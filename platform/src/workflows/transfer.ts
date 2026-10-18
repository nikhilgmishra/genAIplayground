/**
 * Warm-transfer state machine and coordinator (spec section 10).
 *
 * Contract: REQUESTED -> QUEUED -> RECEIVER_ACCEPTED -> BRIDGED ->
 * CALLER_CONFIRMED_CONNECTED -> COMPLETED, with timeout, failure and
 * disconnect events. A successful dial command is NOT a transfer (SAFE-04):
 * the outcome is TRANSFERRED only once the caller is confirmed connected,
 * which requires receiver acceptance and a bridge first.
 *
 * Destinations come only from the trusted DestinationConfig allowlist; ids
 * that look like phone numbers, SIP/tel URIs or URLs are refused (SAFE-05).
 * On TIMED_OUT / RECEIVER_UNAVAILABLE / BRIDGE_DROPPED / dial failure the
 * coordinator plays an approved update (template id only) and invokes the
 * next staffed route; when fallbacks are exhausted it routes to the
 * OUTAGE_CONTINUITY destination. It never ends the call: the TelephonyControl
 * port has no hang-up operation and the coordinator keeps the caller
 * connected (OPS-02). SAFETY transfers are never abandoned by timeouts,
 * attempt counts or budget limits (SAFE-03); they cycle through the staffed
 * safety routes and continuity indefinitely, and time-to-route-initiation is
 * measured with the injected Clock against the 2 s engineering target.
 *
 * A bridge drop after CALLER_CONFIRMED_CONNECTED re-enters the fallback chain
 * (SAFE-03/SAFE-04, finding SAFE-HANDOFF-01): the journey goes back to ROUTING
 * whenever a new attempt is in flight, so the sweep times it out and retries it
 * like any other unanswered attempt; "CONNECTED" always means a human is on the
 * line right now (connectedAt set).
 *
 * At most one non-terminal journey per call, SAFETY first (SAFE-03, finding
 * SAFE-HANDOFF-02): starting (or re-requesting) a SAFETY journey supersedes every
 * active STANDARD journey of the call (status SUPERSEDED: no further timeouts,
 * failovers, update prompts or dials; later vendor events on it are recorded and
 * rejected), and a STANDARD request while a SAFETY journey of the call is ROUTING
 * or CONNECTED dials nothing and returns that SAFETY journey. The TelephonyControl
 * port has no cancel operation, so a STANDARD dial already in flight at the vendor
 * is not withdrawn there (TB-07); it is only never retried or failed over.
 */
import { z } from "zod";
import type { TelephonyControl } from "../adapters/ports.js";
import type { AuditWriter } from "../audit/ports.js";
import type { DestinationConfig } from "../config/ports.js";
import { silentLogger } from "../observability/logger.js";
import type { Logger } from "../observability/ports.js";
import {
  DestinationId,
  HandoffPackage,
  IsoDateTime,
  TransferRecord,
  opaqueIdWithPrefix,
  type AuditOutcome,
  type Environment,
  type Outcome,
  type TransferReason,
  type TransferState,
} from "../protocol/index.js";
import { iso, type Clock } from "../shared/clock.js";
import { AccessDeniedError, ConfigurationRejectedError, ConflictError, DependencyError, ValidationError } from "../shared/errors.js";
import { newId } from "../shared/ids.js";

// ---------------------------------------------------------------------------
// Pure state machine
// ---------------------------------------------------------------------------

export const TransferEventName = z.enum([
  "QUEUED",
  "RECEIVER_ACCEPTED",
  "PACKAGE_ACKNOWLEDGED",
  "BRIDGED",
  "CALLER_CONFIRMED_CONNECTED",
  "COMPLETE",
  "TIMEOUT",
  "RECEIVER_UNAVAILABLE",
  "BRIDGE_DROPPED",
  "CALLER_DISCONNECTED",
  "DIAL_FAILED",
]);
export type TransferEventName = z.infer<typeof TransferEventName>;

/** The only forward path. COMPLETED requires every predecessor except the optional QUEUED. */
export const TRANSFER_PROGRESSION: readonly TransferState[] = [
  "REQUESTED",
  "QUEUED",
  "RECEIVER_ACCEPTED",
  "BRIDGED",
  "CALLER_CONFIRMED_CONNECTED",
  "COMPLETED",
];

const PROGRESS_EVENTS: Partial<Record<TransferEventName, TransferState>> = {
  QUEUED: "QUEUED",
  RECEIVER_ACCEPTED: "RECEIVER_ACCEPTED",
  BRIDGED: "BRIDGED",
  CALLER_CONFIRMED_CONNECTED: "CALLER_CONFIRMED_CONNECTED",
  COMPLETE: "COMPLETED",
};

type FailureEvent = "TIMEOUT" | "RECEIVER_UNAVAILABLE" | "BRIDGE_DROPPED" | "CALLER_DISCONNECTED" | "DIAL_FAILED";
const FAILURE_EVENTS: Record<FailureEvent, TransferState> = {
  TIMEOUT: "TIMED_OUT",
  RECEIVER_UNAVAILABLE: "RECEIVER_UNAVAILABLE",
  BRIDGE_DROPPED: "BRIDGE_DROPPED",
  CALLER_DISCONNECTED: "CALLER_DISCONNECTED",
  DIAL_FAILED: "FAILED",
};
const FAILURE_ALLOWED_FROM: Record<FailureEvent, readonly TransferState[]> = {
  TIMEOUT: ["REQUESTED", "QUEUED", "RECEIVER_ACCEPTED", "BRIDGED"],
  RECEIVER_UNAVAILABLE: ["REQUESTED", "QUEUED"],
  BRIDGE_DROPPED: ["RECEIVER_ACCEPTED", "BRIDGED", "CALLER_CONFIRMED_CONNECTED"],
  CALLER_DISCONNECTED: ["REQUESTED", "QUEUED", "RECEIVER_ACCEPTED", "BRIDGED", "CALLER_CONFIRMED_CONNECTED"],
  DIAL_FAILED: ["REQUESTED"],
};

