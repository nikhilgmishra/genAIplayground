/**
 * Outbox dispatcher (spec sections 8 and 12): claims due PENDING messages with
 * FOR UPDATE SKIP LOCKED plus a short lease, publishes outside any database transaction,
 * then settles. Delivery is at least once: a crash between publish and settle re-publishes
 * after the lease expires, and consumers deduplicate (ConsumerDedup).
 *
 * Failures back off exponentially with jitter (injectable random => deterministic tests) and
 * dead-letter after `maxAttempts`. The dispatcher itself never retries inside one run, so
 * transport retries are not stacked on top of the outbox's retries.
 *
 * Tenant isolation: the dispatcher runs as app_worker inside each tenant's RLS context, for
 * the tenants supplied by trusted configuration.
 */
import { z } from "zod";
import type { AuditWriter } from "../audit/ports.js";
import type { Db, Queryable } from "../db/types.js";
import type { Logger } from "../observability/ports.js";
import { silentLogger } from "../observability/logger.js";
import { AuditEventInput } from "../protocol/index.js";
import type { Clock } from "../shared/clock.js";
import { addMs, iso } from "../shared/clock.js";
import { ValidationError } from "../shared/errors.js";
import { newId } from "../shared/ids.js";
import type { MessagePublisher, OutboxDispatcher, OutboxMessage, OutboxMessageInput } from "./ports.js";

export interface BackoffPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
}

/**
 * Exponential backoff with "equal jitter": half the exponential window is fixed, half random.
 * `attempt` is the number of failed attempts so far (>= 1). `random` returns [0, 1).
 */
export function computeBackoffMs(attempt: number, policy: BackoffPolicy, random: () => number): number {
  const n = Math.max(1, Math.floor(attempt));
  const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.min(n - 1, 30));
  const r = Math.min(Math.max(random(), 0), 0.999999);
  return Math.floor(exp / 2 + r * (exp / 2));
}

/** Outbox message as handed to publishers; tenantId lets consumers set their RLS context. */
export interface DispatchedOutboxMessage extends OutboxMessage {
  tenantId: string;
}

export interface DeadLetterEntry {
  tenantId: string;
  messageId: string;
  topic: OutboxMessageInput["topic"];
  key: string;
  attempts: number;
  lastErrorCode: string | null;
  createdAt: string;
  deadAt: string;
}

const DispatcherConfig = z.strictObject({
  maxAttempts: z.number().int().min(1).max(50),
  baseDelayMs: z.number().int().min(10).max(600_000),
  maxDelayMs: z.number().int().min(10).max(86_400_000),
  leaseSeconds: z.number().int().min(5).max(3_600),
  batchSize: z.number().int().min(1).max(500),
  orderingPerKey: z.boolean(),
});
export type DispatcherConfig = z.infer<typeof DispatcherConfig>;

export const DEFAULT_DISPATCHER_CONFIG: DispatcherConfig = {
  maxAttempts: 8,
  baseDelayMs: 1_000,
  maxDelayMs: 300_000,
  leaseSeconds: 30,
  batchSize: 25,
  orderingPerKey: true,
};

export interface PgOutboxDispatcherOptions {
  db: Db;
  publisher: MessagePublisher;
  clock: Clock;
  /** Tenants this dispatcher serves, from trusted configuration. */
  tenants: readonly string[] | (() => Promise<readonly string[]>);
  config?: Partial<DispatcherConfig>;
  /** Injectable jitter source in [0, 1). */
  random?: () => number;
  logger?: Logger;
  /** When provided, operator repair actions are audited in the same transaction (fail closed). */
  audit?: AuditWriter;
}

interface OutboxRow {
  message_id: string;
  tenant_id: string;
  topic: OutboxMessageInput["topic"];
  key: string;
  payload: Record<string, unknown>;
  dedupe_key: string;
  attempts: number;
  created_at: Date | string;
  last_error_code: string | null;
  dead_at: Date | string | null;
}

const toIso = (v: Date | string): string => (v instanceof Date ? v : new Date(v)).toISOString();
const TENANT_ID = /^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$/;
const MESSAGE_ID = /^msg_[A-Za-z0-9_-]{16,64}$/;

export class PgOutboxDispatcher implements OutboxDispatcher {
  readonly config: DispatcherConfig;
  private readonly logger: Logger;
  private readonly random: () => number;

  constructor(private readonly opts: PgOutboxDispatcherOptions) {
    const cfg = DispatcherConfig.safeParse({ ...DEFAULT_DISPATCHER_CONFIG, ...(opts.config ?? {}) });
    if (!cfg.success || cfg.data.maxDelayMs < cfg.data.baseDelayMs) throw new ValidationError("OUTBOX_DISPATCHER_CONFIG_INVALID");
    this.config = cfg.data;
    this.logger = opts.logger ?? silentLogger;
    this.random = opts.random ?? Math.random;
  }

