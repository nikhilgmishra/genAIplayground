/**
 * The runner's own contract (FO-19-64, FO-19-67, FO-19-69, FO-03-14), exercised as a black box:
 * scripts/vsp/runner.mts and the Makefile run as child processes, against a fixture package (real
 * vitest), temporary manifests, and a throwaway compose project on the real Docker engine.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, onTestFinished } from "vitest";
import YAML from "yaml";
import { uniqueName } from "./clients.js";
import type { EmulationLabel } from "./discovery.js";
import { PLATFORM_ROOT, REPO_ROOT } from "./env.js";
import { layer2 } from "./layer2.js";
import { scratchDir } from "./scratch.js";

const RUNNER = join(REPO_ROOT, "scripts", "vsp", "runner.mts");
const processLevel = layer2.withoutServices("process-level check of scripts/vsp/runner.mts; no emulator involved");
const withDocker = layer2.withoutServices("process-level check of up/down against a throwaway compose project", ["docker-engine"]);

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Variables the Makefile and the runner read, and make's own channel for command-line assignments.
 * `make test-integration SUITE=_harness FILTER=...` exports them to this process; a nested runner or
 * make call must not inherit them (a stray FILTER would re-plan the nested run), so each call starts
 * without them and sets only what the test passes.
 */
const INHERITED_RUNNER_VARS = ["MAKEFLAGS", "MFLAGS", "MAKELEVEL", "MAKEOVERRIDES", "SUITE", "FILTER", "ARGS", "PROFILE", "TIMEOUT", "PURGE", "PURGE_AUDIT", "SERVICE", "VSP_LAYER2_PROBE"];

function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const k of INHERITED_RUNNER_VARS) delete base[k];
  return { ...base, ...env };
}

function runner(args: string[], env: NodeJS.ProcessEnv = {}): Run {
  const r = spawnSync(process.execPath, [RUNNER, ...args], { cwd: REPO_ROOT, env: childEnv(env), encoding: "utf8", timeout: 600_000 });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function make(args: string[], env: NodeJS.ProcessEnv = {}): Run {
  const r = spawnSync("make", ["--no-print-directory", "-C", REPO_ROOT, ...args], { env: childEnv(env), encoding: "utf8", timeout: 600_000 });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function fixturePackage(tests: Record<string, string>): string {
  const dir = scratchDir("vsp-it-unit-");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "vsp-it-fixture-unit", private: true, type: "module" }));
  writeFileSync(join(dir, "vitest.config.mjs"), "export default { test: { include: ['test/*.test.mjs'], reporters: ['default'] } };\n");
  symlinkSync(join(PLATFORM_ROOT, "node_modules"), join(dir, "node_modules"), "dir");
  mkdirSync(join(dir, "test"));
  for (const [name, body] of Object.entries(tests)) writeFileSync(join(dir, "test", name), body);
  return dir;
}

/**
 * A throwaway Layer-2 suite directory platform/test/integration/guard-probe-<id>/ holding one test file.
 * Regular runs exclude guard-probe-* directories and VSP_LAYER2_PROBE=1 makes the Layer-2 config see
 * probe files only, so a probe left behind by an interrupted run is inert. Removed when the test ends.
 */
function probeSuite(lines: readonly string[]): { suite: string; file: string } {
  const suite = uniqueName("guard-probe");
  const dir = join(PLATFORM_ROOT, "test", "integration", suite);
  mkdirSync(dir);
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "probe.test.ts"), [...lines, ""].join("\n"));
  return { suite, file: `test/integration/${suite}/probe.test.ts` };
}

/** Runs one probe file with the Layer-2 config in a separate vitest process (no report unless asked). */
function vitestProbe(file: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [join(PLATFORM_ROOT, "node_modules", "vitest", "vitest.mjs"), "run", "--config", "vitest.integration.config.ts", file], {
    cwd: PLATFORM_ROOT,
    env: childEnv({ VSP_INTEGRATION: "1", VSP_LAYER2_PROBE: "1", VSP_TEST_REPORT_DIR: "", ...env }),
    encoding: "utf8",
    timeout: 120_000,
  });
}

const PASSING = "import { expect, it } from 'vitest';\nit('passes', () => { expect(1 + 1).toBe(2); });\n";
const FAILING = "import { expect, it } from 'vitest';\nit('fails deliberately', () => { expect(1 + 1).toBe(3); });\n";

