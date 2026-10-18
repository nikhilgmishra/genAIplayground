/**
 * Transaction-safety journeys on the LOCAL FIXTURE composition (real container, Studio routes, REAL MCP
 * SDK client, console API, worker loops). SYNTHETIC data only. Each case reproduces a confirmed review
 * finding end to end and asserts the fixed, fail-closed behaviour:
 *   ACT-F1  barge-in / changed request while a commit is in doubt (ACT-01, ACT-03);
 *   ACT-F2  ambiguous intake timeout -> UNKNOWN_OUTCOME, no duplicate request/workflow (ACT-02, ACT-03);
 *   ACT-F3  staff retry after NOT_FOUND re-authorizes and respects confirmation freshness (ACT-01);
 *   ACT-F4  success speech from the authoritative receipt despite a stale read (ACT-05);
 *   ACT-F5  the trusted TC-07 readback states a modality change (ACT-01);
 *   VSP-GW-04 one idempotency-key grammar; tool.invoke audit never silently dropped (OPS-01, AUTH-02);
 *   DP-03   a closed request is never recapped as open (DATA-04).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APPOINTMENTS, PEOPLE, STAFF } from "../../src/fixtures/synthetic-world.js";
import { DependencyError } from "../../src/shared/errors.js";
import { AVERY, createJourneyHarness } from "./harness.js";
import type { JourneyCall, JourneyHarness, ToolResultView } from "./harness.js";

let h: JourneyHarness;
/**
 * A fresh composition per describe block: each case verifies SYNTHETIC Avery again, and the identity
 * service's per-account verification attempt limit (five per hour) must not leak between cases.
 */
function freshHarness(): void {
  beforeAll(async () => {
    h = await createJourneyHarness({ ingestKnowledge: false });
  }, 180_000);
  afterAll(async () => {
    await h?.close();
  });
}

const APPT = APPOINTMENTS[0].appointmentId;
type Option = { slotId: string | null; startsAt: string; status: string };

async function verifiedCall(): Promise<JourneyCall> {
  const call = h.call();
  await call.start();
  await call.role("client");
  expect((await call.verify(AVERY, "avery.synthetic")).bound).toBe(true);
  return call;
}

async function openOptions(call: JourneyCall): Promise<Option[]> {
  const opts = await call.tool("get_appointment_options", { appointmentId: APPT, fromDate: "2026-10-20", toDate: "2026-10-31" });
  return ((opts.data?.appointments as Option[]) ?? []).filter((a) => a.status === "OPEN");
}

async function prepareConfirmed(call: JourneyCall, slot: Option): Promise<{ actionId: string; actionDigest: string }> {
  const prep = await call.tool("prepare_appointment_change", { appointmentId: APPT, startsAt: slot.startsAt, modality: null, slotId: slot.slotId });
  expect(prep.status).toBe("SUCCESS");
  await call.confirmPending();
  return prep.data?.change as { actionId: string; actionDigest: string };
}

/** LOCAL FIXTURE: the provider call times out ambiguously BEFORE it reaches the scheduling system (nothing applied). */
async function commitLost(call: JourneyCall, change: { actionId: string; actionDigest: string }): Promise<ToolResultView> {
  const port = h.c.business.providers["appointment.reschedule"];
  const realCommit = port?.commit.bind(port) as NonNullable<typeof port>["commit"];
  (port as { commit: typeof realCommit }).commit = async () => {
    throw new DependencyError("TIMEOUT_AFTER_SEND", "UNKNOWN");
  };
  try {
    return await call.tool("commit_appointment_change", { actionId: change.actionId, digest: change.actionDigest });
  } finally {
    (port as { commit: typeof realCommit }).commit = realCommit;
  }
}

const effectsFor = (appointmentId: string) => h.c.fixtures.scheduling.effects.filter((e) => JSON.stringify(e).includes(appointmentId));
const ledgerState = async (actionId: string) => (await h.q<{ state: string; state_reason: string | null }>("select state, state_reason from action_ledger where action_id = $1", [actionId]))[0];

