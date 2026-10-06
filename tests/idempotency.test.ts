import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AgentApi,
  AgentApiError,
  AgentApiRequestError,
  AgentApiResponseTooLargeError,
  createGrantCredential,
  createIdempotencyKey,
  type IdempotentOptions,
} from "../src/index.js";

/** The server accepts 8-128 characters of `A-Za-z0-9._:-` as an Idempotency-Key. */
const idempotencyKeySchema = {
  parse(value: unknown) {
    assert.match(String(value), /^[A-Za-z0-9._:-]{8,128}$/);
  },
};

const apiKey = `naa_${"a".repeat(43)}`;
const agentId = "a".repeat(64);
const move = { asset: "near", amount: "1" };
const swap = { origin_asset: "near", destination_asset: "usdc", amount: "1" };
const withdraw = { ...move, chain: "near", recipient: "owner.near" };

test("each SDK write generates a request-local key and returns it without changing wire payloads", async () => {
  const calls: Array<{ key: string | null; body: unknown }> = [];
  const api = new AgentApi({
    baseUrl: "https://api.test",
    apiKey,
    fetch: async (_input, init) => {
      calls.push({
        key: new Headers(init?.headers).get("idempotency-key"),
        body: JSON.parse(String(init?.body)),
      });
      return Response.json({
        correlation_id: agentId,
        details: { amount: "1" },
        idempotencyKey: "untrusted-response-key",
      });
    },
  });
  const writes: Array<(options?: IdempotentOptions) => Promise<{ idempotencyKey: string }>> = [
    (options) => api.generateIntent({ type: "agent_freeze", agent_id: agentId }, options),
    (options) => api.swap(agentId, swap, options),
    (options) => api.withdraw(agentId, withdraw, options),
    (options) => api.transfer(agentId, { ...move, recipient: "owner.near" }, options),
    (options) => api.shield(agentId, move, options),
    (options) => api.unshield(agentId, move, options),
    (options) => api.deposit(agentId, { origin_asset: move.asset, amount: move.amount }, options),
  ];
  for (const write of writes) {
    const result = await write();
    assert.equal(result.idempotencyKey, calls.at(-1)?.key);
    idempotencyKeySchema.parse(result.idempotencyKey);
    assert.deepEqual(result, {
      correlation_id: agentId,
      details: { amount: "1" },
      idempotencyKey: result.idempotencyKey,
    });
    const last = calls.at(-1);
    assert.ok(last);
    assert.ok(!("idempotencyKey" in (last.body as object)));
  }
  assert.equal(new Set(calls.map((call) => call.key)).size, writes.length);
  const options = { idempotencyKey: createIdempotencyKey() };
  const original = { ...options };
  const supplied = await api.shield(agentId, move, options);
  assert.equal(supplied.idempotencyKey, options.idempotencyKey);
  assert.equal(calls.at(-1)?.key, options.idempotencyKey);
  assert.deepEqual(options, original);
  const grantApi = api.forGrant(createGrantCredential().token);
  const concurrent = await Promise.all([api.shield(agentId, move), grantApi.shield(agentId, move)]);
  assert.notEqual(concurrent[0].idempotencyKey, concurrent[1].idempotencyKey);
});

test("quotes and non-idempotency endpoints generate no keys; recovery only forwards its original key", async () => {
  const keys: Array<string | null> = [];
  const api = new AgentApi({
    baseUrl: "https://api.test",
    apiKey,
    fetch: async (_input, init) => {
      keys.push(new Headers(init?.headers).get("idempotency-key"));
      return Response.json({});
    },
  });
  const results = [
    await api.swap(agentId, { ...swap, dry: true }),
    await api.withdraw(agentId, { ...withdraw, dry: true }),
    await api.getStatus(agentId),
    await api.getAgent(agentId),
    await api.submitIntent({
      type: "agent_freeze",
      correlation_id: agentId,
      signed_data: {
        standard: "eip712",
        payload: { domain: {}, types: {}, primaryType: "X", message: {} },
        signature: `0x${"a".repeat(130)}`,
      },
    }),
  ];
  assert.ok(keys.every((key) => key === null));
  assert.ok(results.every((result) => !("idempotencyKey" in result)));
  const request = { correlation_id: agentId, request: { type: "shield" as const, ...move } };
  const recovered = await api.recover(agentId, request, {
    idempotencyKey: "original-operation-key",
  });
  assert.equal(recovered.idempotencyKey, "original-operation-key");
  assert.equal(keys.at(-1), "original-operation-key");
  // Runtime callers bypassing TypeScript must not receive a fresh recovery identity either.
  await api.recover(agentId, request, {} as { idempotencyKey: string });
  assert.equal(keys.at(-1), null);
});

