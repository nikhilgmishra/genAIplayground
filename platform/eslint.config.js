import { existsSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
import YAML from "yaml";

/*
 * Platform lint rules (lint group: WP-06 then WP-07 in phase B, each phase integration package after).
 * Beyond the recommended sets they enforce, with zero violations:
 *   - the module register platform/architecture/modules.yaml (vsp/module-boundaries: every source file
 *     belongs to a declared module and imports only the modules its entry allows; production entry points
 *     never import fixtures; docs/ARCHITECTURE.md section 6.4 rules 1 to 5) - FO-03-11, FO-06-24;
 *   - no raw network clients outside the egress-classified transport (platform/src/connectors/http):
 *     `fetch`, `WebSocket`, `EventSource`, node:http(s)/net/tls/http2/dgram/dns, undici, axios, ws, including
 *     deep imports (`undici/lib/...`); type-only imports are fine. The global object is read only through
 *     static members that are not network or code-loading capabilities: no alias, destructuring, computed
 *     key or `globalThis.fetch` (vsp/no-raw-global-access) - FO-06-20;
 *   - no SQL text built from non-reviewed values (vsp/no-sql-interpolation): the text of every query/exec
 *     call (template, concatenation, variable, `let`, `.concat`, `String.raw`, query config `text`, or a
 *     constant imported from another module) must be provably constant - FO-06-21;
 *   - no eval / new Function / implied eval, no route to the Function constructor through a `constructor`
 *     member (vsp/no-function-constructor) or the `Function` global, no child_process / vm / worker_threads /
 *     cluster / inspector / repl / node:module (createRequire), no `require`, no `process.binding` /
 *     `getBuiltinModule` / `dlopen`, no `WebAssembly` compile / instantiate and no dynamic import outside the
 *     reviewed allowlist below - FO-06-22;
 *   - Secrets Manager is read only through the connector SecretResolver (and the inbound verifier) - FO-06-04.
 * The capability bans (network, process / code loading, secrets, global access, Function constructor) cover
 * fixtures and testing helpers under src/ too, since production modules can import them; only *.test.ts
 * files are exempt, and a test-only exception (the Salesforce emulator) must stay unreachable from
 * production code.
 * Lint is the first gate, not a sandbox: platform/test/architecture/import-graph.test.ts re-checks every
 * production import specifier (deep imports included) against the same restriction lists independently.
 * media/eslint.config.js, companion/eslint.config.js and console/eslint.config.js reuse the boundary
 * plugin exported here, so one register governs every TypeScript package.
 */

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "..");
export const MODULE_REGISTER_PATH = join(here, "architecture", "modules.yaml");

/** Glob (`*`, `**`) to an anchored regular expression over repository-relative paths. */
export function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      out += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/** Loads the module register and prepares longest-prefix resolution. */
export function loadModuleRegister(path = MODULE_REGISTER_PATH) {
  const doc = YAML.parse(readFileSync(path, "utf8"));
  const entries = [];
  for (const m of doc.modules) {
    for (const p of m.paths ?? [m.path]) entries.push({ id: m.id, path: p.replace(/\/+$/, ""), isFile: /\.[cm]?[jt]sx?$/.test(p) });
  }
  entries.sort((a, b) => b.path.length - a.path.length);
  const byId = new Map(doc.modules.map((m) => [m.id, m]));
  const testSupport = (doc.testSupport ?? []).map(globToRegExp);
  const roots = (doc.roots ?? []).map((r) => globToRegExp(`${r}/**`));
  return { doc, entries, byId, testSupport, roots };
}

const stripExt = (p) => p.replace(/\.(d\.ts|tsx?|[cm]?[jt]s|jsx)$/, "");

/** Module id of a repository-relative path (file or directory), or null when no module declares it. */
export function moduleOf(register, rel) {
  const bare = stripExt(rel);
  for (const e of register.entries) {
    if (e.isFile ? stripExt(e.path) === bare : rel === e.path || rel.startsWith(`${e.path}/`)) return e.id;
  }
  return null;
}

export const isUnderRoot = (register, rel) => register.roots.some((r) => r.test(rel));
export const isTestSupport = (register, rel) => register.testSupport.some((r) => r.test(rel));

/** Repository-relative target of an import specifier, or null for a third-party package. */
export function resolveSpecifier(fromRel, spec) {
  if (spec.startsWith(".")) return relative(REPO_ROOT, resolve(REPO_ROOT, dirname(fromRel), spec)).split("\\").join("/");
  if (spec === "@vsp/platform") return "platform/@package-root";
  if (spec.startsWith("@vsp/platform/")) return `platform/${spec.slice("@vsp/platform/".length)}`;
  return null;
}

/**
 * Verdict for one import edge: null when allowed, else a reason code. Used by the ESLint rule and by the
 * architecture suite (platform/test/architecture), so both apply exactly the same register.
 */
export function edgeViolation(register, fromRel, spec) {
  const target = resolveSpecifier(fromRel, spec);
  if (target === null) return null;
  const from = moduleOf(register, fromRel);
  if (from === null) return isUnderRoot(register, fromRel) ? "MODULE_UNDECLARED" : null;
  if (target === "platform/@package-root") return "MODULE_PACKAGE_ROOT_IMPORT";
  const entry = (register.doc.entryPoints ?? []).find((e) => stripExt(e.file) === stripExt(fromRel));
  const to = moduleOf(register, target);
  if (entry && to !== null && (register.doc.entryPointForbidden ?? []).includes(to)) return "ENTRY_POINT_FORBIDDEN_IMPORT";
  if (to === null) return isUnderRoot(register, target) ? "MODULE_TARGET_UNDECLARED" : null;
  if (to === from) return null;
  const m = register.byId.get(from);
  if ((m.allowFiles ?? []).some((f) => stripExt(f) === stripExt(target))) return null;
  if ((m.allow ?? []).includes("*") || (m.allow ?? []).includes(to)) return null;
  return "MODULE_IMPORT_NOT_ALLOWED";
}

