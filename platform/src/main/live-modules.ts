/**
 * Building blocks of the live composition (WP-07; FO-16-11, FO-19-06, FO-21-10, FO-14-53).
 *
 * Production entry point (modules.yaml `entryPoints`, transitive): nothing here, and nothing it imports, may
 * reach a fixture, a LOCAL FIXTURE adapter, the demo, the evaluation tooling or a test emulator.
 *
 *   - startup secrets: Secrets Manager values (the database login, the request-hash pepper) resolved through the
 *     connector runtime's SecretsManagerSecretResolver; values stay in SecretValue and are never logged;
 *   - the PostgreSQL connection from the database secret (an Aurora/RDS JSON secret or a postgres:// URI) and
 *     the schema currency check (the process refuses to start on a schema older than its code);
 *   - the address class of an outbound host (PRIVATE_NETWORK for infrastructure.privateNetworkHosts);
 *   - the guard's inputs every live unit passes the same way (`servedArtifacts`: the pinned policy bundle, the
 *     committed tool catalogue digest, the template catalogue digest and the release image digest the process
 *     serves; `connectorCredentialSets`: the connector profiles of this environment with the adapter
 *     references of this and every committed environment, for the credential separation rule, AUTH-02;
 *     `committedSigningKeySets`: the runtime signing keys of every other committed environment, for the key
 *     separation rule, FO-14-56);
 *   - guard ports for the business-owned ports the live composition has no live implementation for, and the
 *     inbound authenticator that refuses every credential when no inbound authentication is configured.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SecretResolver } from "../connectors/secrets/resolver.js";
import { CONFIG_DIR, REPO_ROOT } from "../config/loader.js";
import type { PlatformConfig } from "../config/ports.js";
import { secretUses } from "../config/rules/index.js";
import type { CommittedSigningKeys, SecretBearing } from "../config/rules/index.js";
import { committedConfigCredentialRefs } from "../connectors/profile/credentials.js";
import type { EnvironmentCredentialSet } from "../connectors/profile/credentials.js";
import { loadConnectorProfilesFromDir } from "../connectors/profile/load.js";
import type { AdmittedProfile } from "../connectors/profile/validate.js";
import { ProfileRejectedError } from "../connectors/profile/validate.js";
import { listMigrations } from "../db/migrate.js";
import { CATALOG_FILE, loadPinnedCatalogFile } from "../gateway/catalog.js";
import type { Db } from "../db/types.js";
import { IntegrationAuthenticationError } from "../gateway/auth.js";
import type { IntegrationAuthenticator } from "../gateway/auth.js";
import type { Logger } from "../observability/ports.js";
import { OpaWasmPolicyEngine } from "../policy/engine.js";
import { Environment } from "../protocol/index.js";
import type { Clock } from "../shared/clock.js";
import { ConfigurationRejectedError, DependencyError, PlatformError } from "../shared/errors.js";
import type { CatalogTemplateRegistry } from "../voice/registry.js";
import { loadDefaultTemplateRegistry } from "../voice/registry.js";

/** A resolved secret's value as a string (the caller never logs it). */
export async function secretString(resolver: Pick<SecretResolver, "resolve">, ref: string, path: string): Promise<string> {
  try {
    return (await resolver.resolve(ref)).value.reveal();
  } catch (err) {
    const code = err instanceof PlatformError && /^[A-Z][A-Z0-9_]{2,63}$/.test(err.reasonCode) ? err.reasonCode : "SECRET_UNAVAILABLE";
    throw new ConfigurationRejectedError([`${code}@${path}`]);
  }
}

/** A >= 32-byte binary secret (peppers): base64 in the secret string, or the raw string when it is long enough. */
export async function secretBytes(resolver: Pick<SecretResolver, "resolve">, ref: string, path: string): Promise<Buffer> {
  const s = await secretString(resolver, ref, path);
  const b64 = /^[A-Za-z0-9+/]{43,}={0,2}$/.test(s) ? Buffer.from(s, "base64") : null;
  const bytes = b64 && b64.length >= 32 ? b64 : Buffer.from(s, "utf8");
  if (bytes.length < 32) throw new ConfigurationRejectedError([`SECRET_TOO_SHORT@${path}`]);
  return bytes;
}

