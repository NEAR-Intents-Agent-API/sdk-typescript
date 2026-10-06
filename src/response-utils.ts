import { AgentApiError, AgentApiResponseTooLargeError } from "./errors.js";
import type { ErrorDocument } from "./types.js";

/** Parse a bounded response, preserving HTTP errors even when their body is not JSON. */
export async function readResponseJson(
  response: Response,
  maxResponseBytes: number,
  idempotencyKey?: string,
): Promise<unknown> {
  const text = await readResponseText(response, maxResponseBytes, idempotencyKey);
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch (error) {
    if (response.ok) throw error;
  }
  if (!response.ok)
    throw new AgentApiError(response.status, json as ErrorDocument | undefined, idempotencyKey);
  return json;
}

/** Count bytes before retaining chunks; decode once to preserve Fetch's UTF-8 behavior. */
export async function readResponseText(
  response: Response,
  maxResponseBytes: number,
  idempotencyKey?: string,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxResponseBytes)
        throw new AgentApiResponseTooLargeError(response.status, maxResponseBytes, idempotencyKey);
      chunks.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks, size));
  } finally {
    // Cleanup must not replace the original error or wait for the underlying source to stop.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