  private async tenants(): Promise<string[]> {
    const list = typeof this.opts.tenants === "function" ? await this.opts.tenants() : this.opts.tenants;
    for (const t of list) if (!TENANT_ID.test(t)) throw new ValidationError("OUTBOX_TENANT_INVALID");
    return [...new Set(list)];
  }

  async runOnce(limit?: number): Promise<{ dispatched: number; failed: number; deadLettered: number }> {
    const max = limit === undefined ? this.config.batchSize : Math.floor(limit);
    if (!Number.isFinite(max) || max < 1 || max > 500) throw new ValidationError("OUTBOX_LIMIT_INVALID");
    const totals = { dispatched: 0, failed: 0, deadLettered: 0 };
    let remaining = max;
    for (const tenantId of await this.tenants()) {
      if (remaining <= 0) break;
      const { token, rows } = await this.claim(tenantId, remaining);
      if (rows.length === 0) continue;
      remaining -= rows.length;
      const messages: DispatchedOutboxMessage[] = rows.map((r) => ({
        messageId: r.message_id,
        tenantId: r.tenant_id,
        topic: r.topic,
        key: r.key,
        payload: r.payload,
        dedupeKey: r.dedupe_key,
        attempts: r.attempts,
        createdAt: toIso(r.created_at),
      }));
      // A publisher exception fails the whole claimed batch (it is retried with backoff).
      const result = await Promise.resolve()
        .then(() => this.opts.publisher.publish(messages))
        .then(
          (r) => ({ published: new Set(r.published), failed: new Set(r.failed), errorCode: "PUBLISH_FAILED" }),
          () => ({ published: new Set<string>(), failed: new Set(messages.map((m) => m.messageId)), errorCode: "PUBLISH_EXCEPTION" }),
        );
      const { published, failed, errorCode } = result;
      const outcome = await this.settle(tenantId, token, rows, published, failed, errorCode);
      totals.dispatched += outcome.dispatched;
      totals.failed += outcome.failed;
      totals.deadLettered += outcome.deadLettered;
    }
    if (totals.failed > 0 || totals.deadLettered > 0) {
      this.logger.warn("outbox.dispatch.failures", { failedCount: totals.failed, deadLetteredCount: totals.deadLettered });
    }
    return totals;
  }

  private async claim(tenantId: string, limit: number): Promise<{ token: string; rows: OutboxRow[] }> {
    const now = this.opts.clock.now();
    const token = newId("clm");
    const leaseUntil = addMs(now, this.config.leaseSeconds * 1000);
    const orderingClause = this.config.orderingPerKey
      ? `and not exists (
           select 1 from outbox_messages o
           where o.tenant_id = m.tenant_id and o.key = m.key and o.status = 'PENDING'
             and (o.created_at < m.created_at or (o.created_at = m.created_at and o.message_id < m.message_id)))`
      : "";
    const rows = await this.opts.db.tx(
      async (tx) => {
        const r = await tx.query<OutboxRow>(
          `with due as (
             select m.message_id from outbox_messages m
             where m.tenant_id = $1 and m.status = 'PENDING' and m.next_attempt_at <= $2
               and (m.claimed_until is null or m.claimed_until <= $2)
               ${orderingClause}
             order by m.created_at, m.message_id
             limit $3
             for update skip locked
           )
           update outbox_messages set claim_token = $4, claimed_until = $5, updated_at = $2
           where message_id in (select message_id from due)
           returning message_id, tenant_id, topic, key, payload, dedupe_key, attempts, created_at, last_error_code, dead_at`,
          [tenantId, iso(now), limit, token, iso(leaseUntil)],
        );
        return r.rows;
      },
      { role: "app_worker", rls: { tenantId } },
    );
    rows.sort((a, b) => toIso(a.created_at).localeCompare(toIso(b.created_at)) || a.message_id.localeCompare(b.message_id));
    return { token, rows };
  }