export const TERMINAL_TRANSFER_STATES: ReadonlySet<TransferState> = new Set<TransferState>([
  "COMPLETED",
  "TIMED_OUT",
  "RECEIVER_UNAVAILABLE",
  "BRIDGE_DROPPED",
  "CALLER_DISCONNECTED",
  "FAILED",
]);
/** Attempt outcomes that trigger an approved update and the next staffed route. */
export const FAILOVER_STATES: ReadonlySet<TransferState> = new Set<TransferState>(["TIMED_OUT", "RECEIVER_UNAVAILABLE", "BRIDGE_DROPPED", "FAILED"]);
const ACK_STATES: ReadonlySet<TransferState> = new Set<TransferState>(["RECEIVER_ACCEPTED", "BRIDGED", "CALLER_CONFIRMED_CONNECTED", "COMPLETED"]);

export type TransferDecision =
  | { kind: "applied"; next: TransferState }
  | { kind: "acknowledged" }
  | { kind: "duplicate" }
  | { kind: "rejected"; reasonCode: string };

/**
 * Pure transition function. Duplicates (target already reached) are ignored;
 * invalid or out-of-order events are rejected without changing anything.
 */
export function transferTransition(
  attempt: Pick<TransferRecord, "state" | "history" | "receiverAcknowledgedPackage">,
  event: TransferEventName,
): TransferDecision {
  const cur = attempt.state;
  const seen = (s: TransferState) => cur === s || attempt.history.some((h) => h.state === s);

  if (event === "PACKAGE_ACKNOWLEDGED") {
    if (attempt.receiverAcknowledgedPackage) return { kind: "duplicate" };
    return ACK_STATES.has(cur) ? { kind: "acknowledged" } : { kind: "rejected", reasonCode: "PACKAGE_ACK_BEFORE_ACCEPTANCE" };
  }

  const progress = PROGRESS_EVENTS[event];
  if (progress !== undefined) {
    const curRank = TRANSFER_PROGRESSION.indexOf(cur);
    const targetRank = TRANSFER_PROGRESSION.indexOf(progress);
    if (curRank === -1) return seen(progress) ? { kind: "duplicate" } : { kind: "rejected", reasonCode: "TRANSFER_ATTEMPT_CLOSED" };
    if (targetRank <= curRank) return { kind: "duplicate" };
    const optionalQueueSkip = cur === "REQUESTED" && progress === "RECEIVER_ACCEPTED";
    if (targetRank === curRank + 1 || optionalQueueSkip) return { kind: "applied", next: progress };
    return { kind: "rejected", reasonCode: "TRANSFER_EVENT_OUT_OF_ORDER" };
  }

  const failure = FAILURE_EVENTS[event as FailureEvent];
  if (cur === failure) return { kind: "duplicate" };
  if (TERMINAL_TRANSFER_STATES.has(cur)) return seen(failure) ? { kind: "duplicate" } : { kind: "rejected", reasonCode: "TRANSFER_ATTEMPT_CLOSED" };
  if (!FAILURE_ALLOWED_FROM[event as FailureEvent].includes(cur)) return { kind: "rejected", reasonCode: "TRANSFER_EVENT_NOT_APPLICABLE" };
  return { kind: "applied", next: failure };
}

// ---------------------------------------------------------------------------
// Destination allowlist (SAFE-05)
// ---------------------------------------------------------------------------

/** True for anything that could be dialled or fetched directly: phone numbers, tel/sip URIs, URLs, emails. */
export function looksLikeDialTarget(value: string): boolean {
  if (typeof value !== "string") return true;
  const digits = (value.match(/\d/g) ?? []).length;
  return (
    /^\s*\+/.test(value) ||
    digits >= 7 ||
    /\b(tel|sip|sips|callto|https?|wss?|ftp)\s*:/i.test(value) ||
    value.includes("@") ||
    value.includes("/") ||
    value.includes("\\")
  );
}

const TEMPLATE_ID = /^[a-z][a-z0-9_.]{2,63}$/;

export function validateDestinations(destinations: readonly DestinationConfig[]): string[] {
  const violations: string[] = [];
  const ids = new Set<string>();
  for (const d of destinations) {
    if (!DestinationId.safeParse(d.destinationId).success || looksLikeDialTarget(d.destinationId)) violations.push("DESTINATION_ID_INVALID");
    if (looksLikeDialTarget(d.vendorQueueRef) || d.vendorQueueRef.length === 0 || d.vendorQueueRef.length > 128) violations.push("VENDOR_QUEUE_REF_INVALID");
    if (ids.has(d.destinationId)) violations.push("DESTINATION_ID_DUPLICATE");
    ids.add(d.destinationId);
  }
  for (const d of destinations) {
    for (const f of d.fallbackDestinationIds) if (!ids.has(f)) violations.push("FALLBACK_DESTINATION_UNDEFINED");
  }
  if (!destinations.some((d) => d.purpose === "OUTAGE_CONTINUITY")) violations.push("OUTAGE_CONTINUITY_DESTINATION_MISSING");
  if (!destinations.some((d) => d.purpose === "SAFETY_PRIORITY")) violations.push("SAFETY_DESTINATION_MISSING");
  return [...new Set(violations)];
}

// ---------------------------------------------------------------------------
// Journey and store
// ---------------------------------------------------------------------------

/**
 * ROUTING: an attempt is in flight (or awaiting a retry) and nobody is connected.
 * CONNECTED: the caller is confirmed connected to a human now (connectedAt set).
 * SUPERSEDED: a STANDARD journey replaced by the call's SAFETY journey (terminal).
 */
