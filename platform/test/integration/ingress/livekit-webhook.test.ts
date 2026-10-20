/**
 * Layer 2 (WP-04): webhooks SENT BY livekit-server itself, received by the production ingress over real HTTP
 * (FO-15-50, FO-07-16, FO-07-17, FO-07-19; AUTH-04, ACT-02 at this boundary).
 *
 * The sender is livekit-server from the composition's pinned image, run as a throwaway container owned by this
 * test (the shared `livekit` service is never reconfigured or restarted), with its documented webhook
 * configuration: `webhook.api_key` and `webhook.urls`. LiveKit signs every delivery with an HS256 JWT in the
 * Authorization header, issued by the API key and carrying base64(SHA-256(body)) in its `sha256` claim
 * (https://docs.livekit.io/home/server/webhooks/). The receiving side is the production stack: IngressRouter with
 * a `jwt_bearer` source profile (issuer = API key, bodyHashClaim "sha256"), the API secret as a Secrets Manager
 * version (LocalStack), PgInbox on postgres:16 (provisioned as on Aurora) with KMS envelope encryption
 * (LocalStack KMS), the Fastify ingressPlugin listening on the Docker bridge gateway so the container can reach
 * it, and the InboxProcessor. A second source is configured with a key LiveKit does not hold: every delivery to it
 * is refused before anything is stored. Room events carry a TURN credential (room.turnPassword): it is sealed in
 * the restricted payload columns and never appears in a log. SYNTHETIC keys and room names only.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { CreateSecretCommand } from "@aws-sdk/client-secrets-manager";
import { RoomServiceClient } from "livekit-server-sdk";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { z } from "zod";
import type { InboundContract } from "../../../src/ingress/contracts.js";
import { systemClock } from "../../../src/shared/clock.js";
import { newId } from "../../../src/shared/ids.js";
import { secretsClient, uniqueName } from "../_harness/clients.js";
import { discoverServices } from "../_harness/discovery.js";
import { layer2, layer2Context } from "../_harness/layer2.js";
import { createAuroraLikeDb, sleep } from "../substrate/support.js";
import type { AuroraLikeDb } from "../substrate/support.js";
import { ingressStack, kmsInboxKey, profile, serve } from "./support.js";

const it = layer2(["postgres", "localstack", "livekit"]);
let adb: AuroraLikeDb;
let kmsKey: string;
let image: string;
let gateway: string;

const SOURCE = "livekit.webhooks";
const MISCONFIGURED = "livekit.misconfigured";

/**
 * The reviewed contract of LiveKit's room webhooks (livekit-server v1.13 protocol `WebhookEvent` with its `Room`),
 * strict: a field this contract does not declare quarantines the event.
 */
const Room = z.strictObject({
  sid: z.string().regex(/^RM_[A-Za-z0-9]{1,32}$/),
  name: z.string().min(1).max(128),
  emptyTimeout: z.number().int().optional(),
  departureTimeout: z.number().int().optional(),
  maxParticipants: z.number().int().optional(),
  creationTime: z.string().regex(/^\d{1,20}$/).optional(),
  creationTimeMs: z.string().regex(/^\d{1,20}$/).optional(),
  turnPassword: z.string().max(256).optional(),
  enabledCodecs: z.array(z.strictObject({ mime: z.string().max(64), fmtpLine: z.string().max(256).optional() })).max(32).optional(),
  metadata: z.string().max(4096).optional(),
  numParticipants: z.number().int().optional(),
  numPublishers: z.number().int().optional(),
  activeRecording: z.boolean().optional(),
});
const RoomEvent = z.strictObject({
  event: z.enum(["room_started", "room_finished"]),
  id: z.string().regex(/^EV_[A-Za-z0-9]{1,32}$/),
  createdAt: z.string().regex(/^\d{1,20}$/),
  room: Room,
  roomEndReason: z.string().regex(/^[A-Z_]{1,64}$/).optional(),
  numDropped: z.number().int().optional(),
});
const LIVEKIT_CONTRACTS: InboundContract[] = [{ contractId: "livekit.webhook", version: "1", schema: RoomEvent }];

const liveKitProfile = (tenantId: string, sourceId: string, apiKey: string, credentials: string) =>
  profile(
    tenantId,
    sourceId,
    { kind: "jwt_bearer", header: "authorization", issuer: apiKey, audience: null, algorithms: ["HS256"], credentials, jwksUrl: null, bodyHashClaim: "sha256", maxTokenAgeSeconds: 600 },
    {
      family: "webhook",
      vendor: "LiveKit",
      documentationUrl: "https://docs.livekit.io/home/server/webhooks/",
      envelope: { idField: "id", typeField: "event", occurredAtField: null, versionField: null, entityField: null },
      contracts: { room_started: { contractId: "livekit.webhook", version: "1" }, room_finished: { contractId: "livekit.webhook", version: "1" } },
    },
  );

