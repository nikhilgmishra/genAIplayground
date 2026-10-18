#!/usr/bin/env node
// Workflow security lint for .github/workflows/*.yml (actionlint is not available in
// the authoring environment). Parses every workflow with the `yaml` package and checks:
//   - top-level `permissions` exists and grants only contents: read;
//   - job-level permissions never grant write except id-token / attestations, and
//     id-token: write only appears in release.yml / deploy.yml;
//   - no pull_request_target trigger; deploy.yml is workflow_dispatch only;
//   - every `uses:` is from an approved owner, has an @version ref and carries the
//     "pin to full commit SHA before production" marker (or is already a 40-hex SHA);
//   - no `${{ inputs.* }}`, `${{ github.event.* }}` or `${{ github.head_ref }}` inside
//     `run:` scripts (script injection); values go through `env:` instead;
//   - jobs that use an `environment` named after a deploy target are only in deploy.yml.
//   node scripts/ci/check-workflows.mjs [dir]
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(join(ROOT, "platform", "package.json"));
const YAML = require("yaml");

const APPROVED_OWNERS = ["actions/", "aws-actions/", "docker/"];
const ID_TOKEN_WORKFLOWS = new Set(["release.yml", "deploy.yml"]);
const INJECTION = /\$\{\{\s*(inputs\.|github\.event\.|github\.head_ref)/;
const SHA_REF = /@[0-9a-f]{40}$/;

export function lintWorkflow(fileName, text) {
  const problems = [];
  let doc;
  try {
    doc = YAML.parse(text);
  } catch (err) {
    return [`${fileName}: YAML parse error: ${err.message.split("\n")[0]}`];
  }
  if (!doc || typeof doc !== "object") return [`${fileName}: empty workflow`];
  const on = doc.on ?? doc[true];
  const triggers = typeof on === "string" ? [on] : Array.isArray(on) ? on : Object.keys(on ?? {});
  if (triggers.includes("pull_request_target")) problems.push(`${fileName}: pull_request_target is not allowed`);
  if (fileName === "deploy.yml" && (triggers.length !== 1 || triggers[0] !== "workflow_dispatch")) {
    problems.push(`${fileName}: deploy must be workflow_dispatch only`);
  }

  const top = doc.permissions;
  if (!top || typeof top !== "object" || Object.keys(top).length !== 1 || top.contents !== "read") {
    problems.push(`${fileName}: top-level permissions must be exactly { contents: read }`);
  }

  const lines = text.split("\n");
  for (const [i, line] of lines.entries()) {
    const m = line.match(/^\s*(?:-\s*)?uses:\s*([^\s#]+)\s*(#.*)?$/);
    if (!m) continue;
    const ref = m[1];
    const comment = m[2] ?? "";
    if (ref.startsWith("./")) continue;
    if (!APPROVED_OWNERS.some((o) => ref.startsWith(o))) problems.push(`${fileName}:${i + 1}: action owner not approved: ${ref}`);
    if (!/@[^@]+$/.test(ref)) problems.push(`${fileName}:${i + 1}: action without a version ref: ${ref}`);
    if (!SHA_REF.test(ref) && !/pin to full commit SHA before production/.test(comment)) {
      problems.push(`${fileName}:${i + 1}: tag-pinned action lacks the SHA-pinning prerequisite marker: ${ref}`);
    }
  }

  for (const [jobId, job] of Object.entries(doc.jobs ?? {})) {
    const perms = job.permissions ?? {};
    for (const [scope, level] of Object.entries(perms)) {
      if (level === "write" && !["id-token", "attestations"].includes(scope)) problems.push(`${fileName}:${jobId}: write permission on ${scope}`);
      if (scope === "id-token" && level === "write" && !ID_TOKEN_WORKFLOWS.has(fileName)) problems.push(`${fileName}:${jobId}: id-token: write outside release/deploy`);
    }
    const envName = typeof job.environment === "string" ? job.environment : job.environment?.name;
    if (envName && /sandbox|staging|production|inputs\.environment/.test(envName) && fileName !== "deploy.yml") {
      problems.push(`${fileName}:${jobId}: deployment environments are only used by deploy.yml`);
    }
    for (const [idx, step] of (job.steps ?? []).entries()) {
      if (typeof step.run === "string" && INJECTION.test(step.run)) {
        problems.push(`${fileName}:${jobId}:step${idx + 1}: untrusted expression inside run (pass it through env)`);
      }
    }
  }
  return problems;
}

function main() {
  const dir = process.argv[2] ?? join(ROOT, ".github", "workflows");
  const files = readdirSync(dir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
  const problems = files.flatMap((f) => lintWorkflow(f, readFileSync(join(dir, f), "utf8")));
  if (problems.length > 0) {
    for (const p of problems) process.stderr.write(`check-workflows: ${p}\n`);
    process.exit(1);
  }
  process.stdout.write(`check-workflows: ok (${files.length} workflows: ${files.join(", ")})\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
