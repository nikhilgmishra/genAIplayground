/**
 * Key and secret separation of the live composition (WP-07; FO-14-56, AUTH-02, OPS-04, FT-91, ADR-0023
 * decision 3). Blocking in the sandbox and full rule sets.
 *
 * KMS key policy cannot keep one key's uses apart: whoever may call kms:Sign on a key can sign anything with it,
 * and whoever may read a secret can use it for anything. So a key the runtime signs with must never be a key
 * anything trusts for another purpose, and a secret must serve one purpose only; this guard rule is the control
 * (as it is for AUDIT_EXPORT_IDENTITY_SHARED and connector credential reuse):
 *
 *   - the approval trust anchor (`approvals.trustedSigningKeyRef`) is never the runtime assertion key
 *     (`signing.assertionKeyRef`), the audit manifest signing key or a trusted manifest key, of this
 *     environment or of any other committed environment configuration: otherwise every gateway task, which holds
 *     kms:Sign on its assertion key, could mint an approval of any scope (approver roles are self-declared in the
 *     record), and an approval would no longer be a human decision;
 *   - the other direction too: this environment's assertion and manifest keys are never the approval trust
 *     anchor of another committed environment (ASSERTION_KEY_IS_APPROVAL_TRUST_KEY /
 *     AUDIT_MANIFEST_KEY_IS_APPROVAL_TRUST_KEY). That environment's guard reads only the COMMITTED configuration
 *     of this one, so a key supplied here by an allowlisted override (VSP_CONFIG_ASSERTION_KEY_REF) is visible to
 *     this guard alone; it refuses the runtime that would sign with another environment's anchor;
 *   - a signing key (assertion, manifest signing or trusted manifest key) is never a signing key of another
 *     committed environment (SIGNING_KEY_REUSED_ACROSS_ENVIRONMENTS): a sandbox runtime could otherwise mint
 *     assertions or manifests the other environment accepts;
 *   - the audit manifest signing key and the trusted manifest keys are never the runtime assertion key: otherwise
 *     the runtime could forge the export manifests that make audit independent of it;
 *   - every secret of the configuration serves ONE purpose (SECRET_REUSED_ACROSS_PURPOSES): the runtime database
 *     login, the request-hash pepper, the OTP pepper, the console session sealer, the audit exporter and verifier
 *     logins, each adapter credential and each connector profile credential of this environment (every profile's
 *     default `credentialRef` and every `capabilityCredentials[].credentialRef`, from
 *     GuardContext.connectorCredentialSets; purpose `connector:<profileId>:<capability>:<access>`, reported at
 *     `connectors.credentials.<env>.profile:<profileId>:<capability>:<access>`) are different secrets. Otherwise,
 *     for example, the internet-facing gateway, which reads the peppers and the database login, could unseal the
 *     console's workforce refresh tokens if the sealer were one of them, and the worker, which reads the connector
 *     credentials, would hold the sealer if it were a profile credential. Two kinds of pair are another rule's:
 *     adapter and connector-profile credentials among themselves (connector credential rule, rules/connectors.ts,
 *     which compares them by IDENTITY through rules/types.ts canonicalReferences: CREDENTIAL_REUSED_ACROSS_*) and
 *     the three database logins (rules/infrastructure.ts, AUDIT_EXPORT_IDENTITY_SHARED);
 *   - no secret of this environment is a secret of another committed environment
 *     (SECRET_REUSED_ACROSS_ENVIRONMENTS; adapter and connector-profile credentials against another environment's
 *     adapter credentials are the connector rule's, by identity too, whenever the supplied credential sets hold that
 *     environment; without them they are compared here, so no pair goes unchecked);
 *   - those signing keys are referenced by key (key ARN or key id), never by an alias: which key an alias names
 *     is not visible in configuration, so separation would not be decidable here.
 *
 * References are compared by identity (rules/types.ts sameKeyOrSecret): a key ARN matches its bare key id, a full
 * Secrets Manager ARN matches the partial ARN of the same secret. Within this environment the keys are ALSO
 * compared by key MATERIAL (GuardContext.runtimeSigningPublicKeys, resolved by startup.ts through GetPublicKey for
 * every form KMS accepts: key ARN, bare key id, mrk- id): two key ids can hold the same imported key material, and
 * then they are one key. When the composition resolved the runtime signing keys (the field is present), a
 * configured signing key whose public key it could not obtain (GetPublicKey denied or failing, a reference no
 * resolver supports) refuses the environment (RUNTIME_SIGNING_KEY_UNRESOLVED@<path>): the material comparison
 * fails closed, and the trust anchor is then not used (no record verifies). Aliases (refused below) and an
 * assertion key reference the mandatory rule already refuses (missing, placeholder, local) are not reported twice.
 * Violations name configuration paths only; the cross-environment ones name `environments.<env>.<path>` of the
 * other configuration. Cross-environment separation is decidable only for references committed in the
 * configuration directory (see main/live-modules.ts committedSigningKeySets), compared by reference.
 *
 * When the trust anchor is refused here, the guard does not use it at all (guard.ts): no approval record
 * verifies, so a record the runtime minted is never VALID even in the report of a refused environment.
 */
