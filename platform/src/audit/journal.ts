/**
 * Durable route-audit journal (follow-on FO-01-19, FO-15-45, FO-22-08; OPS-01, OPS-02, SAFE-03;
 * replaces the crash-loss limit of the process-local DeferredAuditQueue, ADR-0011).
 *
 * During an audit outage a human or safety route proceeds (fail-open ROUTING) but its audit event cannot
 * be appended to the audit outbox. DurableDeferredAuditQueue keeps such ROUTE evidence where a process
 * crash cannot lose it and appends it later, in deferral order, exactly once:
 *
 *  1. `appendOrDefer` appends now (audit event + resolution of the route's intent, one transaction) when it
 *     can. When older route events of the tenant wait in ANY journal — PENDING rows of audit_deferred, entries
 *     of the independent journal not yet drained (written while PostgreSQL refused, possibly by another
 *     replica) or the memory list — it first moves the independent and memory entries into audit_deferred and
 *     drains a bounded number in order, and journals the new event behind any that remain, so tenant order is
 *     kept. When a journal cannot be read, what it holds is unknown and the new event is journaled (never
 *     appended ahead); while the independent journal stays unreadable the tenant's flush appends nothing
 *     either, so evidence waits durably in audit_deferred (visible as vsp_audit_journal_pending and, past the
 *     grace, as a verifier discrepancy) instead of overtaking older evidence. Order is deferral order:
 *     `deferredAt`; at the same instant an entry first journaled in the independent journal; then journal order.
 *     Deferral times are strictly increasing per queue instance, and an event journaled behind older entries gets a
 *     deferral time after the newest of them (the newest PENDING row of audit_deferred, the newest PENDING item of the
 *     independent journal and the newest memory entry; bounded to 60 s ahead of its clock: an entry timed further
 *     ahead, by a skewed clock or a forged row, can be ordered after it), so it never ties with or precedes them, also
 *     when another replica with a clock ahead wrote them; across replicas that did not see each other's entries, order
 *     is as good as their clock synchronisation.
 *  2. Otherwise the event is journaled in the operational database (audit_deferred, migration 2040) — a
 *     different table and privilege set from the audit outbox, so an unwritable audit store, a broken
 *     chain head or a missing writer privilege does not prevent it.
 *  3. When PostgreSQL itself refuses (outage, read-only, pool exhausted) the event goes to the
 *     INDEPENDENT journal (DynamoRouteAuditJournal: a DynamoDB table with conditional writes, outside the
 *     audit database).
 *  4. Only when both refuse is it held in a bounded process-local list (the old behaviour), logged at
 *     error level as `audit.journal.memory_fallback`: the one remaining crash-loss path, now reachable
 *     only when the database AND the independent journal are down. RouteAuditReconciler still turns any
 *     route without evidence into an audit.route.not_recorded marker afterwards.
 *
 * `appendOrDeferIn(tx, ...)` does steps 1-2 inside the CALLER's transaction (a savepoint around the audit
 * append), so a route record written in that transaction (e.g. a safety_events row) and its route
 * evidence commit together or not at all. It drains nothing: when anything of the tenant waits in a journal
 * (or the independent journal cannot be read) the event is journaled behind it.
 *
 * Flush (`flush`, worker loop audit.deferred_flush or the gateway's DeferredAuditFlushTimer) per tenant,
 * under a per-tenant advisory lock (one flusher at a time keeps FIFO across processes):
 *   - drains the independent journal into audit_deferred (insert on deferral id, then mark drained:
 *     idempotent across crashes between the two steps), then the memory list. The independent read is bounded
 *     (valid and rejected items both count); when it is cut at its bound, older entries may still wait there, so
 *     the pass appends only deferrals read in it or with a deferral time below the greatest sort key read
 *     (`readBoundary`), and leaves newer ones PENDING for the next pass: a bounded flush never overtakes evidence
 *     it has not read yet;
 *   - for each PENDING row in (deferred_at, journal_seq) order, in ONE transaction: appends the event,
 *     appends the `audit.deferred.recorded` marker (parentId = the late event, reasonCode = why it was
 *     deferred), marks the row RECORDED and resolves the route's intent. A crash anywhere leaves either
 *     all of it or none of it: never a duplicate, never a loss;
 *   - an event the writer refuses as invalid is marked DROPPED loudly (it could never be written);
 *   - recounts what waits per store: `remaining`, `depth`, vsp_audit_deferred_depth and
 *     vsp_audit_journal_pending{journal="postgres"|"dynamodb"|"memory"}. Every flush recounts, also while
 *     AuditHealth reports the audit store unwritable (nothing is appended then, but audit_deferred and the
 *     independent journal are still counted, so a restarted process or a worker that did not defer the events
 *     itself reports them). A store that cannot be counted keeps its last known count instead of reading 0, so
 *     evidence held in the independent journal during a PostgreSQL outage stays visible; a store this process has
 *     not counted yet (it started during that store's outage) reports no gauge value at all, never a made-up 0,
 *     and the flush's reasonCode (e.g. DB_UNAVAILABLE) says why.
 *
 * Integrity of the independent journal: every item read back is re-validated (schema, input digest, the
 * tenant partition it was read from, its sort key, and a canonical deferral time PostgreSQL stores: the exact
 * `toISOString` form of an instant from 1970 to 9999, so e.g. "2026", which Date.parse accepts and timestamptz
 * refuses, is invalid). An item that fails (tampered with or corrupted) is never appended and never blocks the
 * tenant: it is QUARANTINED. So is an item that validates but whose content PostgreSQL refuses when it is drained
 * (a data exception, a NOT NULL or CHECK violation: it could never be drained, and retrying it would hold every
 * newer route event of the tenant behind it forever). The quarantine is evidenced in the audit chain first
 * (`audit.journal.entry_quarantined`, outcome FAILED, the rejection reason code, a content-free pointer
 * `kv://route-audit-journal/<sha256 of the item's sort key>` and a correlation id derived from it), then the item
 * is marked QUARANTINED in DynamoDB (conditional on PENDING; its stored content is kept for forensics). Until the
 * chain record can be written (audit store unwritable) the item stays PENDING and the tenant's route events wait
 * behind it, as for an unreadable journal. A crash between the two steps repeats the record under the same
 * correlation id; it is never lost. The route the item claimed to evidence stays unevidenced, so the reconciler
 * reports its intent as audit.route.not_recorded.
 *
 * This is NOT a path for consequential mutations: the action ledger and every in-transaction append keep
 * failing closed (AuditHealth.assertCanAcceptConsequential + PgAuditWriter.append).
 *
 * Content: the journal holds the schema-validated AuditEventInput (opaque ids and codes); logs and
 * metrics carry deferral ids, actions, reason codes and counts only.
 */
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { Db, DbRole, Queryable } from "../db/types.js";
import { silentLogger } from "../observability/logger.js";
import { noopMetrics } from "../observability/metrics.js";
import type { Logger, Metrics } from "../observability/ports.js";
import { AuditEventInput } from "../protocol/index.js";
import type { AuditEventInput as AuditEventInputT, AuditSourceComponent } from "../protocol/index.js";
import { canonicalJson, sha256Hex } from "../shared/canonical.js";
import type { Clock } from "../shared/clock.js";
import { iso } from "../shared/clock.js";
import { DependencyError, PlatformError, ValidationError } from "../shared/errors.js";
import { newId } from "../shared/ids.js";
import { buildAuditInput } from "./build-input.js";
import { DEFERRED_AUDIT_MARKER_ACTION } from "./deferred.js";
import type { DeferredFlushResult } from "./deferred.js";
import { AUDIT_HEALTH_REASONS } from "./health.js";
import { sqlStateOf, toSafeInt } from "./internal.js";
import type { AuditHealth, AuditWriter, DeferredAppendResult, DeferredAuditSink } from "./ports.js";
import { assertStreamName, isStorableAuditTimeMs, validateAuditInput } from "./schema.js";

