# platform/src/gateway: trusted tool gateway, MCP adapter and HTTP surface

Status: **IMPLEMENTED_OFFLINE**. Everything here runs and is tested over PGlite, the OPA
WASM policy bundle, the identity services and LOCAL FIXTURE adapters with SYNTHETIC data.
Nothing has been connected to Talkdesk, a real IdP, a vendor sandbox or production, and
nothing here claims HIPAA compliance or production readiness. `tools/` holds the business
tool modules (definitions and execution); the pipeline owns everything around them.

## Files

| File | Responsibility |
|---|---|
| `pipeline.ts` | `ToolPipeline.invoke()` — the trusted request flow below. Never throws; every failure is a `ToolResult` with a reason code. |
| `catalog.ts` | Pinned catalogue: strict JSON Schemas from zod (`additionalProperties: false` at every level, no `patternProperties`), forbidden identity fields, deterministic sha256 digest, frozen lookup, committed-file parsing with tamper detection, drift check. |
| `generate-catalog.ts` | CLI writing `schemas/tools/catalog.json` from the business tool modules; `--check` fails on drift. Modules are built over a services object that throws on access, so definitions cannot depend on runtime data. |
| `mask.ts` | `applyFieldMask` (pure; prototype keys ignored; arrays element-wise). |
| `auth.ts` | `LocalFixtureTokenAuthenticator` (LOCAL FIXTURE, local/ci only) and `JwtAccessTokenAuthenticator` (issuer, audience, asymmetric algorithms, expiry, max age, clock tolerance, client id → integration, scope → channel). |
| `session-binding.ts` | TB-01 modes: `trusted_header` (`X-VSP-Session-Ref`), `server_to_server_lookup` (`X-VSP-Interaction-Id` → `InteractionLookup`), `tool_argument_lookup_exception` (refused without an approval id). |
| `gateway-audit.ts` | Content-free audit helper; the bearer session reference is always converted with `sessionBindingRefFor()`. |
| `call-state.ts` | Per-process session leases and handoff index; read-only pending-action lookup. |
| `mcp.ts` | MCP Streamable HTTP adapter (`POST /mcp`, stateless, JSON responses; `GET`/`DELETE` 405). Rate limited per JSON-RPC message; batches of at most `MCP_MAX_BATCH_MESSAGES` (10) dispatched one at a time, safety and human-route calls first. `tools/list` tool annotations from `mcpAnnotationsFor` (see "MCP tool annotations"). |
| `call-sessions.ts` | `InteractionIndexCallSessions`: server-side call -> live session resolution for safety routes without a session context (console escalation; used only to revoke and flag). LOCAL FIXTURE interaction index; live BLOCKED (TB-01). |
| `openapi.ts`, `generate-openapi.ts` | OpenAPI 3.1 document generated from the route definitions into `schemas/openapi/gateway.openapi.json`; `--check` fails on drift. |
| `http/route.ts`, `http/app.ts` | Route definitions (one source for Fastify and OpenAPI), auth hook before parsing, strict params/body, response validation, helmet, no CORS, body limit, per-integration rate limit (route buckets for everything except the two tool transports), generic errors, opaque request ids. |
| `http/tool-rate-limit.ts` | `ToolCallRateLimiter` for `POST /v1/tools/:name/:version` and `POST /mcp`: SAFETY_AND_HUMAN_ROUTE tools (from the pinned catalogue) classified before any limit and never throttled; every other tool call / MCP message counted in a per-call bucket and the per-integration ceiling (fixed windows, injected Clock, bounded key map, opaque keys only). |
| `http/tool-routes.ts` | `GET /v1/tools/catalog`, `POST /v1/tools/:name/:version`. |
| `http/telephony-routes.ts` | Telephony-control API (TC-01..TC-08, TC-10..TC-12, utterance screening, human request). |
| `http/portal-routes.ts` | Secure-link portal API (describe, approve, step-up). |
| `http/webhook-routes.ts` | `POST /v1/webhooks/transfer-events` (TC-09): LOCAL FIXTURE HMAC in local/ci only; elsewhere `403 WEBHOOK_AUTH_UNVERIFIED`. |
| `http/health-routes.ts` | `GET /health/live`, `GET /health/ready` (database, policy bundle, audit, config guard). |
| `fixtures/` | LOCAL TEST FIXTURES (fixture tools, harnesses). Not used by the composition root except the stub business in tests. |

## Pipeline steps

