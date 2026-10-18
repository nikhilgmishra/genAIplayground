/**
 * Per-dependency circuit breaker (closed / open / half-open) with a rolling
 * failure window and a Clock-driven cooldown.
 *
 * - closed: calls pass; outcomes are recorded in a rolling window of `windowMs`.
 *   When at least `minimumRequests` outcomes are in the window and the failure
 *   rate reaches `failureRateThreshold`, the circuit opens.
 * - open: calls are rejected immediately with CIRCUIT_OPEN (outcome NOT_STARTED,
 *   not retryable: retrying an open circuit only adds load). After `cooldownMs`
 *   the next call moves the circuit to half-open.
 * - half-open: up to `halfOpenMaxProbes` concurrent probe calls pass; any probe
 *   failure re-opens the circuit; `halfOpenSuccessesToClose` probe successes close it.
 *
 * Opening a breaker closes access to the affected dependency only. Safety and
 * human routing must never depend on a breaker-protected call (OPS-02).
 */
import type { Clock } from "../shared/clock.js";
import { DependencyError, PlatformError, ValidationError } from "../shared/errors.js";
import type { Metrics } from "../observability/ports.js";
import { CIRCUIT_STATES } from "../observability/metrics.js";

export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitBreakerSettings {
  windowMs: number;
  minimumRequests: number;
  /** 0 < threshold <= 1 */
  failureRateThreshold: number;
  cooldownMs: number;
  halfOpenMaxProbes: number;
  halfOpenSuccessesToClose: number;
  /** Which errors count as dependency failures. Default: everything except caller-side/policy errors and local backpressure. */
  isFailure?: (err: unknown) => boolean;
}

export interface CircuitBreakerOptions extends CircuitBreakerSettings {
  dependency: string;
  clock: Clock;
  metrics?: Metrics;
}

export class CircuitOpenError extends DependencyError {
  constructor() {
    super("CIRCUIT_OPEN", "NOT_STARTED", false);
  }
}

/** Upper bound on remembered outcomes so the window stays bounded in memory. */
const MAX_WINDOW_ENTRIES = 10_000;

const NON_FAILURE_CODES = new Set(["CIRCUIT_OPEN", "BULKHEAD_FULL", "BULKHEAD_QUEUE_TIMEOUT", "CALLER_ABORTED"]);

/** Default failure classifier: dependency errors and unclassified errors count; local backpressure and caller errors do not. */
export function defaultIsFailure(err: unknown): boolean {
  if (err instanceof DependencyError) return !NON_FAILURE_CODES.has(err.reasonCode);
  if (err instanceof PlatformError) return false;
  return true;
}

export interface CircuitSnapshot {
  dependency: string;
  state: CircuitState;
  windowRequests: number;
  windowFailures: number;
  openedAt: string | null;
}

function validateSettings(s: CircuitBreakerSettings): void {
  const ok =
    Number.isInteger(s.windowMs) &&
    s.windowMs > 0 &&
    Number.isInteger(s.minimumRequests) &&
    s.minimumRequests >= 1 &&
    s.failureRateThreshold > 0 &&
    s.failureRateThreshold <= 1 &&
    Number.isInteger(s.cooldownMs) &&
    s.cooldownMs > 0 &&
    Number.isInteger(s.halfOpenMaxProbes) &&
    s.halfOpenMaxProbes >= 1 &&
    Number.isInteger(s.halfOpenSuccessesToClose) &&
    s.halfOpenSuccessesToClose >= 1;
  if (!ok) throw new ValidationError("CIRCUIT_SETTINGS_INVALID");
}

export class CircuitBreaker {
  private current: CircuitState = "closed";
  private window: { at: number; ok: boolean }[] = [];
  private openedAtMs: number | null = null;
  private probesInFlight = 0;
  private probeSuccesses = 0;
  private readonly isFailure: (err: unknown) => boolean;

  constructor(private readonly opts: CircuitBreakerOptions) {
    validateSettings(opts);
    this.isFailure = opts.isFailure ?? defaultIsFailure;
    this.publishHealth();
  }

  get dependency(): string {
    return this.opts.dependency;
  }

