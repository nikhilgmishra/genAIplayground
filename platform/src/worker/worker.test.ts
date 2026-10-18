/**
 * Worker loop tests over the LOCAL FIXTURE composition (PGlite, OPA WASM,
 * SYNTHETIC data) with a FakeClock and the manual scheduler. No sockets.
 */
import { afterEach, describe, expect, it } from "vitest";
import { buildBusiness } from "../business/index.js";
import { CALLS } from "../fixtures/synthetic-world.js";
import { LOCAL_FIXTURE_TOKENS } from "../gateway/auth.js";
import { buildContainer } from "../main/container.js";
import type { Container } from "../main/container.js";
import { STUB_TOOL_NAMES, createStubBusiness } from "../main/fixtures/stub-business.fixture.js";
import { createMemoryLogger } from "../observability/logger.js";
import type { BusinessModule } from "../business/contract.js";
import { FakeClock } from "../shared/clock.js";
import { ConflictError } from "../shared/errors.js";
import { newId } from "../shared/ids.js";
import { InMemoryMetrics } from "../observability/metrics.js";
import type { RetentionRunReport } from "../retention/ports.js";
import { ActionReconcileLoop, MeteredLoop, OutboxConsumeLoop, OutboxDispatchLoop, LocalConsumerQueueFixture, RetentionLoop } from "./loops.js";
import type { LoopReport, WorkerLoop } from "./loops.js";
import { ManualLoopScheduler } from "./scheduler.js";
import { Worker, buildWorkerHealthApp, workerLoopsFor } from "./worker.js";

const START = "2026-10-18T09:00:00.000Z";
let c: Container | null = null;
let w: Worker | null = null;
afterEach(async () => {
  await w?.stop();
  w = null;
  await c?.close();
  c = null;
});

const tel = { authorization: `Bearer ${LOCAL_FIXTURE_TOKENS.telephony_control}` };

async function stubContainer(consumers: BusinessModule["consumers"] = {}) {
  const { logger, records } = createMemoryLogger();
  const clock = new FakeClock(START);
  const container = await buildContainer({
    environment: "local",
    buildBusiness: createStubBusiness(consumers).build,
    clock,
    env: {},
    allowUncommittedCatalog: true,
    metricToolNames: STUB_TOOL_NAMES,
    logger,
    rateLimit: null,
    ingestKnowledge: false,
  });
  return { container, clock, records };
}

async function enqueue(container: Container, topic: "support_request.sync" | "notification.send", ref: string): Promise<string> {
  return container.db.tx((tx) => container.outbox.enqueue(tx, { topic, key: ref, payload: { supportRequestId: ref }, dedupeKey: `test:${ref}` }), {
    role: "app_runtime",
    rls: { tenantId: container.config.tenantId },
  });
}

describe("worker scheduler", () => {
  it("[SPEC-15.worker] the manual scheduler runs a loop only when its interval elapsed on the FakeClock; loops never overlap", async () => {
    const clock = new FakeClock(START);
    const s = new ManualLoopScheduler(clock);
    const runs: string[] = [];
    s.schedule("a", 1_000, async () => void runs.push("a"));
    s.schedule("b", 5_000, async () => void runs.push("b"));
    expect(await s.runDue()).toEqual([]);
    clock.advanceMs(1_000);
    expect(await s.runDue()).toEqual(["a"]);
    clock.advanceMs(4_000);
    expect(await s.runDue()).toEqual(["a", "b"]);
    expect(() => s.schedule("a", 1_000, async () => undefined)).toThrow("LOOP_DUPLICATE");
    expect(() => s.schedule("c", 1, async () => undefined)).toThrow("LOOP_INTERVAL_INVALID");
    await s.stop();
    clock.advanceMs(10_000);
    expect(await s.runDue()).toEqual([]);
    expect(runs).toEqual(["a", "a", "b"]);
  });
});

