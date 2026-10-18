/**
 * Bounded buffering policy for the local audit outbox (spec section 13):
 * "If the centralized sink fails, a local durable outbox may buffer within a
 * bounded policy. If durable evidence cannot be written at all, block
 * consequential actions and degrade to safe routing."
 *
 * canAcceptConsequential requires ALL of:
 *   - the write probe succeeds (store writable, not a read-only replica, writer privileges present)
 *   - unshipped backlog count <= maxBacklog
 *   - oldest unshipped event age <= maxBacklogAgeSeconds
 * Reason precedence: AUDIT_STORE_UNWRITABLE > AUDIT_BACKLOG_EXCEEDED > AUDIT_SINK_STALE.
 */
import type { Db, DbRole } from "../db/types.js";
import type { Logger } from "../observability/ports.js";
import { silentLogger } from "../observability/logger.js";
import type { Clock } from "../shared/clock.js";
import { iso } from "../shared/clock.js";
import { AuditUnavailableError, ValidationError } from "../shared/errors.js";
import { toDateOrNull, toSafeInt } from "./internal.js";
import type { AuditHealth, AuditHealthStatus } from "./ports.js";
import { STREAM_NAME_RE } from "./schema.js";

export const AUDIT_HEALTH_REASONS = {
  storeUnwritable: "AUDIT_STORE_UNWRITABLE",
  backlogExceeded: "AUDIT_BACKLOG_EXCEEDED",
  sinkStale: "AUDIT_SINK_STALE",
} as const;

export interface AuditBufferPolicy {
  /** Maximum unshipped events across all streams (PlatformConfig.audit.maxBacklog). */
  maxBacklog: number;
  /** Maximum age of the oldest unshipped event (PlatformConfig.audit.maxBacklogAgeSeconds). */
  maxBacklogAgeSeconds: number;
}

export interface PgAuditHealthOptions {
  db: Db;
  clock: Clock;
  policy: AuditBufferPolicy;
  /** Identifies this instance's probe row, e.g. the writer stream name. */
  probeId: string;
  /** Role used for the write probe; should be the role that appends audit events (default app_runtime). */
  role?: Exclude<DbRole, "owner" | "app_auditor">;
  /** Optional RLS tenant context for the probe transaction (the probe stores no tenant data). */
  tenantId?: string;
  logger?: Logger;
  /**
   * Optional reuse of a HEALTHY result for this many ms (default 0 = evaluate every call).
   * Unhealthy results are never cached, and PgAuditWriter still fails closed on every
   * append, so caching only trades probe load against detection latency.
   */
  cacheTtlMs?: number;
}

interface StatsRow {
  backlog_count: unknown;
  oldest_unshipped_recorded_at: unknown;
  last_success_at: unknown;
  last_failure_at: unknown;
  consecutive_failures: unknown;
}

interface ProbeRow {
  can_insert: boolean;
  can_advance: boolean;
  in_recovery: boolean;
}

export function validateBufferPolicy(policy: AuditBufferPolicy): AuditBufferPolicy {
  if (!Number.isSafeInteger(policy.maxBacklog) || policy.maxBacklog < 0) throw new ValidationError("AUDIT_POLICY_INVALID");
  if (!Number.isFinite(policy.maxBacklogAgeSeconds) || policy.maxBacklogAgeSeconds <= 0) throw new ValidationError("AUDIT_POLICY_INVALID");
  return policy;
}

export class PgAuditHealth implements AuditHealth {
  private readonly logger: Logger;
  private readonly role: Exclude<DbRole, "owner" | "app_auditor">;
  private readonly cacheTtlMs: number;
  private cached: { at: number; status: AuditHealthStatus } | null = null;

  constructor(private readonly opts: PgAuditHealthOptions) {
    validateBufferPolicy(opts.policy);
    this.cacheTtlMs = opts.cacheTtlMs ?? 0;
    if (!Number.isSafeInteger(this.cacheTtlMs) || this.cacheTtlMs < 0 || this.cacheTtlMs > 10_000) throw new ValidationError("AUDIT_POLICY_INVALID");
    if (!STREAM_NAME_RE.test(opts.probeId)) throw new ValidationError("AUDIT_PROBE_ID_INVALID");
    this.role = opts.role ?? "app_runtime";
    this.logger = (opts.logger ?? silentLogger).child({ component: "audit_health" });
  }

