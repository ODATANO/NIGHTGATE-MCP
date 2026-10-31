import { txExport } from './tx-module.js';

/**
 * Server configuration from the environment. The connection variables (ODATANO_ACCESS_*) are the same for
 * every ODATANO MCP server; ODATANO_ACCESS_URL points at the gateway or at a direct NIGHTGATE instance.
 */
export interface NightgateMcpConfig {
  /** Base URL: the ODATANO gateway (default https://api.preprod.odatano.dev) or a direct NIGHTGATE host app. */
  baseUrl: string;
  /** ODATANO_ACCESS_KEY: a gateway key (`oda_...`) sent as bearer, or an `ngat_...` agent grant sent as `x-agent-token`. */
  token?: string;
  /** ODATANO_ACCESS_USER / _PASSWORD: basic auth for a direct instance (CAP dev/mocked auth); never for agents. */
  username?: string;
  password?: string;
  /** OData service path of the main Nightgate service. */
  servicePath: string;
  /** Service path of the state reads; the public verify service unless credentials of a direct instance are set. */
  verifyServicePath: string;
  /** OData service path of the indexer service (the anonymous status reads). */
  indexerServicePath: string;
  /**
   * Absolute URL of ODATANO ASTRA, the analytics service. Default `<baseUrl>/odata/v4/analytics`,
   * which is where the gateway serves it; an own deployment sets ODATANO_ANALYTICS_URL to its
   * ASTRA instance (its own app on its own port), or leaves it and gets no analytics tools.
   */
  analyticsUrl: string;
  /** Request timeout in milliseconds. */
  timeoutMs: number;

  // ---- local building (build_sponsorable_transaction), all optional ----
  /** Caller seed (128 hex, a 64-byte BIP39 seed) for local building and swaps; never a tool argument. */
  seedHex?: string;
  /** Where the seed is kept when NIGHTGATE_SEED_HEX is unset; default ~/.nightgate-mcp/seed. */
  seedFile?: string;
  /** Midnight network the builder targets; default preprod. */
  network: string;
  /** A Midnight indexer and node for the builders to read the chain from. Without them the NIGHTGATE API is read. */
  indexerHttpUrl?: string;
  indexerWsUrl?: string;
  nodeUrl?: string;
  /** Where the prover keys of the default lineage come from; default `<baseUrl>/zk-config/attestation-vault-32`. */
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

  // ---- call_contract ----
  /** The lineage packages call_contract may load, from NIGHTGATE_CALL_PACKAGES; every installed one when unset. */
  callPackages?: string[];
}

/** True for a host that never leaves the machine. */
function loopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || hostname === '::1' || /^127\./.test(hostname);
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
  const analyticsUrl = (env.ODATANO_ANALYTICS_URL || `${baseUrl}/odata/v4/analytics`).replace(/\/+$/, '');
  const token = env.ODATANO_ACCESS_KEY || undefined;
  const username = env.ODATANO_ACCESS_USER || undefined;
  for (const [name, url] of [['ODATANO_ACCESS_URL', baseUrl], ['ODATANO_ANALYTICS_URL', analyticsUrl]] as const) {
    let host: URL;
    try { host = new URL(url); } catch { throw new Error(`Invalid ${name}: ${url}`); }
    if (host.protocol === 'http:' && (token || username) && !loopback(host.hostname) && env.NIGHTGATE_ALLOW_PLAIN_HTTP !== '1') {
      throw new Error(`${name} ${url} is plain http: the key or password would travel unencrypted. Use https, or set NIGHTGATE_ALLOW_PLAIN_HTTP=1 for a network you trust`);
    }
  }
  const callPackages = (env.NIGHTGATE_CALL_PACKAGES ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  const servicePath = env.NIGHTGATE_SERVICE_PATH ?? '/odata/v4/midnight';
  const direct = !!username || !!token?.startsWith('ngat_');
  return {
    baseUrl,
    token,
    username,
    password: env.ODATANO_ACCESS_PASSWORD || undefined,
    servicePath,
    verifyServicePath: env.NIGHTGATE_VERIFY_SERVICE_PATH ?? (direct ? servicePath : '/odata/v4/midnight-verify'),
    indexerServicePath: env.NIGHTGATE_INDEXER_SERVICE_PATH ?? '/odata/v4/midnight-indexer',
    analyticsUrl,
    timeoutMs,
    seedHex,
    seedFile: env.NIGHTGATE_SEED_FILE || undefined,
    network,
    indexerHttpUrl: env.NIGHTGATE_INDEXER_HTTP_URL || undefined,
    indexerWsUrl: env.NIGHTGATE_INDEXER_WS_URL || undefined,
    nodeUrl: env.NIGHTGATE_NODE_URL || undefined,
    zkConfigBaseUrl: env.NIGHTGATE_ZK_CONFIG_BASE_URL || undefined,
    zkCacheDir: env.NIGHTGATE_ZK_CACHE_DIR || undefined,
    proofServerUrl: env.NIGHTGATE_PROOF_SERVER_URL || undefined,
    swapStateFile: env.NIGHTGATE_SWAP_STATE_FILE || undefined,
    swapMaxInputs,
    ...(callPackages.length ? { callPackages } : {}),
  };
}

