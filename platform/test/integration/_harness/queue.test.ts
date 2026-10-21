/**
 * Layer 2, FO-16-16 (queue half): the production outbox path over real protocols. PgOutbox enqueues in
 * PostgreSQL, two PgOutboxDispatcher instances claim concurrently (FOR UPDATE SKIP LOCKED over separate
 * connections) and publish through the production SqsPublisher to ElasticMQ; consumers deduplicate
 * with the production PgConsumerDedup across redelivery, a crash before delete, a handler failure and
 * dead-lettering.
 *
 * The concurrent-dispatch test counts what each dispatcher hands to the publisher. Neither the queue
 * nor the outbox table can show a double claim: FIFO deduplication drops the second copy, and settle()
 * counts only rows whose claim token still matches. The hand-off count can. Its first round forces the
 * two claims to overlap (dispatcher A's claim transaction stays open until B's claim has run), so the
 * check does not depend on scheduling luck.
 */
import { CreateQueueCommand, DeleteMessageCommand, GetQueueAttributesCommand, ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import type { Message, SQSClient } from "@aws-sdk/client-sqs";
import { afterAll, beforeAll, describe, expect } from "vitest";
import type { PgPoolDb } from "../../../src/db/pg.js";
import type { Db, Queryable, QueryResult, TxOptions } from "../../../src/db/types.js";
import { PgConsumerDedup } from "../../../src/outbox/consumer-dedup.js";
import { PgOutboxDispatcher } from "../../../src/outbox/dispatcher.js";
import { PgOutbox } from "../../../src/outbox/outbox.js";
import type { MessagePublisher, OutboxMessage } from "../../../src/outbox/ports.js";
import { OUTBOX_ENVELOPE_SCHEMA, SqsPublisher } from "../../../src/outbox/sqs-publisher.js";
import { systemClock } from "../../../src/shared/clock.js";
import { newId } from "../../../src/shared/ids.js";
import { awsQueueUrl, createIntegrationDb, sqsClient, uniqueName } from "./clients.js";
import type { IntegrationDb } from "./clients.js";
import { layer2, layer2Context } from "./layer2.js";

const it = layer2(["postgres", "elasticmq"]);
const outbox = new PgOutbox({ clock: systemClock });

let idb: IntegrationDb;
let db: PgPoolDb;
let sqs: SQSClient;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function createQueue(name: string, attributes: Record<string, string> = {}): Promise<string> {
  await sqs.send(new CreateQueueCommand({ QueueName: name, Attributes: attributes }));
  return awsQueueUrl(name);
}

async function queueArn(url: string): Promise<string> {
  const a = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ["QueueArn"] }));
  return a.Attributes?.QueueArn ?? "";
}

async function receive(url: string, opts: { visibility?: number; max?: number; waitSeconds?: number } = {}): Promise<Message[]> {
  const r = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: url,
      MaxNumberOfMessages: opts.max ?? 10,
      WaitTimeSeconds: opts.waitSeconds ?? 1,
      VisibilityTimeout: opts.visibility,
      MessageSystemAttributeNames: ["ApproximateReceiveCount"],
    }),
  );
  return r.Messages ?? [];
}

async function drain(url: string, expected: number, timeoutMs = 15_000): Promise<Message[]> {
  const got: Message[] = [];
  const deadline = Date.now() + timeoutMs;
  while (got.length < expected && Date.now() < deadline) {
    for (const m of await receive(url)) {
      got.push(m);
      await sqs.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: m.ReceiptHandle }));
    }
  }
  // One more empty poll proves nothing extra was delivered.
  got.push(...(await receive(url, { waitSeconds: 1 })));
  return got;
}

const envelope = (m: Message) => JSON.parse(m.Body ?? "{}") as { schema: string; messageId: string; tenantId: string };

async function enqueue(tenantId: string, n: number): Promise<string[]> {
  return db.tx(
    async (tx) => {
      const ids: string[] = [];
      for (let i = 0; i < n; i++) ids.push(await outbox.enqueue(tx, { topic: "action.committed", key: `k:${newId("act")}`, payload: { actionId: newId("act") }, dedupeKey: `it:${newId("ddk")}` }));
      return ids;
    },
    { role: "app_runtime", rls: { tenantId } },
  );
}

