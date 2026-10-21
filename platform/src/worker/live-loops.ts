/**
 * Worker loops of the live composition (WP-07; FO-16-11, FO-19-06, FO-21-10; WP-04 hand-off).
 *
 * Production entry point (modules.yaml `entryPoints`, transitive): built from loop-kit.ts only, never from the
 * regression worker's loops.ts (which carries the LOCAL FIXTURE consumer queue and telephony delivery).
 *
 *   outbox.dispatch        PgOutboxDispatcher -> SQS (SqsPublisher); a run in which any claimed message failed to
 *                          publish or was moved to DEAD FAILS (OUTBOX_PUBLISH_FAILED / OUTBOX_DEAD_LETTERED) and
 *                          counts vsp_outbox_publish_failures_total{reason} (outbox-publish-failures alarm), so a
 *                          queue that refuses every publish turns worker readiness 503 (OPS-01)
 *   outbox.consume         SQS receive -> business consumer (deduplicated per tenant/consumer/message) -> delete;
 *                          an envelope of a tenant this worker does not serve is unconsumable (never deduplicated
 *                          or consumed under that tenant);
 *                          a failed message is left to the queue (visibility timeout, then the queue's redrive
 *                          policy moves it to the dead-letter queue); never acknowledged without its effect. A
 *                          run with any failed or unconsumable message FAILS (OUTBOX_CONSUME_FAILED /
 *                          OUTBOX_UNCONSUMABLE): readiness turns 503 after consecutive failing runs and
 *                          vsp_outbox_consume_failures_total{reason} feeds the outbox-consume-failures alarm, so a
 *                          consumer that fails on every message is never reported healthy (OPS-01)
 *   actions.reconcile / actions.expire / idempotency.purge / workflows.tick / transfers.sweep / retention.run /
 *   support.sync_retry     as in the regression worker, over the live stores
 *   audit.deferred_flush   the durable deferred route-audit queue (PostgreSQL + independent DynamoDB journal)
 *   audit.route_reconcile  RouteAuditReconciler (route intents / safety incidents without evidence -> markers)
 *   connectors.feed_sync   every configured connector change feed (DLQ_FULL stops a feed, checkpoint kept)
 * Audit shipping and verification run in the separate audit-exporter unit under their own identity.
 */
import { ReceiveMessageCommand, DeleteMessageCommand } from "@aws-sdk/client-sqs";
import type { ReceiveMessageCommandOutput } from "@aws-sdk/client-sqs";
import { RouteAuditReconciler } from "../audit/route-reconciler.js";
import type { BusinessModule } from "../business/contract.js";
import type { Db } from "../db/types.js";
import type { LiveContainer } from "../main/live-container.js";
import type { Logger, Metrics } from "../observability/ports.js";
import { integrationHoldReader } from "../ops/integration-gate.js";
import { PgConsumerDedup } from "../outbox/consumer-dedup.js";
import type { SqsQueueClient } from "../outbox/sqs-dlq.js";
import { OUTBOX_ENVELOPE_SCHEMA } from "../outbox/sqs-publisher.js";
import type { Clock } from "../shared/clock.js";
import { PlatformError } from "../shared/errors.js";
import {
  ActionExpiryLoop,
  ActionReconcileLoop,
  DeferredAuditFlushLoop,
  MeteredLoop,
  OutboxDispatchLoop,
  PgOutboxRetryBacklog,
  RetentionLoop,
  SupportSyncRetryLoop,
  ToolIdempotencyPurgeLoop,
  TransferSweepLoop,
  WorkflowTickLoop,
  guardedRun,
  okReport,
} from "./loop-kit.js";
import type { LoopReport, WorkerLoop } from "./loop-kit.js";

const TENANT = /^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$/;
const MESSAGE_ID = /^msg_[A-Za-z0-9_-]{16,64}$/;
const TOPIC = /^[a-z][a-z0-9_.]{2,63}$/;
const reasonOf = (err: unknown): string => (err instanceof PlatformError && /^[A-Z][A-Z0-9_]{2,63}$/.test(err.reasonCode) ? err.reasonCode : "UNCLASSIFIED_ERROR");

export interface SqsOutboxConsumeLoopOptions {
  db: Db;
  clock: Clock;
  logger: Logger;
  sqs: SqsQueueClient;
  queueUrl: string;
  consumers: BusinessModule["consumers"];
  /**
   * The tenants this worker serves (trusted configuration). An envelope naming any other tenant is unconsumable:
   * its tenant id is never used for deduplication or handed to a consumer.
   */
  tenantIds: readonly string[];
  /** vsp_outbox_consume_failures_total{reason} (content free: closed reason enum). */
  metrics?: Metrics | null;
  intervalMs?: number;
  /** Messages per receive (1..10, the SQS maximum). */
  batchSize?: number;
  /** Seconds a received message stays invisible while it is handled (the redelivery delay after a failure). */
  visibilityTimeoutSeconds?: number;
}

