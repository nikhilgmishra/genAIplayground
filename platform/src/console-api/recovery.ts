/**
 * Dual-controlled SSO-outage recovery for workforce operators (WP-05; follow-on FO-14-51; spec section 7
 * "Break-glass is human-controlled, time-bound and audited, not a tool the model can self-authorize").
 *
 * Why: kill switches and safety routing are operated through the console, whose normal sign-in depends on
 * the workforce IdP (docs/RUNBOOKS/kill-switch-operations.md). When the IdP is down or an operator is
 * locked out, a recovery path that is NOT a development bypass is needed.
 *
 *   identities   a recovery identity is a staff member's hardware-held key (EC P-256 public JWK; the
 *                private key never leaves the token) recorded OUTSIDE the primary IdP, with the reference of
 *                the attestation evidence reviewed out of band. Enrollment is bound to the holder:
 *                  propose  one security_admin, never the holder; the holder must have signed in by SSO recently
 *                           (latest positive IdP evidence within `holderSsoMaxAgeSeconds`: a staff id that never
 *                           authenticated through the workforce IdP is refused, RECOVERY_HOLDER_NOT_AUTHENTICATED),
 *                           and every requested role must be one the directory mapped for the holder then
 *                           (RECOVERY_ROLES_NOT_GRANTED). Returns a one-time enrollment challenge.
 *                  confirm  the HOLDER, in their own SSO session (never a recovery or local session), signs the
 *                           challenge with the enrolled key (compact JWS, typ vsp-recovery-enroll+jwt): proof of
 *                           possession tied to the IdP identity. A key the proposer holds, or a holder who does
 *                           not exist at the IdP, can never get here.
 *                  approve  a second security_admin, neither the proposer nor the holder, only after the holder
 *                           confirmed (RECOVERY_HOLDER_UNCONFIRMED; also a database CHECK).
 *                Roles are limited to security_admin, supervisor and safety_responder. The IdP keeps governing the
 *                holder afterwards (sso.ts, sessions.ts): an offboarding signal SUSPENDS the identity and ends its
 *                RECOVERY sessions; only a new SSO sign-in that maps its roles reinstates it.
 *   activation   `challenge` needs a signed request from the requester's own key (compact JWS, typ
 *                vsp-recovery-request+jwt, single-use nonce): an anonymous or replayed request writes nothing and
 *                consumes none of the identity's budget. It then creates a random 256-bit challenge for one ACTIVE
 *                identity (the requester), valid for 5 minutes. `activate` needs TWO compact JWS (ES256, typ vsp-recovery+jwt) over
 *                {aud, tenant, activationId, challenge, identityId, iat}: one from the requester's key and one
 *                from a DIFFERENT active custodian (another staff member). Any failure closes the activation
 *                (single use, no guessing). Success issues a RECOVERY console session for the requester:
 *                the identity's roles only, short absolute lifetime and idle limit, no refresh, audited, and a
 *                post-use access review is opened with the second custodian recorded as approver.
 *                The claim of the activation, a re-check of BOTH identities under a row share lock, the holder
 *                evidence of BOTH custodians (each signed in by SSO within `holderSsoMaxAgeSeconds`; the requester's
 *                identity roles still mapped for them) and the session insert (with its audit event) are ONE
 *                transaction: a revocation or suspension that committed first is seen (refused); one that comes
 *                later waits for the lock and then ends the session this activation created.
 *   enforcement  a RECOVERY session is bound to the identity it was activated with (its subject digest is
 *                subjectDigestOf(RECOVERY_ISSUER, identityId)). Revoking that identity revokes its recovery
 *                sessions in the same transaction, whatever other identities the holder has, and every request of
 *                a recovery session re-checks that exactly that identity is still ACTIVE (WorkforceSsoService
 *                .authenticate), on top of the ordinary session checks.
 */
import { randomBytes } from "node:crypto";
import { CompactSign, calculateJwkThumbprint, compactVerify, importJWK } from "jose";
import { z } from "zod";
import type { AuditWriter } from "../audit/ports.js";
import type { Db, Queryable } from "../db/types.js";
import { silentLogger } from "../observability/logger.js";
import type { Logger } from "../observability/ports.js";
import type { AuditEventInput, StaffRole } from "../protocol/index.js";
import { sha256Hex } from "../shared/canonical.js";
import type { Clock } from "../shared/clock.js";
import { iso } from "../shared/clock.js";
import { newId } from "../shared/ids.js";
import type * as C from "./contract.js";
import { ConsoleHttpError, conflict, forbidden, notFound, unauthenticated, unavailable } from "./errors.js";
import type { PgBreakGlassIssuance } from "./break-glass-issuance.js";
import { consoleSessionHash, holderEvidenceWithin, issuerDigestOf, newConsoleSessionToken, newSessionFamilyId, subjectDigestOf } from "./sessions.js";
import type { PgConsoleSessionStore } from "./sessions.js";
import { consoleAuditInput } from "./stores.js";

