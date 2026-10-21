/**
 * Workforce authentication for the console API (spec section 7: workforce SSO,
 * MFA, least privilege; AUTH-02/AUTH-03).
 *
 * - `WorkforceTokenVerifier` verifies the bearer JWT with `jose`: asymmetric
 *   algorithm allowlist, exact issuer and audience, `exp`, `nbf`, `iat`
 *   (bounded token lifetime), `auth_time`, a `jti` (for logout revocation) and
 *   an MFA `amr` value. Tokens without MFA are refused (STAFF_MFA_REQUIRED).
 *   Keys come from a `JWTVerifyGetKey`: the LOCAL FIXTURE workforce IdP's JWKS
 *   offline, the issuer's DISCOVERED JWKS through the egress-classified
 *   transport (`WorkforceTokenVerifier.withKeys` over OidcDiscovery, live), or a
 *   configured JWKS URL (`remoteJwks`). In live composition the verifier checks
 *   the ID token of the backend code exchange (sso.ts) as a second, independent
 *   policy check (audience = the console client id, MFA amr, jti, lifetime).
 * - Staff identity and roles are resolved server-side from a `StaffDirectory`
 *   by (issuer, subject[, groups]); nothing in a request body or query can set
 *   them. Live: `OidcGroupStaffDirectory` (oidc-staff-directory.ts, exact IdP
 *   group -> role mapping, unknown managed groups refused). Offline: the LOCAL
 *   FIXTURE directory of SYNTHETIC staff.
 * - The server keeps no browser storage assumptions: the bearer is presented on
 *   every request and logout revokes its `jti` server-side.
 * - `LocalWorkforceSignInFixture` (local/ci ONLY) issues tokens for SYNTHETIC
 *   staff through `LocalOidcProviderFixture` for `IDP.workforceIssuer`.
 */