  private async settle(
    tenantId: string,
    token: string,
    rows: OutboxRow[],
    published: Set<string>,
    failed: Set<string>,
    errorCode: string,
  ): Promise<{ dispatched: number; failed: number; deadLettered: number }> {
    const now = this.opts.clock.now();
    const out = { dispatched: 0, failed: 0, deadLettered: 0 };
    await this.opts.db.tx(
      async (tx) => {
        for (const row of rows) {
          // Ambiguous (reported both ways) or unreported => treat as failed: redelivery is safe, loss is not.
          const ok = published.has(row.message_id) && !failed.has(row.message_id);
          if (ok) {
            const r = await tx.query(
              `update outbox_messages set status = 'DISPATCHED', dispatched_at = $3, claim_token = null, claimed_until = null,
                      updated_at = $3
               where message_id = $1 and claim_token = $2 and status = 'PENDING'`,
              [row.message_id, token, iso(now)],
            );
            if (r.rowCount > 0) out.dispatched += 1;
            continue;
          }
          const attempts = row.attempts + 1;
          const code = failed.has(row.message_id) ? errorCode : "PUBLISH_RESULT_MISSING";
          if (attempts >= this.config.maxAttempts) {
            const r = await tx.query(
              `update outbox_messages set status = 'DEAD', attempts = $3, dead_at = $4, last_error_code = $5,
                      claim_token = null, claimed_until = null, updated_at = $4
               where message_id = $1 and claim_token = $2 and status = 'PENDING'`,
              [row.message_id, token, attempts, iso(now), code],
            );
            if (r.rowCount > 0) out.deadLettered += 1;
          } else {
            const delay = computeBackoffMs(attempts, this.config, this.random);
            const r = await tx.query(
              `update outbox_messages set attempts = $3, next_attempt_at = $4, last_error_code = $5,
                      claim_token = null, claimed_until = null, updated_at = $6
               where message_id = $1 and claim_token = $2 and status = 'PENDING'`,
              [row.message_id, token, attempts, iso(addMs(now, delay)), code, iso(now)],
            );
            if (r.rowCount > 0) out.failed += 1;
          }
        }
      },
      { role: "app_worker", rls: { tenantId } },
    );
    return out;
  }

  /** Operator repair queue: dead-lettered messages (metadata only). */
  async listDead(limit = 100): Promise<DeadLetterEntry[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new ValidationError("OUTBOX_LIMIT_INVALID");
    const out: DeadLetterEntry[] = [];
    for (const tenantId of await this.tenants()) {
      if (out.length >= limit) break;
      const rows = await this.opts.db.tx(
        async (tx) =>
          (
            await tx.query<OutboxRow>(
              `select message_id, tenant_id, topic, key, payload, dedupe_key, attempts, created_at, last_error_code, dead_at
               from outbox_messages where tenant_id = $1 and status = 'DEAD' order by dead_at, message_id limit $2`,
              [tenantId, limit - out.length],
            )
          ).rows,
        { role: "app_worker", rls: { tenantId } },
      );
      for (const r of rows) {
        out.push({
          tenantId: r.tenant_id,
          messageId: r.message_id,
          topic: r.topic,
          key: r.key,
          attempts: r.attempts,
          lastErrorCode: r.last_error_code,
          createdAt: toIso(r.created_at),
          deadAt: toIso(r.dead_at ?? r.created_at),
        });
      }
    }
    return out;
  }

  /**
   * Operator repair: return a dead-lettered message to PENDING with a fresh attempt budget.
   * Audited in the same transaction when an audit writer is configured (fails closed).
   */
  async requeueDead(messageId: string, operator?: { actorRef: string; reasonCode: string; correlationId?: string }): Promise<boolean> {
    if (!MESSAGE_ID.test(messageId)) throw new ValidationError("OUTBOX_MESSAGE_ID_INVALID");
    const now = this.opts.clock.now();
    for (const tenantId of await this.tenants()) {
      const done = await this.opts.db.tx(
        async (tx: Queryable) => {
          const r = await tx.query<{ message_id: string; attempts: number }>(
            `update outbox_messages set status = 'PENDING', attempts = 0, next_attempt_at = $2, dead_at = null,
                    claim_token = null, claimed_until = null, updated_at = $2
             where message_id = $1 and tenant_id = $3 and status = 'DEAD'
             returning message_id, attempts`,
            [messageId, iso(now), tenantId],
          );
          if (r.rowCount === 0) return false;
          if (this.opts.audit) {
            const input = AuditEventInput.parse({
              occurredAt: iso(now),
              correlationId: operator?.correlationId ?? messageId,
              parentId: null,
              tenantId,
              actorRef: operator?.actorRef ?? null,
              subjectRef: null,
              role: null,
              sourceComponent: "worker",
              callId: null,
              sessionRef: null,
              sessionGeneration: null,
              turnId: null,
              versions: null,
              action: "outbox.requeue",
              policyDecision: null,
              assurance: null,
              evidencePointers: [`outbox:${messageId}`],
              beforeHash: null,
              afterHash: null,
              idempotencyKey: null,
              outcome: "SUCCEEDED",
              reasonCode: operator?.reasonCode ?? "OPERATOR_REQUEUE",
              dataClass: "SECURITY_AUDIT",
            });
            await this.opts.audit.append(tx, input, "outbox");
          }
          return true;
        },
        { role: "app_worker", rls: { tenantId } },
      );
      if (done) {
        this.logger.info("outbox.requeue", { messageId });
        return true;
      }
    }
    return false;
  }
}