export const RECOVERY_AUDIENCE = "vsp-console-recovery";
export const RECOVERY_SIGNATURE_TYP = "vsp-recovery+jwt";
/** Holder's proof of possession at enrollment (signed in their SSO session). */
export const RECOVERY_ENROLL_TYP = "vsp-recovery-enroll+jwt";
/** Requester's signed activation request (only the custodian can ask for a challenge). */
export const RECOVERY_REQUEST_TYP = "vsp-recovery-request+jwt";
export const RECOVERY_ISSUER = "vsp-console-recovery";

export interface RecoveryPolicy {
  /** Activation challenge lifetime (default 300 s). */
  challengeTtlSeconds: number;
  /** Absolute lifetime of a recovery session (default 3600 s). */
  sessionLifetimeSeconds: number;
  /** Idle limit of a recovery session (default 600 s). */
  idleTimeoutSeconds: number;
  /** Pending (unexpired, unused) challenges one identity may have at a time (default 3; unauthenticated endpoint). */
  maxPendingChallenges: number;
  /** Challenges one identity may be issued per hour (default 20; each one is a row and an audit event). */
  maxChallengesPerHour: number;
  /**
   * A custodian's latest positive workforce-IdP evidence (SSO sign-in, refresh or active check) must be at most this
   * old for enrollment and activation (default 14 days): a custodian who left without a live session loses the path.
   */
  holderSsoMaxAgeSeconds: number;
  /** Lifetime of the one-time enrollment challenge the holder confirms (default 24 h, at most 7 days). */
  enrollmentTtlSeconds: number;
  /** Maximum age (and future skew) of a signed activation request (default 120 s). */
  requestProofMaxAgeSeconds: number;
}

export const DEFAULT_RECOVERY_POLICY: RecoveryPolicy = {
  challengeTtlSeconds: 300,
  sessionLifetimeSeconds: 3_600,
  idleTimeoutSeconds: 600,
  maxPendingChallenges: 3,
  maxChallengesPerHour: 20,
  holderSsoMaxAgeSeconds: 14 * 86_400,
  enrollmentTtlSeconds: 86_400,
  requestProofMaxAgeSeconds: 120,
};

/** The authenticated console identity confirming an enrollment (from the request's session). */
export interface RecoveryHolderSession {
  staffId: string;
  /** Session kind of the request: only OIDC_SSO (a console SSO session) proves the IdP identity. */
  sessionKind: "OIDC_SSO" | "RECOVERY" | "LOCAL_FIXTURE";
  sessionHash: string | null;
  roles: readonly StaffRole[];
}

interface IdentityRow {
  identity_id: string;
  staff_id: string;
  key_thumbprint: string;
  public_jwk: C.RecoveryPublicJwk | string;
  attestation_ref: string;
  roles: C.RecoveryRole[];
  status: "PROPOSED" | "ACTIVE" | "SUSPENDED" | "REVOKED";
  proposed_by: string;
  proposed_at: Date | string;
  enrollment_challenge_hash: string;
  enrollment_expires_at: Date | string;
  holder_confirmed_at: Date | string | null;
  approved_by: string | null;
  suspend_reason: string | null;
}

const IDENTITY_SELECT =
  "select identity_id, staff_id, key_thumbprint, public_jwk, attestation_ref, roles, status, proposed_by, proposed_at, enrollment_challenge_hash, enrollment_expires_at, holder_confirmed_at, approved_by, suspend_reason from console_recovery_identities";

function identityView(r: IdentityRow): C.RecoveryIdentityView {
  return {
    identityId: r.identity_id,
    staffId: r.staff_id,
    keyThumbprint: r.key_thumbprint,
    roles: [...r.roles],
    attestationRef: r.attestation_ref,
    status: r.status,
    proposedBy: r.proposed_by,
    holderConfirmedAt: r.holder_confirmed_at === null ? null : iso(new Date(r.holder_confirmed_at)),
    approvedBy: r.approved_by,
    suspendReason: r.suspend_reason,
  };
}

const coveredBy = (roles: readonly string[], granted: readonly string[]): boolean => roles.every((r) => granted.includes(r));

const SignedPayload = z.strictObject({
  aud: z.literal(RECOVERY_AUDIENCE),
  tenant: z.string().max(80),
  activationId: z.string().max(80),
  challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  identityId: z.string().max(80),
  iat: z.number().int().positive(),
});

const EnrollPayload = z.strictObject({
  aud: z.literal(RECOVERY_AUDIENCE),
  purpose: z.literal("enrollment"),
  tenant: z.string().max(80),
  identityId: z.string().max(80),
  staffId: z.string().max(80),
  keyThumbprint: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  iat: z.number().int().positive(),
});

const RequestPayload = z.strictObject({
  aud: z.literal(RECOVERY_AUDIENCE),
  purpose: z.literal("activation_request"),
  tenant: z.string().max(80),
  identityId: z.string().max(80),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  iat: z.number().int().positive(),
});

