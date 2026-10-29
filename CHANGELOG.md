# Changelog

All notable changes to `@odatano/nightgate-mcp` are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The README says which NIGHTGATE the current version needs.

## [Unreleased]

## [0.20.0] - 2026-10-28

Needs NIGHTGATE 0.36.0; `send_token`, directed offers and receipts need 0.39.0.

### Added

- **`send_token`.** A sponsored transfer of a shielded token from this wallet
  to another shielded address: built and proven here from the wallet's coins,
  handed to `sponsorTransfer`, the sponsor pays. The recipient needs nothing
  but its address. Needs `sponsorTransfer` in the grant and `@odatano/nightgate-tx`
  0.17.0, which comes with the package.
- **`burn_token`.** Burns an amount of a factory token this wallet holds;
  `issuerKey` names a token another issuer minted.
- **`call_contract`.** A circuit call on any contract whose lineage package is
  installed next to the server, with tagged arguments (`$bytes`, `$uint`,
  `$coin` for a shielded coin funded from this wallet), built here and
  sponsored.
- **Directed offers.** `post_swap_offer` with `directed: true` returns a
  `takerSecret`, shown once; `take_swap_offer` and `sponsor_swap` take
  `takerSecret`, and the sponsor refuses the swap without it. Board rows carry
  `directed`.
- **Receipts.** A landed swap or transfer carries `receipt` in its result:
  the instance's Ed25519 statement of the chain facts and the terms, checkable
  against the key the indexer service publishes under `getReceiptKey()`.

## [0.19.0] - 2026-10-28

Needs NIGHTGATE 0.36.0; `waitMs` needs 0.38.0.

### Added

- **The board waits.** `list_swap_offers` and `my_swap_offers` take `waitMs`
  (up to 25000): the server holds an empty answer until an offer matches or
  the time is up, so a watcher with `status: 'all'` and `since` makes one
  call per change instead of one per interval. Sent only when set, so an
  older server answers as before.
- **The wallet reports what is pending.** Each token row of `get_swap_wallet`
  carries `pending`, what the halves built here bring back once their swaps
  land (the change and the wanted coins). `balance` stays the free coins: a
  half can give only from `balance`, and while it can still land the wallet
  is worth `balance` plus `pending`. Needs `@odatano/nightgate-tx` 0.16.0,
  which comes with the package.

### Changed

- `zod` 4 and `@modelcontextprotocol/sdk` 1.32: the tool schemas are
  unchanged for callers; the install carries no known vulnerable package.

## [0.18.3] - 2026-10-27

Needs NIGHTGATE 0.36.0.

### Added

- **Stage timings for writes.** `anchor_document` and `submit_vault_call`
  return `timings`: `setupMs` and `proveMs` for the local build, `queueMs`,
  `sponsorMs` and `settleMs` from the job's timestamps.
- **Progress names the stage.** The progress messages say what runs, for
  example `proving` or `submitted, waiting for the block`, instead of
  `working`.

## [0.18.2] - 2026-10-27

Needs NIGHTGATE 0.36.0.

### Fixed

- **`get_swap_wallet` reads the posted offers in one call.** It settled each
  offer posted from this server with its own `getSwapOffer`, on every call.
  It now reads the caller's offers changed since the last read with one
  `listSwapOffers` (`mine`, `status: all`, `since`). A failed read or a full
  page falls back to the single reads.
- The MCP server reports the package version instead of a fixed one.

## [0.18.1] - 2026-10-26

Needs NIGHTGATE 0.36.0.

### Fixed

- **Writes from a fresh install.** `@odatano/nightgate-tx` ^0.15.1 installs one
  copy of `@midnight-ntwrk/onchain-runtime-v3`. Two copies failed every write
  after proving with `expected instance of StateValue`.

### Documentation

- `docs/tools.md`: how a client keeps a write open, and that the MCP Inspector
  CLI stops it after 60 seconds.
