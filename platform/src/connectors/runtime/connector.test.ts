/**
 * Connector runtime against the EMULATED vendor (WP-06; FO-06-03, FO-06-06, FO-06-07, FO-06-08, FO-06-11,
 * FO-06-13, FO-06-14, FO-06-15, FO-05-56, FO-16-39; ACT-03, DATA-01, AUTH-02, AUTH-04).
 *
 * Layer 1 with real sockets: the production runtime, token manager, transport and mapping talk HTTP to
 * the protocol emulator (platform/test/integration/connectors/emulator.ts) on 127.0.0.1 through explicit
 * `ci` loopback routes; credentials come from the labelled LOCAL FIXTURE secret resolver. The same code
 * runs over TLS with LocalStack Secrets Manager in the Layer-2 suite. EMULATED, not vendor evidence.
 */
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { AdapterRegistry } from "../../adapters/registry.js";
import { createMemoryLogger } from "../../observability/logger.js";
import { DEFAULT_METRIC_CATALOGUE, InMemoryMetrics } from "../../observability/metrics.js";
import { withConnectorMetrics } from "../../observability/catalog/connectors.js";
import { EgressGuard } from "../../privacy/egress.js";
import { retry } from "../../resilience/retry.js";
import { FakeClock, systemClock } from "../../shared/clock.js";
import type { Clock } from "../../shared/clock.js";
import { VendorEmulator } from "../../../test/integration/connectors/emulator.js";
import type { EmulatorOptions } from "../../../test/integration/connectors/emulator.js";
import { API_HOST, AUTH_HOST, emulatorEgressPolicy, emulatorProfile } from "../../../test/integration/connectors/profiles.js";
import type { ProfileOptions } from "../../../test/integration/connectors/profiles.js";
import { ConnectorSchemaDriftError } from "../dsl/errors.js";
import { ConnectorHttpTransport } from "../http/transport.js";
import { admitConnectorProfile } from "../profile/validate.js";
import { LocalFixtureSecretResolver } from "../secrets/resolver.js";
import type { ResolvedSecret, SecretResolver, VersionStage } from "../secrets/resolver.js";
import { ConnectorRuntime } from "./connector.js";
import type { ConnectorRuntimeDeps } from "./connector.js";
import { ConnectorError, ConnectorRefusal } from "./errors.js";
import { probeConnector, verifyPendingCredentials } from "./health.js";

const READ_REF = "local-fixture:conn/read";
const WRITE_REF = "local-fixture:conn/write";
const emulators: VendorEmulator[] = [];

afterEach(async () => {
  await Promise.all(emulators.splice(0).map((e) => e.stop()));
});

interface Rig {
  em: VendorEmulator;
  rt: ConnectorRuntime;
  secrets: LocalFixtureSecretResolver;
  metrics: InMemoryMetrics;
  logs: ReturnType<typeof createMemoryLogger>;
  deps: ConnectorRuntimeDeps;
}

/**
 * UNIT FAKE (labelled, test-only): a cache in front of the fixture resolver that keeps serving the version
 * it first read until refresh(), the way the Secrets Manager resolver's TTL cache does between reads. It
 * lets a Layer-1 test reach the token endpoint with a stale secret; the real cache runs in Layer 2.
 */
class StaleUntilRefreshResolver implements SecretResolver {
  readonly kind = "local_fixture" as const;
  readonly label = "UNIT FAKE — stale-until-refresh cache over LOCAL FIXTURE secrets";
  private readonly cached = new Map<string, ResolvedSecret>();
  refreshes = 0;
  constructor(private readonly inner: LocalFixtureSecretResolver) {}
  async resolve(ref: string, stage: VersionStage = "AWSCURRENT"): Promise<ResolvedSecret> {
    const key = `${ref}|${stage}`;
    const hit = this.cached.get(key);
    if (hit) return hit;
    const v = await this.inner.resolve(ref, stage);
    this.cached.set(key, v);
    return v;
  }
  refresh(ref: string): void {
    this.refreshes += 1;
    for (const k of [...this.cached.keys()]) if (k.startsWith(`${ref}|`)) this.cached.delete(k);
    this.inner.refresh(ref);
  }
}

/**
 * UNIT FAKE (labelled, test-only): serves Secrets Manager ARN references from LOCAL FIXTURE values so a
 * Layer-1 test can run a profile admitted for staging (where fixture references are refused). The real
 * Secrets Manager resolver reads these references over LocalStack in the Layer-2 suite.
 */
class ArnAliasResolver implements SecretResolver {
  readonly kind = "local_fixture" as const;
  readonly label = "UNIT FAKE — Secrets Manager ARNs aliased onto LOCAL FIXTURE secrets";
  constructor(private readonly inner: LocalFixtureSecretResolver, private readonly aliases: Readonly<Record<string, string>>) {}
  async resolve(ref: string, stage: VersionStage = "AWSCURRENT"): Promise<ResolvedSecret> {
    const target = this.aliases[ref];
    if (!target) throw new Error("UNIT_FAKE_ALIAS_MISSING");
    return { ...(await this.inner.resolve(target, stage)), ref };
  }
  refresh(ref: string): void {
    const target = this.aliases[ref];
    if (target) this.inner.refresh(target);
  }
}

const ARN_READ = "arn:aws:secretsmanager:us-east-1:000000000000:secret:vsp/staging/conn-read-AbCdEf";
const ARN_WRITE = "arn:aws:secretsmanager:us-east-1:000000000000:secret:vsp/staging/conn-write-AbCdEf";

async function rig(o: { profile?: Partial<ProfileOptions>; emulator?: EmulatorOptions; clock?: Clock; secretsOverride?: (s: LocalFixtureSecretResolver) => void; wrapSecrets?: (s: LocalFixtureSecretResolver) => SecretResolver; egressPolicy?: ConstructorParameters<typeof EgressGuard>[0]; admitEnvironment?: "ci" | "staging" } = {}): Promise<Rig> {
  const em = await new VendorEmulator({ clientScopes: { "client-read": ["appointments:read"], "client-write": ["appointments:write"] }, ...o.emulator }).start();
  emulators.push(em);
  const clock = o.clock ?? systemClock;
  const secrets = new LocalFixtureSecretResolver(clock)
    .set(READ_REF, { clientId: "client-read", clientSecret: "secret-read-v1" }, "v1")
    .set(WRITE_REF, { clientId: "client-write", clientSecret: "secret-write-v1" }, "v1");
  o.secretsOverride?.(secrets);
  const metrics = new InMemoryMetrics({ catalogue: withConnectorMetrics(DEFAULT_METRIC_CATALOGUE) });
  const logs = createMemoryLogger();
  const routes = new Map([
    [API_HOST, { port: em.port, tls: false }],
    [AUTH_HOST, { port: em.port, tls: false }],
  ]);
  const transport = new ConnectorHttpTransport({ environment: "ci", egress: new EgressGuard(o.egressPolicy ?? emulatorEgressPolicy(), { environment: "ci" }), loopbackRoutes: routes, metrics, logger: logs.logger });
  const admitted = admitConnectorProfile(emulatorProfile({ readRef: READ_REF, writeRef: WRITE_REF, ...o.profile }), o.admitEnvironment ?? "ci");
  const deps: ConnectorRuntimeDeps = { admitted, transport, secrets: o.wrapSecrets?.(secrets) ?? secrets, clock, metrics, logger: logs.logger };
  const rt = new ConnectorRuntime(deps);
  return { em, rt, secrets, metrics, logs, deps };
}

async function err(p: Promise<unknown>): Promise<ConnectorError | ConnectorRefusal | Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a failure");
}

const api = (em: VendorEmulator) => em.received.filter((r) => r.path.startsWith("/api/"));

