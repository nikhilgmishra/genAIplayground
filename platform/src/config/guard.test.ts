import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { ApprovalRecord, ApprovalScope, ApprovalSubject, Environment } from "../protocol/index.js";
import { FakeClock } from "../shared/clock.js";
import { ConfigurationRejectedError } from "../shared/errors.js";
import { APPROVER_ROLES_BY_SCOPE, approvalSigningPayload, loadApprovalRecords } from "./approvals.js";
import { REQUIRED_APPROVALS_BY_ENVIRONMENT, assertDeployable, evaluateDeployability, phiEndpointsPermitted } from "./guard.js";
import type { GuardContext, GuardReport } from "./guard.js";
import { CONFIG_DIR, REPO_ROOT, loadPlatformConfig } from "./loader.js";
import type { PlatformConfig } from "./ports.js";
import { loadDeployableConfig } from "./startup.js";

const here = dirname(fileURLToPath(import.meta.url));
const clock = new FakeClock("2026-10-17T15:00:00.000Z");
const NOW = clock.now();

/**
 * TEST-ONLY signing key pair generated in memory for this run. Used solely to
 * prove the guard is satisfiable; never written to approvals/ and has no authority.
 */
const TEST_ONLY_KEYS = generateKeyPairSync("ed25519");
const TEST_ONLY_PUBLIC_PEM = TEST_ONLY_KEYS.publicKey.export({ type: "spki", format: "pem" }).toString();

const HYPO_MODEL = { model: "hypothetical-model-1", voice: "hypothetical-voice-1", agentConfig: "hypothetical-agent-1" };
const HYPO_KNOWLEDGE = "d".repeat(64);
const HYPO_TEMPLATES = "e".repeat(64);
const HYPO_IMAGE = `sha256:${"f".repeat(64)}`;

/** TEST-ONLY subjects naming exactly the hypothetical production artifacts below (OPS-APPR-01). */
function boundSubject(scope: ApprovalScope): ApprovalSubject | undefined {
  if (scope === "MODEL_VOICE_SELECTION") return { modelVoice: HYPO_MODEL };
  if (scope === "POLICY_RELEASE") return { policyBundle: { version: "policy-hypothetical-1", digest: "a".repeat(64) } };
  if (scope === "KNOWLEDGE_RELEASE") return { knowledgeSnapshotDigest: HYPO_KNOWLEDGE };
  if (scope === "CLINICAL_SCRIPTS") return { templateCatalogDigest: HYPO_TEMPLATES };
  if (scope === "PRODUCTION_DEPLOYMENT" || scope === "PILOT_EXPOSURE") return { release: { imageDigest: HYPO_IMAGE } };
  return undefined;
}

function testOnlyApproval(scope: ApprovalScope, environment: Environment, over: Partial<ApprovalRecord> = {}, signed = true): ApprovalRecord {
  const subject = boundSubject(scope);
  const record: ApprovalRecord = {
    approvalId: `apr_TESTONLY_${scope.toLowerCase()}_${environment}`.slice(0, 68),
    // The first role the scope allows (APPROVER_ROLES_BY_SCOPE); TEST-ONLY, no authority.
    approver: { name: "Test Only Approver", role: APPROVER_ROLES_BY_SCOPE[scope][0] ?? "security_leadership" },
    scope,
    scopeDetail: `TEST-ONLY hypothetical ${scope} record for guard satisfiability tests; carries no authority`,
    ...(subject ? { subject } : {}),
    environment,
    grantedAt: "2026-10-16T15:00:00.000Z",
    expiresAt: "2026-11-16T15:00:00.000Z",
    evidenceRef: "test://guard.test.ts",
    signature: null,
    ...over,
  };
  if (!signed) return record;
  const sig = cryptoSign(null, Buffer.from(approvalSigningPayload(record), "utf8"), TEST_ONLY_KEYS.privateKey);
  return { ...record, signature: `ed25519:${sig.toString("base64")}` };
}

const load = (env: Environment): PlatformConfig => loadPlatformConfig({ environment: env, env: {} }).config;
const codes = (r: GuardReport) => r.violations.map((v) => v.code);
const has = (r: GuardReport, code: string, path?: string) => r.violations.some((v) => v.code === code && (path === undefined || v.path === path));

const HYPO_ACCOUNT = "111122223333"; // AWS documentation example account id
const POLICY = { version: "policy-hypothetical-1", digest: "a".repeat(64) };
const CATALOG = "b".repeat(64);

