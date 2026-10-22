/**
 * Billing and claims-status systems of record (WP-23; canonical billing / claims-status contract).
 *
 * Only what the system of record states: invoice balances and lines, payments it received, and the
 * insurer-reported claim status with its as-of time. There is no coverage decision, fee waiver, refund or claim
 * adjudication here (FO-06-76): the one write is a review request on an invoice, which puts the invoice IN_REVIEW
 * and records the request; it never changes an amount.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Applied } from "./changes.js";
import { ApiError, notFound } from "./errors.js";
import type { ApiDeps } from "./http.js";
import { context, deadlineOf, get, Id, KeyRef, NotAfter, parse } from "./http.js";
import { newId } from "./ids.js";
import type { InvoiceRow } from "./representation.js";
import { claim, invoice, invoiceLine, payment } from "./representation.js";

const Version = z.string().regex(/^[1-9][0-9]{0,8}$/);
const ReviewRequest = z.strictObject({
  invoiceId: Id,
  expectedVersion: Version,
  reasonCode: z.enum(["CHARGE_QUESTIONED", "DUPLICATE_CHARGE_SUSPECTED", "AMOUNT_QUESTIONED"]),
  authority: z.literal("CLIENT_CONFIRMED"),
  actingPartyId: Id,
  notAfter: NotAfter,
});

export function billingRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const { store } = deps;

  get(app, deps, "/api/v1/subjects/:subjectId/invoices", "billing.invoices.list", "billing:read", async (ctx, req) => {
    const { subjectId } = parse(z.object({ subjectId: Id }), req.params);
    const rows = await store.query<InvoiceRow>("select * from refbiz.invoices where account_id = $1 and subject_id = $2 order by issued_on desc, invoice_id limit 100", [ctx.account.account_id, subjectId]);
    return { items: rows.map(invoice), nextCursor: null };
  });

  get(app, deps, "/api/v1/invoices/:invoiceId", "billing.invoice.get", "billing:read", async (ctx, req) => {
    const { invoiceId } = parse(z.object({ invoiceId: Id }), req.params);
    const r = (await store.query<InvoiceRow>("select * from refbiz.invoices where account_id = $1 and invoice_id = $2", [ctx.account.account_id, invoiceId]))[0];
    if (!r) throw notFound();
    return invoice(r);
  });

  get(app, deps, "/api/v1/invoices/:invoiceId/lines", "billing.invoice_lines.list", "billing:read", async (ctx, req) => {
    const { invoiceId } = parse(z.object({ invoiceId: Id }), req.params);
    const acct = ctx.account.account_id;
    if ((await store.query("select 1 from refbiz.invoices where account_id = $1 and invoice_id = $2", [acct, invoiceId])).length === 0) throw notFound();
    const rows = await store.query<{ line_id: string; code: string; service_date: string; amount_minor: string }>(
      "select line_id, code, service_date, amount_minor from refbiz.invoice_lines where account_id = $1 and invoice_id = $2 order by service_date, line_id",
      [acct, invoiceId],
    );
    return { items: rows.map(invoiceLine), nextCursor: null };
  });

  // Payments the billing system received, including ones newer than any warehouse copy (J04).
  get(app, deps, "/api/v1/invoices/:invoiceId/payments", "billing.payments.list", "billing:read", async (ctx, req) => {
    const { invoiceId } = parse(z.object({ invoiceId: Id }), req.params);
    const acct = ctx.account.account_id;
    if ((await store.query("select 1 from refbiz.invoices where account_id = $1 and invoice_id = $2", [acct, invoiceId])).length === 0) throw notFound();
    const rows = await store.query<{ payment_id: string; invoice_id: string; amount_minor: string; received_at: Date; method_code: string; card_last4: string | null }>(
      "select * from refbiz.payments where account_id = $1 and invoice_id = $2 order by received_at desc, payment_id",
      [acct, invoiceId],
    );
    return { items: rows.map(payment), nextCursor: null };
  });

  get(app, deps, "/api/v1/subjects/:subjectId/claims", "claims.list", "claims:read", async (ctx, req) => {
    const { subjectId } = parse(z.object({ subjectId: Id }), req.params);
    const rows = await store.query<Parameters<typeof claim>[0]>("select * from refbiz.claims where account_id = $1 and subject_id = $2 order by service_date desc, claim_id limit 100", [ctx.account.account_id, subjectId]);
    return { items: rows.map(claim), nextCursor: null };
  });

  get(app, deps, "/api/v1/claims/:claimId", "claims.get", "claims:read", async (ctx, req) => {
    const { claimId } = parse(z.object({ claimId: Id }), req.params);
    const r = (await store.query<Parameters<typeof claim>[0]>("select * from refbiz.claims where account_id = $1 and claim_id = $2", [ctx.account.account_id, claimId]))[0];
    if (!r) throw notFound();
    return claim(r);
  });

  app.put("/api/v1/billing-review-requests/:requestId", async (req, reply) => {
    const operation = "billing.review_request.put";
    const ctx = await context(deps, req, reply, operation, "billing:write");
    const { requestId } = parse(z.object({ requestId: KeyRef }), req.params);
    if (req.refbiz) req.refbiz.keyRef = requestId;
    const b = parse(ReviewRequest, req.body);
    const acct = ctx.account.account_id;
    await deps.changes.execute(
      { accountId: acct, operation, keyRef: requestId, body: b, barrierResourceId: b.invoiceId, notAfter: deadlineOf(b) },
      async (tx): Promise<Applied> => {
        const inv = (await tx.query<InvoiceRow>("select * from refbiz.invoices where account_id = $1 and invoice_id = $2 for update", [acct, b.invoiceId])).rows[0];
        if (!inv) throw notFound();
        // Only the invoice's own client may ask for a review of it.
        if (b.actingPartyId !== inv.subject_id) throw new ApiError(403, "AUTHORITY_REFUSED");
        if (inv.status !== "OPEN") throw new ApiError(409, "STATE_CONFLICT");
        if (String(inv.version) !== b.expectedVersion) throw new ApiError(409, "VERSION_CONFLICT");
        await tx.query("update refbiz.invoices set status = 'IN_REVIEW', version = version + 1 where account_id = $1 and invoice_id = $2", [acct, b.invoiceId]);
        await tx.query("insert into refbiz.billing_reviews (account_id, review_id, invoice_id, key_ref, reason_code) values ($1, $2, $3, $4, $5)", [acct, newId("rvw"), b.invoiceId, requestId, b.reasonCode]);
        const after = (await tx.query<InvoiceRow>("select * from refbiz.invoices where account_id = $1 and invoice_id = $2", [acct, b.invoiceId])).rows[0] as InvoiceRow;
        return { resourceType: "invoice", resourceId: b.invoiceId, beforeVersion: String(inv.version), afterVersion: String(inv.version + 1), resource: invoice(after) };
      },
      reply,
    );
  });
}
