# RB-DEPENDENCY-OUTAGE Dependency outage (including Salesforce outage)

| Field | Value |
|---|---|
| Runbook id | RB-DEPENDENCY-OUTAGE (alias RB-TOOL-LATENCY) |
| Severity | SEV-2 (SEV-1 if the safe telephone route is affected) |
| Primary owner role | SRE on-call |
| Last drilled | NEVER (not yet run) |
| Status | Draft; not executed against any real environment |

## Trigger and detection signals

* `<prefix>-gateway-no-healthy-targets` (critical) and `<prefix>-ingress-5xx-rate` (high) alarms; Studio's independent human route must carry callers.
* `<prefix>-tool-latency-p95` alarm (tool-backed response P95 above the proposed target).
* Dashboard `<prefix>-tools-dependencies`: dependency errors (`vsp_dependency_errors_total`), dependency health, circuit transitions (`vsp_circuit_transitions_total`), bulkhead rejections.
* Dashboard `<prefix>-crm-reconciliation`: CRM reconciliation failures and sync lag (Salesforce).
* Aurora or DynamoDB errors and throttles (dashboard `<prefix>-platform`).

## Immediate containment

1. Confirm callers are still routed: Studio's independent route to humans does not depend on the gateway, model or policy decision (spec section 3).
2. Circuit breakers and bulkheads isolate the failing dependency automatically; do not add manual retries on top of automatic ones (no retry stacking).
3. Engage `INTEGRATION` for the failing integration if it flaps; engage `WRITES` if the business ledger (Aurora) is impaired — a database outage blocks protected reads and writes while the telephone route stays usable.
4. Load-shed noncritical analytics and model work first (admission degradation levels in `platform/src/ops`).

## Salesforce outage specifically

* Accepted support requests are persisted as encrypted internal support requests with a support reference (`SR-XXXX-XXXX`), and callers are told it is a **support reference pending synchronisation**, never an invented Salesforce Case number.
* The `support_request_sync` workflow retries with bounded backoff; items exceeding the retry budget go to the DLQ and the CRM repair human task.
* After recovery, reconcile with [reconciliation-and-dlq-repair.md](reconciliation-and-dlq-repair.md): upsert by external id (no duplicates), confirm every support reference maps to exactly one Case, and preserve customer intent when callbacks fail or webhooks are redelivered.

## Evidence preservation

Privacy counsel determines any reporting obligations and deadlines; the software preserves evidence and supports the process.

* Preserve circuit transitions, dependency error counts, queue ages, DLQ contents (opaque references only) and the list of affected support references.
* No PHI in incident tickets; use opaque ids.

## Step-by-step actions

1. Identify the dependency from dashboards; check vendor status pages through the vendor account team.
2. If the gateway itself is unhealthy: check recent deploys; roll back to the last known-good release (`deployment_operator`).
3. If a business system is down: affected intents degrade to intake and callback; consider `INTENT` switches to stop offering them.
4. Track UNKNOWN commit outcomes created during the outage; none may be retried or announced as success before reconciliation (ACT-03).
5. After recovery, release switches one at a time and watch the dashboards.

## Verification

* Dependency health green; circuit closed; backlog drained.
* CRM reconciliation dashboard: every accepted support request synchronised or in an owned repair task.
* No duplicate effects (`vsp_duplicate_effects_total` stays zero).

## Communication roles

SRE on-call; incident commander (if SEV-1); support operations lead (queue load, wait messages); Salesforce or Talkdesk administrator (vendor tickets); business-system owners; communications lead.

## Drill requirement

Fault-injection drill per dependency (timeouts, outage, partial writes, crash after external commit) with SYNTHETIC fixtures before Phase 3; Salesforce outage drill with reconciliation before pilot.
