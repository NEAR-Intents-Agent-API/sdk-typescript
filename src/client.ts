import { requestError } from "./errors.js";
import type { EndpointDefinition } from "./generated/routes.js";
import { endpoints } from "./generated/routes.js";
import { grantTokenPattern } from "./grants.js";
import { type IdempotentResult, requestIdempotency } from "./idempotency.js";
import { readResponseJson } from "./response-utils.js";
import type {
  AgentPage,
  AgentView,
  ApprovalView,
  BalanceMoveRequest,
  BalanceSource,
  BalancesView,
  ContainmentView,
  DepositRequest,
  EvmSignMessageRequest,
  EvmSignTransactionRequest,
  EvmSignTypedDataRequest,
  GenerateIntentRequest,
  GenerateIntentResponseOf,
  GrantView,
  HistoryPage,
  IntentType,
  NativeSignature,
  NearCallRequest,
  NearTransferRequest,
  NetworkView,
  OperationProof,
  PartnerQuotaView,
  PolicyHistoryView,
  PolicyView,
  QuoteResponse,
  RecoverRequest,
  ReleaseListView,
  ReleaseView,
  ScheduledPage,
  Signature,
  SignRequest,
  SolanaSignMessageRequest,
  SolanaSignTransactionRequest,
  StatusResponse,
  StatusResponseOf,
  SubmitIntentRequest,
  SwapRequest,
  TokenView,
  TransferRequest,
  WalletView,
  WhoamiView,
  WithdrawRequest,
} from "./types.js";

/** The hosted API. Pass `baseUrl` only for a self-hosted or local deployment. */
export const DEFAULT_BASE_URL = "https://api.agentsonintents.com";

export type AgentApiOptions = {
  /** Partner API key (`naa_…`). Server-side only: never ship it to a browser. */
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
   * Grant token (`ngt_…`) sent as `X-Grant-Token` on delegated calls (swap, withdraw, transfer,
   * shield, …). Prefer `api.forGrant(token)`, which returns a separate client per grant.
   */
  grantToken?: string;
};

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
  endpoints.withdraw,
  endpoints.transfer,
  endpoints.shield,
  endpoints.unshield,
]);

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
    if (!/^naa_[A-Za-z0-9_-]{43}$/.test(options.apiKey))
      throw new Error("apiKey is not a naa_ key");
    if (options.grantToken !== undefined && !grantTokenPattern.test(options.grantToken))
      throw new Error("grantToken is not an ngt_ token");
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

  private headers(endpoint: EndpointDefinition, call: Call): Record<string, string> {
    const headers: Record<string, string> = {
      accept: "application/json",
      "x-api-key": this.options.apiKey,
    };
    if (call.body !== undefined) headers["content-type"] = "application/json";
    if (call.idempotencyKey !== undefined) headers["idempotency-key"] = call.idempotencyKey;
    // Only delegated endpoints receive the grant token; nothing else needs it.
    if (endpoint.grant && this.options.grantToken)
      headers["x-grant-token"] = this.options.grantToken;
    return headers;
  }

  private async call<T>(endpoint: EndpointDefinition, call: Call = {}): Promise<T> {
    const { dry, keyed, idempotencyKey } = requestIdempotency(endpoint, call);
    try {
      const url = new URL(`${this.origin}${fillPath(endpoint.path, call.params)}`);
      for (const [key, value] of Object.entries(call.query ?? {}))
        if (value !== undefined) url.searchParams.set(key, String(value));
      const headers = this.headers(endpoint, { ...call, idempotencyKey });
      const settlement = settlementEndpoints.has(endpoint) && !dry;
      const signals = [
        AbortSignal.timeout(this.options.timeoutMs ?? (settlement ? 150_000 : 65_000)),
      ];
      if (call.signal) signals.push(call.signal);
      const response = await this.fetcher(url, {
        method: endpoint.method.toUpperCase(),
        headers,
        body: call.body === undefined ? undefined : JSON.stringify(call.body),
        signal: AbortSignal.any(signals),
        redirect: "error",
        credentials: "omit",
      });
      const json = await readResponseJson(response, this.maxResponseBytes, idempotencyKey);
      return keyed && idempotencyKey !== undefined
        ? { ...(json as T), idempotencyKey }
        : (json as T);
    } catch (error) {
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
   * Every audit event of one execution, each with a `c2sp.org/tlog-proof@v1` against the latest
   * notary-signed checkpoint of the API's transparency log. An event that checkpoint does not yet
   * cover reads `PENDING`. `from_size` is the size of the checkpoint you trust: the proof then
   * carries the consistency path from it.
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

  /** Swap assets. `dry: true` returns a quote and needs no idempotency key. */
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
   * Withdraw to any supported chain. `dry: true` previews under the grant and an idempotency key,
   * like a withdrawal: the SDK creates one unless passed. An identical preview under the same key
   * replays its result for 60 seconds; after that, preview under a new key.
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
   * Creates an inbound public or confidential deposit address; no grant token is needed. Omit
   * `amount` to accept any amount at or above `details.min_amount`; refunds go to the agent.
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
