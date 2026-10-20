/**
 * Inbox processor (follow-on FO-07-18, FO-07-20, FO-06-97; ACT-02, OPS-01, OPS-03). Worker, app_worker.
 *
 * Claims due RECEIVED events per tenant (FOR UPDATE SKIP LOCKED plus a lease, so two workers never
 * process one row at once), decrypts the payload outside any transaction, re-validates it against its
 * contract and then, in ONE transaction that first re-checks the claim token: checks the source-version
 * order of the event's entity (an event already superseded by a newer projected version is marked
 * PROCESSED / SUPERSEDED WITHOUT running its handler, so a stale, reordered or replayed event has no domain
 * effect), runs the contract's handler (its database effects), applies the source-version projection and
 * marks the row PROCESSED.
 * A crash before that commit leaves no effect and the lease expires (redelivery); a crash after it leaves
 * the effect exactly once. The inbox row is unique per (tenant, source, event id), so a duplicate
 * delivery never reaches a handler a second time.
 *
 * A failure retries with bounded exponential backoff and jitter (the profile's processing policy); after
 * maxAttempts the event moves to INBOUND_DEAD with a reason code, vsp_inbox_dead_letter_total is raised
 * (alarm on any increase) and, for a stream record, the position is recorded as an open gap of the
 * stream checkpoint (inbox_stream_gaps): a watermark never silently moves past a dead-lettered record.
 * A payload that no longer matches its contract is QUARANTINED instead.
 */
import { createHash } from "node:crypto";
import type { Db, Queryable } from "../db/types.js";
import { computeBackoffMs } from "../outbox/dispatcher.js";
import { silentLogger } from "../observability/logger.js";
import { noopMetrics } from "../observability/metrics.js";
import type { Logger, Metrics } from "../observability/ports.js";
import type { Clock } from "../shared/clock.js";
import { addMs, iso } from "../shared/clock.js";
import { PlatformError, ValidationError } from "../shared/errors.js";
import { newId } from "../shared/ids.js";
import type { PayloadCipher } from "./cipher.js";
import { classify } from "./contracts.js";
import type { InboundContractRegistry } from "./contracts.js";
import type { SourceProfileRegistry } from "./profile.js";
import { applySourceVersioned, isSupersededBySource } from "./projection.js";

export interface ProcessableEvent {
  inboxId: string;
  tenantId: string;
  sourceId: string;
  eventId: string;
  eventType: string;
  contractId: string;
  contractVersion: string;
  entityKey: string | null;
  sourceVersion: string | null;
  occurredAt: string | null;
  payload: unknown;
}

/** Result of a handler: an optional source-versioned projection fact for the event's entity. */
export interface HandlerResult {
  projection: { stateDigest: string } | null;
}

/** Contract handler: runs inside the processing transaction; must have no effect outside the database. */
export type InboxHandler = (tx: Queryable, event: ProcessableEvent) => Promise<HandlerResult>;

export interface InboxProcessorOptions {
  db: Db;
  cipher: PayloadCipher;
  profiles: SourceProfileRegistry;
  contracts: InboundContractRegistry;
  /** Handlers by `${contractId}@${version}`; an event whose contract has no handler is processed without projection. */
  handlers: Readonly<Record<string, InboxHandler>>;
  clock: Clock;
  tenants: readonly string[] | (() => Promise<readonly string[]>);
  leaseSeconds?: number;
  batchSize?: number;
  random?: () => number;
  logger?: Logger;
  metrics?: Metrics;
}

interface ClaimedRow {
  inbox_id: string;
  tenant_id: string;
  source_id: string;
  event_id: string;
  attempts: number;
  payload_digest: string;
  payload_ciphertext: Buffer | null;
  encrypted_data_key: Buffer | null;
  payload_key_ref: string | null;
  payload_iv: Buffer | null;
  payload_tag: Buffer | null;
  stream_partition: string | null;
  stream_position: string | null;
  received_at: Date | string;
}

export interface ProcessRunResult {
  processed: number;
  superseded: number;
  retried: number;
  deadLettered: number;
  quarantined: number;
}

const REASON = /^[A-Z][A-Z0-9_]{2,63}$/;

export class InboxProcessor {
  private readonly logger: Logger;
  private readonly metrics: Metrics;
  private readonly leaseMs: number;
  private readonly batchSize: number;
  private readonly random: () => number;

