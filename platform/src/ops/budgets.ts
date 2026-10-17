/**
 * Budgets and spend ledger (spec section 12 cost controls; migration 0601).
 *
 * - Budgets are tracked by environment, cohort, workflow and vendor; "*" in a
 *   budget scope matches any value. Several budgets can cover one admission and
 *   each is evaluated (the most restrictive wins in admission control).
 * - Money is integer micro-USD in storage. Spend rows are append-only.
 * - Vendor metering lags: projected spend = recorded spend + metering delay x
 *   recent burn rate. Alerts and prepaid balances are not hard caps; this
 *   projection drives the application's own admission limit.
 * - Safety spend draws from the approved safety reserve first. Exhausting the
 *   budget stops new nonessential automation only; safety work is never stopped,
 *   and safety spend beyond the reserve is reported for the escalation owner.
 */
import { z } from "zod";
import type { Db } from "../db/types.js";
import type { AuditWriter } from "../audit/ports.js";
import type { Logger, Metrics } from "../observability/ports.js";
import { silentLogger } from "../observability/logger.js";
import { Budget, Environment, OpaqueId, VersionLabel } from "../protocol/index.js";
import type { StaffActor } from "../protocol/index.js";
import type { Clock } from "../shared/clock.js";
import { iso } from "../shared/clock.js";
import { digestOf } from "../shared/canonical.js";
import { AuditUnavailableError, DependencyError, PlatformError, ValidationError } from "../shared/errors.js";
import { newId } from "../shared/ids.js";
import type { BudgetService, BudgetStatus } from "./ports.js";
import { BUDGET_ROLES, authorizeStaff } from "./staff-authz.js";

export const MICRO_USD_PER_USD = 1_000_000;
/** Upper bound for a single spend record (USD) to catch unit mistakes. */
export const MAX_SPEND_RECORD_USD = 100_000;

const TOKEN = /^[a-z0-9][a-z0-9_.@-]{0,63}$/;
const SCOPE_TOKEN = /^(\*|[a-z0-9][a-z0-9_.@-]{0,63})$/;
export const SpendToken = z.string().regex(TOKEN);
export const BudgetScopeToken = z.string().regex(SCOPE_TOKEN);

export const toMicroUsd = (usd: number): number => {
  if (!Number.isFinite(usd) || usd < 0) throw new ValidationError("BUDGET_AMOUNT_INVALID");
  return Math.round(usd * MICRO_USD_PER_USD);
};
export const fromMicroUsd = (micro: number): number => micro / MICRO_USD_PER_USD;

export const BudgetDefinitionInput = z
  .strictObject({
    tenantId: OpaqueId,
    environment: Environment,
    cohort: BudgetScopeToken,
    workflow: BudgetScopeToken,
    vendor: BudgetScopeToken,
    periodStart: z.iso.datetime({ offset: false }),
    periodEnd: z.iso.datetime({ offset: false }),
    limitUsd: z.number().finite().min(0).max(1e9),
    safetyReserveUsd: z.number().finite().min(0).max(1e9),
    meteringDelayMinutes: z.number().int().min(0).max(10_080),
    /** Approval record id of the finance approval for this ceiling; null = unapproved (reported). */
    approvedBy: z.string().regex(/^apr_[A-Za-z0-9_-]{8,64}$/).nullable(),
    version: VersionLabel,
    staff: z.unknown(),
    correlationId: OpaqueId.optional(),
  })
  .superRefine((v, ctx) => {
    if (Date.parse(v.periodEnd) <= Date.parse(v.periodStart)) ctx.addIssue({ code: "custom", path: ["periodEnd"], message: "period" });
    if (v.safetyReserveUsd > v.limitUsd) ctx.addIssue({ code: "custom", path: ["safetyReserveUsd"], message: "reserve exceeds limit" });
  });
export type BudgetDefinitionInput = z.input<typeof BudgetDefinitionInput>;