const challengeHash = (c: string): string => sha256Hex(`vsp.recovery-challenge.v1|${c}`);
const enrollmentHash = (c: string): string => sha256Hex(`vsp.recovery-enrollment.v1|${c}`);
const requestNonceHash = (n: string): string => sha256Hex(`vsp.recovery-request.v1|${n}`);

/** Verifies a compact JWS by a recovery public key with the expected `typ`; returns the parsed payload or null. */
async function verifiedPayload<T>(jws: string, publicJwk: C.RecoveryPublicJwk | string, typ: string, schema: z.ZodType<T>): Promise<T | null> {
  try {
    const jwk = typeof publicJwk === "string" ? (JSON.parse(publicJwk) as C.RecoveryPublicJwk) : publicJwk;
    const key = await importJWK({ ...jwk }, "ES256");
    const { payload, protectedHeader } = await compactVerify(jws, key, { algorithms: ["ES256"] });
    if (protectedHeader.typ !== typ) return null;
    const p = schema.safeParse(JSON.parse(Buffer.from(payload).toString("utf8")));
    return p.success ? p.data : null;
  } catch {
    return null;
  }
}

/** Refuses an activation inside its transaction (rolled back), with the reason recorded on the activation. */
class ActivationRefused extends Error {
  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

/** Subject digest a RECOVERY session carries: it names the recovery identity the session was activated with. */
export const recoverySessionSubjectDigest = (identityId: string): string => subjectDigestOf(RECOVERY_ISSUER, identityId);

export class PgRecoveryService {
  private readonly policy: RecoveryPolicy;

  constructor(
    private readonly deps: {
      db: Db;
      audit: AuditWriter;
      sessions: PgConsoleSessionStore;
      issuance: PgBreakGlassIssuance;
      clock: Clock;
      tenantId: string;
      policy?: Partial<RecoveryPolicy>;
      logger?: Logger;
    },
  ) {
    this.policy = { ...DEFAULT_RECOVERY_POLICY, ...deps.policy };
    if (this.policy.enrollmentTtlSeconds < 300 || this.policy.enrollmentTtlSeconds > 7 * 86_400) throw new RangeError("RECOVERY_ENROLLMENT_TTL_INVALID");
    if (this.policy.holderSsoMaxAgeSeconds < 3_600 || this.policy.holderSsoMaxAgeSeconds > 90 * 86_400) throw new RangeError("RECOVERY_HOLDER_SSO_MAX_AGE_INVALID");
    this.log = (deps.logger ?? silentLogger).child({ component: "console_recovery" });
  }

  private readonly log: Logger;

  /**
   * The holder's standing at the workforce IdP for recovery (inside the caller's transaction): latest positive IdP
   * evidence within `holderSsoMaxAgeSeconds`, and `roles` (when given) all mapped for them then. Null when it holds.
   */
  private async holderRefusal(tx: Queryable, staffId: string, roles: readonly string[] | null, now: Date): Promise<"RECOVERY_HOLDER_NOT_AUTHENTICATED" | "RECOVERY_ROLES_NOT_GRANTED" | null> {
    const evidence = await holderEvidenceWithin(tx, staffId);
    if (!evidence || now.getTime() - evidence.confirmedAt.getTime() > this.policy.holderSsoMaxAgeSeconds * 1000) return "RECOVERY_HOLDER_NOT_AUTHENTICATED";
    if (roles !== null && !coveredBy(roles, evidence.roles)) return "RECOVERY_ROLES_NOT_GRANTED";
    return null;
  }

  private tx<T>(staffId: string | null, fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.deps.db.tx(fn, { role: "app_console", rls: { tenantId: this.deps.tenantId, actorId: staffId } });
  }

  /* ---------------- identities (SSO-authenticated security_admin endpoints) ---------------- */

  async list(staffId: string): Promise<C.RecoveryIdentityView[]> {
    const r = await this.tx(staffId, (tx) => tx.query<IdentityRow>(`${IDENTITY_SELECT} order by proposed_at desc limit 64`));
    return r.rows.map(identityView);
  }

  async get(staffId: string, identityId: string): Promise<C.RecoveryIdentityView | null> {
    const r = await this.tx(staffId, (tx) => tx.query<IdentityRow>(`${IDENTITY_SELECT} where identity_id = $1`, [identityId]));
    return r.rows[0] ? identityView(r.rows[0]) : null;
  }

