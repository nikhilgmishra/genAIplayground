/**
 * Console-owned PostgreSQL state (migration 0900). Every write that is an
 * administrative effect runs as app_console with tenant + actor RLS and is
 * paired, in the SAME transaction, with its console audit event (OPS-01).
 *
 * IMPORTANT (PGlite single connection): no function here calls another service
 * that opens its own transaction while a transaction is open.
 */
import { z } from "zod";
import type { AuditWriter } from "../audit/ports.js";
import type { Db, Queryable } from "../db/types.js";
import type { AuditEvent, AuditEventInput, StaffRole } from "../protocol/index.js";
import { canonicalJson, sha256Hex } from "../shared/canonical.js";
import { iso } from "../shared/clock.js";
import { ConflictError, ValidationError } from "../shared/errors.js";
import { newId } from "../shared/ids.js";
import type { EndpointKey, ReconcileResultView, ReleaseKind, ReleaseReviewDecision } from "./contract.js";

/* ------------------------------------------------------------------------ */
/* Audit helper                                                              */
/* ------------------------------------------------------------------------ */

/** `console.<snake_case endpoint>`, e.g. killSwitches.set -> console.kill_switches.set. */
export function auditActionFor(endpoint: EndpointKey): string {
  const snake = endpoint.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  return `console.${snake}`;
}

export interface ConsoleAuditFields {
  tenantId: string;
  correlationId: string;
  staffId: string | null;
  role: StaffRole | null;
  action: string;
  outcome: AuditEventInput["outcome"];
  reasonCode: string | null;
  occurredAt: Date;
  callId?: string | null;
  policyDecision?: AuditEventInput["policyDecision"];
  evidencePointers?: string[];
  beforeHash?: string | null;
  afterHash?: string | null;
  idempotencyKey?: string | null;
}

export function consoleAuditInput(f: ConsoleAuditFields): AuditEventInput {
  return {
    occurredAt: iso(f.occurredAt),
    correlationId: f.correlationId,
    parentId: null,
    tenantId: f.tenantId,
    actorRef: f.staffId,
    subjectRef: null,
    role: f.role,
    sourceComponent: "console",
    callId: f.callId ?? null,
    sessionRef: null,
    sessionGeneration: null,
    turnId: null,
    versions: null,
    action: f.action,
    policyDecision: f.policyDecision ?? null,
    assurance: null,
    evidencePointers: f.evidencePointers ?? [],
    beforeHash: f.beforeHash ?? null,
    afterHash: f.afterHash ?? null,
    idempotencyKey: f.idempotencyKey ?? null,
    outcome: f.outcome,
    reasonCode: f.reasonCode,
    dataClass: "SECURITY_AUDIT",
  };
}

export const consoleTx = <T>(db: Db, tenantId: string, staffId: string, fn: (tx: Queryable) => Promise<T>): Promise<T> =>
  db.tx(fn, { role: "app_console", rls: { tenantId, actorId: staffId } });

/* ------------------------------------------------------------------------ */
/* Idempotency                                                               */
/* ------------------------------------------------------------------------ */

export type IdempotencyLookup =
  | { kind: "new" }
  | { kind: "replay"; status: number; body: unknown }
  | { kind: "in_progress" }
  | { kind: "mismatch" };

export interface IdempotencyScope {
  tenantId: string;
  staffId: string;
  endpoint: EndpointKey;
  key: string;
  requestDigest: string;
}

const keyHash = (key: string): string => sha256Hex(`console-idem:${key}`);

export function requestDigest(endpoint: EndpointKey, params: Record<string, string>, body: unknown): string {
  return sha256Hex(canonicalJson({ endpoint, params, body: body ?? null }));
}

/** First result wins for a repeated Idempotency-Key per staff member and endpoint (24 h). */
export class ConsoleIdempotencyStore {
  constructor(
    private readonly db: Db,
    private readonly ttlSeconds = 86_400,
  ) {}

