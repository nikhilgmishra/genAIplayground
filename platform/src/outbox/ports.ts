import type { Queryable } from "../db/types.js";

export interface OutboxMessageInput {
  topic: "support_request.sync" | "workflow.start" | "workflow.signal" | "notification.send" | "audit.ship" | "action.committed";
  /** Aggregate key for per-key ordering where the transport supports it (SQS FIFO group). */
  key: string;
  /** Opaque references only; PHI stays in access-controlled tables. */
  payload: Record<string, unknown>;
  /** Unique per logical message; duplicates are ignored at enqueue time. */
  dedupeKey: string;
}

export interface OutboxMessage extends OutboxMessageInput {
  messageId: string;
  /** Tenant the message was enqueued for (the transaction's RLS tenant); consumers set their RLS context from it. */
  tenantId: string;
  attempts: number;
  createdAt: string;
}

export interface Outbox {
  /** Must be called inside the same transaction as the state change it announces. */
  enqueue(tx: Queryable, message: OutboxMessageInput): Promise<string>;
}

/** At-least-once transport (SQS with DLQ in AWS; in-memory LOCAL FIXTURE offline). */
export interface MessagePublisher {
  readonly kind: "local_fixture" | "live";
  publish(messages: OutboxMessage[]): Promise<{ published: string[]; failed: string[] }>;
}

export interface OutboxDispatcher {
  runOnce(limit?: number): Promise<{ dispatched: number; failed: number; deadLettered: number }>;
}

/** Consumer-side deduplication: the handler's effects and the dedupe record commit atomically. */
export interface ConsumerDedup {
  processOnce<T>(consumer: string, messageId: string, handler: (tx: Queryable) => Promise<T>): Promise<{ duplicate: boolean; result: T | null }>;
  /** Read-only pre-check inside the tenant's RLS context: has `consumer` already processed `messageId`? */
  isProcessed(tenantId: string, consumer: string, messageId: string): Promise<boolean>;
}
