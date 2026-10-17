/**
 * Tool request idempotency for the gateway (spec section 8 "Tool interface": idempotency
 * semantics per tool; section 12: no retries on top of retries).
 *
 * A repeated tool request carrying the same (tenant, integration, idempotency key) returns the
 * stored result instead of executing again; the same key with a different request hash is
 * rejected (IDEMPOTENCY_KEY_REUSED). A concurrent duplicate while the first is still executing
 * gets IN_PROGRESS. Expired records are ignored by readers in application logic, independent
 * of the purge job, and may then be re-bound.
 *
 * Consequential commits are additionally protected by the action ledger digest/commit protocol;
 * this table is a replay cache, not the commit-safety mechanism.
 */
import { z } from "zod";
import type { Db, Queryable } from "../db/types.js";
import { canonicalJson, digestOf } from "../shared/canonical.js";
import type { Clock } from "../shared/clock.js";
import { addMs, iso } from "../shared/clock.js";
import { ConflictError, ValidationError } from "../shared/errors.js";

export const IdempotencyScope = z.strictObject({
  tenantId: z.string().regex(/^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$/),
  integrationId: z.string().regex(/^[a-z0-9-]{3,64}$/),
});
export type IdempotencyScope = z.infer<typeof IdempotencyScope>;

const Key = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);
const RequestHash = z.string().regex(/^[a-f0-9]{64}$/);
const ToolMeta = z.strictObject({ toolName: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/), toolVersion: z.string().regex(/^\d+\.\d+\.\d+$/) });
export type ToolMeta = z.infer<typeof ToolMeta>;

export const TOOL_IDEMPOTENCY_MAX_RESPONSE_BYTES = 64 * 1024;
const StoredResponse = z
  .record(z.string(), z.unknown())
  .refine((r) => {
    try {
      return Buffer.byteLength(canonicalJson(r)) <= TOOL_IDEMPOTENCY_MAX_RESPONSE_BYTES;
    } catch {
      return false;
    }
  });

/**
 * Request hash over tool identity, arguments and the (non-bearer) session binding, so the same
 * key replayed from a different session or with different arguments is a mismatch.
 */
export function computeToolRequestHash(input: {
  toolName: string;
  toolVersion: string;
  arguments: Record<string, unknown>;
  sessionBinding: string | null;
}): string {
  return digestOf({ v: "tool-request.v1", ...input });
}

export type ReserveResult =
  | { status: "NEW" }
  | { status: "REPLAY"; response: Record<string, unknown>; completedAt: string }
  | { status: "IN_PROGRESS" };

export type LookupResult = null | { status: "COMPLETED"; response: Record<string, unknown>; completedAt: string } | { status: "IN_PROGRESS" | "RELEASED" };

interface Row {
  request_hash: string;
  status: "IN_PROGRESS" | "COMPLETED" | "RELEASED";
  response: Record<string, unknown> | null;
  lease_until: Date | string | null;
  completed_at: Date | string | null;
  expires_at: Date | string;
}

const ms = (v: Date | string): number => (v instanceof Date ? v : new Date(v)).getTime();
const isoOf = (v: Date | string): string => (v instanceof Date ? v : new Date(v)).toISOString();

export interface ToolRequestIdempotencyOptions {
  db: Db;
  clock: Clock;
  /** How long a stored result is replayable. */
  retentionSeconds?: number;
  /** In-progress reservations older than this may be re-taken (crashed gateway instance). */
  leaseSeconds?: number;
}

export class ToolRequestIdempotency {
  private readonly retentionMs: number;
  private readonly leaseMs: number;

  constructor(private readonly opts: ToolRequestIdempotencyOptions) {
    const retention = opts.retentionSeconds ?? 86_400;
    const lease = opts.leaseSeconds ?? 30;
    if (!Number.isInteger(retention) || retention < 60 || retention > 7 * 86_400) throw new ValidationError("IDEMPOTENCY_CONFIG_INVALID");
    if (!Number.isInteger(lease) || lease < 1 || lease > 3_600) throw new ValidationError("IDEMPOTENCY_CONFIG_INVALID");
    this.retentionMs = retention * 1000;
    this.leaseMs = lease * 1000;
  }

