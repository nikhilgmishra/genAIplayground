/**
 * CLI: writes docs/resolution-contracts.md from the contract objects, or with
 * `--check` exits 1 when the committed document differs (CI drift gate).
 *
 *   cd platform && npx tsx src/business/contracts/cli-generate-doc.ts [--check]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TOOL_DEFINITIONS } from "../../gateway/tools/definitions.js";
import { RESOLUTION_CONTRACTS } from "./index.js";
import { renderContractsMarkdown } from "./render.js";

export const CONTRACTS_DOC = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../docs/resolution-contracts.md");

export function expectedContractsDoc(): string {
  return renderContractsMarkdown(RESOLUTION_CONTRACTS, Object.values(TOOL_DEFINITIONS));
}

function main(argv: string[]): number {
  const expected = expectedContractsDoc();
  if (argv.includes("--check")) {
    let current: string;
    try {
      current = readFileSync(CONTRACTS_DOC, "utf8");
    } catch {
      current = "";
    }
    if (current !== expected) {
      console.error("docs/resolution-contracts.md is out of date; run: npx tsx src/business/contracts/cli-generate-doc.ts");
      return 1;
    }
    console.log("docs/resolution-contracts.md is up to date");
    return 0;
  }
  writeFileSync(CONTRACTS_DOC, expected);
  console.log("wrote docs/resolution-contracts.md");
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
