/**
 * Source-version ordering for projections (follow-on FO-07-20; ACT-02, SAFE-04).
 *
 * Events are applied by the SOURCE's ordering, never by arrival: the projected state of an entity is the
 * event with the greatest key (source_version, occurred_at, event_id), compared numerically / as instants
 * / lexicographically. A duplicate, a reordered delivery, a delayed clock, a replay or a backfill of an
 * older version therefore leaves the newest state in place (SUPERSEDED), and the state after any
 * permutation of the same events is the same. The table trigger (migration 2041) refuses a version
 * regression even from a caller that bypasses this function.
 */
import type { Queryable } from "../db/types.js";
import type { Clock } from "../shared/clock.js";
import { iso } from "../shared/clock.js";
import { ValidationError } from "../shared/errors.js";

export interface VersionedFact {
  tenantId: string;
  sourceId: string;
  entityKey: string;
  /** Decimal string, up to 39 digits (Kinesis sequence numbers fit). */
  sourceVersion: string;
  occurredAt: string | null;
  eventId: string;
  inboxId: string;
  stateDigest: string;
}

export interface OrderKey {
  sourceVersion: string;
  occurredAt: string | null;
  eventId: string;
}

const VERSION = /^[0-9]{1,39}$/;

/** Total order of facts: source version, then occurrence time (absent first), then event id. */
export function compareOrderKeys(a: OrderKey, b: OrderKey): number {
  const va = BigInt(a.sourceVersion);
  const vb = BigInt(b.sourceVersion);
  if (va !== vb) return va < vb ? -1 : 1;
  const ta = a.occurredAt === null ? -Infinity : Date.parse(a.occurredAt);
  const tb = b.occurredAt === null ? -Infinity : Date.parse(b.occurredAt);
  if (ta !== tb) return ta < tb ? -1 : 1;
  return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
}

/**
 * Whether an event is already superseded by the projected state of its entity (its key orders at or before the
 * stored one). Serializes concurrent processing of one entity (transaction-scoped advisory lock plus the row
 * lock), so the answer holds until the caller's transaction ends. The processor asks BEFORE running a
 * handler: a stale, reordered or replayed event never reaches the handler's domain effects.
 */
export async function isSupersededBySource(tx: Queryable, key: { tenantId: string; sourceId: string; entityKey: string } & OrderKey): Promise<boolean> {
  if (!VERSION.test(key.sourceVersion)) throw new ValidationError("INBOX_PROJECTION_FACT_INVALID");
  await tx.query("select pg_advisory_xact_lock($1, hashtext($2))", [PROJECTION_LOCK_NAMESPACE, `${key.tenantId}|${key.sourceId}|${key.entityKey}`]);
  const cur = await tx.query<{ source_version: string; occurred_at: Date | string | null; event_id: string }>(
    `select source_version::text as source_version, occurred_at, event_id from inbox_projection_versions
      where tenant_id = $1 and source_id = $2 and entity_key = $3 for update`,
    [key.tenantId, key.sourceId, key.entityKey],
  );
  const row = cur.rows[0];
  if (!row) return false;
  return compareOrderKeys(key, { sourceVersion: row.source_version, occurredAt: row.occurred_at === null ? null : new Date(row.occurred_at).toISOString(), eventId: row.event_id }) <= 0;
}

/** Advisory-lock key space of the per-entity projection lock. */
const PROJECTION_LOCK_NAMESPACE = 7300043;

/** Applies a fact if it orders after the stored state; returns APPLIED or SUPERSEDED. Runs in the caller's transaction. */
export async function applySourceVersioned(tx: Queryable, fact: VersionedFact, clock: Clock): Promise<"APPLIED" | "SUPERSEDED"> {
  if (!VERSION.test(fact.sourceVersion) || !/^[a-f0-9]{64}$/.test(fact.stateDigest)) throw new ValidationError("INBOX_PROJECTION_FACT_INVALID");
  const cur = await tx.query<{ source_version: string; occurred_at: Date | string | null; event_id: string }>(
    `select source_version::text as source_version, occurred_at, event_id from inbox_projection_versions
      where tenant_id = $1 and source_id = $2 and entity_key = $3 for update`,
    [fact.tenantId, fact.sourceId, fact.entityKey],
  );
  const row = cur.rows[0];
  const now = iso(clock.now());
  if (!row) {
    await tx.query(
      `insert into inbox_projection_versions (tenant_id, source_id, entity_key, source_version, occurred_at, event_id, inbox_id, state_digest, applied_at)
       values ($1, $2, $3, $4::numeric, $5::timestamptz, $6, $7, $8, $9::timestamptz)`,
      [fact.tenantId, fact.sourceId, fact.entityKey, fact.sourceVersion, fact.occurredAt, fact.eventId, fact.inboxId, fact.stateDigest, now],
    );
    return "APPLIED";
  }
  const stored: OrderKey = { sourceVersion: row.source_version, occurredAt: row.occurred_at === null ? null : new Date(row.occurred_at).toISOString(), eventId: row.event_id };
  if (compareOrderKeys(fact, stored) <= 0) return "SUPERSEDED";
  await tx.query(
    `update inbox_projection_versions set source_version = $4::numeric, occurred_at = $5::timestamptz, event_id = $6, inbox_id = $7, state_digest = $8,
            applied_at = $9::timestamptz, superseded_count = superseded_count + 1
      where tenant_id = $1 and source_id = $2 and entity_key = $3`,
    [fact.tenantId, fact.sourceId, fact.entityKey, fact.sourceVersion, fact.occurredAt, fact.eventId, fact.inboxId, fact.stateDigest, now],
  );
  return "APPLIED";
}
