// Halves and calls built here: they leave the list when they landed, a refused call gives its coins back,
// one state file belongs to one process, and a half of an earlier process keeps its job readable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __setSwapModuleForTests, closeSwapWallet, lockStateFile, revertHalf, settleHalfJob, swapWalletInfo, trackCall, trackHalfJob } from '../../dist/swap.js';
import { jobSession } from '../../dist/jobs.js';

const config = { network: 'preprod' };
const terms = { contractAddress: 'cc'.repeat(32), circuit: 'enter', coins: [{ tokenType: 'aa'.repeat(32), amount: '5' }] };

function wallet() {
  const reverted = [];
  return { reverted, async revert(tx) { reverted.push(tx); }, async serializeState() { return 'state'; } };
}

test('a call that landed leaves the list without a revert', async () => {
  const w = wallet();
  const id = await trackCall(config, w, Buffer.from('landed-call').toString('base64'), terms);
  trackHalfJob(id, { jobId: 'job-landed' });
  await settleHalfJob(config, 'job-landed', { status: 'succeeded', chainStatus: 'pending' });
  await settleHalfJob(config, 'job-landed', { status: 'succeeded', chainStatus: 'success' });
  assert.deepEqual(w.reverted, []);
  await assert.rejects(revertHalf(config, id), /no half with id/);
});

test('a call the chain dropped gives its coins back', async () => {
  const w = wallet();
  const tx = Buffer.from('dropped-call').toString('base64');
  const id = await trackCall(config, w, tx, terms);
  trackHalfJob(id, { jobId: 'job-dropped' });
  await settleHalfJob(config, 'job-dropped', { status: 'succeeded', chainStatus: 'dropped' });
  assert.deepEqual(w.reverted, [tx]);
  await assert.rejects(revertHalf(config, id), /no half with id/);
});

test('a failed job releases the call; revertHalf releases it by hand', async () => {
  const w = wallet();
  const failed = await trackCall(config, w, Buffer.from('failed-call').toString('base64'), terms);
  trackHalfJob(failed, { jobId: 'job-failed' });
  await settleHalfJob(config, 'job-failed', { status: 'failed' });
  assert.equal(w.reverted.length, 1);
  const byHand = await trackCall(config, w, Buffer.from('by-hand').toString('base64'), terms);
  assert.deepEqual(await revertHalf(config, byHand), { id: byHand, reverted: true });
  assert.equal(w.reverted.length, 2);
});

test('a state file another live process holds is refused; a stale lock is taken over', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-lock-'));
  const held = join(dir, 'held.state');
  writeFileSync(`${held}.lock`, String(process.ppid));
  assert.throws(() => lockStateFile(held), /in use by another process/);
  const stale = join(dir, 'stale.state');
  writeFileSync(`${stale}.lock`, '2147483646');
  assert.doesNotThrow(() => lockStateFile(stale));
});

test('a half of an earlier process keeps the session its job is read under, and the wallet view does not show it', async () => {
  const swapStateFile = join(mkdtempSync(join(tmpdir(), 'mcp-halves-')), 'wallet.state');
  const id = 'ab'.repeat(16);
  writeFileSync(`${swapStateFile}.halves.json`, JSON.stringify([{
    id, role: 'taker', bytes: Buffer.from('half').toString('base64'), builtAt: 1, jobId: 'job-restored', jobSession: 'session-restored',
    terms: { gives: { tokenType: 'aa'.repeat(32), amount: '5' }, wants: { tokenType: 'bb'.repeat(32), amount: '7' } },
  }]));
  __setSwapModuleForTests({
    createSwapWallet: async () => ({
      ...wallet(), address: 'mn_shield-addr_test1own', coinPublicKey: 'c'.repeat(64), encryptionPublicKey: 'e'.repeat(64), maxInputs: 4, provingMode: 'wasm',
      async sync() {}, async coins() { return []; }, async pendingBalances() { return {}; }, async spendable() { return 0n; }, async close() {},
    }),
  });
  try {
    const info = await swapWalletInfo({
      network: 'preprod', seedHex: '5'.repeat(128), swapStateFile,
      indexerHttpUrl: 'http://127.0.0.1:9/api/v4/graphql', indexerWsUrl: 'ws://127.0.0.1:9/api/v4/graphql/ws',
    });
    assert.deepEqual(info.pendingHalves.map((p) => [p.id, p.restored, p.jobId, 'jobSession' in p]), [[id, true, 'job-restored', false]]);
    assert.equal(jobSession('job-restored'), 'session-restored');
  } finally {
    await closeSwapWallet();
    __setSwapModuleForTests(undefined);
  }
});
