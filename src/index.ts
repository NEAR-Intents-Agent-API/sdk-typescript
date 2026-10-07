export {
  AgentApi,
  type AgentApiOptions,
  createAgentApi,
  DEFAULT_BASE_URL,
  type IdempotentOptions,
  type RequestOptions,
} from "./client.js";
export {
  AgentApiError,
  AgentApiRequestError,
  AgentApiResponseTooLargeError,
} from "./errors.js";
export { NoteError } from "./generated/transparency/note.js";
export {
  type OperationProofDocument,
  type ProvenEvent,
  type VerifiedOperation,
  verifyOperationProof,
} from "./generated/transparency/operation-proof.js";
export { ProofError } from "./generated/transparency/verify.js";
export {
  createGrantCredential,
  type GrantCredential,
  grantCommitment,
} from "./grants.js";
export { createIdempotencyKey, type IdempotentResult } from "./idempotency.js";
export type * from "./types.js";
