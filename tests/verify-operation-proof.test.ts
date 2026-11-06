import assert from "node:assert/strict";
import { test } from "node:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { base58, base64 } from "@scure/base";
import { auditLeaf, encodeAuditOpening } from "../src/generated/transparency/audit.js";
import { birthReportData, signingAddress } from "../src/generated/transparency/binding.js";
import { formatCheckpoint } from "../src/generated/transparency/checkpoint.js";
import { emptyRoot, nodeHash } from "../src/generated/transparency/hash.js";
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
  NoteError,
  type OperationProofDocument,
  ProofError,
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

const opening = (salt: number, resourceId = correlationId, evidenceHash: string | null = null) =>
  encodeAuditOpening(
    {
      agentId,
      action: event.action,
      resourceId,
      createdAt: event.created_at,
      evidenceHash,
    },
    new Uint8Array(32).fill(salt),
  );

/** The empty tree: the floor a client holds before it has verified anything. */
const genesis: Checkpoint = { origin, size: 0n, root: emptyRoot(), extensions: [] };

/**
 * A log whose checkpoint the log key and the notary cosign, as the API serves it. With `prior`
 * the log already holds one other entry, so the proven event is its second leaf and the response
 * carries the consistency proof from that one-entry checkpoint (`trusted`); without it the log
 * holds the proven event alone and `trusted` is the empty tree.
 */
function proofDocument(prior = false): {
  document: OperationProofDocument;
  trusted: Checkpoint;
} {
  const logSecret = ed25519.utils.randomSecretKey();
  const notarySecret = ed25519.utils.randomSecretKey();
  const proven = opening(7, correlationId, evidenceHash);
  const leaf = auditLeaf(proven);
  const earlier = auditLeaf(opening(6, "op_earlier"));
  const head: Checkpoint = {
    origin,
    size: prior ? 2n : 1n,
    root: prior ? nodeHash(earlier, leaf) : leaf,
    extensions: [],
  };
  const note = signNote(formatCheckpoint(head), [
    ed25519Signer(origin, logSecret),
    cosignatureSigner(notaryName, notarySecret, () => 1_791_000_000n),
  ]);
  const logPublic = ed25519.getPublicKey(logSecret);
  const notaryPublic = ed25519.getPublicKey(notarySecret);
  const address = signingAddress(logPublic, notaryPublic);
  const document: OperationProofDocument = {
    agent_id: agentId,
    correlation_id: correlationId,
    origin,
    checkpoint: new TextDecoder().decode(note),
    consistency: prior ? { from_size: "1", hashes: [base64.encode(leaf)] } : null,
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
          formatTlogProof({
            extra: proven,
            index: prior ? 1n : 0n,
            proof: prior ? [earlier] : [],
            checkpoint: note,
          }),
        ),
        evidence,
      },
    ],
  };
  const trusted = prior ? { origin, size: 1n, root: earlier, extensions: [] } : genesis;
  return { document, trusted };
}

test("a proof the log and notary signed verifies offline and opens to its event", () => {
  const { document, trusted } = proofDocument();
  const verified = verifyOperationProof(document, origin, trusted);
  assert.equal(verified.birthReportData, document.notary?.birth.report_data);
  assert.equal(verified.checkpoint.size, 1n);
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

test("a log that grew past the trusted checkpoint verifies through its consistency proof", () => {
  const { document, trusted } = proofDocument(true);
  const verified = verifyOperationProof(document, origin, trusted);
  assert.equal(verified.checkpoint.size, 2n);
  assert.equal(verified.proven[0]?.index, 1n);
  const { consistency, ...withoutProof } = document;
  assert.ok(consistency);
  const refusals: [OperationProofDocument, Checkpoint][] = [
    // the log shows no path from the trusted tree to its new one
    [{ ...withoutProof, consistency: null }, trusted],
    [{ ...document, consistency: { ...consistency, hashes: [] } }, trusted],
    // the log disagrees with the tree the client already trusts
    [document, { ...trusted, root: new Uint8Array(32).fill(1) }],
    // the client trusts a tree larger than the one served: a rollback
    [document, { ...trusted, size: 3n }],
    // the trusted checkpoint is for another log
    [document, { ...trusted, origin: "api.other.example/log" }],
  ];
  for (const [forged, floor] of refusals)
    assert.throws(
      () => verifyOperationProof(forged, origin, floor),
      (error) => {
        assert.ok(error instanceof NoteError || error instanceof ProofError);
        return true;
      },
    );
});

test("forged logs, events, openings and notary keys the birth does not bind are refused", () => {
  const { document, trusted } = proofDocument();
  const [proven] = document.events;
  assert.ok(proven?.proof && document.notary);
  const other = opening(8);
  const swapped = proven.proof.replace(
    /^extra .*$/m,
    `extra ${Buffer.from(other).toString("base64")}`,
  );
  const notary = document.notary;
  const unbound = proofDocument().document.notary?.notary_key ?? "";
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
    [{ ...document, checkpoint: null }, NoteError],
  ];
  assert.notEqual(swapped, proven.proof);
  for (const [forged, refusal] of forgeries)
    assert.throws(() => verifyOperationProof(forged, forged.origin, trusted), refusal);
  assert.throws(() => verifyOperationProof(document, "api.other.example/log", trusted), NoteError);
});

test("a getOperationProof response verifies without reshaping and sends from_size", async () => {
  const { document, trusted } = proofDocument(true);
  const urls: string[] = [];
  const api = new AgentApi({
    baseUrl: "https://api.test",
    apiKey: "test-partner-api-key",
    fetch: async (input) => {
      urls.push(String(input));
      return Response.json(document);
    },
  });
  const response = await api.getOperationProof(agentId, correlationId, {
    from_size: String(trusted.size),
  });
  assert.equal(new URL(urls[0] ?? "").searchParams.get("from_size"), "1");
  assert.equal(verifyOperationProof(response, origin, trusted).proven.length, 1);
});
