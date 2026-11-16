import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mock, test } from "node:test";
import {
  calculateJwkThumbprintUri,
  compactVerify,
  decodeJwt,
  decodeProtectedHeader,
  importJWK,
} from "jose";
import {
  AgentApi,
  AgentApiError,
  createGrantProof,
  createKeyAssertion,
  createWorkloadKey,
  DEFAULT_BASE_URL,
  type GrantCredentialType,
  type GrantPublicKeyJwk,
  jwkThumbprintUri,
  localJwkSigner,
  type OidcGrantCredential,
  oidcGrantAudience,
  type PublicKeyGrantCredential,
  type WorkloadSigner,
} from "../src/index.js";

const apiKey = "test-partner-api-key";
const agentId = "a".repeat(64);
const grantId = "b".repeat(64);
const baseUrl = "https://api.test";
const sessionToken = `ngs_${"s".repeat(43)}`;
const sha256Hex = (body: string | Uint8Array) => createHash("sha256").update(body).digest("hex");

/** Verifies the JWS with an independent implementation (jose) and returns header and claims. */
async function verified(token: string, publicJwk: GrantPublicKeyJwk) {
  const { payload } = await compactVerify(
    token,
    await importJWK({ ...publicJwk }, publicJwk.kty === "OKP" ? "EdDSA" : "ES256"),
  );
  return {
    header: decodeProtectedHeader(token),
    claims: decodeJwt(token),
    signedPayload: payload,
  };
}

type Call = { url: URL; init: RequestInit; headers: Headers };

/** A fetch that records every call and answers each with `respond`. */
function recordingFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const call = {
      url: new URL(String(input)),
      init: init ?? {},
      headers: new Headers(init?.headers),
    };
    calls.push(call);
    return respond(call);
  };
  return { calls, fetcher };
}

const exchangeResponse = (expiresIn = 900) =>
  Response.json({
    access_token: sessionToken,
    issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
    token_type: "N_A",
    expires_in: expiresIn,
    expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
    grant_id: grantId,
    label: "deploy bot",
  });

const isExchange = (call: Call) => call.url.pathname.endsWith("/grants/token");

for (const alg of ["Ed25519", "P-256"] as const) {
  test(`${alg}: key, thumbprint URI and signer agree with an independent implementation`, async () => {
    const { privateJwk, publicJwk } = createWorkloadKey(alg);
    assert.equal(privateJwk.d.length, 43);
    assert.deepEqual(
      Object.keys(publicJwk).sort(),
      alg === "Ed25519" ? ["crv", "kty", "x"] : ["crv", "kty", "x", "y"],
    );
    assert.equal(jwkThumbprintUri(publicJwk), await calculateJwkThumbprintUri({ ...publicJwk }));

    const signer = localJwkSigner(privateJwk);
    assert.deepEqual(signer.publicJwk, publicJwk);
    const jws = await createKeyAssertion(signer, { baseUrl, agentId });
    const { header, claims } = await verified(jws, publicJwk);
    assert.deepEqual(header, { alg: alg === "Ed25519" ? "EdDSA" : "ES256" });
    const iss = jwkThumbprintUri(publicJwk);
    assert.equal(claims.iss, iss);
    assert.equal(claims.sub, iss);
  });
}

test("thumbprint URI matches the RFC 8037 Ed25519 vector under the RFC 9278 prefix", () => {
  // RFC 8037, appendix A.3: the thumbprint of the appendix A.2 public key.
  assert.equal(
    jwkThumbprintUri({
      kty: "OKP",
      crv: "Ed25519",
      x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
    }),
    "urn:ietf:params:oauth:jwk-thumbprint:sha-256:kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k",
  );
});

