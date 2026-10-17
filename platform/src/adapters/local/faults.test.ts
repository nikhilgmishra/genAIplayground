import { describe, expect, it } from "vitest";
import { isSafeToRetry, outcomeOf } from "../../resilience/classify.js";
import { DependencyError, ValidationError } from "../../shared/errors.js";
import { AdapterDependencyError } from "../errors.js";
import { FaultInjector, READ_FAULTS, WRITE_FAULTS, type ActiveFaults } from "./faults.js";

const RETRY_ON = ["TIMEOUT_BEFORE_SEND", "CONNECTION_REFUSED", "HTTP_429", "HTTP_503"];

function injector(sleep?: (ms: number) => Promise<void>): FaultInjector {
  const f = new FaultInjector(sleep ? { sleep } : {});
  f.declare("scheduling", { reschedule: WRITE_FAULTS, listSlots: READ_FAULTS });
  return f;
}

async function preSendError(a: ActiveFaults): Promise<unknown> {
  try {
    await a.beforeSend();
  } catch (err) {
    return err;
  }
  return null;
}

describe("FaultInjector (LOCAL FIXTURE)", () => {
  it("[SPEC-14.faults] OUTAGE, TIMEOUT_BEFORE_SEND and QUOTA_EXHAUSTED fail before sending with NOT_STARTED (safe to retry)", async () => {
    const cases = [
      { kind: "OUTAGE", reason: "CONNECTION_REFUSED", http: null },
      { kind: "TIMEOUT_BEFORE_SEND", reason: "TIMEOUT_BEFORE_SEND", http: null },
      { kind: "QUOTA_EXHAUSTED", reason: "HTTP_429", http: 429 },
    ] as const;
    for (const c of cases) {
      const f = injector();
      f.inject({ integrationId: "scheduling", operation: "reschedule", kind: c.kind });
      const err = await preSendError(f.begin("scheduling", "reschedule"));
      expect(err).toBeInstanceOf(DependencyError);
      expect(err).toBeInstanceOf(AdapterDependencyError);
      expect(err).toMatchObject({ reasonCode: c.reason, outcome: "NOT_STARTED", retryable: true, httpStatus: c.http, injected: true, integrationId: "scheduling" });
      expect(isSafeToRetry(err, RETRY_ON)).toBe(true);
    }
  });

  it("[ACT-03] REJECTED is a definite refusal: FAILED outcome, nothing applied, never retried", async () => {
    const f = injector();
    f.inject({ integrationId: "scheduling", operation: "reschedule", kind: "REJECTED" });
    const err = await preSendError(f.begin("scheduling", "reschedule"));
    expect(err).toMatchObject({ reasonCode: "DEPENDENCY_REJECTED", outcome: "FAILED", retryable: false, httpStatus: 400 });
    expect(outcomeOf(err)).toBe("FAILED");
    expect(isSafeToRetry(err, RETRY_ON)).toBe(false);
  });

  it("[ACT-03] TIMEOUT_AFTER_COMMIT passes the pre-send check and throws UNKNOWN only after the effect (never retried blindly)", async () => {
    const f = injector();
    f.inject({ integrationId: "scheduling", operation: "reschedule", kind: "TIMEOUT_AFTER_COMMIT" });
    const a = f.begin("scheduling", "reschedule");
    await expect(a.beforeSend()).resolves.toBeUndefined();
    let err: unknown = null;
    try {
      a.afterCommit();
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ reasonCode: "TIMEOUT_AFTER_SEND", outcome: "UNKNOWN", retryable: false });
    expect(outcomeOf(err)).toBe("UNKNOWN");
    expect(isSafeToRetry(err, RETRY_ON)).toBe(false);
  });

  it("[SPEC-14.faults] PARTIAL_WRITE is flagged on the call and reported as UNKNOWN", () => {
    const f = injector();
    f.inject({ integrationId: "scheduling", operation: "reschedule", kind: "PARTIAL_WRITE" });
    const a = f.begin("scheduling", "reschedule");
    expect(a.has("PARTIAL_WRITE")).toBe(true);
    expect(a.partialWriteError()).toMatchObject({ reasonCode: "PARTIAL_WRITE", outcome: "UNKNOWN", retryable: false });
  });

  it("[SPEC-14.faults] once, counted and persistent modes with skip are deterministic", () => {
    const f = injector();
    f.inject({ integrationId: "scheduling", operation: "listSlots", kind: "STALE_READ", skip: 1, mode: { times: 2 } });
    const seen = Array.from({ length: 5 }, () => f.begin("scheduling", "listSlots").has("STALE_READ"));
    expect(seen).toEqual([false, true, true, false, false]);
    const g = injector();
    const id = g.inject({ integrationId: "scheduling", operation: "listSlots", kind: "STALE_READ", mode: "persistent" });
    expect(Array.from({ length: 4 }, () => g.begin("scheduling", "listSlots").has("STALE_READ"))).toEqual([true, true, true, true]);
    g.clear(id);
    expect(g.begin("scheduling", "listSlots").has("STALE_READ")).toBe(false);
    expect(g.activations.map((x) => x.call)).toEqual([1, 2, 3, 4]);
  });

  it("[SPEC-14.faults] a pre-send failure preempts other matching faults, which stay planned for the next call", async () => {
    const f = injector();
    f.inject({ integrationId: "scheduling", operation: "reschedule", kind: "TIMEOUT_AFTER_COMMIT" });
    f.inject({ integrationId: "scheduling", operation: "reschedule", kind: "OUTAGE" });
    f.inject({ integrationId: "scheduling", operation: "reschedule", kind: "QUOTA_EXHAUSTED" });
    const first = f.begin("scheduling", "reschedule");
    expect(first.kinds).toEqual(["OUTAGE"]);
    expect(await preSendError(first)).toMatchObject({ reasonCode: "CONNECTION_REFUSED" });
    const second = f.begin("scheduling", "reschedule");
    expect(second.kinds).toEqual(["QUOTA_EXHAUSTED"]);
    const third = f.begin("scheduling", "reschedule");
    expect(third.kinds).toEqual(["TIMEOUT_AFTER_COMMIT"]);
    expect(f.unconsumed()).toEqual([]);
  });

  it("[OPS-03] a fault an operation cannot honour is rejected at injection; faults that never fired are reported", () => {
    const f = injector();
    expect(() => f.inject({ integrationId: "scheduling", operation: "listSlots", kind: "TIMEOUT_AFTER_COMMIT" })).toThrow(ValidationError);
    expect(() => f.inject({ integrationId: "scheduling", operation: "cancel", kind: "OUTAGE" })).toThrow(expect.objectContaining({ reasonCode: "FAULT_OPERATION_UNKNOWN" }));
    expect(() => f.inject({ integrationId: "scheduling", operation: "*", kind: "OUT_OF_ORDER" })).toThrow(expect.objectContaining({ reasonCode: "FAULT_KIND_UNSUPPORTED" }));
    expect(() => f.inject({ integrationId: "scheduling", operation: "reschedule", kind: "SLOW" })).toThrow(expect.objectContaining({ reasonCode: "FAULT_SPEC_INVALID" }));
    expect(() => f.inject({ integrationId: "scheduling", operation: "reschedule", kind: "OUTAGE", delayMs: 5 })).toThrow(ValidationError);
    const id = f.inject({ integrationId: "scheduling", operation: "reschedule", kind: "OUTAGE" });
    expect(f.unconsumed().map((u) => u.faultId)).toEqual([id]);
  });

  it("[SPEC-14.faults] SLOW delays the call through the injected sleep and then proceeds", async () => {
    const slept: number[] = [];
    const f = injector(async (ms) => {
      slept.push(ms);
    });
    f.inject({ integrationId: "scheduling", operation: "reschedule", kind: "SLOW", delayMs: 4_000 });
    await expect(f.begin("scheduling", "reschedule").beforeSend()).resolves.toBeUndefined();
    expect(slept).toEqual([4_000]);
  });

  it("[SPEC-14.faults] wildcard operation targets every operation supporting the kind; OUTAGE marks the integration degraded", () => {
    const f = injector();
    f.inject({ integrationId: "scheduling", operation: "*", kind: "OUTAGE", mode: "persistent" });
    expect(f.isDegraded("scheduling")).toBe(true);
    expect(f.begin("scheduling", "listSlots").has("OUTAGE")).toBe(true);
    expect(f.begin("scheduling", "reschedule").has("OUTAGE")).toBe(true);
    expect(f.begin("billing", "listInvoices").kinds).toEqual([]);
    f.reset();
    expect(f.isDegraded("scheduling")).toBe(false);
    expect(f.callCount("scheduling", "listSlots")).toBe(0);
  });

  it("[SPEC-14.faults] a fault plan given at construction is applied in order", () => {
    const f = new FaultInjector({ plan: [{ integrationId: "claims", operation: "getClaim", kind: "STALE_READ", mode: { times: 2 } }] });
    f.declare("claims", { getClaim: READ_FAULTS });
    expect([1, 2, 3].map(() => f.begin("claims", "getClaim").has("STALE_READ"))).toEqual([true, true, false]);
  });
});