describe("worker loop metrics (content-free, closed labels)", () => {
  const loopOf = (name: string, reports: LoopReport[], onRun?: () => void): WorkerLoop => ({
    name,
    intervalMs: 1_000,
    async runOnce() {
      onRun?.();
      const r = reports.shift();
      if (!r) throw new Error("no more scripted reports");
      return r;
    },
  });

  it("[SPEC-13.metrics][SPEC-15.worker] MeteredLoop counts runs, errors and processed items and observes lag and duration per loop", async () => {
    const clock = new FakeClock(START);
    const metrics = new InMemoryMetrics();
    const inner = loopOf(
      "outbox.dispatch",
      [
        { ok: true, processed: 3, reasonCode: null, details: {} },
        { ok: false, processed: 0, reasonCode: "PUBLISH_FAILED", details: {} },
      ],
      () => clock.advanceMs(40),
    );
    const metered = new MeteredLoop(inner, metrics, clock);
    expect(metered.name).toBe("outbox.dispatch");
    await metered.runOnce();
    clock.advanceMs(1_000 + 250 - 40);
    await metered.runOnce();
    expect(metrics.counterValue("vsp_worker_loop_runs_total", { loop: "outbox.dispatch", result: "ok" })).toBe(1);
    expect(metrics.counterValue("vsp_worker_loop_runs_total", { loop: "outbox.dispatch", result: "failed" })).toBe(1);
    expect(metrics.counterValue("vsp_worker_loop_errors_total", { loop: "outbox.dispatch" })).toBe(1);
    expect(metrics.counterValue("vsp_worker_loop_processed_total", { loop: "outbox.dispatch" })).toBe(3);
    expect(metrics.observations("vsp_worker_loop_duration_ms", { loop: "outbox.dispatch" })).toEqual([40, 40]);
    expect(metrics.observations("vsp_worker_loop_lag_ms", { loop: "outbox.dispatch" })).toEqual([250]);
  });

  it("[SPEC-15.worker] a throwing loop is reported as failed, and a failing metrics sink never breaks the loop", async () => {
    const clock = new FakeClock(START);
    const broken = { increment: () => { throw new Error("sink down"); }, observe: () => { throw new Error("sink down"); }, gauge: () => { throw new Error("sink down"); } };
    const r = await new MeteredLoop(loopOf("audit.ship", []), broken, clock).runOnce();
    expect(r).toMatchObject({ ok: false, reasonCode: "UNCLASSIFIED_ERROR" });
    const ok = await new MeteredLoop(loopOf("audit.ship", [{ ok: true, processed: 1, reasonCode: null, details: {} }]), broken, clock).runOnce();
    expect(ok.ok).toBe(true);
  });

  it("[DATA-03][OPS-03][SPEC-13.metrics] the retention loop reports blocked classes, unverified copies, deletions and pending vendor requests as metrics", async () => {
    const clock = new FakeClock(START);
    const metrics = new InMemoryMetrics();
    const report = (tenantId: string): RetentionRunReport => ({
      runId: newId("ret"),
      tenantId,
      startedAt: START,
      completedAt: START,
      status: "COMPLETED_WITH_UNVERIFIED_COPIES",
      classes: [
        { dataClass: "BUSINESS_RECORD", status: "EXECUTED", retentionDays: 30, policyVersion: 1, approvalId: "apr_testOnlyApproval01", legalPurpose: "TEST_ONLY", cutoff: START },
        { dataClass: "TRANSIENT_CONVERSATION", status: "BLOCKED_RETENTION_UNSET", retentionDays: null, policyVersion: null, approvalId: null, legalPurpose: null, cutoff: null },
        { dataClass: "RESTRICTED_QA_MEDIA", status: "BLOCKED_RETENTION_UNSET", retentionDays: null, policyVersion: null, approvalId: null, legalPurpose: null, cutoff: null },
        { dataClass: "SECURITY_AUDIT", status: "BLOCKED_RETENTION_CONFIG_MISMATCH", retentionDays: 10, policyVersion: 2, approvalId: "apr_testOnlyApproval02", legalPurpose: "TEST_ONLY", cutoff: null },
      ],
      datasets: [{ dataset: "support_memory", dataClass: "BUSINESS_RECORD", status: "DELETED", deletedCount: 4, heldCount: 0, deletionIds: [], keyDigest: null, verifications: [], vendorRequests: [], reasonCode: null }],
      unverifiedCopies: [{ dataset: "support_memory", verifier: "aurora_backups", location: "BACKUP", status: "UNVERIFIABLE", leftoverCount: 0, reasonCode: "BACKUP_RETENTION_INFRASTRUCTURE_MANAGED" }],
    });
    const job = {
      run: async () => [report("tnt_synthTenant00000001"), report("tnt_synthTenant00000002")],
      pendingVendorDeletions: async () => ({ salesforce: 2, talkdesk: 1 }),
    };
    const r = await new RetentionLoop(job, clock, createMemoryLogger().logger, 86_400_000, metrics).runOnce();
    expect(r).toMatchObject({ ok: true, processed: 8 });
    expect(metrics.counterValue("vsp_retention_deleted_total", { data_class: "BUSINESS_RECORD" })).toBe(8);
    expect(metrics.gaugeValue("vsp_retention_classes_blocked", { data_class: "TRANSIENT_CONVERSATION", reason: "BLOCKED_RETENTION_UNSET" })).toBe(2);
    expect(metrics.gaugeValue("vsp_retention_classes_blocked", { data_class: "SECURITY_AUDIT", reason: "BLOCKED_RETENTION_CONFIG_MISMATCH" })).toBe(2);
    expect(metrics.gaugeValue("vsp_retention_classes_blocked", { data_class: "BUSINESS_RECORD", reason: "BLOCKED_RETENTION_UNSET" })).toBe(0);
    expect(metrics.gaugeValue("vsp_retention_unverified_copies", { location: "BACKUP", status: "UNVERIFIABLE" })).toBe(2);
    expect(metrics.gaugeValue("vsp_vendor_deletion_requests_pending", { vendor: "salesforce" })).toBe(2);
    expect(metrics.gaugeValue("vsp_vendor_deletion_requests_pending", { vendor: "talkdesk" })).toBe(1);
    expect(JSON.stringify(metrics.allSeries())).not.toContain("support_memory");
  });
});

