/**
 * Human routes on the LOCAL FIXTURE composition (SYNTHETIC calls, LOCAL FIXTURE telephony):
 * [SPEC-16.journey-5] an unverified caller asks for a person: warm-transfer state machine driven
 *   by fixture lifecycle events to CALLER_CONFIRMED_CONNECTED; TRANSFERRED only then.
 * [SPEC-16.journey-7] a caller declines recording: the approved alternative (human route) is
 *   offered, policy denies protected tools, and nothing ever claims the call is unrecorded.
 * [SPEC-16.journey-8] an unavailable language is routed to the staffed interpreter destination.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { APPOINTMENTS } from "../../src/fixtures/synthetic-world.js";
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
  // Nothing left over from an earlier test is delivered into this one.
  await h.c.fixtures.telephony.deliverAll();
});

const tel = () => h.c.fixtures.telephony;
const currentAttempt = async (handoffId: string) => {
  const j = await journeyOf(h, handoffId);
  return { journey: j, attempt: j.attempts.find((a) => a.transferId === j.currentTransferId) };
};

/** Claims that a call is not recorded (spec section 6: never say a call is unrecorded while processing continues). */
const UNRECORDED_CLAIM = /\b(not|never|isn't|is not|won't|will not)\s+(be(ing)?\s+)?recorded\b|\bunrecorded\b|\bno recording\b|\brecording (is|has been) (off|stopped|paused)\b/i;

describe("[SPEC-16.journey-5] unverified caller requests a human", () => {
  it("[SPEC-16.journey-5][SAFE-02][SAFE-04][SAFE-05] warm transfer to CALLER_CONFIRMED_CONNECTED through acceptance and bridge; TRANSFERRED only after connection", async () => {
    const call = h.call();
    await call.start();
    expect(await call.authGate()).toBe(false);
    tel().scriptNextTransfer({ outcome: "CONNECTED" });
    const req = await call.human({ reason: "CALLER_REQUESTED_HUMAN", language: "en", issueCategory: null });
    expect(req.status).toBe(200);
    expect(req.body).toMatchObject({ accepted: true, destinationId: "dst_support_general", speechTemplateId: "transfer.in_progress", reasonCode: "HANDOFF_REQUESTED" });
    const handoffId = req.body.handoffId as string;
    const ctx = await call.handoffContext();
    expect(ctx.body).toMatchObject({ destinationId: "dst_support_general", handoffId, priority: "STANDARD" });

    // Dialled exactly once, to the allowlisted queue only.
    const dials = tel().dials.filter((d) => d.callId === call.callId);
    expect(dials).toHaveLength(1);
    expect(dials[0]?.destinationId).toBe("dst_support_general");

    // Step the vendor lifecycle one event at a time: nothing short of caller-confirmed connection is a transfer.
    const seen: string[] = [];
    for (;;) {
      const e = await tel().deliverNext();
      if (!e) break;
      const { journey, attempt } = await currentAttempt(handoffId);
      seen.push(attempt?.state ?? "NONE");
      if (attempt?.state !== "CALLER_CONFIRMED_CONNECTED" && attempt?.state !== "COMPLETED") {
        expect(journey.status, `after ${e.state}`).toBe("ROUTING");
        expect(journey.connectedAt).toBeNull();
      }
    }
    // REQUESTED is the dial itself (no lifecycle event); then the vendor's acceptance chain.
    expect(seen).toEqual(["REQUESTED", "QUEUED", "RECEIVER_ACCEPTED", "BRIDGED", "CALLER_CONFIRMED_CONNECTED"]);
    const { journey } = await currentAttempt(handoffId);
    expect(journey.status).toBe("CONNECTED");
    expect(journey.connectedAt).not.toBeNull();

    const end = await call.end("TRANSFERRED");
    expect(end).toEqual({ ended: true, outcome: "TRANSFERRED", reasonCode: "CALLER_CONFIRMED_CONNECTED" });
    const events = await h.auditFor(call.callId);
    const states = events.filter((e) => e.action === "transfer.state_changed").map((e) => e.reasonCode);
    expect(states.length).toBeGreaterThanOrEqual(4);
    expect(events.some((e) => e.action === "handoff.requested" && e.evidencePointers.includes("db://destinations/dst_support_general"))).toBe(true);
    await h.expectAuditChainIntact();
  }, 120_000);

  it("[SPEC-16.journey-5][SAFE-04][ACT-04] the call ends before the receiver bridges: Studio's TRANSFERRED claim is not trusted; no TRANSFERRED outcome", async () => {
    const call = h.call();
    await call.start();
    tel().scriptNextTransfer({ outcome: "STALLED", after: "RECEIVER_ACCEPTED" });
    // The conversational layer's MCP tool (session A0) requests the person; the handoff index sees it (TC-12).
    const r = await call.tool("request_human_transfer", { reason: "CALLER_REQUESTED_HUMAN", language: "en", issueCategory: null, accommodations: [] });
    expect(r.status).toBe("SUCCESS");
    expect((r.data?.handoff as { status: string }).status).toBe("TRANSFER_REQUESTED");
    const ctx = await call.handoffContext();
    expect(ctx.body.destinationId).toBe("dst_support_general");
    expect(ctx.body.handoffId).toMatch(/^hnd_/);
    await h.runWorker(["telephony.local_fixture_delivery"]);
    const { journey, attempt } = await currentAttempt(ctx.body.handoffId as string);
    expect(attempt?.state).toBe("RECEIVER_ACCEPTED");
    expect(journey.connectedAt).toBeNull();
    const end = await call.end("TRANSFERRED");
    expect(end.ended).toBe(true);
    expect(end.outcome).not.toBe("TRANSFERRED");
    expect(end.outcome).toBe("OUTCOME_UNKNOWN");
  }, 60_000);
});

