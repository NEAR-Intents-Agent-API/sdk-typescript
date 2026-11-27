import { sha3_256 } from "@noble/hashes/sha3.js";
import { base64urlnopad } from "@scure/base";
import type { GenerateIntentResponse, OffchainMessage } from "./types.js";
import { walletRequestChallenge } from "./wallet-request.js";

function concat(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function u64(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
}

const string = (value: string) => {
  const encoded = new TextEncoder().encode(value);
  return concat(u32(encoded.length), encoded);
};

/** NEP-641 takes a UTC timestamp in whole seconds plus an optional nanosecond fraction. */
function timestampNanos(timestamp: string): bigint {
  const parts = /^(.*?)(?:\.(\d{1,9}))?Z$/.exec(timestamp);
  const milliseconds = parts ? Date.parse(`${parts[1]}Z`) : Number.NaN;
  if (!parts || !Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds % 1000 !== 0)
    throw new RangeError("offchain message timestamp is not a UTC timestamp");
  return BigInt(milliseconds) * 1_000_000n + BigInt((parts[2] ?? "").padEnd(9, "0") || "0");
}

/** Borsh `OffchainMessage` bytes, as the NEAR Intents wallet contract serializes them (NEP-641). */
export function serializeOffchainMessage(message: OffchainMessage): Uint8Array {
  const path = message.path ?? [];
  return concat(
    string(message.chain_id),
    string(message.signer_id),
    u32(path.length),
    ...path.map(string),
    u64(timestampNanos(message.timestamp)),
    string(message.payload),
  );
}

/**
 * The WebAuthn challenge a passkey signs for this NEP-641 message, base64url without padding.
 * Compare it with `intent.payload.challenge` before the owner signs a consent step.
 */
export function offchainMessageChallenge(message: OffchainMessage): string {
  return base64urlnopad.encode(
    sha3_256(
      concat(
        new TextEncoder().encode("NEAR_NEP641_OFFCHAIN_MESSAGE/V1"),
        serializeOffchainMessage(message),
      ),
    ),
  );
}

/**
 * Whether a passkey intent's WebAuthn challenge hashes the preimage its preview shows
 * (`offchain_message` or `wallet_request`). Check it before the owner signs: the passkey signs
 * only the 32-byte challenge, so the preview is the only readable form of what it commits to.
 * False for an intent that is not `webauthn` or carries no preimage.
 */
export function verifyPasskeyChallenge(generated: GenerateIntentResponse): boolean {
  if (generated.intent.standard !== "webauthn") return false;
  const { challenge } = generated.intent.payload;
  const { preview } = generated;
  if ("offchain_message" in preview)
    return offchainMessageChallenge(preview.offchain_message) === challenge;
  if ("wallet_request" in preview)
    return walletRequestChallenge(preview.wallet_request) === challenge;
  return false;
}
