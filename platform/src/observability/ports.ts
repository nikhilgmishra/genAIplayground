/**
 * Content-free observability ports. Log fields and metric labels are restricted
 * to an allowlist of opaque identifiers, codes, counts and durations so PHI
 * cannot reach logs, metric labels, alert text or trace baggage (DATA-01).
 */
export type SafeFieldValue = string | number | boolean | null;
export type SafeFields = Record<string, SafeFieldValue>;

export interface Logger {
  debug(event: string, fields?: SafeFields): void;
  info(event: string, fields?: SafeFields): void;
  warn(event: string, fields?: SafeFields): void;
  error(event: string, fields?: SafeFields): void;
  child(bindings: SafeFields): Logger;
}

export interface Metrics {
  /** Label values must come from the metric's declared enum allowlist; unknown values become "other". */
  increment(name: string, labels?: Record<string, string>, value?: number): void;
  observe(name: string, valueMs: number, labels?: Record<string, string>): void;
  gauge(name: string, value: number, labels?: Record<string, string>): void;
}
