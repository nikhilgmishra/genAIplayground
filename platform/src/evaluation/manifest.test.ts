import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReleaseManifest } from "../protocol/index.js";
import { REQUIRED_APPROVALS_BY_ENVIRONMENT } from "../config/guard.js";
import { migrationsDigest } from "../db/migrate.js";
import { sha256Hex } from "../shared/canonical.js";
import { FakeClock } from "../shared/clock.js";
import { corpusDigest } from "./corpus.js";
import { buildReleaseManifest, requiredApprovalsFor, UNPINNED_DIGEST, writeReleaseManifest } from "./manifest.js";
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

  it("[OPS-06] a local manifest with only local evidence is IMPLEMENTED_OFFLINE; unpinned items are notes, not success claims", () => {
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
    expect(prod.manifest.testEvidence).toEqual([{ kind: "evaluation_run", ref: expect.stringContaining("runs/run_localOnly0001/summary.json"), digest: sha256Hex(summary), status: "BLOCKED" }]);
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

  it("[OPS-06] writes release-manifest.<env>.json and a blocker report without compliance claims", () => {
    const out = tmp();
    const result = base();
    const { manifestPath, reportPath } = writeReleaseManifest(result, out);
    expect(manifestPath.endsWith("release-manifest.production.json")).toBe(true);
    expect(ReleaseManifest.parse(JSON.parse(readFileSync(manifestPath, "utf8"))).status).toBe("BLOCKED");
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    expect(report.blockers.length).toBe(result.blockers.length);
    expect(report.statement).toContain("does not certify HIPAA compliance or production readiness");
  });
});
