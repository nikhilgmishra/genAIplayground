import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PgAuditWriter } from "../audit/writer.js";
import type { PgliteDb } from "../db/pglite.js";
import { createTestDb } from "../db/testing.js";
import type { Db } from "../db/types.js";
import { CALLS, OTHER_TENANT_ID, TENANT_ID } from "../fixtures/synthetic-world.js";
import { createMemoryLogger } from "../observability/logger.js";
import { InMemoryMetrics } from "../observability/metrics.js";
import { FakeClock } from "../shared/clock.js";
import { FIXTURE_AUDIT_TABLE_SQL, RecordingAuditWriterFixture } from "./__fixtures__/audit-writer.fixture.js";
import { SafetyPipeline } from "./pipeline.js";
import type { SafetySignal } from "./ports.js";
import { SAFETY_ROUTE_TARGET_MS, SafetyEventRecorder } from "./safety-events.js";
import type { SafetyIncidentInput } from "./safety-events.js";

let db: PgliteDb;
let clock: FakeClock;
let audit: RecordingAuditWriterFixture;

const CALL_ID = CALLS.primary.callId;
const TRANSFER_ID = "xfr_synthTransferPrimary01";
const signal: SafetySignal = { source: "EXPLICIT_PHRASE", ruleId: "explicit.en.self_kill", strength: "CREDIBLE", subject: "SELF", temporal: "CURRENT", negated: false, locale: "en-US" };

const incidentInput = (over: Partial<SafetyIncidentInput> = {}): SafetyIncidentInput => ({
  tenantId: TENANT_ID,
  callId: CALL_ID,
  sessionGeneration: 0,
  turnId: "turn_synthTurn0001",
  signals: [signal],
  decision: { route: "SAFETY_PRIORITY_HUMAN", destinationId: "dst_safety_priority", reasonCode: "SAFETY_SIGNAL_CREDIBLE" },
  locale: "en-US",
  afterHours: false,
  ...over,
});

async function rows(where = "true", params: unknown[] = []): Promise<Record<string, unknown>[]> {
  return (await db.tx((tx) => tx.query<Record<string, unknown>>(`select * from safety_events where ${where} order by recorded_at, case phase when 'SIGNAL_VALIDATED' then 0 when 'ROUTE_INITIATED' then 1 else 2 end`, params), { role: "owner" })).rows;
}

beforeEach(async () => {
  db = await createTestDb({ include: /^0610_/ });
  await db.exec(FIXTURE_AUDIT_TABLE_SQL);
  clock = new FakeClock("2026-10-17T15:00:00.000Z");
  audit = new RecordingAuditWriterFixture({ table: "fixture_audit_events" });
});
afterEach(async () => {
  await db.close();
});

