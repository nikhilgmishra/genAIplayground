import { isAbsolute, join, resolve } from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

/**
 * Layer-1 test projects (FO-19-67). `vitest run` runs all four, exactly the tests the previous
 * single-project configuration ran; `vitest run --project unit` runs one of them.
 *
 *   unit      src/** and test/** except the three below (new test directories default to unit)
 *   contract  src/**\/*.contract.test.ts (production adapters against injected stub clients)
 *   docs      test/docs/**
 *   journey   test/journeys/**
 *
 * Layer-2 tests (test/integration/**) never run here: they need the Docker composition and run
 * through vitest.integration.config.ts (`make test-integration`).
 *
 * JSON reports are written only on request, so ad hoc runs never overwrite committed evidence:
 * with VSP_TEST_REPORT_DIR set, the run writes <dir>/vitest-<project>.json (one --project selected)
 * or <dir>/vitest-platform.json (all projects). `make test-unit` passes its own reporter flags.
 */
const LAYER2 = "test/integration/**";
const CONTRACT = "src/**/*.contract.test.ts";
const DOCS = "test/docs/**";
const JOURNEYS = "test/journeys/**";

export const PLATFORM_TEST_PROJECTS = ["unit", "contract", "docs", "journey"] as const;

function selectedProjects(argv: readonly string[]): string[] {
  const names: string[] = [];
  argv.forEach((a, i) => {
    if (a === "--project") names.push(argv[i + 1] ?? "");
    else if (a.startsWith("--project=")) names.push(a.slice("--project=".length));
  });
  return names.filter((n) => n !== "");
}

function jsonReportFile(): string | null {
  const dir = process.env.VSP_TEST_REPORT_DIR;
  if (!dir) return null;
  const base = isAbsolute(dir) ? dir : resolve(process.cwd(), dir);
  const projects = selectedProjects(process.argv);
  const name = projects.length === 1 ? projects[0] : projects.length === 0 ? "platform" : projects.join("+");
  return join(base, `vitest-${name}.json`);
}

const reportFile = jsonReportFile();

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
    reporters: reportFile ? ["default", ["json", { outputFile: reportFile }]] : ["default"],
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["src/**/*.test.ts", "test/**/*.test.ts"],
          exclude: [...configDefaults.exclude, CONTRACT, DOCS, JOURNEYS, LAYER2],
        },
      },
      { extends: true, test: { name: "contract", include: [CONTRACT], exclude: [...configDefaults.exclude, LAYER2] } },
      { extends: true, test: { name: "docs", include: [`${DOCS}/*.test.ts`], exclude: [...configDefaults.exclude, LAYER2] } },
      { extends: true, test: { name: "journey", include: [`${JOURNEYS}/*.test.ts`], exclude: [...configDefaults.exclude, LAYER2] } },
    ],
  },
});
