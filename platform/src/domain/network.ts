/**
 * Provider network (onboarding, credentialing documents, remittance) and referral / authorization / eligibility
 * status over the canonical contracts (WP-23; FO-06-72, FO-06-73, FO-01-30, FO-06-76).
 *
 * `HttpProviderNetwork` serves the ProviderSystem port of platform/src/adapters/ports.ts (structurally) and
 * provider-scoped reads: a provider sees only their own onboarding; missing documents are derived from the
 * documents the system reports MISSING or EXPIRED, never asserted. Remittances are what the payer side scheduled,
 * sent or had returned: never a payout authorization.
 *
 * `HttpReferralStatus` is the referral status port (FO-06-73): referral, payer-reported authorization and the
 * payer's last eligibility response, each with its as-of time and connector provenance. Program membership,
 * enrollment or memory never produce one of these records (FO-01-30): the canonical types require a connector
 * `source` that only a read through an admitted profile creates.
 */
import type { MappedRecord } from "../connectors/dsl/mapping.js";
import { ValidationError } from "../shared/errors.js";
import type { ActingParty } from "./authority.js";
import type { AuthorizationStatus, CanonicalOnboardingStatus, CanonicalRemittance, DomainRead, EligibilityStatus, ReferralStatus, SourceRef } from "./contracts.js";
import {
  AuthorizationStatus as AuthorizationSchema,
  CanonicalOnboardingStatus as OnboardingSchema,
  CanonicalRemittance as RemittanceSchema,
  EligibilityStatus as EligibilitySchema,
  ReferralStatus as ReferralSchema,
} from "./contracts.js";
import type { DomainConnector } from "./runner.js";
import { int, optInt, optStr, orNull, readSafely, single, str } from "./runner.js";

/** Same shapes as platform/src/adapters/ports.ts OnboardingStatus / Remittance (structural). */
export interface PortOnboardingStatus {
  providerId: string;
  stage: CanonicalOnboardingStatus["stage"];
  missingDocumentTypes: CanonicalOnboardingStatus["missingDocumentTypes"];
  asOf: string;
  organizationId?: string | null;
}
export interface PortRemittance {
  remittanceId: string;
  practiceId: string;
  periodStart: string;
  periodEnd: string;
  totalMinor: number;
  status: "SCHEDULED" | "SENT" | "RETURNED";
  paidOn: string | null;
}

/** The most recent periods one remittance read may cover (the reference API's documented bound). */
export const MAX_REMITTANCE_PERIODS = 24;

const roleOnly = <T>(party: ActingParty, role: ActingParty["role"], fn: () => Promise<DomainRead<T>>): Promise<DomainRead<T>> =>
  party.role === role ? fn() : Promise.resolve({ status: "UNAVAILABLE", reasonCode: "DOMAIN_ROLE_NOT_SUPPORTED", outcome: "NOT_STARTED", nextStep: "OFFER_HUMAN_OR_CALLBACK" });

export class HttpProviderNetwork {
  readonly kind = "live" as const;
  readonly integrationId = "provider-system";

  constructor(readonly conn: DomainConnector) {
    if (conn.binding.binding.contract !== "provider.v1") throw new ValidationError("DOMAIN_BINDING_CONTRACT_MISMATCH");
  }

  async health(): Promise<{ healthy: boolean; reasonCode: string | null }> {
    return this.conn.runner.health();
  }

  async onboarding(providerId: string): Promise<CanonicalOnboardingStatus | null> {
    return orNull(async () => {
      const result = await this.conn.run("getOnboarding", { params: { providerId } });
      const r = single(result);
      const docs = await this.conn.all("listDocuments", { params: { providerId } });
      const documents = docs.records.map((d) => ({ documentType: str(d, "documentType"), status: str(d, "status"), updatedAt: str(d, "updatedAt") }));
      const parsed = OnboardingSchema.safeParse({
        providerId: str(r, "providerId"),
        stage: str(r, "stage"),
        asOf: str(r, "asOf"),
        organizationId: optStr(r, "organizationId"),
        documents,
        missingDocumentTypes: documents.filter((d) => d.status === "MISSING" || d.status === "EXPIRED").map((d) => d.documentType),
        source: this.conn.source(result),
      });
      if (!parsed.success) throw new ValidationError("DOMAIN_RECORD_INVALID");
      return parsed.data;
    });
  }

  async remittances(practiceId: string, periods: number): Promise<CanonicalRemittance[]> {
    const { records, source } = await this.conn.all("listRemittances", { params: { practiceId, periods } });
    return records.map((r) => remittanceOf(r, source));
  }

  readOnboarding(party: ActingParty): Promise<DomainRead<CanonicalOnboardingStatus>> {
    return roleOnly(party, "provider", () => readSafely(() => this.onboarding(party.partyRef)));
  }

  // ProviderSystem port (platform/src/adapters/ports.ts)
  async getOnboardingStatus(providerId: string): Promise<PortOnboardingStatus | null> {
    const o = await this.onboarding(providerId);
    return o ? { providerId: o.providerId, stage: o.stage, missingDocumentTypes: [...o.missingDocumentTypes], asOf: o.asOf, organizationId: o.organizationId } : null;
  }

