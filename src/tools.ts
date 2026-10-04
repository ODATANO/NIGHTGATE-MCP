import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { int64, raw, NightgateApiError, NightgateClient } from './client.js';
import type { NightgateMcpConfig } from './config.js';
import { BUILDABLE_CALLS, BUILDABLE_ARTIFACTS, buildSponsorable, attesterIdentity, seedIdentity } from './builder.js';
import {
  buildOffer, postedOfferIds, readOffer, revertHalf, sameOffer, settleBoardRows, settleHalfJob, swapWalletInfo, takenHalves,
  takeOffer, trackHalfJob, trackPostedHalf,
} from './swap.js';
import { txExport } from './tx-module.js';
import { buildMint } from './factory.js';

const HEX64 = /^[0-9a-fA-F]{64}$/;
const hex64 = (what: string) =>
  z.string().regex(HEX64, `${what} must be 64 hex characters`);

/** Scaled non-negative integer, as string (preferred, exact) or JS number; a number stays below 2^53 so String() renders it exactly. */
const scaledInt = (what: string) =>
  z.union([
    z.string().regex(/^\d+$/, `${what} must be a non-negative integer (decimal string)`),
    z.number().int().nonnegative().safe(),
  ]);

const merkleSiblings = z.array(hex64('sibling')).length(4)
  .describe('Depth-4 Merkle inclusion path: exactly 4 sibling digests (64 hex each)');
const merkleDirs = z.array(z.boolean()).length(4)
  .describe('Exactly 4 booleans; true means the current node is the LEFT child');
const setSiblings = z.array(hex64('setSibling')).length(6)
  .describe('Depth-6 membership-set path: exactly 6 sibling digests (64 hex each)');
const setDirs = z.array(z.boolean()).length(6)
  .describe('Exactly 6 booleans; true means the current node is the LEFT child');

const POLL_HINT = 'Async: returns { jobId, status } immediately; poll get_job_status until succeeded or failed.';
/** NIGHTGATE's platform sponsor pool id (0.17.2+): the server picks a free pool sponsor. */
const PLATFORM_POOL_SENTINEL = '00000000-0000-0000-0000-706f6f6c0000';

/** One side of a swap: a raw token type and an amount in atoms. */
const swapLeg = (what: string) => z.object({
  tokenType: hex64(`${what}.tokenType`).describe('Raw token type (64 hex), what derive_token_type returns'),
  amount: z.union([
    z.string().regex(/^[1-9]\d*$/, `${what}.amount must be a positive integer (decimal string)`),
    z.number().int().positive().safe(),
  ]).describe('Amount in atoms; a decimal string is exact'),
});
const legOut = (leg: { tokenType: string; amount: string | number }) => ({ tokenType: leg.tokenType.toLowerCase(), amount: String(leg.amount) });
/** A swap half as it is handed over: offer file text or base64 of the serialized transaction. */
const swapHalf = (what: string) => z.string().min(16)
  .describe(`${what}: offer file text (swapoffer1...) or base64 of the serialized, proven transaction`);
const SWAP_HINT = 'A swap settles two shielded tokens between two wallets without a contract: each side builds one half ' +
  '(it spends the coin it gives and creates the coin it wants), the two mirrored halves merge into one transaction, ' +
  'and a sponsor pays the fee.';

const OFFER_STATUS = z.enum(['open', 'filled', 'retired', 'expired', 'all']);
const BOARD_ROW_HINT = 'Each row: offerId, the offer half (feed it to read_swap_offer or take_swap_offer), gives/wants ' +
  'type and amount, tags, expiresAt, postedAt, status, filledTxHash, closedAt, changedAt. Never the poster or the ' +
  "half's nullifiers.";

/**
 * Per-slot salt of a proof field. Content-tree leaves are SALTED, so every
 * single-field proof needs the slot's salt from prepare_document_proof
 * (field `salt`; batch claims carry it as `salt` too). Witness material.
 */
const fieldSalt = hex64('fieldSalt')
  .describe('Per-slot salt of this field, from prepare_document_proof (fields[].salt). Witness material, never publish');

/** The shared 16-slot schema descriptor list from prepare_document_proof. */
/**
 * Content-tree slot widths NIGHTGATE ships: 16 (`attestation-vault`) and 32
 * (`attestation-vault-32`). A document uses exactly one of them, picked by
 * the `compiledArtifactRef` it is anchored under. These bounds only keep
 * obvious nonsense out; the SERVER knows the registered width of the actual
 * artifact and rejects a mismatch with a message naming it.
 */
const SLOT_WIDTHS = [16, 32];
const MAX_SLOT_WIDTH = 32;
const MAX_MASK = 0xffffffff;
const slotCount = (what: string) => (list: unknown[]) => SLOT_WIDTHS.includes(list.length)
  || `${what} must have ${SLOT_WIDTHS.join(' or ')} entries, one per slot of the vault width`;

/**
 * Mirrors the server's vacuity guard: a mask that frees every REAL
 * (non-padding) slot of the schema proves nothing at all. Checking it
 * against the SCHEMA rather than against a fixed all-ones constant is what
 * makes it width-independent, and it also catches the case a constant never
 * could, a mask that frees every real slot of a SHORT schema.
 */
function maskFreesEveryRealSlot(allowedMask: number, schema: Array<{ kind: number }>): boolean {
  return schema.every((s, i) => s.kind === 2 || (allowedMask & (1 << i)) !== 0);
}
const VACUOUS_MASK_MESSAGE =
  'allowedMask frees every real (non-padding) schema slot; the claim would be vacuous and the server rejects it';

const schemaSlots = z.array(z.object({
  fieldKey: hex64('schema.fieldKey'),
  kind: z.union([z.literal(0), z.literal(1), z.literal(2)])
    .describe('0 = uint, 1 = bytes, 2 = padding'),
  scale: z.union([z.string(), z.number()]).describe("Off-chain scaling of uint slots, '0' otherwise"),
})).refine((l) => slotCount('schema')(l) === true, { message: 'schema must have 16 or 32 entries, one per slot of the vault width' })
  .describe('The schema descriptor list returned by prepare_document_proof as `schema`, one entry per slot (16 on the default vault, 32 on attestation-vault-32). Both documents of a comparison MUST use the same one');

/** One document's full opening (salt seed + one value per slot). */
const documentOpening = z.object({
  saltSeed: hex64('saltSeed'),
  slots: z.array(z.object({
    present: z.boolean(),
    value: z.string().optional().describe('uint slots: the scaled integer'),
    valueDigest: hex64('slot.valueDigest').optional().describe('bytes slots: the value digest'),
  })).refine((l) => slotCount('slots')(l) === true, { message: 'slots must have 16 or 32 entries, one per slot of the vault width' }),
}).describe('A document\'s complete opening from prepare_document_proof (`opening`): salt seed plus every slot value (16 or 32, matching the vault width). WITNESS material for the whole document, never publish');

/** Batch claim shapes; claims may mix all kinds in one transaction. */
const numericClaim = z.object({
  predicate: z.enum(['lessOrEqual', 'greaterOrEqual']),
  fieldKey: hex64('fieldKey'),
  value: z.string().regex(/^\d+$/, 'value must be a non-negative integer (decimal string)'),
  salt: fieldSalt,
  siblings: merkleSiblings,
  dirs: merkleDirs,
  threshold: scaledInt('threshold'),
  unit: z.string().optional(),
});
const equalityClaim = z.object({
  predicate: z.literal('bytesEquality'),
  fieldKey: hex64('fieldKey'),
  expectedValue: z.string().min(1).optional()
    .describe('Raw expected string; the server digests the EXACT string'),
  expectedDigest: hex64('expectedDigest').optional()
    .describe('blake2b-256 of the exact expected string (64 hex)'),
  salt: fieldSalt,
  siblings: merkleSiblings,
  dirs: merkleDirs,
}).superRefine((c, ctx) => {
  if (!!c.expectedValue === !!c.expectedDigest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'pass exactly one of expectedValue / expectedDigest' });
  }
});
const membershipClaim = z.object({
  predicate: z.literal('setMembership'),
  fieldKey: hex64('fieldKey'),
  value: z.string().min(1).optional().describe('Raw member string (witness only)'),
  valueDigest: hex64('valueDigest').optional().describe('blake2b-256 of the exact member string (witness only)'),
  allowedValues: z.array(z.string().min(1)).min(1).max(64).optional()
    .describe('The public allow-list; the server builds the canonical set root + path'),
  setRoot: hex64('setRoot').optional().describe('Precomputed canonical set root (64 hex)'),
  setSiblings: setSiblings.optional(),
  setDirs: setDirs.optional(),
  salt: fieldSalt,
  siblings: merkleSiblings,
  dirs: merkleDirs,
}).superRefine((c, ctx) => {
  if (!!c.value === !!c.valueDigest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'pass exactly one of value / valueDigest' });
  }
  const hasList = c.allowedValues !== undefined;
  const hasPath = !!(c.setRoot || c.setSiblings || c.setDirs);
  if (hasList && hasPath) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'pass either allowedValues or setRoot + setSiblings + setDirs, not both' });
  }
  if (!hasList && !(c.setRoot && c.setSiblings && c.setDirs)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'allowedValues or setRoot + setSiblings + setDirs is required' });
  }
});

/** Cross-root claim shapes: they relate the batch payload hash (document A) to a second document. */
const documentIntegrityClaim = z.object({
  predicate: z.literal('documentIntegrity'),
  payloadHashB: hex64('payloadHashB').describe('The second document (A is the batch payloadHash)'),
  attesterIdB: hex64('attesterIdB').optional().describe('Document B\'s attester; default the batch attester'),
  allowedMask: z.number().int().min(0).max(MAX_MASK - 1)
    .describe('Packed slot mask, one bit per slot of the vault width (16 bits by default, 32 on attestation-vault-32), bit i = slot i MAY differ. Must leave at least one real schema slot constrained, otherwise the claim is vacuous and rejected'),
  schema: schemaSlots,
  openingA: documentOpening,
  openingB: documentOpening,
}).superRefine((c, ctx) => {
  if (maskFreesEveryRealSlot(c.allowedMask, c.schema)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: VACUOUS_MASK_MESSAGE });
  }
});
const documentDiffClaim = z.object({
  predicate: z.literal('documentDiff'),
  payloadHashB: hex64('payloadHashB').describe('The second document (A is the batch payloadHash)'),
  attesterIdB: hex64('attesterIdB').optional().describe('Document B\'s attester; default the batch attester'),
  k: z.number().int().min(1).max(MAX_SLOT_WIDTH).describe('Minimum number of differing slots to prove, up to the vault width'),
  schema: schemaSlots,
  openingA: documentOpening,
  openingB: documentOpening,
});

