import { afterEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import type { PgliteDb } from "../db/pglite.js";
import { TENANT_ID } from "../fixtures/synthetic-world.js";
import { ADMISSION_REASON_CODES, CONTINUITY_ROUTES, InMemoryMetrics } from "../observability/metrics.js";
import { FakeClock } from "../shared/clock.js";
import { ValidationError } from "../shared/errors.js";
import { AdmissionControllerImpl, DEFAULT_SHEDDING, ManualLoadSignal, validateShedding } from "./admission.js";
import type { DegradationLevel } from "./admission.js";
import { BudgetServicePg } from "./budgets.js";
import { InMemorySessionCapacity } from "./capacity.js";
import { LocalFixtureBudgetService, LocalFixtureKillSwitchService } from "./fixtures.js";
import { KillSwitchServicePg, emptySnapshot } from "./kill-switches.js";
import type { AdmissionClass, BudgetService, KillSwitchService, KillSwitchSnapshot } from "./ports.js";
import { InTxAuditWriterFixture, createOpsTestDb, staffActor } from "./testing.js";

const CALLER_FACING: AdmissionClass[] = ["PROTECTED_READ", "WRITE", "PUBLIC"];
const ALL: AdmissionClass[] = ["SAFETY", "HUMAN_ROUTE", "PROTECTED_READ", "WRITE", "PUBLIC", "ANALYTICS"];

/** LOCAL TEST FIXTURE kill switch port with a directly settable snapshot. */
class SettableKillSwitches implements KillSwitchService {
  snap: KillSwitchSnapshot = emptySnapshot();
  throws = false;
  async snapshot(): Promise<KillSwitchSnapshot> {
    if (this.throws) throw new Error("unavailable");
    return structuredClone(this.snap);
  }
  async set(): Promise<never> {
    throw new Error("not used");
  }
  async list(): Promise<[]> {
    return [];
  }
}

/** LOCAL TEST FIXTURE budget port with a settable position. */
class SettableBudgets implements BudgetService {
  exhausted = false;
  configured = true;
  throws = false;
  recordThrows = false;
  recorded: { usd: number; safety: boolean }[] = [];
  async statusFor() {
    if (this.throws) throw new Error("unavailable");
    if (!this.configured) return [];
    return [
      {
        budget: {
          budgetId: "bud_synthBudgetFixture0001",
          scope: { environment: "local", cohort: "*", workflow: "*", vendor: "*" },
          periodStart: "2026-10-01T00:00:00.000Z",
          periodEnd: "2026-11-01T00:00:00.000Z",
          limitUsd: 100,
          safetyReserveUsd: 10,
          spentUsd: this.exhausted ? 100 : 0,
          meteringDelayMinutes: 0,
          approvedBy: null,
          version: "test-1",
        },
        spentUsd: this.exhausted ? 100 : 0,
        safetySpentUsd: 0,
        nonSafetySpentUsd: this.exhausted ? 100 : 0,
        burnRateUsdPerMinute: 0,
        projectedUsd: this.exhausted ? 100 : 0,
        projectedNonessentialUsd: this.exhausted ? 100 : 0,
        nonessentialHeadroomUsd: this.exhausted ? 0 : 90,
        safetyReserveRemainingUsd: 10,
        exhausted: this.exhausted,
        safetyReserveExceeded: false,
      },
    ];
  }
  async recordSpend(input: { usd: number; safety: boolean }) {
    if (this.recordThrows) throw new Error("ledger unavailable");
    this.recorded.push({ usd: input.usd, safety: input.safety });
  }
}

function harness(opts: { maxSessions?: number; reserve?: number; humanQueue?: boolean } = {}) {
  const killSwitches = new SettableKillSwitches();
  const budgets = new SettableBudgets();
  const metrics = new InMemoryMetrics();
  const capacity = new InMemorySessionCapacity({ maxConcurrentAiSessions: opts.maxSessions ?? 2000, safetyReserveSessions: opts.reserve ?? 100, metrics });
  const load = new ManualLoadSignal();
  let humanQueue = opts.humanQueue ?? true;
  const ctl = new AdmissionControllerImpl({
    environment: "local",
    killSwitches,
    budgets,
    capacity,
    clock: new FakeClock(),
    load,
    continuity: { humanQueueAvailable: () => humanQueue },
    metrics,
  });
  const admit = (cls: AdmissionClass, over: Record<string, unknown> = {}) =>
    ctl.admit({ tenantId: TENANT_ID, class: cls, vendor: "talkdesk-ai", workflow: "billing_question", cohort: "pilot-a", ...over });
  return { ctl, killSwitches, budgets, metrics, capacity, load, admit, setHumanQueue: (v: boolean) => (humanQueue = v) };
}

const ALL_ENGAGED: KillSwitchSnapshot = {
  aiAdmission: true,
  writes: true,
  outboundNotifications: true,
  intents: ["billing_question", "safety_handoff"],
  integrations: ["talkdesk-ai", "talkdesk-telephony"],
  modelVersions: ["model-1"],
  voiceVersions: ["voice-1"],
};

describe("AdmissionControllerImpl", () => {
  it("[SAFE-03] admission always admits SAFETY/HUMAN_ROUTE when budget exhausted and kill switches engaged", async () => {
    const h = harness({ maxSessions: 1, reserve: 1 });
    h.killSwitches.snap = ALL_ENGAGED;
    h.budgets.exhausted = true;
    h.load.set("DEGRADED");
    expect(h.capacity.tryAcquire()).not.toBeNull(); // standard pool now full
    for (const cls of ["SAFETY", "HUMAN_ROUTE"] as const) {
      const d = await h.admit(cls, { newSession: true, modelVersion: "model-1", voiceVersion: "voice-1" });
      expect(d.admitted).toBe(true);
      expect(d.continuity).toBe("NONE");
    }
    // Even when every dependency of admission is failing or the input is malformed.
    h.killSwitches.throws = true;
    h.budgets.throws = true;
    for (const cls of ["SAFETY", "HUMAN_ROUTE"] as const) {
      expect((await h.ctl.admit({ tenantId: "not a tenant", class: cls, vendor: "*", workflow: null, cohort: "" } as never)).admitted).toBe(true);
    }
  });

  it("[SAFE-03] safety sessions beyond the bounded reserve are still admitted and raise an escalation alert", async () => {
    const h = harness({ maxSessions: 1, reserve: 1 });
    const first = await h.admit("SAFETY", { newSession: true });
    expect(first.reasonCode).toBe("SAFETY_ALWAYS_ADMITTED");
    expect(first.sessionLeaseId).toMatch(/^lse_/);
    const second = await h.admit("HUMAN_ROUTE", { newSession: true });
    expect(second).toMatchObject({ admitted: true, reasonCode: "SAFETY_RESERVE_EXCEEDED_ESCALATE" });
    expect(h.metrics.counterValue("vsp_safety_reserve_overdraw_total", { reserve: "sessions" })).toBe(1);
    expect(h.capacity.active()).toEqual({ standard: 0, safetyReserve: 2 });
  });

  it("[OPS-02] budget exhaustion yields continuity route not a drop", async () => {
    const h = harness();
    h.budgets.exhausted = true;
    for (const cls of CALLER_FACING) {
      expect(await h.admit(cls)).toMatchObject({ admitted: false, continuity: "HUMAN_QUEUE", reasonCode: "BUDGET_EXHAUSTED" });
    }
    h.setHumanQueue(false);
    expect(await h.admit("WRITE")).toMatchObject({ admitted: false, continuity: "CALLBACK_INTAKE", reasonCode: "BUDGET_EXHAUSTED" });
    expect(await h.admit("ANALYTICS")).toMatchObject({ admitted: false, continuity: "NONE" });
    expect(h.metrics.counterValue("vsp_admission_decisions_total", { reason: "BUDGET_EXHAUSTED", admitted: "false" })).toBe(5);
  });

  it("[OPS-02] property: every refusal of caller-facing work names an approved continuity route; essential classes are always admitted", async () => {
    const levels: DegradationLevel[] = ["NORMAL", "ELEVATED", "CONSTRAINED", "DEGRADED"];
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          cls: fc.constantFrom(...ALL),
          aiAdmission: fc.boolean(),
          writes: fc.boolean(),
          intentBlocked: fc.boolean(),
          integrationBlocked: fc.boolean(),
          exhausted: fc.boolean(),
          configured: fc.boolean(),
          budgetThrows: fc.boolean(),
          switchThrows: fc.boolean(),
          capacityFull: fc.boolean(),
          newSession: fc.boolean(),
          level: fc.constantFrom(...levels),
          humanQueue: fc.boolean(),
        }),
        async (s) => {
          const h = harness({ maxSessions: 1, reserve: 0, humanQueue: s.humanQueue });
          h.killSwitches.snap = {
            ...emptySnapshot(),
            aiAdmission: s.aiAdmission,
            writes: s.writes,
            intents: s.intentBlocked ? ["billing_question"] : [],
            integrations: s.integrationBlocked ? ["talkdesk-ai"] : [],
          };
          h.killSwitches.throws = s.switchThrows;
          h.budgets.exhausted = s.exhausted;
          h.budgets.configured = s.configured;
          h.budgets.throws = s.budgetThrows;
          if (s.capacityFull) h.capacity.tryAcquire();
          h.load.set(s.level);
          const d = await h.admit(s.cls, { newSession: s.newSession });
          expect([...ADMISSION_REASON_CODES]).toContain(d.reasonCode);
          expect([...CONTINUITY_ROUTES]).toContain(d.continuity);
          if (s.cls === "SAFETY" || s.cls === "HUMAN_ROUTE") {
            expect(d.admitted).toBe(true);
          } else if (!d.admitted && s.cls !== "ANALYTICS") {
            expect(d.continuity).not.toBe("NONE");
          }
          if (d.admitted) expect(d.continuity).toBe("NONE");
        },
      ),
      { numRuns: 300 },
    );
  });

  it("[SPEC-12.load-shedding] sheds ANALYTICS first, then PUBLIC and PROTECTED_READ, then WRITE when degraded", async () => {
    const h = harness();
    const admittedAt = async (level: DegradationLevel) => {
      h.load.set(level);
      const out: Record<string, boolean> = {};
      for (const cls of ALL) out[cls] = (await h.admit(cls)).admitted;
      return out;
    };
    expect(await admittedAt("NORMAL")).toEqual({ SAFETY: true, HUMAN_ROUTE: true, PROTECTED_READ: true, WRITE: true, PUBLIC: true, ANALYTICS: true });
    expect(await admittedAt("ELEVATED")).toEqual({ SAFETY: true, HUMAN_ROUTE: true, PROTECTED_READ: true, WRITE: true, PUBLIC: true, ANALYTICS: false });
    expect(await admittedAt("CONSTRAINED")).toEqual({ SAFETY: true, HUMAN_ROUTE: true, PROTECTED_READ: false, WRITE: true, PUBLIC: false, ANALYTICS: false });
    expect(await admittedAt("DEGRADED")).toEqual({ SAFETY: true, HUMAN_ROUTE: true, PROTECTED_READ: false, WRITE: false, PUBLIC: false, ANALYTICS: false });
    expect(await h.admit("WRITE")).toMatchObject({ reasonCode: "LOAD_SHED_DEGRADED", continuity: "OUTAGE_MESSAGE_THEN_HUMAN" });
    h.load.set("CONSTRAINED");
    expect(await h.admit("PUBLIC")).toMatchObject({ reasonCode: "LOAD_SHED_CONSTRAINED", continuity: "HUMAN_QUEUE" });
  });

  it("[SPEC-12.load-shedding] shedding tables may never shed SAFETY or HUMAN_ROUTE and must be monotonic", () => {
    expect(() => validateShedding(DEFAULT_SHEDDING)).not.toThrow();
    expect(() => validateShedding({ ...DEFAULT_SHEDDING, DEGRADED: [...DEFAULT_SHEDDING.DEGRADED, "SAFETY"] })).toThrow("SHEDDING_ESSENTIAL_CLASS");
    expect(() => validateShedding({ ...DEFAULT_SHEDDING, CONSTRAINED: ["PUBLIC"] })).toThrow("SHEDDING_NOT_MONOTONIC");
  });

  it("[SPEC-12.capacity] concurrent AI session limit with controlled admission; leases are released", async () => {
    const h = harness({ maxSessions: 2 });
    const a = await h.admit("PUBLIC", { newSession: true });
    const b = await h.admit("PROTECTED_READ", { newSession: true });
    expect([a.admitted, b.admitted]).toEqual([true, true]);
    const c = await h.admit("PUBLIC", { newSession: true });
    expect(c).toMatchObject({ admitted: false, reasonCode: "CAPACITY_LIMIT", continuity: "HUMAN_QUEUE", sessionLeaseId: null });
    // In-session requests are not new admissions and are not capacity-gated.
    expect((await h.admit("WRITE")).admitted).toBe(true);
    h.ctl.releaseSession(a.sessionLeaseId ?? "");
    h.ctl.releaseSession(a.sessionLeaseId ?? ""); // idempotent
    expect((await h.admit("PUBLIC", { newSession: true })).admitted).toBe(true);
    expect(h.metrics.gaugeValue("vsp_ai_sessions_active", { pool: "standard" })).toBe(2);
  });

  it("[SPEC-12.capacity] a refused admission never leaks a capacity lease", async () => {
    const h = harness({ maxSessions: 1 });
    h.budgets.exhausted = true;
    expect((await h.admit("PUBLIC", { newSession: true })).admitted).toBe(false);
    expect(h.capacity.active().standard).toBe(0);
  });

  it("[SPEC-13.kill-switches] each kill switch stops only its own automation and routes callers to a human", async () => {
    const h = harness();
    h.killSwitches.snap = { ...emptySnapshot(), aiAdmission: true };
    expect(await h.admit("PUBLIC", { newSession: true })).toMatchObject({ admitted: false, reasonCode: "KILL_SWITCH_AI_ADMISSION", continuity: "HUMAN_QUEUE" });
    expect((await h.admit("PUBLIC")).admitted).toBe(true);
    h.killSwitches.snap = { ...emptySnapshot(), writes: true };
    expect((await h.admit("WRITE")).reasonCode).toBe("KILL_SWITCH_WRITES");
    expect((await h.admit("PROTECTED_READ")).admitted).toBe(true);
    h.killSwitches.snap = { ...emptySnapshot(), intents: ["billing_question"] };
    expect((await h.admit("PROTECTED_READ")).reasonCode).toBe("KILL_SWITCH_INTENT");
    expect((await h.admit("PROTECTED_READ", { workflow: "appointment" })).admitted).toBe(true);
    h.killSwitches.snap = { ...emptySnapshot(), integrations: ["talkdesk-ai"] };
    expect((await h.admit("PUBLIC")).reasonCode).toBe("KILL_SWITCH_INTEGRATION");
    h.killSwitches.snap = { ...emptySnapshot(), modelVersions: ["model-1"], voiceVersions: ["voice-1"] };
    expect((await h.admit("PUBLIC", { modelVersion: "model-1" })).reasonCode).toBe("KILL_SWITCH_MODEL_VERSION");
    expect((await h.admit("PUBLIC", { voiceVersion: "voice-1" })).reasonCode).toBe("KILL_SWITCH_VOICE_VERSION");
    expect((await h.admit("PUBLIC", { modelVersion: "model-2", voiceVersion: "voice-2" })).admitted).toBe(true);
  });

  it("[SPEC-12.admission] fails closed for nonessential work when budget, kill switch or load state is unknown", async () => {
    const h = harness();
    h.budgets.configured = false;
    expect(await h.admit("PUBLIC")).toMatchObject({ admitted: false, reasonCode: "BUDGET_NOT_CONFIGURED", continuity: "HUMAN_QUEUE" });
    h.budgets.configured = true;
    h.budgets.throws = true;
    expect((await h.admit("PUBLIC")).reasonCode).toBe("BUDGET_STATE_UNAVAILABLE");
    h.budgets.throws = false;
    h.killSwitches.throws = true;
    expect((await h.admit("PUBLIC")).reasonCode).toBe("KILL_SWITCH_STATE_UNAVAILABLE");
    h.killSwitches.throws = false;
    const ctl = new AdmissionControllerImpl({
      environment: "local",
      killSwitches: h.killSwitches,
      budgets: h.budgets,
      capacity: h.capacity,
      clock: new FakeClock(),
      load: {
        level: () => {
          throw new Error("signal down");
        },
      },
    });
    expect(await ctl.admit({ tenantId: TENANT_ID, class: "WRITE", vendor: null, workflow: null, cohort: "pilot-a" })).toMatchObject({
      admitted: false,
      reasonCode: "LOAD_SHED_DEGRADED",
      continuity: "OUTAGE_MESSAGE_THEN_HUMAN",
    });
    expect(await h.ctl.admit({ tenantId: TENANT_ID, class: "PUBLIC", vendor: "Avery Synthetic", workflow: null, cohort: "pilot-a" })).toMatchObject({
      admitted: false,
      reasonCode: "ADMISSION_INPUT_INVALID",
      continuity: "HUMAN_QUEUE",
    });
  });

  it("[SAFE-03] recordCost never throws for safety spend, even when the ledger is down; nonessential failures surface", async () => {
    const h = harness();
    await h.ctl.recordCost({ tenantId: TENANT_ID, vendor: "talkdesk-ai", workflow: "safety_handoff", cohort: "pilot-a", usd: 0.42, safety: true });
    expect(h.budgets.recorded).toEqual([{ usd: 0.42, safety: true }]);
    h.budgets.recordThrows = true;
    await expect(h.ctl.recordCost({ tenantId: TENANT_ID, vendor: "talkdesk-ai", workflow: "safety_handoff", cohort: "pilot-a", usd: 1, safety: true })).resolves.toBeUndefined();
    await expect(h.ctl.recordCost({ tenantId: TENANT_ID, vendor: "talkdesk-ai", workflow: "billing_question", cohort: "pilot-a", usd: 1, safety: false })).rejects.toThrow();
    await expect(h.ctl.recordCost({ tenantId: TENANT_ID, vendor: "talkdesk-ai", workflow: "x", cohort: "pilot-a", usd: -1, safety: false })).rejects.toThrow(ValidationError);
    await expect(h.ctl.recordCost({ tenantId: TENANT_ID, vendor: "talkdesk-ai", workflow: "x", cohort: "pilot-a", usd: -1, safety: true })).resolves.toBeUndefined();
    expect(h.metrics.counterValue("vsp_cost_record_failures_total", { safety: "true" })).toBe(2);
    expect(h.metrics.counterValue("vsp_cost_record_failures_total", { safety: "false" })).toBe(1);
  });
});

