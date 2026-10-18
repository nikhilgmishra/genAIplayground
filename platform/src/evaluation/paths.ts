import { readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Repository root (platform/src/evaluation -> ../../..). */
export const REPO_ROOT = resolve(here, "../../..");

export const repoPaths = (root = REPO_ROOT) => ({
  root,
  scenarios: join(root, "scenarios"),
  skeletons: join(root, "scenarios", "skeletons"),
  generated: join(root, "scenarios", "generated"),
  risk: join(root, "scenarios", "risk"),
  journeys: join(root, "scenarios", "journeys"),
  failures: join(root, "scenarios", "fixtures", "failures"),
  requirements: join(root, "docs", "requirements"),
  catalog: join(root, "docs", "requirements", "catalog.yaml"),
  traceabilityOut: join(root, "docs", "REQUIREMENTS_TRACEABILITY.md"),
  evidence: join(root, "evidence"),
  approvals: join(root, "approvals"),
  migrations: join(root, "platform", "migrations"),
  policyBundleDigest: join(root, "policy", "build", "bundle.sha256"),
});

/** POSIX-style relative path (stable across platforms for digests and reports). */
export const posixRelative = (from: string, to: string): string => relative(from, to).split(sep).join("/");

/**
 * Recursively lists files under `dir` (sorted, deterministic). Skips
 * node_modules, dist, coverage and dot-directories. A missing directory yields [].
 */
export function walkFiles(dir: string, accept: (path: string) => boolean = () => true): string[] {
  const out: string[] = [];
  const visit = (d: string) => {
    let entries: string[];
    try {
      entries = readdirSync(d).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === "node_modules" || name === "dist" || name === "coverage" || name.startsWith(".")) continue;
      const p = join(d, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) visit(p);
      else if (st.isFile() && accept(p)) out.push(p);
    }
  };
  visit(dir);
  return out;
}
