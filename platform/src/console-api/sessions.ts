/**
 * Server-side state of console workforce SSO (WP-05; migration 2050): login transactions and console
 * sessions in PostgreSQL, accessed as app_console under tenant row-level security.
 *
 * Login transactions: the binding of one authorization request (nonce, PKCE challenge, exact redirect URI) travels
 * in the sealed OAuth state (login-state.ts); the unauthenticated start endpoint writes nothing. The exchange
 * records the state's single use (`recordLoginStateUse`, FO-05-10): the first callback that presents a valid state
 * inserts its hash; every later one (a replay, a race, a double submit) finds the row and is refused.
 *
 * Console sessions: the browser holds an opaque bearer `vcs_<43 base64url chars>` (256 random bits);
 * only its sha256 is stored. Every request runs `evaluate` (idle, absolute expiry, revocation, rotation
 * replay) before anything else. Refresh rotates the bearer inside one transaction: the old row is marked
 * rotated only if it is still unrotated and unrevoked (exactly one successor), and a later presentation
 * of the rotated bearer revokes the whole family (refresh-token replay, FO-05-19).
 *
 * Recovery custodians (FO-14-51, FO-14-52): the workforce IdP's answers about a staff member also govern that
 * staff member's dual-controlled recovery identities (migration 2051), in the SAME transaction as the session
 * change and its audit event. The rule fails closed: every TERMINAL path of a staff member's SSO session family
 * (logout, a refused refresh, the refresh-token replay closure, an idle or absolute expiry closure, a directory
 * revocation by the active check) decides once, under a lock on the family's rows (`closeFamily`), with the answer
 * the IdP gave that path:
 *   - ACTIVE (the IdP vouched for this subject now and the mapped roles are known): identities whose roles the
 *     mapping no longer covers are suspended (CUSTODIAN_ROLES_REDUCED), the others stay;
 *   - an answer about the PERSON that covers nothing (another subject, groups that map to no role): every ACTIVE
 *     identity is suspended (CUSTODIAN_OFFBOARDED), whether or not the family was already closed;
 *   - the token refused or inactive (CUSTODIAN_OFFBOARDED) or NO answer (the IdP could not be asked, no refresh
 *     token, an adapter refusal: CUSTODIAN_EVIDENCE_LOST): every ACTIVE identity is suspended when this path closes
 *     the family; on a family another terminal path already closed it decides nothing, because that path decided with
 *     its own answer and revoked the token at the IdP (the refusal of a refresh that was waiting for the IdP when the
 *     family was logged out is that logout's doing).
 * Suspending revokes the staff member's live RECOVERY sessions too; only a new SSO sign-in (MFA) whose mapped roles
 * cover a SUSPENDED identity reinstates it. Nothing else explains an inactive token: not the token's known expiry,
 * not a refresh of the row that may have redeemed it, not another sign-in's logout. The one non-terminal exception is
 * the active check of a request that lost a refresh race on a still-live family (its row rotated by a committed
 * refresh, or a refresh of it claimed within the in-flight window): it is refused retryable and closes nothing; the
 * refresh decides by its own outcome (a rotation carries the IdP's positive answer, a refusal closes the family). Every
 * OIDC_SSO row records the holder's latest positive IdP evidence (`active_checked_at`: sign-in, refresh or positive
 * active check) with the roles mapped then; recovery.ts requires it to be recent.
 */
import { randomBytes } from "node:crypto";
import type { AuditEventInput } from "../protocol/index.js";
import type { AuditWriter } from "../audit/ports.js";
import type { Db, Queryable } from "../db/types.js";
import { sha256Hex } from "../shared/canonical.js";
import { iso } from "../shared/clock.js";
import { newId } from "../shared/ids.js";
import type { StaffRole } from "../protocol/index.js";
import type { SealedToken } from "./token-sealer.js";

export const CONSOLE_SESSION_TOKEN = /^vcs_[A-Za-z0-9_-]{43}$/;

export const newConsoleSessionToken = (): string => `vcs_${randomBytes(32).toString("base64url")}`;
export const consoleSessionHash = (token: string): string => sha256Hex(`vsp.console-session.v1|${token}`);
export const stateHashOf = (state: string): string => sha256Hex(`vsp.console-login-state.v1|${state}`);
export const nonceHashOf = (nonce: string): string => sha256Hex(nonce);
export const issuerDigestOf = (issuer: string): string => sha256Hex(`vsp.issuer.v1|${issuer}`);
export const subjectDigestOf = (issuer: string, subject: string): string => sha256Hex(`vsp.subject.v1|${issuer}\u0000${subject}`);

export interface LoginTransactionRow {
  stateHash: string;
  tenantId: string;
  issuerDigest: string;
  nonceHash: string;
  codeChallenge: string;
  redirectUri: string;
  createdAt: Date;
  expiresAt: Date;
}

