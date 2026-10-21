/**
 * Separate audit verifier (follow-on FO-15-40, FO-15-41, FO-19-82, FO-22-08, FO-03-10; OPS-01, OPS-03).
 *
 * Runs under its OWN identity: its own database LOGIN, granted only role app_audit_verifier (migration 2042:
 * SELECT on the audit tables and on the reconciliation sources, nothing else), and the sink READER
 * credentials (list + get on the audit bucket; the exporter's writer identity cannot read, see sts.ts). It
 * never marks, purges or writes; its output is a content-free report, metrics and (CLI) an exit code.
 * Before checking anything it proves the identity is read-only — the login it connected with (session user
 * and the backend's authenticated login), every role that login can reach, and the acting role
 * (checkIdentity); a verifier that could write, or whose login is a superuser, an owner or a member of a
 * writer role, is refused (VERIFIER_IDENTITY_NOT_READ_ONLY with the failed conditions in identity.findings).
 *
 * One run:
 *  1. integrity — every stream's local chain (IntegrityVerifier.verifyStream) and, with a sink reader,
 *     what the independent sink holds (verifyShipped without markVerified);
 *  2. signatures — every manifest in the sink must carry a valid exporter signature by a trusted key
 *     (ManifestSignatureVerifier); unsigned, partial, untrusted or invalid is a finding;
 *  3. ingestion — writer-side chain heads against rows present, and unshipped events older than the
 *     export grace;
 *  4. reconciliation over [from, to), keyed, against EXPORTED evidence (the sink copy; events not yet due
 *     for export count from the local outbox): every COMMITTED ledger action has its commit event, every
 *     provider receipt its receipt event, every synchronised CRM write its support_request.synced event,
 *     and route evidence has no pending deferral older than the grace, no deferral marked RECORDED whose
 *     route event is not exported, and no missing not_recorded marker.
 *     "A perfect hash chain can still omit events": this is what catches it.
 * Without a sink reader the exported copy cannot be read, so reconciliation runs against the LOCAL outbox
 * only: evidence that was already shipped (or that may have been purged after a verified export) is
 * UNVERIFIED, never counted as missing and never as observed (SourceReconciliation.unverified,
 * RECONCILIATION_NOT_VERIFIED_WITHOUT_SINK). What the verifier can see without the sink still FAILs: a local
 * chain gap, an ingestion gap, a deferral pending past the grace, evidence that is known NOT to be exported
 * (unshipped past the grace), a local event that contradicts the ledger (another tenant, action, key or
 * receipt), and — when nothing was ever purged — evidence that was never written.
 * Verdict: FAIL on any finding; INCONCLUSIVE when the sink reader or the signature keys are not
 * configured (never PASS without them, OPS-03); PASS only when everything ran clean.
 */
import type { Db } from "../../db/types.js";
import { silentLogger } from "../../observability/logger.js";
import { noopMetrics } from "../../observability/metrics.js";
import type { Logger, Metrics } from "../../observability/ports.js";
import { IsoDateTime } from "../../protocol/index.js";
import type { AuditEvent, AuditManifest } from "../../protocol/index.js";
import type { Clock } from "../../shared/clock.js";
import { iso } from "../../shared/clock.js";
import { ValidationError } from "../../shared/errors.js";
import { parseNdjson } from "../chain.js";
import { guardStorage, toSafeInt } from "../internal.js";
import { COMMIT_EVIDENCE_ACTIONS } from "../monitor.js";
import type { AuditSink } from "../ports.js";
import { ROUTE_NOT_RECORDED_ACTION } from "../route-reconciler.js";
import { IntegrityVerifier, assessCompleteness, reconcileCounts } from "../verifier.js";
import type { IntegrityFinding, ReconciliationDiscrepancy, StreamVerification } from "../verifier.js";
import type { ManifestSignatureCheck, ManifestSignatureVerifier } from "./signer.js";

export const VERIFIER_DB_ROLE = "app_audit_verifier" as const;
const MAX_REPORTED = 500;

/** Result of AuditExportVerifier.checkIdentity. */
export interface VerifierIdentityCheck {
  readOnly: boolean;
  /** Every failed condition (empty when read-only). */
  reasonCodes: string[];
  /** Database principals examined (session user, and the authenticated login on PostgreSQL). */
  principals: number;
}

/**
 * Identity probe (see checkIdentity). Application schemas are every schema except pg_catalog,
 * information_schema and pg_* (toast, temp). Runs as the acting role; the catalog functions it uses
 * (pg_has_role, has_*_privilege) answer for any role. Ownership of the current database is membership of
 * the predefined role pg_database_owner (no read of pg_database needed).
 */
