/**
 * Audit exporter unit, Docker-free part (WP-07; FO-16-11, FO-19-06, OPS-01, OPS-04, AUTH-02).
 *
 *  - refusals before any client exists (mode, offline environments, no infrastructure);
 *  - D8 of the WP-07 verifier: the unit hands the deployment guard the SAME inputs as the gateway (loaded policy
 *    bundle, committed tool catalogue digest, template catalogue and image digests, connector credential sets),
 *    so a complete staging configuration passes the full rule set for the exporter, and the old inputs
 *    (no policy, no catalogue) are shown to be refused. Production adds the subject-bound approvals; their one
 *    remaining unverifiable subject (the served knowledge snapshot) is the same for every unit and is asserted.
 * The approval key is a TEST-ONLY in-memory Ed25519 pair (the guard context takes a public key; the unit itself
 * resolves its trust anchor from KMS only, which the composition Layer-2 suite exercises).
 */
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { APPROVER_ROLES_BY_SCOPE, approvalSigningPayload } from "../config/approvals.js";
import { REQUIRED_APPROVALS_BY_ENVIRONMENT, evaluateDeployability } from "../config/guard.js";
import type { GuardContext } from "../config/guard.js";
import { loadPlatformConfig } from "../config/loader.js";
import { loadDeployableConfig } from "../config/startup.js";
import type { PlatformConfig } from "../config/ports.js";
import type { KmsPublicKeyClient } from "../config/approvals.js";
import { createMemoryLogger } from "../observability/logger.js";
import { ensurePolicyBundle } from "../policy/ensure-bundle.js";
import type { ApprovalRecord, ApprovalScope, ApprovalSubject, Environment } from "../protocol/index.js";
import { FakeClock } from "../shared/clock.js";
import { ConfigurationRejectedError } from "../shared/errors.js";
import { PROFILE_ID, emulatorProfile } from "../../test/integration/connectors/profiles.js";
import { auditUnitStartupInputs, startAuditExporter } from "./audit-exporter.js";

const clock = new FakeClock("2026-10-21T12:00:00.000Z");
const KEYS = generateKeyPairSync("ed25519");
const PUBLIC_PEM = KEYS.publicKey.export({ type: "spki", format: "pem" }).toString();
const ACCOUNT = "111122223333"; // AWS documentation example account id
const MODEL = { model: "hypothetical-model-1", voice: "hypothetical-voice-1", agentConfig: "hypothetical-agent-1" };
const IMAGE = `sha256:${"f".repeat(64)}`;
const secret = (env: string, n: string) => `arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:vsp-${env}-${n}`;
const key = (n: number) => `arn:aws:kms:us-east-1:${ACCOUNT}:key/${String(n).repeat(8)}-${String(n).repeat(4)}-${String(n).repeat(4)}-${String(n).repeat(4)}-${String(n).repeat(12)}`;
const noKms: KmsPublicKeyClient = { send: async () => Promise.reject(new Error("KMS_NOT_USED_IN_UNIT_TEST")) } as unknown as KmsPublicKeyClient;

function approval(scope: ApprovalScope, environment: Environment, subject?: ApprovalSubject): ApprovalRecord {
  const r: ApprovalRecord = {
    approvalId: `apr_synthExporter${scope.toLowerCase().replace(/_/g, "")}`.slice(0, 64),
    approver: { name: "Synthetic Approver", role: APPROVER_ROLES_BY_SCOPE[scope][0] ?? "security_leadership" },
    scope,
    scopeDetail: `SYNTHETIC ${scope} record for the audit exporter guard test; no authority`,
    ...(subject ? { subject } : {}),
    environment,
    grantedAt: "2026-10-20T00:00:00.000Z",
    expiresAt: "2026-11-20T00:00:00.000Z",
    evidenceRef: "evidence://synthetic/audit-exporter-test",
    signature: null,
  };
  return { ...r, signature: `ed25519:${cryptoSign(null, Buffer.from(approvalSigningPayload(r), "utf8"), KEYS.privateKey).toString("base64")}` };
}

