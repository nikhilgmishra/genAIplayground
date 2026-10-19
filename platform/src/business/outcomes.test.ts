/**
 * Interaction outcome measurement (spec section 13 "Measure verified resolution, 24-hour and 7-day
 * repeat contact ... Keep containment separate from resolution"; SPEC-13.resolution-metrics) over the
 * REAL modules (PGlite with every migration, OPA bundle, ledger, identity) and LOCAL SYNTHETIC
 * fixtures (business/testing/harness.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db, QueryResult, Queryable, TxOptions } from "../db/types.js";
import { APPOINTMENTS, OTHER_TENANT_ID, PEOPLE, SLOTS, TENANT_ID } from "../fixtures/synthetic-world.js";
import { createMemoryLogger } from "../observability/logger.js";
import { CONTRACT_INTENTS, DEFAULT_METRIC_CATALOGUE, REPEAT_CONTACT_WINDOWS } from "../observability/metrics.js";
import type { AuthContext } from "../protocol/index.js";
import type { ToolDeps } from "./contract.js";
import { RESOLUTION_CONTRACTS } from "./contracts/index.js";
import { BusinessOutcomeService, DEFAULT_REPEAT_CONTACT_POLICY, REPEAT_CONTACT_WINDOW_MS, isContained, isVerifiedResolution } from "./outcomes.js";
import { InteractionIndex } from "./interactions.js";
import { createBusinessHarness, expectDone, type BusinessHarness } from "./testing/harness.js";

let h: BusinessHarness;
beforeEach(async () => {
  h = await createBusinessHarness();
});
afterEach(async () => {
  await h.close();
});

const NONE = { commitReceiptIds: [] as string[], informationProvided: false, requestAccepted: false, transferConnected: false, callerDisconnected: false, policyDeclined: false, failed: false };
const HOUR = 3_600_000;

let seq = 0;
const callId = (label: string) => `cal_synthOutcome${label}${String(++seq).padStart(6, "0")}`;

async function verifiedCall(person: (typeof PEOPLE)[keyof typeof PEOPLE], label: string): Promise<AuthContext> {
  const { sessionRef } = await h.startCall(callId(label));
  return h.verify(person, sessionRef);
}

type PreparedChange = { actionId: string; actionDigest: string };

/** Prepared (not yet confirmed or committed) reschedule of Avery's appointment. */
async function prepareReschedule(auth: AuthContext): Promise<PreparedChange> {
  const appointment = APPOINTMENTS[0] as (typeof APPOINTMENTS)[number];
  const p = expectDone(await h.invoke("prepare_appointment_change", auth, { appointmentId: appointment.appointmentId, startsAt: (SLOTS[0] as (typeof SLOTS)[number]).startsAt, modality: null }));
  if (p.outcome.status !== "SUCCESS") throw new Error(`prepare ${p.outcome.status}`);
  return (p.outcome.data as { change: PreparedChange }).change;
}

async function confirmAndCommit(auth: AuthContext, change: PreparedChange): Promise<void> {
  await h.confirm(auth, change.actionId, change.actionDigest);
  const c = expectDone(await h.invoke("commit_appointment_change", auth, { actionId: change.actionId, digest: change.actionDigest }));
  if (c.outcome.status !== "SUCCESS") throw new Error(`commit ${c.outcome.status}`);
}

/** Every statement each transaction ran, in order, through a pass-through wrapper of the harness database. */
function recordingDb(inner: Db): { db: Db; txs: { sql: string; params: unknown[] }[][] } {
  const txs: { sql: string; params: unknown[] }[][] = [];
  const db: Db = {
    engine: inner.engine,
    query<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
      return inner.query<T>(sql, params);
    },
    exec: (sql: string) => inner.exec(sql),
    close: () => inner.close(),
    tx<T>(fn: (tx: Queryable) => Promise<T>, opts?: TxOptions): Promise<T> {
      return inner.tx((q) => {
        const log: { sql: string; params: unknown[] }[] = [];
        txs.push(log);
        return fn({
          query<R>(sql: string, params?: unknown[]): Promise<QueryResult<R>> {
            log.push({ sql, params: params ?? [] });
            return q.query<R>(sql, params);
          },
          exec: (sql: string) => q.exec(sql),
        });
      }, opts);
    },
  };
  return { db, txs };
}