export const DURABLE_DEFERRED_AUDIT_BADGE = "DURABLE ROUTE-AUDIT JOURNAL — PostgreSQL audit_deferred, independent DynamoDB journal, bounded memory last resort";

/** Route actions whose evidence resolves an open route_audit_intents row. */
export const ROUTE_AUDIT_ACTION_RE = /^(handoff|safety\.route)\./;
/** Route actions of a SAFETY route; the other ROUTE_AUDIT_ACTION_RE actions are human-transfer route evidence. */
export const SAFETY_ROUTE_ACTION_RE = /^(handoff\.safety_|safety\.route\.)/;

/**
 * Route kind an audit action evidences, or null for an action that is no route evidence. A SAFETY_ROUTE intent
 * is resolved only by safety route evidence; a HUMAN_TRANSFER intent by any route evidence of its correlation
 * (a human transfer escalated to a safety route is still audited).
 */
export function routeKindOfAction(action: string): "HUMAN_TRANSFER" | "SAFETY_ROUTE" | null {
  if (!ROUTE_AUDIT_ACTION_RE.test(action)) return null;
  return SAFETY_ROUTE_ACTION_RE.test(action) ? "SAFETY_ROUTE" : "HUMAN_TRANSFER";
}

/**
 * The PostgreSQL regular expressions (operator `~`) of the actions that evidence a route intent of `kind`, for
 * the reconciler's late-evidence lookup; keep them identical to routeKindOfAction.
 */
export function routeEvidenceActionPattern(kind: "HUMAN_TRANSFER" | "SAFETY_ROUTE"): string {
  return kind === "SAFETY_ROUTE" ? "^(handoff\\.safety_|safety\\.route\\.)" : "^(handoff|safety\\.route)\\.";
}

export interface JournalEntry {
  deferralId: string;
  tenantId: string;
  stream: string | null;
  input: AuditEventInputT;
  inputDigest: string;
  reasonCode: string;
  deferredAt: string;
}

/** Chain record of an independent-journal item that failed validation and was quarantined (never appended). */
export const JOURNAL_ENTRY_QUARANTINED_ACTION = "audit.journal.entry_quarantined";

/**
 * A PENDING item of the independent journal that fails validation on read (tampered with or corrupted). It is
 * addressed by its stored sort key only; nothing of its content is trusted or carried.
 */
export interface RejectedJournalItem {
  /** The tenant whose partition was read (the caller's trusted tenant, not the item's own attribute). */
  tenantId: string;
  /** The item's sort key as stored (addresses the item; never logged or written to the chain). */
  key: string;
  /** sha256 hex of the sort key: the content-free reference carried by the quarantine record. */
  ref: string;
  reasonCode: "AUDIT_JOURNAL_ENTRY_INVALID" | "AUDIT_JOURNAL_ENTRY_DIGEST_MISMATCH";
}

/** One read of a tenant's pending independent-journal items, in deferral order. */
export interface JournalRead {
  entries: JournalEntry[];
  rejected: RejectedJournalItem[];
}

/** Rejected item for a validation failure of the item stored under `key` in `tenantId`'s partition. */
export function rejectedJournalItem(tenantId: string, key: string, err: unknown): RejectedJournalItem {
  const reasonCode = err instanceof PlatformError && err.reasonCode === "AUDIT_JOURNAL_ENTRY_DIGEST_MISMATCH" ? "AUDIT_JOURNAL_ENTRY_DIGEST_MISMATCH" : "AUDIT_JOURNAL_ENTRY_INVALID";
  return { tenantId, key, ref: sha256Hex(key), reasonCode };
}

const REASON = /^[A-Z][A-Z0-9_]{2,63}$/;
const DEFERRAL_ID = /^dfr_[A-Za-z0-9_-]{16,64}$/;
const TENANT_ID = /^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$/;
const OPAQUE_ID = /^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$/;
const reasonOf = (err: unknown, fallback = "AUDIT_UNAVAILABLE"): string => (err instanceof PlatformError && REASON.test(err.reasonCode) ? err.reasonCode : fallback);
const isPermanent = (err: unknown): boolean => err instanceof ValidationError;

/**
 * Whether PostgreSQL refused a row for its CONTENT, so the same row can never be stored: a data exception (SQLSTATE
 * class 22: a value it cannot represent, an untranslatable character, an out-of-range date/time) or a NOT NULL / CHECK
 * violation. Connection, privilege, read-only, RLS and contention failures are not content refusals.
 */
function isContentRefusal(err: unknown): boolean {
  const state = sqlStateOf(err);
  return state !== null && (state.startsWith("22") || state === "23502" || state === "23514");
}

/**
 * Whether `value` is a canonical deferral time: exactly the form `Date.prototype.toISOString` gives
 * (`YYYY-MM-DDTHH:mm:ss.sssZ`, 24 characters) of an instant from 1970 to 9999. That is the form this queue writes,
 * the form a sort key starts with (so key order is time order) and a value PostgreSQL timestamptz stores exactly.
 * Anything else - "2026" (Date.parse accepts it, timestamptz refuses it), a local-time or offset form, a 6-digit year -
 * is not a deferral time.
 */
export function isCanonicalDeferralTime(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 24) return false;
  const ms = Date.parse(value);
  return isStorableAuditTimeMs(ms) && new Date(ms).toISOString() === value;
}

/** Deferral time (ms) a stored sort key `<deferredAt>#<deferralId>` starts with, or null when it does not start with a canonical one. */
export function deferralTimeOfSortKey(key: unknown): number | null {
  if (typeof key !== "string" || key.charAt(24) !== "#") return null;
  const at = key.slice(0, 24);
  return isCanonicalDeferralTime(at) ? Date.parse(at) : null;
}

/** Builds the journal entry for a validated event. */
export function journalEntryFor(input: AuditEventInputT, stream: string | null, reasonCode: string, deferredAt: string, deferralId = newId("dfr")): JournalEntry {
  return { deferralId, tenantId: input.tenantId, stream, input, inputDigest: sha256Hex(canonicalJson(input)), reasonCode: REASON.test(reasonCode) ? reasonCode : "AUDIT_UNAVAILABLE", deferredAt };
}

/** Re-validates an entry read back from a journal (a tampered or corrupted entry is refused, never appended). */
export function parseJournalEntry(raw: unknown): JournalEntry {
  const r = raw as Partial<JournalEntry> | null;
  if (!r || typeof r !== "object" || typeof r.deferralId !== "string" || !DEFERRAL_ID.test(r.deferralId)) throw new ValidationError("AUDIT_JOURNAL_ENTRY_INVALID");
  const parsed = AuditEventInput.safeParse(r.input);
  if (!parsed.success) throw new ValidationError("AUDIT_JOURNAL_ENTRY_INVALID");
  const input = validateAuditInput(parsed.data);
  if (typeof r.inputDigest !== "string" || sha256Hex(canonicalJson(input)) !== r.inputDigest) throw new ValidationError("AUDIT_JOURNAL_ENTRY_DIGEST_MISMATCH");
  if (r.tenantId !== input.tenantId || typeof r.reasonCode !== "string" || !REASON.test(r.reasonCode) || !isCanonicalDeferralTime(r.deferredAt)) {
    throw new ValidationError("AUDIT_JOURNAL_ENTRY_INVALID");
  }
  if (r.stream !== null && r.stream !== undefined) assertStreamName(r.stream);
  return { deferralId: r.deferralId, tenantId: input.tenantId, stream: r.stream ?? null, input, inputDigest: r.inputDigest, reasonCode: r.reasonCode, deferredAt: r.deferredAt };
}

// ---------------------------------------------------------------------------------------------
// Independent journal (DynamoDB)
// ---------------------------------------------------------------------------------------------

