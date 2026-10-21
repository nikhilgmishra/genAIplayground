import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReleaseManifest } from "../protocol/index.js";
import { REQUIRED_APPROVALS_BY_ENVIRONMENT } from "../config/guard.js";
import { migrationsDigest } from "../db/migrate.js";
import { sha256Hex } from "../shared/canonical.js";
import { FakeClock } from "../shared/clock.js";
import { corpusDigest } from "./corpus.js";
import {
  boundEvidence,
  buildReleaseManifest,
  main as manifestMain,
  MAX_TEST_EVIDENCE,
  parseManifestArgs,
  requiredApprovalsFor,
  SCORER_MUTATION_SUITE,
  SCORER_SOURCES,
  scorerDigest,
  scorerVersionEvidence,
  UNPINNED_DIGEST,
  writeReleaseManifest,
} from "./manifest.js";
import { SCORER_GATES } from "./scorer.js";
import { main as cliMain } from "./cli.js";
import type { GitReader } from "./manifest.js";
import { REPO_ROOT, repoPaths } from "./paths.js";

const HEAD = "a".repeat(40);
const cleanGit: GitReader = { head: () => HEAD, dirty: () => false };
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "vsp-manifest-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const base = (over: Partial<Parameters<typeof buildReleaseManifest>[0]> = {}) =>
  buildReleaseManifest({
    targetEnvironment: "production",
    git: cleanGit,
    clock: new FakeClock("2026-10-17T15:00:00.000Z"),
    idSource: () => "rel_testRelease0001",
    evidenceDir: tmp(),
    ...over,
  });

