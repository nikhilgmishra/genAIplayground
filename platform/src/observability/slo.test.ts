import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  SERVICE_OBJECTIVES,
  evaluateSlo,
  evaluateSloByBreakdown,
  minSamplesForConclusion,
  percentile,
  sloById,
  summarizeLatency,
  zeroEventUpperBound95,
} from "./slo.js";
import type { SloSample } from "./slo.js";
import { DEFAULT_METRIC_CATALOGUE } from "./metrics.js";

const NOW = new Date("2026-10-17T15:00:00.000Z");
const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();

describe("service objectives as code (spec section 13)", () => {
  it("[SPEC-13.slo] defines every section 13 objective with measurement point, denominator, exclusions and window", () => {
    const ids = SERVICE_OBJECTIVES.map((s) => s.id).sort();
    expect(ids).toEqual(
      [
        "audited_accepted_actions",
        "barge_in_stop",
        "critical_action_authorization",
        "crm_synchronization",
        "duplicate_consequential_actions",
        "handoff_completion",
        "privacy_clinical_boundary_violations",
        "routing_usable_path",
        "tool_backed_substantive_response",
        "warm_simple_turn_latency",
      ].sort(),
    );
    for (const s of SERVICE_OBJECTIVES) {
      expect(s.measurementPoint.length).toBeGreaterThan(10);
      expect(s.numerator.length).toBeGreaterThan(5);
      expect(s.denominator.length).toBeGreaterThan(5);
      expect(Array.isArray(s.exclusions)).toBe(true);
      expect(s.window).toBeDefined();
      expect(DEFAULT_METRIC_CATALOGUE.has(s.metric), s.metric).toBe(true);
    }
  });

  it("[OPS-03] every target is marked PROPOSED and not measured", () => {
    for (const s of SERVICE_OBJECTIVES) {
      expect(s.targetStatus).toBe("PROPOSED");
      expect(s.measured).toBe(false);
    }
  });

  it("[SPEC-13.slo] encodes the proposed section 13 thresholds exactly", () => {
    expect(sloById("routing_usable_path").target).toEqual({ kind: "ratio", minRatio: 0.9995 });
    expect(sloById("routing_usable_path").window).toEqual({ kind: "calendar_month" });
    expect(sloById("warm_simple_turn_latency").target).toEqual({ kind: "latency", percentiles: [{ p: 50, maxMs: 800 }, { p: 95, maxMs: 1500 }] });
    expect(sloById("tool_backed_substantive_response").target).toEqual({ kind: "latency", percentiles: [{ p: 95, maxMs: 3000 }] });
    expect(sloById("barge_in_stop").target).toEqual({ kind: "latency", percentiles: [{ p: 95, maxMs: 250 }] });
    expect(sloById("critical_action_authorization").target).toEqual({ kind: "ratio", minRatio: 1 });
    expect(sloById("audited_accepted_actions").target).toEqual({ kind: "ratio", minRatio: 1 });
    expect(sloById("crm_synchronization").target).toEqual({ kind: "ratio", minRatio: 0.999 });
    expect(sloById("duplicate_consequential_actions").target).toEqual({ kind: "zero_tolerance", maxEvents: 0 });
    expect(sloById("handoff_completion").target).toEqual({ kind: "ratio", minRatio: 0.995 });
    expect(sloById("handoff_completion").reportSeparately).toContain("receiver unavailable attempts");
    expect(sloById("privacy_clinical_boundary_violations").target).toEqual({ kind: "zero_tolerance", maxEvents: 0 });
  });
});

