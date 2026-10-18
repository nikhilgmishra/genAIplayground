/**
 * [SPEC-16.journey-6] Safety handoff WITHOUT authentication, end to end on the LOCAL FIXTURE
 * composition (SYNTHETIC call, LOCAL FIXTURE telephony):
 * utterance screening at A0 -> deterministic safety route -> the acknowledgment from the
 * clinician-owned template (PENDING_CLINICAL_APPROVAL: rendered only because local/ci permits
 * unapproved templates with a badge) -> priority transfer -> primary receiver unavailable ->
 * approved update + backup safety destination -> caller-confirmed connection -> TRANSFERRED.
 * Time to route is recorded (journey timing and safety_events); authentication is never
 * requested. A second case shows the safety route invalidating a verified caller's pending
 * mutation before any commit.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { APPOINTMENTS, STAFF } from "../../src/fixtures/synthetic-world.js";
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

describe("[SPEC-16.journey-6] safety handoff without authentication", () => {
  it("[SPEC-16.journey-6][SAFE-02][SAFE-03][SAFE-04][SAFE-05] A0 screening -> safety route -> receiver unavailable -> backup -> connected; time to route recorded; no authentication requested", async () => {
    const call = h.call();
    await call.start();
    const notificationsBefore = h.c.identity.notifications.sent.length;
    tel().scriptDestination("dst_safety_priority", { outcome: "RECEIVER_UNAVAILABLE" });
    tel().scriptDestination("dst_safety_backup", { outcome: "CONNECTED" });

    const screened = await call.screen("I don't want to live anymore");
    expect(screened.status).toBe(200);
    expect(screened.body).toMatchObject({ route: "SAFETY_PRIORITY_HUMAN", destinationId: "dst_safety_priority", speechTemplateId: "safety.acknowledgment" });
    const handoffId = screened.body.handoffId as string;
    expect(handoffId).toMatch(/^hnd_/);
    expect(screened.body.transferId).toMatch(/^xfr_/);

    // The acknowledgment is the clinician-owned template, still pending clinical approval (never claimed approved).
    const ack = h.c.templates.get("safety.acknowledgment", "en-US");
    expect(ack?.approval.status).toBe("PENDING_CLINICAL_APPROVAL");
    expect(call.heard.find((x) => x.templateId === "safety.acknowledgment")?.utterance).toBe(ack?.text);

    // The session is escalated; Studio's trusted handoff context is the SAFETY destination.
    const ctx = await call.handoffContext();
    expect(ctx.body).toMatchObject({ priority: "SAFETY", handoffId });
    expect(await call.authGate()).toBe(false);

    // Primary receiver unavailable -> approved update -> backup safety destination -> connected.
    await h.runWorker(["telephony.local_fixture_delivery"]);
    await h.runWorker(["telephony.local_fixture_delivery"]);
    const j = await journeyOf(h, handoffId);
    expect(j.priority).toBe("SAFETY");
    expect(j.status).toBe("CONNECTED");
    expect(j.attempts.map((a) => [a.destinationId, a.state])).toEqual([
      ["dst_safety_priority", "RECEIVER_UNAVAILABLE"],
      ["dst_safety_backup", "CALLER_CONFIRMED_CONNECTED"],
    ]);
    expect(tel().updates.filter((u) => u.callId === call.callId).map((u) => u.templateId)).toContain("transfer.safety_update");
    expect(tel().dials.filter((d) => d.callId === call.callId).map((d) => [d.destinationId, d.priority])).toEqual([
      ["dst_safety_priority", "SAFETY"],
      ["dst_safety_backup", "SAFETY"],
    ]);

    // Time to route: journey timing and the durable safety_events record (engineering target 2 s).
    expect(j.safety).toMatchObject({ withinTarget: true });
    expect(typeof j.safety?.timeToRouteInitiationMs).toBe("number");
    const rows = await h.q<{ phase: string; latency_ms: number | null; within_target: boolean | null; destination_id: string; route: string; session_generation: number }>(
      "select phase, latency_ms, within_target, destination_id, route, session_generation from safety_events where call_id = $1 order by recorded_at, phase",
      [call.callId],
    );
    expect(rows.map((r) => r.phase).sort()).toEqual(["ROUTE_INITIATED", "SIGNAL_VALIDATED"]);
    const initiated = rows.find((r) => r.phase === "ROUTE_INITIATED");
    expect(initiated).toMatchObject({ within_target: true, destination_id: "dst_safety_priority", route: "SAFETY_PRIORITY_HUMAN" });
    expect(initiated?.latency_ms).toBeGreaterThanOrEqual(0);
    expect(h.c.metrics.find("vsp_safety_time_to_routing_ms").length).toBeGreaterThan(0);

    // The safety owner queue gets a RESTRICTED support record (never a broadly visible Case).
    const srs = await h.c.business.supportRequests.listForCall(h.c.config.tenantId, call.callId);
    expect(srs.find((r) => r.issueCategory === "safety_concern")).toMatchObject({ restricted: true, priority: "P1_SAFETY", ownerQueue: "q_safety_responders", subjectRef: null });

    // Authentication was never requested: no verification message, no verification step, no protected tool.
    expect(h.c.identity.notifications.sent.length).toBe(notificationsBefore);
    const events = await h.auditFor(call.callId);
    expect(events.some((e) => e.action.startsWith("verification."))).toBe(false);
    expect(events.map((e) => e.action)).toEqual(expect.arrayContaining(["safety.signal", "safety.route_initiated", "handoff.safety_requested", "transfer.safety_route_initiated"]));
    expect(JSON.stringify(events)).not.toContain("live anymore");

    // Console: the safety responder sees the incident with its time to route (content-free).
    const view = await h.consoleRequest(STAFF.safety, "GET", "/console/api/v1/safety-events");
    expect(view.status).toBe(200);
    const incident = (view.body.events as { callId: string; latencyMs: number | null; withinTarget: boolean | null; signalSources: string[] }[]).find((e) => e.callId === call.callId);
    expect(incident).toMatchObject({ withinTarget: true, signalSources: ["EXPLICIT_PHRASE"] });
    expect(JSON.stringify(view.body)).not.toContain("live anymore");

    const end = await call.end("TRANSFERRED");
    expect(end).toEqual({ ended: true, outcome: "TRANSFERRED", reasonCode: "CALLER_CONFIRMED_CONNECTED" });
    await h.expectAuditChainIntact();
  }, 120_000);

  it("[SPEC-16.journey-6][SPEC-10.safety][ACT-01] a safety signal mid-transaction invalidates the pending mutation before the route; the stale confirmation and commit are refused", async () => {
    const call = h.call();
    await call.start();
    await call.role("client");
    expect((await call.verify(AVERY, "avery.synthetic")).bound).toBe(true);
    const opts = await call.tool("get_appointment_options", { appointmentId: APPOINTMENTS[0].appointmentId, fromDate: "2026-10-20", toDate: "2026-10-31" });
    const slot = ((opts.data?.appointments as { slotId: string | null; startsAt: string; status: string }[]) ?? []).find((a) => a.status === "OPEN");
    const prep = await call.tool("prepare_appointment_change", { appointmentId: APPOINTMENTS[0].appointmentId, startsAt: slot?.startsAt, modality: null, slotId: slot?.slotId });
    expect(prep.status).toBe("SUCCESS");
    const change = prep.data?.change as { actionId: string; actionDigest: string };
    const pending = await call.pending();
    expect(pending.status).toBe(200);

    tel().scriptNextTransfer({ outcome: "CONNECTED" });
    const screened = await call.screen("i want to kill myself");
    expect(screened.body.route).toBe("SAFETY_PRIORITY_HUMAN");
    const [row] = await h.q<{ state: string; state_reason: string | null }>("select state, state_reason from action_ledger where action_id = $1", [change.actionId]);
    expect(row?.state).toBe("INVALIDATED");
    expect(row?.state_reason).toBe("SAFETY_ESCALATION");

    const stale = await call.confirm(pending.body);
    expect(stale.status === 409 || stale.body.state === "INVALIDATED").toBe(true);
    const commit = await call.tool("commit_appointment_change", { actionId: change.actionId, digest: change.actionDigest });
    expect(commit.status).not.toBe("SUCCESS");
    expect(h.c.fixtures.scheduling.effects.filter((e) => JSON.stringify(e).includes(APPOINTMENTS[0].appointmentId))).toHaveLength(0);
    await h.runWorker(["telephony.local_fixture_delivery"]);
    expect((await journeyOf(h, screened.body.handoffId as string)).status).toBe("CONNECTED");
    expect((await call.end("TRANSFERRED")).outcome).toBe("TRANSFERRED");
  }, 120_000);
});