const IDENTITY_SQL = `
with principal as (
  select r.oid, r.rolsuper, r.rolcreaterole from pg_roles r
   where r.rolname = session_user
      or r.oid = (select a.usesysid from pg_stat_activity a where a.pid = pg_backend_pid())
),
reach as (
  select distinct r.oid from pg_roles r join principal p on pg_has_role(p.oid, r.oid, 'MEMBER')
),
app_ns as (
  select n.oid from pg_namespace n where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname !~ '^pg_'
)
select current_user::text as acting,
       (select count(*) from principal)::int as principals,
       (select count(*) from pg_stat_activity a where a.pid = pg_backend_pid())::int as backend_rows,
       exists (select 1 from principal where rolsuper or rolcreaterole) as privileged,
       exists (select 1 from reach x join pg_roles r on r.oid = x.oid where r.rolname in ('app_runtime', 'app_worker', 'app_console')) as writer_member,
       (exists (select 1 from reach x join pg_roles r on r.oid = x.oid where r.rolname = 'pg_database_owner')
        or exists (select 1 from pg_namespace n where n.oid in (select oid from app_ns) and n.nspowner in (select oid from reach))
        or exists (select 1 from pg_class c where c.relnamespace in (select oid from app_ns) and c.relowner in (select oid from reach))
        or exists (select 1 from pg_proc f where f.pronamespace in (select oid from app_ns) and f.proowner in (select oid from reach))) as owns,
       exists (select 1 from reach x cross join pg_class c
                where c.relnamespace in (select oid from app_ns) and c.relkind in ('r', 'p', 'v', 'm', 'f')
                  and (has_table_privilege(x.oid, c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER')
                       or has_any_column_privilege(x.oid, c.oid, 'INSERT, UPDATE'))) as can_write,
       exists (select 1 from reach x cross join pg_proc f
                where f.pronamespace in (select oid from app_ns) and f.prosecdef and f.provolatile = 'v' and f.prokind in ('f', 'p')
                  and f.prorettype <> 'trigger'::regtype and f.prorettype <> 'event_trigger'::regtype
                  and has_function_privilege(x.oid, f.oid, 'EXECUTE')) as definer_write,
       (exists (select 1 from reach x cross join app_ns n where has_schema_privilege(x.oid, n.oid, 'CREATE'))
        or exists (select 1 from reach x where has_database_privilege(x.oid, current_database(), 'CREATE'))) as can_create`;

export type ReconciliationSource = "committed_action" | "provider_receipt" | "crm_write" | "route_evidence";

export interface AuditExportVerifierOptions {
  db: Db;
  /** Sink READER (list + get with the verifier's read-only credentials); null => INCONCLUSIVE. */
  sink: AuditSink | null;
  /** Trusted manifest public keys; null => signatures not verified => INCONCLUSIVE. */
  signatures: ManifestSignatureVerifier | null;
  clock: Clock;
  /** Events younger than this are not yet expected in the sink (default 300 s). */
  exportGraceSeconds?: number;
  metrics?: Metrics;
  logger?: Logger;
}

export interface SignatureSummary {
  manifests: number;
  valid: number;
  unsigned: number;
  invalid: number;
  untrustedKey: number;
  partial: number;
}

export interface SourceReconciliation {
  source: ReconciliationSource;
  expected: number;
  /** Expected items whose keyed evidence was found in the exported copy (or is not yet due for export). */
  observed: number;
  /**
   * Expected items the run could not verify (only without a sink reader): their evidence was already shipped,
   * or may have been purged after a verified export, so only the sink could confirm it. Never a pass.
   */
  unverified: number;
  discrepancies: number;
}

export interface AuditVerificationReport {
  verdict: "PASS" | "FAIL" | "INCONCLUSIVE";
  reasonCodes: string[];
  /** The identity check (checkIdentity): a run whose identity is not read-only gives no verdict on the evidence. */
  identity: { role: typeof VERIFIER_DB_ROLE; readOnly: boolean; findings: string[] };
  window: { from: string; to: string };
  streams: number;
  localEventsChecked: number;
  exportedEventsChecked: number;
  integrityFindings: number;
  findings: IntegrityFinding[];
  signatures: SignatureSummary | null;
  ingestionGaps: number;
  reconciliation: SourceReconciliation[];
  discrepancies: (ReconciliationDiscrepancy & { source: ReconciliationSource })[];
  generatedAt: string;
}

