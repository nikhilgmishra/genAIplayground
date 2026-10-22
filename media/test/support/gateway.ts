/**
 * In-process gateway for the media unit tests (Layer 1, Docker-free).
 *
 * Production code: buildGatewayApp, registerMediaRoutes, RuntimeCredentialVerifier, CallBindingService,
 * CallBindingStore, TrustedSessionService, the AES-256-GCM sealer, and the media worker's own MediaGatewayClient,
 * which reaches the routes through `InjectTransport` (Fastify inject instead of a socket).
 * LOCAL FIXTURE / labelled unit fakes: the in-memory KV (MemoryKvStoreFixture), the media-plane lookup (FakeMediaPlane),
 * the handoff recorder and the audit recorder. The Layer-2 media suite replaces every one of them with the real
 * service (livekit-server, DynamoDB Local, Keycloak, the egress API).
 */
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import type { HandoffService } from "@vsp/platform/src/business/contract.js";
import { RuntimeCredentialVerifier } from "@vsp/platform/src/calls/binding/runtime-auth.js";
import { partyDigestOf } from "@vsp/platform/src/calls/binding/livekit-lookup.js";
import type { BindingAuditEvent, CarrierInteractionLookup, CarrierLookupInput, MediaRoomFacts } from "@vsp/platform/src/calls/binding/ports.js";
import { CallBindingService } from "@vsp/platform/src/calls/binding/service.js";
import { CallBindingStore } from "@vsp/platform/src/calls/binding/store.js";
import { AesGcmTokenSealer } from "@vsp/platform/src/console-api/token-sealer.js";
import type { TransportRequest, TransportResponse } from "@vsp/platform/src/connectors/http/transport.js";
import { buildGatewayApp } from "@vsp/platform/src/gateway/http/app.js";
import { LocalFixtureTokenAuthenticator } from "@vsp/platform/src/gateway/auth.js";
import { registerMediaRoutes, sessionServiceCallSessions } from "@vsp/platform/src/gateway/http/media-routes.js";
import { sessionConfig } from "@vsp/platform/src/identity/config.js";
import { MemoryKvStoreFixture } from "@vsp/platform/src/identity/kv/memory-kv-store.js";
import { TrustedSessionService } from "@vsp/platform/src/identity/session-service.js";
import { silentLogger } from "@vsp/platform/src/observability/logger.js";
import type { ConsentState, IntegrationIdentity } from "@vsp/platform/src/protocol/index.js";
import type { MediaBindingClaim, RecordingDeclinedRoute } from "@vsp/platform/src/protocol/call-binding.js";
import { FakeClock } from "@vsp/platform/src/shared/clock.js";
import { AccessDeniedError, DependencyError } from "@vsp/platform/src/shared/errors.js";
import { MediaGatewayClient } from "../../src/binding/client.js";
import type { MediaTransport } from "../../src/binding/client.js";

type FastifyInstance = Awaited<ReturnType<typeof buildGatewayApp>>;
type GetKey = ConstructorParameters<typeof RuntimeCredentialVerifier>[1]["getKey"];

export const TENANT = "tnt_synthTenantMedia0001";

