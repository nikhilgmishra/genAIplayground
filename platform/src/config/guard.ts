/**
 * Deployment configuration guard (OPS-04, OPS-05, OPS-06, DATA-01; spec section 16).
 *
 * `evaluateDeployability` returns every violation for the configuration's
 * environment; `assertDeployable` throws ConfigurationRejectedError when there
 * is any. Rule sets:
 *
 *  - offline (local, ci): synthetic fixtures only. Live adapters, PHI endpoints and
 *    PHI_PROCESSING scopes are rejected so no PHI or paid vendor traffic can be
 *    reached from developer machines or CI.
 *  - sandbox: fixtures remain allowed for systems not yet approved, but PHI must be
 *    impossible (no PHI_PROCESSING scope in use, PHI endpoints off) and every live
 *    adapter must reference a valid, signed VENDOR_SANDBOX_INTEGRATION approval and
 *    carry a real endpoint and credential reference.
 *  - full (staging, production): no fixtures anywhere, credentials present and not
 *    placeholders, model/voice approved, policy and tool catalogue pinned and equal
 *    to what is loaded, strict CORS, audit on with the Object Lock sink, retention
 *    set by counsel, security-approved verification values, KMS-backed signing and
 *    approval trust, and every required approval present, signed, unexpired and
 *    issued for this environment.
 *
 * Every approval is additionally bound (OPS-APPR-01): its approver role must be
 * allowed for its scope, and a subject-bound scope (MODEL_VOICE_SELECTION,
 * POLICY_RELEASE, KNOWLEDGE_RELEASE, CLINICAL_SCRIPTS, PRODUCTION_DEPLOYMENT,
 * PILOT_EXPOSURE) only counts when its signed `subject` equals the active
 * model/voice/agentConfig, the loaded policy bundle, and the knowledge snapshot,
 * template catalogue and image digests the composition supplies. A record that
 * names another artifact, or one the composition cannot state, never counts.
 *
 * Violation strings are `<CODE>@<config path>`: reason codes and configuration keys
 * only, never configuration values, credential references or approver names.
 */
import type { KeyObject } from "node:crypto";
import type { ApprovalRecord, ApprovalScope, Environment } from "../protocol/index.js";
import { ConfigurationRejectedError } from "../shared/errors.js";
import { evaluateApproval, parseTrustedPublicKey } from "./approvals.js";
import type { ApprovalEvaluation, ApprovalSubjectExpectations } from "./approvals.js";
import type { PlatformConfig } from "./ports.js";
import { PlatformConfigSchema } from "./schema.js";

export type RuleSet = "offline" | "sandbox" | "full";

export const RULE_SET_BY_ENVIRONMENT: Readonly<Record<Environment, RuleSet>> = {
  local: "offline",
  ci: "offline",
  sandbox: "sandbox",
  staging: "full",
  production: "full",
};

/** Minimum approvals per environment. Configuration may add scopes, never remove these. */
export const REQUIRED_APPROVALS_BY_ENVIRONMENT: Readonly<Record<Environment, readonly ApprovalScope[]>> = {
  local: [],
  ci: [],
  sandbox: [],
  staging: ["VENDOR_SANDBOX_INTEGRATION", "SECURITY_REVIEW"],
  production: [
    "PHI_PROCESSING",
    "PRODUCTION_DEPLOYMENT",
    "SECURITY_REVIEW",
    "CLINICAL_SCRIPTS",
    "RETENTION_SCHEDULE",
    "MODEL_VOICE_SELECTION",
    "POLICY_RELEASE",
    "KNOWLEDGE_RELEASE",
  ],
};