/** What reconciliation needs of an exported (or not yet due) audit event: ids, keys and references only. */
interface EvidenceEntry {
  eventId: string;
  tenantId: string;
  action: string;
  idempotencyKey: string | null;
  correlationId: string;
  /** Receipt ids the event references (evidencePointers `receipt:<id>` and receiptRefs). */
  receipts: ReadonlySet<string>;
}

interface EvidenceIndex {
  byId: Map<string, EvidenceEntry>;
  /** `${tenantId}|${action}|${correlationId}` -> count */
  byCorrelation: Map<string, number>;
}

const evidenceIndex = (): EvidenceIndex => ({ byId: new Map(), byCorrelation: new Map() });
/** The audit action SupportRequestService appends when a support request is synchronised to the CRM. */
const CRM_SYNCED_ACTION = "support_request.synced";
const corrKey = (tenantId: string, action: string, correlationId: string) => `${tenantId}|${action}|${correlationId}`;

function receiptsOf(evidencePointers: unknown, receiptRefs: unknown): Set<string> {
  const out = new Set<string>();
  if (Array.isArray(evidencePointers)) for (const p of evidencePointers) if (typeof p === "string" && p.startsWith("receipt:")) out.add(p.slice("receipt:".length));
  if (Array.isArray(receiptRefs)) for (const r of receiptRefs) if (typeof r === "string") out.add(r);
  return out;
}

function evidenceOf(e: Pick<AuditEvent, "eventId" | "tenantId" | "action" | "idempotencyKey" | "correlationId" | "evidencePointers" | "receiptRefs">): EvidenceEntry {
  return { eventId: e.eventId, tenantId: e.tenantId, action: e.action, idempotencyKey: e.idempotencyKey ?? null, correlationId: e.correlationId, receipts: receiptsOf(e.evidencePointers, e.receiptRefs) };
}

function addEvidence(idx: EvidenceIndex, e: EvidenceEntry): void {
  if (idx.byId.has(e.eventId)) return;
  idx.byId.set(e.eventId, e);
  const k = corrKey(e.tenantId, e.action, e.correlationId);
  idx.byCorrelation.set(k, (idx.byCorrelation.get(k) ?? 0) + 1);
}

export class AuditExportVerifier {
  private readonly metrics: Metrics;
  private readonly logger: Logger;
  private readonly graceMs: number;

  constructor(private readonly opts: AuditExportVerifierOptions) {
    const grace = opts.exportGraceSeconds ?? 300;
    if (!Number.isFinite(grace) || grace <= 0 || grace > 86_400) throw new ValidationError("AUDIT_VERIFIER_CONFIG_INVALID");
    this.graceMs = grace * 1000;
    this.metrics = opts.metrics ?? noopMetrics;
    this.logger = (opts.logger ?? silentLogger).child({ component: "audit_export_verifier" });
  }

  /**
   * Proves the verifier's database identity is read-only. Not only the acting role (`set local role
   * app_audit_verifier`) is examined, but every principal of the connection: the session user and, on a
   * PostgreSQL server, the login the backend AUTHENTICATED as (pg_stat_activity.usesysid of this backend,
   * which SET SESSION AUTHORIZATION does not change), together with every role either of them is a member
   * of (pg_has_role MEMBER: inherited or reachable through SET ROLE). The identity is refused when any of
   * them is a superuser or may create roles, is a member of a writer role (app_runtime, app_worker,
   * app_console), owns the database, a schema, a relation or a function, holds INSERT / UPDATE / DELETE /
   * TRUNCATE / TRIGGER on any relation of an application schema, may execute a VOLATILE SECURITY DEFINER
   * function (a write path under another owner's rights), or may create objects. On PostgreSQL a backend
   * whose authenticated login cannot be resolved is refused as well (fail closed); the embedded engine
   * (PGlite) has no authentication and only its session user exists.
   */
  async checkIdentity(): Promise<VerifierIdentityCheck> {
    const r = await guardStorage("AUDIT_STORE_UNAVAILABLE", () =>
      this.opts.db.tx(
        (tx) =>
          tx.query<{
            acting: string;
            principals: number;
            backend_rows: number;
            privileged: boolean;
            writer_member: boolean;
            owns: boolean;
            can_write: boolean;
            definer_write: boolean;
            can_create: boolean;
          }>(IDENTITY_SQL),
        { role: VERIFIER_DB_ROLE },
      ),
    );
    const row = r.rows[0];
    const reasons: string[] = [];
    if (!row) return { readOnly: false, reasonCodes: ["VERIFIER_IDENTITY_UNRESOLVED"], principals: 0 };
    if (row.acting !== VERIFIER_DB_ROLE) reasons.push("VERIFIER_ROLE_NOT_ACTIVE");
    if (row.principals < 1 || (this.opts.db.engine === "pg" && row.backend_rows !== 1)) reasons.push("VERIFIER_LOGIN_UNRESOLVED");
    if (row.privileged) reasons.push("VERIFIER_LOGIN_PRIVILEGED");
    if (row.writer_member) reasons.push("VERIFIER_LOGIN_WRITER_MEMBER");
    if (row.owns) reasons.push("VERIFIER_LOGIN_OWNS_OBJECTS");
    if (row.can_write) reasons.push("VERIFIER_IDENTITY_CAN_WRITE");
    if (row.definer_write) reasons.push("VERIFIER_IDENTITY_DEFINER_WRITE_PATH");
    if (row.can_create) reasons.push("VERIFIER_IDENTITY_CAN_CREATE");
    return { readOnly: reasons.length === 0, reasonCodes: reasons, principals: row.principals };
  }

