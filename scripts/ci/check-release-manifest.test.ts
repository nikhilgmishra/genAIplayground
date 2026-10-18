// platform/node_modules/.bin/tsx --test scripts/ci/check-release-manifest.test.ts
// Every manifest and approval below is SYNTHETIC: approvals are signed with a key pair
// generated inside this test only to exercise the verification path. They are not, and
// cannot stand in for, real human approvals.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { APPROVER_ROLES_BY_SCOPE, approvalSigningPayload } from "../../platform/src/config/approvals.js";
import { ReleaseManifest } from "../../platform/src/protocol/release.js";
import type { ApprovalRecord, ApprovalScope, ApprovalSubject } from "../../platform/src/protocol/release.js";
import { evaluateReleaseGate, requiredDeployApprovals } from "./check-release-manifest.js";
import type { DeployEnvironment } from "./check-release-manifest.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const NOW = new Date("2026-10-17T12:00:00.000Z");
const DIGEST = `sha256:${"a".repeat(64)}`;
const COMMIT = "b".repeat(40);
const PLAN = "c".repeat(64);
const hex = (ch: string) => ch.repeat(64);
const KNOWLEDGE = hex("5");
const TEMPLATES = hex("6");

/** SYNTHETIC subjects naming exactly what manifest() below releases (OPS-APPR-01). */
const BOUND_SUBJECT: Partial<Record<ApprovalScope, ApprovalSubject>> = {
  MODEL_VOICE_SELECTION: { modelVoice: { model: "model-1", voice: "voice-1", agentConfig: "agent-1" } },
  POLICY_RELEASE: { policyBundle: { version: "policy-1", digest: hex("3") } },
  KNOWLEDGE_RELEASE: { knowledgeSnapshotDigest: KNOWLEDGE },
  CLINICAL_SCRIPTS: { templateCatalogDigest: TEMPLATES },
  PRODUCTION_DEPLOYMENT: { release: { imageDigest: DIGEST } },
};

