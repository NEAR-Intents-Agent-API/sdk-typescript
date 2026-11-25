# Changelog

## 0.9.6 (unreleased)

Exact-output swaps and withdrawals, output floors and input ceilings checked against a fresh
quote, and stricter request validation. Breaking: `withdraw` no longer takes `memo`, and
`VerifiedPayment.amount` is optional.

- `swap` and `withdraw` take exact input (`amount`, optionally `min_amount_out`; `withdraw` takes
  `min_amount_out` now too) or exact output (`amount_out` with `max_amount_in`). The request types
  are a union of the two. Limits, USD budget, held spend and the balance check count all of
  `max_amount_in`; unused input returns to the balance it was spent from.
- New refusal `above_max_amount_in` (409): a `max_amount_in` below a fresh quote's `amount_in`.
  `below_min_amount_out` is now a clean 409 refusal too, judged against the quote's guaranteed
  `min_amount_out`. Both send nothing. Dry runs warn with either code when their quote already
  misses the figure sent.
- Dry-run `quote` and a result's `details.quote` are typed with the provider's figures:
  `amount_in`, `min_amount_in`, `amount_out`, `min_amount_out`, `withdraw_fee`, `refund_fee`,
  `amount_in_usd`, `amount_out_usd`. A settled exact-output request carries `details.amount_in`,
  the input it spent.
- Breaking: `withdraw` takes no `memo` (`validation_failed`); no route carried it. A withdrawal
  from the public balance to chain `near` takes `amount` alone (`amount_out` or `min_amount_out`
  there is `validation_failed`). Request amounts must be digits only, with no leading zeros.
- A result's `details.amount_out` is the delivery 1Click reported at settlement; until then the
  estimate is `details.expected_amount_out`. An exact-output swap or withdrawal completes only on a
  reported delivery of at least `amount_out`; less stops for review (`amount_out_below_minimum`).
- `recover` takes the same exact-input or exact-output swap and withdraw bodies.
- Receipts: withdrawal and swap terms are exact input (`amount`, with `min_amount_out` when one was
  sent) or exact output (`amount_out` and `max_amount_in`). An exact-output receipt is issued only
  for a reported delivery of `amount_out`. `verifyPaymentReceipt` takes `expect.amount_out` for an
  exact-output withdrawal; `VerifiedPayment.amount` is optional and `maxAmountIn` is new.
- Generated transparency verifier refreshed from API main (`bounded-body.ts` added).
- `GenerateIntentResponseOf<"agent_delete">` types a NEAR owner's intent as `nep366`, the
  delegate action the API generates. It was typed as `nep413`. Types only: no runtime change.

## 0.9.5 (2026-11-24)

