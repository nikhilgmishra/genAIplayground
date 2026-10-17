import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DESTINATIONS, TENANT_ID } from "../fixtures/synthetic-world.js";
import type { Environment } from "../protocol/index.js";
import { CONFIG_DIR, ConfigOverrideRejectedError, allowedOverrideNames, loadPlatformConfig } from "./loader.js";
import { ConfigInvalidError, parsePlatformConfig } from "./schema.js";

const ENVS: Environment[] = ["local", "ci", "sandbox", "staging", "production"];
const rawConfig = (env: Environment): Record<string, unknown> => JSON.parse(readFileSync(join(CONFIG_DIR, `${env}.json`), "utf8"));

describe("environment configuration files", () => {
  it("[SPEC-16.config] all five environment configs parse with the strict schema", () => {
    for (const env of ENVS) {
      const { config, source } = loadPlatformConfig({ environment: env, env: {} });
      expect(config.environment).toBe(env);
      expect(source.fileDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(source.overridesApplied).toEqual([]);
      expect((config as unknown as Record<string, unknown>).$comment).toBeUndefined();
    }
  });

  it("[OPS-04] local and ci are labelled LOCAL FIXTURE and use only fixtures, pglite, memory store and a local dev key", () => {
    for (const env of ["local", "ci"] as const) {
      expect(String(rawConfig(env).$comment)).toContain("LOCAL FIXTURE");
      const { config } = loadPlatformConfig({ environment: env, env: {} });
      expect(config.tenantId).toBe(TENANT_ID);
      expect(Object.values(config.adapters).every((a) => a.kind === "local_fixture")).toBe(true);
      expect(config.database.engine).toBe("pglite");
      expect(config.sessionStore.kind).toBe("memory");
      expect(config.signing.localDevKey).toBe(true);
      expect(config.audit.sink).toBe("local_fixture");
    }
  });

  it("[SAFE-05] the local destination allowlist mirrors the synthetic world DESTINATIONS", () => {
    const { config } = loadPlatformConfig({ environment: "local", env: {} });
    expect(config.destinations).toEqual(DESTINATIONS.map((d) => ({ ...d, fallbackDestinationIds: [...d.fallbackDestinationIds], languages: [...d.languages] })));
  });

  it("[OPS-04] sandbox, staging and production use live kinds with placeholder references and no invented endpoints", () => {
    for (const env of ["sandbox", "staging", "production"] as const) {
      const { config } = loadPlatformConfig({ environment: env, env: {} });
      expect(String(rawConfig(env).$comment)).toContain("EXPECTED TO BE REJECTED");
      for (const a of Object.values(config.adapters)) {
        expect(a.kind).toBe("live");
        expect(a.endpoint).toBeNull();
        expect(a.credentialRef).toMatch(/^arn:aws:secretsmanager:REGION:ACCOUNT:secret:PLACEHOLDER/);
      }
      expect(Object.values(config.retention).every((d) => d === null)).toBe(true);
      expect(config.phi?.endpointsEnabled).toBe(false);
    }
  });
});

describe("strict schema", () => {
  it("[SPEC-16.config] rejects unknown fields and reports paths and codes only", () => {
    const raw = rawConfig("local");
    raw.debugBypassAuth = true;
    try {
      parsePlatformConfig(raw);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigInvalidError);
      expect((err as ConfigInvalidError).issues).toEqual(["$:unrecognized_keys"]);
    }
  });

  it("[AUTH-06] secret values are refused where a reference is expected, and are not echoed in errors", () => {
    const raw = rawConfig("production") as { adapters: Record<string, Record<string, unknown>> };
    const secret = "sk_live_THIS_LOOKS_LIKE_A_SECRET_VALUE_123";
    const salesforce = raw.adapters.salesforce;
    if (!salesforce) throw new Error("fixture missing");
    salesforce.credentialRef = secret;
    try {
      parsePlatformConfig(raw);
      expect.unreachable();
    } catch (err) {
      const e = err as ConfigInvalidError;
      expect(e.issues).toEqual(["adapters.salesforce.credentialRef:invalid_format"]);
      expect(JSON.stringify(e.issues) + e.message).not.toContain(secret);
    }
  });

  it("[DATA-01] endpoints may not carry query strings, fragments or userinfo", () => {
    for (const endpoint of ["https://api.vendor.example.com/v1?subject=Avery", "https://user:pw@api.vendor.example.com", "https://api.vendor.example.com/#x"]) {
      const raw = rawConfig("staging") as { adapters: Record<string, Record<string, unknown>> };
      const a = raw.adapters.billing;
      if (!a) throw new Error("fixture missing");
      a.endpoint = endpoint;
      expect(() => parsePlatformConfig(raw)).toThrow(ConfigInvalidError);
    }
  });

  it("[SPEC-16.config] duplicate required approval scopes are rejected", () => {
    const raw = rawConfig("staging") as { approvals: { required: string[] } };
    raw.approvals.required = ["SECURITY_REVIEW", "SECURITY_REVIEW"];
    expect(() => parsePlatformConfig(raw)).toThrow(ConfigInvalidError);
  });
});