test("localJwkSigner refuses a private JWK whose public members are not its own", () => {
  const { privateJwk } = createWorkloadKey("Ed25519");
  const other = createWorkloadKey("Ed25519").publicJwk;
  assert.throws(
    () => localJwkSigner({ ...privateJwk, x: other.x as string }),
    /not the public key/,
  );
  const ec = createWorkloadKey("P-256").privateJwk;
  const otherEc = createWorkloadKey("P-256").publicJwk;
  if (ec.kty !== "EC" || otherEc.kty !== "EC") throw new Error("expected EC keys");
  assert.throws(() => localJwkSigner({ ...ec, y: otherEc.y }), /not the public key/);
});

test("key assertion carries the exchange claims and a new jti every time", async () => {
  const { privateJwk, publicJwk } = createWorkloadKey("Ed25519");
  const signer = localJwkSigner(privateJwk);
  const [first, second] = await Promise.all([
    createKeyAssertion(signer, { baseUrl: "https://api.test/ignored/path?x=1", agentId }),
    createKeyAssertion(signer, { baseUrl: "https://api.test/", agentId }),
  ]);
  const { claims } = await verified(first, publicJwk);
  assert.equal(claims.aud, `https://api.test/v1/agents/${agentId}/grants/token`);
  assert.ok(typeof claims.jti === "string" && claims.jti.length >= 16 && claims.jti.length <= 256);
  assert.ok(claims.iat !== undefined && claims.exp !== undefined);
  assert.ok(claims.exp - claims.iat <= 300);
  assert.notEqual(claims.jti, decodeJwt(second).jti);
});

test("oidcGrantAudience is the origin plus the agent path", () => {
  assert.equal(
    oidcGrantAudience(DEFAULT_BASE_URL, agentId),
    `https://api.agentsonintents.com/v1/agents/${agentId}`,
  );
  assert.equal(
    oidcGrantAudience("http://localhost:3000/", agentId),
    `http://localhost:3000/v1/agents/${agentId}`,
  );
});

test("grant proof signs the exact body bytes, the request URL without query and the key", async () => {
  const { privateJwk, publicJwk } = createWorkloadKey("P-256");
  const signer = localJwkSigner(privateJwk);
  const body = JSON.stringify({ memo: "café ☕", amount: "1" });
  const proof = await createGrantProof(signer, {
    grantId,
    method: "post",
    url: `${baseUrl}/v1/agents/${agentId}/transfer?x=1#frag`,
    body,
    idempotencyKey: "key-1",
  });
  const { claims } = await verified(proof, publicJwk);
  assert.deepEqual(
    { ...claims, jti: undefined, iat: undefined, exp: undefined },
    {
      iss: jwkThumbprintUri(publicJwk),
      sub: jwkThumbprintUri(publicJwk),
      aud: `${baseUrl}/v1/agents/${agentId}/transfer`,
      grant_id: grantId,
      htm: "POST",
      body_sha256: sha256Hex(Buffer.from(body, "utf8")),
      idempotency_key: "key-1",
      jti: undefined,
      iat: undefined,
      exp: undefined,
    },
  );
  assert.ok(claims.exp !== undefined && claims.iat !== undefined && claims.exp - claims.iat <= 300);
});

test("grant proof omits idempotency_key without one and hashes zero bytes without a body", async () => {
  const { privateJwk } = createWorkloadKey("Ed25519");
  const proof = await createGrantProof(localJwkSigner(privateJwk), {
    grantId,
    method: "POST",
    url: new URL(`${baseUrl}/v1/agents/${agentId}/limit-orders/cancel-all`),
  });
  const claims = decodeJwt(proof);
  assert.equal("idempotency_key" in claims, false);
  assert.equal(claims.body_sha256, sha256Hex(""));
  assert.equal(
    claims.body_sha256,
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});

test("a signer that returns DER instead of r || s is refused before anything is sent", async () => {
  const { publicJwk } = createWorkloadKey("P-256");
  const derLike: WorkloadSigner = { publicJwk, sign: () => new Uint8Array(70) };
  await assert.rejects(
    createGrantProof(derLike, {
      grantId,
      method: "POST",
      url: `${baseUrl}/v1/agents/${agentId}/swap`,
    }),
    /64-byte JWS signature/,
  );
});

test("an async signer works like a local one", async () => {
  const { privateJwk, publicJwk } = createWorkloadKey("P-256");
  const local = localJwkSigner(privateJwk);
  const remote: WorkloadSigner = {
    publicJwk,
    sign: async (input) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return local.sign(input);
    },
  };
  const proof = await createGrantProof(remote, {
    grantId,
    method: "POST",
    url: `${baseUrl}/v1/agents/${agentId}/swap`,
  });
  await verified(proof, publicJwk);
});

