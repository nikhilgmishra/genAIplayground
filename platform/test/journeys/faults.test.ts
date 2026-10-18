/**
 * [SPEC-16.faults] Injected faults over the LOCAL FIXTURE composition (spec section 16:
 * "Inject authentication expiry, two concurrent calls for the same account, an interrupted
 * confirmation, duplicate webhooks, crash after commit, Salesforce outage, failed transfer and
 * audit outage. Verify the final system state, not just the conversation text").
 * Each fault runs in its own freshly built container (no shared fixture state). SYNTHETIC data;
 * every fault is a LOCAL FIXTURE fault (fault injector, scripted telephony, or a labelled
 * database-level simulation).
 */
import { afterEach, describe, expect, it } from "vitest";
import { APPOINTMENTS, STAFF } from "../../src/fixtures/synthetic-world.js";
import { AVERY, createJourneyHarness, journeyOf } from "./harness.js";
import type { JourneyCall, JourneyHarness, ToolResultView } from "./harness.js";

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

async function verifiedClient(hh: JourneyHarness): Promise<JourneyCall> {
  const call = hh.call();
  await call.start();
  await call.role("client");
  expect((await call.verify(AVERY, "avery.synthetic")).bound).toBe(true);
  return call;
}

async function openSlots(call: JourneyCall): Promise<Option[]> {
  const r = await call.tool("get_appointment_options", { appointmentId: APPT, fromDate: "2026-10-20", toDate: "2026-10-31" });
  expect(r.status).toBe("SUCCESS");
  return ((r.data?.appointments as Option[]) ?? []).filter((a) => a.status === "OPEN");
}

async function prepare(call: JourneyCall, slot: Option): Promise<{ actionId: string; actionDigest: string }> {
  const r = await call.tool("prepare_appointment_change", { appointmentId: APPT, startsAt: slot.startsAt, modality: null, slotId: slot.slotId });
  expect(r.status, `prepare ${r.reasonCode ?? ""}`).toBe("SUCCESS");
  return r.data?.change as { actionId: string; actionDigest: string };
}

const effectsFor = (hh: JourneyHarness) => hh.c.fixtures.scheduling.effects.filter((e) => JSON.stringify(e).includes(APPT));
const ledgerState = async (hh: JourneyHarness, actionId: string) => (await hh.q<{ state: string; state_reason: string | null }>("select state, state_reason from action_ledger where action_id = $1", [actionId]))[0];

