/**
 * Layer 2 (WP-04): the authenticated inbound inbox over real HTTP and TLS sockets (FO-07-16..19, FO-06-98,
 * FO-15-50, FO-03-21; ACT-02, AUTH-04 at this boundary). The production Fastify plugin and IngressRouter
 * listen on loopback; payloads are sealed with data keys from LocalStack KMS; source credentials and their
 * rotation come from LocalStack Secrets Manager; the inbox is postgres:16 provisioned as on Aurora.
 *  - authenticate before persistence, persist (encrypted) before acknowledgement; a store that cannot be
 *    written is a 503 and nothing is acknowledged; the sender's retry is accepted once;
 *  - credential rotation: old and new secrets verify only inside the overlap window; a pending secret only
 *    when the profile accepts it; the verifying version is recorded per event;
 *  - mTLS: the client certificate's chain (socket) and its pinned fingerprint;
 *  - [FAULT:DUPLICATE_WEBHOOK]: concurrent redeliveries of one event id, and an SQS redelivery of the
 *    outbox message it produced, give one row, one effect, and recorded duplicates; and a DETERMINISTIC race:
 *    two replicas held at the same point inside the accept transaction (acceptRaceBarrier) are serialized by the
 *    per-event accept lock, so both answer 200 (accepted + recorded duplicate), never a 503.
 */
