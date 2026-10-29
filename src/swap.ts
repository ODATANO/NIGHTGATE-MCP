/**
 * Shielded swaps, the local side: one wallet that holds the shielded coins of
 * `NIGHTGATE_SEED_HEX` builds swap halves and takes offers. It wraps the swap
 * wallet of `@odatano/nightgate-tx`; the fee is the sponsor's, so the wallet
 * needs neither NIGHT nor dust. Its coins sync from a configured Midnight indexer.
 */
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { NightgateMcpConfig } from './config.js';
import { txExport } from './tx-module.js';
import { ensureSeed } from './seed.js';
import { setStage } from './jobs.js';

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
  terms: SwapTermsOut | TransferTermsOut;
  role: 'maker' | 'taker' | 'transfer';
  /** Both halves of a taken offer, so it can be submitted by id. */
  halves?: { makerHalfB64: string; takerHalfB64: string };
  /** The sponsor job the half went into. */
  jobId?: string;
  /** The board entry a maker half was posted as, and its last read status. */
  offerId?: string;
  boardStatus?: string;
  /** When it was posted, in ms. */
  postedAt?: number;
}
/** Halves built here whose swap has not landed, by id. */
const pending = new Map<string, PendingHalf>();

const halfIdOf = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex').slice(0, 32);
const halfId = (halfB64: string): string => halfIdOf(Buffer.from(halfB64, 'base64'));

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
  await ensureSeed(config);
  const { indexerHttpUrl, indexerWsUrl } = config;
  if (!indexerHttpUrl || !indexerWsUrl) {
    throw new Error('swaps need NIGHTGATE_INDEXER_HTTP_URL and NIGHTGATE_INDEXER_WS_URL in the MCP server environment: a Midnight indexer the swap wallet syncs its coins from');
  }
  open ??= (async (): Promise<OpenWallet> => {
    try {
      const { createSwapWallet } = await loadSwapModule();
      const walletState = await readState(config.swapStateFile);
      const wallet = await createSwapWallet({
        seedHex: config.seedHex,
        networkId: config.network,
        indexerHttpUrl,
        indexerWsUrl,
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
export async function syncedWallet(config: NightgateMcpConfig, waitMs: number): Promise<any> {
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
export const SYNC_WAIT_MS = 20_000;

/**
 * The one shielded wallet of this process, for a builder: `synced` waits for its coins like the swap
 * tools do, otherwise it is only open. The builders share its sync and its view of the coins.
 */
export async function processWallet(config: NightgateMcpConfig, synced: boolean): Promise<any> {
  const wallet = synced ? await syncedWallet(config, SYNC_WAIT_MS) : (await openWallet(config)).wallet;
  if (!wallet.shieldedWallet) {
    throw new Error('a contract call from this wallet needs @odatano/nightgate-tx >= 0.19.0 next to the MCP server (npm install @odatano/nightgate-tx@latest)');
  }
  return wallet;
}

/** Saves the wallet after a build reserved coins; a failed save is caught up by the next one. */
export async function saveWalletState(config: NightgateMcpConfig, wallet: any): Promise<void> {
  await writeState(config.swapStateFile, wallet).catch(() => { /* the next save carries it */ });
}

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
  const pendingByType: Record<string, bigint> = await wallet.pendingBalances();
  const byType = new Map<string, { balance: bigint; coins: number; pending: bigint }>();
  for (const c of coins) {
    const t = byType.get(c.tokenType) ?? { balance: 0n, coins: 0, pending: 0n };
    byType.set(c.tokenType, { ...t, balance: t.balance + c.amount, coins: t.coins + 1 });
  }
  for (const [tokenType, pending] of Object.entries(pendingByType)) {
    const t = byType.get(tokenType) ?? { balance: 0n, coins: 0, pending: 0n };
    byType.set(tokenType, { ...t, pending: t.pending + pending });
  }
  const tokens = [];
  for (const [tokenType, t] of byType) {
    tokens.push({ tokenType, balance: t.balance.toString(), coins: t.coins, spendable: String(await wallet.spendable(tokenType)), pending: t.pending.toString() });
  }
  const pendingHalves = [...pending.entries()].map(([id, p]) => ({
    id, role: p.role, ...(p.jobId ? { jobId: p.jobId } : {}),
    ...(p.offerId ? { offerId: p.offerId, boardStatus: p.boardStatus ?? 'open' } : {}), ...p.terms,
  }));
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
  setStage('syncing the wallet');
  const wallet = await syncedWallet(config, SYNC_WAIT_MS);
  setStage('proving');
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

/** What a transfer built here moves: the type, the atoms and the recipient. */
export interface TransferTermsOut {
  tokenType: string;
  amount: string;
  to: string;
}

export interface BuiltTransferOut {
  id: string;
  transferTxB64: string;
  bound: boolean;
  serializedBytes: number;
  inputs: number;
  terms: TransferTermsOut;
  buildMs: number;
}

/** A plain transfer from this wallet to another shielded address, for `sponsorTransfer`; bound unless `bind` is false. */
export async function buildTransfer(config: NightgateMcpConfig, input: { tokenType: string; amount: string; to: string; bind?: boolean }): Promise<BuiltTransferOut> {
  const t0 = Date.now();
  setStage('syncing the wallet');
  const wallet = await syncedWallet(config, SYNC_WAIT_MS);
  if (typeof wallet.buildTransfer !== 'function') {
    throw new Error('transfers need @odatano/nightgate-tx >= 0.17.0 next to the MCP server (npm install @odatano/nightgate-tx@latest)');
  }
  setStage('proving');
  const built = await wallet.buildTransfer({ tokenType: input.tokenType, amount: input.amount, to: input.to, bind: input.bind !== false });
  const terms: TransferTermsOut = { tokenType: String(built.terms.tokenType), amount: String(built.terms.amount), to: String(built.terms.to) };
  const id = halfId(built.txB64);
  pending.set(id, { revert: built.revert, terms, role: 'transfer' });
  await writeState(config.swapStateFile, wallet).catch(() => { /* the transfer is built; the state follows at the next save */ });
  return { id, transferTxB64: built.txB64, bound: built.bound === true, serializedBytes: Number(built.serializedBytes), inputs: Number(built.inputs), terms, buildMs: Date.now() - t0 };
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
  setStage('syncing the wallet');
  const wallet = await syncedWallet(config, SYNC_WAIT_MS);
  setStage('proving');
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
/** Job ids of the halves still listed, so the caller can ask whether their swap landed. */
export function halfJobIds(): string[] {
  return [...new Set([...pending.values()].map((p) => p.jobId).filter((j): j is string => !!j))];
}

export function settleHalfJob(jobId: string, status: unknown): void {
  if (status !== 'succeeded') return;
  for (const [id, half] of pending) if (half.jobId === jobId) pending.delete(id);
}

/** Ties a maker half built here to the board entry it was posted as; any other offer is ignored. */
export async function trackPostedHalf(offer: string, offerId: unknown): Promise<void> {
  if (typeof offerId !== 'string' || ![...pending.values()].some((p) => p.role === 'maker')) return;
  const { decodeOffer } = await loadSwapModule();
  const half = pending.get(halfIdOf((await decodeOffer(offer)).bytes));
  if (half?.role === 'maker') { half.offerId = offerId; half.postedAt = Date.now(); }
}

/** Board entries of the maker halves held here. */
export function postedOfferIds(): string[] {
  return [...pending.values()].flatMap((p) => (p.offerId ? [p.offerId] : []));
}

/** When the oldest maker half held here was posted, in ms; undefined when none is. */
export function earliestPostedAt(): number | undefined {
  const times = [...pending.values()].flatMap((p) => (p.offerId && p.postedAt ? [p.postedAt] : []));
  return times.length ? Math.min(...times) : undefined;
}

/**
 * Board rows (one, an array or an OData collection) settle the halves posted as them:
 * a filled offer spent the half's coins, so it leaves; an expired or retired one stays revertable.
 */
export function settleBoardRows(result: unknown): void {
  const value = (result as { value?: unknown })?.value;
  const rows = Array.isArray(result) ? result : Array.isArray(value) ? value : [result];
  for (const row of rows) {
    const { offerId, status } = (row ?? {}) as { offerId?: unknown; status?: unknown };
    if (typeof offerId !== 'string' || typeof status !== 'string') continue;
    for (const [id, half] of pending) {
      if (half.offerId !== offerId) continue;
      if (status === 'filled') pending.delete(id);
      else half.boardStatus = status;
    }
  }
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
