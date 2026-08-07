import type { NightgateMcpConfig } from './config.js';

/** Error carrying the OData error body of a failed NIGHTGATE call. */
export class NightgateApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'NightgateApiError';
  }
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

/**
 * Minimal OData V4 client for the Nightgate service. Two verbs only:
 * unbound functions (GET, parameters inline in the URL) and unbound
 * actions (POST, JSON body), which is all the MCP tools need.
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

  private async request(method: 'GET' | 'POST', url: string, body?: unknown): Promise<unknown> {
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
      const err = (payload as { error?: { code?: string; message?: string } }).error;
      throw new NightgateApiError(
        response.status,
        err?.code,
        err?.message ?? `NIGHTGATE request failed with HTTP ${response.status}`,
      );
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
