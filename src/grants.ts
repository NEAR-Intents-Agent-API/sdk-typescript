import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { base64urlnopad } from "@scure/base";

/** Shape of a grant token: `ngt_` plus 32 random bytes in unpadded base64url. */
export const grantTokenPattern = /^ngt_[A-Za-z0-9_-]{43}$/;

/** A new grant token and the commitment the owner signs for it. */
export type GrantCredential = {
  /** `ngt_…`. Store it on your backend (encrypted); it is shown nowhere else. */
  token: string;
  /** SHA-256 hex of the token: the `credential` of a `grant_issue` intent. */
  commitment: string;
};

/** The commitment of an existing grant token. */
export function grantCommitment(token: string): string {
  return bytesToHex(sha256(utf8ToBytes(token)));
}

/**
 * Creates the token for one new grant. Send only `commitment` in `grant_issue`; the owner signs
 * it, and afterwards `api.forGrant(token)` runs calls under that grant. Use a new token for every
 * grant.
 */
export function createGrantCredential(): GrantCredential {
  const token = `ngt_${base64urlnopad.encode(crypto.getRandomValues(new Uint8Array(32)))}`;
  return { token, commitment: grantCommitment(token) };
}