/** A hypothetical, fully-correct production configuration (TEST-ONLY values; not a recommendation). */
function hypotheticalProductionConfig(): PlatformConfig {
  const c = structuredClone(load("production"));
  c.tenantId = "tnt_HypotheticalProdTenant01";
  for (const [name, a] of Object.entries(c.adapters)) {
    a.endpoint = `https://${name}.hypothetical-vendor.example.com/api`;
    a.credentialRef = `arn:aws:secretsmanager:us-east-1:${HYPO_ACCOUNT}:secret:vsp-prod-${name}`;
  }
  c.models = {
    active: { ...HYPO_MODEL },
    approved: [{ model: HYPO_MODEL.model, voice: HYPO_MODEL.voice, approvalId: testOnlyApproval("MODEL_VOICE_SELECTION", "production").approvalId }],
  };
  c.policy = { ...c.policy, expectedVersion: POLICY.version, expectedDigest: POLICY.digest };
  c.toolCatalog = { expectedDigest: CATALOG };
  c.cors = { allowedOrigins: ["https://console.hypothetical-tenant.example.com"] };
  c.verification = { ...c.verification, approvedBySecurity: testOnlyApproval("SECURITY_REVIEW", "production").approvalId };
  // TEST-ONLY arbitrary placeholder durations: retention is set by counsel, never by this code.
  c.retention = { TRANSIENT_CONVERSATION: 1, BUSINESS_RECORD: 1, RESTRICTED_QA_MEDIA: 1, SECURITY_AUDIT: 1 };
  c.approvals = { ...c.approvals, trustedSigningKeyRef: `arn:aws:kms:us-east-1:${HYPO_ACCOUNT}:key/00000000-0000-0000-0000-000000000000` };
  c.signing = { assertionKeyRef: `arn:aws:kms:us-east-1:${HYPO_ACCOUNT}:key/11111111-1111-1111-1111-111111111111`, localDevKey: false };
  c.database = { engine: "pg", connectionRef: `arn:aws:secretsmanager:us-east-1:${HYPO_ACCOUNT}:secret:vsp-prod-aurora` };
  c.sessionStore = { kind: "dynamodb", tableName: "vsp-prod-sessions" };
  c.destinations = c.destinations.map((d) => ({ ...d, vendorQueueRef: d.vendorQueueRef.replace("PLACEHOLDER", "HYPOTHETICAL") }));
  return c;
}

function hypotheticalProductionContext(config: PlatformConfig, approvals?: ApprovalRecord[]): GuardContext {
  return {
    approvals: approvals ?? REQUIRED_APPROVALS_BY_ENVIRONMENT.production.map((s) => testOnlyApproval(s, "production")),
    trustedApprovalKey: TEST_ONLY_PUBLIC_PEM,
    adapterKinds: Object.fromEntries(Object.keys(config.adapters).map((k) => [k, "live" as const])),
    loadedPolicy: POLICY,
    toolCatalogDigest: CATALOG,
    knowledgeSnapshotDigest: HYPO_KNOWLEDGE,
    templateCatalogDigest: HYPO_TEMPLATES,
    releaseImageDigest: HYPO_IMAGE,
    now: NOW,
  };
}

