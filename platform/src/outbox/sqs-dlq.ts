/**
 * SQS dead-letter queue repair and application-level dead-lettering (follow-on FO-06-10, FO-03-24;
 * OPS-01, ACT-02). LIVE adapters over the documented SQS API (@aws-sdk/client-sqs).
 *
 * SqsDeadLetterRedrive — audited, bounded operator repair of a dead-letter queue (the SQS redrive policy
 * moved the messages there after maxReceiveCount receives):
 *   - `inspect` lists dead-lettered messages as metadata (outbox message id, tenant, topic, receive count,
 *     redrive count) without the body; inspected messages become visible again after the short visibility.
 *   - `redrive` moves at most `maxMessages` (<= 100) back to the source queue. Per message, in this order:
 *     (1) an `outbox.dlq_redrive` INTENT audit event (outcome PENDING: operator, reason code) is appended for
 *     the message's tenant — if it cannot be written the message is left in the DLQ and the redrive stops
 *     (fail closed); (2) the message is sent to the source queue with its original body and attributes
 *     (FIFO: same group and deduplication id) and an incremented `vsp-redrive-count`; (3) it is deleted
 *     from the DLQ; (4) an `outbox.dlq_redrive.completed` event records what happened (SUCCEEDED, or FAILED
 *     with SQS_DLQ_REDRIVE_SEND_FAILED when the send or delete failed), so the audit trail never claims a
 *     move that did not happen. A completion that cannot be recorded stops the redrive
 *     (AUDIT_COMPLETION_UNRECORDED; the intent event remains). A crash between (2) and (3) leaves a copy in
 *     both queues: delivery is at least once and consumers deduplicate (PgConsumerDedup); a crash before (4)
 *     leaves the PENDING intent, which the operator reconciles against the queues. A message already
 *     redriven `maxRedrives` times stays in the DLQ and is reported (bounded redrive: a poison message cannot
 *     loop forever).
 *   - The operator must be an authenticated staff reference with an allowlisted reason code.
 * SqsDeadLetterWriter — the explicit dead-letter write of a consumer that gives up on a message: a DLQ that
 * refuses the write (missing queue, message over its size limit, access denied) is a typed
 * DLQ_WRITE_REFUSED error, so the consumer stops consuming and keeps its checkpoint (FAULT:DLQ_FULL, WP-07).
 */
import { DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand } from "@aws-sdk/client-sqs";
import type { DeleteMessageCommandOutput, Message, ReceiveMessageCommandOutput, SendMessageCommandOutput } from "@aws-sdk/client-sqs";
import { buildAuditInput } from "../audit/build-input.js";
import type { AuditWriter } from "../audit/ports.js";
import { silentLogger } from "../observability/logger.js";
import { noopMetrics } from "../observability/metrics.js";
import type { Logger, Metrics } from "../observability/ports.js";
import type { Clock } from "../shared/clock.js";
import { AccessDeniedError, DependencyError, PlatformError, ValidationError } from "../shared/errors.js";
import { OUTBOX_ENVELOPE_SCHEMA } from "./sqs-publisher.js";

export interface SqsQueueClient {
  send(command: ReceiveMessageCommand | SendMessageCommand | DeleteMessageCommand): Promise<ReceiveMessageCommandOutput | SendMessageCommandOutput | DeleteMessageCommandOutput>;
}

export const REDRIVE_COUNT_ATTRIBUTE = "vsp-redrive-count";
export const DLQ_REDRIVE_REASON_CODES = ["DEPENDENCY_RECOVERED", "CONSUMER_DEFECT_FIXED", "OPERATOR_INVESTIGATION"] as const;

const QUEUE_URL = /^(https:\/\/sqs\.[a-z]{2}(-gov)?-[a-z]+-\d\.amazonaws\.com\/\d{12}\/[A-Za-z0-9_-]{1,75}(\.fifo)?)$/;
const TENANT_ID = /^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$/;
const MESSAGE_ID = /^msg_[A-Za-z0-9_-]{16,64}$/;

export interface DeadLetterView {
  outboxMessageId: string | null;
  tenantId: string | null;
  topic: string | null;
  receiveCount: number;
  redriveCount: number;
}

export interface RedriveResult {
  redriven: number;
  /** Messages left in the DLQ because they reached maxRedrives. */
  exhausted: number;
  /** Messages left in the DLQ because their envelope is not an outbox envelope (never moved blindly). */
  unrecognized: number;
  /** Reason the redrive stopped early (audit unavailable, send failed); null when it ran to completion. */
  stoppedBy: string | null;
}

export interface SqsDeadLetterRedriveOptions {
  client: SqsQueueClient;
  deadLetterQueueUrl: string;
  sourceQueueUrl: string;
  audit: AuditWriter;
  clock: Clock;
  /** Maximum times one message may be redriven (default 3, 1..10). */
  maxRedrives?: number;
  auditStream?: string;
  logger?: Logger;
  metrics?: Metrics;
}