test("forGrantProof sends X-Grant-Proof, never a token, and only on grant endpoints", async () => {
  const { privateJwk, publicJwk } = createWorkloadKey("Ed25519");
  const { calls, fetcher } = recordingFetch(() => Response.json({}));
  const base = new AgentApi({
    baseUrl,
    apiKey,
    fetch: fetcher,
    grantToken: `ngt_${"t".repeat(43)}`,
  });
  const api = base.forGrantProof({ grantId, signer: localJwkSigner(privateJwk) });
  const request = { recipient: "bob.near", asset: "nep141:wrap.near", amount: "1" };
  await api.transfer(agentId, request, { idempotencyKey: "key-1" });
  await api.getBalances(agentId);

  const [transfer, read] = calls;
  assert.equal(transfer?.headers.get("x-grant-token"), null);
  assert.equal(transfer?.headers.get("x-api-key"), apiKey);
  assert.equal(transfer?.headers.get("idempotency-key"), "key-1");
  const proof = transfer?.headers.get("x-grant-proof");
  assert.ok(proof);
  const { claims } = await verified(proof, publicJwk);
  assert.equal(claims.aud, `${baseUrl}/v1/agents/${agentId}/transfer`);
  assert.equal(claims.htm, "POST");
  assert.equal(claims.grant_id, grantId);
  assert.equal(claims.idempotency_key, "key-1");
  // The hash covers the very string handed to fetch.
  assert.equal(claims.body_sha256, sha256Hex(String(transfer?.init.body)));
  assert.deepEqual(JSON.parse(String(transfer?.init.body)), request);
  assert.equal(read?.headers.get("x-grant-proof"), null);
  assert.equal(read?.headers.get("x-grant-token"), null);
});

test("proofs address the client's own origin, including a local port", async () => {
  const { privateJwk } = createWorkloadKey("Ed25519");
  const { calls, fetcher } = recordingFetch(() => Response.json({}));
  const api = new AgentApi({
    baseUrl: "http://localhost:3000",
    apiKey,
    fetch: fetcher,
  }).forGrantProof({
    grantId,
    signer: localJwkSigner(privateJwk),
  });
  await api.cancelAllLimitOrders(agentId);
  const claims = decodeJwt(calls[0]?.headers.get("x-grant-proof") ?? "");
  assert.equal(claims.aud, `http://localhost:3000/v1/agents/${agentId}/limit-orders/cancel-all`);
  assert.equal(claims.body_sha256, sha256Hex(""));
  assert.equal("idempotency_key" in claims, false);
  assert.equal(calls[0]?.init.body, undefined);
});

test("a retry signs a new proof under the same Idempotency-Key", async () => {
  const { privateJwk } = createWorkloadKey("P-256");
  let attempts = 0;
  const { calls, fetcher } = recordingFetch(() =>
    ++attempts === 1
      ? Response.json(
          {
            errors: [
              {
                code: "provider_unavailable",
                title: "x",
                status: 503,
                layer: "provider",
                retryable: true,
              },
            ],
          },
          { status: 503 },
        )
      : Response.json({}),
  );
  const api = new AgentApi({ baseUrl, apiKey, fetch: fetcher }).forGrantProof({
    grantId,
    signer: localJwkSigner(privateJwk),
  });
  const request = { recipient: "bob.near", asset: "nep141:wrap.near", amount: "1" };
  const first = await api.transfer(agentId, request).catch((error) => error);
  assert.ok(first instanceof AgentApiError);
  const key = first.idempotencyKey;
  assert.ok(key);
  await api.transfer(agentId, request, { idempotencyKey: key });

  const [one, two] = calls.map((call) => decodeJwt(call.headers.get("x-grant-proof") ?? ""));
  assert.equal(calls[0]?.headers.get("idempotency-key"), key);
  assert.equal(calls[1]?.headers.get("idempotency-key"), key);
  assert.equal(one?.idempotency_key, key);
  assert.equal(two?.idempotency_key, key);
  assert.equal(one?.body_sha256, two?.body_sha256);
  assert.notEqual(one?.jti, two?.jti);
  assert.notEqual(calls[0]?.headers.get("x-grant-proof"), calls[1]?.headers.get("x-grant-proof"));
});