/**
 * Phase A tool set: crawler-free verification, job polling, and the
 * curated write path (anchoring, field predicates, disclosure).
 * Wallet lifecycle actions are deliberately never exposed over MCP.
 */
export function registerTools(server: McpServer, client: NightgateClient, config?: NightgateMcpConfig): void {
  const run = wrapHandler(client);

  server.registerTool(
    'verify_attestation',
    {
      description:
        'Verify against LIVE Midnight contract state that an attester\'s record of a payload ' +
        'hash stands in an AttestationVault (crawler-free, no txHash needed). A record is ONE ' +
        'attester\'s attestation of ONE payload (ledger key recordKey(attesterId, payloadHash)): ' +
        'name it by attesterId + payloadHash, or by a bound documentId, which resolves to exactly ' +
        'one record and reveals its attester. Optionally also checks that the anchored content ' +
        'root / schema id match. Returns verified:false (not an error) when absent; the result ' +
        'carries attesterId, payloadHash, recordKey and documentId.',
      inputSchema: {
        contractAddress: z.string().min(1).describe('AttestationVault contract address'),
        attesterId: hex64('attesterId').optional()
          .describe('The attester whose record to check (64 hex; get_attester_identity for this server\'s own). Required unless documentId is given'),
        payloadHash: hex64('payloadHash').optional()
          .describe('The attested payload hash (sha256, 64 hex). Required with attesterId; next to documentId it must match the bound record'),
        documentId: hex64('documentId').optional()
          .describe('A bound document id (64 hex): resolves the record through the vault\'s document bindings'),
        contentRoot: hex64('contentRoot').optional().describe('Optional anchored content root to check (64 hex)'),
        schemaId: hex64('schemaId').optional()
          .describe('Optional anchored schema id to check; the result reports schemaOk, so an examiner can pin the canonical field list'),
        network: z.enum(['preview', 'preprod', 'mainnet']).optional()
          .describe('Read from another network public indexer instead of the configured one'),
        compiledArtifactRef: z.string().optional().describe("Contract artifact ref, defaults to 'attestation-vault'"),
      },
    },
    run(async (args) => {
      if (!args.documentId && !(args.attesterId && args.payloadHash)) {
        throw new Error('name the record: attesterId + payloadHash, or documentId');
      }
      return client.callFunction('verifyAttestationState', {
        contractAddress: args.contractAddress,
        attesterId: args.attesterId,
        payloadHash: args.payloadHash,
        documentId: args.documentId,
        contentRoot: args.contentRoot,
        schemaId: args.schemaId,
        compiledArtifactRef: args.compiledArtifactRef,
        network: args.network,
      });
    }),
  );

  server.registerTool(
    'verify_predicate',
    {
      description:
        'Verify against LIVE Midnight contract state that a ZK claim was recorded true on-chain. ' +
        'Id-free: works for proofs NIGHTGATE never saw. Numeric predicates (lessOrEqual / ' +
        'greaterOrEqual) need threshold (the SAME scaled integer the circuit hashed; a scaling ' +
        'mismatch yields verified:false) and optionally fieldKey for field-bound proofs. ' +
        'bytesEquality needs fieldKey + expectedDigest; setMembership needs fieldKey + setRoot ' +
        '(recompute it from the published list via prepare_membership_set). Every claim is bound ' +
        'to ONE attester\'s record of the document, so attesterId is part of the coordinates.',
      inputSchema: {
        contractAddress: z.string().min(1).describe('AttestationVault contract address'),
        attesterId: hex64('attesterId').describe('The attester whose record of payloadHash carries the claim (64 hex)'),
        payloadHash: hex64('payloadHash').describe('The attestation payload hash (64 hex)'),
        predicate: z.enum(['lessOrEqual', 'greaterOrEqual', 'bytesEquality', 'setMembership',
          'documentIntegrity', 'documentDiff']).describe('Claim kind'),
        threshold: scaledInt('threshold').optional()
          .describe('Numeric predicates only: scaled circuit integer threshold'),
        fieldKey: hex64('fieldKey').optional()
          .describe('Field key (64 hex); required for the numeric and bytes kinds, unused for the cross-root kinds'),
        expectedDigest: hex64('expectedDigest').optional()
          .describe("bytesEquality only: the public expected value digest"),
        setRoot: hex64('setRoot').optional()
          .describe("setMembership only: the canonical allow-list set root"),
        payloadHashB: hex64('payloadHashB').optional()
          .describe('Cross-root kinds: the second document. (A, B) order is part of the claim, query it as proven'),
        attesterIdB: hex64('attesterIdB').optional()
          .describe('Cross-root kinds: document B\'s attester; defaults to attesterId'),
        allowedMask: z.number().int().min(0).max(MAX_MASK).optional()
          .describe('documentIntegrity only: the packed slot mask that was proven (16 bits by default, 32 on attestation-vault-32)'),
        k: z.number().int().min(1).max(MAX_SLOT_WIDTH).optional()
          .describe('documentDiff only: the k that was proven'),
        network: z.enum(['preview', 'preprod', 'mainnet']).optional()
          .describe('Read from another network public indexer instead of the configured one'),
        compiledArtifactRef: z.string().optional().describe("Contract artifact ref, defaults to 'attestation-vault'"),
      },
    },
    run(async (args) => {
      if ((args.predicate === 'lessOrEqual' || args.predicate === 'greaterOrEqual') && args.threshold === undefined) {
        throw new Error('threshold is required for the numeric predicates');
      }
      if (args.predicate === 'bytesEquality' && (!args.fieldKey || !args.expectedDigest)) {
        throw new Error("predicate 'bytesEquality' requires fieldKey and expectedDigest");
      }
      if (args.predicate === 'setMembership' && (!args.fieldKey || !args.setRoot)) {
        throw new Error("predicate 'setMembership' requires fieldKey and setRoot");
      }
      if (args.predicate === 'documentIntegrity' && (!args.payloadHashB || args.allowedMask === undefined)) {
        throw new Error("predicate 'documentIntegrity' requires payloadHashB and allowedMask");
      }
      if (args.predicate === 'documentDiff' && (!args.payloadHashB || args.k === undefined)) {
        throw new Error("predicate 'documentDiff' requires payloadHashB and k");
      }
      return client.callFunction('verifyPredicateState', {
        contractAddress: args.contractAddress,
        attesterId: args.attesterId,
        payloadHash: args.payloadHash,
        attesterIdB: args.attesterIdB,
        fieldKey: args.fieldKey,
        predicate: args.predicate,
        threshold: args.threshold === undefined ? undefined : int64(args.threshold),
        expectedDigest: args.expectedDigest,
        setRoot: args.setRoot,
        payloadHashB: args.payloadHashB,
        allowedMask: args.allowedMask,
        k: args.k,
        compiledArtifactRef: args.compiledArtifactRef,
        network: args.network,
      });
    }),
  );

  server.registerTool(
    'verify_predicate_attestation',
    {
      description:
        'Verify a server-issued predicate attestation by its NIGHTGATE row id (UUID). ' +
        'Confirms the proving transaction succeeded, with a crawler-free live-state fallback. ' +
        'Use verify_predicate instead when you only have on-chain coordinates.',
      inputSchema: {
        predicateAttestationId: z.string().uuid().describe('PredicateAttestations row id'),
      },
    },
    run(async (args) =>
      client.callFunction('verifyPredicateAttestation', {
        predicateAttestationId: args.predicateAttestationId,
      })),
  );

  server.registerTool(
    'verify_document',
    {
      description:
        'Verify an anchored document by its NIGHTGATE document id: compares the provided sha256 ' +
        'against the anchored original and confirms the anchoring transaction, with a crawler-free ' +
        'live-state fallback when contractAddress is supplied.',
      inputSchema: {
        documentId: z.string().uuid().describe('Documents row id'),
        providedSha256: hex64('providedSha256').describe('sha256 of the document to check (64 hex)'),
        contractAddress: z.string().optional().describe('Optional vault address, enables the crawler-free fallback'),
        compiledArtifactRef: z.string().optional().describe("Contract artifact ref, defaults to 'attestation-vault'"),
      },
    },
    run(async (args) =>
      client.callFunction('verifyDocument', {
        documentId: args.documentId,
        providedSha256: args.providedSha256,
        contractAddress: args.contractAddress,
        compiledArtifactRef: args.compiledArtifactRef,
      })),
  );

  server.registerTool(
    'prepare_document_proof',
    {
      description:
        'Turn a structured document into everything the proof tools need: canonical JSON and its ' +
        'payloadHash (what anchor_document anchors), a Merkle contentRoot over an ORDERED list of ' +
        'up to 16 proof fields, and per-field inclusion paths ready for prove_field_predicate / ' +
        'prove_field_equality / prove_field_membership. kind "uint" (default) scales a numeric ' +
        'value; kind "bytes" (NIGHTGATE >= 0.16.0) enters a STRING field as the digest of the ' +
        'exact string, feeding the equality/membership proofs. Keep the field order stable across ' +
        'anchor and proof: it is part of the tree identity. Compute-only and synchronous, nothing ' +
        'is stored server-side. Leaves are SALTED: the response carries a per-field `salt` (feed it ' +
        'back as fieldSalt / claim salt), the full `opening` (salt seed + all 16 slots, needed for ' +
        'the cross-root proofs) and `schemaId` (anchor it alongside the root). STORE the opening ' +
        'with the document: losing the salt seed makes the anchored root unprovable, publishing it ' +
        'makes leaf hashes guessable. Pass saltSeed to reproduce an EXISTING anchored root ' +
        'byte-for-byte; omit it for a fresh document. The returned fields carry witness material ' +
        '(scaled values / digests / salts): treat as sensitive. Store canonicalDocument at your ' +
        'storageRef; re-serializing with different key order will not re-hash equal.',
      inputSchema: {
        document: z.record(z.unknown())
          .describe('The full document as a JSON object; all of it goes into payloadHash'),
        proofFields: z.array(z.object({
          field: z.string().min(1)
            .describe('Dot-separated path into the document (e.g. invoice.total); a literal top-level key containing dots wins'),
          kind: z.enum(['uint', 'bytes']).optional()
            .describe("Leaf kind: 'uint' (default, numeric scaled value) or 'bytes' (string value entered as digest of the exact string)"),
          scale: z.number().int().min(1).max(1_000_000_000).optional()
            .describe("Value scale (default 1000: milli-units); only valid for kind 'uint'"),
        })).min(1).max(MAX_SLOT_WIDTH).describe('ORDERED list of fields to make provable (leaf index = position). Up to 16 on the default vault, up to 32 with compiledArtifactRef attestation-vault-32'),
        saltSeed: hex64('saltSeed').optional()
          .describe('Reuse a stored salt seed to reproduce an already-anchored root; omit for a fresh document (random seed)'),
        compiledArtifactRef: z.string().optional().describe("Contract artifact ref, defaults to 'attestation-vault'"),
      },
    },
    run(async (args) =>
      client.callAction('prepareDocumentProof', {
        documentJson: JSON.stringify(args.document),
        proofFieldsJson: JSON.stringify(args.proofFields),
        saltSeed: args.saltSeed,
        compiledArtifactRef: args.compiledArtifactRef,
      })),
  );

  server.registerTool(
    'attest_agent_output',
    {
      description:
        'Anchor agent-output provenance on the Midnight chain: "agent X produced output O from ' +
        'input I at time T". Builds the canonical v1 envelope server-side, hashes it and anchors ' +
        'it; the response returns the envelopeJson any third party can re-hash and check via ' +
        'verify_attestation, without trusting this server. ' + POLL_HINT,
      inputSchema: {
        agentId: z.string().min(1).max(200).describe('Agent identity, ideally a registered grantee id'),
        inputHash: hex64('inputHash').describe('Commitment to the agent input (64 hex)'),
        outputHash: hex64('outputHash').describe('Commitment to the produced output (64 hex)'),
        sessionId: z.string().uuid().describe('Wallet session id that signs and submits'),
        contractAddress: z.string().min(1).describe('AttestationVault deployment'),
        modelId: z.string().max(200).optional().describe('Optional model identifier'),
        policyHash: hex64('policyHash').optional().describe('Optional commitment to the governing policy (64 hex)'),
        producedAt: z.string().datetime().optional().describe('Optional ISO-8601 production time, defaults to now'),
        storageRef: z.string().optional().describe('Where output/envelope live, defaults to agent-output://<agentId>'),
        compiledArtifactRef: z.string().optional().describe("Contract artifact ref, defaults to 'attestation-vault'"),
        idempotencyKey: z.string().optional().describe('Dedupes retries'),
        sponsorSessionId: z.string().uuid().optional().describe('Optional second session that pays the dust fee'),
      },
    },
    run(async (args) =>
      client.callAction('attestAgentOutput', {
        agentId: args.agentId,
        inputHash: args.inputHash,
        outputHash: args.outputHash,
        modelId: args.modelId,
        policyHash: args.policyHash,
        producedAt: args.producedAt,
        storageRef: args.storageRef,
        sessionId: args.sessionId,
        contractAddress: args.contractAddress,
        compiledArtifactRef: args.compiledArtifactRef,
        idempotencyKey: args.idempotencyKey,
        sponsorSessionId: args.sponsorSessionId,
      })),
  );

  server.registerTool(
    'anchor_document',
    {
      description:
        'Anchor a document content hash on the Midnight chain via the AttestationVault attest ' +
        'circuit (one transaction). Commits only the sha256 + public metadata; you are responsible ' +
        'for storing the actual bytes at storageRef. The on-chain record is keyed by the session\'s ' +
        'attester id AND the hash, so nobody can pre-empt or take over it; the same hash anchored ' +
        'by another identity is a separate record. ' + POLL_HINT +
        ' Also returns documentId for verify_document and attesterId, which verifiers need next to the hash.',
      inputSchema: {
        sha256: hex64('sha256').describe('sha256 of the document content (64 hex), becomes the on-chain payload hash'),
        storageRef: z.string().min(1).describe('Where the bytes live, e.g. file://, s3://, ipfs://'),
        sessionId: z.string().uuid().describe('Wallet session id that signs and submits'),
        contractAddress: z.string().min(1).describe('AttestationVault deployment to anchor into'),
        contentType: z.string().optional().describe('MIME type, informational'),
        size: z.number().int().nonnegative().optional().describe('Content size in bytes, informational'),
        metadata: z.record(z.unknown()).optional().describe('Public metadata object; its hash is anchored alongside'),
        compiledArtifactRef: z.string().optional().describe("Contract artifact ref, defaults to 'attestation-vault'"),
        idempotencyKey: z.string().optional().describe('Dedupes retries of the same anchor request'),
        sponsorSessionId: z.string().uuid().optional().describe('Optional second session that pays the dust fee'),
      },
    },
    run(async (args) =>
      client.callAction('anchorDocument', {
        sha256: args.sha256,
        contentType: args.contentType,
        size: args.size,
        storageRef: args.storageRef,
        metadata: args.metadata === undefined ? undefined : JSON.stringify(args.metadata),
        sessionId: args.sessionId,
        contractAddress: args.contractAddress,
        compiledArtifactRef: args.compiledArtifactRef,
        idempotencyKey: args.idempotencyKey,
        sponsorSessionId: args.sponsorSessionId,
      })),
  );

  server.registerTool(
    'prove_field_predicate',
    {
      description:
        'Issue a zero-knowledge field-bound predicate proof: prove that a hidden field of an ' +
        'anchored document satisfies "value <= threshold" or "value >= threshold" WITHOUT revealing ' +
        'the value. Needs the depth-4 Merkle inclusion path of the field in the anchored content ' +
        'root. value/threshold are scaled integers (decimal strings); the value is a witness and ' +
        'never persisted. If contentRoot is supplied it is anchored first. A false predicate fails ' +
        'at local proving time, nothing is submitted. ' + POLL_HINT,
      inputSchema: {
        payloadHash: hex64('payloadHash').describe('Attestation payload hash (64 hex)'),
        attesterId: hex64('attesterId').optional()
          .describe('The attester whose record of payloadHash the claim is bound to (64 hex); default the session\'s own. A contentRoot can only be anchored under the session\'s own record'),
        fieldKey: hex64('fieldKey').describe('Canonical field id (64 hex, public)'),
        value: z.string().regex(/^\d+$/, 'value must be a non-negative integer (decimal string)')
          .describe('Scaled integer field value (witness only, never persisted)'),
        fieldSalt,
        siblings: merkleSiblings,
        dirs: merkleDirs,
        predicate: z.enum(['lessOrEqual', 'greaterOrEqual']).describe('Predicate operator'),
        threshold: scaledInt('threshold').describe('Scaled integer threshold (same scaling as value)'),
        sessionId: z.string().uuid().describe('Wallet session id that signs and submits'),
        contractAddress: z.string().min(1).describe('AttestationVault deployment'),
        contentRoot: hex64('contentRoot').optional().describe('Optional Merkle root (64 hex) to anchor first'),
        schemaId: hex64('schemaId').optional().describe('Schema id of the field list, required whenever contentRoot is supplied'),
        unit: z.string().optional().describe('Informational unit, e.g. kWh'),
        compiledArtifactRef: z.string().optional().describe("Contract artifact ref, defaults to 'attestation-vault'"),
        idempotencyKey: z.string().optional().describe('Dedupes retries'),
        sponsorSessionId: z.string().uuid().optional().describe('Optional second session that pays the dust fee'),
      },
    },
    run(async (args) =>
      client.callAction('issueFieldPredicateAttestation', {
        payloadHash: args.payloadHash,
        attesterId: args.attesterId,
        fieldKey: args.fieldKey,
        value: args.value,
        fieldSalt: args.fieldSalt,
        contentRoot: args.contentRoot,
        schemaId: args.schemaId,
        siblingsJson: JSON.stringify(args.siblings),
        dirsJson: JSON.stringify(args.dirs),
        predicate: args.predicate,
        threshold: String(args.threshold),
        unit: args.unit,
        sessionId: args.sessionId,
        contractAddress: args.contractAddress,
        compiledArtifactRef: args.compiledArtifactRef,
        idempotencyKey: args.idempotencyKey,
        sponsorSessionId: args.sponsorSessionId,
      })),
  );

  server.registerTool(
    'prepare_membership_set',
    {
      description:
        'Build the canonical depth-6 membership-set tree over a public allow-list (NIGHTGATE ' +
        '>= 0.16.0). Deterministic rule (digest each exact string, dedupe, sort ascending, pad by ' +
        'repeating the last member digest), so ANYONE recomputes the same setRoot from the ' +
        'published list alone: use the root to verify_predicate a setMembership claim. With ' +
        'value/valueDigest it additionally returns the member inclusion path (witness material, ' +
        'treat as sensitive); a non-member is a clean 400. Compute-only and synchronous.',
      inputSchema: {
        allowedValues: z.array(z.string().min(1)).min(1).max(64)
          .describe('The public allow-list (up to 64 distinct values)'),
        value: z.string().min(1).optional()
          .describe('Optional member string to get the inclusion path for (pass this OR valueDigest)'),
        valueDigest: hex64('valueDigest').optional()
          .describe('Optional member digest (64 hex) instead of the raw value'),
        compiledArtifactRef: z.string().optional().describe("Contract artifact ref, defaults to 'attestation-vault'"),
      },
    },
    run(async (args) => {
      if (args.value !== undefined && args.valueDigest !== undefined) {
        throw new Error('pass at most one of value / valueDigest');
      }
      return client.callAction('prepareMembershipSet', {
        allowedValuesJson: JSON.stringify(args.allowedValues),
        value: args.value,
        valueDigest: args.valueDigest,
        compiledArtifactRef: args.compiledArtifactRef,
      });
    }),
  );

  server.registerTool(
    'prove_field_equality',
    {
      description:
        'Issue a ZK bytes-equality proof (NIGHTGATE >= 0.16.0): the anchored document field ' +
        'carries EXACTLY the value behind the public expectedDigest. The digest IS the statement, ' +
        'so this is an authenticity/binding proof, not confidentiality (a low-entropy value\'s ' +
        'digest is dictionary-guessable). The field must be a kind:"bytes" leaf from ' +
        'prepare_document_proof; siblings/dirs are its depth-4 inclusion path. If contentRoot is ' +
        'supplied it is anchored first. ' + POLL_HINT,
      inputSchema: {
        payloadHash: hex64('payloadHash').describe('Attestation payload hash (64 hex)'),
        attesterId: hex64('attesterId').optional()
          .describe('The attester whose record of payloadHash the claim is bound to (64 hex); default the session\'s own. A contentRoot can only be anchored under the session\'s own record'),
        fieldKey: hex64('fieldKey').describe('Canonical field id (64 hex, public)'),
        expectedValue: z.string().min(1).optional()
          .describe('Raw expected string (the server digests the EXACT string; pass this OR expectedDigest)'),
        expectedDigest: hex64('expectedDigest').optional()
          .describe('blake2b-256 of the exact expected string (64 hex)'),
        fieldSalt,
        siblings: merkleSiblings,
        dirs: merkleDirs,
        sessionId: z.string().uuid().describe('Wallet session id that signs and submits'),
        contractAddress: z.string().min(1).describe('AttestationVault deployment'),
        contentRoot: hex64('contentRoot').optional().describe('Optional Merkle root (64 hex) to anchor first'),
        schemaId: hex64('schemaId').optional().describe('Schema id of the field list, required whenever contentRoot is supplied'),
        compiledArtifactRef: z.string().optional().describe("Contract artifact ref, defaults to 'attestation-vault'"),
        idempotencyKey: z.string().optional().describe('Dedupes retries'),
        sponsorSessionId: z.string().uuid().optional().describe('Optional second session that pays the dust fee'),
      },
    },
    run(async (args) => {
      if (!!args.expectedValue === !!args.expectedDigest) {
        throw new Error('pass exactly one of expectedValue / expectedDigest');
      }
      return client.callAction('issueFieldEqualityAttestation', {
        payloadHash: args.payloadHash,
        attesterId: args.attesterId,
        fieldKey: args.fieldKey,
        expectedValue: args.expectedValue,
        expectedDigest: args.expectedDigest,
        fieldSalt: args.fieldSalt,
        contentRoot: args.contentRoot,
        schemaId: args.schemaId,
        siblingsJson: JSON.stringify(args.siblings),
        dirsJson: JSON.stringify(args.dirs),
        sessionId: args.sessionId,
        contractAddress: args.contractAddress,
        compiledArtifactRef: args.compiledArtifactRef,
        idempotencyKey: args.idempotencyKey,
        sponsorSessionId: args.sponsorSessionId,
      });
    }),
  );

  server.registerTool(
    'prove_field_membership',
    {
      description:
        'Issue a ZK set-membership proof (NIGHTGATE >= 0.16.0): the anchored document field\'s ' +
        'HIDDEN value is one of a public allow-list, without revealing which one. Supply the ' +
        'allow-list directly (allowedValues: the server builds the canonical set root + path and ' +
        'rejects a non-member with 400 BEFORE any proving) or a precomputed setRoot + setSiblings ' +
        '+ setDirs from prepare_membership_set. The field must be a kind:"bytes" leaf from ' +
        'prepare_document_proof; value/valueDigest stay witness material, never persisted. If ' +
        'contentRoot is supplied it is anchored first. ' + POLL_HINT,
      inputSchema: {
        payloadHash: hex64('payloadHash').describe('Attestation payload hash (64 hex)'),
        attesterId: hex64('attesterId').optional()
          .describe('The attester whose record of payloadHash the claim is bound to (64 hex); default the session\'s own. A contentRoot can only be anchored under the session\'s own record'),
        fieldKey: hex64('fieldKey').describe('Canonical field id (64 hex, public)'),
        value: z.string().min(1).optional()
          .describe('Raw member string (witness only; pass this OR valueDigest)'),
        valueDigest: hex64('valueDigest').optional()
          .describe('blake2b-256 of the exact member string (witness only)'),
        allowedValues: z.array(z.string().min(1)).min(1).max(64).optional()
          .describe('The public allow-list; pass this OR setRoot + setSiblings + setDirs'),
        setRoot: hex64('setRoot').optional().describe('Precomputed canonical set root (64 hex)'),
        setSiblings: setSiblings.optional(),
        setDirs: setDirs.optional(),
        fieldSalt,
        siblings: merkleSiblings,
        dirs: merkleDirs,
        sessionId: z.string().uuid().describe('Wallet session id that signs and submits'),
        contractAddress: z.string().min(1).describe('AttestationVault deployment'),
        contentRoot: hex64('contentRoot').optional().describe('Optional Merkle root (64 hex) to anchor first'),
        schemaId: hex64('schemaId').optional().describe('Schema id of the field list, required whenever contentRoot is supplied'),
        compiledArtifactRef: z.string().optional().describe("Contract artifact ref, defaults to 'attestation-vault'"),
        idempotencyKey: z.string().optional().describe('Dedupes retries'),
        sponsorSessionId: z.string().uuid().optional().describe('Optional second session that pays the dust fee'),
      },
    },
    run(async (args) => {
      if (!!args.value === !!args.valueDigest) {
        throw new Error('pass exactly one of value / valueDigest');
      }
      const hasList = args.allowedValues !== undefined;
      const hasPath = !!(args.setRoot || args.setSiblings || args.setDirs);
      if (hasList && hasPath) throw new Error('pass either allowedValues or setRoot + setSiblings + setDirs, not both');
      if (!hasList && !(args.setRoot && args.setSiblings && args.setDirs)) {
        throw new Error('allowedValues or setRoot + setSiblings + setDirs is required');
      }
      return client.callAction('issueFieldMembershipAttestation', {
        payloadHash: args.payloadHash,
        attesterId: args.attesterId,
        fieldKey: args.fieldKey,
        value: args.value,
        valueDigest: args.valueDigest,
        allowedValuesJson: args.allowedValues === undefined ? undefined : JSON.stringify(args.allowedValues),
        setRoot: args.setRoot,
        setSiblingsJson: args.setSiblings === undefined ? undefined : JSON.stringify(args.setSiblings),
        setDirsJson: args.setDirs === undefined ? undefined : JSON.stringify(args.setDirs),
        fieldSalt: args.fieldSalt,
        contentRoot: args.contentRoot,
        schemaId: args.schemaId,
        siblingsJson: JSON.stringify(args.siblings),
        dirsJson: JSON.stringify(args.dirs),
        sessionId: args.sessionId,
        contractAddress: args.contractAddress,
        compiledArtifactRef: args.compiledArtifactRef,
        idempotencyKey: args.idempotencyKey,
        sponsorSessionId: args.sponsorSessionId,
      });
    }),
  );

  server.registerTool(
    'prove_field_predicates_batch',
    {
      description:
        'Batch variant of the field proof tools: prove up to 8 field-bound claims on ONE anchored ' +
        'document in ONE transaction (7 if contentRoot is supplied, since the anchor occupies one ' +
        'call slot). Claims may MIX the three kinds (NIGHTGATE >= 0.16.0), discriminated by ' +
        'predicate: numeric (lessOrEqual/greaterOrEqual), bytesEquality, setMembership. Duplicate ' +
        'claim tuples are dropped server-side. One false claim aborts the whole batch at local ' +
        'proving time with zero on-chain effect. After submission the chain can finalize a ' +
        'PARTIAL_SUCCESS subset; verify per claim via verify_predicate_attestation instead of ' +
        'assuming all-or-nothing. ' + POLL_HINT,
      inputSchema: {
        payloadHash: hex64('payloadHash').describe('Shared attestation payload hash; also document A of any cross-root claim (64 hex)'),
        attesterId: hex64('attesterId').optional()
          .describe('The attester whose record of payloadHash the claim is bound to (64 hex); default the session\'s own. A contentRoot can only be anchored under the session\'s own record'),

        claims: z.array(z.union([numericClaim, equalityClaim, membershipClaim, documentIntegrityClaim, documentDiffClaim]))
          .min(1).max(8)
          .describe('1-8 claims on the same payload hash; any mix of numeric, bytesEquality, setMembership, documentIntegrity and documentDiff'),
        sessionId: z.string().uuid().describe('Wallet session id that signs and submits'),
        contractAddress: z.string().min(1).describe('AttestationVault deployment'),
        contentRoot: hex64('contentRoot').optional().describe('Optional Merkle root anchored as first call of the same batch'),
        schemaId: hex64('schemaId').optional().describe('Schema id of the field list, required whenever contentRoot is supplied'),
        compiledArtifactRef: z.string().optional().describe("Contract artifact ref, defaults to 'attestation-vault'"),
        idempotencyKey: z.string().optional().describe('Dedupes retries'),
        sponsorSessionId: z.string().uuid().optional().describe('Optional second session that pays the dust fee'),
      },
    },
    run(async (args) => {
      if (args.contentRoot && args.claims.length > 7) {
        throw new Error('with contentRoot the anchor occupies one slot: max 7 claims');
      }
      return client.callAction('issueFieldPredicateAttestationBatch', {
        payloadHash: args.payloadHash,
        attesterId: args.attesterId,
        contentRoot: args.contentRoot,
        schemaId: args.schemaId,
        claimsJson: JSON.stringify(args.claims.map((c) =>
          'threshold' in c ? { ...c, threshold: String(c.threshold) } : c)),
        sessionId: args.sessionId,
        contractAddress: args.contractAddress,
        compiledArtifactRef: args.compiledArtifactRef,
        idempotencyKey: args.idempotencyKey,
        sponsorSessionId: args.sponsorSessionId,
      });
    }),
  );

  server.registerTool(
    'prove_document_integrity',
    {
      description:
        'Prove that document B differs from anchored document A ONLY in the slots flagged by a ' +
        'public slot mask, values hidden: the version-integrity claim ("v2 changed nothing ' +
        'outside the allowed fields"). Both documents must be anchored, prepared with the SAME ' +
        'ordered field list (identical schemaId) and you need BOTH full openings, which is why ' +
        'this only works for a party that holds both documents. A mask that frees every real slot ' +
        'is vacuous and rejected; a slot that changed, appeared or disappeared outside the mask ' +
        'fails at local proving time with zero on-chain effect. ' + POLL_HINT,
      inputSchema: {
        payloadHashA: hex64('payloadHashA').describe('Anchored document A (64 hex)'),
        payloadHashB: hex64('payloadHashB').describe('Anchored document B; must differ from A'),
        attesterIdA: hex64('attesterIdA').optional()
          .describe('Document A\'s attester (64 hex); default the session\'s own'),
        attesterIdB: hex64('attesterIdB').optional()
          .describe('Document B\'s attester (64 hex); default attesterIdA'),

        allowedMask: z.number().int().min(0).max(MAX_MASK - 1)
          .describe('Packed slot mask, one bit per slot of the vault width (16 bits by default, 32 on attestation-vault-32), bit i = slot i MAY differ. At least one real schema slot must stay constrained'),
        schema: schemaSlots,
        openingA: documentOpening,
        openingB: documentOpening,
        sessionId: z.string().uuid().describe('Wallet session id that signs and submits'),
        contractAddress: z.string().min(1).describe('AttestationVault deployment'),
        contentRootA: hex64('contentRootA').optional().describe('Optional: anchor A\'s root in the same flow'),
        contentRootB: hex64('contentRootB').optional().describe('Optional: anchor B\'s root in the same flow'),
        schemaId: hex64('schemaId').optional().describe('Shared schema id, required whenever a contentRoot is supplied'),
        compiledArtifactRef: z.string().optional().describe("Contract artifact ref, defaults to 'attestation-vault'"),
        idempotencyKey: z.string().optional().describe('Dedupes retries'),
        sponsorSessionId: z.string().uuid().optional().describe('Optional second session that pays the dust fee'),
      },
    },
    run(async (args) => {
      if (maskFreesEveryRealSlot(args.allowedMask, args.schema)) throw new Error(VACUOUS_MASK_MESSAGE);
      return client.callAction('issueDocumentIntegrityAttestation', {
        payloadHashA: args.payloadHashA,
        payloadHashB: args.payloadHashB,
        attesterIdA: args.attesterIdA,
        attesterIdB: args.attesterIdB,
        allowedMask: args.allowedMask,
        schemaJson: JSON.stringify(args.schema),
        openingAJson: JSON.stringify(args.openingA),
        openingBJson: JSON.stringify(args.openingB),
        contentRootA: args.contentRootA,
        contentRootB: args.contentRootB,
        schemaId: args.schemaId,
        sessionId: args.sessionId,
        contractAddress: args.contractAddress,
        compiledArtifactRef: args.compiledArtifactRef,
        idempotencyKey: args.idempotencyKey,
        sponsorSessionId: args.sponsorSessionId,
      });
    }),
  );

  server.registerTool(
    'prove_document_diff',
    {
      description:
        'Prove that at least k of the aligned slots differ between two anchored documents ' +
        '(16 slots on the default vault, 32 on attestation-vault-32), ' +
        'without revealing which slots or what values: the distinctness claim (k=1 is "provably ' +
        'not the same document"). Same requirements as prove_document_integrity: identical field ' +
        'list, both openings in hand. A difference is a value change or a field that appeared or ' +
        'disappeared; both-empty slots compare equal and padding never counts. k above the real ' +
        'count fails at local proving time with zero on-chain effect. ' + POLL_HINT,
      inputSchema: {
        payloadHashA: hex64('payloadHashA').describe('Anchored document A (64 hex)'),
        payloadHashB: hex64('payloadHashB').describe('Anchored document B; must differ from A'),
        attesterIdA: hex64('attesterIdA').optional()
          .describe('Document A\'s attester (64 hex); default the session\'s own'),
        attesterIdB: hex64('attesterIdB').optional()
          .describe('Document B\'s attester (64 hex); default attesterIdA'),

        k: z.number().int().min(1).max(MAX_SLOT_WIDTH).describe('Minimum number of differing slots to prove, up to the vault width'),
        schema: schemaSlots,
        openingA: documentOpening,
        openingB: documentOpening,
        sessionId: z.string().uuid().describe('Wallet session id that signs and submits'),
        contractAddress: z.string().min(1).describe('AttestationVault deployment'),
        contentRootA: hex64('contentRootA').optional().describe('Optional: anchor A\'s root in the same flow'),
        contentRootB: hex64('contentRootB').optional().describe('Optional: anchor B\'s root in the same flow'),
        schemaId: hex64('schemaId').optional().describe('Shared schema id, required whenever a contentRoot is supplied'),
        compiledArtifactRef: z.string().optional().describe("Contract artifact ref, defaults to 'attestation-vault'"),
        idempotencyKey: z.string().optional().describe('Dedupes retries'),
        sponsorSessionId: z.string().uuid().optional().describe('Optional second session that pays the dust fee'),
      },
    },
    run(async (args) =>
      client.callAction('issueDocumentDiffAttestation', {
        payloadHashA: args.payloadHashA,
        payloadHashB: args.payloadHashB,
        attesterIdA: args.attesterIdA,
        attesterIdB: args.attesterIdB,
        k: args.k,
        schemaJson: JSON.stringify(args.schema),
        openingAJson: JSON.stringify(args.openingA),
        openingBJson: JSON.stringify(args.openingB),
        contentRootA: args.contentRootA,
        contentRootB: args.contentRootB,
        schemaId: args.schemaId,
        sessionId: args.sessionId,
        contractAddress: args.contractAddress,
        compiledArtifactRef: args.compiledArtifactRef,
        idempotencyKey: args.idempotencyKey,
        sponsorSessionId: args.sponsorSessionId,
      })),
  );

  server.registerTool(
    'grant_disclosure',
    {
      description:
        'Grant a disclosure level for an attestation to a grantee identity, on-chain via the ' +
        'AttestationVault. Attester-only: the transaction is rejected in-circuit unless the ' +
        'session wallet is the original attester. level: 0=public, 1=legitimate-interest, ' +
        '2=authority. ' + POLL_HINT,
      inputSchema: {
        payloadHash: hex64('payloadHash').describe('The attestation payload hash (64 hex)'),
        grantee: hex64('grantee').describe('Grantee identity (64 hex Bytes<32>)'),
        level: z.union([z.literal(0), z.literal(1), z.literal(2)])
          .describe('0=public, 1=legitimate-interest, 2=authority'),
        sessionId: z.string().uuid().describe('Wallet session id (must be the attester)'),
        contractAddress: z.string().min(1).describe('AttestationVault deployment'),
        compiledArtifactRef: z.string().optional().describe("Contract artifact ref, defaults to 'attestation-vault'"),
        idempotencyKey: z.string().optional().describe('Dedupes retries'),
        sponsorSessionId: z.string().uuid().optional().describe('Optional second session that pays the dust fee'),
      },
    },
    run(async (args) =>
      client.callAction('grantDisclosure', {
        payloadHash: args.payloadHash,
        grantee: args.grantee,
        level: args.level,
        sessionId: args.sessionId,
        contractAddress: args.contractAddress,
        compiledArtifactRef: args.compiledArtifactRef,
        idempotencyKey: args.idempotencyKey,
        sponsorSessionId: args.sponsorSessionId,
      })),
  );

  server.registerTool(
    'revoke_disclosure',
    {
      description:
        'Revoke a previously granted disclosure on-chain (removes the grantee entry). ' +
        'Attester-only, enforced in-circuit. ' + POLL_HINT,
      inputSchema: {
        payloadHash: hex64('payloadHash').describe('The attestation payload hash (64 hex)'),
        grantee: hex64('grantee').describe('Grantee identity (64 hex Bytes<32>)'),
        sessionId: z.string().uuid().describe('Wallet session id (must be the attester)'),
        contractAddress: z.string().min(1).describe('AttestationVault deployment'),
        compiledArtifactRef: z.string().optional().describe("Contract artifact ref, defaults to 'attestation-vault'"),
        idempotencyKey: z.string().optional().describe('Dedupes retries'),
        sponsorSessionId: z.string().uuid().optional().describe('Optional second session that pays the dust fee'),
      },
    },
    run(async (args) =>
      client.callAction('revokeDisclosure', {
        payloadHash: args.payloadHash,
        grantee: args.grantee,
        sessionId: args.sessionId,
        contractAddress: args.contractAddress,
        compiledArtifactRef: args.compiledArtifactRef,
        idempotencyKey: args.idempotencyKey,
        sponsorSessionId: args.sponsorSessionId,
      })),
  );

  server.registerTool(
    'build_sponsorable_transaction',
    {
      description:
        'Build, prove and sign an AttestationVault call LOCALLY (caller half of cross-server fee ' +
        'sponsoring, @odatano/nightgate-tx txbuilder): the seed comes from the MCP server ' +
        'environment (NIGHTGATE_SEED_HEX), the attestation secret is derived from it, nothing ' +
        'secret leaves this machine. Returns the fee-unpaid transaction as base64: UNBOUND by ' +
        'default (hand it to sponsor_unbound_transaction, parallel channel) or bound with ' +
        'bind:true (sponsor_finalized_transaction). The on-chain effect carries the attester id ' +
        'of THIS builder (returned). Proving takes 20-60 s in-process (the first call also ' +
        'fetches the prover keys from the NIGHTGATE /zk-config); NIGHTGATE_PROOF_SERVER_URL ' +
        'switches to a proof server. Needs @odatano/nightgate-tx installed next to the MCP ' +
        'server. params by call: attest {payloadHash, metadataHash}; anchorContentRoot ' +
        '{payloadHash, contentRoot, schemaId}; grantDisclosure {payloadHash, grantee, level 0|1|2}; ' +
        'revokeDisclosure {payloadHash, grantee}; registerPassport {passportId, ownerId}; ' +
        'bindPassport {passportId, payloadHash}. The owner-gated calls address THIS builder\'s own ' +
        'record of the payload (the circuit derives recordKey(attesterId, payloadHash) from the ' +
        'caller). ZK CLAIMS, proven here with no wallet on the server and no witness ever sent ' +
        'to it, address a record explicitly: pass payloadHash (this builder\'s record) or ' +
        'payloadHash + attesterId (another attester\'s record) or recordKey directly: ' +
        'proveFieldPredicate {payloadHash, fieldKey, threshold, op 0=lessOrEqual|1=greaterOrEqual} ' +
        'plus merkleProof {fieldValue, fieldSalt, siblings, dirs}; proveFieldEquality ' +
        '{payloadHash, fieldKey, expectedDigest} plus merkleProof {fieldSalt, siblings, dirs}; ' +
        'proveFieldMembership {payloadHash, fieldKey, setRoot} plus merkleProof {fieldDigest, ' +
        'fieldSalt, siblings, dirs, setProof}; proveFieldsUnchangedExcept {payloadHashA, ' +
        'payloadHashB, allowedMask} and proveFieldsDiffer {payloadHashA, payloadHashB, k} ' +
        '(optionally attesterIdA / attesterIdB, or recordKeyA / recordKeyB), both plus docPair ' +
        '{schema, openingA, openingB}. Every witness field comes straight out of ' +
        'prepare_document_proof. All hashes 64 hex. The built bytes are valid for ' +
        'the transaction TTL (~30 min) and against the contract state at build time: if the ' +
        'sponsor job ends CHAIN_EXECUTION_FAILED, build again.',
      inputSchema: {
        contractAddress: z.string().min(1).describe('AttestationVault contract address (64 hex)'),
        call: z.enum(BUILDABLE_CALLS).describe('Which circuit to call'),
        params: z.record(z.union([z.string(), z.number()]))
          .describe('The call parameters (see the per-call list in the description)'),
        merkleProof: z.record(z.any()).optional()
          .describe('WITNESS material for the proveField* calls, as prepare_document_proof returns it for that field (fieldValue/fieldDigest, fieldSalt, siblings, dirs, setProof). It is consumed by the local prover and never sent to NIGHTGATE'),
        docPair: z.record(z.any()).optional()
          .describe('WITNESS bundle { schema, openingA, openingB } for proveFieldsUnchangedExcept / proveFieldsDiffer; both documents must be prepared with the same ordered field list'),
        bind: z.boolean().optional()
          .describe('false (default): unbound for sponsor_unbound_transaction; true: finalized for sponsor_finalized_transaction'),
        compiledArtifactRef: z.enum(BUILDABLE_ARTIFACTS).optional()
          .describe("Vault lineage to build against, defaults to 'attestation-vault'. Use 'attestation-vault-32' for a 32-slot vault: it has its own circuits, so the builder loads that contract class and fetches ITS prover keys from the server's /zk-config. The address must belong to the lineage named here"),
      },
    },
    run(async (args) => {
      if (!config) throw new Error('local building is not configured for this server instance');
      return buildSponsorable(config, {
        contractAddress: args.contractAddress, call: args.call, params: args.params, bind: args.bind === true,
        compiledArtifactRef: args.compiledArtifactRef,
        merkleProof: args.merkleProof, docPair: args.docPair,
      });
    }),
  );

  server.registerTool(
    'get_attester_identity',
    {
      description:
        'The attester id this MCP server builds under (derived from NIGHTGATE_SEED_HEX via the ' +
        'txbuilder), plus the network, the shielded address and the two public shielded keys ' +
        '(what a sender needs to create a coin for this wallet). Use it to check ' +
        'verify_attestation results against the identity that will appear on-chain; builds ' +
        'nothing and submits nothing.',
      inputSchema: {},
    },
    run(async () => {
      if (!config) throw new Error('local building is not configured for this server instance');
      return attesterIdentity(config);
    }),
  );

  server.registerTool(
    'sponsor_finalized_transaction',
    {
      description:
        'Cross-server fee sponsoring, phase 2 (NIGHTGATE 0.17.0): submit a FINALIZED, fee-unpaid ' +
        'transaction that was built, proven and signed elsewhere (e.g. with the ' +
        "@odatano/nightgate-tx txbuilder, so the caller's key never left its machine). The " +
        "sponsor session pays the dust; the on-chain effect carries the BUILDER's identity, not " +
        "the sponsor's. The server enforces its contract/circuit allow-list and rejects anything " +
        'outside it. The transaction expires with its TTL (default 30 min), so hand it over ' +
        'promptly. This is the SERIAL channel (one tx per sponsor wallet at a time); for ' +
        'parallel submission build with bind:false and use sponsor_unbound_transaction. ' +
        'Poll get_job_status with the sessionId RETURNED by this call (the sponsor the job ' +
        'is keyed by; with the platform pool that is the pool id). ' + POLL_HINT,
      inputSchema: {
        finalizedTxB64: z.string().min(1)
          .describe('Base64 of the caller-finalized, fee-unpaid transaction (~7000 chars for a vault call)'),
        sponsorSessionId: z.string().uuid()
          .describe('Wallet session that pays the dust and submits, or the platform sponsor POOL id ' +
            `${PLATFORM_POOL_SENTINEL} (the server picks a free pool sponsor and fails over between them)`),
        idempotencyKey: z.string().optional()
          .describe('Dedupes retries; the request is also fingerprinted by the transaction bytes'),
      },
    },
    run(async (args) =>
      client.callAction('sponsorFinalizedTransaction', {
        finalizedTxB64: args.finalizedTxB64,
        sponsorSessionId: args.sponsorSessionId,
        idempotencyKey: args.idempotencyKey,
      })),
  );

  server.registerTool(
    'sponsor_unbound_transaction',
    {
      description:
        'Cross-server fee sponsoring, PARALLEL channel (NIGHTGATE 0.18.0): submit an UNBOUND ' +
        '(pre-binding) proven+signed caller transaction, built with the @odatano/nightgate-tx ' +
        "txbuilder's buildSponsorable({ bind: false }) (the caller's key never left its machine). " +
        'The sponsor locks one free dust backing, merges its dust spend, binds and submits; only ' +
        'the dust build takes the per-wallet lock, so ONE sponsor wallet sponsors N transactions ' +
        'at once (N = its registered dust backings; live: several in the same block). Same ' +
        'allow-list policy, pool and grant surface as sponsor_finalized_transaction; do not mix ' +
        'both channels on one sponsor wallet. Contract state is account-style: two sponsored ' +
        'calls against the SAME contract in one block conflict, the loser lands on-chain but its ' +
        'call does not apply and the job ends failed with errorCode CHAIN_EXECUTION_FAILED (the ' +
        'transaction hash is in the error); then REBUILD the transaction against the current ' +
        'contract state and sponsor again (never resubmit the same bytes). Poll get_job_status ' +
        'with the sessionId RETURNED by this call. ' + POLL_HINT,
      inputSchema: {
        unboundTxB64: z.string().min(1)
          .describe('Base64 of the caller-built, proven and signed UNBOUND transaction (bind:false output)'),
        sponsorSessionId: z.string().uuid()
          .describe('Wallet session that pays the dust and submits, or the platform sponsor POOL id ' +
            `${PLATFORM_POOL_SENTINEL}`),
        idempotencyKey: z.string().optional()
          .describe('Dedupes retries of the SAME bytes; a rebuilt transaction is a new key'),
      },
    },
    run(async (args) =>
      client.callAction('sponsorUnboundTransaction', {
        unboundTxB64: args.unboundTxB64,
        sponsorSessionId: args.sponsorSessionId,
        idempotencyKey: args.idempotencyKey,
      })),
  );

  server.registerTool(
    'get_swap_wallet',
    {
      description:
        'The shielded wallet this MCP server swaps from (seed from NIGHTGATE_SEED_HEX): address, ' +
        'public keys, and per token type the balance, the number of free coins and `spendable`, ' +
        'the most ONE swap half can give (what its largest coins hold, up to maxInputs coins). ' +
        'Also lists the halves built here that are not handed over yet; one posted with ' +
        'post_swap_offer carries offerId and boardStatus and leaves the list once its offer filled. The wallet syncs its ' +
        'shielded coins only; a first sync from genesis takes about 5 minutes, during which the ' +
        'answer is { synced: false, syncingSeconds }: call again. Spends nothing.',
      inputSchema: {},
    },
    run(async () => {
      if (!config) throw new Error('swaps are not configured for this server instance');
      for (const offerId of postedOfferIds()) {
        settleBoardRows(await client.callFunction('getSwapOffer', { offerId: raw(offerId) }).catch(() => undefined));
      }
      return swapWalletInfo(config);
    }),
  );

  server.registerTool(
    'read_swap_offer',
    {
      description:
        SWAP_HINT + ' This reads what an offer gives and wants FROM THE TRANSACTION it carries, ' +
        'never from what its maker says: gives / wants (token type and amount, from the ' +
        "maker's side), the coins it carries, and whether it is bound. Refuses anything that is " +
        'not a plain swap half (a contract call, unshielded value, more than one token type ' +
        'given or wanted). Needs no wallet and no network. Check the terms here before take_swap_offer.',
      inputSchema: {
        offer: swapHalf('The offer'),
      },
    },
    run(async (args) => readOffer(args.offer)),
  );

  server.registerTool(
    'build_swap_offer',
    {
      description:
        SWAP_HINT + ' This builds and proves ONE half from this server\'s wallet: it spends `give` ' +
        'and creates `want` (and the change) for this wallet. Returns the offer file ' +
        '(`offer`, text starting with swapoffer1, about 25 000 characters) to publish, its `id`, ' +
        'and the terms read back from the built transaction. Anyone holding the wanted token can ' +
        'take the offer; the first swap that lands consumes it. The coins stay reserved until ' +
        'the swap lands: withdraw an offer that is not going to be used with revert_swap_offer. ' +
        'An offer refers to a recent chain state and expires with it, so publish it promptly. ' +
        '`give.amount` may not exceed `spendable` of get_swap_wallet. Proving takes about 200 s ' +
        'in-process, 11 to 17 s on a proof server (NIGHTGATE_PROOF_SERVER_URL). Spends no fee.',
      inputSchema: {
        give: swapLeg('give'),
        want: swapLeg('want'),
        bind: z.boolean().optional()
          .describe('true (default): bound, with its offer file. false: unbound, base64 only (halfB64), for a taker that builds unbound too'),
      },
    },
    run(async (args) => {
      if (!config) throw new Error('swaps are not configured for this server instance');
      return buildOffer(config, { give: legOut(args.give), want: legOut(args.want), bind: args.bind });
    }),
  );

  server.registerTool(
    'take_swap_offer',
    {
      description:
        SWAP_HINT + ' This takes an offer: it reads the offer\'s terms from the transaction, ' +
        'refuses when they differ from `expect`, builds and proves the mirror half from this ' +
        'server\'s wallet (it spends what the offer wants and creates what the offer gives). ' +
        'With sponsorSessionId the two halves go to the sponsor at once and the answer is the ' +
        'job ({ jobId, status, sessionId, id, terms }): poll get_job_status with the returned ' +
        'sessionId. Without it the answer carries both halves for sponsor_swap. ALWAYS pass ' +
        '`expect` with the terms you agreed to: an offer is text from someone else. With offerId ' +
        'the board entry is read first and the call refuses, before proving, when it is not open ' +
        'or carries another offer than `offer`. A sponsor that refuses the swap leaves the proven ' +
        'half held under `halfId`: send it again with sponsor_swap({ halfId, offerId?, ' +
        'sponsorSessionId }) or release its coins with revert_swap_offer. If the offer was taken ' +
        'by somebody else first, the job fails: revert_swap_offer.',
      inputSchema: {
        offer: swapHalf('The offer to take'),
        expect: z.object({ gives: swapLeg('expect.gives'), wants: swapLeg('expect.wants') }).optional()
          .describe("The terms you agreed to, from the MAKER's side: what the offer gives and what it wants"),
        sponsorSessionId: z.string().uuid().optional()
          .describe('Sponsor session or the platform sponsor POOL id ' + `${PLATFORM_POOL_SENTINEL}` + '; when given the swap is submitted at once'),
        idempotencyKey: z.string().optional().describe('Dedupes retries of the same submission'),
        offerId: z.string().uuid().optional()
          .describe('The board entry the offer came from (list_swap_offers), so the fill is recorded against it'),
      },
    },
    run(async (args) => {
      if (!config) throw new Error('swaps are not configured for this server instance');
      if (args.offerId) {
        const row = await client.callFunction('getSwapOffer', { offerId: raw(args.offerId) }) as { offer?: unknown; status?: unknown };
        if (row.status !== 'open') throw new Error(`board offer ${args.offerId} is ${String(row.status)}, not open`);
        if (typeof row.offer !== 'string' || !(await sameOffer(args.offer, row.offer))) {
          throw new Error(`board offer ${args.offerId} carries another offer than the one passed: take the board's text, or drop offerId`);
        }
      }
      const taken = await takeOffer(config, {
        offer: args.offer,
        ...(args.expect ? { expect: { gives: legOut(args.expect.gives), wants: legOut(args.expect.wants) } } : {}),
      });
      if (!args.sponsorSessionId) return taken;
      let job: Record<string, unknown>;
      try {
        job = await client.callAction('sponsorSwap', {
          ...(args.offerId ? { offerId: args.offerId } : { makerHalfB64: taken.makerHalfB64 }),
          takerHalfB64: taken.takerHalfB64,
          sponsorSessionId: args.sponsorSessionId,
          idempotencyKey: args.idempotencyKey,
        }) as Record<string, unknown>;
      } catch (err) {
        if (!(err instanceof NightgateApiError)) throw err;
        throw new NightgateApiError(err.status, err.code, err.message, { ...(err.detail ?? {}), halfId: taken.id });
      }
      trackHalfJob(taken.id, job.jobId);
      return { ...job, id: taken.id, terms: taken.terms, bound: taken.bound, buildMs: taken.buildMs };
    }),
  );

  server.registerTool(
    'revert_swap_offer',
    {
      description:
        'Release the coins of a swap half this server built (build_swap_offer or take_swap_offer) ' +
        'that is not going to be used. Until then, or until the swap lands, the coins count as ' +
        'spent in this wallet. It does not recall an offer somebody already holds: to make a ' +
        'published offer worthless, spend its coins in another swap. Ids are listed by ' +
        'get_swap_wallet; a half whose swap landed leaves the list when get_job_status reports it.',
      inputSchema: {
        id: z.string().regex(/^[0-9a-f]{32}$/, 'id must be the 32 hex characters a swap tool returned'),
      },
    },
    run(async (args) => {
      if (!config) throw new Error('swaps are not configured for this server instance');
      return revertHalf(config, args.id);
    }),
  );

  server.registerTool(
    'sponsor_swap',
    {
      description:
        SWAP_HINT + ' This hands the two halves to the sponsor, which checks them, merges them, ' +
        'pays the dust and submits: each half carries an offer and nothing else, gives exactly ' +
        'one token type and wants exactly one other, both on the sponsor\'s token allow-list and ' +
        'never NIGHT, at most 4 inputs and 2 outputs per half, and the halves mirror each other ' +
        'in types and amounts. A half may be bound or unbound and is passed as offer file text ' +
        'or base64. Off on a server by default (NIGHTGATE_SPONSOR_ALLOW_SWAPS); an agent grant ' +
        'needs sponsorSwap in its allowedActions. Job result { txHash, swap: { gives, wants } }. ' +
        'An offer fills once: if it was taken first by somebody else the job fails. Pass both ' +
        'halves, or `halfId` alone for an offer this server took (take_swap_offer keeps both ' +
        'halves); with `offerId` the maker half comes from the board, next to takerHalf or the ' +
        'halfId of the taken offer. Poll get_job_status with the sessionId RETURNED by this call. ' + POLL_HINT,
      inputSchema: {
        makerHalf: swapHalf("The maker's half (the offer)").optional(),
        takerHalf: swapHalf("The taker's half").optional(),
        sponsorSessionId: z.string().uuid()
          .describe('Wallet session that pays the dust and submits, or the platform sponsor POOL id ' +
            `${PLATFORM_POOL_SENTINEL}`),
        idempotencyKey: z.string().optional()
          .describe('Dedupes retries of the SAME two halves'),
        halfId: z.string().regex(/^[0-9a-f]{32}$/, 'halfId must be the 32 hex characters a swap tool returned').optional()
          .describe('Id of the half this server built for the swap: alone it names a taken offer, next to both halves it ties the job to the half'),
        offerId: z.string().uuid().optional()
          .describe('An offer on the server\'s board (list_swap_offers): the server takes the maker half from there; pass takerHalf or the halfId of the taken offer with it'),
      },
    },
    run(async (args) => {
      let halves: Record<string, string>;
      if (args.offerId) {
        if (args.makerHalf) throw new Error('sponsor_swap with offerId takes the maker half from the board: no makerHalf');
        const takerHalf = args.takerHalf ?? (args.halfId ? takenHalves(args.halfId).takerHalfB64 : undefined);
        if (!takerHalf) throw new Error('sponsor_swap with offerId needs takerHalf, or the halfId of an offer this server took');
        halves = { offerId: args.offerId, takerHalfB64: takerHalf };
      } else {
        if (!!args.makerHalf !== !!args.takerHalf) throw new Error('sponsor_swap needs makerHalf AND takerHalf, or halfId alone');
        if (!args.makerHalf && !args.halfId) throw new Error('sponsor_swap needs makerHalf and takerHalf, or the halfId of an offer this server took');
        halves = args.makerHalf && args.takerHalf
          ? { makerHalfB64: args.makerHalf, takerHalfB64: args.takerHalf }
          : takenHalves(args.halfId as string);
      }
      const job = await client.callAction('sponsorSwap', {
        ...halves,
        sponsorSessionId: args.sponsorSessionId,
        idempotencyKey: args.idempotencyKey,
      }) as Record<string, unknown>;
      if (args.halfId) trackHalfJob(args.halfId, job?.jobId);
      return job;
    }),
  );

  server.registerTool(
    'post_swap_offer',
    {
      description:
        'Post a maker half on the server\'s offer board, so takers find it with list_swap_offers ' +
        'instead of receiving the offer file out of band. The server checks it like a half it ' +
        'would sponsor (one token type given, one wanted, both on its list, never NIGHT) and ' +
        'records its terms; the half itself stays signed by the maker. The offer closes when a ' +
        'swap that spends one of its inputs lands, on expiry, or by retire_swap_offer. Needs ' +
        'postSwapOffer in an agent grant\'s allowedActions. Returns { offerId, status, terms }.',
      inputSchema: {
        offer: swapHalf('The maker half, as offer file text or base64'),
        expiresAt: z.string().datetime().optional().describe('ISO timestamp; at most 90 days ahead'),
        tags: z.array(z.string().min(1).max(40)).max(8).optional().describe('Up to 8 tags for list_swap_offers'),
      },
    },
    run(async (args) => {
      const posted = await client.callAction('postSwapOffer', {
        offer: args.offer,
        expiresAt: args.expiresAt,
        tags: args.tags ? JSON.stringify(args.tags) : undefined,
      }) as Record<string, unknown> | undefined;
      await trackPostedHalf(args.offer, posted?.offerId).catch(() => { /* posted; the half is just not tied to it */ });
      return posted;
    }),
  );

  server.registerTool(
    'list_swap_offers',
    {
      description:
        'Offers on the server\'s board. Without status: the open ones, newest first. status filled | ' +
        'retired | expired | all reads the closed ones instead, ordered by last change; since keeps ' +
        'offers changed after that instant, so status all + since polled repeatedly is the board\'s ' +
        'change feed. Filters are exact 64-hex token types and one tag. ' + BOARD_ROW_HINT +
        ' Every token may read the board.',
      inputSchema: {
        givesType: hex64('givesType').optional().describe('Only offers that give this token type'),
        wantsType: hex64('wantsType').optional().describe('Only offers that want this token type'),
        tag: z.string().min(1).max(40).optional().describe('Only offers carrying this tag'),
        limit: z.number().int().min(1).max(200).optional().describe('Default 50'),
        status: OFFER_STATUS.optional().describe('Default open'),
        since: z.string().datetime().optional().describe('ISO timestamp; only offers changed after it'),
      },
    },
    run(async (args) => settled(await listOffers(client, { ...args, mine: null }))),
  );

  server.registerTool(
    'my_swap_offers',
    {
      description:
        'The offers this caller posted on the board (a token: its grant\'s), open and closed, ' +
        'ordered by last change: what is still open, what filled (filledTxHash), what expired or ' +
        'was retired. status narrows to one state, since to offers changed after an instant. ' +
        BOARD_ROW_HINT,
      inputSchema: {
        status: OFFER_STATUS.optional().describe('Default all'),
        since: z.string().datetime().optional().describe('ISO timestamp; only offers changed after it'),
        limit: z.number().int().min(1).max(200).optional().describe('Default 50'),
      },
    },
    run(async (args) => settled(await listOffers(client, { status: args.status ?? 'all', since: args.since, limit: args.limit, mine: true }))),
  );

  server.registerTool(
    'get_swap_offer',
    {
      description:
        'One board offer by id, open or closed, in the board\'s shape: status, filledTxHash once a ' +
        'swap spent it, closedAt, changedAt. The way to follow an offer after post_swap_offer or ' +
        'after taking one. Unknown id: 404. ' + BOARD_ROW_HINT,
      inputSchema: {
        offerId: z.string().uuid().describe('The board entry'),
      },
    },
    run(async (args) => settled(await client.callFunction('getSwapOffer', { offerId: raw(args.offerId) }))),
  );

  server.registerTool(
    'get_board_status',
    {
      description:
        'Counts of the server\'s offer board and its sponsors, no credentials needed: openOffers, ' +
        'offersFilledToday and swapsToday (UTC day), sponsorsConfigured and sponsorsReady (at tip ' +
        'with a spendable dust note; 0 means a sponsor_swap would wait or fail now), asOf. ' +
        'Computed at most every 10 s.',
      inputSchema: {},
    },
    run(async () => client.callIndexerFunction('getBoardStatus')),
  );

  server.registerTool(
    'retire_swap_offer',
    {
      description:
        'Take an offer off the board. Only its poster may; the coins behind the half stay ' +
        'reserved until revert_swap_offer releases the half built here. Returns { offerId, status }.',
      inputSchema: {
        offerId: z.string().uuid().describe('The board entry'),
      },
    },
    run(async (args) => client.callAction('retireSwapOffer', { offerId: args.offerId })),
  );

  server.registerTool(
    'grant_disclosure_to_holders',
    {
      description:
        'Disclose a document to everyone who holds a token: whoever registered a claim key on ' +
        'the holder-registry contract for tokenType by passing a coin through it can read the ' +
        'text with claim_disclosure, and the server never learns who. content must hash to ' +
        'payloadHash (blake2b-256 or sha256 of the UTF-8 text); it is stored encrypted. A repeat ' +
        'call for the same payload, token type and registry updates the grant (content kept ' +
        'when omitted). Returns { holderGrantId, hasContent, expiresAt, status }.',
      inputSchema: {
        payloadHash: hex64('payloadHash').describe('Hash of the document (64 hex)'),
        tokenType: hex64('tokenType').describe('The raw shielded token type whose holders may read (64 hex)'),
        registryAddress: hex64('registryAddress').describe('The holder-registry deployment holders registered on'),
        content: z.string().max(1_048_576).optional().describe('The document text; must hash to payloadHash'),
        contentType: z.string().max(100).optional().describe("Default 'text/plain'"),
        expiresAt: z.string().datetime().optional().describe('ISO timestamp, at most one year ahead'),
      },
    },
    run(async (args) =>
      client.callAction('grantDisclosureToHolders', {
        payloadHash: args.payloadHash.toLowerCase(),
        tokenType: args.tokenType.toLowerCase(),
        registryAddress: args.registryAddress.toLowerCase(),
        content: args.content,
        contentType: args.contentType,
        expiresAt: args.expiresAt,
      })),
  );

  server.registerTool(
    'revoke_holder_disclosure',
    {
      description: 'Revoke a disclosure to token holders. Only its grantor may. Returns { holderGrantId, status }.',
      inputSchema: {
        holderGrantId: z.string().uuid().describe('From grant_disclosure_to_holders'),
      },
    },
    run(async (args) => client.callAction('revokeHolderDisclosure', { holderGrantId: args.holderGrantId })),
  );

  server.registerTool(
    'claim_disclosure',
    {
      description:
        'Read a document disclosed to the holders of a token. claimSecret is the 32-byte secret ' +
        'behind the claim key registered on the holder-registry contract (holder_claim_key); the ' +
        'server reads the registry live and answers { entitled, content, contentType, ' +
        'contentHashKind, expiresAt } or { entitled: false, reason }. Needs a live indexer on ' +
        'the server.',
      inputSchema: {
        payloadHash: hex64('payloadHash').describe('Hash of the document (64 hex)'),
        tokenType: hex64('tokenType').describe('The raw shielded token type (64 hex)'),
        claimSecret: hex64('claimSecret').describe('The secret behind the registered claim key (64 hex)'),
      },
    },
    run(async (args) =>
      client.callAction('claimDisclosure', {
        payloadHash: args.payloadHash.toLowerCase(),
        tokenType: args.tokenType.toLowerCase(),
        claimSecret: args.claimSecret.toLowerCase(),
      })),
  );

  server.registerTool(
    'holder_claim_key',
    {
      description:
        'The claim key a token holder registers on the holder-registry contract, derived from a ' +
        '32-byte secret (compute-only). Without a secret a fresh random one is generated: keep ' +
        'it, claim_disclosure needs it. Register the key with registerHolder(coin, claimKey) on ' +
        'the registry (one coin of the token type passes through the contract and comes back), ' +
        'e.g. through build_sponsorable_transaction on a builder that knows the registry.',
      inputSchema: {
        claimSecret: hex64('claimSecret').optional().describe('Existing secret (64 hex); omit to generate one'),
      },
    },
    run(async (args) => {
      const holderClaimKey = await txExport<(secretHex: string) => string>('holderClaimKey', 'holder_claim_key', '0.10.0');
      const { randomBytes } = await import('node:crypto');
      const claimSecret = (args.claimSecret ?? randomBytes(32).toString('hex')).toLowerCase();
      return { claimSecret, claimKey: holderClaimKey(claimSecret) };
    }),
  );

  server.registerTool(
    'derive_token_type',
    {
      description:
        'Derive the raw token type a minting contract produces (compute-only, no wallet, no ' +
        'chain access). A custom token is addressed by rawTokenType(domainSeparator, ' +
        'contractAddress); without it the minted balance cannot be transferred. domainSeparator ' +
        'is the plain string the contract pads (Compact pad(32, "...")) or 64 hex for the padded ' +
        "bytes; defaults to the bundled test token's. The result feeds sendNight(tokenTypeHex).",
      inputSchema: {
        contractAddress: z.string().min(1).describe('The minting contract address (64 hex)'),
        domainSeparator: z.string().optional()
          .describe("Separator string or 64 hex; defaults to 'nightgate:zswap-e2e' (the bundled test token)"),
      },
    },
    run(async (args) =>
      client.callFunction('deriveTokenType', {
        contractAddress: args.contractAddress,
        domainSeparator: args.domainSeparator,
      })),
  );

  server.registerTool(
    'mint_token',
    {
      description:
        'Mint a shielded token with a name of your own on a token-factory deployment. Two ways. ' +
        'LOCAL (default, no sessionId): this process is the issuer, its issuer secret derives from ' +
        'NIGHTGATE_SEED_HEX, the mint is built, proven and signed here and the fee-unpaid ' +
        'transaction goes to the sponsor (sponsorSessionId, default the platform pool) like ' +
        'sponsor_unbound_transaction; the seed never leaves this process. The factory has to be ' +
        'on the sponsor\'s contract list and mint on its circuit list. SERVER (sessionId given): the ' +
        'server session is the issuer and mints through mintFactoryToken; needs that action in ' +
        'the grant. Either way the same name from another issuer is another token, and the ' +
        'response names the token before the job runs ({ tokenType, domain, issuerKey }); a ' +
        'landed mint makes the type known to the sponsor (swaps, offer board). The recipient ' +
        'defaults to this wallet (get_attester_identity); another wallet takes both of its keys. ' +
        'Job result { txHash, ... }. Poll get_job_status with the sessionId RETURNED by this call. ' + POLL_HINT,
      inputSchema: {
        contractAddress: hex64('contractAddress').describe('A token-factory deployment'),
        name: z.string().min(1).refine((s) => Buffer.byteLength(s, 'utf8') <= 32, 'name must be at most 32 UTF-8 bytes')
          .describe('Token name, at most 32 UTF-8 bytes; with the issuer it names the token type'),
        amount: z.union([
          z.string().regex(/^[1-9]\d*$/, 'amount must be a positive integer (decimal string)'),
          z.number().int().positive().safe(),
        ]).describe('Atoms to mint; a decimal string is exact'),
        recipientCoinPublicKey: hex64('recipientCoinPublicKey').optional()
          .describe('Zswap coin public key of the receiving wallet (64 hex); default this wallet\'s own'),
        recipientEncryptionPublicKey: hex64('recipientEncryptionPublicKey').optional()
          .describe('The receiving wallet\'s encryption public key (64 hex); required with a recipient other than this wallet, local way'),
        sponsorSessionId: z.string().uuid().optional()
          .describe(`Local way: the session that pays the dust and submits; default the platform sponsor POOL id ${PLATFORM_POOL_SENTINEL}. Server way: an optional second session that pays`),
        sessionId: z.string().uuid().optional()
          .describe('Server way only: the wallet session that mints; it is the issuer'),
        idempotencyKey: z.string().optional().describe('Dedupes retries'),
      },
    },
    run(async (args) => {
      if (args.sessionId) {
        let recipient = args.recipientCoinPublicKey;
        if (!recipient) {
          if (!config?.seedHex) throw new Error('mint_token needs recipientCoinPublicKey: no NIGHTGATE_SEED_HEX for a default');
          recipient = (await seedIdentity(config)).coinPublicKey;
          if (!recipient) throw new Error('mint_token needs recipientCoinPublicKey: the seed exposes no shielded keys');
        }
        return client.callAction('mintFactoryToken', {
          contractAddress: args.contractAddress.toLowerCase(),
          name: args.name,
          amount: String(args.amount),
          recipientCoinPublicKey: recipient.toLowerCase(),
          sessionId: args.sessionId,
          idempotencyKey: args.idempotencyKey,
          sponsorSessionId: args.sponsorSessionId,
        });
      }
      if (!config) throw new Error('local minting is not configured for this server instance');
      const built = await buildMint(config, {
        contractAddress: args.contractAddress,
        name: args.name,
        amount: String(args.amount),
        recipientCoinPublicKey: args.recipientCoinPublicKey,
        recipientEncryptionPublicKey: args.recipientEncryptionPublicKey,
      });
      const job = await client.callAction('sponsorUnboundTransaction', {
        unboundTxB64: built.unboundTxB64,
        sponsorSessionId: args.sponsorSessionId ?? PLATFORM_POOL_SENTINEL,
        idempotencyKey: args.idempotencyKey,
      }) as Record<string, unknown>;
      const { unboundTxB64: _tx, ...rest } = built;
      return { ...job, ...rest, channel: 'local' };
    }),
  );
  server.registerTool(
    'get_job_status',
    {
      description:
        'Poll the status of an async NIGHTGATE job (all submit actions return a jobId). ' +
        'status: pending | running | external_execution | submitted | reconciliation_required | ' +
        'succeeded | failed. Poll every few seconds until succeeded or failed; result carries ' +
        'the job outcome JSON, chainStatus tracks on-chain finalization independently. ' +
        'Sponsor jobs: failed + errorCode CHAIN_EXECUTION_FAILED = the transaction IS on-chain but ' +
        'the contract call did not apply (same-contract conflict) -> rebuild and sponsor again; ' +
        'reconciliation_required = broadcast outcome unknown to the server yet, the transaction ' +
        'identifier is in the error message, the server keeps resolving it via the indexer. ' +
        'Batches: once confirmed, chainSegments ([{ segment, calls, applied }]) says which calls ' +
        'applied; resend only the ones with applied false. Swaps: the result carries swap ' +
        '{ gives, wants }, what was exchanged from the maker\'s side. Mints: tokenType.',
      inputSchema: {
        jobId: z.string().uuid().describe('Job id returned by a submit action'),
        sessionId: z.string().uuid()
          .describe('Wallet session id the job belongs to; for sponsor jobs the sessionId RETURNED by the sponsor call'),
      },
    },
    run(async (args) => {
      const job = await client.callAction('getJobStatus', {
        jobId: args.jobId,
        sessionId: args.sessionId,
      }) as Record<string, unknown> | undefined;
      settleHalfJob(args.jobId, job?.status);
      return job;
    }),
  );
}

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