import { createPublicKey } from "node:crypto";
import type { KeyObject } from "node:crypto";
import type { EnvironmentCredentialSet } from "../../connectors/profile/credentials.js";
import type { Environment } from "../../protocol/index.js";
import type { PlatformConfig } from "../ports.js";
import { LIVE_RULE_SETS, isKmsAliasRef, refProblem, safeKey, sameKeyOrSecret } from "./types.js";
import type { GuardContext, GuardRule, GuardViolation, SecretUse } from "./types.js";

/** The secret-bearing parts of a configuration (a parsed PlatformConfig or a committed file read as JSON). */
export interface SecretBearing {
  database?: { connectionRef?: unknown } | null;
  infrastructure?: {
    secrets?: { requestHashPepperRef?: unknown; otpPepperRef?: unknown; consoleSessionSealerRef?: unknown } | null;
    auditExport?: { exporterDatabaseRef?: unknown; verifierDatabaseRef?: unknown } | null;
  } | null;
  adapters?: Record<string, { credentialRef?: unknown } | null | undefined> | null;
}

const ref = (v: unknown): string | null => (typeof v === "string" && v.length > 0 && v.length <= 512 ? v : null);

/** Every secret reference of a configuration, with its path and purpose (references only; never reported). */
export function secretUses(c: SecretBearing): SecretUse[] {
  const out: SecretUse[] = [];
  const push = (v: unknown, path: string, purpose: string) => {
    const r = ref(v);
    if (r) out.push({ ref: r, path, purpose });
  };
  push(c.database?.connectionRef, "database.connectionRef", "database-login");
  const s = c.infrastructure?.secrets ?? null;
  push(s?.requestHashPepperRef, "infrastructure.secrets.requestHashPepperRef", "request-hash-pepper");
  push(s?.otpPepperRef, "infrastructure.secrets.otpPepperRef", "otp-pepper");
  push(s?.consoleSessionSealerRef, "infrastructure.secrets.consoleSessionSealerRef", "console-session-sealer");
  const ex = c.infrastructure?.auditExport ?? null;
  push(ex?.exporterDatabaseRef, "infrastructure.auditExport.exporterDatabaseRef", "audit-exporter-login");
  push(ex?.verifierDatabaseRef, "infrastructure.auditExport.verifierDatabaseRef", "audit-verifier-login");
  const adapters = c.adapters && typeof c.adapters === "object" ? c.adapters : {};
  for (const k of Object.keys(adapters).sort().slice(0, 64)) push(adapters[k]?.credentialRef, `adapters.${safeKey(k)}.credentialRef`, `adapter:${safeKey(k)}`);
  return out;
}

