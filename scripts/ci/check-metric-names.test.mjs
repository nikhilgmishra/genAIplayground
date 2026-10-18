// node --test scripts/ci/check-metric-names.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { catalogueNames, drift, terraformNames } from "./check-metric-names.mjs";

const here = dirname(fileURLToPath(import.meta.url));

test("[SPEC-13.alerts] detects Terraform metric names missing from the catalogue", () => {
  const catalogue = catalogueNames('def("vsp_tool_latency_ms", "histogram"); def("vsp_unknown_commits_total", "counter")');
  const tf = terraformNames('metric = "vsp_tool_latency_ms"\nmetric = "vsp_renamed_metric_total"');
  assert.deepEqual(drift(catalogue, tf), ["vsp_renamed_metric_total"]);
});

test("[SPEC-13.dashboards] the real observability module only references catalogue metrics", () => {
  const out = execFileSync(process.execPath, [join(here, "check-metric-names.mjs")], { encoding: "utf8" });
  assert.match(out, /check-metric-names: ok/);
});