function specifierNodes(node) {
  if (node.type === "ImportDeclaration" || node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") return node.source ? [node.source] : [];
  if (node.type === "ImportExpression") return node.source.type === "Literal" ? [node.source] : [];
  if (node.type === "TSImportType") return node.argument?.type === "TSLiteralType" ? [node.argument.literal] : [];
  if (node.type === "TSImportEqualsDeclaration") return node.moduleReference?.type === "TSExternalModuleReference" && node.moduleReference.expression?.type === "Literal" ? [node.moduleReference.expression] : [];
  return [];
}

/** TypeScript-only wrappers that do not change the runtime value of the expression they wrap. */
const WRAPPERS = new Set(["TSAsExpression", "TSNonNullExpression", "TSSatisfiesExpression", "TSTypeAssertion", "TSInstantiationExpression", "ChainExpression", "ParenthesizedExpression"]);
const unwrap = (n) => {
  let x = n;
  while (x && WRAPPERS.has(x.type)) x = x.expression;
  return x;
};

/** Repository source file a relative import specifier resolves to (".js" written for a ".ts" file), or null. */
function resolveSourceFile(fromAbs, spec) {
  if (typeof spec !== "string" || !spec.startsWith(".")) return null;
  const base = resolve(dirname(fromAbs), spec);
  const stem = base.replace(/\.(m|c)?jsx?$/, "");
  for (const c of [`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`, join(base, "index.ts")]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

const parsedFiles = new Map();
/** Parses another source file once per content version (mtime) for the cross-module constant check. */
function parsedModule(abs) {
  const mtime = statSync(abs).mtimeMs;
  const hit = parsedFiles.get(abs);
  if (hit && hit.mtime === mtime) return hit.mod;
  const code = readFileSync(abs, "utf8");
  let mod;
  try {
    const { ast, scopeManager } = tseslint.parser.parseForESLint(code, { range: true, loc: false, sourceType: "module", ecmaVersion: "latest", filePath: abs, jsx: abs.endsWith(".tsx") });
    const moduleScope = scopeManager.globalScope.childScopes.find((sc) => sc.type === "module") ?? scopeManager.globalScope;
    mod = { ast, file: abs, text: (n) => code.slice(n.range[0], n.range[1]), scopeOf: () => moduleScope, moduleScope, allowed: new Set() };
  } catch {
    mod = null;
  }
  parsedFiles.set(abs, { mtime, mod });
  return mod;
}

/**
 * The expression a module exports under `name`, with the module context to evaluate it in, or null.
 * Follows `export const`, `export { local as name }` and re-exports (`export { x } from`, `export *`).
 */
function exportedValue(abs, name, depth) {
  if (depth > 8) return null;
  const mod = parsedModule(abs);
  if (!mod) return null;
  for (const st of mod.ast.body) {
    if (st.type === "ExportNamedDeclaration" && st.declaration?.type === "VariableDeclaration" && st.declaration.kind === "const") {
      for (const d of st.declaration.declarations) if (d.id.type === "Identifier" && d.id.name === name && d.init) return { node: d.init, ctx: mod, scope: mod.moduleScope };
    }
    if (st.type === "ExportNamedDeclaration" && !st.declaration) {
      for (const sp of st.specifiers) {
        const exported = sp.exported.type === "Identifier" ? sp.exported.name : sp.exported.value;
        if (exported !== name) continue;
        const local = sp.local.type === "Identifier" ? sp.local.name : sp.local.value;
        if (st.source) {
          const target = resolveSourceFile(abs, st.source.value);
          return target ? exportedValue(target, local, depth + 1) : null;
        }
        return { node: { type: "Identifier", name: local, range: sp.local.range }, ctx: mod, scope: mod.moduleScope };
      }
    }
  }
  for (const st of mod.ast.body) {
    if (st.type === "ExportAllDeclaration" && !st.exported) {
      const target = resolveSourceFile(abs, st.source.value);
      const found = target ? exportedValue(target, name, depth + 1) : null;
      if (found) return found;
    }
  }
  return null;
}

function lookupVariable(scope, name) {
  for (let s = scope; s; s = s.upper) {
    const v = s.set.get(name);
    if (v) return v;
  }
  return null;
}

/** Property `key` of an object literal (non-computed or string-literal key), or null. */
function objectProperty(obj, key) {
  for (const p of obj.properties) {
    if (p.type !== "Property" || p.kind !== "init") continue;
    const k = !p.computed && p.key.type === "Identifier" ? p.key.name : p.key.type === "Literal" ? String(p.key.value) : null;
    if (k === key) return p.value;
  }
  return null;
}

/**
 * Resolves an Identifier or a static member access (`A.b`, `ns.EXPORT`, `A["b"]`) to the expression that
 * defines its value when that value is fixed at module load: a `const` initialiser, an object-literal
 * property of a `const`, or a constant exported by a repository module. Returns null otherwise (a `let`
 * is handled by the caller, a parameter or anything computed at run time is not resolvable).
 */
function resolveConst(node, ctx, scope, depth) {
  if (depth > 16) return null;
  const n = unwrap(node);
  if (n.type === "Identifier") {
    const v = lookupVariable(scope, n.name);
    const def = v?.defs[0];
    if (!def || v.defs.length !== 1) return null;
    if (def.type === "Variable" && def.parent?.kind === "const" && def.node.id.type === "Identifier" && def.node.init) {
      return { node: def.node.init, ctx, scope: ctx.scopeOf(def.node) };
    }
    if (def.type === "ImportBinding" && def.parent?.importKind !== "type" && def.node.type === "ImportSpecifier") {
      const target = resolveSourceFile(ctx.file, def.parent.source.value);
      const imported = def.node.imported.type === "Identifier" ? def.node.imported.name : def.node.imported.value;
      return target ? exportedValue(target, imported, depth + 1) : null;
    }
    return null;
  }
  if (n.type === "MemberExpression") {
    const key = !n.computed && n.property.type === "Identifier" ? n.property.name : n.computed && n.property.type === "Literal" ? String(n.property.value) : null;
    if (key === null) return null;
    const obj = unwrap(n.object);
    if (obj.type === "Identifier") {
      const v = lookupVariable(scope, obj.name);
      const def = v?.defs[0];
      if (def?.type === "ImportBinding" && def.node.type === "ImportNamespaceSpecifier") {
        const target = resolveSourceFile(ctx.file, def.parent.source.value);
        return target ? exportedValue(target, key, depth + 1) : null;
      }
    }
    const base = resolveConst(obj, ctx, scope, depth + 1);
    if (!base) return null;
    const lit = unwrap(base.node);
    if (lit.type !== "ObjectExpression") return null;
    const value = objectProperty(lit, key);
    return value ? { node: value, ctx: base.ctx, scope: base.scope } : null;
  }
  return null;
}

/**
 * The string a key expression always evaluates to: a literal, a template or `+` concatenation of constant
 * parts, or a constant resolved through resolveConst (`x[\`que${"ry"}\`]`, `x["constr" + "uctor"]`). Null
 * when the key is computed at run time.
 */
function staticString(node, ctx, scope, depth = 0) {
  if (!node || depth > 16) return null;
  const n = unwrap(node);
  if (n.type === "Literal") return typeof n.value === "string" || typeof n.value === "number" ? String(n.value) : null;
  if (n.type === "TemplateLiteral") {
    let out = "";
    for (let i = 0; i < n.quasis.length; i += 1) {
      out += n.quasis[i].value.cooked ?? "";
      if (i < n.expressions.length) {
        const v = staticString(n.expressions[i], ctx, scope, depth + 1);
        if (v === null) return null;
        out += v;
      }
    }
    return out;
  }
  if (n.type === "BinaryExpression" && n.operator === "+") {
    const l = staticString(n.left, ctx, scope, depth + 1);
    const r = l === null ? null : staticString(n.right, ctx, scope, depth + 1);
    return l === null || r === null ? null : l + r;
  }
  if ((n.type === "Identifier" || n.type === "MemberExpression") && ctx && scope) {
    const r = resolveConst(n, ctx, scope, depth + 1);
    return r ? staticString(r.node, r.ctx, r.scope, depth + 1) : null;
  }
  return null;
}

/** Property name of a member access or object-pattern key (non-computed, or a computed key that is constant). */
function memberName(node, ctx, scope) {
  const key = node.type === "MemberExpression" ? node.property : node.key;
  if (!node.computed) return key.type === "Identifier" || key.type === "PrivateIdentifier" ? key.name : key.type === "Literal" ? String(key.value) : null;
  return staticString(key, ctx, scope);
}

const SQL_SINKS = new Set(["query", "exec"]);

/** `query` / `exec` when `callee` names a SQL sink (`x.query`, `x["exec"]`, `` x[`que${"ry"}`] ``, bare `query`), else null. */
function sinkName(callee, ctx, scope) {
  if (callee.type === "Identifier") return SQL_SINKS.has(callee.name) ? callee.name : null;
  if (callee.type !== "MemberExpression") return null;
  const name = memberName(callee, ctx, scope);
  return name !== null && SQL_SINKS.has(name) ? name : null;
}

const DB_RECEIVER_NAMES = /^(?:db|tx|trx|q|pg|pglite|pool|client|conn|connection|database|queryable|admin|inner|executor)$/i;
const DB_RECEIVER_TYPES = /\b(?:Db|Queryable|PgliteDb|PgPoolDb|Pool|PoolClient|PGlite|Transaction)\b/;

/**
 * True when the object a sink is read from is a database handle: named like one (`db`, `tx`, `this.pool`)
 * or declared with a database type (`Db`, `Queryable`, `PoolClient`, ...). Reading `.query` off anything
 * else (a parsed query string, a search input) is not a SQL sink.
 */
function dbReceiver(object, ctx, scope) {
  const o = unwrap(object);
  const name = o.type === "Identifier" ? o.name : o.type === "MemberExpression" && !o.computed && o.property.type === "Identifier" ? o.property.name : null;
  if (name !== null && DB_RECEIVER_NAMES.test(name)) return true;
  if (o.type !== "Identifier") return false;
  const def = lookupVariable(scope, o.name)?.defs[0];
  const ann = def?.type === "Parameter" ? def.name.typeAnnotation : def?.type === "Variable" ? def.node.id.typeAnnotation : null;
  return ann !== null && ann !== undefined && DB_RECEIVER_TYPES.test(ctx.text(ann));
}

/** `Reflect.apply` (or `Reflect["apply"]`). */
function isReflectApply(callee, ctx, scope) {
  const c = unwrap(callee);
  return c.type === "MemberExpression" && unwrap(c.object).type === "Identifier" && unwrap(c.object).name === "Reflect" && memberName(c, ctx, scope) === "apply";
}

/** Generic child walk over an ESTree subtree (parents are set by ESLint on the file being linted). */
function walk(node, keys, visit) {
  if (!node || typeof node.type !== "string") return;
  visit(node);
  for (const k of keys[node.type] ?? []) {
    const c = node[k];
    if (Array.isArray(c)) for (const x of c) walk(x, keys, visit);
    else if (c && typeof c === "object") walk(c, keys, visit);
  }
}

/** Name under which a function is called: declaration, method/property key or `const name = () => ...`. */
function functionName(fn) {
  if (fn.type === "FunctionDeclaration") return fn.id?.name ?? null;
  const p = fn.parent;
  if ((p?.type === "MethodDefinition" || p?.type === "Property") && p.value === fn) return !p.computed && (p.key.type === "Identifier" || p.key.type === "PrivateIdentifier") ? p.key.name : null;
  if (p?.type === "VariableDeclarator" && p.init === fn && p.id.type === "Identifier") return p.id.name;
  return null;
}

/**
 * A parameter is reviewed SQL text when the code that supplies it is checked instead:
 *   - the first parameter of a method or object method named query / exec (a Db implementation
 *     forwarding its caller's statement): every `.query(...)` / `.exec(...)` call site is checked;
 *   - a parameter of a function only this file can call (a non-exported function or `const` arrow, or a
 *     private class method) whose every call passes reviewed text in that position. A function that is
 *     exported, passed as a value or called through a computed member is not.
 */
function reviewedParameter(def, ctx, depth) {
  if (!ctx.sourceCode || depth > 24) return false;
  const fn = def.node;
  const index = fn.params.indexOf(def.name);
  if (index < 0) return false;
  const name = functionName(fn);
  if (name === null) return false;
  const holder = fn.parent;
  if (index === 0 && SQL_SINKS.has(name) && (holder?.type === "MethodDefinition" || (holder?.type === "Property" && holder.method))) return true;
  const keys = ctx.sourceCode.visitorKeys;
  const calls = [];
  if (holder?.type === "MethodDefinition") {
    if (holder.accessibility !== "private" && holder.key.type !== "PrivateIdentifier") return false;
    let escaped = false;
    walk(holder.parent, keys, (x) => {
      if (x.type !== "MemberExpression" || x.object.type !== "ThisExpression") return;
      if (x.computed) escaped = true;
      else if (x.property.name === name) {
        if (x.parent?.type === "CallExpression" && x.parent.callee === x) calls.push(x.parent);
        else escaped = true;
      }
    });
    if (escaped) return false;
  } else {
    const declNode = fn.type === "FunctionDeclaration" ? fn : holder;
    const exportParent = fn.type === "FunctionDeclaration" ? fn.parent : holder?.parent?.parent;
    if (exportParent?.type === "ExportNamedDeclaration" || exportParent?.type === "ExportDefaultDeclaration") return false;
    if (fn.type !== "FunctionDeclaration" && holder?.parent?.kind !== "const") return false;
    const variable = ctx.sourceCode.getDeclaredVariables(declNode).find((v) => v.name === name);
    if (!variable) return false;
    for (const ref of variable.references) {
      if (ref.init) continue;
      const id = ref.identifier;
      if (id.parent?.type === "CallExpression" && id.parent.callee === id) calls.push(id.parent);
      else return false;
    }
  }
  if (calls.length === 0) return false;
  return calls.every((c) => {
    const a = c.arguments[index];
    return a !== undefined && a.type !== "SpreadElement" && c.arguments.slice(0, index).every((b) => b.type !== "SpreadElement") && reviewedSql(a, ctx, ctx.sourceCode.getScope(c), depth + 1);
  });
}

const STRING_METHODS = new Set(["trim", "trimStart", "trimEnd", "toLowerCase", "toUpperCase"]);

/**
 * True when the value of `node` is SQL text fixed by reviewed code: string and number literals, templates
 * and `+` / `.concat` / `[...].join` of reviewed parts, `String.raw` over reviewed parts, either branch of
 * a conditional, constants (also across repository modules and object-literal properties of constants),
 * a `let` whose every assignment is reviewed, and the configured sanitizers (quoteIdent). Anything that can
 * carry a caller, tool or model value at run time (parameters, function results, fields of objects that
 * are not constants) is not.
 */
function reviewedSql(node, ctx, scope, depth = 0) {
  if (!node || depth > 24) return false;
  if (ctx.allowed.has(ctx.text(node))) return true;
  const n = unwrap(node);
  if (n !== node && ctx.allowed.has(ctx.text(n))) return true;
  const next = (x, s = scope) => reviewedSql(x, ctx, s, depth + 1);
  switch (n.type) {
    case "Literal":
      return typeof n.value === "string" || typeof n.value === "number";
    case "TemplateLiteral":
      return n.expressions.every((e) => next(e));
    case "TaggedTemplateExpression": {
      const t = unwrap(n.tag);
      const isRaw = t.type === "MemberExpression" && !t.computed && t.object.type === "Identifier" && t.object.name === "String" && t.property.type === "Identifier" && t.property.name === "raw";
      return isRaw && n.quasi.expressions.every((e) => next(e));
    }
    case "BinaryExpression":
      return n.operator === "+" && next(n.left) && next(n.right);
    case "LogicalExpression":
      return next(n.left) && next(n.right);
    case "ConditionalExpression":
      return next(n.consequent) && next(n.alternate);
    case "AwaitExpression":
      return next(n.argument);
    case "CallExpression": {
      const callee = unwrap(n.callee);
      if (callee.type === "Identifier" && ctx.sanitizers?.has(callee.name)) return true;
      if (callee.type === "Identifier" && ctx.formatters?.has(callee.name)) {
        // A server-side format() helper: values go in as %I / %L arguments; the template itself must be a
        // literal with no %s (which would splice a value in unquoted).
        const t = unwrap(n.arguments[ctx.formatters.get(callee.name)] ?? { type: "Missing" });
        const text = t.type === "Literal" && typeof t.value === "string" ? t.value : t.type === "TemplateLiteral" && t.expressions.length === 0 ? t.quasis[0].value.cooked : null;
        return text !== null && !/%(?:\d+\$)?-?s/i.test(text);
      }
      if (callee.type !== "MemberExpression" || callee.computed || callee.property.type !== "Identifier") return false;
      const method = callee.property.name;
      const target = unwrap(callee.object);
      if (method === "join") {
        const arr = target.type === "ArrayExpression" ? { node: target, scope } : (() => {
          const r = resolveConst(target, ctx, scope, depth + 1);
          return r && unwrap(r.node).type === "ArrayExpression" ? { node: unwrap(r.node), scope: r.scope, ctx: r.ctx } : null;
        })();
        if (!arr) return false;
        const arrCtx = arr.ctx ?? ctx;
        return arr.node.elements.every((e) => e !== null && e.type !== "SpreadElement" && reviewedSql(e, arrCtx, arr.scope, depth + 1)) && n.arguments.every((a) => next(a));
      }
      if (method === "concat") return next(target) && n.arguments.every((a) => a.type !== "SpreadElement" && next(a));
      if (STRING_METHODS.has(method)) return n.arguments.length === 0 && next(target);
      return false;
    }
    case "Identifier":
    case "MemberExpression": {
      if (n.type === "Identifier") {
        const v = lookupVariable(scope, n.name);
        const def = v?.defs[0];
        if (def?.type === "Parameter" && v.defs.length === 1) return reviewedParameter(def, ctx, depth + 1);
        if (def?.type === "Variable" && def.parent?.kind !== "const" && v.defs.length === 1 && def.node.id.type === "Identifier") {
          // A `let` / `var`: every value it can hold (initialiser and each assignment) must be reviewed.
          const writes = v.references.filter((r) => r.isWrite());
          if (writes.length === 0 && !def.node.init) return false;
          if (def.node.init && !reviewedSql(def.node.init, ctx, ctx.scopeOf(def.node), depth + 1)) return false;
          return writes.every((r) => r.writeExpr !== null && r.writeExpr !== undefined && (r.writeExpr === def.node.init || reviewedSql(r.writeExpr, ctx, r.from, depth + 1)));
        }
      }
      const r = resolveConst(n, ctx, scope, depth + 1);
      return r !== null && reviewedSql(r.node, r.ctx, r.scope, depth + 1);
    }
    default:
      return false;
  }
}

/** True when `node` is a regular expression (so `.exec(x)` on it is RegExp.prototype.exec, not SQL). */
function isRegExpValue(node, ctx, scope, depth = 0) {
  if (!node || depth > 12) return false;
  const n = unwrap(node);
  if (n.type === "Literal" && n.regex) return true;
  if ((n.type === "NewExpression" || n.type === "CallExpression") && unwrap(n.callee).type === "Identifier" && unwrap(n.callee).name === "RegExp") return true;
  if (n.type === "ConditionalExpression") return isRegExpValue(n.consequent, ctx, scope, depth + 1) && isRegExpValue(n.alternate, ctx, scope, depth + 1);
  if (n.type === "Identifier" && ctx.sourceCode) {
    // Declared RegExp by its TypeScript annotation: a parameter or variable typed RegExp, or a const
    // initialised by calling a function of this file whose return type is RegExp (or RegExp | null).
    const v = lookupVariable(scope, n.name);
    const def = v?.defs[0];
    const declared = (t) => t !== undefined && t !== null && /^(?:RegExp(?:\s*\|\s*(?:null|undefined))*)$/.test(ctx.text(t.typeAnnotation ?? t).trim());
    if (def?.type === "Parameter" && declared(def.name.typeAnnotation)) return true;
    if (def?.type === "Variable" && declared(def.node.id.typeAnnotation)) return true;
    if (def?.type === "Variable" && def.parent?.kind === "const" && def.node.init) {
      const init = unwrap(def.node.init);
      if (init.type === "CallExpression" && unwrap(init.callee).type === "Identifier") {
        const fv = lookupVariable(ctx.scopeOf(def.node), unwrap(init.callee).name);
        const fdef = fv?.defs[0];
        const fnNode = fdef?.type === "FunctionName" ? fdef.node : fdef?.type === "Variable" ? unwrap(fdef.node.init ?? { type: "Missing" }) : null;
        if (fnNode && /Function/.test(fnNode.type) && declared(fnNode.returnType)) return true;
      }
    }
  }
  if (n.type === "Identifier" || n.type === "MemberExpression") {
    const r = resolveConst(n, ctx, scope, depth + 1);
    return r !== null && isRegExpValue(r.node, r.ctx, r.scope, depth + 1);
  }
  return false;
}

/** The vsp ESLint plugin: module boundaries, reviewed SQL text and no raw access to global capabilities. */
export function createVspPlugin(register) {
  const moduleBoundaries = {
    meta: { type: "problem", schema: [], messages: { violation: "{{code}}: {{from}} -> {{to}} (platform/architecture/modules.yaml)" } },
    create(context) {
      const rel = relative(REPO_ROOT, context.filename).split("\\").join("/");
      if (rel.startsWith("..") || isTestSupport(register, rel)) return {};
      const from = moduleOf(register, rel) ?? "(undeclared)";
      const check = (node) => {
        for (const s of specifierNodes(node)) {
          if (typeof s.value !== "string") continue;
          const code = edgeViolation(register, rel, s.value);
          if (code) {
            const target = resolveSpecifier(rel, s.value);
            context.report({ node: s, messageId: "violation", data: { code, from, to: (target && moduleOf(register, target)) ?? target ?? s.value } });
          }
        }
      };
      return {
        Program(node) {
          if (moduleOf(register, rel) === null && isUnderRoot(register, rel)) context.report({ node, messageId: "violation", data: { code: "MODULE_UNDECLARED", from: rel, to: "-" } });
        },
        ImportDeclaration: check,
        ExportNamedDeclaration: check,
        ExportAllDeclaration: check,
        ImportExpression: check,
        TSImportType: check,
        TSImportEqualsDeclaration: check,
      };
    },
  };

  /*
   * vsp/no-sql-interpolation (FO-06-21): the SQL text of every `.query(...)` / `.exec(...)` call (first
   * argument, or the `text` of a query config object) must be reviewed constant text (reviewedSql above):
   * a template or a concatenation of a parameter, a value held in a variable, `String.raw`, `.concat()` or
   * a constant imported from a module that does not define it as constant text all fail. `.exec` on a
   * regular expression is RegExp.prototype.exec and is not checked. The sink is followed when it is
   * reached indirectly: a constant computed key (`` db[`que${"ry"}`](x) ``), `.call` / `.apply`,
   * `Reflect.apply(db.query, db, [x])`, and aliases (`const run = db.query`, `const { query: run } = db`):
   * every call of an alias is checked like the sink itself. A database sink that escapes where its calls
   * cannot be followed (aliased, passed or stored from a database handle, see dbReceiver) is reported
   * (SQL_SINK_ESCAPE); `.bind` always is.
   */
  const noSqlInterpolation = {
    meta: {
      type: "problem",
      schema: [{ type: "object", properties: { sanitizers: { type: "array", items: { type: "string" } }, formatters: { type: "object", additionalProperties: { type: "integer", minimum: 0 } }, allowIdentifiers: { type: "object", additionalProperties: { type: "array", items: { type: "string" } } } }, additionalProperties: false }],
      messages: {
        interpolated: "SQL_INTERPOLATION: SQL text passed to {{call}}() is built from `{{expr}}`, which is not a reviewed constant fragment; pass values as $n parameters (FO-06-21).",
        escape: "SQL_SINK_ESCAPE: the database sink `{{expr}}` is aliased, passed or stored where its SQL text cannot be checked; call it directly with reviewed text (FO-06-21).",
      },
    },
    create(context) {
      const opts = context.options[0] ?? {};
      const rel = relative(REPO_ROOT, context.filename).split("\\").join("/");
      const src = context.sourceCode;
      const ctx = {
        file: context.filename,
        text: (n) => (n.range ? src.text.slice(n.range[0], n.range[1]) : ""),
        scopeOf: (n) => src.getScope(n),
        sourceCode: src,
        sanitizers: new Set(opts.sanitizers ?? []),
        formatters: new Map(Object.entries(opts.formatters ?? {})),
        allowed: new Set(Object.entries(opts.allowIdentifiers ?? {}).flatMap(([glob, ids]) => (globToRegExp(glob).test(rel) ? ids : []))),
      };
      const report = (node, call) => context.report({ node, messageId: "interpolated", data: { call, expr: ctx.text(node).slice(0, 60) } });
      /** Reports the smallest unreviewed parts: each expression of a template or `+` chain, else the whole argument. */
      const checkText = (arg, scope, call) => {
        const a = unwrap(arg);
        if (a.type === "TemplateLiteral") {
          for (const e of a.expressions) if (!reviewedSql(e, ctx, scope)) report(e, call);
          return;
        }
        if (a.type === "BinaryExpression" && a.operator === "+") {
          for (const side of [a.left, a.right]) if (!reviewedSql(side, ctx, scope)) checkText(side, scope, call);
          return;
        }
        if (!reviewedSql(a, ctx, scope)) report(a, call);
      };
      const escape = (node) => context.report({ node, messageId: "escape", data: { expr: ctx.text(node).slice(0, 60) } });
      /** Checks the SQL text argument of one call of a sink (`args` already stripped of a `.call` thisArg). */
      const checkArgs = (node, args, call, scope) => {
        if (args === null) return report(node, `${call}.apply`);
        const arg = args[0];
        if (!arg || arg.type === "SpreadElement") {
          if (arg) report(arg, call);
          return;
        }
        const a = unwrap(arg);
        if (a.type === "ObjectExpression") {
          const text = objectProperty(a, "text");
          const spread = a.properties.some((p) => p.type === "SpreadElement");
          if (!text || spread) report(a, call);
          else checkText(text, scope, call);
          return;
        }
        checkText(arg, scope, call);
      };
      /** The argument list an `.apply(thisArg, [..])` / `Reflect.apply(fn, thisArg, [..])` passes, or null when not a literal array. */
      const arrayArgs = (list) => {
        const l = list ? unwrap(list) : null;
        return l && l.type === "ArrayExpression" ? l.elements.filter((e) => e !== null) : null;
      };
      /** Climbs TypeScript wrappers from `node`; returns the outermost wrapper and its parent. */
      const climb = (node) => {
        let child = node;
        let parent = node.parent;
        while (parent && WRAPPERS.has(parent.type) && parent.expression === child) {
          child = parent;
          parent = parent.parent;
        }
        return { child, parent };
      };
      /**
       * Every use of a variable holding a sink (an alias): calls (direct, `.call`, `.apply`) are checked like
       * the sink, `.bind` is reported, re-aliasing is followed; when the sink came from a database handle, any
       * other escape (passed, returned, stored) is reported.
       */
      const checkAlias = (variable, call, fromDb, depth) => {
        if (!variable || depth > 6) return;
        for (const ref of variable.references) {
          if (ref.init || ref.isWrite()) continue;
          const { child, parent } = climb(ref.identifier);
          const scope = src.getScope(ref.identifier);
          if (parent?.type === "CallExpression" && parent.callee === child) {
            // A bare call of an alias named `query` / `exec` is already checked as a sink call.
            if (!SQL_SINKS.has(variable.name)) checkArgs(parent, parent.arguments, call, scope);
            continue;
          }
          if (parent?.type === "MemberExpression" && parent.object === child) {
            const via = memberName(parent, ctx, scope);
            const outer = climb(parent);
            const called = outer.parent?.type === "CallExpression" && outer.parent.callee === outer.child;
            if (via === "bind") report(parent, `${call}.bind`);
            else if (via === "call" && called) checkArgs(outer.parent, outer.parent.arguments.slice(1), call, scope);
            else if (via === "apply" && called) checkArgs(outer.parent, arrayArgs(outer.parent.arguments[1]), call, scope);
            continue;
          }
          if (parent?.type === "VariableDeclarator" && parent.init === child && parent.id.type === "Identifier") {
            checkAlias(src.getDeclaredVariables(parent).find((v) => v.name === parent.id.name), call, fromDb, depth + 1);
            continue;
          }
          if (parent?.type === "CallExpression" && isReflectApply(parent.callee, ctx, scope) && parent.arguments[0] === child) {
            checkArgs(parent, arrayArgs(parent.arguments[2]), call, scope);
            continue;
          }
          if (fromDb) escape(child);
        }
      };
      return {
        CallExpression(node) {
          const scope = src.getScope(node);
          let callee = unwrap(node.callee);
          let args = node.arguments;
          // `x.query.call(thisArg, sql)` / `x.query.apply(thisArg, [sql])`: the sink is the inner member.
          const via = callee.type === "MemberExpression" ? memberName(callee, ctx, scope) : null;
          if ((via === "call" || via === "apply" || via === "bind") && sinkName(unwrap(callee.object), ctx, scope) !== null) {
            if (via === "bind") return report(node, `${sinkName(unwrap(callee.object), ctx, scope)}.bind`);
            callee = unwrap(callee.object);
            if (via === "call") args = args.slice(1);
            else {
              args = arrayArgs(args[1]);
              if (args === null) return report(node, `${sinkName(callee, ctx, scope)}.apply`);
            }
          }
          // `Reflect.apply(x.query, thisArg, [sql])`.
          if (isReflectApply(callee, ctx, scope) && node.arguments[0] && node.arguments[0].type !== "SpreadElement") {
            const fn = unwrap(node.arguments[0]);
            const reflected = sinkName(fn, ctx, scope);
            if (reflected !== null && fn.type === "MemberExpression") {
              if (reflected === "exec" && isRegExpValue(fn.object, ctx, scope)) return;
              return checkArgs(node, arrayArgs(node.arguments[2]), reflected, scope);
            }
            return;
          }
          // `x.query(...)`, `x["query"](...)`, a constant computed key, and a bare `query(...)` / `exec(...)` (a destructured sink).
          const call = sinkName(callee, ctx, scope);
          if (call === null) return;
          if (call === "exec" && callee.type === "MemberExpression" && isRegExpValue(callee.object, ctx, scope)) return;
          checkArgs(node, args, call, scope);
        },
        MemberExpression(node) {
          const scope = src.getScope(node);
          const call = sinkName(node, ctx, scope);
          if (call === null) return;
          const { child, parent } = climb(node);
          // Called, or the object of `.call` / `.apply` / `.bind` or of a field read: handled elsewhere or not a sink.
          if (parent?.type === "CallExpression" && parent.callee === child) return;
          if (parent?.type === "MemberExpression" && parent.object === child) return;
          if (parent?.type === "AssignmentExpression" && parent.left === child) return;
          if (parent?.type === "UnaryExpression" && parent.operator === "typeof") return;
          if (parent?.type === "CallExpression" && isReflectApply(parent.callee, ctx, scope) && parent.arguments[0] === child) return;
          if (call === "exec" && isRegExpValue(node.object, ctx, scope)) return;
          const fromDb = dbReceiver(node.object, ctx, scope);
          if (parent?.type === "VariableDeclarator" && parent.init === child && parent.id.type === "Identifier") {
            checkAlias(src.getDeclaredVariables(parent).find((v) => v.name === parent.id.name), call, fromDb, 0);
          }
          if (fromDb) escape(node);
        },
        "ObjectPattern > Property"(prop) {
          const scope = src.getScope(prop);
          const key = memberName(prop, ctx, scope);
          if (key === null || !SQL_SINKS.has(key)) return;
          const value = prop.value.type === "AssignmentPattern" ? prop.value.left : prop.value;
          const pattern = prop.parent;
          const source = pattern.parent?.type === "VariableDeclarator" && pattern.parent.id === pattern ? pattern.parent.init : null;
          const fromDb = source !== null && dbReceiver(source, ctx, scope);
          if (value.type !== "Identifier") {
            if (fromDb) escape(prop);
            return;
          }
          checkAlias(lookupVariable(scope, value.name), key, fromDb, 0);
          if (fromDb && value.name !== key) escape(prop);
        },
      };
    },
  };

  /*
   * vsp/no-raw-global-access (FO-06-20, FO-06-22): the global object may only be read through a static
   * member that is not a network or code-loading capability (`globalThis.fetch`, `globalThis["fetch"]`,
   * `globalThis.WebSocket`, `globalThis.process` ... fail), never aliased, passed or indexed with a
   * computed key; `process` may not reach native bindings or the built-in module loader
   * (`process.binding`, `process.getBuiltinModule`, `process.dlopen`). TypeScript casts are seen through.
   */
  const noRawGlobalAccess = {
    meta: {
      type: "problem",
      schema: [{ type: "object", properties: { globalObjects: { type: "array", items: { type: "string" } }, deniedProperties: { type: "array", items: { type: "string" } }, processDenied: { type: "array", items: { type: "string" } } }, additionalProperties: false }],
      messages: {
        escape: "GLOBAL_OBJECT_ESCAPE: `{{name}}` is used as a value (aliased, passed or destructured); read a specific member instead (FO-06-20, FO-06-22).",
        computed: "GLOBAL_COMPUTED_ACCESS: `{{name}}[...]` with a computed key can reach any global capability (FO-06-20, FO-06-22).",
        denied: "GLOBAL_PROPERTY_DENIED: `{{name}}.{{prop}}` is a network, native-binding or code-loading capability outside the reviewed modules (FO-06-20, FO-06-22).",
      },
    },
    create(context) {
      const opts = context.options[0] ?? {};
      const globalObjects = new Set(opts.globalObjects ?? ["globalThis", "global", "window", "self"]);
      const denied = new Set([...(opts.deniedProperties ?? []), ...globalObjects]);
      const processDenied = new Set(opts.processDenied ?? []);
      const check = (ref) => {
        if (ref.isValueReference === false) return;
        const id = ref.identifier;
        const name = id.name;
        let node = id;
        let parent = id.parent;
        while (parent && WRAPPERS.has(parent.type) && parent.expression === node) {
          node = parent;
          parent = parent.parent;
        }
        if (parent?.type === "UnaryExpression" && parent.operator === "typeof") return;
        if (parent?.type === "MemberExpression" && parent.object === node) {
          const prop = !parent.computed && parent.property.type === "Identifier" ? parent.property.name : parent.computed && parent.property.type === "Literal" ? String(parent.property.value) : null;
          if (prop === null) return context.report({ node: parent, messageId: "computed", data: { name } });
          if ((globalObjects.has(name) && denied.has(prop)) || (name === "process" && processDenied.has(prop))) return context.report({ node: parent, messageId: "denied", data: { name, prop } });
          return;
        }
        context.report({ node: id, messageId: "escape", data: { name } });
      };
      return {
        "Program:exit"() {
          const gs = context.sourceCode.scopeManager.globalScope;
          const names = new Set([...globalObjects, "process"]);
          for (const name of names) for (const ref of gs.set.get(name)?.references ?? []) check(ref);
          for (const ref of gs.through) if (names.has(ref.identifier.name)) check(ref);
        },
      };
    },
  };

  /*
   * vsp/no-function-constructor (FO-06-22): the Function constructor (code from a string) is reachable
   * without the `Function` global, through any function's `constructor`: `[].constructor.constructor("...")`,
   * `(() => 1).constructor("...")`, `Object.getPrototypeOf(async () => {}).constructor`. no-new-func sees
   * none of these, so reading a `constructor` member (also through a constant computed key, a destructuring
   * pattern, `Reflect.get` or `Object.getOwnPropertyDescriptor`) is refused; `x.constructor.name`
   * (a diagnostic string) is the one read allowed. The `Function` global is a restricted global.
   */
  const noFunctionConstructor = {
    meta: { type: "problem", schema: [], messages: { ctor: "FUNCTION_CONSTRUCTOR_REACHABLE: `{{expr}}` reads a `constructor`, a route to the Function constructor (code from a string); use instanceof or `.constructor.name` (FO-06-22)." } },
    create(context) {
      const src = context.sourceCode;
      const ctx = { file: context.filename, text: (n) => (n.range ? src.text.slice(n.range[0], n.range[1]) : ""), scopeOf: (n) => src.getScope(n), sourceCode: src, allowed: new Set() };
      const report = (node) => context.report({ node, messageId: "ctor", data: { expr: ctx.text(node).slice(0, 60) } });
      return {
        MemberExpression(node) {
          const scope = src.getScope(node);
          if (memberName(node, ctx, scope) !== "constructor") return;
          let child = node;
          let parent = node.parent;
          while (parent && WRAPPERS.has(parent.type) && parent.expression === child) {
            child = parent;
            parent = parent.parent;
          }
          if (parent?.type === "MemberExpression" && parent.object === child && memberName(parent, ctx, scope) === "name") return;
          report(node);
        },
        "ObjectPattern > Property"(prop) {
          if (memberName(prop, ctx, src.getScope(prop)) === "constructor") report(prop);
        },
        CallExpression(node) {
          const c = unwrap(node.callee);
          if (c.type !== "MemberExpression") return;
          const scope = src.getScope(node);
          const holder = unwrap(c.object).type === "Identifier" ? unwrap(c.object).name : null;
          const m = memberName(c, ctx, scope);
          const lookup = (holder === "Reflect" && (m === "get" || m === "getOwnPropertyDescriptor")) || (holder === "Object" && m === "getOwnPropertyDescriptor");
          if (lookup && node.arguments[1] && staticString(node.arguments[1], ctx, scope) === "constructor") report(node);
        },
      };
    },
  };

  return { meta: { name: "vsp" }, rules: { "module-boundaries": moduleBoundaries, "no-sql-interpolation": noSqlInterpolation, "no-raw-global-access": noRawGlobalAccess, "no-function-constructor": noFunctionConstructor } };
}

export const register = loadModuleRegister();
export const vspPlugin = createVspPlugin(register);

const NETWORK_MESSAGE = "Outbound network clients go through the egress-classified transport platform/src/connectors/http (FO-06-20, FO-15-19).";
const PROCESS_MESSAGE = "No dynamic shell or code loading outside the reviewed allowlist in platform/eslint.config.js (FO-06-22).";
const SECRETS_MESSAGE = "Secrets are read only through the connector SecretResolver, platform/src/connectors/secrets (FO-06-04).";
export const NETWORK_MODULES = ["node:http", "http", "node:https", "https", "node:net", "net", "node:tls", "tls", "node:http2", "http2", "node:dgram", "dgram", "node:dns", "dns", "node:dns/promises", "dns/promises", "undici", "axios", "node-fetch", "got", "ws"];
export const PROCESS_MODULES = ["node:child_process", "child_process", "node:vm", "vm", "node:worker_threads", "worker_threads", "node:cluster", "cluster", "node:module", "module", "node:inspector", "inspector", "node:inspector/promises", "inspector/promises", "node:repl", "repl"];
export const SECRETS_MODULES = ["@aws-sdk/client-secrets-manager"];
export const RESTRICTED_IMPORTS = [
  ...NETWORK_MODULES.map((name) => ({ name, allowTypeImports: true, message: NETWORK_MESSAGE })),
  ...PROCESS_MODULES.map((name) => ({ name, allowTypeImports: true, message: PROCESS_MESSAGE })),
  ...SECRETS_MODULES.map((name) => ({ name, allowTypeImports: true, message: SECRETS_MESSAGE })),
];

/** True for a Node built-in specifier (`node:x`, or a bare built-in name such as `child_process`). */
export const isBuiltinSpecifier = (name) => name.startsWith("node:") || builtinModules.includes(name);

/**
 * no-restricted-imports options for a restriction list: the exact specifiers, plus every deep import of a
 * restricted package (`undici/lib/api`, `@aws-sdk/client-secrets-manager/dist-cjs/index.js`), which an
 * exact-name entry alone does not match. Built-in subpaths (`dns/promises`) are listed by name.
 */
export function restrictedImportOptions(list, except = []) {
  const kept = list.filter((p) => !except.includes(p.name));
  return {
    paths: kept.map(({ name, message, allowTypeImports }) => ({ name, message, ...(allowTypeImports ? { allowTypeImports } : {}) })),
    patterns: kept.filter((p) => !isBuiltinSpecifier(p.name)).map(({ name, message, allowTypeImports }) => ({ group: [`${name}/**`], message, ...(allowTypeImports ? { allowTypeImports } : {}) })),
  };
}
const restricted = (except) => ["error", restrictedImportOptions(RESTRICTED_IMPORTS, except)];

/*
 * Reviewed exceptions to the import restrictions, in one place so the ESLint blocks below and the
 * independent import scan of platform/test/architecture/import-graph.test.ts apply the same allowlist.
 */
export const RESTRICTED_IMPORT_EXCEPTIONS = [
  // The egress-classified transport is the one module that opens outbound sockets and resolves names.
  { files: ["src/connectors/http/**/*.ts"], allow: ["node:http", "node:https", "node:net", "node:tls", "node:dns"] },
  // The SecretResolver and the inbound credential verifier read Secrets Manager.
  { files: ["src/connectors/secrets/**/*.ts", "src/ingress/credentials.ts"], allow: ["@aws-sdk/client-secrets-manager"] },
  // WP-07: the live composition's AWS client factory constructs the Secrets Manager client it hands to the
  // SecretsManagerSecretResolver (the only reader); it sends no command itself.
  { files: ["src/adapters/live/aws-clients.ts"], allow: ["@aws-sdk/client-secrets-manager"] },
  // Fixed-argument execFile of reviewed tools (git for the manifest, the OPA build, the corpus runner).
  { files: ["src/evaluation/corpus-run.ts", "src/evaluation/manifest.ts", "src/policy/ensure-bundle.ts"], allow: ["node:child_process", "child_process"] },
  // TEST-ONLY: the 127.0.0.1 Salesforce REST emulator of the adapter's contract test. testOnly: no
  // production source may reach it through any chain of imports (platform/test/architecture/import-graph.test.ts).
  { files: ["src/adapters/live/salesforce-emulator.fixture.ts"], allow: ["node:http"], testOnly: true },
];

/** Global objects whose members may be read only statically, and the members that stay denied. */
export const GLOBAL_ACCESS_OPTIONS = {
  globalObjects: ["globalThis", "global", "window", "self"],
  deniedProperties: ["fetch", "WebSocket", "EventSource", "XMLHttpRequest", "eval", "Function", "WebAssembly", "require", "module", "process"],
  processDenied: ["binding", "_linkedBinding", "dlopen", "getBuiltinModule", "mainModule"],
};
export const RESTRICTED_GLOBALS = [
  ...["fetch", "WebSocket", "EventSource", "XMLHttpRequest"].map((name) => ({ name, message: NETWORK_MESSAGE })),
  ...["require", "module", "Function"].map((name) => ({ name, message: PROCESS_MESSAGE })),
  // Compiling or instantiating WebAssembly loads code the reviewed sources do not contain. The OPA policy
  // engine's bundle is instantiated inside its pinned library, never from platform code.
  { name: "WebAssembly", message: PROCESS_MESSAGE },
];

const CONSOLE_LOG = { selector: "CallExpression[callee.object.name='console'][callee.property.name='log']", message: "Use the redacting logger in src/observability; console.log can leak PHI." };
const COMPUTED_IMPORT = { selector: "ImportExpression[source.type!='Literal']", message: "Computed dynamic import: untrusted module loading is banned (FO-06-22)." };
const LITERAL_IMPORT = { selector: "ImportExpression[source.type='Literal']", message: `Dynamic import outside the allowlist. ${PROCESS_MESSAGE}` };
export const SQL_RULE_OPTIONS = {
  sanitizers: ["quoteIdent"],
  // Server-side format() helpers and the index of their template argument (a literal without %s).
  formatters: { utilityStatement: 1 },
  // Reviewed internal fragments that the rule cannot prove constant (each is a code-defined column list,
  // predicate or identifier, never caller or model input). A new interpolation in these files still fails.
  allowIdentifiers: {
    "platform/src/actions/action-service.ts": ["where", 'sets.join(", ")'],
    "platform/src/retention/job.ts": ["table", "expiredWhere", "hold", 'tuple("d")', 'tuple("t")', "this.batchSize", "returning"],
    "platform/src/db/apply-tx-options.ts": ["opts.isolation", "role"],
    // The migration runner applies the reviewed files of platform/migrations (checksummed, append-only).
    "platform/src/db/migrate.ts": ["m.sql"],
    // A column list derived from the module constant SR_COLUMNS (prefixing each column with its alias).
    "platform/src/business/support/support-request-service.ts": ["col", 'SR_COLUMNS.split(",").map((c) => `s.${c.trim()}`).join(", ")'],
  },
};

const PROD_SRC = ["src/**/*.ts"];
const TEST_SUPPORT = ["src/**/*.test.ts", "src/**/*.fixture.ts", "src/**/*test-fixtures.ts", "src/**/testing.ts", "src/**/fixtures/**", "src/**/__fixtures__/**", "src/**/testing/**"];
/*
 * Test files proper. The capability bans (network, process / code loading, Secrets Manager, raw global
 * access, the Function constructor) exempt only these: fixtures and testing helpers under src/ are
 * importable by production modules (the local composition imports the synthetic world), so a network call
 * or a spawn placed in one would otherwise ship unchecked.
 */
const TEST_FILES = ["src/**/*.test.ts"];

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // tsconfigRootDir is explicit: media/, companion/ and console/ import this module, and typescript-eslint
    // refuses to guess between several config directories.
    languageOptions: { globals: globals.node, parserOptions: { tsconfigRootDir: here } },
    plugins: { vsp: vspPlugin },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "error",
      "no-console": ["error", { allow: ["warn", "error"] }],
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-restricted-syntax": ["error", CONSOLE_LOG],
    },
  },
  {
    // Capability bans for every source but test files (production and the fixtures it can import): no raw
    // network clients, no process spawning or code loading, Secrets Manager only through the resolver, the
    // global object read statically, no route to the Function constructor, no dynamic imports.
    files: PROD_SRC,
    ignores: TEST_FILES,
    rules: {
      "@typescript-eslint/no-restricted-imports": restricted([]),
      "no-restricted-globals": ["error", ...RESTRICTED_GLOBALS],
      "vsp/no-raw-global-access": ["error", GLOBAL_ACCESS_OPTIONS],
      "vsp/no-function-constructor": "error",
      "no-restricted-syntax": ["error", CONSOLE_LOG, COMPUTED_IMPORT, LITERAL_IMPORT],
    },
  },
  {
    // Production sources: module boundaries and reviewed SQL (fixtures build reviewed test schemas).
    files: PROD_SRC,
    ignores: TEST_SUPPORT,
    rules: {
      "vsp/module-boundaries": "error",
      "vsp/no-sql-interpolation": ["error", SQL_RULE_OPTIONS],
    },
  },
  {
    // CLI and local entry points may print; the code-loading bans stay on.
    files: ["src/demo/**/*.ts", "src/evaluation/cli.ts", "src/main/**/*.ts", "src/protocol/generate-schemas.ts", "src/**/cli*.ts"],
    rules: { "no-console": "off", "no-restricted-syntax": "off" },
  },
  {
    files: ["src/demo/**/*.ts", "src/evaluation/cli.ts", "src/main/**/*.ts", "src/protocol/generate-schemas.ts", "src/**/cli*.ts"],
    ignores: TEST_FILES,
    rules: { "no-restricted-syntax": ["error", COMPUTED_IMPORT, LITERAL_IMPORT] },
  },
  ...RESTRICTED_IMPORT_EXCEPTIONS.map((e) => ({ files: e.files, ignores: TEST_FILES, rules: { "@typescript-eslint/no-restricted-imports": restricted(e.allow) } })),
  {
    // Reviewed exception with an owner. Salesforce REST adapter: injectable fetch defaulting to
    // globalThis.fetch, moved onto the egress-classified transport by WP-07 (FO-14-53 deliverable). Every
    // other global-access restriction stays on for the file.
    files: ["src/adapters/live/salesforce-rest-support-records.ts"],
    rules: { "vsp/no-raw-global-access": ["error", { ...GLOBAL_ACCESS_OPTIONS, deniedProperties: GLOBAL_ACCESS_OPTIONS.deniedProperties.filter((p) => p !== "fetch") }] },
  },
  {
    // Lazy load of the pinned AWS KMS client by a literal specifier (approval signature verification).
    files: ["src/config/approvals.ts"],
    rules: { "no-restricted-syntax": ["error", CONSOLE_LOG, COMPUTED_IMPORT] },
  },
);