const POSITION_PART = /^[A-Za-z0-9_.-]{1,80}$/;
const part = (s: unknown): string => (typeof s === "string" && POSITION_PART.test(s) ? s : "unnamed");

/**
 * The connector profile credentials of `environment` (GuardContext.connectorCredentialSets, the profiles the worker's
 * connector runtime loads): each profile's default `credentialRef` (purpose `connector:<profileId>:default:READ`) and
 * every `capabilityCredentials[].credentialRef` (`connector:<profileId>:<capability>:<access>`), at the opaque
 * position the connector rule reports (`connectors.credentials.<env>.profile:<profileId>:<capability>:<access>`).
 */
export function connectorProfileSecretUses(sets: readonly EnvironmentCredentialSet[] | undefined, environment: Environment): SecretUse[] {
  const out: SecretUse[] = [];
  for (const set of sets ?? []) {
    if (set.environment !== environment) continue;
    for (const p of set.profiles.slice(0, 256)) {
      const id = part(p.profileId);
      const push = (v: unknown, capability: string, access: "READ" | "WRITE") => {
        const r = ref(v);
        if (r) out.push({ ref: r, path: `connectors.credentials.${environment}.profile:${id}:${capability}:${access}`, purpose: `connector:${id}:${capability}:${access}` });
      };
      push(p.credentialRef, "default", "READ");
      for (const c of (p.capabilityCredentials ?? []).slice(0, 32)) push(c.credentialRef, part(c.capability), c.access === "WRITE" ? "WRITE" : "READ");
    }
  }
  return out;
}

/** The public key's SPKI DER (base64) of a KeyObject or PEM; null when it is not a usable asymmetric key. */
function keyMaterial(key: KeyObject | string | null | undefined): string | null {
  if (!key) return null;
  try {
    const pub = typeof key === "string" || key.type !== "public" ? createPublicKey(key) : key;
    return pub.export({ format: "der", type: "spki" }).toString("base64");
  } catch {
    return null;
  }
}

const ASSERTION_PATH = "signing.assertionKeyRef";
const MANIFEST_PATH = /^infrastructure\.auditExport\.(manifestSigningKeyId|trustedManifestKeyIds\.\d{1,2})$/;

const DATABASE_LOGINS: ReadonlySet<string> = new Set(["database-login", "audit-exporter-login", "audit-verifier-login"]);
/** Adapter and connector-profile credentials: the connector credential rule compares these among themselves (by identity). */
const isConnectorCredential = (purpose: string) => purpose.startsWith("adapter:") || purpose.startsWith("connector:");
/** Pairs another rule reports: connector credentials among themselves (connector rule) and the database logins (infrastructure rule). */
const reportedElsewhere = (a: string, b: string) => (isConnectorCredential(a) && isConnectorCredential(b)) || (DATABASE_LOGINS.has(a) && DATABASE_LOGINS.has(b));

/**
 * Codes after which the guard does not use the trust anchor (guard.ts): the anchor is a key the runtime signs with,
 * or a runtime signing key's material could not be compared with it.
 */
export const TRUST_ANCHOR_SHARED_CODES: readonly string[] = Object.freeze(["APPROVAL_TRUST_KEY_IS_ASSERTION_KEY", "APPROVAL_TRUST_KEY_IS_MANIFEST_KEY", "RUNTIME_SIGNING_KEY_UNRESOLVED"]);

type SeparationContext = Pick<GuardContext, "committedSigningKeys" | "trustedApprovalKey" | "runtimeSigningPublicKeys" | "connectorCredentialSets">;

