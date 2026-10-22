/**
 * Canonical domain contracts (WP-23; follow-on prompt section 6 "Business systems", section 19; FO-19-21,
 * FO-06-72, FO-06-73, FO-01-30, FO-06-76).
 *
 * One model per business capability, independent of any tenant's API: a tenant connects its own system through a
 * ConnectorProfile whose bounded-DSL mappings produce these fields (platform/src/connectors). Every record read
 * from a system of record carries a `source` reference that only a connector read can produce (the profile, its
 * configuration digest, the mapping digest, the response digest and the read time): a fact without it (a summary,
 * a memory, a program membership) can never be presented as an authoritative referral, authorization, claim or
 * eligibility status (FO-01-30, DATA-04).
 *
 * Authority (FO-06-76): the contracts carry only what the system of record states. There is no coverage decision,
 * fee waiver, refund, payout authorization, claim decision or clinical suitability field anywhere; a payer's
 * eligibility response is a statement with its time, not a guarantee.
 */
import { z } from "zod";
import { IsoDateTime, OpaqueId, Sha256Hex } from "../protocol/common.js";

export const DomainSystem = z.enum(["scheduling", "billing", "claims", "provider", "referrals"]);
export type DomainSystem = z.infer<typeof DomainSystem>;

/** Provenance of a record read from a system of record through an admitted connector profile. */
export const SourceRef = z.strictObject({
  kind: z.literal("CONNECTOR_READ"),
  system: DomainSystem,
  connectorProfileId: z.string().regex(/^cnp_[A-Za-z0-9_-]{16,64}$/),
  profileConfigDigest: Sha256Hex,
  mappingDigest: Sha256Hex,
  operationId: z.string().regex(/^[a-z][a-z0-9_.]{2,63}$/),
  responseDigest: Sha256Hex,
  readAt: IsoDateTime,
});
export type SourceRef = z.infer<typeof SourceRef>;

/** Wall-clock date (YYYY-MM-DD) of a business record. */
const DateOnly = z.iso.date();
/** Version token of a record at its system of record (opaque, compared for equality only). */
const Version = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/);
const DisplayName = z.string().min(1).max(120);

// ------------------------------------------------------------------ scheduling

export const Modality = z.enum(["video", "in_person", "phone"]);
export const AppointmentStatus = z.enum(["SCHEDULED", "CANCELLED", "COMPLETED"]);

export const CanonicalAppointment = z.strictObject({
  appointmentId: OpaqueId,
  subjectId: OpaqueId,
  providerRef: OpaqueId,
  providerDisplayName: DisplayName,
  slotId: OpaqueId.nullable(),
  startsAt: IsoDateTime,
  timeZone: z.string().min(1).max(64),
  modality: Modality,
  status: AppointmentStatus,
  version: Version,
  source: SourceRef,
});
export type CanonicalAppointment = z.infer<typeof CanonicalAppointment>;

/** An open slot (administrative availability only; never a clinical suitability match). */
export const SlotOption = z.strictObject({
  slotId: OpaqueId,
  providerRef: OpaqueId,
  providerDisplayName: DisplayName,
  startsAt: IsoDateTime,
  timeZone: z.string().min(1).max(64),
  modality: Modality,
  state: z.enum(["OPEN", "BOOKED", "BLOCKED"]),
  version: Version,
  source: SourceRef,
});
export type SlotOption = z.infer<typeof SlotOption>;

// ------------------------------------------------------------------ billing and claims status

export const CanonicalInvoice = z.strictObject({
  invoiceId: OpaqueId,
  subjectId: OpaqueId,
  issuedOn: DateOnly,
  dueOn: DateOnly,
  status: z.enum(["OPEN", "PAID", "IN_REVIEW", "VOID"]),
  balanceMinor: z.number().int(),
  currency: z.literal("USD"),
  version: Version,
  lines: z.array(z.strictObject({ lineId: OpaqueId, code: z.enum(["SESSION_FEE", "LATE_CANCELLATION", "NO_SHOW", "ADJUSTMENT", "PAYMENT"]), serviceDate: DateOnly, amountMinor: z.number().int() })).max(200),
  source: SourceRef,
});
export type CanonicalInvoice = z.infer<typeof CanonicalInvoice>;

