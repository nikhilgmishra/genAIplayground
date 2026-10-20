/**
 * SecretResolver (WP-06; FO-06-04, FO-16-31, FO-15-26; AUTH-06, DATA-01). Layer 1: the production
 * SecretsManagerSecretResolver over a labelled UNIT FAKE Secrets Manager sender (the same resolver runs
 * against LocalStack Secrets Manager in platform/test/integration/connectors).
 */
import { inspect } from "node:util";
import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { describe, expect, it } from "vitest";
import { createMemoryLogger } from "../../observability/logger.js";
import { FakeClock } from "../../shared/clock.js";
import { secretResolverCredentials } from "./credentials.js";
import { LocalFixtureSecretResolver, SecretValue, SecretsManagerSecretResolver, createSecretResolver } from "./resolver.js";

const REF = "arn:aws:secretsmanager:us-east-1:111122223333:secret:vsp/test-connector-read";

/** UNIT FAKE of the Secrets Manager API (version stages, rotation, failures); not an emulator. */
class FakeSecretsManagerUnitFake {
  calls: { stage: string | undefined }[] = [];
  versions = new Map<string, { id: string; value: string }>([["AWSCURRENT", { id: "v1", value: JSON.stringify({ clientId: "client-read", clientSecret: "sec_synthClientSecretV1" }) }]]);
  fail: string | null = null;
  async send(c: GetSecretValueCommand): Promise<unknown> {
    this.calls.push({ stage: c.input.VersionStage });
    if (this.fail) throw Object.assign(new Error("boom with detail"), { name: this.fail });
    const v = this.versions.get(c.input.VersionStage ?? "AWSCURRENT");
    if (!v) throw Object.assign(new Error("no such version"), { name: "ResourceNotFoundException" });
    return { VersionId: v.id, SecretString: v.value };
  }
  rotate(id: string, value: Record<string, unknown>): void {
    const cur = this.versions.get("AWSCURRENT");
    if (cur) this.versions.set("AWSPREVIOUS", cur);
    this.versions.set("AWSCURRENT", { id, value: JSON.stringify(value) });
  }
}

describe("SecretsManagerSecretResolver [FO-06-04][AUTH-06]", () => {
  it("[FO-06-04] positive: resolves the current version, caches within the TTL, re-reads after it", async () => {
    const sm = new FakeSecretsManagerUnitFake();
    const clock = new FakeClock(new Date("2026-10-19T10:00:00Z"));
    const r = new SecretsManagerSecretResolver(sm, { clock, cacheTtlMs: 60_000 });
    const a = await r.resolve(REF);
    expect([a.versionId, a.stage]).toEqual(["v1", "AWSCURRENT"]);
    expect(a.value.json()).toEqual({ clientId: "client-read", clientSecret: "sec_synthClientSecretV1" });
    await r.resolve(REF);
    expect(sm.calls).toHaveLength(1);
    sm.rotate("v2", { clientId: "client-read", clientSecret: "sec_synthClientSecretV2" });
    clock.advanceMs(61_000);
    expect((await r.resolve(REF)).versionId).toBe("v2");
    expect(sm.calls).toHaveLength(2);
  });

  it("[FO-06-04][FO-15-26] rotation without restart: refresh() after an authentication failure picks up the new version immediately", async () => {
    const sm = new FakeSecretsManagerUnitFake();
    const r = new SecretsManagerSecretResolver(sm, { clock: new FakeClock(new Date("2026-10-19T10:00:00Z")), cacheTtlMs: 3_600_000 });
    expect((await r.resolve(REF)).versionId).toBe("v1");
    sm.rotate("v2", { clientId: "client-read", clientSecret: "sec_synthClientSecretV2" });
    expect((await r.resolve(REF)).versionId).toBe("v1"); // still cached
    r.refresh(REF);
    expect((await r.resolve(REF)).versionId).toBe("v2");
    expect((await r.resolve(REF, "AWSPREVIOUS")).versionId).toBe("v1");
    expect(sm.calls.map((c) => c.stage)).toEqual(["AWSCURRENT", "AWSCURRENT", "AWSPREVIOUS"]);
  });

  it("[FO-06-04][FO-15-26] a read in flight when refresh() runs answers the caller waiting for it but is never cached: the next resolve reads the rotated version", async () => {
    const sm = new FakeSecretsManagerUnitFake();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    // The store answers with the version current when the read arrived, after the gate opens.
    const gated = { send: async (c: GetSecretValueCommand) => { const v = await sm.send(c); await gate; return v; } };
    const r = new SecretsManagerSecretResolver(gated, { clock: new FakeClock(new Date("2026-10-19T10:00:00Z")), cacheTtlMs: 3_600_000 });
    const first = r.resolve(REF);
    await Promise.resolve();
    sm.rotate("v2", { clientId: "client-read", clientSecret: "sec_synthClientSecretV2" });
    r.refresh(REF); // an authentication failure or an operator rotation while the read is in flight
    release();
    expect((await first).versionId).toBe("v1");
    expect((await r.resolve(REF)).versionId).toBe("v2");
    expect(sm.calls).toHaveLength(2);
    expect((await r.resolve(REF)).versionId).toBe("v2"); // and v2 is cached
    expect(sm.calls).toHaveLength(2);
  });

  it("[FO-06-04] adversarial: references that are not resolvable secrets are refused before any call", async () => {
    const sm = new FakeSecretsManagerUnitFake();
    const r = new SecretsManagerSecretResolver(sm, { clock: new FakeClock(new Date()) });
    await expect(r.resolve("arn:aws:kms:us-east-1:111122223333:key/abcd-1234")).rejects.toThrow("SECRET_REF_NOT_A_SECRET");
    await expect(r.resolve("arn:aws:ssm:us-east-1:111122223333:parameter/vsp/x")).rejects.toThrow("SECRET_STORE_NOT_SUPPORTED");
    await expect(r.resolve("Bearer SYNTHETIC-pasted-token")).rejects.toThrow("SECRET_REF_INVALID");
    await expect(r.resolve("local-fixture:conn/read")).rejects.toThrow("SECRET_REF_INVALID");
    expect(sm.calls).toHaveLength(0);
  });

  it("[FO-06-04] failure injection: store errors map to reason codes; vendor error text never surfaces", async () => {
    const sm = new FakeSecretsManagerUnitFake();
    const r = new SecretsManagerSecretResolver(sm, { clock: new FakeClock(new Date()) });
    for (const [name, code, outcome] of [
      ["ResourceNotFoundException", "SECRET_NOT_FOUND", "FAILED"],
      ["AccessDeniedException", "SECRET_ACCESS_DENIED", "FAILED"],
      ["InternalServiceError", "SECRET_STORE_UNAVAILABLE", "NOT_STARTED"],
    ] as const) {
      sm.fail = name;
      const e = (await r.resolve(REF).then(() => null, (x: unknown) => x)) as { reasonCode: string; outcome: string; message: string };
      expect([e.reasonCode, e.outcome, e.message]).toEqual([code, outcome, code]);
    }
    sm.fail = null;
    sm.versions.set("AWSCURRENT", { id: "v9", value: "" });
    await expect(r.resolve(REF)).rejects.toThrow("SECRET_MALFORMED");
  });

  it("[AUTH-06][DATA-01] secret material is redacted in every string, JSON and inspect form and never reaches logs", async () => {
    const v = new SecretValue("SYNTHETIC-super-secret");
    expect(String(v)).toBe("[secret]");
    expect(JSON.stringify({ v })).toBe('{"v":"[secret]"}');
    expect(inspect(v)).toBe("[secret]");
    expect(`${v}`).toBe("[secret]");
    const { logger, records } = createMemoryLogger();
    logger.info("connector.secret", { value: String(v) });
    expect(JSON.stringify(records)).not.toContain("SYNTHETIC-super-secret");
    expect(v.reveal()).toBe("SYNTHETIC-super-secret");
  });
});

