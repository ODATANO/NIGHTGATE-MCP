# @odatano/nightgate-mcp

[![npm](https://img.shields.io/npm/v/@odatano/nightgate-mcp)](https://www.npmjs.com/package/@odatano/nightgate-mcp)
[![npm downloads](https://img.shields.io/npm/dt/@odatano/nightgate-mcp?logo=npm&label=downloads&color=blue)](https://www.npmjs.com/package/@odatano/nightgate-mcp)
[![NIGHTGATE](https://img.shields.io/badge/NIGHTGATE-%3E%3D%200.16.0-4b0082)](https://www.npmjs.com/package/@odatano/nightgate)
[![MCP](https://img.shields.io/badge/MCP-server-2ea44f)](https://modelcontextprotocol.io/)
[![Node](https://img.shields.io/badge/node-%3E%3D%2020-brightgreen?logo=node.js)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-Apache--2.0-yellow)](LICENSE)

MCP server that lets AI agents use [NIGHTGATE](https://github.com/ODATANO/NIGHTGATE),
the Midnight blockchain attestation layer: anchor documents, prove
zero-knowledge predicates over hidden fields, manage disclosure grants,
verify everything against live contract state, and poll async jobs.
Wallet lifecycle (connect, send, deploy) is deliberately not exposed.

## Requirements

- Node.js >= 20
- A running NIGHTGATE instance, see the compatibility matrix below

## Compatibility

Pick the MCP line that matches your NIGHTGATE server. The pairing is not
cosmetic: from NIGHTGATE 0.16.0 on, content-tree leaves are SALTED, so every
field proof must carry its slot salt. An older MCP omits it and the server
rejects the call with 400.

| MCP | NIGHTGATE | Notes |
|---|---|---|
| **0.3.x** | **>= 0.16.0** (0.16.2 recommended) | Current. Adds the cross-root proofs, guarded anchoring and schema ids, and sends the per-field salts the salted leaves require. Does NOT work against 0.15.x and older, which know no salt parameters. |
| 0.2.x | 0.15.x | Bytes equality and set membership on unsalted leaves. Against 0.16.0 and newer every field proof fails with "fieldSalt is required". |
| 0.1.x | 0.14.x | Anchoring, numeric field predicates, disclosure, agent provenance. |

The verification tools are the exception: they only read live contract state
and keep working across the whole range, they simply cannot express the
newer claim kinds on an older server.

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
| `verify_predicate` | Live-state check that a ZK claim was recorded true on-chain, id-free: numeric predicates, `bytesEquality` (+ `expectedDigest`), `setMembership` (+ `setRoot`) and the cross-root kinds `documentIntegrity` / `documentDiff` (+ `payloadHashB`) |
| `verify_predicate_attestation` | Verify a server-issued predicate attestation by its row id |
| `verify_document` | Verify an anchored document by document id + sha256 |
| `prepare_document_proof` | Canonicalize a document into payloadHash + salted Merkle contentRoot + schemaId + per-field proof inputs (incl. each slot salt) + the full `opening` the cross-root proofs need (synchronous) |
| `prepare_membership_set` | Build the canonical allow-list set tree: setRoot for verifiers, inclusion path for provers (synchronous) |
| `attest_agent_output` | Anchor agent-output provenance (canonical envelope, third-party verifiable; async job, NIGHTGATE >= 0.14.0) |
| `anchor_document` | Anchor a document content hash on-chain; with a `nonce` it is the guarded reveal that reclaims a front-run hash (async job) |
| `prove_field_predicate` | ZK proof that a hidden document field satisfies a threshold, without revealing it (async job) |
| `prove_field_equality` | ZK proof that a string field carries exactly the value behind a public digest (async job) |
| `prove_field_membership` | ZK proof that a hidden string field is one of a public allow-list, without revealing which (async job) |
| `prove_field_predicates_batch` | Up to 8 claims on one document in ONE transaction, any mix of numeric / equality / membership / cross-root kinds (async job) |
| `prove_document_integrity` | ZK proof that a second document differs from the anchored one ONLY in a public slot mask, values hidden (async job) |
| `prove_document_diff` | ZK proof that two anchored documents differ at >= k of 16 slots, without revealing which (async job) |
| `prepare_anchor_commitment` | Compute the commitment + secret nonce for guarded anchoring (synchronous) |
| `commit_document_anchor` | Record that commitment on-chain, so a mempool observer cannot front-run the later reveal (async job) |
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