  /** Reserves the key, or reports a replay / in-flight duplicate / reuse with a different request. */
  async begin(s: IdempotencyScope, now: Date): Promise<IdempotencyLookup> {
    return consoleTx(this.db, s.tenantId, s.staffId, async (tx) => {
      const existing = (
        await tx.query<{ request_digest: string; status: string; response_status: number | null; response_body: unknown; expires_at: Date | string }>(
          `select request_digest, status, response_status, response_body, expires_at from console_idempotency
            where tenant_id = $1 and staff_id = $2 and endpoint = $3 and idempotency_key_hash = $4 for update`,
          [s.tenantId, s.staffId, s.endpoint, keyHash(s.key)],
        )
      ).rows[0];
      if (existing && new Date(existing.expires_at).getTime() > now.getTime()) {
        if (existing.request_digest !== s.requestDigest) return { kind: "mismatch" };
        if (existing.status === "COMPLETED" && existing.response_status !== null) {
          const body = typeof existing.response_body === "string" ? (JSON.parse(existing.response_body) as unknown) : existing.response_body;
          return { kind: "replay", status: existing.response_status, body };
        }
        return { kind: "in_progress" };
      }
      if (existing) {
        await tx.query("delete from console_idempotency where tenant_id = $1 and staff_id = $2 and endpoint = $3 and idempotency_key_hash = $4", [
          s.tenantId,
          s.staffId,
          s.endpoint,
          keyHash(s.key),
        ]);
      }
      await tx.query(
        `insert into console_idempotency (tenant_id, staff_id, endpoint, idempotency_key_hash, request_digest, status, created_at, expires_at)
         values ($1, $2, $3, $4, $5, 'IN_PROGRESS', $6::timestamptz, $7::timestamptz)`,
        [s.tenantId, s.staffId, s.endpoint, keyHash(s.key), s.requestDigest, iso(now), iso(new Date(now.getTime() + this.ttlSeconds * 1000))],
      );
      return { kind: "new" };
    });
  }

  async complete(s: IdempotencyScope, status: number, body: unknown): Promise<void> {
    await consoleTx(this.db, s.tenantId, s.staffId, (tx) =>
      tx.query(
        `update console_idempotency set status = 'COMPLETED', response_status = $5, response_body = $6::jsonb
          where tenant_id = $1 and staff_id = $2 and endpoint = $3 and idempotency_key_hash = $4`,
        [s.tenantId, s.staffId, s.endpoint, keyHash(s.key), status, JSON.stringify(body)],
      ),
    );
  }

  /** A failed request leaves no effect, so its reservation is released and the key may be retried. */
  async release(s: IdempotencyScope): Promise<void> {
    await consoleTx(this.db, s.tenantId, s.staffId, (tx) =>
      tx.query("delete from console_idempotency where tenant_id = $1 and staff_id = $2 and endpoint = $3 and idempotency_key_hash = $4 and status = 'IN_PROGRESS'", [
        s.tenantId,
        s.staffId,
        s.endpoint,
        keyHash(s.key),
      ]),
    );
  }
}

/* ------------------------------------------------------------------------ */
/* Session revocations                                                       */
/* ------------------------------------------------------------------------ */

export class ConsoleSessionRevocations {
  constructor(private readonly db: Db) {}

  async isRevoked(tenantId: string, staffId: string, jtiHash: string): Promise<boolean> {
    const r = await consoleTx(this.db, tenantId, staffId, (tx) => tx.query<{ n: number }>("select 1 as n from console_token_revocations where jti_hash = $1", [jtiHash]));
    return r.rows.length > 0;
  }

  /** Revokes the session and records the logout audit event in the same transaction. */
  async revoke(audit: AuditWriter, input: { tenantId: string; staffId: string; jtiHash: string; tokenExpiresAt: string; now: Date; audit: AuditEventInput }): Promise<AuditEvent> {
    return consoleTx(this.db, input.tenantId, input.staffId, async (tx) => {
      const ev = await audit.append(tx, input.audit);
      await tx.query(
        `insert into console_token_revocations (jti_hash, tenant_id, staff_id, revoked_at, token_expires_at, audit_event_id)
         values ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6) on conflict (jti_hash) do nothing`,
        [input.jtiHash, input.tenantId, input.staffId, iso(input.now), input.tokenExpiresAt, ev.eventId],
      );
      return ev;
    });
  }
}