  private validate(scope: IdempotencyScope, key: string, requestHash: string): IdempotencyScope {
    const s = IdempotencyScope.safeParse(scope);
    if (!s.success) throw new ValidationError("IDEMPOTENCY_SCOPE_INVALID");
    if (!Key.safeParse(key).success) throw new ValidationError("IDEMPOTENCY_KEY_INVALID");
    if (!RequestHash.safeParse(requestHash).success) throw new ValidationError("IDEMPOTENCY_REQUEST_HASH_INVALID");
    return s.data;
  }

  private tx<T>(scope: IdempotencyScope, fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.opts.db.tx(fn, { role: "app_runtime", rls: { tenantId: scope.tenantId } });
  }

  private async lock(tx: Queryable, scope: IdempotencyScope, key: string): Promise<Row | null> {
    return (
      (
        await tx.query<Row>(
          `select request_hash, status, response, lease_until, completed_at, expires_at from tool_request_idempotency
           where tenant_id = $1 and integration_id = $2 and idempotency_key = $3 for update`,
          [scope.tenantId, scope.integrationId, key],
        )
      ).rows[0] ?? null
    );
  }

  /** Reserves the key for a new execution, or returns the stored result / in-progress marker. */
  async reserve(scope: IdempotencyScope, key: string, requestHash: string, meta: ToolMeta): Promise<ReserveResult> {
    const s = this.validate(scope, key, requestHash);
    const m = ToolMeta.safeParse(meta);
    if (!m.success) throw new ValidationError("IDEMPOTENCY_TOOL_META_INVALID");
    const now = this.opts.clock.now();
    const nowIso = iso(now);
    return this.tx(s, async (tx) => {
      const inserted = await tx.query(
        `insert into tool_request_idempotency (tenant_id, integration_id, idempotency_key, request_hash, tool_name, tool_version,
            status, response, lease_until, created_at, completed_at, expires_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, 'IN_PROGRESS', null, $7, $8, null, $9, $8)
         on conflict (tenant_id, integration_id, idempotency_key) do nothing`,
        [s.tenantId, s.integrationId, key, requestHash, m.data.toolName, m.data.toolVersion, iso(addMs(now, this.leaseMs)), nowIso, iso(addMs(now, this.retentionMs))],
      );
      if (inserted.rowCount > 0) return { status: "NEW" } as const;
      const row = await this.lock(tx, s, key);
      if (!row) throw new ConflictError("IDEMPOTENCY_RECORD_MISSING", "IDEMPOTENCY_RECORD_MISSING", true);
      const expired = ms(row.expires_at) <= now.getTime();
      if (!expired && row.request_hash !== requestHash) throw new ConflictError("IDEMPOTENCY_KEY_REUSED");
      if (!expired && row.status === "COMPLETED" && row.response) {
        return { status: "REPLAY", response: row.response, completedAt: isoOf(row.completed_at ?? row.expires_at) } as const;
      }
      const leaseLive = row.status === "IN_PROGRESS" && row.lease_until !== null && ms(row.lease_until) > now.getTime();
      if (!expired && leaseLive) return { status: "IN_PROGRESS" } as const;
      // Expired record, released reservation, or crashed in-progress reservation: (re)take it.
      await tx.query(
        `update tool_request_idempotency
         set request_hash = $4, tool_name = $5, tool_version = $6, status = 'IN_PROGRESS', response = null, lease_until = $7,
             completed_at = null, created_at = case when $10 then $8::timestamptz else created_at end,
             expires_at = case when $10 then $9::timestamptz else expires_at end, updated_at = $8
         where tenant_id = $1 and integration_id = $2 and idempotency_key = $3`,
        [s.tenantId, s.integrationId, key, requestHash, m.data.toolName, m.data.toolVersion, iso(addMs(now, this.leaseMs)), nowIso, iso(addMs(now, this.retentionMs)), expired],
      );
      return { status: "NEW" } as const;
    });
  }

  /** Stores the result for a reserved key. Use `completeInTx` to commit it with the effect. */
  async complete(scope: IdempotencyScope, key: string, requestHash: string, response: Record<string, unknown>): Promise<void> {
    const s = this.validate(scope, key, requestHash);
    await this.tx(s, (tx) => this.completeInTx(tx, s, key, requestHash, response));
  }

