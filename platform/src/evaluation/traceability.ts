/**
 * Requirements traceability generator, two status axes plus qualification (follow-on prompt section 0;
 * FO-00-29, FO-00-37, FO-02-28, FO-19-05; original spec section 14: "Every requirement must map to enforcement
 * location, test IDs, evidence and release status").
 *
 * Inputs (read only):
 *   docs/requirements/catalog.yaml          original requirement catalogue with the invariant register
 *   docs/followon/requirements.yaml         follow-on requirements (FO-*) and their originalIds / capabilityIds
 *   docs/followon/gap-ledger.yaml           Software / Environment / Qualification per FO requirement
 *   docs/followon/capabilities.yaml         capability membership (and the coordinator's roll-ups, cross-checked)
 *   docs/followon/activation-register.yaml  activation input ids (AIN-NN), which are never originalIds
 *   scenarios/fixtures/failures/*.json      the fixed fault registry (fault-registry.ts)
 *   test titles                             requirement tags `[AUTH-01]`, `[SPEC-7.x]`, `[FO-17-14]`, fault tags
 *                                           `[FAULT:<ID>]` and register role tags `[FAILURE:<invariant>]`
 *   vitest / opa JSON reports               recorded results (`--vitest-report`, `--opa-report`)
 *
 * Outputs: docs/REQUIREMENTS_TRACEABILITY.md (`--out`) and the JSON report (`--json`, committed as
 * evidence/test-reports/traceability.json).
 *
 * Status rules (OPS-03; one shared classification, unknown.ts):
 *  - Software and Environment are the gap ledger's values (MISSING / IMPLEMENTED / VERIFIED_LOCAL /
 *    RELEASE_PACKAGE_VERIFIED; NOT_CONFIGURED / CONFIGURED / VERIFIED_SANDBOX / APPROVED_PILOT /
 *    VERIFIED_PRODUCTION); a capability or catalogue requirement is never reported ahead of its least advanced
 *    member. Qualification (NOT_RUN / FAIL / INCONCLUSIVE / PASS) is the ledger's value and rolls up as
 *    `combineQualification`. Nothing here raises a status: tags and passing unit tests are software evidence.
 *  - Local test results per requirement: NO_TEST (no tagged test), NOT_RUN (a tagged test has no recorded result
 *    or was skipped), FAIL (one failed), PASS (at least one, every one passed in a recorded report).
 *  - The generator FAILS (exit 1, nothing written) on an originalId that resolves to no catalogue id or alias,
 *    on an activation-register id (AIN-NN) used as an originalId, on a catalogue id that no FO row maps, on an
 *    FO row without a ledger row, on an unknown capability, on a status value outside the two-axis vocabulary,
 *    on a capability roll-up that differs from its members and on an incomplete invariant register.
 *
 * Usage: tsx src/evaluation/traceability.ts [--root <repo>] [--vitest-report <file>]... [--opa-report <file>]...
 *          [--out <md>] [--json <file>] [--generated-at <iso>] [--check]
 *   --check  validates the inputs and prints the issues; writes nothing.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { sha256Hex } from "../shared/canonical.js";
import { loadCatalog, registerIssues } from "./catalog.js";
import type { LoadedCatalog, RegisterTestRef, RequirementEntry } from "./catalog.js";
import { loadFaultPlans } from "./fault-plan.js";
import { buildFaultRegistry, ledgerFaultRows, scanFaultTests } from "./fault-registry.js";
import type { FaultRegistryReport } from "./fault-registry.js";
import { REPO_ROOT, posixRelative, repoPaths, walkFiles } from "./paths.js";
import { classifyRecordedTest, combineQualification, combineRecordedTests, verdictOfTests } from "./unknown.js";
import type { Qualification, RecordedTestStatus } from "./unknown.js";

export const TRACEABILITY_VERSION = "traceability.v2";

/** Requirement tags: catalogue ids and aliases (`[AUTH-01]`, `[SPEC-7.otp]`) and follow-on ids (`[FO-17-24.POLICY_ENGINE_ERROR]`). */
export const TAG_PATTERN = /\[([A-Z][A-Z0-9]{1,7}-[A-Za-z0-9][A-Za-z0-9._-]*)\]/g;

export interface TaggedTest {
  /** Repository-relative POSIX path. */
  file: string;
  line: number;
  title: string;
  kind: "it" | "test" | "describe" | "rego";
  tags: string[];
}

export type TestStatus = RecordedTestStatus;

export interface TestResultIndex {
  /** Report files (repository-relative where possible) that were loaded. */
  sources: string[];
  lookup(test: TaggedTest): { status: TestStatus; source: string | null };
}

const extractTags = (title: string): string[] => [...new Set([...title.matchAll(TAG_PATTERN)].map((m) => m[1] as string))];

