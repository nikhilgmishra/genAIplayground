/**
 * Ships the local audit outbox to the independent append-only sink, per stream,
 * in sequence order (spec section 13).
 *
 * Crash safety / idempotency:
 *   1. The batch is planned and recorded locally (audit_manifests status PLANNED)
 *      BEFORE anything is put, fixing its exact range, manifest id and timestamp.
 *   2. sink.putBatch writes the NDJSON body then the manifest (deterministic key
 *      `<stream>/<first>-<last>.ndjson`); WORM sinks treat an identical re-put as a no-op.
 *   3. Rows are marked shipped (shipped_at + manifest_id, once) and the manifest
 *      becomes SHIPPED in one transaction.
 * A crash or ambiguous failure between 2 and 3 is resolved on the next run by
 * re-putting exactly the PLANNED batch, so no overlapping or duplicate objects arise.
 *
 * Before planning, the shipper re-verifies the batch's hashes and links and refuses
 * to ship across a sequence gap or broken link: a damaged local chain is an
 * integrity incident, and the resulting backlog makes AuditHealth block
 * consequential actions (fail closed) until investigated.
 */
import type { Db, DbRole, Queryable } from "../db/types.js";
import type { Logger } from "../observability/ports.js";
import { silentLogger } from "../observability/logger.js";
import { AuditEvent, AuditManifest } from "../protocol/index.js";
import type { AuditEvent as AuditEventType, AuditManifest as AuditManifestType } from "../protocol/index.js";
import type { Clock } from "../shared/clock.js";
import { iso } from "../shared/clock.js";
import { PlatformError, ValidationError } from "../shared/errors.js";
import { newId } from "../shared/ids.js";
import { batchDigestOf, buildManifest, toNdjson, verifyChain } from "./chain.js";
import { guardStorage, toSafeInt } from "./internal.js";
import type { AuditSink } from "./ports.js";
import { STREAM_NAME_RE } from "./schema.js";

export interface AuditShipperOptions {
  db: Db;
  sink: AuditSink;
  clock: Clock;
  logger?: Logger;
  /** Events per batch (default 500, max 10 000). */
  batchSize?: number;
  /** Upper bound of batches per stream per run (default 20). */
  maxBatchesPerStream?: number;
  /** Identifier for sink health records (default "primary"). */
  sinkId?: string;
  /** Role for shipper transactions (default app_worker, the only role allowed to mark rows shipped). */
  role?: Extract<DbRole, "app_worker" | "owner">;
}

export interface StreamShipResult {
  sourceStream: string;
  batchesShipped: number;
  eventsShipped: number;
  /** Null when the stream is fully shipped or stopped at its batch limit. */
  reasonCode: string | null;
}

export interface ShipRunResult {
  batchesShipped: number;
  eventsShipped: number;
  streams: StreamShipResult[];
  failedStreams: number;
}

interface OutboxRow {
  sequence: unknown;
  event: unknown;
  hash: string;
  manifest_id: string | null;
}

interface ManifestRow {
  manifest: unknown;
  status: "PLANNED" | "SHIPPED";
  last_sequence: unknown;
  last_hash: string;
}

/** Integrity or ordering problem that stops shipping for one stream. */
export class AuditShipBlockedError extends PlatformError {}

export class AuditShipper {
  private readonly logger: Logger;
  private readonly batchSize: number;
  private readonly maxBatches: number;
  private readonly sinkId: string;
  private readonly role: Extract<DbRole, "app_worker" | "owner">;

  constructor(private readonly opts: AuditShipperOptions) {
    this.batchSize = opts.batchSize ?? 500;
    this.maxBatches = opts.maxBatchesPerStream ?? 20;
    this.sinkId = opts.sinkId ?? "primary";
    this.role = opts.role ?? "app_worker";
    if (!Number.isSafeInteger(this.batchSize) || this.batchSize < 1 || this.batchSize > 10_000) throw new ValidationError("AUDIT_BATCH_SIZE_INVALID");
    if (!Number.isSafeInteger(this.maxBatches) || this.maxBatches < 1) throw new ValidationError("AUDIT_BATCH_LIMIT_INVALID");
    if (!STREAM_NAME_RE.test(this.sinkId)) throw new ValidationError("AUDIT_SINK_ID_INVALID");
    this.logger = (opts.logger ?? silentLogger).child({ component: "audit_shipper" });
  }

