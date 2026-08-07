/**
 * Server configuration, environment-driven so the same binary works for
 * local dev (basic auth against a `cds watch` instance) and for a deployed
 * NIGHTGATE behind a reverse proxy (bearer token, phase B agent grants).
 */
export interface NightgateMcpConfig {
  /** Base URL of the NIGHTGATE host app, e.g. http://localhost:4004 */
  baseUrl: string;
  /**
   * Token credential. An `ngat_...` value is a NIGHTGATE agent-grant token
   * (sent as `x-agent-token`, optionally alongside basic transport auth);
   * anything else is sent as a plain `Authorization: Bearer` header.
   */
  token?: string;
  /** Basic-auth credentials for dev/mocked CAP auth. */
  username?: string;
  password?: string;
  /** OData service path of the main Nightgate service. */
  servicePath: string;
  /** Request timeout in milliseconds. */
  timeoutMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): NightgateMcpConfig {
  const baseUrl = (env.NIGHTGATE_BASE_URL ?? 'http://localhost:4004').replace(/\/+$/, '');
  const timeoutMs = Number(env.NIGHTGATE_TIMEOUT_MS ?? 30000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Invalid NIGHTGATE_TIMEOUT_MS: ${env.NIGHTGATE_TIMEOUT_MS}`);
  }
  return {
    baseUrl,
    token: env.NIGHTGATE_TOKEN || undefined,
    username: env.NIGHTGATE_USERNAME || undefined,
    password: env.NIGHTGATE_PASSWORD || undefined,
    servicePath: env.NIGHTGATE_SERVICE_PATH ?? '/api/v1/nightgate',
    timeoutMs,
  };
}