export type SessionKind = "OIDC_SSO" | "RECOVERY";

export interface ConsoleSessionRow {
  sessionHash: string;
  familyId: string;
  generation: number;
  kind: SessionKind;
  tenantId: string;
  staffId: string;
  issuerDigest: string;
  subjectDigest: string;
  roles: StaffRole[];
  amr: string[];
  authenticatedAt: Date;
  authTimeEpoch: number | null;
  nonceHash: string | null;
  createdAt: Date;
  lastActivityAt: Date;
  idleTimeoutSeconds: number;
  absoluteExpiresAt: Date;
  activeCheckedAt: Date;
  refresh: SealedToken | null;
  refreshExpiresAt: Date | null;
  rotatedAt: Date | null;
  rotatedTo: string | null;
  revokedAt: Date | null;
  revokeReason: string | null;
  auditEventId: string;
}

interface SessionDbRow {
  session_hash: string;
  family_id: string;
  generation: number;
  kind: SessionKind;
  tenant_id: string;
  staff_id: string;
  issuer_digest: string;
  subject_digest: string;
  roles: StaffRole[];
  amr: string[];
  authenticated_at: Date | string;
  auth_time_epoch: string | number | null;
  nonce_hash: string | null;
  created_at: Date | string;
  last_activity_at: Date | string;
  idle_timeout_seconds: number;
  absolute_expires_at: Date | string;
  active_checked_at: Date | string;
  refresh_ciphertext: Uint8Array | null;
  refresh_iv: Uint8Array | null;
  refresh_tag: Uint8Array | null;
  refresh_key_id: string | null;
  refresh_expires_at: Date | string | null;
  rotated_at: Date | string | null;
  rotated_to: string | null;
  revoked_at: Date | string | null;
  revoke_reason: string | null;
  audit_event_id: string;
}

const d = (v: Date | string): Date => new Date(v);
const dn = (v: Date | string | null): Date | null => (v === null ? null : new Date(v));
const buf = (v: Uint8Array | null): Buffer | null => (v === null ? null : Buffer.from(v));

function rowOf(r: SessionDbRow): ConsoleSessionRow {
  const ct = buf(r.refresh_ciphertext);
  const iv = buf(r.refresh_iv);
  const tag = buf(r.refresh_tag);
  return {
    sessionHash: r.session_hash,
    familyId: r.family_id,
    generation: r.generation,
    kind: r.kind,
    tenantId: r.tenant_id,
    staffId: r.staff_id,
    issuerDigest: r.issuer_digest,
    subjectDigest: r.subject_digest,
    roles: [...r.roles],
    amr: [...r.amr],
    authenticatedAt: d(r.authenticated_at),
    authTimeEpoch: r.auth_time_epoch === null ? null : Number(r.auth_time_epoch),
    nonceHash: r.nonce_hash,
    createdAt: d(r.created_at),
    lastActivityAt: d(r.last_activity_at),
    idleTimeoutSeconds: r.idle_timeout_seconds,
    absoluteExpiresAt: d(r.absolute_expires_at),
    activeCheckedAt: d(r.active_checked_at),
    refresh: ct && iv && tag && r.refresh_key_id ? { ciphertext: ct, iv, tag, keyId: r.refresh_key_id } : null,
    refreshExpiresAt: dn(r.refresh_expires_at),
    rotatedAt: dn(r.rotated_at),
    rotatedTo: r.rotated_to,
    revokedAt: dn(r.revoked_at),
    revokeReason: r.revoke_reason,
    auditEventId: r.audit_event_id,
  };
}

const SESSION_COLUMNS = `session_hash, family_id, generation, kind, tenant_id, staff_id, issuer_digest, subject_digest, roles, amr,
  authenticated_at, auth_time_epoch, nonce_hash, created_at, last_activity_at, idle_timeout_seconds, absolute_expires_at,
  active_checked_at, refresh_ciphertext, refresh_iv, refresh_tag, refresh_key_id, refresh_expires_at, rotated_at, rotated_to,
  revoked_at, revoke_reason, audit_event_id`;

export type NewSession = Omit<ConsoleSessionRow, "rotatedAt" | "rotatedTo" | "revokedAt" | "revokeReason" | "auditEventId">;

/** Suspension reason when the workforce IdP no longer vouches for a recovery custodian. */
export const CUSTODIAN_OFFBOARDED = "CUSTODIAN_OFFBOARDED";
/** Suspension reason when the directory no longer maps a role a recovery identity carries. */
export const CUSTODIAN_ROLES_REDUCED = "CUSTODIAN_ROLES_REDUCED";
/** Suspension reason when a terminal path of the custodian's SSO session got no IdP answer at all (fail closed). */
export const CUSTODIAN_EVIDENCE_LOST = "CUSTODIAN_EVIDENCE_LOST";

