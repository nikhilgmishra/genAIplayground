import type { Budget, KillSwitch, KillSwitchScope, StaffActor } from "../protocol/index.js";

export interface KillSwitchSnapshot {
  aiAdmission: boolean;
  writes: boolean;
  outboundNotifications: boolean;
  intents: string[];
  integrations: string[];
  modelVersions: string[];
  voiceVersions: string[];
}

/**
 * Separate kill switches (spec section 13). Engaging any switch preserves the
 * approved safety and human routes; those routes are never gated by switches.
 */
export interface KillSwitchService {
  snapshot(tenantId: string): Promise<KillSwitchSnapshot>;
  set(input: {
    tenantId: string;
    scope: KillSwitchScope;
    target: string;
    engaged: boolean;
    reason: string;
    staff: StaffActor;
    /** Added by the ops module: correlation id for the audit event (generated when absent). */
    correlationId?: string;
  }): Promise<KillSwitch>;
  list(tenantId: string): Promise<KillSwitch[]>;
}

export type AdmissionClass = "SAFETY" | "HUMAN_ROUTE" | "PROTECTED_READ" | "WRITE" | "PUBLIC" | "ANALYTICS";

export interface AdmissionDecision {
  admitted: boolean;
  /** When not admitted, the approved continuity route to use instead (never a silent drop). */
  continuity: "NONE" | "HUMAN_QUEUE" | "CALLBACK_INTAKE" | "OUTAGE_MESSAGE_THEN_HUMAN";
  reasonCode: string;
  /**
   * Added by the ops module: capacity lease for an admitted new session; release it
   * with `releaseSession` when the session ends. Null when no lease was taken.
   */
  sessionLeaseId?: string | null;
}

/**
 * Budget and capacity admission. Budget exhaustion stops new nonessential
 * automation; it never disconnects an active safety handoff (SAFE-03).
 */
export interface AdmissionController {
  admit(input: {
    tenantId: string;
    class: AdmissionClass;
    vendor: string | null;
    workflow: string | null;
    cohort: string;
    /** Added by the ops module: true when this admission starts a new AI session (capacity + AI_ADMISSION switch apply). */
    newSession?: boolean;
    /** Added by the ops module: pinned model / voice versions in use, checked against version kill switches. */
    modelVersion?: string | null;
    voiceVersion?: string | null;
  }): Promise<AdmissionDecision>;
  recordCost(input: { tenantId: string; vendor: string; workflow: string; cohort: string; usd: number; safety: boolean }): Promise<void>;
  /** Added by the ops module: releases a capacity lease returned by `admit`. Idempotent. */
  releaseSession?(leaseId: string): void;
}

/** Added by the ops module: budget tracking by environment, cohort, workflow and vendor (spec section 12). */
export interface BudgetStatus {
  budget: Budget;
  spentUsd: number;
  safetySpentUsd: number;
  nonSafetySpentUsd: number;
  /** Spend per minute over the configured recent window. */
  burnRateUsdPerMinute: number;
  /** spent + meteringDelayMinutes * burnRate: vendor metering lags, so recorded spend understates. */
  projectedUsd: number;
  /** Projected spend that consumes the nonessential allowance (non-safety spend, safety overflow and metering projection). */
  projectedNonessentialUsd: number;
  nonessentialHeadroomUsd: number;
  safetyReserveRemainingUsd: number;
  /** New nonessential automation must stop (never disconnects active safety work). */
  exhausted: boolean;
  /** Safety spend beyond the approved reserve: alert the escalation owner; never a cap. */
  safetyReserveExceeded: boolean;
}

export interface BudgetService {
  statusFor(input: { tenantId: string; environment: string; vendor: string | null; workflow: string | null; cohort: string; now: Date }): Promise<BudgetStatus[]>;
  recordSpend(input: { tenantId: string; environment: string; vendor: string; workflow: string; cohort: string; usd: number; safety: boolean; occurredAt: Date }): Promise<void>;
}
