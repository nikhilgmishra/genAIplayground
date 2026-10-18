/**
 * Versioned resolution contracts (spec section 4). Every workflow the voice
 * agent may handle has exactly one contract; unsupported workflows end in
 * honest intake or a human route. All contracts are DRAFT engineering defaults.
 */
import type { ResolutionContract } from "../../protocol/index.js";
import { APPOINTMENT_CREATE, APPOINTMENT_LOOKUP, APPOINTMENT_RESCHEDULE } from "./appointments.js";
import { BILLING_REVIEW, CLAIM_STATUS, INVOICE_EXPLANATION, PAYMENT_PAGE } from "./billing.js";
import { CASE_FOLLOW_UP, COMPLAINT_INTAKE, HUMAN_REQUEST, SAFETY_ROUTE, SUPPORT_INTAKE } from "./intake.js";
import { CREDENTIALING_DOCUMENT_STATUS, PARTNER_INTAKE, PROVIDER_ONBOARDING_STATUS, REMITTANCE_LOOKUP } from "./provider.js";
import { LOGIN_GUIDANCE, PUBLIC_FAQ, VERIFICATION } from "./public.js";

export { ALL_AUDIENCES, DRAFT_NOTICE, defineContract } from "./define.js";
export {
  APPOINTMENT_CREATE,
  APPOINTMENT_LOOKUP,
  APPOINTMENT_RESCHEDULE,
  BILLING_REVIEW,
  CASE_FOLLOW_UP,
  CLAIM_STATUS,
  COMPLAINT_INTAKE,
  CREDENTIALING_DOCUMENT_STATUS,
  HUMAN_REQUEST,
  INVOICE_EXPLANATION,
  LOGIN_GUIDANCE,
  PARTNER_INTAKE,
  PAYMENT_PAGE,
  PROVIDER_ONBOARDING_STATUS,
  PUBLIC_FAQ,
  REMITTANCE_LOOKUP,
  SAFETY_ROUTE,
  SUPPORT_INTAKE,
  VERIFICATION,
};

/** Every contract, in catalogue order. Contract ids are unique (checked at load). */
export const RESOLUTION_CONTRACTS: readonly ResolutionContract[] = Object.freeze([
  PUBLIC_FAQ,
  LOGIN_GUIDANCE,
  VERIFICATION,
  APPOINTMENT_LOOKUP,
  APPOINTMENT_RESCHEDULE,
  APPOINTMENT_CREATE,
  INVOICE_EXPLANATION,
  BILLING_REVIEW,
  PAYMENT_PAGE,
  CLAIM_STATUS,
  PROVIDER_ONBOARDING_STATUS,
  CREDENTIALING_DOCUMENT_STATUS,
  REMITTANCE_LOOKUP,
  PARTNER_INTAKE,
  COMPLAINT_INTAKE,
  SUPPORT_INTAKE,
  CASE_FOLLOW_UP,
  HUMAN_REQUEST,
  SAFETY_ROUTE,
]);

const BY_ID = new Map<string, ResolutionContract>();
for (const c of RESOLUTION_CONTRACTS) {
  if (BY_ID.has(c.contractId)) throw new Error("CONTRACT_ID_DUPLICATE");
  BY_ID.set(c.contractId, c);
}

export function contractById(contractId: string): ResolutionContract | null {
  return BY_ID.get(contractId) ?? null;
}

export const CONTRACT_IDS = Object.freeze(RESOLUTION_CONTRACTS.map((c) => c.contractId));
