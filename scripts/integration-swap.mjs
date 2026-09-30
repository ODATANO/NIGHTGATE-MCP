/**
 * Integration check for the swap tools, no network and no wallet SDK: the
 * swap module of @odatano/nightgate-tx and the HTTP transport are replaced by
 * stand-ins, the MCP server and its tools are the real ones.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../dist/server.js';
import { loadConfig } from '../dist/config.js';
import { __setSwapModuleForTests, closeSwapWallet } from '../dist/swap.js';

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const A = 'a1'.repeat(32);
const B = 'b2'.repeat(32);
const POOL = '00000000-0000-0000-0000-706f6f6c0000';
const JOB = '11111111-2222-4333-8444-555555555555';
const OFFER = `swapoffer1${'q'.repeat(60)}`;
const makerTerms = { gives: { tokenType: A, amount: 1000n }, wants: { tokenType: B, amount: 300n }, inputs: 1, outputs: 2 };

const calls = { created: [], built: [], reverted: [], closed: 0, posts: [] };
let halfCount = 0;
const halfOf = (give, want, bind) => {
  const n = ++halfCount;
  const bytes = Buffer.from(`half-${n}`.padEnd(64, '.'));
  return {
    tx: {}, bound: bind, serializedBytes: 15477,
    halfB64: bytes.toString('base64'),
    ...(bind ? { offer: `${OFFER}${n}` } : {}),
    terms: { gives: { tokenType: give.tokenType, amount: BigInt(give.amount) }, wants: { tokenType: want.tokenType, amount: BigInt(want.amount) }, inputs: 1, outputs: 2 },
    revert: async () => { calls.reverted.push(n); },
  };
};
const wallet = {
  address: 'mn_shield-addr_test1swap', coinPublicKey: 'c'.repeat(64), encryptionPublicKey: 'e'.repeat(64),
  maxInputs: 4, provingMode: 'wasm',
  sync: async () => {},
  coins: async () => [{ tokenType: A, amount: 700n }, { tokenType: A, amount: 300n }, { tokenType: B, amount: 900n }],
  spendable: async (tokenType) => (tokenType === A ? 1000n : 900n),
  buildHalf: async ({ give, want, bind = true }) => { calls.built.push({ give, want, bind }); return halfOf(give, want, bind); },
  takeOffer: async ({ offer, expect }) => {
    if (expect && (String(expect.gives.amount) !== '1000' || expect.gives.tokenType !== A)) {
      throw new Error('takeOffer: the offer gives 1000 of a1a1a1a1a1a1a1a1 for 300 of b2b2b2b2b2b2b2b2, which is not what was expected');
    }
    const half = halfOf(makerTerms.wants, makerTerms.gives, true);
    return { makerHalfB64: Buffer.from(offer).toString('base64'), takerHalfB64: half.halfB64, bound: true, terms: makerTerms, revert: half.revert };
  },
  serializeState: async () => `state-after-${halfCount}-halves`,
  close: async () => { calls.closed += 1; },
};
__setSwapModuleForTests({
  createSwapWallet: async (opts) => { calls.created.push(opts); return wallet; },
  decodeOffer: async (input) => {
    if (!String(input).startsWith(OFFER)) throw new Error('not an offer file and not base64');
    return { tx: { terms: makerTerms }, bound: true, bytes: new Uint8Array(15477) };
  },
  readSwapTerms: (tx) => tx.terms,
});

// The transport: one refusal, then jobs.
let refuseNext = true;
let jobStatus = 'running';
globalThis.fetch = async (url, init) => {
  const name = String(url).split('/').pop();
  const body = init?.body ? JSON.parse(init.body) : undefined;
  calls.posts.push({ name, body });
  const json = (status, payload) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
  if (name === 'sponsorSwap') {
    if (refuseNext) { refuseNext = false; return json(503, { error: { code: 'SPONSOR_POLICY_EMPTY', message: 'this server sponsors no swaps' } }); }
    return json(200, { jobId: JOB, status: 'pending', sessionId: POOL });
  }
  if (name === 'getJobStatus') return json(200, { jobId: JOB, status: jobStatus });
  return json(404, { error: { code: '404', message: `unexpected request ${name}` } });
};

const dir = await mkdtemp(join(tmpdir(), 'nightgate-mcp-swap-'));
const stateFile = join(dir, 'state', 'swap-wallet.state');
const env = {
  ODATANO_ACCESS_URL: 'http://127.0.0.1:9', NIGHTGATE_SEED_HEX: '5'.repeat(128), NIGHTGATE_NETWORK: 'preprod',
  NIGHTGATE_SWAP_STATE_FILE: stateFile, NIGHTGATE_SWAP_MAX_INPUTS: '4',
};
const connect = async (config) => {
  const server = buildServer(config);
  const client = new Client({ name: 'integration-swap', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args }).catch((err) => ({ isError: true, content: [{ type: 'text', text: String(err) }] }));
    const text = r.content?.[0]?.text ?? '';
    let value; try { value = JSON.parse(text); } catch { value = text; }
    return { isError: r.isError === true, value, text };
  };
  return { call, close: async () => { await client.close(); await server.close(); } };
};

try {
  const mcp = await connect(loadConfig(env));

  // The wallet, its coins, and the state on disk.
  let w = await mcp.call('get_swap_wallet');
  if (w.isError || w.value.synced !== true) fail(`get_swap_wallet: ${w.text.slice(0, 300)}`);
  const wantTokens = [
    { tokenType: A, balance: '1000', coins: 2, spendable: '1000' },
    { tokenType: B, balance: '900', coins: 1, spendable: '900' },
  ];
  if (!same(w.value.tokens, wantTokens)) fail(`get_swap_wallet tokens: ${JSON.stringify(w.value.tokens)}`);
  if (w.value.maxInputs !== 4 || w.value.address !== wallet.address || w.value.pendingHalves.length !== 0) fail(`get_swap_wallet: ${w.text.slice(0, 300)}`);
  const opened = calls.created[0];
  if (opened.seedHex !== env.NIGHTGATE_SEED_HEX || opened.networkId !== 'preprod' || opened.maxInputs !== 4 || opened.walletState !== undefined
    || !/indexer\.preprod\.midnight\.network/.test(opened.indexerHttpUrl) || opened.provingMode !== undefined) {
    fail(`createSwapWallet input: ${JSON.stringify({ ...opened, seedHex: '…' })}`);
  }
  if ((await readFile(stateFile, 'utf8')) !== 'state-after-0-halves') fail('the wallet state was not written after the sync');
  console.log('OK: get_swap_wallet lists balance, coins and spendable per token type, state saved after the sync');

  // An offer of this wallet.
  const built = await mcp.call('build_swap_offer', { give: { tokenType: A.toUpperCase(), amount: '1000' }, want: { tokenType: B, amount: 300 } });
  if (built.isError) fail(`build_swap_offer: ${built.text.slice(0, 300)}`);
  if (!/^[0-9a-f]{32}$/.test(built.value.id) || !built.value.offer?.startsWith(OFFER) || built.value.bound !== true) fail(`build_swap_offer: ${built.text.slice(0, 300)}`);
  if (!same(built.value.terms, { gives: { tokenType: A, amount: '1000' }, wants: { tokenType: B, amount: '300' }, inputs: 1, outputs: 2 })) fail(`build_swap_offer terms: ${JSON.stringify(built.value.terms)}`);
  if (!same(calls.built[0], { give: { tokenType: A, amount: '1000' }, want: { tokenType: B, amount: '300' }, bind: true })) fail(`buildHalf input: ${JSON.stringify(calls.built[0])}`);
  if ((await readFile(stateFile, 'utf8')) !== 'state-after-1-halves') fail('the wallet state was not written after the build');
  console.log('OK: build_swap_offer returns the offer file, its id and the terms as decimal strings');

  const read = await mcp.call('read_swap_offer', { offer: built.value.offer });
  if (read.isError || read.value.bound !== true || read.value.gives.amount !== '1000' || read.value.wants.tokenType !== B || read.value.serializedBytes !== 15477) fail(`read_swap_offer: ${read.text.slice(0, 300)}`);
  const unreadable = await mcp.call('read_swap_offer', { offer: 'A'.repeat(40) });
  if (!unreadable.isError) fail('read_swap_offer accepted text that is no offer');
  console.log('OK: read_swap_offer reads the terms from the transaction');

  // Taking an offer: other terms than expected stop it before anything is sent.
  const wrong = await mcp.call('take_swap_offer', {
    offer: OFFER, sponsorSessionId: POOL,
    expect: { gives: { tokenType: A, amount: '999' }, wants: { tokenType: B, amount: '300' } },
  });
  if (!wrong.isError || !/not what was expected/.test(wrong.text) || calls.posts.length !== 0) fail(`take_swap_offer took an offer with other terms: ${wrong.text.slice(0, 300)}`);

  // A refusal keeps the proven half, under its id.
  const expect = { gives: { tokenType: A, amount: '1000' }, wants: { tokenType: B, amount: '300' } };
  const refused = await mcp.call('take_swap_offer', { offer: OFFER, expect, sponsorSessionId: POOL, idempotencyKey: 'k1' });
  if (!refused.isError || refused.value.code !== 'SPONSOR_POLICY_EMPTY' || refused.value.httpStatus !== 503 || !/^[0-9a-f]{32}$/.test(refused.value.halfId ?? '')) {
    fail(`take_swap_offer refusal: ${refused.text.slice(0, 300)}`);
  }
  const takenId = refused.value.halfId;
  const sent = calls.posts[0].body;
  if (sent.makerHalfB64 !== Buffer.from(OFFER).toString('base64') || !sent.takerHalfB64 || sent.sponsorSessionId !== POOL || sent.idempotencyKey !== 'k1') fail(`sponsorSwap body: ${JSON.stringify(sent).slice(0, 300)}`);
  w = await mcp.call('get_swap_wallet');
  if (!same(w.value.pendingHalves.map((p) => [p.id, p.role, p.jobId]), [[built.value.id, 'maker', undefined], [takenId, 'taker', undefined]])) fail(`pending halves after the refusal: ${JSON.stringify(w.value.pendingHalves)}`);
  console.log('OK: take_swap_offer compares the terms, a refused swap keeps its half under halfId');

  // The held half goes out again by id.
  const makerOnly = await mcp.call('sponsor_swap', { halfId: built.value.id, sponsorSessionId: POOL });
  if (!makerOnly.isError || !/an offer built here, not a taken one/.test(makerOnly.text)) fail(`sponsor_swap sent an offer without its taker: ${makerOnly.text.slice(0, 300)}`);
  const job = await mcp.call('sponsor_swap', { halfId: takenId, sponsorSessionId: POOL });
  if (job.isError || job.value.jobId !== JOB) fail(`sponsor_swap by id: ${job.text.slice(0, 300)}`);
  const again = calls.posts.at(-1).body;
  if (again.makerHalfB64 !== sent.makerHalfB64 || again.takerHalfB64 !== sent.takerHalfB64) fail('sponsor_swap by id sent other halves than the taken ones');
  w = await mcp.call('get_swap_wallet');
  if (w.value.pendingHalves.find((p) => p.id === takenId)?.jobId !== JOB) fail(`the job is not on its half: ${JSON.stringify(w.value.pendingHalves)}`);

  // A running or failed job keeps the half, a landed one releases it.
  await mcp.call('get_job_status', { jobId: JOB, sessionId: POOL });
  jobStatus = 'failed';
  await mcp.call('get_job_status', { jobId: JOB, sessionId: POOL });
  w = await mcp.call('get_swap_wallet');
  if (w.value.pendingHalves.length !== 2) fail('a failed job released its half: it could no longer be reverted');
  jobStatus = 'succeeded';
  await mcp.call('get_job_status', { jobId: JOB, sessionId: POOL });
  w = await mcp.call('get_swap_wallet');
  if (!same(w.value.pendingHalves.map((p) => p.id), [built.value.id])) fail(`pending halves after the swap landed: ${JSON.stringify(w.value.pendingHalves)}`);
  console.log('OK: sponsor_swap by halfId, the half leaves the list when its job has succeeded');

  // Both halves passed in, as they arrive from elsewhere.
  const direct = await mcp.call('sponsor_swap', { makerHalf: built.value.offer, takerHalf: 'B'.repeat(64), sponsorSessionId: POOL, halfId: built.value.id });
  if (direct.isError) fail(`sponsor_swap with both halves: ${direct.text.slice(0, 300)}`);
  if (calls.posts.at(-1).body.makerHalfB64 !== built.value.offer) fail('sponsor_swap did not pass the offer file through');

  // Reverting releases the coins once.
  const reverted = await mcp.call('revert_swap_offer', { id: built.value.id });
  if (reverted.isError || !same(calls.reverted, [1])) fail(`revert_swap_offer: ${reverted.text.slice(0, 300)} ${JSON.stringify(calls.reverted)}`);
  const twice = await mcp.call('revert_swap_offer', { id: built.value.id });
  if (!twice.isError) fail('revert_swap_offer reverted the same half twice');
  console.log('OK: revert_swap_offer releases a half once');

  // A restart resumes from the state file.
  await closeSwapWallet();
  if (calls.closed !== 1) fail('the swap wallet was not closed');
  w = await mcp.call('get_swap_wallet');
  if (w.isError || w.value.resumedFromState !== true || calls.created[1]?.walletState !== `state-after-${halfCount}-halves`) fail(`resume: ${w.text.slice(0, 300)}`);
  console.log('OK: a new wallet resumes from NIGHTGATE_SWAP_STATE_FILE');
  await mcp.close();

  // A proof server is used when one is configured; no seed, no swaps.
  await closeSwapWallet();
  const withServer = await connect(loadConfig({ ...env, NIGHTGATE_SWAP_STATE_FILE: '', NIGHTGATE_PROOF_SERVER_URL: 'http://127.0.0.1:6300' }));
  await withServer.call('get_swap_wallet');
  const last = calls.created.at(-1);
  if (last.provingMode !== 'server' || last.proofServerUrl !== 'http://127.0.0.1:6300' || last.walletState !== undefined) fail(`proof server config: ${JSON.stringify({ ...last, seedHex: '…' })}`);
  await withServer.close();
  await closeSwapWallet();
  const noSeed = await connect(loadConfig({ ...env, NIGHTGATE_SEED_HEX: '' }));
  const refusedSeed = await noSeed.call('build_swap_offer', { give: { tokenType: A, amount: '1' }, want: { tokenType: B, amount: '1' } });
  if (!refusedSeed.isError || !/NIGHTGATE_SEED_HEX/.test(refusedSeed.text)) fail(`build_swap_offer without a seed: ${refusedSeed.text.slice(0, 300)}`);
  await noSeed.close();
  console.log('OK: proof server from NIGHTGATE_PROOF_SERVER_URL, swaps need NIGHTGATE_SEED_HEX');
} finally {
  await closeSwapWallet();
  await rm(dir, { recursive: true, force: true });
}
console.log('integration-swap: all checks passed');
