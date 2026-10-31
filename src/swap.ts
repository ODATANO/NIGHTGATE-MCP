/**
 * The local side of shielded swaps and transfers: one wallet of the seed builds halves and takes offers.
 * The sponsor pays the fee, so the wallet needs neither NIGHT nor dust.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { NO_INDEXER, walletIndexer, type NightgateMcpConfig } from './config.js';
import { txExport } from './tx-module.js';
import { ensureSeed } from './seed.js';
import { chainOutcome, setStage } from './jobs.js';

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
/** What a contract call built here takes from this wallet. */
export interface CallTermsOut {
  contractAddress: string;
  circuit: string;
  coins: Array<{ tokenType: string; amount: string }>;
}

interface PendingHalf {
  revert: () => Promise<void>;
  terms: SwapTermsOut | TransferTermsOut | CallTermsOut;
  role: 'maker' | 'taker' | 'transfer' | 'call';
  /** The half's transaction as base64, so a later process can still revert it. */
  bytes: string;
  builtAt: number;
  /** Both halves of a taken offer, so it can be submitted by id. */
  halves?: { makerHalfB64: string; takerHalfB64: string };
  /** The sponsor job the half went into. */
  jobId?: string;
  /** The board entry a maker half was posted as, and its last read status. */
  offerId?: string;
  boardStatus?: string;
  /** When it was posted, in ms. */
  postedAt?: number;
  /** When the board closed the offer (expired or retired), in ms. */
  closedAt?: number;
  /** Loaded from the halves file of an earlier process. */
  restored?: boolean;
  /** `failure` or `dropped` when the chain refused the transaction it went into; its coins can be reverted. */
  chainStatus?: string;
}
/** Halves built here whose swap has not landed, by id. */
const pending = new Map<string, PendingHalf>();

const halfIdOf = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex').slice(0, 32);
const halfId = (halfB64: string): string => halfIdOf(Buffer.from(halfB64, 'base64'));

/** What the halves file keeps of a pending half: everything but the revert closure. */
type StoredHalf = Omit<PendingHalf, 'revert' | 'restored'>;

/** The halves file next to the state file; none without a state file. */
const halvesPath = (config: NightgateMcpConfig): string | undefined => (config.swapStateFile ? `${config.swapStateFile}.halves.json` : undefined);

let halvesFile: string | undefined;
let persistTimer: NodeJS.Timeout | undefined;

/** Writes the pending halves to their file soon; several changes in a row make one write. */
function schedulePersist(): void {
  if (!halvesFile || persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = undefined;
    void persistHalves().catch((err) => console.error(`nightgate-mcp: pending halves not saved: ${(err as Error).message}`));
  }, 0);
}

