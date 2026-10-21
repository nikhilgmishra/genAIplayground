/**
 * LOCAL TEST FIXTURE — in-process workforce OIDC provider behind the console's `WorkforceOidcPort`
 * (sso.ts). Unit tests only: it models the provider behaviour the console relies on (single-use
 * authorization codes bound to the PKCE challenge and redirect, nonce echo, rotating refresh tokens with
 * reuse detection that revokes the family, introspection of disabled users, an absent groups claim for a
 * user without groups, revocation, outage) so the
 * console flow can be tested without Docker. The live path is adapters/live/oidc-client.ts against a real
 * provider (Layer-2 suite platform/test/integration/identity, Keycloak). SYNTHETIC identities only.
 */
import { createHash, randomBytes } from "node:crypto";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import type { JSONWebKeySet, JWTVerifyGetKey } from "jose";

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
import type { Clock } from "../../shared/clock.js";
import { AccessDeniedError, DependencyError } from "../../shared/errors.js";
import { sha256Hex } from "../../shared/canonical.js";
import type { WorkforceOidcPort, WorkforceTokenSet } from "../sso.js";

export const WORKFORCE_FIXTURE_LABEL = "LOCAL TEST FIXTURE — workforce OIDC provider (SYNTHETIC identities)";
export const WORKFORCE_FIXTURE_ISSUER = "https://idp.workforce-fixture.test/realms/workforce";
export const WORKFORCE_FIXTURE_CLIENT_ID = "vsp-console";
export const WORKFORCE_FIXTURE_REDIRECT = "https://console.vsp-local.test/auth/callback";
/** A second allowlisted redirect (a callback bound to one redirect must not be redeemable at the other). */
export const WORKFORCE_FIXTURE_REDIRECT_ALT = "https://console-alt.vsp-local.test/auth/callback";

export interface FixtureWorkforceUser {
  subject: string;
  groups: string[];
  active: boolean;
  amr: string[];
}

interface PendingAuthorization {
  redirectUri: string;
  nonce: string;
  codeChallenge: string;
}

interface IssuedCode extends PendingAuthorization {
  subject: string;
  authTime: number;
  used: boolean;
}

interface RefreshRecord {
  subject: string;
  familyId: string;
  authTime: number;
  nonce: string;
  state: "ACTIVE" | "ROTATED" | "REVOKED";
}

const s256 = (verifier: string): string => createHash("sha256").update(verifier).digest("base64url");

/**
 * The groups claim as Keycloak 26 emits it (Layer-2 finding): absent, not `[]`, for a user without any group,
 * in the ID token and in token introspection alike. The console must read an absent claim as "no groups".
 */
const claimedGroups = (user: FixtureWorkforceUser | undefined): string[] | null => (user && user.groups.length > 0 ? [...user.groups] : null);

export class LocalWorkforceOidcFixture implements WorkforceOidcPort {
  readonly kind = "local_fixture" as const;
  readonly label = WORKFORCE_FIXTURE_LABEL;
  readonly users = new Map<string, FixtureWorkforceUser>();
  /** IDP_UNAVAILABLE unit seam: every provider call fails as a dependency failure while set. */
  unavailable = false;
  /** Next refresh returns an ID token for this subject instead (subject-switch adversary). */
  switchSubjectOnRefresh: string | null = null;
  /**
   * Adversary: the port does NOT apply the expected-subject check itself (a defective or substituted
   * adapter), so the service's own same-actor check is the only defence left.
   */
  skipExpectedSubjectCheck = false;
  /** Adversary: introspection reports this subject instead of the token's own (a substituted token or adapter). */
  introspectAs: string | null = null;
  /**
   * Two console sign-ins that share ONE IdP session (one browser): revoking one refresh token then ends every refresh
   * token of that subject. Off by default, as on Keycloak 26 for two browsers (Layer-2 probe K1): RFC 7009
   * revocation of one sign-in's refresh token leaves the user's other IdP sessions active.
   */
  revokeEndsUserSession = false;
  /** Race seam: awaited once at the start of the next introspection, before the provider computes its answer. */
  beforeIntrospect: (() => Promise<void>) | null = null;
  /** Race seam: awaited once after the next introspection computed its answer, before that answer is returned. */
  afterIntrospect: ((answer: { active: boolean }) => Promise<void>) | null = null;
  /** Race seam: awaited once after the next refresh redeemed (rotated) the old token, before the new tokens return. */
  afterRefreshRedeemed: (() => Promise<void>) | null = null;
  /**
   * Race seam: awaited once at the start of the next refresh, before the provider is reached (nothing redeemed yet;
   * `unavailable` set meanwhile makes that refresh fail as a dependency failure).
   */
  beforeRefresh: (() => Promise<void>) | null = null;
  readonly calls: string[] = [];
  /** max_age of the last authorization request (null when none was sent). */
  lastMaxAgeSeconds: number | null = null;
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly codes = new Map<string, IssuedCode>();
  private readonly refreshTokens = new Map<string, RefreshRecord>();