describe("worker loops over the local composition", () => {
  it("[ACT-02][SPEC-8.outbox] dispatch -> consume runs the business consumer once per message (ConsumerDedup); redeliveries are skipped; failures retry with backoff then dead-letter", async () => {
    const calls: string[] = [];
    let failNext = 0;
    const { container, clock, records } = await stubContainer({
      "support_request.sync": async (messageId) => {
        if (failNext > 0) {
          failNext -= 1;
          throw new ConflictError("FIXTURE_CONSUMER_BUSY");
        }
        calls.push(messageId);
      },
    });
    c = container;
    const queue = new LocalConsumerQueueFixture(c.publisher, clock);
    const dispatch = new OutboxDispatchLoop(c.dispatcher);
    const consume = new OutboxConsumeLoop({ db: c.db, clock, logger: c.logger, queue, consumers: c.business.consumers, maxAttempts: 3, baseDelayMs: 1_000 });

    const m1 = await enqueue(c, "support_request.sync", newId("spr"));
    expect((await dispatch.runOnce()).processed).toBe(1);
    expect(queue.depth).toBe(1);
    expect((await consume.runOnce()).processed).toBe(1);
    expect(calls).toEqual([m1]);

    // SQS-style redelivery of the same message: the dedup row stops a second run.
    await c.publisher.redeliverAll();
    expect(queue.depth).toBe(1);
    const dup = await consume.runOnce();
    expect(dup.details.duplicates).toBe(1);
    expect(calls).toEqual([m1]);

    // Transient failure: retried after the backoff elapses on the FakeClock.
    failNext = 1;
    const m2 = await enqueue(c, "support_request.sync", newId("spr"));
    await dispatch.runOnce();
    expect((await consume.runOnce()).details.retried).toBe(1);
    expect((await consume.runOnce()).processed).toBe(0); // not yet due
    clock.advanceMs(1_000);
    expect((await consume.runOnce()).processed).toBe(1);
    expect(calls).toEqual([m1, m2]);

    // Persistent failure: dead-lettered with a reason code after maxAttempts.
    failNext = 10;
    const m3 = await enqueue(c, "support_request.sync", newId("spr"));
    await dispatch.runOnce();
    for (let i = 0; i < 3; i++) {
      await consume.runOnce();
      clock.advanceMs(10_000);
    }
    expect(queue.dead).toEqual([{ messageId: m3, topic: "support_request.sync", reasonCode: "FIXTURE_CONSUMER_BUSY", attempts: 2 }]);

    // A topic without a consumer is dead-lettered (fail closed), never silently dropped.
    const m4 = await enqueue(c, "notification.send", newId("ntf"));
    await dispatch.runOnce();
    await consume.runOnce();
    expect(queue.dead.at(-1)).toMatchObject({ messageId: m4, reasonCode: "OUTBOX_NO_CONSUMER" });
    // Content-free logs: ids and reason codes only.
    expect(JSON.stringify(records)).not.toContain("supportRequestId");
    queue.close();
  }, 60_000);

  it("[ACT-03] the reconciler skips kinds without a provider and reports an inconclusive lookup, content-free", async () => {
    const { logger, records } = createMemoryLogger();
    const action = { actionId: newId("act"), kind: "appointment.reschedule" } as never;
    const fakeActions = {
      listNeedingReconciliation: async () => [action, { ...(action as object), actionId: newId("act"), kind: "billing.review.submit" } as never],
      reconcile: async () => {
        throw new ConflictError("COMMIT_IN_PROGRESS");
      },
    };
    const provider = { lookup: async () => ({ outcome: "UNKNOWN" }) } as never;
    const loop = new ActionReconcileLoop(fakeActions, { "appointment.reschedule": provider }, ["tnt_synthTenantPrimary01"], logger);
    const r = await loop.runOnce();
    expect(r).toMatchObject({ ok: true, processed: 0, details: { inconclusive: 1, noProvider: 1 } });
    expect(records.map((x) => x.fields?.reasonCode)).toEqual(expect.arrayContaining(["COMMIT_IN_PROGRESS", "RECONCILE_PROVIDER_MISSING"]));
    expect(JSON.stringify(records)).not.toContain("lookup");
  });

  it("[DATA-03][OPS-03] every loop runs bounded and green on the local composition; retention reports BLOCKED classes and deletes nothing; audit is shipped to the LOCAL FIXTURE sink", async () => {
    const { container, clock } = await stubContainer();
    c = container;
    const scheduler = new ManualLoopScheduler(clock);
    const { loops, closers } = workerLoopsFor(c);
    w = new Worker({ loops, scheduler, clock, logger: c.logger, closers });
    expect(w.readiness()).toMatchObject({ ready: false, reasonCode: "WORKER_NOT_STARTED" });
    w.start();
    const reports = await w.runAllOnce();
    for (const [name, r] of Object.entries(reports)) expect({ name, ok: r.ok }).toEqual({ name, ok: true });
    expect(reports["retention.run"]).toMatchObject({ processed: 0, reasonCode: "BLOCKED_RETENTION_UNSET" });
    expect(Number(reports["retention.run"]?.details.blockedClasses)).toBeGreaterThan(0);
    expect(reports["audit.ship"]?.processed).toBeGreaterThan(0); // the budget definition and container audit events
    expect((await c.auditSink.listManifests("runtime")).length).toBeGreaterThan(0);
    expect(w.readiness().ready).toBe(true);
    expect(w.loopNames).toEqual([
      "actions.expire",
      "actions.reconcile",
      "audit.ship",
      "outbox.consume",
      "outbox.dispatch",
      "retention.run",
      "telephony.local_fixture_delivery",
      "tools.idempotency_purge",
      "transfers.sweep",
      "workflows.tick",
    ]);
    // Re-running is idempotent: nothing new to ship, nothing deleted.
    const again = await w.runAllOnce();
    expect(again["audit.ship"]?.processed).toBe(0);
    expect(again["retention.run"]?.processed).toBe(0);
    // Every loop reported its runs through the Metrics port (closed loop-name labels, never "other").
    for (const name of w.loopNames) expect(c.metrics.counterValue("vsp_worker_loop_runs_total", { loop: name, result: "ok" }), name).toBe(2);
    expect(c.metrics.counterValue("vsp_worker_loop_runs_total", { loop: "other" })).toBe(0);
    expect(c.metrics.gaugeValue("vsp_retention_classes_blocked", { data_class: "BUSINESS_RECORD", reason: "BLOCKED_RETENTION_UNSET" })).toBe(1);
    expect(c.metrics.counterValue("vsp_retention_deleted_total")).toBe(0);
  }, 60_000);

  it("[SPEC-15.worker] readiness over HTTP: 503 until loops ran, 200 when green, 503 when a loop stalls (FakeClock)", async () => {
    const { container, clock } = await stubContainer();
    c = container;
    const scheduler = new ManualLoopScheduler(clock);
    const { loops, closers } = workerLoopsFor(c);
    w = new Worker({ loops, scheduler, clock, logger: c.logger, closers });
    const app = await buildWorkerHealthApp(w, c.logger);
    try {
      expect((await app.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(200);
      w.start();
      const notYet = await app.inject({ method: "GET", url: "/health/ready" });
      expect(notYet.statusCode).toBe(503);
      expect(notYet.json()).toMatchObject({ ready: false, reasonCode: "LOOP_NOT_YET_RUN" });
      await w.runAllOnce();
      expect((await app.inject({ method: "GET", url: "/health/ready" })).statusCode).toBe(200);
      // Scheduled runs keep it green while the clock advances.
      clock.advanceMs(1_000);
      await scheduler.runDue();
      expect((await app.inject({ method: "GET", url: "/health/ready" })).statusCode).toBe(200);
      // Nothing runs for 10 minutes: fast loops are stalled.
      clock.advanceMs(600_000);
      const stalled = await app.inject({ method: "GET", url: "/health/ready" });
      expect(stalled.statusCode).toBe(503);
      expect(stalled.json()).toMatchObject({ ready: false, reasonCode: "LOOP_STALLED" });
      // Any credential is refused on the worker surface; no tenant data in health bodies.
      expect(stalled.body).not.toContain(c.config.tenantId);
    } finally {
      await app.close();
    }
  }, 60_000);

  it("[SAFE-04][TB-07] LOCAL FIXTURE telephony events (duplicated, reordered) drive the transfer journey; the sweep times out a stalled attempt and moves to the next route", async () => {
    const { logger } = createMemoryLogger();
    const clock = new FakeClock(START);
    c = await buildContainer({ environment: "local", buildBusiness, clock, env: {}, logger, rateLimit: null, ingestKnowledge: false });
    const scheduler = new ManualLoopScheduler(clock);
    const { loops, closers } = workerLoopsFor(c);
    w = new Worker({ loops, scheduler, clock, logger, closers });
    w.start();

    c.fixtures.telephony.scriptNextTransfer({ outcome: "CONNECTED" }, { duplicate: true, outOfOrder: true });
    const human = await c.app.inject({ method: "POST", url: "/telephony/v1/session/human-request", headers: tel, payload: { callId: CALLS.primary.callId, reason: "CALLER_REQUESTED_HUMAN", language: "en", issueCategory: null } });
    expect(human.json()).toMatchObject({ accepted: true });
    const handoffId = (human.json() as { handoffId: string }).handoffId;
    const delivery = await w.runLoop("telephony.local_fixture_delivery");
    expect(delivery.ok).toBe(true);
    expect(delivery.processed).toBeGreaterThan(4);
    const connected = await c.transferStore.get(handoffId);
    expect(connected?.connectedAt).not.toBeNull();

    c.fixtures.telephony.scriptNextTransfer({ outcome: "STALLED", after: "QUEUED" });
    const second = await c.app.inject({ method: "POST", url: "/telephony/v1/session/human-request", headers: tel, payload: { callId: CALLS.concurrent.callId, reason: "CALLER_REQUESTED_HUMAN", language: "en", issueCategory: null } });
    const stalledId = (second.json() as { handoffId: string }).handoffId;
    await w.runLoop("telephony.local_fixture_delivery");
    const before = await c.transferStore.get(stalledId);
    expect(before?.attemptCount).toBe(1);
    clock.advanceMs(61_000);
    const sweep = await w.runLoop("transfers.sweep");
    expect(sweep.processed).toBeGreaterThan(0);
    const after = await c.transferStore.get(stalledId);
    expect(after?.attemptCount).toBeGreaterThan(1);
  }, 120_000);
});
