#!/usr/bin/env node
// Drift check: every platform metric referenced by the Terraform dashboards/alarms
// (infra/terraform/modules/observability) must exist in the content-free metric
// catalogue: the base catalogue (platform/src/observability/metrics.ts) plus every module
// fragment merged by platform/src/observability/catalog/index.ts (catalog/*.ts and the
// composition fragment platform/src/observability/composition-catalog.ts). A renamed or
// removed metric would otherwise leave an alarm permanently in INSUFFICIENT_DATA (which is not a pass).
//
//   node scripts/ci/check-metric-names.mjs
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function catalogueNames(source) {
  return new Set([...source.matchAll(/def\(\s*"(vsp_[a-z0-9_]+)"/g)].map((m) => m[1]));
}

export function terraformNames(source) {
  return new Set([...source.matchAll(/"(vsp_[a-z0-9_]+)"/g)].map((m) => m[1]));
}

export function drift(catalogue, terraform) {
  return [...terraform].filter((n) => !catalogue.has(n)).sort();
}

/**
 * Source of the base catalogue and of every merged fragment (catalog/*.ts except index and tests, and the
 * composition fragment composition-catalog.ts).
 */
export function catalogueSources(root = ROOT) {
  const dir = join(root, "platform/src/observability/catalog");
  const fragments = readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "index.ts")
    .sort()
    .map((f) => readFileSync(join(dir, f), "utf8"));
  const base = join(root, "platform/src/observability");
  return [readFileSync(join(base, "metrics.ts"), "utf8"), readFileSync(join(base, "composition-catalog.ts"), "utf8"), ...fragments].join("\n");
}

function main() {
  const tfFile = join(ROOT, "infra/terraform/modules/observability/main.tf");
  let catalogueSource;
  try {
    catalogueSource = catalogueSources();
  } catch {
    process.stderr.write("check-metric-names: platform/src/observability/metrics.ts or catalog/ missing (owner: observability engineer)\n");
    process.exit(1);
  }
  const catalogue = catalogueNames(catalogueSource);
  const used = terraformNames(readFileSync(tfFile, "utf8"));
  const missing = drift(catalogue, used);
  if (missing.length > 0) {
    process.stderr.write(`check-metric-names: Terraform references metrics absent from the catalogue: ${missing.join(", ")}\n`);
    process.exit(1);
  }
  process.stdout.write(`check-metric-names: ok (${used.size} Terraform metric names, ${catalogue.size} catalogue metrics)\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
