/**
 * LIVE adapter: Amazon SQS publisher using the documented SendMessageBatch API
 * (AWS SDK for JavaScript v3, @aws-sdk/client-sqs). At most 10 entries per batch; partial
 * batch failures are reported per entry and mapped back to outbox message ids. FIFO queues get
 * MessageGroupId (per-aggregate ordering) and MessageDeduplicationId (stable per logical
 * message) so a re-published message inside the SQS deduplication window is dropped by SQS.
 *
 * BLOCKED for real execution: no AWS account, queue, IAM role or approval exists for this
 * repository. It is verified only by a contract test with an injected stub client. Delivery is
 * still at least once (standard queues, redrive, visibility timeouts), so consumers deduplicate.
 */
import { SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import type { SendMessageBatchCommandOutput, SendMessageBatchRequestEntry } from "@aws-sdk/client-sqs";
import type { Logger } from "../observability/ports.js";
import { silentLogger } from "../observability/logger.js";
import { sha256Hex } from "../shared/canonical.js";
import { ValidationError } from "../shared/errors.js";
import type { MessagePublisher, OutboxMessage } from "./ports.js";

/** Minimal client surface (satisfied by SQSClient) so tests can inject a stub. */
export interface SqsBatchClient {
  send(command: SendMessageBatchCommand): Promise<SendMessageBatchCommandOutput>;
}

export interface SqsPublisherOptions {
  client: SqsBatchClient;
  /** https://sqs.<region>.amazonaws.com/<account-id>/<queue-name>[.fifo] */
  queueUrl: string;
  fifo: boolean;
  logger?: Logger;
}

export const SQS_MAX_BATCH_ENTRIES = 10;
export const OUTBOX_ENVELOPE_SCHEMA = "vsp.outbox.v1";

const QUEUE_URL = /^https:\/\/sqs\.[a-z]{2}(-gov)?-[a-z]+-\d\.amazonaws\.com\/\d{12}\/[A-Za-z0-9_-]{1,75}(\.fifo)?$/;

/** Message body: opaque envelope; payload is already restricted to opaque references at enqueue. */
export function outboxEnvelope(m: OutboxMessage): string {
  return JSON.stringify({
    schema: OUTBOX_ENVELOPE_SCHEMA,
    messageId: m.messageId,
    tenantId: m.tenantId,
    topic: m.topic,
    key: m.key,
    dedupeKey: m.dedupeKey,
    attempts: m.attempts,
    createdAt: m.createdAt,
    payload: m.payload,
  });
}

export class SqsPublisher implements MessagePublisher {
  readonly kind = "live" as const;
  private readonly logger: Logger;

  constructor(private readonly opts: SqsPublisherOptions) {
    if (!QUEUE_URL.test(opts.queueUrl)) throw new ValidationError("SQS_QUEUE_URL_INVALID");
    if (opts.queueUrl.endsWith(".fifo") !== opts.fifo) throw new ValidationError("SQS_QUEUE_FIFO_MISMATCH");
    this.logger = opts.logger ?? silentLogger;
  }

  buildEntries(batch: OutboxMessage[]): SendMessageBatchRequestEntry[] {
    return batch.map((m, i) => {
      const entry: SendMessageBatchRequestEntry = {
        Id: `e${i}`,
        MessageBody: outboxEnvelope(m),
        MessageAttributes: { topic: { DataType: "String", StringValue: m.topic } },
      };
      if (this.opts.fifo) {
        entry.MessageGroupId = m.key;
        entry.MessageDeduplicationId = sha256Hex(`vsp.outbox.dedupe.v1:${m.dedupeKey}`);
      }
      return entry;
    });
  }

  async publish(messages: OutboxMessage[]): Promise<{ published: string[]; failed: string[] }> {
    const published: string[] = [];
    const failed: string[] = [];
    for (let start = 0; start < messages.length; start += SQS_MAX_BATCH_ENTRIES) {
      const batch = messages.slice(start, start + SQS_MAX_BATCH_ENTRIES);
      const entries = this.buildEntries(batch);
      let output: SendMessageBatchCommandOutput;
      try {
        output = await this.opts.client.send(new SendMessageBatchCommand({ QueueUrl: this.opts.queueUrl, Entries: entries }));
      } catch {
        // Whole-batch failure: the outbox retries with backoff; SQS may still have accepted some
        // entries, which is safe because delivery is at least once and consumers deduplicate.
        this.logger.warn("outbox.sqs.batch_failed", { reasonCode: "SQS_SEND_BATCH_EXCEPTION", failedCount: batch.length });
        failed.push(...batch.map((m) => m.messageId));
        continue;
      }
      const ok = new Set((output.Successful ?? []).map((s) => s.Id));
      const bad = new Set((output.Failed ?? []).map((f) => f.Id));
      batch.forEach((m, i) => {
        const id = `e${i}`;
        if (ok.has(id) && !bad.has(id)) published.push(m.messageId);
        else failed.push(m.messageId);
      });
      if (bad.size > 0) this.logger.warn("outbox.sqs.partial_failure", { reasonCode: "SQS_PARTIAL_BATCH_FAILURE", failedCount: bad.size });
    }
    return { published, failed };
  }
}
