/**
 * Workforce SSO configuration of the console (WP-05; follow-on FO-05-13, FO-05-18, FO-05-41, FO-14-02,
 * FO-14-52, FO-01-09). Module-local config sub-schema and guard rule: the phase integration package adds
 * `consoleAuth: WorkforceSsoConfigSchema.optional()` to PlatformConfig and calls
 * `workforceSsoGuardViolations` from the configuration guard (docs/followon/work-packages.yaml ownership
 * rules: a feature package delivers its config sub-schema and guard rule, the integration package wires them).
 *
 * Redirect allowlist (FO-05-13): exact-match strings only. Each entry must be an absolute https URL that
 * round-trips through the WHATWG URL parser unchanged (no normalisation tricks), with no query, fragment,
 * userinfo or wildcard: the SCHEMA refuses anything else in every environment, and the guard additionally refuses
 * loopback hosts outside local/ci. The exchange endpoint compares the presented redirect_uri to this list BEFORE it
 * contacts the IdP. The issuer must be an absolute, canonical https URL without query, fragment, userinfo, dot
 * segments or an explicit default port (the schema checks its form; discovery checks equality with the IdP's).
 *
 * Membership (FO-05-41, FO-01-09): the claim named `groupsClaim` carries IdP membership values that `groupRoles`
 * maps EXACTLY to staff roles. Which kind of value it carries is declared, because a group PATH is spoofable on
 * some IdPs: Keycloak 26 lets a top-level group be named "vsp/security-admin", whose full path "/vsp/security-admin"
 * is identical to the nested managed group's (Layer-2 fidelity finding). So:
 *   CLIENT_ROLES  (required unless attested otherwise) roles of THIS console client at the IdP (Keycloak: a client
 *                 role mapper restricted to the client). Only an IdP administrator with role-mapping rights over the
 *                 client can grant them, whatever groups are named; every value is managed, so a client role that
 *                 `groupRoles` does not list refuses the sign-in (drift fails closed) and `managedGroupPrefix` must
 *                 be null.
 *   GROUP_PATHS   full group paths, only with `unambiguousPathsRef`: the approval record (AIN-13) that the tenant IdP
 *                 makes paths unambiguous (Keycloak: escape-slashes-in-group-path, so the lookalike's path is
 *                 "/vsp~/security-admin"), an IdP activation requirement the guard cannot observe.
 *
 * Session parameters (FO-05-18, FO-05-19): idle timeout, absolute lifetime, activity write interval and
 * the directory active-state check interval are engineering defaults pending identity-owner approval
 * (AIN-15); outside local/ci the guard requires the approval record id.
 */
import { z } from "zod";
import type { Environment, StaffRole } from "../protocol/index.js";
import { STAFF_ROLES } from "./contract.js";

const ISSUER = /^https:\/\/[A-Za-z0-9.-]{1,253}(:\d{2,5})?(\/[A-Za-z0-9._~/%-]*)?$/;
const AMR = /^[a-z][a-z0-9_]{1,31}$/;
const APPROVAL_ID = /^apr_[A-Za-z0-9_-]{8,64}$/;
const GROUP = /^[A-Za-z0-9/_. :-]{1,128}$/;

export const DEFAULT_WORKFORCE_SESSION = {
  /** Idle limit of a console session (engineering default pending identity-owner approval, AIN-15). */
  idleTimeoutSeconds: 900,
  /** Absolute lifetime of a session family; refresh never extends it. */
  absoluteLifetimeSeconds: 28_800,
  /** Bounded write rate of last_activity_at (the idle check is exact to this interval). */
  activityWriteIntervalSeconds: 30,
  /** How often the IdP is asked whether the session is still active (offboarding bound, FO-14-52). */
  activeCheckIntervalSeconds: 60,
  /** How long a session may keep working while the IdP cannot answer the active-state check. */
  activeCheckMaxStalenessSeconds: 300,
  /** In-flight requests may still carry the pre-rotation token this long after a refresh. */
  rotationGraceSeconds: 5,
} as const;

