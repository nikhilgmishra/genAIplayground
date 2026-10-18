/**
 * Telephony-control API for the deterministic Talkdesk Studio steps (identity:
 * telephony_control; talkdesk/studio-flow-spec.md section 3, TC-01..TC-12).
 *
 * Design rules:
 *  - The bearer session reference is returned ONLY by call start (TC-01) and is
 *    presented back only in the trusted X-VSP-Session-Ref header: never in a URL
 *    (access logs), a body, an audit event, a log line or a metric.
 *  - X-VSP-Interaction-Id (identifier only) binds the session to the current call.
 *  - Consent, role, participant change and confirmation are trusted Studio inputs;
 *    the model-facing mcp_tools credential is refused on every route (separate
 *    service identities, AUTH-03).
 *  - Human request and safety screening never require a valid session (SAFE-02)
 *    and never select a destination from caller input (SAFE-05): destinations
 *    come only from trusted configuration through the HandoffService.
 *  - Caller utterances for safety screening and OTP digits are processed
 *    transiently: never stored, logged, audited or echoed (AUTH-06, DATA-01).
 *  - Every mutation is audited with SESSION_AUDIT_ACTIONS names (binding ref only).
 */
import { z } from "zod";
import type { InteractionOutcomeService, HandoffService, SupportRequestService } from "../../business/contract.js";
import { SESSION_AUDIT_ACTIONS } from "../../business/contract.js";
import type { DestinationConfig } from "../../config/ports.js";
import type { AuditHealth } from "../../audit/ports.js";
import type { ActionService } from "../../actions/ports.js";
import type { LedgerEntryView } from "../../actions/action-service.js";
import { BeginVerificationInputSchema } from "../../identity/verification-service.js";
import type { SessionChange, SessionService, VerificationService } from "../../identity/ports.js";
import type { Logger } from "../../observability/ports.js";
import type { AdmissionController } from "../../ops/ports.js";
import {
  ActionState,
  AuthGateResponse,
  ConsentState,
  IntegrationIdentity,
  IsoDateTime,
  IssueCategory,
  OpaqueId,
  Outcome,
  Role,
  SessionRef,
  Sha256Hex,
  SpeechDirective,
  TransferReason,
} from "../../protocol/index.js";
import type { AuthContext, Environment, PreparedAction, VersionSet } from "../../protocol/index.js";
import type { SafetyPipeline } from "../../safety/pipeline.js";
import type { SafetyEventRecorder, SafetyIncident } from "../../safety/safety-events.js";
import type { Clock } from "../../shared/clock.js";
import { AccessDeniedError, PlatformError, SessionInvalidError } from "../../shared/errors.js";
import type { ResponseGate, TemplateRegistry, TurnTracker } from "../../voice/ports.js";
import type { CallOutcomeTracker, HandoffIndex, SessionLeaseRegistry } from "../call-state.js";
import type { TransferJourney } from "../../workflows/transfer.js";
import { journeyOutcome } from "../../workflows/transfer.js";
import type { GatewayAudit } from "../gateway-audit.js";
import type { LocalInteractionLookupFixture } from "../session-binding.js";
import { INTERACTION_ID_HEADER, SESSION_REF_HEADER } from "../session-binding.js";
import { AUTH_ERRORS, ErrorBody, defineRoute } from "./route.js";
import type { RouteContext, RouteDef } from "./route.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const TurnId = z.string().regex(/^turn_[A-Za-z0-9_-]{4,64}$/);
const Language = z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/);
const Locale = z.string().regex(/^[a-z]{2}-[A-Z]{2}$/);
const TemplateId = z.string().regex(/^[a-z][a-z0-9_.]{2,80}$/);
const ReasonCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/);
const DestinationIdSchema = z.string().regex(/^dst_[a-z0-9_]{2,40}$/);
const Continuity = z.enum(["NONE", "HUMAN_QUEUE", "CALLBACK_INTAKE", "OUTAGE_MESSAGE_THEN_HUMAN"]);

