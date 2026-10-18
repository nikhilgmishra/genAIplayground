/**
 * Retention job (spec section 6, DATA-03): enforceable lifecycle by data class
 * with legal-hold exceptions, deletion evidence, derived-copy verification and
 * vendor deletion requests.
 *
 * For each tenant and data class:
 *  - no policy, or a NULL duration => BLOCKED_RETENTION_UNSET: nothing in the
 *    class is deleted (a duration is never invented);
 *  - optional cross-check against the platform configuration: a mismatch =>
 *    BLOCKED_RETENTION_CONFIG_MISMATCH (fail closed);
 *  - otherwise each registered dataset of the class deletes rows older than the
 *    cutoff that no active legal hold covers, in bounded batches. Each batch
 *    writes, in the same transaction, an append-only deletion record (counts,
 *    key digest, policy version, approval id: no content), vendor deletion
 *    requests (PENDING_VENDOR; vendor APIs are BLOCKED) and, when configured, an
 *    audit event. If any of those writes fails, the deletion rolls back.
 *  - after commit every derived-copy verifier runs over the deleted keys and an
 *    append-only verification row is written. Leftovers and unverifiable copies
 *    (e.g. backups) are reported as unverified copies, never as deleted (OPS-03).
 *  - a subject-scoped hold on a dataset without a subject column cannot be
 *    resolved per row, so the dataset is not touched (fail closed);
 *  - CRYPTO_SHRED and APPEND_ONLY_PURGE_REQUIRED datasets are reported
 *    STRATEGY_BLOCKED (never simulated, never a silent failure);
 *  - composite-key datasets (keyColumns) are matched on the whole key tuple; the
 *    evidence key is the key columns joined with "/".
 */
import type { AuditWriter } from "../audit/ports.js";
import type { Db, Queryable } from "../db/types.js";
import type { Logger } from "../observability/ports.js";
import { silentLogger } from "../observability/logger.js";
import { DataClass, OpaqueId } from "../protocol/index.js";
import type { AuditEventInput } from "../protocol/index.js";
import type { Clock } from "../shared/clock.js";
import { iso, systemClock } from "../shared/clock.js";
import { sha256Hex } from "../shared/canonical.js";
import { PlatformError, ValidationError } from "../shared/errors.js";
import { newId } from "../shared/ids.js";
import { currentPolicies } from "./policies.js";
import type { RetentionPolicy } from "./policies.js";
import type { ClassReport, CopyVerification, DatasetReport, RetentionDataset, RetentionRunReport, UnverifiedCopy, VerifierResult } from "./ports.js";
import { quoteIdent } from "./registry.js";
import type { DatasetRegistry } from "./registry.js";

const DAY_MS = 86_400_000;
const VENDOR_REF = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export interface RetentionJobOptions {
  db: Db;
  registry: DatasetRegistry;
  tenantIds: readonly string[];
  clock?: Clock;
  logger?: Logger;
  audit?: AuditWriter | null;
  /** Rows deleted per transaction. */
  batchSize?: number;
  /** Upper bound on batches per dataset per run (bounded work). */
  maxBatchesPerDataset?: number;
  /** Optional platform-config retention (PlatformConfig.retention); must agree with the approved DB policy. */
  configRetention?: Partial<Record<DataClass, number | null>> | null;
}

export const keyDigest = (keys: readonly string[]): string => sha256Hex([...keys].sort().join("\n"));

export class RetentionJob {
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly batchSize: number;
  private readonly maxBatches: number;

  constructor(private readonly opts: RetentionJobOptions) {
    for (const t of opts.tenantIds) if (!OpaqueId.safeParse(t).success) throw new ValidationError("RETENTION_TENANT_INVALID");
    this.clock = opts.clock ?? systemClock;
    this.logger = opts.logger ?? silentLogger;
    this.batchSize = opts.batchSize ?? 500;
    this.maxBatches = opts.maxBatchesPerDataset ?? 100;
    if (!Number.isSafeInteger(this.batchSize) || this.batchSize < 1 || this.batchSize > 10_000) throw new ValidationError("RETENTION_BATCH_SIZE_INVALID");
  }

  async run(now: Date = this.clock.now()): Promise<RetentionRunReport[]> {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new ValidationError("RETENTION_RUN_TIME_INVALID");
    const reports: RetentionRunReport[] = [];
    for (const tenantId of this.opts.tenantIds) reports.push(await this.runTenant(tenantId, now));
    return reports;
  }

