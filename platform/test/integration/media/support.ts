/**
 * Layer-2 media suite plumbing (WP-11). Everything that answers is real:
 *   - the live gateway composition (buildLiveContainer over the composition sandbox: PostgreSQL, DynamoDB Local,
 *     ElasticMQ, LocalStack) with the media routes registered on its app (registerMediaRoutes), the CallBinding
 *     store on its own DynamoDB Local table, TrustedSessionService, the HandoffService and the audit writer of
 *     the composition, the runtime credential verified against Keycloak's JWKS through the egress-classified
 *     transport (OidcHttp -> ConnectorHttpTransport), the media-plane lookup over livekit-server's Twirp API;
 *   - the media worker as its own process (media/test/support/run-worker.ts: createMediaAgentServer, the
 *     LiveKit Agents worker), registering with livekit-server and receiving explicitly dispatched room jobs;
 *   - synthetic callers are @livekit/rtc-node participants publishing a tone; the egress service, when a test
 *     needs it, is a throwaway livekit/egress container on the host network (livekit-server advertises 127.0.0.1
 *     ICE candidates, deploy/local/README.md), writing to its own MinIO bucket.
 * Test plumbing (labelled, not unit fakes): the HTTPS front of the gateway (test PKI for the synthetic name), the
 * TLS proxy in front of the shared Keycloak, the scratch configuration files.
 */
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import type { Server } from "node:https";
import { createServer as createNetServer } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AudioFrame, AudioSource, AudioStream, LocalAudioTrack, Room, RoomEvent, TrackKind, TrackPublishOptions, TrackSource } from "@livekit/rtc-node";
import type { RemoteTrack } from "@livekit/rtc-node";
import { AccessToken, AgentDispatchClient, RoomServiceClient } from "livekit-server-sdk";
import type { ParticipantInfo } from "livekit-server-sdk";
import { OidcHttp } from "../../../src/adapters/live/oidc-http.js";
import { transportJwksResolver } from "../../../src/adapters/live/transport-jwks.js";
import { LiveKitCarrierLookup } from "../../../src/calls/binding/livekit-lookup.js";
import { RuntimeCredentialVerifier } from "../../../src/calls/binding/runtime-auth.js";
import type { BindingAuditEvent, BindingAuditSink } from "../../../src/calls/binding/ports.js";
import { CallBindingService, claimOf } from "../../../src/calls/binding/service.js";
import { CallBindingStore } from "../../../src/calls/binding/store.js";
import { MediaPlaneSupervisor } from "../../../src/calls/binding/supervisor.js";
import { AesGcmTokenSealer } from "../../../src/console-api/token-sealer.js";
import { ConnectorHttpTransport } from "../../../src/connectors/http/transport.js";
import { GatewayAudit } from "../../../src/gateway/gateway-audit.js";
import { actionInvalidator, gatewayBindingAudit, registerMediaRoutes, sessionServiceCallSessions, supervisorEndCall, supervisorHumanRoute, supervisorPersonState } from "../../../src/gateway/http/media-routes.js";
import type { HandoffService } from "../../../src/business/contract.js";
import { DynamoKvStore } from "../../../src/identity/kv/dynamo-kv-store.js";
import type { LiveContainer } from "../../../src/main/live-container.js";
import { ensurePolicyBundle } from "../../../src/policy/ensure-bundle.js";
import { EgressGuard } from "../../../src/privacy/egress.js";
import type { IntegrationIdentity } from "../../../src/protocol/index.js";
import { MediaProcessingState } from "../../../src/protocol/call-binding.js";
import { newId } from "../../../src/shared/ids.js";
import type { MediaBindingClaim } from "../../../src/protocol/call-binding.js";
import { dynamoClient, uniqueName } from "../_harness/clients.js";
import { REPO_ROOT, localEnv } from "../_harness/env.js";
import { Keycloak } from "../_harness/keycloak.js";
import type { Layer2Context } from "../_harness/layer2.js";
import { SUBSTRATE, TlsFrontProxy, bootLive, createPki, provisionSandbox } from "../composition/support.js";
import type { Sandbox, TestPki } from "../composition/support.js";
import { realmName } from "../identity/support.js";
import { createKvTable } from "../substrate/seams.js";

