/**
 * Gateway media routes (WP-11; FO-05-16, FO-10-09, FO-10-46, FO-01-27; ADR-0018 decisions 1.4 and 1.6).
 *
 * The conversation runtime (media/ worker) reaches the control plane only here, with its own OAuth2 integration
 * identity on the `conversation_runtime` channel (RuntimeCredentialVerifier, calls/binding/runtime-auth.ts) and the
 * server-issued CallBinding claim:
 *
 *   POST /media/v1/calls/bindings                          issue, or after the previous owner was lost re-issue
 *                                                          with a new session generation (CallBindingService.bind)
 *   POST /media/v1/calls/bindings/:bindingId/heartbeat     renew; follow the session generation; processing directive
 *   POST /media/v1/calls/bindings/:bindingId/events        call lifecycle (TC-01/TC-03/TC-11 equivalents)
 *   POST /media/v1/calls/bindings/:bindingId/consent       caller declined or revoked a processing dimension
 *   POST /media/v1/calls/bindings/:bindingId/processing    MediaProcessingState readout; a mismatch routes to a person
 *   POST /media/v1/calls/recorders                         the call's recorders and consent for a runtime refused into a
 *                                                          person route (job-checked, issues nothing; DATA-03)
 *   POST /media/v1/calls/human-route                       a person, WITHOUT a binding or session (SAFE-02)
 *   POST /media/v1/calls/safety-route                      the safety route, WITHOUT a binding or session (SAFE-02)
 *
 * Every route authenticates the runtime BEFORE the body is parsed (preValidation, like registerRoutes in route.ts),
 * parses strict bodies, validates its own response (fail closed) and answers errors with reason codes only. A stale
 * claim (old generation or fencing token, superseded or ended binding) is refused with 409 (AUTH-03, AUTH-04). The
 * human and safety routes never require a live binding, are exempt from the rate limit and take their destination
 * only from trusted configuration (SAFE-02, SAFE-03, SAFE-05). There is no fixture credential and no development
 * bypass: the routes exist only when a RuntimeCredentialVerifier is composed.
 *
 * The human and safety routes (and the supervisor's platform-internal human route) share one person router
 * (`personRouter`): the room must exist (a room the media plane positively reports gone is refused,
 * MEDIA_ROOM_NOT_FOUND; a media plane that cannot be asked still routes, unattributed); the request is recorded for
 * the room BEFORE the handoff is attempted (CallBindingService.notePersonRequested), so a runtime that gives up, a
 * re-dispatched runtime and the supervisor all see that a person is owed; a safety route still owed is retried before
 * a standard person; an accepted request is answered again from the record instead of creating a second handoff for
 * the room, and while one request is attempting the room's handoff (an attempt lease written with the request) any
 * other is answered HANDOFF_IN_PROGRESS (not accepted: the asker retries), so concurrent requests (a live owner told
 * that a person is owed, the supervisor's route, a replacement) never start a second handoff (at most one standard and
 * one safety handoff per room).
 *
 * The routes are a Fastify plugin (`registerMediaRoutes`) because the runtime channel is not one of the
 * IntegrationIdentity channels registerRoutes authenticates; MEDIA_ROUTE_SPECS describes them for the OpenAPI
 * document (hand-off to the registry owner). The composition root (WP-17) registers them on the gateway app.
 */
