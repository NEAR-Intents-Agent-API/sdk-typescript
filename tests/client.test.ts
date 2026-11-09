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
  type ExecutionType,
  grantCommitment,
  type LimitOrderRequest,
  type LimitOrderView,
  type PolicyAction,
  type QuoteResponse,
  type StatusResponseOf,
} from "../src/index.js";

const apiKey = "test-partner-api-key";
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

test("limit orders: placement is a keyed grant write, the preview is keyless, reads and cancels are plain calls", async () => {
  const calls: { url: URL; init: RequestInit }[] = [];
  const api = new AgentApi({
    baseUrl: "https://api.test",
    apiKey,
    fetch: async (input, init) => {
      calls.push({ url: new URL(String(input)), init: init ?? {} });
      return Response.json({});
    },
  });
  const { token } = createGrantCredential();
  const claude = api.forGrant(token);
  const order = {
    base_asset: "nep141:wrap.near",
    quote_asset: "nep141:usdt.tether-token.near",
    side: "sell" as const,
    quantity: "1000000000000000000000000",
    price: "5.2",
  };
  const base = `/v1/agents/${agentId}/limit-orders`;

  const placed = await claude.placeLimitOrder(agentId, order, { idempotencyKey: "place-order-1" });
  assert.equal(placed.idempotencyKey, "place-order-1");
  await claude.placeLimitOrder(agentId, { ...order, dry: true });
  await claude.listLimitOrders(agentId, { open: true, limit: 20, offset: 40 });
  await claude.getLimitOrder(agentId, "order/with spaces");
  await claude.cancelLimitOrder(agentId, "order-1");
  await claude.cancelAllLimitOrders(agentId);
  await api.cancelAllLimitOrders(agentId);

  const [place, preview, list, read, cancel, cancelAll, noGrant] = calls;
  assert.equal(place?.init.method, "POST");
  assert.equal(place?.url.pathname, base);
  assert.deepEqual(JSON.parse(String(place?.init.body)), order);
  const placeHeaders = new Headers(place?.init.headers);
  assert.equal(placeHeaders.get("x-grant-token"), token);
  assert.equal(placeHeaders.get("idempotency-key"), "place-order-1");
  assert.equal(placeHeaders.get("x-api-key"), apiKey);

  assert.equal(preview?.init.method, "POST");
  assert.deepEqual(JSON.parse(String(preview?.init.body)), { ...order, dry: true });
  assert.equal(new Headers(preview?.init.headers).get("idempotency-key"), null);

  assert.equal(list?.init.method, "GET");
  assert.equal(list?.url.pathname, base);
  assert.equal(list?.url.searchParams.get("open"), "true");
  assert.equal(list?.url.searchParams.get("limit"), "20");
  assert.equal(list?.url.searchParams.get("offset"), "40");
  assert.equal(list?.init.body, undefined);
  assert.equal(new Headers(list?.init.headers).get("x-grant-token"), null);

  assert.equal(read?.init.method, "GET");
  assert.equal(read?.url.pathname, `${base}/order%2Fwith%20spaces`);
  assert.equal(new Headers(read?.init.headers).get("x-grant-token"), null);

  assert.equal(cancel?.init.method, "POST");
  assert.equal(cancel?.url.pathname, `${base}/order-1/cancel`);
  assert.equal(cancel?.init.body, undefined);
  const cancelHeaders = new Headers(cancel?.init.headers);
  assert.equal(cancelHeaders.get("x-grant-token"), token);
  assert.equal(cancelHeaders.get("idempotency-key"), null);

  assert.equal(cancelAll?.init.method, "POST");
  assert.equal(cancelAll?.url.pathname, `${base}/cancel-all`);
  assert.equal(new Headers(cancelAll?.init.headers).get("x-grant-token"), token);
  assert.equal(new Headers(cancelAll?.init.headers).get("idempotency-key"), null);
  assert.equal(new Headers(noGrant?.init.headers).get("x-grant-token"), null);
});

test("a limit order is funded inside its call, so it gets the settlement budget; its preview and reads do not", async (t) => {
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
  const order = {
    base_asset: "a",
    quote_asset: "b",
    side: "buy" as const,
    quantity: "1",
    price: "1",
  };
  await api.placeLimitOrder(agentId, order, { idempotencyKey: "budgeted-order" });
  await api.placeLimitOrder(agentId, { ...order, dry: true });
  await api.listLimitOrders(agentId);
  await api.cancelLimitOrder(agentId, "order-1");
  assert.deepEqual(budgets, [150_000, 65_000, 65_000, 65_000]);
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
  assert.equal(calls[0]?.headers.get("x-api-key"), apiKey);
  assert.equal(calls[0]?.headers.get("x-grant-token"), null);
  assert.equal(calls[0]?.headers.get("idempotency-key"), null);
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

test("apiKey is an opaque string: any non-empty value is accepted, an empty one is not", () => {
  const baseUrl = "https://api.test";
  for (const key of ["a".repeat(47), "eyJhbGciOiJSUzI1NiJ9.e30.c2ln", "x"])
    assert.doesNotThrow(() => new AgentApi({ baseUrl, apiKey: key }));
  for (const key of ["", "   "])
    assert.throws(
      () => new AgentApi({ baseUrl, apiKey: key }),
      /apiKey must be a non-empty string/,
    );
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
  // Limit orders: a status type, a policy action, quote warning codes and the order's own fields.
  const type: ExecutionType = "limit_order";
  const action: PolicyAction = "limit_order";
  const limitWarnings: QuoteResponse["warnings"][number]["code"][] = [
    "amount_too_low",
    "policy_price_deviation_exceeded",
    "market_price_unavailable",
  ];
  const request: LimitOrderRequest = {
    base_asset: "a",
    quote_asset: "b",
    side: "buy",
    quantity: "1",
    price: "1",
  };
  const order: Pick<LimitOrderView, "order_id" | "fill_status" | "is_payout_status_final"> = {
    order_id: "o",
  };
  const placed: Pick<StatusResponseOf<"limit_order">["details"], "order_id" | "available_amount"> =
    { order_id: "o", available_amount: "1" };
  assert.deepEqual(
    [type, action, request.side, order.order_id, placed.order_id],
    ["limit_order", "limit_order", "buy", "o", "o"],
  );
  assert.equal(limitWarnings.length, 3);
  assert.equal(balance.available_raw, "7");
  assert.equal(warning.length, 5);
  assert.equal(details.amount_out, undefined);
  assert.equal(layers.length, 8);
});
