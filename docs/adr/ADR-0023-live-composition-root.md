# ADR-0023 Live composition root: real adapters only, a per-capability activation map, KMS-only approval trust and fixtures refused outside local and ci

| Field | Value |
|---|---|
| Status | **Accepted for engineering** (software scope of WP-07, phase B integration). Running the composition against an AWS account, a tenant IdP, a vendor or Talkdesk: **Pending human approval** (activation register AIN-01, AIN-12, AIN-13, AIN-34, AIN-36, AIN-37; WP-39 for the AWS resources) |
| Date | 2026-10-21 |
| Decided by | Principal engineer (coding agent) for the engineering scope only |
| Approval needed from | Security leadership (approval trust keys in KMS, egress allowlists, the per-capability activation rule); SRE and security operations (telemetry export, alarm routing, PRQ-011); privacy counsel (the content-free telemetry allowlist, AIN-37) |
| Related prerequisites | PRQ-003, PRQ-011, PRQ-036; activation register AIN-01, AIN-12, AIN-13, AIN-34, AIN-36, AIN-37 |

## Context

Until phase B, `buildContainer` (`platform/src/main/container.ts`) was the only composition: it assembles
LOCAL FIXTURE adapters for local and ci, and every other environment was refused wholesale
(`LIVE_COMPOSITION_NOT_IMPLEMENTED`). The phase B packages built the live parts separately: the durable substrate
and ingress inbox ([ADR-0020](ADR-0020-durable-substrate-real-protocols.md), WP-04), live identity over OpenID
Connect ([ADR-0021](ADR-0021-live-identity-openid-connect.md), WP-05) and the connector runtime with its
egress-classified transport ([ADR-0022](ADR-0022-connector-runtime-module-boundaries.md), WP-06). Each left the
composition to WP-07. The follow-on requirements are that sandbox, staging and production start the gateway,
worker and console from real adapters only (FO-16-11, FO-19-06, FO-21-10), that a missing tenant input disables
only the capability it belongs to (FO-00-26, FO-00-30: "an adapter stub is not a missing BAA"), that no
development bypass reaches a deployed process (FO-14-53, FO-03-49), that approval records are trusted only
through KMS (FO-14-56), and that telemetry leaves the process content-free and only to an allowlisted collector
(FO-03-30). The regression composition must stay exactly as it is for local and ci (FO-00-36, FO-22-21).
Environment status of everything here: NOT_CONFIGURED (it runs against the local emulators only).

## Decision

1. **Two composition roots, never mixed.** `buildContainer` stays the regression composition (local, ci; LOCAL
   FIXTURE adapters, PGlite allowed, the process-local `DeferredAuditQueue`). `buildLiveContainer`
   (`platform/src/main/live-container.ts`, with `live-modules.ts`) composes sandbox, staging and production and
   refuses local and ci. `live-worker.ts` and `live-console.ts` reuse the live container for their units;
   `audit-exporter.ts` is its own unit and does NOT reuse it (it needs none of the runtime's substrate, ports or
   roles): it builds its own AWS clients and database pool and hands the deployment guard the same inputs as the
   other units (decision 9). `platform/architecture/modules.yaml` lists each as a production entry point; the live
   container, live worker, live modules and audit exporter are transitive (nothing they import, directly or
   indirectly, reaches a fixture, a LOCAL FIXTURE adapter, the demo, evaluation tooling or a test emulator).
   `live-console.ts` is listed non-transitively for now because `console-api/auth.ts` still reaches the local
   sign-in fixtures (hand-off: split that file); the console's local sign-in routes are refused by the guard and
   are not mounted.
