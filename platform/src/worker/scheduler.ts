/**
 * Injectable loop schedulers. Each loop runs at most once at a time (no
 * overlap); a loop failure never stops the other loops.
 *
 * - TimerLoopScheduler: real timers (setTimeout chain, unref'd) for processes.
 * - ManualLoopScheduler: deterministic, clock-driven (FakeClock) for tests:
 *   `runDue()` runs every loop whose next run time has been reached.
 */
import type { Clock } from "../shared/clock.js";

export type LoopRun = () => Promise<void>;

export interface LoopScheduler {
  schedule(name: string, intervalMs: number, run: LoopRun): void;
  stop(): Promise<void>;
}

const validInterval = (ms: number): boolean => Number.isInteger(ms) && ms >= 10 && ms <= 7 * 86_400_000;

export class TimerLoopScheduler implements LoopScheduler {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inFlight = new Set<Promise<void>>();
  private stopped = false;

  schedule(name: string, intervalMs: number, run: LoopRun): void {
    if (!validInterval(intervalMs)) throw new RangeError("LOOP_INTERVAL_INVALID");
    if (this.timers.has(name)) throw new RangeError("LOOP_DUPLICATE");
    const tick = () => {
      if (this.stopped) return;
      const p = run()
        .catch(() => undefined)
        .finally(() => {
          this.inFlight.delete(p);
          if (!this.stopped) arm();
        });
      this.inFlight.add(p);
    };
    const arm = () => {
      const t = setTimeout(tick, intervalMs);
      t.unref?.();
      this.timers.set(name, t);
    };
    arm();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    await Promise.all([...this.inFlight]);
  }
}

export class ManualLoopScheduler implements LoopScheduler {
  private readonly loops = new Map<string, { intervalMs: number; run: LoopRun; nextAt: number }>();
  private stopped = false;

  constructor(private readonly clock: Clock) {}

  schedule(name: string, intervalMs: number, run: LoopRun): void {
    if (!validInterval(intervalMs)) throw new RangeError("LOOP_INTERVAL_INVALID");
    if (this.loops.has(name)) throw new RangeError("LOOP_DUPLICATE");
    this.loops.set(name, { intervalMs, run, nextAt: this.clock.now().getTime() + intervalMs });
  }

  names(): string[] {
    return [...this.loops.keys()].sort();
  }

  intervalOf(name: string): number | null {
    return this.loops.get(name)?.intervalMs ?? null;
  }

  /** Runs (sequentially, in name order) every loop that is due; returns the names run. */
  async runDue(): Promise<string[]> {
    if (this.stopped) return [];
    const now = this.clock.now().getTime();
    const ran: string[] = [];
    for (const name of this.names()) {
      const l = this.loops.get(name);
      if (!l || l.nextAt > now) continue;
      l.nextAt = now + l.intervalMs;
      await l.run().catch(() => undefined);
      ran.push(name);
    }
    return ran;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }
}