/** A payment the billing system received (it says "received", never "settled" beyond what the system states). */
export const CanonicalPayment = z.strictObject({
  paymentId: OpaqueId,
  invoiceId: OpaqueId,
  amountMinor: z.number().int().min(1),
  receivedAt: IsoDateTime,
  method: z.enum(["CARD", "ACH", "CHECK", "PORTAL"]),
  source: SourceRef,
});
export type CanonicalPayment = z.infer<typeof CanonicalPayment>;

/** Insurer-reported claim status only: never an eligibility or payment guarantee. */
export const CanonicalClaimStatus = z.strictObject({
  claimId: OpaqueId,
  subjectId: OpaqueId,
  serviceDate: DateOnly,
  payerDisplayName: DisplayName,
  insurerStatus: z.enum(["RECEIVED", "IN_PROCESS", "ADJUDICATED_PAID", "ADJUDICATED_DENIED", "NEEDS_INFORMATION"]),
  statusAsOf: IsoDateTime,
  source: SourceRef,
});
export type CanonicalClaimStatus = z.infer<typeof CanonicalClaimStatus>;

// ------------------------------------------------------------------ provider network

export const DocumentType = z.enum(["LICENSE", "MALPRACTICE_INSURANCE", "W9", "DEA", "BOARD_CERTIFICATION"]);

export const CanonicalOnboardingStatus = z.strictObject({
  providerId: OpaqueId,
  stage: z.enum(["APPLICATION_RECEIVED", "DOCUMENTS_PENDING", "CREDENTIALING_IN_REVIEW", "CONTRACTING", "ACTIVE", "ON_HOLD"]),
  asOf: IsoDateTime,
  organizationId: OpaqueId.nullable(),
  documents: z.array(z.strictObject({ documentType: DocumentType, status: z.enum(["RECEIVED", "MISSING", "EXPIRED", "IN_REVIEW", "ACCEPTED"]), updatedAt: IsoDateTime })).max(20),
  /** Documents the system reports as missing or expired (derived from `documents`, never asserted). */
  missingDocumentTypes: z.array(DocumentType).max(10),
  source: SourceRef,
});
export type CanonicalOnboardingStatus = z.infer<typeof CanonicalOnboardingStatus>;

/** A remittance the payer side scheduled, sent or had returned: never a payout authorization. */
export const CanonicalRemittance = z.strictObject({
  remittanceId: OpaqueId,
  practiceId: OpaqueId,
  periodStart: DateOnly,
  periodEnd: DateOnly,
  totalMinor: z.number().int(),
  status: z.enum(["SCHEDULED", "SENT", "RETURNED"]),
  paidOn: DateOnly.nullable(),
  source: SourceRef,
});
export type CanonicalRemittance = z.infer<typeof CanonicalRemittance>;

// ------------------------------------------------------------------ referrals, authorizations, eligibility

/**
 * Referral status as the referral system of record states it (FO-06-73). Program membership, enrollment or a
 * remembered conversation is NOT a referral status: this record exists only with a connector `source`.
 */
export const ReferralStatus = z.strictObject({
  referralId: OpaqueId,
  subjectId: OpaqueId,
  specialtyCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,40}$/),
  status: z.enum(["RECEIVED", "IN_REVIEW", "ACCEPTED", "DECLINED", "SCHEDULED", "CLOSED"]),
  statusAsOf: IsoDateTime,
  receivedOn: DateOnly,
  referringOrganizationId: OpaqueId.nullable(),
  source: SourceRef,
});
export type ReferralStatus = z.infer<typeof ReferralStatus>;

