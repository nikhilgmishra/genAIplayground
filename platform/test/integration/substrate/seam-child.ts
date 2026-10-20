/**
 * Child process for seams.test.ts (Layer 2, WP-04): proves the CRASH_AFTER_COMMIT seam (killAfter) lands
 * between two durable steps. It commits step 1 to postgres:16, prints "STEP1_COMMITTED", waits, then would
 * commit step 2 and print "STEP2_COMMITTED". Killed after the first marker, step 2 never exists.
 *
 * Environment: VSP_CHILD_DB_URL (a database the test owns), VSP_CHILD_TABLE (a table name it created).
 */
import { PgPoolDb } from "../../../src/db/pg.js";

const url = process.env.VSP_CHILD_DB_URL ?? "";
const table = process.env.VSP_CHILD_TABLE ?? "";
if (!url || !/^[a-z_][a-z0-9_]{0,62}$/.test(table)) {
  process.stderr.write("missing VSP_CHILD_DB_URL or VSP_CHILD_TABLE\n");
  process.exit(3);
}
const db = PgPoolDb.fromConnectionString(url, 1, { applicationName: "vsp-seam-child" });
try {
  await db.tx((tx) => tx.query(`insert into ${table} (step) values (1)`), { role: "owner" });
  process.stdout.write("STEP1_COMMITTED\n");
  await new Promise((r) => setTimeout(r, 30_000));
  await db.tx((tx) => tx.query(`insert into ${table} (step) values (2)`), { role: "owner" });
  process.stdout.write("STEP2_COMMITTED\n");
  await db.close();
} catch (err) {
  process.stderr.write(`child failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
}
