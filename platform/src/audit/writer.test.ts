import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PgliteDb } from "../db/pglite.js";
import { createMemoryLogger } from "../observability/logger.js";
import { FakeClock } from "../shared/clock.js";
import { AuditUnavailableError } from "../shared/errors.js";
import { verifyChain } from "./chain.js";
import { AuditWriterOutageFixture } from "./fixtures.js";
import { AuditEventInvalidError, pseudonymousSessionRef } from "./schema.js";
import { OTHER_TENANT_ID, TENANT_ID, countRows, createAuditTestDb, sampleAuditInput } from "./testing.js";
import { PgAuditWriter } from "./writer.js";
import type { AuditEvent } from "../protocol/index.js";
import { ValidationError } from "../shared/errors.js";

let db: PgliteDb;
let clock: FakeClock;

beforeEach(async () => {
  db = await createAuditTestDb();
  clock = new FakeClock();
  await db.exec(`
    create table synth_business_effects (id text primary key, tenant_id text not null);
    grant insert, select on synth_business_effects to app_runtime;
  `);
});
afterEach(async () => {
  await db.close();
});

const rls = { tenantId: TENANT_ID };

async function streamEvents(stream: string): Promise<AuditEvent[]> {
  const r = await db.tx((tx) => tx.query<{ event: AuditEvent }>("select event from audit_outbox where source_stream = $1 order by sequence", [stream]), {
    role: "owner",
  });
  return r.rows.map((x) => x.event);
}

