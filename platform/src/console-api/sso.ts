/**
 * Workforce SSO for the console (WP-05; follow-on FO-01-09, FO-03-28, FO-05-09, FO-05-10, FO-05-11,
 * FO-05-13, FO-05-18, FO-05-19, FO-05-41, FO-14-02, FO-14-52, FO-01-31; AUTH-02, AUTH-03, AUTH-04, AUTH-06).
 *
 * Flow (authorization code + PKCE, backend exchange; IdP tokens never reach the browser):
 *   start     the browser sends its S256 code challenge and the redirect URI it will use. The redirect
 *             must be in the exact allowlist (FO-05-13). The backend creates the nonce and a SEALED state
 *             (login-state.ts: nonce hash, challenge, redirect digest, issue time and lifetime, HMAC under a key
 *             outside the database, bound to tenant and issuer) and returns the authorization URL built from the
 *             DISCOVERED endpoint, with max_age = maxAuthAgeSeconds so the IdP re-authenticates a user whose IdP
 *             session is older than the exchange accepts. The unauthenticated start writes nothing: an anonymous
 *             flood of starts consumes no capacity a legitimate sign-in needs (STRIDE D).
 *   exchange  the browser posts code, state, code_verifier and redirect URI. Before the IdP is contacted:
 *             the redirect is allowlisted, the state opens under the key (a forged, altered, foreign or expired
 *             state is refused), its single use is recorded (a replayed callback is refused), the redirect equals
 *             the sealed one, and S256(verifier) equals the sealed challenge. Then the backend redeems the code at
 *             the token endpoint (the IdP checks the
 *             code, the verifier and the redirect again: a replayed code is refused there too), validates
 *             the ID token (signature, iss, aud, nonce, auth_time, at_hash) and checks it once more with the
 *             workforce verifier (MFA amr: `amrSatisfiesMfa`, jti, lifetime), maps the membership claim (by
 *             default the console client's own IdP roles, never group names: sso-config.ts) to staff roles (an
 *             unknown managed value refused) and issues an opaque console session (`vcs_`), audited in the same
 *             transaction as the session row.
 *   request   every authenticated call presents the console bearer. `authenticate` enforces revocation,
 *             rotation replay, absolute expiry and IDLE expiry (`lastActivityAt` + idle timeout, FO-05-18)
 *             on every use, records activity at a bounded write rate, and at a bounded interval asks the IdP
 *             whether the user is still active (RFC 7662 introspection of the sealed refresh token): a
 *             disabled, deleted or logged-out user loses the session (STAFF_DEPROVISIONED, FO-14-52), the
 *             groups are re-mapped every time (an absent groups claim is an empty set, so a user removed
 *             from every managed group loses the session: STAFF_NOT_PROVISIONED) and role changes in the
 *             IdP take effect. When the IdP cannot answer, the session keeps working only within
 *             `activeCheckMaxStalenessSeconds`, then fails closed.
 *   refresh   the backend redeems the sealed refresh token (rotation); the refreshed ID token must carry
 *             the same (iss, sub): a different subject revokes the whole session family and fails closed
 *             (FO-05-19, never a silent switch). The console bearer is rotated too: the old bearer is
 *             superseded atomically, and presenting it later revokes the family (replay). Refresh is not
 *             user activity: it never extends the idle window and never the absolute lifetime.
 *   logout    revokes the session family and its IdP refresh token (RFC 7009, best effort); first it asks the IdP
 *             (best effort) whether that token is still active, and that answer decides about the person (below).
 *             RFC 7009 revocation ends that one token family only: the IdP keeps the user's other sessions (other
 *             browsers) active (Keycloak 26, Layer-2 probe K1), so one sign-in's logout says nothing about another.
 *   custodians a staff member's dual-controlled recovery identities follow the IdP (FO-14-51, FO-14-52) and the rule
 *             fails closed (sessions.ts `closeFamily`): every TERMINAL path of an SSO session family (logout, a refused
 *             refresh, the replay closure, an idle or absolute expiry closure, the active check's revocation) asks the
 *             IdP or uses the IdP's own answer, and decides once, under a lock on the family's rows, in the same
 *             transaction as the revocation and its audit events. Only a positive answer (the IdP vouches for this
 *             subject now, with mapped roles) keeps a custodian's identities, and only those its roles still cover
 *             (CUSTODIAN_ROLES_REDUCED otherwise); an inactive or refused token suspends them (CUSTODIAN_OFFBOARDED),
 *             and so does no answer at all (IdP unreachable, timeout, adapter refusal, no refresh token:
 *             CUSTODIAN_EVIDENCE_LOST). Nothing explains an inactive token away (not its known expiry, not the row's
 *             own refresh, not another sign-in's logout): a family whose token the IdP no longer honours suspends the
 *             custodian, reinstated by their next MFA sign-in whose roles cover the identity. A family another terminal
 *             path already closed decides nothing more on a token state (that path decided with its own answer and
 *             revoked the token); an answer about the person (another subject, no mapped role) always suspends. The
 *             only non-terminal case is a request whose active check lost a refresh race on a live family (its row was
 *             rotated by a committed refresh, or a refresh of it is in flight within REFRESH_IN_FLIGHT_SECONDS): it is
 *             refused `SESSION_ROTATED` (retryable), closes nothing, and the refresh decides by its own outcome.
 *             A terminal path whose transaction fails because its audit events cannot be written applies the same
 *             decision without them and appends them on their own (`closeUnaudited`, errors logged): it only tightens,
 *             so an audit outage never keeps a replayed or offboarded family live.
 *
 * Reason codes only; no token, code, state, nonce or IdP subject is ever logged or returned.
 */
import { randomBytes } from "node:crypto";
import type { AuditWriter } from "../audit/ports.js";
import { AnonymousAuditBudget, suppressedEvidence } from "./anonymous-audit.js";
import type { AnonymousAuditBudgetOptions } from "./anonymous-audit.js";
import type { Logger } from "../observability/ports.js";
import { OIDC_REFRESH_MAX_REQUESTS, OIDC_REQUEST_TIMEOUT_MAX_MS } from "../protocol/index.js";
import type { AuditEventInput, StaffRole } from "../protocol/index.js";
import { constantTimeEqualHex, sha256Hex } from "../shared/canonical.js";
import type { Clock } from "../shared/clock.js";
import { AccessDeniedError, ConfigurationRejectedError, DependencyError, PlatformError } from "../shared/errors.js";
import { newId } from "../shared/ids.js";
import { amrSatisfiesMfa } from "./auth.js";
import type { StaffRecord, VerifiedWorkforceToken } from "./auth.js";
import { ConsoleHttpError, badRequest, unauthenticated, unavailable } from "./errors.js";
import { openLoginState, redirectDigestOf, sealLoginState } from "./login-state.js";
import type { OidcGroupStaffDirectory } from "./oidc-staff-directory.js";
import { recoverySessionSubjectDigest } from "./recovery.js";
import {
  CONSOLE_SESSION_TOKEN,
  consoleSessionHash,
  issuerDigestOf,
  newConsoleSessionToken,
  newSessionFamilyId,
  nonceHashOf,
  sessionVerdict,
  stateHashOf,
  subjectDigestOf,
} from "./sessions.js";
import type { ConsoleSessionRow, CustodianAnswer, CustodianAudit, FamilyCloseInput, FamilyCloseOutcome, FamilyCloseResult, NewSession, PgConsoleSessionStore } from "./sessions.js";
import { rolesForGroups } from "./sso-config.js";
import type { WorkforceSsoConfig } from "./sso-config.js";
import { consoleAuditInput } from "./stores.js";
import type { TokenSealer } from "./token-sealer.js";

