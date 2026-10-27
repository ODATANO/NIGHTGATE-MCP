// Builds, proves and signs a vault call here with the caller seed, via the @odatano/nightgate-tx txbuilder.
// The seed and the attestation secret never travel; the sponsor tools submit the fee-unpaid result.
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { builderChainOptions, type NightgateMcpConfig } from './config.js';
import { txExport } from './tx-module.js';
import { holdBuilt, writeTxFile, type TxBytesInfo } from './built.js';
import { ensureSeed } from './seed.js';
import { setStage } from './jobs.js';

/**
 * Call kinds this tool can prepare; one per attestation-vault helper.
 *
 * The prove* entries are what lets a third party make a ZK claim with NO
 * wallet on the server: the witness (the field value, its salt, the
 * inclusion path) is consumed here in the caller's own process and only the
 * finished transaction travels. The server-side `issueField*Attestation`
 * actions do the same work with a SERVER wallet as the attester, which is
 * the wrong shape for anyone but the operator: it would put someone else's
 * key in our custody and stamp every claim with the same attester id.
 */
export const BUILDABLE_CALLS = [
  'attest',
  'anchorContentRoot',
  'grantDisclosure',
  'revokeDisclosure',
  'registerPassport',
  'bindPassport',
  'proveFieldPredicate',
  'proveFieldEquality',
  'proveFieldMembership',
  'proveFieldsUnchangedExcept',
  'proveFieldsDiffer',
] as const;
export type BuildableCall = (typeof BUILDABLE_CALLS)[number];

/**
 * Vault lineages the local builder can load. Each needs its OWN compiled
 * contract class and its own `/zk-config`, because the width is baked into
 * the circuits. Picking the lineage also sets the slot width the prove*
 * calls fold their inclusion paths over (16 or 32), so the address and the
 * ref must belong together.
 */
export const BUILDABLE_ARTIFACTS = ['attestation-vault', 'attestation-vault-32'] as const;
export type BuildableArtifact = (typeof BUILDABLE_ARTIFACTS)[number];
export const DEFAULT_ARTIFACT: BuildableArtifact = 'attestation-vault-32';

export interface BuildInput {
  contractAddress: string;
  call: BuildableCall;
  params: Record<string, string | number>;
  bind: boolean;
  compiledArtifactRef?: BuildableArtifact;
  /**
   * WITNESS material for the prove* calls, exactly as prepare_document_proof
   * returns it per field. Never persisted, never sent to the server: it is
   * consumed by the local prover and only the proof leaves this process.
   */
  merkleProof?: Record<string, unknown>;
  /** Cross-root witness bundle { schema, openingA, openingB } for the two comparison calls. */
  docPair?: Record<string, unknown>;
  /** Where to write the built bytes as base64, for a hand-over outside this process. */
  outFile?: string;
}

export interface BuildOutput extends TxBytesInfo {
  channel: 'unbound' | 'bound';
  file?: string;
  attesterId: string;
  provingMode: string;
  serializedBytes: number;
  buildMs: number;
  /** Builder setup; includes the prover key download on the first call. */
  setupMs: number;
  /** Building, proving and signing the call. */
  proveMs: number;
}

interface TxModules {
  createTxBuilder: (opts: any) => Promise<any>;
  computeRecordKey: (attesterId: string, payloadHash: string) => string;
  calls: Record<string, (input: Record<string, unknown>) => unknown>;
  Contract: unknown;
}

const modules = new Map<BuildableArtifact, Promise<TxModules>>();
const builders = new Map<BuildableArtifact, Promise<any>>();

