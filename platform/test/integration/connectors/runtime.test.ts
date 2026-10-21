/**
 * Layer 2 (WP-06): the production connector runtime over TLS, with its credentials in LocalStack Secrets
 * Manager and its capability evidence signed by LocalStack KMS (FO-06-02 convention: the exact production
 * classes against a protocol emulator). EMULATED, not vendor evidence: the vendor side is the protocol
 * emulator in emulator.ts on 127.0.0.1 behind a private test CA; what it does not prove is any real
 * vendor's documented behaviour, quotas or auth policies (deploy/local/README.md; vendor sandbox runs are
 * Layer 5).
 *
 * Covered here: Secrets Manager resolution with version stages and rotation picked up without restart
 * (FO-06-04, FO-03-29, FO-16-31, FO-15-26), the single refresh on 401 (FO-06-03), a host outside the
 * profile and a redirect refused before I/O (FO-06-13, FO-06-20), Retry-After and the token bucket
 * (FO-06-07; after a pause the queued callers restart spaced at their budget), timeout classification
 * (FO-06-08, ACT-03), capability-scoped credentials (FO-05-56), active probes and KMS-signed capability
 * evidence (FO-06-11, FO-06-18; a sandbox write never runs on a PRODUCTION_WRITE profile), pagination past
 * empty pages, the non-advancing cursor and OFFSET resume positions (FO-06-06), the reconcile lookup's
 * not-found answers (404 and an empty list-style lookup; ACT-03) and the SCHEMA_DRIFT seam (FO-06-05).
 */
import { request as httpsRequest } from "node:https";
import { CreateKeyCommand, ScheduleKeyDeletionCommand } from "@aws-sdk/client-kms";
import { GetSecretValueCommand, PutSecretValueCommand, UpdateSecretVersionStageCommand } from "@aws-sdk/client-secrets-manager";
import type { GetSecretValueCommand as GetCmd } from "@aws-sdk/client-secrets-manager";
import { afterAll, beforeAll, describe, expect, onTestFinished } from "vitest";
import { ConnectorSchemaDriftError } from "../../../src/connectors/dsl/errors.js";
import { TransportError } from "../../../src/connectors/http/transport.js";
import { ConnectorError, ConnectorRefusal } from "../../../src/connectors/runtime/errors.js";
import { KmsEvidenceSigner, capabilityEvidenceFrom, signCapabilityEvidence, verifyEvidenceSignature } from "../../../src/connectors/runtime/evidence.js";
import { probeConnector, verifyPendingCredentials } from "../../../src/connectors/runtime/health.js";
import { SecretsManagerSecretResolver } from "../../../src/connectors/secrets/resolver.js";
import { DEFAULT_METRIC_CATALOGUE, InMemoryMetrics } from "../../../src/observability/metrics.js";
import { withConnectorMetrics } from "../../../src/observability/catalog/connectors.js";
import { FakeClock, systemClock } from "../../../src/shared/clock.js";
import { DependencyError, ValidationError } from "../../../src/shared/errors.js";
import { kmsClient, secretsClient, uniqueName } from "../_harness/clients.js";
import { layer2 } from "../_harness/layer2.js";
import { VendorEmulator } from "./emulator.js";
import { API_HOST, READ_CAPABILITY, TENANT_ID, WRITE_CAPABILITY } from "./profiles.js";
import type { ProfileOptions } from "./profiles.js";
import { schemaDriftSeam } from "./seams.js";
import { createSecret, createTestPki, deleteSecret, liveRig } from "./support.js";
import type { LiveRig, LiveRigOptions, TestPki } from "./support.js";

const it = layer2(["localstack"]);
type ProfileDraft = Parameters<NonNullable<ProfileOptions["mutate"]>>[0];
let pki: TestPki;
beforeAll(() => {
  pki = createTestPki();
});
afterAll(() => pki?.dispose());

async function rig(l2: Parameters<typeof liveRig>[0], o: LiveRigOptions = {}): Promise<LiveRig> {
  const r = await liveRig(l2, pki, o);
  onTestFinished(() => r.dispose());
  return r;
}

async function failure(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a failure");
}

const GET = { params: { appointmentId: "apt-00001" } };
const readiness = (r: LiveRig, capability = READ_CAPABILITY) => r.rt.readiness().find((x) => x.capability === capability);