describe("resolver selection by environment [FO-06-04][OPS-04]", () => {
  it("[OPS-04] fixture references are refused outside local/ci; a deployed environment has no fixture resolver", async () => {
    const clock = new FakeClock(new Date());
    const fixture = new LocalFixtureSecretResolver(clock).set("local-fixture:conn/read", { clientId: "c", clientSecret: "SYNTHETIC" });
    expect(() => createSecretResolver({ environment: "production", secretsManager: null, fixture })).toThrow("SECRET_FIXTURE_RESOLVER_OUTSIDE_LOCAL");
    const sm = new SecretsManagerSecretResolver(new FakeSecretsManagerUnitFake(), { clock });
    const prod = createSecretResolver({ environment: "production", secretsManager: sm });
    await expect(prod.resolve("local-fixture:conn/read")).rejects.toThrow("SECRET_FIXTURE_REF_REFUSED");
    expect((await prod.resolve(REF)).versionId).toBe("v1");
    const local = createSecretResolver({ environment: "ci", secretsManager: null, fixture });
    expect((await local.resolve("local-fixture:conn/read")).value.json()).toEqual({ clientId: "c", clientSecret: "SYNTHETIC" });
    await expect(local.resolve(REF)).rejects.toThrow("SECRET_STORE_NOT_CONFIGURED");
  });

  it("[FO-06-04] the Salesforce adapter's credentials() callback can be bound to the resolver (current version on every call)", async () => {
    const sm = new FakeSecretsManagerUnitFake();
    const r = new SecretsManagerSecretResolver(sm, { clock: new FakeClock(new Date()), cacheTtlMs: 0 });
    const creds = secretResolverCredentials(r, REF);
    expect(await creds()).toEqual({ clientId: "client-read", clientSecret: "sec_synthClientSecretV1" });
    sm.rotate("v2", { clientId: "client-read", clientSecret: "sec_synthClientSecretV2" });
    expect((await creds()).clientSecret).toBe("sec_synthClientSecretV2");
    sm.rotate("v3", { clientId: "client-read" });
    await expect(creds()).rejects.toThrow("SECRET_MALFORMED");
  });
});
