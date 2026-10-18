/**
 * Billing tools end to end (REAL modules over PGlite + LOCAL SYNTHETIC fixtures):
 * invoice explanation, hosted payment page, billing review (REQUEST_ACCEPTED) and claims.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLAIMS, INVOICES, PEOPLE } from "../fixtures/synthetic-world.js";
import { loadDefaultTemplateRegistry } from "../voice/registry.js";
import { createBusinessHarness, expectDone, type BusinessHarness } from "./testing/harness.js";

let h: BusinessHarness;
beforeEach(async () => {
  h = await createBusinessHarness();
});
afterEach(async () => {
  await h.close();
});

const inv = INVOICES[0];

async function verified(person: (typeof PEOPLE)[keyof typeof PEOPLE] = PEOPLE.avery, callId?: string) {
  const { sessionRef } = await h.startCall(callId);
  return h.verify(person, sessionRef);
}

async function prepareAndConfirmReview(auth: Awaited<ReturnType<typeof verified>>) {
  const p = expectDone(await h.invoke("prepare_billing_review", auth, { invoiceId: inv.invoiceId, reasonCategory: "LATE_CANCELLATION_FEE_DISPUTE" }));
  if (p.outcome.status !== "SUCCESS") throw new Error(`prepare ${p.outcome.status}`);
  const masked = p.masked as { actionId: string; actionDigest: string; review: { status: string } };
  expect(masked.review.status).toBe("PENDING_CONFIRMATION");
  await h.confirm(auth, masked.actionId, masked.actionDigest);
  return { actionId: masked.actionId, digest: masked.actionDigest };
}

describe("invoice explanation and payment page", () => {
  it("[SPEC-4.invoice] authoritative invoice fields only, masked to invoice:read; balance spoken from integer minor units", async () => {
    const auth = await verified();
    const r = expectDone(await h.invoke("get_invoice_status", auth, { invoiceId: inv.invoiceId, detail: "BALANCE", serviceDate: null }));
    expect(r.outcome.status).toBe("SUCCESS");
    const masked = r.masked as { invoices: { balanceMinor: number; lines: Record<string, unknown>[] }[]; paymentAvailable: boolean };
    expect(masked.invoices[0]?.balanceMinor).toBe(10000);
    expect(Object.keys(masked.invoices[0]?.lines[0] ?? {}).sort()).toEqual(["amountMinor", "code", "serviceDate"]);
    if (r.outcome.status === "SUCCESS") expect(r.outcome.speech).toMatchObject({ templateId: "invoice.balance", slots: { amount: 10000, dueDate: "2026-10-31" } });
  });

  it("[SPEC-4.payment-page] the payment page detail directs to the approved hosted path and never collects card data", async () => {
    const auth = await verified();
    const r = expectDone(await h.invoke("get_invoice_status", auth, { invoiceId: null, detail: "PAYMENT_PAGE", serviceDate: null }));
    if (r.outcome.status !== "SUCCESS") throw new Error("expected success");
    expect(r.masked).toMatchObject({ paymentAvailable: true, paymentPortalPath: "/billing/pay" });
    expect(r.outcome.speech?.templateId).toBe("billing.payment_page");
    expect(() => h.tool("get_invoice_status").input.parse({ invoiceId: null, detail: "PAYMENT_PAGE", serviceDate: null, cardNumber: "4111111111111111" })).toThrow();
  });

  it("[SPEC-4.invoice] a line explanation names only an approved line type", async () => {
    const auth = await verified();
    const r = expectDone(await h.invoke("get_invoice_status", auth, { invoiceId: inv.invoiceId, detail: "LINE_EXPLANATION", serviceDate: "2026-09-27" }));
    if (r.outcome.status !== "SUCCESS") throw new Error("expected success");
    expect(r.outcome.speech).toMatchObject({ templateId: "invoice.line_explanation", slots: { serviceDate: "2026-09-27", amount: 7500, lineType: "LATE_CANCELLATION" } });
  });
});

describe("billing review", () => {
  it("[ACT-04] [SPEC-16.billing-dispute] review commit marks IN_REVIEW, starts billing_dispute_review and creates a support request in the same commit: REQUEST_ACCEPTED, never RESOLVED", async () => {
    const auth = await verified();
    const { actionId, digest } = await prepareAndConfirmReview(auth);
    const c = expectDone(await h.invoke("submit_billing_review", auth, { actionId, digest }));
    expect(c.outcome.status).toBe("SUCCESS");
    if (c.outcome.status !== "SUCCESS") return;
    const data = c.outcome.data as { outcome: string; workflowAccepted: boolean; review: { supportReference: string } };
    expect(data.outcome).toBe("REQUEST_ACCEPTED");
    expect(data.workflowAccepted).toBe(true);
    expect(data.review.supportReference).toMatch(/^SR-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(c.outcome.speech?.templateId).toBe("commitment.request_accepted_pending_sync");

    // Authoritative state: invoice IN_REVIEW, no balance change; workflow ACCEPTED; SR linked to action and workflow.
    const after = await h.fixtures.billing.getInvoice(inv.invoiceId);
    expect(after?.status).toBe("IN_REVIEW");
    expect(after?.balanceMinor).toBe(inv.balanceMinor);
    const sr = await h.services.support.findByActionId(auth.tenantId, actionId);
    expect(sr).toMatchObject({ issueCategory: "billing_dispute", disposition: "REQUEST_ACCEPTED", syncState: "PENDING" });
    const links = await h.services.support.linkedRefs(auth.tenantId, sr?.supportRequestId ?? "");
    expect(links.actionIds).toEqual([actionId]);
    expect(links.workflowIds).toHaveLength(1);
    const wf = await h.workflows.get(auth.tenantId, links.workflowIds[0] as string);
    expect(wf).toMatchObject({ type: "billing_dispute_review", state: "ACCEPTED" });

    const receiptId = (await h.services.interactions.get(auth.tenantId, actionId))?.receiptId as string;
    const outcome = await h.business.outcomes.record({
      tenantId: auth.tenantId,
      callId: auth.callId,
      contractId: "billing_review@1",
      evidence: { commitReceiptIds: [receiptId], informationProvided: true, requestAccepted: true, transferConnected: false, callerDisconnected: false, policyDeclined: false, failed: false },
    });
    expect(outcome.outcome).toBe("REQUEST_ACCEPTED");
  });

  it("[ACT-04] no billing-review or billing template contains refund, waiver or credit wording", () => {
    const reg = loadDefaultTemplateRegistry();
    const ids = ["billing.review_confirmation", "commitment.request_accepted_pending_sync", "commitment.request_accepted_no_reference", "invoice.balance", "invoice.line_explanation", "billing.payment_page", "billing.not_payable"];
    for (const id of ids) {
      for (const locale of ["en-US", "es-US"]) {
        const t = reg.get(id, locale);
        expect(t, `${id}@${locale}`).not.toBeNull();
        expect(t?.text ?? "").not.toMatch(/refund|reimburs|reembols|devoluci[oó]n|waive|exenci|credit|cr[eé]dito|resolved|resuelt/i);
      }
    }
  });

  it("[ACT-01] a billing review cannot be submitted without the trusted confirmation", async () => {
    const auth = await verified();
    const p = expectDone(await h.invoke("prepare_billing_review", auth, { invoiceId: inv.invoiceId, reasonCategory: "OTHER" }));
    if (p.outcome.status !== "SUCCESS") throw new Error("prepare failed");
    const m = p.masked as { actionId: string; actionDigest: string };
    const c = expectDone(await h.invoke("submit_billing_review", auth, { actionId: m.actionId, digest: m.actionDigest }));
    expect(c.outcome).toMatchObject({ status: "PERMANENT_FAILURE", reasonCode: "ACTION_NOT_CONFIRMED" });
    expect((await h.fixtures.billing.getInvoice(inv.invoiceId))?.status).toBe("OPEN");
  });

  it("[ACT-02] a resubmitted review creates one review, one workflow and one support request", async () => {
    const auth = await verified();
    const { actionId, digest } = await prepareAndConfirmReview(auth);
    const a = expectDone(await h.invoke("submit_billing_review", auth, { actionId, digest }));
    const b = expectDone(await h.invoke("submit_billing_review", auth, { actionId, digest }));
    expect(a.outcome.status).toBe("SUCCESS");
    expect(b.outcome.status).toBe("SUCCESS");
    const refA = a.outcome.status === "SUCCESS" ? (a.outcome.data as { review: { supportReference: string } }).review.supportReference : null;
    const refB = b.outcome.status === "SUCCESS" ? (b.outcome.data as { review: { supportReference: string } }).review.supportReference : null;
    expect(refB).toBe(refA);
    const counts = await h.db.tx(
      async (q) => ({
        sr: Number((await q.query<{ n: number }>("select count(*)::int as n from support_requests")).rows[0]?.n),
        wf: Number((await q.query<{ n: number }>("select count(*)::int as n from workflow_instances where workflow_type = 'billing_dispute_review'")).rows[0]?.n),
      }),
      { role: "owner" },
    );
    expect(counts).toEqual({ sr: 1, wf: 1 });
  });

  it("[ACT-03] [ACT-02] timeout after the billing system applied the review: UNKNOWN, then reconciled by the worker; the action.committed consumer creates the follow-up exactly once", async () => {
    const auth = await verified();
    const { actionId, digest } = await prepareAndConfirmReview(auth);
    h.fixtures.faults.inject({ integrationId: "billing", operation: "markInReview", kind: "TIMEOUT_AFTER_COMMIT" });
    const c = expectDone(await h.invoke("submit_billing_review", auth, { actionId, digest }));
    expect(c.outcome.status).toBe("UNKNOWN_OUTCOME");
    const provider = h.business.providers["billing.review.submit"];
    if (!provider) throw new Error("provider missing");
    const receipt = await h.actions.reconcile(actionId, provider);
    expect(receipt.outcome).toBe("COMMITTED");
    // Reconciliation ran without the per-call hook: no follow-up yet.
    expect(await h.services.support.findByActionId(auth.tenantId, actionId)).toBeNull();
    const consumer = h.business.consumers["action.committed"];
    if (!consumer) throw new Error("consumer missing");
    const payload = { actionId, kind: "billing.review.submit", receiptId: receipt.receiptId, auditEventId: receipt.auditEventId, providerSystem: "billing", reconciled: true };
    await consumer("msg_synthActionCommitted01", payload);
    await consumer("msg_synthActionCommitted01", payload); // redelivery
    await consumer("msg_synthActionCommitted02", payload); // a second copy with another message id
    const sr = await h.services.support.findByActionId(auth.tenantId, actionId);
    expect(sr).toMatchObject({ issueCategory: "billing_dispute", disposition: "REQUEST_ACCEPTED" });
    const n = await h.db.tx(async (q) => Number((await q.query<{ n: number }>("select count(*)::int as n from workflow_instances")).rows[0]?.n), { role: "owner" });
    expect(n).toBe(1);
    expect((await h.services.interactions.get(auth.tenantId, actionId))?.receiptOutcome).toBe("COMMITTED");
  });

  it("[AUTH-05] a client cannot prepare a billing review for another client's invoice even with its valid id", async () => {
    const avery = await verified();
    const r = await h.invoke("prepare_billing_review", avery, { invoiceId: INVOICES[1].invoiceId, reasonCategory: "OTHER" });
    expect(r.stage).toBe("policy");
  });
});

describe("claims", () => {
  it("[SPEC-4.claim-status] insurer status with as-of date; template states it is not a payment guarantee", async () => {
    const auth = await verified();
    const r = expectDone(await h.invoke("get_claim_status", auth, { claimId: CLAIMS[0].claimId }));
    if (r.outcome.status !== "SUCCESS") throw new Error("expected success");
    expect(r.outcome.speech).toMatchObject({ templateId: "claim.status", slots: { serviceDate: "2026-09-20", insurerStatus: "IN_PROCESS", asOfDate: "2026-10-15" } });
    expect(loadDefaultTemplateRegistry().get("claim.status", "en-US")?.text).toMatch(/not a guarantee of payment/);
  });

  it("[AUTH-05] another client's claim id is denied by policy", async () => {
    const blake = await verified(PEOPLE.blake);
    const r = await h.invoke("get_claim_status", blake, { claimId: CLAIMS[0].claimId });
    expect(r.stage).toBe("policy");
  });
});