import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { HandoffService } from "../../business/contract.js";
import { RuntimeAuthenticationError } from "../../calls/binding/runtime-auth.js";
import type { BindingAuditEvent, BindingAuditSink, CallSessionPort, CallSessionView, PendingActionInvalidator, RuntimeIdentity, RuntimeSessionChange } from "../../calls/binding/ports.js";
import type { CallBindingService, PersonWanted } from "../../calls/binding/service.js";
import type { PersonRequest, PersonState } from "../../calls/binding/store.js";
import type { DestinationConfig } from "../../config/ports.js";
import type { IntegrationIdentity, TransferReason } from "../../protocol/index.js";
import { consentProfileFromSession } from "../../protocol/common.js";
import type { ConsentState } from "../../protocol/common.js";
import {
  MediaBindRequest,
  MediaBindResponse,
  MediaConsentDecisionRequest,
  MediaConsentDecisionResponse,
  MediaHeartbeatRequest,
  MediaHeartbeatResponse,
  MediaHumanRouteRequest,
  MediaLifecycleRequest,
  MediaLifecycleResponse,
  MediaProcessingReportRequest,
  MediaProcessingReportResponse,
  MediaRecorderCheckRequest,
  MediaRecorderCheckResponse,
  MediaRouteResponse,
  MediaSafetyRouteRequest,
} from "../../protocol/call-binding.js";
import type { MediaHumanRouteReason } from "../../protocol/call-binding.js";
import type { Clock } from "../../shared/clock.js";
import { AuditUnavailableError, DependencyError, PlatformError, SessionInvalidError } from "../../shared/errors.js";
import { newId } from "../../shared/ids.js";
import { sessionRefHash } from "../../identity/keys.js";
import { bindingProblem, lifecycleProblem } from "../../identity/session-store.js";
import type { TrustedSessionService } from "../../identity/session-service.js";
import type { Logger } from "../../observability/ports.js";
import type { GatewayAudit } from "../gateway-audit.js";
import { errorBody, statusForError } from "./route.js";

/* ------------------------------------------------------------------ route table */

interface MediaRouteSpec {
  operationId: string;
  method: "POST";
  path: string;
  summary: string;
  body: z.ZodType;
  /** Success status and schema; error statuses carry ErrorBody (reason code only). */
  success: { status: number; schema: z.ZodType };
  bindingPath: boolean;
  /** Exempt from the per-integration rate limit (human and safety routes, SAFE-02/SAFE-03). */
  rateLimitExempt: boolean;
}

const BindingIdParams = z.strictObject({ bindingId: z.string().regex(/^cbd_[A-Za-z0-9_-]{16,64}$/) });

export const MEDIA_ROUTE_SPECS: readonly MediaRouteSpec[] = [
  { operationId: "media.bind", method: "POST", path: "/media/v1/calls/bindings", summary: "Issue (or after owner loss re-issue with a new session generation) the CallBinding of a dispatched room job.", body: MediaBindRequest, success: { status: 201, schema: MediaBindResponse }, bindingPath: false, rateLimitExempt: false },
  { operationId: "media.heartbeat", method: "POST", path: "/media/v1/calls/bindings/:bindingId/heartbeat", summary: "Renew the binding, follow the session generation and return the processing directive.", body: MediaHeartbeatRequest, success: { status: 200, schema: MediaHeartbeatResponse }, bindingPath: true, rateLimitExempt: false },
  { operationId: "media.lifecycle", method: "POST", path: "/media/v1/calls/bindings/:bindingId/events", summary: "Call lifecycle event: participant change (new generation), hold, transfer leg, media loss, hang-up.", body: MediaLifecycleRequest, success: { status: 200, schema: MediaLifecycleResponse }, bindingPath: true, rateLimitExempt: false },
  { operationId: "media.consentDecision", method: "POST", path: "/media/v1/calls/bindings/:bindingId/consent", summary: "The caller declined or revoked recording or AI processing on the media path.", body: MediaConsentDecisionRequest, success: { status: 200, schema: MediaConsentDecisionResponse }, bindingPath: true, rateLimitExempt: false },
  { operationId: "media.processingReport", method: "POST", path: "/media/v1/calls/bindings/:bindingId/processing", summary: "MediaProcessingState readout; a mismatch with consent or disclosure routes the call to a person.", body: MediaProcessingReportRequest, success: { status: 200, schema: MediaProcessingReportResponse }, bindingPath: true, rateLimitExempt: false },
  { operationId: "media.recorders", method: "POST", path: "/media/v1/calls/recorders", summary: "The call's recorders and their consent for a runtime refused into a person route (no binding is issued); it may report a recorder the consent does not permit.", body: MediaRecorderCheckRequest, success: { status: 200, schema: MediaRecorderCheckResponse }, bindingPath: false, rateLimitExempt: false },
  { operationId: "media.humanRoute", method: "POST", path: "/media/v1/calls/human-route", summary: "A person for the call; never requires a binding or session (SAFE-02); destination from trusted configuration (SAFE-05).", body: MediaHumanRouteRequest, success: { status: 200, schema: MediaRouteResponse }, bindingPath: false, rateLimitExempt: true },
  { operationId: "media.safetyRoute", method: "POST", path: "/media/v1/calls/safety-route", summary: "The safety route for the call; never requires a binding or session (SAFE-02).", body: MediaSafetyRouteRequest, success: { status: 200, schema: MediaRouteResponse }, bindingPath: false, rateLimitExempt: true },
];