describe("runner: test-unit keeps the real exit code and writes its report", () => {
  processLevel("[FO-19-67] a deliberately failing test makes test-unit exit with vitest's own exit code and the report records the failure", () => {
    const pkg = fixturePackage({ "pass.test.mjs": PASSING, "fail.test.mjs": FAILING });
    const reports = scratchDir("vsp-it-reports-");
    const direct = spawnSync(process.execPath, [join(pkg, "node_modules", "vitest", "vitest.mjs"), "run"], { cwd: pkg, encoding: "utf8" });
    const r = runner(["test-unit", "--package", pkg, "--report-dir", reports]);
    expect(direct.status).not.toBe(0);
    expect(r.code).toBe(direct.status);
    const report = JSON.parse(readFileSync(join(reports, "vitest-unit.json"), "utf8")) as { numFailedTests: number; numPassedTests: number; success: boolean; vsp: { exitCode: number; target: string } };
    expect(report).toMatchObject({ numFailedTests: 1, numPassedTests: 1, success: false, vsp: { exitCode: r.code, target: "test-unit" } });
    // GNU make reports any failing recipe as exit 2; it is still non-zero.
    const viaMake = make(["test-unit", `ARGS=--package ${pkg} --report-dir ${reports}`]);
    expect(viaMake.code).not.toBe(0);
  });

  processLevel("[FO-19-67] a run whose vitest crashes before writing its report exits non-zero, and no count comes from the passing report an earlier run left behind", () => {
    const pkg = fixturePackage({ "pass.test.mjs": PASSING });
    const reports = scratchDir("vsp-it-reports-");
    const label = basename(pkg);
    const perPackage = join(reports, `vitest-unit-${label}.json`);
    expect(runner(["test-unit", "--package", pkg, "--report-dir", reports]).code).toBe(0);
    expect(JSON.parse(readFileSync(perPackage, "utf8"))).toMatchObject({ numTotalTests: 1, numPassedTests: 1, success: true });

    // The package's vitest config now throws: vitest exits non-zero without writing a report.
    writeFileSync(join(pkg, "vitest.config.mjs"), "throw new Error('vitest config broken on purpose');\n");
    const crashed = runner(["test-unit", "--package", pkg, "--report-dir", reports]);
    expect(crashed.code).not.toBe(0);
    expect(crashed.stderr).toMatch(/vitest wrote no JSON report/);
    expect(existsSync(perPackage), "the earlier per-package report is removed, not reused").toBe(false);
    const report = JSON.parse(readFileSync(join(reports, "vitest-unit.json"), "utf8")) as {
      numTotalTests: number;
      numPassedTests: number;
      numFailedTests: number;
      success: boolean;
      testResults: unknown[];
      vsp: { exitCode: number; missingReports: string[]; packages: { counts: unknown; reportMissing: boolean; exitCode: number }[] };
    };
    expect(report).toMatchObject({ numTotalTests: 0, numPassedTests: 0, numFailedTests: 0, success: false, testResults: [], vsp: { exitCode: crashed.code, missingReports: [label] } });
    expect(report.vsp.packages).toEqual([expect.objectContaining({ counts: null, reportMissing: true, exitCode: crashed.code })]);
    expect(crashed.stdout).toMatch(new RegExp(`0/0 passed, 0 failed, 0 skipped; NO REPORT from ${label}`));
  });

  processLevel("[FO-19-67] a run refused before any vitest starts leaves no earlier vitest-unit.json behind", () => {
    const reports = scratchDir("vsp-it-reports-");
    writeFileSync(join(reports, "vitest-unit.json"), JSON.stringify({ numTotalTests: 3417, numPassedTests: 3417, success: true, vsp: { exitCode: 0 } }));
    // A package without node_modules: the runner cannot resolve vitest and refuses (usage error, exit 2).
    const pkg = scratchDir("vsp-it-unit-");
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "vsp-it-fixture-no-vitest", private: true, type: "module" }));
    const r = runner(["test-unit", "--package", pkg, "--report-dir", reports]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/vitest is not installed/);
    expect(existsSync(join(reports, "vitest-unit.json")), "the earlier merged report is removed").toBe(false);
  });

  processLevel("[FO-19-67] a package whose vitest exits 0 but leaves no report fails the run: missing evidence is never a pass", () => {
    const pkg = fixturePackage({ "pass.test.mjs": PASSING });
    // A global-setup teardown (it runs after the reporters) deletes the report vitest just wrote.
    writeFileSync(join(pkg, "vitest.config.mjs"), "export default { test: { include: ['test/*.test.mjs'], globalSetup: ['./teardown-removes-report.mjs'] } };\n");
    writeFileSync(
      join(pkg, "teardown-removes-report.mjs"),
      'import { rmSync } from "node:fs";\nexport default function setup() {\n  return () => {\n    const arg = process.argv.find((a) => a.startsWith("--outputFile.json="));\n    if (arg) rmSync(arg.slice("--outputFile.json=".length), { force: true });\n  };\n}\n',
    );
    const direct = spawnSync(process.execPath, [join(pkg, "node_modules", "vitest", "vitest.mjs"), "run"], { cwd: pkg, encoding: "utf8" });
    expect(direct.status, "vitest itself passes").toBe(0);
    const reports = scratchDir("vsp-it-reports-");
    const r = runner(["test-unit", "--package", pkg, "--report-dir", reports]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/vitest wrote no JSON report \(vitest exit 0\)/);
    const report = JSON.parse(readFileSync(join(reports, "vitest-unit.json"), "utf8")) as { success: boolean; numTotalTests: number; vsp: { exitCode: number; packages: { exitCode: number; reportMissing: boolean }[] } };
    expect(report).toMatchObject({ success: false, numTotalTests: 0, vsp: { exitCode: 1, packages: [{ exitCode: 0, reportMissing: true }] } });
  });

  processLevel("[FO-19-67] an all-passing run exits 0 and writes a successful vitest-unit.json", () => {
    const pkg = fixturePackage({ "pass.test.mjs": PASSING });
    const reports = scratchDir("vsp-it-reports-");
    const r = runner(["test-unit", "--package", pkg, "--report-dir", reports]);
    expect(r.code).toBe(0);
    const report = JSON.parse(readFileSync(join(reports, "vitest-unit.json"), "utf8")) as { numTotalTests: number; success: boolean; vsp: { exitCode: number; packages: { exitCode: number }[] } };
    expect(report).toMatchObject({ numTotalTests: 1, success: true, vsp: { exitCode: 0 } });
    expect(report.vsp.packages).toHaveLength(1);
    expect(make(["test-unit", `ARGS=--package ${pkg} --report-dir ${reports}`]).code).toBe(0);
  });
});

