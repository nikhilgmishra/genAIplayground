/**
 * Worker loops (spec sections 8, 10, 11, 12, 15). Every loop is:
 *  - bounded: a fixed maximum of items per run;
 *  - idempotent: re-running after a crash or with duplicates is safe (each
 *    underlying operation is conditional / deduplicated);
 *  - content-free: logs and reports carry counts, opaque ids and reason codes only;
 *  - isolated: an error is caught and reported (reason code), never thrown to
 *    the scheduler, and never stops the other loops;
 *  - observable: MeteredLoop emits content-free per-loop metrics (runs, errors,
 *    processed items, schedule lag, duration) through the Metrics port; a
 *    metrics failure never affects the loop.
 */
import type { LedgerActionService } from "../actions/action-service.js";
import type { ToolRequestIdempotency } from "../actions/tool-idempotency.js";
import type { ProviderCommitPort } from "../actions/ports.js";
import type { TelephonyEvent, TelephonyFixture } from "../adapters/local/telephony-fixture.js";
import { TRANSFER_EVENT_FOR_STATE } from "../adapters/local/telephony-fixture.js";
import type { AuditShipper } from "../audit/shipper.js";
import type { BusinessModule } from "../business/contract.js";
import type { Db } from "../db/types.js";
import { noopMetrics } from "../observability/metrics.js";
import type { Logger, Metrics } from "../observability/ports.js";
import { PgConsumerDedup } from "../outbox/consumer-dedup.js";
import type { PgOutboxDispatcher } from "../outbox/dispatcher.js";
import type { MemoryPublisherFixture } from "../outbox/memory-publisher.fixture.js";
import type { OutboxMessage } from "../outbox/ports.js";
import type { ActionKind } from "../protocol/index.js";
import type { RetentionJob } from "../retention/job.js";
import type { Clock } from "../shared/clock.js";
import { PlatformError } from "../shared/errors.js";
import type { PgWorkflowEngine } from "../workflows/engine.js";
import type { TransferCoordinator, TransferStore } from "../workflows/transfer.js";

export interface LoopReport {
  ok: boolean;
  /** Items handled in this run (meaning is loop-specific; counts only). */
  processed: number;
  reasonCode: string | null;
  details: Record<string, number | string | boolean | null>;
}

export interface WorkerLoop {
  readonly name: string;
  readonly intervalMs: number;
  runOnce(): Promise<LoopReport>;
}

const reasonOf = (err: unknown): string => (err instanceof PlatformError && /^[A-Z][A-Z0-9_]{2,63}$/.test(err.reasonCode) ? err.reasonCode : "UNCLASSIFIED_ERROR");
const ok = (processed: number, details: LoopReport["details"] = {}): LoopReport => ({ ok: true, processed, reasonCode: null, details });
const failed = (err: unknown, details: LoopReport["details"] = {}): LoopReport => ({ ok: false, processed: 0, reasonCode: reasonOf(err), details });

/** Metrics must never break a loop (or a safety-relevant flow): emission errors are swallowed. */
function safeMetric(fn: () => void): void {
  try {
    fn();
  } catch {
    // content-free metrics are best effort here; the loop report and logs still carry the outcome
  }
}

/**
 * Wraps a loop with content-free metrics (labels are the closed loop-name enum and ok/failed):
 * vsp_worker_loop_runs_total{loop,result}, vsp_worker_loop_errors_total{loop},
 * vsp_worker_loop_processed_total{loop}, vsp_worker_loop_lag_ms{loop} (how far this run started
 * behind the previous start plus the interval) and vsp_worker_loop_duration_ms{loop}.
 */
export class MeteredLoop implements WorkerLoop {
  readonly name: string;
  readonly intervalMs: number;
  private lastStartMs: number | null = null;

  constructor(
    private readonly inner: WorkerLoop,
    private readonly metrics: Metrics,
    private readonly clock: Clock,
  ) {
    this.name = inner.name;
    this.intervalMs = inner.intervalMs;
  }

