# platform/src/console-api: console API v1 (contract + backend)

Status: **IMPLEMENTED_OFFLINE**. `contract.ts` defines the operations and incident control
console API (spec sections 6, 7, 12, 13 and 16); `plugin.ts` implements every endpoint as a
Fastify plugin (`registerConsoleApi(app, deps)`), tested with `fastify.inject` over real
modules on PGlite. The React console (`console/`) is tested against the same contract with a
labelled mock backend. Workforce SSO is BLOCKED (PRQ-036, VQ-IDP-08): only the LOCAL FIXTURE
workforce IdP and SYNTHETIC staff exist. Nothing here has been verified against a vendor, a
real IdP or production, and nothing here claims HIPAA compliance or production readiness.

## Why types and constants only

`contract.ts` has no imports and no runtime dependencies. The console imports it with a
relative path (`console/src/api/contract.ts` re-exports it) and has no zod. The backend
implements matching strict zod schemas (`z.strictObject`, bounded sizes, closed enums) and
must assert type equality against these interfaces (see "Keeping the contract in sync").

## Endpoints (base `/console/api/v1`)

Generated from `CONSOLE_ENDPOINTS`, `ENDPOINT_ROLES` and `PUBLIC_ENDPOINTS`. The roles column
is necessary, not sufficient: the finer rules below also apply.

| Key | Method | Path | Roles (any one) |
|---|---|---|---|
| `auth.config` | GET | `/auth/config` | public (no token) |
| `auth.localStaff` | GET | `/auth/local/staff` | public (no token) |
| `auth.localToken` | POST | `/auth/local/token` | public (no token) |
| `auth.oidcExchange` | POST | `/auth/oidc/exchange` | public (no token) |
| `auth.logout` | POST | `/auth/logout` | `support_agent`, `supervisor`, `safety_responder`, `auditor`, `knowledge_editor`, `policy_approver`, `deployment_operator`, `security_admin` |
| `me` | GET | `/me` | `support_agent`, `supervisor`, `safety_responder`, `auditor`, `knowledge_editor`, `policy_approver`, `deployment_operator`, `security_admin` |
| `overview` | GET | `/overview` | `support_agent`, `supervisor`, `safety_responder`, `deployment_operator`, `security_admin` |
| `calls.list` | GET | `/calls` | `support_agent`, `supervisor`, `safety_responder` |
| `calls.get` | GET | `/calls/:callId` | `support_agent`, `supervisor`, `safety_responder` |
| `calls.transfer` | POST | `/calls/:callId/transfer` | `support_agent`, `supervisor`, `safety_responder` |
| `supportRequests.trace` | GET | `/support-requests/:ref/trace` | `support_agent`, `supervisor`, `safety_responder` |
| `supportRequests.repair` | POST | `/support-requests/:ref/repair` | `supervisor` |
| `actions.pending` | GET | `/actions/pending` | `support_agent`, `supervisor` |
| `actions.cancel` | POST | `/actions/:actionId/cancel` | `support_agent`, `supervisor` |
| `reconciliation.list` | GET | `/reconciliation` | `supervisor` |
| `reconciliation.reconcile` | POST | `/reconciliation/:actionId/reconcile` | `supervisor` |
| `reconciliation.retry` | POST | `/reconciliation/:actionId/retry` | `supervisor` |
| `outbox.requeue` | POST | `/outbox/:messageId/requeue` | `supervisor` |
| `workflows.tasks` | GET | `/workflows/tasks` | `support_agent`, `supervisor` |
| `workflows.decision` | POST | `/workflows/tasks/:taskId/decision` | `support_agent`, `supervisor` |
| `safetyEvents.list` | GET | `/safety-events` | `safety_responder`, `supervisor` |
| `releases.list` | GET | `/releases` | `policy_approver`, `knowledge_editor`, `security_admin`, `auditor` |
| `releases.review` | POST | `/releases/:releaseId/review` | `policy_approver`, `knowledge_editor` |
| `budgets.list` | GET | `/budgets` | `supervisor`, `security_admin`, `deployment_operator` |
| `killSwitches.list` | GET | `/kill-switches` | `supervisor`, `security_admin`, `deployment_operator` |
| `killSwitches.set` | POST | `/kill-switches` | `supervisor`, `security_admin`, `deployment_operator` |
| `audit.search` | GET | `/audit/search` | `auditor`, `security_admin` |
| `destinations.list` | GET | `/destinations` | `support_agent`, `supervisor`, `safety_responder`, `security_admin` |

