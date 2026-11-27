import { sha3_256 } from "@noble/hashes/sha3.js";
import { base64, base64urlnopad } from "@scure/base";
import type { components } from "./generated/api.js";

/** The NEP-616 wallet request a passkey's WebAuthn challenge commits to. */
export type WalletRequestMessage = components["schemas"]["WalletRequestMessage"];

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
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff)
    throw new RangeError("wallet request integer out of range");
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function integer(value: bigint, size: 8 | 16): Uint8Array {
  if (value < 0n || value >= 1n << BigInt(size * 8))
    throw new RangeError("wallet request integer out of range");
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index++)
    bytes[index] = Number((value >> BigInt(8 * index)) & 255n);
  return bytes;
}

const bytes = (value: Uint8Array) => concat(u32(value.length), value);
const string = (value: string) => bytes(new TextEncoder().encode(value));

function timestampNanos(timestamp: string): bigint {
  const parts = /^(.*?)(?:\.(\d{1,9}))?Z$/.exec(timestamp);
  const milliseconds = parts ? Date.parse(`${parts[1]}Z`) : Number.NaN;
  if (!parts || !Number.isFinite(milliseconds) || milliseconds < 0)
    throw new RangeError("wallet request created_at is not a UTC timestamp");
  return BigInt(milliseconds) * 1_000_000n + BigInt((parts[2] ?? "").padEnd(9, "0") || "0");
}

type WalletAction = WalletRequestMessage["request"]["external"][number]["actions"][number];

function action(entry: WalletAction): Uint8Array {
  if (entry.action === "transfer")
    return concat(Uint8Array.of(3), integer(BigInt(entry.payload.amount), 16));
  const { payload } = entry;
  return concat(
    Uint8Array.of(2),
    string(payload.function_name),
    bytes(payload.args ? base64.decode(payload.args) : new Uint8Array()),
    integer(BigInt(payload.deposit ?? "0"), 16),
    integer(BigInt(payload.gas ?? "0"), 8),
    integer(BigInt(payload.gas_weight ?? "1"), 8),
  );
}

/** Borsh `RequestMessage` bytes, as the NEP-616 wallet contract serializes them. */
export function serializeWalletRequestMessage(message: WalletRequestMessage): Uint8Array {
  const promises = message.request.external.map((promise) =>
    concat(
      string(promise.receiver_id),
      promise.refund_to ? concat(Uint8Array.of(1), string(promise.refund_to)) : Uint8Array.of(0),
      u32(promise.actions.length),
      ...promise.actions.map(action),
    ),
  );
  return concat(
    Uint8Array.of(0),
    string(message.chain_id),
    string(message.signer_id),
    u32(message.nonce),
    integer(timestampNanos(message.created_at), 8),
    u32(message.timeout_secs),
    u32(0),
    u32(promises.length),
    ...promises,
  );
}

/** The WebAuthn challenge a passkey signs for this wallet request, base64url without padding. */
export function walletRequestChallenge(message: WalletRequestMessage): string {
  return base64urlnopad.encode(
    sha3_256(
      concat(
        new TextEncoder().encode("NEAR_WALLET_CONTRACT/V1"),
        serializeWalletRequestMessage(message),
      ),
    ),
  );
}
