/**
 * Stream ingestion into the same inbox (follow-on FO-03-26, FO-06-97, FO-07-17, FO-07-20): consume a
 * tenant's EXISTING stream (Kinesis, or Kafka/MSK through the same StreamSource port) without installing a
 * new broker.
 *
 * StreamIngestor, per partition (shard), at least once:
 *   1. reads records strictly after the committed position of inbox_stream_checkpoints (null: from the
 *      start of retention);
 *   2. classifies each record against the source's contracts and ACCEPTS it into the inbox (encrypted,
 *      deduplicated by (tenant, source, event id); event id from the envelope, else `<partition>:<position>`),
 *      with its stream position, under the platform's own IAM identity (auth mechanism STREAM_IAM);
 *   3. only after that commit advances the checkpoint to the record's position. A crash between the two
 *      re-reads the record, which the inbox absorbs as a duplicate. A record that fails to persist stops
 *      the partition (the checkpoint never moves past it);
 *   4. a record accepted as QUARANTINED (unknown type, schema or field) is recorded as an open gap of the
 *      checkpoint at once, and a record dead-lettered later is recorded by the processor: the watermark
 *      reports every position it moved past without applying, until an audited replay closes the gap.
 * Every run writes the checkpoint's heartbeat (source silence vs a broken feed is distinguished by
 * heartbeats and the source's own high position, never guessed) and the lag / open-gap gauges.
 *
 * KinesisStreamSource implements the port over the documented Kinesis Data Streams API (ListShards,
 * GetShardIterator AFTER_SEQUENCE_NUMBER / TRIM_HORIZON, GetRecords) through the narrow `KinesisApi`
 * surface; the composition binds it to @aws-sdk/client-kinesis (dependency requested from the phase
 * integration package; not in the workspace yet, so this adapter has no emulator run).
 */
import type { Db } from "../db/types.js";
import { silentLogger } from "../observability/logger.js";
import { noopMetrics } from "../observability/metrics.js";
import type { Logger, Metrics } from "../observability/ports.js";
import type { Clock } from "../shared/clock.js";
import { iso } from "../shared/clock.js";
import { PlatformError, ValidationError } from "../shared/errors.js";
import { newId } from "../shared/ids.js";
import { classify } from "./contracts.js";
import type { InboundContractRegistry } from "./contracts.js";
import type { PgInbox } from "./inbox.js";
import type { SourceProfile } from "./profile.js";

export interface StreamRecord {
  partition: string;
  /** Decimal position (Kinesis sequence number, Kafka offset); strictly increasing within a partition. */
  position: string;
  data: Buffer;
}

export interface StreamReadResult {
  records: StreamRecord[];
  /** Newest position the source reports for the partition, when it reports one. */
  highPosition: string | null;
  /** The partition is closed (resharded) and fully read. */
  closed: boolean;
}

export interface StreamSource {
  readonly kind: "live" | "local_fixture";
  partitions(): Promise<string[]>;
  read(partition: string, after: string | null, limit: number): Promise<StreamReadResult>;
}

const PARTITION = /^[A-Za-z0-9:._-]{1,128}$/;
const POSITION = /^[0-9]{1,39}$/;

export interface StreamIngestorOptions {
  db: Db;
  inbox: PgInbox;
  source: StreamSource;
  profile: SourceProfile;
  contracts: InboundContractRegistry;
  clock: Clock;
  batchSize?: number;
  logger?: Logger;
  metrics?: Metrics;
}

export interface StreamRunResult {
  partitions: number;
  accepted: number;
  duplicates: number;
  quarantined: number;
  /** Partitions stopped at a record that could not be persisted (checkpoint not advanced). */
  stopped: number;
}

export class StreamIngestor {
  private readonly logger: Logger;
  private readonly metrics: Metrics;
  private readonly batchSize: number;

  constructor(private readonly opts: StreamIngestorOptions) {
    if (opts.profile.verifier.kind !== "stream_iam") throw new ValidationError("INBOX_STREAM_PROFILE_INVALID");
    this.batchSize = opts.batchSize ?? 100;
    if (!Number.isSafeInteger(this.batchSize) || this.batchSize < 1 || this.batchSize > 10_000) throw new ValidationError("INBOX_STREAM_BATCH_INVALID");
    this.logger = (opts.logger ?? silentLogger).child({ component: "stream_ingestor" });
    this.metrics = opts.metrics ?? noopMetrics;
  }

