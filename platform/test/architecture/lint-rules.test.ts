/**
 * Lint rules of the four TypeScript packages, probed through the ESLint API with each package's own
 * configuration (WP-06; FO-03-11 module boundaries, FO-06-20 no raw network client, FO-06-21 reviewed SQL,
 * FO-06-22 no eval / child_process / dynamic import, FO-06-04 Secrets Manager only through the resolver).
 * Each probe is linted as if it were a file at the given path, so the path-scoped exceptions are exercised
 * too. The repository itself lints clean (`pnpm lint`); these probes show the rules would fail a violation,
 * including the bypasses an adversarial review tried (aliased globals, deep imports, createRequire, SQL text
 * held in variables, `.concat`, `String.raw`, query config objects and imported non-constants).
 */
import { join } from "node:path";
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";
import { REPO } from "./support.js";

type Pkg = "platform" | "media" | "companion" | "console";
const engines = new Map<Pkg, ESLint>();
beforeAll(() => {
  for (const pkg of ["platform", "media", "companion", "console"] as const) {
    engines.set(pkg, new ESLint({ cwd: join(REPO, pkg), overrideConfigFile: join(REPO, pkg, "eslint.config.js") }));
  }
});

/** `ruleId` plus the first token of the message (the reason code for vsp rules) of every problem. */
async function lint(pkg: Pkg, rel: string, code: string): Promise<string[]> {
  const [result] = await engines.get(pkg)!.lintText(code, { filePath: join(REPO, rel) });
  return (result?.messages ?? []).map((m) => `${m.ruleId ?? "parse"}${m.ruleId?.startsWith("vsp/") ? `:${m.message.split(":")[0]}` : ""}`);
}

const DB = "declare const db: { query(sql: string, params?: unknown[]): Promise<unknown> };\n";

describe("platform module boundaries [FO-03-11]", () => {
  it("[FO-03-11] the harness importing the action executor fails; a model importing the egress-classified transport passes", async () => {
    expect(await lint("platform", "platform/src/harness/loop.ts", 'import { ActionService } from "../actions/action-service.js";\nexport const a = ActionService;\n')).toEqual(["vsp/module-boundaries:MODULE_IMPORT_NOT_ALLOWED"]);
    expect(await lint("platform", "platform/src/models/client.ts", 'import { ConnectorHttpTransport } from "../connectors/http/index.js";\nexport const t = ConnectorHttpTransport;\n')).toEqual([]);
    expect(await lint("platform", "platform/src/models/client.ts", 'import { SecretsManagerSecretResolver } from "../connectors/secrets/index.js";\nexport const r = SecretsManagerSecretResolver;\n')).toEqual(["vsp/module-boundaries:MODULE_IMPORT_NOT_ALLOWED"]);
  });

  it("[FO-03-11][OPS-04] a production entry point importing fixtures fails; an undeclared module directory fails; type-only imports count", async () => {
    expect(await lint("platform", "platform/src/main/live-container.ts", 'import { STAFF } from "../fixtures/synthetic-world.js";\nexport const s = STAFF;\n')).toEqual(["vsp/module-boundaries:ENTRY_POINT_FORBIDDEN_IMPORT"]);
    expect(await lint("platform", "platform/src/newthing/index.ts", "export const x = 1;\n")).toEqual(["vsp/module-boundaries:MODULE_UNDECLARED"]);
    expect(await lint("platform", "platform/src/prompts/render.ts", 'import type { Db } from "../db/types.js";\nexport type D = Db;\n')).toEqual(["vsp/module-boundaries:MODULE_IMPORT_NOT_ALLOWED"]);
  });

  it("[FO-03-11] adversarial: an `import x = require()` edge and a re-export are checked like an import", async () => {
    expect(await lint("platform", "platform/src/harness/loop.ts", 'import svc = require("../actions/action-service.js");\nexport const a = svc;\n')).toEqual(expect.arrayContaining(["vsp/module-boundaries:MODULE_IMPORT_NOT_ALLOWED"]));
    expect(await lint("platform", "platform/src/harness/loop.ts", 'export { ActionService } from "../actions/action-service.js";\n')).toEqual(["vsp/module-boundaries:MODULE_IMPORT_NOT_ALLOWED"]);
  });

  it("[FO-03-11] test support is exempt from the allowlists (it is never composed)", async () => {
    expect(await lint("platform", "platform/src/harness/loop.test.ts", 'import { ActionService } from "../actions/action-service.js";\nexport const a = ActionService;\n')).toEqual([]);
  });
});

