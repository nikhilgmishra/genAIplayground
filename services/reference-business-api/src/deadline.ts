/**
 * Dispatch deadlines of writes (WP-23; FO-06-74, FO-06-75; ACT-03).
 *
 * A client may send `notAfter` (an instant) with a write. The API then applies the write only if its transaction
 * passes the final deadline check, measured with the database clock:
 *   - every lock wait and statement of the write's transaction is bounded by the time left (lock_timeout and
 *     statement_timeout, transaction-local), so a request held behind another writer's row lock gives up in time;
 *   - the LAST statement before COMMIT checks `clock_timestamp() <= notAfter`; when it fails the change is rolled
 *     back and the request is recorded REJECTED with DEADLINE_EXCEEDED (a replay and the lookup by key say so).
 * The deadline bounds how long a delivery keeps trying (liveness). It does NOT make an absence definitive: the
 * COMMIT that follows the final check can land after `notAfter` (a stalled process, a slow fsync, a synchronous-
 * replication wait, a network delay before the COMMIT reaches the database), and no clock-skew allowance bounds
 * that latency. A lookup 404 is therefore never proof of absence, whatever time has passed.
 *
 * Absence is proved by a FENCE (routes-changes.ts `POST /change-requests/{requestId}/fence`, routes-legacy.ts
 * `POST /legacy/references/{externalRef}/fence`), accepted only once the client's deadline has passed: it records
 * the id as FENCED in the same unique key the write inserts, waiting for a delivery still inside its transaction,
 * so it either returns the change that exists or guarantees that nothing can ever be applied under the id (a later
 * delivery is refused 409 FENCED). Ordering by the database's unique index, not by time.
 */
import type { Tx } from "./db.js";

export const DEADLINE_EXCEEDED = "DEADLINE_EXCEEDED";
/** Failure code of a fenced request id / reference: nothing can ever be applied under it. */
export const FENCED = "FENCED";
/** A fence asked for before the client's deadline passed, with nothing stored under the id: nothing changes. */
export const FENCE_BEFORE_DEADLINE = "FENCE_BEFORE_DEADLINE";
/** A deadline further ahead than this is refused (a client cannot make absence unprovable for long). */
export const MAX_DEADLINE_AHEAD_MS = 86_400_000;
/** Never above the pool's statement timeout (db.ts). */
const MAX_BOUND_MS = 15_000;

/** True when `notAfter` is a valid instant within the accepted horizon. */
export function deadlineAcceptable(notAfter: string, nowMs: number): boolean {
  const t = Date.parse(notAfter);
  return Number.isFinite(t) && t <= nowMs + MAX_DEADLINE_AHEAD_MS;
}

/**
 * Bounds every later lock wait and statement of the transaction by the time left before `notAfter` (database
 * clock). Returns false when the deadline has already passed (nothing may be applied).
 */
export async function boundByDeadline(tx: Tx, notAfter: string): Promise<boolean> {
  const r = await tx.query<{ ms: string | number | null }>("select floor(extract(epoch from ($1::timestamptz - clock_timestamp())) * 1000)::bigint as ms", [notAfter]);
  const ms = Number(r.rows[0]?.ms);
  if (!Number.isFinite(ms) || ms <= 0) return false;
  const bound = `${Math.max(1, Math.min(ms, MAX_BOUND_MS))}ms`;
  await tx.query("select set_config('lock_timeout', $1, true), set_config('statement_timeout', $1, true)", [bound]);
  return true;
}

/** Restores the transaction's default bounds (after a deadline refusal, before recording it). */
export async function unbound(tx: Tx): Promise<void> {
  await tx.query("select set_config('lock_timeout', '0', true), set_config('statement_timeout', $1, true)", [`${MAX_BOUND_MS}ms`]);
}

/** The final check, the last statement before COMMIT: true when the deadline has not passed yet. */
export async function withinDeadline(tx: Tx, notAfter: string): Promise<boolean> {
  const r = await tx.query<{ ok: boolean }>("select clock_timestamp() <= $1::timestamptz as ok", [notAfter]);
  return r.rows[0]?.ok === true;
}

/** A lock wait or statement aborted by the deadline bound (lock_not_available, query_canceled). */
export function isDeadlineAbort(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return code === "55P03" || code === "57014";
}
