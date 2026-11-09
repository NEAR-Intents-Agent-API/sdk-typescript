# Changelog

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
