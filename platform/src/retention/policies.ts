/**
 * Retention policies, legal holds and vendor deletion requests (migration 0800).
 *
 *  - Retention policies are versioned and append-only. A duration can be set
 *    only with a RETENTION_SCHEDULE approval that the injected verifier accepts
 *    (signed human approval records in deployment); clearing a duration back to
 *    NULL ("unset") needs no approval. The coding agent never sets a duration:
 *    tests use labelled TEST-ONLY placeholder values.
 *  - Legal holds narrow by data class, dataset, subject and/or record key; they
 *    are never deleted and are released once, with a reason code.
 *  - Vendor deletion requests are queued by the job (status PENDING_VENDOR);
 *    vendor deletion APIs are BLOCKED, so an operator records submission and
 *    confirmation with an evidence reference. Confirmation without evidence is
 *    refused by the database.
 *
 * Every administrative change requires an MFA-authenticated staff actor with an
 * allowed role and is audited in the same transaction when an audit writer is
 * configured (fail closed: no audit, no change).
 */
import { z } from "zod";
import type { AuditWriter } from "../audit/ports.js";
import type { Db, Queryable } from "../db/types.js";
import { DataClass, OpaqueId, StaffActor } from "../protocol/index.js";
import type { AuditEventInput, StaffRole } from "../protocol/index.js";
import type { Clock } from "../shared/clock.js";
import { iso, systemClock } from "../shared/clock.js";
import { AccessDeniedError, ValidationError } from "../shared/errors.js";
import { newId } from "../shared/ids.js";
import type { RetentionApprovalVerifier } from "./ports.js";

export const RETENTION_ADMIN_ROLES: readonly StaffRole[] = ["security_admin", "policy_approver"];
export const VENDOR_OPERATOR_ROLES: readonly StaffRole[] = ["security_admin", "supervisor"];

const REASON = /^[A-Z][A-Z0-9_]{2,63}$/;

export function authorizeStaff(raw: unknown, allowed: readonly StaffRole[], now: Date): { staff: StaffActor; role: StaffRole } {
  const parsed = StaffActor.safeParse(raw);
  if (!parsed.success) throw new AccessDeniedError("STAFF_INVALID");
  const staff = parsed.data;
  if (!staff.mfa) throw new AccessDeniedError("STAFF_MFA_REQUIRED");
  if (staff.breakGlass && Date.parse(staff.breakGlass.expiresAt) <= now.getTime()) throw new AccessDeniedError("STAFF_BREAK_GLASS_EXPIRED");
  const role = staff.roles.find((r) => allowed.includes(r));
  if (!role) throw new AccessDeniedError("STAFF_ROLE_NOT_PERMITTED");
  return { staff, role };
}

export interface RetentionPolicy {
  tenantId: string;
  dataClass: DataClass;
  policyVersion: number;
  retentionDays: number | null;
  legalPurpose: string | null;
  approvalId: string | null;
  approvedBy: string | null;
  definedBy: string;
  definedAt: string;
}

interface PolicyRow {
  tenant_id: string;
  data_class: DataClass;
  policy_version: number;
  retention_days: number | null;
  legal_purpose: string | null;
  approval_id: string | null;
  approved_by: string | null;
  defined_by: string;
  defined_at: Date | string;
}

const toPolicy = (r: PolicyRow): RetentionPolicy => ({
  tenantId: r.tenant_id,
  dataClass: r.data_class,
  policyVersion: r.policy_version,
  retentionDays: r.retention_days,
  legalPurpose: r.legal_purpose,
  approvalId: r.approval_id,
  approvedBy: r.approved_by,
  definedBy: r.defined_by,
  definedAt: new Date(r.defined_at).toISOString(),
});

/** Latest policy version per class (read inside the caller's transaction). */
export async function currentPolicies(tx: Queryable, tenantId: string): Promise<Map<DataClass, RetentionPolicy>> {
  const rows = await tx.query<PolicyRow>(
    `select distinct on (data_class) tenant_id, data_class, policy_version, retention_days, legal_purpose, approval_id, approved_by, defined_by, defined_at
       from retention_policies where tenant_id = $1 order by data_class, policy_version desc`,
    [tenantId],
  );
  return new Map(rows.rows.map((r) => [r.data_class, toPolicy(r)]));
}

const DefineInput = z.strictObject({
  tenantId: OpaqueId,
  dataClass: DataClass,
  retentionDays: z.number().int().min(1).max(36_500).nullable(),
  legalPurpose: z.string().regex(REASON).nullable(),
  approvalId: z.string().regex(/^apr_[A-Za-z0-9_-]{8,64}$/).nullable(),
  staff: z.unknown(),
});

