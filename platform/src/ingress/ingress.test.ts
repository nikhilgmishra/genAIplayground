/**
 * Authenticated inbound inbox (FO-07-16..22, FO-06-97, FO-06-98, FO-15-50, FO-03-21) over real PostgreSQL
 * SQL (PGlite: foundation, audit and 2041 migrations), the real PgAuditWriter, the production router,
 * verifiers, inbox, processor and replay service, with LOCAL FIXTURES for the credential store
 * (StaticCredentialResolverFixture) and the payload key (LocalAesCipherFixture). SYNTHETIC events only.
 * Layer 2 runs the same code against PostgreSQL 16, LocalStack KMS and Secrets Manager (rotation) and over
 * real HTTP/TLS (test/integration/ingress).
 */
import { createHmac, createHash } from "node:crypto";
import fastify from "fastify";
import fc from "fast-check";
import { SignJWT } from "jose";
import { AccessToken } from "livekit-server-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { PgAuditWriter } from "../audit/writer.js";
import { LegalHoldStorePg } from "../retention/policies.js";
import { PEOPLE, STAFF } from "../fixtures/synthetic-world.js";
import type { PgliteDb } from "../db/pglite.js";
import { createTestDb } from "../db/testing.js";
import { ingressPlugin } from "../gateway/http/webhook-routes.js";
import { createMemoryLogger } from "../observability/logger.js";
import { InMemoryMetrics, createMetricCatalogue } from "../observability/metrics.js";
import { withSubstrateMetrics } from "../observability/catalog/substrate.js";
import { FakeClock, iso } from "../shared/clock.js";
import { newId } from "../shared/ids.js";
import { LocalAesCipherFixture } from "./cipher.js";
import { InboundContractRegistry, classify } from "./contracts.js";
import { StaticCredentialResolverFixture } from "./credentials.js";
import { INBOUND_RAW_PAYLOAD_DATASET, PgInbox } from "./inbox.js";
import { InboxProcessor } from "./processor.js";
import type { InboxHandler } from "./processor.js";
import { SourceProfileRegistry } from "./profile.js";
import type { SourceProfile } from "./profile.js";
import { applySourceVersioned, compareOrderKeys } from "./projection.js";
import { InboxReplayService } from "./replay.js";
import { IngressRouter } from "./router.js";
import { StreamIngestor } from "./streams.js";
import type { StreamSource, StreamRecord } from "./streams.js";
import { InboundVerifier } from "./verifiers.js";

const TENANT = "tnt_synthTenantPrimary01";
const SECRET_OLD = "whk_synthWebhookKeyVersionOne0000000001";
const SECRET_NEW = "whk_synthWebhookKeyVersionTwo0000000002";
let db: PgliteDb;
let clock: FakeClock;

/** Creating and migrating an embedded PostgreSQL can take long on a contended shared machine. */
const PGLITE_SETUP_TIMEOUT_MS = 120_000;

beforeEach(async () => {
  db = await createTestDb({ include: /^(02|08|2041|2043)/ });
  clock = new FakeClock("2026-10-19T12:00:00.000Z");
}, PGLITE_SETUP_TIMEOUT_MS);
afterEach(async () => {
  await db.close();
});

const Receipt = z.strictObject({
  id: z.string(),
  type: z.literal("message.delivered"),
  occurredAt: z.string(),
  version: z.string().regex(/^[0-9]{1,20}$/),
  entity: z.string(),
  status: z.enum(["DELIVERED", "FAILED"]),
});
const contracts = () => new InboundContractRegistry([{ contractId: "delivery.receipt", version: "1", schema: Receipt }]);

function profile(sourceId: string, verifier: SourceProfile["verifier"], extra: Partial<SourceProfile> = {}): Record<string, unknown> {
  return {
    sourceId,
    tenantId: TENANT,
    family: verifier.kind === "stream_iam" ? "stream" : "delivery_receipt",
    vendor: "Synthetic Vendor",
    documentationUrl: "https://docs.example.invalid/webhooks",
    verifier,
    envelope: { idField: "id", typeField: "type", occurredAtField: "occurredAt", versionField: "version", entityField: "entity" },
    contracts: { "message.delivered": { contractId: "delivery.receipt", version: "1" } },
    maxBodyBytes: 4096,
    rawRetentionDays: 30,
    processing: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 8000 },
    rotationOverlapSeconds: 3600,
    acceptPendingCredential: false,
    ...extra,
  };
}

const hmacProfile = (sourceId = "receipts.synthetic") =>
  profile(sourceId, {
    kind: "hmac_header",
    algorithm: "sha256",
    signatureHeader: "x-synthetic-signature",
    encoding: "hex",
    prefix: "sha256=",
    signedPayload: "timestamp.body",
    timestampHeader: "x-synthetic-timestamp",
    toleranceSeconds: 300,
    credentials: "local-fixture:webhooks/receipts",
  });

const receipt = (over: Partial<Record<string, string>> = {}) =>
  Buffer.from(JSON.stringify({ id: newId("evt"), type: "message.delivered", occurredAt: iso(clock.now()), version: "1", entity: "msg_synthetic0001", status: "DELIVERED", ...over }));

function compose(profiles: Record<string, unknown>[] = [hmacProfile()], creds?: StaticCredentialResolverFixture) {
  const { logger, records } = createMemoryLogger();
  const metrics = new InMemoryMetrics({ catalogue: withSubstrateMetrics(createMetricCatalogue()) });
  const credentials =
    creds ??
    new StaticCredentialResolverFixture().set("local-fixture:webhooks/receipts", [{ version: "v1", material: SECRET_OLD }]).set("local-fixture:livekit/api", [{ version: "lk1", material: SECRET_OLD }]);
  const registry = new SourceProfileRegistry(profiles);
  const cipher = new LocalAesCipherFixture();
  const audit = new PgAuditWriter({ db, clock, stream: "gateway.ingress-test" });
  const inbox = new PgInbox({ db, cipher, audit, clock, logger, metrics });
  const router = new IngressRouter({ profiles: registry, contracts: contracts(), verifier: new InboundVerifier({ credentials, clock }), inbox, clock, logger, metrics });
  return { router, inbox, registry, cipher, audit, metrics, records, credentials, logger };
}

function signed(body: Buffer, secret = SECRET_OLD, ts = Math.floor(clock.now().getTime() / 1000)) {
  const sig = createHmac("sha256", secret).update(Buffer.concat([Buffer.from(`${ts}.`), body])).digest("hex");
  const headers: Record<string, string> = { "x-synthetic-signature": `sha256=${sig}`, "x-synthetic-timestamp": String(ts) };
  return { sourceId: "receipts.synthetic", rawBody: body, header: (n: string) => headers[n] ?? null, peer: null };
}