/**
 * What the IdP said about the person at a terminal path of their SSO session family (the custodian decision,
 * `closeFamily`). Only ACTIVE keeps a covered identity; every other answer suspends (see the module comment).
 */
export type CustodianAnswer =
  /** The IdP vouched for the session's subject now (active introspection, a redeemed refresh) with these mapped roles. */
  | { kind: "ACTIVE"; roles: StaffRole[] }
  /** An answer about the person that covers nothing: another subject, or groups that map to no (or an unknown) role. */
  | { kind: "PERSON_REFUSED" }
  /** The IdP refused or reported inactive this family's token (invalid grant, inactive introspection). */
  | { kind: "TOKEN_INACTIVE" }
  /** No answer: the IdP could not be asked (outage, timeout), the adapter refused, or there is no refresh token. */
  | { kind: "NO_ANSWER" };

/** Outcome of `closeFamily`: this path closed the family, another path had closed it, or a refresh race left it open. */
export type FamilyCloseOutcome = "CLOSED" | "ALREADY_CLOSED" | "REFRESH_RACE";

/** One terminal path's decision request (`PgConsoleSessionStore.closeFamily`). */
export interface FamilyCloseInput {
  tenantId: string;
  familyId: string;
  /** The presented row (the refresh race is judged on it). */
  sessionHash: string;
  staffId: string;
  /** Revoke reason of the rows this path closes. */
  reasonCode: string;
  now: Date;
  answer: CustodianAnswer;
  /** Audit event of the session revocation (same transaction), or null when the caller audits it (logout). */
  sessionAudit: AuditEventInput | null;
  custodian: CustodianAudit;
  /** The active check of a request only: a refresh claimed at or after this instant may still be in flight. */
  refreshRaceSince?: Date;
}

/** What `closeFamily` did: the outcome, the custodian change and the refresh tokens of the unrotated rows it revoked. */
export interface FamilyCloseResult {
  outcome: FamilyCloseOutcome;
  custodian: CustodianChange;
  closedRefresh: { sessionHash: string; refresh: SealedToken }[];
}

/** What changed for a staff member's recovery identities inside one transaction (for the audit event). */
export interface CustodianChange {
  /** Suspension reason of `suspended` (CUSTODIAN_OFFBOARDED, CUSTODIAN_EVIDENCE_LOST or CUSTODIAN_ROLES_REDUCED), null when none. */
  reason: string | null;
  suspended: string[];
  reinstated: string[];
  recoverySessionsRevoked: number;
}

const noCustodianChange = (): CustodianChange => ({ reason: null, suspended: [], reinstated: [], recoverySessionsRevoked: 0 });

/**
 * The holder's latest positive IdP evidence: the newest IdP confirmation (sign-in, refresh or positive active
 * check) over the staff member's OIDC_SSO session rows, with the roles the directory mapped then. Null when the
 * staff member never signed in by SSO (within the session retention).
 */
export async function holderEvidenceWithin(tx: Queryable, staffId: string): Promise<{ confirmedAt: Date; roles: StaffRole[] } | null> {
  // Rows confirmed at the same instant (two sessions, different mappings) are intersected: fail closed on a tie.
  const r = await tx.query<{ active_checked_at: Date | string; roles: StaffRole[] }>(
    `select active_checked_at, roles from console_sessions
      where staff_id = $1 and kind = 'OIDC_SSO'
        and active_checked_at = (select max(active_checked_at) from console_sessions where staff_id = $1 and kind = 'OIDC_SSO')
      limit 16`,
    [staffId],
  );
  const first = r.rows[0];
  if (!first) return null;
  const roles = r.rows.slice(1).reduce<StaffRole[]>((acc, row) => acc.filter((x) => row.roles.includes(x)), [...first.roles]);
  return { confirmedAt: d(first.active_checked_at), roles };
}

/**
 * Suspends every ACTIVE recovery identity of `staffId` and revokes their live RECOVERY sessions, inside the
 * caller's app_console transaction acting for that staff member (migration 2051 trigger and RLS).
 */
export async function suspendCustodianWithin(tx: Queryable, staffId: string, reasonCode: string, now: Date): Promise<CustodianChange> {
  const ids = await tx.query<{ identity_id: string }>(
    "update console_recovery_identities set status = 'SUSPENDED', suspended_at = $2::timestamptz, suspend_reason = $3 where staff_id = $1 and status = 'ACTIVE' returning identity_id",
    [staffId, iso(now), reasonCode],
  );
  const sessions = await tx.query("update console_sessions set revoked_at = $2::timestamptz, revoke_reason = $3 where staff_id = $1 and kind = 'RECOVERY' and revoked_at is null", [staffId, iso(now), reasonCode]);
  return { reason: reasonCode, suspended: ids.rows.map((x) => x.identity_id).sort(), reinstated: [], recoverySessionsRevoked: sessions.rowCount };
}