describe("[ACT-F1] interruptions while a commit is in doubt", () => {
  freshHarness();
  it("[ACT-01][ACT-03][ACT-F1] Studio barge-in after UNKNOWN_OUTCOME: the model's re-commit is refused, the ledger is INVALIDATED and the appointment is unchanged", async () => {
    const call = await verifiedCall();
    const [slot] = await openOptions(call);
    if (!slot) throw new Error("NO_OPEN_SLOT");
    const before = effectsFor(APPT).length;
    const change = await prepareConfirmed(call, slot);
    const unknown = await commitLost(call, change);
    expect(unknown.status).toBe("UNKNOWN_OUTCOME");
    expect(unknown.speech).toBeNull();

    const barge = await call.bargeIn();
    expect(barge.status).toBe(200);
    expect((await ledgerState(change.actionId))?.state).toBe("UNKNOWN");

    h.clock.advanceMs(10_000);
    const again = await call.tool("commit_appointment_change", { actionId: change.actionId, digest: change.actionDigest });
    expect(again.status).not.toBe("SUCCESS");
    expect(again.reasonCode).toBe("ACTION_NOT_COMMITTABLE");
    expect(await ledgerState(change.actionId)).toMatchObject({ state: "INVALIDATED", state_reason: "BARGE_IN" });
    expect(effectsFor(APPT).length).toBe(before);
    expect(call.heard.some((x) => x.templateId === "appointment.change_committed")).toBe(false);
    await call.end();
  }, 120_000);
});

describe("[ACT-F3] staff retry after a NOT_FOUND reconciliation", () => {
  freshHarness();
  it("[ACT-01][SAFE-02][ACT-F3] a safety escalation while the commit is in doubt: the console reconcile INVALIDATES, the staff retry commits nothing", async () => {
    const call = await verifiedCall();
    const [slot] = await openOptions(call);
    if (!slot) throw new Error("NO_OPEN_SLOT");
    const before = effectsFor(APPT).length;
    const change = await prepareConfirmed(call, slot);
    expect((await commitLost(call, change)).status).toBe("UNKNOWN_OUTCOME");
    const screened = await call.screen("i want to kill myself");
    expect(screened.status).toBe(200);

    h.clock.advanceMs(30_000);
    const rec = await h.consoleRequest(STAFF.supervisor, "POST", `/console/api/v1/reconciliation/${change.actionId}/reconcile`, {}, "idem_synthTxConsoleRecon001");
    expect(rec.status).toBe(200);
    expect(rec.body).toMatchObject({ state: "INVALIDATED", retryEligible: false, result: { result: "NOT_FOUND" } });
    const reconciliationId = (rec.body.result as { reconciliationId: string }).reconciliationId;
    const retry = await h.consoleRequest(STAFF.supervisor, "POST", `/console/api/v1/reconciliation/${change.actionId}/retry`, { reconciliationId, reason: "RECONCILED_NOT_FOUND_RETRY" }, "idem_synthTxConsoleRetry001");
    expect(retry.status).not.toBe(200);
    expect((await ledgerState(change.actionId))?.state).toBe("INVALIDATED");
    expect(effectsFor(APPT).length).toBe(before);
  }, 120_000);

  it("[ACT-01][ACT-F3] the staff retry is refused once the caller's confirmation is stale (180 s): the action expires, nothing is sent", async () => {
    const call = await verifiedCall();
    const [slot] = await openOptions(call);
    if (!slot) throw new Error("NO_OPEN_SLOT");
    const before = effectsFor(APPT).length;
    const change = await prepareConfirmed(call, slot);
    expect((await commitLost(call, change)).status).toBe("UNKNOWN_OUTCOME");
    h.clock.advanceMs(60_000);
    const rec = await h.consoleRequest(STAFF.supervisor, "POST", `/console/api/v1/reconciliation/${change.actionId}/reconcile`, {}, "idem_synthTxConsoleRecon002");
    expect(rec.body).toMatchObject({ state: "CONFIRMED", result: { result: "NOT_FOUND" } });
    const reconciliationId = (rec.body.result as { reconciliationId: string }).reconciliationId;
    h.clock.advanceMs(120_000);
    const retry = await h.consoleRequest(STAFF.supervisor, "POST", `/console/api/v1/reconciliation/${change.actionId}/retry`, { reconciliationId, reason: "RECONCILED_NOT_FOUND_RETRY" }, "idem_synthTxConsoleRetry002");
    expect(retry.status).not.toBe(200);
    expect((await ledgerState(change.actionId))?.state).toBe("EXPIRED");
    expect(effectsFor(APPT).length).toBe(before);
    await call.end();
  }, 120_000);
});

