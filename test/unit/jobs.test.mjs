// Write starts: dedupe, idempotency keys, resends after a lost answer, refusals and the chain outcome.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { awaitJob, chainOutcome, markReused, startOnce, startSponsored } from '../../dist/jobs.js';
import { apiError, NightgateApiError } from '../../dist/client.js';

const timeout = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

/** A client whose callAction answers from a list of results or errors, recording every call. */
function fakeClient(answers) {
  const calls = [];
  return {
    calls,
    async callAction(action, body) {
      calls.push({ action, body });
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return typeof next === 'function' ? next(action, body) : next;
    },
  };
}

test('chainOutcome reads status and chain status', () => {
  assert.equal(chainOutcome(undefined), 'unknown');
  assert.equal(chainOutcome({ status: 'running' }), 'unknown');
  assert.equal(chainOutcome({ status: 'failed' }), 'failed');
  assert.equal(chainOutcome({ status: 'succeeded', chainStatus: 'pending' }), 'unknown');
  assert.equal(chainOutcome({ status: 'succeeded', chainStatus: 'success' }), 'landed');
  assert.equal(chainOutcome({ status: 'succeeded', chainStatus: 'failure' }), 'failed');
  assert.equal(chainOutcome({ status: 'succeeded', chainStatus: 'dropped' }), 'failed');
  assert.equal(chainOutcome({ status: 'succeeded' }), 'landed');
});

test('a repeated identical call gets the first job and says so', async () => {
  let starts = 0;
  const first = await startOnce('k-reuse', async () => ({ jobId: `j${++starts}` }));
  const second = await startOnce('k-reuse', async () => ({ jobId: `j${++starts}` }));
  assert.equal(starts, 1);
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(second.job.jobId, 'j1');
  assert.equal(markReused(first.job, first, false).deduplicated, undefined);
  const marked = markReused(second.job, second, true);
  assert.equal(marked.deduplicated, true);
  assert.match(marked.dedupe, /with the same idempotencyKey/);
  assert.match(marked.dedupe, /new idempotencyKey/);
});

test('the server always gets an idempotency key: the caller\'s with the call it names, or one made here', async () => {
  const client = fakeClient([{ jobId: 'a' }, { jobId: 'b' }, { jobId: 'c' }]);
  const own = await startSponsored(client, 'k-own', 'caller-key', async (k) => ({ action: 'x', body: { k } }));
  assert.equal(client.calls[0].body.k, 'caller-key:k-own');
  assert.equal(own.job.idempotencyKey, 'caller-key:k-own');
  // the same caller key on another call is another server key, so the two never collide
  await startSponsored(client, 'k-other', 'caller-key', async (k) => ({ action: 'x', body: { k } }));
  assert.equal(client.calls[1].body.k, 'caller-key:k-other');
  client.calls.splice(1, 1);
  const made = await startSponsored(client, 'k-made', undefined, async (k) => ({ action: 'x', body: { k } }));
  assert.match(client.calls[1].body.k, /^mcp-[0-9a-f-]{36}$/);
  assert.equal(made.job.idempotencyKey, client.calls[1].body.k);
});

test('a send without an answer is repeated with the same body, built once', async () => {
  let builds = 0;
  const client = fakeClient([timeout(), timeout(), { jobId: 'late' }]);
  const started = await startSponsored(client, 'k-retry', undefined, async (k) => { builds++; return { action: 'x', body: { k }, info: { built: true } }; });
  assert.equal(builds, 1);
  assert.equal(client.calls.length, 3);
  assert.equal(new Set(client.calls.map((c) => c.body.k)).size, 1);
  assert.equal(started.job.jobId, 'late');
  assert.equal(started.job.built, true);
});

test('after three sends without an answer a later call resends the same transaction', async () => {
  let builds = 0;
  const prepare = async (k) => { builds++; return { action: 'x', body: { k, tx: 'bytes' } }; };
  const client = fakeClient([timeout(), timeout(), timeout(), { jobId: 'found' }]);
  await assert.rejects(startSponsored(client, 'k-lost', undefined, prepare), /did not answer[\s\S]*idempotencyKey mcp-/);
  const again = await startSponsored(client, 'k-lost', undefined, prepare);
  assert.equal(builds, 1);
  assert.equal(again.job.jobId, 'found');
  assert.equal(client.calls[3].body.k, client.calls[0].body.k);
});

test('a refusal releases what the build reserved and carries its detail', async () => {
  let released = 0;
  const client = fakeClient([new NightgateApiError(403, 'SPONSOR_REFUSED', 'refusing to sponsor')]);
  await assert.rejects(
    startSponsored(client, 'k-refused', undefined, async (k) => ({ action: 'x', body: { k }, detail: { halfId: 'h1' }, onRefused: async () => { released++; } })),
    (err) => err instanceof NightgateApiError && err.detail?.halfId === 'h1',
  );
  assert.equal(released, 1);
  assert.equal(client.calls.length, 1);
});

test('onSent gets the job the sponsor started', async () => {
  const seen = [];
  const client = fakeClient([{ jobId: 'sent' }]);
  await startSponsored(client, 'k-sent', undefined, async (k) => ({ action: 'x', body: { k }, onSent: (job) => seen.push(job.jobId) }));
  assert.deepEqual(seen, ['sent']);
});

