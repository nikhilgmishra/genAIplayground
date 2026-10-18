import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadApprovalRecords } from "../config/approvals.js";
import { REPO_ROOT, type OpaWasmPolicyEngine } from "./engine.js";
import { loadTestEngine } from "./fixtures/inputs.fixture.js";
import {
  APPROVED_EXPANSIONS_FILE,
  GoldenProbeFile,
  PROBES_FILE,
  compareProbe,
  evaluateProbe,
  findExpansions,
  loadApprovedExpansions,
  loadProbeFile,
  resolveApprovedExpansions,
  serializeProbeFile,
  type GoldenExpectation,
  type GoldenProbe,
} from "./golden.js";
import { buildProbeFile } from "./golden-matrix.js";

const probeFile = loadProbeFile(PROBES_FILE);
const approvedEntries = loadApprovedExpansions(APPROVED_EXPANSIONS_FILE);
const approvalRecords = loadApprovalRecords(join(REPO_ROOT, "approvals")).records.map((r) => ({ approvalId: r.approvalId, scope: r.scope }));
const { approved, rejected } = resolveApprovedExpansions(approvedEntries, approvalRecords);

let engine: OpaWasmPolicyEngine;
beforeAll(async () => {
  engine = await loadTestEngine();
});

describe("golden probe corpus", () => {
  it("[SPEC-14.policy-expansion] probes.json is schema-valid, has at least 150 probes and covers both entrypoints", () => {
    expect(GoldenProbeFile.safeParse(JSON.parse(readFileSync(PROBES_FILE, "utf8"))).success).toBe(true);
    expect(probeFile.probes.length).toBeGreaterThanOrEqual(150);
    expect(probeFile.probes.some((p) => p.entrypoint === "console")).toBe(true);
    expect(probeFile.probes.filter((p) => !p.expected.allow).length).toBeGreaterThan(probeFile.probes.length / 2);
  });

  it("[SPEC-14.policy-expansion] probes.json is exactly what the declarative matrix generates (no hand edits)", () => {
    const generated = buildProbeFile(engine.catalogue, engine.policyVersion);
    expect(serializeProbeFile(generated)).toBe(readFileSync(PROBES_FILE, "utf8"));
  });

  it("[SPEC-14.policy-expansion] probe file serialization round-trips", () => {
    expect(GoldenProbeFile.parse(JSON.parse(serializeProbeFile(probeFile)))).toEqual(probeFile);
  });

  it("[SPEC-14.policy-expansion] approved expansions are schema-valid and each references a probe and a POLICY_RELEASE approval record", () => {
    const ids = new Set(probeFile.probes.map((p) => p.id));
    for (const e of approvedEntries) expect(ids.has(e.probeId), e.probeId).toBe(true);
    expect(rejected).toEqual([]);
    // No approval records exist in this repository: the coding agent cannot create them.
    expect(approved.size).toBe(approvedEntries.length);
  });
});

describe.each(["authz", "console"] as const)("golden probes through the WASM engine (%s)", (entrypoint) => {
  const probes = probeFile.probes.filter((p) => p.entrypoint === entrypoint);
  it.each(probes.map((p) => [p.id, p] as const))(`[SPEC-14.policy-expansion] %s`, (_id, probe) => {
    const result = compareProbe(probe, evaluateProbe(engine, probe as GoldenProbe), approved);
    if (result.outcome === "SILENT_EXPANSION") {
      throw new Error(`SILENT ACCESS EXPANSION ${probe.id}: ${result.expansion.join(",")} ${result.diffs.join("; ")}`);
    }
    expect(result.outcome === "MATCH" || result.outcome === "APPROVED_EXPANSION", `${result.outcome}: ${result.diffs.join("; ")}`).toBe(true);
  });
});

