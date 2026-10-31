// Halves and calls built here: they leave the list when they landed, a refused call gives its coins back,
// and one state file belongs to one process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lockStateFile, revertHalf, settleHalfJob, trackCall, trackHalfJob } from '../../dist/swap.js';

const config = { network: 'preprod' };
const terms = { contractAddress: 'cc'.repeat(32), circuit: 'enter', coins: [{ tokenType: 'aa'.repeat(32), amount: '5' }] };

function wallet() {
  const reverted = [];
  return { reverted, async revert(tx) { reverted.push(tx); }, async serializeState() { return 'state'; } };
}

test('a call that landed leaves the list without a revert', async () => {
  const w = wallet();
  const id = await trackCall(config, w, Buffer.from('landed-call').toString('base64'), terms);
  trackHalfJob(id, 'job-landed');
  await settleHalfJob(config, 'job-landed', { status: 'succeeded', chainStatus: 'pending' });
  await settleHalfJob(config, 'job-landed', { status: 'succeeded', chainStatus: 'success' });
  assert.deepEqual(w.reverted, []);
  await assert.rejects(revertHalf(config, id), /no half with id/);
});

test('a call the chain dropped gives its coins back', async () => {
  const w = wallet();
  const tx = Buffer.from('dropped-call').toString('base64');
  const id = await trackCall(config, w, tx, terms);
  trackHalfJob(id, 'job-dropped');
  await settleHalfJob(config, 'job-dropped', { status: 'succeeded', chainStatus: 'dropped' });
  assert.deepEqual(w.reverted, [tx]);
  await assert.rejects(revertHalf(config, id), /no half with id/);
});

test('a failed job releases the call; revertHalf releases it by hand', async () => {
  const w = wallet();
  const failed = await trackCall(config, w, Buffer.from('failed-call').toString('base64'), terms);
  trackHalfJob(failed, 'job-failed');
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
