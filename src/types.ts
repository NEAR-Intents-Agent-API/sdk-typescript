import type { components, operations } from "./generated/api.js";

// The wire types are generated from the server's OpenAPI document (src/generated/api.d.ts).
// This file only gives them stable public names, so a field renamed by the server breaks here
// at compile time instead of silently widening to `any`.

type Json<T> = T extends { content: { "application/json": infer Body } } ? Body : never;
type RequestBody<K extends keyof operations> = operations[K] extends { requestBody: infer R }
  ? Json<R>
  : never;
type Success<K extends keyof operations> = Json<
  operations[K]["responses"][Extract<keyof operations[K]["responses"], 200 | 201 | 202>]
>;
type Query<K extends keyof operations> = NonNullable<operations[K]["parameters"]["query"]>;
type Schemas = components["schemas"];

// ---- Errors
export type ErrorDocument = Schemas["ErrorDocument"];
export type ApiErrorObject = ErrorDocument["errors"][number];
/** Which layer refused: `request`, `auth`, `grant`, `policy`, `budget`, `balance`, `provider` or `api`. */
export type ApiErrorLayer = ApiErrorObject["layer"];

// ---- Account and wallet
export type OwnerWallet = Schemas["OwnerWallet"];
export type AgentView = Schemas["AgentView"];
export type AgentPage = Success<"listAgents">;
export type WalletView = Success<"getWallet">;
export type BalancesView = Success<"getBalances">;
export type BalanceEntry = BalancesView["balances"][number];
export type BalanceSource = NonNullable<Query<"getBalances">["source"]>;
export type TokenView = Success<"getTokens">["data"][number];
export type NetworkView = Success<"getNetwork">;
export type ReleaseListView = Success<"listReleases">;
export type ReleaseView = Success<"getRelease">;
export type WhoamiView = Success<"whoami">;
export type PartnerQuotaView = Success<"getPartnerQuota">;
export type ContainmentView = Success<"getContainment">;

// ---- Policy and grants
export type Policy = Schemas["Policy"];
export type PolicyAction = Policy["actions"][number];
/** Where withdrawals and transfers may go: a mode plus the exact destinations it lists. */
export type DestinationRule = Policy["destinations"];
export type Destination = DestinationRule["list"][number];
/** Weekly windows on the owner's clock when money actions may run (`only`) or are paused (`except`). */
export type Schedule = NonNullable<Policy["schedule"]>;
export type ScheduleWindow = Schedule["windows"][number];
export type ScheduleDay = ScheduleWindow["days"][number];
export type PolicyView = Schemas["PolicyView"];
export type PolicyHistoryView = Success<"getPolicyHistory">;
export type GrantView = Schemas["GrantView"];
export type BudgetView = Schemas["BudgetView"];
export type TimelockView = Schemas["TimelockView"];
/** How a grant's holder proves itself: a grant `token`, an `oidc` identity or a `public_key`. */
export type GrantCredentialType = GrantView["credential_type"];
export type ApprovalView = Success<"getApproval">;
export type ScheduledPage = Success<"listScheduledExecutions">;
export type ScheduledExecutionView = ScheduledPage["data"][number];

// ---- Owner intents
export type Intent = Schemas["Intent"];
export type SignedData = Schemas["SignedData"];
export type IntentPreview = Schemas["IntentPreview"];
export type DeletionPreview = Schemas["DeletionPreview"];
export type GenerateIntentRequest = RequestBody<"generateIntent">;
export type GenerateIntentResponse = Schemas["GenerateIntentResponse"];
export type IntentType = GenerateIntentResponse["type"];
export type SubmitIntentRequest = RequestBody<"submitIntent">;
type GrantIssueRequest = Extract<GenerateIntentRequest, { type: "grant_issue" }>;
/**
 * The `credential` of a `grant_issue` intent, which the owner signs: the SHA-256 hex of a grant
 * token, an `oidc` workload identity or a `public_key` workload key.
 */
export type GrantIssueCredential = GrantIssueRequest["credential"];
/** `{ type: "oidc", issuer, claims, audience?, jwks? }`: a workload identity the API verifies. */
export type OidcGrantCredential = Extract<GrantIssueCredential, { type: "oidc" }>;
/** `{ type: "public_key", jwk }`: an Ed25519 or P-256 workload key that never leaves the workload. */
export type PublicKeyGrantCredential = Extract<GrantIssueCredential, { type: "public_key" }>;
/** An Ed25519 or P-256 public JWK. Private members are refused by the API. */
export type GrantPublicKeyJwk = PublicKeyGrantCredential["jwk"];
/** An issuer public key the owner signs into an `oidc` grant (`jwks`). */
export type OidcSigningKey = NonNullable<OidcGrantCredential["jwks"]>["keys"][number];

/** Which signing standards a given owner action produces (the wallet must sign `intent.payload`). */
export type GenerateIntentResponseOf<T extends IntentType> = T extends IntentType
  ? Omit<GenerateIntentResponse, "type" | "intent"> & {
      type: T;
      intent: Extract<
        Intent,
        {
          standard:
            | "eip712"
            | "webauthn"
            | (T extends "policy_update"
                ? "nep413" | "nep366"
                : T extends "agent_create" | "agent_freeze" | "agent_unfreeze" | "agent_delete"
                  ? "nep366"
                  : "nep413");
        }
      >;
    }
  : never;

