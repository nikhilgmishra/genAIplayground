/**
 * Limited, provenance-labelled support memory over PostgreSQL (migration 0700;
 * spec section 9, DATA-04).
 *
 * What may be stored: verified preferences, active issues, completed actions,
 * promises, deadlines and reviewed summaries, as STRUCTURED values only. Each
 * kind has a closed set of keys with typed formats (codes, opaque references,
 * support references, timestamps, queue ids); free text is rejected, so no
 * clinical narrative can enter memory.
 *
 * What may never be stored (DATA-04): anything naming identity, assurance,
 * consent, authentication/authorization, role, scope or permissions, and any
 * clinical concept (diagnosis, medication, symptoms, risk, therapy...). Such keys
 * or code values are rejected here and again by a database trigger.
 *
 * Provenance labels: VERIFIED (from a system of record or review), CALLER_REPORTED
 * (from a call), MACHINE_INFERRED. Recaps never present MACHINE_INFERRED entries
 * as facts: they are excluded unless the entry is a REVIEWED_SUMMARY whose
 * source is a human review record (review://rvw_...), and that entry keeps its
 * MACHINE_INFERRED label so the voice layer can say it is a reviewed summary.
 *
 * Recap disclosure: only for assurance A2/A3 with the authorized subject equal
 * to the memory subject, never on A0/A1 (caller ID or a shared phone does not
 * authenticate), never for another subject or tenant, only unexpired entries.
 * Memory never grants authorization: nothing in this module returns or feeds an
 * AuthContext, consent state or policy input.
 *
 * Not implemented, by design (spec section 9): nightly "dreaming", self-editing
 * policies, cross-customer memory, online reinforcement learning, automatic
 * retraining. There is no API that reads memory across subjects.
 */
import { z } from "zod";
import type { Db } from "../db/types.js";
import type { Logger, Metrics } from "../observability/ports.js";
import { silentLogger } from "../observability/logger.js";
import { Assurance, IsoDateTime, OpaqueId, RiskFlag } from "../protocol/index.js";
import type { Clock } from "../shared/clock.js";
import { iso, systemClock } from "../shared/clock.js";
import { ValidationError } from "../shared/errors.js";
import { newId } from "../shared/ids.js";
import type { MemoryEntry, MemoryProvenance, SupportMemory } from "./ports.js";

export const MemoryKind = z.enum(["PREFERENCE", "OPEN_ISSUE", "COMPLETED_ACTION", "PROMISE", "DEADLINE", "REVIEWED_SUMMARY"]);
export const MemoryProvenanceSchema = z.enum(["VERIFIED", "CALLER_REPORTED", "MACHINE_INFERRED"]);

type ValueFormat = "CODE" | "CODE_OR_TOKEN" | "LANGUAGE" | "TIMEZONE" | "SUPPORT_REF" | "REF" | "DATETIME" | "QUEUE" | "INT" | "BOOL";

/** Closed key set per kind. Anything else is rejected. */
export const MEMORY_KEYS: Readonly<Record<MemoryEntry["kind"], Readonly<Record<string, ValueFormat>>>> = {
  PREFERENCE: { preferenceType: "CODE", preferenceValue: "CODE_OR_TOKEN", language: "LANGUAGE", timeZone: "TIMEZONE", contactWindow: "CODE" },
  OPEN_ISSUE: { issueCategory: "CODE", status: "CODE", nextStep: "CODE", supportReference: "SUPPORT_REF", caseRef: "REF", ownerQueue: "QUEUE", openedAt: "DATETIME", followUpRequired: "BOOL" },
  COMPLETED_ACTION: { actionType: "CODE", receiptRef: "REF", completedAt: "DATETIME", supportReference: "SUPPORT_REF", amountMinor: "INT" },
  PROMISE: { promiseType: "CODE", dueAt: "DATETIME", ownerQueue: "QUEUE", supportReference: "SUPPORT_REF" },
  DEADLINE: { deadlineType: "CODE", dueAt: "DATETIME", supportReference: "SUPPORT_REF" },
  REVIEWED_SUMMARY: { issueCategory: "CODE", status: "CODE", nextStep: "CODE", reviewedAt: "DATETIME", supportReference: "SUPPORT_REF" },
};

