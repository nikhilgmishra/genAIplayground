/**
 * Honest intake (spec section 4: unsupported work ends in intake or handoff, never an
 * invented procedure; ACT-04: acceptance is not resolution).
 *
 * - general support request: A0 unlinked; linked to the A2+ caller's own subject; or, for
 *   a personal representative at A2+, linked to the single represented subject the
 *   authoritative legal-authority registry names with scope support_request:create (policy
 *   support_request:create, representative path, still authorizes it; an ambiguous or
 *   missing authority resolves to a resource policy denies);
 * - complaint: the intake itself is open (complaint:create). A verified A2+ caller's
 *   complaint is linked to the caller's own subject only when policy support_request:create
 *   (self path, subject-linked record) allows it at creation time; unverified callers'
 *   complaints, and any link the policy refuses, stay unlinked (the complaint is still
 *   accepted). Routed into complaint_review in the same transaction; privacy complaints
 *   are restricted;
 * - partner intake: organization-scoped (the partner's server-established organization),
 *   never an individual's record; onboarding requests start partner_onboarding in the
 *   same transaction.
 * Creation is idempotent per (call, turn, tool, arguments).
 */
import type { AuthContext, IssueCategory, SupportRequest, ToolDefinition, WorkflowType } from "../../protocol/index.js";
import { AccessDeniedError } from "../../shared/errors.js";
import type { ToolDeps } from "../contract.js";
import { decideNow } from "../policy.js";
import { atLeast, auditSessionRef, reasonOf, subjectResource } from "../shared.js";
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

/** Subject a support request may be linked to; policy still authorizes the link. */
export type LinkTarget = { kind: "none" } | { kind: "subject"; subjectId: string } | { kind: "unresolved" };

const REPRESENTATIVE_FACTS: ReadonlySet<string> = new Set(["legal_representative", "parental_authority"]);
/** Scope a representative's authority must carry to link a support request to the represented subject. */
export const SUPPORT_REQUEST_LINK_SCOPE = "support_request:create";

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

  /**
   * The subject a requested link points at, from server-established state only: the A2+
   * caller's own subject, or for a personal representative at A2+ the single subject the
   * authoritative registry names with scope support_request:create. No request to link, or
   * below A2 => none (unlinked, as before). A representative without exactly one such
   * subject => unresolved (policy denies; the model can retry without linking).
   */
  async linkTarget(auth: AuthContext, linkToAccount: boolean): Promise<LinkTarget> {
    if (!linkToAccount || !atLeast(auth.assurance, "A2")) return { kind: "none" };
    if (auth.selectedRole === "personal_representative") {
      if (!auth.actorId) return { kind: "unresolved" };
      const facts = await this.deps.adapters.relationships.relationshipsFor(auth.actorId, "personal_representative");
      const subjects = [...new Set(facts.filter((f) => REPRESENTATIVE_FACTS.has(f.type) && f.subjectId !== null && f.scopes.includes(SUPPORT_REQUEST_LINK_SCOPE)).map((f) => f.subjectId as string))];
      return subjects.length === 1 ? { kind: "subject", subjectId: subjects[0] as string } : { kind: "unresolved" };
    }
    return auth.subjectId !== null ? { kind: "subject", subjectId: auth.subjectId } : { kind: "none" };
  }

  /**
   * A verified caller's complaint is linked to the caller's own subject only when policy
   * allows a subject-linked support request for it now (support_request:create, self path).
   * Any refusal or error leaves the complaint unlinked; it is never blocked by linking.
   */
  async complaintSubject(auth: AuthContext, tool: Pick<ToolDefinition, "name" | "version" | "minAssurance" | "consequential">): Promise<string | null> {
    if (auth.subjectId === null || !atLeast(auth.assurance, "A2") || auth.selectedRole === "personal_representative") return null;
    try {
      const d = await decideNow(this.deps, auth, {
        action: SUPPORT_REQUEST_LINK_SCOPE,
        purpose: "caller_self_service",
        tool,
        resource: subjectResource(auth, "support_request", auth.subjectId, "PHI"),
      });
      return d.allow ? auth.subjectId : null;
    } catch (err) {
      this.deps.logger.warn("intake.complaint_link_not_authorized", { reasonCode: reasonOf(err, "COMPLAINT_LINK_UNAVAILABLE") });
      return null;
    }
  }

  async general(c: IntakeContext, input: { issueCategory: (typeof GENERAL_INTAKE_CATEGORIES)[number]; linkToAccount: boolean; urgency: (typeof URGENCY)[number] }): Promise<SupportRequest> {
    const target = await this.linkTarget(c.auth, input.linkToAccount);
    // Policy already denied an unresolved link; this is defence in depth (never link to a guessed subject).
    if (target.kind === "unresolved") throw new AccessDeniedError("RESOURCE_NOT_AUTHORIZED");
    const subjectRef = target.kind === "subject" ? target.subjectId : null;
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

  async complaint(
    c: IntakeContext,
    input: { category: (typeof COMPLAINT_CATEGORIES)[number]; wantsCallback: boolean },
    subjectRef: string | null = null,
  ): Promise<{ supportRequest: SupportRequest; workflowId: string }> {
    const privacy = input.category === "PRIVACY_CONCERN";
    // Only the caller's own verified subject can ever be linked here (see complaintSubject).
    const linked = subjectRef !== null && subjectRef === c.auth.subjectId && atLeast(c.auth.assurance, "A2") ? subjectRef : null;
    const created = await this.withWorkflow(c.auth.tenantId, "complaint_review", (links) => ({
      ...this.base(c),
      subjectRef: linked,
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
    // Recap for the caller's own non-restricted, linked complaint (restricted records are never remembered).
    if (linked) await this.support.rememberOpenIssue(c.auth, created.supportRequest);
    return created;
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
