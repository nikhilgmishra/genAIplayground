# platform/src/ops: kill switches, budgets, admission control (+ metrics, tracing, SLOs)

Status: **IMPLEMENTED_OFFLINE**. Verified against PGlite (real PostgreSQL in WASM)
only. Capacity and budget values are planning figures, not contracted capacity or
approved budgets.

## What is implemented

### Kill switches (`kill-switches.ts`, migration `0600_ops_kill_switches.sql`)

- Separate switches: `AI_ADMISSION` (new AI sessions), `INTENT`, `INTEGRATION`,
  `WRITES`, `MODEL_VERSION`, `VOICE_VERSION`, `OUTBOUND_NOTIFICATIONS`.
- `set()` requires a server-established `StaffActor` with **MFA** and role
  `supervisor` or `security_admin` (also `deployment_operator` for model/voice).
  Current state, an **append-only** history row and the `killswitch.set` audit
  event are written in **one transaction** (role `app_console`, tenant RLS); if the
  audit event cannot be written the change does not happen (OPS-01). Denied
  attempts are audited with outcome `DENIED`. Reasons are reason codes, optionally
  `CODE:<opaque incident id>`; free text is rejected (no PHI).
- History is append-only for every role including the owner (trigger on
  UPDATE/DELETE/TRUNCATE); only `app_console` may insert; `app_runtime` can only read
  current state.
- `snapshot()` (role `app_runtime`) **fails closed** to "all automation engaged" if
  state cannot be read. `killSwitchBlock()` never blocks `SAFETY` or `HUMAN_ROUTE`;
  `notificationAllowed()` never blocks safety-escalation paging.
- **Cache TTL trade-off**: `cacheTtlMs` defaults to **0** (read every time). A
  positive TTL (max 60 s) saves reads but an engaged switch may take up to TTL to
  reach other instances (this instance invalidates on its own writes). Staleness
  can delay containment; it can never block a safety or human route because those
  routes ignore switches.
- **Enforcement points beyond the gateway pipeline and admission** (composed in
  `platform/src/main/container.ts`):
  - `notification-gate.ts` — `KillSwitchGatedNotificationSender` wraps the
    NotificationSender port: every send (secure link, step-up link, OTP code) reads the
    snapshot and is refused before the provider is called when `OUTBOUND_NOTIFICATIONS` or
    `INTEGRATION notifications` is engaged, or the state is unreadable
    (`NotificationBlockedError`, DependencyError NOT_STARTED, reason
    `KILL_SWITCH_OUTBOUND_NOTIFICATIONS` / `KILL_SWITCH_INTEGRATION`). Only a sender composed
    with purpose `SAFETY_ESCALATION` (staff paging) is exempt; the purpose is fixed at
    composition, never per call (OPS-KS-01). The container also passes the same snapshot
    reader to the verification service (`notificationSwitches`, a required dependency), which
    applies the same `notificationBlock()` rule (purpose ROUTINE) before any account lookup,
    counter or throttle: while either switch is engaged or the state is unreadable, a
    secure-link, OTP or step-up begin answers `VERIFICATION_UNAVAILABLE_USE_HUMAN` (MCP
    `nextStep: HUMAN_VERIFICATION`, template `verification.failed_generic`, still DRAFT pending
    support-operations review) instead of "if eligible, a link/code was sent". The switch state
    is global, so the answer is identical for zero, one and many matches; the reason code is
    audit-only (`tool.invoke` `SUCCEEDED` over MCP, `verification.begun` `DENIED` over telephony
    control). This decision is made in the verification service, not by the pipeline's policy
    kill-switch check (the policy catalogue still maps `verification:begin` to
    `identity-directory` only). The gate here stays the enforcement point for the send itself:
    a begin that read the state just before the switch took effect still has its send refused,
    and that one caller hears the generic "if eligible" answer. Both decisions use the same
    INTEGRATION target only while the gate is composed without a custom `integrationId` (the
    container sets none). Composed tests: `notification-gate.test.ts`; details in
    `platform/src/identity/README.md` (OPS-KS-01).
  - `integration-gate.ts` — `KillSwitchGatedSupportRecords` wraps the Salesforce
    SupportRecordSystem port: upserts are held while `INTEGRATION salesforce` or `WRITES` is
    engaged, lookups while `INTEGRATION salesforce` is engaged, everything while the state is
    unreadable (`IntegrationHeldError`, NOT_STARTED). `holdReason()` lets the
    `support_request.sync` consumer check BEFORE claiming, so a held sync spends no attempt,
    makes no state transition and is never dead-lettered (the row records
    `last_sync_reason = KILL_SWITCH_*`, audited as `support_request.sync_held`); the worker's
    `support.sync_retry` sweep enqueues nothing while held and re-enqueues held rows after
    release (OPS-KS-02).
- Engaging a switch during a full audit outage is refused (fail closed). The
  containment path that remains in that case is the independent Talkdesk Studio
  human route, which does not depend on this service.

### Budgets (`budgets.ts`, migration `0601_ops_budgets.sql`)

- Budgets by environment / cohort / workflow / vendor (`*` = any), immutable
  versions (newest wins), integer micro-USD, append-only spend ledger.
- `statusFor()` returns every covering budget with projected spend =
  recorded + **metering delay x recent burn rate**, safety spend drawn from the
  **bounded safety reserve** first, `exhausted` when projected nonessential spend
  reaches `limit - reserve`, and `safetyReserveExceeded` for the escalation owner.
