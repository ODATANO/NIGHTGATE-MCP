// Payments to an unshielded address. The wallet of the seed's unshielded coins, NIGHT included, builds and signs them.
// The sponsor pays the fee, so the wallet needs no dust.
import { canSyncWallet, NO_INDEXER, walletIndexer, type NightgateMcpConfig } from './config.js';
import { holdNight } from './contract-call.js';
import { setStage } from './jobs.js';
import { ensureSeed } from './seed.js';
import { lockStateFile, readUnshieldedState, SYNC_WAIT_MS, writeUnshieldedState } from './swap.js';
import { txExport } from './tx-module.js';
import type { CreateUnshieldedWalletInput, UnshieldedWallet } from '@odatano/nightgate-tx/txbuilder';

type CreateUnshieldedWallet = (opts: CreateUnshieldedWalletInput) => Promise<UnshieldedWallet>;

interface OpenWallet {
  wallet: UnshieldedWallet;
  /** Settles when the wallet has caught up; a failure is kept for the next caller. */
  synced: Promise<void>;
  isSynced: boolean;
  syncError: Error | null;
  startedAt: number;
}

let create: Promise<CreateUnshieldedWallet> | undefined;
let open: Promise<OpenWallet> | undefined;

async function openWallet(config: NightgateMcpConfig): Promise<OpenWallet> {
  const seedHex = await ensureSeed(config);
  const indexer = await walletIndexer(config);
  if (!indexer) throw new Error(`a payment to an unshielded address needs this wallet's unshielded coins, and ${NO_INDEXER}`);
  lockStateFile(config.swapStateFile);
  open ??= (async (): Promise<OpenWallet> => {
    try {
      create ??= txExport<CreateUnshieldedWallet>('createUnshieldedWallet', 'payments to an unshielded address', '0.22.1');
      const walletState = await readUnshieldedState(config);
      const wallet = await (await create)({ seedHex, networkId: config.network, ...indexer, ...(walletState ? { walletState } : {}) });
      const entry: OpenWallet = { wallet, synced: Promise.resolve(), isSynced: false, syncError: null, startedAt: Date.now() };
      entry.synced = (async () => {
        try {
          await wallet.sync();
          entry.isSynced = true;
        } catch (err) {
          entry.syncError = err instanceof Error ? err : new Error(String(err));
        }
      })();
      return entry;
    } catch (err) {
      open = undefined;
      create = undefined;
      throw err;
    }
  })();
  return open;
}

/** Waits for the sync as long as a tool call waits. A failed sync is dropped, so the next call starts a new one. */
async function awaitSync(entry: OpenWallet): Promise<void> {
  if (!entry.isSynced && !entry.syncError) await Promise.race([entry.synced, new Promise((resolve) => setTimeout(resolve, SYNC_WAIT_MS))]);
  if (entry.syncError) open = undefined;
}

/** The wallet once it has caught up; one that needs longer than the tool waits says so instead of blocking the call. */
async function syncedWallet(config: NightgateMcpConfig): Promise<UnshieldedWallet> {
  const entry = await openWallet(config);
  await awaitSync(entry);
  if (entry.syncError) throw new Error(`the wallet's unshielded coins could not sync: ${entry.syncError.message}`);
  if (!entry.isSynced) {
    throw new Error(`the wallet is still syncing its unshielded coins (${Math.round((Date.now() - entry.startedAt) / 1000)} s so far); call again shortly`);
  }
  return entry.wallet;
}

/** What the wallet holds unshielded. `reserved` is what payments built here hold until they landed. */
export interface UnshieldedInfo {
  address?: string;
  synced: boolean;
  syncingSeconds?: number;
  error?: string;
  tokens?: Array<{ tokenType: string; name?: 'NIGHT'; balance: string; coins: number; reserved: string }>;
}

/** The unshielded side of the wallet, NIGHT first and always listed. Undefined without an indexer; it never throws. */
export async function unshieldedInfo(config: NightgateMcpConfig): Promise<UnshieldedInfo | undefined> {
  if (!canSyncWallet(config)) return undefined;
  try {
    const entry = await openWallet(config);
    const { wallet } = entry;
    await awaitSync(entry);
    if (entry.syncError) return { address: wallet.address, synced: false, error: entry.syncError.message };
    if (!entry.isSynced) return { address: wallet.address, synced: false, syncingSeconds: Math.round((Date.now() - entry.startedAt) / 1000) };
    const [balances, coins, reserved] = await Promise.all([wallet.balances(), wallet.coins(), wallet.pending()]);
    const types = [...new Set([wallet.nightTokenType, ...Object.keys(balances), ...reserved.map((c) => c.tokenType)])];
    return {
      address: wallet.address,
      synced: true,
      tokens: types.map((tokenType) => ({
        tokenType,
        ...(tokenType === wallet.nightTokenType ? { name: 'NIGHT' as const } : {}),
        balance: String(balances[tokenType] ?? 0n),
        coins: coins.filter((c) => c.tokenType === tokenType).length,
        reserved: String(reserved.reduce((total, c) => (c.tokenType === tokenType ? total + c.amount : total), 0n)),
      })),
    };
  } catch (err) {
    return { synced: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface BuiltUnshieldedTransfer {
  transferTxB64: string;
  serializedBytes: number;
  inputs: number;
  terms: { tokenType: string; amount: string; to: string };
  buildMs: number;
  /** Runs once the transfer's job settled: a landed one saves the wallet, a failed one gives its coins back. */
  settle(outcome: 'landed' | 'failed'): Promise<void>;
}

/** A plain payment of `amount` atoms to the unshielded address `to`, for `sponsorTransfer`. `tokenType` defaults to NIGHT. */
export async function buildUnshieldedTransfer(
  config: NightgateMcpConfig, input: { amount: string; to: string; tokenType?: string }, callKey: string,
): Promise<BuiltUnshieldedTransfer> {
  const t0 = Date.now();
  let wallet: UnshieldedWallet | undefined;
  // Held until the job settled, since a contract call's pay-in could pick the same coins.
  const hold = holdNight(callKey, 'a NIGHT payment', async (txB64) => { await wallet?.revert(txB64); });
  try {
    setStage('syncing the wallet');
    wallet = await syncedWallet(config);
    setStage('signing');
    const built = await wallet.buildTransfer(input);
    hold.built(built.txB64);
    const from = wallet;
    const settle = async (outcome: 'landed' | 'failed'): Promise<void> => {
      if (!hold.drop()) return;
      if (outcome === 'failed') await from.revert(built.txB64);
      await writeUnshieldedState(config, await from.serializeState());
    };
    return {
      transferTxB64: built.txB64,
      serializedBytes: Number(built.serializedBytes),
      inputs: Number(built.inputs),
      terms: { tokenType: String(built.terms.tokenType), amount: String(built.terms.amount), to: String(built.terms.to) },
      buildMs: Date.now() - t0,
      settle,
    };
  } catch (err) {
    hold.drop();
    throw err;
  }
}

/** Test seam / shutdown. */
export async function closeUnshieldedWallet(): Promise<void> {
  const current = open;
  open = undefined;
  if (!current) return;
  try { await (await current).wallet.close(); } catch { /* best effort */ }
}

/** Test seam: replace the wallet factory the payments load. */
export function __setUnshieldedWalletForTests(factory: CreateUnshieldedWallet | undefined): void {
  create = factory ? Promise.resolve(factory) : undefined;
  open = undefined;
}