  async completeInTx(tx: Queryable, scope: IdempotencyScope, key: string, requestHash: string, response: Record<string, unknown>): Promise<void> {
    const s = this.validate(scope, key, requestHash);
    if (!StoredResponse.safeParse(response).success) throw new ValidationError("IDEMPOTENCY_RESPONSE_INVALID");
    const nowIso = iso(this.opts.clock.now());
    const r = await tx.query(
      `update tool_request_idempotency set status = 'COMPLETED', response = $5::jsonb, completed_at = $6, lease_until = null, updated_at = $6
       where tenant_id = $1 and integration_id = $2 and idempotency_key = $3 and request_hash = $4 and status = 'IN_PROGRESS'
         and expires_at > $6`,
      [s.tenantId, s.integrationId, key, requestHash, JSON.stringify(response), nowIso],
    );
    if (r.rowCount > 0) return;
    const row = await this.lock(tx, s, key);
    if (row && row.request_hash !== requestHash && ms(row.expires_at) > this.opts.clock.now().getTime()) throw new ConflictError("IDEMPOTENCY_KEY_REUSED");
    if (row && row.status === "COMPLETED" && row.request_hash === requestHash) return; // already stored
    throw new ConflictError("IDEMPOTENCY_RESERVATION_LOST");
  }

  /** Releases a reservation after a retryable failure so the same request may execute again. */
  async release(scope: IdempotencyScope, key: string, requestHash: string): Promise<void> {
    const s = this.validate(scope, key, requestHash);
    const nowIso = iso(this.opts.clock.now());
    await this.tx(s, (tx) =>
      tx.query(
        `update tool_request_idempotency set status = 'RELEASED', lease_until = null, updated_at = $5
         where tenant_id = $1 and integration_id = $2 and idempotency_key = $3 and request_hash = $4 and status = 'IN_PROGRESS'`,
        [s.tenantId, s.integrationId, key, requestHash, nowIso],
      ),
    );
  }

  /** Read-only lookup; mismatched request hash on a live key is rejected. */
  async lookup(scope: IdempotencyScope, key: string, requestHash: string): Promise<LookupResult> {
    const s = this.validate(scope, key, requestHash);
    const now = this.opts.clock.now();
    const row = await this.tx(s, async (tx) =>
      (
        await tx.query<Row>(
          `select request_hash, status, response, lease_until, completed_at, expires_at from tool_request_idempotency
           where tenant_id = $1 and integration_id = $2 and idempotency_key = $3`,
          [s.tenantId, s.integrationId, key],
        )
      ).rows[0] ?? null,
    );
    if (!row || ms(row.expires_at) <= now.getTime()) return null;
    if (row.request_hash !== requestHash) throw new ConflictError("IDEMPOTENCY_KEY_REUSED");
    if (row.status === "COMPLETED" && row.response) return { status: "COMPLETED", response: row.response, completedAt: isoOf(row.completed_at ?? row.expires_at) };
    return { status: row.status === "RELEASED" ? "RELEASED" : "IN_PROGRESS" };
  }

  /**
   * One-shot record (first writer wins): stores `response` for the key, or returns the response
   * already stored for the same request. A different request hash is rejected.
   */
  async record(
    scope: IdempotencyScope,
    key: string,
    requestHash: string,
    meta: ToolMeta,
    response: Record<string, unknown>,
  ): Promise<{ replayed: boolean; response: Record<string, unknown> }> {
    const reserved = await this.reserve(scope, key, requestHash, meta);
    if (reserved.status === "REPLAY") return { replayed: true, response: reserved.response };
    if (reserved.status === "IN_PROGRESS") throw new ConflictError("IDEMPOTENCY_IN_PROGRESS", "IDEMPOTENCY_IN_PROGRESS", true);
    await this.complete(scope, key, requestHash, response);
    return { replayed: false, response };
  }

  /** Worker purge of expired records (readers already ignore them). */
  async purgeExpired(tenantId: string, limit = 500): Promise<number> {
    const s = IdempotencyScope.pick({ tenantId: true }).safeParse({ tenantId });
    if (!s.success || !Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new ValidationError("IDEMPOTENCY_PURGE_INVALID");
    const nowIso = iso(this.opts.clock.now());
    return this.opts.db.tx(
      async (tx) =>
        (
          await tx.query(
            `delete from tool_request_idempotency where ctid in (
               select ctid from tool_request_idempotency where tenant_id = $1 and expires_at <= $2 limit $3)`,
            [tenantId, nowIso, limit],
          )
        ).rowCount,
      { role: "app_worker", rls: { tenantId } },
    );
  }
}