/** Writes a file readable by the owner only: next to itself under a name of this write, then renamed. */
async function writePrivate(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.part`;
  await writeFile(tmp, text, { mode: 0o600 });
  await rename(tmp, path);
  await chmod(path, 0o600).catch(() => { /* not every file system has modes */ });
}

async function persistHalves(): Promise<void> {
  if (!halvesFile) return;
  const rows: Array<StoredHalf & { id: string }> = [...pending.entries()].map(([id, { revert: _r, restored: _s, ...rest }]) => ({ id, ...rest }));
  await writePrivate(halvesFile, JSON.stringify(rows));
}

let lockedFile: string | undefined;

/** True while a process with this pid runs. */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException)?.code === 'EPERM'; }
}

/** Claims the state file for this process, so two servers never overwrite each other's coins. The lock file is created atomically. */
export function lockStateFile(path: string | undefined): void {
  if (!path || lockedFile === path) return;
  const lock = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (let tries = 0; ; tries++) {
    try {
      writeFileSync(lock, String(process.pid), { mode: 0o600, flag: 'wx' });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST' || tries > 0) throw err;
      let owner: number | undefined;
      try { owner = Number(readFileSync(lock, 'utf8').trim()); } catch { /* removed meanwhile */ }
      if (owner && owner !== process.pid && alive(owner)) {
        throw new Error(`NIGHTGATE_SWAP_STATE_FILE ${path} is in use by another process (pid ${owner}); give every MCP server its own state file, ` +
          `or delete ${lock} if that process is no MCP server`);
      }
      try { unlinkSync(lock); } catch { /* removed meanwhile */ }
    }
  }
  lockedFile = path;
  process.once('exit', () => { try { if (Number(readFileSync(lock, 'utf8').trim()) === process.pid) unlinkSync(lock); } catch { /* gone already */ } });
}

/** The halves an earlier process left in the file, each revertable through the wallet from its bytes. */
async function restoreHalves(path: string | undefined, wallet: any): Promise<void> {
  if (!path) return;
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return;
    throw new Error(`pending halves ${path} is not readable: ${(err as Error).message}`);
  }
  let rows: Array<StoredHalf & { id: string }>;
  try { rows = JSON.parse(text); } catch { throw new Error(`pending halves ${path} is not JSON; move it aside`); }
  for (const { id, ...rest } of rows) {
    if (pending.has(id) || typeof rest.bytes !== 'string') continue;
    pending.set(id, {
      ...rest,
      restored: true,
      revert: async () => {
        if (typeof wallet.revert !== 'function') throw new Error('reverting a half of an earlier process needs @odatano/nightgate-tx >= 0.20.0 next to the MCP server');
        await wallet.revert(rest.bytes);
      },
    });
  }
}

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

/** The state holds the wallet's coins, so it is written readable by the owner only. */
async function writeState(path: string | undefined, wallet: any): Promise<void> {
  if (!path) return;
  await writePrivate(path, String(await wallet.serializeState()));
}

/** Saved state of a builder's NIGHT coins, next to the swap wallet's state file. */
export async function readUnshieldedState(config: NightgateMcpConfig): Promise<string | undefined> {
  return readState(config.swapStateFile ? `${config.swapStateFile}.unshielded` : undefined);
}

export async function writeUnshieldedState(config: NightgateMcpConfig, state: string): Promise<void> {
  if (config.swapStateFile) await writePrivate(`${config.swapStateFile}.unshielded`, state);
}

/** The saved private states of contract calls, as tagged JSON by package and contract. */
export async function readPrivateStates(config: NightgateMcpConfig): Promise<Record<string, unknown> | undefined> {
  const text = await readState(config.swapStateFile ? `${config.swapStateFile}.private.json` : undefined);
  if (!text) return undefined;
  try { return JSON.parse(text) as Record<string, unknown>; } catch { throw new Error(`${config.swapStateFile}.private.json is not JSON; move it aside`); }
}

export async function writePrivateStates(config: NightgateMcpConfig, states: Record<string, unknown>): Promise<void> {
  if (config.swapStateFile) await writePrivate(`${config.swapStateFile}.private.json`, JSON.stringify(states));
}

async function openWallet(config: NightgateMcpConfig): Promise<OpenWallet> {
  await ensureSeed(config);
  const indexer = await walletIndexer(config);
  if (!indexer) throw new Error(NO_INDEXER);
  lockStateFile(config.swapStateFile);
  open ??= (async (): Promise<OpenWallet> => {
    try {
      const { createSwapWallet } = await loadSwapModule();
      const walletState = await readState(config.swapStateFile);
      const wallet = await createSwapWallet({
        seedHex: config.seedHex,
        networkId: config.network,
        ...indexer,
        ...(config.nodeUrl ? { nodeUrl: config.nodeUrl } : {}),
        ...(config.proofServerUrl ? { provingMode: 'server', proofServerUrl: config.proofServerUrl } : {}),
        ...(config.swapMaxInputs ? { maxInputs: config.swapMaxInputs } : {}),
        ...(walletState ? { walletState } : {}),
      });
      halvesFile = halvesPath(config);
      await restoreHalves(halvesFile, wallet);
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
    id, role: p.role, builtAt: new Date(p.builtAt).toISOString(), ...(p.restored ? { restored: true } : {}), ...(p.jobId ? { jobId: p.jobId } : {}),
    ...(p.offerId ? { offerId: p.offerId, boardStatus: p.boardStatus ?? 'open' } : {}),
    ...(p.closedAt ? { closedAt: new Date(p.closedAt).toISOString() } : {}), ...(p.chainStatus ? { chainStatus: p.chainStatus } : {}), ...p.terms,
  }));
  // the SDK's own list of what is reserved, with the instant it stops waiting for each coin
  const reserved: unknown[] | undefined = typeof wallet.pending === 'function'
    ? (await wallet.pending()).map((c: { tokenType: string; amount: bigint; ttl: string | null }) => ({ tokenType: c.tokenType, amount: c.amount.toString(), ttl: c.ttl }))
    : undefined;
  return { ...base, synced: true, tokens, pendingHalves, ...(reserved ? { reserved } : {}) };
}

/** How long a closed offer's half stays before its coins come back on their own: a swap taken just before the close may still land. */
export const LAPSED_HALF_GRACE_MS = 15 * 60_000;

let releasing: Promise<ReleasedHalf[]> | undefined;
export interface ReleasedHalf { id: string; role: PendingHalf['role']; offerId?: string; boardStatus?: string; terms: PendingHalf['terms'] }

// Reverts the maker halves whose board offer is expired or retired for longer than the grace period and
// that went into no sponsor job: nobody can take them any more, so their coins come back.
export async function releaseLapsedHalves(config: NightgateMcpConfig): Promise<ReleasedHalf[]> {
  releasing ??= (async (): Promise<ReleasedHalf[]> => {
    const now = Date.now();
    const released: ReleasedHalf[] = [];
    for (const [id, half] of [...pending.entries()]) {
      const lapsed = half.offerId && !half.jobId && (half.boardStatus === 'expired' || half.boardStatus === 'retired') && half.closedAt && now - half.closedAt >= LAPSED_HALF_GRACE_MS;
      if (!lapsed) continue;
      try {
        await half.revert();
        pending.delete(id);
        released.push({ id, role: half.role, offerId: half.offerId, boardStatus: half.boardStatus, terms: half.terms });
      } catch (err) {
        console.error(`nightgate-mcp: half ${id} of offer ${half.offerId} not released: ${(err as Error).message}`);
      }
    }
    if (released.length) {
      schedulePersist();
      const entry = await openWallet(config);
      await writeState(config.swapStateFile, entry.wallet).catch(() => { /* the next save carries it */ });
    }
    return released;
  })().finally(() => { releasing = undefined; });
  return releasing;
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
  pending.set(id, { revert: half.revert, terms, role: 'maker', bytes: half.halfB64, builtAt: Date.now() });
  schedulePersist();
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
  pending.set(id, { revert: built.revert, terms, role: 'transfer', bytes: built.txB64, builtAt: Date.now() });
  schedulePersist();
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
  pending.set(id, { revert: taken.revert, terms, role: 'taker', bytes: taken.takerHalfB64, builtAt: Date.now(), halves: { makerHalfB64: taken.makerHalfB64, takerHalfB64: taken.takerHalfB64 } });
  schedulePersist();
  await writeState(config.swapStateFile, wallet).catch(() => { /* as above */ });
  return { id, makerHalfB64: taken.makerHalfB64, takerHalfB64: taken.takerHalfB64, bound: taken.bound === true, terms, buildMs: Date.now() - t0 };
}

/** Releases the coins of a half built here that is not going to be handed over. */
export async function revertHalf(config: NightgateMcpConfig, id: string): Promise<{ id: string; reverted: true }> {
  const half = pending.get(id);
  if (!half) throw new Error(`no half with id ${id} is held by this server (ids are listed by get_swap_wallet, also the ones restored from an earlier process)`);
  await half.revert();
  pending.delete(id);
  schedulePersist();
  if (config.swapStateFile) await writeState(config.swapStateFile, (await openWallet(config)).wallet).catch(() => { /* as above */ });
  return { id, reverted: true };
}

// Releases the coins behind a board offer this wallet posted, from the board's copy of the half when
// no process holds it any more. Only for a closed offer: an open one could still be taken.
export async function revertOffer(config: NightgateMcpConfig, offerId: string, row: { status?: unknown; offer?: unknown }): Promise<{ offerId: string; id?: string; reverted: true }> {
  const held = [...pending.entries()].find(([, p]) => p.offerId === offerId);
  const status = String(row.status ?? '');
  if (status === 'filled') {
    if (held) { pending.delete(held[0]); schedulePersist(); }
    throw new Error(`offer ${offerId} filled: the swap landed and spent the half's coins, nothing to revert`);
  }
  if (status === 'open') throw new Error(`offer ${offerId} is still open and could be taken: retire_swap_offer first, or wait for its expiry`);
  if (held) return { offerId, ...(await revertHalf(config, held[0])) };
  if (typeof row.offer !== 'string' || !row.offer) throw new Error(`offer ${offerId} carries no half to revert`);
  const entry = await openWallet(config);
  if (typeof entry.wallet.revert !== 'function') throw new Error('reverting from the board needs @odatano/nightgate-tx >= 0.20.0 next to the MCP server');
  await entry.wallet.revert(row.offer);
  await writeState(config.swapStateFile, entry.wallet).catch(() => { /* as above */ });
  return { offerId, reverted: true };
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
  if (half && typeof jobId === 'string') { half.jobId = jobId; delete half.chainStatus; schedulePersist(); }
}