/** A complete live configuration (SYNTHETIC values) pinned to what the unit actually loads. */
function completeConfig(environment: "staging" | "production", pins: { policy: { version: string; digest: string }; catalog: string }): PlatformConfig {
  const c = structuredClone(loadPlatformConfig({ environment, env: {} }).config);
  c.tenantId = "tnt_HypotheticalExporter01";
  c.adapters = {};
  c.models = { active: { ...MODEL }, approved: [{ model: MODEL.model, voice: MODEL.voice, approvalId: approval("MODEL_VOICE_SELECTION", environment).approvalId }] };
  c.policy = { ...c.policy, expectedVersion: pins.policy.version, expectedDigest: pins.policy.digest };
  c.toolCatalog = { expectedDigest: pins.catalog };
  c.cors = { allowedOrigins: ["https://console.hypothetical-tenant.example.com"] };
  c.verification = { ...c.verification, approvedBySecurity: approval("SECURITY_REVIEW", environment).approvalId };
  // SYNTHETIC durations: retention is set by counsel, never by this code.
  c.retention = { TRANSIENT_CONVERSATION: 1, BUSINESS_RECORD: 1, RESTRICTED_QA_MEDIA: 1, SECURITY_AUDIT: 1 };
  c.approvals = { ...c.approvals, trustedSigningKeyRef: key(9) };
  c.signing = { assertionKeyRef: key(1), localDevKey: false };
  c.database = { engine: "pg", connectionRef: secret(environment, "aurora") };
  c.sessionStore = { kind: "dynamodb", tableName: `vsp-${environment}-sessions` };
  c.destinations = c.destinations.map((d) => ({ ...d, vendorQueueRef: d.vendorQueueRef.replace("PLACEHOLDER", "HYPOTHETICAL") }));
  c.infrastructure = {
    aws: { region: "us-east-1", endpointOverrides: null, s3ForcePathStyle: false },
    privateNetworkHosts: [],
    trustedProxyCidrs: ["10.40.0.0/20"],
    outbox: { queueUrl: `https://sqs.us-east-1.amazonaws.com/${ACCOUNT}/vsp-${environment}-outbox`, fifo: false, deadLetterQueueUrl: `https://sqs.us-east-1.amazonaws.com/${ACCOUNT}/vsp-${environment}-outbox-dlq` },
    routeAuditJournalTable: `vsp-${environment}-route-audit-journal`,
    auditSink: { bucket: `vsp-${environment}-audit-hypothetical`, expectedBucketOwner: "444455556666", keyPrefix: "audit/", objectLockMode: "COMPLIANCE", kmsKeyId: key(2) },
    auditExport: { manifestSigningKeyId: key(3), exporterDatabaseRef: secret(environment, "audit-exporter"), verifierDatabaseRef: secret(environment, "audit-verifier"), trustedManifestKeyIds: [key(3)] },
    secrets: { requestHashPepperRef: secret(environment, "pepper"), otpPepperRef: secret(environment, "otp-pepper"), consoleSessionSealerRef: secret(environment, "sealer") },
    ingressPayloadKeyId: key(4),
  };
  c.egress = { policyVersion: "egress-hypothetical-1", destinations: [] };
  return c;
}

const rejected = async (p: Promise<unknown>): Promise<string[]> => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(ConfigurationRejectedError);
  return (e as ConfigurationRejectedError).violations;
};

describe("audit exporter unit: refusals before any client [OPS-04]", () => {
  it("[OPS-04] an unknown mode, an offline environment or a configuration without infrastructure refuses the unit", async () => {
    expect(await rejected(startAuditExporter({ env: { VSP_ENVIRONMENT: "sandbox", VSP_AUDIT_UNIT_MODE: "repair" } }))).toEqual(["AUDIT_UNIT_MODE_INVALID@VSP_AUDIT_UNIT_MODE"]);
    for (const env of ["local", "ci"]) expect(await rejected(startAuditExporter({ env: { VSP_ENVIRONMENT: env } }))).toEqual(["LIVE_COMPOSITION_OFFLINE_ENVIRONMENT@environment"]);
    for (const env of ["sandbox", "staging", "production"]) expect(await rejected(startAuditExporter({ env: { VSP_ENVIRONMENT: env, VSP_AUDIT_UNIT_MODE: "verify" } }))).toEqual(["INFRASTRUCTURE_NOT_CONFIGURED@infrastructure"]);
  });
});

