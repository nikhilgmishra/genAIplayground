import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createLocalFixtureSet } from "../adapters/local/fixture-set.js";
import {
  CatalogError,
  assertStrictJsonSchema,
  buildCatalog,
  catalogDriftAgainst,
  catalogFileContent,
  parseCatalogFile,
  toolDefinitionFor,
} from "./catalog.js";
import type { ToolModule } from "./ports.js";
import { FixtureFaults, fixtureAppointmentsTool, fixtureHumanTool, fixtureIntakeTool, fixturePublicFaqTool } from "./fixtures/tools.fixture.js";

const faults = new FixtureFaults();
const fixtures = createLocalFixtureSet();
const modules = (): ToolModule[] =>
  [fixtureAppointmentsTool(fixtures.scheduling, faults), fixturePublicFaqTool(faults), fixtureHumanTool(faults), fixtureIntakeTool(faults)] as unknown as ToolModule[];

function withSchemas(base: ToolModule, input: z.ZodType, output?: z.ZodType): ToolModule {
  return { ...base, input, output: output ?? base.output } as ToolModule;
}

const code = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof CatalogError ? e.reasonCode : "OTHER";
  }
};

describe("pinned tool catalogue", () => {
  it("[SPEC-8.tool-schema][OPS-06] derives JSON Schemas with additionalProperties:false at every object level", () => {
    const catalog = buildCatalog(modules());
    for (const def of catalog.definitions) {
      expect(() => assertStrictJsonSchema(def.inputSchema)).not.toThrow();
      expect(() => assertStrictJsonSchema(def.outputSchema)).not.toThrow();
      expect(def.inputSchema.type).toBe("object");
      expect(def.inputSchema.additionalProperties).toBe(false);
    }
    const appts = catalog.definitions.find((d) => d.name === "fixture_get_appointments");
    const props = appts?.outputSchema.properties as Record<string, { items: { additionalProperties: unknown } }> | undefined;
    expect(props?.appointments?.items.additionalProperties).toBe(false);
  });

  it("[SPEC-8.tool-schema] rejects open objects, records and non-object roots anywhere in a schema", () => {
    const base = modules()[1] as ToolModule;
    expect(code(() => toolDefinitionFor(withSchemas(base, z.object({ topic: z.string() }))))).toBe("SCHEMA_ADDITIONAL_PROPERTIES_NOT_FALSE");
    expect(code(() => toolDefinitionFor(withSchemas(base, z.strictObject({ nested: z.object({ a: z.string() }) }))))).toBe("SCHEMA_ADDITIONAL_PROPERTIES_NOT_FALSE");
    expect(code(() => toolDefinitionFor(withSchemas(base, z.strictObject({ any: z.record(z.string(), z.string()) }))))).toBe("SCHEMA_ADDITIONAL_PROPERTIES_NOT_FALSE");
    expect(code(() => toolDefinitionFor(withSchemas(base, z.array(z.string()))))).toBe("INPUT_SCHEMA_ROOT_NOT_OBJECT");
    expect(code(() => toolDefinitionFor(withSchemas(base, z.strictObject({ topic: z.string() }), z.object({ x: z.string() }))))).toBe("SCHEMA_ADDITIONAL_PROPERTIES_NOT_FALSE");
  });

  it("[AUTH-03] a tool input may never declare a server-established identity field (actor, subject, assurance, consent, sessionRef, ...)", () => {
    const base = modules()[1] as ToolModule;
    for (const field of ["subjectId", "actorId", "assurance", "consent", "sessionRef", "permittedScopes", "selectedRole", "organizationId", "tenantId"]) {
      expect(code(() => toolDefinitionFor(withSchemas(base, z.strictObject({ topic: z.string(), deep: z.strictObject({ [field]: z.string() }) }))))).toBe("INPUT_DECLARES_SERVER_ESTABLISHED_FIELD");
    }
  });

  it("[OPS-06] the digest is deterministic, order independent and changes with any schema change", () => {
    const a = buildCatalog(modules());
    const b = buildCatalog([...modules()].reverse());
    expect(a.digest).toBe(b.digest);
    expect(a.digest).toMatch(/^[a-f0-9]{64}$/);
    const changed = modules();
    changed[1] = withSchemas(changed[1] as ToolModule, z.strictObject({ topic: z.enum(["portal_login"]) }));
    expect(buildCatalog(changed).digest).not.toBe(a.digest);
  });

  it("[OPS-06] one pinned version per tool name; unknown name/version lookups return null; the catalogue is frozen (no runtime registration)", () => {
    const catalog = buildCatalog(modules());
    expect(catalog.pinnedVersion("fixture_public_faq")).toBe("1.0.0");
    expect(catalog.get("fixture_public_faq", "1.0.1")).toBeNull();
    expect(catalog.get("nope", "1.0.0")).toBeNull();
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog.definitions)).toBe(true);
    expect(() => (catalog.definitions as unknown as unknown[]).push({})).toThrow();
    expect(code(() => buildCatalog([...modules(), modules()[0] as ToolModule]))).toBe("TOOL_NAME_DUPLICATE");
    expect(code(() => buildCatalog([]))).toBe("CATALOG_EMPTY");
  });

  it("[OPS-06] committed-file round trip; tampering with a definition or digest is detected; drift is reported", () => {
    const catalog = buildCatalog(modules());
    const text = catalogFileContent(catalog);
    const file = parseCatalogFile(text);
    expect(file.manifest.digest).toBe(catalog.digest);
    expect(catalogDriftAgainst(catalog, file)).toBeNull();
    const tampered = JSON.parse(text) as { definitions: { description: string }[] };
    (tampered.definitions[0] as { description: string }).description = "tampered description that changes the hash";
    expect(code(() => parseCatalogFile(JSON.stringify(tampered)))).toBe("CATALOG_FILE_DIGEST_MISMATCH");
    const changed = modules();
    changed[1] = withSchemas(changed[1] as ToolModule, z.strictObject({ topic: z.enum(["portal_login"]) }));
    expect(catalogDriftAgainst(buildCatalog(changed), file)).toBe("TOOL_CATALOG_DRIFT");
  });

  it("[SPEC-8.tool-schema] mask targets must name output properties; consequential tools need an idempotency mechanism", () => {
    const base = modules()[0] as ToolModule;
    expect(code(() => toolDefinitionFor({ ...base, maskTarget: { collectionKey: "missing", envelopeKeys: [] } }))).toBe("MASK_TARGET_COLLECTION_UNKNOWN");
    expect(code(() => toolDefinitionFor({ ...base, maskTarget: { collectionKey: "appointments", envelopeKeys: ["nope"] } }))).toBe("MASK_TARGET_ENVELOPE_KEY_UNKNOWN");
    expect(code(() => toolDefinitionFor({ ...base, definition: { ...base.definition, consequential: true, idempotency: "NATURALLY_IDEMPOTENT" } }))).toBe("CONSEQUENTIAL_TOOL_WITHOUT_IDEMPOTENCY");
  });
});

