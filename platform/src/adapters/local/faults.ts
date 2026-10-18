/**
 * LOCAL FIXTURE fault injection shared by every SYNTHETIC business-system and
 * vendor fixture (spec section 14: "Test vendor and business failures: all
 * timeouts, stale knowledge, exhausted quotas, out-of-order events, duplicate
 * callbacks, partial writes, process crash after external commit, ... human
 * receiver unavailable, dropped bridge").
 *
 * A FaultPlan is a list of FaultSpecs, each targeting one integration and one
 * operation (or "*" for every operation of that integration). A fault fires
 * once (default), a fixed number of times, or persistently until cleared, and
 * can skip the first N matching calls. Everything is deterministic: no random
 * numbers, no wall-clock reads; SLOW uses the injectable `sleep`.
 *
 * Mapping to DependencyError outcomes (platform/src/shared/errors.ts):
 *   OUTAGE               -> CONNECTION_REFUSED   NOT_STARTED (retryable)  nothing applied
 *   TIMEOUT_BEFORE_SEND  -> TIMEOUT_BEFORE_SEND  NOT_STARTED (retryable)  nothing applied
 *   QUOTA_EXHAUSTED      -> HTTP_429             NOT_STARTED (retryable)  nothing applied, httpStatus 429
 *   REJECTED             -> DEPENDENCY_REJECTED  FAILED (not retryable)   definite refusal, nothing applied, httpStatus 400
 *   TIMEOUT_AFTER_COMMIT -> TIMEOUT_AFTER_SEND   UNKNOWN (never retried)  effect APPLIED first (ACT-03)
 *   PARTIAL_WRITE        -> PARTIAL_WRITE        UNKNOWN (never retried)  first step of a multi-step write applied
 *   SLOW(ms)             -> no error; delays the call by `delayMs` before it proceeds
 *   STALE_READ           -> no error; reads return the record version before its latest change
 *   DUPLICATE_DELIVERY   -> no error; the request (or event) is delivered twice
 *   OUT_OF_ORDER         -> no error; events are delivered in a permuted order
 *
 * Precedence when several faults match one call: SLOW always applies; then at
 * most one pre-send failure fires (OUTAGE, then QUOTA_EXHAUSTED, then
 * TIMEOUT_BEFORE_SEND, then REJECTED) and the remaining matching faults are NOT consumed, so
 * a later call still sees them. At most one fault of each kind fires per call.
 *
 * Fixtures declare which kinds each operation supports. Injecting a kind an
 * operation cannot honour is rejected (a fault test that silently does nothing
 * would be a test that did not run: OPS-03); `unconsumed()` reports planned
 * faults that never fired.
 */
import { z } from "zod";
import { ValidationError } from "../../shared/errors.js";
import { ADAPTER_REASON, AdapterDependencyError } from "../errors.js";

export const FaultKind = z.enum([
  "OUTAGE",
  "TIMEOUT_BEFORE_SEND",
  "TIMEOUT_AFTER_COMMIT",
  "SLOW",
  "QUOTA_EXHAUSTED",
  /** Definite refusal by the dependency (e.g. HTTP 400 / 422): FAILED, nothing applied. Not in the spec list; added so FAILED is testable. */
  "REJECTED",
  "STALE_READ",
  "PARTIAL_WRITE",
  "DUPLICATE_DELIVERY",
  "OUT_OF_ORDER",
]);
export type FaultKind = z.infer<typeof FaultKind>;

/** Pre-send failures in precedence order. */
const PRE_SEND_PRECEDENCE: readonly FaultKind[] = ["OUTAGE", "QUOTA_EXHAUSTED", "TIMEOUT_BEFORE_SEND", "REJECTED"];

/** Kinds every read operation supports. */
export const READ_FAULTS: readonly FaultKind[] = ["OUTAGE", "TIMEOUT_BEFORE_SEND", "SLOW", "QUOTA_EXHAUSTED", "REJECTED", "STALE_READ"];
/** Kinds every idempotent write operation supports. */
export const WRITE_FAULTS: readonly FaultKind[] = [
  "OUTAGE",
  "TIMEOUT_BEFORE_SEND",
  "TIMEOUT_AFTER_COMMIT",
  "SLOW",
  "QUOTA_EXHAUSTED",
  "REJECTED",
  "PARTIAL_WRITE",
  "DUPLICATE_DELIVERY",
];

const DEFAULT_RETRY_AFTER_MS = 1_000;

