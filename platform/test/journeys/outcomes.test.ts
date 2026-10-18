/**
 * [ACT-04][ACT-03] Interaction outcomes at call end on the LOCAL FIXTURE composition (SYNTHETIC
 * client Avery; LOCAL FIXTURE scheduling with injected faults; database-level crash simulation as
 * in faults.test.ts). Each test runs in its own freshly built container.
 *
 *  - TC-11 with a session that no longer resolves (expired, revoked) still records the call's
 *    outcome, keyed by the trusted call id the start-call binding established, from server-side
 *    evidence only; a session of another call, or a repeated call end, records nothing.
 *  - A commit still UNKNOWN / COMMITTING at call end is OUTCOME_UNKNOWN (never
 *    INFORMATION_PROVIDED); when the worker's reconciler records it COMMITTED, the action.committed
 *    consumer appends a revision (never an overwrite) and the current outcome becomes RESOLVED.
 */
import { afterEach, describe, expect, it } from "vitest";
import { APPOINTMENTS } from "../../src/fixtures/synthetic-world.js";
import { LOCAL_FIXTURE_TOKENS } from "../../src/gateway/auth.js";
import { AVERY, createJourneyHarness } from "./harness.js";
import type { JourneyCall, JourneyHarness } from "./harness.js";

let h: JourneyHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});
const start = async (): Promise<JourneyHarness> => {
  h = await createJourneyHarness({ ingestKnowledge: false });
  return h;
};

const APPT = APPOINTMENTS[0].appointmentId;
type Option = { slotId: string | null; startsAt: string; status: string };
type OutcomeRow = { outcome_id: string; outcome: string; reason_code: string; evidence: { revision?: { revises: string; previousOutcome: string; trigger: string; actionId: string }; unresolvedActionIds?: string[] } };

async function verifiedClient(hh: JourneyHarness): Promise<JourneyCall> {
  const call = hh.call();
  await call.start();
  await call.role("client");
  expect((await call.verify(AVERY, "avery.synthetic")).bound).toBe(true);
  return call;
}

async function preparedAndConfirmed(call: JourneyCall): Promise<{ actionId: string; actionDigest: string }> {
  const options = await call.tool("get_appointment_options", { appointmentId: APPT, fromDate: "2026-10-20", toDate: "2026-10-31" });
  expect(options.status).toBe("SUCCESS");
  const slot = ((options.data?.appointments as Option[]) ?? []).find((a) => a.status === "OPEN") as Option;
  const prep = await call.tool("prepare_appointment_change", { appointmentId: APPT, startsAt: slot.startsAt, modality: null, slotId: slot.slotId });
  expect(prep.status).toBe("SUCCESS");
  await call.confirmPending();
  return prep.data?.change as { actionId: string; actionDigest: string };
}

const outcomesOf = (hh: JourneyHarness, callId: string) =>
  hh.q<OutcomeRow>("select outcome_id, outcome, reason_code, evidence from interaction_outcomes where call_id = $1 order by recorded_at, outcome_id", [callId]);