describe("admission reason codes and composition", () => {
  it("[DATA-01] every admission and kill-switch reason code is in the metric label allowlist", async () => {
    const src = (await import("node:fs")).readFileSync(new URL("./admission.ts", import.meta.url), "utf8") + (await import("node:fs")).readFileSync(new URL("./kill-switches.ts", import.meta.url), "utf8");
    const used = new Set([...src.matchAll(/"((?:SAFETY|HUMAN_ROUTE|KILL_SWITCH|LOAD_SHED|BUDGET|CAPACITY|ADMISSION|ADMITTED)[A-Z_]*)"/g)].map((m) => m[1] ?? ""));
    used.delete("KILL_SWITCH_TENANT_INVALID"); // snapshot log reason, not an admission decision
    used.delete("KILL_SWITCH_CACHE_TTL_INVALID");
    used.delete("KILL_SWITCH_INPUT_INVALID");
    used.delete("KILL_SWITCH_CONCURRENT_CHANGE");
    used.delete("KILL_SWITCH_WRITE_FAILED");
    used.delete("KILL_SWITCH_ROLE_AUTHORIZED");
    used.delete("SAFETY_ESCALATION");
    used.delete("HUMAN_ROUTE");
    used.delete("SAFETY");
    for (const code of used) expect([...ADMISSION_REASON_CODES], code).toContain(code);
    expect(used.size).toBeGreaterThan(10);
  });

  it("[SPEC-12.capacity] ops services are built from PlatformConfig.ops; staging/production require the block", async () => {
    const { createOpsServices } = await import("./compose.js");
    const { loadPlatformConfig } = await import("../config/loader.js");
    const fakeDb = { engine: "pg", query: async () => ({ rows: [], rowCount: 0 }), exec: async () => undefined, tx: async () => Promise.reject(new Error("unused")), close: async () => undefined } as const;
    const local = loadPlatformConfig({ environment: "local", env: {} }).config;
    const svc = createOpsServices(local, { db: fakeDb, audit: new InTxAuditWriterFixture(fakeDb), clock: new FakeClock() });
    expect(svc.capacity.limits()).toEqual({ maxConcurrentAiSessions: 2000, safetyReserveSessions: 100 });
    expect(() => createOpsServices({ environment: "production", ops: undefined }, { db: fakeDb, audit: new InTxAuditWriterFixture(fakeDb), clock: new FakeClock() })).toThrow(expect.objectContaining({ reasonCode: "CONFIGURATION_REJECTED", violations: ["OPS_CONFIG_MISSING@ops"] }));
  });
});

