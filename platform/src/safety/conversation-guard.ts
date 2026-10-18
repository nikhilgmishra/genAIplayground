/**
 * Conversation guard: turn, silence, refusal, guardrail-trigger, duration and
 * cost limits that NEVER terminate a call (spec sections 2, 10 and 12; SAFE-02,
 * SAFE-03).
 *
 * Talkdesk documents that a guardrail trigger limit can close a conversation.
 * This guard is the application-side policy: when a limit is reached it offers
 * or transfers to a human (or plays an approved template) instead. Its action
 * union has no terminate / hang-up member at all; disconnect authority belongs
 * to the caller or a human.
 *
 * In safety mode, or while a transfer is in progress, limits are ignored
 * except to escalate to the safety route. Safety mode is sticky: no event
 * clears it. Budget exhaustion never disconnects an active safety handoff; it
 * only stops new nonessential automation and routes non-safety callers to the
 * approved continuity service.
 *
 * `decide(state, event)` is pure (no I/O, no clock, input state untouched) so
 * the invariants are property-tested. `ConversationGuard` keeps per-call state
 * in memory (LOCAL FIXTURE store).
 */
import { z } from "zod";
import type { Logger } from "../observability/ports.js";
import { silentLogger } from "../observability/logger.js";
import { OpaqueId } from "../protocol/index.js";
import type { TransferReason } from "../protocol/index.js";
import { SAFETY_ACKNOWLEDGMENT_TEMPLATE_ID, SAFETY_PRIORITY_DESTINATION_ID } from "./router.js";

// ---------------------------------------------------------------------------
// Limits, state, events, actions
// ---------------------------------------------------------------------------

export const GuardLimitsSchema = z
  .strictObject({
    /** OFFER_HUMAN once at this many completed turns. */
    softTurnLimit: z.number().int().min(1).max(1000),
    /** TRANSFER_HUMAN at this many completed turns. */
    maxTurns: z.number().int().min(2).max(1000),
    /** Consecutive silence timeouts answered with the check-in template before offering a human. */
    silenceCheckIns: z.number().int().min(0).max(10),
    /** TRANSFER_HUMAN (accessibility route) at this many consecutive silence timeouts. */
    maxConsecutiveSilences: z.number().int().min(1).max(20),
    maxRefusals: z.number().int().min(1).max(20),
    /** Application limit; must stay below the vendor trigger limit so we transfer before the vendor closes. */
    maxGuardrailTriggers: z.number().int().min(1).max(20),
    /** Talkdesk guardrail trigger limit for this agent; null = not yet evidenced (TB-05). */
    vendorGuardrailTriggerLimit: z.number().int().min(1).max(50).nullable(),
    /** Per-call automation cost ceiling in integer micro-USD; null = only the budget service applies. */
    maxCallCostMicroUsd: z.number().int().min(0).nullable(),
  })
  .refine((l) => l.softTurnLimit < l.maxTurns, { message: "SOFT_TURN_LIMIT_NOT_BELOW_MAX" })
  .refine((l) => l.silenceCheckIns < l.maxConsecutiveSilences, { message: "SILENCE_CHECKINS_NOT_BELOW_MAX" })
  .refine((l) => l.vendorGuardrailTriggerLimit === null || l.maxGuardrailTriggers < l.vendorGuardrailTriggerLimit, {
    message: "GUARDRAIL_LIMIT_NOT_BELOW_VENDOR_LIMIT",
  });
export type GuardLimits = z.infer<typeof GuardLimitsSchema>;

/**
 * Planning placeholders, NOT approved operational values: support operations
 * and the safety lead set the real limits; the vendor limit must be evidenced.
 */
export const DEFAULT_GUARD_LIMITS: GuardLimits = Object.freeze({
  softTurnLimit: 30,
  maxTurns: 40,
  silenceCheckIns: 1,
  maxConsecutiveSilences: 3,
  maxRefusals: 2,
  maxGuardrailTriggers: 2,
  vendorGuardrailTriggerLimit: null,
  maxCallCostMicroUsd: null,
});

