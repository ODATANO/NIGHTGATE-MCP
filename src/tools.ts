import { createHash } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { int64, raw, NightgateApiError, NightgateClient } from './client.js';
import { isGatewayKey, vaultOf, type NightgateMcpConfig } from './config.js';
import { BUILDABLE_CALLS, BUILDABLE_ARTIFACTS, DEFAULT_ARTIFACT, buildSponsorable, attesterIdentity, type BuildInput } from './builder.js';
import {
  buildOffer, buildTransfer, earliestPostedAt, halfJobIds, postedOfferIds, readOffer, releaseLapsedHalves, revertHalf, revertOffer, sameOffer, settleBoardRows,
  settleHalfJob, swapWalletInfo, takenHalves, takeOffer, trackHalfJob, trackPostedHalf,
} from './swap.js';
import { buildBurn, buildMint } from './factory.js';
import { buildContractCall, nightCallSent } from './contract-call.js';
import { randomBytes } from 'node:crypto';
import { resolveTxSource } from './built.js';
import { awaitJob, callStage, chainOutcome, forgetStart, jobSession, markReused, startSponsored, type JobCheck, type ToolExtra } from './jobs.js';
import { seedCreated, seedNotice } from './seed.js';

const HEX64 = /^[0-9a-fA-F]{64}$/;
const hex64 = (what: string) =>
  z.string().regex(HEX64, `${what} must be 64 hex characters`);

/** Scaled non-negative integer, as string (preferred, exact) or JS number; a number stays below 2^53 so String() renders it exactly. */
const scaledInt = (what: string) =>
  z.union([
    z.string().regex(/^\d+$/, `${what} must be a non-negative integer (decimal string)`),
    z.number().int().nonnegative().safe(),
  ]);

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
const TX_ID = z.string().regex(/^[0-9a-f]{64}$/, 'txId must be the 64 hex characters a build tool returned').optional();
const TX_FILE = z.string().min(1).optional()
  .describe('Path of a file holding the transaction, as base64 text or raw bytes (outFile of a build tool, or written by the txbuilder)');
const swapHalf = (what: string) => z.string().min(16)
  .describe(`${what}: offer file text (swapoffer1...) or base64 of the serialized, proven transaction`);
const SWAP_HINT = 'A swap settles two shielded tokens between two wallets without a contract: each side builds one half ' +
  '(it spends the coin it gives and creates the coin it wants), the two mirrored halves merge into one transaction, ' +
  'and a sponsor pays the fee.';

const OFFER_STATUS = z.enum(['open', 'filled', 'retired', 'expired', 'all']);
const BOARD_ROW_HINT = 'Each row: offerId, the offer half (feed it to read_swap_offer or take_swap_offer), gives/wants ' +
  'type and amount, tags, expiresAt, postedAt, status, filledTxHash, closedAt, changedAt. Never the poster or the ' +
  "half's nullifiers.";

const MAX_SLOT_WIDTH = 32;

const RETRY_HINT = 'If the call was cut off or came back pending, run it again with the same arguments: ' +
  'it picks up the job it started and submits nothing new (the answer says deduplicated). ' +
  'A second, separate call with the same arguments needs a new idempotencyKey.';
const RECEIPT_HINT = 'The tool also waits for the block (about a minute more) and then carries the instance\'s signed ' +
  'receipt; if that wait runs out, receipt is null and the same call again fetches it. ';
const WAIT_HINT = 'The tool waits until the job settled (about 1 minute) and returns { status, txHash, transactionHash, result }. ' +
  'failed: `next` says what to do. ' + RETRY_HINT;
const MAX_MASK = 0xffffffff;

/** Names one request, so a repeat of it is recognised; witness and bytes enter only as a hash. */
function callKey(...parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v))).digest('hex');
}

/** The free verify call that shows a vault call's effect on-chain; none when the call names its record by key only. */
function checkFor(input: Omit<BuildInput, 'bind'>, ownAttesterId: string): JobCheck | undefined {
  const p = input.params;
  const hex = (k: string) => (typeof p[k] === 'string' ? String(p[k]).toLowerCase() : undefined);
  const base = { contractAddress: input.contractAddress, compiledArtifactRef: input.compiledArtifactRef ?? DEFAULT_ARTIFACT };
  const record = (payloadHash?: string, attesterId?: string) =>
    payloadHash ? { ...base, attesterId: attesterId ?? ownAttesterId, payloadHash } : undefined;
  const claim = (args: Record<string, unknown> | undefined): JobCheck | undefined => (args ? { tool: 'verify_predicate', args } : undefined);
  switch (input.call) {
    case 'attest':
    case 'anchorContentRoot':
    case 'grantDisclosure':
    case 'revokeDisclosure':
    case 'bindPassport': {
      const r = record(hex('payloadHash'));
      if (!r) return undefined;
      const root = input.call === 'anchorContentRoot' ? { contentRoot: hex('contentRoot'), schemaId: hex('schemaId') } : {};
      return { tool: 'verify_attestation', args: { ...r, ...root } };
    }
    case 'proveFieldPredicate': {
      const r = record(hex('payloadHash'), hex('attesterId'));
      return claim(r && { ...r, predicate: Number(p.op) === 1 ? 'greaterOrEqual' : 'lessOrEqual', fieldKey: hex('fieldKey'), threshold: String(p.threshold) });
    }
    case 'proveFieldEquality': {
      const r = record(hex('payloadHash'), hex('attesterId'));
      return claim(r && { ...r, predicate: 'bytesEquality', fieldKey: hex('fieldKey'), expectedDigest: hex('expectedDigest') });
    }
    case 'proveFieldMembership': {
      const r = record(hex('payloadHash'), hex('attesterId'));
      return claim(r && { ...r, predicate: 'setMembership', fieldKey: hex('fieldKey'), setRoot: hex('setRoot') });
    }
    case 'proveFieldsUnchangedExcept':
    case 'proveFieldsDiffer': {
      const r = record(hex('payloadHashA'), hex('attesterIdA'));
      if (!r || !hex('payloadHashB')) return undefined;
      const extraArgs = input.call === 'proveFieldsUnchangedExcept'
        ? { predicate: 'documentIntegrity', allowedMask: Number(p.allowedMask) }
        : { predicate: 'documentDiff', k: Number(p.k) };
      return claim({ ...r, payloadHashB: hex('payloadHashB'), attesterIdB: hex('attesterIdB'), ...extraArgs });
    }
    default:
      return undefined;
  }
}

const CONTRACT = z.string().regex(HEX64, 'contractAddress must be 64 hex characters').optional()
  .describe('AttestationVault address (64 hex); default the shared sandbox vault of the network (preprod, preview)');

