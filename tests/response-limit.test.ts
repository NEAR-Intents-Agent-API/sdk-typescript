import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AgentApi,
  AgentApiError,
  AgentApiResponseTooLargeError,
  createGrantCredential,
} from "../src/index.js";

const apiKey = `naa_${"a".repeat(43)}`;
const agentId = "a".repeat(64);
const encoder = new TextEncoder();

test("response budget rejects invalid configuration before a request can start", () => {
  for (const maxResponseBytes of [0, -1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new AgentApi({ baseUrl: "https://api.test", apiKey, maxResponseBytes }), {
      name: "RangeError",
      message: "maxResponseBytes must be a positive safe integer",
    });
  }
});

test("default response budget is 8 MiB and callers can raise it to fit a response", async () => {
  const defaultBytes = 8 * 1_048_576;
  const body = "{}".padEnd(defaultBytes + 1, " ");
  const options = { baseUrl: "https://api.test", apiKey, fetch: async () => new Response(body) };
  await assert.rejects(new AgentApi(options).getAgent(agentId), (error: unknown) => {
    assert.ok(error instanceof AgentApiResponseTooLargeError);
    assert.equal(error.maxResponseBytes, defaultBytes);
    return true;
  });
  const api = new AgentApi({ ...options, maxResponseBytes: encoder.encode(body).byteLength });
  assert.deepEqual(await api.getAgent(agentId), {});
});

test("exact byte budget preserves split UTF-8 and BOM for success and HTTP errors", async (t) => {
  for (const status of [200, 502]) {
    await t.test(`HTTP ${status}`, async () => {
      const title = "€🙂";
      const payload = status === 200 ? { title } : { errors: [{ code: "upstream_error", title }] };
      const bytes = encoder.encode(`\uFEFF${JSON.stringify(payload)}`);
      const chunks = Array.from(bytes, (byte) => Uint8Array.of(byte));
      const response = new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            const chunk = chunks.shift();
            if (chunk) controller.enqueue(chunk);
            else controller.close();
          },
        }),
        { status },
      );
      const api = new AgentApi({
        baseUrl: "https://api.test",
        apiKey,
        maxResponseBytes: bytes.byteLength,
        fetch: async () => response,
      });
      if (status === 200) assert.deepEqual(await api.getAgent(agentId), payload);
      else {
        await assert.rejects(api.getAgent(agentId), (error: unknown) => {
          assert.ok(error instanceof AgentApiError);
          assert.equal(error.code, "upstream_error");
          assert.equal(error.title, title);
          return true;
        });
      }
      assert.equal(response.body?.locked, false);
    });
  }
});

test("overflow stops streamed success and error bodies despite failing or pending cleanup", async (t) => {
  for (const status of [200, 502]) {
    await t.test(`HTTP ${status}`, async () => {
      const text = '"€"';
      const bytes = encoder.encode(text);
      const maxResponseBytes = bytes.byteLength - 1;
      const chunks = [bytes.subarray(0, maxResponseBytes), bytes.subarray(maxResponseBytes)];
      let reads = 0;
      let cancellations = 0;
      const response = new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              const chunk = chunks[reads++];
              controller.enqueue(chunk ?? encoder.encode("unread"));
            },
            cancel() {
              cancellations++;
              if (status === 200) throw new Error("cleanup failed");
              return new Promise<void>(() => {});
            },
          },
          { highWaterMark: 0 },
        ),
        { status },
      );
      const base = new AgentApi({
        baseUrl: "https://api.test",
        apiKey,
        maxResponseBytes,
        fetch: async () => response,
      });
      const api = status === 200 ? base.forGrant(createGrantCredential().token) : base;
      await assert.rejects(api.getAgent(agentId), (error: unknown) => {
        assert.ok(error instanceof AgentApiResponseTooLargeError);
        assert.equal(error.code, "response_too_large");
        assert.equal(error.status, status);
        assert.equal(error.maxResponseBytes, maxResponseBytes);
        return true;
      });
      assert.equal(reads, 2);
      assert.equal(cancellations, 1);
      assert.equal(response.body?.locked, false);
    });
  }
});

test("empty success bodies preserve undefined", async () => {
  for (const response of [new Response(""), new Response(null, { status: 204 })]) {
    const api = new AgentApi({ baseUrl: "https://api.test", apiKey, fetch: async () => response });
    assert.equal(await api.getAgent(agentId), undefined);
  }
});

test("abort during response reading preserves cancellation and never retries a mutation", async () => {
  const controller = new AbortController();
  let calls = 0;
  const api = new AgentApi({
    baseUrl: "https://api.test",
    apiKey,
    fetch: async (_input, init) => {
      calls++;
      const signal = init?.signal;
      assert.ok(signal);
      let sent = false;
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            start(stream) {
              signal.addEventListener("abort", () => stream.error(signal.reason), { once: true });
            },
            pull(stream) {
              if (sent) controller.abort();
              else {
                stream.enqueue(encoder.encode("{"));
                sent = true;
              }
            },
          },
          { highWaterMark: 0 },
        ),
      );
    },
  });
  await assert.rejects(
    api.shield(
      agentId,
      { asset: "near", amount: "1" },
      { idempotencyKey: "shield-body-abort", signal: controller.signal },
    ),
    { name: "AbortError" },
  );
  assert.equal(calls, 1);
});
