/**
 * Loads `platform/config/<environment>.json`, strictly validates it and applies
 * allowlisted environment-variable overrides.
 *
 * Overrides exist only for deployment-specific REFERENCES (Secrets Manager /
 * KMS ARNs and the session table name) so the same reviewed file can be deployed
 * per account. They can never carry secret values (each value must match the
 * reference pattern), never change endpoints, adapter kinds, models, policy or
 * tool-catalogue pins, CORS, audit or approvals (those stay in reviewed config,
 * OPS-06), and never add adapters. Any other `VSP_CONFIG_*` variable is rejected.
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Environment } from "../protocol/index.js";
import { sha256Hex } from "../shared/canonical.js";
import { ValidationError } from "../shared/errors.js";
import type { PlatformConfig } from "./ports.js";
import { SECRET_REF_PATTERN, parsePlatformConfig } from "./schema.js";

const here = dirname(fileURLToPath(import.meta.url));
/** platform/config */
export const CONFIG_DIR = resolve(here, "../../config");
/** Repository root (approvals/ and policy/ live here). */
export const REPO_ROOT = resolve(here, "../../..");

export const ENV_OVERRIDE_PREFIX = "VSP_CONFIG_";
const MAX_CONFIG_BYTES = 256 * 1024;
const TABLE_NAME = /^[A-Za-z0-9_.-]{3,255}$/;

type Setter = (cfg: PlatformConfig, value: string) => void;

const FIXED_OVERRIDES: Record<string, { kind: "secret_ref" | "table_name"; set: Setter }> = {
  VSP_CONFIG_DATABASE_CONNECTION_REF: { kind: "secret_ref", set: (c, v) => void (c.database.connectionRef = v) },
  VSP_CONFIG_ASSERTION_KEY_REF: { kind: "secret_ref", set: (c, v) => void (c.signing.assertionKeyRef = v) },
  VSP_CONFIG_APPROVALS_TRUSTED_KEY_REF: { kind: "secret_ref", set: (c, v) => void (c.approvals.trustedSigningKeyRef = v) },
  VSP_CONFIG_SESSION_TABLE_NAME: { kind: "table_name", set: (c, v) => void (c.sessionStore.tableName = v) },
};
const ADAPTER_CREDENTIAL_OVERRIDE = /^VSP_CONFIG_ADAPTER_([A-Z0-9_]{3,64})_CREDENTIAL_REF$/;

/** Allowlisted override names for a given configuration (fixed ones plus one per declared adapter). */
export function allowedOverrideNames(config: PlatformConfig): string[] {
  return [
    ...Object.keys(FIXED_OVERRIDES),
    ...Object.keys(config.adapters).map((k) => `VSP_CONFIG_ADAPTER_${k.toUpperCase().replace(/-/g, "_")}_CREDENTIAL_REF`),
  ].sort();
}

export class ConfigOverrideRejectedError extends ValidationError {
  constructor(
    reasonCode: "CONFIG_ENV_OVERRIDE_NOT_ALLOWLISTED" | "CONFIG_ENV_OVERRIDE_NOT_A_REFERENCE" | "CONFIG_ENV_OVERRIDE_UNKNOWN_ADAPTER",
    /** Environment variable NAME only (never its value). */
    readonly variable: string,
  ) {
    super(reasonCode);
  }
}

export interface LoadConfigOptions {
  environment: Environment;
  configDir?: string;
  /** Defaults to process.env. */
  env?: Readonly<Record<string, string | undefined>>;
}

export interface LoadedConfig {
  config: PlatformConfig;
  source: {
    file: string;
    /** sha256 of the reviewed file bytes (before overrides). */
    fileDigest: string;
    /** Names of the override variables applied (values are not recorded). */
    overridesApplied: string[];
  };
}

export function applyEnvOverrides(config: PlatformConfig, env: Readonly<Record<string, string | undefined>>): { config: PlatformConfig; applied: string[] } {
  const next = structuredClone(config);
  const applied: string[] = [];
  for (const name of Object.keys(env).sort()) {
    if (!name.startsWith(ENV_OVERRIDE_PREFIX)) continue;
    const value = env[name];
    if (value === undefined || value === "") continue;
    const fixed = Object.hasOwn(FIXED_OVERRIDES, name) ? FIXED_OVERRIDES[name] : undefined;
    if (fixed) {
      const ok = fixed.kind === "secret_ref" ? SECRET_REF_PATTERN.test(value) && value.length <= 512 : TABLE_NAME.test(value);
      if (!ok) throw new ConfigOverrideRejectedError("CONFIG_ENV_OVERRIDE_NOT_A_REFERENCE", name);
      fixed.set(next, value);
      applied.push(name);
      continue;
    }
    const m = ADAPTER_CREDENTIAL_OVERRIDE.exec(name);
    if (m) {
      const key = Object.keys(next.adapters).find((k) => k.toUpperCase().replace(/-/g, "_") === m[1]);
      if (!key) throw new ConfigOverrideRejectedError("CONFIG_ENV_OVERRIDE_UNKNOWN_ADAPTER", name);
      if (!(SECRET_REF_PATTERN.test(value) && value.length <= 512)) throw new ConfigOverrideRejectedError("CONFIG_ENV_OVERRIDE_NOT_A_REFERENCE", name);
      const adapter = next.adapters[key];
      if (adapter) adapter.credentialRef = value;
      applied.push(name);
      continue;
    }
    throw new ConfigOverrideRejectedError("CONFIG_ENV_OVERRIDE_NOT_ALLOWLISTED", name);
  }
  return { config: parsePlatformConfig(next), applied };
}

export function loadPlatformConfig(opts: LoadConfigOptions): LoadedConfig {
  const environment = Environment.parse(opts.environment);
  const file = join(opts.configDir ?? CONFIG_DIR, `${environment}.json`);
  let bytes: Buffer;
  try {
    if (statSync(file).size > MAX_CONFIG_BYTES) throw new ValidationError("CONFIG_FILE_TOO_LARGE");
    bytes = readFileSync(file);
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    throw new ValidationError("CONFIG_FILE_UNREADABLE");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ValidationError("CONFIG_JSON_INVALID");
  }
  const parsed = parsePlatformConfig(raw);
  if (parsed.environment !== environment) throw new ValidationError("CONFIG_ENVIRONMENT_MISMATCH");
  const { config, applied } = applyEnvOverrides(parsed, opts.env ?? process.env);
  return { config, source: { file, fileDigest: sha256Hex(bytes), overridesApplied: applied } };
}