describe("runner: test-integration plans the Layer-2 run", () => {
  processLevel("[FO-19-69] SUITE and FILTER select files of the suite; a FILTER matching no file becomes a test-name pattern", () => {
    const files = JSON.parse(runner(["test-integration", "--suite", "_harness", "--filter", "health,postgres", "--dry-run"]).stdout.trim()) as { files: string[]; testNamePattern: string | null; env: string[]; argv: string[] };
    expect(files.files).toEqual(["test/integration/_harness/health.test.ts", "test/integration/_harness/postgres.test.ts"]);
    expect(files.testNamePattern).toBeNull();
    expect(files.env).toEqual(["NODE_EXTRA_CA_CERTS", "VSP_COMPOSE_PROJECT", "VSP_INTEGRATION", "VSP_LOCAL_STATE_DIR", "VSP_TEST_REPORT_DIR"]);
    expect(files.argv).toContain("vitest.integration.config.ts");
    const byName = JSON.parse(runner(["test-integration", "--suite", "_harness", "--filter", "SIP INVITE", "--dry-run"]).stdout.trim()) as { files: string[]; testNamePattern: string };
    expect(byName.testNamePattern).toBe("SIP INVITE");
    expect(byName.files.length).toBeGreaterThan(2);
    expect(runner(["test-integration", "--suite", "../etc", "--dry-run"]).code).toBe(2);
    expect(runner(["test-integration", "--suite", "no-such-suite", "--dry-run"]).code).toBe(2);
  });

  processLevel("[FO-19-69] test-integration removes an earlier run's reports first, and a run in which vitest writes no report exits non-zero", () => {
    const reports = scratchDir("vsp-it-reports-");
    const stale = { numTotalTestSuites: 9, numPassedTestSuites: 9, numFailedTestSuites: 0, numPendingTestSuites: 0, numTotalTests: 58, numPassedTests: 58, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, startTime: Date.now(), success: true, testResults: [] };
    writeFileSync(join(reports, "vitest-integration.json"), JSON.stringify(stale));
    writeFileSync(join(reports, "vitest-integration.emulation.json"), JSON.stringify({ schema: "vsp.layer2-emulation.v1", services: [], tests: [] }));
    // vitest refuses an unknown project before running anything, so it writes no report.
    const r = runner(["test-integration", "--suite", "_harness", "--filter", "guards", "--report-dir", reports, "--", "--project", "no-such-project"]);
    expect(r.code).not.toBe(0);
    expect(existsSync(join(reports, "vitest-integration.json")), "stale report removed").toBe(false);
    expect(existsSync(join(reports, "vitest-integration.emulation.json")), "stale emulation summary removed").toBe(false);
    expect(r.stderr).toMatch(/vitest wrote no JSON report/);
    expect(r.stdout).toMatch(/report NOT WRITTEN; exit [1-9]/);
  });

  processLevel("[FO-19-69][FO-16-23] a failing Layer-2 test makes test-integration exit with vitest's own exit code; the report it writes records the failure and the emulation labels of the service used", () => {
    const { suite, file } = probeSuite([
      'import { expect } from "vitest";',
      'import { layer2 } from "../_harness/layer2.js";',
      'const it = layer2(["postgres"]);',
      'it("probe that passes against postgres", () => { expect(1 + 1).toBe(2); });',
      'it("probe that fails deliberately against postgres", () => { expect(1 + 1).toBe(3); });',
    ]);
    const probeEnv = { VSP_LAYER2_PROBE: "1" };
    const direct = vitestProbe(file);
    expect(direct.status, "vitest itself fails the probe").toBe(1);

    const reports = scratchDir("vsp-it-reports-");
    const r = runner(["test-integration", "--suite", suite, "--report-dir", reports], probeEnv);
    expect(r.code, `test-integration exit code (vitest itself exited ${direct.status})`).toBe(direct.status);
    expect(r.stdout).toMatch(/test-integration: 1\/2 passed, 1 failed, 0 skipped; report .*vitest-integration\.json; exit 1/);
    const report = JSON.parse(readFileSync(join(reports, "vitest-integration.json"), "utf8")) as {
      numTotalTests: number;
      numPassedTests: number;
      numFailedTests: number;
      success: boolean;
      testResults: { assertionResults: { title: string; status: string; meta: { layer?: string; emulated?: EmulationLabel[] } }[] }[];
    };
    expect(report).toMatchObject({ numTotalTests: 2, numPassedTests: 1, numFailedTests: 1, success: false });

    // The labels in the report are the compose labels of the service the tests used (FO-16-23): what
    // postgres stands in for and what a passing test against it does not prove.
    const compose = YAML.parse(readFileSync(join(REPO_ROOT, "deploy", "local", "services", "core.compose.yaml"), "utf8")) as { services: Record<string, { image: string; labels: Record<string, string> }> };
    const pg = compose.services.postgres;
    const expected: EmulationLabel = {
      service: "postgres",
      image: pg?.image ?? "",
      emulates: pg?.labels["io.vsp.emulates"] ?? "",
      protocol: pg?.labels["io.vsp.protocol"] ?? "",
      notEmulated: pg?.labels["io.vsp.not-emulated"] ?? "",
    };
    expect(expected.emulates.length > 0 && expected.notEmulated.length > 0 && expected.protocol.length > 0).toBe(true);
    const assertions = report.testResults.flatMap((t) => t.assertionResults);
    expect(assertions.map((a) => [a.title, a.status, a.meta.layer]).sort()).toEqual([
      ["probe that fails deliberately against postgres", "failed", "L2"],
      ["probe that passes against postgres", "passed", "L2"],
    ]);
    for (const a of assertions) expect(a.meta.emulated, a.title).toEqual([expected]);
    const emulation = JSON.parse(readFileSync(join(reports, "vitest-integration.emulation.json"), "utf8")) as { services: { label: EmulationLabel; tests: number; passed: number; failed: number }[] };
    expect(emulation.services).toEqual([{ label: expected, tests: 2, passed: 1, failed: 1 }]);

    // Through make: GNU make turns the failing recipe into exit 2, still non-zero.
    const viaMake = make(["test-integration", `SUITE=${suite}`, `ARGS=--report-dir ${reports}`], probeEnv);
    expect(viaMake.code).not.toBe(0);
    expect(JSON.parse(readFileSync(join(reports, "vitest-integration.json"), "utf8"))).toMatchObject({ numFailedTests: 1, success: false });
  });

  processLevel("[FO-19-69][FO-16-23] a run in which vitest writes its JSON report but no emulation summary exits non-zero and names the missing summary", () => {
    const { suite } = probeSuite([
      'import { expect } from "vitest";',
      'import { layer2 } from "../_harness/layer2.js";',
      'const it = layer2(["postgres"]);',
      'it("probe that passes against postgres", () => { expect(1 + 1).toBe(2); });',
    ]);
    const reports = scratchDir("vsp-it-reports-");
    // A --reporter on the command line replaces the configured reporters, the emulation reporter
    // included: vitest writes its JSON report and passes, and nothing writes the emulation summary.
    const r = runner(["test-integration", "--suite", suite, "--report-dir", reports, "--", "--reporter", "json", "--outputFile", join(reports, "vitest-integration.json")], { VSP_LAYER2_PROBE: "1" });
    expect(JSON.parse(readFileSync(join(reports, "vitest-integration.json"), "utf8"))).toMatchObject({ numTotalTests: 1, numPassedTests: 1, success: true });
    expect(existsSync(join(reports, "vitest-integration.emulation.json"))).toBe(false);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/the emulation summary vitest-integration\.emulation\.json is missing/);
    expect(r.stdout).toMatch(/test-integration: 1\/1 passed, 0 failed, 0 skipped; report .*vitest-integration\.json; exit 1/);
  });

  processLevel("[FO-19-69] the Layer-2 config refuses to load without VSP_INTEGRATION=1", () => {
    const r = spawnSync(process.execPath, [join(PLATFORM_ROOT, "node_modules", "vitest", "vitest.mjs"), "run", "--config", "vitest.integration.config.ts", "test/integration/_harness/health.test.ts"], {
      cwd: PLATFORM_ROOT,
      env: { ...process.env, VSP_INTEGRATION: "" },
      encoding: "utf8",
    });
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/only with VSP_INTEGRATION=1/);
  });
});

