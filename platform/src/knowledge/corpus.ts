/**
 * LOCAL FIXTURE corpus loader for `knowledge/corpus/<set>/*.json` at the
 * repository root. Every file must carry the "$fixture" SYNTHETIC label; the
 * approvals inside are synthetic placeholders, not approval records. The local
 * corpus is refused outside local and CI (OPS-04): a real corpus comes from the
 * Salesforce Knowledge export path (BLOCKED, PRQ-032 / VQ-SF-09) and a
 * KNOWLEDGE_RELEASE approval.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Environment } from "../protocol/index.js";
import { ConfigurationRejectedError, ValidationError } from "../shared/errors.js";

const here = dirname(fileURLToPath(import.meta.url));
export const LOCAL_CORPUS_DIR = resolve(here, "../../../knowledge/corpus");

/** Synthetic hosts the local corpus may mention as plain text (reserved .test TLD). */
export const LOCAL_ALLOWED_LINK_DOMAINS: readonly string[] = ["portal.synthetic-health.test", "pay.synthetic-health.test"];

export type CorpusSet = "approved" | "adversarial";

export interface LoadedCorpusFile {
  file: string;
  item: unknown;
}

export function loadLocalCorpus(opts: { set: CorpusSet; environment: Environment; dir?: string }): LoadedCorpusFile[] {
  if (opts.environment !== "local" && opts.environment !== "ci") throw new ConfigurationRejectedError(["KNOWLEDGE_LOCAL_CORPUS_OUTSIDE_LOCAL_CI"]);
  const dir = join(opts.dir ?? LOCAL_CORPUS_DIR, opts.set);
  const files = readdirSync(dir)
    .filter((f) => /^[a-z0-9-]+\.json$/.test(f))
    .sort();
  return files.map((file) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(dir, file), "utf8"));
    } catch {
      throw new ValidationError("KNOWLEDGE_CORPUS_FILE_INVALID_JSON");
    }
    if (!parsed || typeof parsed !== "object" || !("item" in parsed) || !("$fixture" in parsed)) throw new ValidationError("KNOWLEDGE_CORPUS_FILE_SHAPE");
    const label = (parsed as { $fixture: unknown }).$fixture;
    if (typeof label !== "string" || !label.startsWith("SYNTHETIC LOCAL FIXTURE")) throw new ValidationError("KNOWLEDGE_CORPUS_FILE_UNLABELLED");
    return { file, item: (parsed as { item: unknown }).item };
  });
}