(a) integration identity: channel `mcp_tools`, tenant and environment match →
(b) catalogue lookup by exact name + pinned version (MCP: name only, single pinned version) →
(c) arguments: byte bound, no server-established identity fields anywhere, strict schema →
(d) session from the trusted binding only; failure denies protected tools, while
`SAFETY_AND_HUMAN_ROUTE` tools continue without a session (`executeWithoutSession`, SAFE-02:
`request_human_transfer` and `request_safety_route` call the HandoffService with `ctx: null`
and the call id from the trusted transport binding; without a trusted call id they answer
`PERMANENT_FAILURE CALL_UNIDENTIFIED_USE_STUDIO_ROUTE`; no speech without a session; the
`tool.invoke` audit event carries the session reason code and the transport call id) →
(e) regional write fence (`VSP_MUTATIONS_ENABLED`) →
(f) kill-switch snapshot (unreadable fails closed) →
(g) admission (budgets, capacity, load shedding; safety/human always admitted) →
(h) authoritative resource description under a timeout →
(i) relationships →
(j) OPA decision for every permission (deny by default) →
(k) tool-request idempotency (replay, key reuse, in progress, key required) →
(l) execution with timeout, per-dependency breaker and bounded retries (never for safety tools) →
(m) strict output (violation: read → PERMANENT_FAILURE, durable-record writer → UNKNOWN_OUTCOME),
field mask, speech directive pre-check (fallback `fallback.safe_explanation`) →
(n) audit (`tool.invoke`, binding ref, evidence pointers; AUDIT_READ data is withheld when
the append fails) →
(o) strict `ToolResult` and metrics/logs (content-free).

### Ambiguous outcomes of tools that write durable records (ACT-02, ACT-03; finding ACT-F2)

`writesDurableRecords(def)` is true for consequential commits, PREPARE_MUTATION, INTAKE and every
`IDEMPOTENCY_KEY_REQUIRED` tool (intakes create a support request, a grant, a workflow and a CRM
sync message even though they are not `consequential`). For such a tool an executed ambiguous
failure (`DependencyError UNKNOWN`, e.g. the pipeline timeout, an unclassified error, or an output
schema violation) is `UNKNOWN_OUTCOME` (reconciliation ref = request id), never
`RETRYABLE_FAILURE`, and its idempotency reservation is **kept** (not released). The timed-out
execution cannot be cancelled, so the pipeline keeps its promise and settles the reservation with
the REAL result when it completes (`tool.invoke` audit event with reason `LATE_SETTLEMENT`, same
correlation id); a same-key retry meanwhile gets `IDEMPOTENCY_IN_PROGRESS`, then the replay. A
still-ambiguous execution keeps the reservation until its lease expires; a re-execution after that is
reconciled by the business creation key, which is derived from the same transport idempotency key
(`business/services/intake.ts`). A provably-not-started failure stays `RETRYABLE_FAILURE`.
Known limit: `ToolModule.execute` takes no `AbortSignal` (gateway/ports.ts), so a timed-out
execution runs to completion; the result above is reported honestly as in doubt instead.

### One idempotency-key grammar; `tool.invoke` audit never silently dropped (OPS-01; finding VSP-GW-04)

`isAcceptedIdempotencyKey` = the published transport pattern (`^[A-Za-z0-9_-]{16,128}$`) AND the
audit writer's own key rule (`audit/schema.ts AuditWriterInput.shape.idempotencyKey`: first character
alphanumeric, no e-mail, phone, SSN or calendar-date shapes). A supplied key outside it is refused
before any session or policy work with `PERMANENT_FAILURE IDEMPOTENCY_KEY_INVALID` (audited without
the key); safety and human routes continue without the key (SAFE-02). If the writer still rejects a
`tool.invoke` event by schema (`AuditEventInvalidError`), that is not reported as an outage: it is
logged at error level (`gateway.audit.event_invalid`, field path and count only), counted
(`vsp_audit_events_rejected_total{source_component}`) and retried once minimized (no key,
grammar-valid evidence pointers only); an AUDIT_READ disclosure that still cannot be recorded returns
`PERMANENT_FAILURE AUDIT_EVENT_INVALID` (no data), not the retryable `AUDIT_UNAVAILABLE`. Tests:
`pipeline.transactions.test.ts`, `../../test/journeys/transactions.test.ts`.

### MCP tool annotations (ACT-02; findings ACT-F2 / R-08)

`tools/list` advertises the MCP `ToolAnnotations` derived from each pinned definition by
`mcpAnnotationsFor` (hints for the client only; the pipeline enforces everything). Per the MCP
specification `idempotentHint` means "calling again with the same ARGUMENTS has no additional effect".
The idempotency key is not an argument (it travels in `Idempotency-Key` or MCP `_meta.idempotencyKey`), and
since ACT-F2 an ambiguous intake timeout is `UNKNOWN_OUTCOME`: a retry with the same arguments and a new key
creates a second record. So:

