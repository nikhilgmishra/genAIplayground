/**
 * Trusted session and permission model (spec section 7).
 *
 * AuthContext is reconstructed by the gateway from server-side session state on
 * every action. No field here may be supplied by a model, a caller utterance or
 * a vendor-proposed tool argument (AUTH-03).
 */
import { z } from "zod";
import {
  Assurance,
  ConsentState,
  IsoDateTime,
  OpaqueId,
  Role,
  VerificationMethod,
  VersionLabel,
  opaqueIdWithPrefix,
} from "./common.js";

export const SessionRef = opaqueIdWithPrefix("ses");
export type SessionRef = z.infer<typeof SessionRef>;

/** Authenticated service identity of the calling integration (e.g. Talkdesk MCP connector). */
export const IntegrationIdentity = z.strictObject({
  integrationId: z.string().regex(/^[a-z0-9-]{3,64}$/),
  tenantId: OpaqueId,
  environment: z.enum(["local", "ci", "sandbox", "staging", "production"]),
  /** Which trusted channel this credential represents. Tool calls and telephony control use separate identities. */
  channel: z.enum(["mcp_tools", "telephony_control", "portal", "console", "worker", "webhook"]),
  credentialId: z.string().min(3).max(128),
  authMethod: z.enum(["oauth2_client_credentials", "bearer_static_exception", "mtls", "oidc_workforce", "local_fixture"]),
});
export type IntegrationIdentity = z.infer<typeof IntegrationIdentity>;

export const RiskFlag = z.enum([
  "RECENT_NUMBER_CHANGE",
  "OTP_ABUSE_SUSPECTED",
  "ENUMERATION_SUSPECTED",
  "SHARED_DEVICE_POSSIBLE",
  "PARTICIPANT_CHANGED",
  "ACCOUNT_RECOVERY_IN_PROGRESS",
  "FRAUD_REVIEW",
  "SAFETY_ESCALATION_ACTIVE",
]);
export type RiskFlag = z.infer<typeof RiskFlag>;

/** Delegated authority derived only from authoritative enrollment / delegation records. */
export const DelegatedAuthority = z.strictObject({
  grantId: OpaqueId,
  kind: z.enum([
    "practice_delegation",
    "partner_affiliation",
    "legal_representative",
    "parental_authority",
  ]),
  /** Subject or organization the authority covers. */
  subjectId: OpaqueId.nullable(),
  organizationId: OpaqueId.nullable(),
  scopes: z.array(z.string().regex(/^[a-z_]+:[a-z_]+$/)).max(32),
  source: z.enum(["enrollment_system", "delegation_registry", "partner_contract_registry", "legal_authority_registry"]),
  validFrom: IsoDateTime,
  validUntil: IsoDateTime.nullable(),
});
export type DelegatedAuthority = z.infer<typeof DelegatedAuthority>;

export const AuthContext = z.strictObject({
  tenantId: OpaqueId,
  callId: OpaqueId,
  sessionRef: SessionRef,
  /** Incremented on participant change, account switch, recovery, role change or revocation. */
  sessionGeneration: z.number().int().min(1),
  actorId: OpaqueId.nullable(),
  selectedRole: Role.nullable(),
  subjectId: OpaqueId.nullable(),
  organizationId: OpaqueId.nullable(),
  delegatedAuthority: z.array(DelegatedAuthority).max(16),
  permittedScopes: z.array(z.string().regex(/^[a-z_]+:[a-z_]+$/)).max(64),
  assurance: Assurance,
  authenticatedAt: IsoDateTime.nullable(),
  /** Session hard expiry; enforced in application logic, independent of storage TTL (AUTH-04). */
  expiresAt: IsoDateTime,
  verificationMethod: VerificationMethod,
  consent: ConsentState,
  riskFlags: z.array(RiskFlag).max(16),
  policyVersion: VersionLabel,
  revoked: z.boolean(),
  /** A3 step-up is transaction-bound: valid only for this prepared-action digest. */
  stepUp: z
    .strictObject({ actionDigest: z.string().regex(/^[a-f0-9]{64}$/), verifiedAt: IsoDateTime, expiresAt: IsoDateTime })
    .nullable(),
  integration: IntegrationIdentity,
});
export type AuthContext = z.infer<typeof AuthContext>;

/** Authoritative relationship fact passed to policy (never derived from caller statements). */
export const RelationshipFact = z.strictObject({
  type: z.enum([
    "self",
    "treating_provider",
    "practice_member",
    "practice_delegate",
    "partner_affiliate",
    "partner_contract_purpose",
    "legal_representative",
    "parental_authority",
  ]),
  actorId: OpaqueId,
  subjectId: OpaqueId.nullable(),
  organizationId: OpaqueId.nullable(),
  scopes: z.array(z.string().regex(/^[a-z_]+:[a-z_]+$/)).max(32),
  source: z.enum([
    "identity_provider",
    "enrollment_system",
    "delegation_registry",
    "partner_contract_registry",
    "legal_authority_registry",
  ]),
  validUntil: IsoDateTime.nullable(),
  /** Extra constraints, e.g. minor confidentiality conflicts that force human review. */
  constraints: z.array(z.enum(["MINOR_CONFIDENTIALITY_REVIEW", "CUSTODY_DISPUTE", "AUTHORIZATION_EXPIRED"])).max(8),
});
export type RelationshipFact = z.infer<typeof RelationshipFact>;

/** What the Talkdesk Auth Gate variable may be set to. Anything other than boolean true is closed (AUTH-07). */
export const AuthGateResponse = z.strictObject({
  isAuthenticated: z.boolean(),
  sessionGeneration: z.number().int().min(1),
  evaluatedAt: IsoDateTime,
});
export type AuthGateResponse = z.infer<typeof AuthGateResponse>;

/** Signed short-lived assertion claims (minted/validated only by trusted components). */
export const VerificationAssertionClaims = z.strictObject({
  iss: z.string().min(3),
  aud: z.string().min(3),
  sub: OpaqueId,
  exp: z.number().int(),
  iat: z.number().int(),
  nbf: z.number().int(),
  jti: OpaqueId,
  nonce: z.string().min(16).max(128),
  sid: SessionRef,
  gen: z.number().int().min(1),
  call: OpaqueId,
  asr: Assurance,
  role: Role,
  purpose: z.enum(["transfer_receiver", "durable_action_grant", "portal_binding"]),
  /** For durable grants: the only actions this grant authorizes. */
  actions: z.array(z.string().regex(/^[a-z_.]+$/)).max(8),
});
export type VerificationAssertionClaims = z.infer<typeof VerificationAssertionClaims>;