/** Verified reschedule of Avery's appointment: prepare -> trusted confirmation -> commit. Returns the receipt id. */
async function commitReschedule(auth: AuthContext, slot: (typeof SLOTS)[number] = SLOTS[0] as (typeof SLOTS)[number]): Promise<{ actionId: string; receiptId: string }> {
  const appointment = APPOINTMENTS[0] as (typeof APPOINTMENTS)[number];
  const p = expectDone(await h.invoke("prepare_appointment_change", auth, { appointmentId: appointment.appointmentId, startsAt: slot.startsAt, modality: null }));
  if (p.outcome.status !== "SUCCESS") throw new Error(`prepare ${p.outcome.status}`);
  const change = (p.outcome.data as { change: { actionId: string; actionDigest: string } }).change;
  await h.confirm(auth, change.actionId, change.actionDigest);
  const c = expectDone(await h.invoke("commit_appointment_change", auth, { actionId: change.actionId, digest: change.actionDigest }));
  if (c.outcome.status !== "SUCCESS") throw new Error(`commit ${c.outcome.status}`);
  const receiptId = (c.outcome.data as { appointments: { receiptId: string | null }[] }).appointments[0]?.receiptId as string;
  return { actionId: change.actionId, receiptId };
}

async function linkedSupportRequest(auth: AuthContext): Promise<void> {
  const r = expectDone(await h.invoke("create_support_request", auth, { issueCategory: "appointment", linkToAccount: true, urgency: "STANDARD", language: "en" }));
  if (r.outcome.status !== "SUCCESS") throw new Error(`support request ${r.outcome.status}`);
}

const record = (auth: Pick<AuthContext, "tenantId" | "callId">, evidence: Partial<typeof NONE>, extra: { contractId?: string | null; subjectRef?: string | null } = {}) =>
  h.business.outcomes.record({ tenantId: auth.tenantId, callId: auth.callId, contractId: extra.contractId ?? null, evidence: { ...NONE, ...evidence }, ...(extra.subjectRef !== undefined ? { subjectRef: extra.subjectRef } : {}) } as Parameters<
    BusinessHarness["business"]["outcomes"]["record"]
  >[0]);

const subjectRefOf = async (call: string): Promise<(string | null)[]> =>
  (
    await h.db.tx((tx) => tx.query<{ subject_ref: string | null }>("select subject_ref from interaction_outcomes where call_id = $1 order by recorded_at, outcome_id", [call]), {
      role: "owner",
    })
  ).rows.map((r) => r.subject_ref);

const checks = (result: string) => h.metrics.counterValue("vsp_repeat_contact_checks_total", { result });
const repeats = (match: Record<string, string> = {}) => h.metrics.counterValue("vsp_repeat_contacts_total", match);

describe("outcome metrics: intent labels", () => {
  it("[SPEC-13.resolution-metrics][DATA-01] every resolution-contract intent is in the catalogue's closed intent allowlist", () => {
    const allowed = DEFAULT_METRIC_CATALOGUE.get("vsp_interaction_outcomes_total")?.labels.intent ?? [];
    for (const c of RESOLUTION_CONTRACTS) expect(allowed, c.contractId).toContain(c.intent);
    expect([...CONTRACT_INTENTS].sort()).toEqual([...new Set([...RESOLUTION_CONTRACTS.map((c) => c.intent), "unknown"])].sort());
  });

  it("[SPEC-13.resolution-metrics][DATA-01] the outcome counter carries the contract intent (or unknown), never a collapsed 'other'", async () => {
    const auth = await verifiedCall(PEOPLE.avery, "Intent");
    const { receiptId } = await commitReschedule(auth);
    expect((await record(auth, { commitReceiptIds: [receiptId] })).outcome).toBe("RESOLVED");
    const anon = (await h.startCall(callId("IntentAnon"))).ctx;
    await record(anon, { callerDisconnected: true });
    expect(h.metrics.counterValue("vsp_interaction_outcomes_total", { outcome: "RESOLVED", intent: "appointment_reschedule" })).toBe(1);
    expect(h.metrics.counterValue("vsp_interaction_outcomes_total", { outcome: "CALLER_DISCONNECTED", intent: "unknown" })).toBe(1);
    expect(h.metrics.counterValue("vsp_metric_label_rejections_total")).toBe(0);
  });
});

