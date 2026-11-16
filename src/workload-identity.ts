import { ed25519 } from "@noble/curves/ed25519.js";
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { base64urlnopad } from "@scure/base";
import type { GrantPublicKeyJwk } from "./types.js";

// Workload identity for grants: a key the workload keeps signs short-lived JWTs, either an
// assertion for `exchangeGrantToken` or a proof for one request (`X-Grant-Proof`). Keys and
// claims follow docs/workload-identity.md of the API; this file holds no network code.

/** A JWK with the private member `d`, for an Ed25519 or P-256 workload key. */
export type WorkloadPrivateJwk = GrantPublicKeyJwk & { d: string };

/**
 * Signs for a workload key. The key may live anywhere (a file, a TPM, an HSM, a cloud KMS): the
 * SDK never needs it, only its public half and a signature.
 */
export type WorkloadSigner = {
  /** The public key. Its RFC 9278 thumbprint URI is the `iss` and `sub` of everything it signs. */
  publicJwk: GrantPublicKeyJwk;
  /**
   * Signs the JWS signing input (`base64url(header).base64url(claims)`, as UTF-8 bytes) and
   * returns the raw JWS signature: 64 bytes. Ed25519 signs the bytes themselves; P-256 signs
   * ECDSA over their SHA-256 as `r || s` (RFC 7518, 3.4), not ASN.1 DER, which is what a KMS
   * returns and must be converted.
   */
  sign: (signingInput: Uint8Array) => Uint8Array | Promise<Uint8Array>;
};

/** A new workload key as JWKs. Keep `privateJwk` on the workload; the owner signs `publicJwk`. */
export type WorkloadKey = {
  privateJwk: WorkloadPrivateJwk;
  publicJwk: GrantPublicKeyJwk;
};

/** What a grant proof signs about one request. */
export type GrantProofRequest = {
  /** The `grant_id` of the live `public_key` grant, as returned when it was issued. */
  grantId: string;
  /** The request method; sent uppercase. */
  method: string;
  /** The request URL. Its query and fragment are not signed. */
  url: string | URL;
  /** The exact body bytes sent. A string is signed as its UTF-8 bytes. Omit for no body. */
  body?: string | Uint8Array;
  /** The `Idempotency-Key` header exactly as sent. Omit when the request sends none. */
  idempotencyKey?: string;
};

const thumbprintUriPrefix = "urn:ietf:params:oauth:jwk-thumbprint:sha-256:";
/** The API accepts at most five minutes; one minute leaves room for a slow signer. */
const lifetimeSeconds = 60;

const b64 = (bytes: Uint8Array) => base64urlnopad.encode(bytes);
const fromB64 = (value: string) => base64urlnopad.decode(value);

/** The hosted API publishes its own origin, which is the one the audiences below are built on. */
function originOf(baseUrl: string) {
  return new URL(baseUrl).origin;
}

/** Generates an Ed25519 or P-256 workload key. */
export function createWorkloadKey(alg: "Ed25519" | "P-256"): WorkloadKey {
  if (alg === "Ed25519") {
    const secret = ed25519.utils.randomSecretKey();
    const x = b64(ed25519.getPublicKey(secret));
    const publicJwk = { kty: "OKP", crv: "Ed25519", x } as const;
    return { privateJwk: { ...publicJwk, d: b64(secret) }, publicJwk };
  }
  if (alg !== "P-256") throw new RangeError("alg must be Ed25519 or P-256");
  const secret = p256.utils.randomSecretKey();
  const point = p256.getPublicKey(secret, false);
  const publicJwk = {
    kty: "EC",
    crv: "P-256",
    x: b64(point.subarray(1, 33)),
    y: b64(point.subarray(33)),
  } as const;
  return { privateJwk: { ...publicJwk, d: b64(secret) }, publicJwk };
}

/**
 * The RFC 9278 thumbprint URI of a workload key: the `iss` and `sub` of its assertions and
 * proofs. It is the RFC 7638 SHA-256 thumbprint over the required members only, so private
 * members never change it.
 */
export function jwkThumbprintUri(jwk: GrantPublicKeyJwk): string {
  // RFC 7638: required members only, in lexicographic order, no whitespace.
  const canonical =
    jwk.kty === "OKP"
      ? `{"crv":"${jwk.crv}","kty":"OKP","x":"${jwk.x}"}`
      : `{"crv":"${jwk.crv}","kty":"EC","x":"${jwk.x}","y":"${jwk.y}"}`;
  return `${thumbprintUriPrefix}${b64(sha256(utf8ToBytes(canonical)))}`;
}

