/**
 * Deferred route-audit queue over real PostgreSQL SQL (PGlite, foundation + audit migrations),
 * the real PgAuditWriter and PgAuditHealth, a FakeClock and SYNTHETIC inputs. The audit outage is
 * the LOCAL FIXTURE simulation used across the audit tests: `revoke insert on audit_outbox from
 * app_runtime`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PgliteDb } from "../db/pglite.js";
import { createMemoryLogger } from "../observability/logger.js";
import { InMemoryMetrics } from "../observability/metrics.js";
import type { AuditEvent, AuditEventInput } from "../protocol/index.js";
import { FakeClock } from "../shared/clock.js";
import { AuditUnavailableError, ValidationError } from "../shared/errors.js";
import { verifyChain } from "./chain.js";
import { DEFERRED_AUDIT_MARKER_ACTION, DeferredAuditQueue } from "./deferred.js";
import { PgAuditHealth } from "./health.js";
import type { AuditWriter } from "./ports.js";
import { TENANT_ID, createAuditTestDb, sampleAuditInput } from "./testing.js";
import { PgAuditWriter } from "./writer.js";

const START = "2026-10-18T10:00:00.000Z";
let db: PgliteDb;
let clock: FakeClock;
/** Creating and migrating an embedded PostgreSQL can take long on a contended shared machine. */
const PGLITE_SETUP_TIMEOUT_MS = 120_000;

beforeEach(async () => {
  db = await createAuditTestDb();
  clock = new FakeClock(START);
}, PGLITE_SETUP_TIMEOUT_MS);
afterEach(async () => {
  await db.close();
});

const STREAM = "runtime";
const route = (action: string, correlationId: string): AuditEventInput =>
  sampleAuditInput(clock, { action, correlationId, sourceComponent: "gateway", outcome: "PENDING", assurance: "A0", actorRef: null, subjectRef: null, role: null, idempotencyKey: null, evidencePointers: [], turnId: null });

async function chain(): Promise<AuditEvent[]> {
  const r = await db.tx((tx) => tx.query<{ event: AuditEvent }>("select event from audit_outbox where source_stream = $1 order by sequence asc", [STREAM]), { role: "owner" });
  return r.rows.map((x) => x.event);
}

function compose(opts: { maxEntries?: number; writer?: AuditWriter } = {}) {
  const { logger, records } = createMemoryLogger();
  const metrics = new InMemoryMetrics();
  const writer = opts.writer ?? new PgAuditWriter({ db, clock, stream: STREAM });
  const health = new PgAuditHealth({ db, clock, policy: { maxBacklog: 10_000, maxBacklogAgeSeconds: 86_400 }, probeId: "gateway.deferred-test" });
  const queue = new DeferredAuditQueue({ writer, clock, logger, metrics, health, ...(opts.maxEntries ? { maxEntries: opts.maxEntries } : {}) });
  return { queue, records, metrics, health };
}

