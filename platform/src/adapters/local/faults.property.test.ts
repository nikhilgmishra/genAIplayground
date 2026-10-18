import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { FaultInjector, WRITE_FAULTS, type FaultKind } from "./faults.js";

const NON_PRESEND: FaultKind[] = ["TIMEOUT_AFTER_COMMIT", "PARTIAL_WRITE", "DUPLICATE_DELIVERY"];

describe("FaultInjector properties (LOCAL FIXTURE)", () => {
  it("[SPEC-14.faults] a fault with skip k and n activations fires exactly on matching calls k+1..k+n", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...NON_PRESEND),
        fc.integer({ min: 0, max: 6 }),
        fc.oneof(fc.constant<"persistent">("persistent"), fc.integer({ min: 1, max: 6 })),
        fc.integer({ min: 0, max: 15 }),
        (kind, skip, times, calls) => {
          const f = new FaultInjector();
          f.declare("scheduling", { reschedule: WRITE_FAULTS });
          f.inject({ integrationId: "scheduling", operation: "reschedule", kind, skip, mode: times === "persistent" ? "persistent" : { times } });
          const fired = Array.from({ length: calls }, (_, i) => (f.begin("scheduling", "reschedule").has(kind) ? i + 1 : null)).filter((x): x is number => x !== null);
          const limit = times === "persistent" ? Number.POSITIVE_INFINITY : times;
          const expected: number[] = [];
          for (let c = skip + 1; c <= calls && expected.length < limit; c++) expected.push(c);
          expect(fired).toEqual(expected);
          expect(f.activations.map((a) => a.call)).toEqual(expected);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("[SPEC-14.faults] activations are a pure function of the plan and the call sequence (deterministic replay)", () => {
    const kindArb = fc.constantFrom<FaultKind>(...WRITE_FAULTS.filter((k) => k !== "SLOW"));
    fc.assert(
      fc.property(fc.array(fc.record({ kind: kindArb, skip: fc.integer({ min: 0, max: 3 }), times: fc.integer({ min: 1, max: 3 }) }), { maxLength: 6 }), fc.integer({ min: 1, max: 12 }), (plan, calls) => {
        const run = () => {
          const f = new FaultInjector();
          f.declare("salesforce", { upsertCase: WRITE_FAULTS });
          for (const p of plan) f.inject({ integrationId: "salesforce", operation: "upsertCase", kind: p.kind, skip: p.skip, mode: { times: p.times } });
          for (let i = 0; i < calls; i++) f.begin("salesforce", "upsertCase");
          return f.activations;
        };
        expect(run()).toEqual(run());
        // At most one pre-send failure per call.
        const perCall = new Map<number, FaultKind[]>();
        for (const a of run()) perCall.set(a.call, [...(perCall.get(a.call) ?? []), a.kind]);
        for (const kinds of perCall.values()) {
          expect(kinds.filter((k) => k === "OUTAGE" || k === "QUOTA_EXHAUSTED" || k === "TIMEOUT_BEFORE_SEND" || k === "REJECTED").length).toBeLessThanOrEqual(1);
          expect(new Set(kinds).size).toBe(kinds.length);
        }
      }),
      { numRuns: 200 },
    );
  });
});