export interface GuardContext {
  /** Approval records loaded from the approvals directory (see approvals.ts). */
  approvals: ApprovalRecord[];
  /**
   * Trusted approval-signing PUBLIC key resolved from `approvals.trustedSigningKeyRef`
   * (KeyObject or PEM). Absent or null: every approval is UNVERIFIED.
   */
  trustedApprovalKey?: KeyObject | string | null;
  /** `kind` of every adapter/store actually instantiated at startup, keyed by component. */
  adapterKinds: Record<string, "local_fixture" | "live">;
  /** Version and digest of the policy bundle actually loaded. */
  loadedPolicy: { version: string; digest: string } | null;
  /** Digest of the tool catalogue actually loaded. */
  toolCatalogDigest: string | null;
  /**
   * OPS-APPR-01: digests of the artifacts this process will actually serve, used to
   * prove that subject-bound approvals (approvals.ts SUBJECT_KIND_BY_SCOPE) name them.
   * Absent/null: a required KNOWLEDGE_RELEASE / CLINICAL_SCRIPTS / PRODUCTION_DEPLOYMENT
   * record is SUBJECT_UNVERIFIABLE (fail closed). The model/voice subject is compared
   * with `models.active` and the policy subject with `loadedPolicy`.
   */
  knowledgeSnapshotDigest?: string | null;
  /** Digest of the caller-facing template catalogue loaded (voice registry digest()). */
  templateCatalogDigest?: string | null;
  /** Digest (`sha256:<hex>`) of the container image this process runs. */
  releaseImageDigest?: string | null;
  now: Date;
  /** Approval files that failed strict parsing (from loadApprovalRecords). */
  rejectedApprovalFiles?: readonly { file: string; reasonCode: string }[];
  /** Duplicate approval ids found while loading. */
  duplicateApprovalIds?: readonly string[];
}

export interface GuardViolation {
  code: string;
  path: string;
}

export interface GuardReport {
  environment: Environment;
  ruleSet: RuleSet;
  deployable: boolean;
  violations: GuardViolation[];
  approvals: ApprovalEvaluation[];
  requiredApprovals: { scope: ApprovalScope; satisfiedBy: string | null }[];
  /** True only when the full rule set passed and a valid PHI_PROCESSING approval covers enabled PHI endpoints. */
  phiEndpointsPermitted: boolean;
}

export const formatViolation = (v: GuardViolation): string => `${v.code}@${v.path}`;

const PLACEHOLDER = /PLACEHOLDER|:REGION:|:ACCOUNT:/;
const isPlaceholder = (v: string | null | undefined): boolean => typeof v === "string" && PLACEHOLDER.test(v);
const isLocalRef = (v: string | null | undefined): boolean => typeof v === "string" && (v.startsWith("local-fixture:") || v.startsWith("file:"));
const REAL_ARN = /^arn:aws:(secretsmanager|kms|ssm):[a-z]{2}(-[a-z]+)+-\d:\d{12}:/;
const KMS_KEY_ARN = /^arn:aws:kms:[a-z]{2}(-[a-z]+)+-\d:\d{12}:key\/[A-Za-z0-9-]+$/;
const RESERVED_TLDS = [".invalid", ".test", ".localhost", ".local", ".example", ".internal"];

function tryUrl(s: string): URL | null {
  try {
    return new URL(s);
  } catch {
    return null;
  }
}

function nonRoutableHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "localhost" || RESERVED_TLDS.some((t) => h.endsWith(t)) || /^\d{1,3}(\.\d{1,3}){3}$/.test(h);
}

class Collector {
  readonly list: GuardViolation[] = [];
  add(code: string, path: string): void {
    if (!this.list.some((v) => v.code === code && v.path === path)) this.list.push({ code, path });
  }
}

function resolveKey(key: GuardContext["trustedApprovalKey"]): KeyObject | null | "INVALID" {
  if (key === undefined || key === null) return null;
  if (typeof key === "string") {
    try {
      return parseTrustedPublicKey(key);
    } catch {
      return "INVALID";
    }
  }
  return key.type === "public" ? key : "INVALID";
}

