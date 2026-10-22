/**
 * Provider catalogue discovery (WP-08; FO-09-11, OPS-06): dated snapshots of the model ids an account lists, through
 * the egress-classified transport to the protocol emulator (OpenAI and vLLM `/v1/models`; Bedrock control plane
 * `/foundation-models`, SigV4-signed by the platform signer and verified by the emulator). Synthetic ids only.
 */
import { createHash, createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConnectorHttpTransport } from "../../connectors/http/transport.js";
import { EgressGuard } from "../../privacy/egress.js";
import { egressBindingFor } from "../port/config.js";
import type { ModelEndpointConfig } from "../port/config.js";
import { ModelEmulator } from "../../../test/emulators/models/server.js";
import { endpointConfig, egressPolicyFor, hostFor, syntheticAws, syntheticKey } from "../../../test/emulators/models/harness.js";
import { discoverCatalogue, snapshotFileName } from "./discovery.js";
import { TransportModelExchange } from "./http-exchange.js";

let emulator: ModelEmulator;
beforeAll(async () => {
  emulator = await new ModelEmulator({ httpPort: 0, frameDelayMs: 1 }).start();
});
afterAll(async () => {
  await emulator.stop();
});

function exchangeFor(e: ModelEndpointConfig, host: string, extraHosts: string[] = []) {
  const policy = egressPolicyFor([e], { [e.endpointRef]: extraHosts });
  const transport = new ConnectorHttpTransport({ environment: "local", egress: new EgressGuard(policy, { environment: "local" }).forModelEndpoint(egressBindingFor(e)), loopbackRoutes: new Map([host, ...extraHosts].map((h) => [h, { port: emulator.httpPort, tls: false }])) });
  return new TransportModelExchange(transport, { allowedHosts: [host, ...extraHosts], addressClass: "PUBLIC_INTERNET" });
}