/** A signer for a key held in this process, from its private JWK (Ed25519 or P-256). */
export function localJwkSigner(privateJwk: WorkloadPrivateJwk): WorkloadSigner {
  const secret = fromB64(privateJwk.d);
  if (secret.length !== 32) throw new RangeError("privateJwk.d must be a 32-byte key");
  if (privateJwk.kty === "OKP") {
    if (b64(ed25519.getPublicKey(secret)) !== privateJwk.x)
      throw new RangeError("privateJwk.x is not the public key of privateJwk.d");
    return {
      publicJwk: { kty: "OKP", crv: "Ed25519", x: privateJwk.x },
      sign: (input) => ed25519.sign(input, secret),
    };
  }
  const point = p256.getPublicKey(secret, false);
  if (b64(point.subarray(1, 33)) !== privateJwk.x || b64(point.subarray(33)) !== privateJwk.y)
    throw new RangeError("privateJwk.x and y are not the public key of privateJwk.d");
  return {
    publicJwk: { kty: "EC", crv: "P-256", x: privateJwk.x, y: privateJwk.y },
    // Compact format is r || s, which a JWS carries.
    sign: (input) => p256.sign(input, secret),
  };
}

async function signJwt(signer: WorkloadSigner, claims: Record<string, unknown>): Promise<string> {
  const alg = signer.publicJwk.kty === "OKP" ? "EdDSA" : "ES256";
  const text = (value: object) => b64(utf8ToBytes(JSON.stringify(value)));
  const signingInput = `${text({ alg })}.${text(claims)}`;
  const signature = await signer.sign(utf8ToBytes(signingInput));
  // A KMS returns ASN.1 DER for ECDSA; sending it would only read `grant_proof_invalid`.
  if (signature.length !== 64)
    throw new RangeError(
      "signer.sign must return the 64-byte JWS signature (for P-256, r || s rather than DER)",
    );
  return `${signingInput}.${b64(signature)}`;
}

/** The claims every workload JWT carries: the key as issuer and subject, a fresh `jti`. */
function baseClaims(signer: WorkloadSigner, audience: string) {
  const iss = jwkThumbprintUri(signer.publicJwk);
  const iat = Math.floor(Date.now() / 1000);
  return {
    iss,
    sub: iss,
    aud: audience,
    iat,
    exp: iat + lifetimeSeconds,
    jti: crypto.randomUUID(),
  };
}

/**
 * The audience an `oidc` grant's identity tokens must carry for one agent: the API's origin plus
 * `/v1/agents/{agent_id}`. Request your platform's token for exactly this audience. `baseUrl`
 * must be the URL the API itself publishes as `servers[0]` (its configured public URL, such as
 * `DEFAULT_BASE_URL` on the hosted API), not an alias that reaches the same host.
 */
export function oidcGrantAudience(baseUrl: string, agentId: string): string {
  return `${originOf(baseUrl)}/v1/agents/${agentId}`;
}

/** The URL a key assertion is addressed to: the exchange endpoint of one agent. */
function exchangeUrl(baseUrl: string, agentId: string) {
  return `${oidcGrantAudience(baseUrl, agentId)}/grants/token`;
}

/**
 * A single-use assertion (RFC 7523) that the key of a `public_key` grant signs, to send as the
 * `subject_token` of `exchangeGrantToken`. It lives one minute and exchanges once, so create a
 * new one for every exchange. `baseUrl` follows the rule of {@link oidcGrantAudience}.
 */
export function createKeyAssertion(
  signer: WorkloadSigner,
  options: { baseUrl: string; agentId: string },
): Promise<string> {
  return signJwt(signer, baseClaims(signer, exchangeUrl(options.baseUrl, options.agentId)));
}

/**
 * A proof (`X-Grant-Proof`) that the key of a `public_key` grant signs for exactly one request:
 * its grant, method, URL without query, body bytes and `Idempotency-Key`. The API spends it on
 * first use, so sign a new one for every attempt, a retry included, and keep the same
 * `Idempotency-Key`. `AgentApi.forGrantProof` does this for you.
 */
export function createGrantProof(
  signer: WorkloadSigner,
  request: GrantProofRequest,
): Promise<string> {
  const url = new URL(request.url);
  const body = typeof request.body === "string" ? utf8ToBytes(request.body) : request.body;
  return signJwt(signer, {
    ...baseClaims(signer, `${url.origin}${url.pathname}`),
    grant_id: request.grantId,
    htm: request.method.toUpperCase(),
    body_sha256: bytesToHex(sha256(body ?? new Uint8Array())),
    ...(request.idempotencyKey === undefined ? {} : { idempotency_key: request.idempotencyKey }),
  });
}