/** Live outbox consumer: SQS at-least-once delivery, worker-level deduplication, delete only after the effect. */
export class SqsOutboxConsumeLoop implements WorkerLoop {
  readonly name = "outbox.consume";
  readonly intervalMs: number;
  private readonly dedup: PgConsumerDedup;

  constructor(private readonly o: SqsOutboxConsumeLoopOptions) {
    this.intervalMs = o.intervalMs ?? 1_000;
    this.dedup = new PgConsumerDedup({ db: o.db, clock: o.clock, role: "app_worker" });
  }

  runOnce(): Promise<LoopReport> {
    return guardedRun(async () => {
      const out = (await this.o.sqs.send(
        new ReceiveMessageCommand({ QueueUrl: this.o.queueUrl, MaxNumberOfMessages: Math.min(10, Math.max(1, this.o.batchSize ?? 10)), WaitTimeSeconds: 0, VisibilityTimeout: this.o.visibilityTimeoutSeconds ?? 60 }),
      )) as ReceiveMessageCommandOutput;
      let consumed = 0;
      let duplicates = 0;
      let failed = 0;
      let unconsumable = 0;
      const count = (reason: "consume_failed" | "envelope_invalid" | "no_consumer") => {
        try {
          this.o.metrics?.increment("vsp_outbox_consume_failures_total", { reason });
        } catch {
          // the failed run below does not depend on the metrics sink
        }
      };
      for (const m of out.Messages ?? []) {
        if (!m.ReceiptHandle) continue;
        let env: { schema?: unknown; messageId?: unknown; tenantId?: unknown; topic?: unknown; payload?: unknown };
        try {
          env = JSON.parse(m.Body ?? "") as typeof env;
        } catch {
          env = {};
        }
        const valid =
          env.schema === OUTBOX_ENVELOPE_SCHEMA &&
          typeof env.messageId === "string" &&
          MESSAGE_ID.test(env.messageId) &&
          typeof env.tenantId === "string" &&
          TENANT.test(env.tenantId) &&
          this.o.tenantIds.includes(env.tenantId) &&
          typeof env.topic === "string" &&
          TOPIC.test(env.topic) &&
          typeof env.payload === "object" &&
          env.payload !== null;
        const handler = valid ? (this.o.consumers as Record<string, ((id: string, p: Record<string, unknown>) => Promise<void>) | undefined>)[env.topic as string] : undefined;
        if (!valid || !handler) {
          // Not ours to settle: left to the queue, whose redrive policy dead-letters it after maxReceiveCount.
          unconsumable += 1;
          count(valid ? "no_consumer" : "envelope_invalid");
          this.o.logger.warn("worker.outbox.unconsumable", { reasonCode: valid ? "OUTBOX_NO_CONSUMER" : "OUTBOX_ENVELOPE_INVALID" });
          continue;
        }
        const messageId = env.messageId as string;
        const tenantId = env.tenantId as string;
        const consumerName = `worker.${env.topic as string}`;
        try {
          if (await this.dedup.isProcessed(tenantId, consumerName, messageId)) {
            duplicates += 1;
          } else {
            await handler(messageId, env.payload as Record<string, unknown>);
            await this.dedup.processOnceForTenant(tenantId, consumerName, messageId, async () => null);
            consumed += 1;
          }
          await this.o.sqs.send(new DeleteMessageCommand({ QueueUrl: this.o.queueUrl, ReceiptHandle: m.ReceiptHandle }));
        } catch (err) {
          failed += 1;
          count("consume_failed");
          this.o.logger.warn("worker.outbox.consume_failed", { reasonCode: reasonOf(err), messageId });
        }
      }
      if (failed > 0 || unconsumable > 0) {
        return { ok: false, processed: consumed, reasonCode: failed > 0 ? "OUTBOX_CONSUME_FAILED" : "OUTBOX_UNCONSUMABLE", details: { duplicates, failed, unconsumable } };
      }
      return okReport(consumed, { duplicates, failed, unconsumable });
    });
  }
}

/** RouteAuditReconciler as a loop (WP-04 hand-off): route intents and safety incidents left without evidence. */
export class RouteAuditReconcileLoop implements WorkerLoop {
  readonly name = "audit.route_reconcile";
  constructor(
    private readonly reconciler: Pick<RouteAuditReconciler, "runOnce">,
    readonly intervalMs = 60_000,
  ) {}
  runOnce(): Promise<LoopReport> {
    return guardedRun(async () => {
      const r = await this.reconciler.runOnce();
      return okReport(r.markerEventIds.length, {
        intentsEvidenced: r.routeIntents.evidenced,
        intentsNotRecorded: r.routeIntents.notRecorded,
        incidentsEvidenced: r.safetyIncidents.evidenced,
        incidentsNotRecorded: r.safetyIncidents.notRecorded,
      });
    });
  }
}

