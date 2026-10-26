# Configuration of @odatano/nightgate-mcp

Everything the server reads from its environment, how to point it at an own
NIGHTGATE instance, and which versions it needs.

## Variables

| Variable | Default | Purpose |
|---|---|---|
| `ODATANO_ACCESS_KEY` | unset | `oda_…` key, or an `ngat_…` agent grant on a direct instance |
| `ODATANO_ACCESS_URL` | `https://api.preprod.odatano.dev` | Gateway or a direct NIGHTGATE host |
| `ODATANO_ACCESS_USER` / `_PASSWORD` | unset | Basic auth of a direct instance |
| `NIGHTGATE_SEED_HEX` | unset | Seed for local building and swaps: 128 hex characters, a 64-byte BIP39 seed; never a tool argument |
| `NIGHTGATE_SEED_FILE` | `~/.nightgate-mcp/seed` | Where the seed is kept when `NIGHTGATE_SEED_HEX` is unset; created on first use, readable by the owner only |
| `NIGHTGATE_NETWORK` | `preprod` | Network of the local builder |
| `NIGHTGATE_INDEXER_HTTP_URL` / `_WS_URL` | unset | A Midnight indexer; the swap wallet syncs from it, the builders then read it instead of the API |
| `NIGHTGATE_PROOF_SERVER_URL` | unset | Prove on a proof server instead of in-process |
| `NIGHTGATE_SWAP_STATE_FILE` | unset | File for the swap wallet's state; it holds the wallet's coins, keep it like a key |
| `NIGHTGATE_SWAP_MAX_INPUTS` | `4` | Most coins one swap half spends; the sponsor's limit applies |
| `NIGHTGATE_TIMEOUT_MS` | `30000` | Per-request timeout |

Also: `NIGHTGATE_NODE_URL`, `NIGHTGATE_SERVICE_PATH` (`/odata/v4/midnight`),
`NIGHTGATE_VERIFY_SERVICE_PATH` (the state reads; `/odata/v4/midnight-verify`,
the service path when `ODATANO_ACCESS_USER` or an `ngat_` grant is set),
`NIGHTGATE_INDEXER_SERVICE_PATH` (`/odata/v4/midnight-indexer`; a server below
0.35.0 needs `/api/v1/nightgate` and `/api/v1/indexer`), `ODATANO_ANALYTICS_URL`,
`NIGHTGATE_ZK_CONFIG_BASE_URL` (prover keys of `attestation-vault-32`; default
`<base>/zk-config/attestation-vault-32`), `NIGHTGATE_ZK_CACHE_DIR`.

## Own instance

```bash
docker run -d -p 4004:4004 -e ENCRYPTION_KEY=$(openssl rand -hex 32) \
  -e NIGHTGATE_HTTP_PASSWORD=change-me -v nightgate-data:/data ghcr.io/odatano/nightgate:latest
```

Then `ODATANO_ACCESS_URL=http://localhost:4004`, `ODATANO_ACCESS_USER=nightgate`,
`ODATANO_ACCESS_PASSWORD=change-me`. For agents, create a grant with
`createAgentGrant` and pass its `ngat_…` token as `ODATANO_ACCESS_KEY`.
Writes need a sponsor on that instance: its sponsor pool pays for every
sponsored call.

## Compatibility

NIGHTGATE >= 0.36.0; from 0.37.0 the server holds each status read until the
job settles; an older server is asked every few seconds. The hosted gateway
runs 0.37.0. `@odatano/nightgate-tx`
comes with the package; minting also needs `@odatano/contract-token-factory`
next to it. The free state reads need `NIGHTGATE_PUBLIC_VERIFY=true` on an own
instance that is reached without credentials. What an older server lacks per version:
[CHANGELOG](CHANGELOG.md).

Local building needs ONE `@midnight-ntwrk/ledger-v8` in the install
(`npm ls @midnight-ntwrk/ledger-v8`). `expected instance of ...` means two:
`npm dedupe`.
