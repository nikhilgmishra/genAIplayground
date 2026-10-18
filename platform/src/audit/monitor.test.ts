/**
 * OPS-AUD-01: the running system verifies audit integrity, monitors ingestion and reconciles
 * committed actions against their audit evidence (worker loop `audit.verify`), and emits the
 * metrics the audit alarms read. LOCAL FIXTURE composition (journey harness, PGlite, local
 * file sink); SYNTHETIC data. The insider is modelled as the DB owner with triggers disabled.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APPOINTMENTS } from "../fixtures/synthetic-world.js";
import { AVERY, createJourneyHarness } from "../../test/journeys/harness.js";
import type { JourneyHarness, ToolResultView } from "../../test/journeys/harness.js";
import type { InMemoryMetrics } from "../observability/metrics.js";
import { AuditCompletenessMonitor, sourceComponentForStream } from "./monitor.js";

let h: JourneyHarness;
let actionId = "";

type Option = { slotId: string | null; startsAt: string; status: string };
const options = (r: ToolResultView): Option[] => ((r.data?.appointments as Option[]) ?? []).filter((a) => a.status === "OPEN");

beforeAll(async () => {
  h = await createJourneyHarness();
  // One real consequential commit through the gateway (SYNTHETIC Avery reschedules).
  const call = h.call();
  await call.start();
  await call.role("client");
  expect((await call.verify(AVERY, "avery.synthetic")).bound).toBe(true);
  const appt = APPOINTMENTS[0].appointmentId;
  const opts = await call.tool("get_appointment_options", { appointmentId: appt, fromDate: "2026-10-20", toDate: "2026-10-31" });
  const choice = options(opts)[1] as Option;
  const prep = await call.tool("prepare_appointment_change", { appointmentId: appt, startsAt: choice.startsAt, modality: null });
  const change = prep.data?.change as { actionId: string; actionDigest: string };
  await call.confirmPending();
  const committed = await call.tool("commit_appointment_change", { actionId: change.actionId, digest: change.actionDigest });
  expect(committed.data).toMatchObject({ committed: true, commitOutcome: "COMMITTED" });
  actionId = change.actionId;
}, 180_000);
afterAll(async () => {
  await h?.close();
});

const verify = async () => {
  const loop = h.loops.get("audit.verify");
  if (!loop) throw new Error("audit.verify loop not composed");
  return loop.runOnce();
};
const ship = () => h.runWorker(["audit.ship"]);
const metrics = () => h.c.metrics as InMemoryMetrics;
const unlabelled = (name: string) => metrics().find(name).filter((s) => Object.keys(s.labels).length === 0);
const asInsider = (sql: string, params: unknown[] = []) =>
  h.c.db.tx(
    async (tx) => {
      await tx.query("set local session_replication_role = replica");
      await tx.query(sql, params);
    },
    { role: "owner" },
  );

describe("audit completeness monitoring (OPS-AUD-01)", () => {
  it("[OPS-01][SPEC-13.audit][OPS-AUD-01] the worker composes audit.verify; a clean system is PASS with heartbeat metrics (gaps 0, completeness 1, backlog 0)", async () => {
    await ship();
    const before = metrics().find("vsp_audit_ingestion_gaps_total").length;
    const r = await verify();
    expect(r.ok).toBe(true);
    expect(r.details).toMatchObject({ verdict: "PASS", integrityFindings: 0, ingestionGaps: 0, reconciliationDiscrepancies: 0, backlog: 0 });
    expect(Number(r.details.committedActionsChecked)).toBeGreaterThanOrEqual(1);
    expect(r.processed).toBeGreaterThan(1);
    // Heartbeat: the critical alarm's metric has data even with nothing wrong (missing data = breaching).
    expect(metrics().find("vsp_audit_ingestion_gaps_total").length).toBeGreaterThanOrEqual(Math.max(before, 2));
    expect(unlabelled("vsp_audit_ingestion_gaps_total")).toHaveLength(1);
    expect(metrics().counterValue("vsp_audit_ingestion_gaps_total", { source_component: "actions" })).toBe(0);
    expect(unlabelled("vsp_audit_export_completeness_ratio")[0]?.value).toBe(1);
    expect(metrics().gaugeValue("vsp_audit_export_completeness_ratio", { source_component: "actions" })).toBe(1);
    expect(metrics().gaugeValue("vsp_audit_backlog_events")).toBe(0);
  }, 120_000);

  it("[OPS-01][SPEC-13.audit][OPS-AUD-01] unshipped events past the export grace lower completeness and raise SINK_INGESTION_LAG until shipped", async () => {
    const call = h.call();
    await call.start(); // new audit events (session.started) that are not shipped yet
    h.clock.advanceSeconds(h.c.config.audit.maxBacklogAgeSeconds + 60);
    const lag = await verify();
    expect(lag.details.verdict).toBe("FAIL");
    expect(Number(lag.details.ingestionGaps)).toBeGreaterThan(0);
    expect(unlabelled("vsp_audit_export_completeness_ratio")[0]?.value).toBeLessThan(1);
    expect(Number(metrics().gaugeValue("vsp_audit_backlog_events"))).toBeGreaterThan(0);
    await ship();
    expect((await verify()).details.verdict).toBe("PASS");
  }, 120_000);

  it("[OPS-03][OPS-AUD-01] without a sink reader shipped integrity is not verified and the verdict is never PASS", async () => {
    const m = new AuditCompletenessMonitor({ db: h.c.db, sink: null, clock: h.c.clock, metrics: h.c.metrics, tenantIds: h.c.tenantIds });
    const r = await m.runOnce();
    expect(r.verdict).toBe("INCONCLUSIVE");
    expect(r.reasonCodes).toContain("SHIPPED_INTEGRITY_NOT_VERIFIED");
  }, 60_000);

  it("[OPS-01][SPEC-13.audit][OPS-AUD-01] a committed action's audit evidence deleted out of band is detected: reconciliation, sequence gap and the alarm metric", async () => {
    const gapsBefore = unlabelled("vsp_audit_ingestion_gaps_total")[0]?.value ?? 0;
    const receipt = await h.q<{ id: string }>("select receipt ->> 'auditEventId' as id from action_ledger where action_id = $1 and state = 'COMMITTED'", [actionId]);
    const eventId = receipt[0]?.id;
    expect(eventId).toMatch(/^aud_|^[a-z]{2,12}_/);
    await asInsider("delete from audit_outbox where event_id = $1", [eventId]);
    const r = await verify();
    expect(r.ok).toBe(true); // the loop ran; the finding is reported through verdict and metrics
    expect(r.details.verdict).toBe("FAIL");
    expect(Number(r.details.reconciliationDiscrepancies)).toBeGreaterThanOrEqual(1);
    expect(Number(r.details.integrityFindings)).toBeGreaterThanOrEqual(1);
    expect(metrics().counterValue("vsp_audit_ingestion_gaps_total", { source_component: "actions" })).toBeGreaterThan(0);
    expect(unlabelled("vsp_audit_ingestion_gaps_total")[0]?.value ?? 0).toBeGreaterThan(gapsBefore);
  }, 120_000);

  it("[OPS-AUD-01] stream names map to closed source-component labels", () => {
    expect(sourceComponentForStream("runtime")).toBe("gateway");
    expect(sourceComponentForStream("actions")).toBe("actions");
    expect(sourceComponentForStream("console")).toBe("console");
    expect(sourceComponentForStream("gateway.instance-1")).toBe("gateway");
    expect(sourceComponentForStream("something-else")).toBe("worker");
  });
});
