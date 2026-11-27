import assert from "node:assert/strict";
import { test } from "node:test";
import { base64urlnopad } from "@scure/base";
import {
  type GenerateIntentResponse,
  type OffchainMessage,
  offchainMessageChallenge,
  verifyPasskeyChallenge,
} from "../src/index.js";

const hex = (challenge: string) => Buffer.from(base64urlnopad.decode(challenge)).toString("hex");

// near/intents Rust OffchainMessage vectors (wallet revision 32a7836f), as the API pins them.
test("the NEP-641 challenge matches the wallet contract's hash", () => {
  assert.equal(
    hex(
      offchainMessageChallenge({
        chain_id: "mainnet",
        signer_id: "0s0000000000000000000000000000000000000000",
        timestamp: "1970-01-01T00:00:00Z",
        payload: "",
      }),
    ),
    "36a2583abee5b5d6df35ad2e458da18227a5b60c8150b48a34c022ba5e484c27",
  );
  assert.equal(
    hex(
      offchainMessageChallenge({
        chain_id: "mainnet",
        signer_id: "extension.near",
        path: ["wallet.near"],
        timestamp: "2026-08-05T07:28:00.123456789Z",
        payload: "Hello, Near!",
      }),
    ),
    "ac9fc5df2a1da51c4e0446185c8e5b58b65f37d12c544d144fa8f026239962ae",
  );
});

test("a timestamp that is not whole UTC seconds plus a fraction is refused", () => {
  const message: OffchainMessage = {
    chain_id: "mainnet",
    signer_id: "extension.near",
    timestamp: "2026-08-05T07:28:00+01:00",
    payload: "",
  };
  assert.throws(() => offchainMessageChallenge(message), RangeError);
});

test("a passkey consent intent verifies only when its challenge hashes the previewed message", () => {
  const offchain_message: OffchainMessage = {
    chain_id: "mainnet",
    signer_id: "0s0000000000000000000000000000000000000000",
    timestamp: "2026-11-27T10:00:00Z",
    payload: '{"action":"authorize_payout"}',
  };
  const generated = {
    correlation_id: "intent_1",
    type: "payout_authorize",
    agent_id: "a".repeat(64),
    status: "PENDING_SIGNATURE",
    expires_at: "2026-11-27T10:05:00Z",
    signer: { type: "near", account_id: "owner.near", public_key: "ed25519:x" },
    intent: {
      standard: "webauthn",
      payload: {
        challenge: offchainMessageChallenge(offchain_message),
        rpId: "example.com",
        allowCredentials: [],
        userVerification: "required",
        timeout: 60_000,
      },
    },
    preview: { summary: "Pay once.", offchain_message },
  } satisfies GenerateIntentResponse;
  assert.equal(verifyPasskeyChallenge(generated), true);
  const changed = structuredClone(generated);
  changed.preview.offchain_message.payload = '{"action":"other"}';
  assert.equal(verifyPasskeyChallenge(changed), false);
});
