/**
 * Worker composition: the loops over a built Container, their status, and the
 * worker's health surface (GET /health/live, GET /health/ready on port 8081 per
 * the infrastructure contract). Readiness is false until every loop has run
 * at least once, and whenever a loop has failed three times in a row or has
 * not completed a run within three intervals (stalled).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { IntegrationAuthenticationError } from "../gateway/auth.js";
import type { IntegrationAuthenticator } from "../gateway/auth.js";
import { buildGatewayApp } from "../gateway/http/app.js";
import { LivenessBody } from "../gateway/http/health-routes.js";
import { defineRoute } from "../gateway/http/route.js";
import type { RouteDef } from "../gateway/http/route.js";
import type { Container } from "../main/container.js";
import type { Logger } from "../observability/ports.js";
import type { Clock } from "../shared/clock.js";
import { iso } from "../shared/clock.js";
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
  RetentionLoop,
  SupportSyncRetryLoop,
  ToolIdempotencyPurgeLoop,
  TransferSweepLoop,
  WorkflowTickLoop,
} from "./loops.js";
import type { LoopReport, WorkerLoop } from "./loops.js";
import type { LoopScheduler } from "./scheduler.js";
import { integrationHoldReader } from "../ops/integration-gate.js";
import { AuditCompletenessMonitor } from "../audit/monitor.js";

export interface LoopStatus {
  name: string;
  intervalMs: number;
  runs: number;
  lastRunAt: string | null;
  lastOk: boolean | null;
  lastReasonCode: string | null;
  lastProcessed: number;
  consecutiveFailures: number;
}

const FAILURES_BEFORE_NOT_READY = 3;
const STALL_INTERVALS = 3;

export class Worker {
  private readonly statuses = new Map<string, LoopStatus>();
  private readonly running = new Set<string>();
  private startedAt: number | null = null;

  constructor(
    private readonly opts: { loops: readonly WorkerLoop[]; scheduler: LoopScheduler; clock: Clock; logger: Logger; closers?: (() => void)[] },
  ) {
    const names = new Set<string>();
    for (const l of opts.loops) {
      if (names.has(l.name)) throw new RangeError("WORKER_LOOP_DUPLICATE");
      names.add(l.name);
      this.statuses.set(l.name, { name: l.name, intervalMs: l.intervalMs, runs: 0, lastRunAt: null, lastOk: null, lastReasonCode: null, lastProcessed: 0, consecutiveFailures: 0 });
    }
  }

  get loopNames(): string[] {
    return [...this.statuses.keys()].sort();
  }

  start(): void {
    if (this.startedAt !== null) return;
    this.startedAt = this.opts.clock.now().getTime();
    for (const l of this.opts.loops) this.opts.scheduler.schedule(l.name, l.intervalMs, async () => void (await this.runLoop(l.name)));
    this.opts.logger.info("worker.started", { loopCount: this.opts.loops.length });
  }

  /** Runs one loop now (no overlap with a scheduled run of the same loop). */
  async runLoop(name: string): Promise<LoopReport> {
    const loop = this.opts.loops.find((l) => l.name === name);
    const status = this.statuses.get(name);
    if (!loop || !status) throw new RangeError("WORKER_LOOP_UNKNOWN");
    if (this.running.has(name)) return { ok: true, processed: 0, reasonCode: "LOOP_ALREADY_RUNNING", details: {} };
    this.running.add(name);
    try {
      const report = await loop.runOnce();
      status.runs += 1;
      status.lastRunAt = iso(this.opts.clock.now());
      status.lastOk = report.ok;
      status.lastReasonCode = report.reasonCode;
      status.lastProcessed = report.processed;
      status.consecutiveFailures = report.ok ? 0 : status.consecutiveFailures + 1;
      if (!report.ok) this.opts.logger.warn("worker.loop.failed", { loop: name, reasonCode: report.reasonCode, consecutiveFailures: status.consecutiveFailures });
      else if (report.processed > 0) this.opts.logger.info("worker.loop.ran", { loop: name, processed: report.processed });
      return report;
    } finally {
      this.running.delete(name);
    }
  }

  /** Runs every loop once, sequentially (tests, the local demo and graceful drains). */
  async runAllOnce(): Promise<Record<string, LoopReport>> {
    const out: Record<string, LoopReport> = {};
    for (const name of this.loopNames) out[name] = await this.runLoop(name);
    return out;
  }

  status(): LoopStatus[] {
    return this.loopNames.map((n) => ({ ...(this.statuses.get(n) as LoopStatus) }));
  }

  readiness(): { ready: boolean; reasonCode: string | null; loops: { name: string; ok: boolean; reasonCode: string | null }[] } {
    const now = this.opts.clock.now().getTime();
    const loops = this.status().map((s) => {
      if (s.runs === 0) return { name: s.name, ok: false, reasonCode: "LOOP_NOT_YET_RUN" };
      if (s.consecutiveFailures >= FAILURES_BEFORE_NOT_READY) return { name: s.name, ok: false, reasonCode: s.lastReasonCode ?? "LOOP_FAILING" };
      const last = s.lastRunAt ? Date.parse(s.lastRunAt) : 0;
      if (now - last > s.intervalMs * STALL_INTERVALS) return { name: s.name, ok: false, reasonCode: "LOOP_STALLED" };
      return { name: s.name, ok: true, reasonCode: null };
    });
    const firstBad = loops.find((l) => !l.ok);
    return { ready: this.startedAt !== null && !firstBad, reasonCode: this.startedAt === null ? "WORKER_NOT_STARTED" : (firstBad?.reasonCode ?? null), loops };
  }

  async stop(): Promise<void> {
    await this.opts.scheduler.stop();
    for (const c of this.opts.closers ?? []) c();
    this.opts.logger.info("worker.stopped", { loopCount: this.opts.loops.length });
  }
}

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
    new OutboxDispatchLoop(c.dispatcher, intervals.dispatchMs),
    new OutboxConsumeLoop({ db: c.db, clock: c.clock, logger: c.logger, queue, consumers: c.business.consumers, ...(intervals.consumeMs ? { intervalMs: intervals.consumeMs } : {}) }),
    new ActionReconcileLoop(c.actions, c.business.providers, c.tenantIds, c.logger, intervals.reconcileMs),
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

