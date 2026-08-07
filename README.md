# @odatano/nightgate-mcp

MCP server that lets AI agents use [NIGHTGATE](https://github.com/ODATANO/NIGHTGATE),
the Midnight blockchain attestation layer: anchor documents, prove
zero-knowledge predicates over hidden fields, manage disclosure grants,
verify everything against live contract state, and poll async jobs.
Wallet lifecycle (connect, send, deploy) is deliberately not exposed.

## Requirements

- Node.js >= 20
- A running NIGHTGATE instance (>= 0.14.0 for the full tool set)

## Getting a NIGHTGATE instance

The fastest way is the official Docker image; no Node setup, no host app
(published from the NIGHTGATE repo on every release, details in its
`docs/docker.md`):

```bash
docker run -d --name nightgate -p 4004:4004 \
  -e ENCRYPTION_KEY=$(openssl rand -hex 32) \
  -e NIGHTGATE_HTTP_PASSWORD=change-me \
  -v nightgate-data:/data \
  ghcr.io/odatano/nightgate:latest
```

That container targets Midnight preprod by default, serves with HTTP basic
auth (`nightgate` / your password), persists its database in the
`nightgate-data` volume, and proves in-process (wasm), so no proof server
is needed to start. Point this MCP server at it with:

```bash
NIGHTGATE_BASE_URL=http://localhost:4004
NIGHTGATE_USERNAME=nightgate
NIGHTGATE_PASSWORD=change-me
```

For agent operation, create a scoped grant once (as the operator, e.g. via
curl against `createAgentGrant`) and hand the returned `ngat_...` token to
the agent as `NIGHTGATE_TOKEN`; the write tools are then limited to the
grant's allowlist, budget and pinned session.

Alternatively any CAP app using the `@odatano/nightgate` plugin works,
e.g. the NIGHTGATE repo itself via `npm run dev`.

## Setup

```bash
npm install
npm run build
```

Configuration is environment-driven:

| Variable | Default | Purpose |
|---|---|---|
| `NIGHTGATE_BASE_URL` | `http://localhost:4004` | NIGHTGATE host app |
| `NIGHTGATE_USERNAME` / `NIGHTGATE_PASSWORD` | unset | Basic auth (CAP dev/mocked auth) |
| `NIGHTGATE_TOKEN` | unset | `ngat_...` agent-grant token (sent as `x-agent-token`, combinable with basic auth) or a plain bearer token |
| `NIGHTGATE_SERVICE_PATH` | `/api/v1/nightgate` | OData service path |
| `NIGHTGATE_TIMEOUT_MS` | `30000` | Per-request timeout |

## Use with Claude Code

```bash
claude mcp add nightgate \
  --env NIGHTGATE_BASE_URL=http://localhost:4004 \
  --env NIGHTGATE_USERNAME=alice \
  -- node /path/to/NIGHTGATE-MCP/dist/index.js
```

Or in a project `.mcp.json`:

```json
{
  "mcpServers": {
    "nightgate": {
      "command": "node",
      "args": ["/path/to/NIGHTGATE-MCP/dist/index.js"],
      "env": {
        "NIGHTGATE_BASE_URL": "http://localhost:4004",
        "NIGHTGATE_USERNAME": "alice"
      }
    }
  }
}
```

## Tools

| Tool | What it does |
|---|---|
| `verify_attestation` | Live-state check that a payload hash is attested in an AttestationVault (crawler-free, optional content-root check, optional cross-network read) |
| `verify_predicate` | Live-state check that a ZK predicate proof was recorded true on-chain, id-free (plain or field-bound) |
| `verify_predicate_attestation` | Verify a server-issued predicate attestation by its row id |
| `verify_document` | Verify an anchored document by document id + sha256 |
| `prepare_document_proof` | Canonicalize a document into payloadHash + Merkle contentRoot + per-field proof inputs (synchronous, NIGHTGATE >= 0.14.0) |
| `attest_agent_output` | Anchor agent-output provenance (canonical envelope, third-party verifiable; async job, NIGHTGATE >= 0.14.0) |
| `anchor_document` | Anchor a document content hash on-chain (async job) |
| `prove_field_predicate` | ZK proof that a hidden document field satisfies a threshold, without revealing it (async job) |
| `prove_field_predicates_batch` | Up to 8 field predicates on one document in ONE transaction (async job) |
| `grant_disclosure` / `revoke_disclosure` | Attester-only on-chain disclosure ACL (async jobs) |
| `get_job_status` | Poll an async NIGHTGATE job until succeeded/failed |

All verification tools return `verified: false` as a clean negative rather
than an error when the attestation or proof is absent. Write tools require
a connected wallet session (`sessionId`); creating sessions stays outside
MCP by design.

## Integration check

```bash
npm run integration
```

Runs an in-memory MCP client against the server: asserts the tool set,
schemas, and argument validation. Optional live round-trip:

```bash
NIGHTGATE_LIVE=1 NIGHTGATE_BASE_URL=... NIGHTGATE_USERNAME=... \
NIGHTGATE_TEST_CONTRACT=<vault address> NIGHTGATE_TEST_PAYLOAD_HASH=<64 hex> \
npm run integration
```

## License

Apache-2.0