/** Every key and secret separation failure of a live configuration (codes and paths only). */
export function keySeparationViolations(config: PlatformConfig, ctx: SeparationContext): GuardViolation[] {
  const out: GuardViolation[] = [];
  const add = (code: string, path: string) => {
    if (!out.some((v) => v.code === code && v.path === path)) out.push({ code, path });
  };
  const trust = config.approvals.trustedSigningKeyRef;
  const assertion = config.signing.assertionKeyRef;
  const ex = config.infrastructure?.auditExport ?? null;
  const manifestKeys: { ref: string; path: string }[] = ex
    ? [{ ref: ex.manifestSigningKeyId, path: "infrastructure.auditExport.manifestSigningKeyId" }, ...ex.trustedManifestKeyIds.map((ref, i) => ({ ref, path: `infrastructure.auditExport.trustedManifestKeyIds.${i}` }))]
    : [];
  // This environment's signing keys (the assertion key and the audit manifest keys).
  const signingKeys: { ref: string | null; path: string }[] = [{ ref: assertion, path: "signing.assertionKeyRef" }, ...manifestKeys];
  // Every secret of this environment: the configuration's and the connector profile credentials it runs with.
  const secrets = [...secretUses(config), ...connectorProfileSecretUses(ctx.connectorCredentialSets, config.environment)];

  // Approval trust anchor versus the keys the runtime signs with (this environment).
  if (sameKeyOrSecret(trust, assertion)) add("APPROVAL_TRUST_KEY_IS_ASSERTION_KEY", "approvals.trustedSigningKeyRef");
  if (manifestKeys.some((k) => sameKeyOrSecret(trust, k.ref))) add("APPROVAL_TRUST_KEY_IS_MANIFEST_KEY", "approvals.trustedSigningKeyRef");

  // The same comparisons by key MATERIAL, where the composition resolved the public keys (startup.ts): two key
  // ids can hold the same imported key material, and then they are one key whatever the references say.
  const anchorMaterial = keyMaterial(ctx.trustedApprovalKey);
  const runtimeMaterial = (ctx.runtimeSigningPublicKeys ?? [])
    .filter((k) => k.path === ASSERTION_PATH || MANIFEST_PATH.test(k.path))
    .map((k) => ({ path: k.path, material: keyMaterial(k.key) }))
    .filter((k): k is { path: string; material: string } => k.material !== null);
  const assertionMaterial = runtimeMaterial.find((k) => k.path === ASSERTION_PATH)?.material ?? null;
  for (const k of runtimeMaterial) {
    if (anchorMaterial !== null && k.material === anchorMaterial) add(k.path === ASSERTION_PATH ? "APPROVAL_TRUST_KEY_IS_ASSERTION_KEY" : "APPROVAL_TRUST_KEY_IS_MANIFEST_KEY", "approvals.trustedSigningKeyRef");
    if (k.path !== ASSERTION_PATH && k.material === assertionMaterial) add("AUDIT_MANIFEST_KEY_IS_ASSERTION_KEY", k.path);
  }
  // Fail closed: when the composition resolved the runtime signing keys, a configured key whose public key it could
  // not obtain is never compared by material, so the environment is refused (and the anchor is not used).
  if (ctx.runtimeSigningPublicKeys !== undefined) {
    const resolved = new Set(runtimeMaterial.map((k) => k.path));
    for (const k of signingKeys) {
      if (!k.ref || resolved.has(k.path) || isKmsAliasRef(k.ref)) continue;
      // The mandatory rule already refuses a missing, placeholder, local or non-ARN assertion key reference.
      if (k.path === ASSERTION_PATH && refProblem(k.ref, "SIGNING_KEY_REF") !== null) continue;
      add("RUNTIME_SIGNING_KEY_UNRESOLVED", k.path);
    }
  }

  // ... and versus every other committed environment configuration, in both directions.
  for (const other of ctx.committedSigningKeys ?? []) {
    if (other.environment === config.environment) continue;
    const at = `environments.${other.environment}`;
    const theirs: { ref: string | null; path: string }[] = [
      { ref: other.assertionKeyRef, path: `${at}.signing.assertionKeyRef` },
      { ref: other.manifestSigningKeyId, path: `${at}.infrastructure.auditExport.manifestSigningKeyId` },
      ...other.trustedManifestKeyIds.map((ref, i) => ({ ref, path: `${at}.infrastructure.auditExport.trustedManifestKeyIds.${i}` })),
    ];
    // This environment's anchor is another environment's runtime signing key.
    if (sameKeyOrSecret(trust, other.assertionKeyRef)) add("APPROVAL_TRUST_KEY_IS_ASSERTION_KEY", `${at}.signing.assertionKeyRef`);
    for (const t of theirs.slice(1)) if (sameKeyOrSecret(trust, t.ref)) add("APPROVAL_TRUST_KEY_IS_MANIFEST_KEY", t.path);
    // This environment's runtime signing keys are another environment's anchor (the reverse direction).
    const anchor = other.approvalTrustKeyRef ?? null;
    if (sameKeyOrSecret(assertion, anchor)) add("ASSERTION_KEY_IS_APPROVAL_TRUST_KEY", `${at}.approvals.trustedSigningKeyRef`);
    if (manifestKeys.some((k) => sameKeyOrSecret(k.ref, anchor))) add("AUDIT_MANIFEST_KEY_IS_APPROVAL_TRUST_KEY", `${at}.approvals.trustedSigningKeyRef`);
    // A signing key shared between environments.
    for (const t of theirs) if (signingKeys.some((k) => sameKeyOrSecret(k.ref, t.ref))) add("SIGNING_KEY_REUSED_ACROSS_ENVIRONMENTS", t.path);
    // A secret shared between environments. Connector credentials against that environment's adapter credentials
    // are the connector rule's (compared by identity there) when it sees that environment's set; otherwise here.
    const connectorRuleSees = (ctx.connectorCredentialSets ?? []).some((s) => s.environment === other.environment);
    for (const t of other.secrets ?? []) {
      if (secrets.some((u) => !(connectorRuleSees && isConnectorCredential(u.purpose) && isConnectorCredential(t.purpose)) && sameKeyOrSecret(u.ref, t.ref))) add("SECRET_REUSED_ACROSS_ENVIRONMENTS", `${at}.${t.path}`);
    }
  }

  // Audit manifest keys versus the runtime assertion key.
  for (const k of manifestKeys) if (sameKeyOrSecret(k.ref, assertion)) add("AUDIT_MANIFEST_KEY_IS_ASSERTION_KEY", k.path);

  // Signing keys are referenced by key, never by alias (separation must be decidable from configuration).
  if (isKmsAliasRef(assertion)) add("KMS_SIGNING_KEY_REF_IS_ALIAS", "signing.assertionKeyRef");
  for (const k of manifestKeys) if (isKmsAliasRef(k.ref)) add("KMS_SIGNING_KEY_REF_IS_ALIAS", k.path);

  // Secrets: one purpose each. The later path of a pair is reported (configuration order of secretUses).
  for (const [j, b] of secrets.entries()) {
    for (const a of secrets.slice(0, j)) {
      if (a.purpose === b.purpose || reportedElsewhere(a.purpose, b.purpose)) continue;
      if (sameKeyOrSecret(a.ref, b.ref)) add("SECRET_REUSED_ACROSS_PURPOSES", b.path);
    }
  }
  return out;
}

/**
 * True when the trust anchor is a runtime signing key (this or another environment), or when a runtime signing key's
 * material could not be compared with it: the guard must not trust it.
 */
export function trustAnchorShared(config: PlatformConfig, ctx: SeparationContext): boolean {
  return keySeparationViolations(config, ctx).some((v) => TRUST_ANCHOR_SHARED_CODES.includes(v.code));
}

export const keySeparationRule: GuardRule = {
  id: "key-separation",
  file: "key-separation.ts",
  ruleSets: LIVE_RULE_SETS,
  evaluate({ config, ctx, v }) {
    for (const x of keySeparationViolations(config, ctx)) v.add(x.code, x.path);
  },
};
