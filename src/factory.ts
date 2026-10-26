// Local minting on a token factory. The issuer secret is derived from the caller seed, the mint is built here,
// and only the fee-unpaid transaction goes to a sponsor. Needs @odatano/contract-token-factory next to the package.
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { builderChainOptions, type NightgateMcpConfig } from './config.js';
import { txExport } from './tx-module.js';
import { seedIdentity } from './builder.js';
import { ensureSeed } from './seed.js';

const FACTORY_PACKAGE = '@odatano/contract-token-factory';
const HERE = dirname(fileURLToPath(import.meta.url));

export interface MintInput {
  contractAddress: string;
  name: string;
  amount: string;
  /** Default: this wallet's own coin public key. */
  recipientCoinPublicKey?: string;
  /** Required with a recipient other than this wallet. */
  recipientEncryptionPublicKey?: string;
}

export interface MintBuild {
  unboundTxB64: string;
  tokenType: string;
  domain: string;
  issuerKey: string;
  recipientCoinPublicKey: string;
  serializedBytes: number;
  buildMs: number;
}

let factoryModule: Promise<any> | undefined;
let builder: Promise<any> | undefined;

async function loadFactoryModule(): Promise<any> {
  factoryModule ??= import(FACTORY_PACKAGE).catch((err) => {
    factoryModule = undefined;
    throw new Error(
      `minting needs ${FACTORY_PACKAGE} next to the MCP server (npm install ${FACTORY_PACKAGE}): ` +
      (err instanceof Error ? err.message : String(err)),
    );
  });
  return factoryModule;
}

/** One builder per process; the package resolves from this install, not the caller's cwd. */
async function getFactoryBuilder(config: NightgateMcpConfig): Promise<any> {
  builder ??= (async () => {
    const createTxBuilder = await txExport<(opts: Record<string, unknown>) => Promise<any>>('createTxBuilder', 'minting', '0.12.2');
    const opts: Record<string, unknown> = {
      seedHex: config.seedHex,
      networkId: config.network,
      ...builderChainOptions(config),
      package: FACTORY_PACKAGE,
      from: HERE,
    };
    if (config.proofServerUrl) {
      opts.provingMode = 'server';
      opts.proofServerUrl = config.proofServerUrl;
    }
    return createTxBuilder(opts);
  })();
  builder.catch(() => { builder = undefined; });
  return builder;
}

/** Build, prove and sign a mint locally; unbound, for sponsor_unbound_transaction. */
export async function buildMint(config: NightgateMcpConfig, input: MintInput): Promise<MintBuild> {
  const seedHex = await ensureSeed(config);
  const t0 = Date.now();
  const self = await seedIdentity(config);
  const recipient = (input.recipientCoinPublicKey ?? self.coinPublicKey).toLowerCase();
  const foreign = recipient !== self.coinPublicKey.toLowerCase();
  if (foreign && !input.recipientEncryptionPublicKey) {
    throw new Error('minting to another wallet needs recipientEncryptionPublicKey as well: both keys of that wallet, as its get_attester_identity reports them');
  }
  const [issuerSecretOf, prepareMint, tokenTypeOf] = await Promise.all([
    txExport<(opts: { seedHex: string }) => Promise<string>>('tokenFactoryIssuerSecret', 'minting', '0.10.2'),
    txExport<(input: Record<string, unknown>) => unknown>('prepareMint', 'minting', '0.10.2'),
    txExport<(pure: unknown, input: Record<string, unknown>) => Promise<{ issuer: string; domain: string; type: string }>>('tokenTypeOf', 'minting', '0.10.2'),
  ]);
  const { pureCircuits } = await loadFactoryModule();
  const issuerSecret = await issuerSecretOf({ seedHex });
  const contractAddress = input.contractAddress.toLowerCase();
  const { issuer, domain, type } = await tokenTypeOf(pureCircuits, { issuerSecret, name: input.name, contractAddress });
  const b = await getFactoryBuilder(config);
  const built = await b.buildSponsorable({
    contractAddress,
    call: prepareMint({ name: input.name, amount: input.amount, recipientCoinPublicKey: recipient, issuerSecret }),
    ...(foreign ? { recipients: [{ coinPublicKey: recipient, encryptionPublicKey: String(input.recipientEncryptionPublicKey).toLowerCase() }] } : {}),
    bind: false,
  });
  return {
    unboundTxB64: String(built.unboundTxB64),
    tokenType: type,
    domain,
    issuerKey: issuer,
    recipientCoinPublicKey: recipient,
    serializedBytes: Number(built.serializedBytes ?? 0),
    buildMs: Date.now() - t0,
  };
}

/** Test seam / shutdown. */
export async function closeFactoryBuilder(): Promise<void> {
  const open = builder;
  builder = undefined;
  if (open) {
    try { await (await open).close?.(); } catch { /* best effort */ }
  }
}
