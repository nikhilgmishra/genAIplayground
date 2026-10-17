/**
 * Release manifest, approval records and prerequisite register (spec sections 5 and 16).
 * The coding agent cannot fabricate approvals: approval records are created by
 * accountable humans and verified against a trusted signing key in production.
 */
import { z } from "zod";
import { Environment, IsoDateTime, Sha256Hex, StaffRole, VersionLabel, VersionSet } from "./common.js";

export const ApprovalScope = z.enum([
  "PHI_PROCESSING",
  "VENDOR_SANDBOX_INTEGRATION",
  "BILLABLE_TEST_EXECUTION",
  "PSTN_TEST_CALLS",
  "PRODUCTION_DEPLOYMENT",
  "PILOT_EXPOSURE",
  "MODEL_VOICE_SELECTION",
  "POLICY_RELEASE",
  "KNOWLEDGE_RELEASE",
  "CLINICAL_SCRIPTS",
  "RETENTION_SCHEDULE",
  "STATIC_CREDENTIAL_EXCEPTION",
  "SECURITY_REVIEW",
]);
export type ApprovalScope = z.infer<typeof ApprovalScope>;

export const ApprovalRecord = z.strictObject({
  approvalId: z.string().regex(/^apr_[A-Za-z0-9_-]{8,64}$/),
  approver: z.strictObject({
    name: z.string().min(2).max(120),
    role: z.enum([
      "privacy_counsel",
      "security_leadership",
      "clinical_safety_lead",
      "finance",
      "operations",
      "executive_sponsor",
      "identity_owner",
      "salesforce_admin",
      "talkdesk_admin",
      "sre_lead",
      "qa_language_lead",
    ]),
  }),
  scope: ApprovalScope,
  /** Precise scope statement: tenant, SKU, region, feature, model, budget ceiling, etc. */
  scopeDetail: z.string().min(10).max(2000),
  environment: Environment,
  grantedAt: IsoDateTime,
  expiresAt: IsoDateTime,
  evidenceRef: z.string().min(3).max(512),
  /** Detached signature over canonical JSON of the record (verified with a trusted KMS key). */
  signature: z.string().min(16).max(4096).nullable(),
});
export type ApprovalRecord = z.infer<typeof ApprovalRecord>;

export const PrerequisiteStatus = z.enum([
  "UNKNOWN",
  "BLOCKED",
  "REQUESTED",
  "IN_PROGRESS",
  "EVIDENCED",
  "APPROVED",
  "EXPIRED",
  "NOT_APPLICABLE",
]);
export type PrerequisiteStatus = z.infer<typeof PrerequisiteStatus>;

export const PrerequisiteRecord = z.strictObject({
  id: z.string().regex(/^PRQ-[0-9]{3}$/),
  owner: z.string().min(2).max(120),
  artifact: z.string().min(5).max(600),
  gate: z.string().min(5).max(300),
  status: PrerequisiteStatus,
  evidenceRef: z.string().max(512).nullable(),
  approvalDate: IsoDateTime.nullable(),
  expiryDate: IsoDateTime.nullable(),
  environment: z.union([Environment, z.literal("all")]),
  nextAction: z.string().min(5).max(600),
  blocks: z.array(z.string().max(80)).max(32),
});
export type PrerequisiteRecord = z.infer<typeof PrerequisiteRecord>;

export const ReleaseStatus = z.enum(["IMPLEMENTED_OFFLINE", "VERIFIED_SANDBOX", "APPROVED_PILOT", "VERIFIED_PRODUCTION", "BLOCKED"]);
export type ReleaseStatus = z.infer<typeof ReleaseStatus>;

const EvidenceRef = z.strictObject({
  kind: z.string().regex(/^[a-z_]{3,40}$/),
  ref: z.string().max(512),
  digest: Sha256Hex.nullable(),
  status: z.enum(["PASS", "FAIL", "INCONCLUSIVE", "NOT_RUN", "BLOCKED"]),
});

export const ReleaseManifest = z.strictObject({
  manifestVersion: z.literal("release-manifest.v1"),
  releaseId: z.string().regex(/^rel_[A-Za-z0-9_-]{8,64}$/),
  createdAt: IsoDateTime,
  targetEnvironment: Environment,
  status: ReleaseStatus,
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  build: z.strictObject({ buildId: z.string().max(128).nullable(), imageDigest: z.string().max(128).nullable() }),
  infrastructurePlanDigest: Sha256Hex.nullable(),
  schemaVersion: VersionLabel,
  migrationsDigest: Sha256Hex,
  talkdeskConfigurationId: z.string().max(128).nullable(),
  versions: VersionSet,
  toolSchemaDigest: Sha256Hex,
  policyBundleDigest: Sha256Hex,
  knowledgeSnapshotDigest: Sha256Hex.nullable(),
  evaluationCorpusDigest: Sha256Hex,
  testEvidence: z.array(EvidenceRef).max(128),
  quotaAndLoadEvidence: z.array(EvidenceRef).max(32),
  retentionConfigurationDigest: Sha256Hex.nullable(),
  rollbackTarget: z.string().max(128).nullable(),
  approvals: z.array(ApprovalRecord).max(64),
  /** Required approvals for the target environment that are absent (never fabricated). */
  missingApprovals: z.array(ApprovalScope).max(32),
  signature: z.string().max(4096).nullable(),
});
export type ReleaseManifest = z.infer<typeof ReleaseManifest>;

export const StaffActor = z.strictObject({
  staffId: z.string().regex(/^stf_[A-Za-z0-9_-]{8,64}$/),
  roles: z.array(StaffRole).min(1).max(8),
  mfa: z.boolean(),
  authenticatedAt: IsoDateTime,
  breakGlass: z.strictObject({ reason: z.string().min(10).max(300), expiresAt: IsoDateTime, approvedBy: z.string() }).nullable(),
});
export type StaffActor = z.infer<typeof StaffActor>;