describe("reviewed SQL only [FO-06-21]", () => {
  it("[FO-06-21] SQL text built from a parameter, by template or concatenation, fails; constants, $n parameters and quoteIdent pass", async () => {
    const f = "platform/src/business/support/probe.ts";
    expect(await lint("platform", f, `${DB}export const q = (id: string) => db.query(\`select * from t where id = '\${id}'\`);\n`)).toEqual(["vsp/no-sql-interpolation:SQL_INTERPOLATION"]);
    expect(await lint("platform", f, `${DB}export const q = (id: string) => db.query("select * from t where id = " + id);\n`)).toEqual(["vsp/no-sql-interpolation:SQL_INTERPOLATION"]);
    expect(await lint("platform", f, `${DB}const COLS = "a, b";\nconst WHERE = \`id = $1\`;\nexport const q = (id: string) => db.query(\`select \${COLS} from t where \${WHERE}\`, [id]);\n`)).toEqual([]);
    expect(await lint("platform", f, `${DB}declare function quoteIdent(s: string): string;\nexport const q = (t: string) => db.query(\`select 1 from \${quoteIdent(t)}\`);\n`)).toEqual([]);
  });

  it("[FO-06-21] adversarial: a model or tool string laundered through a let or a function call is still refused", async () => {
    const f = "platform/src/business/support/probe.ts";
    expect(await lint("platform", f, `${DB}export const q = (toolInput: string) => { let where = toolInput; if (where === "") where = "1=1"; return db.query(\`select * from t where \${where}\`); };\n`)).toEqual(["vsp/no-sql-interpolation:SQL_INTERPOLATION"]);
    expect(await lint("platform", f, `${DB}const build = (s: string) => s;\nexport const q = (m: string) => db.query(\`select \${build(m)}\`);\n`)).toEqual(["vsp/no-sql-interpolation:SQL_INTERPOLATION"]);
  });

  it("[FO-06-21] adversarial: SQL text held in a variable, built with .concat, String.raw or a query config object, or imported from a module that does not define it as constant text is refused", async () => {
    const f = "platform/src/business/support/probe.ts";
    const SQL = ["vsp/no-sql-interpolation:SQL_INTERPOLATION"];
    const probes: Record<string, string> = {
      constVariable: `${DB}export const q = (id: string) => { const sql = \`select * from t where id = '\${id}'\`; return db.query(sql); };\n`,
      letConcatenation: `${DB}export const q = (id: string) => { const sql = "select * from t where id = '" + id + "'"; return db.query(sql); };\n`,
      letCompound: `${DB}export const q = (b: string) => { let sql = "select 1"; sql += b; return db.query(sql); };\n`,
      concatMethod: `${DB}export const q = (id: string) => db.query("select * from t where id = ".concat(id));\n`,
      configObject: `${DB.replace("sql: string", "sql: string | { text: string }")}export const q = (id: string) => db.query({ text: \`select * from t where id = '\${id}'\` } as never);\n`,
      configSpread: `${DB.replace("sql: string", "sql: string | { text: string }")}export const q = (o: { text: string }) => db.query({ ...o } as never);\n`,
      stringRaw: `${DB}export const q = (id: string) => db.query(String.raw\`select * from t where id = '\${id}'\`);\n`,
      importedUnresolvable: `${DB}import { USER_SQL } from "./other.js";\nexport const q = () => db.query(\`select \${USER_SQL}\`);\n`,
      importedFunction: `${DB}import { canonicalJson } from "../../shared/canonical.js";\nexport const q = (v: unknown) => db.query(\`select '\${canonicalJson(v)}'\`);\n`,
      exportedForwarder: `${DB}export function run(sql: string) { return db.query(sql); }\n`,
      localForwarderTainted: `${DB}function run(sql: string) { return db.query(sql); }\nexport const a = (x: string) => run("select " + x);\n`,
      localForwarderEscapes: `${DB}function run(sql: string) { return db.query(sql); }\nexport const r = run;\n`,
      publicMethodForwarder: `${DB}export class A { s(q: string) { return db.query(q); } }\n`,
      publicMethodCalledWithLiteral: `${DB}export class A { s(q: string) { return db.query(q); } go() { return this.s("select 1"); } }\n`,
      exportedForwarderCalledWithLiteral: `${DB}export function run(sql: string) { return db.query(sql); }\nexport const a = () => run("select 1");\n`,
      exportedArrowForwarder: `${DB}export const run = (sql: string) => db.query(sql);\nexport const a = () => run("select 1");\n`,
      privateMethodTainted: `${DB}export class A { private s(q: string) { return db.query(q); } go(x: string) { return this.s(x); } }\n`,
      destructuredSink: `${DB}export const q = (x: string) => { const { query } = db; return query(x); };\n`,
      computedSink: `${DB}export const q = (x: string) => db["query"](x);\n`,
      callForm: `${DB}export const q = (x: string) => db.query.call(db, x);\n`,
      applyForm: `${DB}export const q = (x: string) => db.query.apply(db, [x]);\n`,
      bindForm: `${DB}export const q = () => db.query.bind(db);\n`,
      formatterWithPercentS: `${DB}declare function utilityStatement(d: unknown, t: string, a: string[]): Promise<string>;\nexport const q = async (n: string) => db.query(await utilityStatement(db, "drop role %s", [n]));\n`,
      formatterDynamicTemplate: `${DB}declare function utilityStatement(d: unknown, t: string, a: string[]): Promise<string>;\nexport const q = async (t: string, n: string) => db.query(await utilityStatement(db, t, [n]));\n`,
    };
    const results: Record<string, string[]> = {};
    for (const [name, code] of Object.entries(probes)) results[name] = await lint("platform", f, code);
    expect(results).toEqual(Object.fromEntries(Object.keys(probes).map((k) => [k, SQL])));
  });

  it("[FO-06-21] adversarial: a sink reached indirectly (renamed alias, Reflect.apply, constant computed key, renamed destructuring, re-alias) still has its SQL text checked; a database sink that escapes is refused", async () => {
    const f = "platform/src/business/support/probe.ts";
    const SQL = "vsp/no-sql-interpolation:SQL_INTERPOLATION";
    const ESC = "vsp/no-sql-interpolation:SQL_SINK_ESCAPE";
    const probes: Record<string, [string, string[]]> = {
      aliasCall: [`${DB}export const q = (x: string) => { const run = db.query; return run.call(db, x); };\n`, [ESC, SQL]],
      aliasDirect: [`${DB}export const q = (x: string) => { const run = db.query; return run(x); };\n`, [ESC, SQL]],
      aliasApply: [`${DB}export const q = (x: string) => { const run = db.query; return run.apply(db, [x]); };\n`, [ESC, SQL]],
      realias: [`${DB}export const q = (x: string) => { const a = db.query; const b = a; return b(x); };\n`, [ESC, SQL]],
      reflectApply: [`${DB}export const q = (x: string) => Reflect.apply(db.query, db, [x]);\n`, [SQL]],
      reflectApplyAlias: [`${DB}export const q = (x: string) => { const run = db.query; return Reflect.apply(run, db, [x]); };\n`, [ESC, SQL]],
      computedTemplateKey: [`${DB}export const q = (x: string) => (db as unknown as Record<string, (s: string) => unknown>)[\`que\${"ry"}\`](x);\n`, [SQL]],
      computedConcatKey: [`${DB}const K = "ex" + "ec";\nexport const q = (x: string) => (db as unknown as Record<string, (s: string) => unknown>)[K](x);\n`, [SQL]],
      destructuredRename: [`${DB}export const q = (x: string) => { const { query: run } = db; return run(x); };\n`, [ESC, SQL]],
      sinkPassed: [`${DB}declare function later(f: unknown): void;\nexport const q = () => later(db.query);\n`, [ESC]],
      aliasPassed: [`${DB}declare function later(f: unknown): void;\nexport const q = () => { const run = db.query; later(run); };\n`, [ESC, ESC]],
      typedReceiver: [`import type { Queryable } from "../../db/types.js";\ndeclare function later(f: unknown): void;\nexport const q = (h: Queryable) => later(h.query);\n`, [ESC]],
    };
    const results: Record<string, string[]> = {};
    for (const [name, [code]] of Object.entries(probes)) results[name] = await lint("platform", f, code);
    expect(results).toEqual(Object.fromEntries(Object.entries(probes).map(([k, [, want]]) => [k, want])));
  });

  it("[FO-06-21] positive: an alias or Reflect.apply with reviewed text passes; `.query` read off a parsed query string or a search input is not a sink", async () => {
    const f = "platform/src/business/support/probe.ts";
    const probes: Record<string, string> = {
      aliasReviewed: `${DB}export const q = () => { const run = db.query; return run.call(db, "select 1"); };\n`.replace("const run = db.query", "const run = (db as unknown as { query: typeof db.query }).query"),
      reflectReviewed: `${DB}export const q = () => Reflect.apply(db.query, db, ["select $1", [1]]);\n`,
      requestQuery: "declare const request: { query: Record<string, string> };\ndeclare function parse(q: unknown): unknown;\nexport const p = () => { const q = request.query; return [parse(request.query), q.page]; };\n",
      inputQuery: "export const k = (input: { query: string }) => ({ text: input.query, n: input.query.length });\n",
    };
    const results: Record<string, string[]> = {};
    for (const [name, code] of Object.entries(probes)) results[name] = await lint("platform", f, code);
    expect(results).toEqual({ aliasReviewed: ["vsp/no-sql-interpolation:SQL_SINK_ESCAPE"], reflectReviewed: [], requestQuery: [], inputQuery: [] });
  });

  it("[FO-06-21] positive: reviewed text in variables, lets, constant objects, other modules, private helpers and %I/%L formatters passes; RegExp.exec is not SQL", async () => {
    const f = "platform/src/business/support/probe.ts";
    const probes: Record<string, string> = {
      letReviewed: `${DB}export const q = (b: boolean) => { let sql = "select 1"; if (b) sql += " where a = $1"; return db.query(sql, [1]); };\n`,
      constObject: `${DB}const SQL = { a: "select 1", b: \`select \${"x"}\` } as const;\nexport const q = () => db.query(SQL.b);\n`,
      importedConstant: `${DB}import { ASSERTION_TYP } from "../../identity/assertions/assertion-service.js";\nexport const q = () => db.query(\`select $1 where '\${ASSERTION_TYP}' <> ''\`, [1]);\n`,
      importedNamespace: `${DB}import * as A from "../../identity/assertions/assertion-service.js";\nexport const q = () => db.query(\`select '\${A.ASSERTION_TYP}'\`);\n`,
      localForwarder: `${DB}function run(sql: string) { return db.query(sql); }\nexport const a = () => run("select 1");\n`,
      privateMethod: `${DB}export class A { private s(q: string) { return db.query(q); } go() { return this.s("select 1"); } }\n`,
      dbImplementation: `${DB}export class W { query(sql: string) { return db.query(sql); } }\n`,
      formatter: `${DB}declare function utilityStatement(d: unknown, t: string, a: string[]): Promise<string>;\nexport const q = async (n: string) => db.query(await utilityStatement(db, "drop role if exists %I", [n]));\n`,
      regexParameter: "export const m = (re: RegExp, s: string) => re.exec(s);\n",
      regexConstant: "const RE = /a(b)/;\nexport const m = (s: string) => RE.exec(s);\n",
      regexFactory: "function make(): RegExp | null { return /x/; }\nconst RE = make();\nexport const m = (s: string) => RE?.exec(s);\n",
    };
    const results: Record<string, string[]> = {};
    for (const [name, code] of Object.entries(probes)) results[name] = await lint("platform", f, code);
    expect(results).toEqual(Object.fromEntries(Object.keys(probes).map((k) => [k, []])));
  });
});

