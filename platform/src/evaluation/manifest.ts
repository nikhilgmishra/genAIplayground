/**
 * Release manifest builder (spec section 16; invariants OPS-06, OPS-04, OPS-03).
 *
 * Binds source commit, build/image digest, infrastructure plan, schema version,
 * migrations digest, Talkdesk configuration id, model/voice configuration,
 * tool-schema digest, policy bundle, knowledge snapshot, evaluation corpus, test
 * evidence, quota and load evidence, retention configuration, rollback target
 * and approvals into a strict ReleaseManifest.
 *
 * It never fabricates anything: approvals are only read from approvals/*.json
 * (none exist; the coding agent cannot create them), absent pins are recorded
 * as placeholders with a BLOCKED reason, and the manifest signature stays null
 * because signing needs a KMS key that does not exist (PRQ-023).
 *
 * Status: IMPLEMENTED_OFFLINE for local/ci targets backed by local evidence;
 * BLOCKED for sandbox, staging and production while any approval, pin or
 * eligible evidence is missing. Staging and production promotion is always a
 * human release decision, so software never emits APPROVED_PILOT or
 * VERIFIED_PRODUCTION.
 *
 * Usage: tsx src/evaluation/manifest.ts --env <local|ci|sandbox|staging|production> [--out-dir <dir>] [--dry-run]
 *   [--tool-catalog-digest <sha256>] [--knowledge-snapshot-digest <sha256>] [--image-digest sha256:<hex>] [--build-id <id>]
 *   [--source-commit <40 hex; must equal HEAD>] [--infra-plan-digest <sha256>] [--talkdesk-config-id <id>]
 *   [--retention-digest <sha256>] [--rollback-target <ref>]
 * (or `pnpm evidence manifest ...`). Unknown, repeated or value-less flags exit 2 (OPS-REL-02);
 * `--dry-run` validates the exact command line and writes nothing. .github/workflows/release.yml
 * runs this command; scripts/ci/check-release-manifest.test.ts executes that step verbatim.
 */
import { execFileSync } from "node:child_process";
import type { KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Environment, PROTOCOL_VERSION, ReleaseManifest } from "../protocol/index.js";
import type { ApprovalScope, ReleaseStatus, VersionSet } from "../protocol/index.js";
import { evaluateApproval, loadApprovalRecords, parseTrustedPublicKey, releaseSubjectExpectations } from "../config/approvals.js";
import type { ApprovalEvaluation } from "../config/approvals.js";
import { REQUIRED_APPROVALS_BY_ENVIRONMENT } from "../config/guard.js";
import { migrationsDigest } from "../db/migrate.js";
import { sha256Hex } from "../shared/canonical.js";
import { systemClock } from "../shared/clock.js";
import type { Clock } from "../shared/clock.js";
import { newId } from "../shared/ids.js";
import { corpusDigest } from "./corpus.js";
import { REPO_ROOT, posixRelative, repoPaths, walkFiles } from "./paths.js";
import { SCORER_GATES } from "./scorer.js";
import { classifyRecordedTest, verdictOfTests } from "./unknown.js";
import type { RecordedTestStatus } from "./unknown.js";

export const UNPINNED_DIGEST = sha256Hex("UNPINNED");
const SHA256 = /^[a-f0-9]{64}$/;

/**
 * Required approvals per target environment: the production guard's floor
 * (REQUIRED_APPROVALS_BY_ENVIRONMENT) plus release-level additions. For sandbox
 * the guard checks VENDOR_SANDBOX_INTEGRATION per live adapter; a sandbox
 * release requires at least one.
 */
const RELEASE_EXTRA: Readonly<Partial<Record<Environment, readonly ApprovalScope[]>>> = { sandbox: ["VENDOR_SANDBOX_INTEGRATION"] };
export const requiredApprovalsFor = (env: Environment): ApprovalScope[] => [...new Set<ApprovalScope>([...REQUIRED_APPROVALS_BY_ENVIRONMENT[env], ...(RELEASE_EXTRA[env] ?? [])])];

export interface GitReader {
  head(): string | null;
  /** True when tracked or untracked changes exist (the commit would not bind the built source). */
  dirty(): boolean | null;
}