  private constructor(
    private readonly clock: Clock,
    private readonly privateKey: SigningKey,
    private readonly publicJwks: JSONWebKeySet,
    readonly issuer: string,
    readonly clientId: string,
  ) {}

  static async create(opts: { clock: Clock; issuer?: string; clientId?: string }): Promise<LocalWorkforceOidcFixture> {
    const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
    const jwk = { ...(await exportJWK(publicKey)), kid: `wf-fixture-${randomBytes(6).toString("hex")}`, alg: "ES256", use: "sig" };
    return new LocalWorkforceOidcFixture(opts.clock, privateKey, { keys: [jwk] }, opts.issuer ?? WORKFORCE_FIXTURE_ISSUER, opts.clientId ?? WORKFORCE_FIXTURE_CLIENT_ID);
  }

  keyResolver(): JWTVerifyGetKey {
    return createLocalJWKSet(this.publicJwks);
  }

  addUser(user: FixtureWorkforceUser): void {
    this.users.set(user.subject, { ...user, groups: [...user.groups], amr: [...user.amr] });
  }

  private gate(op: string): void {
    this.calls.push(op);
    if (this.unavailable) throw new DependencyError("OIDC_PROVIDER_UNAVAILABLE", "NOT_STARTED", true);
  }

  private nowS(): number {
    return Math.floor(this.clock.now().getTime() / 1000);
  }

  async health(): Promise<{ healthy: boolean; reasonCode: string | null }> {
    return this.unavailable ? { healthy: false, reasonCode: "OIDC_PROVIDER_UNAVAILABLE" } : { healthy: true, reasonCode: null };
  }