function auditBase(tenantId: string, now: Date, action: string, actorRef: string, role: StaffRole, extra: Partial<AuditEventInput>): AuditEventInput {
  return {
    occurredAt: iso(now),
    correlationId: newId("cor"),
    parentId: null,
    tenantId,
    actorRef,
    subjectRef: null,
    role,
    sourceComponent: "retention",
    callId: null,
    sessionRef: null,
    sessionGeneration: null,
    turnId: null,
    versions: null,
    action,
    policyDecision: null,
    assurance: null,
    evidencePointers: [],
    beforeHash: null,
    afterHash: null,
    idempotencyKey: null,
    outcome: "SUCCEEDED",
    reasonCode: null,
    dataClass: "SECURITY_AUDIT",
    ...extra,
  };
}

export class RetentionPolicyStorePg {
  private readonly clock: Clock;
  constructor(private readonly deps: { db: Db; approvals: RetentionApprovalVerifier; clock?: Clock; audit?: AuditWriter | null }) {
    this.clock = deps.clock ?? systemClock;
  }

  async define(raw: { tenantId: string; dataClass: DataClass; retentionDays: number | null; legalPurpose: string | null; approvalId: string | null; staff: unknown }): Promise<RetentionPolicy> {
    const parsed = DefineInput.safeParse(raw);
    if (!parsed.success) throw new ValidationError("RETENTION_POLICY_INPUT_INVALID");
    const input = parsed.data;
    const now = this.clock.now();
    const { staff, role } = authorizeStaff(input.staff, RETENTION_ADMIN_ROLES, now);
    let approvedBy: string | null = null;
    if (input.retentionDays !== null) {
      if (input.approvalId === null || input.legalPurpose === null) throw new ValidationError("RETENTION_DURATION_REQUIRES_APPROVAL_AND_PURPOSE");
      const verdict = await this.deps.approvals.verify({ approvalId: input.approvalId, tenantId: input.tenantId, dataClass: input.dataClass });
      if (!verdict.valid || !verdict.approverRole) throw new AccessDeniedError(verdict.reasonCode || "RETENTION_APPROVAL_INVALID");
      approvedBy = verdict.approverRole;
    }
    return this.deps.db.tx(
      async (tx) => {
        const prev = await tx.query<{ v: number | null }>("select max(policy_version) as v from retention_policies where tenant_id = $1 and data_class = $2", [input.tenantId, input.dataClass]);
        const version = (prev.rows[0]?.v ?? 0) + 1;
        const row = (
          await tx.query<PolicyRow>(
            `insert into retention_policies (tenant_id, data_class, policy_version, retention_days, legal_purpose, approval_id, approved_by, defined_by, defined_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz) returning *`,
            [
              input.tenantId,
              input.dataClass,
              version,
              input.retentionDays,
              input.retentionDays === null ? null : input.legalPurpose,
              input.retentionDays === null ? null : input.approvalId,
              approvedBy,
              staff.staffId,
              iso(now),
            ],
          )
        ).rows[0];
        if (!row) throw new ValidationError("RETENTION_POLICY_NOT_STORED");
        if (this.deps.audit) {
          await this.deps.audit.append(
            tx,
            auditBase(input.tenantId, now, "retention.policy.define", staff.staffId, role, {
              evidencePointers: [`db://retention_policies/${input.dataClass}/${version}`],
              reasonCode: input.retentionDays === null ? "RETENTION_UNSET" : "RETENTION_SET_WITH_APPROVAL",
            }),
          );
        }
        return toPolicy(row);
      },
      { role: "app_console", rls: { tenantId: input.tenantId, actorId: staff.staffId } },
    );
  }

  async current(tenantId: string): Promise<Map<DataClass, RetentionPolicy>> {
    if (!OpaqueId.safeParse(tenantId).success) throw new ValidationError("RETENTION_TENANT_INVALID");
    return this.deps.db.tx((tx) => currentPolicies(tx, tenantId), { role: "app_worker", rls: { tenantId } });
  }
}

export interface LegalHold {
  holdId: string;
  tenantId: string;
  dataClass: DataClass | null;
  dataset: string | null;
  subjectId: string | null;
  recordKey: string | null;
  matterRef: string;
  reasonCode: string;
  placedBy: string;
  placedAt: string;
  releasedAt: string | null;
}

