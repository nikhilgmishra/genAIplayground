/**
 * Validates the machine-readable prerequisite register (docs/prerequisites.yaml)
 * against the strict protocol schema and the register rules of spec section 5:
 * UNKNOWN and BLOCKED are valid states and never equivalent to approved (OPS-03);
 * approvals and evidence are recorded by humans with references and dates (OPS-05).
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ApprovalScope, PrerequisiteRecord, PrerequisiteStatus } from "../../src/protocol/index.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string): string => readFileSync(resolve(REPO_ROOT, rel), "utf8");

interface Annotation {
  specRow?: number;
  specSection?: string;
  trustBoundary?: string;
  capabilityGate?: string;
  approvalScope?: string;
  approvalRequests?: string[];
  vendorQuestions?: string[];
}

interface Register {
  schemaVersion: string;
  asOf: string;
  recordSchema: string;
  statusMeaning: Record<string, string>;
  records: unknown[];
  annotations: Record<string, Annotation>;
}

const register = parse(read("docs/prerequisites.yaml")) as Register;
const parsed = register.records.map((r) => PrerequisiteRecord.safeParse(r));
const records: PrerequisiteRecord[] = parsed.flatMap((p) => (p.success ? [p.data] : []));

/** The only states that can ever satisfy a gate, and only with evidence and an approval date. */
const SATISFYING = new Set<PrerequisiteRecord["status"]>(["APPROVED", "EVIDENCED"]);

function satisfies(record: PrerequisiteRecord, now: Date): boolean {
  if (!SATISFYING.has(record.status)) return false;
  if (!record.evidenceRef || !record.approvalDate) return false;
  return record.expiryDate === null || Date.parse(record.expiryDate) > now.getTime();
}

