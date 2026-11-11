import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
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
/** Job kinds whose answer carries a receipt once the block confirmed the transaction. */
const RECEIPT_KINDS = new Set(['sponsorSwap', 'sponsorTransfer']);
const CHAIN_SETTLED = new Set(['success', 'failure', 'dropped']);

const settled = (job: Record<string, unknown>): boolean => job.status === 'succeeded' || job.status === 'failed';

/** A landed swap or transfer whose block has not confirmed it yet: the receipt is still to come. */
export function receiptPending(job: Record<string, unknown>): boolean {
  return job.status === 'succeeded' && RECEIPT_KINDS.has(String(job.kind)) && !CHAIN_SETTLED.has(String(job.chainStatus));
}

/** A sent job of any kind whose block has not confirmed it yet. */
function chainPending(job: Record<string, unknown>): boolean {
  return job.status === 'succeeded' && job.chainStatus === 'pending';
}

/**
 * What a job did on chain: `landed`, `failed` (refused, failed, or sent and then failed or dropped on chain),
 * or `unknown` while it runs. A server that reports no chain status counts a succeeded job as landed.
 */
export function chainOutcome(job: Record<string, unknown> | undefined): 'landed' | 'failed' | 'unknown' {
  if (!job) return 'unknown';
  if (job.status === 'failed') return 'failed';
  if (job.status !== 'succeeded') return 'unknown';
  if (job.chainStatus === 'failure' || job.chainStatus === 'dropped') return 'failed';
  if (job.chainStatus === 'success' || job.chainStatus === null || job.chainStatus === undefined) return 'landed';
  return 'unknown';
}
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
  if (status === 'succeeded') return 'landed, waiting for the block and the receipt';
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

/** Makes a job of an earlier process readable again. */
export function rememberJob(jobId: string, sessionId: string): void {
  sessions.set(jobId, sessionId);
}

const started = new Map<string, { job: Promise<Record<string, unknown>>; at: number }>();

/** A job started by `startOnce`, and whether an earlier identical call started it. */
export interface Started {
  job: Record<string, unknown>;
  reused: boolean;
  startedAt: number;
}

// Starts the job for `key` once. A repeated call with the same key gets the job already started,
// so a client that gave up and asks again pays no second fee.
export async function startOnce(key: string, start: () => Promise<Record<string, unknown>>): Promise<Started> {
  const now = Date.now();
  for (const [k, e] of started) if (now - e.at > STARTED_TTL_MS) started.delete(k);
  for (const [k, e] of unsent) if (now - e.at > STARTED_TTL_MS) unsent.delete(k);
  let entry = started.get(key);
  const reused = !!entry;
  if (!entry) {
    entry = { job: start(), at: now };
    started.set(key, entry);
    entry.job.catch(() => started.delete(key));
  }
  return { job: await entry.job, reused, startedAt: entry.at };
}

/** Failed attempts per call key; a rebuild after a failure needs a server key of its own. */
const attempts = new Map<string, number>();

/** A failed job is forgotten, so the next call with the same key builds again. */
export function forgetStart(key: string): void {
  if (started.delete(key)) attempts.set(key, (attempts.get(key) ?? 0) + 1);
}

/** The server key of a call: the caller's key and the call it names, then one per rebuild. So one key never stands for two calls. */
function serverKey(key: string, callerKey: string): string {
  const n = attempts.get(key) ?? 0;
  const named = `${callerKey}:${key.slice(0, 12)}`;
  return n ? `${named}:retry-${n}` : named;
}

/** What a write tool hands to a sponsor action, built once. */
export interface Handover {
  action: string;
  body: Record<string, unknown>;
  /** Fields the tool answer carries next to the job. */
  info?: Record<string, unknown>;
  /** Fields an error of the send carries, such as the id of a half to revert. */
  detail?: Record<string, unknown>;
  /** Releases what the build reserved; runs when the sponsor refuses the transaction. */
  onRefused?: () => Promise<void>;
  /** Releases what the build reserved when an earlier job already holds the key; default `onRefused`. */
  discard?: () => Promise<void>;
  /** Runs once the sponsor took the transaction, with the job it started. */
  onSent?: (job: Record<string, unknown>) => void;
}