/* ------------------------------------------------------------------ dependencies */

export interface RuntimeAuthenticator {
  authenticate(authorizationHeader: string | undefined): Promise<RuntimeIdentity>;
}

export interface MediaRouteDeps {
  tenantId: string;
  clock: Clock;
  logger: Logger;
  runtimeAuth: RuntimeAuthenticator;
  bindings: CallBindingService;
  handoff: Pick<HandoffService, "requestHuman" | "requestSafetyRoute">;
  destinations: readonly DestinationConfig[];
  /** Per-runtime-credential limit for the binding routes (the human and safety routes are never limited); null disables it. */
  rateLimit: { max: number; timeWindowMs: number } | null;
  audit: BindingAuditSink;
  /** Optional observer of accepted human/safety routes (call-state handoff index). */
  onRoute?: (interactionId: string, route: { handoffId: string | null; destinationId: string; priority: "SAFETY" | "STANDARD" }) => void;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Authenticated conversation-runtime identity (media routes only). */
    vspRuntime?: RuntimeIdentity | null;
  }
}

const HUMAN_REASON: Record<MediaHumanRouteReason, TransferReason> = {
  CALLER_REQUESTED_HUMAN: "CALLER_REQUESTED_HUMAN",
  CONSENT_DECLINED_ALTERNATIVE: "CONSENT_DECLINED_ALTERNATIVE",
  PROCESSING_MISMATCH: "POLICY_REQUIRES_HUMAN",
  RECOVERY_FAILED: "DEPENDENCY_FAILURE",
  BINDING_UNAVAILABLE: "DEPENDENCY_FAILURE",
  AI_UNAVAILABLE: "AI_UNAVAILABLE",
};

/**
 * Per-call rate-limit bucket of the binding routes (runs after authentication, preHandler): the runtime credential
 * plus the binding of the path, or a digest of the room for issuance. A bucket shared by every call of the runtime
 * would turn load on one call into refused heartbeats, then expired bindings, then human routes on every other.
 */
function rateLimitKey(req: FastifyRequest, bindingPath: boolean): string {
  const runtime = req.vspRuntime?.integrationId ?? "anonymous";
  if (bindingPath) {
    const id = (req.params as { bindingId?: unknown } | undefined)?.bindingId;
    return `runtime:${runtime}:binding:${typeof id === "string" ? id.slice(0, 80) : "unknown"}`;
  }
  const room = (req.body as { roomName?: unknown } | null | undefined)?.roomName;
  return `runtime:${runtime}:room:${typeof room === "string" ? createHash("sha256").update(room, "utf8").digest("hex").slice(0, 32) : "unknown"}`;
}

const authStatus = (err: unknown): { status: number; reasonCode: string } =>
  err instanceof RuntimeAuthenticationError ? { status: 401, reasonCode: err.reasonCode } : statusForError(err);

type RouteAnswer = z.infer<typeof MediaRouteResponse>;

/**
 * How long one request holds the room's handoff attempt (the handoff service's own bound on a request is shorter); a
 * holder that died mid-attempt delays the next attempt by at most this much.
 */
export const PERSON_ATTEMPT_LEASE_MS = 15_000;

/**
 * The HandoffService's answer when it placed no transfer (business/handoff.ts: no destination resolves, or the transfer
 * request failed): the next-route prompt with no journey.
 */
const HANDOFF_NOT_PLACED_TEMPLATE = "transfer.failed_next_route";

export interface PersonRouterDeps {
  tenantId: string;
  clock: Clock;
  logger: Logger;
  bindings: Pick<CallBindingService, "roomForRoute" | "notePersonRequested" | "notePersonAccepted" | "notePersonAttemptEnded">;
  handoff: Pick<HandoffService, "requestHuman" | "requestSafetyRoute">;
  destinations: readonly DestinationConfig[];
  audit: BindingAuditSink;
  /** Optional observer of accepted human/safety routes (call-state handoff index). */
  onRoute?: MediaRouteDeps["onRoute"];
}

