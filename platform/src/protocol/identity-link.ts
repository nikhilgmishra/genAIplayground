/**
 * IdentityLink and PersonRoleAssignment (follow-on prompt sections 4, 5 and 7; FO-04-11, FO-04-45).
 *
 * A canonical person is linked to IdP subjects, directory accounts and source-system records only
 * through deterministic, authoritative links with validity intervals and reversible lineage. Fuzzy
 * email/name/phone matching, shared-device linking, CDP alias/identify or model inference can be
 * recorded as an analytics signal but can never authorize protected-data merging or disclosure.
 * The identity graph itself is sensitive: external identifiers are stored as keyed digests.
 *
 * One person can hold several roles (PersonRoleAssignment); a session still selects exactly one
 * (AuthContext.selectedRole) and roles are never unioned silently.
 *
 * Created by WP-02 in phase B; owned by WP-19 from phase D.
 */
import { z } from "zod";
import { DelegatedAuthority } from "./auth.js";
import { EvidencePointer, IsoDateTime, OpaqueId, Role, Sha256Hex, SourceSystemId, envelope, isAfter, opaqueIdWithPrefix } from "./common.js";

export const IDENTITY_LINK_SCHEMA_VERSION = "identity-link.v1";
export const PERSON_ROLE_ASSIGNMENT_SCHEMA_VERSION = "person-role-assignment.v1";

export const PersonRef = opaqueIdWithPrefix("per");
export const IdentityLinkId = opaqueIdWithPrefix("idl");

export const LinkedIdentityKind = z.enum(["IDP_SUBJECT", "DIRECTORY_ACCOUNT", "CRM_CONTACT", "BUSINESS_SYSTEM_RECORD", "CDP_PROFILE"]);
export type LinkedIdentityKind = z.infer<typeof LinkedIdentityKind>;

/** How a link was established. Only the authoritative bases can be used for authorization. */
export const LinkBasis = z.enum([
  "DETERMINISTIC_ENROLLMENT",
  "VERIFIED_IDP_LOGIN",
  "AUTHORITATIVE_SOURCE_LINK",
  "STAFF_REVIEWED_MERGE",
  "ANALYTICS_ALIAS_SIGNAL",
  "PROBABILISTIC_MATCH",
]);
export type LinkBasis = z.infer<typeof LinkBasis>;

/** Bases that can never authorize protected-data merging or disclosure (follow-on prompt section 7). */
export const NON_AUTHORITATIVE_LINK_BASES = ["ANALYTICS_ALIAS_SIGNAL", "PROBABILISTIC_MATCH"] as const satisfies readonly LinkBasis[];

export const IdentityLinkState = z.enum(["ACTIVE", "QUARANTINED_AMBIGUOUS", "SUPERSEDED", "SPLIT", "REVOKED"]);
export type IdentityLinkState = z.infer<typeof IdentityLinkState>;

