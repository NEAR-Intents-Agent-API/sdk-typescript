import { AgentApiError, requestError } from "./errors.js";
import type { EndpointDefinition } from "./generated/routes.js";
import { endpoints } from "./generated/routes.js";
import { GrantSession } from "./grant-session.js";
import { grantSessionTokenPattern, grantTokenPattern } from "./grants.js";
import { type IdempotentResult, requestIdempotency } from "./idempotency.js";
import { readResponseJson } from "./response-utils.js";
import type {
  AgentPage,
  AgentView,
  ApprovalView,
  BalanceMoveRequest,
  BalanceSource,
  BalancesView,
  CancelAllLimitOrdersResult,
  CancelLimitOrderResult,
  ContainmentView,
  DepositRequest,
  EvmSignIntentRequest,
  EvmSignMessageRequest,
  EvmSignTransactionRequest,
  EvmSignTypedDataRequest,
  GenerateIntentRequest,
  GenerateIntentResponseOf,
  GrantTokenExchangeRequest,
  GrantTokenExchangeResponse,
  GrantView,
  HistoryPage,
  IntentSignature,
  IntentType,
  LimitOrderPage,
  LimitOrderRequest,
  LimitOrderView,
  NativeSignature,
  NearCallRequest,
  NearTransferRequest,
  NetworkView,
  OperationLookup,
  OperationProof,
  PartnerQuotaView,
  PolicyHistoryView,
  PolicyView,
  QuoteResponse,
  ReceiptItem,
  ReceiptPage,
  RecoverRequest,
  ReleaseListView,
  ReleaseView,
  RevokeAllGrantsResult,
  RevokeGrantResult,
  ScheduledPage,
  Signature,
  SignRequest,
  SolanaSignIn,
  SolanaSignInRequest,
  SolanaSignIntentRequest,
  SolanaSignMessageRequest,
  SolanaSignTransactionRequest,
  SolanaSignTransferRequest,
  StatusResponse,
  StatusResponseOf,
  SubjectTokenType,
  SubmitIntentRequest,
  SwapRequest,
  TokenView,
  TransferRequest,
  WalletView,
  WhoamiView,
  WithdrawRequest,
} from "./types.js";
import { createGrantProof, createKeyAssertion, type WorkloadSigner } from "./workload-identity.js";

/** The hosted API. Pass `baseUrl` only for a self-hosted or local deployment. */
export const DEFAULT_BASE_URL = "https://api.agentsonintents.com";

export type AgentApiOptions = {
  /**
   * Partner API key from the partner portal, sent as `X-API-Key`. Treat it as an opaque string.
   * Server-side only: never ship it to a browser.
   */
  apiKey: string;
  /** API origin. Defaults to {@link DEFAULT_BASE_URL}; HTTP is accepted for localhost only. */
  baseUrl?: string;
  /** Per-request timeout. Defaults to 150 s for settlement writes, 65 s otherwise. */
  timeoutMs?: number;
  /** Maximum response body bytes before parsing, including errors. Defaults to 8 MiB. */
  maxResponseBytes?: number;
  /** Custom fetch, e.g. for tests or instrumentation. */
  fetch?: typeof fetch;
  /**
   * Grant token (`ngt_…`) or session token (`ngs_…`) sent as `X-Grant-Token` on delegated calls
   * (swap, withdraw, transfer, shield, limit orders, …). Prefer `api.forGrant(token)`, which
   * returns a separate client per grant.
   */
  grantToken?: string;
};

/**
 * Options of {@link AgentApi.forGrantSession}: where the workload's identity comes from. An
 * `oidc` grant's identity token comes from its platform (`subjectToken`); a `public_key` grant's
 * key signs the assertion itself (`signer`).
 */
export type GrantSessionOptions = {
  /** The grant to open the session on. Needed only when several live grants accept the identity. */
  grantId?: string;
  /**
   * Start exchanging again this many seconds before the session ends. Defaults to 60; a short
   * session starts at mid-life at the earliest (the lead time is at most half its lifetime).
   */
  refreshBeforeSeconds?: number;
} & (
  | {
      /**
       * Returns a current identity token for the grant's audience (`oidcGrantAudience`). It is
       * called for every exchange, so read the platform's token again instead of caching it.
       */
      subjectToken: () => string | Promise<string>;
      /** The JWT type of the subject token. Defaults to `urn:ietf:params:oauth:token-type:jwt`. */
      subjectTokenType?: SubjectTokenType;
      signer?: never;
    }
  | {
      /** Signs a new key assertion for every exchange. */
      signer: WorkloadSigner;
      subjectToken?: never;
      subjectTokenType?: never;
    }
);

/** How a client authenticates its grant, other than a fixed `grantToken`. */
type GrantAuth =
  | { kind: "session"; session: GrantSession }
  | { kind: "proof"; grantId: string; signer: WorkloadSigner };

export type RequestOptions = {
  /** Cancels this request. */
  signal?: AbortSignal;
};

export type IdempotentOptions = RequestOptions & {
  /** Stable key for one logical request. Omission generates a new key; retries must reuse it. */
  idempotencyKey?: string;
};

type Call = {
  params?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  idempotencyKey?: string;
  signal?: AbortSignal;
};

