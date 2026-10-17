/**
 * LOCAL FIXTURE implementations of the ops ports for the offline slice, the
 * local demo and other modules' tests. In-memory, per process, kind
 * "local_fixture": the production guard rejects local fixtures (OPS-04).
 * They apply the same authorization, validation and fail-closed rules as the
 * PostgreSQL implementations.
 */
import type { AuditWriter } from "../audit/ports.js";
import { KillSwitch, OpaqueId } from "../protocol/index.js";
import type { Budget, KillSwitchScope, StaffActor } from "../protocol/index.js";
import type { Clock } from "../shared/clock.js";
import { iso } from "../shared/clock.js";
import { AccessDeniedError, ValidationError } from "../shared/errors.js";
import { newId } from "../shared/ids.js";
import { BudgetDefinitionInput, SpendInput, StatusQuery, computeBudgetPosition, fromMicroUsd, toMicroUsd } from "./budgets.js";
import { KillSwitchSetInput, snapshotFromEngaged } from "./kill-switches.js";
import type { BudgetService, BudgetStatus, KillSwitchService, KillSwitchSnapshot } from "./ports.js";
import { BUDGET_ROLES, KILL_SWITCH_ROLES, authorizeStaff } from "./staff-authz.js";

export const OPS_FIXTURE_BADGE = "LOCAL FIXTURE — in-memory ops state, not durable";

export class LocalFixtureKillSwitchService implements KillSwitchService {
  readonly kind = "local_fixture" as const;
  private readonly state = new Map<string, KillSwitch & { tenantId: string; version: number }>();
  readonly history: (KillSwitch & { tenantId: string; version: number })[] = [];

  constructor(private readonly opts: { clock: Clock; audit?: AuditWriter }) {}

  async snapshot(tenantId: string): Promise<KillSwitchSnapshot> {
    if (!OpaqueId.safeParse(tenantId).success) return snapshotFromEngaged([{ scope: "AI_ADMISSION", target: "*" }, { scope: "WRITES", target: "*" }, { scope: "OUTBOUND_NOTIFICATIONS", target: "*" }]);
    return snapshotFromEngaged([...this.state.values()].filter((s) => s.tenantId === tenantId && s.engaged));
  }

  async set(input: { tenantId: string; scope: KillSwitchScope; target: string; engaged: boolean; reason: string; staff: StaffActor; correlationId?: string }): Promise<KillSwitch> {
    const parsed = KillSwitchSetInput.safeParse(input);
    if (!parsed.success) throw new ValidationError("KILL_SWITCH_INPUT_INVALID");
    const req = parsed.data;
    const now = this.opts.clock.now();
    const { staff, role } = authorizeStaff(req.staff, KILL_SWITCH_ROLES[req.scope], now);
    const key = `${req.tenantId}|${req.scope}|${req.target}`;
    const prior = this.state.get(key);
    const ks = KillSwitch.parse({
      switchId: prior?.switchId ?? newId("ksw"),
      scope: req.scope,
      target: req.target,
      engaged: req.engaged,
      reason: req.reason,
      changedBy: staff.staffId,
      changedAt: iso(now),
    });
    if (this.opts.audit) {
      await this.opts.audit.appendStandalone({
        occurredAt: iso(now),
        correlationId: req.correlationId ?? newId("cor"),
        parentId: null,
        tenantId: req.tenantId,
        actorRef: staff.staffId,
        subjectRef: null,
        role,
        sourceComponent: "console",
        callId: null,
        sessionRef: null,
        sessionGeneration: null,
        turnId: null,
        versions: null,
        action: "killswitch.set",
        policyDecision: null,
        assurance: null,
        evidencePointers: [],
        beforeHash: null,
        afterHash: null,
        idempotencyKey: null,
        outcome: "SUCCEEDED",
        reasonCode: req.reason.split(":")[0] ?? null,
        dataClass: "SECURITY_AUDIT",
      });
    }
    const row = { ...ks, tenantId: req.tenantId, version: (prior?.version ?? 0) + 1 };
    this.state.set(key, row);
    this.history.push(row);
    return ks;
  }

  async list(tenantId: string): Promise<KillSwitch[]> {
    return [...this.state.values()].filter((s) => s.tenantId === tenantId).map(({ tenantId: _t, version: _v, ...ks }) => ks);
  }
}

interface FixtureBudget {
  tenantId: string;
  budget: Budget;
  limitMicro: number;
  reserveMicro: number;
  createdSeq: number;
}

export class LocalFixtureBudgetService implements BudgetService {
  readonly kind = "local_fixture" as const;
  private readonly budgets: FixtureBudget[] = [];
  private readonly spend: { tenantId: string; environment: string; vendor: string; workflow: string; cohort: string; micro: number; safety: boolean; at: number }[] = [];
  private seq = 0;
  /** Test hook: makes every call fail to exercise fail-closed paths. */
  failing = false;

