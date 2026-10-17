# RB-UNKNOWN-COMMIT Reconciliation and DLQ repair

| Field | Value |
|---|---|
| Runbook id | RB-UNKNOWN-COMMIT (aliases RB-CRM-RECONCILE, RB-DLQ-REPAIR) |
| Severity | SEV-2 (UNKNOWN commit outcomes); SEV-3 (CRM lag, DLQ backlog without caller impact) |
| Primary owner role | SRE on-call (repair operator: supervisor via console) |
| Last drilled | NEVER (not yet run) |
| Status | Draft; reconciliation logic exists offline (`platform/src/actions`, `platform/src/outbox`, `platform/src/workflows`); console repair flow PLANNED |

## Trigger and detection signals

* `<prefix>-unknown-commits` alarm: a commit outcome is UNKNOWN and must be reconciled before any retry or success message (`vsp_unknown_commits_total`).
* `<prefix>-crm-sync-lag` alarm: CRM synchronisation lag above the proposed target (`vsp_crm_sync_lag_ms`).
* SQS dead-letter alarms (`infra/terraform/modules/sqs`): dead-letter messages present for a queue.
* Dashboards `<prefix>-tools-dependencies` ("Unknown commits", "Backlogs") and `<prefix>-crm-reconciliation`.

## Immediate containment

1. Do **not** retry an UNKNOWN commit and do not tell anyone it succeeded. A timeout is not proof that nothing happened (ACT-03).
2. If UNKNOWN outcomes accumulate for one integration, engage `INTEGRATION` for it ([kill-switch-operations.md](kill-switch-operations.md)).

## Evidence preservation

Privacy counsel determines any reporting obligations and deadlines; the software preserves evidence and supports the process.

* Preserve the action ledger rows, idempotency keys, provider lookups and their results, outbox and DLQ messages (opaque references only), and audit events of each repair.

## Step-by-step actions

### UNKNOWN commit outcomes

1. For each UNKNOWN action, query the provider by its idempotency key or authoritative state (`ProviderCommitPort` lookup; for Salesforce, get by external id).
2. Result COMMITTED → record the commit evidence; the outcome becomes the committed state; the caller is informed through an approved channel if a promise was made.
3. Result NOT_STARTED or FAILED (authoritatively) → the action may be retried with the **same** idempotency key, or cancelled.
4. Lookup unavailable → keep UNKNOWN, assign a human task with owner and deadline; never guess.
5. Compensation, if needed, is domain-approved; reversing an appointment or payment is not automatically safe.

### CRM synchronisation lag and Salesforce reconciliation

1. Check Salesforce availability ([dependency-outage.md](dependency-outage.md)).
2. Each accepted support request with a support reference must map to exactly one Case by external id; upsert again only by external id (no duplicates; duplicate rules are not disabled broadly).
3. Restricted privacy or safety records go to restricted records, not broadly visible Cases.

### DLQ repair

1. Inspect DLQ messages through the PLANNED console repair flow (supervisor role); messages contain opaque references only.
2. Classify: transient failure (redrive), poison message (fix code or data, then redrive), obsolete (record and discard with audit event).
3. Redrive in small batches; consumers deduplicate, so redelivery creates no duplicate effect.
4. Preserve customer intent when callbacks fail or vendors redeliver webhooks.

## Verification

* `vsp_unknown_commits_total` back to zero outstanding; every former UNKNOWN action has a recorded resolution.
* DLQ empty; CRM lag within the proposed target; reconciliation dashboard shows one Case per support reference.

## Communication roles

SRE on-call; supervisor (repair operator); Salesforce administrator; business-system owners; support operations lead (caller follow-up).

## Drill requirement

Crash-after-commit, ambiguous timeout and duplicate-callback scenarios run in CI every release (ACT-02, ACT-03). Console repair flow drilled in a non-production environment before pilot.