/**
 * Aligns a staff member's recovery identities with the roles the directory maps NOW: ACTIVE identities carrying a
 * role outside `roles` are suspended (CUSTODIAN_ROLES_REDUCED, with their RECOVERY sessions); when `reinstate`
 * (a new SSO sign-in), SUSPENDED identities whose roles `roles` covers become ACTIVE again.
 */
export async function alignCustodianWithin(tx: Queryable, staffId: string, roles: readonly StaffRole[], now: Date, reinstate: boolean): Promise<CustodianChange> {
  const reduced = await tx.query<{ identity_id: string }>(
    "update console_recovery_identities set status = 'SUSPENDED', suspended_at = $3::timestamptz, suspend_reason = $4 where staff_id = $1 and status = 'ACTIVE' and not (roles <@ $2::text[]) returning identity_id",
    [staffId, [...roles], iso(now), CUSTODIAN_ROLES_REDUCED],
  );
  let revokedSessions = 0;
  if (reduced.rows.length > 0) {
    const r = await tx.query("update console_sessions set revoked_at = $2::timestamptz, revoke_reason = $3 where staff_id = $1 and kind = 'RECOVERY' and revoked_at is null", [staffId, iso(now), CUSTODIAN_ROLES_REDUCED]);
    revokedSessions = r.rowCount;
  }
  const back = reinstate
    ? await tx.query<{ identity_id: string }>(
        "update console_recovery_identities set status = 'ACTIVE', suspended_at = null, suspend_reason = null where staff_id = $1 and status = 'SUSPENDED' and roles <@ $2::text[] returning identity_id",
        [staffId, [...roles]],
      )
    : { rows: [] as { identity_id: string }[] };
  return {
    reason: reduced.rows.length > 0 ? CUSTODIAN_ROLES_REDUCED : null,
    suspended: reduced.rows.map((x) => x.identity_id).sort(),
    reinstated: back.rows.map((x) => x.identity_id).sort(),
    recoverySessionsRevoked: revokedSessions,
  };
}

/** Audit events for a custodian change (none when nothing changed); built by the caller (actor, correlation). */
export type CustodianAudit = (change: CustodianChange) => AuditEventInput[];

/** Outcome of the per-request lifecycle check (no I/O beyond the row read). */
export type SessionVerdict =
  | { ok: true; row: ConsoleSessionRow }
  | { ok: false; reasonCode: "SESSION_INVALID" | "SESSION_REVOKED" | "SESSION_EXPIRED" | "SESSION_IDLE_EXPIRED" | "SESSION_ROTATED" | "SESSION_TOKEN_REPLAYED"; row: ConsoleSessionRow | null };

/** Pure lifecycle decision over a stored row (AUTH-04): revocation, rotation replay, absolute and idle expiry. */
export function sessionVerdict(row: ConsoleSessionRow | null, now: Date, rotationGraceSeconds: number): SessionVerdict {
  if (!row) return { ok: false, reasonCode: "SESSION_INVALID", row: null };
  if (row.revokedAt !== null) return { ok: false, reasonCode: "SESSION_REVOKED", row };
  if (row.rotatedAt !== null) {
    // A bearer that was rotated by a refresh: in-flight requests within the grace get a retryable refusal;
    // a later presentation is a replay of a superseded credential.
    const inGrace = now.getTime() - row.rotatedAt.getTime() <= rotationGraceSeconds * 1000;
    return { ok: false, reasonCode: inGrace ? "SESSION_ROTATED" : "SESSION_TOKEN_REPLAYED", row };
  }
  if (now.getTime() >= row.absoluteExpiresAt.getTime()) return { ok: false, reasonCode: "SESSION_EXPIRED", row };
  if (now.getTime() - row.lastActivityAt.getTime() > row.idleTimeoutSeconds * 1000) return { ok: false, reasonCode: "SESSION_IDLE_EXPIRED", row };
  return { ok: true, row };
}

export class PgConsoleSessionStore {
  constructor(private readonly db: Db) {}

  private tx<T>(tenantId: string, actorId: string | null, fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.db.tx(fn, { role: "app_console", rls: { tenantId, actorId } });
  }