/** A journal outside the operational/audit database, used when PostgreSQL refuses the deferral. */
export interface IndependentRouteAuditJournal {
  readonly kind: "live" | "local_fixture";
  readonly journal: "dynamodb";
  put(entry: JournalEntry): Promise<void>;
  /**
   * PENDING items of one tenant in deferral order, at most `limit` in total: the entries that validate, and the
   * items that do not (tampered or corrupted) as rejected references. Throws only when the journal cannot be read.
   */
  read(tenantId: string, limit: number): Promise<JournalRead>;
  /**
   * Deferral time (ms) of the tenant's NEWEST pending item: the greatest PENDING sort key that starts with a canonical
   * deferral time (valid or rejected alike: only its time is used), or null when there is none. Every valid pending
   * entry is at or before it. An event journaled behind the independent journal is timed after it, so a newer entry
   * (possibly another replica's, with a clock ahead) is never overtaken. Throws only when the journal cannot be read.
   */
  newestPendingMs(tenantId: string): Promise<number | null>;
  /** Marks the entry as drained into the PostgreSQL journal (idempotent). */
  markDrained(entry: JournalEntry, at: string): Promise<void>;
  /**
   * Marks a rejected item QUARANTINED (only while PENDING; idempotent), recording the reason, the content-free
   * reference and the chain event that evidences the quarantine. The stored content is kept, never appended.
   */
  quarantine(item: RejectedJournalItem, at: string, recordEventId: string): Promise<void>;
}

export interface JournalDocumentSender {
  send(command: PutCommand | QueryCommand | UpdateCommand): Promise<unknown>;
}

/**
 * Parses one stored item read from `tenantId`'s partition. An item that fails is refused (ValidationError): bad
 * JSON, schema or digest (parseJournalEntry), an entry of another tenant moved into this partition, or one stored
 * under another sort key than its own `deferredAt#deferralId` (which would reorder it).
 */
function parseStoredItem(item: Record<string, unknown>, tenantId: string): JournalEntry {
  let input: unknown;
  try {
    input = JSON.parse(String(item.input));
  } catch {
    throw new ValidationError("AUDIT_JOURNAL_ENTRY_INVALID");
  }
  const entry = parseJournalEntry({ ...item, input, stream: item.stream ?? null });
  if (entry.tenantId !== tenantId || item.sk !== `${entry.deferredAt}#${entry.deferralId}`) throw new ValidationError("AUDIT_JOURNAL_ENTRY_INVALID");
  return entry;
}

const isConditionalFailure = (err: unknown): boolean =>
  err instanceof ConditionalCheckFailedException || (typeof err === "object" && err !== null && (err as { name?: unknown }).name === "ConditionalCheckFailedException");

/**
 * DynamoDB route-audit journal (kind "live").
 *
 * Table contract (provisioned with the session table, infra WP-39): partition key `pk` (S) =
 * `raj#<tenantId>`, sort key `sk` (S) = `<deferredAt ISO>#<deferralId>` (deferral order per tenant).
 * Attributes: `deferralId`, `tenantId`, `stream`, `input` (canonical JSON of the AuditEventInput),
 * `inputDigest`, `reasonCode`, `deferredAt`, `status` ("PENDING" | "DRAINED" | "QUARANTINED"), `drainedAt`,
 * and for a quarantined item `quarantinedAt`, `quarantineReason`, `quarantineRef`, `quarantineEventId`.
 *  - put:         PutCommand + `attribute_not_exists(pk)` (a deferral is written once).
 *  - read:        QueryCommand on the tenant partition, ConsistentRead, ascending sort key, status filter; each
 *                 item is re-validated (parseJournalEntry, the partition's tenant, sort key = deferredAt#deferralId)
 *                 and a failing item is returned as rejected instead of failing the whole read.
 *  - pending:     read, strict (throws when a pending item is rejected).
 *  - newestPendingMs: QueryCommand on the tenant partition, ConsistentRead, DESCENDING sort key, status filter,
 *                 projection of the sort key only; the first key that starts with a canonical deferral time.
 *  - markDrained: UpdateCommand `SET #s = :drained` conditioned on the item existing.
 *  - quarantine:  UpdateCommand `SET #s = :quarantined, ...` conditioned on `#s = :pending`.
 * Every SDK error except a conditional failure becomes a reason-coded DependencyError (SDK messages can
 * echo request content and are dropped). No TTL: entries are kept until drained (and the table's TTL,
 * if configured, must exceed the longest outage the policy tolerates).
 */
export class DynamoRouteAuditJournal implements IndependentRouteAuditJournal {
  readonly kind = "live" as const;
  readonly journal = "dynamodb" as const;

  constructor(
    private readonly client: JournalDocumentSender,
    private readonly tableName: string,
  ) {
    if (!/^[A-Za-z0-9_.-]{3,255}$/.test(tableName)) throw new ValidationError("AUDIT_JOURNAL_TABLE_INVALID");
  }

