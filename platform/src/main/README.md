# platform/src/main: composition root and gateway entry points

Status: **IMPLEMENTED_OFFLINE** (local/ci). Every deployed environment is refused.

## Guard first

`buildContainer({ environment, buildBusiness })` loads the reviewed
`platform/config/<environment>.json`, reads the policy bundle and the committed tool
catalogue digest, and runs `assertDeployable` (platform/src/config) with the adapter kinds
the composition would instantiate. A rejected configuration throws
`ConfigurationRejectedError` (reason codes only) before any database, adapter, HTTP server
or port exists (OPS-04; test `buildContainer for committed production config throws
ConfigurationRejectedError before binding any port`).

* **sandbox / staging / production**: refused. The committed files fail the guard today; if
  one passed, the container still refuses with `LIVE_COMPOSITION_NOT_IMPLEMENTED` (live
  database, DynamoDB session store, SQS publisher, S3 audit sink, live business adapters
  and JWKS-backed inbound authentication are not wired; `GATEWAY_INBOUND_AUTH_NOT_CONFIGURED`
  when no `gateway.inboundAuth` section exists). Nothing is simulated in their place.
* **local / ci**: PGlite with every migration, OPA WASM bundle, identity services over LOCAL
  FIXTURE directory/OIDC/notifications and the in-memory session store, audit writer /
  health / query / shipper (LOCAL FIXTURE file sink), action ledger, outbox + dispatcher +
  in-memory publisher, workflow engine, transfer coordinator over the telephony fixture,
  safety pipeline, templates and response gate, knowledge over the SYNTHETIC approved
  corpus, support memory, ops (kill switches, budgets with an ILLUSTRATIVE unapproved
  local budget, capacity, admission), every adapter fixture in the AdapterRegistry, the
  injected business module, the pinned catalogue (must equal `schemas/tools/catalog.json`,
  else `TOOL_CATALOG_DRIFT`), the ToolPipeline and the gateway app.

## Entry points

| File | Use | Binds |
|---|---|---|
| `local.ts` (`pnpm start:local`) | LOCAL FIXTURE gateway + worker loops in one process (PGlite is in-memory) + console API; prints the LOCAL FIXTURE banner with the synthetic integration tokens | 127.0.0.1:8080 (gateway), :8081 (worker health), :8090 (console API) |
| `server.ts` (`node dist/main/server.js`) | Deployed gateway: `VSP_ENVIRONMENT` required, `PORT` (8080), `VSP_MUTATIONS_ENABLED` (default false outside local/ci) | refused outside local/ci; loopback only in local/ci |
| `console.ts` | LOCAL FIXTURE console composition (`ConsoleApiDeps` over the container; workforce SSO is BLOCKED, PRQ-036) | via `local.ts` |
| `fixtures/stub-business.fixture.ts` | LOCAL TEST FIXTURE stub `BusinessModule` for composition tests | — |
| `sessionless-routing.test.ts` | SAFE-02 end to end over this container with the REAL business module: no, expired and revoked sessions over the HTTP tool route and the real MCP SDK client (127.0.0.1); safety/human tools route to an allowlisted destination and are audited, every other tool fails closed | — |

The worker entry point is `platform/src/worker/main.ts`.