`destructiveHint: false` claims "only additive updates" (the MCP default is `true`), so it is false only where
that holds:

| Tools | readOnly | destructive | idempotent | Why |
|---|---|---|---|---|
| PUBLIC_READ, PROTECTED_READ | true | false | true | no effect on the environment |
| INTAKE `create_support_request`, `submit_complaint`, `submit_partner_intake` (`IDEMPOTENCY_KEY_REQUIRED`) | false | false | **false** | insert-only (a new record); repeat-safety hangs on the SAME key, not on the arguments |
| INTAKE `begin_verification` (`IDEMPOTENCY_KEY_REQUIRED`) | false | **true** | **false** | a one-time-code begin makes its challenge the call's only outstanding one, so an earlier code stops working (`OTP_CHALLENGE_SUPERSEDED`, AUTH-OTP-LIMIT-01) |
| PREPARE_MUTATION (`IDEMPOTENCY_KEY_REQUIRED`) | false | **true** | **false** | a new prepared action supersedes the session's earlier `PREPARED` / `CONFIRMED` actions on the same record (they become `INVALIDATED`; an in-doubt one gets a durable invalidation request), `actions/action-service.ts` |
| COMMIT_MUTATION (`PREPARED_ACTION_DIGEST`) | false | **true** | true | the arguments are the action id + digest and the ledger replays the stored receipt; a commit changes existing records (reschedule, invoice state) |
| SAFETY_AND_HUMAN_ROUTE (`NATURALLY_IDEMPOTENT`: no key needed) | false | false | **false** | a repeat returns the active journey, but can write another handoff record or incident and re-apply the escalation; the existing state a route changes is protective (it revokes uncommitted prepared actions), and it is deliberately never marked destructive so it is never held behind a confirmation (SAFE-03) |

`openWorldHint` is false for every tool (only the enumerated, allowlisted systems). `_meta["vsp/idempotency"]`
names the catalogue's retry mechanism (not the MCP hint), so a client can tell that an
`IDEMPOTENCY_KEY_REQUIRED` retry must reuse its key. Before this change every tool, intakes included,
advertised `idempotentHint: true` and `destructiveHint: false`. The annotations are computed at runtime from
the pinned definitions (`begin_verification` is named in `SUPERSEDING_INTAKES`); the committed catalogue
(`schemas/tools/catalog.json`) and its digest are unchanged. Whether the Talkdesk client honours annotations
is UNKNOWN (VQ-TD-26). Tests: `mcp.test.ts`.

### Notifications switched off: `begin_verification` offers the human route (OPS-KS-01)

While `OUTBOUND_NOTIFICATIONS` or `INTEGRATION notifications` is engaged (or the switch state is
unreadable) the verification service (composed with the kill-switch reader `notificationSwitches`) answers
`VERIFICATION_UNAVAILABLE_USE_HUMAN` before any lookup (`platform/src/identity/README.md`), so
`begin_verification` returns `nextStep: HUMAN_VERIFICATION` with the `verification.failed_generic` template
(registry status DRAFT, pending support-operations review), and the telephony-control begin
(`POST /telephony/v1/session/verification`) returns the same response with `speechTemplateId
verification.failed_generic` and no match code: identical for real and unknown people. The switch
reason is audit evidence only: a tool may attach `auditReasonCode` to a SUCCESS outcome
(`ports.ts`; only for causes identical for every caller), which the pipeline writes as the `tool.invoke`
reason code (a pipeline-owned reason such as the session reason or `LATE_SETTLEMENT` wins) and never
returns; the telephony route records `verification.begun` as `DENIED` with that reason instead of
`PENDING`. The policy catalogue still does not map `verification:begin` to the `notifications`
integration, so policy allows the begin and the service decides. Tests: `tools/verification.test.ts`
(real pipeline, policy and audit), `http/routes.test.ts`; both use the gateway test harness, which passes
its kill-switch reader to the service. Over the composed LOCAL container (both paths, console-engaged
switch): `ops/notification-gate.test.ts`.

### `vsp_protected_actions_total` audit label (OPS-01; finding OPS-AUD-01)

