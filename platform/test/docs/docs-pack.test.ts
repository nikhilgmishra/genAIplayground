/**
 * Structural checks over the discovery and governance documentation pack (docs/**
 * excluding docs/ARCHITECTURE.md, docs/spec, docs/release and docs/requirements,
 * which other owners maintain). These checks keep the handoff documents honest:
 * links resolve, every runbook and ADR has its required sections, retention
 * durations are never invented, the threat model covers spec section 14, and the
 * capacity figures cannot drift from the reproducible script.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DataClass } from "../../src/protocol/index.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DOCS = join(REPO_ROOT, "docs");
const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), "utf8");

const NOT_OWNED = new Set(["docs/ARCHITECTURE.md"]);
const NOT_OWNED_DIRS = ["docs/spec/", "docs/release/", "docs/requirements/"];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const ownedDocs = walk(DOCS)
  .map((f) => relative(REPO_ROOT, f).split("\\").join("/"))
  .filter((f) => f.endsWith(".md") && !NOT_OWNED.has(f) && !NOT_OWNED_DIRS.some((d) => f.startsWith(d)))
  .sort();

const stripCode = (md: string): string => md.replace(/```[\s\S]*?```/g, "");

/** Splits a markdown table row into trimmed cells (escaped pipes are kept inside cells). */
function cells(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim());
}