/** Read-only git access (rev-parse, status with optional locks disabled). */
export function gitReader(root: string): GitReader {
  const run = (args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }).trim();
  return {
    head: () => {
      try {
        const h = run(["rev-parse", "HEAD"]);
        return /^[a-f0-9]{40}$/.test(h) ? h : null;
      } catch {
        return null;
      }
    },
    dirty: () => {
      try {
        return run(["status", "--porcelain"]).length > 0;
      } catch {
        return null;
      }
    },
  };
}

export interface ManifestInput {
  targetEnvironment: Environment;
  root?: string;
  clock?: Clock;
  idSource?: () => string;
  git?: GitReader;
  toolCatalogDigest?: string | null;
  knowledgeSnapshotDigest?: string | null;
  versions?: VersionSet | null;
  build?: { buildId: string | null; imageDigest: string | null };
  /** Commit the caller built (CI's GITHUB_SHA). When set it must equal git HEAD, else SOURCE_COMMIT_MISMATCH blocks (OPS-REL-02). */
  expectedSourceCommit?: string | null;
  infrastructurePlanDigest?: string | null;
  talkdeskConfigurationId?: string | null;
  retentionConfigurationDigest?: string | null;
  rollbackTarget?: string | null;
  /** Trusted approval-signing PUBLIC key; absent => every approval is UNVERIFIED. */
  trustedApprovalKey?: KeyObject | string | null;
  approvalsDir?: string;
  evidenceDir?: string;
}

export interface ManifestBlocker {
  code: string;
  detail: string;
  prerequisites: string[];
}

export interface ManifestBuildResult {
  manifest: ReleaseManifest;
  blockers: ManifestBlocker[];
  notes: string[];
  requiredApprovals: ApprovalScope[];
  approvalEvaluations: ApprovalEvaluation[];
  rejectedApprovalFiles: { file: string; reasonCode: string }[];
}

type EvidenceStatus = "PASS" | "FAIL" | "INCONCLUSIVE" | "NOT_RUN" | "BLOCKED";
interface EvidenceRef {
  kind: string;
  ref: string;
  digest: string | null;
  status: EvidenceStatus;
}

function readPolicyDigest(path: string): string | null {
  try {
    const token = readFileSync(path, "utf8").trim().split(/\s+/)[0] ?? "";
    return SHA256.test(token) ? token : null;
  } catch {
    return null;
  }
}

/** Collects evidence references (with sha256) from the evidence directory; release manifests themselves are excluded. */
export function collectEvidence(root: string, evidenceDir: string, env: Environment): { tests: EvidenceRef[]; load: EvidenceRef[] } {
  const tests: EvidenceRef[] = [];
  const load: EvidenceRef[] = [];
  for (const abs of walkFiles(evidenceDir)) {
    const rel = posixRelative(root, abs);
    const inner = posixRelative(evidenceDir, abs);
    if (inner.startsWith("release/")) continue;
    const content = readFileSync(abs);
    const digest = sha256Hex(content);
    if (inner.startsWith("load/") || inner.startsWith("quota/")) {
      let status: EvidenceStatus = "INCONCLUSIVE";
      try {
        const j = JSON.parse(content.toString("utf8")) as { status?: string };
        if (j.status === "PASS" || j.status === "FAIL" || j.status === "BLOCKED" || j.status === "NOT_RUN") status = j.status;
      } catch {
        status = "INCONCLUSIVE";
      }
      load.push({ kind: inner.startsWith("load/") ? "load_test" : "quota_evidence", ref: rel, digest, status });
      continue;
    }
    if (/^runs\/[^/]+\/summary\.json$/.test(inner)) {
      let status: EvidenceStatus = "INCONCLUSIVE";
      try {
        const j = JSON.parse(content.toString("utf8")) as { gates?: Record<string, { status?: string }> };
        const g = j.gates?.[env]?.status;
        if (g === "PASS" || g === "FAIL" || g === "BLOCKED" || g === "INCONCLUSIVE") status = g;
      } catch {
        status = "INCONCLUSIVE";
      }
      tests.push({ kind: "evaluation_run", ref: rel, digest, status });
      continue;
    }
    if (inner.startsWith("runs/")) continue; // results.jsonl / call-evidence.jsonl are covered by the run summary
    if (inner.endsWith(".json")) {
      try {
        const j = JSON.parse(content.toString("utf8")) as { testResults?: unknown; success?: unknown };
        if (Array.isArray(j.testResults) && typeof j.success === "boolean") {
          tests.push({ kind: "test_report", ref: rel, digest, status: j.success ? "PASS" : "FAIL" });
          continue;
        }
      } catch {
        // fall through: unrecognized evidence file
      }
    }
    tests.push({ kind: "evidence_file", ref: rel, digest, status: "INCONCLUSIVE" });
  }
  return { tests, load };
}

