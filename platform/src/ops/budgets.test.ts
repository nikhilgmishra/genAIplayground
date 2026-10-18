import { afterEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import type { PgliteDb } from "../db/pglite.js";
import { OTHER_TENANT_ID, TENANT_ID } from "../fixtures/synthetic-world.js";
import { InMemoryMetrics } from "../observability/metrics.js";
import { FakeClock } from "../shared/clock.js";
import { AccessDeniedError } from "../shared/errors.js";
import { BudgetServicePg, computeBudgetPosition } from "./budgets.js";
import type { BudgetDefinitionInput } from "./budgets.js";
import { LocalFixtureBudgetService } from "./fixtures.js";
import { InTxAuditWriterFixture, createOpsTestDb, staffActor } from "./testing.js";

let db: PgliteDb | undefined;
afterEach(async () => {
  await db?.close();
  db = undefined;
});

/** SYNTHETIC test budget values; not a proposed budget. */
const budgetInput = (
  over: Partial<Omit<BudgetDefinitionInput, "staff">> & { staff?: ReturnType<typeof staffActor> } = {},
): BudgetDefinitionInput & { staff: ReturnType<typeof staffActor> } => ({
  tenantId: TENANT_ID,
  environment: "local",
  cohort: "*",
  workflow: "*",
  vendor: "talkdesk-ai",
  periodStart: "2026-10-01T00:00:00.000Z",
  periodEnd: "2026-11-01T00:00:00.000Z",
  limitUsd: 100,
  safetyReserveUsd: 20,
  meteringDelayMinutes: 0,
  approvedBy: null,
  version: "test-1",
  staff: staffActor("securityAdmin"),
  ...over,
});

async function setup() {
  db = await createOpsTestDb();
  const clock = new FakeClock("2026-10-17T15:00:00.000Z");
  const audit = new InTxAuditWriterFixture(db);
  const metrics = new InMemoryMetrics();
  const svc = new BudgetServicePg({ db, clock, audit, metrics, burnRateWindowMinutes: 10 });
  const spend = (usd: number, over: Partial<{ vendor: string; workflow: string; cohort: string; safety: boolean; occurredAt: Date }> = {}) =>
    svc.recordSpend({ tenantId: TENANT_ID, environment: "local", vendor: "talkdesk-ai", workflow: "billing_question", cohort: "pilot-a", usd, safety: false, occurredAt: clock.now(), ...over });
  const status = (over: Partial<{ vendor: string | null; workflow: string | null; cohort: string }> = {}) =>
    svc.statusFor({ tenantId: TENANT_ID, environment: "local", vendor: "talkdesk-ai", workflow: "billing_question", cohort: "pilot-a", now: clock.now(), ...over });
  return { db, clock, audit, metrics, svc, spend, status };
}

describe("BudgetServicePg", () => {
  it("[SPEC-12.cost] defining a budget requires MFA staff and is audited in the same transaction", async () => {
    const { svc, audit } = await setup();
    await expect(svc.defineBudget(budgetInput({ staff: staffActor("agent") }))).rejects.toThrow(AccessDeniedError);
    await expect(svc.defineBudget(budgetInput({ staff: staffActor("securityAdmin", { mfa: false }) }))).rejects.toThrow("STAFF_MFA_REQUIRED");
    const b = await svc.defineBudget(budgetInput());
    expect(b.budgetId).toMatch(/^bud_/);
    const events = await audit.committed();
    expect(events.map((e) => [e.action, e.outcome, e.body.reasonCode])).toEqual([["budget.define", "SUCCEEDED", "BUDGET_DEFINED_UNAPPROVED"]]);
    await expect(svc.defineBudget(budgetInput({ safetyReserveUsd: 500 }))).rejects.toThrow("BUDGET_INPUT_INVALID");
  });

  it("[SPEC-12.cost] tracks spend by environment, cohort, workflow and vendor with wildcard budget scopes", async () => {
    const { svc, spend, status } = await setup();
    await svc.defineBudget(budgetInput({ vendor: "talkdesk-ai", cohort: "*", workflow: "*", limitUsd: 100 }));
    await svc.defineBudget(budgetInput({ vendor: "*", cohort: "pilot-a", workflow: "billing_question", limitUsd: 30, safetyReserveUsd: 0 }));
    await svc.defineBudget(budgetInput({ vendor: "salesforce", limitUsd: 10, safetyReserveUsd: 0 }));
    await spend(5);
    await spend(7, { workflow: "appointment" });
    await spend(3, { vendor: "model-provider" });
    await spend(4, { cohort: "pilot-b" });
    await svc.recordSpend({ tenantId: TENANT_ID, environment: "staging", vendor: "talkdesk-ai", workflow: "billing_question", cohort: "pilot-a", usd: 50, safety: false, occurredAt: new Date("2026-10-17T15:00:00.000Z") });
    const st = await status();
    const byScope = Object.fromEntries(st.map((s) => [`${s.budget.scope.vendor}|${s.budget.scope.workflow}|${s.budget.scope.cohort}`, s.spentUsd]));
    // talkdesk-ai/*/*: 5 + 7 + 4 (not model-provider, not staging); */billing_question/pilot-a: 5 + 3
    expect(byScope).toEqual({ "talkdesk-ai|*|*": 16, "*|billing_question|pilot-a": 8 });
    // A vendor-specific budget never applies to a request without that vendor.
    const noVendor = await status({ vendor: null });
    expect(noVendor.map((s) => s.budget.scope.vendor)).toEqual(["*"]);
  });

  it("[SPEC-12.cost] projected spend includes metering delay times the recent burn rate", async () => {
    const { svc, spend, status, clock } = await setup();
    await svc.defineBudget(budgetInput({ limitUsd: 100, safetyReserveUsd: 10, meteringDelayMinutes: 30 }));
    clock.advanceMs(-20 * 60_000);
    await spend(40); // outside the 10-minute burn window
    clock.advanceMs(15 * 60_000);
    await spend(10); // inside the window: 10 USD over 10 minutes = 1 USD/min
    clock.advanceMs(5 * 60_000);
    const [s] = await status();
    expect(s?.spentUsd).toBe(50);
    expect(s?.burnRateUsdPerMinute).toBeCloseTo(1, 6);
    expect(s?.projectedUsd).toBeCloseTo(80, 6); // 50 + 30 min * 1 USD/min
    expect(s?.projectedNonessentialUsd).toBeCloseTo(80, 6);
    expect(s?.exhausted).toBe(false); // 80 < 100 - 10
    await spend(10);
    const [s2] = await status();
    // 60 recorded, burn 20/10min = 2/min, projected nonessential = 60 + 60 = 120 >= 90: exhausted before recorded spend reaches the limit.
    expect(s2?.spentUsd).toBe(60);
    expect(s2?.exhausted).toBe(true);
  });

  it("[SAFE-03] safety spend draws from the bounded safety reserve first and overflow is reported, never a cap", async () => {
    const { svc, spend, status, metrics } = await setup();
    await svc.defineBudget(budgetInput({ limitUsd: 100, safetyReserveUsd: 20 }));
    await spend(15, { safety: true });
    let [s] = await status();
    expect(s?.safetyReserveRemainingUsd).toBe(5);
    expect(s?.nonessentialHeadroomUsd).toBe(80);
    expect(s?.safetyReserveExceeded).toBe(false);
    await spend(80);
    [s] = await status();
    expect(s?.exhausted).toBe(true); // nonessential allowance (80) is used up
    await spend(10, { safety: true });
    [s] = await status();
    expect(s?.safetyReserveExceeded).toBe(true);
    expect(s?.safetyReserveRemainingUsd).toBe(-5);
    expect(metrics.counterValue("vsp_cost_usd_micro_total", { safety: "true" })).toBe(25_000_000);
  });

  it("[SPEC-12.cost] the spend ledger and budget versions are append-only; a newer version supersedes", async () => {
    const { svc, spend, status, db } = await setup();
    await svc.defineBudget(budgetInput({ limitUsd: 10, safetyReserveUsd: 0, version: "test-1" }));
    await spend(9);
    expect((await status())[0]?.exhausted).toBe(false);
    await svc.defineBudget(budgetInput({ limitUsd: 5, safetyReserveUsd: 0, version: "test-2" }));
    const [s] = await status();
    expect(s?.budget.version).toBe("test-2");
    expect(s?.exhausted).toBe(true);
    for (const sql of ["update budget_spend set amount_micro_usd = 0", "delete from budget_spend", "update budgets set limit_micro_usd = 0", "delete from budgets"]) {
      await expect(db.tx((tx) => tx.query(sql), { role: "owner" })).rejects.toThrow(/OPS_LEDGER_APPEND_ONLY/);
      await expect(db.tx((tx) => tx.query(sql), { role: "app_runtime", rls: { tenantId: TENANT_ID } })).rejects.toThrow(/permission denied/);
    }
  });

  it("[AUTH-05] budgets and spend are tenant-isolated", async () => {
    const { svc, spend } = await setup();
    await svc.defineBudget(budgetInput());
    await spend(50);
    const other = await svc.statusFor({ tenantId: OTHER_TENANT_ID, environment: "local", vendor: "talkdesk-ai", workflow: "billing_question", cohort: "pilot-a", now: new Date("2026-10-17T15:00:00.000Z") });
    expect(other).toEqual([]);
  });

  it("[SPEC-12.cost] rejects invalid spend (negative, non-finite, wildcard or PHI-shaped scope tokens)", async () => {
    const { spend } = await setup();
    await expect(spend(-1)).rejects.toThrow("SPEND_INPUT_INVALID");
    await expect(spend(Number.POSITIVE_INFINITY)).rejects.toThrow("SPEND_INPUT_INVALID");
    await expect(spend(1, { vendor: "*" })).rejects.toThrow("SPEND_INPUT_INVALID");
    await expect(spend(1, { cohort: "Avery Synthetic-Client" })).rejects.toThrow("SPEND_INPUT_INVALID");
  });
});

describe("budget arithmetic", () => {
  const arb = fc.record({
    limitMicro: fc.integer({ min: 0, max: 1e9 }),
    reserveFrac: fc.double({ min: 0, max: 1, noNaN: true }),
    nonSafety: fc.integer({ min: 0, max: 1e9 }),
    safety: fc.integer({ min: 0, max: 1e9 }),
    recent: fc.integer({ min: 0, max: 1e9 }),
    windowMinutes: fc.integer({ min: 1, max: 60 }),
    meteringDelayMinutes: fc.integer({ min: 0, max: 240 }),
  });
  type ArbValue = typeof arb extends fc.Arbitrary<infer T> ? T : never;
  const toMath = (a: ArbValue) => {
    const reserveMicro = Math.floor(a.limitMicro * a.reserveFrac);
    return {
      limitMicro: a.limitMicro,
      reserveMicro,
      spentMicro: a.nonSafety + a.safety,
      safetyMicro: a.safety,
      recentMicro: a.recent,
      windowMinutes: a.windowMinutes,
      meteringDelayMinutes: a.meteringDelayMinutes,
    };
  };

  it("[SPEC-12.cost] property: exhausted iff projected nonessential spend reaches limit minus reserve", () => {
    fc.assert(
      fc.property(arb, (a) => {
        const m = toMath(a);
        const p = computeBudgetPosition(m);
        const projected = a.nonSafety + Math.max(0, a.safety - m.reserveMicro) + a.meteringDelayMinutes * (a.recent / a.windowMinutes);
        expect(p.exhausted).toBe(projected >= m.limitMicro - m.reserveMicro);
      }),
    );
  });

  it("[SPEC-12.cost] property: more spend or more metering delay never un-exhausts a budget", () => {
    fc.assert(
      fc.property(arb, fc.integer({ min: 0, max: 1e8 }), fc.integer({ min: 0, max: 120 }), fc.boolean(), (a, extra, extraDelay, asSafety) => {
        const m = toMath(a);
        const before = computeBudgetPosition(m);
        const after = computeBudgetPosition({
          ...m,
          spentMicro: m.spentMicro + extra,
          safetyMicro: m.safetyMicro + (asSafety ? extra : 0),
          meteringDelayMinutes: m.meteringDelayMinutes + extraDelay,
        });
        if (before.exhausted) expect(after.exhausted).toBe(true);
      }),
    );
  });

  it("[SAFE-03] property: safety spend within the reserve does not reduce nonessential headroom", () => {
    fc.assert(
      fc.property(arb, (a) => {
        const m = { ...toMath(a), recentMicro: 0 };
        const withinReserve = Math.min(m.safetyMicro, m.reserveMicro);
        const base = computeBudgetPosition({ ...m, spentMicro: m.spentMicro - m.safetyMicro, safetyMicro: 0 });
        const withSafety = computeBudgetPosition({ ...m, spentMicro: m.spentMicro - m.safetyMicro + withinReserve, safetyMicro: withinReserve });
        expect(withSafety.nonessentialHeadroomUsd).toBeCloseTo(base.nonessentialHeadroomUsd, 6);
        expect(withSafety.exhausted).toBe(base.exhausted);
      }),
    );
  });

  it("[SPEC-12.cost] LOCAL FIXTURE budget service computes the same position as the Pg service", async () => {
    const clock = new FakeClock("2026-10-17T15:00:00.000Z");
    const fx = new LocalFixtureBudgetService({ clock, burnRateWindowMinutes: 10 });
    await fx.defineBudget(budgetInput({ limitUsd: 100, safetyReserveUsd: 10, meteringDelayMinutes: 30 }));
    clock.advanceMs(-5 * 60_000);
    await fx.recordSpend({ tenantId: TENANT_ID, environment: "local", vendor: "talkdesk-ai", workflow: "billing_question", cohort: "pilot-a", usd: 10, safety: false, occurredAt: clock.now() });
    clock.advanceMs(5 * 60_000);
    const [s] = await fx.statusFor({ tenantId: TENANT_ID, environment: "local", vendor: "talkdesk-ai", workflow: "billing_question", cohort: "pilot-a", now: clock.now() });
    expect(s?.spentUsd).toBe(10);
    expect(s?.burnRateUsdPerMinute).toBeCloseTo(1, 6);
    expect(s?.projectedUsd).toBeCloseTo(40, 6);
    expect(fx.kind).toBe("local_fixture");
  });
});
