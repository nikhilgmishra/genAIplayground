/**
 * Honest intake (spec section 4: unsupported work ends in intake or handoff, never an
 * invented procedure; ACT-04: acceptance is not resolution).
 *
 * - general support request: A0 unlinked, or linked to the A2+ caller's own subject;
 * - complaint: never linked to an account (complaint:create is an open intake), routed
 *   into complaint_review in the same transaction; privacy complaints are restricted;
 * - partner intake: organization-scoped (the partner's server-established organization),
 *   never an individual's record; onboarding requests start partner_onboarding in the
 *   same transaction.
 * Creation is idempotent per (call, turn, tool, arguments).
 */
import type { AuthContext, IssueCategory, SupportRequest, WorkflowType } from "../../protocol/index.js";
import type { ToolDeps } from "../contract.js";
import { atLeast, auditSessionRef } from "../shared.js";
import { PgSupportRequestService } from "../support/support-request-service.js";
import type { SupportRequestRecordInput } from "../support/support-request-service.js";

export const GENERAL_INTAKE_CATEGORIES = [
  "general_question",
  "portal_login_help",
  "appointment",
  "billing_question",
  "claim_status",
  "provider_onboarding",
  "credentialing_documents",
  "remittance",
  "case_follow_up",
  "accessibility_request",
  "language_support",
  "other",
] as const satisfies readonly IssueCategory[];

export const COMPLAINT_CATEGORIES = ["SERVICE_EXPERIENCE", "BILLING", "ACCESSIBILITY", "PRIVACY_CONCERN", "STAFF_CONDUCT", "OTHER"] as const;
export const PARTNER_REQUEST_TYPES = ["NEW_PARTNER_ONBOARDING", "CONTRACT_ADMINISTRATION", "BILLING_ADMINISTRATION", "ELIGIBILITY_FILE_QUESTION", "OTHER"] as const;
export const URGENCY = ["STANDARD", "URGENT"] as const;

const OWNER_QUEUE_BY_CATEGORY: Partial<Record<IssueCategory, string>> = {
  appointment: "q_scheduling_support",
  billing_question: "q_billing_specialists",
  claim_status: "q_claims_specialists",
  provider_onboarding: "q_provider_relations",
  credentialing_documents: "q_provider_relations",
  remittance: "q_provider_relations",
  portal_login_help: "q_identity_recovery",
};

export interface IntakeContext {
  auth: AuthContext;
  turnId: string;
  tool: string;
  argsDigest: string;
  language: string;
}

export class IntakeService {
  constructor(
    private readonly deps: ToolDeps,
    private readonly support: PgSupportRequestService,
  ) {}

  private base(c: IntakeContext): Pick<SupportRequestRecordInput, "tenantId" | "callId" | "audience" | "actorRef" | "sessionRef" | "sessionGeneration" | "consent" | "language" | "creationKey"> {
    return {
      tenantId: c.auth.tenantId,
      callId: c.auth.callId,
      audience: c.auth.selectedRole,
      actorRef: c.auth.actorId,
      sessionRef: auditSessionRef(c.auth),
      sessionGeneration: c.auth.sessionGeneration,
      consent: c.auth.consent,
      language: c.language,
      creationKey: this.creationKey(c),
    };
  }

  private creationKey(c: IntakeContext): string {
    return PgSupportRequestService.creationKeyFor({ tenantId: c.auth.tenantId, callId: c.auth.callId, turnId: c.turnId, tool: c.tool, args: c.argsDigest });
  }

  /** Links the caller's own subject only when the session is A2+ and the caller asked for it. */
  linkedSubject(auth: AuthContext, linkToAccount: boolean): string | null {
    return linkToAccount && auth.subjectId !== null && atLeast(auth.assurance, "A2") ? auth.subjectId : null;
  }

