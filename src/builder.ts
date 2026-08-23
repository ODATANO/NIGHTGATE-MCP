/**
 * Local transaction building (caller half of cross-server fee sponsoring).
 *
 * Wraps the `@odatano/nightgate-tx` txbuilder: build, prove (in-process wasm
 * or a proof server) and sign an AttestationVault call on THIS machine with
 * the seed from `NIGHTGATE_SEED_HEX`, so the key and the attestation secret
 * never travel; the result is the fee-unpaid transaction the sponsor tools
 * submit. The package is an OPTIONAL peer dependency (it carries the Midnight
 * SDK): the tool is always registered and reports how to install it when it
 * is missing.
 */
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { NightgateMcpConfig } from './config.js';

/**
 * Call kinds this tool can prepare; one per attestation-vault helper.
 *
 * The prove* entries are what lets a third party make a ZK claim with NO
 * wallet on the server: the witness (the field value, its salt, the
 * inclusion path) is consumed here in the caller's own process and only the
 * finished transaction travels. The server-side `issueField*Attestation`
 * actions do the same work with a SERVER wallet as the attester, which is
 * the wrong shape for anyone but the operator: it would put someone else's
 * key in our custody and stamp every claim with the same attester id.
 */
export const BUILDABLE_CALLS = [
  'attest',
  'anchorContentRoot',
  'grantDisclosure',
  'revokeDisclosure',
  'registerPassport',
  'bindPassport',
  'attestCommit',
  'attestReveal',
  'proveFieldPredicate',
  'proveFieldEquality',
  'proveFieldMembership',
  'proveFieldsUnchangedExcept',
  'proveFieldsDiffer',
] as const;
export type BuildableCall = (typeof BUILDABLE_CALLS)[number];

/**
 * Vault lineages the local builder can load. Each needs its OWN compiled
 * contract class and its own `/zk-config`, because the width is baked into
 * the circuits. Picking the lineage also sets the slot width the prove*
 * calls fold their inclusion paths over (16 or 32), so the address and the
 * ref must belong together.
 */
export const BUILDABLE_ARTIFACTS = ['attestation-vault', 'attestation-vault-32'] as const;
export type BuildableArtifact = (typeof BUILDABLE_ARTIFACTS)[number];
export const DEFAULT_ARTIFACT: BuildableArtifact = 'attestation-vault';

export interface BuildInput {
  contractAddress: string;
  call: BuildableCall;
  params: Record<string, string | number>;
  bind: boolean;
  compiledArtifactRef?: BuildableArtifact;
  /**
   * WITNESS material for the prove* calls, exactly as prepare_document_proof
   * returns it per field. Never persisted, never sent to the server: it is
   * consumed by the local prover and only the proof leaves this process.
   */
  merkleProof?: Record<string, unknown>;
  /** Cross-root witness bundle { schema, openingA, openingB } for the two comparison calls. */
  docPair?: Record<string, unknown>;
}

export interface BuildOutput {
  channel: 'unbound' | 'bound';
  unboundTxB64?: string;
  finalizedTxB64?: string;
  attesterId: string;
  provingMode: string;
  serializedBytes: number;
  buildMs: number;
}

interface TxModules {
  createTxBuilder: (opts: any) => Promise<any>;
  calls: Record<string, (input: Record<string, unknown>) => unknown>;
  Contract: unknown;
}

const modules = new Map<BuildableArtifact, Promise<TxModules>>();
const builders = new Map<BuildableArtifact, Promise<any>>();

async function loadModules(ref: BuildableArtifact = DEFAULT_ARTIFACT): Promise<TxModules> {
  let entry = modules.get(ref);
  if (!entry) {
    entry = (async (): Promise<TxModules> => {
      try {
        const [tx, calls, vault] = await Promise.all([
          import('@odatano/nightgate-tx/txbuilder'),
          import('@odatano/nightgate-tx/calls'),
          ref === 'attestation-vault-32'
            ? import('@odatano/nightgate-tx/attestation-vault-32')
            : import('@odatano/nightgate-tx/attestation-vault'),
        ]);
        return { createTxBuilder: tx.createTxBuilder as any, calls: calls as any, Contract: (vault as any).Contract };
      } catch (err) {
        modules.delete(ref);
        throw new Error(
          `local building of '${ref}' needs @odatano/nightgate-tx >= 0.3.0 next to the MCP server ` +
          '(npm install @odatano/nightgate-tx): ' + (err instanceof Error ? err.message : String(err)),
        );
      }
    })();
    modules.set(ref, entry);
  }
  return entry;
}

