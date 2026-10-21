/**
 * Route-audit reconciliation (FO-01-34, FO-15-45, FO-15-48): no human or safety route is ever silently
 * unaudited. Real PostgreSQL SQL (PGlite: foundation, audit, 06xx ops/safety and 2040 migrations), the
 * real PgAuditWriter and DurableDeferredAuditQueue, a FakeClock and SYNTHETIC rows. safety_events rows are
 * inserted the way SafetyEventRecorder writes them during an audit outage (audit_status AUDIT_UNAVAILABLE).
 * The detached-execution + SIGTERM + restart run is Layer 2 (test/integration/substrate/route-audit-crash.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PgliteDb } from "../db/pglite.js";
import { createTestDb } from "../db/testing.js";
import { InMemoryMetrics, createMetricCatalogue } from "../observability/metrics.js";
import { withSubstrateMetrics } from "../observability/catalog/substrate.js";
import type { AuditEvent } from "../protocol/index.js";
import { FakeClock, iso } from "../shared/clock.js";
import { newId } from "../shared/ids.js";
import { verifyChain } from "./chain.js";
import { DurableDeferredAuditQueue } from "./journal.js";
import { PgRouteAuditIntents, ROUTE_NOT_RECORDED_ACTION, RouteAuditReconciler, SAFETY_EVENT_UNAUDITED_ACTION } from "./route-reconciler.js";
import { TENANT_ID, sampleAuditInput } from "./testing.js";
import { PgAuditWriter } from "./writer.js";

const RUNTIME = "runtime";
const WORKER = "worker.reconciler";
let db: PgliteDb;
let clock: FakeClock;

/** Creating and migrating an embedded PostgreSQL can take long on a contended shared machine. */
const PGLITE_SETUP_TIMEOUT_MS = 120_000;

beforeEach(async () => {
  db = await createTestDb({ include: /^(02|06|2040|2045)/ });
  clock = new FakeClock("2026-10-19T10:00:00.000Z");
}, PGLITE_SETUP_TIMEOUT_MS);
afterEach(async () => {
  await db.close();
});

/** Inserts one safety_events row exactly as SafetyEventRecorder's outage fallback does (no audit event). */
async function safetyRow(callId: string, incidentId: string, phase: "SIGNAL_VALIDATED" | "ROUTE_INITIATED", auditEventId: string | null = null): Promise<string> {
  const eventId = newId("sev");
  const at = iso(clock.now());
  await db.tx(
    (tx) =>
      tx.query(
        `insert into safety_events (event_id, incident_id, tenant_id, call_id, session_generation, phase, signal_sources, rule_ids,
           clinical_categories, strongest_strength, any_third_party, any_historical, any_negated, route, destination_id, reason_code, locale,
           locale_supported, after_hours, detected_at, route_initiated_at, latency_ms, target_ms, within_target, audit_event_id, audit_status, recorded_at)
         values ($1, $2, $3, $4, 0, $5, array['EXPLICIT_PHRASE'], array['safety.rule.synthetic'], array[]::text[], 'CREDIBLE', false, false, false,
           'SAFETY_PRIORITY_HUMAN', 'dst_safety_priority', 'SAFETY_SIGNAL_VALIDATED', 'en-US', true, false, $6::timestamptz,
           $7::timestamptz, $8, 2000, $9, $10, $11, $6::timestamptz)`,
        [
          eventId,
          incidentId,
          TENANT_ID,
          callId,
          phase,
          at,
          phase === "ROUTE_INITIATED" ? at : null,
          phase === "ROUTE_INITIATED" ? 0 : null,
          phase === "ROUTE_INITIATED" ? true : null,
          auditEventId,
          auditEventId ? "RECORDED" : "AUDIT_UNAVAILABLE",
        ],
      ),
    { role: "owner" },
  );
  return eventId;
}

function compose() {
  const metrics = new InMemoryMetrics({ catalogue: withSubstrateMetrics(createMetricCatalogue()) });
  const runtimeWriter = new PgAuditWriter({ db, clock, stream: RUNTIME });
  const workerWriter = new PgAuditWriter({ db, clock, stream: WORKER, standaloneRole: "app_worker" });
  const queue = new DurableDeferredAuditQueue({ db, writer: runtimeWriter, clock, tenants: [TENANT_ID] });
  const reconciler = new RouteAuditReconciler({ db, writer: workerWriter, clock, tenants: [TENANT_ID], stream: WORKER, graceSeconds: 300, metrics });
  return { queue, reconciler, metrics, intents: new PgRouteAuditIntents({ db, clock }) };
}

