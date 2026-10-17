import type { KillSwitch, KillSwitchScope, StaffActor } from "../protocol/index.js";

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
  set(input: { tenantId: string; scope: KillSwitchScope; target: string; engaged: boolean; reason: string; staff: StaffActor }): Promise<KillSwitch>;
  list(tenantId: string): Promise<KillSwitch[]>;
}

export type AdmissionClass = "SAFETY" | "HUMAN_ROUTE" | "PROTECTED_READ" | "WRITE" | "PUBLIC" | "ANALYTICS";

export interface AdmissionDecision {
  admitted: boolean;
  /** When not admitted, the approved continuity route to use instead (never a silent drop). */
  continuity: "NONE" | "HUMAN_QUEUE" | "CALLBACK_INTAKE" | "OUTAGE_MESSAGE_THEN_HUMAN";
  reasonCode: string;
}

/**
 * Budget and capacity admission. Budget exhaustion stops new nonessential
 * automation; it never disconnects an active safety handoff (SAFE-03).
 */
export interface AdmissionController {
  admit(input: { tenantId: string; class: AdmissionClass; vendor: string | null; workflow: string | null; cohort: string }): Promise<AdmissionDecision>;
  recordCost(input: { tenantId: string; vendor: string; workflow: string; cohort: string; usd: number; safety: boolean }): Promise<void>;
}