import { createLocalJWKSet, createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from "jose";
import type { JWTVerifyGetKey } from "jose";
import { z } from "zod";
import type { LocalOidcProviderFixture } from "../adapters/local/oidc-fixture.js";
import { IDP, STAFF, TENANT_ID } from "../fixtures/synthetic-world.js";
import type { Environment, StaffRole } from "../protocol/index.js";
import { sha256Hex } from "../shared/canonical.js";
import type { Clock } from "../shared/clock.js";
import { ConfigurationRejectedError, DependencyError, ValidationError } from "../shared/errors.js";
import { newId } from "../shared/ids.js";
import { STAFF_ROLES } from "./contract.js";
import type { LocalStaffOption } from "./contract.js";
import { ConsoleHttpError, unauthenticated } from "./errors.js";

/**
 * RFC 8176 authentication-method values and the factor class each one proves. Values that name no factor of their
 * own (mca, rba, geo, user, wia, mfa) are absent: `mfa` is handled by `amrSatisfiesMfa` itself.
 */
export const AMR_FACTOR_CLASS: Readonly<Record<string, "knowledge" | "possession" | "inherence">> = {
  pwd: "knowledge",
  pin: "knowledge",
  kba: "knowledge",
  otp: "possession",
  sms: "possession",
  tel: "possession",
  hwk: "possession",
  swk: "possession",
  sc: "possession",
  pop: "possession",
  face: "inherence",
  fpt: "inherence",
  iris: "inherence",
  retina: "inherence",
  vbm: "inherence",
};

/**
 * Whether an `amr` claim proves multi-factor authentication. With a tenant override (`accepted`, AIN-13) any one of
 * its values suffices (`pwd` is never one: the schemas refuse it). Without one, the DEFAULT rule: the IdP asserts
 * `mfa`, or the values name at least two DISTINCT factor classes (RFC 8176), e.g. pwd + otp or hwk + pin. A single
 * possession value (otp, swk, hwk, pop, sms alone) proves one factor and is never MFA by itself.
 */
export function amrSatisfiesMfa(amr: readonly string[], accepted: readonly string[] | null): boolean {
  if (accepted !== null) return amr.some((a) => a !== "pwd" && accepted.includes(a));
  if (amr.includes("mfa")) return true;
  const classes = new Set(amr.map((a) => (Object.hasOwn(AMR_FACTOR_CLASS, a) ? AMR_FACTOR_CLASS[a] : undefined)).filter((c) => c !== undefined));
  return classes.size >= 2;
}
/** amr marker carried by tokens from the LOCAL FIXTURE workforce IdP; refused outside local/ci. */
export const LOCAL_FIXTURE_AMR = "local_fixture";
export const OFFLINE_ENVIRONMENTS: readonly Environment[] = ["local", "ci"];
export const isOfflineEnvironment = (e: Environment): boolean => OFFLINE_ENVIRONMENTS.includes(e);

export const WORKFORCE_TOKEN_ALGORITHMS = ["ES256", "ES384", "RS256", "PS256", "EdDSA"] as const;
const MAX_BEARER_CHARS = 8192;
const COMPACT_JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export const WorkforceTokenPolicy = z.strictObject({
  issuer: z.string().min(8).max(512),
  audience: z.string().regex(/^[A-Za-z0-9._:-]{3,256}$/),
  algorithms: z.array(z.enum(WORKFORCE_TOKEN_ALGORITHMS)).min(1).max(5),
  clockToleranceSeconds: z.number().int().min(0).max(60),
  /** exp - iat may not exceed this (short-lived console sessions). */
  maxTokenLifetimeSeconds: z.number().int().min(60).max(43_200),
  /** Tenant override of the accepted MFA amr values (AIN-13); null: the default rule of `amrSatisfiesMfa`. */
  acceptedMfaAmr: z.array(z.string().regex(/^[a-z][a-z0-9_]{1,31}$/)).min(1).max(16).nullable(),
  /** True only in local/ci: accept the LOCAL FIXTURE amr marker. */
  allowLocalFixtureAmr: z.boolean(),
});
export type WorkforceTokenPolicy = z.infer<typeof WorkforceTokenPolicy>;

/** Claims the console uses; other IdP claims are dropped and never logged. */
const Claims = z.object({
  iss: z.string().min(1).max(512),
  sub: z.string().min(1).max(255),
  aud: z.union([z.string().min(1).max(512), z.array(z.string().min(1).max(512)).min(1).max(8)]),
  exp: z.number().int().positive(),
  iat: z.number().int().positive(),
  nbf: z.number().int().positive().optional(),
  jti: z.string().min(16).max(128).regex(/^[A-Za-z0-9_.:-]+$/),
  auth_time: z.number().int().positive(),
  amr: z.array(z.string().min(1).max(32)).min(1).max(16),
});

export interface VerifiedWorkforceToken {
  issuer: string;
  subject: string;
  /** sha256 of the token id; the raw jti is not retained. */
  jtiHash: string;
  issuedAt: Date;
  expiresAt: Date;
  authenticatedAt: Date;
  amr: string[];
  localFixture: boolean;
}

export interface WorkforceTokenVerifierOptions {
  kind: "local_fixture" | "live";
  policy: WorkforceTokenPolicy;
  keys: JWTVerifyGetKey;
  clock: Clock;
}

export class WorkforceTokenVerifier {
  readonly kind: "local_fixture" | "live";
  readonly policy: WorkforceTokenPolicy;
  private readonly keys: JWTVerifyGetKey;
  private readonly clock: Clock;

  constructor(opts: WorkforceTokenVerifierOptions) {
    const parsed = WorkforceTokenPolicy.safeParse(opts.policy);
    if (!parsed.success) throw new ValidationError("WORKFORCE_TOKEN_POLICY_INVALID");
    if (opts.kind === "live" && parsed.data.allowLocalFixtureAmr) throw new ValidationError("WORKFORCE_TOKEN_POLICY_INVALID");
    if (parsed.data.acceptedMfaAmr?.includes(LOCAL_FIXTURE_AMR) || parsed.data.acceptedMfaAmr?.includes("pwd")) throw new ValidationError("WORKFORCE_TOKEN_POLICY_INVALID");
    this.kind = opts.kind;
    this.policy = parsed.data;
    this.keys = opts.keys;
    this.clock = opts.clock;
  }

  /**
   * LOCAL FIXTURE verifier over the in-memory workforce IdP fixture's JWKS
   * (re-read on every verification, so key rotation is honoured).
   */
  static localFixture(opts: { idp: LocalOidcProviderFixture; clock: Clock; issuer?: string; audience?: string; maxTokenLifetimeSeconds?: number }): WorkforceTokenVerifier {
    const issuer = opts.issuer ?? IDP.workforceIssuer;
    const keys: JWTVerifyGetKey = (header, token) => createLocalJWKSet(opts.idp.jwks(issuer))(header, token);
    return new WorkforceTokenVerifier({
      kind: "local_fixture",
      clock: opts.clock,
      keys,
      policy: {
        issuer,
        audience: opts.audience ?? IDP.consoleAudience,
        algorithms: ["ES256"],
        clockToleranceSeconds: 5,
        maxTokenLifetimeSeconds: opts.maxTokenLifetimeSeconds ?? 3600,
        acceptedMfaAmr: null,
        allowLocalFixtureAmr: true,
      },
    });
  }

  /**
   * LIVE verifier over an injected key resolver, normally the workforce issuer's discovered JWKS
   * (`OidcDiscovery.keyResolver()`, adapters/live/oidc-discovery.ts) fetched through the
   * egress-classified transport. The audience is the console's OIDC client id (the ID token of the
   * backend exchange) unless a dedicated console audience is configured.
   */
  static withKeys(opts: { issuer: string; audience: string; keys: JWTVerifyGetKey; clock: Clock; acceptedMfaAmr?: readonly string[] | null; algorithms?: (typeof WORKFORCE_TOKEN_ALGORITHMS)[number][]; maxTokenLifetimeSeconds?: number }): WorkforceTokenVerifier {
    return new WorkforceTokenVerifier({
      kind: "live",
      clock: opts.clock,
      keys: opts.keys,
      policy: {
        issuer: opts.issuer,
        audience: opts.audience,
        algorithms: opts.algorithms ?? ["RS256", "ES256"],
        clockToleranceSeconds: 5,
        maxTokenLifetimeSeconds: opts.maxTokenLifetimeSeconds ?? 3600,
        acceptedMfaAmr: opts.acceptedMfaAmr ? [...opts.acceptedMfaAmr] : null,
        allowLocalFixtureAmr: false,
      },
    });
  }

  /**
   * LIVE verifier against a configured JWKS URL (https only, jose remote key set). Prefer `withKeys`
   * over discovery: the JWKS URI then comes from the issuer's own metadata.
   */
  static remoteJwks(opts: { issuer: string; audience: string; jwksUrl: string; clock: Clock; acceptedMfaAmr?: readonly string[] | null; algorithms?: (typeof WORKFORCE_TOKEN_ALGORITHMS)[number][] }): WorkforceTokenVerifier {
    if (!/^https:\/\/[A-Za-z0-9.-]{1,253}(:\d{2,5})?\/[A-Za-z0-9._~/%-]*$/.test(opts.jwksUrl)) throw new ValidationError("WORKFORCE_JWKS_URL_INVALID");
    return new WorkforceTokenVerifier({
      kind: "live",
      clock: opts.clock,
      keys: createRemoteJWKSet(new URL(opts.jwksUrl), { timeoutDuration: 2500, cooldownDuration: 30_000 }),
      policy: {
        issuer: opts.issuer,
        audience: opts.audience,
        algorithms: opts.algorithms ?? ["RS256", "ES256"],
        clockToleranceSeconds: 5,
        maxTokenLifetimeSeconds: 3600,
        acceptedMfaAmr: opts.acceptedMfaAmr ? [...opts.acceptedMfaAmr] : null,
        allowLocalFixtureAmr: false,
      },
    });
  }

  /** Verifies an `Authorization` header value. Throws ConsoleHttpError 401 with a reason code. */
  async verifyAuthorizationHeader(header: string | undefined): Promise<VerifiedWorkforceToken> {
    if (typeof header !== "string" || !header.startsWith("Bearer ")) throw unauthenticated("UNAUTHENTICATED");
    return this.verify(header.slice("Bearer ".length));
  }

  async verify(token: string): Promise<VerifiedWorkforceToken> {
    if (token.length > MAX_BEARER_CHARS || !COMPACT_JWS.test(token)) throw unauthenticated("UNAUTHENTICATED");
    try {
      const alg = decodeProtectedHeader(token).alg;
      if (typeof alg !== "string" || !(this.policy.algorithms as readonly string[]).includes(alg)) throw unauthenticated("UNAUTHENTICATED");
    } catch (err) {
      if (err instanceof ConsoleHttpError) throw err;
      throw unauthenticated("UNAUTHENTICATED");
    }
    const now = this.clock.now();
    let payload: unknown;
    try {
      const result = await jwtVerify(token, this.keys, {
        issuer: this.policy.issuer,
        audience: this.policy.audience,
        algorithms: [...this.policy.algorithms],
        clockTolerance: this.policy.clockToleranceSeconds,
        currentDate: now,
        maxTokenAge: this.policy.maxTokenLifetimeSeconds,
        requiredClaims: ["iss", "sub", "aud", "exp", "iat", "jti", "auth_time", "amr"],
      });
      payload = result.payload;
    } catch (err) {
      throw mapJoseError(err);
    }
    const c = Claims.safeParse(payload);
    if (!c.success) throw unauthenticated("UNAUTHENTICATED");
    const claims = c.data;
    const tolerance = this.policy.clockToleranceSeconds;
    const nowS = Math.floor(now.getTime() / 1000);
    if (claims.exp - claims.iat > this.policy.maxTokenLifetimeSeconds) throw unauthenticated("SESSION_LIFETIME_EXCEEDED");
    if (claims.auth_time > nowS + tolerance || claims.auth_time > claims.iat + tolerance) throw unauthenticated("STAFF_AUTH_TIME_INVALID");
    const fixtureMarked = claims.amr.includes(LOCAL_FIXTURE_AMR);
    if (fixtureMarked && !this.policy.allowLocalFixtureAmr) throw unauthenticated("LOCAL_FIXTURE_TOKEN_REJECTED");
    if (!amrSatisfiesMfa(claims.amr, this.policy.acceptedMfaAmr)) throw unauthenticated("STAFF_MFA_REQUIRED");
    return {
      issuer: claims.iss,
      subject: claims.sub,
      jtiHash: sha256Hex(`console-jti:${claims.jti}`),
      issuedAt: new Date(claims.iat * 1000),
      expiresAt: new Date(claims.exp * 1000),
      authenticatedAt: new Date(claims.auth_time * 1000),
      amr: [...claims.amr],
      localFixture: fixtureMarked || this.kind === "local_fixture",
    };
  }
}

function mapJoseError(err: unknown): ConsoleHttpError {
  if (err instanceof ConsoleHttpError) return err;
  // The discovered key set could not be fetched (IdP down): a dependency failure, never "invalid token".
  if (err instanceof DependencyError) return new ConsoleHttpError(503, "WORKFORCE_IDP_KEYS_UNAVAILABLE", true);
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  const claim = typeof err === "object" && err !== null ? (err as { claim?: unknown }).claim : undefined;
  if (code === "ERR_JWT_EXPIRED") return unauthenticated(claim === "iat" ? "SESSION_LIFETIME_EXCEEDED" : "SESSION_EXPIRED");
  if (code === "ERR_JWT_CLAIM_VALIDATION_FAILED" && claim === "nbf") return unauthenticated("SESSION_NOT_YET_VALID");
  if (code === "ERR_JWKS_TIMEOUT" || code === "ERR_JWKS_INVALID") return new ConsoleHttpError(503, "WORKFORCE_IDP_KEYS_UNAVAILABLE", true);
  return unauthenticated("UNAUTHENTICATED");
}

/* ------------------------------------------------------------------------ */
/* Staff directory                                                           */
/* ------------------------------------------------------------------------ */

export interface StaffRecord {
  staffId: string;
  tenantId: string;
  /** Neutral role label (never a person's name in fixtures). */
  displayLabel: string;
  roles: StaffRole[];
  active: boolean;
}

/**
 * Trusted mapping from a verified workforce identity (issuer, subject) to the
 * staff member, tenant and roles. Roles are re-read on every request, so a role
 * removed in the directory stops working immediately.
 */
export interface StaffDirectory {
  readonly kind: "local_fixture" | "live";
  /**
   * `groups`: the verified group claim of the IdP (ID token or introspection), when the directory maps
   * IdP groups to roles (live). A directory that keeps its own role records ignores it.
   */
  resolve(identity: { issuer: string; subject: string; groups?: readonly string[] | null }): Promise<StaffRecord | null>;
}

const STAFF_LABELS: Readonly<Record<keyof typeof STAFF, string>> = {
  supervisor: "Synthetic Supervisor",
  agent: "Synthetic Support Agent",
  safety: "Synthetic Safety Responder",
  auditor: "Synthetic Auditor",
  policyApprover: "Synthetic Policy Approver",
  knowledgeEditor: "Synthetic Knowledge Editor",
  deployOperator: "Synthetic Deployment Operator",
  securityAdmin: "Synthetic Security Admin",
};

const StaffRoleEnum = z.enum(STAFF_ROLES);

/** LOCAL FIXTURE staff directory: the SYNTHETIC workforce of platform/src/fixtures/synthetic-world.ts. */
export class LocalStaffDirectoryFixture implements StaffDirectory {
  readonly kind = "local_fixture" as const;
  readonly label = "LOCAL FIXTURE STAFF DIRECTORY — SYNTHETIC STAFF ONLY";
  private readonly bySubject = new Map<string, StaffRecord & { idpSubject: string }>();

  constructor(
    private readonly issuer: string = IDP.workforceIssuer,
    tenantId: string = TENANT_ID,
    extra: readonly (StaffRecord & { idpSubject: string })[] = [],
  ) {
    for (const [key, s] of Object.entries(STAFF) as [keyof typeof STAFF, (typeof STAFF)[keyof typeof STAFF]][]) {
      this.bySubject.set(s.idpSubject, {
        staffId: s.staffId,
        tenantId,
        displayLabel: STAFF_LABELS[key],
        roles: s.roles.map((r) => StaffRoleEnum.parse(r)),
        active: true,
        idpSubject: s.idpSubject,
      });
    }
    for (const e of extra) this.bySubject.set(e.idpSubject, { ...e, roles: [...e.roles] });
  }

  async resolve(identity: { issuer: string; subject: string }): Promise<StaffRecord | null> {
    if (identity.issuer !== this.issuer) return null;
    const s = this.bySubject.get(identity.subject);
    return s ? { staffId: s.staffId, tenantId: s.tenantId, displayLabel: s.displayLabel, roles: [...s.roles], active: s.active } : null;
  }

  /** TEST: change a staff member's directory entry (role removal, deactivation). */
  update(staffId: string, patch: Partial<Pick<StaffRecord, "roles" | "active">>): void {
    for (const s of this.bySubject.values()) if (s.staffId === staffId) Object.assign(s, patch);
  }

  /** SYNTHETIC staff for the local sign-in picker, in directory order. */
  list(): (StaffRecord & { idpSubject: string })[] {
    return [...this.bySubject.values()].map((s) => ({ ...s, roles: [...s.roles] }));
  }

  subjectFor(staffId: string): string | null {
    for (const s of this.bySubject.values()) if (s.staffId === staffId && s.active) return s.idpSubject;
    return null;
  }
}

/* ------------------------------------------------------------------------ */
/* Local sign-in (local/ci only)                                             */
/* ------------------------------------------------------------------------ */

export interface LocalWorkforceSignIn {
  readonly kind: "local_fixture";
  staff(): LocalStaffOption[];
  issueToken(staffId: string): Promise<{ accessToken: string; expiresAt: Date } | null>;
}

/**
 * LOCAL FIXTURE sign-in: the local workforce IdP fixture authenticates a
 * SYNTHETIC staff member (amr `local_fixture` + `mfa`) and issues a short-lived
 * token for the console audience. Refuses to exist outside local/ci (OPS-04).
 */
export class LocalWorkforceSignInFixture implements LocalWorkforceSignIn {
  readonly kind = "local_fixture" as const;
  readonly label = "LOCAL DEV SIGN-IN — SYNTHETIC STAFF, LOCAL FIXTURE IDP";

  constructor(
    private readonly opts: {
      environment: Environment;
      idp: LocalOidcProviderFixture;
      directory: LocalStaffDirectoryFixture;
      clock: Clock;
      issuer?: string;
      audience?: string;
      ttlSeconds?: number;
    },
  ) {
    if (!isOfflineEnvironment(opts.environment)) throw new ConfigurationRejectedError(["CONSOLE_LOCAL_SIGN_IN_OUTSIDE_OFFLINE@console.localSignIn"]);
    const ttl = opts.ttlSeconds ?? 900;
    if (!Number.isInteger(ttl) || ttl < 60 || ttl > 3600) throw new ValidationError("LOCAL_SIGN_IN_TTL_INVALID");
  }

  staff(): LocalStaffOption[] {
    return this.opts.directory.list().filter((s) => s.active).map((s) => ({ staffId: s.staffId, displayLabel: s.displayLabel, roles: [...s.roles] }));
  }

  async issueToken(staffId: string): Promise<{ accessToken: string; expiresAt: Date } | null> {
    const subject = this.opts.directory.subjectFor(staffId);
    if (!subject) return null;
    const ttl = this.opts.ttlSeconds ?? 900;
    const nowS = Math.floor(this.opts.clock.now().getTime() / 1000);
    const accessToken = await this.opts.idp.issueIdToken({
      issuer: this.opts.issuer ?? IDP.workforceIssuer,
      sub: subject,
      nonce: newId("non"),
      audience: this.opts.audience ?? IDP.consoleAudience,
      amr: [LOCAL_FIXTURE_AMR, "mfa"],
      authTime: nowS,
      issuedAt: nowS,
      ttlSeconds: ttl,
    });
    return { accessToken, expiresAt: new Date((nowS + ttl) * 1000) };
  }
}

/** Defensive helper: roles from a directory record, de-duplicated and restricted to the protocol set. */
export function normalizeRoles(roles: readonly string[]): StaffRole[] {
  const out: StaffRole[] = [];
  for (const r of roles) {
    const p = StaffRoleEnum.safeParse(r);
    if (p.success && !out.includes(p.data)) out.push(p.data);
  }
  return out.slice(0, 8);
}