  constructor(private readonly opts: InboxProcessorOptions) {
    const lease = opts.leaseSeconds ?? 60;
    const batch = opts.batchSize ?? 25;
    if (!Number.isSafeInteger(lease) || lease < 5 || lease > 3600 || !Number.isSafeInteger(batch) || batch < 1 || batch > 500) throw new ValidationError("INBOX_PROCESSOR_CONFIG_INVALID");
    this.leaseMs = lease * 1000;
    this.batchSize = batch;
    this.random = opts.random ?? Math.random;
    this.logger = (opts.logger ?? silentLogger).child({ component: "inbox_processor" });
    this.metrics = opts.metrics ?? noopMetrics;
  }

  async runOnce(): Promise<ProcessRunResult> {
    const total: ProcessRunResult = { processed: 0, superseded: 0, retried: 0, deadLettered: 0, quarantined: 0 };
    const list = typeof this.opts.tenants === "function" ? await this.opts.tenants() : this.opts.tenants;
    for (const tenantId of new Set(list)) {
      const { token, rows } = await this.claim(tenantId);
      for (const row of rows) {
        const r = await this.processOne(row, token);
        total[r] += 1;
      }
    }
    this.gaugeBacklog(list).catch(() => undefined);
    return total;
  }

  private async claim(tenantId: string): Promise<{ token: string; rows: ClaimedRow[] }> {
    const now = this.opts.clock.now();
    const token = newId("clm");
    const r = await this.opts.db.tx(
      (tx) =>
        tx.query<ClaimedRow>(
          `with due as (
             select inbox_id from inbound_events
              where status = 'RECEIVED' and next_attempt_at <= $1::timestamptz and (claimed_until is null or claimed_until <= $1::timestamptz)
              order by received_at, inbox_id limit $2 for update skip locked)
           update inbound_events set claim_token = $3, claimed_until = $4::timestamptz, updated_at = $1::timestamptz
            where inbox_id in (select inbox_id from due)
           returning inbox_id, tenant_id, source_id, event_id, attempts, payload_digest, payload_ciphertext, encrypted_data_key, payload_key_ref,
                     payload_iv, payload_tag, stream_partition, stream_position::text as stream_position, received_at`,
          [iso(now), this.batchSize, token, iso(addMs(now, this.leaseMs))],
        ),
      { role: "app_worker", rls: { tenantId } },
    );
    // UPDATE ... RETURNING does not keep the CTE's order: restore arrival order within the batch (fair FIFO;
    // correctness never depends on it, projections order by source version).
    const at = (v: Date | string) => (v instanceof Date ? v.getTime() : Date.parse(v));
    const rows = [...r.rows].sort((a, b) => at(a.received_at) - at(b.received_at) || a.inbox_id.localeCompare(b.inbox_id));
    return { token, rows };
  }

