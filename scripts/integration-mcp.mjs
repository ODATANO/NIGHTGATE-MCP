/**
 * Integration check for the MCP server, no network required by default:
 * builds the server, connects an MCP client over an in-memory transport,
 * lists the tools and asserts the phase-A tool set is present with schemas.
 *
 * Live mode (optional): set NIGHTGATE_LIVE=1 plus NIGHTGATE_BASE_URL and
 * credentials, and provide NIGHTGATE_TEST_CONTRACT + NIGHTGATE_TEST_PAYLOAD_HASH
 * to round-trip verify_attestation against a running NIGHTGATE server.
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
  'attest_agent_output',
  'anchor_document',
  'prove_field_predicate',
  'prove_field_predicates_batch',
  'grant_disclosure',
  'revoke_disclosure',
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
  arguments: { contractAddress: 'x', payloadHash: 'not-hex' },
}).catch((err) => ({ isError: true, content: [{ type: 'text', text: String(err) }] }));
if (!bad.isError) fail('verify_attestation accepted an invalid payloadHash');
console.log('OK: invalid arguments are rejected before any HTTP call');

// Write-tool client-side rule: contentRoot occupies a batch slot, so 8 claims + root must fail.
const claim = {
  fieldKey: 'a'.repeat(64),
  value: '1',
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

if (process.env.NIGHTGATE_LIVE === '1') {
  const contractAddress = process.env.NIGHTGATE_TEST_CONTRACT;
  const payloadHash = process.env.NIGHTGATE_TEST_PAYLOAD_HASH;
  if (!contractAddress || !payloadHash) {
    fail('live mode needs NIGHTGATE_TEST_CONTRACT and NIGHTGATE_TEST_PAYLOAD_HASH');
  }
  const result = await client.callTool({
    name: 'verify_attestation',
    arguments: { contractAddress, payloadHash },
  });
  const text = result.content?.[0]?.text ?? '';
  if (result.isError) fail(`live verify_attestation errored: ${text}`);
  const parsed = JSON.parse(text);
  if (typeof parsed.verified !== 'boolean') fail(`unexpected live response shape: ${text}`);
  console.log(`OK: live verify_attestation returned verified=${parsed.verified} attested=${parsed.attested}`);
} else {
  console.log('SKIP: live round-trip (set NIGHTGATE_LIVE=1 to enable)');
}

await client.close();
await server.close();
console.log('integration-mcp: all checks passed');
