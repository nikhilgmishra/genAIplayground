/**
 * Layer 2 (WP-04): persist before acknowledge under process death (FO-07-17, FO-07-18; ACT-02, OPS-01).
 * An ingress replica (ingress-child.ts: the production router, PgInbox on postgres:16, LocalStack KMS and
 * Secrets Manager, the Fastify plugin on a real socket) is SIGKILLed while it handles a signed delivery:
 *  - after the inbox transaction COMMITTED and before the HTTP response: the sender gets no acknowledgement
 *    (the connection dies), the event is durably in the inbox, and the sender's redelivery to another replica
 *    is answered 200 "duplicate" and recorded — one row, nothing applied twice;
 *  - after the row was inserted and BEFORE the commit: the database rolls the transaction back (no row, no
 *    audit event), the sender gets no acknowledgement, and its redelivery is accepted once — nothing lost.
 */
import { request } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { systemClock } from "../../../src/shared/clock.js";
import { newId } from "../../../src/shared/ids.js";
import { localEnv, PLATFORM_ROOT } from "../_harness/env.js";
import { layer2, layer2Context } from "../_harness/layer2.js";
import type { Layer2Context } from "../_harness/layer2.js";
import { runChild, waitForLine } from "../substrate/contention-harness.js";
import { createAuroraLikeDb } from "../substrate/support.js";
import type { AuroraLikeDb } from "../substrate/support.js";
import { HMAC_SOURCE, hmacSecret, hmacVerifier, ingressStack, kmsInboxKey, profile, receipt, serve, signHeaders } from "./support.js";

const it = layer2(["postgres", "localstack"]);
const CHILD = join(PLATFORM_ROOT, "test", "integration", "ingress", "ingress-child.ts");
let adb: AuroraLikeDb;
let kmsKey: string;

/** POSTs over a raw socket and reports whether ANY response arrived (an acknowledgement) or the connection died. */
function deliver(port: number, body: Buffer, headers: Record<string, string>): Promise<{ acknowledged: false; error: string } | { acknowledged: true; status: number }> {
  return new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port, method: "POST", path: `/v1/ingress/${HMAC_SOURCE}/events`, headers: { ...headers, "content-length": String(body.length) } }, (res) => {
      res.resume();
      resolve({ acknowledged: true, status: res.statusCode ?? 0 });
    });
    req.on("error", (e: NodeJS.ErrnoException) => resolve({ acknowledged: false, error: e.code ?? "ERROR" }));
    req.end(body);
  });
}

async function eventRows(tenantId: string, eventId: string) {
  const r = await adb.db.tx(
    (tx) => tx.query<{ inbox_id: string; status: string; duplicate_count: number }>("select inbox_id, status, duplicate_count from inbound_events where event_id = $1", [eventId]),
    { role: "app_worker", rls: { tenantId } },
  );
  return r.rows;
}

async function auditedAccepts(tenantId: string): Promise<number> {
  const r = await adb.db.tx((tx) => tx.query("select 1 from audit_outbox where tenant_id = app_tenant() and action = 'ingress.event.accepted'"), { role: "app_worker", rls: { tenantId } });
  return r.rows.length;
}

async function crashDuring(l2: Layer2Context, crash: "after_commit" | "before_commit", tenantId: string, arn: string, body: Buffer, headers: Record<string, string>, marker: string) {
  const env = localEnv();
  const run = runChild(CHILD, [], {
    VSP_CHILD_CRASH: crash,
    VSP_CHILD_DB_URL: adb.appUrl,
    VSP_CHILD_TENANT: tenantId,
    VSP_CHILD_SECRET_ARN: arn,
    VSP_CHILD_KMS_KEY: kmsKey,
    VSP_CHILD_LOCALSTACK: l2.url("localstack", 4566),
    VSP_CHILD_AWS_KEY: env.awsAccessKeyId,
    VSP_CHILD_AWS_SECRET: env.awsSecretAccessKey,
  });
  try {
    const port = Number((await waitForLine(run, "LISTENING ")).split(" ")[1]);
    const delivery = deliver(port, body, headers);
    await waitForLine(run, marker);
    run.child.kill("SIGKILL");
    const exit = await run.exited;
    return { delivery: await delivery, exit };
  } catch (err) {
    run.child.kill("SIGKILL");
    await run.exited;
    throw err;
  }
}