function defaults(network: string) {
  return {
    indexerHttpUrl: `https://indexer.${network}.midnight.network/api/v4/graphql`,
    indexerWsUrl: `wss://indexer.${network}.midnight.network/api/v4/graphql/ws`,
    nodeUrl: `wss://rpc.${network}.midnight.network/`,
  };
}

/**
 * One builder per VAULT LINEAGE (the seed is fixed, the circuits are not);
 * created on first use. A 16-slot and a 32-slot vault need different
 * contract classes, different prover keys and therefore separate cache
 * directories, so they cannot share an instance.
 */
async function getBuilder(config: NightgateMcpConfig, ref: BuildableArtifact = DEFAULT_ARTIFACT): Promise<any> {
  if (!config.seedHex) {
    throw new Error('local building needs NIGHTGATE_SEED_HEX (64 or 128 hex) in the MCP server environment; it is never a tool argument');
  }
  let entry = builders.get(ref);
  if (!entry) {
    entry = (async () => {
      const { createTxBuilder, Contract } = await loadModules(ref);
      const network = config.network;
      const d = defaults(network);
      // An explicit zkConfigBaseUrl pins ONE lineage, so it only applies to
      // the default ref; anything else derives its own from the server.
      const zkBase = ref === DEFAULT_ARTIFACT && config.zkConfigBaseUrl
        ? config.zkConfigBaseUrl
        : `${config.baseUrl}/zk-config/${ref}`;
      const opts: Record<string, unknown> = {
        seedHex: config.seedHex,
        networkId: network,
        indexerHttpUrl: config.indexerHttpUrl ?? d.indexerHttpUrl,
        indexerWsUrl: config.indexerWsUrl ?? d.indexerWsUrl,
        nodeUrl: config.nodeUrl ?? d.nodeUrl,
        zkConfigBaseUrl: zkBase,
        contractClass: Contract,
        contractName: ref,
        cacheDir: join(config.zkCacheDir ?? join(tmpdir(), 'nightgate-mcp-zk'), ref),
      };
      if (config.proofServerUrl) {
        opts.provingMode = 'server';
        opts.proofServerUrl = config.proofServerUrl;
      }
      try {
        return await createTxBuilder(opts);
      } catch (err) {
        builders.delete(ref);
        throw err;
      }
    })();
    builders.set(ref, entry);
  }
  return entry;
}

function hexParam(params: Record<string, string | number>, key: string): string {
  const v = params[key];
  if (typeof v !== 'string' || !/^[0-9a-fA-F]{64}$/.test(v)) throw new Error(`params.${key} must be 64 hex characters`);
  return v.toLowerCase();
}