test("a signer failure sends nothing and keeps the request's idempotency key", async () => {
  const { publicJwk } = createWorkloadKey("P-256");
  const { calls, fetcher } = recordingFetch(() => Response.json({}));
  const api = new AgentApi({ baseUrl, apiKey, fetch: fetcher }).forGrantProof({
    grantId,
    signer: {
      publicJwk,
      sign: () => {
        throw new Error("kms unavailable");
      },
    },
  });
  await assert.rejects(
    api.transfer(
      agentId,
      { recipient: "bob.near", asset: "near", amount: "1" },
      { idempotencyKey: "k" },
    ),
    (error: Error & { idempotencyKey?: string }) =>
      error.message === "kms unavailable" && error.idempotencyKey === "k",
  );
  assert.equal(calls.length, 0);
});

test("exchangeGrantToken posts the RFC 8693 body with the API key and no grant header", async () => {
  const { calls, fetcher } = recordingFetch(() => exchangeResponse());
  const api = new AgentApi({ baseUrl, apiKey, fetch: fetcher });
  const response = await api.exchangeGrantToken(agentId, {
    subject_token: "a.b.c",
    grant_id: grantId,
  });
  assert.equal(response.access_token, sessionToken);
  assert.equal(calls[0]?.url.pathname, `/v1/agents/${agentId}/grants/token`);
  assert.equal(calls[0]?.init.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: "a.b.c",
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    grant_id: grantId,
  });
  assert.equal(calls[0]?.headers.get("x-api-key"), apiKey);
  assert.equal(calls[0]?.headers.get("x-grant-token"), null);
  assert.equal(calls[0]?.headers.get("idempotency-key"), null);
});

test("forGrant accepts an ngs_ session token and still refuses anything else", () => {
  const api = new AgentApi({ baseUrl, apiKey });
  assert.doesNotThrow(() => api.forGrant(sessionToken));
  assert.throws(() => api.forGrant("ngs_short"), /not an ngt_ or ngs_ token/);
  assert.throws(() => api.forGrant("not-a-token"), /not an ngt_ or ngs_ token/);
});

test("forGrantSession exchanges lazily, once, and sends the session as X-Grant-Token", async () => {
  const { calls, fetcher } = recordingFetch((call) =>
    isExchange(call) ? exchangeResponse() : Response.json({}),
  );
  let minted = 0;
  const api = new AgentApi({ baseUrl, apiKey, fetch: fetcher }).forGrantSession(agentId, {
    grantId,
    subjectToken: () => `identity.token.${++minted}`,
  });
  assert.equal(calls.length, 0);
  await api.getBalances(agentId);
  assert.equal(calls.length, 1, "a call that needs no grant does not exchange");

  const request = { recipient: "bob.near", asset: "nep141:wrap.near", amount: "1" };
  await api.transfer(agentId, request);
  await api.transfer(agentId, request);
  const exchanges = calls.filter(isExchange);
  assert.equal(exchanges.length, 1);
  assert.equal(JSON.parse(String(exchanges[0]?.init.body)).subject_token, "identity.token.1");
  assert.equal(JSON.parse(String(exchanges[0]?.init.body)).grant_id, grantId);
  const transfers = calls.filter((call) => call.url.pathname.endsWith("/transfer"));
  assert.equal(transfers.length, 2);
  for (const call of transfers) {
    assert.equal(call.headers.get("x-grant-token"), sessionToken);
    assert.equal(call.headers.get("x-grant-proof"), null);
  }
});