/** The trusted destinations of the test gateway (SAFE-05). */
export const DESTINATIONS = [
  { destinationId: "dst_support_general", purpose: "STANDARD_SUPPORT" as const, vendorQueueRef: "queue-standard", fallbackDestinationIds: [], languages: ["en"] },
  { destinationId: "dst_safety_priority", purpose: "SAFETY_PRIORITY" as const, vendorQueueRef: "queue-safety", fallbackDestinationIds: [], languages: ["en"] },
];

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** An RS256 access token as the IdP would issue it to the runtime's OAuth client. */
export function signRuntimeToken(privateKey: KeyObject, claims: Record<string, unknown>): string {
  const head = b64url(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" }));
  const body = b64url(JSON.stringify(claims));
  return `${head}.${body}.${b64url(sign("RSA-SHA256", Buffer.from(`${head}.${body}`), privateKey))}`;
}
const ISSUER = "https://idp.vsp.test/realms/media";

/**
 * LOCAL FIXTURE (unit fake) media plane: rooms with one SIP caller each (its `sip.callID` names the call); jobs and
 * agents present per test. Party identities are digested as the production lookup does.
 */
export class FakeMediaPlane implements CarrierInteractionLookup {
  readonly agents = new Set<string>();
  readonly jobs = new Map<string, string>();
  readonly rooms = new Map<string, MediaRoomFacts>();
  private n = 0;
  /** A SIP call room with the caller's SIP participant (identity `sip_synthCaller` unless given). */
  addSipRoom(roomName: string, callId: string, identity = "sip_synthCaller"): void {
    this.n += 1;
    this.rooms.set(roomName, { roomSid: `RM_synthFakeRoom${String(this.n).padStart(4, "0")}`, sipParties: [{ partyDigest: partyDigestOf(identity), interactionRef: callId, routeRef: null, joinedAtMs: 1_000 + this.n }] });
  }
  async verify(i: CarrierLookupInput) {
    const facts = this.rooms.get(i.roomName);
    if (!facts) throw new AccessDeniedError("MEDIA_ROOM_NOT_FOUND");
    if (this.jobs.get(i.jobRef) !== i.agentIdentity) throw new AccessDeniedError("MEDIA_JOB_NOT_DISPATCHED");
    if (!this.agents.has(i.agentIdentity)) throw new AccessDeniedError("MEDIA_AGENT_NOT_IN_ROOM");
    return { ...facts, presentAgents: [...this.agents] };
  }
  async describeRoom(i: { roomName: string }) {
    const facts = this.rooms.get(i.roomName);
    if (!facts) throw new AccessDeniedError("MEDIA_ROOM_NOT_FOUND");
    return facts;
  }
  /** A dispatched job whose agent joined the room. */
  dispatch(jobRef: string): string {
    const identity = `agent-${jobRef}`;
    this.jobs.set(jobRef, identity);
    this.agents.add(identity);
    return identity;
  }
}

/**
 * Labelled unit fake of the HandoffService: records each request for a person or the safety route. Failure injection
 * (labelled): `failing` / `safetyFailing` make the handoff store refuse every request until reset.
 */
export class HandoffRecorder implements Pick<HandoffService, "requestHuman" | "requestSafetyRoute"> {
  readonly human: { callId: string; reason: string }[] = [];
  readonly safety: { callId: string }[] = [];
  failing = false;
  safetyFailing = false;
  async requestHuman(i: Parameters<HandoffService["requestHuman"]>[0]) {
    if (this.failing) throw new DependencyError("HANDOFF_STORE_UNAVAILABLE", "FAILED", true);
    this.human.push({ callId: i.callId, reason: i.reason });
    return { handoffId: "hnd_synthHandoff000001", transferId: null, destinationId: "dst_support_general", journey: null, speechTemplateId: "human.offer", supportReference: null, priority: "STANDARD" as const };
  }
  async requestSafetyRoute(i: Parameters<HandoffService["requestSafetyRoute"]>[0]) {
    if (this.failing || this.safetyFailing) throw new DependencyError("HANDOFF_STORE_UNAVAILABLE", "FAILED", true);
    this.safety.push({ callId: i.callId });
    return { handoffId: "hnd_synthHandoff000002", transferId: null, destinationId: "dst_safety_priority", journey: null, speechTemplateId: "safety.acknowledge", supportReference: null, priority: "SAFETY" as const };
  }
}

/**
 * The media worker's transport, answered by the in-process gateway (Fastify inject). Failure injection (labelled):
 * `failing` refuses every request at the connection; `failNext(n, path)` refuses the next n requests whose path
 * contains `path` (a gateway blip of exactly n requests).
 */
export class InjectTransport implements MediaTransport {
  readonly sent: { path: string; authorization: string | undefined }[] = [];
  failing = false;
  private failures: { left: number; path: string }[] = [];
  private inFlight = 0;
  constructor(private readonly app: FastifyInstance) {}
  /** Requests sent and not yet answered. */
  get pending(): number {
    return this.inFlight;
  }
  failNext(n: number, path: string): void {
    this.failures.push({ left: n, path });
  }
  /** Ends every injected failure (each test starts from a healthy gateway). */
  heal(): void {
    this.failures = [];
    this.failing = false;
  }
  async send(req: TransportRequest): Promise<TransportResponse> {
    const blip = this.failures.find((f) => f.left > 0 && req.url.pathname.includes(f.path));
    if (blip) blip.left -= 1;
    if (this.failing || blip) throw Object.assign(new Error("ECONNREFUSED"), { reasonCode: "TRANSPORT_CONNECT_FAILED", requestSent: false });
    this.sent.push({ path: req.url.pathname, authorization: req.headers.authorization });
    this.inFlight += 1;
    try {
      const r = await this.app.inject({ method: req.method, url: req.url.pathname, headers: { ...req.headers }, payload: req.body ?? undefined });
      return { status: r.statusCode, headers: {}, body: r.rawPayload };
    } finally {
      this.inFlight -= 1;
    }
  }
}

export interface GatewayHarness {
  app: FastifyInstance;
  clock: FakeClock;
  plane: FakeMediaPlane;
  handoff: HandoffRecorder;
  audits: BindingAuditEvent[];
  transport: InjectTransport;
  client: MediaGatewayClient;
  bindings: CallBindingService;
  /** A valid runtime access token (as the IdP would issue it now). */
  token(): Promise<string>;
  /** Grants recording and AI processing as the trusted consent capture would (the voice agent's consent step). */
  grant(claim: MediaBindingClaim, o?: { recording?: ConsentState["recording"]; processing?: ConsentState["automatedProcessing"] }): Promise<void>;
  /** A control-plane session change outside the media path (e.g. TC-03 through the Studio flow): the generation advances. */
  changeSession(claim: MediaBindingClaim): Promise<void>;
  /** The control plane revokes the call's session (e.g. a fraud hold): the binding can no longer be held. */
  revokeSession(claim: MediaBindingClaim): Promise<void>;
  /**
   * Resolves once no worker request is in flight for a few event-loop turns (the worker's handling of an answer may
   * send the next request), bounded by `maxMs`: the manual timers wait for the gateway's answers this way instead of a
   * fixed sleep, so a loaded host does not turn a heartbeat answer that arrives late into a failed assertion.
   */
  idle(maxMs?: number): Promise<void>;
  close(): Promise<void>;
}

export async function startGateway(o: { recordingDeclinedRoute?: RecordingDeclinedRoute } = {}): Promise<GatewayHarness> {
  const clock = new FakeClock("2026-10-21T12:00:00.000Z");
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const getKey = (async () => publicKey) as unknown as GetKey;
  const kv = new MemoryKvStoreFixture();
  const sessions = new TrustedSessionService({ kv, clock, config: sessionConfig({ tenantId: TENANT, environment: "ci", policyVersion: "policy-ci-2026.10.21", startCallChannels: ["telephony_control"], consentChannels: ["telephony_control"], resolveChannels: ["telephony_control"] }) });
  const carrierIntegration: IntegrationIdentity = { integrationId: "livekit-media-plane", tenantId: TENANT, environment: "ci", channel: "telephony_control", credentialId: "cred-media-plane-01", authMethod: "mtls" };
  const plane = new FakeMediaPlane();
  const handoff = new HandoffRecorder();
  const audits: BindingAuditEvent[] = [];
  const bindings = new CallBindingService(
    { tenantId: TENANT, environment: "ci", bindingTtlSeconds: 30, heartbeatIntervalSeconds: 5, recordingDeclinedRoute: o.recordingDeclinedRoute ?? "CONTINUE_UNRECORDED" },
    {
      store: new CallBindingStore(kv),
      sessions: sessionServiceCallSessions(sessions, carrierIntegration, clock),
      lookup: plane,
      sealer: new AesGcmTokenSealer({ current: { id: "k1", key: randomBytes(32) } }),
      actions: { invalidatePending: async () => 0 },
      audit: { record: async (e) => void audits.push(e) },
      clock,
    },
  );
  const app = await buildGatewayApp({ logger: silentLogger, authenticator: new LocalFixtureTokenAuthenticator({ environment: "ci", tenantId: TENANT }), routes: [], rateLimit: { max: 1_000, timeWindowMs: 60_000 }, clock });
  registerMediaRoutes(app, {
    tenantId: TENANT,
    clock,
    logger: silentLogger,
    runtimeAuth: new RuntimeCredentialVerifier(
      { environment: "ci", tenantId: TENANT, issuer: ISSUER, audience: "vsp-gateway-ci", algorithms: ["RS256"], clockToleranceSeconds: 5, maxTokenAgeSeconds: 600, clientIdClaim: "azp", scope: "vsp.conversation_runtime", clients: [{ clientId: "vsp-media-runtime", integrationId: "vsp-media-runtime", credentialId: "cred-media-runtime-01", adapters: ["controlled_cascade_runtime"] }] },
      { clock, getKey },
    ),
    bindings,
    handoff,
    destinations: DESTINATIONS,
    rateLimit: { max: 1_000, timeWindowMs: 60_000 },
    audit: { record: async (e) => void audits.push(e) },
  });
  await app.ready();
  const token = async () => {
    const now = Math.floor(clock.now().getTime() / 1000);
    return signRuntimeToken(privateKey, { azp: "vsp-media-runtime", scope: "vsp.conversation_runtime", iss: ISSUER, aud: "vsp-gateway-ci", iat: now, exp: now + 300 });
  };
  const transport = new InjectTransport(app);
  const client = new MediaGatewayClient({ baseUrl: "https://gateway.vsp.test", transport, credential: token, addressClass: "PRIVATE_NETWORK" });
  return {
    app,
    clock,
    plane,
    handoff,
    audits,
    transport,
    client,
    bindings,
    token,
    async grant(claim, g = {}) {
      const identity = { integrationId: "vsp-media-runtime", tenantId: TENANT, environment: "ci" as const, channel: "conversation_runtime" as const, credentialId: "cred-media-runtime-01", authMethod: "oauth2_client_credentials" as const, adapters: ["controlled_cascade_runtime" as const] };
      const sessionRef = (await bindings.resolveClaim(identity, claim)).sessionRef;
      await sessions.recordConsent(sessionRef, carrierIntegration, {
        recording: g.recording ?? "GRANTED",
        automatedProcessing: g.processing ?? "GRANTED",
        disclosureTemplateVersion: "disclosure-en-v3",
        capturedAt: clock.now().toISOString(),
        capturedBy: "studio_flow",
      });
    },
    async changeSession(claim) {
      const identity = { integrationId: "vsp-media-runtime", tenantId: TENANT, environment: "ci" as const, channel: "conversation_runtime" as const, credentialId: "cred-media-runtime-01", authMethod: "oauth2_client_credentials" as const, adapters: ["controlled_cascade_runtime" as const] };
      const sessionRef = (await bindings.resolveClaim(identity, claim)).sessionRef;
      await sessions.applyChange(sessionRef, carrierIntegration, { kind: "PARTICIPANT_CHANGED" });
    },
    async revokeSession(claim) {
      const identity = { integrationId: "vsp-media-runtime", tenantId: TENANT, environment: "ci" as const, channel: "conversation_runtime" as const, credentialId: "cred-media-runtime-01", authMethod: "oauth2_client_credentials" as const, adapters: ["controlled_cascade_runtime" as const] };
      const sessionRef = (await bindings.resolveClaim(identity, claim)).sessionRef;
      await sessions.revoke(sessionRef, "FRAUD_REVIEW_HOLD");
    },
    async idle(maxMs = 5_000) {
      const end = Date.now() + maxMs;
      for (let quiet = 0; quiet < 3 && Date.now() <= end; ) {
        await new Promise((r) => (transport.pending === 0 ? setImmediate(r) : setTimeout(r, 2)));
        quiet = transport.pending === 0 ? quiet + 1 : 0;
      }
    },
    close: () => app.close(),
  };
}
