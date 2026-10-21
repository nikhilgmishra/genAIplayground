import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TENANT_ID } from "../fixtures/synthetic-world.js";
import { DEFAULT_WORKFORCE_SESSION, WorkforceSsoConfigSchema, issuerProblem, parseWorkforceSsoConfig, redirectUriProblem, rolesForGroups, workforceSsoGuardViolations } from "./sso-config.js";
import { CONSOLE_SESSION_TOKEN, newConsoleSessionToken, sessionVerdict } from "./sessions.js";
import type { ConsoleSessionRow } from "./sessions.js";
import { AesGcmTokenSealer } from "./token-sealer.js";

const base = {
  tenantId: TENANT_ID,
  issuer: "https://sso.workforce.vsp-unit.invalid/realms/workforce",
  clientId: "vsp-console",
  scopes: ["openid"],
  redirectUris: ["https://console.vsp-unit.invalid/auth/callback"],
  groupsClaim: "groups",
  membershipSource: { kind: "GROUP_PATHS", unambiguousPathsRef: "apr_synthUnambiguousPaths01" },
  groupRoles: { "/vsp/supervisor": "supervisor", "/vsp/security-admin": "security_admin" },
  managedGroupPrefix: "/vsp/",
  acceptedMfaAmr: ["otp", "hwk"],
  maxAuthAgeSeconds: 600,
  loginTransactionTtlSeconds: 600,
  session: DEFAULT_WORKFORCE_SESSION,
  sessionParametersApprovalId: "apr_synthSessionParams001",
};

describe("[FO-05-13] exact-match callback allowlist and config guard", () => {
  it("[FO-05-13] only canonical https redirect URIs without query, fragment, userinfo or wildcard are allowlisted", () => {
    expect(redirectUriProblem("https://console.vsp-unit.invalid/auth/callback", "production")).toBeNull();
    const cases: [string, string][] = [
      ["https://*.vsp-unit.invalid/auth/callback", "REDIRECT_URI_WILDCARD"],
      ["https://Console.vsp-unit.invalid/auth/callback", "REDIRECT_URI_NOT_CANONICAL"],
      ["https://console.vsp-unit.invalid:443/auth/callback", "REDIRECT_URI_NOT_CANONICAL"],
      ["https://console.vsp-unit.invalid/auth/../callback", "REDIRECT_URI_NOT_CANONICAL"],
      ["https://user@console.vsp-unit.invalid/auth/callback", "REDIRECT_URI_USERINFO"],
      ["https://console.vsp-unit.invalid/auth/callback?next=x", "REDIRECT_URI_QUERY"],
      ["https://console.vsp-unit.invalid/auth/callback#x", "REDIRECT_URI_FRAGMENT"],
      ["http://console.vsp-unit.invalid/auth/callback", "REDIRECT_URI_NOT_HTTPS"],
      ["https://localhost/auth/callback", "REDIRECT_URI_LOOPBACK_IN_DEPLOYMENT"],
      ["not a url", "REDIRECT_URI_WILDCARD"],
    ];
    for (const [uri, code] of cases) expect(redirectUriProblem(uri, "production"), uri).toBe(code);
    expect(redirectUriProblem("https://localhost/auth/callback", "local")).toBeNull();
  });

  it("[FO-05-13][FO-05-18][OPS-04] the guard refuses a missing SSO config, emulator issuers and unapproved session parameters outside local/ci", () => {
    expect(workforceSsoGuardViolations(null, "production")).toEqual(["WORKFORCE_SSO_NOT_CONFIGURED@consoleAuth"]);
    expect(workforceSsoGuardViolations(null, "local")).toEqual([]);
    const cfg = parseWorkforceSsoConfig(base);
    expect(workforceSsoGuardViolations(cfg, "production")).toEqual([]);
    const emu = parseWorkforceSsoConfig({ ...base, issuer: "https://idp.vsp-identity.test/realms/workforce", sessionParametersApprovalId: null, redirectUris: ["https://localhost/auth/callback"] });
    expect(workforceSsoGuardViolations(emu, "staging").sort()).toEqual(
      ["REDIRECT_URI_LOOPBACK_IN_DEPLOYMENT@consoleAuth.redirectUris[0]", "WORKFORCE_ISSUER_EMULATOR_IN_DEPLOYMENT@consoleAuth.issuer", "WORKFORCE_SESSION_PARAMETERS_UNAPPROVED@consoleAuth.sessionParametersApprovalId"].sort(),
    );
    expect(workforceSsoGuardViolations(emu, "local")).toEqual([]);
    expect(workforceSsoGuardViolations(parseWorkforceSsoConfig({ ...base, groupRoles: { "/other/admins": "security_admin" } }), "local")).toEqual(["WORKFORCE_GROUP_OUTSIDE_MANAGED_PREFIX@consoleAuth.groupRoles"]);
    // pwd alone is never MFA; openid is mandatory; idle must fit in the absolute lifetime.
    expect(WorkforceSsoConfigSchema.safeParse({ ...base, acceptedMfaAmr: ["pwd"] }).success).toBe(false);
    expect(WorkforceSsoConfigSchema.safeParse({ ...base, scopes: ["profile"] }).success).toBe(false);
    expect(WorkforceSsoConfigSchema.safeParse({ ...base, session: { ...DEFAULT_WORKFORCE_SESSION, idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 1800 } }).success).toBe(false);
  });

  it("[FO-05-41] group mapping is exact; an unknown group under the managed prefix refuses; groups outside it are ignored", () => {
    const cfg = parseWorkforceSsoConfig(base);
    expect(rolesForGroups(cfg, ["/vsp/supervisor", "/hr/everyone"])).toEqual({ roles: ["supervisor"] });
    expect(rolesForGroups(cfg, ["/vsp/supervisor", "/vsp/supervisor-old"])).toEqual({ refused: "STAFF_GROUP_UNKNOWN" });
    expect(rolesForGroups(cfg, ["/hr/everyone"])).toEqual({ refused: "STAFF_NOT_PROVISIONED" });
    expect(rolesForGroups(cfg, null)).toEqual({ refused: "STAFF_GROUPS_CLAIM_MISSING" });
    expect(rolesForGroups(cfg, ["__proto__", "constructor"])).toEqual({ refused: "STAFF_NOT_PROVISIONED" });
  });
});

