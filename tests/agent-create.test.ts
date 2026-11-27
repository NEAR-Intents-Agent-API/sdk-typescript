import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  AgentCreateVerificationError,
  agentCreateCommitment,
  type CreateGrantTerms,
  type GenerateIntentResponse,
  verifyAgentCreateIntent,
} from "../src/index.js";

// Both fixtures are written by the API repo (tests/fixtures/agent-create): copy, never hand-edit.
const read = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/agent-create/${name}`, import.meta.url), "utf8"));
const vector = read("commitment.json");
const fixture = read("generated.json") as {
  tenantId: string;
  cases: Array<{ request: { grant: CreateGrantTerms }; generated: GenerateIntentResponse }>;
  without: GenerateIntentResponse;
};

const rejected = (fn: () => unknown, pattern: RegExp) =>
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof AgentCreateVerificationError);
    assert.match(error.message, pattern);
    return true;
  });
const copy = <T>(value: T): T => structuredClone(value);
function must<T>(value: T | undefined): T {
  assert.ok(value);
  return value;
}

test("the commitment matches the API's golden vector, with and without a grant", () => {
  const { tenantId, agentId, policy, grant } = vector;
  assert.equal(
    agentCreateCommitment({ tenantId, agentId, policy }),
    vector.commitment_without_grant,
  );
  assert.equal(agentCreateCommitment({ tenantId, agentId, policy, grant }), vector.commitment);
});

test("a generated agent_create verifies for every owner type, passkeys included", () => {
  const standards = fixture.cases.map(({ request, generated }) => {
    const { commitment, grant } = verifyAgentCreateIntent(generated, { grant: request.grant });
    assert.equal(grant?.grant_id, generated.preview.grant?.grant_id);
    assert.match(commitment, /^[0-9a-f]{64}$/);
    // The API signs the trimmed label, so a padded request still verifies.
    const padded = { ...must(request.grant), label: ` ${must(request.grant).label} ` };
    verifyAgentCreateIntent(generated, { grant: padded });
    return generated.intent.standard;
  });
  assert.deepEqual(standards, ["nep366", "eip712", "webauthn"]);
});

test("an agent_create without a grant verifies against the tenant you pass", () => {
  const { commitment, grant } = verifyAgentCreateIntent(fixture.without, {
    tenantId: fixture.tenantId,
  });
  assert.equal(grant, undefined);
  assert.match(commitment, /^[0-9a-f]{64}$/);
  rejected(() => verifyAgentCreateIntent(fixture.without), /pass tenantId/);
  rejected(
    () => verifyAgentCreateIntent(fixture.without, { tenantId: "other" }),
    /does not commit/,
  );
});

test("a preview that differs from what is signed or asked is refused", () => {
  for (const { request, generated } of fixture.cases) {
    const asked = { grant: request.grant };
    const policy = copy(generated);
    policy.preview.policy = { ...must(policy.preview.policy), actions: ["swap"] };
    rejected(() => verifyAgentCreateIntent(policy, asked), /does not commit/);

    const label = copy(generated);
    must(label.preview.grant).owner_message.label = "other";
    rejected(() => verifyAgentCreateIntent(label, asked), /label differs/);

    const id = copy(generated);
    must(id.preview.grant).grant_id = "f".repeat(64);
    rejected(() => verifyAgentCreateIntent(id, asked), /nonce or id/);

    rejected(
      () => verifyAgentCreateIntent(generated, { grant: { ...request.grant, label: "x" } }),
      /label differs/,
    );
    rejected(() => verifyAgentCreateIntent(generated), /did not ask for/);
  }
});

test("a passkey challenge must hash the previewed wallet request", () => {
  const passkey = fixture.cases.find(({ generated }) => generated.intent.standard === "webauthn");
  assert.ok(passkey);
  const asked = { grant: passkey.request.grant };
  const changed = copy(passkey.generated);
  assert.ok("wallet_request" in changed.preview);
  must(changed.preview.wallet_request).nonce += 1;
  rejected(() => verifyAgentCreateIntent(changed, asked), /challenge does not hash/);
  const missing = copy(passkey.generated);
  Reflect.deleteProperty(missing.preview, "wallet_request");
  rejected(() => verifyAgentCreateIntent(missing, asked), /must carry its wallet_request/);
});