  private async processOne(row: ClaimedRow, token: string): Promise<keyof ProcessRunResult> {
    const profile = this.opts.profiles.get(row.source_id);
    if (!profile || profile.tenantId !== row.tenant_id) return this.fail(row, token, "INBOX_SOURCE_PROFILE_MISSING", 1);
    let raw: Buffer;
    try {
      if (!row.payload_ciphertext || !row.encrypted_data_key || !row.payload_iv || !row.payload_tag || !row.payload_key_ref) throw new PlatformError("INBOX_PAYLOAD_PURGED");
      raw = await this.opts.cipher.decrypt(
        { ciphertext: row.payload_ciphertext, encryptedDataKey: row.encrypted_data_key, keyRef: row.payload_key_ref, iv: row.payload_iv, tag: row.payload_tag },
        { tenantId: row.tenant_id, sourceId: row.source_id, eventId: row.event_id, payloadDigest: row.payload_digest },
      );
    } catch (err) {
      return this.fail(row, token, reasonOf(err, "INBOX_PAYLOAD_DECRYPT_FAILED"), profile.processing.maxAttempts);
    }
    if (createHash("sha256").update(raw).digest("hex") !== row.payload_digest) return this.fail(row, token, "INBOX_PAYLOAD_DIGEST_MISMATCH", 1);
    const c = classify(raw, profile, this.opts.contracts);
    if (c.quarantine || !c.contract || c.eventType === null) return this.quarantine(row, token, c.quarantine ?? "SCHEMA_VIOLATION");
    const event: ProcessableEvent = {
      inboxId: row.inbox_id,
      tenantId: row.tenant_id,
      sourceId: row.source_id,
      eventId: row.event_id,
      eventType: c.eventType,
      contractId: c.contract.contractId,
      contractVersion: c.contract.version,
      entityKey: c.entityKey,
      sourceVersion: c.sourceVersion,
      occurredAt: c.occurredAt,
      payload: c.payload,
    };
    const handler = this.opts.handlers[`${c.contract.contractId}@${c.contract.version}`];
    try {
      const outcome = await this.opts.db.tx(
        async (tx) => {
          const mine = await tx.query("select 1 from inbound_events where inbox_id = $1 and claim_token = $2 and status = 'RECEIVED' for update", [row.inbox_id, token]);
          if (mine.rows.length !== 1) return "LOST" as const;
          const versioned = event.entityKey !== null && event.sourceVersion !== null;
          const stale =
            versioned &&
            (await isSupersededBySource(tx, { tenantId: event.tenantId, sourceId: event.sourceId, entityKey: event.entityKey ?? "", sourceVersion: event.sourceVersion ?? "0", occurredAt: event.occurredAt, eventId: event.eventId }));
          const result = stale ? { projection: null } : handler ? await handler(tx, event) : { projection: null };
          let projection: "APPLIED" | "SUPERSEDED" | "NO_PROJECTION" = stale ? "SUPERSEDED" : "NO_PROJECTION";
          if (!stale && result.projection && event.entityKey && event.sourceVersion) {
            projection = await applySourceVersioned(
              tx,
              { tenantId: event.tenantId, sourceId: event.sourceId, entityKey: event.entityKey, sourceVersion: event.sourceVersion, occurredAt: event.occurredAt, eventId: event.eventId, inboxId: event.inboxId, stateDigest: result.projection.stateDigest },
              this.opts.clock,
            );
          }
          const now = iso(this.opts.clock.now());
          await tx.query(
            `update inbound_events set status = 'PROCESSED', processed_at = $2::timestamptz, projection_result = $3, attempts = attempts + 1, claim_token = null,
                    claimed_until = null, last_error_code = null, schema_id = $4, schema_version = $5, event_type = $6, entity_key = $7,
                    source_version = $8::numeric, occurred_at = $9::timestamptz, updated_at = $2::timestamptz
              where inbox_id = $1`,
            [row.inbox_id, now, projection, event.contractId, event.contractVersion, event.eventType, event.entityKey, event.sourceVersion, event.occurredAt],
          );
          return projection;
        },
        { role: "app_worker", rls: { tenantId: row.tenant_id } },
      );
      if (outcome === "LOST") return "retried";
      this.metric("vsp_inbox_processed_total", { result: outcome === "SUPERSEDED" ? "superseded" : outcome === "APPLIED" ? "applied" : "no_projection" });
      return outcome === "SUPERSEDED" ? "superseded" : "processed";
    } catch (err) {
      return this.fail(row, token, reasonOf(err, "INBOX_HANDLER_FAILED"), profile.processing.maxAttempts, profile.processing);
    }
  }

  private async quarantine(row: ClaimedRow, token: string, reason: string): Promise<keyof ProcessRunResult> {
    const now = iso(this.opts.clock.now());
    await this.opts.db.tx(
      async (tx) => {
        const r = await tx.query(
          `update inbound_events set status = 'QUARANTINED', quarantine_reason = $3, attempts = attempts + 1, claim_token = null, claimed_until = null,
                  updated_at = $4::timestamptz where inbox_id = $1 and claim_token = $2 and status = 'RECEIVED'`,
          [row.inbox_id, token, reason, now],
        );
        if (r.rowCount === 1) await this.recordGap(tx, row, `INBOX_QUARANTINED_${reason}`, now);
      },
      { role: "app_worker", rls: { tenantId: row.tenant_id } },
    );
    this.metric("vsp_inbox_quarantined_total", { reason: reason.toLowerCase() });
    this.metric("vsp_inbox_processed_total", { result: "quarantined" });
    this.logger.warn("inbox.quarantined", { inboxId: row.inbox_id, integration: row.source_id, reasonCode: `INBOX_QUARANTINED_${reason}` });
    return "quarantined";
  }

