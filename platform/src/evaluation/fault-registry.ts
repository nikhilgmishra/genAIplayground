/**
 * Fixed fault registry (FO-17-24.*; follow-on prompt section 17 fault matrix; work-packages.yaml WP-01).
 *
 * The denominator is fixed: every fault plan in scenarios/fixtures/failures (fault-plan.v2) is one row, and
 * each row must have exactly one FO-17-24.<FAULT_ID> requirement in docs/followon/gap-ledger.yaml and the
 * other way round. A fault counts as covered on its real protocol only through a test tagged
 * `[FAULT:<FAULT_ID>]` that runs at its injection point on Layer 2 (platform/test/integration/<suite>, the
 * Docker emulator composition) or on an in-process protocol the work-package plan accepts as Layer 2 for that
 * fault (ACCEPTED_IN_PROCESS_LAYER2). A `[FAULT:<ID> seam]` tag marks a test of a seam the fault test will
 * use, never the fault test itself; a `[FAULT:<ID>]` tag in an ordinary unit test is recorded as Layer 1.
 *
 * Status per fault (one shared UNKNOWN classification, unknown.ts; OPS-03): PASS only when at least one
 * Layer-2 fault test exists and every one passed in a recorded report; FAIL when one failed; INCONCLUSIVE when
 * one was skipped; NOT_RUN when no Layer-2 fault test exists or none has a recorded result. A tag naming no
 * plan is reported, never silently dropped.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { isIndependentReachRule } from "./fault-plan.js";
import type { FaultPlan } from "./fault-plan.js";
import { posixRelative, walkFiles } from "./paths.js";
import type { TestResultIndex } from "./traceability.js";
import { combineRecordedTests, verdictOfTests } from "./unknown.js";
import type { RecordedTestStatus } from "./unknown.js";

export const FAULT_REGISTRY_VERSION = "fault-registry.v1";

/** `[FAULT:<ID>]` or `[FAULT:<ID> seam]` in a test title. */
export const FAULT_TAG = /\[FAULT:([A-Z][A-Z0-9_]{2,63})( seam)?\]/g;

/**
 * Faults whose Layer-2 run uses an in-process protocol the work-package plan accepts (no emulator stands in
 * for it). Each names the directory its fault test lives in and the protocol, so a test elsewhere is Layer 1.
 */
export const ACCEPTED_IN_PROCESS_LAYER2: Readonly<Record<string, { dir: string; protocol: string; source: string }>> = {
  POLICY_ENGINE_ERROR: {
    dir: "platform/test/invariants/",
    protocol: "in-process OPA WASM engine (compiled Rego bundle) of the full local container, reached through the MCP SDK client over loopback HTTP",
    source: "docs/followon/work-packages.yaml WP-01 deliverables (an accepted Layer-2 protocol)",
  },
};

/** Directories scanned for fault-tagged tests (TypeScript test files only). */
export const FAULT_TEST_ROOTS = ["platform/src", "platform/test", "console/src", "media", "companion", "services"] as const;

export type FaultTestLayer = "layer2" | "accepted_in_process" | "layer1";
export type FaultLayerStatus = "PASS" | "FAIL" | "INCONCLUSIVE" | "NOT_RUN";

export interface FaultTest {
  faultId: string;
  file: string;
  line: number;
  title: string;
  seam: boolean;
  layer: FaultTestLayer;
  /** Layer-2 suite (platform/test/integration/<suite>/); null otherwise. */
  suite: string | null;
}

