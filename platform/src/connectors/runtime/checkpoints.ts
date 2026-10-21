/**
 * Durable checkpoints and the incremental reader (WP-06; FO-06-09; ACT-02).
 *
 * `PgConnectorCheckpointStore` keeps the processed position of a stream in `connector_checkpoints`
 * (migration 2060). `advance` is a compare-and-set on the previous position digest, executed in the
 * caller's transaction: the records a page produced and the position after that page commit together.
 *
 * `IncrementalReader.runOnce` reads pages of a change-feed operation from the stored cursor:
 *   fetch page (no database transaction is held during vendor I/O)
 *   -> one transaction: apply(records) + advance(checkpoint)  [commit]
 *   -> repeat until caught up (an empty page with no position beyond the stored one) or the page bound.
 * A crash before the commit leaves neither the records nor the position (the page is read again); a
 * crash after it leaves both (the page is never read again): no gap, no duplicate projection. Two
 * readers of one stream cannot both advance from one position (CHECKPOINT_CONFLICT for the loser, its
 * transaction rolls back with its records). A stream must return a continuation cursor with every
 * non-empty page (a change-log position, replay id or sync token); otherwise it is not resumable and the
 * reader refuses it (PAGINATION_RESUME_CURSOR_MISSING) instead of re-reading or skipping records. A
 * non-empty page whose cursor equals the stored one is refused (PAGINATION_CURSOR_NOT_ADVANCING: nothing
 * projected, checkpoint unchanged). An empty page with an advanced cursor (a filtered feed) is not
 * "caught up": its position is committed on its own (recordsDelta 0) and reading continues from it.
 */
import type { Db, Queryable } from "../../db/types.js";
import { canonicalJson, sha256Hex } from "../../shared/canonical.js";
import type { Clock } from "../../shared/clock.js";
import { ConflictError, ValidationError } from "../../shared/errors.js";
import { newId } from "../../shared/ids.js";
import type { MappedRecord } from "../dsl/mapping.js";
import type { ConnectorRuntime, ExecuteInput } from "./connector.js";
import { ConnectorError } from "./errors.js";

export interface CheckpointKey {
  tenantId: string;
  profileId: string;
  streamId: string;
}

export interface Checkpoint extends CheckpointKey {
  cursor: string | null;
  replayId: string | null;
  watermark: string | null;
  positionDigest: string;
  recordsCommitted: number;
  pagesCommitted: number;
  mappingDigest: string | null;
  runId: string;
  updatedAt: string;
}

export interface CheckpointAdvance {
  cursor: string | null;
  replayId: string | null;
  watermark: string | null;
  recordsDelta: number;
  mappingDigest: string | null;
  runId: string;
}

interface Row {
  tenant_id: string;
  profile_id: string;
  stream_id: string;
  cursor: string | null;
  replay_id: string | null;
  watermark: Date | string | null;
  position_digest: string;
  records_committed: string | number;
  pages_committed: string | number;
  mapping_digest: string | null;
  run_id: string;
  updated_at: Date | string;
}

const iso = (v: Date | string | null): string | null => (v === null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString());

export function positionDigest(p: { cursor: string | null; replayId: string | null; watermark: string | null; recordsCommitted: number }): string {
  return sha256Hex(canonicalJson({ v: "connector-checkpoint.v1", c: p.cursor, r: p.replayId, w: p.watermark, n: p.recordsCommitted }));
}

function toCheckpoint(r: Row): Checkpoint {
  return {
    tenantId: r.tenant_id,
    profileId: r.profile_id,
    streamId: r.stream_id,
    cursor: r.cursor,
    replayId: r.replay_id,
    watermark: iso(r.watermark),
    positionDigest: r.position_digest,
    recordsCommitted: Number(r.records_committed),
    pagesCommitted: Number(r.pages_committed),
    mappingDigest: r.mapping_digest,
    runId: r.run_id,
    updatedAt: iso(r.updated_at) ?? "",
  };
}

