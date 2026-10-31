// Inputs and outputs: circuit arguments, configuration, OData literals and the masking of secrets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coerceArgs, witnessesAt } from '../../dist/contract-call.js';
import { builderChainOptions, loadConfig } from '../../dist/config.js';
import { odataLiteral } from '../../dist/client.js';
import { redact } from '../../dist/tools.js';

test('coerceArgs turns tagged values and records what the wallet pays', () => {
  const coins = [];
  const night = [];
  const out = coerceArgs([{ $uint: '18446744073709551615' }, { $night: '10000000' }, 7, { $bytes: '0xab' }, { $coin: { tokenType: 'aa'.repeat(32), amount: '5' } }], coins, night);
  assert.equal(out[0], 18446744073709551615n);
  assert.equal(out[1], 10000000n);
  assert.equal(out[2], 7n);
  assert.deepEqual([...out[3]], [0xab]);
  assert.equal(out[4].value, 5n);
  assert.deepEqual(night, ['10000000']);
  assert.deepEqual(coins, [{ tokenType: 'aa'.repeat(32), amount: '5' }]);
});

test('coerceArgs refuses rounded numbers, empty NIGHT and deep nesting', () => {
  assert.throws(() => coerceArgs([9007199254740993], []), /below 2\^53.*\$uint/);
  assert.throws(() => coerceArgs([1.5], []), /below 2\^53/);
  assert.throws(() => coerceArgs([{ $night: '0' }], []), /positive integer/);
  let deep = 1;
  for (let i = 0; i < 20; i++) deep = [deep];
  assert.throws(() => coerceArgs([deep], []), /nested deeper/);
});

test('credentials never go to a plain http host off this machine', () => {
  assert.throws(() => loadConfig({ ODATANO_ACCESS_URL: 'http://api.example.org', ODATANO_ACCESS_KEY: 'oda_x' }), /plain http/);
  assert.throws(() => loadConfig({ ODATANO_ACCESS_URL: 'http://10.0.0.2:4016', ODATANO_ACCESS_USER: 'u' }), /plain http/);
  assert.equal(loadConfig({ ODATANO_ACCESS_URL: 'http://127.0.0.1:4016', ODATANO_ACCESS_USER: 'u' }).baseUrl, 'http://127.0.0.1:4016');
  assert.equal(loadConfig({ ODATANO_ACCESS_URL: 'http://localhost:4004', ODATANO_ACCESS_KEY: 'oda_x' }).baseUrl, 'http://localhost:4004');
  assert.equal(loadConfig({ ODATANO_ACCESS_URL: 'http://10.0.0.2', ODATANO_ACCESS_KEY: 'oda_x', NIGHTGATE_ALLOW_PLAIN_HTTP: '1' }).baseUrl, 'http://10.0.0.2');
  assert.equal(loadConfig({ ODATANO_ACCESS_URL: 'http://api.example.org' }).baseUrl, 'http://api.example.org');
});

test('NIGHTGATE_CALL_PACKAGES is a comma list, unset by default', () => {
  assert.equal(loadConfig({}).callPackages, undefined);
  assert.deepEqual(loadConfig({ NIGHTGATE_CALL_PACKAGES: ' @a/contract-x, b ' }).callPackages, ['@a/contract-x', 'b']);
});

test('a builder never falls back to a retired node host', () => {
  const indexer = { NIGHTGATE_INDEXER_HTTP_URL: 'https://ix/api/v4/graphql', NIGHTGATE_INDEXER_WS_URL: 'wss://ix/api/v4/graphql/ws' };
  const own = builderChainOptions(loadConfig({ ...indexer, NIGHTGATE_NODE_URL: 'wss://node' }));
  assert.equal(own.nodeUrl, 'wss://node');
  const noNode = builderChainOptions(loadConfig(indexer));
  assert.equal(noNode.nodeUrl, undefined);
  assert.ok(noNode.api);
  assert.equal(noNode.walletSync, false);
  const sync = builderChainOptions(loadConfig({ ODATANO_ACCESS_KEY: 'oda_x' }), { walletSync: 'coins', indexer: { indexerHttpUrl: 'h', indexerWsUrl: 'w' } });
  assert.equal(sync.walletSync, 'coins');
  assert.equal(sync.indexerHttpUrl, 'h');
  assert.ok(sync.api);
});

test('OData string literals are quoted, escaped and percent-encoded', () => {
  assert.equal(odataLiteral("a'b"), "'a''b'");
  assert.equal(odataLiteral('x#y?z&w%'), "'x%23y%3Fz%26w%25'");
  assert.equal(odataLiteral(3), '3');
  assert.equal(odataLiteral({ $raw: 'abc' }), 'abc');
});

