/**
 * Layer 2 (WP-04): local proofs that each fault-injection seam built for later packages produces its fault
 * through the real engine or emulator (docs/followon/work-packages.yaml WP-04 faultInjectionPoints). The
 * owning package's [FAULT:<id>] test drives the seam; these tests only prove the seam works:
 *   CONCURRENT_SAME_ACCOUNT (WP-25)   raceOnTwoConnections: two backends inside their transactions at once.
 *   CRASH_AFTER_COMMIT (WP-25)        killAfter: a process killed between two durable steps.
 *   LOCAL_PERSISTENCE_FAILURE (WP-15) readOnlyDatabase and throwawayPostgres (stopped), never the shared service.
 *   AUTH_EXPIRY_IDLE (WP-05)          dynamoSessionSeam: an idle session expires while DynamoDB still holds it.
 * AUTH_EXPIRY_MID_CALL (WP-07) is proven in dynamo.test.ts and DLQ_FULL (WP-07) in sqs.test.ts.
 */
import { GetItemCommand } from "@aws-sdk/client-dynamodb";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { PgPoolDb } from "../../../src/db/pg.js";
import { sessionRefHash } from "../../../src/identity/keys.js";
import { SessionInvalidError } from "../../../src/shared/errors.js";
import { newId } from "../../../src/shared/ids.js";
import { postgresUrl } from "../_harness/clients.js";
import { layer2, layer2Context } from "../_harness/layer2.js";
import { CHILD_DIR, killAfter, raceOnTwoConnections } from "./contention-harness.js";
import { dynamoSessionSeam, readOnlyDatabase, throwawayPostgres } from "./seams.js";
import { createAuroraLikeDb, sleep } from "./support.js";
import type { AuroraLikeDb } from "./support.js";

const it = layer2(["postgres", "dynamodb"]);
let adb: AuroraLikeDb;

