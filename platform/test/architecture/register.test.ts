/**
 * Module register (WP-06; FO-03-11; docs/ARCHITECTURE.md section 6.4): the register is well formed, every
 * TypeScript source under a register root belongs to a declared module, and the allow lists themselves obey
 * the six enforced rules (so a register edit cannot quietly open a forbidden edge). The import graph and the
 * lint and dependency-cruiser rules are checked in import-graph.test.ts, lint-rules.test.ts and
 * depcruise.test.ts.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import YAML from "yaml";
import { z } from "zod";
import { REPO, boundaryApi, readRepoFile, sourceDirectories, sourceFiles, type BoundaryApi, type LoadedRegister, type RegisterDoc } from "./support.js";

const KINDS = ["contracts", "platform-service", "trust", "domain", "composition", "untrusted-output", "test-support", "http-only", "operator", "connector-runtime", "connector-family", "cache"] as const;
const Id = z.string().regex(/^[a-z][a-z0-9-]*$/);
const RepoPath = z.string().regex(/^(platform|media|companion|console|services\/[a-z0-9-]+)\/[A-Za-z0-9_./-]+$/);
const ModuleSchema = z
  .object({
    id: Id,
    path: RepoPath.optional(),
    paths: z.array(RepoPath).min(1).optional(),
    kind: z.enum(KINDS),
    status: z.enum(["present", "planned"]),
    owner: z.string().regex(/^WP-\d{2}(\.\.WP-\d{2})?$/).optional(),
    allow: z.array(z.union([Id, z.literal("*")])),
    allowFiles: z.array(RepoPath).optional(),
  })
  .strict()
  .refine((m) => (m.path === undefined) !== (m.paths === undefined), "exactly one of path and paths")
  .refine((m) => m.status === "present" || m.owner !== undefined, "a planned module names its owning package");
const GateSchema = z
  .object({
    id: Id,
    requirementId: z.string().regex(/^FO-\d{2}-\d{2}$/),
    rule: z.string().min(10),
    packages: z.array(z.string().min(1)).min(1),
    importPatterns: z.array(z.string().min(1)).min(1),
    moduleKinds: z.array(Id).min(1),
    cacheKinds: z.array(z.enum(["exact", "semantic"])).optional(),
    requiresEvaluationReport: z.string().optional(),
    requiresKeyRequirement: z.string().optional(),
    decision: z.object({ adr: z.string(), evaluationReport: z.string().optional() }).strict().nullable(),
  })
  .strict();
const RegisterSchema = z
  .object({
    schemaVersion: z.literal("vsp.module-register.v1"),
    roots: z.array(z.string()).min(1),
    testSupport: z.array(z.string()).min(1),
    untrustedGroup: z.object({ members: z.array(Id).min(1), mayImport: z.array(Id).min(1) }).strict(),
    writePortModules: z.array(Id).min(1),
    writePortImporters: z.array(Id).min(1),
    connectorModules: z.array(Id).min(1),
    connectorForbiddenImporters: z.array(Id).min(1),
    entryPoints: z.array(z.object({ file: RepoPath, transitive: z.boolean() }).strict()).min(1),
    entryPointForbidden: z.array(Id).min(1),
    improvementForbidden: z.array(Id).min(1),
    decisionGates: z.array(GateSchema).min(4),
    caches: z.array(z.object({ file: RepoPath, cacheKind: z.enum(["exact", "semantic"]), key: z.string().min(5), keyRequirement: z.string().optional(), disclosureRecheck: z.boolean().optional(), recheckTest: RepoPath.optional() }).strict()),
    modules: z.array(ModuleSchema).min(10),
  })
  .strict();

let api: BoundaryApi;
let reg: LoadedRegister;
let doc: RegisterDoc;
beforeAll(async () => {
  api = await boundaryApi();
  reg = api.loadModuleRegister();
  doc = reg.doc;
});

/** Module ids reachable from `start` through allow lists ("*" is not followed: only the composition root has it). */
function closure(start: string): Set<string> {
  const seen = new Set<string>();
  const queue = [...(reg.byId.get(start)?.allow ?? [])];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (id === "*" || seen.has(id)) continue;
    seen.add(id);
    queue.push(...(reg.byId.get(id)?.allow ?? []));
  }
  return seen;
}