describe("release manifest builder", () => {
  it("[OPS-06][SPEC-16.release-manifest] production manifest is schema-valid, BLOCKED, unsigned and lists every missing approval", () => {
    const { manifest, blockers } = base();
    expect(ReleaseManifest.safeParse(manifest).success).toBe(true);
    expect(manifest.status).toBe("BLOCKED");
    expect(manifest.signature).toBeNull();
    expect(manifest.approvals).toEqual([]);
    expect([...manifest.missingApprovals].sort()).toEqual(
      ["PHI_PROCESSING", "PRODUCTION_DEPLOYMENT", "SECURITY_REVIEW", "CLINICAL_SCRIPTS", "RETENTION_SCHEDULE", "MODEL_VOICE_SELECTION", "POLICY_RELEASE", "KNOWLEDGE_RELEASE"].sort(),
    );
    const codes = blockers.map((b) => b.code);
    for (const c of ["APPROVALS_MISSING", "APPROVAL_TRUST_KEY_MISSING", "MANIFEST_UNSIGNED", "TOOL_CATALOG_UNPINNED", "KNOWLEDGE_SNAPSHOT_MISSING", "VERSIONS_UNPINNED", "ELIGIBLE_EVALUATION_EVIDENCE_MISSING", "QUOTA_LOAD_EVIDENCE_MISSING", "ROLLBACK_TARGET_MISSING", "RELEASE_DECISION_HUMAN_ONLY"]) {
      expect(codes, c).toContain(c);
    }
  });

  it("[OPS-06] binds source commit, migrations digest, corpus digest and placeholder digests for anything unpinned", () => {
    const { manifest } = base();
    const p = repoPaths(REPO_ROOT);
    expect(manifest.sourceCommit).toBe(HEAD);
    expect(manifest.migrationsDigest).toBe(migrationsDigest(p.migrations));
    expect(manifest.evaluationCorpusDigest).toBe(corpusDigest(REPO_ROOT).digest);
    expect(manifest.toolSchemaDigest).toBe(UNPINNED_DIGEST);
    expect(UNPINNED_DIGEST).toBe(sha256Hex("UNPINNED"));
    expect(manifest.schemaVersion).toBe("2026-10-17.1");
    expect(manifest.versions.model).toBe("UNPINNED");
    const pinned = base({ toolCatalogDigest: "b".repeat(64), knowledgeSnapshotDigest: "c".repeat(64) }).manifest;
    expect(pinned.toolSchemaDigest).toBe("b".repeat(64));
    expect(pinned.versions.toolCatalog).toBe("b".repeat(64));
    expect(pinned.knowledgeSnapshotDigest).toBe("c".repeat(64));
  });

  it("[SPEC-16.release-manifest] required approvals per environment follow the production guard (sandbox also needs VENDOR_SANDBOX_INTEGRATION)", () => {
    for (const env of ["local", "ci", "sandbox", "staging", "production"] as const) {
      for (const scope of REQUIRED_APPROVALS_BY_ENVIRONMENT[env]) expect(requiredApprovalsFor(env)).toContain(scope);
    }
    expect(requiredApprovalsFor("sandbox")).toEqual(["VENDOR_SANDBOX_INTEGRATION"]);
    expect([...requiredApprovalsFor("staging")].sort()).toEqual(["SECURITY_REVIEW", "VENDOR_SANDBOX_INTEGRATION"]);
    expect(requiredApprovalsFor("local")).toEqual([]);
    const sandbox = base({ targetEnvironment: "sandbox" });
    expect(sandbox.manifest.status).toBe("BLOCKED");
    expect(sandbox.manifest.missingApprovals).toEqual(["VENDOR_SANDBOX_INTEGRATION"]);
  });

  it("[OPS-06][SPEC-16.status-vocabulary] a local manifest with only local evidence is IMPLEMENTED_OFFLINE; unpinned items are notes, not success claims", () => {
    const { manifest, blockers, notes } = base({ targetEnvironment: "local" });
    expect(manifest.status).toBe("IMPLEMENTED_OFFLINE");
    expect(blockers).toEqual([]);
    expect(notes.join(" ")).toContain("TOOL_CATALOG_UNPINNED");
    expect(notes.join(" ")).toContain("MANIFEST_UNSIGNED");
    expect(manifest.missingApprovals).toEqual([]);
  });

  it("[OPS-03] failing or unavailable evidence blocks even a local manifest; a dirty tree blocks live targets", () => {
    const ev = tmp();
    mkdirSync(join(ev, "test-reports"), { recursive: true });
    writeFileSync(join(ev, "test-reports/vitest.json"), JSON.stringify({ success: false, testResults: [] }));
    const failing = base({ targetEnvironment: "local", evidenceDir: ev });
    expect(failing.manifest.status).toBe("BLOCKED");
    expect(failing.manifest.testEvidence[0]).toMatchObject({ kind: "test_report", ref: expect.stringContaining("vitest.json"), status: "FAIL" });
    const noGit = base({ targetEnvironment: "local", git: { head: () => null, dirty: () => null } });
    expect(noGit.manifest.status).toBe("BLOCKED");
    expect(noGit.manifest.sourceCommit).toBe("0".repeat(40));
    const dirty = base({ git: { head: () => HEAD, dirty: () => true } });
    expect(dirty.blockers.map((b) => b.code)).toContain("SOURCE_TREE_DIRTY");
  });

  it("[OPS-03] evaluation runs are referenced with digests; local_fixture summaries never satisfy a production gate", () => {
    const ev = tmp();
    mkdirSync(join(ev, "runs/run_localOnly0001"), { recursive: true });
    const summary = JSON.stringify({ gates: { local: { status: "PASS" }, production: { status: "BLOCKED" } } });
    writeFileSync(join(ev, "runs/run_localOnly0001/summary.json"), summary);
    writeFileSync(join(ev, "runs/run_localOnly0001/results.jsonl"), "");
    const prod = base({ evidenceDir: ev });
    expect(prod.manifest.testEvidence).toEqual([
      { kind: "evaluation_run", ref: expect.stringContaining("runs/run_localOnly0001/summary.json"), digest: sha256Hex(summary), status: "BLOCKED" },
      { kind: "scorer_version", ref: expect.stringContaining("SCORER_GATES"), digest: scorerDigest(REPO_ROOT), status: "NOT_RUN" },
    ]);
    expect(prod.blockers.map((b) => b.code)).toContain("ELIGIBLE_EVALUATION_EVIDENCE_MISSING");
    const local = base({ targetEnvironment: "local", evidenceDir: ev });
    expect(local.manifest.testEvidence[0]?.status).toBe("PASS");
    expect(local.manifest.status).toBe("IMPLEMENTED_OFFLINE");
  });

  it("[SPEC-16.release-manifest] approval records cannot be fabricated: malformed files are rejected and an unsigned record never satisfies a scope", () => {
    const approvals = tmp();
    writeFileSync(join(approvals, "broken.json"), "{ not json");
    // TEST FIXTURE ONLY (temporary directory): a structurally valid but unsigned record.
    writeFileSync(
      join(approvals, "fixture-unsigned.json"),
      JSON.stringify({
        approvalId: "apr_fixtureUnsigned01",
        approver: { name: "Fixture Approver (test only)", role: "security_leadership" },
        scope: "SECURITY_REVIEW",
        scopeDetail: "TEST FIXTURE ONLY - not an approval",
        environment: "production",
        grantedAt: "2026-10-01T00:00:00.000Z",
        expiresAt: "2027-10-01T00:00:00.000Z",
        evidenceRef: "fixture://none",
        signature: null,
      }),
    );
    const r = base({ approvalsDir: approvals });
    expect(r.rejectedApprovalFiles).toEqual([{ file: "broken.json", reasonCode: "APPROVAL_RECORD_MALFORMED" }]);
    expect(r.manifest.approvals.map((a) => a.approvalId)).toEqual(["apr_fixtureUnsigned01"]);
    expect(r.approvalEvaluations[0]?.status).toBe("UNSIGNED");
    expect(r.manifest.missingApprovals).toContain("SECURITY_REVIEW");
    expect(r.blockers.map((b) => b.code)).toContain("APPROVAL_RECORD_MALFORMED");
    expect(r.manifest.status).toBe("BLOCKED");
  });

  it("[OPS-06][SPEC-16.status-vocabulary] writes release-manifest.<env>.json and a blocker report without compliance claims", () => {
    const out = tmp();
    const result = base();
    const { manifestPath, reportPath } = writeReleaseManifest(result, out);
    expect(manifestPath.endsWith("release-manifest.production.json")).toBe(true);
    expect(ReleaseManifest.parse(JSON.parse(readFileSync(manifestPath, "utf8"))).status).toBe("BLOCKED");
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    expect(report.blockers.length).toBe(result.blockers.length);
    expect(report.statement).toContain("does not certify HIPAA compliance or production readiness");
  });
  describe("evidence bounds (OPS-REL-01)", () => {
    const reports = (ev: string, pass: number, failing: string[] = []) => {
      mkdirSync(join(ev, "reports"), { recursive: true });
      for (let i = 0; i < pass; i++) writeFileSync(join(ev, "reports", `a-${String(i).padStart(3, "0")}.json`), JSON.stringify({ testResults: [], success: true }));
      for (const name of failing) writeFileSync(join(ev, "reports", name), JSON.stringify({ testResults: [{}], success: false }));
    };

    it("[OPS-03][OPS-REL-01] a FAIL report that sorts after entry 128 still blocks and is kept in manifest.testEvidence", () => {
      const ev = tmp();
      reports(ev, 130, ["z-security-regression.json"]);
      const r = base({ targetEnvironment: "local", evidenceDir: ev });
      const codes = r.blockers.map((b) => b.code);
      expect(codes).toContain("TEST_EVIDENCE_FAILING");
      expect(r.manifest.status).toBe("BLOCKED");
      expect(r.manifest.testEvidence).toHaveLength(MAX_TEST_EVIDENCE);
      expect(r.manifest.testEvidence.some((e) => e.ref.endsWith("z-security-regression.json") && e.status === "FAIL")).toBe(true);
      // Only PASS entries were dropped, so locally the overflow is a note, not a blocker.
      expect(codes).not.toContain("TEST_EVIDENCE_TRUNCATED");
      expect(r.notes.join(" ")).toContain("TEST_EVIDENCE_TRUNCATED");
      expect(ReleaseManifest.safeParse(r.manifest).success).toBe(true);
    });

    it("[OPS-03][OPS-REL-01] truncation blocks a live target, and blocks anywhere when a non-PASS entry would be dropped", () => {
      const ev = tmp();
      reports(ev, 130);
      expect(base({ evidenceDir: ev }).blockers.map((b) => b.code)).toContain("TEST_EVIDENCE_TRUNCATED");
      const ev2 = tmp();
      reports(ev2, 0, Array.from({ length: 130 }, (_, i) => `f-${String(i).padStart(3, "0")}.json`));
      const local = base({ targetEnvironment: "local", evidenceDir: ev2 });
      expect(local.blockers.map((b) => b.code)).toEqual(expect.arrayContaining(["TEST_EVIDENCE_FAILING", "TEST_EVIDENCE_TRUNCATED"]));
    });

    it("[OPS-03][OPS-REL-01] any FAIL quota or load evidence is a builder blocker even when another entry passes", () => {
      const ev = tmp();
      mkdirSync(join(ev, "load"), { recursive: true });
      writeFileSync(join(ev, "load", "a-pass.json"), JSON.stringify({ status: "PASS" }));
      writeFileSync(join(ev, "load", "b-quota-fail.json"), JSON.stringify({ status: "FAIL" }));
      const r = base({ targetEnvironment: "local", evidenceDir: ev });
      expect(r.blockers.map((b) => b.code)).toContain("QUOTA_LOAD_EVIDENCE_FAILING");
      expect(r.manifest.status).toBe("BLOCKED");
      expect(r.manifest.quotaAndLoadEvidence.map((e) => e.status)).toEqual(["PASS", "FAIL"]);
    });

    it("[OPS-03][OPS-REL-01] boundEvidence keeps every non-PASS entry first and preserves order", () => {
      const all = [
        { ref: "a", status: "PASS" as const },
        { ref: "b", status: "PASS" as const },
        { ref: "c", status: "INCONCLUSIVE" as const },
        { ref: "d", status: "FAIL" as const },
      ];
      expect(boundEvidence(all, 2).map((e) => e.ref)).toEqual(["c", "d"]);
      expect(boundEvidence(all, 3).map((e) => e.ref)).toEqual(["a", "c", "d"]);
      expect(boundEvidence(all, 10)).toEqual(all);
    });
  });
  describe("manifest CLI contract (OPS-REL-02)", () => {
    const quiet = () => {
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      vi.spyOn(console, "error").mockImplementation(() => undefined);
    };
    afterEach(() => vi.restoreAllMocks());
    const IMG = `sha256:${"a".repeat(64)}`;

    it("[OPS-06][OPS-REL-02] the old release.yml command line (release-manifest --environment ... --out) is refused, not silently accepted", async () => {
      quiet();
      const out = tmp();
      expect(await cliMain(["release-manifest", "--environment", "sandbox", "--out", join(out, "m.json")])).toBe(2);
      expect(await cliMain(["manifest", "--environment", "sandbox", "--out", join(out, "m.json")])).toBe(2);
      expect(manifestMain(["--env", "sandbox", "--out", join(out, "m.json")])).toBe(2);
      expect(readdirSync(out)).toEqual([]);
    });

    it("[OPS-06][OPS-REL-02] strict flags: unknown, repeated, value-less and malformed values are usage errors; --dry-run writes nothing", async () => {
      expect(parseManifestArgs(["--env", "ci", "--bogus", "x"])).toEqual({ ok: false, reasonCode: "MANIFEST_ARG_UNKNOWN" });
      expect(parseManifestArgs(["--env", "ci", "--env", "local"])).toEqual({ ok: false, reasonCode: "MANIFEST_ARG_REPEATED" });
      expect(parseManifestArgs(["--env", "--out-dir", "x"])).toEqual({ ok: false, reasonCode: "MANIFEST_ARG_VALUE_MISSING" });
      expect(parseManifestArgs(["--env", "ci", "--source-commit", "HEAD"])).toEqual({ ok: false, reasonCode: "MANIFEST_ARG_SOURCE_COMMIT_INVALID" });
      expect(parseManifestArgs(["--env", "ci", "--image-digest", "latest"])).toEqual({ ok: false, reasonCode: "MANIFEST_ARG_IMAGE_DIGEST_INVALID" });
      quiet();
      const out = tmp();
      const args = ["manifest", "--env", "sandbox", "--image-digest", IMG, "--source-commit", "b".repeat(40), "--build-id", "1.1", "--out-dir", out];
      expect(await cliMain([...args, "--dry-run"])).toBe(0);
      expect(readdirSync(out)).toEqual([]);
      expect(await cliMain(["manifest", "--help"])).toBe(0);
    });

    it("[OPS-06][OPS-REL-02] --source-commit must equal the checked-out HEAD", () => {
      const ok = base({ targetEnvironment: "local", expectedSourceCommit: HEAD });
      expect(ok.blockers.map((b) => b.code)).not.toContain("SOURCE_COMMIT_MISMATCH");
      const other = base({ targetEnvironment: "local", expectedSourceCommit: "e".repeat(40) });
      expect(other.blockers.map((b) => b.code)).toContain("SOURCE_COMMIT_MISMATCH");
      expect(other.manifest.sourceCommit).toBe(HEAD);
      expect(other.manifest.status).toBe("BLOCKED");
    });
  });
});

