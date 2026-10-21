/**
 * Child process for contention.test.ts (Layer 2, WP-04): a gateway replica that commits one confirmed action
 * through the production LedgerActionService and dies at the CRASH_AFTER_COMMIT point. The reference system
 * of record applies the effect and the child prints "PROVIDER_APPLIED"; the provider response is then held
 * (a slow network return) so the parent's SIGKILL lands after the effect and before the ledger's COMMITTED
 * transaction. Opaque ids only on stdout.
 *
 * Environment: VSP_CHILD_DB_URL (application login), VSP_CHILD_SOR_URL, VSP_CHILD_CTX (AuthContext JSON),
 * VSP_CHILD_ACTION_ID, VSP_CHILD_DIGEST.
 */
import { PgPoolDb } from "../../../src/db/pg.js";
import type { AuthContext } from "../../../src/protocol/index.js";
import { systemClock } from "../../../src/shared/clock.js";
import { allow, ledgerReplica, ReferenceSystemOfRecord } from "./reference-sor.js";

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    process.stderr.write(`missing ${name}\n`);
    process.exit(3);
  }
  return v;
}

const db = PgPoolDb.fromConnectionString(need("VSP_CHILD_DB_URL"), 2, { applicationName: "vsp-commit-child" });
const sorDb = PgPoolDb.fromConnectionString(need("VSP_CHILD_SOR_URL"), 2, { applicationName: "vsp-commit-child-sor" });
const replica = ledgerReplica(db, systemClock, "child");
const provider = new ReferenceSystemOfRecord(sorDb, {
  afterApply: async () => {
    process.stdout.write("PROVIDER_APPLIED\n");
    await new Promise((resolve) => setTimeout(resolve, 120_000));
  },
});

try {
  const ctx = JSON.parse(need("VSP_CHILD_CTX")) as AuthContext;
  process.stdout.write("COMMITTING\n");
  await replica.service.commit(ctx, { actionId: need("VSP_CHILD_ACTION_ID"), digest: need("VSP_CHILD_DIGEST") }, { reauthorize: async () => allow(systemClock), provider });
  process.stdout.write("UNEXPECTED_RETURN\n");
  process.exit(5);
} catch (err) {
  process.stderr.write(`child failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
}
