import assert from "node:assert/strict";
import { test } from "node:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { base58 } from "@scure/base";
import { auditLeaf, encodeAuditOpening } from "../src/generated/transparency/audit.js";
import { birthReportData, signingAddress } from "../src/generated/transparency/binding.js";
import { formatCheckpoint } from "../src/generated/transparency/checkpoint.js";
import { signWitnessMessage } from "../src/generated/transparency/checkpoint-witness.js";
import {
  COSIGNATURE_V1,
  cosignatureSigner,
  ED25519,
  ed25519Signer,
  signNote,
  verifierKey,
} from "../src/generated/transparency/note.js";
import { formatTlogProof } from "../src/generated/transparency/tlog-proof.js";
import {
  AgentApi,
  type Checkpoint,
  fetchWitnessCheckpoint,
  NoteError,
  type OperationProofDocument,
  ProofError,
  parseCheckpoint,
  verifyOperationProof,
} from "../src/index.js";

const origin = "api.example.com/log";
const notaryName = "api.example.com/notary";
const correlationId = "op_example";
const agentId = "a".repeat(64);
const event = { action: "execute.completed", created_at: "2026-10-06T00:00:00.000Z" };
const settlement = base58.encode(new Uint8Array(32).fill(7));
const evidence = JSON.stringify({ settlement_tx_hash: settlement });
const evidenceHash = bytesToHex(sha256(utf8ToBytes(evidence)));

/** A one-entry log whose checkpoint the log key and the notary cosign, as the API serves it. */
function proofDocument(): OperationProofDocument {
  const logSecret = ed25519.utils.randomSecretKey();
  const notarySecret = ed25519.utils.randomSecretKey();
  const opening = encodeAuditOpening(
    {
      agentId,
      action: event.action,
      resourceId: correlationId,
      createdAt: event.created_at,
      evidenceHash,
    },
    new Uint8Array(32).fill(7),
  );
  const checkpoint = formatCheckpoint({
    origin,
    size: 1n,
    root: auditLeaf(opening),
    extensions: [],
  });
  const note = signNote(checkpoint, [
    ed25519Signer(origin, logSecret),
    cosignatureSigner(notaryName, notarySecret, () => 1_791_000_000n),
  ]);
  const logPublic = ed25519.getPublicKey(logSecret);
  const notaryPublic = ed25519.getPublicKey(notarySecret);
  const address = signingAddress(logPublic, notaryPublic);
  return {
    agent_id: agentId,
    correlation_id: correlationId,
    origin,
    checkpoint: new TextDecoder().decode(note),
    consistency: null,
    notary: {
      log_key: verifierKey(origin, ED25519, logPublic),
      notary_key: verifierKey(notaryName, COSIGNATURE_V1, notaryPublic),
      signing_address: bytesToHex(address),
      birth: { report_data: bytesToHex(birthReportData(address, undefined)), previous: null },
    },
    events: [
      {
        ...event,
        status: "PROVEN",
        proof: new TextDecoder().decode(
          formatTlogProof({ extra: opening, index: 0n, proof: [], checkpoint: note }),
        ),
        evidence,
      },
    ],
  };
}

/** The head a witness would report for this log: the signed checkpoint's body. */
function witnessed(document: OperationProofDocument): Checkpoint {
  const note = document.checkpoint ?? "";
  return parseCheckpoint(note.slice(0, note.indexOf("\n\n") + 1));
}

test("a proof the log and notary signed verifies offline and opens to its event", () => {
  const document = proofDocument();
  const verified = verifyOperationProof(document, origin, witnessed(document));
  assert.equal(verified.checkpoint.size, 1n);
  assert.equal(verified.birthReportData, document.notary?.birth.report_data);
  assert.equal(verified.proven.length, 1);
  assert.deepEqual(verified.proven[0]?.fields, {
    agentId,
    action: event.action,
    createdAt: event.created_at,
    evidenceHash,
    resourceId: correlationId,
  });
  assert.deepEqual(verified.proven[0]?.evidence, JSON.parse(evidence));
  assert.equal(verified.proven[0]?.cosignedAt, 1_791_000_000n);
  assert.deepEqual([verified.pending, verified.unlogged], [0, 0]);
});