/**
 * The scorer a release is gated with (FO-19-04: "record scorer version in the release manifest"). Its version is
 * the content of the files that decide verdicts, digested like the corpus (sorted `<path>:<sha256(content)>`
 * lines); its status is the recorded result of the scorer mutation suite (one mutation per gate family that must
 * turn the gate to FAIL or INCONCLUSIVE, SCORER_MUTATION_SUITE) in the test reports of the evidence directory.
 * No recorded result is NOT_RUN, a failed or skipped mutation case is FAIL or INCONCLUSIVE (one shared
 * classification, unknown.ts), and an unreadable source leaves the digest null and the entry INCONCLUSIVE: a
 * scorer that cannot be identified is never bound as if it were known (OPS-06, OPS-03).
 */
export const SCORER_SOURCES = [
  "platform/src/evaluation/aggregate.ts",
  "platform/src/evaluation/fault-plan.ts",
  "platform/src/evaluation/fault-reach.ts",
  "platform/src/evaluation/scorer.ts",
  "platform/src/evaluation/unknown.ts",
  "platform/src/evaluation/vocabulary.ts",
] as const;
export const SCORER_MUTATION_SUITE = "platform/src/evaluation/scorer.mutation.test.ts";

/** Digest of the scorer sources under `root` (null when any is unreadable). */
export function scorerDigest(root: string): string | null {
  try {
    return sha256Hex(SCORER_SOURCES.map((f) => `${f}:${sha256Hex(readFileSync(join(root, f)))}`).join("\n"));
  } catch {
    return null;
  }
}

/** Recorded statuses of the scorer mutation suite's tests in vitest JSON reports (`testResults[].assertionResults`). */
export function scorerMutationStatuses(reports: readonly unknown[]): RecordedTestStatus[] {
  const suite = SCORER_MUTATION_SUITE.slice("platform/".length);
  const out: RecordedTestStatus[] = [];
  for (const r of reports) {
    const files = (r as { testResults?: unknown }).testResults;
    if (!Array.isArray(files)) continue;
    for (const f of files as { name?: unknown; assertionResults?: unknown }[]) {
      if (typeof f.name !== "string" || !f.name.replace(/\\/g, "/").endsWith(`/${suite}`)) continue;
      for (const a of Array.isArray(f.assertionResults) ? (f.assertionResults as { status?: unknown }[]) : []) out.push(classifyRecordedTest(typeof a.status === "string" ? a.status : null));
    }
  }
  return out;
}

/** The `scorer_version` test-evidence entry: scorer digest plus the recorded mutation-suite result. */
export function scorerVersionEvidence(root: string, reports: readonly unknown[]): EvidenceRef {
  const digest = scorerDigest(root);
  const v = verdictOfTests(scorerMutationStatuses(reports));
  const status: EvidenceStatus = digest === null ? "INCONCLUSIVE" : v === "PASS" || v === "FAIL" || v === "NOT_RUN" ? v : "INCONCLUSIVE";
  return {
    kind: "scorer_version",
    ref: `platform/src/evaluation/scorer.ts SCORER_GATES (${Object.keys(SCORER_GATES).length} gate families); sources ${SCORER_SOURCES.map((f) => f.slice("platform/src/evaluation/".length)).join(",")}; mutation suite ${SCORER_MUTATION_SUITE}`,
    digest,
    status,
  };
}

const isLive = (env: Environment) => env === "sandbox" || env === "staging" || env === "production";

/** Schema bounds of ReleaseManifest.testEvidence / quotaAndLoadEvidence (protocol/release.ts). */
export const MAX_TEST_EVIDENCE = 128;
export const MAX_LOAD_EVIDENCE = 32;

