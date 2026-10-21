/**
 * Value tests for the latency quantile interval (stats.ts quantileWithInterval; FO-17-41 "latency reported with
 * sample counts and 95% intervals").
 *
 * The interval is the distribution-free order-statistic interval [x_(l), x_(u)] with
 *   l = floor(n*q - 1.959964*sqrt(n*q*(1-q)))  and  u = ceil(n*q + 1.959964*sqrt(n*q*(1-q))) + 1
 * (ranks 1-based; a rank outside 1..n leaves that bound null). Every expected value below is a literal worked
 * out by hand from those formulas, not recomputed by the code under test, and each interval is cross-checked
 * against the binomial: the probability that [x_(l), x_(u)] covers the true q-quantile is
 * P(l <= B <= u - 1) for B ~ Binomial(n, q), which must be at least 95% (the normal approximation is
 * conservative here) without the interval collapsing onto the point estimate.
 */
import { describe, expect, it } from "vitest";
import { binomialCdf, clopperPearsonUpper, quantileWithInterval } from "./stats.js";

const ranks = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
/** Coverage of the order-statistic interval of ranks [l, u] for the q-quantile of n independent samples. */
const coverage = (l: number, u: number, n: number, q: number) => binomialCdf(u - 1, n, q) - binomialCdf(l - 1, n, q);

describe("[FO-17-41] quantileWithInterval: nearest-rank estimate and order-statistic 95% interval", () => {
  it("[FO-17-41] values 1..100, q = 0.5: estimate 50, lower95 = x(floor(50 - 9.80)) = 40, upper95 = x(ceil(50 + 9.80) + 1) = 61; binomial coverage >= 95%", () => {
    const r = quantileWithInterval(ranks(100), 0.5);
    expect(r).toEqual({ q: 0.5, samples: 100, estimate: 50, lower95: 40, upper95: 61 });
    const c = coverage(40, 61, 100, 0.5);
    expect(c).toBeGreaterThanOrEqual(0.95);
    expect(c).toBeCloseTo(0.9648, 3);
    // The interval is a real interval around the estimate, not the point estimate (a zero half-width).
    expect((r.upper95 as number) - (r.lower95 as number)).toBe(21);
  });

  it("[FO-17-41] the bounds are order statistics of the sorted sample: unsorted input and non-unit spacing map ranks to values", () => {
    const values = ranks(100)
      .map((v) => v * 10)
      .sort((a, b) => ((a * 7919) % 101) - ((b * 7919) % 101));
    expect(quantileWithInterval(values, 0.5)).toEqual({ q: 0.5, samples: 100, estimate: 500, lower95: 400, upper95: 610 });
    // Ties: the bound is the value at the rank, whatever value it is.
    const tied = [...Array<number>(60).fill(7), ...Array<number>(40).fill(9)];
    expect(quantileWithInterval(tied, 0.5)).toMatchObject({ estimate: 7, lower95: 7, upper95: 9 });
  });

  it("[FO-17-41] values 1..400, q = 0.5: half-width 19.60 gives ranks 180 and 221 (coverage >= 95%)", () => {
    expect(quantileWithInterval(ranks(400), 0.5)).toEqual({ q: 0.5, samples: 400, estimate: 200, lower95: 180, upper95: 221 });
    expect(coverage(180, 221, 400, 0.5)).toBeGreaterThanOrEqual(0.95);
  });

  it("[FO-17-41] p95 and p99: values 1..1000 give p95 [936, 965] (half 13.51) and p99 [983, 998] (half 6.17), each covering >= 95%", () => {
    expect(quantileWithInterval(ranks(1000), 0.95)).toEqual({ q: 0.95, samples: 1000, estimate: 950, lower95: 936, upper95: 965 });
    expect(coverage(936, 965, 1000, 0.95)).toBeGreaterThanOrEqual(0.95);
    expect(quantileWithInterval(ranks(1000), 0.99)).toEqual({ q: 0.99, samples: 1000, estimate: 990, lower95: 983, upper95: 998 });
    expect(coverage(983, 998, 1000, 0.99)).toBeGreaterThanOrEqual(0.95);
  });

  it("[FO-17-41] a tail quantile of a small sample has no upper bound: 1..100 p95 [90, null], p99 [97, null]; 1..20 p99 [18, null]", () => {
    expect(quantileWithInterval(ranks(100), 0.95)).toEqual({ q: 0.95, samples: 100, estimate: 95, lower95: 90, upper95: null });
    expect(quantileWithInterval(ranks(100), 0.99)).toEqual({ q: 0.99, samples: 100, estimate: 99, lower95: 97, upper95: null });
    expect(quantileWithInterval(ranks(20), 0.99)).toEqual({ q: 0.99, samples: 20, estimate: 20, lower95: 18, upper95: null });
  });

  it("[FO-17-41] small samples: n = 5 and n = 1 have no bounds; n = 10 and n = 11 medians have the ranks the formula gives", () => {
    expect(quantileWithInterval(ranks(5), 0.5)).toEqual({ q: 0.5, samples: 5, estimate: 3, lower95: null, upper95: null });
    expect(quantileWithInterval([42], 0.5)).toEqual({ q: 0.5, samples: 1, estimate: 42, lower95: null, upper95: null });
    expect(quantileWithInterval([42], 0.99)).toEqual({ q: 0.99, samples: 1, estimate: 42, lower95: null, upper95: null });
    expect(quantileWithInterval(ranks(10), 0.5)).toEqual({ q: 0.5, samples: 10, estimate: 5, lower95: 1, upper95: 10 });
    expect(quantileWithInterval(ranks(11), 0.5)).toEqual({ q: 0.5, samples: 11, estimate: 6, lower95: 2, upper95: 10 });
    expect(quantileWithInterval([], 0.5)).toEqual({ q: 0.5, samples: 0, estimate: null, lower95: null, upper95: null });
  });

  it("[FO-17-41] the binomial cross-check itself: exact Clopper-Pearson values and the median coverage of 1..100", () => {
    // Reference values: one failure in ten, zero in thirty (1 - 0.05^(1/30)), one-sided 95%.
    expect(clopperPearsonUpper(1, 10)).toBeCloseTo(0.39416, 4);
    expect(clopperPearsonUpper(0, 30)).toBeCloseTo(0.09503, 4);
    expect(binomialCdf(50, 100, 0.5)).toBeCloseTo(0.5398, 4);
    // 1..30 median: half-width 5.37 gives ranks 9 and 22; coverage 98.4%, and narrowing either rank lowers it.
    expect(quantileWithInterval(ranks(30), 0.5)).toEqual({ q: 0.5, samples: 30, estimate: 15, lower95: 9, upper95: 22 });
    expect(coverage(9, 22, 30, 0.5)).toBeCloseTo(0.9839, 3);
    expect(coverage(10, 21, 30, 0.5)).toBeLessThan(coverage(9, 22, 30, 0.5));
  });
});