export const GuardEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("TURN_COMPLETED") }),
  z.strictObject({ type: z.literal("SILENCE_TIMEOUT") }),
  z.strictObject({ type: z.literal("MODEL_REFUSAL") }),
  z.strictObject({ type: z.literal("GUARDRAIL_TRIGGERED") }),
  z.strictObject({ type: z.literal("MAX_DURATION_REACHED") }),
  z.strictObject({ type: z.literal("COST_RECORDED"), microUsd: z.number().int().min(0).max(1_000_000_000) }),
  z.strictObject({ type: z.literal("BUDGET_EXHAUSTED") }),
  z.strictObject({ type: z.literal("BUDGET_RESTORED") }),
  z.strictObject({ type: z.literal("SAFETY_SIGNAL") }),
  z.strictObject({ type: z.literal("CALLER_REQUESTED_HUMAN") }),
  z.strictObject({ type: z.literal("HUMAN_OFFER_ACCEPTED") }),
  z.strictObject({ type: z.literal("HUMAN_OFFER_DECLINED") }),
  z.strictObject({ type: z.literal("UNSUPPORTED_LANGUAGE") }),
  z.strictObject({ type: z.literal("TRANSFER_STARTED"), priority: z.enum(["STANDARD", "SAFETY"]) }),
  z.strictObject({ type: z.literal("TRANSFER_FAILED") }),
  z.strictObject({ type: z.literal("TRANSFER_CONNECTED") }),
  z.strictObject({ type: z.literal("CALLER_DISCONNECTED") }),
]);
export type GuardEvent = z.infer<typeof GuardEventSchema>;
export type GuardEventType = GuardEvent["type"];

export interface GuardState {
  readonly limits: GuardLimits;
  readonly turns: number;
  readonly consecutiveSilences: number;
  readonly totalSilences: number;
  readonly refusals: number;
  readonly guardrailTriggers: number;
  readonly costMicroUsd: number;
  readonly budgetExhausted: boolean;
  readonly humanOffered: boolean;
  /** Destination of the pending human offer, if any. */
  readonly offeredDestinationId: string | null;
  /** Sticky: once true it never returns to false. */
  readonly safetyModeActive: boolean;
  readonly transfer: "NONE" | "ACTIVE";
  readonly humanConnected: boolean;
  readonly callerDisconnected: boolean;
  readonly interpreterRequired: boolean;
}

export type SafetyRouteStep = "INITIATE" | "MAINTAIN" | "UPDATE_CALLER" | "HUMAN_CONNECTED" | "NOTIFY_SAFETY_RESPONDER";

/** The complete action vocabulary. There is deliberately no terminate / hang-up action. */
export type GuardAction =
  | { kind: "CONTINUE"; reasonCode: string }
  | { kind: "PLAY_TEMPLATE"; templateId: string; reasonCode: string }
  | { kind: "OFFER_HUMAN"; templateId: string; destinationId: string; requiresAuthentication: false; reasonCode: string }
  | {
      kind: "TRANSFER_HUMAN";
      templateId: string;
      destinationId: string;
      transferReason: TransferReason;
      requiresAuthentication: false;
      reasonCode: string;
    }
  | {
      kind: "SAFETY_ROUTE";
      step: SafetyRouteStep;
      templateId: string | null;
      destinationId: typeof SAFETY_PRIORITY_DESTINATION_ID;
      revokePendingActions: true;
      requiresAuthentication: false;
      reasonCode: string;
    };
export type GuardActionKind = GuardAction["kind"];
export const GUARD_ACTION_KINDS: readonly GuardActionKind[] = ["CONTINUE", "PLAY_TEMPLATE", "OFFER_HUMAN", "TRANSFER_HUMAN", "SAFETY_ROUTE"];

export interface GuardDecision {
  state: GuardState;
  action: GuardAction;
}

