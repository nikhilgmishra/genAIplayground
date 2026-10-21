/**
 * Layer 2, FO-16-14: PostgreSQL 16 through the production PgPoolDb adapter, with the multi-connection
 * behaviour PGlite (one connection) cannot show: row locks that block and release, NOWAIT, SKIP LOCKED
 * work partitioning, serializable conflicts, deadlock detection and RLS per connection.
 * Rows are written by the production PgOutbox into the production schema (all migrations applied).
 */
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { listMigrations, migrate, MIGRATIONS_DIR } from "../../../src/db/migrate.js";
import type { PgPoolDb } from "../../../src/db/pg.js";
import type { Queryable } from "../../../src/db/types.js";
import { PgOutbox } from "../../../src/outbox/outbox.js";
import { systemClock } from "../../../src/shared/clock.js";
import { newId } from "../../../src/shared/ids.js";
import { createIntegrationDb } from "./clients.js";
import type { IntegrationDb } from "./clients.js";
import { layer2, layer2Context } from "./layer2.js";
import { scratchDir } from "./scratch.js";

const it = layer2(["postgres"]);
const TENANT = newId("tnt");
const OTHER_TENANT = newId("tnt");
const outbox = new PgOutbox({ clock: systemClock });

let idb: IntegrationDb;
let db: PgPoolDb;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Resolves with `promise`, or rejects with `message` when it has not settled within `ms`. */
async function within<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(message)), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => undefined as void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function enqueue(tenantId: string, n: number): Promise<string[]> {
  return db.tx(
    async (tx) => {
      const ids: string[] = [];
      for (let i = 0; i < n; i++) {
        ids.push(await outbox.enqueue(tx, { topic: "action.committed", key: `k:${newId("act")}`, payload: { actionId: newId("act") }, dedupeKey: `it:${newId("ddk")}` }));
      }
      return ids;
    },
    { role: "app_runtime", rls: { tenantId } },
  );
}

const asWorker = <T>(tenantId: string, fn: (tx: Queryable) => Promise<T>, isolation?: "serializable") =>
  db.tx(fn, { role: "app_worker", rls: { tenantId }, ...(isolation ? { isolation } : {}) });