describe("runner: check-runtime and check-deps (FO-03-14)", () => {
  function tempRoot(files: Record<string, string>): string {
    const dir = scratchDir("vsp-it-root-");
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    return dir;
  }

  processLevel("[FO-03-14] the repository pins a supported LTS runtime consistently (.nvmrc, engines, @types/node, image, CI) and runs on it", () => {
    const r = runner(["check-runtime", "--require-running", "--json"]);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.stdout.trim()) as { failed: number; checks: { check: string; verdict: string }[] };
    expect(report.failed).toBe(0);
    for (const c of ["nvmrc-exact", "lts-line", "not-eol", "engines", "types-node", "image", "ci-node", "running"]) expect(report.checks.map((x) => x.check)).toContain(c);
  });

  processLevel("[FO-03-14] a non-LTS line, an end-of-life date or an engines range admitting another major fails the check", () => {
    const odd = tempRoot({ ".nvmrc": "23.11.0\n", "package.json": JSON.stringify({ engines: { node: ">=23 <24" } }) });
    expect(runner(["check-runtime", "--root", odd]).stdout).toMatch(/FAIL lts-line: Node\.js 23 is not an LTS line/);
    expect(runner(["check-runtime", "--root", odd]).code).toBe(1);
    expect(runner(["check-runtime", "--today", "2027-05-01"]).stdout).toMatch(/FAIL not-eol: Node\.js 22 reached end of life on 2027-04-30/);
    const wide = tempRoot({ ".nvmrc": "22.22.0\n", "package.json": JSON.stringify({ engines: { node: ">=22.12" } }) });
    expect(runner(["check-runtime", "--root", wide]).stdout).toMatch(/FAIL engines: .*admits a Node\.js major other than 22/);
    const inexact = tempRoot({ ".nvmrc": "22\n", "package.json": "{}" });
    expect(runner(["check-runtime", "--root", inexact]).code).toBe(1);
  });

  processLevel("[FO-03-14] every setup-node step must read node-version-file: .nvmrc and set no node-version of its own", () => {
    const root = tempRoot({ ".nvmrc": "22.22.0\n", "package.json": "{}" });
    const wf = join(root, ".github", "workflows");
    mkdirSync(wf, { recursive: true });
    const step = (w: string) => `      - uses: actions/setup-node@v4\n        with:\n${w}`;
    writeFileSync(join(wf, "a.yml"), `jobs:\n  t:\n    steps:\n${step("          node-version-file: package.json\n")}`);
    writeFileSync(join(wf, "b.yml"), `jobs:\n  t:\n    steps:\n${step("          node-version-file: .nvmrc\n")}${step("          node-version: 22\n")}`);
    writeFileSync(join(wf, "c.yml"), `jobs:\n  t:\n    steps:\n${step("          node-version-file: .nvmrc\n          node-version: 24\n")}`);
    writeFileSync(join(wf, "d.yml"), `jobs:\n  t:\n    steps:\n${step("          node-version-file: .nvmrc\n")}`);
    const r = runner(["check-runtime", "--root", root, "--json"]);
    expect(r.code).toBe(1);
    const ci = (JSON.parse(r.stdout.trim()) as { checks: { check: string; verdict: string; detail: string }[] }).checks.filter((c) => c.check === "ci-node");
    expect(ci.map((c) => [c.verdict, c.detail.split(":")[0]])).toEqual([
      ["FAIL", ".github/workflows/a.yml"],
      ["FAIL", ".github/workflows/b.yml"],
      ["FAIL", ".github/workflows/c.yml"],
      ["PASS", ".github/workflows/d.yml"],
    ]);
    expect(ci[1]?.detail).toMatch(/1 of 2 setup-node step/);
  });

  processLevel("[WP-03] check-deps --inventory hands over every direct dependency with its locked version and licence, the LiveKit Agents set in lockstep", () => {
    const r = runner(["check-deps", "--inventory", "--json"]);
    expect(r.code, r.stderr).toBe(0);
    const inv = JSON.parse(r.stdout.trim()) as { incomplete: number; entries: { importer: string; name: string; specifier: string; version: string | null; installed: string | null; licence: string | null; planned: boolean; lockstep: boolean }[] };
    expect(inv.incomplete).toBe(0);
    const media = inv.entries.filter((e) => e.importer === "media");
    for (const name of ["@livekit/agents", "@livekit/agents-plugin-silero", "@livekit/agents-plugin-livekit", "@livekit/rtc-node", "livekit-server-sdk", "onnxruntime-node"]) {
      const e = media.find((x) => x.name === name);
      expect(e, name).toMatchObject({ planned: true });
      expect(e?.version, name).toMatch(/^\d+\.\d+\.\d+$/);
      expect(e?.installed, name).toBe(e?.version);
      expect(e?.licence, name).toMatch(/^[A-Za-z0-9.+-]+( (OR|AND) [A-Za-z0-9.+-]+)*$/);
    }
    // Transitive packages whose licence must be recorded are listed too (pnpm licenses), e.g. the
    // on-device inference package @livekit/agents pulls in, which carries a model licence.
    const notable = (JSON.parse(r.stdout.trim()) as { transitiveNotable: { name: string; licence: string }[] | null }).transitiveNotable;
    expect(notable).not.toBeNull();
    expect(notable?.find((n) => n.name === "@livekit/local-inference")?.licence).toMatch(/LicenseRef-LiveKit-Model/);
    const lockstep = media.filter((e) => e.lockstep);
    expect(lockstep).toHaveLength(3);
    expect(new Set(lockstep.map((e) => e.version)).size).toBe(1);
    for (const e of inv.entries.filter((x) => !x.specifier.startsWith("workspace:"))) expect(e.version, `${e.importer} ${e.name}`).toBe(e.specifier);
  });

  processLevel("[FO-03-14] check-deps passes on the workspace and fails on a range specifier or a missing planned dependency", () => {
    const ok = runner(["check-deps", "--json"]);
    expect(ok.code).toBe(0);
    const ranged = tempRoot({ "package.json": JSON.stringify({ devDependencies: { typescript: "^6.0.3" } }), "pnpm-lock.yaml": "lockfileVersion: '9.0'\nimporters:\n  .: {}\n" });
    const r = runner(["check-deps", "--root", ranged]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/FAIL exact: \.: typescript "\^6\.0\.3" is not an exact version/);
    expect(r.stdout).toMatch(/FAIL planned: workspace package media missing/);

    // Installed copies must match the lockfile and declare a licence.
    const drift = tempRoot({
      "package.json": JSON.stringify({ devDependencies: { "left-pad": "1.3.0", "right-pad": "1.0.1" } }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\nimporters:\n  .:\n    devDependencies:\n      left-pad:\n        specifier: 1.3.0\n        version: 1.3.0\n      right-pad:\n        specifier: 1.0.1\n        version: 1.0.1\n",
    });
    for (const [name, manifest] of [
      ["left-pad", { name: "left-pad", version: "1.2.0", license: "WTFPL" }],
      ["right-pad", { name: "right-pad", version: "1.0.1" }],
    ] as const) {
      mkdirSync(join(drift, "node_modules", name), { recursive: true });
      writeFileSync(join(drift, "node_modules", name, "package.json"), JSON.stringify(manifest));
    }
    const d = runner(["check-deps", "--root", drift]);
    expect(d.code).toBe(1);
    expect(d.stdout).toMatch(/FAIL installed: \.: left-pad installed 1\.2\.0 differs from the locked 1\.3\.0/);
    expect(d.stdout).toMatch(/FAIL licence: \.: right-pad@1\.0\.1 declares no licence/);
    expect(runner(["check-deps", "--root", drift, "--inventory"]).code).toBe(1);
  });
});