export const GUARD_TEMPLATES = {
  silenceCheckIn: "silence.check_in",
  humanOffer: "human.offer",
  transferInProgress: "transfer.in_progress",
  transferFailed: "transfer.failed_next_route",
  safetyTransferUpdate: "transfer.safety_update",
  safetyAcknowledgment: SAFETY_ACKNOWLEDGMENT_TEMPLATE_ID,
  outageContinuity: "outage.continuity",
  unsupportedLanguage: "language.unsupported",
} as const;

export const GUARD_DESTINATIONS = {
  standard: "dst_support_general",
  interpreter: "dst_interpreter",
  continuity: "dst_outage_continuity",
  safety: SAFETY_PRIORITY_DESTINATION_ID,
} as const;

export function initialGuardState(limits: GuardLimits = DEFAULT_GUARD_LIMITS, opts: { safetyModeActive?: boolean } = {}): GuardState {
  const parsed = GuardLimitsSchema.parse(limits);
  return Object.freeze({
    limits: Object.freeze({ ...parsed }),
    turns: 0,
    consecutiveSilences: 0,
    totalSilences: 0,
    refusals: 0,
    guardrailTriggers: 0,
    costMicroUsd: 0,
    budgetExhausted: false,
    humanOffered: false,
    offeredDestinationId: null,
    safetyModeActive: opts.safetyModeActive === true,
    transfer: "NONE",
    humanConnected: false,
    callerDisconnected: false,
    interpreterRequired: false,
  });
}

// ---------------------------------------------------------------------------
// Pure decision function
// ---------------------------------------------------------------------------

const cont = (reasonCode: string): GuardAction => ({ kind: "CONTINUE", reasonCode });

const offer = (destinationId: string, reasonCode: string): GuardAction => ({
  kind: "OFFER_HUMAN",
  templateId: GUARD_TEMPLATES.humanOffer,
  destinationId,
  requiresAuthentication: false,
  reasonCode,
});

const transfer = (destinationId: string, transferReason: TransferReason, reasonCode: string, templateId: string = GUARD_TEMPLATES.transferInProgress): GuardAction => ({
  kind: "TRANSFER_HUMAN",
  templateId,
  destinationId,
  transferReason,
  requiresAuthentication: false,
  reasonCode,
});

const safety = (step: SafetyRouteStep, reasonCode: string, templateId: string | null = null): GuardAction => ({
  kind: "SAFETY_ROUTE",
  step,
  templateId,
  destinationId: SAFETY_PRIORITY_DESTINATION_ID,
  revokePendingActions: true,
  requiresAuthentication: false,
  reasonCode,
});

/** Counters only; never decides anything. */
function count(s: GuardState, e: GuardEvent): GuardState {
  switch (e.type) {
    case "TURN_COMPLETED":
      return { ...s, turns: s.turns + 1, consecutiveSilences: 0 };
    case "SILENCE_TIMEOUT":
      return { ...s, consecutiveSilences: s.consecutiveSilences + 1, totalSilences: s.totalSilences + 1 };
    case "MODEL_REFUSAL":
      return { ...s, refusals: s.refusals + 1 };
    case "GUARDRAIL_TRIGGERED":
      return { ...s, guardrailTriggers: s.guardrailTriggers + 1 };
    case "COST_RECORDED":
      return { ...s, costMicroUsd: s.costMicroUsd + e.microUsd };
    case "BUDGET_EXHAUSTED":
      return { ...s, budgetExhausted: true };
    case "BUDGET_RESTORED":
      return { ...s, budgetExhausted: false };
    case "SAFETY_SIGNAL":
      return { ...s, safetyModeActive: true };
    case "UNSUPPORTED_LANGUAGE":
      return { ...s, interpreterRequired: true };
    case "TRANSFER_STARTED":
      return { ...s, transfer: "ACTIVE" };
    case "TRANSFER_FAILED":
      return { ...s, transfer: "NONE" };
    case "TRANSFER_CONNECTED":
      return { ...s, transfer: "NONE", humanConnected: true };
    case "CALLER_DISCONNECTED":
      return { ...s, callerDisconnected: true };
    case "HUMAN_OFFER_DECLINED":
      return { ...s, offeredDestinationId: null };
    default:
      return s;
  }
}

