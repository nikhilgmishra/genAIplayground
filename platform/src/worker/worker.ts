/**
 * Regression worker composition: the loops over the regression container (local / ci), including the LOCAL
 * FIXTURE consumer queue and telephony delivery. The loop runner and health surface live in runtime.ts (shared
 * with the live worker); this file re-exports them so existing imports keep working.
 */
import type { Container } from "../main/container.js";
import { AuditCompletenessMonitor } from "../audit/monitor.js";
import { integrationHoldReader } from "../ops/integration-gate.js";
import {
  ActionExpiryLoop,
  ActionReconcileLoop,
  AuditShipLoop,
  AuditVerifyLoop,
  DeferredAuditFlushLoop,
  LocalConsumerQueueFixture,
  LocalTelephonyDeliveryLoop,
  MeteredLoop,
  OutboxConsumeLoop,
  OutboxDispatchLoop,
  PgOutboxRetryBacklog,
  RetentionLoop,
  SupportSyncRetryLoop,
  ToolIdempotencyPurgeLoop,
  TransferSweepLoop,
  WorkflowTickLoop,
} from "./loops.js";
import type { WorkerLoop } from "./loops.js";

export * from "./runtime.js";

export interface WorkerIntervals {
  dispatchMs?: number;
  consumeMs?: number;
  reconcileMs?: number;
  expireMs?: number;
  purgeMs?: number;
  auditShipMs?: number;
  auditVerifyMs?: number;
  workflowTickMs?: number;
  transferSweepMs?: number;
  retentionMs?: number;
  telephonyDeliveryMs?: number;
  supportSyncRetryMs?: number;
  deferredAuditFlushMs?: number;
}

/** Builds the worker loops over a container (LOCAL FIXTURE queue and telephony delivery in local/ci). */
export function workerLoopsFor(c: Container, intervals: WorkerIntervals = {}): { loops: WorkerLoop[]; closers: (() => void)[]; queue: LocalConsumerQueueFixture } {
  const queue = new LocalConsumerQueueFixture(c.publisher, c.clock);
  const telephony = new LocalTelephonyDeliveryLoop(c.fixtures.telephony, c.transferStore, c.transfers, intervals.telephonyDeliveryMs);
  const raw: WorkerLoop[] = [
    new OutboxDispatchLoop(c.dispatcher, intervals.dispatchMs, undefined, c.metrics, new PgOutboxRetryBacklog(c.db, c.tenantIds)),
    new OutboxConsumeLoop({ db: c.db, clock: c.clock, logger: c.logger, queue, consumers: c.business.consumers, ...(intervals.consumeMs ? { intervalMs: intervals.consumeMs } : {}) }),
    new ActionReconcileLoop(c.actions, c.business.providers, c.tenantIds, c.logger, intervals.reconcileMs, undefined, c.metrics),
    new ActionExpiryLoop(c.actions, c.tenantIds, intervals.expireMs),
    new ToolIdempotencyPurgeLoop(c.toolIdempotency, c.tenantIds, intervals.purgeMs),
    // Deferred route audit (handoffs during an audit outage) is appended once the store is writable again.
    new DeferredAuditFlushLoop(c.deferredAudit, intervals.deferredAuditFlushMs),
    new AuditShipLoop(c.auditShipper, intervals.auditShipMs),
    // OPS-AUD-01: integrity / ingestion / completeness reconciliation over every stream and tenant.
    new AuditVerifyLoop(
      new AuditCompletenessMonitor({
        db: c.db,
        sink: c.auditSink,
        clock: c.clock,
        metrics: c.metrics,
        tenantIds: c.tenantIds,
        logger: c.logger,
        exportGraceSeconds: c.config.audit.maxBacklogAgeSeconds,
      }),
      intervals.auditVerifyMs,
    ),
    new WorkflowTickLoop(c.workflows, c.clock, intervals.workflowTickMs),
    new TransferSweepLoop(c.transfers, intervals.transferSweepMs),
    new RetentionLoop(c.retention, c.clock, c.logger, intervals.retentionMs, c.metrics),
    // Re-enqueues due RETRY_SCHEDULED / stale SYNCING support requests; the consumer dead-letters after the budget.
    // Held (nothing re-enqueued) while INTEGRATION <support records> or WRITES is engaged or unreadable (OPS-KS-02).
    new SupportSyncRetryLoop(c.business.supportRequests, c.tenantIds, intervals.supportSyncRetryMs, undefined, (tenantId) =>
      integrationHoldReader(() => c.deps.killSwitches.snapshot(tenantId), { integration: c.deps.adapters.supportRecords.integrationId, write: true }),
    ),
    telephony,
  ];
  // Every loop reports content-free run / error / processed / lag / duration metrics through the Metrics port.
  const loops = raw.map((l) => new MeteredLoop(l, c.metrics, c.clock));
  return { loops, closers: [() => queue.close(), () => telephony.close()], queue };
}

