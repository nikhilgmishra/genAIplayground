#!/usr/bin/env node
// Renders docs/PREREQUISITES.md from docs/prerequisites.yaml (the machine-readable source).
//   node docs/tools/render-prerequisites.mjs          # rewrite docs/PREREQUISITES.md
//   node docs/tools/render-prerequisites.mjs --check  # exit 1 if docs/PREREQUISITES.md is stale
// Uses the `yaml` package installed for platform/. No network access.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const check = process.argv.includes("--check");
const require = createRequire(`${root}/platform/package.json`);
const YAML = require("yaml");
const reg = YAML.parse(readFileSync(`${root}/docs/prerequisites.yaml`, "utf8"));

const groups = [
  {
    id: "G1",
    title: "Before any PHI, real record or recording leaves synthetic environments",
    why: "PHI_PROCESSING cannot be requested until these exist. Engineering continues with SYNTHETIC fixtures.",
    ids: ["PRQ-002", "PRQ-003", "PRQ-025", "PRQ-026", "PRQ-027", "PRQ-038", "PRQ-040", "PRQ-047", "PRQ-048"],
  },
  {
    id: "G2",
    title: "Before vendor sandbox integration (Phase 2)",
    why: "Live adapters stay disabled; the configuration guard rejects a live adapter without a VENDOR_SANDBOX_INTEGRATION approval.",
    ids: ["PRQ-004", "PRQ-005", "PRQ-006", "PRQ-023", "PRQ-024", "PRQ-034", "PRQ-035", "PRQ-036", "PRQ-037", "PRQ-052"],
  },
  {
    id: "G3",
    title: "Vendor capability gate (TB-01..TB-10) before relying on native Talkdesk AI",
    why: "Each capability is UNKNOWN until written vendor answers and sandbox tests exist. The consequence column of docs/ARCHITECTURE.md section 5 applies meanwhile.",
    ids: ["PRQ-013", "PRQ-014", "PRQ-015", "PRQ-016", "PRQ-017", "PRQ-018", "PRQ-019", "PRQ-020", "PRQ-021", "PRQ-022"],
  },
  {
    id: "G4",
    title: "Before any billable execution or real telephone test",
    why: "OPS-05: no paid tests without scoped authorization and an approved ceiling.",
    ids: ["PRQ-010", "PRQ-043", "PRQ-045"],
  },
  {
    id: "G5",
    title: "Before protected workflows or a specific intent are enabled",
    why: "Intents without these stay intake or human handoff only.",
    ids: ["PRQ-007", "PRQ-029", "PRQ-030", "PRQ-031", "PRQ-032", "PRQ-033", "PRQ-050"],
  },
  {
    id: "G6",
    title: "Before patient-facing voice, a language or a cohort is accepted",
    why: "Safety, clinical-boundary and language acceptance are human decisions.",
    ids: ["PRQ-008", "PRQ-012", "PRQ-028", "PRQ-044"],
  },
  {
    id: "G7",
    title: "Before traffic migration, production promotion or broad launch",
    why: "Promotion is decided by evidence and named approvals, not a calendar date.",
    ids: ["PRQ-001", "PRQ-009", "PRQ-011", "PRQ-039", "PRQ-041", "PRQ-042", "PRQ-046", "PRQ-049", "PRQ-051"],
  },
];

const byId = new Map(reg.records.map((r) => [r.id, r]));
const seen = new Set();
for (const g of groups) for (const id of g.ids) {
  if (!byId.has(id)) throw new Error(`unknown ${id}`);
  if (seen.has(id)) throw new Error(`dup ${id}`);
  seen.add(id);
}
for (const id of byId.keys()) if (!seen.has(id)) throw new Error(`ungrouped ${id}`);

const esc = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
const ann = (id) => {
  const a = reg.annotations[id] ?? {};
  const parts = [];
  if (a.specRow) parts.push(`spec 5 row ${a.specRow}`);
  if (a.trustBoundary) parts.push(a.trustBoundary);
  if (a.capabilityGate) parts.push(a.capabilityGate);
  if (a.approvalScope && a.approvalScope !== "all") parts.push(`scope ${a.approvalScope}`);
  if (a.approvalRequests?.length) parts.push(a.approvalRequests.length > 4 ? `${a.approvalRequests[0]}..${a.approvalRequests.at(-1)}` : a.approvalRequests.join(", "));
  if (a.vendorQuestions?.length) parts.push(a.vendorQuestions.join(", "));
  return parts.join("; ") || "-";
};

const counts = {};
for (const r of reg.records) counts[r.status] = (counts[r.status] ?? 0) + 1;
const satisfied = reg.records.filter((r) => (r.status === "APPROVED" || r.status === "EVIDENCED") && r.evidenceRef && r.approvalDate).length;