describe("[FO-05-13][FO-05-07] the config schema validates the redirect URI and issuer forms in every environment", () => {
  const issues = (cfg: Record<string, unknown>): string[] => {
    const r = WorkforceSsoConfigSchema.safeParse(cfg);
    return r.success ? [] : r.error.issues.map((i) => i.message);
  };
  it("[FO-05-13] a redirect URI must be an absolute canonical https URL without wildcard, userinfo, query or fragment", () => {
    expect(issues(base)).toEqual([]);
    const cases: [string, string][] = [
      ["https://*.vsp-unit.invalid/auth/callback", "REDIRECT_URI_WILDCARD"],
      ["https://console.vsp-unit.invalid/auth/*", "REDIRECT_URI_WILDCARD"],
      ["https://user:pw@console.vsp-unit.invalid/auth/callback", "REDIRECT_URI_USERINFO"],
      ["https://console.vsp-unit.invalid/auth/callback#frag", "REDIRECT_URI_FRAGMENT"],
      ["https://console.vsp-unit.invalid/auth/callback?next=1", "REDIRECT_URI_QUERY"],
      ["http://console.vsp-unit.invalid/auth/callback", "REDIRECT_URI_NOT_HTTPS"],
      ["https://CONSOLE.vsp-unit.invalid/auth/callback", "REDIRECT_URI_NOT_CANONICAL"],
      ["https://console.vsp-unit.invalid:443/auth/callback", "REDIRECT_URI_NOT_CANONICAL"],
      ["/auth/callback/relative/path", "REDIRECT_URI_INVALID"],
      ["javascript:alert(1)//x/y/z", "REDIRECT_URI_NOT_HTTPS"],
    ];
    for (const [uri, code] of cases) expect(issues({ ...base, redirectUris: [uri] }), uri).toContain(code);
    // The schema has no environment: loopback is the guard's rule (allowed only in local/ci).
    expect(issues({ ...base, redirectUris: ["https://localhost/auth/callback"] })).toEqual([]);
    expect(() => parseWorkforceSsoConfig({ ...base, redirectUris: ["https://console.vsp-unit.invalid/auth/callback#x"] })).toThrow(/WORKFORCE_SSO_CONFIG_INVALID: REDIRECT_URI_FRAGMENT/);
  });

  it("[FO-05-07] the issuer must be an absolute canonical https URL without userinfo, query, fragment, dot segments, default port or trailing slash", () => {
    expect(issuerProblem("https://sso.workforce.vsp-unit.invalid/realms/workforce")).toBeNull();
    expect(issuerProblem("https://sso.workforce.vsp-unit.invalid")).toBeNull();
    const cases: [string, string][] = [
      ["http://sso.workforce.vsp-unit.invalid/realms/workforce", "ISSUER_FORM_INVALID"],
      ["https://sso.workforce.vsp-unit.invalid/realms/workforce/", "ISSUER_TRAILING_SLASH"],
      ["https://sso.workforce.vsp-unit.invalid/realms/workforce?x=1", "ISSUER_FORM_INVALID"],
      ["https://sso.workforce.vsp-unit.invalid/realms/workforce#x", "ISSUER_FORM_INVALID"],
      ["https://user@sso.workforce.vsp-unit.invalid/realms/workforce", "ISSUER_FORM_INVALID"],
      ["https://SSO.workforce.vsp-unit.invalid/realms/workforce", "ISSUER_NOT_CANONICAL"],
      ["https://sso.workforce.vsp-unit.invalid:443/realms/workforce", "ISSUER_NOT_CANONICAL"],
      ["https://sso.workforce.vsp-unit.invalid/realms/../admin", "ISSUER_NOT_CANONICAL"],
      ["https://sso.workforce.vsp-unit.invalid/realms//workforce", "ISSUER_NOT_CANONICAL"],
      ["https://sso.workforce.vsp-unit.invalid/realms/%2e%2e/admin", "ISSUER_NOT_CANONICAL"],
    ];
    for (const [issuer, code] of cases) {
      expect(issuerProblem(issuer), issuer).toBe(code);
      expect(WorkforceSsoConfigSchema.safeParse({ ...base, issuer }).success, issuer).toBe(false);
    }
  });
});