  /** Ships every stream with pending events. Failures are isolated per stream. */
  async runOnce(): Promise<ShipRunResult> {
    const streams = await this.tx(async (tx) => {
      const r = await tx.query<{ source_stream: string }>(
        `select distinct source_stream from audit_outbox where shipped_at is null
         union
         select distinct source_stream from audit_manifests where status = 'PLANNED'
         order by 1`,
      );
      return r.rows.map((x) => x.source_stream);
    });
    const results: StreamShipResult[] = [];
    for (const s of streams) results.push(await this.shipStream(s));
    return {
      batchesShipped: results.reduce((a, r) => a + r.batchesShipped, 0),
      eventsShipped: results.reduce((a, r) => a + r.eventsShipped, 0),
      streams: results,
      failedStreams: results.filter((r) => r.reasonCode !== null).length,
    };
  }

  async shipStream(sourceStream: string): Promise<StreamShipResult> {
    const result: StreamShipResult = { sourceStream, batchesShipped: 0, eventsShipped: 0, reasonCode: null };
    for (let i = 0; i < this.maxBatches; i++) {
      let batch: { manifest: AuditManifestType; ndjson: string } | null;
      try {
        batch = await this.nextBatch(sourceStream);
      } catch (err) {
        result.reasonCode = err instanceof PlatformError ? err.reasonCode : "AUDIT_SHIP_PLAN_FAILED";
        this.logger.error("audit.ship.blocked", { reasonCode: result.reasonCode, stream: sourceStream });
        return result;
      }
      if (!batch) return result;

      try {
        await this.opts.sink.putBatch(batch.manifest, batch.ndjson);
      } catch (err) {
        const reasonCode = err instanceof PlatformError && /^[A-Z][A-Z0-9_]{2,63}$/.test(err.reasonCode) ? err.reasonCode : "AUDIT_SINK_PUT_FAILED";
        await this.recordSinkOutcome(reasonCode).catch(() => undefined);
        result.reasonCode = reasonCode;
        this.logger.warn("audit.ship.put_failed", { reasonCode, stream: sourceStream, manifestId: batch.manifest.manifestId });
        return result;
      }

      try {
        await this.markShipped(batch.manifest);
      } catch (err) {
        // The object is in the sink; the PLANNED record makes the next run re-put (no-op) and mark.
        result.reasonCode = err instanceof PlatformError ? err.reasonCode : "AUDIT_SHIP_MARK_FAILED";
        this.logger.warn("audit.ship.mark_failed", { reasonCode: result.reasonCode, stream: sourceStream });
        return result;
      }
      // Sink health bookkeeping must not turn a completed ship into a reported failure.
      await this.recordSinkOutcome(null).catch(() => undefined);
      result.batchesShipped += 1;
      result.eventsShipped += batch.manifest.eventCount;
      this.logger.info("audit.ship.batch_shipped", {
        stream: sourceStream,
        manifestId: batch.manifest.manifestId,
        eventCount: batch.manifest.eventCount,
      });
    }
    return result;
  }