  /**
   * Records the single use of a sealed login state at the exchange: inserts its row already consumed. Returns
   * ALREADY_USED when the state was presented before (replay, race, double submit): the first presentation wins.
   * Only states the backend issued and that are unexpired get here, so the table holds at most one state lifetime
   * of exchanges; `purgeLoginTransactions` deletes rows once their state has expired.
   */
  async recordLoginStateUse(t: LoginTransactionRow, now: Date): Promise<"RECORDED" | "ALREADY_USED"> {
    const r = await this.tx(t.tenantId, null, (tx) =>
      tx.query(
        `insert into console_login_transactions (state_hash, tenant_id, issuer_digest, nonce_hash, code_challenge, redirect_uri, created_at, expires_at, consumed_at, outcome)
         values ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9::timestamptz, 'CONSUMED')
         on conflict (state_hash) do nothing`,
        [t.stateHash, t.tenantId, t.issuerDigest, t.nonceHash, t.codeChallenge, t.redirectUri, iso(t.createdAt), iso(t.expiresAt), iso(now)],
      ),
    );
    return r.rowCount === 1 ? "RECORDED" : "ALREADY_USED";
  }

  /**
   * Deletes login transactions that can no longer be used (expired before `before`, consumed or not), at most
   * `limit` per call. Safe at any time: an unknown state and a consumed one are refused alike. The database
   * refuses to delete an unexpired one (migration 2052), so the cutoff is also bounded by the database clock.
   */
  async purgeLoginTransactions(tenantId: string, before: Date, limit: number): Promise<number> {
    const r = await this.tx(tenantId, null, (tx) =>
      tx.query(
        `delete from console_login_transactions where state_hash in (
           select state_hash from console_login_transactions
            where tenant_id = $1 and expires_at < least($2::timestamptz, now()) order by expires_at limit $3)`,
        [tenantId, iso(before), limit],
      ),
    );
    return r.rowCount;
  }

  async load(tenantId: string, sessionHash: string): Promise<ConsoleSessionRow | null> {
    const r = await this.tx(tenantId, null, (tx) => tx.query<SessionDbRow>(`select ${SESSION_COLUMNS} from console_sessions where session_hash = $1`, [sessionHash]));
    const row = r.rows[0];
    return row ? rowOf(row) : null;
  }

  /**
   * Inserts a session and its audit event in one transaction (the audit event must succeed first, OPS-01). With
   * `custodian` (an OIDC_SSO sign-in), the staff member's recovery identities are aligned with the session's
   * roles in the same transaction (reinstating SUSPENDED ones the roles cover) and the change is audited.
   */
  async insert(audit: AuditWriter, s: NewSession, auditInput: AuditEventInput, custodian?: CustodianAudit): Promise<ConsoleSessionRow> {
    return this.tx(s.tenantId, s.staffId, async (tx) => {
      const row = await this.insertWithin(tx, audit, s, auditInput);
      if (custodian && s.kind === "OIDC_SSO") await this.appendCustodian(tx, audit, await alignCustodianWithin(tx, s.staffId, s.roles, s.createdAt, true), custodian);
      return row;
    });
  }

  private async appendCustodian(tx: Queryable, audit: AuditWriter, change: CustodianChange, build: CustodianAudit): Promise<void> {
    if (change.suspended.length === 0 && change.reinstated.length === 0 && change.recoverySessionsRevoked === 0) return;
    for (const ev of build(change)) await audit.append(tx, ev);
  }