async function events(stream: string): Promise<AuditEvent[]> {
  const r = await db.tx((tx) => tx.query<{ event: AuditEvent }>("select event from audit_outbox where source_stream = $1 order by sequence", [stream]), { role: "owner" });
  return r.rows.map((x) => x.event);
}

const routeEvent = (action: string, callId: string) =>
  sampleAuditInput(clock, { action, callId, correlationId: newId("hnd"), sourceComponent: "gateway", outcome: "PENDING", assurance: "A0", actorRef: null, subjectRef: null, role: null, idempotencyKey: null, evidencePointers: [], turnId: null });

describe("RouteAuditReconciler", () => {
  it("[FO-01-34][OPS-01][SAFE-03] a safety incident whose route never left audit evidence gets exactly one audit.route.not_recorded marker linked to its safety_events rows", async () => {
    const { reconciler, metrics } = compose();
    const callId = newId("call");
    const incidentId = newId("sin");
    const validated = await safetyRow(callId, incidentId, "SIGNAL_VALIDATED");
    const initiated = await safetyRow(callId, incidentId, "ROUTE_INITIATED");
    // Before the grace period nothing is decided (the route may still be completing).
    clock.advanceSeconds(60);
    expect((await reconciler.runOnce()).safetyIncidents).toEqual({ evidenced: 0, notRecorded: 0 });
    clock.advanceSeconds(300);
    const r = await reconciler.runOnce();
    expect(r.safetyIncidents).toEqual({ evidenced: 0, notRecorded: 1 });
    const marker = (await events(WORKER)).find((e) => e.action === ROUTE_NOT_RECORDED_ACTION);
    expect(marker).toMatchObject({ callId, correlationId: incidentId, outcome: "UNKNOWN", reasonCode: "ROUTE_AUDIT_NOT_RECORDED" });
    expect(marker?.evidencePointers).toEqual([`safety_incident:${incidentId}`, `db://safety_events/${validated}`, `db://safety_events/${initiated}`]);
    expect(r.markerEventIds).toEqual([marker?.eventId]);
    // Exactly once: a re-run (or a restarted reconciler) does not write another marker.
    expect((await reconciler.runOnce()).markerEventIds).toEqual([]);
    expect((await events(WORKER)).filter((e) => e.action === ROUTE_NOT_RECORDED_ACTION)).toHaveLength(1);
    expect(metrics.counterValue("vsp_route_audit_reconciled_total", { subject: "safety_incident", result: "not_recorded" })).toBe(1);
    expect(verifyChain(await events(WORKER), { sourceStream: WORKER, expectedSequence: 1, expectedPrevHash: null }).findings).toEqual([]);
  });

  it("[FO-01-34][OPS-01] an evidenced safety route is not reported; its unaudited safety rows are still listed in the chain", async () => {
    const { queue, reconciler } = compose();
    const callId = newId("call");
    const incidentId = newId("sin");
    const unaudited = await safetyRow(callId, incidentId, "SIGNAL_VALIDATED");
    await queue.appendOrDefer(routeEvent("handoff.safety_requested", callId));
    clock.advanceSeconds(301);
    const r = await reconciler.runOnce();
    expect(r.safetyIncidents).toEqual({ evidenced: 1, notRecorded: 0 });
    const marker = (await events(WORKER)).find((e) => e.action === SAFETY_EVENT_UNAUDITED_ACTION);
    expect(marker?.evidencePointers).toEqual([`safety_incident:${incidentId}`, `db://safety_events/${unaudited}`]);
    expect((await events(WORKER)).some((e) => e.action === ROUTE_NOT_RECORDED_ACTION)).toBe(false);
  });

  it("[FO-15-45][OPS-01] a route event still pending in the durable journal counts as evidence (it will be appended), not as a gap", async () => {
    const { queue, reconciler } = compose();
    const callId = newId("call");
    await safetyRow(callId, newId("sin"), "SIGNAL_VALIDATED", null);
    await db.exec("revoke insert on audit_outbox from app_runtime");
    expect(await queue.appendOrDefer(routeEvent("handoff.safety_requested", callId))).toMatchObject({ deferred: true, journal: "postgres" });
    clock.advanceSeconds(301);
    expect((await reconciler.runOnce()).safetyIncidents).toEqual({ evidenced: 1, notRecorded: 0 });
  });

  it("[FO-01-34][FO-15-48] a human route intent that reaches its deadline without evidence becomes a not_recorded marker; one resolved in time, or found late, does not", async () => {
    const { queue, reconciler, intents } = compose();
    const callId = newId("call");
    const lost = newId("hnd");
    const onTime = newId("hnd");
    const late = newId("hnd");
    for (const c of [lost, onTime, late]) await intents.open({ tenantId: TENANT_ID, routeKind: "HUMAN_TRANSFER", correlationId: c, callId, deadlineSeconds: 60 });
    await queue.appendOrDefer({ ...routeEvent("handoff.requested", callId), correlationId: onTime });
    // A route event written by a path that does not resolve intents (e.g. a plain appendStandalone) is found late.
    await new PgAuditWriter({ db, clock, stream: RUNTIME }).appendStandalone({ ...routeEvent("handoff.transfer_failed", callId), correlationId: late, outcome: "FAILED", reasonCode: "TRANSFER_REQUEST_FAILED" });
    clock.advanceSeconds(61);
    const r = await reconciler.runOnce();
    expect(r.routeIntents).toEqual({ evidenced: 1, notRecorded: 1 });
    const status = await db.tx((tx) => tx.query<{ correlation_id: string; status: string }>("select correlation_id, status from route_audit_intents order by correlation_id"), { role: "owner" });
    expect(Object.fromEntries(status.rows.map((x) => [x.correlation_id, x.status]))).toEqual({ [lost]: "NOT_RECORDED", [onTime]: "RECORDED", [late]: "RECORDED" });
    const marker = (await events(WORKER)).find((e) => e.action === ROUTE_NOT_RECORDED_ACTION);
    expect(marker).toMatchObject({ correlationId: lost, callId });
    expect((await reconciler.runOnce()).routeIntents).toEqual({ evidenced: 0, notRecorded: 0 });
  });

  it("[FO-01-34][OPS-01][SAFE-03] adversarial: an event that merely carries the route's correlation id (a non-route action, or a HUMAN route event on a SAFETY intent) closes no intent, written or journaled; the reconciler reports both routes as not recorded", async () => {
    const { queue, reconciler, intents } = compose();
    const callId = newId("call");
    const human = newId("hnd");
    const safety = newId("hnd");
    await intents.open({ tenantId: TENANT_ID, routeKind: "HUMAN_TRANSFER", correlationId: human, callId, deadlineSeconds: 60 });
    await intents.open({ tenantId: TENANT_ID, routeKind: "SAFETY_ROUTE", correlationId: safety, callId, deadlineSeconds: 60 });
    const status = async () =>
      Object.fromEntries((await db.tx((tx) => tx.query<{ correlation_id: string; status: string }>("select correlation_id, status from route_audit_intents"), { role: "owner" })).rows.map((x) => [x.correlation_id, x.status]));
    // Written at once.
    expect(await queue.appendOrDefer({ ...routeEvent("tool.invoke", callId), correlationId: human, outcome: "SUCCEEDED" })).toMatchObject({ written: true });
    expect(await queue.appendOrDefer({ ...routeEvent("handoff.requested", callId), correlationId: safety })).toMatchObject({ written: true });
    // Journaled during an audit outage, then flushed.
    await db.exec("revoke insert on audit_outbox from app_runtime");
    expect(await queue.appendOrDefer({ ...routeEvent("support_request.created", callId), correlationId: human, outcome: "SUCCEEDED" })).toMatchObject({ deferred: true, journal: "postgres" });
    expect(await queue.appendOrDefer({ ...routeEvent("handoff.transfer_failed", callId), correlationId: safety, outcome: "FAILED", reasonCode: "TRANSFER_REQUEST_FAILED" })).toMatchObject({ deferred: true });
    await db.exec("grant insert on audit_outbox to app_runtime");
    expect((await queue.flush()).written).toBe(2);
    expect(await status()).toEqual({ [human]: "OPEN", [safety]: "OPEN" });
    clock.advanceSeconds(61);
    const r = await reconciler.runOnce();
    expect(r.routeIntents).toEqual({ evidenced: 0, notRecorded: 2 });
    expect(await status()).toEqual({ [human]: "NOT_RECORDED", [safety]: "NOT_RECORDED" });
    expect((await events(WORKER)).filter((e) => e.action === ROUTE_NOT_RECORDED_ACTION).map((e) => e.correlationId).sort()).toEqual([human, safety].sort());
  });

  it("[FO-01-34][OPS-01] route evidence of the intent's kind closes it: a safety route event closes a SAFETY intent (and a HUMAN intent escalated to it); late evidence of the right kind is found by the reconciler", async () => {
    const { queue, reconciler, intents } = compose();
    const callId = newId("call");
    const escalated = newId("hnd");
    const safetyNow = newId("hnd");
    const safetyLate = newId("hnd");
    await intents.open({ tenantId: TENANT_ID, routeKind: "HUMAN_TRANSFER", correlationId: escalated, callId, deadlineSeconds: 60 });
    await intents.open({ tenantId: TENANT_ID, routeKind: "SAFETY_ROUTE", correlationId: escalated, callId, deadlineSeconds: 60 });
    await intents.open({ tenantId: TENANT_ID, routeKind: "SAFETY_ROUTE", correlationId: safetyNow, callId, deadlineSeconds: 60 });
    await intents.open({ tenantId: TENANT_ID, routeKind: "SAFETY_ROUTE", correlationId: safetyLate, callId, deadlineSeconds: 60 });
    await queue.appendOrDefer({ ...routeEvent("handoff.safety_requested", callId), correlationId: escalated });
    await queue.appendOrDefer({ ...routeEvent("safety.route.initiated", callId), correlationId: safetyNow });
    // Late: written by a path that resolves no intent; a human event of the same correlation first (not evidence for it).
    const plain = new PgAuditWriter({ db, clock, stream: RUNTIME });
    await plain.appendStandalone({ ...routeEvent("handoff.requested", callId), correlationId: safetyLate });
    clock.advanceSeconds(1);
    await plain.appendStandalone({ ...routeEvent("handoff.safety_transfer_failed", callId), correlationId: safetyLate, outcome: "FAILED", reasonCode: "TRANSFER_REQUEST_FAILED" });
    const rows = await db.tx((tx) => tx.query<{ correlation_id: string; route_kind: string; status: string }>("select correlation_id, route_kind, status from route_audit_intents"), { role: "owner" });
    const recorded = rows.rows.filter((x) => x.status === "RECORDED").map((x) => `${x.correlation_id}/${x.route_kind}`);
    expect(recorded.sort()).toEqual([`${escalated}/HUMAN_TRANSFER`, `${escalated}/SAFETY_ROUTE`, `${safetyNow}/SAFETY_ROUTE`].sort());
    clock.advanceSeconds(61);
    expect((await reconciler.runOnce()).routeIntents).toEqual({ evidenced: 1, notRecorded: 0 });
    const resolved = await db.tx((tx) => tx.query<{ resolved_event_id: string }>("select resolved_event_id from route_audit_intents where correlation_id = $1", [safetyLate]), { role: "owner" });
    const failed = (await events(RUNTIME)).find((e) => e.correlationId === safetyLate && e.action === "handoff.safety_transfer_failed");
    expect(resolved.rows[0]?.resolved_event_id).toBe(failed?.eventId);
  });

  it("[FO-01-34] invalid intents and reconciler configuration are refused", async () => {
    const { intents } = compose();
    await expect(intents.open({ tenantId: TENANT_ID, routeKind: "HUMAN_TRANSFER", correlationId: "free text", callId: newId("call") })).rejects.toThrow("ROUTE_AUDIT_INTENT_INVALID");
    await expect(intents.open({ tenantId: TENANT_ID, routeKind: "SAFETY_ROUTE", correlationId: newId("hnd"), callId: newId("call"), deadlineSeconds: 5 })).rejects.toThrow("ROUTE_AUDIT_INTENT_DEADLINE_INVALID");
    expect(() => new RouteAuditReconciler({ db, writer: new PgAuditWriter({ db, clock, stream: WORKER }), clock, tenants: [TENANT_ID], stream: WORKER, graceSeconds: 1 })).toThrow("ROUTE_AUDIT_RECONCILER_CONFIG_INVALID");
  });
});
