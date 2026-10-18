# RB-FAILED-SAFETY-TRANSFER Failed or slow safety transfer

| Field | Value |
|---|---|
| Runbook id | RB-FAILED-SAFETY-TRANSFER (alias RB-SAFETY-ROUTE) |
| Severity | SEV-1 |
| Primary owner role | Safety responder on-call (with SRE on-call) |
| Last drilled | NEVER (not yet run) |
| Status | Draft; not executed against any real environment. Safety procedures are owned by the clinical safety lead (PRQ-008) |

## Trigger and detection signals

* `<prefix>-safety-handoff-failed` alarm (`vsp_safety_handoffs_total{result="failed"}`), page safety responder on-call.
* `<prefix>-safety-route-initiation` alarm: a validated safety event took longer than the engineering target (two seconds proposed) to initiate the priority route (`vsp_safety_time_to_routing_ms`).
* Dashboard `<prefix>-safety`: "Safety handoffs failed / receiver unavailable".
* Transfer state machine stuck before `RECEIVER_ACCEPTED` or `CALLER_CONFIRMED_CONNECTED`, or ended `OUTCOME_UNKNOWN` (TB-07 not evidenced).
* A bridge drop after `CALLER_CONFIRMED_CONNECTED` is not a stuck state: the journey returns to `ROUTING` (`connectedAt` cleared, so tools no longer report CONNECTED) and the `transfers.sweep` loop times out and re-dials the next route of the fallback chain (SAFE-HANDOFF-01). Repeated drops show as repeated attempts on one journey.
* A STANDARD journey still routing, prompting or dialling on a call that has an active SAFETY journey is a defect (SAFE-HANDOFF-02); the coordinator logs `TRANSFER_SUPERSEDE_RETRIES_EXHAUSTED` when eight conditional supersede writes conflicted.
* Console Safety events: every safety route (screening, model-raised `request_safety_route`, session-less, a human request in safety mode and a staff escalation) writes `safety_events` (`ROUTE_INITIATED`, `SIGNAL_VALIDATED`) and a `vsp_safety_time_to_routing_ms` sample (SAFE-HANDOFF-07). A safety transfer without a safety event is itself a defect.
* `429 RATE_LIMITED` on `request_safety_route` or `request_human_transfer` is a defect: these tools are classified before any rate limit and never throttled ([ADR-0012](../adr/ADR-0012-safety-routes-exempt-from-limits.md)).

## Immediate containment

1. **The caller comes first.** The telephony layer keeps the caller connected; on failure an approved update plays and the next staffed route is invoked (`fallbackDestinationIds` from trusted configuration). Never silently end the call; never leave the model improvising crisis counselling.
2. The safety responder on-call checks the safety queues in Talkdesk for the affected interaction and takes the call directly through supported Talkdesk controls.
3. If failures repeat, engage `AI_ADMISSION` (new AI sessions route to staffed queues through the independent Studio route); safety routes are exempt from switches, budgets, admission limits and tool-call rate limits.
4. **Safety supersedes standard journeys** ([ADR-0016](../adr/ADR-0016-safety-supersedes-standard-transfers.md)). When a safety route starts, every STANDARD journey of the call is marked `SUPERSEDED` (no further dials, prompts or failovers) and a human request in safety mode returns the safety route. A STANDARD dial already in flight at the vendor cannot be withdrawn (no cancel operation, TB-07): the safety responder on-call checks the interaction for a superseded STANDARD leg and takes the caller over through supported Talkdesk controls.
5. **Staff escalation.** A staff member who recognises a safety concern uses the console transfer with reason `SAFETY_PRIORITY` (or a destination whose purpose is `SAFETY_PRIORITY`). That takes the full safety route: the call's pending changes are revoked through the session and the ledger, `SAFETY_ESCALATION` is applied, a restricted safety record and safety events are written (SAFE-HANDOFF-05). A plain human transfer does not do this.
6. A numeric deadline never causes the system to abandon a vulnerable caller.

## Evidence preservation

* Preserve transfer records (`TransferRecord` states and timestamps), handoff package id, destination ids, vendor interaction ids, safety signal rule ids (never the caller's words), and queue state.
* Privacy counsel determines whether reporting obligations apply; the clinical safety lead decides clinical follow-up.

## Step-by-step actions

1. Identify the failing step: destination resolution, vendor transfer request, queue, receiver acceptance, bridge, caller-connected confirmation.
   * Bridge dropped after connection → confirm the journey re-entered `ROUTING` and the next route was dialled. Live transfer events are UNKNOWN (TB-07), so a drop the vendor does not report leaves the journey CONNECTED; the safety responder confirms the caller's state in Talkdesk.
2. Destination misconfiguration → correct trusted destination configuration (never a caller- or model-supplied number, SAFE-05); configuration guard requires safety, human and continuity routes.
3. Receiver unavailable → support operations raises safety staffing; invoke after-hours or unavailable-responder procedure (clinical safety lead, VQ-OPS-02).
4. Vendor failure → Talkdesk administrator opens a priority vendor ticket; consider [vendor-behavior-change.md](vendor-behavior-change.md).
5. Reconcile every affected interaction: each one must end with a human-owned follow-up record, not `OUTCOME_UNKNOWN`.

## Verification

* Synthetic safety call in a non-production tenant reaches `CALLER_CONFIRMED_CONNECTED` through primary and fallback destinations (SF-T safety branch tests, NOT_RUN).
* After a synthetic bridge drop the caller reaches a responder again; no STANDARD dial or update prompt follows the safety responder's connection; a console `SAFETY_PRIORITY` transfer leaves no committable pending action. Offline these are covered only by LOCAL FIXTURE tests (`platform/src/workflows/transfer.test.ts`, `platform/src/workflows/transfer.supersede-race.test.ts`, `platform/test/journeys/safety-handoff-regressions.test.ts`), not by a tenant.
* `vsp_safety_time_to_routing_ms` back under the target; no failed handoffs in the observation window.

## Communication roles

Safety responder on-call (caller ownership); clinical safety lead; incident commander; SRE on-call; support operations lead (staffing); Talkdesk administrator; privacy counsel.

## Drill requirement

Required before patient-facing voice: receiver unavailable, dropped bridge and failed primary destination, in a sandbox tenant with synthetic personas, never against public crisis lines (spec section 10). Repeat each release that changes routing, destinations or the safety flow.
