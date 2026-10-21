/**
 * Connector change-feed sync of the live worker (WP-07; FO-17-24.DLQ_FULL, FO-21-10; ACT-02, OPS-01, DATA-01).
 *
 * One configured feed (PlatformConfig.connectors.feeds) is read with the WP-06 IncrementalReader: each page is
 * projected and its checkpoint advanced in ONE transaction. The projection here is the content-free feed index
 * (migration 2071 connector_feed_index): one row per record key (its keyed digest) with the source update
 * time. A record the sync cannot project (no usable key) is dead-lettered with a content-free envelope
 * (schema, tenant, profile, stream, the record's keyed digest and a reason code; never record values). Dead
 * letters are at-least-once: a page that is rolled back after one of its records was dead-lettered
 * dead-letters that record again on the retry; the record digest (and the FIFO deduplication id) identifies
 * the duplicates.
 *
 * Keyed digests (DP-02 pattern, DATA-01): record keys are low-entropy (a record number, an appointment number),
 * so a plain SHA-256 of one could be reversed by enumerating the key space. Both digests are HMAC-SHA256 under
 * a per-environment key (FeedDigester), derived with HKDF from the environment's request-hash pepper (Secrets
 * Manager, `infrastructure.secrets.requestHashPepperRef`) under its own label, so it is independent of the
 * pepper's other use; without the key the digests cannot be recomputed from a guessed key.
 *
 * [FAULT:DLQ_FULL]: when the dead-letter write is refused (DLQ_WRITE_REFUSED: queue full, missing or the message
 * over its size), the page transaction throws and rolls back, so neither the index rows nor the checkpoint
 * advance: nothing is dropped and the next run starts from the kept checkpoint. Consumption of that feed stops
 * (the run reports STOPPED with the reason code), vsp_connector_feed_dead_letter_refused_total counts it and
 * the error-level log event `connectors.feed.dead_letter_refused` is written; both feed the paging alarm rule
 * `connector-feed-dead-letter-refused` (observability/alarms.ts).
 */
import { createHmac, hkdfSync } from "node:crypto";
import type { MappedRecord } from "../../connectors/dsl/mapping.js";
import type { IncrementalReader } from "../../connectors/runtime/checkpoints.js";
import type { Queryable } from "../../db/types.js";
import { silentLogger } from "../../observability/logger.js";
import type { Logger, Metrics } from "../../observability/ports.js";
import type { Clock } from "../../shared/clock.js";
import { iso } from "../../shared/clock.js";
import { PlatformError } from "../../shared/errors.js";
import { newId } from "../../shared/ids.js";

export const CONNECTOR_FEED_DEAD_LETTER_SCHEMA = "vsp.connector-feed-dead-letter.v1";

/** The dead-letter queue writer (outbox/sqs-dlq.ts SqsDeadLetterWriter satisfies it). */
export interface FeedDeadLetterWriter {
  write(body: string, attributes: { reasonCode: string; groupId?: string; deduplicationId?: string }): Promise<string>;
}

/** HKDF labels of the feed digest key (never reused for another purpose). */
const FEED_DIGEST_SALT = "vsp.connector-feed";
const FEED_DIGEST_INFO = "vsp.connector-feed.digest.v1";
const MIN_KEY_BYTES = 32;

/**
 * Keyed digests of the connector feed (HMAC-SHA256). Holds the key privately; exposes digests only.
 * `recordKey` identifies an index row, `record` a dead-lettered record (envelope and FIFO deduplication id).
 */
export class FeedDigester {
  private readonly key: Buffer;

  constructor(key: Uint8Array) {
    if (!(key instanceof Uint8Array) || key.length < MIN_KEY_BYTES) throw new TypeError("CONNECTOR_FEED_DIGEST_KEY_INVALID");
    this.key = Buffer.from(key);
  }

