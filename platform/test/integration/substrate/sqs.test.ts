/**
 * Layer 2 (WP-04): SQS with a dead-letter queue on ElasticMQ, and its audited repair (FO-03-24, FO-06-10,
 * FO-19-07a; OPS-01, ACT-02). The production SqsPublisher publishes outbox envelopes to a queue whose redrive
 * policy dead-letters a message after maxReceiveCount receives; SqsDeadLetterRedrive moves dead-lettered
 * messages back only after appending an audit event in postgres:16 (refused when it cannot), bounded per
 * message; SqsDeadLetterWriter reports a refusing dead-letter queue (the DLQ_FULL seam) as a typed error.
 */
import { CreateQueueCommand, DeleteMessageCommand, GetQueueAttributesCommand, ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import type { Message, SQSClient } from "@aws-sdk/client-sqs";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { PgAuditWriter } from "../../../src/audit/writer.js";
import { SqsDeadLetterRedrive, SqsDeadLetterWriter } from "../../../src/outbox/sqs-dlq.js";
import { SqsPublisher } from "../../../src/outbox/sqs-publisher.js";
import type { OutboxMessage } from "../../../src/outbox/ports.js";
import { systemClock } from "../../../src/shared/clock.js";
import { newId } from "../../../src/shared/ids.js";
import { awsQueueUrl, sqsClient, uniqueName } from "../_harness/clients.js";
import { layer2, layer2Context } from "../_harness/layer2.js";
import { OVERSIZE_MESSAGE_BYTES, refusingDeadLetterQueue } from "./seams.js";
import { createAuroraLikeDb, sleep } from "./support.js";
import type { AuroraLikeDb } from "./support.js";

const it = layer2(["postgres", "elasticmq"]);
let adb: AuroraLikeDb;
let sqs: SQSClient;

async function queueWithDlq(maxReceiveCount = 2): Promise<{ source: string; dlq: string }> {
  const dlqName = uniqueName("vsp-it-dlq");
  await sqs.send(new CreateQueueCommand({ QueueName: dlqName }));
  const dlq = awsQueueUrl(dlqName);
  const arn = (await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlq, AttributeNames: ["QueueArn"] }))).Attributes?.QueueArn ?? "";
  const srcName = uniqueName("vsp-it-src");
  await sqs.send(new CreateQueueCommand({ QueueName: srcName, Attributes: { RedrivePolicy: JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: String(maxReceiveCount) }) } }));
  return { source: awsQueueUrl(srcName), dlq };
}

const message = (tenantId: string): OutboxMessage => ({
  messageId: newId("msg"),
  tenantId,
  topic: "support_request.sync",
  key: `k:${newId("sr")}`,
  payload: { supportRequestId: newId("sr") },
  dedupeKey: `it:${newId("ddk")}`,
  attempts: 0,
  createdAt: new Date().toISOString(),
});

async function receive(url: string, visibility = 1, wait = 1): Promise<Message[]> {
  return (await sqs.send(new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10, VisibilityTimeout: visibility, WaitTimeSeconds: wait, MessageAttributeNames: ["All"] }))).Messages ?? [];
}

/** Receives (without deleting) until the redrive policy has moved the message to the DLQ. */
async function poisonUntilDeadLettered(source: string, dlq: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await receive(source, 1, 1);
    const attrs = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlq, AttributeNames: ["ApproximateNumberOfMessages"] }));
    if (Number(attrs.Attributes?.ApproximateNumberOfMessages ?? 0) > 0) return;
    await sleep(1_100);
  }
  throw new Error("message never reached the DLQ");
}

async function auditActions(tenantId: string): Promise<string[]> {
  const r = await adb.db.tx((tx) => tx.query<{ action: string; outcome: string }>("select action, event ->> 'outcome' as outcome from audit_outbox where tenant_id = app_tenant() order by recorded_at, sequence"), { role: "app_worker", rls: { tenantId } });
  return r.rows.map((x) => `${x.action}:${x.outcome}`);
}

