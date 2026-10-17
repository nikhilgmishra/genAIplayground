/**
 * Shared protocol primitives. Every object schema in the protocol is strict
 * (unknown keys rejected => JSON Schema additionalProperties:false).
 *
 * Identifiers are opaque: a prefix plus random base64url. They never embed
 * names, dates of birth, phone numbers or any other PHI.
 */
import { z } from "zod";

export const PROTOCOL_VERSION = "2026-10-17.1";

/** Opaque identifier: `<prefix>_<16..64 base64url chars>`. */
export const OpaqueId = z
  .string()
  .regex(/^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$/, "opaque identifier expected");
export type OpaqueId = z.infer<typeof OpaqueId>;

export const opaqueIdWithPrefix = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9_-]{16,64}$`), `opaque ${prefix}_ identifier expected`);

export const IsoDateTime = z.iso.datetime({ offset: false });
export type IsoDateTime = z.infer<typeof IsoDateTime>;

export const Sha256Hex = z.string().regex(/^[a-f0-9]{64}$/, "sha256 hex digest expected");
export type Sha256Hex = z.infer<typeof Sha256Hex>;

/** Semantic or date-based version label for pinned artifacts. */
export const VersionLabel = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/);

export const Environment = z.enum(["local", "ci", "sandbox", "staging", "production"]);
export type Environment = z.infer<typeof Environment>;

/** Caller audience selected during intake. A multi-role user selects exactly one. */
export const Role = z.enum([
  "client",
  "prospective_client",
  "provider",
  "practice_staff",
  "partner",
  "payer_representative",
  "personal_representative",
]);
export type Role = z.infer<typeof Role>;

/** Workforce roles (console, approvals). Separated per spec section 7. */
export const StaffRole = z.enum([
  "support_agent",
  "supervisor",
  "safety_responder",
  "auditor",
  "knowledge_editor",
  "policy_approver",
  "deployment_operator",
  "security_admin",
]);
export type StaffRole = z.infer<typeof StaffRole>;

/**
 * Application policy assurance tiers (NOT NIST AAL certifications).
 * A0 unverified, A1 verified possession, A2 account authenticated, A3 recent step-up.
 */
export const Assurance = z.enum(["A0", "A1", "A2", "A3"]);
export type Assurance = z.infer<typeof Assurance>;
export const ASSURANCE_RANK: Record<Assurance, number> = { A0: 0, A1: 1, A2: 2, A3: 3 };
export const meetsAssurance = (have: Assurance, need: Assurance): boolean =>
  ASSURANCE_RANK[have] >= ASSURANCE_RANK[need];

export const VerificationMethod = z.enum([
  "none",
  "secure_link_oidc",
  "portal_session",
  "otp_sms_registered_channel",
  "otp_voice_registered_channel",
  "human_verified",
]);
export type VerificationMethod = z.infer<typeof VerificationMethod>;

/** Record / payload classification used by policy and egress controls. */
export const Classification = z.enum([
  "PUBLIC",
  "INTERNAL",
  "PHI",
  "PHI_RESTRICTED",
  "FINANCIAL",
  "VERIFICATION_SECRET",
]);
export type Classification = z.infer<typeof Classification>;

/** Retention data classes (spec section 6). Retention durations are set by counsel, never invented here. */
export const DataClass = z.enum([
  "TRANSIENT_CONVERSATION",
  "BUSINESS_RECORD",
  "RESTRICTED_QA_MEDIA",
  "SECURITY_AUDIT",
]);
export type DataClass = z.infer<typeof DataClass>;

/** Distinct interaction outcomes (spec section 4). HTTP 200, hang-up or Case creation never alone mean RESOLVED. */
export const Outcome = z.enum([
  "RESOLVED",
  "REQUEST_ACCEPTED",
  "TRANSFERRED",
  "INFORMATION_PROVIDED",
  "DECLINED_BY_POLICY",
  "CALLER_DISCONNECTED",
  "FAILED",
  "OUTCOME_UNKNOWN",
]);
export type Outcome = z.infer<typeof Outcome>;

export const ConsentValue = z.enum(["GRANTED", "DECLINED", "UNKNOWN", "NOT_REQUIRED"]);
export type ConsentValue = z.infer<typeof ConsentValue>;

export const ConsentState = z.strictObject({
  recording: ConsentValue,
  automatedProcessing: ConsentValue,
  /** Jurisdiction-approved disclosure template version actually played. */
  disclosureTemplateVersion: VersionLabel.nullable(),
  capturedAt: IsoDateTime.nullable(),
  capturedBy: z.enum(["studio_flow", "human_agent", "portal", "none"]),
});
export type ConsentState = z.infer<typeof ConsentState>;

/** Pinned versions of everything that shapes caller-facing behaviour (OPS-06). */
export const VersionSet = z.strictObject({
  agentConfig: VersionLabel,
  model: VersionLabel,
  voice: VersionLabel,
  promptTemplates: VersionLabel,
  policyBundle: VersionLabel,
  toolCatalog: Sha256Hex,
  knowledgeSnapshot: VersionLabel,
  schema: VersionLabel,
});
export type VersionSet = z.infer<typeof VersionSet>;

/** Fields in the protocol that may only be set by trusted server components. */
export const SERVER_ESTABLISHED_FIELDS = [
  "tenantId",
  "callId",
  "sessionGeneration",
  "actorId",
  "selectedRole",
  "subjectId",
  "organizationId",
  "delegatedAuthority",
  "permittedScopes",
  "assurance",
  "authenticatedAt",
  "verificationMethod",
  "consent",
  "riskFlags",
  "policyVersion",
  "revoked",
] as const;
