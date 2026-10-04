# Changelog

All notable changes to `@odatano/nightgate-mcp` are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The README says which NIGHTGATE the current version needs.

## [Unreleased]

## [0.10.1] - 2026-10-03

### Fixed

- A maker half posted with `post_swap_offer` is tied to its `offerId`; `get_swap_wallet`
  lists it with `offerId` and `boardStatus` and drops it once the offer is `filled`
  (read through `get_swap_wallet`, `get_swap_offer`, `list_swap_offers`, `my_swap_offers`).
  An expired or retired offer keeps its half for `revert_swap_offer`.
- Board rows carry `tags` as the server sends them: an array from NIGHTGATE 0.30.3 on.

## [0.10.0] - 2026-10-02

### Added

- **Offer board** (NIGHTGATE 0.30.0): `post_swap_offer(offer, expiresAt?, tags?)`,
  `list_swap_offers(givesType?, wantsType?, tag?, limit?)`, `retire_swap_offer(offerId)`.
  `sponsor_swap` and `take_swap_offer` take an `offerId` from the board in place of the
  maker half: `take_swap_offer` reads the entry first and refuses before proving when it
  is closed or carries another offer; `sponsor_swap` pairs `offerId` with `takerHalf` or
  the `halfId` of a taken offer.
- **Board reads** (NIGHTGATE 0.30.1): `list_swap_offers(status?, since?)` reads closed
  offers and the change feed, `my_swap_offers(status?, since?, limit?)` the caller's own
  posts, `get_swap_offer(offerId)` one offer open or closed, `get_board_status()` the
  board's counts and sponsor readiness without credentials (indexer service,
  `NIGHTGATE_INDEXER_SERVICE_PATH`, default `/api/v1/indexer`).
- **`mint_token(contractAddress, name, amount, recipientCoinPublicKey?, recipientEncryptionPublicKey?, sponsorSessionId?, sessionId?, idempotencyKey?)`**:
  a token of your own name on a token factory. Without `sessionId` the seed is the issuer,
  the mint is built, proven and signed here (`@odatano/nightgate-tx` 0.10.2 on
  `@odatano/contract-token-factory`) and `sponsorUnboundTransaction` pays; with `sessionId`
  the server session mints (`mintFactoryToken`, NIGHTGATE 0.30.1). The recipient defaults
  to this wallet; another wallet takes both of its keys. The type is in the response.
- **Disclosure to token holders**: `grant_disclosure_to_holders(payloadHash, tokenType,
  registryAddress, content?, contentType?, expiresAt?)`, `revoke_holder_disclosure(holderGrantId)`,
  `claim_disclosure(payloadHash, tokenType, claimSecret)`, `holder_claim_key(claimSecret?)`.

### Changed

- Peer dependency `@odatano/nightgate-tx` `>=0.10.2` (`holderClaimKey`, `tokenFactoryIssuerSecret`); local building and swaps still run on 0.8.0. A missing or older install is reported per tool with the version it needs. Optional peer `@odatano/contract-token-factory` for local minting.
- `mint_token` derives the default recipient from the seed without starting the local builder.
- Amounts given as JS numbers must be safe integers; pass a decimal string for anything larger.
- Function calls pass an unused declared parameter as `null`.

## [0.9.0] - 2026-09-30

### Added

- **Shielded swap tools** (NIGHTGATE 0.29.0, `@odatano/nightgate-tx` 0.8.0):
  - `get_swap_wallet`: address, public keys, per token type balance, free coins and
    `spendable`; halves built here that have not landed.
  - `read_swap_offer`: `gives`, `wants`, `inputs`, `outputs`, `bound` of an offer file or
    base64 half, read from the transaction.
  - `build_swap_offer(give, want, bind?)`: one proven half, as offer file (`swapoffer1...`).
  - `take_swap_offer(offer, expect?, sponsorSessionId?, idempotencyKey?)`: the mirror half;
    with a sponsor session it submits both halves. A refusal carries `halfId`.
  - `sponsor_swap(makerHalf, takerHalf | halfId, sponsorSessionId, idempotencyKey?)`.
  - `revert_swap_offer(id)`: releases the coins of a half built here.
- `NIGHTGATE_SWAP_STATE_FILE`, `NIGHTGATE_SWAP_MAX_INPUTS`.
- `get_attester_identity` returns `shieldedAddress`, `coinPublicKey`, `encryptionPublicKey`.
- `npm run integration` covers the swap tools (`scripts/integration-swap.mjs`).

### Changed

- Peer dependency `@odatano/nightgate-tx` `>=0.8.0` (was `>=0.6.0`).
- Lockfile: one `@midnight-ntwrk/ledger-v8` (8.1.0) in the tree. Two copies made the local
  builder fail with `expected instance of DustParameters`.
- `live:sponsor-unbound` verifies with the attester id.
- `NIGHTGATE_SEED_HEX` is 128 hex (a 64-byte BIP39 seed); 64 hex is refused at startup.
- `get_job_status` describes the `swap` result of a swap job.

## [0.8.1] - 2026-09-27

### Changed

- `get_job_status` describes `chainSegments` (NIGHTGATE 0.28.0): for a confirmed batch,
  which calls applied. Tool errors carry the server's string `code` (`INVALID_ARGUMENT`, ...).
- README reorganized; compatibility names the current version only.

## [0.8.0] - 2026-09-23

### Added