  /** Current state, applying the time-based open → half-open transition. */
  state(): CircuitState {
    if (this.current === "open" && this.openedAtMs !== null && this.now() - this.openedAtMs >= this.opts.cooldownMs) {
      this.transition("half_open");
    }
    return this.current;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.state();
    if (state === "open" || (state === "half_open" && this.probesInFlight >= this.opts.halfOpenMaxProbes)) {
      this.opts.metrics?.increment("vsp_circuit_rejections_total", { dependency: this.opts.dependency });
      throw new CircuitOpenError();
    }
    const isProbe = state === "half_open";
    if (isProbe) this.probesInFlight += 1;
    try {
      const v = await fn();
      this.onResult("success", isProbe);
      return v;
    } catch (err) {
      // Errors that are not dependency failures (caller abort, local backpressure,
      // validation) are neutral: they neither open nor close the circuit.
      this.onResult(this.isFailure(err) ? "failure" : "neutral", isProbe);
      throw err;
    } finally {
      if (isProbe) this.probesInFlight -= 1;
    }
  }

  /** Operator / test control: open immediately (e.g. dependency declared down). */
  trip(): void {
    this.transition("open");
  }

  /** Operator / test control: close and clear history. */
  reset(): void {
    this.transition("closed");
  }

  snapshot(): CircuitSnapshot {
    const state = this.state();
    this.prune();
    return {
      dependency: this.opts.dependency,
      state,
      windowRequests: this.window.length,
      windowFailures: this.window.filter((e) => !e.ok).length,
      openedAt: this.openedAtMs === null ? null : new Date(this.openedAtMs).toISOString(),
    };
  }

  private onResult(result: "success" | "failure" | "neutral", isProbe: boolean): void {
    if (result === "neutral") return;
    const ok = result === "success";
    if (isProbe) {
      // The circuit may have been reset/tripped by an operator while the probe ran.
      if (this.current !== "half_open") return;
      if (!ok) {
        this.transition("open");
        return;
      }
      this.probeSuccesses += 1;
      if (this.probeSuccesses >= this.opts.halfOpenSuccessesToClose) this.transition("closed");
      return;
    }
    if (this.current !== "closed") return;
    this.window.push({ at: this.now(), ok });
    if (this.window.length > MAX_WINDOW_ENTRIES) this.window.shift();
    this.prune();
    const total = this.window.length;
    if (total < this.opts.minimumRequests) return;
    const failures = this.window.filter((e) => !e.ok).length;
    if (failures / total >= this.opts.failureRateThreshold) this.transition("open");
  }

  private prune(): void {
    const cutoff = this.now() - this.opts.windowMs;
    while (this.window.length > 0 && (this.window[0]?.at ?? 0) <= cutoff) this.window.shift();
  }

  private transition(to: CircuitState): void {
    const from = this.current;
    this.current = to;
    this.probeSuccesses = 0;
    if (to === "open") this.openedAtMs = this.now();
    if (to === "closed") {
      this.openedAtMs = null;
      this.window = [];
    }
    if (from !== to) this.opts.metrics?.increment("vsp_circuit_transitions_total", { dependency: this.opts.dependency, circuit_state: to });
    this.publishHealth();
  }

  private publishHealth(): void {
    for (const s of CIRCUIT_STATES) {
      this.opts.metrics?.gauge("vsp_dependency_health", s === this.current ? 1 : 0, { dependency: this.opts.dependency, circuit_state: s });
    }
  }

  private now(): number {
    return this.opts.clock.now().getTime();
  }
}

/** One breaker per dependency, created on first use with defaults plus per-dependency overrides. */
export class CircuitBreakerRegistry {
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(
    private readonly deps: { clock: Clock; metrics?: Metrics },
    private readonly defaults: CircuitBreakerSettings,
    private readonly overrides: Readonly<Record<string, Partial<CircuitBreakerSettings>>> = {},
  ) {
    validateSettings(defaults);
  }

  get(dependency: string): CircuitBreaker {
    let b = this.breakers.get(dependency);
    if (!b) {
      const o = Object.hasOwn(this.overrides, dependency) ? this.overrides[dependency] : undefined;
      b = new CircuitBreaker({ ...this.defaults, ...(o ?? {}), dependency, clock: this.deps.clock, metrics: this.deps.metrics });
      this.breakers.set(dependency, b);
    }
    return b;
  }

  snapshot(): CircuitSnapshot[] {
    return [...this.breakers.values()].map((b) => b.snapshot()).sort((a, b) => a.dependency.localeCompare(b.dependency));
  }

  openDependencies(): string[] {
    return this.snapshot()
      .filter((s) => s.state !== "closed")
      .map((s) => s.dependency);
  }
}