  /**
   * The custodian decision of a TERMINAL path of an SSO session family (FO-14-52; module comment): logout, a refused
   * refresh, the replay closure, an idle or absolute expiry closure, a directory revocation. Under a lock on the
   * family's rows: when the family is still open it is revoked with `reasonCode` (and `sessionAudit`, same
   * transaction) and the staff member's recovery identities follow `answer`: ACTIVE suspends only the identities the
   * mapped roles no longer cover (CUSTODIAN_ROLES_REDUCED), every other answer suspends them all
   * (CUSTODIAN_OFFBOARDED; CUSTODIAN_EVIDENCE_LOST for NO_ANSWER). When another terminal path already closed the
   * family (ALREADY_CLOSED), that path decided with its own answer: only an answer about the person (ACTIVE roles,
   * PERSON_REFUSED) still applies; a token state or a missing answer decides nothing more.
   *
   * `refreshRaceSince` (the active check of a request only): when the presented row was rotated by a committed
   * refresh, or a refresh of it was claimed at or after that instant and has not finished, the request lost a refresh
   * race on a live family: nothing is written (REFRESH_RACE) and the refresh decides by its own outcome.
   *
   * Returns the sealed refresh tokens of the unrotated rows this call revoked (the caller revokes them at the IdP).
   */
  async closeFamily(audit: AuditWriter, input: FamilyCloseInput): Promise<FamilyCloseResult> {
    return this.tx(input.tenantId, input.staffId, async (tx) => {
      const rows = (
        await tx.query<{ session_hash: string; revoked_at: Date | string | null; rotated_at: Date | string | null; refresh_started_at: Date | string | null }>(
          "select session_hash, revoked_at, rotated_at, refresh_started_at from console_sessions where family_id = $1 order by generation for update",
          [input.familyId],
        )
      ).rows;
      const open = rows.some((r) => r.revoked_at === null);
      if (open && input.refreshRaceSince) {
        const presented = rows.find((r) => r.session_hash === input.sessionHash);
        const racing = presented !== undefined && (presented.rotated_at !== null || (presented.refresh_started_at !== null && d(presented.refresh_started_at).getTime() >= input.refreshRaceSince.getTime()));
        if (racing) return { outcome: "REFRESH_RACE" as const, custodian: noCustodianChange(), closedRefresh: [] };
      }
      let closedRefresh: { sessionHash: string; refresh: SealedToken }[] = [];
      if (open) {
        const r = await tx.query<{ session_hash: string; rotated_at: Date | string | null; refresh_ciphertext: Uint8Array | null; refresh_iv: Uint8Array | null; refresh_tag: Uint8Array | null; refresh_key_id: string | null }>(
          `update console_sessions set revoked_at = $2::timestamptz, revoke_reason = $3 where family_id = $1 and revoked_at is null
           returning session_hash, rotated_at, refresh_ciphertext, refresh_iv, refresh_tag, refresh_key_id`,
          [input.familyId, iso(input.now), input.reasonCode],
        );
        closedRefresh = r.rows.flatMap((x) => {
          const ct = buf(x.refresh_ciphertext);
          const iv = buf(x.refresh_iv);
          const tag = buf(x.refresh_tag);
          return x.rotated_at === null && ct && iv && tag && x.refresh_key_id ? [{ sessionHash: x.session_hash, refresh: { ciphertext: ct, iv, tag, keyId: x.refresh_key_id } }] : [];
        });
        if (input.sessionAudit) await audit.append(tx, input.sessionAudit);
      }
      const a = input.answer;
      const change =
        a.kind === "ACTIVE"
          ? await alignCustodianWithin(tx, input.staffId, a.roles, input.now, false)
          : a.kind === "PERSON_REFUSED"
            ? await suspendCustodianWithin(tx, input.staffId, CUSTODIAN_OFFBOARDED, input.now)
            : open
              ? await suspendCustodianWithin(tx, input.staffId, a.kind === "TOKEN_INACTIVE" ? CUSTODIAN_OFFBOARDED : CUSTODIAN_EVIDENCE_LOST, input.now)
              : noCustodianChange();
      await this.appendCustodian(tx, audit, change, input.custodian);
      return { outcome: open ? ("CLOSED" as const) : ("ALREADY_CLOSED" as const), custodian: change, closedRefresh };
    });
  }

  /** Offboarding signal without a session to revoke (an IdP-authenticated sign-in the directory refuses). */
  async suspendCustodian(audit: AuditWriter, input: { tenantId: string; staffId: string; now: Date; custodian: CustodianAudit }): Promise<CustodianChange> {
    return this.tx(input.tenantId, input.staffId, async (tx) => {
      const change = await suspendCustodianWithin(tx, input.staffId, CUSTODIAN_OFFBOARDED, input.now);
      await this.appendCustodian(tx, audit, change, input.custodian);
      return change;
    });
  }

  /** The family's live row (unrevoked, unrotated), the one whose refresh token the IdP is asked about at a replay. */
  async liveRowOfFamily(tenantId: string, familyId: string): Promise<ConsoleSessionRow | null> {
    const r = await this.tx(tenantId, null, (tx) =>
      tx.query<SessionDbRow>(`select ${SESSION_COLUMNS} from console_sessions where family_id = $1 and revoked_at is null and rotated_at is null order by generation desc limit 1`, [familyId]),
    );
    const row = r.rows[0];
    return row ? rowOf(row) : null;
  }

  /**
   * Marks a refresh of `sessionHash` as in flight (claimed at `now`) before the IdP is asked to redeem its refresh
   * token. Fails (false) when the row is rotated or revoked, or another refresh of it was claimed after `staleBefore`
   * and is still in flight: at most one refresh per row reaches the IdP at a time (a crashed refresh's claim lapses).
   */
  async claimRefresh(tenantId: string, sessionHash: string, now: Date, staleBefore: Date): Promise<boolean> {
    const r = await this.tx(tenantId, null, (tx) =>
      tx.query(
        `update console_sessions set refresh_started_at = $2::timestamptz
          where session_hash = $1 and rotated_at is null and revoked_at is null
            and (refresh_started_at is null or refresh_started_at < $3::timestamptz)`,
        [sessionHash, iso(now), iso(staleBefore)],
      ),
    );
    return r.rowCount === 1;
  }