describe("no raw network client outside the transport [FO-06-20][FO-15-19]", () => {
  it("[FO-06-20] fetch, globalThis.fetch and node:http(s)/net/undici imports fail outside platform/src/connectors/http; type-only imports pass", async () => {
    const f = "platform/src/business/probe.ts";
    expect(await lint("platform", f, 'export const g = () => fetch("https://example.test/");\n')).toEqual(["no-restricted-globals"]);
    expect(await lint("platform", f, 'export const g = () => globalThis.fetch("https://example.test/");\n')).toEqual(["vsp/no-raw-global-access:GLOBAL_PROPERTY_DENIED"]);
    for (const mod of ["node:http", "node:https", "node:net", "node:tls", "undici", "axios", "ws"]) {
      expect(await lint("platform", f, `import x from "${mod}";\nexport const y = x;\n`), mod).toEqual(["@typescript-eslint/no-restricted-imports"]);
    }
    expect(await lint("platform", f, 'import type { IncomingMessage } from "node:http";\nexport type M = IncomingMessage;\n')).toEqual([]);
    expect(await lint("platform", "platform/src/connectors/http/probe.ts", 'import { request } from "node:https";\nimport { lookup } from "node:dns";\nexport const r = [request, lookup];\n')).toEqual([]);
  });

  it("[FO-06-20] adversarial: the global object aliased, destructured, passed or indexed, other network globals, DNS and deep imports of a restricted package all fail", async () => {
    const f = "platform/src/business/probe.ts";
    const probes: Record<string, [string, string[]]> = {
      bracketFetch: ['export const g = () => (globalThis as unknown as Record<string, () => void>)["fetch"]();\n', ["vsp/no-raw-global-access:GLOBAL_PROPERTY_DENIED"]],
      computedKey: ['export const g = (k: string) => (globalThis as unknown as Record<string, unknown>)[k];\n', ["vsp/no-raw-global-access:GLOBAL_COMPUTED_ACCESS"]],
      alias: ['const g0 = globalThis;\nexport const g = () => g0.fetch("https://x.test/");\n', ["vsp/no-raw-global-access:GLOBAL_OBJECT_ESCAPE"]],
      destructure: ["export const g = () => { const { fetch: f0 } = globalThis; return f0; };\n", ["vsp/no-raw-global-access:GLOBAL_OBJECT_ESCAPE"]],
      reflect: ['export const g = () => Reflect.get(globalThis, "fetch");\n', ["vsp/no-raw-global-access:GLOBAL_OBJECT_ESCAPE"]],
      nestedGlobal: ['export const g = () => globalThis.globalThis.fetch("https://x.test/");\n', ["vsp/no-raw-global-access:GLOBAL_PROPERTY_DENIED"]],
      selfWindow: ['export const g = () => [self.fetch, window.WebSocket];\n', ["vsp/no-raw-global-access:GLOBAL_PROPERTY_DENIED", "vsp/no-raw-global-access:GLOBAL_PROPERTY_DENIED"]],
      webSocket: ['export const g = () => new WebSocket("wss://x.test/");\n', ["no-restricted-globals"]],
      eventSource: ['export const g = () => new EventSource("https://x.test/");\n', ["no-restricted-globals"]],
      dns: ['import { lookup } from "node:dns";\nexport const l = lookup;\n', ["@typescript-eslint/no-restricted-imports"]],
      dnsPromises: ['import { resolve4 } from "dns/promises";\nexport const l = resolve4;\n', ["@typescript-eslint/no-restricted-imports"]],
      undiciDeep: ['import { request } from "undici/lib/api";\nexport const r = request;\n', ["@typescript-eslint/no-restricted-imports"]],
      axiosDeep: ['import a from "axios/lib/axios.js";\nexport const r = a;\n', ["@typescript-eslint/no-restricted-imports"]],
    };
    const results: Record<string, string[]> = {};
    for (const [name, [code]] of Object.entries(probes)) results[name] = await lint("platform", f, code);
    expect(results).toEqual(Object.fromEntries(Object.entries(probes).map(([k, [, want]]) => [k, want])));
    // Reading ordinary members, typeof checks and a local variable named like a global stay legal.
    expect(await lint("platform", f, "export const g = () => [globalThis.structuredClone, typeof globalThis, process.env.X];\nexport const w = (window: number) => window + 1;\n")).toEqual([]);
  });
});