export function evaluateDeployability(config: PlatformConfig, ctx: GuardContext): GuardReport {
  const v = new Collector();
  const parsed = PlatformConfigSchema.safeParse(config);
  const environment = config.environment;
  const ruleSet = RULE_SET_BY_ENVIRONMENT[environment] ?? "full";
  if (!parsed.success) {
    v.add("CONFIG_SCHEMA_INVALID", "$");
    return { environment, ruleSet, deployable: false, violations: v.list, approvals: [], requiredApprovals: [], phiEndpointsPermitted: false };
  }

  // ---------- approvals: evaluate every record once ----------
  const key = resolveKey(ctx.trustedApprovalKey);
  if (key === "INVALID") v.add("APPROVAL_TRUST_KEY_INVALID", "approvals.trustedSigningKeyRef");
  const trustedKey = key === "INVALID" ? null : key;
  // OPS-APPR-01: a record only counts when its signed subject names what is configured/loaded.
  const expected: ApprovalSubjectExpectations = {
    modelVoice: config.models.active,
    policyBundle: ctx.loadedPolicy ? { version: ctx.loadedPolicy.version, digest: ctx.loadedPolicy.digest } : null,
    knowledgeSnapshotDigest: ctx.knowledgeSnapshotDigest ?? null,
    templateCatalogDigest: ctx.templateCatalogDigest ?? null,
    releaseImageDigest: ctx.releaseImageDigest ?? null,
  };
  const evaluations = ctx.approvals.map((r) => evaluateApproval(r, { environment, now: ctx.now, trustedKey, expected }));
  const byId = new Map(evaluations.map((e) => [e.approvalId, e]));
  const validFor = (scope: ApprovalScope) => evaluations.filter((e) => e.scope === scope && e.status === "VALID");
  /** A specific referenced approval must exist, have the expected scope and be VALID. */
  const referencedValid = (id: string | null | undefined, scope: ApprovalScope): boolean => {
    if (!id) return false;
    const e = byId.get(id);
    return !!e && e.scope === scope && e.status === "VALID";
  };

  universalRules(config, ctx, v);
  if (ruleSet !== "offline") consoleWorkforceFixtureRule(config, ctx, v);
  if (ruleSet === "offline") offlineRules(config, ctx, v);
  else if (ruleSet === "sandbox") sandboxRules(config, ctx, v, { referencedValid, hasTrustKey: trustedKey !== null });
  else fullRules(config, ctx, v, { referencedValid, hasTrustKey: trustedKey !== null });

  // ---------- required approvals ----------
  const floor = REQUIRED_APPROVALS_BY_ENVIRONMENT[environment];
  for (const scope of floor) {
    if (!config.approvals.required.includes(scope)) v.add("APPROVAL_REQUIREMENT_BELOW_FLOOR", `approvals.required.${scope}`);
  }
  const required = [...new Set<ApprovalScope>([...floor, ...config.approvals.required])];
  const requiredApprovals = required.map((scope) => {
    const ok = validFor(scope);
    if (ok.length === 0) {
      v.add("APPROVAL_MISSING", `approvals.required.${scope}`);
      for (const e of evaluations.filter((x) => x.scope === scope)) {
        for (const f of e.failures) v.add(`APPROVAL_${f}`, `approvals.records.${e.approvalId}`);
      }
    }
    return { scope, satisfiedBy: ok[0]?.approvalId ?? null };
  });
  if (required.length > 0 && !config.approvals.trustedSigningKeyRef) v.add("APPROVAL_TRUST_KEY_MISSING", "approvals.trustedSigningKeyRef");
  if (required.length > 0 && config.approvals.trustedSigningKeyRef && trustedKey === null && key !== "INVALID") {
    v.add("APPROVAL_TRUST_KEY_UNRESOLVED", "approvals.trustedSigningKeyRef");
  }
  for (const f of ctx.rejectedApprovalFiles ?? []) v.add(f.reasonCode, `approvals.files.${f.file}`);
  for (const id of ctx.duplicateApprovalIds ?? []) v.add("APPROVAL_DUPLICATE_ID", `approvals.records.${id}`);

  const phiEnabled = config.phi?.endpointsEnabled === true;
  const phiApproved = validFor("PHI_PROCESSING").length > 0;
  if (phiEnabled && ruleSet === "full" && !phiApproved) v.add("PHI_ENDPOINTS_UNAPPROVED", "phi.endpointsEnabled");

  const violations = v.list;
  return {
    environment,
    ruleSet,
    deployable: violations.length === 0,
    violations,
    approvals: evaluations,
    requiredApprovals,
    phiEndpointsPermitted: ruleSet === "full" && violations.length === 0 && phiEnabled && phiApproved,
  };
}

