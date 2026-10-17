/**
 * Admission control (spec section 12: capacity, admission control, backpressure,
 * load shedding, cost controls; invariants SAFE-02, SAFE-03, OPS-02).
 *
 * Order of evaluation for a request:
 *  1. SAFETY and HUMAN_ROUTE are admitted immediately, before any I/O, whatever
 *     the budget, kill switches, capacity or degradation state. New sessions in
 *     these classes draw from the safety reserve, which is always granted;
 *     exceeding it raises an alert (never a block).
 *  2. Kill switches (read fails closed to "all engaged").
 *  3. Load shedding by degradation level: ANALYTICS first, then PUBLIC and
 *     PROTECTED_READ, then WRITE when the platform is degraded.
 *  4. Budgets (projected spend including metering delay; missing budget or
 *     unreadable budget state fails closed for nonessential work).
 *  5. Capacity for new AI sessions (bounded pool, controlled admission).
 *
 * Every refusal of caller-facing work carries an approved continuity route
 * (human queue, callback intake, or outage message then human): never a silent
 * drop. Only ANALYTICS, which has no caller, is refused with continuity NONE.
 */
import { z } from "zod";
import type { Logger, Metrics } from "../observability/ports.js";
import { silentLogger } from "../observability/logger.js";
import { Environment, OpaqueId } from "../protocol/index.js";
import type { Clock } from "../shared/clock.js";
import { PlatformError, ValidationError } from "../shared/errors.js";
import type { SessionCapacity } from "./capacity.js";
import { killSwitchBlock } from "./kill-switches.js";
import type { AdmissionClass, AdmissionController, AdmissionDecision, BudgetService, KillSwitchService } from "./ports.js";
import { SpendToken } from "./budgets.js";

export const ADMISSION_CLASS_VALUES = ["SAFETY", "HUMAN_ROUTE", "PROTECTED_READ", "WRITE", "PUBLIC", "ANALYTICS"] as const satisfies readonly AdmissionClass[];
export const ESSENTIAL_CLASSES: readonly AdmissionClass[] = ["SAFETY", "HUMAN_ROUTE"];

export type DegradationLevel = "NORMAL" | "ELEVATED" | "CONSTRAINED" | "DEGRADED";
export const DEGRADATION_LEVELS: readonly DegradationLevel[] = ["NORMAL", "ELEVATED", "CONSTRAINED", "DEGRADED"];

/** Classes shed at each level; each level sheds a superset of the previous one. */
export const DEFAULT_SHEDDING: Readonly<Record<DegradationLevel, readonly AdmissionClass[]>> = {
  NORMAL: [],
  ELEVATED: ["ANALYTICS"],
  CONSTRAINED: ["ANALYTICS", "PUBLIC", "PROTECTED_READ"],
  DEGRADED: ["ANALYTICS", "PUBLIC", "PROTECTED_READ", "WRITE"],
};

/** Validates a shedding table: monotonic, and never sheds SAFETY or HUMAN_ROUTE. */
export function validateShedding(table: Readonly<Record<DegradationLevel, readonly AdmissionClass[]>>): void {
  let prev = new Set<AdmissionClass>();
  for (const level of DEGRADATION_LEVELS) {
    const cur = new Set(table[level] ?? []);
    for (const c of cur) if (ESSENTIAL_CLASSES.includes(c)) throw new ValidationError("SHEDDING_ESSENTIAL_CLASS");
    for (const c of prev) if (!cur.has(c)) throw new ValidationError("SHEDDING_NOT_MONOTONIC");
    prev = cur;
  }
}

export interface LoadSignal {
  level(): DegradationLevel;
}

/** Operator / test controlled load signal. Automatic thresholds need measured load tests (TB-10). */
export class ManualLoadSignal implements LoadSignal {
  constructor(private current: DegradationLevel = "NORMAL") {}
  level(): DegradationLevel {
    return this.current;
  }
  set(level: DegradationLevel): void {
    this.current = level;
  }
}

export interface ContinuitySignal {
  /** Whether the staffed human queue is accepting callers; when not, callers go to callback intake. */
  humanQueueAvailable(): boolean;
}

