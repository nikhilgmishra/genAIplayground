/**
 * request_human_transfer (human:request) and request_safety_route (safety:route).
 * SAFETY_AND_HUMAN_ROUTE: never require authentication, never gated by kill switches,
 * budgets or admission (SAFE-02, SAFE-03). No input can carry a destination: the
 * HandoffService resolves it from trusted configuration only (SAFE-05). The tool never
 * reports TRANSFERRED: a requested or dialled transfer is not a connection (SAFE-04).
 *
 * Session-less execution (SAFE-02): when no trusted session resolves (missing,
 * unknown, expired, revoked, ended or wrong generation) the pipeline calls
 * `executeWithoutSession` with no AuthContext. The HandoffService then runs with
 * ctx null and the call id the trusted transport binding supplied (never a tool
 * argument). Without a trusted call id there is no call to transfer: the result is
 * an honest PERMANENT_FAILURE (CALL_UNIDENTIFIED_USE_STUDIO_ROUTE) and the
 * independent Studio route remains the backstop. Speech is never produced on this
 * path (there is no session generation to bind it to; Studio plays the fixed prompt).
 *
 * Reported status (SAFE-04; finding SAFE-HANDOFF-01): CONNECTED only while a human is
 * confirmed on the line (journey connectedAt set). After a bridge drop the journey is
 * routing again and the tool reports TRANSFER_REQUESTED, never a stale CONNECTED.
 * When no route of the journey can be reached (every route failed to dial in the last
 * pass, or the staffed routes are exhausted: HOLDING_FOR_OPERATIONS) the tool reports
 * ROUTE_UNAVAILABLE_USE_STUDIO_ROUTE with no transfer id, so the contact-centre flow
 * takes its independent Studio route instead of waiting on a transfer that is not in
 * flight (FO-21-10; a telephony guard port in the live composition refuses every dial).
 * The safety evidence is recorded by the HandoffService before the status is mapped. The spoken prompt follows
 * the reported status: the safety tool speaks `safety.studio_route` (what happens next) instead of the
 * acknowledgment, and the human tool `transfer.failed_next_route` instead of `transfer.in_progress`.
 *
 * request_human_transfer in safety mode (SAFE-03; SAFE-HANDOFF-02) returns the call's
 * safety route (destinationPurpose SAFETY_PRIORITY); the HandoffService never dials a
 * STANDARD destination then. Every request_safety_route call produces safety evidence
 * (safety_events, time-to-routing metric) through the HandoffService (SAFE-HANDOFF-07).
 */
import { z } from "zod";
import type { DestinationConfig } from "../../config/ports.js";
import type { BusinessServices } from "../../business/services/types.js";
import { openResource } from "../../business/shared.js";
import { speechFor } from "../../business/speech.js";
import { IssueCategory } from "../../protocol/index.js";
import type { SafetySignal } from "../../safety/ports.js";
import type { HandoffResult } from "../../business/contract.js";
import { journeyOutcome } from "../../workflows/transfer.js";
import type { TransferJourney } from "../../workflows/transfer.js";
import type { ToolModule } from "../ports.js";
import { Id, LanguageArg, SupportRefArg, failed, ok } from "./common.js";
import { TOOL_DEFINITIONS } from "./definitions.js";

const HUMAN_REASONS = [
  "CALLER_REQUESTED_HUMAN",
  "CLINICAL_QUESTION",
  "POLICY_REQUIRES_HUMAN",
  "VERIFICATION_RECOVERY",
  "UNSUPPORTED_LANGUAGE",
  "ACCESSIBILITY",
  "DEPENDENCY_FAILURE",
  "CONSENT_DECLINED_ALTERNATIVE",
] as const;

const Purpose = z.enum(["SAFETY_PRIORITY", "STANDARD_SUPPORT", "INTERPRETER", "CLINICAL_ROUTE", "PROVIDER_SUPPORT", "PARTNER_SUPPORT", "BILLING_SPECIALIST", "OUTAGE_CONTINUITY", "UNAVAILABLE"]);
const RouteStatus = z.enum(["TRANSFER_REQUESTED", "CONNECTED", "ROUTE_UNAVAILABLE_USE_STUDIO_ROUTE"]);