/** Exact (camelCase-split, lowercased) tokens that may never appear in a key. */
const FORBIDDEN_KEY_TOKENS = new Set([
  "assurance", "consent", "consented", "role", "roles", "authenticated", "authentication", "authorized", "authorization", "auth",
  "verified", "verification", "identity", "identified", "scope", "scopes", "permission", "permissions", "grant", "grants", "subject",
  "actor", "diagnosis", "diagnoses", "diagnosed", "medication", "medications", "medicine", "prescription", "dosage", "dose", "symptom",
  "symptoms", "risk", "condition", "conditions", "clinical", "therapy", "therapist", "treatment", "psychiatric", "mental", "mood",
  "suicide", "suicidal", "harm", "crisis", "password", "passcode", "pin", "otp", "secret", "token", "ssn", "dob", "birth", "birthdate",
]);
/** Stems that are forbidden anywhere in a key or a code value. */
const FORBIDDEN_STEMS = [
  "ASSURANC", "CONSENT", "AUTHENT", "AUTHORI", "VERIFIED", "IDENTIT", "PERMISSION", "DIAGNOS", "MEDICAT", "MEDICIN", "PRESCRI", "DOSAGE",
  "SYMPTOM", "CLINICAL", "THERAP", "PSYCH", "SUICID", "SELFHARM", "SELF_HARM", "CRISIS", "DEPRESS", "ANXIET", "BIPOLAR", "SCHIZO",
  "OVERDOSE", "PASSWORD", "PASSCODE",
];

const CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const TOKEN = /^[a-z][a-z0-9_.-]{0,63}$/;
const LANGUAGE = /^[a-z]{2,3}(-[A-Z]{2})?$/;
const TIMEZONE = /^(UTC|[A-Za-z]+(?:\/[A-Za-z_+-]+){1,2})$/;
const SUPPORT_REF = /^SR-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
const QUEUE = /^q_[a-z0-9_]{2,40}$/;
const SOURCE_REF = /^(?:(ledger|case|wf|call|review):\/\/[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}|sr:\/\/SR-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4})$/;
const REVIEW_REF = /^review:\/\/rvw_[A-Za-z0-9_-]{16,64}$/;
const ASSURANCE_CODE = /^A[0-3]$/;

export const keyTokens = (key: string): string[] =>
  key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_-]+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 0);

function forbiddenKey(key: string): boolean {
  if (keyTokens(key).some((t) => FORBIDDEN_KEY_TOKENS.has(t))) return true;
  const upper = key.toUpperCase();
  return FORBIDDEN_STEMS.some((s) => upper.includes(s));
}

function forbiddenCode(value: string): boolean {
  const upper = value.toUpperCase();
  return ASSURANCE_CODE.test(value) || FORBIDDEN_STEMS.some((s) => upper.includes(s)) || /(^|_)(ROLE|SCOPE|RISK|GRANTED|DECLINED)(_|$)/.test(upper);
}

function valueMatches(format: ValueFormat, v: unknown): boolean {
  switch (format) {
    case "CODE":
      return typeof v === "string" && CODE.test(v) && !forbiddenCode(v);
    case "CODE_OR_TOKEN":
      return typeof v === "string" && (CODE.test(v) || TOKEN.test(v)) && !forbiddenCode(v);
    case "LANGUAGE":
      return typeof v === "string" && LANGUAGE.test(v);
    case "TIMEZONE":
      return typeof v === "string" && TIMEZONE.test(v);
    case "SUPPORT_REF":
      return typeof v === "string" && SUPPORT_REF.test(v);
    case "REF":
      return typeof v === "string" && OpaqueId.safeParse(v).success;
    case "DATETIME":
      return typeof v === "string" && IsoDateTime.safeParse(v).success;
    case "QUEUE":
      return typeof v === "string" && QUEUE.test(v);
    case "INT":
      return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
    case "BOOL":
      return typeof v === "boolean";
  }
}