describe("SafetyEventRecorder", () => {
  it("[SPEC-10.latency] measures time from validated signal to route initiation with the injected clock against the 2 s target", async () => {
    const metrics = new InMemoryMetrics();
    const recorder = new SafetyEventRecorder({ db, audit, clock, metrics });
    const incident = recorder.begin(incidentInput());
    await recorder.recordValidated(incident);
    clock.advanceMs(1_500);
    const init = await recorder.recordRouteInitiated(incident, { transferId: TRANSFER_ID });
    expect(init).toMatchObject({ recorded: true, auditRecorded: true, latencyMs: 1_500, withinTarget: true, targetMs: SAFETY_ROUTE_TARGET_MS });
    const [validated, initiated] = await rows();
    expect(validated).toMatchObject({ phase: "SIGNAL_VALIDATED", audit_status: "RECORDED", latency_ms: null });
    expect(initiated).toMatchObject({ phase: "ROUTE_INITIATED", latency_ms: 1500, within_target: true, transfer_id: TRANSFER_ID, target_ms: 2000 });
    expect(metrics.observations("vsp_safety_time_to_routing_ms", { signal_source: "explicit_phrase" })).toEqual([1500]);
    expect(metrics.counterValue("vsp_safety_signals_total", { signal_source: "explicit_phrase" })).toBe(1);
  });

  it("[SPEC-10.latency] a missed target is recorded and logged (content-free); the route is not affected", async () => {
    const { logger, records } = createMemoryLogger();
    const recorder = new SafetyEventRecorder({ db, audit, clock, logger });
    const incident = recorder.begin(incidentInput());
    clock.advanceMs(2_400);
    const r = await recorder.recordRouteInitiated(incident);
    expect(r).toMatchObject({ recorded: true, latencyMs: 2_400, withinTarget: false });
    expect(records.some((x) => x.event === "safety.route.target_missed" && x.fields.reasonCode === "SAFETY_ROUTE_TARGET_MISSED")).toBe(true);
  });

  it("[SPEC-10.latency] utterance-to-detection latency is measured separately when the telephony end-of-utterance time is known", async () => {
    const recorder = new SafetyEventRecorder({ db, audit, clock });
    const utteranceEndedAt = new Date(clock.now().getTime() - 350);
    await recorder.recordValidated(recorder.begin(incidentInput({ utteranceEndedAt })));
    const [row] = await rows();
    expect(row).toMatchObject({ detection_latency_ms: 350 });
  });

  it("[OPS-01] the safety_events row and its audit event commit in the same transaction", async () => {
    const recorder = new SafetyEventRecorder({ db, audit, clock });
    const r = await recorder.recordValidated(recorder.begin(incidentInput()));
    const markers = (await db.tx((tx) => tx.query<{ event_id: string; action: string }>("select event_id, action from fixture_audit_events"), { role: "owner" })).rows;
    expect(markers).toEqual([{ event_id: r.auditEventId, action: "safety.signal.validated" }]);
    const [row] = await rows();
    expect(row?.audit_event_id).toBe(r.auditEventId);
    expect(audit.events[0]).toMatchObject({ sourceComponent: "safety", callId: CALL_ID, reasonCode: "SAFETY_SIGNAL_CREDIBLE", dataClass: "SECURITY_AUDIT", evidencePointers: [`db://safety_events/${String(row?.event_id)}`] });
  });

  it("[SAFE-02] [OPS-01] an audit failure mid-transaction rolls back its write; the incident is still recorded as AUDIT_UNAVAILABLE and nothing throws", async () => {
    audit.failAfterWrite = true;
    const { logger, records } = createMemoryLogger();
    const recorder = new SafetyEventRecorder({ db, audit, clock, logger });
    const incident = recorder.begin(incidentInput());
    const r = await recorder.recordRouteInitiated(incident);
    expect(r).toMatchObject({ recorded: true, auditRecorded: false, reasonCode: "AUDIT_UNAVAILABLE" });
    expect((await db.tx((tx) => tx.query("select * from fixture_audit_events"), { role: "owner" })).rows).toEqual([]);
    expect(await rows()).toEqual([expect.objectContaining({ phase: "ROUTE_INITIATED", audit_status: "AUDIT_UNAVAILABLE", audit_event_id: null })]);
    expect(records.some((x) => x.event === "safety.event.audit_or_store_failed")).toBe(true);
  });

  it("[SAFE-02] a complete database outage never throws into the safety route", async () => {
    const broken: Db = { engine: "pglite", query: async () => Promise.reject(new Error("down")), exec: async () => Promise.reject(new Error("down")), tx: async () => Promise.reject(new Error("down")), close: async () => undefined };
    const recorder = new SafetyEventRecorder({ db: broken, audit, clock });
    const incident = recorder.begin(incidentInput());
    await expect(recorder.recordValidated(incident)).resolves.toMatchObject({ recorded: false, reasonCode: "SAFETY_EVENT_STORE_UNAVAILABLE" });
    await expect(recorder.recordRouteInitiated(incident)).resolves.toMatchObject({ recorded: false, latencyMs: 0 });
  });

  it("[SPEC-10.routing] validation and initiation are idempotent per incident; outcomes append", async () => {
    const recorder = new SafetyEventRecorder({ db, audit, clock });
    const incident = recorder.begin(incidentInput());
    const first = await recorder.recordValidated(incident);
    const second = await recorder.recordValidated(incident);
    expect(second).toMatchObject({ recorded: true, duplicate: true, eventId: first.eventId });
    await recorder.recordOutcome(incident, { outcome: "FAILED" });
    clock.advanceSeconds(30);
    await recorder.recordOutcome(incident, { outcome: "TRANSFERRED", transferId: TRANSFER_ID });
    const all = await rows();
    expect(all.map((r) => r.phase)).toEqual(["SIGNAL_VALIDATED", "OUTCOME", "OUTCOME"]);
    expect(all.map((r) => r.outcome)).toEqual([null, "FAILED", "TRANSFERRED"]);
  });

  it("[SAFE-04] TRANSFERRED cannot be recorded without the transfer coordinator's transfer id", async () => {
    const recorder = new SafetyEventRecorder({ db, audit, clock });
    const r = await recorder.recordOutcome(recorder.begin(incidentInput()), { outcome: "TRANSFERRED" });
    expect(r).toMatchObject({ recorded: false, reasonCode: "SAFETY_EVENT_TRANSFER_REQUIRED" });
  });

  it("[SPEC-10.routing] invalid incident input never throws from begin(); recording reports the reason code", async () => {
    const recorder = new SafetyEventRecorder({ db, audit, clock });
    const incident = recorder.begin(incidentInput({ callId: "+15555550101" }));
    expect(incident.valid).toBe(false);
    await expect(recorder.recordValidated(incident)).resolves.toMatchObject({ recorded: false, reasonCode: "SAFETY_EVENT_CALL_INVALID" });
    expect(recorder.begin(incidentInput({ decision: { route: "NONE", destinationId: null, reasonCode: "NO_SAFETY_SIGNAL" } })).invalidReason).toBe("SAFETY_EVENT_ROUTE_NOT_RECORDABLE");
    expect(recorder.begin(incidentInput({ signals: [{ ...signal, ruleId: "the caller said something" }] })).invalidReason).toBe("SAFETY_EVENT_SIGNAL_INVALID");
  });

  it("[SAFE-01] clinical-boundary routes are recorded without safety signals", async () => {
    const recorder = new SafetyEventRecorder({ db, audit, clock });
    const r = await recorder.recordValidated(
      recorder.begin(incidentInput({ signals: [], clinicalCategories: ["MEDICATION"], decision: { route: "CLINICAL_BOUNDARY_ROUTE", destinationId: "dst_clinical_route", reasonCode: "CLINICAL_BOUNDARY_MEDICATION" } })),
    );
    expect(r.recorded).toBe(true);
    const [row] = await rows();
    expect(row).toMatchObject({ route: "CLINICAL_BOUNDARY_ROUTE", clinical_categories: ["MEDICATION"], signal_sources: [], strongest_strength: null });
  });

  it("[DATA-01] safety events, audit inputs and logs contain no caller text", async () => {
    const { logger, records } = createMemoryLogger();
    const recorder = new SafetyEventRecorder({ db, audit, clock, logger });
    const text = "This is Zqxsyntheticname, my number is 555-0101, and I want to kill myself tonight.";
    const evaluation = new SafetyPipeline().evaluate({ text, locale: "en-US", asrConfidence: 0.3 }, { afterHours: true, safetyModeActive: false });
    const incident = recorder.begin({ ...incidentInput({ signals: evaluation.signals, decision: evaluation.decision, afterHours: true }) });
    await recorder.recordValidated(incident);
    await recorder.recordRouteInitiated(incident, { transferId: TRANSFER_ID });
    await recorder.recordOutcome(incident, { outcome: "IN_PROGRESS", transferId: TRANSFER_ID });
    const blob = JSON.stringify({ rows: await rows(), audit: audit.inputs, records });
    for (const fragment of ["Zqxsyntheticname", "555-0101", "my number", "tonight", "kill myself"]) expect(blob.toLowerCase()).not.toContain(fragment.toLowerCase());
  });
});

