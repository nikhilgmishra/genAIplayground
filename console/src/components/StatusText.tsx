/** Status never relies on colour alone: every status has a text label and a symbol. */
export type Tone = "ok" | "warn" | "bad" | "neutral";

const SYMBOL: Readonly<Record<Tone, string>> = { ok: "✓", warn: "!", bad: "✕", neutral: "•" };

export function StatusText({ tone, label }: { tone: Tone; label: string }) {
  return (
    <span className={`status status-${tone}`}>
      <span className="status-symbol" aria-hidden="true">
        {SYMBOL[tone]}
      </span>{" "}
      {label}
    </span>
  );
}

const HEALTH_TONE: Readonly<Record<string, Tone>> = { HEALTHY: "ok", DEGRADED: "warn", DOWN: "bad", UNKNOWN: "neutral" };
export const healthTone = (status: string): Tone => HEALTH_TONE[status] ?? "neutral";