describe("SQS dead-letter queue and audited redrive on ElasticMQ", () => {
  beforeAll(async () => {
    const l2 = layer2Context(["postgres", "elasticmq"]);
    adb = await createAuroraLikeDb(l2);
    sqs = sqsClient(l2);
  });
  afterAll(async () => {
    await adb?.drop();
  });

  it("[FO-03-24][FO-06-10][OPS-01] a poison message dead-letters after maxReceiveCount; an audited redrive moves it back once, with its redrive count; the intent is audited before the move and the completion after it", async () => {
    const { source, dlq } = await queueWithDlq(2);
    const tenantId = newId("tnt");
    const m = message(tenantId);
    expect((await new SqsPublisher({ client: sqs, queueUrl: source, fifo: false }).publish([m])).published).toEqual([m.messageId]);
    await poisonUntilDeadLettered(source, dlq);
    const audit = new PgAuditWriter({ db: adb.db, clock: systemClock, stream: "worker.dlq-it", standaloneRole: "app_worker" });
    const redrive = new SqsDeadLetterRedrive({ client: sqs, deadLetterQueueUrl: dlq, sourceQueueUrl: source, audit, clock: systemClock });
    const seen = await redrive.inspect(5);
    expect(seen).toEqual([expect.objectContaining({ outboxMessageId: m.messageId, tenantId, topic: "support_request.sync", redriveCount: 0 })]);
    await sleep(1_200); // inspected messages become visible again
    const r = await redrive.redrive({ maxMessages: 10, operator: { staffRef: "stf_synthSupervisor01", reasonCode: "CONSUMER_DEFECT_FIXED" } });
    expect(r).toEqual({ redriven: 1, exhausted: 0, unrecognized: 0, stoppedBy: null });
    expect(await auditActions(tenantId)).toEqual(["outbox.dlq_redrive:PENDING", "outbox.dlq_redrive.completed:SUCCEEDED"]);
    const back = await receive(source, 30, 2);
    expect(back).toHaveLength(1);
    expect(JSON.parse(back[0]?.Body ?? "{}").messageId).toBe(m.messageId);
    expect(back[0]?.MessageAttributes?.["vsp-redrive-count"]?.StringValue).toBe("1");
    await sqs.send(new DeleteMessageCommand({ QueueUrl: source, ReceiptHandle: back[0]?.ReceiptHandle }));
    expect(await receive(dlq, 1, 1)).toEqual([]);
  });

  it("[FO-06-10][OPS-01] a redrive whose audit write fails is refused: the message stays in the DLQ, nothing reaches the source queue", async () => {
    const { source, dlq } = await queueWithDlq(1);
    const tenantId = newId("tnt");
    await new SqsPublisher({ client: sqs, queueUrl: source, fifo: false }).publish([message(tenantId)]);
    await poisonUntilDeadLettered(source, dlq);
    await adb.migrator.exec("revoke insert on audit_outbox from app_worker");
    try {
      const audit = new PgAuditWriter({ db: adb.db, clock: systemClock, stream: "worker.dlq-it-refused", standaloneRole: "app_worker" });
      const r = await new SqsDeadLetterRedrive({ client: sqs, deadLetterQueueUrl: dlq, sourceQueueUrl: source, audit, clock: systemClock }).redrive({ maxMessages: 5, operator: { staffRef: "stf_synthSupervisor01", reasonCode: "DEPENDENCY_RECOVERED" } });
      expect(r.redriven).toBe(0);
      expect(r.stoppedBy).toBe("AUDIT_STORE_UNWRITABLE");
    } finally {
      await adb.migrator.exec("grant insert on audit_outbox to app_worker");
    }
    expect(await receive(source, 1, 1)).toEqual([]);
    const attrs = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlq, AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"] }));
    expect(Number(attrs.Attributes?.ApproximateNumberOfMessages ?? 0) + Number(attrs.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0)).toBe(1);
  });

  it("[FO-06-10][OPS-01] a redrive whose move fails is audited as FAILED, never as a success: the message stays in the DLQ", async () => {
    const { source, dlq } = await queueWithDlq(1);
    const tenantId = newId("tnt");
    await new SqsPublisher({ client: sqs, queueUrl: source, fifo: false }).publish([message(tenantId)]);
    await poisonUntilDeadLettered(source, dlq);
    // The source queue is gone (deleted by mistake): the send is refused by SQS.
    const missingSource = awsQueueUrl(uniqueName("vsp-it-src-missing"));
    const audit = new PgAuditWriter({ db: adb.db, clock: systemClock, stream: "worker.dlq-it-sendfail", standaloneRole: "app_worker" });
    const r = await new SqsDeadLetterRedrive({ client: sqs, deadLetterQueueUrl: dlq, sourceQueueUrl: missingSource, audit, clock: systemClock }).redrive({ maxMessages: 5, operator: { staffRef: "stf_synthSupervisor01", reasonCode: "DEPENDENCY_RECOVERED" } });
    expect(r).toMatchObject({ redriven: 0, stoppedBy: "SQS_DLQ_REDRIVE_SEND_FAILED" });
    expect(await auditActions(tenantId)).toEqual(["outbox.dlq_redrive:PENDING", "outbox.dlq_redrive.completed:FAILED"]);
    // Still in the DLQ (invisible for the redrive's visibility timeout, then deliverable again).
    const attrs = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlq, AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"] }));
    expect(Number(attrs.Attributes?.ApproximateNumberOfMessages ?? 0) + Number(attrs.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0)).toBe(1);
  });

  it("[FO-06-10][ACT-02] redrive is bounded: a message already redriven maxRedrives times stays in the DLQ and is reported", async () => {
    const { source, dlq } = await queueWithDlq(1);
    const tenantId = newId("tnt");
    await new SqsPublisher({ client: sqs, queueUrl: source, fifo: false }).publish([message(tenantId)]);
    const audit = new PgAuditWriter({ db: adb.db, clock: systemClock, stream: "worker.dlq-it-bounded", standaloneRole: "app_worker" });
    const redrive = new SqsDeadLetterRedrive({ client: sqs, deadLetterQueueUrl: dlq, sourceQueueUrl: source, audit, clock: systemClock, maxRedrives: 1 });
    await poisonUntilDeadLettered(source, dlq);
    expect((await redrive.redrive({ maxMessages: 5, operator: { staffRef: "stf_synthSupervisor01", reasonCode: "DEPENDENCY_RECOVERED" } })).redriven).toBe(1);
    await poisonUntilDeadLettered(source, dlq); // still poison: dead-lettered again
    const r = await redrive.redrive({ maxMessages: 5, operator: { staffRef: "stf_synthSupervisor01", reasonCode: "DEPENDENCY_RECOVERED" } });
    expect(r).toMatchObject({ redriven: 0, exhausted: 1 });
    await expect(redrive.redrive({ maxMessages: 5, operator: { staffRef: "stf_synthSupervisor01", reasonCode: "JUST_BECAUSE" } })).rejects.toThrow("SQS_DLQ_REASON_NOT_ALLOWED");
    // An operator ref the audit record could not carry is refused before anything moves.
    await expect(redrive.redrive({ maxMessages: 5, operator: { staffRef: "stf_short123", reasonCode: "DEPENDENCY_RECOVERED" } })).rejects.toThrow("SQS_DLQ_OPERATOR_INVALID");
  });

  it("[FAULT:DLQ_FULL seam][OPS-03] a dead-letter queue that refuses the write (deleted, or a message over the size limit) is a typed DLQ_WRITE_REFUSED, never a silent drop", async () => {
    const missing = new SqsDeadLetterWriter(sqs, await refusingDeadLetterQueue(sqs, "missing"));
    await expect(missing.write("x".repeat(100), { reasonCode: "CONSUMER_GAVE_UP" })).rejects.toMatchObject({ reasonCode: "DLQ_WRITE_REFUSED" });
    const sized = new SqsDeadLetterWriter(sqs, await refusingDeadLetterQueue(sqs, "oversize"));
    await expect(sized.write("x".repeat(OVERSIZE_MESSAGE_BYTES), { reasonCode: "CONSUMER_GAVE_UP" })).rejects.toMatchObject({ reasonCode: "DLQ_WRITE_REFUSED" });
    // The same queue accepts a normal dead letter: the refusal is the fault, not a broken writer.
    expect(await sized.write("x".repeat(4_000), { reasonCode: "CONSUMER_GAVE_UP" })).toBeTruthy();
  });
});
