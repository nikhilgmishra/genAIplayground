/**
 * Builds the Layer-2 vitest configuration used by platform/vitest.integration.config.ts.
 * Kept here so it is type-checked with the platform.
 */
import { isAbsolute, join, resolve } from "node:path";
import { configDefaults } from "vitest/config";
import type { ViteUserConfig } from "vitest/config";
import { noUnitFakes } from "./no-unit-fakes.js";

/**
 * Throwaway probe files the harness self-tests (guards.test.ts) write and run in a separate vitest
 * process. Regular runs never pick them up, so a probe left behind by an interrupted run cannot fail
 * or pass a later run; probe runs (VSP_LAYER2_PROBE=1) see nothing else.
 */
export const PROBE_GLOB = "test/integration/**/guard-probe-*/**";
const PROBE_INCLUDE = "test/integration/**/guard-probe-*/*.test.ts";

export function integrationConfig(env: NodeJS.ProcessEnv = process.env): ViteUserConfig {
  if (env.VSP_INTEGRATION !== "1") {
    throw new Error("vitest.integration.config.ts runs the Layer-2 suite only with VSP_INTEGRATION=1 against the local composition (make up PROFILE=core && make test-integration)");
  }
  const reportDir = env.VSP_TEST_REPORT_DIR ? (isAbsolute(env.VSP_TEST_REPORT_DIR) ? env.VSP_TEST_REPORT_DIR : resolve(process.cwd(), env.VSP_TEST_REPORT_DIR)) : null;
  const harness = "test/integration/_harness";
  const probe = env.VSP_LAYER2_PROBE === "1";
  return {
    plugins: [noUnitFakes()],
    test: {
      name: "integration",
      include: probe ? [PROBE_INCLUDE] : ["test/integration/**/*.test.ts"],
      exclude: probe ? [...configDefaults.exclude] : [...configDefaults.exclude, PROBE_GLOB],
      environment: "node",
      pool: "forks",
      maxWorkers: 2,
      testTimeout: 120_000,
      hookTimeout: 180_000,
      globalSetup: [`${harness}/global-setup.ts`],
      setupFiles: [`${harness}/setup.ts`],
      reporters: [
        "default",
        `./${harness}/emulation-reporter.ts`,
        ...(reportDir ? [["json", { outputFile: join(reportDir, "vitest-integration.json") }] as ["json", { outputFile: string }]] : []),
      ],
    },
  };
}