export type JourneyStatus = "ROUTING" | "CONNECTED" | "COMPLETED" | "CALLER_DISCONNECTED" | "HOLDING_FOR_OPERATIONS" | "SUPERSEDED";

/** Journeys that still own the call's route (a SAFETY journey never holds for operations). */
export function isActiveJourney(j: Pick<TransferJourney, "status">): boolean {
  return j.status === "ROUTING" || j.status === "CONNECTED" || j.status === "HOLDING_FOR_OPERATIONS";
}

export interface SafetyRouteTiming {
  validatedSafetyEventAt: string;
  routeInitiatedAt: string | null;
  timeToRouteInitiationMs: number | null;
  targetMs: number;
  withinTarget: boolean | null;
}

/** One caller's transfer journey across attempts. Opaque ids only. */
export interface TransferJourney {
  handoffId: string;
  tenantId: string;
  callId: string;
  sessionGeneration: number;
  reason: TransferReason;
  priority: "SAFETY" | "STANDARD";
  /** Ordered staffed routes: primary, its fallbacks (transitively), then outage continuity. */
  routePlan: string[];
  routeIndex: number;
  status: JourneyStatus;
  currentTransferId: string | null;
  /** Bounded attempt history (most recent last). */
  attempts: TransferRecord[];
  attemptCount: number;
  continuityAttempts: number;
  /** Vendor transfer references by platform transfer id. */
  vendorRefs: Record<string, string>;
  /** True when every route failed to dial in one pass; the sweep retries (never abandoned). */
  awaitingRetry: boolean;
  updatesPlayed: number;
  connectedAt: string | null;
  destinationCorrected: boolean;
  safety: SafetyRouteTiming | null;
  appliedEventIds: string[];
  auditGaps: number;
  persistenceGaps: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface TransferStore {
  readonly kind: "local_fixture" | "live";
  get(handoffId: string): Promise<TransferJourney | null>;
  findByTransferId(transferId: string): Promise<TransferJourney | null>;
  /** Conditional write: expectedVersion null creates (fails if present); otherwise the stored version must match. */
  put(journey: TransferJourney, expectedVersion: number | null): Promise<void>;
  /** Journeys with an attempt in flight or awaiting retry (status ROUTING): the sweep's work list. */
  listActive(): Promise<TransferJourney[]>;
  /** Every journey of one call (any status), oldest first: the one-active-journey-per-call invariant. */
  listForCall(tenantId: string, callId: string): Promise<TransferJourney[]>;
}

/** LOCAL FIXTURE transfer store (in-memory, SYNTHETIC data only). Production requires a live store (OPS-04). */
export class MemoryTransferStore implements TransferStore {
  readonly kind = "local_fixture" as const;
  private readonly journeys = new Map<string, TransferJourney>();
  private readonly byTransfer = new Map<string, string>();

  async get(handoffId: string): Promise<TransferJourney | null> {
    const j = this.journeys.get(handoffId);
    return j ? structuredClone(j) : null;
  }
  async findByTransferId(transferId: string): Promise<TransferJourney | null> {
    const h = this.byTransfer.get(transferId);
    return h ? this.get(h) : null;
  }
  async put(journey: TransferJourney, expectedVersion: number | null): Promise<void> {
    const existing = this.journeys.get(journey.handoffId);
    if (expectedVersion === null ? existing !== undefined : existing?.version !== expectedVersion) {
      throw new ConflictError("TRANSFER_VERSION_CONFLICT");
    }
    const copy = structuredClone(journey);
    this.journeys.set(journey.handoffId, copy);
    for (const a of copy.attempts) this.byTransfer.set(a.transferId, copy.handoffId);
  }
  async listActive(): Promise<TransferJourney[]> {
    return [...this.journeys.values()].filter((j) => j.status === "ROUTING").map((j) => structuredClone(j));
  }
  async listForCall(tenantId: string, callId: string): Promise<TransferJourney[]> {
    return [...this.journeys.values()]
      .filter((j) => j.tenantId === tenantId && j.callId === callId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((j) => structuredClone(j));
  }
}

/** TRANSFERRED only after CALLER_CONFIRMED_CONNECTED (SAFE-04); a dial or acceptance alone is never a transfer. */
export function journeyOutcome(j: Pick<TransferJourney, "status" | "connectedAt">): Outcome {
  if (j.connectedAt !== null) return "TRANSFERRED";
  if (j.status === "CALLER_DISCONNECTED") return "CALLER_DISCONNECTED";
  if (j.status === "HOLDING_FOR_OPERATIONS") return "FAILED";
  return "OUTCOME_UNKNOWN";
}

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

export interface TransferCoordinatorConfig {
  environment: Environment;
  /** Approved update template ids (content is owned by the voice module and clinical/legal approval). */
  updateTemplateIds: { STANDARD: string; SAFETY: string };
  /** Maximum time without progress before an attempt times out. Operational values; supplied by configuration. */
  attemptTimeoutMs: { STANDARD: number; SAFETY: number };
  /** STANDARD only: continuity re-attempts before holding for operations. SAFETY is never capped. */
  maxStandardContinuityAttempts: number;
  /** Engineering target from spec section 10 (2 s from validated safety event to route initiation). */
  safetyRouteTargetMs?: number;
}

export interface TransferCoordinatorDeps {
  store: TransferStore;
  telephony: TelephonyControl;
  destinations: readonly DestinationConfig[];
  clock: Clock;
  audit: AuditWriter;
  logger?: Logger;
  config: TransferCoordinatorConfig;
}

const TransferIdSchema = opaqueIdWithPrefix("xfr");
const ApplyEventInput = z.strictObject({
  transferId: TransferIdSchema,
  event: TransferEventName,
  eventId: z.string().regex(/^[A-Za-z0-9:._-]{1,128}$/).optional(),
  source: z.string().regex(/^[a-z][a-z0-9_.-]{2,63}$/),
  packageAcknowledged: z.boolean().optional(),
});
export type ApplyTransferEventInput = z.input<typeof ApplyEventInput>;

export interface ApplyTransferEventResult {
  journey: TransferJourney;
  decision: TransferDecision;
}

const MAX_ATTEMPTS_KEPT = 32;
const MAX_EVENT_IDS_KEPT = 256;

export class TransferCoordinator {
  private readonly store: TransferStore;
  private readonly telephony: TelephonyControl;
  private readonly clock: Clock;
  private readonly audit: AuditWriter;
  private readonly logger: Logger;
  private readonly config: Required<TransferCoordinatorConfig>;
  private readonly destinations = new Map<string, DestinationConfig>();
  private readonly safetyDestinationId: string;
  private readonly continuityDestinationId: string;