An accepted (`SUCCESS`/`PENDING`) consequential call increments
`vsp_protected_actions_total{authorization, audit}`. The `audit` label comes from the `tool.invoke`
append for that result: `recorded_before_ack` when the event was durably appended before the result
was returned (`auditEventId` set), `not_recorded` when the append failed (`auditEventId` null). A
replay uses the stored result's `auditEventId`. A commit has no AUDIT_READ obligation, so a failed
`tool.invoke` append does not block it; the gap is counted instead, and the `audited_accepted_actions`
objective and the "Protected actions without decision or audit" panel can fall below 100%. The
metric covers the gateway's `tool.invoke` record only. The ledger's own `action.commit.*` event is
written in the commit transaction and is reconciled by the audit verification loop
(`audit/monitor.ts`), not by this label. Tests: `pipeline.audit-metric.test.ts`.

## Commands

```
npx tsx src/gateway/generate-catalog.ts [--check]   # schemas/tools/catalog.json
npx tsx src/gateway/generate-openapi.ts [--check]   # schemas/openapi/gateway.openapi.json
```

(`platform/package.json` is not owned by this module; script aliases are an interface
change request.)

## Tests of note

* `../main/sessionless-routing.test.ts` — SAFE-02 end to end over the LOCAL container with
  the real business module: no, an expired and a revoked session, over the HTTP tool route
  and the real MCP SDK client on 127.0.0.1; both routing tools route to an allowlisted
  destination and are audited; every other catalogue tool fails closed with the session
  reason code and has no effect.

## Changes after wave 2

* Tool permissions: `get_appointment_options` → `appointment:list_options` (options carry
  the opaque `slotId`; `prepare_appointment_change` accepts an optional `slotId`),
  `prepare_billing_review` → `billing:prepare_review` (no proposal digest any more).
* `submit_complaint` output gains `linkedToAccount`; `create_support_request` resolves a
  representative's link to the represented subject (purpose `representative_access`);
  `get_provider_onboarding_status` uses the provider record's practice organization.
* `begin_verification` speaks the secure-link match code through the DRAFT template
  `verification.secure_link_match_code` (voice slot type `match_code`).
* The tool catalogue was regenerated (`TOOL_CATALOG_VERSION` `2026-10-18.2`).
* A denied invocation without a session records the transport call id in its `tool.invoke`
  audit event (evidence only, never authority).

## BLOCKED / UNKNOWN

* TB-01 session transport: which mode Talkdesk supports is UNKNOWN; local uses
  `trusted_header`. The server-to-server interaction lookup is a LOCAL FIXTURE
  (`BlockedInteractionLookup` outside local/ci, PRQ-013/PRQ-034).
* Inbound OAuth2: `JwtAccessTokenAuthenticator` is tested only against a local JWKS; issuer,
  audience, JWKS URI and client ids are UNKNOWN, and the committed configs carry no
  `gateway.inboundAuth` section, so no deployed environment starts.
* TB-03 OTP is disabled by default (`OTP_DISABLED_TB03`).
* TB-07 / TB-09 transfer events: Talkdesk's webhook authentication is not documented; only
  the LOCAL FIXTURE HMAC is accepted, and only in local/ci.
* Leases, the handoff index and the turn tracker are per process (a multi-task deployment
  needs a shared store).

## Changes in wave 4

* **TC-07** reads the session's ledger entries through `ActionService.listForSession` (no direct
  SQL); the most recent unexpired PREPARED action of the current generation is rendered. Slot values
  come from `BusinessModule.confirmationSlots` (typed values from the authoritative action; an
  appointment change previously always failed to render because its change fields are not the
  template's slot names, which routed every confirmation to a human).
* **TC-11** gathers outcome evidence server-side only: COMMITTED receipts from `listForSession`,
  REQUEST_ACCEPTED support requests from `SupportRequestService.listForCall`, the call's transfer
  journey (`journeyOutcome`: TRANSFERRED only after CALLER_CONFIRMED_CONNECTED; staffed routes
  exhausted => failed) and the pipeline's `CallOutcomeTracker` flags (information provided, policy
  declined). Studio's `reason` is only the hang-up signal. The outcome service infers the contract
  from the call's verified committed actions.
* **TC-12** returns the support reference of the indexed handoff. The `HandoffIndex` is fed by the
  HandoffService observer (`ToolDeps.handoffObserver`), so MCP handoffs with or without a session
  are indexed.
* **Utterance screening** records the incident in `safety_events` (`SafetyEventRecorder`) after the
  priority route was requested (route first, then evidence); the `safety.signal` audit event is
  now written after the route request as well.
* `PgPendingActionLookup` was removed (replaced by `listForSession`).

## Changes in wave 5 (business-correctness fixes)