const COLUMNS = "tenant_id, profile_id, stream_id, cursor, replay_id, watermark, position_digest, records_committed, pages_committed, mapping_digest, run_id, updated_at";

export class PgConnectorCheckpointStore {
  constructor(private readonly clock: Clock) {}

  async load(tx: Queryable, key: CheckpointKey): Promise<Checkpoint | null> {
    const r = await tx.query<Row>(`select ${COLUMNS} from connector_checkpoints where tenant_id = $1 and profile_id = $2 and stream_id = $3`, [key.tenantId, key.profileId, key.streamId]);
    return r.rows[0] ? toCheckpoint(r.rows[0]) : null;
  }

  /**
   * Moves the checkpoint from `expectedDigest` (null: no checkpoint yet) to the next position inside the
   * caller's transaction. Throws ConflictError CHECKPOINT_CONFLICT when another reader moved it first.
   */
  async advance(tx: Queryable, key: CheckpointKey, expectedDigest: string | null, prior: Checkpoint | null, next: CheckpointAdvance): Promise<Checkpoint> {
    if (!Number.isSafeInteger(next.recordsDelta) || next.recordsDelta < 0) throw new ValidationError("CHECKPOINT_DELTA_INVALID");
    const records = (prior?.recordsCommitted ?? 0) + next.recordsDelta;
    const pages = (prior?.pagesCommitted ?? 0) + 1;
    const digest = positionDigest({ cursor: next.cursor, replayId: next.replayId, watermark: next.watermark, recordsCommitted: records });
    const now = this.clock.now().toISOString();
    const r =
      expectedDigest === null
        ? await tx.query<Row>(
            `insert into connector_checkpoints (tenant_id, profile_id, stream_id, cursor, replay_id, watermark, position_digest, records_committed, pages_committed, mapping_digest, run_id, created_at, updated_at)
             values ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9, $10, $11, $12::timestamptz, $12::timestamptz)
             on conflict (tenant_id, profile_id, stream_id) do nothing
             returning ${COLUMNS}`,
            [key.tenantId, key.profileId, key.streamId, next.cursor, next.replayId, next.watermark, digest, records, pages, next.mappingDigest, next.runId, now],
          )
        : await tx.query<Row>(
            `update connector_checkpoints set cursor = $4, replay_id = $5, watermark = $6::timestamptz, position_digest = $7, records_committed = $8, pages_committed = $9,
                    mapping_digest = $10, run_id = $11, updated_at = $12::timestamptz
              where tenant_id = $1 and profile_id = $2 and stream_id = $3 and position_digest = $13
             returning ${COLUMNS}`,
            [key.tenantId, key.profileId, key.streamId, next.cursor, next.replayId, next.watermark, digest, records, pages, next.mappingDigest, next.runId, now, expectedDigest],
          );
    const row = r.rows[0];
    if (!row) throw new ConflictError("CHECKPOINT_CONFLICT");
    return toCheckpoint(row);
  }
}

export interface IncrementalReaderOptions {
  runtime: ConnectorRuntime;
  db: Db;
  store: PgConnectorCheckpointStore;
  tenantId: string;
  streamId: string;
  operationId: string;
  input?: ExecuteInput;
  /** Projects one page inside the checkpoint transaction (the reader's own transaction, role app_worker). */
  apply: (tx: Queryable, records: readonly MappedRecord[]) => Promise<void>;
  /** Target field holding each record's source update time (an instant): advances the watermark. */
  watermarkField?: string;
  /** Target field holding each record's vendor replay id. */
  replayIdField?: string;
}

export interface IncrementalRunResult {
  pages: number;
  records: number;
  completeness: "CAUGHT_UP" | "PAGE_LIMIT";
  checkpoint: Checkpoint | null;
}

export class IncrementalReader {
  private readonly key: CheckpointKey;