test("forged logs, events, openings and notary keys the birth does not bind are refused", () => {
  const document = proofDocument();
  const [proven] = document.events;
  assert.ok(proven?.proof && document.notary);
  const other = encodeAuditOpening(
    { agentId, action: event.action, resourceId: correlationId, createdAt: event.created_at },
    new Uint8Array(32).fill(8),
  );
  const swapped = proven.proof.replace(
    /^extra .*$/m,
    `extra ${Buffer.from(other).toString("base64")}`,
  );
  const notary = document.notary;
  const unbound = proofDocument().notary?.notary_key ?? "";
  const otherBirth = { ...notary.birth, report_data: "0".repeat(128) };
  const forgeries: [OperationProofDocument, typeof NoteError | typeof ProofError][] = [
    [{ ...document, origin: "api.other.example/log" }, NoteError],
    [{ ...document, events: [{ ...proven, action: "execute.failed" }] }, NoteError],
    [
      {
        ...document,
        events: [{ ...proven, evidence: evidence.replace(settlement, settlement.slice(1)) }],
      },
      NoteError,
    ],
    [{ ...document, events: [{ ...proven, proof: swapped }] }, ProofError],
    [{ ...document, notary: { ...notary, notary_key: unbound } }, NoteError],
    [{ ...document, notary: { ...notary, birth: otherBirth } }, NoteError],
    [{ ...document, notary: { ...notary, signing_address: "0".repeat(128) } }, NoteError],
  ];
  assert.notEqual(swapped, proven.proof);
  const trusted = witnessed(document);
  for (const [forged, refusal] of forgeries)
    assert.throws(() => verifyOperationProof(forged, forged.origin, trusted), refusal);
  assert.throws(() => verifyOperationProof(document, "api.other.example/log", trusted), NoteError);
});

test("a log the trusted head does not lead to is refused: a fork, a rollback, another log", () => {
  const document = proofDocument();
  const trusted = witnessed(document);
  const forked = { ...trusted, root: new Uint8Array(32) };
  const ahead = { ...trusted, size: trusted.size + 1n };
  const foreign = { ...trusted, origin: "api.other.example/log" };
  assert.throws(() => verifyOperationProof(document, origin, forked), ProofError);
  assert.throws(() => verifyOperationProof(document, origin, ahead), ProofError);
  assert.throws(() => verifyOperationProof(document, origin, foreign), NoteError);
});

test("a head the pinned witness signs for a fresh nonce is the trusted checkpoint", async (t) => {
  const document = proofDocument();
  const witnessSecret = ed25519.utils.randomSecretKey();
  const witnessKey = bytesToHex(ed25519.getPublicKey(witnessSecret));
  let previous: unknown;
  let replay = false;
  t.mock.method(globalThis, "fetch", (url: URL) => {
    const envelope = signWitnessMessage(
      { nonce: url.searchParams.get("nonce"), checkpoint: formatCheckpoint(witnessed(document)) },
      witnessSecret,
      "response",
    );
    const reply = Response.json(replay ? previous : envelope);
    previous = envelope;
    return Promise.resolve(reply);
  });
  const trusted = await fetchWitnessCheckpoint("https://api.example.com", origin, witnessKey);
  assert.equal(verifyOperationProof(document, origin, trusted).proven.length, 1);
  replay = true;
  await assert.rejects(
    fetchWitnessCheckpoint("https://api.example.com", origin, witnessKey),
    NoteError,
  );
  const stranger = bytesToHex(ed25519.getPublicKey(ed25519.utils.randomSecretKey()));
  replay = false;
  await assert.rejects(
    fetchWitnessCheckpoint("https://api.example.com", origin, stranger),
    NoteError,
  );
});

test("a getOperationProof response verifies without reshaping", async () => {
  const document = proofDocument();
  const api = new AgentApi({
    baseUrl: "https://api.test",
    apiKey: `naa_${"a".repeat(43)}`,
    fetch: async () => Response.json(document),
  });
  const response = await api.getOperationProof(agentId, correlationId);
  assert.equal(verifyOperationProof(response, origin, witnessed(document)).proven.length, 1);
});
