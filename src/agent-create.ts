import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { base64 } from "@scure/base";
import type { GenerateIntentRequest, GenerateIntentResponse, Policy } from "./types.js";
import { walletRequestChallenge } from "./wallet-request.js";

/** The first grant a generated `agent_create` carries: its id and the full signed message. */
export type CreateGrant = NonNullable<GenerateIntentResponse["preview"]["grant"]>;
type AgentGrantMessage = CreateGrant["owner_message"];
/** What `agent_create` accepts as `grant`: the same terms as `grant_issue`. */
export type CreateGrantTerms = NonNullable<
  Extract<GenerateIntentRequest, { type: "agent_create" }>["grant"]
>;

const policyDomain = "near-intents-agent-api.policy.v1";
const agentCreateDomain = "near-intents-agent-api.agent-create.v1";
const createGrantNonceDomain = "near-intents-agent-api.agent-create-grant.v1";

/** The generated `agent_create` does not commit to what it shows, or not to what was asked. */
export class AgentCreateVerificationError extends Error {
  override name = "AgentCreateVerificationError";
}

function fail(message: string): never {
  throw new AgentCreateVerificationError(message);
}

/** Sorted-key JSON, the API's canonical form: the commitment hashes exactly these bytes. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  const result = JSON.stringify(value);
  if (result === undefined) fail("the preview holds a value that is not JSON");
  return result;
}

const sha256Hex = (value: unknown) => bytesToHex(sha256(utf8ToBytes(canonical(value))));

/**
 * The `agent_policy_hash` the owner's wallet signs for revision 1 of a new agent. A grant wraps
 * the plain policy commitment: sha256(canonical({domain, policy_commitment, grant})).
 */
export function agentCreateCommitment(input: {
  tenantId: string;
  agentId: string;
  policy: Policy;
  grant?: AgentGrantMessage;
}): string {
  const policyCommitment = sha256Hex({
    domain: policyDomain,
    tenantId: input.tenantId,
    agentId: input.agentId,
    revision: 1,
    policy: input.policy,
  });
  return input.grant
    ? sha256Hex({
        domain: agentCreateDomain,
        policy_commitment: policyCommitment,
        grant: input.grant,
      })
    : policyCommitment;
}

/** A new agent's first grant has a nonce, and so an id, fixed by the tenant and agent alone. */
function createGrantId(tenantId: string, agentId: string) {
  const nonce = sha256Hex({ domain: createGrantNonceDomain, tenantId, agentId });
  return { nonce, grantId: sha256Hex({ tenant: tenantId, agent: agentId, nonce }) };
}

function decodeArgs(encoded: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(base64.decode(encoded)));
  } catch {
    return fail("the signed call's arguments are not base64 JSON");
  }
}

function storeWalletPolicyHash(call: { args?: unknown } | undefined): string {
  if (!call) fail("the signed request has no store_wallet_policy call");
  const hash = (call.args as { agent_policy_hash?: unknown } | undefined)?.agent_policy_hash;
  if (typeof hash !== "string") fail("the store_wallet_policy call carries no agent_policy_hash");
  return hash;
}

function eip712Call(out: unknown) {
  let parsed: { then?: Array<{ actions?: Array<Record<string, unknown>> }> };
  try {
    parsed = JSON.parse(typeof out === "string" ? out : "");
  } catch {
    return fail("the typed data's `out` is not JSON");
  }
  const action = parsed.then
    ?.flatMap((promise) => promise.actions ?? [])
    .find((candidate) => candidate.function_name === "store_wallet_policy");
  return action && { args: typeof action.args === "string" ? decodeArgs(action.args) : undefined };
}

/** A passkey signs a challenge: the request it hashes must be the one the preview shows. */
function webauthnCall(generated: GenerateIntentResponse, challenge: string) {
  const request = generated.preview.wallet_request;
  if (!request) fail("a passkey agent_create preview must carry its wallet_request");
  if (walletRequestChallenge(request) !== challenge)
    fail("the WebAuthn challenge does not hash the previewed wallet_request");
  const action = request.request.external
    .flatMap((promise) => promise.actions)
    .find(
      (candidate) =>
        candidate.action === "function_call" &&
        candidate.payload.function_name === "store_wallet_policy",
    );
  return action?.action === "function_call"
    ? { args: action.payload.args ? decodeArgs(action.payload.args) : undefined }
    : undefined;
}

