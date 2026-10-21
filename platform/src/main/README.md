# platform/src/main: composition roots and entry points

Two composition roots, never mixed ([ADR-0023](../../../docs/adr/ADR-0023-live-composition-root.md)):

| Root | Environments | What it composes | Status |
|---|---|---|---|
| `container.ts` `buildContainer` (regression composition) | local, ci (refuses every other environment) | PGlite, LOCAL FIXTURE adapters, the in-memory session store, the process-local deferred-audit queue; metrics against the composed catalogue (`createPlatformMetricCatalogue`, as the live root) | IMPLEMENTED (regression profile, FO-00-36, FO-22-21) |
| `live-container.ts` `buildLiveContainer` (+ `live-modules.ts`) | sandbox, staging, production (refuses local and ci) | real adapters only; every capability without its live adapter or tenant inputs NOT_CONFIGURED | IMPLEMENTED; Layer 2 against the local emulators (`platform/test/integration/composition/`); environment NOT_CONFIGURED |

## Live composition (WP-07)

Order, and nothing is constructed before the guard accepts the configuration (OPS-04):

1. configuration (`platform/config/<environment>.json`) and the infrastructure environment (`VSP_*` variables,
   `config/loader.ts`); AWS clients from `infrastructure.aws` (`adapters/live/aws-clients.ts`: endpoint
   overrides only in sandbox and only for emulator hosts; elsewhere `INFRASTRUCTURE_ENDPOINT_OVERRIDE_FORBIDDEN`
   before any client exists);
2. the pinned policy bundle, the committed tool catalogue digest and the approval trust key from KMS only
   (`KmsTrustedKeyResolver`; FO-14-56), the runtime signing keys' public keys for the key separation check
   (`KmsRuntimeSigningKeyResolver`: key ARN, bare key id or mrk- id; one it cannot resolve refuses the unit,
   `RUNTIME_SIGNING_KEY_UNRESOLVED`), the connector credential sets and the committed key sets of the other
   environments (`live-modules.ts`; a committed file that does not parse with a valid environment refuses the unit,
   `COMMITTED_CONFIG_UNREADABLE@configDir.<name>`), then the deployment guard (`config/guard.ts`, rule files under
   `config/rules/`): blocking violations refuse the process, capability violations make their capability
   NOT_CONFIGURED;
3. substrate: PostgreSQL (`PgPoolDb` from the Secrets Manager database secret; the schema must be current,
   `SCHEMA_MIGRATIONS_PENDING`), the DynamoDB session store, the SQS outbox publisher, the KMS assertion signer,
   the durable deferred-audit queue with the independent DynamoDB route-audit journal, the egress guard and ONE
   egress-classified connector transport (`ConnectorHttpTransport`) that every outbound client uses (inbound
   JWKS, caller and workforce IdPs, Salesforce, OTLP). Sandbox only: `network.resolve` and `network.tlsCa`
   for emulated vendor hosts;
4. capabilities and the activation map (`capabilities.ts`): each runtime capability is CONFIGURED or
   NOT_CONFIGURED with guard and composition reason codes, software gaps (owner package) and activation
   register entries kept apart (FO-00-30). A NOT_CONFIGURED capability is refused at admission
   (`ops/capability-gate.ts`, `CAPABILITY_NOT_CONFIGURED`), its integrations are held, and its ports are guard
   ports (`adapters/live/not-configured.ts`); never a stub or canned data (FO-21-10). Exported as
   `vsp_capability_state{capability,state}` and listed (ids and states only) by `/health/ready`;
5. the gateway app (readiness with capability states, tool and MCP routes); the Talkdesk telephony surface is
   not mounted while `contact_center.talkdesk` is NOT_CONFIGURED. Telemetry (`observability/telemetry.ts`):
   OTLP/HTTP JSON over the transport, only when `observability.otlp` names an allowlisted `TELEMETRY_EXPORTER`
   destination.

NOT_CONFIGURED by construction in this build (software gaps): business systems (WP-23), the relationship
directory and caller identity directory (WP-19), notifications (WP-27), Talkdesk telephony and interaction lookup
(WP-28, WP-29), transfers (WP-28), context store (WP-18), models, media and harness (WP-08, WP-11, WP-10), ingress
events (software gap `INGRESS_PLUGIN_NOT_COMPOSED`, owner WP-07 per the B2 hand-off: no source-profile loading, no
production event-contract registry or handlers, no webhook plugin and no processor loop are composed; the guard's
only tenant input for it is `infrastructure.ingressPayloadKeyId`, reported apart from the gap. There is no
`ingress` configuration section: a key nothing reads would make missing code look like a missing input, so the
strict schema refuses one. A `reconcile_by_lookup` source will need `gatewayCredentials` outside local/ci,
ADR-0023 decision 11).

`modules.yaml` lists `live-container.ts`, `live-modules.ts`, `live-worker.ts` and `audit-exporter.ts` as
transitive production entry points (no fixture, LOCAL FIXTURE adapter, demo, evaluation or test code reachable)
and `live-console.ts` non-transitively (`console-api/auth.ts` still reaches the local sign-in fixtures; its routes
are not mounted). `live-composition.test.ts` scans the live sources for canned success, TEST ids, not-implemented
refusals and BLOCKED stub imports.