export const MEDIA_SERVICES = [...SUBSTRATE, "keycloak", "livekit", "valkey"] as const;
/** SYNTHETIC names (the worker's transport maps them to loopback ports; local/ci only). */
export const GATEWAY_HOST = "gateway.vsp-media.test";
export const IDP_HOST = "idp.vsp-media.test";
export const LIVEKIT_HOST = "livekit.vsp-media.test";
export const AUDIENCE = "vsp-gateway-media";
export const RUNTIME_SCOPE = "vsp.conversation_runtime";
const MEDIA_ROOT = join(REPO_ROOT, "media");

/* ------------------------------------------------------------------------ */
/* HTTPS front of the in-process gateway (test plumbing)                      */
/* ------------------------------------------------------------------------ */

/** Terminates TLS for GATEWAY_HOST on 127.0.0.1 and forwards to the gateway's plain loopback listener. */
class GatewayTlsFront {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  port = 0;
  constructor(
    private readonly pki: TestPki,
    private readonly upstreamPort: number,
  ) {}
  async start(): Promise<number> {
    const server = createHttpsServer({ cert: this.pki.certPem, key: this.pki.keyPem }, (req: IncomingMessage, res: ServerResponse) => {
      const up = httpRequest({ host: "127.0.0.1", port: this.upstreamPort, method: req.method, path: req.url, headers: { ...req.headers } }, (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      });
      up.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.pipe(up);
    });
    server.on("connection", (s: Socket) => {
      this.sockets.add(s);
      s.on("close", () => this.sockets.delete(s));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, "127.0.0.1", () => resolve());
    });
    this.port = (server.address() as AddressInfo).port;
    this.server = server;
    return this.port;
  }
  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (!s) return;
    for (const sock of this.sockets) sock.destroy();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
}

/* ------------------------------------------------------------------------ */
/* The stack                                                                  */
/* ------------------------------------------------------------------------ */

export interface MediaStack {
  l2: Layer2Context;
  sb: Sandbox;
  c: LiveContainer;
  pki: TestPki;
  tenantId: string;
  store: CallBindingStore;
  bindings: CallBindingService;
  kc: Keycloak;
  realm: string;
  runtimeClient: { clientId: string; secret: string };
  /**
   * Adversarial clients of the same realm (AUTH-03): `unscoped` is a client the verifier knows but Keycloak gives no
   * runtime scope; `foreign` gets the runtime scope and audience but is not a client the verifier accepts.
   */
  otherClients: { unscoped: { clientId: string; secret: string }; foreign: { clientId: string; secret: string } };
  /** A fresh access token of any client of the realm (client credentials at Keycloak). */
  tokenFor(client: { clientId: string; secret: string }): Promise<string>;
  /** Every binding audit event the gateway wrote (observed on the production sink's way to the audit writer). */
  audits: BindingAuditEvent[];
  /** The gateway composition's warn/error log events (memory logger; redacted fields), newest last, for failure output. */
  gatewayEvents(): string[];
  /** Every person the gateway requested (observed on the production HandoffService's way in). */
  humanRoutes: { callId: string; reason: string }[];
  ports: { gateway: number; idp: number };
  dir: string;
  /** A fresh runtime access token from Keycloak (client credentials). */
  runtimeToken(): Promise<string>;
  /** POST to a gateway media route over HTTPS with the given bearer token. */
  post(path: string, body: unknown, token?: string | null): Promise<{ status: number; json: Record<string, unknown> }>;
  /** Writes the worker configuration and returns the environment of a worker process. */
  /**
   * The worker's configuration file and secrets. `maxConcurrentCalls` is the worker's call slots (its reported load is
   * calls / slots); a suite that keeps more calls open at once on one worker raises it so livekit-server keeps
   * offering it jobs.
   */
  workerEnv(o: { agentName: string; recording: boolean; faultSeams?: boolean; instance: string; maxConcurrentCalls?: number }): Record<string, string>;
  /** The CallBinding record of a room's interaction, read from DynamoDB Local (null when none). */
  bindingOf(roomName: string): Promise<{ claim: MediaBindingClaim; interactionId: string; lastMismatch: string | null; generation: number; recordingDeclined: boolean; consentVersion: number; state: string; ended: boolean } | null>;
  /** Grants recording and AI processing as the trusted consent capture would. */
  grant(claim: MediaBindingClaim): Promise<void>;
  /**
   * The platform's media-plane supervisor for an agent name (the loop the composition schedules). `bindings` replaces
   * the stack's binding service (e.g. one over a store that cannot be read) for its person checks and routes.
   */
  supervisor(agentName: string, o: { redispatchGraceMs: number; humanAfterMs: number }, bindings?: CallBindingService): MediaPlaneSupervisor;
  /** The gateway's binding service over another store (same lookup, sessions, sealer, audit and logger as the stack's). */
  bindingsOver(store: CallBindingStore): CallBindingService;
  /** The caller's decline as the call's owner reports it on the media path (CallBindingService.consentDecision). */
  decline(claim: MediaBindingClaim, dimension: "recording" | "transcriptionAiProcessing"): Promise<void>;
  close(): Promise<void>;
}

