# Changelog

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
