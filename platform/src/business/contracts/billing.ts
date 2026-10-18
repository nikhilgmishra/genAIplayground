/** Invoice explanation, billing review, hosted payment page and claim status contracts. DRAFT engineering defaults. */
import { defineContract } from "./define.js";

const NO_FINANCIAL_PROMISES = [
  "Insurance coverage or eligibility decisions",
  "Fee waivers, credits or adjustments",
  "Promising or implying a refund",
];

export const INVOICE_EXPLANATION = defineContract({
  contractId: "invoice_explanation@1",
  intent: "invoice_explanation",
  title: "Invoice status and explanation from authoritative billing fields",
  eligibleAudiences: ["client", "personal_representative"],
  requiredAssurance: "A2",
  permittedFields: ["balanceMinor", "currency", "dueOn", "invoiceId", "issuedOn", "lines.amountMinor", "lines.code", "lines.serviceDate", "status"],
  sourceSystem: "billing",
  allowedActions: ["invoice.read"],
  successEvidence: ["Authoritative invoice fields returned (integer minor units, line codes, service dates) for the authorized subject"],
  resolvedOutcome: "INFORMATION_PROVIDED",
  callerConfirmationRequired: false,
  escalationOwner: "q_billing_specialists",
  serviceDeadline: null,
  afterHoursBehavior: "SELF_SERVICE_AVAILABLE",
  prohibitedAssertions: [...NO_FINANCIAL_PROMISES, "Amounts or charges that are not present in the authoritative invoice"],
  humanBoundary: ["Disputed liability goes to the billing review contract", "Exceptional refund requests are a human decision"],
  status: "DRAFT",
  approvedBy: null,
});

export const BILLING_REVIEW = defineContract({
  contractId: "billing_review@1",
  intent: "billing_review",
  title: "Durable billing review of a disputed charge (billing_dispute_review workflow)",
  eligibleAudiences: ["client"],
  requiredAssurance: "A2",
  permittedFields: ["actionDigest", "actionId", "expiresAt", "invoiceId", "reviewId", "status", "supportReference"],
  sourceSystem: "billing",
  allowedActions: ["invoice.read", "billing.submit_review", "billing.review.submit"],
  successEvidence: [
    "COMMITTED CommitReceipt for billing.review.submit (invoice marked IN_REVIEW in the billing system)",
    "billing_dispute_review workflow instance ACCEPTED in the same logical commit",
    "Internal support request with an SR reference created in the same logical commit",
  ],
  resolvedOutcome: "REQUEST_ACCEPTED",
  callerConfirmationRequired: true,
  escalationOwner: "q_billing_specialists",
  serviceDeadline: "P7D",
  afterHoursBehavior: "INTAKE_AND_CALLBACK",
  prohibitedAssertions: [
    ...NO_FINANCIAL_PROMISES,
    "Stating that the dispute is resolved or the charge removed",
    "Stating a review outcome before a specialist decision and an authoritative commit",
  ],
  humanBoundary: [
    "The decision on the disputed charge is a billing specialist task (billing_dispute_review WAITING_FOR_HUMAN)",
    "Applying any adjustment is a separate rechecked material change",
  ],
  status: "DRAFT",
  approvedBy: null,
});

export const PAYMENT_PAGE = defineContract({
  contractId: "payment_page@1",
  intent: "payment_page",
  title: "Direction to the approved hosted payment page (no card data by voice)",
  eligibleAudiences: ["client", "personal_representative"],
  requiredAssurance: "A2",
  permittedFields: ["balanceMinor", "dueOn", "invoiceId", "status"],
  sourceSystem: "billing",
  allowedActions: ["invoice.read"],
  successEvidence: ["Approved, identifier-free hosted payment path returned from billing configuration for an OPEN invoice"],
  resolvedOutcome: "INFORMATION_PROVIDED",
  callerConfirmationRequired: false,
  escalationOwner: "q_billing_specialists",
  serviceDeadline: null,
  afterHoursBehavior: "SELF_SERVICE_AVAILABLE",
  prohibitedAssertions: [
    "Collecting card numbers, security codes or bank details by voice, transcript or model",
    "Taking a payment during the call",
    "Inventing a payment URL, phone number or path",
  ],
  humanBoundary: [
    "Caller cannot use the hosted page: isolated PCI flow or staffed payment line",
    "The approved hosted payment path is BLOCKED pending the billing owner (PRQ-050); the local fixture path is a placeholder",
  ],
  status: "DRAFT",
  approvedBy: null,
});

export const CLAIM_STATUS = defineContract({
  contractId: "claim_status@1",
  intent: "claim_status",
  title: "Insurer-reported claim status (not an eligibility or payment guarantee)",
  eligibleAudiences: ["client"],
  requiredAssurance: "A2",
  permittedFields: ["claimId", "insurerStatus", "payerDisplayName", "serviceDate", "statusAsOf"],
  sourceSystem: "claims",
  allowedActions: ["claim.read"],
  successEvidence: ["Insurer-reported claim status with its as-of time returned for the authorized subject"],
  resolvedOutcome: "INFORMATION_PROVIDED",
  callerConfirmationRequired: false,
  escalationOwner: "q_claims_specialists",
  serviceDeadline: null,
  afterHoursBehavior: "SELF_SERVICE_AVAILABLE",
  prohibitedAssertions: [
    "Eligibility or payment guarantees",
    "Predicting the insurer's decision",
    "Coverage decisions",
  ],
  humanBoundary: ["Denied claims, appeals or missing information go to claim investigation"],
  status: "DRAFT",
  approvedBy: null,
});