describe("Secrets Manager resolution on LocalStack [FO-06-04][FO-03-29][FO-16-31]", () => {
  it("[FO-06-04][FO-03-29][FO-16-31] the production SecretResolver reads arn:aws:secretsmanager references: AWSCURRENT cached within its TTL, AWSPENDING by stage, a promoted version picked up after the TTL; values never serialize", async ({ l2 }) => {
    const sm = secretsClient(l2);
    let calls = 0;
    const counting = { send: (c: GetCmd) => ((calls += 1), sm.send(c)) };
    const clock = new FakeClock(new Date());
    const metrics = new InMemoryMetrics({ catalogue: withConnectorMetrics(DEFAULT_METRIC_CATALOGUE) });
    const resolver = new SecretsManagerSecretResolver(counting, { clock, cacheTtlMs: 60_000, metrics });
    const arn = await createSecret(sm, "resolver", { clientId: "client-x", clientSecret: "synthetic-value-v1" });
    onTestFinished(() => deleteSecret(sm, arn));

    const a = await resolver.resolve(arn);
    const b = await resolver.resolve(arn);
    expect([a.value.json().clientSecret, b.versionId, a.stage, calls]).toEqual(["synthetic-value-v1", a.versionId, "AWSCURRENT", 1]);
    expect(metrics.counterValue("vsp_connector_secret_resolutions_total", { result: "cache_hit" })).toBe(1);
    expect(JSON.stringify(a)).not.toContain("synthetic-value-v1");
    expect(String(a.value)).not.toContain("synthetic-value-v1");

    // Rotation step 1 (createSecret of a rotation function): the new value is staged AWSPENDING only.
    const put = await sm.send(new PutSecretValueCommand({ SecretId: arn, SecretString: JSON.stringify({ clientId: "client-x", clientSecret: "synthetic-value-v2" }), VersionStages: ["AWSPENDING"] }));
    const pending = await resolver.resolve(arn, "AWSPENDING");
    expect([pending.versionId, pending.value.json().clientSecret]).toEqual([put.VersionId, "synthetic-value-v2"]);
    resolver.refresh(arn);
    expect((await resolver.resolve(arn)).versionId).toBe(a.versionId);

    // Rotation step 4 (finishSecret): AWSCURRENT moves; a resolver that sees no auth failure picks it up within its TTL bound.
    await sm.send(new UpdateSecretVersionStageCommand({ SecretId: arn, VersionStage: "AWSCURRENT", MoveToVersionId: put.VersionId, RemoveFromVersionId: a.versionId }));
    expect((await resolver.resolve(arn)).versionId).toBe(a.versionId);
    clock.advanceMs(60_001);
    const current = await resolver.resolve(arn);
    expect([current.versionId, current.value.json().clientSecret]).toEqual([put.VersionId, "synthetic-value-v2"]);
  });

  it("[FO-06-04] failure injection: a missing secret, a KMS key ARN and an SSM parameter are refused with typed reasons (the last two before any call)", async ({ l2 }) => {
    const sm = secretsClient(l2);
    let calls = 0;
    const resolver = new SecretsManagerSecretResolver({ send: (c: GetCmd) => ((calls += 1), sm.send(c)) }, { clock: systemClock });
    const missing = (await failure(resolver.resolve(`arn:aws:secretsmanager:us-east-1:000000000000:secret:${uniqueName("vsp-it/absent")}`))) as DependencyError;
    expect([missing.reasonCode, missing.retryable]).toEqual(["SECRET_NOT_FOUND", false]);
    expect(calls).toBe(1);
    expect(((await failure(resolver.resolve("arn:aws:kms:us-east-1:000000000000:key/0000"))) as ValidationError).message).toContain("SECRET_REF_NOT_A_SECRET");
    expect(((await failure(resolver.resolve("arn:aws:ssm:us-east-1:000000000000:parameter/x"))) as ValidationError).message).toContain("SECRET_STORE_NOT_SUPPORTED");
    expect(calls).toBe(1);
  });
});