/**
 * PostgreSQL connection string from the database secret: the RDS/Aurora JSON form
 * ({ engine, host, port, username, password, dbname, sslmode?, sslrootcert? }) or a postgres:// URI.
 *
 * TLS (DATA-01, STRIDE I): outside sandbox every connection of a live unit is TLS with certificate AND host
 * name verification (`sslmode=verify-full`; `sslrootcert` names the CA bundle file shipped in the image, for
 * example the RDS bundle, when the server certificate does not chain to the system store). A JSON secret
 * without `sslmode` gets verify-full; any other mode (disable, allow, prefer, require, verify-ca), a URI without
 * `sslmode=verify-full`, or a URI that also carries the legacy `ssl` parameter is refused
 * DATABASE_TLS_REQUIRED@<path>. In sandbox an emulator may run without TLS, so the secret's mode is honoured.
 *
 * Outside sandbox the URI form is also closed (the driver lets query parameters override the URI): the only
 * parameters accepted are `sslmode` (once, verify-full) and `sslrootcert` (at most once, an absolute path to a
 * `.pem` / `.crt` file without `..`). Any other parameter (`host`, `hostaddr`, `port`, `options`, `uselibpqcompat`, `sslcert`,
 * `sslkey`, `sslnegotiation`, `user`, `password`, ...) is refused DATABASE_TLS_REQUIRED, because each can
 * redirect the connection (a unix socket, another address) or weaken verification. The host must be a plain DNS
 * name or IPv4 literal (never empty, percent-encoded or a socket path), the database a single plain path
 * segment, and there is no fragment; anything else is DATABASE_SECRET_MALFORMED. The JSON form builds the URI
 * itself from the same plain host and database rules.
 */
export function pgConnectionString(secret: string, o: { environment: Environment; path?: string }): string {
  const path = o.path ?? "database.connectionRef";
  const tlsRequired = o.environment === "staging" || o.environment === "production";
  const refuse = (code: string): never => {
    throw new ConfigurationRejectedError([`${code}@${path}`]);
  };
  const t = secret.trim();
  if (/^postgres(ql)?:\/\//.test(t)) {
    let u: URL;
    try {
      u = new URL(t);
    } catch {
      return refuse("DATABASE_SECRET_MALFORMED");
    }
    if (tlsRequired && (u.searchParams.get("sslmode") !== "verify-full" || u.searchParams.has("ssl") || u.searchParams.getAll("sslmode").length !== 1)) refuse("DATABASE_TLS_REQUIRED");
    if (tlsRequired) {
      for (const key of new Set(u.searchParams.keys())) if (!URI_TLS_PARAMS.has(key)) refuse("DATABASE_TLS_REQUIRED");
      const rootCerts = u.searchParams.getAll("sslrootcert");
      if (rootCerts.length > 1 || (rootCerts.length === 1 && !validRootCert(rootCerts[0]))) refuse("DATABASE_TLS_REQUIRED");
      if (!PLAIN_HOST.test(u.hostname) || (u.port !== "" && !/^\d{2,5}$/.test(u.port)) || !PLAIN_DB_PATH.test(u.pathname) || u.hash !== "") refuse("DATABASE_SECRET_MALFORMED");
    }
    return t;
  }
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(t) as Record<string, unknown>;
  } catch {
    return refuse("DATABASE_SECRET_MALFORMED");
  }
  const host = doc.host;
  const port = doc.port ?? 5432;
  const user = doc.username;
  const password = doc.password;
  const db = doc.dbname ?? doc.database;
  if (typeof host !== "string" || !PLAIN_HOST.test(host) || typeof user !== "string" || typeof password !== "string" || typeof db !== "string" || !/^\d{2,5}$/.test(String(port))) {
    refuse("DATABASE_SECRET_MALFORMED");
  }
  if (tlsRequired && !PLAIN_DB_PATH.test(`/${db as string}`)) refuse("DATABASE_SECRET_MALFORMED");
  const declared = doc.sslmode;
  if (declared !== undefined && (typeof declared !== "string" || !SSL_MODES.has(declared))) refuse("DATABASE_SECRET_MALFORMED");
  if (tlsRequired && declared !== undefined && declared !== "verify-full") refuse("DATABASE_TLS_REQUIRED");
  const rootCert = doc.sslrootcert;
  if (rootCert !== undefined && (typeof rootCert !== "string" || !validRootCert(rootCert))) refuse("DATABASE_SECRET_MALFORMED");
  const mode = (declared as string | undefined) ?? "verify-full";
  const params = mode === "disable" ? [] : [`sslmode=${mode}`, ...(typeof rootCert === "string" ? [`sslrootcert=${encodeURIComponent(rootCert)}`] : [])];
  return `postgres://${encodeURIComponent(user as string)}:${encodeURIComponent(password as string)}@${host as string}:${String(port)}/${encodeURIComponent(db as string)}${params.length > 0 ? `?${params.join("&")}` : ""}`;
}

