# `@near-intents-agent-api/sdk`

TypeScript client for the **NEAR Intents Agent API**: give an AI agent its own custody account on
NEAR Intents, let its owner sign the spending rules once, and let the agent swap, transfer and
withdraw inside those rules.

- One method per endpoint, plain TypeScript types for every request and response.
- Runs on your **backend**. It holds your API key, so it never belongs in a browser.
- No wallet signers, no React hooks, no automatic retries. Types only, no runtime schemas.

```sh
npm install @near-intents-agent-api/sdk
```

Requires Node 24+. MIT licensed.

## How it fits together

| Who | Proves itself with | Does what |
|---|---|---|
| **Your backend** | API key (`naa_…`) | Creates agents, reads state, prepares owner actions |
| **The owner** (NEAR account, EVM wallet or passkey) | A wallet signature, once per change | Creates the agent, sets its rules (the *policy*), issues grants, freezes, deletes |
| **The agent** (an assistant, bot or session) | A grant token (`ngt_…`) | Swaps, transfers and withdraws inside the owner's policy |

The owner signs; your backend never holds the owner's keys. A grant says only *who* may act, and
the policy says *what* any grant may do, where funds may go and how much.

## Setup

Create an API key in the partner dashboard and keep it out of git:

```sh
# .env
AGENT_API_KEY=naa_...
```

```ts
import { createAgentApi } from "@near-intents-agent-api/sdk";

const api = createAgentApi({ apiKey: process.env.AGENT_API_KEY! });
```

Run it with `node --env-file=.env your-script.js`. The client talks to
`https://api.agentsonintents.com` by default. Pass `baseUrl` only for a self-hosted or local
deployment (HTTPS, or HTTP for `localhost`):

```ts
const local = createAgentApi({ apiKey: process.env.AGENT_API_KEY!, baseUrl: "http://localhost:3000" });
```

Check the connection:

```ts
const network = await api.getNetwork(); // public: service and provider status
const me = await api.whoami(); // validates the API key; never returns the key
const tokens = await api.getTokens(); // public: every asset an agent can use
```

## Create an agent

Creating an agent is an **owner action**: your backend prepares it, the owner's wallet signs it,
your backend submits it. Every owner action follows the same four steps.

```ts
import type { Policy } from "@near-intents-agent-api/sdk";

// 1. The rulebook. It is always sent complete, and the owner signs all of it at once.
const policy: Policy = {
  frozen: false,
  actions: ["swap", "transfer"], // any of "swap" | "transfer" | "withdraw"
  confidential: false, // true also allows private balances and confidential routes
  owner_approval: false, // true makes every outgoing action wait for the owner's vote
  assets: "any", // or the exact asset ids the agent may touch
  limits: {
    // optional per-asset caps in atomic units: per_transaction, hourly, daily, monthly
    per_transaction: { "nep141:wrap.near": "1000000000000000000000000" },
  },
  max_actions_per_hour: null,
  destinations: { mode: "only", list: [] }, // no destinations: funds stay in the account
  budget: { daily_usd: "100", weekly_usd: null, monthly_usd: null }, // USD caps across assets
  timelock_ms: 0, // delay before every delegated action runs
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
  amount: "2000000", // atomic units: 2 USDT with 6 decimals
  confidential: false,
});
// Send externally to deposit.details.deposit_address, then poll getStatus(deposit.correlation_id).

const balances = await api.getBalances(agentId);
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
await assistant.withdraw(agentId, { asset: "nep141:wrap.near", amount: "1", chain: "near", recipient: "bob.near" });
```

If the policy refuses, the call fails with a stable `code` such as `policy_action_denied`,
`policy_destination_denied`, `spend_budget_exceeded` or `insufficient_balance`; the error says which
layer refused.

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
USD budget charge released once; a new attempt needs a new idempotency key.

## Idempotency

Every write (`generateIntent`, `swap`, `withdraw`, `transfer`, `shield`, `unshield`, `deposit`)
carries an `Idempotency-Key`. Omit it and the SDK generates one and returns it with the result as
`result.idempotencyKey`. To survive a crash, create and store the key **before** sending:

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
`title`), `retryable`, `availableAt`, `requestId`, the `errors` list and the transmitted
`idempotencyKey`:

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
before retrying. Rate limits (`429`) expose `retryable` and `availableAt`.

## Options

| Option | Default | |
|---|---|---|
| `apiKey` | required | Your `naa_…` key. Backend only. |
| `baseUrl` | `https://api.agentsonintents.com` | HTTPS origin; HTTP allowed for `localhost` |
| `grantToken` | none | Prefer `api.forGrant(token)`, which returns a separate client per grant |
| `timeoutMs` | 150 s for swap, withdraw, transfer, shield, unshield; 65 s otherwise | |
| `maxResponseBytes` | 8 MiB | Checked before JSON parsing, including errors |
| `fetch` | global `fetch` | For tests or instrumentation |

Every method also takes `{ signal }` to cancel it. Requests omit cookies and reject redirects.

## Methods

| Area | Methods |
|---|---|
| Owner actions | `generateIntent`, `submitIntent`, `getStatus`, `getHistory`, `getOperationProof` |
| Agents | `listAgents`, `getAgent`, `getWallet`, `getBalances`, `getAddress`, `getContainment` |
| Rules and access | `getPolicy`, `getPolicyHistory`, `listGrants`, `listApprovals`, `getApproval`, `listScheduledExecutions` |
| Agent actions (need a grant) | `swap`, `withdraw`, `transfer`, `shield`, `unshield` |
| Funding and recovery | `deposit`, `recover` |
| Account and service | `whoami`, `getPartnerQuota`, `getNetwork`, `getTokens` |
| Helpers | `createGrantCredential`, `grantCommitment`, `createIdempotencyKey`, `forGrant` |

`getPartnerQuota()` reports how many agents and API keys you may create and what you have used.
Every request, response and view type is exported (`Policy`, `AgentView`, `StatusResponse`,
`GenerateIntentRequest`, `OwnerWallet`, …).

## Without the SDK

The API is plain HTTP. `GET https://api.agentsonintents.com/openapi.json` has every schema and
`GET https://api.agentsonintents.com/llms.txt` is a compact guide for LLM callers. The types in this
package are generated from that OpenAPI document, so to validate responses at runtime or to build
a client in another language, generate it from the same document.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). `src/generated/` is generated from the API's OpenAPI
document and is not edited by hand. Security reports: [SECURITY.md](SECURITY.md).
