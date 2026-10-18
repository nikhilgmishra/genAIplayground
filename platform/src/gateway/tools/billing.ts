/**
 * get_invoice_status (invoice:read), prepare_billing_review (billing:prepare_review),
 * submit_billing_review (billing:submit_review) and get_claim_status (claim:read).
 *
 * Financial facts come from authoritative fields only (integer minor units, line
 * codes, dates); no coverage decision, fee waiver or refund promise is ever produced.
 * Payments only through the approved hosted payment path (card data never by voice).
 * A billing review result is REQUEST_ACCEPTED, never RESOLVED (ACT-04).
 */
import { z } from "zod";
import type { ClaimStatus, Invoice } from "../../adapters/ports.js";
import { BILLING_REVIEW_REASONS } from "../../business/services/billing.js";
import type { BusinessServices } from "../../business/services/types.js";
import { auditSessionRef, subjectResource, unresolvableResource } from "../../business/shared.js";
import { speechFor } from "../../business/speech.js";
import type { ToolSpeech } from "../../business/speech.js";
import type { AuthContext, PolicyPurpose } from "../../protocol/index.js";
import { toolPolicyRef } from "../../policy/input.js";
import type { ToolModule } from "../ports.js";
import { CommitInput, DateArg, Id, InstantArg, SupportRefArg, denied, failed, fromError, ok, retryable, sourceRef, unknownOutcome } from "./common.js";
import type { CommitInputT } from "./common.js";
import { TOOL_DEFINITIONS } from "./definitions.js";

const readPurpose = (auth: AuthContext): PolicyPurpose => (auth.selectedRole === "personal_representative" ? "representative_access" : "caller_self_service");

// ---------------------------------------------------------------------------- invoice

const LineCode = z.enum(["SESSION_FEE", "LATE_CANCELLATION", "NO_SHOW", "ADJUSTMENT", "PAYMENT"]);

const InvoiceRecord = z.strictObject({
  invoiceId: Id,
  issuedOn: DateArg,
  dueOn: DateArg,
  status: z.enum(["OPEN", "PAID", "IN_REVIEW", "VOID"]),
  balanceMinor: z.number().int(),
  currency: z.literal("USD"),
  lines: z.array(z.strictObject({ code: LineCode, serviceDate: DateArg, amountMinor: z.number().int() })).max(32),
});

/**
 * Optional LINE_EXPLANATION selector: the charge the caller names, by its authoritative charge
 * code and/or amount in integer minor units (at least one). The explanation then targets exactly
 * that line; a selector matching no line, or several, explains no line (balance facts instead).
 * Line ids are not offered: they are outside the invoice:read field mask, so the conversational
 * layer never sees one.
 */
export const ChargeSelector = z
  .strictObject({ chargeCode: LineCode.nullable(), amountMinor: z.number().int().min(0).max(100_000_000).nullable() })
  .refine((v) => v.chargeCode !== null || v.amountMinor !== null, { message: "CHARGE_SELECTOR_EMPTY" });
export type ChargeSelectorT = z.infer<typeof ChargeSelector>;

export const InvoiceInput = z
  .strictObject({
    invoiceId: Id.nullable(),
    detail: z.enum(["BALANCE", "LINE_EXPLANATION", "PAYMENT_PAGE"]),
    serviceDate: DateArg.nullable(),
    line: ChargeSelector.nullable().optional(),
  })
  .refine((v) => v.line === undefined || v.line === null || v.detail === "LINE_EXPLANATION", { message: "CHARGE_SELECTOR_REQUIRES_LINE_EXPLANATION" });
export const InvoiceOutput = z.strictObject({
  invoices: z.array(InvoiceRecord).max(10),
  paymentAvailable: z.boolean(),
  paymentPortalPath: z.string().regex(/^\/[a-z0-9_-]{1,32}(\/[a-z0-9_-]{1,32}){0,3}$/).nullable(),
});

const invoiceRecord = (i: Invoice): z.infer<typeof InvoiceRecord> => ({
  invoiceId: i.invoiceId,
  issuedOn: i.issuedOn,
  dueOn: i.dueOn,
  status: i.status,
  balanceMinor: i.balanceMinor,
  currency: i.currency,
  lines: i.lines.map((l) => ({ code: l.code, serviceDate: l.serviceDate, amountMinor: l.amountMinor })),
});