Create an agent and its first grant with one owner signature (near/near-intents-agent-api#213,
#217; API release 1.3.0). Types regenerated from API main (513fd89a). Additive: nothing a 0.9.4
caller does changes. The new `grant` needs an API with #213.

- `agent_create` takes an optional `grant` with the same terms as `grant_issue` (`label`,
  `credential`, `expires_at`). The grant is hashed into the policy commitment the owner signs, so
  one signature creates the agent and authorizes the grant. `preview.grant` echoes it, and passkey
  previews carry `preview.wallet_request`.
- New: `verifyAgentCreateIntent(generated, { grant })` throws `AgentCreateVerificationError` unless
  the signed hash commits to exactly `preview.policy` and the grant you asked for (NEAR, EVM and
  passkey owners). Check it on your backend before the wallet signs: NEAR and EVM wallets show the
  owner only the hash. `agentCreateCommitment`, `walletRequestChallenge` and
  `serializeWalletRequestMessage` are exported for custom checks.
- `agent_create` status details carry `grant_install`: `"installed"`,
  `"refused:grant_credential_reused"` (another onboarding bound the token first) or
  `"refused:grant_expired"`; null until activation. The agent is created either way; start it only
  on `"installed"`.
- `listGrants` shows such a grant with `issued_via: { type: "agent_create", transaction_hash,
  policy_revision: 1, policy_commitment }`.
- Withdrawal previews can warn `provider_would_refuse`: the wallet provider's own dry run would
  refuse the withdrawal, its reason in `detail`.
- `sign-message` on EVM and Solana always refuses NEAR Intents payloads
  (`intents_payload_use_sign_intent`); the deployment switch that allowed them is gone.

## 0.9.4 (2026-11-19)

Approval votes report a reject that OutLayer only recorded (near/near-intents-agent-api#190).
Types regenerated from that branch. Additive: nothing a 0.9.3 caller does changes.

- `approval_vote` status details carry `repeat_required` (`boolean | null`, null until the vote
  is applied). A `reject` sent within a block or two of a policy change can be stored by the
  provider without cancelling the request. The API resends the owner's signed reject for a few
  seconds; `true` means the request is still pending after that, so generate and sign the reject
  again.
- `approval_vote` status details can carry `confirmation: "cancellation_observed"`: a fresh
  reject lost its reply, and the API observed the cancellation from the earlier receipt.

## 0.9.3 (2026-11-17)

Operation lookup by `Idempotency-Key` (near/near-intents-agent-api#182, answers #38). Types
regenerated from API main (123d86bd). Additive: nothing a 0.9.2 caller does changes. The new
method needs an API with #182.

- New: `lookupOperations(agentId, idempotencyKey, options?)` recovers the correlation ids of a
  request whose response was lost, without sending it again (`GET /v1/agents/{agent_id}/operations`,
  API key only, no grant). It returns `OperationLookup`, `{ data, retired }`.
  - `data` holds the retained operations the key admitted on the agent as `getHistory` reads
    them, newest first, with no provider call. The same key under two grants names two operations.
  - `retired` lists the correlation ids whose detail was purged after retention: the key was
    admitted and never runs again.
  - Empty lists are inconclusive: admission may be in progress, the request may have been refused
    before recording, or the original grant's id may be unavailable. Only a replay under the same
    key, body and grant settles it.
  - The key is 8 to 128 characters of `A-Z a-z 0-9 . _ : -`; the API answers another shape with a
    400. The SDK sends it as given.
- Approvals (`listApprovals`, `getApproval`) carry `votes` with retained signed submissions,
  oldest first (near/near-intents-agent-api#181, SDK #43). Each entry contains `{ voter, verdict, voted_at }`. The API records submissions
  before sending them to the provider, so entries can include submissions the provider refused or
  never received. `approval.status` reports the provider's decision.
- Live and dry withdrawals to a NEAR account without storage on the withdrawn token's contract
  return `recipient_storage_unregistered` (409). `invalid_address` covers malformed addresses and
  missing accounts (#181).
- New error code `policy_too_large` (400, near/near-intents-agent-api#185): `generateIntent` refuses
  a policy whose ciphertext is over 15,360 bytes before the owner signs, because the custody
  contract cannot log it in one write. Allow fewer assets, per-asset limits or contracts.
- The API now reads an agent's freeze state from the chain when it prepares a policy intent. An
  unreachable chain fails with `provider_unavailable` (503, retryable); a missing policy record
  with `provider_policy_unavailable` (503).
- Provider outages read faster and more precisely (near/near-intents-agent-api#180). A 2xx reply
  from the custody provider cut off mid-body is `provider_unavailable`, not `internal_error`, and
  the confidential balance read (`getBalances`) answers a provider 503 after one attempt instead
  of after the route's deadline.

## 0.9.2 (2026-11-16)

Workload identity federation for grants (near/near-intents-agent-api#86). Types regenerated from
API main (7310159d). Additive: nothing a 0.9.1 caller does changes. The new methods need an API
with #86; a grant token (`ngt_…`) works as before.

- New: `exchangeGrantToken(agentId, { subject_token, subject_token_type?, grant_id? })` trades a
  workload's OIDC identity token, or a key assertion, for an `ngs_…` session token
  (`POST /v1/agents/{agent_id}/grants/token`).
- New: `forGrantSession(agentId, { subjectToken | signer, grantId?, refreshBeforeSeconds? })`
  returns a client that exchanges on its first delegated call and keeps the `ngs_…` session.
  Concurrent calls share one exchange.
  - Renewal starts `refreshBeforeSeconds` (default 60) before the session ends, and never earlier
    than mid-life: the lead time is the smaller of that value and half the session's life.
  - From that point the current token keeps serving while one background exchange runs, until 5
    seconds before the session ends. A failed background exchange is ignored; after that point a
    call waits for an exchange and fails with its error.
  - A failed exchange is not repeated for 5 seconds, so an outage does not cost one exchange (or
    one KMS signature) per call.
  - A delegated call the API refuses with `agent_grant_required` (a revoked or replaced grant)
    throws as before and is never repeated; it also drops the cached session, so the next call
    exchanges again.
  - A grant holds at most 100 live sessions: keep one client per grant.
- New: `forGrantProof({ grantId, signer })` returns a client that signs every delegated call with
  the key of a `public_key` grant and sends `X-Grant-Proof` instead of `X-Grant-Token`: the proof
  binds the grant, method, URL, exact body bytes and `Idempotency-Key`, and every attempt signs a
  new one.
- The `signal` and timeout of a call also cover its credential step (the session exchange, or the
  signer of a proof, such as a KMS), and raise the same errors as a fetch abort or timeout, with
  the request's `idempotencyKey`. An abort never cancels an exchange other callers share.
- `forGrantProof` and `forGrantSession` check `grantId` locally (64 lowercase hex characters), and
  `forGrantSession` throws unless exactly one of `signer` and `subjectToken` is given.
- New helpers: `createWorkloadKey("Ed25519" | "P-256")`, `localJwkSigner(privateJwk)`,
  `jwkThumbprintUri(publicJwk)`, `oidcGrantAudience(baseUrl, agentId)`,
  `createKeyAssertion(signer, { baseUrl, agentId })` and `createGrantProof(signer, request)`, and
  the types `WorkloadSigner`, `WorkloadKey`, `WorkloadPrivateJwk` and `GrantProofRequest`. A signer
  is `{ publicJwk, sign(signingInput) }`, so a key in a KMS or HSM works.
- `grant_issue.credential` is now typed as a token commitment, `{ type: "oidc", … }` or
  `{ type: "public_key", jwk }` (`GrantIssueCredential`, `OidcGrantCredential`,
  `PublicKeyGrantCredential`, `GrantPublicKeyJwk`, `OidcSigningKey`). Grant views gain
  `credential_type` (`GrantCredentialType`: `token`, `oidc` or `public_key`).
- `forGrant` and the `grantToken` option accept `ngs_…` session tokens as well as `ngt_…` grant
  tokens; the refusal message is now `grantToken is not an ngt_ or ngs_ token`.
- New error codes from the API: `subject_token_invalid`, `grant_proof_invalid`, `grant_ambiguous`,
  `grant_session_limit_reached`, `issuer_unavailable` and `grant_credential_invalid`.

## 0.9.1 (2026-11-13)

Approval backlog and cancel reporting (near/near-intents-agent-api#167). Types regenerated from
API main 8814ae83. Additive only: nothing a 0.9.0 caller does changes, and every method still
works against an API without #167.

- New refusal and dry-run warning code `approval_backlog_full` (409, layer `policy`). Under
  `owner_approval` an agent can have at most 100 committed requests waiting for the owner; the next
  is refused before it reaches the provider, with nothing sent, until the owner approves or
  rejects one. Requests the API already failed take no place.
- `GET /v1/agents/{agent_id}/approvals` holds at most 100 approvals and adds `truncated`, true
  only when the provider holds more open approvals than the API created. `listApprovals` still
  returns the list. A listing that cannot finish within 20 seconds fails with
  `provider_unavailable` (503).
- `grant_revoke` status `details` add `committed_cancellations`
  (`{ order_id, committed_at }[] | null`, at most 100, `order_id` null for a cancel of every open
  order): the limit-order cancels the grant committed that may still reach the provider. They
  share `committed_truncated` with `committed_correlation_ids`.

## 0.9.0 (2026-11-12)

### Payment receipts

Payment receipts (near/near-intents-agent-api#155). Types regenerated from that merge
(13543116). Needs an API with receipts for the new methods; everything else still works against
the previous API.

- New: `getReceipt(agentId, correlationId)` reads the receipt of one settled transfer,
  withdrawal, swap, limit order or deposit, and `listReceipts(agentId, { type?, limit?, cursor? })`
  lists them, newest first (`type` keeps one type; a page can be short or empty while
  `next_cursor` is set). Each item carries `details` (the account's own view, with `usd_value?`,
  `note?`, `grant_id?` and `policy_epoch?`) and a `receipt` that is `null` while `PENDING` and for
  `UNLOGGED`. Shield, unshield and anything unsettled answer 409 `receipt_not_available`.
- New request fields: optional `reference` on `transfer` and `withdraw` (1 to 128 printable ASCII
  characters without spaces; kept in the API's record and committed to by the receipt, never sent
  on chain, not checked for uniqueness) and optional private `note` on `transfer`, `withdraw`,
  `swap`, `placeLimitOrder` and `deposit` (1 to 500 characters on one line; the account's own
  record, never in a receipt).
- New: `verifyReceipt(receipt, { origin, trusted, readTile })` checks a receipt of any type against
  a trusted checkpoint and the log's tiles and returns its typed `terms`.
  `verifyPaymentReceipt(receipt, { origin, trusted, readTile, expect })` is for a payee: it refuses
  anything but a transfer or withdrawal and compares the terms with `expect` (`recipient`, `asset`,
  `amount`, `reference`, and `chain` / `memo` for a withdrawal). It accepts only a confidential
  payment by default; pass `expect.confidential: false` to accept one from the legacy public
  balance (see the confidential-by-default entry below). Also exported:
  `logTileReader(url)`, `parseReceiptTerms`, `LogUnavailableError`, `ReceiptNotCoveredError` and
  the types `Receipt`, `ReceiptTerms`, `ReceiptType`, `TransferTerms`, `WithdrawTerms`,
  `SwapTerms`, `LimitOrderTerms`, `DepositTerms`, `SettlementHashes`, `ExpectedPayment`,
  `PaymentTerms`, `VerifiedReceipt`, `VerifiedPayment`, `TileReader`, plus `ReceiptItem` and
  `ReceiptPage`.

### Confidential by default

Confidential by default (near/near-intents-agent-api#157). Types regenerated from API main
b96969fa. **Behaviour change for callers that omit `confidential`:** they now spend, credit and
read the confidential balance, where before they used the public one. The SDK sends request bodies
as given and sets no default itself, so the change comes with the API, and a build against an
older API keeps the old behaviour.

- `confidential` defaults to `true` on `swap`, `placeLimitOrder`, `withdraw`, `transfer` and
  `deposit` (the generated request types document `@default true`). `confidential: false` is
  refused with the new error code `public_balance_exit_only` (400, layer `request`, not
  retryable), `dry` included, on `swap`, `placeLimitOrder`, `transfer` and `deposit`.
  `withdraw({ confidential: false })` still works: it pays from the legacy public balance, which
  `shield` (unchanged) or that withdrawal alone can empty. Retrying a request recorded before the
  change with the same key and an omitted `confidential` is a different request now (`409
  idempotency_conflict`): resend `confidential: false` to match the record.
- `unshield()` is `@deprecated`: the API refuses every new request with `public_balance_exit_only`.
  The method stays because the endpoint does; unshields recorded earlier still read through
  `getStatus` and `getHistory`.
- `getBalances` without `source` reads the confidential balance; `{ source: "public" }` still
  reads the public one.
- A new policy (`agent_create`, `policy_update`) must set `confidential: true` and list only
  confidential `transfer` destinations, or the API refuses it. Stored policies with
  `confidential: false` still parse; their owner signs a `policy_update` turning it on before the
  agent can shield or act confidentially, and until then a deposit address is refused with
  `policy_action_denied`.
- `verifyPaymentReceipt` accepts a confidential payment by default. A payment from the public
  balance (a withdrawal sent with `confidential: false`) needs `expect.confidential: false`.
  This reverses the default described in the receipts entry above.
- `cancelLimitOrder` refunds to the balance that funded the order, so a resting public order
  placed before the change still cancels to the public balance.

## 0.8.2

Sign-intent 1Click deposits are proven by 1Click's signed quote (near/near-intents-agent-api#151).
Types regenerated from that branch.

- `nativeEvmSignIntent` / `nativeSolanaSignIntent` requests take optional `one_click_quotes`: one
  unchanged 1Click `POST /v0/quote` answer (live, `dry: false`) per deposit address the payload
  pays outside `receivers`, at most two. The API verifies 1Click's signature offline and no longer
  reads 1Click's deposit status, so confidential (`intents.far`) deposits now work. A payload that
  pays a 1Click deposit without its quote is refused with `policy_destination_denied`.
- `max_slippage_bps` now bounds the value lost at the quote's `minAmountOut`, by 1Click's signed USD
  amounts with every fee included, instead of `slippageTolerance` plus 1Click's fee.
- New type `OneClickQuote`.

## 0.8.1

Limit orders, and the API types regenerated from API main a10cbbf6 (near/near-intents-agent-api#109
and #143: dry previews declared as 200 `QuoteResponse`; a held limit order is re-priced when the
owner approves). Needs an API with limit orders for the new methods; everything else still works
against the previous API. Nothing in this release breaks code that reads responses; code that
builds a `DeletionPreview` literal (a test fixture, a demo mode) must add `open_limit_orders`.

- New: `placeLimitOrder(agentId, request, options?)` places a resting order on the agent's public
  NEAR Intents balance, or with `confidential: true` on its confidential balance, and funds it in
  full. Like `swap` it needs a grant and an idempotency key (the SDK generates one and returns it
  as `idempotencyKey`) and gets the 150 s settlement budget. `dry: true` previews it with the API key
  alone (no grant, no idempotency key), makes no provider call and returns a `QuoteResponse` whose `warnings` list every
  rule a live order would fail. `SUCCESS` means the order is funded and resting, not filled:
  `details.order_id` names it.
- New reads and cancels: `listLimitOrders(agentId, { open?, limit?, offset? })` (newest first,
  `{ data }`; `limit` at most 100), `getLimitOrder(agentId, orderId)` (live `fill_status`,
  `partial_fills`, `payouts`, `is_payout_status_final`), `cancelLimitOrder(agentId, orderId)` and
  `cancelAllLimitOrders(agentId)` (up to 50 a call; repeat until `complete` is true). Both cancels
  need a grant but no timelock, schedule or approval, and work while the agent is frozen or the
  policy no longer allows `limit_order`. The USD budget charged when an order was placed is not
  given back by a cancel.
- New types: `LimitOrderRequest`, `LimitOrderView`, `LimitOrderPage`, `CancelLimitOrderResult`,
  `CancelAllLimitOrdersResult`. `ExecutionType` gains `limit_order`, so
  `StatusResponseOf<"limit_order">` is the status of a placed order.
- Policy: `actions` may now include `limit_order`, and the new optional `limit_order:
  { max_deviation_bps }` (0 to 300, default 100) bounds how far worse than the market a price may
  be. A policy without `limit_order` makes the API cancel the agent's open orders, as does a
  freeze. A confidential order also needs `confidential`.
- New error codes: `policy_price_deviation_exceeded` (the price is worse than the market by more
  than `max_deviation_bps`), `market_price_unavailable` (no fresh price for either asset),
  `limit_order_not_found` and `limit_orders_open` (an agent cannot be deleted while orders are not
  payout-final). `amount_too_low` also refuses an order worth under 0.1 USD. `AgentApiError` is
  unchanged: branch on `code`.
- Regenerated API types: quote `warnings[].code` adds `amount_too_low`,
  `policy_price_deviation_exceeded` and `market_price_unavailable`; the quote's `type` adds
  `limit_order`; `RecoverRequest.request` accepts a `limit_order` (recover an UNCERTAIN order under
  its original key); `ExecutionDetails` gains `order_id`, `side`, `price`, `quantity` and `deadline`
  in its request terms; `DeletionPreview` gains `open_limit_orders`.
- Regenerated API types: `ExecutionDetails.available_amount` is what the spent balance holds
  (`insufficient_balance`, atomic units) or what the agent's NEAR account holds
  (`custody_native_balance_required`, yoctoNEAR), kept on the operation so a replay or status read
  states it too. On `custody_native_balance_required` the error's `availableAmount` and `minAmount`
  now carry what the account holds and what the call costs, in yoctoNEAR (before, only
  `insufficient_balance` and `amount_too_low` stated an amount).
- API behaviour, no type change: a withdrawal of a token to a NEAR account with no storage on that
  token's contract (a fresh 1Click deposit address for NEAR USDC) is refused with
  `invalid_address` (409), as is its preview, where it used to answer `validation_failed` or return
  a quote. Register the receiver's storage first, or move the funds inside NEAR Intents.

## 0.8.0 (2026-11-06)

Partner API keys now come from the partner portal (https://partners.near-intents.org), not from
the API. Needs an API with portal-issued keys.

- Breaking: `AgentApi` no longer checks the shape of `apiKey`; it accepts any non-empty string
  (an empty or whitespace-only value still throws at construction). The key is opaque: the portal
  shows it once, it expires 365 days after creation, a partner holds up to 10 live keys, and
  revoking one in the portal stops new dispatches at once and other requests within 30 seconds.
  Rotate by creating a new key, deploying it and revoking the old one. Keys created before the
  partner portal are retired.
- Breaking: `PartnerQuotaView` (`getPartnerQuota`) drops `limits.api_keys` and `usage.api_keys`.
  Code that read them must drop them.
- New error code `api_key_retired` (401, `layer: "auth"`, not retryable): the key was created
  before the partner portal; create a new one in the portal. `invalid_api_key` now names the portal
  in its `detail`, and `key_verification_unavailable` (503, retryable) is answered while the portal
  is down for a key it has not answered for before. `AgentApiError` is unchanged: branch on `code`.
- Breaking: `verifyOperationProof(document, origin, trusted)` requires a trusted `Checkpoint` as a
  third argument and returns the verified `checkpoint`. It refuses a proof whose checkpoint does not
  extend the trusted one (rollback, fork, smaller tree, missing consistency path) and a response
  without a signed `checkpoint`. The two-argument form is gone.
- Breaking: `getOperationProof(agentId, correlationId, query?, options?)` takes the new `query`
  (`{ from_size?: string }`) before `options`. Callers that passed request options as the third
  argument must move them to the fourth.
- New: `fetchWitnessCheckpoint(api, origin, witnessKey)` fetches the checkpoint witness's head
  from `/tee/witness` over HTTPS and verifies its signature against a witness key you pin. Use that
  head as `trusted` and its size as `from_size`. New type export `Checkpoint`.
- Regenerated API types: the quotas change above. The operation proof response's `checkpoint` and
  `consistency` are now what `verifyOperationProof` checks. The generated transparency code also
  gains Intel Trust Authority token, TDX quote and attested-key verifiers (not exported from the
  package); their parser dependencies (`@peculiar/asn1-schema`, `@peculiar/asn1-x509`, `jose`) are
  dev dependencies of the SDK because the published bundle does not import them.

## 0.7.4

- `nativeEvmSignIntent` and `nativeSolanaSignIntent`: the agent's EVM or Solana key signs a NEAR
  Intents payload (canonical JSON text, `transfer` intents only, signer = that key's Intents
  account) and answers `signed_data` to publish as is to `intents.near`, 1Click or a solver relay.
  They need the new `native.evm.sign_intent` / `native.solana.sign_intent` rules
  (`SignIntentRules`): `{ receivers, one_click_deposits, withdrawals?, max_slippage_bps? }`.
  `receivers` are the accounts a transfer may pay; with `one_click_deposits` a transfer may also
  fund a 1Click deposit address whose quote pays the key or a listed receiver and refunds the key;
  `withdrawals` (`[{ chain, address }]`) lets such a deposit pay out to a listed address on another
  chain. Slippage plus 1Click's own fee must stay within `max_slippage_bps` (0–300, default 100).
  A payload paying only such deposits may be due up to 96 hours ahead; anything else within 300
  seconds. These rules are the key's own: `destinations`, `assets`, `limits` and `budget` do not
  apply. A freeze refuses new payloads but cannot recall one already signed.
- `nativeSolanaSignIn` (Sign-In-With-Solana for a domain in `native.solana.sign_in`) and
  `nativeSolanaSignTransfer` (one SOL or SPL transfer to a `recipient` that `destinations` allows,
  under `native.solana.sign_transfer`, without the full-control `sign_transaction`).
- Regenerated API types: native `method` adds `evm_sign_intent`, `solana_sign_in`,
  `solana_sign_intent` and `solana_sign_transfer`; policy `native.solana` adds `sign_in`,
  `sign_intent` and `sign_transfer`, `native.evm` adds `sign_intent`.

## 0.7.3

- Regenerated API types. `DeletionPreview` no longer has `native_balance`: the API stopped
  reading the custody account's native NEAR, which still goes to the sponsor (`beneficiary`).
  Code that read it must drop it.
- Deposit execution details and results add optional `deposit_seen_at`, the first time the API saw
  funds (or processing) for the address. A payment that lands after the address expired reopens
  the deposit instead of leaving it `expired`.
- Dry swap and withdrawal `warnings` add `policy_transaction_limit_exceeded` (an amount above the
  policy's per-transaction limit).
- Regenerated descriptions: a withdrawal preview counts toward the wallet's 1,000 custody
  operations per rolling 24 hours at the provider (was 100). NEAR sent by `nativeNearTransfer`, or
  attached as a `nativeNearCall` deposit, must land where `destinations` allows. A confidential
  bridged withdrawal preview values its `fee`.
- Native NEAR transfers and calls read `SUCCESS` only once the chain finalizes the requested
  transaction; `native_transaction_failed`, `native_transaction_mismatch` and
  `native_transaction_unconfirmed` are possible outcomes. Status and history return
  `signature: null` for native requests; only the signing call returns the signature.

## 0.7.2

- `AgentApiError.retryAfterSeconds`: the response's `Retry-After` header in whole seconds
  (delay-seconds or an HTTP date), when it sent one. It is the API's own wait for a throttle or
  outage whose end `availableAt` cannot name.
- Regenerated API types: `BudgetView` `spent_usd` is `string | null`. An uncapped window has no
  period and counts nothing, so `limit_usd`, `spent_usd`, `remaining_usd` and `resets_at` are all
  null.
- Regenerated descriptions: a withdrawal preview's `fee` on chain `near` falls back to `amount`
  minus `quote.amount_out` when the provider states no estimate in the withdrawn asset. A dry swap
  or withdrawal for an unlisted asset (`unsupported_token`) or an invalid recipient
  (`invalid_address`) is refused before any provider call and uses no preview attempt. Only an
  answer the provider gives before running anything (its rate limiter's 429, `wallet_busy`,
  `provider_limit_reached`) gives a preview attempt back; a provider refusal such as
  `route_unavailable`, an outage or an uncertain attempt stays counted.

## 0.7.1

- Regenerated API types: a dry swap or withdrawal (`QuoteResponse`) carries `owner_approval`,
  true when the live request would wait in `PENDING_APPROVAL` for the owner.

## 0.7.0

- Breaking: regenerated API types. Every error object has a required
  `layer` (`request`, `auth`, `grant`, `policy`, `budget`, `balance`, `provider` or `api`).
  `AgentApiError` adds `layer` (typed `ApiErrorLayer`, exported; `undefined` only when the
  response was not an API error document) and `availableAmount` (`meta.available_amount` on
  `insufficient_balance`). `retryable` is unchanged: true means the same Idempotency-Key can
  succeed, and an absent flag proves nothing.
- Breaking: three error codes are removed, with no aliases: `quote_unavailable` is
  `provider_unavailable` (503, retryable when not recorded), `invalid_request` is
  `validation_failed`, and `status_not_found` is `operation_not_found`. `route_unavailable` means
  no route for this pair or amount; repeating the same request will not help.
- New error code `provider_refused` (400, layer `provider`, not retryable): the provider refused
  the request for a reason it states in `detail`, such as a deposit quote 1Click rejected in words
  the API does not map to another code. Nothing was submitted or charged; change the request and
  send it under a new key.
- `listReleases()`, `getLatestRelease()` and `getRelease(version)` read the public
  `/v1/releases` feed: each release's `version`, `status` (`announced`, `active`, `retired`,
  `withdrawn`), `type`, `announced_at`, `effective_at`, `notice_hours`, `changes`,
  `breaking_changes`, `action_required` and `compose_hash`. Read `action_required` and adapt
  before `effective_at`.
- Budget and limit refusals (`spend_budget_exceeded`, `spend_price_unavailable`,
  `policy_limit_exceeded`, `policy_action_limit_exceeded`, `policy_usage_unavailable`) on a request
  that runs now are plain refusals: no operation, no `FAILED` status, no charge. Retrying the same
  key refuses again. Timelocked work is still judged when it dispatches.
- Dry swap and withdrawal preview `warnings[].code` gains `policy_action_denied`,
  `policy_destination_denied`, `unsupported_token`, `invalid_address` and `insufficient_balance`
  (which carries `available_amount`). The withdrawal preview warns about the action and the
  destination instead of refusing; the dry swap still needs no grant.
- `getBalances` entries add `available_raw` (atomic) and `available` (exact units or null): the
  balance minus queued or timelocked work not yet dispatched. `insufficient_balance` reports the
  available figure. Queued requests claim the balance in the order they were admitted. Every
  asset answers for itself: `nep141:wrap.near` and `nep141:native` are separate balances, and a
  `near` request spends `nep141:wrap.near`.
- Breaking: `details.amount_out` is present only on `SUCCESS`,
  or on `REFUNDED` after a partial fill. Before that, read the new `details.expected_amount_out`.
- A withdrawal preview refused before quoting gives its daily attempt back;
  outages and uncertain attempts stay counted.
- An unpaid deposit ends `FAILED` with `deposit_expired` one day after `expires_at`; a deposit with
  a known deposit tx or amount never expires. A late payment is refunded to `refund_to`.

## 0.6.2

- Breaking: withdrawals drop `wrapped`. NEAR (`nep141:wrap.near`, or `near`) withdrawn to chain
  `near` always arrives as native NEAR, from the public or the confidential balance; there is no
  wNEAR option. Sending `wrapped` is `validation_failed`, and `wrapped_unsupported` is gone.
- Every amount that moves funds must be above zero, and a swap's two assets must differ; otherwise
  `validation_failed`.
- A transfer's `recipient` must be a valid NEAR account id, and a named account must exist on NEAR
  (implicit ids need none), else `invalid_address`. When NEAR RPC cannot answer, the transfer fails
  with `near_rpc_unavailable` (503, retryable) and nothing is sent.
- A recipient that is not a valid address for its chain is `invalid_address` (400) before the
  policy is read, for every execution.
- A deposit with no address ten minutes after creation ends `FAILED` with
  `deposit_address_missing`.
- Status `details` add `request`: the request as admitted, in the request body's field names
  (`origin_asset`, `destination_asset`, `asset`, `amount`, `min_amount_out`, `chain`, `recipient`,
  `memo`, `confidential`).
- `min_amount_out` is sent to the provider as the minimum output; the quote does not apply it. A
  swap reported below it reads `NEEDS_REVIEW` with `amount_out_below_minimum`, never `SUCCESS`.
- `native/evm/sign-transaction` accepts only one unsigned EIP-2718 typed or EIP-155 legacy
  transaction for `chain`; `native/solana/sign-transaction` only one legacy or v0 transaction
  message. Anything else is `validation_failed`.

## 0.6.1

- `AgentApiError` adds `minAmount`: on `amount_too_low`, the route's minimum in atomic units of
  the asset sent, when the provider states one (`errors[0].meta.min_amount`). A refusal recorded
  against an operation keeps it as `details.min_amount` on the operation's status.
- `getContainment` types its inventories: `grants.data` entries carry `grant_id`, `label`,
  `owner_epoch`, `issued_at`, `expires_at`, `revoked_at`, `grant_record_current` and `findings`;
  `pending_operations.data` entries carry `operation_id`, `kind`, the public `status` and
  `failure_code` that `getStatus` reports (`UNCERTAIN`, `QUEUED`, …, not the stored lifecycle
  word), `action`, `disposition`, `created_at` and `updated_at`.
- A dry `withdraw` to any chain but `near` reports `fee: null`: its `quote.amount_out` is in the
  destination chain's asset, so compare `amount` with `amount_out` yourself. `high_fee` is judged
  only where `fee` is valued.
- The account's `budget` windows (a quote's `spend.budget`, the policy view's `usage.budget`) count periods that
  start when each cap is turned on, not a rolling window: `resets_at` is when the current period
  ends and the whole cap is available again (`null` when uncapped). No type change.

## 0.6.0

- Breaking: `nativeNearSignMessage` is generic NEP-413 `signMessage`. The request is now
  `{ message, recipient, nonce, encoding? }` with the relying party's base64 32-byte `nonce` (it is
  required; the API no longer makes one), and `message` is signed as sent instead of having to be a
  `near-intents-agent-api.identity.v1` challenge. `signature` in the response is base64 (it was
  hex); `nonce` echoes the request's. `native.near.sign_message` lists recipients, which may be
  NEAR accounts or domains such as `app.example.com`. `callbackUrl` is not supported. The API
  checks the signature before it answers; the NEAR Intents contracts are still never recipients.
- A dry `swap` or `withdraw` quote gains `spend` (`amount_usd` and the account's `budget`
  windows), `fee` (`{ amount_usd, percent }` or null) and `warnings`. A warning is `high_fee` (above
  5%), `asset_delivered_as_is` (a non-USDC asset withdrawn to `hypercore`) or a spending rule the
  live request would fail, under the code that request would get: `policy_asset_denied` (an asset the policy does
  not list), `policy_schedule_denied` (with `available_at`), `spend_price_unavailable`, `spend_budget_exceeded`, `policy_limit_exceeded`,
  `policy_action_limit_exceeded` or `policy_usage_unavailable` (unreconciled history keeps the
  limits from being judged). The spending rules never refuse a dry run; only the live request is
  refused. An archived, deleted or frozen account, or one whose applied policy does not parse, gets
  no quote: a swap quote and a withdrawal preview are refused with `agent_archived`,
  `agent_deleted`, `wallet_frozen` or `policy_not_ready`, reach no provider and use no attempt. Every preview that reaches the provider uses one of the 20 daily attempts,
  rule warning or not.
- A `native.evm.sign_typed_data` entry may add `primary_types`, so the domain signs only those
  message types. Native details add `domain` and `message_json` (the signed message as canonical
  JSON) for typed-data signatures; a typed-data `message` is at most 65536 bytes.

## 0.5.3

- Breaking: `sign` is replaced by eight `native*` methods for the agent's own keys outside NEAR
  Intents: `nativeNearSignMessage` (the former `sign`, same request and response),
  `nativeNearTransfer`, `nativeNearCall`, `nativeEvmSignTypedData`, `nativeEvmSignMessage`,
  `nativeEvmSignTransaction`, `nativeSolanaSignMessage` and `nativeSolanaSignTransaction`. The API
  no longer serves `/sign`. Each method needs a grant token, an unfrozen agent and its switch in
  the policy's optional `native` block, which replaces `sign: { recipients }` (now
  `native.near.sign_message`); omitted, every method is off. NEAR transfer and call take an
  `Idempotency-Key`; every request is recorded in history as type `native`.
- `native.evm.sign_typed_data` lists EIP-712 domains (`name`, `version`, `chain_id`,
  `verifying_contract`, `salt`); a request's `domain` must match one entry field for field.
  `types.EIP712Domain` may be omitted, and the API derives it.
- The agent's `wallet` adds `evm_account_id` (one address on every EVM chain) and
  `solana_account_id`, null until the provider has reported them.

## 0.5.2

- Withdrawal previews (`withdraw` with `dry: true`) now carry an `Idempotency-Key`, which the API
  requires along with the grant. The SDK creates one unless `idempotencyKey` is passed and returns
  it as `result.idempotencyKey`. An identical preview under the same key replays its result for 60
  seconds; after that, preview under a new key. The API admits 20 previews per agent per rolling 24
  hours, failed ones included (`withdraw_preview_limit_reached`). Swap quotes still need no key.
- Generated wire types follow the deployed API: the operation proof response adds `checkpoint` and
  `consistency`. `getOperationProof` and `verifyOperationProof` are unchanged.

## 0.5.1

- `getHistory` takes `include_unpaid?: boolean`. History now leaves out deposit addresses nothing
  was paid into (open, expired, or closed by deletion) unless it is set; each stays readable through
  `getStatus`.
- Deposit addresses without an `amount` stay open 3 days (was 14). Each agent can be issued 100
  addresses per rolling 24 hours (was 500 per partner); over that, `deposit_quota_exceeded`.
- Deleting an agent is no longer refused by deposit addresses waiting for payment; the deletion
  closes them as `FAILED` with `agent_deleted`.

## 0.5.0

- Withdrawals: `wrapped?: boolean` on the request. NEAR withdrawn to chain `near` arrives as native
  NEAR; `wrapped: true` delivers wNEAR instead.
- Status `details` add `requested_min_amount_out`, `requested_asset` and `delivered` (the asset a
  withdrawal actually delivered), plus `policy_record` (status, refund and storage deposit of the
  on-chain policy record).
- `verifyOperationProof` also binds the proof to its agent: each event's signed `agent_id` must
  match the document's, and the caller checks `agent_id` and `correlation_id` are the ones asked for.
  `AuditProof` documents carry `agent_id`.
- `AgentApiError` docs state the strict `retryable` contract: `true` means the identical request
  under the same `Idempotency-Key` can succeed; `false` never proves nothing was sent.
- Expired unpaid deposits end `FAILED` with `deposit_expired`.

## 0.4.1

- Each `AuditProof` adds `evidence`, the result the event recorded as canonical JSON. The verifier
  checks it against the opening's `evidenceHash` and returns it parsed on each proven event.

## 0.4.0

- `Policy` adds the optional `sign: { recipients }`, replacing `sign_message`. Omitted, the agent
  signs nothing; listed, any grant may sign identity challenges for those NEAR accounts. The NEAR
  Intents contracts (`intents.near`, `intents.far`) are never accepted.
- `signMessage` is renamed `sign` and calls `POST /v1/agents/{agent_id}/sign`; `SignMessageRequest`
  is renamed `SignRequest`. Signing no longer depends on a server setting.
- New error code `signing_recipient_forbidden`.
- `getOperationProof(agentId, correlationId)` returns every audit event of an execution with a
  `c2sp.org/tlog-proof@v1` against the notary-signed checkpoint of the API's transparency log, plus
  the notary keys and their TDX birth attestation. New types `OperationProof` and `AuditProof`.
- `verifyOperationProof(proof, origin)` checks such a proof offline and throws `NoteError` or
  `ProofError` when it does not hold. Its code is generated verbatim from the API's transparency
  package into `src/generated/transparency`, and adds the `@noble/curves` dependency.

## 0.3.0

- `Policy` adds the optional `schedule`: `{ mode: "only" | "except", time_zone, windows: [{ days,
  start, end }] }`, weekly windows on the owner's clock when money actions may run or are paused.
  New types `Schedule`, `ScheduleWindow` and `ScheduleDay`.
- A money action outside the schedule fails with `policy_schedule_denied`; `AgentApiError.availableAt`
  is the earliest time to submit again.

## 0.2.0

- `deposit`: `amount` is optional. Without it, the address accepts any amount at or above
  `details.min_amount` until `details.expires_at`.
- `deposit`: `refund_to` is removed. A failed or late deposit refunds into the agent's own
  balance, reported as `details.refund_to`.
- Status `details` add `memo`, `min_amount`, `min_amount_out`, `expires_at` and `refund_to`, and
  drop `intent_id`.

## 0.1.1

First release of `@near-intents-agent-api/sdk`: a thin, typed, server-side HTTP client with one
method per endpoint, JSON:API errors, request-local idempotency keys, grant-bound clients
(`forGrant`, `createGrantCredential`) and plain TypeScript types generated from the API's OpenAPI
document. `baseUrl` is optional and defaults to `https://api.agentsonintents.com`. The package ships
no runtime schemas.
