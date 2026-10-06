import { type EndpointDefinition, endpoints } from "./generated/routes.js";

/** Creates a key for one logical request. Save it before sending when recovery must survive a restart. */
export function createIdempotencyKey(): string {
  return crypto.randomUUID();
}

/** The API response plus the SDK's effective request key. Reuse this key for retries. */
export type IdempotentResult<T> = T & { idempotencyKey: string };

/** Resolve one request's identity before dispatch; recovery must use its existing key. */
export function requestIdempotency(
  endpoint: EndpointDefinition,
  call: { body?: unknown; idempotencyKey?: string },
) {
  const dry =
    (endpoint === endpoints.swap || endpoint === endpoints.withdraw) &&
    (call.body as { dry?: boolean } | undefined)?.dry === true;
  const keyed = Boolean(endpoint.idempotency) && !dry;
  const idempotencyKey =
    keyed && endpoint !== endpoints.recover && call.idempotencyKey === undefined
      ? createIdempotencyKey()
      : call.idempotencyKey;
  return { dry, keyed, idempotencyKey };
}
