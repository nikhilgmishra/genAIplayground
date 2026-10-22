/** Media worker configuration and Agents server construction (media/src/worker) [FO-10-01][OPS-04]. */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAgent } from "@livekit/agents";
import { afterAll, describe, expect, it } from "vitest";
import agent from "../src/worker/agent.js";
import { MediaConfigError, loadMediaWorkerConfig, parseMediaWorkerConfig } from "../src/worker/config.js";
import { agentEntryFile, createMediaAgentServer } from "../src/worker/server.js";

const BASE = {
  schemaVersion: "vsp.media-worker-config.v1",
  environment: "ci",
  agentName: "vsp-media",
  workerInstanceRef: "media-worker-a1",
  adapter: "controlled_cascade_runtime",
  language: "en",
  livekit: { wsUrl: "ws://127.0.0.1:57880", apiUrl: "https://livekit.vsp.test", addressClass: "PRIVATE_NETWORK" },
  gateway: { baseUrl: "https://gateway.vsp.test", addressClass: "PRIVATE_NETWORK", timeoutMs: 4_000 },
  runtimeAuth: { tokenUrl: "https://idp.vsp.test/realms/media/protocol/openid-connect/token", clientId: "vsp-media-runtime", scope: "vsp.conversation_runtime", addressClass: "PRIVATE_NETWORK" },
  recording: { enabled: true },
  egress: { policyVersion: "egress-media-ci-1", destinations: [] },
  loopbackRoutes: [{ host: "gateway.vsp.test", port: 50443, tls: true }],
  playback: { sampleRate: 48_000, comfortNoiseDbfs: -66, slowerRate: 0.8 },
  recovery: { bindDeadlineMs: 45_000, humanDeadlineMs: 30_000 },
  reconcileIntervalMs: 2_000,
  health: { host: "127.0.0.1", port: 0 },
};

const dir = mkdtempSync(join(tmpdir(), "vsp-media-config-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const codes = (raw: unknown) => {
  try {
    parseMediaWorkerConfig(raw);
    return [];
  } catch (e) {
    return (e as MediaConfigError).reasonCodes;
  }
};

describe("MediaWorkerConfig [OPS-04]", () => {
  it("a local/ci configuration parses with defaults (menu with a person, no fault seams)", () => {
    const c = parseMediaWorkerConfig(BASE);
    expect(c.dtmfMenu["0"]).toBe("REQUEST_HUMAN");
    expect(c.faultSeams).toBe(false);
  });

  it("[OPS-04] adversarial: production refuses plain ws, loopback emulator routes and fault seams; unknown keys are refused", () => {
    const prod = { ...BASE, environment: "production" };
    expect(codes(prod)).toEqual(expect.arrayContaining(["MEDIA_LIVEKIT_WS_NOT_TLS", "MEDIA_LOOPBACK_ROUTE_IN_LIVE_ENVIRONMENT"]));
    expect(codes({ ...prod, livekit: { ...BASE.livekit, wsUrl: "wss://livekit.example.test" }, loopbackRoutes: [], faultSeams: true })).toEqual(["MEDIA_FAULT_SEAM_IN_LIVE_ENVIRONMENT"]);
    expect(codes({ ...prod, livekit: { ...BASE.livekit, wsUrl: "wss://livekit.example.test" }, loopbackRoutes: [] })).toEqual([]);
    expect(codes({ ...BASE, devBypass: true }).length).toBeGreaterThan(0);
    expect(codes({ ...BASE, gateway: { ...BASE.gateway, baseUrl: "http://gateway.vsp.test" } }).length).toBeGreaterThan(0);
    expect(codes({ ...BASE, dtmfMenu: { "1": "REPEAT" } }).length).toBeGreaterThan(0);
  });

  it("loading needs the file and the three secrets from the environment, and names what is missing (never their values)", () => {
    const file = join(dir, "media.json");
    writeFileSync(file, JSON.stringify(BASE));
    expect(() => loadMediaWorkerConfig({})).toThrow("VSP_MEDIA_CONFIG_FILE_MISSING");
    const err = (() => {
      try {
        loadMediaWorkerConfig({ VSP_MEDIA_CONFIG_FILE: file, LIVEKIT_API_KEY: "lkkey_synthUnit01" });
      } catch (e) {
        return e as MediaConfigError;
      }
      return null;
    })();
    expect(err?.reasonCodes).toEqual(["LIVEKIT_API_SECRET_MISSING", "VSP_MEDIA_RUNTIME_CLIENT_SECRET_MISSING"]);
    const ok = loadMediaWorkerConfig({ VSP_MEDIA_CONFIG_FILE: file, LIVEKIT_API_KEY: "lkkey_synthUnit01", LIVEKIT_API_SECRET: "lksecret_synthOnlyForUnitTests0123456789", VSP_MEDIA_RUNTIME_CLIENT_SECRET: "rtsecret_synthOnlyForUnitTests" });
    expect(ok.secrets.livekitApiKey).toBe("lkkey_synthUnit01");
    expect(JSON.stringify(ok.config)).not.toContain("lksecret_");
  });
});

describe("Agents worker [FO-10-01]", () => {
  it("the job module default-exports an Agents agent and the server points the job processes at it", () => {
    expect(isAgent(agent)).toBe(true);
    expect(existsSync(agentEntryFile())).toBe(true);
    const server = createMediaAgentServer(parseMediaWorkerConfig(BASE), { livekitApiKey: "lkkey_synthUnit01", livekitApiSecret: "lksecret_synthOnlyForUnitTests0123456789", runtimeClientSecret: "rtsecret_synthOnlyForUnitTests" });
    expect(server).toBeTruthy();
  });
});