const SSL_MODES = new Set(["disable", "allow", "prefer", "require", "verify-ca", "verify-full"]);
/** The only query parameters a staging/production URI secret may carry. */
const URI_TLS_PARAMS: ReadonlySet<string> = new Set(["sslmode", "sslrootcert"]);
/** A DNS name or IPv4 literal: never empty, percent-encoded, bracketed or a socket path. */
const PLAIN_HOST = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
/** One plain database path segment. */
const PLAIN_DB_PATH = /^\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/;
/** An absolute path to a PEM CA bundle file (`.pem` / `.crt`), never relative and never with `..`. */
const validRootCert = (v: string | undefined): boolean => typeof v === "string" && /^\/[A-Za-z0-9._/-]{1,255}$/.test(v) && /\.(pem|crt)$/.test(v) && !v.includes("..");

/**
 * Refuses a schema older than (or different from) the code: every migration of this build must be applied with
 * its exact checksum. Migrations are a release step under the owner role, never run by a serving process.
 */
export async function assertSchemaCurrent(db: Db, role: "app_runtime" | "app_worker" | "app_console" = "app_runtime"): Promise<{ applied: number }> {
  let rows: { name: string; checksum: string }[];
  try {
    rows = (await db.tx((tx) => tx.query<{ name: string; checksum: string }>("select name, checksum from schema_migrations"), { role })).rows;
  } catch (err) {
    throw new ConfigurationRejectedError([`${err instanceof DependencyError ? err.reasonCode : "DATABASE_SCHEMA_UNREADABLE"}@database`]);
  }
  const applied = new Map(rows.map((r) => [r.name, r.checksum]));
  const problems: string[] = [];
  for (const m of listMigrations()) {
    const c = applied.get(m.name);
    if (c === undefined) problems.push(`SCHEMA_MIGRATIONS_PENDING@migrations.${m.name.slice(0, 4)}`);
    else if (c !== m.checksum) problems.push(`SCHEMA_MIGRATION_MODIFIED@migrations.${m.name.slice(0, 4)}`);
  }
  if (problems.length > 0) throw new ConfigurationRejectedError(problems.slice(0, 16));
  return { applied: applied.size };
}

/** Address class of an outbound host: private for the configured private-network hosts, public otherwise. */
export function addressClassFor(config: PlatformConfig, host: string): "PUBLIC_INTERNET" | "PRIVATE_NETWORK" {
  return (config.infrastructure?.privateNetworkHosts ?? []).includes(host.toLowerCase()) ? "PRIVATE_NETWORK" : "PUBLIC_INTERNET";
}

/**
 * Inbound authenticator of a gateway without configured inbound authentication: every credential is refused
 * INTEGRATION_AUTH_NOT_CONFIGURED (401). No token is accepted and nothing is "allowed for now".
 */
export class RefusingIntegrationAuthenticator implements IntegrationAuthenticator {
  readonly kind = "live" as const;
  readonly notConfigured = true as const;
  async authenticate(): Promise<never> {
    throw new IntegrationAuthenticationError("INTEGRATION_AUTH_NOT_CONFIGURED");
  }
}

/** Digest of the committed (pinned) tool catalogue, or null when it cannot be read. */
export function committedCatalogDigest(): string | null {
  try {
    return loadPinnedCatalogFile(CATALOG_FILE).manifest.digest;
  } catch {
    return null;
  }
}

/** What a live unit loads and serves, as the deployment guard checks it (OPS-04, OPS-06, OPS-APPR-01). */
export interface ServedArtifacts {
  /** The pinned policy bundle (null: it did not load; the guard refuses POLICY_BUNDLE_NOT_LOADED). */
  policy: OpaWasmPolicyEngine | null;
  loadedPolicy: { version: string; digest: string } | null;
  toolCatalogDigest: string | null;
  /** The caller-facing template catalogue and its digest (subject of CLINICAL_SCRIPTS approvals). */
  templates: CatalogTemplateRegistry;
  templateCatalogDigest: string;
  /** The running image (subject of PRODUCTION_DEPLOYMENT approvals), from VSP_RELEASE_IMAGE_DIGEST. */
  releaseImageDigest: string | null;
}