## Entry points

| File | Use | Binds |
|---|---|---|
| `server.ts` (`node dist/main/server.js`) | Gateway. local/ci: `buildContainer` (loopback only). sandbox/staging/production: `startLiveServer` over `buildLiveContainer` (unit `gateway`). `VSP_ENVIRONMENT` required, `PORT` (8080), `VSP_MUTATIONS_ENABLED` (default false outside local/ci), `VSP_LISTEN_HOST` (`0.0.0.0` or `127.0.0.1`; local/ci always loopback) | `VSP_LISTEN_HOST`:PORT |
| `../worker/main.ts` | Worker. local/ci: regression worker. Deployed: `live-worker.ts` `startLiveWorker` (unit `worker`, role `app_worker`): outbox dispatch and consumption, action reconcile and expiry, idempotency purge, deferred-audit flush and route reconciler, workflow tick, transfer sweep, retention, support-sync retry, and the connector change feeds of `connectors` (ConnectorRuntime, durable checkpoints, the content-free index of migration 2071, the SQS dead-letter writer) | health on PORT (8081) |
| `live-console.ts` | Console API unit (role `app_console`) over the live container: refuses unless `operator.console` and `identity.workforce` are CONFIGURED; workforce OIDC over the transport (discovery at startup), sealed refresh tokens (Secrets Manager key), PostgreSQL console sessions, the OIDC group staff directory, recovery and break-glass, the background sweep, and a rate limit on the sign-in routes (`AuthRateLimiter` on the route Fastify matched, so a percent-encoded path is the same budget; keyed on the client address: the socket peer, or for a peer inside `infrastructure.trustedProxyCidrs` the right-most untrusted X-Forwarded-For entry; IPv6 per /64; `vsp_console_auth_rate_limited_total`; per-client edge limits are the WAF's, WP-39). Transfer views read under `app_console` (read only). The static console bundle is not served from it yet | PORT (8083) |
| `audit-exporter.ts` | Audit export or verification unit (`VSP_AUDIT_UNIT_MODE` `export` / `verify`), each under its own database login and task role; its own AWS clients and pool (it does not reuse the live container); the guard gets the same inputs as the gateway (`auditUnitStartupInputs`: policy bundle, catalogue, template and image digests, connector credential sets, the other committed environments' key sets, KMS-only trust and the runtime signing key resolver; `audit-exporter.test.ts` starts the guard over them and is refused when another committed environment's signing key is this anchor or manifest key); refuses while `audit.independent` is NOT_CONFIGURED and when a database identity is shared with the runtime | health on PORT (8082) |
| `local.ts` (`pnpm start:local`) | LOCAL FIXTURE gateway + worker loops in one process (PGlite is in-memory) + console API; prints the LOCAL FIXTURE banner with the synthetic integration tokens | 127.0.0.1:8080 (gateway), :8081 (worker health), :8090 (console API) |
| `console.ts` | LOCAL FIXTURE console composition (`ConsoleApiDeps` over the regression container) | via `local.ts` |
| `fixtures/stub-business.fixture.ts` | LOCAL TEST FIXTURE stub `BusinessModule` for composition tests | — |
| `sessionless-routing.test.ts` | SAFE-02 end to end over the regression container with the REAL business module: no, expired and revoked sessions over the HTTP tool route and the real MCP SDK client (127.0.0.1); safety/human tools route to an allowlisted destination and are audited, every other tool fails closed | — |

`deploy/local/services/app.compose.yaml` runs the live gateway and worker as containers (sandbox profile, the
emulators of `make up PROFILE=core`), after `test/integration/composition/app-stack.ts` provisions their
substrate.

## Regression composition (`buildContainer`, local / ci)

`buildContainer({ environment, buildBusiness })` loads the reviewed `platform/config/<environment>.json`, reads the
policy bundle and the committed tool catalogue digest, and runs `assertDeployable` (platform/src/config) with the
adapter kinds the composition would instantiate. A rejected configuration throws `ConfigurationRejectedError`
(reason codes only) before any database, adapter, HTTP server or port exists. It composes PGlite with every
migration, OPA WASM bundle, identity services over LOCAL FIXTURE directory/OIDC/notifications and the in-memory
session store, audit writer / health / query / shipper (LOCAL FIXTURE file sink), action ledger, outbox +
dispatcher + in-memory publisher, workflow engine, transfer coordinator over the telephony fixture, safety
pipeline, templates and response gate, knowledge over the SYNTHETIC approved corpus, support memory, ops (kill
switches, budgets with an ILLUSTRATIVE unapproved local budget, capacity, admission), every adapter fixture in the
AdapterRegistry, the injected business module, the pinned catalogue (must equal `schemas/tools/catalog.json`, else
`TOOL_CATALOG_DRIFT`), the ToolPipeline and the gateway app. Every other environment is refused here after the guard
(`REGRESSION_COMPOSITION_OFFLINE_ONLY`), so a deployed environment can never fall back to fixtures.

### Wiring (wave 4)

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
  `KnowledgeServicePg` with the container's metrics.
* **Egress and redaction** (`platform/src/privacy/egress-startup.ts`): before anything is constructed,
  every configured adapter endpoint, the inbound-auth JWKS URI, the audit sink and every composed
  telemetry / export destination (`ContainerOptions.telemetryExports`) is checked against the egress
  policy (`ContainerOptions.egressPolicy`; local/ci default `LOCAL_FIXTURE_EGRESS_POLICY`, which
  approves nothing). Any violation refuses startup (`<REASON>@<path>`); outside local/ci the
  violations (at least `EGRESS_POLICY_NOT_CONFIGURED@egress`) join the refusal reasons. The container
  exposes `privacy.egress`, `privacy.redaction` (QA / transcript artifact handling; no transcript
  storage exists) and `privacy.egressReport`.
* **Deferred route audit** (`platform/src/audit/deferred.ts`): `deferredAudit` is passed to the business
  layer as `ToolDeps.deferredAudit`; handoff audit events that cannot be written during an audit
  outage are queued in the process that served the call (process-local, bounded; never for
  mutations) and appended in order by that process: the worker loop `audit.deferred_flush` in the
  worker and local compositions, and `DeferredAuditFlushTimer` in the gateway-only entry point
  (`server.ts`, which runs no worker loops; every 5 s, at most 100 events per run). Graceful
  shutdown of `server.ts`, in order: stop accepting connections and wait for open responses
  (bounded, 5 s); close the app, which force-closes the rest; wait for route handlers still running
  (bounded, 10 s; `server.shutdown_handlers_unsettled` at error level when it expires); one final
  flush (bounded, 5 s) that waits for appends in progress, logs `audit.deferred.unflushed_at_shutdown`
  (`remaining`, `inProgress`) and seals the queue, so a later event is reported as
  `audit.deferred.lost_at_shutdown`; then the database closes. The three bounds together are at
  most 25 s (ECS stop timeout 30 s). The worker and local entry points run no final flush and do
  not seal.
* **Console**: `ConsoleApiDeps.reconciledRetry` = `LedgerReconciledRetry(c.actions, c.business.providers)`.

## End-to-end journeys

`platform/test/journeys/` drives this composition over its real HTTP surface (see the README
there): the nine required demonstration journeys and the injected faults of spec section 16.

### Guard inputs and startup checks shared by every live unit (WP-07 refix)

* `live-modules.ts` `servedArtifacts` (pinned policy bundle, committed tool catalogue digest, template catalogue
  digest, `VSP_RELEASE_IMAGE_DIGEST`) and `connectorCredentialSets` (connector profiles of this environment with
  this and every other committed environment's adapter credential references) are built the same way by the
  gateway, worker and console (`buildLiveContainer`) and the audit exporter (`auditUnitStartupInputs`), as is
  `committedSigningKeySets` (the other committed environments' signing keys, anchors and secrets). Both read the
  configuration directory through `committedConfigFiles`, which fails closed: a file that does not parse as a JSON
  object, whose `environment` does not parse, or whose name is another environment than it declares refuses the
  unit (`COMMITTED_CONFIG_UNREADABLE@configDir.<name>`) instead of dropping out of the cross-environment checks.
* `pgConnectionString(secret, { environment, path })`: staging and production require `sslmode=verify-full`
  (`DATABASE_TLS_REQUIRED@<path>` otherwise; JSON secrets default to it, `sslrootcert` names the CA bundle file).
  The URI form is closed there too, because the driver lets query parameters override the URI: only `sslmode`
  (once) and `sslrootcert` (at most once, an absolute `.pem` / `.crt` path) are accepted; `host`, `hostaddr`,
  `port`, `options`, `uselibpqcompat`, `sslcert`, `sslkey`, `sslnegotiation` or any other parameter is
  `DATABASE_TLS_REQUIRED`, and an empty, percent-encoded or socket-path host, a database that is not one plain
  path segment, or a fragment is `DATABASE_SECRET_MALFORMED` (`live-modules.test.ts` checks the pg driver's own
  parse of every accepted secret: the URI host, TLS on).
* AWS endpoint overrides are checked by `createAwsClients` before any client exists (the KMS `GetPublicKey` of the
  approval trust anchor is the one request before the guard, so it can only reach AWS or a sandbox emulator).
* `LiveContainer.ports` lists every injected port (business ports, verification, caller id-token verifier,
  interaction lookup, call-session resolver and its integration identity, quarantine, consent, account state);
  each is a live implementation or a guard port / guard operation (`adapters/live/not-configured.ts`). The
  Layer-2 `boot.test.ts` scans all of them; `live-composition.test.ts` refuses unreviewed canned literals in every
  live source.
* `gateway.http.rateLimit: null` is refused in every live rule set (`GATEWAY_RATE_LIMIT_DISABLED`) and again by the
  container.
