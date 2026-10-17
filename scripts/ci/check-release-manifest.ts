/**
 * Release-manifest deployment gate (OPS-03, OPS-04, OPS-05; spec sections 14-16).
 *
 * Called by .github/workflows/deploy.yml BEFORE any terraform plan/apply. It refuses
 * to deploy unless the manifest (platform/src/protocol/release.ts) permits the target
 * environment:
 *   - strict schema parse; target environment, image digest and source commit match;
 *   - release status deployable for the environment (production: APPROVED_PILOT or
 *     VERIFIED_PRODUCTION only);
 *   - no declared missing approvals; every required approval scope present, signed and
 *     VERIFIED against the trusted public key, for this environment and unexpired
 *     (REQUIRED_APPROVALS_BY_ENVIRONMENT from platform/src/config/guard.ts, plus
 *     BILLABLE_TEST_EXECUTION for sandbox/staging because deploying creates billable
 *     resources);
 *   - production: every test/quota evidence entry PASS (missing evidence is never PASS),
 *     the reviewed infrastructure plan digest bound in the manifest, a rollback target,
 *     and a manifest signature.
 * The coding agent cannot create approvals; without real signed records this gate DENIES.
 *
 * Usage (run with tsx from the repository root):
 *   platform/node_modules/.bin/tsx scripts/ci/check-release-manifest.ts \
 *     --manifest release-manifest.json --environment production \
 *     [--image-digest sha256:...] [--source-commit <40 hex>] [--plan-digest <64 hex>] \
 *     [--trusted-key-pem approvals-trust.pem] [--now 2026-10-17T00:00:00Z]
 * Exit codes: 0 ALLOW, 1 DENY, 2 usage error. Output: one JSON decision on stdout.
 */
import { readFileSync } from "node:fs";
import type { KeyObject } from "node:crypto";
import { pathToFileURL } from "node:url";
import { ReleaseManifest } from "../../platform/src/protocol/release.js";
import type { ApprovalScope, ReleaseStatus } from "../../platform/src/protocol/release.js";
import { REQUIRED_APPROVALS_BY_ENVIRONMENT } from "../../platform/src/config/guard.js";
import { evaluateApproval, parseTrustedPublicKey } from "../../platform/src/config/approvals.js";

export type DeployEnvironment = "sandbox" | "staging" | "production";

export const DEPLOYABLE_STATUS: Readonly<Record<DeployEnvironment, readonly ReleaseStatus[]>> = {
  sandbox: ["IMPLEMENTED_OFFLINE", "VERIFIED_SANDBOX", "APPROVED_PILOT", "VERIFIED_PRODUCTION"],
  staging: ["VERIFIED_SANDBOX", "APPROVED_PILOT", "VERIFIED_PRODUCTION"],
  production: ["APPROVED_PILOT", "VERIFIED_PRODUCTION"],
};

/** Deploying infrastructure is billable execution (OPS-05) even where the runtime guard needs nothing. */
export const DEPLOY_EXTRA_APPROVALS: Readonly<Record<DeployEnvironment, readonly ApprovalScope[]>> = {
  sandbox: ["BILLABLE_TEST_EXECUTION"],
  staging: ["BILLABLE_TEST_EXECUTION"],
  production: [],
};

export function requiredDeployApprovals(env: DeployEnvironment): ApprovalScope[] {
  return [...new Set([...REQUIRED_APPROVALS_BY_ENVIRONMENT[env], ...DEPLOY_EXTRA_APPROVALS[env]])].sort();
}

export interface GateInput {
  manifest: unknown;
  environment: DeployEnvironment;
  imageDigest?: string;
  sourceCommit?: string;
  planDigest?: string;
  trustedKey: KeyObject | null;
  now: Date;
}

export interface GateDecision {
  decision: "ALLOW" | "DENY";
  environment: DeployEnvironment;
  releaseId: string | null;
  status: string | null;
  requiredApprovals: ApprovalScope[];
  reasons: string[];
}