/** The ID-token facts the console uses (from adapters/live/oidc-client.ts VerifiedIdToken). */
export interface WorkforceIdTokenFacts {
  issuer: string;
  subject: string;
  authTime: number | null;
  amr: string[];
  nonceHash: string | null;
  groups: string[] | null;
}

export interface WorkforceTokenSet {
  idToken: WorkforceIdTokenFacts;
  idTokenJwt: string;
  refreshToken: string | null;
  refreshTokenExpiresAt: Date | null;
}

/**
 * The OIDC relying-party client the console needs (structural port; the live OidcRelyingPartyClient of
 * adapters/live/oidc-client.ts satisfies it, wired by the composition root).
 */
export interface WorkforceOidcPort {
  readonly kind: "local_fixture" | "live";
  readonly clientId: string;
  readonly issuer: string;
  authorizationRequest(input: { redirectUri: string; state: string; nonce: string; codeChallenge: string; scopes: readonly string[]; prompt?: "login" | "consent" | null; maxAgeSeconds?: number | null }): Promise<{ url: string }>;
  exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string; nonceSha256: string; maxAuthAgeSeconds: number }): Promise<WorkforceTokenSet>;
  refresh(input: { refreshToken: string; expected: { isSameSubject: (subject: string) => boolean; authTime: number | null; nonceHash: string | null } }): Promise<WorkforceTokenSet>;
  introspect(token: string, hint: "refresh_token" | "access_token"): Promise<{ active: boolean; subject: string | null; groups: string[] | null; expiresAt: Date | null }>;
  revoke(token: string, hint: "refresh_token" | "access_token"): Promise<void>;
  health(): Promise<{ healthy: boolean; reasonCode: string | null }>;
}

/** Second, independent check of the ID token (WorkforceTokenVerifier: MFA amr, jti, lifetime, audience). */
export interface WorkforceIdTokenPolicyCheck {
  readonly kind: "local_fixture" | "live";
  verify(token: string): Promise<VerifiedWorkforceToken>;
}

export interface WorkforceSsoDeps {
  config: WorkforceSsoConfig;
  oidc: WorkforceOidcPort;
  directory: OidcGroupStaffDirectory;
  verifier: WorkforceIdTokenPolicyCheck;
  sessions: PgConsoleSessionStore;
  sealer: TokenSealer;
  audit: AuditWriter;
  clock: Clock;
  logger: Logger;
  /** Bound on audit events caused by anonymous exchange refusals (anonymous-audit.ts; defaults apply). */
  anonymousAudit?: Partial<AnonymousAuditBudgetOptions>;
}

/** Server-established identity of a console SSO request. */
export interface SsoIdentity {
  kind: "OIDC_SSO" | "RECOVERY";
  sessionHash: string;
  familyId: string;
  generation: number;
  tenantId: string;
  staffId: string;
  roles: StaffRole[];
  authenticatedAt: Date;
  /** The earlier of the absolute expiry and the current idle deadline. */
  sessionExpiresAt: Date;
  idleTimeoutSeconds: number;
}

export interface SsoStartResult {
  authorizationUrl: string;
  state: string;
  expiresAt: Date;
}

export interface SsoTokenResult {
  token: string;
  expiresAt: Date;
  idleTimeoutSeconds: number;
  staffId: string;
  roles: StaffRole[];
}

/** The IdP's answer about the person behind a session (`askIdp`): a custodian answer plus why there is none. */
type IdpAnswer =
  | { kind: "ACTIVE"; roles: StaffRole[] }
  | { kind: "PERSON_REFUSED"; reasonCode: "SESSION_SUBJECT_CHANGED" | "STAFF_GROUP_UNKNOWN" | "STAFF_NOT_PROVISIONED" }
  | { kind: "TOKEN_INACTIVE" }
  | { kind: "NO_ANSWER"; unreachable: boolean; reasonCode: string };

/** No IdP answer (a family another terminal path already closed, or none could be obtained). */
const NO_ANSWER: IdpAnswer = { kind: "NO_ANSWER", unreachable: false, reasonCode: "NO_IDP_ANSWER" };

/**
 * How long a refresh of one row may be in flight: the IdP part of one refresh at the OIDC transport's maximum
 * per-request deadline (OIDC_REFRESH_MAX_REQUESTS sequential requests, OIDC_REQUEST_TIMEOUT_MAX_MS each: 150 s) plus a
 * 30 s margin for the console's own database work (180 s). While a refresh is in flight, a second refresh of the row is
 * refused and a request whose active check sees the token inactive is refused retryable; after it, a crashed refresh's
 * claim lapses and the active check decides. The window bounds the IdP requests, not a paused process or a database
 * wait beyond the margin: a refresh still running after it lets a second refresh of the row reach the IdP; whichever
 * of the two presents the token the IdP has already redeemed is refused, so the family closes and the custodian is
 * suspended (availability only, never fail open; unit case in break-glass.test.ts, verifier probe P3).
 */
export const REFRESH_IN_FLIGHT_SECONDS = Math.ceil((OIDC_REFRESH_MAX_REQUESTS * OIDC_REQUEST_TIMEOUT_MAX_MS) / 1000) + 30;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

const s256 = (verifier: string): string => sha256Base64Url(verifier);
function sha256Base64Url(s: string): string {
  return Buffer.from(sha256Hex(s), "hex").toString("base64url");
}

/** True when an Authorization header carries a console session bearer (not a JWT). */
export function isConsoleSessionHeader(header: string | undefined): boolean {
  return typeof header === "string" && header.startsWith("Bearer ") && CONSOLE_SESSION_TOKEN.test(header.slice("Bearer ".length));
}

export class WorkforceSsoService {
  readonly kind: "local_fixture" | "live";
  private readonly d: WorkforceSsoDeps;
  private readonly log: Logger;
  private readonly anonymousBudget: AnonymousAuditBudget;

  constructor(deps: WorkforceSsoDeps) {
    if (deps.oidc.issuer !== deps.config.issuer || deps.oidc.clientId !== deps.config.clientId) throw new AccessDeniedError("WORKFORCE_SSO_CLIENT_MISMATCH");
    this.d = deps;
    this.kind = deps.oidc.kind === "live" && deps.verifier.kind === "live" ? "live" : "local_fixture";
    this.log = deps.logger.child({ component: "console_sso" });
    this.anonymousBudget = new AnonymousAuditBudget(deps.clock, deps.anonymousAudit);
  }

  get config(): WorkforceSsoConfig {
    return this.d.config;
  }

  private now(): Date {
    return this.d.clock.now();
  }

  private allowlisted(redirectUri: string): boolean {
    // Exact string membership; the config guard already refused non-canonical entries.
    return this.d.config.redirectUris.includes(redirectUri);
  }

