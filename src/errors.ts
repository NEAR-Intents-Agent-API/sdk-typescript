import type { ApiErrorLayer, ApiErrorObject, ErrorDocument } from "./types.js";

/** A transport, cancellation or parsing failure carrying the key of the original request. */
export class AgentApiRequestError extends Error {
  readonly idempotencyKey: string;

  constructor(cause: unknown, idempotencyKey: string) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = cause instanceof Error ? cause.name : "AgentApiRequestError";
    this.idempotencyKey = idempotencyKey;
  }
}

/** Preserve SDK error classes and unkeyed failures; wrap other keyed failures for safe retry. */
export function requestError(error: unknown, idempotencyKey: string | undefined): unknown {
  if (
    idempotencyKey === undefined ||
    error instanceof AgentApiError ||
    error instanceof AgentApiResponseTooLargeError
  )
    return error;
  return new AgentApiRequestError(error, idempotencyKey);
}

/** A success or error body exceeded the client's byte budget before JSON parsing. */
export class AgentApiResponseTooLargeError extends Error {
  readonly code = "response_too_large";
  readonly status: number;
  readonly maxResponseBytes: number;
  readonly idempotencyKey: string | undefined;

  constructor(status: number, maxResponseBytes: number, idempotencyKey?: string) {
    super(`Response exceeds ${maxResponseBytes} bytes`);
    this.name = "AgentApiResponseTooLargeError";
    this.status = status;
    this.maxResponseBytes = maxResponseBytes;
    this.idempotencyKey = idempotencyKey;
  }
}

/**
 * A non-2xx response. `code` is the first error's stable snake_case code; branch on it, never on
 * `title` or `detail`. `layer` says which layer refused (`request`, `auth`, `grant`, `policy`,
 * `budget`, `balance`, `provider` or `api`); it is `undefined` only when the response was not an
 * API error document (for example a proxy's HTML 502). `errors` holds every entry (validation
 * failures return one per field).
 * `retryable` means the identical request under the same Idempotency-Key can succeed after
 * `availableAt` or Retry-After, including a server error whose request may have taken effect.
 * An absent flag proves nothing (it reads `false`), and `false` says only that repeating will not
 * help now, never that nothing was sent: a new key is safe only after a refusal documented as
 * sending nothing. A FAILED or REFUNDED status is not that proof. `minAmount`, on
 * `amount_too_low`, is the route's minimum in atomic units of the asset sent, when the provider
 * states one. `availableAmount`, on `insufficient_balance`, is the balance the request could
 * spend, after queued or timelocked work, in atomic units.
 */
export class AgentApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly layer: ApiErrorLayer | undefined;
  readonly title: string;
  readonly detail: string | undefined;
  readonly retryable: boolean;
  readonly availableAt: string | undefined;
  readonly minAmount: string | undefined;
  readonly availableAmount: string | undefined;
  readonly requestId: string | undefined;
  readonly errors: ApiErrorObject[];
  readonly idempotencyKey: string | undefined;

  constructor(status: number, document: ErrorDocument | undefined, idempotencyKey?: string) {
    const first = document?.errors?.[0];
    super(first?.detail ?? first?.title ?? `HTTP ${status}`);
    this.name = "AgentApiError";
    this.status = status;
    this.code = first?.code ?? "http_error";
    this.layer = first?.layer;
    this.title = first?.title ?? `HTTP ${status}`;
    this.detail = first?.detail;
    this.retryable = first?.meta?.retryable ?? false;
    this.availableAt = first?.meta?.available_at;
    this.minAmount = first?.meta?.min_amount;
    this.availableAmount = first?.meta?.available_amount;
    this.requestId = document?.meta?.request_id;
    this.errors = document?.errors ?? [];
    this.idempotencyKey = idempotencyKey;
  }
}
