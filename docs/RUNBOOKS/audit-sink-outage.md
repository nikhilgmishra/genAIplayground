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

## Durable route-audit journal, route reconciliation and independent verification (WP-04)

Implemented and verified against protocol emulators (Layer 2: postgres:16, DynamoDB Local, MinIO
Object Lock, LocalStack KMS); **not yet wired into the gateway, worker or handoff** (composition
packages WP-07, WP-14, WP-25) and not run in AWS. Until it is wired, the process-local queue above
is what runs. When wired:

* **Where a deferred route event goes.** `DurableDeferredAuditQueue`
  (`platform/src/audit/journal.ts`) journals a refused route event in PostgreSQL `audit_deferred`
  (inside the handoff's own transaction when the caller passes it). If PostgreSQL refuses that too, it
  goes to the independent DynamoDB journal (table with `pk raj#<tenant>`, `sk <deferredAt>#<deferralId>`);
  only if both refuse is it held in process memory (error log `audit.journal.memory_fallback`). A
  crash or restart no longer loses journaled events: **restarting tasks is safe** once
  `vsp_audit_journal_pending{journal="memory"}` is 0 on every task.
* **Signals.** `vsp_audit_journal_entries_total{journal,result}` (`journaled`, `flushed`,
  `journal_failed`, `dropped`), `vsp_audit_journal_pending{journal}`; logs
  `audit.journal.deferred`, `audit.journal.postgres_refused`, `audit.journal.independent_refused`,
  `audit.journal.memory_fallback`, `audit.journal.flushed`, `audit.journal.dropped`,
  `audit.journal.quarantined`, `audit.journal.lost_at_shutdown` (codes and opaque ids only).
* **Flush.** Each flush appends every PENDING deferral of a tenant once, in deferral order, with its
  `audit.deferred.recorded` marker (`evidencePointers` `deferral:<id>`), in one transaction per
  deferral; two replicas flushing at once append each event once. DynamoDB entries are drained into
  `audit_deferred` (column `journal = dynamodb`) first. Tenant order holds across the journals: while
  anything of the tenant waits in `audit_deferred`, the DynamoDB journal or memory, a new route event is
  journaled behind it, not appended ahead. **While the DynamoDB journal cannot be read** (log
  `audit.journal.deferred` with `reasonCode` `AUDIT_JOURNAL_READ_FAILED`, flush `reasonCode` the same), new
  route events are journaled in `audit_deferred` and nothing of that tenant flushes, so
  `vsp_audit_journal_pending{journal="postgres"}` grows (and `{journal="dynamodb"}` keeps its last known value):
  restore DynamoDB access (table, IAM, endpoint) and the next flush appends everything in order. Do not delete or
  edit journal rows to unblock it.
* **While the audit store is unwritable**, each flush appends nothing (flush `reasonCode`
  `AUDIT_STORE_UNWRITABLE`) but still recounts `audit_deferred` and the DynamoDB journal for every tenant, so
  `vsp_audit_deferred_depth` and `vsp_audit_journal_pending{journal}` show what waits even on a task that was
  restarted during the outage or did not defer the events itself.
* **While PostgreSQL is down or read-only**, route events go to the DynamoDB journal:
  `vsp_audit_journal_pending{journal="dynamodb"}` and `vsp_audit_deferred_depth` show how many wait there (each
  flush counts the journal), and the `postgres` series keeps its last known value; neither reads 0 while evidence
  is held. A task started during the PostgreSQL outage has no known PostgreSQL count yet: it reports **no**
  `{journal="postgres"}` value (missing data, not 0; alarm on missing data as breaching), its depth counts only what
  it could count, and its flush `reasonCode` (`DB_UNAVAILABLE`) says why; check the other tasks' series or query
  `audit_deferred` once the database answers. After recovery the flush drains DynamoDB in bounded passes, oldest first; a backlog larger than one pass
  takes several flush runs, and newer events wait behind the older ones until then (the gauges fall to 0).
* **A tampered or corrupted DynamoDB journal item** - its digest does not match, it sits in another tenant's
  partition or under another sort key, it carries a deferral time that is not canonical (`2026`, a local-time form)
  or an event time PostgreSQL cannot store (year 0000), or PostgreSQL refuses its content when it is drained (a
  data exception or CHECK violation) - (log `audit.journal.quarantined` at error level, reason
  `AUDIT_JOURNAL_ENTRY_DIGEST_MISMATCH` or `AUDIT_JOURNAL_ENTRY_INVALID`; chain event
  `audit.journal.entry_quarantined`; `vsp_audit_journal_entries_total{journal="dynamodb",result="dropped"}`)
  is never appended and does not block the tenant: the flush records the quarantine in the chain, marks the
  item `QUARANTINED` (attributes `quarantineReason`, `quarantineRef`, `quarantineEventId`) and continues. Treat
  it as a security incident: the item's content is kept for forensics; find it in the tenant partition
  `raj#<tenant>` by `quarantineRef` (= the hex digest in the event's `kv://route-audit-journal/...` pointer),
  preserve it, review who could write the table (IAM, CloudTrail data events), and expect an
  `audit.route.not_recorded` marker for the route it claimed to evidence. Never edit it back to `PENDING`.
  While the audit store is unwritable the quarantine cannot be recorded, so the item stays `PENDING` and the
  tenant's newer route events wait in `audit_deferred` until the store recovers.
* **Gaps are surfaced, not guessed.** `RouteAuditReconciler` (`route-reconciler.ts`) writes
  `audit.route.not_recorded` for every safety incident (`safety_events`) without route evidence after
  the grace (default 300 s) and for every route intent (`route_audit_intents`, opened before a detached
  route execution) past its deadline without evidence, and `audit.safety_event.unaudited` for safety rows
  written during an outage whose route evidence exists. One row per subject in
  `route_audit_reconciliations`; metric `vsp_route_audit_reconciled_total{subject,result}`. A
  `not_recorded` marker is an evidence gap: document it (SEV-1 for a safety route) and cross-check the
  call's transfer journey.
* **Independent verification.** The exporter (`AuditExporter`, writer credentials: put only) signs every
  manifest with the audit KMS key (`ECC_NIST_P256`, `ECDSA_SHA_256`). The verifier runs as its own identity:
  its own database login granted only `app_audit_verifier`, read-only sink credentials (list and get) and
  `kms:GetPublicKey` only. Locally the command provisions a per-run login `vsp_verify_<random>` (dropped
  afterwards) and MinIO session credentials restricted to list/get on the bucket; in AWS the verifier task
  role provides both (WP-39):

  ```bash
  tsx scripts/vsp/verify-audit.mts --env local --database <db> --bucket <bucket> --kms-key <key-arn> [--from <ISO>] [--to <ISO>]
  # live (never from a default command): VSP_AUDIT_VERIFY_LIVE=1 VSP_AUDIT_VERIFIER_DATABASE_URL=... VSP_AUDIT_BUCKET=...
  #   VSP_AUDIT_BUCKET_OWNER=... VSP_AUDIT_KMS_KEY_ID=... AWS_REGION=... tsx scripts/vsp/verify-audit.mts --env live
  ```

  Exit 0 PASS, 1 FAIL (findings: integrity, unsigned or invalid manifest signatures, ingestion gaps,
  keyed reconciliation of committed actions, provider receipts, CRM writes and route evidence), 2
  INCONCLUSIVE (no sink reader or no signature key: never a pass), 3 usage, 4 dependency unreachable.
  Without `--bucket` the command cannot read the exported copy: reconciliation then uses the local outbox and
  reports shipped evidence per source as `unverified` (reason `RECONCILIATION_NOT_VERIFIED_WITHOUT_SINK`), so an
  intact database is exit 2, never 0 and never a false 1. A finding visible locally is still exit 1: a chain or
  ingestion gap, a route deferral pending past the grace, evidence unshipped past the grace, or a local event
  that contradicts the ledger, a deferral or a marker (another tenant, action, key, correlation or receipt).
  During a sink-reader outage, an exit 2 with `unverified` counts is expected; re-run with the reader before
  closing the incident.
  The JSON report carries codes, streams, sequences, opaque ids and counts only. A
  `VERIFIER_IDENTITY_NOT_READ_ONLY` reason means the verifier was given a writing identity; `identity.findings`
  names why (`VERIFIER_LOGIN_PRIVILEGED` superuser or CREATEROLE, `VERIFIER_LOGIN_WRITER_MEMBER` a member of
  `app_runtime` / `app_worker` / `app_console` — for example the application's own login —,
  `VERIFIER_LOGIN_OWNS_OBJECTS`, `VERIFIER_IDENTITY_CAN_WRITE`, `VERIFIER_IDENTITY_DEFINER_WRITE_PATH`,
  `VERIFIER_IDENTITY_CAN_CREATE`, `VERIFIER_LOGIN_UNRESOLVED`). Fix the credentials before trusting any
  verdict. A `route_evidence` discrepancy on a RECORDED deferral means the journal names an event the export
  does not hold: treat it as an integrity incident (threat T-16).

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
3. Ingestion gap or broken link → stop shipping for that stream (the shipper refuses to ship across a gap). `audit.verify` already runs `verifyStream`, `verifyShipped` (when it has a sink reader), the writer chain-head counts and the keyed reconciliation of committed ledger actions every run; read its verdict and finding codes, re-run the checks for the affected streams, and document every missing or extra event. Completeness is PASS only when integrity, ingestion monitoring and reconciliation all ran clean (`assessCompleteness`); without a sink reader the verdict is INCONCLUSIVE (`SHIPPED_INTEGRITY_NOT_VERIFIED`), never PASS, and a local finding still makes it FAIL.
   * A stream blocked by `AUDIT_CHAIN_GAP`, `AUDIT_CHAIN_BROKEN` or `AUDIT_PLANNED_BATCH_DIVERGED` stays blocked, and its backlog eventually blocks every consequential action (`AUDIT_SINK_STALE`). No seal-and-continue procedure exists, and restarting the writer under a new stream name does not unblock health. Escalate to security leadership; never edit audit tables to clear it.
4. Release blocks only after the backlog is within bounds and verification is clean.

## Verification

* Backlog drained; `vsp_audit_export_completeness_ratio` back to 1 and the `audit-export-incomplete` alarm cleared; `audit.verify` verdict PASS (not INCONCLUSIVE) for every stream touched; reconciliation shows every accepted consequential action has an audit event.
* `vsp_audit_deferred_depth` back to 0 on every process, with an `audit.deferred.recorded` marker for every deferred handoff event and no `dropped` count, `audit.deferred.unflushed_at_shutdown`, `audit.deferred.lost_at_shutdown` or `server.shutdown_handlers_unsettled` log in the window (or each lost event, or each call behind a logged count, documented), and every route-tool `TIMEOUT` shortly before a gateway stop cross-checked against its transfer journey and `safety_events` row; see [How to confirm the flush](#deferred-route-audit-queue).
* `<prefix>-audit-not-recorded-ratio` back to OK, with every affected accepted action reconciled against the ledger.
* Once the durable journal is wired: `vsp_audit_journal_pending` back to 0 for every journal, every `audit.route.not_recorded` marker in the window documented, and `verify-audit` exit 0 (PASS) for the window with the verifier identity.

## Communication roles

Security operations on-call; SRE on-call; incident commander (SEV-1); security leadership; privacy counsel; support operations lead (callers on safe routing).

## Drill requirement

Audit outage drill (sink down, store unwritable) with SYNTHETIC events before pilot, proving consequential actions block, safety and human routes continue and their deferred events are appended after recovery, in a split gateway/worker deployment, by the gateway's own flush and by a graceful gateway stop during the outage with a human request in flight (which must complete, and its event must be logged as `audit.deferred.unflushed_at_shutdown`) and with a human request whose handler outlasts the drain bound (force-closed; the stop must wait for it and log its event the same way, or log `server.shutdown_handlers_unsettled` if it outlasts the settle bound too), plus a route tool that times out and is still running at the stop, to show the gap is detected from `TIMEOUT` / `vsp_timeouts_total` and the transfer journey; a lost-response (412) recovery with the verifier role; integrity-gap tabletop before production.