describe("audit exporter unit: the guard admits it exactly when it admits the gateway [FO-16-11][OPS-04]", () => {
  beforeAll(() => ensurePolicyBundle());

  async function inputsFor(environment: "staging" | "production") {
    const { logger } = createMemoryLogger();
    const probe = loadPlatformConfig({ environment, env: {} }).config;
    const inputs = await auditUnitStartupInputs({ ...probe, policy: { ...probe.policy, expectedVersion: null, expectedDigest: null } }, { environment, clock, logger, env: {}, kms: noKms, releaseImageDigest: IMAGE });
    if (!inputs.loadedPolicy || !inputs.toolCatalogDigest) throw new Error("the unit did not load the policy bundle or the catalogue");
    const config = completeConfig(environment, { policy: inputs.loadedPolicy, catalog: inputs.toolCatalogDigest });
    const subjects: Partial<Record<ApprovalScope, ApprovalSubject>> = {
      MODEL_VOICE_SELECTION: { modelVoice: MODEL },
      POLICY_RELEASE: { policyBundle: inputs.loadedPolicy },
      CLINICAL_SCRIPTS: { templateCatalogDigest: inputs.templateCatalogDigest ?? "" },
      PRODUCTION_DEPLOYMENT: { release: { imageDigest: IMAGE } },
      KNOWLEDGE_RELEASE: { knowledgeSnapshotDigest: "d".repeat(64) },
    };
    const scopes = new Set<ApprovalScope>([...REQUIRED_APPROVALS_BY_ENVIRONMENT[environment], "MODEL_VOICE_SELECTION", "SECURITY_REVIEW"]);
    const approvals = [...scopes].map((s) => approval(s, environment, subjects[s]));
    const ctx = (over: Partial<GuardContext> = {}): GuardContext => ({
      approvals,
      trustedApprovalKey: PUBLIC_PEM,
      adapterKinds: inputs.adapterKinds,
      loadedPolicy: inputs.loadedPolicy,
      toolCatalogDigest: inputs.toolCatalogDigest,
      templateCatalogDigest: inputs.templateCatalogDigest ?? null,
      releaseImageDigest: inputs.releaseImageDigest ?? null,
      ...(inputs.connectorCredentialSets ? { connectorCredentialSets: inputs.connectorCredentialSets } : {}),
      now: clock.now(),
      ...over,
    });
    return { inputs, config, ctx };
  }

  it("[FO-16-11][OPS-04] positive: with the unit's own inputs a complete staging configuration passes the full rule set (deployable, nothing blocking)", async () => {
    const { inputs, config, ctx } = await inputsFor("staging");
    expect(inputs.adapterKinds).toEqual({});
    expect(inputs.keyResolvers?.map((r) => r.constructor.name)).toEqual(["KmsTrustedKeyResolver"]);
    // The runtime signing keys (bare key ids included) are resolved for the key separation check.
    expect(inputs.signingKeyResolvers?.map((r) => r.constructor.name)).toEqual(["KmsRuntimeSigningKeyResolver"]);
    const r = evaluateDeployability(config, ctx());
    expect(r.blocking).toEqual([]);
    expect(r.deployable).toBe(true);
    expect(r.notConfiguredCapabilities).not.toContain("audit.independent");
  });

  it("[OPS-04] the defect reproduced: the inputs the unit used to pass (no policy bundle, no catalogue digest) refuse staging and production", async () => {
    for (const environment of ["staging", "production"] as const) {
      const { config, ctx } = await inputsFor(environment);
      const codes = evaluateDeployability(config, ctx({ loadedPolicy: null, toolCatalogDigest: null })).blocking.map((v) => `${v.code}@${v.path}`);
      expect(codes).toEqual(expect.arrayContaining(["POLICY_BUNDLE_NOT_LOADED@policy.bundlePath", "TOOL_CATALOG_NOT_LOADED@toolCatalog.expectedDigest"]));
    }
  });

  it("[OPS-04][OPS-APPR-01] production: policy, model, template and image subjects verify with the unit's inputs; the only blocker left is the served knowledge snapshot, unverifiable for every unit (fail closed)", async () => {
    const { config, ctx } = await inputsFor("production");
    const r = evaluateDeployability(config, ctx());
    expect(r.deployable).toBe(false);
    const knowledge = r.approvals.find((a) => a.scope === "KNOWLEDGE_RELEASE");
    expect(knowledge?.status).toBe("SUBJECT_UNVERIFIABLE");
    for (const scope of ["POLICY_RELEASE", "CLINICAL_SCRIPTS", "PRODUCTION_DEPLOYMENT", "MODEL_VOICE_SELECTION"]) expect(r.approvals.find((a) => a.scope === scope)?.status, scope).toBe("VALID");
    expect(r.blocking.every((v) => /KNOWLEDGE_RELEASE|knowledge/i.test(`${v.code}@${v.path}`) || v.path.startsWith(`approvals.records.${knowledge?.approvalId}`)), JSON.stringify(r.blocking)).toBe(true);
    // With the snapshot digest known (what WP-20's pinned snapshot will provide) production passes too.
    expect(evaluateDeployability(config, ctx({ knowledgeSnapshotDigest: "d".repeat(64) })).blocking).toEqual([]);
  });
});