/** Payer-reported authorization status (not a coverage decision). */
export const AuthorizationStatus = z.strictObject({
  authorizationId: OpaqueId,
  subjectId: OpaqueId,
  payerDisplayName: DisplayName,
  serviceCode: z.string().regex(/^[A-Z0-9][A-Z0-9_]{1,20}$/),
  status: z.enum(["PENDING", "APPROVED", "DENIED", "EXPIRED"]),
  unitsApproved: z.number().int().min(0).nullable(),
  unitsUsed: z.number().int().min(0).nullable(),
  validFrom: DateOnly.nullable(),
  validTo: DateOnly.nullable(),
  statusAsOf: IsoDateTime,
  source: SourceRef,
});
export type AuthorizationStatus = z.infer<typeof AuthorizationStatus>;

/** The payer's last eligibility response and its time: a statement, never a coverage guarantee. */
export const EligibilityStatus = z.strictObject({
  subjectId: OpaqueId,
  payerDisplayName: DisplayName,
  coverageStatus: z.enum(["ACTIVE", "INACTIVE", "NOT_FOUND_AT_PAYER"]),
  verifiedAt: IsoDateTime,
  source: SourceRef,
});
export type EligibilityStatus = z.infer<typeof EligibilityStatus>;

// ------------------------------------------------------------------ read outcomes

/**
 * The outcome of a domain read. UNAVAILABLE is honest unavailability: no value, the classified reason, and the
 * required next step (offer a person or a callback). A failed dependency never reads as an empty list.
 */
export type DomainRead<T> =
  | { readonly status: "AVAILABLE"; readonly value: T }
  | { readonly status: "NOT_FOUND" }
  | {
      readonly status: "UNAVAILABLE";
      readonly reasonCode: string;
      /** NOT_STARTED: nothing reached the system; FAILED: it answered with a failure or did not answer in time. */
      readonly outcome: "NOT_STARTED" | "FAILED";
      readonly nextStep: "OFFER_HUMAN_OR_CALLBACK";
    };

// ------------------------------------------------------------------ actions and authority

/**
 * Who authorizes a domain change. A provider's approval authorizes changes to that provider's own schedule; it is
 * never a client's consent (follow-on prompt section 1, lesson 3): a client-side change needs that client's own
 * confirmation on a trusted channel.
 */
export const DomainAuthority = z.enum(["CLIENT_CONFIRMED", "PROVIDER_APPROVED"]);
export type DomainAuthority = z.infer<typeof DomainAuthority>;

/**
 * Domain action kinds on the shared action contracts. The client kinds are ledger ActionKinds today; the
 * provider-approved kinds run through the same commit port and need their ActionKind and policy actions added by
 * the action-contract owner (WP-25) before the ledger can prepare them.
 */
export const DomainActionKind = z.enum([
  "appointment.create",
  "appointment.reschedule",
  "appointment.cancel",
  "billing.review.submit",
  "provider.appointment.reschedule",
  "provider.appointment.cancel",
  "provider.availability.block",
]);
export type DomainActionKind = z.infer<typeof DomainActionKind>;

/** The authority each action kind requires (no kind accepts both). */
export const AUTHORITY_OF_KIND: Readonly<Record<DomainActionKind, DomainAuthority>> = Object.freeze({
  "appointment.create": "CLIENT_CONFIRMED",
  "appointment.reschedule": "CLIENT_CONFIRMED",
  "appointment.cancel": "CLIENT_CONFIRMED",
  "billing.review.submit": "CLIENT_CONFIRMED",
  "provider.appointment.reschedule": "PROVIDER_APPROVED",
  "provider.appointment.cancel": "PROVIDER_APPROVED",
  "provider.availability.block": "PROVIDER_APPROVED",
});

/** Fields of the canonical models the platform must never ingest from any tenant mapping (FO-06-76, DATA-01). */
export const PROHIBITED_SOURCE_FIELDS = Object.freeze(["visitReason", "diagnosisCodes", "cardLast4", "bankAccountLast4", "memberReference", "clinicalSummary"] as const);
