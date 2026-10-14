import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";
import { test } from "node:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { AsnConvert, OctetString } from "@peculiar/asn1-schema";
import {
  AlgorithmIdentifier,
  AttributeTypeAndValue,
  AttributeValue,
  BasicConstraints,
  Certificate,
  CertificateList,
  CRLDistributionPoints,
  DistributionPoint,
  DistributionPointName,
  Extension,
  Extensions,
  GeneralName,
  id_ce_basicConstraints,
  id_ce_cRLDistributionPoints,
  id_ce_keyUsage,
  KeyUsage,
  KeyUsageFlags,
  Name,
  RelativeDistinguishedName,
  RevokedCertificate,
  SubjectPublicKeyInfo,
  TBSCertificate,
  TBSCertList,
  Time,
  Validity,
  Version,
} from "@peculiar/asn1-x509";
import { SignJWT } from "jose";
import { itaNotaryRuntimeData, itaReportData } from "../src/generated/transparency/binding.js";
import { formatCheckpoint } from "../src/generated/transparency/checkpoint.js";
import {
  type RuntimeEvent,
  replayRtmr3,
  runtimeEventDigest,
} from "../src/generated/transparency/ita-token.js";
import {
  COSIGNATURE_V1,
  cosignatureSigner,
  ED25519,
  ed25519Signer,
  signNote,
  verifierKey,
} from "../src/generated/transparency/note.js";
import {
  AgentApi,
  ITA_ISSUER,
  ITA_ROOT_SHA256,
  ItaVerificationError,
  type NotaryTokenOptions,
  revocationUrls,
  type TokenNotary,
  verifyNotaryToken,
} from "../src/index.js";

type Party = { name: string; serial: number; publicKey: KeyObject; privateKey: KeyObject };

const SHA512_RSA = "1.2.840.113549.1.1.13";
const DAY = 86_400_000;
const CA_CRL = "https://trust.example.com/ca.crl";
const ROOT_CRL = "https://trust.example.com/root.crl";
const origin = "api.example.com/log";
const notaryName = "api.example.com/notary";
const appId = `${"00".repeat(19)}01`;
const composeHash = "ab".repeat(32);
const measurements = {
  mrtd: "11".repeat(48),
  rtmr0: "22".repeat(48),
  rtmr1: "33".repeat(48),
  rtmr2: "44".repeat(48),
};
const now = new Date();

const party = (name: string, serial: number): Party => ({
  name,
  serial,
  ...generateKeyPairSync("rsa", { modulusLength: 2048 }),
});
const algorithm = () => new AlgorithmIdentifier({ algorithm: SHA512_RSA, parameters: null });
const nameOf = (commonName: string) =>
  new Name([
    new RelativeDistinguishedName([
      new AttributeTypeAndValue({
        type: "2.5.4.3",
        value: new AttributeValue({ utf8String: commonName }),
      }),
    ]),
  ]);
const extension = (extnID: string, critical: boolean, value: object) =>
  new Extension({ extnID, critical, extnValue: new OctetString(AsnConvert.serialize(value)) });
const signed = (data: ArrayBuffer, key: KeyObject) =>
  new Uint8Array(sign("sha512", Buffer.from(data), key)).buffer;

function certificate(subject: Party, issuer: Party, usage: number, crl?: string) {
  const ca = usage !== KeyUsageFlags.digitalSignature;
  const pathLength = ca && subject !== issuer ? { pathLenConstraint: 0 } : {};
  const extensions = [
    extension(id_ce_basicConstraints, true, new BasicConstraints({ cA: ca, ...pathLength })),
    extension(id_ce_keyUsage, true, new KeyUsage(usage)),
  ];
  if (crl) {
    const name = new GeneralName({ uniformResourceIdentifier: crl });
    const point = new DistributionPointName({ fullName: [name] });
    extensions.push(
      extension(
        id_ce_cRLDistributionPoints,
        false,
        new CRLDistributionPoints([new DistributionPoint({ distributionPoint: point })]),
      ),
    );
  }
  const tbsCertificate = new TBSCertificate({
    version: Version.v3,
    serialNumber: new Uint8Array([subject.serial]).buffer,
    signature: algorithm(),
    issuer: nameOf(issuer.name),
    validity: new Validity({
      notBefore: new Date(now.getTime() - 30 * DAY),
      notAfter: new Date(now.getTime() + 300 * DAY),
    }),
    subject: nameOf(subject.name),
    subjectPublicKeyInfo: AsnConvert.parse(
      subject.publicKey.export({ type: "spki", format: "der" }),
      SubjectPublicKeyInfo,
    ),
    extensions: new Extensions(extensions),
  });
  const encoded = new Certificate({
    tbsCertificate,
    signatureAlgorithm: algorithm(),
    signatureValue: signed(AsnConvert.serialize(tbsCertificate), issuer.privateKey),
  });
  return Buffer.from(AsnConvert.serialize(encoded)).toString("base64");
}

