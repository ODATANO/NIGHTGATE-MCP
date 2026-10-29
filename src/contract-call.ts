// A circuit call on any contract whose lineage package is installed next to the MCP server, built,
// proven and signed here from the caller seed; only the fee-unpaid transaction goes to a sponsor.
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { builderChainOptions, type NightgateMcpConfig } from './config.js';
import { txExport } from './tx-module.js';
import { ensureSeed } from './seed.js';
import { setStage } from './jobs.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const HEX64 = /^[0-9a-f]{64}$/;
const PACKAGE_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

export interface ContractCallInput {
  /** An installed lineage package laid out like `@odatano/contract-<name>`: its `contract.json` names the class and the proving files. */
  package: string;
  contractAddress: string;
  circuit: string;
  /** Circuit arguments in order. Tagged values: `{ "$bytes": "<hex>" }`, `{ "$uint": "<n>" }`, `{ "$coin": { "tokenType", "amount" } }`. */
  args: unknown[];
}

export interface ContractCallBuild {
  unboundTxB64: string;
  serializedBytes: number;
  buildMs: number;
  setupMs: number;
  proveMs: number;
  /** The coins the call takes from this wallet, one per `$coin` argument. */
  coins: Array<{ tokenType: string; amount: string }>;
}

const builders = new Map<string, Promise<any>>();

/** One builder per package. With a configured indexer the shielded coins sync, so a `$coin` argument can be funded. */
async function getPackageBuilder(config: NightgateMcpConfig, packageName: string): Promise<any> {
  let entry = builders.get(packageName);
  if (!entry) {
    entry = (async () => {
      const createTxBuilder = await txExport<(opts: Record<string, unknown>) => Promise<any>>('createTxBuilder', 'contract calls', '0.12.2');
      const chain = builderChainOptions(config);
      const opts: Record<string, unknown> = {
        seedHex: config.seedHex,
        networkId: config.network,
        ...chain,
        ...(config.indexerHttpUrl && config.indexerWsUrl ? { walletSync: 'shielded' } : {}),
        package: packageName,
        from: HERE,
      };
      if (config.proofServerUrl) {
        opts.provingMode = 'server';
        opts.proofServerUrl = config.proofServerUrl;
      }
      try { return await createTxBuilder(opts); } catch (err) { builders.delete(packageName); throw err; }
    })();
    builders.set(packageName, entry);
  }
  return entry;
}

const hexBytes = (hex: unknown, what: string): Uint8Array => {
  const h = String(hex ?? '').trim().toLowerCase().replace(/^0x/, '');
  if (!/^([0-9a-f]{2})+$/.test(h)) throw new Error(`${what} must be hex`);
  return new Uint8Array(Buffer.from(h, 'hex'));
};

/** Turns the tagged JSON values of a tool call into what the compiled circuit takes. */
export function coerceArgs(args: unknown[], coins: Array<{ tokenType: string; amount: string }>): unknown[] {
  const one = (raw: unknown, path: string): unknown => {
    if (Array.isArray(raw)) return raw.map((v, i) => one(v, `${path}[${i}]`));
    if (raw && typeof raw === 'object') {
      const o = raw as Record<string, unknown>;
      if ('$bytes' in o) return hexBytes(o.$bytes, `${path}.$bytes`);
      if ('$uint' in o) {
        const text = String(o.$uint ?? '').trim();
        if (!/^\d+$/.test(text)) throw new Error(`${path}.$uint must be a non-negative integer`);
        return BigInt(text);
      }
      if ('$coin' in o) {
        const c = (o.$coin ?? {}) as Record<string, unknown>;
        const tokenType = String(c.tokenType ?? '').trim().toLowerCase();
        const amount = String(c.amount ?? '').trim();
        if (!HEX64.test(tokenType)) throw new Error(`${path}.$coin.tokenType must be 64 hex characters`);
        if (!/^[1-9]\d*$/.test(amount)) throw new Error(`${path}.$coin.amount must be a positive integer`);
        coins.push({ tokenType, amount });
        return { nonce: new Uint8Array(randomBytes(32)), color: hexBytes(tokenType, `${path}.$coin.tokenType`), value: BigInt(amount) };
      }
      return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, one(v, `${path}.${k}`)]));
    }
    if (typeof raw === 'number') {
      if (!Number.isInteger(raw)) throw new Error(`${path} must be an integer; pass decimals as a string`);
      return BigInt(raw);
    }
    return raw;
  };
  return args.map((a, i) => one(a, `args[${i}]`));
}

/** Build, prove and sign one circuit call locally; unbound, for sponsor_unbound_transaction. */
export async function buildContractCall(config: NightgateMcpConfig, input: ContractCallInput): Promise<ContractCallBuild> {
  await ensureSeed(config);
  if (!PACKAGE_NAME.test(input.package)) throw new Error('package must be an npm package name');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(input.circuit)) throw new Error('circuit must be a circuit name');
  const coins: Array<{ tokenType: string; amount: string }> = [];
  const args = coerceArgs(input.args ?? [], coins);
  if (coins.length && !(config.indexerHttpUrl && config.indexerWsUrl)) {
    throw new Error('a $coin argument needs the shielded coins of this wallet: set NIGHTGATE_INDEXER_HTTP_URL and NIGHTGATE_INDEXER_WS_URL so the builder syncs them');
  }
  const t0 = Date.now();
  setStage('preparing the builder and prover keys');
  const b = await getPackageBuilder(config, input.package);
  const t1 = Date.now();
  setStage('proving');
  const built = await b.buildSponsorable({
    contractAddress: input.contractAddress.toLowerCase(),
    call: { circuitId: input.circuit, args, witnesses: {} },
    bind: false,
  });
  return {
    unboundTxB64: String(built.unboundTxB64),
    serializedBytes: Number(built.serializedBytes ?? 0),
    buildMs: Date.now() - t0,
    setupMs: t1 - t0,
    proveMs: Date.now() - t1,
    coins,
  };
}

/** Test seam / shutdown. */
export async function closeContractBuilders(): Promise<void> {
  const open = [...builders.values()];
  builders.clear();
  for (const b of open) {
    try { await (await b).close?.(); } catch { /* best effort */ }
  }
}
