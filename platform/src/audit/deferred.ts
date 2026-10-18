/**
 * Deferred route-audit queue (spec section 13 "If the centralized sink fails, a local durable
 * outbox may buffer within a bounded policy. If durable evidence cannot be written at all, block
 * consequential actions and degrade to safe routing."; OPS-01, OPS-02, SAFE-03).
 *
 * During an audit outage the human / safety handoff correctly proceeds (fail-open ROUTING), but its
 * audit event cannot be appended. This queue keeps such ROUTE evidence and appends it later, in the
 * order it was deferred, once the local durable audit outbox is writable again:
 *  - `appendOrDefer` appends now when it can. While older entries are pending it first drains a
 *    bounded number of them, and defers the new event behind any that remain, so order is kept.
 *  - `flush` (worker loop `audit.deferred_flush`, and the next `appendOrDefer` in this process)
 *    appends queued events FIFO, stops at the first store failure and keeps the rest; an event the
 *    writer refuses as invalid is dropped loudly (it could never be written).
 *  - Every flushed event is followed by an `audit.deferred.recorded` marker event (parentId = the
 *    late event, reasonCode = why it was deferred) so the chain itself shows it was written late.
 *  - Bounded: at most `maxEntries` (engineering default 1000) queued events; beyond that new events
 *    are DROPPED, counted and logged at error level (never silently).
 *  - Content-free: logs and metrics carry action codes, opaque ids, reason codes and counts only.
 *
 * CRASH-LOSS LIMIT (documented, not hidden): the queue is in process memory. A process crash or
 * restart while events are queued loses them. For a safety route the `safety_events` row (written
 * with audit_status AUDIT_UNAVAILABLE by SafetyEventRecorder) remains the durable incident record;
 * the vsp_audit_deferred_depth gauge and the `audit.deferred.queued` error log are the operational
 * signal that evidence is at risk. A durable deferral store would need its own migration and an
 * approved storage location (not implemented).
 *
 * This is NOT a path for consequential mutations: the action ledger and every in-transaction
 * append keep failing closed (AuditHealth.assertCanAcceptConsequential + PgAuditWriter.append).
 */
import type { Logger, Metrics } from "../observability/ports.js";
import { silentLogger } from "../observability/logger.js";
import { noopMetrics } from "../observability/metrics.js";
import type { AuditEventInput } from "../protocol/index.js";
import type { Clock } from "../shared/clock.js";
import { PlatformError, ValidationError } from "../shared/errors.js";
import { newId } from "../shared/ids.js";
import { buildAuditInput } from "./build-input.js";
import { AUDIT_HEALTH_REASONS } from "./health.js";
import type { AuditHealth, AuditWriter, DeferredAppendResult, DeferredAuditSink } from "./ports.js";
import { validateAuditInput } from "./schema.js";

export const DEFERRED_AUDIT_BADGE = "PROCESS-LOCAL DEFERRED ROUTE-AUDIT QUEUE — bounded; lost on a process crash";
export const DEFERRED_AUDIT_MARKER_ACTION = "audit.deferred.recorded";

export interface DeferredAuditQueueOptions {
  writer: AuditWriter;
  clock: Clock;
  logger?: Logger;
  metrics?: Metrics;
  /** Optional precheck for `flush`: nothing is attempted while the store is unwritable. */
  health?: AuditHealth | null;
  /** Maximum queued events (engineering default 1000, pending SRE review; 1..10000). */
  maxEntries?: number;
  /** Maximum events appended per `flush` call (default 100). */
  maxPerFlush?: number;
  /** Maximum queued events drained inline by `appendOrDefer` before it decides (default 16). */
  maxInlineDrain?: number;
}

export interface DeferredFlushResult {
  written: number;
  dropped: number;
  remaining: number;
  /** Why flushing stopped early (store still unavailable); null when the queue drained or the limit was reached. */
  reasonCode: string | null;
}