describe("no eval, shell or untrusted module loading [FO-06-22]", () => {
  it("[FO-06-22] eval, new Function, implied eval, child_process/vm/worker_threads and dynamic import fail in production sources", async () => {
    const f = "platform/src/business/probe.ts";
    expect(await lint("platform", f, 'export const a = eval("1");\n')).toEqual(["no-eval"]);
    expect(await lint("platform", f, 'export const a = new Function("return 1");\n')).toEqual(["no-new-func", "no-restricted-globals"]);
    expect(await lint("platform", f, 'export const a = setTimeout("run()", 1);\n')).toEqual(["no-implied-eval"]);
    for (const mod of ["node:child_process", "node:vm", "node:worker_threads"]) {
      expect(await lint("platform", f, `import * as x from "${mod}";\nexport const y = x;\n`), mod).toEqual(["@typescript-eslint/no-restricted-imports"]);
    }
    expect(await lint("platform", f, "export const load = (name: string) => import(name);\n")).toEqual(["no-restricted-syntax"]);
    expect(await lint("platform", f, 'export const load = () => import("./other.js");\n')).toEqual(["no-restricted-syntax"]);
    expect(await lint("platform", "platform/src/main/local.ts", "export const load = (name: string) => import(name);\n")).toEqual(["no-restricted-syntax"]);
  });

  it("[FO-06-22] adversarial: createRequire, require, process.binding / getBuiltinModule / dlopen, a process alias, inspector and repl fail in production sources", async () => {
    const f = "platform/src/business/probe.ts";
    const probes: Record<string, [string, string[]]> = {
      createRequire: ['import { createRequire } from "node:module";\nconst r = createRequire(import.meta.url);\nexport const cp = r("node:child_process");\n', ["@typescript-eslint/no-restricted-imports"]],
      bareModule: ['import { createRequire } from "module";\nexport const c = createRequire;\n', ["@typescript-eslint/no-restricted-imports"]],
      requireGlobal: ['export const cp = require("node:child_process");\n', ["no-restricted-globals", "@typescript-eslint/no-require-imports"]],
      requireAlias: ["const r = require;\nexport const cp = r;\n", ["no-restricted-globals"]],
      binding: ['export const b = (process as unknown as { binding(n: string): unknown }).binding("spawn_sync");\n', ["vsp/no-raw-global-access:GLOBAL_PROPERTY_DENIED"]],
      builtinLoader: ['export const b = process.getBuiltinModule("node:child_process");\n', ["vsp/no-raw-global-access:GLOBAL_PROPERTY_DENIED"]],
      dlopen: ['export const b = (m: { exports: unknown }) => process.dlopen(m, "/tmp/x.node");\n', ["vsp/no-raw-global-access:GLOBAL_PROPERTY_DENIED"]],
      processComputed: ['export const b = (k: string) => (process as unknown as Record<string, unknown>)[k];\n', ["vsp/no-raw-global-access:GLOBAL_COMPUTED_ACCESS"]],
      processAlias: ["const p = process;\nexport const b = () => p.env;\n", ["vsp/no-raw-global-access:GLOBAL_OBJECT_ESCAPE"]],
      inspector: ['import { Session } from "node:inspector";\nexport const s = Session;\n', ["@typescript-eslint/no-restricted-imports"]],
      repl: ['import { start } from "node:repl";\nexport const s = start;\n', ["@typescript-eslint/no-restricted-imports"]],
      childProcessBare: ['import { execFile } from "child_process";\nexport const e = execFile;\n', ["@typescript-eslint/no-restricted-imports"]],
      wasmInstantiate: ["export const w = (bytes: Uint8Array) => WebAssembly.instantiate(bytes);\n", ["no-restricted-globals"]],
      wasmCompile: ["export const w = (bytes: Uint8Array) => new WebAssembly.Module(bytes);\n", ["no-restricted-globals"]],
      wasmViaGlobal: ["export const w = () => globalThis.WebAssembly;\n", ["vsp/no-raw-global-access:GLOBAL_PROPERTY_DENIED"]],
    };
    const results: Record<string, string[]> = {};
    for (const [name, [code]] of Object.entries(probes)) results[name] = await lint("platform", f, code);
    expect(results).toEqual(Object.fromEntries(Object.entries(probes).map(([k, [, want]]) => [k, want])));
    // The child_process exception is per specifier: the evaluation manifest still may not import vm.
    expect(await lint("platform", "platform/src/evaluation/manifest.ts", 'import { runInNewContext } from "node:vm";\nexport const r = runInNewContext;\n')).toEqual(["@typescript-eslint/no-restricted-imports"]);
  });

  it("[FO-06-22] adversarial: the Function constructor reached through a `constructor` member, a constant computed key, destructuring, Reflect.get or the `Function` global fails; `.constructor.name` passes", async () => {
    const f = "platform/src/business/probe.ts";
    const CTOR = "vsp/no-function-constructor:FUNCTION_CONSTRUCTOR_REACHABLE";
    const probes: Record<string, [string, string[]]> = {
      arrayCtorCtor: ['export const g = () => [].constructor.constructor("return 1")();\n', [CTOR, CTOR]],
      arrowCtor: ['export const g = () => (() => 1).constructor("return 1")();\n', [CTOR]],
      asyncCtor: ['export const g = () => Object.getPrototypeOf(async () => undefined).constructor("return 1");\n', [CTOR]],
      computedKey: ['export const g = (f: () => void) => (f as unknown as Record<string, (s: string) => unknown>)["constr" + "uctor"]("return 1");\n', [CTOR]],
      templateKey: ['export const g = (f: () => void) => (f as unknown as Record<string, (s: string) => unknown>)[`constr${"uctor"}`]("return 1");\n', [CTOR]],
      destructure: ["export const g = (f: () => void) => { const { constructor: C } = f; return C; };\n", [CTOR]],
      reflectGet: ['export const g = (f: () => void) => Reflect.get(f, "constructor");\n', [CTOR]],
      descriptor: ['export const g = (f: () => void) => Object.getOwnPropertyDescriptor(Object.getPrototypeOf(f), "constructor");\n', [CTOR]],
      functionGlobal: ["export const g = () => { const F = Function; return F; };\n", ["no-restricted-globals"]],
      functionBind: ["export const g = () => Function.prototype.bind;\n", ["no-restricted-globals"]],
    };
    const results: Record<string, string[]> = {};
    for (const [name, [code]] of Object.entries(probes)) results[name] = await lint("platform", f, code);
    expect(results).toEqual(Object.fromEntries(Object.entries(probes).map(([k, [, want]]) => [k, want])));
    expect(await lint("platform", f, "export const n = (e: Error) => e.constructor.name;\nexport class A { constructor(readonly x: number) {} }\n")).toEqual([]);
    for (const [pkg, rel] of [["media", "media/src/agent.ts"], ["companion", "companion/src/App.tsx"], ["console", "console/src/pages/Probe.tsx"]] as const) {
      expect(await lint(pkg, rel, 'export const g = () => [].constructor.constructor("return 1")();\n'), pkg).toEqual([CTOR, CTOR]);
      expect(await lint(pkg, rel, "export const F = () => Function;\n"), pkg).toEqual(["no-restricted-globals"]);
    }
  });

  it("[FO-06-20][FO-06-22][FO-06-04] fixtures and testing helpers under src/ (importable by production code) get the network, process, secrets and global bans; only *.test.ts files are exempt", async () => {
    const network = 'import { request } from "node:https";\nexport const r = request;\n';
    for (const rel of ["platform/src/fixtures/probe.ts", "platform/src/business/probe.fixture.ts", "platform/src/business/testing.ts", "platform/src/business/testing/probe.ts", "platform/src/workflows/probe-test-fixtures.ts"]) {
      expect(await lint("platform", rel, network), rel).toEqual(["@typescript-eslint/no-restricted-imports"]);
    }
    const f = "platform/src/business/probe.fixture.ts";
    expect(await lint("platform", f, 'export const g = () => fetch("https://x.test/");\n')).toEqual(["no-restricted-globals"]);
    expect(await lint("platform", f, 'import { execFile } from "node:child_process";\nexport const e = execFile;\n')).toEqual(["@typescript-eslint/no-restricted-imports"]);
    expect(await lint("platform", f, 'import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";\nexport const c = SecretsManagerClient;\n')).toEqual(["@typescript-eslint/no-restricted-imports"]);
    expect(await lint("platform", f, "export const g = () => globalThis.fetch;\n")).toEqual(["vsp/no-raw-global-access:GLOBAL_PROPERTY_DENIED"]);
    expect(await lint("platform", f, 'export const g = () => [].constructor.constructor("return 1")();\n')).toEqual(["vsp/no-function-constructor:FUNCTION_CONSTRUCTOR_REACHABLE", "vsp/no-function-constructor:FUNCTION_CONSTRUCTOR_REACHABLE"]);
    expect(await lint("platform", f, 'export const l = () => import("./other.js");\n')).toEqual(["no-restricted-syntax"]);
    // The one test-only exception (the Salesforce contract-test emulator) and test files proper.
    expect(await lint("platform", "platform/src/adapters/live/salesforce-emulator.fixture.ts", 'import { createServer } from "node:http";\nexport const s = createServer;\n')).toEqual([]);
    expect(await lint("platform", "platform/src/adapters/live/salesforce-emulator.fixture.ts", 'import { connect } from "node:net";\nexport const s = connect;\n')).toEqual(["@typescript-eslint/no-restricted-imports"]);
    expect(await lint("platform", "platform/src/business/probe.test.ts", network)).toEqual([]);
  });

  it("[FO-06-22] the reviewed allowlist: execFile in the evaluation manifest, the literal KMS import in config/approvals.ts, test files", async () => {
    expect(await lint("platform", "platform/src/evaluation/manifest.ts", 'import { execFileSync } from "node:child_process";\nexport const e = execFileSync;\n')).toEqual([]);
    expect(await lint("platform", "platform/src/config/approvals.ts", 'export const k = () => import("@aws-sdk/client-kms");\n')).toEqual([]);
    expect(await lint("platform", "platform/src/config/approvals.ts", "export const k = (n: string) => import(n);\n")).toEqual(["no-restricted-syntax"]);
    expect(await lint("platform", "platform/src/business/probe.test.ts", 'export const k = () => import("node:fs");\n')).toEqual([]);
  });
});

