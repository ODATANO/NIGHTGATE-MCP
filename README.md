<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://cdn.jsdelivr.net/npm/@odatano/brand@1/logos/nightgate-mcp-logo.svg">
    <img src="https://cdn.jsdelivr.net/npm/@odatano/brand@1/logos/nightgate-mcp-logo-on-light.svg" alt="NIGHTGATE MCP" height="84">
  </picture>
</p>

# @odatano/nightgate-mcp

[![npm](https://img.shields.io/npm/v/@odatano/nightgate-mcp)](https://www.npmjs.com/package/@odatano/nightgate-mcp)
[![npm downloads](https://img.shields.io/npm/dt/@odatano/nightgate-mcp?logo=npm&label=downloads&color=blue)](https://www.npmjs.com/package/@odatano/nightgate-mcp)
[![NIGHTGATE](https://img.shields.io/badge/NIGHTGATE-%3E%3D%200.18.0-4b0082)](https://www.npmjs.com/package/@odatano/nightgate)
[![MCP](https://img.shields.io/badge/MCP-server-2ea44f)](https://modelcontextprotocol.io/)
[![Node](https://img.shields.io/badge/node-%3E%3D%2020-brightgreen?logo=node.js)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-Apache--2.0-yellow)](LICENSE)

MCP server that lets AI agents use [NIGHTGATE](https://github.com/ODATANO/NIGHTGATE),
the Midnight blockchain attestation layer: anchor documents, prove
zero-knowledge predicates over hidden fields, manage disclosure grants,
verify everything against live contract state, and poll async jobs.
Wallet lifecycle (connect, send, deploy) is deliberately not exposed; writing
without a wallet session works through fee sponsoring (build locally, a
sponsor pays).

## Quick start: the hosted API

The usual way to run this server is against the hosted ODATANO ACCESS
gateway at [api.odatano.dev](https://api.odatano.dev): no node, no plugin,
no wallet session of your own. One `oda_…` key covers Midnight (this server)
and Cardano (`@odatano/core-mcp`).

1. Get a key at [api.odatano.dev](https://api.odatano.dev): sign in with a
   Cardano wallet (the first key comes with free calls), redeem a giveaway
   code, or buy a pack with tADA over x402 (`POST /keys`). The console shows
   the key once, together with a ready `.mcp.json`.
2. Put the key in your MCP client's config:

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

   or, with Claude Code: `claude mcp add nightgate --env ODATANO_ACCESS_KEY=oda_... -- npx -y @odatano/nightgate-mcp`

3. That is all: the gateway is the default URL. It sends the key as
   `Authorization: Bearer`, swaps in the NIGHTGATE agent grant underneath
   (sponsored writes on the platform pool included) and meters the key per
   call; the verify lane and the prover keys under `/zk-config` are free.
   The hosted NIGHTGATE runs on Midnight **preprod** today.

What the gateway does not offer, the key cannot reach: agent grants, wallet
sessions, contract deployment, dust registration and the sponsor pool status
answer 403 there; this server never calls them. A 402 from the gateway
(units exhausted) reaches the agent with the top-up hint.

## Requirements

- Node.js >= 20 (`npx` fetches the server, nothing to install)
- For `build_sponsorable_transaction`: `@odatano/nightgate-tx` installed next
  to the server and `NIGHTGATE_SEED_HEX` set (see the sponsoring section)

## Writing on-chain: fee sponsoring

An agent does not need a wallet session of its own to write on-chain. Through
the gateway the key already carries a grant for `sponsorUnboundTransaction`
and `sponsorFinalizedTransaction` on the platform sponsor pool; against a
direct instance the grant is the `ngat_…` token. The flow is:

1. `build_sponsorable_transaction`: build, prove and sign the contract call
   LOCALLY (the MCP server wraps the
   [`@odatano/nightgate-tx`](https://www.npmjs.com/package/@odatano/nightgate-tx)
   txbuilder; install it next to the MCP server, it is an optional peer
   dependency because it carries the Midnight SDK). The seed comes from
   `NIGHTGATE_SEED_HEX` in the server environment, the attestation secret is
   derived from it, nothing secret leaves the machine; the result is ~7 KB of
   base64 and the effect will carry this builder's attester id
   (`get_attester_identity`). Proving runs in-process (20-60 s) or on a proof
   server (`NIGHTGATE_PROOF_SERVER_URL`). Without the package or the seed the
   tool answers with a clear error; an agent can still hand in bytes built
   elsewhere with the txbuilder directly.
2. `sponsor_unbound_transaction` with the operator's sponsor session id, or
   the platform pool id `00000000-0000-0000-0000-706f6f6c0000` when the host
   runs a sponsor pool (the server picks a free pool sponsor and fails over).
3. Poll `get_job_status` with the `sessionId` the sponsor call RETURNED, then
   `verify_attestation` to read it back crawler-free.

One sponsor wallet serves several agents at once (parallel channel, 0.18.0).
A job that ends `failed` with `CHAIN_EXECUTION_FAILED` landed on-chain but its
call did not apply (two calls on the same contract in one block): build again
against the current state and sponsor again; never resubmit the same bytes.
On a direct host behind transport auth set `ODATANO_ACCESS_USER` /
`ODATANO_ACCESS_PASSWORD` next to the token, the two combine.


## Run your own instance (optional)

Point `ODATANO_ACCESS_URL` at any NIGHTGATE host app instead of the gateway
(see the compatibility table below for the version pairing). The fastest way
is the official Docker image; no Node setup, no host app (published from the
NIGHTGATE repo on every release, details in its `docs/docker.md`):

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
ODATANO_ACCESS_URL=http://localhost:4004
ODATANO_ACCESS_USER=nightgate
ODATANO_ACCESS_PASSWORD=change-me
```

For agent operation, create a scoped grant once (as the operator, e.g. via
curl against `createAgentGrant`) and hand the returned `ngat_...` token to
the agent as `ODATANO_ACCESS_KEY`; the write tools are then limited to the
grant's allowlist, budget and pinned session. Any CAP app using the
`@odatano/nightgate` plugin works too, e.g. the NIGHTGATE repo itself via
`npm run dev`.

## Compatibility

Pick the MCP line that matches your NIGHTGATE server. The pairing is not
cosmetic: from NIGHTGATE 0.16.0 on, content-tree leaves are SALTED, so every
field proof must carry its slot salt. An older MCP omits it and the server
rejects the call with 400.

| MCP | NIGHTGATE | Notes |
|---|---|---|
| **0.6.0** | **>= 0.24.0** | Current. Vault lineage 4 keys every record by attester AND payload: `verify_attestation` takes `attesterId` + `payloadHash` (or a bound `documentId`), `verify_predicate` takes `attesterId`, the `prove_*` tools accept an optional `attesterId` (the record the claim is proven against), `anchor_document` is one plain attest and returns `attesterId`. `prepare_anchor_commitment` and `commit_document_anchor` are gone (nothing to guard: no identity can take over another attester's record). Local building needs `@odatano/nightgate-tx` >= 0.6.0; the proof calls take `recordKey` or `payloadHash` (+ `attesterId`). Against a 0.23.x server the verify calls fail with 400 (unknown parameter). |
| 0.5.1 | >= 0.19.0 for width 32 | Accepts the 32-slot vault: schema and opening take 16 or 32 entries, `allowedMask` up to 32 bits, `k` up to 32, and the vacuity guard is checked against the SCHEMA instead of a fixed all-ones constant. Target it with `compiledArtifactRef: 'attestation-vault-32'`. Everything else is unchanged, so a 16-slot setup keeps working against any 0.18.x server. |
| 0.5.x | >= 0.18.0 | Adds the parallel sponsoring channel (`sponsor_unbound_transaction`, platform pool id) and LOCAL transaction building (`build_sponsorable_transaction`, `get_attester_identity`) via the optional `@odatano/nightgate-tx` >= 0.2.0 txbuilder; `sponsor_unbound_transaction` 404s against older servers. |
| 0.4.x | >= 0.17.0 | Cross-server fee sponsoring, serial channel only (`sponsor_finalized_transaction`), custom-token identity (`derive_token_type`). |
| 0.3.x | >= 0.16.0 (0.16.2 recommended) | Cross-root proofs, guarded anchoring, schema ids, per-field salts. Does NOT work against 0.15.x and older, which know no salt parameters. |
| 0.2.x | 0.15.x | Bytes equality and set membership on unsalted leaves. Against 0.16.0 and newer every field proof fails with "fieldSalt is required". |
| 0.1.x | 0.14.x | Anchoring, numeric field predicates, disclosure, agent provenance. |

The verification tools are the exception: they only read live contract state
and keep working across the whole range, they simply cannot express the
newer claim kinds on an older server.

## Development setup

```bash
npm install
npm run build
```

Configuration is environment-driven (the same variables in an MCP client's `env` block):

| Variable | Default | Purpose |
|---|---|---|
| `ODATANO_ACCESS_URL` | `https://api.odatano.dev` | The ODATANO ACCESS gateway, or a direct NIGHTGATE host app (`http://localhost:4004` for `cds watch`) |
| `ODATANO_ACCESS_USER` / `ODATANO_ACCESS_PASSWORD` | unset | Basic auth against a direct instance (CAP dev/mocked auth); not for agents |
| `ODATANO_ACCESS_KEY` | unset | **The credential: an ODATANO ACCESS key `oda_…`** (sent as `Authorization: Bearer`; buy one at `POST https://api.odatano.dev/keys`, redeem a code, or sign in at the console). The same variable configures `@odatano/core-mcp`. Against a direct NIGHTGATE instance a raw `ngat_...` agent grant (sent as `x-agent-token`, combinable with basic auth) or any other bearer goes here too |
| `NIGHTGATE_SERVICE_PATH` | `/api/v1/nightgate` | OData service path |
| `NIGHTGATE_TIMEOUT_MS` | `30000` | Per-request timeout |
| `NIGHTGATE_SEED_HEX` | unset | Caller seed (64 or 128 hex) for `build_sponsorable_transaction`; never a tool argument. Needs `@odatano/nightgate-tx` installed |
| `NIGHTGATE_NETWORK` | `preprod` | Network the local builder targets (`preview`, `preprod`, `mainnet`) |
| `NIGHTGATE_INDEXER_HTTP_URL` / `NIGHTGATE_INDEXER_WS_URL` / `NIGHTGATE_NODE_URL` | public Midnight endpoints of the network | Builder's indexer + node |
| `NIGHTGATE_ZK_CONFIG_BASE_URL` | `<base url>/zk-config/attestation-vault` | Where the builder fetches prover keys (cached on disk, `NIGHTGATE_ZK_CACHE_DIR`) |
| `NIGHTGATE_PROOF_SERVER_URL` | unset | Prove contract circuits on a proof server instead of in-process wasm |

## Tools

| Tool | What it does |
|---|---|
| `verify_attestation` | Live-state check that an attester's record of a payload hash stands in an AttestationVault: named by `attesterId` + `payloadHash` or by a bound `documentId` (crawler-free, optional content-root / schema check, optional cross-network read) |
| `verify_predicate` | Live-state check that a ZK claim was recorded true on-chain, id-free: `attesterId` + `payloadHash` name the record; numeric predicates, `bytesEquality` (+ `expectedDigest`), `setMembership` (+ `setRoot`) and the cross-root kinds `documentIntegrity` / `documentDiff` (+ `payloadHashB`, optional `attesterIdB`) |
| `verify_predicate_attestation` | Verify a server-issued predicate attestation by its row id |
| `verify_document` | Verify an anchored document by document id + sha256 |
| `prepare_document_proof` | Canonicalize a document into payloadHash + salted Merkle contentRoot + schemaId + per-field proof inputs (incl. each slot salt) + the full `opening` the cross-root proofs need (synchronous) |
| `prepare_membership_set` | Build the canonical allow-list set tree: setRoot for verifiers, inclusion path for provers (synchronous) |
| `attest_agent_output` | Anchor agent-output provenance (canonical envelope, third-party verifiable; async job, NIGHTGATE >= 0.14.0) |
| `anchor_document` | Anchor a document content hash on-chain as the session's own record, keyed by attester and hash; returns `attesterId` for verifiers (async job) |
| `prove_field_predicate` | ZK proof that a hidden document field satisfies a threshold, without revealing it (async job) |
| `prove_field_equality` | ZK proof that a string field carries exactly the value behind a public digest (async job) |
| `prove_field_membership` | ZK proof that a hidden string field is one of a public allow-list, without revealing which (async job) |
| `prove_field_predicates_batch` | Up to 8 claims on one document in ONE transaction, any mix of numeric / equality / membership / cross-root kinds (async job) |
| `prove_document_integrity` | ZK proof that a second document differs from the anchored one ONLY in a public slot mask, values hidden (async job) |
| `prove_document_diff` | ZK proof that two anchored documents differ at >= k of the vault's slots, without revealing which (async job) |
| `grant_disclosure` / `revoke_disclosure` | Attester-only on-chain disclosure ACL (async jobs) |
| `build_sponsorable_transaction` | Build, prove and sign an AttestationVault call LOCALLY with the seed from the server environment (attest, anchorContentRoot, grant/revokeDisclosure, register/bindPassport, the proveField* claims against any attester's record); returns the fee-unpaid bytes for the sponsor tools, unbound by default (synchronous, 20-60 s, needs `@odatano/nightgate-tx`) |
| `get_attester_identity` | The attester id this server builds under, derived from the seed (synchronous) |
| `sponsor_finalized_transaction` | Submit a transaction that was built, proven and signed ELSEWHERE (e.g. with the `@odatano/nightgate-tx` txbuilder, the builder's key never leaves its machine); the sponsor session pays the dust, the effect carries the builder's identity; serial per sponsor wallet (async job) |
| `sponsor_unbound_transaction` | Same trust shape for an UNBOUND (`bind: false`) caller transaction: the sponsor merges a dust spend from a locked backing, binds and submits, several per sponsor wallet in parallel; `sponsorSessionId` may be the platform pool id (async job) |
| `derive_token_type` | Derive the raw token type a minting contract produces, from contract address + domain separator (synchronous) |
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
NIGHTGATE_LIVE=1 ODATANO_ACCESS_URL=... ODATANO_ACCESS_USER=... \
NIGHTGATE_TEST_CONTRACT=<vault address> NIGHTGATE_TEST_PAYLOAD_HASH=<64 hex> \
npm run integration
```

The agent sponsoring path has its own live lane, entirely through the MCP
tools with a grant token only: `get_attester_identity`,
`build_sponsorable_transaction` (local), `sponsor_unbound_transaction`,
`get_job_status`, `verify_attestation` (the attester id must be ours):

```bash
ODATANO_ACCESS_KEY=oda_... \
NIGHTGATE_SEED_HEX=<64 or 128 hex, a throwaway is fine> \
NIGHTGATE_VAULT=<vault address> NIGHTGATE_SPONSOR_SESSION_ID=<sponsor or pool id> \
npm run live:sponsor-unbound
```

## License

Apache-2.0