/** listSwapOffers wants all seven parameters, null for the unused ones. */
/** Board rows pass through unchanged after settling the maker halves posted as them. */
function settled<T>(rows: T): T {
  settleBoardRows(rows);
  return rows;
}

function listOffers(client: NightgateClient, args: {
  givesType?: string; wantsType?: string; tag?: string; limit?: number; status?: string; since?: string; mine: boolean | null;
}): Promise<unknown> {
  return client.callFunction('listSwapOffers', {
    givesType: args.givesType?.toLowerCase() ?? null,
    wantsType: args.wantsType?.toLowerCase() ?? null,
    tag: args.tag ?? null,
    limit: args.limit ?? null,
    status: args.status ?? null,
    since: args.since ?? null,
    mine: args.mine,
  });
}

/**
 * Uniform handler wrapper: JSON success payloads, API errors reported as
 * tool errors (isError) with status + OData code so the agent can react
 * (e.g. 401 -> credentials, 429 -> back off) instead of crashing the call.
 */
export function wrapHandler(_client: NightgateClient) {
  return function run<A>(fn: (args: A) => Promise<unknown>) {
    return async (args: A): Promise<ToolResult> => {
      try {
        const result = await fn(args);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        if (err instanceof NightgateApiError) {
          const detail = { httpStatus: err.status, code: err.code ?? null, message: err.message, ...(err.detail ?? {}) };
          return { content: [{ type: 'text', text: JSON.stringify(detail, null, 2) }], isError: true };
        }
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: message }], isError: true };
      }
    };
  };
}
