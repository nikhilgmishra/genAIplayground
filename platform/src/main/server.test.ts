/**
 * Gateway-only entry point (`server.ts`) and its own deferred route-audit queue (ADR-0011). This
 * process runs no worker loops, so nothing but its own bounded timer, and the final flush of a
 * graceful shutdown, can append the handoff audit events it deferred during an audit outage.
 * Graceful shutdown waits (bounded) for requests already being handled, then, after the app
 * force-closed the rest, (bounded) for their handlers to settle, so their route evidence reaches the
 * queue before the final flush and before the entry exits; a handler it gave up on is logged at error
 * level, and one that reaches the sealed queue later is reported lost there.
 * Every assertion about shutdown logs is made at the moment `close()` resolves: the entry point calls
 * process.exit(0) then, so nothing logged after that moment would exist in a real process.
 * LOCAL FIXTURE composition in `ci` (loopback, ephemeral port), real HTTP over the listener, the
 * LOCAL FIXTURE outage `revoke insert on audit_outbox from app_runtime`, SYNTHETIC data.
 */
import { afterEach, describe, expect, it } from "vitest";
import { DEFERRED_AUDIT_AFTER_SHUTDOWN, DEFERRED_AUDIT_MARKER_ACTION } from "../audit/deferred.js";
import type { DeferredAppendResult } from "../audit/ports.js";
import { buildBusiness } from "../business/index.js";
import type { BuildBusiness } from "../business/contract.js";
import { LOCAL_FIXTURE_TOKENS } from "../gateway/auth.js";
import { createMemoryLogger } from "../observability/logger.js";
import { newId } from "../shared/ids.js";
import { SHUTDOWN_BUDGET_MS, startServer } from "./server.js";
import type { ServerRuntime } from "./server.js";

let rt: ServerRuntime | null = null;
afterEach(async () => {
  await rt?.close();
  rt = null;
});

/** PORT is still validated; the listener itself uses an ephemeral loopback port. */
const ENV = { VSP_ENVIRONMENT: "ci", PORT: String(20_000 + Math.floor(Math.random() * 30_000)) };
const headers = (callId: string, sessionRef: string | null) => ({
  authorization: `Bearer ${LOCAL_FIXTURE_TOKENS.telephony_control}`,
  "content-type": "application/json",
  "x-vsp-interaction-id": callId,
  ...(sessionRef ? { "x-vsp-session-ref": sessionRef } : {}),
});

/** Starts a call over HTTP; returns its session reference. */
async function startCall(r: ServerRuntime, callId: string): Promise<string> {
  const started = await fetch(`${r.url}/telephony/v1/calls`, {
    method: "POST",
    headers: headers(callId, null),
    body: JSON.stringify({
      callId,
      callerIdHash: null,
      consent: { recording: "GRANTED", automatedProcessing: "GRANTED", disclosureTemplateVersion: "disclosure-local-v1", capturedAt: new Date().toISOString(), capturedBy: "studio_flow" },
    }),
  });
  expect(started.status).toBe(201);
  return ((await started.json()) as { sessionRef: string }).sessionRef;
}

const newCallId = () => `cal_synthGatewayFlush${newId("gf").slice(3, 15)}`;

/** POSTs a human request; resolves to "status <n>", or "client error <code>" when the socket was destroyed. */
function humanRequest(r: ServerRuntime, callId: string, sessionRef: string): Promise<string> {
  return fetch(`${r.url}/telephony/v1/session/human-request`, {
    method: "POST",
    headers: headers(callId, sessionRef),
    body: JSON.stringify({ callId, reason: "CALLER_REQUESTED_HUMAN", language: "en", issueCategory: null }),
  }).then(
    (res) => `status ${res.status}`,
    (err: unknown) => `client error ${(err as { cause?: { code?: string } }).cause?.code ?? "UNKNOWN"}`,
  );
}

