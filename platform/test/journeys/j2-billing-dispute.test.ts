/**
 * [SPEC-16.journey-2] A disputed charge routed into a durable review without promising a
 * refund (SYNTHETIC client Avery, LOCAL FIXTURE billing and Salesforce):
 * verified caller -> invoice facts -> prepare_billing_review -> Studio-captured confirmation ->
 * submit_billing_review (commit) -> invoice IN_REVIEW (one billing effect), billing_dispute_review
 * workflow started in the commit transaction WITH a durable action grant, support request
 * (REQUEST_ACCEPTED, q_billing_intake) synced to the Salesforce fixture by the worker consumer ->
 * call end REQUEST_ACCEPTED (never RESOLVED). No rendered template promises a refund.
 * Guarded review transitions (decision notice) pass the durable grant check and then the CURRENT
 * pre-disclosure recheck (business/recheck.ts): consent, account state and policy re-evaluated now.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INVOICES } from "../../src/fixtures/synthetic-world.js";
import { AVERY, createJourneyHarness } from "./harness.js";
import type { JourneyHarness } from "./harness.js";

let h: JourneyHarness;
beforeAll(async () => {
  h = await createJourneyHarness();
}, 180_000);
afterAll(async () => {
  await h?.close();
});

const INVOICE = INVOICES[0].invoiceId;
/** Wording that would promise money back or a waived charge (spec section 4: invoice explanations never promise a refund). */
const REFUND_PROMISE = /refund|reimburs|money back|credit (it|this|you)|waive|we will remove|will be removed|reverse(d)? the charge/i;
const SYSTEM = { kind: "system" as const, ref: "wrk_synthJourneyWorker01" };
let firstActionId = "";
let reconciledActionId = "";

async function reviewWorkflowOf(actionId: string): Promise<string> {
  const [wf] = await h.q<{ workflow_id: string }>("select workflow_id from workflow_instances where workflow_type = 'billing_dispute_review' and correlation_id = $1", [actionId]);
  expect(wf?.workflow_id, "review workflow").toMatch(/^wf_/);
  return wf?.workflow_id as string;
}

/** Unguarded progress by the system actor to the specialist's decision (WAITING_FOR_HUMAN). */
async function toSpecialistDecision(workflowId: string): Promise<void> {
  const tenantId = h.c.config.tenantId;
  await h.c.workflows.signal({ tenantId, workflowId, event: "VALIDATE", actor: SYSTEM });
  await h.c.workflows.signal({ tenantId, workflowId, event: "VALIDATION_PASSED", actor: SYSTEM });
  expect((await h.c.workflows.get(tenantId, workflowId))?.state).toBe("WAITING_FOR_HUMAN");
}

/** The SYNTHETIC supervisor completes the open decision task (a rejection is the guarded decision notice). */
async function specialistDecides(workflowId: string, decision: "APPROVE" | "REJECT") {
  const tenantId = h.c.config.tenantId;
  const task = (await h.c.workflows.openTasks(tenantId, ["supervisor"])).find((t) => t.workflowId === workflowId);
  expect(task, "open specialist task").toBeDefined();
  const staff = { staffId: "stf_synthSupervisor01", roles: ["supervisor" as const], mfa: true, authenticatedAt: h.clock.now().toISOString(), breakGlass: null };
  const issued = await h.c.workflows.issueTaskToken({ tenantId, taskId: task?.taskId as string, staff });
  return h.c.workflows.completeHumanTask({ tenantId, taskId: task?.taskId as string, taskToken: issued.taskToken, decision, staff });
}

/** Reason codes of the workflow's POLICY_CHANGED_PENDING_ACTION events, oldest first. */
async function policyChangedEvents(workflowId: string): Promise<string[]> {
  const rows = await h.q<{ reason_code: string | null }>("select reason_code from workflow_events where workflow_id = $1 and trigger = 'POLICY_CHANGED_PENDING_ACTION' order by seq", [workflowId]);
  return rows.map((r) => r.reason_code ?? "");
}

