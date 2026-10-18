/**
 * Additive config extensions used by the composition root: strict container
 * infrastructure variables and the optional `gateway` configuration section.
 */
import { describe, expect, it } from "vitest";
import { InfrastructureEnvRejectedError, loadInfrastructureEnv, loadPlatformConfig } from "../config/loader.js";
import { ConfigInvalidError, gatewayConfigOf, parsePlatformConfig } from "../config/schema.js";

describe("infrastructure environment variables", () => {
  it("[OPS-04][SPEC-12.write-fence] VSP_ENVIRONMENT is required and strict; the write fence defaults closed outside local/ci; PORT is validated", () => {
    expect(loadInfrastructureEnv({ VSP_ENVIRONMENT: "local" })).toEqual({ environment: "local", mutationsEnabled: true, port: 8080 });
    expect(loadInfrastructureEnv({ VSP_ENVIRONMENT: "production" })).toMatchObject({ mutationsEnabled: false });
    expect(loadInfrastructureEnv({ VSP_ENVIRONMENT: "production", VSP_MUTATIONS_ENABLED: "true", PORT: "8080" })).toEqual({ environment: "production", mutationsEnabled: true, port: 8080 });
    expect(loadInfrastructureEnv({ VSP_ENVIRONMENT: "ci", VSP_MUTATIONS_ENABLED: "false" }, { defaultPort: 8081 })).toEqual({ environment: "ci", mutationsEnabled: false, port: 8081 });
    const reason = (env: Record<string, string>) => {
      try {
        loadInfrastructureEnv(env);
        return "NO_ERROR";
      } catch (e) {
        return e instanceof InfrastructureEnvRejectedError ? `${e.reasonCode}:${e.variable}` : "OTHER";
      }
    };
    expect(reason({})).toBe("INFRA_ENV_ENVIRONMENT_REQUIRED:VSP_ENVIRONMENT");
    expect(reason({ VSP_ENVIRONMENT: "Production" })).toBe("INFRA_ENV_ENVIRONMENT_INVALID:VSP_ENVIRONMENT");
    expect(reason({ VSP_ENVIRONMENT: "local", VSP_MUTATIONS_ENABLED: "1" })).toBe("INFRA_ENV_BOOLEAN_INVALID:VSP_MUTATIONS_ENABLED");
    expect(reason({ VSP_ENVIRONMENT: "local", PORT: "70000" })).toBe("INFRA_ENV_PORT_INVALID:PORT");
    expect(reason({ VSP_ENVIRONMENT: "local", PORT: "0" })).toBe("INFRA_ENV_PORT_INVALID:PORT");
  });
});

describe("optional gateway configuration section", () => {
  const base = () => structuredClone(loadPlatformConfig({ environment: "local", env: {} }).config) as unknown as Record<string, unknown>;

  it("[SPEC-8.oauth2] absent => null (committed files carry none); present => strictly parsed; malformed => ConfigInvalidError with paths only", () => {
    expect(gatewayConfigOf(loadPlatformConfig({ environment: "local", env: {} }).config)).toBeNull();
    const cfg = base();
    cfg.gateway = {
      inboundAuth: {
        kind: "oauth2_jwt",
        issuer: "https://auth.local.invalid/issuer",
        audience: "vsp-gateway-local",
        jwksUri: "https://auth.local.invalid/jwks",
        algorithms: ["ES256"],
        clockToleranceSeconds: 30,
        maxTokenAgeSeconds: 3600,
        clientIdClaim: "client_id",
        clients: [{ clientId: "talkdesk-mcp-client", integrationId: "talkdesk-local", credentialId: "cred-local-mcp", channels: ["mcp_tools"] }],
        scopeToChannel: { "vsp.mcp_tools": "mcp_tools" },
      },
      http: { bodyLimitBytes: 65_536, rateLimit: { max: 600, timeWindowMs: 60_000 } },
    };
    const parsed = parsePlatformConfig(cfg);
    expect(gatewayConfigOf(parsed)?.inboundAuth?.audience).toBe("vsp-gateway-local");
    const open = base();
    open.gateway = { inboundAuth: null, extra: true };
    expect(() => parsePlatformConfig(open)).toThrow(ConfigInvalidError);
    const hs = base();
    hs.gateway = { inboundAuth: { ...(cfg.gateway as { inboundAuth: object }).inboundAuth, algorithms: ["HS256"] } };
    expect(() => parsePlatformConfig(hs)).toThrow(ConfigInvalidError);
  });
});