/** Every NIGHTGATE tool. Writes are built here with the caller seed and paid by a sponsor; no tool needs a server wallet. */
export function registerTools(server: McpServer, client: NightgateClient, config?: NightgateMcpConfig): void {
  const run = wrapHandler(client);
  /** What a contract call that pays NIGHT does once its job settled, by job id; it runs once. */
  const callSettlers = new Map<string, (outcome: 'landed' | 'failed') => Promise<void>>();
  // A job that was still open when its tool returned may have landed or failed since.
  const settleOpenJobs = async (): Promise<void> => {
    if (!config) return;
    for (const jobId of new Set([...halfJobIds(), ...callSettlers.keys()])) {
      const sessionId = jobSession(jobId);
      if (!sessionId) continue;
      const job = await client.callAction('getJobStatus', { jobId, sessionId }).catch(() => undefined) as Record<string, unknown> | undefined;
      if (!job) continue;
      await settleHalfJob(config, jobId, job);
      await settleCall(jobId, job);
    }
  };
  const settleCall = async (jobId: string, job: Record<string, unknown>): Promise<void> => {
    const outcome = chainOutcome(job);
    const settle = callSettlers.get(jobId);
    if (outcome === 'unknown' || !settle) return;
    callSettlers.delete(jobId);
    await settle(outcome).catch((err) => console.error(`nightgate-mcp: NIGHT coins of job ${jobId} not settled: ${(err as Error).message}`));
  };
  /** Board rows pass through after settling the halves posted as them; a lapsed half is released in the background. */
  const settleRows = <T>(rows: T): T => {
    settleBoardRows(rows);
    if (config) void releaseLapsedHalves(config).catch(() => { /* logged where it failed */ });
    return rows;
  };
  const vault = (contractAddress?: string, compiledArtifactRef?: string): string => {
    if (config) return vaultOf(config, contractAddress, compiledArtifactRef);
    if (!contractAddress) throw new Error('contractAddress is required');
    return contractAddress.toLowerCase();
  };
  // One read of the caller's own offers settles the maker halves posted here.
  let boardReadAt: number | undefined;
  const settlePostedOffers = async (): Promise<void> => {
    const asked = Date.now();
    const from = (boardReadAt ?? earliestPostedAt() ?? asked) - BOARD_OVERLAP_MS;
    const rows = await listOffers(client, { status: 'all', since: new Date(from).toISOString(), limit: BOARD_PAGE, mine: true }).catch(() => undefined);
    if (rows !== undefined) settleBoardRows(rows);
    if (rows !== undefined && boardRows(rows).length < BOARD_PAGE) { boardReadAt = asked; return; }
    // a failed read or a full page may miss an offer: read the ones still held here one by one
    for (const offerId of postedOfferIds()) {
      settleBoardRows(await client.callFunction('getSwapOffer', { offerId: raw(offerId) }).catch(() => undefined));
    }
  };

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
        'carries attesterId, payloadHash, recordKey and documentId. bindingRegistered is only ' +
        'about documentId lookups: true when the vault registrar assigned that id to this ' +
        'attester. A record anchored without a document id reports false, and that is fine. ' +
        'Free: it reads the public verify service.',
      inputSchema: {
        contractAddress: CONTRACT,
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
        compiledArtifactRef: z.string().optional().describe("Contract artifact ref, defaults to 'attestation-vault-32'; 'attestation-vault' for a 16-slot vault"),
      },
    },
    run(async (args) => {
      if (!args.documentId && !(args.attesterId && args.payloadHash)) {
        throw new Error('name the record: attesterId + payloadHash, or documentId');
      }
      return client.callVerifyFunction('verifyAttestationState', {
        contractAddress: vault(args.contractAddress, args.compiledArtifactRef),
        attesterId: args.attesterId,
        payloadHash: args.payloadHash,
        documentId: args.documentId,
        contentRoot: args.contentRoot,
        schemaId: args.schemaId,
        compiledArtifactRef: args.compiledArtifactRef ?? DEFAULT_ARTIFACT,
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
        'to ONE attester\'s record of the document, so attesterId is part of the coordinates. ' +
        'Free: it reads the public verify service.',
      inputSchema: {
        contractAddress: CONTRACT,
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
        compiledArtifactRef: z.string().optional().describe("Contract artifact ref, defaults to 'attestation-vault-32'; 'attestation-vault' for a 16-slot vault"),
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
      return client.callVerifyFunction('verifyPredicateState', {
        contractAddress: vault(args.contractAddress, args.compiledArtifactRef),
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
        compiledArtifactRef: args.compiledArtifactRef ?? DEFAULT_ARTIFACT,
        network: args.network,
      });
    }),
  );

  server.registerTool(
    'prepare_document_proof',
    {
      description:
        'Turn a structured document into everything the proof tools need: canonical JSON and its ' +
        'payloadHash (what anchor_document anchors), a Merkle contentRoot over an ORDERED list of ' +
        'up to 16 proof fields, and per-field inclusion paths ready for the proveField* calls of ' +
        'submit_vault_call. kind "uint" (default) scales a numeric ' +
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
        document: z.record(z.string(), z.unknown())
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
        compiledArtifactRef: z.string().optional().describe("Contract artifact ref, defaults to 'attestation-vault-32'; 'attestation-vault' for a 16-slot vault"),
      },
    },
    run(async (args) =>
      client.callAction('prepareDocumentProof', {
        document: args.document,
        proofFields: args.proofFields,
        saltSeed: args.saltSeed,
        compiledArtifactRef: args.compiledArtifactRef ?? DEFAULT_ARTIFACT,
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
        compiledArtifactRef: z.string().optional().describe("Contract artifact ref, defaults to 'attestation-vault-32'; 'attestation-vault' for a 16-slot vault"),
      },
    },
    run(async (args) => {
      if (args.value !== undefined && args.valueDigest !== undefined) {
        throw new Error('pass at most one of value / valueDigest');
      }
      return client.callAction('prepareMembershipSet', {
        allowedValues: args.allowedValues,
        value: args.value,
        valueDigest: args.valueDigest,
        compiledArtifactRef: args.compiledArtifactRef ?? DEFAULT_ARTIFACT,
      });
    }),
  );

  /** Wait for a swap job; a landed swap frees its half here, one the chain refused stays for a revert. */
  const awaitSwap = async (started: Record<string, unknown>, offerId: string | undefined, extra: ToolExtra) => {
    const check: JobCheck = offerId ? { tool: 'get_swap_offer', args: { offerId } } : { tool: 'get_swap_wallet', args: {} };
    const job = await awaitJob(client, config, started, extra, check);
    if (config && typeof started.jobId === 'string') await settleHalfJob(config, started.jobId, job);
    return job;
  };

  /** Hand bytes to a sponsor once and wait; the same bytes again pick up that job. */
  const sponsorOnce = async (action: string, body: Record<string, unknown>, idempotencyKey: string | undefined, extra: ToolExtra, check?: JobCheck) => {
    const key = callKey(action, body, idempotencyKey ?? null);
    const started = await startSponsored(client, key, idempotencyKey, async (k) => ({ action, body: { ...body, idempotencyKey: k } }));
    const job = await awaitJob(client, config, started.job, extra, check);
    if (chainOutcome(job) === 'failed') forgetStart(key);
    return markReused(job, started, !!idempotencyKey);
  };

  /** Build one vault call here, hand it to the sponsor and wait until it settled. */
  const submitVaultCall = async (input: Omit<BuildInput, 'bind'>, idempotencyKey: string | undefined, extra: ToolExtra): Promise<Record<string, unknown>> => {
    if (!config) throw new Error('local building is not configured for this server instance');
    const key = callKey('vault', input.contractAddress, input.compiledArtifactRef ?? DEFAULT_ARTIFACT, input.call, input.params, input.merkleProof, input.docPair, idempotencyKey ?? null);
    const started = await startSponsored(client, key, idempotencyKey, async (k) => {
      const built = await buildSponsorable(config, { ...input, bind: false });
      const { b64 } = await resolveTxSource({ txId: built.txId }, 'unboundTxB64');
      return {
        action: 'sponsorUnboundTransaction',
        body: { unboundTxB64: b64, idempotencyKey: k },
        info: { attesterId: built.attesterId, contractAddress: input.contractAddress, buildMs: built.buildMs, timings: { setupMs: built.setupMs, proveMs: built.proveMs } },
      };
    });
    const job = await awaitJob(client, config, started.job, extra, checkFor(input, String(started.job.attesterId)));
    if (chainOutcome(job) === 'failed') forgetStart(key);
    return markReused(job, started, !!idempotencyKey);
  };

  server.registerTool(
    'anchor_document',
    {
      description:
        'Anchor a document hash on Midnight in one call: builds the attest transaction here with ' +
        'the caller seed, a sponsor pays the fee, and the tool waits until it landed (about 1 to 2 ' +
        'minutes; the first call also downloads the prover keys). The record belongs to this ' +
        'seed (attesterId). Only the hash and the hash of the metadata go on-chain; keep the ' +
        'document yourself. With contentRoot and schemaId from prepare_document_proof it also ' +
        'anchors the content root, which the field claims of submit_vault_call need. Returns ' +
        '{ status, attesterId, payloadHash, contractAddress, metadataJson, txHash, transactionHash, ' +
        'timings, check }; check is the verify_attestation call that shows the record on-chain. ' + RETRY_HINT,
      inputSchema: {
        sha256: hex64('sha256').describe('sha256 of the document (64 hex); it becomes the payloadHash'),
        metadata: z.record(z.string(), z.unknown()).optional()
          .describe('Public metadata; its sha256 is anchored with the hash. Default none'),
        contentRoot: hex64('contentRoot').optional().describe('Content root from prepare_document_proof (64 hex); needs schemaId'),
        schemaId: hex64('schemaId').optional().describe('Schema id from prepare_document_proof (64 hex); needs contentRoot'),
        contractAddress: CONTRACT,
        compiledArtifactRef: z.enum(BUILDABLE_ARTIFACTS).optional()
          .describe("Vault lineage, default 'attestation-vault-32' (the sandbox vaults); 'attestation-vault' for a 16-slot vault"),
        idempotencyKey: z.string().optional().describe('Dedupes retries of the same anchor'),
      },
    },
    run(async (args, extra) => {
      if (!!args.contentRoot !== !!args.schemaId) throw new Error('pass contentRoot and schemaId together');
      const contractAddress = vault(args.contractAddress, args.compiledArtifactRef);
      const payloadHash = args.sha256.toLowerCase();
      const metadataJson = args.metadata === undefined ? '' : JSON.stringify(args.metadata);
      const metadataHash = createHash('sha256').update(metadataJson, 'utf8').digest('hex');
      const ref = args.compiledArtifactRef ?? DEFAULT_ARTIFACT;
      const anchor = await submitVaultCall(
        { contractAddress, call: 'attest', params: { payloadHash, metadataHash }, compiledArtifactRef: ref },
        args.idempotencyKey, extra);
      if (!args.contentRoot || !args.schemaId) return { ...anchor, payloadHash, metadataJson };
      if (anchor.status !== 'succeeded') {
        const rootNext = anchor.status === 'pending'
          ? 'Run anchor_document again with the same arguments: it waits for this anchor and then anchors the content root.'
          : 'The content root needs the anchor first.';
        return { ...anchor, payloadHash, metadataJson, contentRoot: { status: 'not anchored', next: rootNext } };
      }
      const root = await submitVaultCall(
        { contractAddress, call: 'anchorContentRoot', params: { payloadHash, contentRoot: args.contentRoot, schemaId: args.schemaId }, compiledArtifactRef: ref },
        args.idempotencyKey && `${args.idempotencyKey}:root`, extra);
      return { ...root, payloadHash, metadataJson, anchorTxHash: anchor.txHash, anchorTimings: anchor.timings };
    }),
  );

  server.registerTool(
    'submit_vault_call',
    {
      description:
        'Run any AttestationVault call in one go: build, prove and sign it here with the caller ' +
        'seed, a sponsor pays, and the tool waits until it landed. Same calls and params as ' +
        'build_sponsorable_transaction: the ZK claims over a hidden field (proveFieldPredicate, ' +
        'proveFieldEquality, proveFieldMembership), the claims across two documents ' +
        '(proveFieldsUnchangedExcept, proveFieldsDiffer), disclosure (grantDisclosure, ' +
        'revokeDisclosure), passports and anchoring. The witness from prepare_document_proof is ' +
        'used here and never sent. Returns { status, attesterId, contractAddress, txHash, ' +
        'transactionHash, timings, check }; check is the free verify call that shows the effect on-chain. ' +
        'A failed job says in `next` what to do. ' + RETRY_HINT,
      inputSchema: {
        contractAddress: CONTRACT,
        call: z.enum(BUILDABLE_CALLS).describe('Which circuit to call'),
        params: z.record(z.string(), z.union([z.string(), z.number()]))
          .describe('The call parameters, listed per call in build_sponsorable_transaction'),
        merkleProof: z.record(z.string(), z.any()).optional()
          .describe('WITNESS for the proveField* calls, as prepare_document_proof returns it for that field'),
        docPair: z.record(z.string(), z.any()).optional()
          .describe('WITNESS { schema, openingA, openingB } for proveFieldsUnchangedExcept and proveFieldsDiffer'),
        compiledArtifactRef: z.enum(BUILDABLE_ARTIFACTS).optional()
          .describe("Vault lineage, default 'attestation-vault-32' (the sandbox vaults); 'attestation-vault' for a 16-slot vault"),
        idempotencyKey: z.string().optional().describe('Dedupes retries of the same call'),
      },
    },
    run(async (args, extra) => submitVaultCall({
      contractAddress: vault(args.contractAddress, args.compiledArtifactRef), call: args.call, params: args.params,
      merkleProof: args.merkleProof, docPair: args.docPair, compiledArtifactRef: args.compiledArtifactRef ?? DEFAULT_ARTIFACT,
    }, args.idempotencyKey, extra)),
  );

  server.registerTool(
    'build_sponsorable_transaction',
    {
      description:
        'Build, prove and sign an AttestationVault call LOCALLY and hand back the bytes, for a ' +
        'sponsor on another server or a later hand-over; submit_vault_call does build and submit ' +
        'in one go. The caller seed (NIGHTGATE_SEED_HEX, else the seed file) stays here, the ' +
        'attestation secret is derived from it, nothing secret leaves this machine. The fee-unpaid transaction stays in this process under the ' +
        'returned txId (its sha256; characters and bytes alongside), or is written to outFile: ' +
        'UNBOUND by default (hand the txId to sponsor_unbound_transaction, parallel channel) or ' +
        'bound with bind:true (sponsor_finalized_transaction). The on-chain effect carries the attester id ' +
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
        contractAddress: CONTRACT,
        call: z.enum(BUILDABLE_CALLS).describe('Which circuit to call'),
        params: z.record(z.string(), z.union([z.string(), z.number()]))
          .describe('The call parameters (see the per-call list in the description)'),
        merkleProof: z.record(z.string(), z.any()).optional()
          .describe('WITNESS material for the proveField* calls, as prepare_document_proof returns it for that field (fieldValue/fieldDigest, fieldSalt, siblings, dirs, setProof). It is consumed by the local prover and never sent to NIGHTGATE'),
        docPair: z.record(z.string(), z.any()).optional()
          .describe('WITNESS bundle { schema, openingA, openingB } for proveFieldsUnchangedExcept / proveFieldsDiffer; both documents must be prepared with the same ordered field list'),
        bind: z.boolean().optional()
          .describe('false (default): unbound for sponsor_unbound_transaction; true: finalized for sponsor_finalized_transaction'),
        compiledArtifactRef: z.enum(BUILDABLE_ARTIFACTS).optional()
          .describe("Vault lineage to build against, defaults to 'attestation-vault-32' (the hosted sandbox vaults). Use 'attestation-vault' for a 16-slot vault: it has its own circuits, so the builder loads that contract class and fetches ITS prover keys from the server's /zk-config. The address must belong to the lineage named here"),
        outFile: z.string().min(1).optional()
          .describe('Also write the built bytes as base64 to this path, for a sponsor tool on another server (its file argument)'),
      },
    },
    run(async (args) => {
      if (!config) throw new Error('local building is not configured for this server instance');
      return buildSponsorable(config, {
        contractAddress: vault(args.contractAddress, args.compiledArtifactRef), call: args.call, params: args.params, bind: args.bind === true,
        compiledArtifactRef: args.compiledArtifactRef ?? DEFAULT_ARTIFACT,
        merkleProof: args.merkleProof, docPair: args.docPair, outFile: args.outFile,
      });
    }),
  );

  server.registerTool(
    'get_attester_identity',
    {
      description:
        'The attester id this MCP server builds under (derived from the caller seed via the ' +
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
        'The server picks the wallet that pays. ' + RECEIPT_HINT + WAIT_HINT,
      inputSchema: {
        txId: TX_ID.describe('txId returned by build_sponsorable_transaction (bind:true) on this server; the bytes never pass through the conversation'),
        file: TX_FILE,
        finalizedTxB64: z.string().min(1).optional()
          .describe('Base64 of the caller-finalized, fee-unpaid transaction, only when neither txId nor file is available: long base64 copied through a model loses characters'),
        idempotencyKey: z.string().optional()
          .describe('Dedupes retries; the request is also fingerprinted by the transaction bytes'),
      },
    },
    run(async (args, extra) => {
      const { b64, sent } = await resolveTxSource({ txId: args.txId, file: args.file, b64: args.finalizedTxB64 }, 'finalizedTxB64');
      return { ...await sponsorOnce('sponsorFinalizedTransaction', { finalizedTxB64: b64 }, args.idempotencyKey, extra), sent };
    }),
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
        'allow-list policy and grant surface as sponsor_finalized_transaction; do not mix ' +
        'both channels on one sponsor wallet. Contract state is account-style: two sponsored ' +
        'calls against the SAME contract in one block conflict, the loser lands on-chain but its ' +
        'call does not apply and the job ends failed with errorCode CHAIN_EXECUTION_FAILED (the ' +
        'transaction hash is in the error); then REBUILD the transaction against the current ' +
        'contract state and sponsor again (never resubmit the same bytes). ' + WAIT_HINT,
      inputSchema: {
        txId: TX_ID.describe('txId returned by build_sponsorable_transaction on this server; the bytes never pass through the conversation'),
        file: TX_FILE,
        unboundTxB64: z.string().min(1).optional()
          .describe('Base64 of the caller-built, proven and signed UNBOUND transaction, only when neither txId nor file is available: long base64 copied through a model loses characters'),
        idempotencyKey: z.string().optional()
          .describe('Dedupes retries of the SAME bytes; a rebuilt transaction is a new key'),
      },
    },
    run(async (args, extra) => {
      const { b64, sent } = await resolveTxSource({ txId: args.txId, file: args.file, b64: args.unboundTxB64 }, 'unboundTxB64');
      return { ...await sponsorOnce('sponsorUnboundTransaction', { unboundTxB64: b64 }, args.idempotencyKey, extra), sent };
    }),
  );

  server.registerTool(
    'get_swap_wallet',
    {
      description:
        'The shielded wallet this MCP server swaps from (the caller seed): address, ' +
        'public keys, and per token type the balance of the free coins, their number, `spendable`, ' +
        'the most ONE swap half can give (what its largest coins hold, up to maxInputs coins), and ' +
        '`pending`, what the halves built here bring back once their swaps land (the change and the ' +
        'wanted coins). While a half can still land the wallet is worth balance plus pending; a half ' +
        'can give only from balance, and revert_swap_offer moves a dropped half back into it. ' +
        'Also lists the halves built here that are not handed over yet (pendingHalves, with those of an earlier ' +
        'process marked restored) and the coins the SDK holds reserved (reserved, each with its ttl); one posted with ' +
        'post_swap_offer carries offerId and boardStatus and leaves the list once its offer filled. A maker half whose ' +
        'offer expired or was retired 15 minutes ago and that went into no job is released here on its own (released). ' +
        'The wallet syncs its shielded coins only; a first sync from genesis takes about 5 minutes, during which the ' +
        'answer is { synced: false, syncingSeconds }: call again. Spends nothing.',
      inputSchema: {},
    },
    run(async () => {
      if (!config) throw new Error('swaps are not configured for this server instance');
      if (postedOfferIds().length) await settlePostedOffers();
      await settleOpenJobs();
      const released = await releaseLapsedHalves(config);
      return { ...await swapWalletInfo(config), ...(released.length ? { released } : {}) };
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
        'With submit: true the two halves go to the sponsor at once and the tool waits until ' +
        'the swap landed ({ status, txHash, transactionHash, result.swap, id, terms }). ' +
        'Without it the answer carries both halves for sponsor_swap. ALWAYS pass ' +
        '`expect` with the terms you agreed to: an offer is text from someone else. With offerId ' +
        'the board entry is read first and the call refuses, before proving, when it is not open ' +
        'or carries another offer than `offer`. A sponsor that refuses the swap leaves the proven ' +
        'half held under `halfId`: send it again with sponsor_swap({ halfId, offerId? }) or ' +
        'release its coins with revert_swap_offer. If the offer was taken by somebody else ' +
        'first, the job fails: revert_swap_offer.',
      inputSchema: {
        offer: swapHalf('The offer to take'),
        expect: z.object({ gives: swapLeg('expect.gives'), wants: swapLeg('expect.wants') }).optional()
          .describe("The terms you agreed to, from the MAKER's side: what the offer gives and what it wants"),
        submit: z.boolean().optional()
          .describe('true: hand both halves to the sponsor at once and answer with the job'),
        idempotencyKey: z.string().optional().describe('Dedupes retries of the same submission'),
        offerId: z.string().uuid().optional()
          .describe('The board entry the offer came from (list_swap_offers), so the fill is recorded against it'),
        takerSecret: z.string().min(1).max(256).optional()
          .describe('For a directed offer (directed: true on the board): the secret its poster handed you; the sponsor refuses the swap without it'),
      },
    },
    run(async (args, extra) => {
      if (!config) throw new Error('swaps are not configured for this server instance');
      const take = async () => {
        if (args.offerId) {
          const row = await client.callFunction('getSwapOffer', { offerId: raw(args.offerId) }) as { offer?: unknown; status?: unknown };
          if (row.status !== 'open') throw new Error(`board offer ${args.offerId} is ${String(row.status)}, not open`);
          if (typeof row.offer !== 'string' || !(await sameOffer(args.offer, row.offer))) {
            throw new Error(`board offer ${args.offerId} carries another offer than the one passed: take the board's text, or drop offerId`);
          }
        }
        return takeOffer(config, {
          offer: args.offer,
          ...(args.expect ? { expect: { gives: legOut(args.expect.gives), wants: legOut(args.expect.wants) } } : {}),
        });
      };
      if (args.submit !== true) return take();
      const key = callKey('takeSwapOffer', args.offer, args.expect, args.offerId, args.idempotencyKey ?? null);
      const started = await startSponsored(client, key, args.idempotencyKey, async (k) => {
        const taken = await take();
        return {
          action: 'sponsorSwap',
          body: {
            ...(args.offerId ? { offerId: args.offerId } : { makerHalfB64: taken.makerHalfB64 }),
            takerHalfB64: taken.takerHalfB64,
            idempotencyKey: k,
            ...(args.takerSecret ? { takerSecret: args.takerSecret } : {}),
          },
          info: { id: taken.id, terms: taken.terms, bound: taken.bound, buildMs: taken.buildMs },
          detail: { halfId: taken.id },
        };
      });
      trackHalfJob(String(started.job.id), started.job.jobId);
      const settled = await awaitSwap(started.job, args.offerId, extra);
      if (chainOutcome(settled) === 'failed') forgetStart(key);
      return markReused(settled, started, !!args.idempotencyKey);
    }),
  );

  server.registerTool(
    'revert_swap_offer',
    {
      description:
        'Release the coins of a swap half this wallet built (build_swap_offer, take_swap_offer or ' +
        'send_token) that is not going to be used. Until then, or until the swap lands, the coins count as ' +
        'spent in this wallet. By id for a half listed by get_swap_wallet, also one restored from an earlier ' +
        'process; by offerId for a board offer this wallet posted, from the board\'s copy of the half, which ' +
        'works after a restart and needs the offer closed (expired or retired; retire_swap_offer first while it ' +
        'is open). It does not recall an offer somebody already holds: to make a published offer worthless, ' +
        'spend its coins in another swap. A half whose swap landed leaves the list; its coins are spent.',
      inputSchema: {
        id: z.string().regex(/^[0-9a-f]{32}$/, 'id must be the 32 hex characters a swap tool returned').optional(),
        offerId: z.string().uuid().optional().describe('The board entry, instead of id'),
      },
    },
    run(async (args) => {
      if (!config) throw new Error('swaps are not configured for this server instance');
      if (args.id) return revertHalf(config, args.id);
      if (!args.offerId) throw new Error('pass id (a half listed by get_swap_wallet) or offerId (a board offer this wallet posted)');
      const row = await client.callFunction('getSwapOffer', { offerId: raw(args.offerId) }) as { status?: unknown; offer?: unknown };
      return revertOffer(config, args.offerId, row);
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
        'needs sponsorSwap in its allowedActions. Job result { txHash, transactionHash, swap: { gives, wants } }. ' +
        'An offer fills once: if it was taken first by somebody else the job fails. Pass both ' +
        'halves, or `halfId` alone for an offer this server took (take_swap_offer keeps both ' +
        'halves); with `offerId` the maker half comes from the board, next to takerHalf or the ' +
        'halfId of the taken offer. ' + RECEIPT_HINT + WAIT_HINT,
      inputSchema: {
        makerHalf: swapHalf("The maker's half (the offer)").optional(),
        takerHalf: swapHalf("The taker's half").optional(),
        idempotencyKey: z.string().optional()
          .describe('Dedupes retries of the SAME two halves'),
        halfId: z.string().regex(/^[0-9a-f]{32}$/, 'halfId must be the 32 hex characters a swap tool returned').optional()
          .describe('Id of the half this server built for the swap: alone it names a taken offer, next to both halves it ties the job to the half'),
        offerId: z.string().uuid().optional()
          .describe('An offer on the server\'s board (list_swap_offers): the server takes the maker half from there; pass takerHalf or the halfId of the taken offer with it'),
        takerSecret: z.string().min(1).max(256).optional()
          .describe('For a directed board offer: the secret its poster handed you'),
      },
    },
    run(async (args, extra) => {
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
      const key = callKey('sponsorSwap', halves, args.idempotencyKey ?? null);
      const started = await startSponsored(client, key, args.idempotencyKey, async (k) => ({
        action: 'sponsorSwap',
        body: { ...halves, idempotencyKey: k, ...(args.takerSecret ? { takerSecret: args.takerSecret } : {}) },
      }));
      if (args.halfId) trackHalfJob(args.halfId, started.job.jobId);
      const settled = await awaitSwap(started.job, args.offerId, extra);
      if (chainOutcome(settled) === 'failed') forgetStart(key);
      return markReused(settled, started, !!args.idempotencyKey);
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
        'postSwapOffer in an agent grant\'s allowedActions. Returns { offerId, status, terms }. ' +
        'With directed: true only a taker who knows the returned takerSecret can have the swap ' +
        'sponsored: hand that secret to your counterparty, it is shown once (needs NIGHTGATE 0.39.0).',
      inputSchema: {
        offer: swapHalf('The maker half, as offer file text or base64'),
        expiresAt: z.string().datetime().optional().describe('ISO timestamp; at most 90 days ahead'),
        tags: z.array(z.string().min(1).max(40)).max(8).optional().describe('Up to 8 tags for list_swap_offers'),
        directed: z.boolean().optional()
          .describe('true: the offer can only be taken with the takerSecret this call returns; for an invoice or an agreed OTC deal'),
      },
    },
    run(async (args) => {
      const takerSecret = args.directed ? randomBytes(32).toString('hex') : undefined;
      const posted = await client.callAction('postSwapOffer', {
        offer: args.offer,
        expiresAt: args.expiresAt,
        tags: args.tags,
        ...(takerSecret ? { takerSecretHash: createHash('sha256').update(takerSecret, 'utf8').digest('hex') } : {}),
      }) as Record<string, unknown> | undefined;
      await trackPostedHalf(args.offer, posted?.offerId).catch(() => { /* posted; the half is just not tied to it */ });
      return takerSecret ? { ...posted, takerSecret } : posted;
    }),
  );

  server.registerTool(
    'list_swap_offers',
    {
      description:
        'Offers on the server\'s board. Without status: the open ones, newest first. status filled | ' +
        'retired | expired | all reads the closed ones instead, ordered by last change; since keeps ' +
        'offers changed after that instant, so status all + since polled repeatedly is the board\'s ' +
        'change feed. With waitMs the server holds an empty answer until an offer matches or the ' +
        'time is up, so a watcher makes one call per change instead of one per interval. ' +
        'Filters are exact 64-hex token types and one tag. ' + BOARD_ROW_HINT +
        ' Every token may read the board.',
      inputSchema: {
        givesType: hex64('givesType').optional().describe('Only offers that give this token type'),
        wantsType: hex64('wantsType').optional().describe('Only offers that want this token type'),
        tag: z.string().min(1).max(40).optional().describe('Only offers carrying this tag'),
        limit: z.number().int().min(1).max(200).optional().describe('Default 50'),
        status: OFFER_STATUS.optional().describe('Default open'),
        since: z.string().datetime().optional().describe('ISO timestamp; only offers changed after it'),
        waitMs: z.number().int().min(0).max(BOARD_WAIT_MAX_MS).optional()
          .describe('Hold the call while nothing matches, up to this many ms (at most 25000); needs NIGHTGATE 0.38.0'),
      },
    },
    run(async (args) => settleRows(await listOffers(client, { ...args, mine: null }))),
  );

  server.registerTool(
    'my_swap_offers',
    {
      description:
        'The offers this caller posted on the board (a token: its grant\'s), open and closed, ' +
        'ordered by last change: what is still open, what filled (filledTxHash), what expired or ' +
        'was retired. status narrows to one state, since to offers changed after an instant, ' +
        'waitMs holds an empty answer until one of them changes. ' +
        BOARD_ROW_HINT,
      inputSchema: {
        status: OFFER_STATUS.optional().describe('Default all'),
        since: z.string().datetime().optional().describe('ISO timestamp; only offers changed after it'),
        limit: z.number().int().min(1).max(200).optional().describe('Default 50'),
        waitMs: z.number().int().min(0).max(BOARD_WAIT_MAX_MS).optional()
          .describe('Hold the call while nothing matches, up to this many ms (at most 25000); needs NIGHTGATE 0.38.0'),
      },
    },
    run(async (args) => settleRows(await listOffers(client, { status: args.status ?? 'all', since: args.since, limit: args.limit, mine: true, waitMs: args.waitMs }))),
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
    run(async (args) => settleRows(await client.callFunction('getSwapOffer', { offerId: raw(args.offerId) }))),
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
        'reserved until revert_swap_offer releases the half built here (or until the 15-minute release of ' +
        'get_swap_wallet). Returns { offerId, status }: retired, or the status of an offer already closed ' +
        '(expired, retired, filled), so a lapsed offer answers expired instead of an error (NIGHTGATE 0.40.0).',
      inputSchema: {
        offerId: z.string().uuid().describe('The board entry'),
      },
    },
    run(async (args) => client.callAction('retireSwapOffer', { offerId: args.offerId })),
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
        'Mint a shielded token with a name of your own on a token-factory deployment. This ' +
        'process is the issuer: its issuer secret derives from the caller seed, the mint is ' +
        'built, proven and signed here, and a sponsor pays; the seed never leaves this process. ' +
        'The factory has to be on the sponsor\'s contract list and mint on its circuit list. ' +
        'The same name from another issuer is another token. The answer names the token ' +
        '({ tokenType, domain, issuerKey }); a landed mint makes the type known to the sponsor ' +
        '(swaps, offer board). The recipient defaults to this wallet (get_attester_identity); ' +
        'another wallet takes both of its keys. ' + WAIT_HINT,
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
          .describe('The receiving wallet\'s encryption public key (64 hex); required with a recipient other than this wallet'),
        idempotencyKey: z.string().optional().describe('Dedupes retries'),
      },
    },
    run(async (args, extra) => {
      if (!config) throw new Error('local minting is not configured for this server instance');
      const input = {
        contractAddress: args.contractAddress,
        name: args.name,
        amount: String(args.amount),
        recipientCoinPublicKey: args.recipientCoinPublicKey,
        recipientEncryptionPublicKey: args.recipientEncryptionPublicKey,
      };
      const key = callKey('mintToken', input, args.idempotencyKey ?? null);
      const started = await startSponsored(client, key, args.idempotencyKey, async (k) => {
        const { unboundTxB64, ...built } = await buildMint(config, input);
        return { action: 'sponsorUnboundTransaction', body: { unboundTxB64, idempotencyKey: k }, info: built };
      });
      const job = await awaitJob(client, config, started.job, extra, { tool: 'get_swap_wallet', args: {} });
      if (chainOutcome(job) === 'failed') forgetStart(key);
      return markReused(job, started, !!args.idempotencyKey);
    }),
  );

  server.registerTool(
    'burn_token',
    {
      description:
        'Burn an amount of a factory token this wallet holds: the coins leave circulation and the ' +
        'factory\'s supply ledger drops. Built, proven and signed here, a sponsor pays; the factory ' +
        'has to be on the sponsor\'s contract list and burn on its circuit list. Names the token ' +
        'by its name and issuer: without issuerKey the token is one this wallet minted. ' + WAIT_HINT,
      inputSchema: {
        contractAddress: hex64('contractAddress').describe('The token-factory deployment the token was minted on'),
        name: z.string().min(1).refine((s) => Buffer.byteLength(s, 'utf8') <= 32, 'name must be at most 32 UTF-8 bytes')
          .describe('Token name, at most 32 UTF-8 bytes'),
        amount: z.union([
          z.string().regex(/^[1-9]\d*$/, 'amount must be a positive integer (decimal string)'),
          z.number().int().positive().safe(),
        ]).describe('Atoms to burn; a decimal string is exact'),
        issuerKey: hex64('issuerKey').optional().describe('The issuer of the token (64 hex, from mint_token); default this wallet\'s own issuer'),
        idempotencyKey: z.string().optional().describe('Dedupes retries'),
      },
    },
    run(async (args, extra) => {
      if (!config) throw new Error('local burning is not configured for this server instance');
      const input = { contractAddress: args.contractAddress, name: args.name, amount: String(args.amount), issuerKey: args.issuerKey };
      const key = callKey('burnToken', input, args.idempotencyKey ?? null);
      const started = await startSponsored(client, key, args.idempotencyKey, async (k) => {
        const { unboundTxB64, ...built } = await buildBurn(config, input);
        return { action: 'sponsorUnboundTransaction', body: { unboundTxB64, idempotencyKey: k }, info: built };
      });
      const job = await awaitJob(client, config, started.job, extra, { tool: 'get_swap_wallet', args: {} });
      if (chainOutcome(job) === 'failed') forgetStart(key);
      return markReused(job, started, !!args.idempotencyKey);
    }),
  );

  server.registerTool(
    'send_token',
    {
      description:
        'Send an amount of a shielded token from this wallet to another shielded address, with the ' +
        'sponsor paying the fee: a payout, a salary, an invoice settlement. The transfer is built and ' +
        'proven here from the wallet\'s coins (at most maxInputs of them); only the fee-unpaid bytes go ' +
        'to the server, which records the declared type and amount and submits. The recipient needs ' +
        'nothing but its address. Needs sponsorTransfer in the grant, the type on the sponsor\'s list ' +
        'and NIGHTGATE 0.39.0. ' + RECEIPT_HINT + WAIT_HINT,
      inputSchema: {
        tokenType: hex64('tokenType').describe('Raw token type (64 hex), what derive_token_type or mint_token returns'),
        amount: z.union([
          z.string().regex(/^[1-9]\d*$/, 'amount must be a positive integer (decimal string)'),
          z.number().int().positive().safe(),
        ]).describe('Atoms to send; a decimal string is exact'),
        to: z.string().min(16).describe('The recipient\'s shielded address (mn_shield-addr_...), as its get_attester_identity or get_swap_wallet shows it'),
        idempotencyKey: z.string().optional().describe('Dedupes retries'),
      },
    },
    run(async (args, extra) => {
      if (!config) throw new Error('transfers are not configured for this server instance');
      const input = { tokenType: args.tokenType.toLowerCase(), amount: String(args.amount), to: args.to.trim() };
      const key = callKey('sendToken', input, args.idempotencyKey ?? null);
      const started = await startSponsored(client, key, args.idempotencyKey, async (k) => {
        const built = await buildTransfer(config, input);
        return {
          action: 'sponsorTransfer',
          body: { transferTxB64: built.transferTxB64, tokenType: input.tokenType, amount: input.amount, idempotencyKey: k },
          info: { id: built.id, terms: built.terms, inputs: built.inputs, buildMs: built.buildMs },
          detail: { halfId: built.id },
        };
      });
      trackHalfJob(String(started.job.id), started.job.jobId);
      const job = await awaitJob(client, config, started.job, extra, { tool: 'get_swap_wallet', args: {} });
      if (typeof started.job.jobId === 'string') await settleHalfJob(config, started.job.jobId, job);
      if (chainOutcome(job) === 'failed') forgetStart(key);
      return markReused(job, started, !!args.idempotencyKey);
    }),
  );

  server.registerTool(
    'call_contract',
    {
      description:
        'Call a circuit on any contract whose lineage package is installed next to this server ' +
        '(laid out like @odatano/contract-<name>: contract.json, the compiled class, the proving files). ' +
        'The call is built, proven and signed here from the caller seed and a sponsor pays, so the caller ' +
        'holds neither NIGHT nor DUST. Arguments are JSON in circuit order; tagged values: {"$bytes":"<hex>"}, ' +
        '{"$uint":"<n>"}, and {"$coin":{"tokenType","amount"}} for a shielded coin the circuit receives, ' +
        'funded from this wallet, the one get_swap_wallet shows (a gateway key syncs it through the gateway, ' +
        'a direct instance needs NIGHTGATE_INDEXER_HTTP_URL and _WS_URL; the tool waits up to 20 s for its sync, ' +
        'a first sync from genesis takes about 5 minutes). {"$night":"<atoms>"} is a NIGHT amount the circuit ' +
        'takes from this wallet (receiveUnshielded, a deposit or a stake): the wallet syncs its NIGHT coins ' +
        'and pays them in, the sponsor adds only the fee; set payUnshielded when the amount is no argument. ' +
        'Needs allowUnshieldedOffers on the grant; one pay-in runs at a time. A payout the circuit makes to this wallet (sendUnshielded, ' +
        'a claim or a refund) needs nothing extra: NIGHTGATE 0.40.0 sponsors it. A call that funds anything is ' +
        'bound and goes through the serial sponsor channel, one without through the parallel one. ' +
        'Witnesses come from the package when its contract.json names a witnesses module (createWitnesses ' +
        'gets a secret derived from the seed for that package; the private state they return is kept once the call landed). The contract has to be sponsorable (its ' +
        'address and circuit on the sponsor\'s policy). The answer waits for the block; a call the chain refused ' +
        'gives its coins back. ' + WAIT_HINT,
      inputSchema: {
        package: z.string().min(1).max(214).describe('The installed lineage package, for example @meridian/contract-m402'),
        contractAddress: hex64('contractAddress').describe('The deployment to call'),
        circuit: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'circuit must be a circuit name').describe('The circuit to call'),
        args: z.array(z.unknown()).max(32).optional().describe('Circuit arguments in order, with the tagged values described above'),
        payUnshielded: z.boolean().optional().describe('The circuit takes unshielded tokens from this wallet; implied by a $night argument'),
        idempotencyKey: z.string().optional().describe('Dedupes retries; an identical call without a new key returns the first job'),
      },
    },
    run(async (args, extra) => {
      if (!config) throw new Error('local building is not configured for this server instance');
      const input = {
        package: args.package, contractAddress: args.contractAddress.toLowerCase(), circuit: args.circuit, args: args.args ?? [],
        ...(args.payUnshielded ? { payUnshielded: true } : {}),
      };
      const key = callKey('callContract', input, args.idempotencyKey ?? null);
      if (callSettlers.size) await settleOpenJobs();
      const started = await startSponsored(client, key, args.idempotencyKey, async (k) => {
        const { txB64, bound, settle, ...built } = await buildContractCall(config, input, key);
        const release = async () => {
          await settle('failed');
          if (built.pendingId) await revertHalf(config, built.pendingId);
        };
        return {
          action: bound ? 'sponsorFinalizedTransaction' : 'sponsorUnboundTransaction',
          body: { ...(bound ? { finalizedTxB64: txB64 } : { unboundTxB64: txB64 }), idempotencyKey: k },
          info: {
            contractAddress: input.contractAddress, circuit: input.circuit, bound, coins: built.coins,
            ...(built.night.length ? { night: built.night } : {}), ...(built.unshielded ? { payUnshielded: true } : {}),
            ...(built.witnesses ? { witnesses: 'package' } : {}), ...(built.pendingId ? { pendingId: built.pendingId } : {}),
            buildMs: built.buildMs, timings: { setupMs: built.setupMs, proveMs: built.proveMs },
          },
          onRefused: release,
          onSent: (job) => {
            nightCallSent(txB64, job.jobId);
            if (typeof job.jobId === 'string') callSettlers.set(job.jobId, settle);
          },
        };
      });
      const jobId = typeof started.job.jobId === 'string' ? started.job.jobId : undefined;
      if (jobId && typeof started.job.pendingId === 'string') trackHalfJob(started.job.pendingId, jobId);
      const job = await awaitJob(client, config, started.job, extra);
      if (jobId) {
        await settleHalfJob(config, jobId, job);
        await settleCall(jobId, job);
      }
      if (chainOutcome(job) === 'failed') forgetStart(key);
      return markReused(job, started, !!args.idempotencyKey);
    }),
  );

  server.registerTool(
    'get_usage',
    {
      description:
        'What this key has left and what it spent. With a gateway key (oda_...): unitsLeft, ' +
        'validUntil, status, usage today and over 30 days, and the last calls with the units each ' +
        'one cost (ledger). Free. With an agent grant of a direct instance: jobs by kind and ' +
        'status and the limits { jobsPerHour, jobsPerDay, classes }. Read it before a burst and ' +
        'after a 429 (the error carries retryAfterSeconds).',
      inputSchema: {
        since: z.string().datetime().optional().describe('Agent grants only: ISO timestamp, start of the window; default 30 days back'),
        until: z.string().datetime().optional().describe('Agent grants only: ISO timestamp, end of the window'),
      },
    },
    run(async (args) => {
      if (!config?.token && !config?.username) throw new Error('get_usage needs a key: set ODATANO_ACCESS_KEY (an oda_... key from https://api.odatano.dev)');
      if (config && isGatewayKey(config)) return client.gatewayMe();
      return client.callFunction('getGrantUsage', { grantId: null, since: args.since ?? null, until: args.until ?? null });
    }),
  );
}

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

