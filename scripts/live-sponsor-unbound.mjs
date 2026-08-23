#!/usr/bin/env node
/**
 * Live lane (optional, needs network + a NIGHTGATE >= 0.18.0 with a sponsor
 * or sponsor pool): the whole agent path through the MCP tools, authenticated
 * with an AGENT-GRANT TOKEN only.
 *
 *   build_sponsorable_transaction (local, seed from NIGHTGATE_SEED_HEX)
 *     -> sponsor_unbound_transaction (the sponsor / pool pays the dust)
 *     -> get_job_status until terminal
 *     -> verify_attestation (crawler-free, attester id must be OURS)
 *
 * `@odatano/nightgate-tx` is a devDependency here, so `npm install` is enough.
 *
 *   NIGHTGATE_BASE_URL=https://api.nightgate.dev NIGHTGATE_TOKEN=ngat_... \
 *   NIGHTGATE_SEED_HEX=<64 or 128 hex, a throwaway is fine> \
 *   NIGHTGATE_VAULT=<vault address> NIGHTGATE_SPONSOR_SESSION_ID=<sponsor or pool id> \
 *   npm run live:sponsor-unbound
 */
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../dist/server.js';
import { loadConfig } from '../dist/config.js';
import { closeBuilder } from '../dist/builder.js';

const VAULT = process.env.NIGHTGATE_VAULT;
const SPONSOR = process.env.NIGHTGATE_SPONSOR_SESSION_ID || '00000000-0000-0000-0000-706f6f6c0000';
// An agent grant token is the POINT of this lane, but a hosted server behind
// basic auth has to be testable too, so either credential set is accepted and
// the one in use is printed.
const AUTH = process.env.NIGHTGATE_TOKEN ? 'agent-grant token'
  : (process.env.NIGHTGATE_USERNAME && process.env.NIGHTGATE_PASSWORD) ? 'basic auth'
    : null;
if (!process.env.NIGHTGATE_BASE_URL || !VAULT || !AUTH) {
  console.error('need NIGHTGATE_BASE_URL, NIGHTGATE_VAULT and either NIGHTGATE_TOKEN or NIGHTGATE_USERNAME + NIGHTGATE_PASSWORD (+ NIGHTGATE_SEED_HEX, generated when absent)');
  process.exit(1);
}
const env = { ...process.env, NIGHTGATE_TIMEOUT_MS: process.env.NIGHTGATE_TIMEOUT_MS || '120000' };
if (!env.NIGHTGATE_SEED_HEX) env.NIGHTGATE_SEED_HEX = randomBytes(64).toString('hex');

const server = buildServer(loadConfig(env));
const [ct, st] = InMemoryTransport.createLinkedPair();
await server.connect(st);
const client = new Client({ name: 'live-sponsor-unbound', version: '0' });
await client.connect(ct);
const text = (r) => r.content?.[0]?.text ?? '';
// The MCP protocol has its own 60 s request timeout, well under what a first
// build costs: a fresh vault lineage downloads its prover keys (~114 MB for
// the 32-slot one) before it proves anything.
const CALL_TIMEOUT_MS = Number(process.env.NIGHTGATE_MCP_CALL_TIMEOUT_MS || 900_000);
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS });
  if (r.isError) throw new Error(`${name} failed: ${text(r)}`);
  return JSON.parse(text(r));
};

const ARTIFACT = process.env.NIGHTGATE_VAULT_ARTIFACT || 'attestation-vault';
const me = await call('get_attester_identity', {});
console.log(`attester ${me.attesterId.slice(0, 16)}... on ${me.network}, auth via ${AUTH}, vault lineage ${ARTIFACT}`);

const payloadHash = randomBytes(32).toString('hex');
const t0 = Date.now();
const built = await call('build_sponsorable_transaction', {
  contractAddress: VAULT, call: 'attest',
  params: { payloadHash, metadataHash: randomBytes(32).toString('hex') },
  compiledArtifactRef: ARTIFACT,
});
console.log(`built locally in ${((Date.now() - t0) / 1000).toFixed(1)}s (${built.provingMode}, ${built.serializedBytes} bytes, ${built.channel})`);

const t1 = Date.now();
const { jobId, sessionId } = await call('sponsor_unbound_transaction', { unboundTxB64: built.unboundTxB64, sponsorSessionId: SPONSOR });
let job;
for (;;) {
  await new Promise(r => setTimeout(r, 3000));
  job = await call('get_job_status', { jobId, sessionId });
  if (['succeeded', 'failed', 'reconciliation_required'].includes(job.status)) break;
}
console.log(`job ${job.status} after ${((Date.now() - t1) / 1000).toFixed(1)}s`, job.errorCode ? `(${job.errorCode})` : '', (job.result || '').slice(0, 160));

const v = await call('verify_attestation', { contractAddress: VAULT, payloadHash, compiledArtifactRef: ARTIFACT });
console.log('verify_attestation:', JSON.stringify(v));
await client.close();
await closeBuilder();
const ok = job.status === 'succeeded' && v.verified === true && v.attesterId === built.attesterId && built.attesterId === me.attesterId;
console.log(ok ? 'live-sponsor-unbound: PASS' : 'live-sponsor-unbound: FAIL');
process.exit(ok ? 0 : 2);
