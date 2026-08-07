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

const POLL_HINT = 'Async: returns { jobId, status } immediately; poll get_job_status until succeeded or failed.';

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
        'Verify against LIVE Midnight contract state that a ZK predicate proof (e.g. "hidden value ' +
        '<= threshold") was recorded true on-chain. Id-free: works for proofs NIGHTGATE never saw. ' +
        'threshold must be the SAME scaled integer the circuit hashed (scaling mismatch yields ' +
        'verified:false). Supply fieldKey for a field-bound proof, omit it for a plain one.',
      inputSchema: {
        contractAddress: z.string().min(1).describe('AttestationVault contract address'),
        payloadHash: hex64('payloadHash').describe('The attestation payload hash (64 hex)'),
        predicate: z.enum(['lessOrEqual', 'greaterOrEqual']).describe('Predicate operator'),
        threshold: scaledInt('threshold').describe('Scaled circuit integer threshold (same scaling the circuit hashed)'),
        fieldKey: hex64('fieldKey').optional().describe('Optional field key (64 hex) for field-bound proofs'),
        network: z.enum(['preview', 'preprod', 'mainnet']).optional()
          .describe('Read from another network public indexer instead of the configured one'),
        compiledArtifactRef: z.string().optional().describe("Contract artifact ref, defaults to 'attestation-vault'"),
      },
    },
    run(async (args) =>
      client.callFunction('verifyPredicateState', {
        contractAddress: args.contractAddress,
        payloadHash: args.payloadHash,
        fieldKey: args.fieldKey,
        predicate: args.predicate,
        threshold: int64(args.threshold),
        compiledArtifactRef: args.compiledArtifactRef,
        network: args.network,
      })),
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
        'up to 16 proof fields, and per-field inclusion paths ready for prove_field_predicate. ' +
        'Keep the field order stable across anchor and proof: it is part of the tree identity. ' +
        'Compute-only and synchronous, nothing is stored server-side. The returned fields carry ' +
        'witness material (scaled values): treat as sensitive. Store canonicalDocument at your ' +
        'storageRef; re-serializing with different key order will not re-hash equal.',
      inputSchema: {
        document: z.record(z.unknown())
          .describe('The full document as a JSON object; all of it goes into payloadHash'),
        proofFields: z.array(z.object({
          field: z.string().min(1)
            .describe('Dot-separated path into the document (e.g. invoice.total); a literal top-level key containing dots wins'),
          scale: z.number().int().min(1).max(1_000_000_000).optional()
            .describe('Value scale (default 1000: milli-units)'),
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
    'prove_field_predicates_batch',
    {
      description:
        'Batch variant of prove_field_predicate: prove up to 8 field-bound predicates on ONE ' +
        'anchored document in ONE transaction (7 if contentRoot is supplied, since the anchor ' +
        'occupies one call slot). Duplicate claim tuples are dropped server-side. One false ' +
        'predicate aborts the whole batch at local proving time with zero on-chain effect. After ' +
        'submission the chain can finalize a PARTIAL_SUCCESS subset; verify per claim via ' +
        'verify_predicate_attestation instead of assuming all-or-nothing. ' + POLL_HINT,
      inputSchema: {
        payloadHash: hex64('payloadHash').describe('Shared attestation payload hash (64 hex)'),
        claims: z.array(z.object({
          fieldKey: hex64('fieldKey'),
          value: z.string().regex(/^\d+$/, 'value must be a non-negative integer (decimal string)'),
          siblings: merkleSiblings,
          dirs: merkleDirs,
          predicate: z.enum(['lessOrEqual', 'greaterOrEqual']),
          threshold: scaledInt('threshold'),
          unit: z.string().optional(),
        })).min(1).max(8).describe('1-8 claims on the same payload hash'),
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
        claimsJson: JSON.stringify(args.claims.map((c) => ({ ...c, threshold: String(c.threshold) }))),
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
