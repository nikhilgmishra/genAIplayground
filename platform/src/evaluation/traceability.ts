/**
 * Requirements traceability generator (spec section 14: "Every requirement must
 * map to enforcement location, test IDs, evidence and release status").
 *
 * Scans test titles for requirement tags:
 *   platform/src/**\/*.test.ts, platform/test/**\/*.test.ts      it/test/describe titles
 *   console/src/**\/*.test.tsx (and .test.ts)                    it/test/describe titles
 *   policy/**\/*_test.rego                                       "# [TAG]" comments before test_ rules
 * optionally joins test results from vitest JSON reports
 *   (npx vitest run --reporter=json --outputFile=<file>) and `opa test --format=json` output,
 * and renders docs/REQUIREMENTS_TRACEABILITY.md.
 *
 * Status rules (OPS-03: unknown, missing evidence and unrun tests are not PASS):
 *   NO_TEST              no tagged test exists
 *   NOT_RUN              tagged tests exist but at least one has no recorded result (or was skipped)
 *   FAILING              at least one tagged test failed
 *   IMPLEMENTED_OFFLINE  >= 1 tagged test and every tagged test passed in a recorded run
 *   BLOCKED              verification beyond the offline slice depends on an external prerequisite;
 *                        BLOCKED overrides the release status for sandbox/production readiness.
 *
 * Usage: tsx src/evaluation/traceability.ts [--root <repo>] [--vitest-report <file>]... [--opa-report <file>]
 *          [--out <md>] [--json <file>] [--generated-at <iso>]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadCatalog } from "./catalog.js";
import type { LoadedCatalog, RequirementEntry } from "./catalog.js";
import { REPO_ROOT, posixRelative, repoPaths, walkFiles } from "./paths.js";

export const TAG_PATTERN = /\[([A-Z][A-Z0-9]{1,7}-[A-Za-z0-9][A-Za-z0-9.-]*)\]/g;

export interface TaggedTest {
  /** Repository-relative POSIX path. */
  file: string;
  line: number;
  title: string;
  kind: "it" | "test" | "describe" | "rego";
  tags: string[];
}

export type TestStatus = "passed" | "failed" | "skipped" | "not_run";

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

const toStatus = (s: string | undefined): TestStatus => (s === "passed" ? "passed" : s === "failed" ? "failed" : s === "skipped" || s === "pending" || s === "todo" ? "skipped" : "not_run");

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

const combineStatuses = (xs: TestStatus[]): TestStatus =>
  xs.length === 0 ? "not_run" : xs.includes("failed") ? "failed" : xs.every((x) => x === "passed") ? "passed" : xs.includes("not_run") ? "not_run" : "skipped";

export function buildResultIndex(root: string, vitestReports: readonly string[], opaReports: readonly string[] = []): TestResultIndex {
  const files: { source: string; file: string; assertions: VitestAssertion[] }[] = [];
  const opa: { source: string; file: string; name: string; status: TestStatus }[] = [];
  const rel = (p: string) => (isAbsolute(p) ? posixRelative(root, p) : p.split("\\").join("/"));
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
        return { status: combineStatuses(hits.map((h) => h.status)), source: hits[0]?.source ?? null };
      }
      const match = titleMatcher(test.title);
      const statuses: TestStatus[] = [];
      let source: string | null = null;
      for (const f of files) {
        if (!sameFile(f.file, test.file)) continue;
        for (const a of f.assertions) {
          const hit = test.kind === "describe" ? (a.ancestorTitles ?? []).some(match) : match(a.title ?? "");
          if (hit) {
            statuses.push(toStatus(a.status));
            source = f.source;
          }
        }
      }
      return { status: combineStatuses(statuses), source };
    },
  };
}

// ---------------------------------------------------------------------------
// Matrix
// ---------------------------------------------------------------------------

export type OfflineStatus = "IMPLEMENTED_OFFLINE" | "NOT_RUN" | "NO_TEST" | "FAILING";
export type TraceReleaseStatus = OfflineStatus | "BLOCKED";

export interface RequirementRow {
  id: string;
  kind: RequirementEntry["kind"];
  text: string;
  section: string;
  enforcement: string[];
  verification: string[];
  tests: (TaggedTest & { status: TestStatus; viaAlias: string | null })[];
  counts: Record<TestStatus, number>;
  latestResult: "PASS" | "FAIL" | "NOT_RUN" | "NO_TEST";
  offlineStatus: OfflineStatus;
  releaseStatus: TraceReleaseStatus;
  externalBlock: RequirementEntry["externalBlock"];
  evidence: string[];
}

export interface TraceabilityReport {
  catalogVersion: string;
  catalogDigest: string;
  generatedAt: string;
  resultSources: string[];
  rows: RequirementRow[];
  unknownTags: { tag: string; tests: { file: string; line: number }[] }[];
  gaps: string[];
  summary: Record<TraceReleaseStatus, number> & { requirements: number; taggedTests: number; offline: Record<OfflineStatus, number> };
}

