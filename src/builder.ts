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

/** Call kinds this tool can prepare; one per attestation-vault helper. */
export const BUILDABLE_CALLS = [
  'attest',
  'anchorContentRoot',
  'grantDisclosure',
  'revokeDisclosure',
  'registerPassport',
  'bindPassport',
  'attestCommit',
  'attestReveal',
] as const;
export type BuildableCall = (typeof BUILDABLE_CALLS)[number];

export interface BuildInput {
  contractAddress: string;
  call: BuildableCall;
  params: Record<string, string | number>;
  bind: boolean;
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

let modules: Promise<TxModules> | null = null;
let builder: Promise<any> | null = null;

async function loadModules(): Promise<TxModules> {
  if (!modules) {
    modules = (async (): Promise<TxModules> => {
      try {
        const [tx, calls, vault] = await Promise.all([
          import('@odatano/nightgate-tx/txbuilder'),
          import('@odatano/nightgate-tx/calls'),
          import('@odatano/nightgate-tx/attestation-vault'),
        ]);
        return { createTxBuilder: tx.createTxBuilder as any, calls: calls as any, Contract: (vault as any).Contract };
      } catch (err) {
        modules = null;
        throw new Error(
          'local building needs @odatano/nightgate-tx >= 0.2.0 next to the MCP server ' +
          '(npm install @odatano/nightgate-tx): ' + (err instanceof Error ? err.message : String(err)),
        );
      }
    })();
  }
  return modules as Promise<TxModules>;
}

function defaults(network: string) {
  return {
    indexerHttpUrl: `https://indexer.${network}.midnight.network/api/v4/graphql`,
    indexerWsUrl: `wss://indexer.${network}.midnight.network/api/v4/graphql/ws`,
    nodeUrl: `wss://rpc.${network}.midnight.network/`,
  };
}

/** One builder per process (the seed is fixed); created on first use. */
async function getBuilder(config: NightgateMcpConfig): Promise<any> {
  if (!config.seedHex) {
    throw new Error('local building needs NIGHTGATE_SEED_HEX (64 or 128 hex) in the MCP server environment; it is never a tool argument');
  }
  if (!builder) {
    builder = (async () => {
      const { createTxBuilder, Contract } = await loadModules();
      const network = config.network;
      const d = defaults(network);
      const opts: Record<string, unknown> = {
        seedHex: config.seedHex,
        networkId: network,
        indexerHttpUrl: config.indexerHttpUrl ?? d.indexerHttpUrl,
        indexerWsUrl: config.indexerWsUrl ?? d.indexerWsUrl,
        nodeUrl: config.nodeUrl ?? d.nodeUrl,
        zkConfigBaseUrl: config.zkConfigBaseUrl ?? `${config.baseUrl}/zk-config/attestation-vault`,
        contractClass: Contract,
        cacheDir: config.zkCacheDir ?? join(tmpdir(), 'nightgate-mcp-zk'),
      };
      if (config.proofServerUrl) {
        opts.provingMode = 'server';
        opts.proofServerUrl = config.proofServerUrl;
      }
      try {
        return await createTxBuilder(opts);
      } catch (err) {
        builder = null;
        throw err;
      }
    })();
  }
  return builder;
}

function hexParam(params: Record<string, string | number>, key: string): string {
  const v = params[key];
  if (typeof v !== 'string' || !/^[0-9a-fA-F]{64}$/.test(v)) throw new Error(`params.${key} must be 64 hex characters`);
  return v.toLowerCase();
}

/** Map the tool's flat params onto the typed prepare* helper of the call kind. */
function prepareCall(calls: TxModules['calls'], input: BuildInput, attestationSecret: Uint8Array): unknown {
  const p = input.params;
  switch (input.call) {
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
  const b = await getBuilder(config);
  const { calls } = await loadModules();
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

/** Test seam / shutdown: release the builder's connections. */
export async function closeBuilder(): Promise<void> {
  const b = builder;
  builder = null;
  if (b) {
    try { await (await b).close?.(); } catch { /* best effort */ }
  }
}
