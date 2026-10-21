/**
 * Layer 2 (WP-07; FO-21-10, FO-16-11, OPS-01, ACT-02): the live worker's outbox consumer over ElasticMQ and
 * PostgreSQL 16, inside the live container (unit "worker").
 *
 * The production SqsOutboxConsumeLoop (worker/live-loops.ts) receives from a real queue, deduplicates in the
 * real consumer_dedup table and deletes only after the effect. Asserted: a consumed message is deleted; a
 * redelivered duplicate is deleted without being applied again; a failed handler and an unconsumable envelope
 * leave their messages on the queue (redelivered after the visibility timeout); a run with any failure FAILS
 * (OUTBOX_CONSUME_FAILED / OUTBOX_UNCONSUMABLE) and counts vsp_outbox_consume_failures_total{reason}, the
 * outbox-consume-failures alarm rule fires, and after three failing runs the worker's /health/ready answers
 * 503 (a consumer failing on every message is never reported healthy, OPS-01).
 *
 * The producer side too (security review round 2, D2): the composed outbox.dispatch loop (PgOutboxDispatcher
 * -> SqsPublisher) over an outbox queue that does not exist on ElasticMQ, so every publish is refused. Each run
 * fails (OUTBOX_PUBLISH_FAILED, then OUTBOX_PUBLISH_RETRYING while the message waits out its backoff), the
 * failure is counted in vsp_outbox_publish_failures_total{reason} and the outbox-publish-failures alarm rule
 * fires, worker readiness answers 503 after three failing runs, and the message stays PENDING in PostgreSQL;
 * once the queue exists the message is published and readiness recovers.
 *
 * Test plumbing, labelled: the recording consumers below stand in for the business module's topic handlers
 * (the loop under test is production code; its consumers are a port); the real business consumer of
 * action.committed is used too, with a payload it must refuse.
 */
import { randomBytes } from "node:crypto";
import { CreateQueueCommand, GetQueueAttributesCommand, ReceiveMessageCommand, SendMessageCommand } from "@aws-sdk/client-sqs";
import { afterAll, beforeAll, describe, expect } from "vitest";
import type { BusinessModule } from "../../../src/business/contract.js";
import type { LiveContainer } from "../../../src/main/live-container.js";
import { createMemoryLogger } from "../../../src/observability/logger.js";
import { alarmRule, evaluateAlarm } from "../../../src/observability/alarms.js";
import { OUTBOX_ENVELOPE_SCHEMA } from "../../../src/outbox/sqs-publisher.js";
import type { SqsQueueClient } from "../../../src/outbox/sqs-dlq.js";
import { ensurePolicyBundle } from "../../../src/policy/ensure-bundle.js";
import { DependencyError } from "../../../src/shared/errors.js";
import { newId } from "../../../src/shared/ids.js";
import { SqsOutboxConsumeLoop, liveWorkerLoopsFor } from "../../../src/worker/live-loops.js";
import { ManualLoopScheduler } from "../../../src/worker/scheduler.js";
import { Worker, buildWorkerHealthApp } from "../../../src/worker/runtime.js";
import { awsQueueUrl, uniqueName } from "../_harness/clients.js";
import { layer2, layer2Context } from "../_harness/layer2.js";
import { SUBSTRATE, TENANT, bootLive, createQueue, provisionSandbox } from "./support.js";
import type { Sandbox } from "./support.js";

const it = layer2([...SUBSTRATE]);

let sb: Sandbox;
let c: LiveContainer;
beforeAll(async () => {
  ensurePolicyBundle();
  sb = await provisionSandbox(layer2Context(SUBSTRATE));
  ({ c } = await bootLive(sb, { unit: "worker" }));
});
afterAll(async () => {
  await c?.close();
  await sb?.close();
});

const messageId = () => `msg_synth${randomBytes(10).toString("hex")}`;
const envelope = (topic: string, id: string, payload: Record<string, unknown> = { probe: "synthetic" }) => JSON.stringify({ schema: OUTBOX_ENVELOPE_SCHEMA, messageId: id, tenantId: TENANT, topic, payload });