  constructor(private readonly opts: { clock: Clock; burnRateWindowMinutes?: number }) {}

  async defineBudget(input: BudgetDefinitionInput & { staff: StaffActor }): Promise<Budget> {
    const parsed = BudgetDefinitionInput.safeParse(input);
    if (!parsed.success) throw new ValidationError("BUDGET_INPUT_INVALID");
    const b = parsed.data;
    try {
      authorizeStaff(b.staff, BUDGET_ROLES, this.opts.clock.now());
    } catch (err) {
      throw err instanceof AccessDeniedError ? err : new AccessDeniedError("STAFF_INVALID");
    }
    const budget: Budget = {
      budgetId: newId("bud"),
      scope: { environment: b.environment, cohort: b.cohort, workflow: b.workflow, vendor: b.vendor },
      periodStart: b.periodStart,
      periodEnd: b.periodEnd,
      limitUsd: fromMicroUsd(toMicroUsd(b.limitUsd)),
      safetyReserveUsd: fromMicroUsd(toMicroUsd(b.safetyReserveUsd)),
      spentUsd: 0,
      meteringDelayMinutes: b.meteringDelayMinutes,
      approvedBy: b.approvedBy,
      version: b.version,
    };
    this.budgets.push({ tenantId: b.tenantId, budget, limitMicro: toMicroUsd(b.limitUsd), reserveMicro: toMicroUsd(b.safetyReserveUsd), createdSeq: ++this.seq });
    return budget;
  }

  async recordSpend(input: { tenantId: string; environment: string; vendor: string; workflow: string; cohort: string; usd: number; safety: boolean; occurredAt: Date }): Promise<void> {
    if (this.failing) throw new ValidationError("FIXTURE_FAILURE");
    const parsed = SpendInput.safeParse(input);
    if (!parsed.success) throw new ValidationError("SPEND_INPUT_INVALID");
    const s = parsed.data;
    this.spend.push({ tenantId: s.tenantId, environment: s.environment, vendor: s.vendor, workflow: s.workflow, cohort: s.cohort, micro: toMicroUsd(s.usd), safety: s.safety, at: s.occurredAt.getTime() });
  }

  async statusFor(input: { tenantId: string; environment: string; vendor: string | null; workflow: string | null; cohort: string; now: Date }): Promise<BudgetStatus[]> {
    if (this.failing) throw new ValidationError("FIXTURE_FAILURE");
    const parsed = StatusQuery.safeParse(input);
    if (!parsed.success) throw new ValidationError("BUDGET_QUERY_INVALID");
    const q = parsed.data;
    const now = q.now.getTime();
    const matches = (scopeValue: string, v: string | null) => scopeValue === "*" || scopeValue === v;
    const active = this.budgets.filter(
      (b) =>
        b.tenantId === q.tenantId &&
        b.budget.scope.environment === q.environment &&
        Date.parse(b.budget.periodStart) <= now &&
        Date.parse(b.budget.periodEnd) > now &&
        matches(b.budget.scope.vendor, q.vendor) &&
        matches(b.budget.scope.workflow, q.workflow) &&
        matches(b.budget.scope.cohort, q.cohort),
    );
    // Newest version per scope + period wins.
    const latest = new Map<string, FixtureBudget>();
    for (const b of active) {
      const k = `${b.budget.scope.environment}|${b.budget.scope.cohort}|${b.budget.scope.workflow}|${b.budget.scope.vendor}|${b.budget.periodStart}`;
      const cur = latest.get(k);
      if (!cur || cur.createdSeq < b.createdSeq) latest.set(k, b);
    }
    const windowMs = (this.opts.burnRateWindowMinutes ?? 15) * 60_000;
    return [...latest.values()].map((b) => {
      const ps = Date.parse(b.budget.periodStart);
      const pe = Date.parse(b.budget.periodEnd);
      const windowStart = Math.max(ps, now - windowMs);
      const rows = this.spend.filter(
        (s) =>
          s.tenantId === q.tenantId &&
          s.environment === b.budget.scope.environment &&
          s.at >= ps &&
          s.at < pe &&
          s.at <= now &&
          matches(b.budget.scope.vendor, s.vendor) &&
          matches(b.budget.scope.workflow, s.workflow) &&
          matches(b.budget.scope.cohort, s.cohort),
      );
      const position = computeBudgetPosition({
        limitMicro: b.limitMicro,
        reserveMicro: b.reserveMicro,
        spentMicro: rows.reduce((a, s) => a + s.micro, 0),
        safetyMicro: rows.filter((s) => s.safety).reduce((a, s) => a + s.micro, 0),
        recentMicro: rows.filter((s) => s.at >= windowStart).reduce((a, s) => a + s.micro, 0),
        windowMinutes: Math.max(1, (now - windowStart) / 60_000),
        meteringDelayMinutes: b.budget.meteringDelayMinutes,
      });
      return { budget: { ...b.budget, spentUsd: position.spentUsd }, ...position };
    });
  }
}
