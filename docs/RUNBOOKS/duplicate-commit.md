# RB-DUPLICATE-COMMIT Duplicate consequential effect

| Field | Value |
|---|---|
| Runbook id | RB-DUPLICATE-COMMIT |
| Severity | SEV-1 (unauthorised or unintended mutation) |
| Primary owner role | SRE on-call (with the business-system owner) |
| Last drilled | NEVER (not yet run) |
| Status | Draft; not executed against any real environment |

## Trigger and detection signals

* `<prefix>-duplicate-effects` alarm (`vsp_duplicate_effects_total` above zero; target zero in required failure and retry tests).
* Business-system owner or caller reports two appointments, two billing reviews, two Cases or two notifications for one request.
* Reconciliation finds two provider references for one action id or idempotency key.

## Immediate containment

1. Declare SEV-1. Engage `INTEGRATION` for the affected integration or `INTENT` for the affected workflow; engage `WRITES` if the cause is unclear ([kill-switch-operations.md](kill-switch-operations.md)). Safety and human routes stay available.
2. Pause the outbox dispatcher or worker consumer for the affected topic if redelivery is the cause (operator action, PLANNED console control).

## Evidence preservation

Privacy counsel determines any reporting obligations and deadlines; the software preserves evidence and supports the process.

* Preserve action ledger rows (action id, idempotency key, digest, state transitions), outbox messages and delivery attempts, consumer dedup records, provider receipts and audit events.
* Preserve the timeline of retries, timeouts and crashes from content-free logs.

## Step-by-step actions

1. Determine the duplication point: retry after an ambiguous timeout without reconciliation (ACT-03), an intake retried under a NEW idempotency key after `UNKNOWN_OUTCOME` (a same-key retry replays, ACT-F2), consumer without dedup, provider without idempotency-key support (PRQ-007), Salesforce upsert without the external id, or two prepared actions confirmed separately.
2. Fix the cause and add a regression test tagged `[ACT-02]` reproducing the sequence (retry, redelivery or crash after commit).
3. Remediate the duplicate only through a **domain-approved compensation** with the business-system owner. Reversing an appointment or payment is not automatically safe; it may need caller contact by a human.
4. Record the remediation as a new prepared and confirmed action (human-confirmed), never as a silent deletion.

## Verification

* The regression test creates no duplicate effect.
* Reconciliation shows one provider reference per action id for the affected window.

## Communication roles

Incident commander; SRE on-call; business-system owner; support operations lead (caller contact); privacy counsel (if a duplicate disclosure occurred).

## Drill requirement

Retry, redelivery and crash-after-commit tests run in CI every release (ACT-02). Sandbox drill per provider once live adapters exist.