/**
 * The person router of the session-less routes (SAFE-02): records the request for the room, retries what the room is
 * still owed (a safety route first), answers an accepted request from the record, and requests the handoff otherwise.
 * Never requires a binding or session; audit and the record never block the route.
 */
export function personRouter(d: PersonRouterDeps): (roomName: string, want: PersonWanted, correlationId: string) => Promise<RouteAnswer> {
  const standardDest = d.destinations.find((x) => x.purpose === "STANDARD_SUPPORT")?.destinationId ?? "dst_support_general";
  const safetyDest = d.destinations.find((x) => x.purpose === "SAFETY_PRIORITY")?.destinationId ?? "dst_safety_priority";
  const audit = async (e: Omit<BindingAuditEvent, "tenantId">): Promise<void> => {
    try {
      await d.audit.record({ ...e, tenantId: d.tenantId });
    } catch {
      // The route has already been initiated: audit never blocks a person or the safety route (SAFE-02).
      d.logger.error("gateway.media.route_audit_unwritten", { reasonCode: "AUDIT_UNAVAILABLE", action: e.action });
    }
  };
  return async (roomName, want, correlationId) => {
    // A room the media plane reports gone is refused (MEDIA_ROOM_NOT_FOUND propagates); a media plane that cannot be
    // asked still routes, under a fresh, unattributed interaction.
    const room = await d.bindings.roomForRoute(roomName);
    if (!room.attributed) d.logger.warn("gateway.media.route_unattributed", { reasonCode: room.reasonCode ?? "MEDIA_PLANE_UNAVAILABLE" });
    const at = room.roomSid ? { roomSid: room.roomSid, interactionId: room.interactionId } : null;
    const interactionId = room.interactionId;
    // This request's claim on the room's handoff attempt (one handoff in flight per room).
    const holder = newId("cpa");
    let recorded: PersonRequest | null = null;
    if (at) {
      try {
        recorded = await d.bindings.notePersonRequested(at, want, { holder, leaseMs: PERSON_ATTEMPT_LEASE_MS });
      } catch (err) {
        // Never a reason to withhold the person: the route goes ahead unrecorded.
        d.logger.error("gateway.media.person_request_unrecorded", { reasonCode: err instanceof PlatformError ? err.reasonCode : "UNCLASSIFIED_ERROR" });
      }
    }
    const action = want.kind === "safety" ? "media.route.safety_requested" : "media.route.human_requested";
    // An accepted request answers again (no second handoff for the room), unless a safety route is still owed.
    const owedSafety = recorded?.safety?.state === "OUTSTANDING";
    const accepted = !owedSafety && recorded ? (recorded.safety?.state === "ACCEPTED" ? recorded.safety.handoff : want.kind === "standard" && recorded.standard?.state === "ACCEPTED" ? recorded.standard.handoff : null) : null;
    if (accepted) {
      await audit({ action, outcome: "SUCCEEDED", interactionId, bindingId: null, sessionBindingRef: null, sessionGeneration: null, reasonCode: "HANDOFF_ALREADY_ACCEPTED", correlationId });
      return { accepted: true, destinationId: accepted.destinationId, handoffId: accepted.handoffId, speechTemplateId: accepted.speechTemplateId, reasonCode: "HANDOFF_ALREADY_ACCEPTED" };
    }
    // What is attempted: the safety route still owed, else the request as first recorded (its reason and language).
    const attempt: PersonWanted =
      recorded?.safety?.state === "OUTSTANDING"
        ? { kind: "safety", signals: recorded.safety.signals, locale: recorded.safety.locale }
        : want.kind === "standard" && recorded?.standard
          ? { kind: "standard", reason: recorded.standard.reason, language: recorded.standard.language }
          : want;
    // Another request for the room is attempting this handoff right now (its attempt has not lapsed): no second
    // handoff; the asker retries and is then answered from the record (accepted) or attempts itself (the other failed).
    const slot = recorded ? (attempt.kind === "safety" ? recorded.safety : recorded.standard) : null;
    if (slot?.state === "OUTSTANDING" && slot.attempt && slot.attempt.holder !== holder && slot.attempt.untilMs > d.clock.now().getTime()) {
      await audit({ action, outcome: "SUCCEEDED", interactionId, bindingId: null, sessionBindingRef: null, sessionGeneration: null, reasonCode: "HANDOFF_IN_PROGRESS", correlationId });
      return attempt.kind === "safety"
        ? { accepted: false, destinationId: safetyDest, handoffId: null, speechTemplateId: "safety.fallback_transfer", reasonCode: "HANDOFF_IN_PROGRESS" }
        : { accepted: false, destinationId: standardDest, handoffId: null, speechTemplateId: "human.offer", reasonCode: "HANDOFF_IN_PROGRESS" };
    }
    const note = async (kind: "standard" | "safety", handoff: { handoffId: string | null; destinationId: string; speechTemplateId: string }): Promise<void> => {
      if (!at) return;
      await d.bindings.notePersonAccepted(at, kind, handoff, attempt).catch((err: unknown) => {
        d.logger.error("gateway.media.person_request_unrecorded", { reasonCode: err instanceof PlatformError ? err.reasonCode : "UNCLASSIFIED_ERROR" });
      });
    };
    // A failed attempt gives the room's attempt up at once (best effort; otherwise it lapses).
    const released = async (kind: "standard" | "safety"): Promise<void> => {
      if (!at || !recorded) return;
      await d.bindings.notePersonAttemptEnded(at, kind, holder).catch(() => undefined);
    };
    if (attempt.kind === "safety") {
      try {
        const r = await d.handoff.requestSafetyRoute({
          tenantId: d.tenantId,
          callId: interactionId,
          ctx: null,
          signals: attempt.signals.map((sig) => ({ ...sig, locale: attempt.locale })),
          locale: attempt.locale,
          validatedAt: d.clock.now(),
          decisionReasonCode: "MEDIA_RUNTIME_SAFETY_SIGNAL",
          correlationId,
        });
        await note("safety", { handoffId: r.handoffId, destinationId: r.destinationId, speechTemplateId: r.speechTemplateId });
        d.onRoute?.(interactionId, { handoffId: r.handoffId, destinationId: r.destinationId, priority: "SAFETY" });
        await audit({ action: "media.route.safety_requested", outcome: "SUCCEEDED", interactionId, bindingId: null, sessionBindingRef: null, sessionGeneration: null, reasonCode: room.attributed ? "SAFETY_ROUTE_INITIATED" : "ROUTE_UNATTRIBUTED", correlationId });
        return { accepted: true, destinationId: r.destinationId, handoffId: r.handoffId, speechTemplateId: r.speechTemplateId, reasonCode: "SAFETY_ROUTE_INITIATED" };
      } catch (err) {
        await released("safety");
        d.logger.error("gateway.media.safety_route_failed", { reasonCode: err instanceof PlatformError ? err.reasonCode : "UNCLASSIFIED_ERROR" });
        await audit({ action: "media.route.safety_requested", outcome: "FAILED", interactionId, bindingId: null, sessionBindingRef: null, sessionGeneration: null, reasonCode: "SAFETY_ROUTE_FAILED", correlationId });
        // Never silence: the worker plays the fallback safety clip and the carrier route goes to the safety queue.
        return { accepted: false, destinationId: safetyDest, handoffId: null, speechTemplateId: "safety.fallback_transfer", reasonCode: "SAFETY_ROUTE_FAILED" };
      }
    }
    try {
      const r = await d.handoff.requestHuman({ tenantId: d.tenantId, callId: interactionId, ctx: null, reason: HUMAN_REASON[attempt.reason], language: attempt.language, issueCategory: null });
      // No transfer was placed (no destination resolves for the request, or the transfer request itself failed): the
      // HandoffService answers with the next-route prompt and no journey. Nobody is coming, so the room is NOT recorded
      // as with a person (the runtime would go silent and the supervisor would leave the caller alone): the request
      // stays owed, the attempt is released, and the runtime, its replacement or the supervisor asks again (SAFE-02).
      if (r.journey === null && r.speechTemplateId === HANDOFF_NOT_PLACED_TEMPLATE) {
        await released("standard");
        d.logger.error("gateway.media.human_route_not_placed", { reasonCode: r.destinationId === "dst_unconfigured" ? "DESTINATION_NOT_CONFIGURED" : "TRANSFER_NOT_PLACED" });
        await audit({ action: "media.route.human_requested", outcome: "FAILED", interactionId, bindingId: null, sessionBindingRef: null, sessionGeneration: null, reasonCode: "HANDOFF_NOT_PLACED", correlationId });
        return { accepted: false, destinationId: standardDest, handoffId: null, speechTemplateId: HANDOFF_NOT_PLACED_TEMPLATE, reasonCode: "HANDOFF_NOT_PLACED" };
      }
      await note("standard", { handoffId: r.handoffId, destinationId: r.destinationId, speechTemplateId: r.speechTemplateId });
      d.onRoute?.(interactionId, { handoffId: r.handoffId, destinationId: r.destinationId, priority: r.priority ?? "STANDARD" });
      await audit({ action: "media.route.human_requested", outcome: "SUCCEEDED", interactionId, bindingId: null, sessionBindingRef: null, sessionGeneration: null, reasonCode: room.attributed ? attempt.reason : "ROUTE_UNATTRIBUTED", correlationId });
      return { accepted: true, destinationId: r.destinationId, handoffId: r.handoffId, speechTemplateId: r.speechTemplateId, reasonCode: "HANDOFF_REQUESTED" };
    } catch (err) {
      await released("standard");
      d.logger.error("gateway.media.human_route_failed", { reasonCode: err instanceof PlatformError ? err.reasonCode : "UNCLASSIFIED_ERROR" });
      await audit({ action: "media.route.human_requested", outcome: "FAILED", interactionId, bindingId: null, sessionBindingRef: null, sessionGeneration: null, reasonCode: "HANDOFF_REQUEST_FAILED", correlationId });
      // The request stays recorded as owed: the runtime, its replacement or the supervisor retries it.
      return { accepted: false, destinationId: standardDest, handoffId: null, speechTemplateId: "human.offer", reasonCode: "HANDOFF_REQUEST_FAILED" };
    }
  };
}