test("concurrent calls share one in-flight exchange", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { calls, fetcher } = recordingFetch(async (call) => {
    if (isExchange(call)) {
      await gate;
      return exchangeResponse();
    }
    return Response.json({});
  });
  const api = new AgentApi({ baseUrl, apiKey, fetch: fetcher }).forGrantSession(agentId, {
    subjectToken: () => "identity.token.x",
  });
  const request = { recipient: "bob.near", asset: "nep141:wrap.near", amount: "1" };
  const all = Promise.all(Array.from({ length: 5 }, () => api.transfer(agentId, request)));
  await new Promise((resolve) => setTimeout(resolve, 10));
  release();
  await all;
  assert.equal(calls.filter(isExchange).length, 1);
  assert.equal(
    calls.filter((call) => call.headers.get("x-grant-token") === sessionToken).length,
    5,
  );
});

test("the session is exchanged again shortly before it ends", async (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const { calls, fetcher } = recordingFetch((call) =>
    isExchange(call) ? exchangeResponse(900) : Response.json({}),
  );
  let minted = 0;
  const api = new AgentApi({ baseUrl, apiKey, fetch: fetcher }).forGrantSession(agentId, {
    subjectToken: () => `identity.token.${++minted}`,
  });
  const request = { recipient: "bob.near", asset: "nep141:wrap.near", amount: "1" };
  const exchanges = () => calls.filter(isExchange).length;

  await api.transfer(agentId, request);
  mock.timers.tick(838_000);
  await api.transfer(agentId, request);
  assert.equal(exchanges(), 1, "still fresh 62 s before the end");
  mock.timers.tick(2_000);
  await api.transfer(agentId, request);
  assert.equal(exchanges(), 2, "60 s before the end it renews");
  assert.equal(
    JSON.parse(String(calls.filter(isExchange)[1]?.init.body)).subject_token,
    "identity.token.2",
  );
});

test("a session shorter than the refresh margin renews at half its life, not on every call", async (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const { calls, fetcher } = recordingFetch((call) =>
    isExchange(call) ? exchangeResponse(20) : Response.json({}),
  );
  const api = new AgentApi({ baseUrl, apiKey, fetch: fetcher }).forGrantSession(agentId, {
    subjectToken: () => "identity.token.x",
  });
  const request = { recipient: "bob.near", asset: "nep141:wrap.near", amount: "1" };
  await api.transfer(agentId, request);
  mock.timers.tick(9_000);
  await api.transfer(agentId, request);
  assert.equal(calls.filter(isExchange).length, 1);
  mock.timers.tick(1_500);
  await api.transfer(agentId, request);
  assert.equal(calls.filter(isExchange).length, 2);
});

test("refreshBeforeSeconds moves the renewal point and is validated", async (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const { calls, fetcher } = recordingFetch((call) =>
    isExchange(call) ? exchangeResponse(900) : Response.json({}),
  );
  const base = new AgentApi({ baseUrl, apiKey, fetch: fetcher });
  assert.throws(
    () => base.forGrantSession(agentId, { subjectToken: () => "x", refreshBeforeSeconds: -1 }),
    RangeError,
  );
  const api = base.forGrantSession(agentId, {
    subjectToken: () => "x.y.z",
    refreshBeforeSeconds: 300,
  });
  const request = { recipient: "bob.near", asset: "nep141:wrap.near", amount: "1" };
  await api.transfer(agentId, request);
  mock.timers.tick(599_000);
  await api.transfer(agentId, request);
  assert.equal(calls.filter(isExchange).length, 1);
  mock.timers.tick(2_000);
  await api.transfer(agentId, request);
  assert.equal(calls.filter(isExchange).length, 2);
});