describe("token manager over TLS with Secrets Manager credentials [FO-06-03][FO-15-26][AUTH-04]", () => {
  it("[FO-06-03][FO-15-26] rotation without restart: PutSecretValue rotates the client secret and the vendor revokes the old tokens; the 401 drops the cached token and secret, and the one refresh uses the rotated version", async ({ l2 }) => {
    const r = await rig(l2);
    const first = await r.rt.execute("appointments.get", GET);
    const rotated = `read-${uniqueName("s")}`;
    const put = await r.sm.send(new PutSecretValueCommand({ SecretId: r.readRef, SecretString: JSON.stringify({ clientId: "client-read", clientSecret: rotated }) }));
    r.em.acceptSecret("client-read", rotated);
    r.em.revokeAllTokens();
    const second = await r.rt.execute("appointments.get", GET);
    const current = await r.sm.send(new GetSecretValueCommand({ SecretId: r.readRef }));
    expect(second.records).toHaveLength(1);
    expect([second.receipt.secretVersionId, current.VersionId]).toEqual([put.VersionId, put.VersionId]);
    expect(second.receipt.secretVersionId).not.toBe(first.receipt.secretVersionId);
    expect(r.em.tokenOutcomes).toEqual(["issued:client-read", "issued:client-read"]);
    expect(r.em.requestsTo("GET", "/api/v1/appointments/")).toHaveLength(3);
    expect(r.metrics.counterValue("vsp_connector_secret_resolutions_total", { result: "refreshed" })).toBe(1);
  });

  it("[FO-06-04][FO-15-26] rotation test before promotion: the AWSPENDING version staged with PutSecretValue authenticates (token and synthetic read) while traffic keeps AWSCURRENT; after promotion traffic moves to it", async ({ l2 }) => {
    const r = await rig(l2, { cacheTtlMs: 1_000 });
    const before = await r.rt.execute("appointments.get", GET);
    const next = `read-${uniqueName("s")}`;
    const put = await r.sm.send(new PutSecretValueCommand({ SecretId: r.readRef, SecretString: JSON.stringify({ clientId: "client-read", clientSecret: next }), VersionStages: ["AWSPENDING"] }));
    // Untested at the vendor: the pending value is refused there, and the check says so without touching readiness.
    const refused = await verifyPendingCredentials(r.rt);
    expect(refused.find((c) => c.access === "READ")).toMatchObject({ result: "FAIL", detailCode: "CONNECTOR_TOKEN_CLIENT_REJECTED" });
    // The vendor accepts both secrets during the overlap: the pending version passes.
    r.em.addSecret("client-read", next);
    const checks = await verifyPendingCredentials(r.rt);
    expect(checks.find((c) => c.access === "READ")).toEqual({ capability: READ_CAPABILITY, access: "READ", result: "PASS", detailCode: "PENDING_CREDENTIAL_READ_SYNTHETIC", secretVersionId: put.VersionId });
    expect(checks.find((c) => c.access === "WRITE")).toMatchObject({ result: "FAIL", detailCode: "CONNECTOR_CREDENTIAL_INVALID" }); // nothing staged for the write secret
    expect((await r.rt.execute("appointments.get", GET)).receipt.secretVersionId).toBe(before.receipt.secretVersionId);
    // Promotion (finishSecret): traffic uses the tested version once the resolver's TTL has passed.
    await r.sm.send(new UpdateSecretVersionStageCommand({ SecretId: r.readRef, VersionStage: "AWSCURRENT", MoveToVersionId: put.VersionId, RemoveFromVersionId: before.receipt.secretVersionId }));
    await new Promise((res) => setTimeout(res, 1_100));
    r.rt.tokens.invalidate({ capability: READ_CAPABILITY, access: "READ", credentialRef: r.readRef, scopes: ["appointments:read"] });
    expect((await r.rt.execute("appointments.get", GET)).receipt.secretVersionId).toBe(put.VersionId);
  });

  it("[FO-06-03][FO-15-26] rotation picked up on the token endpoint: with the old secret still cached, the expired token's renewal is refused invalid_client once; the resolver refreshes and the retry with the rotated version succeeds", async ({ l2 }) => {
    const clock = new FakeClock(new Date());
    const r = await rig(l2, { clock, cacheTtlMs: 3_600_000 });
    const first = await r.rt.execute("appointments.get", GET);
    const rotated = `read-${uniqueName("s")}`;
    const put = await r.sm.send(new PutSecretValueCommand({ SecretId: r.readRef, SecretString: JSON.stringify({ clientId: "client-read", clientSecret: rotated }) }));
    r.em.acceptSecret("client-read", rotated);
    clock.advanceMs(1_000_000); // past tokenMaxAgeSeconds (900 s), inside the secret cache TTL
    const second = await r.rt.execute("appointments.get", GET);
    expect([second.records.length, second.receipt.secretVersionId]).toEqual([1, put.VersionId]);
    expect(second.receipt.secretVersionId).not.toBe(first.receipt.secretVersionId);
    expect(r.em.tokenOutcomes).toEqual(["issued:client-read", "invalid_client:client-read", "issued:client-read"]);
    expect(r.em.requestsTo("GET", "/api/v1/appointments/")).toHaveLength(2);
    // An unchanged secret version is not retried: a vendor that refuses the current secret fails closed.
    r.em.acceptSecret("client-read", `rotated-elsewhere-${uniqueName("s")}`);
    clock.advanceMs(1_000_000);
    const e = (await failure(r.rt.execute("appointments.get", GET))) as ConnectorError;
    expect(e.reasonCode).toBe("CONNECTOR_TOKEN_CLIENT_REJECTED");
    expect(r.em.tokenOutcomes.slice(3)).toEqual(["invalid_client:client-read"]);
  });

  it("[FO-06-03][AUTH-04] exactly one token refresh on a 401; a second 401 fails closed (CONNECTOR_AUTH_FAILED) without a refresh loop", async ({ l2 }) => {
    const r = await rig(l2);
    await r.rt.execute("appointments.get", GET);
    r.em.revokeAllTokens();
    await r.rt.execute("appointments.get", GET);
    expect(r.em.tokenRequests).toBe(2);
    r.em.inject("GET /api/v1/appointments/", { kind: "status", status: 401, times: 2 });
    const e = (await failure(r.rt.execute("appointments.get", GET))) as ConnectorError;
    expect([e.reasonCode, e.outcome, r.em.tokenRequests]).toEqual(["CONNECTOR_AUTH_FAILED", "FAILED", 3]);
    expect(readiness(r)).toMatchObject({ status: "NOT_READY", reasonCode: "CONNECTOR_AUTH_FAILED" });
  });

  it("[FO-05-56][AUTH-02] a read-only credential cannot call a write endpoint: misconfigured in Secrets Manager the runtime refuses before I/O, and the vendor answers 403 to a read token on PUT", async ({ l2 }) => {
    const r = await rig(l2);
    const readMaterial = await r.sm.send(new GetSecretValueCommand({ SecretId: r.readRef }));
    await r.sm.send(new PutSecretValueCommand({ SecretId: r.writeRef, SecretString: readMaterial.SecretString }));
    const e = (await failure(r.rt.execute("appointments.upsert", { params: { appointmentId: "apt-00003" }, body: { status: "booked", startsAt: "2026-11-03T15:00:00Z" }, idempotencyKey: "act_synthL2Write0001" }))) as ConnectorRefusal;
    expect(e.reasonCode).toBe("CONNECTOR_SCOPE_NOT_GRANTED");
    expect(r.em.requestsTo("PUT", "/api/v1/appointments")).toHaveLength(0);
    const read = await r.rt.tokens.grant({ capability: READ_CAPABILITY, access: "READ", credentialRef: r.readRef, scopes: ["appointments:read"] }, "probe");
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpsRequest({ host: "127.0.0.1", port: r.em.port, servername: API_HOST, ca: [pki.caPem], method: "PUT", path: "/api/v1/appointments/apt-00003", headers: { authorization: read.header.value.reveal(), "idempotency-key": "idem-l2-0002", "content-type": "application/json" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end("{}");
    });
    expect([status, r.em.applied.size]).toEqual([403, 0]);
  });
});

describe("egress-classified transport over TLS [FO-06-13][FO-06-20][SAFE-05]", () => {
  it("[FO-06-13][FO-06-20] a host outside the profile is refused before I/O even when a route to a listening server exists; a redirect is refused and its target never contacted", async ({ l2 }) => {
    const r = await rig(l2);
    const attacker = await new VendorEmulator({ tls: { cert: pki.certPem, key: pki.keyPem } }).start();
    onTestFinished(() => attacker.stop());
    const policy = { allowedHosts: r.rt.profile.allowedHosts, addressClass: "PUBLIC_INTERNET" as const, dataClass: "INTERNAL" as const };
    const refused = (await failure(r.transport.send({ method: "GET", url: new URL("https://attacker.vendor.emulator.test/api/v1/appointments"), headers: {}, body: null, policy, sideEffect: false, timeoutMs: 2_000, dependency: "scheduling" }))) as TransportError;
    expect([refused.reasonCode, refused.phase, refused.requestSent]).toEqual(["CONNECTOR_HOST_NOT_ALLOWED", "PRE_IO", false]);
    r.em.inject("GET /api/v1/appointments/", { kind: "redirect", location: `https://127.0.0.1:${attacker.port}/api/v1/appointments/apt-00001`, times: 1 });
    const redirected = (await failure(r.rt.execute("appointments.get", GET))) as ConnectorError;
    expect(redirected.reasonCode).toBe("CONNECTOR_REDIRECT_REFUSED");
    expect([attacker.received.length, attacker.tokenRequests]).toEqual([0, 0]);
  });

  it("[FO-06-13] a token response naming another account is refused before any API request; a response from another region is refused", async ({ l2 }) => {
    const acct = await rig(l2);
    acct.em.reportAccountId = "acct-someone-else";
    expect(((await failure(acct.rt.execute("appointments.get", GET))) as ConnectorError).reasonCode).toBe("CONNECTOR_ACCOUNT_BINDING_MISMATCH");
    expect(acct.em.received.filter((x) => x.path.startsWith("/api/"))).toHaveLength(0);
    const region = await rig(l2);
    region.em.reportRegion = "eu-west-1";
    expect(((await failure(region.rt.execute("appointments.get", GET))) as ConnectorError).reasonCode).toBe("CONNECTOR_REGION_MISMATCH");
  });
});

describe("budgets and retry classification over TLS [FO-06-07][FO-06-08][ACT-03]", () => {
  it("[FO-06-07] a vendor 429 with Retry-After: 1 is honoured (the retry waits at least that long and succeeds); vendor usage is exported", async ({ l2 }) => {
    const r = await rig(l2);
    r.em.inject("GET /api/v1/appointments/", { kind: "status", status: 429, retryAfter: "1", times: 1 });
    const out = await r.rt.execute("appointments.get", GET);
    const calls = r.em.requestsTo("GET", "/api/v1/appointments/");
    expect([out.records.length, calls.length]).toEqual([1, 2]);
    expect((calls[1]?.at ?? 0) - (calls[0]?.at ?? 0)).toBeGreaterThanOrEqual(990);
    expect(r.metrics.gaugeValue("vsp_connector_vendor_quota_remaining_ratio", { dependency: "scheduling" })).toBeGreaterThan(0);
  });

  it("[FO-06-07] a Retry-After pauses the whole connector: a concurrent call to another operation is held until the pause ends, not sent into the vendor's limit", async ({ l2 }) => {
    const r = await rig(l2);
    r.em.inject("GET /api/v1/appointments/apt-00001", { kind: "status", status: 429, retryAfter: "2", times: 1 });
    const first = r.rt.execute("appointments.get", GET);
    while (r.em.requestsTo("GET", "/api/v1/appointments/apt-00001").length === 0) await new Promise((res) => setTimeout(res, 10));
    const limitedAt = r.em.requestsTo("GET", "/api/v1/appointments/apt-00001")[0]?.at ?? 0;
    await new Promise((res) => setTimeout(res, 100));
    const other = await r.rt.execute("appointments.get", { params: { appointmentId: "apt-00002" } });
    await first;
    const otherAt = r.em.requestsTo("GET", "/api/v1/appointments/apt-00002")[0]?.at ?? 0;
    expect(other.records).toHaveLength(1);
    expect(otherAt - limitedAt).toBeGreaterThanOrEqual(1_990);
  });

  it("[FO-06-07] a caller already queued for a token when a Retry-After arrives is held until the pause ends too, whether it queued on the connector budget or the operation budget", async ({ l2 }) => {
    const slow = { requestsPerSecond: 1, burst: 1, maxConcurrency: 4 };
    const cases = {
      // Connector budget 1 request/s: a call to ANOTHER operation passes its own budget and sleeps ~1 s in the
      // connector bucket; the pause lands while it sleeps and is re-checked when it wakes.
      connector: {
        profile: { limits: { requestsPerSecond: 1, timeoutMs: 5_000 }, mutate: (p: ProfileDraft) => ({ ...p, operations: p.operations.map((o) => (o.rateBudget ? { ...o, rateBudget: slow } : o)) }) },
        queued: (r: LiveRig) => r.rt.execute("appointments.list"),
        path: "/api/v1/appointments",
      },
      // Operation budget 1 request/s under a fast connector: the second call to the same operation sleeps ~1 s
      // in the operation bucket, then meets the pause in the connector bucket it passes last.
      operation: {
        profile: { limits: { timeoutMs: 5_000 }, mutate: (p: ProfileDraft) => ({ ...p, operations: p.operations.map((o) => (o.operationId === "appointments.get" ? { ...o, rateBudget: slow } : o)) }) },
        queued: (r: LiveRig) => r.rt.execute("appointments.get", { params: { appointmentId: "apt-00002" } }),
        path: "/api/v1/appointments/apt-00002",
      },
    };
    for (const [name, c] of Object.entries(cases)) {
      const r = await rig(l2, { profile: c.profile });
      r.em.inject("GET /api/v1/appointments/apt-00001", { kind: "status", status: 429, retryAfter: "3", times: 1 });
      const [a, b] = await Promise.all([r.rt.execute("appointments.get", GET), c.queued(r)]);
      expect([a.records.length > 0, b.records.length > 0], name).toEqual([true, true]);
      const limitedAt = r.em.requestsTo("GET", "/api/v1/appointments/apt-00001")[0]?.at ?? 0;
      const queuedAt = r.em.received.find((q) => q.method === "GET" && q.path === c.path)?.at ?? 0;
      // Its token was due after ~1 s, but nothing reached the vendor before the 3 s pause ended.
      expect(queuedAt - limitedAt, name).toBeGreaterThanOrEqual(2_950);
      expect(r.metrics.counterValue("vsp_rate_limit_waits_total", { reason: "vendor_pause" }), name).toBeGreaterThanOrEqual(1);
    }
  });

  it("[FO-06-07] after a Retry-After: 2 the callers queued on the operation budget restart spaced at that budget: the vendor's own limiter never answers 429 and sees at most its limit in any second after the pause", async ({ l2 }) => {
    // Vendor: 6 API requests/s (its limiter answers the 7th within a second 429). List budget 5/s, burst 1.
    const r = await rig(l2, {
      emulator: { vendorRateLimitPerSecond: 6 },
      profile: { limits: { timeoutMs: 10_000 }, listRateBudget: { requestsPerSecond: 5, burst: 1, maxConcurrency: 8 }, mutate: (p: ProfileDraft) => ({ ...p, operations: p.operations.map((o) => (o.operationId === "appointments.list" ? { ...o, timeoutMs: 10_000 } : o)) }) },
    });
    r.em.inject("GET /api/v1/appointments", { kind: "status", status: 429, retryAfter: "2", times: 1 });
    const results = await Promise.allSettled(Array.from({ length: 9 }, () => r.rt.execute("appointments.list")));
    expect(results.map((x) => x.status)).toEqual(Array.from({ length: 9 }, () => "fulfilled"));
    const lists = r.em.requestsTo("GET", "/api/v1/appointments");
    const limitedAt = lists[0]?.at ?? 0;
    const after = lists.slice(1).map((q) => q.at);
    expect(after).toHaveLength(9); // eight queued calls and the retry of the limited one
    expect(Math.min(...after) - limitedAt).toBeGreaterThanOrEqual(1_990);
    expect(r.em.rateLimitedResponses).toBe(0);
    expect(r.em.maxApiRequestsInWindow(1_000, "/api/", limitedAt + 1)).toBeLessThanOrEqual(6);
  });

  it("[FO-06-07] the per-operation token bucket throttles below the vendor's limit: a burst of eight never puts more than the vendor's six per second on the wire, so none is answered 429; the same burst with a budget above the limit is", async ({ l2 }) => {
    // Vendor: at most 6 API requests in any second (7th -> 429). Profile: 5/s with a burst of 1.
    const r = await rig(l2, { emulator: { vendorRateLimitPerSecond: 6 }, profile: { listRateBudget: { requestsPerSecond: 5, burst: 1, maxConcurrency: 4 } } });
    const started = Date.now();
    const results = await Promise.all(Array.from({ length: 8 }, () => r.rt.execute("appointments.list")));
    const calls = r.em.requestsTo("GET", "/api/v1/appointments");
    // Exactly eight requests (a 429 would have been retried) and the vendor never limited one.
    expect([results.every((x) => x.httpStatus === 200), calls.length, r.em.rateLimitedResponses]).toEqual([true, 8, 0]);
    expect(r.em.maxApiRequestsInWindow(1_000)).toBeLessThanOrEqual(6);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_300); // seven waits of 200 ms in the bucket
    expect(r.metrics.counterValue("vsp_rate_limit_waits_total")).toBeGreaterThanOrEqual(7);
    // Control: the same burst with a budget above the vendor's limit reaches the vendor's limiter.
    const loose = await rig(l2, { emulator: { vendorRateLimitPerSecond: 6 }, profile: { listRateBudget: { requestsPerSecond: 50, burst: 8, maxConcurrency: 8 } } });
    await Promise.allSettled(Array.from({ length: 8 }, () => loose.rt.execute("appointments.list")));
    expect(loose.em.rateLimitedResponses).toBeGreaterThan(0);
  });

  it("[FO-06-08][ACT-03] a write that times out after send is UNKNOWN and never retried; the reconcile lookup finds the applied effect; a dropped read is retried", async ({ l2 }) => {
    const r = await rig(l2);
    r.em.inject("PUT /api/v1/appointments/", { kind: "hang_after_apply", times: 1 });
    const e = (await failure(r.rt.execute("appointments.upsert", { params: { appointmentId: "apt-00004" }, body: { status: "cancelled", startsAt: "2026-11-04T15:00:00Z" }, idempotencyKey: "act_synthL2Idem00004" }))) as ConnectorError;
    expect([e.reasonCode, e.outcome, e.retryable]).toEqual(["TIMEOUT_AFTER_SEND", "UNKNOWN", false]);
    expect([r.em.requestsTo("PUT", "/api/v1/appointments/").length, r.em.applied.get("apt-00004")]).toEqual([1, 1]);
    const rec = await r.rt.reconcile("appointments.upsert", { params: { appointmentId: "apt-00004" } });
    expect([rec.found, rec.result?.records[0]?.values.status]).toEqual([true, "CANCELLED"]);
    r.em.inject("GET /api/v1/appointments/apt-00002", { kind: "drop", times: 1 });
    const read = await r.rt.execute("appointments.get", { params: { appointmentId: "apt-00002" } });
    expect([read.records.length, r.em.requestsTo("GET", "/api/v1/appointments/apt-00002").length]).toEqual([1, 2]);
  });
});

