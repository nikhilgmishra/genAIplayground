/**
 * Honest intake (spec section 4: unsupported work ends in intake or handoff, never an
 * invented procedure; ACT-04: acceptance is not resolution).
 *
 * - general support request: A0 unlinked; linked to the A2+ caller's own subject; or, for
 *   a personal representative at A2+, linked to the single represented subject the
 *   authoritative legal-authority registry names with scope support_request:create (policy
 *   support_request:create, representative path, still authorizes it; an ambiguous or
 *   missing authority resolves to a resource policy denies); or, for an organization role
 *   (practice staff, partner, payer representative) at A2+, linked to the caller's
 *   server-established ORGANIZATION, authorized at creation by the organization's case:read
 *   path (the path get_authorized_case_status reads it back through), so the request is
 *   organization-scoped exactly as policy intends; a refused link is a denial, never a
 *   silently person-only request;
 * - complaint: the intake itself is open (complaint:create). A verified A2+ caller's
 *   complaint is linked to the caller's own subject only when policy support_request:create
 *   (self path, subject-linked record) allows it at creation time; unverified callers'
 *   complaints, and any link the policy refuses, stay unlinked (the complaint is still
 *   accepted). Routed into complaint_review in the same transaction; privacy complaints
 *   are restricted;
 * - partner intake: organization-scoped (the partner's server-established organization),
 *   never an individual's record; onboarding requests start partner_onboarding in the
 *   same transaction.
 * Creation is idempotent per (call, request identity, tool, arguments). The request identity is the
 * transport idempotency key (the tools require one): a retry of the same request after an ambiguous
 * timeout, even once its gateway reservation was re-taken, finds the record the first execution created
 * instead of creating a second support request, workflow, grant and Salesforce Case (ACT-02, ACT-F2).
 * Only a direct business call without a key falls back to the turn id.
 */
import type { AuthContext, IssueCategory, SupportRequest, ToolDefinition, WorkflowType } from "../../protocol/index.js";
import { AccessDeniedError } from "../../shared/errors.js";
import type { ToolDeps } from "../contract.js";
import { issueWorkflowGrant, type WorkflowStartWithSnapshot } from "../grants.js";
import { decideNow } from "../policy.js";
import { atLeast, auditSessionRef, organizationResource, reasonOf, subjectResource } from "../shared.js";
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
  /** Transport idempotency key of the request (ToolRequest.idempotencyKey); null outside the gateway. */
  idempotencyKey?: string | null;
  tool: string;
  argsDigest: string;
  language: string;
}

/** Subject or organization a support request may be linked to; policy still authorizes the link. */
export type LinkTarget = { kind: "none" } | { kind: "subject"; subjectId: string } | { kind: "organization"; organizationId: string } | { kind: "unresolved" };

/** Roles that act for an organization: their requests are organization-scoped (case:read organization paths). */
export const ORGANIZATION_ROLES: ReadonlySet<string> = new Set(["practice_staff", "partner", "payer_representative"]);

