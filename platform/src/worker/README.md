# platform/src/worker: background loops

Status: software IMPLEMENTED. local/ci: the regression worker (`worker.ts`, FakeClock-tested). sandbox, staging and
production: `main.ts` starts the live worker (`platform/src/main/live-worker.ts`, WP-07) over the live container,
exercised on Layer 2 against the local emulators (`platform/test/integration/composition/boot.test.ts`,
`faults.test.ts`); environment NOT_CONFIGURED.

## Live worker (WP-07)

`live-loops.ts` `liveWorkerLoopsFor(container)` composes, in this order, `outbox.dispatch` (to SQS; see the
table below for its failure reporting), `outbox.consume` (`SqsOutboxConsumeLoop`: receive, deduplicate, apply, delete only after the effect; an envelope of
a tenant the worker does not serve is unconsumable, never deduplicated or consumed under that tenant; a run with any
failed or unconsumable message fails `OUTBOX_CONSUME_FAILED` / `OUTBOX_UNCONSUMABLE`, counts
`vsp_outbox_consume_failures_total{reason}` for the `outbox-consume-failures` alarm and, after three failing runs,
turns readiness 503; the messages stay on the queue for its redrive policy), `actions.reconcile`, `actions.expire`, `tools.idempotency_purge`, `audit.deferred_flush` (the
durable queue: PostgreSQL `audit_deferred` and the independent DynamoDB journal, WP-04), `audit.route_reconcile`
(route intents and safety incidents without evidence get `audit.route.not_recorded`), `workflows.tick`,
`transfers.sweep` (the durable `transfer_journeys` store, migration 2070), `retention.run` and
`support.sync_retry`; the audit export and verification run in their own unit (`main/audit-exporter.ts`), not in
the worker. For each change feed of `PlatformConfig.connectors.feeds` the live worker adds `connectors.feed_sync`
(`adapters/live/connector-feed.ts`): the WP-06 ConnectorRuntime over the egress-classified transport, an
IncrementalReader with PostgreSQL checkpoints, the content-free `connector_feed_index` (migration 2071) written
in the checkpoint's transaction, and the SQS dead-letter writer for records it cannot project. Record-key and
record digests are keyed (HMAC-SHA256 under the container's `feedDigester`, an HKDF subkey of the request-hash
pepper), never a plain SHA-256 of a low-entropy key. A refused
dead-letter write rolls the page back: consumption of that feed stops with `DLQ_WRITE_REFUSED`, the checkpoint
is kept, `vsp_connector_feed_dead_letter_refused_total` drives the `connector-feed-dead-letter-refused` alarm,
and the feed resumes from the checkpoint once the queue accepts (`[FAULT:DLQ_FULL]`). `actions.reconcile` fails
a run that found actions to reconcile and settled none of them (`ACTION_RECONCILE_INCONCLUSIVE` /
`ACTION_RECONCILE_PROVIDER_MISSING`, `vsp_action_reconcile_degraded_total{reason}`, alarm
`action-reconcile-degraded`), so a failing provider is never a healthy loop. `loop-kit.ts` holds the
loop classes shared by both workers, `runtime.ts` the worker runtime and health app.

## Regression worker (local / ci)