  /**
   * First step of enrollment: a security_admin (never the holder) proposes a key for a holder who signed in by SSO
   * recently, with roles the directory mapped for them. The one-time enrollment challenge is returned once.
   */
  async propose(input: { proposerId: string; body: C.RecoveryIdentityProposeRequest; now: Date; audit: AuditEventInput }): Promise<C.RecoveryIdentityProposeResponse> {
    if (input.body.staffId === input.proposerId) throw forbidden("SELF_APPROVAL_PROHIBITED");
    // Import refuses anything that is not a valid public P-256 point.
    try {
      await importJWK({ ...input.body.publicJwk }, "ES256");
    } catch {
      throw new ConsoleHttpError(400, "RECOVERY_KEY_INVALID");
    }
    const thumbprint = await calculateJwkThumbprint({ ...input.body.publicJwk }, "sha256");
    const identityId = newId("rci", 24);
    const roles = [...new Set(input.body.roles)];
    const challenge = randomBytes(32).toString("base64url");
    const enrollmentExpiresAt = new Date(input.now.getTime() + this.policy.enrollmentTtlSeconds * 1000);
    return this.tx(input.proposerId, async (tx) => {
      // The holder must exist at the workforce IdP (a recent SSO sign-in) and hold every proposed role there.
      const refusal = await this.holderRefusal(tx, input.body.staffId, roles, input.now);
      if (refusal === "RECOVERY_HOLDER_NOT_AUTHENTICATED") throw conflict(refusal);
      if (refusal) throw forbidden(refusal);
      await this.deps.audit.append(tx, input.audit);
      try {
        await tx.query(
          `insert into console_recovery_identities (identity_id, tenant_id, staff_id, key_thumbprint, public_jwk, attestation_ref, roles, status, proposed_by, proposed_at,
             enrollment_challenge_hash, enrollment_expires_at)
           values ($1, $2, $3, $4, $5::jsonb, $6, $7::text[], 'PROPOSED', $8, $9::timestamptz, $10, $11::timestamptz)`,
          [identityId, this.deps.tenantId, input.body.staffId, thumbprint, JSON.stringify(input.body.publicJwk), input.body.attestationRef, roles, input.proposerId, iso(input.now), enrollmentHash(challenge), iso(enrollmentExpiresAt)],
        );
      } catch (err) {
        if ((err as { code?: string }).code === "23505") throw conflict("RECOVERY_KEY_ALREADY_REGISTERED");
        throw err;
      }
      const r = (await tx.query<IdentityRow>(`${IDENTITY_SELECT} where identity_id = $1`, [identityId])).rows[0];
      if (!r) throw notFound("NOT_FOUND");
      return { identity: identityView(r), enrollment: { challenge, expiresAt: iso(enrollmentExpiresAt) } };
    });
  }

  /**
   * Second step: the HOLDER proves possession of the enrolled key in their own SSO session (proof of possession
   * bound to the IdP identity): a signature over the enrollment challenge, the identity, the holder's staff id and
   * the key thumbprint. Roles must still be ones the holder's session carries. Not single use per attempt: a wrong
   * signature from the holder can be retried until the enrollment expires (nobody else can reach this step).
   */
  async confirm(input: { holder: RecoveryHolderSession; identityId: string; signature: string; now: Date; audit: AuditEventInput }): Promise<C.RecoveryIdentityView> {
    if (input.holder.sessionKind !== "OIDC_SSO" || input.holder.sessionHash === null) throw forbidden("RECOVERY_HOLDER_SSO_REQUIRED");
    return this.tx(input.holder.staffId, async (tx) => {
      const cur = (await tx.query<IdentityRow>(`${IDENTITY_SELECT} where identity_id = $1 for update`, [input.identityId])).rows[0];
      if (!cur) throw notFound("NOT_FOUND");
      if (cur.staff_id !== input.holder.staffId) throw forbidden("RECOVERY_HOLDER_MISMATCH");
      if (cur.status !== "PROPOSED") throw conflict("RECOVERY_IDENTITY_NOT_PROPOSED");
      if (cur.holder_confirmed_at !== null) throw conflict("RECOVERY_HOLDER_ALREADY_CONFIRMED");
      if (new Date(cur.enrollment_expires_at).getTime() <= input.now.getTime()) throw conflict("RECOVERY_ENROLLMENT_EXPIRED");
      if (!coveredBy(cur.roles, input.holder.roles)) throw forbidden("RECOVERY_ROLES_NOT_GRANTED");
      const p = await verifiedPayload(input.signature, cur.public_jwk, RECOVERY_ENROLL_TYP, EnrollPayload);
      const ageMs = p ? input.now.getTime() - p.iat * 1000 : Number.POSITIVE_INFINITY;
      const valid =
        p !== null &&
        p.tenant === this.deps.tenantId &&
        p.identityId === cur.identity_id &&
        p.staffId === cur.staff_id &&
        p.keyThumbprint === cur.key_thumbprint &&
        enrollmentHash(p.challenge) === cur.enrollment_challenge_hash &&
        ageMs >= -30_000 &&
        ageMs <= this.policy.challengeTtlSeconds * 1000;
      if (!valid) throw forbidden("RECOVERY_HOLDER_PROOF_INVALID");
      await this.deps.audit.append(tx, input.audit);
      await tx.query("update console_recovery_identities set holder_confirmed_at = $2::timestamptz where identity_id = $1", [input.identityId, iso(input.now)]);
      const r = (await tx.query<IdentityRow>(`${IDENTITY_SELECT} where identity_id = $1`, [input.identityId])).rows[0];
      if (!r) throw notFound("NOT_FOUND");
      return identityView(r);
    });
  }