describe("production guard (OPS-04)", () => {
  it("[OPS-04] the committed production config is rejected and the violation list is captured as evidence", () => {
    const loaded = loadPlatformConfig({ environment: "production", env: {} });
    const approvals = loadApprovalRecords(join(REPO_ROOT, loaded.config.approvals.directory));
    const ctx: GuardContext = {
      approvals: approvals.records,
      rejectedApprovalFiles: approvals.rejected,
      duplicateApprovalIds: approvals.duplicateIds,
      trustedApprovalKey: null,
      adapterKinds: {},
      loadedPolicy: null,
      toolCatalogDigest: null,
      now: NOW,
    };
    expect(() => assertDeployable(loaded.config, ctx)).toThrow(ConfigurationRejectedError);
    const report = evaluateDeployability(loaded.config, ctx);
    expect(report.deployable).toBe(false);
    expect(report.ruleSet).toBe("full");
    for (const scope of REQUIRED_APPROVALS_BY_ENVIRONMENT.production) expect(has(report, "APPROVAL_MISSING", `approvals.required.${scope}`)).toBe(true);
    for (const cls of ["TRANSIENT_CONVERSATION", "BUSINESS_RECORD", "RESTRICTED_QA_MEDIA", "SECURITY_AUDIT"]) expect(has(report, "RETENTION_UNSET", `retention.${cls}`)).toBe(true);
    expect(codes(report)).toEqual(
      expect.arrayContaining([
        "ADAPTER_ENDPOINT_MISSING",
        "ADAPTER_CREDENTIAL_PLACEHOLDER",
        "MODEL_VOICE_NOT_APPROVED",
        "POLICY_VERSION_UNPINNED",
        "POLICY_DIGEST_UNPINNED",
        "TOOL_CATALOG_DIGEST_UNPINNED",
        "VERIFICATION_VALUES_UNAPPROVED",
        "APPROVAL_TRUST_KEY_MISSING",
        "SIGNING_KEY_REF_PLACEHOLDER",
        "DATABASE_CONNECTION_REF_PLACEHOLDER",
        "SESSION_STORE_TABLE_PLACEHOLDER",
        "TENANT_PLACEHOLDER",
        "DESTINATION_VENDOR_REF_PLACEHOLDER",
      ]),
    );
    expect(report.phiEndpointsPermitted).toBe(false);

    const evidence = {
      evidence: "production-guard-violations",
      description:
        "Violations reported by the deployment guard for platform/config/production.json with the repository's approvals directory. Expected: REJECTED (no human approval records exist; references are placeholders; retention unset). This is evidence of the control, not of production readiness.",
      generatedBy: "platform/src/config/guard.test.ts",
      regenerate: "cd platform && npx vitest run src/config/guard.test.ts",
      evaluatedAt: NOW.toISOString(),
      configFile: relative(REPO_ROOT, join(CONFIG_DIR, "production.json")),
      configFileDigest: loaded.source.fileDigest,
      approvalsDirectory: loaded.config.approvals.directory,
      approvalRecordsFound: approvals.records.length,
      trustedApprovalKey: "NOT_CONFIGURED",
      runtimeContext: { adapterKindsInstantiated: 0, loadedPolicy: null, toolCatalogDigest: null },
      ruleSet: report.ruleSet,
      result: "REJECTED",
      violationCount: report.violations.length,
      violations: report.violations.map((v) => `${v.code}@${v.path}`),
    };
    mkdirSync(join(here, "__evidence__"), { recursive: true });
    writeFileSync(join(here, "__evidence__", "production-guard-violations.json"), JSON.stringify(evidence, null, 2) + "\n");
  });

  it("[OPS-04] explicit violations for fixture adapters, missing credentials, unapproved model, unknown policy version, permissive CORS, disabled audit and missing approvals", () => {
    const c = hypotheticalProductionConfig();
    const scheduling = c.adapters.scheduling;
    const billing = c.adapters.billing;
    if (!scheduling || !billing) throw new Error("fixture adapters missing");
    scheduling.kind = "local_fixture";
    billing.credentialRef = null;
    c.models.active = { model: "unreviewed-model-2", voice: "hypothetical-voice-1", agentConfig: "hypothetical-agent-1" };
    c.cors.allowedOrigins = ["*", "http://console.hypothetical-tenant.example.com"];
    c.audit = { ...c.audit, enabled: false, sink: "local_fixture" };
    c.database.engine = "pglite";
    c.sessionStore = { kind: "memory", tableName: null };
    const ctx = hypotheticalProductionContext(c, [testOnlyApproval("SECURITY_REVIEW", "production")]);
    ctx.loadedPolicy = { version: "policy-unknown-9", digest: "c".repeat(64) };
    ctx.adapterKinds.scheduling = "local_fixture";
    let error: unknown;
    try {
      assertDeployable(c, ctx);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigurationRejectedError);
    const v = (error as ConfigurationRejectedError).violations;
    expect(v).toEqual(
      expect.arrayContaining([
        "ADAPTER_LOCAL_FIXTURE@adapters.scheduling",
        "ADAPTER_RUNTIME_LOCAL_FIXTURE@runtime.scheduling",
        "ADAPTER_CREDENTIAL_MISSING@adapters.billing.credentialRef",
        "MODEL_VOICE_NOT_APPROVED@models.active",
        "POLICY_VERSION_MISMATCH@policy.expectedVersion",
        "POLICY_DIGEST_MISMATCH@policy.expectedDigest",
        "CORS_WILDCARD@cors.allowedOrigins.0",
        "CORS_NON_HTTPS_ORIGIN@cors.allowedOrigins.1",
        "AUDIT_DISABLED@audit.enabled",
        "AUDIT_SINK_LOCAL_FIXTURE@audit.sink",
        "DATABASE_ENGINE_PGLITE@database.engine",
        "SESSION_STORE_MEMORY@sessionStore.kind",
        "APPROVAL_MISSING@approvals.required.PHI_PROCESSING",
        "APPROVAL_MISSING@approvals.required.PRODUCTION_DEPLOYMENT",
        "APPROVAL_MISSING@approvals.required.CLINICAL_SCRIPTS",
        "APPROVAL_MISSING@approvals.required.MODEL_VOICE_SELECTION",
      ]),
    );
    // DATA-01: violation strings carry codes and config paths only, never references or values.
    const joined = v.join("|") + (error as Error).message;
    expect(joined).not.toContain("arn:aws");
    expect(joined).not.toContain(HYPO_ACCOUNT);
    expect(joined).not.toContain("Test Only Approver");
  });

  it("[OPS-04] a hypothetical fully-correct config with correctly signed approvals passes (the guard is satisfiable)", () => {
    const c = hypotheticalProductionConfig();
    const report = assertDeployable(c, hypotheticalProductionContext(c));
    expect(report.violations).toEqual([]);
    expect(report.deployable).toBe(true);
    expect(report.requiredApprovals.every((r) => r.satisfiedBy !== null)).toBe(true);
    // PHI endpoints are disabled in config, so they are still not permitted.
    expect(phiEndpointsPermitted(report)).toBe(false);
    const withPhi = { ...c, phi: { endpointsEnabled: true } };
    expect(phiEndpointsPermitted(assertDeployable(withPhi, hypotheticalProductionContext(withPhi)))).toBe(true);
  });

  it("[OPS-04] expired, wrong-environment, unsigned, tampered and unverifiable approvals are rejected", () => {
    const c = hypotheticalProductionConfig();
    const scopes = REQUIRED_APPROVALS_BY_ENVIRONMENT.production;
    const cases: { name: string; replace: (r: ApprovalRecord) => ApprovalRecord; code: string; key?: string | null }[] = [
      { name: "expired", replace: (r) => testOnlyApproval(r.scope, "production", { expiresAt: "2026-10-17T14:59:59.000Z" }), code: "APPROVAL_EXPIRED" },
      { name: "wrong environment", replace: (r) => testOnlyApproval(r.scope, "staging", { approvalId: r.approvalId }), code: "APPROVAL_WRONG_ENVIRONMENT" },
      { name: "unsigned", replace: (r) => testOnlyApproval(r.scope, "production", {}, false), code: "APPROVAL_UNSIGNED" },
      { name: "tampered", replace: (r) => ({ ...r, scopeDetail: `${r.scopeDetail} (edited after signing)` }), code: "APPROVAL_SIGNATURE_INVALID" },
      { name: "not yet valid", replace: (r) => testOnlyApproval(r.scope, "production", { grantedAt: "2026-10-18T00:00:00.000Z" }), code: "APPROVAL_NOT_YET_VALID" },
    ];
    for (const tc of cases) {
      const approvals = scopes.map((s) => testOnlyApproval(s, "production"));
      const idx = approvals.findIndex((a) => a.scope === "CLINICAL_SCRIPTS");
      const target = approvals[idx];
      if (!target) throw new Error("missing");
      approvals[idx] = tc.replace(target);
      const report = evaluateDeployability(c, hypotheticalProductionContext(c, approvals));
      expect(report.deployable, tc.name).toBe(false);
      expect(has(report, "APPROVAL_MISSING", "approvals.required.CLINICAL_SCRIPTS"), tc.name).toBe(true);
      expect(has(report, tc.code, `approvals.records.${approvals[idx]?.approvalId}`), tc.name).toBe(true);
    }
    // Correctly signed approvals with no trusted key configured are all UNVERIFIED.
    const noKey = { ...hypotheticalProductionContext(c), trustedApprovalKey: null };
    const r = evaluateDeployability(c, noKey);
    expect(r.deployable).toBe(false);
    expect(codes(r)).toContain("APPROVAL_UNVERIFIED_NO_TRUST_KEY");
    expect(codes(r)).toContain("APPROVAL_TRUST_KEY_UNRESOLVED");
    // A key signed by someone else (not the trusted key) is rejected.
    const foreign = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(codes(evaluateDeployability(c, { ...hypotheticalProductionContext(c), trustedApprovalKey: foreign }))).toContain("APPROVAL_SIGNATURE_INVALID");
    // A private key is never accepted as the trust anchor.
    const priv = TEST_ONLY_KEYS.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(codes(evaluateDeployability(c, { ...hypotheticalProductionContext(c), trustedApprovalKey: priv }))).toContain("APPROVAL_TRUST_KEY_INVALID");
  });

  it("[OPS-04] property: removing any non-empty subset of required production approvals rejects the config", () => {
    const c = hypotheticalProductionConfig();
    const scopes = [...REQUIRED_APPROVALS_BY_ENVIRONMENT.production];
    fc.assert(
      fc.property(fc.subarray(scopes, { minLength: 1 }), (removed) => {
        const approvals = scopes.filter((s) => !removed.includes(s)).map((s) => testOnlyApproval(s, "production"));
        const report = evaluateDeployability(c, hypotheticalProductionContext(c, approvals));
        expect(report.deployable).toBe(false);
        for (const s of removed) expect(has(report, "APPROVAL_MISSING", `approvals.required.${s}`)).toBe(true);
      }),
      { numRuns: 60 },
    );
  });

  it("[OPS-04] configuration cannot lower the environment's approval floor", () => {
    const c = hypotheticalProductionConfig();
    c.approvals.required = c.approvals.required.filter((s) => s !== "CLINICAL_SCRIPTS");
    const approvals = REQUIRED_APPROVALS_BY_ENVIRONMENT.production.filter((s) => s !== "CLINICAL_SCRIPTS").map((s) => testOnlyApproval(s, "production"));
    const r = evaluateDeployability(c, hypotheticalProductionContext(c, approvals));
    expect(has(r, "APPROVAL_REQUIREMENT_BELOW_FLOOR", "approvals.required.CLINICAL_SCRIPTS")).toBe(true);
    expect(has(r, "APPROVAL_MISSING", "approvals.required.CLINICAL_SCRIPTS")).toBe(true);
  });

  it("[OPS-04] static credential and session-binding exceptions need their own valid approvals", () => {
    const c = hypotheticalProductionConfig();
    const sf = c.adapters.salesforce;
    if (!sf) throw new Error("missing");
    sf.authMethod = "bearer_static_exception";
    sf.exceptionApprovalId = "apr_TESTONLY_static_exception";
    c.sessionBinding = { ...c.sessionBinding, mode: "tool_argument_lookup_exception", exceptionApprovalId: "apr_TESTONLY_binding_exception" };
    const base = REQUIRED_APPROVALS_BY_ENVIRONMENT.production.map((s) => testOnlyApproval(s, "production"));
    const r1 = evaluateDeployability(c, hypotheticalProductionContext(c, base));
    expect(has(r1, "STATIC_CREDENTIAL_EXCEPTION_UNAPPROVED", "adapters.salesforce.exceptionApprovalId")).toBe(true);
    expect(has(r1, "SESSION_BINDING_EXCEPTION_UNAPPROVED", "sessionBinding.exceptionApprovalId")).toBe(true);
    // An approval of the wrong scope does not count.
    const wrongScope = testOnlyApproval("POLICY_RELEASE", "production", { approvalId: "apr_TESTONLY_static_exception" });
    expect(has(evaluateDeployability(c, hypotheticalProductionContext(c, [...base, wrongScope])), "STATIC_CREDENTIAL_EXCEPTION_UNAPPROVED")).toBe(true);
    const ok = [
      ...base,
      testOnlyApproval("STATIC_CREDENTIAL_EXCEPTION", "production", { approvalId: "apr_TESTONLY_static_exception" }),
      testOnlyApproval("SECURITY_REVIEW", "production", { approvalId: "apr_TESTONLY_binding_exception" }),
    ];
    expect(evaluateDeployability(c, hypotheticalProductionContext(c, ok)).violations).toEqual([]);
  });

  it("[OPS-04] security-approved verification values, retention, signing keys and trust anchors are each enforced", () => {
    const c = hypotheticalProductionConfig();
    c.verification.approvedBySecurity = null;
    c.retention.RESTRICTED_QA_MEDIA = null;
    c.signing = { assertionKeyRef: null, localDevKey: true };
    c.approvals.trustedSigningKeyRef = null;
    const r = evaluateDeployability(c, hypotheticalProductionContext(c));
    expect(r.violations).toEqual(
      expect.arrayContaining([
        { code: "VERIFICATION_VALUES_UNAPPROVED", path: "verification.approvedBySecurity" },
        { code: "RETENTION_UNSET", path: "retention.RESTRICTED_QA_MEDIA" },
        { code: "SIGNING_LOCAL_DEV_KEY", path: "signing.localDevKey" },
        { code: "SIGNING_KEY_REF_MISSING", path: "signing.assertionKeyRef" },
        { code: "APPROVAL_TRUST_KEY_MISSING", path: "approvals.trustedSigningKeyRef" },
      ]),
    );
    const c2 = hypotheticalProductionConfig();
    c2.approvals.trustedSigningKeyRef = "file:trusted.pem";
    c2.signing.assertionKeyRef = "local-fixture:assertion-dev-key";
    const r2 = evaluateDeployability(c2, hypotheticalProductionContext(c2));
    expect(codes(r2)).toEqual(expect.arrayContaining(["APPROVAL_TRUST_KEY_REF_NOT_KMS", "SIGNING_KEY_REF_LOCAL"]));
  });

  it("[OPS-04] live adapters need https, routable, non-placeholder endpoints and real authentication", () => {
    const c = hypotheticalProductionConfig();
    const set = (name: string, patch: Partial<PlatformConfig["adapters"][string]>) => {
      const a = c.adapters[name];
      if (!a) throw new Error("missing");
      Object.assign(a, patch);
    };
    set("claims", { endpoint: "http://claims.hypothetical-vendor.example.com" });
    set("billing", { endpoint: "https://billing.local.invalid" });
    set("notifications", { authMethod: "none" });
    set("scheduling", { credentialRef: "local-fixture:scheduling" });
    const r = evaluateDeployability(c, hypotheticalProductionContext(c));
    expect(r.violations).toEqual(
      expect.arrayContaining([
        { code: "ADAPTER_ENDPOINT_NOT_HTTPS", path: "adapters.claims.endpoint" },
        { code: "ADAPTER_ENDPOINT_NOT_ROUTABLE", path: "adapters.billing.endpoint" },
        { code: "ADAPTER_AUTH_NONE", path: "adapters.notifications.authMethod" },
        { code: "ADAPTER_CREDENTIAL_LOCAL", path: "adapters.scheduling.credentialRef" },
      ]),
    );
    const c3 = hypotheticalProductionConfig();
    const ctx3 = hypotheticalProductionContext(c3);
    ctx3.adapterKinds.salesforce = "local_fixture";
    expect(codes(evaluateDeployability(c3, ctx3))).toEqual(expect.arrayContaining(["ADAPTER_KIND_MISMATCH", "ADAPTER_RUNTIME_LOCAL_FIXTURE"]));
  });

  it("[SPEC-16.phi] PHI endpoints are not permitted while any prerequisite is missing", () => {
    const c = { ...hypotheticalProductionConfig(), phi: { endpointsEnabled: true } };
    const approvals = REQUIRED_APPROVALS_BY_ENVIRONMENT.production.filter((s) => s !== "PHI_PROCESSING").map((s) => testOnlyApproval(s, "production"));
    const r = evaluateDeployability(c, hypotheticalProductionContext(c, approvals));
    expect(has(r, "PHI_ENDPOINTS_UNAPPROVED", "phi.endpointsEnabled")).toBe(true);
    expect(phiEndpointsPermitted(r)).toBe(false);
  });

  it("[SAFE-02] every environment must keep a safety route, a human route and an outage continuity route", () => {
    const c = load("local");
    c.destinations = c.destinations.filter((d) => d.purpose !== "SAFETY_PRIORITY" && d.purpose !== "OUTAGE_CONTINUITY").map((d) => ({ ...d, fallbackDestinationIds: [] }));
    const r = evaluateDeployability(c, { approvals: [], adapterKinds: {}, loadedPolicy: null, toolCatalogDigest: null, now: NOW });
    expect(codes(r)).toEqual(expect.arrayContaining(["DESTINATION_SAFETY_ROUTE_MISSING", "DESTINATION_CONTINUITY_ROUTE_MISSING"]));
    const c2 = load("local");
    const first = c2.destinations[0];
    if (!first) throw new Error("missing");
    first.fallbackDestinationIds = ["dst_not_configured"];
    expect(codes(evaluateDeployability(c2, { approvals: [], adapterKinds: {}, loadedPolicy: null, toolCatalogDigest: null, now: NOW }))).toContain("DESTINATION_FALLBACK_UNKNOWN");
  });

  it("[OPS-04] staging config is rejected today", () => {
    const c = load("staging");
    const r = evaluateDeployability(c, { approvals: [], adapterKinds: {}, loadedPolicy: null, toolCatalogDigest: null, now: NOW });
    expect(r.deployable).toBe(false);
    expect(has(r, "APPROVAL_MISSING", "approvals.required.VENDOR_SANDBOX_INTEGRATION")).toBe(true);
    expect(has(r, "APPROVAL_MISSING", "approvals.required.SECURITY_REVIEW")).toBe(true);
    expect(has(r, "RETENTION_UNSET")).toBe(true);
  });
});