describe("runner: up and down against the real Docker engine", () => {
  /**
   * A throwaway compose project (entry file plus one services/probe.compose.yaml fragment) in a scratch
   * directory, with its own state and evidence directories. The image is the valkey image the core
   * composition already pulled, so nothing is downloaded.
   */
  function throwawayProject(prefix: string, fragment: (image: string) => string[]) {
    const project = `vsp-it-${uniqueName(prefix).replace(/[^a-z0-9-]/g, "")}`;
    const work = scratchDir("vsp-it-compose-");
    mkdirSync(join(work, "services"));
    writeFileSync(join(work, "compose.yaml"), `name: vsp-it-${prefix}\n`);
    const image = execFileSync("docker", ["inspect", "--format", "{{.Config.Image}}", `${process.env.VSP_COMPOSE_PROJECT ?? "vsp-local"}-valkey-1`], { encoding: "utf8" }).trim();
    writeFileSync(join(work, "services", "probe.compose.yaml"), [...fragment(image), ""].join("\n"));
    const env = { VSP_COMPOSE_PROJECT: project, VSP_COMPOSE_DIR: work, VSP_LOCAL_STATE_DIR: join(work, "state"), VSP_EVIDENCE_DIR: join(work, "evidence") };
    const list = (what: "volume" | "ps") =>
      execFileSync("docker", what === "volume" ? ["volume", "ls", "--quiet", "--filter", `label=com.docker.compose.project=${project}`] : ["ps", "--all", "--quiet", "--filter", `label=com.docker.compose.project=${project}`], { encoding: "utf8" })
        .split("\n")
        .filter((l) => l.trim() !== "");
    // The record written by the most recent command: records are never overwritten, so take the new file.
    const seen = new Set<string>();
    const lastRecord = (action: string) => {
      const files = readdirSync(join(work, "evidence")).filter((f) => f.startsWith(`local-${action}-`) && !seen.has(f));
      expect(files, `exactly one new ${action} record`).toHaveLength(1);
      seen.add(files[0] ?? "");
      return JSON.parse(readFileSync(join(work, "evidence", files[0] ?? ""), "utf8")) as Record<string, unknown>;
    };
    return { project, env, volumes: () => list("volume"), containers: () => list("ps"), lastRecord };
  }

  withDocker("[FO-19-64] down removes every container; volumes only with --purge; audit volumes only with --purge-audit; each teardown is recorded", () => {
    const p = throwawayProject("runner", (image) => [
      "volumes:",
      "  audit-data:",
      "    labels: { io.vsp.data-class: audit }",
      "  cache-data:",
      "    labels: { io.vsp.data-class: cache }",
      "services:",
      "  probe:",
      `    image: ${image}`,
      "    profiles: [probe]",
      '    command: ["valkey-server", "--save", "", "--appendonly", "no"]',
      '    volumes: ["audit-data:/audit", "cache-data:/cache"]',
      "    healthcheck:",
      '      test: ["CMD-SHELL", "valkey-cli ping | grep -q PONG"]',
      "      interval: 1s",
      "      retries: 30",
    ]);
    const { project, env, volumes, containers, lastRecord } = p;
    try {
      const up = make(["up", "PROFILE=probe", "TIMEOUT=120"], env);
      expect(up.code, up.stderr).toBe(0);
      expect(lastRecord("up")).toMatchObject({ action: "up", project, profiles: ["probe"], exitCode: 0 });
      expect(containers()).toHaveLength(1);
      expect(volumes()).toHaveLength(2);

      expect(make(["down"], env).code).toBe(0);
      expect(containers()).toEqual([]);
      expect(volumes()).toHaveLength(2);
      expect(lastRecord("down")).toMatchObject({ purge: false, containersRemaining: 0, removedVolumes: [] });

      // GNU make imports environment variables as make variables: PURGE and PURGE_AUDIT exported in the
      // shell must not turn a plain `make down` into a purge. Only command-line assignments count.
      const exported = make(["down"], { ...env, PURGE: "1", PURGE_AUDIT: "1" });
      expect(exported.code).toBe(0);
      expect(exported.stderr).toMatch(/down: ignoring PURGE PURGE_AUDIT from the environment/);
      expect(volumes(), "both volumes kept, audit evidence included").toHaveLength(2);
      expect(lastRecord("down")).toMatchObject({ purge: false, purgeAudit: false, removedVolumes: [] });

      expect(make(["up", "PROFILE=probe", "TIMEOUT=120"], env).code).toBe(0);
      lastRecord("up");
      expect(make(["down", "PURGE=1"], { ...env, PURGE_AUDIT: "1" }).code).toBe(0);
      expect(containers()).toEqual([]);
      expect(volumes(), "the exported PURGE_AUDIT does not reach the audit volume").toEqual([`${project}_audit-data`]);
      expect(lastRecord("down")).toMatchObject({ purge: true, purgeAudit: false, auditPurgeRefused: true, removedVolumes: [`${project}_cache-data`] });

      expect(make(["down", "PURGE=1", "PURGE_AUDIT=1"], env).code).toBe(0);
      expect(containers()).toEqual([]);
      expect(volumes()).toEqual([]);
      expect(lastRecord("down")).toMatchObject({ purge: true, purgeAudit: true, auditPurgeRefused: false, removedVolumes: [`${project}_audit-data`], containersRemaining: 0, exitCode: 0 });
    } finally {
      runner(["down", "--purge-audit"], env);
    }
  });

  withDocker("[FO-19-63][FO-16-23] up exits non-zero and records the exit code when a service never becomes healthy, and the Layer-2 harness refuses to run against it", () => {
    const { project, env, containers, volumes, lastRecord } = throwawayProject("sick", (image) => [
      "services:",
      "  sick:",
      `    image: ${image}`,
      "    profiles: [sick]",
      '    command: ["valkey-server", "--save", "", "--appendonly", "no"]',
      "    healthcheck:",
      '      test: ["CMD", "false"]',
      "      interval: 1s",
      "      timeout: 1s",
      "      retries: 2",
      "      start_period: 0s",
    ]);
    try {
      const direct = runner(["up", "--profile", "sick", "--timeout", "60"], env);
      expect(direct.code, "the runner returns compose's own non-zero exit code").not.toBe(0);
      expect(direct.stderr).toMatch(/service sick: state=running health=unhealthy/);
      expect(direct.stdout).toMatch(new RegExp(`up: FAILED \\(exit ${direct.code}\\)`));
      expect(lastRecord("up")).toMatchObject({ action: "up", profiles: ["sick"], exitCode: direct.code, services: [expect.objectContaining({ service: "sick", state: "running", health: "unhealthy" })] });

      const viaMake = make(["up", "PROFILE=sick", "TIMEOUT=60"], env);
      expect(viaMake.code, "GNU make reports the failing recipe as non-zero").not.toBe(0);
      const second = lastRecord("up");
      expect(second.exitCode).not.toBe(0);
      expect(second.exitCode).toBe(direct.code);

      // The Layer-2 global setup waits for health and then fails the run (nothing is skipped) while a
      // container of the project stays unhealthy.
      const { file } = probeSuite([
        'import { expect } from "vitest";',
        'import { layer2 } from "../_harness/layer2.js";',
        'const it = layer2.withoutServices("probe: global setup must refuse an unhealthy composition first");',
        'it("probe body that must not run", () => { expect(1).toBe(1); });',
      ]);
      const harness = vitestProbe(file, { VSP_COMPOSE_PROJECT: project, VSP_HEALTH_TIMEOUT_MS: "3000" });
      const output = `${harness.stdout}${harness.stderr}`;
      expect(harness.status, output).not.toBe(0);
      expect(output).toMatch(/services not healthy after 3000 ms: sick=unhealthy/);
      expect(output).not.toMatch(/Tests\s+1 passed/);
    } finally {
      runner(["down", "--purge-audit"], env);
    }
    expect(containers()).toEqual([]);
    expect(volumes()).toEqual([]);
  });

  processLevel("[FO-19-63] up refuses an unknown profile and an invalid project name before touching Docker state", () => {
    expect(runner(["up", "--profile", "no-such-profile"]).code).toBe(2);
    expect(runner(["up", "--profile", "core"], { VSP_COMPOSE_PROJECT: "Not Valid" }).code).toBe(2);
  });
});