  /** Second security_admin (not the proposer, not the holder) activates the identity, after the holder confirmed. */
  async approve(input: { approverId: string; identityId: string; now: Date; audit: AuditEventInput }): Promise<C.RecoveryIdentityView> {
    return this.tx(input.approverId, async (tx) => {
      const cur = (await tx.query<IdentityRow>(`${IDENTITY_SELECT} where identity_id = $1 for update`, [input.identityId])).rows[0];
      if (!cur) throw notFound("NOT_FOUND");
      if (cur.proposed_by === input.approverId || cur.staff_id === input.approverId) throw forbidden("RECOVERY_DUAL_CONTROL_REQUIRED");
      if (cur.status !== "PROPOSED") throw conflict("RECOVERY_IDENTITY_NOT_PROPOSED");
      if (cur.holder_confirmed_at === null) throw conflict("RECOVERY_HOLDER_UNCONFIRMED");
      const refusal = await this.holderRefusal(tx, cur.staff_id, cur.roles, input.now);
      if (refusal === "RECOVERY_HOLDER_NOT_AUTHENTICATED") throw conflict(refusal);
      if (refusal) throw forbidden(refusal);
      await this.deps.audit.append(tx, input.audit);
      await tx.query("update console_recovery_identities set status = 'ACTIVE', approved_by = $2, approved_at = $3::timestamptz where identity_id = $1", [input.identityId, input.approverId, iso(input.now)]);
      const r = (await tx.query<IdentityRow>(`${IDENTITY_SELECT} where identity_id = $1`, [input.identityId])).rows[0];
      if (!r) throw notFound("NOT_FOUND");
      return identityView(r);
    });
  }

  /**
   * Revocation takes effect immediately: every live RECOVERY session activated with THIS identity is revoked in
   * the same transaction, whatever other identities the holder has (the holder's ordinary SSO sessions are not
   * recovery sessions and are untouched). The row lock serialises against a concurrent activation (see activate).
   */
  async revoke(input: { adminId: string; identityId: string; reason: string; now: Date; audit: AuditEventInput }): Promise<C.RecoveryIdentityView> {
    return this.tx(input.adminId, async (tx) => {
      const cur = (await tx.query<IdentityRow>(`${IDENTITY_SELECT} where identity_id = $1 for update`, [input.identityId])).rows[0];
      if (!cur) throw notFound("NOT_FOUND");
      if (cur.status === "REVOKED") throw conflict("RECOVERY_IDENTITY_REVOKED");
      await this.deps.audit.append(tx, input.audit);
      await tx.query("update console_recovery_identities set status = 'REVOKED', revoked_by = $2, revoked_at = $3::timestamptz, revoke_reason = $4 where identity_id = $1", [input.identityId, input.adminId, iso(input.now), input.reason]);
      // A separate statement after the row lock: it sees every session an activation committed while we waited.
      await this.deps.sessions.revokeRecoverySessionsWithin(tx, recoverySessionSubjectDigest(input.identityId), "RECOVERY_IDENTITY_REVOKED", input.now);
      const r = (await tx.query<IdentityRow>(`${IDENTITY_SELECT} where identity_id = $1`, [input.identityId])).rows[0];
      if (!r) throw notFound("NOT_FOUND");
      return identityView(r);
    });
  }

  async hasActiveIdentity(staffId: string): Promise<boolean> {
    const r = await this.tx(null, (tx) => tx.query<{ n: number }>("select count(*)::int as n from console_recovery_identities where staff_id = $1 and status = 'ACTIVE'", [staffId]));
    return (r.rows[0]?.n ?? 0) > 0;
  }

  async anyActive(): Promise<boolean> {
    const r = await this.tx(null, (tx) => tx.query<{ n: number }>("select count(*)::int as n from console_recovery_identities where status = 'ACTIVE'"));
    return (r.rows[0]?.n ?? 0) > 0;
  }

  /* ---------------- activation (public endpoints; the IdP may be down) ---------------- */

