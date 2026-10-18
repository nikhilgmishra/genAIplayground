/**
 * CLI: writes the pinned tool catalogue schemas/tools/catalog.json from the
 * business tool modules (platform/src/gateway/tools). `--check` exits 1 when the
 * committed file differs from what the modules produce (CI drift gate, OPS-06).
 *   npx tsx src/gateway/generate-catalog.ts [--check] [--out <file>] [--generated-at <iso>]
 *
 * Definitions and JSON Schemas are static: the modules are constructed over a
 * spec-only services object that THROWS on any access, so a definition can never
 * depend on runtime data (and the generator needs no database or adapters).
 * The composition root re-checks at boot that the modules it builds with real
 * dependencies hash to the same digest as the committed file (TOOL_CATALOG_DRIFT).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { BusinessServices } from "../business/services/types.js";
import { CATALOG_FILE, CatalogError, buildCatalog, catalogFileContent, parseCatalogFile } from "./catalog.js";
import type { PinnedCatalog } from "./catalog.js";
import type { ToolModule } from "./ports.js";
import { createBusinessToolModules } from "./tools/index.js";

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

const stdio: CliIo = { out: (l) => process.stdout.write(`${l}\n`), err: (l) => process.stderr.write(`${l}\n`) };

/** Services placeholder for definition-only construction: any access throws (fail closed). */
export function specOnlyBusinessServices(): BusinessServices {
  return new Proxy({} as BusinessServices, {
    get: (_t, key) => {
      if (typeof key === "symbol") return undefined;
      throw new CatalogError("TOOL_DEFINITION_DEPENDS_ON_RUNTIME_SERVICE", String(key));
    },
  });
}

/** The business tool modules for definition and schema derivation only (execute is never called). */
export function catalogToolModules(): ToolModule[] {
  return createBusinessToolModules(specOnlyBusinessServices());
}

function committedFile(file: string): ReturnType<typeof parseCatalogFile> | null {
  if (!existsSync(file)) return null;
  try {
    return parseCatalogFile(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Builds the catalogue; keeps the committed manifest timestamp while the digest is unchanged. */
export function buildBusinessCatalog(file: string = CATALOG_FILE, generatedAt?: string): PinnedCatalog {
  const fresh = buildCatalog(catalogToolModules(), generatedAt ? { generatedAt } : {});
  const prior = committedFile(file);
  if (!generatedAt && prior && prior.manifest.digest === fresh.digest) {
    return buildCatalog(catalogToolModules(), { generatedAt: prior.manifest.generatedAt, catalogVersion: prior.manifest.catalogVersion });
  }
  return fresh;
}

export function runGenerateCatalog(argv: readonly string[], io: CliIo = stdio): number {
  const check = argv.includes("--check");
  const arg = (flag: string): { ok: boolean; value: string | undefined } => {
    const i = argv.indexOf(flag);
    if (i < 0) return { ok: true, value: undefined };
    const v = argv[i + 1];
    return v === undefined || v.startsWith("--") ? { ok: false, value: undefined } : { ok: true, value: v };
  };
  const out = arg("--out");
  const at = arg("--generated-at");
  if (!out.ok || !at.ok) {
    io.err("catalog.usage: --out <file> and --generated-at <iso> require a value");
    return 2;
  }
  const file = out.value ? resolve(out.value) : CATALOG_FILE;
  let catalog: PinnedCatalog;
  try {
    catalog = buildBusinessCatalog(file, at.value);
  } catch (e) {
    io.err(`catalog.invalid ${e instanceof CatalogError ? e.reasonCode : "CATALOG_BUILD_FAILED"}`);
    return 1;
  }
  const content = catalogFileContent(catalog);
  if (check) {
    if (!existsSync(file)) {
      io.err("catalog.drift MISSING: run `npx tsx src/gateway/generate-catalog.ts` and commit the result");
      return 1;
    }
    if (readFileSync(file, "utf8") !== content) {
      io.err("catalog.drift MODIFIED: run `npx tsx src/gateway/generate-catalog.ts` and commit the result");
      return 1;
    }
    io.out(`catalog.check ok ${catalog.definitions.length} tools digest=${catalog.digest}`);
    return 0;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, "utf8");
  io.out(`catalog.write ok ${catalog.definitions.length} tools digest=${catalog.digest}`);
  return 0;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = runGenerateCatalog(process.argv.slice(2));
}