describe("approval binding (OPS-APPR-01)", () => {
  const recordId = (approvals: ApprovalRecord[], scope: ApprovalScope) => approvals.find((a) => a.scope === scope)?.approvalId ?? "missing";

  it("[OPS-04][OPS-06][OPS-APPR-01] an unreviewed model listed with the approval id of a record for another model is rejected", () => {
    const c = hypotheticalProductionConfig();
    const approvals = REQUIRED_APPROVALS_BY_ENVIRONMENT.production.map((s) => testOnlyApproval(s, "production"));
    const mv = recordId(approvals, "MODEL_VOICE_SELECTION");
    c.models = { active: { model: "unreviewed-model-9", voice: "unreviewed-voice-9", agentConfig: "agent-x" }, approved: [{ model: "unreviewed-model-9", voice: "unreviewed-voice-9", approvalId: mv }] };
    const r = evaluateDeployability(c, hypotheticalProductionContext(c, approvals));
    expect(r.deployable).toBe(false);
    expect(has(r, "MODEL_VOICE_APPROVAL_INVALID", "models.approved")).toBe(true);
    expect(has(r, "APPROVAL_MISSING", "approvals.required.MODEL_VOICE_SELECTION")).toBe(true);
    expect(has(r, "APPROVAL_SUBJECT_MISMATCH", `approvals.records.${mv}`)).toBe(true);
    // Changing only the agent configuration is also a different, unapproved subject.
    const c2 = hypotheticalProductionConfig();
    c2.models.active = { ...c2.models.active, agentConfig: "hypothetical-agent-2" };
    expect(has(evaluateDeployability(c2, hypotheticalProductionContext(c2)), "MODEL_VOICE_APPROVAL_INVALID", "models.approved")).toBe(true);
  });

  it("[OPS-04][OPS-06][OPS-APPR-01] a POLICY_RELEASE record for bundle v1 does not approve a config pinned to (and loading) bundle v2", () => {
    const c = hypotheticalProductionConfig();
    const v2 = { version: "policy-hypothetical-2", digest: "c".repeat(64) };
    c.policy = { ...c.policy, expectedVersion: v2.version, expectedDigest: v2.digest };
    const ctx = { ...hypotheticalProductionContext(c), loadedPolicy: v2 };
    const r = evaluateDeployability(c, ctx);
    expect(r.deployable).toBe(false);
    expect(has(r, "APPROVAL_MISSING", "approvals.required.POLICY_RELEASE")).toBe(true);
    expect(has(r, "APPROVAL_SUBJECT_MISMATCH", `approvals.records.${recordId(ctx.approvals, "POLICY_RELEASE")}`)).toBe(true);
    // Same digest but a different version label is still a different subject.
    const c3 = hypotheticalProductionConfig();
    c3.policy = { ...c3.policy, expectedVersion: "policy-hypothetical-relabelled" };
    const r3 = evaluateDeployability(c3, { ...hypotheticalProductionContext(c3), loadedPolicy: { version: "policy-hypothetical-relabelled", digest: POLICY.digest } });
    expect(has(r3, "APPROVAL_MISSING", "approvals.required.POLICY_RELEASE")).toBe(true);
  });

  it("[OPS-04][OPS-06][OPS-APPR-01] knowledge snapshot, template catalogue and image approvals must name the digests actually served; unknown digests fail closed", () => {
    const c = hypotheticalProductionConfig();
    const cases: [ApprovalScope, Partial<GuardContext>][] = [
      ["KNOWLEDGE_RELEASE", { knowledgeSnapshotDigest: "9".repeat(64) }],
      ["CLINICAL_SCRIPTS", { templateCatalogDigest: "9".repeat(64) }],
      ["PRODUCTION_DEPLOYMENT", { releaseImageDigest: `sha256:${"9".repeat(64)}` }],
    ];
    for (const [scope, patch] of cases) {
      const ctx = { ...hypotheticalProductionContext(c), ...patch };
      const r = evaluateDeployability(c, ctx);
      expect(r.deployable, scope).toBe(false);
      expect(has(r, "APPROVAL_MISSING", `approvals.required.${scope}`), scope).toBe(true);
      expect(has(r, "APPROVAL_SUBJECT_MISMATCH", `approvals.records.${recordId(ctx.approvals, scope)}`), scope).toBe(true);
    }
    const unknown = { ...hypotheticalProductionContext(c), knowledgeSnapshotDigest: undefined, templateCatalogDigest: null, releaseImageDigest: undefined };
    const ru = evaluateDeployability(c, unknown);
    expect(ru.deployable).toBe(false);
    for (const scope of ["KNOWLEDGE_RELEASE", "CLINICAL_SCRIPTS", "PRODUCTION_DEPLOYMENT"] as const) {
      expect(has(ru, "APPROVAL_SUBJECT_UNVERIFIABLE", `approvals.records.${recordId(unknown.approvals, scope)}`), scope).toBe(true);
    }
  });

  it("[OPS-04][OPS-APPR-01] a subject-bound approval without a signed subject never counts; subjects of another scope are refused", () => {
    const c = hypotheticalProductionConfig();
    const approvals = REQUIRED_APPROVALS_BY_ENVIRONMENT.production.map((s) => (s === "KNOWLEDGE_RELEASE" ? testOnlyApproval(s, "production", { subject: undefined }) : testOnlyApproval(s, "production")));
    const r = evaluateDeployability(c, hypotheticalProductionContext(c, approvals));
    expect(has(r, "APPROVAL_SUBJECT_MISSING", `approvals.records.${recordId(approvals, "KNOWLEDGE_RELEASE")}`)).toBe(true);
    const stray = REQUIRED_APPROVALS_BY_ENVIRONMENT.production.map((s) =>
      s === "SECURITY_REVIEW" ? testOnlyApproval(s, "production", { subject: { modelVoice: HYPO_MODEL } }) : testOnlyApproval(s, "production"),
    );
    const r2 = evaluateDeployability(c, hypotheticalProductionContext(c, stray));
    expect(has(r2, "APPROVAL_SUBJECT_UNEXPECTED", `approvals.records.${recordId(stray, "SECURITY_REVIEW")}`)).toBe(true);
    expect(r2.deployable).toBe(false);
  });

  it("[OPS-04][OPS-APPR-01] approvals signed by a role not allowed for the scope are rejected (vendor admin approving PHI, clinical scripts, security)", () => {
    const c = hypotheticalProductionConfig();
    const approvals = REQUIRED_APPROVALS_BY_ENVIRONMENT.production.map((s) => testOnlyApproval(s, "production", { approver: { name: "Test Only Vendor Admin", role: "talkdesk_admin" } }));
    const r = evaluateDeployability(c, hypotheticalProductionContext(c, approvals));
    expect(r.deployable).toBe(false);
    for (const scope of ["PHI_PROCESSING", "CLINICAL_SCRIPTS", "SECURITY_REVIEW", "RETENTION_SCHEDULE", "PRODUCTION_DEPLOYMENT"] as const) {
      expect(has(r, "APPROVAL_MISSING", `approvals.required.${scope}`), scope).toBe(true);
      expect(has(r, "APPROVAL_APPROVER_ROLE_NOT_PERMITTED", `approvals.records.${recordId(approvals, scope)}`), scope).toBe(true);
    }
    // DATA-01: still no approver names or values in violations.
    expect(r.violations.map((v) => `${v.code}@${v.path}`).join("|")).not.toContain("Vendor Admin");
  });
});

