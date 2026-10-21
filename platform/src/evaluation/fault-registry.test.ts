import { describe, expect, it } from "vitest";
import { loadFaultPlans } from "./fault-plan.js";
import type { FaultPlan } from "./fault-plan.js";
import {
  ACCEPTED_IN_PROCESS_LAYER2,
  buildFaultRegistry,
  crossCheckLedger,
  extractFaultTests,
  layer2StatusByFault,
  ledgerFaultRows,
  loadLedgerFaultRows,
  scanFaultTests,
} from "./fault-registry.js";
import type { FaultTest, LedgerFaultRow } from "./fault-registry.js";
import { REPO_ROOT, repoPaths } from "./paths.js";
import type { TestResultIndex } from "./traceability.js";
import type { RecordedTestStatus } from "./unknown.js";

const plans = loadFaultPlans(repoPaths().failures);

/** Unit fake of a test-result index (no report file): status by `<file>:<line>`. */
const fakeResults = (statuses: Record<string, RecordedTestStatus>): TestResultIndex => ({
  sources: ["fake-report.json"],
  lookup: (t) => ({ status: statuses[`${t.file}:${t.line}`] ?? "not_run", source: statuses[`${t.file}:${t.line}`] ? "fake-report.json" : null }),
});

const onePlan = (id: string): Map<string, FaultPlan> => {
  const p = plans.get("POLICY_ENGINE_ERROR") as FaultPlan;
  return new Map([[id, { ...p, faultId: id, registry: { ...p.registry, requirementId: `FO-17-24.${id}` } }]]);
};