import { execFileSync } from "node:child_process";
import { X509Certificate, createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import { CreateQueueCommand, GetQueueAttributesCommand, ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { PgOutboxDispatcher } from "../../../src/outbox/dispatcher.js";
import { PgConsumerDedup } from "../../../src/outbox/consumer-dedup.js";
import { PgOutbox } from "../../../src/outbox/outbox.js";
import { SqsPublisher } from "../../../src/outbox/sqs-publisher.js";
import { FakeClock, systemClock } from "../../../src/shared/clock.js";
import { newId } from "../../../src/shared/ids.js";
import { awsQueueUrl, secretsClient, sqsClient, uniqueName } from "../_harness/clients.js";
import { layer2, layer2Context } from "../_harness/layer2.js";
import { scratchDir } from "../_harness/scratch.js";
import { readOnlyDatabase } from "../substrate/seams.js";
import { createAuroraLikeDb, sleep } from "../substrate/support.js";
import type { AuroraLikeDb } from "../substrate/support.js";
import { CreateSecretCommand, UpdateSecretVersionStageCommand } from "@aws-sdk/client-secrets-manager";
import { SignJWT } from "jose";
import { HMAC_SOURCE, MTLS_SOURCE, acceptRaceBarrier, hmacSecret, hmacVerifier, ingressStack, kmsInboxKey, profile, receipt, rotate, serve, signHeaders } from "./support.js";

const it = layer2(["postgres", "localstack", "elasticmq"]);
let adb: AuroraLikeDb;
let kmsKey: string;

async function post(url: string, body: Buffer, headers: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`${url}/v1/ingress/${HMAC_SOURCE}/events`, { method: "POST", body, headers });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

async function inboxRows(tenantId: string) {
  const r = await adb.db.tx(
    (tx) =>
      tx.query<{ inbox_id: string; event_id: string; status: string; credential_version: string | null; auth_mechanism: string; cipher_kind: string; duplicate_count: number; payload_ciphertext: Buffer; payload_digest: string }>(
        "select inbox_id, event_id, status, credential_version, auth_mechanism, cipher_kind, duplicate_count, payload_ciphertext, payload_digest from inbound_events order by received_at, inbox_id",
      ),
    { role: "app_worker", rls: { tenantId } },
  );
  return r.rows;
}

describe("inbound inbox over HTTP/TLS with KMS and Secrets Manager", () => {
  beforeAll(async () => {
    const l2 = layer2Context(["postgres", "localstack", "elasticmq"]);
    adb = await createAuroraLikeDb(l2);
    kmsKey = await kmsInboxKey(l2);
  });
  afterAll(async () => {
    await adb?.drop();
  });

  it("[FO-07-16][FO-07-17][FO-07-19][OPS-01] a signed event is authenticated, sealed with a KMS data key and audited before the 200; a bad signature is refused and stores nothing; an identical replayed request is a recorded duplicate", async ({ l2 }) => {
    const tenantId = newId("tnt");
    const { arn, key } = await hmacSecret(l2);
    const stack = ingressStack(l2, adb.db, systemClock, kmsKey, [profile(tenantId, HMAC_SOURCE, hmacVerifier(arn))]);
    const { app, url } = await serve(stack.router);
    try {
      const body = receipt(systemClock);
      const headers = signHeaders(body, key, systemClock);
      const ok = await post(url, body, headers);
      expect(ok).toMatchObject({ status: 200, body: { accepted: true, decision: "accepted" } });
      const [row] = await inboxRows(tenantId);
      expect(row).toMatchObject({ status: "RECEIVED", auth_mechanism: "HMAC_SHA256_HEADER", cipher_kind: "live", payload_digest: createHash("sha256").update(body).digest("hex") });
      const meta = await adb.db.tx((tx) => tx.query<{ schema_id: string; schema_version: string }>("select schema_id, schema_version from inbound_events"), { role: "app_console", rls: { tenantId } });
      expect(meta.rows).toEqual([{ schema_id: "delivery.receipt", schema_version: "1" }]);
      expect(row?.credential_version).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
      expect(row?.payload_ciphertext.includes(body)).toBe(false);
      // The processor's decryption (KMS Decrypt with the same encryption context) returns the exact bytes.
      const seen: string[] = [];
      await stack.processor(adb.db, { "delivery.receipt@1": async (_tx, ev) => (seen.push(ev.eventId), { projection: null }) }).runOnce();
      expect(seen).toEqual([JSON.parse(body.toString()).id]);
      // Adversarial: wrong key; the identical captured request replayed is authentic, recorded and applied once.
      const forged = receipt(systemClock);
      expect((await post(url, forged, signHeaders(forged, Buffer.alloc(32, 7), systemClock))).status).toBe(401);
      expect(await post(url, body, headers)).toMatchObject({ status: 200, body: { decision: "duplicate", inboxId: row?.inbox_id } });
      expect((await inboxRows(tenantId))[0]?.duplicate_count).toBe(1);
      // Payload limit and timestamp window (FO-15-50).
      const big = Buffer.from(JSON.stringify({ ...JSON.parse(receipt(systemClock).toString()), entity: "x".repeat(5000) }));
      expect((await post(url, big, signHeaders(big, key, systemClock))).status).toBe(413);
      const stale = receipt(systemClock);
      expect(await post(url, stale, signHeaders(stale, key, new FakeClock(new Date(Date.now() - 600_000))))).toMatchObject({ status: 401, body: { error: { reasonCode: "INGRESS_TIMESTAMP_INVALID" } } });
      expect(await inboxRows(tenantId)).toHaveLength(1);
      const audited = await adb.db.tx((tx) => tx.query("select 1 from audit_outbox where tenant_id = app_tenant() and action = 'ingress.event.accepted'"), { role: "app_worker", rls: { tenantId } });
      expect(audited.rows).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("[FO-07-17][OPS-01] persist before acknowledge: while the inbox cannot be written the sender gets 503 and nothing is acknowledged; its retry is accepted once", async ({ l2 }) => {
    const tenantId = newId("tnt");
    const { arn, key } = await hmacSecret(l2);
    const undo = await readOnlyDatabase(l2, adb);
    const roPool = adb.pool(2);
    const roStack = ingressStack(l2, roPool, systemClock, kmsKey, [profile(tenantId, HMAC_SOURCE, hmacVerifier(arn))]);
    const ro = await serve(roStack.router);
    const body = receipt(systemClock);
    try {
      const refused = await post(ro.url, body, signHeaders(body, key, systemClock));
      expect(refused.status).toBe(503);
      expect(refused.body).not.toHaveProperty("accepted");
    } finally {
      await ro.app.close();
      await roPool.close();
      await undo();
    }
    expect(await inboxRows(tenantId)).toEqual([]);
    const stack = ingressStack(l2, adb.pool(2), systemClock, kmsKey, [profile(tenantId, HMAC_SOURCE, hmacVerifier(arn))]);
    const { app, url } = await serve(stack.router);
    try {
      await sleep(1_100); // the sender's retry carries a new timestamp and signature
      expect((await post(url, body, signHeaders(body, key, systemClock))).body).toMatchObject({ decision: "accepted" });
      expect(await inboxRows(tenantId)).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("[FO-06-98][FO-15-50][AUTH-04] rotation through Secrets Manager without a restart: old and new keys both verify inside the overlap window only; a pending key only when accepted; the verifying version is recorded", async ({ l2 }) => {
    const tenantId = newId("tnt");
    const { arn, key: k1 } = await hmacSecret(l2);
    const clock = new FakeClock(new Date());
    const stack = ingressStack(l2, adb.db, clock, kmsKey, [profile(tenantId, HMAC_SOURCE, hmacVerifier(arn), { rotationOverlapSeconds: 600 })]);
    const { app, url } = await serve(stack.router);
    try {
      const k2 = Buffer.alloc(32, 0x42);
      const send = async (key: Buffer) => {
        const b = receipt(clock);
        return post(url, b, signHeaders(b, key, clock));
      };
      const versionOf = async (r: { body: Record<string, unknown> }) =>
        (await inboxRows(tenantId)).find((x) => x.inbox_id === r.body.inboxId)?.credential_version ?? null;
      const before = await send(k1);
      expect(before.status).toBe(200);
      const v1 = await versionOf(before);
      expect((await send(k2)).status, "the next key is not valid before rotation").toBe(401);
      const v2 = await rotate(l2, arn, { key: k2.toString("base64") });
      expect(v2).not.toBe(v1);
      // Inside the overlap window: both verify, each recorded with the version that verified it.
      const old = await send(k1);
      const next = await send(k2);
      expect([old.status, next.status]).toEqual([200, 200]);
      expect(await versionOf(old)).toBe(v1);
      expect(await versionOf(next)).toBe(v2);
      // After the overlap window: only the current key verifies.
      clock.advanceSeconds(601);
      expect((await send(k1)).status).toBe(401);
      expect((await send(k2)).status).toBe(200);
      // A staged (AWSPENDING) key verifies only for a profile that accepts the pending credential.
      const k3 = Buffer.alloc(32, 0x43);
      await rotate(l2, arn, { key: k3.toString("base64") }, "AWSPENDING");
      expect((await send(k3)).status).toBe(401);
      const accepting = ingressStack(l2, adb.db, clock, kmsKey, [profile(tenantId, HMAC_SOURCE, hmacVerifier(arn), { rotationOverlapSeconds: 600, acceptPendingCredential: true })]);
      const srv2 = await serve(accepting.router);
      try {
        const b = receipt(clock);
        expect((await post(srv2.url, b, signHeaders(b, k3, clock))).status).toBe(200);
      } finally {
        await srv2.app.close();
      }
    } finally {
      await app.close();
    }
  });

  it("[FO-06-98][FO-15-50][AUTH-04] a next key staged as AWSPENDING long before its promotion: the old key verifies for the full overlap counted from the PROMOTION (UpdateSecretVersionStage), at every replica and after a restart, and is refused after it", async ({ l2 }) => {
    const tenantId = newId("tnt");
    const { arn, key: k1 } = await hmacSecret(l2);
    const overlap = 3600;
    const clock = new FakeClock(new Date());
    const profiles = [profile(tenantId, HMAC_SOURCE, hmacVerifier(arn), { rotationOverlapSeconds: overlap })];
    const replicaA = ingressStack(l2, adb.pool(2), clock, kmsKey, profiles);
    const a = await serve(replicaA.router);
    const send = async (url: string, k: Buffer) => {
      const b = receipt(clock);
      const r = await post(url, b, signHeaders(b, k, clock));
      const version = r.status === 200 ? ((await inboxRows(tenantId)).find((x) => x.inbox_id === r.body.inboxId)?.credential_version ?? null) : null;
      return { status: r.status, version };
    };
    try {
      const before = await send(a.url, k1);
      expect(before.status).toBe(200);
      const v1 = before.version;
      // The next key is staged two hours (twice the overlap) before the rotation finishes.
      const k2 = Buffer.alloc(32, 0x52);
      const v2 = await rotate(l2, arn, { key: k2.toString("base64") }, "AWSPENDING");
      clock.advanceSeconds(2 * overlap);
      expect(await send(a.url, k1), "the old key is still the current one").toMatchObject({ status: 200, version: v1 });
      expect((await send(a.url, k2)).status, "a pending key does not verify for this profile").toBe(401);
      // The rotation finishes: AWSCURRENT moves to the staged version (the old one becomes AWSPREVIOUS).
      await secretsClient(l2).send(new UpdateSecretVersionStageCommand({ SecretId: arn, VersionStage: "AWSCURRENT", MoveToVersionId: v2, RemoveFromVersionId: v1 ?? undefined }));
      clock.advanceSeconds(30);
      expect(await send(a.url, k2)).toMatchObject({ status: 200, version: v2 });
      expect(await send(a.url, k1), "inside the overlap after the promotion").toMatchObject({ status: 200, version: v1 });
      const promoted = await adb.db.tx((tx) => tx.query<{ basis: string }>("select anchor_basis as basis from ingress_credential_promotions where credential_ref = $1 and version_id = $2", [arn, v2]), { role: "app_runtime" });
      expect(promoted.rows).toEqual([{ basis: "WITNESSED" }]);
      // Another replica (and a restarted process) reads the same durable anchor.
      clock.advanceSeconds(overlap - 120);
      const stackB = ingressStack(l2, adb.pool(2), clock, kmsKey, profiles);
      const replicaB = await serve(stackB.router);
      try {
        expect(await send(replicaB.url, k1), "still inside the window at a fresh replica").toMatchObject({ status: 200, version: v1 });
        clock.advanceSeconds(121); // one second past anchor + overlap (the anchor is the first observation, 30 s after the promotion)
        expect((await send(replicaB.url, k1)).status, "after the overlap the old key is refused").toBe(401);
        expect((await send(a.url, k1)).status).toBe(401);
        expect(await send(replicaB.url, k2)).toMatchObject({ status: 200, version: v2 });
      } finally {
        await replicaB.app.close();
      }
      // Both replicas logged their acceptances and refusals (with the verifying version), never key material.
      const logged = [...replicaA.records, ...stackB.records];
      expect(logged.filter((r) => r.event === "ingress.persisted").length).toBeGreaterThan(0);
      expect(logged.filter((r) => r.event === "ingress.auth_rejected").length).toBeGreaterThan(0);
      const text = JSON.stringify(logged);
      for (const k of [k1, k2]) for (const form of [k.toString("hex"), k.toString("base64"), k.toString("base64url")]) expect(text).not.toContain(form);
    } finally {
      await a.app.close();
    }
  });

  it("[FO-07-18][FO-15-50][FAULT:DUPLICATE_WEBHOOK][ACT-02] redeliveries reach the inbox whichever replica receives them: a body-signed webhook redelivered byte for byte to a second replica is a recorded duplicate (200); a bearer token reused over other bytes at another replica is refused by the durable replay cache; a token outside its lifetime bound is refused", async ({ l2 }) => {
    const tenantId = newId("tnt");
    const { arn, key } = await hmacSecret(l2);
    const bodySigned = { ...hmacVerifier(arn), signatureHeader: "x-hub-signature-256", signedPayload: "body", timestampHeader: null };
    const jwtSecret = await hmacSecret(l2);
    const jwtSource = "cdp.bearer";
    const profiles = [
      profile(tenantId, HMAC_SOURCE, bodySigned),
      profile(tenantId, jwtSource, { kind: "jwt_bearer", header: "authorization", issuer: "cdp.synthetic", audience: "vsp-ingress", algorithms: ["HS256"], credentials: jwtSecret.arn, jwksUrl: null, bodyHashClaim: null, maxTokenAgeSeconds: 600 }),
    ];
    // Two replicas: separate routers, verifiers, inboxes and pools; one shared database.
    const a = await serve(ingressStack(l2, adb.pool(2), systemClock, kmsKey, profiles).router);
    const b = await serve(ingressStack(l2, adb.pool(2), systemClock, kmsKey, profiles).router);
    try {
      const body = receipt(systemClock);
      const headers = { "x-hub-signature-256": `sha256=${createHmac("sha256", key).update(body).digest("hex")}`, "content-type": "application/json" };
      expect(await post(a.url, body, headers)).toMatchObject({ status: 200, body: { decision: "accepted" } });
      expect(await post(b.url, body, headers), "reached: a byte-identical redelivery at another replica").toMatchObject({ status: 200, body: { decision: "duplicate" } });
      expect(await post(a.url, body, headers)).toMatchObject({ status: 200, body: { decision: "duplicate" } });
      const rows = await inboxRows(tenantId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.duplicate_count).toBe(2);
      const deliveries = await adb.db.tx((tx) => tx.query<{ duplicate: boolean }>("select duplicate from inbound_deliveries"), { role: "app_worker", rls: { tenantId } });
      expect(deliveries.rows.filter((d) => d.duplicate)).toHaveLength(2);

      const jwtPost = async (url: string, b2: Buffer, token: string) => {
        const r = await fetch(`${url}/v1/ingress/${jwtSource}/events`, { method: "POST", body: b2, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });
        return { status: r.status, body: (await r.json()) as Record<string, unknown> };
      };
      const token = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setIssuer("cdp.synthetic").setAudience("vsp-ingress").setIssuedAt().setExpirationTime("5m").setJti(newId("jti")).sign(new Uint8Array(jwtSecret.key));
      const e1 = receipt(systemClock);
      expect(await jwtPost(a.url, e1, token)).toMatchObject({ status: 200, body: { decision: "accepted" } });
      expect(await jwtPost(b.url, e1, token)).toMatchObject({ status: 200, body: { decision: "duplicate" } });
      expect(await jwtPost(b.url, receipt(systemClock), token)).toMatchObject({ status: 401, body: { error: { reasonCode: "INGRESS_REPLAYED" } } });
      // [FO-15-50] Token lifetime bound (maxTokenAgeSeconds 600): a long-lived token, or one issued an hour ago, is refused.
      const nowS = Math.floor(Date.now() / 1000);
      const bounded = (iat: number, exp: number) =>
        new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setIssuer("cdp.synthetic").setAudience("vsp-ingress").setIssuedAt(iat).setExpirationTime(exp).setJti(newId("jti")).sign(new Uint8Array(jwtSecret.key));
      expect(await jwtPost(a.url, receipt(systemClock), await bounded(nowS, nowS + 7200))).toMatchObject({ status: 401, body: { error: { reasonCode: "INGRESS_TOKEN_LIFETIME_EXCEEDED" } } });
      expect(await jwtPost(b.url, receipt(systemClock), await bounded(nowS - 3600, nowS + 60))).toMatchObject({ status: 401, body: { error: { reasonCode: "INGRESS_TOKEN_LIFETIME_EXCEEDED" } } });
      expect(await jwtPost(a.url, receipt(systemClock), await bounded(nowS - 700, nowS - 100))).toMatchObject({ status: 401, body: { error: { reasonCode: "INGRESS_TOKEN_INVALID" } } });
      expect(await inboxRows(tenantId)).toHaveLength(2);
    } finally {
      await a.app.close();
      await b.app.close();
    }
  });

  it("[FO-07-16][AUTH-04] mTLS on the socket: a CA-verified client certificate whose fingerprint is pinned in Secrets Manager is accepted; an unpinned certificate of the same CA and a foreign certificate are refused", async ({ l2 }) => {
    const tenantId = newId("tnt");
    const dir = scratchDir("vsp-it-mtls-");
    const ossl = (...args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
    const ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"];
    ossl("req", "-x509", ...ec, "-keyout", "ca.key", "-out", "ca.crt", "-days", "2", "-subj", "/CN=vsp-it-ca");
    ossl("req", "-x509", ...ec, "-keyout", "rogue-ca.key", "-out", "rogue-ca.crt", "-days", "2", "-subj", "/CN=vsp-it-rogue-ca");
    const issue = (name: string, ca: string, ext: string) => {
      ossl("req", ...ec, "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", `/CN=${name}`);
      execFileSync("sh", ["-c", `printf '%s\\n' '${ext}' > ${name}.ext`], { cwd: dir });
      ossl("x509", "-req", "-in", `${name}.csr`, "-CA", `${ca}.crt`, "-CAkey", `${ca}.key`, "-CAcreateserial", "-out", `${name}.crt`, "-days", "2", "-extfile", `${name}.ext`);
    };
    issue("server", "ca", "subjectAltName=IP:127.0.0.1");
    issue("partner", "ca", "extendedKeyUsage=clientAuth");
    issue("other", "ca", "extendedKeyUsage=clientAuth");
    issue("foreign", "rogue-ca", "extendedKeyUsage=clientAuth");
    const file = (n: string) => readFileSync(join(dir, n));
    const fingerprint = new X509Certificate(file("partner.crt")).fingerprint256.replace(/:/g, "").toLowerCase();
    const secret = await secretsClient(l2).send(new CreateSecretCommand({ Name: uniqueName("vsp-it/ingress/mtls"), SecretString: JSON.stringify({ fingerprint }) }));
    const stack = ingressStack(l2, adb.db, systemClock, kmsKey, [profile(tenantId, MTLS_SOURCE, { kind: "mtls", mode: "socket", credentials: secret.ARN })]);
    const { app, port } = await serve(stack.router, { key: file("server.key"), cert: file("server.crt"), ca: file("ca.crt") });
    const send = (client: string | null) =>
      new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
        const body = receipt(systemClock);
        const req = httpsRequest(
          {
            host: "127.0.0.1",
            port,
            method: "POST",
            path: `/v1/ingress/${MTLS_SOURCE}/events`,
            ca: file("ca.crt"),
            headers: { "content-type": "application/json", "content-length": body.length },
            ...(client ? { key: file(`${client}.key`), cert: file(`${client}.crt`) } : {}),
          },
          (res) => {
            let text = "";
            res.on("data", (d: Buffer) => (text += d.toString("utf8")));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) as Record<string, unknown> }));
          },
        );
        req.on("error", reject);
        req.end(body);
      });
    try {
      expect(await send("partner")).toMatchObject({ status: 200, body: { decision: "accepted" } });
      expect(await send("other")).toMatchObject({ status: 401, body: { error: { reasonCode: "INGRESS_CLIENT_CERT_NOT_PINNED" } } });
      expect(await send("foreign")).toMatchObject({ status: 401, body: { error: { reasonCode: "INGRESS_CLIENT_CERT_UNVERIFIED" } } });
      expect(await send(null)).toMatchObject({ status: 401, body: { error: { reasonCode: "INGRESS_CLIENT_CERT_UNVERIFIED" } } });
      const rows = await inboxRows(tenantId);
      expect(rows.map((r) => r.auth_mechanism)).toEqual(["MTLS"]);
    } finally {
      await app.close();
    }
  });

  it("[FAULT:DUPLICATE_WEBHOOK][FO-07-18][ACT-02] deterministic race: two replicas' accepts of one event are held at the same point inside the transaction; the per-event accept lock serializes them, so both answer 200 (accepted, then a recorded duplicate), one row, never a 503", async ({ l2 }) => {
    const tenantId = newId("tnt");
    const { arn, key } = await hmacSecret(l2);
    const profiles = [profile(tenantId, HMAC_SOURCE, hmacVerifier(arn))];
    const barrier = acceptRaceBarrier(adb.db);
    // Two replicas: separate pools, routers, verifiers and inboxes over one database; each Db passes through the barrier.
    const a = await serve(ingressStack(l2, barrier.wrap(adb.pool(2)), systemClock, kmsKey, profiles).router);
    const b = await serve(ingressStack(l2, barrier.wrap(adb.pool(2)), systemClock, kmsKey, profiles).router);
    try {
      // INJECT: the vendor's delivery and its redelivery of the same event reach two replicas at the same moment.
      const body = receipt(systemClock);
      const [ra, rb] = await Promise.all([post(a.url, body, signHeaders(body, key, systemClock)), post(b.url, body, signHeaders(body, key, systemClock))]);
      expect(barrier.outcome(), "reached: one accept waited for the other's per-event lock inside its transaction").toBe("LOCK_WAIT_OBSERVED");
      expect(barrier.arrivals()).toBe(2);
      expect([ra.status, rb.status]).toEqual([200, 200]);
      expect([ra.body.decision, rb.body.decision].sort()).toEqual(["accepted", "duplicate"]);
      expect(ra.body.inboxId).toBe(rb.body.inboxId);
      const rows = await inboxRows(tenantId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.duplicate_count).toBe(1);
      const deliveries = await adb.db.tx((tx) => tx.query<{ duplicate: boolean; digest_matches: boolean }>("select duplicate, digest_matches from inbound_deliveries order by duplicate"), { role: "app_worker", rls: { tenantId } });
      expect(deliveries.rows).toEqual([{ duplicate: false, digest_matches: true }, { duplicate: true, digest_matches: true }]);
      const accepted = await adb.db.tx((tx) => tx.query("select 1 from audit_outbox where tenant_id = app_tenant() and action = 'ingress.event.accepted'"), { role: "app_worker", rls: { tenantId } });
      expect(accepted.rows, "one acceptance audited").toHaveLength(1);
    } finally {
      await a.app.close();
      await b.app.close();
    }
  });

  it("[FAULT:DUPLICATE_WEBHOOK][FO-07-18][ACT-02] ten concurrent redeliveries of one event id and an SQS redelivery of the outbox message it produced: one row, one effect, every duplicate recorded", async ({ l2 }) => {
    const tenantId = newId("tnt");
    const { arn, key } = await hmacSecret(l2);
    const stack = ingressStack(l2, adb.db, systemClock, kmsKey, [profile(tenantId, HMAC_SOURCE, hmacVerifier(arn))]);
    const { app, url } = await serve(stack.router);
    const sqs = sqsClient(l2);
    const queue = uniqueName("vsp-it-dup");
    await sqs.send(new CreateQueueCommand({ QueueName: queue }));
    try {
      // INJECT (inbound): the vendor redelivers the same event id ten times at once (each a fresh signature).
      const body = receipt(systemClock);
      const now = Math.floor(Date.now() / 1000);
      const sends = Array.from({ length: 10 }, (_, i) => {
        const clockAt = new FakeClock(new Date((now - i) * 1000));
        return post(url, body, signHeaders(body, key, clockAt));
      });
      const results = await Promise.all(sends);
      expect(results.every((r) => r.status === 200)).toBe(true);
      const decisions = results.map((r) => r.body.decision).sort();
      expect(decisions.filter((d) => d === "accepted")).toHaveLength(1);
      expect(decisions.filter((d) => d === "duplicate")).toHaveLength(9);
      const rows = await inboxRows(tenantId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.duplicate_count, "reached: nine duplicates recorded").toBe(9);
      const deliveries = await adb.db.tx((tx) => tx.query<{ duplicate: boolean; digest_matches: boolean }>("select duplicate, digest_matches from inbound_deliveries"), { role: "app_worker", rls: { tenantId } });
      expect(deliveries.rows.filter((d) => d.duplicate)).toHaveLength(9);
      expect(deliveries.rows.every((d) => d.digest_matches)).toBe(true);

      // Processing: one effect, which enqueues one outbox message (same transaction).
      const outbox = new PgOutbox({ clock: systemClock });
      const handler = async (tx: Parameters<Parameters<typeof stack.processor>[1][string]>[0], ev: { eventId: string }) => {
        await outbox.enqueue(tx, { topic: "support_request.sync", key: `receipt:${ev.eventId}`, payload: { receiptRef: ev.eventId }, dedupeKey: `receipt:${ev.eventId}` });
        return { projection: null };
      };
      const [p1, p2] = await Promise.all([stack.processor(adb.pool(2), { "delivery.receipt@1": handler }).runOnce(), stack.processor(adb.pool(2), { "delivery.receipt@1": handler }).runOnce()]);
      expect(p1.processed + p2.processed).toBe(1);

      // INJECT (outbox): the message is published, received, not deleted (consumer crash), and redelivered by SQS.
      await new PgOutboxDispatcher({ db: adb.db, publisher: new SqsPublisher({ client: sqs, queueUrl: awsQueueUrl(queue), fifo: false }), clock: systemClock, tenants: [tenantId] }).runOnce();
      const consumer = new PgConsumerDedup({ db: adb.db, clock: systemClock });
      let effects = 0;
      const consume = async () => {
        const got = (await sqs.send(new ReceiveMessageCommand({ QueueUrl: awsQueueUrl(queue), MaxNumberOfMessages: 1, WaitTimeSeconds: 2, VisibilityTimeout: 1, MessageSystemAttributeNames: ["ApproximateReceiveCount"] }))).Messages ?? [];
        const m = got[0];
        if (!m) return null;
        const msg = JSON.parse(m.Body ?? "{}") as { messageId: string; tenantId: string };
        const r = await consumer.processOnceForTenant(msg.tenantId, "it.receipts", msg.messageId, async () => (effects += 1));
        return { duplicate: r.duplicate, receiveCount: Number(m.Attributes?.ApproximateReceiveCount ?? 0) };
      };
      const first = await consume();
      expect(first).toMatchObject({ duplicate: false, receiveCount: 1 });
      await sleep(1_500); // visibility timeout passes without a delete: SQS redelivers
      const second = await consume();
      expect(second, "reached: SQS redelivered the same message").toMatchObject({ duplicate: true, receiveCount: 2 });
      expect(effects).toBe(1);
      const attrs = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: awsQueueUrl(queue), AttributeNames: ["ApproximateNumberOfMessages"] }));
      expect(attrs.Attributes).toBeDefined();
      const dedupRows = await adb.db.tx((tx) => tx.query("select 1 from consumer_dedup where consumer = 'it.receipts'"), { role: "app_worker", rls: { tenantId } });
      expect(dedupRows.rows, "the deduplication decision is recorded").toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});