- README and `docs/tools.md`: servers on one machine share one seed file and
  so one identity unless each sets its own seed.

## [0.18.0] - 2026-10-26

Needs NIGHTGATE 0.36.0; from 0.37.0 the server holds each status read until the job settles.

### Changed

- **No tool takes a server wallet session.** Every write is built, proven and
  signed here with the caller seed, and a sponsor pays the fee.
- **Writes wait for their job.** `anchor_document`, `submit_vault_call`,
  `sponsor_unbound_transaction`, `sponsor_finalized_transaction`,
  `sponsor_swap`, `take_swap_offer` (`submit: true`) and `mint_token` return
  `status`, `txHash`, `transactionHash`, `result`, on failure `next`, and
  `check`, the free call that shows the effect on-chain. They send MCP progress
  every 5 seconds. A job still open after 5 minutes, or one whose status cannot
  be read, comes back as `pending` with its `jobId` and `txHash`.
- **A repeated call picks up its job.** The same write with the same arguments,
  after a client timeout or a `pending`, waits for the job it started instead
  of submitting again. A failed job is built anew.
- **`anchor_document(sha256, metadata?, contentRoot?, schemaId?)`** builds the
  attest call here; with a content root it anchors that too.
- **`contractAddress` is optional** on the vault tools: default the shared
  sandbox vault of the network (preprod `ca0b1e3c…`, preview `31df87bc…`); a
  16-slot `attestation-vault` needs its address.
- **Seed file.** Without `NIGHTGATE_SEED_HEX` the seed is read from
  `NIGHTGATE_SEED_FILE` (default `~/.nightgate-mcp/seed`) and created there on
  first use; that answer carries `seed: { created, file, meaning }`.
- **Free state reads.** `verify_attestation` and `verify_predicate` read the
  public verify service (`/odata/v4/midnight-verify`) without credentials,
  unless basic auth or an `ngat_` grant of a direct instance is set.
  `NIGHTGATE_VERIFY_SERVICE_PATH` overrides it.
- **`get_usage`** replaces `get_grant_usage`. With a gateway key it reads
  `GET /me`: units left, validity, usage and the cost of the last calls.
- `@odatano/nightgate-tx` is a dependency, no longer an optional peer.
- `verify_attestation` describes `bindingRegistered`.

### Added

- `submit_vault_call(call, params, merkleProof?, docPair?)`: any vault call in
  one go, with the calls and params of `build_sponsorable_transaction`.

### Removed

- `get_job_status`.
- The tools that needed a server wallet session: `attest_agent_output`,
  `prove_field_predicate`, `prove_field_equality`, `prove_field_membership`,
  `prove_field_predicates_batch`, `prove_document_integrity`,
  `prove_document_diff`, `grant_disclosure`, `revoke_disclosure`,
  `verify_document`, `verify_predicate_attestation`. The claims and the
  disclosure calls run through `submit_vault_call`.
- `sessionId` on `mint_token`.
- `grant_disclosure_to_holders`, `revoke_holder_disclosure`,
  `claim_disclosure`, `holder_claim_key`.

## [0.17.1] - 2026-10-25

Needs NIGHTGATE 0.36.0; `get_job_status` waits on the server from 0.37.0.

### Changed

- The errors for a missing `NIGHTGATE_SEED_HEX` name its format: 128 hex
  characters, a 64-byte BIP39 seed. Same wording in
  [docs/configuration.md](docs/configuration.md).

## [0.17.0] - 2026-10-25

Needs NIGHTGATE 0.36.0; `get_job_status` waits on the server from 0.37.0.

### Changed

- **`get_job_status` waits instead of polling.** It passes `waitMs` (default
  20000, at most 25000) and the server holds the call until the job settles;
  a server without `waitMs` is asked again without it. Tool descriptions say
  call instead of poll.
- **Explorer hash.** The descriptions name `transactionHash`, the hash
  explorers show, next to the ledger identifier `txHash` / `transactionId`.