describe("sandbox guard (OPS-05)", () => {
  function hypotheticalSandbox(liveAdapter: string, approvalId: string | null): PlatformConfig {
    const c = structuredClone(load("sandbox"));
    for (const [name, a] of Object.entries(c.adapters)) {
      if (name === liveAdapter) {
        a.endpoint = `https://${name}-sandbox.hypothetical-vendor.example.com/api`;
        a.credentialRef = `arn:aws:secretsmanager:us-east-1:${HYPO_ACCOUNT}:secret:vsp-sbx-${name}`;
        a.integrationApprovalId = approvalId;
      } else {
        Object.assign(a, { kind: "local_fixture", endpoint: null, credentialRef: null, authMethod: "none" });
      }
    }
    c.approvals.trustedSigningKeyRef = `arn:aws:kms:us-east-1:${HYPO_ACCOUNT}:key/00000000-0000-0000-0000-000000000000`;
    return c;
  }
  const sandboxCtx = (approvals: ApprovalRecord[]): GuardContext => ({
    approvals,
    trustedApprovalKey: TEST_ONLY_PUBLIC_PEM,
    adapterKinds: {},
    loadedPolicy: null,
    toolCatalogDigest: null,
    now: NOW,
  });

  it("[OPS-05] sandbox guard rejects live adapters without VENDOR_SANDBOX_INTEGRATION approval", () => {
    const committed = load("sandbox");
    let error: unknown;
    try {
      assertDeployable(committed, { approvals: [], adapterKinds: {}, loadedPolicy: null, toolCatalogDigest: null, now: NOW });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigurationRejectedError);
    const v = (error as ConfigurationRejectedError).violations;
    for (const name of Object.keys(committed.adapters)) expect(v).toContain(`SANDBOX_LIVE_ADAPTER_UNAPPROVED@adapters.${name}`);
    expect(v).toContain("APPROVAL_MISSING@approvals.required.VENDOR_SANDBOX_INTEGRATION");

    const c = hypotheticalSandbox("salesforce", null);
    const r = evaluateDeployability(c, sandboxCtx([testOnlyApproval("VENDOR_SANDBOX_INTEGRATION", "sandbox")]));
    expect(r.violations).toEqual([{ code: "SANDBOX_LIVE_ADAPTER_UNAPPROVED", path: "adapters.salesforce" }]);
  });

  it("[OPS-05] an approval for another environment or scope does not authorize a sandbox integration", () => {
    const prodApproval = testOnlyApproval("VENDOR_SANDBOX_INTEGRATION", "production");
    const c = hypotheticalSandbox("salesforce", prodApproval.approvalId);
    const r = evaluateDeployability(c, sandboxCtx([prodApproval, testOnlyApproval("VENDOR_SANDBOX_INTEGRATION", "sandbox")]));
    expect(has(r, "SANDBOX_LIVE_ADAPTER_UNAPPROVED", "adapters.salesforce")).toBe(true);
  });

  it("[OPS-05] a live sandbox adapter with its own signed VENDOR_SANDBOX_INTEGRATION approval passes; fixtures remain allowed", () => {
    const approval = testOnlyApproval("VENDOR_SANDBOX_INTEGRATION", "sandbox");
    const c = hypotheticalSandbox("salesforce", approval.approvalId);
    const report = assertDeployable(c, { ...sandboxCtx([approval]), adapterKinds: { salesforce: "live", scheduling: "local_fixture" } });
    expect(report.ruleSet).toBe("sandbox");
    expect(report.violations).toEqual([]);
    expect(report.phiEndpointsPermitted).toBe(false);
  });

  it("[OPS-05] PHI is impossible in sandbox: PHI_PROCESSING scopes and PHI endpoints are rejected", () => {
    const approval = testOnlyApproval("VENDOR_SANDBOX_INTEGRATION", "sandbox");
    const c = hypotheticalSandbox("salesforce", approval.approvalId);
    const phi = testOnlyApproval("PHI_PROCESSING", "sandbox");
    const r = evaluateDeployability({ ...c, phi: { endpointsEnabled: true } }, sandboxCtx([approval, phi]));
    expect(r.violations).toEqual(
      expect.arrayContaining([
        { code: "PHI_ENDPOINTS_FORBIDDEN_IN_ENVIRONMENT", path: "phi.endpointsEnabled" },
        { code: "PHI_SCOPE_NOT_PERMITTED_IN_ENVIRONMENT", path: `approvals.records.${phi.approvalId}` },
      ]),
    );
    const c2 = { ...c, approvals: { ...c.approvals, required: [...c.approvals.required, "PHI_PROCESSING" as const] } };
    expect(has(evaluateDeployability(c2, sandboxCtx([approval])), "PHI_SCOPE_NOT_PERMITTED_IN_ENVIRONMENT", "approvals.required.PHI_PROCESSING")).toBe(true);
  });

  it("[OPS-05] a live sandbox adapter still needs a real endpoint and credential reference", () => {
    const approval = testOnlyApproval("VENDOR_SANDBOX_INTEGRATION", "sandbox");
    const c = hypotheticalSandbox("salesforce", approval.approvalId);
    const sf = c.adapters.salesforce;
    if (!sf) throw new Error("missing");
    sf.endpoint = null;
    sf.credentialRef = "arn:aws:secretsmanager:REGION:ACCOUNT:secret:PLACEHOLDER-x";
    const r = evaluateDeployability(c, sandboxCtx([approval]));
    expect(codes(r)).toEqual(expect.arrayContaining(["ADAPTER_ENDPOINT_MISSING", "ADAPTER_CREDENTIAL_PLACEHOLDER"]));
  });
});

