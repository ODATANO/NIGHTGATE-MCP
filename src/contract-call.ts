// A circuit call on any contract whose lineage package is installed next to the MCP server, built,
// proven and signed here from the caller seed; only the fee-unpaid transaction goes to a sponsor.
import { createHmac, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { builderChainOptions, canSyncWallet, NO_INDEXER, walletIndexer, type NightgateMcpConfig } from './config.js';
import { txExport } from './tx-module.js';
import { ensureSeed } from './seed.js';
import { setStage } from './jobs.js';
import { processWallet, readPrivateStates, readUnshieldedState, SYNC_WAIT_MS, trackCall, writePrivateStates, writeUnshieldedState } from './swap.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const HEX64 = /^[0-9a-f]{64}$/;
const PACKAGE_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
/** Deepest nesting of a tool argument. */
const MAX_ARG_DEPTH = 16;

export interface ContractCallInput {
  /** An installed lineage package laid out like `@odatano/contract-<name>`: its `contract.json` names the class and the proving files. */
  package: string;
  contractAddress: string;
  circuit: string;
  /** Circuit arguments in order. Tagged values: `{ "$bytes": "<hex>" }`, `{ "$uint": "<n>" }`, `{ "$night": "<atoms>" }`, `{ "$coin": { "tokenType", "amount" } }`. */
  args: unknown[];
  /** The circuit takes unshielded tokens from this wallet (`receiveUnshielded`). Implied by a `$night` argument. */
  payUnshielded?: boolean;
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
  /** The NIGHT amounts of its `$night` arguments, in atoms. */
  night: string[];
  /** True when this wallet's unshielded coins pay into the call. */
  unshielded: boolean;
  /** True when the package supplied the call's witnesses. */
  witnesses: boolean;
  /** The id under which get_swap_wallet lists the coins the call reserved. */
  pendingId?: string;
  /** Saves or drops what the build reserved once the job landed or failed. */
  settle: (outcome: 'landed' | 'failed') => Promise<void>;
}

interface PackageBuilder {
  builder: any;
  /** The process wallet the builder balances from; a builder on a wallet that was replaced is closed. */
  shieldedWallet: unknown;
  /** Settles when the builder's own NIGHT coins caught up; only for a builder that syncs them. */
  synced?: Promise<void>;
  isSynced: boolean;
  syncError?: Error;
}

/** One builder per package and wallet mode: `none` syncs nothing of its own, `coins` also syncs this wallet's NIGHT coins. */
type BuilderMode = 'none' | 'coins';
const builders = new Map<string, Promise<PackageBuilder>>();

async function dropBuilder(id: string): Promise<void> {
  const entry = builders.get(id);
  builders.delete(id);
  if (entry) await (await entry).builder.close?.().catch(() => { /* its wallet is gone already */ });
}

async function getPackageBuilder(config: NightgateMcpConfig, packageName: string, shieldedWallet: unknown, mode: BuilderMode): Promise<PackageBuilder> {
  const id = `${packageName}|${mode}`;
  const cached = builders.get(id);
  if (cached) {
    const entry = await cached;
    if (entry.shieldedWallet === shieldedWallet && !entry.syncError) return entry;
    // another call may have replaced it while this one waited
    if (builders.get(id) !== cached) return getPackageBuilder(config, packageName, shieldedWallet, mode);
    // the stale one closes in the background, so the new one is in the map before anything else waits
    builders.delete(id);
    void entry.builder.close?.().catch(() => { /* its wallet is gone already */ });
  }
  const entry = (async (): Promise<PackageBuilder> => {
    const createTxBuilder = await txExport<(opts: Record<string, unknown>) => Promise<any>>('createTxBuilder', 'contract calls', '0.12.2');
    let chain: Record<string, unknown>;
    let walletState: { unshielded: string } | undefined;
    if (mode === 'coins') {
      const indexer = await walletIndexer(config);
      if (!indexer) throw new Error(`a call that pays unshielded tokens needs this wallet's NIGHT coins, and ${NO_INDEXER}`);
      chain = builderChainOptions(config, { walletSync: 'coins', indexer });
      const saved = await readUnshieldedState(config);
      if (saved) walletState = { unshielded: saved };
    } else {
      chain = builderChainOptions(config);
    }
    const opts: Record<string, unknown> = {
      seedHex: config.seedHex,
      networkId: config.network,
      ...chain,
      ...(shieldedWallet ? { shieldedWallet } : {}),
      ...(walletState ? { walletState } : {}),
      package: packageName,
      from: HERE,
    };
    if (config.proofServerUrl) {
      opts.provingMode = 'server';
      opts.proofServerUrl = config.proofServerUrl;
    }
    const builder = await createTxBuilder(opts);
    const built: PackageBuilder = { builder, shieldedWallet, isSynced: mode === 'none' };
    if (mode === 'coins') {
      built.synced = (async () => {
        try {
          await builder.waitForSync();
          built.isSynced = true;
        } catch (err) {
          built.syncError = err instanceof Error ? err : new Error(String(err));
        }
      })();
    }
    return built;
  })();
  builders.set(id, entry);
  try { return await entry; } catch (err) { builders.delete(id); throw err; }
}

/** How long a call that never reached the sponsor holds its gate; one with a job holds it until the job settled. */
const GATE_TTL_MS = 3_600_000;
/** A call that holds a gate until its job settled. */
interface Holder { key: string; packageName: string; since: number; txB64?: string; jobId?: string }
/**
 * One unsettled call per gate: `night` for a NIGHT pay-in, since two could pick the same coins, and
 * `state|<package>|<contract>` for a call whose witnesses may change a private state, since two would build on the same one.
 */
const gates = new Map<string, Holder>();

/** Takes a gate for this call, synchronously, so two calls that arrive together never both pass. */
function takeGate(gate: string, callKey: string, packageName: string, what: string): Holder {
  const held = gates.get(gate);
  if (held && held.key !== callKey && (held.jobId || Date.now() - held.since < GATE_TTL_MS)) {
    throw new Error(`${what} of this server has not settled yet (${held.jobId ? `job ${held.jobId}` : 'not handed over'}, built ${new Date(held.since).toISOString()}); ` +
      'run that call again to wait for it, or get_swap_wallet, then call again');
  }
  if (held && held.key !== callKey && gate === 'night') void releaseNight(held).catch(() => { /* the builder is gone already */ });
  const mine: Holder = { key: callKey, packageName, since: Date.now() };
  gates.set(gate, mine);
  return mine;
}

/** Frees a gate this call still holds. */
function dropGate(gate: string, mine: Holder | undefined): void {
  if (mine && gates.get(gate) === mine) gates.delete(gate);
}

/** Releases the NIGHT a pay-in reserved in its package's builder. */
async function releaseNight(call: Holder): Promise<void> {
  if (!call.txB64) return;
  const id = `${call.packageName}|coins`;
  const entry = builders.get(id);
  if (!entry) return;
  const { builder } = await entry;
  if (typeof builder.revert === 'function') await builder.revert(call.txB64);
  else await dropBuilder(id);
}

/** Records the job a gated call went into; from then on only the job's outcome frees the gate. */
export function nightCallSent(txB64: string, jobId: unknown): void {
  if (typeof jobId !== 'string') return;
  for (const held of gates.values()) if (held.txB64 === txB64) held.jobId = jobId;
}

/** The builder once its NIGHT coins caught up; one that needs longer than the tool waits says so. */
async function syncedBuilder(entry: PackageBuilder, started: number): Promise<any> {
  if (!entry.isSynced && !entry.syncError) await Promise.race([entry.synced, new Promise((r) => setTimeout(r, SYNC_WAIT_MS))]);
  if (entry.syncError) throw new Error(`the wallet's NIGHT coins could not sync: ${entry.syncError.message}`);
  if (!entry.isSynced) {
    throw new Error(`the wallet is still syncing its NIGHT coins (${Math.round((Date.now() - started) / 1000)} s so far); call again shortly`);
  }
  return entry.builder;
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

const atoms = (raw: unknown, what: string, positive: boolean): bigint => {
  const text = String(raw ?? '').trim();
  if (!(positive ? /^[1-9]\d*$/ : /^\d+$/).test(text)) throw new Error(`${what} must be a ${positive ? 'positive' : 'non-negative'} integer`);
  return BigInt(text);
};

/** Turns the tagged JSON values of a tool call into what the compiled circuit takes. */
export function coerceArgs(args: unknown[], coins: Array<{ tokenType: string; amount: string }>, night: string[] = []): unknown[] {
  const one = (raw: unknown, path: string, depth: number): unknown => {
    if (depth > MAX_ARG_DEPTH) throw new Error(`${path} is nested deeper than ${MAX_ARG_DEPTH} levels`);
    if (Array.isArray(raw)) return raw.map((v, i) => one(v, `${path}[${i}]`, depth + 1));
    if (raw && typeof raw === 'object') {
      const o = raw as Record<string, unknown>;
      if ('$bytes' in o) return hexBytes(o.$bytes, `${path}.$bytes`);
      if ('$uint' in o) return atoms(o.$uint, `${path}.$uint`, false);
      if ('$night' in o) {
        const amount = atoms(o.$night, `${path}.$night`, true);
        night.push(amount.toString());
        return amount;
      }
      if ('$coin' in o) {
        const c = (o.$coin ?? {}) as Record<string, unknown>;
        const tokenType = String(c.tokenType ?? '').trim().toLowerCase();
        if (!HEX64.test(tokenType)) throw new Error(`${path}.$coin.tokenType must be 64 hex characters`);
        const amount = atoms(c.amount, `${path}.$coin.amount`, true).toString();
        coins.push({ tokenType, amount });
        return { nonce: new Uint8Array(randomBytes(32)), color: hexBytes(tokenType, `${path}.$coin.tokenType`), value: BigInt(amount) };
      }
      return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, one(v, `${path}.${k}`, depth + 1)]));
    }
    if (typeof raw === 'number') {
      if (!Number.isSafeInteger(raw)) throw new Error(`${path} must be an integer below 2^53; pass a larger or exact one as {"$uint":"<n>"}`);
      return BigInt(raw);
    }
    return raw;
  };
  return args.map((a, i) => one(a, `args[${i}]`, 0));
}