  async runOnce(): Promise<StreamRunResult> {
    const { profile } = this.opts;
    const out: StreamRunResult = { partitions: 0, accepted: 0, duplicates: 0, quarantined: 0, stopped: 0 };
    let lag = 0n;
    let gaps = 0;
    for (const partition of await this.opts.source.partitions()) {
      if (!PARTITION.test(partition)) throw new ValidationError("INBOX_STREAM_PARTITION_INVALID");
      out.partitions += 1;
      const committed = await this.committed(partition);
      const read = await this.opts.source.read(partition, committed, this.batchSize);
      let last = committed;
      for (const rec of read.records) {
        if (!POSITION.test(rec.position) || rec.partition !== partition || (last !== null && BigInt(rec.position) <= BigInt(last))) {
          throw new ValidationError("INBOX_STREAM_RECORD_POSITION_INVALID");
        }
        const c0 = classify(rec.data, profile, this.opts.contracts);
        // A record without its own event id is identified by its stream position (stable across re-reads).
        const c = c0.eventId.startsWith("digest:") ? { ...c0, eventId: `${partition}:${rec.position}` } : c0;
        let accepted;
        try {
          accepted = await this.opts.inbox.accept({ profile, classification: c, rawBody: rec.data, auth: { mechanism: "STREAM_IAM", credentialVersion: null }, stream: { partition, position: rec.position } });
        } catch (err) {
          out.stopped += 1;
          this.logger.error("stream.persist_failed", { integration: profile.sourceId, reasonCode: err instanceof PlatformError ? err.reasonCode : "INBOX_PERSIST_FAILED" });
          break;
        }
        if (accepted.duplicate) out.duplicates += 1;
        else if (accepted.status === "QUARANTINED") out.quarantined += 1;
        else out.accepted += 1;
        await this.advance(partition, rec.position, read.highPosition, accepted.status === "QUARANTINED" && !accepted.duplicate ? { inboxId: accepted.inboxId, reason: `INBOX_QUARANTINED_${c.quarantine ?? "SCHEMA_VIOLATION"}` } : null);
        last = rec.position;
      }
      const state = await this.heartbeat(partition, read.highPosition);
      if (state) {
        if (state.sourceHigh !== null && BigInt(state.sourceHigh) > BigInt(state.committed)) lag += BigInt(state.sourceHigh) - BigInt(state.committed);
        gaps += state.openGaps;
      }
    }
    try {
      this.metrics.gauge("vsp_inbox_stream_lag", Number(lag > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : lag));
      this.metrics.gauge("vsp_inbox_stream_open_gaps", gaps);
    } catch {
      // metrics never change what is ingested
    }
    return out;
  }

  private async committed(partition: string): Promise<string | null> {
    const p = this.opts.profile;
    const r = await this.opts.db.tx(
      (tx) => tx.query<{ c: string }>("select committed_position::text as c from inbox_stream_checkpoints where tenant_id = $1 and source_id = $2 and stream_partition = $3", [p.tenantId, p.sourceId, partition]),
      { role: "app_worker", rls: { tenantId: p.tenantId } },
    );
    return r.rows[0]?.c ?? null;
  }

  private async advance(partition: string, position: string, sourceHigh: string | null, gap: { inboxId: string; reason: string } | null): Promise<void> {
    const p = this.opts.profile;
    const now = iso(this.opts.clock.now());
    await this.opts.db.tx(
      async (tx) => {
        if (gap) {
          await tx.query(
            `insert into inbox_stream_gaps (gap_id, tenant_id, source_id, stream_partition, stream_position, inbox_id, reason_code, opened_at)
             values ($1, $2, $3, $4, $5::numeric, $6, $7, $8::timestamptz) on conflict (tenant_id, source_id, stream_partition, stream_position) do nothing`,
            [newId("isg"), p.tenantId, p.sourceId, partition, position, gap.inboxId, gap.reason, now],
          );
        }
        await tx.query(
          `insert into inbox_stream_checkpoints (tenant_id, source_id, stream_partition, committed_position, low_watermark, high_watermark, source_high_position, open_gaps, heartbeat_at, updated_at)
           values ($1, $2, $3, $4::numeric, $4::numeric, $4::numeric, $5::numeric, 0, $6::timestamptz, $6::timestamptz)
           on conflict (tenant_id, source_id, stream_partition) do update
             set committed_position = greatest(inbox_stream_checkpoints.committed_position, excluded.committed_position),
                 high_watermark = greatest(inbox_stream_checkpoints.high_watermark, excluded.high_watermark),
                 source_high_position = coalesce(excluded.source_high_position, inbox_stream_checkpoints.source_high_position),
                 heartbeat_at = excluded.heartbeat_at, updated_at = excluded.updated_at`,
          [p.tenantId, p.sourceId, partition, position, sourceHigh, now],
        );
        await tx.query(
          `update inbox_stream_checkpoints set open_gaps = (select count(*) from inbox_stream_gaps g where g.tenant_id = $1 and g.source_id = $2 and g.stream_partition = $3 and g.closed_at is null)
            where tenant_id = $1 and source_id = $2 and stream_partition = $3`,
          [p.tenantId, p.sourceId, partition],
        );
      },
      { role: "app_worker", rls: { tenantId: p.tenantId } },
    );
  }