describe("Secrets Manager only through the SecretResolver [FO-06-04]", () => {
  it("[FO-06-04] importing the Secrets Manager client outside connectors/secrets (and the inbound verifier) fails", async () => {
    const code = 'import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";\nexport const c = SecretsManagerClient;\n';
    expect(await lint("platform", "platform/src/adapters/live/probe.ts", code)).toEqual(["@typescript-eslint/no-restricted-imports"]);
    expect(await lint("platform", "platform/src/connectors/secrets/probe.ts", code)).toEqual([]);
    expect(await lint("platform", "platform/src/ingress/credentials.ts", code)).toEqual([]);
    // A deep import of the client package is the same client.
    const deep = 'import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager/dist-cjs/index.js";\nexport const c = SecretsManagerClient;\n';
    expect(await lint("platform", "platform/src/business/support/probe.ts", deep)).toEqual(["@typescript-eslint/no-restricted-imports"]);
    expect(await lint("platform", "platform/src/connectors/secrets/probe.ts", deep)).toEqual([]);
  });
});

describe("media/, companion/ and console/ configurations [FO-03-11][FO-06-20][FO-06-22]", () => {
  it("[FO-03-11] media/ (untrusted-output group): write ports and the platform root refused, the transport allowed, no secrets or eval", async () => {
    expect(await lint("media", "media/src/agent.ts", 'import { ActionService } from "@vsp/platform/src/actions/action-service.js";\nexport const a = ActionService;\n')).toEqual(["vsp/module-boundaries:MODULE_IMPORT_NOT_ALLOWED"]);
    expect(await lint("media", "media/src/agent.ts", 'import { ConnectorHttpTransport } from "@vsp/platform/src/connectors/http/index.js";\nexport const t = ConnectorHttpTransport;\n')).toEqual([]);
    expect(await lint("media", "media/src/agent.ts", 'import * as p from "@vsp/platform";\nexport const x = p;\n')).toEqual(["vsp/module-boundaries:MODULE_PACKAGE_ROOT_IMPORT"]);
    expect(await lint("media", "media/src/main.ts", 'import { STAFF } from "@vsp/platform/src/fixtures/synthetic-world.js";\nexport const s = STAFF;\n')).toEqual(["vsp/module-boundaries:ENTRY_POINT_FORBIDDEN_IMPORT"]);
    expect(await lint("media", "media/src/agent.ts", 'import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";\nexport const c = SecretsManagerClient;\n')).toEqual(["@typescript-eslint/no-restricted-imports"]);
    expect(await lint("media", "media/src/agent.ts", 'import http from "node:http";\nexport const h = http;\n')).toEqual(["@typescript-eslint/no-restricted-imports"]);
    expect(await lint("media", "media/src/agent.ts", 'export const a = eval("1");\nexport const l = (n: string) => import(n);\n')).toEqual(["no-eval", "no-restricted-syntax"]);
    expect(await lint("media", "media/src/agent.ts", 'import { request } from "undici/lib/api";\nimport { lookup } from "node:dns";\nexport const r = [request, lookup];\n')).toEqual(["@typescript-eslint/no-restricted-imports", "@typescript-eslint/no-restricted-imports"]);
    expect(await lint("media", "media/src/agent.ts", 'const g = globalThis;\nexport const f = () => [g, process.getBuiltinModule("node:vm")];\n')).toEqual(["vsp/no-raw-global-access:GLOBAL_OBJECT_ESCAPE", "vsp/no-raw-global-access:GLOBAL_PROPERTY_DENIED"]);
  });

  it("[FO-03-11] companion/ (HTTP-only): no platform module, Node built-in, AWS SDK or browser storage", async () => {
    expect(await lint("companion", "companion/src/App.tsx", 'import { PROTOCOL_VERSION } from "../../platform/src/protocol/common.js";\nexport const v = PROTOCOL_VERSION;\n')).toEqual(["vsp/module-boundaries:MODULE_IMPORT_NOT_ALLOWED"]);
    expect(await lint("companion", "companion/src/App.tsx", 'import { readFileSync } from "node:fs";\nimport { S3Client } from "@aws-sdk/client-s3";\nexport const v = [readFileSync, S3Client];\n')).toEqual(["@typescript-eslint/no-restricted-imports", "@typescript-eslint/no-restricted-imports"]);
    expect(await lint("companion", "companion/src/App.tsx", 'export const t = localStorage.getItem("t");\n')).toEqual(["no-restricted-globals"]);
    expect(await lint("companion", "companion/src/App.tsx", 'import { exec } from "child_process";\nimport { readFile } from "fs/promises";\nexport const v = [exec, readFile];\n')).toEqual(["@typescript-eslint/no-restricted-imports", "@typescript-eslint/no-restricted-imports"]);
  });

  it("[FO-03-11] console/ (HTTP-only): only the console API contract file; server modules and Node built-ins refused; existing rules kept", async () => {
    expect(await lint("console", "console/src/pages/Probe.tsx", 'export * from "../../../platform/src/console-api/contract";\n')).toEqual([]);
    expect(await lint("console", "console/src/pages/Probe.tsx", 'import { ActionService } from "../../../platform/src/actions/action-service";\nexport const a = ActionService;\n')).toEqual(["vsp/module-boundaries:MODULE_IMPORT_NOT_ALLOWED"]);
    expect(await lint("console", "console/src/pages/Probe.tsx", 'import { readFileSync } from "node:fs";\nexport const r = readFileSync;\n')).toEqual(["@typescript-eslint/no-restricted-imports"]);
    expect(await lint("console", "console/src/pages/Probe.tsx", 'import { exec } from "child_process";\nexport const r = exec;\n')).toEqual(["@typescript-eslint/no-restricted-imports"]);
    expect(await lint("console", "console/src/pages/Probe.tsx", "export const t = sessionStorage.getItem(\"t\");\n")).toEqual(["no-restricted-globals"]);
  });
});
