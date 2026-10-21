/**
 * Telemetry export (WP-07; FO-03-30, DATA-01, AIN-37). Content attributes are never exported (the schema
 * accepts DISABLED only). An OTLP endpoint is optional (null: nothing leaves the process); when one is set it
 * must be allowlisted for this environment as a TELEMETRY_EXPORTER destination (content-free classes only),
 * and outside sandbox it must be a routable host, never an emulator. A configured endpoint that breaks these
 * rules refuses the environment: a contradictory export setting is a configuration error, not a missing input.
 */
import { egressDestinationFor } from "./egress.js";
import { LIVE_RULE_SETS, emulatorHost, nonRoutableHost, tryUrl } from "./types.js";
import type { GuardRule } from "./types.js";

export const observabilityRule: GuardRule = {
  id: "observability",
  file: "observability.ts",
  ruleSets: LIVE_RULE_SETS,
  evaluate({ config, ruleSet, v }) {
    const otlp = config.observability?.otlp;
    if (!otlp) return;
    for (const [signal, raw] of [
      ["metricsUrl", otlp.metricsUrl],
      ["tracesUrl", otlp.tracesUrl],
    ] as const) {
      if (!raw) continue;
      const path = `observability.otlp.${signal}`;
      const url = tryUrl(raw);
      if (!url) {
        v.add("TELEMETRY_ENDPOINT_INVALID", path);
        continue;
      }
      const d = egressDestinationFor(config, url);
      if (!d) v.add("TELEMETRY_ENDPOINT_NOT_ALLOWLISTED", path);
      else if (d.kind !== "TELEMETRY_EXPORTER") v.add("TELEMETRY_ENDPOINT_NOT_TELEMETRY_DESTINATION", path);
      if (ruleSet === "full" && (nonRoutableHost(url.hostname) || emulatorHost(url.hostname))) v.add("TELEMETRY_ENDPOINT_NOT_ROUTABLE", path);
    }
  },
};
