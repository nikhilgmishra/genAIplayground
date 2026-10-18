/**
 * CLI: writes schemas/openapi/gateway.openapi.json from the gateway route
 * definitions; `--check` exits 1 when the committed file differs (CI drift gate).
 *   npx tsx src/gateway/generate-openapi.ts [--check] [--out <file>]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { OPENAPI_FILE, openApiFileContent } from "./openapi.js";

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

const stdio: CliIo = { out: (l) => process.stdout.write(`${l}\n`), err: (l) => process.stderr.write(`${l}\n`) };

export function runGenerateOpenApi(argv: readonly string[], io: CliIo = stdio): number {
  const check = argv.includes("--check");
  const outIdx = argv.indexOf("--out");
  const outArg = outIdx >= 0 ? argv[outIdx + 1] : undefined;
  if (outIdx >= 0 && (outArg === undefined || outArg.startsWith("--"))) {
    io.err("openapi.usage: --out requires a file path");
    return 2;
  }
  const file = outArg ? resolve(outArg) : OPENAPI_FILE;
  const content = openApiFileContent();
  if (check) {
    if (!existsSync(file)) {
      io.err("openapi.drift MISSING: run `npx tsx src/gateway/generate-openapi.ts` and commit the result");
      return 1;
    }
    if (readFileSync(file, "utf8") !== content) {
      io.err("openapi.drift MODIFIED: run `npx tsx src/gateway/generate-openapi.ts` and commit the result");
      return 1;
    }
    io.out("openapi.check ok");
    return 0;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, "utf8");
  io.out("openapi.write ok");
  return 0;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = runGenerateOpenApi(process.argv.slice(2));
}
