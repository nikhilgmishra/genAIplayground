/**
 * Layer 2 (WP-04): inbox processing on postgres:16 with payloads sealed by LocalStack KMS (FO-06-97,
 * FO-07-18, FO-07-20, FO-07-21, FO-07-22, FO-16-41; ACT-02, OPS-01).
 *  - a poison event goes INBOUND_DEAD after its bounded attempts (never re-claimed before its backoff), loudly;
 *  - an operator replay without its audit write is refused and changes nothing; with MFA and audit it re-runs once;
 *  - two processors on two pools (SKIP LOCKED claims) handle every event exactly once;
 *  - a processor stalled past its lease loses the event to a second processor and cannot apply it again;
 *  - source-version ordering: reordered, delayed and duplicated versions leave the newest state;
 *  - unknown schemas are quarantined at acceptance and never processed;
 *  - raw replay payloads live in restricted columns and are purged at retention, keeping the digest; a payload
 *    under an active legal hold (LegalHoldStorePg) is kept until the hold is released.
 */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { PgAuditWriter } from "../../../src/audit/writer.js";
import type { PayloadCipher } from "../../../src/ingress/cipher.js";
import { classify } from "../../../src/ingress/contracts.js";
import { INBOUND_RAW_PAYLOAD_DATASET } from "../../../src/ingress/inbox.js";
import { InboxProcessor } from "../../../src/ingress/processor.js";
import type { InboxHandler } from "../../../src/ingress/processor.js";
import { InboxReplayService } from "../../../src/ingress/replay.js";
import { LegalHoldStorePg } from "../../../src/retention/policies.js";
import { FakeClock, iso } from "../../../src/shared/clock.js";
import { newId } from "../../../src/shared/ids.js";
import { layer2, layer2Context } from "../_harness/layer2.js";
import { createAuroraLikeDb, latch } from "../substrate/support.js";
import type { AuroraLikeDb } from "../substrate/support.js";
import { HMAC_SOURCE, contracts, hmacVerifier, ingressStack, kmsInboxKey, profile, receipt } from "./support.js";
import type { IngressStack } from "./support.js";

const it = layer2(["postgres", "localstack"]);
let adb: AuroraLikeDb;
let kmsKey: string;
const CRED = "arn:aws:secretsmanager:us-east-1:000000000000:secret:vsp-it-unused-AbCdEf"; // never resolved: events enter through PgInbox.accept

/** Accepts one event through the production inbox (authentication is http.test.ts's subject). */
async function accept(stack: IngressStack, tenantId: string, body: Buffer) {
  const p = stack.registry.get(HMAC_SOURCE);
  if (!p) throw new Error("profile missing");
  return stack.inbox.accept({ profile: p, classification: classify(body, p, contracts()), rawBody: body, auth: { mechanism: "HMAC_SHA256_HEADER", credentialVersion: "v1" } });
}

async function rows(tenantId: string) {
  return (
    await adb.db.tx(
      (tx) =>
        tx.query<{ inbox_id: string; event_id: string; status: string; attempts: number; replay_count: number; projection_result: string | null; payload_ciphertext: Buffer | null; raw_purged_at: Date | null; payload_digest: string; next_attempt_at: Date }>(
          "select inbox_id, event_id, status, attempts, replay_count, projection_result, payload_ciphertext, raw_purged_at, payload_digest, next_attempt_at from inbound_events order by received_at, inbox_id",
        ),
      { role: "app_worker", rls: { tenantId } },
    )
  ).rows;
}

const digestOf = (s: string) => createHash("sha256").update(s).digest("hex");