async function rows(): Promise<Record<string, unknown>[]> {
  return (await db.tx((tx) => tx.query("select * from inbound_events order by received_at, inbox_id"), { role: "owner" })).rows;
}

describe("IngressRouter: authenticate before persistence, persist before acknowledgement", () => {
  it("[FO-07-16][FO-07-17][FO-07-19] a signed event is stored encrypted with its digest, contract and the verifying credential version, and audited in the same transaction", async () => {
    const { router } = compose();
    const body = receipt();
    const res = await router.handle(signed(body));
    expect(res).toMatchObject({ status: 200, body: { accepted: true, decision: "accepted" } });
    const [row] = await rows();
    expect(row).toMatchObject({
      status: "RECEIVED",
      schema_id: "delivery.receipt",
      schema_version: "1",
      auth_mechanism: "HMAC_SHA256_HEADER",
      credential_version: "v1",
      payload_digest: createHash("sha256").update(body).digest("hex"),
      cipher_kind: "local_fixture",
      retention_class: "INBOUND_RAW_REPLAY",
    });
    // Encrypted at rest: the stored ciphertext is not the plaintext.
    expect(Buffer.from(row?.payload_ciphertext as Uint8Array).includes(Buffer.from("msg_synthetic0001"))).toBe(false);
    const audit = (await db.tx((tx) => tx.query<{ event: { action: string; ingress: unknown; evidencePointers: string[] } }>("select event from audit_outbox"), { role: "owner" })).rows[0]?.event;
    expect(audit?.action).toBe("ingress.event.accepted");
    expect(audit?.ingress).toEqual({ sourceId: "receipts.synthetic", payloadDigest: row?.payload_digest, schemaId: "delivery.receipt", schemaVersion: "1", authMechanism: "HMAC_SHA256_HEADER", credentialVersion: "v1" });
    expect(row?.audit_event_id).toBeTruthy();
  });

  it("[OPS-03][DATA-01] ingress logs name the source and the decision in fields the content-free logger keeps, and never carry a signature, a secret or payload content", async () => {
    const { router, records } = compose();
    const body = receipt();
    const good = signed(body);
    await router.handle(good);
    await router.handle(good);
    await router.handle({ ...good, rawBody: Buffer.concat([body, Buffer.from(" ")]) });
    const of = (event: string) => records.filter((r) => r.event === event).map((r) => r.fields);
    expect(of("ingress.persisted").map((f) => [f.integration, f.outcome])).toEqual([
      ["receipts.synthetic", "accepted"],
      ["receipts.synthetic", "duplicate"],
    ]);
    expect(of("ingress.auth_rejected")).toEqual([expect.objectContaining({ integration: "receipts.synthetic", reasonCode: "INGRESS_SIGNATURE_INVALID" })]);
    const text = JSON.stringify(records);
    expect(text).not.toContain("[redacted]");
    expect(text).not.toContain(good.header("x-synthetic-signature") ?? "-");
    expect(text).not.toContain("msg_synthetic0001");
    for (const form of [SECRET_OLD, Buffer.from(SECRET_OLD).toString("base64")]) expect(text).not.toContain(form);
  });

  it("[FO-07-16][FO-15-50][DATA-01] an unauthenticated, tampered, stale or oversized delivery is rejected and nothing is persisted; a byte-identical replay is a recorded duplicate, never a second event", async () => {
    const { router, metrics } = compose();
    const body = receipt();
    const good = signed(body);
    expect((await router.handle({ ...good, header: () => null })).status).toBe(401);
    expect((await router.handle({ ...good, rawBody: Buffer.concat([body, Buffer.from(" ")]) })).body).toEqual({ error: { reasonCode: "INGRESS_SIGNATURE_INVALID" } });
    expect((await router.handle(signed(body, SECRET_OLD, Math.floor(clock.now().getTime() / 1000) - 3600))).body).toEqual({ error: { reasonCode: "INGRESS_TIMESTAMP_INVALID" } });
    expect((await router.handle({ ...good, rawBody: Buffer.alloc(5000, 32) })).status).toBe(413);
    expect((await router.handle({ ...good, sourceId: "unknown.source" })).status).toBe(404);
    expect(await rows()).toEqual([]);
    const first = await router.handle(good);
    expect(first).toMatchObject({ status: 200, body: { decision: "accepted" } });
    // The captured request replayed inside the timestamp window: authentic, deduplicated, applied once.
    const again = await router.handle(good);
    expect(again).toMatchObject({ status: 200, body: { decision: "duplicate" } });
    expect((again.body as { inboxId: string }).inboxId).toBe((first.body as { inboxId: string }).inboxId);
    expect(await rows()).toHaveLength(1);
    // After the window the same bytes are refused before the inbox.
    clock.advanceSeconds(301);
    expect((await router.handle(good)).body).toEqual({ error: { reasonCode: "INGRESS_TIMESTAMP_INVALID" } });
    expect(metrics.counterValue("vsp_inbox_events_total", { result: "auth_rejected" })).toBe(4);
  });

  it("[FO-07-18][FO-15-50][FAULT:DUPLICATE_WEBHOOK] a body-signed HMAC source (the signature covers only the bytes, as GitHub and Shopify sign): the vendor's byte-identical redelivery after a lost acknowledgement is answered 200 duplicate and recorded", async () => {
    const body = profile("repo.events", {
      kind: "hmac_header",
      algorithm: "sha256",
      signatureHeader: "x-hub-signature-256",
      encoding: "hex",
      prefix: "sha256=",
      signedPayload: "body",
      timestampHeader: null,
      toleranceSeconds: 300,
      credentials: "local-fixture:webhooks/receipts",
    });
    const { router } = compose([body]);
    const bytes = receipt();
    const sig = `sha256=${createHmac("sha256", SECRET_OLD).update(bytes).digest("hex")}`;
    const req = { sourceId: "repo.events", rawBody: bytes, header: (n: string) => (n === "x-hub-signature-256" ? sig : null), peer: null };
    expect(await router.handle(req)).toMatchObject({ status: 200, body: { decision: "accepted" } });
    clock.advanceSeconds(30); // the sender's acknowledgement timed out; it redelivers the identical request
    expect(await router.handle(req)).toMatchObject({ status: 200, body: { decision: "duplicate" } });
    const deliveries = await db.tx((tx) => tx.query<{ duplicate: boolean; digest_matches: boolean }>("select duplicate, digest_matches from inbound_deliveries order by received_at"), { role: "owner" });
    expect(deliveries.rows).toEqual([
      { duplicate: false, digest_matches: true },
      { duplicate: true, digest_matches: true },
    ]);
    expect(await rows()).toHaveLength(1);
  });

  it("[FO-15-50][FO-07-18][AUTH-04] JWT replay cache: the same token over the same bytes is a recorded duplicate; a token that does not bind the body cannot be reused over other bytes (durable, refused before anything is stored); such a token without a jti is refused", async () => {
    const unbound = profile("cdp.jwt", { kind: "jwt_bearer", header: "authorization", issuer: "cdp.synthetic", audience: "vsp-ingress", algorithms: ["HS256"], credentials: "local-fixture:livekit/api", jwksUrl: null, bodyHashClaim: null, maxTokenAgeSeconds: 600 });
    const { router } = compose([unbound]);
    clock.set(new Date());
    const key = new TextEncoder().encode(SECRET_OLD);
    const token = (jti: string | null) => {
      const t = new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setIssuer("cdp.synthetic").setAudience("vsp-ingress").setIssuedAt().setExpirationTime("5m");
      return (jti ? t.setJti(jti) : t).sign(key);
    };
    const req = (b: Buffer, t: string) => ({ sourceId: "cdp.jwt", rawBody: b, header: (n: string) => (n === "authorization" ? `Bearer ${t}` : null), peer: null });
    const t1 = await token(newId("jti"));
    const bytes = receipt();
    expect(await router.handle(req(bytes, t1))).toMatchObject({ status: 200, body: { decision: "accepted" } });
    expect(await router.handle(req(bytes, t1))).toMatchObject({ status: 200, body: { decision: "duplicate" } });
    const other = receipt();
    expect(await router.handle(req(other, t1))).toEqual({ status: 401, body: { error: { reasonCode: "INGRESS_REPLAYED" } } });
    // The refusal is durable state, not process memory: a second router (another replica) refuses it too.
    const replica = compose([unbound]);
    expect(await replica.router.handle(req(other, t1))).toEqual({ status: 401, body: { error: { reasonCode: "INGRESS_REPLAYED" } } });
    expect((await rows()).map((r) => r.event_id)).toEqual([JSON.parse(bytes.toString()).id]);
    expect(await router.handle(req(receipt(), await token(null)))).toEqual({ status: 401, body: { error: { reasonCode: "INGRESS_TOKEN_JTI_REQUIRED" } } });
    // A fresh token is a fresh key.
    expect(await router.handle(req(other, await token(newId("jti"))))).toMatchObject({ status: 200, body: { decision: "accepted" } });
    const keys = await db.tx((tx) => tx.query<{ key_digest: string }>("select key_digest from inbound_replay_keys"), { role: "owner" });
    expect(keys.rows).toHaveLength(2);
    expect(JSON.stringify(keys.rows)).not.toContain(t1);
    // Expired keys are purged by the worker; an unexpired key cannot be deleted.
    const { inbox } = compose([unbound]);
    expect(await inbox.purgeExpiredReplayKeys(TENANT)).toBe(0);
    const reason = (p: Promise<unknown>) => p.then(() => "RESOLVED", (e: Error) => e.message);
    expect(await reason(db.tx((tx) => tx.query("delete from inbound_replay_keys"), { role: "app_worker", rls: { tenantId: TENANT } }))).toContain("INBOX_REPLAY_KEY_NOT_EXPIRED");
  });

  it("[FO-06-98][AUTH-06] during the overlap window the old and the new secret both verify; after it only the new one does; the inbox records which version verified; no secret reaches logs", async () => {
    const t0 = clock.now();
    const creds = new StaticCredentialResolverFixture().set("local-fixture:webhooks/receipts", [
      { version: "v1", material: SECRET_OLD, stage: "previous", validUntil: new Date(t0.getTime() + 3_600_000) },
      { version: "v2", material: SECRET_NEW, stage: "current", validFrom: t0 },
    ]);
    const { router, records } = compose([hmacProfile()], creds);
    expect((await router.handle(signed(receipt(), SECRET_OLD))).status).toBe(200);
    clock.advanceSeconds(1);
    expect((await router.handle(signed(receipt(), SECRET_NEW))).status).toBe(200);
    clock.advanceSeconds(3600);
    expect((await router.handle(signed(receipt(), SECRET_OLD))).body).toEqual({ error: { reasonCode: "INGRESS_SIGNATURE_INVALID" } });
    expect((await router.handle(signed(receipt(), SECRET_NEW))).status).toBe(200);
    expect((await rows()).map((r) => r.credential_version)).toEqual(["v1", "v2", "v2"]);
    const logged = JSON.stringify(records);
    expect(logged).not.toContain(SECRET_OLD);
    expect(logged).not.toContain(SECRET_NEW);
    expect(logged).not.toContain("msg_synthetic0001");
  });

  it("[FO-15-50][FO-07-16] a LiveKit-signed webhook (JWT over the body, the vendor SDK as sender) verifies; a body that does not match the token's sha256 claim is refused", async () => {
    const lk = profile("livekit.webhooks", { kind: "jwt_bearer", header: "authorization", issuer: "APIsynthetic01", audience: null, algorithms: ["HS256"], credentials: "local-fixture:livekit/api", jwksUrl: null, bodyHashClaim: "sha256", maxTokenAgeSeconds: 600 });
    const { router } = compose([lk]);
    const body = receipt();
    const at = new AccessToken("APIsynthetic01", SECRET_OLD, { ttl: "5m" });
    at.sha256 = createHash("sha256").update(body).digest("base64");
    const token = await at.toJwt();
    const req = (b: Buffer, t: string) => ({ sourceId: "livekit.webhooks", rawBody: b, header: (n: string) => (n === "authorization" ? t : null), peer: null });
    // jose's currentDate is the FakeClock: issue the token "now" relative to it.
    clock.set(new Date());
    expect((await router.handle(req(body, token))).status).toBe(200);
    expect((await router.handle(req(receipt(), token))).body).toEqual({ error: { reasonCode: "INGRESS_BODY_HASH_MISMATCH" } });
    const forged = await new SignJWT({ sha256: at.sha256 }).setProtectedHeader({ alg: "HS256" }).setIssuer("APIsynthetic01").setExpirationTime("5m").sign(new TextEncoder().encode("not-the-api-secret-0000000000000"));
    expect((await router.handle(req(body, forged))).body).toEqual({ error: { reasonCode: "INGRESS_TOKEN_INVALID" } });
  });

  it("[FO-07-16] reconcile-by-lookup: the delivered body is replaced by the authoritative record; an announcement the source cannot confirm is refused", async () => {
    const rbl = profile("cdp.unsigned", { kind: "reconcile_by_lookup", gatewayCredentials: "local-fixture:webhooks/receipts", gatewayHeader: "x-gateway-token" });
    const base = compose([rbl]);
    const authoritative = receipt({ id: "evt_authoritative0001", status: "FAILED" });
    const router = new IngressRouter({
      profiles: base.registry,
      contracts: contracts(),
      verifier: new InboundVerifier({ credentials: base.credentials, clock }),
      inbox: base.inbox,
      clock,
      lookups: { "cdp.unsigned": { fetch: async (_s, id) => (id === "evt_authoritative0001" ? authoritative : null) } },
    });
    const req = (b: Buffer) => ({ sourceId: "cdp.unsigned", rawBody: b, header: (n: string) => (n === "x-gateway-token" ? SECRET_OLD : null), peer: null });
    const claimed = receipt({ id: "evt_authoritative0001", status: "DELIVERED" });
    expect((await router.handle(req(claimed))).status).toBe(200);
    expect((await rows())[0]).toMatchObject({ auth_mechanism: "RECONCILE_BY_LOOKUP", payload_digest: createHash("sha256").update(authoritative).digest("hex") });
    expect((await router.handle(req(receipt({ id: "evt_unknownAtSource01" })))).body).toEqual({ error: { reasonCode: "INGRESS_LOOKUP_NOT_FOUND" } });
    expect((await router.handle({ ...req(claimed), header: () => "wrong" })).status).toBe(401);
  });

  it("[FO-07-16][DATA-01] reconcile-by-lookup: an authoritative record that describes ANOTHER event than the one announced is refused (401 INGRESS_LOOKUP_EVENT_MISMATCH) and nothing is stored", async () => {
    const rbl = profile("cdp.unsigned", { kind: "reconcile_by_lookup", gatewayCredentials: "local-fixture:webhooks/receipts", gatewayHeader: "x-gateway-token" });
    const base = compose([rbl]);
    // The source answers the lookup for one id with the record of a different event (a confused or hostile lookup).
    const other = receipt({ id: "evt_someOtherEvent001", status: "FAILED" });
    const router = new IngressRouter({
      profiles: base.registry,
      contracts: contracts(),
      verifier: new InboundVerifier({ credentials: base.credentials, clock }),
      inbox: base.inbox,
      clock,
      metrics: base.metrics,
      lookups: { "cdp.unsigned": { fetch: async () => other } },
    });
    const announced = receipt({ id: "evt_announcedEvent01" });
    const r = await router.handle({ sourceId: "cdp.unsigned", rawBody: announced, header: (n: string) => (n === "x-gateway-token" ? SECRET_OLD : null), peer: null });
    expect(r).toEqual({ status: 401, body: { error: { reasonCode: "INGRESS_LOOKUP_EVENT_MISMATCH" } } });
    expect(await rows()).toEqual([]);
    expect(base.metrics.counterValue("vsp_inbox_events_total", { result: "auth_rejected", auth: "reconcile_by_lookup" })).toBe(1);
  });

  it("[FO-15-50][AUTH-04] JWT lifetime: an expired token is refused, and so is a token without exp or whose remaining lifetime (exp) or age (iat) exceeds maxTokenAgeSeconds; a token inside the bound verifies", async () => {
    const jwtSource = profile("cdp.jwt", { kind: "jwt_bearer", header: "authorization", issuer: "cdp.synthetic", audience: "vsp-ingress", algorithms: ["HS256"], credentials: "local-fixture:livekit/api", jwksUrl: null, bodyHashClaim: null, maxTokenAgeSeconds: 600 });
    const { router } = compose([jwtSource]);
    clock.set(new Date());
    const nowS = Math.floor(clock.now().getTime() / 1000);
    const key = new TextEncoder().encode(SECRET_OLD);
    const token = (iat: number, exp: number) => new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setIssuer("cdp.synthetic").setAudience("vsp-ingress").setJti(newId("jti")).setIssuedAt(iat).setExpirationTime(exp).sign(key);
    const send = async (t: string) => router.handle({ sourceId: "cdp.jwt", rawBody: receipt(), header: (n: string) => (n === "authorization" ? `Bearer ${t}` : null), peer: null });
    expect(await send(await token(nowS - 700, nowS - 100))).toEqual({ status: 401, body: { error: { reasonCode: "INGRESS_TOKEN_INVALID" } } }); // expired
    expect(await send(await token(nowS, nowS + 7200))).toEqual({ status: 401, body: { error: { reasonCode: "INGRESS_TOKEN_LIFETIME_EXCEEDED" } } }); // valid for 2 h
    expect(await send(await token(nowS - 3600, nowS + 60))).toEqual({ status: 401, body: { error: { reasonCode: "INGRESS_TOKEN_LIFETIME_EXCEEDED" } } }); // issued 1 h ago
    // A token without exp would be bounded by nothing but the jti cache: refused, with or without iat.
    const noExp = (iat: number | null) => {
      const t = new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setIssuer("cdp.synthetic").setAudience("vsp-ingress").setJti(newId("jti"));
      return (iat === null ? t : t.setIssuedAt(iat)).sign(key);
    };
    expect(await send(await noExp(null))).toEqual({ status: 401, body: { error: { reasonCode: "INGRESS_TOKEN_INVALID" } } });
    expect(await send(await noExp(nowS))).toEqual({ status: 401, body: { error: { reasonCode: "INGRESS_TOKEN_INVALID" } } });
    expect(await rows()).toEqual([]);
    expect(await send(await token(nowS - 60, nowS + 540))).toMatchObject({ status: 200, body: { decision: "accepted" } });
  });

  it("[FO-07-21][OPS-03] an unknown event type or an undeclared field is quarantined (stored, counted, alarmed), never projected", async () => {
    const { router, metrics, records } = compose();
    const unknownType = Buffer.from(JSON.stringify({ id: "evt_unknownType00001", type: "message.read", occurredAt: iso(clock.now()), version: "1", entity: "msg_x", status: "DELIVERED" }));
    const extraField = Buffer.from(JSON.stringify({ id: "evt_extraField000001", type: "message.delivered", occurredAt: iso(clock.now()), version: "1", entity: "msg_x", status: "DELIVERED", recipientName: "never promoted" }));
    expect((await router.handle(signed(unknownType))).body).toMatchObject({ decision: "quarantined" });
    clock.advanceSeconds(1);
    expect((await router.handle(signed(extraField))).body).toMatchObject({ decision: "quarantined" });
    expect((await rows()).map((r) => [r.status, r.quarantine_reason])).toEqual([
      ["QUARANTINED", "UNKNOWN_EVENT_TYPE"],
      ["QUARANTINED", "UNKNOWN_FIELD"],
    ]);
    expect(metrics.counterValue("vsp_inbox_quarantined_total", { reason: "unknown_event_type" })).toBe(1);
    expect(metrics.counterValue("vsp_inbox_quarantined_total", { reason: "unknown_field" })).toBe(1);
    expect(JSON.stringify(records)).not.toContain("never promoted");
    const proj = await db.tx((tx) => tx.query("select * from inbox_projection_versions"), { role: "owner" });
    expect(proj.rows).toEqual([]);
  });

  it("[FO-07-18][ACT-02][FAULT:DUPLICATE_WEBHOOK] a redelivered event is one inbox row with the duplicate recorded, and one projection effect", async () => {
    const { router, registry, cipher } = compose();
    const body = receipt();
    expect((await router.handle(signed(body))).body).toMatchObject({ decision: "accepted" });
    clock.advanceSeconds(1);
    expect((await router.handle(signed(body))).body).toMatchObject({ decision: "duplicate" });
    const conflicting = Buffer.from(body.toString().replace("DELIVERED", "FAILED"));
    clock.advanceSeconds(1);
    expect((await router.handle(signed(conflicting))).body).toMatchObject({ decision: "duplicate" });
    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0]?.duplicate_count).toBe(2);
    const deliveries = await db.tx((tx) => tx.query<{ duplicate: boolean; digest_matches: boolean }>("select duplicate, digest_matches from inbound_deliveries order by received_at"), { role: "owner" });
    expect(deliveries.rows).toEqual([
      { duplicate: false, digest_matches: true },
      { duplicate: true, digest_matches: true },
      { duplicate: true, digest_matches: false },
    ]);
    let effects = 0;
    const handler: InboxHandler = async () => {
      effects += 1;
      return { projection: { stateDigest: "a".repeat(64) } };
    };
    const processor = new InboxProcessor({ db, cipher, profiles: registry, contracts: contracts(), handlers: { "delivery.receipt@1": handler }, clock, tenants: [TENANT] });
    expect((await processor.runOnce()).processed).toBe(1);
    expect((await processor.runOnce()).processed).toBe(0);
    expect(effects).toBe(1);
  });

  it("[FO-06-97][OPS-01][OPS-03] a poison event retries with bounded backoff, moves to INBOUND_DEAD with a reason code and alarm metric; an audited, MFA-verified replay reprocesses it exactly once; a replay whose audit write fails is refused", async () => {
    const { router, registry, cipher, metrics } = compose();
    await router.handle(signed(receipt()));
    let fail = true;
    let effects = 0;
    const handler: InboxHandler = async () => {
      if (fail) throw Object.assign(new Error("synthetic downstream failure"), { reasonCode: "SYNTHETIC_HANDLER_FAILURE" });
      effects += 1;
      return { projection: null };
    };
    const processor = new InboxProcessor({ db, cipher, profiles: registry, contracts: contracts(), handlers: { "delivery.receipt@1": handler }, clock, tenants: [TENANT], random: () => 0.5, metrics });
    expect(await processor.runOnce()).toMatchObject({ retried: 1 });
    const due1 = new Date((await rows())[0]?.next_attempt_at as Date | string).getTime() - clock.now().getTime();
    expect(due1).toBeGreaterThanOrEqual(500);
    expect(await processor.runOnce()).toMatchObject({ retried: 0, processed: 0 }); // not due yet: backoff respected
    clock.advanceSeconds(10);
    expect(await processor.runOnce()).toMatchObject({ retried: 1 });
    clock.advanceSeconds(10);
    expect(await processor.runOnce()).toMatchObject({ deadLettered: 1 });
    expect((await rows())[0]).toMatchObject({ status: "INBOUND_DEAD", dead_reason: "INBOX_HANDLER_FAILED", attempts: 3 });
    expect(metrics.counterValue("vsp_inbox_dead_letter_total")).toBe(1);

    const replay = new InboxReplayService({ db, audit: new PgAuditWriter({ db, clock, stream: "console.replay-test", standaloneRole: "app_console" }), clock, metrics });
    const inboxId = String((await rows())[0]?.inbox_id);
    const operator = { staffRef: "stf_synthSupervisor01", mfaVerifiedAt: iso(clock.now()), reasonCode: "HANDLER_DEFECT_FIXED" };
    await expect(replay.replay({ tenantId: TENANT, inboxId, operator: { ...operator, reasonCode: "BECAUSE_I_SAID_SO" } })).rejects.toThrow("INBOX_REPLAY_REASON_NOT_ALLOWED");
    // An operator ref the audit record could not carry (shorter than the opaque-id grammar) is a policy refusal.
    await expect(replay.replay({ tenantId: TENANT, inboxId, operator: { ...operator, staffRef: "stf_short123" } })).rejects.toThrow("INBOX_REPLAY_OPERATOR_INVALID");
    await expect(replay.replay({ tenantId: TENANT, inboxId, operator: { ...operator, mfaVerifiedAt: iso(new Date(clock.now().getTime() - 3_600_000)) } })).rejects.toThrow("INBOX_REPLAY_MFA_REQUIRED");
    await db.exec("revoke insert on audit_outbox from app_console");
    await expect(replay.replay({ tenantId: TENANT, inboxId, operator })).rejects.toThrow();
    expect((await rows())[0]?.status).toBe("INBOUND_DEAD");
    expect(metrics.counterValue("vsp_inbox_replays_total", { result: "refused_audit" })).toBe(1);
    await db.exec("grant insert on audit_outbox to app_console");
    const done = await replay.replay({ tenantId: TENANT, inboxId, operator });
    expect(done.priorStatus).toBe("INBOUND_DEAD");
    fail = false;
    expect((await processor.runOnce()).processed).toBe(1);
    expect((await processor.runOnce()).processed).toBe(0);
    expect(effects).toBe(1);
    const audit = await db.tx((tx) => tx.query<{ action: string }>("select action from audit_outbox where action = 'inbox.replay'"), { role: "owner" });
    expect(audit.rows).toHaveLength(1);
  });

  it("[FO-06-97][AUTH-02][OPS-01] replay policy: an MFA time in the future is refused, and an event replayed maxReplays times is refused (INBOX_REPLAY_LIMIT_REACHED) with nothing changed or audited", async () => {
    const { router, registry, cipher, metrics } = compose();
    const unknownType = Buffer.from(JSON.stringify({ id: "evt_replayLimit000001", type: "message.read", occurredAt: iso(clock.now()), version: "1", entity: "msg_x", status: "DELIVERED" }));
    expect((await router.handle(signed(unknownType))).body).toMatchObject({ decision: "quarantined" });
    const inboxId = String((await rows())[0]?.inbox_id);
    const replay = new InboxReplayService({ db, audit: new PgAuditWriter({ db, clock, stream: "console.replay-limit-test", standaloneRole: "app_console" }), clock, metrics, maxReplays: 1 });
    const operator = { staffRef: "stf_synthSupervisor01", mfaVerifiedAt: iso(clock.now()), reasonCode: "CONTRACT_UPDATED" };
    // A verification time ahead of the server clock (forged or skewed) is not a fresh MFA.
    await expect(replay.replay({ tenantId: TENANT, inboxId, operator: { ...operator, mfaVerifiedAt: iso(new Date(clock.now().getTime() + 60_000)) } })).rejects.toThrow("INBOX_REPLAY_MFA_REQUIRED");
    expect(metrics.counterValue("vsp_inbox_replays_total", { result: "refused_policy" })).toBe(1);
    expect((await replay.replay({ tenantId: TENANT, inboxId, operator })).priorStatus).toBe("QUARANTINED");
    // The contract is still unknown: processing quarantines it again.
    expect(await new InboxProcessor({ db, cipher, profiles: registry, contracts: contracts(), handlers: {}, clock, tenants: [TENANT] }).runOnce()).toMatchObject({ quarantined: 1 });
    clock.advanceSeconds(60);
    await expect(replay.replay({ tenantId: TENANT, inboxId, operator: { ...operator, mfaVerifiedAt: iso(clock.now()) } })).rejects.toThrow("INBOX_REPLAY_LIMIT_REACHED");
    expect(metrics.counterValue("vsp_inbox_replays_total", { result: "refused_state" })).toBe(1);
    expect((await rows())[0]).toMatchObject({ status: "QUARANTINED", replay_count: 1 });
    const replays = await db.tx((tx) => tx.query("select replay_id from inbound_replays"), { role: "owner" });
    expect(replays.rows).toHaveLength(1);
    const audited = await db.tx((tx) => tx.query("select event_id from audit_outbox where action = 'inbox.replay'"), { role: "owner" });
    expect(audited.rows).toHaveLength(1);
  });

  it("[FO-07-17][FO-07-19][OPS-01] a decrypted payload whose digest is not the recorded one (a defective or substituted cipher) is never processed: INBOUND_DEAD at once with INBOX_PAYLOAD_DIGEST_MISMATCH", async () => {
    const { router, registry, cipher, metrics } = compose();
    await router.handle(signed(receipt()));
    // LOCAL TEST DOUBLE of the PayloadCipher port: decrypts, then returns other bytes than the sealed ones.
    const substituted = { kind: cipher.kind, encrypt: cipher.encrypt.bind(cipher), decrypt: async (...a: Parameters<typeof cipher.decrypt>) => Buffer.concat([await cipher.decrypt(...a), Buffer.from(" ")]) };
    let effects = 0;
    const processor = new InboxProcessor({
      db,
      cipher: substituted,
      profiles: registry,
      contracts: contracts(),
      handlers: { "delivery.receipt@1": async () => ((effects += 1), { projection: null }) },
      clock,
      tenants: [TENANT],
      metrics,
    });
    expect(await processor.runOnce()).toMatchObject({ deadLettered: 1, processed: 0, retried: 0 });
    expect(effects).toBe(0);
    expect((await rows())[0]).toMatchObject({ status: "INBOUND_DEAD", dead_reason: "INBOX_PAYLOAD_DIGEST_MISMATCH", attempts: 1 });
    expect(metrics.counterValue("vsp_inbox_dead_letter_total")).toBe(1);
  });

  it("[FO-07-22][DATA-02] raw payloads live only as ciphertext in the restricted columns: the gateway and console roles cannot read them; retention purges them after processing, never before", async () => {
    const { router, registry, cipher, inbox } = compose([hmacProfile()]);
    await router.handle(signed(receipt()));
    const reason = (p: Promise<unknown>) => p.then(() => "RESOLVED", (e: Error) => e.message);
    expect(await reason(db.tx((tx) => tx.query("select payload_ciphertext from inbound_events"), { role: "app_runtime", rls: { tenantId: TENANT } }))).toContain("permission denied");
    expect(await reason(db.tx((tx) => tx.query("select payload_ciphertext from inbound_events"), { role: "app_console", rls: { tenantId: TENANT } }))).toContain("permission denied");
    const processor = new InboxProcessor({ db, cipher, profiles: registry, contracts: contracts(), handlers: {}, clock, tenants: [TENANT] });
    await processor.runOnce();
    expect(await inbox.purgeExpiredPayloads(TENANT)).toEqual({ purged: 0, held: 0, reasonCode: null }); // retention not expired yet
    // A second event is received but not processed (no worker ran) before its retention expires.
    clock.advanceSeconds(1);
    const pendingBody = receipt();
    await router.handle(signed(pendingBody));
    clock.advanceSeconds(31 * 86_400);
    expect(await inbox.purgeExpiredPayloads(TENANT)).toEqual({ purged: 1, held: 0, reasonCode: null });
    const [row, pending] = await rows();
    expect(row).toMatchObject({ payload_ciphertext: null, status: "PROCESSED" });
    expect(row?.payload_digest).toMatch(/^[a-f0-9]{64}$/);
    // The unprocessed event keeps its payload past retention: purging it would make it unprocessable.
    expect(pending).toMatchObject({ status: "RECEIVED", raw_purged_at: null });
    expect(pending?.payload_ciphertext).not.toBeNull();
    expect(await processor.runOnce()).toMatchObject({ processed: 1 });
    expect(await inbox.purgeExpiredPayloads(TENANT)).toEqual({ purged: 1, held: 0, reasonCode: null });
    expect((await rows()).every((r) => r.payload_ciphertext === null && r.status === "PROCESSED")).toBe(true);
  });

  it("[FO-07-22][DATA-03] a legal hold keeps raw payloads past their retention (record, dataset and tenant scope, any data class; a subject-scoped hold holds them all); after the release they are purged", async () => {
    const { router, registry, cipher, inbox } = compose([hmacProfile()]);
    for (let i = 0; i < 3; i++) await router.handle(signed(receipt()));
    await new InboxProcessor({ db, cipher, profiles: registry, contracts: contracts(), handlers: {}, clock, tenants: [TENANT] }).runOnce();
    const ids = (await rows()).map((r) => String(r.inbox_id));
    const holds = new LegalHoldStorePg({ db, clock });
    const admin = { staffId: STAFF.securityAdmin.staffId, roles: [...STAFF.securityAdmin.roles], mfa: true, authenticatedAt: iso(clock.now()), breakGlass: null };
    const matterRef = newId("mtr");
    clock.advanceSeconds(31 * 86_400);
    // A record-scoped hold on one payload, with a data class: it still applies (a raw payload can hold any class).
    const recordHold = await holds.place({ tenantId: TENANT, dataClass: "BUSINESS_RECORD", dataset: INBOUND_RAW_PAYLOAD_DATASET, recordKey: ids[0], matterRef, reasonCode: "LITIGATION_HOLD", staff: admin });
    // A hold scoped to another dataset does not apply.
    await holds.place({ tenantId: TENANT, dataset: "support_memory", matterRef, reasonCode: "LITIGATION_HOLD", staff: admin });
    // A subject-scoped hold cannot be resolved per inbound row: nothing of the tenant is purged while it is active.
    const subjectHold = await holds.place({ tenantId: TENANT, subjectId: PEOPLE.avery.subjectId, matterRef, reasonCode: "LITIGATION_HOLD", staff: admin });
    expect(await inbox.purgeExpiredPayloads(TENANT)).toEqual({ purged: 0, held: 3, reasonCode: "LEGAL_HOLD_SUBJECT_SCOPE_UNRESOLVABLE" });
    await holds.release({ tenantId: TENANT, holdId: subjectHold.holdId, reasonCode: "MATTER_CLOSED", staff: admin });
    expect(await inbox.purgeExpiredPayloads(TENANT)).toEqual({ purged: 2, held: 1, reasonCode: "LEGAL_HOLD_ACTIVE" });
    const kept = (await rows()).filter((r) => r.payload_ciphertext !== null).map((r) => r.inbox_id);
    expect(kept).toEqual([ids[0]]);
    // A tenant-wide hold (no scope) keeps it too; once every hold is released it is purged.
    const tenantHold = await holds.place({ tenantId: TENANT, matterRef, reasonCode: "REGULATOR_REQUEST", staff: admin });
    await holds.release({ tenantId: TENANT, holdId: recordHold.holdId, reasonCode: "MATTER_CLOSED", staff: admin });
    expect(await inbox.purgeExpiredPayloads(TENANT)).toEqual({ purged: 0, held: 1, reasonCode: "LEGAL_HOLD_ACTIVE" });
    await holds.release({ tenantId: TENANT, holdId: tenantHold.holdId, reasonCode: "MATTER_CLOSED", staff: admin });
    expect(await inbox.purgeExpiredPayloads(TENANT)).toEqual({ purged: 1, held: 0, reasonCode: null });
    expect((await rows()).every((r) => r.payload_ciphertext === null && /^[a-f0-9]{64}$/.test(String(r.payload_digest)))).toBe(true);
  });

  it("[FO-07-16] the Fastify ingress plugin verifies over the exact raw bytes it received (HTTP inject)", async () => {
    const { router } = compose();
    const app = fastify();
    await app.register(ingressPlugin, { router });
    const body = receipt();
    const s = signed(body);
    const res = await app.inject({
      method: "POST",
      url: "/v1/ingress/receipts.synthetic/events",
      payload: body,
      headers: { "content-type": "application/json", "x-synthetic-signature": String(s.header("x-synthetic-signature")), "x-synthetic-timestamp": String(s.header("x-synthetic-timestamp")) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accepted: true, decision: "accepted" });
    const bad = await app.inject({ method: "POST", url: "/v1/ingress/receipts.synthetic/events", payload: body, headers: { "content-type": "application/json" } });
    expect(bad.statusCode).toBe(401);
    expect(bad.json()).toMatchObject({ error: { reasonCode: "INGRESS_SIGNATURE_MISSING" } });
    await app.close();
  });
});