describe("fault-injection seams produce their faults", () => {
  beforeAll(async () => {
    adb = await createAuroraLikeDb(layer2Context(["postgres", "dynamodb"]));
    await adb.migrator.exec("create table seam_race (k text primary key, by_pid integer not null)");
    await adb.migrator.exec("create table seam_steps (step integer not null)");
  });
  afterAll(async () => {
    await adb?.drop();
  });

  it("[FAULT:CONCURRENT_SAME_ACCOUNT seam] raceOnTwoConnections holds two backends inside their transactions together: both read the same snapshot, then collide on one key", async () => {
    const side = () => ({
      db: adb.migrator,
      opts: { role: "owner" as const },
      body: async (tx: Parameters<Parameters<typeof raceOnTwoConnections>[0]["body"]>[0], barrier: () => Promise<void>) => {
        const before = (await tx.query("select 1 from seam_race where k = 'account-1'")).rows.length;
        await barrier();
        const ins = await tx.query("insert into seam_race (k, by_pid) values ('account-1', pg_backend_pid()) on conflict (k) do nothing");
        return { before, inserted: ins.rowCount };
      },
    });
    const [a, b] = await raceOnTwoConnections(side(), side());
    expect(a.ok && b.ok).toBe(true);
    expect(a.backendPid).not.toBe(b.backendPid);
    if (!a.ok || !b.ok) throw new Error("race failed");
    expect([a.value.before, b.value.before], "both raced before either committed").toEqual([0, 0]);
    expect([a.value.inserted, b.value.inserted].sort()).toEqual([0, 1]);
    // A side that never arrives is a typed timeout, not a silent pass.
    const lone = await raceOnTwoConnections(
      { db: adb.migrator, opts: { role: "owner" }, body: async (_tx, barrier) => barrier() },
      { db: adb.migrator, opts: { role: "owner" }, body: async () => undefined },
      300,
    );
    expect(lone[0].ok).toBe(false);
    if (!lone[0].ok) expect(String(lone[0].error)).toMatch(/RACE_BARRIER_TIMEOUT/);
  });

  it("[FAULT:CRASH_AFTER_COMMIT seam] killAfter SIGKILLs a process between two durable steps: step 1 is committed, step 2 never happens", async () => {
    const run = await killAfter(join(CHILD_DIR, "seam-child.ts"), [], "STEP1_COMMITTED", "SIGKILL", { VSP_CHILD_DB_URL: postgresUrl(layer2Context(["postgres"]), adb.name), VSP_CHILD_TABLE: "seam_steps" });
    expect(run.exit.signal).toBe("SIGKILL");
    expect(run.lines).not.toContain("STEP2_COMMITTED");
    await sleep(500);
    expect((await adb.migrator.query<{ step: number }>("select step from seam_steps order by step")).rows).toEqual([{ step: 1 }]);
  });

  it("[FAULT:LOCAL_PERSISTENCE_FAILURE seam] readOnlyDatabase: new sessions refuse writes with SQLSTATE 25006 and still read; undo restores writes", async ({ l2 }) => {
    const undo = await readOnlyDatabase(l2, adb);
    const ro = adb.pool(1);
    try {
      await expect(ro.tx((tx) => tx.query("insert into audit_write_probe (probe_id, probed_at) values ('seam.ro', now())"), { role: "app_runtime" })).rejects.toMatchObject({ code: "25006" });
      expect((await ro.tx((tx) => tx.query("select 1 as one"), { role: "app_runtime" })).rows).toEqual([{ one: 1 }]);
    } finally {
      await ro.close();
      await undo();
    }
    const rw = adb.pool(1);
    await rw.tx((tx) => tx.query("insert into audit_write_probe (probe_id, probed_at) values ('seam.rw', now()) on conflict (probe_id) do update set probed_at = excluded.probed_at"), { role: "app_runtime" });
  });

  it("[FAULT:LOCAL_PERSISTENCE_FAILURE seam] throwawayPostgres: a test-owned postgres:16 container that is stopped surfaces as DependencyError DB_UNAVAILABLE (the shared service is untouched)", async () => {
    const pg = await throwawayPostgres();
    try {
      const db = PgPoolDb.fromConnectionString(pg.url, 1, { connectionTimeoutMillis: 2000 });
      await db.exec("create table t (x int)");
      await db.query("insert into t values (1)");
      await db.close();
      pg.stop();
      const after = PgPoolDb.fromConnectionString(pg.url, 1, { connectionTimeoutMillis: 2000 });
      await expect(after.query("insert into t values (2)")).rejects.toMatchObject({ reasonCode: "DB_UNAVAILABLE", outcome: "NOT_STARTED" });
      await after.close().catch(() => undefined);
    } finally {
      pg.remove();
    }
    // The shared service still answers.
    expect((await adb.migrator.query("select 1 as one")).rows).toEqual([{ one: 1 }]);
  }, 120_000);

  it("[FAULT:AUTH_EXPIRY_IDLE seam] an idle session (never touched after start) expires by the injected clock while DynamoDB still holds the item; resolve fails closed", async ({ l2 }) => {
    const s = await dynamoSessionSeam(l2, 300);
    const started = await s.sessions.startCall({ integration: s.telephony, callId: newId("call"), callerIdHash: null, consent: { recording: "UNKNOWN", automatedProcessing: "UNKNOWN", disclosureTemplateVersion: null, capturedAt: null, capturedBy: "none" } });
    s.clock.advanceSeconds(301);
    const item = await s.dynamo.send(new GetItemCommand({ TableName: s.table, Key: { pk: { S: `ses#${sessionRefHash(started.sessionRef)}` } }, ConsistentRead: true }));
    expect(item.Item, "the item is still stored").toBeDefined();
    await expect(s.sessions.resolve(started.sessionRef, s.mcp)).rejects.toBeInstanceOf(SessionInvalidError);
    await expect(s.sessions.resolve(started.sessionRef, s.mcp)).rejects.toMatchObject({ reasonCode: expect.stringMatching(/EXPIRED/) });
  });
});