  /** The feed digest key derived from the environment's request-hash pepper (HKDF-SHA256, own label). */
  static fromPepper(pepper: Uint8Array): FeedDigester {
    if (!(pepper instanceof Uint8Array) || pepper.length < MIN_KEY_BYTES) throw new TypeError("CONNECTOR_FEED_DIGEST_KEY_INVALID");
    return new FeedDigester(Buffer.from(hkdfSync("sha256", pepper, Buffer.from(FEED_DIGEST_SALT, "utf8"), Buffer.from(FEED_DIGEST_INFO, "utf8"), 32)));
  }

  private mac(parts: readonly string[]): string {
    // NUL-separated fields: no field contains NUL (ids are opaque, keys match KEY), so the encoding is unambiguous.
    return createHmac("sha256", this.key).update(parts.join("\u0000"), "utf8").digest("hex");
  }

  /** Digest of a record key within its feed (connector_feed_index.record_key_digest). */
  recordKey(scope: { tenantId: string; profileId: string; streamId: string }, key: string): string {
    return this.mac(["record-key", scope.tenantId, scope.profileId, scope.streamId, key]);
  }

  /** Canonical digest of a mapped record's values (stable key order); identifies it without its content. */
  record(scope: { tenantId: string; profileId: string; streamId: string }, r: MappedRecord): string {
    const keys = Object.keys(r.values).sort();
    return this.mac(["record", scope.tenantId, scope.profileId, scope.streamId, JSON.stringify(keys.map((k) => [k, r.values[k] ?? null]))]);
  }
}

export interface ConnectorFeedSyncOptions {
  /** The reader over the feed (its `apply` must be this sync's `project`; see `ConnectorFeedSync.readerApply`). */
  reader: Pick<IncrementalReader, "runOnce" | "checkpoint">;
  /** Keyed digests (per-environment key): index rows and dead-letter envelopes never carry a plain hash. */
  digester: FeedDigester;
  deadLetters: FeedDeadLetterWriter;
  tenantId: string;
  profileId: string;
  streamId: string;
  /** Target field of the mapping that holds the record's stable key. */
  keyField: string;
  /** Target field that holds the record's source update time (an instant), when the mapping has one. */
  updatedAtField?: string | null;
  maxPagesPerRun: number;
  clock: Clock;
  metrics?: Metrics | null;
  logger?: Logger;
}

export interface FeedRunResult {
  result: "caught_up" | "page_limit" | "stopped";
  pages: number;
  records: number;
  indexed: number;
  deadLettered: number;
  reasonCode: string | null;
}

const KEY = /^[A-Za-z0-9:._/=+-]{1,255}$/;
const OPAQUE = /^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$/;

export class ConnectorFeedSync {
  private readonly logger: Logger;
  private runId = newId("run");
  private counts = { indexed: 0, deadLettered: 0 };

  constructor(private readonly o: ConnectorFeedSyncOptions) {
    if (!OPAQUE.test(o.tenantId)) throw new TypeError("CONNECTOR_FEED_TENANT_INVALID");
    if (!/^[a-z][a-zA-Z0-9_.]{0,63}$/.test(o.keyField)) throw new TypeError("CONNECTOR_FEED_KEY_FIELD_INVALID");
    if (!Number.isInteger(o.maxPagesPerRun) || o.maxPagesPerRun < 1 || o.maxPagesPerRun > 1_000) throw new TypeError("CONNECTOR_FEED_PAGE_BOUND_INVALID");
    this.logger = (o.logger ?? silentLogger).child({ component: "connector_feed" });
  }

  private count(name: string, labels?: Record<string, string>, value?: number): void {
    try {
      this.o.metrics?.increment(name, labels, value);
    } catch {
      // metrics never change what the sync does
    }
  }