/** Starts a call over HTTP, then requests a human during the LOCAL FIXTURE audit outage (the outage is left in place). */
async function humanRequestDuringOutage(r: ServerRuntime): Promise<string> {
  const callId = newCallId();
  const sessionRef = await startCall(r, callId);
  await r.container.db.exec("revoke insert on audit_outbox from app_runtime");
  // SAFE-02 / SAFE-03: the human route proceeds; its audit event waits in this process's queue.
  expect(await humanRequest(r, callId, sessionRef)).toBe("status 200");
  expect(r.container.deferredAudit.pending().map((p) => p.action)).toEqual(["handoff.requested"]);
  return callId;
}

/**
 * Business whose handoff route-audit append waits at a gate the test opens (a request still being
 * handled when shutdown begins, e.g. a slow transfer request); records each append result.
 */
function gatedRouteAudit() {
  const results: DeferredAppendResult[] = [];
  let entered = 0;
  let open: () => void = () => undefined;
  const gate = new Promise<void>((res) => {
    open = res;
  });
  const build: BuildBusiness = (deps) => {
    const inner = deps.deferredAudit;
    if (!inner) throw new Error("the composition must provide the deferred route-audit queue");
    return buildBusiness({
      ...deps,
      deferredAudit: {
        appendOrDefer: async (input, stream) => {
          entered += 1;
          await gate;
          const res = await inner.appendOrDefer(input, stream);
          results.push(res);
          return res;
        },
      },
    });
  };
  return { build, results, entered: () => entered, open: () => open() };
}

async function until(cond: () => boolean, timeoutMs: number): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("condition not reached");
    await new Promise((res) => setTimeout(res, 25));
  }
}

