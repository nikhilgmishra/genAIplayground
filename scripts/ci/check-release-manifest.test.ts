// platform/node_modules/.bin/tsx --test scripts/ci/check-release-manifest.test.ts
// Every manifest and approval below is SYNTHETIC: approvals are signed with a key pair
// generated inside this test only to exercise the verification path. They are not, and
// cannot stand in for, real human approvals.
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import { approvalSigningPayload } from "../../platform/src/config/approvals.js";
import type { ApprovalRecord, ApprovalScope } from "../../platform/src/protocol/release.js";
import { evaluateReleaseGate, requiredDeployApprovals } from "./check-release-manifest.js";
import type { DeployEnvironment } from "./check-release-manifest.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const NOW = new Date("2026-10-17T12:00:00.000Z");
const DIGEST = `sha256:${"a".repeat(64)}`;
const COMMIT = "b".repeat(40);
const PLAN = "c".repeat(64);
const hex = (ch: string) => ch.repeat(64);

function approval(scope: ApprovalScope, env: DeployEnvironment, overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  const record: ApprovalRecord = {
    approvalId: `apr_SYNTHETIC_${scope.toLowerCase()}`,
    approver: { name: "SYNTHETIC test approver", role: "security_leadership" },
    scope,
    scopeDetail: "SYNTHETIC approval for gate unit tests only",
    environment: env,
    grantedAt: "2026-10-01T00:00:00.000Z",
    expiresAt: "2026-12-31T00:00:00.000Z",
    evidenceRef: "evidence/SYNTHETIC",
    signature: null,
    ...overrides,
  };
  const sig = sign(null, Buffer.from(approvalSigningPayload(record), "utf8"), privateKey).toString("base64");
  return { ...record, signature: overrides.signature === undefined ? `ed25519:${sig}` : overrides.signature };
}

function manifest(env: DeployEnvironment, overrides: Record<string, unknown> = {}) {
  return {
    manifestVersion: "release-manifest.v1",
    releaseId: "rel_SYNTHETIC0001",
    createdAt: "2026-10-17T00:00:00.000Z",
    targetEnvironment: env,
    status: env === "production" ? "APPROVED_PILOT" : "VERIFIED_SANDBOX",
    sourceCommit: COMMIT,
    build: { buildId: "build-1", imageDigest: DIGEST },
    infrastructurePlanDigest: PLAN,
    schemaVersion: "2026-10-17.1",
    migrationsDigest: hex("1"),
    talkdeskConfigurationId: null,
    versions: {
      agentConfig: "agent-1",
      model: "model-1",
      voice: "voice-1",
      promptTemplates: "prompts-1",
      policyBundle: "policy-1",
      toolCatalog: hex("2"),
      knowledgeSnapshot: "kb-1",
      schema: "schema-1",
    },
    toolSchemaDigest: hex("2"),
    policyBundleDigest: hex("3"),
    knowledgeSnapshotDigest: null,
    evaluationCorpusDigest: hex("4"),
    testEvidence: [{ kind: "unit_tests", ref: "evidence/SYNTHETIC", digest: null, status: "PASS" }],
    quotaAndLoadEvidence: [{ kind: "load_test", ref: "evidence/SYNTHETIC", digest: null, status: "PASS" }],
    retentionConfigurationDigest: null,
    rollbackTarget: "rel_SYNTHETIC0000",
    approvals: requiredDeployApprovals(env).map((s) => approval(s, env)),
    missingApprovals: [],
    signature: "SYNTHETIC-signature-placeholder",
    ...overrides,
  };
}

const gate = (env: DeployEnvironment, m: unknown, extra: Partial<Parameters<typeof evaluateReleaseGate>[0]> = {}) =>
  evaluateReleaseGate({ manifest: m, environment: env, imageDigest: DIGEST, sourceCommit: COMMIT, planDigest: PLAN, trustedKey: publicKey, now: NOW, ...extra });

test("[OPS-04] production deploy with every signed approval, PASS evidence and bound plan is allowed (SYNTHETIC)", () => {
  const d = gate("production", manifest("production"));
  assert.equal(d.decision, "ALLOW", d.reasons.join(","));
  assert.ok(d.requiredApprovals.includes("PRODUCTION_DEPLOYMENT"));
});

test("[OPS-04] production refuses a manifest without approvals", () => {
  const d = gate("production", manifest("production", { approvals: [] }));
  assert.equal(d.decision, "DENY");
  assert.ok(d.reasons.includes("APPROVAL_MISSING:PRODUCTION_DEPLOYMENT"));
});