describe("[SPEC-16.faults] injected faults on the local composition", () => {
  it("[SPEC-16.fault-auth-expiry][AUTH-04][SAFE-02] authentication expiry mid-call: protected tools fail closed before TTL cleanup; safety and human routes still work", async () => {
    const hh = await start();
    const call = await verifiedClient(hh);
    expect((await openSlots(call)).length).toBeGreaterThan(0);
    expect(await call.authGate()).toBe(true);

    // The session expires (7200 s TTL) while the KV record still exists (storage TTL grace not yet reached).
    hh.clock.advanceMs(7_201_000);
    const expired = await call.tool("get_appointment_options", { appointmentId: APPT, fromDate: "2026-10-20", toDate: "2026-10-31" });
    expect(expired.status).toBe("POLICY_DENIED");
    expect(expired.reasonCode).toMatch(/EXPIRED/);
    expect(expired.data ?? null).toBeNull();
    expect(await call.authGate()).toBe(false);
    const pending = await call.pending();
    expect(pending.status).toBe(403);

    // SAFE-02: the safety route and the human route need no valid session.
    hh.c.fixtures.telephony.scriptDestination("dst_safety_priority", { outcome: "CONNECTED" });
    const screened = await call.screen("i want to kill myself");
    expect(screened.body).toMatchObject({ route: "SAFETY_PRIORITY_HUMAN", destinationId: "dst_safety_priority" });
    expect(screened.body.handoffId).toMatch(/^hnd_/);
    const human = await call.tool("request_human_transfer", { reason: "CALLER_REQUESTED_HUMAN", language: "en", issueCategory: null, accommodations: [] });
    expect(human.status).toBe("SUCCESS");
    expect(hh.c.fixtures.telephony.dials.filter((d) => d.callId === call.callId).map((d) => d.priority)).toContain("SAFETY");
    const events = await hh.auditFor(call.callId);
    expect(events.some((e) => e.action === "tool.invoke" && e.outcome === "DENIED" && /EXPIRED/.test(e.reasonCode ?? ""))).toBe(true);
    await hh.expectAuditChainIntact();
  }, 120_000);

  it("[SPEC-16.fault-concurrent-calls][ACT-02][SPEC-8.concurrency] two concurrent calls for the same account: one commit, the other STATE_CHANGED, a single scheduling effect", async () => {
    const hh = await start();
    const a = await verifiedClient(hh);
    const b = await verifiedClient(hh);
    const slots = await openSlots(a);
    expect(slots.length).toBeGreaterThanOrEqual(2);
    const ca = await prepare(a, slots[0] as Option);
    const cb = await prepare(b, slots[1] as Option);
    await a.confirmPending();
    await b.confirmPending();

    const [ra, rb] = await Promise.all([
      a.tool("commit_appointment_change", { actionId: ca.actionId, digest: ca.actionDigest }),
      b.tool("commit_appointment_change", { actionId: cb.actionId, digest: cb.actionDigest }),
    ]);
    const outcomes = [ra, rb];
    const winner = outcomes.findIndex((r) => r.status === "SUCCESS" && (r.data as { committed?: boolean } | null)?.committed === true);
    expect(winner).toBeGreaterThanOrEqual(0);
    const loserCall = winner === 0 ? b : a;
    const loserChange = winner === 0 ? cb : ca;
    let loser: ToolResultView = outcomes[1 - winner] as ToolResultView;
    // A commit that found the record busy is told to retry; the retry sees the authoritative change.
    if (loser.status === "RETRYABLE_FAILURE") loser = await loserCall.tool("commit_appointment_change", { actionId: loserChange.actionId, digest: loserChange.actionDigest });
    expect(loser.status).toBe("PERMANENT_FAILURE");
    expect(loser.reasonCode).toBe("STATE_CHANGED");

    expect(effectsFor(hh)).toHaveLength(1);
    const winnerChange = winner === 0 ? ca : cb;
    expect((await ledgerState(hh, winnerChange.actionId))?.state).toBe("COMMITTED");
    expect((await ledgerState(hh, loserChange.actionId))?.state).toBe("INVALIDATED");
    const appt = await hh.c.fixtures.scheduling.getAppointment(APPT);
    expect(appt?.startsAt).toBe((slots[winner] as Option).startsAt);
    expect((await (winner === 0 ? a : b).end()).outcome).toBe("RESOLVED");
    expect((await loserCall.end()).outcome).not.toBe("RESOLVED");
  }, 120_000);

  it("[SPEC-16.fault-interrupted-confirmation][ACT-01][SPEC-11.barge-in] barge-in during confirmation invalidates the turn and the pending action; the late confirmation and the commit are refused", async () => {
    const hh = await start();
    const call = await verifiedClient(hh);
    const slots = await openSlots(call);
    const change = await prepare(call, slots[0] as Option);
    const prompt = await call.pending();
    expect(prompt.status).toBe(200);

    const barge = await call.bargeIn();
    expect(barge.body).toEqual({ invalidatedTurn: true, invalidatedActions: 1 });
    expect(await ledgerState(hh, change.actionId)).toMatchObject({ state: "INVALIDATED", state_reason: "BARGE_IN" });

    const late = await call.confirm(prompt.body);
    expect(late.status).toBe(409);
    expect((late.body.error as { reasonCode: string }).reasonCode).toBe("CONFIRMATION_TURN_STALE");
    const commit = await call.tool("commit_appointment_change", { actionId: change.actionId, digest: change.actionDigest });
    expect(commit.status).not.toBe("SUCCESS");
    expect((await call.pending()).status).toBe(404);
    expect(effectsFor(hh)).toHaveLength(0);
    expect((await hh.c.fixtures.scheduling.getAppointment(APPT))?.startsAt).toBe(APPOINTMENTS[0].startsAt);
    const events = await hh.auditFor(call.callId);
    expect(events.some((e) => e.action === "turn.barge_in" && e.outcome === "INVALIDATED")).toBe(true);
    expect(events.some((e) => e.action === "action.confirmation_captured" && e.reasonCode === "CONFIRMATION_TURN_STALE")).toBe(true);
    await hh.expectAuditChainIntact();
  }, 120_000);

  it("[SPEC-16.fault-duplicate-webhooks][ACT-02][SAFE-04][TB-09] transfer events delivered twice and out of order through the webhook: state stays correct, one dial, each transition applied once", async () => {
    const hh = await start();
    const call = hh.call();
    await call.start();
    // The fixture's own lifecycle events are never delivered here; only signed webhook deliveries drive the state.
    hh.c.fixtures.telephony.scriptNextTransfer({ outcome: "STALLED", after: "REQUESTED" });
    const req = await call.human({ reason: "CALLER_REQUESTED_HUMAN", language: "en", issueCategory: null });
    const transferId = req.body.transferId as string;
    const handoffId = req.body.handoffId as string;
    const ev = (event: string, n: number) => ({ transferId, event, eventId: `td-evt-${transferId.slice(4, 16)}-${n}` });

    // Out of order: BRIDGED before RECEIVER_ACCEPTED is rejected, never skipping the acceptance.
    expect((await hh.transferEvent(ev("BRIDGED", 3))).body).toMatchObject({ decision: "rejected" });
    expect((await hh.transferEvent(ev("QUEUED", 1))).body).toMatchObject({ decision: "applied" });
    expect((await hh.transferEvent(ev("RECEIVER_ACCEPTED", 2))).body).toMatchObject({ decision: "applied" });
    // Duplicate (same event id, fresh signature): idempotent.
    hh.clock.advanceMs(1000);
    expect((await hh.transferEvent(ev("RECEIVER_ACCEPTED", 2))).body).toMatchObject({ decision: "duplicate" });
    // An exact replay of a signed delivery is refused outright.
    const replayBody = ev("QUEUED", 1);
    const first = await hh.transferEvent(replayBody);
    expect(first.body).toMatchObject({ decision: "duplicate" });
    const replay = await hh.transferEvent(replayBody);
    expect(replay.status).toBe(401);
    // Late, in order now.
    expect((await hh.transferEvent(ev("BRIDGED", 3))).body).toMatchObject({ decision: "applied" });
    expect((await hh.transferEvent(ev("CALLER_CONFIRMED_CONNECTED", 4))).body).toMatchObject({ decision: "applied" });
    hh.clock.advanceMs(1000);
    expect((await hh.transferEvent(ev("CALLER_CONFIRMED_CONNECTED", 4))).body).toMatchObject({ decision: "duplicate" });

    const j = await journeyOf(hh, handoffId);
    expect(j.status).toBe("CONNECTED");
    const attempt = j.attempts.find((a) => a.transferId === transferId);
    expect(attempt?.history.map((x) => x.state)).toEqual(["REQUESTED", "QUEUED", "RECEIVER_ACCEPTED", "BRIDGED", "CALLER_CONFIRMED_CONNECTED"]);
    expect(hh.c.fixtures.telephony.dials.filter((d) => d.callId === call.callId)).toHaveLength(1);
    const events = await hh.auditFor(call.callId);
    const applied = events.filter((e) => e.action === "transfer.state_changed");
    expect(applied).toHaveLength(4);
    expect((await call.end("TRANSFERRED")).outcome).toBe("TRANSFERRED");
    await hh.expectAuditChainIntact();
  }, 120_000);

  it("[SPEC-16.fault-crash-after-commit][ACT-02][ACT-03] provider commits, then the process dies before recording it: the caller is never told success; the worker reconciler records COMMITTED once (one effect)", async () => {
    const hh = await start();
    const call = await verifiedClient(hh);
    const slots = await openSlots(call);
    const change = await prepare(call, slots[0] as Option);
    await call.confirmPending();

    // LOCAL FIXTURE crash simulation: right after the provider applies the change, every database
    // write of this process fails (the process is gone) until it "restarts".
    const port = hh.c.business.providers["appointment.reschedule"];
    expect(port).toBeDefined();
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
    let result: ToolResultView;
    try {
      result = await call.tool("commit_appointment_change", { actionId: change.actionId, digest: change.actionDigest });
    } finally {
      (hh.c.db as { tx: typeof realTx }).tx = realTx;
      (port as { commit: typeof realCommit }).commit = realCommit;
    }
    // The caller is never told the change succeeded without recorded evidence.
    expect(result.status).not.toBe("SUCCESS");
    expect(result.speech).toBeNull();
    expect(effectsFor(hh)).toHaveLength(1);
    expect((await ledgerState(hh, change.actionId))?.state).toBe("COMMITTING");

    // After restart the worker reconciler (stale COMMITTING) looks the commit up by its idempotency key.
    hh.clock.advanceMs(31_000);
    await hh.runWorker(["actions.reconcile", "outbox.dispatch", "outbox.consume"]);
    expect((await ledgerState(hh, change.actionId))?.state).toBe("COMMITTED");
    expect(effectsFor(hh)).toHaveLength(1);
    await hh.runWorker(["actions.reconcile", "outbox.dispatch", "outbox.consume"]);
    expect(effectsFor(hh)).toHaveLength(1);
    const recon = await hh.q<{ result: string }>("select result from action_reconciliations where action_id = $1", [change.actionId]);
    expect(recon.map((r) => r.result)).toContain("COMMITTED");
    const [idx] = await hh.q<{ receipt_outcome: string | null }>("select receipt_outcome from interaction_actions where action_id = $1", [change.actionId]);
    expect(idx?.receipt_outcome).toBe("COMMITTED");
    expect((await call.end()).outcome).toBe("RESOLVED");
  }, 120_000);

  it("[SPEC-16.fault-salesforce-outage][SPEC-8.salesforce][ACT-02] Salesforce outage: internal SR reference spoken (never a Case number), sync RETRY then DEAD_LETTER, operator repair syncs exactly one Case", async () => {
    const hh = await start();
    const call = await verifiedClient(hh);
    const faultId = hh.c.fixtures.faults.inject({ integrationId: "salesforce", operation: "*", kind: "OUTAGE", mode: "persistent" });
    const created = await call.tool("create_support_request", { issueCategory: "billing_question", linkToAccount: true, urgency: "STANDARD", language: "en" });
    expect(created.status).toBe("SUCCESS");
    expect(created.speech?.templateId).toBe("support_reference.pending_sync");
    const ref = (created.data?.request as { supportReference: string }).supportReference;
    expect(ref).toMatch(/^SR-/);
    const tenantId = hh.c.config.tenantId;
    const srs = hh.c.business.supportRequests;

    await hh.runWorker(["outbox.dispatch", "outbox.consume"]);
    let sr = await srs.getByReference(tenantId, ref);
    expect(sr).toMatchObject({ syncState: "RETRY_SCHEDULED", salesforceCaseId: null });
    // Retries until the bounded budget is exhausted (the sweep the worker must run: retryDue).
    for (let i = 0; i < 8 && sr?.syncState !== "DEAD_LETTER"; i++) {
      hh.clock.advanceMs(1_000_000);
      await srs.retryDue?.(tenantId);
      await hh.runWorker(["outbox.dispatch", "outbox.consume"]);
      sr = await srs.getByReference(tenantId, ref);
    }
    expect(sr?.syncState).toBe("DEAD_LETTER");
    expect(hh.c.fixtures.supportRecords.records().cases).toHaveLength(0);

    // Salesforce recovers; the operator repairs the dead letter (audited); exactly one Case.
    hh.c.fixtures.faults.clear(faultId);
    await srs.repairDeadLetter?.(tenantId, sr?.supportRequestId as string, { actorRef: STAFF.supervisor.staffId, reasonCode: "ROOT_CAUSE_FIXED" });
    await hh.runWorker(["outbox.dispatch", "outbox.consume"]);
    sr = await srs.getByReference(tenantId, ref);
    expect(sr?.syncState).toBe("SYNCED");
    expect(hh.c.fixtures.supportRecords.records().cases.filter((x) => x.caseId === sr?.salesforceCaseId)).toHaveLength(1);
    await srs.retryDue?.(tenantId);
    await hh.runWorker(["outbox.dispatch", "outbox.consume"]);
    expect(hh.c.fixtures.supportRecords.records().cases).toHaveLength(1);
    // The caller heard the internal reference as pending synchronization, never a Salesforce Case number.
    for (const u of call.utterances()) expect(u).not.toContain(sr?.salesforceCaseId as string);
    await hh.expectAuditChainIntact();
  }, 120_000);

  // Formerly KNOWN FAILING: no worker loop ran PgSupportRequestService.retryDue, so a request whose
  // first sync failed stayed RETRY_SCHEDULED forever. Fixed by the `support.sync_retry` loop in
  // src/worker/worker.ts workerLoopsFor (SupportSyncRetryLoop, src/worker/loops.ts), which re-enqueues
  // due requests per tenant; dispatch/consume then sync them (or dead-letter after the budget).
  it("[SPEC-16.fault-salesforce-outage][SPEC-8.salesforce] with only the composed worker loops, a request whose sync failed during the outage syncs after Salesforce recovers", async () => {
    const hh = await start();
    const call = await verifiedClient(hh);
    const faultId = hh.c.fixtures.faults.inject({ integrationId: "salesforce", operation: "*", kind: "OUTAGE", mode: "persistent" });
    const created = await call.tool("create_support_request", { issueCategory: "billing_question", linkToAccount: true, urgency: "STANDARD", language: "en" });
    const ref = (created.data?.request as { supportReference: string }).supportReference;
    await hh.runWorker(["outbox.dispatch", "outbox.consume"]);
    hh.c.fixtures.faults.clear(faultId);
    for (let i = 0; i < 4; i++) {
      hh.clock.advanceMs(1_000_000);
      await hh.runWorker([...hh.loops.keys()].filter((n) => n !== "retention.run"));
    }
    expect((await hh.c.business.supportRequests.getByReference(hh.c.config.tenantId, ref))?.syncState).toBe("SYNCED");
  }, 120_000);

  it("[SPEC-16.fault-failed-transfer][SAFE-03][SAFE-04][OPS-02] every staffed route fails: approved updates, the outage-continuity destination, then holding for operations; the call is never ended", async () => {
    const hh = await start();
    const call = hh.call();
    await call.start();
    const tel = hh.c.fixtures.telephony;
    tel.scriptDestination("dst_support_general", { outcome: "RECEIVER_UNAVAILABLE" });
    tel.scriptDestination("dst_outage_continuity", { outcome: "STALLED", after: "QUEUED" });
    const req = await call.human({ reason: "CALLER_REQUESTED_HUMAN", language: "en", issueCategory: null });
    const handoffId = req.body.handoffId as string;
    await hh.runWorker(["telephony.local_fixture_delivery"]);
    let j = await journeyOf(hh, handoffId);
    expect(j.attempts.map((a) => a.destinationId)).toEqual(["dst_support_general", "dst_outage_continuity"]);
    expect(j.status).toBe("ROUTING");
    // Continuity attempts time out (engineering default 60 s) and are retried within the bounded budget.
    for (let i = 0; i < 6; i++) {
      hh.clock.advanceMs(61_000);
      await hh.runWorker(["transfers.sweep", "telephony.local_fixture_delivery"]);
    }
    j = await journeyOf(hh, handoffId);
    expect(j.status).toBe("HOLDING_FOR_OPERATIONS");
    expect(j.connectedAt).toBeNull();
    expect(j.attempts.filter((a) => a.destinationId === "dst_outage_continuity").length).toBe(3);
    expect(tel.updates.filter((u) => u.callId === call.callId).map((u) => u.templateId)).toContain("transfer.failed_next_route");
    // Never ended: the session is still live (Studio keeps the caller on the continuity route) and nothing hung up.
    const ctx = await call.handoffContext();
    expect(ctx.status).toBe(200);
    expect("hangUp" in tel).toBe(false);
    const events = await hh.auditFor(call.callId);
    expect(events.some((e) => e.action === "transfer.holding_for_operations" && e.reasonCode === "STAFFED_ROUTES_EXHAUSTED")).toBe(true);
    expect(events.some((e) => e.action === "session.ended")).toBe(false);
    await hh.expectAuditChainIntact();
  }, 120_000);

  it("[SPEC-16.fault-audit-outage][OPS-01][SAFE-02] durable audit evidence cannot be written: the consequential commit is blocked before any provider effect; the safety route still works", async () => {
    const hh = await start();
    const call = await verifiedClient(hh);
    const slots = await openSlots(call);
    const change = await prepare(call, slots[0] as Option);
    await call.confirmPending();
    const deliveriesBefore = hh.c.fixtures.scheduling.deliveries.length;

    // LOCAL FIXTURE audit outage: the runtime role loses INSERT on the durable audit outbox.
    await hh.q("revoke insert on audit_outbox from app_runtime");
    let commit: ToolResultView;
    let screened: { status: number; body: Record<string, unknown> };
    try {
      commit = await call.tool("commit_appointment_change", { actionId: change.actionId, digest: change.actionDigest });
      hh.c.fixtures.telephony.scriptDestination("dst_safety_priority", { outcome: "CONNECTED" });
      screened = await call.screen("i want to kill myself");
    } finally {
      await hh.q("grant insert on audit_outbox to app_runtime");
    }
    expect(commit.status).not.toBe("SUCCESS");
    expect(commit.speech).toBeNull();
    expect(hh.c.fixtures.scheduling.deliveries.length).toBe(deliveriesBefore);
    expect(effectsFor(hh)).toHaveLength(0);
    expect((await ledgerState(hh, change.actionId))?.state).not.toBe("COMMITTED");
    expect((await hh.c.fixtures.scheduling.getAppointment(APPT))?.startsAt).toBe(APPOINTMENTS[0].startsAt);

    expect(screened.body).toMatchObject({ route: "SAFETY_PRIORITY_HUMAN", destinationId: "dst_safety_priority" });
    expect(hh.c.fixtures.telephony.dials.filter((d) => d.callId === call.callId && d.priority === "SAFETY")).toHaveLength(1);
    await hh.runWorker(["telephony.local_fixture_delivery"]);
    expect((await journeyOf(hh, screened.body.handoffId as string)).status).toBe("CONNECTED");
    // Whatever evidence was written is still a valid chain (nothing half-written).
    await hh.expectAuditChainIntact();
  }, 120_000);
});
