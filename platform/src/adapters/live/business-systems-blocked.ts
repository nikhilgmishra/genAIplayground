/**
 * LIVE business-system adapters — BLOCKED.
 *
 * No documented scheduling, billing, claims, provider-network or
 * relationship-registry API has been supplied by the business-system owners
 * (PRQ-007) or the identity owner (PRQ-005). Each stub is kind "live", reports
 * itself unhealthy and rejects every method with BLOCKED_CAPABILITY_UNVERIFIED
 * (OPS-03) without any network access. The LOCAL fixtures in ../local model
 * the behaviour the platform needs from these systems; the evidence listed
 * here decides whether a real system can provide it.
 *
 * The idempotency-key and lookup-by-key requirement is load-bearing: without
 * them an ambiguous timeout cannot be reconciled (ACT-03) and the intent stays
 * disabled (PRQ-007 next action).
 */
import type { RelationshipFact, Role } from "../../protocol/index.js";
import type {
  Appointment,
  BillingSystem,
  ClaimStatus,
  ClaimsSystem,
  Invoice,
  OnboardingStatus,
  ProviderSystem,
  RelationshipDirectory,
  Remittance,
  SchedulingSystem,
  Slot,
} from "../ports.js";
import { BlockedLiveAdapter, type RequiredEvidence } from "./blocked-base.js";

const commonEvidence = (system: string, extra: string): RequiredEvidence => ({
  capability: `${system} API for the voice-support intents`,
  evidence: `Documented API from the system owner with synthetic fixtures: method, endpoint, version, auth mechanism, request/response schema, error codes, rate limits, data classification, retention; ${extra}`,
  prerequisites: ["PRQ-007"],
  vendorQuestions: [],
  trustBoundary: null,
});

export class SchedulingLiveBlocked extends BlockedLiveAdapter implements SchedulingSystem {
  readonly integrationId = "scheduling";
  readonly prerequisites: readonly string[] = ["PRQ-007", "PRQ-033", "PRQ-024"];
  readonly requiredEvidence = [
    commonEvidence(
      "Scheduling",
      "optimistic-concurrency version on appointments, slot-conflict semantics, idempotency keys on create/reschedule and an authoritative lookup by idempotency key; administrative availability only (no clinical matching)",
    ),
  ];
  async listAppointments(_subjectId: string): Promise<Appointment[]> {
    return this.blocked("listAppointments");
  }
  async getAppointment(_appointmentId: string): Promise<Appointment | null> {
    return this.blocked("getAppointment");
  }
  async listSlots(_input: { subjectId: string; appointmentId: string | null; fromDate: string; toDate: string }): Promise<Slot[]> {
    return this.blocked("listSlots");
  }
  async reschedule(_input: { appointmentId: string; beforeVersion: string; slotId: string; idempotencyKey: string }): Promise<{ appointment: Appointment; reference: string }> {
    return this.blocked("reschedule");
  }
  async create(_input: { subjectId: string; slotId: string; idempotencyKey: string }): Promise<{ appointment: Appointment; reference: string }> {
    return this.blocked("create");
  }
  async findByIdempotencyKey(_idempotencyKey: string): Promise<{ appointment: Appointment; reference: string } | null> {
    return this.blocked("findByIdempotencyKey");
  }
}

export class BillingLiveBlocked extends BlockedLiveAdapter implements BillingSystem {
  readonly integrationId = "billing";
  readonly prerequisites: readonly string[] = ["PRQ-007", "PRQ-050", "PRQ-033", "PRQ-024"];
  readonly requiredEvidence = [
    commonEvidence("Billing", "authoritative invoice line codes and balances, review-state transition with version check, idempotency keys and lookup by key"),
    {
      capability: "Approved hosted payment page",
      evidence: "Billing owner confirms the hosted payment page or isolated PCI flow and the portal path the voice flow may reference; card data never enters speech, transcripts or models",
      prerequisites: ["PRQ-050"],
      vendorQuestions: [],
      trustBoundary: null,
    },
  ];
  async listInvoices(_subjectId: string): Promise<Invoice[]> {
    return this.blocked("listInvoices");
  }
  async getInvoice(_invoiceId: string): Promise<Invoice | null> {
    return this.blocked("getInvoice");
  }
  async hostedPaymentPath(_invoiceId: string): Promise<{ portalPath: string }> {
    return this.blocked("hostedPaymentPath");
  }
  async markInReview(_input: { invoiceId: string; beforeVersion: string; idempotencyKey: string }): Promise<{ invoice: Invoice; reference: string }> {
    return this.blocked("markInReview");
  }
  async findReviewByIdempotencyKey(_idempotencyKey: string): Promise<{ invoice: Invoice; reference: string } | null> {
    return this.blocked("findReviewByIdempotencyKey");
  }
}

export class ClaimsLiveBlocked extends BlockedLiveAdapter implements ClaimsSystem {
  readonly integrationId = "claims";
  readonly prerequisites: readonly string[] = ["PRQ-007", "PRQ-033", "PRQ-024"];
  readonly requiredEvidence = [commonEvidence("Claims", "insurer-reported status values with as-of timestamps, distinguishable from eligibility or payment guarantees")];
  async listClaims(_subjectId: string): Promise<ClaimStatus[]> {
    return this.blocked("listClaims");
  }
  async getClaim(_claimId: string): Promise<ClaimStatus | null> {
    return this.blocked("getClaim");
  }
}

export class ProviderSystemLiveBlocked extends BlockedLiveAdapter implements ProviderSystem {
  readonly integrationId = "provider-system";
  readonly prerequisites: readonly string[] = ["PRQ-007", "PRQ-033", "PRQ-024"];
  readonly requiredEvidence = [commonEvidence("Provider network", "onboarding stage and missing-document types, remittances scoped by practice and period")];
  async getOnboardingStatus(_providerId: string): Promise<OnboardingStatus | null> {
    return this.blocked("getOnboardingStatus");
  }
  async listRemittances(_input: { practiceId: string; fromDate: string; toDate: string }): Promise<Remittance[]> {
    return this.blocked("listRemittances");
  }
}

export class RelationshipDirectoryLiveBlocked extends BlockedLiveAdapter implements RelationshipDirectory {
  readonly integrationId = "relationship-directory";
  readonly prerequisites: readonly string[] = ["PRQ-005", "PRQ-007", "PRQ-027", "PRQ-024"];
  readonly requiredEvidence: readonly RequiredEvidence[] = [
    {
      capability: "Authoritative enrollment, delegation, partner-contract and legal-authority registries",
      evidence:
        "Systems of record and documented APIs for practice delegation, partner affiliation/contract purpose, legal representative and parental authority (validity windows, revocation, constraint codes such as minor confidentiality and custody disputes)",
      prerequisites: ["PRQ-005", "PRQ-007"],
      vendorQuestions: ["VQ-IDP-02", "VQ-IDP-05"],
      trustBoundary: null,
    },
    {
      capability: "Minor and representative access rules",
      evidence: "Privacy counsel determination for minors and personal representatives",
      prerequisites: ["PRQ-027"],
      vendorQuestions: ["VQ-LEG-03"],
      trustBoundary: null,
    },
  ];
  async relationshipsFor(_actorId: string, _role: Role): Promise<RelationshipFact[]> {
    return this.blocked("relationshipsFor");
  }
}
