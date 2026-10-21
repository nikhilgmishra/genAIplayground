/*
 * dependency-cruiser rules (lint group: WP-06 then WP-07 in phase B, each phase integration package after).
 *
 * Generated at load time from the module register platform/architecture/modules.yaml, the same file the
 * ESLint rule vsp/module-boundaries (platform/eslint.config.js) and the architecture suite
 * (platform/test/architecture) read, so the three can never disagree about a boundary (FO-03-11, FO-06-24;
 * docs/ARCHITECTURE.md section 6.4). It adds what a per-file lint rule cannot see:
 *   - transitive reachability: a production entry point never reaches a fixture, a LOCAL FIXTURE adapter,
 *     the demo, the evaluation tooling or a test emulator through any chain of imports (OPS-04);
 *   - decision-gated technologies (FO-03-25, FO-08-17, FO-08-35, FO-23-08): no import of a gated package
 *     while its register entry has no Accepted ADR (`decision: null`).
 *
 * Run: npx depcruise --config .dependency-cruiser.cjs platform/src console/src (plus media/src and
 * companion/src once they exist); platform/test/architecture/depcruise.test.ts runs it in the unit suite.
 */
/* eslint-disable @typescript-eslint/no-require-imports -- dependency-cruiser loads this file as CommonJS */
const { readFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const { join } = require("node:path");

const YAML = createRequire(join(__dirname, "platform", "package.json"))("yaml");
const register = YAML.parse(readFileSync(join(__dirname, "platform", "architecture", "modules.yaml"), "utf8"));

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const FILE_EXT = /\.[cm]?[jt]sx?$/;
const SRC_EXT = "\\.[cm]?[jt]sx?$";
const isFile = (p) => FILE_EXT.test(p);
const entriesOf = (m) => (m.paths ?? [m.path]).map((p) => p.replace(/\/+$/, ""));
const allEntries = register.modules.flatMap((m) => entriesOf(m).map((p) => ({ id: m.id, p })));

/**
 * Register glob to a regular expression source over repository-relative paths. Only a leading `**\/`, a
 * trailing `/**` and `*` inside one segment are used by the register; dependency-cruiser refuses regular
 * expressions with nested quantifiers (safe-regex), so `**\/` becomes `(?:^|/)` rather than `(?:.*\/)?`.
 */
function globToRegExpSource(glob) {
  let g = glob;
  let prefix = "^";
  let suffix = "$";
  if (g.startsWith("**/")) {
    prefix = "(?:^|/)";
    g = g.slice(3);
  }
  if (g.endsWith("/**")) {
    suffix = "/";
    g = g.slice(0, -3);
  }
  if (g.includes("**")) throw new Error(`modules.yaml: unsupported glob ${glob}`);
  return `${prefix}${g.split("*").map((part) => esc(part).replace(/\\\?/g, "[^/]")).join("[^/]*")}${suffix}`;
}

/** Paths that belong to a module: its directories (minus nested modules) and its files. */
function memberRegex(m) {
  const alts = entriesOf(m).map((p) => {
    if (isFile(p)) return `${esc(p.replace(FILE_EXT, ""))}${SRC_EXT}`;
    const nested = allEntries
      .filter((e) => e.id !== m.id && e.p.startsWith(`${p}/`))
      .map((e) => {
        const rest = e.p.slice(p.length + 1);
        return isFile(rest) ? `${esc(rest.replace(FILE_EXT, ""))}${SRC_EXT}` : `${esc(rest)}/`;
      });
    return nested.length > 0 ? `${esc(p)}/(?!${nested.join("|")})` : `${esc(p)}/`;
  });
  return `^(?:${alts.join("|")})`;
}

const byId = new Map(register.modules.map((m) => [m.id, m]));
const member = (id) => {
  const m = byId.get(id);
  if (!m) throw new Error(`modules.yaml: unknown module id ${id}`);
  return memberRegex(m);
};
const ROOTS = `^(?:${register.roots.map((r) => globToRegExpSource(r).slice(1, -1)).join("|")})/`;
const TEST_SUPPORT = (register.testSupport ?? []).map(globToRegExpSource);
const ALL_MEMBERS = register.modules.map(memberRegex);

const moduleRules = register.modules
  .filter((m) => !(m.allow ?? []).includes("*"))
  .map((m) => ({
    name: `module-${m.id}`,
    severity: "error",
    comment: `${m.id} imports only ${["itself", ...(m.allow ?? []), ...(m.allowFiles ?? [])].join(", ")} (platform/architecture/modules.yaml)`,
    from: { path: memberRegex(m), pathNot: TEST_SUPPORT },
    to: {
      path: ROOTS,
      pathNot: [memberRegex(m), ...(m.allow ?? []).map(member), ...(m.allowFiles ?? []).map((f) => `^${esc(f.replace(FILE_EXT, ""))}${SRC_EXT}`)],
    },
  }));

const entryForbidden = [...(register.entryPointForbidden ?? []).map(member), "^platform/test/"];
const entryRules = (register.entryPoints ?? []).map((e) => ({
  name: `entry-point-${e.file.replace(/^.*\//, "").replace(FILE_EXT, "")}`,
  severity: "error",
  comment: `${e.file} never ${e.transitive ? "reaches" : "imports"} ${(register.entryPointForbidden ?? []).join(", ")} or a test emulator (OPS-04)`,
  from: { path: `^${esc(e.file)}$` },
  to: e.transitive ? { path: entryForbidden, reachable: true } : { path: entryForbidden },
}));

const gatePattern = (p) => (p.startsWith("^") ? `(?:^|node_modules/)${p.slice(1)}` : p);
const gateRules = (register.decisionGates ?? [])
  .filter((g) => g.decision === null || g.decision === undefined)
  .map((g) => ({
    name: `decision-gate-${g.id}`,
    severity: "error",
    comment: `${g.requirementId}: ${g.rule}; needs an Accepted ADR recorded in modules.yaml before any import`,
    from: {},
    to: { path: g.importPatterns.map(gatePattern) },
  }));

/** @type {import("dependency-cruiser").IConfiguration} */
module.exports = {
  forbidden: [
    ...moduleRules,
    {
      name: "module-undeclared",
      severity: "error",
      comment: "Every source file under a TypeScript root belongs to a module declared in platform/architecture/modules.yaml",
      from: { path: ROOTS, pathNot: [...ALL_MEMBERS, ...TEST_SUPPORT] },
      to: {},
    },
    {
      name: "module-target-undeclared",
      severity: "error",
      comment: "An import into a TypeScript root must land in a declared module",
      from: { path: ROOTS, pathNot: TEST_SUPPORT },
      to: { path: ROOTS, pathNot: ALL_MEMBERS },
    },
    {
      name: "module-package-root-import",
      severity: "error",
      comment: "Import a declared module by path, never the @vsp/platform package root",
      from: { path: ROOTS, pathNot: TEST_SUPPORT },
      to: { path: "^@vsp/platform$" },
    },
    ...entryRules,
    ...gateRules,
  ],
  options: {
    tsPreCompilationDeps: true,
    doNotFollow: { path: "(^|/)node_modules/" },
    exclude: { path: ["(^|/)dist/", "(^|/)coverage/", "\\.d\\.ts$"] },
    moduleSystems: ["es6", "cjs"],
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      mainFields: ["module", "main", "types", "typings"],
      extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json"],
    },
    skipAnalysisNotInRules: true,
  },
};