const settlementEndpoints = new Set<EndpointDefinition>([
  endpoints.swap,
  endpoints.placeLimitOrder,
  endpoints.withdraw,
  endpoints.transfer,
  endpoints.shield,
  endpoints.unshield,
]);

/**
 * Settles with `promise`, or rejects with the signal's reason as soon as it aborts, which is what
 * a fetch under that signal rejects with. The promise itself is not cancelled.
 */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** A grant ID as the API issues it: 64 lowercase hex characters. */
function assertGrantId(grantId: string) {
  if (!/^[0-9a-f]{64}$/.test(grantId))
    throw new Error("grantId must be the 64-character hex id of an issued grant");
}

/** `{agent_id}` path segments filled from `params`, each URI-encoded. */
function fillPath(template: string, params: Record<string, string> = {}) {
  return template.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`missing path parameter ${name}`);
    return encodeURIComponent(value);
  });
}

/**
 * Typed client for the NEAR Intents Agent API. One method per endpoint; paths and methods come
 * from the shared endpoint registry, so the client cannot drift from the server.
 *
 * Owner actions follow a generate/submit shape: `generateIntent` returns
 * `intent: { standard, payload }`, your frontend has the owner's wallet sign `payload`
 * unchanged, and `submitIntent` sends the wallet's output back. `getStatus` tracks the result.
 */
export class AgentApi {
  private grantAuth: GrantAuth | undefined;
  private readonly origin: string;
  private readonly fetcher: typeof fetch;
  private readonly maxResponseBytes: number;