  /** True only when checkIdentity finds nothing (see there). */
  async identityIsReadOnly(): Promise<boolean> {
    return (await this.checkIdentity()).readOnly;
  }

  async run(window: { from: string; to: string }): Promise<AuditVerificationReport> {
    const from = IsoDateTime.safeParse(window.from);
    const to = IsoDateTime.safeParse(window.to);
    if (!from.success || !to.success || Date.parse(to.data) <= Date.parse(from.data)) throw new ValidationError("AUDIT_VERIFY_WINDOW_INVALID");
    const now = this.opts.clock.now();
    const report: AuditVerificationReport = {
      verdict: "INCONCLUSIVE",
      reasonCodes: [],
      identity: { role: VERIFIER_DB_ROLE, readOnly: false, findings: [] },
      window: { from: from.data, to: to.data },
      streams: 0,
      localEventsChecked: 0,
      exportedEventsChecked: 0,
      integrityFindings: 0,
      findings: [],
      signatures: null,
      ingestionGaps: 0,
      reconciliation: [],
      discrepancies: [],
      generatedAt: iso(now),
    };
    const identity = await this.checkIdentity();
    report.identity.readOnly = identity.readOnly;
    report.identity.findings = identity.reasonCodes;
    if (!report.identity.readOnly) {
      report.verdict = "FAIL";
      report.reasonCodes.push("VERIFIER_IDENTITY_NOT_READ_ONLY");
      this.finish(report);
      return report;
    }

    // 1. integrity (local and, with a reader, shipped).
    const integrity: StreamVerification[] = [];
    const iv = new IntegrityVerifier({ db: this.opts.db, sink: this.opts.sink ?? NO_SINK, clock: this.opts.clock, role: VERIFIER_DB_ROLE });
    const streams = await iv.listStreams();
    report.streams = streams.length;
    for (const s of streams) {
      const local = await iv.verifyStream(s);
      integrity.push(local);
      report.localEventsChecked += local.checkedEvents;
      if (this.opts.sink) {
        const shipped = await iv.verifyShipped(s);
        integrity.push(shipped);
      }
    }

    // 2. exported evidence index and manifest signatures.
    const exported = evidenceIndex();
    if (this.opts.sink) {
      const sig: SignatureSummary = { manifests: 0, valid: 0, unsigned: 0, invalid: 0, untrustedKey: 0, partial: 0 };
      for (const s of streams) {
        let manifests: AuditManifest[];
        try {
          manifests = await this.opts.sink.listManifests(s);
        } catch {
          continue; // already reported by verifyShipped as SINK_UNAVAILABLE
        }
        for (const m of manifests) {
          sig.manifests += 1;
          if (this.opts.signatures) this.countSignature(sig, this.opts.signatures.check(m), m, integrity);
          let body: string;
          try {
            body = await this.opts.sink.getBatch(m.objectKey);
          } catch {
            continue; // BATCH_MISSING reported by verifyShipped
          }
          for (const line of parseNdjson(body)) {
            if (!line.ok) continue;
            addEvidence(exported, evidenceOf(line.event));
            report.exportedEventsChecked += 1;
          }
        }
      }
      report.signatures = this.opts.signatures ? sig : null;
    }

    // 3. ingestion: chain heads vs rows present; unshipped older than the grace.
    const ingestion = await this.ingestion(now);
    report.ingestionGaps = ingestion.length;

    // 4. reconciliation against exported evidence (+ local events not yet due for export); without a sink
    // reader, against the local outbox with shipped evidence reported as unverified (see the module doc).
    const pending = await this.pendingExport(now);
    const evidence = { exported, pending };
    const recon = await this.reconcile(from.data, to.data, evidence, now);
    report.reconciliation = recon.summary;
    const unverified = recon.summary.reduce((n, s) => n + s.unverified, 0);
    report.discrepancies = recon.discrepancies.slice(0, MAX_REPORTED);

    const allFindings = integrity.flatMap((v) => v.findings);
    report.integrityFindings = allFindings.length;
    report.findings = allFindings.slice(0, MAX_REPORTED);

    const assessment = assessCompleteness({
      integrity,
      ingestion: { ok: ingestion.length === 0, checkedStreams: streams.length, gaps: [] },
      reconciliation: { ok: recon.discrepancies.length === 0, expectedTotal: 0, observedTotal: 0, discrepancies: [] },
    });
    const reasons = [...assessment.reasonCodes];
    let verdict = assessment.verdict;
    if (ingestion.length > 0 && !reasons.includes("INGESTION_GAPS")) reasons.push("INGESTION_GAPS");
    const sig = report.signatures;
    if (sig && sig.unsigned + sig.invalid + sig.untrustedKey + sig.partial > 0) {
      verdict = "FAIL";
      reasons.push("MANIFEST_SIGNATURE_FINDINGS");
    }
    if (!this.opts.sink) {
      reasons.push("SINK_READER_NOT_CONFIGURED");
      if (unverified > 0) reasons.push("RECONCILIATION_NOT_VERIFIED_WITHOUT_SINK");
      if (verdict === "PASS") verdict = "INCONCLUSIVE";
    }
    if (this.opts.sink && !this.opts.signatures) {
      reasons.push("SIGNATURES_NOT_VERIFIED");
      if (verdict === "PASS") verdict = "INCONCLUSIVE";
    }
    report.verdict = verdict;
    report.reasonCodes = [...new Set(reasons)];
    this.finish(report);
    return report;
  }

