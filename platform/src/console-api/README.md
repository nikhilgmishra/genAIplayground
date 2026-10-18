# platform/src/console-api: console API contract v1

Status: **IMPLEMENTED_OFFLINE (contract only)**. `contract.ts` defines the operations and
incident control console API (spec sections 6, 7, 12, 13 and 16). The React console
(`console/`) is built and tested against it with a labelled mock backend; **the backend
endpoints are not implemented in this directory yet**. Workforce SSO is BLOCKED (PRQ-036).
Nothing here has been verified against a vendor, a real IdP or production.

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
| `actions.pending`, `actions.cancel` | Action ledger (`platform/src/actions`); cancel endpoint not yet in `ActionService` (interface change requested) |
| `workflows.tasks`, `workflows.decision` | `WorkflowEngine.openTasks`; for a decision the backend calls `PgWorkflowEngine.issueTaskToken` and then `completeHumanTask` for the same authenticated staff member inside the one request, so the plaintext token never leaves the server. `completeHumanTask` takes no reason code yet (interface change requested); until then the reason is recorded in the console audit event |
| `safetyEvents.list` | `safety_events` rows written by `SafetyEventRecorder` (`platform/src/safety/safety-events.ts`) |
| `audit.search` | `auditedSearch` / `PgAuditQuery` (`platform/src/audit/query.ts`) |
| `calls.transfer`, `destinations.list` | `TransferCoordinator` (`platform/src/workflows/transfer.ts`), trusted `DestinationConfig` |
| `calls.list`, `calls.get`, `supportRequests.trace`, `overview`, `releases.*` | Not yet backed by a single port; compose from sessions, audit, support records, workflows, ops and the policy/knowledge release pipeline |

## Keeping the contract in sync

* `console/src/api/contract.test.ts` reads the platform sources as raw text and fails when
  `StaffRole`, `KillSwitchScope`, `TransferReason`, `KILL_SWITCH_ROLES`, `BUDGET_ROLES`,
  `GLOBAL_SCOPES`, `KILL_SWITCH_REASON` or `BUSINESS_ROLE_STAFF_MAPPING` drift from the contract.
* The backend should add type-level equality checks between its zod-inferred types and the
  interfaces here (for example `expectTypeOf<z.infer<typeof MeResponseSchema>>().toEqualTypeOf<MeResponse>()`).

## Known gaps

* No backend implementation of these endpoints yet (`platform/src/console-api` holds only the contract).
* No `join` endpoint: the supported Talkdesk join control is unverified (TB-07);
  `CallDetailResponse.controls.join` reports availability only.
* No endpoint for safety-event acknowledgement, legal holds or policy source text; "inspect a
  source policy" is served by policy decision ids, reason codes and versions on the call
  timeline and by release diff summaries.
