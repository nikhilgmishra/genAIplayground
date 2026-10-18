# RB-AUDIT-OUTAGE Audit sink outage or integrity gap

| Field | Value |
|---|---|
| Runbook id | RB-AUDIT-OUTAGE (alias RB-AUDIT-GAP) |
| Severity | SEV-2 while the bounded local buffer holds; SEV-1 if durable evidence cannot be written or an integrity gap is found |
| Primary owner role | Security operations on-call (with SRE on-call) |
| Last drilled | NEVER (not yet run) |
| Status | Draft; audit health, shipper, the `audit.verify` completeness monitor and the deferred route-audit queue exist and are tested offline (`platform/src/audit`, `platform/src/worker`); the live S3 Object Lock sink and its read-only verifier role are BLOCKED (PRQ-037, PRQ-040) |

## Trigger and detection signals

* `<prefix>-audit-backlog-not-draining` alarm: the shipping backlog has not drained for 15 minutes (`vsp_audit_backlog_events`).
* `<prefix>-audit-ingestion-gap` alarm (critical): a finding of the worker loop `audit.verify` (sequence gap, rewritten or missing row, a committed ledger action without its commit audit event), **or verification not reporting**: the loop emits `vsp_audit_ingestion_gaps_total` with a zero heartbeat every run (default 60 s) and the alarm treats missing data as breaching (OPS-AUD-01).
* `<prefix>-audit-export-incomplete` alarm: completeness below 1 or not reported for 15 minutes (`vsp_audit_export_completeness_ratio`: shipped events / events older than the export grace).
* Dashboard `<prefix>-audit`; `AuditHealth.status()` reason codes `AUDIT_STORE_UNWRITABLE`, `AUDIT_BACKLOG_EXCEEDED`, `AUDIT_SINK_STALE`.
* Panel "Protected actions without decision or audit": `vsp_protected_actions_total{audit="not_recorded"}` above zero means an accepted consequential call's `tool.invoke` append failed (the commit's own ledger event is reconciled by `audit.verify`).
* `vsp_audit_events_rejected_total` above zero: the audit writer refused an event by schema (VSP-GW-04). That is a code defect, not an outage; the event was retried once minimised.
* `vsp_audit_deferred_depth` above zero or `vsp_audit_deferred_total{result="dropped"}`: handoff route audit events queued during an outage, or dropped because the bounded queue overflowed ([ADR-0011](../adr/ADR-0011-deferred-route-audit.md)). No dashboard panel or alarm exists for these yet.

## Immediate containment

1. While the sink is down, the local durable outbox buffers within the bounded policy (backlog size and age).
2. When the bound is exceeded or the store is unwritable, `assertCanAcceptConsequential` fails and **consequential actions are blocked**; the platform **degrades to safe routing**. Safety and human routes are not blocked: their handoff audit events go to the bounded, process-local deferred queue and the worker loop `audit.deferred_flush` appends them in order, each followed by an `audit.deferred.recorded` marker, once the store is writable again. A restart of the process holding that queue loses its events (the `safety_events` row stays the durable record of a safety route), so do not restart it as a first response.
3. **Do not acknowledge a mutation and hope to log it later** (spec section 13). Do not raise the buffer bounds to make the alarm go away.
4. Consider engaging `WRITES` explicitly so callers get a consistent message ([kill-switch-operations.md](kill-switch-operations.md)).

## Evidence preservation

Privacy counsel determines any reporting obligations and deadlines; the software preserves evidence and supports the process.

* Preserve the local audit outbox, chain heads, manifests and purge watermarks; suspend purge (`purgeVerified`) until the incident closes (the worker does not schedule purge today; do not run it by hand during the incident).
* Keep the `audit.verify` run details and error-level logs for the window (finding codes and counts only).
* For an integrity gap, snapshot the local store and the sink listing before any repair; treat as a potential insider event (threat T-16) until shown otherwise; security leadership joins the reporting decision.

## Step-by-step actions

1. Sink unavailable (network, permissions, KMS, Object Lock configuration) → restore connectivity; the shipper resumes in sequence order and is idempotent across a crash between put and mark.
   * **HTTP 412 on re-put (OPS-AUD-02).** After a lost `PutObject` response or a crash before the local mark, the re-put of the same batch gets 412 on its deterministic key. With the default `existingObjectCheck: "defer_to_verifier"` the writer accepts it without reading (the writer role is denied `s3:GetObject*` and `kms:Decrypt`), counts it in `existingObjectsUnverified` (in-process counter, not a metric) and moves on; the read-only verifier identity later proves the stored content with `verifyShipped`, and local rows are purged only after a clean verification. If every retry still ends `AUDIT_SINK_UNAVAILABLE`, check that the sink is not configured with `head_checksum`, which needs HeadObject and `kms:Decrypt` that the writer role does not have.
   * A verifier finding `MANIFEST_DIGEST_MISMATCH`, `MANIFEST_CONTENT_MISMATCH` or `LOCAL_SINK_DIVERGENCE` after a 412 means a foreign or stale object sits at our key (for example sequence reuse after a database restore): handle it as an integrity gap (step 3) and keep the local rows.
2. Store unwritable → treat as a database incident ([dependency-outage.md](dependency-outage.md)).
3. Ingestion gap or broken link → stop shipping for that stream (the shipper refuses to ship across a gap). `audit.verify` already runs `verifyStream`, `verifyShipped` (when it has a sink reader), the writer chain-head counts and the keyed reconciliation of committed ledger actions every run; read its verdict and finding codes, re-run the checks for the affected streams, and document every missing or extra event. Completeness is PASS only when integrity, ingestion monitoring and reconciliation all ran clean (`assessCompleteness`); without a sink reader the verdict is INCONCLUSIVE (`SHIPPED_INTEGRITY_NOT_VERIFIED`), never PASS.
   * A stream blocked by `AUDIT_CHAIN_GAP`, `AUDIT_CHAIN_BROKEN` or `AUDIT_PLANNED_BATCH_DIVERGED` stays blocked, and its backlog eventually blocks every consequential action (`AUDIT_SINK_STALE`). No seal-and-continue procedure exists, and restarting the writer under a new stream name does not unblock health. Escalate to security leadership; never edit audit tables to clear it.
4. Release blocks only after the backlog is within bounds and verification is clean.

## Verification

* Backlog drained; `vsp_audit_export_completeness_ratio` back to 1 and the `audit-export-incomplete` alarm cleared; `audit.verify` verdict PASS (not INCONCLUSIVE) for every stream touched; reconciliation shows every accepted consequential action has an audit event.
* `vsp_audit_deferred_depth` back to 0, with an `audit.deferred.recorded` marker for every deferred handoff event and no `dropped` count in the window (or each dropped event documented).

## Communication roles

Security operations on-call; SRE on-call; incident commander (SEV-1); security leadership; privacy counsel; support operations lead (callers on safe routing).

## Drill requirement

Audit outage drill (sink down, store unwritable) with SYNTHETIC events before pilot, proving consequential actions block, safety and human routes continue and their deferred events are appended after recovery; a lost-response (412) recovery with the verifier role; integrity-gap tabletop before production.
