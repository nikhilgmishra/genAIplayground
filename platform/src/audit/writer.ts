/**
 * Durable audit writer over the local audit outbox (spec section 13, OPS-01).
 *
 * Sequence + prevHash + hash are assigned under a row lock on the stream's chain
 * head inside the caller's transaction, so the audit event commits or rolls back
 * atomically with the consequential change it records. Committed sequences per
 * stream are contiguous (a rolled-back append releases its sequence number).
 * Every storage failure surfaces as AuditUnavailableError so callers fail closed:
 * "Do not acknowledge a mutation and hope to log it later."
 */
import type { Db, DbRole, Queryable } from "../db/types.js";
import type { Logger } from "../observability/ports.js";
import { silentLogger } from "../observability/logger.js";
import type { AuditEvent, AuditEventInput } from "../protocol/index.js";
import type { Clock } from "../shared/clock.js";
import { iso } from "../shared/clock.js";
import { AuditUnavailableError, ValidationError } from "../shared/errors.js";
import { newId } from "../shared/ids.js";
import { buildChainedEvent } from "./chain.js";
import { toAuditUnavailable, toSafeInt } from "./internal.js";
import type { AuditWriter } from "./ports.js";
import { assertStreamName, normalizeAuditInput, validateAuditInput } from "./schema.js";

export interface PgAuditWriterOptions {
  db: Db;
  clock: Clock;
  /** Default stream for this writer instance, e.g. auditStreamName("gateway", instanceId). */
  stream: string;
  logger?: Logger;
  /** Role for appendStandalone transactions (default app_runtime). */
  standaloneRole?: Exclude<DbRole, "owner" | "app_auditor">;
  /** Events stamped further than this into the future (writer clock) are rejected. Default 300 s. */
  maxFutureSkewSeconds?: number;
}

interface HeadRow {
  last_sequence: unknown;
  last_hash: string | null;
  tenant: string | null;
}

export class PgAuditWriter implements AuditWriter {
  readonly kind = "live" as const;
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly defaultStream: string;
  private readonly logger: Logger;
  private readonly standaloneRole: Exclude<DbRole, "owner" | "app_auditor">;
  private readonly maxFutureSkewMs: number;

  constructor(opts: PgAuditWriterOptions) {
    this.db = opts.db;
    this.clock = opts.clock;
    this.defaultStream = assertStreamName(opts.stream);
    this.logger = (opts.logger ?? silentLogger).child({ component: "audit_writer" });
    this.standaloneRole = opts.standaloneRole ?? "app_runtime";
    this.maxFutureSkewMs = (opts.maxFutureSkewSeconds ?? 300) * 1000;
  }

  /**
   * Validates, chains and inserts the event in `tx`. The transaction must carry
   * rls.tenantId equal to input.tenantId (enforced by RLS and checked here).
   * Throws AuditEventInvalidError for invalid input and AuditUnavailableError for
   * any storage failure; in both cases the caller must not acknowledge its action.
   */
  async append(tx: Queryable, input: AuditEventInput, stream?: string): Promise<AuditEvent> {
    const prepared = this.prepare(input);
    const sourceStream = assertStreamName(stream ?? this.defaultStream);
    try {
      return await this.appendPrepared(tx, prepared, sourceStream);
    } catch (err) {
      const e = toAuditUnavailable(err);
      this.logger.error("audit.append.failed", { reasonCode: e.reasonCode, stream: sourceStream });
      throw e;
    }
  }

  async appendStandalone(input: AuditEventInput, stream?: string): Promise<AuditEvent> {
    const prepared = this.prepare(input);
    const sourceStream = assertStreamName(stream ?? this.defaultStream);
    try {
      return await this.db.tx((tx) => this.appendPrepared(tx, prepared, sourceStream), {
        role: this.standaloneRole,
        rls: { tenantId: prepared.tenantId },
      });
    } catch (err) {
      const e = toAuditUnavailable(err);
      this.logger.error("audit.append.failed", { reasonCode: e.reasonCode, stream: sourceStream });
      throw e;
    }
  }

  private prepare(input: AuditEventInput): AuditEventInput {
    const valid = normalizeAuditInput(validateAuditInput(input));
    const occurred = new Date(valid.occurredAt).getTime();
    if (occurred - this.clock.now().getTime() > this.maxFutureSkewMs) {
      throw new ValidationError("AUDIT_EVENT_TIMESTAMP_IN_FUTURE");
    }
    return valid;
  }

  private async lockHead(tx: Queryable, stream: string): Promise<HeadRow | undefined> {
    const r = await tx.query<HeadRow>(
      `select last_sequence::text as last_sequence, last_hash, app_tenant() as tenant
         from audit_chain_heads where source_stream = $1 for update`,
      [stream],
    );
    return r.rows[0];
  }

  private async appendPrepared(tx: Queryable, input: AuditEventInput, stream: string): Promise<AuditEvent> {
    let head = await this.lockHead(tx, stream);
    if (!head) {
      await tx.query(
        `insert into audit_chain_heads (source_stream, last_sequence, last_hash, updated_at)
         values ($1, 0, null, $2::timestamptz) on conflict (source_stream) do nothing`,
        [stream, iso(this.clock.now())],
      );
      head = await this.lockHead(tx, stream);
      if (!head) throw new AuditUnavailableError("AUDIT_CHAIN_HEAD_UNAVAILABLE");
    }
    if (head.tenant !== input.tenantId) throw new AuditUnavailableError("AUDIT_TENANT_CONTEXT_MISMATCH");

    const lastSequence = toSafeInt(head.last_sequence);
    const event = buildChainedEvent(input, newId("aud"), {
      sourceStream: stream,
      sequence: lastSequence + 1,
      prevHash: head.last_hash,
    });
    const recordedAt = iso(this.clock.now());

    await tx.query(
      `insert into audit_outbox
         (event_id, tenant_id, source_stream, sequence, prev_hash, hash, event, occurred_at, recorded_at,
          correlation_id, call_id, action, outcome, data_class)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::timestamptz, $9::timestamptz, $10, $11, $12, $13, $14)`,
      [
        event.eventId,
        event.tenantId,
        event.sourceStream,
        event.sequence,
        event.prevHash,
        event.hash,
        JSON.stringify(event),
        event.occurredAt,
        recordedAt,
        event.correlationId,
        event.callId,
        event.action,
        event.outcome,
        event.dataClass,
      ],
    );
    const advanced = await tx.query(
      `update audit_chain_heads set last_sequence = $2, last_hash = $3, updated_at = $4::timestamptz
        where source_stream = $1 and last_sequence = $5`,
      [stream, event.sequence, event.hash, recordedAt, lastSequence],
    );
    if (advanced.rowCount !== 1) throw new AuditUnavailableError("AUDIT_CHAIN_CONFLICT");
    return event;
  }
}