describe("pagination and reconcile over TLS [FO-06-06][ACT-02][ACT-03]", () => {
  it("[FO-06-06] an empty page carrying an advanced cursor is read past (COMPLETE with every later record), at the page bound it is TRUNCATED with that cursor; a non-empty page that does not advance the cursor is refused", async ({ l2 }) => {
    const r = await rig(l2);
    r.em.inject("GET /api/v1/appointments", { kind: "status", status: 200, times: 1, body: { items: [], nextCursor: "10" } });
    const all = await r.rt.readAll("appointments.list");
    expect([all.records.length, all.pages, all.completeness, all.records[0]?.values.sequence]).toEqual([13, 3, "COMPLETE", 11]);
    r.em.inject("GET /api/v1/appointments", { kind: "status", status: 200, times: 1, body: { items: [], nextCursor: "10" } });
    const bounded = await r.rt.readAll("appointments.list", {}, { maxPages: 1 });
    expect([bounded.completeness, bounded.truncatedReason, bounded.nextCursor]).toEqual(["TRUNCATED", "PAGE_LIMIT", "10"]);
    const item = { id: "apt-00001", status: "booked", startsAt: "2026-11-01T10:00:00Z", seq: 1 };
    r.em.inject("GET /api/v1/appointments", { kind: "status", status: 200, times: 1, body: { items: [item], nextCursor: "10" } });
    r.em.inject("GET /api/v1/appointments", { kind: "status", status: 200, times: 1, body: { items: [item], nextCursor: "10" } });
    expect(((await failure(r.rt.readAll("appointments.list"))) as ConnectorError).reasonCode).toBe("PAGINATION_CURSOR_NOT_ADVANCING");
  });

  it("[FO-06-06] OFFSET over TLS: the short last page ends the read COMPLETE; the page bound is TRUNCATED with the offset to resume from, and the resumed read returns the rest", async ({ l2 }) => {
    const r = await rig(l2, { profile: { listMaxPages: 2, mutate: (p: ProfileDraft) => ({ ...p, operations: p.operations.map((o) => (o.operationId === "appointments.list" && o.pagination ? { ...o, pagination: { ...o.pagination, strategy: "OFFSET" } } : o)) }) } });
    const bounded = await r.rt.readAll("appointments.list");
    expect([bounded.records.length, bounded.completeness, bounded.truncatedReason, bounded.nextCursor]).toEqual([20, "TRUNCATED", "PAGE_LIMIT", "20"]);
    const rest = await r.rt.readAll("appointments.list", {}, { startCursor: bounded.nextCursor });
    expect([rest.records.map((x) => x.values.sequence), rest.completeness]).toEqual([[21, 22, 23], "COMPLETE"]);
    expect(r.em.requestsTo("GET", "/api/v1/appointments").map((q) => q.query.cursor)).toEqual(["0", "10", "20"]);
  });

  it("[ACT-03] reconcile over TLS: a write the vendor never applied is found=false (404 lookup, and a list-style lookup answering 200 with no record), an applied one is found; a failing lookup throws", async ({ l2 }) => {
    const r = await rig(l2);
    expect(await r.rt.reconcile("appointments.upsert", { params: { appointmentId: "apt-never02" } })).toEqual({ found: false, result: null });
    expect((await r.rt.reconcile("appointments.upsert", { params: { appointmentId: "apt-00002" } })).found).toBe(true);
    r.em.inject("GET /api/v1/appointments/", { kind: "status", status: 500, times: 2 });
    expect(((await failure(r.rt.reconcile("appointments.upsert", { params: { appointmentId: "apt-00002" } }))) as ConnectorError).reasonCode).toBe("CONNECTOR_SERVER_ERROR");
    // The same write reconciled through a query by external id: 200 with an empty list is "not applied".
    const byQuery = { name: "appointmentId", in: "query" as const, wireName: "externalId", type: "opaque_id" as const, required: true, maxLength: 64, enumValues: null, integerRange: null };
    const q = await rig(l2, { profile: { mutate: (p: ProfileDraft) => ({ ...p, operations: p.operations.map((o) => (o.operationId === "appointments.lookup" ? { ...o, pathTemplate: "/appointments", params: [byQuery], recordsPointer: "/items" } : o)) }) } });
    const missing = await q.rt.reconcile("appointments.upsert", { params: { appointmentId: "apt-never03" } });
    expect([missing.found, missing.result?.httpStatus, missing.result?.records.length]).toEqual([false, 200, 0]);
    expect((await q.rt.reconcile("appointments.upsert", { params: { appointmentId: "apt-00002" } })).found).toBe(true);
  });
});