const PlaceInput = z.strictObject({
  tenantId: OpaqueId,
  dataClass: DataClass.nullable().optional(),
  dataset: z.string().regex(/^[a-z][a-z0-9_]{2,62}$/).nullable().optional(),
  subjectId: OpaqueId.nullable().optional(),
  recordKey: OpaqueId.nullable().optional(),
  matterRef: OpaqueId,
  reasonCode: z.string().regex(REASON),
  staff: z.unknown(),
});

const ReleaseInput = z.strictObject({ tenantId: OpaqueId, holdId: z.string().regex(/^lgh_[A-Za-z0-9_-]{16,64}$/), reasonCode: z.string().regex(REASON), staff: z.unknown() });

export class LegalHoldStorePg {
  private readonly clock: Clock;
  constructor(private readonly deps: { db: Db; clock?: Clock; audit?: AuditWriter | null }) {
    this.clock = deps.clock ?? systemClock;
  }

  async place(raw: z.input<typeof PlaceInput>): Promise<LegalHold> {
    const parsed = PlaceInput.safeParse(raw);
    if (!parsed.success) throw new ValidationError("LEGAL_HOLD_INPUT_INVALID");
    const input = parsed.data;
    const now = this.clock.now();
    const { staff, role } = authorizeStaff(input.staff, RETENTION_ADMIN_ROLES, now);
    const hold: LegalHold = {
      holdId: newId("lgh"),
      tenantId: input.tenantId,
      dataClass: input.dataClass ?? null,
      dataset: input.dataset ?? null,
      subjectId: input.subjectId ?? null,
      recordKey: input.recordKey ?? null,
      matterRef: input.matterRef,
      reasonCode: input.reasonCode,
      placedBy: staff.staffId,
      placedAt: iso(now),
      releasedAt: null,
    };
    await this.deps.db.tx(
      async (tx) => {
        await tx.query(
          `insert into legal_holds (hold_id, tenant_id, data_class, dataset, subject_id, record_key, matter_ref, reason_code, placed_by, placed_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz)`,
          [hold.holdId, hold.tenantId, hold.dataClass, hold.dataset, hold.subjectId, hold.recordKey, hold.matterRef, hold.reasonCode, hold.placedBy, hold.placedAt],
        );
        if (this.deps.audit) {
          await this.deps.audit.append(tx, auditBase(hold.tenantId, now, "retention.hold.place", staff.staffId, role, { evidencePointers: [`db://legal_holds/${hold.holdId}`], reasonCode: hold.reasonCode }));
        }
      },
      { role: "app_console", rls: { tenantId: hold.tenantId, actorId: staff.staffId } },
    );
    return hold;
  }

  async release(raw: z.input<typeof ReleaseInput>): Promise<void> {
    const parsed = ReleaseInput.safeParse(raw);
    if (!parsed.success) throw new ValidationError("LEGAL_HOLD_INPUT_INVALID");
    const input = parsed.data;
    const now = this.clock.now();
    const { staff, role } = authorizeStaff(input.staff, RETENTION_ADMIN_ROLES, now);
    await this.deps.db.tx(
      async (tx) => {
        const r = await tx.query(
          "update legal_holds set released_at = $3::timestamptz, released_by = $4, release_reason_code = $5 where tenant_id = $1 and hold_id = $2 and released_at is null",
          [input.tenantId, input.holdId, iso(now), staff.staffId, input.reasonCode],
        );
        if (r.rowCount !== 1) throw new ValidationError("LEGAL_HOLD_NOT_ACTIVE");
        if (this.deps.audit) {
          await this.deps.audit.append(tx, auditBase(input.tenantId, now, "retention.hold.release", staff.staffId, role, { evidencePointers: [`db://legal_holds/${input.holdId}`], reasonCode: input.reasonCode }));
        }
      },
      { role: "app_console", rls: { tenantId: input.tenantId, actorId: staff.staffId } },
    );
  }

  async listActive(tenantId: string): Promise<LegalHold[]> {
    if (!OpaqueId.safeParse(tenantId).success) throw new ValidationError("RETENTION_TENANT_INVALID");
    const rows = await this.deps.db.tx(
      async (tx) =>
        (
          await tx.query<{
            hold_id: string;
            tenant_id: string;
            data_class: DataClass | null;
            dataset: string | null;
            subject_id: string | null;
            record_key: string | null;
            matter_ref: string;
            reason_code: string;
            placed_by: string;
            placed_at: Date | string;
            released_at: Date | string | null;
          }>("select * from legal_holds where tenant_id = $1 and released_at is null order by placed_at, hold_id", [tenantId])
        ).rows,
      { role: "app_console", rls: { tenantId } },
    );
    return rows.map((r) => ({
      holdId: r.hold_id,
      tenantId: r.tenant_id,
      dataClass: r.data_class,
      dataset: r.dataset,
      subjectId: r.subject_id,
      recordKey: r.record_key,
      matterRef: r.matter_ref,
      reasonCode: r.reason_code,
      placedBy: r.placed_by,
      placedAt: new Date(r.placed_at).toISOString(),
      releasedAt: r.released_at === null ? null : new Date(r.released_at).toISOString(),
    }));
  }
}