Finer rules the server enforces:

* `killSwitches.set`: the staff member also needs a role in `KILL_SWITCH_SCOPE_ROLES[scope]`
  (mirrors `KILL_SWITCH_ROLES` in `platform/src/ops/staff-authz.ts`: model and voice version
  switches also allow `deployment_operator`).
* `workflows.decision`: the staff member needs one of the task's `requiredStaffRoles`
  (`BUSINESS_ROLE_STAFF_MAPPING`, `platform/src/workflows/types.ts`); `workflows.tasks` returns
  only tasks for the caller's roles.
* `releases.review`: role per release kind (`RELEASE_REVIEW_ROLES`); a reviewer never reviews a
  release they submitted (`SELF_REVIEW_FORBIDDEN`).
* `actions.cancel`: `support_agent` only for calls they currently own; only `PREPARED` /
  `CONFIRMED` actions; `COMMITTING` and later are refused (`ACTION_NOT_CANCELLABLE`).
* `reconciliation.retry`: only when the action's latest reconciliation returned `NOT_FOUND` and
  `reconciliationId` names that reconciliation (`RECONCILE_REQUIRED` otherwise) (ACT-03).
* `calls.transfer`: `destinationId` must be in the trusted allowlist (`DESTINATION_NOT_ALLOWLISTED`,
  SAFE-05); the response state is `REQUESTED`/`QUEUED`, never success (SAFE-04).
* `supportRequests.repair`: only a `DEAD_LETTER` Salesforce sync (`409 STATE_CONFLICT` otherwise);
  restricted (privacy / safety) requests additionally need `restricted_record:view` (valid break-glass
  approved by someone else), exactly as reading them; reason codes from
  `OPERATOR_REASON_CODES["supportRequests.repair"]`; the response is `syncState: PENDING` (the sync is
  asynchronous, never reported done here).

## Authentication

* **Workforce SSO (target).** Authorization code + PKCE (S256). `GET auth/config` returns the
  issuer, client id and the authorization endpoint the backend resolved from the issuer's
  OpenID Connect discovery document. The browser redirects, receives `code` + `state`, and posts
  `{code, codeVerifier, redirectUri, nonce}` to `POST auth/oidc/exchange`. The backend exchanges
  the code at the IdP token endpoint, validates the ID token (issuer, audience, nonce, expiry and
  the MFA claim defined by the IdP configuration, BLOCKED VQ-IDP-08), maps workforce groups to
  `StaffRole` and mints a short-lived console bearer token. IdP tokens never reach the browser.
  BLOCKED until the identity owner issues the workforce OIDC client (PRQ-036).
* **Local fixture (offline only).** `GET auth/local/staff` lists synthetic staff from
  `platform/src/fixtures/synthetic-world.ts` `STAFF`; `POST auth/local/token` with `{staffId}`
  authenticates one of them through the local workforce IdP fixture (mfa true, amr
  `local_fixture`) and returns a token with `localFixture: true`. Register these two routes ONLY
  when the environment is `local` or `ci` and the workforce IdP adapter kind is `local_fixture`;
  everywhere else they return 404 `LOCAL_FIXTURE_DISABLED`, and the production configuration
  guard must reject them (OPS-04). The console additionally shows the picker only when
  `auth/config` reports `mode: local_fixture`, `localFixture: true` and environment local/ci.
* Every authenticated request carries `Authorization: Bearer <token>`. The console keeps the token
  in memory only; cookies are never used (`credentials: "omit"`), so there is no ambient
  authority for CSRF.
* `GET me` returns the server-established `StaffView`. Sessions without MFA are refused.
  Break-glass is time-bound, granted by a `security_admin` through the separate audited access
  process (never self-granted, `approvedBy` is never the holder), expires fail-closed, and has no
  request or grant endpoint in this API.

## Binding backend rules

1. Authorize every request server-side from the verified token (AUTH-02, AUTH-03). Never trust
   a role, staff id or tenant in a body or query.
2. Path parameters must match `PATH_PARAM_PATTERNS` (opaque ids, `SR-XXXX-XXXX` references);
   query parameters are metadata filters only. No PHI in URLs (spec section 6).
3. Responses are content-free: no transcript text, audio, recording links, caller summaries,
   raw queries, shared secrets, evidence-object bodies or Step Functions task tokens. There is
   deliberately no field in the contract that could carry them.
4. Every mutation writes its audit event in the same transaction as the change and refuses with
   `AUDIT_UNAVAILABLE` when it cannot (OPS-01). Searches are audited too (`auditedSearch`).