describe("[SPEC-16.journey-5] call-end outcomes and session-less handoffs", () => {
  it("[ACT-04] a hang-up with no other server-side evidence is CALLER_DISCONNECTED, never RESOLVED", async () => {
    const call = h.call();
    await call.start();
    expect(await call.end("CALLER_HANGUP")).toEqual({ ended: true, outcome: "CALLER_DISCONNECTED", reasonCode: "CALLER_DISCONNECTED" });
    const rows = await h.q<{ outcome: string; evidence: { commitReceiptIds: string[]; requestAccepted: boolean; transferConnected: boolean } }>("select outcome, evidence from interaction_outcomes where call_id = $1", [call.callId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.evidence).toMatchObject({ commitReceiptIds: [], requestAccepted: false, transferConnected: false });
  }, 60_000);

  it("[SAFE-02][SPEC-10.transfer] an MCP human request with NO session (trusted call id only) routes and is indexed for the call's handoff context", async () => {
    const call = h.call();
    tel().scriptNextTransfer({ outcome: "CONNECTED" });
    // No TC-01: the conversational layer only has the trusted interaction id.
    const r = await call.tool("request_human_transfer", { reason: "CALLER_REQUESTED_HUMAN", language: "en", issueCategory: null, accommodations: [] });
    expect(r.status).toBe("SUCCESS");
    expect(r.sessionGeneration).toBe(0);
    const indexed = h.c.handoffs.latest(call.callId);
    expect(indexed).toMatchObject({ destinationId: "dst_support_general", priority: "STANDARD" });
    expect(indexed?.handoffId).toMatch(/^hnd_/);
    expect(tel().dials.filter((d) => d.callId === call.callId)).toHaveLength(1);
    await h.runWorker(["telephony.local_fixture_delivery"]);
    expect((await journeyOf(h, indexed?.handoffId as string)).status).toBe("CONNECTED");
  }, 60_000);
});

describe("[SPEC-16.journey-7] caller declines recording", () => {
  it("[SPEC-16.journey-7][DATA-03][SAFE-02] declined recording: approved alternative route, protected tools denied by policy, no 'unrecorded' claim anywhere", async () => {
    const call = h.call();
    call.studioPlays("recording.consent_question");
    await call.start("DECLINED");
    call.studioPlays("recording.decline_alternative");
    await call.role("client");

    // Policy refuses the automated protected path (verification and protected reads) and requires a person.
    const linksBefore = h.c.identity.notifications.sent.length;
    const vv = await call.verify(AVERY, "avery.synthetic");
    expect(vv.bound).toBe(false);
    expect(vv.begin).toMatchObject({ status: "POLICY_DENIED", reasonCode: "CONSENT_DECLINED_ALTERNATIVE_ROUTE", speech: null });
    expect(h.c.identity.notifications.sent.length).toBe(linksBefore);
    const read = await call.tool("get_appointment_options", { appointmentId: APPOINTMENTS[0].appointmentId, fromDate: "2026-10-20", toDate: "2026-10-31" });
    expect(read.status).toBe("POLICY_DENIED");
    expect(read.data ?? null).toBeNull();
    const events = await h.auditFor(call.callId);
    const denial = events.find((e) => e.action === "tool.invoke" && e.outcome === "DENIED" && e.evidencePointers.includes("db://tool_catalog/begin_verification/1.0.0"));
    expect(denial?.policyDecision?.reasonCodes).toContain("CONSENT_DECLINED_ALTERNATIVE_ROUTE");

    // The human route is offered and works without the automated path.
    tel().scriptNextTransfer({ outcome: "CONNECTED" });
    const req = await call.human({ reason: "CONSENT_DECLINED_ALTERNATIVE", language: "en", issueCategory: null });
    expect(req.body).toMatchObject({ accepted: true, destinationId: "dst_support_general" });
    await h.runWorker(["telephony.local_fixture_delivery"]);
    const end = await call.end("TRANSFERRED");
    expect(end.outcome).toBe("TRANSFERRED");

    // No caller-facing utterance, and no approved template at all, says the call is unrecorded.
    expect(call.heard.map((x) => x.templateId)).toEqual(expect.arrayContaining(["recording.consent_question", "recording.decline_alternative", "transfer.in_progress"]));
    for (const u of call.utterances()) expect(UNRECORDED_CLAIM.test(u), u).toBe(false);
    for (const t of h.c.templates.list()) expect(UNRECORDED_CLAIM.test(t.text), t.templateId).toBe(false);
    const consent = events.find((e) => e.action === "session.started");
    expect(consent).toBeDefined();
  }, 120_000);
});

describe("[SPEC-16.journey-8] unavailable language routed to an interpreter", () => {
  it("[SPEC-16.journey-8][SAFE-05] an unsupported language goes to the staffed interpreter destination with the interpreter accommodation", async () => {
    const call = h.call();
    await call.start();
    const screened = await call.screen("Preciso de ajuda com a minha consulta", "pt-BR");
    expect(screened.status).toBe(200);
    expect(screened.body.route).toBe("NONE");
    tel().scriptNextTransfer({ outcome: "CONNECTED" });
    const req = await call.human({ reason: "UNSUPPORTED_LANGUAGE", language: "pt", issueCategory: null });
    expect(req.body).toMatchObject({ accepted: true, destinationId: "dst_interpreter", speechTemplateId: "language.interpreter_route" });
    const dials = tel().dials.filter((d) => d.callId === call.callId);
    expect(dials.map((d) => d.destinationId)).toEqual(["dst_interpreter"]);
    await h.runWorker(["telephony.local_fixture_delivery"]);
    const { journey } = await currentAttempt(req.body.handoffId as string);
    expect(journey.status).toBe("CONNECTED");
    expect(journey.reason).toBe("UNSUPPORTED_LANGUAGE");
    const end = await call.end("TRANSFERRED");
    expect(end.outcome).toBe("TRANSFERRED");
    const events = await h.auditFor(call.callId);
    expect(events.some((e) => e.action === "handoff.requested" && e.evidencePointers.includes("db://destinations/dst_interpreter"))).toBe(true);
    expect(call.heard.map((x) => x.templateId)).toContain("language.interpreter_route");
  }, 60_000);
});
