# RB-AUDIT-OUTAGE Audit sink outage or integrity gap

| Field | Value |
|---|---|
| Runbook id | RB-AUDIT-OUTAGE (alias RB-AUDIT-GAP) |
| Severity | SEV-2 while the bounded local buffer holds; SEV-1 if durable evidence cannot be written or an integrity gap is found |
| Primary owner role | Security operations on-call (with SRE on-call) |
| Last drilled | NEVER (not yet run) |
| Status | Draft; audit health, shipper, the `audit.verify` completeness monitor and the deferred route-audit queue (with its gateway-side flush) exist and are tested offline (`platform/src/audit`, `platform/src/worker`, `platform/src/main/server.ts`); the alarms below exist as Terraform plans only (export and paging BLOCKED, PRQ-011, PRQ-047); the live S3 Object Lock sink and its read-only verifier role are BLOCKED (PRQ-037, PRQ-040) |

## Trigger and detection signals

* `<prefix>-audit-backlog-not-draining` alarm: the shipping backlog has not drained for 15 minutes (`vsp_audit_backlog_events`).
* `<prefix>-audit-ingestion-gap` alarm (critical): a finding of the worker loop `audit.verify` (sequence gap, rewritten or missing row, a committed ledger action without its commit audit event), **or verification not reporting**: the loop emits `vsp_audit_ingestion_gaps_total` with a zero heartbeat every run (default 60 s) and the alarm treats missing data as breaching (OPS-AUD-01).
* `<prefix>-audit-export-incomplete` alarm: completeness below 1 or not reported for 15 minutes (`vsp_audit_export_completeness_ratio`: shipped events / events older than the export grace).
* Dashboard `<prefix>-audit`; `AuditHealth.status()` reason codes `AUDIT_STORE_UNWRITABLE`, `AUDIT_BACKLOG_EXCEEDED`, `AUDIT_SINK_STALE`.
* `<prefix>-audit-not-recorded-ratio` alarm (critical) and the panel "Protected actions without decision or audit": the share of accepted consequential tool calls whose `tool.invoke` append failed (`vsp_protected_actions_total{audit="not_recorded"}` divided by all accepted ones) is above 0 percent. The commit's own ledger event is reconciled by `audit.verify`.
* `vsp_audit_events_rejected_total` above zero: the audit writer refused an event by schema (VSP-GW-04). That is a code defect, not an outage; the event was retried once minimised.
* `<prefix>-audit-deferred-depth` alarm (high): some process has held handoff route audit events in its deferred queue for 5 minutes (Maximum of `vsp_audit_deferred_depth` above 0 in 5 consecutive minutes). `<prefix>-audit-deferred-dropped` alarm (critical): a deferred event was dropped, because the bounded queue was full, the writer refused it as invalid, or it arrived after a graceful shutdown's final flush; that route evidence is lost. Dashboard panel "Deferred route audit" on `<prefix>-audit`; error-level logs `audit.deferred.queued`, `audit.deferred.dropped`, `audit.deferred.unflushed_at_shutdown`, `audit.deferred.lost_at_shutdown` and, from a gateway stop, `server.shutdown_handlers_unsettled` (route handlers still running when the process gave up waiting: their route evidence may be lost; counts only); the warn log `server.shutdown_drain_timeout` means a gateway stop force-closed requests (their callers saw a connection error). See [Deferred route-audit queue](#deferred-route-audit-queue) and [ADR-0011](../adr/ADR-0011-deferred-route-audit.md).

## Immediate containment