/**
 * The session-less human route for the media-plane supervisor (calls/binding/supervisor.ts): a room whose runtime
 * was lost and not recovered, or whose caller is still owed a person, goes to a person (SAFE-02). Platform-internal: no
 * runtime credential is involved. It retries what the room is owed (the safety route first, else the first recorded
 * request), never creates a second handoff for a room whose request was accepted, and throws when no person was
 * requested so the supervisor retries on its next sweep. A room the media plane reports gone has no caller to route.
 */
export function supervisorHumanRoute(d: Omit<PersonRouterDeps, "onRoute"> & { language: string; onRoute?: MediaRouteDeps["onRoute"] }): (roomName: string) => Promise<void> {
  const route = personRouter(d);
  return async (roomName) => {
    const answer = await route(roomName, { kind: "standard", reason: "RECOVERY_FAILED", language: d.language }, newId("cor"));
    if (!answer.accepted) throw new DependencyError(answer.reasonCode, "FAILED", true);
    d.logger.warn("gateway.media.supervisor_human_route", { reasonCode: answer.reasonCode, destinationId: answer.destinationId });
  };
}

/** The supervisor's check of a room's person request before it re-dispatches the AI (CallBindingService.personStateOfRoom). */
export function supervisorPersonState(bindings: Pick<CallBindingService, "personStateOfRoom">): (room: { name: string; sid: string }) => Promise<PersonState> {
  return (room) => bindings.personStateOfRoom({ sid: room.sid });
}