// ---- Workload identity
/** The RFC 8693 token exchange body of `POST /v1/agents/{agent_id}/grants/token`. */
export type GrantTokenExchangeRequest = RequestBody<"exchangeGrantToken">;
/** The `ngs_…` session token to send as `X-Grant-Token`, and when it ends. */
export type GrantTokenExchangeResponse = Success<"exchangeGrantToken">;
/** The JWT type of the subject token: `jwt` (default) or `id_token`. */
export type SubjectTokenType = GrantTokenExchangeRequest["subject_token_type"];

// ---- Executions
export type StatusResponse = Schemas["StatusResponse"];
export type StatusType = StatusResponse["type"];
/** The agent-run money moves; the other status types are owner intents. */
export type ExecutionType = Extract<
  StatusType,
  "swap" | "limit_order" | "withdraw" | "transfer" | "shield" | "unshield" | "deposit"
>;
export type Status = StatusResponse["status"];
export type StatusResponseOf<T extends StatusType> = Extract<StatusResponse, { type: T }>;
export type ExecutionDetails = Schemas["ExecutionDetails"];
export type HistoryPage = Success<"getHistory">;
/** What an `Idempotency-Key` admitted: retained `data` newest first, and the `retired` correlation ids. */
export type OperationLookup = Success<"lookupOperations">;
export type OperationProof = Success<"getOperationProof">;
export type AuditProof = OperationProof["events"][number];
/** A settled execution: a view of its terms in `details` and, once proven, its receipt. */
export type ReceiptItem = Success<"getReceipt">;
export type ReceiptPage = Success<"listReceipts">;
/** A dry swap, withdrawal or limit order: what it would do and every rule it would fail. */
export type QuoteResponse = Extract<Success<"swap">, { dry: true }>;
export type SwapRequest = RequestBody<"swap">;
export type LimitOrderRequest = RequestBody<"placeLimitOrder">;
export type WithdrawRequest = RequestBody<"withdraw">;
export type TransferRequest = RequestBody<"transfer">;
export type BalanceMoveRequest = RequestBody<"shield">;
export type DepositRequest = RequestBody<"deposit">;
export type RecoverRequest = RequestBody<"recover">;

// ---- Limit orders
/** An order as the custody provider reports it, in 1Click's own snake_case fields. */
export type LimitOrderView = Success<"getLimitOrder">;
export type LimitOrderPage = Success<"listLimitOrders">;
/** What the provider reports of a cancelled order; every field may be absent. */
export type CancelLimitOrderResult = Success<"cancelLimitOrder">;
/** One round of a batch cancel: call again until `complete` is true. */
export type CancelAllLimitOrdersResult = Success<"cancelAllLimitOrders">;

// ---- Native: the agent's own NEAR, EVM and Solana keys outside NEAR Intents
export type SignRequest = RequestBody<"nativeNearSignMessage">;
export type Signature = Success<"nativeNearSignMessage">;
export type NearTransferRequest = RequestBody<"nativeNearTransfer">;
export type NearCallRequest = RequestBody<"nativeNearCall">;
export type EvmSignTypedDataRequest = RequestBody<"nativeEvmSignTypedData">;
export type EvmSignMessageRequest = RequestBody<"nativeEvmSignMessage">;
export type EvmSignTransactionRequest = RequestBody<"nativeEvmSignTransaction">;
export type SolanaSignMessageRequest = RequestBody<"nativeSolanaSignMessage">;
export type SolanaSignTransactionRequest = RequestBody<"nativeSolanaSignTransaction">;
export type EvmSignIntentRequest = RequestBody<"nativeEvmSignIntent">;
export type SolanaSignIntentRequest = RequestBody<"nativeSolanaSignIntent">;
/** 1Click's signed `POST /v0/quote` answer, sent unchanged in `one_click_quotes`. */
export type OneClickQuote = NonNullable<EvmSignIntentRequest["one_click_quotes"]>[number];
/** A NEAR Intents payload signed by the agent's EVM or Solana key, with `signed_data` to publish. */
export type IntentSignature = Success<"nativeEvmSignIntent"> | Success<"nativeSolanaSignIntent">;
export type SolanaSignInRequest = RequestBody<"nativeSolanaSignIn">;
/** A Sign-In-With-Solana signature and `signed_message`, the exact text signed. */
export type SolanaSignIn = Success<"nativeSolanaSignIn">;
export type SolanaSignTransferRequest = RequestBody<"nativeSolanaSignTransfer">;
/** The `sign_intent` rules of `native.evm` or `native.solana`. */
export type SignIntentRules = NonNullable<
  NonNullable<NonNullable<Policy["native"]>["evm"]>["sign_intent"]
>;
/** An EVM or Solana signature and the address that made it. */
export type NativeSignature = Success<"nativeEvmSignTypedData">;
