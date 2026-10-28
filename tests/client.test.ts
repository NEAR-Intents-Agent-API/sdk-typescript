import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  AgentApi,
  AgentApiError,
  type ApiErrorLayer,
  type BalanceEntry,
  createGrantCredential,
  DEFAULT_BASE_URL,
  type ExecutionDetails,
  grantCommitment,
  type QuoteResponse,
} from "../src/index.js";

const apiKey = `naa_${"a".repeat(43)}`;
const agentId = "a".repeat(64);

test("client preserves payload, places credentials and idempotency only in headers", async () => {
  const calls: { url: URL; init: RequestInit }[] = [];
  const api = new AgentApi({
    baseUrl: "https://api.test",
    apiKey,
    fetch: async (input, init) => {
      calls.push({ url: new URL(String(input)), init: init ?? {} });
      return Response.json({});
    },
  });
  const body = {
    origin_asset: "near",
    destination_asset: "usdc",
    amount: "1000000000000000000000000",
  };
  await api.swap(agentId, body, { idempotencyKey: "same-logical-execution" });
  await api.getStatus("intent/with spaces", { waitMs: 30_000 });
  await api.getHistory(agentId, { include_unpaid: true });
  assert.equal(calls[2]?.url.pathname, `/v1/agents/${agentId}/history`);
  assert.equal(calls[2]?.url.searchParams.get("include_unpaid"), "true");
  assert.equal(calls[0]?.url.pathname, `/v1/agents/${agentId}/swap`);
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), body);
  const headers = new Headers(calls[0]?.init.headers);
  assert.equal(headers.get("x-api-key"), apiKey);
  assert.equal(headers.get("idempotency-key"), "same-logical-execution");
  assert.equal(headers.get("authorization"), null);
  assert.equal(calls[0]?.init.credentials, "omit");
  assert.equal(calls[0]?.init.redirect, "error");
  assert.equal(calls[1]?.url.searchParams.get("correlation_id"), "intent/with spaces");
  assert.equal(calls[1]?.url.searchParams.get("wait_ms"), "30000");
});

test("baseUrl is optional and defaults to the hosted API", async () => {
  const urls: string[] = [];
  const api = new AgentApi({
    apiKey,
    fetch: async (input) => {
      urls.push(String(input));
      return Response.json({ data: [] });
    },
  });
  await api.getTokens();
  assert.equal(DEFAULT_BASE_URL, "https://api.agentsonintents.com");
  assert.equal(urls[0], "https://api.agentsonintents.com/v1/tokens");
});

test("release reads are public GETs on /v1/releases", async () => {
  const urls: string[] = [];
  const api = new AgentApi({
    baseUrl: "https://api.test",
    apiKey,
    fetch: async (input) => {
      urls.push(String(input));
      return Response.json({ releases: [] });
    },
  });
  await api.listReleases();
  await api.getLatestRelease();
  await api.getRelease("2026.10.23");
  assert.deepEqual(urls, [
    "https://api.test/v1/releases",
    "https://api.test/v1/releases/latest",
    "https://api.test/v1/releases/2026.10.23",
  ]);
});

test("settlement calls outlive provider budget while quotes and status retain short client deadline", async (t) => {
  const budgets: number[] = [];
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    budgets.push(ms);
    return timeout(ms);
  });
  const api = new AgentApi({
    baseUrl: "https://api.test",
    apiKey,
    fetch: async () => Response.json({}),
  });
  const swap = { origin_asset: "near", destination_asset: "usdc", amount: "1" };
  await api.swap(agentId, swap, { idempotencyKey: "budgeted-settlement" });
  await api.swap(agentId, { ...swap, dry: true });
  await api.getStatus("correlation-id", { refresh: true });
  assert.deepEqual(budgets, [150_000, 65_000, 65_000]);
});