describe("SLO evaluators", () => {
  it("[SPEC-13.slo] nearest-rank percentiles P50/P95/P99", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    const s = summarizeLatency(values);
    expect(s).toEqual({ count: 100, p50: 50, p95: 95, p99: 99, max: 100 });
    expect(percentile([5], 99)).toBe(5);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(summarizeLatency([])).toBeNull();
  });

  it("[SPEC-13.slo] property: percentiles are monotonic and bounded by min/max", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 100_000 }), { minLength: 1, maxLength: 300 }), (vals) => {
        const s = summarizeLatency(vals);
        if (!s) throw new Error("expected summary");
        const sorted = [...vals].sort((a, b) => a - b);
        expect(s.p50).toBeLessThanOrEqual(s.p95);
        expect(s.p95).toBeLessThanOrEqual(s.p99);
        expect(s.p99).toBeLessThanOrEqual(s.max);
        expect(s.p50).toBeGreaterThanOrEqual(sorted[0] ?? 0);
        // at least p% of samples are <= the percentile value
        expect(sorted.filter((v) => v <= s.p95).length / sorted.length).toBeGreaterThanOrEqual(0.95);
      }),
    );
  });

  it("[SPEC-13.slo] latency SLO meets or misses the proposed target from samples", () => {
    const def = sloById("warm_simple_turn_latency");
    const good: SloSample[] = Array.from({ length: 40 }, (_, i) => ({ at: at(i), valueMs: 500 + i * 10 })); // max 890
    const r = evaluateSlo(def, good, { now: NOW, evidence: "synthetic_local" });
    expect(r.status).toBe("MEETS_PROPOSED_TARGET");
    expect(r.targetStatus).toBe("PROPOSED");
    expect(r.evidence).toBe("synthetic_local");
    expect(r.percentiles?.p50).toBe(690);
    const slow = [...good, ...Array.from({ length: 5 }, (_, i) => ({ at: at(i), valueMs: 4000 }))];
    const r2 = evaluateSlo(def, slow, { now: NOW, evidence: "synthetic_local" });
    expect(r2.status).toBe("MISSES_PROPOSED_TARGET");
    expect(r2.checks.find((c) => c.label.startsWith("P95"))?.met).toBe(false);
  });

  it("[OPS-03] no samples, too few samples or samples outside the window are INCONCLUSIVE, never a pass", () => {
    const def = sloById("warm_simple_turn_latency");
    expect(evaluateSlo(def, [], { now: NOW, evidence: "synthetic_local" }).status).toBe("INCONCLUSIVE");
    expect(minSamplesForConclusion(def)).toBe(20);
    const few = Array.from({ length: 19 }, (_, i) => ({ at: at(i), valueMs: 100 }));
    expect(evaluateSlo(def, few, { now: NOW, evidence: "synthetic_local" }).status).toBe("INCONCLUSIVE");
    const old = Array.from({ length: 50 }, () => ({ at: "2026-09-01T00:00:00.000Z", valueMs: 100 }));
    const r = evaluateSlo(def, old, { now: NOW, evidence: "synthetic_local" });
    expect(r.sampleCount).toBe(0);
    expect(r.status).toBe("INCONCLUSIVE");
    expect(minSamplesForConclusion(sloById("routing_usable_path"))).toBe(2000);
    expect(minSamplesForConclusion(sloById("handoff_completion"))).toBe(200);
  });

  it("[SPEC-13.slo] exclusions are removed from the denominator and counted separately", () => {
    const def = sloById("tool_backed_substantive_response");
    const samples: SloSample[] = [
      ...Array.from({ length: 30 }, (_, i) => ({ at: at(i), valueMs: 1000 })),
      ...Array.from({ length: 10 }, (_, i) => ({ at: at(i), valueMs: 9000, excluded: true })),
    ];
    const r = evaluateSlo(def, samples, { now: NOW, evidence: "synthetic_local" });
    expect(r.sampleCount).toBe(30);
    expect(r.excludedCount).toBe(10);
    expect(r.status).toBe("MEETS_PROPOSED_TARGET");
  });

  it("[SPEC-13.slo] ratio SLO attainment and calendar-month window", () => {
    const def = sloById("critical_action_authorization");
    const ok = Array.from({ length: 10 }, (_, i) => ({ at: at(i), good: true }));
    expect(evaluateSlo(def, ok, { now: NOW, evidence: "synthetic_local" }).status).toBe("MEETS_PROPOSED_TARGET");
    const r = evaluateSlo(def, [...ok, { at: at(1), good: false }], { now: NOW, evidence: "synthetic_local" });
    expect(r.status).toBe("MISSES_PROPOSED_TARGET");
    expect(r.attainment).toBeCloseTo(10 / 11);
    const month = evaluateSlo(sloById("routing_usable_path"), [{ at: "2026-09-30T23:59:59.000Z", good: false }], { now: NOW, evidence: "synthetic_local" });
    expect(month.window.start).toBe("2026-10-01T00:00:00.000Z");
    expect(month.sampleCount).toBe(0);
  });

  it("[SPEC-13.slo] zero-tolerance SLO misses on any event and reports an upper bound on zero events", () => {
    const def = sloById("duplicate_consequential_actions");
    const clean = Array.from({ length: 3000 }, () => ({ at: at(1), good: true }));
    const r = evaluateSlo(def, clean, { now: NOW, evidence: "synthetic_local" });
    expect(r.status).toBe("MEETS_PROPOSED_TARGET");
    // spec section 14: zero failures in 3000 gives a rough 95% upper bound near 0.1 percent
    expect(r.zeroEventUpperBound95).toBeGreaterThan(0.00099);
    expect(r.zeroEventUpperBound95).toBeLessThan(0.00101);
    const bad = evaluateSlo(def, [{ at: at(1), good: false }], { now: NOW, evidence: "synthetic_local" });
    expect(bad.status).toBe("MISSES_PROPOSED_TARGET");
    expect(zeroEventUpperBound95(0)).toBeNull();
  });

  it("[SPEC-13.slo] breakdown evaluation exposes a poorly served minority language slice", () => {
    const def = sloById("warm_simple_turn_latency");
    const samples: SloSample[] = [
      ...Array.from({ length: 200 }, (_, i) => ({ at: at(i % 60), valueMs: 600, labels: { language: "en" } })),
      ...Array.from({ length: 20 }, (_, i) => ({ at: at(i), valueMs: 2500, labels: { language: "es" } })),
    ];
    const overall = evaluateSlo(def, samples, { now: NOW, evidence: "synthetic_local" });
    expect(overall.percentiles?.p50).toBe(600);
    const by = evaluateSloByBreakdown(def, samples, "language", { now: NOW, evidence: "synthetic_local" });
    expect(by.en?.status).toBe("MEETS_PROPOSED_TARGET");
    expect(by.es?.status).toBe("MISSES_PROPOSED_TARGET");
    expect(() => evaluateSloByBreakdown(sloById("crm_synchronization"), samples, "language", { now: NOW, evidence: "synthetic_local" })).toThrow(
      "SLO_BREAKDOWN_NOT_DECLARED",
    );
  });
});