describe("operations are reviewed and enabled [FO-06-15][OPS-04]", () => {
  it("[FO-06-15] calling a disabled operation throws OPERATION_NOT_ENABLED before I/O; an undeclared one OPERATION_NOT_DECLARED", async () => {
    const { em, rt } = await rig();
    const disabled = await err(rt.execute("appointments.cancel", { params: { appointmentId: "apt-00001" } }));
    expect([disabled.constructor.name, (disabled as ConnectorRefusal).reasonCode]).toEqual(["ConnectorRefusal", "OPERATION_NOT_ENABLED"]);
    expect((await err(rt.execute("appointments.delete_everything"))).message).toBe("OPERATION_NOT_DECLARED");
    expect(em.received).toHaveLength(0);
    expect(em.tokenRequests).toBe(0);
  });

  it("[FO-06-15] authoritative fields and the pinned event schema come from the profile", async () => {
    const { rt } = await rig();
    const r = await rt.execute("appointments.get", { params: { appointmentId: "apt-00002" } });
    expect(Object.entries(r.records[0]?.provenance ?? {}).filter(([, p]) => p.authoritative).map(([k]) => k)).toEqual(["appointmentId", "status", "startsAt"]);
    rt.assertEventSchema("appointments", "reference.appointment.changed", "1");
    expect(() => rt.assertEventSchema("appointments", "reference.appointment.changed", "2")).toThrow("CONNECTOR_EVENT_SCHEMA_NOT_PINNED");
  });

  it("[FO-05-56][AUTH-02] a read-only credential cannot call a write endpoint: the runtime refuses before I/O, and the vendor refuses a read token on the write route", async () => {
    // Profile whose write capability is (mis)served by the read client: the vendor grants it no write scope.
    const { em, rt, secrets } = await rig();
    secrets.set(WRITE_REF, { clientId: "client-read", clientSecret: "secret-read-v1" }, "v2");
    const e = await err(rt.execute("appointments.upsert", { params: { appointmentId: "apt-00003" }, body: { status: "booked", startsAt: "2026-11-03T15:00:00Z" }, idempotencyKey: "idem-key-0001" }));
    expect((e as ConnectorRefusal).reasonCode).toBe("CONNECTOR_SCOPE_NOT_GRANTED");
    expect(em.requestsTo("PUT", "/api/v1/appointments")).toHaveLength(0);
    // The emulated vendor itself enforces the scope on the wire: a read token on PUT is 403.
    const read = await rt.tokens.grant({ capability: "scheduling.appointments_read", access: "READ", credentialRef: READ_REF, scopes: ["appointments:read"] }, "probe");
    const res = await fetch(`http://127.0.0.1:${em.port}/api/v1/appointments/apt-00003`, { method: "PUT", headers: { authorization: read.header.value.reveal(), "idempotency-key": "idem-key-0002", "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(403);
    expect(em.applied.size).toBe(0);
  });

  it("[OPS-04] a READ_ONLY profile never sends a write", async () => {
    const { em, rt } = await rig({ profile: { writeMode: "READ_ONLY", mutate: (p) => ({ ...p, capabilityCredentials: p.capabilityCredentials?.filter((c) => c.access === "READ"), operations: p.operations.map((o) => (o.kind === "WRITE" ? { ...o, enabled: false } : o)), bindingVerification: { account: { source: "TOKEN_RESPONSE", locator: "/instance_id" }, region: null } }) } });
    expect((await err(rt.execute("appointments.upsert", { params: { appointmentId: "apt-1" } }))).message).toBe("OPERATION_NOT_ENABLED");
    expect(em.received).toHaveLength(0);
  });

  it("[OPS-04][ACT-03] defence in depth: a runtime handed a READ_ONLY profile with an enabled write (built without admission) refuses the write before I/O", async () => {
    const { em, deps } = await rig();
    // Admission refuses this combination (WRITE_ENABLED_ON_READ_ONLY_PROFILE); the runtime does not rely on it.
    const tampered = new ConnectorRuntime({ ...deps, admitted: { ...deps.admitted, profile: { ...deps.admitted.profile, writeMode: "READ_ONLY" } } });
    const e = (await err(tampered.execute("appointments.upsert", { params: { appointmentId: "apt-00009" }, body: { status: "booked", startsAt: "2026-11-09T15:00:00Z" }, idempotencyKey: "act_synthIdem0000009" }))) as ConnectorRefusal;
    expect([e.constructor.name, e.reasonCode]).toEqual(["ConnectorRefusal", "CONNECTOR_WRITE_MODE_READ_ONLY"]);
    expect([em.received.length, em.tokenRequests, em.applied.size]).toEqual([0, 0, 0]);
  });
});

describe("token manager [FO-06-03][FO-06-14][AUTH-04]", () => {
  it("[FO-06-03] tokens are cached per credential and the expiry bound is honoured (a new token after tokenMaxAgeSeconds)", async () => {
    const clock = new FakeClock(new Date());
    const { em, rt } = await rig({ clock, emulator: { tokenExpiresIn: 36_000 } });
    await rt.execute("appointments.get", { params: { appointmentId: "apt-00001" } });
    await rt.execute("appointments.get", { params: { appointmentId: "apt-00002" } });
    expect(em.tokenRequests).toBe(1);
    clock.advanceMs(900_000 - 31_000); // inside min(expires_in, tokenMaxAgeSeconds = 900 s) minus the 30 s margin
    await rt.execute("appointments.get", { params: { appointmentId: "apt-00001" } });
    expect(em.tokenRequests).toBe(1);
    clock.advanceMs(2_000);
    await rt.execute("appointments.get", { params: { appointmentId: "apt-00001" } });
    expect(em.tokenRequests).toBe(2);
    expect(rt.tokens.tokenRequests).toBe(2);
  });

  it("[FO-06-03][AUTH-04] a 401 on an API call triggers exactly one refresh; a second 401 fails closed without a refresh loop", async () => {
    const { em, rt } = await rig();
    await rt.execute("appointments.get", { params: { appointmentId: "apt-00001" } });
    em.revokeAllTokens();
    await rt.execute("appointments.get", { params: { appointmentId: "apt-00001" } });
    expect(em.tokenRequests).toBe(2);
    em.inject("GET /api/v1/appointments/", { kind: "status", status: 401, times: 2 });
    const e = await err(rt.execute("appointments.get", { params: { appointmentId: "apt-00001" } }));
    expect([(e as ConnectorError).reasonCode, (e as ConnectorError).outcome]).toEqual(["CONNECTOR_AUTH_FAILED", "FAILED"]);
    expect(em.tokenRequests).toBe(3);
    expect(rt.readiness().find((r) => r.capability === "scheduling.appointments_read")).toMatchObject({ status: "NOT_READY", reasonCode: "CONNECTOR_AUTH_FAILED" });
  });

  it("[FO-06-03][FO-15-26] a token request in flight when the credential is invalidated answers the caller waiting for it but is never cached: the next grant requests a fresh token", async () => {
    const { em, rt } = await rig();
    const cred = rt.profile.capabilityCredentials?.find((c) => c.access === "READ");
    if (!cred) throw new Error("profile");
    em.inject("POST /oauth/token", { kind: "delay", ms: 200, times: 1 });
    const first = rt.tokens.grant(cred, "probe");
    while (em.tokenRequests === 0) await new Promise((r) => setTimeout(r, 5));
    rt.tokens.invalidate(cred); // a 401 or a rotation lands while the token request is at the vendor
    const a = await first;
    const b = await rt.tokens.grant(cred, "probe");
    expect([em.tokenRequests, b.header.value.reveal() === a.header.value.reveal()]).toEqual([2, false]);
    // Without an invalidate in between, the token is cached as usual.
    const c = await rt.tokens.grant(cred, "probe");
    expect([em.tokenRequests, c.header.value.reveal() === b.header.value.reveal()]).toEqual([2, true]);
  });

  it("[FO-06-03][FO-15-26] rotation without restart: after the vendor rotates the client secret, the next token request uses the rotated value", async () => {
    const { em, rt, secrets } = await rig();
    await rt.execute("appointments.get", { params: { appointmentId: "apt-00001" } });
    em.acceptSecret("client-read", "secret-read-v2");
    secrets.set(READ_REF, { clientId: "client-read", clientSecret: "secret-read-v2" }, "v2");
    em.revokeAllTokens();
    const r = await rt.execute("appointments.get", { params: { appointmentId: "apt-00001" } });
    expect(r.receipt.secretVersionId).toBe("v2");
    expect(secrets.refreshCount).toBeGreaterThanOrEqual(1);
  });

  it("[FO-06-03][FO-15-26] invalid_client at the token endpoint: the secret is re-read once and the token request is retried only when the version changed, never with the same secret", async () => {
    // The vendor rotated, the store still holds v1: one token request, a typed refusal, one re-read, no retry.
    const stale = await rig();
    stale.em.acceptSecret("client-read", "secret-read-v2");
    const e = (await err(stale.rt.execute("appointments.get", { params: { appointmentId: "apt-00001" } }))) as ConnectorError;
    expect([e.reasonCode, e.outcome, e.retryable]).toEqual(["CONNECTOR_TOKEN_CLIENT_REJECTED", "NOT_STARTED", false]);
    expect([stale.em.tokenRequests, stale.rt.tokens.tokenRequests, stale.secrets.refreshCount]).toEqual([1, 1, 1]);
    expect(api(stale.em)).toHaveLength(0);

    // The store has v2 but the resolver still serves its cached v1 when the token expires: the renewal is
    // refused invalid_client once, the re-read returns v2, and exactly one retry with v2 succeeds.
    const clock = new FakeClock(new Date());
    const held: { cache?: StaleUntilRefreshResolver } = {};
    const rotated = await rig({ clock, wrapSecrets: (s) => (held.cache = new StaleUntilRefreshResolver(s)) });
    await rotated.rt.execute("appointments.get", { params: { appointmentId: "apt-00001" } });
    rotated.em.acceptSecret("client-read", "secret-read-v2");
    rotated.secrets.set(READ_REF, { clientId: "client-read", clientSecret: "secret-read-v2" }, "v2");
    clock.advanceMs(900_000);
    const r = await rotated.rt.execute("appointments.get", { params: { appointmentId: "apt-00001" } });
    expect(r.receipt.secretVersionId).toBe("v2");
    expect([rotated.em.tokenRequests, rotated.rt.tokens.tokenRequests, held.cache?.refreshes]).toEqual([3, 3, 1]);
  });

  it("[FO-06-04][FO-15-26] rotation test: each AWSPENDING version authenticates (token request, and the synthetic read for the read credential) before promotion; traffic keeps AWSCURRENT; a pending value the vendor refuses fails without touching readiness", async () => {
    const { em, rt, secrets } = await rig();
    await probeConnector(rt, { now: () => new Date() });
    secrets.setPending(READ_REF, { clientId: "client-read", clientSecret: "secret-read-v2" }, "v2").setPending(WRITE_REF, { clientId: "client-write", clientSecret: "secret-write-v2" }, "w2");
    em.addSecret("client-read", "secret-read-v2");
    em.addSecret("client-write", "secret-write-v2");
    const checks = await verifyPendingCredentials(rt);
    expect(checks).toEqual([
      { capability: "scheduling.appointments_read", access: "READ", result: "PASS", detailCode: "PENDING_CREDENTIAL_READ_SYNTHETIC", secretVersionId: "v2" },
      { capability: "scheduling.appointments_write", access: "WRITE", result: "PASS", detailCode: "PENDING_TOKEN_ISSUED", secretVersionId: "w2" },
    ]);
    expect(em.requestsTo("PUT", "/api/v1/appointments/")).toHaveLength(0); // a write is never sent to test a credential
    // Traffic is on the current version, not on the pending token now cached apart.
    expect((await rt.execute("appointments.get", { params: { appointmentId: "apt-00001" } })).receipt.secretVersionId).toBe("v1");
    // A pending value the vendor does not accept: FAIL, and the read capability stays READY on its current credential.
    secrets.setPending(READ_REF, { clientId: "client-read", clientSecret: "secret-read-v3" }, "v3");
    const refused = await verifyPendingCredentials(rt);
    expect(refused[0]).toEqual({ capability: "scheduling.appointments_read", access: "READ", result: "FAIL", detailCode: "CONNECTOR_TOKEN_CLIENT_REJECTED", secretVersionId: null });
    expect(rt.readiness().find((r) => r.capability === "scheduling.appointments_read")?.status).toBe("READY");
    // The pending token is issued but the API refuses it twice (one refresh): FAIL, readiness still unchanged.
    secrets.setPending(READ_REF, { clientId: "client-read", clientSecret: "secret-read-v2" }, "v2b");
    em.inject("GET /api/v1/appointments/", { kind: "status", status: 401, times: 2 });
    expect((await verifyPendingCredentials(rt))[0]).toMatchObject({ result: "FAIL", detailCode: "CONNECTOR_AUTH_FAILED" });
    expect(rt.readiness().find((r) => r.capability === "scheduling.appointments_read")).toMatchObject({ status: "READY", reasonCode: "PROBES_PASSED" });
    // No pending version staged: FAIL with a typed reason, nothing sent.
    const none = await rig();
    const before = none.em.tokenRequests;
    expect((await verifyPendingCredentials(none.rt)).map((c) => [c.result, c.detailCode])).toEqual([
      ["FAIL", "CONNECTOR_CREDENTIAL_INVALID"],
      ["FAIL", "CONNECTOR_CREDENTIAL_INVALID"],
    ]);
    expect(none.em.tokenRequests).toBe(before);
    // A write never runs on a pending credential.
    const w = (await err(rt.execute("appointments.upsert", { params: { appointmentId: "apt-00010" }, body: { status: "booked", startsAt: "2026-11-10T15:00:00Z" }, idempotencyKey: "act_synthIdem0000010", credentialStage: "AWSPENDING" }))) as ConnectorRefusal;
    expect([w.constructor.name, w.reasonCode]).toEqual(["ConnectorRefusal", "PENDING_CREDENTIAL_WRITE_REFUSED"]);
  });

  it("[FO-06-14] granted scopes are checked: broader than declared is refused; narrower refuses only the operations needing the missing scope; omitted means as requested", async () => {
    const broad = await rig();
    broad.em.scopeMode = "broader";
    expect(((await err(broad.rt.execute("appointments.get", { params: { appointmentId: "apt-00001" } }))) as ConnectorError).reasonCode).toBe("CONNECTOR_TOKEN_SCOPE_BROADER");
    expect(api(broad.em)).toHaveLength(0);
    const narrow = await rig();
    narrow.em.scopeMode = "narrower";
    expect(((await err(narrow.rt.execute("appointments.get", { params: { appointmentId: "apt-00001" } }))) as ConnectorRefusal).reasonCode).toBe("CONNECTOR_SCOPE_NOT_GRANTED");
    expect(api(narrow.em)).toHaveLength(0);
    expect(narrow.metrics.counterValue("vsp_connector_token_requests_total", { result: "scope_narrower" })).toBe(1);
    const omit = await rig();
    omit.em.scopeMode = "omit";
    expect((await omit.rt.execute("appointments.get", { params: { appointmentId: "apt-00001" } })).records).toHaveLength(1);
  });

  it("[FO-06-03] client_secret_basic, private_key_jwt, self-signed bearer JWT and API key schemes all authenticate against the emulator", async () => {
    const basic = await rig({ profile: { auth: { clientAuth: "CLIENT_SECRET_BASIC" } } });
    expect((await basic.rt.execute("appointments.get", { params: { appointmentId: "apt-00001" } })).records).toHaveLength(1);
    expect(basic.em.received.find((r) => r.path === "/oauth/token")?.authorization).toBe("basic");

    const kp = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const pem = kp.publicKey.export({ type: "spki", format: "pem" }).toString();
    const priv = kp.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const jwt = await rig({
      emulator: { jwtClients: { "client-read": { pem, alg: "ES256" }, "client-write": { pem, alg: "ES256" } } },
      profile: { auth: { scheme: "OAUTH2_JWT_BEARER", clientAuth: "PRIVATE_KEY_JWT", audience: `https://${AUTH_HOST}/oauth/token` } },
      secretsOverride: (s) => {
        s.set(READ_REF, { clientId: "client-read", privateKeyPem: priv, keyId: "k1", alg: "ES256" }, "v1");
        s.set(WRITE_REF, { clientId: "client-write", privateKeyPem: priv, keyId: "k1", alg: "ES256" }, "v1");
      },
    });
    expect((await jwt.rt.execute("appointments.get", { params: { appointmentId: "apt-00001" } })).records).toHaveLength(1);

    const signed = await rig({
      emulator: { bearerJwtIssuers: { "client-read": { pem, alg: "ES256", audience: "reference-scheduling-api" } } },
      profile: { auth: { scheme: "SIGNED_JWT_BEARER", tokenUrl: null, clientAuth: null, audience: "reference-scheduling-api" }, binding: { account: { source: "RESPONSE_HEADER", locator: "x-account-id" }, region: null } },
      secretsOverride: (s) => {
        s.set(READ_REF, { clientId: "client-read", privateKeyPem: priv, alg: "ES256" }, "v1");
        s.set(WRITE_REF, { clientId: "client-write", privateKeyPem: priv, alg: "ES256" }, "v1");
      },
    });
    expect((await signed.rt.execute("appointments.get", { params: { appointmentId: "apt-00001" } })).records).toHaveLength(1);
    expect(signed.em.tokenRequests).toBe(0);

    const key = await rig({
      emulator: { apiKeys: ["key_synthReadApiKey01"] },
      profile: { auth: { scheme: "API_KEY_HEADER", tokenUrl: null, clientAuth: null, apiKeyHeader: "x-api-key" }, binding: { account: { source: "RESPONSE_HEADER", locator: "x-account-id" }, region: null } },
      secretsOverride: (s) => {
        s.set(READ_REF, { apiKey: "key_synthReadApiKey01" }, "v1");
        s.set(WRITE_REF, { apiKey: "key_synthWriteApiKey02" }, "v1");
      },
    });
    expect((await key.rt.execute("appointments.get", { params: { appointmentId: "apt-00001" } })).records).toHaveLength(1);
  });
});

describe("account, region and host binding [FO-06-13][FO-06-20]", () => {
  it("[FO-06-13] a token for another account is refused before any API request; a response from another region is refused", async () => {
    const acct = await rig();
    acct.em.reportAccountId = "acct-someone-else";
    expect(((await err(acct.rt.execute("appointments.get", { params: { appointmentId: "apt-00001" } }))) as ConnectorError).reasonCode).toBe("CONNECTOR_ACCOUNT_BINDING_MISMATCH");
    expect(api(acct.em)).toHaveLength(0);
    const region = await rig();
    region.em.reportRegion = "eu-west-1";
    const e = (await err(region.rt.execute("appointments.get", { params: { appointmentId: "apt-00001" } }))) as ConnectorError;
    expect([e.reasonCode, e.outcome]).toEqual(["CONNECTOR_REGION_MISMATCH", "FAILED"]);
    expect(region.rt.readiness().find((r) => r.capability === "scheduling.appointments_read")?.status).toBe("NOT_READY");
  });

  it("[FO-06-20] a next link pointing at another host is refused before I/O", async () => {
    const { em, rt } = await rig({
      profile: {
        mutate: (p) => ({
          ...p,
          operations: p.operations.map((o) => (o.operationId === "appointments.list" && o.pagination ? { ...o, pagination: { ...o.pagination, strategy: "NEXT_LINK", cursorParam: null, nextPointer: "/next" } } : o)),
        }),
      },
    });
    em.inject("GET /api/v1/appointments", { kind: "status", status: 200, times: 1, body: { items: [{ id: "apt-1", status: "booked", startsAt: "2026-11-01T10:00:00Z" }], next: "https://attacker.example.com/api/v1/appointments?cursor=10" } });
    expect(((await err(rt.readAll("appointments.list"))) as ConnectorRefusal).reasonCode).toBe("CONNECTOR_NEXT_LINK_OFF_ORIGIN");
    expect(api(em)).toHaveLength(1);
  });
});

describe("pagination [FO-06-06]", () => {
  it("[FO-06-06] reads to the last page; an empty source is one empty page", async () => {
    const full = await rig();
    const r = await full.rt.readAll("appointments.list");
    expect([r.records.length, r.pages, r.completeness]).toEqual([23, 3, "COMPLETE"]);
    expect(new Set(r.records.map((x) => x.values.appointmentId)).size).toBe(23);
    const empty = await rig({ emulator: { records: 0 } });
    const e = await empty.rt.readAll("appointments.list");
    expect([e.records.length, e.pages, e.completeness]).toEqual([0, 1, "COMPLETE"]);
  });

  it("[FO-06-06] the page-count bound returns a partial result labelled TRUNCATED with the resume cursor", async () => {
    const { rt } = await rig({ profile: { listMaxPages: 2 } });
    const r = await rt.readAll("appointments.list");
    expect([r.records.length, r.pages, r.completeness, r.truncatedReason, r.nextCursor]).toEqual([20, 2, "TRUNCATED", "PAGE_LIMIT", "20"]);
    const rest = await rt.readAll("appointments.list", {}, { startCursor: r.nextCursor });
    expect([rest.records.length, rest.completeness]).toEqual([3, "COMPLETE"]);
  });

  it("[FO-06-06] an empty page that carries an advanced cursor is not the end: the read continues from it; at the page bound it is TRUNCATED with that cursor", async () => {
    const empty = { kind: "status" as const, status: 200, times: 1, body: { items: [], nextCursor: "10" } };
    const on = await rig();
    on.em.inject("GET /api/v1/appointments", { ...empty });
    const r = await on.rt.readAll("appointments.list");
    expect([r.records.length, r.pages, r.completeness, r.nextCursor]).toEqual([13, 3, "COMPLETE", null]);
    expect(r.records.map((x) => x.values.sequence)).toEqual(Array.from({ length: 13 }, (_, i) => i + 11));
    expect(on.em.requestsTo("GET", "/api/v1/appointments").map((q) => q.query.cursor ?? null)).toEqual([null, "10", "20"]);

    const bounded = await rig();
    bounded.em.inject("GET /api/v1/appointments", { ...empty });
    const t = await bounded.rt.readAll("appointments.list", {}, { maxPages: 1 });
    expect([t.records.length, t.pages, t.completeness, t.truncatedReason, t.nextCursor]).toEqual([0, 1, "TRUNCATED", "PAGE_LIMIT", "10"]);
    const resumed = await bounded.rt.readAll("appointments.list", {}, { startCursor: t.nextCursor });
    expect([resumed.records.length, resumed.completeness]).toEqual([13, "COMPLETE"]);

    // An empty page at the position it was asked for is the vendor's "nothing further": COMPLETE.
    const caughtUp = await rig();
    caughtUp.em.inject("GET /api/v1/appointments", { kind: "status", status: 200, times: 1, body: { items: [], nextCursor: "10" } });
    const c = await caughtUp.rt.readAll("appointments.list", {}, { startCursor: "10" });
    expect([c.records.length, c.pages, c.completeness]).toEqual([0, 1, "COMPLETE"]);
  });

  it("[FO-06-06][ACT-02] a non-empty page whose next cursor is the one requested is refused (PAGINATION_CURSOR_NOT_ADVANCING) instead of re-serving its records", async () => {
    const { em, rt } = await rig();
    const stuck = { kind: "status" as const, status: 200, times: 1, body: { items: [{ id: "apt-00001", status: "booked", startsAt: "2026-11-01T10:00:00Z", seq: 1 }], nextCursor: "10" } };
    em.inject("GET /api/v1/appointments", { ...stuck });
    em.inject("GET /api/v1/appointments", { ...stuck });
    const e = (await err(rt.readAll("appointments.list"))) as ConnectorError;
    expect([e.constructor.name, e.reasonCode, e.outcome, e.retryable]).toEqual(["ConnectorError", "PAGINATION_CURSOR_NOT_ADVANCING", "FAILED", false]);
    expect(em.requestsTo("GET", "/api/v1/appointments").map((q) => q.query.cursor ?? null)).toEqual([null, "10"]);
  });

  it("[FO-06-06] cursor expiry: after the first page the result is TRUNCATED (CURSOR_EXPIRED); on the first page it is a typed error", async () => {
    const later = await rig();
    later.em.inject("GET /api/v1/appointments", { kind: "delay", ms: 0, times: 1 });
    later.em.inject("GET /api/v1/appointments", { kind: "cursor_expired", times: 1 });
    const r = await later.rt.readAll("appointments.list");
    expect([r.records.length, r.completeness, r.truncatedReason]).toEqual([10, "TRUNCATED", "CURSOR_EXPIRED"]);
    const first = await rig();
    first.em.inject("GET /api/v1/appointments", { kind: "cursor_expired", times: 1 });
    expect(((await err(first.rt.readAll("appointments.list"))) as ConnectorError).reasonCode).toBe("CURSOR_EXPIRED");
    // An expired cursor cannot be resumed: the TRUNCATED result carries no resume cursor.
    expect(r.nextCursor).toBeNull();
  });

  // The list operation paged by OFFSET: the runtime sends the offset of the next record in the cursor param.
  const offsetPaged = (maxPages = 5): Partial<ProfileOptions> => ({
    listMaxPages: maxPages,
    mutate: (p) => ({ ...p, operations: p.operations.map((o) => (o.operationId === "appointments.list" && o.pagination ? { ...o, pagination: { ...o.pagination, strategy: "OFFSET" } } : o)) }),
  });
  const offsets = (em: VendorEmulator) => em.requestsTo("GET", "/api/v1/appointments").map((q) => q.query.cursor ?? null);

  it("[FO-06-06] OFFSET: the last (short) page ends the read COMPLETE; an empty page at the end does too", async () => {
    const full = await rig({ profile: offsetPaged() });
    const r = await full.rt.readAll("appointments.list");
    expect([r.records.length, r.pages, r.completeness, r.truncatedReason, r.nextCursor]).toEqual([23, 3, "COMPLETE", null, null]);
    expect(r.records.map((x) => x.values.sequence)).toEqual(Array.from({ length: 23 }, (_, i) => i + 1));
    expect(offsets(full.em)).toEqual(["0", "10", "20"]); // the short third page is not followed by a fourth request
    const exact = await rig({ profile: offsetPaged(), emulator: { records: 20 } });
    const e = await exact.rt.readAll("appointments.list");
    expect([e.records.length, e.pages, e.completeness]).toEqual([20, 3, "COMPLETE"]);
    expect(offsets(exact.em)).toEqual(["0", "10", "20"]);
    const none = await rig({ profile: offsetPaged(), emulator: { records: 0 } });
    const n = await none.rt.readAll("appointments.list");
    expect([n.records.length, n.pages, n.completeness]).toEqual([0, 1, "COMPLETE"]);
  });

  it("[FO-06-06] OFFSET: the page bound returns TRUNCATED with the offset to resume from, and startCursor resumes there", async () => {
    const { em, rt } = await rig({ profile: offsetPaged(2) });
    const r = await rt.readAll("appointments.list");
    expect([r.records.length, r.pages, r.completeness, r.truncatedReason, r.nextCursor]).toEqual([20, 2, "TRUNCATED", "PAGE_LIMIT", "20"]);
    const rest = await rt.readAll("appointments.list", {}, { startCursor: r.nextCursor });
    expect([rest.records.map((x) => x.values.sequence), rest.pages, rest.completeness, rest.nextCursor]).toEqual([[21, 22, 23], 1, "COMPLETE", null]);
    expect(offsets(em)).toEqual(["0", "10", "20"]);
    // A resume position that is not a decimal offset is refused before any request.
    const before = em.received.length;
    for (const bad of ["abc", "-1", "01", "1e3", "10000000000"]) {
      const x = (await err(rt.readAll("appointments.list", {}, { startCursor: bad }))) as ConnectorRefusal;
      expect([x.constructor.name, x.reasonCode]).toEqual(["ConnectorRefusal", "PAGINATION_START_OFFSET_INVALID"]);
    }
    expect(em.received.length).toBe(before);
  });
});

describe("budgets, Retry-After and bulkheads [FO-06-07][FO-16-39]", () => {
  it("[FO-06-07] the per-operation token bucket throttles below the vendor's limit: no 429 although the caller bursts past it", async () => {
    const { em, rt } = await rig({ emulator: { vendorRateLimitPerSecond: 6 }, profile: { listRateBudget: { requestsPerSecond: 5, burst: 1, maxConcurrency: 4 } } });
    const started = Date.now();
    await Promise.all(Array.from({ length: 8 }, () => rt.execute("appointments.list")));
    const calls = em.requestsTo("GET", "/api/v1/appointments");
    // Eight requests, none limited by the vendor (6 per second): the bucket kept the wire under its limit.
    expect([calls.length, em.rateLimitedResponses]).toEqual([8, 0]);
    expect(em.maxApiRequestsInWindow(1_000)).toBeLessThanOrEqual(6);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_300); // 8 requests at 5/s with a burst of 1
  });

  it("[FO-06-07] after the vendor's 429 the queued callers restart spaced at their budget: the vendor answers 429 once, and after the pause never sees more than its limit in a second", async () => {
    // Vendor limit 6 requests/s (the 7th within a second is answered 429 with Retry-After: 1); list budget 5/s, burst 1.
    const slowList = (p: Parameters<NonNullable<ProfileOptions["mutate"]>>[0]) => ({ ...p, operations: p.operations.map((o) => (o.operationId === "appointments.list" ? { ...o, timeoutMs: 10_000 } : o)) });
    const { em, rt } = await rig({ emulator: { vendorRateLimitPerSecond: 6 }, profile: { limits: { timeoutMs: 10_000 }, listRateBudget: { requestsPerSecond: 5, burst: 1, maxConcurrency: 8 }, mutate: slowList } });
    // Other traffic of the connector fills the vendor's window: six reads within the same second.
    await Promise.all(Array.from({ length: 6 }, (_, i) => rt.execute("appointments.get", { params: { appointmentId: `apt-0000${i + 1}` } })));
    // Ten list calls: the first is answered 429 (Retry-After: 1) while nine wait for their list tokens.
    const results = await Promise.all(Array.from({ length: 10 }, () => rt.execute("appointments.list")));
    expect(results.every((x) => x.httpStatus === 200)).toBe(true);
    expect(em.rateLimitedResponses).toBe(1);
    const lists = em.requestsTo("GET", "/api/v1/appointments").filter((q) => q.path === "/api/v1/appointments");
    expect(lists).toHaveLength(11); // ten calls and the one retry of the limited call
    const limitedAt = lists[0]?.at ?? 0;
    const after = lists.slice(1).map((q) => q.at);
    // Nothing was sent during the pause, and after it the backlog arrived spaced, not as one burst.
    expect(Math.min(...after) - limitedAt).toBeGreaterThanOrEqual(990);
    expect(em.maxApiRequestsInWindow(1_000, "/api/", limitedAt + 1)).toBeLessThanOrEqual(6);
    expect(Math.max(...after) - Math.min(...after)).toBeGreaterThanOrEqual(1_700); // ten starts 200 ms apart
  }, 20_000);

  it("[FO-06-07][FO-16-39] the connector-wide concurrency cap holds across operations: with limits.maxConcurrency 1 a call to another operation waits for the one in flight, and beyond the queue it is refused BULKHEAD_FULL", async () => {
    // Per-operation budgets that would let each operation run alone (rate 50/s; concurrency 1 each, the most
    // admission allows under a connector cap of 1): only the connector bulkhead keeps the two apart.
    const wide = { requestsPerSecond: 50, burst: 50, maxConcurrency: 1 };
    const { em, rt } = await rig({ profile: { limits: { maxConcurrency: 1 }, mutate: (p) => ({ ...p, operations: p.operations.map((o) => (o.rateBudget ? { ...o, rateBudget: wide } : o)) }) } });
    em.inject("GET /api/v1/appointments", { kind: "delay", ms: 150, times: 20 });
    const get = () => rt.execute("appointments.get", { params: { appointmentId: "apt-00001" } });
    const list = () => rt.execute("appointments.list");
    await Promise.all([get(), list()]);
    expect(em.maxInFlight).toBe(1);
    const getAt = em.requestsTo("GET", "/api/v1/appointments/apt-00001")[0]?.at ?? 0;
    const listAt = em.received.find((q) => q.path === "/api/v1/appointments")?.at ?? 0;
    expect(Math.abs(listAt - getAt)).toBeGreaterThanOrEqual(140); // the second operation queued behind the first
    // One running and four queued (queue = 4 x maxConcurrency): the sixth concurrent call is refused before I/O.
    const sent = api(em).length;
    const outcomes = await Promise.all([get, list, get, list, get, list].map((f) => f().then(() => "ok", (e: ConnectorError) => e.reasonCode)));
    expect([outcomes.filter((o) => o === "ok").length, outcomes.filter((o) => o === "BULKHEAD_FULL").length]).toEqual([5, 1]);
    expect([em.maxInFlight, api(em).length - sent]).toEqual([1, 5]);
  });

  it("[FO-06-07] a vendor 429 with Retry-After is honoured: the retry waits at least that long and succeeds; usage is exported", async () => {
    const { em, rt, metrics } = await rig();
    em.inject("GET /api/v1/appointments/", { kind: "status", status: 429, retryAfter: "1", times: 1 });
    const r = await rt.execute("appointments.get", { params: { appointmentId: "apt-00001" } });
    expect(r.records).toHaveLength(1);
    const calls = em.requestsTo("GET", "/api/v1/appointments/");
    expect(calls).toHaveLength(2);
    expect((calls[1]?.at ?? 0) - (calls[0]?.at ?? 0)).toBeGreaterThanOrEqual(990);
    expect(metrics.gaugeValue("vsp_connector_vendor_quota_remaining_ratio", { dependency: "scheduling" })).toBeGreaterThan(0);
  });

  it("[FO-06-07] a call queued on its operation budget when a Retry-After arrives is still held by the vendor pause (every bucket of the connector pauses)", async () => {
    const { em, rt } = await rig({ profile: { mutate: (p) => ({ ...p, operations: p.operations.map((o) => (o.operationId === "appointments.get" ? { ...o, rateBudget: { requestsPerSecond: 2, burst: 1, maxConcurrency: 4 } } : o)) }) } });
    em.inject("GET /api/v1/appointments/apt-00001", { kind: "status", status: 429, retryAfter: "1", times: 1 });
    // The second call waits ~500 ms for its operation token; the vendor's 1 s pause arrives meanwhile.
    await Promise.all([rt.execute("appointments.get", { params: { appointmentId: "apt-00001" } }), rt.execute("appointments.get", { params: { appointmentId: "apt-00002" } })]);
    const limitedAt = em.requestsTo("GET", "/api/v1/appointments/apt-00001")[0]?.at ?? 0;
    const queuedAt = em.requestsTo("GET", "/api/v1/appointments/apt-00002")[0]?.at ?? 0;
    expect(queuedAt - limitedAt).toBeGreaterThanOrEqual(990);
  });

  it("[FO-06-07] a Retry-After beyond the retry budget is not shortened: the call fails NOT_STARTED with the hint, and the connector pauses", async () => {
    const { em, rt } = await rig({ profile: { limits: { timeoutMs: 1_000 } , mutate: (p) => ({ ...p, operations: p.operations.map((o) => (o.timeoutMs !== undefined ? { ...o, timeoutMs: Math.min(o.timeoutMs, 1_000) } : o)) }) } });
    em.inject("GET /api/v1/appointments/", { kind: "status", status: 503, retryAfter: "120", times: 1 });
    const e = (await err(rt.execute("appointments.get", { params: { appointmentId: "apt-00001" } }))) as ConnectorError;
    expect([e.reasonCode, e.outcome, e.retryAfterMs]).toEqual(["HTTP_503", "NOT_STARTED", 120_000]);
    expect(em.requestsTo("GET", "/api/v1/appointments/")).toHaveLength(1);
    // The vendor asked for 120 s: the connector's bucket refuses new requests instead of hammering it.
    expect(((await err(rt.execute("appointments.get", { params: { appointmentId: "apt-00001" } }))) as ConnectorError).reasonCode).toBe("RATE_BUDGET_EXHAUSTED");
    expect(em.requestsTo("GET", "/api/v1/appointments/")).toHaveLength(1);
  });

  it("[FO-06-07][FO-16-39] the per-operation concurrency cap holds; a saturated connector rejects with BULKHEAD_FULL while another connector proceeds", async () => {
    const a = await rig({ profile: { listRateBudget: { requestsPerSecond: 50, burst: 50, maxConcurrency: 2 } } });
    for (let i = 0; i < 6; i += 1) a.em.inject("GET /api/v1/appointments", { kind: "delay", ms: 150, times: 1 });
    await Promise.all(Array.from({ length: 6 }, () => a.rt.execute("appointments.list")));
    expect(a.em.maxInFlight).toBe(2);
    const sat = await rig({ profile: { limits: { maxConcurrency: 1 }, mutate: (p) => ({ ...p, operations: p.operations.map((o) => (o.rateBudget ? { ...o, rateBudget: { ...o.rateBudget, maxConcurrency: 1 } } : o)) }) } });
    sat.em.inject("GET /api/v1/appointments/", { kind: "delay", ms: 400, times: 10 });
    const other = await rig();
    const inflight = Array.from({ length: 6 }, () => sat.rt.execute("appointments.get", { params: { appointmentId: "apt-00001" } }).then(() => "ok", (e: ConnectorError) => e.reasonCode));
    const otherResult = await other.rt.execute("appointments.get", { params: { appointmentId: "apt-00002" } });
    expect(otherResult.records).toHaveLength(1);
    expect(await Promise.all(inflight)).toContain("BULKHEAD_FULL");
  });

  it("[FO-16-39] repeated availability failures open the connector's circuit: later calls fail fast without I/O", async () => {
    const { em, rt } = await rig({ profile: { limits: { retryBudget: 0 } } });
    em.inject("GET /api/v1/appointments/", { kind: "status", status: 500, times: 20 });
    for (let i = 0; i < 10; i += 1) await err(rt.execute("appointments.get", { params: { appointmentId: "apt-00001" } }));
    const before = em.requestsTo("GET", "/api/v1/appointments/").length;
    expect(((await err(rt.execute("appointments.get", { params: { appointmentId: "apt-00001" } }))) as ConnectorError).reasonCode).toBe("CIRCUIT_OPEN");
    expect(em.requestsTo("GET", "/api/v1/appointments/")).toHaveLength(before);
    expect(rt.circuit.snapshot().state).toBe("open");
  });
});

describe("timeouts and retry classification [FO-06-08][ACT-03]", () => {
  it("[FO-06-08][ACT-03] timeout after send on a write is UNKNOWN, never retried; the reconcile lookup finds the applied effect", async () => {
    const { em, rt } = await rig();
    em.inject("PUT /api/v1/appointments/", { kind: "hang_after_apply", times: 1 });
    const e = (await err(rt.execute("appointments.upsert", { params: { appointmentId: "apt-00004" }, body: { status: "cancelled", startsAt: "2026-11-04T15:00:00Z" }, idempotencyKey: "act_synthIdem0000004" }))) as ConnectorError;
    expect([e.reasonCode, e.outcome, e.retryable]).toEqual(["TIMEOUT_AFTER_SEND", "UNKNOWN", false]);
    expect(em.requestsTo("PUT", "/api/v1/appointments/")).toHaveLength(1);
    expect(em.applied.get("apt-00004")).toBe(1);
    const rec = await rt.reconcile("appointments.upsert", { params: { appointmentId: "apt-00004" } });
    expect([rec.found, rec.result?.records[0]?.values.status]).toEqual([true, "CANCELLED"]);
  });

  it("[FO-06-08][ACT-03] reconcile: a lookup answering 404 is found=false with no result (never 'applied'); a 5xx lookup throws instead of reporting either", async () => {
    const { em, rt } = await rig();
    const missing = await rt.reconcile("appointments.upsert", { params: { appointmentId: "apt-never01" } });
    expect(missing).toEqual({ found: false, result: null });
    expect(em.requestsTo("GET", "/api/v1/appointments/apt-never01")).toHaveLength(1);
    const present = await rt.reconcile("appointments.upsert", { params: { appointmentId: "apt-00003" } });
    expect([present.found, present.result?.records[0]?.values.appointmentId]).toEqual([true, "apt-00003"]);
    // The lookup itself fails (retried once within the read budget): neither found nor not found.
    em.inject("GET /api/v1/appointments/", { kind: "status", status: 500, times: 2 });
    const e = (await err(rt.reconcile("appointments.upsert", { params: { appointmentId: "apt-00003" } }))) as ConnectorError;
    expect([e.constructor.name, e.reasonCode, e.outcome]).toEqual(["ConnectorError", "CONNECTOR_SERVER_ERROR", "FAILED"]);
    em.inject("GET /api/v1/appointments/", { kind: "status", status: 503, times: 2 });
    expect(((await err(rt.reconcile("appointments.upsert", { params: { appointmentId: "apt-00003" } }))) as ConnectorError).reasonCode).toBe("HTTP_503");
  });

  it("[FO-06-08][ACT-03] reconcile through a list-style lookup: a 200 answer with an empty record list is found=false (an unapplied write is never taken as applied); a matching record is found", async () => {
    const byQuery = { name: "appointmentId", in: "query" as const, wireName: "externalId", type: "opaque_id" as const, required: true, maxLength: 64, enumValues: null, integerRange: null };
    const { em, rt } = await rig({ profile: { mutate: (p) => ({ ...p, operations: p.operations.map((o) => (o.operationId === "appointments.lookup" ? { ...o, pathTemplate: "/appointments", params: [byQuery], recordsPointer: "/items" } : o)) }) } });
    const missing = await rt.reconcile("appointments.upsert", { params: { appointmentId: "apt-never02" } });
    expect([missing.found, missing.result?.httpStatus, missing.result?.records.length, missing.result?.mappingDigest === null]).toEqual([false, 200, 0, false]);
    expect(em.requestsTo("GET", "/api/v1/appointments").map((q) => q.query.externalId)).toEqual(["apt-never02"]);
    const present = await rt.reconcile("appointments.upsert", { params: { appointmentId: "apt-00003" } });
    expect([present.found, present.result?.records.map((x) => x.values.appointmentId)]).toEqual([true, ["apt-00003"]]);
  });

  it("[FO-06-08][ACT-03] a 503 on a write that needs reconciliation is UNKNOWN and never retried; on a write with an idempotency key it is retried with the same key and applied once", async () => {
    const plain = await rig({ profile: { mutate: (p) => ({ ...p, operations: p.operations.map((o) => (o.operationId === "appointments.upsert" ? { ...o, idempotency: "NOT_IDEMPOTENT_RECONCILE_REQUIRED", idempotencyKeyHeader: null } : o)) }) } });
    plain.em.inject("PUT /api/v1/appointments/", { kind: "status", status: 503, retryAfter: "1", times: 1 });
    const e = (await err(plain.rt.execute("appointments.upsert", { params: { appointmentId: "apt-new11" }, body: { status: "booked", startsAt: "2026-11-11T15:00:00Z" } }))) as ConnectorError;
    expect([e.reasonCode, e.outcome, e.retryable, e.retryAfterMs]).toEqual(["HTTP_503", "UNKNOWN", false, 1_000]);
    expect(plain.em.requestsTo("PUT", "/api/v1/appointments/")).toHaveLength(1);
    // Reconcile answers whether it was applied (here it was not).
    expect((await plain.rt.reconcile("appointments.upsert", { params: { appointmentId: "apt-new11" } })).found).toBe(false);
    const keyed = await rig();
    keyed.em.inject("PUT /api/v1/appointments/", { kind: "status", status: 503, retryAfter: "1", times: 1 });
    const ok = await keyed.rt.execute("appointments.upsert", { params: { appointmentId: "apt-new12" }, body: { status: "booked", startsAt: "2026-11-12T15:00:00Z" }, idempotencyKey: "act_synthIdem0000012" });
    expect(ok.records[0]?.values.appointmentId).toBe("apt-new12");
    const puts = keyed.em.requestsTo("PUT", "/api/v1/appointments/");
    expect([puts.length, new Set(puts.map((q) => q.idempotencyKey)).size, keyed.em.applied.get("apt-new12")]).toEqual([2, 1, 1]);
  });

  it("[FO-06-08][ACT-03] a 5xx after the vendor applied a write is UNKNOWN and not retried; a 5xx on a read is retried within budget", async () => {
    const { em, rt } = await rig();
    em.inject("PUT /api/v1/appointments/", { kind: "error_after_apply", status: 500, times: 1 });
    const e = (await err(rt.execute("appointments.upsert", { params: { appointmentId: "apt-00005" }, body: { status: "booked", startsAt: "2026-11-05T15:00:00Z" }, idempotencyKey: "act_synthIdem0000005" }))) as ConnectorError;
    expect([e.reasonCode, e.outcome]).toEqual(["CONNECTOR_SERVER_ERROR", "UNKNOWN"]);
    expect(em.requestsTo("PUT", "/api/v1/appointments/")).toHaveLength(1);
    em.inject("GET /api/v1/appointments/", { kind: "status", status: 500, times: 1 });
    expect((await rt.execute("appointments.get", { params: { appointmentId: "apt-00001" } })).records).toHaveLength(1);
    expect(em.requestsTo("GET", "/api/v1/appointments/")).toHaveLength(2);
  });

  it("[FO-06-08] timeout before send (token endpoint never answers) is NOT_STARTED; connection refused is NOT_STARTED; a read timeout is retried once", async () => {
    const tok = await rig({ profile: { limits: { retryBudget: 0, timeoutMs: 300 }, mutate: (p) => ({ ...p, operations: p.operations.map((o) => (o.timeoutMs !== undefined ? { ...o, timeoutMs: 300 } : o)) }) } });
    tok.em.inject("POST /oauth/token", { kind: "hang", times: 1 });
    const e = (await err(tok.rt.execute("appointments.upsert", { params: { appointmentId: "apt-00006" }, body: { status: "booked", startsAt: "2026-11-06T15:00:00Z" }, idempotencyKey: "act_synthIdem0000006" }))) as ConnectorError;
    expect([e.reasonCode, e.outcome]).toEqual(["TIMEOUT_BEFORE_SEND", "NOT_STARTED"]);
    expect(tok.em.requestsTo("PUT", "/api/v1/appointments/")).toHaveLength(0);
    const read = await rig({ profile: { mutate: (p) => ({ ...p, operations: p.operations.map((o) => (o.operationId === "appointments.get" ? { ...o, timeoutMs: 300 } : o)) }) } });
    read.em.inject("GET /api/v1/appointments/", { kind: "hang", times: 1 });
    expect((await read.rt.execute("appointments.get", { params: { appointmentId: "apt-00001" } })).records).toHaveLength(1);
    expect(read.em.requestsTo("GET", "/api/v1/appointments/")).toHaveLength(2);
  });

  it("[FO-06-08] no retry stacking: inside another retry scope the runtime refuses (NESTED_RETRY_REFUSED) before any I/O", async () => {
    const { em, rt } = await rig();
    const e = await err(retry(() => rt.execute("appointments.get", { params: { appointmentId: "apt-00001" } }), { dependency: "scheduling", maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 }));
    expect((e as ConnectorError).reasonCode).toBe("NESTED_RETRY_REFUSED");
    expect(em.received).toHaveLength(0);
  });
});

describe("mapping, drift and data minimization [FO-06-05][DATA-01]", () => {
  it("[FAULT:SCHEMA_DRIFT seam][FO-06-05] a drifted vendor record is refused whole, typed, and the capability turns UNKNOWN", async () => {
    const { em, rt } = await rig();
    await probeConnector(rt, { now: () => new Date() });
    expect(rt.readiness().find((r) => r.capability === "scheduling.appointments_read")?.status).toBe("READY");
    em.drift = { rename: { status: "state" } };
    const e = await err(rt.readAll("appointments.list"));
    expect(e).toBeInstanceOf(ConnectorSchemaDriftError);
    expect((e as ConnectorSchemaDriftError).issues).toEqual([{ kind: "MISSING_REQUIRED", targetField: "status" }]);
    expect(rt.readiness().find((r) => r.capability === "scheduling.appointments_read")).toMatchObject({ status: "UNKNOWN", reasonCode: "CONNECTOR_SCHEMA_DRIFT" });
    expect((await rt.health()).healthy).toBe(false);
  });

  it("[FO-06-05][ACT-03] a write whose receipt drifted is UNKNOWN (its effect cannot be read back): reconcile first", async () => {
    const { em, rt } = await rig();
    em.drift = { retype: ["startsAt"] };
    const e = (await err(rt.execute("appointments.upsert", { params: { appointmentId: "apt-00007" }, body: { status: "booked", startsAt: "2026-11-07T15:00:00Z" }, idempotencyKey: "act_synthIdem0000007" }))) as ConnectorError;
    expect([e.reasonCode, e.outcome]).toEqual(["CONNECTOR_RECEIPT_SCHEMA_DRIFT", "UNKNOWN"]);
    expect(em.applied.get("apt-00007")).toBe(1);
  });

  it("[DATA-01] positive and adversarial: prohibited fields never leave the mapping; logs and errors carry no record value, token or secret", async () => {
    const { em, rt, logs } = await rig();
    const r = await rt.readAll("appointments.list");
    expect(JSON.stringify(r)).not.toContain("SYNTHETIC restricted note");
    em.inject("GET /api/v1/appointments/", { kind: "status", status: 400, times: 1, body: { error: "bad", echo: "SYNTHETIC-PHI-Jane-Doe-1970-01-01" } });
    const e = await err(rt.execute("appointments.get", { params: { appointmentId: "apt-00001" } }));
    expect(e.message).toBe("CONNECTOR_REQUEST_REJECTED");
    const dump = JSON.stringify(logs.records);
    for (const secret of ["secret-read-v1", "SYNTHETIC-PHI-Jane-Doe", "SYNTHETIC restricted note", "apt-00001"]) expect(dump).not.toContain(secret);
  });

  it("[DATA-01] failure injection: an egress policy that does not approve PHI for the vendor stops the call before I/O", async () => {
    const policy = emulatorEgressPolicy();
    const d = policy.destinations[0];
    if (!d) throw new Error("policy");
    const { em, rt } = await rig({ egressPolicy: { ...policy, destinations: [{ ...d, allowedClasses: ["INTERNAL"] }] } });
    const e = await err(rt.execute("appointments.get", { params: { appointmentId: "apt-00001" } }));
    expect(e.message).toBe("EGRESS_PHI_NOT_APPROVED_FOR_DESTINATION");
    expect(api(em)).toHaveLength(0);
  });
});

describe("active probes and readiness [FO-06-11][OPS-03]", () => {
  it("[FO-06-11][OPS-03] a never-contacted connector is UNKNOWN and unhealthy; the registry health report fails closed", async () => {
    const { rt } = await rig();
    expect(rt.readiness().map((r) => [r.status, r.reasonCode])).toEqual([
      ["UNKNOWN", "CONNECTOR_NEVER_PROBED"],
      ["UNKNOWN", "CONNECTOR_NEVER_PROBED"],
    ]);
    const reg = new AdapterRegistry();
    reg.register("scheduling", rt);
    expect(await reg.healthReport()).toEqual([{ component: "scheduling", integrationId: "scheduling", kind: "live", healthy: false, reasonCode: "CONNECTOR_NEVER_PROBED" }]);
  });

  it("[FO-06-11] probes: auth + metadata + synthetic record make reads READY; writes need an authorized sandbox write and reconcile", async () => {
    const { em, rt } = await rig();
    const report = await probeConnector(rt, { now: () => new Date() });
    expect(report.steps.map((s) => [s.step, s.result])).toEqual([
      ["VALIDATE_CONFIGURATION", "PASS"],
      ["AUTHENTICATE", "PASS"],
      ["INSPECT_METADATA", "PASS"],
      ["INSPECT_SYNTHETIC_RECORD", "PASS"],
      ["WRITE_RECONCILE_TEST", "NOT_RUN"],
      ["COMPARE_MAPPING", "PASS"],
    ]);
    expect(rt.readiness().map((r) => [r.capability, r.status])).toEqual([
      ["scheduling.appointments_read", "READY"],
      ["scheduling.appointments_write", "UNKNOWN"],
    ]);
    expect(em.applied.size).toBe(0);
    const full = await probeConnector(rt, { now: () => new Date(), sandboxWrite: { operationId: "appointments.upsert", input: { params: { appointmentId: "apt-sbx01" }, body: { status: "booked", startsAt: "2026-11-09T15:00:00Z" }, idempotencyKey: "act_synthProbeWrite01" } } });
    expect(full.steps.find((s) => s.step === "WRITE_RECONCILE_TEST")).toEqual({ step: "WRITE_RECONCILE_TEST", result: "PASS", detailCode: "WRITE_RECONCILED" });
    expect((await rt.health()).healthy).toBe(true);
  });

  it("[FO-06-11][ACT-03] a sandbox write must name an enabled WRITE operation: a read or an undeclared operation is NOT_RUN SANDBOX_WRITE_NOT_AUTHORIZED, nothing is sent for it and the write capability stays unqualified", async () => {
    const { em, rt } = await rig();
    for (const operationId of ["appointments.get", "appointments.metadata", "appointments.delete_everything"]) {
      const before = api(em).length;
      const report = await probeConnector(rt, { now: () => new Date(), sandboxWrite: { operationId, input: { params: { appointmentId: "apt-00001" }, body: { status: "booked", startsAt: "2026-11-09T15:00:00Z" }, idempotencyKey: "act_synthProbeWrite03" } } });
      expect(report.steps.find((s) => s.step === "WRITE_RECONCILE_TEST"), operationId).toEqual({ step: "WRITE_RECONCILE_TEST", result: "NOT_RUN", detailCode: "SANDBOX_WRITE_NOT_AUTHORIZED" });
      // The probe's own reads (metadata, synthetic record) only: the named operation was not run as a test write.
      expect(api(em).length - before, operationId).toBe(2);
      expect(rt.readiness().map((r) => [r.capability, r.status]), operationId).toEqual([
        ["scheduling.appointments_read", "READY"],
        ["scheduling.appointments_write", "UNKNOWN"],
      ]);
    }
    expect([em.requestsTo("PUT", "/api/v1/appointments/").length, em.applied.size]).toEqual([0, 0]);
  });

  it("[FO-06-11][OPS-04][ACT-03] a sandbox write is never sent on a PRODUCTION_WRITE or READ_ONLY profile: the step is NOT_RUN WRITE_TEST_REQUIRES_SANDBOX_PROFILE and the write capability is not qualified", async () => {
    const sandboxWrite = { operationId: "appointments.upsert", input: { params: { appointmentId: "apt-sbx02" }, body: { status: "booked", startsAt: "2026-11-09T15:00:00Z" }, idempotencyKey: "act_synthProbeWrite02" } };
    const refused = { step: "WRITE_RECONCILE_TEST", result: "NOT_RUN", detailCode: "WRITE_TEST_REQUIRES_SANDBOX_PROFILE" };
    // PRODUCTION_WRITE is admitted only for staging / production, whose references are Secrets Manager ARNs.
    const prod = await rig({ admitEnvironment: "staging", profile: { writeMode: "PRODUCTION_WRITE", readRef: ARN_READ, writeRef: ARN_WRITE }, wrapSecrets: (s) => new ArnAliasResolver(s, { [ARN_READ]: READ_REF, [ARN_WRITE]: WRITE_REF }) });
    const p = await probeConnector(prod.rt, { now: () => new Date(), sandboxWrite });
    expect(p.steps.find((x) => x.step === "WRITE_RECONCILE_TEST")).toEqual(refused);
    expect([prod.em.requestsTo("PUT", "/api/v1/appointments/").length, prod.em.applied.size]).toEqual([0, 0]);
    expect(prod.rt.readiness().map((x) => [x.capability, x.status, x.reasonCode])).toEqual([
      ["scheduling.appointments_read", "READY", "PROBES_PASSED"],
      ["scheduling.appointments_write", "UNKNOWN", "WRITE_RECONCILE_TEST_NOT_RUN"],
    ]);
    expect((await prod.rt.health()).healthy).toBe(false);

    const ro = await rig({ profile: { writeMode: "READ_ONLY", mutate: (q) => ({ ...q, capabilityCredentials: q.capabilityCredentials?.filter((c) => c.access === "READ"), operations: q.operations.map((o) => (o.kind === "WRITE" ? { ...o, enabled: false } : o)), bindingVerification: { account: { source: "TOKEN_RESPONSE", locator: "/instance_id" }, region: null } }) } });
    const r = await probeConnector(ro.rt, { now: () => new Date(), sandboxWrite });
    expect(r.steps.find((x) => x.step === "WRITE_RECONCILE_TEST")).toEqual(refused);
    expect([ro.em.requestsTo("PUT", "/api/v1/appointments/").length, ro.em.applied.size]).toEqual([0, 0]);
    expect(ro.rt.readiness().map((x) => [x.capability, x.status])).toEqual([["scheduling.appointments_read", "READY"]]);
  });

  it("[FO-06-11][FO-06-13][FO-06-07] metadata is fetched on the standard call path: a 5xx is retried within budget, a response from another region is refused, and the metadata operation's budget and bulkhead apply", async () => {
    const { em, rt } = await rig();
    em.inject("GET /api/v1/metadata/", { kind: "status", status: 503, times: 1 });
    const meta = await rt.fetchMetadata("Appointment");
    expect([...meta.fields.keys()]).toContain("/status");
    expect(em.requestsTo("GET", "/api/v1/metadata/")).toHaveLength(2); // retried once (retryBudget 1)
    em.reportRegion = "eu-west-1";
    const e = (await err(rt.fetchMetadata("Appointment"))) as ConnectorError;
    expect([e.reasonCode, e.outcome]).toEqual(["CONNECTOR_REGION_MISMATCH", "FAILED"]);
    expect(rt.readiness().find((r) => r.capability === "scheduling.appointments_read")?.status).toBe("NOT_READY");
    // A connector pause (Retry-After) holds metadata too: its operation bucket pauses with the rest.
    em.reportRegion = null;
    const paused = await rig({ profile: { limits: { timeoutMs: 1_000 }, mutate: (p) => ({ ...p, operations: p.operations.map((o) => (o.timeoutMs !== undefined ? { ...o, timeoutMs: Math.min(o.timeoutMs, 1_000) } : o)) }) } });
    paused.em.inject("GET /api/v1/appointments/", { kind: "status", status: 503, retryAfter: "120", times: 1 });
    await err(paused.rt.execute("appointments.get", { params: { appointmentId: "apt-00001" } }));
    expect(((await err(paused.rt.fetchMetadata("Appointment"))) as ConnectorError).reasonCode).toBe("RATE_BUDGET_EXHAUSTED");
    expect(paused.em.requestsTo("GET", "/api/v1/metadata/")).toHaveLength(0);
  });

  it("[FO-06-11] failure injection: metadata drift fails the probe and leaves the capability UNKNOWN; an auth failure makes it NOT_READY", async () => {
    const drift = await rig();
    drift.em.drift = { retype: ["seq"] };
    const r = await probeConnector(drift.rt, { now: () => new Date() });
    expect(r.steps.find((s) => s.step === "INSPECT_METADATA")).toMatchObject({ result: "FAIL", detailCode: "CONNECTOR_SCHEMA_DRIFT" });
    expect(drift.rt.readiness().find((x) => x.capability === "scheduling.appointments_read")?.status).toBe("UNKNOWN");
    const auth = await rig();
    auth.em.acceptSecret("client-read", "rotated-without-telling-us");
    await probeConnector(auth.rt, { now: () => new Date() });
    expect(auth.rt.readiness().find((x) => x.capability === "scheduling.appointments_read")).toMatchObject({ status: "NOT_READY", reasonCode: "CONNECTOR_TOKEN_CLIENT_REJECTED" });
  });
});