  /**
   * Unauthenticated (the IdP may be down), but only the custodian can ask: the request must carry a signature by the
   * identity's own key over a fresh nonce (`proof`). An anonymous, invalid, stale or replayed request is refused
   * BEFORE anything is counted or written, so nobody but the key holder can consume the identity's budget.
   */
  async challenge(input: { identityId: string; proof: string; correlationId: string }): Promise<C.RecoveryChallengeResponse> {
    const now = this.deps.clock.now();
    const identity = (await this.tx(null, (tx) => tx.query<IdentityRow>(`${IDENTITY_SELECT} where identity_id = $1`, [input.identityId]))).rows[0];
    if (!identity || identity.status !== "ACTIVE") throw notFound("RECOVERY_IDENTITY_UNAVAILABLE");
    const request = await verifiedPayload(input.proof, identity.public_jwk, RECOVERY_REQUEST_TYP, RequestPayload);
    const requestAgeMs = request ? now.getTime() - request.iat * 1000 : Number.POSITIVE_INFINITY;
    if (!request || request.tenant !== this.deps.tenantId || request.identityId !== identity.identity_id || Math.abs(requestAgeMs) > this.policy.requestProofMaxAgeSeconds * 1000) {
      // Anonymous noise on a public endpoint: logged, nothing written, nothing counted.
      this.log.warn("console.recovery.request_proof_invalid", { reasonCode: "RECOVERY_REQUEST_PROOF_INVALID", correlationId: input.correlationId });
      throw unauthenticated("RECOVERY_REQUEST_PROOF_INVALID");
    }
    const challenge = randomBytes(32).toString("base64url");
    const activationId = newId("rca", 24);
    const expiresAt = new Date(now.getTime() + this.policy.challengeTtlSeconds * 1000);
    // Per identity, a bounded number of pending challenges and of challenges per hour (each is a row and an audit
    // event), counted over signed requests only. Beyond it: refused (retryable), nothing written.
    const issued = await this.tx(identity.staff_id, async (tx) => {
      const counts = (
        await tx.query<{ pending: number; recent: number }>(
          `select count(*) filter (where status = 'PENDING' and expires_at > $2::timestamptz)::int as pending, count(*)::int as recent
             from console_recovery_activations where identity_id = $1 and created_at > $3::timestamptz`,
          [input.identityId, iso(now), iso(new Date(now.getTime() - 3_600_000))],
        )
      ).rows[0];
      if ((counts?.pending ?? 0) >= this.policy.maxPendingChallenges || (counts?.recent ?? 0) >= this.policy.maxChallengesPerHour) return "LIMIT" as const;
      // The request nonce is single use (unique per identity): a replayed signed request is refused, nothing written.
      const inserted = await tx.query(
        `insert into console_recovery_activations (activation_id, tenant_id, identity_id, challenge_hash, request_nonce_hash, created_at, expires_at, status)
         values ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, 'PENDING')
         on conflict (identity_id, request_nonce_hash) do nothing`,
        [activationId, this.deps.tenantId, input.identityId, challengeHash(challenge), requestNonceHash(request.nonce), iso(now), iso(expiresAt)],
      );
      return inserted.rowCount === 1 ? ("ISSUED" as const) : ("REPLAYED" as const);
    });
    if (issued === "LIMIT") throw unavailable("RECOVERY_CHALLENGE_LIMIT", true);
    if (issued === "REPLAYED") {
      this.log.warn("console.recovery.request_replayed", { reasonCode: "RECOVERY_REQUEST_REPLAYED", correlationId: input.correlationId });
      throw unauthenticated("RECOVERY_REQUEST_REPLAYED");
    }
    await this.auditAnonymous(input.correlationId, identity.staff_id, "console.auth.recovery_challenge", "PENDING", "RECOVERY_CHALLENGE_ISSUED", now, [`recovery_activation:${activationId}`]);
    return { activationId, challenge, expiresAt: iso(expiresAt) };
  }