2. **Order: no pool, store, port or listener exists before the guard accepts the configuration (OPS-04).**
   Configuration; AWS clients from `infrastructure.aws`: endpoint overrides only in sandbox and only for
   emulator hosts, checked by the client factory itself with the guard's own definition
   (`shared/emulator-hosts.ts`) before any client exists (`INFRASTRUCTURE_ENDPOINT_OVERRIDE_FORBIDDEN` outside
   sandbox, `INFRASTRUCTURE_ENDPOINT_OVERRIDE_NOT_EMULATOR` for a non-emulator host); the guard's inputs, which
   every unit builds the same way (`live-modules.ts` `servedArtifacts`: the pinned policy bundle, the committed
   tool catalogue digest, the template catalogue digest and the release image digest `VSP_RELEASE_IMAGE_DIGEST`;
   `connectorCredentialSets`: the connector profiles with this and every committed environment's adapter
   credential references); the approval trust key (one KMS `GetPublicKey`, the only request before the guard,
   which therefore can only reach AWS or a sandbox emulator); the deployment guard; then the substrate, the
   capabilities, the activation map, the gates and the app. The guard's rules are one file each under
   `platform/src/config/rules/` (mandatory substrate, infrastructure, egress, observability, approvals, sandbox,
   full, offline, CORS, console workforce, connectors, gateway limits, live adapters), registered in
   `rules/index.ts`; a test fails when a rule file is neither registered nor a declared helper. Live rule sets
   also refuse a disabled gateway rate limit (`GATEWAY_RATE_LIMIT_DISABLED`), and staging and production
   require TLS with certificate and host verification to PostgreSQL for every unit (`DATABASE_TLS_REQUIRED`,
   `sslmode=verify-full`, optional `sslrootcert` CA bundle); a URI secret there may carry no other query
   parameter (the driver lets `host`, `hostaddr`, `options` and the like override the URI) and only a plain host
   and database name.
3. **Approval trust comes from KMS only (FO-14-56).** The live composition resolves the approval trust anchor
   with `KmsTrustedKeyResolver` (GetPublicKey of a `SIGN_VERIFY` ECC_NIST_P256 key) and has no other resolver: a
   repository PEM (`file:`), a `local-fixture:` reference or a key that is disabled, pending deletion or of the
   wrong usage or spec gives `APPROVAL_TRUST_KEY_REF_NOT_KMS` or `APPROVAL_TRUST_KEY_UNRESOLVED` (logged with
   its reason code), and every approval-gated scope is then unproven. **Key and secret separation** (blocking
   in the sandbox and full rule sets, `config/rules/key-separation.ts`): KMS key policy cannot keep one key's uses
   apart (whoever may call kms:Sign on a key signs anything with it, whoever may read a secret uses it for
   anything) and every gateway task holds kms:Sign on its assertion key, so the trust anchor is never the runtime
   assertion key, the audit manifest signing key or a trusted manifest key, of this environment or of any other
   committed environment configuration (`APPROVAL_TRUST_KEY_IS_ASSERTION_KEY`, `APPROVAL_TRUST_KEY_IS_MANIFEST_KEY`);
   within this environment the keys are also compared by key MATERIAL (two key ids can hold the same imported
   material): `config/startup.ts` `resolveRuntimeSigningPublicKeys` obtains the public key of every runtime
   signing key with `KmsRuntimeSigningKeyResolver` (GetPublicKey by key ARN, bare key id or mrk- id, every form
   the runtime may sign with; never an alias; used for this comparison only, never as a trust anchor), and a key
   it cannot resolve (GetPublicKey denied or failing, an unsupported reference) refuses the environment
   (`RUNTIME_SIGNING_KEY_UNRESOLVED@<path>`): the comparison fails closed instead of being skipped, and the anchor
   is then not used either. A refused anchor is not used at all, so no record verifies and a record the runtime
   minted is never VALID. The reverse direction holds too:
   this environment's assertion and manifest keys are never another committed environment's anchor
   (`ASSERTION_KEY_IS_APPROVAL_TRUST_KEY`, `AUDIT_MANIFEST_KEY_IS_APPROVAL_TRUST_KEY`), evaluated on the effective
   configuration, so a key supplied by an allowlisted override, which the other environment's guard cannot see,
   is refused where it is used; and no signing key is another environment's signing key
   (`SIGNING_KEY_REUSED_ACROSS_ENVIRONMENTS`). In the same class the manifest keys are never the assertion key
   (`AUDIT_MANIFEST_KEY_IS_ASSERTION_KEY`: the runtime could forge export manifests); every secret serves one
   purpose: the database login, the two peppers, the console session sealer, the exporter and verifier logins,
   each adapter credential and each connector profile credential of this environment (every profile's default
   and capability credentials, reported at `connectors.credentials.<env>.profile:<id>:<capability>:<access>`)
   are different secrets (`SECRET_REUSED_ACROSS_PURPOSES`: for example the gateway, which reads the peppers and
   the database login, could otherwise unseal workforce refresh tokens, and the worker, which reads the connector
   credentials, would hold the sealer), and none is a secret of another committed environment
   (`SECRET_REUSED_ACROSS_ENVIRONMENTS`); adapter and profile credentials among themselves and against other
   environments' adapter credentials are the connector credential rule's, which compares them by identity too
   (references normalized to one spelling per secret first, `config/rules/types.ts` `canonicalReferences`); signing keys are referenced by
   key, never by alias (`KMS_SIGNING_KEY_REF_IS_ALIAS`: separation must be decidable from configuration).
   References compare by key id (an ARN matches its bare key id and a multi-region replica; a full Secrets
   Manager ARN matches the partial ARN of the same secret); cross-environment separation is decidable only for
   committed references (compared by reference, not by material), and a committed configuration file that does
   not parse with a valid environment refuses the unit (`COMMITTED_CONFIG_UNREADABLE@configDir.<name>`) instead
   of dropping out of the comparison.
