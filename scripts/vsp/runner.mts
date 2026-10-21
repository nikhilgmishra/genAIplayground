/**
 * Single entry point for the local composition and the test layers (prompt section 19; FO-19-63,
 * FO-19-64, FO-19-67, FO-19-69, FO-03-14). Runs on Node 22 directly (`node scripts/vsp/runner.mts`,
 * type stripping); the Makefile is a thin wrapper around it.
 *
 *   up [--profile core,media] [--timeout s]       start the Layer-2 composition and wait for health
 *   down [--purge] [--purge-audit]                stop it; volumes only with --purge, audit volumes only with --purge-audit
 *   ps                                            services, state, health and published ports
 *   logs [service] [--tail n]                     container logs
 *   test-unit [--package dir]... [--report-dir d] [-- vitest args]
 *                                                 Layer 1 unit/property tests of every workspace package with tests;
 *                                                 writes <report-dir>/vitest-unit.json; exit code = vitest exit code
 *                                                 (a package whose vitest writes no report fails and adds no counts)
 *   test-integration [--suite name] [--filter a,b] [--report-dir d] [--dry-run] [-- vitest args]
 *                                                 Layer 2: platform/test/integration/<suite> against the running composition;
 *                                                 writes <report-dir>/vitest-integration.json; exit code = vitest exit code
 *                                                 (non-zero when vitest writes no report); earlier reports are removed first
 *   check-runtime [--today YYYY-MM-DD] [--require-running] [--json]
 *                                                 the pinned Node.js runtime is a supported LTS line everywhere it is pinned
 *   check-deps [--json] [--inventory]             every manifest pins exact versions; the planned dependency set is present,
 *                                                 installed at the locked versions and licensed; --inventory prints every
 *                                                 direct dependency with locked version and licence (hand-off to docs/INVENTORY.md)
 *   ws <typecheck|lint|test>                      package-local task that also works for skeleton packages without sources
 *
 * No command calls a billable endpoint (OPS-05). Exit codes are the real exit codes of the tools run
 * (GNU make itself reports any failing recipe as 2).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve } from "node:path";
import { downMain } from "./down.mts";
import { composeBaseArgs, composeContext, composePs, err, gitCommit, lastValue, out, parseFlags, REPO_ROOT, requireDocker, run, UsageError, upMain } from "./up.mts";

const DEFAULT_REPORT_DIR = join(REPO_ROOT, "evidence", "test-reports");

/* ------------------------------------------------------------------ workspace discovery */

export function workspacePackageDirs(root = REPO_ROOT): string[] {
  const text = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
  const globs: string[] = [];
  let inPackages = false;
  for (const line of text.split("\n")) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const m = /^\s+-\s+["']?([^"'#\s]+)["']?/.exec(line);
      if (m?.[1]) globs.push(m[1]);
      else if (/^\S/.test(line)) inPackages = false;
    }
  }
  const dirs: string[] = [];
  for (const g of globs) {
    if (g.endsWith("/*")) {
      const base = join(root, g.slice(0, -2));
      if (!existsSync(base)) continue;
      for (const d of readdirSync(base).sort()) if (existsSync(join(base, d, "package.json"))) dirs.push(join(base, d));
    } else if (existsSync(join(root, g, "package.json"))) {
      dirs.push(join(root, g));
    }
  }
  return dirs;
}

const SOURCE_DIRS = ["src", "test", "e2e"];
const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", ".data"]);

function walk(dir: string, accept: (f: string) => boolean, found: string[] = [], limit = Number.POSITIVE_INFINITY, skipDir: (name: string) => boolean = () => false): string[] {
  if (!existsSync(dir) || found.length >= limit) return found;
  for (const name of readdirSync(dir)) {
    if (found.length >= limit) break;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name) && !skipDir(name)) walk(p, accept, found, limit, skipDir);
    } else if (accept(p)) {
      found.push(p);
    }
  }
  return found;
}

const isSource = (f: string) => /\.(ts|tsx|mts|cts)$/.test(f) && !f.endsWith(".d.ts");
const isTest = (f: string) => /\.test\.(ts|tsx|mts|js|mjs)$/.test(f);

function sourcesOf(pkgDir: string, accept: (f: string) => boolean, limit = Number.POSITIVE_INFINITY): string[] {
  const found: string[] = [];
  for (const d of SOURCE_DIRS) walk(join(pkgDir, d), accept, found, limit);
  return found;
}

/** TypeScript files at the package root (vite.config.ts, vitest.config.ts, ...), which tsconfig includes too. */
function rootSources(pkgDir: string): string[] {
  return readdirSync(pkgDir)
    .filter((f) => isSource(f) && statSync(join(pkgDir, f)).isFile())
    .sort();
}

