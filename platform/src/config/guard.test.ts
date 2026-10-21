import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { ApprovalRecord, ApprovalScope, ApprovalSubject, Environment } from "../protocol/index.js";
import { FakeClock } from "../shared/clock.js";
import { ConfigurationRejectedError, ValidationError } from "../shared/errors.js";
import { APPROVER_ROLES_BY_SCOPE, KmsRuntimeSigningKeyResolver, KmsTrustedKeyResolver, approvalSigningPayload, loadApprovalRecords } from "./approvals.js";
import type { KmsPublicKeyClient } from "./approvals.js";
import { REQUIRED_APPROVALS_BY_ENVIRONMENT, assertDeployable, evaluateDeployability, phiEndpointsPermitted } from "./guard.js";
import type { GuardContext, GuardReport } from "./guard.js";
import { secretUses } from "./rules/index.js";
import type { CommittedSigningKeys } from "./rules/index.js";
import { CONFIG_DIR, REPO_ROOT, loadPlatformConfig } from "./loader.js";
import type { PlatformConfig } from "./ports.js";
import { loadDeployableConfig, resolveRuntimeSigningPublicKeys } from "./startup.js";
import type { TrustedKeyResolver } from "./approvals.js";
import { createMemoryLogger } from "../observability/logger.js";
import { DEFAULT_WORKFORCE_SESSION } from "../console-api/sso-config.js";
import { emulatorProfile } from "../../test/integration/connectors/profiles.js";

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
  withHypotheticalLiveInputs(c);
  return c;
}

const HYPO_AUDIT_ACCOUNT = "444455556666"; // AWS documentation example account id
const hypoSecret = (env: string, name: string) => `arn:aws:secretsmanager:us-east-1:${HYPO_ACCOUNT}:secret:vsp-${env}-${name}`;
const hypoKey = (n: number) => `arn:aws:kms:us-east-1:${HYPO_ACCOUNT}:key/${String(n).repeat(8)}-${String(n).repeat(4)}-${String(n).repeat(4)}-${String(n).repeat(4)}-${String(n).repeat(12)}`;

/**
 * TEST-ONLY live inputs of a hypothetical tenant (WP-07): the infrastructure block, an egress policy listing
 * every live adapter and IdP host, and workforce SSO. Values are hypothetical (documentation account ids,
 * example.com hosts); nothing here is a recommendation.
 */
