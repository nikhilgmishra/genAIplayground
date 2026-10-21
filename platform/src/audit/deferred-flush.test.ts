/**
 * Gateway-side flush of the deferred route-audit queue (`DeferredAuditFlushTimer`, ADR-0011): the
 * gateway-only entry point runs no worker loops, so this bounded timer is what drains that process's
 * own queue, and its `stop` attempts one bounded final flush on graceful shutdown. Real timers with
 * short intervals, an injected writer that can be down, slow or hanging, a FakeClock, SYNTHETIC inputs.
 */
import { describe, expect, it } from "vitest";
import { createMemoryLogger } from "../observability/logger.js";
import { InMemoryMetrics } from "../observability/metrics.js";
import type { AuditEvent, AuditEventInput } from "../protocol/index.js";
import { FakeClock } from "../shared/clock.js";
import { AuditUnavailableError, ValidationError } from "../shared/errors.js";
import { DEFERRED_AUDIT_AFTER_SHUTDOWN, DEFERRED_AUDIT_MARKER_ACTION, DeferredAuditFlushTimer, DeferredAuditQueue } from "./deferred.js";
import type { DeferredFlushResult } from "./deferred.js";
import type { AuditWriter, DeferredAppendResult } from "./ports.js";
import { sampleAuditInput } from "./testing.js";

const clock = new FakeClock("2026-10-18T10:00:00.000Z");
const route = (action: string, correlationId: string): AuditEventInput =>
  sampleAuditInput(clock, { action, correlationId, sourceComponent: "gateway", outcome: "PENDING", assurance: "A0", actorRef: null, subjectRef: null, role: null, idempotencyKey: null, evidencePointers: [], turnId: null });

/** A writer that is down until `up()`; optionally slow, or hanging forever while `hang` is set. */
function writer(opts: { delayMs?: number } = {}) {
  const accepted: string[] = [];
  const state = { down: true, hang: false, inFlight: 0, maxInFlight: 0 };
  const w: AuditWriter = {
    append: async () => {
      throw new AuditUnavailableError("AUDIT_STORE_UNWRITABLE");
    },
    appendStandalone: async (input) => {
      state.inFlight += 1;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      try {
        if (state.hang) await new Promise(() => undefined);
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        if (state.down) throw new AuditUnavailableError("AUDIT_STORE_UNWRITABLE");
        accepted.push(`${input.action}:${input.correlationId}`);
        return { eventId: `aud_synthFlushTimer${String(accepted.length).padStart(8, "0")}` } as AuditEvent;
      } finally {
        state.inFlight -= 1;
      }
    },
  };
  return { w, accepted, state };
}

function compose(w: AuditWriter) {
  const { logger, records } = createMemoryLogger();
  const metrics = new InMemoryMetrics();
  const queue = new DeferredAuditQueue({ writer: w, clock, logger, metrics });
  return { queue, logger, records, metrics };
}