/**
 * Loads the artifacts every live unit (gateway, worker, console, audit exporter) hands to the guard the same
 * way, so no unit is refused for an input the gateway has and none is admitted on a weaker check.
 */
export async function servedArtifacts(preliminary: PlatformConfig, o: { environment: Environment; clock: Clock; logger: Logger; releaseImageDigest: string | null }): Promise<ServedArtifacts> {
  let policy: OpaWasmPolicyEngine | null;
  try {
    policy = await OpaWasmPolicyEngine.load({
      clock: o.clock,
      logger: o.logger,
      environment: o.environment,
      ...(preliminary.policy.expectedVersion ? { expectedVersion: preliminary.policy.expectedVersion } : {}),
      ...(preliminary.policy.expectedDigest ? { expectedDigest: preliminary.policy.expectedDigest } : {}),
    });
  } catch {
    policy = null;
  }
  const templates = loadDefaultTemplateRegistry();
  return {
    policy,
    loadedPolicy: policy ? { version: policy.policyVersion, digest: policy.bundleDigest } : null,
    toolCatalogDigest: committedCatalogDigest(),
    templates,
    templateCatalogDigest: templates.digest(),
    releaseImageDigest: o.releaseImageDigest,
  };
}

const CREDENTIAL_POSITION = /^[A-Z][A-Z0-9_]{2,63}$/;

/**
 * Inputs of the connector credential separation rule (config/rules/connectors.ts; AUTH-02, FO-05-56): the
 * connector profiles of this environment (loaded from `connectors.profileDirectory`, the same files the worker
 * runs) with this environment's adapter references, plus the adapter references of every OTHER committed
 * environment configuration in the configuration directory. A profile set that fails to load refuses the unit
 * (CONNECTOR_PROFILE_REJECTED and the loader's codes, @connectors.profileDirectory), and so does a committed
 * configuration file that does not parse with a valid environment (committedConfigFiles,
 * COMMITTED_CONFIG_UNREADABLE@configDir.<name>). The guard rule compares these references by identity
 * (config/rules/connectors.ts normalizeCredentialSets).
 */
export function connectorCredentialSets(
  preliminary: PlatformConfig,
  o: { environment: Environment; configDir?: string; repoRoot?: string },
): { sets: EnvironmentCredentialSet[]; profiles: readonly AdmittedProfile[] } {
  const dir = preliminary.connectors?.profileDirectory ?? null;
  let profiles: readonly AdmittedProfile[] = [];
  if (dir) {
    try {
      profiles = loadConnectorProfilesFromDir(resolve(o.repoRoot ?? REPO_ROOT, dir), o.environment);
    } catch (err) {
      const codes = err instanceof ProfileRejectedError ? err.violations.filter((c) => CREDENTIAL_POSITION.test(c)) : [];
      throw new ConfigurationRejectedError([...new Set(["CONNECTOR_PROFILE_REJECTED", ...codes])].slice(0, 16).map((c) => `${c}@connectors.profileDirectory`));
    }
  }
  const own: Record<string, string> = {};
  for (const [k, a] of Object.entries(preliminary.adapters)) if (typeof a.credentialRef === "string" && a.credentialRef.length > 0) own[k] = a.credentialRef;
  const configDir = o.configDir ?? CONFIG_DIR;
  // Every committed file must parse with a valid environment first (committedConfigFiles refuses one that does not):
  // the connector module's reader skips such a file, which would drop it from the cross-environment comparison.
  committedConfigFiles(configDir);
  let others: { environment: Environment; adapterCredentialRefs: Record<string, string> }[];
  try {
    others = committedConfigCredentialRefs(configDir).filter((e) => e.environment !== o.environment);
  } catch {
    throw new ConfigurationRejectedError(["COMMITTED_CONFIG_UNREADABLE@configDir"]);
  }
  return {
    sets: [{ environment: o.environment, profiles: profiles.map((p) => p.profile), adapterCredentialRefs: own }, ...others.map((e) => ({ environment: e.environment, profiles: [], adapterCredentialRefs: e.adapterCredentialRefs }))],
    profiles,
  };
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 && v.length <= 512 ? v : null);