describe("[FO-19-04][OPS-06] the release manifest records the scorer it is gated with", () => {
  const report = (statuses: string[], success = true) => ({
    success,
    testResults: [
      { name: "/ws/platform/src/evaluation/aggregate.test.ts", assertionResults: [{ status: "failed" }] },
      { name: `/ws/${SCORER_MUTATION_SUITE}`, assertionResults: statuses.map((status) => ({ status })) },
    ],
  });
  const withReport = (r: unknown) => {
    const ev = tmp();
    mkdirSync(join(ev, "test-reports"), { recursive: true });
    writeFileSync(join(ev, "test-reports/vitest-platform.json"), JSON.stringify(r));
    return ev;
  };

  it("[FO-19-04][OPS-06] the scorer version is the digest of the verdict-deciding sources, recomputed independently here", () => {
    const expected = sha256Hex(SCORER_SOURCES.map((f) => `${f}:${sha256Hex(readFileSync(join(REPO_ROOT, f)))}`).join("\n"));
    expect(scorerDigest(REPO_ROOT)).toBe(expected);
    expect(SCORER_SOURCES).toContain("platform/src/evaluation/scorer.ts");
    expect(SCORER_SOURCES).toContain("platform/src/evaluation/fault-reach.ts");
    // A changed scorer source is a different scorer version; an unreadable one is no version at all.
    const root = tmp();
    for (const f of SCORER_SOURCES) {
      mkdirSync(join(root, f, ".."), { recursive: true });
      writeFileSync(join(root, f), readFileSync(join(REPO_ROOT, f)));
    }
    expect(scorerDigest(root)).toBe(expected);
    writeFileSync(join(root, "platform/src/evaluation/fault-reach.ts"), `${readFileSync(join(REPO_ROOT, "platform/src/evaluation/fault-reach.ts"), "utf8")}\n// changed\n`);
    expect(scorerDigest(root)).not.toBe(expected);
    rmSync(join(root, "platform/src/evaluation/unknown.ts"));
    expect(scorerDigest(root)).toBeNull();
    expect(scorerVersionEvidence(root, [report(["passed"])])).toMatchObject({ kind: "scorer_version", digest: null, status: "INCONCLUSIVE" });
  });

  it("[FO-19-04][OPS-03] its status is the recorded mutation-suite result: PASS only when every recorded case passed; FAIL blocks even a local manifest; unrecorded is NOT_RUN", () => {
    const n = Object.keys(SCORER_GATES).length;
    const passed = base({ targetEnvironment: "local", evidenceDir: withReport(report(Array.from({ length: n }, () => "passed"))) });
    const entry = passed.manifest.testEvidence.find((e) => e.kind === "scorer_version");
    expect(entry).toEqual({ kind: "scorer_version", ref: expect.stringContaining(`${n} gate families`), digest: scorerDigest(REPO_ROOT), status: "PASS" });
    expect(passed.notes.join(" ")).not.toContain("SCORER_MUTATION_SUITE_NOT_PASS");

    const failed = base({ targetEnvironment: "local", evidenceDir: withReport(report(["passed", "failed"])) });
    expect(failed.manifest.testEvidence.find((e) => e.kind === "scorer_version")?.status).toBe("FAIL");
    expect(failed.blockers.map((b) => b.code)).toContain("TEST_EVIDENCE_FAILING");
    expect(failed.manifest.status).toBe("BLOCKED");

    const skipped = base({ targetEnvironment: "local", evidenceDir: withReport(report(["passed", "skipped"])) });
    expect(skipped.manifest.testEvidence.find((e) => e.kind === "scorer_version")?.status).toBe("INCONCLUSIVE");

    // Another suite's results never stand in for the mutation suite.
    const other = base({ targetEnvironment: "local", evidenceDir: withReport({ success: true, testResults: [{ name: "/ws/platform/src/evaluation/scorer.test.ts", assertionResults: [{ status: "passed" }] }] }) });
    expect(other.manifest.testEvidence.find((e) => e.kind === "scorer_version")?.status).toBe("NOT_RUN");
    expect(other.notes.join(" ")).toContain("SCORER_MUTATION_SUITE_NOT_PASS");
    expect(other.manifest.status).toBe("IMPLEMENTED_OFFLINE");
    // A live target is blocked until the mutation suite of this scorer has a passing recorded result.
    const live = base({ targetEnvironment: "staging", evidenceDir: withReport(report(["passed", "pending"])) });
    expect(live.blockers.map((b) => b.code)).toContain("SCORER_MUTATION_SUITE_NOT_PASS");
  });
});