  private loginBinding(): { tenantId: string; issuerDigest: string } {
    return { tenantId: this.d.config.tenantId, issuerDigest: issuerDigestOf(this.d.config.issuer) };
  }

  /**
   * Starts an authorization request bound by a sealed state (nonce, PKCE challenge, exact redirect, lifetime). Writes
   * nothing (the endpoint is unauthenticated); asks the IdP to re-authenticate beyond `maxAuthAgeSeconds` (max_age).
   */
  async start(input: { redirectUri: string; codeChallenge: string }): Promise<SsoStartResult> {
    if (!this.allowlisted(input.redirectUri)) throw badRequest("REDIRECT_URI_NOT_ALLOWED");
    if (!CHALLENGE.test(input.codeChallenge)) throw badRequest("PKCE_CHALLENGE_INVALID");
    // Whole seconds: the sealed issue time is in seconds, and the returned expiry is exactly the sealed one.
    const issuedAt = new Date(Math.floor(this.now().getTime() / 1000) * 1000);
    const ttlSeconds = this.d.config.loginTransactionTtlSeconds;
    const nonce = randomBytes(32).toString("base64url");
    const state = sealLoginState(this.d.sealer, this.loginBinding(), { nonceHash: nonceHashOf(nonce), codeChallenge: input.codeChallenge, redirectUri: input.redirectUri, issuedAt, ttlSeconds });
    let url: string;
    try {
      url = (
        await this.d.oidc.authorizationRequest({ redirectUri: input.redirectUri, state, nonce, codeChallenge: input.codeChallenge, scopes: this.d.config.scopes, maxAgeSeconds: this.d.config.maxAuthAgeSeconds })
      ).url;
    } catch (err) {
      throw this.providerError(err);
    }
    return { authorizationUrl: url, state, expiresAt: new Date(issuedAt.getTime() + ttlSeconds * 1000) };
  }

  /**
   * Backend code exchange. Every refusal before the IdP is contacted leaves the IdP untouched. A refusal no
   * verified identity stands behind (before the IdP, the IdP refusing the code, an ID token that fails the
   * independent check) is audited through the anonymous budget (anonymous-audit.ts: bounded per window, the
   * suppressed count carried on the next event); a refusal of an IdP-authenticated person (MFA, groups) is
   * audited per event and attributed to the pseudonymous staff id of that identity. Reason codes only.
   */
  async exchange(input: { code: string; state: string; codeVerifier: string; redirectUri: string; correlationId: string }): Promise<SsoTokenResult> {
    // 1. Redirect allowlist BEFORE anything else (FO-05-13).
    if (!this.allowlisted(input.redirectUri)) throw badRequest("REDIRECT_URI_NOT_ALLOWED");
    if (!VERIFIER.test(input.codeVerifier)) throw unauthenticated("PKCE_VERIFIER_INVALID");
    const now = this.now();
    // 2. The state must be one this backend issued for this tenant and issuer (forged, altered or foreign states are
    //    anonymous noise on an unauthenticated endpoint: logged, never an audit event per request).
    const sealed = openLoginState(this.d.sealer, this.loginBinding(), input.state);
    if (sealed === null) {
      this.log.warn("console.sso.login_state_unknown", { correlationId: input.correlationId, reasonCode: "LOGIN_TRANSACTION_UNAVAILABLE" });
      throw unauthenticated("LOGIN_TRANSACTION_UNAVAILABLE");
    }
    if (now.getTime() >= sealed.expiresAt.getTime()) {
      await this.auditAnonymous(input.correlationId, "console.auth.oidc_exchange", "DENIED", "LOGIN_TRANSACTION_EXPIRED");
      throw unauthenticated("LOGIN_TRANSACTION_UNAVAILABLE");
    }
    // 3. Single use of the state (replayed or raced callbacks stop here); recorded before any other check, so a
    //    callback refused below has spent its state too.
    const used = await this.d.sessions.recordLoginStateUse(
      {
        // Keyed on the canonical encoding of the authenticated bytes (login-state.ts), never on the presented spelling.
        stateHash: stateHashOf(sealed.canonical),
        tenantId: this.d.config.tenantId,
        issuerDigest: issuerDigestOf(this.d.config.issuer),
        nonceHash: sealed.nonceHash,
        codeChallenge: sealed.codeChallenge,
        redirectUri: input.redirectUri,
        createdAt: sealed.issuedAt,
        expiresAt: sealed.expiresAt,
      },
      now,
    );
    if (used === "ALREADY_USED") {
      this.log.warn("console.sso.login_state_reused", { correlationId: input.correlationId, reasonCode: "LOGIN_TRANSACTION_UNAVAILABLE" });
      throw unauthenticated("LOGIN_TRANSACTION_UNAVAILABLE");
    }
    if (redirectDigestOf(input.redirectUri) !== sealed.redirectDigest) return this.refuseExchange(input.correlationId, "REDIRECT_URI_MISMATCH", 400, null);
    if (s256(input.codeVerifier) !== sealed.codeChallenge) return this.refuseExchange(input.correlationId, "PKCE_VERIFIER_MISMATCH", 401, null);
    // 4. The IdP redeems the code (it checks code, verifier and redirect again; a replayed code is refused).
    let tokens: WorkforceTokenSet;
    try {
      // Only the nonce hash travels in the state: the adapter compares the ID token's nonce against it (constant time).
      tokens = await this.d.oidc.exchangeCode({ code: input.code, codeVerifier: input.codeVerifier, redirectUri: input.redirectUri, nonceSha256: sealed.nonceHash, maxAuthAgeSeconds: this.d.config.maxAuthAgeSeconds });
    } catch (err) {
      const e = this.providerError(err);
      await this.auditAnonymous(input.correlationId, "console.auth.oidc_exchange", e.status >= 500 ? "FAILED" : "DENIED", e.reasonCode);
      throw e;
    }
    if (tokens.idToken.nonceHash === null || !constantTimeEqualHex(tokens.idToken.nonceHash, sealed.nonceHash)) return this.refuseExchange(input.correlationId, "OIDC_NONCE_MISMATCH", 401, null);
    return this.issue(tokens, input.correlationId, now);
  }