interface Envelope {
  schema: string;
  messageId: string;
  tenantId: string;
  topic: string;
  key: string;
  dedupeKey: string;
}

function envelopeOf(m: Message): Envelope | null {
  try {
    const e = JSON.parse(m.Body ?? "") as Partial<Envelope>;
    if (e.schema !== OUTBOX_ENVELOPE_SCHEMA || typeof e.messageId !== "string" || !MESSAGE_ID.test(e.messageId) || typeof e.tenantId !== "string" || !TENANT_ID.test(e.tenantId)) return null;
    if (typeof e.topic !== "string" || typeof e.key !== "string" || typeof e.dedupeKey !== "string") return null;
    return e as Envelope;
  } catch {
    return null;
  }
}

const redriveCountOf = (m: Message): number => {
  const v = Number(m.MessageAttributes?.[REDRIVE_COUNT_ATTRIBUTE]?.StringValue ?? "0");
  return Number.isSafeInteger(v) && v >= 0 ? v : 0;
};

export class SqsDeadLetterRedrive {
  private readonly maxRedrives: number;
  private readonly logger: Logger;
  private readonly metrics: Metrics;

  constructor(private readonly opts: SqsDeadLetterRedriveOptions) {
    if (!QUEUE_URL.test(opts.deadLetterQueueUrl) || !QUEUE_URL.test(opts.sourceQueueUrl)) throw new ValidationError("SQS_QUEUE_URL_INVALID");
    if (opts.deadLetterQueueUrl.endsWith(".fifo") !== opts.sourceQueueUrl.endsWith(".fifo")) throw new ValidationError("SQS_DLQ_FIFO_MISMATCH");
    this.maxRedrives = opts.maxRedrives ?? 3;
    if (!Number.isSafeInteger(this.maxRedrives) || this.maxRedrives < 1 || this.maxRedrives > 10) throw new ValidationError("SQS_DLQ_POLICY_INVALID");
    this.logger = (opts.logger ?? silentLogger).child({ component: "sqs_dlq" });
    this.metrics = opts.metrics ?? noopMetrics;
  }

  private get fifo(): boolean {
    return this.opts.sourceQueueUrl.endsWith(".fifo");
  }

  private async receive(max: number, visibility: number): Promise<Message[]> {
    try {
      const r = (await this.opts.client.send(
        new ReceiveMessageCommand({
          QueueUrl: this.opts.deadLetterQueueUrl,
          MaxNumberOfMessages: Math.min(10, max),
          VisibilityTimeout: visibility,
          WaitTimeSeconds: 0,
          MessageAttributeNames: ["All"],
          MessageSystemAttributeNames: ["ApproximateReceiveCount", "MessageGroupId", "MessageDeduplicationId"],
        }),
      )) as ReceiveMessageCommandOutput;
      return r.Messages ?? [];
    } catch {
      throw new DependencyError("SQS_DLQ_RECEIVE_FAILED", "NOT_STARTED");
    }
  }

  /** Metadata of up to `limit` dead-lettered messages (no bodies). */
  async inspect(limit = 10): Promise<DeadLetterView[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ValidationError("SQS_DLQ_LIMIT_INVALID");
    const out: DeadLetterView[] = [];
    while (out.length < limit) {
      const batch = await this.receive(limit - out.length, 1);
      if (batch.length === 0) break;
      for (const m of batch) {
        const e = envelopeOf(m);
        out.push({
          outboxMessageId: e?.messageId ?? null,
          tenantId: e?.tenantId ?? null,
          topic: e?.topic ?? null,
          receiveCount: Number(m.Attributes?.ApproximateReceiveCount ?? 0),
          redriveCount: redriveCountOf(m),
        });
      }
    }
    return out;
  }

