import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { int64, NightgateApiError, NightgateClient } from './client.js';

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

/** Batch claim shapes (NIGHTGATE >= 0.15.0 allows mixing the three kinds). */
const numericClaim = z.object({
  predicate: z.enum(['lessOrEqual', 'greaterOrEqual']),
  fieldKey: hex64('fieldKey'),
  value: z.string().regex(/^\d+$/, 'value must be a non-negative integer (decimal string)'),
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

/**
 * Phase A tool set: crawler-free verification, job polling, and the
 * curated write path (anchoring, field predicates, disclosure).
 * Wallet lifecycle actions are deliberately never exposed over MCP.
 */
export function registerTools(server: McpServer, client: NightgateClient): void {
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
        predicate: z.enum(['lessOrEqual', 'greaterOrEqual', 'bytesEquality', 'setMembership'])
          .describe('Claim kind'),
        threshold: scaledInt('threshold').optional()
          .describe('Numeric predicates only: scaled circuit integer threshold'),
        fieldKey: hex64('fieldKey').optional()
          .describe('Field key (64 hex); optional for numeric, required for the bytes kinds'),
        expectedDigest: hex64('expectedDigest').optional()
          .describe("bytesEquality only: the public expected value digest"),
        setRoot: hex64('setRoot').optional()
          .describe("setMembership only: the canonical allow-list set root"),
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
      return client.callFunction('verifyPredicateState', {
        contractAddress: args.contractAddress,
        payloadHash: args.payloadHash,
        fieldKey: args.fieldKey,
        predicate: args.predicate,
        threshold: args.threshold === undefined ? undefined : int64(args.threshold),
        expectedDigest: args.expectedDigest,
        setRoot: args.setRoot,
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
        'value; kind "bytes" (NIGHTGATE >= 0.15.0) enters a STRING field as the digest of the ' +
        'exact string, feeding the equality/membership proofs. Keep the field order stable across ' +
        'anchor and proof: it is part of the tree identity. Compute-only and synchronous, nothing ' +
        'is stored server-side. The returned fields carry witness material (scaled values / value ' +
        'digests): treat as sensitive. Store canonicalDocument at your storageRef; re-serializing ' +
        'with different key order will not re-hash equal.',
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
        })).min(1).max(16).describe('ORDERED list of fields to make provable (leaf index = position)'),
        compiledArtifactRef: z.string().optional().describe("Contract artifact ref, defaults to 'attestation-vault'"),
      },
    },
    run(async (args) =>
      client.callAction('prepareDocumentProof', {
        documentJson: JSON.stringify(args.document),
        proofFieldsJson: JSON.stringify(args.proofFields),
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
        'actual bytes at storageRef. Attestation is first-come-first-served per hash. ' + POLL_HINT +
        ' Also returns documentId for verify_document.',
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
        fieldKey: hex64('fieldKey').describe('Canonical field id (64 hex, public)'),
        value: z.string().regex(/^\d+$/, 'value must be a non-negative integer (decimal string)')
          .describe('Scaled integer field value (witness only, never persisted)'),
        siblings: merkleSiblings,
        dirs: merkleDirs,
        predicate: z.enum(['lessOrEqual', 'greaterOrEqual']).describe('Predicate operator'),
        threshold: scaledInt('threshold').describe('Scaled integer threshold (same scaling as value)'),
        sessionId: z.string().uuid().describe('Wallet session id that signs and submits'),
        contractAddress: z.string().min(1).describe('AttestationVault deployment'),
        contentRoot: hex64('contentRoot').optional().describe('Optional Merkle root (64 hex) to anchor first'),
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
        contentRoot: args.contentRoot,
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
        '>= 0.15.0). Deterministic rule (digest each exact string, dedupe, sort ascending, pad by ' +
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
        'Issue a ZK bytes-equality proof (NIGHTGATE >= 0.15.0): the anchored document field ' +
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
        siblings: merkleSiblings,
        dirs: merkleDirs,
        sessionId: z.string().uuid().describe('Wallet session id that signs and submits'),
        contractAddress: z.string().min(1).describe('AttestationVault deployment'),
        contentRoot: hex64('contentRoot').optional().describe('Optional Merkle root (64 hex) to anchor first'),
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
        contentRoot: args.contentRoot,
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
        'Issue a ZK set-membership proof (NIGHTGATE >= 0.15.0): the anchored document field\'s ' +
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
        siblings: merkleSiblings,
        dirs: merkleDirs,
        sessionId: z.string().uuid().describe('Wallet session id that signs and submits'),
        contractAddress: z.string().min(1).describe('AttestationVault deployment'),
        contentRoot: hex64('contentRoot').optional().describe('Optional Merkle root (64 hex) to anchor first'),
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
        contentRoot: args.contentRoot,
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
        'call slot). Claims may MIX the three kinds (NIGHTGATE >= 0.15.0), discriminated by ' +
        'predicate: numeric (lessOrEqual/greaterOrEqual), bytesEquality, setMembership. Duplicate ' +
        'claim tuples are dropped server-side. One false claim aborts the whole batch at local ' +
        'proving time with zero on-chain effect. After submission the chain can finalize a ' +
        'PARTIAL_SUCCESS subset; verify per claim via verify_predicate_attestation instead of ' +
        'assuming all-or-nothing. ' + POLL_HINT,
      inputSchema: {
        payloadHash: hex64('payloadHash').describe('Shared attestation payload hash (64 hex)'),
        claims: z.array(z.union([numericClaim, equalityClaim, membershipClaim]))
          .min(1).max(8)
          .describe('1-8 claims on the same payload hash; any mix of numeric, bytesEquality and setMembership'),
        sessionId: z.string().uuid().describe('Wallet session id that signs and submits'),
        contractAddress: z.string().min(1).describe('AttestationVault deployment'),
        contentRoot: hex64('contentRoot').optional().describe('Optional Merkle root anchored as first call of the same batch'),
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
    'get_job_status',
    {
      description:
        'Poll the status of an async NIGHTGATE job (all submit actions return a jobId). ' +
        'status: pending | running | external_execution | submitted | reconciliation_required | ' +
        'succeeded | failed. Poll every few seconds until succeeded or failed; result carries ' +
        'the job outcome JSON, chainStatus tracks on-chain finalization independently.',
      inputSchema: {
        jobId: z.string().uuid().describe('Job id returned by a submit action'),
        sessionId: z.string().uuid().describe('Wallet session id the job belongs to'),
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