describe("migration 0610 safety_events", () => {
  const insertSql = `insert into safety_events (event_id, incident_id, tenant_id, call_id, session_generation, phase, signal_sources, rule_ids,
      clinical_categories, strongest_strength, any_third_party, any_historical, any_negated, route, destination_id, reason_code, locale,
      locale_supported, after_hours, detected_at, route_initiated_at, latency_ms, target_ms, within_target, transfer_id, outcome, audit_status, recorded_at)
    values ($1, 'sin_synthIncident0000001', $2, $3, 0, $4, $5::text[], $6::text[], '{}', 'CREDIBLE', false, false, false, $7, 'dst_safety_priority', $8,
      'en-US', true, false, '2026-10-17T15:00:00Z', $9::timestamptz, $10, 2000, $11, $12, $13, 'AUDIT_UNAVAILABLE', '2026-10-17T15:00:01Z')`;
  const base = ["sev_synthEvent00000000001", TENANT_ID, CALL_ID, "SIGNAL_VALIDATED", ["EXPLICIT_PHRASE"], ["explicit.en.self_kill"], "SAFETY_PRIORITY_HUMAN", "SAFETY_SIGNAL_CREDIBLE", null, null, null, null, null];
  const insertAs = (params: unknown[], tenant = TENANT_ID) => db.tx((tx) => tx.query(insertSql, params), { role: "app_runtime", rls: { tenantId: tenant } });
  const withParam = (i: number, v: unknown) => base.map((x, j) => (j === i ? v : x));

  it("[DATA-01] check constraints reject free text in every code column", async () => {
    await expect(insertAs(base)).resolves.toBeDefined();
    await expect(insertAs(withParam(0, "sev_synthEvent00000000002").map((x, j) => (j === 5 ? ["i want to kill myself"] : x)))).rejects.toThrow();
    await expect(insertAs(withParam(0, "sev_synthEvent00000000003").map((x, j) => (j === 7 ? "Caller said they are not safe" : x)))).rejects.toThrow();
    await expect(insertAs(withParam(0, "sev_synthEvent00000000004").map((x, j) => (j === 4 ? ["FREE_TEXT"] : x)))).rejects.toThrow();
    await expect(insertAs(withParam(0, "sev_synthEvent00000000005").map((x, j) => (j === 2 ? "+15555550101" : x)))).rejects.toThrow();
    await expect(insertAs(withParam(0, "sev_synthEvent00000000006").map((x, j) => (j === 6 ? "NONE" : x)))).rejects.toThrow();
  });

  it("[SPEC-10.latency] latency must match the recorded timestamps and the target flag must be consistent", async () => {
    const initiated = (id: string, latency: number, within: boolean) =>
      base.map((x, j) => (j === 0 ? id : j === 3 ? "ROUTE_INITIATED" : j === 8 ? "2026-10-17T15:00:01.500Z" : j === 9 ? latency : j === 10 ? within : x));
    await expect(insertAs(initiated("sev_synthEvent00000000010", 1500, true))).resolves.toBeDefined();
    await expect(insertAs(initiated("sev_synthEvent00000000011", 200, true))).rejects.toThrow();
    await expect(insertAs(initiated("sev_synthEvent00000000012", 1500, false))).rejects.toThrow();
  });

  it("[SAFE-04] an OUTCOME of TRANSFERRED requires a transfer id", async () => {
    const outcome = (id: string, transfer: string | null) => base.map((x, j) => (j === 0 ? id : j === 3 ? "OUTCOME" : j === 11 ? transfer : j === 12 ? "TRANSFERRED" : x));
    await expect(insertAs(outcome("sev_synthEvent00000000020", null))).rejects.toThrow();
    await expect(insertAs(outcome("sev_synthEvent00000000021", TRANSFER_ID))).resolves.toBeDefined();
  });

  it("[OPS-01] safety_events is append-only for every role, including the owner", async () => {
    await insertAs(base);
    await expect(db.tx((tx) => tx.query("update safety_events set reason_code = 'X_CHANGED'"), { role: "app_runtime", rls: { tenantId: TENANT_ID } })).rejects.toThrow();
    await expect(db.tx((tx) => tx.query("delete from safety_events"), { role: "app_runtime", rls: { tenantId: TENANT_ID } })).rejects.toThrow();
    await expect(db.tx((tx) => tx.query("update safety_events set reason_code = 'X_CHANGED'"), { role: "owner" })).rejects.toThrow(/SAFETY_EVENTS_APPEND_ONLY/);
    await expect(db.tx((tx) => tx.query("delete from safety_events"), { role: "owner" })).rejects.toThrow(/SAFETY_EVENTS_APPEND_ONLY/);
    await expect(db.tx((tx) => tx.exec("truncate safety_events"), { role: "owner" })).rejects.toThrow(/SAFETY_EVENTS_APPEND_ONLY/);
    expect(await rows()).toHaveLength(1);
  });

  it("[AUTH-05] row-level security isolates tenants for runtime and console roles", async () => {
    await insertAs(base);
    const visible = (role: "app_runtime" | "app_console" | "app_auditor", tenant: string) =>
      db.tx(async (tx) => (await tx.query("select event_id from safety_events")).rows.length, { role, rls: { tenantId: tenant } });
    expect(await visible("app_runtime", TENANT_ID)).toBe(1);
    expect(await visible("app_console", TENANT_ID)).toBe(1);
    expect(await visible("app_auditor", OTHER_TENANT_ID)).toBe(0);
    expect(await visible("app_runtime", OTHER_TENANT_ID)).toBe(0);
    await expect(insertAs(withParam(0, "sev_synthEvent00000000030"), OTHER_TENANT_ID)).rejects.toThrow();
    await expect(db.tx((tx) => tx.query(insertSql, withParam(0, "sev_synthEvent00000000031")), { role: "app_console", rls: { tenantId: TENANT_ID } })).rejects.toThrow();
  });
});