/** The supervisor's end of a call whose caller left the room (CallBindingService.endRoom), with its own correlation id. */
export function supervisorEndCall(bindings: Pick<CallBindingService, "endRoom">): (roomName: string) => Promise<unknown> {
  return (roomName) => bindings.endRoom(roomName, newId("cor"));
}

/* ------------------------------------------------------------------ plugin */

/** Registers the media routes on the gateway app (call after buildGatewayApp, before listen). */
export function registerMediaRoutes(app: FastifyInstance, d: MediaRouteDeps): void {
  const route = personRouter({ tenantId: d.tenantId, clock: d.clock, logger: d.logger, bindings: d.bindings, handoff: d.handoff, destinations: d.destinations, audit: d.audit, onRoute: d.onRoute });

  const handlers: Record<string, (identity: RuntimeIdentity, body: never, requestId: string) => Promise<unknown>> = {
    "media.bind": (identity, body: MediaBindRequest, requestId) => d.bindings.bind(identity, body, requestId),
    "media.heartbeat": (identity, body: z.infer<typeof MediaHeartbeatRequest>, requestId) => d.bindings.heartbeat(identity, body.claim, requestId),
    "media.lifecycle": (identity, body: MediaLifecycleRequest, requestId) => d.bindings.lifecycle(identity, body, requestId),
    "media.consentDecision": (identity, body: MediaConsentDecisionRequest, requestId) => d.bindings.consentDecision(identity, body, requestId),
    "media.processingReport": (identity, body: MediaProcessingReportRequest, requestId) => d.bindings.reportProcessing(identity, body, requestId),
    "media.recorders": (identity, body: MediaRecorderCheckRequest, requestId) => d.bindings.recordersOfJob(identity, body, requestId),
    "media.humanRoute": (_identity, body: MediaHumanRouteRequest, requestId) => route(body.roomName, { kind: "standard", reason: body.reason, language: body.language }, requestId),
    "media.safetyRoute": (_identity, body: MediaSafetyRouteRequest, requestId) => route(body.roomName, { kind: "safety", signals: body.signals, locale: body.locale }, requestId),
  };

  for (const spec of MEDIA_ROUTE_SPECS) {
    const handler = handlers[spec.operationId];
    if (!handler) throw new Error(`media route without handler: ${spec.operationId}`);
    const limit =
      d.rateLimit && !spec.rateLimitExempt
        ? { rateLimit: { max: d.rateLimit.max, timeWindow: d.rateLimit.timeWindowMs, keyGenerator: (req: FastifyRequest) => rateLimitKey(req, spec.bindingPath) } }
        : {};
    app.route({
      method: spec.method,
      url: spec.path,
      config: { vspOperationId: spec.operationId, vspRateLimitExempt: spec.rateLimitExempt, ...limit },
      preValidation: async (req: FastifyRequest, reply: FastifyReply) => {
        req.vspRuntime = null;
        const h = req.headers.authorization;
        try {
          req.vspRuntime = await d.runtimeAuth.authenticate(typeof h === "string" ? h : undefined);
        } catch (err) {
          const { status, reasonCode } = authStatus(err);
          d.logger.warn("gateway.media.auth_failed", { reasonCode, action: spec.operationId });
          return reply.code(status).header("www-authenticate", 'Bearer realm="vsp-gateway"').send(errorBody(reasonCode, req.id));
        }
      },
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const identity = req.vspRuntime;
        if (!identity) return reply.code(401).send(errorBody("RUNTIME_CREDENTIAL_MISSING", req.id));
        const parsed = spec.body.safeParse(req.body);
        if (!parsed.success) return reply.code(400).send(errorBody("INVALID_REQUEST_BODY", req.id));
        if (spec.bindingPath) {
          const params = BindingIdParams.safeParse(req.params ?? {});
          const claimed = (parsed.data as { claim?: { bindingId?: unknown } }).claim?.bindingId;
          if (!params.success || params.data.bindingId !== claimed) return reply.code(400).send(errorBody("BINDING_PATH_MISMATCH", req.id));
        }
        let result: unknown;
        try {
          result = await handler(identity, parsed.data as never, req.id);
        } catch (err) {
          const { status, reasonCode } = statusForError(err);
          return reply.code(status).send(errorBody(reasonCode, req.id));
        }
        if (!spec.success.schema.safeParse(result).success) return reply.code(500).send(errorBody("RESPONSE_SCHEMA_VIOLATION", req.id));
        return reply.code(spec.success.status).send(result);
      },
    });
  }
}