  async general(c: IntakeContext, input: { issueCategory: (typeof GENERAL_INTAKE_CATEGORIES)[number]; linkToAccount: boolean; urgency: (typeof URGENCY)[number] }): Promise<SupportRequest> {
    const subjectRef = this.linkedSubject(c.auth, input.linkToAccount);
    const sr = await this.support.createRecord({
      ...this.base(c),
      subjectRef,
      organizationRef: null,
      issueCategory: input.issueCategory,
      disposition: "REQUEST_ACCEPTED",
      summaryTemplateId: "summary.general_intake",
      summarySlots: { issueCategory: input.issueCategory, linked: subjectRef ? "yes" : "no" },
      attempted: ["support_request.create"],
      commitReceiptIds: [],
      nextStep: "TEAM_FOLLOW_UP",
      restricted: false,
      priority: input.urgency === "URGENT" ? "P2_URGENT" : "P3_STANDARD",
      ownerQueue: OWNER_QUEUE_BY_CATEGORY[input.issueCategory] ?? "q_support_general",
    });
    if (subjectRef) await this.support.rememberOpenIssue(c.auth, sr);
    return sr;
  }

  async complaint(c: IntakeContext, input: { category: (typeof COMPLAINT_CATEGORIES)[number]; wantsCallback: boolean }): Promise<{ supportRequest: SupportRequest; workflowId: string }> {
    const privacy = input.category === "PRIVACY_CONCERN";
    return this.withWorkflow(c.auth.tenantId, "complaint_review", (links) => ({
      ...this.base(c),
      subjectRef: null,
      organizationRef: null,
      issueCategory: privacy ? "privacy_concern" : "complaint",
      disposition: "REQUEST_ACCEPTED",
      summaryTemplateId: "summary.complaint",
      summarySlots: { category: input.category, callback: input.wantsCallback ? "yes" : "no" },
      attempted: ["complaint.create"],
      commitReceiptIds: [],
      nextStep: "COMPLAINT_REVIEW",
      restricted: privacy,
      priority: "P3_STANDARD",
      ownerQueue: privacy ? "q_privacy_office" : "q_complaints",
      links,
    }));
  }

  async partner(c: IntakeContext, input: { requestType: (typeof PARTNER_REQUEST_TYPES)[number]; urgency: (typeof URGENCY)[number] }): Promise<{ supportRequest: SupportRequest; workflowId: string | null }> {
    const organizationRef = c.auth.organizationId;
    const record = (links: SupportRequestRecordInput["links"]): SupportRequestRecordInput => ({
      ...this.base(c),
      subjectRef: null,
      organizationRef,
      issueCategory: "partner_intake",
      disposition: "REQUEST_ACCEPTED",
      summaryTemplateId: "summary.partner_intake",
      summarySlots: { requestType: input.requestType, urgency: input.urgency },
      attempted: ["partner_intake.create"],
      commitReceiptIds: [],
      nextStep: "PARTNER_TEAM_REVIEW",
      restricted: false,
      priority: input.urgency === "URGENT" ? "P2_URGENT" : "P3_STANDARD",
      ownerQueue: "q_partner_support",
      links,
    });
    if (input.requestType === "NEW_PARTNER_ONBOARDING") return this.withWorkflow(c.auth.tenantId, "partner_onboarding", record);
    return { supportRequest: await this.support.createRecord(record([])), workflowId: null };
  }

  /** Support request and workflow in ONE transaction, linked both ways (the workflow's source refs hold the SR id). */
  private async withWorkflow(
    tenantId: string,
    type: WorkflowType,
    build: (links: NonNullable<SupportRequestRecordInput["links"]>) => SupportRequestRecordInput,
  ): Promise<{ supportRequest: SupportRequest; workflowId: string }> {
    return this.deps.db.tx(
      async (tx) => {
        const supportRequest = await this.support.createRecord(build([]), tx);
        const existing = await tx.query<{ link_ref: string }>(
          "select link_ref from support_request_links where support_request_id = $1 and link_kind = 'workflow' limit 1",
          [supportRequest.supportRequestId],
        );
        // Idempotent replay of the same intake: the workflow was started with the original request.
        if (existing.rows[0]) return { supportRequest, workflowId: existing.rows[0].link_ref };
        const workflow = await this.deps.workflows.start(
          { tenantId, type, correlationId: supportRequest.supportRequestId, sourceRecordRefs: [supportRequest.supportRequestId], grantRef: null },
          tx,
        );
        await this.support.linkInTx(tx, supportRequest, "workflow", workflow.workflowId);
        return { supportRequest, workflowId: workflow.workflowId };
      },
      { role: "app_runtime", rls: { tenantId } },
    );
  }
}