describe("docs/prerequisites.yaml", () => {
  it("[SPEC-5.prerequisites] every record matches the strict PrerequisiteRecord schema", () => {
    const failures = parsed
      .map((p, i) => ({ i, p }))
      .filter(({ p }) => !p.success)
      .map(({ i, p }) => `records[${i}]: ${p.success ? "" : p.error.issues.map((x) => `${x.path.join(".")} ${x.message}`).join("; ")}`);
    expect(failures).toEqual([]);
    expect(records.length).toBe(register.records.length);
    expect(records.length).toBeGreaterThanOrEqual(40);
    expect(register.schemaVersion).toBe("vsp.prerequisites.v1");
    expect(register.recordSchema).toBe("platform/src/protocol/release.ts#PrerequisiteRecord");
  });

  it("[SPEC-5.prerequisites] record ids are unique and numbered PRQ-001 upward without gaps", () => {
    const ids = records.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    ids.forEach((id, i) => expect(id).toBe(`PRQ-${String(i + 1).padStart(3, "0")}`));
  });

  it("[OPS-03] no record is APPROVED or EVIDENCED without evidenceRef and approvalDate", () => {
    const offenders = records.filter((r) => SATISFYING.has(r.status) && (!r.evidenceRef || !r.approvalDate)).map((r) => r.id);
    expect(offenders).toEqual([]);
  });

  it("[OPS-03] UNKNOWN and BLOCKED records carry no approval date and never satisfy a gate", () => {
    const now = new Date();
    const open = records.filter((r) => r.status === "UNKNOWN" || r.status === "BLOCKED");
    expect(open.length).toBeGreaterThan(0);
    for (const r of open) {
      expect(r.approvalDate, `${r.id} approvalDate`).toBeNull();
      expect(satisfies(r, now), `${r.id} must not satisfy its gate`).toBe(false);
    }
    // A record with a dated approval and a passed expiry is EXPIRED, never still APPROVED/EVIDENCED.
    const stale = records.filter((r) => SATISFYING.has(r.status) && r.expiryDate !== null && Date.parse(r.expiryDate) <= now.getTime());
    expect(stale.map((r) => r.id)).toEqual([]);
  });

  it("[OPS-03] an approval date never follows its expiry date", () => {
    const inverted = records.filter((r) => r.approvalDate && r.expiryDate && Date.parse(r.expiryDate) <= Date.parse(r.approvalDate));
    expect(inverted.map((r) => r.id)).toEqual([]);
  });

  it("[OPS-05] an APPROVED record cites a human approval record id (apr_...) as its evidence", () => {
    const uncited = records.filter((r) => r.status === "APPROVED" && !/apr_[A-Za-z0-9_-]{8,64}/.test(r.evidenceRef ?? "")).map((r) => r.id);
    expect(uncited).toEqual([]);
  });

  it("[OPS-03] a NOT_APPLICABLE record states its reason in nextAction", () => {
    const silent = records.filter((r) => r.status === "NOT_APPLICABLE" && !/not applicable|does not apply/i.test(r.nextAction)).map((r) => r.id);
    expect(silent).toEqual([]);
  });

  it("[SPEC-5.prerequisites] status vocabulary matches the protocol enum", () => {
    expect(Object.keys(register.statusMeaning).sort()).toEqual([...PrerequisiteStatus.options].sort());
  });

  it("[SPEC-5.prerequisites] all twelve spec section 5 owner rows are present exactly once", () => {
    const rows = Object.values(register.annotations)
      .map((a) => a.specRow)
      .filter((n): n is number => typeof n === "number")
      .sort((a, b) => a - b);
    expect(rows).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("[SPEC-3.trust-boundaries] every trust-boundary capability TB-01..TB-10 has a prerequisite record", () => {
    const architecture = read("docs/ARCHITECTURE.md");
    for (let n = 1; n <= 10; n++) {
      const tb = `TB-${String(n).padStart(2, "0")}`;
      expect(architecture).toContain(`| ${tb} |`);
      const ids = Object.entries(register.annotations)
        .filter(([, a]) => a.trustBoundary === tb)
        .map(([id]) => id);
      expect(ids, tb).toHaveLength(1);
      const rec = records.find((r) => r.id === ids[0]);
      expect(rec?.artifact.startsWith(`${tb}:`), `${tb} artifact text`).toBe(true);
    }
  });

  it("[SPEC-5.prerequisites] every record names a next action and what it blocks; annotations reference existing ids", () => {
    for (const r of records) {
      expect(r.nextAction.trim().length, r.id).toBeGreaterThanOrEqual(5);
      expect(r.blocks.length, `${r.id} blocks`).toBeGreaterThan(0);
    }
    const ids = new Set(records.map((r) => r.id));
    for (const key of Object.keys(register.annotations)) expect(ids.has(key), key).toBe(true);
    for (const id of ids) expect(register.annotations[id], `annotation for ${id}`).toBeDefined();
  });

  it("[OPS-05] approval scopes in annotations are protocol ApprovalScope values", () => {
    for (const [id, a] of Object.entries(register.annotations)) {
      if (a.approvalScope === undefined || a.approvalScope === "all") continue;
      expect(ApprovalScope.safeParse(a.approvalScope).success, `${id} ${a.approvalScope}`).toBe(true);
    }
  });

  it("[SPEC-5.prerequisites] vendor question and approval request references exist in their source documents", () => {
    const questions = read("talkdesk/vendor-questions.md");
    const requests = read("docs/release/approval-requests.md");
    for (const [id, a] of Object.entries(register.annotations)) {
      for (const q of a.vendorQuestions ?? []) expect(questions.includes(`| ${q} |`), `${id} -> ${q}`).toBe(true);
      for (const ar of a.approvalRequests ?? []) expect(requests.includes(`## ${ar} `), `${id} -> ${ar}`).toBe(true);
    }
  });

  it("[SPEC-16.handoff] docs/PREREQUISITES.md is the current rendering of the YAML (render-prerequisites --check)", () => {
    const run = spawnSync(process.execPath, [resolve(REPO_ROOT, "docs/tools/render-prerequisites.mjs"), "--check"], { encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
  });

  it("[SPEC-16.handoff] docs/PREREQUISITES.md renders every record with its current status", () => {
    const md = read("docs/PREREQUISITES.md");
    for (const r of records) {
      const row = md.split("\n").find((line) => line.startsWith(`| ${r.id} |`));
      expect(row, `${r.id} row`).toBeDefined();
      expect(row, `${r.id} status`).toContain(`| ${r.status} |`);
    }
  });
});
