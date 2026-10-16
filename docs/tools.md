# Tools of @odatano/nightgate-mcp

Every tool, what it does, and the two flows that chain several of them. Async
tools return `{ jobId, status }`; `get_job_status` polls. The server reads
the chain through the ODATANO API; only the swap wallet syncs from a Midnight
indexer.

## All tools

| Tool | What it does |
|---|---|
| `verify_attestation`, `verify_predicate`, `verify_predicate_attestation`, `verify_document` | Check records and ZK claims against live contract state; absent = `verified: false` |
| `prepare_document_proof`, `prepare_membership_set` | Build proof inputs: salted content tree, set root |
| `anchor_document`, `attest_agent_output` | Anchor a document hash or an agent-output envelope (async) |
| `prove_field_predicate`, `prove_field_equality`, `prove_field_membership` | ZK claims over one hidden field (async) |
| `prove_field_predicates_batch` | Up to 8 claims in one transaction (async) |
| `prove_document_integrity`, `prove_document_diff` | ZK claims across two documents (async) |
| `grant_disclosure`, `revoke_disclosure` | On-chain disclosure ACL (async) |
| `build_sponsorable_transaction`, `get_attester_identity` | Build, prove and sign a vault call locally; the bytes stay here under a `txId`, or go to `outFile`. The attester id and shielded keys of the seed |
| `sponsor_unbound_transaction`, `sponsor_finalized_transaction` | Hand a built transaction by `txId` or `file` to a sponsor that pays and submits (async); the result says what was sent |
| `get_swap_wallet`, `read_swap_offer` | Shielded coins of the local wallet; what an offer gives and wants |
| `build_swap_offer`, `take_swap_offer`, `revert_swap_offer` | Build one half of a shielded swap locally, take an offer, release a half |
| `sponsor_swap` | Hand both halves of a swap, or a board offer plus the taker half, to a sponsor that merges, pays and submits (async) |
| `post_swap_offer`, `list_swap_offers`, `retire_swap_offer` | The server's offer board: post a maker half, find open offers, take yours down |
| `get_swap_offer`, `my_swap_offers`, `get_board_status` | Follow one offer, see your own posts and their fills, read the board's counts without credentials |
| `mint_token` | Mint a shielded token with a name of your own on a token factory: built here with the seed as issuer and sponsored, or by a server session (async) |
| `grant_disclosure_to_holders`, `revoke_holder_disclosure`, `claim_disclosure`, `holder_claim_key` | Disclose a document to the holders of a token; read it with the secret behind a registered claim key |
| `derive_token_type` | Token type a minting contract produces |
| `get_job_status` | Poll an async job; batches report `chainSegments`, swaps `swap` |
| `get_grant_usage` | What the key did and what it may still do: hour and day budgets, rate classes with what is left |
| `analytics_*` | Midnight aggregates via ODATANO ASTRA, when the host serves it |

Errors carry the server's HTTP status and `code` (`INVALID_ARGUMENT`, ...).

## Fee sponsoring

The caller builds, the server pays. Needs `@odatano/nightgate-tx` next to the
server and `NIGHTGATE_SEED_HEX`; the contract state is read through the API.

1. `build_sponsorable_transaction` builds, proves and signs the call locally
   and returns a `txId`. The bytes never travel as a tool argument.
2. `sponsor_unbound_transaction` with the `txId`, or with `file` for bytes
   built elsewhere; the server's sponsor pool pays and submits.
3. `get_job_status` with the returned `sessionId`, then `verify_attestation`.

`failed` / `CHAIN_EXECUTION_FAILED`: landed but not applied; build again, never
resubmit the same bytes.

## Shielded swaps

Two wallets exchange two shielded tokens without a contract. Each side builds
one half, the halves mirror each other, a sponsor merges them and pays the fee.
Needs `@odatano/nightgate-tx` next to the server, `NIGHTGATE_SEED_HEX` and a
Midnight indexer the swap wallet syncs its coins from (`NIGHTGATE_INDEXER_HTTP_URL`,
`NIGHTGATE_INDEXER_WS_URL`).

1. `get_swap_wallet`: balance, free coins and `spendable` per token type. The
   first call starts the sync of the shielded coins (about 5 minutes from
   genesis, seconds with `NIGHTGATE_SWAP_STATE_FILE`).
2. Maker: `build_swap_offer` with `give` and `want` returns the offer file
   (`swapoffer1...`) to publish, or `post_swap_offer` puts it on the server's
   board.
3. Taker: `list_swap_offers` or `read_swap_offer`, then `take_swap_offer` with
   `expect`, `submit: true` and, for a board entry, its `offerId`. It builds
   the mirror half and submits both; the server's sponsor pool pays.
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
- Tokens to swap: `mint_token` mints on a token factory to this wallet, or to
  any wallet whose two keys are given. Without a `sessionId` the seed is the
  issuer, the mint is built here and the sponsor pays; this needs
  `@odatano/contract-token-factory` next to `@odatano/nightgate-tx`. A landed
  mint makes the type known to the sponsor.
- `get_board_status` says whether a sponsor is ready before anything is built.