  private countSignature(sig: SignatureSummary, check: ManifestSignatureCheck, m: AuditManifest, integrity: StreamVerification[]): void {
    if (check === "VALID") {
      sig.valid += 1;
      this.metric("vsp_audit_manifest_signatures_total", { result: "verified" });
      return;
    }
    if (check === "UNSIGNED") sig.unsigned += 1;
    else if (check === "UNTRUSTED_KEY") sig.untrustedKey += 1;
    else if (check === "PARTIAL" || check === "WRONG_SIGNER_ROLE") sig.partial += 1;
    else sig.invalid += 1;
    this.metric("vsp_audit_manifest_signatures_total", { result: check === "UNSIGNED" ? "unsigned" : "invalid" });
    integrity.push({
      sourceStream: m.sourceStream,
      scope: "shipped",
      ok: false,
      checkedEvents: 0,
      firstSequence: m.firstSequence,
      lastSequence: m.lastSequence,
      findings: [{ code: check === "UNSIGNED" ? "MANIFEST_UNSIGNED" : "MANIFEST_SIGNATURE_INVALID", sourceStream: m.sourceStream, sequence: m.firstSequence, manifestId: m.manifestId }],
    });
  }

  private async ingestion(now: Date): Promise<string[]> {
    const cutoff = iso(new Date(now.getTime() - this.graceMs));
    const rows = await guardStorage("AUDIT_STORE_UNAVAILABLE", () =>
      this.opts.db.tx(
        (tx) =>
          tx.query<{ s: string; head: unknown; purged: unknown; present: unknown; lagging: unknown }>(
            `select h.source_stream as s, h.last_sequence::text as head, coalesce(w.purged_through_sequence, 0)::text as purged,
                    (select count(*) from audit_outbox o where o.source_stream = h.source_stream)::text as present,
                    (select count(*) from audit_outbox o where o.source_stream = h.source_stream and o.shipped_at is null and o.recorded_at <= $1::timestamptz)::text as lagging
               from audit_chain_heads h left join audit_purge_watermarks w on w.source_stream = h.source_stream order by 1`,
            [cutoff],
          ),
        { role: VERIFIER_DB_ROLE },
      ),
    );
    const gaps: string[] = [];
    for (const r of rows.rows) {
      const expected = toSafeInt(r.head) - toSafeInt(r.purged);
      const present = toSafeInt(r.present);
      if (present !== expected) gaps.push(`${present < expected ? "COUNT_SHORTFALL" : "COUNT_EXCESS"}:${r.s}`);
      if (toSafeInt(r.lagging) > 0) gaps.push(`SINK_INGESTION_LAG:${r.s}`);
    }
    return gaps;
  }

