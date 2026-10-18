/**
 * Vendor and business-system ports. Every implementation declares `kind`:
 * "local_fixture" adapters serve SYNTHETIC records only and are rejected by
 * the production configuration guard (OPS-04). "live" adapters may only be
 * enabled with evidenced prerequisites and approvals.
 *
 * Domain records returned here are authoritative-system fields. Caller-facing
 * speech is never built from free-text fields of these records.
 */
import type { DestinationId, RelationshipFact, Role } from "../protocol/index.js";

export type AdapterKind = "local_fixture" | "live";

export interface AdapterHealth {
  healthy: boolean;
  reasonCode: string | null;
}

export interface Adapter {
  readonly kind: AdapterKind;
  /** Integration id used by kill switches, budgets and circuit breakers, e.g. "salesforce", "scheduling". */
  readonly integrationId: string;
  health(): Promise<AdapterHealth>;
}

// ---------- Identity directory (restricted verification service) ----------
export interface AccountCandidate {
  accountId: string;
  actorId: string;
  roles: Role[];
}
export interface RegisteredChannel {
  channelRef: string;
  kind: "sms" | "voice" | "email" | "portal_push";
  verified: boolean;
  /** Recent number/channel changes are a SIM-swap risk signal. */
  changedAt: string | null;
}
export interface IdentityDirectory extends Adapter {
  /** Restricted: callers never learn whether 0, 1 or many candidates matched. */
  findCandidates(locator: { fullName: string; dateOfBirth: string } | { portalUsernameHint: string }): Promise<AccountCandidate[]>;
  registeredChannels(accountId: string): Promise<RegisteredChannel[]>;
  accountState(accountId: string): Promise<"ACTIVE" | "LOCKED" | "RECOVERY_IN_PROGRESS" | "CLOSED">;
  /** Maps an IdP subject (OIDC `sub`) to the platform actor id. */
  actorForIdpSubject(issuer: string, sub: string): Promise<string | null>;
  /** Subject the actor acts as when acting for themselves (client) or their own provider record. */
  selfSubjectId(actorId: string, role: Role): Promise<string | null>;
  organizationFor(actorId: string, role: Role): Promise<string | null>;
}

export interface OidcClaims {
  issuer: string;
  sub: string;
  audience: string;
  nonce: string;
  authTime: number;
  amr: string[];
  acr: string | null;
}
export interface OidcVerifier extends Adapter {
  /** Verifies signature (JWKS), issuer, audience, expiry and nonce. Throws on failure. */
  verifyIdToken(idToken: string, expected: { nonce: string; maxAuthAgeSeconds: number }): Promise<OidcClaims>;
}

export interface RelationshipDirectory extends Adapter {
  /** Authoritative enrollment, delegation, partner contract and legal-authority records. */
  relationshipsFor(actorId: string, role: Role): Promise<RelationshipFact[]>;
}

// ---------- Notifications ----------
export interface NotificationSender extends Adapter {
  /** Neutral content only, directing to a secure channel; template ids are approved. */
  send(input: { channelRef: string; templateId: string; slots: Record<string, string>; idempotencyKey: string }): Promise<{ messageId: string }>;
}

// ---------- Scheduling ----------
export interface Appointment {
  appointmentId: string;
  subjectId: string;
  providerDisplayName: string;
  startsAt: string;
  timeZone: string;
  modality: "video" | "in_person" | "phone";
  status: "SCHEDULED" | "CANCELLED" | "COMPLETED";
  version: string;
}
export interface Slot {
  slotId: string;
  startsAt: string;
  timeZone: string;
  modality: Appointment["modality"];
  providerDisplayName: string;
}
export interface SchedulingSystem extends Adapter {
  listAppointments(subjectId: string): Promise<Appointment[]>;
  getAppointment(appointmentId: string): Promise<Appointment | null>;
  /** Administrative availability only; no clinical suitability matching. */
  listSlots(input: { subjectId: string; appointmentId: string | null; fromDate: string; toDate: string }): Promise<Slot[]>;
  reschedule(input: { appointmentId: string; beforeVersion: string; slotId: string; idempotencyKey: string }): Promise<{ appointment: Appointment; reference: string }>;
  create(input: { subjectId: string; slotId: string; idempotencyKey: string }): Promise<{ appointment: Appointment; reference: string }>;
  findByIdempotencyKey(idempotencyKey: string): Promise<{ appointment: Appointment; reference: string } | null>;
}

