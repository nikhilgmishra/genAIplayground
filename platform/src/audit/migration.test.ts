import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PgliteDb } from "../db/pglite.js";
import type { DbRole } from "../db/types.js";
import { FakeClock } from "../shared/clock.js";
import { OTHER_TENANT_ID, TENANT_ID, countRows, createAuditTestDb, sampleAuditInput } from "./testing.js";
import { PgAuditWriter } from "./writer.js";

let db: PgliteDb;
let clock: FakeClock;
let writer: PgAuditWriter;

beforeEach(async () => {
  db = await createAuditTestDb();
  clock = new FakeClock();
  writer = new PgAuditWriter({ db, clock, stream: "actions.synth-1" });
  for (let i = 0; i < 3; i++) await writer.appendStandalone(sampleAuditInput(clock));
  await writer.appendStandalone(sampleAuditInput(clock, { tenantId: OTHER_TENANT_ID }), "actions.synth-other");
});
afterEach(async () => {
  await db.close();
});

const asRole = (role: DbRole, sql: string, params: unknown[] = [], tenantId = TENANT_ID) =>
  db.tx((tx) => tx.query(sql, params), { role, rls: { tenantId } });

describe("audit evidence migration: append-only enforcement", () => {
  it("[OPS-01] app_runtime cannot UPDATE audit rows", async () => {
    await expect(asRole("app_runtime", "update audit_outbox set outcome = 'FAILED' where sequence = 1")).rejects.toMatchObject({ code: "42501" });
    await expect(asRole("app_runtime", "update audit_outbox set shipped_at = now(), manifest_id = null")).rejects.toMatchObject({ code: "42501" });
  });

  it("[OPS-01] app_runtime cannot DELETE or TRUNCATE audit rows", async () => {
    await expect(asRole("app_runtime", "delete from audit_outbox")).rejects.toMatchObject({ code: "42501" });
    await expect(asRole("app_runtime", "truncate audit_outbox")).rejects.toMatchObject({ code: "42501" });
    await expect(asRole("app_runtime", "delete from audit_chain_heads")).rejects.toMatchObject({ code: "42501" });
    expect(await countRows(db, "select count(*) as n from audit_outbox")).toBe(4);
  });

  it("[OPS-01] the owner role cannot UPDATE, DELETE or TRUNCATE audit rows while triggers are active", async () => {
    await expect(asRole("owner", "update audit_outbox set outcome = 'FAILED' where sequence = 1")).rejects.toThrow("AUDIT_APPEND_ONLY");
    await expect(asRole("owner", "delete from audit_outbox where sequence = 1")).rejects.toThrow("AUDIT_APPEND_ONLY");
    await expect(asRole("owner", "truncate audit_outbox cascade")).rejects.toThrow("AUDIT_APPEND_ONLY");
    expect(await countRows(db, "select count(*) as n from audit_outbox")).toBe(4);
  });

  it("[OPS-01] app_runtime cannot forge, skip or rewind the chain directly", async () => {
    // Rewind the head
    await expect(asRole("app_runtime", "update audit_chain_heads set last_sequence = 1 where source_stream = 'actions.synth-1'")).rejects.toThrow(
      "AUDIT_CHAIN_HEAD_NOT_NEXT",
    );
    // Advance the head to a non-existent event
    await expect(
      asRole("app_runtime", "update audit_chain_heads set last_sequence = 4, last_hash = repeat('a', 64) where source_stream = 'actions.synth-1'"),
    ).rejects.toThrow("AUDIT_CHAIN_HEAD_UNBACKED");
    // Insert a head that does not start empty
    await expect(asRole("app_runtime", "insert into audit_chain_heads values ('forged.stream', 9, repeat('b', 64), now())")).rejects.toThrow(
      "AUDIT_CHAIN_HEAD_INVALID_START",
    );
    // Insert an event that skips a sequence number
    const ev = sampleAuditInput(clock);
    const forged = { ...ev, eventId: "aud_synthForgedEvent0001", schemaVersion: "audit.v1", sourceStream: "actions.synth-1", sequence: 9, prevHash: "c".repeat(64), hash: "d".repeat(64) };
    await expect(
      asRole(
        "app_runtime",
        `insert into audit_outbox (event_id, tenant_id, source_stream, sequence, prev_hash, hash, event, occurred_at, recorded_at, correlation_id, call_id, action, outcome, data_class)
         values ($1, $2, $3, 9, $4, $5, $6::jsonb, now(), now(), $7, $8, $9, $10, $11)`,
        [forged.eventId, TENANT_ID, forged.sourceStream, forged.prevHash, forged.hash, JSON.stringify(forged), ev.correlationId, ev.callId, ev.action, ev.outcome, ev.dataClass],
      ),
    ).rejects.toThrow("AUDIT_SEQUENCE_NOT_NEXT");
  });

  it("[OPS-01] the shipper role may set shipped_at/manifest_id exactly once and nothing else", async () => {
    await db.tx(
      (tx) =>
        tx.query(
          `insert into audit_manifests (manifest_id, source_stream, first_sequence, last_sequence, event_count, first_prev_hash, last_hash, batch_digest, object_key, manifest, sink_kind, status, planned_at)
           select 'amf_synthManifest000001', 'actions.synth-1', 1, 1, 1, null, hash, repeat('e', 64), 'actions.synth-1/000000000001-000000000001.ndjson',
                  jsonb_build_object('manifestId', 'amf_synthManifest000001', 'batchDigest', repeat('e', 64), 'objectKey', 'actions.synth-1/000000000001-000000000001.ndjson', 'sourceStream', 'actions.synth-1'),
                  'local_fixture', 'PLANNED', now()
             from audit_outbox where source_stream = 'actions.synth-1' and sequence = 1`,
        ),
      { role: "app_worker" },
    );
    await expect(asRole("app_worker", "update audit_outbox set outcome = 'FAILED' where sequence = 1")).rejects.toMatchObject({ code: "42501" });
    await expect(
      asRole("app_worker", "update audit_outbox set shipped_at = now(), manifest_id = 'amf_synthManifest000001' where source_stream = 'actions.synth-1' and sequence = 1"),
    ).resolves.toMatchObject({ rowCount: 1 });
    // second mark is refused (RLS hides shipped rows from the mark policy; trigger refuses as backstop)
    const again = await asRole("app_worker", "update audit_outbox set shipped_at = now(), manifest_id = 'amf_synthManifest000001' where source_stream = 'actions.synth-1' and sequence = 1");
    expect(again.rowCount).toBe(0);
    await expect(
      asRole("owner", "update audit_outbox set shipped_at = now() where source_stream = 'actions.synth-1' and sequence = 1"),
    ).rejects.toThrow("AUDIT_ALREADY_SHIPPED");
    await expect(asRole("app_runtime", "update audit_outbox set shipped_at = now(), manifest_id = 'amf_synthManifest000001' where sequence = 2")).rejects.toMatchObject({
      code: "42501",
    });
  });

  it("[OPS-01] app_worker cannot delete directly and the purge function refuses unshipped or unverified rows", async () => {
    await expect(asRole("app_worker", "delete from audit_outbox where sequence = 1")).rejects.toMatchObject({ code: "42501" });
    await expect(asRole("app_worker", "select audit_purge_verified('actions.synth-1', 2, now())")).rejects.toThrow("AUDIT_PURGE_PRECONDITION_FAILED");
    await expect(asRole("app_runtime", "select audit_purge_verified('actions.synth-1', 2, now())")).rejects.toMatchObject({ code: "42501" });
    await expect(asRole("app_auditor", "select audit_purge_verified('actions.synth-1', 2, now())")).rejects.toMatchObject({ code: "42501" });
    // setting the purge flag by hand grants nothing
    await expect(
      db.tx(async (tx) => {
        await tx.query("select set_config('vsp.audit_purge', 'authorized', true)");
        await tx.query("delete from audit_outbox where sequence = 1");
      }, { role: "app_worker" }),
    ).rejects.toMatchObject({ code: "42501" });
    expect(await countRows(db, "select count(*) as n from audit_outbox")).toBe(4);
  });

  it("[AUTH-02] app_auditor reads only the tenant-filtered metadata view and cannot write or read base tables", async () => {
    await expect(asRole("app_auditor", "select * from audit_outbox")).rejects.toMatchObject({ code: "42501" });
    await expect(asRole("app_auditor", "select * from audit_chain_heads")).rejects.toMatchObject({ code: "42501" });
    await expect(asRole("app_auditor", "insert into audit_write_probe values ('auditor.probe', now())")).rejects.toMatchObject({ code: "42501" });
    await expect(asRole("app_auditor", "update audit_event_metadata set outcome = 'FAILED'")).rejects.toMatchObject({ code: "42501" });
    await expect(asRole("app_auditor", "delete from audit_event_metadata")).rejects.toMatchObject({ code: "42501" });
    const mine = await asRole("app_auditor", "select tenant_id from audit_event_metadata");
    expect(mine.rows).toHaveLength(3);
    expect(new Set(mine.rows.map((r) => (r as { tenant_id: string }).tenant_id))).toEqual(new Set([TENANT_ID]));
    const other = await asRole("app_auditor", "select tenant_id from audit_event_metadata", [], OTHER_TENANT_ID);
    expect(other.rows).toHaveLength(1);
    const none = await db.tx((tx) => tx.query("select * from audit_event_metadata"), { role: "app_auditor" });
    expect(none.rows).toHaveLength(0);
  });

  it("[AUTH-05] app_runtime and app_console reads are tenant isolated", async () => {
    const rt = await asRole("app_runtime", "select tenant_id from audit_outbox");
    expect(rt.rows).toHaveLength(3);
    const rtOther = await asRole("app_runtime", "select tenant_id from audit_outbox", [], OTHER_TENANT_ID);
    expect(rtOther.rows).toHaveLength(1);
    await expect(asRole("app_console", "select * from audit_outbox")).rejects.toMatchObject({ code: "42501" });
    const console = await asRole("app_console", "select tenant_id from audit_event_metadata");
    expect(console.rows).toHaveLength(3);
  });

  it("[AUTH-05] RLS refuses an insert whose tenant differs from the transaction tenant", async () => {
    // A well-formed next link (so the chain trigger passes) that claims another tenant.
    const head = await db.tx((tx) => tx.query<{ h: string }>("select last_hash as h from audit_chain_heads where source_stream = 'actions.synth-1'"), { role: "owner" });
    const ev = sampleAuditInput(clock, { tenantId: OTHER_TENANT_ID });
    const doc = { ...ev, eventId: "aud_synthCrossTenant0001", schemaVersion: "audit.v1", sourceStream: "actions.synth-1", sequence: 4, prevHash: head.rows[0]!.h, hash: "b".repeat(64) };
    await expect(
      db.tx(
        (tx) =>
          tx.query(
            `insert into audit_outbox (event_id, tenant_id, source_stream, sequence, prev_hash, hash, event, occurred_at, recorded_at, correlation_id, call_id, action, outcome, data_class)
             values ($1, $2, 'actions.synth-1', 4, $3, $4, $5::jsonb, now(), now(), $6, $7, $8, $9, $10)`,
            [doc.eventId, OTHER_TENANT_ID, doc.prevHash, doc.hash, JSON.stringify(doc), ev.correlationId, ev.callId, ev.action, ev.outcome, ev.dataClass],
          ),
        { role: "app_runtime", rls: { tenantId: TENANT_ID } },
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("[SPEC-13.4] stored columns must mirror the hashed event document (check constraint)", async () => {
    await expect(
      db.tx(async (tx) => {
        await tx.query("set local session_replication_role = replica");
        await tx.query("update audit_outbox set outcome = 'FAILED' where source_stream = 'actions.synth-1' and sequence = 1");
      }, { role: "owner" }),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