interface Entry {
  deferralId: string;
  input: AuditEventInput;
  stream: string | undefined;
  reasonCode: string;
  deferredAtMs: number;
}

const REASON = /^[A-Z][A-Z0-9_]{2,63}$/;
const reasonOf = (err: unknown, fallback = "AUDIT_UNAVAILABLE"): string => (err instanceof PlatformError && REASON.test(err.reasonCode) ? err.reasonCode : fallback);
/** The writer refuses the event itself (schema, timestamp): retrying can never succeed. */
const isPermanent = (err: unknown): boolean => err instanceof ValidationError;

export class DeferredAuditQueue implements DeferredAuditSink {
  readonly badge = DEFERRED_AUDIT_BADGE;
  private readonly entries: Entry[] = [];
  private readonly logger: Logger;
  private readonly metrics: Metrics;
  private readonly maxEntries: number;
  private readonly maxPerFlush: number;
  private readonly maxInlineDrain: number;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: DeferredAuditQueueOptions) {
    this.logger = (opts.logger ?? silentLogger).child({ component: "audit_deferred" });
    this.metrics = opts.metrics ?? noopMetrics;
    this.maxEntries = opts.maxEntries ?? 1000;
    this.maxPerFlush = opts.maxPerFlush ?? 100;
    this.maxInlineDrain = opts.maxInlineDrain ?? 16;
    for (const [n, lo, hi] of [
      [this.maxEntries, 1, 10_000],
      [this.maxPerFlush, 1, 1_000],
      [this.maxInlineDrain, 0, 1_000],
    ] as const) {
      if (!Number.isSafeInteger(n) || n < lo || n > hi) throw new ValidationError("DEFERRED_AUDIT_POLICY_INVALID");
    }
  }

  /** Queued events awaiting a durable append. */
  get depth(): number {
    return this.entries.length;
  }

  /** Opaque ids, actions and reason codes of the queued events (operations; content-free). */
  pending(): { deferralId: string; action: string; reasonCode: string }[] {
    return this.entries.map((e) => ({ deferralId: e.deferralId, action: e.input.action, reasonCode: e.reasonCode }));
  }

  async appendOrDefer(input: AuditEventInput, stream?: string): Promise<DeferredAppendResult> {
    // An invalid event is a programming error: refused now, never queued.
    const valid = validateAuditInput(input);
    return this.exclusive(async () => {
      if (this.entries.length > 0) {
        // Order first: older deferred events go before this one.
        const drained = this.maxInlineDrain > 0 ? await this.drain(this.maxInlineDrain) : null;
        if (this.entries.length > 0) return this.enqueue(valid, stream, drained?.reasonCode ?? "AUDIT_DEFERRED_QUEUE_PENDING");
      }
      try {
        const ev = await this.opts.writer.appendStandalone(valid, stream);
        return { written: true, deferred: false, eventId: ev.eventId, reasonCode: null };
      } catch (err) {
        if (isPermanent(err)) throw err;
        return this.enqueue(valid, stream, reasonOf(err));
      }
    });
  }

  /** Appends queued events in order (bounded); skipped while the audit store reports itself unwritable. */
  async flush(limit = this.maxPerFlush): Promise<DeferredFlushResult> {
    return this.exclusive(async () => {
      if (this.entries.length === 0) return { written: 0, dropped: 0, remaining: 0, reasonCode: null };
      if (this.opts.health) {
        const status = await this.opts.health.status().catch(() => null);
        if (!status || status.reasonCode === AUDIT_HEALTH_REASONS.storeUnwritable) {
          this.gaugeDepth();
          return { written: 0, dropped: 0, remaining: this.entries.length, reasonCode: status?.reasonCode ?? AUDIT_HEALTH_REASONS.storeUnwritable };
        }
      }
      return this.drain(Math.max(1, Math.min(limit, this.maxPerFlush)));
    });
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async drain(limit: number): Promise<DeferredFlushResult> {
    let written = 0;
    let dropped = 0;
    let stoppedBy: string | null = null;
    while (this.entries.length > 0 && written + dropped < limit) {
      const e = this.entries[0] as Entry;
      let eventId: string;
      try {
        eventId = (await this.opts.writer.appendStandalone(e.input, e.stream)).eventId;
      } catch (err) {
        if (isPermanent(err)) {
          this.entries.shift();
          dropped += 1;
          this.count("dropped", "invalid");
          this.logger.error("audit.deferred.dropped", { deferralId: e.deferralId, action: e.input.action, correlationId: e.input.correlationId, reasonCode: reasonOf(err, "AUDIT_EVENT_INVALID") });
          continue;
        }
        stoppedBy = reasonOf(err);
        break;
      }
      this.entries.shift();
      written += 1;
      this.count("flushed", "none");
      this.observeAge(e);
      this.logger.warn("audit.deferred.flushed", { deferralId: e.deferralId, eventId, action: e.input.action, reasonCode: e.reasonCode });
      await this.marker(e, eventId);
    }
    this.gaugeDepth();
    return { written, dropped, remaining: this.entries.length, reasonCode: stoppedBy };
  }

  /** Records in the chain that `eventId` was written late, and why (best effort; the late event itself is the evidence). */
  private async marker(e: Entry, eventId: string): Promise<void> {
    try {
      await this.opts.writer.appendStandalone(
        buildAuditInput(
          {
            tenantId: e.input.tenantId,
            correlationId: e.input.correlationId,
            parentId: eventId,
            sourceComponent: e.input.sourceComponent,
            action: DEFERRED_AUDIT_MARKER_ACTION,
            outcome: "SUCCEEDED",
            callId: e.input.callId,
            versions: e.input.versions,
            reasonCode: e.reasonCode,
            dataClass: "SECURITY_AUDIT",
          },
          this.opts.clock,
        ),
        e.stream,
      );
    } catch (err) {
      this.logger.warn("audit.deferred.marker_failed", { deferralId: e.deferralId, eventId, reasonCode: reasonOf(err) });
    }
  }

  private enqueue(input: AuditEventInput, stream: string | undefined, reasonCode: string): DeferredAppendResult {
    if (this.entries.length >= this.maxEntries) {
      this.count("dropped", "queue_full");
      // Loud: route evidence is being lost (bounded queue exhausted during a long outage).
      this.logger.error("audit.deferred.dropped", { action: input.action, correlationId: input.correlationId, reasonCode: "AUDIT_DEFERRED_QUEUE_FULL", depth: this.entries.length });
      this.gaugeDepth();
      return { written: false, deferred: false, eventId: null, reasonCode: "AUDIT_DEFERRED_QUEUE_FULL" };
    }
    const deferralId = newId("dfr");
    this.entries.push({ deferralId, input, stream, reasonCode, deferredAtMs: this.opts.clock.now().getTime() });
    this.count("queued", "store_unavailable");
    this.gaugeDepth();
    // Loud and content-free: the event is held in process memory only until the store recovers.
    this.logger.error("audit.deferred.queued", { deferralId, action: input.action, correlationId: input.correlationId, reasonCode, depth: this.entries.length });
    return { written: false, deferred: true, eventId: null, reasonCode };
  }

  private count(result: "queued" | "flushed" | "dropped", reason: "store_unavailable" | "queue_full" | "invalid" | "none"): void {
    try {
      this.metrics.increment("vsp_audit_deferred_total", { result, reason });
    } catch {
      // metrics never change what is written or queued
    }
  }

  private gaugeDepth(): void {
    try {
      this.metrics.gauge("vsp_audit_deferred_depth", this.entries.length);
    } catch {
      // metrics never change what is written or queued
    }
  }

  private observeAge(e: Entry): void {
    try {
      this.metrics.observe("vsp_audit_deferred_age_ms", Math.max(0, this.opts.clock.now().getTime() - e.deferredAtMs));
    } catch {
      // metrics never change what is written or queued
    }
  }
}
