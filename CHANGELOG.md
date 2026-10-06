# Changelog

## Unreleased

`getOperationProof(agentId, correlationId)` returns every audit event of an execution with a
`c2sp.org/tlog-proof@v1` against the notary-signed checkpoint of the API's transparency log, plus
the notary keys and their TDX birth attestation. New types `OperationProof` and `AuditProof`.

## 0.1.1

First release of `@near-intents-agent-api/sdk`: a thin, typed, server-side HTTP client with one
method per endpoint, JSON:API errors, request-local idempotency keys, grant-bound clients
(`forGrant`, `createGrantCredential`) and plain TypeScript types generated from the API's OpenAPI
document. `baseUrl` is optional and defaults to `https://api.agentsonintents.com`. The package ships
no runtime schemas.