export const HumanInput = z.strictObject({
  reason: z.enum(HUMAN_REASONS),
  language: LanguageArg,
  issueCategory: IssueCategory.nullable(),
  accommodations: z.array(z.enum(["interpreter", "relay_service", "slower_speech", "repeat_on_request", "tty"])).max(5),
});
export const HumanOutput = z.strictObject({
  handoff: z.strictObject({ status: RouteStatus, transferId: Id.nullable(), destinationPurpose: Purpose, supportReference: SupportRefArg.nullable() }),
});

const purposeOf = (destinations: readonly DestinationConfig[], id: string): z.infer<typeof Purpose> => destinations.find((d) => d.destinationId === id)?.purpose ?? "UNAVAILABLE";

/**
 * The journey fields the reported status reads. `awaitingRetry` is optional only for callers that
 * describe a journey by its status alone; an absent flag reads as false.
 */
export type RouteStatusInput = Pick<TransferJourney, "status" | "connectedAt"> & Partial<Pick<TransferJourney, "awaitingRetry">>;

/**
 * True when no route of the journey can be reached now: every route failed to dial in the last pass
 * (awaitingRetry, the sweep may retry later) or the staffed routes are exhausted
 * (HOLDING_FOR_OPERATIONS). Nothing is in flight then, so the platform must not claim a transfer: the
 * contact-centre flow takes its independent Studio route to a human (SAFE-03, SAFE-04; FO-21-10).
 */
export const routeUnreachable = (j: RouteStatusInput): boolean =>
  j.connectedAt === null && (j.status === "HOLDING_FOR_OPERATIONS" || (j.status === "ROUTING" && j.awaitingRetry === true));

/**
 * CONNECTED only after CALLER_CONFIRMED_CONNECTED and while nobody dropped (connectedAt set).
 * TRANSFER_REQUESTED only while an attempt can still connect. No journey, or a journey with no
 * reachable route, is ROUTE_UNAVAILABLE_USE_STUDIO_ROUTE (never a claimed transfer).
 */
export const statusOf = (j: RouteStatusInput | null): z.infer<typeof RouteStatus> =>
  !j || routeUnreachable(j) ? "ROUTE_UNAVAILABLE_USE_STUDIO_ROUTE" : journeyOutcome(j) === "TRANSFERRED" ? "CONNECTED" : "TRANSFER_REQUESTED";

/** Reason code when the session-less path has no trusted call id to route. */
export const CALL_UNIDENTIFIED = "CALL_UNIDENTIFIED_USE_STUDIO_ROUTE";

/**
 * What the tool reports for a handoff. With no reachable route nothing is in flight: no transfer id is
 * reported and the purpose is the journey's primary route (the one the contact-centre flow maps to its
 * own queue), never the last continuity route that failed to dial.
 */
const reported = (s: BusinessServices, r: HandoffResult): { status: z.infer<typeof RouteStatus>; transferId: string | null; destinationPurpose: z.infer<typeof Purpose> } => {
  const status = statusOf(r.journey);
  if (status !== "ROUTE_UNAVAILABLE_USE_STUDIO_ROUTE" || !r.journey) return { status, transferId: r.transferId, destinationPurpose: purposeOf(s.deps.destinations, r.destinationId) };
  return { status, transferId: null, destinationPurpose: purposeOf(s.deps.destinations, r.journey.routePlan[0] ?? r.destinationId) };
};

const humanData = (s: BusinessServices, r: HandoffResult): z.infer<typeof HumanOutput> => ({
  handoff: { ...reported(s, r), supportReference: r.supportReference ?? null },
});

const safetyData = (s: BusinessServices, r: HandoffResult): z.infer<typeof SafetyOutput> => ({
  handoff: reported(s, r),
});

/** "Connecting you now" is never spoken when no route can be reached; the next-route prompt is (the call is never ended). */
const humanSpeechTemplate = (r: HandoffResult): string =>
  r.speechTemplateId === "transfer.in_progress" && r.journey && routeUnreachable(r.journey) ? "transfer.failed_next_route" : r.speechTemplateId;

/** Safety prompt when the tool reports ROUTE_UNAVAILABLE_USE_STUDIO_ROUTE (DRAFT, pending the clinical safety lead). */
export const SAFETY_STUDIO_ROUTE_TEMPLATE_ID = "safety.studio_route";