4. **A missing tenant input disables one capability, never the process (FO-00-26, FO-00-30, FO-21-03).** The
   guard separates blocking violations (missing mandatory substrate, a fixture outside local/ci, an endpoint
   override outside sandbox: the process refuses) from capability violations (a tenant input of one component:
   its capability becomes NOT_CONFIGURED). The activation map (`platform/src/main/capabilities.ts`) lists every
   runtime capability of `docs/followon/capabilities.yaml` as CONFIGURED or NOT_CONFIGURED with three kinds of
   reason kept apart: guard and composition reason codes (`<CODE>@<config path>`), software gaps with their
   owning package (code that does not exist yet is never shown as a missing input), and the activation register
   entries it waits on. A NOT_CONFIGURED capability's intents are refused at admission
   (`CapabilityGatedAdmission`, `CAPABILITY_NOT_CONFIGURED`), its integrations are held by the kill-switch layer,
   and its ports are guard ports (`adapters/live/not-configured.ts`): a proxy whose every method rejects
   `CapabilityNotConfiguredError` and counts the reach, and whose health reports
   `CAPABILITY_NOT_CONFIGURED`. Never a stub, never canned data. The map is the gauge
   `vsp_capability_state{capability,state}` and is listed (ids and states only) by `/health/ready`.
   The safety and human routes are never gated (SAFE-02), so they run over the telephony guard port; when no
   route of a journey can be reached (every dial refused in the last pass, or the staffed routes exhausted) both
   routing tools report `ROUTE_UNAVAILABLE_USE_STUDIO_ROUTE` with no transfer id, never TRANSFER_REQUESTED, so
   the contact-centre flow takes its independent Studio route; the safety evidence is still recorded.
5. **The schema must be current.** The live units refuse to start on a database whose applied migrations are
   behind the code (`SCHEMA_MIGRATIONS_PENDING`) or that lacks a required table; migration 2070 adds the durable
   transfer store (`transfer_journeys`) and the read grant on `schema_migrations`, 2071 the content-free
   connector change-feed index.
6. **One outbound transport for every client (FO-14-53, WP-06 decision 2).** The live container builds one
   `ConnectorHttpTransport`; the inbound JWKS resolver, the caller and workforce IdP clients, the Salesforce
   adapter and the OTLP exporter use it, each bound to its egress destination. In sandbox only, the
   container accepts a resolver map and extra trusted CAs for emulated vendor hosts (the `network` option, used by
   the Layer-2 suite, never read from configuration); staging and production refuse it
   (`NETWORK_OVERRIDE_OUTSIDE_SANDBOX`). No development bypass
   remains: LOCAL FIXTURE integration tokens, the development signing key and `local-fixture:` / `file:`
   references are refused outside local and ci.