/** Safety mode: every event yields a SAFETY_ROUTE action; limits and budget never end the route. */
function decideSafety(prev: GuardState, s: GuardState, e: GuardEvent): GuardAction {
  switch (e.type) {
    case "SAFETY_SIGNAL":
    case "CALLER_REQUESTED_HUMAN":
    case "HUMAN_OFFER_ACCEPTED":
      if (!prev.safetyModeActive || (s.transfer === "NONE" && !s.humanConnected)) {
        return safety("INITIATE", prev.safetyModeActive ? "SAFETY_ROUTE_REINITIATE" : "SAFETY_ROUTE_START", GUARD_TEMPLATES.safetyAcknowledgment);
      }
      return safety("MAINTAIN", "SAFETY_ROUTE_IN_PROGRESS");
    case "TRANSFER_STARTED":
      return safety("MAINTAIN", "SAFETY_TRANSFER_STARTED");
    case "TRANSFER_FAILED":
      // The transfer coordinator cycles staffed safety routes and continuity; the caller is updated, never dropped.
      return safety("UPDATE_CALLER", "SAFETY_TRANSFER_RETRY_NEXT_ROUTE", GUARD_TEMPLATES.safetyTransferUpdate);
    case "TRANSFER_CONNECTED":
      return safety("HUMAN_CONNECTED", "SAFETY_HUMAN_CONNECTED");
    case "CALLER_DISCONNECTED":
      // Disconnect procedure is owned by the safety lead; automation only notifies the responder.
      return safety("NOTIFY_SAFETY_RESPONDER", "SAFETY_CALLER_DISCONNECTED");
    case "SILENCE_TIMEOUT":
      return s.humanConnected
        ? safety("MAINTAIN", "SAFETY_LIMITS_IGNORED")
        : safety("UPDATE_CALLER", "SAFETY_HOLD_UPDATE", GUARD_TEMPLATES.safetyTransferUpdate);
    case "BUDGET_EXHAUSTED":
    case "COST_RECORDED":
      return safety("MAINTAIN", "SAFETY_RESERVE_IN_USE");
    case "UNSUPPORTED_LANGUAGE":
      return safety("MAINTAIN", "SAFETY_INTERPRETER_REQUIRED");
    default:
      return safety("MAINTAIN", "SAFETY_LIMITS_IGNORED");
  }
}

function overCost(s: GuardState): boolean {
  return s.budgetExhausted || (s.limits.maxCallCostMicroUsd !== null && s.costMicroUsd > s.limits.maxCallCostMicroUsd);
}

