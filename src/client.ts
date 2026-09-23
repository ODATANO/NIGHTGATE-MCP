import type { NightgateMcpConfig } from './config.js';

/** Error carrying the OData error body of a failed NIGHTGATE call. */
export class NightgateApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | undefined,
    message: string,
    /** Extra fields of a gateway error body (unitsLeft, price, topup, products, validUntil, retryAfterSeconds). */
    public readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'NightgateApiError';
  }
}

/**
 * Two error shapes reach the client: CAP's `{ error: { code, message } }`
 * from NIGHTGATE itself, and the ODATANO ACCESS gateway's `{ error: "<text>",
 * ...detail }` (401 key problems, 402 units exhausted with a top-up hint,
 * 403 closed action or product not on the key, 429 with Retry-After).
 */
export function apiError(status: number, payload: unknown, headers: Headers, fallback: string): NightgateApiError {
  const body = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const err = body.error;
  if (typeof err === 'string') {
    const { error: _e, ...rest } = body;
    const detail: Record<string, unknown> = { ...rest };
    const retry = headers.get('retry-after');
    if (retry) detail.retryAfterSeconds = Number(retry);
    return new NightgateApiError(status, undefined, err, Object.keys(detail).length ? detail : undefined);
  }
  const e = (err ?? {}) as { code?: string; message?: string };
  return new NightgateApiError(status, e.code, e.message ?? fallback);
}

/**
 * Marker for an OData Int64 URL literal: rendered unquoted so precision
 * is preserved beyond Number.MAX_SAFE_INTEGER.
 */
export interface Int64Literal {
  $int64: string;
}

export function int64(value: string | number): Int64Literal {
  const digits = String(value);
  if (!/^\d+$/.test(digits)) throw new Error(`not a non-negative integer: ${value}`);
  return { $int64: digits };
}

/** OData system query options for the ASTRA entity reads. */
export interface EntityQuery {
  filter?: string;
  select?: string;
  orderby?: string;
  top?: number;
  skip?: number;
  count?: boolean;
}

/** Build the `?$filter=...` query string; only provided options are emitted. */
export function buildQueryString(query: EntityQuery): string {
  const parts: string[] = [];
  const add = (name: string, value: string | number | boolean | undefined) => {
    if (value === undefined || value === '') return;
    parts.push(`$${name}=${encodeURIComponent(String(value))}`);
  };
  add('filter', query.filter);
  add('select', query.select);
  add('orderby', query.orderby);
  add('top', query.top);
  add('skip', query.skip);
  if (query.count) add('count', 'true');
  return parts.length ? `?${parts.join('&')}` : '';
}

/**
 * Minimal OData V4 client for the Nightgate service: unbound functions (GET,
 * parameters inline in the URL) and unbound actions (POST, JSON body), plus
 * the reads of ODATANO ASTRA, the analytics service next door on the same host.
 */
export class NightgateClient {
  constructor(private readonly config: NightgateMcpConfig) {}

  /** GET <service>/<name>(p1=...,p2=...) with only the provided parameters. */
  async callFunction(name: string, params: Record<string, string | number | Int64Literal | undefined>): Promise<unknown> {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      parts.push(`${key}=${odataLiteral(value)}`);
    }
    const url = `${this.config.baseUrl}${this.config.servicePath}/${name}(${parts.join(',')})`;
    return this.request('GET', url);
  }

  /** POST <service>/<name> with the provided parameters as JSON body. */
  async callAction(name: string, params: Record<string, unknown>): Promise<unknown> {
    const body: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue;
      body[key] = value;
    }
    const url = `${this.config.baseUrl}${this.config.servicePath}/${name}`;
    return this.request('POST', url, body);
  }

  // ---- ODATANO ASTRA: analytics over the same index, same host, same key ----

  /** Base URL of ODATANO ASTRA: the gateway's `/odata/v4/astra` unless ODATANO_ANALYTICS_URL says otherwise. */
  analyticsUrl(): string {
    return this.config.analyticsUrl;
  }

  /** GET <astra>/<Entity>?$filter=... â the ready-made views (KeyFigures, BlocksDaily, TopBlockProducers, ...). */
  async analyticsQuery(entity: string, query: EntityQuery = {}): Promise<unknown> {
    return this.request('GET', `${this.analyticsUrl()}/${entity}${buildQueryString(query)}`);
  }

  /** GET <astra>/<name>(p1=...,p2=...) â getWindow, getSeries, compare, getAnomalies. */
  async analyticsFunction(name: string, params: Record<string, string | number | undefined>): Promise<unknown> {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      parts.push(`${key}=${odataLiteral(value)}`);
    }
    return this.request('GET', `${this.analyticsUrl()}/${name}(${parts.join(',')})`);
  }

  /**
   * Does the host serve ODATANO ASTRA? `served` registers the analytics tools,
   * `closed` = the gateway answers 403, `absent` = 404 or no answer. Never throws.
   */
  async analyticsStatus(): Promise<'served' | 'closed' | 'absent'> {
    try {
      const response = await fetch(`${this.analyticsUrl()}/$metadata`, {
        method: 'GET',
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(Math.min(this.config.timeoutMs, 10000)),
      });
      await response.arrayBuffer().catch(() => undefined);
      if (response.ok) return 'served';
      return response.status === 403 ? 'closed' : 'absent';
    } catch {
      return 'absent';
    }
  }

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.config.token?.startsWith('ngat_')) {
      // NIGHTGATE agent-grant token (0.14.0): travels in its own header so it
      // never collides with the host app's transport auth. Basic credentials
      // may accompany it when the host requires transport authentication.
      headers['x-agent-token'] = this.config.token;
      if (this.config.username) {
        const basic = Buffer.from(`${this.config.username}:${this.config.password ?? ''}`).toString('base64');
        headers.Authorization = `Basic ${basic}`;
      }
    } else if (this.config.token) {
      headers.Authorization = `Bearer ${this.config.token}`;
    } else if (this.config.username) {
      const basic = Buffer.from(`${this.config.username}:${this.config.password ?? ''}`).toString('base64');
      headers.Authorization = `Basic ${basic}`;
    }
    return headers;
  }

  private async request(method: 'GET' | 'POST', url: string, body?: unknown): Promise<unknown> {
    const headers = this.authHeaders();
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });

    const text = await response.text();
    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw: text };
    }

    if (!response.ok) {
      throw apiError(response.status, payload, response.headers, `NIGHTGATE request failed with HTTP ${response.status}`);
    }
    return stripODataNoise(payload);
  }
}

/** Encode a JS value as an OData URL literal (strings quoted, '' -> escaped). */
function odataLiteral(value: string | number | Int64Literal): string {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object') return value.$int64;
  return `'${value.replace(/'/g, "''")}'`;
}

/** Drop @odata.* metadata keys so tool output stays clean for the model. */
function stripODataNoise(payload: unknown): unknown {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (key.startsWith('@odata')) continue;
    out[key] = value;
  }
  return out;
}