5. Operator reasons are reason codes from `OPERATOR_REASON_CODES` for that endpoint, optionally
   `CODE:<opaque incident id>` (`OPERATOR_REASON_PATTERN`, same shape as `KILL_SWITCH_REASON`).
   Free text is rejected (`REASON_NOT_ALLOWED`). The catalogue is a PROPOSED engineering list
   pending review by support operations and security.
6. `killSwitches.set` re-checks `confirmationPhrase` equals `ENGAGE|RELEASE <scope> <target>`
   (`CONFIRMATION_MISMATCH`) and that `target` is `*` for global scopes or one of the configured
   `targets`. Switches never gate the safety and human routes (`safetyRoutesPreserved: true`).
7. `POST` requests carry `Idempotency-Key` (`IDEMPOTENCY_KEY_PATTERN`); return the first result
   for a repeated key per staff member and endpoint.
8. `releases.review` records an opinion. It is never an approval record; releasing requires a
   signed `POLICY_RELEASE` / `KNOWLEDGE_RELEASE` approval (`approvals/`), which the console cannot
   create (`approvalRecordCreated: false`).
9. Errors: `ConsoleErrorBody` with reason code, correlation id and retryable flag only.

## Implementation map (existing platform ports)

| Endpoint(s) | Backing service |
|---|---|
| `killSwitches.*` | `KillSwitchService` (`platform/src/ops/ports.ts`) |
| `budgets.list` | `BudgetService.statusFor` (`platform/src/ops`) |
| `reconciliation.list`, `reconcile`, `retry` | `ActionService.listNeedingReconciliation`, `reconcile`, commit protocol (`platform/src/actions`) |
| `reconciliation.list` (dead letters), `outbox.requeue` | `PgOutboxDispatcher.listDead`, `requeueDead` (`platform/src/outbox/dispatcher.ts`) |
| `supportRequests.repair` | `SupportRequestService.trace` (worker view: existence, restricted flag, sync state) + `repairDeadLetter` (`PgSupportRequestService`: back to `PENDING` with a fresh sync message and a reset attempt budget, audited in its transaction as `support_request.repair_requeued`, actor = the staff member); `503 REPAIR_PATH_UNAVAILABLE` when the business module has no repair |
| `actions.pending`, `actions.cancel` | Pending list: console column-allowlisted read of `action_ledger` (migration 0900). Cancel: `LedgerActionService.cancelPending` (not on the `ActionService` port; interface change requested) |
| `workflows.tasks`, `workflows.decision` | `WorkflowEngine.openTasks`; for a decision the backend calls `PgWorkflowEngine.issueTaskToken` and then `completeHumanTask` for the same authenticated staff member inside the one request, so the plaintext token never leaves the server. `completeHumanTask` takes no reason code yet (interface change requested); until then the reason is recorded in the console audit event |
| `safetyEvents.list` | `safety_events` rows written by `SafetyEventRecorder` (`platform/src/safety/safety-events.ts`) |
| `audit.search` | `PgAuditQuery` as app_auditor plus a console audit event for the search (same semantics as `auditedSearch`, which does not return the event id) |
| `calls.transfer` | `HandoffService.requestHuman`, or `HandoffService.requestSafetyRoute` for a staff safety escalation (`platform/src/business/contract.ts`), both routing through the `TransferCoordinator`; `LedgerActionService.cancelPending` for the escalation's pending-action revocation |
| `destinations.list` | Trusted `DestinationConfig` (vendor queue refs never returned) |
| `supportRequests.trace` | `SupportRequestService.trace` + ledger `describe` + `WorkflowEngine.get/openTasks` |
| `calls.list`, `calls.get`, `overview` | `read-models.ts` over `audit_event_metadata` (app_console), `safety_events`, `TransferStore.listActive/get`, kill switches, budgets, capacity, `AuditHealth` |
| `releases.*` | `console_release_submissions` / `console_release_reviews` (migration 0900), `knowledge_snapshots`, `KnowledgeServicePg.reviewQueue` |

## Keeping the contract in sync

* `console/src/api/contract.test.ts` reads the platform sources as raw text and fails when
  `StaffRole`, `KillSwitchScope`, `TransferReason`, `KILL_SWITCH_ROLES`, `BUDGET_ROLES`,
  `GLOBAL_SCOPES`, `KILL_SWITCH_REASON` or `BUSINESS_ROLE_STAFF_MAPPING` drift from the contract.
