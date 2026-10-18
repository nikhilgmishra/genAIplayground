/** Appointment lookup, reschedule and create contracts. DRAFT engineering defaults. */
import { defineContract } from "./define.js";

const APPOINTMENT_PROHIBITED = [
  "Clinical suitability of a provider, appointment type or time (no clinical matching)",
  "Appointment facts of any person other than the authorized subject",
  "Treatment or attendance status to a partner, employer or unrelated caller",
];

export const APPOINTMENT_LOOKUP = defineContract({
  contractId: "appointment_lookup@1",
  intent: "appointment_lookup",
  title: "Own or authorized appointment facts and open administrative times",
  eligibleAudiences: ["client", "personal_representative", "provider"],
  requiredAssurance: "A2",
  permittedFields: ["appointmentId", "modality", "providerDisplayName", "startsAt", "status", "timeZone"],
  sourceSystem: "scheduling",
  allowedActions: ["appointment.read"],
  successEvidence: ["Authoritative appointment records or open slots returned from the scheduling system for the authorized subject"],
  resolvedOutcome: "INFORMATION_PROVIDED",
  callerConfirmationRequired: false,
  escalationOwner: "q_scheduling_support",
  serviceDeadline: null,
  afterHoursBehavior: "SELF_SERVICE_AVAILABLE",
  prohibitedAssertions: [...APPOINTMENT_PROHIBITED],
  humanBoundary: [
    "Representative access to a minor's records (minor confidentiality review)",
    "Expired, ambiguous or unsupported representative authority",
  ],
  status: "DRAFT",
  approvedBy: null,
});

const CHANGE_FIELDS = ["actionDigest", "actionId", "appointmentId", "expiresAt", "receiptId", "slotId", "startsAt", "status", "timeZone"];

const CHANGE_PROHIBITED = [
  "Announcing that a change is made before a COMMITTED commit receipt exists",
  "Retrying after an UNKNOWN outcome before reconciliation by the provider idempotency key",
  "Fees, waivers or policy exceptions not present in the authoritative record",
  ...APPOINTMENT_PROHIBITED,
];

export const APPOINTMENT_RESCHEDULE = defineContract({
  contractId: "appointment_reschedule@1",
  intent: "appointment_reschedule",
  title: "Approved reschedule of the client's own appointment",
  eligibleAudiences: ["client"],
  requiredAssurance: "A2",
  permittedFields: [...CHANGE_FIELDS],
  sourceSystem: "scheduling",
  allowedActions: ["appointment.read", "appointment.prepare_change", "appointment.commit_change", "appointment.reschedule"],
  successEvidence: [
    "COMMITTED CommitReceipt for kind appointment.reschedule with the scheduling provider reference and after-version",
    "Trusted confirmation (telephony_control or portal) bound to the prepared-action digest and session generation",
  ],
  resolvedOutcome: "RESOLVED",
  callerConfirmationRequired: true,
  escalationOwner: "q_scheduling_support",
  serviceDeadline: null,
  afterHoursBehavior: "SELF_SERVICE_AVAILABLE",
  prohibitedAssertions: CHANGE_PROHIBITED,
  humanBoundary: [
    "Slot conflicts that the offered options cannot resolve",
    "UNKNOWN commit outcome that reconciliation cannot resolve",
    "Minimum assurance A2 vs A3 for commits is pending the identity risk assessment (PRQ-030)",
  ],
  status: "DRAFT",
  approvedBy: null,
});

export const APPOINTMENT_CREATE = defineContract({
  contractId: "appointment_create@1",
  intent: "appointment_create",
  title: "Approved booking of a new appointment for the client",
  eligibleAudiences: ["client"],
  requiredAssurance: "A2",
  permittedFields: [...CHANGE_FIELDS],
  sourceSystem: "scheduling",
  allowedActions: ["appointment.read", "appointment.prepare_change", "appointment.commit_change", "appointment.create"],
  successEvidence: [
    "COMMITTED CommitReceipt for kind appointment.create with the scheduling provider reference",
    "Trusted confirmation (telephony_control or portal) bound to the prepared-action digest and session generation",
  ],
  resolvedOutcome: "RESOLVED",
  callerConfirmationRequired: true,
  escalationOwner: "q_scheduling_support",
  serviceDeadline: null,
  afterHoursBehavior: "SELF_SERVICE_AVAILABLE",
  prohibitedAssertions: CHANGE_PROHIBITED,
  humanBoundary: [
    "New-client intake, provider assignment or clinical triage (never automated)",
    "UNKNOWN commit outcome that reconciliation cannot resolve",
  ],
  status: "DRAFT",
  approvedBy: null,
});