/** What a package's witnesses module hands back: the witness functions and the private state they start from. */
interface PackageWitnesses {
  witnesses: object;
  privateState?: unknown;
}

/**
 * The witnesses a lineage package ships: `contract.json` names a module under `witnesses`, which exports
 * `createWitnesses({ secret, network, contractAddress })`. `secret` is 32 bytes derived from the seed for
 * this package alone, so the package never sees the seed. None when the package names no module.
 */
export async function packageWitnesses(config: NightgateMcpConfig, packageName: string, contractAddress: string): Promise<PackageWitnesses | undefined> {
  const resolveBuilderPackage = await txExport<(input: { package: string; from?: string }) => Promise<{ package: { root: string } }>>('resolveBuilderPackage', 'contract calls', '0.12.2');
  const { package: { root } } = await resolveBuilderPackage({ package: packageName, from: HERE });
  return witnessesAt(root, packageName, config, contractAddress);
}

/** The witnesses of the package in `root`, as `packageWitnesses` describes them. */
export async function witnessesAt(root: string, packageName: string, config: NightgateMcpConfig, contractAddress: string): Promise<PackageWitnesses | undefined> {
  const manifest = JSON.parse(await readFile(join(root, 'contract.json'), 'utf8')) as { witnesses?: unknown };
  if (manifest.witnesses === undefined) return undefined;
  if (typeof manifest.witnesses !== 'string' || !manifest.witnesses) throw new Error(`${packageName}: contract.json witnesses must name a module file`);
  const file = resolve(root, manifest.witnesses);
  const inside = relative(root, file);
  if (isAbsolute(inside) || inside.startsWith('..') || inside.split(sep).includes('node_modules')) {
    throw new Error(`${packageName}: contract.json witnesses must name a file inside the package`);
  }
  const mod = await import(pathToFileURL(file).href);
  const create = mod.createWitnesses ?? mod.default?.createWitnesses;
  if (typeof create !== 'function') throw new Error(`${packageName}: ${manifest.witnesses} exports no createWitnesses function`);
  const secret = new Uint8Array(createHmac('sha256', Buffer.from(String(config.seedHex), 'hex')).update(`nightgate-mcp witnesses ${packageName}`).digest());
  const made = await create({ secret, network: config.network, contractAddress });
  if (!made || typeof made !== 'object' || typeof (made as PackageWitnesses).witnesses !== 'object' || (made as PackageWitnesses).witnesses === null) {
    throw new Error(`${packageName}: createWitnesses must return { witnesses, privateState? }`);
  }
  return made as PackageWitnesses;
}