describe("[FO-05-41][FO-01-09] the membership claim cannot be spoofed by group names", () => {
  const roles = { ...base, membershipSource: { kind: "CLIENT_ROLES" }, groupsClaim: "vsp_roles", groupRoles: { supervisor: "supervisor", "security-admin": "security_admin" }, managedGroupPrefix: null };
  it("[FO-05-41] CLIENT_ROLES (the console client's own roles at the IdP) map exactly and every unlisted value refuses; no prefix applies", () => {
    const cfg = parseWorkforceSsoConfig(roles);
    expect(rolesForGroups(cfg, ["supervisor"])).toEqual({ roles: ["supervisor"] });
    expect(rolesForGroups(cfg, ["supervisor", "security-admin"])).toEqual({ roles: ["supervisor", "security_admin"] });
    // A path-shaped value (what a group-path mapping would see for a lookalike top-level group) is not a client role.
    expect(rolesForGroups(cfg, ["supervisor", "/vsp/security-admin"])).toEqual({ refused: "STAFF_GROUP_UNKNOWN" });
    expect(rolesForGroups(cfg, ["retired-role"])).toEqual({ refused: "STAFF_GROUP_UNKNOWN" });
    expect(rolesForGroups(cfg, [])).toEqual({ refused: "STAFF_NOT_PROVISIONED" });
    expect(rolesForGroups(cfg, null)).toEqual({ refused: "STAFF_GROUPS_CLAIM_MISSING" });
    expect(WorkforceSsoConfigSchema.safeParse({ ...roles, managedGroupPrefix: "/vsp/" }).success).toBe(false);
    expect(workforceSsoGuardViolations(cfg, "production")).toEqual([]);
  });

  it("[FO-05-41][FO-01-09] GROUP_PATHS needs the tenant's unambiguous-paths approval; without it the config is refused", () => {
    expect(WorkforceSsoConfigSchema.safeParse({ ...base, membershipSource: { kind: "GROUP_PATHS" } }).success).toBe(false);
    expect(WorkforceSsoConfigSchema.safeParse({ ...base, membershipSource: { kind: "GROUP_PATHS", unambiguousPathsRef: "yes" } }).success).toBe(false);
    const { membershipSource: _drop, ...noSource } = base;
    expect(WorkforceSsoConfigSchema.safeParse(noSource).success).toBe(false);
    expect(workforceSsoGuardViolations(parseWorkforceSsoConfig({ ...base, managedGroupPrefix: null }), "production")).toContain("WORKFORCE_GROUP_PATHS_UNMANAGED@consoleAuth.managedGroupPrefix");
  });
});

