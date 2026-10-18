/**
 * Invoice explanation, hosted payment page and billing review (spec sections 4, 8, 9, 16:
 * "a disputed charge routed into a durable review without promising a refund").
 *
 * Billing review = prepared action (billing.review.submit) -> trusted confirmation ->
 * commit through the ledger with BillingReviewCommitPort (invoice marked IN_REVIEW,
 * nothing else changes). In the SAME logical commit (the ledger's onCommitted hook,
 * inside the COMMITTED transaction) the billing_dispute_review workflow is started and
 * an internal support request is created and linked. The result is REQUEST_ACCEPTED:
 * never RESOLVED, never a refund promise (ACT-04). When the commit is completed later
 * by reconciliation (no hook), the "action.committed" consumer performs the same
 * follow-up idempotently.
 */
import type { Invoice } from "../../adapters/ports.js";
import { sha256Hex } from "../../shared/canonical.js";
import type { Queryable } from "../../db/types.js";
import type { AuthContext, CommitReceipt, ConsentState, PolicyDecision, PreparedAction, SupportRequest } from "../../protocol/index.js";
import { ValidationError } from "../../shared/errors.js";
import type { ToolDeps } from "../contract.js";
import { BILLING_REVIEW } from "../contracts/index.js";
import { commitAction, type CommitResult } from "../commit.js";
import type { InteractionIndex } from "../interactions.js";
import type { ReauthorizeSpec } from "../policy.js";
import { issueWorkflowGrant, type WorkflowStartWithSnapshot } from "../grants.js";
import { decideNow } from "../policy.js";
import { BillingReviewCommitPort } from "../providers.js";
import { TOOL_DEFINITIONS } from "../../gateway/tools/definitions.js";
import { AccessDeniedError } from "../../shared/errors.js";
import { authorizeOperatorRetry, withOperatorRetryAuthority } from "./operator-retry.js";
import type { OperatorRetrySpec } from "./operator-retry.js";
import { UNKNOWN_CONSENT } from "../shared.js";
import type { PgSupportRequestService } from "../support/support-request-service.js";

export const BILLING_REVIEW_REASONS = [
  "CHARGE_NOT_RECOGNIZED",
  "AMOUNT_INCORRECT",
  "LATE_CANCELLATION_FEE_DISPUTE",
  "NO_SHOW_FEE_DISPUTE",
  "INSURANCE_SHOULD_HAVE_PAID",
  "OTHER",
] as const;
export type BillingReviewReason = (typeof BILLING_REVIEW_REASONS)[number];

export type BillingReviewPrepareOutcome =
  | { kind: "PREPARED"; action: PreparedAction; invoice: Invoice }
  | { kind: "NOT_ELIGIBLE"; reasonCode: string };

export type BillingReviewCommitOutcome =
  | { kind: "REQUEST_ACCEPTED"; actionId: string; receiptId: string; supportRequest: SupportRequest | null; workflowId: string | null }
  | Exclude<CommitResult, { kind: "COMMITTED" }>;

export class BillingService {
  /** System-of-record commit port; carries the operator-retry authority (ACT-F3) for staff retries. */
  readonly provider: BillingReviewCommitPort & { authorizeOperatorRetry(action: PreparedAction): Promise<PolicyDecision> };

  constructor(
    private readonly deps: ToolDeps,
    private readonly support: PgSupportRequestService,
    private readonly interactions: InteractionIndex,
  ) {
    // A staff retry re-establishes the CALLER's current authority with exactly the submit tool's policy
    // action, purpose and resource (gateway/tools/billing.ts submit_billing_review).
    const submitTool = TOOL_DEFINITIONS.submit_billing_review;
    const spec: OperatorRetrySpec = {
      action: submitTool.permissions[0] ?? "",
      purpose: "caller_self_service",
      tool: submitTool,
      resource: (a) => ({ type: "billing_review", tenantId: a.tenantId, subjectId: a.subjectId, organizationId: null, classification: "FINANCIAL", actionDigest: a.digest }),
      check: async (a) => {
        if (a.kind !== "billing.review.submit") throw new AccessDeniedError("ACTION_NOT_AVAILABLE");
      },
    };
    this.provider = withOperatorRetryAuthority(new BillingReviewCommitPort(deps.adapters.billing), (a) => authorizeOperatorRetry(deps, spec, a));
  }

