/**
 * Business-layer transaction regressions over the REAL modules (PGlite, OPA bundle, action ledger,
 * identity, workflow engine, support memory) with LOCAL SYNTHETIC fixtures (business/testing/harness.ts):
 *   ACT-F2  intake creation key derived from the transport idempotency key (not a minted turn id);
 *   ACT-F3  the operator-retry authority re-establishes the caller's CURRENT authority;
 *   ACT-F4  the commit success view is bound to the authoritative receipt, never a stale re-read;
 *   ACT-F5  every caller-relevant field of the digest-bound change is read back;
 *   DP-03   the repeat-caller recap is reconciled with the system of record before it is spoken.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessionRefHash } from "../actions/digest.js";
import { telephony } from "../identity/identity-harness.fixture.js";
import type { SessionRecord } from "../identity/session-store.js";
import { APPOINTMENTS, INVOICES, PEOPLE, SLOTS, TENANT_ID } from "../fixtures/synthetic-world.js";
import { staffActor } from "../ops/testing.js";
import { policyAuthFromContext, toolPolicyRef } from "../policy/input.js";
import type { AuthContext, PreparedAction } from "../protocol/index.js";
import { newTurnId } from "../shared/ids.js";
import { INTERNAL_CHANGE_FIELDS, READBACK_FIELDS, confirmationSlotsFor } from "./confirmation.js";
import { policyAuthFromSessionRecord } from "./services/operator-retry.js";
import { TOOL_DEFINITIONS } from "../gateway/tools/definitions.js";
import { createBusinessHarness, expectDone, type BusinessHarness } from "./testing/harness.js";

let h: BusinessHarness;
beforeEach(async () => {
  h = await createBusinessHarness();
});
afterEach(async () => {
  await h.close();
});

const APPT = APPOINTMENTS[0];
/** SYNTHETIC extra open slot of Avery's provider, IN PERSON (her appointment is a video visit). */
const IN_PERSON_SLOT = {
  slotId: "slt_synthReviewInPerson01",
  providerActorId: PEOPLE.morgan.actorId,
  providerDisplayName: "Dr. Morgan",
  startsAt: "2026-10-28T17:00:00.000Z",
  timeZone: "America/Chicago",
  modality: "in_person" as const,
  heldBy: null,
};

async function verifiedAvery(callId?: string): Promise<{ sessionRef: string; auth: AuthContext }> {
  const { sessionRef } = await h.startCall(callId);
  return { sessionRef, auth: await h.verify(PEOPLE.avery, sessionRef) };
}

async function prepared(auth: AuthContext, args: Record<string, unknown>): Promise<PreparedAction> {
  const p = expectDone(await h.invoke("prepare_appointment_change", auth, args));
  if (p.outcome.status !== "SUCCESS") throw new Error(`prepare ${p.outcome.status}`);
  const id = (p.outcome.data as { change: { actionId: string } }).change.actionId;
  const action = await h.actions.get(TENANT_ID, id);
  if (!action) throw new Error("ACTION_MISSING");
  return action;
}

const render = (auth: AuthContext, templateId: string, slots: Record<string, string | number | boolean>, locale = "en-US"): string | null => {
  const t = h.deps.templates.get(templateId, "en-US");
  if (!t) return null;
  const r = h.deps.responseGate.render(
    { templateId, templateVersion: t.version, responseClass: t.responseClass, slots, authorizationRef: "pdc_synthDecisionPrimary01", sourceRefs: ["action:act_synthPreparedAction001"], turnId: "turn_synthTurn0001", sessionGeneration: auth.sessionGeneration },
    { sessionRef: "ses_bnd_unbound", currentTurnId: "turn_synthTurn0001", sessionGeneration: auth.sessionGeneration, validAuthorizationRefs: new Set(["pdc_synthDecisionPrimary01"]), locale, environment: "local" },
  );
  return r.ok ? r.utterance : null;
};

