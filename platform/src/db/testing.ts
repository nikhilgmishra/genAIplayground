import { migrate, listMigrations, MIGRATIONS_DIR } from "./migrate.js";
import { PgliteDb } from "./pglite.js";
import { PgPoolDb } from "./pg.js";
import type { Db, DbRole } from "./types.js";
import { mkdtempSync, copyFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface TestDbOptions {
  /**
   * Restrict to migrations whose file name matches (the 0001 foundation migration
   * is always applied). Lets a module test its own schema while other modules'
   * migrations are being written. Integration tests use all migrations.
   */
  include?: RegExp;
}

/** Engine selected for createTestDb: VSP_TEST_DB=pg runs the same suites on a real PostgreSQL server. */
export function testDbEngine(env: NodeJS.ProcessEnv = process.env): "pglite" | "pg" {
  const v = env.VSP_TEST_DB ?? "pglite";
  if (v !== "pglite" && v !== "pg") throw new Error("VSP_TEST_DB must be pglite or pg");
  return v;
}

function migrationsDir(opts: TestDbOptions): string {
  if (!opts.include) return MIGRATIONS_DIR;
  const dir = mkdtempSync(join(tmpdir(), "vsp-migrations-"));
  for (const m of listMigrations(MIGRATIONS_DIR)) {
    if (m.name.startsWith("0001_") || opts.include.test(m.name)) copyFileSync(join(MIGRATIONS_DIR, m.name), join(dir, m.name));
  }
  return dir;
}

/**
 * LOCAL TEST SWITCH (VSP_TEST_DB=pg): a fresh PostgreSQL database per call on the server named by
 * VSP_TEST_PG_URL (an administrative connection string of a LOCAL server, e.g. the Layer-2
 * postgres:16 service), with the selected migrations applied through PgPoolDb. `close` ends the
 * pool and drops the database. Creation is serialized with an advisory lock because the foundation
 * migration creates cluster-wide roles. Never used outside tests.
 */
/** Connection string of each database createPgTestDb returned (for createTestLogin on a real server). */
const PG_TEST_URLS = new WeakMap<object, string>();

async function createPgTestDb(opts: TestDbOptions): Promise<PgPoolDb> {
  const adminUrl = process.env.VSP_TEST_PG_URL;
  if (!adminUrl || !/^postgres(ql)?:\/\/[^@]+@(127\.0\.0\.1|localhost)(:\d+)?\/[a-z_]+$/.test(adminUrl)) {
    throw new Error("VSP_TEST_DB=pg needs VSP_TEST_PG_URL=postgres://<user>:<password>@127.0.0.1:<port>/<db> (a LOCAL server only)");
  }
  const name = `vsp_ut_${randomBytes(6).toString("hex")}`;
  const admin = PgPoolDb.fromConnectionString(adminUrl, 2);
  const url = adminUrl.replace(/\/[a-z_]+$/, `/${name}`);
  const db = PgPoolDb.fromConnectionString(url, 4);
  try {
    await admin.exec(`create database ${name}`);
    await admin.tx(
      async (tx) => {
        await tx.query("select pg_advisory_xact_lock(7300004)");
        await migrate(db, migrationsDir(opts));
      },
      { role: "owner" },
    );
  } catch (err) {
    await db.close().catch(() => undefined);
    await admin.close().catch(() => undefined);
    throw err;
  }
  await admin.close();
  PG_TEST_URLS.set(db, url);
  const close = db.close.bind(db);
  return Object.assign(db, {
    async close(): Promise<void> {
      await close();
      const a = PgPoolDb.fromConnectionString(adminUrl, 1);
      try {
        await a.exec(`drop database if exists ${name} with (force)`);
      } finally {
        await a.close();
      }
    },
  });
}

/**
 * LOCAL TEST FIXTURE: fresh in-memory PostgreSQL (PGlite) with migrations applied.
 * Each call returns an isolated database. With VSP_TEST_DB=pg the same call returns a fresh
 * database on a real PostgreSQL server instead (see createPgTestDb); callers use only the Db port,
 * so the suites run unchanged on both engines.
 */
export async function createTestDb(opts: TestDbOptions = {}): Promise<PgliteDb> {
  if (testDbEngine() === "pg") {
    // The PgliteDb type keeps every caller unchanged; its one embedded-only member fails loudly on a server.
    const pg = Object.assign(await createPgTestDb(opts), {
      openCopyAs: (): Promise<never> => Promise.reject(new Error("openCopyAs is PGlite-only: with VSP_TEST_DB=pg open a separate login with createTestLogin(db, roles).open()")),
    });
    return pg as unknown as PgliteDb;
  }
  const db = await PgliteDb.create();
  await migrate(db, migrationsDir(opts));
  return db;
}

const LOGIN_RE = /^vsp_tl_[a-f0-9]{12}$/;
const GRANTABLE: readonly DbRole[] = ["app_runtime", "app_worker", "app_console", "app_auditor", "app_audit_verifier"];

export interface TestLogin {
  login: string;
  /**
   * Opens a database handle whose session user IS the login (close it when done):
   *  - PGlite: a point-in-time copy of the embedded database opened as the login (PgliteDb.openCopyAs) —
   *    open it after the data it must see was written;
   *  - VSP_TEST_DB=pg: a live pool that the server authenticates as the login.
   */
  open(): Promise<Db>;
  /** Removes the login. */
  drop(): Promise<void>;
}

/**
 * LOCAL TEST FIXTURE: a separate LOGIN role granted exactly `roles`, the way a production component (the audit
 * verifier, for example) connects with its own login rather than the application's. Handles opened from it
 * run as that login, so session_user is the login and `set local role` works only for roles it was granted.
 * Never used outside tests.
 */
export async function createTestLogin(db: Db, roles: readonly DbRole[]): Promise<TestLogin> {
  for (const r of roles) if (!GRANTABLE.includes(r)) throw new Error(`createTestLogin: role ${r} cannot be granted`);
  const login = `vsp_tl_${randomBytes(6).toString("hex")}`;
  if (!LOGIN_RE.test(login)) throw new Error("createTestLogin: invalid login name");
  const grant = roles.length > 0 ? `grant ${roles.join(", ")} to ${login};` : "";
  const drop = async () => {
    await db.exec(`drop owned by ${login}; drop role if exists ${login}`);
  };
  if (db.engine === "pg") {
    const url = PG_TEST_URLS.get(db);
    if (!url) throw new Error("createTestLogin: the database was not created by createTestDb");
    const password = randomBytes(18).toString("hex");
    await db.exec(`create role ${login} login password '${password}'; ${grant}`);
    const loginUrl = url.replace(/^postgres(ql)?:\/\/[^@]+@/, `postgres://${login}:${password}@`);
    return { login, open: async () => PgPoolDb.fromConnectionString(loginUrl, 2, { applicationName: "vsp-test-login" }), drop };
  }
  if (!(db instanceof PgliteDb)) throw new Error("createTestLogin: unsupported database handle");
  await db.exec(`create role ${login} login; ${grant}`);
  return { login, open: () => db.openCopyAs(login), drop };
}