- **Default vault lineage `attestation-vault-32`**, the lineage of the hosted
  sandbox vaults: the local builder, its prover keys and every tool that
  sends `compiledArtifactRef` use it when none is given. A 16-slot vault needs
  `compiledArtifactRef: 'attestation-vault'`.

## [0.16.0] - 2026-10-24

Needs NIGHTGATE 0.36.0 and `@odatano/nightgate-tx` 0.14.0.

### Changed

- **The proof tools send typed parameters.** `siblings`, `dirs`, `setSiblings`,
  `setDirs`, `allowedValues`, `claims`, `schema`, `openingA`, `openingB`,
  `document` and `proofFields` go to NIGHTGATE as arrays and objects; the
  `*Json` string parameters of NIGHTGATE 0.35 and below are not sent anymore.
  `post_swap_offer` sends `tags` as an array. Tool inputs are unchanged.

## [0.15.0] - 2026-10-19

Needs NIGHTGATE 0.35.0 and `@odatano/nightgate-tx` 0.14.0; analytics under `/odata/v4/analytics` (the gateway serves both names).

### Changed

- **The analytics URL defaults to `<ODATANO_ACCESS_URL>/odata/v4/analytics`**
  instead of `…/odata/v4/astra`. An ASTRA instance that still serves
  `/odata/v4/astra` needs `ODATANO_ANALYTICS_URL` set to that path.

## [0.14.0] - 2026-10-18

Needs NIGHTGATE 0.35.0 and `@odatano/nightgate-tx` 0.14.0 (the gateway serves both spellings).

### Changed

- The tools call NIGHTGATE under `/odata/v4/midnight` and
  `/odata/v4/midnight-indexer`. Against a server below 0.35.0 set
  `NIGHTGATE_SERVICE_PATH=/api/v1/nightgate` and
  `NIGHTGATE_INDEXER_SERVICE_PATH=/api/v1/indexer`.

## [0.13.0] - 2026-10-15

Needs NIGHTGATE 0.34.0 and `@odatano/nightgate-tx` 0.12.2.

### Added

- `get_grant_usage`: the key's jobs and its limits, the hour and day budgets
  and the rate classes with what is left.

### Changed

- A 429 from NIGHTGATE carries `retryAfterSeconds` from `Retry-After`, as a
  gateway 429 did already.

## [0.12.0] - 2026-10-13

Needs NIGHTGATE 0.33.0 and `@odatano/nightgate-tx` 0.12.2.

### Changed

- `build_sponsorable_transaction` and the local `mint_token` read contract
  state through the NIGHTGATE API (`createTxBuilder({ api })`); they dial no
  indexer and no node. `NIGHTGATE_INDEXER_HTTP_URL` and `NIGHTGATE_INDEXER_WS_URL`
  switch them back to a Midnight indexer.
- The swap wallet syncs from `NIGHTGATE_INDEXER_HTTP_URL` and
  `NIGHTGATE_INDEXER_WS_URL` only; without them the swap tools refuse with
  the two names instead of dialing the public indexer.
- `build_sponsorable_transaction` returns `txId` (sha256 of the bytes),
  `characters` and `bytes` instead of the base64; the bytes stay in the server
  process for one hour, `outFile` writes them to a path.
- `sponsor_unbound_transaction` and `sponsor_finalized_transaction` take `txId`
  or `file` (base64 text or raw bytes); the base64 argument remains for callers
  without either. The result carries `sent` with characters, bytes and `txId`.

## [0.11.0] - 2026-10-12

Needs NIGHTGATE 0.32.0.

### Changed

- `sponsor_finalized_transaction`, `sponsor_unbound_transaction`, `sponsor_swap`
  and `mint_token` take no `sponsorSessionId`: the server's sponsor pool pays,
  or the wallet session the agent grant is pinned to.
- `take_swap_offer`: `submit: true` hands both halves to the sponsor at once;
  it replaces the sponsor session id as the trigger.
- The platform pool id is gone from every tool description.

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