describe("verified resolution is separate from containment", () => {
  it("[SPEC-13.resolution-metrics][ACT-04] a contained call that only got information is counted as contained and never as a verified resolution", async () => {
    const auth = await verifiedCall(PEOPLE.avery, "Contained");
    const d = await record(auth, { informationProvided: true }, { contractId: "invoice_explanation@1" });
    expect(d.outcome).toBe("INFORMATION_PROVIDED");
    expect(h.metrics.counterValue("vsp_contained_interactions_total", { outcome: "INFORMATION_PROVIDED", intent: "invoice_explanation" })).toBe(1);
    expect(h.metrics.counterValue("vsp_verified_resolutions_total")).toBe(0);
    // Hanging up without a transfer is containment too, and still not resolution.
    const gone = await verifiedCall(PEOPLE.avery, "ContainedHangup");
    expect((await record(gone, { callerDisconnected: true })).outcome).toBe("CALLER_DISCONNECTED");
    expect(h.metrics.counterValue("vsp_contained_interactions_total")).toBe(2);
    expect(h.metrics.counterValue("vsp_verified_resolutions_total")).toBe(0);
  });

  it("[SPEC-13.resolution-metrics][ACT-04] only RESOLVED with this call's verified receipt is a verified resolution; an accepted request or a claimed foreign receipt is not", async () => {
    const auth = await verifiedCall(PEOPLE.avery, "Verified");
    const { receiptId } = await commitReschedule(auth);
    expect((await record(auth, { commitReceiptIds: [receiptId] })).outcome).toBe("RESOLVED");
    expect(h.metrics.counterValue("vsp_verified_resolutions_total", { intent: "appointment_reschedule", source: "call_end" })).toBe(1);
    // Workflow acceptance / support-request creation is not issue resolution (ACT-04).
    const intake = await verifiedCall(PEOPLE.avery, "Accepted");
    expect((await record(intake, { requestAccepted: true }, { contractId: "support_intake@1" })).outcome).toBe("REQUEST_ACCEPTED");
    expect(h.metrics.counterValue("vsp_interaction_outcomes_total", { outcome: "REQUEST_ACCEPTED", intent: "support_intake" })).toBe(1);
    // Another call claiming the first call's receipt gets no resolution and no verified count.
    const other = await verifiedCall(PEOPLE.avery, "Claimed");
    expect((await record(other, { commitReceiptIds: [receiptId] }, { contractId: "appointment_reschedule@1" })).outcome).toBe("OUTCOME_UNKNOWN");
    expect(h.metrics.counterValue("vsp_verified_resolutions_total")).toBe(1);
  });

  it("[SPEC-13.resolution-metrics][SAFE-04] a connected or failed human transfer is never containment; transfers are not penalised as unresolved", async () => {
    const t = await verifiedCall(PEOPLE.avery, "Transferred");
    expect((await record(t, { transferConnected: true }, { contractId: "human_request@1" })).outcome).toBe("TRANSFERRED");
    const f = await verifiedCall(PEOPLE.avery, "TransferFailed");
    expect((await record(f, { failed: true })).outcome).toBe("FAILED");
    expect(h.metrics.counterValue("vsp_contained_interactions_total")).toBe(0);
    expect(h.metrics.counterValue("vsp_interaction_outcomes_total", { outcome: "TRANSFERRED", intent: "human_request" })).toBe(1);
    expect(isContained({ transferConnected: true, failed: false, transferAttempted: true })).toBe(false);
    expect(isContained({ transferConnected: false, failed: true, transferAttempted: false })).toBe(false);
    expect(isContained({ transferConnected: false, failed: false, transferAttempted: true })).toBe(false);
    expect(isContained({ transferConnected: false, failed: false, transferAttempted: false })).toBe(true);
    expect(["RESOLVED", "REQUEST_ACCEPTED", "TRANSFERRED", "INFORMATION_PROVIDED", "OUTCOME_UNKNOWN"].filter((o) => isVerifiedResolution(o as never))).toEqual(["RESOLVED"]);
  });

  it("[SPEC-13.resolution-metrics][SAFE-04] a human transfer requested but never connected (still ROUTING when the caller hangs up) is not containment", async () => {
    const { ctx } = await h.startCall(callId("Abandoned"));
    const r = expectDone(await h.invoke("request_human_transfer", ctx, { reason: "CALLER_REQUESTED_HUMAN", language: "en", issueCategory: null, accommodations: [] }));
    expect(r.outcome.status).toBe("SUCCESS");
    expect((await h.deps.transfers.journeysForCall(TENANT_ID, ctx.callId)).map((j) => [j.priority, j.status])).toEqual([["STANDARD", "ROUTING"]]);
    // The gateway's outcome evidence says only that the caller disconnected: no connected or failed transfer.
    expect((await record(ctx, { callerDisconnected: true })).outcome).toBe("CALLER_DISCONNECTED");
    expect(h.metrics.counterValue("vsp_interaction_outcomes_total", { outcome: "CALLER_DISCONNECTED" })).toBe(1);
    expect(h.metrics.counterValue("vsp_contained_interactions_total")).toBe(0);
  });

  it("[SPEC-13.resolution-metrics][SAFE-04] a safety route still in progress at call end is not containment", async () => {
    const { ctx } = await h.startCall(callId("SafetyRouting"));
    const r = expectDone(await h.invoke("request_safety_route", ctx, { signalSource: "CALLER_REQUEST", concernSubject: "SELF", language: "en" }));
    expect(r.outcome.status).toBe("SUCCESS");
    expect((await h.deps.transfers.journeysForCall(TENANT_ID, ctx.callId)).map((j) => [j.priority, j.status])).toEqual([["SAFETY", "ROUTING"]]);
    await record(ctx, { callerDisconnected: true });
    expect(h.metrics.counterValue("vsp_contained_interactions_total")).toBe(0);
    // The same kind of call without any transfer journey is contained (the journey alone made the difference).
    const plain = (await h.startCall(callId("NoTransfer"))).ctx;
    await record(plain, { callerDisconnected: true });
    expect(h.metrics.counterValue("vsp_contained_interactions_total", { outcome: "CALLER_DISCONNECTED", intent: "unknown" })).toBe(1);
  });

  it("[SPEC-13.resolution-metrics][SAFE-04] an unreadable transfer store counts as a transfer attempt, never containment, and never blocks the outcome", async () => {
    const { logger, records } = createMemoryLogger();
    const transfers = {
      journeysForCall: () => Promise.reject(new Error("TRANSFER_STORE_UNAVAILABLE")),
    } as unknown as ToolDeps["transfers"];
    const svc = new BusinessOutcomeService({ ...h.deps, transfers, logger }, new InteractionIndex(h.deps.db, h.deps.clock));
    const auth = await verifiedCall(PEOPLE.avery, "TransferLookupDown");
    const d = await svc.record({ tenantId: auth.tenantId, callId: auth.callId, contractId: "invoice_explanation@1", evidence: { ...NONE, informationProvided: true } });
    expect(d.outcome).toBe("INFORMATION_PROVIDED");
    expect(h.metrics.counterValue("vsp_interaction_outcomes_total", { outcome: "INFORMATION_PROVIDED", intent: "invoice_explanation" })).toBe(1);
    expect(h.metrics.counterValue("vsp_contained_interactions_total")).toBe(0);
    const warn = records.find((rec) => rec.event === "business.outcome.transfer_lookup_failed");
    expect(warn?.level).toBe("warn");
    // DATA-01: the log line names no call, session or subject.
    expect(JSON.stringify(records)).not.toContain(auth.callId);
    expect(JSON.stringify(records)).not.toContain(PEOPLE.avery.subjectId);
  });

  it("[SPEC-13.resolution-metrics][ACT-04] a retried call-end record() that is RESOLVED both times is one verified resolution", async () => {
    const auth = await verifiedCall(PEOPLE.avery, "RetriedResolved");
    const { receiptId } = await commitReschedule(auth);
    expect((await record(auth, { commitReceiptIds: [receiptId] })).outcome).toBe("RESOLVED");
    // A TC-11 retry of the same call end (same receipt): a second RESOLVED row, not a second resolution.
    expect((await record(auth, { commitReceiptIds: [receiptId] })).outcome).toBe("RESOLVED");
    expect(h.metrics.counterValue("vsp_interaction_outcomes_total", { outcome: "RESOLVED", intent: "appointment_reschedule" })).toBe(2);
    expect(h.metrics.counterValue("vsp_verified_resolutions_total", { intent: "appointment_reschedule", source: "call_end" })).toBe(1);
    expect(h.metrics.counterValue("vsp_verified_resolutions_total")).toBe(1);
  });

  it("[SPEC-13.resolution-metrics][ACT-03] a commit reconciled after call end counts once as a verified resolution (source reconciliation); the revision keeps the subject", async () => {
    const auth = await verifiedCall(PEOPLE.avery, "Reconciled");
    const appointment = APPOINTMENTS[0] as (typeof APPOINTMENTS)[number];
    const p = expectDone(await h.invoke("prepare_appointment_change", auth, { appointmentId: appointment.appointmentId, startsAt: (SLOTS[0] as (typeof SLOTS)[number]).startsAt, modality: null }));
    if (p.outcome.status !== "SUCCESS") throw new Error(`prepare ${p.outcome.status}`);
    const change = (p.outcome.data as { change: { actionId: string; actionDigest: string } }).change;
    // Call end before the commit: nothing verified yet.
    expect((await record(auth, { informationProvided: true })).outcome).toBe("INFORMATION_PROVIDED");
    await h.confirm(auth, change.actionId, change.actionDigest);
    expect(expectDone(await h.invoke("commit_appointment_change", auth, { actionId: change.actionId, digest: change.actionDigest })).outcome.status).toBe("SUCCESS");
    const revised = await h.business.outcomes.reviseAfterCommit?.(TENANT_ID, change.actionId);
    expect(revised).toEqual({ revised: true, outcome: "RESOLVED", reasonCode: "COMMITTED_RECEIPT_VERIFIED" });
    expect(h.metrics.counterValue("vsp_verified_resolutions_total", { intent: "appointment_reschedule", source: "reconciliation" })).toBe(1);
    // Redelivery appends nothing and counts nothing.
    expect(await h.business.outcomes.reviseAfterCommit?.(TENANT_ID, change.actionId)).toMatchObject({ revised: false });
    expect(h.metrics.counterValue("vsp_verified_resolutions_total")).toBe(1);
    expect(await subjectRefOf(auth.callId)).toEqual([PEOPLE.avery.subjectId, PEOPLE.avery.subjectId]);
  });

  it("[SPEC-13.resolution-metrics][ACT-04] a call resolved at call end is never counted again: a later RESOLVED revision (after a repeated record() without the receipt) is not a second verified resolution", async () => {
    const auth = await verifiedCall(PEOPLE.avery, "ResolvedOnce");
    const { actionId, receiptId } = await commitReschedule(auth);
    expect((await record(auth, { commitReceiptIds: [receiptId] })).outcome).toBe("RESOLVED");
    expect(h.metrics.counterValue("vsp_verified_resolutions_total", { intent: "appointment_reschedule", source: "call_end" })).toBe(1);
    // A repeated call-end record() that lost the receipt: the call's latest row is unresolved again.
    h.clock.advanceMs(60_000);
    expect((await record(auth, {})).outcome).toBe("OUTCOME_UNKNOWN");
    // The action.committed consumer restores RESOLVED with a revision, but the call was already counted.
    expect(await h.business.outcomes.reviseAfterCommit?.(TENANT_ID, actionId)).toEqual({ revised: true, outcome: "RESOLVED", reasonCode: "COMMITTED_RECEIPT_VERIFIED" });
    expect(h.metrics.counterValue("vsp_verified_resolutions_total", { source: "reconciliation" })).toBe(0);
    expect(h.metrics.counterValue("vsp_verified_resolutions_total")).toBe(1);
    expect(h.metrics.counterValue("vsp_interaction_outcomes_total", { outcome: "RESOLVED" })).toBe(1);
  });

  it("[SPEC-13.resolution-metrics][ACT-04] a repeated record() that resolves a call recorded unresolved counts it once (call_end); a later redelivered revision adds nothing", async () => {
    const auth = await verifiedCall(PEOPLE.avery, "ResolvedLater");
    const { actionId, receiptId } = await commitReschedule(auth);
    expect((await record(auth, {})).outcome).toBe("OUTCOME_UNKNOWN");
    expect(h.metrics.counterValue("vsp_verified_resolutions_total")).toBe(0);
    h.clock.advanceMs(60_000);
    expect((await record(auth, { commitReceiptIds: [receiptId] })).outcome).toBe("RESOLVED");
    expect(h.metrics.counterValue("vsp_verified_resolutions_total", { intent: "appointment_reschedule", source: "call_end" })).toBe(1);
    expect(await h.business.outcomes.reviseAfterCommit?.(TENANT_ID, actionId)).toMatchObject({ revised: false, outcome: "RESOLVED" });
    expect(h.metrics.counterValue("vsp_verified_resolutions_total")).toBe(1);
    // Containment is still counted once per call (at its first recorded outcome).
    expect(h.metrics.counterValue("vsp_contained_interactions_total")).toBe(1);
  });
});