1. While the sink is down, the local durable outbox buffers within the bounded policy (backlog size and age).
2. When the bound is exceeded or the store is unwritable, `assertCanAcceptConsequential` fails and **consequential actions are blocked**; the platform **degrades to safe routing**. Safety and human routes are not blocked: their handoff audit events go to the bounded, process-local deferred queue of the process that served the call, which appends them in order once the store is writable again, each followed by an `audit.deferred.recorded` marker. A crash or restart of that process loses its queued events (the `safety_events` row stays the durable record of a safety route). **Do not restart, redeploy or scale in gateway or worker tasks as a first response** while `<prefix>-audit-deferred-depth` is in ALARM.
3. **Do not acknowledge a mutation and hope to log it later** (spec section 13). Do not raise the buffer bounds to make the alarm go away.
4. Consider engaging `WRITES` explicitly so callers get a consistent message ([kill-switch-operations.md](kill-switch-operations.md)).

## Deferred route-audit queue

* **What it is.** A bounded FIFO in process memory (engineering default 1000 events, configurable
  1..10000) of handoff (human and safety route) audit events that could not be appended because
  the local durable audit outbox was unwritable (`DeferredAuditQueue`,
  `platform/src/audit/deferred.ts`). It holds route evidence only, never a consequential
  mutation's audit event; those stay blocked. Every process has its own queue, and only that
  process can drain it. The gateway-only process (`server.ts`) runs its own bounded timer
  (`DeferredAuditFlushTimer`: every 5 s, at most 100 events per run). The worker runs the loop
  `audit.deferred_flush` for the worker's queue. The local composition runs both in one process.
  A run attempts nothing while audit health reports `AUDIT_STORE_UNWRITABLE`, stops at the first
  store failure, and keeps order. Each late event keeps its original `occurredAt` and is
  followed by an `audit.deferred.recorded` marker (`parentId` = the late event, `reasonCode` =
  why it was deferred).
* **Depth alarm.** Every flush run reports `vsp_audit_deferred_depth`, also when the queue is
  empty, so each flushing process sends a heartbeat. `<prefix>-audit-deferred-depth` alarms when
  the Maximum over all processes stays above 0 for 5 consecutive minutes.
  `<prefix>-audit-deferred-dropped` alarms on the first dropped event. Thresholds are
  engineering proposals pending SRE review (PRQ-011).
* **Crash-loss limit.** Queued events are lost when the process holding them exits without a
  graceful shutdown: a crash, an out-of-memory kill, a forced task stop, or a stop that runs past
  the container stop timeout. Nothing is logged then. On a graceful shutdown (SIGTERM) the
  gateway exits as soon as these steps return, in this order:
  1. stops accepting connections and waits, for at most 5 s, for the open responses, so a human
     or safety request in flight completes with its answer (`server.shutdown_drain_timeout`
     warns when the bound expires);
  2. closes the HTTP app, which force-closes any request still open; the caller of such a
     request sees a connection error, but its handler keeps running;
  3. waits, for at most 10 s, for every route handler still running to finish, so its event is
     appended or queued before the final flush. When this bound expires it logs
     `server.shutdown_handlers_unsettled` at error level with the count (`unsettled`): those
     handlers may not reach the queue before the process exits, and their route evidence is
     then lost with **no per-event log**;
  4. attempts one final flush, bounded by 5 s, which also waits for appends still in progress;
     it logs at error level as `audit.deferred.unflushed_at_shutdown` the events still queued
     (`remaining`) and the appends still running (`inProgress`, e.g. hung in the store), with
     the reason code, then seals the queue;
  5. closes the database.

  The three bounds together are at most 25 s, within the 30 s ECS stop timeout. A handler that
  reaches the sealed queue after step 4, while the process is still alive, has its event dropped
  and logged at error level as `audit.deferred.lost_at_shutdown` (reason
  `AUDIT_DEFERRED_AFTER_SHUTDOWN`, counted as `vsp_audit_deferred_total{result="dropped"}`).
  So on a graceful stop, route evidence that reached the queue, or whose route handler was still
  running, is either written or its possible loss is on record at error level before the process
  exits: per event for queued events, **as a count only** for `server.shutdown_handlers_unsettled`
  and `inProgress`. **Not covered:** a `request_human_transfer` or `request_safety_route` execution
  that its tool timeout (5 s) detached from the request. The caller got `TIMEOUT` while the handoff
  work kept running; if the process exits before that work reaches the queue, its route evidence
  is lost with **no log at all**. A count tells you how many events may be
  missing, not which calls; find the calls from the window's `handoff.*` and telephony logs. The
  worker and local entry points do not run this sequence today (no final flush, no seal): a stop
  of those processes during an outage loses their queued events without these logs. The
  `safety_events` row (`audit_status = AUDIT_UNAVAILABLE`) remains the durable record of a
  safety route. For a human route only the error-level log lines (action code and opaque ids)
  remain.