describe("inbox processing on postgres:16 with KMS-sealed payloads", () => {
  beforeAll(async () => {
    const l2 = layer2Context(["postgres", "localstack"]);
    adb = await createAuroraLikeDb(l2);
    kmsKey = await kmsInboxKey(l2);
  });
  afterAll(async () => {
    await adb?.drop();
  });

  it("[FO-06-97][OPS-03] a poison event is retried with backoff, then INBOUND_DEAD after its bounded attempts, with an alarm; it is never claimed before its backoff", async ({ l2 }) => {
    const tenantId = newId("tnt");
    const clock = new FakeClock(new Date());
    const stack = ingressStack(l2, adb.db, clock, kmsKey, [profile(tenantId, HMAC_SOURCE, hmacVerifier(CRED))]);
    await accept(stack, tenantId, receipt(clock));
    let calls = 0;
    const poison: InboxHandler = async () => {
      calls += 1;
      throw new Error("handler defect");
    };
    const proc = stack.processor(adb.db, { "delivery.receipt@1": poison }, clock);
    expect((await proc.runOnce()).retried).toBe(1);
    expect((await proc.runOnce()).retried, "not re-claimed before its backoff").toBe(0);
    clock.advanceSeconds(10);
    expect((await proc.runOnce()).retried).toBe(1);
    clock.advanceSeconds(10);
    expect((await proc.runOnce()).deadLettered).toBe(1);
    clock.advanceSeconds(3600);
    expect(await proc.runOnce()).toMatchObject({ processed: 0, retried: 0, deadLettered: 0 });
    expect(calls).toBe(3);
    const [row] = await rows(tenantId);
    expect(row).toMatchObject({ status: "INBOUND_DEAD", attempts: 3 });
    expect(stack.records.some((r) => r.level === "error" && r.event === "inbox.dead_lettered")).toBe(true);
    expect(stack.metrics.counterValue("vsp_inbox_dead_letter_total")).toBe(1);
  });

  it("[FO-06-97][OPS-01] operator replay: refused without its audit write and without fresh MFA (nothing changes); with both, the event re-runs and is processed once", async ({ l2 }) => {
    const tenantId = newId("tnt");
    const clock = new FakeClock(new Date());
    const stack = ingressStack(l2, adb.db, clock, kmsKey, [profile(tenantId, HMAC_SOURCE, hmacVerifier(CRED), { processing: { maxAttempts: 1, baseDelayMs: 1000, maxDelayMs: 8000 } })]);
    await accept(stack, tenantId, receipt(clock));
    await stack.processor(adb.db, { "delivery.receipt@1": async () => Promise.reject(new Error("defect")) }, clock).runOnce();
    const [dead] = await rows(tenantId);
    expect(dead?.status).toBe("INBOUND_DEAD");
    const replay = new InboxReplayService({ db: adb.db, audit: new PgAuditWriter({ db: adb.db, clock, stream: "console.replay-it", standaloneRole: "app_console" }), clock });
    const req = (mfaAgeSeconds: number) => ({ tenantId, inboxId: dead?.inbox_id ?? "", operator: { staffRef: "stf_synthOperator0001", mfaVerifiedAt: iso(new Date(clock.now().getTime() - mfaAgeSeconds * 1000)), reasonCode: "HANDLER_DEFECT_FIXED" } });

    await adb.migrator.exec("revoke insert on audit_outbox from app_console");
    try {
      await expect(replay.replay(req(30))).rejects.toMatchObject({ reasonCode: "AUDIT_STORE_UNWRITABLE" });
    } finally {
      await adb.migrator.exec("grant insert on audit_outbox to app_console");
    }
    await expect(replay.replay(req(3600))).rejects.toMatchObject({ reasonCode: "INBOX_REPLAY_MFA_REQUIRED" });
    const unchanged = await rows(tenantId);
    expect(unchanged[0]).toMatchObject({ status: "INBOUND_DEAD", replay_count: 0 });
    const noReplays = await adb.db.tx((tx) => tx.query("select 1 from inbound_replays"), { role: "app_console", rls: { tenantId } });
    expect(noReplays.rows).toEqual([]);

    const done = await replay.replay(req(30));
    expect(done).toMatchObject({ priorStatus: "INBOUND_DEAD" });
    let applied = 0;
    await stack.processor(adb.db, { "delivery.receipt@1": async () => ((applied += 1), { projection: null }) }, clock).runOnce();
    await stack.processor(adb.db, { "delivery.receipt@1": async () => ((applied += 1), { projection: null }) }, clock).runOnce();
    expect(applied).toBe(1);
    expect((await rows(tenantId))[0]).toMatchObject({ status: "PROCESSED", replay_count: 1 });
    const audited = await adb.db.tx((tx) => tx.query<{ event: { actorRef: string } }>("select event from audit_outbox where tenant_id = app_tenant() and action = 'inbox.replay'"), { role: "app_worker", rls: { tenantId } });
    expect(audited.rows.map((r) => r.event.actorRef)).toEqual(["stf_synthOperator0001"]);
  });

  it("[FO-07-18][FO-16-41][ACT-02] two processors on two pools: thirty events, each handled exactly once", async ({ l2 }) => {
    const tenantId = newId("tnt");
    const clock = new FakeClock(new Date());
    const stack = ingressStack(l2, adb.db, clock, kmsKey, [profile(tenantId, HMAC_SOURCE, hmacVerifier(CRED))]);
    for (let i = 0; i < 30; i++) await accept(stack, tenantId, receipt(clock));
    const seen = new Map<string, number>();
    const handler: InboxHandler = async (_tx, ev) => (seen.set(ev.eventId, (seen.get(ev.eventId) ?? 0) + 1), { projection: null });
    const make = () => new InboxProcessor({ db: adb.pool(2), cipher: stack.cipher, profiles: stack.registry, contracts: contracts(), handlers: { "delivery.receipt@1": handler }, clock, tenants: [tenantId], batchSize: 4 });
    const drain = async (p: InboxProcessor) => {
      let n = 0;
      for (;;) {
        const r = await p.runOnce();
        n += r.processed;
        if (r.processed + r.retried === 0) return n;
      }
    };
    const [a, b] = await Promise.all([drain(make()), drain(make())]);
    expect(a + b).toBe(30);
    expect(a > 0 && b > 0, "both processors took part").toBe(true);
    expect(seen.size).toBe(30);
    expect([...seen.values()].every((n) => n === 1)).toBe(true);
  });

  it("[FO-16-41][FO-10-43][ACT-02] a processor stalled past its lease loses the event to another processor; its late attempt is fenced by the claim token and applies nothing", async ({ l2 }) => {
    const tenantId = newId("tnt");
    const clock = new FakeClock(new Date());
    const stack = ingressStack(l2, adb.db, clock, kmsKey, [profile(tenantId, HMAC_SOURCE, hmacVerifier(CRED))]);
    await accept(stack, tenantId, receipt(clock));
    const entered = latch();
    const gate = latch();
    // The stalled replica pauses inside its KMS decrypt (between its claim and its processing transaction).
    const stallingCipher: PayloadCipher = { kind: "live", encrypt: (p, c) => stack.cipher.encrypt(p, c), decrypt: async (p, c) => (entered.release(), await gate.promise, stack.cipher.decrypt(p, c)) };
    let effects = 0;
    const handlers = { "delivery.receipt@1": (async () => ((effects += 1), { projection: null })) as InboxHandler };
    const stalled = new InboxProcessor({ db: adb.pool(2), cipher: stallingCipher, profiles: stack.registry, contracts: contracts(), handlers, clock, tenants: [tenantId], leaseSeconds: 5 });
    const later = new FakeClock(new Date(clock.now().getTime() + 30_000));
    const takeover = new InboxProcessor({ db: adb.pool(2), cipher: stack.cipher, profiles: stack.registry, contracts: contracts(), handlers, clock: later, tenants: [tenantId], leaseSeconds: 5 });
    const first = stalled.runOnce();
    await entered.promise;
    expect((await takeover.runOnce()).processed).toBe(1);
    gate.release();
    expect(await first).toMatchObject({ processed: 0 });
    expect(effects).toBe(1);
    expect((await rows(tenantId))[0]).toMatchObject({ status: "PROCESSED", attempts: 1 });
  });

  it("[FO-07-20][ACT-02] source-version ordering: versions delivered 3, 1, 2 with a delayed clock and a duplicate leave version 3 projected; the late older versions run no handler", async ({ l2 }) => {
    const tenantId = newId("tnt");
    const clock = new FakeClock(new Date());
    const stack = ingressStack(l2, adb.db, clock, kmsKey, [profile(tenantId, HMAC_SOURCE, hmacVerifier(CRED))]);
    const t0 = clock.now().getTime();
    const ev = (version: string, minutesAgo: number) => receipt(clock, { version, entity: "msg_synthetic0042", occurredAt: iso(new Date(t0 - minutesAgo * 60_000)) });
    for (const b of [ev("3", 5), ev("1", 0), ev("2", 60)]) {
      await accept(stack, tenantId, b);
      clock.advanceSeconds(1);
    }
    const handled: string[] = [];
    const projector: InboxHandler = async (_tx, e) => (handled.push(`${e.entityKey}@${e.sourceVersion}`), { projection: { stateDigest: digestOf(`${e.entityKey}:${e.sourceVersion}`) } });
    // One event per claim, so processing follows arrival order (3, 1, 2): the older versions arrive late.
    const oneAtATime = new InboxProcessor({ db: adb.db, cipher: stack.cipher, profiles: stack.registry, contracts: contracts(), handlers: { "delivery.receipt@1": projector }, clock, tenants: [tenantId], batchSize: 1 });
    const outcomes: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await oneAtATime.runOnce();
      outcomes.push(r.processed === 1 ? "processed" : r.superseded === 1 ? "superseded" : "none");
    }
    expect(outcomes).toEqual(["processed", "superseded", "superseded"]);
    expect(handled, "superseded versions never reach the handler's domain effects").toEqual(["msg_synthetic0042@3"]);
    const results = (await rows(tenantId)).map((r) => r.projection_result);
    expect(results).toEqual(["APPLIED", "SUPERSEDED", "SUPERSEDED"]);
    // Any arrival order of the same versions (here 1, 2, 3 for another entity, batched) ends in the same state.
    const t1 = clock.now().getTime();
    for (const v of ["1", "2", "3"]) {
      await accept(stack, tenantId, receipt(clock, { version: v, entity: "msg_synthetic0043", occurredAt: iso(new Date(t1)) }));
      clock.advanceSeconds(1);
    }
    await stack.processor(adb.db, { "delivery.receipt@1": projector }, clock).runOnce();
    const proj = await adb.db.tx((tx) => tx.query<{ source_version: string; state_digest: string }>("select source_version::text as source_version, state_digest from inbox_projection_versions where tenant_id = app_tenant()"), { role: "app_worker", rls: { tenantId } });
    expect(proj.rows.sort((a, b) => a.state_digest.localeCompare(b.state_digest))).toEqual(
      [
        { source_version: "3", state_digest: digestOf("msg_synthetic0042:3") },
        { source_version: "3", state_digest: digestOf("msg_synthetic0043:3") },
      ].sort((a, b) => a.state_digest.localeCompare(b.state_digest)),
    );
    // The table refuses a version regression even from a caller that bypasses applySourceVersioned.
    await expect(adb.db.tx((tx) => tx.query("update inbox_projection_versions set source_version = 1 where tenant_id = app_tenant()"), { role: "app_worker", rls: { tenantId } })).rejects.toBeTruthy();
  });

  it("[FO-07-21][FO-07-22][DATA-03][OPS-03] an unknown schema is quarantined at acceptance and never processed; raw payloads are restricted columns and are purged at retention, keeping the digest, except while a legal hold applies", async ({ l2 }) => {
    const tenantId = newId("tnt");
    const clock = new FakeClock(new Date());
    const stack = ingressStack(l2, adb.db, clock, kmsKey, [profile(tenantId, HMAC_SOURCE, hmacVerifier(CRED), { rawRetentionDays: 1 })]);
    const q = await accept(stack, tenantId, Buffer.from(JSON.stringify({ ...JSON.parse(receipt(clock).toString()), unexpectedField: "x" })));
    expect(q.status).toBe("QUARANTINED");
    expect(stack.metrics.counterValue("vsp_inbox_quarantined_total"), "the quarantine is counted for alerting").toBe(1);
    expect(stack.records.some((r) => r.event === "inbox.quarantined")).toBe(true);
    const ok = await accept(stack, tenantId, receipt(clock));
    let handled = 0;
    await stack.processor(adb.db, { "delivery.receipt@1": async () => ((handled += 1), { projection: null }) }, clock).runOnce();
    expect(handled).toBe(1);
    const audit = await adb.db.tx((tx) => tx.query<{ action: string }>("select action from audit_outbox where tenant_id = app_tenant() order by recorded_at"), { role: "app_worker", rls: { tenantId } });
    expect(audit.rows.map((r) => r.action).sort()).toEqual(["ingress.event.accepted", "ingress.event.quarantined"]);
    // Restricted storage: the console role cannot read the sealed payload columns at all.
    for (const role of ["app_console", "app_runtime"] as const) {
      await expect(adb.db.tx((tx) => tx.query("select payload_ciphertext from inbound_events"), { role, rls: { tenantId } }), role).rejects.toMatchObject({ code: "42501" });
    }
    // Every raw payload carries its retention class.
    const classes = await adb.db.tx((tx) => tx.query<{ retention_class: string }>("select distinct retention_class from inbound_events"), { role: "app_worker", rls: { tenantId } });
    expect(classes.rows).toEqual([{ retention_class: "INBOUND_RAW_REPLAY" }]);
    // A third event is received but no worker processes it before its retention expires.
    const pending = await accept(stack, tenantId, receipt(clock));
    clock.advanceSeconds(2 * 86_400);
    // A legal hold on the processed event's payload (DATA-03) keeps it past its retention; the other is purged.
    const holds = new LegalHoldStorePg({ db: adb.db, clock });
    const admin = { staffId: newId("stf"), roles: ["security_admin" as const], mfa: true, authenticatedAt: iso(clock.now()), breakGlass: null };
    const hold = await holds.place({ tenantId, dataset: INBOUND_RAW_PAYLOAD_DATASET, recordKey: ok.inboxId, matterRef: newId("mtr"), reasonCode: "LITIGATION_HOLD", staff: admin });
    expect(await stack.inbox.purgeExpiredPayloads(tenantId)).toEqual({ purged: 1, held: 1, reasonCode: "LEGAL_HOLD_ACTIVE" });
    const during = await rows(tenantId);
    expect(during.find((r) => r.inbox_id === ok.inboxId)?.payload_ciphertext, "the held payload is kept").not.toBeNull();
    expect(during.find((r) => r.inbox_id === q.inboxId)?.payload_ciphertext).toBeNull();
    await holds.release({ tenantId, holdId: hold.holdId, reasonCode: "MATTER_CLOSED", staff: admin });
    expect(await stack.inbox.purgeExpiredPayloads(tenantId)).toEqual({ purged: 1, held: 0, reasonCode: null });
    // The unprocessed event keeps its payload past retention (purging it would make it unprocessable); once processed it is purged.
    const unprocessed = (await rows(tenantId)).find((r) => r.inbox_id === pending.inboxId);
    expect(unprocessed).toMatchObject({ status: "RECEIVED", raw_purged_at: null });
    expect(unprocessed?.payload_ciphertext).not.toBeNull();
    await stack.processor(adb.db, { "delivery.receipt@1": async () => ((handled += 1), { projection: null }) }, clock).runOnce();
    expect(handled).toBe(2);
    expect(await stack.inbox.purgeExpiredPayloads(tenantId)).toEqual({ purged: 1, held: 0, reasonCode: null });
    const after = await rows(tenantId);
    for (const r of after) {
      expect(r.payload_ciphertext).toBeNull();
      expect(r.raw_purged_at).not.toBeNull();
      expect(r.payload_digest).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(after.find((r) => r.inbox_id === ok.inboxId)?.status).toBe("PROCESSED");
  });
});
