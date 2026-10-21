/**
 * Decision-gated technology checker (WP-06; FO-03-25 EventBridge fan-out, FO-08-17 graph retrieval,
 * FO-08-35 semantic caches, FO-23-08 Personal Agent Protocol). A gated technology may appear in a package
 * manifest, the lockfile, an import, a declared module kind or a declared cache only when its register entry
 * (platform/architecture/modules.yaml decisionGates) records an Accepted ADR under docs/adr/ (not
 * docs/adr/proposed/), plus the extra evidence the gate names: an evaluation report for graph retrieval, the
 * FO-07-42 key and the disclosure re-check on return for a semantic cache.
 *
 * It takes the repository root and the register document as inputs, so the suite can run it over fixture
 * trees as well as the repository.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { importSpecifiers, sourceFiles, type DecisionGate, type RegisterDoc } from "./support.js";

export interface GateFinding {
  gate: string;
  requirementId: string;
  source: "manifest" | "lockfile" | "import" | "module" | "cache" | "decision";
  where: string;
  detail: string;
}

const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every package.json of the workspace: the root, each top-level package and services/*. */
export function manifestPaths(root: string): string[] {
  const out = existsSync(join(root, "package.json")) ? ["package.json"] : [];
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory() || dir.name === "node_modules" || dir.name.startsWith(".")) continue;
    if (existsSync(join(root, dir.name, "package.json"))) out.push(`${dir.name}/package.json`);
    if (dir.name === "services") {
      for (const s of readdirSync(join(root, "services"), { withFileTypes: true })) {
        if (s.isDirectory() && existsSync(join(root, "services", s.name, "package.json"))) out.push(`services/${s.name}/package.json`);
      }
    }
  }
  return out.sort();
}

/** Why a recorded decision does not (yet) qualify the gate, or null when it does. */
export function decisionProblem(root: string, gate: DecisionGate, doc: RegisterDoc): string | null {
  const d = gate.decision;
  if (d === null) return "no decision recorded";
  if (!/^docs\/adr\/ADR-\d{4}-[a-z0-9-]+\.md$/.test(d.adr)) return `decision.adr ${d.adr} is not an ADR under docs/adr/ (proposed ADRs do not qualify)`;
  if (!existsSync(join(root, d.adr))) return `decision.adr ${d.adr} does not exist`;
  const text = readFileSync(join(root, d.adr), "utf8");
  const status = /^\|\s*Status\s*\|([^\n]*)$/im.exec(text)?.[1] ?? /^Status:\s*([^\n]*)$/im.exec(text)?.[1] ?? "";
  if (!/\baccepted\b/i.test(status) || /\bsuperseded\b|\bproposed\b|\brejected\b/i.test(status)) return `ADR ${d.adr} status is not Accepted ("${status.trim().slice(0, 60)}")`;
  if (gate.requiresEvaluationReport) {
    const report = d.evaluationReport;
    if (!report || !report.startsWith(gate.requiresEvaluationReport) || !existsSync(join(root, report))) return `an evaluation report under ${gate.requiresEvaluationReport} showing measured gains is required`;
  }
  if (gate.requiresKeyRequirement) {
    const kinds = new Set(gate.cacheKinds ?? []);
    const tag = `[${gate.requirementId}]`;
    const tested = (f: string | undefined) => f !== undefined && /\.test\.tsx?$/.test(f) && existsSync(join(root, f)) && readFileSync(join(root, f), "utf8").includes(tag);
    const bad = doc.caches.filter((c) => kinds.has(c.cacheKind) && (c.keyRequirement !== gate.requiresKeyRequirement || c.disclosureRecheck !== true || !tested(c.recheckTest)));
    if (bad.length > 0) return `cache ${bad[0]!.file} must declare keyRequirement ${gate.requiresKeyRequirement}, disclosureRecheck: true and a recheckTest tagged ${tag}`;
  }
  return null;
}

/** All uses of decision-gated technologies that are not qualified by an Accepted ADR. */
export function checkDecisionGates(root: string, doc: RegisterDoc, sourceDirs: readonly string[]): GateFinding[] {
  const findings: GateFinding[] = [];
  const manifests = manifestPaths(root).map((p) => ({ p, json: JSON.parse(readFileSync(join(root, p), "utf8")) as Record<string, unknown> }));
  const lock = existsSync(join(root, "pnpm-lock.yaml")) ? readFileSync(join(root, "pnpm-lock.yaml"), "utf8") : "";
  const imports = sourceFiles(root, sourceDirs).flatMap((f) => importSpecifiers(readFileSync(join(root, f), "utf8")).map((spec) => ({ f, spec })));

  for (const gate of doc.decisionGates) {
    const uses: GateFinding[] = [];
    const add = (source: GateFinding["source"], where: string, detail: string) => uses.push({ gate: gate.id, requirementId: gate.requirementId, source, where, detail });
    for (const { p, json } of manifests) {
      for (const field of DEP_FIELDS) {
        const deps = (json[field] ?? {}) as Record<string, string>;
        for (const name of Object.keys(deps)) if (gate.packages.includes(name)) add("manifest", p, `${field}.${name}`);
      }
    }
    for (const name of gate.packages) {
      const re = new RegExp(`(?:^|[\\s'"/])${esc(name)}(?:@\\d|'?:)`, "m");
      if (re.test(lock)) add("lockfile", "pnpm-lock.yaml", name);
    }
    const patterns = gate.importPatterns.map((s) => new RegExp(s));
    for (const { f, spec } of imports) if (patterns.some((re) => re.test(spec))) add("import", f, spec);
    for (const m of doc.modules) if (gate.moduleKinds.includes(m.kind)) add("module", "platform/architecture/modules.yaml", `module ${m.id} has kind ${m.kind}`);
    for (const c of doc.caches) if ((gate.cacheKinds ?? []).includes(c.cacheKind)) add("cache", c.file, `cacheKind ${c.cacheKind}`);

    if (uses.length === 0) continue;
    const problem = decisionProblem(root, gate, doc);
    if (problem !== null) {
      findings.push(...uses);
      if (gate.decision !== null) findings.push({ gate: gate.id, requirementId: gate.requirementId, source: "decision", where: "platform/architecture/modules.yaml", detail: problem });
    }
  }
  return findings;
}