* `schemas.test.ts` asserts type-level equality between every zod-inferred type and the
  interface here (`expectTypeOf<z.infer<typeof S.MeResponseS>>().toEqualTypeOf<C.MeResponse>()`).
* `ReleaseReviewItem.heldItems` was added compatibly (optional) by the backend.

## Backend implementation (`plugin.ts`)

| File | Purpose |
|---|---|
| `plugin.ts` | `registerConsoleApi(app, deps)`: every endpoint under `/console/api/v1`, error handler, not-found handler (`LOCAL_FIXTURE_DISABLED` for `auth/local/*` outside local/ci), `no-store` headers. `assertConsoleDeps` refuses local fixture identity components outside local/ci; `consoleRuntimeComponents` reports them to the configuration guard |
| `deps.ts` | `ConsoleApiDeps`: the explicit ports / narrow class slices the composition root supplies (`HandoffService`, `SupportRequestService` from `business/contract.ts`; ledger, outbox dispatcher, workflow engine, transfer store, knowledge, ops, audit, policy) |
| `schemas.ts` | Strict zod schemas for every request and response; `schemas.test.ts` asserts the inferred types equal the contract interfaces (`expectTypeOf`) |
| `auth.ts` | `WorkforceTokenVerifier` (jose: issuer, audience, exp, nbf, iat lifetime, jti, auth_time, MFA amr; local JWKS or remote JWKS URL), `StaffDirectory` port, `LocalStaffDirectoryFixture`, `LocalWorkforceSignInFixture`, `BlockedWorkforceStaffDirectory` |
| `break-glass.ts` | `PgBreakGlassGrantSource`: authoritative grants from `console_break_glass_grants`, mapped into the console policy input |
| `authorize.ts` | ENDPOINT_ROLES + `decideConsole` (any one mapped catalogue action allowing suffices) and the deny-reason mapping |
| `stores.ts` | Console-owned state: idempotency, session revocations, release submissions and reviews, reconciliations; console audit input builder |
| `read-models.ts` | Content-free read models from audit metadata (`audit_event_metadata`, app_console), `safety_events`, the ledger column allowlist |
| `fixtures/` | LOCAL TEST FIXTURES: the harness over real modules and the labelled business-service stand-ins |
| migration `0900_console.sql` | `console_break_glass_grants` (never self-granted, time-bound), `console_token_revocations`, `console_idempotency`, `console_release_submissions`, `console_release_reviews` (`approval_record` is always false), `console_reconciliations`, and a column-allowlisted, tenant-RLS console read policy on `action_ledger` |

### Request pipeline

1. Bearer JWT verified (`WorkforceTokenVerifier`), staff resolved by (issuer, subject) from the
   `StaffDirectory` (roles re-read on every request), logout revocation checked, the latest
   break-glass grant loaded. Tokens without an MFA amr are refused (`401 STAFF_MFA_REQUIRED`).
2. `ENDPOINT_ROLES` (`403 STAFF_ROLE_NOT_PERMITTED`, audited as a denial).
3. Strict path / query / body validation (`400 VALIDATION_FAILED`; reasons `REASON_NOT_ALLOWED`).
4. Console policy decision(s) (`403` with the mapped reason code, audited).
5. `Idempotency-Key` for every mutating POST (first result wins per staff member and endpoint).
6. Handler with the finer rules (scope roles, task roles, release roles, self-review, typed
   confirmation, reason allowlists, break-glass for restricted records).
7. Strict response validation: a response with any field outside the contract is refused
   (`500 RESPONSE_SCHEMA_VIOLATION`) instead of being sent.

### Policy mapping

Every read view maps to a dedicated, non-mutating console catalogue action whose role set
equals the endpoint's `ENDPOINT_ROLES` (checked by `policy-alignment.test.ts`); mutations keep
their mutating actions (auditor read-only taint applies).