function withHypotheticalLiveInputs(c: PlatformConfig): PlatformConfig {
  const env = c.environment;
  c.database = { engine: "pg", connectionRef: hypoSecret(env, "aurora") };
  c.sessionStore = { kind: "dynamodb", tableName: `vsp-${env}-sessions` };
  c.signing = { assertionKeyRef: hypoKey(1), localDevKey: false };
  c.infrastructure = {
    aws: { region: "us-east-1", endpointOverrides: null, s3ForcePathStyle: false },
    privateNetworkHosts: [],
    // TEST-ONLY load balancer subnets (RFC 1918).
    trustedProxyCidrs: ["10.40.0.0/20", "10.40.16.0/20"],
    outbox: { queueUrl: `https://sqs.us-east-1.amazonaws.com/${HYPO_ACCOUNT}/vsp-${env}-outbox`, fifo: false, deadLetterQueueUrl: `https://sqs.us-east-1.amazonaws.com/${HYPO_ACCOUNT}/vsp-${env}-outbox-dlq` },
    routeAuditJournalTable: `vsp-${env}-route-audit-journal`,
    auditSink: { bucket: `vsp-${env}-audit-hypothetical`, expectedBucketOwner: HYPO_AUDIT_ACCOUNT, keyPrefix: "audit/", objectLockMode: "COMPLIANCE", kmsKeyId: hypoKey(2) },
    auditExport: { manifestSigningKeyId: hypoKey(3), exporterDatabaseRef: hypoSecret(env, "audit-exporter"), verifierDatabaseRef: hypoSecret(env, "audit-verifier"), trustedManifestKeyIds: [hypoKey(3)] },
    secrets: { requestHashPepperRef: hypoSecret(env, "request-hash-pepper"), otpPepperRef: hypoSecret(env, "otp-pepper"), consoleSessionSealerRef: hypoSecret(env, "console-session-sealer") },
    ingressPayloadKeyId: hypoKey(4),
  };
  const issuer = "https://sso.hypothetical-tenant.example.com/realms/workforce";
  c.consoleAuth = {
    tenantId: "tnt_HypotheticalWorkforce01",
    issuer,
    clientId: "vsp-console",
    scopes: ["openid"],
    redirectUris: ["https://console.hypothetical-tenant.example.com/console/auth/callback"],
    groupsClaim: "roles",
    membershipSource: { kind: "CLIENT_ROLES" },
    groupRoles: { "vsp-supervisor": "supervisor" },
    managedGroupPrefix: null,
    acceptedMfaAmr: null,
    maxAuthAgeSeconds: 300,
    loginTransactionTtlSeconds: 600,
    session: { ...DEFAULT_WORKFORCE_SESSION },
    sessionParametersApprovalId: "apr_TESTONLY_session_parameters",
  };
  const hostOf = (u: string) => new URL(u).host;
  c.egress = {
    policyVersion: "egress-hypothetical-1",
    destinations: [
      ...Object.entries(c.adapters)
        .filter(([, a]) => a.kind === "live" && a.endpoint)
        .map(([name, a]) => ({
          destinationId: `egr_${name.replace(/-/g, "_")}`,
          kind: "SYSTEM_OF_RECORD" as const,
          hosts: [hostOf(a.endpoint ?? "")],
          allowedClasses: ["INTERNAL" as const],
          coverage: { baaRef: null, approvalId: null },
          environments: [env],
          adapterKind: "live" as const,
        })),
      { destinationId: "egr_workforce_idp", kind: "VERIFICATION_SERVICE", hosts: [hostOf(issuer)], allowedClasses: ["INTERNAL"], coverage: { baaRef: null, approvalId: null }, environments: [env], adapterKind: "live" },
    ],
  };
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
      rulesEvaluated: report.rulesEvaluated,
      violationCount: report.violations.length,
      blockingCount: report.blocking.length,
      violations: report.violations.map((v) => `${v.code}@${v.path}`),
      notConfiguredCapabilities: report.notConfiguredCapabilities,
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
    return withHypotheticalLiveInputs(c);
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

  it("[OPS-05][FO-19-06] a live sandbox adapter with its own signed VENDOR_SANDBOX_INTEGRATION approval passes; a DECLARED fixture is NOT_CONFIGURED, an INSTANTIATED fixture is refused", () => {
    const approval = testOnlyApproval("VENDOR_SANDBOX_INTEGRATION", "sandbox");
    const c = hypotheticalSandbox("salesforce", approval.approvalId);
    const report = assertDeployable(c, { ...sandboxCtx([approval]), adapterKinds: { salesforce: "live" } });
    expect(report.ruleSet).toBe("sandbox");
    expect(report.violations).toEqual([]);
    expect(report.phiEndpointsPermitted).toBe(false);
    // Declared local_fixture components are not composed: their capabilities are NOT_CONFIGURED, not refused.
    expect(report.components.find((x) => x.component === "salesforce")).toMatchObject({ capabilityId: "crm.salesforce", state: "CONFIGURED" });
    expect(report.components.find((x) => x.component === "scheduling")).toMatchObject({ capabilityId: "domain.business_systems", state: "NOT_CONFIGURED", reasons: ["ADAPTER_NOT_DECLARED_LIVE@adapters.scheduling"] });
    expect(report.notConfiguredCapabilities).not.toContain("crm.salesforce");
    expect(report.notConfiguredCapabilities).toContain("domain.business_systems");
    // A fixture the composition actually instantiated is refused in sandbox (FO-19-06: real adapters or none).
    const withFixture = evaluateDeployability(c, { ...sandboxCtx([approval]), adapterKinds: { salesforce: "live", scheduling: "local_fixture" } });
    expect(withFixture.deployable).toBe(false);
    expect(withFixture.blocking).toEqual([{ code: "SANDBOX_RUNTIME_LOCAL_FIXTURE", path: "runtime.scheduling" }]);
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

describe("per-capability gating (WP-07; FO-00-26, FO-00-30, FO-19-06, FO-14-53)", () => {
  it("[FO-00-30][OPS-04] a missing tenant input disables only its capability; the environment stays deployable and the report says which", () => {
    const c = hypotheticalProductionConfig();
    const sf = c.adapters.salesforce;
    if (!sf) throw new Error("missing");
    sf.endpoint = null;
    sf.credentialRef = "arn:aws:secretsmanager:REGION:ACCOUNT:secret:PLACEHOLDER-sf";
    const r = assertDeployable(c, hypotheticalProductionContext(c));
    expect(r.deployable).toBe(true);
    expect(r.blocking).toEqual([]);
    expect(r.capabilityViolations).toEqual([
      { capabilityId: "crm.salesforce", component: "salesforce", code: "ADAPTER_ENDPOINT_MISSING", path: "adapters.salesforce.endpoint" },
      { capabilityId: "crm.salesforce", component: "salesforce", code: "ADAPTER_CREDENTIAL_PLACEHOLDER", path: "adapters.salesforce.credentialRef" },
    ]);
    expect(r.notConfiguredCapabilities).toEqual(["crm.salesforce"]);
    expect(r.components.filter((x) => x.state === "NOT_CONFIGURED").map((x) => x.component)).toEqual(["salesforce"]);
    expect(r.components.find((x) => x.component === "scheduling")?.state).toBe("CONFIGURED");
    // Reported (never silently dropped), and PHI stays impossible while any violation exists.
    expect(has(r, "ADAPTER_ENDPOINT_MISSING", "adapters.salesforce.endpoint")).toBe(true);
    expect(phiEndpointsPermitted(assertDeployable({ ...c, phi: { endpointsEnabled: true } }, hypotheticalProductionContext(c)))).toBe(false);
    // DATA-01: codes and paths only.
    expect(JSON.stringify(r.components)).not.toContain("arn:aws");
  });

  it("[FO-19-06][OPS-04] adversarial: fixtures and missing mandatory data still refuse staging/production (a capability violation never masks them)", () => {
    const c = hypotheticalProductionConfig();
    const billing = c.adapters.billing;
    if (!billing) throw new Error("missing");
    billing.kind = "local_fixture";
    delete c.infrastructure;
    c.database.engine = "pglite";
    const ctx = hypotheticalProductionContext(c);
    ctx.adapterKinds.billing = "local_fixture";
    const r = evaluateDeployability(c, ctx);
    expect(r.deployable).toBe(false);
    expect(r.blocking).toEqual(
      expect.arrayContaining([
        { code: "ADAPTER_LOCAL_FIXTURE", path: "adapters.billing" },
        { code: "ADAPTER_RUNTIME_LOCAL_FIXTURE", path: "runtime.billing" },
        { code: "INFRASTRUCTURE_NOT_CONFIGURED", path: "infrastructure" },
        { code: "DATABASE_ENGINE_PGLITE", path: "database.engine" },
      ]),
    );
    // Missing egress policy: nothing may leave, refused.
    const c2 = hypotheticalProductionConfig();
    delete c2.egress;
    expect(evaluateDeployability(c2, hypotheticalProductionContext(c2)).blocking).toEqual([{ code: "EGRESS_POLICY_NOT_CONFIGURED", path: "egress" }]);
  });

  it("[FO-14-53] no development bypass in staging/production: AWS endpoint overrides are refused there and accepted in sandbox for emulator hosts only", () => {
    const overrides = { dynamodb: "http://localhost:8000", sqs: null, s3: "http://minio.vsp.test:9000", kms: null, secretsManager: null, sts: null };
    for (const env of ["staging", "production"] as const) {
      const c = hypotheticalProductionConfig();
      c.environment = env;
      if (!c.infrastructure) throw new Error("missing");
      c.infrastructure.aws = { ...c.infrastructure.aws, endpointOverrides: overrides, s3ForcePathStyle: true };
      const r = evaluateDeployability(c, hypotheticalProductionContext(c));
      expect(r.deployable, env).toBe(false);
      expect(has(r, "INFRASTRUCTURE_ENDPOINT_OVERRIDE_FORBIDDEN", "infrastructure.aws.endpointOverrides.dynamodb"), env).toBe(true);
      expect(has(r, "INFRASTRUCTURE_ENDPOINT_OVERRIDE_FORBIDDEN", "infrastructure.aws.endpointOverrides.s3"), env).toBe(true);
      expect(has(r, "INFRASTRUCTURE_S3_PATH_STYLE_OUTSIDE_EMULATOR", "infrastructure.aws.s3ForcePathStyle"), env).toBe(true);
    }
    const approval = testOnlyApproval("VENDOR_SANDBOX_INTEGRATION", "sandbox");
    const sbx = withHypotheticalLiveInputs(structuredClone(load("sandbox")));
    for (const a of Object.values(sbx.adapters)) Object.assign(a, { kind: "local_fixture", endpoint: null, credentialRef: null, authMethod: "none" });
    sbx.approvals.trustedSigningKeyRef = `arn:aws:kms:us-east-1:${HYPO_ACCOUNT}:key/00000000-0000-0000-0000-000000000000`;
    if (!sbx.infrastructure) throw new Error("missing");
    sbx.infrastructure.aws = { ...sbx.infrastructure.aws, endpointOverrides: overrides, s3ForcePathStyle: true };
    const ok = evaluateDeployability(sbx, { approvals: [approval], trustedApprovalKey: TEST_ONLY_PUBLIC_PEM, adapterKinds: {}, loadedPolicy: null, toolCatalogDigest: null, now: NOW });
    expect(ok.blocking).toEqual([]);
    sbx.infrastructure.aws.endpointOverrides = { ...overrides, kms: "https://kms.us-east-1.amazonaws.example.com" };
    const bad = evaluateDeployability(sbx, { approvals: [approval], trustedApprovalKey: TEST_ONLY_PUBLIC_PEM, adapterKinds: {}, loadedPolicy: null, toolCatalogDigest: null, now: NOW });
    expect(bad.blocking).toEqual([{ code: "INFRASTRUCTURE_ENDPOINT_OVERRIDE_NOT_EMULATOR", path: "infrastructure.aws.endpointOverrides.kms" }]);
  });

  it("[AUTH-02][OPS-04] the audit exporter and verifier run under identities separate from the runtime and from each other", () => {
    const c = hypotheticalProductionConfig();
    if (!c.infrastructure?.auditExport) throw new Error("missing");
    c.infrastructure.auditExport.verifierDatabaseRef = c.infrastructure.auditExport.exporterDatabaseRef;
    expect(evaluateDeployability(c, hypotheticalProductionContext(c)).blocking).toEqual([{ code: "AUDIT_EXPORT_IDENTITY_SHARED", path: "infrastructure.auditExport.verifierDatabaseRef" }]);
    const c2 = hypotheticalProductionConfig();
    if (!c2.infrastructure?.auditExport) throw new Error("missing");
    c2.infrastructure.auditExport.exporterDatabaseRef = c2.database.connectionRef ?? "";
    expect(has(evaluateDeployability(c2, hypotheticalProductionContext(c2)), "AUDIT_EXPORT_IDENTITY_SHARED", "infrastructure.auditExport.exporterDatabaseRef")).toBe(true);
    // A missing export block disables only the independent audit capability.
    const c3 = hypotheticalProductionConfig();
    if (!c3.infrastructure) throw new Error("missing");
    c3.infrastructure.auditExport = null;
    const r3 = evaluateDeployability(c3, hypotheticalProductionContext(c3));
    expect(r3.deployable).toBe(true);
    expect(r3.notConfiguredCapabilities).toEqual(["audit.independent"]);
  });

  it("[FO-03-30][DATA-01] a telemetry endpoint must be an allowlisted TELEMETRY_EXPORTER destination and routable outside sandbox", () => {
    const c = hypotheticalProductionConfig();
    c.observability = { contentAttributes: "DISABLED", otlp: { metricsUrl: "https://otel.hypothetical-tenant.example.com/v1/metrics", tracesUrl: null, exportIntervalMs: 60_000, timeoutMs: 5_000 } };
    expect(evaluateDeployability(c, hypotheticalProductionContext(c)).blocking).toEqual([{ code: "TELEMETRY_ENDPOINT_NOT_ALLOWLISTED", path: "observability.otlp.metricsUrl" }]);
    c.egress?.destinations.push({ destinationId: "egr_otel_collector", kind: "SYSTEM_OF_RECORD", hosts: ["otel.hypothetical-tenant.example.com"], allowedClasses: ["INTERNAL"], coverage: { baaRef: null, approvalId: null }, environments: ["production"], adapterKind: "live" });
    expect(evaluateDeployability(c, hypotheticalProductionContext(c)).blocking).toEqual([{ code: "TELEMETRY_ENDPOINT_NOT_TELEMETRY_DESTINATION", path: "observability.otlp.metricsUrl" }]);
    const last = c.egress?.destinations.at(-1);
    if (last) last.kind = "TELEMETRY_EXPORTER";
    const ok = evaluateDeployability(c, hypotheticalProductionContext(c));
    expect(ok.violations).toEqual([]);
  });

  it("[FO-03-49][OPS-04] workforce SSO problems disable identity.workforce and the console only", () => {
    const c = hypotheticalProductionConfig();
    delete c.consoleAuth;
    const r = evaluateDeployability(c, hypotheticalProductionContext(c));
    expect(r.deployable).toBe(true);
    expect(r.notConfiguredCapabilities).toEqual(["identity.workforce", "operator.console"]);
    expect(r.capabilityViolations.map((x) => `${x.capabilityId}:${x.code}@${x.path}`)).toEqual(["identity.workforce:WORKFORCE_SSO_NOT_CONFIGURED@consoleAuth", "operator.console:WORKFORCE_SSO_NOT_CONFIGURED@consoleAuth"]);
    const c2 = hypotheticalProductionConfig();
    if (!c2.consoleAuth) throw new Error("missing");
    c2.consoleAuth.sessionParametersApprovalId = null;
    expect(evaluateDeployability(c2, hypotheticalProductionContext(c2)).notConfiguredCapabilities).toEqual(["identity.workforce", "operator.console"]);
    // A workforce issuer that the egress policy does not list is not reachable: NOT_CONFIGURED too.
    const c3 = hypotheticalProductionConfig();
    if (c3.egress) c3.egress.destinations = c3.egress.destinations.filter((d) => d.destinationId !== "egr_workforce_idp");
    expect(evaluateDeployability(c3, hypotheticalProductionContext(c3)).capabilityViolations).toEqual([
      { capabilityId: "identity.workforce", component: "workforce-sso", code: "WORKFORCE_ISSUER_NOT_ALLOWLISTED", path: "consoleAuth.issuer" },
    ]);
  });

  it("[AUTH-02] connector credential reuse refuses the environment (separation failure, not a missing input)", () => {
    const c = hypotheticalProductionConfig();
    const shared = hypoSecret("production", "salesforce");
    const ctx: GuardContext = {
      ...hypotheticalProductionContext(c),
      connectorCredentialSets: [
        { environment: "production", profiles: [], adapterCredentialRefs: { salesforce: shared } },
        { environment: "staging", profiles: [], adapterCredentialRefs: { salesforce: shared } },
      ],
    };
    const r = evaluateDeployability(c, ctx);
    expect(r.deployable).toBe(false);
    expect(r.blocking).toEqual([{ code: "CREDENTIAL_REUSED_ACROSS_ENVIRONMENTS", path: "connectors.credentials.staging.adapter:salesforce" }]);
    expect(JSON.stringify(r.violations)).not.toContain("arn:aws");
  });

  it("[OPS-04][STRIDE-D] gateway rate limiting cannot be switched off outside local/ci (gateway.http.rateLimit: null is refused); an absent block keeps the composition's default", () => {
    const c = hypotheticalProductionConfig();
    (c as unknown as Record<string, unknown>).gateway = { inboundAuth: null, http: { bodyLimitBytes: 65_536, rateLimit: null } };
    expect(evaluateDeployability(c, hypotheticalProductionContext(c)).blocking).toEqual([{ code: "GATEWAY_RATE_LIMIT_DISABLED", path: "gateway.http.rateLimit" }]);
    (c as unknown as Record<string, unknown>).gateway = { inboundAuth: null, http: { bodyLimitBytes: 65_536, rateLimit: { max: 600, timeWindowMs: 60_000 } } };
    expect(evaluateDeployability(c, hypotheticalProductionContext(c)).violations).toEqual([]);
    delete (c as unknown as Record<string, unknown>).gateway;
    expect(evaluateDeployability(c, hypotheticalProductionContext(c)).violations).toEqual([]);
    // The regression rule set (local/ci) keeps the test convenience.
    const local = structuredClone(load("local")) as unknown as Record<string, unknown>;
    local.gateway = { inboundAuth: null, http: { bodyLimitBytes: 65_536, rateLimit: null } };
    const r = evaluateDeployability(local as unknown as PlatformConfig, { approvals: [], adapterKinds: {}, loadedPolicy: null, toolCatalogDigest: null, now: NOW });
    expect(r.violations.map((v) => v.code)).not.toContain("GATEWAY_RATE_LIMIT_DISABLED");
  });

  it("[OPS-01][STRIDE-D] trusted proxy ranges: private ranges only; without them staging/production make the console NOT_CONFIGURED (one shared balancer address would let one client lock out every operator)", () => {
    const c = hypotheticalProductionConfig();
    if (!c.infrastructure) throw new Error("missing");
    c.infrastructure.trustedProxyCidrs = [];
    const r = evaluateDeployability(c, hypotheticalProductionContext(c));
    expect(r.deployable).toBe(true);
    expect(r.notConfiguredCapabilities).toEqual(["operator.console"]);
    expect(r.capabilityViolations).toEqual([{ capabilityId: "operator.console", component: "console-edge", code: "CONSOLE_TRUSTED_PROXY_NOT_CONFIGURED", path: "infrastructure.trustedProxyCidrs" }]);
    for (const [cidr, code] of [
      ["0.0.0.0/0", "TRUSTED_PROXY_CIDR_NOT_PRIVATE"],
      ["8.8.8.0/24", "TRUSTED_PROXY_CIDR_NOT_PRIVATE"],
      ["10.0.0.0/7", "TRUSTED_PROXY_CIDR_NOT_PRIVATE"],
      ["2001:db8::/32", "TRUSTED_PROXY_CIDR_NOT_PRIVATE"],
      ["10.0.0.1/8", "TRUSTED_PROXY_CIDR_INVALID"],
      ["10.0.0.0/33", "TRUSTED_PROXY_CIDR_INVALID"],
    ] as const) {
      c.infrastructure.trustedProxyCidrs = [cidr];
      expect(evaluateDeployability(c, hypotheticalProductionContext(c)).blocking, cidr).toEqual([{ code, path: "infrastructure.trustedProxyCidrs.0" }]);
    }
    c.infrastructure.trustedProxyCidrs = ["fd00:10::/48", "192.168.4.0/24"];
    expect(evaluateDeployability(c, hypotheticalProductionContext(c)).violations).toEqual([]);
  });

  it("[OPS-04] the offline regression rule set has no activation map (fixtures are the regression composition) and reports the rules it ran", () => {
    const c = load("local");
    const r = evaluateDeployability(c, { approvals: [], adapterKinds: {}, loadedPolicy: null, toolCatalogDigest: null, now: NOW });
    expect(r.components).toEqual([]);
    expect(r.rulesEvaluated).toEqual(["universal", "offline", "connector-credentials", "approvals"]);
    const p = evaluateDeployability(hypotheticalProductionConfig(), hypotheticalProductionContext(hypotheticalProductionConfig()));
    expect(p.rulesEvaluated).toEqual(["universal", "console-workforce", "full", "mandatory-data", "cors-and-binding", "gateway-limits", "infrastructure", "key-separation", "egress", "observability", "connector-credentials", "approvals"]);
  });
});

describe("approval trust outside production (FO-14-56)", () => {
  it("[FO-14-56][OPS-04] sandbox verifies approvals against a KMS key only: a repository PEM or local fixture trust reference is refused", () => {
    for (const ref of ["file:approvals/keys/demo-public.pem", "local-fixture:approval-trust"]) {
      const c = withHypotheticalLiveInputs(structuredClone(load("sandbox")));
      c.approvals.trustedSigningKeyRef = ref;
      const r = evaluateDeployability(c, { approvals: [], trustedApprovalKey: TEST_ONLY_PUBLIC_PEM, adapterKinds: {}, loadedPolicy: null, toolCatalogDigest: null, now: NOW });
      expect(r.deployable, ref).toBe(false);
      expect(has(r, "APPROVAL_TRUST_KEY_REF_NOT_KMS", "approvals.trustedSigningKeyRef"), ref).toBe(true);
    }
  });
});

describe("key and secret separation (WP-07; FO-14-56, AUTH-02, FT-91)", () => {
  const TRUST = `arn:aws:kms:us-east-1:${HYPO_ACCOUNT}:key/00000000-0000-0000-0000-000000000000`;
  const keyIdOf = (arn: string) => arn.slice(arn.indexOf("key/") + 4);
  const blockingOf = (c: PlatformConfig, ctx: GuardContext = hypotheticalProductionContext(c)) => evaluateDeployability(c, ctx).blocking;
  const sep = (r: GuardReport) =>
    r.blocking.filter((v) => /^(APPROVAL_TRUST_KEY_IS_|AUDIT_MANIFEST_KEY_IS_|ASSERTION_KEY_IS_APPROVAL_TRUST_KEY|SIGNING_KEY_REUSED_ACROSS_ENVIRONMENTS|SECRET_REUSED_ACROSS_|KMS_SIGNING_KEY_REF_IS_ALIAS)/.test(v.code));
  /** A committed entry of another environment: hypothetical keys 5 and 6, anchor 7, its own secrets (none shared). */
  const otherEnv = (o: Partial<CommittedSigningKeys> = {}): CommittedSigningKeys => ({
    environment: "staging",
    assertionKeyRef: hypoKey(5),
    manifestSigningKeyId: hypoKey(6),
    trustedManifestKeyIds: [hypoKey(6)],
    approvalTrustKeyRef: hypoKey(7),
    secrets: secretUses(withHypotheticalLiveInputs({ ...structuredClone(load("staging")), environment: "staging" })),
    ...o,
  });
  const withOther = (c: PlatformConfig, o: Partial<CommittedSigningKeys> = {}): GuardContext => ({ ...hypotheticalProductionContext(c), committedSigningKeys: [otherEnv(o)] });

  it("[FO-14-56][AUTH-02] control: the hypothetical production configuration keeps every key and secret apart and passes", () => {
    const c = hypotheticalProductionConfig();
    expect(c.approvals.trustedSigningKeyRef).toBe(TRUST);
    const r = evaluateDeployability(c, hypotheticalProductionContext(c));
    expect(r.violations).toEqual([]);
    expect(r.approvals.every((a) => a.status === "VALID")).toBe(true);
  });

  it("[FO-14-56][AUTH-02] adversarial: the approval trust anchor equal to the runtime assertion key refuses the environment, and no approval verifies (a record the runtime could mint is never VALID)", () => {
    const c = hypotheticalProductionConfig();
    c.approvals.trustedSigningKeyRef = c.signing.assertionKeyRef;
    const r = evaluateDeployability(c, hypotheticalProductionContext(c));
    expect(r.deployable).toBe(false);
    expect(sep(r)).toEqual([{ code: "APPROVAL_TRUST_KEY_IS_ASSERTION_KEY", path: "approvals.trustedSigningKeyRef" }]);
    // The key resolved and every record is correctly signed for it: still nothing counts.
    expect(r.approvals.length).toBeGreaterThan(0);
    expect(r.approvals.every((a) => a.status === "UNVERIFIED_NO_TRUST_KEY")).toBe(true);
    expect(r.requiredApprovals.every((x) => x.satisfiedBy === null)).toBe(true);
    // Not reported as an unresolvable key: the reason is the separation failure.
    expect(codes(r)).not.toContain("APPROVAL_TRUST_KEY_UNRESOLVED");
    // Normalized: the same key under another region's ARN (a multi-region replica shares the key id and material).
    const c2 = hypotheticalProductionConfig();
    c2.signing.assertionKeyRef = TRUST.replace("us-east-1", "eu-west-1");
    expect(sep(evaluateDeployability(c2, hypotheticalProductionContext(c2)))).toEqual([{ code: "APPROVAL_TRUST_KEY_IS_ASSERTION_KEY", path: "approvals.trustedSigningKeyRef" }]);
  });

  it("[FO-14-56][AUTH-02] adversarial: the trust anchor equal to the audit manifest signing key or to any trusted manifest key (ARN or bare key id, any case) refuses the environment", () => {
    const c = hypotheticalProductionConfig();
    if (!c.infrastructure?.auditExport) throw new Error("missing");
    c.infrastructure.auditExport.manifestSigningKeyId = keyIdOf(TRUST);
    c.infrastructure.auditExport.trustedManifestKeyIds = [keyIdOf(TRUST)];
    expect(sep(evaluateDeployability(c, hypotheticalProductionContext(c)))).toEqual([{ code: "APPROVAL_TRUST_KEY_IS_MANIFEST_KEY", path: "approvals.trustedSigningKeyRef" }]);
    const c2 = hypotheticalProductionConfig();
    if (!c2.infrastructure?.auditExport) throw new Error("missing");
    // A key id with letters, in another region's ARN and upper case: the same key.
    c2.approvals.trustedSigningKeyRef = `arn:aws:kms:us-east-1:${HYPO_ACCOUNT}:key/abcdef01-2345-6789-abcd-ef0123456789`;
    c2.infrastructure.auditExport.trustedManifestKeyIds = [hypoKey(3), `arn:aws:kms:us-west-2:${HYPO_ACCOUNT}:key/ABCDEF01-2345-6789-ABCD-EF0123456789`];
    const r2 = evaluateDeployability(c2, hypotheticalProductionContext(c2));
    expect(sep(r2)).toEqual([{ code: "APPROVAL_TRUST_KEY_IS_MANIFEST_KEY", path: "approvals.trustedSigningKeyRef" }]);
    expect(r2.approvals.every((a) => a.status === "UNVERIFIED_NO_TRUST_KEY")).toBe(true);
  });

  it("[AUTH-02][OPS-01] adversarial: an audit manifest key equal to the runtime assertion key refuses the environment (the runtime could forge export manifests)", () => {
    const c = hypotheticalProductionConfig();
    if (!c.infrastructure?.auditExport) throw new Error("missing");
    const assertion = c.signing.assertionKeyRef ?? "";
    c.infrastructure.auditExport.manifestSigningKeyId = assertion;
    c.infrastructure.auditExport.trustedManifestKeyIds = [assertion];
    expect(sep(evaluateDeployability(c, hypotheticalProductionContext(c)))).toEqual([
      { code: "AUDIT_MANIFEST_KEY_IS_ASSERTION_KEY", path: "infrastructure.auditExport.manifestSigningKeyId" },
      { code: "AUDIT_MANIFEST_KEY_IS_ASSERTION_KEY", path: "infrastructure.auditExport.trustedManifestKeyIds.0" },
    ]);
    // Only a trusted (verification) key equal to the assertion key, by its bare id: still refused.
    const c2 = hypotheticalProductionConfig();
    if (!c2.infrastructure?.auditExport) throw new Error("missing");
    c2.infrastructure.auditExport.trustedManifestKeyIds = [hypoKey(3), keyIdOf(assertion)];
    expect(sep(evaluateDeployability(c2, hypotheticalProductionContext(c2)))).toEqual([{ code: "AUDIT_MANIFEST_KEY_IS_ASSERTION_KEY", path: "infrastructure.auditExport.trustedManifestKeyIds.1" }]);
  });

  it("[AUTH-02][DATA-01] adversarial: the console session sealer, the request-hash pepper and the OTP pepper are three different secrets (a full ARN matches the partial ARN of the same secret)", () => {
    const fresh = () => {
      const c = hypotheticalProductionConfig();
      if (!c.infrastructure) throw new Error("missing");
      return { c, s: c.infrastructure.secrets };
    };
    const a = fresh();
    a.s.consoleSessionSealerRef = a.s.requestHashPepperRef;
    expect(sep(evaluateDeployability(a.c, hypotheticalProductionContext(a.c)))).toEqual([{ code: "SECRET_REUSED_ACROSS_PURPOSES", path: "infrastructure.secrets.consoleSessionSealerRef" }]);
    const b = fresh();
    b.s.consoleSessionSealerRef = `${b.s.otpPepperRef ?? ""}-Ab12Cd`;
    expect(sep(evaluateDeployability(b.c, hypotheticalProductionContext(b.c)))).toEqual([{ code: "SECRET_REUSED_ACROSS_PURPOSES", path: "infrastructure.secrets.consoleSessionSealerRef" }]);
    const d = fresh();
    d.s.otpPepperRef = `${d.s.requestHashPepperRef ?? ""}-Zz98Yx`;
    expect(sep(evaluateDeployability(d.c, hypotheticalProductionContext(d.c)))).toEqual([{ code: "SECRET_REUSED_ACROSS_PURPOSES", path: "infrastructure.secrets.otpPepperRef" }]);
    // Different names that only share a prefix stay different (the suffix is ignored on one side only).
    const e = fresh();
    e.s.requestHashPepperRef = hypoSecret("production", "pepper-prod01");
    e.s.otpPepperRef = hypoSecret("production", "pepper-test01");
    expect(sep(evaluateDeployability(e.c, hypotheticalProductionContext(e.c)))).toEqual([]);
    // The same name in another account is another secret.
    const f = fresh();
    f.s.consoleSessionSealerRef = (f.s.requestHashPepperRef ?? "").replace(HYPO_ACCOUNT, HYPO_AUDIT_ACCOUNT);
    expect(sep(evaluateDeployability(f.c, hypotheticalProductionContext(f.c)))).toEqual([]);
  });

  it("[FO-14-56][AUTH-02] adversarial: the trust anchor equal to a runtime signing key of ANOTHER committed environment configuration refuses the environment", () => {
    const c = hypotheticalProductionConfig();
    const other = (o: Partial<{ assertionKeyRef: string | null; manifestSigningKeyId: string | null; trustedManifestKeyIds: string[] }>) => ({
      ...hypotheticalProductionContext(c),
      committedSigningKeys: [{ environment: "staging" as const, assertionKeyRef: hypoKey(5), manifestSigningKeyId: hypoKey(6), trustedManifestKeyIds: [hypoKey(6)], ...o }],
    });
    expect(blockingOf(c, other({}))).toEqual([]);
    expect(sep(evaluateDeployability(c, other({ assertionKeyRef: keyIdOf(TRUST) })))).toEqual([{ code: "APPROVAL_TRUST_KEY_IS_ASSERTION_KEY", path: "environments.staging.signing.assertionKeyRef" }]);
    expect(sep(evaluateDeployability(c, other({ manifestSigningKeyId: TRUST })))).toEqual([{ code: "APPROVAL_TRUST_KEY_IS_MANIFEST_KEY", path: "environments.staging.infrastructure.auditExport.manifestSigningKeyId" }]);
    expect(sep(evaluateDeployability(c, other({ trustedManifestKeyIds: [hypoKey(6), TRUST] })))).toEqual([{ code: "APPROVAL_TRUST_KEY_IS_MANIFEST_KEY", path: "environments.staging.infrastructure.auditExport.trustedManifestKeyIds.1" }]);
    const shared = evaluateDeployability(c, other({ assertionKeyRef: TRUST }));
    expect(shared.approvals.every((a) => a.status === "UNVERIFIED_NO_TRUST_KEY")).toBe(true);
    // The environment's own entry is compared through its own configuration, never twice.
    expect(blockingOf(c, { ...hypotheticalProductionContext(c), committedSigningKeys: [{ environment: "production", assertionKeyRef: TRUST, manifestSigningKeyId: null, trustedManifestKeyIds: [] }] })).toEqual([]);
  });

  it("[FO-14-56][AUTH-02] signing keys are referenced by key, never by alias (which key an alias names is not visible in configuration)", () => {
    const c = hypotheticalProductionConfig();
    c.signing.assertionKeyRef = `arn:aws:kms:us-east-1:${HYPO_ACCOUNT}:alias/vsp-production-assertions`;
    if (!c.infrastructure?.auditExport) throw new Error("missing");
    c.infrastructure.auditExport.manifestSigningKeyId = "alias/vsp-production-manifests";
    c.infrastructure.auditExport.trustedManifestKeyIds = ["alias/vsp-production-manifests"];
    expect(sep(evaluateDeployability(c, hypotheticalProductionContext(c)))).toEqual([
      { code: "KMS_SIGNING_KEY_REF_IS_ALIAS", path: "signing.assertionKeyRef" },
      { code: "KMS_SIGNING_KEY_REF_IS_ALIAS", path: "infrastructure.auditExport.manifestSigningKeyId" },
      { code: "KMS_SIGNING_KEY_REF_IS_ALIAS", path: "infrastructure.auditExport.trustedManifestKeyIds.0" },
    ]);
  });

  it("[FO-14-56][OPS-05] the sandbox rule set applies the same separation; the offline regression rule set (local fixture keys) does not run it", () => {
    const sbx = withHypotheticalLiveInputs(structuredClone(load("sandbox")));
    for (const a of Object.values(sbx.adapters)) Object.assign(a, { kind: "local_fixture", endpoint: null, credentialRef: null, authMethod: "none" });
    sbx.approvals.trustedSigningKeyRef = sbx.signing.assertionKeyRef;
    const approval = testOnlyApproval("VENDOR_SANDBOX_INTEGRATION", "sandbox");
    const r = evaluateDeployability(sbx, { approvals: [approval], trustedApprovalKey: TEST_ONLY_PUBLIC_PEM, adapterKinds: {}, loadedPolicy: null, toolCatalogDigest: null, now: NOW });
    expect(r.blocking).toEqual([
      { code: "APPROVAL_TRUST_KEY_IS_ASSERTION_KEY", path: "approvals.trustedSigningKeyRef" },
      { code: "APPROVAL_MISSING", path: "approvals.required.VENDOR_SANDBOX_INTEGRATION" },
      { code: "APPROVAL_UNVERIFIED_NO_TRUST_KEY", path: `approvals.records.${approval.approvalId}` },
    ]);
    expect(r.approvals.map((a) => a.status)).toEqual(["UNVERIFIED_NO_TRUST_KEY"]);
    sbx.approvals.trustedSigningKeyRef = TRUST;
    const ok = evaluateDeployability(sbx, { approvals: [approval], trustedApprovalKey: TEST_ONLY_PUBLIC_PEM, adapterKinds: {}, loadedPolicy: null, toolCatalogDigest: null, now: NOW });
    expect(ok.blocking).toEqual([]);
    expect(ok.approvals.map((a) => a.status)).toEqual(["VALID"]);
    const local = load("local");
    expect(evaluateDeployability(local, { approvals: [], adapterKinds: {}, loadedPolicy: null, toolCatalogDigest: null, now: NOW }).rulesEvaluated).not.toContain("key-separation");
  });

  it("[AUTH-02][DATA-01] adversarial: every secret serves one purpose: the sealer or a pepper equal to the database login, the exporter or verifier login, or an adapter credential (and an adapter credential equal to the database login) each refuse the environment", () => {
    const fresh = () => {
      const c = hypotheticalProductionConfig();
      if (!c.infrastructure?.auditExport) throw new Error("missing");
      return { c, s: c.infrastructure.secrets, ex: c.infrastructure.auditExport };
    };
    const cases: [string, (x: ReturnType<typeof fresh>) => void, string][] = [
      ["sealer == database login", (x) => void (x.s.consoleSessionSealerRef = x.c.database.connectionRef), "infrastructure.secrets.consoleSessionSealerRef"],
      ["request-hash pepper == database login", (x) => void (x.s.requestHashPepperRef = x.c.database.connectionRef), "infrastructure.secrets.requestHashPepperRef"],
      ["OTP pepper == database login (full ARN of the partial reference)", (x) => void (x.s.otpPepperRef = `${x.c.database.connectionRef ?? ""}-Qw12Er`), "infrastructure.secrets.otpPepperRef"],
      // The later path of the pair (configuration order: database login, peppers, sealer, exporter, verifier, adapters).
      ["sealer == audit exporter login", (x) => void (x.s.consoleSessionSealerRef = x.ex.exporterDatabaseRef), "infrastructure.auditExport.exporterDatabaseRef"],
      ["sealer == audit verifier login", (x) => void (x.s.consoleSessionSealerRef = x.ex.verifierDatabaseRef), "infrastructure.auditExport.verifierDatabaseRef"],
      ["request-hash pepper == audit exporter login", (x) => void (x.ex.exporterDatabaseRef = x.s.requestHashPepperRef ?? ""), "infrastructure.auditExport.exporterDatabaseRef"],
      ["OTP pepper == an adapter credential", (x) => void (x.s.otpPepperRef = x.c.adapters.scheduling?.credentialRef ?? null), "adapters.scheduling.credentialRef"],
      ["an adapter credential == database login", (x) => void ((x.c.adapters.billing ?? { credentialRef: null }).credentialRef = x.c.database.connectionRef), "adapters.billing.credentialRef"],
    ];
    for (const [label, mutate, path] of cases) {
      const x = fresh();
      mutate(x);
      const r = evaluateDeployability(x.c, hypotheticalProductionContext(x.c));
      expect(sep(r), label).toEqual([{ code: "SECRET_REUSED_ACROSS_PURPOSES", path }]);
      expect(r.deployable, label).toBe(false);
    }
  });

  it("[AUTH-02] pairs another rule reports are left to it: two adapter credentials (connector credential rule, which compares this environment's configured adapters even without supplied sets) and the database logins (AUDIT_EXPORT_IDENTITY_SHARED, compared by secret identity)", () => {
    const a = hypotheticalProductionConfig();
    (a.adapters.billing ?? { credentialRef: null }).credentialRef = a.adapters.scheduling?.credentialRef ?? null;
    const ra = evaluateDeployability(a, hypotheticalProductionContext(a));
    expect(sep(ra)).toEqual([]);
    expect(ra.blocking).toEqual([{ code: "CREDENTIAL_REUSED_ACROSS_CONNECTORS", path: "connectors.credentials.production.adapter:billing" }]);
    const b = hypotheticalProductionConfig();
    if (!b.infrastructure?.auditExport) throw new Error("missing");
    // The full ARN (six-character suffix) of the runtime login's partial reference: the same secret.
    b.infrastructure.auditExport.exporterDatabaseRef = `${b.database.connectionRef ?? ""}-Ab12Cd`;
    const rb = evaluateDeployability(b, hypotheticalProductionContext(b));
    expect(rb.blocking).toEqual([{ code: "AUDIT_EXPORT_IDENTITY_SHARED", path: "infrastructure.auditExport.exporterDatabaseRef" }]);
    const c = hypotheticalProductionConfig();
    if (!c.infrastructure?.auditExport) throw new Error("missing");
    c.infrastructure.auditExport.verifierDatabaseRef = `${c.infrastructure.auditExport.exporterDatabaseRef}-Zz98Yx`;
    expect(evaluateDeployability(c, hypotheticalProductionContext(c)).blocking).toEqual([{ code: "AUDIT_EXPORT_IDENTITY_SHARED", path: "infrastructure.auditExport.verifierDatabaseRef" }]);
    const d = hypotheticalProductionConfig();
    if (!d.infrastructure?.auditExport) throw new Error("missing");
    d.infrastructure.auditExport.verifierDatabaseRef = `${d.database.connectionRef ?? ""}-Zz98Yx`;
    expect(evaluateDeployability(d, hypotheticalProductionContext(d)).blocking).toEqual([{ code: "AUDIT_EXPORT_IDENTITY_SHARED", path: "infrastructure.auditExport.verifierDatabaseRef" }]);
  });

  it("[FO-14-56][AUTH-02] adversarial (reverse direction): this environment's assertion key or audit manifest key equal to ANOTHER environment's approval trust anchor refuses the environment; its own anchor stays usable", () => {
    const c = hypotheticalProductionConfig();
    expect(blockingOf(c, withOther(c))).toEqual([]);
    const r = evaluateDeployability(c, withOther(c, { approvalTrustKeyRef: keyIdOf(c.signing.assertionKeyRef ?? "") }));
    expect(sep(r)).toEqual([{ code: "ASSERTION_KEY_IS_APPROVAL_TRUST_KEY", path: "environments.staging.approvals.trustedSigningKeyRef" }]);
    expect(r.deployable).toBe(false);
    // This environment's own anchor is not the problem: its approvals still verify.
    expect(r.approvals.every((a) => a.status === "VALID")).toBe(true);
    const m = evaluateDeployability(c, withOther(c, { approvalTrustKeyRef: hypoKey(3).replace("us-east-1", "eu-west-1") }));
    expect(sep(m)).toEqual([{ code: "AUDIT_MANIFEST_KEY_IS_APPROVAL_TRUST_KEY", path: "environments.staging.approvals.trustedSigningKeyRef" }]);
    // Only a trusted (verification) manifest key equal to the other anchor: still refused.
    const c2 = hypotheticalProductionConfig();
    if (!c2.infrastructure?.auditExport) throw new Error("missing");
    c2.infrastructure.auditExport.trustedManifestKeyIds = [hypoKey(3), hypoKey(8)];
    expect(sep(evaluateDeployability(c2, withOther(c2, { approvalTrustKeyRef: hypoKey(8) })))).toEqual([{ code: "AUDIT_MANIFEST_KEY_IS_APPROVAL_TRUST_KEY", path: "environments.staging.approvals.trustedSigningKeyRef" }]);
    // Another environment trusting the SAME approval anchor as this one is not a separation failure.
    expect(blockingOf(c, withOther(c, { approvalTrustKeyRef: c.approvals.trustedSigningKeyRef }))).toEqual([]);
  });

  it("[FO-14-56][AUTH-02] adversarial: a signing key (assertion, manifest signing or trusted manifest key) shared with another committed environment refuses the environment", () => {
    const c = hypotheticalProductionConfig();
    const assertion = c.signing.assertionKeyRef ?? "";
    expect(sep(evaluateDeployability(c, withOther(c, { assertionKeyRef: keyIdOf(assertion) })))).toEqual([{ code: "SIGNING_KEY_REUSED_ACROSS_ENVIRONMENTS", path: "environments.staging.signing.assertionKeyRef" }]);
    expect(sep(evaluateDeployability(c, withOther(c, { manifestSigningKeyId: assertion, trustedManifestKeyIds: [hypoKey(6)] })))).toEqual([{ code: "SIGNING_KEY_REUSED_ACROSS_ENVIRONMENTS", path: "environments.staging.infrastructure.auditExport.manifestSigningKeyId" }]);
    expect(sep(evaluateDeployability(c, withOther(c, { trustedManifestKeyIds: [hypoKey(6), hypoKey(3)] })))).toEqual([{ code: "SIGNING_KEY_REUSED_ACROSS_ENVIRONMENTS", path: "environments.staging.infrastructure.auditExport.trustedManifestKeyIds.1" }]);
  });

  it("[AUTH-02][DATA-01] adversarial: a secret shared with another committed environment refuses the environment (adapter credentials between environments are the connector rule's whenever it sees that environment, compared here otherwise)", () => {
    const c = hypotheticalProductionConfig();
    const s = c.infrastructure?.secrets;
    if (!s) throw new Error("missing");
    const theirs = otherEnv().secrets ?? [];
    const swap = (path: string, ref: string | null) => theirs.map((u) => (u.path === path ? { ...u, ref: ref ?? "" } : u));
    expect(sep(evaluateDeployability(c, withOther(c, { secrets: swap("infrastructure.secrets.consoleSessionSealerRef", s.requestHashPepperRef) })))).toEqual([
      { code: "SECRET_REUSED_ACROSS_ENVIRONMENTS", path: "environments.staging.infrastructure.secrets.consoleSessionSealerRef" },
    ]);
    expect(sep(evaluateDeployability(c, withOther(c, { secrets: swap("database.connectionRef", `${c.database.connectionRef ?? ""}-Ab12Cd`) })))).toEqual([{ code: "SECRET_REUSED_ACROSS_ENVIRONMENTS", path: "environments.staging.database.connectionRef" }]);
    expect(sep(evaluateDeployability(c, withOther(c, { secrets: swap("adapters.scheduling.credentialRef", c.database.connectionRef) })))).toEqual([{ code: "SECRET_REUSED_ACROSS_ENVIRONMENTS", path: "environments.staging.adapters.scheduling.credentialRef" }]);
    // Adapter credential to adapter credential across environments: when the connector credential rule sees that
    // environment's set it reports the pair (by identity), not this rule; when it does not, this rule reports it.
    const adapterPair = withOther(c, { secrets: swap("adapters.scheduling.credentialRef", `${c.adapters.scheduling?.credentialRef ?? ""}-Ab12Cd`) });
    expect(sep(evaluateDeployability(c, adapterPair))).toEqual([{ code: "SECRET_REUSED_ACROSS_ENVIRONMENTS", path: "environments.staging.adapters.scheduling.credentialRef" }]);
    const seen = evaluateDeployability(c, { ...adapterPair, connectorCredentialSets: [{ environment: "staging", profiles: [], adapterCredentialRefs: { scheduling: `${c.adapters.scheduling?.credentialRef ?? ""}-Ab12Cd` } }] });
    expect(sep(seen)).toEqual([]);
    expect(seen.blocking).toEqual([{ code: "CREDENTIAL_REUSED_ACROSS_ENVIRONMENTS", path: "connectors.credentials.staging.adapter:scheduling" }]);
  });

  it("[FO-14-56][AUTH-02] control: the hypothetical production configuration against every committed environment configuration (their keys, anchors and secrets) passes", () => {
    const c = hypotheticalProductionConfig();
    const committed: CommittedSigningKeys[] = (["local", "ci", "sandbox", "staging"] as const).map((env) => {
      const o = load(env);
      return {
        environment: env,
        assertionKeyRef: o.signing.assertionKeyRef,
        manifestSigningKeyId: o.infrastructure?.auditExport?.manifestSigningKeyId ?? null,
        trustedManifestKeyIds: o.infrastructure?.auditExport?.trustedManifestKeyIds ?? [],
        approvalTrustKeyRef: o.approvals.trustedSigningKeyRef,
        secrets: secretUses(o),
      };
    });
    expect(committed.some((e) => (e.secrets ?? []).length > 0)).toBe(true);
    expect(evaluateDeployability(c, { ...hypotheticalProductionContext(c), committedSigningKeys: committed }).violations).toEqual([]);
  });

  it("[FO-14-56][AUTH-02] adversarial: the trust anchor holding the SAME key material as the assertion key or a manifest key (another key id, imported material) refuses the environment, and no approval verifies", () => {
    const c = hypotheticalProductionConfig();
    const ctx = (runtimeSigningPublicKeys: GuardContext["runtimeSigningPublicKeys"]): GuardContext => ({ ...hypotheticalProductionContext(c), runtimeSigningPublicKeys });
    const other = generateKeyPairSync("ed25519").publicKey;
    // Control: different material for every runtime key (the references already differ).
    const manifest = generateKeyPairSync("ed25519").publicKey;
    const ok = evaluateDeployability(c, ctx([{ path: "signing.assertionKeyRef", key: other }, { path: "infrastructure.auditExport.manifestSigningKeyId", key: manifest }, { path: "infrastructure.auditExport.trustedManifestKeyIds.0", key: manifest }]));
    expect(ok.violations).toEqual([]);
    expect(ok.approvals.every((a) => a.status === "VALID")).toBe(true);
    // The anchor (TEST_ONLY_PUBLIC_PEM) is the assertion key's material.
    const r = evaluateDeployability(c, ctx([{ path: "signing.assertionKeyRef", key: TEST_ONLY_KEYS.publicKey }]));
    expect(sep(r)).toEqual([{ code: "APPROVAL_TRUST_KEY_IS_ASSERTION_KEY", path: "approvals.trustedSigningKeyRef" }]);
    expect(r.approvals.every((a) => a.status === "UNVERIFIED_NO_TRUST_KEY")).toBe(true);
    // A private key object is compared by its public half; a manifest key's material counts too.
    expect(sep(evaluateDeployability(c, ctx([{ path: "infrastructure.auditExport.trustedManifestKeyIds.0", key: TEST_ONLY_KEYS.privateKey }])))).toEqual([{ code: "APPROVAL_TRUST_KEY_IS_MANIFEST_KEY", path: "approvals.trustedSigningKeyRef" }]);
    // The manifest key holding the assertion key's material: the runtime could forge export manifests.
    expect(sep(evaluateDeployability(c, ctx([{ path: "signing.assertionKeyRef", key: other }, { path: "infrastructure.auditExport.manifestSigningKeyId", key: other }])))).toEqual([{ code: "AUDIT_MANIFEST_KEY_IS_ASSERTION_KEY", path: "infrastructure.auditExport.manifestSigningKeyId" }]);
    // Only known paths are compared (the runtime keys themselves resolved to separate material).
    expect(evaluateDeployability(c, ctx([{ path: "signing.assertionKeyRef", key: other }, { path: "infrastructure.auditExport.manifestSigningKeyId", key: manifest }, { path: "infrastructure.auditExport.trustedManifestKeyIds.0", key: manifest }, { path: "infrastructure.auditSink.kmsKeyId", key: TEST_ONLY_KEYS.publicKey }])).violations).toEqual([]);
  });

  it("[FO-14-56][OPS-05] the sandbox rule set refuses a sandbox runtime whose assertion key is a committed staging approval anchor (the override case: staging's guard cannot see it)", () => {
    const sbx = withHypotheticalLiveInputs(structuredClone(load("sandbox")));
    for (const a of Object.values(sbx.adapters)) Object.assign(a, { kind: "local_fixture", endpoint: null, credentialRef: null, authMethod: "none" });
    sbx.approvals.trustedSigningKeyRef = TRUST;
    const approval = testOnlyApproval("VENDOR_SANDBOX_INTEGRATION", "sandbox");
    const ctx = (anchor: string): GuardContext => ({ approvals: [approval], trustedApprovalKey: TEST_ONLY_PUBLIC_PEM, adapterKinds: {}, loadedPolicy: null, toolCatalogDigest: null, now: NOW, committedSigningKeys: [otherEnv({ approvalTrustKeyRef: anchor })] });
    expect(evaluateDeployability(sbx, ctx(hypoKey(7))).blocking).toEqual([]);
    const r = evaluateDeployability(sbx, ctx(sbx.signing.assertionKeyRef ?? ""));
    expect(r.blocking).toEqual([{ code: "ASSERTION_KEY_IS_APPROVAL_TRUST_KEY", path: "environments.staging.approvals.trustedSigningKeyRef" }]);
  });

  const PROFILE_AT = "connectors.credentials.production.profile:cnp_synthEmulatedVendor01";
  /** This environment's connector profile (the SYNTHETIC emulated vendor) with the given read and write credentials. */
  const withProfile = (c: PlatformConfig, readRef: string, writeRef: string, extra: GuardContext["connectorCredentialSets"] = []): GuardContext => ({
    ...hypotheticalProductionContext(c),
    connectorCredentialSets: [{ environment: "production", profiles: [emulatorProfile({ readRef, writeRef })] }, ...(extra ?? [])],
  });

  it("[AUTH-02][DATA-01][FT-91] adversarial: a connector profile credential of this environment (the default, a READ or a WRITE capability credential) equal to the console sealer, a pepper or the database login refuses the environment at the profile position", () => {
    const read = hypoSecret("production", "connector-read");
    const write = hypoSecret("production", "connector-write");
    const control = hypotheticalProductionConfig();
    expect(evaluateDeployability(control, withProfile(control, read, write)).violations).toEqual([]);
    const cases: [string, (s: NonNullable<PlatformConfig["infrastructure"]>["secrets"], c: PlatformConfig) => void, string[]][] = [
      // The worker holds the connector credentials: with the sealer among them it could unseal workforce refresh tokens.
      ["sealer == profile read credential (default and READ capability)", (s) => void (s.consoleSessionSealerRef = read), [`${PROFILE_AT}:default:READ`, `${PROFILE_AT}:scheduling.appointments_read:READ`]],
      // The internet-facing gateway reads the pepper: with a vendor WRITE credential as the pepper it could write to the vendor.
      ["request-hash pepper == profile WRITE credential", (s) => void (s.requestHashPepperRef = write), [`${PROFILE_AT}:scheduling.appointments_write:WRITE`]],
      ["OTP pepper == profile WRITE credential (its full ARN)", (s) => void (s.otpPepperRef = `${write}-Ab12Cd`), [`${PROFILE_AT}:scheduling.appointments_write:WRITE`]],
      ["database login == profile read credential", (_s, c) => void (c.database.connectionRef = read), [`${PROFILE_AT}:default:READ`, `${PROFILE_AT}:scheduling.appointments_read:READ`]],
      ["audit exporter login == profile WRITE credential", (_s, c) => void (c.infrastructure?.auditExport && (c.infrastructure.auditExport.exporterDatabaseRef = write)), [`${PROFILE_AT}:scheduling.appointments_write:WRITE`]],
    ];
    for (const [label, mutate, paths] of cases) {
      const c = hypotheticalProductionConfig();
      if (!c.infrastructure) throw new Error("missing");
      mutate(c.infrastructure.secrets, c);
      const r = evaluateDeployability(c, withProfile(c, read, write));
      expect(sep(r), label).toEqual(paths.map((path) => ({ code: "SECRET_REUSED_ACROSS_PURPOSES", path })));
      expect(r.deployable, label).toBe(false);
      expect(JSON.stringify(r.violations), label).not.toMatch(/arn:aws/);
    }
    // Against another committed environment: this environment's profile credential is that environment's sealer.
    const c2 = hypotheticalProductionConfig();
    const theirs = (otherEnv().secrets ?? []).map((u) => (u.path === "infrastructure.secrets.consoleSessionSealerRef" ? { ...u, ref: read } : u));
    expect(sep(evaluateDeployability(c2, { ...withProfile(c2, read, write), committedSigningKeys: [otherEnv({ secrets: theirs })] }))).toEqual([
      { code: "SECRET_REUSED_ACROSS_ENVIRONMENTS", path: "environments.staging.infrastructure.secrets.consoleSessionSealerRef" },
    ]);
  });

  it("[AUTH-02][FT-91] adversarial: connector credentials are compared by IDENTITY, not by spelling: a full and a partial Secrets Manager ARN of one secret in two adapters, in a profile and an adapter, and in this and another environment's adapters each refuse the environment (connector credential rule)", () => {
    const blockingWith = (c: PlatformConfig, ctx: GuardContext) => evaluateDeployability(c, ctx).blocking;
    // Two adapters: the partial ARN of one and the full ARN of the same secret (no supplied sets: the configured adapters).
    const a = hypotheticalProductionConfig();
    (a.adapters.billing ?? { credentialRef: null }).credentialRef = `${a.adapters.scheduling?.credentialRef ?? ""}-Ab12Cd`;
    expect(blockingWith(a, hypotheticalProductionContext(a))).toEqual([{ code: "CREDENTIAL_REUSED_ACROSS_CONNECTORS", path: "connectors.credentials.production.adapter:billing" }]);
    // The same through the composition's sets (connectorCredentialSets of this environment).
    expect(blockingWith(a, withProfile(a, hypoSecret("production", "connector-read"), hypoSecret("production", "connector-write")))).toEqual([{ code: "CREDENTIAL_REUSED_ACROSS_CONNECTORS", path: "connectors.credentials.production.adapter:billing" }]);
    // A profile credential (full ARN) and an adapter credential (partial ARN of the same secret).
    const b = hypotheticalProductionConfig();
    const sched = b.adapters.scheduling?.credentialRef ?? "";
    const rb = evaluateDeployability(b, withProfile(b, `${sched}-Qw12Er`, hypoSecret("production", "connector-write")));
    expect(rb.blocking).toEqual([{ code: "CREDENTIAL_REUSED_ACROSS_CONNECTORS", path: "connectors.credentials.production.adapter:scheduling" }]);
    // Reported once, by the connector rule (the key separation rule leaves connector pairs to it).
    expect(sep(rb)).toEqual([]);
    // This environment's adapter (partial ARN) and another committed environment's adapter (full ARN of the same secret).
    const c = hypotheticalProductionConfig();
    const shared = c.adapters.salesforce?.credentialRef ?? "";
    const other = [{ environment: "staging" as const, profiles: [], adapterCredentialRefs: { salesforce: `${shared}-Zz98Yx` } }];
    expect(blockingWith(c, withProfile(c, hypoSecret("production", "connector-read"), hypoSecret("production", "connector-write"), other))).toEqual([
      { code: "CREDENTIAL_REUSED_ACROSS_ENVIRONMENTS", path: "connectors.credentials.staging.adapter:salesforce" },
    ]);
    // This environment's profile credential and another environment's adapter, by different spellings.
    expect(
      blockingWith(c, withProfile(c, hypoSecret("production", "connector-read"), `${hypoSecret("production", "connector-write")}-Mn34Op`, [{ environment: "staging", profiles: [], adapterCredentialRefs: { billing: hypoSecret("production", "connector-write") } }])),
    ).toEqual([{ code: "CREDENTIAL_REUSED_ACROSS_ENVIRONMENTS", path: "connectors.credentials.staging.adapter:billing" }]);
    // Controls: names that only share a prefix, and the same name in another account, are different secrets.
    const d = hypotheticalProductionConfig();
    (d.adapters.billing ?? { credentialRef: null }).credentialRef = hypoSecret("production", "pepper-prod01");
    (d.adapters.claims ?? { credentialRef: null }).credentialRef = hypoSecret("production", "pepper-test01");
    (d.adapters.notifications ?? { credentialRef: null }).credentialRef = (d.adapters.scheduling?.credentialRef ?? "").replace(HYPO_ACCOUNT, HYPO_AUDIT_ACCOUNT);
    expect(blockingWith(d, hypotheticalProductionContext(d))).toEqual([]);
  });

  it("[FO-14-56][AUTH-02] fail closed: when the composition resolved the runtime signing keys, a configured signing key it could not resolve refuses the environment (RUNTIME_SIGNING_KEY_UNRESOLVED) and the anchor is not used; nothing is reported without resolution, for an alias or for an assertion reference the mandatory rule refuses", () => {
    const c = hypotheticalProductionConfig();
    const a = generateKeyPairSync("ed25519").publicKey;
    const m = generateKeyPairSync("ed25519").publicKey;
    const all = [{ path: "signing.assertionKeyRef", key: a }, { path: "infrastructure.auditExport.manifestSigningKeyId", key: m }, { path: "infrastructure.auditExport.trustedManifestKeyIds.0", key: m }];
    const ctx = (runtimeSigningPublicKeys?: GuardContext["runtimeSigningPublicKeys"]): GuardContext => ({ ...hypotheticalProductionContext(c), ...(runtimeSigningPublicKeys ? { runtimeSigningPublicKeys } : {}) });
    expect(evaluateDeployability(c, ctx(all)).violations).toEqual([]);
    // No resolution at all (a context that did not resolve keys): references only, nothing reported.
    expect(evaluateDeployability(c, ctx()).violations).toEqual([]);
    const unresolved = (r: GuardReport) => r.blocking.filter((v) => v.code === "RUNTIME_SIGNING_KEY_UNRESOLVED").map((v) => v.path);
    // The trusted manifest key's public key could not be obtained.
    const r = evaluateDeployability(c, ctx(all.slice(0, 2)));
    expect(unresolved(r)).toEqual(["infrastructure.auditExport.trustedManifestKeyIds.0"]);
    expect(r.deployable).toBe(false);
    // The anchor is not used: its separation from that key is unproven, so no record verifies.
    expect(r.approvals.every((x) => x.status === "UNVERIFIED_NO_TRUST_KEY")).toBe(true);
    // Resolution attempted, nothing resolved: every configured signing key is reported.
    expect(unresolved(evaluateDeployability(c, ctx([])))).toEqual(["signing.assertionKeyRef", "infrastructure.auditExport.manifestSigningKeyId", "infrastructure.auditExport.trustedManifestKeyIds.0"]);
    // A key object that is not a usable public key counts as unresolved.
    expect(unresolved(evaluateDeployability(c, ctx([...all.slice(0, 2), { path: "infrastructure.auditExport.trustedManifestKeyIds.0", key: "not a key" as unknown as KeyObject }])))).toEqual(["infrastructure.auditExport.trustedManifestKeyIds.0"]);
    // Not reported twice: an alias (KMS_SIGNING_KEY_REF_IS_ALIAS) and a placeholder assertion key (SIGNING_KEY_REF_PLACEHOLDER).
    const al = hypotheticalProductionConfig();
    if (!al.infrastructure?.auditExport) throw new Error("missing");
    al.infrastructure.auditExport.trustedManifestKeyIds = [hypoKey(3), "alias/vsp-production-manifests"];
    al.signing.assertionKeyRef = `arn:aws:kms:REGION:ACCOUNT:key/PLACEHOLDER-vsp-production-assertions`;
    const ra = evaluateDeployability(al, { ...hypotheticalProductionContext(al), runtimeSigningPublicKeys: all.slice(1, 3) });
    expect(unresolved(ra)).toEqual([]);
    expect(ra.blocking.map((v) => v.code)).toEqual(expect.arrayContaining(["KMS_SIGNING_KEY_REF_IS_ALIAS", "SIGNING_KEY_REF_PLACEHOLDER"]));
    // A placeholder MANIFEST key is not refused by another rule: it is unresolved here.
    const pm = hypotheticalProductionConfig();
    if (!pm.infrastructure?.auditExport) throw new Error("missing");
    pm.infrastructure.auditExport.trustedManifestKeyIds = [hypoKey(3), `arn:aws:kms:us-east-1:${HYPO_ACCOUNT}:key/PLACEHOLDER-manifest`];
    expect(unresolved(evaluateDeployability(pm, { ...hypotheticalProductionContext(pm), runtimeSigningPublicKeys: all }))).toEqual(["infrastructure.auditExport.trustedManifestKeyIds.1"]);
  });
});

describe("outbox dead-letter queue (WP-07; OPS-01)", () => {
  it("[OPS-01] staging and production require the outbox dead-letter queue (one poison message must not fail the consume loop forever); sandbox may run without it", () => {
    for (const env of ["staging", "production"] as const) {
      const c = hypotheticalProductionConfig();
      c.environment = env;
      if (!c.infrastructure?.outbox) throw new Error("missing");
      c.infrastructure.outbox.deadLetterQueueUrl = null;
      expect(has(evaluateDeployability(c, hypotheticalProductionContext(c)), "OUTBOX_DLQ_NOT_CONFIGURED", "infrastructure.outbox.deadLetterQueueUrl"), env).toBe(true);
      c.infrastructure.outbox.deadLetterQueueUrl = `https://sqs.us-east-1.amazonaws.com/${HYPO_ACCOUNT}/vsp-PLACEHOLDER-dlq`;
      expect(has(evaluateDeployability(c, hypotheticalProductionContext(c)), "OUTBOX_DLQ_PLACEHOLDER", "infrastructure.outbox.deadLetterQueueUrl"), env).toBe(true);
    }
    const c = hypotheticalProductionConfig();
    expect(evaluateDeployability(c, hypotheticalProductionContext(c)).violations).toEqual([]);
    const sbx = withHypotheticalLiveInputs(structuredClone(load("sandbox")));
    for (const a of Object.values(sbx.adapters)) Object.assign(a, { kind: "local_fixture", endpoint: null, credentialRef: null, authMethod: "none" });
    sbx.approvals.trustedSigningKeyRef = `arn:aws:kms:us-east-1:${HYPO_ACCOUNT}:key/00000000-0000-0000-0000-000000000000`;
    if (!sbx.infrastructure?.outbox) throw new Error("missing");
    sbx.infrastructure.outbox.deadLetterQueueUrl = null;
    const r = evaluateDeployability(sbx, { approvals: [], trustedApprovalKey: TEST_ONLY_PUBLIC_PEM, adapterKinds: {}, loadedPolicy: null, toolCatalogDigest: null, now: NOW });
    expect(codes(r)).not.toContain("OUTBOX_DLQ_NOT_CONFIGURED");
  });
});

describe("runtime signing public keys for the key separation rule (WP-07; FO-14-56)", () => {
  const resolver = (keys: Record<string, KeyObject | Error>): TrustedKeyResolver => ({
    kind: "live",
    resolve: async (ref) => {
      const k = keys[ref];
      if (k instanceof Error) throw k;
      return k ?? null;
    },
  });
  it("[FO-14-56] a live configuration's assertion and audit manifest keys are resolved through the trust resolvers; unsupported or failing references are left out and logged; the offline rule set resolves none", async () => {
    const c = hypotheticalProductionConfig();
    const a = generateKeyPairSync("ed25519").publicKey;
    const m = generateKeyPairSync("ed25519").publicKey;
    const { logger, records } = createMemoryLogger();
    const out = await resolveRuntimeSigningPublicKeys(c, [resolver({ [c.signing.assertionKeyRef ?? ""]: a, [hypoKey(3)]: m })], logger);
    expect(out.map((x) => x.path)).toEqual(["signing.assertionKeyRef", "infrastructure.auditExport.manifestSigningKeyId", "infrastructure.auditExport.trustedManifestKeyIds.0"]);
    expect(out[0]?.key).toBe(a);
    const failing = await resolveRuntimeSigningPublicKeys(c, [resolver({ [c.signing.assertionKeyRef ?? ""]: new ValidationError("APPROVAL_TRUST_KEY_UNAVAILABLE") })], logger);
    expect(failing).toEqual([]);
    expect(records.some((r) => r.event === "config.runtime_signing_key.unresolved" && r.fields.component === "signing.assertionKeyRef" && r.fields.reasonCode === "APPROVAL_TRUST_KEY_UNAVAILABLE")).toBe(true);
    // A reference no resolver supports is logged too (and refused by the guard, RUNTIME_SIGNING_KEY_UNRESOLVED).
    expect(records.some((r) => r.event === "config.runtime_signing_key.unresolved" && r.fields.component === "infrastructure.auditExport.manifestSigningKeyId" && r.fields.reasonCode === "RUNTIME_SIGNING_KEY_REF_UNSUPPORTED")).toBe(true);
    expect(await resolveRuntimeSigningPublicKeys(load("local"), [resolver({ "local-fixture:assertion-dev-key": a })], logger)).toEqual([]);
  });

  it("[FO-14-56][AUTH-02] startup hands the guard the runtime keys' material: two different key ids with the same public key (anchor and assertion key) refuse the environment for that reason", async () => {
    const anchor = hypoKey(8);
    const assertion = hypoKey(9);
    const env = { VSP_CONFIG_APPROVALS_TRUSTED_KEY_REF: anchor, VSP_CONFIG_ASSERTION_KEY_REF: assertion };
    const shared = generateKeyPairSync("ed25519").publicKey;
    const attempt = async (keys: Record<string, KeyObject>) => {
      try {
        await loadDeployableConfig({ environment: "production", clock, env, adapterKinds: {}, loadedPolicy: null, toolCatalogDigest: null, keyResolvers: [resolver(keys)] });
        return [];
      } catch (err) {
        if (err instanceof ConfigurationRejectedError) return err.violations;
        throw err;
      }
    };
    expect(await attempt({ [anchor]: shared, [assertion]: shared })).toContain("APPROVAL_TRUST_KEY_IS_ASSERTION_KEY@approvals.trustedSigningKeyRef");
    expect(await attempt({ [anchor]: shared, [assertion]: generateKeyPairSync("ed25519").publicKey })).not.toContain("APPROVAL_TRUST_KEY_IS_ASSERTION_KEY@approvals.trustedSigningKeyRef");
  });

  /** A KMS GetPublicKey client over in-memory keys by KeyId (the command is passed through as its input). */
  const kmsOf = (keys: Record<string, KeyObject | "DENIED">, calls: string[] = []): KmsPublicKeyClient => ({
    send: async (input: unknown) => {
      const id = (input as { KeyId: string }).KeyId;
      calls.push(id);
      const k = keys[id];
      if (!k || k === "DENIED") throw Object.assign(new Error("AccessDeniedException"), { name: "AccessDeniedException" });
      return { PublicKey: new Uint8Array(k.export({ format: "der", type: "spki" })), KeyUsage: "SIGN_VERIFY", KeySpec: "ECC_NIST_P256" };
    },
  });
  const passThrough = (input: { KeyId: string }) => input;
  const BARE = (n: number) => hypoKey(n).slice(hypoKey(n).indexOf(":key/") + 5);
  const MRK = "mrk-0123456789abcdef0123456789abcdef";

  it("[FO-14-56] KmsRuntimeSigningKeyResolver resolves every form the runtime signs with (key ARN, bare key id, mrk- id) and never an alias; a denied call or a reply without a public key throws", async () => {
    const k = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey;
    const calls: string[] = [];
    const r = new KmsRuntimeSigningKeyResolver(kmsOf({ [hypoKey(3)]: k, [BARE(3)]: k, [MRK]: k, [BARE(4)]: "DENIED" }, calls), passThrough);
    for (const ref of [hypoKey(3), BARE(3), MRK]) expect((await r.resolve(ref))?.export({ format: "der", type: "spki" }).equals(k.export({ format: "der", type: "spki" })), ref).toBe(true);
    for (const ref of ["alias/vsp-manifests", `arn:aws:kms:us-east-1:${HYPO_ACCOUNT}:alias/vsp-manifests`, "local-fixture:assertion-dev-key", hypoSecret("production", "pepper")]) expect(await r.resolve(ref), ref).toBeNull();
    expect(calls).toEqual([hypoKey(3), BARE(3), MRK]);
    await expect(r.resolve(BARE(4))).rejects.toMatchObject({ reasonCode: "RUNTIME_SIGNING_KEY_UNAVAILABLE" });
    const empty = new KmsRuntimeSigningKeyResolver({ send: async () => ({ KeyUsage: "SIGN_VERIFY" }) }, passThrough);
    await expect(empty.resolve(BARE(3))).rejects.toMatchObject({ reasonCode: "RUNTIME_SIGNING_KEY_INVALID" });
    // The trust anchor resolver still takes key ARNs only.
    expect(await new KmsTrustedKeyResolver(kmsOf({ [BARE(3)]: k }), passThrough).resolve(BARE(3))).toBeNull();
  });

  it("[FO-14-56][AUTH-02] adversarial (startup, KMS resolvers): a manifest key named by its BARE key id holding the anchor's or the assertion key's key material is refused by material; GetPublicKey denied on it refuses the environment (RUNTIME_SIGNING_KEY_UNRESOLVED), never only logged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vsp-guard-keysep-"));
    const repoRoot = join(dir, "repo");
    mkdirSync(join(repoRoot, "approvals"), { recursive: true });
    // A record signed for the anchor (TEST-ONLY key): VALID only while the guard uses the anchor.
    const record = testOnlyApproval("SECURITY_REVIEW", "production");
    writeFileSync(join(repoRoot, "approvals", `${record.approvalId}.json`), JSON.stringify(record));
    try {
      const anchor = hypoKey(8);
      const assertion = hypoKey(1);
      const write = (manifest: string) => {
        const c = hypotheticalProductionConfig();
        if (!c.infrastructure?.auditExport) throw new Error("missing");
        c.approvals.trustedSigningKeyRef = anchor;
        c.infrastructure.auditExport.manifestSigningKeyId = manifest;
        c.infrastructure.auditExport.trustedManifestKeyIds = [manifest];
        writeFileSync(join(dir, "production.json"), JSON.stringify(c));
      };
      const anchorKey = TEST_ONLY_KEYS.publicKey;
      const assertionKey = generateKeyPairSync("ed25519").publicKey;
      const { logger, records } = createMemoryLogger();
      const attempt = async (keys: Record<string, KeyObject | "DENIED">) => {
        const kms = kmsOf(keys);
        try {
          await loadDeployableConfig({
            environment: "production",
            clock,
            env: {},
            configDir: dir,
            repoRoot,
            adapterKinds: {},
            loadedPolicy: null,
            toolCatalogDigest: null,
            logger,
            keyResolvers: [new KmsTrustedKeyResolver(kms, passThrough)],
            signingKeyResolvers: [new KmsRuntimeSigningKeyResolver(kms, passThrough)],
          });
          return [];
        } catch (err) {
          if (err instanceof ConfigurationRejectedError) return err.violations;
          throw err;
        }
      };
      write(BARE(3));
      // Control: separate material for every key.
      const separate = await attempt({ [anchor]: anchorKey, [assertion]: assertionKey, [BARE(3)]: generateKeyPairSync("ed25519").publicKey });
      expect(separate.filter((v) => /^(APPROVAL_TRUST_KEY_IS_|AUDIT_MANIFEST_KEY_IS_|RUNTIME_SIGNING_KEY_UNRESOLVED)/.test(v))).toEqual([]);
      // The manifest key (bare id) holds the anchor's material: the audit exporter's key could mint approvals.
      expect(await attempt({ [anchor]: anchorKey, [assertion]: assertionKey, [BARE(3)]: anchorKey })).toContain("APPROVAL_TRUST_KEY_IS_MANIFEST_KEY@approvals.trustedSigningKeyRef");
      // The manifest key (bare id) holds the assertion key's material: the runtime could forge export manifests.
      expect(await attempt({ [anchor]: anchorKey, [assertion]: assertionKey, [BARE(3)]: assertionKey })).toEqual(
        expect.arrayContaining(["AUDIT_MANIFEST_KEY_IS_ASSERTION_KEY@infrastructure.auditExport.manifestSigningKeyId", "AUDIT_MANIFEST_KEY_IS_ASSERTION_KEY@infrastructure.auditExport.trustedManifestKeyIds.0"]),
      );
      // GetPublicKey denied on the manifest key while the anchor resolves: refused, and the anchor is not used.
      const denied = await attempt({ [anchor]: anchorKey, [assertion]: assertionKey, [BARE(3)]: "DENIED" });
      expect(denied).toEqual(expect.arrayContaining(["RUNTIME_SIGNING_KEY_UNRESOLVED@infrastructure.auditExport.manifestSigningKeyId", "RUNTIME_SIGNING_KEY_UNRESOLVED@infrastructure.auditExport.trustedManifestKeyIds.0"]));
      expect(denied).toContain(`APPROVAL_UNVERIFIED_NO_TRUST_KEY@approvals.records.${record.approvalId}`);
      expect(separate).not.toContain(`APPROVAL_UNVERIFIED_NO_TRUST_KEY@approvals.records.${record.approvalId}`);
      expect(records.some((r) => r.event === "config.runtime_signing_key.unresolved" && r.fields.component === "infrastructure.auditExport.manifestSigningKeyId" && r.fields.reasonCode === "RUNTIME_SIGNING_KEY_UNAVAILABLE")).toBe(true);
      // The key ARN form of the same key (the reference check and the material check both apply).
      write(hypoKey(3));
      expect(await attempt({ [anchor]: anchorKey, [assertion]: assertionKey, [hypoKey(3)]: anchorKey })).toContain("APPROVAL_TRUST_KEY_IS_MANIFEST_KEY@approvals.trustedSigningKeyRef");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