describe("[ACT-F5] the trusted readback states every material digest-bound change", () => {
  it("[ACT-01][ACT-F5] a reschedule to an in-person slot reads the visit type back in the prepare speech and the TC-07 slots; the digest binds it", async () => {
    h.fixtures.store.insert("slots", IN_PERSON_SLOT);
    const { auth } = await verifiedAvery();
    const p = expectDone(await h.invoke("prepare_appointment_change", auth, { appointmentId: APPT.appointmentId, startsAt: IN_PERSON_SLOT.startsAt, modality: null, slotId: IN_PERSON_SLOT.slotId }));
    if (p.outcome.status !== "SUCCESS") throw new Error(`prepare ${p.outcome.status}`);
    expect(p.outcome.speech?.slots).toMatchObject({ fromModality: "video", toModality: "in_person" });
    const action = await h.actions.get(TENANT_ID, (p.outcome.data as { change: { actionId: string } }).change.actionId);
    if (!action) throw new Error("ACTION_MISSING");
    expect(action.change).toMatchObject({ fromModality: "video", toModality: "in_person" });
    const slots = await confirmationSlotsFor(h.deps, action);
    expect(slots).toMatchObject({ fromModality: "video", toModality: "in_person" });
    const prompt = render(auth, "appointment.change_confirmation", slots ?? {});
    expect(prompt).toBe("To confirm, I'll move your video appointment from October 22, 2026 at 12:00 PM, Central Time, to October 28, 2026 at 12:00 PM, Central Time, as an in-person visit. Say yes to confirm, or no to keep it.");
    expect(render(auth, "appointment.change_confirmation", slots ?? {}, "es-US")).toMatch(/cita por video .* como una visita en persona\./);
  });

  it("[ACT-01][ACT-F5] every caller-relevant change field the business layer writes is read back (reschedule, new booking with provider, billing review reason)", async () => {
    const { auth } = await verifiedAvery();
    const reschedule = await prepared(auth, { appointmentId: APPT.appointmentId, startsAt: SLOTS[0].startsAt, modality: null });
    const create = await prepared(auth, { appointmentId: null, startsAt: SLOTS[1].startsAt, modality: "video" });
    const review = expectDone(await h.invoke("prepare_billing_review", auth, { invoiceId: INVOICES[0].invoiceId, reasonCategory: "LATE_CANCELLATION_FEE_DISPUTE" }));
    if (review.outcome.status !== "SUCCESS") throw new Error("review prepare failed");
    const billing = await h.actions.get(TENANT_ID, (review.masked as { actionId: string }).actionId);
    if (!billing) throw new Error("ACTION_MISSING");
    for (const action of [reschedule, create, billing]) {
      const readback = READBACK_FIELDS[action.kind] ?? [];
      const internal = INTERNAL_CHANGE_FIELDS[action.kind] ?? [];
      // Nothing in the digest-bound change is unaccounted for, and every read-back field is present.
      expect(Object.keys(action.change).sort(), action.kind).toEqual([...readback, ...internal].sort());
      const slots = await confirmationSlotsFor(h.deps, action);
      expect(slots, action.kind).not.toBeNull();
      const utterance = render(auth, action.confirmationTemplateId, slots ?? {});
      expect(utterance, action.kind).not.toBeNull();
    }
    expect(render(auth, "appointment.create_confirmation", (await confirmationSlotsFor(h.deps, create)) ?? {})).toBe(
      "To confirm, I'll book a video visit with Dr. Morgan on October 26, 2026 at 11:00 AM, Central Time. Say yes to confirm, or no to cancel.",
    );
    expect(render(auth, "billing.review_confirmation", (await confirmationSlotsFor(h.deps, billing)) ?? {})).toMatch(/because you are disputing a late cancellation fee\./);
    if (review.outcome.status === "SUCCESS") expect(review.outcome.speech?.slots).toMatchObject({ reasonCategory: "LATE_CANCELLATION_FEE_DISPUTE" });
    // A change that lacks a material field is never read back partially (null => the gateway routes to a human).
    expect(await confirmationSlotsFor(h.deps, { ...reschedule, change: { ...reschedule.change, toModality: null } })).toBeNull();
    expect(await confirmationSlotsFor(h.deps, { ...create, change: { ...create.change, providerName: null } })).toBeNull();
    expect(await confirmationSlotsFor(h.deps, { ...billing, change: { ...billing.change, reasonCategory: "SOMETHING_ELSE" } })).toBeNull();
  });
});

