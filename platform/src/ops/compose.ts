/**
 * Builds the ops services from PlatformConfig.ops. The production guard requires
 * the `ops` block (OPS_CONFIG_MISSING); offline environments fall back to the
 * defaults below, which mirror platform/config/local.json.
 */
import type { AuditWriter } from "../audit/ports.js";
import type { OpsConfig, PlatformConfig } from "../config/ports.js";
import type { Db } from "../db/types.js";
import type { Logger, Metrics } from "../observability/ports.js";
import type { Clock } from "../shared/clock.js";
import { ConfigurationRejectedError } from "../shared/errors.js";
import { AdmissionControllerImpl } from "./admission.js";
import type { ContinuitySignal, LoadSignal } from "./admission.js";
import { BudgetServicePg } from "./budgets.js";
import { InMemorySessionCapacity } from "./capacity.js";
import { KillSwitchServicePg } from "./kill-switches.js";

/** Planning defaults (spec section 12 illustrative capacity: 2000 concurrent). Not contracted capacity (TB-10). */
export const DEFAULT_OPS_CONFIG: Readonly<OpsConfig> = Object.freeze({
  admission: { maxConcurrentAiSessions: 2000, safetyReserveSessions: 100 },
  killSwitches: { cacheTtlMs: 0 },
  budgets: { burnRateWindowMinutes: 15, requireBudget: true },
});

export interface OpsServices {
  killSwitches: KillSwitchServicePg;
  budgets: BudgetServicePg;
  capacity: InMemorySessionCapacity;
  admission: AdmissionControllerImpl;
}

export function createOpsServices(
  config: Pick<PlatformConfig, "environment" | "ops">,
  deps: { db: Db; audit: AuditWriter; clock: Clock; metrics?: Metrics; logger?: Logger; load?: LoadSignal; continuity?: ContinuitySignal },
): OpsServices {
  if (!config.ops && (config.environment === "staging" || config.environment === "production")) {
    throw new ConfigurationRejectedError(["OPS_CONFIG_MISSING@ops"]);
  }
  const ops = config.ops ?? DEFAULT_OPS_CONFIG;
  const killSwitches = new KillSwitchServicePg({ db: deps.db, audit: deps.audit, clock: deps.clock, metrics: deps.metrics, logger: deps.logger, cacheTtlMs: ops.killSwitches.cacheTtlMs });
  const budgets = new BudgetServicePg({ db: deps.db, audit: deps.audit, clock: deps.clock, metrics: deps.metrics, logger: deps.logger, burnRateWindowMinutes: ops.budgets.burnRateWindowMinutes });
  const capacity = new InMemorySessionCapacity({ ...ops.admission, metrics: deps.metrics });
  const admission = new AdmissionControllerImpl({
    environment: config.environment,
    killSwitches,
    budgets,
    capacity,
    clock: deps.clock,
    load: deps.load,
    continuity: deps.continuity,
    metrics: deps.metrics,
    logger: deps.logger,
    requireBudget: ops.budgets.requireBudget,
  });
  return { killSwitches, budgets, capacity, admission };
}
