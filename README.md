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
| `build_sponsorable_transaction`, `get_attester_identity` | Build, prove and sign locally; the attester id it builds under |
| `sponsor_unbound_transaction`, `sponsor_finalized_transaction` | Hand locally built bytes to a sponsor that pays and submits (async) |
| `derive_token_type` | Token type a minting contract produces |
| `get_job_status` | Poll an async job; batches report `chainSegments` |
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

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ODATANO_ACCESS_KEY` | unset | `oda_…` key, or an `ngat_…` agent grant on a direct instance |
| `ODATANO_ACCESS_URL` | `https://api.preprod.odatano.dev` | Gateway or a direct NIGHTGATE host |
| `ODATANO_ACCESS_USER` / `_PASSWORD` | unset | Basic auth of a direct instance |
| `NIGHTGATE_SEED_HEX` | unset | Seed for local building; never a tool argument |
| `NIGHTGATE_NETWORK` | `preprod` | Network of the local builder |
| `NIGHTGATE_PROOF_SERVER_URL` | unset | Prove on a proof server instead of in-process |
| `NIGHTGATE_TIMEOUT_MS` | `30000` | Per-request timeout |

Also: `NIGHTGATE_SERVICE_PATH`, `ODATANO_ANALYTICS_URL`, `NIGHTGATE_INDEXER_HTTP_URL`,
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

NIGHTGATE >= 0.24.0; `chainSegments` needs >= 0.28.0. Per version: [CHANGELOG](CHANGELOG.md).

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