/** Map the tool's flat params onto the typed prepare* helper of the call kind. */
function prepareCall(calls: TxModules['calls'], input: BuildInput, attestationSecret: Uint8Array): unknown {
  const p = input.params;
  const slotWidth = input.compiledArtifactRef === 'attestation-vault-32' ? 32 : 16;
  const witness = (what: string) => {
    if (!input.merkleProof) throw new Error(`call '${input.call}' needs merkleProof (${what}); take it from prepare_document_proof`);
    return input.merkleProof as any;
  };
  const pair = () => {
    if (!input.docPair) throw new Error(`call '${input.call}' needs docPair { schema, openingA, openingB } from prepare_document_proof`);
    return input.docPair as any;
  };
  switch (input.call) {
    case 'proveFieldPredicate': {
      const op = Number(p.op);
      if (![0, 1].includes(op)) throw new Error('params.op must be 0 (lessOrEqual) or 1 (greaterOrEqual)');
      return calls.prepareProveFieldPredicate({
        payloadHash: hexParam(p, 'payloadHash'), fieldKey: hexParam(p, 'fieldKey'),
        threshold: BigInt(p.threshold as string | number), op: BigInt(op),
        merkleProof: witness('fieldValue, fieldSalt, siblings, dirs'), attestationSecret, slotWidth,
      } as any);
    }
    case 'proveFieldEquality':
      return calls.prepareProveFieldEquality({
        payloadHash: hexParam(p, 'payloadHash'), fieldKey: hexParam(p, 'fieldKey'),
        expectedDigest: hexParam(p, 'expectedDigest'),
        merkleProof: witness('fieldSalt, siblings, dirs'), attestationSecret, slotWidth,
      } as any);
    case 'proveFieldMembership':
      return calls.prepareProveFieldMembership({
        payloadHash: hexParam(p, 'payloadHash'), fieldKey: hexParam(p, 'fieldKey'),
        setRoot: hexParam(p, 'setRoot'),
        merkleProof: witness('fieldDigest, fieldSalt, siblings, dirs, setProof'), attestationSecret, slotWidth,
      } as any);
    case 'proveFieldsUnchangedExcept':
      return calls.prepareProveFieldsUnchangedExcept({
        payloadHashA: hexParam(p, 'payloadHashA'), payloadHashB: hexParam(p, 'payloadHashB'),
        allowedMask: Number(p.allowedMask), docPair: pair(), attestationSecret, slotWidth,
      } as any);
    case 'proveFieldsDiffer':
      return calls.prepareProveFieldsDiffer({
        payloadHashA: hexParam(p, 'payloadHashA'), payloadHashB: hexParam(p, 'payloadHashB'),
        k: Number(p.k), docPair: pair(), attestationSecret, slotWidth,
      } as any);
    case 'attest':
      return calls.prepareAttest({ payloadHash: hexParam(p, 'payloadHash'), metadataHash: hexParam(p, 'metadataHash'), attestationSecret });
    case 'anchorContentRoot':
      return calls.prepareAnchorContentRoot({ payloadHash: hexParam(p, 'payloadHash'), contentRoot: hexParam(p, 'contentRoot'), schemaId: hexParam(p, 'schemaId'), attestationSecret });
    case 'grantDisclosure': {
      const level = Number(p.level);
      if (![0, 1, 2].includes(level)) throw new Error('params.level must be 0, 1 or 2');
      return calls.prepareGrantDisclosure({ payloadHash: hexParam(p, 'payloadHash'), grantee: hexParam(p, 'grantee'), level, attestationSecret });
    }
    case 'revokeDisclosure':
      return calls.prepareRevokeDisclosure({ payloadHash: hexParam(p, 'payloadHash'), grantee: hexParam(p, 'grantee'), attestationSecret });
    case 'registerPassport':
      return calls.prepareRegisterPassport({ passportId: hexParam(p, 'passportId'), ownerId: hexParam(p, 'ownerId'), attestationSecret });
    case 'bindPassport':
      return calls.prepareBindPassport({ passportId: hexParam(p, 'passportId'), payloadHash: hexParam(p, 'payloadHash'), attestationSecret });
    case 'attestCommit':
      return calls.prepareAttestCommit({ commitment: hexParam(p, 'commitment'), attestationSecret });
    case 'attestReveal':
      return calls.prepareAttestReveal({ payloadHash: hexParam(p, 'payloadHash'), metadataHash: hexParam(p, 'metadataHash'), nonce: hexParam(p, 'nonce'), attestationSecret });
  }
}

/** Build + prove + sign locally; unbound (parallel channel) by default. */
export async function buildSponsorable(config: NightgateMcpConfig, input: BuildInput): Promise<BuildOutput> {
  const t0 = Date.now();
  const ref = input.compiledArtifactRef ?? DEFAULT_ARTIFACT;
  const b = await getBuilder(config, ref);
  const { calls } = await loadModules(ref);
  const call = prepareCall(calls, input, b.attestationSecret);
  const built = await b.buildSponsorable({ contractAddress: input.contractAddress, call, bind: input.bind ? true : false });
  const out: BuildOutput = {
    channel: input.bind ? 'bound' : 'unbound',
    attesterId: String(b.attesterId),
    provingMode: String(b.provingMode ?? (config.proofServerUrl ? 'server' : 'wasm')),
    serializedBytes: Number(built.serializedBytes ?? 0),
    buildMs: Date.now() - t0,
  };
  if (input.bind) out.finalizedTxB64 = built.finalizedTxB64;
  else out.unboundTxB64 = built.unboundTxB64;
  return out;
}

/** The caller's attester id (derived from the seed), without building anything. */
export async function attesterIdentity(config: NightgateMcpConfig): Promise<{ attesterId: string; network: string }> {
  const b = await getBuilder(config);
  return { attesterId: String(b.attesterId), network: config.network };
}

/** Test seam / shutdown: release every lineage's builder connections. */
export async function closeBuilder(): Promise<void> {
  const open = [...builders.values()];
  builders.clear();
  for (const b of open) {
    try { await (await b).close?.(); } catch { /* best effort */ }
  }
}