export function buildTraceability(catalog: LoadedCatalog, tests: readonly TaggedTest[], results: TestResultIndex | null, generatedAt: string): TraceabilityReport {
  const byReq = new Map<string, RequirementRow["tests"]>();
  const unknown = new Map<string, { file: string; line: number }[]>();
  for (const t of tests) {
    const status = results ? results.lookup(t).status : "not_run";
    for (const tag of t.tags) {
      const canonical = catalog.resolve(tag);
      if (!canonical) {
        unknown.set(tag, [...(unknown.get(tag) ?? []), { file: t.file, line: t.line }]);
        continue;
      }
      byReq.set(canonical, [...(byReq.get(canonical) ?? []), { ...t, status, viaAlias: canonical === tag ? null : tag }]);
    }
  }
  const rows: RequirementRow[] = catalog.catalog.requirements.map((r) => {
    const rowTests = byReq.get(r.id) ?? [];
    const counts: Record<TestStatus, number> = { passed: 0, failed: 0, skipped: 0, not_run: 0 };
    for (const t of rowTests) counts[t.status]++;
    const offlineStatus: OfflineStatus =
      rowTests.length === 0 ? "NO_TEST" : counts.failed > 0 ? "FAILING" : counts.passed === rowTests.length ? "IMPLEMENTED_OFFLINE" : "NOT_RUN";
    const latestResult = rowTests.length === 0 ? "NO_TEST" : counts.failed > 0 ? "FAIL" : counts.passed === rowTests.length ? "PASS" : "NOT_RUN";
    const evidence = results
      ? [...new Set(rowTests.map((t) => results.lookup(t).source).filter((s): s is string => s !== null))].sort()
      : [];
    return {
      id: r.id,
      kind: r.kind,
      text: r.text,
      section: r.section,
      enforcement: r.enforcement,
      verification: r.verification,
      tests: rowTests,
      counts,
      latestResult,
      offlineStatus,
      releaseStatus: r.externalBlock ? "BLOCKED" : offlineStatus,
      externalBlock: r.externalBlock,
      evidence,
    };
  });
  const tally = <K extends string>(keys: readonly K[], pick: (r: RequirementRow) => K) =>
    Object.fromEntries(keys.map((k) => [k, rows.filter((r) => pick(r) === k).length])) as Record<K, number>;
  const offlineKeys = ["IMPLEMENTED_OFFLINE", "NOT_RUN", "NO_TEST", "FAILING"] as const;
  return {
    catalogVersion: catalog.catalog.catalogVersion,
    catalogDigest: catalog.digest,
    generatedAt,
    resultSources: results?.sources ?? [],
    rows,
    unknownTags: [...unknown.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([tag, ts]) => ({ tag, tests: ts })),
    gaps: rows.filter((r) => r.tests.length === 0).map((r) => r.id),
    summary: {
      ...tally(["IMPLEMENTED_OFFLINE", "NOT_RUN", "NO_TEST", "FAILING", "BLOCKED"] as const, (r) => r.releaseStatus),
      requirements: rows.length,
      taggedTests: tests.length,
      offline: tally(offlineKeys, (r) => r.offlineStatus),
    },
  };
}

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const short = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export function renderTraceabilityMarkdown(rep: TraceabilityReport): string {
  const L: string[] = [];
  L.push("# Requirements traceability", "");
  L.push("<!-- GENERATED FILE: do not edit by hand. Source: docs/requirements/catalog.yaml; generator: platform/src/evaluation/traceability.ts -->", "");
  L.push(`Catalogue version \`${rep.catalogVersion}\` (sha256 \`${rep.catalogDigest.slice(0, 16)}…\`). Generated at ${rep.generatedAt}.  `);
  L.push(
    rep.resultSources.length > 0
      ? `Test results joined from: ${rep.resultSources.map((s) => `\`${s}\``).join(", ")}.`
      : "**No test-result report was supplied: every tagged requirement is NOT_RUN** (tags alone are not evidence).",
    "",
  );
  L.push("## Status legend", "");
  L.push("| Status | Meaning |", "|---|---|");
  L.push("| `IMPLEMENTED_OFFLINE` | At least one tagged test exists and every tagged test passed in a recorded run (local fixtures / synthetic data only) |");
  L.push("| `NOT_RUN` | Tagged tests exist but at least one has no recorded result or was skipped |");
  L.push("| `NO_TEST` | No test carries this requirement's tag (gap) |");
  L.push("| `FAILING` | At least one tagged test failed |");
  L.push("| `BLOCKED` | Verification beyond the offline slice depends on an external prerequisite; overrides the release status for sandbox/production readiness (offline status shown in brackets) |");
  L.push("", "`VERIFIED_SANDBOX`, `APPROVED_PILOT` and `VERIFIED_PRODUCTION` are never produced by this generator: they require sandbox or production evidence and human approvals. Unknown, missing evidence and unrun tests are not PASS (OPS-03).", "");
  const s = rep.summary;
  L.push("## Summary", "");
  L.push("| Requirements | Tagged tests | IMPLEMENTED_OFFLINE | NOT_RUN | NO_TEST | FAILING | BLOCKED (release) |", "|---|---|---|---|---|---|---|");
  L.push(`| ${s.requirements} | ${s.taggedTests} | ${s.offline.IMPLEMENTED_OFFLINE} | ${s.offline.NOT_RUN} | ${s.offline.NO_TEST} | ${s.offline.FAILING} | ${s.BLOCKED} |`, "");
  L.push("Offline columns count every requirement by its offline status; BLOCKED counts requirements whose release status is externally blocked.", "");
  L.push("## Matrix", "");
  L.push("| Requirement | Text (short) | Enforcement location | Test IDs | Latest result | Evidence path | Release status |", "|---|---|---|---|---|---|---|");
  for (const r of rep.rows) {
    const refs = r.tests.slice(0, 4).map((t) => `\`${t.file}:${t.line}\`${t.viaAlias ? ` (as ${t.viaAlias})` : ""}`);
    const more = r.tests.length > 4 ? ` (+${r.tests.length - 4} more)` : "";
    const tests = r.tests.length === 0 ? "—" : `${r.tests.length}: ${refs.join("<br>")}${more}`;
    const latest = r.latestResult === "PASS" ? `PASS (${r.counts.passed}/${r.tests.length})` : r.latestResult === "FAIL" ? `FAIL (${r.counts.failed} failed)` : r.latestResult;
    const release = r.releaseStatus === "BLOCKED" ? `BLOCKED (offline: ${r.offlineStatus}; ${r.externalBlock?.prerequisites.join(", ")})` : r.releaseStatus;
    L.push(`| ${r.id} | ${esc(short(r.text))} | ${r.enforcement.map((e) => `\`${e}\``).join(", ")} | ${tests} | ${latest} | ${r.evidence.length > 0 ? r.evidence.map((e) => `\`${e}\``).join(", ") : "—"} | ${release} |`);
  }
  L.push("", "## Gaps (no tagged test)", "");
  L.push(rep.gaps.length === 0 ? "None." : rep.gaps.map((g) => `- ${g}`).join("\n"), "");
  L.push("## Unknown tags (used in tests, not in the catalogue)", "");
  if (rep.unknownTags.length === 0) L.push("None.");
  else for (const u of rep.unknownTags) L.push(`- \`${u.tag}\` — ${u.tests.length} test(s), e.g. \`${u.tests[0]?.file}:${u.tests[0]?.line}\``);
  L.push("", "## Failing tests", "");
  const failing = rep.rows.flatMap((r) => r.tests.filter((t) => t.status === "failed").map((t) => `- ${r.id}: \`${t.file}:${t.line}\` ${esc(short(t.title, 120))}`));
  L.push(failing.length === 0 ? "None recorded." : [...new Set(failing)].join("\n"), "");
  L.push("## Externally blocked requirements", "", "| Requirement | Reason | Prerequisites |", "|---|---|---|");
  for (const r of rep.rows.filter((x) => x.externalBlock)) L.push(`| ${r.id} | ${esc(r.externalBlock?.reason ?? "")} | ${r.externalBlock?.prerequisites.join(", ")} |`);
  L.push("");
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