const telephony = (tenantId: string): IntegrationIdentity => ({ integrationId: "livekit-media-plane", tenantId, environment: "sandbox", channel: "telephony_control", credentialId: "cred-media-plane-l2", authMethod: "mtls" });

export async function startMediaStack(l2: Layer2Context): Promise<MediaStack> {
  ensurePolicyBundle();
  const dir = mkdtempSync(join(tmpdir(), "vsp-media-l2-"));
  const pki = createPki([GATEWAY_HOST, IDP_HOST]);
  writeFileSync(join(dir, "ca.pem"), pki.caPem);
  const sb = await provisionSandbox(l2);
  const realm = realmName("media");
  const kc = new Keycloak(`https://localhost:${l2.port("keycloak", 8443)}`);
  const idpProxy = new TlsFrontProxy(pki, { port: l2.port("keycloak", 8443), servername: "localhost" }, "127.0.0.1");
  const idpPort = await idpProxy.start();
  const runtimeClient = { clientId: "vsp-media-runtime", secret: randomBytes(24).toString("base64url") };
  await kc.createRealm({
    realm,
    enabled: true,
    attributes: { frontendUrl: `https://${IDP_HOST}` },
    accessTokenLifespan: 300,
    clients: [
      {
        clientId: runtimeClient.clientId,
        protocol: "openid-connect",
        publicClient: false,
        secret: runtimeClient.secret,
        standardFlowEnabled: false,
        serviceAccountsEnabled: true,
        protocolMappers: [{ name: "aud-media", protocol: "openid-connect", protocolMapper: "oidc-audience-mapper", config: { "included.custom.audience": AUDIENCE, "access.token.claim": "true", "id.token.claim": "false" } }],
      },
    ],
  });
  await kc.addDefaultScope(realm, runtimeClient.clientId, RUNTIME_SCOPE);
  const otherClients = { unscoped: { clientId: "vsp-media-runtime-b", secret: randomBytes(24).toString("base64url") }, foreign: { clientId: "vsp-other-service", secret: randomBytes(24).toString("base64url") } };
  for (const oc of [otherClients.unscoped, otherClients.foreign]) {
    await kc.admin("POST", `/realms/${realm}/clients`, {
      clientId: oc.clientId,
      protocol: "openid-connect",
      publicClient: false,
      secret: oc.secret,
      standardFlowEnabled: false,
      serviceAccountsEnabled: true,
      protocolMappers: [{ name: "aud-media", protocol: "openid-connect", protocolMapper: "oidc-audience-mapper", config: { "included.custom.audience": AUDIENCE, "access.token.claim": "true", "id.token.claim": "false" } }],
    });
  }
  // The foreign client is given the runtime scope too: only the verifier's client list refuses it.
  const scopes = await kc.adminJson<{ id: string; name: string }[]>(`/realms/${realm}/client-scopes`);
  const runtimeScopeId = scopes.find((x) => x.name === RUNTIME_SCOPE)?.id ?? "";
  await kc.admin("PUT", `/realms/${realm}/clients/${await kc.clientUuid(realm, otherClients.foreign.clientId)}/default-client-scopes/${runtimeScopeId}`);
  const { c, records } = await bootLive(sb);
  const tenantId = c.tenantIds[0] as string;
  const dynamo = dynamoClient(l2);
  const table = await createKvTable(dynamo, uniqueName("vsp-it-media-bindings"));
  const store = new CallBindingStore(DynamoKvStore.fromClient(dynamo, table));
  // The gateway's own transport for the media plane and the IdP's key set (production classes; loopback routes
  // are the local/ci form of the private DNS names).
  const egress = new EgressGuard(
    {
      policyVersion: "egress-media-gateway-l2-1",
      destinations: [
        { destinationId: "egr_media_plane", kind: "RESTRICTED_MEDIA_STORE", hosts: [LIVEKIT_HOST], allowedClasses: ["INTERNAL"], coverage: { baaRef: null, approvalId: null }, environments: ["ci"], adapterKind: "live" },
        { destinationId: "egr_runtime_idp", kind: "VERIFICATION_SERVICE", hosts: [IDP_HOST], allowedClasses: ["PUBLIC", "VERIFICATION_SECRET"], coverage: { baaRef: null, approvalId: "apr_synthMediaIdpL2001" }, environments: ["ci"], adapterKind: "live" },
      ],
    },
    { environment: "ci" },
  );
  const transport = new ConnectorHttpTransport({
    environment: "ci",
    egress,
    loopbackRoutes: new Map([
      [LIVEKIT_HOST, { port: l2.port("livekit", 7880), tls: false }],
      [IDP_HOST, { port: idpPort, tls: true }],
    ]),
    tlsCa: [pki.caPem],
  });
  const env = localEnv();
  const lookup = new LiveKitCarrierLookup({ apiUrl: `https://${LIVEKIT_HOST}`, apiKey: env.livekitApiKey, addressClass: "PRIVATE_NETWORK" }, transport, async () => env.livekitApiSecret);
  const integration = telephony(tenantId);
  // Observation of the production sinks (test plumbing): every event still goes to the composition's audit writer
  // and every request to its HandoffService; the test reads what passed.
  const audits: BindingAuditEvent[] = [];
  const productionAudit = gatewayBindingAudit(new GatewayAudit(c.audit, c.clock, c.logger, c.versions));
  const audit: BindingAuditSink = {
    async record(e) {
      await productionAudit.record(e);
      audits.push(e);
    },
  };
  const humanRoutes: { callId: string; reason: string }[] = [];
  const handoff: Pick<HandoffService, "requestHuman" | "requestSafetyRoute"> = {
    async requestHuman(i) {
      const r = await c.business.handoff.requestHuman(i);
      humanRoutes.push({ callId: i.callId, reason: i.reason });
      return r;
    },
    requestSafetyRoute: (i) => c.business.handoff.requestSafetyRoute(i),
  };
  const sealer = new AesGcmTokenSealer({ current: { id: "media-l2-1", key: randomBytes(32) } });
  const bindingsOver = (over: CallBindingStore) =>
    new CallBindingService(
      { tenantId, environment: "sandbox", bindingTtlSeconds: 30, heartbeatIntervalSeconds: 5, recordingDeclinedRoute: "CONTINUE_UNRECORDED" },
      {
        store: over,
        sessions: sessionServiceCallSessions(c.identity.sessions, integration, c.clock),
        lookup,
        sealer,
        actions: actionInvalidator(c.actions),
        audit,
        clock: c.clock,
        logger: c.logger,
      },
    );
  const bindings = bindingsOver(store);
  const oidc = new OidcHttp({ transport, egress, destination: { allowedHosts: [IDP_HOST], addressClass: "PRIVATE_NETWORK" } });
  registerMediaRoutes(c.app, {
    tenantId,
    clock: c.clock,
    logger: c.logger,
    runtimeAuth: new RuntimeCredentialVerifier(
      {
        environment: "sandbox",
        tenantId,
        issuer: `https://${IDP_HOST}/realms/${realm}`,
        audience: AUDIENCE,
        algorithms: ["RS256"],
        clockToleranceSeconds: 5,
        maxTokenAgeSeconds: 600,
        clientIdClaim: "azp",
        scope: RUNTIME_SCOPE,
        clients: [
          { clientId: runtimeClient.clientId, integrationId: "vsp-media-runtime", credentialId: "cred-media-runtime-l2", adapters: ["controlled_cascade_runtime"] },
          { clientId: otherClients.unscoped.clientId, integrationId: "vsp-media-runtime-b", credentialId: "cred-media-runtime-l2b", adapters: ["controlled_cascade_runtime"] },
        ],
      },
      { clock: c.clock, getKey: transportJwksResolver({ http: oidc, jwksUri: `https://${IDP_HOST}/realms/${realm}/protocol/openid-connect/certs`, clock: c.clock }) },
    ),
    bindings,
    handoff,
    destinations: c.config.destinations,
    rateLimit: { max: 600, timeWindowMs: 60_000 },
    audit,
  });
  await c.app.listen({ port: 0, host: "127.0.0.1" });
  const front = new GatewayTlsFront(pki, (c.app.server.address() as AddressInfo).port);
  const gatewayPort = await front.start();

  const post = (path: string, body: unknown, token?: string | null) =>
    new Promise<{ status: number; json: Record<string, unknown> }>((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = httpsRequest(
        { host: "127.0.0.1", port: gatewayPort, method: "POST", path, servername: GATEWAY_HOST, ca: pki.caPem, headers: { host: GATEWAY_HOST, "content-type": "application/json", "content-length": Buffer.byteLength(payload), ...(token ? { authorization: `Bearer ${token}` } : {}) } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (d: Buffer) => chunks.push(d));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            resolve({ status: res.statusCode ?? 0, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} });
          });
        },
      );
      req.on("error", reject);
      req.end(payload);
    });

  const runtimeIdentity = { integrationId: "vsp-media-runtime", tenantId, environment: "sandbox" as const, channel: "conversation_runtime" as const, credentialId: "cred-media-runtime-l2", authMethod: "oauth2_client_credentials" as const, adapters: ["controlled_cascade_runtime" as const] };

  return {
    l2,
    sb,
    c,
    pki,
    tenantId,
    store,
    bindings,
    kc,
    realm,
    runtimeClient,
    otherClients,
    tokenFor: async (client) => (await kc.clientCredentials(realm, client.clientId, client.secret)).access_token,
    audits,
    gatewayEvents: () => records.filter((r) => r.level === "warn" || r.level === "error").map((r) => JSON.stringify({ level: r.level, event: r.event, ...r.fields })),
    humanRoutes,
    ports: { gateway: gatewayPort, idp: idpPort },
    dir,
    runtimeToken: async () => (await kc.clientCredentials(realm, runtimeClient.clientId, runtimeClient.secret)).access_token,
    post,
    workerEnv(o) {
      const config = {
        schemaVersion: "vsp.media-worker-config.v1",
        environment: "ci",
        agentName: o.agentName,
        workerInstanceRef: o.instance,
        adapter: "controlled_cascade_runtime",
        language: "en",
        livekit: { wsUrl: l2.url("livekit", 7880, "ws"), apiUrl: `https://${LIVEKIT_HOST}`, addressClass: "PRIVATE_NETWORK" },
        gateway: { baseUrl: `https://${GATEWAY_HOST}`, addressClass: "PRIVATE_NETWORK", timeoutMs: 5_000 },
        runtimeAuth: { tokenUrl: `https://${IDP_HOST}/realms/${realm}/protocol/openid-connect/token`, clientId: runtimeClient.clientId, scope: RUNTIME_SCOPE, addressClass: "PRIVATE_NETWORK" },
        recording: { enabled: o.recording },
        egress: {
          policyVersion: "egress-media-worker-l2-1",
          destinations: [
            { destinationId: "egr_gateway", kind: "SYSTEM_OF_RECORD", hosts: [GATEWAY_HOST], allowedClasses: ["INTERNAL"], coverage: { baaRef: null, approvalId: null }, environments: ["ci"], adapterKind: "live" },
            { destinationId: "egr_media_plane", kind: "RESTRICTED_MEDIA_STORE", hosts: [LIVEKIT_HOST], allowedClasses: ["INTERNAL"], coverage: { baaRef: null, approvalId: null }, environments: ["ci"], adapterKind: "live" },
            { destinationId: "egr_runtime_idp", kind: "VERIFICATION_SERVICE", hosts: [IDP_HOST], allowedClasses: ["PUBLIC", "VERIFICATION_SECRET"], coverage: { baaRef: null, approvalId: "apr_synthMediaIdpL2001" }, environments: ["ci"], adapterKind: "live" },
          ],
        },
        loopbackRoutes: [
          { host: GATEWAY_HOST, port: gatewayPort, tls: true },
          { host: LIVEKIT_HOST, port: l2.port("livekit", 7880), tls: false },
          { host: IDP_HOST, port: idpPort, tls: true },
        ],
        tlsCaFiles: [join(dir, "ca.pem")],
        playback: { sampleRate: 48_000, comfortNoiseDbfs: -60, slowerRate: 0.8 },
        recovery: { bindDeadlineMs: 90_000, humanDeadlineMs: 30_000 },
        reconcileIntervalMs: 1_000,
        idleProcesses: 1,
        ...(o.maxConcurrentCalls ? { maxConcurrentCalls: o.maxConcurrentCalls } : {}),
        faultSeams: o.faultSeams ?? false,
        health: { host: "127.0.0.1", port: 0 },
      };
      const file = join(dir, `worker-${o.instance}.json`);
      writeFileSync(file, JSON.stringify(config, null, 2));
      return { VSP_MEDIA_CONFIG_FILE: file, LIVEKIT_API_KEY: env.livekitApiKey, LIVEKIT_API_SECRET: env.livekitApiSecret, VSP_MEDIA_RUNTIME_CLIENT_SECRET: runtimeClient.secret };
    },
    async bindingOf(roomName) {
      // The room's claim by its server id (what the gateway pinned at the first touch), then the call record.
      const facts = await lookup.describeRoom({ tenantId, roomName }).catch(() => null);
      if (!facts) return null;
      const claim = await store.roomClaim(tenantId, facts.roomSid);
      if (!claim) return null;
      const rec = await store.load(tenantId, claim.interactionId);
      if (!rec) return null;
      const b = rec.data.binding;
      return { claim: claimOf(b), interactionId: claim.interactionId, lastMismatch: rec.data.lastMismatch?.mismatch ?? null, generation: b.sessionGeneration, recordingDeclined: rec.data.runtimeDeclines.recording !== null, consentVersion: rec.data.consentVersion, state: b.state, ended: rec.data.ended };
    },
    async grant(claim) {
      const { sessionRef } = await bindings.resolveClaim(runtimeIdentity, claim);
      await c.identity.sessions.recordConsent(sessionRef, integration, { recording: "GRANTED", automatedProcessing: "GRANTED", disclosureTemplateVersion: "disclosure-en-v3", capturedAt: c.clock.now().toISOString(), capturedBy: "studio_flow" });
    },
    supervisor(agentName, o, over = bindings) {
      return new MediaPlaneSupervisor(
        { agentName, ...o },
        {
          api: lookup,
          now: () => Date.now(),
          routeToHuman: supervisorHumanRoute({ tenantId, clock: c.clock, bindings: over, handoff, destinations: c.config.destinations, audit, logger: c.logger, language: "en" }),
          endCall: supervisorEndCall(over),
          personState: supervisorPersonState(over),
          logger: c.logger,
        },
      );
    },
    bindingsOver,
    async decline(claim, dimension) {
      await bindings.consentDecision(runtimeIdentity, { claim, dimension, decision: "DECLINED", capturedVia: "dtmf_menu", occurredAt: c.clock.now().toISOString() }, newId("cor"));
    },
    async close() {
      await front.stop();
      await c.close().catch(() => undefined);
      await idpProxy.stop();
      await kc.deleteRealm(realm);
      dynamo.destroy();
      await sb.close();
      pki.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/* ------------------------------------------------------------------------ */
/* The worker process                                                         */
/* ------------------------------------------------------------------------ */

export class WorkerProcess {
  private child: ChildProcess | null = null;
  output = "";
  workerId: string | null = null;
  constructor(private readonly env: Record<string, string>) {}

  /** Starts the production worker in its own process group; resolves once it registered with livekit-server. */
  async start(timeoutMs = 90_000): Promise<string> {
    const child = spawn(process.execPath, ["--import", "tsx", join(MEDIA_ROOT, "test", "support", "run-worker.ts")], {
      cwd: MEDIA_ROOT,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS ?? "", ...this.env },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout?.on("data", (d: Buffer) => (this.output += d.toString("utf8")));
    child.stderr?.on("data", (d: Buffer) => (this.output += d.toString("utf8")));
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const m = /MEDIA_WORKER_READY (\S+)/.exec(this.output);
      if (m?.[1]) return (this.workerId = m[1]);
      if (child.exitCode !== null) throw new Error(`MEDIA_WORKER_EXITED ${child.exitCode}: ${this.output.slice(-2_000)}`);
      if (Date.now() > deadline) throw new Error(`MEDIA_WORKER_NOT_READY: ${this.output.slice(-2_000)}`);
      await sleep(100);
    }
  }

  /** A crash of the worker host: SIGKILL to the whole process group (the worker and its job processes). */
  crash(): void {
    const pid = this.child?.pid;
    if (pid) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child?.pid || child.exitCode !== null) return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      return;
    }
    const deadline = Date.now() + 10_000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await sleep(100);
    this.crash();
  }
}