async function until(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("DeferredAuditFlushTimer (gateway-side flush of the deferred route-audit queue)", () => {
  it("[OPS-01][SAFE-03][SPEC-13.bounded-buffer] drains the queue on its own timer once the store is writable, in deferral order with a marker after each late event", async () => {
    const { w, accepted, state } = writer();
    const { queue, logger, metrics } = compose(w);
    await queue.appendOrDefer(route("handoff.requested", "hnd_synthGatewayFlush0001"));
    await queue.appendOrDefer(route("handoff.safety_requested", "hnd_synthGatewayFlush0002"));
    expect(queue.depth).toBe(2);
    const timer = new DeferredAuditFlushTimer(queue, { intervalMs: 100, logger });
    timer.start();
    try {
      // While the store is down the runs keep the events, in order.
      await new Promise((r) => setTimeout(r, 350));
      expect(queue.pending().map((p) => p.action)).toEqual(["handoff.requested", "handoff.safety_requested"]);
      state.down = false;
      await until(() => queue.depth === 0);
      expect(accepted).toEqual([
        "handoff.requested:hnd_synthGatewayFlush0001",
        `${DEFERRED_AUDIT_MARKER_ACTION}:hnd_synthGatewayFlush0001`,
        "handoff.safety_requested:hnd_synthGatewayFlush0002",
        `${DEFERRED_AUDIT_MARKER_ACTION}:hnd_synthGatewayFlush0002`,
      ]);
      expect(metrics.counterValue("vsp_audit_deferred_total", { result: "flushed", reason: "none" })).toBe(2);
      expect(metrics.gaugeValue("vsp_audit_deferred_depth")).toBe(0);
    } finally {
      await timer.stop();
    }
  });

  it("[OPS-01][SPEC-13.bounded-buffer] every flush reports the depth gauge, also for an empty queue (heartbeat for the sustained-depth alarm)", async () => {
    const { w } = writer();
    const { queue, metrics } = compose(w);
    expect(metrics.gaugeValue("vsp_audit_deferred_depth")).toBeUndefined();
    expect(await queue.flush()).toEqual({ written: 0, dropped: 0, remaining: 0, reasonCode: null });
    expect(metrics.gaugeValue("vsp_audit_deferred_depth")).toBe(0);
  });

  it("[OPS-01] runs never overlap or pile up while the store is slow, and a failing run never stops the timer", async () => {
    const slow = writer({ delayMs: 250 });
    const { queue } = compose(slow.w);
    await queue.appendOrDefer(route("handoff.requested", "hnd_synthGatewaySlow00001"));
    let runs = 0;
    let active = 0;
    let maxActive = 0;
    const counted = {
      get depth() {
        return queue.depth;
      },
      get inProgress() {
        return queue.inProgress;
      },
      seal: () => queue.seal(),
      flush: async (limit?: number): Promise<DeferredFlushResult> => {
        runs += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          return await queue.flush(limit);
        } finally {
          active -= 1;
        }
      },
    };
    const timer = new DeferredAuditFlushTimer(counted, { intervalMs: 100, finalFlushTimeoutMs: 0 });
    timer.start();
    await new Promise((r) => setTimeout(r, 900));
    await timer.stop();
    // 250 ms per run + 100 ms between runs: a fixed-rate timer would have started about 9 runs.
    expect(maxActive).toBe(1);
    expect(runs).toBeGreaterThanOrEqual(1);
    expect(runs).toBeLessThanOrEqual(3);
    expect(slow.state.maxInFlight).toBe(1);

    let calls = 0;
    const failing = {
      depth: 1,
      inProgress: 0,
      seal: () => undefined,
      flush: async (): Promise<DeferredFlushResult> => {
        calls += 1;
        throw new AuditUnavailableError("AUDIT_STORE_UNWRITABLE");
      },
    };
    const { logger, records } = createMemoryLogger();
    const t2 = new DeferredAuditFlushTimer(failing, { intervalMs: 100, finalFlushTimeoutMs: 0, logger });
    expect(await t2.runOnce()).toEqual({ written: 0, dropped: 0, remaining: 1, reasonCode: "AUDIT_STORE_UNWRITABLE" });
    t2.start();
    await until(() => calls >= 4);
    await t2.stop();
    expect(records.filter((r) => r.event === "audit.deferred.flush_failed").length).toBeGreaterThanOrEqual(3);
  });

  it("[OPS-01][SAFE-03] stop cancels the timer and attempts a final flush that drains the whole queue in bounded batches", async () => {
    const { w, accepted, state } = writer();
    const { queue, logger, records } = compose(w);
    for (let i = 0; i < 250; i++) await queue.appendOrDefer(route("handoff.requested", `hnd_synthGatewayFinal${String(i).padStart(4, "0")}`));
    state.down = false;
    // The interval is long: only the final flush can append these.
    const timer = new DeferredAuditFlushTimer(queue, { intervalMs: 300_000, limit: 100, logger });
    timer.start();
    expect(await timer.stop()).toEqual({ written: 250, dropped: 0, remaining: 0, inProgress: 0, reasonCode: null });
    expect(accepted.filter((a) => a.startsWith("handoff.requested:")).map((a) => a.slice(-4))).toEqual(Array.from({ length: 250 }, (_, i) => String(i).padStart(4, "0")));
    expect(records).toContainEqual(expect.objectContaining({ level: "warn", event: "audit.deferred.final_flush", fields: expect.objectContaining({ written: 250 }) }));
    expect(records.some((r) => r.event === "audit.deferred.unflushed_at_shutdown")).toBe(false);
    // Idempotent.
    expect(await timer.stop()).toEqual({ written: 250, dropped: 0, remaining: 0, inProgress: 0, reasonCode: null });

    // A stopped timer never restarts (a fresh queue: `stop` sealed this one).
    const again = compose(w);
    state.down = true;
    await again.queue.appendOrDefer(route("handoff.requested", "hnd_synthGatewayAfterStop"));
    const fast = new DeferredAuditFlushTimer(again.queue, { intervalMs: 100, finalFlushTimeoutMs: 0 });
    expect(await fast.stop()).toMatchObject({ remaining: 1, reasonCode: "DEFERRED_AUDIT_FINAL_FLUSH_DISABLED" });
    fast.start();
    state.down = false;
    await new Promise((r) => setTimeout(r, 350));
    expect(again.queue.depth).toBe(1);
  });

  it("[OPS-01][SAFE-03] a final flush that cannot finish is bounded in time and reports the events lost with the process at error level", async () => {
    const down = writer();
    const a = compose(down.w);
    await a.queue.appendOrDefer(route("handoff.requested", "hnd_synthGatewayLost00001"));
    await a.queue.appendOrDefer(route("handoff.requested", "hnd_synthGatewayLost00002"));
    expect(await new DeferredAuditFlushTimer(a.queue, { logger: a.logger }).stop()).toEqual({ written: 0, dropped: 0, remaining: 2, inProgress: 0, reasonCode: "AUDIT_STORE_UNWRITABLE" });
    expect(a.records).toContainEqual(
      expect.objectContaining({ level: "error", event: "audit.deferred.unflushed_at_shutdown", fields: expect.objectContaining({ remaining: 2, reasonCode: "AUDIT_STORE_UNWRITABLE" }) }),
    );

    const hanging = writer();
    const b = compose(hanging.w);
    await b.queue.appendOrDefer(route("handoff.requested", "hnd_synthGatewayHang00001"));
    hanging.state.down = false;
    hanging.state.hang = true;
    const t0 = Date.now();
    expect(await new DeferredAuditFlushTimer(b.queue, { finalFlushTimeoutMs: 200, logger: b.logger }).stop()).toEqual({
      written: 0,
      dropped: 0,
      remaining: 1,
      inProgress: 0,
      reasonCode: "DEFERRED_AUDIT_FINAL_FLUSH_TIMEOUT",
    });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(b.records).toContainEqual(expect.objectContaining({ level: "error", event: "audit.deferred.unflushed_at_shutdown", fields: expect.objectContaining({ remaining: 1 }) }));

    // A timer run that hangs in the store when shutdown begins counts toward the same bound.
    const stuck = writer();
    const c = compose(stuck.w);
    await c.queue.appendOrDefer(route("handoff.requested", "hnd_synthGatewayStuck0001"));
    stuck.state.down = false;
    stuck.state.hang = true;
    const timer = new DeferredAuditFlushTimer(c.queue, { intervalMs: 100, finalFlushTimeoutMs: 200, logger: c.logger });
    timer.start();
    await until(() => stuck.state.inFlight === 1);
    const t1 = Date.now();
    expect(await timer.stop()).toMatchObject({ remaining: 1, reasonCode: "DEFERRED_AUDIT_FINAL_FLUSH_TIMEOUT" });
    expect(Date.now() - t1).toBeLessThan(2_000);
    // Content-free: action codes, opaque ids, reason codes and counts only.
    expect(JSON.stringify([...a.records, ...b.records, ...c.records])).not.toMatch(/fullName|dateOfBirth/);
  });

  it("[OPS-01][SAFE-03] the final-flush bound keeps the process alive until the loss is logged, even when the stuck flush holds no event-loop handle", async () => {
    // A lost promise holds no handle: an unref'd deadline would let the process exit before the bound,
    // silently. Measured synchronously around stop(), so no other timer can interfere.
    const { logger, records } = createMemoryLogger();
    const lost = { depth: 1, inProgress: 0, seal: () => undefined, flush: () => new Promise<DeferredFlushResult>(() => undefined) };
    const refTimers = () => process.getActiveResourcesInfo().filter((x) => x === "Timeout").length;
    const before = refTimers();
    const stopping = new DeferredAuditFlushTimer(lost, { finalFlushTimeoutMs: 200, logger }).stop();
    expect(refTimers()).toBe(before + 1);
    expect(await stopping).toMatchObject({ remaining: 1, reasonCode: "DEFERRED_AUDIT_FINAL_FLUSH_TIMEOUT" });
    expect(records).toContainEqual(expect.objectContaining({ level: "error", event: "audit.deferred.unflushed_at_shutdown", fields: expect.objectContaining({ remaining: 1 }) }));
  });

  it("[OPS-01][SAFE-03] stop seals the queue: an event a force-closed request defers after the final flush is reported lost at error level and counted, never queued silently", async () => {
    const { w, accepted, state } = writer();
    const { queue, logger, records, metrics } = compose(w);
    await queue.appendOrDefer(route("handoff.requested", "hnd_synthGatewaySeal00001"));
    const timer = new DeferredAuditFlushTimer(queue, { intervalMs: 300_000, finalFlushTimeoutMs: 1_000, logger });
    timer.start();
    expect(queue.isSealed).toBe(false);
    expect(await timer.stop()).toEqual({ written: 0, dropped: 0, remaining: 1, inProgress: 0, reasonCode: "AUDIT_STORE_UNWRITABLE" });
    expect(queue.isSealed).toBe(true);

    // A handler the shutdown could not wait for reaches the queue now: nothing would flush it.
    expect(await queue.appendOrDefer(route("handoff.safety_requested", "hnd_synthGatewaySeal00002"))).toEqual({ written: false, deferred: false, eventId: null, reasonCode: DEFERRED_AUDIT_AFTER_SHUTDOWN });
    expect(queue.pending().map((p) => p.action)).toEqual(["handoff.requested"]);
    expect(records).toContainEqual(
      expect.objectContaining({
        level: "error",
        event: "audit.deferred.lost_at_shutdown",
        fields: expect.objectContaining({ action: "handoff.safety_requested", correlationId: "hnd_synthGatewaySeal00002", reasonCode: DEFERRED_AUDIT_AFTER_SHUTDOWN, storeReasonCode: "AUDIT_STORE_UNWRITABLE", lost: 1 }),
      }),
    );
    expect(metrics.counterValue("vsp_audit_deferred_total", { result: "dropped", reason: "store_unavailable" })).toBe(1);
    expect(metrics.counterValue("vsp_audit_deferred_total", { result: "queued", reason: "store_unavailable" })).toBe(1);

    // Still writable while the store is: the older event first (order), then the new one directly.
    state.down = false;
    const now = await queue.appendOrDefer(route("handoff.requested", "hnd_synthGatewaySeal00003"));
    expect(now).toMatchObject({ written: true, deferred: false, reasonCode: null });
    expect(accepted).toEqual(["handoff.requested:hnd_synthGatewaySeal00001", `${DEFERRED_AUDIT_MARKER_ACTION}:hnd_synthGatewaySeal00001`, "handoff.requested:hnd_synthGatewaySeal00003"]);
    expect(records.filter((r) => r.event === "audit.deferred.lost_at_shutdown")).toHaveLength(1);

    // With the final flush disabled the queue is sealed as well.
    const b = compose(writer().w);
    await new DeferredAuditFlushTimer(b.queue, { finalFlushTimeoutMs: 0 }).stop();
    expect(await b.queue.appendOrDefer(route("handoff.requested", "hnd_synthGatewaySeal00004"))).toMatchObject({ deferred: false, reasonCode: DEFERRED_AUDIT_AFTER_SHUTDOWN });
    expect(b.queue.depth).toBe(0);

    // A seal that fails never blocks the shutdown report, and says so.
    const c = createMemoryLogger();
    const broken = {
      depth: 1,
      inProgress: 0,
      seal: () => {
        throw new Error("seal unavailable");
      },
      flush: async (): Promise<DeferredFlushResult> => ({ written: 0, dropped: 0, remaining: 1, reasonCode: "AUDIT_STORE_UNWRITABLE" }),
    };
    expect(await new DeferredAuditFlushTimer(broken, { logger: c.logger }).stop()).toMatchObject({ remaining: 1, reasonCode: "AUDIT_STORE_UNWRITABLE" });
    expect(c.records).toContainEqual(expect.objectContaining({ level: "error", event: "audit.deferred.seal_failed", fields: expect.objectContaining({ reasonCode: "DEFERRED_AUDIT_SEAL_FAILED" }) }));
    expect(c.records).toContainEqual(expect.objectContaining({ level: "error", event: "audit.deferred.unflushed_at_shutdown", fields: expect.objectContaining({ remaining: 1 }) }));
  });

  it("[OPS-01][SAFE-03] the final flush waits (bounded) for an append still in progress, and reports one still running at the seal at error level", async () => {
    // Store up but slow: stop returns only once the append in progress was written.
    const slowUp = writer({ delayMs: 300 });
    slowUp.state.down = false;
    const a = compose(slowUp.w);
    const appended: DeferredAppendResult[] = [];
    const pendingA = a.queue.appendOrDefer(route("handoff.requested", "hnd_synthGatewayInProg001")).then((r) => appended.push(r));
    expect(a.queue.inProgress).toBe(1);
    expect(await new DeferredAuditFlushTimer(a.queue, { finalFlushTimeoutMs: 2_000, logger: a.logger }).stop()).toEqual({ written: 0, dropped: 0, remaining: 0, inProgress: 0, reasonCode: null });
    expect(appended).toEqual([expect.objectContaining({ written: true, deferred: false })]);
    await pendingA;
    expect(a.records.filter((r) => r.level === "error")).toEqual([]);

    // Store down and slow: the append in progress fails and is queued; the final flush then counts it.
    const slowDown = writer({ delayMs: 300 });
    const b = compose(slowDown.w);
    const pendingB = b.queue.appendOrDefer(route("handoff.safety_requested", "hnd_synthGatewayInProg002"));
    expect(await new DeferredAuditFlushTimer(b.queue, { finalFlushTimeoutMs: 2_000, logger: b.logger }).stop()).toEqual({
      written: 0,
      dropped: 0,
      remaining: 1,
      inProgress: 0,
      reasonCode: "AUDIT_STORE_UNWRITABLE",
    });
    expect(await pendingB).toMatchObject({ deferred: true, reasonCode: "AUDIT_STORE_UNWRITABLE" });
    expect(b.records).toContainEqual(expect.objectContaining({ level: "error", event: "audit.deferred.unflushed_at_shutdown", fields: expect.objectContaining({ remaining: 1, inProgress: 0 }) }));

    // An append hung in the store when shutdown begins: neither queued nor written, so it is counted as in progress.
    const hung = writer();
    hung.state.down = false;
    hung.state.hang = true;
    const c = compose(hung.w);
    void c.queue.appendOrDefer(route("handoff.requested", "hnd_synthGatewayInProg003"));
    const t0 = Date.now();
    expect(await new DeferredAuditFlushTimer(c.queue, { finalFlushTimeoutMs: 200, logger: c.logger }).stop()).toEqual({
      written: 0,
      dropped: 0,
      remaining: 0,
      inProgress: 1,
      reasonCode: "DEFERRED_AUDIT_FINAL_FLUSH_TIMEOUT",
    });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(c.records).toContainEqual(
      expect.objectContaining({ level: "error", event: "audit.deferred.unflushed_at_shutdown", fields: expect.objectContaining({ remaining: 0, inProgress: 1, reasonCode: "DEFERRED_AUDIT_FINAL_FLUSH_TIMEOUT" }) }),
    );
  });

  it("[OPS-01] the run timer never keeps the process alive (unref'd)", async () => {
    const { queue } = compose(writer().w);
    const refTimers = () => process.getActiveResourcesInfo().filter((x) => x === "Timeout").length;
    const timer = new DeferredAuditFlushTimer(queue, { intervalMs: 100, finalFlushTimeoutMs: 0 });
    const before = refTimers();
    timer.start();
    expect(refTimers()).toBe(before);
    await timer.stop();
  });

  it("[OPS-01] the flush policy is bounded", () => {
    const { queue } = compose(writer().w);
    for (const bad of [{ intervalMs: 50 }, { intervalMs: 300_001 }, { limit: 0 }, { limit: 1_001 }, { finalFlushTimeoutMs: -1 }, { finalFlushTimeoutMs: 60_001 }, { intervalMs: 1.5 }]) {
      expect(() => new DeferredAuditFlushTimer(queue, bad), JSON.stringify(bad)).toThrow(ValidationError);
    }
    expect(() => new DeferredAuditFlushTimer(queue, { intervalMs: 100, limit: 1, finalFlushTimeoutMs: 0 })).not.toThrow();
  });
});