export function main(argv: readonly string[]): number {
  const root = resolve(argValues(argv, "--root")[0] ?? REPO_ROOT);
  const p = repoPaths(root);
  const abs = (x: string) => (isAbsolute(x) ? x : resolve(process.cwd(), x));
  let catalog: LoadedCatalog;
  try {
    catalog = loadCatalog(argValues(argv, "--catalog")[0] ? abs(argValues(argv, "--catalog")[0] as string) : p.catalog);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 2;
  }
  const vitest = argValues(argv, "--vitest-report").map(abs);
  const opa = argValues(argv, "--opa-report").map(abs);
  const results = vitest.length + opa.length > 0 ? buildResultIndex(root, vitest, opa) : null;
  const generatedAt = argValues(argv, "--generated-at")[0] ?? new Date().toISOString();
  const report = buildTraceability(catalog, scanTaggedTests(root), results, generatedAt);
  const out = argValues(argv, "--out")[0] ? abs(argValues(argv, "--out")[0] as string) : p.traceabilityOut;
  writeFileSync(out, renderTraceabilityMarkdown(report));
  const json = argValues(argv, "--json")[0];
  if (json) writeFileSync(abs(json), `${JSON.stringify(report, null, 2)}\n`);
  const s = report.summary;
  process.stdout.write(
    `traceability: ${s.requirements} requirements, ${s.taggedTests} tagged tests; offline IMPLEMENTED_OFFLINE=${s.offline.IMPLEMENTED_OFFLINE} NOT_RUN=${s.offline.NOT_RUN} NO_TEST=${s.offline.NO_TEST} FAILING=${s.offline.FAILING}; release BLOCKED=${s.BLOCKED}; unknown tags=${report.unknownTags.length} -> ${posixRelative(root, out)}\n`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