async function send(queueUrl: string, body: string): Promise<void> {
  await sb.sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: body }));
}

/** Messages on the queue, visible or in flight (ElasticMQ reports both counts). */
async function onQueue(queueUrl: string): Promise<number> {
  const a = await sb.sqs.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"] }));
  return Number(a.Attributes?.ApproximateNumberOfMessages ?? 0) + Number(a.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0);
}

/** Test plumbing: topic handlers that record what was applied (and one that always fails). */
function recordingConsumers(applied: string[]): BusinessModule["consumers"] {
  return {
    "support_request.sync": async (id) => {
      applied.push(id);
    },
    "workflow.signal": async () => {
      throw new DependencyError("CONSUMER_SYNTHETIC_FAILURE", "FAILED", true);
    },
  };
}

const loopFor = (queueUrl: string, consumers: BusinessModule["consumers"], visibilityTimeoutSeconds = 30) =>
  new SqsOutboxConsumeLoop({ db: c.db, clock: c.clock, logger: c.logger, metrics: c.metrics, sqs: c.aws.sqs as unknown as SqsQueueClient, queueUrl, consumers, tenantIds: c.tenantIds, visibilityTimeoutSeconds });

const failures = () => c.localMetrics.find("vsp_outbox_consume_failures_total").map((s) => ({ metric: s.name, labels: s.labels, value: s.value }));
const failureCount = (reason: string) => failures().filter((s) => s.labels.reason === reason).reduce((n, s) => n + s.value, 0);