/* ------------------------------------------------------------------------ */
/* Release submissions (provenance) and reviews                              */
/* ------------------------------------------------------------------------ */

export const DiffEntryInput = z.strictObject({
  ref: z.string().regex(/^[a-z][a-z0-9_.:-]{2,120}$/),
  change: z.enum(["ADDED", "REMOVED", "CHANGED"]),
  summaryCode: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
});

export const ReleaseSubmissionInput = z.strictObject({
  tenantId: z.string().regex(/^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$/),
  kind: z.enum(["POLICY_BUNDLE", "KNOWLEDGE_SNAPSHOT"]),
  version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/),
  previousVersion: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/).nullable(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  submittedBy: z.string().regex(/^stf_[A-Za-z0-9_-]{8,64}$/),
  submittedAt: z.iso.datetime({ offset: false }),
  diff: z.strictObject({
    added: z.number().int().min(0).max(100_000),
    removed: z.number().int().min(0).max(100_000),
    changed: z.number().int().min(0).max(100_000),
    entries: z.array(DiffEntryInput).max(200),
  }),
});
export type ReleaseSubmissionInput = z.infer<typeof ReleaseSubmissionInput>;

export interface ReleaseSubmission extends ReleaseSubmissionInput {
  releaseId: string;
}

export interface ReleaseReviewRecord {
  reviewId: string;
  releaseId: string;
  reviewerStaffId: string;
  reviewerRole: StaffRole;
  decision: ReleaseReviewDecision;
  reason: string;
  at: string;
  auditEventId: string;
}

interface SubmissionRow {
  release_id: string;
  tenant_id: string;
  kind: ReleaseKind;
  version: string;
  previous_version: string | null;
  digest: string;
  submitted_by: string;
  submitted_at: Date | string;
  diff_added: number;
  diff_removed: number;
  diff_changed: number;
  diff_entries: unknown;
}

const toIso = (v: Date | string): string => new Date(v).toISOString();

function rowToSubmission(r: SubmissionRow): ReleaseSubmission {
  const entries = z.array(DiffEntryInput).max(200).safeParse(typeof r.diff_entries === "string" ? JSON.parse(r.diff_entries) : r.diff_entries);
  return {
    releaseId: r.release_id,
    tenantId: r.tenant_id,
    kind: r.kind,
    version: r.version,
    previousVersion: r.previous_version,
    digest: r.digest,
    submittedBy: r.submitted_by,
    submittedAt: toIso(r.submitted_at),
    diff: { added: r.diff_added, removed: r.diff_removed, changed: r.diff_changed, entries: entries.success ? entries.data : [] },
  };
}

/**
 * Release submission registry. `record` is the release pipeline's write path
 * (app_worker; the policy CI job or knowledge release job), never the console's.
 */
export class ReleaseSubmissionRegistryPg {
  constructor(private readonly db: Db) {}

  async record(raw: ReleaseSubmissionInput, now: Date): Promise<ReleaseSubmission> {
    const parsed = ReleaseSubmissionInput.safeParse(raw);
    if (!parsed.success) throw new ValidationError("RELEASE_SUBMISSION_INVALID");
    const s = parsed.data;
    const releaseId = `rel_${sha256Hex(`${s.tenantId}:${s.kind}:${s.digest}`).slice(0, 32)}`;
    await this.db.tx(
      (tx) =>
        tx.query(
          `insert into console_release_submissions (release_id, tenant_id, kind, version, previous_version, digest, submitted_by, submitted_at,
             diff_added, diff_removed, diff_changed, diff_entries, recorded_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9, $10, $11, $12::jsonb, $13::timestamptz)
           on conflict (tenant_id, kind, digest) do nothing`,
          [releaseId, s.tenantId, s.kind, s.version, s.previousVersion, s.digest, s.submittedBy, s.submittedAt, s.diff.added, s.diff.removed, s.diff.changed, JSON.stringify(s.diff.entries), iso(now)],
        ),
      { role: "app_worker", rls: { tenantId: s.tenantId } },
    );
    return { ...s, releaseId };
  }

