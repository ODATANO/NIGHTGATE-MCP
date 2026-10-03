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
  /** OData service path of the indexer service (the anonymous status reads). */
  indexerServicePath: string;
  /**
   * Absolute URL of ODATANO ASTRA, the analytics service. Default `<baseUrl>/odata/v4/astra`,
   * which is where the gateway serves it; an own deployment sets ODATANO_ANALYTICS_URL to its
   * ASTRA instance (its own app on its own port), or leaves it and gets no analytics tools.
   */
  analyticsUrl: string;
  /** Request timeout in milliseconds. */
  timeoutMs: number;

  // ---- local building (build_sponsorable_transaction), all optional ----
  /** Caller seed (128 hex, a 64-byte BIP39 seed) for local building and swaps; never a tool argument. */
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

  // ---- shielded swaps, all optional ----
  /** File the swap wallet's state is kept in, so a restart resumes instead of syncing from genesis. It holds the wallet's coins. */
  swapStateFile?: string;
  /** Most coins one swap half spends; default the builder's (4, the sponsor's default). */
  swapMaxInputs?: number;
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
  if (seedHex && !/^[0-9a-fA-F]{128}$/.test(seedHex)) {
    throw new Error('Invalid NIGHTGATE_SEED_HEX: expected 128 hex characters (a 64-byte BIP39 seed)');
  }
  const swapMaxInputs = env.NIGHTGATE_SWAP_MAX_INPUTS ? Number(env.NIGHTGATE_SWAP_MAX_INPUTS) : undefined;
  if (swapMaxInputs !== undefined && (!Number.isInteger(swapMaxInputs) || swapMaxInputs < 1)) {
    throw new Error(`Invalid NIGHTGATE_SWAP_MAX_INPUTS: ${env.NIGHTGATE_SWAP_MAX_INPUTS} (a positive integer)`);
  }
  const analyticsUrl = (env.ODATANO_ANALYTICS_URL || `${baseUrl}/odata/v4/astra`).replace(/\/+$/, '');
  return {
    baseUrl,
    token: env.ODATANO_ACCESS_KEY || undefined,
    username: env.ODATANO_ACCESS_USER || undefined,
    password: env.ODATANO_ACCESS_PASSWORD || undefined,
    servicePath: env.NIGHTGATE_SERVICE_PATH ?? '/api/v1/nightgate',
    indexerServicePath: env.NIGHTGATE_INDEXER_SERVICE_PATH ?? '/api/v1/indexer',
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
    swapStateFile: env.NIGHTGATE_SWAP_STATE_FILE || undefined,
    swapMaxInputs,
  };
}
