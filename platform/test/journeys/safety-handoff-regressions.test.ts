/**
 * Regression journeys for the safety-handoff review findings, end to end on the LOCAL FIXTURE
 * composition (full container, REAL business module, real HTTP and MCP surfaces, worker loops,
 * FakeClock; SYNTHETIC people and calls; LOCAL FIXTURE telephony, Salesforce and staff IdP):
 *  - SAFE-HANDOFF-01: a bridge drop after caller-confirmed connection re-enters the fallback chain;
 *  - SAFE-HANDOFF-02: the safety route supersedes STANDARD journeys of the call;
 *  - SAFE-HANDOFF-05: a staff-raised safety escalation (console) takes the full safety path;
 *  - SAFE-HANDOFF-07: a model-raised request_safety_route writes safety evidence;
 *  - DP-01: clinical-question / privacy-concern handoff records are restricted and minimized.
 * Nothing here is Talkdesk, Salesforce or production evidence.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { APPOINTMENTS, STAFF } from "../../src/fixtures/synthetic-world.js";
import { RESTRICTED_CASE_SUMMARY } from "../../src/business/support/support-request-service.js";
import { AVERY, createJourneyHarness, journeyOf } from "./harness.js";
import type { JourneyHarness } from "./harness.js";

let h: JourneyHarness;
beforeAll(async () => {
  h = await createJourneyHarness({ ingestKnowledge: false });
}, 180_000);
afterAll(async () => {
  await h?.close();
});
beforeEach(async () => {
  await h.c.fixtures.telephony.deliverAll();
});

const tel = () => h.c.fixtures.telephony;
const dialsFor = (callId: string) => tel().dials.filter((d) => d.callId === callId);

describe("safety handoff regressions (LOCAL FIXTURE composition)", () => {
  it("[SAFE-03][SAFE-04][SAFE-HANDOFF-01] a safety bridge drop after CALLER_CONFIRMED_CONNECTED re-dials: the stalled backup is timed out by the sweep and the caller is re-routed", async () => {
    const call = h.call();
    await call.start();
    tel().scriptDestination("dst_safety_priority", { outcome: "BRIDGE_DROPPED", after: "CALLER_CONFIRMED_CONNECTED" });
    tel().scriptDestination("dst_safety_backup", { outcome: "STALLED", after: "REQUESTED" });
    tel().scriptDestination("dst_outage_continuity", { outcome: "STALLED", after: "REQUESTED" });
    const s = await call.screen("I don't want to live anymore");
    const handoffId = s.body.handoffId as string;
    for (let i = 0; i < 4; i++) await h.runWorker(["telephony.local_fixture_delivery"]);
    const dropped = await journeyOf(h, handoffId);
    expect(dropped.status).toBe("ROUTING");
    expect(dropped.connectedAt).toBeNull();
    expect(dropped.attempts.map((a) => [a.destinationId, a.state])).toEqual([
      ["dst_safety_priority", "BRIDGE_DROPPED"],
      ["dst_safety_backup", "REQUESTED"],
    ]);
    // The model is told the truth: nobody is connected.
    const tool = await call.tool("request_safety_route", { signalSource: "CALLER_REQUEST", concernSubject: "SELF", language: "en-US" });
    expect(tool.data).toMatchObject({ handoff: { status: "TRANSFER_REQUESTED" } });
    const before = dialsFor(call.callId).length;
    for (let i = 0; i < 3; i++) {
      h.clock.advanceMs(31_000);
      await h.runWorker(["transfers.sweep", "telephony.local_fixture_delivery"]);
    }
    expect(dialsFor(call.callId).length - before).toBeGreaterThanOrEqual(2);
    expect(dialsFor(call.callId).slice(before).every((d) => d.priority === "SAFETY")).toBe(true);
    const later = await journeyOf(h, handoffId);
    expect(later.status).toBe("ROUTING");
    expect(later.attempts.some((a) => a.destinationId === "dst_safety_backup" && a.state === "TIMED_OUT")).toBe(true);
    await call.end("CALLER_HANGUP");
  });

  it("[SAFE-03][SAFE-HANDOFF-02] a human request during a safety route never starts a competing STANDARD transfer, before or after the safety responder connects", async () => {
    const call = h.call();
    await call.start();
    tel().scriptDestination("dst_safety_priority", { outcome: "CONNECTED" });
    tel().scriptDestination("dst_support_general", { outcome: "STALLED", after: "QUEUED" });
    tel().scriptDestination("dst_outage_continuity", { outcome: "STALLED", after: "QUEUED" });
    const s = await call.screen("I don't want to live anymore");
    const human = await call.tool("request_human_transfer", { reason: "CALLER_REQUESTED_HUMAN", language: "en-US", issueCategory: null, accommodations: [] });
    expect(human.status).toBe("SUCCESS");
    expect(human.data).toMatchObject({ handoff: { destinationPurpose: "SAFETY_PRIORITY" } });
    for (let i = 0; i < 6; i++) await h.runWorker(["telephony.local_fixture_delivery"]);
    const safety = await journeyOf(h, s.body.handoffId as string);
    expect(safety.status).toBe("CONNECTED");
    // Studio's human request after the responder connected changes nothing either.
    const studio = await call.human({ reason: "CALLER_REQUESTED_HUMAN", language: "en", issueCategory: null });
    expect(studio.body).toMatchObject({ accepted: true, handoffId: s.body.handoffId });
    for (let i = 0; i < 6; i++) {
      h.clock.advanceMs(61_000);
      await h.runWorker(["transfers.sweep", "telephony.local_fixture_delivery"]);
    }
    expect(dialsFor(call.callId).map((d) => [d.destinationId, d.priority])).toEqual([["dst_safety_priority", "SAFETY"]]);
    expect(tel().updates.filter((u) => u.callId === call.callId)).toHaveLength(0);
    expect((await call.handoffContext()).body).toMatchObject({ priority: "SAFETY", destinationId: "dst_safety_priority" });
    await call.end("TRANSFERRED");
  });

  it("[SAFE-03][SAFE-HANDOFF-02] a safety signal after a clinical-boundary handoff supersedes the STANDARD journey: no further STANDARD dials or update prompts", async () => {
    const call = h.call();
    await call.start();
    tel().scriptDestination("dst_clinical_route", { outcome: "STALLED", after: "QUEUED" });
    tel().scriptDestination("dst_support_general", { outcome: "STALLED", after: "QUEUED" });
    tel().scriptDestination("dst_safety_priority", { outcome: "CONNECTED" });
    const clinical = await call.screen("Should I increase my sertraline dose?");
    expect(clinical.body.route).toBe("CLINICAL_BOUNDARY_ROUTE");
    const safety = await call.screen("I don't want to live anymore");
    expect(safety.body.route).toBe("SAFETY_PRIORITY_HUMAN");
    for (let i = 0; i < 6; i++) await h.runWorker(["telephony.local_fixture_delivery"]);
    expect((await journeyOf(h, clinical.body.handoffId as string)).status).toBe("SUPERSEDED");
    const dialsAtSafety = dialsFor(call.callId).length;
    for (let i = 0; i < 6; i++) {
      h.clock.advanceMs(61_000);
      await h.runWorker(["transfers.sweep", "telephony.local_fixture_delivery"]);
    }
    expect(dialsFor(call.callId).length).toBe(dialsAtSafety);
    expect(tel().updates.filter((u) => u.callId === call.callId && u.templateId === "transfer.failed_next_route")).toHaveLength(0);
    await call.end("TRANSFERRED");
  });

  it("[SPEC-10.stop-admin-work][SAFE-03][SAFE-HANDOFF-05] a staff safety escalation from the console revokes the confirmed change, flags the session (TC-12 SAFETY) and records the safety incident", async () => {
    // Earlier cases advanced the FakeClock; ship audit so consequential mutations are not blocked by a stale sink.
    await h.runWorker(["audit.ship"], 3);
    const call = h.call();
    await call.start();
    await call.role("client");
    expect((await call.verify(AVERY, "avery.synthetic")).bound).toBe(true);
    const opts = await call.tool("get_appointment_options", { appointmentId: APPOINTMENTS[0].appointmentId, fromDate: "2026-10-20", toDate: "2026-10-31" });
    const slot = ((opts.data?.appointments as { status: string; startsAt: string; slotId: string }[] | undefined) ?? []).find((a) => a.status === "OPEN");
    const prep = await call.tool("prepare_appointment_change", { appointmentId: APPOINTMENTS[0].appointmentId, startsAt: slot?.startsAt, modality: null, slotId: slot?.slotId });
    expect(prep.status, JSON.stringify({ prep: prep.reasonCode, slots: opts.status })).toBe("SUCCESS");
    const change = prep.data?.change as { actionId: string; actionDigest: string };
    await call.confirmPending();
    expect((await h.q<{ state: string }>("select state from action_ledger where action_id = $1", [change.actionId]))[0]?.state).toBe("CONFIRMED");

    const t = await h.consoleRequest(STAFF.safety, "POST", `/console/api/v1/calls/${call.callId}/transfer`, { destinationId: "dst_safety_priority", reason: "SAFETY_PRIORITY" }, "idem_shSafetyEscalation0001");
    expect(t.status).toBe(200);
    expect(t.body).toMatchObject({ destinationId: "dst_safety_priority" });
    expect(["INVALIDATED", "CANCELLED"]).toContain((await h.q<{ state: string }>("select state from action_ledger where action_id = $1", [change.actionId]))[0]?.state);
    expect((await call.handoffContext()).body).toMatchObject({ priority: "SAFETY", destinationId: "dst_safety_priority" });
    const commit = await call.tool("commit_appointment_change", { actionId: change.actionId, digest: change.actionDigest });
    expect(commit.status).not.toBe("SUCCESS");
    expect(h.c.fixtures.scheduling.effects).toHaveLength(0);
    const rows = await h.q<{ phase: string; signal_sources: string[] }>("select phase, signal_sources from safety_events where call_id = $1 order by recorded_at", [call.callId]);
    expect(rows.map((r) => r.phase).sort()).toEqual(["ROUTE_INITIATED", "SIGNAL_VALIDATED"]);
    expect(rows.every((r) => r.signal_sources.includes("HUMAN_INTERVENTION"))).toBe(true);
    const restricted = await h.q<{ restricted: boolean; owner_queue: string; priority: string }>("select restricted, owner_queue, priority from support_requests where call_id = $1", [call.callId]);
    expect(restricted).toContainEqual({ restricted: true, owner_queue: "q_safety_responders", priority: "P1_SAFETY" });
    const audit = (await h.auditFor(call.callId)).find((e) => e.action === "handoff.safety_requested");
    expect(audit).toMatchObject({ sourceComponent: "console", actorRef: STAFF.safety.staffId });
    await call.end("TRANSFERRED");
  });

  it("[SPEC-13.metrics][SAFE-03][SAFE-HANDOFF-07] a model-raised request_safety_route (MCP) writes safety_events, the time-to-routing metric and the console safety-event entry", async () => {
    const call = h.call();
    await call.start();
    const before = h.c.metrics.observations("vsp_safety_time_to_routing_ms").length;
    const r = await call.tool("request_safety_route", { signalSource: "EXPLICIT_PHRASE", concernSubject: "SELF", language: "en-US" });
    expect(r.status).toBe("SUCCESS");
    const rows = await h.q<{ phase: string; route: string; transfer_id: string | null }>("select phase, route, transfer_id from safety_events where call_id = $1", [call.callId]);
    expect(rows.map((x) => x.phase).sort()).toEqual(["ROUTE_INITIATED", "SIGNAL_VALIDATED"]);
    expect(rows.every((x) => x.route === "SAFETY_PRIORITY_HUMAN")).toBe(true);
    expect(rows.find((x) => x.phase === "ROUTE_INITIATED")?.transfer_id).toMatch(/^xfr_/);
    expect(h.c.metrics.observations("vsp_safety_time_to_routing_ms").length - before).toBe(1);
    const view = await h.consoleRequest(STAFF.safety, "GET", "/console/api/v1/safety-events");
    expect(((view.body.events as { callId: string }[] | undefined) ?? []).some((e) => e.callId === call.callId)).toBe(true);
    // Studio screening on another call is recorded exactly once (no double recording).
    const other = h.call();
    await other.start();
    await other.screen("I want to kill myself");
    const otherRows = await h.q<{ phase: string }>("select phase from safety_events where call_id = $1", [other.callId]);
    expect(otherRows.map((x) => x.phase).sort()).toEqual(["ROUTE_INITIATED", "SIGNAL_VALIDATED"]);
    await call.end("CALLER_HANGUP");
    await other.end("CALLER_HANGUP");
  });

  it("[DATA-01][SPEC-8.restricted][DP-01] a verified client's medication question is a restricted, subject-free record synchronized as a minimal RESTRICTED Case; the audit carries no clinical topic", async () => {
    const call = h.call();
    await call.start();
    await call.role("client");
    expect((await call.verify(AVERY, "avery.synthetic")).bound).toBe(true);
    const s = await call.screen("Should I increase my sertraline dose?");
    expect(s.body.route).toBe("CLINICAL_BOUNDARY_ROUTE");
    await h.runWorker(["outbox.dispatch", "outbox.consume"], 3);
    const rows = await h.q<{ reference_number: string; restricted: boolean; subject_ref: string | null; owner_queue: string; sync_state: string }>(
      "select reference_number, restricted, subject_ref, owner_queue, sync_state from support_requests where call_id = $1 and issue_category = 'clinical_question_redirected'",
      [call.callId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ restricted: true, subject_ref: null, owner_queue: "q_clinical_route", sync_state: "SYNCED" });
    const sf = h.c.fixtures.supportRecords.records().cases.find((c) => c.fields.supportReference === rows[0]?.reference_number) as { visibility?: string; fields: { subjectRef: string | null; summary: string; restricted: boolean; attempted: string[] } } | undefined;
    expect(sf?.visibility).toBe("RESTRICTED");
    expect(sf?.fields).toMatchObject({ subjectRef: null, summary: RESTRICTED_CASE_SUMMARY, restricted: true, attempted: [] });
    const clinicalAudit = (await h.auditFor(call.callId)).filter((e) => e.action === "safety.clinical_boundary");
    expect(clinicalAudit.length).toBeGreaterThan(0);
    expect(clinicalAudit.every((e) => e.reasonCode === "CLINICAL_BOUNDARY_ROUTE")).toBe(true);
    await call.end("TRANSFERRED");
  });
});