  /** Local events that are not yet due in the sink (unshipped, recorded within the export grace). */
  private async pendingExport(now: Date): Promise<EvidenceIndex> {
    const cutoff = iso(new Date(now.getTime() - this.graceMs));
    const idx = evidenceIndex();
    const rows = await guardStorage("AUDIT_STORE_UNAVAILABLE", () =>
      this.opts.db.tx(
        (tx) =>
          tx.query<{ event_id: string; tenant_id: string; action: string; correlation_id: string; k: string | null; pointers: unknown; refs: unknown }>(
            `select event_id, tenant_id, action, correlation_id, event ->> 'idempotencyKey' as k,
                    event -> 'evidencePointers' as pointers, event -> 'receiptRefs' as refs
               from audit_outbox where shipped_at is null and recorded_at > $1::timestamptz`,
            [cutoff],
          ),
        { role: VERIFIER_DB_ROLE },
      ),
    );
    for (const r of rows.rows) {
      addEvidence(idx, { eventId: r.event_id, tenantId: r.tenant_id, action: r.action, correlationId: r.correlation_id, idempotencyKey: r.k, receipts: receiptsOf(r.pointers, r.refs) });
    }
    return idx;
  }

  private async reconcile(
    from: string,
    to: string,
    evidence: { exported: EvidenceIndex; pending: EvidenceIndex },
    now: Date,
  ): Promise<{ summary: SourceReconciliation[]; discrepancies: (ReconciliationDiscrepancy & { source: ReconciliationSource })[] }> {
    const sources = await guardStorage("AUDIT_STORE_UNAVAILABLE", () =>
      this.opts.db.tx(
        async (tx) => {
          const ledger = await tx.query<{ action_id: string; tenant_id: string; provider_idempotency_key: string; receipt: unknown }>(
            `select action_id, tenant_id, provider_idempotency_key, receipt from action_ledger
              where state = 'COMMITTED' and updated_at >= $1::timestamptz and updated_at < $2::timestamptz order by action_id`,
            [from, to],
          );
          const crm = await tx.query<{ support_request_id: string; tenant_id: string }>(
            `select support_request_id, tenant_id from support_requests
              where sync_state = 'SYNCED' and synced_at >= $1::timestamptz and synced_at < $2::timestamptz order by support_request_id`,
            [from, to],
          );
          const pendingRoutes = await tx.query<{ deferral_id: string }>(
            `select deferral_id from audit_deferred where status = 'PENDING' and deferred_at <= $1::timestamptz order by deferral_id`,
            [iso(new Date(now.getTime() - this.graceMs))],
          );
          const recordedRoutes = await tx.query<{ deferral_id: string; tenant_id: string; action: string; correlation_id: string; recorded_event_id: string }>(
            `select deferral_id, tenant_id, action, correlation_id, recorded_event_id from audit_deferred
              where status = 'RECORDED' and recorded_at >= $1::timestamptz and recorded_at < $2::timestamptz order by deferral_id`,
            [from, to],
          );
          const markers = await tx.query<{ subject_id: string; audit_event_id: string; tenant_id: string }>(
            `select subject_id, audit_event_id, tenant_id from route_audit_reconciliations
              where result = 'NOT_RECORDED' and reconciled_at >= $1::timestamptz and reconciled_at < $2::timestamptz order by subject_id`,
            [from, to],
          );
          return { ledger: ledger.rows, crm: crm.rows, pendingRoutes: pendingRoutes.rows, recordedRoutes: recordedRoutes.rows, markers: markers.rows };
        },
        { role: VERIFIER_DB_ROLE },
      ),
    );

    // Without a sink reader: the local copies of the referenced evidence (shipped => unverifiable; unshipped past the
    // grace => known NOT exported), and whether anything was ever purged (then absent evidence is unverifiable too).
    const local = this.opts.sink
      ? null
      : await this.localEvidence(
          [
            ...sources.ledger.map((l) => (l.receipt as { auditEventId?: unknown } | null)?.auditEventId),
            ...sources.recordedRoutes.map((d) => d.recorded_event_id),
            ...sources.markers.map((m) => m.audit_event_id),
          ].filter((id): id is string => typeof id === "string" && !evidence.pending.byId.has(id)),
          sources.crm.map((c) => ({ tenantId: c.tenant_id, correlationId: c.support_request_id })),
        );

    /** Where the evidence an expected item names stands: observed (exported or not yet due), unverifiable, or missing. */
    type Resolution = { kind: "observed" | "unverifiable" | "missing"; ev: EvidenceEntry | null };
    const resolve = (id: unknown): Resolution => {
      if (typeof id !== "string") return { kind: "missing", ev: null };
      const ev = evidence.exported.byId.get(id) ?? evidence.pending.byId.get(id);
      if (ev) return { kind: "observed", ev };
      if (!local) return { kind: "missing", ev: null };
      const copy = local.byId.get(id);
      if (copy) return { kind: copy.shipped ? "unverifiable" : "missing", ev: copy.entry };
      return { kind: local.purgedAny ? "unverifiable" : "missing", ev: null };
    };
    /** The resolution counts only when the evidence it can see matches the item's keys (an unseen purged copy cannot be keyed). */
    const keyed = (r: Resolution, matches: (ev: EvidenceEntry) => boolean): Resolution["kind"] => {
      if (r.kind === "missing") return "missing";
      if (r.ev === null) return r.kind === "unverifiable" ? "unverifiable" : "missing";
      return matches(r.ev) ? r.kind : "missing";
    };

    const out: (ReconciliationDiscrepancy & { source: ReconciliationSource })[] = [];
    const summary: SourceReconciliation[] = [];
    const tally = () => ({ expected: [] as string[], observed: [] as string[], unverified: [] as string[] });
    const note = (t: ReturnType<typeof tally>, key: string, kind: Resolution["kind"]) => {
      t.expected.push(key);
      if (kind === "observed") t.observed.push(key);
      else if (kind === "unverifiable") t.unverified.push(key);
    };
    const run = (source: ReconciliationSource, action: string, t: ReturnType<typeof tally>) => {
      // Unverified items are not discrepancies (only the sink could tell); they keep the verdict from PASS.
      const r = reconcileCounts({ [action]: t.expected }, { [action]: [...t.observed, ...t.unverified] });
      summary.push({ source, expected: t.expected.length, observed: t.observed.length, unverified: t.unverified.length, discrepancies: r.discrepancies.length });
      for (const d of r.discrepancies) out.push({ ...d, source });
      if (r.discrepancies.length > 0) this.metric("vsp_audit_reconciliation_discrepancies_total", { source }, r.discrepancies.length);
    };

    // Committed actions: the commit event the receipt names must be exported evidence of THIS action — same
    // tenant, a commit-evidence action, bound to the ledger's provider idempotency key. Provider receipts:
    // that same event must reference the receipt id (evidence pointer receipt:<id> or receiptRefs).
    const committed = tally();
    const receipts = tally();
    for (const l of sources.ledger) {
      const receipt = (l.receipt ?? {}) as { receiptId?: unknown; auditEventId?: unknown };
      const res = resolve(receipt.auditEventId);
      const isCommitEvidence = (ev: EvidenceEntry) => ev.tenantId === l.tenant_id && (COMMIT_EVIDENCE_ACTIONS as readonly string[]).includes(ev.action) && ev.idempotencyKey === l.provider_idempotency_key;
      const commitKind = keyed(res, isCommitEvidence);
      note(committed, l.action_id, commitKind);
      if (typeof receipt.receiptId === "string") {
        const receiptId = receipt.receiptId;
        note(receipts, receiptId, commitKind === "missing" ? "missing" : keyed(res, (ev) => isCommitEvidence(ev) && ev.receipts.has(receiptId)));
      }
    }
    run("committed_action", "action.commit", committed);
    run("provider_receipt", "commit.receipt", receipts);

    // CRM writes: every synchronised support request has its support_request.synced event.
    const crm = tally();
    for (const c of sources.crm) {
      const k = corrKey(c.tenant_id, CRM_SYNCED_ACTION, c.support_request_id);
      const seen = (evidence.exported.byCorrelation.get(k) ?? 0) + (evidence.pending.byCorrelation.get(k) ?? 0);
      let kind: Resolution["kind"] = seen > 0 ? "observed" : "missing";
      if (kind === "missing" && local) {
        const copies = local.byCorrelation.get(k);
        kind = copies && copies.shipped > 0 ? "unverifiable" : copies && copies.unshipped > 0 ? "missing" : local.purgedAny ? "unverifiable" : "missing";
      }
      note(crm, c.support_request_id, kind);
    }
    run("crm_write", CRM_SYNCED_ACTION, crm);

    // Route evidence: no deferral pending past the grace; a deferral marked RECORDED must have its route event in
    // the exported evidence (same tenant, action and correlation); every not_recorded marker is evidence too.
    const routes = tally();
    for (const p of sources.pendingRoutes) note(routes, p.deferral_id, "missing");
    for (const d of sources.recordedRoutes) {
      note(routes, d.deferral_id, keyed(resolve(d.recorded_event_id), (ev) => ev.tenantId === d.tenant_id && ev.action === d.action && ev.correlationId === d.correlation_id));
    }
    for (const m of sources.markers) {
      note(routes, m.subject_id, keyed(resolve(m.audit_event_id), (ev) => ev.action === ROUTE_NOT_RECORDED_ACTION && ev.tenantId === m.tenant_id));
    }
    run("route_evidence", "route.evidence", routes);

    return { summary, discrepancies: out };
  }

