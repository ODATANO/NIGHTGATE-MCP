#!/usr/bin/env node
/**
 * Smoke test of the REAL deployment shape: spawn `dist/index.js` as a stdio
 * MCP server and talk to it over the wire, the way Claude Desktop or Claude
 * Code does. The other lanes embed the server in-process, which exercises
 * the tool logic but never the transport, the env handover or the binary's
 * own startup.
 *
 * Reads .env like the other lanes. Run: npm run live:stdio
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(root, 'dist', 'index.js');
const fail = (m) => { console.error(`FAIL ${m}`); process.exit(1); };

// Hand the child exactly what an MCP client's `env` block would carry.
const pass = [
  'ODATANO_ACCESS_URL', 'ODATANO_ACCESS_KEY', 'ODATANO_ACCESS_USER', 'ODATANO_ACCESS_PASSWORD',
  'NIGHTGATE_NETWORK', 'NIGHTGATE_SEED_HEX', 'NIGHTGATE_TIMEOUT_MS',
  'NIGHTGATE_INDEXER_HTTP_URL', 'NIGHTGATE_INDEXER_WS_URL', 'NIGHTGATE_NODE_URL',
  'NIGHTGATE_ZK_CONFIG_BASE_URL', 'NIGHTGATE_ZK_CACHE_DIR', 'NIGHTGATE_PROOF_SERVER_URL',
];
const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
for (const k of pass) if (process.env[k]) env[k] = process.env[k];

const transport = new StdioClientTransport({ command: process.execPath, args: [entry], env });
const client = new Client({ name: 'stdio-smoke', version: '0' });
await client.connect(transport);
console.log('OK   spawned dist/index.js and completed the MCP handshake');

const { tools } = await client.listTools();
console.log(`OK   ${tools.length} tools discovered over stdio`);
const byName = new Map(tools.map((t) => [t.name, t]));
for (const required of ['verify_attestation', 'build_sponsorable_transaction', 'prove_document_integrity']) {
  if (!byName.has(required)) fail(`tool '${required}' missing from the stdio listing`);
}

// The width-32 surface must be visible to a CLIENT, not just to our tests:
// an agent picks its arguments from the advertised schema alone.
const build = byName.get('build_sponsorable_transaction');
const refs = build?.inputSchema?.properties?.compiledArtifactRef?.enum ?? [];
if (!refs.includes('attestation-vault-32')) {
  fail(`build_sponsorable_transaction does not advertise attestation-vault-32 (got ${JSON.stringify(refs)})`);
}
console.log('OK   build_sponsorable_transaction advertises both vault lineages');

// A real read against the configured server, over the transport.
const VAULT = process.env.NIGHTGATE_VAULT;
if (VAULT && process.env.ODATANO_ACCESS_URL) {
  const r = await client.callTool({
    name: 'verify_attestation',
    arguments: {
      contractAddress: VAULT,
      payloadHash: '0'.repeat(64),
      compiledArtifactRef: process.env.NIGHTGATE_VAULT_ARTIFACT || 'attestation-vault',
    },
  }, undefined, { timeout: 120_000 });
  const text = r.content?.[0]?.text ?? '';
  if (r.isError) fail(`verify_attestation over stdio errored: ${text}`);
  const parsed = JSON.parse(text);
  if (typeof parsed.attested !== 'boolean') fail(`unexpected shape: ${text}`);
  console.log(`OK   live read through the stdio server: attested=${parsed.attested} (an unattested hash, so false is correct)`);
} else {
  console.log('SKIP live read (set ODATANO_ACCESS_URL + NIGHTGATE_VAULT)');
}

await client.close();
console.log('live-stdio-smoke: PASS');
