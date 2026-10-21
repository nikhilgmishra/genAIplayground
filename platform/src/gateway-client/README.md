# platform/src/gateway-client: generated client of the gateway HTTP surface

Status: software IMPLEMENTED (WP-07; FO-03-11 rule 1). Unit-tested over a labelled recording HTTP fake
(`client.test.ts`); no caller in the untrusted-output group uses it yet (the harness, models and media packages
are WP-10, WP-08 and WP-11).

The only way the untrusted-output group (models, harness, media) and the HTTP-only clients reach the trusted side
(`platform/architecture/modules.yaml` module `gateway-client`).

| File | Responsibility |
|---|---|
| `operations.generated.ts` | GENERATED from `schemas/openapi/gateway.openapi.json` by `pnpm --filter @vsp/platform openapi:gen` (`src/gateway/generate-openapi.ts`, which holds the client generator): the API version, the digest of the OpenAPI document it was generated from, the component types, and `GATEWAY_OPERATIONS` (method, path, path parameters, declared headers, body requirement and declared response statuses per operation) with request and response body types. `openapi:check` fails when it differs from what the generator would write (`openapi.drift MODIFIED src/gateway-client/operations.generated.ts`). Never edit it by hand. |
| `client.ts` | `GatewayClient.call(operationId, { pathParams, headers, body, timeoutMs })` over an injected `GatewayHttp` port (the caller binds it to its egress-classified transport; the client opens no socket). It refuses, before sending, an undeclared operation, path parameter or header, a missing required header, a path value outside `[A-Za-z0-9._~-]{1,128}`, a body on an operation that takes none or none where one is required, and an invalid credential; after receiving, an undeclared status or malformed JSON. The base URL is https, or http on the loopback interface only. The integration credential is read per call and only placed in the Authorization header; errors (`GatewayClientError`) carry reason codes only. |
| `index.ts` | Public surface. |

```
cd platform
npx tsx src/gateway/generate-openapi.ts          # regenerate the OpenAPI document and this client
npx tsx src/gateway/generate-openapi.ts --check  # drift check (CI)
npx vitest run src/gateway-client
```
