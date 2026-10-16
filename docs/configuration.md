# Configuration of @odatano/nightgate-mcp

Everything the server reads from its environment, how to point it at an own
NIGHTGATE instance, and which versions it needs.

## Variables

| Variable | Default | Purpose |
|---|---|---|
| `ODATANO_ACCESS_KEY` | unset | `oda_…` key, or an `ngat_…` agent grant on a direct instance |
| `ODATANO_ACCESS_URL` | `https://api.preprod.odatano.dev` | Gateway or a direct NIGHTGATE host |
| `ODATANO_ACCESS_USER` / `_PASSWORD` | unset | Basic auth of a direct instance |
| `NIGHTGATE_SEED_HEX` | unset | Seed (128 hex) for local building and swaps; never a tool argument |
| `NIGHTGATE_NETWORK` | `preprod` | Network of the local builder |
| `NIGHTGATE_INDEXER_HTTP_URL` / `_WS_URL` | unset | A Midnight indexer; the swap wallet syncs from it, the builders then read it instead of the API |
| `NIGHTGATE_PROOF_SERVER_URL` | unset | Prove on a proof server instead of in-process |
| `NIGHTGATE_SWAP_STATE_FILE` | unset | File for the swap wallet's state; it holds the wallet's coins, keep it like a key |
| `NIGHTGATE_SWAP_MAX_INPUTS` | `4` | Most coins one swap half spends; the sponsor's limit applies |
| `NIGHTGATE_TIMEOUT_MS` | `30000` | Per-request timeout |

Also: `NIGHTGATE_NODE_URL`, `NIGHTGATE_SERVICE_PATH`, `NIGHTGATE_INDEXER_SERVICE_PATH`,
`ODATANO_ANALYTICS_URL`, `NIGHTGATE_ZK_CONFIG_BASE_URL`, `NIGHTGATE_ZK_CACHE_DIR`.

## Own instance

```bash
docker run -d -p 4004:4004 -e ENCRYPTION_KEY=$(openssl rand -hex 32) \
  -e NIGHTGATE_HTTP_PASSWORD=change-me -v nightgate-data:/data ghcr.io/odatano/nightgate:latest
```

Then `ODATANO_ACCESS_URL=http://localhost:4004`, `ODATANO_ACCESS_USER=nightgate`,
`ODATANO_ACCESS_PASSWORD=change-me`. For agents, create a grant with
`createAgentGrant` and pass its `ngat_…` token as `ODATANO_ACCESS_KEY`.

## Compatibility

NIGHTGATE >= 0.34.0, which the hosted gateway runs. Local building needs
`@odatano/nightgate-tx` >= 0.12.2 next to the server, local minting also
`@odatano/contract-token-factory`. What an older server lacks per version:
[CHANGELOG](CHANGELOG.md).

Local building needs ONE `@midnight-ntwrk/ledger-v8` in the install
(`npm ls @midnight-ntwrk/ledger-v8`). `expected instance of ...` means two:
`npm dedupe`.
