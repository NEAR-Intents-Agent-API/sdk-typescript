# Changelog

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