/** Largest page of listSwapOffers. */
const BOARD_PAGE = 200;
/** Margin on `since` for clock skew between this machine and the server. */
const BOARD_OVERLAP_MS = 120_000;

/** The rows of a board answer: an array or an OData collection. */
function boardRows(result: unknown): unknown[] {
  const value = (result as { value?: unknown })?.value;
  return Array.isArray(result) ? result : Array.isArray(value) ? value : [];
}

/** The board's long-poll cap: NIGHTGATE holds an empty answer at most this long. */
const BOARD_WAIT_MAX_MS = 25_000;

/**
 * listSwapOffers with the seven parameters, null for the unused ones. `waitMs` is sent only
 * when set: a server before NIGHTGATE 0.38.0 refuses a parameter it does not declare.
 */
function listOffers(client: NightgateClient, args: {
  givesType?: string; wantsType?: string; tag?: string; limit?: number; status?: string; since?: string; mine: boolean | null; waitMs?: number;
}): Promise<unknown> {
  return client.callFunction('listSwapOffers', {
    givesType: args.givesType?.toLowerCase() ?? null,
    wantsType: args.wantsType?.toLowerCase() ?? null,
    tag: args.tag ?? null,
    limit: args.limit ?? null,
    status: args.status ?? null,
    since: args.since ?? null,
    mine: args.mine,
    ...(args.waitMs === undefined ? {} : { waitMs: args.waitMs }),
  });
}