export function evaluateReleaseGate(input: GateInput): GateDecision {
  const reasons: string[] = [];
  const required = requiredDeployApprovals(input.environment);
  const parsed = ReleaseManifest.safeParse(input.manifest);
  if (!parsed.success) {
    // Paths only: never echo manifest values.
    for (const issue of parsed.error.issues.slice(0, 20)) reasons.push(`MANIFEST_SCHEMA_INVALID:${issue.path.join(".") || "(root)"}`);
    return { decision: "DENY", environment: input.environment, releaseId: null, status: null, requiredApprovals: required, reasons };
  }
  const m = parsed.data;

  if (m.targetEnvironment !== input.environment) reasons.push(`ENVIRONMENT_MISMATCH:${m.targetEnvironment}`);
  if (!DEPLOYABLE_STATUS[input.environment].includes(m.status)) reasons.push(`STATUS_NOT_DEPLOYABLE:${m.status}`);

  if (!m.build.imageDigest || !/^sha256:[a-f0-9]{64}$/.test(m.build.imageDigest)) reasons.push("IMAGE_DIGEST_MISSING");
  else if (input.imageDigest !== undefined && input.imageDigest !== m.build.imageDigest) reasons.push("IMAGE_DIGEST_MISMATCH");
  if (input.sourceCommit !== undefined && input.sourceCommit !== m.sourceCommit) reasons.push("SOURCE_COMMIT_MISMATCH");

  if (m.missingApprovals.length > 0) reasons.push(`MISSING_APPROVALS_DECLARED:${[...m.missingApprovals].sort().join(",")}`);

  for (const scope of required) {
    const candidates = m.approvals.filter((a) => a.scope === scope);
    if (candidates.length === 0) {
      reasons.push(`APPROVAL_MISSING:${scope}`);
      continue;
    }
    const evaluations = candidates.map((a) => evaluateApproval(a, { environment: input.environment, now: input.now, trustedKey: input.trustedKey }));
    if (!evaluations.some((e) => e.status === "VALID")) {
      reasons.push(`APPROVAL_INVALID:${scope}:${[...new Set(evaluations.flatMap((e) => e.failures))].join("+")}`);
    }
  }

  const evidence = [...m.testEvidence, ...m.quotaAndLoadEvidence];
  if (input.environment === "production") {
    if (evidence.length === 0) reasons.push("EVIDENCE_MISSING");
    for (const e of evidence) if (e.status !== "PASS") reasons.push(`EVIDENCE_NOT_PASS:${e.kind}:${e.status}`);
    if (!m.infrastructurePlanDigest) reasons.push("PLAN_DIGEST_NOT_BOUND");
    if (!m.rollbackTarget) reasons.push("ROLLBACK_TARGET_REQUIRED");
    if (!m.signature) reasons.push("MANIFEST_SIGNATURE_REQUIRED");
  } else if (input.environment === "staging") {
    for (const e of evidence) if (e.status === "FAIL" || e.status === "BLOCKED") reasons.push(`EVIDENCE_NOT_PASS:${e.kind}:${e.status}`);
  } else {
    for (const e of evidence) if (e.status === "FAIL") reasons.push(`EVIDENCE_FAILED:${e.kind}`);
  }

  if (input.planDigest !== undefined && m.infrastructurePlanDigest && m.infrastructurePlanDigest !== input.planDigest) {
    reasons.push("PLAN_DIGEST_MISMATCH");
  }
  if (input.environment === "production" && input.planDigest === undefined) reasons.push("PLAN_DIGEST_NOT_CHECKED");

  return {
    decision: reasons.length === 0 ? "ALLOW" : "DENY",
    environment: input.environment,
    releaseId: m.releaseId,
    status: m.status,
    requiredApprovals: required,
    reasons,
  };
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    const v = argv[i + 1];
    if (!k?.startsWith("--") || v === undefined) throw new Error("USAGE");
    out[k.slice(2)] = v;
  }
  return out;
}

function main(): void {
  let args: Record<string, string>;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch {
    process.stderr.write("usage: check-release-manifest.ts --manifest <file> --environment sandbox|staging|production [--image-digest] [--source-commit] [--plan-digest] [--trusted-key-pem] [--now]\n");
    process.exit(2);
  }
  const env = args.environment as DeployEnvironment;
  if (!args.manifest || !["sandbox", "staging", "production"].includes(env)) {
    process.stderr.write("check-release-manifest: --manifest and a deployable --environment are required\n");
    process.exit(2);
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(args.manifest, "utf8"));
  } catch {
    process.stdout.write(`${JSON.stringify({ decision: "DENY", environment: env, reasons: ["MANIFEST_UNREADABLE"] })}\n`);
    process.exit(1);
  }
  let trustedKey: KeyObject | null = null;
  if (args["trusted-key-pem"]) {
    try {
      trustedKey = parseTrustedPublicKey(readFileSync(args["trusted-key-pem"], "utf8"));
    } catch {
      process.stdout.write(`${JSON.stringify({ decision: "DENY", environment: env, reasons: ["TRUSTED_KEY_INVALID"] })}\n`);
      process.exit(1);
    }
  }
  const decision = evaluateReleaseGate({
    manifest,
    environment: env,
    imageDigest: args["image-digest"],
    sourceCommit: args["source-commit"],
    planDigest: args["plan-digest"],
    trustedKey,
    now: args.now ? new Date(args.now) : new Date(),
  });
  process.stdout.write(`${JSON.stringify(decision)}\n`);
  process.exit(decision.decision === "ALLOW" ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
