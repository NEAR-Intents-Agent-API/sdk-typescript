import { test } from "node:test";
import type { GenerateIntentResponseOf, IntentType } from "../src/index.js";

// Type-level checks: `pnpm typecheck` fails if a mapping drifts from what the API generates.
type StandardOf<T extends IntentType> = GenerateIntentResponseOf<T>["intent"]["standard"];
type Equal<A, B> =
  (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false;
type Wallet = "eip712" | "webauthn";

const delegate: [
  Equal<StandardOf<"agent_create">, Wallet | "nep366">,
  Equal<StandardOf<"agent_freeze">, Wallet | "nep366">,
  Equal<StandardOf<"agent_unfreeze">, Wallet | "nep366">,
  Equal<StandardOf<"agent_delete">, Wallet | "nep366">,
] = [true, true, true, true];
const consent: [
  Equal<StandardOf<"grant_issue">, Wallet | "nep413">,
  Equal<StandardOf<"approval_vote">, Wallet | "nep413">,
] = [true, true];
const either: Equal<StandardOf<"policy_update">, Wallet | "nep413" | "nep366"> = true;

test("a NEAR owner signs each owner action in the standard the API generates", () => {
  void delegate;
  void consent;
  void either;
});
