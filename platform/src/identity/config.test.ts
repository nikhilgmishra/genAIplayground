import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { TENANT_ID } from "../fixtures/synthetic-world.js";
import { ValidationError } from "../shared/errors.js";
import { DEFAULT_VERIFICATION_CONFIG, identityConfigFromPlatform, sessionConfig, verificationConfig } from "./config.js";
import { DynamoKvStore } from "./kv/dynamo-kv-store.js";

describe("identity configuration", () => {
  it("[SPEC-7.OTP] defaults are the spec's proposed values pending security approval, with OTP disabled (TB-03 unknown)", () => {
    expect(DEFAULT_VERIFICATION_CONFIG).toMatchObject({
      otpEnabled: false,
      otpExpirySeconds: 300,
      otpMaxAttemptsPerChallenge: 3,
      otpMaxPerAccountPerHour: 5,
      secureLinkExpirySeconds: 300,
      stepUpMaxAuthAgeSeconds: 120,
      recentChannelChangeDays: 30,
    });
    expect(DEFAULT_VERIFICATION_CONFIG.acceptedAmr).toEqual(["mfa", "hwk", "swk", "otp", "fido", "pop"]);
    expect(DEFAULT_VERIFICATION_CONFIG.acceptedAmr).not.toContain("pwd");
  });

  it("[AUTH-03] the default consent channels exclude the model-facing MCP channel; only telephony control starts calls", () => {
    const s = sessionConfig({ tenantId: TENANT_ID, environment: "local", policyVersion: "p1" });
    expect(s.consentChannels).not.toContain("mcp_tools");
    expect(s.startCallChannels).toEqual(["telephony_control"]);
    expect(s.resolveChannels).toEqual(["mcp_tools", "telephony_control", "portal"]);
  });

  it("[SPEC-7.SESSION] maps the repository's local platform configuration and rejects out-of-range values", () => {
    const local = JSON.parse(readFileSync(new URL("../../config/local.json", import.meta.url), "utf8")) as Parameters<typeof identityConfigFromPlatform>[0];
    const cfg = identityConfigFromPlatform(local, { policyVersion: "policy-local-1", otpEnabled: false });
    expect(cfg.session.sessionTtlSeconds).toBe(local.sessionBinding.sessionTtlSeconds);
    expect(cfg.verification.otpMaxAttemptsPerChallenge).toBe(local.verification.otpMaxAttemptsPerChallenge);
    expect(cfg.verification.maxAuthAgeSeconds).toBe(local.verification.maxAuthAgeSeconds);
    expect(() => verificationConfig({ otpExpirySeconds: 5 })).toThrow(ValidationError);
    expect(() => verificationConfig({ acceptedAmr: [] })).toThrow(ValidationError);
    expect(() => sessionConfig({ tenantId: "not-opaque", environment: "local", policyVersion: "p1" })).toThrow(ValidationError);
  });

  it("[SPEC-7.KV] DynamoKvStore.fromClient wraps a DynamoDBClient without any network call", () => {
    const store = DynamoKvStore.fromClient(new DynamoDBClient({ region: "us-east-1" }), "vsp-local-sessions");
    expect(store.kind).toBe("live");
  });
});