describe("catalogue discovery [FO-09-11][OPS-06]", () => {
  it("[FO-09-11] OpenAI and vLLM listings become sorted, digested, dated snapshots that say whether the pinned id is listed", async () => {
    const host = hostFor("openai_responses");
    const e = endpointConfig("openai_responses", host);
    const key = syntheticKey();
    emulator.registerHost(host, { bearer: [key], models: ["emulated-tools", "emulated-text"] });
    const snap = await discoverCatalogue(e, { exchange: exchangeFor(e, host), credential: { kind: "bearer", token: async () => key }, now: () => new Date("2026-10-21T08:00:00Z") });
    expect(snap).toMatchObject({ schemaVersion: "model-catalogue-snapshot.v1", provider: "openai_responses", capturedAt: "2026-10-21T08:00:00.000Z", source: "GET /v1/models", pinnedModelListed: true });
    expect(snap.models.map((m) => m.id)).toEqual(["emulated-text", "emulated-tools"]);
    expect(snap.modelsDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshotFileName(snap)).toBe(`2026-10-21-${e.endpointRef}.json`);
    const vhost = hostFor("vllm_openai_compatible");
    const v = endpointConfig("vllm_openai_compatible", vhost, { model: { id: "emulated-other", revision: "r1" } });
    emulator.registerHost(vhost, { bearer: "none", models: ["emulated-text"] });
    const vs = await discoverCatalogue(v, { exchange: exchangeFor(v, vhost), credential: null, now: () => new Date() });
    expect(vs).toMatchObject({ pinnedModelListed: false, models: [{ id: "emulated-text", maxModelLen: 32_768 }] });
  });

  it("[FO-09-11][FO-09-06] Bedrock: the control-plane listing is SigV4-signed by the platform signer and verified by the emulator", async () => {
    const host = hostFor("bedrock_converse");
    const cp = `bedrock.${host}`;
    const e = endpointConfig("bedrock_converse", host);
    const aws = syntheticAws();
    emulator.registerHost(cp, { aws: [aws], region: "us-east-1", models: ["emulated-text"] });
    const snap = await discoverCatalogue(e, { exchange: exchangeFor(e, host, [cp]), credential: { kind: "aws", credentials: async () => aws }, now: () => new Date(), controlPlaneUrl: new URL(`https://${cp}/foundation-models?byOutputModality=TEXT`) });
    expect(snap).toMatchObject({ source: "GET /foundation-models", pinnedModelListed: true, models: [{ id: "emulated-text", lifecycle: "ACTIVE", streaming: true, outputModalities: ["TEXT"] }] });
    expect(emulator.requests(cp)[0]).toMatchObject({ api: "bedrock_control", sigv4: "VERIFIED" });
  });

  it("[OPS-05] adversarial: without a credential nothing is requested; a rejected key is a typed refusal", async () => {
    const host = hostFor("openai_responses");
    const e = endpointConfig("openai_responses", host);
    emulator.registerHost(host, { bearer: [syntheticKey()], models: [] });
    await expect(discoverCatalogue(e, { exchange: exchangeFor(e, host), credential: null, now: () => new Date() })).rejects.toMatchObject({ reasonCode: "MODEL_CREDENTIAL_NOT_CONFIGURED" });
    expect(emulator.requests(host)).toEqual([]);
    await expect(discoverCatalogue(e, { exchange: exchangeFor(e, host), credential: { kind: "bearer", token: async () => "key_synthWrong" }, now: () => new Date() })).rejects.toMatchObject({ reasonCode: "MODEL_AUTH_REJECTED", httpStatus: 401 });
  });

  it("[OPS-06][DATA-01] adversarial: a snapshot keeps no account identifiers (org/user owners, fine-tuned ids, account ARNs); the pinned check uses the provider ids", async () => {
    // UNIT FAKE exchange: one canned listing body (synthetic), standing in for a provider account's /v1/models.
    const listing = {
      object: "list",
      data: [
        { id: "emulated-text", object: "model", owned_by: "system" },
        { id: "emulated-tools", object: "model", owned_by: "org-synthAccount0001" },
        { id: "ft:emulated-base:synth-org-name::AbC123xy", object: "model", owned_by: "user-synthOwner0001" },
        { id: "arn:aws:bedrock:us-east-1:000000000000:custom-model/emulated-base/synth01", object: "model", owned_by: "proj_synthProject01" },
      ],
    };
    const fake = { incremental: false, send: async () => ({ status: 200, headers: { "content-type": "application/json" }, body: (async function* () { yield Buffer.from(JSON.stringify(listing)); })() }) };
    const e = endpointConfig("openai_responses", hostFor("openai_responses"), { model: { id: "ft:emulated-base:synth-org-name::AbC123xy", revision: "r1" } });
    const snap = await discoverCatalogue(e, { exchange: fake, credential: { kind: "bearer", token: async () => "key_synthFakeListing" }, now: () => new Date("2026-10-21T08:00:00Z") });
    const dump = JSON.stringify(snap);
    for (const leaked of ["org-synthAccount0001", "user-synthOwner0001", "proj_synthProject01", "synth-org-name", "000000000000", "AbC123xy"]) expect(dump, leaked).not.toContain(leaked);
    expect(snap.pinnedModelListed).toBe(true);
    expect(snap.accountScopedModels).toBe(2);
    expect(snap.models.map((m) => m.ownedBy).sort()).toEqual(["ACCOUNT_SCOPED", "ACCOUNT_SCOPED", "ACCOUNT_SCOPED", "system"]);
    expect(snap.models.filter((m) => m.id.startsWith("account-scoped:")).every((m) => /^account-scoped:[0-9a-f]{24}$/.test(m.id))).toBe(true);
    expect(snap.models.map((m) => m.id)).toEqual(expect.arrayContaining(["emulated-text", "emulated-tools"]));
    expect(snap.accountScopedIdDigest).toBe("EPHEMERAL");
  });

  it("[OPS-06][DATA-01] adversarial: account-scoped ids are KEYED digests: an offline guess of the account id cannot confirm them; a configured key makes them stable across snapshots", async () => {
    const arn = "arn:aws:bedrock:us-east-1:000000000000:custom-model/emulated-base/synth01";
    const listing = { object: "list", data: [{ id: "emulated-text", object: "model", owned_by: "system" }, { id: arn, object: "model", owned_by: "system" }] };
    const fake = { incremental: false, send: async () => ({ status: 200, headers: { "content-type": "application/json" }, body: (async function* () { yield Buffer.from(JSON.stringify(listing)); })() }) };
    const e = endpointConfig("openai_responses", hostFor("openai_responses"));
    const deps = { exchange: fake, credential: { kind: "bearer" as const, token: async () => "key_synthFakeListing" }, now: () => new Date("2026-10-21T08:00:00Z") };
    const digestOf = (s: { models: { id: string }[] }) => s.models.find((m) => m.id.startsWith("account-scoped:"))?.id;
    // Without a key: a fresh key per snapshot, so two snapshots never share the digest and none matches an unkeyed guess.
    const a = await discoverCatalogue(e, deps);
    const b = await discoverCatalogue(e, deps);
    expect(digestOf(a)).not.toBe(digestOf(b));
    const unkeyed = `account-scoped:${createHash("sha256").update(`model-id\0${arn}`).digest("hex").slice(0, 24)}`;
    expect([digestOf(a), digestOf(b)]).not.toContain(unkeyed);
    // With the configured key: stable, and HMAC under that key (a wrong key gives another digest).
    const key = Buffer.alloc(32, 3);
    const k1 = await discoverCatalogue(e, { ...deps, idDigestKey: key });
    const k2 = await discoverCatalogue(e, { ...deps, idDigestKey: key });
    expect(digestOf(k1)).toBe(digestOf(k2));
    expect(digestOf(k1)).toBe(`account-scoped:${createHmac("sha256", key).update(`model-id\0${arn}`).digest("hex").slice(0, 24)}`);
    expect(k1.accountScopedIdDigest).toBe("KEYED");
    expect(digestOf(await discoverCatalogue(e, { ...deps, idDigestKey: Buffer.alloc(32, 4) }))).not.toBe(digestOf(k1));
    await expect(discoverCatalogue(e, { ...deps, idDigestKey: Buffer.alloc(31) })).rejects.toThrow("MODEL_CATALOGUE_DIGEST_KEY_TOO_SHORT");
  });
});