  constructor(private readonly opts: IncrementalReaderOptions) {
    const stream = (opts.runtime.profile.streams ?? []).find((s) => s.streamId === opts.streamId);
    if (!stream) throw new ValidationError("CHECKPOINT_STREAM_UNKNOWN");
    const op = opts.runtime.profile.operations.find((o) => o.operationId === opts.operationId);
    if (!op || op.responseObject !== stream.sourceObject) throw new ValidationError("CHECKPOINT_OPERATION_NOT_OF_STREAM");
    this.key = { tenantId: opts.tenantId, profileId: opts.runtime.profile.profileId, streamId: opts.streamId };
  }

  private txOpts() {
    return { role: "app_worker" as const, rls: { tenantId: this.opts.tenantId } };
  }

  async checkpoint(): Promise<Checkpoint | null> {
    return this.opts.db.tx((tx) => this.opts.store.load(tx, this.key), this.txOpts());
  }

  async runOnce(maxPages: number): Promise<IncrementalRunResult> {
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10_000) throw new ValidationError("CHECKPOINT_PAGE_BOUND_INVALID");
    let cp = await this.checkpoint();
    const runId = newId("run");
    let pages = 0;
    let records = 0;
    while (pages < maxPages) {
      const from = cp?.cursor ?? null;
      const page = await this.opts.runtime.page(this.opts.operationId, this.opts.input ?? {}, from);
      if (page.records.length === 0) {
        // Caught up: the vendor reports no position beyond the stored one.
        if (page.next === null || page.next === from) return { pages, records, completeness: "CAUGHT_UP", checkpoint: cp };
        // A filtered feed moved its position without returning records: persist the new position (nothing
        // to project) so the next page, and the next run, read from it instead of stalling before it.
        const prior = cp;
        cp = await this.opts.db.tx(
          (tx) =>
            this.opts.store.advance(tx, this.key, prior?.positionDigest ?? null, prior, {
              cursor: page.next,
              replayId: prior?.replayId ?? null,
              watermark: prior?.watermark ?? null,
              recordsDelta: 0,
              mappingDigest: page.mappingDigest,
              runId,
            }),
          this.txOpts(),
        );
        pages += 1;
        continue;
      }
      if (page.next === null) throw new ConnectorError("PAGINATION_RESUME_CURSOR_MISSING", "FAILED", this.opts.runtime.integrationId, this.opts.operationId, { retryable: false });
      // Records served with the position they were read from would be projected again on every page.
      if (page.next === from) throw new ConnectorError("PAGINATION_CURSOR_NOT_ADVANCING", "FAILED", this.opts.runtime.integrationId, this.opts.operationId, { retryable: false });
      const watermark = this.newestWatermark(page.records, cp?.watermark ?? null);
      const replayId = this.lastReplayId(page.records) ?? cp?.replayId ?? null;
      const prior = cp;
      cp = await this.opts.db.tx(async (tx) => {
        await this.opts.apply(tx, page.records);
        return this.opts.store.advance(tx, this.key, prior?.positionDigest ?? null, prior, {
          cursor: page.next,
          replayId,
          watermark,
          recordsDelta: page.records.length,
          mappingDigest: page.mappingDigest,
          runId,
        });
      }, this.txOpts());
      pages += 1;
      records += page.records.length;
    }
    return { pages, records, completeness: "PAGE_LIMIT", checkpoint: cp };
  }

  private newestWatermark(recs: readonly MappedRecord[], prior: string | null): string | null {
    const f = this.opts.watermarkField;
    if (!f) return prior;
    let best = prior === null ? null : Date.parse(prior);
    for (const r of recs) {
      const v = r.values[f];
      if (typeof v !== "string") continue;
      const t = Date.parse(v);
      if (Number.isFinite(t) && (best === null || t > best)) best = t;
    }
    return best === null ? null : new Date(best).toISOString();
  }

  private lastReplayId(recs: readonly MappedRecord[]): string | null {
    const f = this.opts.replayIdField;
    if (!f) return null;
    for (let i = recs.length - 1; i >= 0; i -= 1) {
      const v = recs[i]?.values[f];
      if (typeof v === "string" && /^[A-Za-z0-9:._/=+-]{1,255}$/.test(v)) return v;
    }
    return null;
  }
}