  /**
   * Remittances whose period lies in [fromDate, toDate]. The system serves the most recent periods only: when the
   * range reaches past the oldest period it returned at its documented bound, the read is refused
   * (REMITTANCE_RANGE_EXCEEDS_SOURCE_WINDOW) rather than returned incomplete.
   */
  async listRemittances(input: { practiceId: string; fromDate: string; toDate: string }): Promise<PortRemittance[]> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(input.toDate) || input.toDate < input.fromDate) throw new ValidationError("REMITTANCE_RANGE_INVALID");
    const all = await this.remittances(input.practiceId, MAX_REMITTANCE_PERIODS);
    if (all.length >= MAX_REMITTANCE_PERIODS) {
      const oldest = all.reduce((m, r) => (r.periodStart < m ? r.periodStart : m), all[0]?.periodStart ?? input.fromDate);
      if (oldest > input.fromDate) throw new ValidationError("REMITTANCE_RANGE_EXCEEDS_SOURCE_WINDOW");
    }
    return all
      .filter((r) => r.periodEnd >= input.fromDate && r.periodStart <= input.toDate)
      .map((r) => ({ remittanceId: r.remittanceId, practiceId: r.practiceId, periodStart: r.periodStart, periodEnd: r.periodEnd, totalMinor: r.totalMinor, status: r.status, paidOn: r.paidOn }));
  }
}

function remittanceOf(r: MappedRecord, source: SourceRef): CanonicalRemittance {
  const parsed = RemittanceSchema.safeParse({
    remittanceId: str(r, "remittanceId"),
    practiceId: str(r, "practiceId"),
    periodStart: str(r, "periodStart"),
    periodEnd: str(r, "periodEnd"),
    totalMinor: int(r, "totalMinor"),
    status: str(r, "status"),
    paidOn: optStr(r, "paidOn"),
    source,
  });
  if (!parsed.success) throw new ValidationError("DOMAIN_RECORD_INVALID");
  return parsed.data;
}

export class HttpReferralStatus {
  readonly kind = "live" as const;
  readonly integrationId = "referrals";

  constructor(readonly conn: DomainConnector) {
    if (conn.binding.binding.contract !== "referrals.v1") throw new ValidationError("DOMAIN_BINDING_CONTRACT_MISMATCH");
  }

  async health(): Promise<{ healthy: boolean; reasonCode: string | null }> {
    return this.conn.runner.health();
  }

  private referralOf(r: MappedRecord, source: SourceRef): ReferralStatus {
    const parsed = ReferralSchema.safeParse({
      referralId: str(r, "referralId"),
      subjectId: str(r, "subjectId"),
      specialtyCode: str(r, "specialtyCode"),
      status: str(r, "status"),
      statusAsOf: str(r, "statusAsOf"),
      receivedOn: str(r, "receivedOn"),
      referringOrganizationId: optStr(r, "referringOrganizationId"),
      source,
    });
    if (!parsed.success) throw new ValidationError("DOMAIN_RECORD_INVALID");
    return parsed.data;
  }

  async referralsOf(subjectId: string): Promise<ReferralStatus[]> {
    const { records, source } = await this.conn.all("listReferrals", { params: { subjectId } });
    return records.map((r) => this.referralOf(r, source));
  }

  async referral(referralId: string): Promise<ReferralStatus | null> {
    return orNull(async () => {
      const result = await this.conn.run("getReferral", { params: { referralId } });
      return this.referralOf(single(result), this.conn.source(result));
    });
  }

  async authorizationsOf(subjectId: string): Promise<AuthorizationStatus[]> {
    const { records, source } = await this.conn.all("listAuthorizations", { params: { subjectId } });
    return records.map((r) => {
      const parsed = AuthorizationSchema.safeParse({
        authorizationId: str(r, "authorizationId"),
        subjectId: str(r, "subjectId"),
        payerDisplayName: str(r, "payerDisplayName"),
        serviceCode: str(r, "serviceCode"),
        status: str(r, "status"),
        unitsApproved: optInt(r, "unitsApproved"),
        unitsUsed: optInt(r, "unitsUsed"),
        validFrom: optStr(r, "validFrom"),
        validTo: optStr(r, "validTo"),
        statusAsOf: str(r, "statusAsOf"),
        source,
      });
      if (!parsed.success) throw new ValidationError("DOMAIN_RECORD_INVALID");
      return parsed.data;
    });
  }

  async eligibilityOf(subjectId: string): Promise<EligibilityStatus | null> {
    return orNull(async () => {
      const result = await this.conn.run("getEligibility", { params: { subjectId } });
      const r = single(result);
      const parsed = EligibilitySchema.safeParse({
        subjectId: str(r, "subjectId"),
        payerDisplayName: str(r, "payerDisplayName"),
        coverageStatus: str(r, "coverageStatus"),
        verifiedAt: str(r, "verifiedAt"),
        source: this.conn.source(result),
      });
      if (!parsed.success) throw new ValidationError("DOMAIN_RECORD_INVALID");
      return parsed.data;
    });
  }

  // ---------------------------------------------------------------- party-scoped reads (AUTH-05; client's own records)

  readReferrals(party: ActingParty): Promise<DomainRead<ReferralStatus[]>> {
    return roleOnly(party, "client", () => readSafely(async () => (await this.referralsOf(party.partyRef)).filter((r) => r.subjectId === party.partyRef)));
  }

  readReferral(party: ActingParty, referralId: string): Promise<DomainRead<ReferralStatus>> {
    return roleOnly(party, "client", () =>
      readSafely(async () => {
        const r = await this.referral(referralId);
        return r !== null && r.subjectId === party.partyRef ? r : null;
      }),
    );
  }

  readAuthorizations(party: ActingParty): Promise<DomainRead<AuthorizationStatus[]>> {
    return roleOnly(party, "client", () => readSafely(async () => (await this.authorizationsOf(party.partyRef)).filter((a) => a.subjectId === party.partyRef)));
  }

  readEligibility(party: ActingParty): Promise<DomainRead<EligibilityStatus>> {
    return roleOnly(party, "client", () =>
      readSafely(async () => {
        const e = await this.eligibilityOf(party.partyRef);
        return e !== null && e.subjectId === party.partyRef ? e : null;
      }),
    );
  }
}
