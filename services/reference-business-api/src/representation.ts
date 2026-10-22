/**
 * Wire representations of the reference API's records (WP-23). Two account dialects exist so that tenant
 * mappings are exercised through the platform's bounded mapping DSL rather than assumed:
 *   canonical     status and modality codes as the canonical contracts name them;
 *   legacy_codes  the codes of an older scheduling product (BKD / CXL / CMP, VID / OFC / TEL), which a tenant
 *                 profile maps with enum tables.
 * Some representations carry fields the platform must never ingest (visit reason, diagnosis codes, card and
 * bank fragments, member reference, clinical summary): the platform's mappings declare them PROHIBITED.
 */
export type Dialect = "canonical" | "legacy_codes";

const LEGACY_STATUS: Record<string, string> = { SCHEDULED: "BKD", CANCELLED: "CXL", COMPLETED: "CMP" };
const LEGACY_MODALITY: Record<string, string> = { video: "VID", in_person: "OFC", phone: "TEL" };
export const LEGACY_STATUS_CODES = Object.values(LEGACY_STATUS);
export const LEGACY_MODALITY_CODES = Object.values(LEGACY_MODALITY);
export const CANONICAL_STATUS_CODES = Object.keys(LEGACY_STATUS);
export const CANONICAL_MODALITY_CODES = Object.keys(LEGACY_MODALITY);

