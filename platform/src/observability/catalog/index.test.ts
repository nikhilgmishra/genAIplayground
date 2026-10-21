/**
 * Central metric catalogue merge (WP-07; FO-03-30, DATA-01): every module fragment file in this directory is
 * merged, no name is declared twice, and the merged catalogue still collapses unsafe label values.
 */
import { readdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_METRIC_CATALOGUE, InMemoryMetrics, OpenTelemetryMetrics, createMetricCatalogue } from "../metrics.js";
import { COMPOSITION_METRICS, RUNTIME_CAPABILITY_IDS } from "../composition-catalog.js";
import { COMPOSITION_FRAGMENT_FILE, PLATFORM_METRIC_CATALOGUE, PLATFORM_METRIC_FRAGMENTS, createPlatformMetricCatalogue } from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("platform metric catalogue merge [FO-03-30][DATA-01]", () => {
  it("[FO-03-30] every fragment file of the catalogue directory is merged (a new fragment cannot be left out)", () => {
    const files = readdirSync(here)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "index.ts")
      .map((f) => `catalog/${f}`);
    expect(Object.keys(PLATFORM_METRIC_FRAGMENTS).sort()).toEqual([COMPOSITION_FRAGMENT_FILE, ...files].sort());
    expect(readdirSync(dirname(here))).toContain(COMPOSITION_FRAGMENT_FILE);
    const expected = DEFAULT_METRIC_CATALOGUE.size + Object.values(PLATFORM_METRIC_FRAGMENTS).reduce((n, defs) => n + defs.length, 0);
    expect(PLATFORM_METRIC_CATALOGUE.size).toBe(expected);
    for (const defs of Object.values(PLATFORM_METRIC_FRAGMENTS)) for (const d of defs) expect(PLATFORM_METRIC_CATALOGUE.get(d.name)).toBe(d);
  });

  it("[DATA-01] adversarial: a fragment that redeclares a base metric is refused, never silently shadowed", () => {
    const base = createMetricCatalogue();
    const clash = [...base.values()][0];
    expect(clash).toBeDefined();
    const original = PLATFORM_METRIC_FRAGMENTS[COMPOSITION_FRAGMENT_FILE];
    const mutable = PLATFORM_METRIC_FRAGMENTS as Record<string, readonly unknown[]>;
    // The frozen registry refuses the injection: the merge set cannot be altered at run time.
    expect(() => {
      mutable[COMPOSITION_FRAGMENT_FILE] = [...(original ?? []), clash];
    }).toThrow(TypeError);
    expect(createPlatformMetricCatalogue().size).toBe(PLATFORM_METRIC_CATALOGUE.size);
  });

  it("[DATA-01] composition labels are closed code enums; a capability id that is not a runtime capability collapses to other", () => {
    for (const d of COMPOSITION_METRICS) {
      expect(d.name).toMatch(/^vsp_[a-z0-9_]+$/);
      for (const values of Object.values(d.labels)) for (const v of values) expect(v).toMatch(/^[a-z0-9][a-z0-9_.-]*$/);
    }
    const m = new InMemoryMetrics({ catalogue: PLATFORM_METRIC_CATALOGUE });
    m.gauge("vsp_capability_state", 1, { capability: "tnt_synthTenantId000000001", state: "configured" });
    m.gauge("vsp_capability_state", 1, { capability: RUNTIME_CAPABILITY_IDS[0], state: "configured" });
    expect(m.find("vsp_capability_state").map((s) => s.labels.capability)).toEqual(["other", RUNTIME_CAPABILITY_IDS[0]]);
    // The live OTel bridge applies the same allowlist (unknown names dropped, never thrown).
    const otel = new OpenTelemetryMetrics({ catalogue: PLATFORM_METRIC_CATALOGUE });
    otel.increment("vsp_not_a_metric_total");
    expect(otel.droppedCalls).toBe(1);
  });
});