describe("gateway-only process drains its own deferred route-audit queue (ADR-0011)", () => {
  it("[OPS-01][SAFE-02][SAFE-03][SPEC-16.fault-audit-outage] without any worker loop, the gateway's timer appends the deferred handoff event after recovery, followed by its marker", async () => {
    const { logger } = createMemoryLogger();
    rt = await startServer({ env: ENV, port: 0, logger, deferredAuditFlush: { intervalMs: 100 } });
    const r = rt;
    expect(r.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    let callId: string;
    try {
      callId = await humanRequestDuringOutage(r);
      // Nothing is attempted while the store is unwritable; the depth gauge keeps reporting the held event.
      await new Promise((res) => setTimeout(res, 300));
      expect(r.container.deferredAudit.depth).toBe(1);
      expect(r.container.metrics.gaugeValue("vsp_audit_deferred_depth")).toBe(1);
    } finally {
      await r.container.db.exec("grant insert on audit_outbox to app_runtime");
    }
    await until(() => r.container.deferredAudit.depth === 0, 10_000);
    const events = (await r.container.auditQuery.search({ tenantId: r.container.config.tenantId, callId, limit: 200 }))
      .filter((e) => e.action.startsWith("handoff.") || e.action === DEFERRED_AUDIT_MARKER_ACTION)
      .sort((a, b) => a.sequence - b.sequence);
    expect(events.map((e) => e.action)).toEqual(["handoff.requested", DEFERRED_AUDIT_MARKER_ACTION]);
    expect(events[1]).toMatchObject({ parentId: events[0]?.eventId, reasonCode: "AUDIT_STORE_UNWRITABLE" });
    expect(r.container.metrics.counterValue("vsp_audit_deferred_total", { result: "flushed", reason: "none" })).toBe(1);
    expect(r.container.metrics.gaugeValue("vsp_audit_deferred_depth")).toBe(0);
  }, 120_000);

  it("[OPS-01][SAFE-03] graceful shutdown closes the listener, then attempts a bounded final flush before the database closes", async () => {
    const { logger, records } = createMemoryLogger();
    // The timer never fires during this test: only the shutdown flush can append the event.
    rt = await startServer({ env: ENV, port: 0, logger, deferredAuditFlush: { intervalMs: 300_000 } });
    const r = rt;
    try {
      await humanRequestDuringOutage(r);
    } finally {
      await r.container.db.exec("grant insert on audit_outbox to app_runtime");
    }
    expect(r.container.deferredAudit.depth).toBe(1);
    // Order: the final flush starts only once the listener is closed and the requests being handled
    // finished, and it still writes, so the database is open; a flush before the listener closes
    // could miss an event an in-flight request defers.
    const listeningAtFinalFlush: boolean[] = [];
    const stop = r.deferredAuditFlush.stop.bind(r.deferredAuditFlush);
    r.deferredAuditFlush.stop = () => {
      listeningAtFinalFlush.push(r.container.app.server.listening);
      return stop();
    };
    rt = null;
    await r.close();
    expect(listeningAtFinalFlush).toEqual([false]);
    expect(r.container.deferredAudit.depth).toBe(0);
    expect(r.container.metrics.counterValue("vsp_audit_deferred_total", { result: "flushed", reason: "none" })).toBe(1);
    expect(records).toContainEqual(expect.objectContaining({ level: "warn", event: "audit.deferred.final_flush", fields: expect.objectContaining({ written: 1, dropped: 0 }) }));
    expect(records.some((x) => x.event === "audit.deferred.unflushed_at_shutdown")).toBe(false);
    // The listener is closed.
    await expect(fetch(`${r.url}/health/live`)).rejects.toThrow();
  }, 120_000);

  it("[OPS-01][SAFE-03] an event that still cannot be written at shutdown is reported lost at error level, and shutdown stays bounded", async () => {
    const { logger, records } = createMemoryLogger();
    rt = await startServer({ env: ENV, port: 0, logger, deferredAuditFlush: { intervalMs: 300_000, finalFlushTimeoutMs: 1_000 } });
    const r = rt;
    await humanRequestDuringOutage(r);
    rt = null;
    const t0 = Date.now();
    await r.close();
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(records).toContainEqual(expect.objectContaining({ level: "error", event: "audit.deferred.unflushed_at_shutdown", fields: expect.objectContaining({ remaining: 1, reasonCode: "AUDIT_STORE_UNWRITABLE" }) }));
  }, 120_000);

  it("[OPS-01][SAFE-02][SAFE-03] a human request still being handled when shutdown begins completes, and its route evidence is appended before the database closes", async () => {
    const { logger, records } = createMemoryLogger();
    const g = gatedRouteAudit();
    rt = await startServer({ env: ENV, port: 0, logger, buildBusiness: g.build, deferredAuditFlush: { intervalMs: 300_000 } });
    const r = rt;
    const callId = newCallId();
    const human = humanRequest(r, callId, await startCall(r, callId));
    await until(() => g.entered() === 1, 10_000);
    rt = null;
    const closing = r.close();
    // Shutdown has begun (no new connection) while the request is still being handled; the handler
    // resumes only later, so a shutdown that did not wait would have destroyed it by then.
    await until(() => !r.container.app.server.listening, 10_000);
    await new Promise((res) => setTimeout(res, 250));
    g.open();
    await closing;
    // Not force-closed: the caller gets its answer, and the event was written, not deferred or lost.
    expect(await human).toBe("status 200");
    expect(g.results).toEqual([expect.objectContaining({ written: true, deferred: false, reasonCode: null })]);
    expect(records.filter((x) => x.level === "error" && x.event.startsWith("audit.deferred"))).toEqual([]);
    expect(records.some((x) => x.event === "server.shutdown_drain_timeout")).toBe(false);
  }, 120_000);

  it("[OPS-01][SAFE-02][SAFE-03] during a persisting outage a human request in flight at shutdown completes, and the event it defers is counted by the final flush as lost with the process", async () => {
    const { logger, records } = createMemoryLogger();
    const g = gatedRouteAudit();
    rt = await startServer({ env: ENV, port: 0, logger, buildBusiness: g.build, deferredAuditFlush: { intervalMs: 300_000, finalFlushTimeoutMs: 1_000 } });
    const r = rt;
    const callId = newCallId();
    const sessionRef = await startCall(r, callId);
    await r.container.db.exec("revoke insert on audit_outbox from app_runtime");
    const human = humanRequest(r, callId, sessionRef);
    await until(() => g.entered() === 1, 10_000);
    rt = null;
    const closing = r.close();
    await until(() => !r.container.app.server.listening, 10_000);
    await new Promise((res) => setTimeout(res, 250));
    g.open();
    await closing;
    expect(await human).toBe("status 200");
    expect(g.results).toEqual([expect.objectContaining({ written: false, deferred: true, reasonCode: "AUDIT_STORE_UNWRITABLE" })]);
    expect(records).toContainEqual(expect.objectContaining({ level: "error", event: "audit.deferred.unflushed_at_shutdown", fields: expect.objectContaining({ remaining: 1, reasonCode: "AUDIT_STORE_UNWRITABLE" }) }));
    expect(records.some((x) => x.event === "audit.deferred.lost_at_shutdown")).toBe(false);
  }, 120_000);

  it("[OPS-01][SAFE-02][SAFE-03] a request force-closed after the drain bound: shutdown waits for its handler, so its route evidence is written before the database closes and the process exits", async () => {
    const { logger, records } = createMemoryLogger();
    const g = gatedRouteAudit();
    rt = await startServer({ env: ENV, port: 0, logger, buildBusiness: g.build, inFlightDrainTimeoutMs: 100, deferredAuditFlush: { intervalMs: 300_000, finalFlushTimeoutMs: 1_000 } });
    const r = rt;
    const callId = newCallId();
    const human = humanRequest(r, callId, await startCall(r, callId));
    await until(() => g.entered() === 1, 10_000);
    rt = null;
    const closing = r.close();
    // The drain bound expires and the app force-closes the request (the caller sees a connection
    // error); the handler is still waiting (e.g. a slow transfer call) and resumes a second later.
    expect(await human).toMatch(/^client error /);
    setTimeout(() => g.open(), 1_000);
    await closing;
    // The moment the entry calls process.exit(0): the handler has settled and its event is written.
    expect(g.results).toEqual([expect.objectContaining({ written: true, deferred: false, reasonCode: null })]);
    expect(records).toContainEqual(expect.objectContaining({ level: "warn", event: "server.shutdown_drain_timeout", fields: expect.objectContaining({ inFlight: 1 }) }));
    expect(records.filter((x) => x.level === "error")).toEqual([]);
  }, 120_000);

  it("[OPS-01][SAFE-02][SAFE-03] during a persisting outage the event a force-closed handler defers is counted lost at error level before close() resolves (the moment the entry exits)", async () => {
    const { logger, records } = createMemoryLogger();
    const g = gatedRouteAudit();
    rt = await startServer({ env: ENV, port: 0, logger, buildBusiness: g.build, inFlightDrainTimeoutMs: 100, deferredAuditFlush: { intervalMs: 300_000, finalFlushTimeoutMs: 1_000 } });
    const r = rt;
    const callId = newCallId();
    const sessionRef = await startCall(r, callId);
    await r.container.db.exec("revoke insert on audit_outbox from app_runtime");
    const human = humanRequest(r, callId, sessionRef);
    await until(() => g.entered() === 1, 10_000);
    rt = null;
    const closing = r.close();
    expect(await human).toMatch(/^client error /);
    setTimeout(() => g.open(), 1_000);
    await closing;
    const atExit = records.map((x) => `${x.level}:${x.event}`);
    expect(g.results).toEqual([expect.objectContaining({ written: false, deferred: true, reasonCode: "AUDIT_STORE_UNWRITABLE" })]);
    expect(records).toContainEqual(
      expect.objectContaining({ level: "error", event: "audit.deferred.unflushed_at_shutdown", fields: expect.objectContaining({ remaining: 1, inProgress: 0, reasonCode: "AUDIT_STORE_UNWRITABLE" }) }),
    );
    expect(atExit).not.toContain("error:server.shutdown_handlers_unsettled");
    expect(atExit).not.toContain("error:audit.deferred.lost_at_shutdown");
  }, 120_000);

  it("[OPS-01][SAFE-03] a handler still running when the settle bound expires is logged at error level before close() resolves, and the event it defers later is reported lost by the sealed queue, never queued silently", async () => {
    const { logger, records } = createMemoryLogger();
    const g = gatedRouteAudit();
    rt = await startServer({
      env: ENV,
      port: 0,
      logger,
      buildBusiness: g.build,
      inFlightDrainTimeoutMs: 100,
      handlerSettleTimeoutMs: 100,
      deferredAuditFlush: { intervalMs: 300_000, finalFlushTimeoutMs: 1_000 },
    });
    const r = rt;
    const callId = newCallId();
    const sessionRef = await startCall(r, callId);
    await r.container.db.exec("revoke insert on audit_outbox from app_runtime");
    const human = humanRequest(r, callId, sessionRef);
    await until(() => g.entered() === 1, 10_000);
    rt = null;
    // The handler is still waiting when both bounds expire: the app force-closes it, the settle wait
    // gives up (error), the final flush finds an empty queue, the database closes.
    await r.close();
    expect(await human).toMatch(/^client error /);
    expect(records).toContainEqual(expect.objectContaining({ level: "warn", event: "server.shutdown_drain_timeout", fields: expect.objectContaining({ inFlight: 1, reasonCode: "SHUTDOWN_DRAIN_TIMEOUT" }) }));
    // At the moment the entry exits, the possible loss is on record at error level.
    expect(records).toContainEqual(expect.objectContaining({ level: "error", event: "server.shutdown_handlers_unsettled", fields: expect.objectContaining({ unsettled: 1, reasonCode: "SHUTDOWN_HANDLERS_UNSETTLED" }) }));
    expect(records.some((x) => x.event === "audit.deferred.unflushed_at_shutdown")).toBe(false);
    // Only a process that is still alive then sees the handler reach the sealed queue.
    g.open();
    await until(() => g.results.length === 1, 10_000);
    expect(g.results).toEqual([{ written: false, deferred: false, eventId: null, reasonCode: DEFERRED_AUDIT_AFTER_SHUTDOWN }]);
    expect(r.container.deferredAudit.depth).toBe(0);
    expect(records).toContainEqual(
      expect.objectContaining({ level: "error", event: "audit.deferred.lost_at_shutdown", fields: expect.objectContaining({ action: "handoff.requested", reasonCode: DEFERRED_AUDIT_AFTER_SHUTDOWN, lost: 1 }) }),
    );
    expect(r.container.metrics.counterValue("vsp_audit_deferred_total", { result: "dropped", reason: "store_unavailable" })).toBe(1);
  }, 120_000);

  it("[OPS-01] the shutdown bounds are validated before anything is composed or bound, and together stay within the ECS stop timeout", async () => {
    const { logger, records } = createMemoryLogger();
    for (const bad of [-1, 20_001, 1.5]) {
      await expect(startServer({ env: ENV, port: 0, logger, inFlightDrainTimeoutMs: bad })).rejects.toThrow("SHUTDOWN_DRAIN_POLICY_INVALID");
      await expect(startServer({ env: ENV, port: 0, logger, handlerSettleTimeoutMs: bad })).rejects.toThrow("SHUTDOWN_DRAIN_POLICY_INVALID");
    }
    // Drain + settle + final flush at most SHUTDOWN_BUDGET_MS (25 s of the 30 s ECS stopTimeout).
    expect(SHUTDOWN_BUDGET_MS).toBe(25_000);
    for (const over of [
      { inFlightDrainTimeoutMs: 20_000 },
      { inFlightDrainTimeoutMs: 10_000, handlerSettleTimeoutMs: 10_000, deferredAuditFlush: { finalFlushTimeoutMs: 5_001 } },
      { handlerSettleTimeoutMs: 15_000, deferredAuditFlush: { finalFlushTimeoutMs: 5_001 } },
      { deferredAuditFlush: { finalFlushTimeoutMs: Number.NaN } },
    ]) {
      await expect(startServer({ env: ENV, port: 0, logger, ...over }), JSON.stringify(over)).rejects.toThrow("SHUTDOWN_DRAIN_POLICY_INVALID");
    }
    expect(records.some((x) => x.event === "container.ready")).toBe(false);
  });
});
