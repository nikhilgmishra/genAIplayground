/**
 * Break-glass issuance workflow and post-use access reviews (WP-05; follow-on FO-05-45, FO-05-44;
 * spec section 7: emergency access is human-controlled, time-bound, justified, approved by someone else
 * and reviewed; the model can never request or grant it).
 *
 *   request   any non-auditor staff member files a request (justification code from the policy catalogue,
 *             duration bounded by the policy maximum, an operator reason). It grants nothing.
 *   decide    a security_admin who is NOT the requester approves or rejects it before `decideBy`. Approval
 *             writes the grant row (migration 0900 `console_break_glass_grants`: approved_by = decider,
 *             staff_id = requester, expires_at = now + requested duration) in the SAME transaction as the
 *             decision and its audit event. The database refuses a self-decided request and a self-granted
 *             grant independently of this code (CHECK and RLS).
 *   use       the console policy allows `requiresBreakGlass` actions only under a valid grant and returns the
 *             BREAK_GLASS_REVIEW obligation; the console then opens the post-use review task (first use) in
 *             the same transaction as the use's audit event, and refuses the access when it cannot (fail closed).
 *   review    a security_admin who is neither the holder nor the approver completes the review with an
 *             outcome and a reason code.
 * Grants still expire by time only; revocation stays possible through the 0900 one-time revocation.
 */
import type { AuditWriter } from "../audit/ports.js";
import type { Db, Queryable } from "../db/types.js";
import type { AuditEventInput } from "../protocol/index.js";
import { iso } from "../shared/clock.js";
import { newId } from "../shared/ids.js";
import type * as C from "./contract.js";
import { conflict, forbidden, notFound } from "./errors.js";

/** Pending requests must be decided within this window. */
export const BREAK_GLASS_DECISION_WINDOW_SECONDS = 3_600;
/** Post-use reviews are due this long after the first use. */
export const ACCESS_REVIEW_DUE_SECONDS = 72 * 3_600;

interface RequestRow {
  request_id: string;
  requested_by: string;
  justification_code: C.BreakGlassJustificationCode;
  requested_duration_seconds: number;
  requested_at: Date | string;
  decide_by: Date | string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  decided_by: string | null;
  decided_at: Date | string | null;
  grant_id: string | null;
  grant_expires_at: Date | string | null;
}

interface ReviewRow {
  review_id: string;
  subject_kind: C.AccessReviewSubject;
  subject_ref: string;
  holder_staff_id: string;
  approver_staff_id: string | null;
  opened_at: Date | string;
  due_at: Date | string;
  status: "OPEN" | "COMPLETED";
  outcome: C.AccessReviewOutcome | null;
  reviewer_staff_id: string | null;
  completed_at: Date | string | null;
}

const isoOf = (v: Date | string): string => new Date(v).toISOString();
const isoOrNull = (v: Date | string | null): string | null => (v === null ? null : new Date(v).toISOString());

function requestView(r: RequestRow, now: Date): C.BreakGlassRequestView {
  const expired = r.status === "PENDING" && new Date(r.decide_by).getTime() <= now.getTime();
  return {
    requestId: r.request_id,
    requestedBy: r.requested_by,
    justificationCode: r.justification_code,
    durationSeconds: r.requested_duration_seconds,
    requestedAt: isoOf(r.requested_at),
    decideBy: isoOf(r.decide_by),
    status: expired ? "EXPIRED" : r.status,
    decidedBy: r.decided_by,
    decidedAt: isoOrNull(r.decided_at),
    grantId: r.grant_id,
    grantExpiresAt: isoOrNull(r.grant_expires_at),
  };
}

function reviewView(r: ReviewRow): C.AccessReviewView {
  return {
    reviewId: r.review_id,
    subjectKind: r.subject_kind,
    subjectRef: r.subject_ref,
    holderStaffId: r.holder_staff_id,
    approverStaffId: r.approver_staff_id,
    openedAt: isoOf(r.opened_at),
    dueAt: isoOf(r.due_at),
    status: r.status,
    outcome: r.outcome,
    reviewerStaffId: r.reviewer_staff_id,
    completedAt: isoOrNull(r.completed_at),
  };
}

const REQUEST_SELECT = `select r.request_id, r.requested_by, r.justification_code, r.requested_duration_seconds, r.requested_at, r.decide_by, r.status,
        r.decided_by, r.decided_at, r.grant_id, g.expires_at as grant_expires_at
   from console_break_glass_requests r left join console_break_glass_grants g on g.grant_id = r.grant_id`;

const REVIEW_SELECT = `select review_id, subject_kind, subject_ref, holder_staff_id, approver_staff_id, opened_at, due_at, status, outcome,
        reviewer_staff_id, completed_at from console_access_reviews`;

/** Internal: a concurrent first use won the race; the losing transaction is rolled back. */
class FirstUseAlreadyRecorded extends Error {
  constructor() {
    super("FIRST_USE_ALREADY_RECORDED");
  }
}