/** Throws ConfigurationRejectedError when the configuration has any violation for its environment. */
export function assertDeployable(config: PlatformConfig, ctx: GuardContext): GuardReport {
  const report = evaluateDeployability(config, ctx);
  if (!report.deployable) throw new ConfigurationRejectedError(report.violations.map(formatViolation));
  return report;
}

// ---------------------------------------------------------------------------
// Rule sets
// ---------------------------------------------------------------------------

function universalRules(config: PlatformConfig, ctx: GuardContext, v: Collector): void {
  // Trusted destinations (SAFE-05, SAFE-02, OPS-02): structure must be sound everywhere.
  const ids = new Set<string>();
  for (const [i, d] of config.destinations.entries()) {
    if (ids.has(d.destinationId)) v.add("DESTINATION_DUPLICATE_ID", `destinations.${i}`);
    ids.add(d.destinationId);
  }
  for (const [i, d] of config.destinations.entries()) {
    for (const f of d.fallbackDestinationIds) {
      if (f === d.destinationId) v.add("DESTINATION_FALLBACK_SELF", `destinations.${i}.fallbackDestinationIds`);
      else if (!ids.has(f)) v.add("DESTINATION_FALLBACK_UNKNOWN", `destinations.${i}.fallbackDestinationIds`);
    }
  }
  const purposes = new Set(config.destinations.map((d) => d.purpose));
  if (!purposes.has("SAFETY_PRIORITY")) v.add("DESTINATION_SAFETY_ROUTE_MISSING", "destinations");
  if (!purposes.has("STANDARD_SUPPORT")) v.add("DESTINATION_HUMAN_ROUTE_MISSING", "destinations");
  if (!purposes.has("OUTAGE_CONTINUITY")) v.add("DESTINATION_CONTINUITY_ROUTE_MISSING", "destinations");

  // Declared adapter kinds must match what was actually instantiated.
  for (const [name, a] of Object.entries(config.adapters)) {
    const runtime = Object.hasOwn(ctx.adapterKinds, name) ? ctx.adapterKinds[name] : undefined;
    if (runtime !== undefined && runtime !== a.kind) v.add("ADAPTER_KIND_MISMATCH", `adapters.${name}`);
  }
  if (config.ops && config.ops.admission.safetyReserveSessions > config.ops.admission.maxConcurrentAiSessions) {
    v.add("OPS_SAFETY_RESERVE_EXCEEDS_CAPACITY", "ops.admission.safetyReserveSessions");
  }
}

/** Workforce IdP adapter key (platform/config/*.json) and the console's local sign-in runtime component. */
export const WORKFORCE_IDP_ADAPTER_KEY = "workforce-sso";
export const CONSOLE_LOCAL_SIGN_IN_COMPONENT = "console-local-sign-in";

/**
 * OPS-04 (console): outside local/ci — including sandbox, where other fixtures may
 * remain — the console's local workforce sign-in routes and a local_fixture
 * workforce IdP must never run: they would mint staff tokens for SYNTHETIC
 * identities without SSO or MFA evidence. The RUNTIME components are rejected in
 * every non-offline environment (the console also refuses to construct them,
 * console-api assertConsoleDeps). The DECLARED adapter kind is additionally
 * rejected in staging/production; in sandbox the declared check is not applied
 * because sandbox keeps fixtures for not-yet-approved systems (OPS-05 semantics).
 */
function consoleWorkforceFixtureRule(config: PlatformConfig, ctx: GuardContext, v: Collector): void {
  const ruleSet = RULE_SET_BY_ENVIRONMENT[config.environment] ?? "full";
  if (ruleSet === "full" && config.adapters[WORKFORCE_IDP_ADAPTER_KEY]?.kind === "local_fixture") {
    v.add("WORKFORCE_IDP_LOCAL_FIXTURE_OUTSIDE_OFFLINE", `adapters.${WORKFORCE_IDP_ADAPTER_KEY}`);
  }
  if (Object.hasOwn(ctx.adapterKinds, WORKFORCE_IDP_ADAPTER_KEY) && ctx.adapterKinds[WORKFORCE_IDP_ADAPTER_KEY] === "local_fixture") {
    v.add("WORKFORCE_IDP_LOCAL_FIXTURE_OUTSIDE_OFFLINE", `runtime.${WORKFORCE_IDP_ADAPTER_KEY}`);
  }
  if (Object.hasOwn(ctx.adapterKinds, CONSOLE_LOCAL_SIGN_IN_COMPONENT)) v.add("CONSOLE_LOCAL_SIGN_IN_OUTSIDE_OFFLINE", `runtime.${CONSOLE_LOCAL_SIGN_IN_COMPONENT}`);
}