/** Reads `agent_policy_hash` from the one `store_wallet_policy` call the owner will sign. */
function signedCommitment(generated: GenerateIntentResponse): string {
  const { intent } = generated;
  if (intent.standard === "nep366")
    return storeWalletPolicyHash(
      intent.payload.actions.find((action) => action.params.methodName === "store_wallet_policy")
        ?.params,
    );
  if (intent.standard === "eip712")
    return storeWalletPolicyHash(eip712Call(intent.payload.message.out));
  if (intent.standard === "webauthn")
    return storeWalletPolicyHash(webauthnCall(generated, intent.payload.challenge));
  return fail(`agent_create is never signed with ${intent.standard}`);
}

function sameCredential(
  signed: AgentGrantMessage["credential"],
  asked: CreateGrantTerms["credential"],
) {
  if (typeof asked === "string" || asked.type === "public_key")
    return canonical(signed) === canonical(asked);
  if (typeof signed === "string" || signed.type !== "oidc") return false;
  // The API fills in an OIDC audience the request may leave out; the rest must match exactly.
  return (
    signed.issuer === asked.issuer &&
    canonical(signed.claims) === canonical(asked.claims) &&
    canonical(signed.jwks ?? null) === canonical(asked.jwks ?? null) &&
    (asked.audience === undefined || signed.audience === asked.audience)
  );
}

/** The grant the preview shows must be the one asked for, for this agent and its signer. */
function assertGrantAsked(
  generated: GenerateIntentResponse,
  grant: CreateGrant,
  asked: CreateGrantTerms,
  tenantId: string | undefined,
) {
  const message = grant.owner_message;
  if (message.agent_id !== generated.agent_id) fail("the grant names another agent");
  const expected = createGrantId(message.tenant_id, message.agent_id);
  if (message.nonce !== expected.nonce || grant.grant_id !== expected.grantId)
    fail("the grant's nonce or id is not the one a new agent's first grant has");
  if (canonical(message.owner) !== canonical(generated.signer))
    fail("the grant names another owner than the signer");
  if (message.owner_epoch !== 1) fail("a new agent's first grant is at owner epoch 1");
  // The API trims a label before the owner signs it.
  if (message.label !== asked.label.trim()) fail("the grant label differs from the one asked for");
  if (message.expires_at_ms !== Date.parse(asked.expires_at))
    fail("the grant expiry differs from the one asked for");
  if (!sameCredential(message.credential, asked.credential))
    fail("the grant credential differs from the one asked for");
  if (tenantId !== undefined && message.tenant_id !== tenantId)
    fail("the grant names another tenant");
}

/**
 * Checks, before the owner signs, that a generated `agent_create` commits to exactly the policy
 * and first grant its preview shows, and that the grant is the one you asked for. Wallets show the
 * owner only a hash; this recomputes it for NEAR, EVM and passkey owners (a passkey's challenge is
 * recomputed from `preview.wallet_request`). Throws `AgentCreateVerificationError`.
 *
 * Without a grant the preview names no tenant, so pass `tenantId` (your partner tenant id).
 */
export function verifyAgentCreateIntent(
  generated: GenerateIntentResponse,
  expected: { grant?: CreateGrantTerms; tenantId?: string } = {},
): { commitment: string; grant: CreateGrant | undefined } {
  if (generated.type !== "agent_create") fail(`expected agent_create, got ${generated.type}`);
  const { preview } = generated;
  if (preview.revision !== 1 || !preview.policy) fail("the preview is not a first policy revision");
  const grant = preview.grant;
  if (grant && expected.grant)
    assertGrantAsked(generated, grant, expected.grant, expected.tenantId);
  else if (grant || expected.grant)
    fail(
      grant ? "the preview carries a grant you did not ask for" : "the preview carries no grant",
    );
  const message = grant?.owner_message;
  const tenantId = message?.tenant_id ?? expected.tenantId;
  if (tenantId === undefined) fail("pass tenantId to check an agent_create without a grant");
  const commitment = agentCreateCommitment({
    tenantId,
    agentId: generated.agent_id,
    policy: preview.policy,
    ...(message ? { grant: message } : {}),
  });
  if (signedCommitment(generated) !== commitment)
    fail("the signed agent_policy_hash does not commit to the previewed policy and grant");
  return { commitment, grant };
}