  /**
   * Local copies of the evidence a sink-less run needs: the named events (primary key) and the CRM-sync events of
   * the given (tenant, support request) pairs (tenant/correlation index), with whether each was shipped; and
   * whether any stream was ever purged (a purged event exists only in the sink).
   */
  private async localEvidence(
    eventIds: readonly string[],
    crmWrites: readonly { tenantId: string; correlationId: string }[],
  ): Promise<{ byId: Map<string, { entry: EvidenceEntry; shipped: boolean }>; byCorrelation: Map<string, { shipped: number; unshipped: number }>; purgedAny: boolean }> {
    type Row = { event_id: string; tenant_id: string; action: string; correlation_id: string; k: string | null; pointers: unknown; refs: unknown; shipped: boolean };
    const columns = `event_id, tenant_id, action, correlation_id, event ->> 'idempotencyKey' as k,
                     event -> 'evidencePointers' as pointers, event -> 'receiptRefs' as refs, shipped_at is not null as shipped`;
    const rows = await guardStorage("AUDIT_STORE_UNAVAILABLE", () =>
      this.opts.db.tx(
        async (tx) => {
          const named = await tx.query<Row>(`select ${columns} from audit_outbox where event_id = any($1::text[])`, [[...new Set(eventIds)]]);
          const synced = await tx.query<Row>(
            `select ${columns} from audit_outbox
              where (tenant_id, correlation_id) in (select t, c from unnest($1::text[], $2::text[]) as w(t, c)) and action = $3`,
            [crmWrites.map((w) => w.tenantId), crmWrites.map((w) => w.correlationId), CRM_SYNCED_ACTION],
          );
          const purged = await tx.query<{ any: boolean }>("select exists (select 1 from audit_purge_watermarks) as any");
          return { events: [...named.rows, ...synced.rows], purgedAny: purged.rows[0]?.any !== false };
        },
        { role: VERIFIER_DB_ROLE },
      ),
    );
    const byId = new Map<string, { entry: EvidenceEntry; shipped: boolean }>();
    const byCorrelation = new Map<string, { shipped: number; unshipped: number }>();
    for (const r of rows.events) {
      const entry: EvidenceEntry = { eventId: r.event_id, tenantId: r.tenant_id, action: r.action, correlationId: r.correlation_id, idempotencyKey: r.k, receipts: receiptsOf(r.pointers, r.refs) };
      if (byId.has(r.event_id)) continue; // found by both lookups
      byId.set(r.event_id, { entry, shipped: r.shipped === true });
      if (r.action === CRM_SYNCED_ACTION) {
        const k = corrKey(r.tenant_id, r.action, r.correlation_id);
        const c = byCorrelation.get(k) ?? { shipped: 0, unshipped: 0 };
        if (r.shipped === true) c.shipped += 1;
        else c.unshipped += 1;
        byCorrelation.set(k, c);
      }
    }
    return { byId, byCorrelation, purgedAny: rows.purgedAny };
  }