* **How to confirm the flush.**
  1. `vsp_audit_deferred_depth` is back to 0 and `<prefix>-audit-deferred-depth` is OK.
  2. The `audit.deferred.flushed` warn logs and `vsp_audit_deferred_total{result="flushed"}` for
     the window match the `audit.deferred.queued` logs (`vsp_audit_deferred_total{result="queued"}`).
  3. An audit metadata search for the affected calls shows each late `handoff.*` event followed
     by an `audit.deferred.recorded` marker whose `parentId` is that event.
  4. Each `safety_events` row with `audit_status = AUDIT_UNAVAILABLE` in the window has a
     matching late `handoff.safety_requested` event.
  5. `audit.verify` reports PASS for the `runtime` stream.
  6. There is no `audit.deferred.dropped`, `audit.deferred.unflushed_at_shutdown`,
     `audit.deferred.lost_at_shutdown` or `server.shutdown_handlers_unsettled` log in the window.
     Otherwise, document each lost event as an evidence gap (SEV-1; step 3 below). For
     `server.shutdown_handlers_unsettled` and an `unflushed_at_shutdown` with `inProgress` above
     0, only a count is logged: identify the affected calls from the `handoff.*` and telephony
     logs of that task around the stop, and document each call without a matching audit event.
     Also look for `TIMEOUT` results and a rise in `vsp_timeouts_total` for
     `request_human_transfer` and `request_safety_route` shortly before the stop: each such call
     may have lost its route evidence with no log. Cross-check its transfer journey and
     `safety_events` row against the `handoff.*` audit events and document each call without one.
     A `server.shutdown_drain_timeout` warning with no error log after it means callers were cut
     off; it rules out lost evidence only when no route tool timed out shortly before the stop.

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
* `vsp_audit_deferred_depth` back to 0 on every process, with an `audit.deferred.recorded` marker for every deferred handoff event and no `dropped` count, `audit.deferred.unflushed_at_shutdown`, `audit.deferred.lost_at_shutdown` or `server.shutdown_handlers_unsettled` log in the window (or each lost event, or each call behind a logged count, documented), and every route-tool `TIMEOUT` shortly before a gateway stop cross-checked against its transfer journey and `safety_events` row; see [How to confirm the flush](#deferred-route-audit-queue).
* `<prefix>-audit-not-recorded-ratio` back to OK, with every affected accepted action reconciled against the ledger.

## Communication roles

Security operations on-call; SRE on-call; incident commander (SEV-1); security leadership; privacy counsel; support operations lead (callers on safe routing).

## Drill requirement

Audit outage drill (sink down, store unwritable) with SYNTHETIC events before pilot, proving consequential actions block, safety and human routes continue and their deferred events are appended after recovery, in a split gateway/worker deployment, by the gateway's own flush and by a graceful gateway stop during the outage with a human request in flight (which must complete, and its event must be logged as `audit.deferred.unflushed_at_shutdown`) and with a human request whose handler outlasts the drain bound (force-closed; the stop must wait for it and log its event the same way, or log `server.shutdown_handlers_unsettled` if it outlasts the settle bound too), plus a route tool that times out and is still running at the stop, to show the gap is detected from `TIMEOUT` / `vsp_timeouts_total` and the transfer journey; a lost-response (412) recovery with the verifier role; integrity-gap tabletop before production.
