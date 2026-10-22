# Changelog

## Unreleased

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