describe("audit exporter unit: cross-environment key separation at startup [FO-14-56][AUTH-02]", () => {
  beforeAll(() => ensurePolicyBundle());

  it("[FO-14-56][AUTH-02] adversarial: another committed environment's signing key equal to this environment's approval trust anchor, its anchor equal to this environment's audit manifest key, or its manifest key equal to this one refuses the audit unit at startup; the control boots the guard clean", async () => {
    const root = mkdtempSync(join(tmpdir(), "vsp-audit-unit-"));
    const configDir = join(root, "config");
    const repoRoot = join(root, "repo");
    mkdirSync(configDir);
    mkdirSync(join(repoRoot, "approvals"), { recursive: true });
    try {
      const { logger } = createMemoryLogger();
      const probe = loadPlatformConfig({ environment: "staging", env: {} }).config;
      const pins = await auditUnitStartupInputs({ ...probe, policy: { ...probe.policy, expectedVersion: null, expectedDigest: null } }, { environment: "staging", clock, logger, env: {}, kms: noKms, releaseImageDigest: IMAGE });
      if (!pins.loadedPolicy || !pins.toolCatalogDigest) throw new Error("the unit did not load the policy bundle or the catalogue");
      // This environment: anchor key(9), assertion key(1), audit manifest key(3) (complete staging configuration).
      writeFileSync(join(configDir, "staging.json"), JSON.stringify(completeConfig("staging", { policy: pins.loadedPolicy, catalog: pins.toolCatalogDigest })));
      for (const scope of [...REQUIRED_APPROVALS_BY_ENVIRONMENT.staging, "MODEL_VOICE_SELECTION" as const]) {
        const record = approval(scope, "staging", scope === "MODEL_VOICE_SELECTION" ? { modelVoice: MODEL } : undefined);
        writeFileSync(join(repoRoot, "approvals", `${record.approvalId}.json`), JSON.stringify(record));
      }
      // KMS GetPublicKey over in-memory SYNTHETIC keys: the anchor is the approvals' signing key; every key has its own material.
      const material: Record<string, KeyObject> = { [key(9)]: KEYS.publicKey, [key(1)]: generateKeyPairSync("ed25519").publicKey, [key(3)]: generateKeyPairSync("ed25519").publicKey };
      const kms: KmsPublicKeyClient = {
        send: async (command: unknown) => {
          const k = material[(command as { input: { KeyId: string } }).input.KeyId];
          if (!k) throw new Error("NotFoundException");
          return { PublicKey: new Uint8Array(k.export({ format: "der", type: "spki" })), KeyUsage: "SIGN_VERIFY", KeySpec: "ECC_NIST_P256" };
        },
      };
      const start = async (other: Record<string, unknown>): Promise<string[]> => {
        writeFileSync(join(configDir, "production.json"), JSON.stringify({ environment: "production", ...other }));
        const preliminary = loadPlatformConfig({ environment: "staging", configDir, env: {} }).config;
        const inputs = await auditUnitStartupInputs(preliminary, { environment: "staging", clock, logger, env: {}, configDir, repoRoot, kms, releaseImageDigest: IMAGE });
        try {
          await loadDeployableConfig(inputs);
          return [];
        } catch (err) {
          if (err instanceof ConfigurationRejectedError) return err.violations;
          throw err;
        }
      };
      const separation = (v: string[]) => v.filter((x) => /^(APPROVAL_TRUST_KEY_IS_|AUDIT_MANIFEST_KEY_IS_|ASSERTION_KEY_IS_|SIGNING_KEY_REUSED_|SECRET_REUSED_|RUNTIME_SIGNING_KEY_)/.test(x));
      // Control: the other environment's keys are its own; the unit's guard passes (nothing refused).
      expect(await start({ signing: { assertionKeyRef: key(5) }, approvals: { trustedSigningKeyRef: key(6) } })).toEqual([]);
      // Its runtime (assertion) key is this environment's approval anchor: that runtime could mint staging approvals.
      expect(separation(await start({ signing: { assertionKeyRef: key(9) } }))).toEqual(["APPROVAL_TRUST_KEY_IS_ASSERTION_KEY@environments.production.signing.assertionKeyRef"]);
      // Its anchor is this environment's audit manifest key: this exporter could mint production approvals.
      expect(separation(await start({ approvals: { trustedSigningKeyRef: key(3) } }))).toEqual(["AUDIT_MANIFEST_KEY_IS_APPROVAL_TRUST_KEY@environments.production.approvals.trustedSigningKeyRef"]);
      // Its manifest key is this environment's manifest key.
      expect(separation(await start({ infrastructure: { auditExport: { manifestSigningKeyId: key(3), trustedManifestKeyIds: [key(3)] } } }))).toEqual([
        "SIGNING_KEY_REUSED_ACROSS_ENVIRONMENTS@environments.production.infrastructure.auditExport.manifestSigningKeyId",
        "SIGNING_KEY_REUSED_ACROSS_ENVIRONMENTS@environments.production.infrastructure.auditExport.trustedManifestKeyIds.0",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("audit exporter unit: connector credential separation at startup [AUTH-02][FT-91]", () => {
  beforeAll(() => ensurePolicyBundle());

  it("[AUTH-02][FT-91] adversarial: a connector profile credential of the unit's environment (the profile default credentialRef, a capabilityCredentials[] credentialRef) that is the audit exporter's own database login or the request-hash pepper refuses the audit unit at startup at the profile position (SECRET_REUSED_ACROSS_PURPOSES); the control with distinct secrets boots the guard clean", async () => {
    const root = mkdtempSync(join(tmpdir(), "vsp-audit-unit-connectors-"));
    const configDir = join(root, "config");
    const repoRoot = join(root, "repo");
    mkdirSync(configDir);
    mkdirSync(join(repoRoot, "approvals"), { recursive: true });
    mkdirSync(join(repoRoot, "connectors"));
    try {
      const { logger } = createMemoryLogger();
      const probe = loadPlatformConfig({ environment: "staging", env: {} }).config;
      const pins = await auditUnitStartupInputs({ ...probe, policy: { ...probe.policy, expectedVersion: null, expectedDigest: null } }, { environment: "staging", clock, logger, env: {}, kms: noKms, releaseImageDigest: IMAGE });
      if (!pins.loadedPolicy || !pins.toolCatalogDigest) throw new Error("the unit did not load the policy bundle or the catalogue");
      // This environment's secrets include the exporter login secret("staging", "audit-exporter") and the request-hash pepper
      // secret("staging", "pepper"); the connector profiles the worker runs are read from <repoRoot>/connectors.
      const config = { ...completeConfig("staging", { policy: pins.loadedPolicy, catalog: pins.toolCatalogDigest }), connectors: { profileDirectory: "connectors", feeds: [] } };
      writeFileSync(join(configDir, "staging.json"), JSON.stringify(config));
      for (const scope of [...REQUIRED_APPROVALS_BY_ENVIRONMENT.staging, "MODEL_VOICE_SELECTION" as const]) {
        const record = approval(scope, "staging", scope === "MODEL_VOICE_SELECTION" ? { modelVoice: MODEL } : undefined);
        writeFileSync(join(repoRoot, "approvals", `${record.approvalId}.json`), JSON.stringify(record));
      }
      // KMS GetPublicKey over in-memory SYNTHETIC keys: the anchor is the approvals' signing key; every key has its own material.
      const material: Record<string, KeyObject> = { [key(9)]: KEYS.publicKey, [key(1)]: generateKeyPairSync("ed25519").publicKey, [key(3)]: generateKeyPairSync("ed25519").publicKey };
      const kms: KmsPublicKeyClient = {
        send: async (command: unknown) => {
          const k = material[(command as { input: { KeyId: string } }).input.KeyId];
          if (!k) throw new Error("NotFoundException");
          return { PublicKey: new Uint8Array(k.export({ format: "der", type: "spki" })), KeyUsage: "SIGN_VERIFY", KeySpec: "ECC_NIST_P256" };
        },
      };
      // The unit's guard over the SYNTHETIC emulated-vendor profile with the given credentials.
      const start = async (o: Parameters<typeof emulatorProfile>[0]): Promise<string[]> => {
        writeFileSync(join(repoRoot, "connectors", "vendor.json"), JSON.stringify(emulatorProfile(o)));
        const preliminary = loadPlatformConfig({ environment: "staging", configDir, env: {} }).config;
        const inputs = await auditUnitStartupInputs(preliminary, { environment: "staging", clock, logger, env: {}, configDir, repoRoot, kms, releaseImageDigest: IMAGE });
        try {
          await loadDeployableConfig(inputs);
          return [];
        } catch (err) {
          if (err instanceof ConfigurationRejectedError) return err.violations;
          throw err;
        }
      };
      const read = secret("staging", "connector-read");
      const write = secret("staging", "connector-write");
      const at = `connectors.credentials.staging.profile:${PROFILE_ID}`;
      // A refused unit lists every violation (non-blocking ones too): the secret and credential separation ones are compared.
      const separation = (v: string[]) => v.filter((x) => /^(SECRET_REUSED_|CREDENTIAL_REUSED_|AUDIENCE_REUSED_)/.test(x));
      // Control: the profile's credentials are secrets of their own; the unit's guard passes (nothing refused).
      expect(await start({ readRef: read, writeRef: write })).toEqual([]);
      // The profile's default credentialRef is the exporter's own database login: the worker would hold the audit exporter's identity.
      const login = await start({ readRef: read, writeRef: write, mutate: (p) => ({ ...p, credentialRef: secret("staging", "audit-exporter") }) });
      expect(separation(login)).toEqual([`SECRET_REUSED_ACROSS_PURPOSES@${at}:default:READ`]);
      // A capabilityCredentials[] WRITE credential is the request-hash pepper: the gateway, which reads the pepper, could write to the vendor.
      const pepper = await start({ readRef: read, writeRef: secret("staging", "pepper") });
      expect(separation(pepper)).toEqual([`SECRET_REUSED_ACROSS_PURPOSES@${at}:scheduling.appointments_write:WRITE`]);
      // Codes and paths only, never the reference.
      expect(JSON.stringify([...login, ...pepper])).not.toMatch(/arn:aws/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