  async runOnce(): Promise<LoopReport> {
    const start = this.clock.now().getTime();
    const labels = { loop: this.name };
    if (this.lastStartMs !== null) {
      const lag = Math.max(0, start - (this.lastStartMs + this.intervalMs));
      safeMetric(() => this.metrics.observe("vsp_worker_loop_lag_ms", lag, labels));
    }
    this.lastStartMs = start;
    const report = await guarded(() => this.inner.runOnce());
    const duration = Math.max(0, this.clock.now().getTime() - start);
    safeMetric(() => this.metrics.observe("vsp_worker_loop_duration_ms", duration, labels));
    safeMetric(() => this.metrics.increment("vsp_worker_loop_runs_total", { loop: this.name, result: report.ok ? "ok" : "failed" }));
    if (!report.ok) safeMetric(() => this.metrics.increment("vsp_worker_loop_errors_total", labels));
    if (report.processed > 0) safeMetric(() => this.metrics.increment("vsp_worker_loop_processed_total", labels, report.processed));
    return report;
  }
}

/** Small helper so each loop's body is wrapped identically. */
async function guarded(fn: () => Promise<LoopReport>): Promise<LoopReport> {
  try {
    return await fn();
  } catch (err) {
    return failed(err);
  }
}

// ---------------------------------------------------------------------------
// Outbox: dispatch (claim -> publish -> settle) and consume (dedup -> business consumer)
// ---------------------------------------------------------------------------

export class OutboxDispatchLoop implements WorkerLoop {
  readonly name = "outbox.dispatch";
  constructor(
    private readonly dispatcher: Pick<PgOutboxDispatcher, "runOnce">,
    readonly intervalMs = 1_000,
    private readonly limit = 100,
  ) {}
  runOnce(): Promise<LoopReport> {
    return guarded(async () => {
      const r = await this.dispatcher.runOnce(this.limit);
      return ok(r.dispatched, { failed: r.failed, deadLettered: r.deadLettered });
    });
  }
}

interface QueueEntry {
  message: OutboxMessage;
  attempts: number;
  nextAttemptAt: number;
}

export interface DeadLetter {
  messageId: string;
  topic: string;
  reasonCode: string;
  attempts: number;
}

/**
 * LOCAL FIXTURE consumer queue: the in-process analogue of the SQS queue + DLQ
 * behind the MemoryPublisherFixture. Deliveries are queued (deduplicated by
 * message id while pending) and consumed by OutboxConsumeLoop with bounded
 * retries; exhausted messages move to an in-memory dead-letter list (opaque
 * ids and reason codes only). Not durable: a process restart loses pending
 * entries, which the outbox does not redeliver (they are DISPATCHED) — local only.
 */
export class LocalConsumerQueueFixture {
  readonly badge = "LOCAL FIXTURE — in-memory consumer queue, not durable";
  private readonly entries = new Map<string, QueueEntry>();
  readonly dead: DeadLetter[] = [];
  overflowed = 0;
  private readonly unsubscribe: () => void;

  constructor(
    publisher: Pick<MemoryPublisherFixture, "subscribe">,
    private readonly clock: Clock,
    private readonly maxDepth = 10_000,
  ) {
    this.unsubscribe = publisher.subscribe(async (message) => {
      if (this.entries.has(message.messageId)) return;
      if (this.entries.size >= this.maxDepth) {
        this.overflowed += 1;
        throw new Error("LOCAL_CONSUMER_QUEUE_FULL");
      }
      this.entries.set(message.messageId, { message, attempts: 0, nextAttemptAt: this.clock.now().getTime() });
    });
  }

  get depth(): number {
    return this.entries.size;
  }

  due(limit: number): QueueEntry[] {
    const now = this.clock.now().getTime();
    return [...this.entries.values()].filter((e) => e.nextAttemptAt <= now).slice(0, limit);
  }

  ack(messageId: string): void {
    this.entries.delete(messageId);
  }

  retry(entry: QueueEntry, delayMs: number): void {
    entry.attempts += 1;
    entry.nextAttemptAt = this.clock.now().getTime() + delayMs;
  }

  deadLetter(entry: QueueEntry, reasonCode: string): void {
    this.entries.delete(entry.message.messageId);
    this.dead.push({ messageId: entry.message.messageId, topic: entry.message.topic, reasonCode, attempts: entry.attempts });
    if (this.dead.length > 1_000) this.dead.shift();
  }

  close(): void {
    this.unsubscribe();
  }
}

const TENANT = /^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$/;

