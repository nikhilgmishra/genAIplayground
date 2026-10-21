/**
 * Additive config extensions used by the composition root: strict container
 * infrastructure variables and the optional `gateway` configuration section.
 */
import { describe, expect, it } from "vitest";
import { InfrastructureEnvRejectedError, loadInfrastructureEnv, loadPlatformConfig } from "../config/loader.js";
import { ConfigInvalidError, gatewayConfigOf, parsePlatformConfig } from "../config/schema.js";
import * as configModule from "../config/index.js";
import type { GatewayConfig, PlatformConfig } from "../config/index.js";

describe("infrastructure environment variables", () => {
  it("[OPS-04][SPEC-12.write-fence] VSP_ENVIRONMENT is required and strict; the write fence defaults closed outside local/ci; PORT is validated", () => {
    expect(loadInfrastructureEnv({ VSP_ENVIRONMENT: "local" })).toEqual({ environment: "local", mutationsEnabled: true, port: 8080, listenHost: "127.0.0.1", releaseImageDigest: null });
    expect(loadInfrastructureEnv({ VSP_ENVIRONMENT: "production" })).toMatchObject({ mutationsEnabled: false, listenHost: "0.0.0.0" });
    expect(loadInfrastructureEnv({ VSP_ENVIRONMENT: "production", VSP_MUTATIONS_ENABLED: "true", PORT: "8080" })).toEqual({ environment: "production", mutationsEnabled: true, port: 8080, listenHost: "0.0.0.0", releaseImageDigest: null });
    expect(loadInfrastructureEnv({ VSP_ENVIRONMENT: "ci", VSP_MUTATIONS_ENABLED: "false" }, { defaultPort: 8081 })).toEqual({ environment: "ci", mutationsEnabled: false, port: 8081, listenHost: "127.0.0.1", releaseImageDigest: null });
    // WP-07: a live unit on a developer host listens on loopback only; local/ci can never widen to every interface.
    expect(loadInfrastructureEnv({ VSP_ENVIRONMENT: "sandbox", VSP_LISTEN_HOST: "127.0.0.1" }).listenHost).toBe("127.0.0.1");
    expect(loadInfrastructureEnv({ VSP_ENVIRONMENT: "local", VSP_LISTEN_HOST: "0.0.0.0" }).listenHost).toBe("127.0.0.1");
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
    expect(reason({ VSP_ENVIRONMENT: "sandbox", VSP_LISTEN_HOST: "192.0.2.10" })).toBe("INFRA_ENV_LISTEN_HOST_INVALID:VSP_LISTEN_HOST");
    // OPS-APPR-01: the running image digest is strict (a tag or a truncated digest is refused, never ignored).
    const digest = `sha256:${"c".repeat(64)}`;
    expect(loadInfrastructureEnv({ VSP_ENVIRONMENT: "production", VSP_RELEASE_IMAGE_DIGEST: digest }).releaseImageDigest).toBe(digest);
    for (const bad of ["latest", `sha256:${"c".repeat(63)}`, `SHA256:${"c".repeat(64)}`, `sha256:${"C".repeat(64)}`]) {
      expect(reason({ VSP_ENVIRONMENT: "production", VSP_RELEASE_IMAGE_DIGEST: bad })).toBe("INFRA_ENV_RELEASE_IMAGE_DIGEST_INVALID:VSP_RELEASE_IMAGE_DIGEST");
    }
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

describe("config module surface (ICR: typed PlatformConfig.gateway and index exports)", () => {
  it("[OPS-04][SPEC-8.oauth2] the config index exports loadInfrastructureEnv and gatewayConfigOf; PlatformConfig.gateway is typed and still re-validated", () => {
    expect(configModule.loadInfrastructureEnv).toBe(loadInfrastructureEnv);
    expect(configModule.gatewayConfigOf).toBe(gatewayConfigOf);
    expect(configModule.InfrastructureEnvRejectedError).toBe(InfrastructureEnvRejectedError);
    const cfg: PlatformConfig = loadPlatformConfig({ environment: "local", env: {} }).config;
    const typed: GatewayConfig = { inboundAuth: null, http: { bodyLimitBytes: 65_536, rateLimit: null } };
    expect(gatewayConfigOf({ ...cfg, gateway: typed })).toEqual(typed);
    // A section built in code that bypassed the schema still fails closed.
    const forged = { ...cfg, gateway: { ...typed, http: { bodyLimitBytes: 1, rateLimit: null } } };
    expect(() => gatewayConfigOf(forged)).toThrow(ConfigInvalidError);
  });
});
