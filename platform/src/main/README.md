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

## Wiring (wave 4)

* **Workflow engine** with `grantStore: PgDurableGrantStore` (durable action grants, spec section 7)
  and the shared `metrics` (`vsp_grant_checks_total`). The grant store is also passed to the
  business layer (`ToolDeps.grants`), which issues a grant inside the transaction that accepts
  durable work (billing review commit or its reconciled follow-up, partner onboarding, complaint
  review) and passes the `grantRef` to `WorkflowEngine.start`.
* **Retention** uses `createPlatformDatasetRegistry()` (support memory, the 0300 support records,
  tool-request and console idempotency). Migration `0910_worker_privileges.sql` gives `app_worker`
  key-column SELECT + DELETE (tenant RLS) on `console_idempotency` and INSERT on
  `durable_action_grants` (the reconciled billing follow-up runs as the worker).
* **Outbox dispatcher** `instanceId` from `ContainerOptions.instanceId`, else `VSP_INSTANCE_ID`,
  else `local-1` (audit stream `outbox.<instanceId>`).
* **Handoff index**: every handoff the HandoffService returns (telephony-control, MCP/HTTP tools
  with or without a session, console) is recorded through `ToolDeps.handoffObserver`, so TC-12
  and TC-11 see session-less MCP handoffs too.
* **Call outcome evidence** (`CallOutcomeTracker`): the pipeline records per call whether an
  informational read succeeded or a policy decision denied a request; TC-11 combines it with the
  ledger (`listForSession` COMMITTED receipts), `SupportRequestService.listForCall`
  (REQUEST_ACCEPTED) and the transfer journey (TRANSFERRED only after caller-confirmed connection).
* **Safety evidence**: the screening route records `safety_events` (validated signal, route
  initiation with time to route) through `SafetyEventRecorder`, after the route was requested.
* **Confirmation prompts** (TC-07) use `BusinessModule.confirmationSlots` (typed slot values from
  the authoritative prepared action / system of record).
* **Metrics** reach the response gates (`vsp_voice_gate_*`) and support memory
  (`vsp_memory_recap_withheld_total`); knowledge ingestion/search counters are emitted by
  `KnowledgeServicePg` with the container's metrics. The privacy `EgressGuard` and
  `RedactionService` emit their counters when given `metrics`, but neither is composed here yet.
* **Console**: `ConsoleApiDeps.reconciledRetry` = `LedgerReconciledRetry(c.actions, c.business.providers)`.

## End-to-end journeys

`platform/test/journeys/` drives this composition over its real HTTP surface (see the README
there): the nine required demonstration journeys and the injected faults of spec section 16.