test('awaitJob waits until the block confirmed any job, and names a chain failure', async () => {
  const client = fakeClient([
    { jobId: 'j', status: 'succeeded', chainStatus: 'pending' },
    { jobId: 'j', status: 'succeeded', chainStatus: 'failure' },
  ]);
  const job = await awaitJob(client, { timeoutMs: 30_000 }, { jobId: 'j', sessionId: 's', status: 'queued', kind: 'sponsorUnbound' }, undefined);
  assert.equal(job.chainStatus, 'failure');
  assert.match(job.next, /did not apply/);
  assert.equal(client.calls.length, 2);
});

test('a server answer like 503 with a code is a refusal, not a lost answer', async () => {
  const client = fakeClient([new NightgateApiError(503, 'SPONSOR_POLICY_EMPTY', 'no sponsor policy'), { jobId: 'never' }]);
  await assert.rejects(startSponsored(client, 'k-503', undefined, async (k) => ({ action: 'x', body: { k } })), (err) => err.code === 'SPONSOR_POLICY_EMPTY');
  assert.equal(client.calls.length, 1);
});

test('a caller key that names an earlier build takes the next retry key', async () => {
  const client = fakeClient([new NightgateApiError(409, 'IDEMPOTENCY_KEY_CONFLICT', 'used with a different payload'), { jobId: 'rebuilt' }]);
  const started = await startSponsored(client, 'k-conflict', 'pay-1', async (k) => ({ action: 'x', body: { idempotencyKey: k } }));
  assert.deepEqual(client.calls.map((c) => c.body.idempotencyKey), ['pay-1:k-conflict', 'pay-1:k-conflict:retry-1']);
  assert.equal(started.job.idempotencyKey, 'pay-1:k-conflict:retry-1');
});

const conflictNaming = (job) => new NightgateApiError(409, 'IDEMPOTENCY_KEY_CONFLICT', 'used with a different payload', { job });

test('a key that names a running or landed job gives that job back: nothing is sent again, the build is discarded', async () => {
  for (const [n, held] of [{ jobId: 'first', status: 'running', chainStatus: null }, { jobId: 'first', status: 'succeeded', chainStatus: 'success' }].entries()) {
    const released = [];
    const client = fakeClient([conflictNaming(held)]);
    const started = await startSponsored(client, `k-held-${n}`, 'pay-2', async (k) => ({
      action: 'x', body: { idempotencyKey: k }, info: { terms: 'same call' },
      discard: async () => { released.push('discard'); }, onRefused: async () => { released.push('refused'); },
      onSent: () => { released.push('sent'); },
    }));
    assert.equal(client.calls.length, 1);
    assert.deepEqual(released, ['discard']);
    assert.equal(started.job.jobId, 'first');
    assert.equal(started.job.status, held.status);
    assert.equal(started.job.terms, 'same call');
    assert.equal(started.job.deduplicated, true);
    assert.match(started.job.dedupe, /already names job first[\s\S]*Nothing new was sent/);
  }
});

test('without a discard of its own the adopted call releases through onRefused', async () => {
  const released = [];
  const client = fakeClient([conflictNaming({ jobId: 'first', status: 'submitted', chainStatus: 'pending' })]);
  await startSponsored(client, 'k-held-refused', 'pay-3', async (k) => ({ action: 'x', body: { idempotencyKey: k }, onRefused: async () => { released.push('refused'); } }));
  assert.deepEqual(released, ['refused']);
});

test('a key that names a job the chain refused takes the next key and sends', async () => {
  const client = fakeClient([conflictNaming({ jobId: 'first', status: 'succeeded', chainStatus: 'dropped' }), { jobId: 'second' }]);
  const started = await startSponsored(client, 'k-dropped', 'pay-4', async (k) => ({ action: 'x', body: { idempotencyKey: k } }));
  assert.deepEqual(client.calls.map((c) => c.body.idempotencyKey), ['pay-4:k-dropped', 'pay-4:k-dropped:retry-1']);
  assert.equal(started.job.jobId, 'second');
  assert.equal(started.job.deduplicated, undefined);
});

test('a job is read by its id alone when no session is known', async () => {
  const client = fakeClient([{ jobId: 'j-plain', status: 'succeeded', chainStatus: 'success' }]);
  const job = await awaitJob(client, { timeoutMs: 30_000 }, { jobId: 'j-plain', status: 'running' }, undefined);
  assert.equal(job.status, 'succeeded');
  assert.equal(client.calls[0].action, 'getJobStatus');
  assert.equal(client.calls[0].body.jobId, 'j-plain');
  assert.equal(client.calls[0].body.sessionId, undefined);
});

test('an error body that names the job of a key conflict keeps it', () => {
  const body = { error: { code: 'IDEMPOTENCY_KEY_CONFLICT', message: 'used', '@nightgate.job': { jobId: 'j1', status: 'succeeded', chainStatus: 'success' } } };
  const err = apiError(409, body, new Headers(), 'fallback');
  assert.deepEqual(err.detail, { job: { jobId: 'j1', status: 'succeeded', chainStatus: 'success' } });
  assert.equal(apiError(409, { error: { code: 'IDEMPOTENCY_KEY_CONFLICT', message: 'used' } }, new Headers(), 'fallback').detail, undefined);
});