describe("active probes and KMS-signed capability evidence [FO-06-11][FO-06-18]", () => {
  it("[FO-06-11][FO-06-18] a probe over TLS makes reads READY (writes UNKNOWN without a sandbox write); its evidence is signed by a LocalStack KMS P-256 key and verifies; a changed result breaks the signature", async ({ l2 }) => {
    const r = await rig(l2);
    const report = await probeConnector(r.rt, { now: () => new Date() });
    expect(r.rt.readiness().map((x) => [x.capability, x.status])).toEqual([
      [READ_CAPABILITY, "READY"],
      [WRITE_CAPABILITY, "UNKNOWN"],
    ]);
    const kms = kmsClient(l2);
    const key = await kms.send(new CreateKeyCommand({ KeySpec: "ECC_NIST_P256", KeyUsage: "SIGN_VERIFY", Description: uniqueName("vsp-it-evidence") }));
    const keyArn = key.KeyMetadata?.Arn ?? "";
    onTestFinished(async () => {
      await kms.send(new ScheduleKeyDeletionCommand({ KeyId: keyArn, PendingWindowInDays: 7 })).catch(() => undefined);
    });
    const signer = new KmsEvidenceSigner(kms, keyArn, "integration_owner");
    const evidence = capabilityEvidenceFrom(report, { tenantId: TENANT_ID, capability: READ_CAPABILITY, level: "EMULATOR_PASS", evidenceRef: "evidence/connectors/l2-emulated-run", occurredAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000) });
    const signed = await signCapabilityEvidence(evidence, signer, systemClock);
    const publicKey = await signer.publicKeyDer();
    expect([signed.result, signed.signature?.keyRef, verifyEvidenceSignature(signed, publicKey)]).toEqual(["PASS", keyArn, true]);
    expect(verifyEvidenceSignature({ ...signed, result: "FAIL" }, publicKey)).toBe(false);
    const write = capabilityEvidenceFrom(report, { tenantId: TENANT_ID, capability: WRITE_CAPABILITY, level: "EMULATOR_PASS", evidenceRef: "evidence/connectors/l2-emulated-run", occurredAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000) });
    expect(write.result).toBe("INCONCLUSIVE");
  });

  it("[FO-06-11][OPS-04][ACT-03] a sandbox write runs only on a SANDBOX_WRITE profile: on a PRODUCTION_WRITE profile (admitted for staging, Secrets Manager references) the probe sends no write; on the sandbox profile the write is sent once and reconciled", async ({ l2 }) => {
    const sandboxWrite = { operationId: "appointments.upsert", input: { params: { appointmentId: "apt-sbxl2" }, body: { status: "booked", startsAt: "2026-11-09T15:00:00Z" }, idempotencyKey: "act_synthL2ProbeWrite" } };
    const prod = await rig(l2, { admitEnvironment: "staging", profile: { writeMode: "PRODUCTION_WRITE" } });
    const p = await probeConnector(prod.rt, { now: () => new Date(), sandboxWrite });
    expect(p.steps.find((x) => x.step === "WRITE_RECONCILE_TEST")).toEqual({ step: "WRITE_RECONCILE_TEST", result: "NOT_RUN", detailCode: "WRITE_TEST_REQUIRES_SANDBOX_PROFILE" });
    expect([prod.em.requestsTo("PUT", "/api/v1/appointments/").length, prod.em.applied.size]).toEqual([0, 0]);
    expect([readiness(prod)?.status, readiness(prod, WRITE_CAPABILITY)?.status]).toEqual(["READY", "UNKNOWN"]);
    const sbx = await rig(l2);
    const s = await probeConnector(sbx.rt, { now: () => new Date(), sandboxWrite });
    expect(s.steps.find((x) => x.step === "WRITE_RECONCILE_TEST")).toEqual({ step: "WRITE_RECONCILE_TEST", result: "PASS", detailCode: "WRITE_RECONCILED" });
    expect([sbx.em.requestsTo("PUT", "/api/v1/appointments/").length, sbx.em.applied.get("apt-sbxl2"), readiness(sbx, WRITE_CAPABILITY)?.status]).toEqual([1, 1, "READY"]);
  });

  it("[FO-06-11][OPS-03] failure injection: a vendor that no longer accepts the stored secret makes the probe NOT_READY (fail closed), not healthy", async ({ l2 }) => {
    const r = await rig(l2);
    r.em.acceptSecret("client-read", `rotated-elsewhere-${uniqueName("s")}`);
    await probeConnector(r.rt, { now: () => new Date() });
    expect(readiness(r)).toMatchObject({ status: "NOT_READY", reasonCode: "CONNECTOR_TOKEN_CLIENT_REJECTED" });
    expect((await r.rt.health()).healthy).toBe(false);
  });
});