  static fromClient(client: DynamoDBClient, tableName: string): DynamoRouteAuditJournal {
    const doc = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: false, convertClassInstanceToMap: false, convertEmptyValues: false },
      unmarshallOptions: { wrapNumbers: false },
    });
    return new DynamoRouteAuditJournal(doc, tableName);
  }

  async put(entry: JournalEntry): Promise<void> {
    if (!TENANT_ID.test(entry.tenantId) || !DEFERRAL_ID.test(entry.deferralId)) throw new ValidationError("AUDIT_JOURNAL_ENTRY_INVALID");
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            pk: `raj#${entry.tenantId}`,
            sk: `${entry.deferredAt}#${entry.deferralId}`,
            deferralId: entry.deferralId,
            tenantId: entry.tenantId,
            stream: entry.stream,
            input: canonicalJson(entry.input),
            inputDigest: entry.inputDigest,
            reasonCode: entry.reasonCode,
            deferredAt: entry.deferredAt,
            status: "PENDING",
          },
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
    } catch (err) {
      if (isConditionalFailure(err)) return; // already journaled (a retried put of the same deferral)
      throw new DependencyError("AUDIT_JOURNAL_WRITE_FAILED", "UNKNOWN", false);
    }
  }

  async read(tenantId: string, limit: number): Promise<JournalRead> {
    if (!TENANT_ID.test(tenantId) || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new ValidationError("AUDIT_JOURNAL_QUERY_INVALID");
    const entries: JournalEntry[] = [];
    const rejected: RejectedJournalItem[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      let page: { Items?: Record<string, unknown>[]; LastEvaluatedKey?: Record<string, unknown> } | undefined;
      try {
        page = (await this.client.send(
          new QueryCommand({
            TableName: this.tableName,
            KeyConditionExpression: "pk = :pk",
            FilterExpression: "#s = :pending",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: { ":pk": `raj#${tenantId}`, ":pending": "PENDING" },
            ConsistentRead: true,
            ScanIndexForward: true,
            Limit: Math.min(1000, Math.max(limit * 2, 25)),
            ...(startKey ? { ExclusiveStartKey: startKey } : {}),
          }),
        )) as typeof page;
      } catch {
        throw new DependencyError("AUDIT_JOURNAL_READ_FAILED", "FAILED", true);
      }
      for (const item of page?.Items ?? []) {
        // The table's sort key is a string; an item without one cannot be addressed (nor written by put).
        if (typeof item.sk !== "string") throw new ValidationError("AUDIT_JOURNAL_ENTRY_INVALID");
        try {
          entries.push(parseStoredItem(item, tenantId));
        } catch (err) {
          if (!(err instanceof ValidationError)) throw err;
          rejected.push(rejectedJournalItem(tenantId, item.sk, err));
        }
        if (entries.length + rejected.length >= limit) return { entries, rejected };
      }
      startKey = page?.LastEvaluatedKey;
    } while (startKey);
    return { entries, rejected };
  }

  async newestPendingMs(tenantId: string): Promise<number | null> {
    if (!TENANT_ID.test(tenantId)) throw new ValidationError("AUDIT_JOURNAL_QUERY_INVALID");
    let startKey: Record<string, unknown> | undefined;
    do {
      let page: { Items?: Record<string, unknown>[]; LastEvaluatedKey?: Record<string, unknown> } | undefined;
      try {
        page = (await this.client.send(
          new QueryCommand({
            TableName: this.tableName,
            KeyConditionExpression: "pk = :pk",
            FilterExpression: "#s = :pending",
            ProjectionExpression: "#k",
            ExpressionAttributeNames: { "#s": "status", "#k": "sk" },
            ExpressionAttributeValues: { ":pk": `raj#${tenantId}`, ":pending": "PENDING" },
            ConsistentRead: true,
            ScanIndexForward: false,
            Limit: 25,
            ...(startKey ? { ExclusiveStartKey: startKey } : {}),
          }),
        )) as typeof page;
      } catch {
        throw new DependencyError("AUDIT_JOURNAL_READ_FAILED", "FAILED", true);
      }
      for (const item of page?.Items ?? []) {
        const ms = deferralTimeOfSortKey(item.sk);
        if (ms !== null) return ms;
      }
      startKey = page?.LastEvaluatedKey;
    } while (startKey);
    return null;
  }

  /** Valid pending entries in deferral order; strict: throws the rejection reason when a pending item is rejected. */
  async pending(tenantId: string, limit: number): Promise<JournalEntry[]> {
    const r = await this.read(tenantId, limit);
    const first = r.rejected[0];
    if (first) throw new ValidationError(first.reasonCode);
    return r.entries;
  }

  async quarantine(item: RejectedJournalItem, at: string, recordEventId: string): Promise<void> {
    if (!TENANT_ID.test(item.tenantId) || !/^[0-9a-f]{64}$/.test(item.ref) || !OPAQUE_ID.test(recordEventId) || !REASON.test(item.reasonCode) || Number.isNaN(Date.parse(at))) {
      throw new ValidationError("AUDIT_JOURNAL_QUARANTINE_INVALID");
    }
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: `raj#${item.tenantId}`, sk: item.key },
          UpdateExpression: "SET #s = :quarantined, quarantinedAt = :at, quarantineReason = :reason, quarantineRef = :ref, quarantineEventId = :ev",
          ConditionExpression: "#s = :pending",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: { ":quarantined": "QUARANTINED", ":pending": "PENDING", ":at": at, ":reason": item.reasonCode, ":ref": item.ref, ":ev": recordEventId },
        }),
      );
    } catch (err) {
      if (isConditionalFailure(err)) return; // no longer pending (quarantined by another replica, or gone)
      throw new DependencyError("AUDIT_JOURNAL_WRITE_FAILED", "UNKNOWN", false);
    }
  }

  async markDrained(entry: JournalEntry, at: string): Promise<void> {
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: `raj#${entry.tenantId}`, sk: `${entry.deferredAt}#${entry.deferralId}` },
          UpdateExpression: "SET #s = :drained, drainedAt = :at",
          ConditionExpression: "attribute_exists(pk)",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: { ":drained": "DRAINED", ":at": at },
        }),
      );
    } catch (err) {
      if (isConditionalFailure(err)) return;
      throw new DependencyError("AUDIT_JOURNAL_WRITE_FAILED", "UNKNOWN", false);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Durable deferred queue
// ---------------------------------------------------------------------------------------------

export interface DurableDeferredAuditQueueOptions {
  /** Operational database holding audit_deferred and route_audit_intents (and the audit outbox). */
  db: Db;
  writer: AuditWriter;
  clock: Clock;
  /** Tenants whose journal this process flushes (trusted configuration). */
  tenants: readonly string[] | (() => Promise<readonly string[]>);
  /** Independent journal used when PostgreSQL refuses the deferral (recommended in production). */
  independent?: IndependentRouteAuditJournal | null;
  /** Role of the journal and flush transactions (default app_runtime; the worker uses app_worker). */
  role?: Extract<DbRole, "app_runtime" | "app_worker" | "app_console">;
  logger?: Logger;
  metrics?: Metrics;
  /** Optional precheck for `flush`: nothing is attempted while the audit store reports itself unwritable. */
  health?: AuditHealth | null;
  /** Events appended per `flush` call per tenant (default 100, 1..1000). */
  maxPerFlush?: number;
  /** Pending deferrals drained inline by `appendOrDefer` before it decides (default 16, 0..1000). */
  maxInlineDrain?: number;
  /** Bounded last-resort memory list (default 1000, 1..10000). */
  maxMemoryEntries?: number;
  /** Source component of the chain records this queue writes itself (quarantined journal items; default "gateway"). */
  sourceComponent?: AuditSourceComponent;
}

interface PendingRow {
  deferral_id: string;
  source_stream: string | null;
  event_input: unknown;
  input_digest: string;
  reason_code: string;
  deferred_at: unknown;
  tenant_id: string;
}

/** Advisory-lock key space of the per-tenant flush lock (hashtext of the tenant id). */
const FLUSH_LOCK_NAMESPACE = 7300040;

export class DurableDeferredAuditQueue implements DeferredAuditSink {
  readonly badge = DURABLE_DEFERRED_AUDIT_BADGE;
  readonly durable = true as const;
  private readonly logger: Logger;
  private readonly metrics: Metrics;
  private readonly role: Extract<DbRole, "app_runtime" | "app_worker" | "app_console">;
  private readonly maxPerFlush: number;
  private readonly maxInlineDrain: number;
  private readonly maxMemory: number;
  private readonly memory: JournalEntry[] = [];
  /** Last known PENDING rows of audit_deferred per tenant (kept, not zeroed, while PostgreSQL cannot be counted). */
  private readonly pendingPostgres = new Map<string, number>();
  /** Last known PENDING items of the independent journal per tenant (kept while it cannot be read). */
  private readonly pendingIndependent = new Map<string, number>();
  /** Whether the last flush had no tenant to flush (then 0 is the known count of every store). */
  private flushesNoTenant = false;
  /** Last deferral time this queue issued (ms); deferral times are strictly increasing per queue instance. */
  private lastDeferredAtMs = Number.NEGATIVE_INFINITY;
  private sealed = false;
  private appending = 0;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: DurableDeferredAuditQueueOptions) {
    this.logger = (opts.logger ?? silentLogger).child({ component: "audit_journal" });
    this.metrics = opts.metrics ?? noopMetrics;
    this.role = opts.role ?? "app_runtime";
    this.maxPerFlush = opts.maxPerFlush ?? 100;
    this.maxInlineDrain = opts.maxInlineDrain ?? 16;
    this.maxMemory = opts.maxMemoryEntries ?? 1000;
    for (const [n, lo, hi] of [
      [this.maxPerFlush, 1, 1000],
      [this.maxInlineDrain, 0, 1000],
      [this.maxMemory, 1, 10_000],
    ] as const) {
      if (!Number.isSafeInteger(n) || n < lo || n > hi) throw new ValidationError("DEFERRED_AUDIT_POLICY_INVALID");
    }
  }

  /** Last known number of route events awaiting their append (both durable journals + memory). */
  get depth(): number {
    return total(this.pendingPostgres) + total(this.pendingIndependent) + this.memory.length;
  }

  /** Events held only in process memory (lost on a crash; both journals refused them). */
  get memoryDepth(): number {
    return this.memory.length;
  }

  get inProgress(): number {
    return this.appending;
  }

  get isSealed(): boolean {
    return this.sealed;
  }

  /**
   * Graceful shutdown: durable deferrals need no final flush (they survive the process). After `seal`, an
   * event that neither journal accepts is reported lost (`audit.journal.lost_at_shutdown`) instead of being
   * held in memory where nothing would flush it.
   */
  seal(): void {
    this.sealed = true;
  }

  async appendOrDefer(input: AuditEventInputT, stream?: string): Promise<DeferredAppendResult> {
    const valid = validateAuditInput(input);
    const s = stream === undefined ? null : assertStreamName(stream);
    this.appending += 1;
    try {
      return await this.exclusive(async () => {
        // Order first: route events of this tenant still waiting in ANY journal go before this event.
        let behind: string | null;
        let newestMs: number | null = null;
        try {
          const older = await this.olderPending(valid.tenantId);
          behind = older.waiting ? "AUDIT_DEFERRED_QUEUE_PENDING" : null;
          newestMs = older.newestMs;
        } catch (err) {
          // A journal cannot be read (or drained): what it holds is unknown, so this event must not overtake it.
          behind = reasonOf(err, "AUDIT_JOURNAL_READ_FAILED");
        }
        if (behind) return this.defer(valid, s, behind, newestMs);
        try {
          const eventId = await this.opts.db.tx(
            async (tx) => {
              const ev = await this.opts.writer.append(tx, valid, s ?? undefined);
              await resolveIntents(tx, valid, { eventId: ev.eventId }, this.opts.clock);
              return ev.eventId;
            },
            { role: this.role, rls: { tenantId: valid.tenantId } },
          );
          return { written: true, deferred: false, eventId, reasonCode: null, journal: null, deferralId: null };
        } catch (err) {
          if (isPermanent(err)) throw err;
          return this.defer(valid, s, reasonOf(err), null);
        }
      });
    } finally {
      this.appending -= 1;
    }
  }

  /**
   * Same as appendOrDefer but inside the caller's transaction (role and RLS context are the caller's): the
   * audit append runs under a savepoint and, when it fails, the deferral row is written in the same
   * transaction. Throws when even the deferral cannot be written (the caller's transaction then fails as a
   * whole, so a route record is never committed without its evidence or its deferral).
   */
  async appendOrDeferIn(tx: Queryable, input: AuditEventInputT, stream?: string): Promise<DeferredAppendResult> {
    const valid = validateAuditInput(input);
    const s = stream === undefined ? null : assertStreamName(stream);
    const pending = await tx.query<{ n: unknown; newest: unknown }>(
      "select count(*)::text as n, max(deferred_at) as newest from audit_deferred where tenant_id = $1 and status = 'PENDING'",
      [valid.tenantId],
    );
    let reasonCode = "AUDIT_DEFERRED_QUEUE_PENDING";
    // Route events waiting in the independent journal or in memory go before this one too (they are moved
    // into audit_deferred by the next flush, outside this transaction).
    const inMemory = this.memory.filter((m) => m.tenantId === valid.tenantId);
    let behind = toSafeInt(pending.rows[0]?.n ?? 0) > 0 || inMemory.length > 0;
    // The newest deferral time this event is journaled behind: its own deferral time is set after it.
    let newestMs = latestMs(msOf(pending.rows[0]?.newest), newestEntryMs(inMemory));
    if (this.opts.independent) {
      try {
        // A rejected (tampered) item still waits until the next flush has quarantined it.
        const read = await this.opts.independent.read(valid.tenantId, 1);
        if (itemCount(read) > 0) {
          behind = true;
          // Timed after the NEWEST item waiting there, not only the oldest one read (another replica, possibly with a
          // clock ahead of this one, may have written newer ones).
          newestMs = latestMs(newestMs, newestEntryMs(read.entries), await this.opts.independent.newestPendingMs(valid.tenantId));
        }
      } catch (err) {
        if (!behind) reasonCode = reasonOf(err, "AUDIT_JOURNAL_READ_FAILED");
        behind = true;
      }
    }
    if (!behind) {
      await tx.query("savepoint vsp_route_audit_append");
      try {
        const ev = await this.opts.writer.append(tx, valid, s ?? undefined);
        await tx.query("release savepoint vsp_route_audit_append");
        await resolveIntents(tx, valid, { eventId: ev.eventId }, this.opts.clock);
        return { written: true, deferred: false, eventId: ev.eventId, reasonCode: null, journal: null, deferralId: null };
      } catch (err) {
        await tx.query("rollback to savepoint vsp_route_audit_append");
        if (isPermanent(err)) throw err;
        reasonCode = reasonOf(err);
      }
    }
    const entry = journalEntryFor(valid, s, reasonCode, this.deferralTime(behind ? newestMs : null));
    await insertDeferral(tx, entry, "postgres");
    await resolveIntents(tx, valid, { deferralId: entry.deferralId }, this.opts.clock);
    this.journaled("postgres", entry);
    return { written: false, deferred: true, eventId: null, reasonCode: entry.reasonCode, journal: "postgres", deferralId: entry.deferralId };
  }

  /** Appends journaled events in order for every configured tenant (bounded per tenant). */
  async flush(limit = this.maxPerFlush): Promise<DeferredFlushResult> {
    return this.exclusive(async () => {
      const total: DeferredFlushResult = { written: 0, dropped: 0, remaining: 0, reasonCode: null };
      if (this.opts.health) {
        const status = await this.opts.health.status().catch(() => null);
        if (!status || status.reasonCode === AUDIT_HEALTH_REASONS.storeUnwritable) {
          // Nothing is appended while the audit store is unwritable, but what waits is still counted: audit_deferred and
          // the independent journal do not depend on the audit store, and a restarted process (or a worker that did not
          // defer the events itself) knows nothing of them otherwise.
          const tenants = await this.tenants();
          for (const tenantId of tenants) await this.recount(tenantId, null);
          this.forgetOtherTenants(tenants);
          total.reasonCode = status?.reasonCode ?? AUDIT_HEALTH_REASONS.storeUnwritable;
          total.remaining = this.depth;
          this.gauge();
          return total;
        }
      }
      const tenants = await this.tenants();
      for (const tenantId of tenants) {
        let r: TenantFlush;
        try {
          r = await this.flushTenant(tenantId, Math.max(1, Math.min(limit, this.maxPerFlush)));
        } catch (err) {
          // Nothing more of the tenant was appended (a journal could not be read or drained).
          r = { written: 0, dropped: 0, reasonCode: reasonOf(err), independentRemaining: null };
        }
        // Recount what still waits. A store that cannot be counted (PostgreSQL down, DynamoDB unreadable) keeps
        // its last known count instead of reading 0, so evidence held there stays visible in remaining, depth and
        // vsp_audit_journal_pending{journal} - in particular during the PostgreSQL outage the independent journal
        // exists for.
        const countReason = await this.recount(tenantId, r.independentRemaining);
        total.written += r.written;
        total.dropped += r.dropped;
        total.reasonCode ??= r.reasonCode ?? countReason;
      }
      this.forgetOtherTenants(tenants);
      total.remaining = this.depth;
      this.gauge();
      return total;
    });
  }

  /** Content-free view of what is held in process memory (operations). */
  pendingInMemory(): { deferralId: string; action: string; reasonCode: string }[] {
    return this.memory.map((e) => ({ deferralId: e.deferralId, action: e.input.action, reasonCode: e.reasonCode }));
  }

  // -------------------------------------------------------------------------------------------

  private async tenants(): Promise<string[]> {
    const list = typeof this.opts.tenants === "function" ? await this.opts.tenants() : this.opts.tenants;
    for (const t of list) if (!TENANT_ID.test(t)) throw new ValidationError("AUDIT_JOURNAL_TENANT_INVALID");
    const fromMemory = this.memory.map((m) => m.tenantId);
    return [...new Set([...list, ...fromMemory])];
  }

  /** Drops the counts of tenants this process no longer flushes, and records that the configured set is known. */
  private forgetOtherTenants(tenants: readonly string[]): void {
    for (const known of [this.pendingPostgres, this.pendingIndependent]) for (const t of [...known.keys()]) if (!tenants.includes(t)) known.delete(t);
    this.flushesNoTenant = tenants.length === 0;
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.catch(() => undefined);
    return run;
  }

  /**
   * Whether route events of this tenant still wait in a journal, so that a new event must be journaled behind
   * them: PENDING rows of audit_deferred, entries of the independent journal not yet drained (written while
   * PostgreSQL refused, possibly by ANOTHER replica) and this process's memory list. When something waits, it
   * first moves the independent and memory entries into audit_deferred (and, with maxInlineDrain > 0, appends
   * up to that many in order), then counts again. Throws when a journal cannot be read or drained.
   */
  private async olderPending(tenantId: string): Promise<{ waiting: boolean; newestMs: number | null }> {
    const first = await this.pendingAnywhere(tenantId);
    if (first.count === 0) return { waiting: false, newestMs: null };
    if (this.maxInlineDrain > 0) await this.flushTenant(tenantId, this.maxInlineDrain);
    else await this.drainIntoPostgres(tenantId, this.maxPerFlush);
    const again = await this.pendingAnywhere(tenantId);
    return { waiting: again.count > 0, newestMs: latestMs(first.newestMs, again.newestMs) };
  }

  /** What waits for the tenant in the three stores, and the newest deferral time seen among it (null: none seen). */
  private async pendingAnywhere(tenantId: string): Promise<{ count: number; newestMs: number | null }> {
    const inMemory = this.memory.filter((m) => m.tenantId === tenantId);
    const inPostgres = await this.pendingSummary(tenantId);
    const read: JournalRead = this.opts.independent ? await this.opts.independent.read(tenantId, 1) : { entries: [], rejected: [] };
    // When anything waits in the independent journal, the newest of it (not only the oldest item read) bounds the new
    // event's deferral time.
    const newestIndependent = this.opts.independent && itemCount(read) > 0 ? await this.opts.independent.newestPendingMs(tenantId) : null;
    return {
      count: inMemory.length + inPostgres.count + itemCount(read),
      newestMs: latestMs(newestEntryMs(inMemory), inPostgres.newestMs, newestEntryMs(read.entries), newestIndependent),
    };
  }

  private async pendingSummary(tenantId: string): Promise<{ count: number; newestMs: number | null }> {
    const r = await this.opts.db.tx(
      (tx) => tx.query<{ n: unknown; newest: unknown }>("select count(*)::text as n, max(deferred_at) as newest from audit_deferred where status = 'PENDING'"),
      { role: this.role, rls: { tenantId } },
    );
    return { count: toSafeInt(r.rows[0]?.n ?? 0), newestMs: msOf(r.rows[0]?.newest) };
  }

  /**
   * Recounts the tenant's pending deferrals: audit_deferred, and the independent journal unless the drain just
   * established how many remain there (`independentRemaining`). A count that fails leaves the last known value
   * (never 0) and returns its reason code.
   */
  private async recount(tenantId: string, independentRemaining: number | null): Promise<string | null> {
    let reason: string | null = null;
    try {
      this.pendingPostgres.set(tenantId, (await this.pendingSummary(tenantId)).count);
    } catch (err) {
      reason = reasonOf(err, "AUDIT_JOURNAL_READ_FAILED");
    }
    if (this.opts.independent) {
      try {
        this.pendingIndependent.set(tenantId, independentRemaining ?? itemCount(await this.opts.independent.read(tenantId, PENDING_COUNT_READ_LIMIT)));
      } catch (err) {
        reason ??= reasonOf(err, "AUDIT_JOURNAL_READ_FAILED");
      }
    }
    return reason;
  }

  /**
   * Deferral time of a new journal entry: the clock's time, but always after every deferral this queue issued before
   * (strictly increasing, so two deferrals of one process never tie) and, for an event journaled BEHIND older
   * entries, after the newest of those (`floorMs`) - so the flush, which orders by deferral time, cannot put it ahead
   * of them even when they were deferred at the same instant (possibly by another replica). A floor more than
   * MAX_DEFERRAL_AHEAD_MS ahead of this clock (another replica's skew, or a forged entry) is clamped to that bound.
   */
  private deferralTime(floorMs: number | null): string {
    const now = this.opts.clock.now().getTime();
    const floor = floorMs === null ? Number.NEGATIVE_INFINITY : Math.min(floorMs, now + MAX_DEFERRAL_AHEAD_MS);
    this.lastDeferredAtMs = Math.max(now, this.lastDeferredAtMs + 1, floor + 1);
    return iso(new Date(this.lastDeferredAtMs));
  }

  private async defer(input: AuditEventInputT, stream: string | null, reasonCode: string, floorMs: number | null): Promise<DeferredAppendResult> {
    const entry = journalEntryFor(input, stream, reasonCode, this.deferralTime(floorMs));
    try {
      await this.opts.db.tx(
        async (tx) => {
          await insertDeferral(tx, entry, "postgres");
          await resolveIntents(tx, input, { deferralId: entry.deferralId }, this.opts.clock);
        },
        { role: this.role, rls: { tenantId: input.tenantId } },
      );
      shift(this.pendingPostgres, input.tenantId, 1);
      this.journaled("postgres", entry);
      return { written: false, deferred: true, eventId: null, reasonCode: entry.reasonCode, journal: "postgres", deferralId: entry.deferralId };
    } catch (err) {
      this.count("journal_failed", "postgres");
      this.logger.error("audit.journal.postgres_refused", { deferralId: entry.deferralId, action: input.action, reasonCode: reasonOf(err, "AUDIT_JOURNAL_WRITE_FAILED") });
    }
    if (this.opts.independent) {
      try {
        await this.opts.independent.put(entry);
        shift(this.pendingIndependent, input.tenantId, 1);
        this.journaled("dynamodb", entry);
        return { written: false, deferred: true, eventId: null, reasonCode: entry.reasonCode, journal: "dynamodb", deferralId: entry.deferralId };
      } catch (err) {
        this.count("journal_failed", "dynamodb");
        this.logger.error("audit.journal.independent_refused", { deferralId: entry.deferralId, action: input.action, reasonCode: reasonOf(err, "AUDIT_JOURNAL_WRITE_FAILED") });
      }
    }
    return this.holdInMemory(entry);
  }

  private holdInMemory(entry: JournalEntry): DeferredAppendResult {
    if (this.sealed) {
      this.count("dropped", "memory");
      this.legacyCount("dropped", "store_unavailable");
      this.logger.error("audit.journal.lost_at_shutdown", { deferralId: entry.deferralId, action: entry.input.action, correlationId: entry.input.correlationId, reasonCode: "AUDIT_DEFERRED_AFTER_SHUTDOWN" });
      return { written: false, deferred: false, eventId: null, reasonCode: "AUDIT_DEFERRED_AFTER_SHUTDOWN", journal: null, deferralId: entry.deferralId };
    }
    if (this.memory.length >= this.maxMemory) {
      this.count("dropped", "memory");
      this.legacyCount("dropped", "queue_full");
      this.logger.error("audit.journal.dropped", { deferralId: entry.deferralId, action: entry.input.action, correlationId: entry.input.correlationId, reasonCode: "AUDIT_DEFERRED_QUEUE_FULL" });
      return { written: false, deferred: false, eventId: null, reasonCode: "AUDIT_DEFERRED_QUEUE_FULL", journal: null, deferralId: entry.deferralId };
    }
    this.memory.push(entry);
    this.journaled("memory", entry);
    // Loud: both durable journals refused; this event is lost if the process crashes before a flush.
    this.logger.error("audit.journal.memory_fallback", { deferralId: entry.deferralId, action: entry.input.action, correlationId: entry.input.correlationId, reasonCode: entry.reasonCode, memoryDepth: this.memory.length });
    return { written: false, deferred: true, eventId: null, reasonCode: entry.reasonCode, journal: "memory", deferralId: entry.deferralId };
  }

  /**
   * Drains the independent journal and the memory list of a tenant into audit_deferred, then appends up to `limit`
   * PENDING deferrals in order. When the independent read was cut at its limit, older entries may still wait there,
   * so only deferrals that cannot be newer than any of them are appended (Drain.boundary); the rest wait for the next
   * pass, never overtaking them.
   */
  private async flushTenant(tenantId: string, limit: number): Promise<TenantFlush> {
    const drained = await this.drainIntoPostgres(tenantId, limit);
    let written = 0;
    let dropped = 0;
    let reasonCode: string | null = null;
    while (written + dropped < limit) {
      const step = await this.flushOne(tenantId, drained);
      if (step.kind === "empty" || step.kind === "locked" || step.kind === "held") break;
      if (step.kind === "written") written += 1;
      else if (step.kind === "dropped") dropped += 1;
      else if (step.kind === "stopped") {
        reasonCode = step.reasonCode;
        break;
      }
    }
    return { written, dropped: dropped + drained.quarantined, reasonCode, independentRemaining: drained.boundary === null ? 0 : null };
  }

  /**
   * Moves the tenant's independent-journal entries (at most `limit` items read, valid and rejected) and memory entries
   * into audit_deferred, then quarantines the independent items that failed validation. Throws when the independent
   * journal cannot be read or written, or a quarantine cannot be evidenced in the chain yet.
   */
  private async drainIntoPostgres(tenantId: string, limit: number): Promise<Drain> {
    const sources: { entry: JournalEntry; from: "dynamodb" | "memory" }[] = [];
    const read: JournalRead = this.opts.independent ? await this.opts.independent.read(tenantId, limit) : { entries: [], rejected: [] };
    for (const entry of read.entries) sources.push({ entry, from: "dynamodb" });
    for (const entry of this.memory.filter((m) => m.tenantId === tenantId)) sources.push({ entry, from: "memory" });
    let refused = 0;
    for (const { entry, from } of sources) {
      try {
        await this.opts.db.tx((tx) => insertDeferral(tx, entry, from === "dynamodb" ? "dynamodb" : "postgres"), { role: this.role, rls: { tenantId } });
      } catch (err) {
        // PostgreSQL refuses this item's content: it can never be drained. Retrying it in every pass would hold every newer
        // route event of the tenant behind it, so it is rejected like an item that fails validation (quarantined, with
        // its chain record first; until that record can be written the drain still stops here).
        if (from !== "dynamodb" || !isContentRefusal(err)) throw err;
        await this.quarantine(rejectedJournalItem(tenantId, `${entry.deferredAt}#${entry.deferralId}`, new ValidationError("AUDIT_JOURNAL_ENTRY_INVALID")));
        shift(this.pendingIndependent, tenantId, -1);
        refused += 1;
        continue;
      }
      if (from === "dynamodb") {
        await this.opts.independent?.markDrained(entry, iso(this.opts.clock.now()));
        shift(this.pendingIndependent, tenantId, -1);
      } else this.memory.splice(this.memory.indexOf(entry), 1);
      shift(this.pendingPostgres, tenantId, 1);
    }
    for (const item of read.rejected) {
      await this.quarantine(item);
      shift(this.pendingIndependent, tenantId, -1);
    }
    return { quarantined: read.rejected.length + refused, readIds: new Set(read.entries.map((e) => e.deferralId)), boundary: itemCount(read) >= limit ? readBoundary(read) : null };
  }

  /**
   * Quarantines an independent-journal item that failed validation: the chain record first (so the quarantine is
   * never silent), then the item's QUARANTINED mark. Its content is never appended or copied; the record carries
   * the rejection reason and a content-free reference only.
   */
  private async quarantine(item: RejectedJournalItem): Promise<void> {
    const independent = this.opts.independent;
    if (!independent || !TENANT_ID.test(item.tenantId)) throw new ValidationError("AUDIT_JOURNAL_QUARANTINE_INVALID");
    const record = buildAuditInput(
      {
        tenantId: item.tenantId,
        correlationId: quarantineCorrelationId(item),
        sourceComponent: this.opts.sourceComponent ?? "gateway",
        action: JOURNAL_ENTRY_QUARANTINED_ACTION,
        outcome: "FAILED",
        reasonCode: item.reasonCode,
        evidencePointers: [`kv://route-audit-journal/${item.ref}`],
        dataClass: "SECURITY_AUDIT",
      },
      this.opts.clock,
    );
    const ev = await this.opts.db.tx((tx) => this.opts.writer.append(tx, record), { role: this.role, rls: { tenantId: item.tenantId } });
    await independent.quarantine(item, iso(this.opts.clock.now()), ev.eventId);
    this.count("dropped", "dynamodb");
    this.legacyCount("dropped", "invalid");
    this.logger.error("audit.journal.quarantined", { ref: item.ref, eventId: ev.eventId, reasonCode: item.reasonCode });
  }

  private async flushOne(tenantId: string, drained: Drain): Promise<{ kind: "empty" | "locked" | "held" | "written" | "dropped" } | { kind: "stopped"; reasonCode: string }> {
    let candidate: PendingRow | undefined;
    try {
      const out = await this.opts.db.tx(
        async (tx) => {
          const locked = await tx.query<{ ok: boolean }>("select pg_try_advisory_xact_lock($1, hashtext($2)) as ok", [FLUSH_LOCK_NAMESPACE, tenantId]);
          if (!locked.rows[0]?.ok) return { kind: "locked" as const };
          // Deferral order: deferral time; at the same instant (only across processes: one queue never issues a time
          // twice) an entry first journaled in the independent journal goes first, because an event journaled behind it
          // in PostgreSQL may share its instant; then journal order.
          const r = await tx.query<PendingRow>(
            `select deferral_id, source_stream, event_input, input_digest, reason_code, deferred_at, tenant_id from audit_deferred
              where status = 'PENDING' order by deferred_at, (journal = 'dynamodb') desc, journal_seq limit 1 for update`,
          );
          candidate = r.rows[0];
          if (!candidate) return { kind: "empty" as const };
          // Older entries may still wait in the independent journal (its read was cut at the limit): append only
          // what cannot be newer than any of them, and keep the rest PENDING for the next pass.
          if (!appendableNow(candidate, drained)) return { kind: "held" as const };
          const entry = parseJournalEntry({
            deferralId: candidate.deferral_id,
            tenantId: candidate.tenant_id,
            stream: candidate.source_stream,
            input: candidate.event_input,
            inputDigest: candidate.input_digest,
            reasonCode: candidate.reason_code,
            deferredAt: toIsoString(candidate.deferred_at),
          });
          const ev = await this.opts.writer.append(tx, entry.input, entry.stream ?? undefined);
          const marker = await this.opts.writer.append(
            tx,
            buildAuditInput(
              {
                tenantId: entry.tenantId,
                correlationId: entry.input.correlationId,
                parentId: ev.eventId,
                sourceComponent: entry.input.sourceComponent,
                action: DEFERRED_AUDIT_MARKER_ACTION,
                outcome: "SUCCEEDED",
                callId: entry.input.callId,
                versions: entry.input.versions,
                reasonCode: entry.reasonCode,
                evidencePointers: [`deferral:${entry.deferralId}`],
                dataClass: "SECURITY_AUDIT",
              },
              this.opts.clock,
            ),
            entry.stream ?? undefined,
          );
          const now = iso(this.opts.clock.now());
          await tx.query(
            `update audit_deferred set status = 'RECORDED', recorded_event_id = $2, marker_event_id = $3, recorded_at = $4::timestamptz,
                    attempts = attempts + 1, last_error_code = null
              where deferral_id = $1 and status = 'PENDING'`,
            [entry.deferralId, ev.eventId, marker.eventId, now],
          );
          await resolveIntents(tx, entry.input, { eventId: ev.eventId }, this.opts.clock);
          shift(this.pendingPostgres, tenantId, -1);
          this.count("flushed", "postgres");
          this.legacyCount("flushed", "none");
          this.observeAge(entry);
          this.logger.warn("audit.journal.flushed", { deferralId: entry.deferralId, eventId: ev.eventId, action: entry.input.action, reasonCode: entry.reasonCode });
          return { kind: "written" as const };
        },
        { role: this.role, rls: { tenantId } },
      );
      return out;
    } catch (err) {
      const row = candidate as PendingRow | undefined;
      if (row && isPermanent(err)) {
        await this.markDropped(tenantId, row.deferral_id, reasonOf(err, "AUDIT_EVENT_INVALID"));
        return { kind: "dropped" };
      }
      const code = reasonOf(err);
      if (row) await this.recordAttempt(tenantId, row.deferral_id, code).catch(() => undefined);
      return { kind: "stopped", reasonCode: code };
    }
  }

  private async markDropped(tenantId: string, deferralId: string, reasonCode: string): Promise<void> {
    await this.opts.db.tx(
      (tx) => tx.query("update audit_deferred set status = 'DROPPED', drop_reason = $2, attempts = attempts + 1 where deferral_id = $1 and status = 'PENDING'", [deferralId, reasonCode]),
      { role: this.role, rls: { tenantId } },
    );
    shift(this.pendingPostgres, tenantId, -1);
    this.count("dropped", "postgres");
    this.legacyCount("dropped", "invalid");
    this.logger.error("audit.journal.dropped", { deferralId, reasonCode });
  }

  private async recordAttempt(tenantId: string, deferralId: string, reasonCode: string): Promise<void> {
    await this.opts.db.tx(
      (tx) => tx.query("update audit_deferred set attempts = attempts + 1, last_error_code = $2 where deferral_id = $1 and status = 'PENDING'", [deferralId, reasonCode]),
      { role: this.role, rls: { tenantId } },
    );
  }

  private journaled(journal: "postgres" | "dynamodb" | "memory", entry: JournalEntry): void {
    this.count("journaled", journal);
    this.legacyCount("queued", "store_unavailable");
    this.gauge();
    if (journal !== "memory") {
      this.logger.warn("audit.journal.deferred", { deferralId: entry.deferralId, kind: journal, action: entry.input.action, correlationId: entry.input.correlationId, reasonCode: entry.reasonCode });
    }
  }

  private count(result: "journaled" | "flushed" | "journal_failed" | "dropped", journal: "postgres" | "dynamodb" | "memory"): void {
    try {
      this.metrics.increment("vsp_audit_journal_entries_total", { journal, result });
    } catch {
      // metrics never change what is written or journaled
    }
  }

  private legacyCount(result: "queued" | "flushed" | "dropped", reason: "store_unavailable" | "queue_full" | "invalid" | "none"): void {
    try {
      this.metrics.increment("vsp_audit_deferred_total", { result, reason });
    } catch {
      // metrics never change what is written or journaled
    }
  }

  private gauge(): void {
    try {
      this.metrics.gauge("vsp_audit_deferred_depth", this.depth);
      this.metrics.gauge("vsp_audit_journal_pending", this.memory.length, { journal: "memory" });
      // A store with no known count (this process has not counted it yet: it started during that store's outage) reports
      // no value, never a made-up 0; with no tenant to flush, 0 is the count.
      if (this.pendingPostgres.size > 0 || this.flushesNoTenant) this.metrics.gauge("vsp_audit_journal_pending", total(this.pendingPostgres), { journal: "postgres" });
      if (this.opts.independent && (this.pendingIndependent.size > 0 || this.flushesNoTenant)) {
        this.metrics.gauge("vsp_audit_journal_pending", total(this.pendingIndependent), { journal: "dynamodb" });
      }
    } catch {
      // metrics never change what is written or journaled
    }
  }

  private observeAge(entry: JournalEntry): void {
    try {
      this.metrics.observe("vsp_audit_deferred_age_ms", Math.max(0, this.opts.clock.now().getTime() - Date.parse(entry.deferredAt)));
    } catch {
      // metrics never change what is written or journaled
    }
  }
}