test("a failed exchange is not kept: the API's error surfaces, and the next try follows the backoff", async (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  let exchanges = 0;
  const { calls, fetcher } = recordingFetch((call) => {
    if (!isExchange(call)) return Response.json({});
    return ++exchanges === 1
      ? Response.json(
          {
            errors: [
              { code: "subject_token_invalid", title: "Invalid", status: 401, layer: "auth" },
            ],
          },
          { status: 401 },
        )
      : exchangeResponse();
  });
  const api = new AgentApi({ baseUrl, apiKey, fetch: fetcher }).forGrantSession(agentId, {
    subjectToken: () => "identity.token.x",
  });
  const request = { recipient: "bob.near", asset: "nep141:wrap.near", amount: "1" };
  const invalid = (error: unknown) =>
    error instanceof AgentApiError && error.code === "subject_token_invalid";
  await assert.rejects(api.transfer(agentId, request), invalid);
  await assert.rejects(api.transfer(agentId, request), invalid);
  assert.equal(exchanges, 1, "no second exchange inside the backoff");
  assert.equal(calls.filter((call) => call.url.pathname.endsWith("/transfer")).length, 0);
  mock.timers.tick(5_000);
  await api.transfer(agentId, request);
  assert.equal(exchanges, 2);
});

test("a key-bound session signs a fresh assertion for every exchange", async (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const { privateJwk, publicJwk } = createWorkloadKey("P-256");
  const { calls, fetcher } = recordingFetch((call) =>
    isExchange(call) ? exchangeResponse(120) : Response.json({}),
  );
  const api = new AgentApi({ baseUrl, apiKey, fetch: fetcher }).forGrantSession(agentId, {
    signer: localJwkSigner(privateJwk),
  });
  const request = { recipient: "bob.near", asset: "nep141:wrap.near", amount: "1" };
  await api.transfer(agentId, request);
  mock.timers.tick(100_000);
  await api.transfer(agentId, request);

  const [one, two] = calls.filter(isExchange).map((call) => JSON.parse(String(call.init.body)));
  assert.equal(one.subject_token_type, "urn:ietf:params:oauth:token-type:jwt");
  const first = await verified(one.subject_token, publicJwk);
  assert.equal(first.claims.aud, `${baseUrl}/v1/agents/${agentId}/grants/token`);
  assert.equal(first.claims.iss, jwkThumbprintUri(publicJwk));
  assert.notEqual(first.claims.jti, decodeJwt(two.subject_token).jti);
});

test("a grant client derived from a session client carries no other grant credential", async () => {
  const { privateJwk } = createWorkloadKey("Ed25519");
  const { calls, fetcher } = recordingFetch((call) =>
    isExchange(call) ? exchangeResponse() : Response.json({}),
  );
  const session = new AgentApi({ baseUrl, apiKey, fetch: fetcher }).forGrantSession(agentId, {
    subjectToken: () => "identity.token.x",
  });
  const proof = session.forGrantProof({ grantId, signer: localJwkSigner(privateJwk) });
  await proof.transfer(agentId, { recipient: "bob.near", asset: "near", amount: "1" });
  assert.equal(calls.filter(isExchange).length, 0);
  assert.equal(calls[0]?.headers.get("x-grant-token"), null);
  assert.ok(calls[0]?.headers.get("x-grant-proof"));
});

test("grant_issue takes the federated credentials as typed objects", async () => {
  const { calls, fetcher } = recordingFetch(() => Response.json({}));
  const api = new AgentApi({ baseUrl, apiKey, fetch: fetcher });
  const { publicJwk } = createWorkloadKey("P-256");
  const issue = {
    type: "grant_issue",
    agent_id: agentId,
    label: "bot",
    expires_at: "2027-01-01T00:00:00.000Z",
  } as const;
  const oidc: OidcGrantCredential = {
    type: "oidc",
    issuer: "https://token.actions.githubusercontent.com",
    claims: { repository_owner_id: "1", repository_id: "2", environment: "production" },
  };
  const key: PublicKeyGrantCredential = { type: "public_key", jwk: publicJwk };
  await api.generateIntent({ ...issue, credential: oidc });
  await api.generateIntent({ ...issue, credential: key });
  assert.deepEqual(
    calls.map((call) => JSON.parse(String(call.init.body)).credential),
    [oidc, key],
  );
  const kinds: GrantCredentialType[] = ["token", "oidc", "public_key"];
  assert.equal(kinds.length, 3);
});