/** Line codes the approved explanation template can name. */
const EXPLAINABLE_LINES: Record<string, string> = { SESSION_FEE: "SESSION_FEE", LATE_CANCELLATION: "LATE_CANCELLATION" };

/**
 * The line a LINE_EXPLANATION explains. With a selector the caller named one charge: exactly one
 * line must match it (never a different or a guessed line). Without one, the first explainable
 * line (on the service date when given), as before.
 */
export function selectInvoiceLine(inv: Pick<Invoice, "lines">, serviceDate: string | null, selector: ChargeSelectorT | null | undefined): Invoice["lines"][number] | undefined {
  const onDate = inv.lines.filter((l) => serviceDate === null || l.serviceDate === serviceDate);
  if (!selector) return onDate.find((l) => EXPLAINABLE_LINES[l.code]);
  const matches = onDate.filter((l) => (selector.chargeCode === null || l.code === selector.chargeCode) && (selector.amountMinor === null || l.amountMinor === selector.amountMinor));
  return matches.length === 1 ? matches[0] : undefined;
}

function invoiceSpeech(s: BusinessServices, input: Pick<z.infer<typeof InvoiceInput>, "detail" | "serviceDate" | "line">, inv: Invoice | undefined, payable: boolean): ToolSpeech {
  if (!inv) return speechFor(s.deps.templates, "lookup.none_found");
  const refs = [sourceRef("billing", inv.invoiceId)];
  if (input.detail === "PAYMENT_PAGE") return speechFor(s.deps.templates, payable ? "billing.payment_page" : "billing.not_payable");
  if (input.detail === "LINE_EXPLANATION") {
    const line = selectInvoiceLine(inv, input.serviceDate, input.line);
    if (line && EXPLAINABLE_LINES[line.code] && line.amountMinor >= 0) {
      return speechFor(s.deps.templates, "invoice.line_explanation", { serviceDate: line.serviceDate, amount: line.amountMinor, lineType: EXPLAINABLE_LINES[line.code] as string }, refs);
    }
  }
  return speechFor(s.deps.templates, "invoice.balance", { amount: Math.max(0, inv.balanceMinor), dueDate: inv.dueOn }, refs);
}

export function getInvoiceStatusTool(s: BusinessServices): ToolModule<z.infer<typeof InvoiceInput>, z.infer<typeof InvoiceOutput>> {
  return {
    definition: TOOL_DEFINITIONS.get_invoice_status,
    maskTarget: { collectionKey: "invoices", envelopeKeys: ["paymentAvailable", "paymentPortalPath"] },
    input: InvoiceInput,
    output: InvoiceOutput,
    purpose: (auth) => readPurpose(auth),
    async resolveResource(auth, input) {
      if (input.invoiceId !== null) {
        const inv = await s.billing.invoice(input.invoiceId);
        return inv ? subjectResource(auth, "invoice", inv.subjectId, "FINANCIAL") : unresolvableResource(auth, "invoice", "FINANCIAL");
      }
      return auth.subjectId ? subjectResource(auth, "invoice", auth.subjectId, "FINANCIAL") : unresolvableResource(auth, "invoice", "FINANCIAL");
    },
    async execute(ctx, input) {
      try {
        let invoices: Invoice[];
        if (input.invoiceId !== null) {
          const inv = await s.billing.invoice(input.invoiceId);
          if (!inv) return denied("RESOURCE_NOT_AUTHORIZED");
          invoices = [inv];
        } else {
          if (!ctx.auth.subjectId) return denied("RESOURCE_NOT_AUTHORIZED");
          invoices = (await s.billing.invoicesFor(ctx.auth.subjectId)).slice(0, 10);
        }
        const focus = invoices.find((i) => i.status === "OPEN") ?? invoices[0];
        const path = focus ? await s.billing.paymentPath(focus) : null;
        return ok({ invoices: invoices.map(invoiceRecord), paymentAvailable: path !== null, paymentPortalPath: path }, invoiceSpeech(s, input, focus, path !== null));
      } catch (err) {
        return fromError(err, "BILLING_LOOKUP_FAILED");
      }
    },
  };
}

// ---------------------------------------------------------------------------- billing review