  async invoice(invoiceId: string): Promise<Invoice | null> {
    return this.deps.adapters.billing.getInvoice(invoiceId);
  }

  async invoicesFor(subjectId: string): Promise<Invoice[]> {
    return this.deps.adapters.billing.listInvoices(subjectId);
  }

  /** Approved hosted payment path for an OPEN invoice; null when not payable. Card data never by voice. */
  async paymentPath(invoice: Invoice): Promise<string | null> {
    if (invoice.status !== "OPEN" || invoice.balanceMinor <= 0) return null;
    try {
      return (await this.deps.adapters.billing.hostedPaymentPath(invoice.invoiceId)).portalPath;
    } catch {
      return null;
    }
  }

  async prepareReview(auth: AuthContext, decision: PolicyDecision, input: { invoiceId: string; reasonCategory: BillingReviewReason }): Promise<BillingReviewPrepareOutcome> {
    if (!auth.subjectId) return { kind: "NOT_ELIGIBLE", reasonCode: "SUBJECT_REQUIRED" };
    const invoice = await this.deps.adapters.billing.getInvoice(input.invoiceId);
    if (!invoice || invoice.subjectId !== auth.subjectId) return { kind: "NOT_ELIGIBLE", reasonCode: "INVOICE_NOT_AVAILABLE" };
    if (invoice.status !== "OPEN") return { kind: "NOT_ELIGIBLE", reasonCode: "INVOICE_NOT_REVIEWABLE" };
    const action = await this.deps.actions.prepare(
      auth,
      {
        kind: "billing.review.submit",
        target: { system: "billing", recordType: "invoice", recordRef: invoice.invoiceId, beforeVersion: invoice.version },
        change: { reasonCategory: input.reasonCategory, requestedStatus: "IN_REVIEW" },
        impact: { summaryTemplateId: "billing.review_confirmation", fees: null, reversible: false },
        confirmationTemplateId: "billing.review_confirmation",
        ttlSeconds: 300,
        requiresStepUp: false,
      },
      decision,
    );
    await this.interactions.recordPrepared({ tenantId: auth.tenantId, callId: auth.callId, actionId: action.actionId, kind: action.kind, contractId: BILLING_REVIEW.contractId });
    return { kind: "PREPARED", action, invoice };
  }

  async commitReview(auth: AuthContext, input: { actionId: string; digest: string }, reauthorize: ReauthorizeSpec): Promise<BillingReviewCommitOutcome> {
    const action = await this.deps.actions.get(auth.tenantId, input.actionId);
    if (!action || action.kind !== "billing.review.submit") return { kind: "DENIED", reasonCode: "ACTION_NOT_AVAILABLE" };
    let followUp: { supportRequest: SupportRequest; workflowId: string } | null = null;
    const result = await commitAction(this.deps.actions, auth, input, {
      provider: this.provider,
      reauthorize: (a) => decideNow(this.deps, auth, { ...reauthorize, resource: { ...reauthorize.resource, actionDigest: a.digest } }),
      onCommitted: async (tx, committed, receipt) => {
        followUp = await this.followUpInTx(tx, committed, receipt, { callId: auth.callId, consent: auth.consent, audience: auth.selectedRole });
      },
    });
    if (result.kind !== "COMMITTED") return result;
    await this.interactions.recordReceipt(auth.tenantId, result.receipt).catch(() => undefined);
    const fu: { supportRequest: SupportRequest; workflowId: string } | null = followUp ?? (await this.existingFollowUp(auth.tenantId, input.actionId));
    if (fu) await this.support.rememberOpenIssue(auth, fu.supportRequest);
    return { kind: "REQUEST_ACCEPTED", actionId: input.actionId, receiptId: result.receipt.receiptId, supportRequest: fu?.supportRequest ?? null, workflowId: fu?.workflowId ?? null };
  }