describe("[ACT-F4] success speech from the authoritative receipt", () => {
  async function confirmedReschedule() {
    const { auth } = await verifiedAvery();
    const action = await prepared(auth, { appointmentId: APPT.appointmentId, startsAt: SLOTS[0].startsAt, modality: null, slotId: SLOTS[0].slotId });
    await h.confirm(auth, action.actionId, action.digest);
    return { auth, action };
  }

  it("[ACT-05][ACT-F4] a stale read after COMMITTED never announces the old time: the receipt-bound new time is spoken", async () => {
    const { auth, action } = await confirmedReschedule();
    // getAppointment #1 = commit resolveResource, #2 = ledger currentVersion, #3 = the post-commit read (stale).
    h.fixtures.faults.inject({ integrationId: "scheduling", operation: "getAppointment", kind: "STALE_READ", skip: 2 });
    const c = expectDone(await h.invoke("commit_appointment_change", auth, { actionId: action.actionId, digest: action.digest }));
    expect(c.outcome.status).toBe("SUCCESS");
    if (c.outcome.status !== "SUCCESS") return;
    expect((await h.fixtures.scheduling.getAppointment(APPT.appointmentId))?.startsAt).toBe(SLOTS[0].startsAt);
    expect((c.outcome.data as { appointments: { startsAt: string }[] }).appointments[0]?.startsAt).toBe(SLOTS[0].startsAt);
    expect(c.outcome.speech?.templateId).toBe("appointment.change_committed");
    expect(c.outcome.speech?.slots).toEqual({ date: "2026-10-23", time: "12:00", timeZone: "America/Chicago" });
    expect(c.outcome.speech?.slots).not.toMatchObject({ date: "2026-10-22" });
  });

  it("[ACT-05][ACT-F4] when neither the re-read nor the prepared change matches the receipt evidence, the result is UNKNOWN (COMMITTED_RECORD_UNREADABLE), never a guessed time", async () => {
    const { auth, action } = await confirmedReschedule();
    const port = h.business.providers["appointment.reschedule"];
    if (!port) throw new Error("PORT_MISSING");
    const realCommit = port.commit.bind(port);
    // LOCAL FIXTURE: the provider reports a commit whose evidence names a different time than the prepared change.
    (port as { commit: typeof realCommit }).commit = async (a, key) => {
      const r = await realCommit(a, key);
      return r.outcome === "COMMITTED" ? { ...r, evidence: { ...r.evidence, startsAt: "2026-10-30T15:00:00.000Z" } } : r;
    };
    h.fixtures.faults.inject({ integrationId: "scheduling", operation: "getAppointment", kind: "STALE_READ", skip: 2 });
    try {
      const c = expectDone(await h.invoke("commit_appointment_change", auth, { actionId: action.actionId, digest: action.digest }));
      expect(c.outcome).toMatchObject({ status: "UNKNOWN_OUTCOME", reasonCode: "COMMITTED_RECORD_UNREADABLE" });
      expect(c.outcome.status === "SUCCESS").toBe(false);
    } finally {
      (port as { commit: typeof realCommit }).commit = realCommit;
    }
  });
});

describe("[ACT-F3] operator-retry authority (current caller authority)", () => {
  it("[ACT-01][ACT-F3] the policy view of the trusted session record equals the caller path's (policyAuthFromContext)", async () => {
    const { sessionRef, auth } = await verifiedAvery();
    const store = (h.deps.sessions as unknown as { store: { load(hash: string): Promise<{ rec: SessionRecord } | null> } }).store;
    const loaded = await store.load(sessionRefHash(sessionRef));
    if (!loaded) throw new Error("SESSION_RECORD_MISSING");
    expect(policyAuthFromSessionRecord(loaded.rec, h.clock.now())).toEqual(policyAuthFromContext(auth));
  });

  it("[ACT-01][AUTH-04][SAFE-02][ACT-F3] a live session allows; writes kill switch denies; a changed, ended or revoked session refuses with a reason code", async () => {
    const { sessionRef, auth } = await verifiedAvery();
    const action = await prepared(auth, { appointmentId: APPT.appointmentId, startsAt: SLOTS[0].startsAt, modality: null });
    const port = h.services.appointments.provider;
    const live = await port.authorizeOperatorRetry(action);
    expect(live.allow).toBe(true);
    expect(live.obligations).not.toContain("REQUIRE_HUMAN");

    await h.ops.killSwitches.set({ tenantId: TENANT_ID, scope: "WRITES", target: "*", engaged: true, reason: "INCIDENT_UNSAFE_OUTPUT", staff: staffActor("supervisor") });
    const killed = await port.authorizeOperatorRetry(action);
    expect(killed.allow).toBe(false);
    expect(killed.reasonCodes).toContain("KILL_SWITCH_WRITES");
    await h.ops.killSwitches.set({ tenantId: TENANT_ID, scope: "WRITES", target: "*", engaged: false, reason: "INCIDENT_RESOLVED", staff: staffActor("supervisor") });

    const reason = (p: Promise<unknown>) => p.then(() => "RESOLVED", (e: { reasonCode?: string }) => e.reasonCode ?? "NO_REASON_CODE");
    // A safety escalation (or any participant / account change) moves the session to a new generation.
    await h.identity.sessions.applyChange(sessionRef, telephony(), { kind: "SAFETY_ESCALATION" });
    expect(await reason(port.authorizeOperatorRetry(action))).toBe("SESSION_GENERATION_CHANGED");

    const second = await verifiedAvery("cal_synthCallRepeat00001");
    const other = await prepared(second.auth, { appointmentId: APPT.appointmentId, startsAt: SLOTS[0].startsAt, modality: null });
    await h.identity.sessions.endCall(second.sessionRef, telephony());
    expect(await reason(port.authorizeOperatorRetry(other))).toBe("SESSION_ENDED");

    const third = await verifiedAvery("cal_synthCallConcurrent1");
    const revokedAction = await prepared(third.auth, { appointmentId: APPT.appointmentId, startsAt: SLOTS[0].startsAt, modality: null });
    await h.identity.sessions.revoke(third.sessionRef, "SESSION_REVOKED_BY_TEST");
    expect(await reason(port.authorizeOperatorRetry(revokedAction))).toBe("SESSION_REVOKED");
  });
});

