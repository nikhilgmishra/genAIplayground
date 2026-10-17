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

## Immediate containment

1. **The caller comes first.** The telephony layer keeps the caller connected; on failure an approved update plays and the next staffed route is invoked (`fallbackDestinationIds` from trusted configuration). Never silently end the call; never leave the model improvising crisis counselling.
2. The safety responder on-call checks the safety queues in Talkdesk for the affected interaction and takes the call directly through supported Talkdesk controls.
3. If failures repeat, engage `AI_ADMISSION` (new AI sessions route to staffed queues through the independent Studio route); safety routes are exempt from switches, budgets and admission limits.
4. A numeric deadline never causes the system to abandon a vulnerable caller.

## Evidence preservation

* Preserve transfer records (`TransferRecord` states and timestamps), handoff package id, destination ids, vendor interaction ids, safety signal rule ids (never the caller's words), and queue state.
* Privacy counsel determines whether reporting obligations apply; the clinical safety lead decides clinical follow-up.

## Step-by-step actions

1. Identify the failing step: destination resolution, vendor transfer request, queue, receiver acceptance, bridge, caller-connected confirmation.
2. Destination misconfiguration → correct trusted destination configuration (never a caller- or model-supplied number, SAFE-05); configuration guard requires safety, human and continuity routes.
3. Receiver unavailable → support operations raises safety staffing; invoke after-hours or unavailable-responder procedure (clinical safety lead, VQ-OPS-02).
4. Vendor failure → Talkdesk administrator opens a priority vendor ticket; consider [vendor-behavior-change.md](vendor-behavior-change.md).
5. Reconcile every affected interaction: each one must end with a human-owned follow-up record, not `OUTCOME_UNKNOWN`.

## Verification

* Synthetic safety call in a non-production tenant reaches `CALLER_CONFIRMED_CONNECTED` through primary and fallback destinations (SF-T safety branch tests).
* `vsp_safety_time_to_routing_ms` back under the target; no failed handoffs in the observation window.

## Communication roles

Safety responder on-call (caller ownership); clinical safety lead; incident commander; SRE on-call; support operations lead (staffing); Talkdesk administrator; privacy counsel.

## Drill requirement

Required before patient-facing voice: receiver unavailable, dropped bridge and failed primary destination, in a sandbox tenant with synthetic personas, never against public crisis lines (spec section 10). Repeat each release that changes routing, destinations or the safety flow.