  async authorizationRequest(input: { redirectUri: string; state: string; nonce: string; codeChallenge: string; scopes: readonly string[]; prompt?: "login" | "consent" | null; maxAgeSeconds?: number | null }): Promise<{ url: string }> {
    this.gate("authorize");
    this.pending.set(input.state, { redirectUri: input.redirectUri, nonce: input.nonce, codeChallenge: input.codeChallenge });
    this.lastMaxAgeSeconds = input.maxAgeSeconds ?? null;
    const url = new URL(`${this.issuer}/protocol/openid-connect/auth`);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: this.clientId,
      redirect_uri: input.redirectUri,
      scope: input.scopes.join(" "),
      state: input.state,
      nonce: input.nonce,
      code_challenge: input.codeChallenge,
      code_challenge_method: "S256",
      ...(input.prompt ? { prompt: input.prompt } : {}),
      ...(input.maxAgeSeconds !== undefined && input.maxAgeSeconds !== null ? { max_age: String(input.maxAgeSeconds) } : {}),
    }).toString();
    return { url: url.toString() };
  }

  /** The browser's sign-in at the provider: returns the authorization code for a pending request. */
  login(authorizationUrl: string, subject: string): { code: string; state: string } {
    const state = new URL(authorizationUrl).searchParams.get("state") ?? "";
    const p = this.pending.get(state);
    const user = this.users.get(subject);
    if (!p || !user) throw new AccessDeniedError("FIXTURE_LOGIN_REFUSED");
    this.pending.delete(state);
    const code = randomBytes(24).toString("base64url");
    this.codes.set(code, { ...p, subject, authTime: this.nowS(), used: false });
    return { code, state };
  }

  private async idToken(subject: string, nonce: string, authTime: number): Promise<string> {
    const user = this.users.get(subject);
    const iat = this.nowS();
    // Like Keycloak: the groups claim is OMITTED (not an empty array) for a user without groups.
    const groups = user && user.groups.length > 0 ? { groups: [...user.groups] } : {};
    return new SignJWT({ nonce, auth_time: authTime, amr: user?.amr ?? ["pwd"], ...groups, azp: this.clientId })
      .setProtectedHeader({ alg: "ES256", kid: this.publicJwks.keys[0]?.kid ?? "wf", typ: "JWT" })
      .setIssuer(this.issuer)
      .setSubject(subject)
      .setAudience(this.clientId)
      .setIssuedAt(iat)
      .setExpirationTime(iat + 300)
      .setJti(randomBytes(16).toString("hex"))
      .sign(this.privateKey);
  }

  private async tokenSet(subject: string, nonce: string, authTime: number, familyId: string): Promise<WorkforceTokenSet> {
    const user = this.users.get(subject);
    const refreshToken = randomBytes(32).toString("base64url");
    this.refreshTokens.set(refreshToken, { subject, familyId, authTime, nonce, state: "ACTIVE" });
    return {
      idToken: { issuer: this.issuer, subject, authTime, amr: [...(user?.amr ?? [])], nonceHash: sha256Hex(nonce), groups: claimedGroups(user) },
      idTokenJwt: await this.idToken(subject, nonce, authTime),
      refreshToken,
      refreshTokenExpiresAt: new Date((this.nowS() + 1800) * 1000),
    };
  }

  async exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string; nonceSha256: string; maxAuthAgeSeconds: number }): Promise<WorkforceTokenSet> {
    this.gate("token:authorization_code");
    const c = this.codes.get(input.code);
    // RFC 6749 4.1.2: a code is single use; RFC 7636 4.6: the verifier must match the challenge.
    if (!c || c.used || c.redirectUri !== input.redirectUri || s256(input.codeVerifier) !== c.codeChallenge) throw new AccessDeniedError("OIDC_GRANT_INVALID");
    c.used = true;
    const user = this.users.get(c.subject);
    if (!user?.active) throw new AccessDeniedError("OIDC_GRANT_INVALID");
    if (sha256Hex(c.nonce) !== input.nonceSha256) throw new AccessDeniedError("OIDC_NONCE_MISMATCH");
    return this.tokenSet(c.subject, c.nonce, c.authTime, randomBytes(8).toString("hex"));
  }

  async refresh(input: { refreshToken: string; expected: { isSameSubject: (subject: string) => boolean; authTime: number | null; nonceHash: string | null } }): Promise<WorkforceTokenSet> {
    const before = this.beforeRefresh;
    this.beforeRefresh = null;
    if (before) await before();
    this.gate("token:refresh_token");
    const r = this.refreshTokens.get(input.refreshToken);
    if (!r || r.state !== "ACTIVE" || !this.users.get(r.subject)?.active) {
      // Reuse of a rotated token revokes the whole family (provider-side replay detection).
      if (r?.state === "ROTATED") for (const x of this.refreshTokens.values()) if (x.familyId === r.familyId) x.state = "REVOKED";
      throw new AccessDeniedError("OIDC_GRANT_INVALID");
    }
    r.state = "ROTATED";
    const hook = this.afterRefreshRedeemed;
    this.afterRefreshRedeemed = null;
    if (hook) await hook();
    const subject = this.switchSubjectOnRefresh ?? r.subject;
    this.switchSubjectOnRefresh = null;
    if (!this.skipExpectedSubjectCheck && !input.expected.isSameSubject(subject)) throw new AccessDeniedError("OIDC_SUBJECT_CHANGED");
    return this.tokenSet(subject, r.nonce, r.authTime, r.familyId);
  }

  async introspect(token: string): Promise<{ active: boolean; subject: string | null; groups: string[] | null; expiresAt: Date | null }> {
    this.gate("introspect");
    const hook = this.beforeIntrospect;
    this.beforeIntrospect = null;
    if (hook) await hook();
    const r = this.refreshTokens.get(token);
    const user = r ? this.users.get(r.subject) : undefined;
    const answer: { active: boolean; subject: string | null; groups: string[] | null; expiresAt: Date | null } =
      !r || r.state !== "ACTIVE" || !user?.active ? { active: false, subject: null, groups: null, expiresAt: null } : { active: true, subject: this.introspectAs ?? r.subject, groups: claimedGroups(user), expiresAt: null };
    const after = this.afterIntrospect;
    this.afterIntrospect = null;
    if (after) await after(answer);
    return answer;
  }

  async revoke(token: string): Promise<void> {
    this.gate("revoke");
    const r = this.refreshTokens.get(token);
    if (r) for (const x of this.refreshTokens.values()) if (x.familyId === r.familyId || (this.revokeEndsUserSession && x.subject === r.subject)) x.state = "REVOKED";
  }

  /** Test helper: the refresh-token family state of a subject (no token values). */
  familyStates(subject: string): string[] {
    return [...this.refreshTokens.values()].filter((r) => r.subject === subject).map((r) => r.state);
  }

  /** Test helper: the state of the family ONE refresh token belongs to (null for a token never issued here). */
  familyStateOf(refreshToken: string): string[] | null {
    const r = this.refreshTokens.get(refreshToken);
    return r ? [...this.refreshTokens.values()].filter((x) => x.familyId === r.familyId).map((x) => x.state) : null;
  }

  /** Test helper: the state of one refresh token (null when never issued here). */
  refreshTokenState(refreshToken: string): RefreshRecord["state"] | null {
    return this.refreshTokens.get(refreshToken)?.state ?? null;
  }
}

/** PKCE pair the console browser would generate (RFC 7636, S256). */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: s256(verifier) };
}
