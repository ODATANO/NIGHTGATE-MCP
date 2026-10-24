<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://cdn.jsdelivr.net/npm/@odatano/brand@1/logos/nightgate-mcp-logo.svg">
    <img src="https://cdn.jsdelivr.net/npm/@odatano/brand@1/logos/nightgate-mcp-logo-on-light.svg" alt="NIGHTGATE MCP" height="84">
  </picture>
</p>

# @odatano/nightgate-mcp

[![npm](https://img.shields.io/npm/v/@odatano/nightgate-mcp)](https://www.npmjs.com/package/@odatano/nightgate-mcp)
[![NIGHTGATE](https://img.shields.io/badge/NIGHTGATE-%3E%3D%200.36.0-4b0082)](https://www.npmjs.com/package/@odatano/nightgate)
[![MCP](https://img.shields.io/badge/MCP-server-2ea44f)](https://modelcontextprotocol.io/)
[![License](https://img.shields.io/badge/license-Apache--2.0-yellow)](LICENSE)

MCP server for [NIGHTGATE](https://github.com/ODATANO/NIGHTGATE) on Midnight.
Anchors documents, proves zero-knowledge claims over hidden fields, grants and
verifies disclosure against live contract state; swaps shielded tokens over an
offer board and mints them on a token factory. Transactions are sponsored, the
agent holds no NIGHT. The chain is read through the
[ODATANO API](https://api.odatano.dev): no indexer, no node.

## Quick start

Get an `oda_…` key at [api.odatano.dev](https://api.odatano.dev) (Cardano
wallet sign-in, a redeem code, or tADA over x402), then:

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

[docs/tools.md](docs/tools.md) lists every tool and the two flows: fee
sponsoring (build and prove here, a sponsor pays) and shielded swaps (two
halves, one sponsor). Errors carry the server's HTTP status and `code`.

## Configuration

[docs/configuration.md](docs/configuration.md): every variable, an own
NIGHTGATE instance, version requirements. Needs NIGHTGATE >= 0.36.0, which the
hosted gateway runs.

## Development

```bash
npm install && npm run integration
```

Live lanes:

```bash
NIGHTGATE_LIVE=1 NIGHTGATE_TEST_CONTRACT=<vault> NIGHTGATE_TEST_PAYLOAD_HASH=<64 hex> npm run integration
NIGHTGATE_SEED_HEX=<hex> NIGHTGATE_VAULT=<vault> npm run live:sponsor-unbound
```

## License

Apache-2.0