export const SpendInput = z.strictObject({
  tenantId: OpaqueId,
  environment: Environment,
  vendor: SpendToken,
  workflow: SpendToken,
  cohort: SpendToken,
  usd: z.number().finite().min(0).max(MAX_SPEND_RECORD_USD),
  safety: z.boolean(),
  occurredAt: z.date(),
});

export const StatusQuery = z.strictObject({
  tenantId: OpaqueId,
  environment: Environment,
  vendor: SpendToken.nullable(),
  workflow: SpendToken.nullable(),
  cohort: SpendToken,
  now: z.date(),
});

export interface BudgetMath {
  limitMicro: number;
  reserveMicro: number;
  spentMicro: number;
  safetyMicro: number;
  recentMicro: number;
  windowMinutes: number;
  meteringDelayMinutes: number;
}

/** Pure budget arithmetic (micro-USD in, USD out). Exported for property tests. */
export function computeBudgetPosition(m: BudgetMath): Omit<BudgetStatus, "budget"> {
  const nonSafety = Math.max(0, m.spentMicro - m.safetyMicro);
  const burnPerMinute = m.windowMinutes > 0 ? m.recentMicro / m.windowMinutes : 0;
  const delayProjection = m.meteringDelayMinutes * burnPerMinute;
  const safetyOverflow = Math.max(0, m.safetyMicro - m.reserveMicro);
  const nonessentialAllowance = Math.max(0, m.limitMicro - m.reserveMicro);
  const projectedNonessential = nonSafety + safetyOverflow + delayProjection;
  return {
    spentUsd: fromMicroUsd(m.spentMicro),
    safetySpentUsd: fromMicroUsd(m.safetyMicro),
    nonSafetySpentUsd: fromMicroUsd(nonSafety),
    burnRateUsdPerMinute: fromMicroUsd(burnPerMinute),
    projectedUsd: fromMicroUsd(m.spentMicro + delayProjection),
    projectedNonessentialUsd: fromMicroUsd(projectedNonessential),
    nonessentialHeadroomUsd: fromMicroUsd(Math.max(0, nonessentialAllowance - projectedNonessential)),
    safetyReserveRemainingUsd: fromMicroUsd(m.reserveMicro - m.safetyMicro),
    exhausted: projectedNonessential >= nonessentialAllowance,
    safetyReserveExceeded: m.safetyMicro > m.reserveMicro,
  };
}

interface BudgetRow {
  budget_id: string;
  environment: string;
  cohort: string;
  workflow: string;
  vendor: string;
  period_start: Date | string;
  period_end: Date | string;
  limit_micro_usd: string | number;
  safety_reserve_micro_usd: string | number;
  metering_delay_minutes: number;
  approved_by: string | null;
  version: string;
}

const num = (v: string | number | bigint): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new DependencyError("BUDGET_STATE_INVALID", "FAILED", false);
  return n;
};
const toIso = (v: Date | string): string => new Date(v).toISOString();

export interface BudgetServicePgOptions {
  db: Db;
  clock: Clock;
  audit: AuditWriter;
  metrics?: Metrics;
  logger?: Logger;
  /** Recent window used for the burn rate (default 15 minutes). */
  burnRateWindowMinutes?: number;
}

export class BudgetServicePg implements BudgetService {
  readonly kind = "live" as const;
  private readonly windowMinutes: number;
  private readonly logger: Logger;

  constructor(private readonly opts: BudgetServicePgOptions) {
    const w = opts.burnRateWindowMinutes ?? 15;
    if (!Number.isInteger(w) || w < 1 || w > 1440) throw new ValidationError("BUDGET_WINDOW_INVALID");
    this.windowMinutes = w;
    this.logger = (opts.logger ?? silentLogger).child({ component: "budgets" });
  }