describe("integration with the durable audit writer", () => {
  it("[OPS-01] safety audit events pass the real audit writer's strict validation and chain in the same transaction", async () => {
    const full = await createTestDb({ include: /^(0201|0610)_/ });
    try {
      const writer = new PgAuditWriter({ db: full, clock, stream: "safety.synth-1" });
      const recorder = new SafetyEventRecorder({ db: full, audit: writer, clock });
      const incident = recorder.begin(incidentInput());
      expect((await recorder.recordValidated(incident)).auditRecorded).toBe(true);
      clock.advanceMs(800);
      expect((await recorder.recordRouteInitiated(incident, { transferId: TRANSFER_ID })).auditRecorded).toBe(true);
      expect((await recorder.recordOutcome(incident, { outcome: "TRANSFERRED", transferId: TRANSFER_ID })).auditRecorded).toBe(true);
      const events = (await full.tx((tx) => tx.query<{ action: string; sequence: number }>("select action, sequence from audit_outbox order by sequence"), { role: "owner" })).rows;
      expect(events.map((e) => e.action)).toEqual(["safety.signal.validated", "safety.route.initiated", "safety.route.outcome"]);
      const linked = (await full.tx((tx) => tx.query<{ n: number }>("select count(*)::int as n from safety_events s join audit_outbox a on a.event_id = s.audit_event_id"), { role: "owner" })).rows[0];
      expect(linked?.n).toBe(3);
    } finally {
      await full.close();
    }
  });
});