/** Reason codes for an invalid value (empty = valid). Exported for tests and for callers that pre-check. */
export function memoryValueViolations(kind: MemoryEntry["kind"], value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["MEMORY_VALUE_NOT_OBJECT"];
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0 || entries.length > 12) return ["MEMORY_VALUE_SIZE"];
  const allowed = MEMORY_KEYS[kind];
  const v = new Set<string>();
  for (const [key, val] of entries) {
    if (forbiddenKey(key)) {
      v.add("MEMORY_FORBIDDEN_KEY");
      continue;
    }
    const format = allowed[key];
    if (!format) {
      v.add("MEMORY_KEY_NOT_ALLOWED_FOR_KIND");
      continue;
    }
    if (typeof val === "string" && (format === "CODE" || format === "CODE_OR_TOKEN") && forbiddenCode(val)) {
      v.add("MEMORY_FORBIDDEN_VALUE");
      continue;
    }
    if (!valueMatches(format, val)) v.add("MEMORY_VALUE_FORMAT");
  }
  return [...v].sort();
}

const RecordInput = z.strictObject({
  tenantId: OpaqueId,
  subjectId: OpaqueId,
  kind: MemoryKind,
  value: z.record(z.string().regex(/^[a-z][a-zA-Z0-9]{0,40}$/), z.union([z.string().max(200), z.number(), z.boolean(), z.null()])),
  provenance: MemoryProvenanceSchema,
  sourceRef: z.string().regex(SOURCE_REF),
  expiresAt: IsoDateTime,
});

const RecapInput = z.strictObject({
  tenantId: OpaqueId,
  subjectId: OpaqueId,
  assurance: z.string(),
  authorizedSubjectId: OpaqueId.nullable(),
  now: z.date().refine((d) => Number.isFinite(d.getTime())),
  riskFlags: z.array(RiskFlag).max(16).optional(),
});

/** Risk flags that suppress a recap even for an authenticated caller. */
const RECAP_BLOCKING_FLAGS: readonly string[] = ["PARTICIPANT_CHANGED", "ACCOUNT_RECOVERY_IN_PROGRESS", "FRAUD_REVIEW", "SAFETY_ESCALATION_ACTIVE"];

export interface SupportMemoryOptions {
  db: Db;
  /** Tenants whose expired entries `expire()` deletes (tenant-scoped, RLS-respecting). */
  tenantIds: readonly string[];
  clock?: Clock;
  logger?: Logger;
  /** Optional upper bound on expiry horizon, set from an approved retention policy. No default is invented. */
  maxTtlMs?: number | null;
  /** Maximum entries in one recap. */
  recapLimit?: number;
  /** Content-free vsp_memory_recap_withheld_total{reason} (closed reason set). */
  metrics?: Metrics;
}

interface Row {
  memory_id: string;
  tenant_id: string;
  subject_id: string;
  kind: MemoryEntry["kind"];
  value: MemoryEntry["value"];
  provenance: MemoryProvenance;
  source_ref: string;
  created_at: Date | string;
  expires_at: Date | string;
}

/** Whether an entry may be presented in a recap (see module doc). */
export function recapEligible(e: Pick<MemoryEntry, "kind" | "provenance" | "sourceRef">): boolean {
  if (e.provenance !== "MACHINE_INFERRED") return true;
  return e.kind === "REVIEWED_SUMMARY" && REVIEW_REF.test(e.sourceRef);
}

export type RecapLabel = "VERIFIED" | "CALLER_REPORTED" | "MACHINE_SUMMARY_HUMAN_REVIEWED";