describe("[ACT-F2] intake creation key", () => {
  it("[ACT-02][ACT-F2] the same transport idempotency key creates ONE support request across invocations with different turn ids; a new key is a new request", async () => {
    const { auth } = await verifiedAvery();
    const tool = toolPolicyRef(TOOL_DEFINITIONS.create_support_request);
    const input = { issueCategory: "general_question" as const, linkToAccount: false, urgency: "STANDARD" as const };
    const ctx = (idempotencyKey: string) => ({ auth, turnId: newTurnId(), idempotencyKey, tool: "create_support_request", argsDigest: "a".repeat(64), language: "en" });
    const a = await h.services.intake.general(ctx("idem_synthIntakeKey00001"), input, tool);
    const b = await h.services.intake.general(ctx("idem_synthIntakeKey00001"), input, tool);
    const c = await h.services.intake.general(ctx("idem_synthIntakeKey00002"), input, tool);
    expect(b.supportRequest.supportRequestId).toBe(a.supportRequest.supportRequestId);
    expect(c.supportRequest.supportRequestId).not.toBe(a.supportRequest.supportRequestId);
    const rows = await h.db.query<{ n: string }>("select count(*)::text as n from support_requests where call_id = $1", [auth.callId]);
    expect(rows.rows[0]?.n).toBe("2");
  });
});

describe("[DP-03] repeat-caller recap reconciled with the system of record", () => {
  async function linkedComplaint(): Promise<{ ref: string; workflowId: string }> {
    const first = await verifiedAvery();
    const r = expectDone(await h.invoke("submit_complaint", first.auth, { category: "SERVICE_EXPERIENCE", wantsCallback: false, language: "en" }));
    if (r.outcome.status !== "SUCCESS") throw new Error(`complaint ${r.outcome.status}`);
    const ref = (r.outcome.data as { complaint: { supportReference: string } }).complaint.supportReference;
    const trace = await h.business.supportRequests.trace(TENANT_ID, ref);
    const workflowId = trace?.workflowIds[0];
    if (!workflowId) throw new Error("WORKFLOW_MISSING");
    return { ref, workflowId };
  }

  async function repeatCaseStatus() {
    const repeat = await verifiedAvery("cal_synthCallRepeat00001");
    const res = expectDone(await h.invoke("get_authorized_case_status", repeat.auth, { supportReference: null }));
    if (res.outcome.status !== "SUCCESS") throw new Error("status");
    return res;
  }

  it("[DATA-04][DP-03] an OPEN request is recapped with the record's own category", async () => {
    const { ref } = await linkedComplaint();
    const res = await repeatCaseStatus();
    if (res.outcome.status !== "SUCCESS") return;
    expect(res.outcome.speech?.templateId).toBe("case.recap_open_issue");
    expect(res.outcome.speech?.slots).toEqual({ supportReference: ref, issueCategory: "complaint" });
    expect((res.masked as { recapAvailable: boolean }).recapAvailable).toBe(true);
  });

  it("[DATA-04][DP-03] a cancelled (CLOSED) request is never recapped as open: the caller hears the authoritative status", async () => {
    const { ref, workflowId } = await linkedComplaint();
    const wf = await h.workflows.signal({ tenantId: TENANT_ID, workflowId, event: "CANCEL", actor: { kind: "system", ref: null } });
    expect(wf.state).toBe("CANCELLED");
    const res = await repeatCaseStatus();
    if (res.outcome.status !== "SUCCESS") return;
    const cases = (res.masked as { cases: { caseRef: string; status: string }[]; recapAvailable: boolean }).cases;
    expect(cases.find((c) => c.caseRef === ref)?.status).toBe("CLOSED");
    expect(res.outcome.speech?.templateId).toBe("case.status");
    expect(res.outcome.speech?.slots).toEqual({ supportReference: ref, caseStatus: "CLOSED" });
    expect((res.masked as { recapAvailable: boolean }).recapAvailable).toBe(false);
  });
});
