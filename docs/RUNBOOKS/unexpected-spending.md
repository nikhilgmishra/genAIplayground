# RB-UNEXPECTED-SPEND Unexpected spending

| Field | Value |
|---|---|
| Runbook id | RB-UNEXPECTED-SPEND |
| Severity | SEV-2 |
| Primary owner role | Finance and platform owner (with SRE on-call) |
| Last drilled | NEVER (not yet run) |
| Status | Draft; not executed against any real environment. No budgets or rate cards are approved yet (PRQ-010) |

## Trigger and detection signals

* `<prefix>-budget-burn` alarm: projected spend crossed the configured fraction of budget (`vsp_budget_utilization_ratio`). Alerts are not hard caps.
* Dashboard `<prefix>-cost-quotas`: spend, budget utilisation, quota utilisation, safety reserve overdraw (`vsp_safety_reserve_overdraw_total`, an alert, never a cap).
* Vendor billing notification, AWS Budgets notification, or a usage export showing growth not explained by traffic.
* `vsp_cost_record_failures_total` above zero (cost not being recorded; spend is understated).

## Immediate containment

1. Budget exhaustion already stops **new nonessential automation** and routes callers to approved continuity service (`AdmissionController`, `BudgetService`). Confirm it is happening.
2. **Never disconnect an active safety handoff** to enforce a financial limit; the approved safety reserve and escalation owner apply (SAFE-03).
3. For a runaway source, engage the narrowest [kill switch](kill-switch-operations.md): `INTENT` (one workflow), `INTEGRATION` (one vendor), `OUTBOUND_NOTIFICATIONS` (notification pumping; enforced on every send before the provider, OPS-KS-01), `MODEL_VERSION` (a costlier model), or `AI_ADMISSION`.
4. Stop any billable test runs; billable execution requires an approved `BILLABLE_TEST_EXECUTION` record and ceiling.

## Evidence preservation

Privacy counsel determines any reporting obligations and deadlines; the software preserves evidence and supports the process.

* Preserve budget status snapshots (spent, projected with metering delay, burn rate), admission decisions, kill switch changes and vendor usage exports.
* Record the approved budget and approval id in force at the time.

## Step-by-step actions

1. Attribute spend by environment, cohort, workflow and vendor (`BudgetService.statusFor`).
2. Compare against traffic (dashboard `<prefix>-call-flow`) and cost per verified resolution; distinguish real demand from abuse (OTP pumping, call floods, retries on top of retries, long calls stuck in loops). Tool floods from one call hit its per-call bucket (`429 RATE_LIMITED`, MCP batches counted per message); safety and human tools are never limited ([ADR-0012](../adr/ADR-0012-safety-routes-exempt-from-limits.md)).
3. Abuse → follow [authentication-bypass.md](authentication-bypass.md) or the challenge-abuse controls; retry storm → [dependency-outage.md](dependency-outage.md).
4. Real demand → finance decides whether to raise the budget (new approval record); engineering never raises it.
5. Vendor metering delay or fixed charges → note them in the incident record; prepaid balances and alerts are not guaranteed caps.

## Verification

* Burn rate back within budget; admission decisions show nonessential automation resumed only within the approved budget.
* Safety reserve not exceeded, or exceedance escalated to the owner.

## Communication roles

Finance and platform owner (decision); SRE on-call; incident commander (if abuse); vendor account teams; executive sponsor (budget changes).

## Drill requirement

Synthetic budget-exhaustion drill in a non-production environment before pilot, proving that nonessential automation stops while a synthetic safety handoff continues.
