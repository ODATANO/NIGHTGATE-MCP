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

  // ---- local building (build_sponsorable_transaction), all optional ----
  /** Caller seed (64 or 128 hex) for the local txbuilder; never a tool argument. */
  seedHex?: string;
  /** Midnight network the builder targets; default preprod. */
  network: string;
  indexerHttpUrl?: string;
  indexerWsUrl?: string;
  nodeUrl?: string;
  /** Where the prover keys come from; default `<baseUrl>/zk-config/attestation-vault`. */
  zkConfigBaseUrl?: string;
  /** Disk cache for prover keys; default `<tmp>/nightgate-mcp-zk`. */
  zkCacheDir?: string;
  /** Set to prove contract circuits on a proof server instead of in-process wasm. */
  proofServerUrl?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): NightgateMcpConfig {
  const baseUrl = (env.NIGHTGATE_BASE_URL ?? 'http://localhost:4004').replace(/\/+$/, '');
  const timeoutMs = Number(env.NIGHTGATE_TIMEOUT_MS ?? 30000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Invalid NIGHTGATE_TIMEOUT_MS: ${env.NIGHTGATE_TIMEOUT_MS}`);
  }
  const network = env.NIGHTGATE_NETWORK || 'preprod';
  if (!['preview', 'preprod', 'mainnet'].includes(network)) {
    throw new Error(`Invalid NIGHTGATE_NETWORK: ${network} (preview | preprod | mainnet)`);
  }
  const seedHex = env.NIGHTGATE_SEED_HEX || undefined;
  if (seedHex && !/^([0-9a-fA-F]{64}|[0-9a-fA-F]{128})$/.test(seedHex)) {
    throw new Error('Invalid NIGHTGATE_SEED_HEX: expected 64 or 128 hex characters');
  }
  return {
    baseUrl,
    token: env.NIGHTGATE_TOKEN || undefined,
    username: env.NIGHTGATE_USERNAME || undefined,
    password: env.NIGHTGATE_PASSWORD || undefined,
    servicePath: env.NIGHTGATE_SERVICE_PATH ?? '/api/v1/nightgate',
    timeoutMs,
    seedHex,
    network,
    indexerHttpUrl: env.NIGHTGATE_INDEXER_HTTP_URL || undefined,
    indexerWsUrl: env.NIGHTGATE_INDEXER_WS_URL || undefined,
    nodeUrl: env.NIGHTGATE_NODE_URL || undefined,
    zkConfigBaseUrl: env.NIGHTGATE_ZK_CONFIG_BASE_URL || undefined,
    zkCacheDir: env.NIGHTGATE_ZK_CACHE_DIR || undefined,
    proofServerUrl: env.NIGHTGATE_PROOF_SERVER_URL || undefined,
  };
}