/** Sends after a timeout or a lost connection, with the same body and idempotency key. */
const SEND_ATTEMPTS = 3;
/** Rebuilds a caller key may have had before this process started. */
const MAX_KEY_CONFLICTS = 8;
/** Handovers whose send got no answer, by call key, so a repeated call resends instead of building again. */
const unsent = new Map<string, { handover: Handover; idempotencyKey: string; at: number }>();

/** No answer, or a gateway that lost the server's: the server may have taken the request, so only the same idempotency key may resend it. */
function unanswered(err: unknown): boolean {
  if (err instanceof NightgateApiError) return err.status === 502 || err.status === 504;
  const name = (err as Error)?.name;
  return name === 'TimeoutError' || name === 'AbortError' || /fetch failed|ECONNRESET|socket hang up/i.test(String((err as Error)?.message ?? err));
}

/** The job a key conflict names: the one an earlier build of this call started. */
function heldJob(err: NightgateApiError): Record<string, unknown> | undefined {
  const job = err.detail?.job;
  return isRecord(job) && typeof job.jobId === 'string' ? job : undefined;
}

/**
 * Starts a sponsored write once per call key. The server always gets an idempotency key: the caller's, or one made
 * here and kept with the job. A send without an answer is repeated with the same body; if none comes, a later
 * call with the same key resends that body instead of building again, so the same coins are never spent twice.
 */
export function startSponsored(
  client: NightgateClient,
  key: string,
  callerKey: string | undefined,
  prepare: (idempotencyKey: string) => Promise<Handover>,
): Promise<Started> {
  return startOnce(key, async () => {
    const kept = unsent.get(key);
    let idempotencyKey = kept?.idempotencyKey ?? (callerKey ? serverKey(key, callerKey) : `mcp-${randomUUID()}`);
    const handover = kept?.handover ?? await prepare(idempotencyKey);
    setStage('handing over to the sponsor');
    let conflicts = 0;
    for (let attempt = 1; ; attempt++) {
      try {
        const job = await client.callAction(handover.action, handover.body) as Record<string, unknown>;
        unsent.delete(key);
        handover.onSent?.(job);
        return { ...job, ...(handover.info ?? {}), idempotencyKey };
      } catch (err) {
        if (unanswered(err) && attempt < SEND_ATTEMPTS) continue;
        const conflict = callerKey && !kept && err instanceof NightgateApiError && err.code === 'IDEMPOTENCY_KEY_CONFLICT' ? err : undefined;
        // An earlier build of this call holds the key, usually one from before a restart. While it runs or once it landed, it is the answer.
        const held = conflict && heldJob(conflict);
        if (held && chainOutcome(held) !== 'failed') {
          unsent.delete(key);
          await (handover.discard ?? handover.onRefused)?.().catch((e) => console.error(`nightgate-mcp: reserved coins not released: ${(e as Error).message}`));
          return {
            ...(handover.info ?? {}), jobId: held.jobId, status: held.status, idempotencyKey, deduplicated: true,
            dedupe: `This call's idempotencyKey already names job ${String(held.jobId)}, started by an earlier call. Nothing new was sent, and what this call built was discarded. ` +
              'For a second, separate call pass a new idempotencyKey.',
          };
        }
        // That build failed on chain, or the server does not say which job it is: this rebuild takes the next key.
        if (conflict && conflicts < MAX_KEY_CONFLICTS) {
          conflicts++;
          attempts.set(key, (attempts.get(key) ?? 0) + 1);
          idempotencyKey = serverKey(key, callerKey as string);
          handover.body = { ...handover.body, idempotencyKey };
          attempt = 0;
          continue;
        }
        if (unanswered(err)) {
          unsent.set(key, { handover, idempotencyKey, at: Date.now() });
          throw new Error(`the sponsor did not answer (${(err as Error)?.message ?? String(err)}); it may have taken the transaction. ` +
            `Run the tool again with the same arguments: it sends the same transaction with idempotencyKey ${idempotencyKey} and gets that job; nothing is built twice.`);
        }
        unsent.delete(key);
        await handover.onRefused?.().catch((e) => console.error(`nightgate-mcp: reserved coins not released: ${(e as Error).message}`));
        if (err instanceof NightgateApiError && handover.detail) throw new NightgateApiError(err.status, err.code, err.message, { ...(err.detail ?? {}), ...handover.detail });
        throw err;
      }
    }
  });
}