  private async heartbeat(partition: string, sourceHigh: string | null): Promise<{ committed: string; sourceHigh: string | null; openGaps: number } | null> {
    const p = this.opts.profile;
    const now = iso(this.opts.clock.now());
    const r = await this.opts.db.tx(
      (tx) =>
        tx.query<{ committed: string; source_high: string | null; open_gaps: number }>(
          `update inbox_stream_checkpoints set heartbeat_at = $4::timestamptz, source_high_position = coalesce($5::numeric, source_high_position),
                  open_gaps = (select count(*) from inbox_stream_gaps g where g.tenant_id = $1 and g.source_id = $2 and g.stream_partition = $3 and g.closed_at is null)
            where tenant_id = $1 and source_id = $2 and stream_partition = $3
           returning committed_position::text as committed, source_high_position::text as source_high, open_gaps`,
          [p.tenantId, p.sourceId, partition, now, sourceHigh],
        ),
      { role: "app_worker", rls: { tenantId: p.tenantId } },
    );
    const row = r.rows[0];
    return row ? { committed: row.committed, sourceHigh: row.source_high, openGaps: Number(row.open_gaps) } : null;
  }
}

/** Narrow surface of the Kinesis Data Streams API used by KinesisStreamSource (field names as in the AWS API). */
export interface KinesisApi {
  listShards(input: { StreamARN: string; NextToken?: string }): Promise<{ Shards?: { ShardId?: string }[]; NextToken?: string }>;
  getShardIterator(input: {
    StreamARN: string;
    ShardId: string;
    ShardIteratorType: "TRIM_HORIZON" | "AFTER_SEQUENCE_NUMBER";
    StartingSequenceNumber?: string;
  }): Promise<{ ShardIterator?: string }>;
  getRecords(input: { StreamARN: string; ShardIterator: string; Limit: number }): Promise<{
    Records?: { SequenceNumber?: string; Data?: Uint8Array }[];
    NextShardIterator?: string;
    MillisBehindLatest?: number;
  }>;
}

const STREAM_ARN = /^arn:aws:kinesis:[a-z0-9-]{4,32}:\d{12}:stream\/[A-Za-z0-9_.-]{1,128}$/;

/** Kinesis Data Streams source (kind "live"). One partition per shard; position = sequence number. */
export class KinesisStreamSource implements StreamSource {
  readonly kind = "live" as const;

  constructor(
    private readonly api: KinesisApi,
    private readonly streamArn: string,
  ) {
    if (!STREAM_ARN.test(streamArn)) throw new ValidationError("INBOX_KINESIS_STREAM_ARN_INVALID");
  }

  async partitions(): Promise<string[]> {
    const out: string[] = [];
    let next: string | undefined;
    for (let page = 0; page < 100; page++) {
      const r = await this.call(() => this.api.listShards(next ? { StreamARN: this.streamArn, NextToken: next } : { StreamARN: this.streamArn }));
      for (const s of r.Shards ?? []) if (s.ShardId && PARTITION.test(s.ShardId)) out.push(s.ShardId);
      next = r.NextToken;
      if (!next) break;
    }
    return out;
  }

  async read(partition: string, after: string | null, limit: number): Promise<StreamReadResult> {
    const it = await this.call(() =>
      this.api.getShardIterator(
        after
          ? { StreamARN: this.streamArn, ShardId: partition, ShardIteratorType: "AFTER_SEQUENCE_NUMBER", StartingSequenceNumber: after }
          : { StreamARN: this.streamArn, ShardId: partition, ShardIteratorType: "TRIM_HORIZON" },
      ),
    );
    if (!it.ShardIterator) return { records: [], highPosition: null, closed: true };
    const r = await this.call(() => this.api.getRecords({ StreamARN: this.streamArn, ShardIterator: it.ShardIterator as string, Limit: Math.min(10_000, limit) }));
    const records: StreamRecord[] = [];
    for (const rec of r.Records ?? []) {
      if (!rec.SequenceNumber || !POSITION.test(rec.SequenceNumber) || !(rec.Data instanceof Uint8Array)) throw new ValidationError("INBOX_KINESIS_RECORD_INVALID");
      records.push({ partition, position: rec.SequenceNumber, data: Buffer.from(rec.Data) });
    }
    return { records, highPosition: null, closed: r.NextShardIterator === undefined };
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof PlatformError) throw err;
      throw new PlatformError("INBOX_KINESIS_UNAVAILABLE", "INBOX_KINESIS_UNAVAILABLE", true);
    }
  }
}