describe("module register is well formed [FO-03-11]", () => {
  it("[FO-03-11] the register validates: closed kinds, unique ids, known allow targets, planned modules name an owner", () => {
    const raw = YAML.parse(readRepoFile(REPO, "platform/architecture/modules.yaml")) as unknown;
    const parsed = RegisterSchema.safeParse(raw);
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 5))).toBe(true);
    const ids = doc.modules.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    const known = new Set(ids);
    const unknown = doc.modules.flatMap((m) => (m.allow ?? []).filter((a) => a !== "*" && !known.has(a)).map((a) => `${m.id} -> ${a}`));
    const groups = [...doc.untrustedGroup.members, ...doc.untrustedGroup.mayImport, ...doc.writePortModules, ...doc.writePortImporters, ...doc.connectorModules, ...doc.connectorForbiddenImporters, ...doc.entryPointForbidden, ...doc.improvementForbidden];
    expect([...unknown, ...groups.filter((g) => !known.has(g))]).toEqual([]);
    expect(doc.modules.filter((m) => (m.allow ?? []).includes("*")).map((m) => m.id)).toEqual(["main"]);
  });

  it("[FO-03-11] every module path lies under a register root; present modules exist and declared paths do not collide", () => {
    const paths = doc.modules.flatMap((m) => m.paths ?? [m.path!]);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths.filter((p) => !api.isUnderRoot(reg, `${p}/x.ts`) && !api.isUnderRoot(reg, p))).toEqual([]);
    const missing = doc.modules.filter((m) => m.status === "present").flatMap((m) => (m.paths ?? [m.path!]).filter((p) => !existsSync(join(REPO, p))));
    expect(missing).toEqual([]);
  });

  it("[FO-03-11] every TypeScript source under a register root belongs to a declared module (an undeclared directory fails)", () => {
    const roots = doc.roots.flatMap((r) => (r.includes("*") ? sourceDirectories(REPO, [r]) : [r]));
    const files = sourceFiles(REPO, roots).filter((f) => !api.isTestSupport(reg, f));
    expect(files.length).toBeGreaterThan(300);
    expect(files.filter((f) => api.moduleOf(reg, f) === null)).toEqual([]);
  });

  it("[FO-03-11] adversarial: a new directory nobody declared, and a file in a nested module, resolve as the register says", () => {
    expect(api.moduleOf(reg, "platform/src/newthing/index.ts")).toBeNull();
    expect(api.edgeViolation(reg, "platform/src/newthing/index.ts", "../shared/errors.js")).toBe("MODULE_UNDECLARED");
    expect(api.moduleOf(reg, "platform/src/adapters/local/oidc-fixture.ts")).toBe("adapters-local");
    expect(api.moduleOf(reg, "platform/src/adapters/registry.ts")).toBe("adapters");
    expect(api.moduleOf(reg, "platform/src/privacy/egress.ts")).toBe("privacy-egress");
    expect(api.moduleOf(reg, "platform/src/privacy/redaction-service.ts")).toBe("privacy");
    expect(api.moduleOf(reg, "platform/src/console-api/contract.ts")).toBe("console-api-contract");
    expect(api.isTestSupport(reg, "platform/src/workflows/workflow-test-fixtures.ts")).toBe(true);
    expect(api.isTestSupport(reg, "platform/src/workflows/engine.ts")).toBe(false);
  });
});

