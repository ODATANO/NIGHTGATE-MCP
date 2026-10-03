<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://cdn.jsdelivr.net/npm/@odatano/brand@1/logos/nightgate-mcp-logo.svg">
    <img src="https://cdn.jsdelivr.net/npm/@odatano/brand@1/logos/nightgate-mcp-logo-on-light.svg" alt="NIGHTGATE MCP" height="84">
  </picture>
</p>

# @odatano/nightgate-mcp

[![npm](https://img.shields.io/npm/v/@odatano/nightgate-mcp)](https://www.npmjs.com/package/@odatano/nightgate-mcp)
[![NIGHTGATE](https://img.shields.io/badge/NIGHTGATE-%3E%3D%200.24.0-4b0082)](https://www.npmjs.com/package/@odatano/nightgate)
[![MCP](https://img.shields.io/badge/MCP-server-2ea44f)](https://modelcontextprotocol.io/)
[![License](https://img.shields.io/badge/license-Apache--2.0-yellow)](LICENSE)

MCP server for [NIGHTGATE](https://github.com/ODATANO/NIGHTGATE), the Midnight
attestation layer: anchor documents, prove zero-knowledge claims over hidden
fields, manage disclosure grants, verify against live contract state. Agents
write through fee sponsoring: they build and prove locally, a sponsor pays.

## Quick start

Get an `oda_…` key at [api.preprod.odatano.dev](https://api.preprod.odatano.dev)
(Cardano wallet sign-in, giveaway code, or tADA over x402), then:

```json
{
  "mcpServers": {
    "nightgate": {
      "command": "npx",
      "args": ["-y", "@odatano/nightgate-mcp"],
      "env": { "ODATANO_ACCESS_KEY": "oda_..." }
    }
  }
}
```

Claude Code: `claude mcp add nightgate --env ODATANO_ACCESS_KEY=oda_... -- npx -y @odatano/nightgate-mcp`

The hosted gateway is the default (Midnight preprod). The same key works for
`@odatano/core-mcp` (Cardano). Node.js >= 20.

## Tools

| Tool | What it does |
|---|---|
| `verify_attestation`, `verify_predicate`, `verify_predicate_attestation`, `verify_document` | Check records and ZK claims against live contract state; absent = `verified: false` |
| `prepare_document_proof`, `prepare_membership_set` | Build proof inputs: salted content tree, set root |
| `anchor_document`, `attest_agent_output` | Anchor a document hash or an agent-output envelope (async) |
| `prove_field_predicate`, `prove_field_equality`, `prove_field_membership` | ZK claims over one hidden field (async) |
| `prove_field_predicates_batch` | Up to 8 claims in one transaction (async) |
| `prove_document_integrity`, `prove_document_diff` | ZK claims across two documents (async) |
| `grant_disclosure`, `revoke_disclosure` | On-chain disclosure ACL (async) |
| `build_sponsorable_transaction`, `get_attester_identity` | Build, prove and sign locally; the attester id and shielded keys it builds under |
| `sponsor_unbound_transaction`, `sponsor_finalized_transaction` | Hand locally built bytes to a sponsor that pays and submits (async) |
| `get_swap_wallet`, `read_swap_offer` | Shielded coins of the local wallet; what an offer gives and wants |
| `build_swap_offer`, `take_swap_offer`, `revert_swap_offer` | Build one half of a shielded swap locally, take an offer, release a half |
| `sponsor_swap` | Hand both halves of a swap, or a board offer plus the taker half, to a sponsor that merges, pays and submits (async) |
| `post_swap_offer`, `list_swap_offers`, `retire_swap_offer` | The server's offer board: post a maker half, find open offers, take yours down |
| `get_swap_offer`, `my_swap_offers`, `get_board_status` | Follow one offer, see your own posts and their fills, read the board's counts without credentials |
| `mint_token` | Mint a shielded token with a name of your own on a token factory: built here with the seed as issuer and sponsored, or by a server session (async) |
| `grant_disclosure_to_holders`, `revoke_holder_disclosure`, `claim_disclosure`, `holder_claim_key` | Disclose a document to the holders of a token; read it with the secret behind a registered claim key |
| `derive_token_type` | Token type a minting contract produces |
| `get_job_status` | Poll an async job; batches report `chainSegments`, swaps `swap` |
| `analytics_*` | Midnight aggregates via ODATANO ASTRA, when the host serves it |

Errors carry the server's HTTP status and `code` (`INVALID_ARGUMENT`, ...).

## Fee sponsoring

1. `build_sponsorable_transaction` builds and proves the call locally (needs
   `@odatano/nightgate-tx` installed next to the server and `NIGHTGATE_SEED_HEX`).
2. `sponsor_unbound_transaction` with a sponsor session id or the platform pool
   id `00000000-0000-0000-0000-706f6f6c0000`.
3. `get_job_status` with the returned `sessionId`, then `verify_attestation`.

`failed` / `CHAIN_EXECUTION_FAILED`: landed but not applied; build again, never
resubmit the same bytes.

## Shielded swaps

Two wallets exchange two shielded tokens without a contract. Each side builds
one half, the halves mirror each other, a sponsor merges them and pays the fee.
Needs `@odatano/nightgate-tx` >= 0.8.0 next to the server and `NIGHTGATE_SEED_HEX`.

1. `get_swap_wallet`: balance, free coins and `spendable` per token type. The
   first call starts the sync of the shielded coins (about 5 minutes from
   genesis, seconds with `NIGHTGATE_SWAP_STATE_FILE`).
2. Maker: `build_swap_offer` with `give` and `want` returns the offer file
   (`swapoffer1...`) to publish, or `post_swap_offer` puts it on the server's
   board.
3. Taker: `list_swap_offers` or `read_swap_offer`, then `take_swap_offer` with
   `expect`, a `sponsorSessionId` and, for a board entry, its `offerId`. It
   builds the mirror half and submits both.
4. `get_job_status` with the returned `sessionId`; the result carries `swap`.
   The maker follows the offer with `get_swap_offer` or `my_swap_offers`
   (`filled` + `filledTxHash`); `list_swap_offers` with `status: all` and
   `since` is the board's change feed.

- One half spends at most `NIGHTGATE_SWAP_MAX_INPUTS` coins, the smallest that
  fit. `give.amount` above `spendable` is refused before proving.
- An offer fills once. Its coins stay reserved in the maker's wallet until the
  swap lands or `revert_swap_offer` releases them.
- A refused submission keeps the proven half: `sponsor_swap` with its `halfId`.
- The sponsor needs swaps switched on and both token types on its list; an
  agent grant needs `sponsorSwap` in `allowedActions`.
- With `NIGHTGATE_PROOF_SERVER_URL` the proof server sees the coins a half
  spends: use one you run yourself.
- Tokens to swap: `mint_token` mints on a token factory to this wallet (or
  any other wallet, given both of its keys). Without a `sessionId` the seed is
  the issuer: the mint is built and proven here (needs
  `@odatano/contract-token-factory` next to `@odatano/nightgate-tx`; the
  prover keys come from the package's release assets on first use) and the
  sponsor pays. A landed mint makes the type known to the sponsor.
- `get_board_status` says whether a sponsor is ready before anything is built.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ODATANO_ACCESS_KEY` | unset | `oda_…` key, or an `ngat_…` agent grant on a direct instance |
| `ODATANO_ACCESS_URL` | `https://api.preprod.odatano.dev` | Gateway or a direct NIGHTGATE host |
| `ODATANO_ACCESS_USER` / `_PASSWORD` | unset | Basic auth of a direct instance |
| `NIGHTGATE_SEED_HEX` | unset | Seed (128 hex) for local building and swaps; never a tool argument |
| `NIGHTGATE_NETWORK` | `preprod` | Network of the local builder |
| `NIGHTGATE_PROOF_SERVER_URL` | unset | Prove on a proof server instead of in-process |
| `NIGHTGATE_SWAP_STATE_FILE` | unset | File for the swap wallet's state; it holds the wallet's coins, keep it like a key |
| `NIGHTGATE_SWAP_MAX_INPUTS` | `4` | Most coins one swap half spends; the sponsor's limit applies |
| `NIGHTGATE_TIMEOUT_MS` | `30000` | Per-request timeout |

Also: `NIGHTGATE_SERVICE_PATH`, `NIGHTGATE_INDEXER_SERVICE_PATH`, `ODATANO_ANALYTICS_URL`, `NIGHTGATE_INDEXER_HTTP_URL`,
`NIGHTGATE_INDEXER_WS_URL`, `NIGHTGATE_NODE_URL`, `NIGHTGATE_ZK_CONFIG_BASE_URL`,
`NIGHTGATE_ZK_CACHE_DIR`.

## Own instance

```bash
docker run -d -p 4004:4004 -e ENCRYPTION_KEY=$(openssl rand -hex 32) \
  -e NIGHTGATE_HTTP_PASSWORD=change-me -v nightgate-data:/data ghcr.io/odatano/nightgate:latest
```

Then `ODATANO_ACCESS_URL=http://localhost:4004`, `ODATANO_ACCESS_USER=nightgate`,
`ODATANO_ACCESS_PASSWORD=change-me`. For agents, create a grant with
`createAgentGrant` and pass its `ngat_…` token as `ODATANO_ACCESS_KEY`.

## Compatibility

NIGHTGATE >= 0.24.0; `chainSegments` needs >= 0.28.0, swaps need >= 0.29.0, the offer board and holder disclosure need >= 0.30.0, `get_swap_offer`, `my_swap_offers`, `get_board_status`, the server way of `mint_token` and the `status`/`since` filters need >= 0.30.1.
`@odatano/nightgate-tx` >= 0.10.2 for local building (local minting also needs `@odatano/contract-token-factory`). Per version: [CHANGELOG](CHANGELOG.md).

Local building needs ONE `@midnight-ntwrk/ledger-v8` in the install
(`npm ls @midnight-ntwrk/ledger-v8`). `expected instance of ...` means two:
`npm dedupe`.

## Development

```bash
npm install && npm run integration
```

Live lanes:

```bash
NIGHTGATE_LIVE=1 NIGHTGATE_TEST_CONTRACT=<vault> NIGHTGATE_TEST_PAYLOAD_HASH=<64 hex> npm run integration
NIGHTGATE_SEED_HEX=<hex> NIGHTGATE_VAULT=<vault> NIGHTGATE_SPONSOR_SESSION_ID=<sponsor or pool id> npm run live:sponsor-unbound
```

## License

Apache-2.0