/**
 * Records the message ids a dispatcher hands to the publisher, then delegates to the production
 * SqsPublisher unchanged (the messages still reach ElasticMQ over the SQS protocol). Not a unit fake:
 * it observes the hand-off that FIFO deduplication and the claim-token check in settle() would hide.
 */
class HandOffRecorder implements MessagePublisher {
  readonly handed: string[] = [];
  constructor(private readonly inner: MessagePublisher) {}
  get kind(): MessagePublisher["kind"] {
    return this.inner.kind;
  }
  publish(messages: OutboxMessage[]): Promise<{ published: string[]; failed: string[] }> {
    this.handed.push(...messages.map((m) => m.messageId));
    return this.inner.publish(messages);
  }
}

/** The dispatcher's claim statement (PgOutboxDispatcher.claim): `with due as (select ... ) update ...`. */
const CLAIM_SQL = /^\s*with due as \(/;

/**
 * Interleaving seam around the real PgPoolDb: every statement runs unchanged on the production
 * transaction; after a transaction's claim statement returns (row locks still held, nothing committed)
 * `afterClaim` runs before the dispatcher continues to commit. Not a unit fake: it only orders the two
 * dispatchers' transactions so that their claims overlap deterministically.
 */
class ClaimGate implements Db {
  readonly engine = "pg" as const;
  constructor(
    private readonly inner: Db,
    private readonly afterClaim: () => Promise<void>,
  ) {}
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    return this.inner.query<T>(sql, params);
  }
  exec(sql: string): Promise<void> {
    return this.inner.exec(sql);
  }
  tx<T>(fn: (tx: Queryable) => Promise<T>, opts?: TxOptions): Promise<T> {
    const afterClaim = this.afterClaim;
    return this.inner.tx(
      (tx) =>
        fn({
          async query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<R>> {
            const r = await tx.query<R>(sql, params);
            if (CLAIM_SQL.test(sql)) await afterClaim();
            return r;
          },
          exec: (sql: string) => tx.exec(sql),
        }),
      opts,
    );
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

const outboxMessage = (tenantId: string): OutboxMessage => ({
  messageId: newId("msg"),
  tenantId,
  topic: "action.committed",
  key: `k:${newId("act")}`,
  payload: { actionId: newId("act") },
  dedupeKey: `it:${newId("ddk")}`,
  attempts: 0,
  createdAt: new Date().toISOString(),
});

describe("outbox over SQS (ElasticMQ) with redelivery", () => {
  beforeAll(async () => {
    const l2 = layer2Context(["postgres", "elasticmq"]);
    idb = await createIntegrationDb(l2, 10);
    db = idb.db;
    sqs = sqsClient(l2);
  });
  afterAll(async () => {
    await idb?.drop();
  });

  it("[FO-16-16][ACT-02] two concurrent dispatchers publish every outbox message exactly once to a FIFO queue", async () => {
    const tenant = newId("tnt");
    const ids = await enqueue(tenant, 12);
    const url = await createQueue(`${uniqueName("vsp-it-outbox")}.fifo`, { FifoQueue: "true" });
    const sqsPublisher = new SqsPublisher({ client: sqs, queueUrl: url, fifo: true });
    expect(sqsPublisher.kind).toBe("live");
    const handA = new HandOffRecorder(sqsPublisher);
    const handB = new HandOffRecorder(sqsPublisher);

    // Round 1 is forced to overlap: A's claim transaction (its row locks held, nothing committed) waits
    // until B's claim statement has finished or is waiting for one of A's row locks.
    let releaseAClaimed: () => void = () => undefined;
    const aClaimed = new Promise<void>((resolve) => (releaseAClaimed = resolve));
    let gateArmed = true;
    let bClaimsFinished = 0;
    let bWaitedForRowLock = false;
    const waitForB = async () => {
      const deadline = Date.now() + 4_000;
      while (bClaimsFinished === 0) {
        const r = await db.query<{ n: number }>(
          "select count(*)::int as n from pg_stat_activity where pid <> pg_backend_pid() and datname = current_database() and wait_event_type = 'Lock' and query ~ '^\\s*with due as \\('",
        );
        if ((r.rows[0]?.n ?? 0) > 0) {
          bWaitedForRowLock = true;
          return;
        }
        if (Date.now() > deadline) throw new Error("CLAIM_GATE: dispatcher B neither finished its claim nor waited for a row lock while A held its claim open");
        await sleep(10);
      }
    };
    const dbA = new ClaimGate(db, async () => {
      if (!gateArmed) return;
      gateArmed = false;
      releaseAClaimed();
      await waitForB();
    });
    const dbB = new ClaimGate(db, async () => {
      bClaimsFinished += 1;
    });
    const dispatcher = (gated: Db, publisher: MessagePublisher) => new PgOutboxDispatcher({ db: gated, publisher, clock: systemClock, tenants: [tenant], config: { batchSize: 4 } });
    const a = dispatcher(dbA, handA);
    const b = dispatcher(dbB, handB);
    const firstA = a.runOnce();
    await Promise.race([aClaimed, firstA.then(() => Promise.reject(new Error("CLAIM_GATE: the dispatcher's claim statement was not recognized")))]);
    const [r1a, r1b] = await Promise.all([firstA, b.runOnce()]);
    expect(r1a.failed + r1b.failed).toBe(0);
    expect(handA.handed, "A handed its claimed batch").toHaveLength(4);
    expect(handB.handed.filter((id) => handA.handed.includes(id)), "rows A held were re-claimed and handed again by B").toEqual([]);
    expect(handB.handed, "B claimed the next batch").toHaveLength(4);
    expect(bWaitedForRowLock, "SKIP LOCKED: B's claim never waits for the rows A holds").toBe(false);
    let dispatched = r1a.dispatched + r1b.dispatched;

    // Later rounds run with natural scheduling.
    for (let round = 0; round < 10 && dispatched < ids.length; round++) {
      const [ra, rb] = await Promise.all([a.runOnce(), b.runOnce()]);
      expect(ra.failed + rb.failed).toBe(0);
      dispatched += ra.dispatched + rb.dispatched;
    }
    expect(dispatched).toBe(ids.length);
    // Each row was claimed by exactly one dispatcher and handed to the publisher exactly once: the two
    // claims partition the rows (SKIP LOCKED) instead of both publishing a row.
    expect(handA.handed.filter((id) => handB.handed.includes(id)), "rows handed to the publisher by both dispatchers").toEqual([]);
    expect([...handA.handed, ...handB.handed].sort(), "publisher hand-offs, one per outbox row").toEqual([...ids].sort());
    expect(handA.handed.length > 0 && handB.handed.length > 0, "both dispatchers claimed work").toBe(true);
    const delivered = (await drain(url, ids.length)).map(envelope);
    expect(delivered.every((e) => e.schema === OUTBOX_ENVELOPE_SCHEMA && e.tenantId === tenant)).toBe(true);
    expect(delivered.map((e) => e.messageId).sort()).toEqual([...ids].sort());
    const states = await db.tx((tx) => tx.query<{ status: string }>("select status from outbox_messages where tenant_id = app_tenant()"), { role: "app_worker", rls: { tenantId: tenant } });
    expect(states.rows.every((r) => r.status === "DISPATCHED")).toBe(true);
  });

  it("[FO-16-16][ACT-02] a re-publish after a crash between publish and settle is dropped by FIFO deduplication", async () => {
    const tenant = newId("tnt");
    const url = await createQueue(`${uniqueName("vsp-it-dedupe")}.fifo`, { FifoQueue: "true" });
    const publisher = new SqsPublisher({ client: sqs, queueUrl: url, fifo: true });
    const m = outboxMessage(tenant);
    expect((await publisher.publish([m])).published).toEqual([m.messageId]);
    // Same logical message published again (the lease expired before the dispatcher settled it).
    expect((await publisher.publish([{ ...m, attempts: 1 }])).published).toEqual([m.messageId]);
    const delivered = await drain(url, 1, 4_000);
    expect(delivered.map((x) => envelope(x).messageId)).toEqual([m.messageId]);
  });

  it("[FO-16-16][ACT-02] redelivery after a consumer crash before DeleteMessage runs the handler once (PgConsumerDedup)", async () => {
    const tenant = newId("tnt");
    const url = await createQueue(uniqueName("vsp-it-redeliver"));
    const publisher = new SqsPublisher({ client: sqs, queueUrl: url, fifo: false });
    const m = outboxMessage(tenant);
    await publisher.publish([m]);
    const dedup = new PgConsumerDedup({ db, clock: systemClock });
    let effects = 0;
    const handle = (msg: Message) => dedup.processOnceForTenant(envelope(msg).tenantId, "it.consumer", envelope(msg).messageId, async () => {
      effects += 1;
      return "done";
    });
    const first = await receive(url, { visibility: 1, waitSeconds: 2 });
    expect(first).toHaveLength(1);
    expect((await handle(first[0] as Message)).duplicate).toBe(false);
    // Crash: no DeleteMessage. The visibility timeout expires and SQS redelivers.
    await sleep(1_500);
    let second: Message[] = [];
    for (let i = 0; i < 10 && second.length === 0; i++) second = await receive(url, { visibility: 5, waitSeconds: 1 });
    expect(second).toHaveLength(1);
    expect(second[0]?.Attributes?.ApproximateReceiveCount).toBe("2");
    expect(await handle(second[0] as Message)).toEqual({ duplicate: true, result: null });
    await sqs.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: second[0]?.ReceiptHandle }));
    expect(effects).toBe(1);
    expect(await dedup.isProcessed(tenant, "it.consumer", m.messageId)).toBe(true);
  });

  it("[FO-16-16][ACT-02] a handler failure rolls back the dedupe record, so the redelivered copy is processed exactly once", async () => {
    const tenant = newId("tnt");
    const url = await createQueue(uniqueName("vsp-it-retry"));
    await new SqsPublisher({ client: sqs, queueUrl: url, fifo: false }).publish([outboxMessage(tenant)]);
    const dedup = new PgConsumerDedup({ db, clock: systemClock });
    let calls = 0;
    let effects = 0;
    const handle = (msg: Message) =>
      dedup.processOnceForTenant(envelope(msg).tenantId, "it.flaky", envelope(msg).messageId, async (tx) => {
        calls += 1;
        await tx.query("select 1");
        if (calls === 1) throw new Error("synthetic handler failure before commit");
        effects += 1;
        return calls;
      });
    const first = await receive(url, { visibility: 1, waitSeconds: 2 });
    await expect(handle(first[0] as Message)).rejects.toThrow(/synthetic handler failure/);
    expect(await dedup.isProcessed(tenant, "it.flaky", envelope(first[0] as Message).messageId)).toBe(false);
    await sleep(1_500);
    let again: Message[] = [];
    for (let i = 0; i < 10 && again.length === 0; i++) again = await receive(url, { visibility: 5, waitSeconds: 1 });
    expect((await handle(again[0] as Message)).duplicate).toBe(false);
    await sqs.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: again[0]?.ReceiptHandle }));
    expect(effects).toBe(1);
  });

  it("[FO-16-16] a message never deleted moves to the dead-letter queue after maxReceiveCount receives", async () => {
    const dlq = await createQueue(uniqueName("vsp-it-dlq"));
    const url = await createQueue(uniqueName("vsp-it-poison"), { RedrivePolicy: JSON.stringify({ deadLetterTargetArn: await queueArn(dlq), maxReceiveCount: "2" }) });
    const m = outboxMessage(newId("tnt"));
    await new SqsPublisher({ client: sqs, queueUrl: url, fifo: false }).publish([m]);
    let receives = 0;
    const deadline = Date.now() + 15_000;
    let dead: Message[] = [];
    while (Date.now() < deadline && dead.length === 0) {
      receives += (await receive(url, { visibility: 1, waitSeconds: 1 })).length;
      dead = await receive(dlq, { waitSeconds: 0 });
      if (dead.length === 0) await sleep(1_100);
    }
    expect(receives).toBe(2);
    expect(dead.map((x) => envelope(x).messageId)).toEqual([m.messageId]);
  });
});
