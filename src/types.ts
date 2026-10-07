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
  "swap" | "withdraw" | "transfer" | "shield" | "unshield" | "deposit"
>;
export type Status = StatusResponse["status"];
export type StatusResponseOf<T extends StatusType> = Extract<StatusResponse, { type: T }>;
export type ExecutionDetails = Schemas["ExecutionDetails"];
export type HistoryPage = Success<"getHistory">;
export type QuoteResponse = Extract<Success<"swap">, { dry: true }>;
export type SwapRequest = RequestBody<"swap">;
export type WithdrawRequest = RequestBody<"withdraw">;
export type TransferRequest = RequestBody<"transfer">;
export type BalanceMoveRequest = RequestBody<"shield">;
export type DepositRequest = RequestBody<"deposit">;
export type RecoverRequest = RequestBody<"recover">;
export type SignMessageRequest = RequestBody<"signMessage">;
export type Signature = Success<"signMessage">;