/** Tagged JSON for a private state: bytes and big integers survive the file. */
export function encodeState(value: unknown): unknown {
  if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString('hex') };
  if (typeof value === 'bigint') return { $bigint: value.toString() };
  if (Array.isArray(value)) return value.map(encodeState);
  if (value && typeof value === 'object') {
    if (Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`a private state holds a ${value.constructor?.name ?? 'class'} value, which is not saved`);
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encodeState(v)]));
  }
  return value;
}

export function decodeState(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeState);
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (typeof o.$bytes === 'string' && Object.keys(o).length === 1) return new Uint8Array(Buffer.from(o.$bytes, 'hex'));
    if (typeof o.$bigint === 'string' && Object.keys(o).length === 1) return BigInt(o.$bigint);
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, decodeState(v)]));
  }
  return value;
}

/** Private states of landed calls by package and contract; kept on disk next to the state file when there is one. */
let privateStates: Map<string, unknown> | undefined;

async function savedPrivateState(config: NightgateMcpConfig, key: string): Promise<unknown> {
  privateStates ??= new Map(Object.entries((await readPrivateStates(config)) ?? {}).map(([k, v]) => [k, decodeState(v)]));
  return privateStates.get(key);
}

async function keepPrivateState(config: NightgateMcpConfig, key: string, state: unknown): Promise<void> {
  privateStates ??= new Map();
  privateStates.set(key, state);
  await writePrivateStates(config, Object.fromEntries([...privateStates].map(([k, v]) => [k, encodeState(v)])));
}

