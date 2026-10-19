/**
 * Layer 2 (FO-17-03, FO-19-69): production adapters over their real protocols against the local
 * Docker composition. Never part of the default unit run; start it with
 *
 *   make up PROFILE=core && make test-integration [SUITE=_harness] [FILTER=...]
 *
 * which sets VSP_INTEGRATION=1, the state directory and the report directory
 * (evidence/test-reports/vitest-integration.json). See test/integration/_harness/README.md.
 */
import { defineConfig } from "vitest/config";
import { integrationConfig } from "./test/integration/_harness/config.ts";

export default defineConfig(integrationConfig());
