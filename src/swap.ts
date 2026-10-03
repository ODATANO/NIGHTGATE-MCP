/**
 * Shielded swaps, the local side: one wallet that holds the shielded coins of
 * `NIGHTGATE_SEED_HEX` builds swap halves and takes offers. It wraps the swap
 * wallet of `@odatano/nightgate-tx` (0.8.0 or later); the fee is the sponsor's,
 * so the wallet needs neither NIGHT nor dust.
 */
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { NightgateMcpConfig } from './config.js';
import { txExport } from './tx-module.js';

export interface SwapLeg {
  tokenType: string;
  amount: string;
}
export interface SwapTermsOut {
  gives: SwapLeg;
  wants: SwapLeg;
  inputs?: number;
  outputs?: number;
}

interface TxSwapModule {
  createSwapWallet: (opts: Record<string, unknown>) => Promise<any>;
  readSwapTerms: (tx: unknown) => any;
  decodeOffer: (input: string) => Promise<{ tx: unknown; bound: boolean; bytes: Uint8Array }>;
}

let modulePromise: Promise<TxSwapModule> | undefined;

async function loadSwapModule(): Promise<TxSwapModule> {
  modulePromise ??= (async (): Promise<TxSwapModule> => {
    try {
      const [createSwapWallet, readSwapTerms, decodeOffer] = await Promise.all([
        txExport<TxSwapModule['createSwapWallet']>('createSwapWallet', 'swaps', '0.8.0'),
        txExport<TxSwapModule['readSwapTerms']>('readSwapTerms', 'swaps', '0.8.0'),
        txExport<TxSwapModule['decodeOffer']>('decodeOffer', 'swaps', '0.8.0'),
      ]);
      return { createSwapWallet, readSwapTerms, decodeOffer };
    } catch (err) {
      modulePromise = undefined;
      throw err;
    }
  })();
  return modulePromise;
}

function defaults(network: string) {
  return {
    indexerHttpUrl: `https://indexer.${network}.midnight.network/api/v4/graphql`,
    indexerWsUrl: `wss://indexer.${network}.midnight.network/api/v4/graphql/ws`,
  };
}

const termsOut = (terms: any): SwapTermsOut => ({
  gives: { tokenType: String(terms.gives.tokenType), amount: String(terms.gives.amount) },
  wants: { tokenType: String(terms.wants.tokenType), amount: String(terms.wants.amount) },
  ...(Number.isInteger(terms.inputs) ? { inputs: terms.inputs } : {}),
  ...(Number.isInteger(terms.outputs) ? { outputs: terms.outputs } : {}),
});

/** What an offer gives and wants, read from the transaction it carries. No wallet, no network. */
export async function readOffer(offer: string): Promise<SwapTermsOut & { bound: boolean; serializedBytes: number }> {
  const { decodeOffer, readSwapTerms } = await loadSwapModule();
  const decoded = await decodeOffer(offer);
  return { ...termsOut(readSwapTerms(decoded.tx)), bound: decoded.bound, serializedBytes: decoded.bytes.length };
}

/** Do two offer texts (file or base64, either form) carry the same transaction? */
export async function sameOffer(a: string, b: string): Promise<boolean> {
  const { decodeOffer } = await loadSwapModule();
  const [x, y] = await Promise.all([decodeOffer(a), decodeOffer(b)]);
  return x.bytes.length === y.bytes.length && x.bytes.every((byte, i) => byte === y.bytes[i]);
}

interface OpenWallet {
  wallet: any;
  /** Settles when the wallet has caught up; a failure is kept for the next caller. */
  synced: Promise<void>;
  isSynced: boolean;
  syncError: Error | null;
  startedAt: number;
  resumed: boolean;
}

let open: Promise<OpenWallet> | undefined;
interface PendingHalf {
  revert: () => Promise<void>;
  terms: SwapTermsOut;
  role: 'maker' | 'taker';
  /** Both halves of a taken offer, so it can be submitted by id. */
  halves?: { makerHalfB64: string; takerHalfB64: string };
  /** The sponsor job the half went into. */
  jobId?: string;
}
/** Halves built here whose swap has not landed, by id. */
const pending = new Map<string, PendingHalf>();

const halfId = (halfB64: string): string => createHash('sha256').update(Buffer.from(halfB64, 'base64')).digest('hex').slice(0, 32);

async function readState(path: string | undefined): Promise<string | undefined> {
  if (!path) return undefined;
  try {
    const text = (await readFile(path, 'utf8')).trim();
    return text.length > 0 ? text : undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
    throw new Error(`swap wallet state ${path} is not readable: ${(err as Error).message}`);
  }
}

