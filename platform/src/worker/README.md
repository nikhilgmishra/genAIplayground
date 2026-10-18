# platform/src/worker: background loops

Status: **IMPLEMENTED_OFFLINE** (local/ci, FakeClock-tested). `main.ts` refuses deployed
environments through the same configuration guard as the gateway.

Every loop is bounded (fixed maximum per run), idempotent (each underlying operation is
conditional or deduplicated), content-free (counts, opaque ids and reason codes only) and
isolated (errors are reported as reason codes and never stop other loops). Schedulers are
injectable: `TimerLoopScheduler` (no overlap, unref'd timers) for processes,
`ManualLoopScheduler` (FakeClock-driven `runDue()`) for tests.

| Loop | Interval (default) | Work |
|---|---|---|
| `outbox.dispatch` | 1 s | `PgOutboxDispatcher.runOnce(100)`: claim → publish → settle with backoff and dead-lettering. |
| `outbox.consume` | 1 s | Business consumers for delivered messages with worker-level `ConsumerDedup` (`worker.<topic>`); consumer runs outside any transaction, then the dedup row is recorded; bounded retries with backoff, then a dead-letter entry; a topic without a consumer is dead-lettered (`OUTBOX_NO_CONSUMER`). The in-process queue behind the memory publisher is a LOCAL FIXTURE (not durable). |
| `actions.reconcile` | 30 s | UNKNOWN / stale COMMITTING actions reconciled through the business module's provider ports; missing provider and inconclusive lookups are reported. |
| `actions.expire` | 15 s | `ActionService.expireDue`. |
| `tools.idempotency_purge` | 5 min | Expired tool-request idempotency rows. |
| `audit.ship` | 10 s | `AuditShipper.runOnce()` to the configured sink (LOCAL FIXTURE file sink offline). |
| `workflows.tick` | 5 s | `PgWorkflowEngine.tickDetailed(now)`. |
| `transfers.sweep` | 5 s | `TransferCoordinator.sweepTimeouts()` (stalled attempts move to the next route; safety routes are never abandoned). |
| `retention.run` | 24 h | `RetentionJob.run(now)`; every class without an approved duration is reported `BLOCKED_RETENTION_UNSET` and nothing is deleted. |
| `telephony.local_fixture_delivery` | 0.5 s | LOCAL FIXTURE only: telephony fixture events (duplicated / reordered by script) → `TransferCoordinator.applyEvent`. Live Talkdesk transfer events are BLOCKED (TB-07). |

Health (`worker.ts`): `GET /health/live`; `GET /health/ready` is 503 until every loop has
run, and when a loop failed three times in a row or has not run within three intervals.