describe("admission over PostgreSQL-backed kill switches and budgets", () => {
  let db: PgliteDb | undefined;
  afterEach(async () => {
    await db?.close();
    db = undefined;
  });

  it("[SAFE-03] end to end: engaged switches and an exhausted budget stop automation but never the safety route", async () => {
    db = await createOpsTestDb();
    const clock = new FakeClock("2026-10-17T15:00:00.000Z");
    const audit = new InTxAuditWriterFixture(db);
    const killSwitches = new KillSwitchServicePg({ db, audit, clock });
    const budgets = new BudgetServicePg({ db, audit, clock });
    const ctl = new AdmissionControllerImpl({
      environment: "local",
      killSwitches,
      budgets,
      capacity: new InMemorySessionCapacity({ maxConcurrentAiSessions: 2000, safetyReserveSessions: 100 }),
      clock,
    });
    const req = (cls: AdmissionClass) => ctl.admit({ tenantId: TENANT_ID, class: cls, vendor: "talkdesk-ai", workflow: "billing_question", cohort: "pilot-a", newSession: true });
    await budgets.defineBudget({
      tenantId: TENANT_ID,
      environment: "local",
      cohort: "*",
      workflow: "*",
      vendor: "*",
      periodStart: "2026-10-01T00:00:00.000Z",
      periodEnd: "2026-11-01T00:00:00.000Z",
      limitUsd: 10,
      safetyReserveUsd: 2,
      meteringDelayMinutes: 0,
      approvedBy: null,
      version: "test-1",
      staff: staffActor("securityAdmin"),
    });
    expect((await req("PUBLIC")).admitted).toBe(true);
    await ctl.recordCost({ tenantId: TENANT_ID, vendor: "talkdesk-ai", workflow: "billing_question", cohort: "pilot-a", usd: 8, safety: false });
    expect(await req("PUBLIC")).toMatchObject({ admitted: false, reasonCode: "BUDGET_EXHAUSTED", continuity: "HUMAN_QUEUE" });
    await killSwitches.set({ tenantId: TENANT_ID, scope: "AI_ADMISSION", target: "*", engaged: true, reason: "INCIDENT_UNEXPECTED_SPENDING", staff: staffActor("supervisor") });
    expect((await req("PROTECTED_READ")).reasonCode).toBe("KILL_SWITCH_AI_ADMISSION");
    const safety = await req("SAFETY");
    expect(safety.admitted).toBe(true);
    await ctl.recordCost({ tenantId: TENANT_ID, vendor: "talkdesk-ai", workflow: "safety_handoff", cohort: "pilot-a", usd: 5, safety: true });
    expect((await req("HUMAN_ROUTE")).admitted).toBe(true);
    const [status] = await budgets.statusFor({ tenantId: TENANT_ID, environment: "local", vendor: "talkdesk-ai", workflow: "billing_question", cohort: "pilot-a", now: clock.now() });
    expect(status?.safetyReserveExceeded).toBe(true);
  });

  it("[OPS-02] LOCAL FIXTURE ops services compose with the admission controller", async () => {
    const clock = new FakeClock("2026-10-17T15:00:00.000Z");
    const ctl = new AdmissionControllerImpl({
      environment: "local",
      killSwitches: new LocalFixtureKillSwitchService({ clock }),
      budgets: new LocalFixtureBudgetService({ clock }),
      capacity: new InMemorySessionCapacity({ maxConcurrentAiSessions: 10, safetyReserveSessions: 2 }),
      clock,
    });
    // No budget defined: nonessential work is refused with a continuity route; safety is admitted.
    expect(await ctl.admit({ tenantId: TENANT_ID, class: "PUBLIC", vendor: null, workflow: null, cohort: "pilot-a" })).toMatchObject({ admitted: false, reasonCode: "BUDGET_NOT_CONFIGURED", continuity: "HUMAN_QUEUE" });
    expect((await ctl.admit({ tenantId: TENANT_ID, class: "SAFETY", vendor: null, workflow: null, cohort: "pilot-a" })).admitted).toBe(true);
  });
});