/** Items (valid and rejected) of one independent-journal read: each still waits before newer route events. */
const itemCount = (r: JournalRead): number => r.entries.length + r.rejected.length;

/** Bound of a deferral time carried by a floor: at most this far ahead of the deferring process's clock. */
const MAX_DEFERRAL_AHEAD_MS = 60_000;
/** Items read to count the independent journal's pending items (operations gauge; at most this many are counted). */
const PENDING_COUNT_READ_LIMIT = 1000;

/** One tenant's flush pass: counts, the first stop reason, and the independent items known to remain (null: unknown). */
interface TenantFlush {
  written: number;
  dropped: number;
  reasonCode: string | null;
  independentRemaining: number | null;
}

/**
 * What a drain moved: the number quarantined, the deferral ids read from the independent journal, and - when that
 * read was cut at its limit - the boundary below which a PENDING deferral is older than every entry still waiting
 * there (null: nothing remains there).
 */
interface Drain {
  quarantined: number;
  readIds: ReadonlySet<string>;
  boundary: string | null;
}

/**
 * Boundary of a read cut at its limit: the first 24 characters of the greatest sort key read (valid or rejected). Every
 * item still waiting has a greater sort key, hence a deferral time whose ISO form is not below this prefix; a deferral
 * whose ISO deferral time is below it is strictly older than all of them (a string comparison, valid for any stored
 * key, including a forged one).
 */