export const StartCallBody = z.strictObject({
  /** Talkdesk interaction identifier: an identifier only, never authority. */
  callId: OpaqueId,
  /** ANI digest is a risk signal only (AUTH-01); null in Phase 2. */
  callerIdHash: Sha256Hex.nullable(),
  consent: ConsentState,
});
export const AdmissionView = z.strictObject({ admitted: z.boolean(), continuity: Continuity, reasonCode: ReasonCodeSchema });
export const StartCallResponse = z.strictObject({
  sessionRef: SessionRef,
  sessionGeneration: z.number().int().min(1),
  /** Literal false: Studio never maps this into the Auth Gate variable (SF-T-10). */
  authGate: z.literal(false),
  expiresAt: IsoDateTime,
  admission: AdmissionView,
});
export const GenerationResponse = z.strictObject({ sessionGeneration: z.number().int().min(1) });
export const RoleBody = z.strictObject({ role: Role });
export const ChangeBody = z.strictObject({ kind: z.enum(["PARTICIPANT_CHANGED", "ACCOUNT_SWITCH", "RECOVERY_STARTED"]) });
export const VerificationBody = z.strictObject({
  method: z.enum(["secure_link", "otp"]),
  role: Role,
  locator: BeginVerificationInputSchema.shape.locator,
});
export const VerificationResponse = z.strictObject({
  response: z.enum(["IF_ELIGIBLE_A_LINK_WAS_SENT", "IF_ELIGIBLE_A_CODE_WAS_SENT", "VERIFICATION_UNAVAILABLE_USE_HUMAN"]),
  /** Two-word match code the caller hears and compares in the portal (secure link only). */
  matchCode: z.string().max(64).nullable(),
  /** OTP challenge handle for the isolated DTMF step (OTP only). */
  challengeId: z.string().regex(/^otc_[A-Za-z0-9_-]{16,64}$/).nullable(),
  speechTemplateId: TemplateId,
});
export const OtpBody = z.strictObject({ challengeId: z.string().regex(/^otc_[A-Za-z0-9_-]{16,64}$/), code: z.string().regex(/^\d{6}$/) });
export const OtpResponse = z.strictObject({ verified: z.boolean(), reasonCode: ReasonCodeSchema });
export const PendingConfirmationResponse = z.strictObject({
  actionId: OpaqueId,
  digest: Sha256Hex,
  sessionGeneration: z.number().int().min(1),
  turnId: TurnId,
  expiresAt: IsoDateTime,
  confirmationTemplateId: TemplateId,
  /** Rendered by the gateway response gate from the approved template; null => route to a human. */
  promptText: z.string().max(500).nullable(),
  routeToHuman: z.boolean(),
});
export const ConfirmParams = z.strictObject({ actionId: OpaqueId });
export const ConfirmBody = z.strictObject({
  digest: Sha256Hex,
  sessionGeneration: z.number().int().min(1),
  turnId: TurnId,
  method: z.enum(["dtmf_keypress", "deterministic_skill_affirmative"]),
  capturedAt: IsoDateTime,
});
export const ConfirmResponse = z.strictObject({ actionId: OpaqueId, state: ActionState });
export const BargeInResponse = z.strictObject({ invalidatedTurn: z.boolean(), invalidatedActions: z.number().int().min(0) });
export const ScreeningBody = z.strictObject({
  callId: OpaqueId,
  /** Recognized caller text: processed transiently, never stored or logged. */
  text: z.string().max(2000),
  locale: Locale,
  asrConfidence: z.number().min(0).max(1).nullable(),
});
export const ScreeningResponse = z.strictObject({
  route: z.enum(["NONE", "SAFETY_PRIORITY_HUMAN", "CLINICAL_BOUNDARY_ROUTE"]),
  handoffId: OpaqueId.nullable(),
  transferId: OpaqueId.nullable(),
  destinationId: DestinationIdSchema.nullable(),
  speechTemplateId: TemplateId.nullable(),
  interpreterRequired: z.boolean(),
  reasonCode: ReasonCodeSchema,
});
export const HumanRequestBody = z.strictObject({
  callId: OpaqueId,
  reason: TransferReason.exclude(["SAFETY_PRIORITY"]),
  language: Language,
  issueCategory: IssueCategory.nullable(),
  accommodations: z.array(z.enum(["interpreter", "relay_service", "slower_speech", "repeat_on_request", "tty"])).max(5).optional(),
});
export const HumanRequestResponse = z.strictObject({
  accepted: z.boolean(),
  handoffId: OpaqueId.nullable(),
  transferId: OpaqueId.nullable(),
  destinationId: DestinationIdSchema,
  speechTemplateId: TemplateId,
  reasonCode: ReasonCodeSchema,
});
export const HandoffContextResponse = z.strictObject({
  destinationId: DestinationIdSchema,
  handoffId: OpaqueId.nullable(),
  supportReference: z.string().regex(/^SR-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/).nullable(),
  priority: z.enum(["SAFETY", "STANDARD"]),
});
export const EndBody = z.strictObject({ reason: z.enum(["CALLER_HANGUP", "FLOW_COMPLETED", "TRANSFERRED"]) });
export const EndResponse = z.strictObject({ ended: z.boolean(), outcome: Outcome.nullable(), reasonCode: ReasonCodeSchema });

export const SESSION_HEADERS = [
  { name: "X-VSP-Session-Ref", required: true, description: "Bearer session reference from TC-01 (header only; never in a URL or body)." },
  { name: "X-VSP-Interaction-Id", required: false, description: "Talkdesk interaction id of the current call (identifier only); a session from another call is rejected." },
];
const OPTIONAL_SESSION_HEADERS = SESSION_HEADERS.map((h) => ({ ...h, required: false }));

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

type ResolvingSessions = SessionService & {
  resolve(ref: string, integ: IntegrationIdentity, options?: { expectedCallId?: string }): Promise<AuthContext>;
  authGate(ref: string, integ: IntegrationIdentity, options?: { expectedCallId?: string }): Promise<z.infer<typeof AuthGateResponse>>;
};

export interface TelephonyRouteDeps {
  tenantId: string;
  environment: Environment;
  clock: Clock;
  logger: Logger;
  sessions: ResolvingSessions;
  verification: VerificationService;
  otpEnabled: boolean;
  /** Ledger: TC-07 and TC-11 read the session's actions through listForSession (content-free views). */
  actions: ActionService & { listForSession(tenantId: string, sessionRef: string): Promise<LedgerEntryView[]> };
  admission: AdmissionController;
  turns: TurnTracker;
  /** Full response gate (with the turn tracker) used to render the confirmation prompt. */
  gate: ResponseGate;
  templates: TemplateRegistry;
  safety: SafetyPipeline;
  handoff: HandoffService;
  outcomes: InteractionOutcomeService;
  auditHealth: AuditHealth;
  audit: GatewayAudit;
  /** LOCAL FIXTURE interaction index for server_to_server_lookup (null when not used). */
  interactionLookup: LocalInteractionLookupFixture | null;
  leases: SessionLeaseRegistry;
  handoffs: HandoffIndex;
  /** TC-11 evidence: support requests created for or linked to the call (REQUEST_ACCEPTED). */
  supportRequests?: Pick<SupportRequestService, "listForCall">;
  /** TC-11 evidence: the call's transfer journey (TRANSFERRED only after CALLER_CONFIRMED_CONNECTED). */
  journeys?: { get(handoffId: string): Promise<TransferJourney | null> };
  /** TC-11 evidence: per-call flags the tool pipeline observed (information provided, policy declined). */
  callOutcomes?: CallOutcomeTracker;
  /**
   * Durable, content-free safety evidence (safety_events + audit): validated signal and route
   * initiation with time to route. Recorded AFTER the route was initiated; never blocks it.
   */
  safetyEvents?: Pick<SafetyEventRecorder, "begin" | "recordValidated" | "recordRouteInitiated">;
  /** TC-07: typed confirmation slot values from the authoritative action (BusinessModule.confirmationSlots). */
  confirmationSlots?: (action: PreparedAction) => Promise<Record<string, string | number | boolean> | null>;
  versions: VersionSet;
  destinations: readonly DestinationConfig[];
  cohort?: string;
  defaultLocale?: string;
}

