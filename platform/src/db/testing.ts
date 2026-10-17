import { migrate } from "./migrate.js";
import { PgliteDb } from "./pglite.js";

/**
 * LOCAL TEST FIXTURE: fresh in-memory PostgreSQL (PGlite) with all migrations applied.
 * Each call returns an isolated database.
 */
export async function createTestDb(): Promise<PgliteDb> {
  const db = await PgliteDb.create();
  await migrate(db);
  return db;
}