// ---------- Billing ----------
export interface Invoice {
  invoiceId: string;
  subjectId: string;
  issuedOn: string;
  dueOn: string;
  status: "OPEN" | "PAID" | "IN_REVIEW" | "VOID";
  lines: { lineId: string; code: "SESSION_FEE" | "LATE_CANCELLATION" | "NO_SHOW" | "ADJUSTMENT" | "PAYMENT"; serviceDate: string; amountMinor: number }[];
  balanceMinor: number;
  currency: "USD";
  version: string;
}
export interface BillingSystem extends Adapter {
  listInvoices(subjectId: string): Promise<Invoice[]>;
  getInvoice(invoiceId: string): Promise<Invoice | null>;
  /** Approved hosted payment page path; card data is never collected by voice. */
  hostedPaymentPath(invoiceId: string): Promise<{ portalPath: string }>;
  markInReview(input: { invoiceId: string; beforeVersion: string; idempotencyKey: string }): Promise<{ invoice: Invoice; reference: string }>;
  findReviewByIdempotencyKey(idempotencyKey: string): Promise<{ invoice: Invoice; reference: string } | null>;
}

// ---------- Claims ----------
export interface ClaimStatus {
  claimId: string;
  subjectId: string;
  serviceDate: string;
  payerDisplayName: string;
  /** Insurer-reported status only; never an eligibility or payment guarantee. */
  insurerStatus: "RECEIVED" | "IN_PROCESS" | "ADJUDICATED_PAID" | "ADJUDICATED_DENIED" | "NEEDS_INFORMATION";
  statusAsOf: string;
}
export interface ClaimsSystem extends Adapter {
  listClaims(subjectId: string): Promise<ClaimStatus[]>;
  getClaim(claimId: string): Promise<ClaimStatus | null>;
}

// ---------- Provider network ----------
export interface OnboardingStatus {
  providerId: string;
  stage: "APPLICATION_RECEIVED" | "DOCUMENTS_PENDING" | "CREDENTIALING_IN_REVIEW" | "CONTRACTING" | "ACTIVE" | "ON_HOLD";
  missingDocumentTypes: ("LICENSE" | "MALPRACTICE_INSURANCE" | "W9" | "DEA" | "BOARD_CERTIFICATION")[];
  asOf: string;
  /**
   * Added (additive, optional): the practice ORGANIZATION the provider network records
   * this onboarding under (authoritative provider -> practice mapping). null / absent =
   * no practice (independent provider, or the system does not say): a practice-path
   * request then has no organization to match and policy denies it (fail closed).
   * Never taken from caller input.
   */
  organizationId?: string | null;
}
export interface Remittance {
  remittanceId: string;
  practiceId: string;
  periodStart: string;
  periodEnd: string;
  totalMinor: number;
  status: "SCHEDULED" | "SENT" | "RETURNED";
  paidOn: string | null;
}
export interface ProviderSystem extends Adapter {
  getOnboardingStatus(providerId: string): Promise<OnboardingStatus | null>;
  listRemittances(input: { practiceId: string; fromDate: string; toDate: string }): Promise<Remittance[]>;
}

// ---------- Support records (Salesforce Service Cloud) ----------
export interface CaseFields {
  subjectRef: string | null;
  audience: Role | null;
  issueCategory: string;
  disposition: string;
  ownerQueue: string;
  priority: string;
  summary: string;
  attempted: string[];
  commitReceiptIds: string[];
  sourceCallIds: string[];
  language: string;
  consentStatus: string;
  nextStep: string | null;
  deadline: string | null;
  versions: string;
  restricted: boolean;
  supportReference: string;
}
export interface SupportRecordSystem extends Adapter {
  /** Upsert by external id (Salesforce REST upsert); repeated calls never duplicate. */
  upsertInteraction(externalId: string, fields: { callId: string; language: string; consentStatus: string; startedAt: string }): Promise<{ recordId: string; created: boolean }>;
  upsertCase(externalId: string, interactionExternalId: string, fields: CaseFields): Promise<{ caseId: string; created: boolean }>;
  getCaseByExternalId(externalId: string): Promise<{ caseId: string; status: string; ownerQueue: string } | null>;
}

// ---------- Telephony (Talkdesk) ----------
export interface TelephonyControl extends Adapter {
  /** Destination ids are resolved from trusted configuration only (SAFE-05). */
  requestTransfer(input: { callId: string; destinationId: DestinationId; handoffId: string; priority: "SAFETY" | "STANDARD" }): Promise<{ transferRef: string }>;
  playApprovedUpdate(input: { callId: string; templateId: string }): Promise<void>;
}
