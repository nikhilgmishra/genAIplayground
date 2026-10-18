/**
 * Internal support requests and asynchronous Salesforce synchronization
 * (spec section 8; SPEC-8.4) over the REAL outbox, consumer dedup, audit and PGlite,
 * with the LOCAL Salesforce-like fixture (fault injection).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PEOPLE } from "../fixtures/synthetic-world.js";
import { SupportRequest } from "../protocol/index.js";
import { RESTRICTED_CASE_SUMMARY } from "./support/support-request-service.js";
import { createBusinessHarness, expectDone, type BusinessHarness } from "./testing/harness.js";

let h: BusinessHarness;
beforeEach(async () => {
  h = await createBusinessHarness({ sync: { maxAttempts: 3, baseBackoffMs: 60_000, maxBackoffMs: 600_000, claimStaleSeconds: 120 } });
});
afterEach(async () => {
  await h.close();
});

interface OutboxRow {
  message_id: string;
  payload: Record<string, unknown>;
  dedupe_key: string;
}

async function syncMessages(): Promise<OutboxRow[]> {
  return h.db.tx(
    async (q) => (await q.query<OutboxRow>("select message_id, payload, dedupe_key from outbox_messages where topic = 'support_request.sync' order by created_at, message_id")).rows,
    { role: "owner" },
  );
}

async function createRequest(link = false) {
  const { sessionRef, ctx } = await h.startCall();
  const auth = link ? await h.verify(PEOPLE.avery, sessionRef) : ctx;
  const r = expectDone(await h.invoke("create_support_request", auth, { issueCategory: "appointment", linkToAccount: link, urgency: "STANDARD", language: "en" }));
  if (r.outcome.status !== "SUCCESS") throw new Error(`create ${r.outcome.status}`);
  const ref = (r.outcome.data as { request: { supportReference: string } }).request.supportReference;
  return { auth, ref, result: r };
}

describe("support requests", () => {
  it("[SPEC-8.4] [ACT-04] creation persists the internal request and its sync message in one transaction; the caller gets a support reference pending sync, not a Case number", async () => {
    const { auth, ref, result } = await createRequest();
    if (result.outcome.status === "SUCCESS") {
      expect(result.outcome.speech).toMatchObject({ templateId: "support_reference.pending_sync", slots: { supportReference: ref } });
      expect(result.masked).toEqual({ request: { status: "REQUEST_ACCEPTED", supportReference: ref }, synchronization: "PENDING_SYNC", linkedToAccount: false });
    }
    const sr = await h.services.support.getByReference(auth.tenantId, ref);
    expect(SupportRequest.safeParse(sr).success).toBe(true);
    expect(sr).toMatchObject({ syncState: "PENDING", salesforceCaseId: null, subjectRef: null, disposition: "REQUEST_ACCEPTED", summaryProvenance: "template_assembled" });
    expect(sr?.summary).not.toMatch(/[0-9]{4,}/);
    const msgs = await syncMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.payload).toEqual({ tenantId: auth.tenantId, supportRequestId: sr?.supportRequestId, attempt: 0 });
    expect(h.fixtures.supportRecords.records().cases).toHaveLength(0);
  });

  it("[SPEC-8.4] [ACT-02] a sync message upserts interaction + Case by external id; a duplicate delivery is processed once", async () => {
    const { auth, ref } = await createRequest();
    const [m] = await syncMessages();
    if (!m) throw new Error("no message");
    const first = await h.business.supportRequests.handleSyncMessage(m.message_id, m.payload);
    const dup = await h.business.supportRequests.handleSyncMessage(m.message_id, m.payload);
    expect(first).toEqual({ duplicate: false, syncState: "SYNCED" });
    expect(dup).toEqual({ duplicate: true, syncState: "SYNCED" });
    const records = h.fixtures.supportRecords.records();
    expect(records.cases).toHaveLength(1);
    expect(records.interactions).toHaveLength(1);
    expect(h.fixtures.supportRecords.apiCallCount("upsertCase")).toBe(1);
    const sr = await h.services.support.getByReference(auth.tenantId, ref);
    expect(sr?.syncState).toBe("SYNCED");
    expect(sr?.salesforceCaseId).toBe(records.cases[0]?.caseId);
    expect(records.cases[0]?.fields.supportReference).toBe(ref);
  });

  it("[SPEC-8.4] Salesforce outage: the internal reference stands, sync is RETRY_SCHEDULED with backoff, and a later sync succeeds (customer intent preserved)", async () => {
    const { auth, ref } = await createRequest();
    h.fixtures.faults.inject({ integrationId: "salesforce", operation: "*", kind: "OUTAGE", mode: "persistent" });
    const [m] = await syncMessages();
    if (!m) throw new Error("no message");
    expect(await h.business.supportRequests.handleSyncMessage(m.message_id, m.payload)).toEqual({ duplicate: false, syncState: "RETRY_SCHEDULED" });
    expect((await h.business.supportRequests.listUnsynced(auth.tenantId, 10)).map((s) => s.referenceNumber)).toEqual([ref]);
    // Not due yet: nothing re-enqueued.
    expect(await h.services.support.retryDue(auth.tenantId)).toBe(0);
    h.clock.advanceSeconds(61);
    expect(await h.services.support.retryDue(auth.tenantId)).toBe(1);
    h.fixtures.faults.reset();
    const msgs = await syncMessages();
    expect(msgs).toHaveLength(2);
    const retry = msgs[1];
    if (!retry) throw new Error("no retry");
    expect(await h.business.supportRequests.handleSyncMessage(retry.message_id, retry.payload)).toEqual({ duplicate: false, syncState: "SYNCED" });
    const trace = await h.business.supportRequests.trace(auth.tenantId, ref);
    expect(trace?.salesforce).toMatchObject({ syncState: "SYNCED", attempts: 2 });
    expect(trace?.auditEventIds.length).toBeGreaterThanOrEqual(3);
    expect(h.metrics.counterValue("vsp_crm_reconciliation_total", { result: "retried" })).toBe(1);
    expect(h.metrics.counterValue("vsp_crm_reconciliation_total", { result: "synced" })).toBe(1);
  });

  it("[SPEC-8.4] bounded attempts end in DEAD_LETTER (operator repair), and repair re-queues the request", async () => {
    const { auth, ref } = await createRequest();
    h.fixtures.faults.inject({ integrationId: "salesforce", operation: "*", kind: "OUTAGE", mode: "persistent" });
    for (let i = 0; i < 3; i++) {
      const msgs = await syncMessages();
      const m = msgs[msgs.length - 1];
      if (!m) throw new Error("no message");
      const r = await h.business.supportRequests.handleSyncMessage(m.message_id, m.payload);
      expect(r.syncState).toBe(i < 2 ? "RETRY_SCHEDULED" : "DEAD_LETTER");
      h.clock.advanceSeconds(3600);
      await h.services.support.retryDue(auth.tenantId);
    }
    const sr = await h.services.support.getByReference(auth.tenantId, ref);
    expect(sr?.syncState).toBe("DEAD_LETTER");
    h.fixtures.faults.reset();
    const repaired = await h.services.support.repairDeadLetter(auth.tenantId, sr?.supportRequestId ?? "", { actorRef: "stf_synthSupervisor01", reasonCode: "SALESFORCE_RECOVERED" });
    expect(repaired.syncState).toBe("PENDING");
    const msgs = await syncMessages();
    const m = msgs[msgs.length - 1];
    if (!m) throw new Error("no message");
    expect((await h.business.supportRequests.handleSyncMessage(m.message_id, m.payload)).syncState).toBe("SYNCED");
  });

  it("[SPEC-8.4] a worker that crashed while SYNCING is re-queued after the claim goes stale; the upsert is idempotent", async () => {
    const { auth, ref } = await createRequest();
    const sr = await h.services.support.getByReference(auth.tenantId, ref);
    // Simulate a claim left behind by a crashed worker.
    await h.db.tx(
      (q) =>
        q.query(
          "update support_requests set sync_state = 'SYNCING', sync_attempts = 1, sync_claim_token = 'scl_synthCrashedWorker0001', last_sync_attempt_at = $2, row_version = row_version + 1 where support_request_id = $1",
          [sr?.supportRequestId, h.clock.now().toISOString()],
        ),
      { role: "owner" },
    );
    expect(await h.services.support.retryDue(auth.tenantId)).toBe(0);
    h.clock.advanceSeconds(121);
    expect(await h.services.support.retryDue(auth.tenantId)).toBe(1);
    const msgs = await syncMessages();
    const m = msgs[msgs.length - 1];
    if (!m) throw new Error("no message");
    expect((await h.business.supportRequests.handleSyncMessage(m.message_id, m.payload)).syncState).toBe("SYNCED");
    expect(h.fixtures.supportRecords.records().cases).toHaveLength(1);
  });

  it("[DATA-01] [SPEC-8.restricted] a privacy complaint is a restricted record: hidden from the runtime role and synchronized only as a minimal restricted Case", async () => {
    const { ctx } = await h.startCall();
    const r = expectDone(await h.invoke("submit_complaint", ctx, { category: "PRIVACY_CONCERN", wantsCallback: true, language: "en" }));
    if (r.outcome.status !== "SUCCESS") throw new Error("complaint failed");
    const ref = (r.outcome.data as { complaint: { supportReference: string } }).complaint.supportReference;
    expect(await h.services.support.getByReference(ctx.tenantId, ref)).toBeNull();
    const trace = await h.business.supportRequests.trace(ctx.tenantId, ref);
    expect(trace?.supportRequest).toMatchObject({ restricted: true, issueCategory: "privacy_concern", ownerQueue: "q_privacy_office" });
    expect(trace?.workflowIds).toHaveLength(1);
    const [m] = await syncMessages();
    if (!m) throw new Error("no message");
    await h.business.supportRequests.handleSyncMessage(m.message_id, m.payload);
    const c = h.fixtures.supportRecords.records().cases[0];
    expect(c?.visibility).toBe("RESTRICTED");
    expect(c?.fields).toMatchObject({ restricted: true, summary: RESTRICTED_CASE_SUMMARY, attempted: [], commitReceiptIds: [], nextStep: null });
  });

  it("[AUTH-05] [DATA-01] a restricted request reference resolves to a denied resource in the case-status tool", async () => {
    const { ctx } = await h.startCall();
    const r = expectDone(await h.invoke("submit_complaint", ctx, { category: "PRIVACY_CONCERN", wantsCallback: false, language: "en" }));
    const ref = r.outcome.status === "SUCCESS" ? (r.outcome.data as { complaint: { supportReference: string } }).complaint.supportReference : "";
    const { sessionRef } = await h.startCall("cal_synthCallConcurrent1");
    const avery = await h.verify(PEOPLE.avery, sessionRef);
    expect((await h.invoke("get_authorized_case_status", avery, { supportReference: ref })).stage).toBe("policy");
  });

  it("[ACT-02] the same intake tool call in the same turn creates one support request", async () => {
    const { ctx } = await h.startCall();
    const args = { issueCategory: "billing_question", linkToAccount: false, urgency: "STANDARD", language: "en" };
    const a = expectDone(await h.invoke("create_support_request", ctx, args, { turnId: "turn_synthSameTurn01" }));
    const b = expectDone(await h.invoke("create_support_request", ctx, args, { turnId: "turn_synthSameTurn01" }));
    const ra = a.outcome.status === "SUCCESS" ? (a.outcome.data as { request: { supportReference: string } }).request.supportReference : "a";
    const rb = b.outcome.status === "SUCCESS" ? (b.outcome.data as { request: { supportReference: string } }).request.supportReference : "b";
    expect(rb).toBe(ra);
    expect(await syncMessages()).toHaveLength(1);
  });

  it("[DATA-04] an A0 caller asking to link the account gets an unlinked request (no subject without A2)", async () => {
    const { ctx } = await h.startCall();
    const r = expectDone(await h.invoke("create_support_request", ctx, { issueCategory: "other", linkToAccount: true, urgency: "STANDARD", language: "en" }));
    expect(r.masked).toMatchObject({ linkedToAccount: false });
  });
});
