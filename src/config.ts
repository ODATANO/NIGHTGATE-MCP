/**
 * Server configuration, environment-driven. The connection variables are the
 * same for every ODATANO MCP server (ODATANO_ACCESS_*): one key from
 * https://api.preprod.odatano.dev configures the Midnight and the Cardano server alike.
 * A direct NIGHTGATE instance (local `cds watch`, an own deployment) is reached
 * by pointing ODATANO_ACCESS_URL at it.
 */
export interface NightgateMcpConfig {
  /** Base URL: the ODATANO ACCESS gateway (default https://api.preprod.odatano.dev) or a direct NIGHTGATE host app. */
  baseUrl: string;
  /**
   * ODATANO_ACCESS_KEY. The usual value is an ODATANO ACCESS key (`oda_...`),
   * sent as `Authorization: Bearer`; the gateway swaps in the agent grant.
   * Against a direct NIGHTGATE instance an `ngat_...` agent-grant token goes
   * as `x-agent-token` (optionally alongside basic transport auth); anything
   * else is a plain bearer.
   */
  token?: string;
  /** ODATANO_ACCESS_USER / _PASSWORD: basic auth for a direct instance (CAP dev/mocked auth); never for agents. */
  username?: string;
  password?: string;
  /** OData service path of the main Nightgate service. */
  servicePath: string;
  /**
   * Absolute URL of ODATANO ASTRA, the analytics service. Default `<baseUrl>/odata/v4/astra`,
   * which is where the gateway serves it; an own deployment sets ODATANO_ANALYTICS_URL to its
   * ASTRA instance (its own app on its own port), or leaves it and gets no analytics tools.
   */
  analyticsUrl: string;
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
  const baseUrl = (env.ODATANO_ACCESS_URL || 'https://api.preprod.odatano.dev').replace(/\/+$/, '');
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
  const analyticsUrl = (env.ODATANO_ANALYTICS_URL || `${baseUrl}/odata/v4/astra`).replace(/\/+$/, '');
  return {
    baseUrl,
    token: env.ODATANO_ACCESS_KEY || undefined,
    username: env.ODATANO_ACCESS_USER || undefined,
    password: env.ODATANO_ACCESS_PASSWORD || undefined,
    servicePath: env.NIGHTGATE_SERVICE_PATH ?? '/api/v1/nightgate',
    analyticsUrl,
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
