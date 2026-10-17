/**
 * LOCAL FIXTURE — in-memory at-least-once transport. NOT a durable queue and NOT production.
 * The production configuration guard must reject any publisher whose kind is "local_fixture"
 * (OPS-04).
 *
 * Supports failure injection (whole-call exceptions, per-message failures) and duplicate
 * delivery to simulate SQS at-least-once redelivery, so consumer deduplication is exercised.
 */
import type { MessagePublisher, OutboxMessage } from "./ports.js";

export const MEMORY_PUBLISHER_FIXTURE_BADGE = "LOCAL FIXTURE — in-memory transport, synthetic only";

export interface MemoryDelivery {
  message: OutboxMessage;
  /** 1 for the first delivery of a message id, 2+ for duplicates/redeliveries. */
  deliveryNumber: number;
}

export type MemorySubscriber = (message: OutboxMessage, delivery: MemoryDelivery) => Promise<void>;

export class MemoryPublisherFixture implements MessagePublisher {
  readonly kind = "local_fixture" as const;
  readonly badge = MEMORY_PUBLISHER_FIXTURE_BADGE;
  readonly deliveries: MemoryDelivery[] = [];
  /** Subscriber failures are recorded (the transport still accepted the message). */
  subscriberErrors = 0;
  publishCalls = 0;

  private readonly subscribers = new Set<MemorySubscriber>();
  private throwRemaining = 0;
  private readonly failRemaining = new Map<string, number>();
  private failAllRemaining = 0;
  private readonly deliveryCounts = new Map<string, number>();

  private duplicateEveryDelivery: boolean;

  constructor(options: { duplicateEveryDelivery?: boolean } = {}) {
    this.duplicateEveryDelivery = options.duplicateEveryDelivery ?? false;
  }

  subscribe(handler: MemorySubscriber): () => void {
    this.subscribers.add(handler);
    return () => this.subscribers.delete(handler);
  }

  /** The next `n` publish calls throw (transport unavailable). */
  throwOnNextPublish(n = 1): void {
    this.throwRemaining += n;
  }

  /** The next `n` publish calls report every message as failed. */
  failAllOnNextPublish(n = 1): void {
    this.failAllRemaining += n;
  }

  /** Report `messageId` as failed for its next `times` publish attempts. */
  failMessage(messageId: string, times = 1): void {
    this.failRemaining.set(messageId, (this.failRemaining.get(messageId) ?? 0) + times);
  }

  setDuplicateDelivery(on: boolean): void {
    this.duplicateEveryDelivery = on;
  }

  deliveryCount(messageId: string): number {
    return this.deliveryCounts.get(messageId) ?? 0;
  }

  async publish(messages: OutboxMessage[]): Promise<{ published: string[]; failed: string[] }> {
    this.publishCalls += 1;
    if (this.throwRemaining > 0) {
      this.throwRemaining -= 1;
      throw new Error("MEMORY_PUBLISHER_FIXTURE_UNAVAILABLE");
    }
    const failAll = this.failAllRemaining > 0;
    if (failAll) this.failAllRemaining -= 1;
    const published: string[] = [];
    const failed: string[] = [];
    for (const message of messages) {
      const remaining = this.failRemaining.get(message.messageId) ?? 0;
      if (failAll || remaining > 0) {
        if (remaining > 0) this.failRemaining.set(message.messageId, remaining - 1);
        failed.push(message.messageId);
        continue;
      }
      await this.deliver(message);
      if (this.duplicateEveryDelivery) await this.deliver(message);
      published.push(message.messageId);
    }
    return { published, failed };
  }

  /** Redelivers every message already delivered once (simulates visibility-timeout redelivery). */
  async redeliverAll(): Promise<number> {
    const firsts = this.deliveries.filter((d) => d.deliveryNumber === 1).map((d) => d.message);
    for (const m of firsts) await this.deliver(m);
    return firsts.length;
  }

  private async deliver(message: OutboxMessage): Promise<void> {
    const n = (this.deliveryCounts.get(message.messageId) ?? 0) + 1;
    this.deliveryCounts.set(message.messageId, n);
    const delivery: MemoryDelivery = { message: structuredClone(message), deliveryNumber: n };
    this.deliveries.push(delivery);
    for (const s of this.subscribers) {
      try {
        await s(delivery.message, delivery);
      } catch {
        this.subscriberErrors += 1;
      }
    }
  }
}