describe("PostgreSQL 16 through PgPoolDb (multi-connection)", () => {
  beforeAll(async () => {
    idb = await createIntegrationDb(layer2Context(["postgres"]), 8);
    db = idb.db;
  });
  afterAll(async () => {
    await idb?.drop();
  });

  it("[FO-16-14] every production migration applies through PgPoolDb; a re-run is a no-op and a modified migration is refused", async () => {
    const applied = await db.query<{ name: string }>("select name from schema_migrations order by name");
    expect(applied.rows.map((r) => r.name)).toEqual(listMigrations().map((m) => m.name));
    expect(await migrate(db)).toEqual([]);
    const dir = scratchDir("vsp-it-migrations-");
    for (const m of listMigrations()) copyFileSync(join(MIGRATIONS_DIR, m.name), join(dir, m.name));
    const first = listMigrations()[1]?.name ?? "";
    writeFileSync(join(dir, first), `${readFileSync(join(dir, first), "utf8")}\n-- drift\n`);
    await expect(migrate(db, dir)).rejects.toThrow(/was modified after being applied/);
  });

  it("[FO-16-14] a row lock held by one connection blocks a second connection until commit, which then sees the committed update", async () => {
    const [messageId] = await enqueue(TENANT, 1);
    const holderLocked = deferred();
    const release = deferred();
    const pids: { holder?: number; waiter?: number } = {};
    let waiterStarted: () => void = () => undefined;
    const waiterHasConnection = new Promise<void>((r) => {
      waiterStarted = r;
    });
    const events: string[] = [];
    const backendPid = async (tx: Queryable) => Number((await tx.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]?.pid);
    const holder = asWorker(TENANT, async (tx) => {
      pids.holder = await backendPid(tx);
      await tx.query("select message_id from outbox_messages where message_id = $1 for update", [messageId]);
      holderLocked.resolve();
      await release.promise;
      await tx.query("update outbox_messages set attempts = attempts + 1 where message_id = $1", [messageId]);
      events.push("holder-commit");
    });
    let waiter: Promise<number | undefined> = Promise.resolve(undefined);
    let settled: PromiseSettledResult<unknown>[];
    try {
      await holderLocked.promise;
      waiter = asWorker(TENANT, async (tx) => {
        pids.waiter = await backendPid(tx);
        waiterStarted();
        const r = await tx.query<{ attempts: number }>("select attempts from outbox_messages where message_id = $1 for update", [messageId]);
        events.push("waiter-acquired");
        return r.rows[0]?.attempts;
      });
      // The waiter runs on its own server backend while the holder still holds the lock: a pool that
      // serializes both transactions on one connection never gets here.
      await within(waiterHasConnection, 5_000, "the waiter got no second connection while the holder held the row lock");
      expect(pids.waiter).not.toBe(pids.holder);
      // The server reports the waiter as blocked on a lock by exactly the holder's backend.
      const deadline = Date.now() + 4_000;
      let blocked: { blockers: number[]; wait_event_type: string | null } | undefined;
      while (Date.now() < deadline) {
        blocked = (
          await db.query<{ blockers: number[]; wait_event_type: string | null }>(
            "select pg_blocking_pids($1::int) as blockers, (select wait_event_type from pg_stat_activity where pid = $1::int) as wait_event_type",
            [pids.waiter],
          )
        ).rows[0];
        if ((blocked?.blockers.length ?? 0) > 0) break;
        await sleep(50);
      }
      expect(blocked).toEqual({ blockers: [pids.holder], wait_event_type: "Lock" });
      expect(events).toEqual([]);
    } finally {
      release.resolve();
      settled = await Promise.allSettled([holder, waiter]);
    }
    expect(settled).toEqual([
      { status: "fulfilled", value: undefined },
      { status: "fulfilled", value: 1 },
    ]);
    expect(events).toEqual(["holder-commit", "waiter-acquired"]);
  });

  it("[FO-16-14] FOR UPDATE NOWAIT on a locked row fails with lock_not_available (55P03) instead of waiting", async () => {
    const [messageId] = await enqueue(TENANT, 1);
    const locked = deferred();
    const release = deferred();
    const holder = asWorker(TENANT, async (tx) => {
      await tx.query("select 1 from outbox_messages where message_id = $1 for update", [messageId]);
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    await expect(asWorker(TENANT, (tx) => tx.query("select 1 from outbox_messages where message_id = $1 for update nowait", [messageId]))).rejects.toMatchObject({ code: "55P03" });
    release.resolve();
    await holder;
  });

  it("[FO-16-14] FOR UPDATE SKIP LOCKED partitions due rows between two concurrent claimers without overlap or blocking", async () => {
    const tenant = newId("tnt");
    await enqueue(tenant, 10);
    const firstLocked = deferred();
    const release = deferred();
    const claimSql = `select message_id from outbox_messages where tenant_id = $1 and status = 'PENDING'
                      order by created_at, message_id limit 5 for update skip locked`;
    const a = asWorker(tenant, async (tx) => {
      const r = await tx.query<{ message_id: string }>(claimSql, [tenant]);
      firstLocked.resolve();
      await release.promise;
      return r.rows.map((x) => x.message_id);
    });
    await firstLocked.promise;
    const t0 = Date.now();
    const b = await asWorker(tenant, async (tx) => (await tx.query<{ message_id: string }>(claimSql, [tenant])).rows.map((x) => x.message_id));
    expect(Date.now() - t0).toBeLessThan(2_000);
    release.resolve();
    const aRows = await a;
    expect(aRows).toHaveLength(5);
    expect(b).toHaveLength(5);
    expect(aRows.filter((id) => b.includes(id))).toEqual([]);
  });

  it("[FO-16-14] serializable transactions with a write-skew conflict: exactly one commits, the other fails with 40001", async () => {
    const tenant = newId("tnt");
    const bothRead = { n: 0, gate: deferred() };
    const attempt = () =>
      db.tx(
        async (tx) => {
          const c = await tx.query<{ c: string }>("select count(*)::text as c from outbox_messages where tenant_id = app_tenant()");
          bothRead.n += 1;
          if (bothRead.n === 2) bothRead.gate.resolve();
          await bothRead.gate.promise;
          if (Number(c.rows[0]?.c) === 0) await outbox.enqueue(tx, { topic: "action.committed", key: "k:singleton", payload: { kind: "SINGLETON" }, dedupeKey: `it:${newId("ddk")}` });
        },
        { role: "app_runtime", rls: { tenantId: tenant }, isolation: "serializable" },
      );
    const results = await Promise.allSettled([attempt(), attempt()]);
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: "40001" });
    const rows = await asWorker(tenant, (tx) => tx.query("select 1 from outbox_messages where tenant_id = app_tenant()"));
    expect(rows.rowCount).toBe(1);
  });

  it("[FO-16-14] opposite lock order across two connections is detected as a deadlock (40P01) and one transaction survives", async () => {
    const [m1, m2] = await enqueue(TENANT, 2);
    const bothHoldFirst = { n: 0, gate: deferred() };
    const lockBoth = (first: string | undefined, second: string | undefined) =>
      asWorker(TENANT, async (tx) => {
        await tx.query("select 1 from outbox_messages where message_id = $1 for update", [first]);
        bothHoldFirst.n += 1;
        if (bothHoldFirst.n === 2) bothHoldFirst.gate.resolve();
        await bothHoldFirst.gate.promise;
        await tx.query("select 1 from outbox_messages where message_id = $1 for update", [second]);
      });
    const results = await Promise.allSettled([lockBoth(m1, m2), lockBoth(m2, m1)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "40P01" });
  });

  it("[FO-16-14] row-level security holds per connection: another tenant's rows are invisible and cannot be updated", async () => {
    const [mine] = await enqueue(TENANT, 1);
    const seen = await asWorker(OTHER_TENANT, (tx) => tx.query("select 1 from outbox_messages where message_id = $1", [mine]));
    expect(seen.rowCount).toBe(0);
    const updated = await asWorker(OTHER_TENANT, (tx) => tx.query("update outbox_messages set attempts = 99 where message_id = $1", [mine]));
    expect(updated.rowCount).toBe(0);
    const own = await asWorker(TENANT, (tx) => tx.query<{ attempts: number }>("select attempts from outbox_messages where message_id = $1", [mine]));
    expect(own.rows[0]?.attempts).toBe(0);
  });
});
