/**
 * Layer 2 (WP-04): PgPoolDb, the production Aurora adapter, against postgres:16 with pgvector, provisioned
 * as on Aurora (non-superuser owner, separate application login; support.ts).
 *
 * FO-16-03 migrations (ordered, checksum-guarded, as a non-superuser owner; grants and RLS asserted through
 * catalog queries), FO-03-21 (PostgreSQL 16 + pgvector; the inbox and journal tables), FO-19-07a (RLS across
 * connections, SERIALIZABLE retry, pool exhaustion), FO-15-28 / FO-15-42 (database role separation),
 * FO-15-33 (the audit, ingress, outbox and db unit suites re-run unchanged on postgres:16 through the
 * VSP_TEST_DB=pg switch of createTestDb).
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { listMigrations, migrate } from "../../../src/db/migrate.js";
import { PgPoolDb } from "../../../src/db/pg.js";
import { DependencyError } from "../../../src/shared/errors.js";
import { newId } from "../../../src/shared/ids.js";
import { postgresUrl } from "../_harness/clients.js";
import { PLATFORM_ROOT } from "../_harness/env.js";
import { layer2, layer2Context } from "../_harness/layer2.js";
import { scratchDir } from "../_harness/scratch.js";
import { createAuroraLikeDb, latch, RUNTIME_ROLES, sleep } from "./support.js";
import type { AuroraLikeDb } from "./support.js";

const it = layer2(["postgres"]);
let adb: AuroraLikeDb;

const reason = (p: Promise<unknown>) =>
  p.then(
    () => "RESOLVED",
    (e: { reasonCode?: string; code?: string; message?: string }) => e.reasonCode ?? e.code ?? e.message ?? "ERROR",
  );

describe("PgPoolDb on postgres:16 provisioned as on Aurora", () => {
  beforeAll(async () => {
    adb = await createAuroraLikeDb(layer2Context(["postgres"]));
  });
  afterAll(async () => {
    await adb?.drop();
  });

  it("[FO-16-03][FO-03-21] every migration applies in order as a NON-superuser owner, checksums are recorded, a re-run is a no-op, pgvector is present", async () => {
    const who = await adb.migrator.query<{ super: boolean; createrole: boolean }>("select rolsuper as super, rolcreaterole as createrole from pg_roles where rolname = current_user");
    expect(who.rows[0]).toEqual({ super: false, createrole: true });
    const applied = await adb.migrator.query<{ name: string; checksum: string }>("select name, checksum from schema_migrations order by name");
    expect(applied.rows).toEqual(listMigrations().map((m) => ({ name: m.name, checksum: m.checksum })));
    expect(applied.rows.map((r) => r.name)).toEqual(expect.arrayContaining(["2040_route_audit_journal.sql", "2041_inbound_inbox.sql", "2042_audit_verifier_role.sql"]));
    expect(await migrate(adb.migrator)).toEqual([]);
    const ext = await adb.migrator.query<{ extname: string }>("select extname from pg_extension where extname = 'vector'");
    expect(ext.rows).toHaveLength(1);
    // The application login is not the owner and owns nothing.
    const owner = await adb.db.query<{ owns: boolean }>("select exists (select 1 from pg_class c join pg_roles r on r.oid = c.relowner where r.rolname = current_user) as owns");
    expect(owner.rows[0]?.owns).toBe(false);
  });

  it("[FO-16-03][FO-03-21][DATA-01] the new inbox and journal tables have forced row-level security and append-only triggers (catalog)", async () => {
    const tables = ["audit_deferred", "route_audit_intents", "route_audit_reconciliations", "inbound_events", "inbound_deliveries", "inbound_replays", "inbox_projection_versions", "inbox_stream_checkpoints", "inbox_stream_gaps"];
    const rls = await adb.db.query<{ relname: string; on: boolean; forced: boolean }>(
      "select relname, relrowsecurity as on, relforcerowsecurity as forced from pg_class where relname = any($1::text[]) order by relname",
      [tables],
    );
    expect(rls.rows).toHaveLength(tables.length);
    expect(rls.rows.every((r) => r.on && r.forced)).toBe(true);
    const policies = await adb.db.query<{ tablename: string }>("select distinct tablename from pg_policies where tablename = any($1::text[]) order by 1", [tables]);
    expect(policies.rows.map((r) => r.tablename).sort()).toEqual([...tables].sort());
    const triggers = await adb.db.query<{ tgname: string }>("select tgname from pg_trigger where tgrelid in ('audit_deferred'::regclass, 'inbound_events'::regclass, 'inbox_projection_versions'::regclass) and not tgisinternal order by 1");
    expect(triggers.rows.map((r) => r.tgname)).toEqual(
      expect.arrayContaining(["audit_deferred_guard", "audit_deferred_no_delete", "inbound_events_guard", "inbound_events_no_delete", "inbox_projection_versions_guard"]),
    );
  });

  it("[FO-15-28][FO-15-42][OPS-01] database roles are separated: the verifier and auditor read and cannot write; writers cannot rewrite or read evidence beyond their tenant; nobody truncates", async () => {
    const priv = async (role: string, table: string, p: string) =>
      (await adb.db.query<{ ok: boolean }>("select has_table_privilege($1, $2, $3) as ok", [role, table, p])).rows[0]?.ok;
    const auditTables = ["audit_outbox", "audit_chain_heads", "audit_manifests", "audit_purge_watermarks"];
    for (const t of auditTables) {
      expect(await priv("app_audit_verifier", t, "SELECT"), `verifier reads ${t}`).toBe(true);
      for (const p of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"]) expect(await priv("app_audit_verifier", t, p), `verifier ${p} ${t}`).toBe(false);
      for (const p of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"]) expect(await priv("app_auditor", t, p), `auditor ${p} ${t}`).toBe(false);
      for (const r of ["app_runtime", "app_worker", "app_console"]) {
        expect(await priv(r, t, "DELETE"), `${r} DELETE ${t}`).toBe(false);
        expect(await priv(r, t, "TRUNCATE"), `${r} TRUNCATE ${t}`).toBe(false);
      }
    }
    // Writers append evidence but never read the manifests (the auditor and verifier do).
    expect(await priv("app_runtime", "audit_manifests", "SELECT")).toBe(false);
    expect(await priv("app_console", "audit_outbox", "SELECT")).toBe(false);
    // Through the application login, over separate connections: the verifier role cannot even mark a manifest verified.
    expect(await reason(adb.db.tx((tx) => tx.query("update audit_manifests set verified_at = now()"), { role: "app_audit_verifier" }))).toBe("42501");
    expect(await reason(adb.db.tx((tx) => tx.query("insert into audit_write_probe (probe_id, probed_at) values ('x.verifier', now())"), { role: "app_audit_verifier" }))).toBe("42501");
    expect(await reason(adb.db.tx((tx) => tx.query("delete from audit_outbox"), { role: "app_runtime", rls: { tenantId: newId("tnt") } }))).toBe("42501");
    for (const r of RUNTIME_ROLES) {
      const member = await adb.db.query<{ ok: boolean }>("select pg_has_role(current_user, $1, 'MEMBER') as ok", [r]);
      expect(member.rows[0]?.ok, `application login is a member of ${r}`).toBe(true);
    }
  });

  it("[FO-19-07a][FO-03-21][AUTH-02] row-level security holds per connection: another tenant's inbox rows are invisible from a second pool", async () => {
    const a = newId("tnt");
    const b = newId("tnt");
    const inbox = newId("inb");
    await adb.db.tx(
      (tx) =>
        tx.query(
          `insert into inbound_events (inbox_id, tenant_id, source_id, event_id, received_at, payload_digest, payload_bytes, payload_ciphertext, encrypted_data_key,
             payload_key_ref, payload_iv, payload_tag, cipher_kind, raw_retain_until, auth_mechanism, status, next_attempt_at, updated_at)
           values ($1, $2, 'rls.synthetic', 'evt-rls-1', now(), $3, 1, '\\x00', '\\x00', 'kms-key-ref', '\\x00', '\\x00', 'live', now() + interval '1 day',
             'HMAC_SHA256_HEADER', 'RECEIVED', now(), now())`,
          [inbox, a, "d".repeat(64)],
        ),
      { role: "app_runtime", rls: { tenantId: a } },
    );
    const other = adb.pool(2);
    const seenByB = await other.tx((tx) => tx.query("select inbox_id from inbound_events"), { role: "app_worker", rls: { tenantId: b } });
    expect(seenByB.rows).toEqual([]);
    const upd = await other.tx((tx) => tx.query("update inbound_events set status = 'PROCESSED' where inbox_id = $1", [inbox]), { role: "app_worker", rls: { tenantId: b } });
    expect(upd.rowCount).toBe(0);
    const seenByA = await other.tx((tx) => tx.query("select inbox_id from inbound_events"), { role: "app_worker", rls: { tenantId: a } });
    expect(seenByA.rows).toHaveLength(1);
    await expect(other.tx((tx) => tx.query("insert into inbound_deliveries (delivery_id, inbox_id, tenant_id, received_at, duplicate, payload_digest, digest_matches, auth_mechanism) values ($1, $2, $3, now(), true, $4, true, 'MTLS')", [newId("idl"), inbox, a, "d".repeat(64)]), { role: "app_worker", rls: { tenantId: b } })).rejects.toMatchObject({ code: "42501" });
  });

  it("[FO-19-07a] SERIALIZABLE write skew between two connections: without retry one fails with 40001; with the retry policy both complete and the invariant holds", async () => {
    await adb.migrator.exec("create table if not exists it_oncall (doctor text primary key, on_call boolean not null); grant select, update on it_oncall to app_runtime");
    const reset = () => adb.migrator.exec("delete from it_oncall; insert into it_oncall values ('a', true), ('b', true)");
    const tenant = { tenantId: newId("tnt") };
    const run = async (useRetry: boolean) => {
      await reset();
      const aRead = latch();
      const bRead = latch();
      const p2 = adb.pool(2);
      const attempts = { a: 0, b: 0 };
      const leave = (me: "a" | "b", mine: ReturnType<typeof latch>, theirs: ReturnType<typeof latch>, pool: PgPoolDb) =>
        pool.tx(
          async (tx) => {
            attempts[me] += 1;
            const n = Number((await tx.query<{ n: string }>("select count(*)::text as n from it_oncall where on_call")).rows[0]?.n);
            if (attempts[me] === 1) {
              mine.release();
              await theirs.promise; // both have read before either writes: a guaranteed write skew
            }
            if (n >= 2) await tx.query("update it_oncall set on_call = false where doctor = $1", [me]);
          },
          { role: "app_runtime", rls: tenant, isolation: "serializable", ...(useRetry ? { retry: { maxAttempts: 5, baseDelayMs: 5 } } : {}) },
        );
      const results = await Promise.allSettled([leave("a", aRead, bRead, adb.db), leave("b", bRead, aRead, p2)]);
      const onCall = Number((await adb.migrator.query<{ n: string }>("select count(*)::text as n from it_oncall where on_call")).rows[0]?.n);
      return { results, attempts, onCall };
    };
    const plain = await run(false);
    const failures = plain.results.filter((r) => r.status === "rejected");
    expect(failures).toHaveLength(1);
    expect((failures[0] as PromiseRejectedResult).reason).toMatchObject({ code: "40001" });
    expect(plain.onCall).toBe(1);
    const retried = await run(true);
    expect(retried.results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(retried.attempts.a + retried.attempts.b).toBe(3); // exactly one transaction ran again
    expect(retried.onCall).toBe(1); // never zero doctors on call
  });

  it("[FO-19-07a][OPS-03] pool exhaustion is a bounded, reason-coded DB_POOL_EXHAUSTED, and the pool recovers when connections return", async () => {
    const small = adb.pool(2, { connectionTimeoutMillis: 300 });
    const hold = latch();
    const holders = [0, 1].map(() => small.tx(async (tx) => {
      await tx.query("select 1");
      await hold.promise;
    }));
    await sleep(100);
    const started = Date.now();
    const third = await reason(small.tx((tx) => tx.query("select 1")));
    expect(third).toBe("DB_POOL_EXHAUSTED");
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(small.stats()).toMatchObject({ total: 2, max: 2 });
    hold.release();
    await Promise.all(holders);
    await expect(small.tx((tx) => tx.query("select 1"))).resolves.toBeDefined();
    // An unreachable server is NOT_STARTED / DB_UNAVAILABLE, never a hang.
    const nowhere = PgPoolDb.fromConnectionString("postgres://nobody:nothing@127.0.0.1:1/none", 1, { connectionTimeoutMillis: 500 });
    const err = await nowhere.query("select 1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DependencyError);
    expect(err).toMatchObject({ reasonCode: "DB_UNAVAILABLE", outcome: "NOT_STARTED" });
    await nowhere.close();
  });

  it("[FO-15-33][FO-16-03][OPS-01] the audit, ingress, outbox, KV and db unit suites pass unchanged on postgres:16 (createTestDb with VSP_TEST_DB=pg)", async ({ l2 }) => {
    const out = join(scratchDir("vsp-unit-on-pg-"), "report.json");
    const env: NodeJS.ProcessEnv = { ...process.env, VSP_TEST_DB: "pg", VSP_TEST_PG_URL: postgresUrl(l2) };
    delete env.VSP_INTEGRATION;
    delete env.VSP_TEST_REPORT_DIR;
    delete env.VSP_LAYER2_PROBE;
    const r = spawnSync(
      join(PLATFORM_ROOT, "node_modules", ".bin", "vitest"),
      ["run", "--project", "unit", "src/audit", "src/ingress", "src/outbox", "src/db", "src/identity/kv", "--reporter=json", `--outputFile=${out}`],
      { cwd: PLATFORM_ROOT, env, encoding: "utf8", timeout: 900_000, maxBuffer: 64 * 1024 * 1024 },
    );
    const report = JSON.parse(readFileSync(out, "utf8")) as { numTotalTests: number; numFailedTests: number; numPassedTests: number; success: boolean };
    expect(report.numFailedTests, r.stderr.slice(-2000)).toBe(0);
    expect(report.numPassedTests).toBeGreaterThan(150);
    expect(r.status).toBe(0);
  }, 900_000);
});