  /** A refresh claimed at `claimedAt` ended without a redemption the backend recorded: its own claim is released. */
  async releaseRefreshClaim(tenantId: string, sessionHash: string, claimedAt: Date): Promise<void> {
    await this.tx(tenantId, null, (tx) =>
      tx.query("update console_sessions set refresh_started_at = null where session_hash = $1 and rotated_at is null and refresh_started_at = $2::timestamptz", [sessionHash, iso(claimedAt)]),
    );
  }

  /**
   * Same as `insert`, inside a caller's app_console transaction (RLS actor = the session's staff member), so a
   * session can be issued atomically with the facts that justify it (recovery activation, recovery.ts).
   */
  async insertWithin(tx: Queryable, audit: AuditWriter, s: NewSession, auditInput: AuditEventInput): Promise<ConsoleSessionRow> {
    const ev = await audit.append(tx, auditInput);
    await this.insertRow(tx, s, ev.eventId);
    return { ...s, rotatedAt: null, rotatedTo: null, revokedAt: null, revokeReason: null, auditEventId: ev.eventId };
  }

  /**
   * Revokes every live RECOVERY session bound to one recovery identity (its subject digest), inside the caller's
   * transaction (identity revocation, recovery.ts). Returns the number revoked.
   */
  async revokeRecoverySessionsWithin(tx: Queryable, subjectDigest: string, reasonCode: string, now: Date): Promise<number> {
    const r = await tx.query(
      `update console_sessions set revoked_at = $2::timestamptz, revoke_reason = $3
        where kind = 'RECOVERY' and subject_digest = $1 and revoked_at is null`,
      [subjectDigest, iso(now), reasonCode],
    );
    return r.rowCount;
  }

  /**
   * The ACTIVE recovery identities of a staff member (migration 2051), for the per-request check of a RECOVERY
   * session: the session is valid only while the identity it was activated with is still ACTIVE.
   */
  async activeRecoveryIdentityIds(tenantId: string, staffId: string): Promise<string[]> {
    const r = await this.tx(tenantId, null, (tx) =>
      tx.query<{ identity_id: string }>("select identity_id from console_recovery_identities where staff_id = $1 and status = 'ACTIVE' order by identity_id limit 64", [staffId]),
    );
    return r.rows.map((x) => x.identity_id);
  }

  private async insertRow(tx: Queryable, s: NewSession, auditEventId: string): Promise<void> {
    await tx.query(
      `insert into console_sessions (session_hash, family_id, generation, kind, tenant_id, staff_id, issuer_digest, subject_digest, roles, amr,
         authenticated_at, auth_time_epoch, nonce_hash, created_at, last_activity_at, idle_timeout_seconds, absolute_expires_at, active_checked_at,
         refresh_ciphertext, refresh_iv, refresh_tag, refresh_key_id, refresh_expires_at, audit_event_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10::text[], $11::timestamptz, $12, $13, $14::timestamptz, $15::timestamptz, $16,
               $17::timestamptz, $18::timestamptz, $19, $20, $21, $22, $23::timestamptz, $24)`,
      [
        s.sessionHash,
        s.familyId,
        s.generation,
        s.kind,
        s.tenantId,
        s.staffId,
        s.issuerDigest,
        s.subjectDigest,
        s.roles,
        s.amr,
        iso(s.authenticatedAt),
        s.authTimeEpoch,
        s.nonceHash,
        iso(s.createdAt),
        iso(s.lastActivityAt),
        s.idleTimeoutSeconds,
        iso(s.absoluteExpiresAt),
        iso(s.activeCheckedAt),
        s.refresh?.ciphertext ?? null,
        s.refresh?.iv ?? null,
        s.refresh?.tag ?? null,
        s.refresh?.keyId ?? null,
        s.refreshExpiresAt ? iso(s.refreshExpiresAt) : null,
        auditEventId,
      ],
    );
  }

  /**
   * Replaces `oldHash` by `next` (refresh rotation) atomically: succeeds only while the old row is
   * unrotated and unrevoked, so two concurrent refreshes of one bearer yield exactly one successor.
   */
  async rotate(audit: AuditWriter, tenantId: string, oldHash: string, next: NewSession, now: Date, auditInput: AuditEventInput, custodian?: CustodianAudit): Promise<ConsoleSessionRow | null> {
    return this.tx(tenantId, next.staffId, async (tx) => {
      const r = await tx.query(
        `update console_sessions set rotated_at = $2::timestamptz, rotated_to = $3
          where session_hash = $1 and rotated_at is null and revoked_at is null`,
        [oldHash, iso(now), next.sessionHash],
      );
      if (r.rowCount !== 1) return null;
      const ev = await audit.append(tx, auditInput);
      await this.insertRow(tx, next, ev.eventId);
      // A refresh re-maps the roles: identities the new mapping no longer covers are suspended (never reinstated).
      if (custodian) await this.appendCustodian(tx, audit, await alignCustodianWithin(tx, next.staffId, next.roles, now, false), custodian);
      return { ...next, rotatedAt: null, rotatedTo: null, revokedAt: null, revokeReason: null, auditEventId: ev.eventId };
    });
  }