/**
 * Bounded subset for the manifest (OPS-REL-01): every non-PASS entry is kept first (FAIL,
 * BLOCKED, NOT_RUN, INCONCLUSIVE), then PASS entries fill the remaining room; the result
 * keeps the original (sorted path) order. Callers decide blockers over the full list.
 */
export function boundEvidence<T extends { status: EvidenceStatus }>(all: readonly T[], max: number): T[] {
  if (all.length <= max) return [...all];
  const rank: Record<EvidenceStatus, number> = { FAIL: 0, BLOCKED: 1, NOT_RUN: 2, INCONCLUSIVE: 3, PASS: 4 };
  const keep = new Set(
    all
      .map((e, i) => ({ e, i }))
      .sort((a, b) => rank[a.e.status] - rank[b.e.status] || a.i - b.i)
      .slice(0, max)
      .map((x) => x.i),
  );
  return all.filter((_, i) => keep.has(i));
}
const unpinnedLabel = (v: string) => v === "UNPINNED" || v === "UNKNOWN";

export function buildReleaseManifest(input: ManifestInput): ManifestBuildResult {
  const env = Environment.parse(input.targetEnvironment);
  const root = input.root ?? REPO_ROOT;
  const p = repoPaths(root);
  const clock = input.clock ?? systemClock;
  const git = input.git ?? gitReader(root);
  const blockers: ManifestBlocker[] = [];
  const notes: string[] = [];
  const live = isLive(env);
  /** In live targets a missing pin blocks the release; locally it is only noted. */
  const gap = (code: string, detail: string, prerequisites: string[] = []) => {
    if (live) blockers.push({ code, detail, prerequisites });
    else notes.push(`${code}: ${detail}`);
  };

  // ---------- source ----------
  const head = git.head();
  if (!head) blockers.push({ code: "SOURCE_COMMIT_UNAVAILABLE", detail: "git rev-parse HEAD failed; the manifest cannot bind source", prerequisites: [] });
  if (input.expectedSourceCommit && head && input.expectedSourceCommit !== head) {
    blockers.push({ code: "SOURCE_COMMIT_MISMATCH", detail: "the commit supplied by the caller is not the checked-out HEAD; the manifest records HEAD", prerequisites: [] });
  }
  const dirty = git.dirty();
  if (dirty === true) gap("SOURCE_TREE_DIRTY", "working tree has uncommitted changes; the commit does not bind the built source");
  if (dirty === null) gap("SOURCE_TREE_STATE_UNKNOWN", "git status unavailable");

  // ---------- pins ----------
  const toolDigest = input.toolCatalogDigest && SHA256.test(input.toolCatalogDigest) ? input.toolCatalogDigest : null;
  if (!toolDigest) gap("TOOL_CATALOG_UNPINNED", "no pinned tool catalogue digest supplied; placeholder digest of 'UNPINNED' recorded");
  const policyDigest = readPolicyDigest(p.policyBundleDigest);
  if (!policyDigest) gap("POLICY_BUNDLE_UNPINNED", "policy/build/bundle.sha256 not present; placeholder digest of 'UNPINNED' recorded", ["PRQ-031"]);
  const knowledgeDigest = input.knowledgeSnapshotDigest && SHA256.test(input.knowledgeSnapshotDigest) ? input.knowledgeSnapshotDigest : null;
  if (!knowledgeDigest) gap("KNOWLEDGE_SNAPSHOT_MISSING", "no approved knowledge snapshot digest", ["PRQ-032"]);
  const versions: VersionSet = input.versions ?? {
    agentConfig: "UNPINNED",
    model: "UNPINNED",
    voice: "UNPINNED",
    promptTemplates: "UNPINNED",
    policyBundle: policyDigest ? `sha256-${policyDigest.slice(0, 16)}` : "UNPINNED",
    toolCatalog: toolDigest ?? UNPINNED_DIGEST,
    knowledgeSnapshot: knowledgeDigest ? `sha256-${knowledgeDigest.slice(0, 16)}` : "UNPINNED",
    schema: PROTOCOL_VERSION,
  };
  const unpinned = Object.entries(versions).filter(([, v]) => typeof v === "string" && unpinnedLabel(v)).map(([k]) => k);
  if (unpinned.length > 0) gap("VERSIONS_UNPINNED", `unpinned: ${unpinned.join(", ")}`, ["PRQ-020", "PRQ-045"]);
  const build = input.build ?? { buildId: null, imageDigest: null };
  if (!build.imageDigest) gap("IMAGE_DIGEST_MISSING", "no signed build/image digest", ["PRQ-042"]);
  const infra = input.infrastructurePlanDigest && SHA256.test(input.infrastructurePlanDigest) ? input.infrastructurePlanDigest : null;
  if (!infra) gap("INFRA_PLAN_MISSING", "no reviewed infrastructure plan digest", ["PRQ-037"]);
  const talkdesk = input.talkdeskConfigurationId ?? null;
  if (!talkdesk) gap("TALKDESK_CONFIGURATION_UNKNOWN", "vendor configuration identity not available (TB-08)", ["PRQ-020"]);
  const retention = input.retentionConfigurationDigest && SHA256.test(input.retentionConfigurationDigest) ? input.retentionConfigurationDigest : null;
  if (!retention) gap("RETENTION_CONFIGURATION_MISSING", "no approved retention schedule configuration", ["PRQ-025"]);
  const rollback = input.rollbackTarget ?? null;
  if (!rollback && (env === "staging" || env === "production")) blockers.push({ code: "ROLLBACK_TARGET_MISSING", detail: "no rehearsed known-good rollback target", prerequisites: ["PRQ-011"] });

  // ---------- evidence ----------
  // OPS-REL-01: every decision is made over the FULL evidence list, before the schema's
  // size bound is applied; the recorded subset keeps every non-PASS entry so the deploy
  // gate (which only sees the manifest) still sees each failure.
  const evidence = collectEvidence(root, input.evidenceDir ?? p.evidence, env);
  const noTestEvidence = evidence.tests.length === 0;
  // FO-19-04: the scorer version and its mutation-suite result, read from the same test reports.
  const reports = evidence.tests
    .filter((e) => e.kind === "test_report")
    .flatMap((e) => {
      try {
        return [JSON.parse(readFileSync(resolve(root, e.ref), "utf8")) as unknown];
      } catch {
        return [];
      }
    });
  const scorer = scorerVersionEvidence(root, reports);
  if (scorer.digest === null) gap("SCORER_VERSION_UNREADABLE", "the scorer sources could not be read; the scorer the release is gated with is unknown");
  else if (scorer.status !== "PASS") gap("SCORER_MUTATION_SUITE_NOT_PASS", `${SCORER_MUTATION_SUITE} has no passing recorded result in the evidence reports (${scorer.status})`);
  evidence.tests.push(scorer);
  const testEvidence = boundEvidence(evidence.tests, MAX_TEST_EVIDENCE);
  const quotaAndLoadEvidence = boundEvidence(evidence.load, MAX_LOAD_EVIDENCE);
  if (evidence.tests.some((e) => e.status === "FAIL")) blockers.push({ code: "TEST_EVIDENCE_FAILING", detail: "at least one evidence entry is FAIL", prerequisites: [] });
  if (evidence.load.some((e) => e.status === "FAIL")) blockers.push({ code: "QUOTA_LOAD_EVIDENCE_FAILING", detail: "at least one quota or load evidence entry is FAIL", prerequisites: ["PRQ-022"] });
  for (const [label, all, kept, max] of [
    ["TEST_EVIDENCE", evidence.tests, testEvidence, MAX_TEST_EVIDENCE],
    ["QUOTA_LOAD_EVIDENCE", evidence.load, quotaAndLoadEvidence, MAX_LOAD_EVIDENCE],
  ] as const) {
    if (all.length <= max) continue;
    const dropped = all.length - kept.length;
    const nonPassDropped = all.filter((e) => e.status !== "PASS").length - kept.filter((e) => e.status !== "PASS").length;
    // A live release must bind all of its evidence; locally the PASS-only overflow is noted.
    if (live || nonPassDropped > 0) blockers.push({ code: `${label}_TRUNCATED`, detail: `${all.length} entries, ${kept.length} recorded (${dropped} dropped, ${nonPassDropped} of them not PASS)`, prerequisites: [] });
    else notes.push(`${label}_TRUNCATED: ${all.length} entries, ${kept.length} recorded (only PASS entries dropped)`);
  }
  if (noTestEvidence) notes.push("NO_TEST_EVIDENCE: evidence/ holds no test reports or evaluation runs");
  if (live) {
    const eligible = evidence.tests.filter((e) => e.kind === "evaluation_run" && e.status === "PASS");
    if (eligible.length === 0) {
      blockers.push({ code: "ELIGIBLE_EVALUATION_EVIDENCE_MISSING", detail: `no evaluation run whose ${env} gate is PASS; local_fixture runs never satisfy it`, prerequisites: ["PRQ-012", "PRQ-043"] });
    }
    if (evidence.load.filter((e) => e.status === "PASS").length === 0) {
      blockers.push({ code: "QUOTA_LOAD_EVIDENCE_MISSING", detail: "no passing quota or load evidence for the vendor path (TB-10)", prerequisites: ["PRQ-022"] });
    }
  }

  // ---------- approvals ----------
  const loaded = loadApprovalRecords(input.approvalsDir ?? p.approvals);
  let trustedKey: KeyObject | null = null;
  if (typeof input.trustedApprovalKey === "string") {
    try {
      trustedKey = parseTrustedPublicKey(input.trustedApprovalKey);
    } catch {
      blockers.push({ code: "APPROVAL_TRUST_KEY_INVALID", detail: "trusted approval key could not be parsed", prerequisites: ["PRQ-023"] });
    }
  } else if (input.trustedApprovalKey) trustedKey = input.trustedApprovalKey;
  const now = clock.now();
  // OPS-APPR-01: an approval only counts when its signed subject names what this manifest releases.
  const expected = releaseSubjectExpectations({ versions, policyBundleDigest: policyDigest, knowledgeSnapshotDigest: knowledgeDigest, build });
  const evaluations = loaded.records.map((r) => evaluateApproval(r, { environment: env, now, trustedKey, expected }));
  const requiredApprovals = requiredApprovalsFor(env);
  const missingApprovals = requiredApprovals.filter((scope) => !evaluations.some((e) => e.scope === scope && e.status === "VALID"));
  if (missingApprovals.length > 0) blockers.push({ code: "APPROVALS_MISSING", detail: `missing or invalid: ${missingApprovals.join(", ")}`, prerequisites: ["PRQ-024"] });
  if (requiredApprovals.length > 0 && !trustedKey) blockers.push({ code: "APPROVAL_TRUST_KEY_MISSING", detail: "no trusted approval-signing key; every approval is UNVERIFIED", prerequisites: ["PRQ-023"] });
  for (const f of loaded.rejected) blockers.push({ code: f.reasonCode, detail: `approval file ${f.file} rejected`, prerequisites: ["PRQ-024"] });
  for (const id of loaded.duplicateIds) blockers.push({ code: "APPROVAL_DUPLICATE_ID", detail: `duplicate approval id ${id}`, prerequisites: ["PRQ-024"] });
  if (loaded.records.length > 64) blockers.push({ code: "APPROVALS_TOO_MANY", detail: "more than 64 approval records", prerequisites: [] });

  // ---------- signature ----------
  if (live) blockers.push({ code: "MANIFEST_UNSIGNED", detail: "manifest signing needs a KMS asymmetric key that does not exist", prerequisites: ["PRQ-023"] });
  else notes.push("MANIFEST_UNSIGNED: signing needs a KMS key (PRQ-023); acceptable only for local/ci evidence");
  if (env === "staging" || env === "production") {
    blockers.push({ code: "RELEASE_DECISION_HUMAN_ONLY", detail: "pilot or production promotion is authorized only by named human approvers", prerequisites: ["PRQ-024"] });
  }

  // ---------- source digests that must be read (OPS-06: an unreadable source is never bound) ----------
  const readDigest = (code: string, detail: string, read: () => string): string => {
    try {
      return read();
    } catch {
      blockers.push({ code, detail, prerequisites: [] });
      return UNPINNED_DIGEST;
    }
  };
  const migrations = readDigest("MIGRATIONS_UNREADABLE", "platform/migrations could not be read; placeholder digest of 'UNPINNED' recorded", () => migrationsDigest(p.migrations));
  const corpus = readDigest("EVALUATION_CORPUS_UNREADABLE", "the evaluation corpus could not be read or is empty; placeholder digest of 'UNPINNED' recorded", () => {
    const c = corpusDigest(root);
    if (c.files.length === 0) throw new Error("EVALUATION_CORPUS_EMPTY");
    return c.digest;
  });

  const status: ReleaseStatus = blockers.length > 0 ? "BLOCKED" : env === "sandbox" ? "VERIFIED_SANDBOX" : live ? "BLOCKED" : "IMPLEMENTED_OFFLINE";
  const manifest = ReleaseManifest.parse({
    manifestVersion: "release-manifest.v1",
    releaseId: (input.idSource ?? (() => newId("rel")))(),
    createdAt: now.toISOString(),
    targetEnvironment: env,
    status,
    sourceCommit: head ?? "0".repeat(40),
    build: { buildId: build.buildId, imageDigest: build.imageDigest },
    infrastructurePlanDigest: infra,
    schemaVersion: PROTOCOL_VERSION,
    migrationsDigest: migrations,
    talkdeskConfigurationId: talkdesk,
    versions,
    toolSchemaDigest: toolDigest ?? UNPINNED_DIGEST,
    policyBundleDigest: policyDigest ?? UNPINNED_DIGEST,
    knowledgeSnapshotDigest: knowledgeDigest,
    evaluationCorpusDigest: corpus,
    testEvidence,
    quotaAndLoadEvidence,
    retentionConfigurationDigest: retention,
    rollbackTarget: rollback,
    approvals: loaded.records.slice(0, 64),
    missingApprovals,
    signature: null,
  });
  return { manifest, blockers, notes, requiredApprovals, approvalEvaluations: evaluations, rejectedApprovalFiles: loaded.rejected };
}