/** Wraps witness functions, also class methods and getters, so the private state the last one returned is known after the build. */
// Exported for the unit tests only.
export function trackWitnesses(witnesses: object, record: (state: unknown) => void): object {
  return new Proxy(witnesses, {
    get(target, name, receiver) {
      const value = Reflect.get(target, name, receiver);
      if (typeof value !== 'function') return value;
      return (...a: unknown[]) => {
        const out = value.apply(target, a);
        if (Array.isArray(out) && out.length === 2) record(out[0]);
        return out;
      };
    },
  });
}

/**
 * Build, prove and sign one circuit call locally: unbound when the wallet funds nothing, bound when it does.
 * `callKey` names the request, so a NIGHT pay-in that is resent is not taken for a second one.
 */
export async function buildContractCall(config: NightgateMcpConfig, input: ContractCallInput, callKey: string): Promise<ContractCallBuild> {
  await ensureSeed(config);
  if (!PACKAGE_NAME.test(input.package)) throw new Error('package must be an npm package name');
  if (config.callPackages && !config.callPackages.includes(input.package)) {
    throw new Error(`package ${input.package} is not in NIGHTGATE_CALL_PACKAGES (${config.callPackages.join(', ')})`);
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(input.circuit)) throw new Error('circuit must be a circuit name');
  const coins: Array<{ tokenType: string; amount: string }> = [];
  const night: string[] = [];
  const args = coerceArgs(input.args ?? [], coins, night);
  const unshielded = input.payUnshielded === true || night.length > 0;
  const withIndexer = canSyncWallet(config);
  if (coins.length && !withIndexer) throw new Error(`a $coin argument needs the shielded coins of this wallet, and ${NO_INDEXER}`);
  if (unshielded && !withIndexer) throw new Error(`a call that pays unshielded tokens needs this wallet's NIGHT coins, and ${NO_INDEXER}`);
  const contractAddress = input.contractAddress.toLowerCase();
  const nightGate = unshielded ? takeGate('night', callKey, input.package, 'a NIGHT pay-in') : undefined;
  const stateGate = `state|${input.package}|${contractAddress}`;
  let stateHold: Holder | undefined;
  try {
    return await buildGated();
  } catch (err) {
    dropGate('night', nightGate);
    dropGate(stateGate, stateHold);
    throw err;
  }

  async function buildGated(): Promise<ContractCallBuild> {
    const t0 = Date.now();
    let wallet: any = null;
    if (withIndexer) {
      setStage(coins.length || unshielded ? 'syncing the wallet' : 'opening the wallet');
      wallet = await processWallet(config, coins.length > 0 || unshielded);
    }
    setStage('preparing the builder and prover keys');
    const mode: BuilderMode = unshielded ? 'coins' : 'none';
    const entry = await getPackageBuilder(config, input.package, wallet?.shieldedWallet, mode);
    const b = mode === 'coins' ? await syncedBuilder(entry, t0) : entry.builder;
    const own = await packageWitnesses(config, input.package, contractAddress);
    if (own) stateHold = takeGate(stateGate, callKey, input.package, `a call on ${contractAddress.slice(0, 16)}… that may change its private state`);
    const stateKey = `${input.package}|${contractAddress}`;
    const initialPrivateState = own ? (await savedPrivateState(config, stateKey)) ?? own.privateState : undefined;
    let privateState = initialPrivateState;
    const witnesses = own ? trackWitnesses(own.witnesses, (s) => { privateState = s; }) : {};
    const t1 = Date.now();
    setStage('proving');
    const bound = coins.length > 0 || unshielded;
    let built: any;
    try {
      built = await b.buildSponsorable({
        contractAddress,
        call: { circuitId: input.circuit, args, witnesses },
        ...(initialPrivateState !== undefined ? { initialPrivateState } : {}),
        bind: bound,
      });
    } catch (err) {
      if (unshielded) await dropBuilder(`${input.package}|coins`);
      if (coins.length && /InsufficientFunds/i.test(String((err as Error)?.message ?? err))) throw new Error(await shortfallText(wallet, coins));
      throw err;
    }
    const txB64 = String(bound ? built.finalizedTxB64 : built.unboundTxB64);
    if (nightGate) nightGate.txB64 = txB64;
    if (stateHold) stateHold.txB64 = txB64;
    const pendingId = coins.length
      ? await trackCall(config, wallet, txB64, { contractAddress, circuit: input.circuit, coins })
      : undefined;
    const settle = async (outcome: 'landed' | 'failed'): Promise<void> => {
      // A private state the witnesses changed counts only once the call applied.
      if (outcome === 'landed' && own && privateState !== undefined && privateState !== initialPrivateState) {
        await keepPrivateState(config, stateKey, privateState).catch((err) => console.error(`nightgate-mcp: private state of ${stateKey} not saved: ${(err as Error).message}`));
      }
      dropGate(stateGate, stateHold);
      if (!nightGate || gates.get('night') !== nightGate) return;
      gates.delete('night');
      if (outcome === 'failed') { await releaseNight(nightGate); return; }
      const entry = builders.get(`${input.package}|coins`);
      const state = entry ? await (await entry).builder.serializeWalletState() : undefined;
      if (typeof state?.unshielded === 'string') await writeUnshieldedState(config, state.unshielded);
    };
    return {
      txB64,
      bound,
      serializedBytes: Number(built.serializedBytes ?? 0),
      buildMs: Date.now() - t0,
      setupMs: t1 - t0,
      proveMs: Date.now() - t1,
      coins,
      night,
      unshielded,
      witnesses: !!own,
      ...(pendingId ? { pendingId } : {}),
      settle,
    };
  }
}

/** Test seam / shutdown. */
export async function closeContractBuilders(): Promise<void> {
  const open = [...builders.values()];
  builders.clear();
  for (const b of open) {
    try { await (await b).builder.close?.(); } catch { /* best effort */ }
  }
}