  constructor(deps: TransferCoordinatorDeps) {
    const violations = validateDestinations(deps.destinations);
    const c = deps.config;
    if (!TEMPLATE_ID.test(c.updateTemplateIds.STANDARD) || !TEMPLATE_ID.test(c.updateTemplateIds.SAFETY)) violations.push("UPDATE_TEMPLATE_ID_INVALID");
    for (const v of [c.attemptTimeoutMs.STANDARD, c.attemptTimeoutMs.SAFETY]) {
      if (!Number.isInteger(v) || v < 1000 || v > 3_600_000) violations.push("ATTEMPT_TIMEOUT_INVALID");
    }
    if (!Number.isInteger(c.maxStandardContinuityAttempts) || c.maxStandardContinuityAttempts < 1 || c.maxStandardContinuityAttempts > 20) {
      violations.push("CONTINUITY_ATTEMPTS_INVALID");
    }
    if (c.environment === "production" && (deps.store.kind === "local_fixture" || deps.telephony.kind === "local_fixture")) {
      violations.push("FIXTURE_ADAPTER_IN_PRODUCTION");
    }
    if (violations.length > 0) throw new ConfigurationRejectedError([...new Set(violations)]);

    this.store = deps.store;
    this.telephony = deps.telephony;
    this.clock = deps.clock;
    this.audit = deps.audit;
    this.logger = (deps.logger ?? silentLogger).child({ component: "transfer_coordinator" });
    this.config = { ...c, safetyRouteTargetMs: c.safetyRouteTargetMs ?? 2000 };
    for (const d of deps.destinations) this.destinations.set(d.destinationId, { ...d, fallbackDestinationIds: [...d.fallbackDestinationIds], languages: [...d.languages] });
    this.safetyDestinationId = deps.destinations.find((d) => d.purpose === "SAFETY_PRIORITY")?.destinationId as string;
    this.continuityDestinationId = deps.destinations.find((d) => d.purpose === "OUTAGE_CONTINUITY")?.destinationId as string;
  }

  /**
   * Starts a transfer journey from a strictly validated handoff package. The
   * destination is resolved only from trusted configuration. Idempotent per
   * handoffId (a repeated request never dials twice).
   */
  async requestTransfer(raw: unknown, opts: { validatedSafetyEventAt?: string } = {}): Promise<TransferJourney> {
    const now = this.clock.now();
    const candidate = raw && typeof raw === "object" ? { ...(raw as Record<string, unknown>) } : null;
    if (!candidate) throw new ValidationError("HANDOFF_PACKAGE_INVALID");
    const isSafety = candidate.reason === "SAFETY_PRIORITY";

    // SAFE-05: the destination is checked before anything else; a dial target is never accepted.
    const supplied = candidate.destinationId;
    const problem = this.destinationProblem(supplied);
    let corrected = false;
    if (problem !== null) {
      if (!isSafety) {
        await this.auditSafe(this.auditBase(candidate), "transfer.denied", "DENIED", problem);
        this.logger.warn("transfer.destination_rejected", { reasonCode: problem });
        throw new AccessDeniedError(problem);
      }
      // SAFE-03: a safety caller is never left without a route because of a bad target;
      // the configured safety destination is used and the supplied value is never dialled.
      candidate.destinationId = this.safetyDestinationId;
      corrected = true;
    }

    const parsed = HandoffPackage.safeParse(candidate);
    if (!parsed.success) throw new ValidationError("HANDOFF_PACKAGE_INVALID");
    const handoff = parsed.data;
    let primary = handoff.destinationId;
    if (isSafety && this.destinations.get(primary)?.purpose !== "SAFETY_PRIORITY") {
      primary = this.safetyDestinationId;
      corrected = true;
    }

    const existing = await this.store.get(handoff.handoffId);
    if (existing) {
      if (existing.tenantId !== handoff.tenantId || existing.callId !== handoff.callId) throw new AccessDeniedError("HANDOFF_ID_CONFLICT");
      if (existing.priority === "SAFETY" && isActiveJourney(existing)) await this.supersedeStandardJourneys(existing);
      return existing;
    }

    if (!isSafety) {
      // SAFE-03: the safety route supersedes standard journeys; a STANDARD request never dials while
      // a SAFETY journey of the same call is routing or connected (the caller stays on that route).
      const activeSafety = await this.activeSafetyJourney(handoff.tenantId, handoff.callId);
      if (activeSafety) {
        await this.auditJourney(activeSafety, "transfer.standard_request_superseded", "DENIED", "SAFETY_JOURNEY_ACTIVE");
        this.logger.warn("transfer.standard_request_superseded", { handoffId: activeSafety.handoffId, reasonCode: "SAFETY_JOURNEY_ACTIVE" });
        return activeSafety;
      }
    }

    let safety: SafetyRouteTiming | null = null;
    if (isSafety) {
      const at = opts.validatedSafetyEventAt ?? handoff.createdAt;
      if (!IsoDateTime.safeParse(at).success) throw new ValidationError("SAFETY_EVENT_TIME_INVALID");
      safety = { validatedSafetyEventAt: at, routeInitiatedAt: null, timeToRouteInitiationMs: null, targetMs: this.config.safetyRouteTargetMs, withinTarget: null };
    }

    const journey: TransferJourney = {
      handoffId: handoff.handoffId,
      tenantId: handoff.tenantId,
      callId: handoff.callId,
      sessionGeneration: handoff.sessionGeneration,
      reason: handoff.reason,
      priority: isSafety ? "SAFETY" : "STANDARD",
      routePlan: this.routePlan(primary),
      routeIndex: 0,
      status: "ROUTING",
      currentTransferId: null,
      attempts: [],
      attemptCount: 0,
      continuityAttempts: 0,
      vendorRefs: {},
      awaitingRetry: false,
      updatesPlayed: 0,
      connectedAt: null,
      destinationCorrected: corrected,
      safety,
      appliedEventIds: [],
      auditGaps: 0,
      persistenceGaps: 0,
      version: 0,
      createdAt: iso(now),
      updatedAt: iso(now),
    };
    if (corrected) {
      await this.auditJourney(journey, "transfer.destination_corrected", "ALLOWED", problem ?? "SAFETY_DESTINATION_ENFORCED");
      this.logger.warn("transfer.safety_destination_enforced", { handoffId: journey.handoffId, reasonCode: problem ?? "SAFETY_DESTINATION_ENFORCED" });
    }
    await this.persist(journey, true);
    await this.auditJourney(journey, "transfer.requested", "PENDING", null);
    await this.routeFrom(journey, 0, false);
    // The priority route is initiated first; only then are competing STANDARD journeys stopped.
    if (isSafety) await this.supersedeStandardJourneys(journey);
    return journey;
  }