/**
 * Uniform handler wrapper: JSON success payloads, API errors reported as
 * tool errors (isError) with status + OData code so the agent can react
 * (e.g. 401 -> credentials, 429 -> back off) instead of crashing the call.
 */
/** Masks secrets an SDK error or a URL may carry: access tokens in the query, project ids and full gateway or grant keys. */
export function redact(text: string): string {
  return text
    .replace(/([?&](?:project_id|key|token|apikey)=)[^&\s"'`]+/gi, '$1<redacted>')
    .replace(/\b(oda|ngat)_[A-Za-z0-9_-]{16,}/g, '$1_<redacted>')
    .replace(/\b(night(?:preprod|preview|mainnet))[A-Za-z0-9]{16,}/g, '$1<redacted>');
}

export function wrapHandler(_client: NightgateClient) {
  return function run<A>(fn: (args: A, extra: ToolExtra) => Promise<unknown>) {
    return async (args: A, extra: ToolExtra): Promise<ToolResult> => {
      const notice: { createdFile?: string } = {};
      const stage: { stage?: string } = {};
      const stopProgress = startProgress(extra, stage);
      try {
        const result = await callStage.run(stage, () => seedNotice.run(notice, () => fn(args, extra)));
        const seed = notice.createdFile ? seedCreated(notice.createdFile) : undefined;
        const out = seed && result && typeof result === 'object' && !Array.isArray(result) ? { ...result, seed } : result;
        return { content: [{ type: 'text', text: redact(JSON.stringify(out, null, 2)) }] };
      } catch (err) {
        const seed = notice.createdFile ? seedCreated(notice.createdFile) : undefined;
        if (err instanceof NightgateApiError) {
          const detail = { httpStatus: err.status, code: err.code ?? null, message: err.message, ...(err.detail ?? {}), ...(seed ? { seed } : {}) };
          return { content: [{ type: 'text', text: redact(JSON.stringify(detail, null, 2)) }], isError: true };
        }
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: redact(seed ? `${message}\n${JSON.stringify({ seed }, null, 2)}` : message) }], isError: true };
      } finally {
        stopProgress();
      }
    };
  };
}

/** Progress every 5 s while a call runs, when the client asked for it with a progress token. */
function startProgress(extra: ToolExtra | undefined, stage: { stage?: string }): () => void {
  const token = extra?._meta?.progressToken;
  if (token === undefined || !extra) return () => {};
  const t0 = Date.now();
  let n = 0;
  const timer = setInterval(() => {
    extra.sendNotification({
      method: 'notifications/progress',
      params: { progressToken: token, progress: ++n, message: `${stage.stage ?? 'working'}, ${Math.round((Date.now() - t0) / 1000)} s` },
    }).catch(() => undefined);
  }, 5_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