/** A Secrets Manager secret holding an HS256 key ({"key": base64 of the key bytes}); returns its ARN and version. */
async function apiSecret(l2: Parameters<typeof secretsClient>[0], secret: string): Promise<{ arn: string; version: string }> {
  const r = await secretsClient(l2).send(new CreateSecretCommand({ Name: uniqueName("vsp-it/ingress/livekit"), SecretString: JSON.stringify({ key: Buffer.from(secret, "utf8").toString("base64") }) }));
  return { arn: r.ARN ?? "", version: r.VersionId ?? "" };
}

interface ThrowawayLiveKit {
  url: string;
  container: string;
  /** livekit-server's webhook delivery log lines (event, id, url, status), for failure messages. */
  webhookLog(): string;
  remove(): void;
}

/** livekit-server (the composition's image) with its own API key and webhook URLs, on an ephemeral loopback port. */
async function throwawayLiveKit(apiKey: string, apiSecretValue: string, webhookUrls: string[]): Promise<ThrowawayLiveKit> {
  const container = `vsp-it-livekit-${randomBytes(4).toString("hex")}`;
  const config = [
    "port: 7880",
    "rtc:",
    "  tcp_port: 7881",
    "  udp_port: 7882",
    "  use_external_ip: false",
    "webhook:",
    `  api_key: ${apiKey}`,
    "  urls:",
    ...webhookUrls.map((u) => `    - ${u}`),
    "logging:",
    "  level: info",
  ].join("\n");
  const run = spawnSync("docker", ["run", "-d", "--rm", "--name", container, "--label", "io.vsp.test=ingress-livekit-webhook", "-p", "127.0.0.1::7880", "-e", `LIVEKIT_KEYS=${apiKey}: ${apiSecretValue}`, "-e", `LIVEKIT_CONFIG=${config}`, image], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`THROWAWAY_LIVEKIT_START_FAILED: ${run.stderr.trim().slice(0, 300)}`);
  const port = spawnSync("docker", ["port", container, "7880/tcp"], { encoding: "utf8" }).stdout.trim().split("\n")[0]?.split(":").pop();
  const url = `http://127.0.0.1:${port}`;
  const rooms = new RoomServiceClient(url, apiKey, apiSecretValue);
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      await rooms.listRooms();
      break;
    } catch {
      if (Date.now() > deadline) {
        spawnSync("docker", ["rm", "-f", container]);
        throw new Error("THROWAWAY_LIVEKIT_NOT_READY");
      }
      await sleep(500);
    }
  }
  return {
    url,
    container,
    webhookLog: () =>
      spawnSync("docker", ["logs", container], { encoding: "utf8" })
        .stderr.split("\n")
        .concat(spawnSync("docker", ["logs", container], { encoding: "utf8" }).stdout.split("\n"))
        .filter((l) => l.includes("livekit.webhook"))
        .map((l) => l.replace(/"room": "[^"]*"/g, '"room": "<redacted>"'))
        .slice(-12)
        .join("\n"),
    remove: () => void spawnSync("docker", ["rm", "-f", container]),
  };
}

async function rows(tenantId: string) {
  const r = await adb.db.tx(
    (tx) =>
      tx.query<{ source_id: string; event_type: string; status: string; auth_mechanism: string; credential_version: string | null; schema_id: string | null; payload_ciphertext: Buffer | null; audit_event_id: string }>(
        "select source_id, event_type, status, auth_mechanism, credential_version, schema_id, payload_ciphertext, audit_event_id from inbound_events order by event_type",
      ),
    { role: "app_worker", rls: { tenantId } },
  );
  return r.rows;
}