export const AdmitInput = z.strictObject({
  tenantId: OpaqueId,
  class: z.enum(ADMISSION_CLASS_VALUES),
  vendor: SpendToken.nullable(),
  workflow: SpendToken.nullable(),
  cohort: SpendToken,
  newSession: z.boolean().optional(),
  modelVersion: z.string().max(64).nullable().optional(),
  voiceVersion: z.string().max(64).nullable().optional(),
});

export const RecordCostInput = z.strictObject({
  tenantId: OpaqueId,
  vendor: SpendToken,
  workflow: SpendToken,
  cohort: SpendToken,
  usd: z.number().finite().min(0),
  safety: z.boolean(),
});

export interface AdmissionControllerOptions {
  environment: Environment;
  killSwitches: KillSwitchService;
  budgets: BudgetService;
  capacity: SessionCapacity;
  clock: Clock;
  load?: LoadSignal;
  continuity?: ContinuitySignal;
  metrics?: Metrics;
  logger?: Logger;
  /** Fail closed when no budget covers nonessential work (default true). */
  requireBudget?: boolean;
  shedding?: Readonly<Record<DegradationLevel, readonly AdmissionClass[]>>;
}

type Continuity = AdmissionDecision["continuity"];

export class AdmissionControllerImpl implements AdmissionController {
  private readonly logger: Logger;
  private readonly shedding: Readonly<Record<DegradationLevel, readonly AdmissionClass[]>>;
  private readonly requireBudget: boolean;

  constructor(private readonly opts: AdmissionControllerOptions) {
    Environment.parse(opts.environment);
    this.shedding = opts.shedding ?? DEFAULT_SHEDDING;
    validateShedding(this.shedding);
    this.requireBudget = opts.requireBudget ?? true;
    this.logger = (opts.logger ?? silentLogger).child({ component: "admission" });
  }

  async admit(input: Parameters<AdmissionController["admit"]>[0]): Promise<AdmissionDecision> {
    // 1. Essential routes: decided from the class alone, before validation of any other field or any I/O.
    const cls = (input as { class?: unknown } | null)?.class;
    if (cls === "SAFETY" || cls === "HUMAN_ROUTE") return this.admitEssential(cls, (input as { newSession?: unknown }).newSession === true);

    const parsed = AdmitInput.safeParse(input);
    // Invalid input fails closed to a human route (it may still be a caller).
    if (!parsed.success) return this.decide(String(cls), false, "ADMISSION_INPUT_INVALID", this.callerContinuity());
    const req = parsed.data;
    const callerFacing = req.class !== "ANALYTICS";
    const refuse = (reason: string, continuity?: Continuity) =>
      this.decide(req.class, false, reason, callerFacing ? (continuity ?? this.callerContinuity()) : "NONE");

    // 2. Kill switches (snapshot fails closed inside the service; a throwing service also fails closed).
    let snapshot;
    try {
      snapshot = await this.opts.killSwitches.snapshot(req.tenantId);
    } catch {
      return refuse("KILL_SWITCH_STATE_UNAVAILABLE");
    }
    const blocked = killSwitchBlock(snapshot, {
      class: req.class,
      newSession: req.newSession === true,
      intent: req.workflow,
      integration: req.vendor,
      modelVersion: req.modelVersion ?? null,
      voiceVersion: req.voiceVersion ?? null,
    });
    if (blocked) return refuse(blocked);

    // 3. Load shedding.
    const level = this.loadLevel();
    if (this.shedding[level].includes(req.class)) {
      const reason = level === "ELEVATED" ? "LOAD_SHED_ELEVATED" : level === "CONSTRAINED" ? "LOAD_SHED_CONSTRAINED" : "LOAD_SHED_DEGRADED";
      return refuse(reason, level === "DEGRADED" ? "OUTAGE_MESSAGE_THEN_HUMAN" : undefined);
    }

    // 4. Budgets.
    let statuses;
    try {
      statuses = await this.opts.budgets.statusFor({
        tenantId: req.tenantId,
        environment: this.opts.environment,
        vendor: req.vendor,
        workflow: req.workflow,
        cohort: req.cohort,
        now: this.opts.clock.now(),
      });
    } catch {
      return refuse("BUDGET_STATE_UNAVAILABLE");
    }
    if (statuses.length === 0 && this.requireBudget) return refuse("BUDGET_NOT_CONFIGURED");
    if (statuses.some((s) => s.exhausted)) return refuse("BUDGET_EXHAUSTED");

    // 5. Capacity for new sessions (taken last so a refusal above never leaks a lease).
    if (req.newSession) {
      const lease = this.opts.capacity.tryAcquire();
      if (!lease) return refuse("CAPACITY_LIMIT");
      return this.decide(req.class, true, "ADMITTED", "NONE", lease.leaseId);
    }
    return this.decide(req.class, true, "ADMITTED", "NONE");
  }