  /** Every journey of one call (any status), oldest first. */
  async journeysForCall(tenantId: string, callId: string): Promise<TransferJourney[]> {
    return this.store.listForCall(tenantId, callId);
  }

  /** The call's SAFETY journey that is routing or connected right now, or null. */
  async activeSafetyJourney(tenantId: string, callId: string): Promise<TransferJourney | null> {
    const all = await this.store.listForCall(tenantId, callId);
    return all.filter((j) => j.priority === "SAFETY" && (j.status === "ROUTING" || j.status === "CONNECTED")).at(-1) ?? null;
  }

  /**
   * Stops every active STANDARD journey of the safety journey's call (status SUPERSEDED, audited).
   * Never throws: a failure is logged and the next safety request or sweep tries again; the
   * safety route itself is never affected.
   */
  private async supersedeStandardJourneys(safety: TransferJourney): Promise<number> {
    let superseded = 0;
    try {
      for (const j of await this.store.listForCall(safety.tenantId, safety.callId)) {
        if (j.priority !== "STANDARD" || !isActiveJourney(j)) continue;
        j.status = "SUPERSEDED";
        j.awaitingRetry = false;
        try {
          await this.persist(j);
        } catch (err) {
          this.logger.error("transfer.supersede_failed", { handoffId: j.handoffId, reasonCode: err instanceof ConflictError || err instanceof DependencyError ? err.reasonCode : "TRANSFER_SUPERSEDE_FAILED" });
          continue;
        }
        superseded++;
        await this.auditJourney(j, "transfer.superseded", "INVALIDATED", "SUPERSEDED_BY_SAFETY_ROUTE");
        this.logger.warn("transfer.superseded_by_safety", { handoffId: j.handoffId, reasonCode: "SUPERSEDED_BY_SAFETY_ROUTE" });
      }
    } catch {
      this.logger.error("transfer.supersede_failed", { handoffId: safety.handoffId, reasonCode: "TRANSFER_STORE_UNAVAILABLE" });
    }
    return superseded;
  }