function offlineRules(config: PlatformConfig, ctx: GuardContext, v: Collector): void {
  for (const [name, a] of Object.entries(config.adapters)) {
    if (a.kind === "live") v.add("OFFLINE_LIVE_ADAPTER_FORBIDDEN", `adapters.${name}`);
  }
  for (const [name, kind] of Object.entries(ctx.adapterKinds)) {
    if (kind === "live") v.add("OFFLINE_LIVE_ADAPTER_FORBIDDEN", `runtime.${safeKey(name)}`);
  }
  if (config.audit.sink === "s3_object_lock") v.add("OFFLINE_LIVE_AUDIT_SINK_FORBIDDEN", "audit.sink");
  if (config.phi?.endpointsEnabled) v.add("PHI_ENDPOINTS_FORBIDDEN_IN_ENVIRONMENT", "phi.endpointsEnabled");
  noPhiScope(config, ctx, v);
}

interface Lookups {
  referencedValid: (id: string | null | undefined, scope: ApprovalScope) => boolean;
  hasTrustKey: boolean;
}

function sandboxRules(config: PlatformConfig, ctx: GuardContext, v: Collector, l: Lookups): void {
  if (config.phi?.endpointsEnabled) v.add("PHI_ENDPOINTS_FORBIDDEN_IN_ENVIRONMENT", "phi.endpointsEnabled");
  noPhiScope(config, ctx, v);
  let anyLive = false;
  for (const [name, a] of Object.entries(config.adapters)) {
    if (a.kind !== "live") continue;
    anyLive = true;
    if (!l.referencedValid(a.integrationApprovalId, "VENDOR_SANDBOX_INTEGRATION")) v.add("SANDBOX_LIVE_ADAPTER_UNAPPROVED", `adapters.${name}`);
    liveAdapterRules(name, a, v, l);
  }
  for (const [name, kind] of Object.entries(ctx.adapterKinds)) {
    if (kind === "live" && !Object.hasOwn(config.adapters, name)) v.add("SANDBOX_LIVE_COMPONENT_UNDECLARED", `runtime.${safeKey(name)}`);
  }
  if (anyLive && !config.approvals.trustedSigningKeyRef) v.add("APPROVAL_TRUST_KEY_MISSING", "approvals.trustedSigningKeyRef");
  if (!config.audit.enabled) v.add("AUDIT_DISABLED", "audit.enabled");
  corsRules(config, v);
  sessionBindingRule(config, v, l);
}

