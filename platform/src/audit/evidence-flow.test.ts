/**
 * End-to-end evidence flow over real PostgreSQL (PGlite) and the LOCAL FIXTURE sink:
 * health gate -> consequential change + audit event in one transaction -> ship ->
 * verify the independent copy -> reconcile against the source of truth.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PgliteDb } from "../db/pglite.js";
import { FakeClock, iso } from "../shared/clock.js";
import { AuditUnavailableError } from "../shared/errors.js";
import { PgAuditHealth } from "./health.js";
import { AuditShipper } from "./shipper.js";
import { LocalFsAuditSinkFixture } from "./sinks/local-fs.js";
import { TENANT_ID, countRows, createAuditTestDb, sampleAuditInput } from "./testing.js";
import { IntegrityVerifier, assessCompleteness, reconcileCounts } from "./verifier.js";
import { PgAuditWriter } from "./writer.js";

let db: PgliteDb;
let clock: FakeClock;
let root: string;

beforeEach(async () => {
  db = await createAuditTestDb();
  clock = new FakeClock();
  root = mkdtempSync(join(tmpdir(), "vsp-audit-e2e-"));
  await db.exec(`
    create table synth_ledger (action_id text primary key, tenant_id text not null, idempotency_key text not null, state text not null);
    grant insert, select on synth_ledger to app_runtime;
  `);
});
afterEach(async () => {
  await db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("audit evidence flow", () => {
  it("[OPS-01] every accepted consequential action has durable, independently verified audit evidence", async () => {
    const writer = new PgAuditWriter({ db, clock, stream: "actions.synth-e2e" });
    const health = new PgAuditHealth({ db, clock, policy: { maxBacklog: 100, maxBacklogAgeSeconds: 300 }, probeId: "actions.synth-e2e" });
    const sink = new LocalFsAuditSinkFixture(root);
    const from = iso(clock.now());

    // a synthetic "commit" helper that refuses to acknowledge without audit evidence
    async function commit(actionId: string, key: string): Promise<"ACKNOWLEDGED"> {
      await health.assertCanAcceptConsequential();
      await db.tx(async (tx) => {
        await tx.query("insert into synth_ledger values ($1, $2, $3, 'COMMITTED')", [actionId, TENANT_ID, key]);
        await writer.append(tx, sampleAuditInput(clock, { idempotencyKey: key, evidencePointers: [`ledger://actions/${actionId}`] }));
      }, { rls: { tenantId: TENANT_ID } });
      return "ACKNOWLEDGED";
    }

    expect(await commit("act_synthE2eAction00001", "idem_synthE2eAction00001")).toBe("ACKNOWLEDGED");
    expect(await commit("act_synthE2eAction00002", "idem_synthE2eAction00002")).toBe("ACKNOWLEDGED");

    // audit outage: the third action is refused and leaves no ledger row
    await db.exec("revoke insert on audit_outbox from app_runtime");
    await expect(commit("act_synthE2eAction00003", "idem_synthE2eAction00003")).rejects.toBeInstanceOf(AuditUnavailableError);
    await db.exec("grant insert on audit_outbox to app_runtime");
    expect(await countRows(db, "select count(*) as n from synth_ledger")).toBe(2);

    // ship, verify the independent copy, then reconcile ledger vs evidence
    clock.advanceSeconds(5);
    expect((await new AuditShipper({ db, sink, clock }).runOnce()).eventsShipped).toBe(2);
    const verifier = new IntegrityVerifier({ db, sink, clock });
    const integrity = [await verifier.verifyStream("actions.synth-e2e"), await verifier.verifyShipped("actions.synth-e2e", { markVerified: true })];
    const ledgerKeys = (await db.tx((tx) => tx.query<{ k: string }>("select idempotency_key as k from synth_ledger order by 1"), { role: "owner" })).rows.map((r) => r.k);
    const observed = await verifier.observedActionKeys({ tenantId: TENANT_ID, actions: ["action.commit.succeeded"], from, to: iso(clock.now()) });
    const reconciliation = reconcileCounts({ "action.commit.succeeded": ledgerKeys }, observed);
    const ingestion = await verifier.detectIngestionGaps({
      silenceThresholdSeconds: 60,
      reports: [{ sourceStream: "actions.synth-e2e", windowStart: from, windowEnd: iso(clock.now()), reportedEventCount: ledgerKeys.length }],
    });
    expect(assessCompleteness({ integrity, ingestion, reconciliation })).toEqual({ verdict: "PASS", reasonCodes: [] });
    expect(await health.status()).toMatchObject({ canAcceptConsequential: true, backlogCount: 0 });
  });
});
