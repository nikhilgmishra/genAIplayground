# RB-RESTORE-DRILL Backup restore drill

| Field | Value |
|---|---|
| Runbook id | RB-RESTORE-DRILL |
| Severity | Drill (procedure) |
| Primary owner role | SRE lead |
| Last drilled | NEVER (not yet run) |
| Status | Draft; requires a deployed non-production environment (PRQ-037). No restore has ever been performed |

## Trigger and detection signals

Scheduled drill before broad release (spec section 12) and after any change to backup configuration, schema migrations or KMS keys. Unscheduled use: data corruption or accidental deletion detected on `<prefix>-platform` or by reconciliation.

## Immediate containment

For a real restore: engage `WRITES` ([kill-switch-operations.md](kill-switch-operations.md)) so no new mutations land on corrupted data; safety and human routes stay available.

## Evidence preservation

Privacy counsel determines any reporting obligations and deadlines; the software preserves evidence and supports the process.

* Record backup ids, snapshot times, restore start and end, data-loss window observed, and verification results as a `SECURITY_AUDIT` drill record.
* A restore creates derived copies; record them for the retention matrix (deletion verification applies).

## Step-by-step actions

1. Choose the restore point (Aurora point-in-time; DynamoDB point-in-time if enabled) in the non-production environment.
2. Restore to a new cluster or table; never over the live one.
3. Apply migrations check: the migrator refuses a changed applied migration; confirm schema version matches the release manifest.
4. Run integrity checks: audit verifier on restored audit outbox; reconcile action ledger against provider state (synthetic providers in drills).
5. Reconcile external side effects that happened after the restore point (UNKNOWN commits, Salesforce upserts) before reopening writes ([reconciliation-and-dlq-repair.md](reconciliation-and-dlq-repair.md)).
6. Measure elapsed time and data-loss window against the proposed objectives (application recovery within 15 minutes after a regional incident; cross-region data-loss objective no worse than five minutes; both subject to measured replication and contracts, PRQ-039).

## Verification

* Restored data passes integrity and reconciliation checks; measured times recorded honestly (a missed objective is recorded as missed).

## Communication roles

SRE lead; SRE on-call; security operations (evidence); business-system owners (reconciliation); incident commander (real restores).

## Drill requirement

At least once before broad release and after material backup or schema changes; cadence set by SRE lead and security leadership.