const transferRequest = { recipient: "bob.near", asset: "nep141:wrap.near", amount: "1" };
const unavailable = () =>
  Response.json(
    { errors: [{ code: "issuer_unavailable", title: "Unavailable", status: 503, layer: "auth" }] },
    { status: 503 },
  );
const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

test("an exchange that fails while the session is still valid costs nothing", async (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  let down = false;
  let n = 0;
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));
  const { calls, fetcher } = recordingFetch((call) => {
    if (!isExchange(call)) return Response.json({});
    return down ? unavailable() : exchangeResponse(900);
  });
  const api = new AgentApi({ baseUrl, apiKey, fetch: fetcher }).forGrantSession(agentId, {
    subjectToken: () => `identity.token.${++n}`,
  });
  const exchanges = () => calls.filter(isExchange).length;
  await api.transfer(agentId, transferRequest);
  down = true;

  mock.timers.tick(845_000); // 55 s left
  await api.transfer(agentId, transferRequest);
  await flush();
  assert.equal(exchanges(), 2, "one background exchange was tried");
  assert.equal(calls.at(-1)?.headers.get("x-grant-token"), sessionToken);

  mock.timers.tick(1_000);
  await api.transfer(agentId, transferRequest);
  await flush();
  assert.equal(exchanges(), 2, "backed off: no exchange per call during an outage");

  mock.timers.tick(5_000);
  await api.transfer(agentId, transferRequest);
  await flush();
  assert.equal(exchanges(), 3, "tries again after the backoff");

  // Past the session's end the failure surfaces.
  mock.timers.tick(60_000);
  await assert.rejects(
    api.transfer(agentId, transferRequest),
    (error) => error instanceof AgentApiError && error.code === "issuer_unavailable",
  );
  await assert.rejects(api.transfer(agentId, transferRequest), AgentApiError);
  assert.equal(exchanges(), 4, "a call inside the backoff fails without another exchange");

  down = false;
  mock.timers.tick(5_000);
  await api.transfer(agentId, transferRequest);
  assert.equal(exchanges(), 5);
  await flush();
  assert.deepEqual(unhandled, []);
});

test("a session the API refuses is dropped, the request is not repeated, the next call exchanges", async () => {
  let exchanges = 0;
  let revoked = false;
  const { calls, fetcher } = recordingFetch((call) => {
    if (isExchange(call)) {
      exchanges += 1;
      revoked = false;
      return exchangeResponse();
    }
    return revoked
      ? Response.json(
          {
            errors: [
              {
                code: "agent_grant_required",
                title: "Grant required",
                status: 403,
                layer: "grant",
              },
            ],
          },
          { status: 403 },
        )
      : Response.json({});
  });
  const api = new AgentApi({ baseUrl, apiKey, fetch: fetcher }).forGrantSession(agentId, {
    subjectToken: () => "identity.token.x",
  });
  await api.transfer(agentId, transferRequest);
  revoked = true;
  await assert.rejects(
    api.transfer(agentId, transferRequest),
    (error) => error instanceof AgentApiError && error.code === "agent_grant_required",
  );
  const transfers = () => calls.filter((call) => call.url.pathname.endsWith("/transfer")).length;
  assert.equal(transfers(), 2, "the refused request is not retried");
  assert.equal(exchanges, 1);
  await api.transfer(agentId, transferRequest);
  assert.equal(exchanges, 2);
  assert.equal(transfers(), 3);
});