describe("PgAuditWriter", () => {
  it("[OPS-01] appends inside the caller's transaction and commits atomically with the business change", async () => {
    const writer = new PgAuditWriter({ db, clock, stream: "actions.synth-1" });
    const ev = await db.tx(async (tx) => {
      await tx.query("insert into synth_business_effects (id, tenant_id) values ($1, $2)", ["eff_synthEffect0000001", TENANT_ID]);
      return writer.append(tx, sampleAuditInput(clock));
    }, { rls });
    expect(ev).toMatchObject({ sourceStream: "actions.synth-1", sequence: 1, prevHash: null, schemaVersion: "audit.v1" });
    expect(await countRows(db, "select count(*) as n from audit_outbox")).toBe(1);
    expect(await countRows(db, "select count(*) as n from synth_business_effects")).toBe(1);
  });

  it("[OPS-01] a caller rollback after append leaves neither the effect nor the audit event, and the sequence is reused", async () => {
    const writer = new PgAuditWriter({ db, clock, stream: "actions.synth-1" });
    await expect(
      db.tx(async (tx) => {
        await tx.query("insert into synth_business_effects (id, tenant_id) values ($1, $2)", ["eff_synthEffect0000001", TENANT_ID]);
        await writer.append(tx, sampleAuditInput(clock));
        throw new Error("BUSINESS_FAILURE_AFTER_AUDIT");
      }, { rls }),
    ).rejects.toThrow("BUSINESS_FAILURE_AFTER_AUDIT");
    expect(await countRows(db, "select count(*) as n from audit_outbox")).toBe(0);
    const next = await writer.appendStandalone(sampleAuditInput(clock));
    expect(next.sequence).toBe(1);
  });

  it("[OPS-01] audit store outage surfaces AuditUnavailableError and the caller's transaction rolls back", async () => {
    const { logger, records } = createMemoryLogger();
    const writer = new PgAuditWriter({ db, clock, stream: "actions.synth-1", logger });
    await db.exec("revoke insert on audit_outbox from app_runtime");
    const attempt = db.tx(async (tx) => {
      await tx.query("insert into synth_business_effects (id, tenant_id) values ($1, $2)", ["eff_synthEffect0000001", TENANT_ID]);
      await writer.append(tx, sampleAuditInput(clock));
      return "ACKNOWLEDGED";
    }, { rls });
    await expect(attempt).rejects.toBeInstanceOf(AuditUnavailableError);
    await expect(attempt).rejects.toMatchObject({ reasonCode: "AUDIT_STORE_UNWRITABLE", message: "AUDIT_STORE_UNWRITABLE" });
    expect(await countRows(db, "select count(*) as n from synth_business_effects")).toBe(0);
    // content-free failure log: no SQL, no event payload
    expect(records).toContainEqual({ level: "error", event: "audit.append.failed", fields: { component: "audit_writer", reasonCode: "AUDIT_STORE_UNWRITABLE", stream: "actions.synth-1" } });
    expect(JSON.stringify(records)).not.toContain("insert into");
  });

  it("[OPS-01] AuditWriterOutageFixture makes callers fail closed and roll back", async () => {
    const outage = new AuditWriterOutageFixture(new PgAuditWriter({ db, clock, stream: "actions.synth-1" }));
    outage.setOutage(true);
    await expect(
      db.tx(async (tx) => {
        await tx.query("insert into synth_business_effects (id, tenant_id) values ($1, $2)", ["eff_synthEffect0000001", TENANT_ID]);
        await outage.append(tx, sampleAuditInput(clock));
      }, { rls }),
    ).rejects.toMatchObject({ name: "AuditUnavailableError", reasonCode: "AUDIT_STORE_UNWRITABLE" });
    expect(await countRows(db, "select count(*) as n from synth_business_effects")).toBe(0);
    expect(outage.attemptsDuringOutage).toBe(1);
    outage.setOutage(false);
    expect((await outage.appendStandalone(sampleAuditInput(clock))).sequence).toBe(1);
  });

  it("[OPS-01] a missing or mismatched tenant context fails closed instead of writing cross-tenant evidence", async () => {
    const writer = new PgAuditWriter({ db, clock, stream: "actions.synth-1" });
    await expect(db.tx((tx) => writer.append(tx, sampleAuditInput(clock)), { rls: { tenantId: OTHER_TENANT_ID } })).rejects.toMatchObject({
      reasonCode: "AUDIT_TENANT_CONTEXT_MISMATCH",
    });
    await expect(db.tx((tx) => writer.append(tx, sampleAuditInput(clock)))).rejects.toMatchObject({ reasonCode: "AUDIT_TENANT_CONTEXT_MISMATCH" });
    expect(await countRows(db, "select count(*) as n from audit_outbox")).toBe(0);
  });

  it("[SPEC-13.4] assigns contiguous per-stream sequences with valid prevHash links", async () => {
    const writer = new PgAuditWriter({ db, clock, stream: "gateway.synth-a" });
    for (let i = 0; i < 5; i++) await writer.appendStandalone(sampleAuditInput(clock));
    await writer.appendStandalone(sampleAuditInput(clock), "gateway.synth-b");
    const a = await streamEvents("gateway.synth-a");
    expect(a.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(verifyChain(a, { sourceStream: "gateway.synth-a", expectedSequence: 1, expectedPrevHash: null }).findings).toEqual([]);
    const b = await streamEvents("gateway.synth-b");
    expect(b.map((e) => e.sequence)).toEqual([1]);
    const head = await db.tx((tx) => tx.query<{ s: string; h: string }>("select last_sequence::text as s, last_hash as h from audit_chain_heads where source_stream = 'gateway.synth-a'"), { role: "owner" });
    expect(head.rows[0]).toEqual({ s: "5", h: a[4]!.hash });
  });

  it("[SPEC-13.4] concurrent appends from two writer instances on one stream produce one contiguous, valid chain", async () => {
    const w1 = new PgAuditWriter({ db, clock, stream: "actions.shared" });
    const w2 = new PgAuditWriter({ db, clock, stream: "actions.shared" });
    await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 ? w1 : w2).appendStandalone(sampleAuditInput(clock))));
    const events = await streamEvents("actions.shared");
    expect(events.map((e) => e.sequence)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(verifyChain(events, { sourceStream: "actions.shared", expectedSequence: 1, expectedPrevHash: null }).findings).toEqual([]);
  });

  it("[SPEC-13.4] property: interleaved appends with random rollbacks across streams leave contiguous, valid chains", async () => {
    const writer = new PgAuditWriter({ db, clock, stream: "worker.prop" });
    await fc.assert(
      fc.asyncProperty(fc.array(fc.tuple(fc.constantFrom("worker.prop-a", "worker.prop-b", "worker.prop-c"), fc.boolean()), { minLength: 1, maxLength: 12 }), async (ops) => {
        await Promise.all(
          ops.map(([stream, rollback]) =>
            db
              .tx(async (tx) => {
                await writer.append(tx, sampleAuditInput(clock), stream);
                if (rollback) throw new Error("ROLLBACK");
              }, { rls })
              .catch((e: Error) => {
                if (e.message !== "ROLLBACK") throw e;
              }),
          ),
        );
        for (const s of ["worker.prop-a", "worker.prop-b", "worker.prop-c"]) {
          const events = await streamEvents(s);
          expect(events.map((e) => e.sequence)).toEqual(events.map((_, i) => i + 1));
          expect(verifyChain(events, { sourceStream: s, expectedSequence: 1, expectedPrevHash: null }).findings).toEqual([]);
        }
      }),
      { numRuns: 15 },
    );
  });

  it("[DATA-01] rejects invalid input before touching the database and stores the session ref only as a pseudonym", async () => {
    const writer = new PgAuditWriter({ db, clock, stream: "actions.synth-1" });
    await expect(writer.appendStandalone({ ...sampleAuditInput(clock), reasonCode: "free text reason" })).rejects.toBeInstanceOf(AuditEventInvalidError);
    await expect(
      writer.appendStandalone({ ...sampleAuditInput(clock), ...({ transcript: "synthetic words" } as object) } as ReturnType<typeof sampleAuditInput>),
    ).rejects.toBeInstanceOf(AuditEventInvalidError);
    expect(await countRows(db, "select count(*) as n from audit_chain_heads")).toBe(0);
    const input = sampleAuditInput(clock);
    const ev = await writer.appendStandalone(input);
    expect(ev.sessionRef).toBe(pseudonymousSessionRef(input.sessionRef!));
    const raw = await db.tx((tx) => tx.query<{ t: string }>("select event::text as t from audit_outbox"), { role: "owner" });
    expect(raw.rows[0]!.t).not.toContain(input.sessionRef!);
  });

  it("[SPEC-13.3] rejects events stamped beyond the allowed clock skew", async () => {
    const writer = new PgAuditWriter({ db, clock, stream: "actions.synth-1", maxFutureSkewSeconds: 60 });
    const future = new FakeClock("2026-10-17T15:02:00.000Z");
    await expect(writer.appendStandalone(sampleAuditInput(future))).rejects.toBeInstanceOf(ValidationError);
    await expect(writer.appendStandalone(sampleAuditInput(future))).rejects.toMatchObject({ reasonCode: "AUDIT_EVENT_TIMESTAMP_IN_FUTURE" });
  });

  it("[OPS-01] a role without audit privileges (app_auditor) cannot append and gets AuditUnavailableError", async () => {
    const writer = new PgAuditWriter({ db, clock, stream: "actions.synth-1" });
    await expect(db.tx((tx) => writer.append(tx, sampleAuditInput(clock)), { role: "app_auditor", rls })).rejects.toBeInstanceOf(AuditUnavailableError);
  });
});
