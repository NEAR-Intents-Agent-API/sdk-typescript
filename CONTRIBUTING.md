# Contributing

Thanks for helping with the TypeScript SDK for the NEAR Intents Agent API.

## Setup

Requires Node 24+ and pnpm.

```sh
pnpm install
pnpm check   # lint, typecheck + build, unit tests
```

## What lives here

- `src/client.ts`, `errors.ts`, `idempotency.ts`, `grants.ts`, `response-utils.ts`: the
  hand-written client. Behaviour changes (idempotency, timeouts, errors, grant handling) belong
  here and need tests in `tests/`.
- `src/types.ts`: the public names for the wire types.
- `src/generated/`: **generated, never edit by hand.** `api.d.ts` (request and response types) and
  `routes.ts` (method, path and idempotency of every endpoint) are produced from the API's OpenAPI
  document. A pull request that edits them directly will not be merged; if a type is wrong or
  missing, open an issue describing the API response and we will fix it at the source.

The SDK ships no runtime schemas. To validate responses or generate a client in another language,
generate it from `GET /openapi.json` on the API.

## Pull requests

- Keep the SDK a thin client: no wallet signers, React hooks, workflow engine or automatic retries.
- Never retry a write under a new `Idempotency-Key`; an unknown outcome must stay observable.
- Add or update tests for changed behaviour, and update `README.md` and `CHANGELOG.md`.
- `pnpm check` must pass.

## Releases

Maintainers bump `version` in `package.json`, update `CHANGELOG.md`, and push a tag `v<version>`.
The release workflow publishes with npm trusted publishing; pre-release versions (`0.2.0-beta.1`)
go to the `next` dist-tag.