test("[OPS-04] production refuses IMPLEMENTED_OFFLINE and VERIFIED_SANDBOX releases", () => {
  for (const status of ["IMPLEMENTED_OFFLINE", "VERIFIED_SANDBOX", "BLOCKED"]) {
    const d = gate("production", manifest("production", { status }));
    assert.equal(d.decision, "DENY");
    assert.ok(d.reasons.includes(`STATUS_NOT_DEPLOYABLE:${status}`));
  }
});

test("[OPS-04] declared missing approvals block deployment", () => {
  const d = gate("production", manifest("production", { missingApprovals: ["CLINICAL_SCRIPTS"] }));
  assert.equal(d.decision, "DENY");
  assert.ok(d.reasons.includes("MISSING_APPROVALS_DECLARED:CLINICAL_SCRIPTS"));
});

test("[OPS-04] unsigned or unverifiable approvals never count", () => {
  const unsigned = manifest("production", { approvals: requiredDeployApprovals("production").map((s) => approval(s, "production", { signature: null })) });
  assert.equal(gate("production", unsigned).decision, "DENY");
  const noKey = gate("production", manifest("production"), { trustedKey: null });
  assert.equal(noKey.decision, "DENY");
  assert.ok(noKey.reasons.some((r) => r.includes("UNVERIFIED_NO_TRUST_KEY")));
});

test("[OPS-04] expired or wrong-environment approvals are rejected", () => {
  const expired = manifest("production", {
    approvals: requiredDeployApprovals("production").map((s) => approval(s, "production", { expiresAt: "2026-10-02T00:00:00.000Z" })),
  });
  assert.ok(gate("production", expired).reasons.some((r) => r.endsWith("EXPIRED")));
  const staging = manifest("production", { approvals: requiredDeployApprovals("production").map((s) => approval(s, "staging")) });
  assert.ok(gate("production", staging).reasons.some((r) => r.includes("WRONG_ENVIRONMENT")));
});

test("[OPS-03] production refuses INCONCLUSIVE, NOT_RUN or missing evidence", () => {
  const d = gate("production", manifest("production", { testEvidence: [{ kind: "pstn_tests", ref: "x", digest: null, status: "NOT_RUN" }], quotaAndLoadEvidence: [] }));
  assert.equal(d.decision, "DENY");
  assert.ok(d.reasons.includes("EVIDENCE_NOT_PASS:pstn_tests:NOT_RUN"));
  const none = gate("production", manifest("production", { testEvidence: [], quotaAndLoadEvidence: [] }));
  assert.ok(none.reasons.includes("EVIDENCE_MISSING"));
});

test("[OPS-05] sandbox deployment requires a BILLABLE_TEST_EXECUTION approval", () => {
  const d = gate("sandbox", manifest("sandbox", { approvals: [] }));
  assert.equal(d.decision, "DENY");
  assert.ok(d.reasons.includes("APPROVAL_MISSING:BILLABLE_TEST_EXECUTION"));
  assert.equal(gate("sandbox", manifest("sandbox")).decision, "ALLOW");
});

test("[SPEC-15.release] image digest, commit and reviewed plan must match the manifest", () => {
  assert.ok(gate("production", manifest("production"), { imageDigest: `sha256:${"f".repeat(64)}` }).reasons.includes("IMAGE_DIGEST_MISMATCH"));
  assert.ok(gate("production", manifest("production"), { sourceCommit: "e".repeat(40) }).reasons.includes("SOURCE_COMMIT_MISMATCH"));
  assert.ok(gate("production", manifest("production"), { planDigest: "d".repeat(64) }).reasons.includes("PLAN_DIGEST_MISMATCH"));
  assert.ok(gate("production", manifest("production"), { planDigest: undefined }).reasons.includes("PLAN_DIGEST_NOT_CHECKED"));
  assert.ok(gate("production", manifest("production", { infrastructurePlanDigest: null })).reasons.includes("PLAN_DIGEST_NOT_BOUND"));
});

test("[SPEC-15.release] production needs a rollback target and a manifest signature", () => {
  const d = gate("production", manifest("production", { rollbackTarget: null, signature: null }));
  assert.ok(d.reasons.includes("ROLLBACK_TARGET_REQUIRED"));
  assert.ok(d.reasons.includes("MANIFEST_SIGNATURE_REQUIRED"));
});

test("[OPS-04] a manifest targeting another environment is refused", () => {
  assert.ok(gate("production", manifest("staging")).reasons.includes("ENVIRONMENT_MISMATCH:staging"));
});

test("[OPS-03] schema violations deny and report paths only", () => {
  const d = gate("production", { ...manifest("production"), unexpected: "x" });
  assert.equal(d.decision, "DENY");
  assert.ok(d.reasons.every((r) => r.startsWith("MANIFEST_SCHEMA_INVALID:")));
});