describe("live outbox consumer on ElasticMQ [FO-21-10][OPS-01]", () => {
  it("[FO-16-11][ACT-02] positive: a consumed message is deleted after its effect; a redelivered duplicate is deleted without being applied again", async () => {
    const queue = await createQueue(sb.sqs, "vsp-it-comp-consume-ok");
    const applied: string[] = [];
    const loop = loopFor(queue, recordingConsumers(applied));
    const id = messageId();
    await send(queue, envelope("support_request.sync", id));
    const r1 = await loop.runOnce();
    expect(r1).toMatchObject({ ok: true, processed: 1, reasonCode: null, details: { duplicates: 0, failed: 0, unconsumable: 0 } });
    expect(applied).toEqual([id]);
    expect(await onQueue(queue)).toBe(0);
    // At-least-once delivery: the same message again (a redelivery) is recognised and only deleted.
    await send(queue, envelope("support_request.sync", id));
    const r2 = await loop.runOnce();
    expect(r2).toMatchObject({ ok: true, processed: 0, details: { duplicates: 1 } });
    expect(applied).toEqual([id]);
    expect(await onQueue(queue)).toBe(0);
  });

  it("[OPS-01][FO-21-10] failure injection: a failing handler, an invalid envelope and a message without a consumer stay on the queue; the run fails, the failures are counted and the alarm fires", async () => {
    const queue = await createQueue(sb.sqs, "vsp-it-comp-consume-fail");
    const applied: string[] = [];
    const before = { consume: failureCount("consume_failed"), invalid: failureCount("envelope_invalid"), none: failureCount("no_consumer") };
    const loop = loopFor(queue, { ...recordingConsumers(applied), "action.committed": c.business.consumers["action.committed"] }, 1);
    await send(queue, envelope("workflow.signal", messageId()));
    // The real business consumer of action.committed refuses a payload that is not a committed action.
    await send(queue, envelope("action.committed", messageId(), { actionId: "not-an-action" }));
    await send(queue, "not an outbox envelope");
    await send(queue, envelope("notification.send", messageId()));
    const r = await loop.runOnce();
    expect(r.ok).toBe(false);
    expect(r.reasonCode).toBe("OUTBOX_CONSUME_FAILED");
    expect(r.details).toMatchObject({ failed: 2, unconsumable: 2 });
    expect(applied).toEqual([]);
    expect(failureCount("consume_failed") - before.consume).toBe(2);
    expect(failureCount("envelope_invalid") - before.invalid).toBe(1);
    expect(failureCount("no_consumer") - before.none).toBe(1);
    expect(evaluateAlarm(alarmRule("outbox-consume-failures"), failures())).toMatchObject({ state: "ALARM" });
    // Nothing was acknowledged: every message is redelivered once the visibility timeout passes.
    expect(await onQueue(queue)).toBe(4);
    const again = await sb.sqs.send(new ReceiveMessageCommand({ QueueUrl: queue, MaxNumberOfMessages: 10, WaitTimeSeconds: 3, VisibilityTimeout: 30 }));
    expect((again.Messages ?? []).length).toBeGreaterThanOrEqual(1);
  });

  it("[OPS-01][AUTH-02] failure injection: only unconsumable envelopes (malformed, or of a tenant this worker does not serve) fail the run as OUTBOX_UNCONSUMABLE (never reported as a success)", async () => {
    const queue = await createQueue(sb.sqs, "vsp-it-comp-consume-bad");
    const applied: string[] = [];
    const loop = loopFor(queue, recordingConsumers(applied));
    await send(queue, JSON.stringify({ schema: OUTBOX_ENVELOPE_SCHEMA, messageId: "not-a-message-id", tenantId: TENANT, topic: "support_request.sync", payload: {} }));
    // A well-formed envelope of a tenant this worker does not serve: never deduplicated or consumed under it.
    await send(queue, JSON.stringify({ schema: OUTBOX_ENVELOPE_SCHEMA, messageId: messageId(), tenantId: "tnt_synthOtherTenantXX0001", topic: "support_request.sync", payload: { probe: "synthetic" } }));
    expect(await loop.runOnce()).toMatchObject({ ok: false, processed: 0, reasonCode: "OUTBOX_UNCONSUMABLE", details: { failed: 0, unconsumable: 2 } });
    expect(applied).toEqual([]);
    expect(await onQueue(queue)).toBe(2);
  });

  it("[OPS-01][FO-21-10] failure injection: an outbox queue that does not exist refuses every publish; outbox.dispatch fails, is counted and alarmed, readiness turns 503 after three runs; once the queue exists the message is published", async () => {
    const name = uniqueName("vsp-it-comp-outbox-missing");
    const cfg = sb.config();
    (cfg.infrastructure as Record<string, unknown>).outbox = { queueUrl: awsQueueUrl(name), fifo: false, deadLetterQueueUrl: null };
    sb.writeConfig(cfg);
    const { c: w } = await bootLive(sb, { unit: "worker" });
    const { logger } = createMemoryLogger();
    const dispatch = liveWorkerLoopsFor(w, { instanceId: "worker-l2-dispatch" }).find((l) => l.name === "outbox.dispatch");
    if (!dispatch) throw new Error("outbox.dispatch not composed");
    const worker = new Worker({ loops: [dispatch], scheduler: new ManualLoopScheduler(w.clock), clock: w.clock, logger });
    const health = await buildWorkerHealthApp(worker, logger);
    const publishFailures = () => w.localMetrics.find("vsp_outbox_publish_failures_total").map((s) => ({ metric: s.name, labels: s.labels, value: s.value }));
    try {
      worker.start();
      const messageRef = `srq_synth${randomBytes(8).toString("hex")}`;
      const id = await w.db.tx((tx) => w.outbox.enqueue(tx, { topic: "support_request.sync", key: messageRef, payload: { supportRequestId: messageRef }, dedupeKey: newId("ddk") }), { role: "app_runtime", rls: { tenantId: TENANT } });
      const runs: { reasonCode: string | null; ready: number }[] = [];
      for (let i = 0; i < 3; i++) {
        const r = await worker.runLoop(dispatch.name);
        expect(r.ok, `run ${i + 1}`).toBe(false);
        runs.push({ reasonCode: r.reasonCode, ready: (await health.inject({ method: "GET", url: "/health/ready" })).statusCode });
      }
      expect(runs[0]?.reasonCode).toBe("OUTBOX_PUBLISH_FAILED");
      // A later run either retried and failed again, or found the message still waiting out its backoff.
      for (const r of runs.slice(1)) expect(["OUTBOX_PUBLISH_FAILED", "OUTBOX_PUBLISH_RETRYING"]).toContain(r.reasonCode);
      expect(runs.map((r) => r.ready)).toEqual([200, 200, 503]);
      expect(JSON.parse((await health.inject({ method: "GET", url: "/health/ready" })).body)).toMatchObject({ ready: false });
      expect(publishFailures().filter((s) => s.labels.reason === "publish_failed").reduce((n, s) => n + s.value, 0)).toBeGreaterThanOrEqual(1);
      expect(evaluateAlarm(alarmRule("outbox-publish-failures"), publishFailures())).toMatchObject({ state: "ALARM" });
      // Nothing was lost: the message is still PENDING in PostgreSQL with the publish error recorded.
      const row = await sb.idb.db.tx(async (tx) => (await tx.query<{ status: string; last_error_code: string | null }>("select status, last_error_code from outbox_messages where message_id = $1", [id])).rows[0], { role: "owner" });
      expect(row?.status).toBe("PENDING");
      expect(row?.last_error_code).toMatch(/^PUBLISH_/);

      // The queue is restored: once the backoff elapsed the message is published and readiness recovers.
      await sb.sqs.send(new CreateQueueCommand({ QueueName: name }));
      const deadline = Date.now() + 20_000;
      let last = await worker.runLoop(dispatch.name);
      while (!(last.ok && last.processed === 1) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 300));
        last = await worker.runLoop(dispatch.name);
      }
      expect(last).toMatchObject({ ok: true, processed: 1, reasonCode: null });
      expect((await health.inject({ method: "GET", url: "/health/ready" })).statusCode).toBe(200);
      const got = await sb.sqs.send(new ReceiveMessageCommand({ QueueUrl: awsQueueUrl(name), MaxNumberOfMessages: 10, WaitTimeSeconds: 2 }));
      expect((got.Messages ?? []).map((m) => (JSON.parse(m.Body ?? "{}") as { messageId?: string }).messageId)).toContain(id);
    } finally {
      await worker.stop();
      await health.close();
      await w.close();
      sb.writeConfig(sb.config());
    }
  });

  it("[OPS-01] readiness: three consecutive failing consume runs turn the worker's /health/ready to 503 with the loop's reason; a healthy run turns it back", async () => {
    const queue = await createQueue(sb.sqs, "vsp-it-comp-consume-ready");
    const handlers: BusinessModule["consumers"] = { "workflow.signal": async () => { throw new DependencyError("CONSUMER_SYNTHETIC_FAILURE", "FAILED", true); } };
    const loop = loopFor(queue, handlers, 1);
    const { logger } = createMemoryLogger();
    const worker = new Worker({ loops: [loop], scheduler: new ManualLoopScheduler(c.clock), clock: c.clock, logger });
    const health = await buildWorkerHealthApp(worker, logger);
    try {
      worker.start();
      const id = messageId();
      await send(queue, envelope("workflow.signal", id));
      const statuses: number[] = [];
      for (let i = 0; i < 3; i++) {
        // Wait out the visibility timeout so each run receives the redelivered message again.
        if (i > 0) await new Promise((r) => setTimeout(r, 1_200));
        const r = await worker.runLoop(loop.name);
        expect(r.ok).toBe(false);
        statuses.push((await health.inject({ method: "GET", url: "/health/ready" })).statusCode);
      }
      expect(statuses).toEqual([200, 200, 503]);
      const body = JSON.parse((await health.inject({ method: "GET", url: "/health/ready" })).body) as { ready: boolean; reasonCode: string };
      expect(body).toMatchObject({ ready: false, reasonCode: "OUTBOX_CONSUME_FAILED" });
      // The consumer is fixed: the next run consumes the redelivered message and readiness recovers.
      handlers["workflow.signal"] = async () => undefined;
      await new Promise((r) => setTimeout(r, 1_200));
      expect(await worker.runLoop(loop.name)).toMatchObject({ ok: true, processed: 1 });
      expect((await health.inject({ method: "GET", url: "/health/ready" })).statusCode).toBe(200);
      expect(await onQueue(queue)).toBe(0);
    } finally {
      await worker.stop();
      await health.close();
    }
  });
});