/** A connector change feed (adapters/live/connector-feed.ts ConnectorFeedSync satisfies it). */
export interface FeedSync {
  runOnce(): Promise<{ result: "caught_up" | "page_limit" | "stopped"; records: number; indexed: number; deadLettered: number; reasonCode: string | null }>;
}

/** Runs every configured feed once per run; a stopped feed fails the run with its reason code (readiness). */
export class ConnectorFeedLoop implements WorkerLoop {
  readonly name = "connectors.feed_sync";
  constructor(
    private readonly feeds: readonly FeedSync[],
    readonly intervalMs = 60_000,
  ) {}
  runOnce(): Promise<LoopReport> {
    return guardedRun(async () => {
      let indexed = 0;
      let deadLettered = 0;
      let stopped: string | null = null;
      for (const f of this.feeds) {
        const r = await f.runOnce();
        indexed += r.indexed;
        deadLettered += r.deadLettered;
        if (r.result === "stopped") stopped ??= r.reasonCode ?? "CONNECTOR_FEED_STOPPED";
      }
      return { ok: stopped === null, processed: indexed, reasonCode: stopped, details: { feeds: this.feeds.length, deadLettered } };
    });
  }
}

export interface LiveWorkerIntervals {
  dispatchMs?: number;
  consumeMs?: number;
  reconcileMs?: number;
  expireMs?: number;
  purgeMs?: number;
  workflowTickMs?: number;
  transferSweepMs?: number;
  retentionMs?: number;
  supportSyncRetryMs?: number;
  deferredAuditFlushMs?: number;
  routeReconcileMs?: number;
  feedSyncMs?: number;
}

/** The live worker's loops over a live container (every loop metered, content-free). */
export function liveWorkerLoopsFor(c: LiveContainer, o: { feeds?: readonly FeedSync[]; intervals?: LiveWorkerIntervals; instanceId: string; metrics?: Metrics }): WorkerLoop[] {
  const i = o.intervals ?? {};
  const outbox = c.config.infrastructure?.outbox;
  if (!outbox) throw new TypeError("LIVE_WORKER_OUTBOX_NOT_CONFIGURED");
  const raw: WorkerLoop[] = [
    new OutboxDispatchLoop(c.dispatcher, i.dispatchMs, undefined, o.metrics ?? c.metrics, new PgOutboxRetryBacklog(c.db, c.tenantIds)),
    new SqsOutboxConsumeLoop({
      db: c.db,
      clock: c.clock,
      logger: c.logger,
      metrics: o.metrics ?? c.metrics,
      sqs: c.aws.sqs as unknown as SqsQueueClient,
      queueUrl: outbox.queueUrl,
      consumers: c.business.consumers,
      tenantIds: c.tenantIds,
      ...(i.consumeMs ? { intervalMs: i.consumeMs } : {}),
    }),
    new ActionReconcileLoop(c.actions, c.business.providers, c.tenantIds, c.logger, i.reconcileMs, undefined, c.metrics),
    new ActionExpiryLoop(c.actions, c.tenantIds, i.expireMs),
    new ToolIdempotencyPurgeLoop(c.toolIdempotency, c.tenantIds, i.purgeMs),
    new DeferredAuditFlushLoop(c.deferredAudit, i.deferredAuditFlushMs),
    new RouteAuditReconcileLoop(
      new RouteAuditReconciler({ db: c.db, writer: c.audit, clock: c.clock, tenants: c.tenantIds, stream: `worker.${o.instanceId}`, logger: c.logger, metrics: c.metrics }),
      i.routeReconcileMs,
    ),
    new WorkflowTickLoop(c.workflows, c.clock, i.workflowTickMs),
    new TransferSweepLoop(c.transfers, i.transferSweepMs),
    new RetentionLoop(c.retention, c.clock, c.logger, i.retentionMs, c.metrics),
    // Held while INTEGRATION <support records> or WRITES is engaged, or the CRM capability is NOT_CONFIGURED.
    new SupportSyncRetryLoop(c.business.supportRequests, c.tenantIds, i.supportSyncRetryMs, undefined, (tenantId) =>
      integrationHoldReader(() => c.gates.killSwitches.snapshot(tenantId), { integration: c.deps.adapters.supportRecords.integrationId, write: true }),
    ),
    ...(o.feeds && o.feeds.length > 0 ? [new ConnectorFeedLoop(o.feeds, i.feedSyncMs)] : []),
  ];
  return raw.map((l) => new MeteredLoop(l, o.metrics ?? c.metrics, c.clock));
}