let out = `# Prerequisite register

Human-readable rendering of [\`prerequisites.yaml\`](prerequisites.yaml), which is the
machine-readable source (validated by \`platform/test/docs/prerequisites.test.ts\` against
\`PrerequisiteRecord\` in \`platform/src/protocol/release.ts\`). **Generated file — do not edit
by hand.** Update the YAML, then run \`node docs/tools/render-prerequisites.mjs\`; the docs tests
fail if this file is stale.

As of ${reg.asOf}. No production or vendor account was inspected for this register.

## How to read this register

* **UNKNOWN** — the state of the external artifact cannot be determined from this repository.
* **BLOCKED** — the artifact is known to be missing for engineering use, so the gate cannot pass.
* UNKNOWN and BLOCKED are valid states. **Neither is ever equivalent to approved** (OPS-03).
* Only the named human owner moves a record to \`EVIDENCED\` or \`APPROVED\`, with an
  evidence reference and approval date (and an \`apr_…\` approval record id for \`APPROVED\`).
  The coding agent never sets those fields and cannot create approval records
  ([\`approvals/README.md\`](../approvals/README.md)).
* Evidence must identify the exact tenant, SKU, region, feature and model where relevant.
* Missing secrets block integration execution, not offline coding. Offline work continues
  against SYNTHETIC fixtures (\`platform/src/fixtures/synthetic-world.ts\`).
* "Next action" is the smallest action that unblocks the record. Vendor question ids
  (\`VQ-*\`) are in [\`talkdesk/vendor-questions.md\`](../talkdesk/vendor-questions.md),
  capability gate ids (\`CG-*\`) in [\`talkdesk/capability-gate.md\`](../talkdesk/capability-gate.md)
  and approval requests (\`AR-*\`) in [\`release/approval-requests.md\`](release/approval-requests.md).

## Summary

| Status | Records |
|---|---:|
${Object.entries(counts).sort().map(([s, n]) => `| ${s} | ${n} |`).join("\n")}
| **Total** | **${reg.records.length}** |

Records satisfied (APPROVED or EVIDENCED with evidence and date): **${satisfied}**.

| Gate group | Records |
|---|---|
${groups.map((g) => `| ${g.id} ${g.title} | ${g.ids.join(", ")} |`).join("\n")}
`;

for (const g of groups) {
  out += `\n## ${g.id} ${g.title}\n\n${g.why}\n\n`;
  out += `| ID | Status | Owner | Required artifact | Gate | Env | Blocks | Smallest next action | Cross-refs |\n|---|---|---|---|---|---|---|---|---|\n`;
  for (const id of g.ids) {
    const r = byId.get(id);
    out += `| ${r.id} | ${r.status} | ${esc(r.owner)} | ${esc(r.artifact)} | ${esc(r.gate)} | ${r.environment} | ${esc(r.blocks.join(", "))} | ${esc(r.nextAction)} | ${esc(ann(id))} |\n`;
  }
}

out += `
## Evidence, approval and expiry fields

Every record currently has \`evidenceRef: null\`, \`approvalDate: null\` and \`expiryDate: null\`.
When an owner supplies evidence, record in the YAML: the evidence reference (document id,
ticket or evidence-pack path), the approval date and expiry date (ISO-8601 UTC), and the
environment it applies to. An approval that expires moves the record to \`EXPIRED\`, which
is treated as not approved.

## Related documents

* [\`DECISIONS.md\`](DECISIONS.md) — architecture decision records that depend on these prerequisites.
* [\`security/threat-model.md\`](security/threat-model.md), [\`privacy/data-flow-inventory.md\`](privacy/data-flow-inventory.md), [\`privacy/retention-matrix.md\`](privacy/retention-matrix.md) — engineering drafts awaiting PRQ-003 review.
* [\`capacity-cost-model.md\`](capacity-cost-model.md) — illustrative figures awaiting PRQ-022 and PRQ-046.
* [\`vendor-integration-inventory.md\`](vendor-integration-inventory.md) — integration facts, all UNKNOWN until evidenced.
* [\`release/phase-gates.md\`](release/phase-gates.md) and [\`release/approval-requests.md\`](release/approval-requests.md) — promotion gates and prepared approval requests.
`;

const target = `${root}/docs/PREREQUISITES.md`;
if (check) {
  let current = "";
  try {
    current = readFileSync(target, "utf8");
  } catch {
    current = "";
  }
  if (current !== out) {
    console.error("docs/PREREQUISITES.md is stale: run node docs/tools/render-prerequisites.mjs");
    process.exit(1);
  }
  console.log("docs/PREREQUISITES.md is current;", JSON.stringify(counts));
} else {
  writeFileSync(target, out);
  console.log("wrote docs/PREREQUISITES.md;", JSON.stringify(counts));
}