/** Normal mode, no transfer and no human yet. */
function decideNormal(s: GuardState, e: GuardEvent): { state: GuardState; action: GuardAction } {
  const L = s.limits;
  const offerOnce = (destinationId: string, reasonCode: string, otherwise: GuardAction): { state: GuardState; action: GuardAction } =>
    s.humanOffered ? { state: s, action: otherwise } : { state: { ...s, humanOffered: true, offeredDestinationId: destinationId }, action: offer(destinationId, reasonCode) };

  switch (e.type) {
    case "CALLER_REQUESTED_HUMAN":
      return { state: s, action: transfer(GUARD_DESTINATIONS.standard, "CALLER_REQUESTED_HUMAN", "CALLER_REQUESTED_HUMAN") };
    case "HUMAN_OFFER_ACCEPTED":
      return {
        state: { ...s, offeredDestinationId: null },
        action: transfer(s.offeredDestinationId ?? GUARD_DESTINATIONS.standard, "CALLER_REQUESTED_HUMAN", "HUMAN_OFFER_ACCEPTED"),
      };
    case "UNSUPPORTED_LANGUAGE":
      return { state: s, action: transfer(GUARD_DESTINATIONS.interpreter, "UNSUPPORTED_LANGUAGE", "UNSUPPORTED_LANGUAGE_INTERPRETER", GUARD_TEMPLATES.unsupportedLanguage) };
    case "BUDGET_EXHAUSTED":
    case "COST_RECORDED":
      if (overCost(s)) {
        return { state: s, action: transfer(GUARD_DESTINATIONS.continuity, "AI_UNAVAILABLE", "BUDGET_EXHAUSTED_CONTINUITY", GUARD_TEMPLATES.outageContinuity) };
      }
      return { state: s, action: cont("COST_WITHIN_LIMIT") };
    case "TRANSFER_FAILED":
      return { state: s, action: transfer(GUARD_DESTINATIONS.continuity, "DEPENDENCY_FAILURE", "TRANSFER_FAILED_NEXT_ROUTE", GUARD_TEMPLATES.transferFailed) };
    case "MAX_DURATION_REACHED":
      return { state: s, action: transfer(GUARD_DESTINATIONS.standard, "POLICY_REQUIRES_HUMAN", "MAX_DURATION_HUMAN_ROUTE") };
    case "SILENCE_TIMEOUT":
      if (s.consecutiveSilences >= L.maxConsecutiveSilences) {
        // A silent caller may be using assistive communication or relay: a human, never a hang-up.
        return { state: s, action: transfer(GUARD_DESTINATIONS.standard, "ACCESSIBILITY", "SILENCE_LIMIT_HUMAN_ROUTE") };
      }
      if (s.consecutiveSilences <= L.silenceCheckIns) {
        return { state: s, action: { kind: "PLAY_TEMPLATE", templateId: GUARD_TEMPLATES.silenceCheckIn, reasonCode: "SILENCE_CHECK_IN" } };
      }
      return offerOnce(GUARD_DESTINATIONS.standard, "SILENCE_OFFER_HUMAN", { kind: "PLAY_TEMPLATE", templateId: GUARD_TEMPLATES.silenceCheckIn, reasonCode: "SILENCE_CHECK_IN" });
    case "MODEL_REFUSAL":
      if (s.refusals >= L.maxRefusals) return { state: s, action: transfer(GUARD_DESTINATIONS.standard, "POLICY_REQUIRES_HUMAN", "REFUSAL_LIMIT_HUMAN_ROUTE") };
      if (s.refusals === L.maxRefusals - 1) return offerOnce(GUARD_DESTINATIONS.standard, "REFUSAL_OFFER_HUMAN", cont("REFUSAL_COUNTED"));
      return { state: s, action: cont("REFUSAL_COUNTED") };
    case "GUARDRAIL_TRIGGERED":
      if (s.guardrailTriggers >= L.maxGuardrailTriggers) {
        return { state: s, action: transfer(GUARD_DESTINATIONS.standard, "POLICY_REQUIRES_HUMAN", "GUARDRAIL_LIMIT_HUMAN_ROUTE") };
      }
      if (s.guardrailTriggers === L.maxGuardrailTriggers - 1) return offerOnce(GUARD_DESTINATIONS.standard, "GUARDRAIL_OFFER_HUMAN", cont("GUARDRAIL_COUNTED"));
      return { state: s, action: cont("GUARDRAIL_COUNTED") };
    case "TURN_COMPLETED":
      if (s.turns >= L.maxTurns) return { state: s, action: transfer(GUARD_DESTINATIONS.standard, "POLICY_REQUIRES_HUMAN", "TURN_LIMIT_HUMAN_ROUTE") };
      if (s.turns >= L.softTurnLimit) return offerOnce(GUARD_DESTINATIONS.standard, "TURN_LIMIT_OFFER_HUMAN", cont("TURN_COUNTED"));
      return { state: s, action: cont("TURN_COUNTED") };
    case "CALLER_DISCONNECTED":
      return { state: s, action: cont("CALLER_DISCONNECTED") };
    default:
      return { state: s, action: cont("EVENT_RECORDED") };
  }
}

/**
 * Pure guard decision. Never mutates `state`; never returns a terminating
 * action. Invariant (SAFE-03): if the resulting state is in safety mode the
 * action is always a SAFETY_ROUTE to the safety priority destination.
 */