7. **Telemetry is content-free and opt-in (FO-03-30, AIN-37).** OTLP/HTTP JSON export (the OpenTelemetry SDK
   meter and tracer providers with the platform's own JSON exporters, `observability/otlp.ts`) starts only when
   `observability.otlp` names an https endpoint on a `TELEMETRY_EXPORTER` egress destination of this
   environment. Metrics carry catalogue names and allowlisted attributes only; an attribute outside the
   allowlist is dropped and counted (`vsp_telemetry_attributes_dropped_total`); a failing collector never
   affects serving (exports are counted as failed). Span and event names come from closed registries
   (`SPAN_NAMES`, `SPAN_EVENT_NAMES` in `observability/tracing.ts`), and the exporter applies the same name
   registries and attribute allowlist to every span, including those of the raw tracer. The metric catalogue is split into module-owned parts
   merged in `observability/catalog/index.ts`, and `scripts/ci/check-metric-names.mjs` checks every emitted name
   against it.
8. **The worker schedules every loop the substrate needs, and a failing loop is never healthy.** A consume run
   with any failed or unconsumable outbox message fails (`OUTBOX_CONSUME_FAILED` / `OUTBOX_UNCONSUMABLE`),
   counts `vsp_outbox_consume_failures_total{reason}` (alarm `outbox-consume-failures`) and, after three failing
   runs, turns the worker's readiness to 503; the messages stay on the queue for its redrive policy. The producer
   side likewise: a dispatch run in which a claimed message failed to publish or was dead-lettered fails
   (`OUTBOX_PUBLISH_FAILED` / `OUTBOX_DEAD_LETTERED`) and counts `vsp_outbox_publish_failures_total{reason}`
   (alarm `outbox-publish-failures`), and a run that claims nothing while earlier failures wait out their backoff
   fails `OUTBOX_PUBLISH_RETRYING`, so a queue that refuses every publish is not ready after three runs; the
   messages stay in PostgreSQL. The call-session resolver's trusted telephony identity is a
   guard operation (it refuses, counts and pages), never a canned `null`. Outbox dispatch to SQS and consumption, action
   reconciliation and expiry, the tool idempotency purge, the durable deferred-audit flush and route reconciler,
   the workflow tick, the transfer sweep, the retention run, the support-sync retry and, when connector profiles
   are configured, the connector change feeds (`connectors.feed_sync`: ConnectorRuntime, IncrementalReader with
   PostgreSQL checkpoints, the SQS dead-letter writer). A dead-letter write that is refused rolls the page back: neither the index nor the checkpoint
   advances and consumption of that feed stops (`[FAULT:DLQ_FULL]`); the paging alarm rule
   `connector-feed-dead-letter-refused` fires. Alarm rules are code (`observability/alarms.ts`) validated against
   the catalogue; each names an indexed runbook.
9. **The audit exporter is its own unit with its own identities (WP-04 hand-off).** `audit-exporter.ts` runs in
   `export` or `verify` mode, each under its own database login and task role; the guard refuses a database
   identity shared with the runtime (`AUDIT_EXPORT_IDENTITY_SHARED`). It passes the guard exactly the inputs the
   gateway passes (`auditUnitStartupInputs`), so the full rule set admits it whenever it admits the gateway: a
   complete staging configuration passes; in production the served knowledge snapshot is still not an input of
   any unit (no pinned snapshot digest yet, knowledge owner), so a KNOWLEDGE_RELEASE approval stays
   SUBJECT_UNVERIFIABLE and production fails closed for every unit alike.
10. **The console is composed from the live container (WP-05 hand-off).** `buildLiveConsole` refuses unless
    `operator.console` and `identity.workforce` are CONFIGURED: the workforce client credential and the
    session sealer key come from Secrets Manager, discovery runs at startup (an egress refusal is a
    configuration error; an unreachable IdP leaves the console up with sign-in failing closed), and the
    unauthenticated sign-in routes are rate limited in the app on the ROUTE the router matched (never the raw
    URL, so a percent-encoded path is the same budget), keyed on the client address: the socket peer, or only
    for a peer inside `infrastructure.trustedProxyCidrs` (private load balancer ranges) the right-most
    X-Forwarded-For entry that is not a trusted proxy. Staging and production without trusted proxy ranges make
    `operator.console` NOT_CONFIGURED (one shared balancer address would let one client lock every operator
    out). The console's transfer views read under `app_console` (read only); the per-client edge limit is the
    WAF, WP-39. All units still share one database login (`database.connectionRef`); separate logins per unit
    are a WP-39 provisioning item.
11. **Ingress events are not composed in this build.** `ingress.events` is NOT_CONFIGURED with the software
    gap `INGRESS_PLUGIN_NOT_COMPOSED` (owner WP-07, the B2 hand-off): no source-profile loading, event-contract
    registry, handlers, webhook plugin or processor loop is composed. Missing code is never reported as a
    missing tenant input (FO-00-30): the configuration has no `ingress` section (a key nothing reads would look
    like that input; the strict schema refuses it), and the payload key `infrastructure.ingressPayloadKeyId` is
    the one tenant input the guard reports for the capability, apart from the gap.
    Decision recorded for that hand-off: a `reconcile_by_lookup` source (no vendor signature; the inbox fetches
    the authoritative record server-side) must carry `gatewayCredentials` outside local and ci, so an
    unauthenticated caller cannot drive server-side lookups; the WAF rate limit is in addition, not instead. It
    is enforced in the ingress source admission (ingress module owner).
12. **Fault seams stay test-only.** The Layer-2 composition suite drives `[FAULT:AUTH_EXPIRY_MID_CALL]` with
    the WP-05 `SessionExpirySeam`, which refuses every environment but local and ci: the test wraps it with
    `ci` and hands it to the sandbox container as its clock. The seam is never composed by a deployed process.

## Consequences

* `make up PROFILE=core && make test-integration SUITE=composition` boots the sandbox gateway, worker and
  console from real adapters against PostgreSQL 16, DynamoDB Local, ElasticMQ, LocalStack KMS and Secrets
  Manager, Keycloak 26 and a throwaway OpenTelemetry Collector
  (`platform/test/integration/composition/README.md`). `deploy/local/services/app.compose.yaml` runs the gateway
  and worker as containers on the pinned Node base image, and `otel-collector.compose.yaml` a collector, both
  behind their own compose profiles.
* The BLOCKED stub adapters (`adapters/live/*-blocked.ts`, `blocked-set.ts`) are no longer imported by any
  composition (a scan test); deleting the files needs the adapters module owner, whose registry, inventory and
  refusal tests still construct them.
* In this build NOT_CONFIGURED by construction (software gaps): business systems (WP-23), the relationship
  directory and caller identity directory (WP-19), notifications (WP-27), Talkdesk telephony and interaction
  lookup (WP-28, WP-29), transfers (WP-28), the context store (WP-18), models, media runtime and harness (WP-08,
  WP-11, WP-10).
* The regression composition keeps the process-local `DeferredAuditQueue`; only the live composition uses the
  durable queue (ADR-0020 decision 1).
* A generated gateway client (`platform/src/gateway-client`, from `schemas/openapi/gateway.openapi.json` by
  `openapi:gen`) is the only way the untrusted group reaches the gateway; its drift is checked by
  `openapi:check`.
* Open: HTTP request tracing spans in the gateway app; the Kinesis client (WP-17); the Terraform resources for
  the new tables, queues, roles and alarms (WP-39); the ingress source registry and plugin (decision 11).

## Alternatives considered

| Alternative | Why not adopted |
|---|---|
| Extend `buildContainer` with an environment switch | One file would hold fixtures and live adapters together; a wrong branch would reach a fixture in a deployed process. Two roots with a transitive import check make that impossible |
| Refuse the whole process when any tenant input is missing | Every capability would wait for the slowest input, and a missing vendor contract would read as a platform failure (FO-00-30) |
| BLOCKED stub adapters that refuse every call | A stub looks like an implementation to the guard and the registry; a guard port of a NOT_CONFIGURED capability is refused at admission and reported as such |
| Trust approvals signed by a repository PEM in sandbox | A key in the repository is a key anyone with the repository holds; KMS-only trust is the same rule everywhere |
| The OpenTelemetry OTLP exporter packages with their own HTTP client | They bypass the egress transport, its allowlist and its TLS pinning, and are not in the pinned dependency set; the platform's exporters post through the connector transport |

## Linked requirements

OPS-01, OPS-03, OPS-04, OPS-05, OPS-06, AUTH-02, AUTH-04, DATA-01; FO-00-26, FO-00-30, FO-00-36, FO-01-03,
FO-03-30, FO-03-49, FO-14-53, FO-14-56, FO-16-11, FO-17-24 (AUTH_EXPIRY_MID_CALL, DLQ_FULL), FO-19-06, FO-21-03,
FO-21-10, FO-22-20, FO-22-21.

## Revisit when

An AWS sandbox account exists (AIN-01, WP-39), a tenant IdP or vendor sandbox is connected (AIN-12, AIN-13,
AIN-36), telemetry export is approved (AIN-37), or a capability's live adapter lands and its software gap closes.