export const WorkforceSessionPolicySchema = z.strictObject({
  idleTimeoutSeconds: z.number().int().min(60).max(3_600),
  absoluteLifetimeSeconds: z.number().int().min(900).max(43_200),
  activityWriteIntervalSeconds: z.number().int().min(0).max(300),
  activeCheckIntervalSeconds: z.number().int().min(0).max(900),
  activeCheckMaxStalenessSeconds: z.number().int().min(0).max(3_600),
  rotationGraceSeconds: z.number().int().min(0).max(30),
});
export type WorkforceSessionPolicy = z.infer<typeof WorkforceSessionPolicySchema>;

/** What the membership claim carries (see the module comment). */
export const MembershipSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("CLIENT_ROLES") }),
  z.strictObject({ kind: z.literal("GROUP_PATHS"), unambiguousPathsRef: z.string().regex(APPROVAL_ID) }),
]);
export type MembershipSource = z.infer<typeof MembershipSourceSchema>;

export const WorkforceSsoConfigSchema = z
  .strictObject({
    tenantId: z.string().regex(/^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$/),
    /** Exact issuer identifier of the workforce IdP (discovery is fetched from it). */
    issuer: z.string().max(512).regex(ISSUER),
    clientId: z.string().regex(/^[A-Za-z0-9._:-]{3,256}$/),
    scopes: z.array(z.string().regex(/^[\x21\x23-\x5B\x5D-\x7E]{1,64}$/)).min(1).max(16),
    /** Exact-match redirect URI allowlist (FO-05-13). */
    redirectUris: z.array(z.string().min(12).max(256)).min(1).max(8),
    /** ID-token / introspection claim with the membership values (client roles or group paths). */
    groupsClaim: z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/),
    /** What `groupsClaim` carries: CLIENT_ROLES, or GROUP_PATHS with the unambiguous-paths approval. */
    membershipSource: MembershipSourceSchema,
    /** Exact IdP membership value -> staff role. A value not listed grants nothing. */
    groupRoles: z.record(z.string().regex(GROUP), z.enum(STAFF_ROLES)).refine((r) => Object.keys(r).length >= 1 && Object.keys(r).length <= 64, "groupRoles size"),
    /**
     * GROUP_PATHS: a group under this prefix that is NOT in groupRoles refuses sign-in (directory drift fails
     * closed). CLIENT_ROLES: must be null (every client role is managed).
     */
    managedGroupPrefix: z.string().regex(GROUP).nullable(),
    /**
     * Tenant override of the amr values accepted as MFA (AIN-13), any one of which suffices; `pwd` is never one.
     * null: the default rule (auth.ts `amrSatisfiesMfa`): `mfa`, or values of two distinct RFC 8176 factor classes.
     */
    acceptedMfaAmr: z.array(z.string().regex(AMR)).min(1).max(16).nullable(),
    /** Sign-in requires an IdP authentication at most this old (auth_time). */
    maxAuthAgeSeconds: z.number().int().min(30).max(3_600),
    /** Lifetime of a server-side login transaction (state, nonce, PKCE challenge). */
    loginTransactionTtlSeconds: z.number().int().min(60).max(1_800),
    session: WorkforceSessionPolicySchema,
    /** Identity-owner approval of the session parameters (AIN-15); null until it exists. */
    sessionParametersApprovalId: z.string().regex(APPROVAL_ID).nullable(),
  })
  .superRefine((c, ctx) => {
    if (!c.scopes.includes("openid")) ctx.addIssue({ code: "custom", message: "OPENID_SCOPE_REQUIRED", path: ["scopes"] });
    if (c.acceptedMfaAmr?.includes("pwd")) ctx.addIssue({ code: "custom", message: "PWD_IS_NOT_MFA", path: ["acceptedMfaAmr"] });
    if (new Set(c.redirectUris).size !== c.redirectUris.length) ctx.addIssue({ code: "custom", message: "REDIRECT_URI_DUPLICATE", path: ["redirectUris"] });
    c.redirectUris.forEach((u, i) => {
      const p = redirectUriFormProblem(u);
      if (p) ctx.addIssue({ code: "custom", message: p, path: ["redirectUris", i] });
    });
    const issuer = issuerProblem(c.issuer);
    if (issuer) ctx.addIssue({ code: "custom", message: issuer, path: ["issuer"] });
    if (c.membershipSource.kind === "CLIENT_ROLES" && c.managedGroupPrefix !== null) ctx.addIssue({ code: "custom", message: "CLIENT_ROLES_HAVE_NO_PREFIX", path: ["managedGroupPrefix"] });
    if (c.session.activityWriteIntervalSeconds >= c.session.idleTimeoutSeconds) ctx.addIssue({ code: "custom", message: "ACTIVITY_INTERVAL_EXCEEDS_IDLE", path: ["session"] });
    if (c.session.idleTimeoutSeconds > c.session.absoluteLifetimeSeconds) ctx.addIssue({ code: "custom", message: "IDLE_EXCEEDS_ABSOLUTE", path: ["session"] });
  });