/* ------------------------------------------------------------------ adapters for the composition root */

/**
 * The control-plane SessionService as the binding service's CallSessionPort, under the trusted carrier integration
 * identity of the media plane (a telephony_control credential that only the gateway holds; the runtime's own
 * credential never reaches the session service). `view` reads without counting as caller activity (as the Auth Gate
 * read does), so heartbeats never extend the idle window of verified privileges (FO-05-18).
 *
 * Owner recovery uses the session service's ACCOUNT_SWITCH change: privileges dropped, generation advanced, consent
 * kept, no account-recovery risk flag (the caller did not change). A dedicated RUNTIME_RECOVERY change kind is a
 * hand-off to the identity owner.
 */
export function sessionServiceCallSessions(sessions: TrustedSessionService, integration: IntegrationIdentity, clock: Clock): CallSessionPort {
  const UNDECIDED: ConsentState = { recording: "UNKNOWN", automatedProcessing: "UNKNOWN", disclosureTemplateVersion: null, capturedAt: null, capturedBy: "none" };
  const viewOf = (generation: number, expiresAt: string, consent: ConsentState): CallSessionView => {
    const profile = consentProfileFromSession(consent);
    const pick = (s: (typeof profile)["recording"]) => ({ value: s.value, expiresAt: s.expiresAt, capturedAt: s.capturedAt, templateVersion: s.templateVersion });
    return { sessionGeneration: generation, expiresAt, consent: { recording: pick(profile.recording), transcriptionAiProcessing: pick(profile.transcriptionAiProcessing), disclosureTemplateVersion: consent.disclosureTemplateVersion } };
  };
  const CHANGE: Record<RuntimeSessionChange, "PARTICIPANT_CHANGED" | "ACCOUNT_SWITCH"> = { PARTICIPANT_CHANGED: "PARTICIPANT_CHANGED", OWNER_RECOVERED: "ACCOUNT_SWITCH" };
  return {
    async start(callId) {
      const r = await sessions.startCall({ integration, callId, callerIdHash: null, consent: UNDECIDED });
      return { sessionRef: r.sessionRef, sessionGeneration: r.sessionGeneration, expiresAt: r.expiresAt };
    },
    async view(sessionRef, callId) {
      const loaded = await sessions.store.load(sessionRefHash(sessionRef));
      if (!loaded) throw new SessionInvalidError("SESSION_NOT_FOUND");
      const problem = bindingProblem(loaded.rec, integration, sessions.config) ?? lifecycleProblem(loaded.rec, clock.now()) ?? (loaded.rec.callId !== callId ? "SESSION_CALL_MISMATCH" : null);
      if (problem) throw new SessionInvalidError(problem);
      return viewOf(loaded.rec.generation, loaded.rec.expiresAt, loaded.rec.consent);
    },
    async change(sessionRef, change) {
      const ctx = await sessions.applyChange(sessionRef, integration, { kind: CHANGE[change] });
      return viewOf(ctx.sessionGeneration, ctx.expiresAt, ctx.consent);
    },
    async end(sessionRef) {
      await sessions.endCall(sessionRef, integration);
    },
  };
}

/** ActionService.invalidatePending as the binding service's port. */
export function actionInvalidator(actions: { invalidatePending(sessionRef: string, reasonCode: string): Promise<number> }): PendingActionInvalidator {
  return { invalidatePending: (sessionRef, reasonCode) => actions.invalidatePending(sessionRef, reasonCode) };
}

/** GatewayAudit as the binding audit sink; an unwritten event is an error (issuance then fails closed, OPS-01). */
export function gatewayBindingAudit(audit: GatewayAudit): BindingAuditSink {
  return {
    async record(e) {
      const id = await audit.record({
        tenantId: e.tenantId,
        action: e.action,
        outcome: e.outcome,
        sourceComponent: "gateway",
        callId: e.interactionId,
        sessionBindingRef: e.sessionBindingRef,
        sessionGeneration: e.sessionGeneration,
        reasonCode: e.reasonCode,
        // A typed opaque reference (`call_binding:cbd_...`), the grammar the audit store accepts for evidence pointers.
        evidencePointers: e.bindingId ? [`call_binding:${e.bindingId}`] : [],
        correlationId: e.correlationId,
      });
      if (id === null) throw new AuditUnavailableError();
    },
  };
}