export interface OutboxConsumeLoopOptions {
  db: Db;
  clock: Clock;
  logger: Logger;
  queue: LocalConsumerQueueFixture;
  consumers: BusinessModule["consumers"];
  intervalMs?: number;
  maxPerRun?: number;
  maxAttempts?: number;
  /** Base retry delay; doubled per attempt up to maxDelayMs. */
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * Runs the business consumers for delivered outbox messages with worker-level
 * deduplication (ConsumerDedup, consumer name `worker.<topic>`), in addition to
 * the consumers' own idempotency. The business consumer runs OUTSIDE any
 * transaction (it opens its own; PGlite serializes connections), then the
 * dedup row is recorded. A crash between the two re-runs the consumer on
 * redelivery, which is safe because every business consumer is idempotent.
 */
export class OutboxConsumeLoop implements WorkerLoop {
  readonly name = "outbox.consume";
  readonly intervalMs: number;
  private readonly dedup: PgConsumerDedup;
  private readonly maxPerRun: number;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;

  constructor(private readonly opts: OutboxConsumeLoopOptions) {
    this.intervalMs = opts.intervalMs ?? 1_000;
    this.maxPerRun = opts.maxPerRun ?? 50;
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.baseDelayMs = opts.baseDelayMs ?? 1_000;
    this.maxDelayMs = opts.maxDelayMs ?? 60_000;
    this.dedup = new PgConsumerDedup({ db: opts.db, clock: opts.clock, role: "app_worker" });
  }

  runOnce(): Promise<LoopReport> {
    return guarded(async () => {
      let consumed = 0;
      let duplicates = 0;
      let retried = 0;
      let dead = 0;
      for (const entry of this.opts.queue.due(this.maxPerRun)) {
        const m = entry.message;
        const tenantId = m.tenantId;
        const consumerName = `worker.${m.topic}`;
        const handler = (this.opts.consumers as Record<string, ((id: string, p: Record<string, unknown>) => Promise<void>) | undefined>)[m.topic];
        if (!tenantId || !TENANT.test(tenantId)) {
          this.opts.queue.deadLetter(entry, "OUTBOX_TENANT_MISSING");
          dead += 1;
          continue;
        }
        if (!handler) {
          this.opts.queue.deadLetter(entry, "OUTBOX_NO_CONSUMER");
          this.opts.logger.warn("worker.outbox.no_consumer", { topic: m.topic, messageId: m.messageId, reasonCode: "OUTBOX_NO_CONSUMER" });
          dead += 1;
          continue;
        }
        try {
          if (await this.dedup.isProcessed(tenantId, consumerName, m.messageId)) {
            this.opts.queue.ack(m.messageId);
            duplicates += 1;
            continue;
          }
          await handler(m.messageId, m.payload);
          await this.dedup.processOnceForTenant(tenantId, consumerName, m.messageId, async () => null);
          this.opts.queue.ack(m.messageId);
          consumed += 1;
        } catch (err) {
          if (entry.attempts + 1 >= this.maxAttempts) {
            this.opts.queue.deadLetter(entry, reasonOf(err));
            dead += 1;
            this.opts.logger.warn("worker.outbox.dead_lettered", { topic: m.topic, messageId: m.messageId, reasonCode: reasonOf(err) });
          } else {
            this.opts.queue.retry(entry, Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** entry.attempts));
            retried += 1;
          }
        }
      }
      return ok(consumed, { duplicates, retried, deadLettered: dead, depth: this.opts.queue.depth });
    });
  }
}

// ---------------------------------------------------------------------------
// Action ledger: reconciliation of UNKNOWN / stale COMMITTING, and expiry
// ---------------------------------------------------------------------------

export class ActionReconcileLoop implements WorkerLoop {
  readonly name = "actions.reconcile";
  constructor(
    private readonly actions: Pick<LedgerActionService, "listNeedingReconciliation" | "reconcile">,
    private readonly providers: Partial<Record<ActionKind, ProviderCommitPort>>,
    private readonly tenantIds: readonly string[],
    private readonly logger: Logger,
    readonly intervalMs = 30_000,
    private readonly limit = 25,
  ) {}
  runOnce(): Promise<LoopReport> {
    return guarded(async () => {
      let reconciled = 0;
      let inconclusive = 0;
      let noProvider = 0;
      for (const tenantId of this.tenantIds) {
        for (const action of await this.actions.listNeedingReconciliation(tenantId, this.limit)) {
          const provider = this.providers[action.kind];
          if (!provider) {
            noProvider += 1;
            this.logger.warn("worker.reconcile.no_provider", { actionId: action.actionId, reasonCode: "RECONCILE_PROVIDER_MISSING" });
            continue;
          }
          try {
            await this.actions.reconcile(action.actionId, provider);
            reconciled += 1;
          } catch (err) {
            inconclusive += 1;
            this.logger.warn("worker.reconcile.inconclusive", { actionId: action.actionId, reasonCode: reasonOf(err) });
          }
        }
      }
      return ok(reconciled, { inconclusive, noProvider });
    });
  }
}

