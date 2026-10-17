/**
 * Writes JSON Schema (draft 2020-12) files for every protocol artifact to /schemas/protocol.
 * `--check` fails if the committed files differ from the generated output (CI gate).
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { PROTOCOL_VERSION } from "./common.js";
import { PROTOCOL_SCHEMAS } from "./registry.js";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "../../../schemas/protocol");
const check = process.argv.includes("--check");

export function renderSchemas(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const [name, schema] of Object.entries(PROTOCOL_SCHEMAS)) {
    const json = z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" }) as Record<string, unknown>;
    const doc = {
      $id: `https://schemas.voice-support.invalid/protocol/${PROTOCOL_VERSION}/${name}.json`,
      title: name,
      "x-protocol-version": PROTOCOL_VERSION,
      ...json,
    };
    files[`${name}.schema.json`] = JSON.stringify(doc, null, 2) + "\n";
  }
  return files;
}

const files = renderSchemas();
let drift = 0;
mkdirSync(outDir, { recursive: true });
for (const [file, content] of Object.entries(files)) {
  const path = join(outDir, file);
  if (check) {
    if (!existsSync(path) || readFileSync(path, "utf8") !== content) {
      console.error(`schema drift: ${file}`);
      drift++;
    }
  } else {
    writeFileSync(path, content);
  }
}
if (check && drift > 0) process.exit(1);
console.log(`${check ? "checked" : "wrote"} ${Object.keys(files).length} protocol schemas in ${outDir}`);