describe("DeferredAuditQueue (route evidence during an audit outage)", () => {
  it("[OPS-01][SAFE-03][SPEC-13.bounded-buffer] events deferred during an outage are appended in deferral order once the store is writable, each followed by a marker naming why it was late; the chain stays intact", async () => {
    const { queue, records, metrics, health } = compose();
    expect(await queue.appendOrDefer(route("handoff.requested", "hnd_synthHandoffBefore0001"))).toMatchObject({ written: true, deferred: false });

    await db.exec("revoke insert on audit_outbox from app_runtime");
    const first = await queue.appendOrDefer(route("handoff.requested", "hnd_synthHandoffDuring0001"));
    clock.advanceMs(1_000);
    const second = await queue.appendOrDefer(route("handoff.safety_requested", "hnd_synthHandoffDuring0002"));
    expect(first).toEqual({ written: false, deferred: true, eventId: null, reasonCode: "AUDIT_STORE_UNWRITABLE" });
    expect(second).toMatchObject({ written: false, deferred: true });
    expect(queue.depth).toBe(2);
    // Consequential work is still refused while route evidence is queued (the queue never changes health).
    await expect(health.assertCanAcceptConsequential()).rejects.toBeInstanceOf(AuditUnavailableError);
    // Flushing while the store is unwritable attempts nothing.
    expect(await queue.flush()).toEqual({ written: 0, dropped: 0, remaining: 2, reasonCode: "AUDIT_STORE_UNWRITABLE" });
    // Loud, content-free signal while evidence is held in memory.
    expect(records.filter((r) => r.level === "error" && r.event === "audit.deferred.queued").map((r) => r.fields.action)).toEqual(["handoff.requested", "handoff.safety_requested"]);
    expect(metrics.counterValue("vsp_audit_deferred_total", { result: "queued", reason: "store_unavailable" })).toBe(2);
    expect(metrics.gaugeValue("vsp_audit_deferred_depth")).toBe(2);

    await db.exec("grant insert on audit_outbox to app_runtime");
    clock.advanceMs(30_000);
    expect(await queue.flush()).toEqual({ written: 2, dropped: 0, remaining: 0, reasonCode: null });
    const events = await chain();
    expect(events.map((e) => [e.action, e.correlationId])).toEqual([
      ["handoff.requested", "hnd_synthHandoffBefore0001"],
      ["handoff.requested", "hnd_synthHandoffDuring0001"],
      [DEFERRED_AUDIT_MARKER_ACTION, "hnd_synthHandoffDuring0001"],
      ["handoff.safety_requested", "hnd_synthHandoffDuring0002"],
      [DEFERRED_AUDIT_MARKER_ACTION, "hnd_synthHandoffDuring0002"],
    ]);
    // The late event keeps its original occurrence time; the marker points at it and carries the deferral reason.
    expect(events[1]?.occurredAt).toBe(START);
    expect(events[2]).toMatchObject({ parentId: events[1]?.eventId, reasonCode: "AUDIT_STORE_UNWRITABLE", outcome: "SUCCEEDED", sourceComponent: "gateway" });
    expect(verifyChain(events, { sourceStream: STREAM, expectedSequence: 1, expectedPrevHash: null }).findings).toEqual([]);
    expect(metrics.counterValue("vsp_audit_deferred_total", { result: "flushed", reason: "none" })).toBe(2);
    expect(metrics.observations("vsp_audit_deferred_age_ms")).toEqual([31_000, 30_000]);
    expect(metrics.gaugeValue("vsp_audit_deferred_depth")).toBe(0);
    // Re-flushing is a no-op (idempotent: each deferred event is appended exactly once).
    expect(await queue.flush()).toEqual({ written: 0, dropped: 0, remaining: 0, reasonCode: null });
    expect(await chain()).toHaveLength(5);
  });

  it("[OPS-01][SPEC-13.bounded-buffer] order is kept across recovery: a new event first drains the older deferred ones, then is appended after them", async () => {
    const { queue } = compose();
    await db.exec("revoke insert on audit_outbox from app_runtime");
    await queue.appendOrDefer(route("handoff.requested", "hnd_synthHandoffOrder00001"));
    await db.exec("grant insert on audit_outbox to app_runtime");
    const next = await queue.appendOrDefer(route("handoff.transfer_failed", "hnd_synthHandoffOrder00002"));
    expect(next).toMatchObject({ written: true, deferred: false });
    expect((await chain()).map((e) => e.action)).toEqual(["handoff.requested", DEFERRED_AUDIT_MARKER_ACTION, "handoff.transfer_failed"]);
  });

  it("[OPS-01][SPEC-13.bounded-buffer] the queue is bounded: beyond maxEntries a new event is dropped loudly and counted, never silently", async () => {
    const { queue, records, metrics } = compose({ maxEntries: 2 });
    await db.exec("revoke insert on audit_outbox from app_runtime");
    await queue.appendOrDefer(route("handoff.requested", "hnd_synthHandoffBound00001"));
    await queue.appendOrDefer(route("handoff.requested", "hnd_synthHandoffBound00002"));
    const third = await queue.appendOrDefer(route("handoff.requested", "hnd_synthHandoffBound00003"));
    expect(third).toEqual({ written: false, deferred: false, eventId: null, reasonCode: "AUDIT_DEFERRED_QUEUE_FULL" });
    expect(queue.depth).toBe(2);
    expect(metrics.counterValue("vsp_audit_deferred_total", { result: "dropped", reason: "queue_full" })).toBe(1);
    expect(records).toContainEqual(expect.objectContaining({ level: "error", event: "audit.deferred.dropped", fields: expect.objectContaining({ reasonCode: "AUDIT_DEFERRED_QUEUE_FULL", correlationId: "hnd_synthHandoffBound00003" }) }));
  });

  it("[OPS-01][AUTH-06] an invalid event is refused up front and never queued; an event the writer later refuses as invalid is dropped loudly instead of blocking the queue", async () => {
    const { queue } = compose();
    await expect(queue.appendOrDefer({ ...route("handoff.requested", "hnd_synthHandoffInvalid01"), reasonCode: "CALLER SAID 5551234" } as AuditEventInput)).rejects.toBeInstanceOf(ValidationError);
    expect(queue.depth).toBe(0);

    // A writer that is down, then refuses one event permanently and accepts the rest.
    const accepted: string[] = [];
    let down = true;
    const writer: AuditWriter = {
      append: async () => {
        throw new AuditUnavailableError("AUDIT_STORE_UNWRITABLE");
      },
      appendStandalone: async (input) => {
        if (down) throw new AuditUnavailableError("AUDIT_STORE_UNWRITABLE");
        if (input.correlationId === "hnd_synthHandoffRefused01") throw new ValidationError("AUDIT_EVENT_TIMESTAMP_IN_FUTURE");
        accepted.push(`${input.action}:${input.correlationId}`);
        return { eventId: `aud_synthAccepted${String(accepted.length).padStart(8, "0")}` } as AuditEvent;
      },
    };
    const { logger, records } = createMemoryLogger();
    const metrics = new InMemoryMetrics();
    const q = new DeferredAuditQueue({ writer, clock, logger, metrics });
    await q.appendOrDefer(route("handoff.requested", "hnd_synthHandoffRefused01"));
    await q.appendOrDefer(route("handoff.requested", "hnd_synthHandoffKept00001"));
    down = false;
    expect(await q.flush()).toEqual({ written: 1, dropped: 1, remaining: 0, reasonCode: null });
    expect(accepted).toEqual(["handoff.requested:hnd_synthHandoffKept00001", `${DEFERRED_AUDIT_MARKER_ACTION}:hnd_synthHandoffKept00001`]);
    expect(metrics.counterValue("vsp_audit_deferred_total", { result: "dropped", reason: "invalid" })).toBe(1);
    expect(records).toContainEqual(expect.objectContaining({ level: "error", event: "audit.deferred.dropped", fields: expect.objectContaining({ reasonCode: "AUDIT_EVENT_TIMESTAMP_IN_FUTURE" }) }));
  });

  it("[OPS-01] concurrent appends are serialized: nothing is lost or reordered and every written event belongs to the tenant", async () => {
    const { queue } = compose();
    const ids = Array.from({ length: 8 }, (_, i) => `hnd_synthHandoffConcurrent${String(i).padStart(2, "0")}`);
    await db.exec("revoke insert on audit_outbox from app_runtime");
    await Promise.all(ids.slice(0, 4).map((id) => queue.appendOrDefer(route("handoff.requested", id))));
    await db.exec("grant insert on audit_outbox to app_runtime");
    await Promise.all(ids.slice(4).map((id) => queue.appendOrDefer(route("handoff.requested", id))));
    await queue.flush();
    const events = (await chain()).filter((e) => e.action === "handoff.requested");
    expect(events.map((e) => e.correlationId)).toEqual(ids);
    expect(new Set(events.map((e) => e.tenantId))).toEqual(new Set([TENANT_ID]));
  });
});
