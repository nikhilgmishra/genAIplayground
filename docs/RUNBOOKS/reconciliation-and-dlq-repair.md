# RB-UNKNOWN-COMMIT Reconciliation and DLQ repair

| Field | Value |
|---|---|
| Runbook id | RB-UNKNOWN-COMMIT (aliases RB-CRM-RECONCILE, RB-DLQ-REPAIR) |
| Severity | SEV-2 (UNKNOWN commit outcomes); SEV-3 (CRM lag, DLQ backlog without caller impact) |
| Primary owner role | SRE on-call (repair operator: supervisor via console) |
| Last drilled | NEVER (not yet run) |
| Status | Draft; reconciliation logic exists offline (`platform/src/actions`, `platform/src/outbox`, `platform/src/workflows`); the console reconciliation, retry and dead-letter repair endpoints and the Reconciliation queue page exist and are tested offline (`platform/src/console-api`, `console/`) with LOCAL FIXTURE sign-in; workforce SSO BLOCKED (PRQ-036) |

## Trigger and detection signals

* `<prefix>-unknown-commits` alarm: a commit outcome is UNKNOWN and must be reconciled before any retry or success message (`vsp_unknown_commits_total`).
* `<prefix>-crm-sync-lag` alarm: CRM synchronisation lag above the proposed target (`vsp_crm_sync_lag_ms`).
* SQS dead-letter alarms (`infra/terraform/modules/sqs`): dead-letter messages present for a queue.
* Dashboards `<prefix>-tools-dependencies` ("Unknown commits", "Backlogs") and `<prefix>-crm-reconciliation`.

## Immediate containment

1. Do **not** retry an UNKNOWN commit and do not tell anyone it succeeded. A timeout is not proof that nothing happened (ACT-03).
2. If UNKNOWN outcomes accumulate for one integration, engage `INTEGRATION` for it ([kill-switch-operations.md](kill-switch-operations.md)). The worker's `actions.reconcile` lookups are not gated by that switch, so reconciliation continues.
3. An interruption while the commit is in doubt is durable: if the caller barged in, changed the request, the call ended or a safety escalation happened while the action was `COMMITTING` or `UNKNOWN`, the ledger holds an invalidation request on it. A NOT_FOUND reconciliation then ends the action `INVALIDATED`, never `CONFIRMED`; an effect that really happened still reconciles to `COMMITTED` (ACT-F1).

## Evidence preservation

Privacy counsel determines any reporting obligations and deadlines; the software preserves evidence and supports the process.

* Preserve the action ledger rows, idempotency keys, provider lookups and their results, outbox and DLQ messages (opaque references only), and audit events of each repair.

## Step-by-step actions

### UNKNOWN commit outcomes

1. For each UNKNOWN action, query the provider by its idempotency key or authoritative state (`ProviderCommitPort` lookup; for Salesforce, get by external id).
2. Result COMMITTED → record the commit evidence; the outcome becomes the committed state; the caller is informed through an approved channel if a promise was made.
3. Result NOT_FOUND (authoritatively not started) → a supervisor may retry it from the console (`reconciliation.retry`) with the **same** provider idempotency key, within 10 minutes of that console reconciliation, or cancel it. The ledger re-checks what the caller path checks (ACT-F3): the action is still `CONFIRMED` with no invalidation request; the caller's confirmation is still fresh (otherwise `CONFIRMATION_STALE` and the action expires); and the CALLER's current authority is re-established from server-side state (live, unrevoked session at the action's generation without a safety escalation, same actor and subject, current relationships, kill switches including `WRITES`, policy). Your console role never replaces the caller's authority. A refusal (`RETRY_NOT_ELIGIBLE`, `CONFIRMATION_STALE`, `SESSION_ENDED`, `SESSION_GENERATION_CHANGED`, `POLICY_DENIED`) is the correct outcome: create a human follow-up or contact the caller through an approved channel; never re-create the change by hand.
4. Lookup unavailable → keep UNKNOWN, assign a human task with owner and deadline; never guess.
5. Compensation, if needed, is domain-approved; reversing an appointment or payment is not automatically safe.
6. Intake tools (support request, complaint, partner intake) that timed out answer `UNKNOWN_OUTCOME`: the gateway keeps the replay reservation and settles it with the real result when the execution finishes (`tool.invoke` reason `LATE_SETTLEMENT`); a same-key retry gets `IDEMPOTENCY_IN_PROGRESS`, then the replay (ACT-F2). Do not create the record again under a new idempotency key; that is the path that still duplicates.

### CRM synchronisation lag and Salesforce reconciliation

1. Check Salesforce availability ([dependency-outage.md](dependency-outage.md)).
2. Each accepted support request with a support reference must map to exactly one Case by external id; upsert again only by external id (no duplicates; duplicate rules are not disabled broadly).
3. Restricted records go to restricted Cases, never broadly visible ones: clinical-question, privacy-concern and safety-concern handoffs, privacy complaints and safety records sync as a minimal RESTRICTED Case, and clinical-question records carry no subject link (DP-01). A restricted request found as a broadly visible Case is a privacy incident ([phi-exposure.md](phi-exposure.md)).
4. Requests held by a kill switch (state `PENDING`, `last_sync_reason = KILL_SWITCH_INTEGRATION` or `KILL_SWITCH_WRITES`) are not lag to repair; they sync after the switch is released.

### DLQ repair

1. Inspect dead letters in the console Reconciliation queue (supervisor, `dlq:repair`): outbox dead letters are requeued with `outbox.requeue`; a dead-lettered Salesforce sync is repaired with `supportRequests.repair` (back to `PENDING` with a fresh sync message and attempt budget, audited `support_request.repair_requeued`; a restricted request also needs a `restricted_record:view` break-glass grant). Messages contain opaque references only. SQS dead-letter redrive (`infra/terraform/modules/sqs`) has no console control.
2. Classify: transient failure (redrive), poison message (fix code or data, then redrive), obsolete (record and discard with audit event).
3. Redrive in small batches; consumers deduplicate, so redelivery creates no duplicate effect.
4. Preserve customer intent when callbacks fail or vendors redeliver webhooks.

## Verification

* `vsp_unknown_commits_total` back to zero outstanding; every former UNKNOWN action ended `COMMITTED`, `INVALIDATED`, cancelled, expired or with an owned human task.
* DLQ empty; CRM lag within the proposed target; reconciliation dashboard shows one Case per support reference.

## Communication roles

SRE on-call; supervisor (repair operator); Salesforce administrator; business-system owners; support operations lead (caller follow-up).

## Drill requirement

Crash-after-commit, ambiguous timeout and duplicate-callback scenarios run in CI every release (ACT-02, ACT-03). Console repair flow drilled in a non-production environment before pilot.
