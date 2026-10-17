/**
 * Consumer-side deduplication (spec section 8: "Events are at least once; consumers
 * deduplicate"). The dedupe row and the handler's effects are written in ONE transaction:
 * if the handler fails, both roll back and redelivery retries; if it succeeds, a redelivered
 * copy finds the dedupe row and is skipped (ACT-02).
 */
import { z } from "zod";
import type { Db, DbRole, Queryable } from "../db/types.js";
import type { Clock } from "../shared/clock.js";
import { iso } from "../shared/clock.js";
import { ValidationError } from "../shared/errors.js";
import type { ConsumerDedup } from "./ports.js";

const Consumer = z.string().regex(/^[a-z][a-z0-9_.-]{2,63}$/);
const MessageId = z.string().regex(/^[A-Za-z0-9_.:-]{8,128}$/);
const TenantId = z.string().regex(/^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$/);

export interface PgConsumerDedupOptions {
  db: Db;
  clock: Clock;
  /** Role for consumer transactions; workers by default. */
  role?: Extract<DbRole, "app_worker" | "app_runtime">;
  /** Tenant used by the port-level `processOnce`; multi-tenant consumers call `processOnceForTenant`. */
  tenantId?: string;
}

export class PgConsumerDedup implements ConsumerDedup {
  constructor(private readonly opts: PgConsumerDedupOptions) {
    if (opts.tenantId !== undefined && !TenantId.safeParse(opts.tenantId).success) throw new ValidationError("CONSUMER_TENANT_INVALID");
  }

  processOnce<T>(consumer: string, messageId: string, handler: (tx: Queryable) => Promise<T>): Promise<{ duplicate: boolean; result: T | null }> {
    if (!this.opts.tenantId) throw new ValidationError("CONSUMER_TENANT_CONTEXT_REQUIRED");
    return this.processOnceForTenant(this.opts.tenantId, consumer, messageId, handler);
  }

  async processOnceForTenant<T>(
    tenantId: string,
    consumer: string,
    messageId: string,
    handler: (tx: Queryable) => Promise<T>,
  ): Promise<{ duplicate: boolean; result: T | null }> {
    if (!TenantId.safeParse(tenantId).success) throw new ValidationError("CONSUMER_TENANT_INVALID");
    if (!Consumer.safeParse(consumer).success) throw new ValidationError("CONSUMER_NAME_INVALID");
    if (!MessageId.safeParse(messageId).success) throw new ValidationError("CONSUMER_MESSAGE_ID_INVALID");
    return this.opts.db.tx(
      async (tx) => {
        const inserted = await tx.query<{ message_id: string }>(
          `insert into consumer_dedup (consumer, message_id, tenant_id, processed_at)
           values ($1, $2, app_tenant(), $3)
           on conflict (consumer, message_id) do nothing
           returning message_id`,
          [consumer, messageId, iso(this.opts.clock.now())],
        );
        if (inserted.rowCount === 0) return { duplicate: true, result: null };
        const result = await handler(tx);
        return { duplicate: false, result };
      },
      { role: this.opts.role ?? "app_worker", rls: { tenantId } },
    );
  }
}
