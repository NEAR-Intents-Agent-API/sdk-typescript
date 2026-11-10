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
                : T extends "agent_create" | "agent_freeze" | "agent_unfreeze"
                  ? "nep366"
                  : "nep413");
        }
      >;
    }
  : never;

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
export type OperationProof = Success<"getOperationProof">;
export type AuditProof = OperationProof["events"][number];
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
