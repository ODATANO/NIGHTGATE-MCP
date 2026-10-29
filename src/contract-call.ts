// A circuit call on any contract whose lineage package is installed next to the MCP server, built,
// proven and signed here from the caller seed; only the fee-unpaid transaction goes to a sponsor.
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { builderChainOptions, type NightgateMcpConfig } from './config.js';
import { txExport } from './tx-module.js';
import { ensureSeed } from './seed.js';
import { setStage } from './jobs.js';
import { processWallet, saveWalletState } from './swap.js';

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
  txB64: string;
  /** A call the wallet funds is bound (the wallet adds a balancing transaction) and goes to `sponsorFinalizedTransaction`. */
  bound: boolean;
  serializedBytes: number;
  buildMs: number;
  setupMs: number;
  proveMs: number;
  /** The coins the call takes from this wallet, one per `$coin` argument. */
  coins: Array<{ tokenType: string; amount: string }>;
}

interface PackageBuilder {
  builder: any;
  /** The process wallet the builder balances from; a builder on a wallet that was replaced is closed. */
  shieldedWallet: unknown;
}

const builders = new Map<string, Promise<PackageBuilder>>();

/** One builder per package. It syncs no wallet of its own: a `$coin` is funded from the process wallet. */
async function getPackageBuilder(config: NightgateMcpConfig, packageName: string, shieldedWallet: unknown): Promise<any> {
  const cached = builders.get(packageName);
  if (cached) {
    const entry = await cached;
    if (entry.shieldedWallet === shieldedWallet) return entry.builder;
    builders.delete(packageName);
    await entry.builder.close?.().catch(() => { /* its wallet is gone already */ });
  }
  const entry = (async (): Promise<PackageBuilder> => {
    const createTxBuilder = await txExport<(opts: Record<string, unknown>) => Promise<any>>('createTxBuilder', 'contract calls', '0.12.2');
    const opts: Record<string, unknown> = {
      seedHex: config.seedHex,
      networkId: config.network,
      ...builderChainOptions(config),
      ...(shieldedWallet ? { shieldedWallet } : {}),
      package: packageName,
      from: HERE,
    };
    if (config.proofServerUrl) {
      opts.provingMode = 'server';
      opts.proofServerUrl = config.proofServerUrl;
    }
    try { return { builder: await createTxBuilder(opts), shieldedWallet }; } catch (err) { builders.delete(packageName); throw err; }
  })();
  builders.set(packageName, entry);
  return (await entry).builder;
}

/** What the synced wallet holds free of the colours a call asked for, for a shortfall message. */
async function shortfallText(wallet: any, coins: Array<{ tokenType: string; amount: string }>): Promise<string> {
  const held: Array<{ tokenType: string; amount: bigint }> = await wallet.coins();
  const asked = coins.map((c) => `${c.amount} of ${c.tokenType}`).join(', ');
  const free = coins.map((c) => {
    const own = held.filter((h) => h.tokenType === c.tokenType);
    const sum = own.reduce((s, h) => s + h.amount, 0n);
    return `${sum} of ${c.tokenType} in ${own.length} free coin${own.length === 1 ? '' : 's'}`;
  }).join(', ');
  return `the wallet cannot fund the $coin argument (${asked}): synced, it holds ${free}; coins of a half or call that has not landed are reserved (get_swap_wallet lists them)`;
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
  const withIndexer = Boolean(config.indexerHttpUrl && config.indexerWsUrl);
  if (coins.length && !withIndexer) {
    throw new Error('a $coin argument needs the shielded coins of this wallet: set NIGHTGATE_INDEXER_HTTP_URL and NIGHTGATE_INDEXER_WS_URL so the wallet syncs them');
  }
  const t0 = Date.now();
  let wallet: any = null;
  if (withIndexer) {
    setStage(coins.length ? 'syncing the wallet' : 'opening the wallet');
    wallet = await processWallet(config, coins.length > 0);
  }
  setStage('preparing the builder and prover keys');
  const b = await getPackageBuilder(config, input.package, wallet?.shieldedWallet);
  const t1 = Date.now();
  setStage('proving');
  const bound = coins.length > 0;
  let built: any;
  try {
    built = await b.buildSponsorable({
      contractAddress: input.contractAddress.toLowerCase(),
      call: { circuitId: input.circuit, args, witnesses: {} },
      bind: bound,
    });
  } catch (err) {
    if (bound && /InsufficientFunds/i.test(String((err as Error)?.message ?? err))) throw new Error(await shortfallText(wallet, coins));
    throw err;
  }
  if (bound) await saveWalletState(config, wallet);
  return {
    txB64: String(bound ? built.finalizedTxB64 : built.unboundTxB64),
    bound,
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
    try { await (await b).builder.close?.(); } catch { /* best effort */ }
  }
}