/** Marks a job that an earlier identical call started, so a repeat is never taken for a second payment. */
export function markReused(job: Record<string, unknown>, started: Started, keyed: boolean): Record<string, unknown> {
  if (!started.reused) return job;
  return {
    ...job,
    deduplicated: true,
    dedupe: `An identical call${keyed ? ' with the same idempotencyKey' : ''} started this job at ${new Date(started.startedAt).toISOString()}; ` +
      'nothing new was sent. For a second, separate call pass a new idempotencyKey.',
  };
}

/** What a failed job asks the caller to do next. */
function nextStep(job: Record<string, unknown>): string | undefined {
  if (job.status !== 'failed') return undefined;
  if (job.errorCode === 'CHAIN_EXECUTION_FAILED') {
    return 'The transaction is on-chain but its contract call did not apply, usually because another call changed the same contract in that block. Run the tool again; it builds against the new state.';
  }
  return 'Nothing was applied. Read errorCode and errorMessage, fix the input and run the tool again.';
}

/** Reads the job's status once, waiting on the server where it can. The session is sent when known; a current server needs none. */
async function readJob(client: NightgateClient, config: NightgateMcpConfig | undefined, jobId: string, sessionId: string | undefined): Promise<Record<string, unknown>> {
  const waitMs = longPoll ? Math.min(JOB_WAIT_MS, Math.max(0, (config?.timeoutMs ?? 30_000) - 5_000)) : 0;
  try {
    return await client.callAction('getJobStatus', waitMs > 0 ? { jobId, sessionId, waitMs } : { jobId, sessionId }) as Record<string, unknown>;
  } catch (err) {
    if (!(waitMs > 0 && err instanceof NightgateApiError && err.status === 400 && /waitMs/.test(err.message))) throw err;
    longPoll = false;
    return await client.callAction('getJobStatus', { jobId, sessionId }) as Record<string, unknown>;
  }
}

// Waits until a sponsor job settled and, for a swap or transfer, until the block confirmed it, so the
// answer carries the receipt. A job still open after 5 minutes, or one whose status cannot be read,
// comes back as pending, with `check` to look it up on-chain.
export async function awaitJob(
  client: NightgateClient,
  config: NightgateMcpConfig | undefined,
  start: Record<string, unknown>,
  extra: ToolExtra | undefined,
  check?: JobCheck,
): Promise<Record<string, unknown>> {
  const { jobId } = start;
  if (typeof jobId !== 'string') return start;
  const sessionId = typeof start.sessionId === 'string' ? start.sessionId : undefined;
  if (sessionId) sessions.set(jobId, sessionId);
  const deadline = Date.now() + JOB_MAX_WAIT_MS;
  let job: Record<string, unknown> = start;
  let statusError: string | undefined;
  while ((!settled(job) || receiptPending(job) || chainPending(job)) && Date.now() < deadline) {
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
  if (!settled(job)) {
    out.status = 'pending';
    out.next = 'The job runs on. Run this tool again with the same arguments to wait for it; it submits nothing new.';
    if (statusError) out.statusError = statusError;
  } else if (receiptPending(job)) {
    out.next = 'The transaction is sent; its receipt comes once the block confirmed it. Run this tool again with the same arguments to fetch it; it submits nothing new.';
  } else if (job.status === 'succeeded' && RECEIPT_KINDS.has(String(job.kind)) && job.chainStatus !== 'success') {
    out.next = `The sponsor sent the transaction but the chain reports it as ${String(job.chainStatus)}; no receipt exists. Check get_swap_wallet before running the tool again.`;
  } else if (chainPending(job)) {
    out.next = 'The transaction is sent; the block has not confirmed it yet. Run this tool again with the same arguments to wait for it; it submits nothing new.';
  } else if (chainOutcome(job) === 'failed') {
    out.next = `The sponsor sent the transaction but the chain reports it as ${String(job.chainStatus)}: its effect did not apply. Run the tool again; it builds against the new state.`;
  }
  const timings = { ...(isRecord(job.timings) ? job.timings : {}), ...(settled(job) ? serverTimings(job) : {}) };
  if (Object.keys(timings).length) out.timings = timings;
  const step = nextStep(job);
  if (step) out.next = step;
  if (check && job.status !== 'failed') out.check = check;
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