function revocationList(issuer: Party, revoked: readonly number[] = []) {
  const revokedCertificates = revoked.map(
    (serial) =>
      new RevokedCertificate({
        userCertificate: new Uint8Array([serial]).buffer,
        revocationDate: new Time(now),
      }),
  );
  const tbsCertList = new TBSCertList({
    version: Version.v2,
    signature: algorithm(),
    issuer: nameOf(issuer.name),
    thisUpdate: new Time(new Date(now.getTime() - DAY)),
    nextUpdate: new Time(new Date(now.getTime() + 20 * DAY)),
    ...(revokedCertificates.length ? { revokedCertificates } : {}),
  });
  const list = new CertificateList({
    tbsCertList,
    signatureAlgorithm: algorithm(),
    signature: signed(AsnConvert.serialize(tbsCertList), issuer.privateKey),
  });
  return new Uint8Array(AsnConvert.serialize(list));
}

const root = party("Test Root CA", 1);
const ca = party("Test Signing CA", 2);
const leaf = party("Test Token Signer", 3);
const issuing = KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign;
const x5c = [
  certificate(leaf, ca, KeyUsageFlags.digitalSignature, CA_CRL),
  certificate(ca, root, issuing, ROOT_CRL),
  certificate(root, root, issuing),
];
const rootSha256 = createHash("sha256")
  .update(Buffer.from(x5c[2] ?? "", "base64"))
  .digest("hex");
const { n, e } = leaf.publicKey.export({ format: "jwk" });
const signingKey = { kid: "test-signer.PS384", kty: "RSA", alg: "PS384", use: "sig", n, e, x5c };
const lists = new Map([
  [CA_CRL, revocationList(ca)],
  [ROOT_CRL, revocationList(root)],
]);

const event = (name: string, payload: string): RuntimeEvent => ({
  imr: 3,
  event_type: 0x08000001,
  digest: bytesToHex(runtimeEventDigest(name, hexToBytes(payload))),
  event: name,
  event_payload: payload,
});

async function storedNotary(): Promise<TokenNotary> {
  const logSecret = ed25519.utils.randomSecretKey();
  const notarySecret = ed25519.utils.randomSecretKey();
  const logKey = verifierKey(origin, ED25519, ed25519.getPublicKey(logSecret));
  const notaryKey = verifierKey(notaryName, COSIGNATURE_V1, ed25519.getPublicKey(notarySecret));
  const body = formatCheckpoint({
    origin,
    size: 3n,
    root: new Uint8Array(32).fill(5),
    extensions: [],
  });
  const note = signNote(body, [
    ed25519Signer(origin, logSecret),
    cosignatureSigner(notaryName, notarySecret, () => 1_791_000_000n),
  ]);
  const checkpoint = new TextDecoder().decode(note);
  const nonce = bytesToHex(sha256(utf8ToBytes(checkpoint)));
  const runtime = itaNotaryRuntimeData(logKey, notaryKey, undefined, hexToBytes(nonce));
  const verifierNonce = {
    val: randomBytes(64).toString("base64"),
    iat: Buffer.from(String(now.getTime())).toString("base64"),
  };
  const reportData = itaReportData(
    Buffer.from(verifierNonce.val, "base64"),
    Buffer.from(verifierNonce.iat, "base64"),
    runtime,
  );
  const events = [event("app-id", appId), event("compose-hash", composeHash)];
  const seconds = Math.floor(now.getTime() / 1000);
  const token = await new SignJWT({
    iss: ITA_ISSUER,
    iat: seconds,
    nbf: seconds,
    exp: seconds + 300,
    tdx: {
      attester_tcb_status: "UpToDate",
      attester_advisory_ids: [],
      attester_runtime_data: JSON.parse(new TextDecoder().decode(runtime)),
      tdx_is_debuggable: false,
      tdx_td_attributes: "0000001000000000",
      tdx_mrconfigid: `01${composeHash}${"00".repeat(15)}`,
      tdx_mrtd: measurements.mrtd,
      tdx_rtmr0: measurements.rtmr0,
      tdx_rtmr1: measurements.rtmr1,
      tdx_rtmr2: measurements.rtmr2,
      tdx_rtmr3: replayRtmr3(events).rtmr3,
      tdx_report_data: bytesToHex(reportData),
    },
  })
    .setProtectedHeader({ alg: "PS384", typ: "JWT", kid: signingKey.kid })
    .sign(leaf.privateKey);
  return {
    log_key: logKey,
    notary_key: notaryKey,
    birth: { previous: null },
    ita: {
      token,
      nonce,
      checkpoint,
      verifier_nonce: verifierNonce,
      runtime_data: Buffer.from(runtime).toString("base64"),
      event_log: events,
      signing_key: signingKey,
    },
  };
}

