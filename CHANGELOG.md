# Changelog

All notable changes to `@odatano/nightgate-mcp` are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The server compatibility table in the README says which NIGHTGATE each
version needs.

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