const iso = (d: Date | string | null): string | null => (d === null ? null : new Date(d).toISOString());
const date = (d: Date | string | null): string | null => {
  if (d === null) return null;
  if (typeof d === "string") return d.slice(0, 10);
  // pg returns DATE as a local-midnight Date; format the calendar date it denotes.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

export interface AppointmentRow {
  appointment_id: string;
  subject_id: string;
  provider_id: string;
  display_name: string;
  slot_id: string | null;
  starts_at: Date;
  time_zone: string;
  modality: string;
  status: string;
  version: number;
  visit_reason: string | null;
  external_ref: string | null;
  updated_at: Date;
}

export function appointment(r: AppointmentRow, dialect: Dialect): Record<string, unknown> {
  return {
    id: r.appointment_id,
    subjectId: r.subject_id,
    providerId: r.provider_id,
    providerDisplayName: r.display_name,
    slotId: r.slot_id,
    startsAt: iso(r.starts_at),
    timeZone: r.time_zone,
    modality: dialect === "legacy_codes" ? LEGACY_MODALITY[r.modality] : r.modality,
    status: dialect === "legacy_codes" ? LEGACY_STATUS[r.status] : r.status,
    version: String(r.version),
    updatedAt: iso(r.updated_at),
    visitReason: r.visit_reason,
  };
}

export interface SlotRow {
  slot_id: string;
  provider_id: string;
  display_name: string;
  starts_at: Date;
  time_zone: string;
  modality: string;
  state: string;
  version: number;
}

export function slot(r: SlotRow, dialect: Dialect): Record<string, unknown> {
  return {
    id: r.slot_id,
    providerId: r.provider_id,
    providerDisplayName: r.display_name,
    startsAt: iso(r.starts_at),
    timeZone: r.time_zone,
    modality: dialect === "legacy_codes" ? LEGACY_MODALITY[r.modality] : r.modality,
    state: r.state,
    version: String(r.version),
  };
}

/** Wall-clock local time (no offset) of an instant in an IANA zone: the legacy product's time format. */
export function localWallClock(at: Date, zone: string): string {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

export function legacyAppointment(r: AppointmentRow, zone: string): Record<string, unknown> {
  return {
    apptRef: r.appointment_id,
    clientRef: r.subject_id,
    providerRef: r.provider_id,
    startLocal: localWallClock(new Date(r.starts_at), zone),
    modeCode: LEGACY_MODALITY[r.modality],
    state: LEGACY_STATUS[r.status],
    rev: r.version,
    externalRef: r.external_ref,
  };
}

export interface InvoiceRow {
  invoice_id: string;
  subject_id: string;
  issued_on: Date | string;
  due_on: Date | string;
  status: string;
  balance_minor: string | number;
  currency: string;
  version: number;
}

export const invoice = (r: InvoiceRow): Record<string, unknown> => ({
  id: r.invoice_id,
  subjectId: r.subject_id,
  issuedOn: date(r.issued_on),
  dueOn: date(r.due_on),
  status: r.status,
  balanceMinor: Number(r.balance_minor),
  currency: r.currency,
  version: String(r.version),
});

export const invoiceLine = (r: { line_id: string; code: string; service_date: Date | string; amount_minor: string | number }): Record<string, unknown> => ({
  lineId: r.line_id,
  code: r.code,
  serviceDate: date(r.service_date),
  amountMinor: Number(r.amount_minor),
});

export const payment = (r: { payment_id: string; invoice_id: string; amount_minor: string | number; received_at: Date; method_code: string; card_last4: string | null }): Record<string, unknown> => ({
  paymentId: r.payment_id,
  invoiceId: r.invoice_id,
  amountMinor: Number(r.amount_minor),
  receivedAt: iso(r.received_at),
  method: r.method_code,
  cardLast4: r.card_last4,
});

export const claim = (r: { claim_id: string; subject_id: string; service_date: Date | string; payer_display_name: string; insurer_status: string; status_as_of: Date; diagnosis_codes: string | null }): Record<string, unknown> => ({
  id: r.claim_id,
  subjectId: r.subject_id,
  serviceDate: date(r.service_date),
  payerDisplayName: r.payer_display_name,
  insurerStatus: r.insurer_status,
  statusAsOf: iso(r.status_as_of),
  diagnosisCodes: r.diagnosis_codes,
});

export const onboarding = (r: { provider_id: string; stage: string; as_of: Date; organization_id: string | null }): Record<string, unknown> => ({
  providerId: r.provider_id,
  stage: r.stage,
  asOf: iso(r.as_of),
  organizationId: r.organization_id,
});

export const onboardingDocument = (r: { document_type: string; status: string; updated_at: Date }): Record<string, unknown> => ({
  documentType: r.document_type,
  status: r.status,
  updatedAt: iso(r.updated_at),
});

export const remittance = (r: {
  remittance_id: string;
  practice_id: string;
  period_start: Date | string;
  period_end: Date | string;
  total_minor: string | number;
  status: string;
  paid_on: Date | string | null;
  bank_account_last4: string | null;
}): Record<string, unknown> => ({
  id: r.remittance_id,
  practiceId: r.practice_id,
  periodStart: date(r.period_start),
  periodEnd: date(r.period_end),
  totalMinor: Number(r.total_minor),
  status: r.status,
  paidOn: date(r.paid_on),
  bankAccountLast4: r.bank_account_last4,
});

export const referral = (r: {
  referral_id: string;
  subject_id: string;
  specialty_code: string;
  status: string;
  status_as_of: Date;
  received_on: Date | string;
  referring_organization_id: string | null;
  clinical_summary: string | null;
}): Record<string, unknown> => ({
  id: r.referral_id,
  subjectId: r.subject_id,
  specialtyCode: r.specialty_code,
  status: r.status,
  statusAsOf: iso(r.status_as_of),
  receivedOn: date(r.received_on),
  referringOrganizationId: r.referring_organization_id,
  clinicalSummary: r.clinical_summary,
});

export const authorization = (r: {
  authorization_id: string;
  subject_id: string;
  payer_display_name: string;
  service_code: string;
  status: string;
  units_approved: number | null;
  units_used: number | null;
  valid_from: Date | string | null;
  valid_to: Date | string | null;
  status_as_of: Date;
}): Record<string, unknown> => ({
  id: r.authorization_id,
  subjectId: r.subject_id,
  payerDisplayName: r.payer_display_name,
  serviceCode: r.service_code,
  status: r.status,
  unitsApproved: r.units_approved,
  unitsUsed: r.units_used,
  validFrom: date(r.valid_from),
  validTo: date(r.valid_to),
  statusAsOf: iso(r.status_as_of),
});

export const eligibility = (r: { subject_id: string; payer_display_name: string; coverage_status: string; verified_at: Date; member_reference: string | null }): Record<string, unknown> => ({
  subjectId: r.subject_id,
  payerDisplayName: r.payer_display_name,
  coverageStatus: r.coverage_status,
  verifiedAt: iso(r.verified_at),
  memberReference: r.member_reference,
});
