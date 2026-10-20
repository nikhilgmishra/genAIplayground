/**
 * Repository import graph against the module register (WP-06; FO-03-11, FO-06-24 rules 1 to 5; OPS-04):
 * every import edge of every production source under a register root is allowed by its module's entry,
 * and no production entry point reaches a fixture, a LOCAL FIXTURE adapter, the demo, the evaluation
 * tooling or a test emulator through any chain of imports. The edge verdict is the function the ESLint rule
 * uses (platform/eslint.config.js edgeViolation), so lint and this suite cannot disagree.
 */
import { existsSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { REPO, boundaryApi, importSpecifiers, readRepoFile, sourceDirectories, sourceFiles, valueImportSpecifiers, type BoundaryApi, type LoadedRegister, type RestrictionApi } from "./support.js";

let api: BoundaryApi & RestrictionApi;
let reg: LoadedRegister;
let production: string[];
/** Production sources plus the fixtures and testing helpers they can import: everything but test files. */
let capabilityScoped: string[];
const TEST_FILE = /\.test\.tsx?$|(^|\/)(test|e2e)\//;
beforeAll(async () => {
  api = await boundaryApi();
  reg = api.loadModuleRegister();
  const roots = reg.doc.roots.flatMap((r) => (r.includes("*") ? sourceDirectories(REPO, [r]) : [r]));
  const all = sourceFiles(REPO, roots);
  production = all.filter((f) => !api.isTestSupport(reg, f));
  capabilityScoped = all.filter((f) => !TEST_FILE.test(f));
});

/** Repository-relative source file a relative specifier resolves to (".js" written for a ".ts" file), or null. */
function resolveSource(fromRel: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = normalize(join(dirname(fromRel), spec)).split("\\").join("/");
  const stem = base.replace(/\.(js|mjs|cjs|jsx|ts|tsx)$/, "");
  for (const c of [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}/index.ts`]) if (existsSync(join(REPO, c)) && /\.(ts|tsx|mts)$/.test(c)) return c;
  return null;
}

describe("repository import graph [FO-03-11]", () => {
  it("[FO-03-11] every import edge of every production source is allowed by the register (zero violations)", () => {
    expect(production.length).toBeGreaterThan(300);
    const violations: string[] = [];
    for (const f of production) {
      for (const spec of importSpecifiers(readRepoFile(REPO, f))) {
        const code = api.edgeViolation(reg, f, spec);
        if (code) violations.push(`${code}: ${f} -> ${spec}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("[FO-03-11][OPS-04] no production entry point reaches fixtures, LOCAL FIXTURE adapters, demo, evaluation or test code transitively", () => {
    const forbidden = new Set(reg.doc.entryPointForbidden);
    for (const entry of reg.doc.entryPoints.filter((e) => existsSync(join(REPO, e.file)))) {
      const seen = new Set<string>([entry.file]);
      const queue = [entry.file];
      const reached: string[] = [];
      while (queue.length > 0) {
        const f = queue.shift()!;
        for (const spec of importSpecifiers(readRepoFile(REPO, f))) {
          const target = resolveSource(f, spec);
          if (target === null || seen.has(target)) continue;
          seen.add(target);
          const mod = api.moduleOf(reg, target);
          if ((mod !== null && forbidden.has(mod)) || target.startsWith("platform/test/")) reached.push(`${f} -> ${target}`);
          if (entry.transitive) queue.push(target);
        }
      }
      expect(seen.size, entry.file).toBeGreaterThan(entry.transitive ? 20 : 1);
      expect(reached, entry.file).toEqual([]);
    }
  });

  it("[FO-03-11] adversarial: forbidden edges get the reason codes the lint rule reports", () => {
    const cases: [string, string, string | null][] = [
      ["platform/src/harness/loop.ts", "../actions/action-service.js", "MODULE_IMPORT_NOT_ALLOWED"],
      ["platform/src/models/client.ts", "../connectors/secrets/resolver.js", "MODULE_IMPORT_NOT_ALLOWED"],
      ["platform/src/models/client.ts", "../connectors/http/transport.js", null],
      ["platform/src/models/client.ts", "../privacy/egress.js", null],
      ["platform/src/models/client.ts", "../privacy/redaction-service.js", "MODULE_IMPORT_NOT_ALLOWED"],
      ["platform/src/business/x.ts", "../transfer/port.js", "MODULE_IMPORT_NOT_ALLOWED"],
      ["platform/src/actions/x.ts", "../transfer/port.js", null],
      ["platform/src/console-api/x.ts", "../connectors/runtime/connector.js", "MODULE_IMPORT_NOT_ALLOWED"],
      ["platform/src/main/live-container.ts", "../fixtures/synthetic-world.js", "ENTRY_POINT_FORBIDDEN_IMPORT"],
      ["platform/src/main/live-container.ts", "../adapters/local/oidc-fixture.js", "ENTRY_POINT_FORBIDDEN_IMPORT"],
      ["platform/src/main/container.ts", "../fixtures/synthetic-world.js", null],
      ["platform/src/improvement/x.ts", "../policy/engine.js", "MODULE_IMPORT_NOT_ALLOWED"],
      ["platform/src/improvement/x.ts", "../tenant-config/publication/publish.js", "MODULE_IMPORT_NOT_ALLOWED"],
      ["platform/src/improvement/x.ts", "../tenant-config/drafts.js", null],
      ["console/src/pages/x.tsx", "../../../platform/src/console-api/contract", null],
      ["console/src/pages/x.tsx", "../../../platform/src/console-api/schemas", "MODULE_IMPORT_NOT_ALLOWED"],
      ["console/src/pages/x.tsx", "../../../platform/src/protocol/common.js", "MODULE_IMPORT_NOT_ALLOWED"],
      ["media/src/agent.ts", "@vsp/platform/src/actions/action-service.js", "MODULE_IMPORT_NOT_ALLOWED"],
      ["media/src/agent.ts", "@vsp/platform/src/connectors/http/index.js", null],
      ["media/src/agent.ts", "@vsp/platform", "MODULE_PACKAGE_ROOT_IMPORT"],
      ["platform/src/shared/x.ts", "../newthing/y.js", "MODULE_TARGET_UNDECLARED"],
      ["platform/src/newthing/y.ts", "../shared/errors.js", "MODULE_UNDECLARED"],
      ["platform/src/business/x.ts", "zod", null],
    ];
    expect(cases.map(([from, spec]) => api.edgeViolation(reg, from, spec))).toEqual(cases.map((c) => c[2]));
  });
});

/**
 * The import restrictions of platform/eslint.config.js (network, process / code loading, Secrets Manager),
 * re-checked here without ESLint's matcher: a specifier is restricted when it names a restricted module or
 * any path inside it (`undici/lib/api`, `@aws-sdk/client-secrets-manager/dist-cjs/index.js`), and only the
 * reviewed per-file exceptions apply (FO-06-20, FO-06-22, FO-06-04).
 */
function restrictionViolations(rel: string, source: string): string[] {
  const restricted = [...api.NETWORK_MODULES, ...api.PROCESS_MODULES, ...api.SECRETS_MODULES];
  const platformRel = rel.startsWith("platform/") ? rel.slice("platform/".length) : null;
  const allowed = new Set(api.RESTRICTED_IMPORT_EXCEPTIONS.filter((e) => platformRel !== null && e.files.some((g) => api.globToRegExp(g).test(platformRel))).flatMap((e) => e.allow));
  const out: string[] = [];
  for (const spec of valueImportSpecifiers(source, rel)) {
    const hit = restricted.find((m) => spec === m || spec.startsWith(`${m}/`));
    if (hit !== undefined && !allowed.has(hit)) out.push(`${rel} -> ${spec}`);
  }
  return out;
}

describe("restricted runtime imports, independent of ESLint [FO-06-20][FO-06-22][FO-06-04]", () => {
  it("[FO-06-20][FO-06-22][FO-06-04] no production source, fixture or testing helper loads a network client, process / code-loading module or the Secrets Manager client outside its reviewed exception (deep imports included)", () => {
    expect(capabilityScoped.length).toBeGreaterThan(production.length);
    expect(capabilityScoped).toContain("platform/src/fixtures/synthetic-world.ts");
    const violations = capabilityScoped.flatMap((f) => restrictionViolations(f, readRepoFile(REPO, f)));
    expect(violations).toEqual([]);
    // The exceptions are in use (a stale exception would hide nothing, but must not drift unnoticed).
    expect(restrictionViolations("platform/src/connectors/http/transport.ts", 'import { lookup } from "node:dns";\n')).toEqual([]);
  });

  it("[FO-06-20][OPS-04] a test-only exception (the Salesforce contract-test emulator, node:http) is unreachable from every production source through any chain of imports", () => {
    const testOnly = api.RESTRICTED_IMPORT_EXCEPTIONS.filter((e) => e.testOnly === true);
    expect(testOnly.length).toBeGreaterThan(0);
    const isTestOnly = (rel: string) => rel.startsWith("platform/") && testOnly.some((e) => e.files.some((g) => api.globToRegExp(g).test(rel.slice("platform/".length))));
    expect(capabilityScoped.filter(isTestOnly)).toEqual(["platform/src/adapters/live/salesforce-emulator.fixture.ts"]);
    // Breadth-first over every import of every production source, through fixtures and helpers alike.
    const seen = new Set<string>(production);
    const queue = [...production];
    const reached: string[] = [];
    while (queue.length > 0) {
      const f = queue.shift()!;
      for (const spec of importSpecifiers(readRepoFile(REPO, f))) {
        const target = resolveSource(f, spec);
        if (target === null || seen.has(target)) continue;
        seen.add(target);
        if (isTestOnly(target)) reached.push(`${f} -> ${target}`);
        queue.push(target);
      }
    }
    expect(seen.size).toBeGreaterThan(production.length); // fixtures production imports were walked too
    expect(reached).toEqual([]);
  });

  it("[FO-06-20][FO-06-22][FO-06-04] adversarial: deep imports, require, literal dynamic import and re-exports are seen; type-only imports are not", () => {
    const f = "platform/src/business/probe.ts";
    expect(restrictionViolations(f, 'import { request } from "undici/lib/api";\n')).toEqual([`${f} -> undici/lib/api`]);
    expect(restrictionViolations(f, 'import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager/dist-cjs/index.js";\n')).toEqual([`${f} -> @aws-sdk/client-secrets-manager/dist-cjs/index.js`]);
    expect(restrictionViolations(f, 'const cp = require("child_process");\nexport const x = cp;\n')).toEqual([`${f} -> child_process`]);
    expect(restrictionViolations(f, 'export const l = () => import("node:vm");\n')).toEqual([`${f} -> node:vm`]);
    expect(restrictionViolations(f, 'export { createRequire } from "node:module";\n')).toEqual([`${f} -> node:module`]);
    expect(restrictionViolations(f, 'import { resolve4 } from "node:dns/promises";\n')).toEqual([`${f} -> node:dns/promises`]);
    expect(restrictionViolations(f, 'import type { IncomingMessage } from "node:http";\nimport { type Agent } from "node:https";\nexport type T = import("undici").Dispatcher;\n')).toEqual([]);
    // An exception is per file and per specifier.
    expect(restrictionViolations("platform/src/evaluation/manifest.ts", 'import { execFileSync } from "node:child_process";\n')).toEqual([]);
    expect(restrictionViolations("platform/src/evaluation/manifest.ts", 'import { runInNewContext } from "node:vm";\n')).toEqual(["platform/src/evaluation/manifest.ts -> node:vm"]);
  });
});
