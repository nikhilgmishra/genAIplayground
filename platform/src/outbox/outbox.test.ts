/**
 * Transactional outbox, dispatcher and consumer dedup on real PostgreSQL (PGlite) with the
 * LOCAL FIXTURE in-memory publisher. Payloads use SYNTHETIC opaque references only.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { createTestDb } from "../db/testing.js";
import type { PgliteDb } from "../db/pglite.js";
import type { Queryable } from "../db/types.js";
import { OTHER_TENANT_ID, TENANT_ID } from "../fixtures/synthetic-world.js";
import { FakeClock } from "../shared/clock.js";
import { InTxAuditWriterFixture, fixtureAuditRows, installAuditFixtureTable } from "../actions/fixtures/audit-writer.fixture.js";
import { PgConsumerDedup } from "./consumer-dedup.js";
import { PgOutboxDispatcher, computeBackoffMs } from "./dispatcher.js";
import { MemoryPublisherFixture } from "./memory-publisher.fixture.js";
import { PgOutbox, isOpaquePayloadString } from "./outbox.js";
import type { MessagePublisher, OutboxMessage, OutboxMessageInput } from "./ports.js";

let db: PgliteDb;
let clock: FakeClock;
let outbox: PgOutbox;
let publisher: MemoryPublisherFixture;

beforeEach(async () => {
  db = await createTestDb({ include: /^01/ });
  clock = new FakeClock();
  outbox = new PgOutbox({ clock });
  publisher = new MemoryPublisherFixture();
});
afterEach(async () => {
  await db.close();
});

const inTenant = <T>(fn: (tx: Queryable) => Promise<T>, tenantId = TENANT_ID) => db.tx(fn, { role: "app_runtime", rls: { tenantId } });
const msg = (n: number, overrides: Partial<OutboxMessageInput> = {}): OutboxMessageInput => ({
  topic: "support_request.sync",
  key: `support_request:spr_synthRequest${String(n).padStart(8, "0")}`,
  payload: { supportRequestId: `spr_synthRequest${String(n).padStart(8, "0")}`, attemptedAt: "2026-10-17T15:00:00.000Z" },
  dedupeKey: `support_request.sync:${n}`,
  ...overrides,
});
const dispatcherWith = (p: MessagePublisher, extra: Partial<ConstructorParameters<typeof PgOutboxDispatcher>[0]> = {}) =>
  new PgOutboxDispatcher({ db, publisher: p, clock, tenants: [TENANT_ID], random: () => 0.5, config: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 8_000 }, ...extra });
const statusOf = async (id: string) =>
  (await db.tx((tx) => tx.query<{ status: string; attempts: number; last_error_code: string | null }>("select status, attempts, last_error_code from outbox_messages where message_id = $1", [id]), { role: "owner" })).rows[0];
const reason = (p: Promise<unknown>) => p.then(() => "RESOLVED", (e: { reasonCode?: string }) => e.reasonCode ?? "NO_REASON_CODE");

describe("enqueue", () => {
  it("[SPEC-8.3] enqueue participates in the caller's transaction: a rolled-back state change leaves no message", async () => {
    await expect(
      inTenant(async (tx) => {
        await outbox.enqueue(tx, msg(1));
        throw new Error("state change failed");
      }),
    ).rejects.toThrow("state change failed");
    const n = await db.tx((tx) => tx.query<{ n: number }>("select count(*)::int as n from outbox_messages"), { role: "owner" });
    expect(n.rows[0]?.n).toBe(0);
  });

  it("[ACT-02] duplicate logical messages (same dedupeKey) are ignored at enqueue and return the original id", async () => {
    const a = await inTenant((tx) => outbox.enqueue(tx, msg(1)));
    const b = await inTenant((tx) => outbox.enqueue(tx, msg(1)));
    expect(b).toBe(a);
    const n = await db.tx((tx) => tx.query<{ n: number }>("select count(*)::int as n from outbox_messages"), { role: "owner" });
    expect(n.rows[0]?.n).toBe(1);
    // Same dedupe key in another tenant is a different logical message.
    const c = await inTenant((tx) => outbox.enqueue(tx, msg(1)), OTHER_TENANT_ID);
    expect(c).not.toBe(a);
  });

  it("[SPEC-8.3] enqueue outside a tenant RLS context fails closed", async () => {
    expect(await reason(db.tx((tx) => outbox.enqueue(tx, msg(1)), { role: "app_runtime" }))).toBe("OUTBOX_TENANT_CONTEXT_REQUIRED");
  });

  it("[DATA-01] payloads carry opaque references only: names, phone numbers, dates of birth and free text are rejected", async () => {
    for (const payload of [
      { name: "Avery Synthetic-Client" },
      { phone: "+15555550101" },
      { dob: "1990-01-01" },
      { note: "please call me back" },
      { nested: { deeper: { deepest: { tooDeep: "x" } } } },
      { text: "a".repeat(201) },
    ]) {
      expect(await reason(inTenant((tx) => outbox.enqueue(tx, msg(1, { payload }))))).toMatch(/OUTBOX_PAYLOAD_NOT_OPAQUE/);
    }
    const ok = await inTenant((tx) =>
      outbox.enqueue(tx, msg(2, { payload: { caseId: "cas_synthCase0000000001", reasonCode: "SALESFORCE_UNAVAILABLE", count: 2, ok: true, refs: ["rcp_synthReceipt0000001"], at: "2026-10-17T15:00:00.000Z" } })),
    );
    expect(ok).toMatch(/^msg_/);
    expect(await reason(inTenant((tx) => outbox.enqueue(tx, msg(3, { topic: "unknown.topic" as never }))))).toBe("OUTBOX_MESSAGE_INVALID");
    expect(await reason(inTenant((tx) => outbox.enqueue(tx, { ...msg(4), extra: 1 } as never)))).toBe("OUTBOX_MESSAGE_INVALID");
  });

  it("[DATA-01] property: strings containing whitespace or 4+ digit runs are never accepted as opaque", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 40 }), (s) => {
        if (/\s/.test(s) || (/\d{4,}/.test(s) && !/^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$/.test(s) && !/^\d{4}-\d{2}-\d{2}T/.test(s) && !/^[a-f0-9]{64}$/.test(s))) {
          expect(isOpaquePayloadString(s)).toBe(false);
        }
      }),
      { seed: 23, numRuns: 500 },
    );
  });
});

describe("dispatcher", () => {
  it("[SPEC-8.3] dispatches PENDING messages once and marks them DISPATCHED", async () => {
    const ids = await inTenant(async (tx) => [await outbox.enqueue(tx, msg(1)), await outbox.enqueue(tx, msg(2))]);
    const d = dispatcherWith(publisher);
    expect(await d.runOnce()).toEqual({ dispatched: 2, failed: 0, deadLettered: 0 });
    expect(publisher.deliveries.map((x) => x.message.messageId).sort()).toEqual([...ids].sort());
    expect(await d.runOnce()).toEqual({ dispatched: 0, failed: 0, deadLettered: 0 });
    // OutboxMessage carries the tenant so consumers can set their RLS context.
    const delivered: OutboxMessage | undefined = publisher.deliveries[0]?.message;
    expect(delivered?.tenantId).toBe(TENANT_ID);
  });

  it("[SPEC-12.3] failures back off exponentially with deterministic jitter and dead-letter after max attempts", async () => {
    const id = await inTenant((tx) => outbox.enqueue(tx, msg(1)));
    const d = dispatcherWith(publisher);
    publisher.failMessage(id, 10);
    expect(await d.runOnce()).toEqual({ dispatched: 0, failed: 1, deadLettered: 0 });
    expect(await statusOf(id)).toEqual({ status: "PENDING", attempts: 1, last_error_code: "PUBLISH_FAILED" });
    // Not due yet: attempt 1 => window 1000ms, equal jitter with random 0.5 => 750ms.
    clock.advanceMs(749);
    expect((await d.runOnce()).failed).toBe(0);
    clock.advanceMs(1);
    expect((await d.runOnce()).failed).toBe(1);
    expect((await statusOf(id))?.attempts).toBe(2);
    clock.advanceMs(1_500);
    expect(await d.runOnce()).toEqual({ dispatched: 0, failed: 0, deadLettered: 1 });
    expect(await statusOf(id)).toMatchObject({ status: "DEAD", attempts: 3 });
    clock.advanceSeconds(3_600);
    expect(await d.runOnce()).toEqual({ dispatched: 0, failed: 0, deadLettered: 0 });
    expect(publisher.publishCalls).toBe(3);
  });

  it("[SPEC-8.4] operator repair: listDead shows dead letters and requeueDead returns them to PENDING with an audit record", async () => {
    await installAuditFixtureTable(db);
    const audit = new InTxAuditWriterFixture(db);
    const id = await inTenant((tx) => outbox.enqueue(tx, msg(1)));
    const d = dispatcherWith(publisher, { config: { maxAttempts: 1 }, audit });
    publisher.throwOnNextPublish();
    expect((await d.runOnce()).deadLettered).toBe(1);
    const dead = await d.listDead();
    expect(dead).toEqual([expect.objectContaining({ messageId: id, tenantId: TENANT_ID, lastErrorCode: "PUBLISH_EXCEPTION", attempts: 1 })]);
    expect(JSON.stringify(dead)).not.toContain("supportRequestId");
    expect(await d.requeueDead(id, { actorRef: "stf_synthSupervisor01", reasonCode: "OPERATOR_REQUEUE" })).toBe(true);
    expect(await d.requeueDead(id)).toBe(false);
    expect((await fixtureAuditRows(db, id)).map((r) => r.action)).toEqual(["outbox.requeue"]);
    // Per-instance audit stream (no shared chain head across dispatcher instances).
    const streams = await db.tx((tx) => tx.query<{ stream: string }>("select stream from test_fixture_audit_events where correlation_id = $1", [id]), { role: "owner" });
    expect(streams.rows.map((r) => r.stream)).toEqual([d.auditStream]);
    expect(d.auditStream).toMatch(/^outbox\.odi_[a-z0-9_-]+$/);
    expect(await d.runOnce()).toEqual({ dispatched: 1, failed: 0, deadLettered: 0 });
    expect(await d.listDead()).toEqual([]);
  });

  it("[OPS-01] requeue fails closed when the operator action cannot be audited", async () => {
    await installAuditFixtureTable(db);
    const audit = new InTxAuditWriterFixture(db);
    const id = await inTenant((tx) => outbox.enqueue(tx, msg(1)));
    const d = dispatcherWith(publisher, { config: { maxAttempts: 1 }, audit });
    publisher.throwOnNextPublish();
    await d.runOnce();
    audit.outage = true;
    expect(await reason(d.requeueDead(id, { actorRef: "stf_synthSupervisor01", reasonCode: "OPERATOR_REQUEUE" }))).toBe("AUDIT_FIXTURE_OUTAGE");
    expect((await statusOf(id))?.status).toBe("DEAD");
  });

  it("[FO-06-10][OPS-01] requeue fails closed without a composed audit writer or without an accountable operator", async () => {
    await installAuditFixtureTable(db);
    const id = await inTenant((tx) => outbox.enqueue(tx, msg(1)));
    const unaudited = dispatcherWith(publisher, { config: { maxAttempts: 1 } });
    publisher.throwOnNextPublish();
    await unaudited.runOnce();
    expect(await reason(unaudited.requeueDead(id, { actorRef: "stf_synthSupervisor01", reasonCode: "OPERATOR_REQUEUE" }))).toBe("OUTBOX_REQUEUE_AUDIT_NOT_CONFIGURED");
    const audited = dispatcherWith(publisher, { config: { maxAttempts: 1 }, audit: new InTxAuditWriterFixture(db) });
    expect(await reason(audited.requeueDead(id))).toBe("OUTBOX_REQUEUE_OPERATOR_REQUIRED");
    expect((await statusOf(id))?.status).toBe("DEAD");
    expect(await fixtureAuditRows(db, id)).toEqual([]);
  });

  it("[SPEC-12.3] a publish exception or an unreported message counts as failed (redelivery is safe, loss is not)", async () => {
    const ids = await inTenant(async (tx) => [await outbox.enqueue(tx, msg(1)), await outbox.enqueue(tx, msg(2))]);
    const d = dispatcherWith(publisher);
    publisher.throwOnNextPublish();
    expect((await d.runOnce()).failed).toBe(2);
    clock.advanceSeconds(5);
    const lossy: MessagePublisher = { kind: "local_fixture", publish: async (m) => ({ published: [m[0]?.messageId ?? ""], failed: [] }) };
    const r = await dispatcherWith(lossy).runOnce();
    expect(r).toEqual({ dispatched: 1, failed: 1, deadLettered: 0 });
    const codes = await Promise.all(ids.map(statusOf));
    expect(codes.map((c) => c?.last_error_code).sort()).toEqual(["PUBLISH_EXCEPTION", "PUBLISH_RESULT_MISSING"]);
  });

  it("[SPEC-8.3] per-key ordering: a later message for the same key waits until the earlier one is delivered", async () => {
    const [first, second] = await inTenant(async (tx) => {
      const a = await outbox.enqueue(tx, msg(1, { key: "case:cas_synthCase0000000001", dedupeKey: "ordered:1" }));
      clock.advanceMs(1);
      const b = await outbox.enqueue(tx, msg(2, { key: "case:cas_synthCase0000000001", dedupeKey: "ordered:2" }));
      return [a, b];
    });
    const d = dispatcherWith(publisher);
    publisher.failMessage(first ?? "", 1);
    expect(await d.runOnce()).toEqual({ dispatched: 0, failed: 1, deadLettered: 0 });
    expect(publisher.deliveryCount(second ?? "")).toBe(0);
    clock.advanceSeconds(2);
    expect((await d.runOnce()).dispatched).toBe(1);
    expect((await d.runOnce()).dispatched).toBe(1);
    expect(publisher.deliveries.map((x) => x.message.messageId)).toEqual([first, second]);
  });

  it("[ACT-02] a dispatcher crash between publish and settle redelivers after the lease; the consumer processes once", async () => {
    await db.exec(`create table test_consumer_effects (ref text primary key, applied int not null); grant select, insert, update on test_consumer_effects to app_worker;`);
    const id = await inTenant((tx) => outbox.enqueue(tx, msg(1)));
    const dedup = new PgConsumerDedup({ db, clock, tenantId: TENANT_ID });
    publisher.subscribe(async (m) => {
      await dedup.processOnce("sync-consumer", m.messageId, (tx) =>
        tx.query(
          "insert into test_consumer_effects (ref, applied) values ($1, 1) on conflict (ref) do update set applied = test_consumer_effects.applied + 1",
          [String(m.payload.supportRequestId)],
        ),
      );
    });
    // Publisher delivers, then the dispatcher "dies" before settling (settle transaction fails).
    const crashy: MessagePublisher = {
      kind: "local_fixture",
      publish: async (m) => {
        await publisher.publish(m);
        throw new Error("dispatcher crashed after publish");
      },
    };
    const d1 = new PgOutboxDispatcher({ db, publisher: crashy, clock, tenants: [TENANT_ID], random: () => 0.5, config: { leaseSeconds: 30, baseDelayMs: 100_000, maxDelayMs: 100_000 } });
    await d1.runOnce();
    expect(publisher.deliveryCount(id)).toBe(1);
    clock.advanceSeconds(120);
    expect((await dispatcherWith(publisher).runOnce()).dispatched).toBe(1);
    expect(publisher.deliveryCount(id)).toBe(2);
    const applied = await db.tx((tx) => tx.query<{ applied: number }>("select applied from test_consumer_effects"), { role: "owner" });
    expect(applied.rows).toEqual([{ applied: 1 }]);
  });

  it("[SPEC-8.3] a claimed message is skipped by a concurrent dispatcher while its lease is live (SKIP LOCKED + lease)", async () => {
    await inTenant((tx) => outbox.enqueue(tx, msg(1)));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slow: MessagePublisher = {
      kind: "local_fixture",
      publish: async (m) => {
        await gate;
        return publisher.publish(m);
      },
    };
    const first = dispatcherWith(slow).runOnce();
    await new Promise((r) => setTimeout(r, 50));
    expect(await dispatcherWith(publisher).runOnce()).toEqual({ dispatched: 0, failed: 0, deadLettered: 0 });
    release();
    expect((await first).dispatched).toBe(1);
    expect(publisher.deliveries).toHaveLength(1);
  });

  it("[AUTH-05] a dispatcher only serves its configured tenants", async () => {
    await inTenant((tx) => outbox.enqueue(tx, msg(1)), OTHER_TENANT_ID);
    expect((await dispatcherWith(publisher).runOnce()).dispatched).toBe(0);
    expect((await dispatcherWith(publisher, { tenants: [TENANT_ID, OTHER_TENANT_ID] }).runOnce()).dispatched).toBe(1);
  });

  it("[SPEC-12.3] property: backoff stays within the equal-jitter window and never exceeds the cap", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 60 }), fc.double({ min: 0, max: 1, noNaN: true }), (attempt, r) => {
        const policy = { baseDelayMs: 1_000, maxDelayMs: 300_000 };
        const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
        const d = computeBackoffMs(attempt, policy, () => r);
        expect(d).toBeGreaterThanOrEqual(Math.floor(exp / 2));
        expect(d).toBeLessThan(exp);
        expect(d).toBeLessThanOrEqual(policy.maxDelayMs);
        expect(computeBackoffMs(attempt, policy, () => r)).toBe(d);
      }),
      { seed: 29, numRuns: 400 },
    );
  });

  it("[SPEC-8.3] the MemoryPublisherFixture is labelled as a local fixture", () => {
    expect(publisher.kind).toBe("local_fixture");
    expect(publisher.badge).toMatch(/LOCAL FIXTURE/);
  });
});

describe("dispatcher audit stream", () => {
  it("[OPS-01] each dispatcher instance audits on its own stream auditStreamName('outbox', instanceId)", () => {
    const a = dispatcherWith(publisher, { instanceId: "ECS Task 7F3A" });
    const b = dispatcherWith(publisher, { instanceId: "task-0b12" });
    expect(a.auditStream).toBe("outbox.ecs-task-7f3a");
    expect(b.auditStream).toBe("outbox.task-0b12");
    expect(dispatcherWith(publisher).auditStream).not.toBe(dispatcherWith(publisher).auditStream);
  });
});

describe("consumer dedup", () => {
  it("[ACT-02] duplicate delivery is skipped; the dedupe row and the handler's effects commit atomically", async () => {
    const dedup = new PgConsumerDedup({ db, clock, tenantId: TENANT_ID });
    let runs = 0;
    const first = await dedup.processOnce("billing-consumer", "msg_synthMessage00000001", async () => {
      runs += 1;
      return "done";
    });
    const second = await dedup.processOnce("billing-consumer", "msg_synthMessage00000001", async () => {
      runs += 1;
      return "done";
    });
    expect(first).toEqual({ duplicate: false, result: "done" });
    expect(second).toEqual({ duplicate: true, result: null });
    expect(runs).toBe(1);
    // A different consumer of the same message processes it independently.
    expect((await dedup.processOnce("notify-consumer", "msg_synthMessage00000001", async () => 1)).duplicate).toBe(false);
  });

  it("[ACT-02] a failing handler rolls back its dedupe row so redelivery is processed", async () => {
    const dedup = new PgConsumerDedup({ db, clock, tenantId: TENANT_ID });
    await expect(
      dedup.processOnce("billing-consumer", "msg_synthMessage00000002", async () => {
        throw new Error("downstream unavailable");
      }),
    ).rejects.toThrow("downstream unavailable");
    expect((await dedup.processOnce("billing-consumer", "msg_synthMessage00000002", async () => "ok")).duplicate).toBe(false);
  });

  it("[ACT-02][AUTH-05] isProcessed is a tenant-scoped read-only pre-check", async () => {
    const dedup = new PgConsumerDedup({ db, clock, tenantId: TENANT_ID });
    expect(await dedup.isProcessed(TENANT_ID, "worker.action.committed", "msg_synthMessage00000009")).toBe(false);
    await dedup.processOnce("worker.action.committed", "msg_synthMessage00000009", async () => null);
    expect(await dedup.isProcessed(TENANT_ID, "worker.action.committed", "msg_synthMessage00000009")).toBe(true);
    expect(await dedup.isProcessed(TENANT_ID, "worker.notification.send", "msg_synthMessage00000009")).toBe(false);
    // Another tenant's context never sees the dedupe row.
    expect(await dedup.isProcessed(OTHER_TENANT_ID, "worker.action.committed", "msg_synthMessage00000009")).toBe(false);
    await expect(dedup.isProcessed("not a tenant", "worker.action.committed", "msg_synthMessage00000009")).rejects.toThrow("CONSUMER_TENANT_INVALID");
    await expect(dedup.isProcessed(TENANT_ID, "Bad Consumer", "msg_synthMessage00000009")).rejects.toThrow("CONSUMER_NAME_INVALID");
  });

  it("[SPEC-8.3] consumers require a tenant context and validate names", async () => {
    const noTenant = new PgConsumerDedup({ db, clock });
    expect(() => noTenant.processOnce("billing-consumer", "msg_synthMessage00000003", async () => 1)).toThrow("CONSUMER_TENANT_CONTEXT_REQUIRED");
    const dedup = new PgConsumerDedup({ db, clock, tenantId: TENANT_ID });
    await expect(dedup.processOnce("Bad Consumer", "msg_synthMessage00000003", async () => 1)).rejects.toThrow("CONSUMER_NAME_INVALID");
  });
});
