/**
 * submit_complaint (complaint:create), create_support_request (support_request:create)
 * and get_authorized_case_status (case:read).
 *
 * Linking: a verified (A2+) caller's complaint is linked to the caller's own subject when
 * policy allows a subject-linked support request (support_request:create, evaluated in the
 * business layer); unverified complaints stay unlinked. A support request asked to be linked
 * is authorized against the AUTHORITATIVE target: the caller's own subject, or for a personal
 * representative the represented subject with scope support_request:create (purpose
 * representative_access), or for an organization role (practice staff, partner, payer
 * representative) the caller's server-established organization, authorized at creation by the
 * organization's case:read path so get_authorized_case_status finds it again; an unresolvable
 * target is denied by policy and a refused organization link denies the request.
 *
 * Intake takes categories and flags only (no free text, never echoed). The caller is
 * told the SR reference is a support reference pending synchronization, never a
 * Salesforce Case number. Case status resolves the reference to its AUTHORITATIVE scope
 * (subject or organization); unknown or restricted references resolve to a resource
 * policy denies (no existence disclosure). The recap uses SupportMemory only as a
 * pointer, at A2+ for the same subject, with the session's risk flags: the referenced
 * request is re-read from the system of record and recapped only while it is still open
 * (DATA-04, DP-03; CaseService.recap). Creation keys derive from the transport idempotency
 * key (ACT-F2; IntakeService).
 */
import { z } from "zod";
import { CASE_STATUSES, type CaseView } from "../../business/services/cases.js";
import { COMPLAINT_CATEGORIES, GENERAL_INTAKE_CATEGORIES, ORGANIZATION_ROLES, URGENCY, organizationPurpose } from "../../business/services/intake.js";
import type { BusinessServices } from "../../business/services/types.js";
import { atLeast, openResource, organizationResource, subjectResource, unresolvableResource } from "../../business/shared.js";
import { toolPolicyRef } from "../../policy/input.js";
import { speechFor } from "../../business/speech.js";
import type { ToolSpeech } from "../../business/speech.js";
import { IssueCategory } from "../../protocol/index.js";
import type { AuthContext, PolicyPurpose } from "../../protocol/index.js";
import type { ToolModule } from "../ports.js";
import { InstantArg, LanguageArg, SupportRefArg, denied, fromError, ok, sourceRef } from "./common.js";
import { TOOL_DEFINITIONS } from "./definitions.js";
import { argsDigest } from "./provider.js";

const Accepted = z.strictObject({ status: z.literal("REQUEST_ACCEPTED"), supportReference: SupportRefArg });

export const ComplaintInput = z.strictObject({ category: z.enum(COMPLAINT_CATEGORIES), wantsCallback: z.boolean(), language: LanguageArg });
export const ComplaintOutput = z.strictObject({ complaint: Accepted, synchronization: z.literal("PENDING_SYNC"), linkedToAccount: z.boolean() });

export function submitComplaintTool(s: BusinessServices): ToolModule<z.infer<typeof ComplaintInput>, z.infer<typeof ComplaintOutput>> {
  const definition = TOOL_DEFINITIONS.submit_complaint;
  return {
    definition,
    maskTarget: { collectionKey: "complaint", envelopeKeys: ["synchronization", "linkedToAccount"] },
    input: ComplaintInput,
    output: ComplaintOutput,
    purpose: () => "caller_self_service",
    resolveResource: async (auth) => openResource(auth, "complaint", "INTERNAL"),
    async execute(ctx, input) {
      try {
        const subjectRef = await s.intake.complaintSubject(ctx.auth, toolPolicyRef(definition));
        const r = await s.intake.complaint({ auth: ctx.auth, turnId: ctx.request.turnId, idempotencyKey: ctx.request.idempotencyKey, tool: definition.name, argsDigest: argsDigest(input), language: input.language }, input, subjectRef);
        const ref = r.supportRequest.referenceNumber;
        return ok(
          { complaint: { status: "REQUEST_ACCEPTED", supportReference: ref }, synchronization: "PENDING_SYNC", linkedToAccount: r.supportRequest.subjectRef !== null },
          speechFor(s.deps.templates, "commitment.request_accepted_pending_sync", { supportReference: ref }, [sourceRef("sr", r.supportRequest.supportRequestId)]),
        );
      } catch (err) {
        return fromError(err, "INTAKE_FAILED");
      }
    },
  };
}

export const SupportRequestInput = z.strictObject({
  issueCategory: z.enum(GENERAL_INTAKE_CATEGORIES),
  linkToAccount: z.boolean(),
  urgency: z.enum(URGENCY),
  language: LanguageArg,
});
export const SupportRequestOutput = z.strictObject({ request: Accepted, synchronization: z.literal("PENDING_SYNC"), linkedToAccount: z.boolean() });

/** A representative's link is a representative_access request; everything else is the caller's own service. */
const supportRequestPurpose = (auth: AuthContext, input: { linkToAccount: boolean }): PolicyPurpose =>
  auth.selectedRole === "personal_representative" && input.linkToAccount && atLeast(auth.assurance, "A2") ? "representative_access" : "caller_self_service";

