# RB-AI-OFF-ROUTE AI-off route and outage service mode

| Field | Value |
|---|---|
| Runbook id | RB-AI-OFF-ROUTE (alias RB-ADMISSION) |
| Severity | SEV-2 (SEV-1 if staffed safety capacity is insufficient) |
| Primary owner role | Support operations lead (with SRE on-call) |
| Last drilled | NEVER (not yet run) |
| Status | Draft; not executed against any real environment. Staffing, wait thresholds and overflow targets are UNKNOWN (PRQ-009, VQ-OPS-03) |

## Trigger and detection signals

* `<prefix>-admission-rejections` alarm: admission control routed callers to continuity service (dashboard `<prefix>-admission-controls`).
* AI layer unavailable or contained: `AI_ADMISSION` kill switch engaged, Talkdesk AI Agent Platform incident, model or voice version withdrawn, budget exhaustion.
* Dashboard `<prefix>-call-flow`: human demand, queue age and abandonment rising.

## Context

Human capacity is finite. With the illustrative figures in [`../capacity-cost-model.md`](../capacity-cost-model.md),
a 20 % handoff rate implies about 150 continuously busy agents in the busy hour (roughly 268
scheduled), while a sudden 100 % AI outage would need about 750 continuously busy agents. A small
residual queue cannot absorb that; do not claim seamless human fallback unless staffed capacity
exists (spec section 12).

## Immediate containment

1. Confirm the **independent Studio route to humans** is carrying calls (it needs no model, gateway or policy decision).
2. Enter **outage service mode**:
   * prioritised **safety** and **urgent access** queues first (safety routes are exempt from every switch, budget and admission limit);
   * limited administrative intake (minimal unverified intake and support references);
   * **consented callback** where the caller agrees (callback feature availability UNKNOWN, VQ-TD-40);
   * **realistic wait messages** from approved templates; never promise a time that staffing cannot meet;
   * **vendor overflow arrangements** if contracted (UNKNOWN).
3. Support operations lead requests additional staffing per the outage staffing plan (to be supplied, PRQ-009).
4. A whole-Talkdesk outage needs the separately contracted carrier or continuity arrangement (PRQ-049); AWS failover does not help.

## Evidence preservation

Privacy counsel determines any reporting obligations and deadlines; the software preserves evidence and supports the process.

* Preserve admission decisions, kill switch history, queue age and abandonment series, callback records and the staffing actually available.

## Step-by-step actions

1. Record the start time and reason in the incident record.
2. Engage `AI_ADMISSION` if not already engaged ([kill-switch-operations.md](kill-switch-operations.md)).
3. Switch Studio to the outage-mode routing (Talkdesk administrator; flow defined in `talkdesk/studio-flow-spec.md`).
4. Monitor safety queue age continuously; escalate to the incident commander if safety queue age rises.
5. When AI service recovers, release `AI_ADMISSION` gradually (cohort percentage or calls per day), watching error, latency and safety dashboards.
6. Work the callback backlog to completion; each callback has an owner and a deadline.

## Verification

* All safety calls connected to a human during the episode.
* Callback backlog cleared; abandonment returns to baseline.

## Communication roles

Support operations lead (staffing and messages); SRE on-call; safety responder on-call; incident commander; Talkdesk administrator; communications lead (status messaging).

## Drill requirement

Prove the AI-off route under realistic staffing assumptions before pilot (spec section 15 phase 3): a scheduled exercise in a sandbox tenant with synthetic callers, then a supervised production exercise once approved. Repeat after staffing model or Studio routing changes.