function approval(scope: ApprovalScope, env: DeployEnvironment, overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  const subject = BOUND_SUBJECT[scope];
  const record: ApprovalRecord = {
    approvalId: `apr_SYNTHETIC_${scope.toLowerCase()}`,
    approver: { name: "SYNTHETIC test approver", role: APPROVER_ROLES_BY_SCOPE[scope][0] ?? "security_leadership" },
    scope,
    scopeDetail: "SYNTHETIC approval for gate unit tests only",
    ...(subject ? { subject } : {}),
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
      promptTemplates: TEMPLATES,
      policyBundle: "policy-1",
      toolCatalog: hex("2"),
      knowledgeSnapshot: "kb-1",
      schema: "schema-1",
    },
    toolSchemaDigest: hex("2"),
    policyBundleDigest: hex("3"),
    knowledgeSnapshotDigest: KNOWLEDGE,
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

// ---------------------------------------------------------------------------
// OPS-APPR-01: approvals are bound to the artifact they approve and to an allowed role.
// ---------------------------------------------------------------------------

const withApproval = (env: DeployEnvironment, scope: ApprovalScope, over: Partial<ApprovalRecord>) =>
  requiredDeployApprovals(env).map((s) => (s === scope ? approval(s, env, over) : approval(s, env)));

test("[OPS-04][OPS-APPR-01] a MODEL_VOICE_SELECTION approval for another model/voice/agentConfig does not authorize this release", () => {
  const otherModel = manifest("production", { approvals: withApproval("production", "MODEL_VOICE_SELECTION", { subject: { modelVoice: { model: "model-9", voice: "voice-1", agentConfig: "agent-1" } } }) });
  const d = gate("production", otherModel);
  assert.equal(d.decision, "DENY");
  assert.ok(d.reasons.includes("APPROVAL_INVALID:MODEL_VOICE_SELECTION:SUBJECT_MISMATCH"), d.reasons.join(","));
  // The manifest moving to an unreviewed model under the same (signed, valid) approval is refused too.
  const movedManifest = manifest("production");
  const d2 = gate("production", { ...movedManifest, versions: { ...movedManifest.versions, agentConfig: "agent-unreviewed" } });
  assert.ok(d2.reasons.includes("APPROVAL_INVALID:MODEL_VOICE_SELECTION:SUBJECT_MISMATCH"), d2.reasons.join(","));
});

test("[OPS-04][OPS-APPR-01] POLICY_RELEASE, KNOWLEDGE_RELEASE, CLINICAL_SCRIPTS and PRODUCTION_DEPLOYMENT must name the released digests", () => {
  const cases: [ApprovalScope, ApprovalSubject][] = [
    ["POLICY_RELEASE", { policyBundle: { version: "policy-1", digest: hex("9") } }],
    ["KNOWLEDGE_RELEASE", { knowledgeSnapshotDigest: hex("9") }],
    ["CLINICAL_SCRIPTS", { templateCatalogDigest: hex("9") }],
    ["PRODUCTION_DEPLOYMENT", { release: { imageDigest: `sha256:${hex("9")}` } }],
  ];
  for (const [scope, subject] of cases) {
    const d = gate("production", manifest("production", { approvals: withApproval("production", scope, { subject }) }));
    assert.equal(d.decision, "DENY", scope);
    assert.ok(d.reasons.includes(`APPROVAL_INVALID:${scope}:SUBJECT_MISMATCH`), `${scope}: ${d.reasons.join(",")}`);
  }
});

test("[OPS-04][OPS-APPR-01] a subject-bound approval without a signed subject, or a manifest that does not state the artifact, never counts", () => {
  const d = gate("production", manifest("production", { approvals: withApproval("production", "KNOWLEDGE_RELEASE", { subject: undefined }) }));
  assert.ok(d.reasons.includes("APPROVAL_INVALID:KNOWLEDGE_RELEASE:SUBJECT_MISSING"), d.reasons.join(","));
  const unstated = gate("production", manifest("production", { knowledgeSnapshotDigest: null }));
  assert.ok(unstated.reasons.includes("APPROVAL_INVALID:KNOWLEDGE_RELEASE:SUBJECT_UNVERIFIABLE"), unstated.reasons.join(","));
  const m = manifest("production");
  const labelOnly = gate("production", { ...m, versions: { ...m.versions, promptTemplates: "prompts-1" } });
  assert.ok(labelOnly.reasons.includes("APPROVAL_INVALID:CLINICAL_SCRIPTS:SUBJECT_UNVERIFIABLE"), labelOnly.reasons.join(","));
});

test("[OPS-04][OPS-APPR-01] approvals signed by a role not allowed for the scope are refused (e.g. a vendor admin approving PHI processing)", () => {
  for (const scope of ["PHI_PROCESSING", "CLINICAL_SCRIPTS", "SECURITY_REVIEW", "RETENTION_SCHEDULE"] as const) {
    const d = gate("production", manifest("production", { approvals: withApproval("production", scope, { approver: { name: "SYNTHETIC vendor admin", role: "talkdesk_admin" } }) }));
    assert.equal(d.decision, "DENY", scope);
    assert.ok(d.reasons.includes(`APPROVAL_INVALID:${scope}:APPROVER_ROLE_NOT_PERMITTED`), `${scope}: ${d.reasons.join(",")}`);
  }
});

// ---------------------------------------------------------------------------
// OPS-REL-02: run the release.yml manifest steps exactly as written.
// ---------------------------------------------------------------------------

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const YAML = createRequire(join(REPO, "platform", "package.json"))("yaml") as { parse(text: string): unknown };

interface WorkflowStep {
  name?: string;
  run?: string;
  env?: Record<string, string>;
}

function releaseStep(prefix: string): WorkflowStep {
  const doc = YAML.parse(readFileSync(join(REPO, ".github/workflows/release.yml"), "utf8")) as { jobs: Record<string, { steps: WorkflowStep[] }> };
  const step = Object.values(doc.jobs)
    .flatMap((j) => j.steps)
    .find((st) => st.name?.startsWith(prefix));
  assert.ok(step?.run, `release.yml step "${prefix}" not found`);
  return step;
}

/** GitHub's bash invocation for `run:` (bash --noprofile --norc -eo pipefail). */
function runStep(step: WorkflowStep, cwd: string, env: Record<string, string>): { status: number | null; stdout: string; stderr: string } {
  // `pnpm --filter @vsp/platform evidence ...` is dispatched exactly as platform/package.json's
  // `evidence` script does (asserted below); everything else in the step runs unchanged.
  const shim = [
    "pnpm() {",
    '  [ "$1" = --filter ] && [ "$2" = @vsp/platform ] && [ "$3" = evidence ] || { echo "unexpected pnpm invocation: $*" >&2; return 97; }',
    "  shift 3",
    '  (cd "$VSP_REPO/platform" && "$VSP_REPO/platform/node_modules/.bin/tsx" src/evaluation/cli.ts "$@")',
    "}",
  ].join("\n");
  const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", `${shim}\n${step.run ?? ""}`], {
    cwd,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? cwd, VSP_REPO: REPO, ...env },
    encoding: "utf8",
    timeout: 240_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test("[OPS-06][OPS-REL-02] release.yml manifest generation step runs verbatim and its output passes the gate's parse checks", () => {
  const pkg = JSON.parse(readFileSync(join(REPO, "platform", "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts.evidence, "tsx src/evaluation/cli.ts", "the pnpm shim must mirror the evidence script");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
  const ws = mkdtempSync(join(tmpdir(), "vsp-release-ws-"));
  try {
    // A GITHUB_WORKSPACE that resolves tools from this checkout; outputs stay in the temp dir.
    // (The gate script is copied, not linked: its entry-point check compares real paths.)
    symlinkSync(join(REPO, "platform"), join(ws, "platform"));
    mkdirSync(join(ws, "scripts", "ci"), { recursive: true });
    copyFileSync(join(REPO, "scripts/ci/check-release-manifest.ts"), join(ws, "scripts/ci/check-release-manifest.ts"));
    mkdirSync(join(ws, "evidence", "runs"), { recursive: true });
    const githubEnv = join(ws, "github-env");
    writeFileSync(githubEnv, "");
    const digest = `sha256:${"d".repeat(64)}`;
    const env = {
      TARGET_ENVIRONMENT: "sandbox",
      DIGEST: digest,
      GITHUB_SHA: head,
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_WORKSPACE: ws,
      GITHUB_ENV: githubEnv,
      IMAGE_REF: `registry.invalid/vsp@${digest}`,
    };
    const gen = runStep(releaseStep("Generate release manifest"), ws, env);
    assert.equal(gen.status, 0, `generate step failed: ${gen.stderr}`);
    const manifestPath = join(ws, "evidence/runs/release-manifest.json");
    assert.ok(existsSync(manifestPath), "evidence/runs/release-manifest.json (consumed by deploy.yml) was not written");
    const parsed = ReleaseManifest.safeParse(JSON.parse(readFileSync(manifestPath, "utf8")));
    assert.ok(parsed.success, "manifest is not schema-valid");
    assert.equal(parsed.data.targetEnvironment, "sandbox");
    assert.equal(parsed.data.build.imageDigest, digest);
    assert.equal(parsed.data.build.buildId, "123.1");
    assert.equal(parsed.data.sourceCommit, head);

    const check = runStep(releaseStep("Check the manifest is well formed"), ws, env);
    assert.equal(check.status, 0, check.stderr);
    const decision = JSON.parse(readFileSync(join(ws, "evidence/runs/release-manifest-gate.json"), "utf8")) as { decision: string; reasons: string[] };
    // No approvals exist, so the gate denies; but never because the step wiring is broken.
    assert.equal(decision.decision, "DENY");
    for (const bad of ["MANIFEST_UNREADABLE", "IMAGE_DIGEST_MISMATCH", "SOURCE_COMMIT_MISMATCH", "ENVIRONMENT_MISMATCH:sandbox"]) assert.ok(!decision.reasons.includes(bad), bad);
    assert.ok(!decision.reasons.some((r) => r.startsWith("MANIFEST_SCHEMA_INVALID")), decision.reasons.join(","));
    // The signing step signs the same file deploy.yml verifies.
    assert.match(releaseStep("Sign the release manifest").run ?? "", /evidence\/runs\/release-manifest\.json/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("[OPS-06][OPS-REL-02] the release.yml pre-check fails the step when the CLI rejects the command line", () => {
  const step = releaseStep("Generate release manifest");
  const broken: WorkflowStep = { ...step, run: (step.run ?? "").replace("--out-dir", "--out") };
  const ws = mkdtempSync(join(tmpdir(), "vsp-release-ws-"));
  try {
    mkdirSync(join(ws, "evidence", "runs"), { recursive: true });
    const r = runStep(broken, ws, { TARGET_ENVIRONMENT: "sandbox", DIGEST: `sha256:${"d".repeat(64)}`, GITHUB_SHA: "a".repeat(40), GITHUB_RUN_ID: "1", GITHUB_RUN_ATTEMPT: "1", GITHUB_WORKSPACE: ws });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /::error::the evaluation CLI rejected the release-manifest command line/);
    assert.ok(!existsSync(join(ws, "evidence/runs/release-manifest.json")));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