export function createSupportRequestTool(s: BusinessServices): ToolModule<z.infer<typeof SupportRequestInput>, z.infer<typeof SupportRequestOutput>> {
  const definition = TOOL_DEFINITIONS.create_support_request;
  return {
    definition,
    maskTarget: { collectionKey: "request", envelopeKeys: ["synchronization", "linkedToAccount"] },
    input: SupportRequestInput,
    output: SupportRequestOutput,
    purpose: (auth, input) => supportRequestPurpose(auth, input),
    async resolveResource(auth, input) {
      const target = await s.intake.linkTarget(auth, input.linkToAccount);
      if (target.kind === "subject") return subjectResource(auth, "support_request", target.subjectId, "PHI");
      // Creating the request is the open intake path; the organization link itself is authorized by the
      // organization's case:read path in the business layer (IntakeService.general), or the call is denied.
      return target.kind === "unresolved" ? unresolvableResource(auth, "support_request", "PHI") : openResource(auth, "support_request", "INTERNAL");
    },
    async execute(ctx, input) {
      try {
        const r = await s.intake.general({ auth: ctx.auth, turnId: ctx.request.turnId, idempotencyKey: ctx.request.idempotencyKey, tool: definition.name, argsDigest: argsDigest(input), language: input.language }, input, toolPolicyRef(definition));
        const sr = r.supportRequest;
        return ok(
          { request: { status: "REQUEST_ACCEPTED", supportReference: sr.referenceNumber }, synchronization: "PENDING_SYNC", linkedToAccount: r.linkedTo !== null },
          speechFor(s.deps.templates, "support_reference.pending_sync", { supportReference: sr.referenceNumber }, [sourceRef("sr", sr.supportRequestId)]),
        );
      } catch (err) {
        return fromError(err, "INTAKE_FAILED");
      }
    },
  };
}

const CaseRecord = z.strictObject({
  caseRef: SupportRefArg,
  category: IssueCategory,
  status: z.enum(CASE_STATUSES),
  nextStep: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/).nullable(),
  deadline: InstantArg.nullable(),
});
export const CaseInput = z.strictObject({ supportReference: SupportRefArg.nullable() });
export const CaseOutput = z.strictObject({ cases: z.array(CaseRecord).max(5), recapAvailable: z.boolean() });

const casePurpose = (auth: AuthContext): PolicyPurpose => (auth.selectedRole !== null && ORGANIZATION_ROLES.has(auth.selectedRole) ? organizationPurpose(auth.selectedRole) : "caller_self_service");

const ORG_ROLES = ORGANIZATION_ROLES;

export function getAuthorizedCaseStatusTool(s: BusinessServices): ToolModule<z.infer<typeof CaseInput>, z.infer<typeof CaseOutput>> {
  async function scope(auth: AuthContext, input: z.infer<typeof CaseInput>): Promise<{ kind: "subject"; id: string } | { kind: "organization"; id: string } | null> {
    if (input.supportReference !== null) {
      const sc = await s.cases.scopeOf(auth.tenantId, input.supportReference);
      if (!sc) return null;
      if (sc.sr.subjectRef) return { kind: "subject", id: sc.sr.subjectRef };
      if (sc.organizationRef) return { kind: "organization", id: sc.organizationRef };
      return null;
    }
    if (auth.selectedRole && ORG_ROLES.has(auth.selectedRole) && auth.organizationId) return { kind: "organization", id: auth.organizationId };
    return auth.subjectId ? { kind: "subject", id: auth.subjectId } : null;
  }
  return {
    definition: TOOL_DEFINITIONS.get_authorized_case_status,
    maskTarget: { collectionKey: "cases", envelopeKeys: ["recapAvailable"] },
    input: CaseInput,
    output: CaseOutput,
    purpose: (auth) => casePurpose(auth),
    async resolveResource(auth, input) {
      const sc = await scope(auth, input);
      if (!sc) return unresolvableResource(auth, "support_case", "INTERNAL");
      return sc.kind === "subject" ? subjectResource(auth, "support_case", sc.id, "PHI") : organizationResource(auth, "support_case", sc.id, "INTERNAL");
    },
    async execute(ctx, input) {
      try {
        const sc = await scope(ctx.auth, input);
        if (!sc) return denied("RESOURCE_NOT_AUTHORIZED");
        let cases: CaseView[];
        if (input.supportReference !== null) {
          const found = await s.cases.scopeOf(ctx.auth.tenantId, input.supportReference);
          cases = found ? [await s.cases.view(found.sr)] : [];
        } else {
          cases = sc.kind === "subject" ? await s.cases.forSubject(ctx.auth.tenantId, sc.id) : await s.cases.forOrganization(ctx.auth.tenantId, sc.id);
        }
        // Repeat-caller recap: a memory pointer reconciled with the system of record (open requests only),
        // never for another subject or below A2 (DATA-04, DP-03).
        const recap = sc.kind === "subject" && sc.id === ctx.auth.subjectId ? await s.cases.recap(ctx.auth) : null;
        let speech: ToolSpeech;
        if (input.supportReference === null && recap) {
          speech = speechFor(s.deps.templates, "case.recap_open_issue", { supportReference: recap.supportReference, issueCategory: recap.issueCategory }, [`sr:${recap.supportReference}`]);
        } else if (cases[0]) {
          speech = speechFor(s.deps.templates, "case.status", { supportReference: cases[0].caseRef, caseStatus: cases[0].status }, [`sr:${cases[0].caseRef}`]);
        } else {
          speech = speechFor(s.deps.templates, "case.none_found");
        }
        return ok({ cases: cases.slice(0, 5), recapAvailable: recap !== null }, speech);
      } catch (err) {
        return fromError(err, "CASE_LOOKUP_FAILED");
      }
    },
  };
}