const ReadyBody = z.strictObject({
  ready: z.boolean(),
  reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/).nullable(),
  loops: z.array(z.strictObject({ name: z.string().max(64), ok: z.boolean(), reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/).nullable() })).max(32),
});

export function workerHealthRoutes(worker: Worker): RouteDef<unknown, unknown>[] {
  return [
    defineRoute({
      operationId: "worker.live",
      method: "GET",
      path: "/health/live",
      channel: null,
      summary: "Worker process liveness.",
      tags: ["health"],
      rateLimitExempt: true,
      responses: { 200: { description: "Live", schema: LivenessBody } },
      handler: async () => ({ status: 200, body: { status: "live" } }),
    }),
    defineRoute({
      operationId: "worker.ready",
      method: "GET",
      path: "/health/ready",
      channel: null,
      summary: "Worker readiness: every loop has run, none failing repeatedly or stalled (loop names and reason codes only).",
      tags: ["health"],
      rateLimitExempt: true,
      responses: { 200: { description: "Ready", schema: ReadyBody }, 503: { description: "Not ready", schema: ReadyBody } },
      handler: async () => {
        const r = worker.readiness();
        return { status: r.ready ? 200 : 503, body: r };
      },
    }),
  ] as RouteDef<unknown, unknown>[];
}

/** The worker exposes no authenticated route: any credential is refused. */
const noIntegrations: IntegrationAuthenticator = {
  kind: "live",
  async authenticate() {
    throw new IntegrationAuthenticationError("INTEGRATION_CHANNEL_NOT_ALLOWED");
  },
};

export function buildWorkerHealthApp(worker: Worker, logger: Logger): Promise<FastifyInstance> {
  return buildGatewayApp({ logger, authenticator: noIntegrations, routes: workerHealthRoutes(worker), rateLimit: null });
}