describe("native OPA and WASM agree", () => {
  it("[SPEC-14.policy-expansion] [OPS-06] every probe decides identically under native opa eval (what opa test runs) and the WASM bundle", () => {
    const dir = mkdtempSync(join(tmpdir(), "vsp-parity-"));
    try {
      const authz = probeFile.probes.filter((p) => p.entrypoint === "authz").map((p) => ({ id: p.id, input: p.input }));
      const consoleProbes = probeFile.probes.filter((p) => p.entrypoint === "console").map((p) => ({ id: p.id, input: p.input }));
      writeFileSync(join(dir, "data.json"), JSON.stringify({ golden_parity: { authz, console: consoleProbes } }));
      // Bind the probe input to a local first: `with input as p.input` (a ref whose path
      // contains the key "input") does not bind as expected inside a comprehension in OPA 1.21.
      const query =
        "x := {" +
        '"authz": {p.id: d | some p in data.golden_parity.authz; probe := p.input; d := data.vsp.authz.decision with input as probe}, ' +
        '"console": {p.id: d | some p in data.golden_parity.console; probe := p.input; d := data.vsp.console.decision with input as probe}}';
      const out = execFileSync(join(REPO_ROOT, ".tools", "opa"), ["eval", "--format", "json", "-d", join(REPO_ROOT, "policy", "vsp"), "--ignore", "*_test.rego", "-d", join(dir, "data.json"), query], {
        maxBuffer: 64 * 1024 * 1024,
        timeout: 120_000,
      });
      const parsed = JSON.parse(out.toString("utf8")) as { result: { bindings: { x: Record<"authz" | "console", Record<string, GoldenExpectation & { fieldMask?: string[] }>> } }[] };
      const native = parsed.result[0]!.bindings.x;
      let compared = 0;
      for (const p of probeFile.probes) {
        const n = native[p.entrypoint][p.id];
        expect(n, p.id).toBeDefined();
        const wasm = evaluateProbe(engine, p);
        expect({ allow: n!.allow, reasonCodes: n!.reasonCodes, fieldMask: n!.fieldMask ?? [], obligations: n!.obligations }, p.id).toEqual(wasm);
        compared += 1;
      }
      expect(compared).toBe(probeFile.probes.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("expansion gate logic", () => {
  const deny: GoldenExpectation = { allow: false, reasonCodes: ["RELATIONSHIP_NOT_ESTABLISHED"], fieldMask: [], obligations: [] };
  const allow: GoldenExpectation = { allow: true, reasonCodes: ["ALLOW_SELF"], fieldMask: ["startsAt", "status"], obligations: ["AUDIT_READ"] };
  const probe = (id: string, expected: GoldenExpectation) => ({ id, expected });

  it("[SPEC-14.policy-expansion] a deny probe that now allows is a SILENT_EXPANSION unless approved", () => {
    expect(compareProbe(probe("authz.x.deny", deny), allow, new Set()).outcome).toBe("SILENT_EXPANSION");
    expect(compareProbe(probe("authz.x.deny", deny), allow, new Set(["authz.x.deny"])).outcome).toBe("APPROVED_EXPANSION");
  });

  it("[SPEC-14.policy-expansion] a wider field mask or a dropped obligation is an expansion", () => {
    expect(compareProbe(probe("authz.x.allow", allow), { ...allow, fieldMask: [...allow.fieldMask, "subjectId"] }, new Set())).toMatchObject({ outcome: "SILENT_EXPANSION", expansion: ["FIELD_MASK_WIDENED"] });
    expect(compareProbe(probe("authz.x.allow", allow), { ...allow, obligations: [] }, new Set())).toMatchObject({ outcome: "SILENT_EXPANSION", expansion: ["OBLIGATION_REMOVED"] });
    const humanDeny = { ...deny, reasonCodes: ["HUMAN_BOUNDARY"], obligations: ["REQUIRE_HUMAN"] };
    expect(compareProbe(probe("authz.x.hb", humanDeny), { ...humanDeny, obligations: [] }, new Set()).expansion).toEqual(["OBLIGATION_REMOVED"]);
  });

  it("[SPEC-14.policy-expansion] tightening is a mismatch (fails) but never an expansion", () => {
    expect(compareProbe(probe("authz.x.allow", allow), deny, new Set())).toMatchObject({ outcome: "MISMATCH", expansion: [] });
    expect(compareProbe(probe("authz.x.deny", deny), { ...deny, reasonCodes: ["SESSION_INVALID"] }, new Set()).outcome).toBe("MISMATCH");
    expect(compareProbe(probe("authz.x.allow", allow), allow, new Set()).outcome).toBe("MATCH");
  });

  it("[SPEC-14.policy-expansion] file-to-file gate flags flips, removed probes and rewritten deny probes", () => {
    const base = probeFile;
    const denyProbe = base.probes.find((p) => !p.expected.allow && p.entrypoint === "authz")!;
    const allowProbe = base.probes.find((p) => p.expected.allow && p.entrypoint === "authz")!;
    const flipped: GoldenProbeFile = { ...base, probes: base.probes.map((p) => (p.id === denyProbe.id ? { ...p, expected: allowProbe.expected } : p)) };
    expect(findExpansions(base, flipped, new Set())).toEqual([{ probeId: denyProbe.id, kinds: ["ALLOW_FLIP"], approved: false }]);
    expect(findExpansions(base, flipped, new Set([denyProbe.id]))[0]?.approved).toBe(true);
    const removed: GoldenProbeFile = { ...base, probes: base.probes.filter((p) => p.id !== denyProbe.id), probeCount: base.probes.length - 1 };
    expect(findExpansions(base, removed, new Set())).toEqual([{ probeId: denyProbe.id, kinds: ["PROBE_REMOVED"], approved: false }]);
    const rewritten: GoldenProbeFile = { ...base, probes: base.probes.map((p) => (p.id === denyProbe.id && p.entrypoint === "authz" ? { ...p, input: { ...p.input, purpose: "audit_review" } } : p)) as GoldenProbe[] };
    expect(findExpansions(base, rewritten, new Set())[0]?.kinds).toEqual(["PROBE_INPUT_CHANGED"]);
    const tightened: GoldenProbeFile = { ...base, probes: base.probes.map((p) => (p.id === allowProbe.id ? { ...p, expected: denyProbe.expected } : p)) };
    expect(findExpansions(base, tightened, new Set())).toEqual([]);
    expect(findExpansions(base, base, new Set())).toEqual([]);
  });

  it("[SPEC-14.policy-expansion] an approval entry counts only with an existing POLICY_RELEASE approval record", () => {
    const entry = { probeId: "authz.x.deny", approvedBy: "Synthetic Approver", approvalId: "apr_synthTestOnly0001", reason: "SYNTHETIC test entry for the gate logic" };
    expect(resolveApprovedExpansions([entry], []).rejected).toEqual([{ probeId: "authz.x.deny", reasonCode: "APPROVAL_RECORD_NOT_FOUND" }]);
    expect(resolveApprovedExpansions([entry], [{ approvalId: "apr_synthTestOnly0001", scope: "PILOT_EXPOSURE" }]).rejected[0]?.reasonCode).toBe("APPROVAL_SCOPE_NOT_POLICY_RELEASE");
    expect([...resolveApprovedExpansions([entry], [{ approvalId: "apr_synthTestOnly0001", scope: "POLICY_RELEASE" }]).approved]).toEqual(["authz.x.deny"]);
  });
});