| Endpoint | Console policy action(s) (any one) |
|---|---|
| `me`, `auth.logout` | `console:session` (every staff role) |
| `overview` | `operations:overview` |
| `calls.list`, `calls.get`, `supportRequests.trace` | `journey:inspect`; restricted support requests additionally `restricted_record:view` (break-glass) |
| `calls.transfer` | `call:transfer` |
| `actions.pending` | `pending_action:review` |
| `reconciliation.list` | `reconciliation:view` (supervisor) |
| `actions.cancel` | `pending_action:cancel` (supervisor; support_agent only when the call is assigned to them) |
| `reconciliation.reconcile`, `reconciliation.retry` | `operation:retry_reconciled` |
| `outbox.requeue` | `dlq:repair` |
| `supportRequests.repair` | `dlq:repair` (same operator repair action); restricted requests additionally `restricted_record:view` (break-glass) |
| `workflows.tasks` | `human_task:view` |
| `workflows.decision` | `human_task:decide` |
| `safetyEvents.list` | `safety_event:view` |
| `releases.list` | `release:view`; per item, policy bundles additionally `policy:review` |
| `releases.review` | `policy:approve` with initiator = submitter (policy bundles), `knowledge:submit_release` (knowledge snapshots) |
| `budgets.list` | `budget:view` |
| `killSwitches.list` | `kill_switch:view` |
| `killSwitches.set` | `kill_switch:engage` / `kill_switch:release` with the requested scope |
| `audit.search` | `audit:search` |
| `destinations.list` | `journey:inspect`, `policy:review` |

### Restricted support requests and the trace

* The worker-view trace decides only which gate applies (existence and the restricted flag);
  nothing from it is returned. A restricted request needs `restricted_record:view` (valid
  break-glass approved by someone else).
* The returned data is read through `SupportRequestService.trace(..., { reader: { kind:
  "console", restrictedReader } })`: as `app_console` under row-level security, with
  `app.restricted_reader = 'on'` (migration 0300) set in that transaction ONLY after the
  `restricted_record:view` decision allowed. A row RLS hides answers 404.