const SAFETY_DESTINATION = "dst_safety_priority";

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function telephonyRoutes(d: TelephonyRouteDeps): RouteDef<unknown, unknown>[] {
  const locale = d.defaultLocale ?? "en-US";
  const standardDestination = d.destinations.find((x) => x.purpose === "STANDARD_SUPPORT")?.destinationId ?? "dst_support_general";
  const safetyDestination = d.destinations.find((x) => x.purpose === "SAFETY_PRIORITY")?.destinationId ?? SAFETY_DESTINATION;

  const expectedCall = (ctx: RouteContext<unknown, unknown>): { expectedCallId?: string } => {
    const v = ctx.header(INTERACTION_ID_HEADER);
    return v && OpaqueId.safeParse(v.trim()).success ? { expectedCallId: v.trim() } : {};
  };
  const bearer = (ctx: RouteContext<unknown, unknown>): string | null => {
    const v = ctx.header(SESSION_REF_HEADER)?.trim() ?? null;
    return v && SessionRef.safeParse(v).success ? v : null;
  };
  /** Required session: throws SessionInvalidError (403, reason code only). */
  const session = async (ctx: RouteContext<unknown, unknown>): Promise<{ auth: AuthContext; sessionRef: string; integration: IntegrationIdentity }> => {
    const integration = ctx.integration;
    if (!integration) throw new AccessDeniedError("INTEGRATION_REQUIRED");
    const ref = bearer(ctx);
    if (!ref) throw new SessionInvalidError("SESSION_REF_MISSING");
    const auth = await d.sessions.resolve(ref, integration, expectedCall(ctx));
    return { auth, sessionRef: ref, integration };
  };
  /** Optional session for SAFE-02 routes: any failure yields null, never an error. */
  const optionalSession = async (ctx: RouteContext<unknown, unknown>): Promise<{ auth: AuthContext; sessionRef: string } | null> => {
    try {
      const s = await session(ctx);
      return { auth: s.auth, sessionRef: s.sessionRef };
    } catch {
      return null;
    }
  };
  const tc = "telephony_control" as const;
  const src = "telephony_control" as const;

  const routes = [
    defineRoute({
      operationId: "telephony.startCall",
      ref: "TC-01",
      method: "POST",
      path: "/telephony/v1/calls",
      channel: tc,
      summary: "Start the trusted call session (A0, generation 1) after Studio consent capture; AI admission with a capacity lease (newSession).",
      tags: ["telephony-control"],
      body: StartCallBody,
      responses: { 201: { description: "Session started", schema: StartCallResponse }, ...AUTH_ERRORS, 503: { description: "Session store unavailable: Studio routes to continuity", schema: ErrorBody } },
      handler: async (ctx) => {
        const integration = ctx.integration as IntegrationIdentity;
        const started = await d.sessions.startCall({ integration, callId: ctx.body.callId, callerIdHash: ctx.body.callerIdHash, consent: ctx.body.consent });
        let decision: { admitted: boolean; continuity: z.infer<typeof Continuity>; reasonCode: string; sessionLeaseId?: string | null };
        try {
          decision = await d.admission.admit({
            tenantId: d.tenantId,
            class: "PUBLIC",
            vendor: integration.integrationId,
            workflow: null,
            cohort: d.cohort ?? "default",
            newSession: true,
            modelVersion: d.versions.model,
            voiceVersion: d.versions.voice,
          });
        } catch {
          decision = { admitted: false, continuity: "HUMAN_QUEUE", reasonCode: "ADMISSION_UNAVAILABLE" };
        }
        const admission = { admitted: decision.admitted, continuity: decision.continuity, reasonCode: /^[A-Z][A-Z0-9_]{2,63}$/.test(decision.reasonCode) ? decision.reasonCode : "ADMISSION_REFUSED" };
        d.leases.set(started.sessionRef, { leaseId: decision.sessionLeaseId ?? null, decision: admission });
        d.interactionLookup?.bind({ tenantId: d.tenantId, integrationId: integration.integrationId, interactionId: ctx.body.callId }, started.sessionRef);
        await d.audit.record({
          tenantId: d.tenantId,
          action: SESSION_AUDIT_ACTIONS.started,
          outcome: "SUCCEEDED",
          sourceComponent: src,
          sessionRef: started.sessionRef,
          callId: ctx.body.callId,
          reasonCode: admission.admitted ? "AI_ADMITTED" : admission.reasonCode,
          correlationId: ctx.requestId,
        });
        return { status: 201, body: { sessionRef: started.sessionRef, sessionGeneration: started.sessionGeneration, authGate: false, expiresAt: started.expiresAt, admission } };
      },
    }),
    defineRoute({
      operationId: "telephony.recordConsent",
      ref: "TC-02",
      method: "POST",
      path: "/telephony/v1/session/consent",
      channel: tc,
      summary: "Record the consent captured by the deterministic Studio step (capturedBy studio_flow or human_agent).",
      tags: ["telephony-control"],
      headers: SESSION_HEADERS,
      body: ConsentState,
      responses: { 200: { description: "Consent recorded", schema: GenerationResponse }, ...AUTH_ERRORS, 503: { description: "Audit evidence unavailable", schema: ErrorBody } },
      handler: async (ctx) => {
        const s = await session(ctx);
        await d.auditHealth.assertCanAcceptConsequential();
        const next = await d.sessions.recordConsent(s.sessionRef, s.integration, ctx.body);
        await d.audit.record({
          tenantId: d.tenantId,
          action: SESSION_AUDIT_ACTIONS.consentRecorded,
          outcome: "SUCCEEDED",
          sourceComponent: src,
          ctx: next,
          reasonCode: `CONSENT_RECORDING_${ctx.body.recording}`,
          correlationId: ctx.requestId,
        });
        return { status: 200, body: { sessionGeneration: next.sessionGeneration } };
      },
    }),
    defineRoute({
      operationId: "telephony.selectRole",
      ref: "TC-03",
      method: "POST",
      path: "/telephony/v1/session/role",
      channel: tc,
      summary: "Role chosen in the deterministic menu. A different role drops privileges (new generation); roles never combine.",
      tags: ["telephony-control"],
      headers: SESSION_HEADERS,
      body: RoleBody,
      responses: { 200: { description: "Role selected", schema: GenerationResponse }, ...AUTH_ERRORS },
      handler: async (ctx) => {
        const s = await session(ctx);
        const next = await d.sessions.selectRole(s.sessionRef, s.integration, ctx.body.role);
        if (next.sessionGeneration !== s.auth.sessionGeneration) await d.actions.invalidatePending(s.sessionRef, "ROLE_CHANGED").catch(() => 0);
        await d.audit.record({ tenantId: d.tenantId, action: SESSION_AUDIT_ACTIONS.roleSelected, outcome: "SUCCEEDED", sourceComponent: src, ctx: next, reasonCode: "ROLE_SELECTED", correlationId: ctx.requestId });
        return { status: 200, body: { sessionGeneration: next.sessionGeneration } };
      },
    }),
    defineRoute({
      operationId: "telephony.authGate",
      ref: "TC-04",
      method: "GET",
      path: "/telephony/v1/session/auth-gate",
      channel: tc,
      summary: "Strict boolean for the Talkdesk Auth Gate variable: true only for a valid, current, A2+ session (AUTH-07). Never throws; unknown, expired, revoked, ended, other-call or missing sessions read false.",
      tags: ["telephony-control"],
      headers: OPTIONAL_SESSION_HEADERS,
      responses: { 200: { description: "AuthGateResponse (exactly isAuthenticated, sessionGeneration, evaluatedAt)", schema: AuthGateResponse }, ...AUTH_ERRORS },
      handler: async (ctx) => {
        const integration = ctx.integration as IntegrationIdentity;
        const ref = bearer(ctx);
        const gate = await d.sessions.authGate(ref ?? "", integration, expectedCall(ctx));
        const body = AuthGateResponse.parse({ isAuthenticated: gate.isAuthenticated === true, sessionGeneration: gate.sessionGeneration, evaluatedAt: gate.evaluatedAt });
        await d.audit.record({
          tenantId: d.tenantId,
          action: SESSION_AUDIT_ACTIONS.authGateRead,
          outcome: body.isAuthenticated ? "ALLOWED" : "DENIED",
          sourceComponent: src,
          sessionRef: ref,
          reasonCode: body.isAuthenticated ? "AUTH_GATE_OPEN" : "AUTH_GATE_CLOSED",
          correlationId: ctx.requestId,
        });
        return { status: 200, body };
      },
    }),
    defineRoute({
      operationId: "telephony.admission",
      ref: "TC-05",
      method: "GET",
      path: "/telephony/v1/session/admission",
      channel: tc,
      summary: "AI admission decided at call start (kill switches, budgets, capacity). Refusals carry the continuity route; never a silent drop.",
      tags: ["telephony-control"],
      headers: SESSION_HEADERS,
      responses: { 200: { description: "Admission decision", schema: AdmissionView }, ...AUTH_ERRORS },
      handler: async (ctx) => {
        const s = await session(ctx);
        const rec = d.leases.get(s.sessionRef);
        return { status: 200, body: rec?.decision ?? { admitted: false, continuity: "HUMAN_QUEUE", reasonCode: "ADMISSION_UNKNOWN" } };
      },
    }),
    defineRoute({
      operationId: "telephony.beginVerification",
      method: "POST",
      path: "/telephony/v1/session/verification",
      channel: tc,
      summary: "Begin verification: secure link to the registered channel (preferred) or OTP to an existing verified channel (only when enabled, TB-03). Identical response for zero, one or many matches.",
      tags: ["telephony-control"],
      headers: SESSION_HEADERS,
      body: VerificationBody,
      responses: { 200: { description: "Generic response", schema: VerificationResponse }, ...AUTH_ERRORS },
      handler: async (ctx) => {
        const s = await session(ctx);
        const input = { role: ctx.body.role, locator: ctx.body.locator };
        let body: z.infer<typeof VerificationResponse>;
        if (ctx.body.method === "otp") {
          if (!d.otpEnabled) {
            body = { response: "VERIFICATION_UNAVAILABLE_USE_HUMAN", matchCode: null, challengeId: null, speechTemplateId: "verification.failed_generic" };
          } else {
            const r = await d.verification.beginOtp(s.auth, input);
            body = { response: r.response, matchCode: null, challengeId: r.response === "IF_ELIGIBLE_A_CODE_WAS_SENT" ? r.challengeId : null, speechTemplateId: r.response === "IF_ELIGIBLE_A_CODE_WAS_SENT" ? "verification.otp_sent" : "verification.failed_generic" };
          }
        } else {
          const r = await d.verification.beginSecureLink(s.auth, input);
          body = { response: r.response, matchCode: r.response === "IF_ELIGIBLE_A_LINK_WAS_SENT" ? r.matchCode : null, challengeId: null, speechTemplateId: r.response === "IF_ELIGIBLE_A_LINK_WAS_SENT" ? "verification.secure_link_sent" : "verification.failed_generic" };
        }
        await d.audit.record({ tenantId: d.tenantId, action: SESSION_AUDIT_ACTIONS.verificationBegun, outcome: "PENDING", sourceComponent: src, ctx: s.auth, reasonCode: ctx.body.method === "otp" ? "VERIFICATION_OTP" : "VERIFICATION_SECURE_LINK", correlationId: ctx.requestId });
        return { status: 200, body };
      },
    }),
    defineRoute({
      operationId: "telephony.submitOtp",
      ref: "TC-06",
      method: "POST",
      path: "/telephony/v1/session/otp",
      channel: tc,
      summary: "Isolated DTMF OTP submission (disabled unless TB-03 is evidenced and OTP is enabled). Digits are never stored, logged, audited or echoed.",
      tags: ["telephony-control"],
      headers: SESSION_HEADERS,
      body: OtpBody,
      responses: { 200: { description: "Verification result", schema: OtpResponse }, ...AUTH_ERRORS },
      handler: async (ctx) => {
        if (!d.otpEnabled) throw new AccessDeniedError("OTP_DISABLED_TB03");
        const s = await session(ctx);
        const r = await d.verification.submitOtp({ sessionRef: s.sessionRef, challengeId: ctx.body.challengeId, code: ctx.body.code }, s.integration);
        const reasonCode = /^[A-Z][A-Z0-9_]{2,63}$/.test(r.reasonCode) ? r.reasonCode : "OTP_NOT_VERIFIED";
        await d.audit.record({
          tenantId: d.tenantId,
          action: r.verified ? SESSION_AUDIT_ACTIONS.verificationBound : SESSION_AUDIT_ACTIONS.verificationFailed,
          outcome: r.verified ? "SUCCEEDED" : "DENIED",
          sourceComponent: src,
          ctx: s.auth,
          reasonCode,
          correlationId: ctx.requestId,
        });
        return { status: 200, body: { verified: r.verified, reasonCode } };
      },
    }),
    defineRoute({
      operationId: "telephony.pendingConfirmation",
      ref: "TC-07",
      method: "GET",
      path: "/telephony/v1/session/pending-confirmation",
      channel: tc,
      summary: "The server-side PREPARED action for this session with a gateway-rendered confirmation prompt and a fresh confirmation turn. Nothing is taken from the model or the caller (ACT-01, ACT-05).",
      tags: ["telephony-control"],
      headers: SESSION_HEADERS,
      responses: { 200: { description: "Pending action", schema: PendingConfirmationResponse }, 404: { description: "No pending action: route to a human", schema: ErrorBody }, ...AUTH_ERRORS },
      handler: async (ctx) => {
        const s = await session(ctx);
        // The most recent unexpired PREPARED action of this session and generation (ledger view, never model input).
        const nowMs = d.clock.now().getTime();
        const views = await d.actions.listForSession(d.tenantId, s.sessionRef);
        const action = [...views]
          .reverse()
          .map((v) => v.action)
          .find((a) => a.state === "PREPARED" && a.sessionGeneration === s.auth.sessionGeneration && Date.parse(a.expiresAt) > nowMs);
        if (!action) {
          return { status: 404, body: { error: { reasonCode: "NO_PENDING_ACTION", requestId: ctx.requestId } } };
        }
        const turnId = d.turns.beginTurn(s.sessionRef, s.auth.sessionGeneration);
        const promptText = await renderConfirmation(d, action, turnId, s.sessionRef, s.auth.sessionGeneration, locale);
        return {
          status: 200,
          body: {
            actionId: action.actionId,
            digest: action.digest,
            sessionGeneration: action.sessionGeneration,
            turnId,
            expiresAt: action.expiresAt,
            confirmationTemplateId: action.confirmationTemplateId,
            promptText,
            routeToHuman: promptText === null,
          },
        };
      },
    }),
    defineRoute({
      operationId: "telephony.confirmAction",
      ref: "TC-08",
      method: "POST",
      path: "/telephony/v1/session/actions/:actionId/confirm",
      channel: tc,
      summary: "Trusted confirmation captured by the deterministic Studio step, bound to the prepared-action digest, generation and the current confirmation turn (ACT-01). A stale turn (barge-in) is refused.",
      tags: ["telephony-control"],
      headers: SESSION_HEADERS,
      params: ConfirmParams,
      body: ConfirmBody,
      responses: { 200: { description: "Confirmation recorded (or the action was invalidated)", schema: ConfirmResponse }, 409: { description: "Stale confirmation turn or state conflict", schema: ErrorBody }, ...AUTH_ERRORS, 503: { description: "Audit evidence unavailable", schema: ErrorBody } },
      handler: async (ctx) => {
        const s = await session(ctx);
        if (!d.turns.isCurrent(s.sessionRef, ctx.body.turnId, ctx.body.sessionGeneration)) {
          await d.audit.record({ tenantId: d.tenantId, action: SESSION_AUDIT_ACTIONS.confirmationCaptured, outcome: "DENIED", sourceComponent: src, ctx: s.auth, reasonCode: "CONFIRMATION_TURN_STALE", turnId: ctx.body.turnId, evidencePointers: [`ledger://actions/${ctx.params.actionId}`], correlationId: ctx.requestId });
          return { status: 409, body: { error: { reasonCode: "CONFIRMATION_TURN_STALE", requestId: ctx.requestId } } };
        }
        const action = await d.actions.confirm(
          {
            actionId: ctx.params.actionId,
            digest: ctx.body.digest,
            sessionRef: s.sessionRef,
            sessionGeneration: ctx.body.sessionGeneration,
            turnId: ctx.body.turnId,
            method: ctx.body.method,
            capturedBy: s.integration.integrationId,
            capturedAt: ctx.body.capturedAt,
          },
          s.integration,
        );
        await d.audit.record({
          tenantId: d.tenantId,
          action: SESSION_AUDIT_ACTIONS.confirmationCaptured,
          outcome: action.state === "CONFIRMED" ? "SUCCEEDED" : "INVALIDATED",
          sourceComponent: src,
          ctx: s.auth,
          reasonCode: action.state === "CONFIRMED" ? "CONFIRMATION_CAPTURED" : `ACTION_${action.state}`,
          turnId: ctx.body.turnId,
          evidencePointers: [`ledger://actions/${action.actionId}`],
          correlationId: ctx.requestId,
        });
        return { status: 200, body: { actionId: action.actionId, state: action.state } };
      },
    }),
    defineRoute({
      operationId: "telephony.bargeIn",
      method: "POST",
      path: "/telephony/v1/session/barge-in",
      channel: tc,
      summary: "Caller interruption: invalidates the current turn (late results cannot speak into a new state) and every pending action of the session (spec sections 8 and 11).",
      tags: ["telephony-control"],
      headers: SESSION_HEADERS,
      responses: { 200: { description: "Invalidated", schema: BargeInResponse }, ...AUTH_ERRORS },
      handler: async (ctx) => {
        const s = await session(ctx);
        const turn = d.turns.bargeIn(s.sessionRef);
        const invalidated = await d.actions.invalidatePending(s.sessionRef, "BARGE_IN");
        await d.audit.record({ tenantId: d.tenantId, action: SESSION_AUDIT_ACTIONS.bargeIn, outcome: "INVALIDATED", sourceComponent: src, ctx: s.auth, reasonCode: "BARGE_IN", turnId: turn, correlationId: ctx.requestId });
        return { status: 200, body: { invalidatedTurn: turn !== null, invalidatedActions: invalidated } };
      },
    }),
    defineRoute({
      operationId: "telephony.applyChange",
      ref: "TC-10",
      method: "POST",
      path: "/telephony/v1/session/change",
      channel: tc,
      summary: "Participant change, account switch or recovery: new generation, privileges dropped, pending actions invalidated; the Auth Gate must be refreshed.",
      tags: ["telephony-control"],
      headers: SESSION_HEADERS,
      body: ChangeBody,
      responses: { 200: { description: "Changed", schema: GenerationResponse }, ...AUTH_ERRORS },
      handler: async (ctx) => {
        const s = await session(ctx);
        const next = await d.sessions.applyChange(s.sessionRef, s.integration, { kind: ctx.body.kind } as SessionChange);
        await d.actions.invalidatePending(s.sessionRef, ctx.body.kind).catch(() => 0);
        await d.audit.record({ tenantId: d.tenantId, action: SESSION_AUDIT_ACTIONS.changed, outcome: "SUCCEEDED", sourceComponent: src, ctx: next, reasonCode: ctx.body.kind, correlationId: ctx.requestId });
        return { status: 200, body: { sessionGeneration: next.sessionGeneration } };
      },
    }),
    defineRoute({
      operationId: "telephony.screenUtterance",
      method: "POST",
      path: "/telephony/v1/session/utterance-screening",
      channel: tc,
      summary: "Early safety signal: deterministic safety + clinical-boundary screening of the recognized utterance; a signal starts the priority safety route. No authentication required (SAFE-02); text is never stored or logged.",
      tags: ["telephony-control", "safety"],
      headers: OPTIONAL_SESSION_HEADERS,
      body: ScreeningBody,
      rateLimitExempt: true,
      responses: { 200: { description: "Screening decision", schema: ScreeningResponse }, ...AUTH_ERRORS },
      handler: async (ctx) => {
        const s = await optionalSession(ctx);
        const callId = s?.auth.callId ?? ctx.body.callId;
        const evaluation = d.safety.evaluate(
          { text: ctx.body.text, locale: ctx.body.locale, asrConfidence: ctx.body.asrConfidence },
          { afterHours: false, safetyModeActive: s ? s.auth.riskFlags.includes("SAFETY_ESCALATION_ACTIVE") : false },
        );
        const decision = evaluation.decision;
        const reasonCode = /^[A-Z][A-Z0-9_]{2,63}$/.test(decision.reasonCode) ? decision.reasonCode : "SAFETY_DECISION";
        if (decision.route === "SAFETY_PRIORITY_HUMAN") {
          const validatedAt = d.clock.now();
          const incident = beginIncident(d, { callId, generation: s?.auth.sessionGeneration ?? 0, signals: evaluation.signals, decision, locale: ctx.body.locale, correlationId: ctx.requestId });
          // The route first: nothing that can fail (audit, database) runs before the priority transfer is requested.
          let routed: Awaited<ReturnType<HandoffService["requestSafetyRoute"]>> | null = null;
          try {
            routed = await d.handoff.requestSafetyRoute({ tenantId: d.tenantId, callId, ctx: s?.auth ?? null, signals: evaluation.signals, locale: ctx.body.locale, validatedAt });
            d.handoffs.record(callId, routed, "SAFETY");
          } catch (err) {
            // The independent Studio safety route (SF-S) is the backstop: still answer with the trusted safety destination.
            d.logger.error("gateway.safety.route_request_failed", { reasonCode: err instanceof PlatformError ? err.reasonCode : "UNCLASSIFIED_ERROR" });
          }
          await recordIncident(d, incident, routed?.transferId ?? null);
          await d.audit.record({ tenantId: d.tenantId, action: SESSION_AUDIT_ACTIONS.safetySignal, outcome: "ALLOWED", sourceComponent: "safety", ctx: s?.auth ?? null, callId, reasonCode, correlationId: ctx.requestId });
          await d.audit.record({ tenantId: d.tenantId, action: SESSION_AUDIT_ACTIONS.safetyRouteInitiated, outcome: routed ? "PENDING" : "FAILED", sourceComponent: "safety", ctx: s?.auth ?? null, callId, reasonCode: routed ? reasonCode : "SAFETY_ROUTE_REQUEST_FAILED", evidencePointers: routed ? [`handoff:${routed.handoffId}`] : [], correlationId: ctx.requestId });
          return {
            status: 200,
            body: {
              route: "SAFETY_PRIORITY_HUMAN",
              handoffId: routed?.handoffId ?? null,
              transferId: routed?.transferId ?? null,
              destinationId: routed?.destinationId ?? safetyDestination,
              speechTemplateId: decision.acknowledgmentTemplateId ?? "safety.acknowledgment",
              interpreterRequired: decision.interpreterRequired,
              reasonCode,
            },
          };
        }
        if (decision.route === "CLINICAL_BOUNDARY_ROUTE") {
          const incident = beginIncident(d, { callId, generation: s?.auth.sessionGeneration ?? 0, signals: evaluation.signals, decision, clinicalCategories: [...new Set(evaluation.clinicalFindings.map((f) => f.category))], locale: ctx.body.locale, correlationId: ctx.requestId });
          let routed: Awaited<ReturnType<HandoffService["requestHuman"]>> | null = null;
          try {
            routed = await d.handoff.requestHuman({ tenantId: d.tenantId, callId, ctx: s?.auth ?? null, reason: "CLINICAL_QUESTION", language: ctx.body.locale.slice(0, 2), issueCategory: "clinical_question_redirected" });
            d.handoffs.record(callId, routed, "STANDARD");
          } catch (err) {
            d.logger.warn("gateway.clinical.route_request_failed", { reasonCode: err instanceof PlatformError ? err.reasonCode : "UNCLASSIFIED_ERROR" });
          }
          await recordIncident(d, incident, routed?.transferId ?? null);
          await d.audit.record({ tenantId: d.tenantId, action: "safety.clinical_boundary", outcome: routed ? "PENDING" : "FAILED", sourceComponent: "safety", ctx: s?.auth ?? null, callId, reasonCode, correlationId: ctx.requestId });
          return {
            status: 200,
            body: {
              route: "CLINICAL_BOUNDARY_ROUTE",
              handoffId: routed?.handoffId ?? null,
              transferId: routed?.transferId ?? null,
              destinationId: routed?.destinationId ?? decision.destinationId ?? standardDestination,
              speechTemplateId: decision.acknowledgmentTemplateId ?? "clinical.boundary",
              interpreterRequired: decision.interpreterRequired,
              reasonCode,
            },
          };
        }
        return { status: 200, body: { route: "NONE", handoffId: null, transferId: null, destinationId: null, speechTemplateId: null, interpreterRequired: decision.interpreterRequired, reasonCode } };
      },
    }),
    defineRoute({
      operationId: "telephony.requestHuman",
      method: "POST",
      path: "/telephony/v1/session/human-request",
      channel: tc,
      summary: "Caller asked for a person. Never requires a valid session (SAFE-02); the destination comes only from trusted configuration (SAFE-05).",
      tags: ["telephony-control", "safety"],
      headers: OPTIONAL_SESSION_HEADERS,
      body: HumanRequestBody,
      rateLimitExempt: true,
      responses: { 200: { description: "Handoff requested (or the standard fallback destination)", schema: HumanRequestResponse }, ...AUTH_ERRORS },
      handler: async (ctx) => {
        const s = await optionalSession(ctx);
        const callId = s?.auth.callId ?? ctx.body.callId;
        try {
          const r = await d.handoff.requestHuman({
            tenantId: d.tenantId,
            callId,
            ctx: s?.auth ?? null,
            reason: ctx.body.reason,
            language: ctx.body.language,
            issueCategory: ctx.body.issueCategory,
            ...(ctx.body.accommodations ? { accommodations: ctx.body.accommodations } : {}),
          });
          d.handoffs.record(callId, r, "STANDARD");
          return { status: 200, body: { accepted: true, handoffId: r.handoffId, transferId: r.transferId, destinationId: r.destinationId, speechTemplateId: r.speechTemplateId, reasonCode: "HANDOFF_REQUESTED" } };
        } catch (err) {
          d.logger.error("gateway.human.route_request_failed", { reasonCode: err instanceof PlatformError ? err.reasonCode : "UNCLASSIFIED_ERROR" });
          // Studio's independent human route still applies; answer with the trusted standard destination.
          return { status: 200, body: { accepted: false, handoffId: null, transferId: null, destinationId: standardDestination, speechTemplateId: "human.offer", reasonCode: "HANDOFF_REQUEST_FAILED" } };
        }
      },
    }),
    defineRoute({
      operationId: "telephony.handoffContext",
      ref: "TC-12",
      method: "GET",
      path: "/telephony/v1/session/handoff",
      channel: tc,
      summary: "Trusted transfer destination for Studio (never from model output): latest gateway handoff for the call, else the configured default for the session's priority (SAFETY while a safety escalation is active).",
      tags: ["telephony-control"],
      headers: SESSION_HEADERS,
      responses: { 200: { description: "Handoff context", schema: HandoffContextResponse }, ...AUTH_ERRORS },
      handler: async (ctx) => {
        const s = await session(ctx);
        const safety = s.auth.riskFlags.includes("SAFETY_ESCALATION_ACTIVE");
        const latest = d.handoffs.latest(s.auth.callId);
        const priority = safety || latest?.priority === "SAFETY" ? "SAFETY" : "STANDARD";
        const useLatest = latest !== null && (priority === "STANDARD" || latest.priority === "SAFETY");
        const destinationId = useLatest ? latest.destinationId : priority === "SAFETY" ? safetyDestination : standardDestination;
        const supportReference = useLatest && latest.supportReference && /^SR-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(latest.supportReference) ? latest.supportReference : null;
        return { status: 200, body: { destinationId, handoffId: useLatest ? latest.handoffId : null, supportReference, priority } };
      },
    }),
    defineRoute({
      operationId: "telephony.endCall",
      ref: "TC-11",
      method: "POST",
      path: "/telephony/v1/session/end",
      channel: tc,
      summary: "Call end: releases the AI capacity lease, ends the session (privileges dropped), invalidates pending actions and records the interaction outcome from server-side evidence (ACT-04). The gateway enforces expiry even if this is never sent (AUTH-04).",
      tags: ["telephony-control"],
      headers: OPTIONAL_SESSION_HEADERS,
      body: EndBody,
      responses: { 200: { description: "Ended", schema: EndResponse }, ...AUTH_ERRORS },
      handler: async (ctx) => {
        const ref = bearer(ctx);
        const lease = ref ? d.leases.take(ref) : null;
        if (lease?.leaseId) d.admission.releaseSession?.(lease.leaseId);
        let s: { auth: AuthContext; sessionRef: string; integration: IntegrationIdentity };
        try {
          s = await session(ctx);
        } catch (err) {
          return { status: 200, body: { ended: false, outcome: null, reasonCode: err instanceof PlatformError && /^[A-Z][A-Z0-9_]{2,63}$/.test(err.reasonCode) ? err.reasonCode : "SESSION_INVALID" } };
        }
        await d.sessions.endCall(s.sessionRef, s.integration);
        await d.actions.invalidatePending(s.sessionRef, "CALL_ENDED").catch(() => 0);
        d.interactionLookup?.unbind({ tenantId: d.tenantId, integrationId: s.integration.integrationId, interactionId: s.auth.callId });
        let outcome: { outcome: z.infer<typeof Outcome>; reasonCode: string } | null = null;
        try {
          // ACT-04: every outcome fact is gathered server-side; Studio's end reason is only the hang-up signal.
          const evidence = await gatherOutcomeEvidence(d, s.sessionRef, s.auth.callId, ctx.body.reason === "CALLER_HANGUP");
          outcome = await d.outcomes.record({ tenantId: d.tenantId, callId: s.auth.callId, contractId: null, evidence });
        } catch (err) {
          d.logger.warn("gateway.outcome.record_failed", { reasonCode: err instanceof PlatformError ? err.reasonCode : "UNCLASSIFIED_ERROR" });
        }
        await d.audit.record({ tenantId: d.tenantId, action: SESSION_AUDIT_ACTIONS.ended, outcome: "SUCCEEDED", sourceComponent: src, ctx: s.auth, reasonCode: ctx.body.reason, correlationId: ctx.requestId });
        const reasonCode = outcome && /^[A-Z][A-Z0-9_]{2,63}$/.test(outcome.reasonCode) ? outcome.reasonCode : "OUTCOME_NOT_RECORDED";
        return { status: 200, body: { ended: true, outcome: outcome?.outcome ?? null, reasonCode } };
      },
    }),
  ];
  return routes as RouteDef<unknown, unknown>[];
}