/** The NIGHTGATE connection as the txbuilder's `api` option takes it: same host, same credentials. */
export function apiConnectOptions(config: NightgateMcpConfig): Record<string, unknown> {
  const agent = config.token?.startsWith('ngat_');
  return {
    baseUrl: config.baseUrl,
    servicePath: config.servicePath,
    indexerServicePath: config.indexerServicePath,
    timeoutMs: config.timeoutMs,
    ...(agent ? { agentToken: config.token } : config.token ? { token: config.token } : {}),
    ...(config.username && (agent || !config.token) ? { username: config.username, password: config.password } : {}),
  };
}

/** True when the process wallet has an indexer to sync from: a configured one, or the gateway's lane for a gateway key. */
export function canSyncWallet(config: NightgateMcpConfig): boolean {
  return Boolean(config.indexerHttpUrl && config.indexerWsUrl) || isGatewayKey(config);
}

/** The indexer the process wallet syncs from: the configured one, else the gateway's indexer lane; null when there is none. */
export async function walletIndexer(config: NightgateMcpConfig): Promise<{ indexerHttpUrl: string; indexerWsUrl: string } | null> {
  if (config.indexerHttpUrl && config.indexerWsUrl) return { indexerHttpUrl: config.indexerHttpUrl, indexerWsUrl: config.indexerWsUrl };
  if (!isGatewayKey(config)) return null;
  const gatewayIndexerUrls = await txExport<(api: Record<string, unknown>) => { indexerHttpUrl: string; indexerWsUrl: string } | null>('gatewayIndexerUrls', 'the wallet sync through the gateway', '0.20.0');
  return gatewayIndexerUrls({ baseUrl: config.baseUrl, token: config.token });
}

/** What a wallet sync needs that this server does not have. */
export const NO_INDEXER = 'the wallet has no indexer to sync its coins from: use a gateway key (oda_…), or set NIGHTGATE_INDEXER_HTTP_URL and NIGHTGATE_INDEXER_WS_URL for a direct instance';

/**
 * Where a local builder reads contract state: the configured indexer and node, else the NIGHTGATE API.
 * With `sync` the builder also syncs its own NIGHT coins from that indexer.
 */
export function builderChainOptions(
  config: NightgateMcpConfig,
  sync?: { walletSync: 'coins'; indexer: { indexerHttpUrl: string; indexerWsUrl: string } },
): Record<string, unknown> {
  const walletSync = sync?.walletSync ?? false;
  if (config.indexerHttpUrl && config.indexerWsUrl && config.nodeUrl) {
    return { indexerHttpUrl: config.indexerHttpUrl, indexerWsUrl: config.indexerWsUrl, nodeUrl: config.nodeUrl, walletSync };
  }
  return { api: apiConnectOptions(config), walletSync, ...(sync ? sync.indexer : {}) };
}

/** The shared sandbox vaults of the hosted gateway, one per testnet (attestation-vault-32). */
export const SANDBOX_VAULTS: Readonly<Record<string, string>> = {
  preprod: 'ca0b1e3c601857a7b6940bbbbd6508654f5983b63aa36ccf8254f7700f89aead',
  preview: '31df87bc396ab32e8408b0ebfd1f8e7bf121f17e12e2ba360ed9f08c7ba40692',
};

/** The vault a call targets: the given address, else the sandbox vault of the network. */
export function vaultOf(config: NightgateMcpConfig, contractAddress?: string, compiledArtifactRef?: string): string {
  if (contractAddress) return contractAddress.toLowerCase();
  if (compiledArtifactRef && compiledArtifactRef !== 'attestation-vault-32') {
    throw new Error(`the sandbox vaults are attestation-vault-32: pass contractAddress for a '${compiledArtifactRef}' vault`);
  }
  const sandbox = SANDBOX_VAULTS[config.network];
  if (!sandbox) throw new Error(`contractAddress is required on ${config.network}: there is no sandbox vault there`);
  return sandbox;
}

/** True for a key of the hosted gateway, which reports its units on GET /me. */
export function isGatewayKey(config: NightgateMcpConfig): boolean {
  return !!config.token?.startsWith('oda_');
}