describe("committed business tool catalogue (schemas/tools/catalog.json)", () => {
  const silent = () => {
    const lines: string[] = [];
    return { lines, io: { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) } };
  };

  it("[OPS-06] the committed catalogue matches the business tool modules (--check); drift and tampering are refused", async () => {
    const { runGenerateCatalog, buildBusinessCatalog } = await import("./generate-catalog.js");
    const { CATALOG_FILE, loadPinnedCatalogFile, toolCatalogDigest, pinnedToolNames, pinnedToolVersions } = await import("./catalog.js");
    const ok = silent();
    expect(runGenerateCatalog(["--check"], ok.io)).toBe(0);
    const file = loadPinnedCatalogFile(CATALOG_FILE);
    const built = buildBusinessCatalog();
    expect(built.digest).toBe(file.manifest.digest);
    expect(toolCatalogDigest()).toBe(file.manifest.digest);
    expect(pinnedToolNames()).toEqual([...built.names()].sort());
    expect(Object.keys(pinnedToolVersions()).length).toBe(built.definitions.length);
    for (const def of file.definitions) {
      expect(() => assertStrictJsonSchema(def.inputSchema)).not.toThrow();
      expect(() => assertStrictJsonSchema(def.outputSchema)).not.toThrow();
    }
    expect(pinnedToolNames()).toEqual(expect.arrayContaining(["request_safety_route", "request_human_transfer"]));
    const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "vsp-catalog-"));
    try {
      const out = join(dir, "catalog.json");
      expect(runGenerateCatalog(["--check", "--out", out], silent().io)).toBe(1);
      expect(runGenerateCatalog(["--out", out], silent().io)).toBe(0);
      expect(runGenerateCatalog(["--check", "--out", out], silent().io)).toBe(0);
      const text = readFileSync(out, "utf8").replace('"description": "', '"description": "edited ');
      writeFileSync(out, text, "utf8");
      const drift = silent();
      expect(runGenerateCatalog(["--check", "--out", out], drift.io)).toBe(1);
      expect(drift.lines.join("\n")).toContain("catalog.drift MODIFIED");
      expect(code(() => parseCatalogFile(text))).toBe("CATALOG_FILE_DIGEST_MISMATCH");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[OPS-06] tool definitions are static: building them never touches a runtime service", async () => {
    const { specOnlyBusinessServices, catalogToolModules } = await import("./generate-catalog.js");
    expect(() => catalogToolModules()).not.toThrow();
    const s = specOnlyBusinessServices();
    expect(() => (s as unknown as { deps: unknown }).deps).toThrow(CatalogError);
  });
});