  /**
   * The IncrementalReader `apply` of this feed: indexes projectable records and dead-letters the others, inside
   * the reader's page transaction. A refused dead-letter write throws, which rolls the page (and its
   * checkpoint) back.
   */
  readonly project = async (tx: Queryable, records: readonly MappedRecord[]): Promise<void> => {
    const now = iso(this.o.clock.now());
    let indexed = 0;
    let deadLettered = 0;
    for (const r of records) {
      const key = r.values[this.o.keyField];
      if (typeof key !== "string" || !KEY.test(key)) {
        const digest = this.o.digester.record(this.o, r);
        const envelope = JSON.stringify({
          schema: CONNECTOR_FEED_DEAD_LETTER_SCHEMA,
          tenantId: this.o.tenantId,
          profileId: this.o.profileId,
          streamId: this.o.streamId,
          recordDigest: digest,
          reasonCode: "FEED_RECORD_KEY_MISSING",
          deadLetteredAt: now,
        });
        // Throws DLQ_WRITE_REFUSED when the queue refuses: the page transaction rolls back (DLQ_FULL).
        await this.o.deadLetters.write(envelope, { reasonCode: "FEED_RECORD_KEY_MISSING", groupId: this.o.streamId, deduplicationId: digest.slice(0, 64) });
        deadLettered += 1;
        continue;
      }
      const updated = this.o.updatedAtField ? r.values[this.o.updatedAtField] : null;
      const updatedAt = typeof updated === "string" && Number.isFinite(Date.parse(updated)) ? new Date(updated).toISOString() : null;
      await tx.query(
        `insert into connector_feed_index (tenant_id, profile_id, stream_id, record_key_digest, source_updated_at, first_seen_at, last_seen_at, last_run_id)
         values ($1, $2, $3, $4, $5, $6, $6, $7)
         on conflict (tenant_id, profile_id, stream_id, record_key_digest)
         do update set source_updated_at = greatest(connector_feed_index.source_updated_at, excluded.source_updated_at), last_seen_at = excluded.last_seen_at, last_run_id = excluded.last_run_id`,
        [this.o.tenantId, this.o.profileId, this.o.streamId, this.o.digester.recordKey(this.o, key), updatedAt, now, this.runId],
      );
      indexed += 1;
    }
    // Counted once the whole page applied (a page whose dead-letter write is refused adds nothing). The reader
    // commits right after; a checkpoint conflict at that commit (another reader advanced first) is the only
    // case where a counted page does not commit.
    this.counts.indexed += indexed;
    this.counts.deadLettered += deadLettered;
  };

  /** The feed's committed checkpoint (the reader's own read; operations and the DLQ_FULL evidence). */
  checkpoint(): ReturnType<IncrementalReader["checkpoint"]> {
    return this.o.reader.checkpoint();
  }

  /** One bounded run. Never throws: a stop is reported with its reason code and the checkpoint is kept. */
  async runOnce(): Promise<FeedRunResult> {
    this.runId = newId("run");
    this.counts = { indexed: 0, deadLettered: 0 };
    try {
      const r = await this.o.reader.runOnce(this.o.maxPagesPerRun);
      const result = r.completeness === "CAUGHT_UP" ? "caught_up" : "page_limit";
      this.count("vsp_connector_feed_runs_total", { result });
      if (this.counts.indexed > 0) this.count("vsp_connector_feed_records_total", { result: "indexed" }, this.counts.indexed);
      if (this.counts.deadLettered > 0) this.count("vsp_connector_feed_records_total", { result: "dead_lettered" }, this.counts.deadLettered);
      return { result, pages: r.pages, records: r.records, indexed: this.counts.indexed, deadLettered: this.counts.deadLettered, reasonCode: null };
    } catch (err) {
      const reasonCode = err instanceof PlatformError && /^[A-Z][A-Z0-9_]{2,63}$/.test(err.reasonCode) ? err.reasonCode : "CONNECTOR_FEED_FAILED";
      this.count("vsp_connector_feed_runs_total", { result: "stopped" });
      if (reasonCode === "DLQ_WRITE_REFUSED") {
        this.count("vsp_connector_feed_dead_letter_refused_total");
        this.logger.error("connectors.feed.dead_letter_refused", { reasonCode, stream: this.o.streamId });
      } else {
        this.logger.warn("connectors.feed.stopped", { reasonCode, stream: this.o.streamId });
      }
      // The committed pages of this run are real; the refused page and everything after it were not applied.
      return { result: "stopped", pages: 0, records: 0, indexed: this.counts.indexed, deadLettered: this.counts.deadLettered, reasonCode };
    }
  }
}
