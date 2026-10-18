/** Presentation helpers. Times are shown in UTC with an explicit zone label. */
export function formatUtc(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "invalid time";
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
}

export function formatUsd(amount: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(amount);
}

export function formatSeconds(seconds: number | null): string {
  if (seconds === null) return "unknown";
  if (seconds < 60) return `${seconds} s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? `${m} min` : `${m} min ${s} s`;
}

export const formatCount = (n: number | null): string => (n === null ? "unknown" : String(n));

export const yesNo = (v: boolean): string => (v ? "Yes" : "No");

/** Human label for an enum value: "WAITING_FOR_HUMAN" -> "Waiting for human". */
export function enumLabel(value: string): string {
  const s = value.replace(/[_.]/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