const TITLE_CALL =
  /\b(it|test|describe)((?:\.(?:skip|only|concurrent|sequential|todo|fails|skipIf\([^)]*\)|runIf\([^)]*\)))*)\s*\(\s*(["'`])((?:\\.|(?!\3)[^\\])*?)\3/g;

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Extracts tagged it/test/describe titles from a TypeScript test source. */
export function extractVitestTitles(source: string, file: string): TaggedTest[] {
  const out: TaggedTest[] = [];
  for (const m of source.matchAll(TITLE_CALL)) {
    const title = (m[4] ?? "").replace(/\\(["'`\\])/g, "$1");
    const tags = extractTags(title);
    if (tags.length === 0) continue;
    out.push({ file, line: lineAt(source, m.index ?? 0), title, kind: m[1] as "it" | "test" | "describe", tags });
  }
  return out;
}

/** Extracts `# [TAG]` comments that precede a `test_*` rule in a Rego test file. */
export function extractRegoTests(source: string, file: string): TaggedTest[] {
  const out: TaggedTest[] = [];
  let pending: string[] = [];
  const lines = source.split("\n");
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim();
    if (line.startsWith("#")) {
      pending.push(...extractTags(line));
      continue;
    }
    const rule = /^(test_[A-Za-z0-9_]+)\b/.exec(line);
    if (rule) {
      if (pending.length > 0) out.push({ file, line: i + 1, title: rule[1] as string, kind: "rego", tags: [...new Set(pending)] });
      pending = [];
      continue;
    }
    if (line.length > 0 && !line.startsWith("import") && !line.startsWith("package")) pending = [];
  }
  return out;
}

export const TEST_SCAN_ROOTS = [
  { dir: "platform/src", accept: (p: string) => p.endsWith(".test.ts"), kind: "vitest" as const },
  { dir: "platform/test", accept: (p: string) => p.endsWith(".test.ts"), kind: "vitest" as const },
  { dir: "console/src", accept: (p: string) => p.endsWith(".test.tsx") || p.endsWith(".test.ts"), kind: "vitest" as const },
  { dir: "policy", accept: (p: string) => p.endsWith("_test.rego"), kind: "rego" as const },
];

export function scanTaggedTests(root: string): TaggedTest[] {
  const out: TaggedTest[] = [];
  for (const scan of TEST_SCAN_ROOTS) {
    for (const abs of walkFiles(join(root, scan.dir), scan.accept)) {
      const rel = posixRelative(root, abs);
      const text = readFileSync(abs, "utf8");
      out.push(...(scan.kind === "rego" ? extractRegoTests(text, rel) : extractVitestTitles(text, rel)));
    }
  }
  return out.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Test results
// ---------------------------------------------------------------------------

interface VitestAssertion {
  ancestorTitles?: string[];
  title?: string;
  status?: string;
}
interface VitestFileResult {
  name?: string;
  assertionResults?: VitestAssertion[];
}
interface OpaResult {
  location?: { file?: string };
  name?: string;
  fail?: boolean;
  error?: unknown;
  skip?: boolean;
}

/** Builds a matcher for titles with template interpolations or printf-style placeholders. */
function titleMatcher(title: string): (candidate: string) => boolean {
  if (!/\$\{|%[sdifjo#]/.test(title)) return (c) => c === title;
  const pattern = title
    .split(/\$\{[^}]*\}|%[sdifjo#]/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  const re = new RegExp(`^${pattern}$`);
  return (c) => re.test(c);
}

export function buildResultIndex(root: string, vitestReports: readonly string[], opaReports: readonly string[] = []): TestResultIndex {
  const files: { source: string; file: string; assertions: VitestAssertion[] }[] = [];
  const opa: { source: string; file: string; name: string; status: TestStatus }[] = [];
  // A report outside the repository (a local run that is not committed) is named `local-run:<file>`, never by a
  // path that does not exist in the repository.
  const rel = (p: string) => {
    const r = isAbsolute(p) ? posixRelative(root, p) : p.split("\\").join("/");
    return r.startsWith("../") ? `local-run:${basename(p)}` : r;
  };
  const sources: string[] = [];
  for (const report of vitestReports) {
    const parsed = JSON.parse(readFileSync(report, "utf8")) as { testResults?: VitestFileResult[] };
    sources.push(rel(report));
    for (const tr of parsed.testResults ?? []) {
      if (!tr.name) continue;
      files.push({ source: rel(report), file: tr.name.split("\\").join("/"), assertions: tr.assertionResults ?? [] });
    }
  }
  for (const report of opaReports) {
    const parsed = JSON.parse(readFileSync(report, "utf8")) as OpaResult[];
    sources.push(rel(report));
    for (const r of Array.isArray(parsed) ? parsed : []) {
      if (!r.name) continue;
      const status: TestStatus = r.skip ? "skipped" : r.fail || r.error ? "failed" : "passed";
      opa.push({ source: rel(report), file: (r.location?.file ?? "").split("\\").join("/"), name: r.name, status });
    }
  }
  const sameFile = (reportFile: string, testFile: string) => reportFile === testFile || reportFile.endsWith(`/${testFile}`) || testFile.endsWith(`/${reportFile}`);
  return {
    sources,
    lookup(test) {
      if (test.kind === "rego") {
        const hits = opa.filter((o) => o.name === test.title && (o.file === "" || sameFile(o.file, test.file)));
        return { status: combineRecordedTests(hits.map((h) => h.status)), source: hits[0]?.source ?? null };
      }
      const match = titleMatcher(test.title);
      const statuses: TestStatus[] = [];
      let source: string | null = null;
      for (const f of files) {
        if (!sameFile(f.file, test.file)) continue;
        for (const a of f.assertions) {
          const hit = test.kind === "describe" ? (a.ancestorTitles ?? []).some(match) : match(a.title ?? "");
          if (hit) {
            statuses.push(classifyRecordedTest(a.status));
            source = f.source;
          }
        }
      }
      return { status: combineRecordedTests(statuses), source };
    },
  };
}

// ---------------------------------------------------------------------------
// Two status axes (gap ledger vocabulary)
// ---------------------------------------------------------------------------

export const SOFTWARE_ORDER = ["MISSING", "IMPLEMENTED", "VERIFIED_LOCAL", "RELEASE_PACKAGE_VERIFIED"] as const;
export const ENVIRONMENT_ORDER = ["NOT_CONFIGURED", "CONFIGURED", "VERIFIED_SANDBOX", "APPROVED_PILOT", "VERIFIED_PRODUCTION"] as const;
export const QUALIFICATIONS = ["NOT_RUN", "FAIL", "INCONCLUSIVE", "PASS"] as const;
export type SoftwareStatus = (typeof SOFTWARE_ORDER)[number];
export type EnvironmentStatus = (typeof ENVIRONMENT_ORDER)[number];

/** Least advanced member (a capability is never reported ahead of its weakest member); no members -> the least value. */
export function rollupSoftware(xs: readonly SoftwareStatus[]): SoftwareStatus {
  return xs.length === 0 ? "MISSING" : SOFTWARE_ORDER[Math.min(...xs.map((x) => SOFTWARE_ORDER.indexOf(x)))] ?? "MISSING";
}
export function rollupEnvironment(xs: readonly EnvironmentStatus[]): EnvironmentStatus {
  return xs.length === 0 ? "NOT_CONFIGURED" : ENVIRONMENT_ORDER[Math.min(...xs.map((x) => ENVIRONMENT_ORDER.indexOf(x)))] ?? "NOT_CONFIGURED";
}

export interface FollowOnRequirement {
  id: string;
  section: string;
  kind: string;
  text: string;
  originalIds: string[];
  capabilityIds: string[];
}
export interface FollowOnStatus {
  software: SoftwareStatus;
  environment: EnvironmentStatus;
  qualification: Qualification;
  workPackage: string | null;
}
export interface FollowOnCapability {
  id: string;
  title: string;
  memberRequirementIds: string[];
  softwareRollup: string | null;
  environmentRollup: string | null;
}
export interface FollowOnInputs {
  asOf: string | null;
  digests: { requirements: string; gapLedger: string; capabilities: string; activationRegister: string };
  requirements: FollowOnRequirement[];
  status: Map<string, FollowOnStatus>;
  capabilities: FollowOnCapability[];
  activationIds: Set<string>;
  /** Raw gap ledger (fault rows for the registry cross-check). */
  ledger: unknown;
  /** Status values outside the vocabulary (reported as issues). */
  invalidValues: string[];
}

const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function parseFollowOn(texts: { requirements: string; gapLedger: string; capabilities: string; activationRegister: string }): FollowOnInputs {
  const req = parseYaml(texts.requirements) as { asOf?: string; requirements?: Record<string, unknown>[] };
  const led = parseYaml(texts.gapLedger) as { entries?: Record<string, unknown>[] };
  const cap = parseYaml(texts.capabilities) as { capabilities?: Record<string, unknown>[] };
  const act = parseYaml(texts.activationRegister) as { entries?: Record<string, unknown>[] };
  if (!Array.isArray(req.requirements) || !Array.isArray(led.entries) || !Array.isArray(cap.capabilities)) throw new Error("FOLLOW_ON_INPUTS_UNREADABLE");
  const invalidValues: string[] = [];
  const status = new Map<string, FollowOnStatus>();
  for (const e of led.entries) {
    const id = String(e.id);
    const sw = String(e.softwareStatus);
    const env = String(e.environmentStatus);
    const q = String(e.qualification);
    if (!(SOFTWARE_ORDER as readonly string[]).includes(sw)) invalidValues.push(`${id} softwareStatus=${sw}`);
    if (!(ENVIRONMENT_ORDER as readonly string[]).includes(env)) invalidValues.push(`${id} environmentStatus=${env}`);
    if (!(QUALIFICATIONS as readonly string[]).includes(q)) invalidValues.push(`${id} qualification=${q}`);
    status.set(id, {
      // An unknown value never advances anything (OPS-03): it is reported and counted as the least value.
      software: (SOFTWARE_ORDER as readonly string[]).includes(sw) ? (sw as SoftwareStatus) : "MISSING",
      environment: (ENVIRONMENT_ORDER as readonly string[]).includes(env) ? (env as EnvironmentStatus) : "NOT_CONFIGURED",
      qualification: (QUALIFICATIONS as readonly string[]).includes(q) ? (q as Qualification) : "NOT_RUN",
      workPackage: typeof e.workPackage === "string" ? e.workPackage : null,
    });
  }
  return {
    asOf: typeof req.asOf === "string" ? req.asOf : null,
    digests: { requirements: sha256Hex(texts.requirements), gapLedger: sha256Hex(texts.gapLedger), capabilities: sha256Hex(texts.capabilities), activationRegister: sha256Hex(texts.activationRegister) },
    requirements: req.requirements.map((r) => ({
      id: String(r.id),
      section: String(r.section ?? ""),
      kind: String(r.kind ?? ""),
      text: String(r.text ?? ""),
      originalIds: asStrings(r.originalIds),
      capabilityIds: asStrings(r.capabilityIds),
    })),
    status,
    capabilities: cap.capabilities.map((c) => ({
      id: String(c.id),
      title: String(c.title ?? ""),
      memberRequirementIds: asStrings(c.memberRequirementIds),
      softwareRollup: typeof c.softwareRollup === "string" ? c.softwareRollup : null,
      environmentRollup: typeof c.environmentRollup === "string" ? c.environmentRollup : null,
    })),
    activationIds: new Set((act.entries ?? []).map((e) => String(e.id)).filter((id) => /^AIN-\d{2}$/.test(id))),
    ledger: led,
    invalidValues,
  };
}

export function loadFollowOn(root: string): FollowOnInputs {
  const read = (rel: string) => readFileSync(join(root, "docs", "followon", rel), "utf8");
  return parseFollowOn({ requirements: read("requirements.yaml"), gapLedger: read("gap-ledger.yaml"), capabilities: read("capabilities.yaml"), activationRegister: read("activation-register.yaml") });
}

/** Mapping and vocabulary issues; any issue fails the generator (reason code, then the ids). */
export function followOnIssues(fo: FollowOnInputs, catalog: LoadedCatalog): string[] {
  const issues: string[] = [];
  const catalogIds = new Set(catalog.catalog.requirements.map((r) => r.id));
  const mapped = new Set<string>();
  const capIds = new Set(fo.capabilities.map((c) => c.id));
  const reqIds = new Set(fo.requirements.map((r) => r.id));
  for (const r of fo.requirements) {
    for (const o of r.originalIds) {
      if (/^AIN-\d+$/.test(o) || fo.activationIds.has(o)) {
        issues.push(`AIN_AS_ORIGINAL_ID ${r.id} ${o}`);
        continue;
      }
      const canonical = catalog.resolve(o);
      if (!canonical) issues.push(`ORIGINAL_ID_UNRESOLVED ${r.id} ${o}`);
      else mapped.add(canonical);
    }
    if (!fo.status.has(r.id)) issues.push(`LEDGER_ROW_MISSING ${r.id}`);
    for (const c of r.capabilityIds) if (!capIds.has(c)) issues.push(`CAPABILITY_UNKNOWN ${r.id} ${c}`);
  }
  for (const id of catalogIds) if (!mapped.has(id)) issues.push(`CATALOG_ID_WITHOUT_FO_ROW ${id}`);
  for (const c of fo.capabilities) {
    for (const m of c.memberRequirementIds) if (!reqIds.has(m)) issues.push(`CAPABILITY_MEMBER_UNKNOWN ${c.id} ${m}`);
    const members = c.memberRequirementIds.map((m) => fo.status.get(m)).filter((s): s is FollowOnStatus => s !== undefined);
    const sw = rollupSoftware(members.map((m) => m.software));
    const env = rollupEnvironment(members.map((m) => m.environment));
    if (c.softwareRollup !== null && c.softwareRollup !== sw) issues.push(`CAPABILITY_ROLLUP_MISMATCH ${c.id} software=${c.softwareRollup} members=${sw}`);
    if (c.environmentRollup !== null && c.environmentRollup !== env) issues.push(`CAPABILITY_ROLLUP_MISMATCH ${c.id} environment=${c.environmentRollup} members=${env}`);
  }
  for (const v of fo.invalidValues) issues.push(`STATUS_VALUE_UNKNOWN ${v}`);
  issues.push(...registerIssues(catalog.catalog));
  return issues;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export type LocalTestsResult = "PASS" | "FAIL" | "NOT_RUN" | "NO_TEST";
const localOf = (statuses: readonly TestStatus[]): LocalTestsResult => {
  if (statuses.length === 0) return "NO_TEST";
  const c = combineRecordedTests(statuses);
  return c === "passed" ? "PASS" : c === "failed" ? "FAIL" : "NOT_RUN";
};

export interface AxesRollup {
  software: SoftwareStatus;
  environment: EnvironmentStatus;
  qualification: Qualification;
}

export interface RequirementRow {
  id: string;
  kind: RequirementEntry["kind"];
  text: string;
  section: string;
  enforcement: string[];
  verification: string[];
  tests: (TaggedTest & { status: TestStatus; viaAlias: string | null })[];
  counts: Record<TestStatus, number>;
  /** Recorded local result of the tagged tests (software evidence, never qualification). */
  latestResult: LocalTestsResult;
  externalBlock: RequirementEntry["externalBlock"];
  evidence: string[];
  /** Follow-on rows that map this catalogue id (FO-00-37). */
  followOnIds: string[];
  /** Least advanced follow-on row that maps it; null when the follow-on inputs were not supplied. */
  axes: AxesRollup | null;
}

export interface FollowOnRow extends AxesRollup {
  id: string;
  section: string;
  kind: string;
  text: string;
  originalIds: string[];
  capabilityIds: string[];
  workPackage: string | null;
  taggedTests: number;
  localTests: LocalTestsResult;
}

export interface CapabilityRow extends AxesRollup {
  id: string;
  title: string;
  requirements: number;
  softwareCounts: Partial<Record<SoftwareStatus, number>>;
}

export interface InvariantRoleResult {
  tests: { file: string; title: string; line: number | null; status: TestStatus }[];
  /** PASS only when every cited test was found and passed in a recorded report. */
  result: Qualification;
}
export interface InvariantRow {
  id: string;
  followOnId: string;
  threatIds: string[];
  ownerRole: string;
  ownerPackage: string;
  activationDependency: string[];
  secondaryPackages: string[];
  openGaps: string[];
  positive: InvariantRoleResult;
  adversarial: InvariantRoleResult;
  failureInjection: InvariantRoleResult;
  /** PASS only when all three roles PASS. */
  allRoles: Qualification;
}

export interface TraceabilityReport {
  traceabilityVersion: typeof TRACEABILITY_VERSION;
  catalogVersion: string;
  catalogDigest: string;
  generatedAt: string;
  resultSources: string[];
  followOnSources: (FollowOnInputs["digests"] & { asOf: string | null }) | null;
  rows: RequirementRow[];
  followOnRows: FollowOnRow[];
  capabilities: CapabilityRow[];
  invariants: InvariantRow[];
  faults: FaultRegistryReport | null;
  unknownTags: { tag: string; tests: { file: string; line: number }[] }[];
  gaps: string[];
  issues: string[];
  summary: {
    requirements: number;
    taggedTests: number;
    localTests: Record<LocalTestsResult, number>;
    externallyBlocked: number;
    followOn: { requirements: number; software: Record<string, number>; environment: Record<string, number>; qualification: Record<string, number> } | null;
    capabilities: { count: number; software: Record<string, number>; environment: Record<string, number>; qualification: Record<string, number> } | null;
    invariants: { count: number; allRolesPass: number; failureInjectionPass: number } | null;
  };
}

const tally = (xs: readonly string[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const x of xs) out[x] = (out[x] ?? 0) + 1;
  return out;
};

const qualificationOfTests = (statuses: readonly TestStatus[]): Qualification => {
  if (statuses.every((x) => x === "not_run")) return "NOT_RUN";
  const v = verdictOfTests(statuses);
  return v === "PASS" ? "PASS" : v === "FAIL" ? "FAIL" : v === "NOT_RUN" ? "NOT_RUN" : "INCONCLUSIVE";
};

export function buildTraceability(
  catalog: LoadedCatalog,
  tests: readonly TaggedTest[],
  results: TestResultIndex | null,
  generatedAt: string,
  followOn: FollowOnInputs | null = null,
  faults: FaultRegistryReport | null = null,
): TraceabilityReport {
  const statusOf = (t: TaggedTest): TestStatus => (results ? results.lookup(t).status : "not_run");
  const foIds = new Set((followOn?.requirements ?? []).map((r) => r.id));
  const byReq = new Map<string, RequirementRow["tests"]>();
  const byFo = new Map<string, TestStatus[]>();
  const unknown = new Map<string, { file: string; line: number }[]>();
  for (const t of tests) {
    const status = statusOf(t);
    for (const tag of t.tags) {
      const canonical = catalog.resolve(tag);
      if (canonical) {
        byReq.set(canonical, [...(byReq.get(canonical) ?? []), { ...t, status, viaAlias: canonical === tag ? null : tag }]);
        continue;
      }
      if (/^FO-\d{2}-/.test(tag) && (followOn === null || foIds.has(tag))) {
        if (followOn) byFo.set(tag, [...(byFo.get(tag) ?? []), status]);
        continue;
      }
      unknown.set(tag, [...(unknown.get(tag) ?? []), { file: t.file, line: t.line }]);
    }
  }
  // Follow-on rows.
  const followOnRows: FollowOnRow[] = (followOn?.requirements ?? []).map((r) => {
    const st = followOn?.status.get(r.id);
    const own = byFo.get(r.id) ?? [];
    return {
      id: r.id,
      section: r.section,
      kind: r.kind,
      text: r.text,
      originalIds: r.originalIds,
      capabilityIds: r.capabilityIds,
      workPackage: st?.workPackage ?? null,
      software: st?.software ?? "MISSING",
      environment: st?.environment ?? "NOT_CONFIGURED",
      qualification: st?.qualification ?? "NOT_RUN",
      taggedTests: own.length,
      localTests: localOf(own),
    };
  });
  const foByOriginal = new Map<string, FollowOnRow[]>();
  for (const f of followOnRows) {
    for (const o of f.originalIds) {
      const c = catalog.resolve(o);
      if (c) foByOriginal.set(c, [...(foByOriginal.get(c) ?? []), f]);
    }
  }
  const axesOf = (members: readonly AxesRollup[]): AxesRollup => ({
    software: rollupSoftware(members.map((m) => m.software)),
    environment: rollupEnvironment(members.map((m) => m.environment)),
    qualification: combineQualification(members.map((m) => m.qualification)),
  });
  const rows: RequirementRow[] = catalog.catalog.requirements.map((r) => {
    const rowTests = byReq.get(r.id) ?? [];
    const counts: Record<TestStatus, number> = { passed: 0, failed: 0, skipped: 0, not_run: 0 };
    for (const t of rowTests) counts[t.status]++;
    const evidence = results ? [...new Set(rowTests.map((t) => results.lookup(t).source).filter((s): s is string => s !== null))].sort() : [];
    const fo = foByOriginal.get(r.id) ?? [];
    return {
      id: r.id,
      kind: r.kind,
      text: r.text,
      section: r.section,
      enforcement: r.enforcement,
      verification: r.verification,
      tests: rowTests,
      counts,
      latestResult: localOf(rowTests.map((t) => t.status)),
      externalBlock: r.externalBlock,
      evidence,
      followOnIds: fo.map((f) => f.id),
      axes: followOn ? axesOf(fo) : null,
    };
  });
  const foById = new Map(followOnRows.map((f) => [f.id, f] as const));
  const capabilities: CapabilityRow[] = (followOn?.capabilities ?? []).map((c) => {
    const members = c.memberRequirementIds.map((m) => foById.get(m)).filter((m): m is FollowOnRow => m !== undefined);
    return { id: c.id, title: c.title, requirements: members.length, softwareCounts: tally(members.map((m) => m.software)), ...axesOf(members) };
  });
  // Invariant register x recorded results (FO-19-05).
  const findTest = (ref: RegisterTestRef): TaggedTest | null => tests.find((t) => t.file === ref.file && t.kind !== "describe" && t.title.includes(ref.title)) ?? null;
  const role = (refs: readonly RegisterTestRef[]): InvariantRoleResult => {
    const found = refs.map((ref) => {
      const t = findTest(ref);
      return { file: ref.file, title: ref.title, line: t?.line ?? null, status: t ? statusOf(t) : ("not_run" as TestStatus) };
    });
    return { tests: found, result: qualificationOfTests(found.map((f) => f.status)) };
  };
  const invariants: InvariantRow[] = catalog.catalog.requirements
    .filter((r) => r.kind === "invariant" && r.register)
    .map((r) => {
      const g = r.register as NonNullable<RequirementEntry["register"]>;
      const positive = role(g.positiveTests);
      const adversarial = role(g.adversarialTests);
      const failureInjection = role(g.failureInjectionTests);
      return {
        id: r.id,
        followOnId: g.followOnId,
        threatIds: g.threatIds,
        ownerRole: g.ownerRole,
        ownerPackage: g.ownerPackage,
        activationDependency: g.activationDependency,
        secondaryPackages: g.secondaryPackages,
        openGaps: g.openGaps,
        positive,
        adversarial,
        failureInjection,
        allRoles: combineQualification([positive.result, adversarial.result, failureInjection.result]),
      };
    });
  // Register completeness and the follow-on mapping are checked for the repository (follow-on inputs present);
  // a fixture catalogue without docs/followon reports its matrix only.
  const issues = followOn ? followOnIssues(followOn, catalog) : [];
  const local = (["PASS", "FAIL", "NOT_RUN", "NO_TEST"] as const).map((k) => [k, rows.filter((r) => r.latestResult === k).length] as const);
  return {
    traceabilityVersion: TRACEABILITY_VERSION,
    catalogVersion: catalog.catalog.catalogVersion,
    catalogDigest: catalog.digest,
    generatedAt,
    resultSources: results?.sources ?? [],
    followOnSources: followOn ? { ...followOn.digests, asOf: followOn.asOf } : null,
    rows,
    followOnRows,
    capabilities,
    invariants,
    faults,
    unknownTags: [...unknown.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([tag, ts]) => ({ tag, tests: ts })),
    gaps: rows.filter((r) => r.tests.length === 0).map((r) => r.id),
    issues,
    summary: {
      requirements: rows.length,
      taggedTests: tests.length,
      localTests: Object.fromEntries(local) as Record<LocalTestsResult, number>,
      externallyBlocked: rows.filter((r) => r.externalBlock).length,
      followOn: followOn
        ? {
            requirements: followOnRows.length,
            software: tally(followOnRows.map((f) => f.software)),
            environment: tally(followOnRows.map((f) => f.environment)),
            qualification: tally(followOnRows.map((f) => f.qualification)),
          }
        : null,
      capabilities: followOn
        ? { count: capabilities.length, software: tally(capabilities.map((c) => c.software)), environment: tally(capabilities.map((c) => c.environment)), qualification: tally(capabilities.map((c) => c.qualification)) }
        : null,
      invariants: invariants.length > 0 ? { count: invariants.length, allRolesPass: invariants.filter((i) => i.allRoles === "PASS").length, failureInjectionPass: invariants.filter((i) => i.failureInjection.result === "PASS").length } : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const short = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const counts = (r: Record<string, number>) =>
  Object.entries(r)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k} ${v}`)
    .join(", ") || "—";

export function renderTraceabilityMarkdown(rep: TraceabilityReport): string {
  const L: string[] = [];
  L.push("# Requirements traceability", "");
  L.push(
    "<!-- GENERATED FILE: do not edit by hand. Sources: docs/requirements/catalog.yaml, docs/followon/{requirements,gap-ledger,capabilities,activation-register}.yaml, scenarios/fixtures/failures; generator: platform/src/evaluation/traceability.ts -->",
    "",
  );
  L.push(`Report \`${rep.traceabilityVersion}\`. Catalogue version \`${rep.catalogVersion}\` (sha256 \`${rep.catalogDigest.slice(0, 16)}…\`). Generated at ${rep.generatedAt}.  `);
  if (rep.followOnSources) L.push(`Follow-on ledger as of ${rep.followOnSources.asOf ?? "UNKNOWN"} (gap-ledger sha256 \`${rep.followOnSources.gapLedger.slice(0, 16)}…\`).  `);
  L.push(
    rep.resultSources.length > 0
      ? `Test results joined from: ${rep.resultSources.map((s) => `\`${s}\``).join(", ")}.${rep.resultSources.some((s) => s.startsWith("local-run:")) ? " `local-run:` reports come from a local run that is not committed (the coordinator regenerates this file from the committed reports)." : ""}`
      : "**No test-result report was supplied: every tagged requirement is NOT_RUN** (tags alone are not evidence).",
    "",
  );
  L.push("## Status vocabulary", "");
  L.push("Two independent axes plus qualification (follow-on prompt section 0, ADR-0018 decision 7):", "");
  L.push("| Axis | Values | Source |", "|---|---|---|");
  L.push("| Software | `MISSING` < `IMPLEMENTED` < `VERIFIED_LOCAL` < `RELEASE_PACKAGE_VERIFIED` | `docs/followon/gap-ledger.yaml` per follow-on requirement |");
  L.push("| Environment | `NOT_CONFIGURED` < `CONFIGURED` < `VERIFIED_SANDBOX` < `APPROVED_PILOT` < `VERIFIED_PRODUCTION` | `docs/followon/gap-ledger.yaml` |");
  L.push("| Qualification | `NOT_RUN`, `FAIL`, `INCONCLUSIVE`, `PASS` | `docs/followon/gap-ledger.yaml` (evidence under `evidence/`) |");
  L.push("| Local tests | `NO_TEST`, `NOT_RUN`, `FAIL`, `PASS` | tagged tests joined with the recorded reports above (software evidence, never qualification) |");
  L.push(
    "",
    "A capability or catalogue requirement is never reported ahead of its least advanced follow-on member; qualification is PASS only when every member is PASS. Unknown, missing evidence and unrun tests are not PASS (OPS-03). This generator never raises a status.",
    "",
  );
  const s = rep.summary;
  L.push("## Summary", "");
  if (s.followOn) {
    L.push("| Scope | Count | Software | Environment | Qualification |", "|---|---|---|---|---|");
    L.push(`| Follow-on requirements | ${s.followOn.requirements} | ${counts(s.followOn.software)} | ${counts(s.followOn.environment)} | ${counts(s.followOn.qualification)} |`);
    if (s.capabilities) L.push(`| Capabilities | ${s.capabilities.count} | ${counts(s.capabilities.software)} | ${counts(s.capabilities.environment)} | ${counts(s.capabilities.qualification)} |`);
    L.push("");
  }
  L.push("| Catalogue requirements | Tagged tests | Local PASS | Local NOT_RUN | Local NO_TEST | Local FAIL | Externally blocked |", "|---|---|---|---|---|---|---|");
  L.push(`| ${s.requirements} | ${s.taggedTests} | ${s.localTests.PASS} | ${s.localTests.NOT_RUN} | ${s.localTests.NO_TEST} | ${s.localTests.FAIL} | ${s.externallyBlocked} |`, "");
  if (s.invariants) L.push(`Invariants: ${s.invariants.count}; all three test roles PASS for ${s.invariants.allRolesPass}; failure injection PASS for ${s.invariants.failureInjectionPass}.`, "");
  if (rep.faults) {
    const ledger = rep.faults.ledgerIssues === null ? "gap ledger not read" : `plan versus gap-ledger disagreements ${rep.faults.ledgerIssues.length}`;
    L.push(`Fault registry: ${rep.faults.denominator} faults (fixed denominator); Layer-2 [FAULT:] status ${counts(rep.faults.summary.layer2)}; ${ledger}; fault tags naming no plan ${rep.faults.unknownFaultTags.length}.`, "");
  }
  L.push("## Issues", "");
  L.push(rep.issues.length === 0 ? "None (every originalId resolves, no activation id is used as an originalId, every catalogue id has a follow-on row, the register is complete)." : rep.issues.map((i) => `- \`${i}\``).join("\n"), "");

  if (rep.invariants.length > 0) {
    L.push("## Invariant register (FO-02-28, FO-19-05)", "");
    L.push("Positive, direct adversarial and failure-injection tests per invariant (`docs/requirements/catalog.yaml` `register`). A role is PASS only when every cited test passed in a recorded report.", "");
    L.push("| Invariant | FO row | Threats | Positive | Adversarial | Failure injection | All roles | Owner | Activation | Open gaps |", "|---|---|---|---|---|---|---|---|---|---|");
    for (const i of rep.invariants) {
      L.push(
        `| ${i.id} | ${i.followOnId} | ${i.threatIds.join(", ")} | ${i.positive.result} (${i.positive.tests.length}) | ${i.adversarial.result} (${i.adversarial.tests.length}) | ${i.failureInjection.result} (${i.failureInjection.tests.length}) | ${i.allRoles} | ${esc(i.ownerRole)} (${i.ownerPackage}) | ${i.activationDependency.join(", ") || "none"} | ${i.openGaps.join(", ") || "—"} |`,
      );
    }
    L.push("");
  }
  if (rep.capabilities.length > 0) {
    L.push("## Capabilities", "");
    L.push("| Capability | Title | Requirements | Software | Environment | Qualification |", "|---|---|---|---|---|---|");
    for (const c of rep.capabilities) L.push(`| \`${c.id}\` | ${esc(short(c.title, 60))} | ${c.requirements} | ${c.software} | ${c.environment} | ${c.qualification} |`);
    L.push("");
  }
  if (rep.faults) {
    L.push("## Fault registry (FO-17-24)", "");
    L.push("| Fault | Injection point | Injection-point packages | Layer-2 owner | Local driver | Layer-2 [FAULT:] tests | Layer-2 status |", "|---|---|---|---|---|---|---|");
    for (const f of rep.faults.rows) {
      const l2 = f.tests.filter((t) => !t.seam && t.layer !== "layer1").length;
      L.push(`| \`${f.faultId}\` | ${esc(short(f.injectionPoint, 70))} | ${f.injectionPointPackages.join(", ")} | ${f.layer2Owner} | ${f.localDriver} | ${l2} | ${f.layer2} |`);
    }
    L.push("");
    // Shown, never folded into "Issues": the gap ledger is regenerated from docs/followon/source by the status-docs
    // owner, so a disagreement is that owner's to resolve; hiding it here would overstate the registry's state.
    const li = rep.faults.ledgerIssues;
    L.push(`Plan versus gap-ledger disagreements (fault-registry.ts crossCheckLedger; resolved by regenerating docs/followon from its sources): ${li === null ? "not checked (gap ledger not read)" : li.length === 0 ? "none" : li.length}.`, "");
    for (const i of li ?? []) L.push(`- \`${i}\``);
    if ((li ?? []).length > 0) L.push("");
    L.push(`Fault tags naming no plan: ${rep.faults.unknownFaultTags.length === 0 ? "none" : rep.faults.unknownFaultTags.map((t) => `\`${t.faultId}\` (${t.file}:${t.line})`).join(", ")}.`, "");
  }
  L.push("## Catalogue matrix", "");
  L.push("| Requirement | Text (short) | Enforcement location | Test IDs | Local tests | Evidence path | FO rows | Software | Environment | Qualification |", "|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rep.rows) {
    const refs = r.tests.slice(0, 3).map((t) => `\`${t.file}:${t.line}\`${t.viaAlias ? ` (as ${t.viaAlias})` : ""}`);
    const more = r.tests.length > 3 ? ` (+${r.tests.length - 3} more)` : "";
    const testsCell = r.tests.length === 0 ? "—" : `${r.tests.length}: ${refs.join("<br>")}${more}`;
    const latest = r.latestResult === "PASS" ? `PASS (${r.counts.passed}/${r.tests.length})` : r.latestResult === "FAIL" ? `FAIL (${r.counts.failed} failed)` : r.latestResult;
    const fo = r.followOnIds.length === 0 ? "—" : `${r.followOnIds.length}`;
    L.push(
      `| ${r.id} | ${esc(short(r.text))} | ${r.enforcement.map((e) => `\`${e}\``).join(", ")} | ${testsCell} | ${latest} | ${r.evidence.length > 0 ? r.evidence.map((e) => `\`${e}\``).join(", ") : "—"} | ${fo} | ${r.axes?.software ?? "—"} | ${r.axes?.environment ?? "—"} | ${r.axes?.qualification ?? "—"} |`,
    );
  }
  L.push("", "## Gaps (catalogue requirements with no tagged test)", "");
  L.push(rep.gaps.length === 0 ? "None." : rep.gaps.map((g) => `- ${g}`).join("\n"), "");
  L.push("## Unknown tags (used in tests, in neither the catalogue nor the follow-on requirements)", "");
  if (rep.unknownTags.length === 0) L.push("None.");
  else for (const u of rep.unknownTags) L.push(`- \`${u.tag}\` — ${u.tests.length} test(s), e.g. \`${u.tests[0]?.file}:${u.tests[0]?.line}\``);
  L.push("", "## Failing tests", "");
  const failing = rep.rows.flatMap((r) => r.tests.filter((t) => t.status === "failed").map((t) => `- ${r.id}: \`${t.file}:${t.line}\` ${esc(short(t.title, 120))}`));
  L.push(failing.length === 0 ? "None recorded." : [...new Set(failing)].join("\n"), "");
  L.push("## Externally blocked catalogue requirements", "", "| Requirement | Reason | Prerequisites |", "|---|---|---|");
  for (const r of rep.rows.filter((x) => x.externalBlock)) L.push(`| ${r.id} | ${esc(r.externalBlock?.reason ?? "")} | ${r.externalBlock?.prerequisites.join(", ")} |`);
  L.push("");
  if (rep.followOnRows.length > 0) {
    L.push("## Follow-on requirements", "");
    L.push("| Requirement | Kind | Text (short) | Original ids | Capabilities | Package | Software | Environment | Qualification | Tagged tests |", "|---|---|---|---|---|---|---|---|---|---|");
    for (const f of rep.followOnRows) {
      L.push(
        `| ${f.id} | ${f.kind} | ${esc(short(f.text, 80))} | ${f.originalIds.join(", ") || "—"} | ${f.capabilityIds.join(", ") || "—"} | ${f.workPackage ?? "—"} | ${f.software} | ${f.environment} | ${f.qualification} | ${f.taggedTests === 0 ? "—" : `${f.taggedTests} (${f.localTests})`} |`,
      );
    }
    L.push("");
  }
  return L.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function argValues(argv: readonly string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === name && argv[i + 1] !== undefined) out.push(argv[i + 1] as string);
  return out;
}

/** Follow-on inputs when the repository has them (a fixture tree without docs/followon reports the catalogue only). */
function followOnIfPresent(root: string): FollowOnInputs | null {
  return existsSync(join(root, "docs", "followon", "requirements.yaml")) ? loadFollowOn(root) : null;
}

export function main(argv: readonly string[]): number {
  const root = resolve(argValues(argv, "--root")[0] ?? REPO_ROOT);
  const p = repoPaths(root);
  const abs = (x: string) => (isAbsolute(x) ? x : resolve(process.cwd(), x));
  const check = argv.includes("--check");
  let catalog: LoadedCatalog;
  let followOn: FollowOnInputs | null;
  try {
    catalog = loadCatalog(argValues(argv, "--catalog")[0] ? abs(argValues(argv, "--catalog")[0] as string) : p.catalog);
    followOn = followOnIfPresent(root);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 2;
  }
  const vitest = argValues(argv, "--vitest-report").map(abs);
  const opa = argValues(argv, "--opa-report").map(abs);
  const results = vitest.length + opa.length > 0 ? buildResultIndex(root, vitest, opa) : null;
  const generatedAt = argValues(argv, "--generated-at")[0] ?? new Date().toISOString();
  const plans = existsSync(p.failures) ? loadFaultPlans(p.failures) : null;
  const faults = plans && plans.size > 0 ? buildFaultRegistry(plans, scanFaultTests(root), results, followOn ? ledgerFaultRows(followOn.ledger) : null) : null;
  const report = buildTraceability(catalog, scanTaggedTests(root), results, generatedAt, followOn, faults);
  if (report.issues.length > 0) {
    for (const i of report.issues) process.stderr.write(`TRACEABILITY ERROR: ${i}\n`);
    process.stderr.write(`${report.issues.length} traceability error(s); nothing written\n`);
    return 1;
  }
  const s = report.summary;
  const line = `traceability: ${s.requirements} catalogue requirements, ${s.followOn?.requirements ?? 0} follow-on requirements, ${s.capabilities?.count ?? 0} capabilities, ${s.taggedTests} tagged tests; local PASS=${s.localTests.PASS} NOT_RUN=${s.localTests.NOT_RUN} NO_TEST=${s.localTests.NO_TEST} FAIL=${s.localTests.FAIL}; invariants all-roles PASS=${s.invariants?.allRolesPass ?? 0}/${s.invariants?.count ?? 0}; unknown tags=${report.unknownTags.length}`;
  if (check) {
    process.stdout.write(`${line} (check only, nothing written)\n`);
    return 0;
  }
  const out = argValues(argv, "--out")[0] ? abs(argValues(argv, "--out")[0] as string) : p.traceabilityOut;
  writeFileSync(out, renderTraceabilityMarkdown(report));
  const json = argValues(argv, "--json")[0];
  if (json) writeFileSync(abs(json), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${line} -> ${posixRelative(root, out)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