function readBoundary(read: JournalRead): string {
  let last = "";
  for (const e of read.entries) if (`${e.deferredAt}#${e.deferralId}` > last) last = `${e.deferredAt}#${e.deferralId}`;
  for (const r of read.rejected) if (r.key > last) last = r.key;
  return last.slice(0, 24);
}

/** Whether a PENDING deferral may be appended in this pass: read in this pass, or older than everything still waiting. */
function appendableNow(row: PendingRow, drained: Drain): boolean {
  return drained.boundary === null || drained.readIds.has(row.deferral_id) || toIsoString(row.deferred_at) < drained.boundary;
}

const total = (m: ReadonlyMap<string, number>): number => [...m.values()].reduce((a, b) => a + b, 0);
const shift = (m: Map<string, number>, tenantId: string, by: number): void => {
  m.set(tenantId, Math.max(0, (m.get(tenantId) ?? 0) + by));
};
/** Milliseconds of a timestamp read from PostgreSQL (Date or ISO string), or null. */
function msOf(v: unknown): number | null {
  const ms = v instanceof Date ? v.getTime() : typeof v === "string" ? Date.parse(v) : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
}
const newestEntryMs = (entries: readonly JournalEntry[]): number | null => latestMs(...entries.map((e) => Date.parse(e.deferredAt)));
function latestMs(...values: (number | null)[]): number | null {
  let out: number | null = null;
  for (const v of values) if (v !== null && Number.isFinite(v) && (out === null || v > out)) out = v;
  return out;
}