test("invalid supplied keys are forwarded unchanged rather than replaced", async () => {
  for (const idempotencyKey of ["", "short", "invalid/key"]) {
    let sentKey: string | null = null;
    const api = new AgentApi({
      baseUrl: "https://api.test",
      apiKey,
      fetch: async (_input, init) => {
        sentKey = new Headers(init?.headers).get("idempotency-key");
        return Response.json(
          { errors: [{ code: "validation_failed", title: "Invalid key" }] },
          { status: 400 },
        );
      },
    });
    await assert.rejects(api.shield(agentId, move, { idempotencyKey }), (error: unknown) => {
      assert.ok(error instanceof AgentApiError);
      assert.equal(error.idempotencyKey, idempotencyKey);
      assert.equal(error.code, "validation_failed");
      return true;
    });
    assert.equal(sentKey, idempotencyKey);
  }
});

test("write failures retain the transmitted key and never retry automatically", async (t) => {
  const transportErrors = [
    new TypeError("connection lost"),
    new DOMException("timed out", "TimeoutError"),
    new DOMException("cancelled", "AbortError"),
  ];
  const cases = [
    {
      name: "HTTP JSON",
      response: () =>
        Response.json(
          { errors: [{ code: "provider_unavailable", title: "Unavailable" }] },
          { status: 503 },
        ),
      expected: AgentApiError,
    },
    {
      name: "HTTP non-JSON",
      response: () => new Response("unavailable", { status: 502 }),
      expected: AgentApiError,
    },
    {
      name: "oversized success",
      response: () => new Response("{} "),
      expected: AgentApiResponseTooLargeError,
      maxResponseBytes: 2,
    },
    {
      name: "oversized error",
      response: () => new Response("{} ", { status: 502 }),
      expected: AgentApiResponseTooLargeError,
      maxResponseBytes: 2,
    },
    {
      name: "invalid success JSON",
      response: () => new Response("{"),
      expected: AgentApiRequestError,
    },
    {
      name: "body read failure",
      response: () =>
        new Response(
          new ReadableStream({
            start(stream) {
              stream.error(new Error("read failed"));
            },
          }),
        ),
      expected: AgentApiRequestError,
    },
    ...transportErrors.map((cause) => ({
      name: cause.name,
      response: (): Response => {
        throw cause;
      },
      expected: AgentApiRequestError,
      cause,
    })),
  ];
  for (const scenario of cases)
    await t.test(scenario.name, async () => {
      let sentKey: string | null = null;
      let calls = 0;
      const api = new AgentApi({
        baseUrl: "https://api.test",
        apiKey,
        maxResponseBytes: "maxResponseBytes" in scenario ? scenario.maxResponseBytes : undefined,
        fetch: async (_input, init) => {
          calls++;
          sentKey = new Headers(init?.headers).get("idempotency-key");
          return scenario.response();
        },
      });
      await assert.rejects(api.shield(agentId, move), (error: unknown) => {
        assert.ok(error instanceof scenario.expected);
        assert.equal(error.idempotencyKey, sentKey);
        idempotencyKeySchema.parse(error.idempotencyKey);
        if ("cause" in scenario) {
          assert.equal(error.cause, scenario.cause);
          assert.equal(error.name, scenario.cause.name);
          assert.equal(error.message, scenario.cause.message);
        }
        return true;
      });
      assert.equal(calls, 1);
    });
});