/* ------------------------------------------------------------------------ */
/* The media plane: dispatch, participants, a synthetic caller                */
/* ------------------------------------------------------------------------ */

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until<T>(what: string, probe: () => Promise<T | null | undefined | false>, timeoutMs = 60_000, everyMs = 250): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe().catch(() => null);
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`TIMEOUT waiting for ${what}`);
    await sleep(everyMs);
  }
}

export const roomService = (l2: Layer2Context) => new RoomServiceClient(l2.url("livekit", 7880), localEnv().livekitApiKey, localEnv().livekitApiSecret);
export const dispatchClient = (l2: Layer2Context) => new AgentDispatchClient(l2.url("livekit", 7880), localEnv().livekitApiKey, localEnv().livekitApiSecret);

/** The runtime's agent participant in the room (kind AGENT), as the server API lists it. */
export async function agentIn(l2: Layer2Context, room: string, notIdentity?: string): Promise<ParticipantInfo | null> {
  const ps = await roomService(l2).listParticipants(room);
  return ps.find((p) => p.kind === 4 && p.state !== 3 && p.identity !== notIdentity) ?? null;
}

/** The typed processing readout the worker publishes on its participant. */
export function readoutOf(p: ParticipantInfo | null): MediaProcessingState | null {
  const raw = p?.attributes?.["vsp.mediaProcessing"];
  return raw ? MediaProcessingState.parse(JSON.parse(raw)) : null;
}