export class PgBreakGlassIssuance {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditWriter,
    private readonly maxDurationSeconds: number,
  ) {}

  private tx<T>(tenantId: string, staffId: string, fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.db.tx(fn, { role: "app_console", rls: { tenantId, actorId: staffId } });
  }

  async request(input: { tenantId: string; staffId: string; body: C.BreakGlassRequestCreate; now: Date; audit: AuditEventInput }): Promise<C.BreakGlassRequestView> {
    if (input.body.durationSeconds > this.maxDurationSeconds) throw forbidden("BREAK_GLASS_DURATION_EXCEEDED");
    const requestId = newId("bgr", 24);
    const decideBy = new Date(input.now.getTime() + BREAK_GLASS_DECISION_WINDOW_SECONDS * 1000);
    return this.tx(input.tenantId, input.staffId, async (tx) => {
      const ev = await this.audit.append(tx, input.audit);
      await tx.query(
        `insert into console_break_glass_requests (request_id, tenant_id, requested_by, justification_code, reason, requested_duration_seconds,
           requested_at, decide_by, status, request_audit_event_id)
         values ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, 'PENDING', $9)`,
        [requestId, input.tenantId, input.staffId, input.body.justificationCode, input.body.reason, input.body.durationSeconds, iso(input.now), iso(decideBy), ev.eventId],
      );
      const r = (await tx.query<RequestRow>(`${REQUEST_SELECT} where r.request_id = $1`, [requestId])).rows[0];
      if (!r) throw notFound("NOT_FOUND");
      return requestView(r, input.now);
    });
  }

  /** The request (for the decision's policy check: initiator = requester). */
  async get(tenantId: string, staffId: string, requestId: string, now: Date): Promise<C.BreakGlassRequestView | null> {
    const r = await this.tx(tenantId, staffId, (tx) => tx.query<RequestRow>(`${REQUEST_SELECT} where r.request_id = $1`, [requestId]));
    return r.rows[0] ? requestView(r.rows[0], now) : null;
  }

  /** Own requests; with `allPending`, the tenant's pending requests too (security_admin queue). */
  async list(tenantId: string, staffId: string, now: Date, allPending: boolean): Promise<C.BreakGlassRequestView[]> {
    const r = await this.tx(tenantId, staffId, (tx) =>
      tx.query<RequestRow>(`${REQUEST_SELECT} where r.requested_by = $1 or ($2::boolean and r.status = 'PENDING' and r.decide_by > $3::timestamptz) order by r.requested_at desc limit 200`, [staffId, allPending, iso(now)]),
    );
    return r.rows.map((x) => requestView(x, now));
  }

  /** Independent decision; approval issues the grant in the same transaction as the decision and its audit event. */
  async decide(input: { tenantId: string; deciderId: string; requestId: string; body: C.BreakGlassDecisionRequest; now: Date; audit: AuditEventInput }): Promise<C.BreakGlassRequestView> {
    return this.tx(input.tenantId, input.deciderId, async (tx) => {
      // Read first: the decide policy (RLS) hides a request from its own requester for update, so the lock
      // below would answer "not found" to them; the explicit refusal is the honest reason.
      const seen = (await tx.query<RequestRow>(`${REQUEST_SELECT} where r.request_id = $1`, [input.requestId])).rows[0];
      if (!seen) throw notFound("NOT_FOUND");
      if (seen.requested_by === input.deciderId) throw forbidden("SELF_APPROVAL_PROHIBITED");
      const cur = (await tx.query<RequestRow>(`${REQUEST_SELECT} where r.request_id = $1 for update of r`, [input.requestId])).rows[0];
      if (!cur) throw notFound("NOT_FOUND");
      if (cur.status !== "PENDING") throw conflict("BREAK_GLASS_REQUEST_DECIDED");
      if (new Date(cur.decide_by).getTime() <= input.now.getTime()) throw conflict("BREAK_GLASS_REQUEST_EXPIRED");
      const ev = await this.audit.append(tx, input.audit);
      let grantId: string | null = null;
      if (input.body.decision === "APPROVE") {
        grantId = newId("bgl", 24);
        const expiresAt = new Date(input.now.getTime() + cur.requested_duration_seconds * 1000);
        await tx.query(
          `insert into console_break_glass_grants (grant_id, tenant_id, staff_id, approved_by, justification_code, granted_at, expires_at, recorded_at)
           values ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, $6::timestamptz)`,
          [grantId, input.tenantId, cur.requested_by, input.deciderId, cur.justification_code, iso(input.now), iso(expiresAt)],
        );
      }
      await tx.query(
        `update console_break_glass_requests set status = $2, decided_by = $3, decided_at = $4::timestamptz, decision_reason = $5, grant_id = $6, decision_audit_event_id = $7
          where request_id = $1`,
        [input.requestId, input.body.decision === "APPROVE" ? "APPROVED" : "REJECTED", input.deciderId, iso(input.now), input.body.reason, grantId, ev.eventId],
      );
      const r = (await tx.query<RequestRow>(`${REQUEST_SELECT} where r.request_id = $1`, [input.requestId])).rows[0];
      if (!r) throw notFound("NOT_FOUND");
      return requestView(r, input.now);
    });
  }

  /**
   * First use of a grant (or a recovery session): opens the post-use review task in the same transaction as
   * the first use's audit event. Idempotent per subject (a later use neither re-opens nor re-audits it).
   * Concurrent first uses (two connections) open exactly one review and commit exactly one first-use audit
   * event: the loser's insert waits on the unique key, finds the winner's row and rolls its own audit event
   * back. Throws (and the caller refuses the access) when it cannot.
   */
  async recordUse(input: { tenantId: string; holderId: string; approverId: string | null; subjectKind: C.AccessReviewSubject; subjectRef: string; now: Date; audit: AuditEventInput }): Promise<{ reviewId: string; auditEventId: string | null }> {
    const existingReview = (tx: Queryable) =>
      tx.query<{ review_id: string }>("select review_id from console_access_reviews where tenant_id = $1 and subject_kind = $2 and subject_ref = $3", [input.tenantId, input.subjectKind, input.subjectRef]);
    try {
      return await this.tx(input.tenantId, input.holderId, async (tx) => {
        const existing = (await existingReview(tx)).rows[0];
        // Later uses are audited by the endpoint itself; the review already covers the grant.
        if (existing) return { reviewId: existing.review_id, auditEventId: null };
        const ev = await this.audit.append(tx, input.audit);
        const inserted = await tx.query<{ review_id: string }>(
          `insert into console_access_reviews (review_id, tenant_id, subject_kind, subject_ref, holder_staff_id, approver_staff_id, opened_at, due_at, first_use_audit_event_id, status)
           values ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9, 'OPEN')
           on conflict (tenant_id, subject_kind, subject_ref) do nothing
           returning review_id`,
          [newId("acr", 24), input.tenantId, input.subjectKind, input.subjectRef, input.holderId, input.approverId, iso(input.now), iso(new Date(input.now.getTime() + ACCESS_REVIEW_DUE_SECONDS * 1000)), ev.eventId],
        );
        const row = inserted.rows[0];
        // A concurrent first use committed the review: roll this transaction (and its audit event) back.
        if (!row) throw new FirstUseAlreadyRecorded();
        return { reviewId: row.review_id, auditEventId: ev.eventId };
      });
    } catch (err) {
      if (!(err instanceof FirstUseAlreadyRecorded)) throw err;
      const winner = (await this.tx(input.tenantId, input.holderId, existingReview)).rows[0];
      if (!winner) throw conflict("ACCESS_REVIEW_UNAVAILABLE", true);
      return { reviewId: winner.review_id, auditEventId: null };
    }
  }

  async listReviews(tenantId: string, staffId: string): Promise<C.AccessReviewView[]> {
    const r = await this.tx(tenantId, staffId, (tx) => tx.query<ReviewRow>(`${REVIEW_SELECT} order by (status = 'OPEN') desc, due_at asc limit 200`));
    return r.rows.map(reviewView);
  }

  async getReview(tenantId: string, staffId: string, reviewId: string): Promise<C.AccessReviewView | null> {
    const r = await this.tx(tenantId, staffId, (tx) => tx.query<ReviewRow>(`${REVIEW_SELECT} where review_id = $1`, [reviewId]));
    return r.rows[0] ? reviewView(r.rows[0]) : null;
  }

  /** Independent completion: never by the holder or the approver of the reviewed access. */
  async completeReview(input: { tenantId: string; reviewerId: string; reviewId: string; body: C.AccessReviewCompleteRequest; now: Date; audit: AuditEventInput }): Promise<C.AccessReviewView> {
    return this.tx(input.tenantId, input.reviewerId, async (tx) => {
      const cur = (await tx.query<ReviewRow>(`${REVIEW_SELECT} where review_id = $1 for update`, [input.reviewId])).rows[0];
      if (!cur) throw notFound("NOT_FOUND");
      if (cur.holder_staff_id === input.reviewerId || cur.approver_staff_id === input.reviewerId) throw forbidden("SELF_REVIEW_FORBIDDEN");
      if (cur.status !== "OPEN") throw conflict("ACCESS_REVIEW_COMPLETED");
      const ev = await this.audit.append(tx, input.audit);
      await tx.query(
        `update console_access_reviews set status = 'COMPLETED', outcome = $2, reason = $3, reviewer_staff_id = $4, completed_at = $5::timestamptz, completion_audit_event_id = $6
          where review_id = $1`,
        [input.reviewId, input.body.outcome, input.body.reason, input.reviewerId, iso(input.now), ev.eventId],
      );
      const r = (await tx.query<ReviewRow>(`${REVIEW_SELECT} where review_id = $1`, [input.reviewId])).rows[0];
      if (!r) throw notFound("NOT_FOUND");
      return reviewView(r);
    });
  }
}