  private finish(report: AuditVerificationReport): void {
    this.metric("vsp_audit_verifier_runs_total", { verdict: report.verdict.toLowerCase() });
    const log = report.verdict === "FAIL" ? this.logger.error.bind(this.logger) : this.logger.info.bind(this.logger);
    log("audit.verifier.run", {
      reasonCode: report.reasonCodes[0] ?? null,
      verdict: report.verdict,
      streams: report.streams,
      integrityFindings: report.integrityFindings,
      ingestionGaps: report.ingestionGaps,
      discrepancies: report.discrepancies.length,
    });
  }

  private metric(name: string, labels: Record<string, string>, n = 1): void {
    try {
      this.metrics.increment(name, labels, n);
    } catch {
      // metrics never change the verdict
    }
  }
}

/** Placeholder for a verifier without a sink reader: verifyShipped is never called with it. */
const NO_SINK: AuditSink = {
  kind: "live",
  putBatch: () => Promise.reject(new ValidationError("AUDIT_SINK_READER_NOT_COMPOSED")),
  listManifests: () => Promise.reject(new ValidationError("AUDIT_SINK_READER_NOT_COMPOSED")),
  getBatch: () => Promise.reject(new ValidationError("AUDIT_SINK_READER_NOT_COMPOSED")),
};