* `sync.lastReasonCode`, `sync.syncedAt` and `sync.outboxMessageIds` come from the business
  trace (`last_sync_reason`, `synced_at`, the request's `support_request.sync` outbox ids).

### Console-initiated transfers

`calls.transfer` passes the staff-selected destination (`destinationId`, already checked
against the allowlist here) and `initiatedBy {staffId}` to `HandoffService.requestHuman`,
which re-checks the allowlist (refusal: `400 DESTINATION_NOT_ALLOWLISTED`, nothing dialled)
and audits the staff member as the actor. A different dialled destination (coordinator
fallback) is still reported as `TRANSFER_DESTINATION_SUBSTITUTED`.

**Staff safety escalation (spec section 10: human intervention is a safety signal; finding
SAFE-HANDOFF-05).** When the reason is `SAFETY_PRIORITY` or the selected destination has purpose
`SAFETY_PRIORITY`, the handler calls `HandoffService.requestSafetyRoute` with
`humanInterventionSignal()` and `initiatedBy {staffId}` instead of a plain human request: the
priority route is requested first, then the business layer resolves the call's live session
server-side to revoke its pending mutations and apply `SAFETY_ESCALATION` (TC-12 then answers
priority SAFETY), writes the restricted P1 safety record and the safety incident (`safety_events`,
time-to-routing metric). The console additionally cancels the call's remaining `PREPARED` /
`CONFIRMED` actions through the ledger (`action.cancel`, reason `SAFETY_ESCALATION`, actor the staff
member), so revocation does not depend on that session resolution (which is a LOCAL FIXTURE in the
local composition and BLOCKED live, TB-01). The success audit reason code is
`SAFETY_ESCALATION_ROUTED`. A human request for a call whose safety route is active is answered with
that safety route (the business layer never dials a STANDARD destination then).

### Audit (OPS-01)

* Console-owned effects (logout revocation, release review, console reconciliation record and
  its retry consumption) are written in ONE app_console transaction with their console audit
  event (`sourceComponent: "console"`, action `console.<endpoint>`).
* Effects owned by other modules are audited in-transaction by that module: kill switches
  (`killswitch.set`, sourceComponent console), ledger cancel (`action.cancel`), ledger
  reconcile (`action.reconciled` / `action.reconcile.inconclusive`), outbox requeue
  (`outbox.requeue`), support-request repair (`support_request.repair_requeued`), human task
  completion (`workflow.human_task.complete`). Their module APIs
  take no transaction, so the console first writes a write-ahead intent event (`PENDING`) that
  must succeed (`503 AUDIT_UNAVAILABLE` otherwise, nothing attempted), then a best-effort
  completion event. Responses return the effect's own in-transaction audit event id.
* Sensitive reads (`calls.get`, `supportRequests.trace`, `safetyEvents.list`) and every
  `audit.search` are audited before data is returned; if that is impossible nothing is returned.
* Denials are audited best-effort (`DENIED`); the denial stands either way.

### Content-free read models

* Active calls / investigation timelines: audit METADATA by callId (session lifecycle from
  `SESSION_AUDIT_ACTIONS`, `tool.invoke` with `db://tool_catalog/<name>/<version>` pointers,
  `transfer.*` joined to the transfer store, `action.*` joined to the ledger, policy decisions)
  plus `safety_events` rows. Intent category and caller language are not carried by
  content-free metadata, so they are reported as `null` / `und`, never guessed.
* Queue health: transfer journeys per allowlisted destination; staffed-agent availability is
  `null` (Talkdesk queue telemetry, TB-07 UNKNOWN). AI admission: kill-switch snapshot, budget
  exhaustion, capacity.
* Releases: release submissions recorded by the release pipeline (`ReleaseSubmissionRegistryPg.record`,
  app_worker) for the loaded policy bundle digest and knowledge snapshot digest, held knowledge
  items (`heldItems`), reviewer opinions. `approvalStatus` is `MISSING`: no signed approval
  record exists and the console cannot create one.

### Local sign-in (local/ci only)

`LocalWorkforceSignInFixture` issues tokens through `LocalOidcProviderFixture` for
`IDP.workforceIssuer` / `IDP.consoleAudience` (amr `local_fixture` + `mfa`, 15 minutes) for the
SYNTHETIC `STAFF`. It refuses to be constructed outside local/ci, `registerConsoleApi` refuses
local identity components outside local/ci, the routes are not registered there (404
`LOCAL_FIXTURE_DISABLED`), and the configuration guard rejects the `console-local-sign-in` runtime
component and a local_fixture `workforce-sso` runtime kind outside local/ci (declared kind:
staging/production).

## Known gaps

* `auth.oidcExchange` answers `503 OIDC_NOT_CONFIGURED`: no workforce OIDC client, token
  endpoint, MFA claim definition or role-group mapping exists (PRQ-036, VQ-IDP-08). The live
  bearer verifier (`WorkforceTokenVerifier.remoteJwks`) and the BLOCKED live directory exist.
* `reconciliation.retry` enforces every gate (latest unconsumed NOT_FOUND console reconciliation
  within 10 minutes, ledger back in CONFIRMED), consumes the console reconciliation and then
  calls `ConsoleApiDeps.reconciledRetry`. The local composition (`main/console.ts`) wires
  `LedgerReconciledRetry` (`reconciled-retry.ts`): it reads the ledger's LATEST reconciliation
  record (must be NOT_FOUND and unconsumed) and calls `LedgerActionService.retryAfterReconcile`
  with that ledger id, the staff ref and the provider port, so the ledger re-checks the row
  version, the CONFIRMED state, the expiry, the recorded confirmation **and its freshness** (the
  caller-path window; stale => `CONFIRMATION_STALE`, action expired), refuses an action carrying a
  durable invalidation request, and requires the port's `authorizeOperatorRetry` to re-establish the
  CALLER's current authority (live, unrevoked session at the action's generation without a safety
  escalation; current relationships, kill switches and policy) before it commits with the SAME
  provider idempotency key (ACT-01, finding ACT-F3). The staff member's console authorization never
  substitutes for the caller's. Without a port the endpoint still answers `503 RETRY_PATH_UNAVAILABLE`.
  End to end: `platform/test/journeys/console-retry.test.ts` (UNKNOWN commit -> reconcile
  NOT_FOUND -> retry COMMITTED, one scheduling effect, a second retry refused) and
  `platform/test/journeys/transactions.test.ts` (safety escalation while in doubt -> reconcile
  INVALIDATED, retry commits nothing; stale confirmation -> retry refused, action expired).
* Safety events: the `FAIL_SAFE` signal source (the safety pipeline could not assess an utterance
  and routed to safety) is part of `SafetySignalSource` in `contract.ts`, `schemas.ts` and the read
  model; up to six sources per incident.
* `actions.cancel` for support agents needs a call-ownership source (Talkdesk agent assignment,
  TB-07); without one only supervisors can cancel (fail closed).
* `calls.transfer` passes the staff-selected allowlisted destination and the initiating staff
  member (see "Console-initiated transfers"); the plugin's tests use the labelled
  `HandoffServiceFixture`, and `platform/src/main/console.test.ts` exercises the real
  business layer for the restricted trace.
* No rate limiting on the auth endpoints in this plugin (composition root / gateway).
* No `join` endpoint: the supported Talkdesk join control is unverified (TB-07);
  `CallDetailResponse.controls.join` reports availability only.
* No endpoint for safety-event acknowledgement, legal holds or policy source text; "inspect a
  source policy" is served by policy decision ids, reason codes and versions on the call
  timeline and by release diff summaries.
