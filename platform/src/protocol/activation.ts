/**
 * ActivationRecord and ActivationReport (follow-on prompt sections 0, 14 and 21; FO-04-41).
 *
 * Tenant activation is a separate truthful state from software completion. One ActivationRecord per
 * capability or workflow carries both status axes, the qualification result with evidence, the
 * missing external inputs (AIN ids from the activation register) and the required versus present
 * approvals. A capability is ACTIVE only with qualification PASS, environment at least
 * APPROVED_PILOT, no missing input and every required approval present (OPS-03, OPS-04). Unknown
 * inputs block only the affected capability. In every state the axes obey statusAxesIssues
 * (common.ts): a SUSPENDED or NOT_ELIGIBLE record never keeps a verified environment level its
 * current qualification does not support.
 *
 * Created by WP-02 in phase B; owned by WP-31 from phase F.
 */
import { z } from "zod";
import {
  ActivationInputId,
  CapabilityId,
  ENVIRONMENT_STATUS_RANK,
  Environment,
  EnvironmentStatus,
  EvidencePointer,
  QualificationResult,
  Sha256Hex,
  SoftwareStatus,
  envelope,
  opaqueIdWithPrefix,
  statusAxesIssues,
} from "./common.js";
import { ApprovalScope } from "./release.js";

export const ACTIVATION_RECORD_SCHEMA_VERSION = "activation-record.v1";
export const ACTIVATION_REPORT_SCHEMA_VERSION = "activation-report.v1";

export const ActivationState = z.enum(["NOT_ELIGIBLE", "ELIGIBLE", "ACTIVE", "SUSPENDED", "DEACTIVATED"]);
export type ActivationState = z.infer<typeof ActivationState>;

const ApprovalId = z.string().regex(/^apr_[A-Za-z0-9_-]{8,64}$/);

export const ActivationRecord = z
  .strictObject({
    ...envelope(ACTIVATION_RECORD_SCHEMA_VERSION, ["tenantId", "occurredAt"], ["causationId", "expiresAt"]),
    recordId: opaqueIdWithPrefix("acr"),
    capabilityId: CapabilityId,
    /** Workflow family the record covers, e.g. `billing_dispute_review`; null for a platform capability. */
    workflowRef: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/).nullable(),
    software: SoftwareStatus,
    environment: EnvironmentStatus,
    qualification: QualificationResult,
    evidenceRefs: z.array(EvidencePointer).max(32),
    missingInputs: z.array(ActivationInputId).max(32),
    approvalsRequired: z.array(ApprovalScope).max(16),
    approvalsPresent: z.array(z.strictObject({ scope: ApprovalScope, approvalId: ApprovalId })).max(16),
    state: ActivationState,
    reasonCodes: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/)).max(16),
  })
  .superRefine((r, ctx) => {
    const present = new Set(r.approvalsPresent.map((a) => a.scope));
    const missingApproval = r.approvalsRequired.filter((s) => !present.has(s));
    for (const i of statusAxesIssues(r)) ctx.addIssue({ code: "custom", message: i.code, path: [i.path] });
    if (r.state === "ACTIVE" || r.state === "ELIGIBLE") {
      if (r.qualification !== "PASS") ctx.addIssue({ code: "custom", message: "ELIGIBLE_WITHOUT_QUALIFICATION_PASS", path: ["qualification"] });
      if (r.missingInputs.length > 0) ctx.addIssue({ code: "custom", message: "ELIGIBLE_WITH_MISSING_INPUTS", path: ["missingInputs"] });
      if (missingApproval.length > 0) ctx.addIssue({ code: "custom", message: "ELIGIBLE_WITH_MISSING_APPROVALS", path: ["approvalsPresent"] });
      if (r.software === "MISSING") ctx.addIssue({ code: "custom", message: "ELIGIBLE_WITHOUT_SOFTWARE", path: ["software"] });
    }
    if (r.state === "ACTIVE" && ENVIRONMENT_STATUS_RANK[r.environment] < ENVIRONMENT_STATUS_RANK.APPROVED_PILOT) {
      ctx.addIssue({ code: "custom", message: "ACTIVE_BELOW_APPROVED_PILOT", path: ["environment"] });
    }
    if (r.state === "NOT_ELIGIBLE" && r.reasonCodes.length === 0 && r.missingInputs.length === 0 && missingApproval.length === 0) {
      ctx.addIssue({ code: "custom", message: "NOT_ELIGIBLE_WITHOUT_REASON", path: ["reasonCodes"] });
    }
  });
export type ActivationRecord = z.infer<typeof ActivationRecord>;

/** Computes the state a record may claim from its evidence (never more than the evidence allows). */
export function permittedActivationState(r: Omit<ActivationRecord, "state">): ActivationState {
  const present = new Set(r.approvalsPresent.map((a) => a.scope));
  const ready =
    r.software !== "MISSING" &&
    r.qualification === "PASS" &&
    r.evidenceRefs.length > 0 &&
    r.missingInputs.length === 0 &&
    r.approvalsRequired.every((s) => present.has(s));
  if (!ready) return "NOT_ELIGIBLE";
  return ENVIRONMENT_STATUS_RANK[r.environment] >= ENVIRONMENT_STATUS_RANK.APPROVED_PILOT ? "ACTIVE" : "ELIGIBLE";
}

export const ActivationReport = z
  .strictObject({
    ...envelope(ACTIVATION_REPORT_SCHEMA_VERSION, ["tenantId", "occurredAt"], ["causationId"]),
    reportId: opaqueIdWithPrefix("acp"),
    targetEnvironment: Environment,
    tenantConfigDigest: Sha256Hex,
    generatedBy: z.string().regex(/^[a-z][a-z0-9_.-]{2,63}$/),
    records: z.array(ActivationRecord).min(1).max(512),
    summary: z.strictObject({
      active: z.number().int().min(0).max(512),
      eligible: z.number().int().min(0).max(512),
      notEligible: z.number().int().min(0).max(512),
      suspended: z.number().int().min(0).max(512),
      deactivated: z.number().int().min(0).max(512),
    }),
  })
  .superRefine((r, ctx) => {
    const count = (s: ActivationState) => r.records.filter((x) => x.state === s).length;
    const expected = { active: count("ACTIVE"), eligible: count("ELIGIBLE"), notEligible: count("NOT_ELIGIBLE"), suspended: count("SUSPENDED"), deactivated: count("DEACTIVATED") };
    for (const k of Object.keys(expected) as (keyof typeof expected)[]) {
      if (r.summary[k] !== expected[k]) ctx.addIssue({ code: "custom", message: "SUMMARY_DOES_NOT_MATCH_RECORDS", path: ["summary", k] });
    }
    const keys = r.records.map((x) => `${x.capabilityId}|${x.workflowRef ?? ""}`);
    if (new Set(keys).size !== keys.length) ctx.addIssue({ code: "custom", message: "DUPLICATE_CAPABILITY_RECORD", path: ["records"] });
    r.records.forEach((x, i) => {
      if (x.tenantId !== r.tenantId) ctx.addIssue({ code: "custom", message: "RECORD_FROM_OTHER_TENANT", path: ["records", i, "tenantId"] });
    });
  });
export type ActivationReport = z.infer<typeof ActivationReport>;
