/**
 * Shared types and helpers of the deployment guard's rule files (WP-07; OPS-04, OPS-05, DATA-01).
 *
 * Every rule file under platform/src/config/rules/ exports one `GuardRule` that the registry (index.ts) lists;
 * the guard (../guard.ts) runs the rules whose rule set applies. A rule reports through the `Collector`:
 *
 *   v.add(code, path)                              a BLOCKING violation: the environment is not deployable
 *   v.capability(capabilityId, component, code, path)
 *                                                  a CAPABILITY violation: a tenant input of one capability is
 *                                                  missing or invalid, so that capability (and only it) is
 *                                                  NOT_CONFIGURED in the activation map; the environment still
 *                                                  starts and the capability's gate refuses its work.
 *
 * Violations carry reason codes and configuration paths only (DATA-01): never values, references or names.
 */
import type { KeyObject } from "node:crypto";
import type { EnvironmentCredentialSet } from "../../connectors/profile/credentials.js";
import type { RuntimeCapabilityId } from "../../observability/composition-catalog.js";
import { isEmulatorHost } from "../../shared/emulator-hosts.js";
import type { ApprovalRecord, ApprovalScope, Environment } from "../../protocol/index.js";
import type { ApprovalEvaluation } from "../approvals.js";
import type { PlatformConfig } from "../ports.js";

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
  /**
   * Connector profiles of this environment plus the adapter references of every committed environment
   * (connectors/profile/credentials.ts). Absent: the credential separation rule has nothing to compare.
   */
  connectorCredentialSets?: readonly EnvironmentCredentialSet[];
  /**
   * Key and secret references of every OTHER committed environment configuration (platform/config/<env>.json):
   * the runtime assertion key, the audit manifest keys, the approval trust anchor and the secrets
   * (main/live-modules.ts committedSigningKeySets). The key separation rule refuses, in both directions, a key one
   * environment's runtime signs with that another environment trusts as its approval anchor, a signing key or a
   * secret shared between environments. Absent: those cross-environment comparisons have nothing to compare.
   */
  committedSigningKeys?: readonly CommittedSigningKeys[];
  /**
   * PUBLIC keys of this environment's runtime signing keys (the assertion key and the audit manifest keys),
   * resolved by startup.ts (GetPublicKey for a key ARN, a bare key id or an mrk- id), keyed by configuration path.
   * The key separation rule compares their key material with the trust anchor's and with each other, so two key
   * ids holding the same (imported) key material are one key. PRESENT (even empty): every configured runtime
   * signing key must be in it, otherwise the environment is refused (RUNTIME_SIGNING_KEY_UNRESOLVED, fail closed)
   * and the trust anchor is not used. Absent: the composition did not resolve keys; only references are compared.
   */
  runtimeSigningPublicKeys?: readonly { path: string; key: KeyObject }[];
}

/** Key and secret references of one committed environment configuration (references only; never reported). */
export interface CommittedSigningKeys {
  environment: Environment;
  assertionKeyRef: string | null;
  manifestSigningKeyId: string | null;
  trustedManifestKeyIds: readonly string[];
  /** `approvals.trustedSigningKeyRef` of that environment (absent: not compared). */
  approvalTrustKeyRef?: string | null;
  /** Its secret references, by configuration path (key-separation.ts secretUses; absent: not compared). */
  secrets?: readonly SecretUse[];
}

/** One secret reference of a configuration, with the path it is configured at and the purpose it serves. */
export interface SecretUse {
  ref: string;
  path: string;
  /**
   * `database-login`, `request-hash-pepper`, `otp-pepper`, `console-session-sealer`, `audit-exporter-login`,
   * `audit-verifier-login`, `adapter:<key>` or `connector:<profileId>:<capability>:<access>` (a connector profile
   * credential; `default:READ` for the profile's default credential).
   */
  purpose: string;
}

export interface GuardViolation {
  code: string;
  path: string;
}

/** A violation that makes one capability NOT_CONFIGURED instead of refusing the environment. */
export interface CapabilityViolation extends GuardViolation {
  capabilityId: RuntimeCapabilityId;
  /** The configured component (adapter key or config block) the violation is about. */
  component: string;
}

/** Approval lookups shared by the rules (evaluated once per guard run). */
export interface Lookups {
  /** A specific referenced approval exists, has the expected scope and is VALID. */
  referencedValid: (id: string | null | undefined, scope: ApprovalScope) => boolean;
  hasTrustKey: boolean;
  /** Every evaluated approval record. */
  evaluations: readonly ApprovalEvaluation[];
  /** VALID records of a scope. */
  validFor: (scope: ApprovalScope) => readonly ApprovalEvaluation[];
  /** The trusted key failed to parse (it is not a usable public key). */
  trustKeyInvalid: boolean;
  /**
   * The trust anchor reference is a key the runtime signs with, or a runtime signing key's material could not be
   * compared with it (key separation, rules/key-separation.ts): the guard did not use it, so no record verifies;
   * the key separation rule reports why.
   */
  trustKeyRefused: boolean;
}