describe("[FO-05-18][AUTH-04] session verdict and sealed refresh tokens", () => {
  const now = new Date("2026-10-20T12:00:00.000Z");
  const row = (o: Partial<ConsoleSessionRow>): ConsoleSessionRow =>
    ({
      revokedAt: null,
      rotatedAt: null,
      absoluteExpiresAt: new Date(now.getTime() + 3_600_000),
      lastActivityAt: new Date(now.getTime() - 60_000),
      idleTimeoutSeconds: 900,
      ...o,
    }) as ConsoleSessionRow;

  it("[FO-05-18][AUTH-04] idle, absolute, revoked, rotated and replayed bearers are refused on every use", () => {
    expect(sessionVerdict(null, now, 5)).toMatchObject({ ok: false, reasonCode: "SESSION_INVALID" });
    expect(sessionVerdict(row({}), now, 5).ok).toBe(true);
    expect(sessionVerdict(row({ lastActivityAt: new Date(now.getTime() - 900_001) }), now, 5)).toMatchObject({ reasonCode: "SESSION_IDLE_EXPIRED" });
    expect(sessionVerdict(row({ lastActivityAt: new Date(now.getTime() - 900_000) }), now, 5).ok).toBe(true);
    expect(sessionVerdict(row({ absoluteExpiresAt: now }), now, 5)).toMatchObject({ reasonCode: "SESSION_EXPIRED" });
    expect(sessionVerdict(row({ revokedAt: now }), now, 5)).toMatchObject({ reasonCode: "SESSION_REVOKED" });
    expect(sessionVerdict(row({ rotatedAt: new Date(now.getTime() - 4_000) }), now, 5)).toMatchObject({ reasonCode: "SESSION_ROTATED" });
    expect(sessionVerdict(row({ rotatedAt: new Date(now.getTime() - 6_000) }), now, 5)).toMatchObject({ reasonCode: "SESSION_TOKEN_REPLAYED" });
    expect(newConsoleSessionToken()).toMatch(CONSOLE_SESSION_TOKEN);
  });

  it("[AUTH-03] a sealed refresh token opens only for its own session (AAD) and key; rotation keeps old keys readable", () => {
    const k1 = { id: "sealer-1", key: randomBytes(32) };
    const k2 = { id: "sealer-2", key: randomBytes(32) };
    const s1 = new AesGcmTokenSealer({ current: k1 });
    const sealed = s1.seal("rt_synthRefreshTokenValue", "session-a");
    expect(sealed.ciphertext.toString("utf8")).not.toContain("rt_synth");
    expect(s1.open(sealed, "session-a")).toBe("rt_synthRefreshTokenValue");
    expect(() => s1.open(sealed, "session-b")).toThrow(expect.objectContaining({ reasonCode: "TOKEN_UNSEAL_FAILED" }));
    const tampered = { ...sealed, ciphertext: Buffer.from(sealed.ciphertext.map((b, i) => (i === 0 ? b ^ 1 : b))) };
    expect(() => s1.open(tampered, "session-a")).toThrow(expect.objectContaining({ reasonCode: "TOKEN_UNSEAL_FAILED" }));
    const rotated = new AesGcmTokenSealer({ current: k2, previous: [k1] });
    expect(rotated.open(sealed, "session-a")).toBe("rt_synthRefreshTokenValue");
    expect(rotated.seal("x", "a").keyId).toBe("sealer-2");
    expect(() => new AesGcmTokenSealer({ current: k2 }).open(sealed, "session-a")).toThrow(expect.objectContaining({ reasonCode: "TOKEN_UNSEAL_FAILED" }));
    expect(() => new AesGcmTokenSealer({ current: { id: "short", key: randomBytes(16) } })).toThrow();
  });
});
