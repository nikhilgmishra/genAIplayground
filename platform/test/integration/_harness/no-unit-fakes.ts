/**
 * Keeps unit fakes out of Layer 2 (FO-16-23): a Vite plugin for vitest.integration.config.ts that
 * refuses any import, made directly by a file under test/integration (or resolved at run time without
 * an importer), of a LOCAL FIXTURE adapter, an in-memory fake, PGlite or a module-level test helper.
 * Layer-2 tests compose production adapters against the emulators; synthetic ids come from
 * shared/ids.ts, not from fixtures.
 */
import type { Plugin } from "vitest/config";

export const UNIT_FAKE_PATTERNS: readonly { pattern: RegExp; what: string }[] = [
  { pattern: /\.fixture\.(ts|js)$/, what: "*.fixture.ts (LOCAL FIXTURE)" },
  { pattern: /\/src\/adapters\/local\//, what: "src/adapters/local (LOCAL FIXTURE adapters)" },
  { pattern: /\/src\/fixtures\//, what: "src/fixtures (synthetic world used by fixtures)" },
  { pattern: /\/src\/.+\/testing\.(ts|js)$/, what: "module test helpers (src/**/testing.ts)" },
  { pattern: /\/src\/db\/pglite\.(ts|js)$/, what: "PGlite (single-connection Layer-1 database)" },
  { pattern: /@electric-sql\/pglite/, what: "PGlite (single-connection Layer-1 database)" },
  { pattern: /\/memory-[a-z-]+\.(ts|js)$/, what: "in-memory store implementations" },
  { pattern: /\/src\/audit\/sinks\/local-fs\.(ts|js)$/, what: "local filesystem audit sink fixture" },
];

export function unitFakeMatch(id: string): string | null {
  const normalized = id.replace(/\\/g, "/").split("?")[0] ?? id;
  return UNIT_FAKE_PATTERNS.find((p) => p.pattern.test(normalized))?.what ?? null;
}

const LAYER2_IMPORTER = /\/test\/integration\//;

export function noUnitFakes(): Plugin {
  return {
    name: "vsp-no-unit-fakes-in-layer2",
    enforce: "pre",
    async resolveId(source, importer, options) {
      // Static imports carry their importer; ids the module runner resolves at run time (dynamic
      // imports of computed specifiers) arrive without one and are checked as well.
      if (importer && !LAYER2_IMPORTER.test(importer.replace(/\\/g, "/"))) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      const what = unitFakeMatch(resolved?.id ?? source);
      if (what) this.error(`UNIT_FAKE_IN_LAYER2: ${source} (${what}) imported by ${importer ?? "a run-time import"}; Layer-2 tests use production adapters against the emulators`);
      return resolved;
    },
  };
}