  async list(tenantId: string, staffId: string, limit = 50): Promise<ReleaseSubmission[]> {
    const rows = await consoleTx(this.db, tenantId, staffId, (tx) =>
      tx.query<SubmissionRow>(
        `select release_id, tenant_id, kind, version, previous_version, digest, submitted_by, submitted_at, diff_added, diff_removed, diff_changed, diff_entries
           from console_release_submissions order by submitted_at desc, release_id limit $1`,
        [Math.min(Math.max(1, limit), 200)],
      ),
    );
    return rows.rows.map(rowToSubmission);
  }

  async get(tenantId: string, staffId: string, releaseId: string): Promise<ReleaseSubmission | null> {
    const rows = await consoleTx(this.db, tenantId, staffId, (tx) =>
      tx.query<SubmissionRow>(
        `select release_id, tenant_id, kind, version, previous_version, digest, submitted_by, submitted_at, diff_added, diff_removed, diff_changed, diff_entries
           from console_release_submissions where release_id = $1`,
        [releaseId],
      ),
    );
    const r = rows.rows[0];
    return r ? rowToSubmission(r) : null;
  }

  async reviewsFor(tenantId: string, staffId: string, releaseIds: readonly string[]): Promise<Map<string, ReleaseReviewRecord[]>> {
    const out = new Map<string, ReleaseReviewRecord[]>();
    if (releaseIds.length === 0) return out;
    const rows = await consoleTx(this.db, tenantId, staffId, (tx) =>
      tx.query<{ review_id: string; release_id: string; reviewer_staff_id: string; reviewer_role: StaffRole; decision: ReleaseReviewDecision; reason: string; reviewed_at: Date | string; audit_event_id: string }>(
        `select review_id, release_id, reviewer_staff_id, reviewer_role, decision, reason, reviewed_at, audit_event_id
           from console_release_reviews where release_id = any($1::text[]) order by reviewed_at, review_id`,
        [[...releaseIds]],
      ),
    );
    for (const r of rows.rows) {
      const list = out.get(r.release_id) ?? [];
      list.push({
        reviewId: r.review_id,
        releaseId: r.release_id,
        reviewerStaffId: r.reviewer_staff_id,
        reviewerRole: r.reviewer_role,
        decision: r.decision,
        reason: r.reason,
        at: toIso(r.reviewed_at),
        auditEventId: r.audit_event_id,
      });
      out.set(r.release_id, list);
    }
    return out;
  }

  /** Records a reviewer opinion and its audit event in one transaction. Never an approval record. */
  async recordReview(
    audit: AuditWriter,
    input: { tenantId: string; staffId: string; role: StaffRole; release: ReleaseSubmission; decision: ReleaseReviewDecision; reason: string; now: Date; auditInput: (reviewId: string) => AuditEventInput },
  ): Promise<{ reviewId: string; auditEventId: string }> {
    const reviewId = newId("rvw");
    return consoleTx(this.db, input.tenantId, input.staffId, async (tx) => {
      const ev = await audit.append(tx, input.auditInput(reviewId));
      await tx.query(
        `insert into console_release_reviews (review_id, tenant_id, release_id, release_digest, reviewer_staff_id, reviewer_role, decision, reason, reviewed_at, audit_event_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10)`,
        [reviewId, input.tenantId, input.release.releaseId, input.release.digest, input.staffId, input.role, input.decision, input.reason, iso(input.now), ev.eventId],
      );
      return { reviewId, auditEventId: ev.eventId };
    });
  }
}