/** A fresh, confirmed and committed billing review of Avery's invoice (LOCAL FIXTURE: the invoice is reopened first). */
async function acceptedReview(reasonCategory: string): Promise<string> {
  h.c.fixtures.store.update("invoices", INVOICE, (inv: { status: string }) => {
    inv.status = "OPEN";
  });
  const call = h.call();
  await call.start();
  await call.role("client");
  expect((await call.verify(AVERY, "avery.synthetic")).bound).toBe(true);
  const prep = await call.tool("prepare_billing_review", { invoiceId: INVOICE, reasonCategory });
  expect(prep.status).toBe("SUCCESS");
  await call.confirmPending();
  const submitted = await call.tool("submit_billing_review", { actionId: prep.data?.actionId as string, digest: prep.data?.actionDigest as string });
  expect(submitted.status).toBe("SUCCESS");
  expect((await call.end()).outcome).toBe("REQUEST_ACCEPTED");
  return prep.data?.actionId as string;
}

describe("[SPEC-16.journey-2] disputed charge routed into a durable review", () => {
  it("[SPEC-16.journey-2][ACT-01][ACT-04][SPEC-7.durable-grant][SPEC-8.salesforce] confirmed review -> IN_REVIEW, workflow with grant, SR synced, REQUEST_ACCEPTED, no refund promise", async () => {
    const call = h.call();
    await call.start();
    await call.role("client");
    expect((await call.verify(AVERY, "avery.synthetic")).bound).toBe(true);

    // The caller names the disputed charge ("the seventy-five dollar late fee"): the typed line selector
    // makes the explanation target exactly that line, not the first explainable one.
    const facts = await call.tool("get_invoice_status", { invoiceId: INVOICE, detail: "LINE_EXPLANATION", serviceDate: null, line: { chargeCode: "LATE_CANCELLATION", amountMinor: 7500 } });
    expect(facts.status).toBe("SUCCESS");
    expect(facts.speech).toMatchObject({ templateId: "invoice.line_explanation", slots: { amount: 7500, lineType: "LATE_CANCELLATION", serviceDate: "2026-09-27" } });

    const prep = await call.tool("prepare_billing_review", { invoiceId: INVOICE, reasonCategory: "LATE_CANCELLATION_FEE_DISPUTE" });
    expect(prep.status).toBe("SUCCESS");
    expect(prep.speech?.templateId).toBe("billing.review_confirmation");
    const actionId = prep.data?.actionId as string;
    const digest = prep.data?.actionDigest as string;
    firstActionId = actionId;

    const prompt = await call.confirmPending();
    expect(prompt).toMatchObject({ actionId, digest, confirmationTemplateId: "billing.review_confirmation", routeToHuman: false });
    expect(prompt.promptText as string).toContain("does not change your balance");

    const billingEffectsBefore = h.c.fixtures.billing.effects.length;
    const submitted = await call.tool("submit_billing_review", { actionId, digest });
    expect(submitted.status).toBe("SUCCESS");
    expect(submitted.data).toMatchObject({ outcome: "REQUEST_ACCEPTED", workflowAccepted: true, review: { reviewId: actionId, status: "REQUEST_ACCEPTED" } });
    const ref = (submitted.data?.review as { supportReference: string }).supportReference;
    expect(ref).toMatch(/^SR-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(submitted.speech?.templateId).toBe("commitment.request_accepted_pending_sync");

    // Authoritative billing state: IN_REVIEW, exactly one effect, balance unchanged (no refund applied).
    const invoice = await h.c.fixtures.billing.getInvoice(INVOICE);
    expect(invoice?.status).toBe("IN_REVIEW");
    expect(invoice?.balanceMinor).toBe(INVOICES[0].balanceMinor);
    expect(h.c.fixtures.billing.effects.length - billingEffectsBefore).toBe(1);

    // Ledger COMMITTED with the receipt.
    const [ledger] = await h.q<{ state: string; receipt: { receiptId: string } | null }>("select state, receipt from action_ledger where action_id = $1", [actionId]);
    expect(ledger?.state).toBe("COMMITTED");

    // Durable review workflow started in the commit transaction WITH a narrowly scoped durable grant.
    const [wf] = await h.q<{ workflow_id: string; state: string; grant_ref: string | null; source_record_refs: string[]; owner_queue: string }>(
      "select workflow_id, state, grant_ref, source_record_refs, owner_queue from workflow_instances where workflow_type = 'billing_dispute_review' and correlation_id = $1",
      [actionId],
    );
    expect(wf?.state).toBe("ACCEPTED");
    expect(wf?.grant_ref).toMatch(/^grt_/);
    expect(wf?.source_record_refs).toEqual(expect.arrayContaining([actionId, INVOICE, wf?.grant_ref]));
    const [grant] = await h.q<{ subject_id: string; actor_id: string | null; actions: string[]; source_ref: string; expires_at: Date; revoked_at: Date | null }>(
      "select subject_id, actor_id, actions, source_ref, expires_at, revoked_at from durable_action_grants where grant_id = $1",
      [wf?.grant_ref],
    );
    expect(grant).toMatchObject({ subject_id: AVERY.subjectId, actor_id: AVERY.actorId, source_ref: actionId, revoked_at: null });
    expect([...(grant?.actions ?? [])].sort()).toEqual(["billing.review.commit", "billing.review.decision_notice", "billing.review.outcome_notice"]);
    expect(new Date(grant?.expires_at as Date).getTime()).toBeGreaterThan(h.clock.now().getTime());

    // Support request (REQUEST_ACCEPTED, billing intake queue), linked to the action and the workflow.
    const sr = await h.c.business.supportRequests.getByReference(h.c.config.tenantId, ref);
    expect(sr).toMatchObject({ disposition: "REQUEST_ACCEPTED", issueCategory: "billing_dispute", ownerQueue: "q_billing_intake", syncState: "PENDING", salesforceCaseId: null, restricted: false });
    expect(sr?.commitReceiptIds).toEqual([(ledger?.receipt as { receiptId: string }).receiptId]);
    // The minimized CRM summary records explicitly that nothing was promised (not caller-facing).
    expect(sr?.summary).toContain("No refund, waiver or adjustment was promised.");

    // The worker consumer synchronizes it to the Salesforce fixture (idempotent upsert by external id).
    await h.runWorker(["outbox.dispatch", "outbox.consume"]);
    const synced = await h.c.business.supportRequests.getByReference(h.c.config.tenantId, ref);
    expect(synced?.syncState).toBe("SYNCED");
    expect(synced?.salesforceCaseId).toMatch(/^[a-zA-Z0-9]{15,18}$/);
    const cases = h.c.fixtures.supportRecords.records().cases.filter((x) => x.caseId === synced?.salesforceCaseId);
    expect(cases).toHaveLength(1);
    // Redelivery creates nothing new.
    await h.runWorker(["outbox.dispatch", "outbox.consume"]);
    expect(h.c.fixtures.supportRecords.records().cases.filter((x) => x.caseId === synced?.salesforceCaseId)).toHaveLength(1);

    // Call end: acceptance of durable work is REQUEST_ACCEPTED, never RESOLVED (ACT-04).
    const end = await call.end("FLOW_COMPLETED");
    expect(end).toEqual({ ended: true, outcome: "REQUEST_ACCEPTED", reasonCode: "REQUEST_ACCEPTED_NOT_RESOLUTION" });

    // Caller-visible: nothing rendered promises a refund.
    expect(call.utterances().length).toBeGreaterThanOrEqual(4);
    for (const u of call.utterances()) expect(REFUND_PROMISE.test(u), u).toBe(false);
    expect(call.heard.map((x) => x.templateId)).toEqual(expect.arrayContaining(["billing.review_confirmation", "commitment.request_accepted_pending_sync"]));

    const events = await h.auditFor(call.callId);
    expect(events.some((e) => e.action === "interaction.outcome_recorded" && e.reasonCode === "REQUEST_ACCEPTED_NOT_RESOLUTION")).toBe(true);
    const grantIssued = await h.c.auditQuery.search({ tenantId: h.c.config.tenantId, correlationId: wf?.grant_ref as string, limit: 10 });
    expect(grantIssued.map((e) => e.action)).toContain("workflow.grant.issued");
    await h.expectAuditChainIntact();
  }, 120_000);

  it("[SPEC-16.journey-2][ACT-03][SPEC-7.durable-grant] a review commit known only after reconciliation: the worker's action.committed consumer starts the review workflow with its grant exactly once", async () => {
    const call = h.call();
    await call.start();
    await call.role("client");
    expect((await call.verify(AVERY, "avery.synthetic")).bound).toBe(true);
    // The other OPEN invoice of the SYNTHETIC world belongs to another client: use a fresh review of Avery's invoice
    // only if it is still OPEN; the first test moved it to IN_REVIEW, so reopen it in the fixture store (LOCAL FIXTURE).
    h.c.fixtures.store.update("invoices", INVOICE, (inv: { status: string }) => {
      inv.status = "OPEN";
    });
    const prep = await call.tool("prepare_billing_review", { invoiceId: INVOICE, reasonCategory: "AMOUNT_INCORRECT" });
    expect(prep.status).toBe("SUCCESS");
    const actionId = prep.data?.actionId as string;
    const digest = prep.data?.actionDigest as string;
    await call.confirmPending();
    // LOCAL FIXTURE fault: the billing system applies the review but the response times out (ACT-03).
    h.c.fixtures.faults.inject({ integrationId: "billing", operation: "markInReview", kind: "TIMEOUT_AFTER_COMMIT" });
    const submitted = await call.tool("submit_billing_review", { actionId, digest });
    expect(submitted.status).toBe("UNKNOWN_OUTCOME");
    expect(submitted.speech).toBeNull();
    expect(await h.q("select workflow_id from workflow_instances where correlation_id = $1", [actionId])).toEqual([]);

    // Worker: reconcile by idempotency key -> COMMITTED -> action.committed -> follow-up in the consumer's
    // dedup transaction as app_worker (migration 0910 grants it INSERT on durable_action_grants).
    await h.runWorker(["actions.reconcile", "outbox.dispatch", "outbox.consume"]);
    await h.runWorker(["actions.reconcile", "outbox.dispatch", "outbox.consume"]);
    const [ledger] = await h.q<{ state: string }>("select state from action_ledger where action_id = $1", [actionId]);
    expect(ledger?.state).toBe("COMMITTED");
    const wfs = await h.q<{ grant_ref: string | null; state: string }>("select grant_ref, state from workflow_instances where workflow_type = 'billing_dispute_review' and correlation_id = $1", [actionId]);
    expect(wfs).toHaveLength(1);
    expect(wfs[0]?.grant_ref).toMatch(/^grt_/);
    const [grant] = await h.q<{ subject_id: string; source_ref: string }>("select subject_id, source_ref from durable_action_grants where grant_id = $1", [wfs[0]?.grant_ref]);
    expect(grant).toMatchObject({ subject_id: AVERY.subjectId, source_ref: actionId });
    const srs = await h.q<{ reference_number: string; disposition: string }>(
      "select r.reference_number, r.disposition from support_requests r join support_request_links l on l.support_request_id = r.support_request_id where l.link_kind = 'action' and l.link_ref = $1",
      [actionId],
    );
    expect(srs).toHaveLength(1);
    expect(srs[0]?.disposition).toBe("REQUEST_ACCEPTED");
    expect((await call.end()).outcome).toBe("REQUEST_ACCEPTED");
    reconciledActionId = actionId;
  }, 120_000);

  it("[SPEC-7.durable-grant][SPEC-9.recheck] the specialist's decision notice passes the durable grant check and the CURRENT pre-disclosure recheck (consent, account state, policy) and completes", async () => {
    const tenantId = h.c.config.tenantId;
    const workflowId = await reviewWorkflowOf(firstActionId);
    await toSpecialistDecision(workflowId);
    const done = await specialistDecides(workflowId, "REJECT");
    expect(done.state).toBe("COMPLETED");
    expect((await h.c.workflows.get(tenantId, workflowId))?.state).toBe("COMPLETED");
    expect(h.c.metrics.counterValue("vsp_grant_checks_total", { result: "valid" })).toBeGreaterThanOrEqual(1);
    expect(h.c.metrics.counterValue("vsp_grant_checks_total", { result: "store_unconfigured" })).toBe(0);
    // The recheck evaluated the CURRENT bundle for the grant's subject (no policy change since acceptance).
    const allowed = (await h.c.auditQuery.search({ tenantId, correlationId: firstActionId, limit: 50 })).filter((e) => e.action === "workflow.recheck.allowed");
    expect(allowed).toHaveLength(1);
    expect(allowed[0]).toMatchObject({ outcome: "ALLOWED", reasonCode: null, policyDecision: { allow: true, policyVersion: h.c.policy.policyVersion } });
    const [snap] = await h.q<{ policy_snapshot_version: string | null }>("select policy_snapshot_version from workflow_instances where workflow_id = $1", [workflowId]);
    expect(snap?.policy_snapshot_version).toBe(h.c.policy.policyVersion);
    expect(await policyChangedEvents(workflowId)).toEqual([]);
  }, 60_000);

  it("[SPEC-9.recheck][ACT-03] a review accepted by reconciliation carries no consent snapshot (the worker never saw the call's consent): its disclosure waits for a human (CONSENT_NOT_ESTABLISHED) until the consent registry records current consent", async () => {
    const tenantId = h.c.config.tenantId;
    const workflowId = await reviewWorkflowOf(reconciledActionId);
    await toSpecialistDecision(workflowId);
    await expect(specialistDecides(workflowId, "REJECT")).rejects.toMatchObject({ reasonCode: "CONSENT_NOT_ESTABLISHED" });
    expect(await policyChangedEvents(workflowId)).toEqual(["CONSENT_NOT_ESTABLISHED"]);
    h.c.recheck.consent.record(tenantId, AVERY.subjectId, "GRANTED");
    expect((await specialistDecides(workflowId, "REJECT")).state).toBe("COMPLETED");
  }, 60_000);

  it("[SPEC-9.recheck][SPEC-7.durable-grant] consent revoked and an account closed after acceptance apply immediately: each records POLICY_CHANGED_PENDING_ACTION and the decision stays with a human; restored state completes", async () => {
    const tenantId = h.c.config.tenantId;
    const actionId = await acceptedReview("CHARGE_NOT_RECOGNIZED");
    const workflowId = await reviewWorkflowOf(actionId);
    await toSpecialistDecision(workflowId);

    // The client withdraws consent after the call (trusted consent registry, LOCAL FIXTURE).
    h.c.recheck.consent.revoke(tenantId, AVERY.subjectId);
    await expect(specialistDecides(workflowId, "REJECT")).rejects.toMatchObject({ reasonCode: "CONSENT_REVOKED" });
    expect((await h.c.workflows.get(tenantId, workflowId))?.state).toBe("WAITING_FOR_HUMAN");
    expect(await policyChangedEvents(workflowId)).toEqual(["CONSENT_REVOKED"]);

    // Consent restored, but the account is now closed (identity directory, LOCAL FIXTURE).
    h.c.recheck.consent.record(tenantId, AVERY.subjectId, "GRANTED");
    h.c.identity.directory.setAccountState(AVERY.accountId, "CLOSED");
    try {
      await expect(specialistDecides(workflowId, "REJECT")).rejects.toMatchObject({ reasonCode: "ACCOUNT_CLOSED" });
      expect(await policyChangedEvents(workflowId)).toEqual(["CONSENT_REVOKED", "ACCOUNT_CLOSED"]);
    } finally {
      h.c.identity.directory.setAccountState(AVERY.accountId, "ACTIVE");
    }
    const denied = (await h.c.auditQuery.search({ tenantId, correlationId: actionId, limit: 50 })).filter((e) => e.action === "workflow.recheck.denied");
    expect(denied.map((e) => e.reasonCode).sort()).toEqual(["ACCOUNT_CLOSED", "CONSENT_REVOKED"]);

    // Positive control: with current consent and an active account the same decision completes.
    expect((await specialistDecides(workflowId, "REJECT")).state).toBe("COMPLETED");
  }, 120_000);
});