describe("SCHEMA_DRIFT injection point [FO-06-05]", () => {
  it("[FAULT:SCHEMA_DRIFT seam][FO-06-05] each drift kind makes the mapping refuse the record whole with a typed drift error and turns the read capability UNKNOWN; metadata drift fails mapping validation", async ({ l2 }) => {
    const r = await rig(l2);
    await probeConnector(r.rt, { now: () => new Date() });
    expect(readiness(r)?.status).toBe("READY");
    const expected = { RENAMED_REQUIRED_FIELD: [{ kind: "MISSING_REQUIRED", targetField: "status" }], RETYPED_FIELD: [{ kind: "TYPE_MISMATCH", targetField: "startsAt" }], UNMAPPED_ENUM_VALUE: [{ kind: "UNKNOWN_ENUM_VALUE", targetField: "status" }] } as const;
    for (const kind of ["RENAMED_REQUIRED_FIELD", "RETYPED_FIELD", "UNMAPPED_ENUM_VALUE"] as const) {
      const seam = schemaDriftSeam(r.em, kind);
      const e = await failure(r.rt.readAll("appointments.list"));
      expect(e, kind).toBeInstanceOf(ConnectorSchemaDriftError);
      expect((e as ConnectorSchemaDriftError).issues, kind).toEqual(expected[kind]);
      expect(readiness(r), kind).toMatchObject({ status: "UNKNOWN", reasonCode: "CONNECTOR_SCHEMA_DRIFT" });
      seam.undo();
    }
    const meta = schemaDriftSeam(r.em, "RENAMED_REQUIRED_FIELD");
    expect((await r.rt.validateMappings()).Appointment).toEqual([{ kind: "MISSING_REQUIRED", targetField: "status" }]);
    meta.undo();
    expect((await r.rt.validateMappings()).Appointment).toEqual([]);
  });
});