/**
 * The safety tool's speech follows the status it reports (SAFE-04): the acknowledgment ("connecting you with a
 * person") only while a platform route can still connect; when no route can be reached, or the transfer could
 * not even be requested, the prompt says what happens next (the contact-centre's independent Studio safety
 * route) and never claims a connection the platform is not making.
 */
export const safetySpeechTemplate = (r: Pick<HandoffResult, "journey" | "speechTemplateId">): string =>
  statusOf(r.journey) === "ROUTE_UNAVAILABLE_USE_STUDIO_ROUTE" ? SAFETY_STUDIO_ROUTE_TEMPLATE_ID : r.speechTemplateId;

/** The conversational layer's request is itself an (unresolved) signal; credibility is never inferred from the model. */
const toolSignal = (input: z.infer<typeof SafetyInput>): SafetySignal => ({
  source: input.signalSource,
  ruleId: "tool.request_safety_route",
  strength: "UNRESOLVED",
  subject: input.concernSubject,
  temporal: "UNKNOWN",
  negated: false,
  locale: input.language,
});

export function requestHumanTransferTool(s: BusinessServices): ToolModule<z.infer<typeof HumanInput>, z.infer<typeof HumanOutput>> {
  return {
    definition: TOOL_DEFINITIONS.request_human_transfer,
    maskTarget: { collectionKey: "handoff", envelopeKeys: [] },
    input: HumanInput,
    output: HumanOutput,
    purpose: () => "human_handoff",
    resolveResource: async (auth) => openResource(auth, "support_request", "INTERNAL"),
    async execute(ctx, input) {
      const r = await s.handoff.requestHuman({
        tenantId: ctx.auth.tenantId,
        callId: ctx.auth.callId,
        ctx: ctx.auth,
        reason: input.reason,
        language: input.language,
        issueCategory: input.issueCategory,
        accommodations: input.accommodations,
      });
      return ok(humanData(s, r), speechFor(s.deps.templates, humanSpeechTemplate(r)));
    },
    async executeWithoutSession(ctx, input) {
      if (!ctx.callId) return failed(CALL_UNIDENTIFIED);
      // No destination can be supplied here: the HandoffService resolves it from trusted configuration (SAFE-05).
      const r = await s.handoff.requestHuman({
        tenantId: ctx.tenantId,
        callId: ctx.callId,
        ctx: null,
        reason: input.reason,
        language: input.language,
        issueCategory: input.issueCategory,
        accommodations: input.accommodations,
      });
      return ok(humanData(s, r), null);
    },
  };
}

export const SafetyInput = z.strictObject({
  signalSource: z.enum(["EXPLICIT_PHRASE", "SEMANTIC_SIGNAL", "CALLER_REQUEST"]),
  concernSubject: z.enum(["SELF", "THIRD_PARTY", "UNKNOWN"]),
  language: LanguageArg,
});
export const SafetyOutput = z.strictObject({
  handoff: z.strictObject({ status: RouteStatus, transferId: Id.nullable(), destinationPurpose: Purpose }),
});

export function requestSafetyRouteTool(s: BusinessServices): ToolModule<z.infer<typeof SafetyInput>, z.infer<typeof SafetyOutput>> {
  return {
    definition: TOOL_DEFINITIONS.request_safety_route,
    maskTarget: { collectionKey: "handoff", envelopeKeys: [] },
    input: SafetyInput,
    output: SafetyOutput,
    purpose: () => "safety_routing",
    resolveResource: async (auth) => openResource(auth, "support_request", "INTERNAL"),
    async execute(ctx, input) {
      // Deterministic routing does the rest of the work from the unresolved signal.
      const r = await s.handoff.requestSafetyRoute({ tenantId: ctx.auth.tenantId, callId: ctx.auth.callId, ctx: ctx.auth, signals: [toolSignal(input)], locale: input.language, validatedAt: ctx.now });
      return ok(safetyData(s, r), speechFor(s.deps.templates, safetySpeechTemplate(r)));
    },
    async executeWithoutSession(ctx, input) {
      if (!ctx.callId) return failed(CALL_UNIDENTIFIED);
      const r = await s.handoff.requestSafetyRoute({ tenantId: ctx.tenantId, callId: ctx.callId, ctx: null, signals: [toolSignal(input)], locale: input.language, validatedAt: ctx.now });
      return ok(safetyData(s, r), null);
    },
  };
}