export interface VendorDeletionRequest {
  requestId: string;
  vendor: string;
  dataset: string;
  dataClass: string;
  itemCount: number;
  rejectedRefCount: number;
  keyDigest: string;
  status: "PENDING_VENDOR" | "SUBMITTED" | "CONFIRMED" | "FAILED";
  evidenceRef: string | null;
  createdAt: string;
}

const TransitionInput = z.strictObject({
  tenantId: OpaqueId,
  requestId: z.string().regex(/^vdr_[A-Za-z0-9_-]{16,64}$/),
  status: z.enum(["SUBMITTED", "CONFIRMED", "FAILED"]),
  evidenceRef: z.string().regex(/^[a-z][a-z0-9+.-]{1,15}:\/\/[A-Za-z0-9/_.:@-]{3,180}$/).nullable(),
  staff: z.unknown(),
});

/** Operator view of vendor deletion requests. Vendor APIs are BLOCKED; status changes need human evidence. */
export class VendorDeletionQueuePg {
  private readonly clock: Clock;
  constructor(private readonly deps: { db: Db; clock?: Clock; audit?: AuditWriter | null }) {
    this.clock = deps.clock ?? systemClock;
  }

  async list(tenantId: string, status?: VendorDeletionRequest["status"]): Promise<VendorDeletionRequest[]> {
    if (!OpaqueId.safeParse(tenantId).success) throw new ValidationError("RETENTION_TENANT_INVALID");
    const rows = await this.deps.db.tx(
      async (tx) =>
        (
          await tx.query<{
            request_id: string;
            vendor: string;
            dataset: string;
            data_class: string;
            item_count: number;
            rejected_ref_count: number;
            key_digest: string;
            status: VendorDeletionRequest["status"];
            evidence_ref: string | null;
            created_at: Date | string;
          }>(
            `select request_id, vendor, dataset, data_class, item_count, rejected_ref_count, key_digest, status, evidence_ref, created_at
               from vendor_deletion_requests where tenant_id = $1 and ($2::text is null or status = $2) order by created_at, request_id`,
            [tenantId, status ?? null],
          )
        ).rows,
      { role: "app_console", rls: { tenantId } },
    );
    return rows.map((r) => ({
      requestId: r.request_id,
      vendor: r.vendor,
      dataset: r.dataset,
      dataClass: r.data_class,
      itemCount: r.item_count,
      rejectedRefCount: r.rejected_ref_count,
      keyDigest: r.key_digest,
      status: r.status,
      evidenceRef: r.evidence_ref,
      createdAt: new Date(r.created_at).toISOString(),
    }));
  }

  async transition(raw: z.input<typeof TransitionInput>): Promise<void> {
    const parsed = TransitionInput.safeParse(raw);
    if (!parsed.success) throw new ValidationError("VENDOR_DELETION_INPUT_INVALID");
    const input = parsed.data;
    const now = this.clock.now();
    const { staff, role } = authorizeStaff(input.staff, VENDOR_OPERATOR_ROLES, now);
    if (input.status === "CONFIRMED" && input.evidenceRef === null) throw new ValidationError("VENDOR_DELETION_CONFIRMATION_REQUIRES_EVIDENCE");
    await this.deps.db.tx(
      async (tx) => {
        const r = await tx.query(
          "update vendor_deletion_requests set status = $3, evidence_ref = coalesce($4, evidence_ref), updated_at = $5::timestamptz, updated_by = $6 where tenant_id = $1 and request_id = $2",
          [input.tenantId, input.requestId, input.status, input.evidenceRef, iso(now), staff.staffId],
        );
        if (r.rowCount !== 1) throw new ValidationError("VENDOR_DELETION_REQUEST_NOT_FOUND");
        if (this.deps.audit) {
          await this.deps.audit.append(
            tx,
            auditBase(input.tenantId, now, "retention.vendor_request.transition", staff.staffId, role, { evidencePointers: [`db://vendor_deletion_requests/${input.requestId}`], reasonCode: `VENDOR_DELETION_${input.status}` }),
          );
        }
      },
      { role: "app_console", rls: { tenantId: input.tenantId, actorId: staff.staffId } },
    );
  }
}