/** The state holds the wallet's coins: written next to itself, then renamed, readable by the owner only. */
async function writeState(path: string | undefined, wallet: any): Promise<void> {
  if (!path) return;
  const state = String(await wallet.serializeState());
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.part`;
  await writeFile(tmp, state, { mode: 0o600 });
  await rename(tmp, path);
  await chmod(path, 0o600).catch(() => { /* not every file system has modes */ });
}

async function openWallet(config: NightgateMcpConfig): Promise<OpenWallet> {
  if (!config.seedHex) {
    throw new Error('swaps need NIGHTGATE_SEED_HEX in the MCP server environment; it is never a tool argument');
  }
  open ??= (async (): Promise<OpenWallet> => {
    try {
      const { createSwapWallet } = await loadSwapModule();
      const d = defaults(config.network);
      const walletState = await readState(config.swapStateFile);
      const wallet = await createSwapWallet({
        seedHex: config.seedHex,
        networkId: config.network,
        indexerHttpUrl: config.indexerHttpUrl ?? d.indexerHttpUrl,
        indexerWsUrl: config.indexerWsUrl ?? d.indexerWsUrl,
        ...(config.nodeUrl ? { nodeUrl: config.nodeUrl } : {}),
        ...(config.proofServerUrl ? { provingMode: 'server', proofServerUrl: config.proofServerUrl } : {}),
        ...(config.swapMaxInputs ? { maxInputs: config.swapMaxInputs } : {}),
        ...(walletState ? { walletState } : {}),
      });
      const entry: OpenWallet = { wallet, synced: Promise.resolve(), isSynced: false, syncError: null, startedAt: Date.now(), resumed: !!walletState };
      entry.synced = (async () => {
        try {
          await wallet.sync();
          await writeState(config.swapStateFile, wallet).catch((err) => console.error(`nightgate-mcp: swap wallet state not saved: ${(err as Error).message}`));
          entry.isSynced = true;
        } catch (err) {
          entry.syncError = err instanceof Error ? err : new Error(String(err));
        }
      })();
      return entry;
    } catch (err) {
      open = undefined;
      throw err;
    }
  })();
  return open;
}

/** The wallet once it has caught up; a wallet that needs longer than `waitMs` says so instead of blocking the call. */
async function syncedWallet(config: NightgateMcpConfig, waitMs: number): Promise<any> {
  const entry = await openWallet(config);
  if (!entry.isSynced && !entry.syncError) {
    await Promise.race([entry.synced, new Promise((resolve) => setTimeout(resolve, waitMs))]);
  }
  if (entry.syncError) {
    open = undefined;
    throw new Error(`the swap wallet could not sync: ${entry.syncError.message}`);
  }
  if (!entry.isSynced) {
    const seconds = Math.round((Date.now() - entry.startedAt) / 1000);
    throw new Error(
      `the swap wallet is still syncing its shielded coins (${seconds} s so far; a first sync from genesis takes about 5 minutes` +
      `${config.swapStateFile ? '' : ', set NIGHTGATE_SWAP_STATE_FILE to resume after a restart'}); call again shortly`);
  }
  return entry.wallet;
}

/** How long a tool call waits for a wallet that is still syncing. */
const SYNC_WAIT_MS = 20_000;

export async function swapWalletInfo(config: NightgateMcpConfig): Promise<Record<string, unknown>> {
  const entry = await openWallet(config);
  const { wallet } = entry;
  const base = {
    address: String(wallet.address),
    coinPublicKey: String(wallet.coinPublicKey),
    encryptionPublicKey: String(wallet.encryptionPublicKey),
    network: config.network,
    maxInputs: Number(wallet.maxInputs),
    provingMode: String(wallet.provingMode),
    synced: entry.isSynced,
    resumedFromState: entry.resumed,
  };
  if (entry.syncError) throw new Error(`the swap wallet could not sync: ${entry.syncError.message}`);
  if (!entry.isSynced) {
    await Promise.race([entry.synced, new Promise((resolve) => setTimeout(resolve, SYNC_WAIT_MS))]);
    if (!entry.isSynced) return { ...base, syncingSeconds: Math.round((Date.now() - entry.startedAt) / 1000) };
  }
  const coins: Array<{ tokenType: string; amount: bigint }> = await wallet.coins();
  const byType = new Map<string, { balance: bigint; coins: number }>();
  for (const c of coins) {
    const t = byType.get(c.tokenType) ?? { balance: 0n, coins: 0 };
    byType.set(c.tokenType, { balance: t.balance + c.amount, coins: t.coins + 1 });
  }
  const tokens = [];
  for (const [tokenType, t] of byType) {
    tokens.push({ tokenType, balance: t.balance.toString(), coins: t.coins, spendable: String(await wallet.spendable(tokenType)) });
  }
  const pendingHalves = [...pending.entries()].map(([id, p]) => ({ id, role: p.role, ...(p.jobId ? { jobId: p.jobId } : {}), ...p.terms }));
  return { ...base, synced: true, tokens, pendingHalves };
}

export interface BuiltOffer {
  id: string;
  offer?: string;
  halfB64: string;
  bound: boolean;
  serializedBytes: number;
  terms: SwapTermsOut;
  buildMs: number;
}

/** One half of a swap from this wallet; bound with its offer file unless `bind` is false. */
export async function buildOffer(config: NightgateMcpConfig, input: { give: SwapLeg; want: SwapLeg; bind?: boolean }): Promise<BuiltOffer> {
  const t0 = Date.now();
  const wallet = await syncedWallet(config, SYNC_WAIT_MS);
  const half = await wallet.buildHalf({ give: input.give, want: input.want, bind: input.bind !== false });
  const terms = termsOut(half.terms);
  const id = halfId(half.halfB64);
  pending.set(id, { revert: half.revert, terms, role: 'maker' });
  await writeState(config.swapStateFile, wallet).catch(() => { /* the half is built; the state follows at the next save */ });
  return {
    id, ...(half.offer ? { offer: half.offer } : {}), halfB64: half.halfB64, bound: half.bound === true,
    serializedBytes: Number(half.serializedBytes), terms, buildMs: Date.now() - t0,
  };
}

export interface TakenOfferOut {
  id: string;
  makerHalfB64: string;
  takerHalfB64: string;
  bound: boolean;
  terms: SwapTermsOut;
  buildMs: number;
}

/** The mirror half of an offer from this wallet, after its terms were read and compared with `expect`. */
export async function takeOffer(config: NightgateMcpConfig, input: { offer: string; expect?: { gives: SwapLeg; wants: SwapLeg } }): Promise<TakenOfferOut> {
  const t0 = Date.now();
  const wallet = await syncedWallet(config, SYNC_WAIT_MS);
  const taken = await wallet.takeOffer({ offer: input.offer, ...(input.expect ? { expect: input.expect } : {}) });
  const terms = termsOut(taken.terms);
  const id = halfId(taken.takerHalfB64);
  pending.set(id, { revert: taken.revert, terms, role: 'taker', halves: { makerHalfB64: taken.makerHalfB64, takerHalfB64: taken.takerHalfB64 } });
  await writeState(config.swapStateFile, wallet).catch(() => { /* as above */ });
  return { id, makerHalfB64: taken.makerHalfB64, takerHalfB64: taken.takerHalfB64, bound: taken.bound === true, terms, buildMs: Date.now() - t0 };
}

/** Releases the coins of a half built here that is not going to be handed over. */
export async function revertHalf(config: NightgateMcpConfig, id: string): Promise<{ id: string; reverted: true }> {
  const half = pending.get(id);
  if (!half) throw new Error(`no half with id ${id} was built by this server process (ids are listed by get_swap_wallet)`);
  await half.revert();
  pending.delete(id);
  const entry = await openWallet(config);
  await writeState(config.swapStateFile, entry.wallet).catch(() => { /* as above */ });
  return { id, reverted: true };
}

/** Both halves of an offer taken here, for a submission by id. */
export function takenHalves(id: string): { makerHalfB64: string; takerHalfB64: string } {
  const half = pending.get(id);
  if (!half) throw new Error(`no half with id ${id} is held by this server process (ids are listed by get_swap_wallet)`);
  if (!half.halves) throw new Error(`half ${id} is an offer built here, not a taken one: pass both halves`);
  return half.halves;
}

/** Remembers the sponsor job a half went into. An id this process does not hold is ignored. */
export function trackHalfJob(id: string, jobId: unknown): void {
  const half = pending.get(id);
  if (half && typeof jobId === 'string') half.jobId = jobId;
}

/** A landed swap spent its coins: its half is no longer pending. A failed one stays, so it can be reverted. */
export function settleHalfJob(jobId: string, status: unknown): void {
  if (status !== 'succeeded') return;
  for (const [id, half] of pending) if (half.jobId === jobId) pending.delete(id);
}

/** Test seam / shutdown. */
export async function closeSwapWallet(): Promise<void> {
  const current = open;
  open = undefined;
  pending.clear();
  if (!current) return;
  try { await (await current).wallet.close?.(); } catch { /* best effort */ }
}

/** Test seam: replace the module the swap functions load. */
export function __setSwapModuleForTests(mod: TxSwapModule | undefined): void {
  modulePromise = mod ? Promise.resolve(mod) : undefined;
  open = undefined;
  pending.clear();
}