export type WorkforceSsoConfig = z.infer<typeof WorkforceSsoConfigSchema>;

const OFFLINE: readonly Environment[] = ["local", "ci"];
/** Environments where emulator issuers and loopback redirects are refused and approvals are mandatory. */
const STRICT: readonly Environment[] = ["staging", "production"];

/**
 * Environment-independent form of a redirect URI (schema): absolute, canonical, https, no wildcard, userinfo, query
 * or fragment, a plain path. Exactness is the point: the stored string is what the exchange compares byte for byte,
 * so it must already be the parser's canonical form.
 */
export function redirectUriFormProblem(raw: string): string | null {
  if (/[*\s]/.test(raw)) return "REDIRECT_URI_WILDCARD";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "REDIRECT_URI_INVALID";
  }
  if (url.href !== raw) return "REDIRECT_URI_NOT_CANONICAL";
  if (url.username || url.password) return "REDIRECT_URI_USERINFO";
  if (url.search || raw.includes("?")) return "REDIRECT_URI_QUERY";
  if (url.hash || raw.includes("#")) return "REDIRECT_URI_FRAGMENT";
  if (url.protocol !== "https:") return "REDIRECT_URI_NOT_HTTPS";
  if (!/^\/[A-Za-z0-9._~/-]{0,200}$/.test(url.pathname)) return "REDIRECT_URI_PATH_INVALID";
  return null;
}

/** Why a redirect URI may not be allowlisted in `environment`, or null (the form, then loopback outside local/ci). */
export function redirectUriProblem(raw: string, environment: Environment): string | null {
  const form = redirectUriFormProblem(raw);
  if (form) return form;
  const host = new URL(raw).hostname.toLowerCase();
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
  if (loopback && STRICT.includes(environment)) return "REDIRECT_URI_LOOPBACK_IN_DEPLOYMENT";
  return null;
}

/**
 * Why an issuer identifier is malformed, or null: an absolute https URL in canonical form (lower-case host, no
 * explicit default port, no dot segments or empty segments), without userinfo, query or fragment, and without a
 * trailing slash (discovery requires the IdP's `issuer` to equal it exactly).
 */
export function issuerProblem(raw: string): string | null {
  if (!ISSUER.test(raw)) return "ISSUER_FORM_INVALID";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "ISSUER_FORM_INVALID";
  }
  if (url.protocol !== "https:") return "ISSUER_NOT_HTTPS";
  if (url.username || url.password) return "ISSUER_USERINFO";
  if (url.search || url.hash || raw.includes("?") || raw.includes("#")) return "ISSUER_QUERY_OR_FRAGMENT";
  if (raw.endsWith("/")) return "ISSUER_TRAILING_SLASH";
  const canonical = url.pathname === "/" ? url.origin : `${url.origin}${url.pathname}`;
  if (canonical !== raw || url.pathname.includes("//")) return "ISSUER_NOT_CANONICAL";
  return null;
}