/** Correlation id of a quarantine record, derived from the item's reference (a repeated record shares it). */
const quarantineCorrelationId = (item: RejectedJournalItem): string => `raj_${item.ref.slice(0, 40)}`;

function toIsoString(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string") return new Date(v).toISOString();
  throw new ValidationError("AUDIT_JOURNAL_ENTRY_INVALID");
}

/** Inserts a PENDING deferral (idempotent on the deferral id). The caller's transaction carries the tenant's RLS context. */
export async function insertDeferral(tx: Queryable, entry: JournalEntry, journal: "postgres" | "dynamodb"): Promise<void> {
  await tx.query(
    `insert into audit_deferred (deferral_id, tenant_id, source_stream, action, correlation_id, call_id, event_input, input_digest,
                                 reason_code, journal, deferred_at, status)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11::timestamptz, 'PENDING')
     on conflict (deferral_id) do nothing`,
    [
      entry.deferralId,
      entry.tenantId,
      entry.stream,
      entry.input.action,
      entry.input.correlationId,
      entry.input.callId,
      JSON.stringify(entry.input),
      entry.inputDigest,
      entry.reasonCode,
      journal,
      entry.deferredAt,
    ],
  );
}

/**
 * Resolves the open route intent(s) of this route event's correlation: route actions only, and a SAFETY_ROUTE
 * intent only with safety route evidence (routeKindOfAction). Any other event of the correlation leaves the
 * intent OPEN, so the reconciler still reports it (audit.route.not_recorded) when no route evidence arrives.
 */
export async function resolveIntents(tx: Queryable, input: AuditEventInputT, by: { eventId?: string; deferralId?: string }, clock: Clock): Promise<number> {
  const kind = routeKindOfAction(input.action);
  if (!kind) return 0;
  const r = await tx.query(
    `update route_audit_intents set status = 'RECORDED', resolved_event_id = $3, resolved_deferral_id = $4, resolved_at = $5::timestamptz
      where tenant_id = $1 and correlation_id = $2 and status = 'OPEN' and (route_kind = 'HUMAN_TRANSFER' or $6::text = 'SAFETY_ROUTE')`,
    [input.tenantId, input.correlationId, by.eventId ?? null, by.deferralId ?? null, iso(clock.now()), kind],
  );
  return r.rowCount;
}