const options = (overrides: Partial<NotaryTokenOptions> = {}): NotaryTokenOptions => ({
  root: rootSha256,
  issuer: ITA_ISSUER,
  revocationList: (url) => lists.get(url),
  now: new Date(now.getTime() + 3_600_000),
  appId,
  composeHash,
  measurements,
  ...overrides,
});

const failed = (checks: Record<string, boolean>) =>
  Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);

test("a stored notary token verifies against its pinned root after it expired", async () => {
  const notary = await storedNotary();
  const { claims, checks } = await verifyNotaryToken(notary, options());
  assert.deepEqual(failed(checks), []);
  assert.equal(claims.iss, ITA_ISSUER);
  const keys = [notary.ita.signing_key];
  assert.deepEqual(revocationUrls(notary.ita.token, { root: rootSha256, keys }), [
    CA_CRL,
    ROOT_CRL,
  ]);
  assert.throws(
    () => revocationUrls(notary.ita.token, { root: ITA_ROOT_SHA256, keys }),
    ItaVerificationError,
    "a chain to another root names no URL to fetch",
  );
  await assert.rejects(
    verifyNotaryToken(notary, options({ root: ITA_ROOT_SHA256 })),
    ItaVerificationError,
  );
  const malformed = JSON.parse(JSON.stringify({ ...notary, ita: { ...notary.ita, event_log: 1 } }));
  await assert.rejects(verifyNotaryToken(malformed, options()), ItaVerificationError);
});

test("other keys, checkpoint, OS image, app or compose, or a revoked signer all fail", async () => {
  const notary = await storedNotary();
  const other = await storedNotary();
  const swapped = await verifyNotaryToken({ ...notary, notary_key: other.notary_key }, options());
  assert.deepEqual(failed(swapped.checks), ["runtime_data_is_ours", "checkpoint_signed_by_notary"]);
  const moved = await verifyNotaryToken(
    { ...notary, ita: { ...notary.ita, checkpoint: other.ita.checkpoint } },
    options(),
  );
  assert.deepEqual(failed(moved.checks), [
    "nonce_commits_to_checkpoint",
    "checkpoint_signed_by_notary",
  ]);
  const recomposed = await verifyNotaryToken(notary, options({ composeHash: "cd".repeat(32) }));
  assert.deepEqual(failed(recomposed.checks), ["compose_hash_attested"]);
  const reimaged = await verifyNotaryToken(
    notary,
    options({ measurements: { ...measurements, rtmr1: "55".repeat(48) } }),
  );
  assert.deepEqual(failed(reimaged.checks), ["measurements_pinned"]);
  const elsewhere = await verifyNotaryToken(notary, options({ appId: `${"00".repeat(19)}09` }));
  assert.deepEqual(failed(elsewhere.checks), ["app_id_attested"]);
  const revoked = new Map([
    [CA_CRL, revocationList(ca, [leaf.serial])],
    [ROOT_CRL, revocationList(root)],
  ]);
  await assert.rejects(
    verifyNotaryToken(notary, options({ revocationList: (url) => revoked.get(url) })),
    /revoked/,
  );
});

test("the notary of a getOperationProof response verifies without reshaping", async () => {
  const notary = await storedNotary();
  const agentId = "a".repeat(64);
  const document = {
    agent_id: agentId,
    correlation_id: "op_example",
    origin,
    notary: {
      ...notary,
      signing_address: "0".repeat(128),
      birth: { attestation: "00", report_data: "0".repeat(128), previous: null },
    },
    events: [],
  };
  const api = new AgentApi({
    baseUrl: "https://api.test",
    apiKey: `naa_${"a".repeat(43)}`,
    fetch: async () => Response.json(document),
  });
  const proof = await api.getOperationProof(agentId, "op_example");
  const ita = proof.notary?.ita;
  assert.ok(proof.notary && ita);
  const { checks } = await verifyNotaryToken({ ...proof.notary, ita }, options());
  assert.deepEqual(failed(checks), []);
});