  /** Records activity with a bounded write rate; never moves the time backwards. */
  async touch(tenantId: string, sessionHash: string, now: Date, minIntervalSeconds: number): Promise<void> {
    await this.tx(tenantId, null, (tx) =>
      tx.query(
        `update console_sessions set last_activity_at = $2::timestamptz
          where session_hash = $1 and revoked_at is null and rotated_at is null
            and last_activity_at <= $2::timestamptz - make_interval(secs => $3)`,
        [sessionHash, iso(now), minIntervalSeconds],
      ),
    );
  }

  /**
   * The IdP confirmed the session active now (optionally with re-mapped roles). With `custodian` (re-mapped roles
   * of an SSO session's staff member), recovery identities whose roles the new mapping no longer covers are
   * suspended in the same transaction (never reinstated here: that needs a new sign-in).
   */
  async markActive(tenantId: string, sessionHash: string, now: Date, roles: StaffRole[] | null, custodian?: { audit: AuditWriter; staffId: string; build: CustodianAudit }): Promise<void> {
    await this.tx(tenantId, custodian?.staffId ?? null, async (tx) => {
      await tx.query(
        `update console_sessions set active_checked_at = greatest(active_checked_at, $2::timestamptz), roles = coalesce($3::text[], roles)
          where session_hash = $1 and revoked_at is null`,
        [sessionHash, iso(now), roles],
      );
      if (custodian && roles) await this.appendCustodian(tx, custodian.audit, await alignCustodianWithin(tx, custodian.staffId, roles, now, false), custodian.build);
    });
  }

  /** Revokes one session (idempotent; the first reason stays). Returns true when this call revoked it. */
  async revoke(tenantId: string, sessionHash: string, reasonCode: string, now: Date): Promise<boolean> {
    const r = await this.tx(tenantId, null, (tx) =>
      tx.query(`update console_sessions set revoked_at = $2::timestamptz, revoke_reason = $3 where session_hash = $1 and revoked_at is null`, [sessionHash, iso(now), reasonCode]),
    );
    return r.rowCount === 1;
  }

  /** Revokes every session of a family (rotation replay, subject change, offboarding). */
  async revokeFamily(tenantId: string, familyId: string, reasonCode: string, now: Date): Promise<number> {
    const r = await this.tx(tenantId, null, (tx) =>
      tx.query(`update console_sessions set revoked_at = $2::timestamptz, revoke_reason = $3 where family_id = $1 and revoked_at is null`, [familyId, iso(now), reasonCode]),
    );
    return r.rowCount;
  }

  /** Revokes every live session of a staff member (offboarding, recovery identity revoked). */
  async revokeStaff(tenantId: string, staffId: string, reasonCode: string, now: Date): Promise<number> {
    const r = await this.tx(tenantId, null, (tx) =>
      tx.query(`update console_sessions set revoked_at = $2::timestamptz, revoke_reason = $3 where staff_id = $1 and revoked_at is null`, [staffId, iso(now), reasonCode]),
    );
    return r.rowCount;
  }

  /** Live (unrevoked, unrotated, unexpired) sessions whose last active-state check is older than `checkedBefore`. */
  async dueForActiveCheck(tenantId: string, checkedBefore: Date, now: Date, limit: number): Promise<ConsoleSessionRow[]> {
    const r = await this.tx(tenantId, null, (tx) =>
      tx.query<SessionDbRow>(
        `select ${SESSION_COLUMNS} from console_sessions
          where revoked_at is null and rotated_at is null and absolute_expires_at > $2::timestamptz and active_checked_at < $1::timestamptz
          order by active_checked_at asc limit $3`,
        [iso(checkedBefore), iso(now), limit],
      ),
    );
    return r.rows.map(rowOf);
  }

  /** Expired-but-unrevoked sessions (idle or absolute), for the sweeper to close with a reason. */
  async expiredUnrevoked(tenantId: string, now: Date, limit: number): Promise<ConsoleSessionRow[]> {
    const r = await this.tx(tenantId, null, (tx) =>
      tx.query<SessionDbRow>(
        `select ${SESSION_COLUMNS} from console_sessions
          where revoked_at is null and rotated_at is null
            and (absolute_expires_at <= $1::timestamptz or last_activity_at + make_interval(secs => idle_timeout_seconds) < $1::timestamptz)
          limit $2`,
        [iso(now), limit],
      ),
    );
    return r.rows.map(rowOf);
  }
}

export const newSessionFamilyId = (): string => newId("csf", 24);
