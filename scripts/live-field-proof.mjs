#!/usr/bin/env node
/**
 * The claim path a PAYING THIRD PARTY can walk: prove a ZK statement about
 * an anchored document with no wallet on the server, no key and no witness
 * leaving this machine, and the sponsor paying only the dust.
 *
 *   prepare_document_proof   (compute-only, no chain)
 *   build_sponsorable_transaction  attest        -> anchor the payload
 *   build_sponsorable_transaction  anchorContentRoot
 *   build_sponsorable_transaction  proveFieldPredicate  <- the ZK claim
 *   verify_predicate          (crawler-free, reads live contract state)
 *
 * Everything is authenticated by an agent grant alone, which is what makes
 * it sellable: the token buys sponsored transactions, not custody.
 *
 * Reads .env like the other lanes. Run: npm run live:field-proof
 */
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../dist/server.js';
import { loadConfig } from '../dist/config.js';
import { closeBuilder } from '../dist/builder.js';

const VAULT = process.env.NIGHTGATE_VAULT;
const ARTIFACT = process.env.NIGHTGATE_VAULT_ARTIFACT || 'attestation-vault';
const SPONSOR = process.env.NIGHTGATE_SPONSOR_SESSION_ID || '00000000-0000-0000-0000-706f6f6c0000';
const fail = (m) => { console.error(`FAIL ${m}`); process.exit(1); };
if (!VAULT || !process.env.ODATANO_ACCESS_URL) fail('need ODATANO_ACCESS_URL and NIGHTGATE_VAULT');

const env = { ...process.env, NIGHTGATE_TIMEOUT_MS: process.env.NIGHTGATE_TIMEOUT_MS || '120000' };
if (!env.NIGHTGATE_SEED_HEX) env.NIGHTGATE_SEED_HEX = randomBytes(64).toString('hex');

const server = buildServer(loadConfig(env));
const [ct, st] = InMemoryTransport.createLinkedPair();
await server.connect(st);
const client = new Client({ name: 'live-field-proof', version: '0' });
await client.connect(ct);
const TIMEOUT = Number(process.env.NIGHTGATE_MCP_CALL_TIMEOUT_MS || 900_000);
const text = (r) => r.content?.[0]?.text ?? '';
const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: TIMEOUT });
    if (r.isError) throw new Error(`${name} failed: ${text(r)}`);
    return JSON.parse(text(r));
};
const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

// 1. A document with something worth hiding: the amount stays secret, only
//    "at least 10000.00" becomes public.
const AMOUNT = 18450.75;
const THRESHOLD = 10000.00;
const SCALE = 100;
const doc = { invoiceId: 'INV-' + randomBytes(4).toString('hex'), total: AMOUNT, currency: 'EUR' };
const prep = await call('prepare_document_proof', {
    document: doc,
    proofFields: [{ field: 'total', scale: SCALE }, { field: 'currency', kind: 'bytes' }],
    compiledArtifactRef: ARTIFACT,
});
const fields = parse(prep.fields);
const total = fields.find((f) => f.field === 'total') || fail('prepare returned no total field');
console.log(`prepared: payload ${prep.payloadHash.slice(0, 12)}…, ${parse(prep.schema).length} slots, path depth ${total.siblings.length}`);

const me = await call('get_attester_identity', {});
console.log(`attester ${me.attesterId.slice(0, 16)}… (local seed, never sent)`);

async function submit(label, call_, params, extra = {}) {
    const t0 = Date.now();
    const built = await call('build_sponsorable_transaction', {
        contractAddress: VAULT, call: call_, params, compiledArtifactRef: ARTIFACT, ...extra,
    });
    console.log(`  ${label}: proven locally in ${((Date.now() - t0) / 1000).toFixed(1)}s (${built.serializedBytes} B)`);
    const { jobId, sessionId } = await call('sponsor_unbound_transaction', {
        unboundTxB64: built.unboundTxB64, sponsorSessionId: SPONSOR,
    });
    for (;;) {
        await new Promise((r) => setTimeout(r, 3000));
        const job = await call('get_job_status', { jobId, sessionId });
        if (['succeeded', 'failed', 'reconciliation_required'].includes(job.status)) {
            if (job.status !== 'succeeded') fail(`${label} job ${job.status}: ${job.errorMessage ?? ''}`);
            console.log(`  ${label}: sponsored, tx ${String(JSON.parse(job.result || '{}').txHash ?? '').slice(0, 18)}…`);
            return;
        }
    }
}

// 2. Anchor the payload and its content root, then prove the claim.
await submit('attest', 'attest', { payloadHash: prep.payloadHash, metadataHash: prep.payloadHash });
await submit('anchorContentRoot', 'anchorContentRoot', {
    payloadHash: prep.payloadHash, contentRoot: prep.contentRoot, schemaId: prep.schemaId,
});
await submit('proveFieldPredicate', 'proveFieldPredicate', {
    payloadHash: prep.payloadHash, fieldKey: total.fieldKey,
    threshold: String(Math.round(THRESHOLD * SCALE)), op: 1,
}, {
    merkleProof: { fieldValue: String(total.value), fieldSalt: total.salt, siblings: total.siblings, dirs: total.dirs },
});

// 3. Anyone can check it against live contract state, with no wallet.
for (let i = 0; ; i++) {
    const v = await call('verify_predicate', {
        contractAddress: VAULT, attesterId: me.attesterId, payloadHash: prep.payloadHash, fieldKey: total.fieldKey,
        predicate: 'greaterOrEqual', threshold: Math.round(THRESHOLD * SCALE),
        compiledArtifactRef: ARTIFACT,
    }).catch(() => null);
    if (v?.verified === true) {
        console.log(`\nVERIFIED on chain: total >= ${THRESHOLD} EUR is proven, the amount (${AMOUNT}) never left this process.`);
        break;
    }
    if (i > 30) fail('claim never became visible');
    await new Promise((r) => setTimeout(r, 6000));
}

await client.close();
await closeBuilder();
console.log('live-field-proof: PASS');