export class ActionExpiryLoop implements WorkerLoop {
  readonly name = "actions.expire";
  constructor(
    private readonly actions: Pick<LedgerActionService, "expireDue">,
    private readonly tenantIds: readonly string[],
    readonly intervalMs = 15_000,
    private readonly limit = 100,
  ) {}
  runOnce(): Promise<LoopReport> {
    return guarded(async () => {
      let expired = 0;
      for (const t of this.tenantIds) expired += await this.actions.expireDue(t, this.limit);
      return ok(expired);
    });
  }
}

export class ToolIdempotencyPurgeLoop implements WorkerLoop {
  readonly name = "tools.idempotency_purge";
  constructor(
    private readonly store: Pick<ToolRequestIdempotency, "purgeExpired">,
    private readonly tenantIds: readonly string[],
    readonly intervalMs = 300_000,
    private readonly limit = 500,
  ) {}
  runOnce(): Promise<LoopReport> {
    return guarded(async () => {
      let purged = 0;
      for (const t of this.tenantIds) purged += await this.store.purgeExpired(t, this.limit);
      return ok(purged);
    });
  }
}

// ---------------------------------------------------------------------------
// Audit shipping, workflows, transfers, retention
// ---------------------------------------------------------------------------

export class AuditShipLoop implements WorkerLoop {
  readonly name = "audit.ship";
  constructor(
    private readonly shipper: Pick<AuditShipper, "runOnce">,
    readonly intervalMs = 10_000,
  ) {}
  runOnce(): Promise<LoopReport> {
    return guarded(async () => {
      const r = await this.shipper.runOnce();
      const blocked = r.streams.filter((s) => s.reasonCode !== null).length;
      return ok(r.eventsShipped, { batches: r.batchesShipped, streamsWithReason: blocked });
    });
  }
}

export class WorkflowTickLoop implements WorkerLoop {
  readonly name = "workflows.tick";
  constructor(
    private readonly workflows: Pick<PgWorkflowEngine, "tickDetailed">,
    private readonly clock: Clock,
    readonly intervalMs = 5_000,
  ) {}
  runOnce(): Promise<LoopReport> {
    return guarded(async () => {
      const r = await this.workflows.tickDetailed(this.clock.now());
      return { ok: r.failures.length === 0, processed: r.events.length, reasonCode: r.failures[0]?.reasonCode ?? null, details: { failures: r.failures.length } };
    });
  }
}

export class TransferSweepLoop implements WorkerLoop {
  readonly name = "transfers.sweep";
  constructor(
    private readonly transfers: Pick<TransferCoordinator, "sweepTimeouts">,
    readonly intervalMs = 5_000,
  ) {}
  runOnce(): Promise<LoopReport> {
    return guarded(async () => ok(await this.transfers.sweepTimeouts()));
  }
}

/**
 * Retention: deletes nothing while no approved duration exists; BLOCKED classes are reported, never "deleted".
 * Emits vsp_retention_deleted_total{data_class}, vsp_retention_classes_blocked{data_class,reason},
 * vsp_retention_unverified_copies{location,status} and (when the job can count them)
 * vsp_vendor_deletion_requests_pending{vendor}.
 */
