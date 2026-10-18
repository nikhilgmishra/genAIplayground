import { afterEach, describe, expect, it } from "vitest";
import { createTestDb } from "./testing.js";
import type { PgliteDb } from "./pglite.js";

let db: PgliteDb | undefined;
afterEach(async () => {
  await db?.close();
  db = undefined;
});

describe("db foundation", () => {
  it("applies migrations idempotently and exposes RLS context helpers", async () => {
    db = await createTestDb();
    const tenant = await db.tx(async (tx) => (await tx.query<{ t: string }>("select app_tenant() as t")).rows[0]?.t, {
      rls: { tenantId: "tnt_aaaaaaaaaaaaaaaaaaaa" },
    });
    expect(tenant).toBe("tnt_aaaaaaaaaaaaaaaaaaaa");
    const role = await db.tx(async (tx) => (await tx.query<{ r: string }>("select current_user as r")).rows[0]?.r);
    expect(role).toBe("app_runtime");
  });

  it("rolls back a failed transaction", async () => {
    db = await createTestDb();
    await db.exec("create table t_rb (id int primary key); grant all on t_rb to app_runtime;");
    await expect(
      db.tx(async (tx) => {
        await tx.query("insert into t_rb values (1)");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const n = await db.query<{ n: number }>("select count(*)::int as n from t_rb");
    expect(n.rows[0]?.n).toBe(0);
  });
});
