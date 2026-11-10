<div align="center">

# `@near-intents-agent-api/sdk`

**Typed TypeScript client for the NEAR Intents Agent API.**

[![npm](https://img.shields.io/npm/v/@near-intents-agent-api/sdk)](https://www.npmjs.com/package/@near-intents-agent-api/sdk)
[![CI](https://github.com/NEAR-Intents-Agent-API/sdk-typescript/actions/workflows/ci.yml/badge.svg)](https://github.com/NEAR-Intents-Agent-API/sdk-typescript/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@near-intents-agent-api/sdk)](LICENSE)
![node](https://img.shields.io/node/v/@near-intents-agent-api/sdk)

[Install](#install) · [How it fits](#how-it-fits-together) · [Create an agent](#create-an-agent) · [Let an agent act](#let-an-agent-act) · [Errors](#errors) · [Methods](#methods)

</div>

> The Agent API is an experimental, mainnet-only beta. You and your users may lose all assets used with it, or lose access to them. It is operated by NEAR Technologies Limited.

Give an AI agent its own agent account on NEAR Intents, let its owner sign the spending rules
once, and let the agent swap, transfer and withdraw inside those rules.

- One method per endpoint, plain TypeScript types for every request and response.
- Runs on your **backend**. It holds your partner API key, so it never belongs in a browser.
- No wallet signers, no React hooks, no automatic retries. Types only, no runtime schemas.
- Offline verification of operation proofs, and grant-token and idempotency-key helpers.

> [!WARNING]
> The hosted API runs on mainnet with real funds. Build with small amounts and a dedicated owner account.

## Install

```sh
npm install @near-intents-agent-api/sdk
```

Requires Node.js 24+.

## How it fits together

| Who | Proves itself with | Does what |
|---|---|---|
| **Your backend** | Partner API key | Creates agents, reads state, prepares owner actions |
| **The owner** (NEAR account, EVM wallet or passkey) | A wallet signature, once per change | Creates the agent, sets its rules (the *policy*), issues grants, freezes, deletes |
| **The agent** (an assistant, bot or session) | A grant token (`ngt_…`) | Swaps, transfers and withdraws inside the owner's policy |

The owner signs; your backend never holds the owner's keys. A grant says only *who* may act, and
the policy says *what* any grant may do, where funds may go and how much.

## Setup

Create a partner API key in the [partner portal](https://partners.near-intents.org/) and keep it out of git.
The portal shows a key once and you can hold up to 10 live keys. A key expires 365 days after it is
created. To rotate it, create a new key, deploy it, then revoke the old one in the portal. A
revoked key stops new dispatches at once and every other request within 30 seconds. Keys created
before the partner portal are retired: the API refuses them with `api_key_retired`, so create a new
one.

> [!CAUTION]
> The partner API key identifies your backend. Never ship it to a browser, mobile app, prompt or log.
> Treat it as an opaque string: the SDK sends it as `X-API-Key` and does not parse it.

```sh
# .env: partner API key from the partner portal
NEAR_INTENTS_AGENT_API_KEY=
```

```ts
import { createAgentApi } from "@near-intents-agent-api/sdk";

const api = createAgentApi({ apiKey: process.env.NEAR_INTENTS_AGENT_API_KEY! });
```

Run it with `node --env-file=.env your-script.js`. The client talks to
`https://api.agentsonintents.com` by default. Pass `baseUrl` only for a self-hosted or local
deployment (HTTPS, or HTTP for `localhost`):

```ts
const local = createAgentApi({ apiKey: process.env.NEAR_INTENTS_AGENT_API_KEY!, baseUrl: "http://localhost:3000" });
```

Check the connection:

```ts
const network = await api.getNetwork(); // public: service and provider status
const release = await api.getLatestRelease(); // public: the announced or active release and what to adapt to
const me = await api.whoami(); // validates the API key; never returns the key
const tokens = await api.getTokens(); // public: every asset an agent can use
```

## Create an agent

Creating an agent is an **owner action**: your backend prepares it, the owner's wallet signs it,
your backend submits it. Every owner action follows the same four steps.

Before the owner signs, show the Owner Terms, OutLayer's terms and the required risk notice, and
keep evidence of acceptance. `preview.summary` ends with the notice. Show it again before the owner
funds the wallet.

```ts
import type { Policy } from "@near-intents-agent-api/sdk";

// 1. The rulebook. It is always sent complete, and the owner signs all of it at once.
const policy: Policy = {
  frozen: false,
  actions: ["swap", "transfer"], // any of "swap" | "transfer" | "withdraw" | "limit_order"
  confidential: false, // true also allows the confidential balance and confidential routes
  owner_approval: false, // true makes every outgoing action wait for the owner's vote
  assets: "any", // or the exact asset ids the agent may spend
  limits: {
    // optional per-asset caps in atomic units: per_transaction, hourly, daily, monthly
    per_transaction: { "nep141:wrap.near": "1000000000000000000000000" },
  },
  max_actions_per_hour: null,
  destinations: { mode: "only", list: [] }, // no destinations: funds stay in the account
  budget: { daily_usd: "100", weekly_usd: null, monthly_usd: null }, // USD caps across assets
  timelock_ms: 0, // delay before every money action runs (deposits excepted)
};

// 2. Prepare. The response carries the exact payload the owner's wallet must sign.
const generated = await api.generateIntent({
  type: "agent_create",
  name: "My first agent",
  owner: { type: "near", account_id: "alice.near", public_key: "ed25519:..." },
  policy,
});
generated.preview.policy; // show the owner what they are about to authorize

// 3. The owner signs `generated.intent` with their wallet (see "Signing" below).
const signedData = await signWithWallet(generated.intent);

// 4. Submit, then follow the operation to its end.
await api.submitIntent({
  type: generated.type,
  correlation_id: generated.correlation_id,
  signed_data: signedData,
});
const status = await settled(generated.correlation_id);
if (status.status !== "SUCCESS") throw new Error(status.failure_code ?? status.status);

const agentId = generated.agent_id;
const agent = await api.getAgent(agentId);
const wallet = await api.getWallet(agentId);
```

`settled` polls the status endpoint, which long-polls for up to 30 seconds per call:

```ts
async function settled(correlationId: string) {
  while (true) {
    const status = await api.getStatus(correlationId, { waitMs: 30_000 });
    if (status.status !== "PROCESSING" && status.status !== "QUEUED") return status;
  }
}
```

### Signing

`generated.intent` is `{ standard, payload }`. The wallet signs `payload` exactly as returned, and
you submit the wallet's output back. Pick the wallet method from `intent.standard`; never rebuild,
hash or reorder the payload:

```ts
async function signWithWallet(intent: GenerateIntentResponse["intent"]): Promise<SignedData> {
  switch (intent.standard) {
    case "nep366": // NEAR: gasless delegate action, submitted by the API's sponsor
      return { ...intent, signed_delegate: (await wallet.signDelegateActions({ delegateActions: [intent.payload] })).signedDelegateActions[0] };
    case "nep413": { // NEAR: message signature
      const nonce = Uint8Array.from(atob(intent.payload.nonce), (c) => c.charCodeAt(0));
      const { publicKey, signature } = await wallet.signMessage({ ...intent.payload, nonce });
      return { ...intent, public_key: publicKey, signature };
    }
    case "eip712": // EVM wallet
      return { ...intent, signature: await walletClient.signTypedData({ account, ...intent.payload }) };
    case "webauthn": // passkey
      return { ...intent, credential: await startAuthentication({ optionsJSON: intent.payload }) };
  }
}
```

The SDK contains no signers. The `wallet`, `walletClient` and `startAuthentication` above are your
own wallet integration (NEAR wallet selector, viem, `@simplewebauthn/browser`). In a web app the
usual split is: your backend calls `generateIntent` and returns the intent to the browser, the
browser signs with the user's wallet, and your backend calls `submitIntent` with the result.

## Fund the account

Incoming funds need no grant. Ask for a deposit address, send to it, and follow the status:

```ts
const deposit = await api.deposit(agentId, {
  origin_asset: "nep141:usdt.tether-token.near",
  confidential: false,
});
// Send at least deposit.details.min_amount to deposit.details.deposit_address (with
// deposit.details.memo if present) before deposit.details.expires_at, then poll
// getStatus(deposit.correlation_id). Add `amount` (atomic units) for an exact deposit.
// Without it the address stays open 3 days. An unpaid deposit ends FAILED with
// failure_code "deposit_expired" one day after expires_at; one with a known deposit tx or amount
// never expires. A failed or late deposit refunds into the agent's own balance
// (deposit.details.refund_to). Until something is paid in, getHistory lists the
// address only with { include_unpaid: true }.

const balances = await api.getBalances(agentId);
// Each entry has balance_raw / balance (what the account holds) and available_raw / available:
// the balance minus queued or timelocked work that has not been dispatched yet. Show and check
// `available`; dispatched work is already debited. `available` is null when the exact units are
// not known; `available_raw` is always the atomic amount.
```

Amounts are strings in the token's **atomic units**. Asset ids come from `getTokens()`.

## Let an agent act

Each assistant, session or bot gets its own **grant**. You create the token, the owner signs only
its commitment, and the token stays on your backend (encrypted):

```ts
import { createGrantCredential } from "@near-intents-agent-api/sdk";

const { token, commitment } = createGrantCredential();
const grant = await api.generateIntent({
  type: "grant_issue",
  agent_id: agentId,
  label: "Trading assistant",
  credential: commitment,
  expires_at: new Date(Date.now() + 86_400_000).toISOString(), // at most 365 days ahead
});
// The owner signs grant.intent and your backend submits it, exactly as in "Create an agent".

const assistant = api.forGrant(token); // one client per grant
```

The agent then acts within the policy, with no further owner signature:

```ts
const swap = {
  origin_asset: "nep141:wrap.near",
  destination_asset: "nep141:usdt.tether-token.near",
  amount: "1000000000000000000000000",
};
const quote = await assistant.swap(agentId, { ...swap, dry: true }); // preview, moves nothing
const execution = await assistant.swap(agentId, swap);
const done = await settled(execution.correlation_id);

await assistant.transfer(agentId, { asset: "nep141:wrap.near", amount: "1", recipient: "bob.near" });
// NEAR withdrawn to chain "near" always arrives as native NEAR, public or confidential.
const withdrawal = { asset: "nep141:wrap.near", amount: "1", chain: "near", recipient: "bob.near" };
const fees = await assistant.withdraw(agentId, { ...withdrawal, dry: true }); // preview, under its own key
await assistant.withdraw(agentId, withdrawal);
```

If the policy refuses, the call fails with a stable `code` such as `policy_action_denied`,
`policy_destination_denied`, `spend_budget_exceeded` or `insufficient_balance`, and `error.layer`
says which layer refused: `request`, `auth`, `grant`, `policy`, `budget`, `balance`, `provider` or
`api`.

Budget and limit refusals (`spend_budget_exceeded`, `spend_price_unavailable`,
`policy_limit_exceeded`, `policy_action_limit_exceeded`, `policy_usage_unavailable`) are plain
refusals for a request that runs now: no operation exists, nothing is charged, and there is no
`FAILED` status to read. Repeating the same key refuses again. Work held by a timelock is judged
when it dispatches. `insufficient_balance` carries `error.availableAmount`, the available figure
(see `getBalances`). A dry swap or withdrawal never refuses for these reasons; it warns:
`quote.warnings[].code` is one of `policy_action_denied`, `policy_destination_denied`,
`policy_asset_denied`, `policy_transaction_limit_exceeded`, `policy_schedule_denied`, `spend_price_unavailable`,
`spend_budget_exceeded`, `policy_limit_exceeded`, `policy_action_limit_exceeded`,
`policy_usage_unavailable`, `unsupported_token`, `invalid_address`, `insufficient_balance`
(with `available_amount`), `amount_too_low`, `policy_price_deviation_exceeded`,
`market_price_unavailable` (the last three for limit orders), `high_fee` or `asset_delivered_as_is`. A withdrawal preview warns
about the action and the destination instead of refusing. `quote.owner_approval` is true when
the live request would wait in `PENDING_APPROVAL` for the owner.

### Limit orders

A limit order rests on the NEAR Intents order book until it fills, is cancelled or reaches its
`deadline` (default and maximum seven days). The policy must list `limit_order` in `actions`, and
`confidential` as well for `confidential: true` (funded from, and paid back to, the confidential
balance). An optional `limit_order: { max_deviation_bps }` (0 to 300, default 100) bounds how far
worse than the market the price may be: a sell that far below, a buy that far above. A better
price is not limited. The order is judged like a swap on the asset it spends (assets, limits,
actions per hour, USD budget, `timelock_ms`, `schedule`, `owner_approval`); `destinations` does
not apply.

```ts
const order = {
  base_asset: "nep141:wrap.near",
  quote_asset: "nep141:usdt.tether-token.near",
  side: "sell" as const, // "sell" spends `quantity` of base_asset; "buy" spends what it costs at `price`
  quantity: "1000000000000000000000000", // base_asset, atomic units
  price: "5.2", // quote units per one whole base unit, a plain decimal
};
const preview = await assistant.placeLimitOrder(agentId, { ...order, dry: true }); // no key, no provider call
const placed = await assistant.placeLimitOrder(agentId, order); // SUCCESS = funded and resting, not filled
const orderId = placed.details?.order_id;

const open = await assistant.listLimitOrders(agentId, { open: true }); // { data: [...] }
const live = await assistant.getLimitOrder(agentId, orderId); // fill_status, partial_fills, payouts
await assistant.cancelLimitOrder(agentId, orderId); // unfilled funds return to the balance
let round = await assistant.cancelAllLimitOrders(agentId); // up to 50 a call
while (!round.complete) round = await assistant.cancelAllLimitOrders(agentId);
```

`placeLimitOrder` needs a grant and an idempotency key like a swap; the dry preview needs neither.
Its warnings add `amount_too_low` (the order must be worth at least 0.1 USD),
`policy_price_deviation_exceeded` and `market_price_unavailable` (no fresh price for either asset)
to the codes of a swap preview, and the live request refuses with the same codes. Cancelling
needs a grant but no timelock, schedule or approval, and works while the agent is frozen or the
policy no longer allows `limit_order`; the USD budget charged when the order was placed is not
given back. Freezing the agent, or applying a policy without `limit_order`, makes the API cancel
its open orders. 1Click's own fee is in the order's `app_fees`. Deleting an agent is refused with
`limit_orders_open` while orders are not payout-final (the deletion preview reports
`open_limit_orders`).

## Native accounts

Besides its NEAR Intents balance, the agent has its own NEAR account and EVM and Solana addresses
(`wallet.near_account_id`, `wallet.evm_account_id`, `wallet.solana_account_id`). The policy's
optional `native` block switches each method on separately; omitted, every one is off:

```ts
policy: {
  ...current.policy,
  native: {
    near: { sign_message: ["app.example.near"], transfer: false, call: [] },
    evm: {
      // Typed data only under these EIP-712 domains, matched field for field.
      sign_typed_data: [{ name: "Exchange", version: "1", chain_id: 1337, verifying_contract: "0x0000000000000000000000000000000000000000" }],
      sign_message: false,
      sign_transaction: false,
    },
    solana: { sign_message: false, sign_transaction: false },
  },
},
```

```ts
const signed = await assistant.nativeEvmSignTypedData(agentId, {
  chain: "hyperevm",
  typed_data: { domain, types, primaryType: "Agent", message }, // types.EIP712Domain may be omitted
});
await assistant.nativeNearTransfer(agentId, { to: "bob.near", amount: "1000000000000000000000" });
```

Native methods skip `budget`, `timelock_ms`, `schedule` and `owner_approval`: a signed EVM or
Solana transaction, or typed data such as a permit, can move everything at that address. NEAR a
`nativeNearTransfer` sends, or a `nativeNearCall` attaches as its deposit, must land where
`destinations` allows (judged as a `withdraw` on chain `near`). NEAR transfers and calls take an
idempotency key like other actions; every native request is recorded in history as type `native`.
A NEAR transfer or call reads `SUCCESS` only once the chain finalizes the transaction the request
asked for; a failed one reads `FAILED` (`native_transaction_failed`). The signing methods return
the signature once; status and history show `signature: null`. The NEAR Intents contracts are
never a signing recipient or call target.

### NEAR Intents payloads from the EVM or Solana key

The EVM and Solana keys sign NEAR Intents payloads only through `nativeEvmSignIntent` and
`nativeSolanaSignIntent`, each fenced by its own `sign_intent` rules (`sign_message` never opens
them). The payload is canonical JSON text, `transfer` intents only, signed for the key's own
Intents account:

```ts
native: {
  evm: {
    sign_typed_data: [], sign_message: false, sign_transaction: false,
    sign_intent: {
      receivers: ["treasury.near"],      // accounts a transfer may pay
      one_click_deposits: true,          // 1Click deposits paying the key or a receiver back
      withdrawals: [{ chain: "base", address: "0x…" }], // 1Click deposits paying out here
      max_slippage_bps: 100,             // value lost at minAmountOut, fees included, 0–300 (default 100)
    },
  },
},
```

```ts
// One 1Click `POST /v0/quote` answer per deposit address the payload pays, sent unchanged.
const quote = await fetch("https://1click.chaindefuser.com/v0/quote", { … }).then((r) => r.json());
const { signed_data } = await assistant.nativeEvmSignIntent(agentId, {
  payload,
  one_click_quotes: [quote],
});
// Publish signed_data as is: intents.near (execute_intents), 1Click or a solver relay.
```

A transfer to a 1Click deposit address needs that deposit's live (`dry: false`) quote in
`one_click_quotes` (at most two). The API checks 1Click's signature on it offline against 1Click's
quote key, the same check as the 1Click SDK's `verifyQuoteSignature`, and never calls 1Click, so
public (`intents.near`) and confidential (`intents.far`) deposits work the same way. The quote must
refund the key, pay the key, a receiver or a listed withdrawal address, lose at most
`max_slippage_bps` of value at its `minAmountOut` by 1Click's signed USD amounts (fees included),
and be paid with exactly its `amountIn` (on `intents.far` as the `imt:` confidential token). A
deposit 1Click has since closed is not seen; a late payment refunds to the key. A payload paying
only such deposits may be due up to 96 hours ahead (1Click's own deadline); anything else within
300 seconds. `destinations`, `assets`, `limits` and `budget` do not apply to these rules. Freezing
the account refuses new payloads, but a payload signed before the freeze stays publishable until
its deadline. A refused payload never reaches the wallet provider; a retry is judged again.

`nativeSolanaSignIn` signs a Sign-In-With-Solana login for a domain in `native.solana.sign_in`;
`nativeSolanaSignTransfer` signs one SOL or SPL transfer to a `recipient` that `destinations`
allows, under `native.solana.sign_transfer`.

## Change the rules

A policy change is one owner signature over the complete new policy. Read it, edit it, keep the
revision:

```ts
const current = await api.getPolicy(agentId);
if (current.policy === null || current.revision === null) throw new Error("policy_not_ready");

const update = await api.generateIntent({
  type: "policy_update",
  agent_id: agentId,
  expected_revision: current.revision,
  policy: { ...current.policy, timelock_ms: 60_000 },
});
// Owner signs update.intent, backend submits, then follow update.correlation_id.
```

`timelock_ms`, `destinations`, `budget` and `schedule` are enforced by the API itself, so changing
only those needs no blockchain transaction. `schedule` is optional and limits money actions to
weekly windows in an IANA time zone; omit it to remove it:

```ts
policy: {
  ...current.policy,
  schedule: {
    mode: "only",
    time_zone: "Europe/Berlin",
    windows: [{ days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" }],
  },
},
```

Outside the schedule an action fails with `policy_schedule_denied`; `error.availableAt` says when
it can run.

If someone changed the policy meanwhile, submitting fails with `policy_revision_conflict`: read the
current policy again and ask for a fresh signature. Other owner actions use the same four steps:
`agent_freeze`, `agent_unfreeze`, `grant_revoke`, `execution_cancel`, `agent_archive`,
`agent_restore`, `agent_delete` and `approval_vote`.

## Statuses

`getStatus` returns the operation with a `status`:

| Status | Meaning | What to do |
|---|---|---|
| `PENDING_SIGNATURE` | Waiting for the owner's signature | Get it signed, then `submitIntent` |
| `PENDING_APPROVAL` | Waiting for the owner's approval vote | The owner votes (`approval_vote`) |
| `PENDING_DEPOSIT` | Waiting for incoming funds | Send the deposit |
| `QUEUED`, `PROCESSING` | In progress (queued runs after the policy's timelock) | Keep polling |
| `SUCCESS` | Done, backed by reconciled evidence | |
| `REFUNDED`, `FAILED` | Ended without the intended result | Read `failure_code` |
| `UNCERTAIN` | The outcome is unknown | Keep polling the **original** `correlation_id`; never resubmit under a new key |
| `NEEDS_REVIEW` | Stopped for inspection | Read `details.reason`; never retry. After it is resolved, `getStatus(id, { refresh: true })` |

A failed operation with `details.never_executed` or `details.never_submitted` set to `true` has its
USD and per-asset charges released once; only the provider's own flags count, never a failure
reason. A new attempt needs a new idempotency key.

`details.amount_out` is present only on `SUCCESS`, or on `REFUNDED` after a partial fill. Before
that, read `details.expected_amount_out`, the provider's estimate; never treat it as received.

## Verify an operation

`getOperationProof` returns an execution's audit trail with a transparency-log proof per event.
`verifyOperationProof` checks it offline, without trusting the API: each `PROVEN` event's opening
hashes to a leaf the checkpoint includes, the checkpoint carries the log's and the notary's
signatures, and the opening describes that event. A signed log alone cannot prove it was not rolled
back, so you also pass a **trusted checkpoint**: one you retained from an earlier verification, or
the head of the checkpoint witness, which `fetchWitnessCheckpoint` reads and verifies. Pin the log
origin and the witness key yourself; never take either from an API response.

```ts
import { fetchWitnessCheckpoint, verifyOperationProof } from "@near-intents-agent-api/sdk";

const origin = "api.agentsonintents.com/log";
// The witness public key (hex) pinned in the attested deployment. Keep it in your own config.
const witnessKey = "598165a18b588f504e159c0e2573d73983ae22bf15cf80d36902276d63a11101";

const trusted = await fetchWitnessCheckpoint("https://api.agentsonintents.com", origin, witnessKey);
const proof = await api.getOperationProof(agentId, correlationId, {
  from_size: String(trusted.size),
});
const verified = verifyOperationProof(proof, origin, trusted);
```

`fetchWitnessCheckpoint(api, origin, witnessKey)` sends a fresh nonce to `/tee/witness` over HTTPS
and checks the witness's signature, so a lying API cannot forge the head. Fetch it immediately
before requesting the proof. `from_size` makes the API include a consistency proof from that head;
a server behind it answers 409 `transparency_checkpoint_behind`. The verifier refuses a proof that
does not extend `trusted`, a smaller or forked tree, or a checkpoint that differs from the one the
event proofs use. `Checkpoint` is the type of `trusted` and of `verified.checkpoint`. To keep your
own state instead of asking the witness, persist `verified.checkpoint` and pass it next time, but
only after the attestation below passes. A retained checkpoint proves continuation from itself,
not that the log is current.

`verified.proven` lists each event's leaf index, audited fields, checkpoint and `evidence`: the
result it recorded, with its settlement transaction hashes, checked against the opening's
`evidenceHash`. `PENDING` events wait for the next checkpoint. A proof that does not hold, or
evidence altered after it was committed, throws `NoteError` or `ProofError`. The TDX quote is not
checked here: to tie the notary keys to attested code, verify the attestation in
`proof.notary.birth.attestation` with a quote verifier such as dstack-verifier and compare its
`report_data` with `verified.birthReportData`.

## Idempotency

Every write (`generateIntent`, `swap`, `placeLimitOrder`, `withdraw`, `transfer`, `shield`, `unshield`, `deposit`)
carries an `Idempotency-Key`. Omit it and the SDK generates one and returns it with the result as
`result.idempotencyKey`. A withdrawal preview (`withdraw` with `dry: true`) carries one too: it
needs the grant and a key, an identical preview under the same key replays its result for 60
seconds. The API sets no preview cap: each preview counts toward the wallet's 1,000 custody
operations per rolling 24 hours at the provider. A swap quote
(`swap` with `dry: true`) and a limit-order preview (`placeLimitOrder` with `dry: true`) need
neither. To survive a crash, create and store the key **before**
sending:

```ts
import { createIdempotencyKey } from "@near-intents-agent-api/sdk";

const idempotencyKey = createIdempotencyKey();
await saveRequest({ agentId, request, idempotencyKey }); // your durable storage
await assistant.transfer(agentId, request, { idempotencyKey });
```

To retry, send the same body with the same key; the original result comes back. The SDK never
retries by itself. A request with a new key is new work, so never use one to retry an `UNCERTAIN`
operation. `recover` requires the original key. Quotes, reads and `submitIntent` need no key.

## Errors

Failures throw `AgentApiError` with `status`, a stable snake_case `code` (branch on it, never on
`title`), `layer`, `retryable`, `availableAt`, `retryAfterSeconds`, `minAmount`, `availableAmount`, `requestId`, the `errors` list and the
transmitted `idempotencyKey`:

```ts
import { AgentApiError } from "@near-intents-agent-api/sdk";

try {
  await api.submitIntent(submission);
} catch (error) {
  if (error instanceof AgentApiError && error.code === "policy_revision_conflict") {
    // Read the current policy, then generate a fresh request and get a fresh signature.
  }
  throw error;
}
```

Transport, timeout, cancellation and parsing failures throw `AgentApiRequestError`, and a response
over the size budget throws `AgentApiResponseTooLargeError`. Both keep the original `idempotencyKey`
(and `cause`); a failed write may still have reached the API, so reconcile the original operation
before retrying. `retryable` means the identical call under the same `idempotencyKey` can succeed
after `availableAt` or `retryAfterSeconds` (the response's `Retry-After` header); server errors (`internal_error`, `database_busy`,
`transaction_unconfirmed`) are retryable because the call may have taken effect, so repeat them
under the same key, never a new one. A rejected partner API key is `invalid_api_key` (401, the key
is not valid or no longer live; its `detail` names the portal), `api_key_retired` (401, not
retryable: the key was created before the partner portal, so create a new one there) or, while the
portal cannot be reached for a key it has never answered for, `key_verification_unavailable`
(503, retryable). `retryable: false` says only that repeating will not help
now, never that nothing was sent, and an absent flag proves nothing (it reads `false`).
`route_unavailable` means no route for this pair or amount: repeating the same request will not
help, so try another amount or pair. `provider_refused` (400, not retryable) is the provider's
own refusal of the request, in its words in `detail`; nothing was sent, so change the request and
use a new key. Use a new key only after a refusal documented as sending nothing
(such as `wallet_busy`, whose key replays the refusal); after a server error, a lost response or
a recovery code, keep the original key and read the status. A `FAILED` or `REFUNDED` status is not
proof that nothing was sent (a partial failure is `FAILED`): check its details and balances before
deciding to send new work. An execution the
provider may have received returns `UNCERTAIN`; keep polling its `correlation_id`.
`minAmount` is set on `amount_too_low` when the provider states the route minimum: that minimum in
atomic units of the asset sent, so quote at least that. `custody_native_balance_required` states
the agent's NEAR shortfall the same way: `availableAmount` is what its NEAR account holds and
`minAmount` what the call costs, in yoctoNEAR; a replay or status read keeps them as
`details.available_amount` and `details.min_amount`. A withdrawal of a token to a NEAR account
with no storage on that token's contract (a fresh 1Click deposit address) is refused with
`invalid_address`, as is its preview: register the receiver's storage first or move the funds
inside NEAR Intents. A refusal recorded against an operation
keeps it as `details.min_amount` on the operation's status, so a replay under the same key states
it too.

## Options

| Option | Default | |
|---|---|---|
| `apiKey` | required | Your partner API key from the partner portal, as an opaque non-empty string. Backend only. |
| `baseUrl` | `https://api.agentsonintents.com` | HTTPS origin; HTTP allowed for `localhost` |
| `grantToken` | none | Prefer `api.forGrant(token)`, which returns a separate client per grant |
| `timeoutMs` | 150 s for swap, placeLimitOrder, withdraw, transfer, shield, unshield; 65 s otherwise | |
| `maxResponseBytes` | 8 MiB | Checked before JSON parsing, including errors |
| `fetch` | global `fetch` | For tests or instrumentation |

Every method also takes `{ signal }` to cancel it. Requests omit cookies and reject redirects.

## Methods

| Area | Methods |
|---|---|
| Owner actions | `generateIntent`, `submitIntent`, `getStatus`, `getHistory`, `getOperationProof` |
| Agents | `listAgents`, `getAgent`, `getWallet`, `getBalances`, `getAddress`, `getContainment`, `listProviderRecords` |
| Rules and access | `getPolicy`, `getPolicyHistory`, `listGrants`, `listApprovals`, `getApproval`, `listScheduledExecutions` |
| Agent actions (need a grant) | `swap`, `placeLimitOrder`, `withdraw`, `transfer`, `shield`, `unshield`, `cancelLimitOrder`, `cancelAllLimitOrders` |
| Limit order reads | `listLimitOrders`, `getLimitOrder` |
| Funding and recovery | `deposit`, `recover` |
| The agent's own keys outside NEAR Intents (each needs its switch in the policy's `native` block and a grant) | `nativeNearSignMessage`, `nativeNearTransfer`, `nativeNearCall`, `nativeEvmSignTypedData`, `nativeEvmSignMessage`, `nativeEvmSignIntent`, `nativeEvmSignTransaction`, `nativeSolanaSignIn`, `nativeSolanaSignMessage`, `nativeSolanaSignIntent`, `nativeSolanaSignTransfer`, `nativeSolanaSignTransaction` |
| Account and service | `whoami`, `getPartnerQuota`, `getNetwork`, `getTokens`, `listReleases`, `getLatestRelease`, `getRelease` |
| Helpers | `createGrantCredential`, `grantCommitment`, `createIdempotencyKey`, `forGrant`, `verifyOperationProof`, `fetchWitnessCheckpoint` |

`getPartnerQuota()` reports how many agents you may create and what you have used.
Every request, response and view type is exported (`Policy`, `AgentView`, `StatusResponse`,
`GenerateIntentRequest`, `OwnerWallet`, …).

## Without the SDK

The API is plain HTTP. `GET https://api.agentsonintents.com/openapi.json` has every schema and
`GET https://api.agentsonintents.com/llms.txt` is a compact guide for LLM callers. The types in this
package are generated from that OpenAPI document, so to validate responses at runtime or to build
a client in another language, generate it from the same document.

## Related

| Repository | |
|---|---|
| [api](https://github.com/NEAR-Intents-Agent-API/api) | The Agent API and partner portal |
| [examples](https://github.com/NEAR-Intents-Agent-API/examples) | Runnable scripts for every flow in this README |
| [skills](https://github.com/NEAR-Intents-Agent-API/skills) | Agent skills for building on the API in any language |
| [demo](https://github.com/NEAR-Intents-Agent-API/demo) · [agent-connect](https://github.com/NEAR-Intents-Agent-API/agent-connect) | Full applications built on this SDK |