Every loop is bounded (fixed maximum per run), idempotent (each underlying operation is
conditional or deduplicated), content-free (counts, opaque ids and reason codes only) and
isolated (errors are reported as reason codes and never stop other loops). Schedulers are
injectable: `TimerLoopScheduler` (no overlap, unref'd timers) for processes,
`ManualLoopScheduler` (FakeClock-driven `runDue()`) for tests.

| Loop | Interval (default) | Work |
|---|---|---|
| `outbox.dispatch` | 1 s | `PgOutboxDispatcher.runOnce(100)`: claim → publish → settle with backoff and dead-lettering. Never reported healthy while publishing fails (OPS-01, both compositions): a run in which a claimed message failed to publish or was moved to DEAD fails (`OUTBOX_PUBLISH_FAILED` / `OUTBOX_DEAD_LETTERED`) and counts `vsp_outbox_publish_failures_total{reason: publish_failed\|dead_lettered}` (alarm `outbox-publish-failures`, RB-DLQ-REPAIR); a run that claimed nothing while an earlier failure still waits out its backoff (`PgOutboxRetryBacklog`: PENDING rows with a publish error code, per tenant under RLS, bounded) fails `OUTBOX_PUBLISH_RETRYING`, so a queue that refuses every publish turns readiness 503 after three runs; the first successful publish of the backlog clears it. |
| `outbox.consume` | 1 s | Business consumers for delivered messages with worker-level `ConsumerDedup` (`worker.<topic>`); consumer runs outside any transaction, then the dedup row is recorded; bounded retries with backoff, then a dead-letter entry; a topic without a consumer is dead-lettered (`OUTBOX_NO_CONSUMER`). The in-process queue behind the memory publisher is a LOCAL FIXTURE (not durable). |
| `actions.reconcile` | 30 s | UNKNOWN / stale COMMITTING actions reconciled through the business module's provider ports; missing provider and inconclusive lookups are reported. |
| `actions.expire` | 15 s | `ActionService.expireDue`. |
| `tools.idempotency_purge` | 5 min | Expired tool-request idempotency rows. |
| `audit.ship` | 10 s | `AuditShipper.runOnce()` to the configured sink (LOCAL FIXTURE file sink offline). |
| `audit.verify` | 60 s | `AuditCompletenessMonitor.runOnce()` (`platform/src/audit/monitor.ts`, OPS-AUD-01): local and shipped integrity of every stream, writer chain head vs rows present, shipping lag past the export grace (`audit.maxBacklogAgeSeconds`), keyed reconciliation of COMMITTED ledger actions against their commit audit events; emits `vsp_audit_ingestion_gaps_total` (0 heartbeat every run), `vsp_audit_export_completeness_ratio`, `vsp_audit_backlog_events`. The verdict (PASS / FAIL / INCONCLUSIVE) is in the run details and metrics; FAIL is not a loop failure (restarting cannot repair evidence). In a live deployment this loop needs the read-only audit verifier role, in a task whose role is not an evidence writer (`infra/terraform/modules/audit`, OPS-AUD-02). |
| `audit.deferred_flush` | 5 s | `DeferredAuditQueue.flush(100)` (`platform/src/audit/deferred.ts`): human / safety handoff audit events deferred during an audit outage are appended FIFO once the store is writable (skipped while `AuditHealth` reports `AUDIT_STORE_UNWRITABLE`, reported as the run's reason code, not a loop failure); each is followed by an `audit.deferred.recorded` marker. The queue is process-local, so this loop must run in the process that holds it (`pnpm start:local` runs gateway and worker in one process); a crash loses queued events (documented limit; the `safety_events` row stays the durable incident record). Never used for consequential mutations. |
| `workflows.tick` | 5 s | `PgWorkflowEngine.tickDetailed(now)`. |
| `transfers.sweep` | 5 s | `TransferCoordinator.sweepTimeouts()` (stalled attempts move to the next route; safety routes are never abandoned). |
| `support.sync_retry` | 30 s | `SupportRequestService.retryDue(tenantId, 100)` per tenant: due `RETRY_SCHEDULED` requests and stale `SYNCING` claims are re-enqueued as `support_request.sync` outbox messages (dedupe key per attempt, so a repeated sweep before delivery enqueues nothing new); `outbox.dispatch` / `outbox.consume` deliver them and the business consumer settles `SYNCED`, `RETRY_SCHEDULED` (bounded exponential backoff) or `DEAD_LETTER` after the attempt budget (operator repair: console `supportRequests.repair`). `processed` counts due requests swept. A business module without `retryDue` fails the loop closed (`SUPPORT_SYNC_RETRY_UNAVAILABLE`, worker not ready). Kill switches (OPS-KS-02): while `INTEGRATION <support records>` (salesforce) or `WRITES` is engaged, or the snapshot is unreadable, nothing is re-enqueued for the tenant (`details.heldTenants`); the consumer also checks before claiming, so a held request keeps its state and attempt count (`last_sync_reason = KILL_SWITCH_*`) and is re-enqueued with its own dedupe key after release. |
| `retention.run` | 24 h | `RetentionJob.run(now)`; every class without an approved duration is reported `BLOCKED_RETENTION_UNSET` and nothing is deleted. |
| `telephony.local_fixture_delivery` | 0.5 s | LOCAL FIXTURE only: telephony fixture events (duplicated / reordered by script) → `TransferCoordinator.applyEvent`. Live Talkdesk transfer events are BLOCKED (TB-07). |

Health (`worker.ts`): `GET /health/live`; `GET /health/ready` is 503 until every loop has
run, and when a loop failed three times in a row or has not run within three intervals.

Metrics (content-free, closed label enums; `platform/src/observability/metrics.ts`):
`workerLoopsFor` wraps every loop in `MeteredLoop`, which emits through the container's
`Metrics` port `vsp_worker_loop_runs_total{loop,result}`, `vsp_worker_loop_errors_total{loop}`,
`vsp_worker_loop_processed_total{loop}`, `vsp_worker_loop_lag_ms{loop}` (start delay behind the
previous start plus the interval) and `vsp_worker_loop_duration_ms{loop}`. `RetentionLoop` also
emits `vsp_retention_deleted_total{data_class}`, `vsp_retention_classes_blocked{data_class,reason}`,
`vsp_retention_unverified_copies{location,status}` and
`vsp_vendor_deletion_requests_pending{vendor}` (`RetentionJob.pendingVendorDeletions()`). The loop
names are the closed `WORKER_LOOP_NAMES` enum (now including `support.sync_retry` and
`audit.deferred_flush`). The support-sync sweep's outcomes are also visible as
`vsp_crm_reconciliation_total{result=retried|dead_lettered|synced}` (business consumer) and the deferred
audit as `vsp_audit_deferred_total{result,reason}`, `vsp_audit_deferred_depth` and
`vsp_audit_deferred_age_ms` (audit module). A failing metrics sink never affects a loop. The `outbox.consume` dedup pre-check uses
`ConsumerDedup.isProcessed(tenantId, consumer, messageId)` (tenant RLS) and messages carry
`tenantId`.

## Tests

| File | Covers |
|---|---|
| `worker.test.ts` | scheduler, `MeteredLoop` metrics, outbox dispatch/consume, dispatch failure reporting (failed and dead-lettered runs counted, the retry backlog failing runs between retries, readiness 503 after three runs and recovery after the first publish), reconciler, retention metrics, every loop green on the composition, readiness, LOCAL FIXTURE telephony delivery, the `support.sync_retry` sweep (retries with backoff, idempotent per attempt, dead-letters after the budget, fails closed without `retryDue`, bounded per tenant) |
| `deferred-audit.test.ts` | audit outage over the composition: the commit stays blocked, the human and safety routes proceed, their handoff audit events are deferred and appended in order by `audit.deferred_flush` after recovery (chain intact) |

The journeys (`platform/test/journeys/faults.test.ts`) also run only the composed worker loops for the
Salesforce outage: a request whose sync failed during the outage syncs after recovery.