  /** Applies a telephony event (idempotent on duplicates, rejects invalid/out-of-order events without corrupting state). */
  async applyEvent(raw: ApplyTransferEventInput): Promise<ApplyTransferEventResult> {
    const parsedInput = ApplyEventInput.safeParse(raw);
    if (!parsedInput.success) throw new ValidationError("TRANSFER_EVENT_INPUT_INVALID");
    const input = parsedInput.data;
    const journey = await this.store.findByTransferId(input.transferId);
    if (!journey) throw new AccessDeniedError("TRANSFER_NOT_FOUND");
    if (input.eventId !== undefined && journey.appliedEventIds.includes(input.eventId)) {
      return { journey, decision: { kind: "duplicate" } };
    }

    let attempt = journey.attempts.find((a) => a.transferId === input.transferId);
    if (!attempt) return this.reject(journey, input.event, "TRANSFER_ATTEMPT_UNKNOWN");
    // A STANDARD journey superseded by the call's safety route never resumes (no status change,
    // no failover, no dial); its late vendor events are recorded for operations only.
    if (journey.status === "SUPERSEDED") return this.reject(journey, input.event, "TRANSFER_JOURNEY_SUPERSEDED");
    if (attempt.transferId !== journey.currentTransferId) {
      // The caller leaving is call-level and applies to the active attempt; anything else on a
      // superseded attempt is stale (recorded for operations, never applied).
      const current = journey.attempts.find((a) => a.transferId === journey.currentTransferId);
      if (input.event !== "CALLER_DISCONNECTED" || !current) {
        if (input.event === "RECEIVER_ACCEPTED") this.logger.warn("transfer.late_acceptance_superseded", { transferId: input.transferId });
        return this.reject(journey, input.event, "TRANSFER_ATTEMPT_SUPERSEDED");
      }
      attempt = current;
    }

    if (
      input.event === "CALLER_DISCONNECTED" &&
      (journey.status === "ROUTING" || journey.status === "HOLDING_FOR_OPERATIONS" || journey.status === "CONNECTED") &&
      TERMINAL_TRANSFER_STATES.has(attempt.state)
    ) {
      // Between attempts (awaiting a retry or holding for operations): the journey ends because the caller left.
      journey.status = "CALLER_DISCONNECTED";
      journey.awaitingRetry = false;
      this.rememberEvent(journey, input.eventId);
      await this.persist(journey);
      await this.auditJourney(journey, "transfer.caller_disconnected", "FAILED", "CALLER_DISCONNECTED");
      return { journey, decision: { kind: "applied", next: "CALLER_DISCONNECTED" } };
    }

    const decision = transferTransition(attempt, input.event);
    if (decision.kind === "rejected") return this.reject(journey, input.event, decision.reasonCode);
    if (decision.kind === "duplicate") {
      this.rememberEvent(journey, input.eventId);
      await this.persist(journey);
      return { journey, decision };
    }

    const now = iso(this.clock.now());
    if (decision.kind === "acknowledged") {
      this.updateAttempt(journey, attempt.transferId, (a) => ({ ...a, receiverAcknowledgedPackage: true, updatedAt: now }));
      this.rememberEvent(journey, input.eventId);
      await this.persist(journey);
      await this.auditJourney(journey, "transfer.package_acknowledged", "SUCCEEDED", null);
      return { journey, decision };
    }

    const next = decision.next;
    const ack = attempt.receiverAcknowledgedPackage || (next === "RECEIVER_ACCEPTED" && input.packageAcknowledged === true);
    this.updateAttempt(journey, attempt.transferId, (a) => ({
      ...a,
      state: next,
      history: [...a.history, { state: next, at: now, source: input.source }].slice(-64),
      receiverAcknowledgedPackage: ack,
      updatedAt: now,
    }));
    this.rememberEvent(journey, input.eventId);

    if (next === "CALLER_CONFIRMED_CONNECTED") {
      journey.status = "CONNECTED";
      journey.connectedAt = now;
    } else if (next === "COMPLETED") {
      journey.status = "COMPLETED";
    } else if (next === "BRIDGE_DROPPED") {
      // SAFE-HANDOFF-01: nobody is connected any more; the journey is routing again (sweep, retries).
      journey.connectedAt = null;
      journey.status = "ROUTING";
    } else if (next === "CALLER_DISCONNECTED") {
      journey.status = "CALLER_DISCONNECTED";
      journey.awaitingRetry = false;
    }
    await this.persist(journey);
    await this.auditJourney(journey, "transfer.state_changed", this.auditOutcomeFor(next), next === "COMPLETED" && !ack ? "HANDOFF_PACKAGE_UNACKNOWLEDGED" : stateReason(next));
    this.logger.info("transfer.state_changed", { transferId: attempt.transferId, toState: next, priority: journey.priority });

    if (next === "CALLER_DISCONNECTED" && journey.priority === "SAFETY" && journey.connectedAt === null) {
      // The safety lead owns the disconnect procedure; record that follow-up is required.
      await this.auditJourney(journey, "transfer.safety_disconnect", "PENDING", "SAFETY_DISCONNECT_FOLLOW_UP_REQUIRED");
      this.logger.warn("transfer.safety_disconnect_follow_up_required", { handoffId: journey.handoffId });
    }
    if (FAILOVER_STATES.has(next)) await this.failover(journey, next);
    return { journey, decision };
  }

  /**
   * Applies TIMEOUT to attempts without progress for longer than the configured
   * attempt timeout, and retries journeys whose routes all failed to dial.
   * SAFETY journeys are never ended here; a timeout only moves them to the next route.
   */
  async sweepTimeouts(): Promise<number> {
    const now = this.clock.now().getTime();
    let applied = 0;
    for (const j of await this.store.listActive()) {
      try {
        if (j.awaitingRetry) {
          await this.routeFrom(j, j.routeIndex + 1, true);
          applied++;
          continue;
        }
        const current = j.attempts.find((a) => a.transferId === j.currentTransferId);
        if (!current || TERMINAL_TRANSFER_STATES.has(current.state)) continue;
        const last = current.history.at(-1)?.at ?? current.updatedAt;
        if (now - Date.parse(last) >= this.config.attemptTimeoutMs[j.priority]) {
          const r = await this.applyEvent({ transferId: current.transferId, event: "TIMEOUT", source: "coordinator.timeout" });
          if (r.decision.kind === "applied") applied++;
        }
      } catch (err) {
        // One journey's conflict or store error never stops the sweep for the others; it is retried next sweep.
        const reasonCode = err instanceof ConflictError || err instanceof DependencyError ? err.reasonCode : "TRANSFER_SWEEP_FAILED";
        this.logger.error("transfer.sweep_failed", { handoffId: j.handoffId, reasonCode });
      }
    }
    return applied;
  }

  async get(handoffId: string): Promise<TransferJourney | null> {
    return this.store.get(handoffId);
  }

  // -------------------------------------------------------------------------

  private destinationProblem(value: unknown): string | null {
    if (typeof value !== "string") return "DESTINATION_ID_INVALID";
    if (looksLikeDialTarget(value)) return "DESTINATION_LOOKS_LIKE_DIAL_TARGET";
    if (!DestinationId.safeParse(value).success) return "DESTINATION_ID_INVALID";
    if (!this.destinations.has(value)) return "DESTINATION_NOT_ALLOWLISTED";
    return null;
  }