/** Inserts a minimal inbox row (the projection references its inbox row). Owner role, test setup only. */
async function seedInboxRow(tx: import("../db/types.js").Queryable, inboxId: string, eventId: string): Promise<void> {
  await tx.query(
    `insert into inbound_events (inbox_id, tenant_id, source_id, event_id, received_at, payload_digest, payload_bytes, payload_ciphertext, encrypted_data_key,
       payload_key_ref, payload_iv, payload_tag, cipher_kind, raw_retain_until, auth_mechanism, status, next_attempt_at, updated_at)
     values ($1, $2, 'receipts.synthetic', $3 || ':' || $1, now(), $4, 0, '\\x00', '\\x00', 'local-fixture:inbox-key', '\\x00', '\\x00', 'local_fixture',
       now() + interval '1 day', 'HMAC_SHA256_HEADER', 'RECEIVED', now(), now())
     on conflict (inbox_id) do nothing`,
    [inboxId, TENANT, eventId, "c".repeat(64)],
  );
}

describe("source-version ordering (FO-07-20)", () => {
  it("[FO-07-20][ACT-02] any permutation of duplicated, reordered and clock-skewed events converges to the source-version-ordered state", async () => {
    const event = fc.record({ version: fc.integer({ min: 0, max: 20 }), skewSeconds: fc.integer({ min: -3600, max: 3600 }), n: fc.integer({ min: 0, max: 5 }) });
    await fc.assert(
      fc.asyncProperty(fc.array(event, { minLength: 1, maxLength: 12 }), fc.integer({ min: 0, max: 1_000_000 }), async (events, seed) => {
        const facts = events.map((e, i) => ({
          tenantId: TENANT,
          sourceId: "receipts.synthetic",
          entityKey: `ent_${seed}`,
          sourceVersion: String(e.version),
          occurredAt: iso(new Date(Date.parse("2026-10-19T12:00:00.000Z") + e.skewSeconds * 1000)),
          eventId: `evt_${e.version}_${e.n}_${i % 3}`,
          inboxId: `inb_${String(seed).padStart(8, "0")}${String(i).padStart(8, "0")}`,
          stateDigest: createHash("sha256").update(`${e.version}:${e.n}:${i % 3}`).digest("hex"),
        }));
        const expected = [...facts].sort(compareOrderKeys).at(-1);
        // Arrival order: a seeded shuffle with every event delivered once or twice.
        const deliveries = [...facts, ...facts.filter((_, i) => (i + seed) % 2 === 0)];
        for (let i = deliveries.length - 1; i > 0; i--) {
          const j = (seed * 31 + i * 17) % (i + 1);
          [deliveries[i], deliveries[j]] = [deliveries[j] as (typeof deliveries)[number], deliveries[i] as (typeof deliveries)[number]];
        }
        await db.tx(async (tx) => {
          for (const f of facts) await seedInboxRow(tx, f.inboxId, f.eventId);
          for (const f of deliveries) await applySourceVersioned(tx, f, clock);
        }, { role: "owner" });
        const state = await db.tx((tx) => tx.query<{ event_id: string; state_digest: string }>("select event_id, state_digest from inbox_projection_versions where entity_key = $1", [`ent_${seed}`]), { role: "owner" });
        expect(state.rows[0]).toEqual({ event_id: expected?.eventId, state_digest: expected?.stateDigest });
        await db.exec(`alter table inbox_projection_versions disable trigger inbox_projection_versions_no_delete; delete from inbox_projection_versions; alter table inbox_projection_versions enable trigger inbox_projection_versions_no_delete`);
      }),
      { numRuns: 60 },
    );
  });

  it("[FO-07-20] the table refuses a version regression even from a caller that bypasses the ordering function", async () => {
    await db.tx((tx) => seedInboxRow(tx, "inb_0000000000000005", "evt_5"), { role: "owner" });
    await db.tx((tx) => applySourceVersioned(tx, { tenantId: TENANT, sourceId: "receipts.synthetic", entityKey: "ent_x", sourceVersion: "5", occurredAt: null, eventId: "evt_5", inboxId: "inb_0000000000000005", stateDigest: "b".repeat(64) }, clock), { role: "owner" });
    await expect(db.exec("update inbox_projection_versions set source_version = 4 where entity_key = 'ent_x'")).rejects.toThrow("INBOX_PROJECTION_VERSION_REGRESSION");
  });
});

