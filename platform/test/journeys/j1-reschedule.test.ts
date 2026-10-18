/**
 * [SPEC-16.journey-1] Verified client reschedules an appointment with conflict handling,
 * end to end on the LOCAL FIXTURE composition (SYNTHETIC client Avery):
 * unverified caller -> protected read refused -> secure-link verification approved in the
 * portal with MFA -> authorized options -> prepare -> Studio-captured confirmation -> the
 * chosen slot is taken by a concurrent booking -> SLOT_UNAVAILABLE with fresh options ->
 * prepare again -> confirmation -> commit -> COMMITTED receipt -> call end RESOLVED.
 * Backend evidence: ledger rows, interaction index, scheduling fixture effect log (exactly
 * one effect), interaction outcome row, audit events and the audit chain.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APPOINTMENTS, SLOTS } from "../../src/fixtures/synthetic-world.js";
import { AVERY, createJourneyHarness } from "./harness.js";
import type { JourneyHarness, ToolResultView } from "./harness.js";

let h: JourneyHarness;
beforeAll(async () => {
  h = await createJourneyHarness();
}, 180_000);
afterAll(async () => {
  await h?.close();
});

const APPT = APPOINTMENTS[0].appointmentId;
type Option = { appointmentId: string | null; slotId: string | null; startsAt: string; status: string };
const options = (r: ToolResultView): Option[] => ((r.data?.appointments as Option[]) ?? []).filter((a) => a.status === "OPEN");

describe("[SPEC-16.journey-1] verified client reschedules with conflict handling", () => {
  it("[SPEC-16.journey-1][ACT-01][ACT-02][ACT-04][AUTH-02][SPEC-15.phase-1] unverified -> verified -> SLOT_UNAVAILABLE -> new option -> confirmed commit -> exactly one effect -> RESOLVED", async () => {
    const call = h.call();
    await call.start();
    await call.role("client");

    // A0: the protected read fails closed before verification (no disclosure, nothing read).
    const unverified = await call.tool("get_appointment_options", { appointmentId: APPT, fromDate: "2026-10-20", toDate: "2026-10-31" });
    expect(unverified.status).toBe("POLICY_DENIED");
    expect(unverified.data ?? null).toBeNull();
    expect(await call.authGate()).toBe(false);

    // Secure mock authentication: secure link to the registered channel, MFA sign-in in the portal.
    const v = await call.verify(AVERY, "avery.synthetic");
    expect(v.begin.status).toBe("SUCCESS");
    expect(v.begin.speech?.templateId).toBe("verification.secure_link_match_code");
    expect(v).toMatchObject({ bound: true, reasonCode: "VERIFIED" });
    expect(await call.authGate()).toBe(true);

    // Authorized lookup.
    const opts = await call.tool("get_appointment_options", { appointmentId: APPT, fromDate: "2026-10-20", toDate: "2026-10-31" });
    expect(opts.status).toBe("SUCCESS");
    expect(opts.speech?.templateId).toBe("appointment.option_offer");
    const offered = options(opts);
    expect(offered.map((o) => o.slotId)).toEqual(SLOTS.map((s) => s.slotId));
    const first = offered[0] as Option;

    // Prepare the first choice; Studio reads the server-rendered confirmation and captures DTMF.
    const prep1 = await call.tool("prepare_appointment_change", { appointmentId: APPT, startsAt: first.startsAt, modality: null, slotId: first.slotId });
    expect(prep1.status).toBe("SUCCESS");
    const change1 = prep1.data?.change as { actionId: string; actionDigest: string };
    const p1 = await call.confirmPending();
    expect(p1).toMatchObject({ actionId: change1.actionId, digest: change1.actionDigest, confirmationTemplateId: "appointment.change_confirmation" });
    expect(typeof p1.promptText).toBe("string");

    // A concurrent booking (another channel) takes the chosen slot between confirmation and commit.
    h.c.fixtures.scheduling.simulateConcurrentBooking(first.slotId as string);
    const effectsBefore = h.c.fixtures.scheduling.effects.length;
    const conflict = await call.tool("commit_appointment_change", { actionId: change1.actionId, digest: change1.actionDigest });
    expect(conflict.status).toBe("SUCCESS");
    expect(conflict.data).toMatchObject({ committed: false, commitOutcome: "SLOT_UNAVAILABLE", nextStep: "CHOOSE_NEW_OPTION" });
    expect(conflict.speech?.templateId).toBe("appointment.slot_unavailable_next_option");
    expect(h.c.fixtures.scheduling.effects.length).toBe(effectsBefore);
    const fresh = options(conflict);
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh.map((o) => o.startsAt)).not.toContain(first.startsAt);
    const second = fresh[0] as Option;

    // New preparation for a fresh option, fresh confirmation, commit.
    const prep2 = await call.tool("prepare_appointment_change", { appointmentId: APPT, startsAt: second.startsAt, modality: null });
    expect(prep2.status).toBe("SUCCESS");
    const change2 = prep2.data?.change as { actionId: string; actionDigest: string; slotId: string };
    expect(change2.actionId).not.toBe(change1.actionId);
    // The first action can no longer be confirmed or committed.
    const stale = await call.confirm({ actionId: change1.actionId, digest: change1.actionDigest, sessionGeneration: p1.sessionGeneration, turnId: p1.turnId });
    expect(stale.status).toBe(409);
    await call.confirmPending();
    const committed = await call.tool("commit_appointment_change", { actionId: change2.actionId, digest: change2.actionDigest });
    expect(committed.status).toBe("SUCCESS");
    expect(committed.data).toMatchObject({ committed: true, commitOutcome: "COMMITTED", nextStep: "NONE" });
    const record = (committed.data?.appointments as { receiptId: string; startsAt: string }[])[0] as { receiptId: string; startsAt: string };
    expect(record.receiptId).toMatch(/^rcp_/);
    expect(record.startsAt).toBe(second.startsAt);
    expect(committed.speech?.templateId).toBe("appointment.change_committed");

    // Exactly one scheduling effect; the appointment moved to the second slot (authoritative state).
    const effects = h.c.fixtures.scheduling.effects.filter((e) => JSON.stringify(e).includes(APPT));
    expect(effects).toHaveLength(1);
    const appt = await h.c.fixtures.scheduling.getAppointment(APPT);
    expect(appt?.startsAt).toBe(second.startsAt);

    // Ledger: first action closed without effect, second COMMITTED with the receipt.
    const ledger = await h.q<{ action_id: string; state: string }>("select action_id, state from action_ledger where action_id = any($1::text[]) order by prepared_at", [[change1.actionId, change2.actionId]]);
    expect(ledger.find((r) => r.action_id === change2.actionId)?.state).toBe("COMMITTED");
    expect(ledger.find((r) => r.action_id === change1.actionId)?.state).not.toBe("COMMITTED");
    const idx = await h.q<{ action_id: string; receipt_id: string | null; receipt_outcome: string | null; contract_id: string | null }>(
      "select action_id, receipt_id, receipt_outcome, contract_id from interaction_actions where call_id = $1",
      [call.callId],
    );
    expect(idx.find((r) => r.action_id === change2.actionId)).toMatchObject({ receipt_id: record.receiptId, receipt_outcome: "COMMITTED", contract_id: "appointment_reschedule@1" });

    // Call end: RESOLVED only from the verified COMMITTED receipt of the contract's action kind.
    const end = await call.end("FLOW_COMPLETED");
    expect(end).toEqual({ ended: true, outcome: "RESOLVED", reasonCode: "COMMITTED_RECEIPT_VERIFIED" });
    const outcomes = await h.q<{ outcome: string; contract_id: string | null; evidence: { commitReceiptIds: string[]; contractInferred: boolean } }>(
      "select outcome, contract_id, evidence from interaction_outcomes where call_id = $1",
      [call.callId],
    );
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ outcome: "RESOLVED", contract_id: "appointment_reschedule@1" });
    expect(outcomes[0]?.evidence.commitReceiptIds).toEqual([record.receiptId]);
    expect(await call.authGate()).toBe(false);

    // Caller-visible: the success template was rendered only after the receipt existed.
    const heardIds = call.heard.map((x) => x.templateId);
    expect(heardIds.indexOf("appointment.change_committed")).toBeGreaterThan(heardIds.indexOf("appointment.slot_unavailable_next_option"));
    expect(heardIds.filter((t) => t === "appointment.change_committed")).toHaveLength(1);
    expect(call.utterances().length).toBeGreaterThanOrEqual(6);

    // Audit trace: every step left durable, content-free evidence; the chain verifies.
    const events = await h.auditFor(call.callId);
    const actions = new Set(events.map((e) => e.action));
    for (const a of ["session.started", "session.role_selected", "tool.invoke", "action.confirmation_captured", "action.commit.started", "interaction.outcome_recorded", "session.ended"]) {
      expect(actions.has(a), a).toBe(true);
    }
    // The portal binding is audited too, but its event carries no call id (identity port gap, see report).
    const bound = await h.c.auditQuery.search({ tenantId: h.c.config.tenantId, action: "verification.bound", limit: 50 });
    expect(bound.some((e) => e.outcome === "SUCCEEDED" && e.reasonCode === "SECURE_LINK_BOUND")).toBe(true);
    expect(JSON.stringify(events)).not.toContain(call.sessionRef as string);
    const chain = await h.expectAuditChainIntact();
    expect(chain.events).toBeGreaterThanOrEqual(events.length);
  }, 120_000);

  // KNOWN FAILING (defect outside this role's ownership, see report): IntegrityVerifier.verifyStream
  // reads `sequence::text as sequence ... order by sequence`, so PostgreSQL orders by the TEXT alias
  // (1, 10, 11, ..., 19, 2, 20, ...). Any stream with 10 or more events reports SEQUENCE_GAP /
  // SEQUENCE_OUT_OF_ORDER / PREV_HASH_MISMATCH / HEAD_MISMATCH although the stored chain is intact
  // (proved above with verifyChain in numeric order). Fix: `order by audit_outbox.sequence` in
  // src/audit/verifier.ts:283 and :415 (and src/audit/shipper.ts:200 and :261).
  // KNOWN FAILING (same defect class, src/audit/shipper.ts:198-200 and :259-261, outside this role's
  // ownership): the shipper selects `sequence::text as sequence ... order by sequence`, so a stream
  // with 10 or more unshipped events is read 1, 10, 11, ... and the batch fails its own continuity
  // check (AUDIT_CHAIN_GAP). Observed here: stream "runtime" ships 1 event and stops; the rest of the
  // journey's evidence stays in the local outbox, and the growing backlog would eventually trip the
  // audit health gate. Fix: `order by audit_outbox.sequence` in both queries.
  it("[OPS-01][SPEC-13.audit][SPEC-16.journey-1] the audit shipper exports every journey event to the LOCAL FIXTURE sink", async () => {
    const r = await h.c.auditShipper.runOnce();
    expect(r.streams.filter((x) => x.reasonCode !== null)).toEqual([]);
    const left = await h.q<{ n: number }>("select count(*)::int as n from audit_outbox where shipped_at is null");
    expect(left[0]?.n).toBe(0);
  });

  it("[OPS-01][SPEC-16.journey-1] IntegrityVerifier verifies the journey's audit streams without findings", async () => {
    const findings = await h.integrityVerifierFindings();
    for (const [stream, f] of Object.entries(findings)) expect(f, stream).toEqual([]);
  });
});
