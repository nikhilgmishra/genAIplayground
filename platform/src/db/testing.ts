import { migrate, listMigrations, MIGRATIONS_DIR } from "./migrate.js";
import { PgliteDb } from "./pglite.js";
import { mkdtempSync, copyFileSync } from "node:fs";
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

/**
 * LOCAL TEST FIXTURE: fresh in-memory PostgreSQL (PGlite) with migrations applied.
 * Each call returns an isolated database.
 */
export async function createTestDb(opts: TestDbOptions = {}): Promise<PgliteDb> {
  const db = await PgliteDb.create();
  if (!opts.include) {
    await migrate(db);
    return db;
  }
  const dir = mkdtempSync(join(tmpdir(), "vsp-migrations-"));
  for (const m of listMigrations(MIGRATIONS_DIR)) {
    if (m.name.startsWith("0001_") || opts.include.test(m.name)) copyFileSync(join(MIGRATIONS_DIR, m.name), join(dir, m.name));
  }
  await migrate(db, dir);
  return db;
}