/** LOCAL TEST DOUBLE of a stream (the Kinesis adapter's protocol run needs the Kinesis client and emulator). */
class StreamSourceFixture implements StreamSource {
  readonly kind = "local_fixture" as const;
  readonly records: StreamRecord[] = [];
  async partitions(): Promise<string[]> {
    return ["shardId-000000000000"];
  }
  async read(partition: string, after: string | null, limit: number) {
    const recs = this.records.filter((r) => r.partition === partition && (after === null || BigInt(r.position) > BigInt(after))).slice(0, limit);
    return { records: recs, highPosition: this.records.at(-1)?.position ?? null, closed: false };
  }
}

describe("stream ingestion (FO-03-26, FO-06-97)", () => {
  it("[FO-03-26][FO-06-97][ACT-02] records are persisted before the checkpoint moves; a re-read is absorbed as a duplicate; a quarantined record is an open gap of the watermark", async () => {
    const sp = profile("stream.synthetic", { kind: "stream_iam" });
    const { registry, cipher, audit, metrics } = compose([sp]);
    const inbox = new PgInbox({ db, cipher, audit, clock, role: "app_worker", auditStream: "worker.stream-test" });
    const source = new StreamSourceFixture();
    const p = registry.get("stream.synthetic") as SourceProfile;
    source.records.push({ partition: "shardId-000000000000", position: "49590000000000000000000000000000000000001", data: receipt() });
    source.records[0] = { ...source.records[0] as StreamRecord, position: "100" };
    source.records.push({ partition: "shardId-000000000000", position: "200", data: Buffer.from(JSON.stringify({ id: "evt_streamUnknown001", type: "message.bounced", occurredAt: iso(clock.now()), version: "1", entity: "e", status: "x" })) });
    const ing = new StreamIngestor({ db, inbox, source, profile: p, contracts: contracts(), clock, metrics });
    expect(await ing.runOnce()).toMatchObject({ partitions: 1, accepted: 1, quarantined: 1, duplicates: 0, stopped: 0 });
    const cp = await db.tx((tx) => tx.query<{ committed: string; open_gaps: number }>("select committed_position::text as committed, open_gaps from inbox_stream_checkpoints"), { role: "owner" });
    expect(cp.rows[0]).toEqual({ committed: "200", open_gaps: 1 });
    expect(metrics.gaugeValue("vsp_inbox_stream_open_gaps")).toBe(1);
    // The checkpoint can never move backwards (a backfill never rolls back a newer position).
    await expect(db.exec("update inbox_stream_checkpoints set committed_position = 100")).rejects.toThrow("INBOX_CHECKPOINT_REGRESSION");
  });

  it("[FO-03-26][ACT-02] a crash after the inbox commit and before the checkpoint write re-reads the record, which the inbox absorbs as a duplicate", async () => {
    const sp = profile("stream.synthetic", { kind: "stream_iam" });
    const { registry, cipher, audit } = compose([sp]);
    const inbox = new PgInbox({ db, cipher, audit, clock, role: "app_worker", auditStream: "worker.stream-test" });
    const source = new StreamSourceFixture();
    source.records.push({ partition: "shardId-000000000000", position: "7", data: receipt() });
    let crash = true;
    // LOCAL TEST DOUBLE: the real PGlite database, except the first checkpoint write "crashes" the process.
    const crashingDb: import("../db/types.js").Db = {
      engine: "pglite",
      query: (sql, params) => db.query(sql, params),
      exec: (sql) => db.exec(sql),
      close: () => Promise.resolve(),
      tx: (fn, opts) =>
        db.tx(
          (tx) =>
            fn({
              query: async (sql, params) => {
                if (crash && sql.includes("insert into inbox_stream_checkpoints")) {
                  crash = false;
                  throw new Error("synthetic crash before the checkpoint write");
                }
                return tx.query(sql, params);
              },
              exec: (sql) => tx.exec(sql),
            }),
          opts,
        ),
    };
    const p = registry.get("stream.synthetic") as SourceProfile;
    await expect(new StreamIngestor({ db: crashingDb, inbox, source, profile: p, contracts: contracts(), clock }).runOnce()).rejects.toThrow("synthetic crash");
    expect(await rows()).toHaveLength(1); // persisted before the crash
    const restarted = new StreamIngestor({ db, inbox, source, profile: p, contracts: contracts(), clock });
    expect(await restarted.runOnce()).toMatchObject({ accepted: 0, duplicates: 1 });
    expect(await rows()).toHaveLength(1);
    const cp = await db.tx((tx) => tx.query<{ committed: string }>("select committed_position::text as committed from inbox_stream_checkpoints"), { role: "owner" });
    expect(cp.rows[0]?.committed).toBe("7");
  });

  it("[FO-03-26][OPS-03] a record that cannot be persisted stops its partition without moving the checkpoint", async () => {
    const sp = profile("stream.synthetic", { kind: "stream_iam" });
    const { registry, cipher } = compose([sp]);
    const failingAudit = { append: async () => Promise.reject(Object.assign(new Error("x"), { reasonCode: "AUDIT_STORE_UNWRITABLE" })), appendStandalone: async () => Promise.reject(new Error("x")) };
    const inbox = new PgInbox({ db, cipher, audit: failingAudit, clock, role: "app_worker" });
    const source = new StreamSourceFixture();
    source.records.push({ partition: "shardId-000000000000", position: "1", data: receipt() });
    const ing = new StreamIngestor({ db, inbox, source, profile: registry.get("stream.synthetic") as SourceProfile, contracts: contracts(), clock });
    expect(await ing.runOnce()).toMatchObject({ stopped: 1, accepted: 0 });
    const cp = await db.tx((tx) => tx.query("select * from inbox_stream_checkpoints"), { role: "owner" });
    expect(cp.rows).toEqual([]);
  });

  it("[FO-07-21] classification never trusts a missing id: an unparseable payload gets a digest identity and is quarantined", () => {
    const p = new SourceProfileRegistry([hmacProfile()]).get("receipts.synthetic") as SourceProfile;
    const c = classify(Buffer.from("not json"), p, contracts());
    expect(c.quarantine).toBe("PAYLOAD_UNPARSEABLE");
    expect(c.eventId).toMatch(/^digest:[a-f0-9]{64}$/);
  });
});
