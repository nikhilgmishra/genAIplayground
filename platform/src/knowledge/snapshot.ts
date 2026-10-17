/**
 * Pinned knowledge snapshots (OPS-06). A snapshot names the exact set of
 * servable item versions (source id, version, digests) and is identified by a
 * version label `kb.<seq>.<digest prefix>` plus a sha256 digest. Snapshots are
 * append-only; a new one is written only when the servable set changes.
 * The digest is what ReleaseManifest.knowledgeSnapshotDigest pins; promoting a
 * snapshot beyond local/CI requires a KNOWLEDGE_RELEASE approval (PRQ-032).
 */
import type { Queryable } from "../db/types.js";
import { digestOf } from "../shared/canonical.js";

export interface SnapshotItem {
  sourceId: string;
  version: number;
  sourceSystem: string;
  contentDigest: string;
  itemDigest: string;
}

export interface ComputedSnapshot {
  digest: string;
  items: SnapshotItem[];
}

export async function computeSnapshot(tx: Queryable, tenantId: string): Promise<ComputedSnapshot> {
  const rows = await tx.query<{ source_id: string; version: number; source_system: string; content_digest: string; item_digest: string }>(
    `select source_id, version, source_system, content_digest, item_digest from knowledge_items
      where tenant_id = $1 and servable order by source_id, version`,
    [tenantId],
  );
  const items = rows.rows.map((r) => ({ sourceId: r.source_id, version: r.version, sourceSystem: r.source_system, contentDigest: r.content_digest, itemDigest: r.item_digest }));
  return { digest: digestOf({ schema: "knowledge-snapshot.v1", items }), items };
}

export async function persistSnapshotIfChanged(tx: Queryable, tenantId: string, snap: ComputedSnapshot, nowIso: string): Promise<{ version: string; digest: string; created: boolean }> {
  const latest = await tx.query<{ snapshot_seq: number; snapshot_version: string; snapshot_digest: string }>(
    "select snapshot_seq, snapshot_version, snapshot_digest from knowledge_snapshots where tenant_id = $1 order by snapshot_seq desc limit 1",
    [tenantId],
  );
  const prev = latest.rows[0];
  if (prev && prev.snapshot_digest === snap.digest) return { version: prev.snapshot_version, digest: prev.snapshot_digest, created: false };
  const seq = (prev?.snapshot_seq ?? 0) + 1;
  const version = `kb.${seq}.${snap.digest.slice(0, 12)}`;
  await tx.query(
    `insert into knowledge_snapshots (tenant_id, snapshot_seq, snapshot_version, snapshot_digest, item_count, items, created_at)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz)`,
    [tenantId, seq, version, snap.digest, snap.items.length, JSON.stringify(snap.items), nowIso],
  );
  return { version, digest: snap.digest, created: true };
}