describe("documentation pack", () => {
  it("[SPEC-16.handoff] the pack contains every required handoff document", () => {
    for (const rel of [
      "docs/INVENTORY.md",
      "docs/PREREQUISITES.md",
      "docs/prerequisites.yaml",
      "docs/DECISIONS.md",
      "docs/IMPLEMENTATION_STATUS.md",
      "docs/TEST_EVIDENCE.md",
      "docs/RUNBOOKS/README.md",
      "docs/security/threat-model.md",
      "docs/security/permission-matrix.md",
      "docs/privacy/data-flow-inventory.md",
      "docs/privacy/retention-matrix.md",
      "docs/capacity-cost-model.md",
      "docs/vendor-integration-inventory.md",
      "scripts/capacity_model.py",
    ]) {
      expect(existsSync(join(REPO_ROOT, rel)), rel).toBe(true);
    }
  });

  it("[SPEC-16.handoff] every relative markdown link resolves to an existing path or one listed in docs/ARCHITECTURE.md", () => {
    const architecture = read("docs/ARCHITECTURE.md");
    const broken: string[] = [];
    for (const file of ownedDocs) {
      const body = stripCode(read(file));
      for (const m of body.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
        const target = m[1] ?? "";
        if (/^(https?:|mailto:|#)/.test(target)) continue;
        const pathPart = target.split("#")[0] ?? "";
        if (pathPart === "") continue;
        const abs = resolve(REPO_ROOT, dirname(file), pathPart);
        const repoRel = relative(REPO_ROOT, abs).split("\\").join("/");
        if (repoRel.startsWith("..")) {
          broken.push(`${file} -> ${target} (outside repository)`);
          continue;
        }
        if (!existsSync(abs) && !architecture.includes(`\`${repoRel.replace(/\/$/, "")}`)) broken.push(`${file} -> ${target}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it("[SPEC-16.handoff] status documents carry the release status vocabulary", () => {
    const status = read("docs/IMPLEMENTATION_STATUS.md");
    for (const s of ["IMPLEMENTED_OFFLINE", "VERIFIED_SANDBOX", "APPROVED_PILOT", "VERIFIED_PRODUCTION", "BLOCKED", "NOT_RUN"]) {
      expect(status, s).toContain(`\`${s}\``);
    }
    const evidence = read("docs/TEST_EVIDENCE.md");
    for (const s of ["PASS", "FAIL", "INCONCLUSIVE", "NOT_RUN", "BLOCKED"]) expect(evidence, s).toContain(`\`${s}\``);
    expect(evidence).toContain("Missing evidence is INCONCLUSIVE, never PASS");
  });

  it("[OPS-03] the pack never claims compliance or production readiness affirmatively", () => {
    const offenders: string[] = [];
    for (const file of ownedDocs) {
      read(file)
        .split("\n")
        .forEach((line, i) => {
          if (/HIPAA[- ]complian(t|ce)|production[- ]read(y|iness)/i.test(line) && !/\b(not|never|no|cannot|without)\b|n't/i.test(line)) {
            offenders.push(`${file}:${i + 1}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });

  it("[DATA-01] phone-number-shaped strings in the pack are fictional 555-01xx numbers only", () => {
    const offenders: string[] = [];
    for (const file of ownedDocs) {
      for (const m of read(file).matchAll(/(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g)) {
        if (!/555[\s.-]?01\d\d/.test(m[0])) offenders.push(`${file}: ${m[0].length} chars`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("architecture decision records", () => {
  const adrDir = join(DOCS, "adr");
  const adrFiles = readdirSync(adrDir)
    .filter((f) => /^ADR-\d{4}-[a-z0-9-]+\.md$/.test(f))
    .sort();

  it("[SPEC-16.decisions] ADR-0001..ADR-0010 exist with contiguous numbering", () => {
    const numbers = adrFiles.map((f) => Number(f.slice(4, 8)));
    expect(numbers.length).toBeGreaterThanOrEqual(10);
    numbers.forEach((n, i) => expect(n).toBe(i + 1));
  });

  it("[SPEC-16.decisions] every ADR states status, context, decision, consequences, alternatives and linked requirements", () => {
    for (const f of adrFiles) {
      const body = readFileSync(join(adrDir, f), "utf8");
      expect(body.startsWith(`# ${f.slice(0, 8)} `), `${f} title`).toBe(true);
      expect(body, `${f} status`).toMatch(/^\| Status \| .*(Accepted for engineering|Pending human approval|Superseded by ADR-\d{4}|Rejected)/m);
      for (const h of ["## Context", "## Decision", "## Consequences", "## Alternatives considered", "## Linked requirements"]) {
        expect(body, `${f} ${h}`).toContain(`\n${h}\n`);
      }
      expect(body, `${f} links requirement ids`).toMatch(/\b(AUTH|DATA|ACT|SAFE|OPS)-0\d\b/);
    }
  });

  it("[SPEC-16.decisions] DECISIONS.md indexes every ADR file", () => {
    const index = read("docs/DECISIONS.md");
    for (const f of adrFiles) expect(index, f).toContain(`(adr/${f})`);
  });
});

describe("runbooks", () => {
  const dir = join(DOCS, "RUNBOOKS");
  const runbooks = readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .sort();
  const index = readFileSync(join(dir, "README.md"), "utf8");
  const REQUIRED = [
    "phi-exposure",
    "unsafe-output",
    "failed-safety-transfer",
    "authentication-bypass",
    "dependency-outage",
    "unexpected-spending",
    "duplicate-commit",
    "vendor-behavior-change",
    "ai-off-route",
    "kill-switch-operations",
    "reconciliation-and-dlq-repair",
    "audit-sink-outage",
    "restore-drill",
    "regional-failover",
    "secret-rotation",
    "access-review",
    "policy-release",
    "knowledge-release",
  ];

  it("[SPEC-13.runbooks] every required runbook exists and is linked from the index", () => {
    for (const name of REQUIRED) {
      expect(runbooks, name).toContain(`${name}.md`);
      expect(index, `${name} indexed`).toContain(`](${name}.md)`);
    }
  });

  it("[SPEC-13.runbooks] every runbook has detection, severity, containment, evidence, steps, verification, roles and drill sections", () => {
    for (const f of runbooks) {
      const body = readFileSync(join(dir, f), "utf8");
      expect(body, `${f} id`).toMatch(/^\| Runbook id \| RB-[A-Z-]+/m);
      expect(body, `${f} severity`).toMatch(/^\| Severity \| \S/m);
      expect(body, `${f} last drilled`).toContain("| Last drilled | NEVER (not yet run) |");
      for (const h of ["## Trigger and detection signals", "## Immediate containment", "## Evidence preservation", "## Step-by-step actions", "## Verification", "## Communication roles", "## Drill requirement"]) {
        expect(body, `${f} ${h}`).toMatch(new RegExp(`\\n${h.replace(/[()]/g, "\\$&")}( \\([^)]*\\))?\\n`));
      }
      const evidence = body.split("## Evidence preservation")[1]?.split("\n## ")[0] ?? "";
      expect(evidence, `${f} reporting obligations belong to privacy counsel`).toMatch(/Privacy counsel determines/);
      const id = /^\| Runbook id \| (RB-[A-Z-]+)/m.exec(body)?.[1] ?? "";
      expect(index, `${f} id ${id} in index`).toContain(id);
    }
  });

  it("[SPEC-13.runbooks] every alarm runbook id referenced by infrastructure maps to a runbook", () => {
    const alarmText = [read("infra/terraform/modules/observability/main.tf"), read("infra/terraform/modules/sqs/main.tf")].join("\n");
    const ids = new Set([...alarmText.matchAll(/Runbook (RB-[A-Z-]+)/g)].map((m) => m[1] ?? ""));
    expect(ids.size).toBeGreaterThan(0);
    for (const id of ids) expect(index, id).toContain(id);
  });
});

describe("privacy documents", () => {
  it("[DATA-03] the retention matrix covers all four data classes and never invents a duration", () => {
    const md = read("docs/privacy/retention-matrix.md");
    for (const cls of DataClass.options) expect(md, cls).toContain(`\`${cls}\``);
    expect(md).not.toMatch(/\b\d+\s*(seconds?|minutes?|hours?|days?|weeks?|months?|years?)\b/i);
    const allowed = /TO BE SET BY PRIVACY COUNSEL|Not persisted|Owner's approved schedule|Until verified shipment/;
    let rows = 0;
    let durationCol = -1;
    for (const line of md.split("\n")) {
      if (!line.startsWith("|")) {
        durationCol = -1;
        continue;
      }
      const c = cells(line);
      if (c.includes("Retention duration")) {
        durationCol = c.indexOf("Retention duration");
        continue;
      }
      if (durationCol < 0 || /^-+$/.test(c[0]?.replace(/:/g, "") ?? "")) continue;
      rows++;
      expect(c[durationCol] ?? "", line).toMatch(allowed);
    }
    expect(rows).toBeGreaterThanOrEqual(12);
  });

  it("[DATA-02] the data-flow inventory treats raw audio as sensitive even after transcript redaction", () => {
    const md = read("docs/privacy/data-flow-inventory.md");
    expect(md).toContain("Raw audio remains sensitive even if the transcript is later redacted");
    expect(md).toContain("```mermaid");
    for (const id of ["DF-03", "DF-07", "DF-08", "DF-09", "DF-10", "DF-11", "DF-12", "DF-13", "DF-14", "DF-15", "DF-16", "DF-18", "DF-19", "DF-21", "DF-22"]) {
      expect(md, id).toContain(`| ${id} |`);
    }
  });
});

describe("threat model", () => {
  const md = read("docs/security/threat-model.md");
  const rows = md.split("\n").filter((l) => /^\| T-\d{2} \|/.test(l));

  it("[SPEC-14.threat-model] covers every spec section 14 threat and the Talkdesk-specific threats", () => {
    const names = rows.map((r) => (cells(r)[1] ?? "").toLowerCase());
    for (const t of [
      "caller spoofing",
      "sim swap",
      "account enumeration",
      "session fixation",
      "replay",
      "cross-tenant access",
      "confused-deputy tools",
      "prompt injection through speech",
      "prompt injection through documents",
      "data exfiltration",
      "malicious urls",
      "server-side request forgery",
      "forged webhooks",
      "unauthorised callbacks",
      "approval replay",
      "insider access",
      "secret leakage",
      "supply-chain changes",
      "denial of service",
      "auth gate misinitialisation",
      "model mutates trusted session fields",
      "guardrail termination of a crisis flow",
      "arbitrary dial targets",
    ]) {
      expect(names, t).toContain(t);
    }
  });

  it("[SPEC-14.threat-model] every threat row has attack path, mitigation, enforcement, tests, residual risk and a valid status", () => {
    const ids = rows.map((r) => cells(r)[0]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of rows) {
      const c = cells(r);
      expect(c, r.slice(0, 12)).toHaveLength(9);
      for (const cell of c) expect(cell.length, `${c[0]} empty cell`).toBeGreaterThan(0);
      expect(c[8], `${c[0]} status`).toMatch(/IMPLEMENTED_OFFLINE|IN_PROGRESS|BLOCKED|UNKNOWN/);
    }
  });
});

const python = spawnSync("python3", ["--version"], { encoding: "utf8" });
const pythonAvailable = python.status === 0;

describe("capacity model", () => {
  it.skipIf(!pythonAvailable)("[SPEC-12.capacity] scripts/capacity_model.py reproduces every spec section 12 figure (exit 0)", () => {
    const run = spawnSync("python3", ["-I", join(REPO_ROOT, "scripts/capacity_model.py")], { encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("checks: PASS");
  });

  it.skipIf(!pythonAvailable)("[SPEC-12.capacity] the tables embedded in docs/capacity-cost-model.md match the script output", () => {
    const run = spawnSync("python3", ["-I", join(REPO_ROOT, "scripts/capacity_model.py"), "--markdown"], { encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    const doc = read("docs/capacity-cost-model.md");
    const embedded = /<!-- capacity-model:begin[^>]*-->\n([\s\S]*?)<!-- capacity-model:end -->/.exec(doc)?.[1] ?? "";
    expect(embedded.trim()).toBe(run.stdout.trim());
  });

  it("[SPEC-12.capacity] the capacity document labels inputs as illustrative and lists separately contracted quotas", () => {
    const doc = read("docs/capacity-cost-model.md");
    expect(doc).toContain("illustrative planning assumption");
    for (const q of ["trunks", "Call starts", "Media legs", "AI sessions", "ASR and TTS", "token throughput", "MCP tool calls", "Exports", "Salesforce API", "Notifications", "Workflow executions"]) {
      expect(doc, q).toContain(q);
    }
  });
});