  private async issue(tokens: WorkforceTokenSet, correlationId: string, now: Date): Promise<SsoTokenResult> {
    // 4. Independent policy check of the same ID token: MFA amr, jti, bounded lifetime, audience.
    let checked: VerifiedWorkforceToken;
    try {
      checked = await this.d.verifier.verify(tokens.idTokenJwt);
    } catch (err) {
      const reason = err instanceof PlatformError ? err.reasonCode : "UNAUTHENTICATED";
      await this.auditAnonymous(correlationId, "console.auth.oidc_exchange", "DENIED", reason);
      throw err instanceof ConsoleHttpError ? err : unauthenticated("UNAUTHENTICATED");
    }
    if (checked.issuer !== tokens.idToken.issuer || checked.subject !== tokens.idToken.subject) return this.refuseExchange(correlationId, "OIDC_TOKEN_INCONSISTENT", 401, null);
    // From here the identity is IdP-authenticated and independently verified: refusals are attributed to it.
    const verifiedStaffId = this.d.directory.staffIdFor(tokens.idToken.issuer, tokens.idToken.subject);
    if (!amrSatisfiesMfa(tokens.idToken.amr, this.d.config.acceptedMfaAmr)) return this.refuseExchange(correlationId, "STAFF_MFA_REQUIRED", 401, verifiedStaffId);
    // 5. Live directory: exact group mapping; unknown managed groups refuse.
    const mapped = this.d.directory.map({ issuer: tokens.idToken.issuer, subject: tokens.idToken.subject, groups: tokens.idToken.groups });
    if ("refused" in mapped) {
      // The IdP authenticated this person and the directory maps them to nothing: an offboarding signal for any
      // recovery identity they hold (CUSTODIAN_OFFBOARDED). The refusal stands whatever happens to that write.
      await this.d.sessions.suspendCustodian(this.d.audit, { tenantId: this.d.config.tenantId, staffId: verifiedStaffId, now, custodian: this.custodianAudit(this.d.config.tenantId, verifiedStaffId, correlationId, now) }).catch((err: unknown) => {
        this.log.error("console.sso.custodian_suspension_failed", { staffId: verifiedStaffId, reasonCode: err instanceof PlatformError ? err.reasonCode : "CUSTODIAN_SUSPENSION_FAILED" });
      });
      return this.refuseExchange(correlationId, mapped.refused === "STAFF_GROUP_UNKNOWN" ? "STAFF_GROUP_UNKNOWN" : "STAFF_NOT_PROVISIONED", 401, verifiedStaffId);
    }
    const staff = mapped.record;
    const token = newConsoleSessionToken();
    const sessionHash = consoleSessionHash(token);
    const policy = this.d.config.session;
    const absoluteExpiresAt = new Date(now.getTime() + policy.absoluteLifetimeSeconds * 1000);
    const authenticatedAt = tokens.idToken.authTime !== null ? new Date(tokens.idToken.authTime * 1000) : checked.authenticatedAt;
    const s: NewSession = {
      sessionHash,
      familyId: newSessionFamilyId(),
      generation: 1,
      kind: "OIDC_SSO",
      tenantId: staff.tenantId,
      staffId: staff.staffId,
      issuerDigest: issuerDigestOf(tokens.idToken.issuer),
      subjectDigest: subjectDigestOf(tokens.idToken.issuer, tokens.idToken.subject),
      roles: staff.roles,
      amr: tokens.idToken.amr.slice(0, 16),
      authenticatedAt,
      authTimeEpoch: tokens.idToken.authTime,
      nonceHash: tokens.idToken.nonceHash,
      createdAt: now,
      lastActivityAt: now,
      idleTimeoutSeconds: policy.idleTimeoutSeconds,
      absoluteExpiresAt,
      activeCheckedAt: now,
      refresh: tokens.refreshToken ? this.d.sealer.seal(tokens.refreshToken, sessionHash) : null,
      refreshExpiresAt: tokens.refreshTokenExpiresAt,
    };
    // Same transaction: the staff member's recovery identities follow the roles mapped now (a SUSPENDED one the
    // roles cover is reinstated by this MFA sign-in; an ACTIVE one they no longer cover is suspended).
    await this.d.sessions.insert(this.d.audit, s, this.auditFor(correlationId, staff, "console.auth.oidc_exchange", "SUCCEEDED", "WORKFORCE_SSO_SIGN_IN", now), this.custodianAudit(staff.tenantId, staff.staffId, correlationId, now));
    this.log.info("console.sso.signed_in", { staffId: staff.staffId, correlationId, reasonCode: "WORKFORCE_SSO_SIGN_IN" });
    return { token, expiresAt: this.deadline(s), idleTimeoutSeconds: policy.idleTimeoutSeconds, staffId: staff.staffId, roles: staff.roles };
  }

  private deadline(row: Pick<ConsoleSessionRow, "absoluteExpiresAt" | "lastActivityAt" | "idleTimeoutSeconds">): Date {
    const idle = row.lastActivityAt.getTime() + row.idleTimeoutSeconds * 1000;
    return new Date(Math.min(idle, row.absoluteExpiresAt.getTime()));
  }

  /** Per-request authentication of a console bearer (AUTH-04: enforced on every use, independent of any TTL). */
  async authenticate(header: string | undefined): Promise<SsoIdentity> {
    if (!isConsoleSessionHeader(header)) throw unauthenticated("UNAUTHENTICATED");
    const token = (header as string).slice("Bearer ".length);
    const hash = consoleSessionHash(token);
    const now = this.now();
    const row = await this.d.sessions.load(this.d.config.tenantId, hash);
    const verdict = sessionVerdict(row, now, this.d.config.session.rotationGraceSeconds);
    if (!verdict.ok) {
      if (verdict.row) await this.closeOnVerdict(verdict.row, verdict.reasonCode, now);
      throw new ConsoleHttpError(401, verdict.reasonCode, verdict.reasonCode === "SESSION_ROTATED");
    }
    let current = verdict.row;
    current = current.kind === "RECOVERY" ? await this.ensureRecoveryIdentity(current, now) : await this.ensureActive(current, now);
    await this.d.sessions.touch(current.tenantId, current.sessionHash, now, this.d.config.session.activityWriteIntervalSeconds);
    const touched = now.getTime() - current.lastActivityAt.getTime() >= this.d.config.session.activityWriteIntervalSeconds * 1000 ? { ...current, lastActivityAt: now } : current;
    return {
      kind: current.kind,
      sessionHash: current.sessionHash,
      familyId: current.familyId,
      generation: current.generation,
      tenantId: current.tenantId,
      staffId: current.staffId,
      roles: [...current.roles],
      authenticatedAt: current.authenticatedAt,
      sessionExpiresAt: this.deadline(touched),
      idleTimeoutSeconds: current.idleTimeoutSeconds,
    };
  }

  /**
   * Closes a session the verdict refused so it can never be used again. An idle or absolute expiry and the replay of
   * a superseded bearer are TERMINAL paths of the family: they decide about the custodian with the IdP's answer
   * (`closeTerminal`). For a replay the IdP is asked about the family's LIVE row (the one the presenter could still
   * use), never the superseded one, whose token the family's own refresh redeemed.
   */
  private async closeOnVerdict(row: ConsoleSessionRow, reason: string, now: Date): Promise<void> {
    if (reason === "SESSION_IDLE_EXPIRED" || reason === "SESSION_EXPIRED") {
      await this.closeExpired(row, reason, now);
    } else if (reason === "SESSION_TOKEN_REPLAYED") {
      // A superseded bearer was presented after the grace: the family is compromised (OAuth BCP refresh reuse).
      const live = await this.d.sessions.liveRowOfFamily(row.tenantId, row.familyId);
      const answer = live ? await this.askIdp(live) : NO_ANSWER;
      await this.closeTerminal(live ?? row, reason, now, answer, { audit: true });
    }
  }

  /** Idle or absolute expiry closure (request or sweep): a RECOVERY row only ends; an SSO family decides first. */
  private async closeExpired(row: ConsoleSessionRow, reason: "SESSION_IDLE_EXPIRED" | "SESSION_EXPIRED", now: Date): Promise<boolean> {
    if (row.kind !== "OIDC_SSO") {
      const closed = await this.d.sessions.revoke(row.tenantId, row.sessionHash, reason, now);
      if (closed) await this.auditSystem(row, "console.auth.session_revoked", reason, now);
      return closed;
    }
    return (await this.closeTerminal(row, reason, now, await this.askIdp(row), { audit: true })) === "CLOSED";
  }