async function loadModules(ref: BuildableArtifact = DEFAULT_ARTIFACT): Promise<TxModules> {
  let entry = modules.get(ref);
  if (!entry) {
    entry = (async (): Promise<TxModules> => {
      try {
        const [tx, calls, vault] = await Promise.all([
          import('@odatano/nightgate-tx/txbuilder'),
          import('@odatano/nightgate-tx/calls'),
          ref === 'attestation-vault-32'
            ? import('@odatano/nightgate-tx/attestation-vault-32')
            : import('@odatano/nightgate-tx/attestation-vault'),
        ]);
        return {
          createTxBuilder: tx.createTxBuilder as any,
          computeRecordKey: (tx as any).computeRecordKey,
          calls: calls as any,
          Contract: (vault as any).Contract,
        };
      } catch (err) {
        modules.delete(ref);
        throw new Error(
          `local building of '${ref}' needs @odatano/nightgate-tx >= 0.12.2 next to the MCP server ` +
          '(npm install @odatano/nightgate-tx): ' + (err instanceof Error ? err.message : String(err)),
        );
      }
    })();
    modules.set(ref, entry);
  }
  return entry;
}

/**
 * One builder per VAULT LINEAGE (the seed is fixed, the circuits are not);
 * created on first use. A 16-slot and a 32-slot vault need different
 * contract classes, different prover keys and therefore separate cache
 * directories, so they cannot share an instance.
 */
async function getBuilder(config: NightgateMcpConfig, ref: BuildableArtifact = DEFAULT_ARTIFACT): Promise<any> {
  await ensureSeed(config);
  let entry = builders.get(ref);
  if (!entry) {
    entry = (async () => {
      const { createTxBuilder, Contract } = await loadModules(ref);
      const network = config.network;
      // An explicit zkConfigBaseUrl pins ONE lineage, so it only applies to
      // the default ref; anything else derives its own from the server.
      const zkBase = ref === DEFAULT_ARTIFACT && config.zkConfigBaseUrl
        ? config.zkConfigBaseUrl
        : `${config.baseUrl}/zk-config/${ref}`;
      const opts: Record<string, unknown> = {
        seedHex: config.seedHex,
        networkId: network,
        ...builderChainOptions(config),
        zkConfigBaseUrl: zkBase,
        contractClass: Contract,
        contractName: ref,
        cacheDir: join(config.zkCacheDir ?? join(tmpdir(), 'nightgate-mcp-zk'), ref),
      };
      if (config.proofServerUrl) {
        opts.provingMode = 'server';
        opts.proofServerUrl = config.proofServerUrl;
      }
      try {
        return await createTxBuilder(opts);
      } catch (err) {
        builders.delete(ref);
        throw err;
      }
    })();
    builders.set(ref, entry);
  }
  return entry;
}

function hexParam(params: Record<string, string | number>, key: string): string {
  const v = params[key];
  if (typeof v !== 'string' || !/^[0-9a-fA-F]{64}$/.test(v)) throw new Error(`params.${key} must be 64 hex characters`);
  return v.toLowerCase();
}

/**
 * Map the tool's flat params onto the typed prepare* helper of the call kind.
 * The proof helpers take the RECORD KEY of the document they prove against:
 * `recordKey` as given, else recordKey(attesterId ?? this builder, payloadHash).
 */