describe("ingress replica killed in the middle of an accept", () => {
  beforeAll(async () => {
    const l2 = layer2Context(["postgres", "localstack"]);
    adb = await createAuroraLikeDb(l2);
    kmsKey = await kmsInboxKey(l2);
  });
  afterAll(async () => {
    await adb?.drop();
  });

  it("[FO-07-17][FO-07-18][ACT-02][OPS-01] crash after the inbox commit, before the response: no acknowledgement reaches the sender, the event is durable, and its redelivery to another replica is a recorded duplicate", async ({ l2 }) => {
    const tenantId = newId("tnt");
    const { arn, key } = await hmacSecret(l2);
    const body = receipt(systemClock);
    const eventId = String(JSON.parse(body.toString()).id);
    const headers = signHeaders(body, key, systemClock);
    const { delivery, exit } = await crashDuring(l2, "after_commit", tenantId, arn, body, headers, "COMMITTED");
    expect(exit.signal, "reached: the replica died at the crash point").toBe("SIGKILL");
    expect(delivery, "no acknowledgement was sent").toMatchObject({ acknowledged: false });
    const persisted = await eventRows(tenantId, eventId);
    expect(persisted, "acknowledged or not, a committed event is never lost").toEqual([{ inbox_id: expect.any(String), status: "RECEIVED", duplicate_count: 0 }]);
    expect(await auditedAccepts(tenantId)).toBe(1);
    // The sender redelivers the identical request (no acknowledgement): another replica answers duplicate.
    const replica = await serve(ingressStack(l2, adb.pool(2), systemClock, kmsKey, [profile(tenantId, HMAC_SOURCE, hmacVerifier(arn))]).router);
    try {
      const again = await fetch(`${replica.url}/v1/ingress/${HMAC_SOURCE}/events`, { method: "POST", body, headers });
      expect(again.status).toBe(200);
      expect(await again.json()).toMatchObject({ decision: "duplicate", inboxId: persisted[0]?.inbox_id });
    } finally {
      await replica.app.close();
    }
    expect(await eventRows(tenantId, eventId)).toEqual([{ inbox_id: persisted[0]?.inbox_id, status: "RECEIVED", duplicate_count: 1 }]);
    expect(await auditedAccepts(tenantId), "one accepted event, one audit event").toBe(1);
  });

  it("[FO-07-17][ACT-02][OPS-01] crash after the insert, before the commit: the transaction is rolled back (no row, no audit event), nothing is acknowledged, and the redelivery is accepted once", async ({ l2 }) => {
    const tenantId = newId("tnt");
    const { arn, key } = await hmacSecret(l2);
    const body = receipt(systemClock);
    const eventId = String(JSON.parse(body.toString()).id);
    const headers = signHeaders(body, key, systemClock);
    const { delivery, exit } = await crashDuring(l2, "before_commit", tenantId, arn, body, headers, "INSERTED_UNCOMMITTED");
    expect(exit.signal, "reached: the replica died inside the transaction").toBe("SIGKILL");
    expect(delivery).toMatchObject({ acknowledged: false });
    // The server aborts the dead backend's transaction; wait until it is gone, then nothing of it remains.
    for (let i = 0; i < 100; i++) {
      const open = await adb.db.tx((tx) => tx.query("select 1 from pg_stat_activity where application_name = 'vsp-ingress-child' and datname = current_database()"), { role: "owner" });
      if (open.rows.length === 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(await eventRows(tenantId, eventId)).toEqual([]);
    expect(await auditedAccepts(tenantId)).toBe(0);
    const replica = await serve(ingressStack(l2, adb.pool(2), systemClock, kmsKey, [profile(tenantId, HMAC_SOURCE, hmacVerifier(arn))]).router);
    try {
      const again = await fetch(`${replica.url}/v1/ingress/${HMAC_SOURCE}/events`, { method: "POST", body, headers });
      expect(again.status).toBe(200);
      expect(await again.json()).toMatchObject({ decision: "accepted" });
    } finally {
      await replica.app.close();
    }
    expect(await eventRows(tenantId, eventId)).toEqual([{ inbox_id: expect.any(String), status: "RECEIVED", duplicate_count: 0 }]);
    expect(await auditedAccepts(tenantId)).toBe(1);
  });
});
