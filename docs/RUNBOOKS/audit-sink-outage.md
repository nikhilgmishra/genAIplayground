# RB-AUDIT-OUTAGE Audit sink outage or integrity gap

| Field | Value |
|---|---|
| Runbook id | RB-AUDIT-OUTAGE (alias RB-AUDIT-GAP) |
| Severity | SEV-2 while the bounded local buffer holds; SEV-1 if durable evidence cannot be written or an integrity gap is found |
| Primary owner role | Security operations on-call (with SRE on-call) |
| Last drilled | NEVER (not yet run) |
| Status | Draft; audit health, shipper and verifier exist offline (`platform/src/audit`); live S3 Object Lock sink BLOCKED (PRQ-040) |

## Trigger and detection signals

* `<prefix>-audit-backlog-not-draining` alarm: the shipping backlog has not drained for 15 minutes (`vsp_audit_backlog_events`).
* `<prefix>-audit-ingestion-gap` alarm (critical): a sequence gap in audit ingestion (`vsp_audit_ingestion_gaps_total`).
* `<prefix>-audit-export-incomplete` alarm: completeness below 1 or not reported (`vsp_audit_export_completeness_ratio`).
* Dashboard `<prefix>-audit`; `AuditHealth.status()` reason codes `AUDIT_STORE_UNWRITABLE`, `AUDIT_BACKLOG_EXCEEDED`, `AUDIT_SINK_STALE`.

## Immediate containment

1. While the sink is down, the local durable outbox buffers within the bounded policy (backlog size and age).
2. When the bound is exceeded or the store is unwritable, `assertCanAcceptConsequential` fails and **consequential actions are blocked**; the platform **degrades to safe routing**. Safety and human routes are not blocked.
3. **Do not acknowledge a mutation and hope to log it later** (spec section 13). Do not raise the buffer bounds to make the alarm go away.
4. Consider engaging `WRITES` explicitly so callers get a consistent message ([kill-switch-operations.md](kill-switch-operations.md)).

## Evidence preservation

Privacy counsel determines any reporting obligations and deadlines; the software preserves evidence and supports the process.

* Preserve the local audit outbox, chain heads, manifests and purge watermarks; suspend purge (`purgeVerified`) until the incident closes.
* For an integrity gap, snapshot the local store and the sink listing before any repair; treat as a potential insider event (threat T-16) until shown otherwise; security leadership joins the reporting decision.

## Step-by-step actions

1. Sink unavailable (network, permissions, KMS, Object Lock configuration) → restore connectivity; the shipper resumes in sequence order and is idempotent across a crash between put and mark.
2. Store unwritable → treat as a database incident ([dependency-outage.md](dependency-outage.md)).
3. Ingestion gap or broken link → stop shipping for that stream (the shipper refuses to ship across a gap), run `IntegrityVerifier.verifyStream` and `verifyShipped`, reconcile counts against the action ledger (`reconcileCounts`), and document every missing or extra event. Completeness is PASS only when integrity, ingestion monitoring and reconciliation all ran clean (`assessCompleteness`).
4. Release blocks only after the backlog is within bounds and verification is clean.

## Verification

* Backlog drained; `audit-export-completeness` back to 1; verifier clean for every stream touched; reconciliation shows every accepted consequential action has an audit event.

## Communication roles

Security operations on-call; SRE on-call; incident commander (SEV-1); security leadership; privacy counsel; support operations lead (callers on safe routing).

## Drill requirement

Audit outage drill (sink down, store unwritable) with SYNTHETIC events before pilot, proving consequential actions block and safety routes continue; integrity-gap tabletop before production.