test('redact masks keys and project ids, not short prefixes', () => {
  assert.equal(redact('wss://x/ws?project_id=nightpreprodABCDEFGH12345678'), 'wss://x/ws?project_id=<redacted>');
  assert.equal(redact('https://h/api/v4/graphql?token=abc123&apikey=def456'), 'https://h/api/v4/graphql?token=<redacted>&apikey=<redacted>');
  assert.equal(redact('key oda_0123456789abcdef0123 used'), 'key oda_<redacted> used');
  assert.equal(redact('prefix oda_3d30b76f'), 'prefix oda_3d30b76f');
  assert.equal(redact('ngat_abcdefghijklmnopqrstu'), 'ngat_<redacted>');
  assert.equal(redact('https://h/indexer?key=oda_secret&x=1'), 'https://h/indexer?key=<redacted>&x=1');
});

test('witnesses come from the module contract.json names, with a secret per seed and package', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-witness-'));
  writeFileSync(join(root, 'contract.json'), JSON.stringify({ name: 'pot', witnesses: 'witnesses.mjs' }));
  writeFileSync(join(root, 'witnesses.mjs'), 'export function createWitnesses({ secret, network, contractAddress }) {\n' +
    '  return { witnesses: { secretKey: (ctx) => [ctx.privateState, secret] }, privateState: { network, contractAddress, n: secret.length } };\n}\n');
  const config = { seedHex: '11'.repeat(64), network: 'preprod' };
  const a = await witnessesAt(root, '@x/contract-pot', config, 'cc'.repeat(32));
  const b = await witnessesAt(root, '@x/contract-pot', config, 'cc'.repeat(32));
  const other = await witnessesAt(root, '@x/contract-other', config, 'cc'.repeat(32));
  assert.equal(typeof a.witnesses.secretKey, 'function');
  assert.deepEqual(a.privateState, { network: 'preprod', contractAddress: 'cc'.repeat(32), n: 32 });
  const secretOf = (w) => w.witnesses.secretKey({ privateState: null })[1];
  assert.deepEqual(secretOf(a), secretOf(b));
  assert.notDeepEqual(secretOf(a), secretOf(other));
  assert.notEqual(Buffer.from(secretOf(a)).toString('hex'), config.seedHex.slice(0, 64));
});

test('a package without a witnesses module has none; one pointing outside is refused', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-witness-'));
  writeFileSync(join(root, 'contract.json'), JSON.stringify({ name: 'plain' }));
  assert.equal(await witnessesAt(root, 'plain', { seedHex: '11'.repeat(64), network: 'preview' }, 'cc'.repeat(32)), undefined);
  writeFileSync(join(root, 'contract.json'), JSON.stringify({ name: 'bad', witnesses: '../elsewhere.mjs' }));
  await assert.rejects(witnessesAt(root, 'bad', { seedHex: '11'.repeat(64), network: 'preview' }, 'cc'.repeat(32)), /inside the package/);
});

test('a private state keeps bytes and big integers through its file form', async () => {
  const { encodeState, decodeState } = await import('../../dist/contract-call.js');
  const state = { key: new Uint8Array([1, 2, 255]), round: 2n ** 70n, list: [1n, 'x', { inner: new Uint8Array(0) }], flag: true, none: null };
  const text = JSON.stringify(encodeState(state));
  assert.deepEqual(decodeState(JSON.parse(text)), state);
  assert.throws(() => encodeState({ when: new Date(0) }), /Date value, which is not saved/);
});

test('the analytics URL may not take credentials over plain http either', () => {
  assert.throws(() => loadConfig({ ODATANO_ACCESS_KEY: 'oda_x', ODATANO_ANALYTICS_URL: 'http://astra.example.org/odata' }), /ODATANO_ANALYTICS_URL .* plain http/);
  assert.equal(loadConfig({ ODATANO_ACCESS_KEY: 'oda_x', ODATANO_ANALYTICS_URL: 'http://127.0.0.1:4005/odata' }).analyticsUrl, 'http://127.0.0.1:4005/odata');
});

test('wrapped witnesses keep class methods and report the last private state', async () => {
  const { trackWitnesses } = await import('../../dist/contract-call.js');
  class Pot { constructor() { this.secret = 7; } secretKey(ctx) { return [{ ...ctx.privateState, used: true }, this.secret]; } }
  let seen;
  const w = trackWitnesses(new Pot(), (s) => { seen = s; });
  assert.deepEqual(w.secretKey({ privateState: { n: 1 } }), [{ n: 1, used: true }, 7]);
  assert.deepEqual(seen, { n: 1, used: true });
  assert.equal(w.secret, 7);
});
