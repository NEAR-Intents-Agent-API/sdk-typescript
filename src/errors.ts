import type { ApiErrorObject, ErrorDocument } from "./types.js";

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
 * `title` or `detail`. `errors` holds every entry (validation failures return one per field).
 */
export class AgentApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly detail: string | undefined;
  readonly retryable: boolean;
  readonly availableAt: string | undefined;
  readonly requestId: string | undefined;
  readonly errors: ApiErrorObject[];
  readonly idempotencyKey: string | undefined;

  constructor(status: number, document: ErrorDocument | undefined, idempotencyKey?: string) {
    const first = document?.errors?.[0];
    super(first?.detail ?? first?.title ?? `HTTP ${status}`);
    this.name = "AgentApiError";
    this.status = status;
    this.code = first?.code ?? "http_error";
    this.title = first?.title ?? `HTTP ${status}`;
    this.detail = first?.detail;
    this.retryable = first?.meta?.retryable ?? false;
    this.availableAt = first?.meta?.available_at;
    this.requestId = document?.meta?.request_id;
    this.errors = document?.errors ?? [];
    this.idempotencyKey = idempotencyKey;
  }
}
