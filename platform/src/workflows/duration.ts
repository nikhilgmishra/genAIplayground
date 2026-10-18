/**
 * Strict ISO-8601 duration handling for workflow deadlines.
 *
 * Only fixed-length units are accepted (weeks, days, hours, minutes, seconds).
 * Calendar units (years, months) are rejected because their length depends on
 * the calendar position and would make deadlines and Step Functions
 * TimeoutSeconds ambiguous.
 */
const DURATION_RE = /^P(?:(\d{1,4})W)?(?:(\d{1,4})D)?(?:T(?:(\d{1,5})H)?(?:(\d{1,6})M)?(?:(\d{1,7})S)?)?$/;

/** Upper bound for any single state deadline (AWS Step Functions Standard executions last at most one year). */
export const MAX_DEADLINE_SECONDS = 365 * 24 * 3600;
/** Lower bound: deadlines shorter than a minute are not meaningful for durable follow-up work. */
export const MIN_DEADLINE_SECONDS = 60;

export type DurationParse = { ok: true; seconds: number } | { ok: false; reasonCode: string };

export function parseIsoDuration(value: string): DurationParse {
  if (typeof value !== "string" || value.length > 32) return { ok: false, reasonCode: "DEADLINE_NOT_ISO8601" };
  if (/^P[^T]*[YM]/.test(value)) return { ok: false, reasonCode: "DEADLINE_CALENDAR_UNITS_NOT_SUPPORTED" };
  const m = DURATION_RE.exec(value);
  if (!m || value === "P" || value.endsWith("T")) return { ok: false, reasonCode: "DEADLINE_NOT_ISO8601" };
  const [, w, d, h, min, s] = m;
  if (w === undefined && d === undefined && h === undefined && min === undefined && s === undefined) {
    return { ok: false, reasonCode: "DEADLINE_NOT_ISO8601" };
  }
  const n = (x: string | undefined) => (x === undefined ? 0 : Number.parseInt(x, 10));
  const seconds = n(w) * 7 * 86400 + n(d) * 86400 + n(h) * 3600 + n(min) * 60 + n(s);
  if (seconds < MIN_DEADLINE_SECONDS) return { ok: false, reasonCode: "DEADLINE_TOO_SHORT" };
  if (seconds > MAX_DEADLINE_SECONDS) return { ok: false, reasonCode: "DEADLINE_TOO_LONG" };
  return { ok: true, seconds };
}

/** Parses a duration that has already passed definition validation; throws on invalid input. */
export function durationSeconds(value: string): number {
  const r = parseIsoDuration(value);
  if (!r.ok) throw new Error(r.reasonCode);
  return r.seconds;
}