describe("[ACT-04] call-end outcome without a live session", () => {
  it("[ACT-04][AUTH-04] the session expired mid-call: TC-11 still records the call's outcome (keyed by the trusted call id, server-side evidence) and closes the call", async () => {
    const hh = await start();
    const call = await verifiedClient(hh);
    const options = await call.tool("get_appointment_options", { appointmentId: APPT, fromDate: "2026-10-20", toDate: "2026-10-31" });
    expect(options.status).toBe("SUCCESS");
    // The session expires (7200 s TTL) before Studio sends the call end.
    hh.clock.advanceMs(7_201_000);
    const end = await call.end("CALLER_HANGUP");
    expect(end).toEqual({ ended: true, outcome: "INFORMATION_PROVIDED", reasonCode: "INFORMATION_PROVIDED" });
    const rows = await outcomesOf(hh, call.callId);
    expect(rows.map((r) => r.outcome)).toEqual(["INFORMATION_PROVIDED"]);
    const events = await hh.auditFor(call.callId);
    expect(events.some((e) => e.action === "interaction.outcome_recorded" && e.reasonCode === "INFORMATION_PROVIDED")).toBe(true);
    expect(events.some((e) => e.action === "session.ended" && e.reasonCode === "SESSION_EXPIRED")).toBe(true);
    // The binding is gone: a repeated call end records nothing more.
    expect(await call.end("CALLER_HANGUP")).toMatchObject({ ended: false, outcome: null });
    expect(await outcomesOf(hh, call.callId)).toHaveLength(1);
    await hh.expectAuditChainIntact();
  }, 120_000);

  it("[ACT-04][AUTH-04] a revoked session (no other evidence, caller hung up) still gets CALLER_DISCONNECTED; a bearer of ANOTHER call never records an outcome for this one", async () => {
    const hh = await start();
    const a = hh.call();
    await a.start();
    const b = hh.call();
    await b.start();
    await hh.c.identity.sessions.revoke(a.sessionRef as string, "FRAUD_REVIEW");
    // Studio presents call B's session on call A's interaction id: refused, nothing recorded for A.
    const mixed = await hh.c.app.inject({
      method: "POST",
      url: "/telephony/v1/session/end",
      headers: { authorization: `Bearer ${LOCAL_FIXTURE_TOKENS.telephony_control}`, "x-vsp-interaction-id": a.callId, "x-vsp-session-ref": b.sessionRef as string },
      payload: { reason: "CALLER_HANGUP" },
    });
    expect(mixed.statusCode).toBe(200);
    expect(mixed.json()).toMatchObject({ ended: false, outcome: null });
    expect(await outcomesOf(hh, a.callId)).toEqual([]);
    expect(await outcomesOf(hh, b.callId)).toEqual([]);
    // With its own (revoked) session the call end records the outcome from server-side evidence.
    expect(await a.end("CALLER_HANGUP")).toEqual({ ended: true, outcome: "CALLER_DISCONNECTED", reasonCode: "CALLER_DISCONNECTED" });
    // Call B is unaffected and ends normally.
    expect((await b.end("CALLER_HANGUP")).outcome).toBe("CALLER_DISCONNECTED");
  }, 120_000);
});