  /**
   * A RECOVERY session is valid only while the recovery identity it was activated with is ACTIVE (FO-14-51),
   * checked on EVERY request (no interval, no IdP involved): its subject digest names that identity. Revoking
   * the identity also revokes the session row (recovery.ts); this check holds even if that write was missed.
   */
  private async ensureRecoveryIdentity(row: ConsoleSessionRow, now: Date): Promise<ConsoleSessionRow> {
    const active = await this.d.sessions.activeRecoveryIdentityIds(row.tenantId, row.staffId);
    if (active.some((id) => recoverySessionSubjectDigest(id) === row.subjectDigest)) return row;
    if (await this.d.sessions.revoke(row.tenantId, row.sessionHash, "RECOVERY_IDENTITY_REVOKED", now)) await this.auditSystem(row, "console.auth.session_revoked", "RECOVERY_IDENTITY_REVOKED", now);
    throw unauthenticated("RECOVERY_IDENTITY_REVOKED");
  }

  /**
   * What the IdP says about the person behind `row` now, from RFC 7662 introspection of its sealed refresh token:
   * ACTIVE with the roles the membership claim maps to (the subject must be the session's), PERSON_REFUSED (another
   * subject, or a membership that maps to no or an unknown role; an absent claim is an EMPTY set), TOKEN_INACTIVE, or
   * NO_ANSWER (`unreachable`: an outage or a configuration the egress policy refuses; otherwise an adapter refusal or
   * no refresh token). Never throws.
   */
  private async askIdp(row: ConsoleSessionRow): Promise<IdpAnswer> {
    if (!row.refresh) return { kind: "NO_ANSWER", unreachable: false, reasonCode: "SESSION_REFRESH_UNAVAILABLE" };
    let result: Awaited<ReturnType<WorkforceOidcPort["introspect"]>>;
    try {
      result = await this.d.oidc.introspect(this.d.sealer.open(row.refresh, row.sessionHash), "refresh_token");
    } catch (err) {
      const unreachable = err instanceof DependencyError || err instanceof ConfigurationRejectedError;
      const reasonCode = err instanceof PlatformError ? err.reasonCode : "OIDC_PROVIDER_UNAVAILABLE";
      this.log.warn("console.sso.idp_answer_unavailable", { staffId: row.staffId, reasonCode });
      return { kind: "NO_ANSWER", unreachable, reasonCode };
    }
    if (!result.active) return { kind: "TOKEN_INACTIVE" };
    // The introspection must describe the session's own subject (a token of another user is never adopted).
    if (result.subject !== null && subjectDigestOf(this.d.config.issuer, result.subject) !== row.subjectDigest) return { kind: "PERSON_REFUSED", reasonCode: "SESSION_SUBJECT_CHANGED" };
    // Group membership is re-mapped on EVERY answer. An absent groups claim is an EMPTY group set, never
    // "unchanged": IdPs (Keycloak among them) omit the claim entirely for a user with no groups, so a user removed
    // from every managed group must lose the session (offboarding by group unassignment, FO-14-52, AUTH-04). An IdP
    // whose introspection response does not carry the claim at all therefore ends every session at its first check:
    // fail closed, see README "Workforce SSO" (configuration requirement).
    const mapped = rolesForGroups(this.d.config, result.groups ?? []);
    if ("refused" in mapped) return { kind: "PERSON_REFUSED", reasonCode: mapped.refused === "STAFF_GROUP_UNKNOWN" ? "STAFF_GROUP_UNKNOWN" : "STAFF_NOT_PROVISIONED" };
    return { kind: "ACTIVE", roles: mapped.roles };
  }

  /**
   * Directory active-state check at a bounded interval (FO-14-52), a non-terminal path until it revokes. The IdP's
   * answer: ACTIVE keeps the session with the re-mapped roles (a reduction suspends the identities it no longer
   * covers); an answer about the person that covers nothing closes the family and suspends; an inactive token (or an
   * adapter refusal) closes the family and suspends, unless the request lost a refresh race on a live family (refused
   * `SESSION_ROTATED`, retryable: the refresh decides) or another terminal path closed it meanwhile (`SESSION_REVOKED`:
   * that path decided). An unreachable IdP keeps the session only within the staleness bound, then fails closed (503,
   * nothing closed).
   */
  private async ensureActive(row: ConsoleSessionRow, now: Date): Promise<ConsoleSessionRow> {
    const policy = this.d.config.session;
    if (row.kind !== "OIDC_SSO") throw unauthenticated("SESSION_INVALID");
    if (now.getTime() - row.activeCheckedAt.getTime() < policy.activeCheckIntervalSeconds * 1000) return row;
    const answer = await this.askIdp(row);
    if (answer.kind === "NO_ANSWER" && (answer.unreachable || !row.refresh)) {
      // The IdP could not be asked (or there is nothing to ask it with): no answer about the user.
      if (now.getTime() - row.activeCheckedAt.getTime() <= policy.activeCheckMaxStalenessSeconds * 1000) return row;
      throw unavailable("STAFF_ACTIVE_STATE_UNVERIFIED");
    }
    if (answer.kind === "PERSON_REFUSED") {
      await this.closeTerminal(row, answer.reasonCode, now, answer, { audit: true });
      throw unauthenticated(answer.reasonCode);
    }
    if (answer.kind === "TOKEN_INACTIVE" || answer.kind === "NO_ANSWER") {
      const outcome = await this.closeTerminal(row, "STAFF_DEPROVISIONED", now, answer, { audit: true, refreshRaceSince: this.refreshInFlightSince(now) });
      // The family's own refresh rotated (or is rotating) this token: the successor is valid, retry with it.
      if (outcome === "REFRESH_RACE") throw new ConsoleHttpError(401, "SESSION_ROTATED", true);
      // Another terminal path (its logout, a refused refresh) closed the family meanwhile and decided.
      if (outcome === "ALREADY_CLOSED") throw unauthenticated("SESSION_REVOKED");
      throw unauthenticated("STAFF_DEPROVISIONED");
    }
    const roles: StaffRole[] = answer.roles;
    // Re-mapped roles that no longer cover a recovery identity suspend it in the same transaction.
    const changed = roles.length !== row.roles.length || roles.some((r) => !row.roles.includes(r));
    await this.d.sessions.markActive(row.tenantId, row.sessionHash, now, roles, changed ? { audit: this.d.audit, staffId: row.staffId, build: this.custodianAudit(row.tenantId, row.staffId, newId("cor"), now) } : undefined);
    return { ...row, activeCheckedAt: now, roles };
  }

  /** A refresh claimed at or after this instant may still be in flight (REFRESH_IN_FLIGHT_SECONDS). */
  private refreshInFlightSince(now: Date): Date {
    return new Date(now.getTime() - REFRESH_IN_FLIGHT_SECONDS * 1000);
  }