  /**
   * Two custodians' signatures over the challenge yield a RECOVERY session for the requester. Every failure
   * closes the activation (single use).
   */
  async activate(input: { body: C.RecoveryActivateRequest; correlationId: string }): Promise<{ token: string; expiresAt: Date; idleTimeoutSeconds: number; staffId: string; roles: StaffRole[] }> {
    const now = this.deps.clock.now();
    const act = (
      await this.tx(null, (tx) =>
        tx.query<{ activation_id: string; identity_id: string; challenge_hash: string; expires_at: Date | string; status: string }>(
          "select activation_id, identity_id, challenge_hash, expires_at, status from console_recovery_activations where activation_id = $1",
          [input.body.activationId],
        ),
      )
    ).rows[0];
    if (!act || act.status !== "PENDING") throw unauthenticated("RECOVERY_ACTIVATION_UNAVAILABLE");
    const refuse = async (reason: string, staffId: string | null): Promise<never> => {
      await this.tx(null, (tx) => tx.query("update console_recovery_activations set status = 'REFUSED', completed_at = $2::timestamptz, outcome = $3 where activation_id = $1 and status = 'PENDING'", [act.activation_id, iso(now), reason]));
      await this.auditAnonymous(input.correlationId, staffId, "console.auth.recovery_activate", "DENIED", reason, now, [`recovery_activation:${act.activation_id}`]);
      throw unauthenticated(reason);
    };
    if (new Date(act.expires_at).getTime() <= now.getTime()) return refuse("RECOVERY_ACTIVATION_EXPIRED", null);
    const [first, second] = input.body.approvals;
    if (!first || !second || first.identityId !== act.identity_id || second.identityId === first.identityId) return refuse("RECOVERY_DUAL_CONTROL_REQUIRED", null);
    const rows = (await this.tx(null, (tx) => tx.query<IdentityRow>(`${IDENTITY_SELECT} where identity_id = any($1::text[])`, [[first.identityId, second.identityId]]))).rows;
    const requester = rows.find((r) => r.identity_id === first.identityId);
    const cosigner = rows.find((r) => r.identity_id === second.identityId);
    if (!requester || !cosigner || requester.status !== "ACTIVE" || cosigner.status !== "ACTIVE") return refuse("RECOVERY_IDENTITY_UNAVAILABLE", requester?.staff_id ?? null);
    if (requester.staff_id === cosigner.staff_id) return refuse("RECOVERY_DUAL_CONTROL_REQUIRED", requester.staff_id);
    for (const [approval, identity] of [[first, requester], [second, cosigner]] as const) {
      if (!(await this.signatureValid(approval.signature, identity, act.activation_id, act.challenge_hash, now))) return refuse("RECOVERY_SIGNATURE_INVALID", requester.staff_id);
    }
    // Issue the RECOVERY session (identity roles only, short lifetime, no refresh) and close the activation.
    const token = newConsoleSessionToken();
    const sessionHash = consoleSessionHash(token);
    const roles = [...new Set(requester.roles)] as StaffRole[];
    const audit = consoleAuditInput({
      tenantId: this.deps.tenantId,
      correlationId: input.correlationId,
      staffId: requester.staff_id,
      role: roles[0] ?? null,
      action: "console.auth.recovery_activate",
      outcome: "SUCCEEDED",
      reasonCode: "RECOVERY_SESSION_ISSUED",
      occurredAt: now,
      evidencePointers: [`recovery_activation:${act.activation_id}`, `recovery_cosigner:${cosigner.staff_id}`],
    });
    // One transaction: claim the activation, re-check both identities under a share lock, issue the session. A
    // revocation that committed before this point is seen here; one that starts later waits for the lock and
    // then revokes the session issued here (revoke). Nothing is issued against a stale identity read.
    const outcome = await this.tx(requester.staff_id, async (tx) => {
      const claimed = await tx.query(
        "update console_recovery_activations set status = 'ACTIVATED', second_identity_id = $2, completed_at = $3::timestamptz, session_hash = $4, outcome = 'RECOVERY_SESSION_ISSUED' where activation_id = $1 and status = 'PENDING'",
        [act.activation_id, cosigner.identity_id, iso(now), sessionHash],
      );
      if (claimed.rowCount !== 1) return "ACTIVATION_UNAVAILABLE" as const;
      const live = (await tx.query<{ identity_id: string; status: string; staff_id: string }>("select identity_id, status, staff_id from console_recovery_identities where identity_id = any($1::text[]) for share", [[requester.identity_id, cosigner.identity_id]])).rows;
      const stillActive = (id: string, staff: string) => live.some((r) => r.identity_id === id && r.status === "ACTIVE" && r.staff_id === staff);
      if (!stillActive(requester.identity_id, requester.staff_id) || !stillActive(cosigner.identity_id, cosigner.staff_id)) throw new ActivationRefused("RECOVERY_IDENTITY_UNAVAILABLE");
      // Both custodians must still stand at the workforce IdP: a recent positive SSO answer for each, and the
      // requester's identity roles still mapped for them (a custodian who left without a live session loses the path).
      const requesterRefusal = await this.holderRefusal(tx, requester.staff_id, requester.roles, now);
      if (requesterRefusal) throw new ActivationRefused(requesterRefusal);
      if (await this.holderRefusal(tx, cosigner.staff_id, null, now)) throw new ActivationRefused("RECOVERY_COSIGNER_NOT_AUTHENTICATED");
      await this.deps.sessions.insertWithin(
        tx,
        this.deps.audit,
        {
          sessionHash,
          familyId: newSessionFamilyId(),
          generation: 1,
          kind: "RECOVERY",
          tenantId: this.deps.tenantId,
          staffId: requester.staff_id,
          issuerDigest: issuerDigestOf(RECOVERY_ISSUER),
          subjectDigest: recoverySessionSubjectDigest(requester.identity_id),
          roles,
          amr: ["hwk"],
          authenticatedAt: now,
          authTimeEpoch: Math.floor(now.getTime() / 1000),
          nonceHash: null,
          createdAt: now,
          lastActivityAt: now,
          idleTimeoutSeconds: this.policy.idleTimeoutSeconds,
          absoluteExpiresAt: new Date(now.getTime() + this.policy.sessionLifetimeSeconds * 1000),
          activeCheckedAt: now,
          refresh: null,
          refreshExpiresAt: null,
        },
        audit,
      );
      return "ISSUED" as const;
    }).catch((err: unknown) => {
      if (err instanceof ActivationRefused) return err;
      throw err;
    });
    if (outcome === "ACTIVATION_UNAVAILABLE") throw unauthenticated("RECOVERY_ACTIVATION_UNAVAILABLE");
    // The transaction rolled back (the activation is still PENDING): close it as refused.
    if (outcome instanceof ActivationRefused) return refuse(outcome.reasonCode, requester.staff_id);
    // Post-use review of the recovery session (the co-signer is the approver of record).
    await this.deps.issuance.recordUse({
      tenantId: this.deps.tenantId,
      holderId: requester.staff_id,
      approverId: cosigner.staff_id,
      subjectKind: "RECOVERY_SESSION",
      subjectRef: act.activation_id,
      now,
      audit: consoleAuditInput({ tenantId: this.deps.tenantId, correlationId: input.correlationId, staffId: requester.staff_id, role: roles[0] ?? null, action: "console.access_review.opened", outcome: "PENDING", reasonCode: "RECOVERY_SESSION_REVIEW_OPENED", occurredAt: now }),
    });
    const expiresAt = new Date(now.getTime() + Math.min(this.policy.idleTimeoutSeconds, this.policy.sessionLifetimeSeconds) * 1000);
    return { token, expiresAt, idleTimeoutSeconds: this.policy.idleTimeoutSeconds, staffId: requester.staff_id, roles };
  }