describe("allow lists obey the six enforced rules [FO-03-11]", () => {
  it("[FO-03-11] rule 1: the untrusted-output group imports only its allowlist, downward only, also transitively", () => {
    const { members, mayImport } = doc.untrustedGroup;
    const contracts = new Set(doc.modules.filter((m) => m.kind === "contracts").map((m) => m.id));
    const permitted = new Set([...mayImport, ...members]);
    for (const id of members) {
      expect((reg.byId.get(id)?.allow ?? []).filter((a) => !permitted.has(a)), id).toEqual([]);
      expect([...closure(id)].filter((a) => !permitted.has(a) && !contracts.has(a)), `${id} (transitive)`).toEqual([]);
    }
    expect(reg.byId.get("models")?.allow?.filter((a) => members.includes(a))).toEqual([]);
    expect(reg.byId.get("prompts")?.allow?.filter((a) => members.includes(a))).toEqual([]);
    expect(reg.byId.get("harness")?.allow?.filter((a) => members.includes(a)).sort()).toEqual(["models", "prompts"]);
    expect(reg.byId.get("media")?.allow?.filter((a) => members.includes(a)).sort()).toEqual(["harness", "models"]);
    // The transport in the group's list imports nothing outside that list (no profile, resolver, DSL or family).
    expect((reg.byId.get("connectors-http")?.allow ?? []).filter((a) => !mayImport.includes(a))).toEqual([]);
  });

  it("[FO-03-11] rule 2: write ports are imported only by the action executor and the composition roots", () => {
    const offenders = doc.modules.filter((m) => !doc.writePortImporters.includes(m.id)).flatMap((m) => (m.allow ?? []).filter((a) => doc.writePortModules.includes(a)).map((a) => `${m.id} -> ${a}`));
    expect(offenders).toEqual([]);
  });

  it("[FO-03-11] rule 3: the connector runtime and families are never imported by the untrusted group, the console API or operator review modules", () => {
    const offenders = doc.connectorForbiddenImporters.flatMap((id) => (reg.byId.get(id)?.allow ?? []).filter((a) => doc.connectorModules.includes(a)).map((a) => `${id} -> ${a}`));
    expect(offenders).toEqual([]);
    expect(reg.byId.get("console-api")?.allow).toEqual(expect.arrayContaining(["readiness", "connectors-catalog"]));
  });

  it("[FO-03-11] rule 4: production entry points are declared and the forbidden set covers fixtures, LOCAL FIXTURE adapters, demo and evaluation", () => {
    expect(doc.entryPointForbidden.sort()).toEqual(["adapters-local", "demo", "evaluation", "fixtures"]);
    expect(doc.entryPoints.map((e) => e.file)).toEqual(expect.arrayContaining(["platform/src/main/live-container.ts", "platform/src/main/live-modules.ts", "platform/src/main/server.ts", "media/src/main.ts"]));
  });

  it("[FO-03-11] rule 5: HTTP-only packages import only the gateway client and the console API contract", () => {
    for (const m of doc.modules.filter((x) => x.kind === "http-only")) {
      expect((m.allow ?? []).filter((a) => a !== "gateway-client"), m.id).toEqual([]);
      expect((m.allowFiles ?? []).filter((f) => f !== "platform/src/console-api/contract.ts"), m.id).toEqual([]);
    }
  });

  it("[FO-03-11] rule 6: improvement never imports policy, identity or the publication path, and never reaches policy or identity transitively", () => {
    const imp = reg.byId.get("improvement")!;
    expect((imp.allow ?? []).filter((a) => doc.improvementForbidden.includes(a))).toEqual([]);
    expect([...closure("improvement")].filter((a) => a === "policy" || a === "identity")).toEqual([]);
    expect(reg.byId.get("studio")?.allow).not.toContain("tenant-config-publication");
  });

  it("[FO-03-11] adversarial: a register edit that opens a forbidden edge is caught by the rule checks", () => {
    const allowOf = (id: string) => reg.byId.get(id)!.allow!;
    const original = [...allowOf("harness")];
    allowOf("harness").push("actions");
    try {
      const permitted = new Set([...doc.untrustedGroup.mayImport, ...doc.untrustedGroup.members]);
      expect(allowOf("harness").filter((a) => !permitted.has(a))).toEqual(["actions"]);
      expect(api.edgeViolation(reg, "platform/src/harness/loop.ts", "../actions/action-service.js")).toBeNull();
    } finally {
      allowOf("harness").splice(0, allowOf("harness").length, ...original);
    }
    expect(api.edgeViolation(reg, "platform/src/harness/loop.ts", "../actions/action-service.js")).toBe("MODULE_IMPORT_NOT_ALLOWED");
  });
});

describe("cache declarations [FO-08-35]", () => {
  it("[FO-08-35] every cache class or cache file in production sources is declared with its key kind; none is similarity-keyed", () => {
    const files = sourceFiles(REPO, ["platform/src", "media/src"]).filter((f) => !api.isTestSupport(reg, f));
    const declared = new Set(doc.caches.map((c) => c.file));
    const found = files.filter((f) => /cache/i.test(f.slice(f.lastIndexOf("/") + 1)) || /\bclass\s+\w*Cache\b/.test(readRepoFile(REPO, f)));
    expect(found.length).toBeGreaterThan(0);
    expect(found.filter((f) => !declared.has(f))).toEqual([]);
    expect(doc.caches.filter((c) => !existsSync(join(REPO, c.file))).map((c) => c.file)).toEqual([]);
    expect(doc.caches.filter((c) => c.cacheKind === "semantic")).toEqual([]);
  });
});