  /**
   * Vendor deletion requests still waiting for the vendor (status PENDING_VENDOR), counted per
   * vendor across the configured tenants (app_worker, tenant RLS). Content-free: vendor ids and counts.
   */
  async pendingVendorDeletions(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const tenantId of this.opts.tenantIds) {
      const rows = await this.opts.db.tx(
        async (tx) =>
          (
            await tx.query<{ vendor: string; n: number }>(
              "select vendor, count(*)::int as n from vendor_deletion_requests where tenant_id = $1 and status = 'PENDING_VENDOR' group by vendor order by vendor",
              [tenantId],
            )
          ).rows,
        { role: "app_worker", rls: { tenantId } },
      );
      for (const r of rows) out[r.vendor] = (out[r.vendor] ?? 0) + r.n;
    }
    return out;
  }

  private async runTenant(tenantId: string, now: Date): Promise<RetentionRunReport> {
    const runId = newId("ret");
    const startedAt = iso(now);
    const asWorker = { role: "app_worker" as const, rls: { tenantId } };
    await this.opts.db.tx((tx) => tx.query("insert into retention_runs (run_id, tenant_id, started_at, status) values ($1, $2, $3::timestamptz, 'STARTED')", [runId, tenantId, startedAt]), asWorker);

    const policies = await this.opts.db.tx((tx) => currentPolicies(tx, tenantId), asWorker);
    const classes = DataClass.options.map((c) => this.classReport(c, policies.get(c) ?? null, now));
    const byClass = new Map(classes.map((c) => [c.dataClass, c]));

    const datasets: DatasetReport[] = [];
    for (const ds of this.opts.registry.list()) {
      const cls = byClass.get(ds.dataClass);
      const base: DatasetReport = { dataset: ds.name, dataClass: ds.dataClass, status: "NOTHING_EXPIRED", deletedCount: 0, heldCount: 0, deletionIds: [], keyDigest: null, verifications: [], vendorRequests: [], reasonCode: null };
      if (!cls || cls.status !== "EXECUTED" || cls.cutoff === null) {
        datasets.push({ ...base, status: "SKIPPED_RETENTION_UNSET", reasonCode: cls?.status ?? "BLOCKED_RETENTION_UNSET" });
        continue;
      }
      if (ds.deleteStrategy !== "HARD_DELETE") {
        const reasonCode = ds.deleteStrategy === "APPEND_ONLY_PURGE_REQUIRED" ? "RETENTION_PURGE_PATH_REQUIRED" : "RETENTION_CRYPTO_SHRED_BLOCKED";
        this.logger.warn("retention.dataset.strategy_blocked", { tenantId, runId, reasonCode, kind: ds.name });
        datasets.push({ ...base, status: "STRATEGY_BLOCKED", reasonCode });
        continue;
      }
      try {
        datasets.push(await this.processDataset(ds, cls, tenantId, runId, now));
      } catch (err) {
        const reasonCode = err instanceof PlatformError ? err.reasonCode : "RETENTION_DATASET_FAILED";
        this.logger.error("retention.dataset.failed", { tenantId, runId, reasonCode, kind: ds.name });
        datasets.push({ ...base, status: "FAILED", reasonCode });
      }
    }

    const unverifiedCopies: UnverifiedCopy[] = [];
    for (const d of datasets) {
      for (const v of d.verifications) {
        if (v.status !== "VERIFIED_ABSENT") unverifiedCopies.push({ dataset: d.dataset, verifier: v.verifier, location: v.location, status: v.status, leftoverCount: v.leftoverCount, reasonCode: v.reasonCode });
      }
    }
    const allBlocked = classes.every((c) => c.status !== "EXECUTED");
    const status: RetentionRunReport["status"] = datasets.some((d) => d.status === "FAILED")
      ? "FAILED"
      : allBlocked
        ? "BLOCKED_RETENTION_UNSET"
        : unverifiedCopies.length > 0
          ? "COMPLETED_WITH_UNVERIFIED_COPIES"
          : "COMPLETED";
    const completedAt = iso(this.clock.now());
    const summary = {
      classes: classes.map((c) => ({ dataClass: c.dataClass, status: c.status, policyVersion: c.policyVersion })),
      datasets: datasets.map((d) => ({ dataset: d.dataset, status: d.status, deletedCount: d.deletedCount, heldCount: d.heldCount, keyDigest: d.keyDigest })),
      unverifiedCopies: unverifiedCopies.length,
    };
    await this.opts.db.tx(
      (tx) => tx.query("update retention_runs set completed_at = $3::timestamptz, status = $4, summary = $5::jsonb where tenant_id = $1 and run_id = $2", [tenantId, runId, completedAt, status, JSON.stringify(summary)]),
      asWorker,
    );
    for (const c of classes) if (c.status !== "EXECUTED") this.logger.warn("retention.class.blocked", { tenantId, runId, reasonCode: c.status, kind: c.dataClass });
    this.logger.info("retention.run.completed", { tenantId, runId, status, count: datasets.reduce((n, d) => n + d.deletedCount, 0) });
    return { runId, tenantId, startedAt, completedAt, status, classes, datasets, unverifiedCopies };
  }

  private classReport(dataClass: DataClass, policy: RetentionPolicy | null, now: Date): ClassReport {
    const base = { dataClass, retentionDays: policy?.retentionDays ?? null, policyVersion: policy?.policyVersion ?? null, approvalId: policy?.approvalId ?? null, legalPurpose: policy?.legalPurpose ?? null };
    if (!policy || policy.retentionDays === null || policy.approvalId === null || policy.legalPurpose === null) {
      return { ...base, status: "BLOCKED_RETENTION_UNSET", cutoff: null };
    }
    const cfg = this.opts.configRetention;
    if (cfg && dataClass in cfg && cfg[dataClass] !== policy.retentionDays) {
      return { ...base, status: "BLOCKED_RETENTION_CONFIG_MISMATCH", cutoff: null };
    }
    return { ...base, status: "EXECUTED", cutoff: new Date(now.getTime() - policy.retentionDays * DAY_MS).toISOString() };
  }

  /** Evidence key expression for alias `a`: the key column, or the composite key columns joined with "/". */
  private keyExpr(ds: RetentionDataset, a: string): string {
    const cols = ds.keyColumns ?? [ds.keyColumn];
    return cols.length === 1 ? `${a}.${quoteIdent(cols[0] as string)}::text` : `(${cols.map((c) => `${a}.${quoteIdent(c)}::text`).join(" || '/' || ")})`;
  }

  /** SQL predicate: row `t` is covered by an active legal hold. */
  private holdPredicate(ds: RetentionDataset): string {
    const tenant = `t.${quoteIdent(ds.tenantColumn)}`;
    const key = this.keyExpr(ds, "t");
    const subject = ds.subjectColumn ? `(h.subject_id is null or h.subject_id = t.${quoteIdent(ds.subjectColumn)}::text)` : "h.subject_id is null";
    return `exists (select 1 from legal_holds h where h.tenant_id = ${tenant} and h.released_at is null
              and (h.data_class is null or h.data_class = $3) and (h.dataset is null or h.dataset = $4)
              and ${subject} and (h.record_key is null or h.record_key = ${key}))`;
  }

  private async processDataset(ds: RetentionDataset, cls: ClassReport, tenantId: string, runId: string, now: Date): Promise<DatasetReport> {
    const table = quoteIdent(ds.table);
    const tenantCol = quoteIdent(ds.tenantColumn);
    const tsCol = quoteIdent(ds.timestampColumn);
    const cutoff = cls.cutoff as string;
    const asWorker = { role: "app_worker" as const, rls: { tenantId } };
    const params = [tenantId, cutoff, ds.dataClass, ds.name];
    const report: DatasetReport = { dataset: ds.name, dataClass: ds.dataClass, status: "NOTHING_EXPIRED", deletedCount: 0, heldCount: 0, deletionIds: [], keyDigest: null, verifications: [], vendorRequests: [], reasonCode: null };

    const expiredWhere = `t.${tenantCol} = $1 and t.${tsCol} < $2::timestamptz`;
    // Fail closed and visible: without DELETE privilege for the worker role the dataset cannot be purged.
    const canDelete = await this.opts.db.tx(
      async (tx) => (await tx.query<{ ok: boolean }>("select has_table_privilege(current_user, $1, 'DELETE') as ok", [ds.table])).rows[0]?.ok === true,
      asWorker,
    );
    if (!canDelete) {
      this.logger.warn("retention.dataset.privilege_missing", { tenantId, runId, reasonCode: "RETENTION_DELETE_PRIVILEGE_MISSING", kind: ds.name });
      return { ...report, status: "STRATEGY_BLOCKED", reasonCode: "RETENTION_DELETE_PRIVILEGE_MISSING" };
    }
    if (!ds.subjectColumn) {
      const subjectHolds = await this.opts.db.tx(
        async (tx) =>
          (
            await tx.query<{ n: number }>(
              `select count(*)::int as n from legal_holds h where h.tenant_id = $1 and h.released_at is null and h.subject_id is not null
                 and (h.data_class is null or h.data_class = $2) and (h.dataset is null or h.dataset = $3)`,
              [tenantId, ds.dataClass, ds.name],
            )
          ).rows[0]?.n ?? 0,
        asWorker,
      );
      if (subjectHolds > 0) {
        const expired = await this.opts.db.tx(async (tx) => (await tx.query<{ n: number }>(`select count(*)::int as n from ${table} t where ${expiredWhere}`, [tenantId, cutoff])).rows[0]?.n ?? 0, asWorker);
        return { ...report, status: "HELD_SUBJECT_HOLD_UNRESOLVABLE", heldCount: expired, reasonCode: "LEGAL_HOLD_SUBJECT_SCOPE_UNRESOLVABLE" };
      }
    }

    const hold = this.holdPredicate(ds);
    report.heldCount = await this.opts.db.tx(
      async (tx) => (await tx.query<{ n: number }>(`select count(*)::int as n from ${table} t where ${expiredWhere} and ${hold}`, params)).rows[0]?.n ?? 0,
      asWorker,
    );
    const candidates = await this.opts.db.tx(
      async (tx) => (await tx.query<{ n: number }>(`select count(*)::int as n from ${table} t where ${expiredWhere} and not ${hold}`, params)).rows[0]?.n ?? 0,
      asWorker,
    );

    const vendorCols = ds.vendorCopies.map((v, i) => `d.${quoteIdent(v.refColumn)}::text as vendor_ref_${i}`);
    const returning = [`${this.keyExpr(ds, "d")} as k`, ...vendorCols].join(", ");
    const tuple = (a: string) => (ds.keyColumns ?? [ds.keyColumn]).map((c) => `${a}.${quoteIdent(c)}`).join(", ");
    const allKeys: string[] = [];
    for (let batch = 0; batch < this.maxBatches; batch += 1) {
      const result = await this.opts.db.tx(async (tx) => {
        const deleted = (
          await tx.query<Record<string, string | null>>(
            `delete from ${table} as d where d.${tenantCol} = $1 and (${tuple("d")}) in (
               select ${tuple("t")} from ${table} t where ${expiredWhere} and not ${hold}
                order by t.${tsCol}, ${tuple("t")} limit ${this.batchSize})
             returning ${returning}`,
            params,
          )
        ).rows;
        if (deleted.length === 0) return null;
        const keys = deleted.map((r) => String(r.k));
        const deletionId = newId("del");
        const digest = keyDigest(keys);
        await tx.query(
          `insert into deletion_records (deletion_id, tenant_id, run_id, dataset, data_class, policy_version, approval_id, cutoff, deleted_count, held_count, key_digest, derived_copies, executed_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9, $10, $11, $12::text[], $13::timestamptz)`,
          [deletionId, tenantId, runId, ds.name, ds.dataClass, cls.policyVersion, cls.approvalId, cutoff, keys.length, report.heldCount, digest, ds.derivedCopies.map((v) => v.name), iso(now)],
        );
        const vendorRequests: DatasetReport["vendorRequests"] = [];
        for (const [i, vc] of ds.vendorCopies.entries()) {
          const refs = deleted.map((r) => r[`vendor_ref_${i}`]).filter((v): v is string => typeof v === "string" && v.length > 0);
          const valid = refs.filter((r) => VENDOR_REF.test(r) && !/\d{7,}/.test(r));
          if (refs.length === 0) continue;
          const requestId = newId("vdr");
          await tx.query(
            `insert into vendor_deletion_requests (request_id, tenant_id, run_id, deletion_id, vendor, dataset, data_class, item_refs, item_count, rejected_ref_count, key_digest, status, created_at, updated_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9, $10, $11, 'PENDING_VENDOR', $12::timestamptz, $12::timestamptz)`,
            [requestId, tenantId, runId, deletionId, vc.vendor, ds.name, ds.dataClass, valid, refs.length, refs.length - valid.length, keyDigest(refs), iso(now)],
          );
          vendorRequests.push({ requestId, vendor: vc.vendor, itemCount: refs.length, status: "PENDING_VENDOR" });
        }
        if (this.opts.audit) await this.opts.audit.append(tx, this.auditEvent(tenantId, now, deletionId, digest, cls));
        return { keys, deletionId, vendorRequests };
      }, asWorker);
      if (!result) break;
      allKeys.push(...result.keys);
      report.deletionIds.push(result.deletionId);
      report.vendorRequests.push(...result.vendorRequests);
      report.verifications.push(...(await this.verifyDerived(ds, tenantId, result.deletionId, result.keys, now)));
      if (result.keys.length < this.batchSize) break;
    }
    report.deletedCount = allKeys.length;
    if (candidates > 0 && allKeys.length === 0) {
      // Expired, unheld rows exist but none could be deleted (e.g. no row-level DELETE policy): never "nothing expired".
      this.logger.error("retention.dataset.delete_blocked", { tenantId, runId, reasonCode: "RETENTION_DELETE_BLOCKED", kind: ds.name, count: candidates });
      return { ...report, status: "FAILED", reasonCode: "RETENTION_DELETE_BLOCKED" };
    }
    if (allKeys.length > 0) {
      report.status = "DELETED";
      report.keyDigest = keyDigest(allKeys);
    }
    // Verification results per verifier aggregated across batches.
    report.verifications = aggregate(report.verifications);
    return report;
  }

  private async verifyDerived(ds: RetentionDataset, tenantId: string, deletionId: string, keys: readonly string[], now: Date): Promise<CopyVerification[]> {
    const out: CopyVerification[] = [];
    const rows: unknown[][] = [];
    for (const v of ds.derivedCopies) {
      let result: VerifierResult;
      try {
        result = await v.verify({ tenantId, dataset: ds.name, deletedKeys: keys, db: this.opts.db });
      } catch {
        result = { status: "UNVERIFIABLE", reasonCode: "VERIFIER_FAILED" };
      }
      const leftover = result.status === "LEFTOVERS_FOUND" ? result.leftoverKeys : [];
      const reasonCode = result.status === "UNVERIFIABLE" ? result.reasonCode : result.status === "LEFTOVERS_FOUND" ? "DERIVED_COPY_LEFTOVERS" : null;
      out.push({ verifier: v.name, location: v.location, verifierKind: v.kind, status: result.status, leftoverCount: leftover.length, reasonCode });
      rows.push([newId("dvf"), tenantId, deletionId, v.name, v.location, v.kind, result.status, leftover.length, leftover.length > 0 ? keyDigest(leftover) : null, reasonCode, iso(now)]);
      if (result.status !== "VERIFIED_ABSENT") this.logger.warn("retention.verification.unverified", { tenantId, deletionId, reasonCode: reasonCode ?? "UNVERIFIED", kind: v.name });
    }
    if (rows.length > 0) {
      await this.opts.db.tx(async (tx: Queryable) => {
        for (const r of rows) {
          await tx.query(
            `insert into deletion_verifications (verification_id, tenant_id, deletion_id, verifier, location, verifier_kind, status, leftover_count, leftover_digest, reason_code, verified_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz)`,
            r,
          );
        }
      }, { role: "app_worker", rls: { tenantId } });
    }
    return out;
  }

  private auditEvent(tenantId: string, now: Date, deletionId: string, digest: string, cls: ClassReport): AuditEventInput {
    return {
      occurredAt: iso(now),
      correlationId: newId("cor"),
      parentId: null,
      tenantId,
      actorRef: null,
      subjectRef: null,
      role: null,
      sourceComponent: "retention",
      callId: null,
      sessionRef: null,
      sessionGeneration: null,
      turnId: null,
      versions: null,
      action: "retention.delete",
      policyDecision: null,
      assurance: null,
      evidencePointers: [`db://deletion_records/${deletionId}`],
      beforeHash: digest,
      afterHash: null,
      idempotencyKey: null,
      outcome: "SUCCEEDED",
      reasonCode: cls.legalPurpose,
      dataClass: "SECURITY_AUDIT",
    };
  }
}

function aggregate(vs: readonly CopyVerification[]): CopyVerification[] {
  const rank = { VERIFIED_ABSENT: 0, LEFTOVERS_FOUND: 1, UNVERIFIABLE: 2 } as const;
  const by = new Map<string, CopyVerification>();
  for (const v of vs) {
    const prev = by.get(v.verifier);
    if (!prev) {
      by.set(v.verifier, { ...v });
      continue;
    }
    prev.leftoverCount += v.leftoverCount;
    if (rank[v.status] > rank[prev.status]) {
      prev.status = v.status;
      prev.reasonCode = v.reasonCode;
    }
  }
  return [...by.values()];
}
