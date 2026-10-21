/**
 * LIVE workforce staff directory over the workforce IdP's group claims (WP-05; follow-on FO-05-41,
 * FO-14-02, FO-14-52, FO-19-07; AUTH-02, AUTH-03). Replaces the former blocked stub.
 *
 * Resolution: a verified workforce identity (issuer, subject) plus the membership claim of its ID token or
 * introspection response maps to a StaffRecord:
 *   - the issuer must be the configured workforce issuer (one tenant per issuer);
 *   - each value is matched EXACTLY against `groupRoles`; with CLIENT_ROLES (roles of the console client at the IdP,
 *     the required source unless the tenant attests unambiguous group paths: sso-config.ts) every value is managed,
 *     so an unlisted one refuses the identity (STAFF_GROUP_UNKNOWN); with GROUP_PATHS an unlisted path under
 *     `managedGroupPrefix` refuses it and other paths grant nothing: drift fails closed instead of guessing;
 *   - no mapped role, or no membership claim at all, means not provisioned (null).
 * Group NAMES never grant a role by themselves: on Keycloak 26 a top-level group named "vsp/security-admin" has the
 * same full path as the nested managed group, so a path mapping is spoofable by anyone who may create a group.
 * The staff id is a pseudonymous, stable function of (issuer, subject): `stf_` + 32 base64url characters of
 * sha256("vsp.staff.v1", issuer, subject). The IdP subject itself is never stored or logged.
 *
 * Active state (offboarding, FO-14-52) is not a property of this mapping: the console session service asks
 * the IdP (token introspection) at a bounded interval and revokes the session when the IdP reports the
 * user disabled, deleted or logged out; see sso.ts.
 */
import { createHash } from "node:crypto";
import type { StaffRole } from "../protocol/index.js";
import type { StaffDirectory, StaffRecord } from "./auth.js";
import { rolesForGroups } from "./sso-config.js";
import type { WorkforceSsoConfig } from "./sso-config.js";

export type GroupMapping = { record: StaffRecord } | { refused: string };

export class OidcGroupStaffDirectory implements StaffDirectory {
  readonly kind = "live" as const;

  constructor(private readonly config: Pick<WorkforceSsoConfig, "issuer" | "tenantId" | "groupRoles" | "managedGroupPrefix" | "membershipSource">) {}

  /** Pseudonymous stable staff id for (issuer, subject). */
  staffIdFor(issuer: string, subject: string): string {
    const h = createHash("sha256").update("vsp.staff.v1\u0000").update(issuer).update("\u0000").update(subject).digest("base64url");
    return `stf_${h.slice(0, 32)}`;
  }

  /** Maps claims to a staff record or a refusal reason (never throws). */
  map(identity: { issuer: string; subject: string; groups: readonly string[] | null }): GroupMapping {
    if (identity.issuer !== this.config.issuer) return { refused: "STAFF_ISSUER_UNKNOWN" };
    if (typeof identity.subject !== "string" || identity.subject.length < 1 || identity.subject.length > 255) return { refused: "STAFF_NOT_PROVISIONED" };
    const mapped = rolesForGroups(this.config, identity.groups);
    if ("refused" in mapped) return mapped;
    const staffId = this.staffIdFor(identity.issuer, identity.subject);
    return { record: { staffId, tenantId: this.config.tenantId, displayLabel: workforceDisplayLabel(staffId, mapped.roles), roles: mapped.roles, active: true } };
  }

  async resolve(identity: { issuer: string; subject: string; groups?: readonly string[] | null }): Promise<StaffRecord | null> {
    const m = this.map({ issuer: identity.issuer, subject: identity.subject, groups: identity.groups ?? null });
    return "record" in m ? m.record : null;
  }
}

/** Neutral display label: role names and a short id; never a person's name or e-mail. */
export function workforceDisplayLabel(staffId: string, roles: readonly StaffRole[]): string {
  const role = (roles[0] ?? "staff").replace(/_/g, " ");
  return `Workforce ${role} ${staffId.slice(4, 10)}`;
}