/** Job ids of the halves still listed, so the caller can ask whether their swap landed. */
export function halfJobIds(): string[] {
  return [...new Set([...pending.values()].filter((p) => !p.chainStatus).map((p) => p.jobId).filter((j): j is string => !!j))];
}

/**
 * A half or call whose transaction landed spent its coins and leaves the list. One the chain refused stays,
 * marked with the chain status: a swap half for revert_swap_offer, a contract call is released here.
 */
export async function settleHalfJob(config: NightgateMcpConfig, jobId: string, job: Record<string, unknown>): Promise<void> {
  const outcome = chainOutcome(job);
  if (outcome === 'unknown') return;
  for (const [id, half] of [...pending.entries()]) {
    if (half.jobId !== jobId) continue;
    if (outcome === 'landed') { pending.delete(id); schedulePersist(); continue; }
    if (half.role === 'call') { await revertHalf(config, id).catch((err) => console.error(`nightgate-mcp: coins of call ${id} not released: ${(err as Error).message}`)); continue; }
    half.chainStatus = String(job.chainStatus ?? job.status);
    schedulePersist();
  }
}

/** Lists a bound contract call whose `$coin` arguments reserved coins, so they come back if it never lands. */
export async function trackCall(config: NightgateMcpConfig, wallet: any, txB64: string, terms: CallTermsOut): Promise<string> {
  const id = halfId(txB64);
  pending.set(id, {
    revert: async () => {
      if (typeof wallet.revert !== 'function') throw new Error('releasing the coins of a call needs @odatano/nightgate-tx >= 0.20.0 next to the MCP server');
      await wallet.revert(txB64);
    },
    terms, role: 'call', bytes: txB64, builtAt: Date.now(),
  });
  schedulePersist();
  await writeState(config.swapStateFile, wallet).catch(() => { /* the call is listed; the state follows at the next save */ });
  return id;
}

