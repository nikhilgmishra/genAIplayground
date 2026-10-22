/**
 * Metric catalogue fragment of the model port (WP-08). Content free: labels are closed code enums (provider,
 * outcome, token direction, fallback reason), never model ids, hosts, prompts or completions.
 *
 * Module-local until the phase integration package moves it into platform/src/observability/catalog/models.ts
 * and lists it in catalog/index.ts (both owned by the composition owner of the phase; the WP-08 hand-off diff
 * does exactly that). Until then `withModelMetrics` extends a catalogue for the modules and tests that emit
 * these metrics; every emitter guards its metric calls, so an unmerged catalogue never changes a model call.
 */
import type { MetricCatalogue, MetricDefinition } from "../../observability/metrics.js";

const def = (
  name: string,
  type: MetricDefinition["type"],
  unit: MetricDefinition["unit"],
  dashboard: MetricDefinition["dashboard"],
  description: string,
  labels: Record<string, readonly string[]> = {},
): MetricDefinition => ({ name, type, unit, dashboard, description, labels });

export const MODEL_PROVIDER_LABELS = ["openai_responses", "bedrock_converse", "vllm_openai_compatible"] as const;
export const MODEL_OUTCOME_LABELS = ["COMPLETED", "REFUSED", "INCOMPLETE", "OVERLOADED", "TIMED_OUT", "CANCELLED", "MALFORMED", "UNAVAILABLE", "FAILED"] as const;
export const MODEL_FALLBACK_REASONS = ["MODEL_REFUSED", "MODEL_HANG", "MODEL_OVERLOAD", "MODEL_UNAVAILABLE", "MODEL_MALFORMED", "MODEL_FAILED", "MODEL_INCOMPLETE", "MODEL_CANCELLED"] as const;

export const MODEL_METRICS: readonly MetricDefinition[] = [
  def("vsp_model_calls_total", "counter", "1", "tools_dependencies", "Model port calls by provider and typed outcome", {
    provider: MODEL_PROVIDER_LABELS,
    outcome: MODEL_OUTCOME_LABELS,
  }),
  def("vsp_model_call_latency_ms", "histogram", "ms", "voice_experience", "Wall-clock of a model port call (all attempts) by provider and outcome", {
    provider: MODEL_PROVIDER_LABELS,
    outcome: MODEL_OUTCOME_LABELS,
  }),
  def("vsp_model_tokens_total", "counter", "1", "cost_quotas", "Provider-reported model tokens by provider and direction", {
    provider: MODEL_PROVIDER_LABELS,
    direction: ["input", "output"],
  }),
  def("vsp_model_fallbacks_total", "counter", "1", "safety", "Turns answered with the approved fallback instead of model output, by reason", {
    reason: MODEL_FALLBACK_REASONS,
  }),
  def("vsp_model_profile_status", "gauge", "1", "tools_dependencies", "Real-model profile status (1 for the current status of each provider profile)", {
    provider: MODEL_PROVIDER_LABELS,
    status: ["NOT_CONFIGURED", "CONFIGURED"],
  }),
];

/** The catalogue plus the model metrics (a name the catalogue already has is left as the catalogue defines it). */
export function withModelMetrics(catalogue: MetricCatalogue): MetricCatalogue {
  const out = new Map(catalogue);
  for (const d of MODEL_METRICS) if (!out.has(d.name)) out.set(d.name, d);
  return out;
}