test("other refusals keep the session", async () => {
  let exchanges = 0;
  const { fetcher } = recordingFetch((call) => {
    if (isExchange(call)) {
      exchanges += 1;
      return exchangeResponse();
    }
    return Response.json(
      { errors: [{ code: "policy_action_denied", title: "Denied", status: 403, layer: "policy" }] },
      { status: 403 },
    );
  });
  const api = new AgentApi({ baseUrl, apiKey, fetch: fetcher }).forGrantSession(agentId, {
    subjectToken: () => "identity.token.x",
  });
  await assert.rejects(api.transfer(agentId, transferRequest), AgentApiError);
  await assert.rejects(api.transfer(agentId, transferRequest), AgentApiError);
  assert.equal(exchanges, 1);
});

test("an aborted call stops waiting for a hanging exchange or signer, keeping its key", async () => {
  const hang: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });
  const { publicJwk } = createWorkloadKey("P-256");
  const clients = {
    session: new AgentApi({ baseUrl, apiKey, fetch: hang }).forGrantSession(agentId, {
      subjectToken: () => "identity.token.x",
    }),
    proof: new AgentApi({ baseUrl, apiKey, fetch: hang }).forGrantProof({
      grantId,
      signer: { publicJwk, sign: () => new Promise<Uint8Array>(() => undefined) },
    }),
  };
  for (const api of Object.values(clients)) {
    const controller = new AbortController();
    const call = api.transfer(agentId, transferRequest, {
      idempotencyKey: "k-1",
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(
      call,
      (error: Error & { idempotencyKey?: string }) =>
        error.name === "AbortError" && error.idempotencyKey === "k-1",
    );
    await assert.rejects(
      api.transfer(agentId, transferRequest, { signal: AbortSignal.abort() }),
      (error: Error) => error.name === "AbortError",
    );
  }
});

test("the call's timeout covers the credential step", async () => {
  const { publicJwk } = createWorkloadKey("P-256");
  const { calls, fetcher } = recordingFetch(() => Response.json({}));
  const api = new AgentApi({ baseUrl, apiKey, fetch: fetcher, timeoutMs: 20 }).forGrantProof({
    grantId,
    signer: { publicJwk, sign: () => new Promise<Uint8Array>(() => undefined) },
  });
  await assert.rejects(
    api.transfer(agentId, transferRequest, { idempotencyKey: "k-2" }),
    (error: Error & { idempotencyKey?: string }) =>
      error.name === "TimeoutError" && error.idempotencyKey === "k-2",
  );
  assert.equal(calls.length, 0);
});

test("an abort does not cancel the exchange other callers share", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { calls, fetcher } = recordingFetch(async (call) => {
    if (!isExchange(call)) return Response.json({});
    await gate;
    return exchangeResponse();
  });
  const api = new AgentApi({ baseUrl, apiKey, fetch: fetcher }).forGrantSession(agentId, {
    subjectToken: () => "identity.token.x",
  });
  const controller = new AbortController();
  const aborted = api.transfer(agentId, transferRequest, { signal: controller.signal });
  const patient = api.transfer(agentId, transferRequest);
  await flush();
  controller.abort();
  await assert.rejects(aborted, (error: Error) => error.name === "AbortError");
  release();
  await patient;
  assert.equal(calls.filter(isExchange).length, 1);
});

test("grant IDs are checked locally and a session needs exactly one identity source", () => {
  const api = new AgentApi({ baseUrl, apiKey });
  const { privateJwk } = createWorkloadKey("Ed25519");
  const signer = localJwkSigner(privateJwk);
  assert.throws(() => api.forGrantProof({ grantId: "nope", signer }), /grantId/);
  assert.throws(() => api.forGrantSession(agentId, { signer, grantId: "B".repeat(64) }), /grantId/);
  assert.throws(
    () => api.forGrantSession(agentId, { signer, subjectToken: () => "x.y.z" } as never),
    /exactly one/,
  );
  assert.throws(() => api.forGrantSession(agentId, {} as never), /exactly one/);
});
