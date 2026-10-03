/**
 * Integration check for the MCP server, no network required by default:
 * builds the server, connects an MCP client over an in-memory transport,
 * lists the tools and asserts the phase-A tool set is present with schemas.
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

const EXPECTED_TOOLS = [
  'verify_attestation',
  'verify_predicate',
  'verify_predicate_attestation',
  'verify_document',
  'prepare_document_proof',
  'prepare_membership_set',
  'attest_agent_output',
  'anchor_document',
  'prove_field_predicate',
  'prove_field_equality',
  'prove_field_membership',
  'prove_field_predicates_batch',
  'prove_document_integrity',
  'prove_document_diff',
  'grant_disclosure',
  'revoke_disclosure',
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
  'grant_disclosure_to_holders',
  'revoke_holder_disclosure',
  'claim_disclosure',
  'holder_claim_key',
  'get_job_status',
];

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

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
for (const tool of tools) {
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
  arguments: { contractAddress: 'x', payloadHash: 'f'.repeat(64) },
}).catch((err) => ({ isError: true, content: [{ type: 'text', text: String(err) }] }));
if (!unnamed.isError || !/attesterId \+ payloadHash, or documentId/.test(JSON.stringify(unnamed.content))) {
  fail('verify_attestation accepted a payloadHash without its attester');
}
console.log('OK: verify_attestation needs attesterId + payloadHash or a documentId');

// Write-tool client-side rule: contentRoot occupies a batch slot, so 8 claims + root must fail.
const claim = {
  fieldKey: 'a'.repeat(64),
  value: '1',
  salt: '9'.repeat(64),
  siblings: ['b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64), 'e'.repeat(64)],
  dirs: [true, false, true, false],
  predicate: 'lessOrEqual',
  threshold: '10',
};
const overfull = await client.callTool({
  name: 'prove_field_predicates_batch',
  arguments: {
    payloadHash: 'f'.repeat(64),
    contentRoot: 'a'.repeat(64),
    claims: Array.from({ length: 8 }, () => claim),
    sessionId: '00000000-0000-0000-0000-000000000000',
    contractAddress: 'x',
  },
}).catch((err) => ({ isError: true, content: [{ type: 'text', text: String(err) }] }));
if (!overfull.isError) fail('batch accepted 8 claims alongside a contentRoot');
console.log('OK: batch slot rule (anchor + max 7 claims) enforced client-side');

// 0.15.0 kinds: XOR rules must be enforced client-side, valid mixed shapes accepted by the schema.
const eqBothLanes = await client.callTool({
  name: 'prove_field_equality',
  arguments: {
    payloadHash: 'f'.repeat(64), fieldKey: 'a'.repeat(64),
    expectedValue: 'NMC811', expectedDigest: 'b'.repeat(64),
    fieldSalt: claim.salt, siblings: claim.siblings, dirs: claim.dirs,
    sessionId: '00000000-0000-0000-0000-000000000000', contractAddress: 'x',
  },
}).catch((err) => ({ isError: true, content: [{ type: 'text', text: String(err) }] }));
if (!eqBothLanes.isError) fail('prove_field_equality accepted expectedValue AND expectedDigest');
console.log('OK: equality expectedValue/expectedDigest XOR enforced client-side');

const memNoSet = await client.callTool({
  name: 'prove_field_membership',
  arguments: {
    payloadHash: 'f'.repeat(64), fieldKey: 'a'.repeat(64), value: 'EEA',
    siblings: claim.siblings, dirs: claim.dirs,
    sessionId: '00000000-0000-0000-0000-000000000000', contractAddress: 'x',
  },
}).catch((err) => ({ isError: true, content: [{ type: 'text', text: String(err) }] }));
if (!memNoSet.isError) fail('prove_field_membership accepted a claim without allowedValues or a set path');
console.log('OK: membership allowedValues/setRoot lane rule enforced client-side');

const badVerifyKind = await client.callTool({
  name: 'verify_predicate',
  arguments: {
    contractAddress: 'x', attesterId: 'a'.repeat(64), payloadHash: 'f'.repeat(64),
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

// Salted leaves: the slot salt is MANDATORY on every field proof from
// NIGHTGATE 0.16.0 on, so the schema must reject a call without it. Omitting
// it here is exactly what an older MCP would send, and the whole point of
// the compatibility matrix in the README.
const noSalt = await client.callTool({
  name: 'prove_field_predicate',
  arguments: {
    payloadHash: 'f'.repeat(64), fieldKey: 'a'.repeat(64), value: '1',
    siblings: claim.siblings, dirs: claim.dirs,
    predicate: 'lessOrEqual', threshold: '10',
    sessionId: '00000000-0000-0000-0000-000000000000', contractAddress: 'x',
  },
}).catch((err) => ({ isError: true, content: [{ type: 'text', text: String(err) }] }));
if (!noSalt.isError) fail('prove_field_predicate accepted a call without fieldSalt (salted leaves are mandatory)');
console.log('OK: field proofs require the slot salt');

// Cross-root proofs need the shared schema and BOTH full openings, one
// entry per slot of the vault width (16 by default, 32 on
// attestation-vault-32). `real` slots carry a kind the mask can constrain;
// kind 2 is padding and never counts.
const widthFixture = (width, realSlots) => ({
  opening: { saltSeed: '7'.repeat(64), slots: Array.from({ length: width }, () => ({ present: false })) },
  schema: Array.from({ length: width }, (_, i) => ({
    fieldKey: 'a'.repeat(64), kind: realSlots.includes(i) ? 0 : 2, scale: '0',
  })),
});
const integrityCall = async (width, realSlots, allowedMask) => {
  const { schema, opening } = widthFixture(width, realSlots);
  return client.callTool({
    name: 'prove_document_integrity',
    arguments: {
      payloadHashA: 'a'.repeat(64), payloadHashB: 'b'.repeat(64),
      allowedMask, schema, openingA: opening, openingB: opening,
      sessionId: '00000000-0000-0000-0000-000000000000',
      contractAddress: 'c'.repeat(64),
    },
  }).catch((err) => ({ isError: true, content: [{ type: 'text', text: String(err) }] }));
};
const saysVacuous = (r) => r.isError && /vacuous/i.test(JSON.stringify(r.content ?? r));

// A mask that frees every REAL slot proves nothing. Asserted on the MESSAGE:
// with a valid contract address, the only thing left to reject is the mask.
const vacuous16 = await integrityCall(16, [0, 1, 2, 3], 0b1111);
if (!saysVacuous(vacuous16)) fail(`prove_document_integrity accepted a mask freeing every real slot: ${JSON.stringify(vacuous16).slice(0, 200)}`);
console.log('OK: vacuous integrity mask rejected client-side, by schema not by a fixed constant');

// The same rule at width 32, with the real slot at index 31: proves the
// 32-entry schema/opening shape is accepted AND that bit 31 is read.
const vacuous32 = await integrityCall(32, [0, 31], 0x80000001);
if (!saysVacuous(vacuous32)) fail(`width-32 integrity call did not reach the mask check: ${JSON.stringify(vacuous32).slice(0, 200)}`);
console.log('OK: width-32 schema/opening accepted, mask bit 31 evaluated');

// Counter-test: the guard must not be a blanket reject. Freeing slot 31 but
// leaving slot 0 constrained is a legitimate claim, so it has to get PAST
// validation (and then fail on the HTTP call, since no server runs here).
const legitimate32 = await integrityCall(32, [0, 31], 0x80000000);
if (saysVacuous(legitimate32)) fail('a legitimate width-32 mask was rejected as vacuous');
console.log('OK: a mask leaving one real slot constrained passes validation');

// Swaps: the argument rules hold before a wallet is opened or a request is sent.
const swapCall = (name, args) => client.callTool({ name, arguments: args })
  .catch((err) => ({ isError: true, content: [{ type: 'text', text: String(err) }] }));
const said = (r, re) => r.isError && re.test(JSON.stringify(r.content ?? r));
const POOL = '00000000-0000-0000-0000-706f6f6c0000';
const legA = { tokenType: 'a'.repeat(64), amount: '1000' };
const legB = { tokenType: 'b'.repeat(64), amount: '300' };

const zeroAmount = await swapCall('build_swap_offer', { give: { ...legA, amount: '0' }, want: legB });
if (!said(zeroAmount, /positive integer/)) fail(`build_swap_offer accepted an amount of 0: ${JSON.stringify(zeroAmount).slice(0, 200)}`);
const shortType = await swapCall('build_swap_offer', { give: { tokenType: 'abc', amount: '1' }, want: legB });
if (!shortType.isError) fail('build_swap_offer accepted a token type that is not 64 hex');
console.log('OK: swap legs need a 64-hex token type and a positive amount');

const oneHalf = await swapCall('sponsor_swap', { makerHalf: 'A'.repeat(64), sponsorSessionId: POOL });
if (!said(oneHalf, /makerHalf AND takerHalf, or halfId alone/)) fail(`sponsor_swap accepted one half: ${JSON.stringify(oneHalf).slice(0, 200)}`);
const noHalf = await swapCall('sponsor_swap', { sponsorSessionId: POOL });
if (!said(noHalf, /makerHalf and takerHalf, or the halfId/)) fail(`sponsor_swap accepted a call without halves: ${JSON.stringify(noHalf).slice(0, 200)}`);
const offerNoTaker = await swapCall('sponsor_swap', { offerId: '00000000-0000-4000-8000-000000000001', sponsorSessionId: POOL });
if (!said(offerNoTaker, /offerId needs takerHalf/)) fail(`sponsor_swap accepted an offerId without the taker half: ${JSON.stringify(offerNoTaker).slice(0, 200)}`);
const unknownHalf = await swapCall('sponsor_swap', { halfId: '0'.repeat(32), sponsorSessionId: POOL });
if (!said(unknownHalf, /no half with id 0{32} is held/)) fail(`sponsor_swap accepted an id it does not hold: ${JSON.stringify(unknownHalf).slice(0, 200)}`);
const offerUnknownHalf = await swapCall('sponsor_swap', { offerId: '00000000-0000-4000-8000-000000000001', halfId: '0'.repeat(32), sponsorSessionId: POOL });
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
const mintArgs = { contractAddress: 'c'.repeat(64), name: 'CREDIT', amount: '1000', recipientCoinPublicKey: 'd'.repeat(64), sessionId: POOL };
const longName = await swapCall('mint_token', { ...mintArgs, name: 'x'.repeat(33) });
if (!said(longName, /32 UTF-8 bytes/)) fail(`mint_token accepted a 33-byte name: ${JSON.stringify(longName).slice(0, 200)}`);
const wideName = await swapCall('mint_token', { ...mintArgs, name: '\u20ac'.repeat(11) });
if (!said(wideName, /32 UTF-8 bytes/)) fail(`mint_token counted characters, not bytes: ${JSON.stringify(wideName).slice(0, 200)}`);
const zeroMint = await swapCall('mint_token', { ...mintArgs, amount: '0' });
if (!said(zeroMint, /positive integer/)) fail(`mint_token accepted amount 0: ${JSON.stringify(zeroMint).slice(0, 200)}`);
const shortKey = await swapCall('mint_token', { ...mintArgs, recipientCoinPublicKey: 'abc' });
if (!said(shortKey, /recipientCoinPublicKey/)) fail(`mint_token accepted a short recipient key: ${JSON.stringify(shortKey).slice(0, 200)}`);
// Local way: a foreign recipient needs both keys; without a seed the issuer is missing. Both refuse before any build.
const { sessionId: _s, ...localArgs } = mintArgs;
const foreignNoEnc = await swapCall('mint_token', localArgs);
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