function prepareCall(mods: TxModules, input: BuildInput, attestationSecret: Uint8Array, ownAttesterId: string): unknown {
  const { calls } = mods;
  const p = input.params;
  const slotWidth = (input.compiledArtifactRef ?? DEFAULT_ARTIFACT) === 'attestation-vault-32' ? 32 : 16;
  const recordKeyOf = (keyName: string, payloadName: string, attesterName: string): string => {
    if (typeof p[keyName] === 'string') return hexParam(p, keyName);
    const attester = typeof p[attesterName] === 'string' ? hexParam(p, attesterName) : ownAttesterId;
    return mods.computeRecordKey(attester, hexParam(p, payloadName));
  };
  const recordKey = () => recordKeyOf('recordKey', 'payloadHash', 'attesterId');
  const recordKeyA = () => recordKeyOf('recordKeyA', 'payloadHashA', 'attesterIdA');
  const recordKeyB = () => {
    if (typeof p.recordKeyB === 'string') return hexParam(p, 'recordKeyB');
    const attester = typeof p.attesterIdB === 'string' ? hexParam(p, 'attesterIdB')
      : typeof p.attesterIdA === 'string' ? hexParam(p, 'attesterIdA') : ownAttesterId;
    return mods.computeRecordKey(attester, hexParam(p, 'payloadHashB'));
  };
  const witness = (what: string) => {
    if (!input.merkleProof) throw new Error(`call '${input.call}' needs merkleProof (${what}); take it from prepare_document_proof`);
    return input.merkleProof as any;
  };
  const pair = () => {
    if (!input.docPair) throw new Error(`call '${input.call}' needs docPair { schema, openingA, openingB } from prepare_document_proof`);
    return input.docPair as any;
  };
  switch (input.call) {
    case 'proveFieldPredicate': {
      const op = Number(p.op);
      if (![0, 1].includes(op)) throw new Error('params.op must be 0 (lessOrEqual) or 1 (greaterOrEqual)');
      return calls.prepareProveFieldPredicate({
        recordKey: recordKey(), fieldKey: hexParam(p, 'fieldKey'),
        threshold: BigInt(p.threshold as string | number), op: BigInt(op),
        merkleProof: witness('fieldValue, fieldSalt, siblings, dirs'), attestationSecret, slotWidth,
      } as any);
    }
    case 'proveFieldEquality':
      return calls.prepareProveFieldEquality({
        recordKey: recordKey(), fieldKey: hexParam(p, 'fieldKey'),
        expectedDigest: hexParam(p, 'expectedDigest'),
        merkleProof: witness('fieldSalt, siblings, dirs'), attestationSecret, slotWidth,
      } as any);
    case 'proveFieldMembership':
      return calls.prepareProveFieldMembership({
        recordKey: recordKey(), fieldKey: hexParam(p, 'fieldKey'),
        setRoot: hexParam(p, 'setRoot'),
        merkleProof: witness('fieldDigest, fieldSalt, siblings, dirs, setProof'), attestationSecret, slotWidth,
      } as any);
    case 'proveFieldsUnchangedExcept':
      return calls.prepareProveFieldsUnchangedExcept({
        recordKeyA: recordKeyA(), recordKeyB: recordKeyB(),
        allowedMask: Number(p.allowedMask), docPair: pair(), attestationSecret, slotWidth,
      } as any);
    case 'proveFieldsDiffer':
      return calls.prepareProveFieldsDiffer({
        recordKeyA: recordKeyA(), recordKeyB: recordKeyB(),
        k: Number(p.k), docPair: pair(), attestationSecret, slotWidth,
      } as any);
    case 'attest':
      return calls.prepareAttest({ payloadHash: hexParam(p, 'payloadHash'), metadataHash: hexParam(p, 'metadataHash'), attestationSecret });
    case 'anchorContentRoot':
      return calls.prepareAnchorContentRoot({ payloadHash: hexParam(p, 'payloadHash'), contentRoot: hexParam(p, 'contentRoot'), schemaId: hexParam(p, 'schemaId'), attestationSecret });
    case 'grantDisclosure': {
      const level = Number(p.level);
      if (![0, 1, 2].includes(level)) throw new Error('params.level must be 0, 1 or 2');
      return calls.prepareGrantDisclosure({ payloadHash: hexParam(p, 'payloadHash'), grantee: hexParam(p, 'grantee'), level, attestationSecret });
    }
    case 'revokeDisclosure':
      return calls.prepareRevokeDisclosure({ payloadHash: hexParam(p, 'payloadHash'), grantee: hexParam(p, 'grantee'), attestationSecret });
    case 'registerPassport':
      return calls.prepareRegisterPassport({ passportId: hexParam(p, 'passportId'), ownerId: hexParam(p, 'ownerId'), attestationSecret });
    case 'bindPassport':
      return calls.prepareBindPassport({ passportId: hexParam(p, 'passportId'), payloadHash: hexParam(p, 'payloadHash'), attestationSecret });
  }
}