/** Validated-signal instant of a safety incident (no I/O; null when no recorder is wired or input is unusable). */
function beginIncident(
  d: TelephonyRouteDeps,
  i: { callId: string; generation: number; signals: SafetyIncidentInputSignals; decision: { route: string; destinationId: string | null; reasonCode: string }; clinicalCategories?: readonly string[] | undefined; locale: string; correlationId: string },
): SafetyIncident | null {
  if (!d.safetyEvents) return null;
  try {
    return d.safetyEvents.begin({
      tenantId: d.tenantId,
      callId: i.callId,
      sessionGeneration: i.generation,
      correlationId: i.correlationId,
      signals: i.signals,
      decision: i.decision as Parameters<SafetyEventRecorder["begin"]>[0]["decision"],
      ...(i.clinicalCategories ? { clinicalCategories: i.clinicalCategories as Parameters<SafetyEventRecorder["begin"]>[0]["clinicalCategories"] } : {}),
      locale: i.locale,
      afterHours: false,
    });
  } catch {
    return null;
  }
}

/** Route initiation (time to route) then the validated signal; recording failures never affect the route. */
async function recordIncident(d: TelephonyRouteDeps, incident: SafetyIncident | null, transferId: string | null): Promise<void> {
  if (!incident || !d.safetyEvents) return;
  try {
    await d.safetyEvents.recordRouteInitiated(incident, { transferId });
    await d.safetyEvents.recordValidated(incident);
  } catch (err) {
    d.logger.warn("gateway.safety.event_not_recorded", { reasonCode: err instanceof PlatformError ? err.reasonCode : "SAFETY_EVENT_NOT_RECORDED" });
  }
}