export function healthOf(p: ParticipantInfo | null): { phase: string; inboundFrames: number; inboundPeakDbfs: number; outboundFrames: number } | null {
  const raw = p?.attributes?.["vsp.mediaHealth"];
  return raw ? (JSON.parse(raw) as { phase: string; inboundFrames: number; inboundPeakDbfs: number; outboundFrames: number }) : null;
}

export interface SyntheticCaller {
  room: Room;
  identity: string;
  /** Peak and RMS (dBFS) and frame count of the audio received from the runtime's track. */
  received: { frames: number; peak: number; sumSquares: number; samples: number };
  stop(): Promise<void>;
}

/** A WebRTC caller: joins, publishes a 440 Hz tone at -14 dBFS peak, and measures what the runtime sends back. */
export async function joinCaller(l2: Layer2Context, roomName: string, identity = uniqueName("caller")): Promise<SyntheticCaller> {
  const t = new AccessToken(localEnv().livekitApiKey, localEnv().livekitApiSecret, { identity, ttl: 600 });
  t.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
  const room = new Room();
  const received = { frames: 0, peak: 0, sumSquares: 0, samples: 0 };
  let stopped = false;
  room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
    if (track.kind !== TrackKind.KIND_AUDIO) return;
    void (async () => {
      for await (const frame of new AudioStream(track, { sampleRate: 48_000, numChannels: 1 })) {
        if (stopped) break;
        received.frames++;
        for (const s of frame.data) {
          received.peak = Math.max(received.peak, Math.abs(s));
          received.sumSquares += s * s;
        }
        received.samples += frame.data.length;
      }
    })();
  });
  await room.connect(l2.url("livekit", 7880, "ws"), await t.toJwt(), { autoSubscribe: true, dynacast: false });
  const source = new AudioSource(48_000, 1);
  const track = LocalAudioTrack.createAudioTrack("synthetic-caller-tone", source);
  const opts = new TrackPublishOptions();
  opts.source = TrackSource.SOURCE_MICROPHONE;
  await room.localParticipant?.publishTrack(track, opts);
  void (async () => {
    let n = 0;
    while (!stopped) {
      const data = new Int16Array(480);
      for (let j = 0; j < 480; j++) data[j] = Math.round(6_000 * Math.sin((2 * Math.PI * 440 * n++) / 48_000));
      try {
        await source.captureFrame(new AudioFrame(data, 48_000, 1, 480));
      } catch {
        break;
      }
    }
  })();
  return {
    room,
    identity,
    received,
    async stop() {
      stopped = true;
      await room.disconnect().catch(() => undefined);
    },
  };
}

