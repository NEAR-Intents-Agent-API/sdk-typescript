import assert from "node:assert/strict";
import { test } from "node:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { formatCheckpoint } from "../src/generated/transparency/checkpoint.js";
import { signWitnessMessage } from "../src/generated/transparency/checkpoint-witness.js";
import { emptyRoot } from "../src/generated/transparency/hash.js";
import { fetchWitnessCheckpoint, NoteError } from "../src/index.js";

const origin = "api.example.com/log";
const head = { origin, size: 0n, root: emptyRoot(), extensions: [] };
const secret = ed25519.utils.randomSecretKey();
const pinned = bytesToHex(ed25519.getPublicKey(secret));

/** Answers `/tee/witness` the way the API transports front-1's signed reply. */
async function withWitness<T>(sign: (nonce: string) => unknown, run: () => Promise<T>) {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: URL) =>
    Response.json(sign(input.searchParams.get("nonce") ?? ""))) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = real;
  }
}

const reply = (key: Uint8Array) => (nonce: string) =>
  signWitnessMessage({ nonce, checkpoint: formatCheckpoint(head) }, key, "response");

test("the witness head is accepted only when the pinned key signed it for this nonce", async () => {
  const api = "https://api.example.com";
  const checkpoint = await withWitness(reply(secret), () =>
    fetchWitnessCheckpoint(api, origin, pinned),
  );
  assert.equal(checkpoint.size, 0n);
  assert.equal(checkpoint.origin, origin);

  const other = ed25519.utils.randomSecretKey();
  await withWitness(reply(other), () =>
    assert.rejects(fetchWitnessCheckpoint(api, origin, pinned), NoteError),
  );
  await withWitness(
    () => reply(secret)("0".repeat(64)),
    () => assert.rejects(fetchWitnessCheckpoint(api, origin, pinned), NoteError),
  );
  await withWitness(reply(secret), () =>
    assert.rejects(fetchWitnessCheckpoint(api, "api.other.example/log", pinned), NoteError),
  );
  await assert.rejects(fetchWitnessCheckpoint("http://api.example.com", origin, pinned), NoteError);
});