  private async fail(row: ClaimedRow, token: string, reasonCode: string, maxAttempts: number, backoff?: { baseDelayMs: number; maxDelayMs: number }): Promise<keyof ProcessRunResult> {
    const attempts = row.attempts + 1;
    const now = this.opts.clock.now();
    const dead = attempts >= maxAttempts;
    const code = REASON.test(reasonCode) ? reasonCode : "INBOX_HANDLER_FAILED";
    await this.opts.db.tx(
      async (tx) => {
        if (dead) {
          const r = await tx.query(
            `update inbound_events set status = 'INBOUND_DEAD', dead_reason = $3, dead_at = $4::timestamptz, attempts = $5, last_error_code = $3,
                    claim_token = null, claimed_until = null, updated_at = $4::timestamptz
              where inbox_id = $1 and claim_token = $2 and status = 'RECEIVED'`,
            [row.inbox_id, token, code, iso(now), attempts],
          );
          if (r.rowCount === 1) await this.recordGap(tx, row, code, iso(now));
        } else {
          const delay = computeBackoffMs(attempts, backoff ?? { baseDelayMs: 1000, maxDelayMs: 300_000 }, this.random);
          await tx.query(
            `update inbound_events set attempts = $3, next_attempt_at = $4::timestamptz, last_error_code = $5, claim_token = null, claimed_until = null,
                    updated_at = $6::timestamptz where inbox_id = $1 and claim_token = $2 and status = 'RECEIVED'`,
            [row.inbox_id, token, attempts, iso(addMs(now, delay)), code, iso(now)],
          );
        }
      },
      { role: "app_worker", rls: { tenantId: row.tenant_id } },
    );
    if (dead) {
      this.metric("vsp_inbox_dead_letter_total", undefined);
      this.metric("vsp_inbox_processed_total", { result: "dead_lettered" });
      // Loud: an inbound event will not be applied until an audited replay.
      this.logger.error("inbox.dead_lettered", { inboxId: row.inbox_id, integration: row.source_id, reasonCode: code, attempts });
      return "deadLettered";
    }
    this.metric("vsp_inbox_processed_total", { result: "retry_scheduled" });
    this.logger.warn("inbox.retry_scheduled", { inboxId: row.inbox_id, integration: row.source_id, reasonCode: code, attempts });
    return "retried";
  }

  /** A stream position that will not be processed is recorded as an open gap of its checkpoint. */
  private async recordGap(tx: Queryable, row: ClaimedRow, reasonCode: string, now: string): Promise<void> {
    if (row.stream_partition === null || row.stream_position === null) return;
    await tx.query(
      `insert into inbox_stream_gaps (gap_id, tenant_id, source_id, stream_partition, stream_position, inbox_id, reason_code, opened_at)
       values ($1, $2, $3, $4, $5::numeric, $6, $7, $8::timestamptz) on conflict (tenant_id, source_id, stream_partition, stream_position) do nothing`,
      [newId("isg"), row.tenant_id, row.source_id, row.stream_partition, row.stream_position, row.inbox_id, REASON.test(reasonCode) ? reasonCode : "INBOX_RECORD_NOT_PROCESSED", now],
    );
    await tx.query(
      `update inbox_stream_checkpoints set open_gaps = (select count(*) from inbox_stream_gaps g where g.tenant_id = $1 and g.source_id = $2 and g.stream_partition = $3 and g.closed_at is null),
              updated_at = $4::timestamptz where tenant_id = $1 and source_id = $2 and stream_partition = $3`,
      [row.tenant_id, row.source_id, row.stream_partition, now],
    );
  }

  private async gaugeBacklog(tenants: readonly string[]): Promise<void> {
    let n = 0;
    for (const tenantId of new Set(tenants)) {
      const r = await this.opts.db.tx((tx) => tx.query<{ n: string }>("select count(*)::text as n from inbound_events where status = 'RECEIVED'"), { role: "app_worker", rls: { tenantId } });
      n += Number(r.rows[0]?.n ?? 0);
    }
    this.metrics.gauge("vsp_inbox_backlog", n);
  }

  private metric(name: string, labels: Record<string, string> | undefined): void {
    try {
      this.metrics.increment(name, labels);
    } catch {
      // metrics never change what is processed
    }
  }
}

function reasonOf(err: unknown, fallback: string): string {
  return err instanceof PlatformError && REASON.test(err.reasonCode) ? err.reasonCode : fallback;
}
