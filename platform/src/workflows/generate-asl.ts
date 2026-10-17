/**
 * CLI: generate (or drift-check) the Step Functions STANDARD ASL documents in
 * infra/stepfunctions from the versioned workflow definitions.
 *
 *   npx tsx src/workflows/generate-asl.ts            # write files
 *   npx tsx src/workflows/generate-asl.ts --check    # exit 1 when the committed files drift
 *   npx tsx src/workflows/generate-asl.ts --out <dir> [--check]
 *
 * Output is content-free (file names and counts only).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildAslFiles, type AslOptions } from "./asl.js";
import type { WorkflowDefinitionRegistry } from "./registry.js";
import { createDefaultRegistry } from "./registry.js";
import type { VersionedWorkflowDefinition } from "./types.js";
import { WorkflowType } from "../protocol/index.js";

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ASL_DIR = resolve(here, "../../../infra/stepfunctions");

/** Newest registered version of every workflow type (in-flight executions keep their published version). */
export function latestDefinitions(registry: WorkflowDefinitionRegistry = createDefaultRegistry()): VersionedWorkflowDefinition[] {
  const out: VersionedWorkflowDefinition[] = [];
  for (const t of WorkflowType.options) {
    const d = registry.latest(t);
    if (d) out.push(d);
  }
  return out;
}

const isGenerated = (f: string) => f === "manifest.json" || f.endsWith(".asl.json");

/** Drift reasons: MISSING:<file>, MODIFIED:<file>, UNEXPECTED:<file>. Empty means in sync. */
export function checkAslDrift(dir: string, files: Map<string, string>): string[] {
  const drift: string[] = [];
  for (const [file, content] of files) {
    const p = join(dir, file);
    if (!existsSync(p)) drift.push(`MISSING:${file}`);
    else if (readFileSync(p, "utf8") !== content) drift.push(`MODIFIED:${file}`);
  }
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) if (isGenerated(f) && !files.has(f)) drift.push(`UNEXPECTED:${f}`);
  }
  return drift.sort();
}

export function writeAslFiles(dir: string, files: Map<string, string>): string[] {
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  for (const [file, content] of files) {
    writeFileSync(join(dir, file), content, "utf8");
    written.push(file);
  }
  return written.sort();
}

export function runGenerateAsl(
  argv: readonly string[],
  io: { out: (line: string) => void; err: (line: string) => void } = {
    out: (l) => process.stdout.write(`${l}\n`),
    err: (l) => process.stderr.write(`${l}\n`),
  },
  opts: { registry?: WorkflowDefinitionRegistry; aslOptions?: Partial<AslOptions> } = {},
): number {
  const check = argv.includes("--check");
  const outIdx = argv.indexOf("--out");
  const outArg = outIdx >= 0 ? argv[outIdx + 1] : undefined;
  if (outIdx >= 0 && (outArg === undefined || outArg.startsWith("--"))) {
    io.err("asl.usage: --out requires a directory");
    return 2;
  }
  const dir = outArg ? resolve(outArg) : DEFAULT_ASL_DIR;
  const files = buildAslFiles(latestDefinitions(opts.registry), opts.aslOptions);
  if (check) {
    const drift = checkAslDrift(dir, files);
    if (drift.length > 0) {
      for (const d of drift) io.err(`asl.drift ${d}`);
      io.err("asl.drift detected: run `npx tsx src/workflows/generate-asl.ts` and commit the result");
      return 1;
    }
    io.out(`asl.check ok ${files.size} files`);
    return 0;
  }
  const written = writeAslFiles(dir, files);
  for (const f of written) io.out(`asl.write ${f}`);
  return 0;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = runGenerateAsl(process.argv.slice(2));
}