export const FaultSpec = z
  .strictObject({
    integrationId: z.string().regex(/^[a-z][a-z0-9-]{2,63}$/),
    /** Operation (method name) or "*" for every operation of the integration that supports the kind. */
    operation: z.string().regex(/^(\*|[a-zA-Z][a-zA-Z0-9]{1,63})$/),
    kind: FaultKind,
    mode: z
      .union([z.literal("once"), z.literal("persistent"), z.strictObject({ times: z.number().int().min(1).max(10_000) })])
      .default("once"),
    /** Matching calls that pass untouched before the fault becomes eligible. */
    skip: z.number().int().min(0).max(10_000).default(0),
    /** SLOW only: delay applied before the call proceeds. */
    delayMs: z.number().int().min(1).max(120_000).optional(),
    /** QUOTA_EXHAUSTED only: Retry-After surfaced on the error. */
    retryAfterMs: z.number().int().min(0).max(3_600_000).optional(),
  })
  .superRefine((s, ctx) => {
    if (s.kind === "SLOW" && s.delayMs === undefined) ctx.addIssue({ code: "custom", message: "SLOW requires delayMs" });
    if (s.kind !== "SLOW" && s.delayMs !== undefined) ctx.addIssue({ code: "custom", message: "delayMs only applies to SLOW" });
    if (s.kind !== "QUOTA_EXHAUSTED" && s.retryAfterMs !== undefined) ctx.addIssue({ code: "custom", message: "retryAfterMs only applies to QUOTA_EXHAUSTED" });
  });
export type FaultSpec = z.infer<typeof FaultSpec>;
export type FaultSpecInput = z.input<typeof FaultSpec>;
/** A fault plan is an ordered list of specs; order decides which same-kind fault fires first. */
export type FaultPlan = readonly FaultSpecInput[];

export interface FaultActivation {
  faultId: string;
  integrationId: string;
  operation: string;
  kind: FaultKind;
  /** 1-based index of the call to this integration/operation. */
  call: number;
  /** Global activation order across the injector. */
  sequence: number;
}

interface PlannedFault {
  id: string;
  spec: FaultSpec;
  /** Matching calls observed (for `skip`). */
  seen: number;
  fired: number;
  remaining: number;
}

export type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface FaultInjectorOptions {
  /** Used by SLOW. Tests may inject a recorder; the default uses a timer. */
  sleep?: Sleep;
  plan?: FaultPlan;
}

export class FaultInjector {
  readonly kind = "local_fixture" as const;
  readonly label = "LOCAL FIXTURE fault injector — SYNTHETIC";
  private readonly planned: PlannedFault[] = [];
  private readonly declarations = new Map<string, Map<string, ReadonlySet<FaultKind>>>();
  private readonly callCounts = new Map<string, number>();
  private readonly log: FaultActivation[] = [];
  private nextFault = 1;
  private sequence = 0;
  private readonly sleep: Sleep;

  constructor(opts: FaultInjectorOptions = {}) {
    this.sleep = opts.sleep ?? realSleep;
    for (const spec of opts.plan ?? []) this.inject(spec);
  }

  /** Called by fixtures at construction: which fault kinds each operation can honour. */
  declare(integrationId: string, operations: Readonly<Record<string, readonly FaultKind[]>>): void {
    let ops = this.declarations.get(integrationId);
    if (!ops) {
      ops = new Map();
      this.declarations.set(integrationId, ops);
    }
    for (const [op, kinds] of Object.entries(operations)) ops.set(op, new Set(kinds));
  }

  /** Plans a fault. Returns a deterministic fault id ("flt-1", "flt-2", ...). */
  inject(input: FaultSpecInput): string {
    const parsed = FaultSpec.safeParse(input);
    if (!parsed.success) throw new ValidationError("FAULT_SPEC_INVALID");
    const spec = parsed.data;
    const ops = this.declarations.get(spec.integrationId);
    if (ops) {
      if (spec.operation === "*") {
        if (![...ops.values()].some((k) => k.has(spec.kind))) throw new ValidationError("FAULT_KIND_UNSUPPORTED");
      } else {
        const kinds = ops.get(spec.operation);
        if (!kinds) throw new ValidationError("FAULT_OPERATION_UNKNOWN");
        if (!kinds.has(spec.kind)) throw new ValidationError("FAULT_KIND_UNSUPPORTED");
      }
    }
    const id = `flt-${this.nextFault++}`;
    const remaining = spec.mode === "once" ? 1 : spec.mode === "persistent" ? Number.POSITIVE_INFINITY : spec.mode.times;
    this.planned.push({ id, spec, seen: 0, fired: 0, remaining });
    return id;
  }

  /** Removes one planned fault, or every planned fault when no id is given. */
  clear(faultId?: string): void {
    if (faultId === undefined) {
      this.planned.length = 0;
      return;
    }
    const i = this.planned.findIndex((p) => p.id === faultId);
    if (i >= 0) this.planned.splice(i, 1);
  }

  /** Clears planned faults, call counters and the activation log (declarations are kept). */
  reset(): void {
    this.planned.length = 0;
    this.callCounts.clear();
    this.log.length = 0;
    this.sequence = 0;
  }