  /**
   * A TERMINAL path of `row`'s family: closes the family with `reason` and decides about the staff member's recovery
   * identities by `answer`, in one transaction with the audit events (sessions.ts `closeFamily`); then the refresh
   * tokens of the rows it closed are revoked at the IdP (best effort). Returns what happened to the family.
   */
  private async closeTerminal(row: ConsoleSessionRow, reason: string, now: Date, answer: CustodianAnswer, opts: { audit: boolean; refreshRaceSince?: Date }): Promise<FamilyCloseOutcome> {
    const correlationId = newId("cor");
    const input: FamilyCloseInput = {
      tenantId: row.tenantId,
      familyId: row.familyId,
      sessionHash: row.sessionHash,
      staffId: row.staffId,
      reasonCode: reason,
      now,
      answer: answer.kind === "ACTIVE" ? { kind: "ACTIVE", roles: answer.roles } : { kind: answer.kind },
      sessionAudit: opts.audit
        ? consoleAuditInput({ tenantId: row.tenantId, correlationId, staffId: row.staffId, role: row.roles[0] ?? null, action: "console.auth.session_revoked", outcome: "DENIED", reasonCode: reason, occurredAt: now })
        : null,
      custodian: this.custodianAudit(row.tenantId, row.staffId, correlationId, now),
      ...(opts.refreshRaceSince ? { refreshRaceSince: opts.refreshRaceSince } : {}),
    };
    let out: FamilyCloseResult;
    try {
      out = await this.d.sessions.closeFamily(this.d.audit, input);
    } catch (err) {
      out = await this.closeUnaudited(input, err);
    }
    if (out.custodian.suspended.length > 0) this.log.warn("console.sso.custodian_suspended", { staffId: row.staffId, reasonCode: out.custodian.reason ?? reason });
    for (const c of out.closedRefresh) await this.revokeTokenAtIdp(this.d.sealer.open(c.refresh, c.sessionHash), row.staffId);
    return out.outcome;
  }

  /**
   * The decision's transaction failed (its audit events could not be written, or the database refused the write). A
   * terminal path only tightens: it revokes sessions and suspends recovery identities, it never grants. So the same
   * decision runs again under the same row lock WITHOUT its audit events, rather than leaving open a family the IdP no
   * longer vouches for or a replay showed compromised (fail closed; FO-05-19, FO-14-52). The events are then appended
   * on their own, and an error is logged either way (`console.sso.terminal_closure_unaudited`, plus
   * `console.sso.terminal_audit_unwritten` per event the audit store still refuses). When the second attempt fails too
   * (the database itself is down, so no session can be used either), the original error stands.
   */
  private async closeUnaudited(input: FamilyCloseInput, cause: unknown): Promise<FamilyCloseResult> {
    let out: FamilyCloseResult;
    try {
      out = await this.d.sessions.closeFamily(this.d.audit, { ...input, sessionAudit: null, custodian: () => [] });
    } catch {
      throw cause;
    }
    this.log.error("console.sso.terminal_closure_unaudited", { staffId: input.staffId, reasonCode: cause instanceof PlatformError ? cause.reasonCode : "TERMINAL_CLOSURE_AUDIT_FAILED" });
    const events = [...(out.outcome === "CLOSED" && input.sessionAudit ? [input.sessionAudit] : []), ...input.custodian(out.custodian)];
    for (const ev of events) {
      try {
        await this.d.audit.appendStandalone(ev);
      } catch (err) {
        this.log.error("console.sso.terminal_audit_unwritten", { staffId: input.staffId, action: ev.action, reasonCode: err instanceof PlatformError ? err.reasonCode : "AUDIT_UNAVAILABLE" });
      }
    }
    return out;
  }

  /** Audit events of a custodian change (suspension, reinstatement), attributed like the session events. */
  private custodianAudit(tenantId: string, staffId: string, correlationId: string, now: Date): CustodianAudit {
    return (c) => {
      const out: AuditEventInput[] = [];
      if (c.suspended.length > 0 || c.recoverySessionsRevoked > 0) {
        out.push(
          consoleAuditInput({
            tenantId,
            correlationId,
            staffId,
            role: null,
            action: "console.recovery_identity.suspended",
            outcome: "SUCCEEDED",
            reasonCode: c.reason ?? "CUSTODIAN_OFFBOARDED",
            occurredAt: now,
            evidencePointers: [...c.suspended.slice(0, 15).map((id) => `recovery_identity:${id}`), `db://console_sessions/recovery-revoked/${c.recoverySessionsRevoked}`],
          }),
        );
      }
      if (c.reinstated.length > 0) {
        out.push(
          consoleAuditInput({
            tenantId,
            correlationId,
            staffId,
            role: null,
            action: "console.recovery_identity.reinstated",
            outcome: "SUCCEEDED",
            reasonCode: "RECOVERY_IDENTITY_REINSTATED",
            occurredAt: now,
            evidencePointers: c.reinstated.slice(0, 16).map((id) => `recovery_identity:${id}`),
          }),
        );
      }
      return out;
    };
  }

  private async revokeAtIdp(row: ConsoleSessionRow): Promise<void> {
    if (!row.refresh) return;
    await this.revokeTokenAtIdp(this.d.sealer.open(row.refresh, row.sessionHash), row.staffId);
  }

  /** RFC 7009 revocation of one refresh token (best effort; a failure is logged, never the token). */
  private async revokeTokenAtIdp(refreshToken: string, staffId: string): Promise<void> {
    try {
      await this.d.oidc.revoke(refreshToken, "refresh_token");
    } catch (err) {
      this.log.warn("console.sso.idp_revocation_failed", { staffId, reasonCode: err instanceof PlatformError ? err.reasonCode : "OIDC_REVOCATION_FAILED" });
    }
  }

  /** Tokens the IdP issued to a refresh the console then refused or could not record are revoked there (best effort). */
  private async discardIssued(tokens: WorkforceTokenSet, staffId: string): Promise<void> {
    if (tokens.refreshToken) await this.revokeTokenAtIdp(tokens.refreshToken, staffId);
  }