export const ReviewPrepareInput = z.strictObject({ invoiceId: Id, reasonCategory: z.enum(BILLING_REVIEW_REASONS) });
export const ReviewPrepareOutput = z.strictObject({
  review: z.strictObject({ reviewId: z.string().regex(/^act_[A-Za-z0-9_-]{16,64}$/), status: z.literal("PENDING_CONFIRMATION"), supportReference: z.null() }),
  actionId: z.string().regex(/^act_[A-Za-z0-9_-]{16,64}$/),
  actionDigest: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: InstantArg,
  confirmationTemplateId: z.literal("billing.review_confirmation"),
});

export function prepareBillingReviewTool(s: BusinessServices): ToolModule<z.infer<typeof ReviewPrepareInput>, z.infer<typeof ReviewPrepareOutput>> {
  return {
    definition: TOOL_DEFINITIONS.prepare_billing_review,
    maskTarget: { collectionKey: "review", envelopeKeys: ["actionId", "actionDigest", "expiresAt", "confirmationTemplateId"] },
    input: ReviewPrepareInput,
    output: ReviewPrepareOutput,
    purpose: () => "caller_self_service",
    async resolveResource(auth, input) {
      // The invoice's real subject (authoritative billing lookup); billing:prepare_review needs no digest.
      const inv = await s.billing.invoice(input.invoiceId);
      return inv ? subjectResource(auth, "billing_review", inv.subjectId, "FINANCIAL") : unresolvableResource(auth, "billing_review", "FINANCIAL");
    },
    async execute(ctx, input) {
      try {
        const r = await s.billing.prepareReview(ctx.auth, ctx.decision, input);
        if (r.kind === "NOT_ELIGIBLE") return failed(r.reasonCode);
        const { action, invoice } = r;
        return ok(
          {
            review: { reviewId: action.actionId, status: "PENDING_CONFIRMATION", supportReference: null },
            actionId: action.actionId,
            actionDigest: action.digest,
            expiresAt: action.expiresAt,
            confirmationTemplateId: "billing.review_confirmation",
          },
          speechFor(s.deps.templates, "billing.review_confirmation", { issuedDate: invoice.issuedOn }, [sourceRef("action", action.actionId), sourceRef("billing", invoice.invoiceId)]),
        );
      } catch (err) {
        return fromError(err, "PREPARE_FAILED");
      }
    },
  };
}

export const ReviewSubmitOutput = z.strictObject({
  review: z.strictObject({ reviewId: z.string().regex(/^act_[A-Za-z0-9_-]{16,64}$/), status: z.literal("REQUEST_ACCEPTED"), supportReference: SupportRefArg.nullable() }),
  outcome: z.literal("REQUEST_ACCEPTED"),
  workflowAccepted: z.boolean(),
});

export function submitBillingReviewTool(s: BusinessServices): ToolModule<CommitInputT, z.infer<typeof ReviewSubmitOutput>> {
  const definition = TOOL_DEFINITIONS.submit_billing_review;
  async function prepared(auth: AuthContext, input: CommitInputT) {
    const action = await s.deps.actions.get(auth.tenantId, input.actionId).catch(() => null);
    const binding = auditSessionRef(auth);
    if (!action || action.kind !== "billing.review.submit" || binding === null || action.sessionRef !== binding) return null;
    const inv = await s.billing.invoice(action.target.recordRef).catch(() => null);
    if (!inv || inv.subjectId !== action.subjectId) return null;
    return action;
  }
  return {
    definition,
    maskTarget: { collectionKey: "review", envelopeKeys: ["outcome", "workflowAccepted"] },
    input: CommitInput,
    output: ReviewSubmitOutput,
    purpose: () => "caller_self_service",
    async resolveResource(auth, input) {
      const action = await prepared(auth, input);
      return action ? subjectResource(auth, "billing_review", action.subjectId, "FINANCIAL", input.digest) : unresolvableResource(auth, "billing_review", "FINANCIAL", input.digest);
    },
    async execute(ctx, input) {
      const action = await prepared(ctx.auth, input);
      if (!action) return denied("RESOURCE_NOT_AUTHORIZED");
      const r = await s.billing.commitReview(ctx.auth, input, {
        action: definition.permissions[0] as string,
        purpose: "caller_self_service",
        tool: toolPolicyRef(definition),
        resource: subjectResource(ctx.auth, "billing_review", action.subjectId, "FINANCIAL", input.digest),
      });
      switch (r.kind) {
        case "REQUEST_ACCEPTED": {
          const ref = r.supportRequest?.referenceNumber ?? null;
          const speech = ref
            ? speechFor(s.deps.templates, "commitment.request_accepted_pending_sync", { supportReference: ref }, [sourceRef("receipt", r.receiptId)])
            : speechFor(s.deps.templates, "commitment.request_accepted_no_reference", {}, [sourceRef("receipt", r.receiptId)]);
          return ok({ review: { reviewId: r.actionId, status: "REQUEST_ACCEPTED", supportReference: ref }, outcome: "REQUEST_ACCEPTED", workflowAccepted: r.workflowId !== null && r.workflowId !== "" }, speech);
        }
        case "STATE_CHANGED":
          return failed("STATE_CHANGED");
        case "UNKNOWN":
          return unknownOutcome(r.reasonCode, r.reconciliationRef);
        case "RETRYABLE":
          return retryable(r.reasonCode, r.retryAfterMs);
        case "DENIED":
          return denied(r.reasonCode);
        case "REJECTED":
        case "FAILED":
          return failed(r.reasonCode);
      }
    },
  };
}