  private tx<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return guardStorage("AUDIT_STORE_UNAVAILABLE", () => this.opts.db.tx(fn, { role: this.role }));
  }

  /** Returns the PLANNED batch to (re)ship, or plans the next one, or null when nothing is pending. */
  private async nextBatch(stream: string): Promise<{ manifest: AuditManifestType; ndjson: string } | null> {
    return this.tx(async (tx) => {
      const planned = await tx.query<ManifestRow>(
        `select manifest, status, last_sequence::text as last_sequence, last_hash from audit_manifests
          where source_stream = $1 and status = 'PLANNED' order by first_sequence limit 1`,
        [stream],
      );
      const plannedRow = planned.rows[0];
      if (plannedRow) {
        const parsedManifest = AuditManifest.safeParse(plannedRow.manifest);
        if (!parsedManifest.success) throw new AuditShipBlockedError("AUDIT_PLANNED_MANIFEST_INVALID");
        const manifest = parsedManifest.data;
        const events = await this.loadRange(tx, stream, manifest.firstSequence, manifest.lastSequence);
        const ndjson = toNdjson(events);
        if (events.length !== manifest.eventCount || batchDigestOf(ndjson) !== manifest.batchDigest) {
          throw new AuditShipBlockedError("AUDIT_PLANNED_BATCH_DIVERGED");
        }
        return { manifest, ndjson };
      }

      const prev = await tx.query<ManifestRow>(
        `select manifest, status, last_sequence::text as last_sequence, last_hash from audit_manifests
          where source_stream = $1 order by audit_manifests.last_sequence desc limit 1`,
        [stream],
      );
      const prevRow = prev.rows[0];
      const expectedSequence = prevRow ? toSafeInt(prevRow.last_sequence) + 1 : 1;
      const expectedPrevHash = prevRow ? prevRow.last_hash : null;

      const rows = await tx.query<OutboxRow>(
        `select sequence::text as sequence, event, hash, manifest_id from audit_outbox
          where source_stream = $1 and shipped_at is null order by audit_outbox.sequence limit $2`,
        [stream, this.batchSize],
      );
      if (rows.rows.length === 0) return null;
      const events = rows.rows.map((r) => this.parseRow(r));
      const firstEvent = events[0];
      if (!firstEvent) return null;
      if (firstEvent.sequence !== expectedSequence) throw new AuditShipBlockedError("AUDIT_CHAIN_GAP");

      // Ship only the contiguous, verified prefix; a gap or broken link stops here.
      const check = verifyChain(events, { sourceStream: stream, expectedSequence, expectedPrevHash });
      // A prevHash mismatch not explained by a gap means either this event or the one
      // before it was rewritten, so the preceding event is withheld as well.
      let usable = events.length;
      for (const f of check.findings) {
        const idx = events.findIndex((e) => e.sequence === f.sequence);
        if (idx < 0) continue;
        const explainedByGap = check.findings.some((g) => g.code === "SEQUENCE_GAP" && g.sequence === f.sequence);
        const cut = f.code === "PREV_HASH_MISMATCH" && !explainedByGap ? idx - 1 : idx;
        usable = Math.max(0, Math.min(usable, cut));
      }
      if (usable === 0) {
        throw new AuditShipBlockedError(check.findings.some((f) => f.code === "SEQUENCE_GAP") ? "AUDIT_CHAIN_GAP" : "AUDIT_CHAIN_BROKEN");
      }
      const batchEvents = events.slice(0, usable);
      const { manifest, ndjson } = buildManifest(batchEvents, { manifestId: newId("amf"), createdAt: iso(this.opts.clock.now()) });
      await tx.query(
        `insert into audit_manifests
           (manifest_id, source_stream, first_sequence, last_sequence, event_count, first_prev_hash, last_hash,
            batch_digest, object_key, manifest, sink_kind, status, planned_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, 'PLANNED', $12::timestamptz)`,
        [
          manifest.manifestId,
          manifest.sourceStream,
          manifest.firstSequence,
          manifest.lastSequence,
          manifest.eventCount,
          manifest.firstPrevHash,
          manifest.lastHash,
          manifest.batchDigest,
          manifest.objectKey,
          JSON.stringify(manifest),
          this.opts.sink.kind,
          manifest.createdAt,
        ],
      );
      return { manifest, ndjson };
    });
  }

  private parseRow(r: OutboxRow): AuditEventType {
    const parsed = AuditEvent.safeParse(r.event);
    if (!parsed.success || parsed.data.sequence !== toSafeInt(r.sequence) || parsed.data.hash !== r.hash) {
      throw new AuditShipBlockedError("AUDIT_CHAIN_BROKEN");
    }
    return parsed.data;
  }

  private async loadRange(tx: Queryable, stream: string, first: number, last: number): Promise<AuditEventType[]> {
    const r = await tx.query<OutboxRow>(
      `select sequence::text as sequence, event, hash, manifest_id from audit_outbox
        where source_stream = $1 and sequence between $2 and $3 order by audit_outbox.sequence`,
      [stream, first, last],
    );
    return r.rows.map((row) => this.parseRow(row));
  }

  private async markShipped(manifest: AuditManifestType): Promise<void> {
    const shippedAt = iso(this.opts.clock.now());
    await this.tx(async (tx) => {
      const updated = await tx.query(
        `update audit_outbox set shipped_at = $4::timestamptz, manifest_id = $5
          where source_stream = $1 and sequence between $2 and $3 and shipped_at is null`,
        [manifest.sourceStream, manifest.firstSequence, manifest.lastSequence, shippedAt, manifest.manifestId],
      );
      const already = await tx.query<{ n: unknown }>(
        `select count(*)::text as n from audit_outbox
          where source_stream = $1 and sequence between $2 and $3 and manifest_id = $4`,
        [manifest.sourceStream, manifest.firstSequence, manifest.lastSequence, manifest.manifestId],
      );
      const marked = toSafeInt(already.rows[0]?.n ?? 0);
      if (marked !== manifest.eventCount || updated.rowCount > manifest.eventCount) {
        throw new AuditShipBlockedError("AUDIT_SHIP_MARK_MISMATCH");
      }
      await tx.query(
        `update audit_manifests set status = 'SHIPPED', shipped_at = $2::timestamptz
          where manifest_id = $1 and status = 'PLANNED'`,
        [manifest.manifestId, shippedAt],
      );
    });
  }

  private async recordSinkOutcome(failureReason: string | null): Promise<void> {
    const at = iso(this.opts.clock.now());
    await this.tx(async (tx) => {
      if (failureReason === null) {
        await tx.query(
          `insert into audit_sink_status (sink_id, sink_kind, last_success_at, consecutive_failures)
           values ($1, $2, $3::timestamptz, 0)
           on conflict (sink_id) do update
             set sink_kind = excluded.sink_kind, last_success_at = excluded.last_success_at, consecutive_failures = 0`,
          [this.sinkId, this.opts.sink.kind, at],
        );
      } else {
        await tx.query(
          `insert into audit_sink_status (sink_id, sink_kind, last_failure_at, last_failure_reason, consecutive_failures)
           values ($1, $2, $3::timestamptz, $4, 1)
           on conflict (sink_id) do update
             set sink_kind = excluded.sink_kind, last_failure_at = excluded.last_failure_at,
                 last_failure_reason = excluded.last_failure_reason,
                 consecutive_failures = audit_sink_status.consecutive_failures + 1`,
          [this.sinkId, this.opts.sink.kind, at, failureReason],
        );
      }
    });
  }

  /**
   * Deletes the longest prefix of `stream` whose rows were shipped in manifests
   * already verified against the sink (IntegrityVerifier.verifyShipped with
   * markVerified). Uses the security-definer purge function; the S3 Object Lock
   * copy remains the retained evidence.
   */
  async purgeVerified(stream: string): Promise<{ purgedThroughSequence: number; deleted: number }> {
    if (!STREAM_NAME_RE.test(stream)) throw new ValidationError("AUDIT_STREAM_INVALID");
    return this.tx(async (tx) => {
      const wm = await tx.query<{ s: unknown }>(
        "select purged_through_sequence::text as s from audit_purge_watermarks where source_stream = $1",
        [stream],
      );
      let through = wm.rows[0] ? toSafeInt(wm.rows[0].s) : 0;
      const start = through;
      const ms = await tx.query<{ first_sequence: unknown; last_sequence: unknown }>(
        `select first_sequence::text as first_sequence, last_sequence::text as last_sequence from audit_manifests
          where source_stream = $1 and status = 'SHIPPED' and verified_at is not null and last_sequence > $2
          order by audit_manifests.first_sequence`,
        [stream, through],
      );
      for (const m of ms.rows) {
        if (toSafeInt(m.first_sequence) > through + 1) break;
        through = Math.max(through, toSafeInt(m.last_sequence));
      }
      if (through === start) return { purgedThroughSequence: through, deleted: 0 };
      const r = await tx.query<{ n: unknown }>("select audit_purge_verified($1, $2, $3::timestamptz) as n", [
        stream,
        through,
        iso(this.opts.clock.now()),
      ]);
      return { purgedThroughSequence: through, deleted: toSafeInt(r.rows[0]?.n ?? 0) };
    });
  }
}
