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
 *  - `flush` (worker loop `audit.deferred_flush`; in the gateway-only process the bounded timer
 *    `DeferredAuditFlushTimer`; and the next `appendOrDefer` in this process) appends queued events
 *    FIFO, stops at the first store failure and keeps the rest; an event the writer refuses as
 *    invalid is dropped loudly (it could never be written). Every `flush` call reports the
 *    vsp_audit_deferred_depth gauge, also when the queue is empty, so each flushing process sends
 *    a depth heartbeat for the sustained-depth alarm.
 *  - Every flushed event is followed by an `audit.deferred.recorded` marker event (parentId = the
 *    late event, reasonCode = why it was deferred) so the chain itself shows it was written late.
 *  - Bounded: at most `maxEntries` (engineering default 1000) queued events; beyond that new events
 *    are DROPPED, counted and logged at error level (never silently).
 *  - Content-free: logs and metrics carry action codes, opaque ids, reason codes and counts only.
 *
 *  - Sealed at graceful shutdown (`seal`, called by `DeferredAuditFlushTimer.stop` once its final
 *    flush returned): an event that cannot be appended at once is then no longer queued, because
 *    nothing would flush it; it is dropped, counted and logged at error level as
 *    `audit.deferred.lost_at_shutdown` (reason AUDIT_DEFERRED_AFTER_SHUTDOWN). `inProgress` counts
 *    the `appendOrDefer` calls that have not returned, so the final flush can wait for them and
 *    report those still running at the seal.
 *  - LIMIT: the queue can only report what reaches it while the process is alive. A caller that has
 *    not called `appendOrDefer` yet when the process exits (e.g. a request handler still waiting for
 *    a slow transfer call) loses its event without any log from this module. The gateway entry point
 *    (`platform/src/main/server.ts`) therefore waits, bounded, for its request handlers to settle
 *    before the final flush, and logs those it gave up on at error level. It does not wait for a
 *    route-tool execution that its tool timeout detached from the request (the pipeline answered
 *    TIMEOUT while the handoff work continues): such an event is lost with no log if the process
 *    exits first. Detect it from TIMEOUT results / `vsp_timeouts_total` for request_human_transfer
 *    and request_safety_route shortly before a stop.
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
/** Reason code of an event that could not be appended after the queue was sealed at shutdown. */
export const DEFERRED_AUDIT_AFTER_SHUTDOWN = "AUDIT_DEFERRED_AFTER_SHUTDOWN";

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
  private sealed = false;
  private lostAfterSeal = 0;
  private appending = 0;

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

  /** True once `seal` ran: no further event is queued. */
  get isSealed(): boolean {
    return this.sealed;
  }

  /**
   * `appendOrDefer` calls that have not returned yet (waiting for their turn or for the store): each
   * ends written, queued, or (once sealed) reported lost. A `flush` started now runs after all of them.
   */
  get inProgress(): number {
    return this.appending;
  }

  /**
   * Graceful shutdown (`DeferredAuditFlushTimer.stop`, after its final flush): from now on an event
   * that cannot be appended at once is dropped and reported as lost (`audit.deferred.lost_at_shutdown`,
   * error level, reason AUDIT_DEFERRED_AFTER_SHUTDOWN, counted as dropped) instead of being queued
   * where nothing would flush it. Appends that succeed at once, and `flush` of events already queued,
   * still work. Idempotent; a sealed queue is never unsealed.
   */
  seal(): void {
    this.sealed = true;
  }

  /** Opaque ids, actions and reason codes of the queued events (operations; content-free). */
  pending(): { deferralId: string; action: string; reasonCode: string }[] {
    return this.entries.map((e) => ({ deferralId: e.deferralId, action: e.input.action, reasonCode: e.reasonCode }));
  }

  async appendOrDefer(input: AuditEventInput, stream?: string): Promise<DeferredAppendResult> {
    // An invalid event is a programming error: refused now, never queued.
    const valid = validateAuditInput(input);
    // Counted from the call on (synchronously, before it joins the serialized chain), so a shutdown
    // can wait for it and report it if it is still running when the queue is sealed.
    this.appending += 1;
    try {
      return await this.exclusive(async () => {
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
    } finally {
      this.appending -= 1;
    }
  }

  /** Appends queued events in order (bounded); skipped while the audit store reports itself unwritable. */
  async flush(limit = this.maxPerFlush): Promise<DeferredFlushResult> {
    return this.exclusive(async () => {
      if (this.entries.length === 0) {
        // Depth heartbeat: an empty queue is reported as 0, not as missing data.
        this.gaugeDepth();
        return { written: 0, dropped: 0, remaining: 0, reasonCode: null };
      }
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
    if (this.sealed) {
      // Loud: shutdown already ran its final flush, so a queued event would be lost silently.
      this.lostAfterSeal += 1;
      this.count("dropped", "store_unavailable");
      this.logger.error("audit.deferred.lost_at_shutdown", {
        action: input.action,
        correlationId: input.correlationId,
        reasonCode: DEFERRED_AUDIT_AFTER_SHUTDOWN,
        storeReasonCode: reasonCode,
        lost: this.lostAfterSeal,
        depth: this.entries.length,
      });
      return { written: false, deferred: false, eventId: null, reasonCode: DEFERRED_AUDIT_AFTER_SHUTDOWN };
    }
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

export interface DeferredAuditFlushTimerOptions {
  /** Time between flush runs (default 5000 ms, as the worker loop `audit.deferred_flush`; 100..300000). */
  intervalMs?: number;
  /** Events appended per run (default 100, 1..1000; the queue also caps it at its own maxPerFlush). */
  limit?: number;
  /** Upper bound of the final flush `stop` attempts on graceful shutdown (default 5000 ms; 0 = none; at most 60000). */
  finalFlushTimeoutMs?: number;
  logger?: Logger;
}

export interface DeferredFinalFlushResult {
  written: number;
  dropped: number;
  /** Events still queued when `stop` returned: lost with the process (crash-loss limit). */
  remaining: number;
  /**
   * `appendOrDefer` calls still running when `stop` sealed the queue (e.g. hung in the store): their
   * events may be lost with the process; one that then fails is reported by the sealed queue only if
   * it settles before the process exits.
   */
  inProgress: number;
  /** Why events remain (the store's reason code, or DEFERRED_AUDIT_FINAL_FLUSH_TIMEOUT / _DISABLED); null when the queue drained and no append was in progress. */
  reasonCode: string | null;
}

/**
 * Bounded flush timer for a process that holds a DeferredAuditQueue but runs no worker loops: the
 * gateway-only entry point (platform/src/main/server.ts). The worker's `audit.deferred_flush` loop
 * drains the worker process's own queue, never this one (ADR-0011).
 *  - Runs `queue.flush(limit)` every `intervalMs` on an unref'd setTimeout chain: at most one run at a
 *    time (no pile-up while the store is slow), and the timer never keeps the process alive.
 *  - A run never throws: a failing flush is logged with its reason code and the events stay queued.
 *  - `stop` (graceful shutdown, called once the process stopped taking work: in the gateway after its
 *    listener closed and its request handlers settled or the wait for them expired) cancels the
 *    timer, waits for a run in progress and for `appendOrDefer` calls in progress, then drains the
 *    queue in bounded batches until it is empty or the store refuses; all of that within
 *    `finalFlushTimeoutMs`. Events still queued then are lost with the process (crash-loss limit),
 *    and appends still running may be; both are logged at error level with their counts
 *    (`audit.deferred.unflushed_at_shutdown`, `remaining` and `inProgress`). The bound's own timer
 *    keeps the process alive until then, so the loss is logged even when the stuck flush holds no
 *    handle that would. In the same synchronous step that counts them, `stop` seals the queue: an
 *    event that reaches `appendOrDefer` later and cannot be appended at once is reported lost by the
 *    queue itself (`audit.deferred.lost_at_shutdown`), not queued. That report needs the caller to
 *    reach the queue before the process exits: `stop` cannot see a caller that has not called
 *    `appendOrDefer` yet (the caller's process must wait for its own work first; see server.ts).
 * Order and the `audit.deferred.recorded` markers are the queue's own (flush is FIFO and serialized),
 * and every run reports vsp_audit_deferred_depth.
 */
export class DeferredAuditFlushTimer {
  private readonly logger: Logger;
  private readonly intervalMs: number;
  private readonly limit: number;
  private readonly finalFlushTimeoutMs: number;
  private state: "idle" | "running" | "stopped" = "idle";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<unknown> | null = null;
  private stopping: Promise<DeferredFinalFlushResult> | null = null;

  constructor(
    private readonly queue: Pick<DeferredAuditQueue, "flush" | "depth" | "seal" | "inProgress">,
    opts: DeferredAuditFlushTimerOptions = {},
  ) {
    this.logger = (opts.logger ?? silentLogger).child({ component: "audit_deferred_flush" });
    this.intervalMs = opts.intervalMs ?? 5_000;
    this.limit = opts.limit ?? 100;
    this.finalFlushTimeoutMs = opts.finalFlushTimeoutMs ?? 5_000;
    for (const [n, lo, hi] of [
      [this.intervalMs, 100, 300_000],
      [this.limit, 1, 1_000],
      [this.finalFlushTimeoutMs, 0, 60_000],
    ] as const) {
      if (!Number.isSafeInteger(n) || n < lo || n > hi) throw new ValidationError("DEFERRED_AUDIT_FLUSH_POLICY_INVALID");
    }
  }

  /** Arms the timer (idempotent; a stopped timer never restarts). */
  start(): void {
    if (this.state !== "idle") return;
    this.state = "running";
    this.arm();
  }

  /** One bounded flush run. Never throws: a failure leaves the events queued and is returned as its reason code. */
  async runOnce(): Promise<DeferredFlushResult> {
    try {
      return await this.queue.flush(this.limit);
    } catch (err) {
      const reasonCode = reasonOf(err);
      this.logger.warn("audit.deferred.flush_failed", { reasonCode, depth: this.queue.depth });
      return { written: 0, dropped: 0, remaining: this.queue.depth, reasonCode };
    }
  }

  /** Stops the timer and attempts one bounded final flush (idempotent). */
  stop(): Promise<DeferredFinalFlushResult> {
    this.stopping ??= this.shutdown();
    return this.stopping;
  }

  private arm(): void {
    if (this.state !== "running") return;
    const t = setTimeout(() => {
      this.timer = null;
      if (this.state !== "running") return;
      this.running = this.runOnce().finally(() => {
        this.running = null;
        this.arm();
      });
    }, this.intervalMs);
    t.unref?.();
    this.timer = t;
  }

  private async shutdown(): Promise<DeferredFinalFlushResult> {
    this.state = "stopped";
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const result = this.finalFlushTimeoutMs > 0 ? await this.finalFlush() : this.sealCounting(0, 0, "DEFERRED_AUDIT_FINAL_FLUSH_DISABLED");
    if (result.remaining > 0 || result.inProgress > 0) {
      // Loud and content-free: this route evidence is lost (remaining) or may be lost (inProgress) when the process exits.
      this.logger.error("audit.deferred.unflushed_at_shutdown", {
        remaining: result.remaining,
        inProgress: result.inProgress,
        written: result.written,
        dropped: result.dropped,
        reasonCode: result.reasonCode,
      });
    } else if (result.written + result.dropped > 0) {
      this.logger.warn("audit.deferred.final_flush", { written: result.written, dropped: result.dropped });
    }
    return result;
  }

  private async finalFlush(): Promise<DeferredFinalFlushResult> {
    const done = { written: 0, dropped: 0, reasonCode: null as string | null };
    let expired = false;
    const drain = (async () => {
      // A timer run still in progress counts toward the bound (a hung store must not stall shutdown).
      await this.running;
      // An append still in progress is waited for too: `flush` is serialized behind it, so it is
      // written, or queued and then flushed here, or still running when the bound expires (counted).
      while (!expired && (this.queue.depth > 0 || this.queue.inProgress > 0)) {
        const r = await this.runOnce();
        done.written += r.written;
        done.dropped += r.dropped;
        if (r.reasonCode !== null) {
          done.reasonCode = r.reasonCode;
          return;
        }
        // Nothing was queued once the appends it waited for returned; a later one is counted at the seal.
        if (r.written + r.dropped === 0) return;
      }
    })();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      // Deliberately NOT unref'd (unlike the run timer): a stuck flush may hold no event-loop handle
      // of its own, and the process must live until the bound expires and the loss is logged. Bounded
      // (at most finalFlushTimeoutMs) and cleared as soon as the drain settles.
      deadline = setTimeout(() => resolve("timeout"), this.finalFlushTimeoutMs);
    });
    const outcome = await Promise.race([drain.then(() => "drained" as const), timedOut]);
    clearTimeout(deadline);
    if (outcome === "timeout") {
      // A run still in progress finishes on its own; no further batch is started.
      expired = true;
      done.reasonCode = "DEFERRED_AUDIT_FINAL_FLUSH_TIMEOUT";
    }
    return this.sealCounting(done.written, done.dropped, done.reasonCode ?? (this.queue.depth > 0 ? "AUDIT_DEFERRED_QUEUE_PENDING" : "AUDIT_DEFERRED_APPEND_IN_PROGRESS"));
  }

  /**
   * Counts what is still queued and the appends still running, and seals the queue, in one synchronous
   * step: every later event that cannot be appended at once is reported by the queue itself.
   */
  private sealCounting(written: number, dropped: number, reasonIfRemaining: string): DeferredFinalFlushResult {
    const remaining = this.queue.depth;
    const inProgress = this.queue.inProgress;
    try {
      this.queue.seal();
    } catch (err) {
      // Never blocks the shutdown report; a later event could then be queued unreported, so say so.
      this.logger.error("audit.deferred.seal_failed", { reasonCode: reasonOf(err, "DEFERRED_AUDIT_SEAL_FAILED") });
    }
    return { written, dropped, remaining, inProgress, reasonCode: remaining > 0 || inProgress > 0 ? reasonIfRemaining : null };
  }
}
