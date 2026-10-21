/**
 * Writes the generated contract artifacts from the single zod source (FO-04-01):
 *  - schemas/protocol/<Name>.schema.json (JSON Schema draft 2020-12) for every original protocol
 *    artifact (registry.ts PROTOCOL_SCHEMAS) and every follow-on contract (followon.ts), with the
 *    contract version (`x-contract-version`) and, for the 34 contracts, the common-field map
 *    (`x-common-fields`, FO-04-42);
 *  - approvals/schema/ApprovalRecord.schema.json, an exact copy of the protocol ApprovalRecord
 *    schema for human approvers (platform/src/config/approvals.test.ts checks the copy);
 *  - schemas/openapi/console.openapi.json from the console API zod contract (console-openapi.ts).
 * `--check` fails if any committed file differs, is missing, or is a stale schema file no longer
 * generated (CI gate: `pnpm --filter @vsp/platform schemas:check`).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { PROTOCOL_VERSION } from "./common.js";
import { CONSOLE_OPENAPI_PATH, renderConsoleOpenApi } from "./console-openapi.js";
import { COMMON_FIELDS_BY_SCHEMA_KEY, CONTRACT_VERSION_BY_SCHEMA_KEY, FOLLOWON_SCHEMAS } from "./followon.js";
import { PROTOCOL_SCHEMAS } from "./registry.js";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "../../..");
export const PROTOCOL_SCHEMA_DIR = "schemas/protocol";
export const APPROVAL_SCHEMA_COPY = "approvals/schema/ApprovalRecord.schema.json";

/**
 * Every generated schema by name: the original registry plus the follow-on registry. A name in both
 * must be the very same zod schema (one source); anything else is a registry conflict.
 */
export function generatedSchemas(): Record<string, z.ZodType> {
  const all: Record<string, z.ZodType> = { ...PROTOCOL_SCHEMAS };
  for (const [name, schema] of Object.entries(FOLLOWON_SCHEMAS)) {
    const prior = all[name];
    if (prior !== undefined && prior !== schema) throw new Error(`SCHEMA_REGISTRY_CONFLICT:${name}`);
    all[name] = schema;
  }
  return Object.fromEntries(Object.keys(all).sort().map((k) => [k, all[k] as z.ZodType]));
}

/** File name -> content for schemas/protocol. */
export function renderSchemas(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const [name, schema] of Object.entries(generatedSchemas())) {
    const json = z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" }) as Record<string, unknown>;
    const contractVersion = CONTRACT_VERSION_BY_SCHEMA_KEY[name];
    const commonFields = COMMON_FIELDS_BY_SCHEMA_KEY[name];
    const doc = {
      $id: `https://schemas.voice-support.invalid/protocol/${PROTOCOL_VERSION}/${name}.json`,
      title: name,
      "x-protocol-version": PROTOCOL_VERSION,
      ...(contractVersion ? { "x-contract-version": contractVersion } : {}),
      ...(commonFields ? { "x-common-fields": commonFields } : {}),
      ...json,
    };
    files[`${name}.schema.json`] = JSON.stringify(doc, null, 2) + "\n";
  }
  return files;
}

/** Repository-relative path -> content for every generated artifact. */
export function renderAll(): Record<string, string> {
  const out: Record<string, string> = {};
  const schemas = renderSchemas();
  for (const [file, content] of Object.entries(schemas)) out[`${PROTOCOL_SCHEMA_DIR}/${file}`] = content;
  const approval = schemas["ApprovalRecord.schema.json"];
  if (!approval) throw new Error("ApprovalRecord schema missing from the registry");
  out[APPROVAL_SCHEMA_COPY] = approval;
  out[CONSOLE_OPENAPI_PATH] = renderConsoleOpenApi();
  return out;
}

/** Drift report: files that differ or are missing, plus stale *.schema.json files in schemas/protocol. */
export function driftReport(root = REPO_ROOT): string[] {
  const files = renderAll();
  const problems: string[] = [];
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    if (!existsSync(path)) problems.push(`missing: ${rel}`);
    else if (readFileSync(path, "utf8") !== content) problems.push(`drift: ${rel}`);
  }
  const dir = join(root, PROTOCOL_SCHEMA_DIR);
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (f.endsWith(".schema.json") && !(`${PROTOCOL_SCHEMA_DIR}/${f}` in files)) problems.push(`stale: ${PROTOCOL_SCHEMA_DIR}/${f}`);
    }
  }
  return problems;
}

function main(): void {
  const check = process.argv.includes("--check");
  if (check) {
    const problems = driftReport();
    for (const p of problems) console.error(`schema ${p}`);
    if (problems.length > 0) process.exit(1);
    console.log(`checked ${Object.keys(renderAll()).length} generated contract files`);
    return;
  }
  const files = renderAll();
  for (const [rel, content] of Object.entries(files)) {
    const path = join(REPO_ROOT, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  console.log(`wrote ${Object.keys(files).length} generated contract files`);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) main();