export class RetentionLoop implements WorkerLoop {
  readonly name = "retention.run";
  constructor(
    private readonly job: Pick<RetentionJob, "run"> & Partial<Pick<RetentionJob, "pendingVendorDeletions">>,
    private readonly clock: Clock,
    private readonly logger: Logger,
    readonly intervalMs = 86_400_000,
    private readonly metrics: Metrics = noopMetrics,
  ) {}
  runOnce(): Promise<LoopReport> {
    return guarded(async () => {
      const reports = await this.job.run(this.clock.now());
      let deleted = 0;
      let blockedClasses = 0;
      let unverified = 0;
      const deletedByClass = new Map<string, number>();
      const blocked = new Map<string, number>();
      const copies = new Map<string, number>();
      for (const r of reports) {
        for (const d of r.datasets) {
          deleted += d.deletedCount;
          deletedByClass.set(d.dataClass, (deletedByClass.get(d.dataClass) ?? 0) + d.deletedCount);
        }
        blockedClasses += r.classes.filter((c) => c.status !== "EXECUTED").length;
        unverified += r.unverifiedCopies.length;
        for (const c of r.classes) {
          if (c.status !== "EXECUTED") {
            this.logger.warn("worker.retention.class_blocked", { dataClass: c.dataClass, reasonCode: c.status });
            blocked.set(`${c.dataClass}|${c.status}`, (blocked.get(`${c.dataClass}|${c.status}`) ?? 0) + 1);
          }
        }
        for (const u of r.unverifiedCopies) copies.set(`${u.location}|${u.status}`, (copies.get(`${u.location}|${u.status}`) ?? 0) + 1);
      }
      for (const [dataClass, n] of deletedByClass) if (n > 0) safeMetric(() => this.metrics.increment("vsp_retention_deleted_total", { data_class: dataClass }, n));
      for (const dataClass of DATA_CLASSES) {
        for (const reason of BLOCK_REASONS) {
          safeMetric(() => this.metrics.gauge("vsp_retention_classes_blocked", blocked.get(`${dataClass}|${reason}`) ?? 0, { data_class: dataClass, reason }));
        }
      }
      for (const location of COPY_LOCATIONS) {
        for (const status of COPY_STATUSES) {
          safeMetric(() => this.metrics.gauge("vsp_retention_unverified_copies", copies.get(`${location}|${status}`) ?? 0, { location, status }));
        }
      }
      if (this.job.pendingVendorDeletions) {
        const pending = await this.job.pendingVendorDeletions().catch(() => null);
        if (pending) for (const [vendor, n] of Object.entries(pending)) safeMetric(() => this.metrics.gauge("vsp_vendor_deletion_requests_pending", n, { vendor }));
      }
      const status = reports.every((r) => r.status === "BLOCKED_RETENTION_UNSET") ? "BLOCKED_RETENTION_UNSET" : null;
      return { ok: true, processed: deleted, reasonCode: status, details: { blockedClasses, unverifiedCopies: unverified, runs: reports.length } };
    });
  }
}

const DATA_CLASSES = ["TRANSIENT_CONVERSATION", "BUSINESS_RECORD", "RESTRICTED_QA_MEDIA", "SECURITY_AUDIT"] as const;
const BLOCK_REASONS = ["BLOCKED_RETENTION_UNSET", "BLOCKED_RETENTION_CONFIG_MISMATCH"] as const;
const COPY_LOCATIONS = ["DERIVED_TABLE", "INDEX", "CACHE", "BACKUP", "VENDOR"] as const;
const COPY_STATUSES = ["LEFTOVERS_FOUND", "UNVERIFIABLE"] as const;

// ---------------------------------------------------------------------------
// LOCAL FIXTURE: telephony fixture events -> transfer coordinator
// ---------------------------------------------------------------------------

/**
 * Delivers the telephony fixture's queued lifecycle events (duplicated and
 * reordered by script) to the TransferCoordinator. The coordinator dedups by
 * event id and applies only legal transitions. LOCAL FIXTURE only: live
 * Talkdesk transfer events are BLOCKED (TB-07 / TB-09).
 */
export class LocalTelephonyDeliveryLoop implements WorkerLoop {
  readonly name = "telephony.local_fixture_delivery";
  private unmatched = 0;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly telephony: Pick<TelephonyFixture, "subscribe" | "deliverAll" | "kind">,
    private readonly store: Pick<TransferStore, "get">,
    private readonly transfers: Pick<TransferCoordinator, "applyEvent">,
    readonly intervalMs = 500,
    private readonly maxPerRun = 200,
  ) {
    if (telephony.kind !== "local_fixture") throw new RangeError("LOCAL_TELEPHONY_DELIVERY_REQUIRES_FIXTURE");
    this.unsubscribe = telephony.subscribe(async (e: TelephonyEvent) => {
      const name = TRANSFER_EVENT_FOR_STATE[e.state];
      if (!name) return; // REQUESTED: the dial itself
      const journey = await this.store.get(e.handoffId);
      const transferId = journey ? Object.entries(journey.vendorRefs).find(([, ref]) => ref === e.transferRef)?.[0] : undefined;
      if (!transferId) {
        this.unmatched += 1;
        return;
      }
      await this.transfers.applyEvent({ transferId, event: name as never, eventId: e.eventId, source: "telephony.local_fixture" });
    });
  }

  runOnce(): Promise<LoopReport> {
    return guarded(async () => {
      const before = this.unmatched;
      const delivered = await this.telephony.deliverAll(this.maxPerRun);
      return ok(delivered, { unmatched: this.unmatched - before });
    });
  }

  close(): void {
    this.unsubscribe();
  }
}
