/**
 * Appointment tools end to end over the REAL modules (PGlite, OPA bundle, action ledger,
 * identity) and LOCAL SYNTHETIC fixtures (business/testing/harness.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mcp } from "../identity/identity-harness.fixture.js";
import { APPOINTMENTS, PEOPLE, SLOTS } from "../fixtures/synthetic-world.js";
import { createBusinessHarness, expectDone, type BusinessHarness } from "./testing/harness.js";

let h: BusinessHarness;
beforeEach(async () => {
  h = await createBusinessHarness();
});
afterEach(async () => {
  await h.close();
});

const avery = APPOINTMENTS[0];
const slot1 = SLOTS[0];
const slot2 = SLOTS[1];

async function verifiedAvery() {
  const { sessionRef } = await h.startCall();
  const auth = await h.verify(PEOPLE.avery, sessionRef);
  return { sessionRef, auth };
}

async function prepareReschedule(auth: Awaited<ReturnType<typeof verifiedAvery>>["auth"], startsAt: string = slot1.startsAt) {
  const r = expectDone(await h.invoke("prepare_appointment_change", auth, { appointmentId: avery.appointmentId, startsAt, modality: null }));
  expect(r.outcome.status).toBe("SUCCESS");
  if (r.outcome.status !== "SUCCESS") throw new Error("unreachable");
  const change = (r.outcome.data as { change: { actionId: string; actionDigest: string } }).change;
  return { actionId: change.actionId, digest: change.actionDigest, result: r };
}

describe("appointment options and reschedule", () => {
  it("[SPEC-16.reschedule] [AUTH-02] a verified client sees own appointment and open times; masked to the policy field mask", async () => {
    const { auth } = await verifiedAvery();
    const r = expectDone(await h.invoke("get_appointment_options", auth, { appointmentId: avery.appointmentId, fromDate: "2026-10-20", toDate: "2026-10-31" }));
    expect(r.decision.allow).toBe(true);
    expect(r.outcome.status).toBe("SUCCESS");
    const masked = r.masked as { appointments: Record<string, unknown>[]; optionCount: number };
    expect(masked.optionCount).toBe(3);
    expect(masked.appointments.length).toBe(4);
    for (const rec of masked.appointments) for (const k of Object.keys(rec)) expect(r.decision.fieldMask).toContain(k);
    if (r.outcome.status === "SUCCESS") {
      expect(r.outcome.speech?.templateId).toBe("appointment.option_offer");
      expect(r.outcome.speech?.slots).toEqual({ date: "2026-10-23", time: "12:00", timeZone: "America/Chicago" });
    }
  });

  it("[ACT-01] [SPEC-16.reschedule] options carry the opaque slot id (appointment:list_options mask); prepare binds an offered slot id and refuses one that does not match", async () => {
    const { auth } = await verifiedAvery();
    const r = expectDone(await h.invoke("get_appointment_options", auth, { appointmentId: avery.appointmentId, fromDate: "2026-10-20", toDate: "2026-10-31" }));
    expect(r.decision.fieldMask).toEqual(["appointmentId", "modality", "providerDisplayName", "slotId", "startsAt", "status", "timeZone"]);
    const masked = r.masked as { appointments: { slotId: string | null; status: string; startsAt: string }[] };
    expect(masked.appointments.filter((a) => a.status === "SCHEDULED").every((a) => a.slotId === null)).toBe(true);
    const offered = masked.appointments.filter((a) => a.status === "OPEN");
    expect(offered.map((a) => a.slotId)).toContain(slot1.slotId);
    expect(offered.find((a) => a.slotId === slot1.slotId)?.startsAt).toBe(slot1.startsAt);

    const bound = expectDone(await h.invoke("prepare_appointment_change", auth, { appointmentId: avery.appointmentId, startsAt: slot1.startsAt, modality: null, slotId: slot1.slotId }));
    expect(bound.outcome.status).toBe("SUCCESS");
    if (bound.outcome.status === "SUCCESS") expect((bound.outcome.data as { change: { slotId: string } }).change.slotId).toBe(slot1.slotId);
    // A slot id that does not belong to the authoritative open slot at that time selects nothing.
    const mismatch = expectDone(await h.invoke("prepare_appointment_change", auth, { appointmentId: avery.appointmentId, startsAt: slot1.startsAt, modality: null, slotId: slot2.slotId }));
    expect(mismatch.outcome).toMatchObject({ status: "PERMANENT_FAILURE", reasonCode: "SLOT_UNAVAILABLE" });
  });

  it("[AUTH-02] an A0 caller is denied appointment options (no protected read before verification)", async () => {
    const { ctx } = await h.startCall();
    const r = await h.invoke("get_appointment_options", ctx, { appointmentId: avery.appointmentId, fromDate: "2026-10-20", toDate: "2026-10-31" });
    expect(r.stage).toBe("policy");
  });

  it("[SPEC-16.reschedule] [ACT-01] prepare -> trusted confirmation -> commit reschedules exactly once and is RESOLVED only with the receipt", async () => {
    const { auth } = await verifiedAvery();
    const { actionId, digest, result } = await prepareReschedule(auth);
    if (result.outcome.status === "SUCCESS") {
      expect(result.outcome.speech?.templateId).toBe("appointment.change_confirmation");
      expect(result.outcome.speech?.slots).toMatchObject({ fromDate: "2026-10-22", fromTime: "12:00", toDate: "2026-10-23", toTime: "12:00", toTimeZone: "America/Chicago" });
    }
    await h.confirm(auth, actionId, digest);
    const c = expectDone(await h.invoke("commit_appointment_change", auth, { actionId, digest }));
    expect(c.outcome.status).toBe("SUCCESS");
    if (c.outcome.status !== "SUCCESS") return;
    const data = c.outcome.data as { committed: boolean; appointments: { receiptId: string | null; startsAt: string }[] };
    expect(data.committed).toBe(true);
    expect(data.appointments[0]?.startsAt).toBe(slot1.startsAt);
    expect(c.outcome.speech?.templateId).toBe("appointment.change_committed");
    expect(h.fixtures.scheduling.effects).toHaveLength(1);

    const receiptId = data.appointments[0]?.receiptId as string;
    const resolved = await h.business.outcomes.record({
      tenantId: auth.tenantId,
      callId: auth.callId,
      contractId: "appointment_reschedule@1",
      evidence: { commitReceiptIds: [receiptId], informationProvided: true, requestAccepted: false, transferConnected: false, callerDisconnected: false, policyDeclined: false, failed: false },
    });
    expect(resolved.outcome).toBe("RESOLVED");
  });

  it("[ACT-01] commit without a trusted confirmation fails and nothing changes", async () => {
    const { auth } = await verifiedAvery();
    const { actionId, digest } = await prepareReschedule(auth);
    const c = expectDone(await h.invoke("commit_appointment_change", auth, { actionId, digest }));
    expect(c.outcome).toMatchObject({ status: "PERMANENT_FAILURE", reasonCode: "ACTION_NOT_CONFIRMED" });
    expect(h.fixtures.scheduling.effects).toHaveLength(0);
  });

  it("[ACT-01] a confirmation from the model-facing mcp_tools identity is rejected", async () => {
    const { auth } = await verifiedAvery();
    const { actionId, digest } = await prepareReschedule(auth);
    await expect(
      h.actions.confirm(
        { actionId, digest, sessionRef: auth.sessionRef, sessionGeneration: auth.sessionGeneration, turnId: "turn_modelSaysYes", method: "deterministic_skill_affirmative", capturedBy: "talkdesk-ai", capturedAt: h.clock.now().toISOString() },
        mcp(),
      ),
    ).rejects.toMatchObject({ reasonCode: "CONFIRMATION_CHANNEL_NOT_TRUSTED" });
    const c = expectDone(await h.invoke("commit_appointment_change", auth, { actionId, digest }));
    expect(c.outcome.status).toBe("PERMANENT_FAILURE");
    expect(h.fixtures.scheduling.effects).toHaveLength(0);
  });

  it("[ACT-01] a wrong digest is denied and invalidates the pending action", async () => {
    const { auth } = await verifiedAvery();
    const { actionId, digest } = await prepareReschedule(auth);
    await h.confirm(auth, actionId, digest);
    const c = expectDone(await h.invoke("commit_appointment_change", auth, { actionId, digest: "a".repeat(64) }));
    expect(c.outcome.status).toBe("POLICY_DENIED");
    expect(h.fixtures.scheduling.effects).toHaveLength(0);
    expect((await h.actions.get(auth.tenantId, actionId))?.state).toBe("INVALIDATED");
  });

  it("[ACT-02] a retried commit (redelivery of the same tool call) returns the stored receipt and creates one change", async () => {
    const { auth } = await verifiedAvery();
    const { actionId, digest } = await prepareReschedule(auth);
    await h.confirm(auth, actionId, digest);
    const first = expectDone(await h.invoke("commit_appointment_change", auth, { actionId, digest }));
    const second = expectDone(await h.invoke("commit_appointment_change", auth, { actionId, digest }));
    expect(first.outcome.status).toBe("SUCCESS");
    expect(second.outcome.status).toBe("SUCCESS");
    if (first.outcome.status === "SUCCESS" && second.outcome.status === "SUCCESS") {
      const r1 = (first.outcome.data as { appointments: { receiptId: string }[] }).appointments[0]?.receiptId;
      const r2 = (second.outcome.data as { appointments: { receiptId: string }[] }).appointments[0]?.receiptId;
      expect(r2).toBe(r1);
    }
    expect(h.fixtures.scheduling.effects).toHaveLength(1);
  });

  it("[ACT-02] [ACT-03] provider applies the change then the call times out: UNKNOWN, reconciled by key, one effect, success only after reconciliation", async () => {
    const { auth } = await verifiedAvery();
    const { actionId, digest } = await prepareReschedule(auth);
    await h.confirm(auth, actionId, digest);
    h.fixtures.faults.inject({ integrationId: "scheduling", operation: "reschedule", kind: "TIMEOUT_AFTER_COMMIT" });
    const c = expectDone(await h.invoke("commit_appointment_change", auth, { actionId, digest }));
    expect(c.outcome.status).toBe("UNKNOWN_OUTCOME");
    expect(h.fixtures.scheduling.effects).toHaveLength(1);
    expect((await h.actions.get(auth.tenantId, actionId))?.state).toBe("UNKNOWN");
    // No success claim yet; the next call reconciles by the provider idempotency key before anything else.
    const again = expectDone(await h.invoke("commit_appointment_change", auth, { actionId, digest }));
    expect(again.outcome.status).toBe("SUCCESS");
    expect(h.fixtures.scheduling.effects).toHaveLength(1);
    expect((await h.actions.get(auth.tenantId, actionId))?.state).toBe("COMMITTED");
  });

  it("[ACT-03] worker reconciliation through the business provider port resolves an UNKNOWN commit", async () => {
    const { auth } = await verifiedAvery();
    const { actionId, digest } = await prepareReschedule(auth);
    await h.confirm(auth, actionId, digest);
    h.fixtures.faults.inject({ integrationId: "scheduling", operation: "reschedule", kind: "TIMEOUT_AFTER_COMMIT" });
    expect(expectDone(await h.invoke("commit_appointment_change", auth, { actionId, digest })).outcome.status).toBe("UNKNOWN_OUTCOME");
    const provider = h.business.providers["appointment.reschedule"];
    if (!provider) throw new Error("provider missing");
    const receipt = await h.actions.reconcile(actionId, provider);
    expect(receipt.outcome).toBe("COMMITTED");
    expect(receipt.reconciled).toBe(true);
    expect(h.fixtures.scheduling.effects).toHaveLength(1);
  });

  it("[SPEC-16.reschedule] slot taken between prepare and commit: SLOT_UNAVAILABLE, nothing changed, fresh options offered", async () => {
    const { auth } = await verifiedAvery();
    const { actionId, digest } = await prepareReschedule(auth);
    await h.confirm(auth, actionId, digest);
    h.fixtures.scheduling.simulateConcurrentBooking(slot1.slotId);
    const c = expectDone(await h.invoke("commit_appointment_change", auth, { actionId, digest }));
    expect(c.outcome.status).toBe("SUCCESS");
    if (c.outcome.status !== "SUCCESS") return;
    const data = c.outcome.data as { committed: boolean; commitOutcome: string; appointments: { startsAt: string; status: string }[] };
    expect(data).toMatchObject({ committed: false, commitOutcome: "SLOT_UNAVAILABLE" });
    expect(data.appointments.map((a) => a.startsAt)).toEqual([slot2.startsAt, SLOTS[2].startsAt]);
    expect(c.outcome.speech?.templateId).toBe("appointment.slot_unavailable_next_option");
    expect(h.fixtures.scheduling.effects).toHaveLength(0);
    // Re-prepare with a fresh option works.
    const again = await prepareReschedule(auth, slot2.startsAt);
    await h.confirm(auth, again.actionId, again.digest);
    expect(expectDone(await h.invoke("commit_appointment_change", auth, { actionId: again.actionId, digest: again.digest })).outcome.status).toBe("SUCCESS");
    expect(h.fixtures.scheduling.effects).toHaveLength(1);
  });

  it("[SPEC-8.prepare-commit] appointment changed elsewhere: STATE_CHANGED (re-prepare), nothing committed", async () => {
    const { auth } = await verifiedAvery();
    const { actionId, digest } = await prepareReschedule(auth);
    await h.confirm(auth, actionId, digest);
    h.fixtures.scheduling.simulateConcurrentChange(avery.appointmentId);
    const c = expectDone(await h.invoke("commit_appointment_change", auth, { actionId, digest }));
    expect(c.outcome).toMatchObject({ status: "PERMANENT_FAILURE", reasonCode: "STATE_CHANGED" });
    expect(h.fixtures.scheduling.effects).toHaveLength(0);
  });

  it("[SPEC-4.appointment-create] a verified client books a new appointment from an offered time", async () => {
    const { auth } = await verifiedAvery();
    const opts = expectDone(await h.invoke("get_appointment_options", auth, { appointmentId: null, fromDate: "2026-10-20", toDate: "2026-10-31" }));
    expect(opts.outcome.status).toBe("SUCCESS");
    const p = expectDone(await h.invoke("prepare_appointment_change", auth, { appointmentId: null, startsAt: slot2.startsAt, modality: "video" }));
    if (p.outcome.status !== "SUCCESS") throw new Error(`prepare ${p.outcome.status}`);
    expect(p.outcome.speech?.templateId).toBe("appointment.create_confirmation");
    const change = (p.outcome.data as { change: { actionId: string; actionDigest: string } }).change;
    await h.confirm(auth, change.actionId, change.actionDigest);
    const c = expectDone(await h.invoke("commit_appointment_change", auth, { actionId: change.actionId, digest: change.actionDigest }));
    expect(c.outcome.status).toBe("SUCCESS");
    if (c.outcome.status === "SUCCESS") expect(c.outcome.speech?.templateId).toBe("appointment.create_committed");
    expect(h.fixtures.scheduling.effects.map((e) => e.operation)).toEqual(["create"]);
  });

  it("[AUTH-05] a client cannot prepare a change to another client's appointment even with its valid id", async () => {
    const { auth } = await verifiedAvery();
    const r = await h.invoke("prepare_appointment_change", auth, { appointmentId: APPOINTMENTS[1].appointmentId, startsAt: slot1.startsAt, modality: null });
    expect(r.stage).toBe("policy");
  });

  it("[AUTH-05] a prepared action of another session cannot be committed (resolves to a denied resource)", async () => {
    const a = await verifiedAvery();
    const { actionId, digest } = await prepareReschedule(a.auth);
    await h.confirm(a.auth, actionId, digest);
    const other = await h.startCall("cal_synthCallConcurrent1");
    const other2 = await h.verify(PEOPLE.avery, other.sessionRef);
    const r = await h.invoke("commit_appointment_change", other2, { actionId, digest });
    expect(r.stage).toBe("policy");
    expect(h.fixtures.scheduling.effects).toHaveLength(0);
  });
});