  /**
   * Same-actor refresh with rotation (FO-05-19). Refused for an idle, expired, revoked or rotated session; a
   * different subject from the IdP revokes the family. A refresh the IdP refuses is a terminal path (the family
   * closes and the custodian is suspended unless another terminal path closed the family first); one that ends
   * without a recorded redemption (IdP unreachable, unknown outcome, an invalid answer) only releases its claim: the
   * row stays as it was and its next active check asks the IdP (an old token that was redeemed is then inactive).
   */
  async refresh(header: string | undefined, correlationId: string): Promise<SsoTokenResult> {
    if (!isConsoleSessionHeader(header)) throw unauthenticated("UNAUTHENTICATED");
    const oldToken = (header as string).slice("Bearer ".length);
    const oldHash = consoleSessionHash(oldToken);
    const now = this.now();
    const row = await this.d.sessions.load(this.d.config.tenantId, oldHash);
    const verdict = sessionVerdict(row, now, 0);
    if (!verdict.ok) {
      if (verdict.row) await this.closeOnVerdict(verdict.row, verdict.reasonCode === "SESSION_ROTATED" ? "SESSION_TOKEN_REPLAYED" : verdict.reasonCode, now);
      throw unauthenticated(verdict.reasonCode === "SESSION_ROTATED" ? "SESSION_TOKEN_REPLAYED" : verdict.reasonCode);
    }
    const cur = verdict.row;
    if (cur.kind !== "OIDC_SSO" || !cur.refresh) throw unauthenticated("SESSION_REFRESH_UNAVAILABLE");
    // One refresh of a row reaches the IdP at a time, and the claim is visible BEFORE the IdP redeems the token: a
    // request whose active check meanwhile sees the old token inactive knows the family itself is rotating it.
    if (!(await this.d.sessions.claimRefresh(cur.tenantId, cur.sessionHash, now, this.refreshInFlightSince(now)))) {
      throw new ConsoleHttpError(401, "SESSION_ROTATED", true);
    }
    let tokens: WorkforceTokenSet;
    try {
      tokens = await this.d.oidc.refresh({
        refreshToken: this.d.sealer.open(cur.refresh, cur.sessionHash),
        expected: { isSameSubject: (sub) => subjectDigestOf(this.d.config.issuer, sub) === cur.subjectDigest, authTime: cur.authTimeEpoch, nonceHash: cur.nonceHash },
      });
    } catch (err) {
      const e = this.providerError(err);
      if (e.reasonCode === "OIDC_SUBJECT_CHANGED") {
        await this.closeTerminal(cur, "SESSION_SUBJECT_CHANGED", now, { kind: "PERSON_REFUSED" }, { audit: true });
        throw unauthenticated("SESSION_SUBJECT_CHANGED");
      }
      if (e.reasonCode === "OIDC_GRANT_INVALID") {
        // The IdP no longer honours this family's refresh token (disabled user, reuse, expiry, its own logout's
        // revocation): a terminal path. Unless another terminal path already closed the family, the custodian is
        // suspended (fail closed; reinstated by the next MFA sign-in).
        await this.closeTerminal(cur, "SESSION_REFRESH_REFUSED", now, { kind: "TOKEN_INACTIVE" }, { audit: true });
        throw unauthenticated("SESSION_REFRESH_REFUSED");
      }
      await this.d.sessions.releaseRefreshClaim(cur.tenantId, cur.sessionHash, now).catch((err2: unknown) => {
        this.log.error("console.sso.refresh_claim_release_failed", { staffId: cur.staffId, reasonCode: err2 instanceof PlatformError ? err2.reasonCode : "REFRESH_CLAIM_RELEASE_FAILED" });
      });
      throw e;
    }
    // Same actor: the refreshed (iss, sub) must equal the bound one (never adopted silently).
    if (subjectDigestOf(tokens.idToken.issuer, tokens.idToken.subject) !== cur.subjectDigest || issuerDigestOf(tokens.idToken.issuer) !== cur.issuerDigest) {
      await this.discardIssued(tokens, cur.staffId);
      await this.closeTerminal(cur, "SESSION_SUBJECT_CHANGED", now, { kind: "PERSON_REFUSED" }, { audit: true });
      this.log.warn("console.sso.subject_changed", { staffId: cur.staffId, reasonCode: "SESSION_SUBJECT_CHANGED" });
      throw unauthenticated("SESSION_SUBJECT_CHANGED");
    }
    const mapped = this.d.directory.map({ issuer: tokens.idToken.issuer, subject: tokens.idToken.subject, groups: tokens.idToken.groups });
    if ("refused" in mapped) {
      const reason = mapped.refused === "STAFF_GROUP_UNKNOWN" ? "STAFF_GROUP_UNKNOWN" : "STAFF_NOT_PROVISIONED";
      await this.discardIssued(tokens, cur.staffId);
      await this.closeTerminal(cur, reason, now, { kind: "PERSON_REFUSED" }, { audit: true });
      throw unauthenticated(reason);
    }
    if (mapped.record.staffId !== cur.staffId) {
      await this.discardIssued(tokens, cur.staffId);
      await this.closeTerminal(cur, "SESSION_SUBJECT_CHANGED", now, { kind: "PERSON_REFUSED" }, { audit: true });
      throw unauthenticated("SESSION_SUBJECT_CHANGED");
    }
    const token = newConsoleSessionToken();
    const nextHash = consoleSessionHash(token);
    const next: NewSession = {
      ...cur,
      sessionHash: nextHash,
      generation: cur.generation + 1,
      roles: mapped.record.roles,
      createdAt: now,
      // Refresh is not user activity: the idle window keeps its last real use.
      lastActivityAt: cur.lastActivityAt,
      activeCheckedAt: now,
      refresh: tokens.refreshToken ? this.d.sealer.seal(tokens.refreshToken, nextHash) : null,
      refreshExpiresAt: tokens.refreshTokenExpiresAt,
    };
    const rolesChanged = next.roles.length !== cur.roles.length || next.roles.some((r) => !cur.roles.includes(r));
    const rotated = await this.d.sessions.rotate(
      this.d.audit,
      cur.tenantId,
      cur.sessionHash,
      next,
      now,
      this.auditFor(correlationId, mapped.record, "console.auth.refresh", "SUCCEEDED", "WORKFORCE_SESSION_REFRESHED", now),
      rolesChanged ? this.custodianAudit(cur.tenantId, cur.staffId, correlationId, now) : undefined,
    );
    if (!rotated) {
      // The row was ended meanwhile (a terminal path, such as its logout, raced this refresh and decided): the IdP's
      // new tokens are revoked there.
      await this.discardIssued(tokens, cur.staffId);
      const after = await this.d.sessions.load(cur.tenantId, cur.sessionHash);
      throw unauthenticated(after?.revokedAt ? "SESSION_REVOKED" : "SESSION_TOKEN_REPLAYED");
    }
    return { token, expiresAt: this.deadline(next), idleTimeoutSeconds: next.idleTimeoutSeconds, staffId: cur.staffId, roles: next.roles };
  }

  /**
   * Logout, a TERMINAL path: the whole family is revoked and its IdP refresh token revoked (best effort). Before
   * that the IdP is asked whether the token is still active, and that answer decides about the staff member's
   * recovery identities (sessions.ts `closeFamily`): only an active answer for the session's subject whose roles
   * cover an identity keeps it; an inactive token or no answer (the IdP cannot be asked) suspends it, even when a
   * refresh of the row is in flight (that refresh may have redeemed the token: fail closed, reinstated by the next
   * MFA sign-in).
   */
  async logout(identity: Pick<SsoIdentity, "tenantId" | "familyId" | "sessionHash">, now: Date): Promise<void> {
    const row = await this.d.sessions.load(identity.tenantId, identity.sessionHash);
    if (!row || row.kind !== "OIDC_SSO") {
      await this.d.sessions.revokeFamily(identity.tenantId, identity.familyId, "STAFF_LOGOUT", now);
      if (row) await this.revokeAtIdp(row);
      return;
    }
    // A row another terminal path already closed: that path decided; the answer could not change anything.
    const answer = row.revokedAt === null ? await this.askIdp(row) : NO_ANSWER;
    // The logout itself is audited by the route (STAFF_LOGOUT); only a custodian change is added here.
    await this.closeTerminal(row, "STAFF_LOGOUT", now, answer, { audit: false });
  }