/* ------------------------------------------------------------------------ */
/* Throwaway egress service                                                   */
/* ------------------------------------------------------------------------ */

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

export const EGRESS_IMAGE = "livekit/egress:v1.15.0@sha256:ac244a40268ce1dd1510fbff6eb529609ec68aceff1602343f79be8ca08c355b";
/** Every image this suite runs is pinned by tag AND digest (never a floating tag such as latest). */
const PINNED_IMAGE = /^[a-z0-9./-]+:v\d+\.\d+\.\d+@sha256:[a-f0-9]{64}$/;

export interface EgressService {
  container: string;
  bucket: string;
  logs(): string;
  remove(): void;
}

/**
 * Starts the egress service for one test file: host network (it must reach livekit-server's 127.0.0.1 ICE
 * candidates), configured from deploy/local/livekit/egress.yaml with the generated local credentials and a
 * unique MinIO bucket the test created. Ready once livekit-server lists it through a trivial ListEgress (it
 * answers once an egress instance registered on the bus).
 */
export async function startEgress(l2: Layer2Context, bucket: string): Promise<EgressService> {
  const env = localEnv();
  const template = readFileSync(join(REPO_ROOT, "deploy", "local", "livekit", "egress.yaml"), "utf8");
  const body = template
    .replaceAll("${VSP_LIVEKIT_API_KEY}", env.livekitApiKey)
    .replaceAll("${VSP_LIVEKIT_API_SECRET}", env.livekitApiSecret)
    .replaceAll("${VSP_VALKEY_PASSWORD}", env.valkeyPassword)
    .replaceAll("${VSP_MINIO_ROOT_USER}", env.minioUser)
    .replaceAll("${VSP_MINIO_ROOT_PASSWORD}", env.minioPassword)
    .replaceAll("${VSP_PORT_LIVEKIT}", String(l2.port("livekit", 7880)))
    .replaceAll("${VSP_PORT_VALKEY}", String(l2.port("valkey", 6379)))
    .replaceAll("${VSP_PORT_MINIO}", String(l2.port("minio", 9000)))
    .replaceAll("${VSP_EGRESS_BUCKET}", bucket)
    .replaceAll("${VSP_EGRESS_TEMPLATE_PORT}", String(await freePort()));
  if (!PINNED_IMAGE.test(EGRESS_IMAGE)) throw new Error("EGRESS_IMAGE_NOT_PINNED");
  // Leftovers of an interrupted run (a container that is no longer running) are removed; a running one may belong to
  // a concurrent run of this suite and is never touched.
  for (const status of ["exited", "created", "dead"]) {
    const stale = spawnSync("docker", ["ps", "-aq", "--filter", "label=io.vsp.test=media-recording", "--filter", `status=${status}`], { encoding: "utf8" }).stdout.split("\n").filter((x) => /^[a-f0-9]{12,64}$/.test(x.trim()));
    for (const id of stale) spawnSync("docker", ["rm", id.trim()], { encoding: "utf8" });
  }
  const container = uniqueName("vsp-it-egress");
  const run = spawnSync("docker", ["run", "-d", "--name", container, "--label", "io.vsp.test=media-recording", "--network", "host", "-e", `EGRESS_CONFIG_BODY=${body}`, EGRESS_IMAGE], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`EGRESS_START_FAILED: ${run.stderr.trim().slice(0, 300)}`);
  return {
    container,
    bucket,
    logs: () => spawnSync("docker", ["logs", "--tail", "200", container], { encoding: "utf8" }).stdout + spawnSync("docker", ["logs", "--tail", "200", container], { encoding: "utf8" }).stderr,
    remove: () => void spawnSync("docker", ["rm", "-f", container], { encoding: "utf8" }),
  };
}
