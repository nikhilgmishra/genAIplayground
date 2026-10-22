import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.js";

const base = {
  REFBIZ_ENVIRONMENT: "local",
  REFBIZ_DATABASE_HOST: "127.0.0.1",
  REFBIZ_DATABASE_USER: "vsp",
  REFBIZ_DATABASE_PASSWORD: "pw_synthLocalOnly01",
  REFBIZ_DATABASE_SSL: "disable",
};

const reason = (env: Record<string, string>): string => {
  try {
    loadConfig(env);
  } catch (e) {
    if (e instanceof ConfigError) return e.reasonCode;
    throw e;
  }
  return "ACCEPTED";
};

describe("reference business API configuration [FO-06-74]", () => {
  it("[FO-06-74] a local configuration starts without fault control unless it is enabled explicitly", () => {
    const off = loadConfig(base);
    expect(off.admin).toBeNull();
    const on = loadConfig({ ...base, REFBIZ_FAULT_CONTROL: "enabled" });
    expect(on.admin).toEqual({ bind: "127.0.0.1", port: 8080 });
  });

  it("[FO-06-74][OPS-05] the fault-control listener is refused outside local and ci, whatever else is configured", () => {
    for (const environment of ["sandbox", "staging", "production"]) {
      expect(reason({ ...base, REFBIZ_ENVIRONMENT: environment, REFBIZ_FAULT_CONTROL: "enabled", REFBIZ_TLS_CERT_FILE: "/c.pem", REFBIZ_TLS_KEY_FILE: "/k.pem", REFBIZ_DATABASE_SSL: "require" })).toBe(
        "REFBIZ_FAULT_CONTROL_OUTSIDE_LOCAL",
      );
    }
    expect(reason({ ...base, REFBIZ_ENVIRONMENT: "ci", REFBIZ_FAULT_CONTROL: "enabled" })).toBe("ACCEPTED");
  });

  it("[FO-06-74] the fault-control listener binds the loopback interface only", () => {
    expect(reason({ ...base, REFBIZ_FAULT_CONTROL: "enabled", REFBIZ_ADMIN_BIND: "0.0.0.0" })).toBe("REFBIZ_ADMIN_NOT_LOOPBACK");
    expect(reason({ ...base, REFBIZ_FAULT_CONTROL: "enabled", REFBIZ_ADMIN_BIND: "::1" })).toBe("ACCEPTED");
  });

  it("[FO-06-74][OPS-05] fault control also needs the API on loopback: a deployed image (0.0.0.0) that claims local or ci refuses to start", () => {
    expect(reason({ ...base, REFBIZ_ENVIRONMENT: "ci", REFBIZ_FAULT_CONTROL: "enabled", REFBIZ_API_BIND: "0.0.0.0" })).toBe("REFBIZ_FAULT_CONTROL_REQUIRES_LOOPBACK_API");
    expect(reason({ ...base, REFBIZ_ENVIRONMENT: "local", REFBIZ_FAULT_CONTROL: "enabled", REFBIZ_API_BIND: "10.0.0.5" })).toBe("REFBIZ_FAULT_CONTROL_REQUIRES_LOOPBACK_API");
    expect(reason({ ...base, REFBIZ_ENVIRONMENT: "local", REFBIZ_API_BIND: "0.0.0.0" })).toBe("ACCEPTED");
  });

  it("[FO-06-74] outside local/ci the API needs its own TLS certificate, database TLS and an existing database", () => {
    const deployed = { ...base, REFBIZ_ENVIRONMENT: "sandbox", REFBIZ_DATABASE_SSL: "require" };
    expect(reason(deployed)).toBe("REFBIZ_TLS_REQUIRED");
    const tls = { ...deployed, REFBIZ_TLS_CERT_FILE: "/c.pem", REFBIZ_TLS_KEY_FILE: "/k.pem" };
    expect(reason(tls)).toBe("ACCEPTED");
    expect(reason({ ...tls, REFBIZ_DATABASE_SSL: "disable" })).toBe("REFBIZ_DATABASE_TLS_REQUIRED");
    expect(reason({ ...tls, REFBIZ_DATABASE_CREATE: "true" })).toBe("REFBIZ_DATABASE_CREATE_OUTSIDE_LOCAL");
    expect(reason({ ...deployed, REFBIZ_TLS_CERT_FILE: "/c.pem" })).toBe("REFBIZ_TLS_PAIR_INCOMPLETE");
  });

  it("[FO-06-74] an invalid value is refused with the field's reason code, never its value", () => {
    expect(reason({ ...base, REFBIZ_ENVIRONMENT: "prod" })).toBe("CONFIG_INVALID_REFBIZ_ENVIRONMENT");
    expect(reason({ ...base, REFBIZ_DATABASE_NAME: "refbiz; drop" })).toBe("CONFIG_INVALID_REFBIZ_DATABASE_NAME");
    const { REFBIZ_DATABASE_PASSWORD: _p, ...noPassword } = base;
    expect(reason(noPassword)).toBe("CONFIG_INVALID_REFBIZ_DATABASE_PASSWORD");
  });
});