export class Collector {
  readonly list: GuardViolation[] = [];
  readonly capabilityList: CapabilityViolation[] = [];
  private readonly blockingKeys = new Set<string>();

  /** A blocking violation (the environment is not deployable). */
  add(code: string, path: string): void {
    this.record(code, path);
    this.blockingKeys.add(`${code}@${path}`);
  }

  /** A capability violation: `capabilityId` is NOT_CONFIGURED; the environment may still start. */
  capability(capabilityId: RuntimeCapabilityId, component: string, code: string, path: string): void {
    this.record(code, path);
    if (!this.capabilityList.some((v) => v.code === code && v.path === path && v.capabilityId === capabilityId)) this.capabilityList.push({ capabilityId, component, code, path });
  }

  /** Blocking violations, in report order. */
  blocking(): GuardViolation[] {
    return this.list.filter((v) => this.blockingKeys.has(`${v.code}@${v.path}`));
  }

  private record(code: string, path: string): void {
    if (!this.list.some((v) => v.code === code && v.path === path)) this.list.push({ code, path });
  }
}

export interface RuleInput {
  readonly config: PlatformConfig;
  readonly ctx: GuardContext;
  readonly ruleSet: RuleSet;
  readonly v: Collector;
  readonly l: Lookups;
}

export interface GuardRule {
  /** Stable rule id (reported in GuardReport.rulesEvaluated). */
  readonly id: string;
  /** The file under platform/src/config/rules/ that defines it (the registry completeness test checks it). */
  readonly file: string;
  /** Rule sets the rule applies to. */
  readonly ruleSets: readonly RuleSet[];
  evaluate(input: RuleInput): void;
}

export const ALL_RULE_SETS: readonly RuleSet[] = Object.freeze(["offline", "sandbox", "full"]);
export const LIVE_RULE_SETS: readonly RuleSet[] = Object.freeze(["sandbox", "full"]);

// ---------------------------------------------------------------------------
// Value classifiers (they never echo the value into a violation)
// ---------------------------------------------------------------------------

const PLACEHOLDER = /PLACEHOLDER|:REGION:|:ACCOUNT:/;
export const isPlaceholder = (v: string | null | undefined): boolean => typeof v === "string" && PLACEHOLDER.test(v);
export const isLocalRef = (v: string | null | undefined): boolean => typeof v === "string" && (v.startsWith("local-fixture:") || v.startsWith("file:"));
export const REAL_ARN = /^arn:aws:(secretsmanager|kms|ssm):[a-z]{2}(-[a-z]+)+-\d:\d{12}:/;
export const KMS_KEY_ARN = /^arn:aws:kms:[a-z]{2}(-[a-z]+)+-\d:\d{12}:key\/[A-Za-z0-9-]+$/;
const RESERVED_TLDS = [".invalid", ".test", ".localhost", ".local", ".example", ".internal"];

export function tryUrl(s: string): URL | null {
  try {
    return new URL(s);
  } catch {
    return null;
  }
}

export function nonRoutableHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "localhost" || RESERVED_TLDS.some((t) => h.endsWith(t)) || /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.startsWith("[");
}

/** Emulator host names (`.test`, `localhost`, loopback): accepted only where an emulator may stand in (sandbox). */
export const emulatorHost = isEmulatorHost;

export const safeKey = (k: string): string => (/^[A-Za-z0-9_-]{1,64}$/.test(k) ? k : "unnamed");

/** Secret references must be present, real (not placeholders) and not local fixtures. */
export function refProblem(ref: string | null | undefined, prefix: string): string | null {
  if (!ref) return `${prefix}_MISSING`;
  if (isPlaceholder(ref)) return `${prefix}_PLACEHOLDER`;
  if (isLocalRef(ref)) return `${prefix}_LOCAL`;
  if (!REAL_ARN.test(ref)) return `${prefix}_INVALID`;
  return null;
}

// ---------------------------------------------------------------------------
// Reference identity (key and secret separation; never echoed)
// ---------------------------------------------------------------------------