  /** primary, then fallbacks transitively (breadth first, de-duplicated), then outage continuity last. */
  private routePlan(primary: string): string[] {
    const plan: string[] = [];
    const queue = [primary];
    while (queue.length > 0 && plan.length < 8) {
      const id = queue.shift() as string;
      if (plan.includes(id) || !this.destinations.has(id)) continue;
      plan.push(id);
      for (const f of this.destinations.get(id)?.fallbackDestinationIds ?? []) queue.push(f);
    }
    const withoutContinuity = plan.filter((id) => this.destinations.get(id)?.purpose !== "OUTAGE_CONTINUITY");
    return [...withoutContinuity, this.continuityDestinationId];
  }

  /** Next route index after the last one failed; null when a STANDARD journey must hold for operations. */
  private nextRouteIndex(j: TransferJourney, candidate: number): number | null {
    const last = j.routePlan.length - 1;
    if (candidate <= last) return candidate;
    if (j.priority === "SAFETY") return 0; // cycle through staffed safety routes and continuity indefinitely
    return j.continuityAttempts < this.config.maxStandardContinuityAttempts ? last : null;
  }

  private async failover(j: TransferJourney, cause: TransferState): Promise<void> {
    await this.playUpdate(j);
    await this.auditJourney(j, "transfer.fallback", "PENDING", stateReason(cause));
    await this.routeFrom(j, j.routeIndex + 1, false);
  }

  /** Tries routes starting at `from`, at most one full pass per call (no tight loops when telephony is down). */
  private async routeFrom(j: TransferJourney, from: number, isRetry: boolean): Promise<void> {
    if (isRetry) await this.playUpdate(j);
    let candidate = from;
    for (let tries = 0; tries < j.routePlan.length; tries++) {
      const idx = this.nextRouteIndex(j, candidate);
      if (idx === null) {
        j.status = "HOLDING_FOR_OPERATIONS";
        j.awaitingRetry = false;
        await this.persist(j);
        await this.auditJourney(j, "transfer.holding_for_operations", "FAILED", "STAFFED_ROUTES_EXHAUSTED");
        // The call is NOT ended: the caller stays on the continuity route and operations is alerted.
        this.logger.error("transfer.holding_for_operations", { handoffId: j.handoffId, reasonCode: "STAFFED_ROUTES_EXHAUSTED" });
        return;
      }
      const ok = await this.startAttempt(j, idx);
      if (ok) return;
      candidate = idx + 1;
      if (tries < j.routePlan.length - 1) await this.playUpdate(j);
    }
    j.awaitingRetry = true;
    await this.persist(j);
    await this.auditJourney(j, "transfer.routes_unavailable", "PENDING", "TELEPHONY_ROUTE_UNAVAILABLE");
    this.logger.error("transfer.routes_unavailable", { handoffId: j.handoffId, priority: j.priority });
  }

  private async startAttempt(j: TransferJourney, idx: number): Promise<boolean> {
    const destinationId = j.routePlan[idx] as string;
    const dest = this.destinations.get(destinationId);
    if (!dest) return false; // unreachable: plan only contains allowlisted ids
    const now = this.clock.now();
    const transferId = newId("xfr");
    const record = TransferRecord.parse({
      transferId,
      handoffId: j.handoffId,
      callId: j.callId,
      destinationId,
      priority: j.priority,
      state: "REQUESTED",
      history: [{ state: "REQUESTED", at: iso(now), source: "coordinator" }],
      receiverAcknowledgedPackage: false,
      fallbackDestinationIds: j.routePlan.slice(idx + 1).slice(0, 4),
      updatedAt: iso(now),
    });
    j.routeIndex = idx;
    j.currentTransferId = transferId;
    j.attempts = [...j.attempts, record].slice(-MAX_ATTEMPTS_KEPT);
    j.attemptCount += 1;
    j.awaitingRetry = false;
    // A new attempt in flight means the journey is routing (sweep-visible), whatever came before.
    j.status = "ROUTING";
    j.connectedAt = null;
    if (dest.purpose === "OUTAGE_CONTINUITY") j.continuityAttempts += 1;
    // Persist before dialling so a crash after the dial is reconcilable.
    await this.persist(j);

    const initiatedAt = this.clock.now();
    if (j.safety && j.safety.routeInitiatedAt === null) {
      const elapsed = Math.max(0, initiatedAt.getTime() - Date.parse(j.safety.validatedSafetyEventAt));
      j.safety = { ...j.safety, routeInitiatedAt: iso(initiatedAt), timeToRouteInitiationMs: elapsed, withinTarget: elapsed <= j.safety.targetMs };
      if (!j.safety.withinTarget) {
        this.logger.warn("transfer.safety_route_target_missed", { handoffId: j.handoffId, durationMs: elapsed });
      }
      await this.auditJourney(j, "transfer.safety_route_initiated", "PENDING", j.safety.withinTarget ? null : "SAFETY_ROUTE_TARGET_MISSED");
    }
    try {
      const r = await this.telephony.requestTransfer({ callId: j.callId, destinationId, handoffId: j.handoffId, priority: j.priority });
      if (typeof r?.transferRef === "string" && r.transferRef.length <= 128) j.vendorRefs[transferId] = r.transferRef;
      await this.persist(j);
      await this.auditJourney(j, "transfer.attempt_started", "PENDING", null);
      this.logger.info("transfer.attempt_started", { transferId, destinationId, priority: j.priority });
      return true;
    } catch {
      const at = iso(this.clock.now());
      this.updateAttempt(j, transferId, (a) => ({ ...a, state: "FAILED", history: [...a.history, { state: "FAILED", at, source: "coordinator.dial" }], updatedAt: at }));
      await this.persist(j);
      await this.auditJourney(j, "transfer.dial_failed", "FAILED", "DIAL_COMMAND_FAILED");
      this.logger.warn("transfer.dial_failed", { transferId, destinationId });
      return false;
    }
  }

