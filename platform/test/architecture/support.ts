/**
 * Shared helpers of the architecture suite (WP-06; FO-03-11). The register, the module resolution and the
 * edge verdict come from platform/eslint.config.js itself, so the suite, the ESLint rule and
 * .dependency-cruiser.cjs apply one register (platform/architecture/modules.yaml).
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

export const PLATFORM_DIR = fileURLToPath(new URL("../..", import.meta.url));
export const REPO = join(PLATFORM_DIR, "..");

export interface RegisterModule {
  id: string;
  path?: string;
  paths?: string[];
  kind: string;
  status: "present" | "planned";
  owner?: string;
  allow?: string[];
  allowFiles?: string[];
}

export interface DecisionGate {
  id: string;
  requirementId: string;
  rule: string;
  packages: string[];
  importPatterns: string[];
  moduleKinds: string[];
  cacheKinds?: string[];
  requiresEvaluationReport?: string;
  requiresKeyRequirement?: string;
  decision: { adr: string; evaluationReport?: string } | null;
}

export interface CacheDeclaration {
  file: string;
  cacheKind: "exact" | "semantic";
  key: string;
  keyRequirement?: string;
  disclosureRecheck?: boolean;
  /** Test file that proves the disclosure re-check on return (a similarity-keyed cache must name one). */
  recheckTest?: string;
}

export interface RegisterDoc {
  schemaVersion: string;
  roots: string[];
  testSupport: string[];
  untrustedGroup: { members: string[]; mayImport: string[] };
  writePortModules: string[];
  writePortImporters: string[];
  connectorModules: string[];
  connectorForbiddenImporters: string[];
  entryPoints: { file: string; transitive: boolean }[];
  entryPointForbidden: string[];
  improvementForbidden: string[];
  decisionGates: DecisionGate[];
  caches: CacheDeclaration[];
  modules: RegisterModule[];
}

export interface LoadedRegister {
  doc: RegisterDoc;
  byId: Map<string, RegisterModule>;
}

/** The functions platform/eslint.config.js exports (it is plain JavaScript, so the shape is declared here). */
export interface BoundaryApi {
  REPO_ROOT: string;
  MODULE_REGISTER_PATH: string;
  loadModuleRegister(path?: string): LoadedRegister;
  moduleOf(register: LoadedRegister, rel: string): string | null;
  isUnderRoot(register: LoadedRegister, rel: string): boolean;
  isTestSupport(register: LoadedRegister, rel: string): boolean;
  resolveSpecifier(fromRel: string, spec: string): string | null;
  edgeViolation(register: LoadedRegister, fromRel: string, spec: string): string | null;
  globToRegExp(glob: string): RegExp;
}

/** The import-restriction lists platform/eslint.config.js exports (the ESLint blocks are built from them). */
export interface RestrictionApi {
  NETWORK_MODULES: string[];
  PROCESS_MODULES: string[];
  SECRETS_MODULES: string[];
  /** `testOnly`: the exception's files must stay unreachable from production sources (import-graph.test.ts). */
  RESTRICTED_IMPORT_EXCEPTIONS: { files: string[]; allow: string[]; testOnly?: boolean }[];
}

export async function boundaryApi(): Promise<BoundaryApi & RestrictionApi> {
  const href = pathToFileURL(join(PLATFORM_DIR, "eslint.config.js")).href;
  return (await import(href)) as BoundaryApi & RestrictionApi;
}

const SOURCE = /\.(ts|tsx|mts|cts)$/;
const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", ".data", "playwright-report", "test-results"]);

/** Repository-relative TypeScript sources under the given repository-relative directories. */
export function sourceFiles(root: string, dirs: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (abs: string) => {
    for (const name of readdirSync(abs).sort()) {
      if (SKIP_DIRS.has(name)) continue;
      const p = join(abs, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (SOURCE.test(name) && !name.endsWith(".d.ts")) out.push(relative(root, p).split("\\").join("/"));
    }
  };
  for (const d of dirs) if (existsSync(join(root, d))) walk(join(root, d));
  return out;
}

/** Directories (repository-relative) under the register roots that hold TypeScript sources directly. */
export function sourceDirectories(root: string, roots: readonly string[]): string[] {
  const expanded = roots.flatMap((r) => {
    if (!r.includes("*")) return [r];
    const [head = "", tail = ""] = r.split("/*/");
    if (!existsSync(join(root, head))) return [];
    return readdirSync(join(root, head)).map((n) => `${head}/${n}/${tail}`);
  });
  const dirs = new Set<string>();
  for (const f of sourceFiles(root, expanded)) dirs.add(f.slice(0, f.lastIndexOf("/")));
  return [...dirs].sort();
}

/** Every static, re-export, dynamic-literal and `import("x")` type specifier of one source file. */
export function importSpecifiers(source: string): string[] {
  return ts.preProcessFile(source, true, true).importedFiles.map((f) => f.fileName);
}

/**
 * Specifiers a source file loads at run time: value imports and re-exports, side-effect imports,
 * `import x = require()`, literal dynamic `import()` and `require()` calls. Type-only imports and
 * `import("x").T` type references are left out (they emit no code).
 */
export function valueImportSpecifiers(source: string, fileName = "probe.ts"): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];
  const lit = (n: ts.Node | undefined) => (n && ts.isStringLiteralLike(n) ? n.text : null);
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n)) {
      const c = n.importClause;
      const typeOnly = c !== undefined && (c.isTypeOnly || (c.name === undefined && c.namedBindings !== undefined && ts.isNamedImports(c.namedBindings) && c.namedBindings.elements.length > 0 && c.namedBindings.elements.every((e) => e.isTypeOnly)));
      const spec = lit(n.moduleSpecifier);
      if (!typeOnly && spec !== null) out.push(spec);
    } else if (ts.isExportDeclaration(n)) {
      const spec = lit(n.moduleSpecifier);
      if (!n.isTypeOnly && spec !== null) out.push(spec);
    } else if (ts.isImportEqualsDeclaration(n)) {
      if (!n.isTypeOnly && ts.isExternalModuleReference(n.moduleReference)) {
        const spec = lit(n.moduleReference.expression);
        if (spec !== null) out.push(spec);
      }
    } else if (ts.isCallExpression(n)) {
      const isImport = n.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(n.expression) && n.expression.text === "require";
      const spec = lit(n.arguments[0]);
      if ((isImport || isRequire) && spec !== null) out.push(spec);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

export function readRepoFile(root: string, rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}