/** Parses the config; throws with reason codes on a schema problem. */
export function parseWorkforceSsoConfig(raw: unknown): WorkforceSsoConfig {
  const r = WorkforceSsoConfigSchema.safeParse(raw);
  if (!r.success) throw new Error(`WORKFORCE_SSO_CONFIG_INVALID: ${r.error.issues.map((i) => i.message).join(",").slice(0, 200)}`);
  return r.data;
}

/**
 * Configuration-guard rule (to be loaded by platform/src/config/guard.ts). Violations are
 * `CODE@path` strings like the guard's own.
 */
export function workforceSsoGuardViolations(config: WorkforceSsoConfig | null | undefined, environment: Environment): string[] {
  const out: string[] = [];
  const offline = OFFLINE.includes(environment);
  const strict = STRICT.includes(environment);
  if (!config) {
    if (!offline) out.push("WORKFORCE_SSO_NOT_CONFIGURED@consoleAuth");
    return out;
  }
  config.redirectUris.forEach((u, i) => {
    const p = redirectUriProblem(u, environment);
    if (p) out.push(`${p}@consoleAuth.redirectUris[${i}]`);
  });
  const issuerHost = new URL(config.issuer).hostname.toLowerCase();
  if (strict && (issuerHost === "localhost" || issuerHost.endsWith(".test") || issuerHost.endsWith(".localhost"))) out.push("WORKFORCE_ISSUER_EMULATOR_IN_DEPLOYMENT@consoleAuth.issuer");
  if (strict && config.sessionParametersApprovalId === null) out.push("WORKFORCE_SESSION_PARAMETERS_UNAPPROVED@consoleAuth.sessionParametersApprovalId");
  if (config.managedGroupPrefix !== null && !Object.keys(config.groupRoles).every((g) => g.startsWith(config.managedGroupPrefix as string))) {
    out.push("WORKFORCE_GROUP_OUTSIDE_MANAGED_PREFIX@consoleAuth.groupRoles");
  }
  // A path mapping is spoofable unless the tenant IdP makes paths unambiguous; the approval reference records that
  // activation requirement (AIN-13). Outside local/ci a group-path mapping without a managed prefix is refused too.
  if (strict && config.membershipSource.kind === "GROUP_PATHS" && config.managedGroupPrefix === null) out.push("WORKFORCE_GROUP_PATHS_UNMANAGED@consoleAuth.managedGroupPrefix");
  return out;
}

/**
 * Roles a membership claim maps to, or the reason it is refused (exact match). CLIENT_ROLES: every value is managed,
 * so an unlisted value refuses (drift fails closed). GROUP_PATHS: an unlisted value under the managed prefix refuses.
 */
export function rolesForGroups(config: Pick<WorkforceSsoConfig, "groupRoles" | "managedGroupPrefix" | "membershipSource">, groups: readonly string[] | null): { roles: StaffRole[] } | { refused: string } {
  if (groups === null) return { refused: "STAFF_GROUPS_CLAIM_MISSING" };
  const allManaged = config.membershipSource.kind === "CLIENT_ROLES";
  const roles: StaffRole[] = [];
  for (const g of groups) {
    const role = Object.hasOwn(config.groupRoles, g) ? config.groupRoles[g] : undefined;
    if (role) {
      if (!roles.includes(role)) roles.push(role);
      continue;
    }
    if (allManaged || (config.managedGroupPrefix !== null && g.startsWith(config.managedGroupPrefix))) return { refused: "STAFF_GROUP_UNKNOWN" };
  }
  if (roles.length === 0) return { refused: "STAFF_NOT_PROVISIONED" };
  return { roles: roles.slice(0, 8) };
}