describe("[FO-17-24][FO-17-14][OPS-03] fixed fault registry", () => {
  it("[FO-17-24] the registry is the fixed denominator of 50 fault plans, each naming its injection point, injection-point packages and Layer-2 owner", () => {
    expect(plans.size).toBe(50);
    for (const p of plans.values()) {
      expect(p.registry.requirementId).toBe(`FO-17-24.${p.faultId}`);
      expect(p.registry.injectionPoint.length).toBeGreaterThan(10);
      expect(p.registry.injectionPointPackages.length).toBeGreaterThan(0);
      expect(p.registry.layer2Owner).toMatch(/^WP-\d{2}$/);
    }
    const rep = buildFaultRegistry(plans, [], null, null);
    expect(rep.denominator).toBe(50);
    expect(rep.rows).toHaveLength(50);
    // Without tests or reports nothing is PASS (OPS-03).
    expect(rep.summary.layer2).toEqual({ PASS: 0, FAIL: 0, INCONCLUSIVE: 0, NOT_RUN: 50 });
  });

  it("[FO-17-24] every plan has exactly one FO-17-24 gap-ledger row with the same Layer-2 owner and packages; the only open disagreement is the faultSource the coordinator regenerates", () => {
    const ledger = loadLedgerFaultRows(REPO_ROOT);
    expect(new Set(ledger.map((r) => r.faultId))).toEqual(new Set(plans.keys()));
    const issues = crossCheckLedger(plans, ledger);
    expect(issues.filter((i) => !i.startsWith("LEDGER_FAULT_SOURCE_STALE "))).toEqual([]);
    // The faultSource of the faults whose plans this package added is regenerated from the statusUpdates.
    const stale = issues.map((i) => i.split(" ")[1]);
    for (const id of stale) expect(plans.get(id as string)?.registry.origin, id).toBe("prompt_section_17");
  });

  it("[FO-17-24] the cross-check names every kind of disagreement", () => {
    const p = onePlan("X_FAULT");
    const row = (over: Partial<LedgerFaultRow>): LedgerFaultRow => ({ id: "FO-17-24.X_FAULT", faultId: "X_FAULT", workPackage: "WP-01", regressionPackage: null, faultSource: "registry", injectionPointPackages: ["WP-01"], postconditionPackages: ["WP-01"], softwareStatus: "IMPLEMENTED", ...over });
    expect(crossCheckLedger(p, [row({})])).toEqual([]);
    expect(crossCheckLedger(p, [])).toEqual(["PLAN_WITHOUT_LEDGER_ROW X_FAULT"]);
    expect(crossCheckLedger(p, [row({}), { ...row({}), id: "FO-17-24.Y_FAULT", faultId: "Y_FAULT" }])).toEqual(["LEDGER_ROW_WITHOUT_PLAN FO-17-24.Y_FAULT"]);
    expect(crossCheckLedger(p, [row({ workPackage: "WP-09" })])).toEqual(["LAYER2_OWNER_MISMATCH X_FAULT plan=WP-01 ledger=WP-09"]);
    // A VERIFIED_LOCAL row names its owner as regressionPackage (no workPackage).
    expect(crossCheckLedger(p, [row({ workPackage: null, regressionPackage: "WP-01", softwareStatus: "VERIFIED_LOCAL" })])).toEqual([]);
    expect(crossCheckLedger(p, [row({ workPackage: null, regressionPackage: "WP-09", softwareStatus: "VERIFIED_LOCAL" })])).toEqual(["LAYER2_OWNER_MISMATCH X_FAULT plan=WP-01 ledger=WP-09"]);
    expect(crossCheckLedger(p, [row({ workPackage: null })])).toEqual(["LAYER2_OWNER_MISMATCH X_FAULT plan=WP-01 ledger=none"]);
    expect(crossCheckLedger(p, [row({ injectionPointPackages: ["WP-02"] })])).toEqual(["INJECTION_POINT_PACKAGES_MISMATCH X_FAULT"]);
    expect(crossCheckLedger(p, [row({ postconditionPackages: [] })])).toEqual(["POSTCONDITION_PACKAGES_MISMATCH X_FAULT"]);
    expect(crossCheckLedger(p, [row({ faultSource: "prompt section 17" })])).toEqual(["LEDGER_FAULT_SOURCE_STALE X_FAULT faultSource=prompt section 17"]);
    expect(() => ledgerFaultRows({})).toThrow("GAP_LEDGER_UNREADABLE");
  });

  it("[FO-17-24][FAULT:POLICY_ENGINE_ERROR seam] the POLICY_ENGINE_ERROR fault test is found at its accepted in-process Layer-2 protocol; tags elsewhere are Layer 1 or seams", () => {
    const tests = scanFaultTests(REPO_ROOT);
    const pee = tests.filter((t) => t.faultId === "POLICY_ENGINE_ERROR" && !t.seam && t.layer !== "layer1");
    expect(pee.length).toBeGreaterThanOrEqual(4);
    expect(pee.every((t) => t.file === "platform/test/invariants/policy-engine-error.fault.test.ts" && t.layer === "accepted_in_process")).toBe(true);
    // A tag in an ordinary unit test (this file's synthetic sources below) is Layer 1 and never the fault test.
    expect(tests.filter((t) => t.faultId === "POLICY_ENGINE_ERROR" && !t.file.startsWith("platform/test/invariants/")).every((t) => t.layer === "layer1")).toBe(true);
    expect(ACCEPTED_IN_PROCESS_LAYER2.POLICY_ENGINE_ERROR?.dir).toBe("platform/test/invariants/");
    // This test's own tag is a seam and never counts as the fault test.
    expect(tests.some((t) => t.file === "platform/src/evaluation/fault-registry.test.ts" && t.faultId === "POLICY_ENGINE_ERROR" && t.seam && t.layer === "layer1")).toBe(true);
  });

  it("[FO-17-24][OPS-03] layers: integration suites are Layer 2, the accepted directory only for its own fault, everything else Layer 1", () => {
    const src = [
      'it("[FAULT:DLQ_FULL] runs on the emulator", () => {});',
      'it("[FAULT:DLQ_FULL seam] a seam", () => {});',
      'it("[FAULT:POLICY_ENGINE_ERROR] here", () => {});',
      'describe("[FAULT:DLQ_FULL] a describe block is not a test", () => {});',
    ].join("\n");
    const l2 = extractFaultTests(src, "platform/test/integration/substrate/x.test.ts");
    expect(l2.map((t) => [t.faultId, t.layer, t.suite, t.seam])).toEqual([
      ["DLQ_FULL", "layer2", "substrate", false],
      ["DLQ_FULL", "layer2", "substrate", true],
      ["POLICY_ENGINE_ERROR", "layer2", "substrate", false],
    ]);
    // Every suite name the Layer-2 runner accepts (scripts/vsp/runner.mts SUITE_RE) is a suite, underscores included.
    expect(extractFaultTests(src, "platform/test/integration/media_bridge/x.test.ts").map((t) => [t.layer, t.suite])).toEqual([
      ["layer2", "media_bridge"],
      ["layer2", "media_bridge"],
      ["layer2", "media_bridge"],
    ]);
    expect(extractFaultTests(src, "platform/test/integration/substrate/nested/x.test.ts").map((t) => t.suite)).toEqual(["substrate", "substrate", "substrate"]);
    // The shared harness (WP-03's own protocol self-tests) and the runner's guard probes are never a fault suite.
    expect(extractFaultTests(src, "platform/test/integration/_harness/x.test.ts").map((t) => [t.layer, t.suite])).toEqual([
      ["layer1", null],
      ["layer1", null],
      ["layer1", null],
    ]);
    expect(extractFaultTests(src, "platform/test/integration/guard-probe-missing/x.test.ts").map((t) => t.layer)).toEqual(["layer1", "layer1", "layer1"]);
    // A file directly in the integration root belongs to no suite.
    expect(extractFaultTests(src, "platform/test/integration/x.test.ts").map((t) => t.layer)).toEqual(["layer1", "layer1", "layer1"]);
    expect(extractFaultTests(src, "platform/test/invariants/x.test.ts").map((t) => t.layer)).toEqual(["layer1", "layer1", "accepted_in_process"]);
    expect(extractFaultTests(src, "platform/src/ingress/x.test.ts").map((t) => t.layer)).toEqual(["layer1", "layer1", "layer1"]);
  });

  it("[FO-17-24][OPS-03][FO-22-07] status: PASS only when every Layer-2 fault test passed in a recorded report; seams, Layer-1 tests, skips and missing results never PASS", () => {
    const p = onePlan("X_FAULT");
    const t = (line: number, over: Partial<FaultTest> = {}): FaultTest => ({ faultId: "X_FAULT", file: "platform/test/integration/s/a.test.ts", line, title: `[FAULT:X_FAULT] ${line}`, seam: false, layer: "layer2", suite: "s", ...over });
    const status = (tests: FaultTest[], results: Record<string, RecordedTestStatus> | null) => buildFaultRegistry(p, tests, results ? fakeResults(results) : null, null).rows[0]?.layer2;
    const a = "platform/test/integration/s/a.test.ts";
    expect(status([t(1)], { [`${a}:1`]: "passed" })).toBe("PASS");
    expect(status([t(1), t(2)], { [`${a}:1`]: "passed", [`${a}:2`]: "failed" })).toBe("FAIL");
    expect(status([t(1), t(2)], { [`${a}:1`]: "passed", [`${a}:2`]: "skipped" })).toBe("INCONCLUSIVE");
    expect(status([t(1)], {})).toBe("NOT_RUN");
    expect(status([t(1)], null)).toBe("NOT_RUN");
    expect(status([], { [`${a}:1`]: "passed" })).toBe("NOT_RUN");
    expect(status([t(1, { seam: true })], { [`${a}:1`]: "passed" })).toBe("NOT_RUN");
    expect(status([t(1, { layer: "layer1", suite: null })], { [`${a}:1`]: "passed" })).toBe("NOT_RUN");
    const rep = buildFaultRegistry(p, [t(1, { seam: true }), t(3, { faultId: "NO_SUCH_FAULT" })], null, null);
    expect(rep.summary.seamOnly).toBe(1);
    expect(rep.unknownFaultTags).toEqual([{ faultId: "NO_SUCH_FAULT", file: a, line: 3 }]);
    expect(layer2StatusByFault(rep)).toEqual({ X_FAULT: "NOT_RUN" });
  });
});