function fullRules(config: PlatformConfig, ctx: GuardContext, v: Collector, l: Lookups): void {
  const t = config.tenantId.toLowerCase();
  if (t.includes("synth")) v.add("TENANT_SYNTHETIC_FIXTURE", "tenantId");
  if (isPlaceholder(config.tenantId)) v.add("TENANT_PLACEHOLDER", "tenantId");

  // Fixtures anywhere (OPS-04).
  for (const [name, a] of Object.entries(config.adapters)) {
    if (a.kind === "local_fixture") v.add("ADAPTER_LOCAL_FIXTURE", `adapters.${name}`);
    else liveAdapterRules(name, a, v, l);
  }
  for (const [name, kind] of Object.entries(ctx.adapterKinds)) {
    if (kind === "local_fixture") v.add("ADAPTER_RUNTIME_LOCAL_FIXTURE", `runtime.${safeKey(name)}`);
  }
  if (config.sessionStore.kind === "memory") v.add("SESSION_STORE_MEMORY", "sessionStore.kind");
  else if (!config.sessionStore.tableName) v.add("SESSION_STORE_TABLE_MISSING", "sessionStore.tableName");
  else if (isPlaceholder(config.sessionStore.tableName)) v.add("SESSION_STORE_TABLE_PLACEHOLDER", "sessionStore.tableName");
  if (config.database.engine === "pglite") v.add("DATABASE_ENGINE_PGLITE", "database.engine");
  refRule(config.database.connectionRef, "database.connectionRef", "DATABASE_CONNECTION_REF", v);
  if (config.audit.sink === "local_fixture") v.add("AUDIT_SINK_LOCAL_FIXTURE", "audit.sink");
  if (!config.audit.enabled) v.add("AUDIT_DISABLED", "audit.enabled");

  // Pinned, reviewable versions (OPS-06).
  const active = config.models.active;
  const approved = config.models.approved.find((m) => m.model === active.model && m.voice === active.voice);
  if (!approved) v.add("MODEL_VOICE_NOT_APPROVED", "models.active");
  else if (!approved.approvalId) v.add("MODEL_VOICE_APPROVAL_MISSING", "models.approved");
  else if (!l.referencedValid(approved.approvalId, "MODEL_VOICE_SELECTION")) v.add("MODEL_VOICE_APPROVAL_INVALID", "models.approved");
  if (!config.policy.expectedVersion) v.add("POLICY_VERSION_UNPINNED", "policy.expectedVersion");
  if (!config.policy.expectedDigest) v.add("POLICY_DIGEST_UNPINNED", "policy.expectedDigest");
  if (!ctx.loadedPolicy) v.add("POLICY_BUNDLE_NOT_LOADED", "policy.bundlePath");
  else {
    if (config.policy.expectedVersion && ctx.loadedPolicy.version !== config.policy.expectedVersion) v.add("POLICY_VERSION_MISMATCH", "policy.expectedVersion");
    if (config.policy.expectedDigest && ctx.loadedPolicy.digest !== config.policy.expectedDigest) v.add("POLICY_DIGEST_MISMATCH", "policy.expectedDigest");
  }
  if (!config.toolCatalog.expectedDigest) v.add("TOOL_CATALOG_DIGEST_UNPINNED", "toolCatalog.expectedDigest");
  if (!ctx.toolCatalogDigest) v.add("TOOL_CATALOG_NOT_LOADED", "toolCatalog.expectedDigest");
  else if (config.toolCatalog.expectedDigest && ctx.toolCatalogDigest !== config.toolCatalog.expectedDigest) v.add("TOOL_CATALOG_DIGEST_MISMATCH", "toolCatalog.expectedDigest");

  corsRules(config, v);
  sessionBindingRule(config, v, l);

  // Verification values must be security-approved.
  if (!config.verification.approvedBySecurity) v.add("VERIFICATION_VALUES_UNAPPROVED", "verification.approvedBySecurity");
  else if (!l.referencedValid(config.verification.approvedBySecurity, "SECURITY_REVIEW")) v.add("VERIFICATION_APPROVAL_INVALID", "verification.approvedBySecurity");

  // Retention durations are set by counsel; never invented here.
  for (const [cls, days] of Object.entries(config.retention)) {
    if (days === null) v.add("RETENTION_UNSET", `retention.${cls}`);
  }

  // Signing keys.
  if (config.signing.localDevKey) v.add("SIGNING_LOCAL_DEV_KEY", "signing.localDevKey");
  refRule(config.signing.assertionKeyRef, "signing.assertionKeyRef", "SIGNING_KEY_REF", v);
  const trustRef = config.approvals.trustedSigningKeyRef;
  if (trustRef && !KMS_KEY_ARN.test(trustRef)) v.add("APPROVAL_TRUST_KEY_REF_NOT_KMS", "approvals.trustedSigningKeyRef");

  for (const [i, d] of config.destinations.entries()) {
    if (isPlaceholder(d.vendorQueueRef)) v.add("DESTINATION_VENDOR_REF_PLACEHOLDER", `destinations.${i}.vendorQueueRef`);
  }
  if (!config.ops) v.add("OPS_CONFIG_MISSING", "ops");
}