describe("environment-variable overrides", () => {
  it("[SPEC-16.config] applies allowlisted reference overrides and records only variable names", () => {
    const env = {
      VSP_CONFIG_DATABASE_CONNECTION_REF: "arn:aws:secretsmanager:us-east-1:111122223333:secret:vsp-stg-aurora",
      VSP_CONFIG_ADAPTER_SALESFORCE_CREDENTIAL_REF: "arn:aws:secretsmanager:us-east-1:111122223333:secret:vsp-stg-sf",
      VSP_CONFIG_ADAPTER_TALKDESK_TELEPHONY_CREDENTIAL_REF: "arn:aws:secretsmanager:us-east-1:111122223333:secret:vsp-stg-td",
      VSP_CONFIG_SESSION_TABLE_NAME: "vsp-stg-sessions",
      UNRELATED_VARIABLE: "ignored",
    };
    const { config, source } = loadPlatformConfig({ environment: "staging", env });
    expect(config.database.connectionRef).toBe(env.VSP_CONFIG_DATABASE_CONNECTION_REF);
    expect(config.adapters.salesforce?.credentialRef).toBe(env.VSP_CONFIG_ADAPTER_SALESFORCE_CREDENTIAL_REF);
    expect(config.adapters["talkdesk-telephony"]?.credentialRef).toBe(env.VSP_CONFIG_ADAPTER_TALKDESK_TELEPHONY_CREDENTIAL_REF);
    expect(config.sessionStore.tableName).toBe("vsp-stg-sessions");
    expect(source.overridesApplied).toEqual([
      "VSP_CONFIG_ADAPTER_SALESFORCE_CREDENTIAL_REF",
      "VSP_CONFIG_ADAPTER_TALKDESK_TELEPHONY_CREDENTIAL_REF",
      "VSP_CONFIG_DATABASE_CONNECTION_REF",
      "VSP_CONFIG_SESSION_TABLE_NAME",
    ]);
    expect(JSON.stringify(source)).not.toContain("111122223333");
  });

  it("[AUTH-06] an override carrying a secret value is rejected without echoing the value", () => {
    const secret = "super-secret-password-value";
    try {
      loadPlatformConfig({ environment: "staging", env: { VSP_CONFIG_ADAPTER_BILLING_CREDENTIAL_REF: secret } });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigOverrideRejectedError);
      expect((err as ConfigOverrideRejectedError).reasonCode).toBe("CONFIG_ENV_OVERRIDE_NOT_A_REFERENCE");
      expect((err as Error).message).not.toContain(secret);
    }
  });

  it("[OPS-06] pins, endpoints, adapter kinds and audit cannot be overridden from the environment", () => {
    for (const name of [
      "VSP_CONFIG_POLICY_EXPECTED_DIGEST",
      "VSP_CONFIG_ADAPTER_BILLING_ENDPOINT",
      "VSP_CONFIG_ADAPTER_BILLING_KIND",
      "VSP_CONFIG_AUDIT_ENABLED",
      "VSP_CONFIG_MODELS_ACTIVE",
    ]) {
      expect(() => loadPlatformConfig({ environment: "production", env: { [name]: "x" } })).toThrow("CONFIG_ENV_OVERRIDE_NOT_ALLOWLISTED");
    }
    expect(() =>
      loadPlatformConfig({ environment: "production", env: { VSP_CONFIG_ADAPTER_NEW_VENDOR_CREDENTIAL_REF: "arn:aws:secretsmanager:us-east-1:111122223333:secret:x" } }),
    ).toThrow("CONFIG_ENV_OVERRIDE_UNKNOWN_ADAPTER");
    const names = allowedOverrideNames(loadPlatformConfig({ environment: "production", env: {} }).config);
    expect(names.every((n) => /_REF$|_TABLE_NAME$/.test(n))).toBe(true);
  });

  it("[SPEC-16.config] a file whose environment does not match the requested environment is rejected", () => {
    const dir = mkdtempSync(join(tmpdir(), "vsp-config-test-"));
    writeFileSync(join(dir, "production.json"), readFileSync(join(CONFIG_DIR, "local.json")));
    expect(() => loadPlatformConfig({ environment: "production", configDir: dir, env: {} })).toThrow("CONFIG_ENVIRONMENT_MISMATCH");
    writeFileSync(join(dir, "staging.json"), "{ not json");
    expect(() => loadPlatformConfig({ environment: "staging", configDir: dir, env: {} })).toThrow("CONFIG_JSON_INVALID");
    expect(() => loadPlatformConfig({ environment: "ci", configDir: dir, env: {} })).toThrow("CONFIG_FILE_UNREADABLE");
  });
});
