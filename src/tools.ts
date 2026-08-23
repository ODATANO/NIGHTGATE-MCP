import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { int64, NightgateApiError, NightgateClient } from './client.js';
import type { NightgateMcpConfig } from './config.js';
import { BUILDABLE_CALLS, BUILDABLE_ARTIFACTS, buildSponsorable, attesterIdentity } from './builder.js';

const HEX64 = /^[0-9a-fA-F]{64}$/;
const hex64 = (what: string) =>
  z.string().regex(HEX64, `${what} must be 64 hex characters`);

/** Scaled non-negative integer, as string (preferred, exact) or JS number. */
const scaledInt = (what: string) =>
  z.union([
    z.string().regex(/^\d+$/, `${what} must be a non-negative integer (decimal string)`),
    z.number().int().nonnegative(),
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
        'Verify against LIVE Midnight contract state that a payload hash is attested in an ' +
        'AttestationVault (crawler-free, no txHash needed). Optionally also checks that the ' +
        'anchored content root matches. Returns verified:false (not an error) when absent.',
      inputSchema: {
        contractAddress: z.string().min(1).describe('AttestationVault contract address'),
        payloadHash: hex64('payloadHash').describe('The attested payload hash (sha256, 64 hex)'),
        contentRoot: hex64('contentRoot').optional().describe('Optional anchored content root to check (64 hex)'),
        schemaId: hex64('schemaId').optional()
          .describe('Optional anchored schema id to check; the result reports schemaOk, so an examiner can pin the canonical field list'),
        network: z.enum(['preview', 'preprod', 'mainnet']).optional()
          .describe('Read from another network public indexer instead of the configured one'),
        compiledArtifactRef: z.string().optional().describe("Contract artifact ref, defaults to 'attestation-vault'"),
      },
    },
    run(async (args) =>
      client.callFunction('verifyAttestationState', {
        contractAddress: args.contractAddress,
        payloadHash: args.payloadHash,
        contentRoot: args.contentRoot,
        schemaId: args.schemaId,
        compiledArtifactRef: args.compiledArtifactRef,
        network: args.network,
      })),
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
        '(recompute it from the published list via prepare_membership_set).',
      inputSchema: {
        contractAddress: z.string().min(1).describe('AttestationVault contract address'),
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
        payloadHash: args.payloadHash,
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
        'circuit. Commits only the sha256 + public metadata; you are responsible for storing the ' +
        'actual bytes at storageRef. Plain attestation is first-come-first-served per hash, so a ' +
        'mempool observer can front-run a visible hash: for a hash that is secret until anchoring, ' +
        'use prepare_anchor_commitment + commit_document_anchor first and pass the nonce here, ' +
        'which turns this call into the guarded REVEAL and reclaims a front-run hash. ' + POLL_HINT +
        ' Also returns documentId for verify_document.',
      inputSchema: {
        sha256: hex64('sha256').describe('sha256 of the document content (64 hex), becomes the on-chain payload hash'),
        storageRef: z.string().min(1).describe('Where the bytes live, e.g. file://, s3://, ipfs://'),
        sessionId: z.string().uuid().describe('Wallet session id that signs and submits'),
        contractAddress: z.string().min(1).describe('AttestationVault deployment to anchor into'),
        contentType: z.string().optional().describe('MIME type, informational'),
        size: z.number().int().nonnegative().optional().describe('Content size in bytes, informational'),
        metadata: z.record(z.unknown()).optional().describe('Public metadata object; its hash is anchored alongside'),
        nonce: hex64('nonce').optional()
          .describe('Guarded REVEAL: the secret nonce from prepare_anchor_commitment, after commit_document_anchor finalized. Same sha256 and metadata as the commitment'),
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
        nonce: args.nonce,
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
    'prepare_anchor_commitment',
    {
      description:
        'Phase 0 of guarded anchoring: compute the opaque commitment for commit_document_anchor ' +
        'plus the nonce the later reveal needs. Compute-only and synchronous. STORE the nonce and ' +
        'keep it SECRET until the reveal: it is exactly what a mempool front-runner cannot forge. ' +
        'Pass the same metadata here and to anchor_document. Use this when the payload hash is ' +
        'secret until anchoring; for publicly known identifiers, registrar pre-assignment is the ' +
        'better protection.',
      inputSchema: {
        sha256: hex64('sha256').describe('sha256 of the document content (64 hex)'),
        metadata: z.record(z.unknown()).optional()
          .describe('Public metadata object; MUST equal the metadata passed to anchor_document later'),
        nonce: hex64('nonce').optional().describe('Reuse a specific nonce; omit for a fresh random one'),
      },
    },
    run(async (args) =>
      client.callAction('prepareAnchorCommitment', {
        sha256: args.sha256,
        metadata: args.metadata === undefined ? undefined : JSON.stringify(args.metadata),
        nonce: args.nonce,
      })),
  );

  server.registerTool(
    'commit_document_anchor',
    {
      description:
        'Phase 1 of guarded anchoring: record the opaque commitment on-chain. Observers learn ' +
        'nothing about the payload. Once this job finalizes, call anchor_document with the SAME ' +
        'sha256 and metadata plus the nonce to reveal; a plain attest that front-ran the reveal is ' +
        'taken over in-circuit, and everything the front-runner recorded meanwhile (content root, ' +
        'disclosure grants, claims) stops counting. ' + POLL_HINT,
      inputSchema: {
        commitment: hex64('commitment').describe('The commitment from prepare_anchor_commitment (64 hex)'),
        sessionId: z.string().uuid().describe('Wallet session id that signs and submits; the SAME session must reveal'),
        contractAddress: z.string().min(1).describe('AttestationVault deployment'),
        compiledArtifactRef: z.string().optional().describe("Contract artifact ref, defaults to 'attestation-vault'"),
        idempotencyKey: z.string().optional().describe('Dedupes retries'),
        sponsorSessionId: z.string().uuid().optional().describe('Optional second session that pays the dust fee'),
      },
    },
    run(async (args) =>
      client.callAction('commitDocumentAnchor', {
        commitment: args.commitment,
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
        'bindPassport {passportId, payloadHash}; attestCommit {commitment}; attestReveal ' +
        '{payloadHash, metadataHash, nonce}. ZK CLAIMS, proven here with no wallet on the ' +
        'server and no witness ever sent to it: proveFieldPredicate {payloadHash, fieldKey, ' +
        'threshold, op 0=lessOrEqual|1=greaterOrEqual} plus merkleProof {fieldValue, fieldSalt, ' +
        'siblings, dirs}; proveFieldEquality {payloadHash, fieldKey, expectedDigest} plus ' +
        'merkleProof {fieldSalt, siblings, dirs}; proveFieldMembership {payloadHash, fieldKey, ' +
        'setRoot} plus merkleProof {fieldDigest, fieldSalt, siblings, dirs, setProof}; ' +
        'proveFieldsUnchangedExcept {payloadHashA, payloadHashB, allowedMask} and ' +
        'proveFieldsDiffer {payloadHashA, payloadHashB, k}, both plus docPair {schema, ' +
        'openingA, openingB}. Every witness field comes straight out of ' +
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
        'txbuilder), plus the network. Use it to check verify_attestation results against the ' +
        'identity that will appear on-chain; builds nothing and submits nothing.',
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
        'identifier is in the error message, the server keeps resolving it via the indexer.',
      inputSchema: {
        jobId: z.string().uuid().describe('Job id returned by a submit action'),
        sessionId: z.string().uuid()
          .describe('Wallet session id the job belongs to; for sponsor jobs the sessionId RETURNED by the sponsor call'),
      },
    },
    run(async (args) =>
      client.callAction('getJobStatus', {
        jobId: args.jobId,
        sessionId: args.sessionId,
      })),
  );
}

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

/**
 * Uniform handler wrapper: JSON success payloads, API errors reported as
 * tool errors (isError) with status + OData code so the agent can react
 * (e.g. 401 -> credentials, 429 -> back off) instead of crashing the call.
 */
function wrapHandler(_client: NightgateClient) {
  return function run<A>(fn: (args: A) => Promise<unknown>) {
    return async (args: A): Promise<ToolResult> => {
      try {
        const result = await fn(args);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        if (err instanceof NightgateApiError) {
          const detail = { httpStatus: err.status, code: err.code ?? null, message: err.message };
          return { content: [{ type: 'text', text: JSON.stringify(detail, null, 2) }], isError: true };
        }
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: message }], isError: true };
      }
    };
  };
}
