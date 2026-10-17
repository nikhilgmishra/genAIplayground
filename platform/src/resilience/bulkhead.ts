/**
 * Per-dependency bulkhead: bounded concurrency plus a bounded wait queue, so a
 * slow dependency cannot absorb every worker (spec section 12: bulkheads,
 * backpressure). Overflow is rejected immediately with BULKHEAD_FULL (outcome
 * NOT_STARTED, not retryable: backpressure must propagate, not be retried).
 */
import { DependencyError, ValidationError } from "../shared/errors.js";
import type { Metrics } from "../observability/ports.js";
import { systemTimers } from "./timeout.js";
import type { TimerPort } from "./timeout.js";

export interface BulkheadOptions {
  dependency: string;
  maxConcurrent: number;
  maxQueue: number;
  /** Maximum time a call may wait for a slot; omitted = waits until a slot or abort. */
  queueTimeoutMs?: number;
  timers?: TimerPort;
  metrics?: Metrics;
}

interface Waiter {
  grant: () => void;
  cancel: (err: DependencyError) => void;
}

export class Bulkhead {
  private running = 0;
  private readonly queue: Waiter[] = [];
  private readonly timers: TimerPort;

  constructor(private readonly opts: BulkheadOptions) {
    const ok =
      Number.isInteger(opts.maxConcurrent) &&
      opts.maxConcurrent >= 1 &&
      Number.isInteger(opts.maxQueue) &&
      opts.maxQueue >= 0 &&
      (opts.queueTimeoutMs === undefined || (Number.isInteger(opts.queueTimeoutMs) && opts.queueTimeoutMs > 0));
    if (!ok) throw new ValidationError("BULKHEAD_SETTINGS_INVALID");
    this.timers = opts.timers ?? systemTimers;
  }

  get active(): number {
    return this.running;
  }

  get queued(): number {
    return this.queue.length;
  }

  async run<T>(fn: () => Promise<T>, runOpts: { signal?: AbortSignal } = {}): Promise<T> {
    if (runOpts.signal?.aborted) throw this.reject("CALLER_ABORTED");
    if (this.running < this.opts.maxConcurrent) {
      this.running += 1;
    } else if (this.queue.length < this.opts.maxQueue) {
      await this.wait(runOpts.signal);
    } else {
      throw this.reject("BULKHEAD_FULL");
    }
    this.publish();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private wait(signal: AbortSignal | undefined): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let timer: unknown = null;
      const cleanup = () => {
        if (timer !== null) this.timers.clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const i = this.queue.indexOf(waiter);
        if (i >= 0) this.queue.splice(i, 1);
      };
      const waiter: Waiter = {
        grant: () => {
          cleanup();
          resolve();
        },
        cancel: (err) => {
          cleanup();
          this.publish();
          reject(err);
        },
      };
      const onAbort = () => waiter.cancel(this.reject("CALLER_ABORTED"));
      if (this.opts.queueTimeoutMs !== undefined) {
        timer = this.timers.setTimeout(() => waiter.cancel(this.reject("BULKHEAD_QUEUE_TIMEOUT")), this.opts.queueTimeoutMs);
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(waiter);
      this.publish();
    });
  }

  private release(): void {
    const next = this.queue[0];
    if (next) {
      // Hand the slot directly to the next waiter; `running` is unchanged.
      next.grant();
    } else {
      this.running -= 1;
    }
    this.publish();
  }

  private reject(reason: "BULKHEAD_FULL" | "BULKHEAD_QUEUE_TIMEOUT" | "CALLER_ABORTED"): DependencyError {
    this.opts.metrics?.increment("vsp_bulkhead_rejections_total", { dependency: this.opts.dependency, reason });
    return new DependencyError(reason, "NOT_STARTED", false);
  }

  private publish(): void {
    this.opts.metrics?.gauge("vsp_bulkhead_active", this.running, { dependency: this.opts.dependency });
    this.opts.metrics?.gauge("vsp_bulkhead_queued", this.queue.length, { dependency: this.opts.dependency });
  }
}