/**
 * Deployable units of ADR-0018 decision 8 (ECS Fargate gateway, worker, audit exporter, console and companion;
 * the media plane's conversation runtime; the reference business API). A prompt, a model or a harness is a
 * library module inside one of them, never a unit of its own (FO-03-11: no microservice per prompt).
 */
const DEPLOYABLE_UNITS = new Set(["gateway", "worker", "audit-exporter", "console", "companion", "media", "reference-business-api"]);
const WORKSPACE_PACKAGES = new Set(["platform", "console", "media", "companion", "services/reference-business-api"]);

/** Keys of the top-level `services = { ... }` map of a Terraform file (the ECS services it creates). */
function terraformServiceKeys(text: string): string[] {
  const start = text.search(/\n\s*services\s*=\s*\{/);
  if (start < 0) return [];
  let i = text.indexOf("{", start);
  let depth = 0;
  const keys: string[] = [];
  let line = "";
  for (; i < text.length; i += 1) {
    const c = text[i];
    if (c === "{") {
      if (depth === 1) {
        const m = /([A-Za-z0-9_-]+)\s*=\s*$/.exec(line);
        if (m?.[1]) keys.push(m[1]);
      }
      depth += 1;
      line = "";
    } else if (c === "}") {
      depth -= 1;
      line = "";
      if (depth === 0) break;
    } else if (c === "\n") line = "";
    else line += c;
  }
  return keys;
}

describe("no microservice per prompt [FO-03-11]", () => {
  it("[FO-03-11] every ECS service, workspace package, container image and application compose service is a deployable unit of ADR-0018; prompts, models and the harness are library modules with no entry point", () => {
    const tf = readRepoFile(REPO, "infra/terraform/modules/stack/main.tf");
    const ecs = terraformServiceKeys(tf);
    expect(ecs).toEqual(expect.arrayContaining(["gateway", "worker"]));
    expect(ecs.filter((k) => !DEPLOYABLE_UNITS.has(k))).toEqual([]);

    const ws = YAML.parse(readRepoFile(REPO, "pnpm-workspace.yaml")) as { packages: string[] };
    const packages = ws.packages.flatMap((p) => (p.endsWith("/*") ? sourceDirectories(REPO, [`${p.slice(0, -2)}/*/src`]).map((d) => d.replace(/\/src$/, "")) : [p]));
    const declared = ws.packages.filter((p) => !p.endsWith("/*"));
    expect(declared.filter((p) => !WORKSPACE_PACKAGES.has(p))).toEqual([]);
    expect(packages.filter((p) => !WORKSPACE_PACKAGES.has(p))).toEqual([]);

    // One image per workspace package at most; no module directory builds an image of its own.
    expect(existsSync(join(REPO, "platform", "Dockerfile"))).toBe(true);
    for (const m of doc.modules) {
      for (const d of m.paths ?? (m.path ? [m.path] : [])) expect(existsSync(join(REPO, d, "Dockerfile")), `${m.id} builds its own image`).toBe(false);
    }

    const app = join(REPO, "deploy/local/services/app.compose.yaml");
    if (existsSync(app)) {
      const compose = YAML.parse(readRepoFile(REPO, "deploy/local/services/app.compose.yaml")) as { services?: Record<string, unknown> };
      expect(Object.keys(compose.services ?? {}).filter((k) => !DEPLOYABLE_UNITS.has(k))).toEqual([]);
    }

    // Prompts, models and the harness are untrusted-output libraries: no production entry point lies in them.
    const LIBRARIES = ["models", "prompts", "harness"];
    expect(doc.modules.filter((m) => LIBRARIES.includes(m.id)).map((m) => [m.id, m.kind])).toEqual(LIBRARIES.map((id) => [id, "untrusted-output"]));
    expect(doc.entryPoints.map((e) => api.moduleOf(reg, e.file)).filter((id) => id !== null && LIBRARIES.includes(id))).toEqual([]);
  });

  it("[FO-03-11] adversarial: a per-prompt ECS service is not a deployable unit", () => {
    const tf = "module \"ecs\" {\n  services = {\n    gateway = {\n      cpu = 1\n    }\n    billing-prompt = {\n      cpu = 1\n    }\n  }\n}\n";
    expect(terraformServiceKeys(tf).filter((k) => !DEPLOYABLE_UNITS.has(k))).toEqual(["billing-prompt"]);
  });
});