describe("offline guard (local, ci)", () => {
  const fixtureKinds = (c: PlatformConfig) => Object.fromEntries(Object.keys(c.adapters).map((k) => [k, "local_fixture" as const]));

  it("[OPS-05] local and ci configs pass the offline rule set with labelled fixture adapters", () => {
    for (const env of ["local", "ci"] as const) {
      const c = load(env);
      const r = assertDeployable(c, { approvals: [], adapterKinds: fixtureKinds(c), loadedPolicy: null, toolCatalogDigest: null, now: NOW });
      expect(r.ruleSet).toBe("offline");
      expect(r.violations).toEqual([]);
      expect(r.phiEndpointsPermitted).toBe(false);
    }
  });

  it("[OPS-05] local rejects live adapters and PHI scopes so no PHI or paid vendor traffic is reachable offline", () => {
    const c = load("local");
    const billing = c.adapters.billing;
    if (!billing) throw new Error("missing");
    billing.kind = "live";
    const r = evaluateDeployability(
      { ...c, phi: { endpointsEnabled: true } },
      { approvals: [testOnlyApproval("PHI_PROCESSING", "local")], adapterKinds: { ...fixtureKinds(c), billing: "live" }, loadedPolicy: null, toolCatalogDigest: null, now: NOW },
    );
    expect(codes(r)).toEqual(
      expect.arrayContaining(["OFFLINE_LIVE_ADAPTER_FORBIDDEN", "PHI_ENDPOINTS_FORBIDDEN_IN_ENVIRONMENT", "PHI_SCOPE_NOT_PERMITTED_IN_ENVIRONMENT"]),
    );
  });

  it("[OPS-04] startup composition accepts local and refuses production", async () => {
    const local = load("local");
    const ok = await loadDeployableConfig({ environment: "local", clock, env: {}, adapterKinds: fixtureKinds(local), loadedPolicy: null, toolCatalogDigest: null });
    expect(ok.report.deployable).toBe(true);
    await expect(
      loadDeployableConfig({ environment: "production", clock, env: {}, adapterKinds: {}, loadedPolicy: null, toolCatalogDigest: null }),
    ).rejects.toBeInstanceOf(ConfigurationRejectedError);
  });

  it("[OPS-04] a structurally invalid config object is rejected rather than evaluated", () => {
    const c = { ...load("production"), cors: { allowedOrigins: "*" } } as unknown as PlatformConfig;
    expect(codes(evaluateDeployability(c, { approvals: [], adapterKinds: {}, loadedPolicy: null, toolCatalogDigest: null, now: NOW }))).toEqual(["CONFIG_SCHEMA_INVALID"]);
  });
});