/** Writes release-manifest.<env>.json and release-manifest.<env>.report.json (blockers and notes). */
export function writeReleaseManifest(result: ManifestBuildResult, outDir: string): { manifestPath: string; reportPath: string } {
  mkdirSync(outDir, { recursive: true });
  const env = result.manifest.targetEnvironment;
  const manifestPath = join(outDir, `release-manifest.${env}.json`);
  const reportPath = join(outDir, `release-manifest.${env}.report.json`);
  writeFileSync(manifestPath, `${JSON.stringify(result.manifest, null, 2)}\n`);
  writeFileSync(
    reportPath,
    `${JSON.stringify(
      {
        releaseId: result.manifest.releaseId,
        status: result.manifest.status,
        requiredApprovals: result.requiredApprovals,
        missingApprovals: result.manifest.missingApprovals,
        blockers: result.blockers,
        notes: result.notes,
        statement: "Engineering evidence only. This manifest does not certify HIPAA compliance or production readiness.",
      },
      null,
      2,
    )}\n`,
  );
  return { manifestPath, reportPath };
}

/** Flags `manifest` accepts (each takes one value). Anything else is a usage error (OPS-REL-02: no silently ignored flags). */
export const MANIFEST_VALUE_FLAGS = [
  "--env",
  "--root",
  "--out-dir",
  "--tool-catalog-digest",
  "--knowledge-snapshot-digest",
  "--image-digest",
  "--build-id",
  "--source-commit",
  "--infra-plan-digest",
  "--talkdesk-config-id",
  "--retention-digest",
  "--rollback-target",
] as const;
/** Boolean flags: `--dry-run` validates the exact command line and writes nothing; `--help` prints usage. */
export const MANIFEST_BOOLEAN_FLAGS = ["--dry-run", "--help"] as const;