  /** Defines a budget version (administrative, MFA staff, audited in the same transaction). */
  async defineBudget(input: BudgetDefinitionInput & { staff: StaffActor }): Promise<Budget> {
    const parsed = BudgetDefinitionInput.safeParse(input);
    if (!parsed.success) throw new ValidationError("BUDGET_INPUT_INVALID");
    const b = parsed.data;
    const now = this.opts.clock.now();
    const { staff, role } = authorizeStaff(b.staff, BUDGET_ROLES, now);
    const budgetId = newId("bud");
    const budget = Budget.parse({
      budgetId,
      scope: { environment: b.environment, cohort: b.cohort, workflow: b.workflow, vendor: b.vendor },
      periodStart: b.periodStart,
      periodEnd: b.periodEnd,
      limitUsd: fromMicroUsd(toMicroUsd(b.limitUsd)),
      safetyReserveUsd: fromMicroUsd(toMicroUsd(b.safetyReserveUsd)),
      spentUsd: 0,
      meteringDelayMinutes: b.meteringDelayMinutes,
      approvedBy: b.approvedBy,
      version: b.version,
    });
    try {
      await this.opts.db.tx(
        async (tx) => {
          await tx.query(
            `insert into budgets (budget_id, tenant_id, environment, cohort, workflow, vendor, period_start, period_end, limit_micro_usd,
                                  safety_reserve_micro_usd, metering_delay_minutes, approved_by, version, defined_by, created_at)
             values ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9, $10, $11, $12, $13, $14, $15::timestamptz)`,
            [
              budgetId,
              b.tenantId,
              b.environment,
              b.cohort,
              b.workflow,
              b.vendor,
              b.periodStart,
              b.periodEnd,
              toMicroUsd(b.limitUsd),
              toMicroUsd(b.safetyReserveUsd),
              b.meteringDelayMinutes,
              b.approvedBy,
              b.version,
              staff.staffId,
              iso(now),
            ],
          );
          await this.opts.audit.append(tx, {
            occurredAt: iso(now),
            correlationId: b.correlationId ?? newId("cor"),
            parentId: null,
            tenantId: b.tenantId,
            actorRef: staff.staffId,
            subjectRef: null,
            role,
            sourceComponent: "console",
            callId: null,
            sessionRef: null,
            sessionGeneration: null,
            turnId: null,
            versions: null,
            action: "budget.define",
            policyDecision: null,
            assurance: null,
            evidencePointers: [`db://budgets/${budgetId}`],
            beforeHash: null,
            afterHash: digestOf(budget),
            idempotencyKey: null,
            outcome: "SUCCEEDED",
            reasonCode: b.approvedBy ? "BUDGET_DEFINED" : "BUDGET_DEFINED_UNAPPROVED",
            dataClass: "SECURITY_AUDIT",
          });
        },
        { role: "app_console", rls: { tenantId: b.tenantId, actorId: staff.staffId } },
      );
    } catch (err) {
      if (err instanceof AuditUnavailableError) throw err;
      throw new DependencyError("BUDGET_WRITE_FAILED", "UNKNOWN", false);
    }
    return budget;
  }

  async recordSpend(input: { tenantId: string; environment: string; vendor: string; workflow: string; cohort: string; usd: number; safety: boolean; occurredAt: Date }): Promise<void> {
    const parsed = SpendInput.safeParse(input);
    if (!parsed.success) throw new ValidationError("SPEND_INPUT_INVALID");
    const s = parsed.data;
    const micro = toMicroUsd(s.usd);
    try {
      await this.opts.db.tx(
        (tx) =>
          tx.query(
            `insert into budget_spend (spend_id, tenant_id, environment, cohort, workflow, vendor, amount_micro_usd, safety, occurred_at, recorded_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::timestamptz)`,
            [newId("spd"), s.tenantId, s.environment, s.cohort, s.workflow, s.vendor, micro, s.safety, iso(s.occurredAt), iso(this.opts.clock.now())],
          ),
        { role: "app_runtime", rls: { tenantId: s.tenantId } },
      );
    } catch (err) {
      if (err instanceof PlatformError) throw err;
      throw new DependencyError("SPEND_WRITE_FAILED", "UNKNOWN", false);
    }
    this.opts.metrics?.increment("vsp_cost_usd_micro_total", { vendor: s.vendor, safety: String(s.safety) }, micro);
  }