  constructor(private readonly options: AgentApiOptions) {
    const url = new URL(options.baseUrl ?? DEFAULT_BASE_URL);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local))
      throw new Error("baseUrl must use HTTPS");
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/")
      throw new Error("baseUrl must be a plain origin");
    if (typeof options.apiKey !== "string" || options.apiKey.trim() === "")
      throw new Error("apiKey must be a non-empty string");
    if (
      options.grantToken !== undefined &&
      !grantTokenPattern.test(options.grantToken) &&
      !grantSessionTokenPattern.test(options.grantToken)
    )
      throw new Error("grantToken is not an ngt_ or ngs_ token");
    const maxResponseBytes =
      options.maxResponseBytes === undefined ? 8 * 1_048_576 : options.maxResponseBytes;
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0)
      throw new RangeError("maxResponseBytes must be a positive safe integer");
    this.origin = url.href.replace(/\/$/, "");
    this.fetcher = options.fetch ?? fetch;
    this.maxResponseBytes = maxResponseBytes;
  }

  getPartnerQuota(options: RequestOptions = {}): Promise<PartnerQuotaView> {
    return this.call(endpoints.getPartnerQuota, options);
  }

  /**
   * The headers of one attempt. Built per attempt because a grant proof is single-use: a retry
   * signs a new one, and the `Idempotency-Key` it repeats is what finds the first attempt. The
   * credential step (an exchange, a signer such as a KMS) runs under the call's `signal`.
   */
  private async headers(
    endpoint: EndpointDefinition,
    call: Call,
    request: { url: URL; body: string | undefined },
    signal: AbortSignal,
  ): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      accept: "application/json",
      "x-api-key": this.options.apiKey,
    };
    if (call.body !== undefined) headers["content-type"] = "application/json";
    if (call.idempotencyKey !== undefined) headers["idempotency-key"] = call.idempotencyKey;
    // Only delegated endpoints receive the grant credential; nothing else needs it.
    if (endpoint.grant)
      Object.assign(headers, await this.grantHeaders(endpoint, call, request, signal));
    return headers;
  }

  /** The grant credential header: a token or a proof, never both (the API refuses both). */
  private async grantHeaders(
    endpoint: EndpointDefinition,
    call: Call,
    request: { url: URL; body: string | undefined },
    signal: AbortSignal,
  ): Promise<Record<string, string>> {
    const auth = this.grantAuth;
    if (auth?.kind === "proof") {
      signal.throwIfAborted();
      const proof = createGrantProof(auth.signer, {
        grantId: auth.grantId,
        method: endpoint.method,
        url: request.url,
        body: request.body,
        idempotencyKey: call.idempotencyKey,
      });
      return { "x-grant-proof": await untilAborted(proof, signal) };
    }
    if (auth?.kind === "session") {
      signal.throwIfAborted();
      // The exchange is shared with other callers, so an abort stops this wait, not the exchange.
      return { "x-grant-token": await untilAborted(auth.session.token(), signal) };
    }
    return this.options.grantToken ? { "x-grant-token": this.options.grantToken } : {};
  }

  /**
   * A session the API no longer knows (its grant was revoked, replaced or expired) would be sent
   * until it ends, so forget it: the next call exchanges again. This request is never repeated.
   */
  private forgetRefusedSession(sent: string | undefined, error: unknown) {
    if (
      this.grantAuth?.kind === "session" &&
      sent !== undefined &&
      error instanceof AgentApiError &&
      (error.status === 401 || error.status === 403) &&
      error.code === "agent_grant_required"
    )
      this.grantAuth.session.invalidate(sent);
  }

  private async call<T>(endpoint: EndpointDefinition, call: Call = {}): Promise<T> {
    const { dry, keyed, idempotencyKey } = requestIdempotency(endpoint, call);
    let sentToken: string | undefined;
    try {
      const url = new URL(`${this.origin}${fillPath(endpoint.path, call.params)}`);
      for (const [key, value] of Object.entries(call.query ?? {}))
        if (value !== undefined) url.searchParams.set(key, String(value));
      // Serialized once: a grant proof signs these exact bytes.
      const body = call.body === undefined ? undefined : JSON.stringify(call.body);
      const settlement = settlementEndpoints.has(endpoint) && !dry;
      // Built first: the timeout and the caller's signal also cover the credential step.
      const signals = [
        AbortSignal.timeout(this.options.timeoutMs ?? (settlement ? 150_000 : 65_000)),
      ];
      if (call.signal) signals.push(call.signal);
      const signal = AbortSignal.any(signals);
      const headers = await this.headers(
        endpoint,
        { ...call, idempotencyKey },
        { url, body },
        signal,
      );
      sentToken = headers["x-grant-token"];
      const response = await this.fetcher(url, {
        method: endpoint.method.toUpperCase(),
        headers,
        body,
        signal,
        redirect: "error",
        credentials: "omit",
      });
      const json = await readResponseJson(response, this.maxResponseBytes, idempotencyKey);
      return keyed && idempotencyKey !== undefined
        ? { ...(json as T), idempotencyKey }
        : (json as T);
    } catch (error) {
      this.forgetRefusedSession(sentToken, error);
      throw requestError(error, idempotencyKey);
    }
  }

  /**
   * A client that runs delegated calls under one owner grant. Keep one per session, assistant or
   * bot: each carries its own token, so concurrent calls never borrow another grant.
   */
  forGrant(grantToken: string): AgentApi {
    return new AgentApi({ ...this.options, grantToken, maxResponseBytes: this.maxResponseBytes });
  }

  /**
   * A client that runs delegated calls under a federated grant (`oidc` or `public_key`) by
   * session. It exchanges the workload's identity for an `ngs_…` session token on the first
   * delegated call, keeps it, and exchanges again shortly before it ends; concurrent calls share
   * one exchange. In the last minute of a session the current token keeps serving while one
   * background exchange runs, so a brief issuer outage costs nothing; a failed exchange is not
   * repeated for a few seconds.
   *
   * Revoking or replacing the grant ends its sessions at once. A delegated call the API then
   * refuses with `agent_grant_required` throws that error, is never repeated, and drops the
   * cached session: the next call exchanges again (and fails the same way if no live grant
   * accepts the identity). The API holds at most 100 live sessions per grant, so keep one client
   * per grant and reuse it; creating one per invocation in a serverless function burns sessions.
   * `signal` and the timeout of each call cover its exchange too.
   */
  forGrantSession(agentId: string, options: GrantSessionOptions): AgentApi {
    if ((options.signer === undefined) === (options.subjectToken === undefined))
      throw new Error("pass exactly one of signer and subjectToken");
    if (options.grantId !== undefined) assertGrantId(options.grantId);
    const refreshBefore = options.refreshBeforeSeconds ?? 60;
    if (!Number.isFinite(refreshBefore) || refreshBefore < 0)
      throw new RangeError("refreshBeforeSeconds must be a non-negative number");
    const exchange = async () =>
      this.exchangeGrantToken(agentId, {
        subject_token: options.signer
          ? await createKeyAssertion(options.signer, { baseUrl: this.origin, agentId })
          : await options.subjectToken(),
        subject_token_type: options.subjectTokenType,
        grant_id: options.grantId,
      });
    return this.withGrantAuth({
      kind: "session",
      session: new GrantSession(exchange, refreshBefore * 1000),
    });
  }

  /**
   * A client that signs every delegated call with the key of a `public_key` grant and sends the
   * proof as `X-Grant-Proof`, so no bearer token exists anywhere. `grantId` is the ID returned when
   * the grant was issued. Each attempt, a retry included, signs a new proof (`signer` runs once
   * per attempt: a cloud KMS bills per signature, so prefer {@link forGrantSession} at high
   * rates) and repeats the same `Idempotency-Key`. This client's `baseUrl` must be the URL the API
   * publishes as `servers[0]`: the proof is addressed to it.
   */
  forGrantProof(options: { grantId: string; signer: WorkloadSigner }): AgentApi {
    assertGrantId(options.grantId);
    return this.withGrantAuth({ kind: "proof", grantId: options.grantId, signer: options.signer });
  }

  private withGrantAuth(auth: GrantAuth): AgentApi {
    const { grantToken: _, ...rest } = this.options;
    const client = new AgentApi({ ...rest, maxResponseBytes: this.maxResponseBytes });
    client.grantAuth = auth;
    return client;
  }

  // ------------------------------------------------------------------------------ owner intents

  /**
   * Builds the payload the owner's wallet must sign for one owner action. Omission generates
   * a new `idempotencyKey`; reuse the response/error key to retry the same intent.
   * Interrupted generation returns
   * `intent_generation_recovery_required` unless a saved payload or complete preparation can
   * recover the original request; the key never
   * starts another builder. Keep that key for recovery.
   */
  generateIntent<T extends IntentType>(
    request: Extract<GenerateIntentRequest, { type: T }>,
    options: IdempotentOptions = {},
  ): Promise<IdempotentResult<GenerateIntentResponseOf<T>>> {
    return this.call(endpoints.generateIntent, { body: request, ...options });
  }

  /** Sends the wallet's output for a generated intent. Resubmitting the same signature is safe. */
  submitIntent<T extends IntentType>(
    request: SubmitIntentRequest & { type: T },
    options: RequestOptions = {},
  ): Promise<StatusResponseOf<T>> {
    return this.call(endpoints.submitIntent, { body: request, ...options });
  }

  /**
   * Status of an intent or execution. `waitMs` (≤ 30 000) long-polls until the status is
   * terminal, needs a signature, or the wait ends.
   */
  getStatus(
    correlationId: string,
    options: RequestOptions & { waitMs?: number; refresh?: boolean } = {},
  ): Promise<StatusResponse> {
    return this.call(endpoints.getStatus, {
      query: { correlation_id: correlationId, wait_ms: options.waitMs, refresh: options.refresh },
      signal: options.signal,
    });
  }

  /**
   * An agent's intents and executions, newest first. Deposit addresses nothing was paid into are
   * left out unless `include_unpaid` is set.
   */
  getHistory(
    agentId: string,
    query: { cursor?: string; limit?: number; include_unpaid?: boolean } = {},
    options: RequestOptions = {},
  ): Promise<HistoryPage> {
    return this.call(endpoints.getHistory, { params: { agent_id: agentId }, query, ...options });
  }

  /**
   * Recovers the correlation ids a request admitted when its response was lost, without sending
   * it again. Pass the original `Idempotency-Key`; the API key alone is enough, no grant. `data`
   * holds the retained matches as history reads them, newest first, read from the API's own
   * records (the provider is not called); a key used under two grants names two executions.
   * `retired` holds the ids whose detail was purged after retention: the key was admitted, its
   * request will not run again, and only the id remains. Follow a `data` entry with `getStatus`.
   *
   * Empty lists are inconclusive, not a "never sent": admission may still be in progress, the API
   * may have refused the request before recording it, or the original grant's id may be
   * unavailable. Only a replay under the same key, body and grant settles it. Dry previews create
   * nothing to look up. The key is 8 to 128 characters of `A-Z a-z 0-9 . _ : -`; the API refuses
   * another shape with a 400.
   */
  lookupOperations(
    agentId: string,
    idempotencyKey: string,
    options: RequestOptions = {},
  ): Promise<OperationLookup> {
    return this.call(endpoints.lookupOperations, {
      params: { agent_id: agentId },
      query: { idempotency_key: idempotencyKey },
      ...options,
    });
  }

  /**
   * Every audit event of one execution, each with a `c2sp.org/tlog-proof@v1` against the latest
   * notary-signed checkpoint of the API's transparency log. An event that checkpoint does not yet
   * cover reads `PENDING`. Send `from_size` (the size of your trusted checkpoint, as a decimal
   * string) to receive a consistency proof from it, which `verifyOperationProof` requires to accept
   * a checkpoint beyond the trusted one.
   */
  getOperationProof(
    agentId: string,
    correlationId: string,
    query: { from_size?: string } = {},
    options: RequestOptions = {},
  ): Promise<OperationProof> {
    return this.call(endpoints.getOperationProof, {
      params: { agent_id: agentId, correlation_id: correlationId },
      query,
      ...options,
    });
  }

  /**
   * The agent's settled transfers, withdrawals, swaps, limit orders and deposits, newest first;
   * `type` keeps one type. Each `PROVEN` item carries a `receipt` anyone checks with
   * `verifyReceipt`, or a payee with `verifyPaymentReceipt`.
   */
  listReceipts(
    agentId: string,
    query: { cursor?: string; limit?: number; type?: ReceiptItem["type"] } = {},
    options: RequestOptions = {},
  ): Promise<ReceiptPage> {
    return this.call(endpoints.listReceipts, {
      params: { agent_id: agentId },
      query,
      ...options,
    });
  }

  /**
   * One settled transfer's, withdrawal's, swap's, limit order's or deposit's receipt. Anything
   * else is 409 `receipt_not_available`; prove it with `getOperationProof`.
   */
  getReceipt(
    agentId: string,
    correlationId: string,
    options: RequestOptions = {},
  ): Promise<ReceiptItem> {
    return this.call(endpoints.getReceipt, {
      params: { agent_id: agentId, correlation_id: correlationId },
      ...options,
    });
  }

  // ------------------------------------------------------------------------------------ agents

  listAgents(
    query: { external_user_id?: string; cursor?: string } = {},
    options: RequestOptions = {},
  ): Promise<AgentPage> {
    return this.call(endpoints.listAgents, { query, ...options });
  }

  getAgent(agentId: string, options: RequestOptions = {}): Promise<AgentView> {
    return this.call(endpoints.getAgent, { params: { agent_id: agentId }, ...options });
  }

  getWallet(agentId: string, options: RequestOptions = {}): Promise<WalletView> {
    return this.call(endpoints.getWallet, { params: { agent_id: agentId }, ...options });
  }

  /**
   * The agent's balances. `source` defaults to `confidential`, the agent's account; pass
   * `source: "public"` to read the legacy public balance, which can only be shielded or withdrawn.
   */
  getBalances(
    agentId: string,
    query: { source?: BalanceSource; asset?: string } = {},
    options: RequestOptions = {},
  ): Promise<BalancesView> {
    return this.call(endpoints.getBalances, { params: { agent_id: agentId }, query, ...options });
  }

  /** Public: every asset agents can use, with chain and USD price. Needs no API key. */
  async getTokens(options: RequestOptions = {}): Promise<TokenView[]> {
    return (await this.call<{ data: TokenView[] }>(endpoints.getTokens, options)).data;
  }

  getPolicy(agentId: string, options: RequestOptions = {}): Promise<PolicyView> {
    return this.call(endpoints.getPolicy, { params: { agent_id: agentId }, ...options });
  }

  getPolicyHistory(
    agentId: string,
    query: { cursor?: number; limit?: number } = {},
    options: RequestOptions = {},
  ): Promise<PolicyHistoryView> {
    return this.call(endpoints.getPolicyHistory, {
      params: { agent_id: agentId },
      query,
      ...options,
    });
  }

  async listGrants(agentId: string, options: RequestOptions = {}): Promise<GrantView[]> {
    return (
      await this.call<{ data: GrantView[] }>(endpoints.listGrants, {
        params: { agent_id: agentId },
        ...options,
      })
    ).data;
  }

  /**
   * Revokes one grant with the API key alone: no owner signature. `revoked_reason` reads
   * `partner_revoked`; the grant's next request is refused with `agent_grant_required` and its
   * sessions end. Work already committed keeps running and is listed in `committed_*`. Revoking a
   * revoked grant returns it unchanged. Freezing the agent stays the owner's.
   */
  revokeGrant(
    agentId: string,
    grantId: string,
    options: RequestOptions = {},
  ): Promise<RevokeGrantResult> {
    return this.call(endpoints.revokeGrant, {
      params: { agent_id: agentId, grant_id: grantId },
      ...options,
    });
  }

  /**
   * Revokes every live grant on the agent with the API key alone, as {@link AgentApi.revokeGrant}
   * does for one. `data` lists the grants this call revoked, newest first; the owner's wallet and
   * policy are untouched.
   */
  revokeAllGrants(agentId: string, options: RequestOptions = {}): Promise<RevokeAllGrantsResult> {
    return this.call(endpoints.revokeAllGrants, { params: { agent_id: agentId }, ...options });
  }

  /**
   * Trades a workload's identity token (an `oidc` grant) or a key assertion (a `public_key`
   * grant) for an `ngs_…` session token, which goes in `X-Grant-Token`. `forGrantSession` does
   * this and renews the session for you. `subject_token_type` defaults to `jwt`; `grant_id` is
   * needed only when several live grants accept the token (`grant_ambiguous`).
   */
  exchangeGrantToken(
    agentId: string,
    request: Pick<GrantTokenExchangeRequest, "subject_token" | "grant_id"> & {
      subject_token_type?: SubjectTokenType;
    },
    options: RequestOptions = {},
  ): Promise<GrantTokenExchangeResponse> {
    return this.call(endpoints.exchangeGrantToken, {
      params: { agent_id: agentId },
      body: {
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: request.subject_token,
        subject_token_type: request.subject_token_type ?? "urn:ietf:params:oauth:token-type:jwt",
        ...(request.grant_id === undefined ? {} : { grant_id: request.grant_id }),
      } satisfies GrantTokenExchangeRequest,
      ...options,
    });
  }

  /** Executions the timelock holds, earliest release first; follow `next_cursor` for more. */
  listScheduledExecutions(
    agentId: string,
    query: { cursor?: string; limit?: number } = {},
    options: RequestOptions = {},
  ): Promise<ScheduledPage> {
    return this.call(endpoints.listScheduledExecutions, {
      params: { agent_id: agentId },
      query,
      ...options,
    });
  }

  getContainment(
    agentId: string,
    query: { grants_cursor?: string; operations_cursor?: string } = {},
    options: RequestOptions = {},
  ): Promise<ContainmentView> {
    return this.call(endpoints.getContainment, {
      params: { agent_id: agentId },
      query,
      ...options,
    });
  }

  /**
   * The agent's pending approvals, at most 100. The API also returns `truncated`, true only when
   * the provider holds more open approvals than the API created; this method returns the list.
   */
  async listApprovals(agentId: string, options: RequestOptions = {}): Promise<ApprovalView[]> {
    return (
      await this.call<{ data: ApprovalView[] }>(endpoints.listApprovals, {
        params: { agent_id: agentId },
        ...options,
      })
    ).data;
  }

  getApproval(
    agentId: string,
    approvalId: string,
    options: RequestOptions = {},
  ): Promise<ApprovalView> {
    return this.call(endpoints.getApproval, {
      params: { agent_id: agentId, approval_id: approvalId },
      ...options,
    });
  }

  getAddress(
    agentId: string,
    chain: "near",
    options: RequestOptions = {},
  ): Promise<{ chain: "near"; address: string; [key: string]: unknown }> {
    return this.call(endpoints.getAddress, { params: { agent_id: agentId, chain }, ...options });
  }

  listProviderRecords(
    agentId: string,
    kind: "requests" | "audit" | "deposits" | "deposit_history",
    query: { limit?: number; offset?: number; type?: string } = {},
    options: RequestOptions = {},
  ): Promise<{ data: unknown }> {
    return this.call(endpoints.listProviderRecords, {
      params: { agent_id: agentId, kind },
      query,
      ...options,
    });
  }

  // -------------------------------------------------------------------------------- executions

  /**
   * Swap assets on the confidential balance. `confidential` defaults to `true`; `false` is
   * refused with `public_balance_exit_only`, `dry` included. `dry: true` returns a quote and
   * needs no idempotency key.
   */
  swap(
    agentId: string,
    request: SwapRequest & { dry: true },
    options?: RequestOptions,
  ): Promise<QuoteResponse>;
  swap(
    agentId: string,
    request: SwapRequest,
    options?: IdempotentOptions,
  ): Promise<IdempotentResult<StatusResponseOf<"swap">>>;
  swap(
    agentId: string,
    request: SwapRequest,
    options: IdempotentOptions = {},
  ): Promise<QuoteResponse | IdempotentResult<StatusResponseOf<"swap">>> {
    return this.call(endpoints.swap, { params: { agent_id: agentId }, body: request, ...options });
  }

  /**
   * Places a resting limit order on the agent's confidential balance and funds it in full.
   * `confidential` defaults to `true`; `false` is refused with `public_balance_exit_only`, `dry`
   * included. The call answers once the order is funded: `SUCCESS` means it rests, not that it filled. Read the order with
   * `details.order_id` through `getLimitOrder`. The policy must allow `limit_order` and price the
   * order within `limit_order.max_deviation_bps` of the market. `dry: true` previews it, listing
   * every rule a live order would fail as a warning; it needs no grant and no idempotency key.
   */
  placeLimitOrder(
    agentId: string,
    request: LimitOrderRequest & { dry: true },
    options?: RequestOptions,
  ): Promise<QuoteResponse>;
  placeLimitOrder(
    agentId: string,
    request: LimitOrderRequest,
    options?: IdempotentOptions,
  ): Promise<IdempotentResult<StatusResponseOf<"limit_order">>>;
  placeLimitOrder(
    agentId: string,
    request: LimitOrderRequest,
    options: IdempotentOptions = {},
  ): Promise<QuoteResponse | IdempotentResult<StatusResponseOf<"limit_order">>> {
    return this.call(endpoints.placeLimitOrder, {
      params: { agent_id: agentId },
      body: request,
      ...options,
    });
  }

  /**
   * The agent's limit orders as the custody provider lists them, newest first. `open: true` lists
   * only orders still resting. A listed order's status is not refreshed: read one with
   * `getLimitOrder` for its live state.
   */
  listLimitOrders(
    agentId: string,
    query: { open?: boolean; limit?: number; offset?: number } = {},
    options: RequestOptions = {},
  ): Promise<LimitOrderPage> {
    return this.call(endpoints.listLimitOrders, {
      params: { agent_id: agentId },
      query,
      ...options,
    });
  }

  /** One order's live state: `fill_status`, `partial_fills`, `payouts` and `is_payout_status_final`. */
  getLimitOrder(
    agentId: string,
    orderId: string,
    options: RequestOptions = {},
  ): Promise<LimitOrderView> {
    return this.call(endpoints.getLimitOrder, {
      params: { agent_id: agentId, order_id: orderId },
      ...options,
    });
  }

  /**
   * Cancels a resting order and refunds what is unfilled to the balance that funded it (the legacy
   * public balance for an order recorded there). Needs a grant but
   * no timelock, schedule or approval, and works while the agent is frozen or the policy no longer
   * allows `limit_order`. The USD budget charged when the order was placed is not given back.
   */
  cancelLimitOrder(
    agentId: string,
    orderId: string,
    options: RequestOptions = {},
  ): Promise<CancelLimitOrderResult> {
    return this.call(endpoints.cancelLimitOrder, {
      params: { agent_id: agentId, order_id: orderId },
      ...options,
    });
  }

  /**
   * Cancels up to 50 resting orders per call; call again until `complete` is true. Needs a grant,
   * with the same exemptions as {@link AgentApi.cancelLimitOrder}.
   */
  cancelAllLimitOrders(
    agentId: string,
    options: RequestOptions = {},
  ): Promise<CancelAllLimitOrdersResult> {
    return this.call(endpoints.cancelAllLimitOrders, {
      params: { agent_id: agentId },
      ...options,
    });
  }

  /**
   * Withdraw to any supported chain. Pays from the confidential balance by default;
   * `confidential: false` pays from the legacy public balance, the one public exit (with
   * `shield`, which moves it to the confidential balance). `dry: true` previews under the grant
   * and an idempotency key, like a withdrawal: the SDK creates one unless passed. An identical
   * preview under the same key replays its result for 60 seconds; after that, preview under a new
   * key.
   */
  withdraw(
    agentId: string,
    request: WithdrawRequest & { dry: true },
    options?: IdempotentOptions,
  ): Promise<IdempotentResult<QuoteResponse>>;
  withdraw(
    agentId: string,
    request: WithdrawRequest,
    options?: IdempotentOptions,
  ): Promise<IdempotentResult<StatusResponseOf<"withdraw">>>;
  withdraw(
    agentId: string,
    request: WithdrawRequest,
    options: IdempotentOptions = {},
  ): Promise<IdempotentResult<QuoteResponse | StatusResponseOf<"withdraw">>> {
    return this.call(endpoints.withdraw, {
      params: { agent_id: agentId },
      body: request,
      ...options,
    });
  }

  /**
   * Transfer from the agent's confidential balance to the recipient's confidential balance.
   * `confidential` defaults to `true`; `false` is refused with `public_balance_exit_only`.
   */
  transfer(
    agentId: string,
    request: TransferRequest,
    options: IdempotentOptions = {},
  ): Promise<IdempotentResult<StatusResponseOf<"transfer">>> {
    return this.call(endpoints.transfer, {
      params: { agent_id: agentId },
      body: request,
      ...options,
    });
  }

  /**
   * Moves an amount from the legacy public balance to the confidential balance. The policy must
   * have `confidential` on. Nothing moves funds back: the public balance can only be shielded or
   * withdrawn with `confidential: false`.
   */
  shield(
    agentId: string,
    request: BalanceMoveRequest,
    options: IdempotentOptions = {},
  ): Promise<IdempotentResult<StatusResponseOf<"shield">>> {
    return this.call(endpoints.shield, {
      params: { agent_id: agentId },
      body: request,
      ...options,
    });
  }

  /**
   * @deprecated The API refuses every unshield with 400 `public_balance_exit_only`, `dry`
   * included, before it reads the body: the confidential balance is the agent's account and only
   * the legacy public balance has an exit. To pay out of the public balance use
   * `withdraw({ confidential: false })`; to move it to the confidential balance use `shield`.
   * Unshields recorded earlier still read through `getStatus` and `getHistory`.
   */
  unshield(
    agentId: string,
    request: BalanceMoveRequest,
    options: IdempotentOptions = {},
  ): Promise<IdempotentResult<StatusResponseOf<"unshield">>> {
    return this.call(endpoints.unshield, {
      params: { agent_id: agentId },
      body: request,
      ...options,
    });
  }

  /**
   * Creates an inbound deposit address that credits the agent's confidential balance; no grant
   * token is needed. `confidential` defaults to `true`; `false` is refused with
   * `public_balance_exit_only`, and a policy without `confidential` refuses the deposit with
   * `policy_action_denied`. Omit `amount` to accept any amount at or above `details.min_amount`;
   * refunds go to the agent.
   */
  deposit(
    agentId: string,
    request: DepositRequest,
    options: IdempotentOptions = {},
  ): Promise<IdempotentResult<StatusResponseOf<"deposit">>> {
    return this.call(endpoints.deposit, {
      params: { agent_id: agentId },
      body: request,
      ...options,
    });
  }

  /** First dispatch of an UNCERTAIN execution that provably never reached the provider. Requires its original key. */
  recover(
    agentId: string,
    request: RecoverRequest,
    options: IdempotentOptions & { idempotencyKey: string },
  ): Promise<IdempotentResult<StatusResponse>> {
    return this.call(endpoints.recover, {
      params: { agent_id: agentId },
      body: request,
      ...options,
    });
  }

  // ------------------------------------------------------------------------------------ native
  // The agent's own NEAR, EVM and Solana keys outside NEAR Intents. Each method needs a grant
  // token, an unfrozen agent and its switch in the policy's `native` block; every request is
  // recorded in history as type `native`.

  /**
   * NEP-413 `signMessage` with the agent's NEAR key: sign the `message`, `recipient` and base64
   * 32-byte `nonce` a dApp sent, and hand it back `near_account_id`, `public_key` and the base64
   * `signature`. The policy's `native.near.sign_message` must list the recipient. `callbackUrl` is
   * not supported. Never signs for `intents.near` or `intents.far`.
   */
  nativeNearSignMessage(
    agentId: string,
    request: SignRequest,
    options: RequestOptions = {},
  ): Promise<Signature> {
    return this.call(endpoints.nativeNearSignMessage, {
      params: { agent_id: agentId },
      body: request,
      ...options,
    });
  }

  /** Sends native NEAR from the agent's NEAR account. Needs `native.near.transfer`. */
  nativeNearTransfer(
    agentId: string,
    request: NearTransferRequest,
    options: IdempotentOptions = {},
  ): Promise<IdempotentResult<StatusResponseOf<"native">>> {
    return this.call(endpoints.nativeNearTransfer, {
      params: { agent_id: agentId },
      body: request,
      ...options,
    });
  }

  /**
   * Calls a NEAR contract from the agent's NEAR account. `native.near.call` must list
   * `receiver_id`; the NEAR Intents contracts are never callable.
   */
  nativeNearCall(
    agentId: string,
    request: NearCallRequest,
    options: IdempotentOptions = {},
  ): Promise<IdempotentResult<StatusResponseOf<"native">>> {
    return this.call(endpoints.nativeNearCall, {
      params: { agent_id: agentId },
      body: request,
      ...options,
    });
  }

  /** Signs EIP-712 typed data as `wallet.evm_account_id`. Needs `native.evm.sign_typed_data`. */
  nativeEvmSignTypedData(
    agentId: string,
    request: EvmSignTypedDataRequest,
    options: RequestOptions = {},
  ): Promise<NativeSignature> {
    return this.call(endpoints.nativeEvmSignTypedData, {
      params: { agent_id: agentId },
      body: request,
      ...options,
    });
  }

  /** Signs a personal message (EIP-191) as `wallet.evm_account_id`. Needs `native.evm.sign_message`. */
  nativeEvmSignMessage(
    agentId: string,
    request: EvmSignMessageRequest,
    options: RequestOptions = {},
  ): Promise<NativeSignature> {
    return this.call(endpoints.nativeEvmSignMessage, {
      params: { agent_id: agentId },
      body: request,
      ...options,
    });
  }

  /**
   * Signs a NEAR Intents payload (canonical JSON text, `transfer` intents only) with the agent's
   * EVM key as ERC-191. Needs `native.evm.sign_intent`: it pays only that rule's `receivers`, and
   * 1Click deposits with `one_click_deposits` or `withdrawals`, each proven by its signed 1Click
   * quote in `one_click_quotes` (checked offline; 1Click is never called). One deposit outside those
   * rules can be paid with `payout_authorization_id`: the `correlation_id` of an owner-signed
   * `payout_authorize` intent, spent by the first deposit whose quote matches its terms.
   * Publish `signed_data` as is.
   * A freeze refuses new payloads but cannot recall one already signed.
   */
  nativeEvmSignIntent(
    agentId: string,
    request: EvmSignIntentRequest,
    options: RequestOptions = {},
  ): Promise<IntentSignature> {
    return this.call(endpoints.nativeEvmSignIntent, {
      params: { agent_id: agentId },
      body: request,
      ...options,
    });
  }

  /** Signs a raw EVM transaction; nothing is broadcast. Needs `native.evm.sign_transaction`. */
  nativeEvmSignTransaction(
    agentId: string,
    request: EvmSignTransactionRequest,
    options: RequestOptions = {},
  ): Promise<NativeSignature> {
    return this.call(endpoints.nativeEvmSignTransaction, {
      params: { agent_id: agentId },
      body: request,
      ...options,
    });
  }

  /**
   * Signs a Sign-In-With-Solana login the API writes from these fields, as
   * `wallet.solana_account_id`. Needs `domain` in `native.solana.sign_in`.
   */
  nativeSolanaSignIn(
    agentId: string,
    request: SolanaSignInRequest,
    options: RequestOptions = {},
  ): Promise<SolanaSignIn> {
    return this.call(endpoints.nativeSolanaSignIn, {
      params: { agent_id: agentId },
      body: request,
      ...options,
    });
  }

  /** Signs a message as `wallet.solana_account_id`. Needs `native.solana.sign_message`. */
  nativeSolanaSignMessage(
    agentId: string,
    request: SolanaSignMessageRequest,
    options: RequestOptions = {},
  ): Promise<NativeSignature> {
    return this.call(endpoints.nativeSolanaSignMessage, {
      params: { agent_id: agentId },
      body: request,
      ...options,
    });
  }

  /**
   * Signs a NEAR Intents payload with the agent's Solana key (raw Ed25519), under
   * `native.solana.sign_intent`, the same rules as {@link AgentApi.nativeEvmSignIntent}.
   */
  nativeSolanaSignIntent(
    agentId: string,
    request: SolanaSignIntentRequest,
    options: RequestOptions = {},
  ): Promise<IntentSignature> {
    return this.call(endpoints.nativeSolanaSignIntent, {
      params: { agent_id: agentId },
      body: request,
      ...options,
    });
  }

  /**
   * Signs a Solana transaction message only if it is one SOL or SPL transfer to `recipient`, which
   * `destinations` must allow; nothing is broadcast. Needs `native.solana.sign_transfer`.
   */
  nativeSolanaSignTransfer(
    agentId: string,
    request: SolanaSignTransferRequest,
    options: RequestOptions = {},
  ): Promise<NativeSignature> {
    return this.call(endpoints.nativeSolanaSignTransfer, {
      params: { agent_id: agentId },
      body: request,
      ...options,
    });
  }

  /** Signs a Solana transaction; nothing is broadcast. Needs `native.solana.sign_transaction`. */
  nativeSolanaSignTransaction(
    agentId: string,
    request: SolanaSignTransactionRequest,
    options: RequestOptions = {},
  ): Promise<NativeSignature> {
    return this.call(endpoints.nativeSolanaSignTransaction, {
      params: { agent_id: agentId },
      body: request,
      ...options,
    });
  }

  // -------------------------------------------------------------------------------------- meta

  getNetwork(options: RequestOptions = {}): Promise<NetworkView> {
    return this.call(endpoints.getNetwork, options);
  }

  /** This deployment's releases, newest first: announced, active, retired and withdrawn. Public. */
  listReleases(options: RequestOptions = {}): Promise<ReleaseListView> {
    return this.call(endpoints.listReleases, options);
  }

  /** The most recently announced release that was not withdrawn. Public. */
  getLatestRelease(options: RequestOptions = {}): Promise<ReleaseView> {
    return this.call(endpoints.getLatestRelease, options);
  }

  getRelease(version: string, options: RequestOptions = {}): Promise<ReleaseView> {
    return this.call(endpoints.getRelease, { params: { version }, ...options });
  }

  whoami(options: RequestOptions = {}): Promise<WhoamiView> {
    return this.call(endpoints.whoami, options);
  }
}

/** Creates a client. Keep the API key on your backend. */
export function createAgentApi(options: AgentApiOptions): AgentApi {
  return new AgentApi(options);
}