/* ------------------------------------------------------------------------ */
/* Console reconciliations (ACT-03 retry gating)                             */
/* ------------------------------------------------------------------------ */

export interface ReconciliationRecord extends ReconcileResultView {
  actionId: string;
  ledgerState: string;
  consumed: boolean;
  performedBy: string;
}

interface ReconRow {
  reconciliation_id: string;
  action_id: string;
  result: ReconcileResultView["result"];
  receipt_id: string | null;
  ledger_state: string;
  performed_by: string;
  performed_at: Date | string;
  retry_consumed_at: Date | string | null;
}

function rowToRecon(r: ReconRow): ReconciliationRecord {
  return {
    reconciliationId: r.reconciliation_id,
    actionId: r.action_id,
    result: r.result,
    at: toIso(r.performed_at),
    receiptId: r.receipt_id,
    ledgerState: r.ledger_state,
    consumed: r.retry_consumed_at !== null,
    performedBy: r.performed_by,
  };
}

export class ConsoleReconciliationStore {
  constructor(private readonly db: Db) {}

  async record(
    audit: AuditWriter,
    input: { tenantId: string; staffId: string; actionId: string; result: ReconcileResultView["result"]; receiptId: string | null; ledgerState: string; ledgerAuditEventId: string | null; now: Date; auditInput: (reconciliationId: string) => AuditEventInput },
  ): Promise<{ record: ReconciliationRecord; auditEventId: string }> {
    const reconciliationId = newId("rcn");
    return consoleTx(this.db, input.tenantId, input.staffId, async (tx) => {
      const ev = await audit.append(tx, input.auditInput(reconciliationId));
      await tx.query(
        `insert into console_reconciliations (reconciliation_id, tenant_id, action_id, result, receipt_id, ledger_state, ledger_audit_event_id, performed_by, performed_at, audit_event_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10)`,
        [reconciliationId, input.tenantId, input.actionId, input.result, input.receiptId, input.ledgerState, input.ledgerAuditEventId, input.staffId, iso(input.now), ev.eventId],
      );
      return {
        record: { reconciliationId, actionId: input.actionId, result: input.result, at: iso(input.now), receiptId: input.receiptId, ledgerState: input.ledgerState, consumed: false, performedBy: input.staffId },
        auditEventId: ev.eventId,
      };
    });
  }

  async latestFor(tenantId: string, staffId: string, actionIds: readonly string[]): Promise<Map<string, ReconciliationRecord>> {
    const out = new Map<string, ReconciliationRecord>();
    if (actionIds.length === 0) return out;
    const rows = await consoleTx(this.db, tenantId, staffId, (tx) =>
      tx.query<ReconRow>(
        `select distinct on (action_id) reconciliation_id, action_id, result, receipt_id, ledger_state, performed_by, performed_at, retry_consumed_at
           from console_reconciliations where action_id = any($1::text[]) order by action_id, reconcile_seq desc`,
        [[...actionIds]],
      ),
    );
    for (const r of rows.rows) out.set(r.action_id, rowToRecon(r));
    return out;
  }

  /** Marks the NOT_FOUND reconciliation as used by a retry, with its audit event, atomically (single use). */
  async consume(audit: AuditWriter, input: { tenantId: string; staffId: string; reconciliationId: string; now: Date; auditInput: AuditEventInput }): Promise<string> {
    return consoleTx(this.db, input.tenantId, input.staffId, async (tx) => {
      const r = await tx.query(
        `update console_reconciliations set retry_consumed_at = $2::timestamptz, retry_consumed_by = $3
          where reconciliation_id = $1 and result = 'NOT_FOUND' and retry_consumed_at is null`,
        [input.reconciliationId, iso(input.now), input.staffId],
      );
      if (r.rowCount !== 1) throw new ConflictError("RECONCILE_REQUIRED");
      const ev = await audit.append(tx, input.auditInput);
      return ev.eventId;
    });
  }
}