export function decide(state: GuardState, event: GuardEvent): GuardDecision {
  const next = count(state, event);
  if (next.safetyModeActive) {
    return { state: Object.freeze(next), action: decideSafety(state, next, event) };
  }
  if (next.humanConnected) {
    // A human owns the call now; automation limits no longer apply.
    return { state: Object.freeze(next), action: cont("HUMAN_CONNECTED") };
  }
  if (state.transfer === "ACTIVE" && next.transfer === "ACTIVE") {
    // Limits are ignored while a transfer is in progress (only SAFETY_SIGNAL escalates, handled above).
    return { state: Object.freeze(next), action: cont(event.type === "TRANSFER_STARTED" ? "TRANSFER_STARTED" : "TRANSFER_ACTIVE_LIMITS_IGNORED") };
  }
  if (event.type === "TRANSFER_STARTED") {
    return { state: Object.freeze(next), action: cont("TRANSFER_STARTED") };
  }
  const r = decideNormal(next, event);
  return { state: Object.freeze(r.state), action: r.action };
}

// ---------------------------------------------------------------------------
// Stateful wrapper (LOCAL FIXTURE store)
// ---------------------------------------------------------------------------

export interface ConversationGuardOptions {
  limits?: GuardLimits;
  logger?: Logger;
  /** Bound on tracked calls; the oldest is evicted (its next event re-initializes with hints). */
  maxCalls?: number;
}

/**
 * Per-call guard. The in-memory state map is a LOCAL FIXTURE; a deployment
 * keeps the counters with the call session. Safety mode can always be
 * re-established from the session (`hints.safetyModeActive`), so losing guard
 * state can never downgrade a safety call.
 */
export class ConversationGuard {
  readonly kind = "local_fixture" as const;
  private readonly limits: GuardLimits;
  private readonly logger: Logger;
  private readonly maxCalls: number;
  private readonly states = new Map<string, GuardState>();

  constructor(opts: ConversationGuardOptions = {}) {
    this.limits = GuardLimitsSchema.parse(opts.limits ?? DEFAULT_GUARD_LIMITS);
    this.logger = (opts.logger ?? silentLogger).child({ component: "conversation_guard" });
    this.maxCalls = opts.maxCalls ?? 50_000;
  }

  start(callId: string, opts: { safetyModeActive?: boolean } = {}): GuardState {
    OpaqueId.parse(callId);
    const s = initialGuardState(this.limits, opts);
    this.put(callId, s);
    return s;
  }

  state(callId: string): GuardState | null {
    return this.states.get(callId) ?? null;
  }

  /** Applies an untrusted event. Invalid events fail safe (safety route in safety mode, otherwise a human offer). */
  apply(callId: string, event: unknown, hints: { safetyModeActive?: boolean } = {}): GuardDecision {
    if (!OpaqueId.safeParse(callId).success) throw new Error("GUARD_CALL_ID_INVALID");
    let s = this.states.get(callId) ?? initialGuardState(this.limits, hints);
    if (hints.safetyModeActive === true && !s.safetyModeActive) s = Object.freeze({ ...s, safetyModeActive: true });
    const parsed = GuardEventSchema.safeParse(event);
    let decision: GuardDecision;
    if (!parsed.success) {
      this.logger.warn("guard.event.invalid", { reasonCode: "GUARD_EVENT_INVALID", callId });
      decision = {
        state: s,
        action: s.safetyModeActive ? safety("MAINTAIN", "GUARD_EVENT_INVALID") : offer(GUARD_DESTINATIONS.standard, "GUARD_EVENT_INVALID"),
      };
    } else {
      decision = decide(s, parsed.data);
    }
    this.put(callId, decision.state);
    this.logger.info("guard.decision", { callId, event: parsed.success ? parsed.data.type : "INVALID", action: decision.action.kind, reasonCode: decision.action.reasonCode });
    return decision;
  }

  end(callId: string): void {
    this.states.delete(callId);
  }

  private put(callId: string, s: GuardState): void {
    this.states.delete(callId);
    this.states.set(callId, s);
    while (this.states.size > this.maxCalls) {
      const oldest = this.states.keys().next().value;
      if (oldest === undefined) break;
      this.states.delete(oldest);
    }
  }
}