function liveAdapterRules(name: string, a: PlatformConfig["adapters"][string], v: Collector, l: Lookups): void {
  const path = `adapters.${name}`;
  if (!a.endpoint) v.add("ADAPTER_ENDPOINT_MISSING", `${path}.endpoint`);
  else {
    const url = tryUrl(a.endpoint);
    if (!url) v.add("ADAPTER_ENDPOINT_INVALID", `${path}.endpoint`);
    else {
      if (url.protocol !== "https:") v.add("ADAPTER_ENDPOINT_NOT_HTTPS", `${path}.endpoint`);
      if (nonRoutableHost(url.hostname)) v.add("ADAPTER_ENDPOINT_NOT_ROUTABLE", `${path}.endpoint`);
      if (isPlaceholder(a.endpoint)) v.add("ADAPTER_ENDPOINT_PLACEHOLDER", `${path}.endpoint`);
    }
  }
  if (a.authMethod === "none") v.add("ADAPTER_AUTH_NONE", `${path}.authMethod`);
  refRule(a.credentialRef, `${path}.credentialRef`, "ADAPTER_CREDENTIAL", v);
  if (a.authMethod === "bearer_static_exception" && !l.referencedValid(a.exceptionApprovalId, "STATIC_CREDENTIAL_EXCEPTION")) {
    v.add("STATIC_CREDENTIAL_EXCEPTION_UNAPPROVED", `${path}.exceptionApprovalId`);
  }
}

/** Secret references must be present, real (not placeholders) and not local fixtures. */
function refRule(ref: string | null, path: string, prefix: string, v: Collector): void {
  if (!ref) v.add(`${prefix}_MISSING`, path);
  else if (isPlaceholder(ref)) v.add(`${prefix}_PLACEHOLDER`, path);
  else if (isLocalRef(ref)) v.add(`${prefix}_LOCAL`, path);
  else if (!REAL_ARN.test(ref)) v.add(`${prefix}_INVALID`, path);
}

function corsRules(config: PlatformConfig, v: Collector): void {
  for (const [i, origin] of config.cors.allowedOrigins.entries()) {
    const path = `cors.allowedOrigins.${i}`;
    if (origin.includes("*")) {
      v.add("CORS_WILDCARD", path);
      continue;
    }
    const url = tryUrl(origin);
    if (!url) {
      v.add("CORS_ORIGIN_INVALID", path);
      continue;
    }
    if (url.protocol !== "https:") v.add("CORS_NON_HTTPS_ORIGIN", path);
    if (url.origin !== origin) v.add("CORS_ORIGIN_NOT_EXACT", path);
    if (nonRoutableHost(url.hostname)) v.add("CORS_ORIGIN_NOT_ROUTABLE", path);
  }
}

function sessionBindingRule(config: PlatformConfig, v: Collector, l: Lookups): void {
  if (config.sessionBinding.mode === "tool_argument_lookup_exception" && !l.referencedValid(config.sessionBinding.exceptionApprovalId, "SECURITY_REVIEW")) {
    v.add("SESSION_BINDING_EXCEPTION_UNAPPROVED", "sessionBinding.exceptionApprovalId");
  }
}

function noPhiScope(config: PlatformConfig, ctx: GuardContext, v: Collector): void {
  if (config.approvals.required.includes("PHI_PROCESSING")) v.add("PHI_SCOPE_NOT_PERMITTED_IN_ENVIRONMENT", "approvals.required.PHI_PROCESSING");
  for (const r of ctx.approvals) {
    if (r.scope === "PHI_PROCESSING" && r.environment === config.environment) v.add("PHI_SCOPE_NOT_PERMITTED_IN_ENVIRONMENT", `approvals.records.${r.approvalId}`);
  }
}

const safeKey = (k: string): string => (/^[A-Za-z0-9_-]{1,64}$/.test(k) ? k : "unnamed");

/** Convenience for runtime code paths: PHI endpoints are usable only when the guard explicitly permitted them. */
export function phiEndpointsPermitted(report: GuardReport | null | undefined): boolean {
  return report?.phiEndpointsPermitted === true;
}