async function until<T>(what: string, probe: () => Promise<T | null>, context: () => string = () => "", timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v !== null) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n${context()}`);
    await sleep(200);
  }
}

describe("LiveKit's own webhooks over real HTTP into the authenticated inbox", () => {
  beforeAll(async () => {
    const l2 = layer2Context(["postgres", "localstack", "livekit"]);
    adb = await createAuroraLikeDb(l2);
    kmsKey = await kmsInboxKey(l2);
    const svc = discoverServices().livekit;
    if (!svc) throw new Error("the composition's livekit service is not running (make up PROFILE=core)");
    image = svc.image;
    // The Docker bridge gateway: the address a container reaches the host (this test's ingress socket) on.
    gateway = spawnSync("docker", ["network", "inspect", "bridge", "--format", "{{range .IPAM.Config}}{{.Gateway}}{{end}}"], { encoding: "utf8" }).stdout.trim();
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(gateway)) throw new Error("no Docker bridge gateway address");
  });
  afterAll(async () => {
    await adb?.drop();
  });

  it("[FO-15-50][FO-07-16][FO-07-17][FO-07-19][AUTH-04] livekit-server's signed room webhooks (HS256 JWT binding the body's SHA-256, LiveKit's documented mechanism) verify against the API secret version in Secrets Manager, are sealed, audited and processed; deliveries signed with a key the source does not hold are refused before anything is stored", async ({ l2 }) => {
    const tenantId = newId("tnt");
    const apiKey = `APIvspit${randomBytes(4).toString("hex")}`;
    const secretValue = randomBytes(24).toString("hex");
    const good = await apiSecret(l2, secretValue);
    const wrong = await apiSecret(l2, randomBytes(24).toString("hex"));
    const stack = ingressStack(l2, adb.pool(2), systemClock, kmsKey, [liveKitProfile(tenantId, SOURCE, apiKey, good.arn), liveKitProfile(tenantId, MISCONFIGURED, apiKey, wrong.arn)], LIVEKIT_CONTRACTS);
    const { app, url } = await serve(stack.router, undefined, gateway);
    const lk = await throwawayLiveKit(apiKey, secretValue, [`${url}/v1/ingress/${SOURCE}/events`, `${url}/v1/ingress/${MISCONFIGURED}/events`]);
    try {
      const rooms = new RoomServiceClient(lk.url, apiKey, secretValue);
      const roomName = uniqueName("vsp-it-room");
      // INJECT: real room lifecycle events; livekit-server sends one webhook per event to each configured URL.
      await rooms.createRoom({ name: roomName, emptyTimeout: 30 });
      await until("room_started in the inbox", async () => ((await rows(tenantId)).some((r) => r.event_type === "room_started") ? true : null), lk.webhookLog);
      await rooms.deleteRoom(roomName);
      const stored = await until("room_finished in the inbox", async () => {
        const all = await rows(tenantId);
        return all.some((r) => r.event_type === "room_finished") ? all : null;
      }, lk.webhookLog);

      // Authenticated with LiveKit's mechanism, recorded with the verifying credential version, sealed and audited.
      expect(stored.map((r) => [r.source_id, r.event_type, r.status, r.auth_mechanism, r.credential_version, r.schema_id])).toEqual([
        [SOURCE, "room_finished", "RECEIVED", "JWT_BEARER", good.version, "livekit.webhook"],
        [SOURCE, "room_started", "RECEIVED", "JWT_BEARER", good.version, "livekit.webhook"],
      ]);
      for (const r of stored) {
        expect(r.payload_ciphertext?.includes(Buffer.from(roomName))).toBe(false);
        expect(r.audit_event_id).toMatch(/^aud_/);
      }

      // The misconfigured source refused every LiveKit delivery before persistence (nothing stored for it).
      const refused = await until("a refused delivery", async () => {
        const n = stack.records.filter((x) => x.event === "ingress.auth_rejected" && x.fields.integration === MISCONFIGURED);
        return n.length >= 2 ? n : null;
      }, () => `${lk.webhookLog()}\nrouter log events: ${JSON.stringify(stack.records.map((x) => [x.event, x.fields.integration ?? null, x.fields.reasonCode ?? null]))}`);
      expect(refused.every((x) => x.fields.reasonCode === "INGRESS_TOKEN_INVALID")).toBe(true);
      expect(stack.metrics.counterValue("vsp_inbox_events_total", { result: "auth_rejected", auth: "jwt_bearer" })).toBe(refused.length);
      expect(stack.metrics.counterValue("vsp_inbox_events_total", { result: "accepted", auth: "jwt_bearer" })).toBe(2);
      expect(stored.every((r) => r.source_id === SOURCE)).toBe(true);
      expect(stack.records.filter((x) => x.event === "ingress.persisted").map((x) => [x.fields.integration, x.fields.outcome])).toEqual([
        [SOURCE, "accepted"],
        [SOURCE, "accepted"],
      ]);
      // livekit-server itself recorded the outcome of every delivery: 200 for the configured source, 401 for the other.
      const deliveries = lk.webhookLog();
      expect(deliveries).toMatch(new RegExp(`${MISCONFIGURED.replace(".", "\\.")}/events", .*"statusCode": 401`));
      expect(deliveries).toMatch(new RegExp(`${SOURCE.replace(".", "\\.")}/events", .*"statusCode": 200`));

      // Processing decrypts the exact payload LiveKit sent (KMS Decrypt with the row's encryption context).
      const seen: { eventType: string; room: string; turn: string | null }[] = [];
      const r = await stack
        .processor(adb.pool(2), {
          "livekit.webhook@1": async (_tx, ev) => {
            const p = RoomEvent.parse(ev.payload);
            seen.push({ eventType: ev.eventType, room: p.room.name, turn: p.room.turnPassword ?? null });
            return { projection: null };
          },
        })
        .runOnce();
      expect(r.processed).toBe(2);
      expect(seen.map((s) => [s.eventType, s.room]).sort()).toEqual([
        ["room_finished", roomName],
        ["room_started", roomName],
      ]);

      // Logs carry ids, digests and reason codes only: never the TURN credential in the payload, the API secret or a token.
      const logged = JSON.stringify(stack.records);
      for (const s of seen) if (s.turn) expect(logged).not.toContain(s.turn);
      expect(logged).not.toContain(secretValue);
      expect(logged).not.toContain(roomName);
      expect(logged).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\./);
    } finally {
      lk.remove();
      await app.close();
    }
  });
});