  private async signatureValid(jws: string, identity: IdentityRow, activationId: string, expectedChallengeHash: string, now: Date): Promise<boolean> {
    const p = await verifiedPayload(jws, identity.public_jwk, RECOVERY_SIGNATURE_TYP, SignedPayload);
    if (!p) return false;
    const ageMs = now.getTime() - p.iat * 1000;
    return (
      p.tenant === this.deps.tenantId &&
      p.activationId === activationId &&
      p.identityId === identity.identity_id &&
      challengeHash(p.challenge) === expectedChallengeHash &&
      ageMs >= -30_000 &&
      ageMs <= this.policy.challengeTtlSeconds * 1000
    );
  }

  private async auditAnonymous(correlationId: string, staffId: string | null, action: string, outcome: AuditEventInput["outcome"], reasonCode: string, now: Date, evidencePointers: string[]): Promise<void> {
    try {
      await this.deps.audit.appendStandalone(consoleAuditInput({ tenantId: this.deps.tenantId, correlationId, staffId, role: null, action, outcome, reasonCode, occurredAt: now, evidencePointers }));
    } catch {
      // The refusal stands either way; the activation row records the outcome durably.
    }
  }
}

/** Builds a custodian's signature over an activation challenge (operator tooling and tests). */
export async function signRecoveryChallenge(input: { privateKey: Parameters<CompactSign["sign"]>[0]; tenantId: string; activationId: string; challenge: string; identityId: string; now: Date }): Promise<string> {
  const payload = { aud: RECOVERY_AUDIENCE, tenant: input.tenantId, activationId: input.activationId, challenge: input.challenge, identityId: input.identityId, iat: Math.floor(input.now.getTime() / 1000) };
  return new CompactSign(new TextEncoder().encode(JSON.stringify(payload))).setProtectedHeader({ alg: "ES256", typ: RECOVERY_SIGNATURE_TYP }).sign(input.privateKey);
}

/** Builds the holder's enrollment confirmation (operator tooling and tests): signed by the enrolled key. */
export async function signRecoveryEnrollment(input: { privateKey: Parameters<CompactSign["sign"]>[0]; tenantId: string; identityId: string; staffId: string; keyThumbprint: string; challenge: string; now: Date }): Promise<string> {
  const payload = { aud: RECOVERY_AUDIENCE, purpose: "enrollment", tenant: input.tenantId, identityId: input.identityId, staffId: input.staffId, keyThumbprint: input.keyThumbprint, challenge: input.challenge, iat: Math.floor(input.now.getTime() / 1000) };
  return new CompactSign(new TextEncoder().encode(JSON.stringify(payload))).setProtectedHeader({ alg: "ES256", typ: RECOVERY_ENROLL_TYP }).sign(input.privateKey);
}

/** Builds a custodian's signed activation request (operator tooling and tests): a fresh single-use nonce. */
export async function signRecoveryRequest(input: { privateKey: Parameters<CompactSign["sign"]>[0]; tenantId: string; identityId: string; now: Date; nonce?: string }): Promise<string> {
  const payload = { aud: RECOVERY_AUDIENCE, purpose: "activation_request", tenant: input.tenantId, identityId: input.identityId, nonce: input.nonce ?? randomBytes(32).toString("base64url"), iat: Math.floor(input.now.getTime() / 1000) };
  return new CompactSign(new TextEncoder().encode(JSON.stringify(payload))).setProtectedHeader({ alg: "ES256", typ: RECOVERY_REQUEST_TYP }).sign(input.privateKey);
}

/** RFC 7638 thumbprint of a recovery public key (for display and the uniqueness constraint). */
export async function recoveryKeyThumbprint(jwk: C.RecoveryPublicJwk): Promise<string> {
  return calculateJwkThumbprint({ ...jwk }, "sha256");
}
