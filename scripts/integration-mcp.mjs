/**
 * Integration check for the MCP server, no network required by default:
 * builds the server, connects an MCP client over an in-memory transport,
 * lists the tools and asserts the tool set is present with schemas.
 *
 * Live mode (optional): set NIGHTGATE_LIVE=1 plus ODATANO_ACCESS_URL and
 * credentials, and provide NIGHTGATE_TEST_CONTRACT + NIGHTGATE_TEST_ATTESTER_ID +
 * NIGHTGATE_TEST_PAYLOAD_HASH to round-trip verify_attestation against a
 * running NIGHTGATE server.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../dist/server.js';
import { loadConfig } from '../dist/config.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EXPECTED_TOOLS = [
  'verify_attestation',
  'verify_predicate',
  'prepare_document_proof',
  'prepare_membership_set',
  'anchor_document',
  'submit_vault_call',
  'build_sponsorable_transaction',
  'get_attester_identity',
  'sponsor_finalized_transaction',
  'sponsor_unbound_transaction',
  'derive_token_type',
  'get_swap_wallet',
  'read_swap_offer',
  'build_swap_offer',
  'take_swap_offer',
  'revert_swap_offer',
  'sponsor_swap',
  'post_swap_offer',
  'list_swap_offers',
  'my_swap_offers',
  'get_swap_offer',
  'get_board_status',
  'retire_swap_offer',
  'mint_token',
  'get_usage',
];
// No tool takes a server wallet session any more.
const GONE_TOOLS = ['get_job_status', 'verify_document', 'attest_agent_output', 'prove_field_predicate', 'grant_disclosure', 'claim_disclosure'];

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

// a build tool that runs here must not leave a seed in the home directory
process.env.NIGHTGATE_SEED_FILE ??= join(mkdtempSync(join(tmpdir(), 'nightgate-mcp-it-')), 'seed');
const config = loadConfig();
const server = buildServer(config);
const client = new Client({ name: 'integration-check', version: '0.0.0' });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
for (const expected of EXPECTED_TOOLS) {
  if (!names.includes(expected)) fail(`missing tool: ${expected} (got: ${names.join(', ')})`);
}
for (const gone of GONE_TOOLS) {
  if (names.includes(gone)) fail(`tool ${gone} is still registered`);
}
for (const tool of tools) {
  if (/sessionId/.test(JSON.stringify(tool.inputSchema))) fail(`tool ${tool.name} still takes a sessionId`);
  if (!tool.description || tool.description.length < 20) fail(`tool ${tool.name} has no useful description`);
  if (!tool.inputSchema || tool.inputSchema.type !== 'object') fail(`tool ${tool.name} has no input schema`);
}
console.log(`OK: ${names.length} tools registered: ${names.join(', ')}`);

// Schema-validation path: a bad argument must be rejected client-side/server-side,
// not forwarded to NIGHTGATE.
const bad = await client.callTool({
  name: 'verify_attestation',
  arguments: { contractAddress: 'x', attesterId: 'a'.repeat(64), payloadHash: 'not-hex' },
}).catch((err) => ({ isError: true, content: [{ type: 'text', text: String(err) }] }));
if (!bad.isError) fail('verify_attestation accepted an invalid payloadHash');
console.log('OK: invalid arguments are rejected before any HTTP call');

// A record is named by attester + payload, or by a bound document id.
const unnamed = await client.callTool({
  name: 'verify_attestation',
  arguments: { payloadHash: 'f'.repeat(64) },
}).catch((err) => ({ isError: true, content: [{ type: 'text', text: String(err) }] }));
if (!unnamed.isError || !/attesterId \+ payloadHash, or documentId/.test(JSON.stringify(unnamed.content))) {
  fail('verify_attestation accepted a payloadHash without its attester');
}
console.log('OK: verify_attestation needs attesterId + payloadHash or a documentId');

// One-call writes check their arguments before anything is built.
const call = (name, args) => client.callTool({ name, arguments: args })
  .catch((err) => ({ isError: true, content: [{ type: 'text', text: String(err) }] }));
const rootOnly = await call('anchor_document', { sha256: 'f'.repeat(64), contentRoot: 'a'.repeat(64) });
if (!rootOnly.isError || !/contentRoot and schemaId together/.test(JSON.stringify(rootOnly.content))) fail('anchor_document accepted contentRoot without schemaId');
const unknownCall = await call('submit_vault_call', { call: 'issueFieldPredicateAttestation', params: {} });
if (!unknownCall.isError) fail('submit_vault_call accepted a call that is not a vault circuit');
const badVault = await call('anchor_document', { sha256: 'f'.repeat(64), contractAddress: 'x' });
if (!badVault.isError) fail('anchor_document accepted a contract address that is not 64 hex');
const smallVault = await call('anchor_document', { sha256: 'f'.repeat(64), compiledArtifactRef: 'attestation-vault' });
if (!smallVault.isError || !/sandbox vaults are attestation-vault-32/.test(JSON.stringify(smallVault.content))) fail('a 16-slot anchor without an address fell back to the 32-slot sandbox');
console.log('OK: anchor_document and submit_vault_call validate before building');

if (!config.token && !config.username) {
  const usage = await call('get_usage', {});
  if (!usage.isError || !/ODATANO_ACCESS_KEY/.test(JSON.stringify(usage.content))) fail('get_usage without a key does not name ODATANO_ACCESS_KEY');
  console.log('OK: get_usage without a key says which variable to set');
}

const badVerifyKind = await client.callTool({
  name: 'verify_predicate',
  arguments: {
    attesterId: 'a'.repeat(64), payloadHash: 'f'.repeat(64),
    predicate: 'setMembership', fieldKey: 'a'.repeat(64),
  },
}).catch((err) => ({ isError: true, content: [{ type: 'text', text: String(err) }] }));
if (!badVerifyKind.isError) fail('verify_predicate accepted setMembership without setRoot');
console.log('OK: verify_predicate per-kind coordinate rules enforced client-side');

if (process.env.NIGHTGATE_LIVE === '1') {
  const contractAddress = process.env.NIGHTGATE_TEST_CONTRACT;
  const attesterId = process.env.NIGHTGATE_TEST_ATTESTER_ID;
  const payloadHash = process.env.NIGHTGATE_TEST_PAYLOAD_HASH;
  if (!contractAddress || !attesterId || !payloadHash) {
    fail('live mode needs NIGHTGATE_TEST_CONTRACT, NIGHTGATE_TEST_ATTESTER_ID and NIGHTGATE_TEST_PAYLOAD_HASH');
  }
  const result = await client.callTool({
    name: 'verify_attestation',
    arguments: { contractAddress, attesterId, payloadHash },
  });
  const text = result.content?.[0]?.text ?? '';
  if (result.isError) fail(`live verify_attestation errored: ${text}`);
  const parsed = JSON.parse(text);
  if (typeof parsed.verified !== 'boolean') fail(`unexpected live response shape: ${text}`);
  console.log(`OK: live verify_attestation returned verified=${parsed.verified} attested=${parsed.attested}`);
} else {
  console.log('SKIP: live round-trip (set NIGHTGATE_LIVE=1 to enable)');
}

// Swaps: the argument rules hold before a wallet is opened or a request is sent.
const swapCall = (name, args) => client.callTool({ name, arguments: args })
  .catch((err) => ({ isError: true, content: [{ type: 'text', text: String(err) }] }));
const said = (r, re) => r.isError && re.test(JSON.stringify(r.content ?? r));
const legA = { tokenType: 'a'.repeat(64), amount: '1000' };
const legB = { tokenType: 'b'.repeat(64), amount: '300' };

const zeroAmount = await swapCall('build_swap_offer', { give: { ...legA, amount: '0' }, want: legB });
if (!said(zeroAmount, /positive integer/)) fail(`build_swap_offer accepted an amount of 0: ${JSON.stringify(zeroAmount).slice(0, 200)}`);
const shortType = await swapCall('build_swap_offer', { give: { tokenType: 'abc', amount: '1' }, want: legB });
if (!shortType.isError) fail('build_swap_offer accepted a token type that is not 64 hex');
console.log('OK: swap legs need a 64-hex token type and a positive amount');

const oneHalf = await swapCall('sponsor_swap', { makerHalf: 'A'.repeat(64) });
if (!said(oneHalf, /makerHalf AND takerHalf, or halfId alone/)) fail(`sponsor_swap accepted one half: ${JSON.stringify(oneHalf).slice(0, 200)}`);
const noHalf = await swapCall('sponsor_swap', {});
if (!said(noHalf, /makerHalf and takerHalf, or the halfId/)) fail(`sponsor_swap accepted a call without halves: ${JSON.stringify(noHalf).slice(0, 200)}`);
const offerNoTaker = await swapCall('sponsor_swap', { offerId: '00000000-0000-4000-8000-000000000001' });
if (!said(offerNoTaker, /offerId needs takerHalf/)) fail(`sponsor_swap accepted an offerId without the taker half: ${JSON.stringify(offerNoTaker).slice(0, 200)}`);
const unknownHalf = await swapCall('sponsor_swap', { halfId: '0'.repeat(32) });
if (!said(unknownHalf, /no half with id 0{32} is held/)) fail(`sponsor_swap accepted an id it does not hold: ${JSON.stringify(unknownHalf).slice(0, 200)}`);
const offerUnknownHalf = await swapCall('sponsor_swap', { offerId: '00000000-0000-4000-8000-000000000001', halfId: '0'.repeat(32) });
if (!said(offerUnknownHalf, /no half with id 0{32} is held/)) fail(`sponsor_swap with offerId did not look up the half id: ${JSON.stringify(offerUnknownHalf).slice(0, 200)}`);
const unknownRevert = await swapCall('revert_swap_offer', { id: '0'.repeat(32) });
if (!said(unknownRevert, /no half with id 0{32}/)) fail(`revert_swap_offer accepted an id it does not hold: ${JSON.stringify(unknownRevert).slice(0, 200)}`);
console.log('OK: sponsor_swap takes both halves, a held half id, or a board offer plus the taker half; revert_swap_offer a held id');

const badStatus = await swapCall('list_swap_offers', { status: 'closed' });
if (!said(badStatus, /status/)) fail(`list_swap_offers accepted an unknown status: ${JSON.stringify(badStatus).slice(0, 200)}`);
const badSince = await swapCall('my_swap_offers', { since: 'yesterday' });
if (!said(badSince, /since/)) fail(`my_swap_offers accepted a non-ISO since: ${JSON.stringify(badSince).slice(0, 200)}`);
const badOfferId = await swapCall('get_swap_offer', { offerId: 'not-a-uuid' });
if (!said(badOfferId, /offerId/)) fail(`get_swap_offer accepted a non-uuid id: ${JSON.stringify(badOfferId).slice(0, 200)}`);
const mintArgs = { contractAddress: 'c'.repeat(64), name: 'CREDIT', amount: '1000', recipientCoinPublicKey: 'd'.repeat(64) };
const longName = await swapCall('mint_token', { ...mintArgs, name: 'x'.repeat(33) });
if (!said(longName, /32 UTF-8 bytes/)) fail(`mint_token accepted a 33-byte name: ${JSON.stringify(longName).slice(0, 200)}`);
const wideName = await swapCall('mint_token', { ...mintArgs, name: '\u20ac'.repeat(11) });
if (!said(wideName, /32 UTF-8 bytes/)) fail(`mint_token counted characters, not bytes: ${JSON.stringify(wideName).slice(0, 200)}`);
const zeroMint = await swapCall('mint_token', { ...mintArgs, amount: '0' });
if (!said(zeroMint, /positive integer/)) fail(`mint_token accepted amount 0: ${JSON.stringify(zeroMint).slice(0, 200)}`);
const shortKey = await swapCall('mint_token', { ...mintArgs, recipientCoinPublicKey: 'abc' });
if (!said(shortKey, /recipientCoinPublicKey/)) fail(`mint_token accepted a short recipient key: ${JSON.stringify(shortKey).slice(0, 200)}`);
// Local way: a foreign recipient needs both keys; without a seed the issuer is missing. Both refuse before any build.
const foreignNoEnc = await swapCall('mint_token', mintArgs);
if (!said(foreignNoEnc, /recipientEncryptionPublicKey|NIGHTGATE_SEED_HEX|nightgate-tx/)) fail(`mint_token built for a foreign recipient without its encryption key: ${JSON.stringify(foreignNoEnc).slice(0, 200)}`);
console.log('OK: mint_token checks name, amount, recipient keys before any call');
const hugeMint = await swapCall('mint_token', { ...mintArgs, amount: 1e21 });
if (!hugeMint.isError) fail('mint_token accepted a number above 2^53 (String() would render it as 1e+21)');
console.log('OK: list_swap_offers, my_swap_offers and get_swap_offer validate status, since and offerId; mint_token name, amount and recipient key');

const notAnOffer = await swapCall('read_swap_offer', { offer: 'swapoffer1' + 'q'.repeat(40) });
if (!notAnOffer.isError) fail('read_swap_offer accepted text that is no offer');
console.log(`OK: read_swap_offer refuses text that is no offer (${JSON.stringify(notAnOffer.content?.[0]?.text ?? '').slice(0, 110)})`);

await client.close();
await server.close();
console.log('integration-mcp: all checks passed');
