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
  ConsentProfile,
  DisclosureClassification,
  ConsentState,
  IsoDateTime,
  Jurisdiction,
  OpaqueId,
  ProcessingBasisKind,
  ProcessingPurpose,
  Role,
  VerificationMethod,
  VersionLabel,
  opaqueIdWithPrefix,
} from "./common.js";

export const AUTH_CONTEXT_SCHEMA_VERSION = "auth-context.v1";

/**
 * Upper bound of one OpenID Connect request's deadline (discovery, keys, token, introspection, revocation): the
 * OIDC transport refuses a longer per-request timeout (adapters/live/oidc-http.ts), and the console bounds how long
 * a refresh of one session row can be in flight from it (console-api/sso.ts REFRESH_IN_FLIGHT_SECONDS).
 */
export const OIDC_REQUEST_TIMEOUT_MAX_MS = 30_000;

/**
 * The most OpenID Connect requests one refresh-token grant makes in sequence (adapters/live/oidc-client.ts `refresh`,
 * pinned by its unit test): the discovery document when its cache has expired, the token request, the key set, the
 * discovery document again when its cache (at least 60 s, OidcDiscovery's minimum TTL) expires during the refresh,
 * and the key set again for an unknown `kid` (key rotation). With OIDC_REQUEST_TIMEOUT_MAX_MS each, this bounds the
 * IdP part of one refresh; the console's in-flight window adds a margin for its own database work.
 */
export const OIDC_REFRESH_MAX_REQUESTS = 5;

export const SessionRef = opaqueIdWithPrefix("ses");
export type SessionRef = z.infer<typeof SessionRef>;

/**
 * Trusted integration channels, including the follow-on `conversation_runtime` channel: the media /
 * conversation runtime calls the gateway with its own integration identity plus the trusted
 * CallBinding (ADR-0018 decision 1.6). IntegrationIdentity.channel below keeps the original six
 * values until the identity owner (WP-05: gateway/auth.ts fixture credentials, session-service and
 * session-store channel allowlists) adopts this enum; no other value is ever accepted.
 */
export const IntegrationChannel = z.enum(["mcp_tools", "telephony_control", "portal", "console", "worker", "webhook", "conversation_runtime"]);
export type IntegrationChannel = z.infer<typeof IntegrationChannel>;

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

/** Bases that rely on no approved matrix entry: public information, and the honest "unknown". */
export const UNAPPROVED_PROCESSING_BASES = ["PUBLIC_INFORMATION", "UNKNOWN"] as const satisfies readonly ProcessingBasisKind[];
/**
 * Bases that may be recorded for an UNKNOWN jurisdiction: the two unapproved bases and safety
 * routing, which never waits for jurisdiction or account authentication (SAFE-02). Every other basis
 * is a jurisdiction-specific matrix entry, so it cannot apply where the jurisdiction is unknown
 * (an unknown jurisdiction never inherits a permissive policy).
 */
export const UNKNOWN_JURISDICTION_BASES = ["PUBLIC_INFORMATION", "UNKNOWN", "SAFETY_ROUTING"] as const satisfies readonly ProcessingBasisKind[];

/**
 * Permitted processing basis established by the identity service from the counsel-approved
 * jurisdiction/purpose matrix (follow-on prompt section 5): never from a caller statement or model.
 * Every basis except PUBLIC_INFORMATION and UNKNOWN names the approval record of the matrix entry it
 * relies on; UNKNOWN never carries one; only PUBLIC_INFORMATION, UNKNOWN and SAFETY_ROUTING may be
 * recorded for an UNKNOWN jurisdiction.
 */
export const ProcessingBasis = z
  .strictObject({
    basis: ProcessingBasisKind,
    purpose: ProcessingPurpose,
    jurisdiction: Jurisdiction,
    /** Approval record of the matrix entry relied on; null only for PUBLIC_INFORMATION and UNKNOWN. */
    approvalRef: z.string().regex(/^apr_[A-Za-z0-9_-]{8,64}$/).nullable(),
    establishedAt: IsoDateTime,
    source: z.enum(["identity_service", "consent_registry", "delegation_registry", "policy_matrix"]),
  })
  .superRefine((b, ctx) => {
    const unapproved = (UNAPPROVED_PROCESSING_BASES as readonly string[]).includes(b.basis);
    if (!unapproved && b.approvalRef === null) ctx.addIssue({ code: "custom", message: "PROCESSING_BASIS_WITHOUT_APPROVAL", path: ["approvalRef"] });
    if (b.basis === "UNKNOWN" && b.approvalRef !== null) ctx.addIssue({ code: "custom", message: "UNKNOWN_BASIS_WITH_APPROVAL", path: ["approvalRef"] });
    if (b.jurisdiction === "UNKNOWN" && !(UNKNOWN_JURISDICTION_BASES as readonly string[]).includes(b.basis)) {
      ctx.addIssue({ code: "custom", message: "BASIS_FOR_UNKNOWN_JURISDICTION", path: ["jurisdiction"] });
    }
  });
export type ProcessingBasis = z.infer<typeof ProcessingBasis>;

export const AuthContext = z.strictObject({
  /**
   * Contract version (follow-on common envelope). Optional while session-store.ts (WP-05) does not
   * set it; absent means auth-context.v1.
   */
  schemaVersion: z.literal(AUTH_CONTEXT_SCHEMA_VERSION).optional(),
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
  /** Server-established processing basis (FO-04-05); additive until the session service sets it. */
  processingBasis: ProcessingBasis.optional(),
  /** Per-dimension consent (follow-on prompt section 5); additive until the session service sets it. */
  consentProfile: ConsentProfile.optional(),
  /**
   * Highest classification the session may disclose under its current assurance and basis. Never
   * VERIFICATION_SECRET: verification secrets are disclosed to no one (AUTH-06).
   */
  dataClassification: DisclosureClassification.optional(),
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
