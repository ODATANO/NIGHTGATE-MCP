import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { NightgateApiError, type NightgateClient } from './client.js';
import type { NightgateMcpConfig } from './config.js';

export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** A follow-up call that shows on-chain whether the job's effect landed. */
export interface JobCheck {
  tool: string;
  args: Record<string, unknown>;
}

/** Longest a tool waits for the job it started, in ms. */
const JOB_MAX_WAIT_MS = 300_000;
/** How long one getJobStatus call lets the server wait, in ms. */
const JOB_WAIT_MS = 20_000;
/** How long a started job is kept, so a repeated call picks it up instead of submitting again. */
const STARTED_TTL_MS = 3_600_000;
// Off for this process once the server refuses getJobStatus' waitMs.
let longPoll = true;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The stage of the running tool call, shown in its progress messages. */
export const callStage = new AsyncLocalStorage<{ stage?: string }>();

export function setStage(stage: string): void {
  const store = callStage.getStore();
  if (store) store.stage = stage;
}

/** Stage of a job by its status, for the progress messages. */
function jobStage(status: unknown): string {
  return status === 'external_execution' || status === 'submitted'
    ? 'submitted, waiting for the block'
    : 'waiting for the sponsor';
}

/** Milliseconds between two timestamps of a job; undefined when one is missing. */
function span(from: unknown, to: unknown): number | undefined {
  const a = typeof from === 'string' ? Date.parse(from) : NaN;
  const b = typeof to === 'string' ? Date.parse(to) : NaN;
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, b - a) : undefined;
}

/** Server stages of a job from the timestamps getJobStatus returns. */
export function serverTimings(job: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number | undefined> = {
    queueMs: span(job.queuedAt, job.startedAt),
    sponsorMs: span(job.startedAt, job.submittedAt),
    settleMs: span(job.submittedAt, job.chainFinalizedAt ?? job.finishedAt),
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as Record<string, number>;
}

/** The session of every job this process started; getJobStatus needs it, the caller never sees it. */
const sessions = new Map<string, string>();

export function jobSession(jobId: string): string | undefined {
  return sessions.get(jobId);
}

const started = new Map<string, { job: Promise<Record<string, unknown>>; at: number }>();

// Starts the job for `key` once. A repeated call with the same key gets the job already started,
// so a client that gave up and asks again pays no second fee.
export function startOnce(key: string, start: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
  const now = Date.now();
  for (const [k, e] of started) if (now - e.at > STARTED_TTL_MS) started.delete(k);
  let entry = started.get(key);
  if (!entry) {
    entry = { job: start(), at: now };
    started.set(key, entry);
    entry.job.catch(() => started.delete(key));
  }
  return entry.job;
}

/** A failed job is forgotten, so the next call with the same key builds again. */
export function forgetStart(key: string): void {
  started.delete(key);
}

/** What a failed job asks the caller to do next. */
function nextStep(job: Record<string, unknown>): string | undefined {
  if (job.status !== 'failed') return undefined;
  if (job.errorCode === 'CHAIN_EXECUTION_FAILED') {
    return 'The transaction is on-chain but its contract call did not apply, usually because another call changed the same contract in that block. Run the tool again; it builds against the new state.';
  }
  return 'Nothing was applied. Read errorCode and errorMessage, fix the input and run the tool again.';
}

/** Reads the job's status once, waiting on the server where it can. */
async function readJob(client: NightgateClient, config: NightgateMcpConfig | undefined, jobId: string, sessionId: string): Promise<Record<string, unknown>> {
  const waitMs = longPoll ? Math.min(JOB_WAIT_MS, Math.max(0, (config?.timeoutMs ?? 30_000) - 5_000)) : 0;
  try {
    return await client.callAction('getJobStatus', waitMs > 0 ? { jobId, sessionId, waitMs } : { jobId, sessionId }) as Record<string, unknown>;
  } catch (err) {
    if (!(waitMs > 0 && err instanceof NightgateApiError && err.status === 400 && /waitMs/.test(err.message))) throw err;
    longPoll = false;
    return await client.callAction('getJobStatus', { jobId, sessionId }) as Record<string, unknown>;
  }
}

// Waits until a sponsor job settled and returns its outcome. A job still open after 5 minutes,
// or one whose status cannot be read, comes back as pending, with `check` to look it up on-chain.
export async function awaitJob(
  client: NightgateClient,
  config: NightgateMcpConfig | undefined,
  start: Record<string, unknown>,
  extra: ToolExtra | undefined,
  check?: JobCheck,
): Promise<Record<string, unknown>> {
  const { jobId, sessionId } = start;
  if (typeof jobId !== 'string' || typeof sessionId !== 'string') return start;
  sessions.set(jobId, sessionId);
  const deadline = Date.now() + JOB_MAX_WAIT_MS;
  let job: Record<string, unknown> = start;
  let statusError: string | undefined;
  while (job.status !== 'succeeded' && job.status !== 'failed' && Date.now() < deadline) {
    if (extra?.signal.aborted) break;
    setStage(jobStage(job.status));
    const t0 = Date.now();
    try {
      job = { ...job, ...await readJob(client, config, jobId, sessionId) };
      statusError = undefined;
    } catch (err) {
      statusError = err instanceof Error ? err.message : String(err);
      // a 4xx is no verdict on the job either, but asking again will not change it
      if (err instanceof NightgateApiError && err.status < 500 && err.status !== 429) break;
    }
    // a server that answered at once did not wait: pause before asking again
    if (Date.now() - t0 < 1_000) await sleep(3_000);
  }
  return outcome(job, check, statusError);
}

function outcome(job: Record<string, unknown>, check?: JobCheck, statusError?: string): Record<string, unknown> {
  const { sessionId: _s, result, ...rest } = job;
  const out: Record<string, unknown> = { ...rest };
  if (typeof result === 'string' && result) {
    try { out.result = JSON.parse(result); } catch { out.result = result; }
  } else if (result !== undefined && result !== null) {
    out.result = result;
  }
  const settled = job.status === 'succeeded' || job.status === 'failed';
  if (!settled) {
    out.status = 'pending';
    out.next = 'The job runs on. Run this tool again with the same arguments to wait for it; it submits nothing new.';
    if (statusError) out.statusError = statusError;
  }
  const timings = { ...(isRecord(job.timings) ? job.timings : {}), ...(settled ? serverTimings(job) : {}) };
  if (Object.keys(timings).length) out.timings = timings;
  const step = nextStep(job);
  if (step) out.next = step;
  if (check && job.status !== 'failed') out.check = check;
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