- `defineBudget()` requires MFA staff and is audited (`budget.define`) in the same
  transaction; the financial authority is the referenced approval record
  (`approvedBy`), reported as unapproved when null.

### Admission control (`admission.ts`, `capacity.ts`, `compose.ts`)

1. `SAFETY` and `HUMAN_ROUTE` are admitted **before any I/O**, regardless of budget,
   kill switches, capacity, degradation or malformed input; new sessions use the
   safety reserve, which is always granted (overdraw ⇒ `SAFETY_RESERVE_EXCEEDED_ESCALATE`
   + `vsp_safety_reserve_overdraw_total`, never a block) (SAFE-02, SAFE-03).
2. Kill switches (fail closed).
3. Load shedding: `ELEVATED` sheds ANALYTICS; `CONSTRAINED` also PUBLIC and
   PROTECTED_READ; `DEGRADED` also WRITE (route `OUTAGE_MESSAGE_THEN_HUMAN`). Tables
   are validated monotonic and can never shed SAFETY/HUMAN_ROUTE.
4. Budgets: missing budget, unreadable budget state or exhaustion ⇒ refused.
5. Capacity: bounded concurrent AI sessions (`maxConcurrentAiSessions`, planning
   figure 2000) with leases released via `releaseSession`.

Every refusal of caller-facing work carries `HUMAN_QUEUE`, `CALLBACK_INTAKE` (when
the human queue is not accepting) or `OUTAGE_MESSAGE_THEN_HUMAN`: **never a silent
drop** (OPS-02). Only ANALYTICS (no caller) is refused with `NONE`. `recordCost`
never throws for safety spend.

`createOpsServices(config, deps)` builds the services from `PlatformConfig.ops`
(required in staging/production).

### Observability pieces owned by this module (`platform/src/observability/`)

- `metrics.ts`: metric catalogue (name, type, unit, dashboard, label keys with
  closed enums) covering the section 13 dashboards; `InMemoryMetrics` (LOCAL
  FIXTURE; unknown names throw by default) and `OpenTelemetryMetrics` (bridge to
  `@opentelemetry/api` meters). Values outside a label's enum collapse to `other`,
  undeclared keys are dropped, prototype keys never match (DATA-01).
- `tracing.ts`: `createSafeTracer()`; span attributes pass an allowlist with value
  validators (session refs deliberately excluded); exceptions are not recorded,
  only reason codes; baggage writes throw and inbound baggage is stripped.
- `slo.ts`: the ten section 13 objectives as code (measurement point, numerator,
  denominator, exclusions, window, metric, breakdowns, report-separately items),
  every target **PROPOSED / not measured**; evaluators with nearest-rank
  P50/P95/P99, exclusions, windows, per-dimension breakdowns, minimum sample sizes
  (INCONCLUSIVE otherwise, OPS-03) and a zero-event 95 percent upper bound.

## LOCAL FIXTURE

`fixtures.ts` (`LocalFixtureKillSwitchService`, `LocalFixtureBudgetService`, in
memory, `kind: "local_fixture"`), `testing.ts` (in-transaction audit writer test
fixture, synthetic staff), `InMemorySessionCapacity` is per process.

## BLOCKED (prerequisite needed)

| Item | Prerequisite |
|---|---|
| Real capacity limit and safety reserve size | Contracted vendor concurrency/quotas (TB-10) and approval of the reserve by finance and the safety lead |
| Budgets, ceilings and metering delays | Vendor rate cards and finance-approved budgets (`approvedBy` approval records) |
| Multi-instance capacity counter | Shared counter design (e.g. DynamoDB conditional counter) once instance topology is approved |
| Automatic degradation thresholds | Load-test evidence (spec section 12); `ManualLoadSignal` is operator-controlled today |
| Metrics/traces export | Approved CloudWatch / Datadog configuration and PHI-aware export policy |
| SLO measurement | Real telephone-path measurements; all targets remain PROPOSED |
| Approved caller wording for the notifications-off human route (OPS-KS-01) | Support operations and the Talkdesk package owner: the composed LOCAL container answers `VERIFICATION_UNAVAILABLE_USE_HUMAN` with template `verification.failed_generic` (IMPLEMENTED_OFFLINE, see above), but that template is DRAFT pending support-operations review, and the Talkdesk package names a different Studio template for this response (`verification.unavailable_use_human`, not in the platform registry); one approved template id is needed |
| Kill-switch gates for other background provider calls and the console reconciled retry under WRITES (OPS-KS-02 follow-up) | Business / console-api owners; only the Salesforce support-record sync is gated here (the only background call into a switchable integration found by the review) |

## How to test

```
cd platform
npx vitest run src/ops src/observability/metrics.test.ts src/observability/tracing.test.ts src/observability/slo.test.ts
```

`notification-gate.test.ts` and `integration-gate.test.ts` include end-to-end cases over the
LOCAL FIXTURE composition (journey harness: real console API, MCP and telephony-control routes,
worker loops, Salesforce and notification fixtures).

## Requirements enforced

SAFE-02, SAFE-03 (safety and human routes always admitted; cost, kill switches and
capacity never terminate them), OPS-01 (kill-switch and budget changes audited in
the same transaction), OPS-02 (continuity route on every refusal; AI failure keeps a
usable route), OPS-03 (SLO evaluations inconclusive without evidence), DATA-01
(metric labels, span attributes, baggage, kill-switch reasons), AUTH-05 (tenant RLS),
spec sections 12 and 13.