  private async playUpdate(j: TransferJourney): Promise<void> {
    const templateId = this.config.updateTemplateIds[j.priority];
    try {
      await this.telephony.playApprovedUpdate({ callId: j.callId, templateId });
      j.updatesPlayed += 1;
      await this.auditJourney(j, "transfer.update_played", "SUCCEEDED", null);
    } catch {
      // Failing to play an update never stops the next route from being invoked.
      this.logger.warn("transfer.update_failed", { handoffId: j.handoffId, templateId });
      await this.auditJourney(j, "transfer.update_failed", "FAILED", "UPDATE_PLAYBACK_FAILED");
    }
  }

  private updateAttempt(j: TransferJourney, transferId: string, fn: (a: TransferRecord) => TransferRecord): void {
    j.attempts = j.attempts.map((a) => (a.transferId === transferId ? TransferRecord.parse(fn(a)) : a));
  }

  private rememberEvent(j: TransferJourney, eventId: string | undefined): void {
    if (eventId !== undefined) j.appliedEventIds = [...j.appliedEventIds, eventId].slice(-MAX_EVENT_IDS_KEPT);
  }

  private async reject(j: TransferJourney, event: TransferEventName, reasonCode: string): Promise<ApplyTransferEventResult> {
    this.logger.warn("transfer.event_rejected", { handoffId: j.handoffId, eventCode: event, reasonCode });
    await this.auditJourney(j, "transfer.event_rejected", "DENIED", reasonCode);
    return { journey: j, decision: { kind: "rejected", reasonCode } };
  }

  /**
   * Persists with a conditional write. A SAFETY journey keeps routing even if
   * the store is unavailable (the gap is counted and logged); a STANDARD
   * journey fails closed so the independent Studio route takes over.
   */
  private async persist(j: TransferJourney, create = false): Promise<void> {
    const expected = create ? null : j.version;
    const next = { ...j, version: j.version + 1, updatedAt: iso(this.clock.now()) };
    try {
      await this.store.put(next, expected);
      j.version = next.version;
      j.updatedAt = next.updatedAt;
    } catch (err) {
      if (j.priority === "SAFETY" && !(err instanceof ConflictError)) {
        j.persistenceGaps += 1;
        this.logger.error("transfer.persistence_unavailable", { handoffId: j.handoffId, priority: j.priority });
        return;
      }
      if (err instanceof ConflictError) throw err;
      throw new DependencyError("TRANSFER_STORE_UNAVAILABLE", "UNKNOWN");
    }
  }

  private auditOutcomeFor(state: TransferState): AuditOutcome {
    if (state === "CALLER_CONFIRMED_CONNECTED" || state === "COMPLETED") return "SUCCEEDED";
    if (TERMINAL_TRANSFER_STATES.has(state)) return "FAILED";
    return "PENDING";
  }

  private auditBase(c: Record<string, unknown>): { tenantId: string | null; callId: string | null; correlationId: string; sessionGeneration: number | null } {
    const opaque = /^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$/;
    const s = (v: unknown) => (typeof v === "string" && opaque.test(v) ? v : null);
    return {
      tenantId: s(c.tenantId),
      callId: s(c.callId),
      correlationId: s(c.handoffId) ?? newId("cor"),
      sessionGeneration: typeof c.sessionGeneration === "number" && Number.isInteger(c.sessionGeneration) ? c.sessionGeneration : null,
    };
  }

  private async auditJourney(j: TransferJourney, action: string, outcome: AuditOutcome, reasonCode: string | null): Promise<void> {
    const ok = await this.auditSafe(
      { tenantId: j.tenantId, callId: j.callId, correlationId: j.handoffId, sessionGeneration: j.sessionGeneration },
      action,
      outcome,
      reasonCode,
      [`transfer_journey:${j.handoffId}`, ...(j.currentTransferId ? [`transfer:${j.currentTransferId}`] : [])],
    );
    if (!ok) j.auditGaps += 1;
  }

  /**
   * Transfers are the safe route, so audit unavailability never blocks them
   * (OPS-02); the gap is counted on the journey and logged for reconciliation.
   */
  private async auditSafe(
    base: { tenantId: string | null; callId: string | null; correlationId: string; sessionGeneration: number | null },
    action: string,
    outcome: AuditOutcome,
    reasonCode: string | null,
    evidence: string[] = [],
  ): Promise<boolean> {
    if (base.tenantId === null) return false;
    try {
      await this.audit.appendStandalone({
        occurredAt: iso(this.clock.now()),
        correlationId: base.correlationId,
        parentId: null,
        tenantId: base.tenantId,
        actorRef: null,
        subjectRef: null,
        role: null,
        sourceComponent: "telephony_control",
        callId: base.callId,
        sessionRef: null,
        sessionGeneration: base.sessionGeneration,
        turnId: null,
        versions: null,
        action,
        policyDecision: null,
        assurance: null,
        evidencePointers: evidence,
        beforeHash: null,
        afterHash: null,
        idempotencyKey: null,
        outcome,
        reasonCode,
        dataClass: "BUSINESS_RECORD",
      });
      return true;
    } catch {
      this.logger.error("transfer.audit_unavailable", { action, reasonCode: "AUDIT_UNAVAILABLE" });
      return false;
    }
  }
}

function stateReason(state: TransferState): string | null {
  switch (state) {
    case "TIMED_OUT":
      return "TRANSFER_TIMED_OUT";
    case "RECEIVER_UNAVAILABLE":
      return "RECEIVER_UNAVAILABLE";
    case "BRIDGE_DROPPED":
      return "BRIDGE_DROPPED";
    case "FAILED":
      return "TRANSFER_ATTEMPT_FAILED";
    case "CALLER_DISCONNECTED":
      return "CALLER_DISCONNECTED";
    default:
      return null;
  }
}
