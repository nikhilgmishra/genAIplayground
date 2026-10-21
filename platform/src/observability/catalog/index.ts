/**
 * The platform metric catalogue, merged centrally (WP-07; FO-03-30, DATA-01).
 *
 * `platform/src/observability/metrics.ts` keeps the base catalogue; each feature module that adds metrics keeps
 * its own fragment file in this directory (ownership rules of docs/followon/work-packages.yaml): substrate
 * (WP-04), connectors (WP-06). The composition's own fragment (activation map, capability gate, telemetry,
 * connector feed, unit starts) lives with the observability group in `../composition-catalog.ts`, because the
 * composition owner of each phase owns that group and this file. `createPlatformMetricCatalogue` merges the
 * base with EVERY fragment listed in PLATFORM_METRIC_FRAGMENTS (keyed by its path relative to
 * platform/src/observability) and fails on a duplicate name (two modules may never declare the same series with
 * different labels). index.test.ts proves that every fragment file in this directory and the composition
 * fragment are listed here, so a new fragment cannot be left out of the composed catalogue, and
 * scripts/ci/check-metric-names.mjs reads the same files for the Terraform drift check.
 */
import { ValidationError } from "../../shared/errors.js";
import { createMetricCatalogue } from "../metrics.js";
import type { CatalogueExtensions, MetricCatalogue, MetricDefinition } from "../metrics.js";
import { COMPOSITION_METRICS } from "../composition-catalog.js";
import { CONNECTOR_METRICS } from "./connectors.js";
import { SUBSTRATE_METRICS } from "./substrate.js";

/** The composition fragment's path relative to platform/src/observability (outside this directory). */
export const COMPOSITION_FRAGMENT_FILE = "composition-catalog.ts";

/**
 * Every module fragment, by its path relative to platform/src/observability (`catalog/<file>` for the fragments
 * of this directory; the test compares this list with the directory).
 */
export const PLATFORM_METRIC_FRAGMENTS: Readonly<Record<string, readonly MetricDefinition[]>> = Object.freeze({
  [COMPOSITION_FRAGMENT_FILE]: COMPOSITION_METRICS,
  "catalog/connectors.ts": CONNECTOR_METRICS,
  "catalog/substrate.ts": SUBSTRATE_METRICS,
});

/**
 * The composed catalogue: the base catalogue (with the dynamic extensions: tool names, intents, models,
 * voices) plus every module fragment. Throws METRIC_NAME_DUPLICATE when a fragment redeclares a name.
 */
export function createPlatformMetricCatalogue(ext: CatalogueExtensions = {}): MetricCatalogue {
  const out = new Map(createMetricCatalogue(ext));
  for (const defs of Object.values(PLATFORM_METRIC_FRAGMENTS)) {
    for (const d of defs) {
      if (!/^vsp_[a-z0-9_]{3,80}$/.test(d.name)) throw new ValidationError("METRIC_NAME_INVALID");
      if (out.has(d.name)) throw new ValidationError("METRIC_NAME_DUPLICATE");
      if (d.type === "counter" && !d.name.endsWith("_total")) throw new ValidationError("METRIC_COUNTER_SUFFIX");
      out.set(d.name, d);
    }
  }
  return out;
}

/** The composed catalogue without dynamic extensions. */
export const PLATFORM_METRIC_CATALOGUE: MetricCatalogue = createPlatformMetricCatalogue();