  async status(): Promise<AuditHealthStatus> {
    const now = this.opts.clock.now();
    if (this.cached && now.getTime() - this.cached.at < this.cacheTtlMs) return { ...this.cached.status };
    this.cached = null;
    const s = await this.evaluate(now);
    if (s.canAcceptConsequential && this.cacheTtlMs > 0) this.cached = { at: now.getTime(), status: s };
    return { ...s };
  }

  private async evaluate(now: Date): Promise<AuditHealthStatus> {
    let stats: StatsRow | undefined;
    let probe: ProbeRow | undefined;
    try {
      [stats, probe] = await this.opts.db.tx(
        async (tx) => {
          const p = await tx.query<ProbeRow>(
            `select has_table_privilege(current_user, 'audit_outbox', 'INSERT') as can_insert,
                    has_table_privilege(current_user, 'audit_chain_heads', 'UPDATE') as can_advance,
                    pg_is_in_recovery() as in_recovery`,
          );
          await tx.query(
            `insert into audit_write_probe (probe_id, probed_at) values ($1, $2::timestamptz)
             on conflict (probe_id) do update set probed_at = excluded.probed_at`,
            [this.opts.probeId, iso(now)],
          );
          const s = await tx.query<StatsRow>("select * from audit_backlog_stats()");
          return [s.rows[0], p.rows[0]] as const;
        },
        this.opts.tenantId ? { role: this.role, rls: { tenantId: this.opts.tenantId } } : { role: this.role },
      );
    } catch {
      return this.blocked(AUDIT_HEALTH_REASONS.storeUnwritable, 0, null, false);
    }
    if (!stats || !probe) return this.blocked(AUDIT_HEALTH_REASONS.storeUnwritable, 0, null, false);

    let backlogCount: number;
    let oldestAgeSeconds: number | null;
    let consecutiveFailures: number;
    try {
      backlogCount = toSafeInt(stats.backlog_count);
      const oldest = toDateOrNull(stats.oldest_unshipped_recorded_at);
      oldestAgeSeconds = oldest ? Math.max(0, Math.floor((now.getTime() - oldest.getTime()) / 1000)) : null;
      consecutiveFailures = toSafeInt(stats.consecutive_failures);
    } catch {
      return this.blocked(AUDIT_HEALTH_REASONS.storeUnwritable, 0, null, false);
    }

    const ageExceeded = oldestAgeSeconds !== null && oldestAgeSeconds > this.opts.policy.maxBacklogAgeSeconds;
    const sinkHealthy = consecutiveFailures === 0 && !ageExceeded;

    if (!probe.can_insert || !probe.can_advance || probe.in_recovery) {
      return this.blocked(AUDIT_HEALTH_REASONS.storeUnwritable, backlogCount, oldestAgeSeconds, sinkHealthy);
    }
    if (backlogCount > this.opts.policy.maxBacklog) {
      return this.blocked(AUDIT_HEALTH_REASONS.backlogExceeded, backlogCount, oldestAgeSeconds, sinkHealthy);
    }
    if (ageExceeded) {
      return this.blocked(AUDIT_HEALTH_REASONS.sinkStale, backlogCount, oldestAgeSeconds, sinkHealthy);
    }
    return { canAcceptConsequential: true, backlogCount, oldestUnshippedAgeSeconds: oldestAgeSeconds, sinkHealthy, reasonCode: null };
  }

  async assertCanAcceptConsequential(): Promise<void> {
    const s = await this.status();
    if (!s.canAcceptConsequential) throw new AuditUnavailableError(s.reasonCode ?? "AUDIT_UNAVAILABLE");
  }

  /**
   * When reasonCode is AUDIT_STORE_UNWRITABLE because the store could not be read,
   * backlogCount (0) and oldestUnshippedAgeSeconds (null) are unknown, not healthy.
   */
  private blocked(reasonCode: string, backlogCount: number, oldest: number | null, sinkHealthy: boolean): AuditHealthStatus {
    this.logger.warn("audit.health.blocked", { reasonCode, backlogCount });
    return { canAcceptConsequential: false, backlogCount, oldestUnshippedAgeSeconds: oldest, sinkHealthy, reasonCode };
  }
}