  /**
   * Offboarding sweeper (worker loop; the integration package schedules it). Closes idle or absolutely expired
   * sessions as terminal paths (each asks the IdP first and decides about the custodian, so an expiry never ends a
   * custodian's session without a decision), asks the IdP about every live session whose active-state check is due,
   * so a deprovisioned user (disabled, or removed from every managed group) loses access within
   * `activeCheckIntervalSeconds` even without making a request, closes RECOVERY sessions whose recovery identity is
   * no longer ACTIVE, and deletes expired single-use login states.
   */
  async sweep(limit = 200): Promise<{ checked: number; revoked: number; unverified: number; purgedLoginTransactions: number }> {
    const now = this.now();
    const tenantId = this.d.config.tenantId;
    let revoked = 0;
    let unverified = 0;
    for (const row of await this.d.sessions.expiredUnrevoked(tenantId, now, limit)) {
      const reason = now.getTime() >= row.absoluteExpiresAt.getTime() ? "SESSION_EXPIRED" : "SESSION_IDLE_EXPIRED";
      try {
        if (await this.closeExpired(row, reason, now)) revoked += 1;
      } catch (err) {
        unverified += 1;
        this.log.error("console.sso.expiry_closure_failed", { staffId: row.staffId, reasonCode: err instanceof PlatformError ? err.reasonCode : "EXPIRY_CLOSURE_FAILED" });
      }
    }
    // Login transactions that can no longer be used (expired a minute ago or more) are deleted in bounded batches.
    const purged = await this.d.sessions.purgeLoginTransactions(tenantId, new Date(now.getTime() - 60_000), limit);
    const due = await this.d.sessions.dueForActiveCheck(tenantId, new Date(now.getTime() - this.d.config.session.activeCheckIntervalSeconds * 1000), now, limit);
    for (const row of due) {
      try {
        if (row.kind === "RECOVERY") {
          await this.ensureRecoveryIdentity(row, now);
          await this.d.sessions.markActive(tenantId, row.sessionHash, now, null);
        } else await this.ensureActive(row, now);
      } catch (err) {
        // A row its own refresh is rotating right now, or one another path closed meanwhile, is not revoked here.
        if (err instanceof ConsoleHttpError && err.status === 401) {
          if (err.reasonCode !== "SESSION_ROTATED" && err.reasonCode !== "SESSION_REVOKED") revoked += 1;
        } else unverified += 1;
      }
    }
    return { checked: due.length, revoked, unverified, purgedLoginTransactions: purged };
  }

  /** Refuses an exchange: anonymous refusals go through the audit budget, a verified actor's are audited per event. */
  private refuseExchange(correlationId: string, reasonCode: string, status: 400 | 401, verifiedStaffId: string | null): never {
    if (verifiedStaffId === null) void this.auditAnonymous(correlationId, "console.auth.oidc_exchange", "DENIED", reasonCode);
    else void this.auditVerifiedRefusal(correlationId, verifiedStaffId, "console.auth.oidc_exchange", reasonCode);
    throw new ConsoleHttpError(status, reasonCode);
  }

  /**
   * IdP and adapter failures to console HTTP errors: refusals 401, dependency failures 503 (retryable unless the
   * outcome is unknown), and a configuration refusal (the egress policy refuses an IdP URL: OIDC_EGRESS_REFUSED)
   * 503 NOT retryable under its own reason code, never reported as an IdP outage.
   */
  private providerError(err: unknown): ConsoleHttpError {
    if (err instanceof ConsoleHttpError) return err;
    if (err instanceof ConfigurationRejectedError) {
      const code = err.violations.map((v) => v.split("@")[0] ?? "").find((c) => /^[A-Z][A-Z0-9_]{2,63}$/.test(c)) ?? "WORKFORCE_IDP_CONFIGURATION_REJECTED";
      this.log.error("console.sso.idp_configuration_rejected", { reasonCode: code });
      return unavailable(code, false);
    }
    if (err instanceof DependencyError) {
      this.log.warn("console.sso.idp_unavailable", { reasonCode: err.reasonCode });
      return unavailable(err.outcome === "UNKNOWN" ? "WORKFORCE_IDP_OUTCOME_UNKNOWN" : "WORKFORCE_IDP_UNAVAILABLE", err.outcome !== "UNKNOWN");
    }
    if (err instanceof PlatformError) return unauthenticated(/^[A-Z][A-Z0-9_]{2,63}$/.test(err.reasonCode) ? err.reasonCode : "UNAUTHENTICATED");
    return unauthenticated("UNAUTHENTICATED");
  }

  private auditFor(correlationId: string, staff: Pick<StaffRecord, "tenantId" | "staffId" | "roles">, action: string, outcome: AuditEventInput["outcome"], reasonCode: string, now: Date): AuditEventInput {
    return consoleAuditInput({ tenantId: staff.tenantId, correlationId, staffId: staff.staffId, role: staff.roles[0] ?? null, action, outcome, reasonCode, occurredAt: now });
  }

  private async auditSystem(row: ConsoleSessionRow, action: string, reasonCode: string, now: Date): Promise<void> {
    try {
      await this.d.audit.appendStandalone(consoleAuditInput({ tenantId: row.tenantId, correlationId: newId("cor"), staffId: row.staffId, role: row.roles[0] ?? null, action, outcome: "DENIED", reasonCode, occurredAt: now }));
    } catch (err) {
      this.log.warn("console.sso.audit_failed", { reasonCode: err instanceof PlatformError ? err.reasonCode : "AUDIT_UNAVAILABLE" });
    }
  }

  /**
   * Anonymous refusal (no verified identity behind it): written only within the anonymous audit budget, with the
   * number suppressed since the last written event; suppressed ones are logged once per window (best effort).
   */
  private async auditAnonymous(correlationId: string, action: string, outcome: AuditEventInput["outcome"], reasonCode: string): Promise<void> {
    const admitted = this.anonymousBudget.admit(action, reasonCode);
    if (!admitted.write) {
      if (admitted.firstSuppressedInWindow) this.log.warn("console.sso.anonymous_audit_suppressed", { action, reasonCode, correlationId });
      return;
    }
    try {
      await this.d.audit.appendStandalone(
        consoleAuditInput({ tenantId: this.d.config.tenantId, correlationId, staffId: null, role: null, action, outcome, reasonCode, occurredAt: this.now(), evidencePointers: suppressedEvidence(admitted.suppressedBefore) }),
      );
    } catch (err) {
      this.log.warn("console.sso.audit_failed", { reasonCode: err instanceof PlatformError ? err.reasonCode : "AUDIT_UNAVAILABLE" });
    }
  }

  /** Refused sign-in of an IdP-authenticated, independently verified identity (pseudonymous staff id; best effort). */
  private async auditVerifiedRefusal(correlationId: string, staffId: string, action: string, reasonCode: string): Promise<void> {
    try {
      await this.d.audit.appendStandalone(consoleAuditInput({ tenantId: this.d.config.tenantId, correlationId, staffId, role: null, action, outcome: "DENIED", reasonCode, occurredAt: this.now() }));
    } catch (err) {
      this.log.warn("console.sso.audit_failed", { reasonCode: err instanceof PlatformError ? err.reasonCode : "AUDIT_UNAVAILABLE" });
    }
  }
}