- **Analytics tools over ODATANO ASTRA** (`analytics_overview`, `analytics_key_figures`,
  `analytics_daily`, `analytics_top_block_producers`, `analytics_metrics`, `analytics_metric`,
  `analytics_series`, `analytics_compare`, `analytics_anomalies`), registered when the host
  serves ASTRA at `ODATANO_ANALYTICS_URL` (default: the gateway's `/odata/v4/astra`). Same key,
  one unit per read, chain pinned to Midnight; `analytics_compare` puts Cardano next to it.

### Changed

- **Default gateway host is `https://api.preprod.odatano.dev`** (one host per
  network; `api.odatano.dev` now only redirects there with a 307). Node drops
  the `Authorization` header on a cross-host redirect, so the old default
  would answer 401 for every call: set `ODATANO_ACCESS_URL` explicitly on
  older versions, or upgrade. The missing-key warning fires for any
  `api.<network>.odatano.dev` host.

## [0.7.0] - 2026-09-20

### Changed (breaking)

- **One connection env for both ODATANO MCP servers.** `ODATANO_ACCESS_URL`
  (default `https://api.odatano.dev`, the gateway), `ODATANO_ACCESS_KEY`
  (the `oda_…` key, or an `ngat_…` grant / other bearer against a direct
  instance) and `ODATANO_ACCESS_USER` / `ODATANO_ACCESS_PASSWORD` (basic
  auth for a direct instance) replace `NIGHTGATE_BASE_URL`,
  `NIGHTGATE_TOKEN`, `NIGHTGATE_USERNAME` and `NIGHTGATE_PASSWORD`; the old
  names are not read any more. `@odatano/core-mcp` 0.3.0 reads the same
  four, so an `.mcp.json` needs one key for both chains and no URL. The
  other `NIGHTGATE_*` variables (network, seed, indexer, zk-config, proof
  server, timeout, service path) are unchanged.
- **Gateway error bodies reach the agent.** The ODATANO ACCESS gateway
  answers with `{ error: "<text>", ...detail }`; the client now keeps the
  text as the message and hands the detail (`unitsLeft`, `price`, the
  `topup` hint, `products`, `validUntil`, `retryAfterSeconds` from
  `Retry-After`) through to the tool error, so a 402 says how to top up
  instead of "request failed with HTTP 402".
- **The hosted API is the documented default.** README: quick start with a
  key from api.odatano.dev first, sponsoring through the gateway's platform
  pool, own instance second; the server warns at startup when the gateway
  is the target and no key is set. Server version constant follows the
  package.

## [0.6.1] - 2026-09-19

### Changed

- **The ODATANO ACCESS key (`oda_…`) is the documented credential.**
  `api.nightgate.dev` is the ODATANO ACCESS gateway since 2026-09-18: it
  meters the key in units, swaps in the NIGHTGATE agent grant underneath and
  fronts ODATANO with the same key. Set `NIGHTGATE_BASE_URL=https://api.nightgate.dev`
  and `NIGHTGATE_TOKEN=oda_…`; the key goes as a plain `Authorization: Bearer`.
  Get one at `POST https://api.odatano.dev/keys` (x402), from a giveaway
  code, or by signing in at the console. A raw `ngat_…` agent grant
  (`x-agent-token`) still works against a direct NIGHTGATE instance. No code
  change: the client already sent a prefix-less token as a bearer.
- `.env.example` and README updated accordingly; this changelog added and
  shipped with the package.

## [0.6.0] - 2026-09

### Changed (breaking)

- **Vault lineage 4: every record is keyed by attester AND payload**
  (NIGHTGATE >= 0.24.0). `verify_attestation` takes `attesterId` +
  `payloadHash` (or a bound `documentId`), `verify_predicate` takes
  `attesterId`, the `prove_*` tools accept an optional `attesterId` (the
  record the claim is proven against), `anchor_document` is one plain attest
  and returns `attesterId`.
- `prepare_anchor_commitment` and `commit_document_anchor` are gone: nothing
  is left to guard, no identity can take over another attester's record.
- Local building needs `@odatano/nightgate-tx` >= 0.6.0; the proof calls
  take `recordKey` or `payloadHash` (+ `attesterId`). Against a 0.23.x server
  the verify calls fail with 400 (unknown parameter).

## [0.5.1] - 2026-08-23

### Added

- **32-slot vault.** Schema and opening take 16 or 32 entries, `allowedMask`
  up to 32 bits, `k` up to 32; the vacuity guard is checked against the
  schema instead of a fixed all-ones constant. Target it with
  `compiledArtifactRef: 'attestation-vault-32'` (NIGHTGATE >= 0.19.0 for
  width 32). A 16-slot setup keeps working against any 0.18.x server.
- Local ZK claims: field and document proofs can be built in-process.

## [0.5.0] - 2026-08-19

### Added

- **Parallel sponsoring channel:** `sponsor_unbound_transaction` with the
  platform pool id (NIGHTGATE >= 0.18.0; 404 against older servers).
- **Local transaction building** for agents: `build_sponsorable_transaction`
  and `get_attester_identity` via the optional `@odatano/nightgate-tx`
  >= 0.2.0 txbuilder, driven by `NIGHTGATE_SEED_HEX` (never a tool argument).

## [0.3.0] - 2026-08-16

### Added

- Cross-root document proofs and guarded anchoring (`prepare_anchor_commitment`
  / `commit_document_anchor`, removed again in 0.6.0).

## [0.2.0] - 2026-08-10

### Added

- Membership and equality proof tools; README documents the tool set and the
  server compatibility table.

## [0.1.0] - 2026-08-07

### Added

- Initial MCP server: attestation, verification and job tools over the
  NIGHTGATE OData API, agent-grant (`ngat_…`) or basic auth.
