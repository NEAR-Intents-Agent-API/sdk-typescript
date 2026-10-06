# Security policy

Please report vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/NEAR-Intents-Agent-API/sdk-typescript/security/advisories/new)
rather than a public issue.

The SDK is a server-side client. It handles partner API keys (`naa_…`) and grant tokens
(`ngt_…`), so keep both on your backend and never ship them to a browser. Reports about key or
token exposure, request-forgery, response-size or timeout handling in this package are in scope.
Vulnerabilities in the API itself are reported through the same channel and forwarded.