test("a grant client sends its token only to delegated endpoints", async () => {
  const headers: Record<string, string | null> = {};
  const api = new AgentApi({
    baseUrl: "https://api.test",
    apiKey,
    fetch: async (input, init) => {
      headers[new URL(String(input)).pathname] = new Headers(init?.headers).get("x-grant-token");
      return Response.json({});
    },
  });
  const { token, commitment } = createGrantCredential();
  const claude = api.forGrant(token);
  await claude.swap(
    agentId,
    { origin_asset: "a", destination_asset: "b", amount: "1" },
    {
      idempotencyKey: "grant-scoped-swap",
    },
  );
  await claude.transfer(
    agentId,
    { asset: "a", amount: "1", recipient: "owner.near" },
    { idempotencyKey: "grant-scoped-transfer" },
  );
  await claude.getAgent(agentId);
  await api.swap(
    agentId,
    { origin_asset: "a", destination_asset: "b", amount: "1" },
    {
      idempotencyKey: "key-only-swap",
    },
  );
  assert.equal(headers[`/v1/agents/${agentId}/swap`], null, "the base client carries no grant");
  assert.equal(headers[`/v1/agents/${agentId}/transfer`], token);
  assert.equal(headers[`/v1/agents/${agentId}`], null, "reads never carry the token");
  // The commitment the owner signs is SHA-256 of the token, which the API stores.
  assert.equal(commitment, createHash("sha256").update(token).digest("hex"));
  assert.equal(grantCommitment(token), commitment);
  assert.match(token, /^ngt_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(createGrantCredential().token, token);
  assert.throws(() => api.forGrant("not-a-token"), /grantToken is not an ngt_ token/);
});

test("an operation proof is read from the agent's operation with the API key alone", async () => {
  const calls: { url: URL; headers: Headers }[] = [];
  const api = new AgentApi({
    baseUrl: "https://api.test",
    apiKey,
    fetch: async (input, init) => {
      calls.push({ url: new URL(String(input)), headers: new Headers(init?.headers) });
      return Response.json({ correlation_id: "op_1", origin: "o", notary: null, events: [] });
    },
  });
  const { token } = createGrantCredential();
  await api.forGrant(token).getOperationProof(agentId, "op_a/b");
  assert.equal(calls[0]?.url.pathname, `/v1/agents/${agentId}/operations/op_a%2Fb/proof`);
  assert.equal(calls[0]?.url.searchParams.has("from_size"), false);
  assert.equal(calls[0]?.headers.get("x-api-key"), apiKey);
  assert.equal(calls[0]?.headers.get("x-grant-token"), null);
  assert.equal(calls[0]?.headers.get("idempotency-key"), null);
  await api.getOperationProof(agentId, "op_1", { from_size: "42" });
  assert.equal(calls[1]?.url.searchParams.get("from_size"), "42");
});

test("client exposes JSON:API errors and handles non-JSON upstream failures", async () => {
  for (const json of [true, false]) {
    const api = new AgentApi({
      baseUrl: "https://api.test",
      apiKey,
      fetch: async () =>
        json
          ? Response.json(
              {
                errors: [
                  {
                    status: "409",
                    code: "policy_conflict",
                    layer: "policy",
                    title: "Conflict",
                    meta: { retryable: false, min_amount: "150000", available_amount: "42" },
                  },
                ],
                meta: { request_id: "request-1" },
              },
              { status: 409 },
            )
          : new Response("upstream unavailable", { status: 502 }),
    });
    await assert.rejects(api.getAgent(agentId), (error: unknown) => {
      assert.ok(error instanceof AgentApiError);
      assert.equal(error.status, json ? 409 : 502);
      assert.equal(error.code, json ? "policy_conflict" : "http_error");
      assert.equal(error.requestId, json ? "request-1" : undefined);
      assert.equal(error.minAmount, json ? "150000" : undefined);
      assert.equal(error.layer, json ? "policy" : undefined);
      return true;
    });
  }
});

test("error layer and retryable come from the first error; an absent flag reads false", async () => {
  const cases = [
    { code: "spend_budget_exceeded", layer: "budget", meta: undefined, retryable: false },
    { code: "provider_unavailable", layer: "provider", meta: { retryable: true }, retryable: true },
    { code: "operation_not_found", layer: "request", meta: { retryable: false }, retryable: false },
    {
      code: "insufficient_balance",
      layer: "balance",
      meta: { available_amount: "42" },
      retryable: false,
    },
  ] as const;
  for (const expected of cases) {
    const api = new AgentApi({
      baseUrl: "https://api.test",
      apiKey,
      fetch: async () =>
        Response.json(
          {
            errors: [
              {
                status: "503",
                code: expected.code,
                layer: expected.layer,
                title: "Refused",
                meta: expected.meta,
              },
            ],
            meta: { request_id: "request-2" },
          },
          { status: 503 },
        ),
    });
    await assert.rejects(api.getAgent(agentId), (error: unknown) => {
      assert.ok(error instanceof AgentApiError);
      assert.equal(error.code, expected.code);
      assert.equal(error.layer, expected.layer);
      assert.equal(error.errors[0]?.layer, expected.layer);
      assert.equal(error.retryable, expected.retryable);
      assert.equal(
        error.availableAmount,
        expected.code === "insufficient_balance" ? "42" : undefined,
      );
      return true;
    });
  }
});

test("Retry-After reaches the error in seconds, from delay-seconds or an HTTP date", async () => {
  const inFive = new Date(Date.now() + 5_000).toUTCString();
  for (const [header, seconds] of [
    ["1", 1],
    [" 30 ", 30],
    [inFive, 5],
    ["Thu, 01 Jan 1970 00:00:00 GMT", 0],
    ["soon", undefined],
    [null, undefined],
  ] as const) {
    const api = new AgentApi({
      baseUrl: "https://api.test",
      apiKey,
      fetch: async () =>
        Response.json(
          {
            errors: [
              {
                status: "429",
                code: "rate_limited",
                layer: "api",
                title: "Rate limited",
                meta: { retryable: true },
              },
            ],
          },
          { status: 429, headers: header === null ? {} : { "retry-after": header } },
        ),
    });
    await assert.rejects(api.getAgent(agentId), (error: unknown) => {
      assert.ok(error instanceof AgentApiError);
      assert.equal(error.retryable, true);
      // An HTTP date rounds up to the next whole second, so allow the clock one second.
      if (header === inFive)
        assert.ok(error.retryAfterSeconds === 5 || error.retryAfterSeconds === 4);
      else assert.equal(error.retryAfterSeconds, seconds, String(header));
      return true;
    });
  }
});

test("client refuses credential-bearing or insecure origins before fetch", () => {
  for (const baseUrl of [
    "http://api.test",
    "https://user:pass@api.test",
    "https://api.test?key=secret",
    "https://api.test/path",
  ]) {
    assert.throws(() => new AgentApi({ baseUrl, apiKey }));
  }
  assert.doesNotThrow(() => new AgentApi({ baseUrl: "http://localhost:8080", apiKey }));
});

test("aborted requests forward cancellation and never retry a mutation", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const api = new AgentApi({
    baseUrl: "https://api.test",
    apiKey,
    fetch: async (_input, init) => {
      calls++;
      init?.signal?.throwIfAborted();
      throw new Error("unexpected");
    },
  });
  await assert.rejects(
    api.shield(
      agentId,
      { asset: "near", amount: "1" },
      { idempotencyKey: "shield-one", signal: controller.signal },
    ),
    { name: "AbortError" },
  );
  assert.equal(calls, 1);
});

test("wire types carry error layers, available balances and expected_amount_out", () => {
  // Compile-time checks: a server rename or removal breaks the build before it reaches a caller.
  const balance: Pick<BalanceEntry, "balance_raw" | "available_raw" | "available"> = {
    balance_raw: "10",
    available_raw: "7",
    available: null,
  };
  const warning: QuoteResponse["warnings"][number]["code"][] = [
    "policy_action_denied",
    "policy_destination_denied",
    "unsupported_token",
    "invalid_address",
    "insufficient_balance",
  ];
  const details: Pick<ExecutionDetails, "amount_out" | "expected_amount_out"> = {
    expected_amount_out: "5",
  };
  const layers: ApiErrorLayer[] = [
    "request",
    "auth",
    "grant",
    "policy",
    "budget",
    "balance",
    "provider",
    "api",
  ];
  assert.equal(balance.available_raw, "7");
  assert.equal(warning.length, 5);
  assert.equal(details.amount_out, undefined);
  assert.equal(layers.length, 8);
});