describe("[ACT-F4][ACT-F5] receipt-bound success speech and complete readback", () => {
  freshHarness();
  it("[ACT-01][ACT-F5] a reschedule to an in-person slot: the trusted TC-07 prompt states the visit type change before the caller confirms", async () => {
    h.c.fixtures.store.insert("slots", {
      slotId: "slt_synthTxInPerson00001",
      providerActorId: PEOPLE.morgan.actorId,
      providerDisplayName: "Dr. Morgan",
      startsAt: "2026-10-29T17:00:00.000Z",
      timeZone: "America/Chicago",
      modality: "in_person",
      heldBy: null,
    });
    const call = await verifiedCall();
    expect((await h.c.fixtures.scheduling.getAppointment(APPT))?.modality).toBe("video");
    const prep = await call.tool("prepare_appointment_change", { appointmentId: APPT, startsAt: "2026-10-29T17:00:00.000Z", modality: null, slotId: "slt_synthTxInPerson00001" });
    expect(prep.status).toBe("SUCCESS");
    const p = await call.pending();
    expect(p.status).toBe(200);
    expect(p.body.routeToHuman).toBe(false);
    expect(String(p.body.promptText)).toBe(
      "To confirm, I'll move your video appointment from October 22, 2026 at 12:00 PM, Central Time, to October 29, 2026 at 12:00 PM, Central Time, as an in-person visit. Say yes to confirm, or no to keep it.",
    );
    await call.end();
  }, 120_000);

  it("[ACT-05][ACT-F4] a stale read after the commit: the tool result and the caller hear the NEW time from the receipt, never the old one", async () => {
    const call = await verifiedCall();
    const [slot] = await openOptions(call);
    if (!slot) throw new Error("NO_OPEN_SLOT");
    const original = await h.c.fixtures.scheduling.getAppointment(APPT);
    const change = await prepareConfirmed(call, slot);
    // getAppointment #1 = commit resolveResource, #2 = ledger currentVersion, #3 = the post-commit read (stale).
    h.c.fixtures.faults.inject({ integrationId: "scheduling", operation: "getAppointment", kind: "STALE_READ", skip: 2 });
    const commit = await call.tool("commit_appointment_change", { actionId: change.actionId, digest: change.actionDigest });
    expect(commit.status).toBe("SUCCESS");
    const rec = (commit.data?.appointments as { startsAt: string }[])[0];
    expect(rec?.startsAt).toBe(slot.startsAt);
    expect(rec?.startsAt).not.toBe(original?.startsAt);
    const heard = call.heard.at(-1);
    expect(heard?.templateId).toBe("appointment.change_committed");
    expect((await h.c.fixtures.scheduling.getAppointment(APPT))?.startsAt).toBe(slot.startsAt);
    const when = new Date(slot.startsAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/Chicago" });
    expect(heard?.utterance).toContain(when);
    await call.end();
  }, 120_000);
});

describe("[ACT-F2] ambiguous intake timeout", () => {
  freshHarness();
  it("[ACT-02][ACT-03][ACT-F2] submit_complaint times out after it started: UNKNOWN_OUTCOME, the same-key retry replays the one complaint and workflow", async () => {
    const call = await verifiedCall();
    const count = async () => (await h.q<{ n: string }>("select count(*)::text as n from support_requests where call_id = $1 and issue_category = 'complaint'", [call.callId]))[0]?.n;
    const workflows = async () => (await h.q<{ n: string }>("select count(*)::text as n from workflow_instances where workflow_type = 'complaint_review'"))[0]?.n;
    const wfBefore = Number(await workflows());
    // The 2nd relationship lookup of the next tool call happens inside submit_complaint's execute (5000 ms timeout).
    h.c.fixtures.faults.inject({ integrationId: "relationship-directory", operation: "relationshipsFor", kind: "SLOW", delayMs: 5600, skip: 1 });
    const key = "idem_synthTxComplaintTimeout1";
    const args = { category: "SERVICE_EXPERIENCE", wantsCallback: false, language: "en" };
    const first = await call.tool("submit_complaint", args, { idempotencyKey: key });
    expect(first.status).toBe("UNKNOWN_OUTCOME");
    expect(first.speech).toBeNull();
    // The timed-out execution is not cancellable; let it finish and settle the reservation.
    await new Promise((r) => setTimeout(r, 1500));
    expect(await count()).toBe("1");
    let retry = await call.tool("submit_complaint", args, { idempotencyKey: key });
    for (let i = 0; i < 20 && retry.status === "RETRYABLE_FAILURE"; i++) {
      await new Promise((r) => setTimeout(r, 100));
      retry = await call.tool("submit_complaint", args, { idempotencyKey: key });
    }
    expect(retry.status).toBe("SUCCESS");
    expect(await count()).toBe("1");
    expect(Number(await workflows())).toBe(wfBefore + 1);
    await call.end();
  }, 120_000);
});

describe("[VSP-GW-04] idempotency-key grammar over MCP", () => {
  freshHarness();
  it("[AUTH-02][OPS-01][SAFE-02][VSP-GW-04] a date-shaped key is refused on a protected read with IDEMPOTENCY_KEY_INVALID (readiness unaffected); a safety route with one is still routed and audited", async () => {
    const call = await verifiedCall();
    const read = await call.tool("get_appointment_options", { appointmentId: APPT, fromDate: "2026-10-20", toDate: "2026-10-31" }, { idempotencyKey: "2026-10-18-turn-0007-read" });
    expect(read.status).toBe("PERMANENT_FAILURE");
    expect(read.reasonCode).toBe("IDEMPOTENCY_KEY_INVALID");
    expect(read.auditEventId).not.toBeNull();
    const ok = await call.tool("get_appointment_options", { appointmentId: APPT, fromDate: "2026-10-20", toDate: "2026-10-31" }, { idempotencyKey: "8f14e45f-ceea-467a-9575-1d1a2b3c4d5e" });
    expect(ok.status).toBe("SUCCESS");
    const safety = await call.tool("request_safety_route", { signalSource: "EXPLICIT_PHRASE", concernSubject: "SELF", language: "en" }, { idempotencyKey: "2026-10-18-turn-0002-saf" });
    expect(["SUCCESS", "PENDING"]).toContain(safety.status);
    expect(safety.auditEventId).not.toBeNull();
    // The refusal is recorded as tool.invoke (correlated by request id; it precedes session resolution).
    const refused = await h.c.auditQuery.search({ tenantId: h.c.config.tenantId, correlationId: (read as unknown as { requestId: string }).requestId, limit: 10 });
    expect(refused.map((e) => [e.action, e.reasonCode])).toContainEqual(["tool.invoke", "IDEMPOTENCY_KEY_INVALID"]);
    const routed = await h.c.auditQuery.search({ tenantId: h.c.config.tenantId, correlationId: (safety as unknown as { requestId: string }).requestId, limit: 10 });
    expect(routed.some((e) => e.action === "tool.invoke" && e.idempotencyKey === null)).toBe(true);
    expect(JSON.stringify([...refused, ...routed, ...(await h.auditFor(call.callId))])).not.toContain("2026-10-18-turn");
  }, 120_000);
});

describe("[DP-03] repeat-caller recap", () => {
  freshHarness();
  it("[DATA-04][DP-03] a linked complaint the workflow closed is not recapped as open on the next verified call", async () => {
    const first = await verifiedCall();
    const created = await first.tool("submit_complaint", { category: "STAFF_CONDUCT", wantsCallback: false, language: "en" });
    expect(created.status).toBe("SUCCESS");
    const ref = (created.data?.complaint as { supportReference: string }).supportReference;
    await first.end();
    const trace = await h.c.business.supportRequests.trace(h.c.config.tenantId, ref);
    const workflowId = trace?.workflowIds[0];
    if (!workflowId) throw new Error("WORKFLOW_MISSING");
    const wf = await h.c.workflows.signal({ tenantId: h.c.config.tenantId, workflowId, event: "CANCEL", actor: { kind: "system", ref: null } });
    expect(wf.state).toBe("CANCELLED");

    h.clock.advanceMs(600_000);
    const repeat = await verifiedCall();
    const status = await repeat.tool("get_authorized_case_status", { supportReference: null });
    expect(status.status).toBe("SUCCESS");
    // The authoritative record says CLOSED ...
    expect((status.data?.cases as { caseRef: string; status: string }[]).find((c) => c.caseRef === ref)?.status).toBe("CLOSED");
    // ... so the newest memory entry (this complaint) is skipped: any recap names a request that is still open.
    if (status.speech?.templateId === "case.recap_open_issue") expect(status.speech.slots.supportReference).not.toBe(ref);
    const spokenRef = ref.replace(/^SR-/, "");
    expect(repeat.heard.some((x) => x.templateId === "case.recap_open_issue" && (x.utterance ?? "").includes(spokenRef.slice(0, 1)) && JSON.stringify(status.speech?.slots ?? {}).includes(ref))).toBe(false);
    await repeat.end();
  }, 120_000);
});