  async recordCost(input: { tenantId: string; vendor: string; workflow: string; cohort: string; usd: number; safety: boolean }): Promise<void> {
    const parsed = RecordCostInput.safeParse(input);
    const safety = (input as { safety?: unknown } | null)?.safety === true;
    if (!parsed.success) {
      if (safety) {
        this.noteCostFailure(true, "COST_INPUT_INVALID");
        return;
      }
      throw new ValidationError("COST_INPUT_INVALID");
    }
    try {
      await this.opts.budgets.recordSpend({ ...parsed.data, environment: this.opts.environment, occurredAt: this.opts.clock.now() });
    } catch (err) {
      const code = err instanceof PlatformError ? err.reasonCode : "UNCLASSIFIED_ERROR";
      // Metering failure must never interrupt a safety flow.
      if (parsed.data.safety) {
        this.noteCostFailure(true, code);
        return;
      }
      this.noteCostFailure(false, code);
      throw err;
    }
  }

  releaseSession(leaseId: string): void {
    this.opts.capacity.release(leaseId);
  }

  private admitEssential(cls: "SAFETY" | "HUMAN_ROUTE", newSession: boolean): AdmissionDecision {
    let reason = cls === "SAFETY" ? "SAFETY_ALWAYS_ADMITTED" : "HUMAN_ROUTE_ALWAYS_ADMITTED";
    let leaseId: string | null = null;
    if (newSession) {
      try {
        const { lease, overReserve } = this.opts.capacity.acquireReserve();
        leaseId = lease.leaseId;
        if (overReserve) {
          reason = "SAFETY_RESERVE_EXCEEDED_ESCALATE";
          this.safely(() => this.opts.metrics?.increment("vsp_safety_reserve_overdraw_total", { reserve: "sessions" }));
          this.safely(() => this.logger.warn("admission.safety_reserve.exceeded", { reasonCode: reason }));
        }
      } catch {
        // Capacity bookkeeping failure never blocks an essential route.
        leaseId = null;
      }
    }
    return this.decide(cls, true, reason, "NONE", leaseId);
  }

  private decide(cls: AdmissionClass | string, admitted: boolean, reasonCode: string, continuity: Continuity, sessionLeaseId: string | null = null): AdmissionDecision {
    this.safely(() =>
      this.opts.metrics?.increment("vsp_admission_decisions_total", { admission_class: cls, admitted: String(admitted), reason: reasonCode, continuity }),
    );
    if (!admitted) this.safely(() => this.logger.info("admission.refused", { reasonCode, route: continuity, scope: cls }));
    return { admitted, continuity, reasonCode, sessionLeaseId };
  }

  private callerContinuity(): Continuity {
    try {
      return this.opts.continuity?.humanQueueAvailable() === false ? "CALLBACK_INTAKE" : "HUMAN_QUEUE";
    } catch {
      return "CALLBACK_INTAKE";
    }
  }

  private loadLevel(): DegradationLevel {
    try {
      const l = this.opts.load?.level() ?? "NORMAL";
      return DEGRADATION_LEVELS.includes(l) ? l : "DEGRADED";
    } catch {
      // An unreadable load signal is treated as degraded (fail closed for nonessential work).
      return "DEGRADED";
    }
  }

  private noteCostFailure(safety: boolean, reasonCode: string): void {
    this.safely(() => this.opts.metrics?.increment("vsp_cost_record_failures_total", { safety: String(safety) }));
    this.safely(() => this.logger.warn("admission.cost_record.failed", { reasonCode }));
  }

  /** Observability side effects must never change an admission outcome. */
  private safely(fn: () => void): void {
    try {
      fn();
    } catch {
      // intentionally ignored
    }
  }
}