  async statusFor(input: { tenantId: string; environment: string; vendor: string | null; workflow: string | null; cohort: string; now: Date }): Promise<BudgetStatus[]> {
    const parsed = StatusQuery.safeParse(input);
    if (!parsed.success) throw new ValidationError("BUDGET_QUERY_INVALID");
    const q = parsed.data;
    const nowIso = iso(q.now);
    try {
      return await this.opts.db.tx(
        async (tx) => {
          const budgets = (
            await tx.query<BudgetRow>(
              `select distinct on (environment, cohort, workflow, vendor, period_start)
                      budget_id, environment, cohort, workflow, vendor, period_start, period_end,
                      limit_micro_usd::text as limit_micro_usd, safety_reserve_micro_usd::text as safety_reserve_micro_usd,
                      metering_delay_minutes, approved_by, version
                 from budgets
                where environment = $1 and period_start <= $2::timestamptz and period_end > $2::timestamptz
                  and (vendor = '*' or vendor = $3::text) and (workflow = '*' or workflow = $4::text) and (cohort = '*' or cohort = $5::text)
                order by environment, cohort, workflow, vendor, period_start, created_seq desc`,
              [q.environment, nowIso, q.vendor, q.workflow, q.cohort],
            )
          ).rows;
          const out: BudgetStatus[] = [];
          for (const b of budgets) {
            const periodStartMs = new Date(b.period_start).getTime();
            const windowStart = new Date(Math.max(periodStartMs, q.now.getTime() - this.windowMinutes * 60_000));
            const windowMinutes = Math.max(1, (q.now.getTime() - windowStart.getTime()) / 60_000);
            const spend = (
              await tx.query<{ total: string; safety: string; recent: string }>(
                `select coalesce(sum(amount_micro_usd), 0)::text as total,
                        coalesce(sum(amount_micro_usd) filter (where safety), 0)::text as safety,
                        coalesce(sum(amount_micro_usd) filter (where occurred_at >= $5::timestamptz), 0)::text as recent
                   from budget_spend
                  where environment = $1 and occurred_at >= $2::timestamptz and occurred_at < $3::timestamptz and occurred_at <= $4::timestamptz
                    and ($6::text = '*' or vendor = $6::text) and ($7::text = '*' or workflow = $7::text) and ($8::text = '*' or cohort = $8::text)`,
                [b.environment, toIso(b.period_start), toIso(b.period_end), nowIso, iso(windowStart), b.vendor, b.workflow, b.cohort],
              )
            ).rows[0];
            const position = computeBudgetPosition({
              limitMicro: num(b.limit_micro_usd),
              reserveMicro: num(b.safety_reserve_micro_usd),
              spentMicro: num(spend?.total ?? "0"),
              safetyMicro: num(spend?.safety ?? "0"),
              recentMicro: num(spend?.recent ?? "0"),
              windowMinutes,
              meteringDelayMinutes: b.metering_delay_minutes,
            });
            const budget = Budget.parse({
              budgetId: b.budget_id,
              scope: { environment: b.environment, cohort: b.cohort, workflow: b.workflow, vendor: b.vendor },
              periodStart: toIso(b.period_start),
              periodEnd: toIso(b.period_end),
              limitUsd: fromMicroUsd(num(b.limit_micro_usd)),
              safetyReserveUsd: fromMicroUsd(num(b.safety_reserve_micro_usd)),
              spentUsd: position.spentUsd,
              meteringDelayMinutes: b.metering_delay_minutes,
              approvedBy: b.approved_by,
              version: b.version,
            });
            out.push({ budget, ...position });
            const limit = budget.limitUsd;
            this.opts.metrics?.gauge("vsp_budget_utilization_ratio", limit > 0 ? position.projectedUsd / limit : 1, { vendor: b.vendor });
          }
          return out;
        },
        { role: "app_runtime", rls: { tenantId: q.tenantId } },
      );
    } catch (err) {
      if (err instanceof PlatformError) throw err;
      throw new DependencyError("BUDGET_STATE_UNAVAILABLE", "FAILED", false);
    }
  }
}