describe("per-call outcome writes", () => {
  it("[SPEC-13.resolution-metrics][ACT-03] record() and reviseAfterCommit() take the same per-call advisory lock before reading the call's rows (exact once-per-call counts under READ COMMITTED)", async () => {
    // PGlite runs one transaction at a time, so the concurrent TC-11 race itself cannot be reproduced
    // offline; this pins that both writers serialize on one key before any read of interaction_outcomes.
    const { db, txs } = recordingDb(h.deps.db);
    const svc = new BusinessOutcomeService({ ...h.deps, db }, new InteractionIndex(h.deps.db, h.deps.clock));
    const auth = await verifiedCall(PEOPLE.avery, "Lock");
    const change = await prepareReschedule(auth);
    await svc.record({ tenantId: auth.tenantId, callId: auth.callId, contractId: null, evidence: { ...NONE, informationProvided: true } });
    await confirmAndCommit(auth, change);
    expect((await svc.reviseAfterCommit(TENANT_ID, change.actionId)).revised).toBe(true);
    const writers = txs.filter((log) => log.some((s) => /insert into interaction_outcomes/.test(s.sql)));
    expect(writers).toHaveLength(2);
    for (const log of writers) {
      expect(log[0]?.sql).toMatch(/pg_advisory_xact_lock\(hashtextextended\(\$1, 0\)\)/);
      expect(log[0]?.params).toEqual([`interaction_outcomes:${TENANT_ID}:${auth.callId}`]);
      const firstRead = log.findIndex((s) => /from interaction_outcomes/.test(s.sql));
      expect(firstRead).toBeGreaterThan(0);
    }
  });

  it("[SPEC-13.resolution-metrics] a second record() in the same millisecond is strictly later, so the call's latest row is unambiguous", async () => {
    const auth = await verifiedCall(PEOPLE.avery, "SameMs");
    await record(auth, { informationProvided: true });
    await record(auth, { callerDisconnected: true });
    const rows = (
      await h.db.tx((tx) => tx.query<{ outcome: string; recorded_at: Date | string }>("select outcome, recorded_at from interaction_outcomes where call_id = $1 order by recorded_at, outcome_id", [auth.callId]), {
        role: "owner",
      })
    ).rows;
    expect(rows.map((r) => r.outcome)).toEqual(["INFORMATION_PROVIDED", "CALLER_DISCONNECTED"]);
    const [t1, t2] = rows.map((r) => new Date(r.recorded_at).getTime());
    expect(t2).toBeGreaterThan(t1 as number);
  });
});