/** Resolves a package's binary (e.g. vitest, tsc, eslint) from the package's own dependencies. */
export function resolveBin(pkgDir: string, pkg: string, bin: string): string {
  const req = createRequire(join(pkgDir, "package.json"));
  let manifestPath: string;
  try {
    manifestPath = req.resolve(`${pkg}/package.json`);
  } catch {
    throw new UsageError(`${pkg} is not installed for ${relative(REPO_ROOT, pkgDir) || pkgDir} (run pnpm install)`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { bin?: string | Record<string, string> };
  const rel = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[bin];
  if (!rel) throw new UsageError(`${pkg} has no "${bin}" binary`);
  return join(dirname(manifestPath), rel);
}

function spawnNode(script: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv = process.env): number {
  const r = spawnSync(process.execPath, [script, ...args], { cwd, env, stdio: "inherit" });
  if (r.error) {
    err(`failed to start ${basename(script)}: ${r.error.message}`);
    return 127;
  }
  return r.status ?? 1;
}

/* ------------------------------------------------------------------ ws: package-local tasks */

function wsMain(argv: readonly string[]): number {
  const task = argv[0];
  const pkgDir = process.cwd();
  const name = (JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { name?: string }).name ?? basename(pkgDir);
  const sources = [...sourcesOf(pkgDir, isSource, 1), ...rootSources(pkgDir)];
  if (task === "typecheck") {
    if (sources.length === 0) {
      out(`SKIPPED ${name} typecheck: no TypeScript sources yet (skeleton package)`);
      return 0;
    }
    return spawnNode(resolveBin(pkgDir, "typescript", "tsc"), ["-p", "tsconfig.json", "--noEmit"], pkgDir);
  }
  if (task === "lint") {
    if (sources.length === 0) {
      out(`SKIPPED ${name} lint: no TypeScript sources yet (skeleton package)`);
      return 0;
    }
    const config = ["eslint.config.js", "eslint.config.mjs", "eslint.config.ts"].find((c) => existsSync(join(pkgDir, c)));
    if (!config) {
      // Fail closed: sources exist, so they must not go unlinted.
      err(`FAIL ${name} lint: sources exist but the package has no eslint.config.js (owner: the import-allowlist package, WP-06)`);
      return 1;
    }
    return spawnNode(resolveBin(pkgDir, "eslint", "eslint"), [...SOURCE_DIRS.filter((d) => existsSync(join(pkgDir, d))), ...rootSources(pkgDir)], pkgDir);
  }
  if (task === "test") {
    if (sourcesOf(pkgDir, isTest, 1).length === 0) {
      out(`SKIPPED ${name} test: no test files yet (skeleton package)`);
      return 0;
    }
    return spawnNode(resolveBin(pkgDir, "vitest", "vitest"), ["run", ...argv.slice(1)], pkgDir);
  }
  throw new UsageError("ws needs one of: typecheck, lint, test");
}

/* ------------------------------------------------------------------ test-unit */

interface VitestJson {
  numTotalTestSuites: number;
  numPassedTestSuites: number;
  numFailedTestSuites: number;
  numPendingTestSuites: number;
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
  numTodoTests: number;
  startTime: number;
  success: boolean;
  testResults: unknown[];
}

/** Vitest project selection per workspace package (by report label); packages not listed run their whole suite. */
const UNIT_ARGS: Record<string, string[]> = { platform: ["--project", "unit"] };

export function unitPackages(explicit: readonly string[]): string[] {
  if (explicit.length > 0) return explicit.map((p) => resolve(p));
  return workspacePackageDirs().filter((d) => sourcesOf(d, isTest, 1).length > 0);
}

const COUNT_FIELDS = [
  "numTotalTestSuites",
  "numPassedTestSuites",
  "numFailedTestSuites",
  "numPendingTestSuites",
  "numTotalTests",
  "numPassedTests",
  "numFailedTests",
  "numPendingTests",
  "numTodoTests",
  "startTime",
] as const;

/**
 * Reads a vitest JSON report written by THIS run. The caller removes the file before vitest starts,
 * so a file that is missing, unparsable or older than the spawn is never read as this run's
 * evidence (OPS-03): it yields null and the package counts as failed.
 */
export function readVitestJson(path: string, notBeforeMs = 0): VitestJson | null {
  try {
    if (statSync(path).mtimeMs < notBeforeMs) return null;
    const json = JSON.parse(readFileSync(path, "utf8")) as Partial<VitestJson>;
    if (COUNT_FIELDS.some((k) => typeof json[k] !== "number") || typeof json.success !== "boolean" || !Array.isArray(json.testResults)) return null;
    return json as VitestJson;
  } catch {
    return null;
  }
}

/** Removes a report left by an earlier run; a file that cannot be removed stops the run. */
function removeStaleReport(path: string): void {
  rmSync(path, { force: true });
  if (existsSync(path)) throw new UsageError(`cannot remove the earlier report ${path}`);
}

/** Report label per package directory: the path below the repository, so labels never collide. */
export function packageLabel(dir: string): string {
  const rel = relative(REPO_ROOT, dir);
  const base = rel === "" || rel.startsWith("..") ? basename(dir) : rel;
  return base.replace(/[^A-Za-z0-9._-]+/g, "-");
}

interface UnitPackageResult {
  package: string;
  dir: string;
  command: string[];
  exitCode: number;
  report: string;
  /** Counts from the report this run wrote; null when vitest wrote none (the package then failed). */
  counts: Omit<VitestJson, "testResults"> | null;
  reportMissing: boolean;
}

function testUnitMain(argv: readonly string[]): number {
  const f = parseFlags(argv, ["package", "report-dir"], []);
  if (f.positionals.length > 0) throw new UsageError(`unexpected argument ${f.positionals[0]}`);
  const reportDir = resolve(lastValue(f, "report-dir") ?? process.env.VSP_TEST_REPORT_DIR ?? DEFAULT_REPORT_DIR);
  mkdirSync(reportDir, { recursive: true });
  const path = join(reportDir, "vitest-unit.json");
  // The merged report of an earlier run must not survive a run that stops before writing its own.
  removeStaleReport(path);
  const packages = unitPackages(f.values.get("package") ?? []);
  if (packages.length === 0) throw new UsageError("no workspace package has unit tests");
  const startedAt = new Date().toISOString();
  const results: UnitPackageResult[] = [];
  const reports: (VitestJson | null)[] = [];
  let exitCode = 0;
  for (const dir of packages) {
    const short = relative(REPO_ROOT, dir) || dir;
    const label = packageLabel(dir);
    const report = join(reportDir, `vitest-unit-${label}.json`);
    const vitest = resolveBin(dir, "vitest", "vitest");
    const args = ["run", ...(UNIT_ARGS[label] ?? []), "--reporter=default", "--reporter=json", `--outputFile.json=${report}`, ...f.rest];
    removeStaleReport(report);
    out(`test-unit: ${short}: vitest ${args.join(" ")}`);
    const spawnedAt = Date.now();
    const code = spawnNode(vitest, args, dir, { ...process.env, VSP_TEST_REPORT_DIR: "" });
    const json = readVitestJson(report, spawnedAt - 1_000);
    reports.push(json);
    let counts: UnitPackageResult["counts"] = null;
    if (json) {
      const { testResults: _ignored, ...rest } = json;
      counts = rest;
    }
    results.push({ package: label, dir: short, command: ["vitest", ...args], exitCode: code, report: relative(reportDir, report), counts, reportMissing: json === null });
    if (code !== 0 && exitCode === 0) exitCode = code;
    if (!json) {
      err(`test-unit: ${short}: vitest wrote no JSON report (vitest exit ${code}); the package counts as failed and no counts are reported for it`);
      // A run whose evidence is missing is never a pass, even if vitest itself exited 0.
      if (exitCode === 0) exitCode = 1;
    }
  }
  const merged = mergeVitest(reports);
  const finishedAt = new Date().toISOString();
  const missing = results.filter((r) => r.reportMissing).map((r) => r.package);
  const summary = {
    ...merged,
    success: merged.success && exitCode === 0,
    vsp: {
      schema: "vsp.test-report.v1",
      target: "test-unit",
      layer: "L1",
      commit: gitCommit(),
      startedAt,
      finishedAt,
      exitCode,
      packages: results,
      missingReports: missing,
      note: "Layer 1 (unit/property, PGlite and LOCAL FIXTURES). Not Layer-2 or production evidence. Counts cover only reports written by this run.",
    },
  };
  writeFileSync(path, `${JSON.stringify(summary)}\n`);
  const missingNote = missing.length > 0 ? `; NO REPORT from ${missing.join(", ")}` : "";
  out(`test-unit: ${merged.numPassedTests}/${merged.numTotalTests} passed, ${merged.numFailedTests} failed, ${merged.numPendingTests} skipped${missingNote}; report ${relative(REPO_ROOT, path) || path}; exit ${exitCode}`);
  return exitCode;
}

export function mergeVitest(reports: readonly (VitestJson | null)[]): VitestJson {
  const acc: VitestJson = {
    numTotalTestSuites: 0,
    numPassedTestSuites: 0,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    numTotalTests: 0,
    numPassedTests: 0,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    startTime: Date.now(),
    success: reports.length > 0,
    testResults: [],
  };
  for (const r of reports) {
    if (!r) {
      acc.success = false;
      continue;
    }
    acc.numTotalTestSuites += r.numTotalTestSuites;
    acc.numPassedTestSuites += r.numPassedTestSuites;
    acc.numFailedTestSuites += r.numFailedTestSuites;
    acc.numPendingTestSuites += r.numPendingTestSuites;
    acc.numTotalTests += r.numTotalTests;
    acc.numPassedTests += r.numPassedTests;
    acc.numFailedTests += r.numFailedTests;
    acc.numPendingTests += r.numPendingTests;
    acc.numTodoTests += r.numTodoTests;
    acc.startTime = Math.min(acc.startTime, r.startTime);
    acc.success = acc.success && r.success;
    acc.testResults.push(...r.testResults);
  }
  return acc;
}

/* ------------------------------------------------------------------ test-integration */

const INTEGRATION_ROOT = join(REPO_ROOT, "platform", "test", "integration");
const INTEGRATION_REPORT = "vitest-integration.json";
const INTEGRATION_EMULATION_REPORT = "vitest-integration.emulation.json";
const SUITE_RE = /^[_a-z][a-z0-9_-]{0,40}$/;
/** Throwaway probe directories the harness self-tests create; never part of a planned run. */
export const PROBE_DIR_RE = /^guard-probe-/;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface IntegrationPlan {
  cwd: string;
  argv: string[];
  env: Record<string, string>;
  files: string[];
  testNamePattern: string | null;
}

/**
 * Builds the vitest invocation. FILTER items match test file paths inside the suite (substring); when
 * no file matches any item, they are used as a test-name pattern instead.
 */
export function planIntegration(opts: { suite?: string | undefined; filter?: string | undefined; reportDir: string; rest: readonly string[]; stateDir: string; project: string }): IntegrationPlan {
  if (opts.suite !== undefined && !SUITE_RE.test(opts.suite)) throw new UsageError(`invalid suite "${opts.suite}"`);
  const suiteDir = opts.suite ? join(INTEGRATION_ROOT, opts.suite) : INTEGRATION_ROOT;
  if (!existsSync(suiteDir)) throw new UsageError(`suite not found: ${relative(REPO_ROOT, suiteDir)}`);
  const all = walk(suiteDir, (p) => p.endsWith(".test.ts"), [], Number.POSITIVE_INFINITY, (name) => PROBE_DIR_RE.test(name))
    .map((p) => relative(join(REPO_ROOT, "platform"), p))
    .sort();
  if (all.length === 0) throw new UsageError(`suite ${relative(REPO_ROOT, suiteDir)} has no *.test.ts files`);
  const items = (opts.filter ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
  let files = all;
  let testNamePattern: string | null = null;
  if (items.length > 0) {
    const matched = all.filter((p) => items.some((i) => p.includes(i)));
    if (matched.length > 0) files = matched;
    else testNamePattern = items.map(escapeRegex).join("|");
  }
  const vitest = resolveBin(join(REPO_ROOT, "platform"), "vitest", "vitest");
  const argv = [vitest, "run", "--config", "vitest.integration.config.ts", ...files, ...(testNamePattern ? ["--testNamePattern", testNamePattern] : []), ...opts.rest];
  const env: Record<string, string> = {
    VSP_INTEGRATION: "1",
    VSP_TEST_REPORT_DIR: opts.reportDir,
    VSP_LOCAL_STATE_DIR: opts.stateDir,
    VSP_COMPOSE_PROJECT: opts.project,
    NODE_EXTRA_CA_CERTS: join(opts.stateDir, "tls", "ca.pem"),
  };
  return { cwd: join(REPO_ROOT, "platform"), argv, env, files, testNamePattern };
}

function testIntegrationMain(argv: readonly string[]): number {
  const f = parseFlags(argv, ["suite", "filter", "report-dir", "project", "state-dir"], ["dry-run"]);
  if (f.positionals.length > 0) throw new UsageError(`unexpected argument ${f.positionals[0]}`);
  const reportDir = resolve(lastValue(f, "report-dir") ?? process.env.VSP_TEST_REPORT_DIR ?? DEFAULT_REPORT_DIR);
  const ctx = composeContext({ project: lastValue(f, "project"), stateDir: lastValue(f, "state-dir") });
  const plan = planIntegration({
    suite: lastValue(f, "suite") ?? (process.env.SUITE || undefined),
    filter: lastValue(f, "filter") ?? (process.env.FILTER || undefined),
    reportDir,
    rest: f.rest,
    stateDir: ctx.stateDir,
    project: ctx.project,
  });
  if (f.booleans.has("dry-run")) {
    out(JSON.stringify({ cwd: relative(REPO_ROOT, plan.cwd), argv: plan.argv.slice(1), files: plan.files, testNamePattern: plan.testNamePattern, env: Object.keys(plan.env).sort() }));
    return 0;
  }
  // Reports of an earlier run are removed before anything can stop this one, so a refused or
  // crashed run never leaves a passing report behind in the report directory (OPS-03).
  mkdirSync(reportDir, { recursive: true });
  const reportPath = join(reportDir, INTEGRATION_REPORT);
  const emulationPath = join(reportDir, INTEGRATION_EMULATION_REPORT);
  removeStaleReport(reportPath);
  removeStaleReport(emulationPath);
  requireDocker();
  if (!existsSync(join(ctx.stateDir, "env"))) throw new UsageError(`no local composition state in ${relative(REPO_ROOT, ctx.stateDir)}: run make up PROFILE=core first`);
  if (composePs(ctx).length === 0) throw new UsageError(`compose project ${ctx.project} is not running: run make up PROFILE=core first`);
  out(`test-integration: vitest ${plan.argv.slice(1).join(" ")}`);
  const spawnedAt = Date.now();
  const r = spawnSync(process.execPath, plan.argv, { cwd: plan.cwd, env: { ...process.env, ...plan.env }, stdio: "inherit" });
  let code = r.error ? 127 : (r.status ?? 1);
  const json = readVitestJson(reportPath, spawnedAt - 1_000);
  const shown = relative(REPO_ROOT, reportPath) || reportPath;
  if (!json) {
    err(`test-integration: vitest wrote no JSON report (vitest exit ${code}); nothing from this run is evidence`);
    if (code === 0) code = 1;
  } else if (!existsSync(emulationPath)) {
    err(`test-integration: the emulation summary ${INTEGRATION_EMULATION_REPORT} is missing; the run does not say which services were emulated (FO-16-23)`);
    if (code === 0) code = 1;
  }
  const counts = json ? `${json.numPassedTests}/${json.numTotalTests} passed, ${json.numFailedTests} failed, ${json.numPendingTests} skipped; ` : "";
  out(`test-integration: ${counts}report ${json ? shown : "NOT WRITTEN"}; exit ${code}`);
  return code;
}

/* ------------------------------------------------------------------ check-runtime (FO-03-14) */

interface NodeLine {
  major: number;
  codename: string;
  start: string;
  lts: string | null;
  maintenance: string | null;
  end: string;
  planned?: boolean;
}

/**
 * Node.js release schedule (https://github.com/nodejs/Release, schedule.json), recorded 2026-10-19.
 * Odd majors are never LTS. Refresh this table when a new major is released; check-runtime warns
 * when it is older than a year.
 */
export const NODE_SCHEDULE: { asOf: string; source: string; lines: NodeLine[] } = {
  asOf: "2026-10-19",
  source: "https://github.com/nodejs/Release/blob/main/schedule.json",
  lines: [
    { major: 18, codename: "Hydrogen", start: "2022-04-19", lts: "2022-10-25", maintenance: "2023-10-18", end: "2025-04-30" },
    { major: 20, codename: "Iron", start: "2023-04-18", lts: "2023-10-24", maintenance: "2024-10-22", end: "2026-04-30" },
    { major: 21, codename: "", start: "2023-10-17", lts: null, maintenance: "2024-04-01", end: "2024-06-01" },
    { major: 22, codename: "Jod", start: "2024-04-24", lts: "2024-10-29", maintenance: "2025-10-21", end: "2027-04-30" },
    { major: 23, codename: "", start: "2024-10-16", lts: null, maintenance: "2025-04-01", end: "2025-06-01" },
    { major: 24, codename: "Krypton", start: "2025-05-06", lts: "2025-10-28", maintenance: "2026-10-20", end: "2028-04-30" },
    { major: 25, codename: "", start: "2025-10-15", lts: null, maintenance: "2026-04-01", end: "2026-06-01" },
    { major: 26, codename: "", start: "2026-04-22", lts: "2026-10-28", maintenance: "2027-10-20", end: "2029-04-30", planned: true },
  ],
};

type Verdict = "PASS" | "WARN" | "FAIL";
interface Check {
  check: string;
  verdict: Verdict;
  detail: string;
}

const DAY_MS = 86_400_000;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

function cmpSemver(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Evaluates simple space-separated comparator ranges such as ">=22.12 <23". */
export function satisfiesRange(version: readonly number[], range: string): boolean | null {
  const parts = range.trim().split(/\s+/);
  for (const p of parts) {
    const m = /^(>=|<=|>|<|=)?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(p);
    if (!m) return null;
    const op = m[1] ?? "=";
    const v = [Number(m[2]), Number(m[3] ?? 0), Number(m[4] ?? 0)];
    const c = cmpSemver(version, v);
    const ok = op === ">=" ? c >= 0 : op === ">" ? c > 0 : op === "<=" ? c <= 0 : op === "<" ? c < 0 : c === 0;
    if (!ok) return false;
  }
  return true;
}

export function checkRuntime(opts: { root: string; today: Date; requireRunning: boolean; runningVersion: string; schedule?: typeof NODE_SCHEDULE }): Check[] {
  const schedule = opts.schedule ?? NODE_SCHEDULE;
  const checks: Check[] = [];
  const add = (check: string, verdict: Verdict, detail: string) => checks.push({ check, verdict, detail });
  const nvmrcPath = join(opts.root, ".nvmrc");
  const pinned = existsSync(nvmrcPath) ? readFileSync(nvmrcPath, "utf8").trim().replace(/^v/, "") : "";
  const m = SEMVER.exec(pinned);
  if (!m) {
    add("nvmrc-exact", "FAIL", `.nvmrc must hold an exact version (x.y.z), found "${pinned}"`);
    return checks;
  }
  const version = [Number(m[1]), Number(m[2]), Number(m[3])];
  const major = version[0] ?? 0;
  add("nvmrc-exact", "PASS", `.nvmrc pins Node.js ${pinned}`);

  const line = schedule.lines.find((l) => l.major === major);
  const today = opts.today.toISOString().slice(0, 10);
  if (!line) add("lts-line", "FAIL", `Node.js ${major} is not in the recorded release schedule (as of ${schedule.asOf})`);
  else if (!line.lts) add("lts-line", "FAIL", `Node.js ${major} is not an LTS line (odd majors never are)`);
  else if (line.lts > today) add("lts-line", "FAIL", `Node.js ${major} enters LTS on ${line.lts}; it is not LTS on ${today}`);
  else {
    const phase = line.maintenance && line.maintenance <= today ? "maintenance LTS" : "active LTS";
    add("lts-line", "PASS", `Node.js ${major} "${line.codename}" is ${phase} on ${today}`);
  }
  if (line) {
    const daysLeft = Math.floor((Date.parse(`${line.end}T00:00:00Z`) - opts.today.getTime()) / DAY_MS);
    if (daysLeft <= 0) add("not-eol", "FAIL", `Node.js ${major} reached end of life on ${line.end}`);
    else if (daysLeft < 183) add("not-eol", "WARN", `Node.js ${major} reaches end of life on ${line.end} (${daysLeft} days): plan the move to the next LTS line`);
    else add("not-eol", "PASS", `Node.js ${major} is supported until ${line.end} (${daysLeft} days)`);
  }
  const scheduleAge = Math.floor((opts.today.getTime() - Date.parse(`${schedule.asOf}T00:00:00Z`)) / DAY_MS);
  if (scheduleAge > 365) add("schedule-fresh", "WARN", `the recorded release schedule is ${scheduleAge} days old; refresh NODE_SCHEDULE from ${schedule.source}`);

  // engines.node in every manifest that declares it must admit the pinned version and no other major.
  const manifests = [join(opts.root, "package.json"), ...workspacePackageDirsSafe(opts.root).map((d) => join(d, "package.json"))];
  for (const path of manifests) {
    if (!existsSync(path)) continue;
    const pkg = JSON.parse(readFileSync(path, "utf8")) as { engines?: { node?: string }; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const rel = relative(opts.root, path);
    const range = pkg.engines?.node;
    if (range !== undefined) {
      const ok = satisfiesRange(version, range);
      const otherMajorAdmitted = satisfiesRange([major + 1, 0, 0], range) !== false || satisfiesRange([major - 1, 99, 99], range) !== false;
      if (ok === null) add("engines", "FAIL", `${rel}: engines.node "${range}" is not a simple comparator range`);
      else if (!ok) add("engines", "FAIL", `${rel}: engines.node "${range}" excludes the pinned ${pinned}`);
      else if (otherMajorAdmitted) add("engines", "FAIL", `${rel}: engines.node "${range}" admits a Node.js major other than ${major}`);
      else add("engines", "PASS", `${rel}: engines.node "${range}" admits ${pinned} and only major ${major}`);
    }
    const typesNode = pkg.devDependencies?.["@types/node"] ?? pkg.dependencies?.["@types/node"];
    if (typesNode !== undefined) {
      const tm = /^(\d+)\./.exec(typesNode);
      if (Number(tm?.[1]) !== major) add("types-node", "FAIL", `${rel}: @types/node ${typesNode} does not match Node.js ${major}`);
      else add("types-node", "PASS", `${rel}: @types/node ${typesNode}`);
    }
  }
  const dockerfile = join(opts.root, "platform", "Dockerfile");
  if (existsSync(dockerfile)) {
    const dm = /ARG NODE_IMAGE=node:(\d+\.\d+\.\d+)/.exec(readFileSync(dockerfile, "utf8"));
    if (!dm) add("image", "FAIL", "platform/Dockerfile does not pin ARG NODE_IMAGE=node:<x.y.z>-...");
    else if (dm[1] !== pinned) add("image", "FAIL", `platform/Dockerfile pins node:${dm[1]}, .nvmrc pins ${pinned}`);
    else add("image", "PASS", `platform/Dockerfile base image node:${dm[1]}`);
  }
  const workflowsDir = join(opts.root, ".github", "workflows");
  if (existsSync(workflowsDir)) {
    for (const wf of readdirSync(workflowsDir).filter((f) => /\.ya?ml$/.test(f)).sort()) {
      const verdict = ciNodeVerdict(readFileSync(join(workflowsDir, wf), "utf8"));
      if (verdict) add("ci-node", verdict.verdict, `.github/workflows/${wf}: ${verdict.detail}`);
    }
  }
  if (opts.requireRunning) {
    const running = opts.runningVersion.replace(/^v/, "");
    if (running !== pinned) add("running", "FAIL", `running Node.js ${running} differs from the pinned ${pinned}`);
    else add("running", "PASS", `running Node.js ${running}`);
  }
  return checks;
}

interface WorkflowStep {
  uses?: unknown;
  with?: Record<string, unknown> | null;
}

/**
 * Every actions/setup-node step of a workflow must take its version from `node-version-file: .nvmrc`
 * and set no `node-version` of its own. Returns null for a workflow without setup-node.
 */
export function ciNodeVerdict(text: string): { verdict: Verdict; detail: string } | null {
  let doc: { jobs?: Record<string, { steps?: WorkflowStep[] | null } | null> | null } | null;
  try {
    doc = loadYaml().parse(text) as typeof doc;
  } catch (e) {
    return { verdict: "FAIL", detail: `not parseable YAML (${(e as Error).message.split("\n")[0]})` };
  }
  const steps = Object.values(doc?.jobs ?? {}).flatMap((job) => job?.steps ?? []);
  const setups = steps.filter((s) => typeof s?.uses === "string" && /^actions\/setup-node@/.test(s.uses));
  if (setups.length === 0) {
    return /setup-node@/.test(text) ? { verdict: "FAIL", detail: "mentions setup-node outside a job step the check can read" } : null;
  }
  const bad = setups.filter((s) => s.with?.["node-version"] !== undefined || s.with?.["node-version-file"] !== ".nvmrc");
  if (bad.length > 0) return { verdict: "FAIL", detail: `${bad.length} of ${setups.length} setup-node step(s) do not take the version from node-version-file: .nvmrc alone` };
  return { verdict: "PASS", detail: `${setups.length} setup-node step(s) read node-version-file: .nvmrc` };
}

function workspacePackageDirsSafe(root: string): string[] {
  return existsSync(join(root, "pnpm-workspace.yaml")) ? workspacePackageDirs(root) : [];
}

function report(checks: readonly Check[], json: boolean, title: string): number {
  const failed = checks.filter((c) => c.verdict === "FAIL").length;
  if (json) out(JSON.stringify({ check: title, failed, warnings: checks.filter((c) => c.verdict === "WARN").length, checks }));
  else {
    for (const c of checks) out(`${c.verdict.padEnd(4)} ${c.check}: ${c.detail}`);
    out(`${title}: ${failed === 0 ? "PASS" : "FAIL"} (${checks.length} checks, ${failed} failed)`);
  }
  return failed === 0 ? 0 : 1;
}

function checkRuntimeMain(argv: readonly string[]): number {
  const f = parseFlags(argv, ["today", "root"], ["require-running", "json"]);
  const todayArg = lastValue(f, "today");
  if (todayArg !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(todayArg)) throw new UsageError("--today must be YYYY-MM-DD");
  const today = todayArg ? new Date(`${todayArg}T00:00:00Z`) : new Date();
  const root = resolve(lastValue(f, "root") ?? REPO_ROOT);
  return report(checkRuntime({ root, today, requireRunning: f.booleans.has("require-running"), runningVersion: process.version }), f.booleans.has("json"), "check-runtime");
}

/* ------------------------------------------------------------------ check-deps */

const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/**
 * The planned dependency set (WP-03 deliverable; ADR-0018 decision 1.1 and open item 2): each entry
 * must be declared, exact-pinned, in the named workspace package.
 */
export const PLANNED_DEPENDENCIES: Record<string, readonly string[]> = {
  ".": ["dependency-cruiser"],
  media: [
    "@livekit/agents",
    "@livekit/agents-plugin-silero",
    "@livekit/agents-plugin-livekit",
    "@livekit/rtc-node",
    "livekit-server-sdk",
    "onnxruntime-node",
  ],
  platform: [
    "livekit-server-sdk",
    "openai",
    "@aws-sdk/client-bedrock-runtime",
    "@opentelemetry/sdk-node",
    "@opentelemetry/exporter-trace-otlp-proto",
    "@opentelemetry/exporter-metrics-otlp-proto",
    "pdfjs-dist",
    "mammoth",
    "@aws-sdk/client-sesv2",
    "@aws-sdk/client-ses",
    "@aws-sdk/client-sns",
    "@aws-sdk/client-athena",
    "@aws-sdk/client-glue",
    "@grpc/grpc-js",
    "avsc",
  ],
  console: ["@playwright/test", "@axe-core/playwright"],
  companion: ["@playwright/test", "@axe-core/playwright", "react"],
  "services/reference-business-api": ["fastify"],
};
/** Packages that must move in lockstep (the plugins declare an exact peer on @livekit/agents). */
const LOCKSTEP = ["@livekit/agents", "@livekit/agents-plugin-silero", "@livekit/agents-plugin-livekit"];

interface Lockfile {
  importers?: Record<string, Record<string, Record<string, { specifier: string; version: string }> | undefined>>;
}

function loadYaml(): { parse(text: string): unknown } {
  const req = createRequire(join(REPO_ROOT, "platform", "package.json"));
  return req("yaml") as { parse(text: string): unknown };
}

export function checkDeps(root: string): Check[] {
  const checks: Check[] = [];
  const add = (check: string, verdict: Verdict, detail: string) => checks.push({ check, verdict, detail });
  const dirs = [root, ...workspacePackageDirsSafe(root)];
  const lockPath = join(root, "pnpm-lock.yaml");
  const lock = existsSync(lockPath) ? (loadYaml().parse(readFileSync(lockPath, "utf8")) as Lockfile) : null;
  if (!lock) add("lockfile", "FAIL", "pnpm-lock.yaml missing");
  const awsVersions = new Map<string, string[]>();
  for (const dir of dirs) {
    const importer = relative(root, dir) || ".";
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
    let bad = 0;
    let total = 0;
    for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      for (const [name, spec] of Object.entries(pkg[section] ?? {})) {
        total += 1;
        if (section === "peerDependencies") continue;
        const workspace = spec === "workspace:*" && name.startsWith("@vsp/");
        if (!workspace && !EXACT.test(spec)) {
          bad += 1;
          add("exact", "FAIL", `${importer}: ${name} "${spec}" is not an exact version`);
        }
        if (name.startsWith("@aws-sdk/")) awsVersions.set(spec, [...(awsVersions.get(spec) ?? []), `${importer}:${name}`]);
        const locked = lock?.importers?.[importer]?.[section]?.[name];
        if (lock && section !== "peerDependencies" && (!locked || locked.specifier !== spec)) {
          bad += 1;
          add("lockfile", "FAIL", `${importer}: ${name} "${spec}" is not locked with the same specifier (run pnpm install)`);
        }
      }
    }
    if (bad === 0) add("exact", "PASS", `${importer}: ${total} dependencies exact-pinned and locked`);
    const declared = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    for (const required of PLANNED_DEPENDENCIES[importer] ?? []) {
      if (!(required in declared)) add("planned", "FAIL", `${importer}: planned dependency ${required} is missing`);
    }
    const lockstep = LOCKSTEP.filter((n) => n in declared).map((n) => declared[n]);
    if (lockstep.length > 0) {
      if (lockstep.length !== LOCKSTEP.length || new Set(lockstep).size !== 1) add("lockstep", "FAIL", `${importer}: ${LOCKSTEP.join(", ")} must all be declared at one version (found ${lockstep.join(", ")})`);
      else add("lockstep", "PASS", `${importer}: ${LOCKSTEP.join(", ")} at ${lockstep[0]}`);
    }
  }
  for (const [importer, required] of Object.entries(PLANNED_DEPENDENCIES)) {
    if (!dirs.some((d) => (relative(root, d) || ".") === importer)) add("planned", "FAIL", `workspace package ${importer} missing (planned: ${required.join(", ")})`);
  }
  if (awsVersions.size > 1) add("aws-sdk", "WARN", `@aws-sdk/* clients use ${awsVersions.size} versions (${[...awsVersions.keys()].join(", ")}); keep one to avoid duplicate cores`);
  else if (awsVersions.size === 1) add("aws-sdk", "PASS", `@aws-sdk/* clients at ${[...awsVersions.keys()][0]}`);
  // Installed direct dependencies: the version on disk is the locked one and a licence is declared.
  if (lock) {
    const direct = depsInventory(root, lock).filter((e) => !e.specifier.startsWith("workspace:"));
    const notInstalled = direct.filter((e) => e.installed === null);
    if (direct.length > 0 && notInstalled.length === direct.length) add("installed", "WARN", "dependencies are not installed; run pnpm install --frozen-lockfile to check installed versions and licences");
    else {
      // pnpm licenses lists every installed package; the direct-level licence warning is the fallback.
      const transitive = transitiveLicences(root);
      for (const e of direct) {
        const id = `${e.importer}: ${e.name}`;
        if (e.installed === null) add("installed", "FAIL", `${id} is locked at ${e.version ?? "?"} but not installed (run pnpm install --frozen-lockfile)`);
        else if (e.installed !== e.version) add("installed", "FAIL", `${id} installed ${e.installed} differs from the locked ${e.version ?? "?"}`);
        if (e.installed !== null && e.licence === null) add("licence", "FAIL", `${id}@${e.installed} declares no licence in its package.json`);
        else if (!transitive.ok && e.licence !== null && RESTRICTIVE_LICENCE.test(e.licence)) add("licence", "WARN", `${id}@${e.installed ?? "?"} is licensed ${e.licence}; record the obligation in docs/INVENTORY.md (WP-44)`);
      }
      const installedOk = direct.filter((e) => e.installed !== null && e.installed === e.version).length;
      const licensed = direct.filter((e) => e.licence !== null).length;
      add("installed", installedOk === direct.length ? "PASS" : "FAIL", `${installedOk}/${direct.length} direct dependencies installed at the locked version`);
      add("licence", licensed === direct.length ? "PASS" : "FAIL", `${licensed}/${direct.length} direct dependencies declare a licence (inventory: check-deps --inventory)`);
      if (!transitive.ok) add("licence-transitive", "WARN", `installed packages not listed (${transitive.reason})`);
      else {
        for (const n of transitive.notable) add("licence-transitive", "WARN", `${n.name}@${n.versions.join(",")} is licensed ${n.licence}; record the obligation in docs/INVENTORY.md (WP-44)`);
        add("licence-transitive", "PASS", `${transitive.total} installed packages listed by pnpm licenses; ${transitive.notable.length} carry a licence to record`);
      }
    }
  }
  return checks;
}

/** Licences whose obligations must be recorded before release (copyleft, source-available, none). */
const RESTRICTIVE_LICENCE = /\b(A?GPL|LGPL|SSPL|BUSL|EUPL|MPL|CDDL|EPL|UNLICENSED|SEE LICENSE)/i;

export interface InventoryEntry {
  importer: string;
  name: string;
  section: string;
  specifier: string;
  /** Locked version (pnpm-lock.yaml, peer suffix removed); null when not locked. */
  version: string | null;
  /** Version of the installed manifest; null when not installed. */
  installed: string | null;
  /** SPDX licence expression of the installed manifest; null when none is declared or not installed. */
  licence: string | null;
  planned: boolean;
  lockstep: boolean;
}

export interface NotableLicence {
  name: string;
  versions: string[];
  licence: string;
}

/**
 * Every installed package (direct and transitive) by licence, from `pnpm licenses list` (reads the
 * installed tree, no network); `notable` holds the packages whose licence must be recorded.
 */
export function transitiveLicences(root: string): { ok: true; total: number; notable: NotableLicence[] } | { ok: false; reason: string } {
  const r = run("pnpm", ["licenses", "list", "--json"], { cwd: root });
  if (r.code !== 0) return { ok: false, reason: `pnpm licenses list exited ${r.code}: ${(r.stderr || r.stdout).trim().split("\n")[0] ?? ""}` };
  let parsed: Record<string, { name: string; versions?: string[] }[]>;
  try {
    parsed = JSON.parse(r.stdout) as typeof parsed;
  } catch {
    return { ok: false, reason: "pnpm licenses list printed no JSON" };
  }
  const notable: NotableLicence[] = [];
  const names = new Set<string>();
  for (const [licence, pkgs] of Object.entries(parsed)) {
    for (const p of pkgs) {
      names.add(p.name);
      if (RESTRICTIVE_LICENCE.test(licence) || /LicenseRef-|Unknown/i.test(licence)) notable.push({ name: p.name, versions: p.versions ?? [], licence });
    }
  }
  return { ok: true, total: names.size, notable: notable.sort((a, b) => a.name.localeCompare(b.name)) };
}

function installedManifest(dir: string, name: string): { version: string | null; licence: string | null } | null {
  const path = join(dir, "node_modules", ...name.split("/"), "package.json");
  if (!existsSync(path)) return null;
  const pkg = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown; license?: unknown; licenses?: unknown };
  let licence: string | null = null;
  if (typeof pkg.license === "string" && pkg.license.trim() !== "") licence = pkg.license.trim();
  else if (pkg.license && typeof pkg.license === "object" && typeof (pkg.license as { type?: unknown }).type === "string") licence = (pkg.license as { type: string }).type;
  else if (Array.isArray(pkg.licenses)) {
    const types = pkg.licenses.map((l: unknown) => (l && typeof l === "object" ? (l as { type?: unknown }).type : undefined)).filter((t): t is string => typeof t === "string");
    licence = types.length > 0 ? types.join(" OR ") : null;
  }
  return { version: typeof pkg.version === "string" ? pkg.version : null, licence };
}

/**
 * Every direct dependency of every workspace package with its locked version, installed version and
 * declared licence: the pinned list handed to WP-44 for docs/INVENTORY.md (`check-deps --inventory`).
 */
export function depsInventory(root: string, lock?: Lockfile): InventoryEntry[] {
  const lockfile = lock ?? (loadYaml().parse(readFileSync(join(root, "pnpm-lock.yaml"), "utf8")) as Lockfile);
  const entries: InventoryEntry[] = [];
  for (const dir of [root, ...workspacePackageDirsSafe(root)]) {
    const importer = relative(root, dir) || ".";
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
    const planned = new Set(PLANNED_DEPENDENCIES[importer] ?? []);
    for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
      for (const [name, specifier] of Object.entries(pkg[section] ?? {})) {
        const locked = lockfile.importers?.[importer]?.[section]?.[name];
        const installed = installedManifest(dir, name);
        entries.push({
          importer,
          name,
          section,
          specifier,
          version: locked ? (locked.version.split("(")[0] ?? locked.version) : null,
          installed: installed?.version ?? null,
          licence: installed?.licence ?? null,
          planned: planned.has(name),
          lockstep: LOCKSTEP.includes(name),
        });
      }
    }
  }
  return entries.sort((a, b) => a.importer.localeCompare(b.importer) || a.name.localeCompare(b.name));
}

function inventoryMain(root: string, json: boolean): number {
  const entries = depsInventory(root);
  const incomplete = entries.filter((e) => e.version === null || e.installed === null || e.licence === null);
  const transitive = transitiveLicences(root);
  const notable = transitive.ok ? transitive.notable : null;
  if (json) out(JSON.stringify({ schema: "vsp.deps-inventory.v1", root: relative(REPO_ROOT, root) || ".", commit: gitCommit(), entries, incomplete: incomplete.length, transitiveNotable: notable, transitiveError: transitive.ok ? null : transitive.reason }));
  else {
    out("| Package | Dependency | Section | Locked version | Licence | Planned |");
    out("| --- | --- | --- | --- | --- | --- |");
    for (const e of entries) out(`| ${e.importer} | ${e.name} | ${e.section} | ${e.version ?? "NOT LOCKED"} | ${e.licence ?? (e.installed === null ? "NOT INSTALLED" : "NONE DECLARED")} | ${e.planned ? (e.lockstep ? "yes (lockstep)" : "yes") : ""} |`);
    out("");
    if (notable) {
      out("Installed packages (direct or transitive) whose licence must be recorded:");
      out("");
      out("| Package | Versions | Licence |");
      out("| --- | --- | --- |");
      for (const n of notable) out(`| ${n.name} | ${n.versions.join(", ")} | ${n.licence} |`);
    } else out(`Transitive licences not listed: ${transitive.ok ? "" : transitive.reason}`);
    out(`check-deps --inventory: ${entries.length} direct dependencies, ${incomplete.length} without a locked version, an installed copy or a licence`);
  }
  return incomplete.length === 0 ? 0 : 1;
}

function checkDepsMain(argv: readonly string[]): number {
  const f = parseFlags(argv, ["root"], ["json", "inventory"]);
  const root = resolve(lastValue(f, "root") ?? REPO_ROOT);
  if (f.booleans.has("inventory")) return inventoryMain(root, f.booleans.has("json"));
  return report(checkDeps(root), f.booleans.has("json"), "check-deps");
}

/* ------------------------------------------------------------------ ps / logs */

function psMain(argv: readonly string[]): number {
  const f = parseFlags(argv, ["project"], []);
  requireDocker();
  const ctx = composeContext({ project: lastValue(f, "project") });
  const rows = composePs(ctx);
  if (rows.length === 0) out(`no containers for project ${ctx.project}`);
  for (const e of rows) {
    const ports = (e.Publishers ?? []).filter((p) => (p.PublishedPort ?? 0) > 0).map((p) => `${p.URL}:${p.PublishedPort}->${p.TargetPort}/${p.Protocol}`);
    out(`${e.Service.padEnd(24)} ${e.State.padEnd(10)} ${(e.Health || "none").padEnd(10)} ${ports.join(" ")}`);
  }
  return 0;
}

function logsMain(argv: readonly string[]): number {
  const f = parseFlags(argv, ["project", "tail"], []);
  requireDocker();
  const ctx = composeContext({ project: lastValue(f, "project") });
  return run("docker", [...composeBaseArgs(ctx), "logs", "--no-color", "--tail", lastValue(f, "tail") ?? "200", ...f.positionals], { inherit: true }).code;
}

/* ------------------------------------------------------------------ main */

const COMMANDS: Record<string, (argv: readonly string[]) => number> = {
  up: upMain,
  down: downMain,
  ps: psMain,
  logs: logsMain,
  "test-unit": testUnitMain,
  "test-integration": testIntegrationMain,
  "check-runtime": checkRuntimeMain,
  "check-deps": checkDepsMain,
  ws: wsMain,
};

function usage(): string {
  const header = readFileSync(new URL(import.meta.url), "utf8").split("*/")[0] ?? "";
  return header
    .split("\n")
    .map((l) => l.replace(/^\s?\/?\*+ ?/, ""))
    .join("\n")
    .trim();
}

export function main(argv: readonly string[]): number {
  const [command, ...rest] = argv;
  if (command === undefined || command === "help" || command === "--help") {
    out(usage());
    return command === undefined ? 2 : 0;
  }
  const fn = COMMANDS[command];
  if (!fn) {
    err(`unknown command "${command}"\n\n${usage()}`);
    return 2;
  }
  try {
    return fn(rest);
  } catch (e) {
    if (e instanceof UsageError) {
      err(`${command}: ${e.message}`);
      return 2;
    }
    throw e;
  }
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));