/** One committed environment configuration file of the configuration directory, read as JSON (never validated further). */
export interface CommittedConfigFile {
  /** The file name without `.json` (lower-case letters). */
  name: string;
  environment: Environment;
  doc: Record<string, unknown>;
}

const COMMITTED_FILE = /^[a-z]+\.json$/;

/**
 * Every committed environment configuration of the configuration directory (`<name>.json`), the files the
 * cross-environment separation checks read (credential separation, connectorCredentialSets; key separation,
 * committedSigningKeySets). Fails closed: a file that does not parse as a JSON object, whose `environment` does not
 * parse, or whose name is an environment name other than the environment it declares (the loader would refuse it,
 * CONFIG_ENVIRONMENT_MISMATCH, and an environment declaring THIS environment would otherwise be skipped as this
 * environment's own file) refuses the unit with COMMITTED_CONFIG_UNREADABLE@configDir.<name>; an unreadable directory
 * refuses it with COMMITTED_CONFIG_UNREADABLE@configDir. A malformed sibling never silently drops out of the checks.
 */
export function committedConfigFiles(dir: string): CommittedConfigFile[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => COMMITTED_FILE.test(n)).sort();
  } catch {
    throw new ConfigurationRejectedError(["COMMITTED_CONFIG_UNREADABLE@configDir"]);
  }
  const out: CommittedConfigFile[] = [];
  const refused: string[] = [];
  for (const f of names) {
    const name = f.slice(0, -".json".length);
    let doc: unknown;
    try {
      doc = JSON.parse(readFileSync(join(dir, f), "utf8"));
    } catch {
      refused.push(name);
      continue;
    }
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
      refused.push(name);
      continue;
    }
    const env = Environment.safeParse((doc as { environment?: unknown }).environment);
    const named = Environment.safeParse(name);
    if (!env.success || (named.success && named.data !== env.data)) {
      refused.push(name);
      continue;
    }
    out.push({ name, environment: env.data, doc: doc as Record<string, unknown> });
  }
  if (refused.length > 0) throw new ConfigurationRejectedError(refused.slice(0, 16).map((n) => `COMMITTED_CONFIG_UNREADABLE@configDir.${n}`));
  return out;
}

/**
 * Inputs of the key separation rule (config/rules/key-separation.ts; FO-14-56, AUTH-02): the key and secret
 * references of every OTHER committed environment configuration in the configuration directory (the same
 * `<env>.json` files the credential separation rule reads, committedConfigFiles): its runtime signing keys (assertion
 * key, audit manifest signing and trusted manifest keys), its approval trust anchor and its secrets (key-separation.ts
 * secretUses). The rule refuses this environment's trust anchor when it is another environment's signing key, this
 * environment's signing keys when one is another environment's anchor or signing key, and a secret shared between
 * environments. Only committed references are visible here (an override another environment's process applies
 * is not). A directory that cannot be read, or a file in it that does not parse with a valid environment, refuses the
 * unit (COMMITTED_CONFIG_UNREADABLE@configDir, @configDir.<name>).
 */
export function committedSigningKeySets(o: { environment: Environment; configDir?: string }): CommittedSigningKeys[] {
  const out: CommittedSigningKeys[] = [];
  for (const file of committedConfigFiles(o.configDir ?? CONFIG_DIR)) {
    if (file.environment === o.environment) continue;
    const doc = file.doc as SecretBearing & {
      signing?: { assertionKeyRef?: unknown } | null;
      approvals?: { trustedSigningKeyRef?: unknown } | null;
      infrastructure?: (NonNullable<SecretBearing["infrastructure"]> & { auditExport?: { manifestSigningKeyId?: unknown; trustedManifestKeyIds?: unknown; exporterDatabaseRef?: unknown; verifierDatabaseRef?: unknown } | null }) | null;
    };
    const ex = doc.infrastructure?.auditExport ?? null;
    const trusted = Array.isArray(ex?.trustedManifestKeyIds) ? ex.trustedManifestKeyIds.map(str).filter((k): k is string => k !== null).slice(0, 16) : [];
    out.push({
      environment: file.environment,
      assertionKeyRef: str(doc.signing?.assertionKeyRef),
      manifestSigningKeyId: str(ex?.manifestSigningKeyId),
      trustedManifestKeyIds: trusted,
      approvalTrustKeyRef: str(doc.approvals?.trustedSigningKeyRef),
      secrets: secretUses(doc),
    });
  }
  return out;
}