export const IdentityLink = z
  .strictObject({
    ...envelope(IDENTITY_LINK_SCHEMA_VERSION, ["tenantId", "occurredAt"], ["causationId", "expiresAt"]),
    linkId: IdentityLinkId,
    personRef: PersonRef,
    /** Version of the canonical id; merges and splits bump it and invalidate caches. */
    canonicalIdVersion: z.number().int().min(1).max(1_000_000),
    linked: z.strictObject({
      kind: LinkedIdentityKind,
      system: SourceSystemId,
      /** OIDC issuer for IDP_SUBJECT links (https URL without query); null otherwise. */
      issuer: z.string().max(256).regex(/^https:\/\/[A-Za-z0-9.-]{1,253}(:\d{2,5})?(\/[A-Za-z0-9._~/-]*)?$/).nullable(),
      /** Keyed digest (HMAC-SHA256) of the external identifier; the raw value is not stored here. */
      externalRefDigest: Sha256Hex,
    }),
    basis: LinkBasis,
    /** True only for an ACTIVE link on an authoritative basis. */
    authorizationEligible: z.boolean(),
    state: IdentityLinkState,
    verifiedAt: IsoDateTime.nullable(),
    verificationSource: z.enum(["identity_provider", "enrollment_system", "directory", "source_system", "staff_review", "analytics"]),
    reviewEvidenceRef: EvidencePointer.nullable(),
    validFrom: IsoDateTime,
    validUntil: IsoDateTime.nullable(),
    lineage: z.strictObject({
      supersedes: IdentityLinkId.nullable(),
      mergedFrom: z.array(PersonRef).max(8),
      splitFrom: PersonRef.nullable(),
    }),
  })
  .superRefine((l, ctx) => {
    const nonAuthoritative = (NON_AUTHORITATIVE_LINK_BASES as readonly string[]).includes(l.basis);
    if (l.authorizationEligible && (nonAuthoritative || l.state !== "ACTIVE")) {
      ctx.addIssue({ code: "custom", message: "NON_AUTHORITATIVE_LINK_ELIGIBLE", path: ["authorizationEligible"] });
    }
    if (l.authorizationEligible && l.verifiedAt === null) ctx.addIssue({ code: "custom", message: "ELIGIBLE_LINK_UNVERIFIED", path: ["verifiedAt"] });
    // A CDP profile or an analytics verification is never an authenticator (follow-on prompt
    // section 5), whatever basis label the link carries.
    if (l.authorizationEligible && (l.linked.kind === "CDP_PROFILE" || l.verificationSource === "analytics")) {
      ctx.addIssue({ code: "custom", message: "ELIGIBLE_LINK_FROM_ANALYTICS", path: ["authorizationEligible"] });
    }
    if (l.basis === "STAFF_REVIEWED_MERGE" && l.reviewEvidenceRef === null) ctx.addIssue({ code: "custom", message: "MERGE_WITHOUT_REVIEW_EVIDENCE", path: ["reviewEvidenceRef"] });
    if ((l.linked.kind === "IDP_SUBJECT") !== (l.linked.issuer !== null)) ctx.addIssue({ code: "custom", message: "ISSUER_ONLY_FOR_IDP_SUBJECT", path: ["linked", "issuer"] });
    if (l.validUntil !== null && !isAfter(l.validUntil, l.validFrom)) ctx.addIssue({ code: "custom", message: "LINK_VALIDITY_EMPTY", path: ["validUntil"] });
    if (l.lineage.mergedFrom.includes(l.personRef) || l.lineage.splitFrom === l.personRef) {
      ctx.addIssue({ code: "custom", message: "LINEAGE_REFERS_TO_SELF", path: ["lineage"] });
    }
  });
export type IdentityLink = z.infer<typeof IdentityLink>;

/** A link authorizes protected joins at `now` only when eligible, ACTIVE and within its validity interval. */
export function linkAuthorizes(l: IdentityLink, now: Date): boolean {
  const t = now.getTime();
  if (!l.authorizationEligible || l.state !== "ACTIVE") return false;
  if (Date.parse(l.validFrom) > t) return false;
  if (l.validUntil !== null && Date.parse(l.validUntil) <= t) return false;
  return l.expiresAt === null || Date.parse(l.expiresAt) > t;
}

/**
 * One role a person holds, from an authoritative source, with its organization/delegation scope.
 * A person may have many assignments; each session selects one (never a union).
 */
export const PersonRoleAssignment = z
  .strictObject({
    ...envelope(PERSON_ROLE_ASSIGNMENT_SCHEMA_VERSION, ["tenantId", "occurredAt"], ["causationId", "expiresAt"]),
    assignmentId: opaqueIdWithPrefix("pra"),
    personRef: PersonRef,
    /** Actor identity used by sessions for this person in this role. */
    actorRef: OpaqueId,
    role: Role,
    organizationRef: OpaqueId.nullable(),
    delegations: z.array(DelegatedAuthority).max(16),
    source: z.enum(["identity_provider", "enrollment_system", "delegation_registry", "partner_contract_registry", "legal_authority_registry"]),
    validFrom: IsoDateTime,
    validUntil: IsoDateTime.nullable(),
    revoked: z.boolean(),
  })
  .superRefine((a, ctx) => {
    if (a.validUntil !== null && !isAfter(a.validUntil, a.validFrom)) ctx.addIssue({ code: "custom", message: "ASSIGNMENT_VALIDITY_EMPTY", path: ["validUntil"] });
    const orgRoles: readonly string[] = ["provider", "practice_staff", "partner", "payer_representative"];
    if (orgRoles.includes(a.role) && a.organizationRef === null) ctx.addIssue({ code: "custom", message: "ORGANIZATION_ROLE_WITHOUT_ORGANIZATION", path: ["organizationRef"] });
  });
export type PersonRoleAssignment = z.infer<typeof PersonRoleAssignment>;

/** Assignments usable at `now` for one person of one tenant; a session must still pick exactly one of them. */
export function activeAssignments(assignments: readonly PersonRoleAssignment[], tenantId: string, personRef: string, now: Date): PersonRoleAssignment[] {
  const t = now.getTime();
  return assignments.filter(
    (a) =>
      a.tenantId === tenantId &&
      a.personRef === personRef &&
      !a.revoked &&
      Date.parse(a.validFrom) <= t &&
      (a.validUntil === null || Date.parse(a.validUntil) > t) &&
      (a.expiresAt === null || Date.parse(a.expiresAt) > t),
  );
}