describe("repeat contact", () => {
  it("[SPEC-13.resolution-metrics][DATA-01] 24-hour and 7-day repeat contact of the same authorized subject, labelled by prior outcome and intent only", async () => {
    // Call 1: verified reschedule (subject from the ledger action).
    const first = await verifiedCall(PEOPLE.avery, "RepeatA");
    const { receiptId } = await commitReschedule(first);
    await record(first, { commitReceiptIds: [receiptId] });
    expect(checks("first_contact")).toBe(1);
    expect(await subjectRefOf(first.callId)).toEqual([PEOPLE.avery.subjectId]);

    // Call 2, two hours later: a subject-linked support request (A2) -> repeat inside 24h and 7d.
    h.clock.advanceMs(2 * HOUR);
    const second = await verifiedCall(PEOPLE.avery, "RepeatB");
    await linkedSupportRequest(second);
    await record(second, { requestAccepted: true }, { contractId: "support_intake@1" });
    expect(repeats({ window: "24h", prior_outcome: "RESOLVED", prior_intent: "appointment_reschedule" })).toBe(1);
    expect(repeats({ window: "7d", prior_outcome: "RESOLVED", prior_intent: "appointment_reschedule" })).toBe(1);

    // Call 3, three days after call 2: read-only, the trusted session subject is passed -> 7d only.
    h.clock.advanceMs(72 * HOUR);
    const third = await verifiedCall(PEOPLE.avery, "RepeatC");
    await record(third, { informationProvided: true }, { contractId: "invoice_explanation@1", subjectRef: third.subjectId });
    expect(repeats({ window: "24h" })).toBe(1);
    expect(repeats({ window: "7d", prior_outcome: "REQUEST_ACCEPTED", prior_intent: "support_intake" })).toBe(1);

    // Call 4, twenty days later: outside every window.
    h.clock.advanceMs(20 * 24 * HOUR);
    const fourth = await verifiedCall(PEOPLE.avery, "RepeatD");
    await record(fourth, { informationProvided: true }, { subjectRef: fourth.subjectId });
    expect(checks("repeat")).toBe(2);
    expect(checks("first_contact")).toBe(2);

    // DATA-01: no subject, actor, account or call id reaches a metric label.
    const series = JSON.stringify(h.metrics.allSeries());
    for (const id of [PEOPLE.avery.subjectId, PEOPLE.avery.actorId, PEOPLE.avery.accountId, first.callId, second.callId]) expect(series).not.toContain(id);
    expect(h.metrics.counterValue("vsp_metric_label_rejections_total")).toBe(0);
  });

  it("[SPEC-13.resolution-metrics] a second record() for the same call is not a new contact or contained call, and another subject's calls never count", async () => {
    const a = await verifiedCall(PEOPLE.avery, "SameA");
    await record(a, { informationProvided: true }, { subjectRef: a.subjectId });
    await record(a, { informationProvided: true, callerDisconnected: true }, { subjectRef: a.subjectId });
    expect(checks("first_contact")).toBe(1);
    expect(checks("repeat")).toBe(0);
    expect(h.metrics.counterValue("vsp_contained_interactions_total")).toBe(1);
    expect(h.metrics.counterValue("vsp_interaction_outcomes_total")).toBe(2);
    h.clock.advanceMs(HOUR);
    const b = await verifiedCall(PEOPLE.blake, "SameB");
    await record(b, { informationProvided: true }, { subjectRef: b.subjectId });
    expect(checks("first_contact")).toBe(2);
    expect(repeats()).toBe(0);
  });

  it("[SPEC-13.resolution-metrics][ACT-03] a call's contact time is its call-end row: a prior call whose revision falls inside the window but whose call end does not is not a repeat", async () => {
    // Call A ends at t0 with a prepared change; the commit's reconciliation revision is appended at t0 + 2 days.
    const a = await verifiedCall(PEOPLE.avery, "RevA");
    const change = await prepareReschedule(a);
    expect((await record(a, { informationProvided: true })).outcome).toBe("INFORMATION_PROVIDED");
    await confirmAndCommit(a, change);
    h.clock.advanceMs(48 * HOUR);
    expect(await h.business.outcomes.reviseAfterCommit?.(TENANT_ID, change.actionId)).toMatchObject({ revised: true, outcome: "RESOLVED" });
    expect(await subjectRefOf(a.callId)).toEqual([PEOPLE.avery.subjectId, PEOPLE.avery.subjectId]);
    // Call B at t0 + 8 days: A's call end is outside every window (7d), its revision (6 days ago) is not a contact.
    h.clock.advanceMs(6 * 24 * HOUR);
    const b = await verifiedCall(PEOPLE.avery, "RevB");
    await record(b, { informationProvided: true }, { subjectRef: b.subjectId });
    expect(checks("first_contact")).toBe(2);
    expect(checks("repeat")).toBe(0);
    expect(repeats()).toBe(0);
  });

  it("[SPEC-13.resolution-metrics][ACT-03] prior_outcome is the prior call's CURRENT outcome: a call revised to RESOLVED after call end is a RESOLVED prior contact", async () => {
    const a = await verifiedCall(PEOPLE.avery, "PriorRevA");
    const change = await prepareReschedule(a);
    expect((await record(a, { informationProvided: true })).outcome).toBe("INFORMATION_PROVIDED");
    await confirmAndCommit(a, change);
    h.clock.advanceMs(60_000);
    expect(await h.business.outcomes.reviseAfterCommit?.(TENANT_ID, change.actionId)).toMatchObject({ revised: true, outcome: "RESOLVED" });
    h.clock.advanceMs(HOUR);
    const b = await verifiedCall(PEOPLE.avery, "PriorRevB");
    await record(b, { informationProvided: true }, { subjectRef: b.subjectId });
    expect(repeats({ window: "24h", prior_outcome: "RESOLVED", prior_intent: "appointment_reschedule" })).toBe(1);
    expect(repeats({ window: "7d", prior_outcome: "RESOLVED", prior_intent: "appointment_reschedule" })).toBe(1);
    expect(repeats({ prior_outcome: "INFORMATION_PROVIDED" })).toBe(0);
  });

  it("[SPEC-13.resolution-metrics][AUTH-02] no authorized subject (unverified caller, no subject-linked record) is not measured; conflicting subjects are ambiguous, never guessed", async () => {
    const anon = (await h.startCall(callId("Anon"))).ctx;
    await record(anon, { callerDisconnected: true });
    expect(checks("no_authorized_subject")).toBe(1);
    expect(await subjectRefOf(anon.callId)).toEqual([null]);

    const mixed = await verifiedCall(PEOPLE.avery, "Mixed");
    await commitReschedule(mixed);
    await record(mixed, { informationProvided: true }, { subjectRef: PEOPLE.blake.subjectId as string });
    expect(checks("subject_ambiguous")).toBe(1);
    expect(await subjectRefOf(mixed.callId)).toEqual([null]);
  });

  it("[SPEC-13.resolution-metrics][DATA-01] the console role reads a call's outcome but never its subject reference; the runtime and worker roles do", async () => {
    const auth = await verifiedCall(PEOPLE.avery, "ConsoleColumns");
    await record(auth, { informationProvided: true }, { subjectRef: auth.subjectId });
    const as = (role: "app_console" | "app_runtime" | "app_worker", sql: string) => h.db.tx((tx) => tx.query<Record<string, unknown>>(sql, [auth.callId]), { role, rls: { tenantId: TENANT_ID } });
    const consoleRows = await as("app_console", "select outcome_id, call_id, outcome, reason_code, recorded_at from interaction_outcomes where call_id = $1");
    expect(consoleRows.rows.map((r) => r.outcome)).toEqual(["INFORMATION_PROVIDED"]);
    await expect(as("app_console", "select subject_ref from interaction_outcomes where call_id = $1")).rejects.toThrow(/permission denied/);
    await expect(as("app_console", "select * from interaction_outcomes where call_id = $1")).rejects.toThrow(/permission denied/);
    for (const role of ["app_runtime", "app_worker"] as const) expect((await as(role, "select subject_ref from interaction_outcomes where call_id = $1")).rows, role).toEqual([{ subject_ref: PEOPLE.avery.subjectId }]);
  });

  it("[SPEC-13.resolution-metrics][AUTH-05] tenant-scoped: a prior outcome of the same subject reference in another tenant is never a prior contact", async () => {
    const otherTenant = OTHER_TENANT_ID;
    await h.db.tx(
      (tx) =>
        tx.query(
          `insert into interaction_outcomes (outcome_id, tenant_id, call_id, contract_id, outcome, reason_code, evidence, recorded_at, subject_ref)
           values ('ioc_synthOtherTenantRow001', $1, 'cal_synthOtherTenantCall01', null, 'INFORMATION_PROVIDED', 'INFORMATION_PROVIDED', '{}'::jsonb, $2, $3)`,
          [otherTenant, h.clock.now().toISOString(), PEOPLE.avery.subjectId],
        ),
      { role: "owner" },
    );
    h.clock.advanceMs(HOUR);
    const auth = await verifiedCall(PEOPLE.avery, "Tenant");
    await record(auth, { informationProvided: true }, { subjectRef: auth.subjectId });
    expect(checks("first_contact")).toBe(1);
    expect(repeats()).toBe(0);
  });

  it("[SPEC-13.resolution-metrics] the window set is configuration: a placeholder default (24h, 7d) and validated overrides", async () => {
    expect(DEFAULT_REPEAT_CONTACT_POLICY.windows).toEqual(["24h", "7d"]);
    for (const w of REPEAT_CONTACT_WINDOWS) expect(REPEAT_CONTACT_WINDOW_MS[w]).toBeGreaterThan(0);
    const interactions = new InteractionIndex(h.deps.db, h.deps.clock);
    expect(() => new BusinessOutcomeService(h.deps, interactions, { repeatContact: { windows: [] } })).toThrow("REPEAT_CONTACT_POLICY_INVALID");
    expect(() => new BusinessOutcomeService(h.deps, interactions, { repeatContact: { windows: ["24h", "24h"] } })).toThrow("REPEAT_CONTACT_POLICY_INVALID");
    expect(() => new BusinessOutcomeService(h.deps, interactions, { repeatContact: { windows: ["36h" as never] } })).toThrow("REPEAT_CONTACT_POLICY_INVALID");
    const svc = new BusinessOutcomeService(h.deps, interactions, { repeatContact: { windows: ["72h"] } });
    const a = await verifiedCall(PEOPLE.avery, "WinA");
    await svc.record({ tenantId: a.tenantId, callId: a.callId, contractId: null, evidence: { ...NONE, informationProvided: true }, subjectRef: a.subjectId });
    h.clock.advanceMs(48 * HOUR);
    const b = await verifiedCall(PEOPLE.avery, "WinB");
    await svc.record({ tenantId: b.tenantId, callId: b.callId, contractId: null, evidence: { ...NONE, informationProvided: true }, subjectRef: b.subjectId });
    expect(repeats({ window: "72h", prior_outcome: "INFORMATION_PROVIDED", prior_intent: "unknown" })).toBe(1);
    expect(repeats({ window: "24h" })).toBe(0);
  });
});