// ---------------------------------------------------------------------------- claims

const ClaimRecord = z.strictObject({
  claimId: Id,
  serviceDate: DateArg,
  payerDisplayName: z.string().max(80),
  insurerStatus: z.enum(["RECEIVED", "IN_PROCESS", "ADJUDICATED_PAID", "ADJUDICATED_DENIED", "NEEDS_INFORMATION"]),
  statusAsOf: InstantArg,
});
export const ClaimInput = z.strictObject({ claimId: Id.nullable() });
export const ClaimOutput = z.strictObject({ claims: z.array(ClaimRecord).max(10) });

const CLAIM_TEMPLATE_STATUS: Record<ClaimStatus["insurerStatus"], string> = {
  RECEIVED: "RECEIVED",
  IN_PROCESS: "IN_PROCESS",
  NEEDS_INFORMATION: "PENDING_INFORMATION",
  ADJUDICATED_PAID: "ADJUDICATED",
  ADJUDICATED_DENIED: "DENIED",
};

export function getClaimStatusTool(s: BusinessServices): ToolModule<z.infer<typeof ClaimInput>, z.infer<typeof ClaimOutput>> {
  return {
    definition: TOOL_DEFINITIONS.get_claim_status,
    maskTarget: { collectionKey: "claims", envelopeKeys: [] },
    input: ClaimInput,
    output: ClaimOutput,
    purpose: () => "caller_self_service",
    async resolveResource(auth, input) {
      if (input.claimId !== null) {
        const c = await s.deps.adapters.claims.getClaim(input.claimId);
        return c ? subjectResource(auth, "claim", c.subjectId, "FINANCIAL") : unresolvableResource(auth, "claim", "FINANCIAL");
      }
      return auth.subjectId ? subjectResource(auth, "claim", auth.subjectId, "FINANCIAL") : unresolvableResource(auth, "claim", "FINANCIAL");
    },
    async execute(ctx, input) {
      try {
        let claims: ClaimStatus[];
        if (input.claimId !== null) {
          const c = await s.deps.adapters.claims.getClaim(input.claimId);
          if (!c) return denied("RESOURCE_NOT_AUTHORIZED");
          claims = [c];
        } else {
          if (!ctx.auth.subjectId) return denied("RESOURCE_NOT_AUTHORIZED");
          claims = (await s.deps.adapters.claims.listClaims(ctx.auth.subjectId)).slice(0, 10);
        }
        const first = claims[0];
        const speech = first
          ? speechFor(
              s.deps.templates,
              "claim.status",
              { serviceDate: first.serviceDate, insurerStatus: CLAIM_TEMPLATE_STATUS[first.insurerStatus], asOfDate: first.statusAsOf.slice(0, 10) },
              [sourceRef("claims", first.claimId)],
            )
          : speechFor(s.deps.templates, "lookup.none_found");
        return ok(
          { claims: claims.map((c) => ({ claimId: c.claimId, serviceDate: c.serviceDate, payerDisplayName: c.payerDisplayName, insurerStatus: c.insurerStatus, statusAsOf: c.statusAsOf })) },
          speech,
        );
      } catch (err) {
        return fromError(err, "CLAIMS_LOOKUP_FAILED");
      }
    },
  };
}