export const MANIFEST_USAGE = [
  "usage: manifest --env <local|ci|sandbox|staging|production> [--out-dir <dir>] [--dry-run]",
  "         [--image-digest sha256:<64 hex>] [--build-id <id>] [--source-commit <40 hex, must equal git HEAD>]",
  "         [--tool-catalog-digest <sha256>] [--knowledge-snapshot-digest <sha256>] [--infra-plan-digest <sha256>]",
  "         [--talkdesk-config-id <id>] [--retention-digest <sha256>] [--rollback-target <ref>] [--root <dir>]",
  "       writes <out-dir>/release-manifest.<env>.json and release-manifest.<env>.report.json",
].join("\n");

type ParsedManifestArgs = { ok: true; values: Map<string, string>; flags: Set<string> } | { ok: false; reasonCode: string };

/** Strict argv parse: unknown flags, missing values and repeated flags are rejected. */
export function parseManifestArgs(argv: readonly string[]): ParsedManifestArgs {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if ((MANIFEST_BOOLEAN_FLAGS as readonly string[]).includes(a)) {
      flags.add(a);
      continue;
    }
    if (!(MANIFEST_VALUE_FLAGS as readonly string[]).includes(a)) return { ok: false, reasonCode: "MANIFEST_ARG_UNKNOWN" };
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) return { ok: false, reasonCode: "MANIFEST_ARG_VALUE_MISSING" };
    if (values.has(a)) return { ok: false, reasonCode: "MANIFEST_ARG_REPEATED" };
    values.set(a, v);
    i++;
  }
  const commit = values.get("--source-commit");
  if (commit !== undefined && !/^[a-f0-9]{40}$/.test(commit)) return { ok: false, reasonCode: "MANIFEST_ARG_SOURCE_COMMIT_INVALID" };
  const image = values.get("--image-digest");
  if (image !== undefined && !/^sha256:[a-f0-9]{64}$/.test(image)) return { ok: false, reasonCode: "MANIFEST_ARG_IMAGE_DIGEST_INVALID" };
  return { ok: true, values, flags };
}