  /**
   * Starts one call to `integrationId.operation`: counts it, selects the faults
   * that fire for it (consuming one-shot / counted faults) and returns them.
   */
  begin(integrationId: string, operation: string): ActiveFaults {
    const key = `${integrationId}/${operation}`;
    const call = (this.callCounts.get(key) ?? 0) + 1;
    this.callCounts.set(key, call);
    const supported = this.declarations.get(integrationId)?.get(operation);
    if (!supported) return new ActiveFaults(integrationId, operation, [], this.sleep);

    const eligible: PlannedFault[] = [];
    for (const p of this.planned) {
      if (p.remaining <= 0 || p.spec.integrationId !== integrationId) continue;
      if (p.spec.operation !== "*" && p.spec.operation !== operation) continue;
      if (!supported.has(p.spec.kind)) continue;
      p.seen += 1;
      if (p.seen > p.spec.skip) eligible.push(p);
    }
    const firstOfKind = new Map<FaultKind, PlannedFault>();
    for (const p of eligible) if (!firstOfKind.has(p.spec.kind)) firstOfKind.set(p.spec.kind, p);
    const preSendKind = PRE_SEND_PRECEDENCE.find((k) => firstOfKind.has(k));
    const firing = [...firstOfKind.values()].filter((p) => preSendKind === undefined || p.spec.kind === preSendKind || p.spec.kind === "SLOW");
    for (const p of firing) {
      p.remaining -= 1;
      p.fired += 1;
      this.log.push({ faultId: p.id, integrationId, operation, kind: p.spec.kind, call, sequence: ++this.sequence });
    }
    return new ActiveFaults(
      integrationId,
      operation,
      firing.map((p) => p.spec),
      this.sleep,
    );
  }

  /** True while an OUTAGE fault with remaining activations is planned for the integration (used by health()). */
  isDegraded(integrationId: string): boolean {
    return this.planned.some((p) => p.spec.integrationId === integrationId && p.spec.kind === "OUTAGE" && p.remaining > 0);
  }

  get activations(): readonly FaultActivation[] {
    return this.log.map((a) => ({ ...a }));
  }

  /** Planned faults that have never fired. A fault test whose fault never fired did not test anything. */
  unconsumed(): { faultId: string; spec: FaultSpec }[] {
    return this.planned.filter((p) => p.fired === 0).map((p) => ({ faultId: p.id, spec: { ...p.spec } }));
  }

  callCount(integrationId: string, operation: string): number {
    return this.callCounts.get(`${integrationId}/${operation}`) ?? 0;
  }
}

/** The faults firing for one call. Fixtures consult it at the right points of the operation. */
export class ActiveFaults {
  private readonly kindSet: ReadonlySet<FaultKind>;

  constructor(
    readonly integrationId: string,
    readonly operation: string,
    private readonly specs: readonly FaultSpec[],
    private readonly sleep: Sleep,
  ) {
    this.kindSet = new Set(specs.map((s) => s.kind));
  }

  get kinds(): FaultKind[] {
    return [...this.kindSet];
  }

  has(kind: FaultKind): boolean {
    return this.kindSet.has(kind);
  }

  /** SLOW delay, then the pre-send failure (if any). Nothing has been applied when this throws. */
  async beforeSend(): Promise<void> {
    const delay = this.specs.filter((s) => s.kind === "SLOW").reduce((sum, s) => sum + (s.delayMs ?? 0), 0);
    if (delay > 0) await this.sleep(delay);
    const details = { integrationId: this.integrationId, operation: this.operation, injected: true };
    if (this.has("OUTAGE")) throw new AdapterDependencyError(ADAPTER_REASON.CONNECTION_REFUSED, "NOT_STARTED", details);
    if (this.has("QUOTA_EXHAUSTED")) {
      const spec = this.specs.find((s) => s.kind === "QUOTA_EXHAUSTED");
      throw new AdapterDependencyError(ADAPTER_REASON.HTTP_429, "NOT_STARTED", {
        ...details,
        httpStatus: 429,
        retryAfterMs: spec?.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS,
      });
    }
    if (this.has("TIMEOUT_BEFORE_SEND")) throw new AdapterDependencyError(ADAPTER_REASON.TIMEOUT_BEFORE_SEND, "NOT_STARTED", details);
    if (this.has("REJECTED")) throw new AdapterDependencyError(ADAPTER_REASON.DEPENDENCY_REJECTED, "FAILED", { ...details, httpStatus: 400, retryable: false });
  }

  /** Call AFTER the effect has been applied: an ambiguous timeout hides a committed effect (ACT-03). */
  afterCommit(): void {
    if (this.has("TIMEOUT_AFTER_COMMIT")) {
      throw new AdapterDependencyError(ADAPTER_REASON.TIMEOUT_AFTER_SEND, "UNKNOWN", {
        integrationId: this.integrationId,
        operation: this.operation,
        injected: true,
      });
    }
  }

  /** Error for a write whose first step was applied but whose remaining steps were not. */
  partialWriteError(): AdapterDependencyError {
    return new AdapterDependencyError(ADAPTER_REASON.PARTIAL_WRITE, "UNKNOWN", {
      integrationId: this.integrationId,
      operation: this.operation,
      injected: true,
    });
  }
}

/** Shared default so fixtures without an explicit injector behave as fault-free. */
export const noFaults = (): FaultInjector => new FaultInjector();
