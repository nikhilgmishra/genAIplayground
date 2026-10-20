/**
 * Uncertainty bounds for failure rates (spec section 14: "Zero failures in a
 * finite test set does not establish zero population risk").
 *
 * All bounds are one-sided 95 percent upper bounds and assume approximately
 * independent opportunities. Repetitions of the same scenario are NOT
 * independent, so callers should report the bound over distinct scenarios as
 * well as over runs.
 */

export const UNCERTAINTY_CAVEAT =
  "Zero observed failures does not establish zero risk. Bounds are one-sided 95% upper bounds assuming approximately independent opportunities; " +
  "repetitions of one scenario are dependent, synthetic scenarios are not production traffic, and dedicated safety review remains necessary.";

// Lanczos approximation (g = 7, n = 9) for ln Gamma.
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012,
  9.9843695780195716e-6, 1.5056327351493116e-7,
];
export function lnGamma(z: number): number {
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  const x = z - 1;
  let a = LANCZOS[0] as number;
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += (LANCZOS[i] as number) / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** P(X <= x) for X ~ Binomial(n, p). */
export function binomialCdf(x: number, n: number, p: number): number {
  if (x < 0) return 0;
  if (x >= n) return 1;
  if (p <= 0) return 1;
  if (p >= 1) return 0;
  const lnNfact = lnGamma(n + 1);
  const lp = Math.log(p);
  const lq = Math.log1p(-p);
  let max = -Infinity;
  const terms: number[] = [];
  for (let k = 0; k <= x; k++) {
    const t = lnNfact - lnGamma(k + 1) - lnGamma(n - k + 1) + k * lp + (n - k) * lq;
    terms.push(t);
    if (t > max) max = t;
  }
  const sum = terms.reduce((s, t) => s + Math.exp(t - max), 0);
  return Math.min(1, Math.exp(max + Math.log(sum)));
}

/** Exact (Clopper-Pearson) one-sided upper confidence bound for a binomial proportion. */
export function clopperPearsonUpper(failures: number, n: number, confidence = 0.95): number | null {
  if (!Number.isInteger(n) || n <= 0 || !Number.isInteger(failures) || failures < 0 || failures > n) return null;
  if (failures === n) return 1;
  const alpha = 1 - confidence;
  if (failures === 0) return 1 - Math.pow(alpha, 1 / n);
  let lo = failures / n;
  let hi = 1;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (binomialCdf(failures, n, mid) > alpha) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** Rule-of-three approximation (3/n) for zero observed failures; null otherwise. */
export const ruleOfThreeUpper = (failures: number, n: number): number | null => (failures === 0 && n > 0 ? Math.min(1, 3 / n) : null);

export interface FailureRateBound {
  failures: number;
  opportunities: number;
  observedRate: number | null;
  clopperPearsonUpper95: number | null;
  ruleOfThreeUpper95: number | null;
}

export function failureRateBound(failures: number, opportunities: number): FailureRateBound {
  return {
    failures,
    opportunities,
    observedRate: opportunities > 0 ? failures / opportunities : null,
    clopperPearsonUpper95: clopperPearsonUpper(failures, opportunities),
    ruleOfThreeUpper95: ruleOfThreeUpper(failures, opportunities),
  };
}

export interface QuantileEstimate {
  /** Quantile level (0.5, 0.95, 0.99). */
  q: number;
  samples: number;
  /** Nearest-rank estimate; null without samples. */
  estimate: number | null;
  /** Distribution-free 95% interval from binomial order statistics; null where the sample is too small to bound it. */
  lower95: number | null;
  upper95: number | null;
}

/**
 * Nearest-rank quantile with a distribution-free 95% confidence interval (order statistics, normal approximation
 * of the binomial rank). Samples must be independent for the interval to hold; turns of one call are not, so the
 * interval is reported with that caveat (FO-17-41, FO-17-43).
 */
export function quantileWithInterval(values: readonly number[], q: number): QuantileEstimate {
  const n = values.length;
  if (n === 0) return { q, samples: 0, estimate: null, lower95: null, upper95: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (rank: number) => sorted[Math.min(n, Math.max(1, rank)) - 1] as number;
  const half = 1.959964 * Math.sqrt(n * q * (1 - q));
  const lo = Math.floor(n * q - half);
  const hi = Math.ceil(n * q + half) + 1;
  return { q, samples: n, estimate: at(Math.ceil(q * n)), lower95: lo >= 1 ? at(lo) : null, upper95: hi <= n ? at(hi) : null };
}