/** Spoken-label class for the voice layer. Memory never grants authorization nor states medical fact. */
export function recapLabel(e: Pick<MemoryEntry, "provenance" | "kind">): { label: RecapLabel; grantsAuthorization: false; medicalFact: false } {
  const label: RecapLabel = e.provenance === "MACHINE_INFERRED" ? "MACHINE_SUMMARY_HUMAN_REVIEWED" : e.provenance;
  return { label, grantsAuthorization: false, medicalFact: false };
}

export class SupportMemoryPg implements SupportMemory {
  readonly kind = "live" as const;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly tenantIds: readonly string[];

  constructor(private readonly opts: SupportMemoryOptions) {
    for (const t of opts.tenantIds) if (!OpaqueId.safeParse(t).success) throw new ValidationError("MEMORY_TENANT_INVALID");
    if (opts.maxTtlMs !== undefined && opts.maxTtlMs !== null && (!Number.isSafeInteger(opts.maxTtlMs) || opts.maxTtlMs <= 0)) throw new ValidationError("MEMORY_MAX_TTL_INVALID");
    this.tenantIds = [...opts.tenantIds];
    this.clock = opts.clock ?? systemClock;
    this.logger = opts.logger ?? silentLogger;
  }

  async record(entry: Omit<MemoryEntry, "memoryId" | "createdAt">): Promise<MemoryEntry> {
    const parsed = RecordInput.safeParse(entry);
    if (!parsed.success) {
      const keys = entry && typeof entry === "object" && entry.value && typeof entry.value === "object" ? Object.keys(entry.value) : [];
      throw new ValidationError(keys.some(forbiddenKey) ? "MEMORY_FORBIDDEN_KEY" : "MEMORY_ENTRY_INVALID");
    }
    const e = parsed.data;
    const violations = memoryValueViolations(e.kind, e.value);
    if (violations.length > 0) {
      this.logger.warn("memory.record.rejected", { reasonCode: violations[0] ?? "MEMORY_ENTRY_INVALID", kind: e.kind });
      throw new ValidationError(violations[0] ?? "MEMORY_ENTRY_INVALID");
    }
    if (e.kind === "REVIEWED_SUMMARY" && !REVIEW_REF.test(e.sourceRef)) throw new ValidationError("MEMORY_REVIEWED_SUMMARY_REQUIRES_REVIEW_REF");
    if (e.provenance === "CALLER_REPORTED" && !e.sourceRef.startsWith("call://")) throw new ValidationError("MEMORY_PROVENANCE_SOURCE_MISMATCH");
    if (e.provenance === "VERIFIED" && e.sourceRef.startsWith("call://")) throw new ValidationError("MEMORY_PROVENANCE_SOURCE_MISMATCH");
    const now = this.clock.now();
    const expiresAt = Date.parse(e.expiresAt);
    if (expiresAt <= now.getTime()) throw new ValidationError("MEMORY_EXPIRY_NOT_IN_FUTURE");
    if (this.opts.maxTtlMs && expiresAt - now.getTime() > this.opts.maxTtlMs) throw new ValidationError("MEMORY_EXPIRY_BEYOND_APPROVED_MAXIMUM");

    const out: MemoryEntry = {
      memoryId: newId("mem"),
      tenantId: e.tenantId,
      subjectId: e.subjectId,
      kind: e.kind,
      value: e.value,
      provenance: e.provenance,
      sourceRef: e.sourceRef,
      createdAt: iso(now),
      expiresAt: new Date(expiresAt).toISOString(),
    };
    await this.opts.db.tx(
      (tx) =>
        tx.query(
          `insert into support_memory (memory_id, tenant_id, subject_id, kind, value, provenance, source_ref, created_at, expires_at)
           values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::timestamptz, $9::timestamptz)`,
          [out.memoryId, out.tenantId, out.subjectId, out.kind, JSON.stringify(out.value), out.provenance, out.sourceRef, out.createdAt, out.expiresAt],
        ),
      { role: "app_runtime", rls: { tenantId: out.tenantId, subjectId: out.subjectId } },
    );
    this.logger.info("memory.record.stored", { memoryId: out.memoryId, kind: out.kind, provenance: out.provenance });
    return out;
  }