/** Ties a maker half built here to the board entry it was posted as; any other offer is ignored. */
export async function trackPostedHalf(offer: string, offerId: unknown): Promise<void> {
  if (typeof offerId !== 'string' || ![...pending.values()].some((p) => p.role === 'maker')) return;
  const { decodeOffer } = await loadSwapModule();
  const half = pending.get(halfIdOf((await decodeOffer(offer)).bytes));
  if (half?.role === 'maker') { half.offerId = offerId; half.postedAt = Date.now(); schedulePersist(); }
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

// Board rows (one, an array or an OData collection) settle the halves posted as them: a filled offer spent
// the half's coins, so it leaves; an expired or retired one is noted with its close and released after the grace.
export function settleBoardRows(result: unknown): void {
  const value = (result as { value?: unknown })?.value;
  const rows = Array.isArray(result) ? result : Array.isArray(value) ? value : [result];
  for (const row of rows) {
    const { offerId, status, closedAt, expiresAt } = (row ?? {}) as { offerId?: unknown; status?: unknown; closedAt?: unknown; expiresAt?: unknown };
    if (typeof offerId !== 'string' || typeof status !== 'string') continue;
    for (const [id, half] of pending) {
      if (half.offerId !== offerId) continue;
      if (status === 'filled') { pending.delete(id); schedulePersist(); continue; }
      half.boardStatus = status;
      if (status === 'expired' || status === 'retired') {
        const stamp = Date.parse(String(closedAt ?? expiresAt ?? ''));
        half.closedAt = Number.isFinite(stamp) ? stamp : (half.closedAt ?? Date.now());
        schedulePersist();
      }
    }
  }
}

/** Test seam / shutdown. */
export async function closeSwapWallet(): Promise<void> {
  const current = open;
  open = undefined;
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = undefined; }
  await persistHalves().catch(() => { /* the file keeps its last state */ });
  pending.clear();
  halvesFile = undefined;
  if (!current) return;
  try { await (await current).wallet.close?.(); } catch { /* best effort */ }
}

/** Test seam: replace the module the swap functions load. */
export function __setSwapModuleForTests(mod: TxSwapModule | undefined): void {
  modulePromise = mod ? Promise.resolve(mod) : undefined;
  open = undefined;
  pending.clear();
  halvesFile = undefined;
}