  /** Audited, bounded move of dead-lettered messages back to the source queue. */
  async redrive(input: { maxMessages: number; operator: { staffRef: string; reasonCode: string } }): Promise<RedriveResult> {
    if (!Number.isSafeInteger(input.maxMessages) || input.maxMessages < 1 || input.maxMessages > 100) throw new ValidationError("SQS_DLQ_LIMIT_INVALID");
    // Same grammar as the audit actorRef (OpaqueId): a short ref is refused here, not as an invalid audit event.
    if (!/^stf_[A-Za-z0-9_-]{16,64}$/.test(input.operator.staffRef)) throw new AccessDeniedError("SQS_DLQ_OPERATOR_INVALID");
    if (!(DLQ_REDRIVE_REASON_CODES as readonly string[]).includes(input.operator.reasonCode)) throw new AccessDeniedError("SQS_DLQ_REASON_NOT_ALLOWED");
    const result: RedriveResult = { redriven: 0, exhausted: 0, unrecognized: 0, stoppedBy: null };
    let seen = 0;
    while (seen < input.maxMessages && result.stoppedBy === null) {
      const batch = await this.receive(input.maxMessages - seen, 30);
      if (batch.length === 0) break;
      for (const m of batch) {
        seen += 1;
        if (result.stoppedBy !== null) continue; // the rest become visible again after the visibility timeout
        const e = envelopeOf(m);
        if (!e) {
          result.unrecognized += 1;
          continue;
        }
        const count = redriveCountOf(m);
        if (count >= this.maxRedrives) {
          result.exhausted += 1;
          this.logger.error("outbox.dlq.redrive_exhausted", { messageId: e.messageId, reasonCode: "SQS_DLQ_REDRIVE_LIMIT", redriveCount: count });
          continue;
        }
        const auditInput = (action: string, outcome: "PENDING" | "SUCCEEDED" | "FAILED", reasonCode: string) =>
          buildAuditInput(
            {
              tenantId: e.tenantId,
              correlationId: e.messageId,
              sourceComponent: "worker",
              action,
              outcome,
              actorRef: input.operator.staffRef,
              reasonCode,
              evidencePointers: [`outbox:${e.messageId}`],
              dataClass: "SECURITY_AUDIT",
            },
            this.opts.clock,
          );
        try {
          await this.opts.audit.appendStandalone(auditInput("outbox.dlq_redrive", "PENDING", input.operator.reasonCode), this.opts.auditStream);
        } catch (err) {
          result.stoppedBy = err instanceof PlatformError ? err.reasonCode : "AUDIT_UNAVAILABLE";
          this.count("refused_audit");
          continue;
        }
        let moved = false;
        try {
          await this.opts.client.send(
            new SendMessageCommand({
              QueueUrl: this.opts.sourceQueueUrl,
              MessageBody: m.Body ?? "",
              MessageAttributes: {
                ...(m.MessageAttributes ?? {}),
                [REDRIVE_COUNT_ATTRIBUTE]: { DataType: "Number", StringValue: String(count + 1) },
              },
              ...(this.fifo ? { MessageGroupId: m.Attributes?.MessageGroupId ?? e.key, MessageDeduplicationId: `${m.Attributes?.MessageDeduplicationId ?? e.messageId}-r${count + 1}`.slice(0, 128) } : {}),
            }),
          );
          await this.opts.client.send(new DeleteMessageCommand({ QueueUrl: this.opts.deadLetterQueueUrl, ReceiptHandle: m.ReceiptHandle }));
          moved = true;
        } catch {
          result.stoppedBy = "SQS_DLQ_REDRIVE_SEND_FAILED";
          this.count("failed");
        }
        try {
          await this.opts.audit.appendStandalone(
            auditInput("outbox.dlq_redrive.completed", moved ? "SUCCEEDED" : "FAILED", moved ? input.operator.reasonCode : "SQS_DLQ_REDRIVE_SEND_FAILED"),
            this.opts.auditStream,
          );
        } catch {
          this.logger.error("outbox.dlq.redrive_completion_unrecorded", { messageId: e.messageId, reasonCode: "AUDIT_COMPLETION_UNRECORDED" });
          if (result.stoppedBy === null) result.stoppedBy = "AUDIT_COMPLETION_UNRECORDED";
        }
        if (!moved) continue;
        result.redriven += 1;
        this.count("redriven");
      }
    }
    this.logger.info("outbox.dlq.redrive", { redriven: result.redriven, exhausted: result.exhausted, unrecognized: result.unrecognized, reasonCode: result.stoppedBy });
    return result;
  }

  private count(result: "redriven" | "refused_audit" | "failed"): void {
    try {
      this.metrics.increment("vsp_outbox_dlq_redrive_total", { result });
    } catch {
      // metrics never change the repair
    }
  }
}

/** Explicit dead-letter write of a consumer that gives up on a message (typed refusal; FAULT:DLQ_FULL). */
export class SqsDeadLetterWriter {
  readonly kind = "live" as const;

  constructor(
    private readonly client: SqsQueueClient,
    private readonly deadLetterQueueUrl: string,
  ) {
    if (!QUEUE_URL.test(deadLetterQueueUrl)) throw new ValidationError("SQS_QUEUE_URL_INVALID");
  }

  /** Writes the message body to the DLQ; a refusal is DependencyError DLQ_WRITE_REFUSED (the caller stops consuming). */
  async write(body: string, attributes: { reasonCode: string; groupId?: string; deduplicationId?: string }): Promise<string> {
    if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(attributes.reasonCode)) throw new ValidationError("SQS_DLQ_REASON_INVALID");
    try {
      const r = (await this.client.send(
        new SendMessageCommand({
          QueueUrl: this.deadLetterQueueUrl,
          MessageBody: body,
          MessageAttributes: { "vsp-dead-letter-reason": { DataType: "String", StringValue: attributes.reasonCode } },
          ...(this.deadLetterQueueUrl.endsWith(".fifo") ? { MessageGroupId: attributes.groupId ?? "dead-letter", MessageDeduplicationId: attributes.deduplicationId } : {}),
        }),
      )) as SendMessageCommandOutput;
      if (!r.MessageId) throw new Error("no message id");
      return r.MessageId;
    } catch {
      throw new DependencyError("DLQ_WRITE_REFUSED", "UNKNOWN", false);
    }
  }
}
