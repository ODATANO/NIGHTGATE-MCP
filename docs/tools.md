# Tools of @odatano/nightgate-mcp

Every tool and what it returns. Writes are built, proven and signed here with
the caller seed, a sponsor pays the fee, and the tool waits until the job
settled. Reads of contract state are free. Vault tools default to the shared
sandbox vault of the network and to the `attestation-vault-32` lineage.

## First anchor

With only `ODATANO_ACCESS_KEY` set:

1. `anchor_document` with the sha256 of a document. It builds the transaction,
   the sponsor pays, and after about a minute the answer carries `status`,
   `attesterId`, `txHash` and `check`.
2. `check` is the `verify_attestation` call that shows the record on-chain.
   Run it as given. It is free.

The first build downloads the prover keys and creates the seed file (see
[Seed](#seed)).

## All tools

| Tool | What it does |
|---|---|
| `verify_attestation`, `verify_predicate` | Check a record or a ZK claim against live contract state; absent = `verified: false`. Free |
| `prepare_document_proof`, `prepare_membership_set` | Build proof inputs: salted content tree, set root |
| `anchor_document` | Anchor a document hash, optionally with its content root, in one call |
| `submit_vault_call` | Any vault call in one call: ZK claims over a hidden field, claims across two documents, disclosure, passports |
| `build_sponsorable_transaction`, `get_attester_identity` | Build a vault call and keep the bytes under a `txId` or in `outFile`, for a sponsor elsewhere. The attester id and shielded keys of the seed |
| `sponsor_unbound_transaction`, `sponsor_finalized_transaction` | Hand bytes built elsewhere to a sponsor, by `txId` or `file`, and wait for the job |
| `get_swap_wallet`, `read_swap_offer` | Shielded coins of the local wallet; what an offer gives and wants |
| `build_swap_offer`, `take_swap_offer`, `revert_swap_offer` | Build one half of a shielded swap locally, take an offer, release a half |
| `sponsor_swap` | Hand both halves of a swap, or a board offer plus the taker half, to a sponsor and wait |
| `post_swap_offer`, `list_swap_offers`, `retire_swap_offer` | The server's offer board: post a maker half, find open offers, take yours down |
| `get_swap_offer`, `my_swap_offers`, `get_board_status` | Follow one offer, see your own posts and their fills, read the board's counts without credentials |
| `mint_token`, `burn_token` | Mint a shielded token with a name of your own on a token factory, the seed is the issuer; burn one this wallet holds |
| `send_token` | Pay another shielded address from this wallet; the sponsor pays the fee |
| `call_contract` | Call a circuit on any contract whose lineage package is installed next to the server, built here and sponsored |
| `derive_token_type` | Token type a minting contract produces |
| `get_usage` | What the key has left and what each call cost. Free |
| `analytics_*` | Midnight aggregates via ODATANO ASTRA, when the host serves it |

Errors carry the server's HTTP status and `code` (`INVALID_ARGUMENT`, ...).

## What a write returns

| Field | Meaning |
|---|---|
| `status` | `succeeded`, `failed`, or `pending` when the job is still open after 5 minutes or its status cannot be read |
| `txHash` | Ledger identifier of the transaction |
| `transactionHash` | Hash the explorers show, null until indexed |
| `result` | The job result, for a swap `swap`, for a mint `tokenType` |
| `errorCode`, `errorMessage`, `next` | Why it failed and what to do |
| `statusError` | With `pending`: why the status could not be read |
| `check` | `{ tool, args }`: the call that shows the effect on-chain |
| `receipt` | A swap or transfer the block confirmed: the instance's signed statement of the chain facts and the terms. The tool waits for the block; null when that wait ran out first, the same call again fetches it |
| `seed` | Only once, when this call created the seed file |

`failed` with `CHAIN_EXECUTION_FAILED`: the transaction is on-chain but its
contract call did not apply, usually because another call changed the same
contract in that block. Run the tool again. It builds against the new state.

A tool that was cut off, for example by a client timeout, or that came back
`pending`: run it again with the same arguments. It picks up the job it
started and submits nothing new, so there is no second fee.

While a call runs it sends MCP progress every 5 seconds, so a client that
resets its request timeout on progress keeps the call open. Each message
names the current stage and the elapsed time, for example `proving, 45 s` or
`submitted, waiting for the block, 130 s`. A proof takes several minutes. The MCP Inspector CLI ignores progress and stops after 60
seconds, so it cannot run the writes. With `@modelcontextprotocol/sdk`, call
`client.callTool(params, undefined, { timeout: 600000, resetTimeoutOnProgress: true })`.

`anchor_document` and `submit_vault_call` return `timings` in milliseconds.
A stage without both timestamps is left out.

| Field | Stage |
|---|---|
| `setupMs` | Builder setup here; the first call includes the prover key download |
| `proveMs` | Building, proving and signing the call here |
| `queueMs` | Waiting in the sponsor's queue |
| `sponsorMs` | The sponsor adds the fee and broadcasts |
| `settleMs` | From the broadcast until the block is final |

`anchor_document` with a content root returns the anchor's stages as
`anchorTimings`.

## Sandbox vaults

`contractAddress` defaults to the shared sandbox vault of the network. Both
are `attestation-vault-32` and open to every key; a 16-slot
`attestation-vault` needs its address:

| Network | Vault |
|---|---|
| preprod | `ca0b1e3c601857a7b6940bbbbd6508654f5983b63aa36ccf8254f7700f89aead` |
| preview | `31df87bc396ab32e8408b0ebfd1f8e7bf121f17e12e2ba360ed9f08c7ba40692` |

Mainnet has no sandbox vault; pass `contractAddress` there.

## Seed

The seed is the caller's identity on Midnight. Every record anchored with it
belongs to its `attesterId`, and only it can prove claims on or revoke
disclosures of those records.

- `NIGHTGATE_SEED_HEX` set: that seed is used.
- Unset: the seed is read from `NIGHTGATE_SEED_FILE` (default
  `~/.nightgate-mcp/seed`). Without that file the first tool that needs the
  seed creates it, readable by the owner only, and its answer carries
  `seed: { created, file, meaning }`.

Keep the file and back it up. Every server on the same machine shares that
file and so one identity. For separate identities, give each server its own
`NIGHTGATE_SEED_HEX` or `NIGHTGATE_SEED_FILE`.

## Field claims

1. `prepare_document_proof` with the document and the fields to make
   provable. Keep `opening` with the document.
2. `anchor_document` with `sha256: payloadHash`, `contentRoot` and `schemaId`.
3. `submit_vault_call` with `proveFieldPredicate`, `proveFieldEquality` or
   `proveFieldMembership`, the params listed in `build_sponsorable_transaction`
   and the field's witness as `merkleProof`. The witness stays here.
4. `check` names the `verify_predicate` call for the claim.

## verify_attestation fields

| Field | Meaning |
|---|---|
| `verified` | The record stands and every given check matched |
| `attested` | The attester's record of `payloadHash` is in the vault |
| `contentRootOk`, `schemaOk` | The given `contentRoot` and `schemaId` match the anchor |
| `bindingRegistered` | Only for lookups by `documentId`: the vault registrar assigned that id to this attester. A record anchored without a document id reports `false`, and that is fine |
| `recordKey` | Ledger key of the record, `recordKey(attesterId, payloadHash)` |

## Shielded swaps

Two wallets exchange two shielded tokens without a contract. Each side builds
one half, the halves mirror each other, a sponsor merges them and pays the fee.
Needs a Midnight indexer the swap wallet syncs its coins from
(`NIGHTGATE_INDEXER_HTTP_URL`, `NIGHTGATE_INDEXER_WS_URL`).

1. `get_swap_wallet`: per token type the balance of the free coins, their
   number, `spendable` and `pending`, what the halves built here bring back
   once their swaps land (the change and the wanted coins). While a half can
   still land the wallet is worth balance plus pending; a half can give only
   from balance, and `revert_swap_offer` moves a dropped half back into it.
   The first call starts the sync of the shielded coins (about 5 minutes from
   genesis, seconds with `NIGHTGATE_SWAP_STATE_FILE`). With offers posted from
   this server it reads their state in one `listSwapOffers` call.
2. Maker: `build_swap_offer` with `give` and `want` returns the offer file
   (`swapoffer1...`) to publish, or `post_swap_offer` puts it on the server's
   board.
3. Taker: `list_swap_offers` or `read_swap_offer`, then `take_swap_offer` with
   `expect`, `submit: true` and, for a board entry, its `offerId`. It builds
   the mirror half, submits both and waits; the result carries `swap`.
4. The maker follows the offer with `get_swap_offer` or `my_swap_offers`
   (`filled` + `filledTxHash`); `list_swap_offers` with `status: all` and
   `since` is the board's change feed.

- One half spends at most `NIGHTGATE_SWAP_MAX_INPUTS` coins, the smallest that
  fit. `give.amount` above `spendable` is refused before proving.
- An offer fills once. Its coins stay reserved in the maker's wallet until the
  swap lands or `revert_swap_offer` releases them.
- `post_swap_offer` with `directed: true` returns a `takerSecret` once: only a
  taker who passes it to `take_swap_offer` or `sponsor_swap` gets the swap
  sponsored, so an invoice or an agreed deal goes to its counterparty alone.
- A refused submission keeps the proven half: `sponsor_swap` with its `halfId`.
- The sponsor needs swaps switched on and both token types on its list; an
  agent grant needs `sponsorSwap` in `allowedActions`.
- With `NIGHTGATE_PROOF_SERVER_URL` the proof server sees the coins a half
  spends: use one you run yourself.
- Tokens to swap: `mint_token` mints on a token factory to this wallet, or to
  any wallet whose two keys are given; this needs
  `@odatano/contract-token-factory` next to `@odatano/nightgate-tx`. A landed
  mint makes the type known to the sponsor.
- `get_board_status` says whether a sponsor is ready before anything is built.

## Transfers, burns and contract calls

- `send_token({ tokenType, amount, to })` pays another shielded address from
  this wallet: the transfer is built and proven here from the wallet's coins
  (at most `maxInputs`), handed to the server's `sponsorTransfer` with the
  declared type and amount, and the sponsor pays. The recipient needs nothing
  but its address (`get_attester_identity` or `get_swap_wallet` of the other
  side). Until the transfer lands its coins are pending; a refused submission
  keeps the proven transfer under `halfId` for `revert_swap_offer`. The server
  needs `NIGHTGATE_SPONSOR_ALLOW_TRANSFERS`, the grant `sponsorTransfer`, the
  type the sponsor's list.
- `burn_token({ contractAddress, name, amount, issuerKey? })` burns a factory
  token this wallet holds; without `issuerKey` the token is one this wallet
  minted. Same path as `mint_token`: built here, sponsored.
- `call_contract({ package, contractAddress, circuit, args })` calls a circuit
  on any contract whose lineage package is installed next to the server (laid
  out like `@odatano/contract-<name>`). Arguments are JSON in circuit order;
  `{"$bytes":"<hex>"}`, `{"$uint":"<n>"}` and `{"$coin":{"tokenType","amount"}}`
  are tagged, a `$coin` is a shielded coin the circuit receives, funded from
  this wallet (needs the indexer variables so the coins sync). Circuits that
  need witnesses beyond the contract's own are not reachable here.
- A swap or transfer the block confirmed carries `receipt` in its result (the
  tool waits for the block, about a minute after the sponsor sent it; the same
  call again fetches a receipt that wait missed):
  `{ payload, signature, publicKey, algorithm }`, the instance's Ed25519
  statement of the chain facts and the terms (`declared: true` for a
  transfer). Check it against the key `getReceiptKey()` on the indexer service
  publishes, without reading the board.