const TITLE_CALL =
  /\b(it|test|describe)((?:\.(?:skip|only|concurrent|sequential|todo|fails|skipIf\([^)]*\)|runIf\([^)]*\)|each\([^)]*\)))*)\s*\(\s*(["'`])((?:\\.|(?!\3)[^\\])*?)\3/g;

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Suite directory grammar of the Layer-2 runner (scripts/vsp/runner.mts SUITE_RE). */
const LAYER2_SUITE = /^platform\/test\/integration\/([_a-z][a-z0-9_-]{0,40})\//;
/**
 * Directories under platform/test/integration that are not a package's Layer-2 suite: the shared harness
 * (WP-03's own protocol self-tests) and the runner's guard probes (deliberately failing, never walked).
 */
const NOT_A_FAULT_SUITE = (suite: string): boolean => suite === "_harness" || suite.startsWith("guard-probe-");

export function layerOf(file: string, faultId: string): { layer: FaultTestLayer; suite: string | null } {
  const l2 = LAYER2_SUITE.exec(file);
  if (l2 && !NOT_A_FAULT_SUITE(l2[1] as string)) return { layer: "layer2", suite: l2[1] as string };
  const accepted = ACCEPTED_IN_PROCESS_LAYER2[faultId];
  if (accepted && file.startsWith(accepted.dir)) return { layer: "accepted_in_process", suite: null };
  return { layer: "layer1", suite: null };
}

/** Extracts fault-tagged it/test/describe titles from one TypeScript test source. */
export function extractFaultTests(source: string, file: string): FaultTest[] {
  const out: FaultTest[] = [];
  for (const m of source.matchAll(TITLE_CALL)) {
    // A describe block is not a test: only it/test titles carry a recorded result.
    if (m[1] === "describe") continue;
    const title = (m[4] ?? "").replace(/\\(["'`\\])/g, "$1");
    for (const t of title.matchAll(FAULT_TAG)) {
      const faultId = t[1] as string;
      out.push({ faultId, file, line: lineAt(source, m.index ?? 0), title, seam: t[2] !== undefined, ...layerOf(file, faultId) });
    }
  }
  return out;
}

export function scanFaultTests(root: string): FaultTest[] {
  const out: FaultTest[] = [];
  for (const dir of FAULT_TEST_ROOTS) {
    const abs = join(root, dir);
    if (!existsSync(abs)) continue;
    for (const f of walkFiles(abs, (p) => (p.endsWith(".test.ts") || p.endsWith(".test.tsx")) && !p.includes("/node_modules/"))) {
      out.push(...extractFaultTests(readFileSync(f, "utf8"), posixRelative(root, f)));
    }
  }
  return out.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Gap-ledger rows (docs/followon/gap-ledger.yaml, read only; regenerated by the coordinator)
// ---------------------------------------------------------------------------

export interface LedgerFaultRow {
  id: string;
  faultId: string;
  workPackage: string | null;
  faultSource: string | null;
  injectionPointPackages: string[];
  postconditionPackages: string[];
  softwareStatus: string | null;
}

export function ledgerFaultRows(ledger: unknown): LedgerFaultRow[] {
  const entries = (ledger as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) throw new Error("GAP_LEDGER_UNREADABLE");
  return entries
    .filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null && typeof (e as { id?: unknown }).id === "string" && ((e as { id: string }).id).startsWith("FO-17-24."))
    .map((e) => ({
      id: e.id as string,
      faultId: (e.id as string).slice("FO-17-24.".length),
      workPackage: typeof e.workPackage === "string" ? e.workPackage : null,
      faultSource: typeof e.faultSource === "string" ? e.faultSource : null,
      injectionPointPackages: Array.isArray(e.injectionPointPackages) ? (e.injectionPointPackages as string[]) : [],
      postconditionPackages: Array.isArray(e.postconditionPackages) ? (e.postconditionPackages as string[]) : [],
      softwareStatus: typeof e.softwareStatus === "string" ? e.softwareStatus : null,
    }));
}

export const loadLedgerFaultRows = (root: string): LedgerFaultRow[] => ledgerFaultRows(parseYaml(readFileSync(join(root, "docs", "followon", "gap-ledger.yaml"), "utf8")));

// ---------------------------------------------------------------------------
// Registry report
// ---------------------------------------------------------------------------

export interface FaultRegistryRow {
  faultId: string;
  requirementId: string;
  planVersion: number;
  origin: FaultPlan["registry"]["origin"];
  injectionPoint: string;
  injectionPointPackages: string[];
  postconditionPackages: string[];
  layer2Owner: string;
  localDriver: FaultPlan["registry"]["localDriver"];
  /** Independent local reach rules (a `driver_self_report` rule is never reach evidence and is not counted). */
  reachRules: number;
  tests: (FaultTest & { status: RecordedTestStatus })[];
  /** Status of the Layer-2 (or accepted in-process) [FAULT:<id>] tests; seams and Layer-1 tests never count. */
  layer2: FaultLayerStatus;
  ledger: LedgerFaultRow | null;
}

export interface FaultRegistryReport {
  registryVersion: typeof FAULT_REGISTRY_VERSION;
  /** Fixed denominator: the number of fault plans (FO-17-24 rows). */
  denominator: number;
  rows: FaultRegistryRow[];
  /** Fault tags naming no plan. */
  unknownFaultTags: { faultId: string; file: string; line: number }[];
  /** Plan / gap-ledger disagreements (null when the ledger was not read). */
  ledgerIssues: string[] | null;
  summary: { layer2: Record<FaultLayerStatus, number>; withLayer2Test: number; seamOnly: number; layer1Only: number };
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

/** Plan versus gap-ledger cross-check (reason codes, one per disagreement). */
export function crossCheckLedger(plans: ReadonlyMap<string, FaultPlan>, rows: readonly LedgerFaultRow[]): string[] {
  const issues: string[] = [];
  const byFault = new Map(rows.map((r) => [r.faultId, r] as const));
  for (const r of rows) if (!plans.has(r.faultId)) issues.push(`LEDGER_ROW_WITHOUT_PLAN ${r.id}`);
  for (const [id, p] of plans) {
    const r = byFault.get(id);
    if (!r) {
      issues.push(`PLAN_WITHOUT_LEDGER_ROW ${id}`);
      continue;
    }
    if (r.workPackage !== p.registry.layer2Owner) issues.push(`LAYER2_OWNER_MISMATCH ${id} plan=${p.registry.layer2Owner} ledger=${r.workPackage ?? "none"}`);
    if (!sameSet(r.injectionPointPackages, p.registry.injectionPointPackages)) issues.push(`INJECTION_POINT_PACKAGES_MISMATCH ${id}`);
    if (!sameSet(r.postconditionPackages, p.registry.postconditionPackages)) issues.push(`POSTCONDITION_PACKAGES_MISMATCH ${id}`);
    // generate.py: a fault with a plan has faultSource "registry..." (the coordinator regenerates the ledger).
    if (!String(r.faultSource ?? "").startsWith("registry")) issues.push(`LEDGER_FAULT_SOURCE_STALE ${id} faultSource=${r.faultSource ?? "none"}`);
  }
  return issues.sort();
}

export function buildFaultRegistry(
  plans: ReadonlyMap<string, FaultPlan>,
  tests: readonly FaultTest[],
  results: TestResultIndex | null,
  ledger: readonly LedgerFaultRow[] | null,
): FaultRegistryReport {
  const statusOf = (t: FaultTest): RecordedTestStatus => (results ? results.lookup({ file: t.file, line: t.line, title: t.title, kind: "it", tags: [] }).status : "not_run");
  const ledgerBy = new Map((ledger ?? []).map((r) => [r.faultId, r] as const));
  const rows: FaultRegistryRow[] = [...plans.values()]
    .sort((a, b) => (a.faultId < b.faultId ? -1 : 1))
    .map((p) => {
      const own = tests.filter((t) => t.faultId === p.faultId).map((t) => ({ ...t, status: statusOf(t) }));
      const l2 = own.filter((t) => !t.seam && t.layer !== "layer1");
      const v = verdictOfTests(l2.map((t) => t.status));
      const layer2: FaultLayerStatus = v === "PASS" ? "PASS" : v === "FAIL" ? "FAIL" : l2.length === 0 || combineRecordedTests(l2.map((t) => t.status)) === "not_run" ? "NOT_RUN" : "INCONCLUSIVE";
      return {
        faultId: p.faultId,
        requirementId: p.registry.requirementId,
        planVersion: p.version,
        origin: p.registry.origin,
        injectionPoint: p.registry.injectionPoint,
        injectionPointPackages: [...p.registry.injectionPointPackages],
        postconditionPackages: [...p.registry.postconditionPackages],
        layer2Owner: p.registry.layer2Owner,
        localDriver: p.registry.localDriver,
        reachRules: p.reachEvidence.filter(isIndependentReachRule).length,
        tests: own,
        layer2,
        ledger: ledgerBy.get(p.faultId) ?? null,
      };
    });
  const unknownFaultTags = tests.filter((t) => !plans.has(t.faultId)).map((t) => ({ faultId: t.faultId, file: t.file, line: t.line }));
  const count = (s: FaultLayerStatus) => rows.filter((r) => r.layer2 === s).length;
  const hasL2 = (r: FaultRegistryRow) => r.tests.some((t) => !t.seam && t.layer !== "layer1");
  return {
    registryVersion: FAULT_REGISTRY_VERSION,
    denominator: plans.size,
    rows,
    unknownFaultTags,
    ledgerIssues: ledger ? crossCheckLedger(plans, ledger) : null,
    summary: {
      layer2: { PASS: count("PASS"), FAIL: count("FAIL"), INCONCLUSIVE: count("INCONCLUSIVE"), NOT_RUN: count("NOT_RUN") },
      withLayer2Test: rows.filter(hasL2).length,
      seamOnly: rows.filter((r) => !hasL2(r) && r.tests.some((t) => t.seam)).length,
      layer1Only: rows.filter((r) => !hasL2(r) && !r.tests.some((t) => t.seam) && r.tests.length > 0).length,
    },
  };
}

/** Layer-2 status per fault for the aggregate's coverage holes (aggregate.ts `layer2Faults`). */
export const layer2StatusByFault = (rep: FaultRegistryReport): Record<string, FaultLayerStatus> => Object.fromEntries(rep.rows.map((r) => [r.faultId, r.layer2]));