  async recapFor(input: {
    tenantId: string;
    subjectId: string;
    assurance: string;
    authorizedSubjectId: string | null;
    now: Date;
    riskFlags?: string[];
  }): Promise<MemoryEntry[]> {
    const parsed = RecapInput.safeParse(input);
    if (!parsed.success) throw new ValidationError("MEMORY_RECAP_INPUT_INVALID");
    const r = parsed.data;
    const assurance = Assurance.safeParse(r.assurance);
    const deny = (reasonCode: string): MemoryEntry[] => {
      this.logger.info("memory.recap.withheld", { reasonCode });
      try {
        this.opts.metrics?.increment("vsp_memory_recap_withheld_total", { reason: reasonCode });
      } catch {
        // Metrics never release a withheld recap.
      }
      return [];
    };
    if (!assurance.success) return deny("MEMORY_RECAP_ASSURANCE_INVALID");
    if (assurance.data !== "A2" && assurance.data !== "A3") return deny("MEMORY_RECAP_REQUIRES_A2");
    if (r.authorizedSubjectId === null || r.authorizedSubjectId !== r.subjectId) return deny("MEMORY_RECAP_SUBJECT_NOT_AUTHORIZED");
    if ((r.riskFlags ?? []).some((f) => RECAP_BLOCKING_FLAGS.includes(f))) return deny("MEMORY_RECAP_RISK_FLAG");

    const nowIso = r.now.toISOString();
    const rows = await this.opts.db.tx(
      async (tx) =>
        (
          await tx.query<Row>(
            `select memory_id, tenant_id, subject_id, kind, value, provenance, source_ref, created_at, expires_at
               from support_memory
              where tenant_id = $1 and subject_id = $2 and expires_at > $3::timestamptz and created_at <= $3::timestamptz
              order by created_at desc, memory_id asc
              limit $4`,
            [r.tenantId, r.subjectId, nowIso, Math.min(50, this.opts.recapLimit ?? 10) * 2],
          )
        ).rows,
      { role: "app_runtime", rls: { tenantId: r.tenantId, subjectId: r.subjectId } },
    );
    const out: MemoryEntry[] = [];
    for (const row of rows) {
      const entry: MemoryEntry = {
        memoryId: row.memory_id,
        tenantId: row.tenant_id,
        subjectId: row.subject_id,
        kind: row.kind,
        value: row.value,
        provenance: row.provenance,
        sourceRef: row.source_ref,
        createdAt: new Date(row.created_at).toISOString(),
        expiresAt: new Date(row.expires_at).toISOString(),
      };
      // Defense in depth: re-validate stored rows before disclosure.
      if (entry.tenantId !== r.tenantId || entry.subjectId !== r.subjectId || Date.parse(entry.expiresAt) <= r.now.getTime()) continue;
      if (!MemoryKind.safeParse(entry.kind).success || memoryValueViolations(entry.kind, entry.value).length > 0 || !SOURCE_REF.test(entry.sourceRef)) {
        this.logger.warn("memory.recap.invalid_row_dropped", { memoryId: entry.memoryId, reasonCode: "MEMORY_ROW_INVALID" });
        continue;
      }
      if (!recapEligible(entry)) continue;
      out.push(entry);
      if (out.length >= (this.opts.recapLimit ?? 10)) break;
    }
    return out;
  }

  async expire(now: Date): Promise<number> {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new ValidationError("MEMORY_EXPIRE_TIME_INVALID");
    let total = 0;
    for (const tenantId of this.tenantIds) {
      const n = await this.opts.db.tx(
        async (tx) => (await tx.query("delete from support_memory where tenant_id = $1 and expires_at <= $2::timestamptz", [tenantId, now.toISOString()])).rowCount,
        { role: "app_worker", rls: { tenantId } },
      );
      total += n;
      this.logger.info("memory.expire.completed", { tenantId, count: n });
    }
    return total;
  }
}
