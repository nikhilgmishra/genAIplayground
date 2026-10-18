/**
 * Policy decision contract between the gateway and the local OPA bundle.
 * Deny by default; the gateway treats any evaluation error as deny.
 */
import { z } from "zod";
import { Assurance, Classification, Environment, IsoDateTime, OpaqueId, Role, VersionLabel } from "./common.js";
import { RelationshipFact, RiskFlag } from "./auth.js";
import { ReasonCode } from "./tools.js";

export const PolicyAction = z.string().regex(/^[a-z_]+:[a-z_]+$/);
export type PolicyAction = z.infer<typeof PolicyAction>;

export const PolicyPurpose = z.enum([
  "caller_self_service",
  "delegated_practice_administration",
  "partner_administration",
  "representative_access",
  "safety_routing",
  "human_handoff",
  "public_information",
  "staff_support",
  "audit_review",
  "durable_follow_up",
]);
export type PolicyPurpose = z.infer<typeof PolicyPurpose>;

export const PolicyInput = z.strictObject({
  action: PolicyAction,
  purpose: PolicyPurpose,
  environment: Environment,
  now: IsoDateTime,
  tool: z.strictObject({ name: z.string(), version: z.string(), minAssurance: Assurance, consequential: z.boolean() }).nullable(),
  /** Server-established subset of AuthContext. */
  auth: z.strictObject({
    tenantId: OpaqueId,
    sessionGeneration: z.number().int().min(1),
    actorId: OpaqueId.nullable(),
    selectedRole: Role.nullable(),
    subjectId: OpaqueId.nullable(),
    organizationId: OpaqueId.nullable(),
    permittedScopes: z.array(z.string()),
    assurance: Assurance,
    authenticatedAt: IsoDateTime.nullable(),
    expiresAt: IsoDateTime,
    revoked: z.boolean(),
    riskFlags: z.array(RiskFlag),
    consentRecording: z.enum(["GRANTED", "DECLINED", "UNKNOWN", "NOT_REQUIRED"]),
    consentAutomatedProcessing: z.enum(["GRANTED", "DECLINED", "UNKNOWN", "NOT_REQUIRED"]),
    stepUpDigest: z.string().nullable(),
    stepUpExpiresAt: IsoDateTime.nullable(),
  }),
  resource: z.strictObject({
    type: z.string().regex(/^[a-z_]{3,40}$/),
    tenantId: OpaqueId,
    subjectId: OpaqueId.nullable(),
    organizationId: OpaqueId.nullable(),
    classification: Classification,
    /** For mutations: the prepared action digest being committed. */
    actionDigest: z.string().nullable(),
  }),
  relationships: z.array(RelationshipFact).max(32),
  killSwitches: z.strictObject({
    aiAdmission: z.boolean(),
    writes: z.boolean(),
    intents: z.array(z.string()),
    integrations: z.array(z.string()),
  }),
});
export type PolicyInput = z.infer<typeof PolicyInput>;

export const PolicyDecision = z.strictObject({
  decisionId: OpaqueId,
  allow: z.boolean(),
  reasonCodes: z.array(ReasonCode).min(1).max(16),
  /** Fields the response may include; anything else is stripped (field-level minimization). */
  fieldMask: z.array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.]{0,80}$/)).max(64),
  obligations: z.array(z.enum(["REQUIRE_CONFIRMATION", "REQUIRE_STEP_UP", "REQUIRE_HUMAN", "AUDIT_READ", "RESTRICTED_RECORD"])).max(8),
  policyVersion: VersionLabel,
  evaluatedAt: IsoDateTime,
});
export type PolicyDecision = z.infer<typeof PolicyDecision>;
