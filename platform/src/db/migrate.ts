import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "../shared/canonical.js";
import type { Db } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = resolve(here, "../../migrations");

export interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

export function listMigrations(dir = MIGRATIONS_DIR): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((name) => {
      const sql = readFileSync(join(dir, name), "utf8");
      return { name, sql, checksum: sha256Hex(sql) };
    });
}

/** Digest over all migration checksums, pinned in the ReleaseManifest. */
export const migrationsDigest = (dir = MIGRATIONS_DIR): string =>
  sha256Hex(listMigrations(dir).map((m) => `${m.name}:${m.checksum}`).join("\n"));

/**
 * Applies pending migrations in order inside owner transactions. An applied
 * migration whose checksum changed is a hard failure (no silent schema drift).
 */
export async function migrate(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  await db.tx(
    (tx) =>
      tx.query(`create table if not exists schema_migrations (
        name text primary key, checksum text not null, applied_at timestamptz not null default now())`),
    { role: "owner" },
  );
  const applied = new Map(
    (await db.query<{ name: string; checksum: string }>("select name, checksum from schema_migrations")).rows.map((r) => [r.name, r.checksum]),
  );
  const ran: string[] = [];
  for (const m of listMigrations(dir)) {
    const prior = applied.get(m.name);
    if (prior) {
      if (prior !== m.checksum) throw new Error(`migration ${m.name} was modified after being applied`);
      continue;
    }
    await db.tx(
      async (tx) => {
        await tx.exec(m.sql);
        await tx.query("insert into schema_migrations (name, checksum) values ($1, $2)", [m.name, m.checksum]);
      },
      { role: "owner" },
    );
    ran.push(m.name);
  }
  return ran;
}