/** Policy purpose of an organization role's organization-scoped work (matches get_authorized_case_status). */
export const organizationPurpose = (role: AuthContext["selectedRole"]): "delegated_practice_administration" | "partner_administration" =>
  role === "practice_staff" ? "delegated_practice_administration" : "partner_administration";

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
    // ACT-F2: the request identity is the transport idempotency key, never a per-invocation minted turn id.
    const requestIdentity = c.idempotencyKey ? `idem:${c.idempotencyKey}` : c.turnId;
    return PgSupportRequestService.creationKeyFor({ tenantId: c.auth.tenantId, callId: c.auth.callId, turnId: requestIdentity, tool: c.tool, args: c.argsDigest });
  }

  /**
   * The subject a requested link points at, from server-established state only: the A2+
   * caller's own subject, or for a personal representative at A2+ the single subject the
   * authoritative registry names with scope support_request:create; for an organization role the
   * caller's server-established organization. No request to link, or below A2 => none (unlinked,
   * as before). A representative without exactly one such subject, or an organization role
   * without an organization => unresolved (policy denies; the model can retry without linking).
   */
  async linkTarget(auth: AuthContext, linkToAccount: boolean): Promise<LinkTarget> {
    if (!linkToAccount || !atLeast(auth.assurance, "A2")) return { kind: "none" };
    if (auth.selectedRole !== null && ORGANIZATION_ROLES.has(auth.selectedRole)) {
      return auth.organizationId !== null ? { kind: "organization", organizationId: auth.organizationId } : { kind: "unresolved" };
    }
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

  /**
   * An organization role's link to its organization is authorized NOW by the organization's
   * case:read path (relationship fact from the authoritative delegation / partner-contract
   * registry, with scope, A2): the caller must be able to follow the request up through
   * get_authorized_case_status. Any refusal or evaluation error denies the request.
   */
  private async authorizeOrganizationLink(auth: AuthContext, organizationId: string, tool: Pick<ToolDefinition, "name" | "version" | "minAssurance" | "consequential">): Promise<void> {
    let allowed = false;
    let reason = "RESOURCE_NOT_AUTHORIZED";
    try {
      const d = await decideNow(this.deps, auth, { action: "case:read", purpose: organizationPurpose(auth.selectedRole), tool, resource: organizationResource(auth, "support_case", organizationId, "INTERNAL") });
      allowed = d.allow;
      if (!d.allow) reason = d.reasonCodes[0] ?? reason;
    } catch (err) {
      reason = reasonOf(err, "ORGANIZATION_LINK_UNAVAILABLE");
    }
    if (!allowed) {
      this.deps.logger.warn("intake.organization_link_not_authorized", { reasonCode: reason });
      throw new AccessDeniedError(/^[A-Z][A-Z0-9_]{2,63}$/.test(reason) ? reason : "RESOURCE_NOT_AUTHORIZED");
    }
  }

  async general(
    c: IntakeContext,
    input: { issueCategory: (typeof GENERAL_INTAKE_CATEGORIES)[number]; linkToAccount: boolean; urgency: (typeof URGENCY)[number] },
    tool: Pick<ToolDefinition, "name" | "version" | "minAssurance" | "consequential">,
  ): Promise<{ supportRequest: SupportRequest; linkedTo: "subject" | "organization" | null }> {
    const target = await this.linkTarget(c.auth, input.linkToAccount);
    // Policy already denied an unresolved link; this is defence in depth (never link to a guessed subject).
    if (target.kind === "unresolved") throw new AccessDeniedError("RESOURCE_NOT_AUTHORIZED");
    if (target.kind === "organization") await this.authorizeOrganizationLink(c.auth, target.organizationId, tool);
    const subjectRef = target.kind === "subject" ? target.subjectId : null;
    const organizationRef = target.kind === "organization" ? target.organizationId : null;
    const sr = await this.support.createRecord({
      ...this.base(c),
      subjectRef,
      organizationRef,
      issueCategory: input.issueCategory,
      disposition: "REQUEST_ACCEPTED",
      summaryTemplateId: "summary.general_intake",
      summarySlots: { issueCategory: input.issueCategory, linked: subjectRef || organizationRef ? "yes" : "no" },
      attempted: ["support_request.create"],
      commitReceiptIds: [],
      nextStep: "TEAM_FOLLOW_UP",
      restricted: false,
      priority: input.urgency === "URGENT" ? "P2_URGENT" : "P3_STANDARD",
      ownerQueue: OWNER_QUEUE_BY_CATEGORY[input.issueCategory] ?? "q_support_general",
    });
    if (subjectRef) await this.support.rememberOpenIssue(c.auth, sr);
    return { supportRequest: sr, linkedTo: subjectRef ? "subject" : organizationRef ? "organization" : null };
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

  /**
   * Support request, durable action grant and workflow in ONE transaction, linked both ways
   * (the workflow's source refs hold the SR id and the grant id). The grant's subject is the
   * linked account subject, else the partner's organization, else the support request itself
   * (see business/grants.ts); its actions are exactly the workflow's declared grant actions.
   */
  private async withWorkflow(
    tenantId: string,
    type: WorkflowType,
    build: (links: NonNullable<SupportRequestRecordInput["links"]>) => SupportRequestRecordInput,
  ): Promise<{ supportRequest: SupportRequest; workflowId: string }> {
    return this.deps.db.tx(
      async (tx) => {
        const record = build([]);
        const supportRequest = await this.support.createRecord(record, tx);
        const existing = await tx.query<{ link_ref: string }>(
          "select link_ref from support_request_links where support_request_id = $1 and link_kind = 'workflow' limit 1",
          [supportRequest.supportRequestId],
        );
        // Idempotent replay of the same intake: the workflow (and its grant) was started with the original request.
        if (existing.rows[0]) return { supportRequest, workflowId: existing.rows[0].link_ref };
        const grantRef = await issueWorkflowGrant(this.deps, tx, {
          tenantId,
          type,
          subjectId: record.subjectRef ?? record.organizationRef ?? supportRequest.supportRequestId,
          actorId: record.actorRef ?? null,
          sourceRef: supportRequest.supportRequestId,
        });
        const start: WorkflowStartWithSnapshot = {
          tenantId,
          type,
          correlationId: supportRequest.supportRequestId,
          sourceRecordRefs: grantRef ? [supportRequest.supportRequestId, grantRef] : [supportRequest.supportRequestId],
          grantRef,
          // Policy snapshot for reproducibility; the pre-disclosure recheck evaluates the CURRENT policy (spec section 9).
          policySnapshotVersion: this.deps.versions.policyBundle,
        };
        const workflow = await this.deps.workflows.start(start, tx);
        await this.support.linkInTx(tx, supportRequest, "workflow", workflow.workflowId);
        return { supportRequest, workflowId: workflow.workflowId };
      },
      { role: "app_runtime", rls: { tenantId } },
    );
  }
}
