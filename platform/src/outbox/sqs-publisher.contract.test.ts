/**
 * CONTRACT TEST (stub client, no AWS access): asserts the exact SendMessageBatch input the live
 * SqsPublisher builds and how it maps per-entry results. Real SQS execution is BLOCKED pending
 * an approved AWS account, queue and IAM role.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import type { SendMessageBatchCommandOutput } from "@aws-sdk/client-sqs";
import { createTestDb } from "../db/testing.js";
import type { PgliteDb } from "../db/pglite.js";
import { TENANT_ID } from "../fixtures/synthetic-world.js";
import { sha256Hex } from "../shared/canonical.js";
import { FakeClock } from "../shared/clock.js";
import { PgOutboxDispatcher } from "./dispatcher.js";
import { PgOutbox } from "./outbox.js";
import type { OutboxMessage } from "./ports.js";
import { OUTBOX_ENVELOPE_SCHEMA, SqsPublisher } from "./sqs-publisher.js";
import type { SqsBatchClient } from "./sqs-publisher.js";

const FIFO_URL = "https://sqs.us-east-1.amazonaws.com/123456789012/vsp-outbox-local.fifo";
const STD_URL = "https://sqs.us-east-1.amazonaws.com/123456789012/vsp-outbox-local";

class StubSqsClient implements SqsBatchClient {
  readonly commands: SendMessageBatchCommand[] = [];
  failIds = new Set<string>();
  throwOnCall = new Set<number>();
  omitIds = new Set<string>();
  async send(command: SendMessageBatchCommand): Promise<SendMessageBatchCommandOutput> {
    this.commands.push(command);
    if (this.throwOnCall.has(this.commands.length)) throw new Error("ServiceUnavailable");
    const entries = command.input.Entries ?? [];
    return {
      $metadata: {},
      Successful: entries
        .filter((e) => !this.failIds.has(e.Id ?? "") && !this.omitIds.has(e.Id ?? ""))
        .map((e) => ({ Id: e.Id, MessageId: `sqs-${e.Id}`, MD5OfMessageBody: "stub" })),
      Failed: entries.filter((e) => this.failIds.has(e.Id ?? "")).map((e) => ({ Id: e.Id, SenderFault: false, Code: "InternalError" })),
    };
  }
}

const message = (n: number): OutboxMessage & { tenantId: string } => ({
  messageId: `msg_synthMessage${String(n).padStart(8, "0")}`,
  tenantId: TENANT_ID,
  topic: "action.committed",
  key: `scheduling:apt_synthAveryAppt0000${n % 2}`,
  payload: { actionId: `act_synthAction${String(n).padStart(9, "0")}` },
  dedupeKey: `action.committed:act_synthAction${String(n).padStart(9, "0")}`,
  attempts: 0,
  createdAt: "2026-10-17T15:00:00.000Z",
});

describe("SqsPublisher (CONTRACT, stub client)", () => {
  it("[SPEC-8.3] CONTRACT: FIFO SendMessageBatch input carries QueueUrl, envelope body, MessageGroupId=key and a stable MessageDeduplicationId", async () => {
    const client = new StubSqsClient();
    const pub = new SqsPublisher({ client, queueUrl: FIFO_URL, fifo: true });
    expect(pub.kind).toBe("live");
    const r = await pub.publish([message(1), message(2)]);
    expect(r).toEqual({ published: [message(1).messageId, message(2).messageId], failed: [] });
    expect(client.commands).toHaveLength(1);
    const cmd = client.commands[0];
    expect(cmd).toBeInstanceOf(SendMessageBatchCommand);
    expect(cmd?.input).toEqual({
      QueueUrl: FIFO_URL,
      Entries: [1, 2].map((n, i) => ({
        Id: `e${i}`,
        MessageBody: JSON.stringify({
          schema: OUTBOX_ENVELOPE_SCHEMA,
          messageId: message(n).messageId,
          tenantId: TENANT_ID,
          topic: "action.committed",
          key: message(n).key,
          dedupeKey: message(n).dedupeKey,
          attempts: 0,
          createdAt: "2026-10-17T15:00:00.000Z",
          payload: message(n).payload,
        }),
        MessageAttributes: { topic: { DataType: "String", StringValue: "action.committed" } },
        MessageGroupId: message(n).key,
        MessageDeduplicationId: sha256Hex(`vsp.outbox.dedupe.v1:${message(n).dedupeKey}`),
      })),
    });
  });

  it("[SPEC-8.3] CONTRACT: standard queues omit FIFO-only attributes", async () => {
    const client = new StubSqsClient();
    await new SqsPublisher({ client, queueUrl: STD_URL, fifo: false }).publish([message(1)]);
    const entry = client.commands[0]?.input.Entries?.[0];
    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty("MessageGroupId");
    expect(entry).not.toHaveProperty("MessageDeduplicationId");
  });

  it("[SPEC-8.3] CONTRACT: batches are at most 10 entries; partial failures, omitted entries and batch exceptions map to failed ids", async () => {
    const client = new StubSqsClient();
    client.failIds.add("e3");
    client.omitIds.add("e5");
    client.throwOnCall.add(2);
    const msgs = Array.from({ length: 23 }, (_, i) => message(i));
    const r = await new SqsPublisher({ client, queueUrl: FIFO_URL, fifo: true }).publish(msgs);
    expect(client.commands.map((c) => c.input.Entries?.length)).toEqual([10, 10, 3]);
    // Batch 1: e3 failed, e5 omitted from the response; batch 2 threw; batch 3 (3 entries) all succeeded.
    const expectedFailed = [msgs[3], msgs[5], ...msgs.slice(10, 20)].filter((m): m is NonNullable<typeof m> => !!m).map((m) => m.messageId);
    expect(new Set(r.failed)).toEqual(new Set(expectedFailed));
    expect(r.published.length + r.failed.length).toBe(23);
    expect(r.published).not.toContain(msgs[3]?.messageId);
  });

  it("[OPS-04] construction rejects malformed queue URLs and FIFO mismatches", () => {
    const client = new StubSqsClient();
    expect(() => new SqsPublisher({ client, queueUrl: "https://example.invalid/q", fifo: false })).toThrow("SQS_QUEUE_URL_INVALID");
    expect(() => new SqsPublisher({ client, queueUrl: FIFO_URL, fifo: false })).toThrow("SQS_QUEUE_FIFO_MISMATCH");
    expect(() => new SqsPublisher({ client, queueUrl: STD_URL, fifo: true })).toThrow("SQS_QUEUE_FIFO_MISMATCH");
  });
});

describe("SqsPublisher with the outbox dispatcher (CONTRACT, stub client)", () => {
  let db: PgliteDb;
  beforeEach(async () => {
    db = await createTestDb({ include: /^01/ });
  });
  afterEach(async () => {
    await db.close();
  });

  it("[SPEC-12.3] CONTRACT: a partially failed batch retries only the failed message with the same deduplication id", async () => {
    const clock = new FakeClock();
    const outbox = new PgOutbox({ clock });
    const ids = await db.tx(
      async (tx) => [
        await outbox.enqueue(tx, { topic: "notification.send", key: "ntf:a", payload: { notificationId: "ntf_synthNotification01" }, dedupeKey: "notification.send:1" }),
        await outbox.enqueue(tx, { topic: "notification.send", key: "ntf:b", payload: { notificationId: "ntf_synthNotification02" }, dedupeKey: "notification.send:2" }),
      ],
      { role: "app_runtime", rls: { tenantId: TENANT_ID } },
    );
    const client = new StubSqsClient();
    client.failIds.add("e1");
    const d = new PgOutboxDispatcher({ db, publisher: new SqsPublisher({ client, queueUrl: FIFO_URL, fifo: true }), clock, tenants: [TENANT_ID], random: () => 0 });
    expect(await d.runOnce()).toEqual({ dispatched: 1, failed: 1, deadLettered: 0 });
    client.failIds.clear();
    clock.advanceSeconds(2);
    expect(await d.runOnce()).toEqual({ dispatched: 1, failed: 0, deadLettered: 0 });
    const firstBody = JSON.parse(client.commands[0]?.input.Entries?.[1]?.MessageBody ?? "{}") as { messageId: string };
    const retryBody = JSON.parse(client.commands[1]?.input.Entries?.[0]?.MessageBody ?? "{}") as { messageId: string };
    expect(retryBody.messageId).toBe(firstBody.messageId);
    expect(ids).toContain(retryBody.messageId);
    expect(client.commands[1]?.input.Entries?.[0]?.MessageDeduplicationId).toBe(client.commands[0]?.input.Entries?.[1]?.MessageDeduplicationId);
  });
});