export function main(argv: readonly string[]): number {
  const parsed = parseManifestArgs(argv);
  if (parsed.ok && parsed.flags.has("--help")) {
    process.stdout.write(`${MANIFEST_USAGE}\n`);
    return 0;
  }
  const env = Environment.safeParse(parsed.ok ? parsed.values.get("--env") : undefined);
  if (!parsed.ok || !env.success) {
    process.stderr.write(`manifest: ${parsed.ok ? "MANIFEST_ARG_ENV_INVALID" : parsed.reasonCode}\n${MANIFEST_USAGE}\n`);
    return 2;
  }
  const arg = (name: (typeof MANIFEST_VALUE_FLAGS)[number]): string | undefined => parsed.values.get(name);
  const root = resolve(arg("--root") ?? REPO_ROOT);
  const outArg = arg("--out-dir");
  const outDir = outArg ? (isAbsolute(outArg) ? outArg : resolve(process.cwd(), outArg)) : join(repoPaths(root).evidence, "release");
  if (parsed.flags.has("--dry-run")) {
    process.stdout.write(`manifest dry run: arguments accepted target=${env.data} out=${join(outDir, `release-manifest.${env.data}.json`)}\n`);
    return 0;
  }
  const result = buildReleaseManifest({
    targetEnvironment: env.data,
    root,
    toolCatalogDigest: arg("--tool-catalog-digest") ?? null,
    knowledgeSnapshotDigest: arg("--knowledge-snapshot-digest") ?? null,
    build: { buildId: arg("--build-id") ?? null, imageDigest: arg("--image-digest") ?? null },
    expectedSourceCommit: arg("--source-commit") ?? null,
    infrastructurePlanDigest: arg("--infra-plan-digest") ?? null,
    talkdeskConfigurationId: arg("--talkdesk-config-id") ?? null,
    retentionConfigurationDigest: arg("--retention-digest") ?? null,
    rollbackTarget: arg("--rollback-target") ?? null,
  });
  const paths = writeReleaseManifest(result, outDir);
  process.stdout.write(
    `release manifest ${result.manifest.releaseId} target=${env.data} status=${result.manifest.status} blockers=${result.blockers.length} missingApprovals=${result.manifest.missingApprovals.length} -> ${posixRelative(root, paths.manifestPath)}\n`,
  );
  for (const b of result.blockers) process.stdout.write(`  BLOCKED ${b.code}: ${b.detail}${b.prerequisites.length ? ` (${b.prerequisites.join(", ")})` : ""}\n`);
  return existsSync(paths.manifestPath) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