* **TC-11 without a live session.** When the session no longer resolves (expired, revoked, ended
  elsewhere), the call still gets an interaction outcome (ACT-04): the call is identified only by the
  authenticated Studio identity's `X-VSP-Interaction-Id` AND the start-call binding TC-01 recorded for
  this tenant and integration (`InteractionLookup`); a bearer reference, when sent, must be exactly
  that call's session. The session is marked ended, pending actions are invalidated, the outcome is
  recorded from server-side evidence (`gatherOutcomeEvidence`) and `session.ended` is audited with
  the session-failure reason. An unknown call, another call's session, a repeated end or an
  unavailable lookup (live: `BlockedInteractionLookup`) records nothing (`ended: false`).
* **Commit unsettled at call end.** The outcome service (business/outcomes.ts) returns
  `OUTCOME_UNKNOWN` / `COMMIT_OUTCOME_UNKNOWN` for a call action still COMMITTING / UNKNOWN in the
  ledger (or committed but not yet recorded for the call) and appends a revision when the reconciler
  commits it (see business README).
* **`get_appointment_options`** with `appointmentId: null` by a **provider** is the provider's own
  schedule: purpose `caller_self_service`, resource `appointment_options` on the provider's own
  subject, classification INTERNAL (policy path `provider_own_schedule`, self fact with enrollment
  scope `appointment:list_options`); only that provider's open slots are returned, never a client's
  appointment. With an appointment id a provider still needs a treating relationship (PHI).
* **`get_invoice_status`** takes an optional typed selector `line: { chargeCode, amountMinor } | null`
  (strict; at least one non-null; only with `LINE_EXPLANATION`): the explanation targets exactly the
  one matching line, otherwise no line is explained (balance facts). Line ids are not offered (outside
  the `invoice:read` field mask).
* **`create_support_request`** by an organization role with `linkToAccount` links the request to
  the caller's organization (authorized by the organization's `case:read` path at creation), so
  `get_authorized_case_status` finds it; a refused link denies the request.
* Tool catalogue regenerated: `TOOL_CATALOG_VERSION` `2026-10-18.3`; OpenAPI regenerated (TC-11
  summary).

## Safety-handoff review fixes (SAFE-HANDOFF-03, VSP-GW-01, VSP-GW-03, SAFE-HANDOFF-07)

* **Tool rate limiting never throttles the safe route.** The generic route limiter used to put
  every call of a Talkdesk integration into one bucket per route, so routine tool traffic of other
  calls turned `request_safety_route` / `request_human_transfer` into `429 RATE_LIMITED` on both
  `/v1/tools` and `/mcp` (the header comment claimed the opposite). Now `buildGatewayApp` creates a
  `ToolCallRateLimiter` whenever the per-integration limit is on and the two tool transports are
  metered by it: the tool name is classified from the pinned catalogue BEFORE any limit
  (SAFETY_AND_HUMAN_ROUTE => exempt, never counted); everything else takes a token from its call's
  bucket (trusted `X-VSP-Interaction-Id`, else the session-reference hash) and from the
  per-integration ceiling. Default per-call share: `max(min(ceiling, 120), floor(ceiling / 5))`
  per window (engineering default pending SRE capacity review, TB-10; `perCallRateLimit` overrides).
  The production ceiling itself (600/min default, per process) still has to be sized against the
  capacity model; that is configuration, not code (see the report's known gaps).
* **MCP batches are counted per message.** A JSON-RPC array is accepted (older protocol revisions)
  only up to 10 messages (`400 -32600` above, or when empty, before any tool runs); every message is
  admitted on its own and dispatched sequentially through a fresh stateless server/transport (no
  100-way concurrent fan-out); a throttled message gets its own JSON-RPC error
  (`MCP_RATE_LIMITED_CODE` -32029) while the others still run; a single throttled message answers
  HTTP 429 `RATE_LIMITED` as before. Rate-limit headers report the most restrictive metered decision.
* **Tool status after a bridge drop (SAFE-HANDOFF-01).** `routing.ts` `statusOf` reports CONNECTED
  only when the journey's `connectedAt` is set (a dropped bridge is TRANSFER_REQUESTED again).
* **Safety evidence.** `request_safety_route` (with or without a session) now produces safety_events
  and the time-to-routing metric through the HandoffService (`ToolDeps.safetyEvents`, composed in the
  container with the same recorder the screening route uses); the screening route records only when
  the HandoffService did not (`HandoffResult.safetyEventRecorded`). A human request routed as SAFETY
  is indexed with that priority (`HandoffResult.priority`) for TC-12.
* **Clinical-boundary audit minimization (DP-01).** The subject-linked `safety.clinical_boundary`
  audit event carries the generic reason code `CLINICAL_BOUNDARY_ROUTE`; the specific category stays
  in the content-free, subject-free `safety_events` row and the Studio response.
* OpenAPI regenerated (summaries of `tools.invoke` and `mcp.post`).