const KMS_KEY_REF = /^arn:aws[a-z-]*:kms:[a-z0-9-]+:\d{12}:key\/([A-Za-z0-9-]+)$/;
const KMS_BARE_KEY_ID = /^(mrk-[0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
const KMS_ALIAS_REF = /^(arn:aws[a-z-]*:kms:[a-z0-9-]+:\d{12}:)?alias\/(.+)$/;
const SECRETS_MANAGER_REF = /^arn:aws[a-z-]*:secretsmanager:([a-z0-9-]+):(\d{12}|[A-Za-z0-9]+):secret:(.+)$/;
const SSM_REF = /^arn:aws[a-z-]*:ssm:([a-z0-9-]+):(\d{12}|[A-Za-z0-9]+):parameter\/?(.+)$/;
/** The six-character suffix Secrets Manager appends to a secret's name in its full ARN. */
const SECRET_ARN_SUFFIX = /-[A-Za-z0-9]{6}$/;

/** A KMS key referenced by an alias (alias name or alias ARN): which key it names is not visible in configuration. */
export const isKmsAliasRef = (ref: string | null | undefined): boolean => typeof ref === "string" && KMS_ALIAS_REF.test(ref);

type RefIdentity = { kind: "kms-key"; id: string } | { kind: "kms-alias"; name: string } | { kind: "secret" | "ssm"; scope: string; name: string } | { kind: "other"; value: string };

function refIdentity(ref: string): RefIdentity {
  const key = KMS_KEY_REF.exec(ref);
  // An ARN and its bare key id are the same key; a multi-region replica (mrk-) shares the key id AND the key
  // material across regions, so the region and the account are not part of a key's identity.
  if (key?.[1]) return { kind: "kms-key", id: key[1].toLowerCase() };
  if (KMS_BARE_KEY_ID.test(ref)) return { kind: "kms-key", id: ref.toLowerCase() };
  const alias = KMS_ALIAS_REF.exec(ref);
  if (alias?.[2]) return { kind: "kms-alias", name: alias[2].toLowerCase() };
  const secret = SECRETS_MANAGER_REF.exec(ref);
  if (secret?.[3]) return { kind: "secret", scope: `${secret[1]}:${secret[2]}`, name: secret[3] };
  const ssm = SSM_REF.exec(ref);
  if (ssm?.[3]) return { kind: "ssm", scope: `${ssm[1]}:${ssm[2]}`, name: ssm[3] };
  return { kind: "other", value: ref };
}

/**
 * True when two references name the same KMS key or the same secret (key and secret separation, AUTH-02):
 * a key ARN and its bare key id match (case-insensitive); two aliases match by name; a full Secrets Manager ARN
 * matches the partial ARN of the same secret (the six-character suffix of the full ARN is ignored, never both
 * sides at once, so `x-prod01` and `x-test01` stay different). Null or empty references never match.
 */
export function sameKeyOrSecret(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const x = refIdentity(a);
  const y = refIdentity(b);
  if (x.kind === "kms-key" && y.kind === "kms-key") return x.id === y.id;
  if (x.kind === "kms-alias" && y.kind === "kms-alias") return x.name === y.name;
  if ((x.kind === "secret" && y.kind === "secret") || (x.kind === "ssm" && y.kind === "ssm")) {
    if (x.scope !== y.scope) return false;
    if (x.name === y.name) return true;
    return x.kind === "secret" && (x.name.replace(SECRET_ARN_SUFFIX, "") === y.name || x.name === y.name.replace(SECRET_ARN_SUFFIX, ""));
  }
  return false;
}

/**
 * One spelling per identity: maps every reference to the first-seen reference of its identity class (the
 * transitive closure of `sameKeyOrSecret`), so a rule that compares references as strings (the connector credential
 * rule, connectors/profile/credentials.ts) sees a full Secrets Manager ARN and the partial ARN of the same secret, or
 * a key ARN and its bare key id, as one reference. The closure may join two names that each match a third (`x`,
 * `x-prod01`, `x-test01`): every reported pair then still shares an identity with some other use (fail closed).
 * References only; never reported.
 */
export function canonicalReferences(refs: readonly string[]): Map<string, string> {
  const unique = [...new Set(refs.filter((r) => typeof r === "string" && r.length > 0))];
  const parent = unique.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r] ?? r;
    let x = i;
    while (parent[x] !== r) {
      const next = parent[x] ?? r;
      parent[x] = r;
      x = next;
    }
    return r;
  };
  for (let j = 1; j < unique.length; j++) {
    for (let i = 0; i < j; i++) {
      if (!sameKeyOrSecret(unique[i], unique[j])) continue;
      const a = find(i);
      const b = find(j);
      // The lower index (first seen) stays the representative.
      if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
    }
  }
  return new Map(unique.map((r, i) => [r, unique[find(i)] ?? r]));
}

export function refRule(ref: string | null | undefined, path: string, prefix: string, v: Collector): void {
  const p = refProblem(ref, prefix);
  if (p) v.add(p, path);
}

export function noPhiScope(config: PlatformConfig, ctx: GuardContext, v: Collector): void {
  if (config.approvals.required.includes("PHI_PROCESSING")) v.add("PHI_SCOPE_NOT_PERMITTED_IN_ENVIRONMENT", "approvals.required.PHI_PROCESSING");
  for (const r of ctx.approvals) {
    if (r.scope === "PHI_PROCESSING" && r.environment === config.environment) v.add("PHI_SCOPE_NOT_PERMITTED_IN_ENVIRONMENT", `approvals.records.${r.approvalId}`);
  }
}
