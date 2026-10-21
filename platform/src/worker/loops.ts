/**
 * Worker loops of the REGRESSION composition: every fixture-free loop (loop-kit.ts, re-exported here so the
 * regression worker and its tests keep one import), plus the two LOCAL FIXTURE pieces only local / ci run:
 * the in-memory consumer queue behind the MemoryPublisherFixture and the telephony fixture's event delivery.
 * The live worker (live-loops.ts) imports loop-kit.ts directly and never this file (modules.yaml entryPoints).
 */
import type { TelephonyEvent, TelephonyFixture } from "../adapters/local/telephony-fixture.js";
import { TRANSFER_EVENT_FOR_STATE } from "../adapters/local/telephony-fixture.js";
import type { MemoryPublisherFixture } from "../outbox/memory-publisher.fixture.js";
import type { Clock } from "../shared/clock.js";
import type { TransferCoordinator, TransferStore } from "../workflows/transfer.js";
import { guardedRun, okReport } from "./loop-kit.js";
import type { ConsumerQueue, DeadLetter, LoopReport, QueueEntry, WorkerLoop } from "./loop-kit.js";

export * from "./loop-kit.js";

/**
 * LOCAL FIXTURE consumer queue: the in-process analogue of the SQS queue + DLQ
 * behind the MemoryPublisherFixture. Deliveries are queued (deduplicated by
 * message id while pending) and consumed by OutboxConsumeLoop with bounded
 * retries; exhausted messages move to an in-memory dead-letter list (opaque
 * ids and reason codes only). Not durable: a process restart loses pending
 * entries, which the outbox does not redeliver (they are DISPATCHED) — local only.
 */
export class LocalConsumerQueueFixture implements ConsumerQueue {
  readonly badge = "LOCAL FIXTURE — in-memory consumer queue, not durable";
  private readonly entries = new Map<string, QueueEntry>();
  readonly dead: DeadLetter[] = [];
  overflowed = 0;
  private readonly unsubscribe: () => void;

  constructor(
    publisher: Pick<MemoryPublisherFixture, "subscribe">,
    private readonly clock: Clock,
    private readonly maxDepth = 10_000,
  ) {
    this.unsubscribe = publisher.subscribe(async (message) => {
      if (this.entries.has(message.messageId)) return;
      if (this.entries.size >= this.maxDepth) {
        this.overflowed += 1;
        throw new Error("LOCAL_CONSUMER_QUEUE_FULL");
      }
      this.entries.set(message.messageId, { message, attempts: 0, nextAttemptAt: this.clock.now().getTime() });
    });
  }

  get depth(): number {
    return this.entries.size;
  }

  due(limit: number): QueueEntry[] {
    const now = this.clock.now().getTime();
    return [...this.entries.values()].filter((e) => e.nextAttemptAt <= now).slice(0, limit);
  }

  ack(messageId: string): void {
    this.entries.delete(messageId);
  }

  retry(entry: QueueEntry, delayMs: number): void {
    entry.attempts += 1;
    entry.nextAttemptAt = this.clock.now().getTime() + delayMs;
  }

  deadLetter(entry: QueueEntry, reasonCode: string): void {
    this.entries.delete(entry.message.messageId);
    this.dead.push({ messageId: entry.message.messageId, topic: entry.message.topic, reasonCode, attempts: entry.attempts });
    if (this.dead.length > 1_000) this.dead.shift();
  }

  close(): void {
    this.unsubscribe();
  }
}

/**
 * Delivers the telephony fixture's queued lifecycle events (duplicated and
 * reordered by script) to the TransferCoordinator. The coordinator dedups by
 * event id and applies only legal transitions. LOCAL FIXTURE only: live
 * Talkdesk transfer events are BLOCKED (TB-07 / TB-09).
 */
export class LocalTelephonyDeliveryLoop implements WorkerLoop {
  readonly name = "telephony.local_fixture_delivery";
  private unmatched = 0;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly telephony: Pick<TelephonyFixture, "subscribe" | "deliverAll" | "kind">,
    private readonly store: Pick<TransferStore, "get">,
    private readonly transfers: Pick<TransferCoordinator, "applyEvent">,
    readonly intervalMs = 500,
    private readonly maxPerRun = 200,
  ) {
    if (telephony.kind !== "local_fixture") throw new RangeError("LOCAL_TELEPHONY_DELIVERY_REQUIRES_FIXTURE");
    this.unsubscribe = telephony.subscribe(async (e: TelephonyEvent) => {
      const name = TRANSFER_EVENT_FOR_STATE[e.state];
      if (!name) return; // REQUESTED: the dial itself
      const journey = await this.store.get(e.handoffId);
      const transferId = journey ? Object.entries(journey.vendorRefs).find(([, ref]) => ref === e.transferRef)?.[0] : undefined;
      if (!transferId) {
        this.unmatched += 1;
        return;
      }
      await this.transfers.applyEvent({ transferId, event: name as never, eventId: e.eventId, source: "telephony.local_fixture" });
    });
  }

  runOnce(): Promise<LoopReport> {
    return guardedRun(async () => {
      const before = this.unmatched;
      const delivered = await this.telephony.deliverAll(this.maxPerRun);
      return okReport(delivered, { unmatched: this.unmatched - before });
    });
  }

  close(): void {
    this.unsubscribe();
  }
}