  private async existingFollowUp(tenantId: string, actionId: string): Promise<{ supportRequest: SupportRequest; workflowId: string } | null> {
    const sr = await this.support.findByActionId(tenantId, actionId);
    if (!sr) return null;
    const links = await this.support.linkedRefs(tenantId, sr.supportRequestId);
    return { supportRequest: sr, workflowId: links.workflowIds[0] ?? "" };
  }

  /**
   * Follow-up inside the COMMITTED transaction (or the consumer's dedup transaction):
   * billing_dispute_review workflow + linked support request. Idempotent per action.
   * Uses only the given transaction (no other database access while it is open).
   */
  async followUpInTx(
    tx: Queryable,
    action: PreparedAction,
    receipt: Pick<CommitReceipt, "receiptId">,
    ctx: { callId: string | null; consent: ConsentState | null; audience: AuthContext["selectedRole"] },
  ): Promise<{ supportRequest: SupportRequest; workflowId: string }> {
    if (action.kind !== "billing.review.submit") throw new ValidationError("FOLLOW_UP_KIND_INVALID");
    const existing = await this.support.findByActionId(action.tenantId, action.actionId, tx);
    if (existing) {
      const wf = await tx.query<{ link_ref: string }>("select link_ref from support_request_links where support_request_id = $1 and link_kind = 'workflow' limit 1", [existing.supportRequestId]);
      return { supportRequest: existing, workflowId: wf.rows[0]?.link_ref ?? "" };
    }
    const indexed = await this.interactions.get(action.tenantId, action.actionId, tx);
    const callId = ctx.callId ?? indexed?.callId ?? null;
    if (!callId) throw new ValidationError("FOLLOW_UP_CALL_UNKNOWN");
    const lang = await tx.query<{ language: string }>("select language from support_interactions where call_id = $1", [callId]);
    const reason = typeof action.change.reasonCategory === "string" ? action.change.reasonCategory : "OTHER";
    // Durable action grant in the accepting (COMMITTED / consumer dedup) transaction: the review
    // workflow's later commit, decision notice and outcome notice need it (spec section 7).
    const grantRef = await issueWorkflowGrant(this.deps, tx, {
      tenantId: action.tenantId,
      type: "billing_dispute_review",
      subjectId: action.subjectId,
      actorId: action.actorId,
      sourceRef: action.actionId,
    });
    const start: WorkflowStartWithSnapshot = {
      tenantId: action.tenantId,
      type: "billing_dispute_review",
      correlationId: action.actionId,
      sourceRecordRefs: grantRef ? [action.actionId, action.target.recordRef, grantRef] : [action.actionId, action.target.recordRef],
      grantRef,
      // Policy snapshot for reproducibility; the pre-disclosure recheck evaluates the CURRENT policy (spec section 9).
      policySnapshotVersion: this.deps.versions.policyBundle,
    };
    const workflow = await this.deps.workflows.start(start, tx);
    const supportRequest = await this.support.createRecord(
      {
        tenantId: action.tenantId,
        callId,
        audience: ctx.audience ?? "client",
        subjectRef: action.subjectId,
        organizationRef: null,
        actorRef: action.actorId,
        sessionRef: action.sessionRef,
        sessionGeneration: action.sessionGeneration,
        issueCategory: "billing_dispute",
        disposition: "REQUEST_ACCEPTED",
        summaryTemplateId: "summary.billing_review",
        summarySlots: { reasonCategory: reason },
        attempted: ["billing.review.submit"],
        commitReceiptIds: [receipt.receiptId],
        nextStep: "BILLING_SPECIALIST_REVIEW",
        restricted: false,
        priority: "P3_STANDARD",
        ownerQueue: "q_billing_intake",
        language: lang.rows[0]?.language ?? "en",
        consent: ctx.consent ?? UNKNOWN_CONSENT,
        creationKey: sha256Hex(`vsp.billing_review.follow_up.v1:${action.tenantId}:${action.actionId}`),
        links: [
          { kind: "action", ref: action.actionId },
          { kind: "workflow", ref: workflow.workflowId },
        ],
      },
      tx,
    );
    return { supportRequest, workflowId: workflow.workflowId };
  }
}