/** Build + prove + sign locally; unbound (parallel channel) by default. */
export async function buildSponsorable(config: NightgateMcpConfig, input: BuildInput): Promise<BuildOutput> {
  const t0 = Date.now();
  const ref = input.compiledArtifactRef ?? DEFAULT_ARTIFACT;
  setStage('preparing the builder and prover keys');
  const b = await getBuilder(config, ref);
  const mods = await loadModules(ref);
  const t1 = Date.now();
  setStage('proving');
  const call = prepareCall(mods, input, b.attestationSecret, String(b.attesterId));
  const built = await b.buildSponsorable({ contractAddress: input.contractAddress, call, bind: input.bind ? true : false });
  const b64 = String(input.bind ? built.finalizedTxB64 : built.unboundTxB64);
  if (input.outFile) await writeTxFile(input.outFile, b64);
  const out: BuildOutput = {
    ...holdBuilt(b64),
    channel: input.bind ? 'bound' : 'unbound',
    ...(input.outFile ? { file: input.outFile } : {}),
    attesterId: String(b.attesterId),
    provingMode: String(b.provingMode ?? (config.proofServerUrl ? 'server' : 'wasm')),
    serializedBytes: Number(built.serializedBytes ?? 0),
    buildMs: Date.now() - t0,
    setupMs: t1 - t0,
    proveMs: Date.now() - t1,
  };
  return out;
}

const identities = new Map<string, Promise<SeedIdentity>>();

export interface SeedIdentity {
  attesterId: string;
  shieldedAddress: string;
  coinPublicKey: string;
  encryptionPublicKey: string;
}

/** The public identity of the seed, a pure derivation: no builder, no indexer, no zk assets. */
export async function seedIdentity(config: NightgateMcpConfig): Promise<SeedIdentity> {
  const seedHex = await ensureSeed(config);
  const key = `${config.network}:${seedHex.toLowerCase()}`;
  let entry = identities.get(key);
  if (!entry) {
    entry = (async () => {
      const deriveIdentity = await txExport<(opts: { seedHex: string; networkId: string }) => Promise<any>>('deriveIdentity', 'identity derivation', '0.8.0');
      const id = await deriveIdentity({ seedHex, networkId: config.network });
      return {
        attesterId: String(id.attesterId),
        shieldedAddress: String(id.addresses?.shielded ?? ''),
        coinPublicKey: String(id.shieldedKeys?.coinPublicKey ?? ''),
        encryptionPublicKey: String(id.shieldedKeys?.encryptionPublicKey ?? ''),
      };
    })();
    entry.catch(() => identities.delete(key));
    identities.set(key, entry);
  }
  return entry;
}

/** The caller's attester id (derived from the seed), without building anything. */
export async function attesterIdentity(config: NightgateMcpConfig): Promise<{
  attesterId: string; network: string; shieldedAddress?: string; coinPublicKey?: string; encryptionPublicKey?: string;
}> {
  const b = await getBuilder(config);
  return {
    attesterId: String(b.attesterId),
    network: config.network,
    ...(b.addresses?.shielded ? { shieldedAddress: String(b.addresses.shielded) } : {}),
    ...(b.shieldedKeys ? { coinPublicKey: String(b.shieldedKeys.coinPublicKey), encryptionPublicKey: String(b.shieldedKeys.encryptionPublicKey) } : {}),
  };
}

/** Test seam / shutdown: release every lineage's builder connections. */
export async function closeBuilder(): Promise<void> {
  const open = [...builders.values()];
  builders.clear();
  for (const b of open) {
    try { await (await b).close?.(); } catch { /* best effort */ }
  }
}