type SafetyIncidentInputSignals = Parameters<SafetyEventRecorder["begin"]>[0]["signals"];

type OutcomeEvidence = Parameters<InteractionOutcomeService["record"]>[0]["evidence"];

/**
 * TC-11 outcome evidence from server-side records only (ACT-04, SAFE-04):
 *  - commitReceiptIds: COMMITTED ledger receipts of this session (the outcome service
 *    re-verifies them against the call's interaction_actions and infers the contract);
 *  - requestAccepted: a support request of this call with disposition REQUEST_ACCEPTED
 *    (handoff and safety records are OUTCOME_UNKNOWN and never count);
 *  - transferConnected / failed: the call's latest transfer journey (TRANSFERRED only
 *    after CALLER_CONFIRMED_CONNECTED; staffed routes exhausted => failed);
 *  - informationProvided / policyDeclined: what the tool pipeline observed for the call.
 * A source that cannot be read contributes nothing (never a guessed success).
 */
async function gatherOutcomeEvidence(d: TelephonyRouteDeps, sessionRef: string, callId: string, callerDisconnected: boolean): Promise<OutcomeEvidence> {
  const views = await d.actions.listForSession(d.tenantId, sessionRef).catch(() => [] as LedgerEntryView[]);
  const commitReceiptIds = [...new Set(views.filter((v) => v.state === "COMMITTED" && v.receiptId !== null).map((v) => v.receiptId as string))].slice(0, 16);
  const requests = d.supportRequests ? await d.supportRequests.listForCall(d.tenantId, callId).catch(() => []) : [];
  const requestAccepted = requests.some((r) => r.disposition === "REQUEST_ACCEPTED");
  const latest = d.handoffs.latest(callId);
  const journey = latest && d.journeys ? await d.journeys.get(latest.handoffId).catch(() => null) : null;
  const journeyResult = journey ? journeyOutcome(journey) : null;
  const flags = d.callOutcomes?.take(callId) ?? { informationProvided: false, policyDeclined: false };
  return {
    commitReceiptIds,
    informationProvided: flags.informationProvided,
    requestAccepted,
    transferConnected: journeyResult === "TRANSFERRED",
    callerDisconnected,
    policyDeclined: flags.policyDeclined,
    failed: journeyResult === "FAILED",
  };
}