describe("[ACT-03][ACT-04] a commit unsettled at call end", () => {
  it("[ACT-03][ACT-04] timeout after the scheduling system applied the change: OUTCOME_UNKNOWN at call end (not INFORMATION_PROVIDED); reconciliation appends a RESOLVED revision exactly once", async () => {
    const hh = await start();
    const call = await verifiedClient(hh);
    const change = await preparedAndConfirmed(call);
    // LOCAL FIXTURE fault: the scheduling system applies the change but the response times out.
    hh.c.fixtures.faults.inject({ integrationId: "scheduling", operation: "reschedule", kind: "TIMEOUT_AFTER_COMMIT" });
    const commit = await call.tool("commit_appointment_change", { actionId: change.actionId, digest: change.actionDigest });
    expect(commit.status).toBe("UNKNOWN_OUTCOME");
    expect(commit.speech).toBeNull();

    const end = await call.end("FLOW_COMPLETED");
    expect(end).toEqual({ ended: true, outcome: "OUTCOME_UNKNOWN", reasonCode: "COMMIT_OUTCOME_UNKNOWN" });
    const [first] = await outcomesOf(hh, call.callId);
    expect(first?.evidence.unresolvedActionIds).toEqual([change.actionId]);

    // The worker reconciles by idempotency key (COMMITTED) and the action.committed consumer revises the outcome.
    await hh.runWorker(["actions.reconcile", "outbox.dispatch", "outbox.consume"]);
    await hh.runWorker(["actions.reconcile", "outbox.dispatch", "outbox.consume"]);
    const [ledger] = await hh.q<{ state: string }>("select state from action_ledger where action_id = $1", [change.actionId]);
    expect(ledger?.state).toBe("COMMITTED");
    const rows = await outcomesOf(hh, call.callId);
    expect(rows.map((r) => [r.outcome, r.reason_code])).toEqual([
      ["OUTCOME_UNKNOWN", "COMMIT_OUTCOME_UNKNOWN"],
      ["RESOLVED", "COMMITTED_RECEIPT_VERIFIED"],
    ]);
    // Append-only: the original row is untouched; the revision names what it revises and why.
    expect(rows[0]).toMatchObject({ outcome_id: first?.outcome_id, outcome: "OUTCOME_UNKNOWN" });
    expect(rows[1]?.evidence.revision).toEqual({ revises: first?.outcome_id, previousOutcome: "OUTCOME_UNKNOWN", trigger: "ACTION_COMMITTED_AFTER_CALL_END", actionId: change.actionId });
    await expect(hh.q("update interaction_outcomes set outcome = 'RESOLVED' where outcome_id = $1", [first?.outcome_id])).rejects.toThrow(/SUPPORT_RECORDS_APPEND_ONLY/);
    const events = await hh.auditFor(call.callId);
    expect(events.filter((e) => e.action === "interaction.outcome_revised").map((e) => e.reasonCode)).toEqual(["COMMITTED_RECEIPT_VERIFIED"]);

    // Redelivery and later worker rounds append nothing more.
    await hh.c.business.outcomes.reviseAfterCommit?.(hh.c.config.tenantId, change.actionId);
    await hh.runWorker(["actions.reconcile", "outbox.dispatch", "outbox.consume"]);
    expect(await outcomesOf(hh, call.callId)).toHaveLength(2);
    await hh.expectAuditChainIntact();
  }, 120_000);

  it("[ACT-03][ACT-02] crash after the provider commit (ledger left COMMITTING): the call end is OUTCOME_UNKNOWN; after restart the reconciler commits once and the outcome is revised to RESOLVED", async () => {
    const hh = await start();
    const call = await verifiedClient(hh);
    const change = await preparedAndConfirmed(call);
    // LOCAL FIXTURE crash simulation (as in faults.test.ts): after the provider applies the change every
    // database write of this process fails until it "restarts".
    const port = hh.c.business.providers["appointment.reschedule"];
    const realCommit = port?.commit.bind(port) as NonNullable<typeof port>["commit"];
    const realTx = hh.c.db.tx.bind(hh.c.db);
    let crashed = false;
    (port as { commit: typeof realCommit }).commit = async (action, key) => {
      const r = await realCommit(action, key);
      crashed = true;
      return r;
    };
    (hh.c.db as { tx: typeof realTx }).tx = (async (fn: never, opts: never) => {
      if (crashed) throw new Error("SIMULATED_PROCESS_CRASH");
      return realTx(fn, opts);
    }) as typeof realTx;
    try {
      const r = await call.tool("commit_appointment_change", { actionId: change.actionId, digest: change.actionDigest });
      expect(r.status).not.toBe("SUCCESS");
    } finally {
      (hh.c.db as { tx: typeof realTx }).tx = realTx;
      (port as { commit: typeof realCommit }).commit = realCommit;
    }
    const [before] = await hh.q<{ state: string }>("select state from action_ledger where action_id = $1", [change.actionId]);
    expect(before?.state).toBe("COMMITTING");

    expect(await call.end("FLOW_COMPLETED")).toEqual({ ended: true, outcome: "OUTCOME_UNKNOWN", reasonCode: "COMMIT_OUTCOME_UNKNOWN" });
    hh.clock.advanceMs(31_000);
    await hh.runWorker(["actions.reconcile", "outbox.dispatch", "outbox.consume"]);
    await hh.runWorker(["actions.reconcile", "outbox.dispatch", "outbox.consume"]);
    expect(hh.c.fixtures.scheduling.effects.filter((e) => JSON.stringify(e).includes(APPT))).toHaveLength(1);
    expect((await outcomesOf(hh, call.callId)).map((r) => r.outcome)).toEqual(["OUTCOME_UNKNOWN", "RESOLVED"]);
  }, 120_000);
});
