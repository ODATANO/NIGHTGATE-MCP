// Payments to an unshielded address: one runs at a time, a landed one saves the wallet, a failed one gives its coins back.
// The wallet view lists what the seed holds unshielded.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __setUnshieldedWalletForTests, buildUnshieldedTransfer, closeUnshieldedWallet, unshieldedInfo } from '../../dist/unshielded.js';

const NIGHT = '00'.repeat(32);
const TO = 'mn_addr_preprod1recipient';
const base = { network: 'preprod', seedHex: 'ab'.repeat(64), indexerHttpUrl: 'https://indexer.example/api/v4/graphql', indexerWsUrl: 'wss://indexer.example/api/v4/graphql/ws' };
const stateConfig = () => ({ ...base, swapStateFile: join(mkdtempSync(join(tmpdir(), 'mcp-night-')), 'wallet.state') });

function fakeWallet(over = {}) {
  const calls = { opened: [], built: [], reverted: [], closed: 0 };
  let n = 0;
  const wallet = {
    address: 'mn_addr_preprod1own',
    nightTokenType: NIGHT,
    async sync() { /* at the tip */ },
    async balances() { return { [NIGHT]: 5_000_000n }; },
    async coins() { return [{ tokenType: NIGHT, amount: 3_000_000n }, { tokenType: NIGHT, amount: 2_000_000n }]; },
    async pending() { return []; },
    async buildTransfer(input) {
      calls.built.push(input);
      return { txB64: Buffer.from(`transfer-${++n}`).toString('base64'), serializedBytes: 551, inputs: 2, terms: { tokenType: input.tokenType ?? NIGHT, amount: BigInt(input.amount), to: input.to } };
    },
    async revert(txB64) { calls.reverted.push(txB64); },
    async serializeState() { return `state-after-${n}`; },
    async close() { calls.closed++; },
    ...over,
  };
  __setUnshieldedWalletForTests(async (opts) => { calls.opened.push(opts); return wallet; });
  return calls;
}

afterEach(async () => {
  await closeUnshieldedWallet();
  __setUnshieldedWalletForTests(undefined);
});

test('builds a NIGHT payment from the wallet of the seed and hands back its terms as text', async () => {
  const calls = fakeWallet();
  const built = await buildUnshieldedTransfer(base, { amount: '700', to: TO }, 'key-terms');
  assert.deepEqual(calls.opened, [{ seedHex: base.seedHex, networkId: 'preprod', indexerHttpUrl: base.indexerHttpUrl, indexerWsUrl: base.indexerWsUrl }]);
  assert.deepEqual(calls.built, [{ amount: '700', to: TO }]);
  assert.equal(built.transferTxB64, Buffer.from('transfer-1').toString('base64'));
  assert.deepEqual(built.terms, { tokenType: NIGHT, amount: '700', to: TO });
  assert.equal(built.inputs, 2);
  await built.settle('landed');
});

test('one payment at a time: the next one waits until the first settled, then the saved wallet carries it', async () => {
  fakeWallet();
  const config = stateConfig();
  const first = await buildUnshieldedTransfer(config, { amount: '5', to: TO }, 'key-first');
  await assert.rejects(buildUnshieldedTransfer(config, { amount: '6', to: TO }, 'key-second'), /a NIGHT payment of this server has not settled yet/);
  assert.equal(existsSync(`${config.swapStateFile}.unshielded`), false);
  await first.settle('landed');
  assert.equal(readFileSync(`${config.swapStateFile}.unshielded`, 'utf8'), 'state-after-1');
  const second = await buildUnshieldedTransfer(config, { amount: '6', to: TO }, 'key-second');
  // a settle that runs twice changes nothing the second time
  await first.settle('failed');
  await second.settle('landed');
  assert.equal(readFileSync(`${config.swapStateFile}.unshielded`, 'utf8'), 'state-after-2');
});

test('a payment that failed gives its coins back and frees the gate', async () => {
  const calls = fakeWallet();
  const built = await buildUnshieldedTransfer(base, { amount: '5', to: TO }, 'key-failed');
  await built.settle('failed');
  assert.deepEqual(calls.reverted, [built.transferTxB64]);
  await (await buildUnshieldedTransfer(base, { amount: '5', to: TO }, 'key-after-failed')).settle('landed');
});

test('a build the wallet refuses frees the gate', async () => {
  fakeWallet({ async buildTransfer() { throw new Error('buildTransfer: sending 9 of 0000000000000000 needs more than the 5 this wallet holds unreserved'); } });
  await assert.rejects(buildUnshieldedTransfer(base, { amount: '9', to: TO }, 'key-short'), /needs more than the 5/);
  fakeWallet();
  await (await buildUnshieldedTransfer(base, { amount: '5', to: TO }, 'key-after-short')).settle('landed');
});

test('needs an indexer, and names a sync that failed', async () => {
  fakeWallet();
  await assert.rejects(buildUnshieldedTransfer({ network: 'preprod', seedHex: base.seedHex }, { amount: '5', to: TO }, 'key-no-indexer'), /needs this wallet's unshielded coins, and the wallet has no indexer/);
  fakeWallet({ async sync() { throw new Error('indexer answered 410'); } });
  await assert.rejects(buildUnshieldedTransfer(base, { amount: '5', to: TO }, 'key-sync'), /unshielded coins could not sync: indexer answered 410/);
  fakeWallet();
  await (await buildUnshieldedTransfer(base, { amount: '5', to: TO }, 'key-after-sync')).settle('landed');
});

test('the wallet view lists NIGHT first: the free balance, its coins and what a payment holds', async () => {
  const OTHER = 'c3'.repeat(32);
  fakeWallet({
    async balances() { return { [OTHER]: 40n, [NIGHT]: 5_000_000n }; },
    async coins() { return [{ tokenType: OTHER, amount: 40n }, { tokenType: NIGHT, amount: 3_000_000n }, { tokenType: NIGHT, amount: 2_000_000n }]; },
    async pending() { return [{ tokenType: NIGHT, amount: 700n }]; },
  });
  assert.deepEqual(await unshieldedInfo(base), {
    address: 'mn_addr_preprod1own',
    synced: true,
    tokens: [
      { tokenType: NIGHT, name: 'NIGHT', balance: '5000000', coins: 2, reserved: '700' },
      { tokenType: OTHER, balance: '40', coins: 1, reserved: '0' },
    ],
  });
});

test('the wallet view names NIGHT in an empty wallet, is absent without an indexer and reports a failed sync', async () => {
  fakeWallet({ async balances() { return {}; }, async coins() { return []; } });
  assert.deepEqual((await unshieldedInfo(base)).tokens, [{ tokenType: NIGHT, name: 'NIGHT', balance: '0', coins: 0, reserved: '0' }]);
  assert.equal(await unshieldedInfo({ network: 'preprod', seedHex: base.seedHex }), undefined);
  await closeUnshieldedWallet();
  fakeWallet({ async sync() { throw new Error('indexer answered 410'); } });
  assert.deepEqual(await unshieldedInfo(base), { address: 'mn_addr_preprod1own', synced: false, error: 'indexer answered 410' });
  fakeWallet();
  assert.equal((await unshieldedInfo(base)).synced, true);
});