/**
 * Renders the confirmation prompt through the response gate from the approved template
 * (null => human). Slot values come from the business layer's typed view of the
 * authoritative action (confirmationSlots); without it, only change fields whose names
 * equal the template's slots are used. A missing value fails the render (route to human).
 */
async function renderConfirmation(
  d: TelephonyRouteDeps,
  action: PreparedAction,
  turnId: string,
  sessionRef: string,
  generation: number,
  locale: string,
): Promise<string | null> {
  const template = d.templates.get(action.confirmationTemplateId, locale);
  if (!template) return null;
  const slots: Record<string, string | number | boolean> = {};
  const typed = d.confirmationSlots ? await d.confirmationSlots(action).catch(() => null) : undefined;
  if (typed === null) return null;
  for (const name of Object.keys(template.slots)) {
    const v = typed !== undefined ? typed[name] : action.change[name];
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") slots[name] = v;
  }
  const directive = SpeechDirective.safeParse({
    templateId: template.templateId,
    templateVersion: template.version,
    responseClass: template.responseClass,
    slots,
    authorizationRef: action.policyDecisionId,
    sourceRefs: [action.actionId],
    turnId,
    sessionGeneration: generation,
  });
  if (!directive.success) return null;
  const rendered = d.gate.render(directive.data, {
    sessionRef,
    currentTurnId: turnId,
    sessionGeneration: generation,
    validAuthorizationRefs: new Set([action.policyDecisionId]),
    locale,
    environment: d.environment,
  });
  return rendered.ok ? rendered.utterance : null;
}

