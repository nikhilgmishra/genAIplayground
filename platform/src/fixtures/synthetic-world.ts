/**
 * SYNTHETIC FIXTURE DATA — NOT REAL PEOPLE, NOT PHI.
 *
 * One canonical synthetic world shared by local adapters, unit tests,
 * scenarios and the demonstration journeys. Names are obviously synthetic,
 * dates of birth and phone numbers use reserved/fictional values, and every
 * identifier is prefixed "synth". Production configuration rejects any
 * adapter serving this data (OPS-04).
 */
export const SYNTHETIC_BADGE = "LOCAL SYNTHETIC FIXTURE — NOT PRODUCTION DATA";

export const TENANT_ID = "tnt_synthTenantPrimary01";
export const OTHER_TENANT_ID = "tnt_synthTenantOther0001";

export const IDP = {
  clientIssuer: "https://idp-client.local.invalid",
  providerIssuer: "https://idp-provider.local.invalid",
  workforceIssuer: "https://sso-workforce.local.invalid",
  portalAudience: "vsp-portal-local",
  consoleAudience: "vsp-console-local",
} as const;

export interface SyntheticPerson {
  actorId: string;
  accountId: string;
  subjectId: string | null;
  role: "client" | "provider" | "practice_staff" | "partner" | "personal_representative";
  displayName: string;
  fullName: string;
  dateOfBirth: string | null;
  idpIssuer: string;
  idpSubject: string;
  channels: { channelRef: string; kind: "sms" | "voice" | "email" | "portal_push"; verified: boolean; changedAt: string | null }[];
  organizationId: string | null;
  accountState: "ACTIVE" | "LOCKED" | "RECOVERY_IN_PROGRESS" | "CLOSED";
  isMinor?: boolean;
}

export const PEOPLE = {
  avery: {
    actorId: "act_synthClientAvery01",
    accountId: "acc_synthClientAvery01",
    subjectId: "sub_synthClientAvery01",
    role: "client",
    displayName: "Avery",
    fullName: "Avery Synthetic-Client",
    dateOfBirth: "1990-01-01",
    idpIssuer: IDP.clientIssuer,
    idpSubject: "client|synth-avery",
    channels: [{ channelRef: "chn_synthAverySms00001", kind: "sms", verified: true, changedAt: null }],
    organizationId: null,
    accountState: "ACTIVE",
  },
  blake: {
    actorId: "act_synthClientBlake01",
    accountId: "acc_synthClientBlake01",
    subjectId: "sub_synthClientBlake01",
    role: "client",
    displayName: "Blake",
    fullName: "Blake Synthetic-Client",
    dateOfBirth: "1985-06-15",
    idpIssuer: IDP.clientIssuer,
    idpSubject: "client|synth-blake",
    /** Recent channel change: SIM-swap risk signal. */
    channels: [{ channelRef: "chn_synthBlakeSms00001", kind: "sms", verified: true, changedAt: "2026-10-16T09:00:00.000Z" }],
    organizationId: null,
    accountState: "ACTIVE",
  },
  casey: {
    actorId: "act_synthClientCasey01",
    accountId: "acc_synthClientCasey01",
    subjectId: "sub_synthClientCasey01",
    role: "client",
    displayName: "Casey",
    fullName: "Casey Synthetic-Minor",
    dateOfBirth: "2012-03-03",
    idpIssuer: IDP.clientIssuer,
    idpSubject: "client|synth-casey",
    channels: [],
    organizationId: null,
    accountState: "ACTIVE",
    isMinor: true,
  },
  dana: {
    actorId: "act_synthRepDana00001",
    accountId: "acc_synthRepDana00001",
    subjectId: null,
    role: "personal_representative",
    displayName: "Dana",
    fullName: "Dana Synthetic-Parent",
    dateOfBirth: "1980-09-09",
    idpIssuer: IDP.clientIssuer,
    idpSubject: "client|synth-dana",
    channels: [{ channelRef: "chn_synthDanaSms000001", kind: "sms", verified: true, changedAt: null }],
    organizationId: null,
    accountState: "ACTIVE",
  },
  emery: {
    actorId: "act_synthRepEmery0001",
    accountId: "acc_synthRepEmery0001",
    subjectId: null,
    role: "personal_representative",
    displayName: "Emery",
    fullName: "Emery Synthetic-Proxy",
    dateOfBirth: "1975-12-12",
    idpIssuer: IDP.clientIssuer,
    idpSubject: "client|synth-emery",
    channels: [{ channelRef: "chn_synthEmerySms00001", kind: "sms", verified: true, changedAt: null }],
    organizationId: null,
    accountState: "ACTIVE",
  },
  morgan: {
    actorId: "act_synthProvMorgan01",
    accountId: "acc_synthProvMorgan01",
    subjectId: "prv_synthProvMorgan01",
    role: "provider",
    displayName: "Dr. Morgan",
    fullName: "Morgan Synthetic-Provider",
    dateOfBirth: null,
    idpIssuer: IDP.providerIssuer,
    idpSubject: "provider|synth-morgan",
    channels: [{ channelRef: "chn_synthMorganEmail01", kind: "email", verified: true, changedAt: null }],
    organizationId: "org_synthPracticeNorth1",
    accountState: "ACTIVE",
  },
  newbie: {
    actorId: "act_synthProvNewbie01",
    accountId: "acc_synthProvNewbie01",
    subjectId: "prv_synthProvNewbie01",
    role: "provider",
    displayName: "Dr. Newbie",
    fullName: "Newbie Synthetic-Provider",
    dateOfBirth: null,
    idpIssuer: IDP.providerIssuer,
    idpSubject: "provider|synth-newbie",
    channels: [{ channelRef: "chn_synthNewbieEmail01", kind: "email", verified: true, changedAt: null }],
    organizationId: null,
    accountState: "ACTIVE",
  },
  riley: {
    actorId: "act_synthStaffRiley01",
    accountId: "acc_synthStaffRiley01",
    subjectId: null,
    role: "practice_staff",
    displayName: "Riley",
    fullName: "Riley Synthetic-Staff",
    dateOfBirth: null,
    idpIssuer: IDP.providerIssuer,
    idpSubject: "provider|synth-riley",
    channels: [{ channelRef: "chn_synthRileyEmail001", kind: "email", verified: true, changedAt: null }],
    organizationId: "org_synthPracticeNorth1",
    accountState: "ACTIVE",
  },
  quinn: {
    actorId: "act_synthPartnerQuinn1",
    accountId: "acc_synthPartnerQuinn1",
    subjectId: null,
    role: "partner",
    displayName: "Quinn",
    fullName: "Quinn Synthetic-Partner",
    dateOfBirth: null,
    idpIssuer: IDP.clientIssuer,
    idpSubject: "partner|synth-quinn",
    channels: [{ channelRef: "chn_synthQuinnEmail001", kind: "email", verified: true, changedAt: null }],
    organizationId: "org_synthPartnerAcme01",
    accountState: "ACTIVE",
  },
} as const satisfies Record<string, SyntheticPerson>;

export const ORGANIZATIONS = {
  practiceNorth: { organizationId: "org_synthPracticeNorth1", kind: "practice", displayName: "North Synthetic Practice" },
  practiceSouth: { organizationId: "org_synthPracticeSouth1", kind: "practice", displayName: "South Synthetic Practice" },
  partnerAcme: { organizationId: "org_synthPartnerAcme01", kind: "partner", displayName: "Acme Synthetic Employer Partner" },
} as const;

/** Authoritative delegation / enrollment / legal-authority records. */
export const DELEGATIONS = [
  {
    grantId: "gnt_synthRileyNorthDelegation",
    kind: "practice_delegation",
    actorId: PEOPLE.riley.actorId,
    subjectId: null,
    organizationId: ORGANIZATIONS.practiceNorth.organizationId,
    scopes: ["remittance:read", "onboarding:read", "case:read"],
    source: "delegation_registry",
    validFrom: "2026-01-01T00:00:00.000Z",
    validUntil: "2027-01-01T00:00:00.000Z",
  },
  {
    grantId: "gnt_synthMorganNorthMember01",
    kind: "practice_delegation",
    actorId: PEOPLE.morgan.actorId,
    subjectId: null,
    organizationId: ORGANIZATIONS.practiceNorth.organizationId,
    scopes: ["remittance:read", "onboarding:read", "case:read", "appointment:read"],
    source: "enrollment_system",
    validFrom: "2025-01-01T00:00:00.000Z",
    validUntil: null,
  },
  {
    grantId: "gnt_synthQuinnAcmeAffiliation",
    kind: "partner_affiliation",
    actorId: PEOPLE.quinn.actorId,
    subjectId: null,
    organizationId: ORGANIZATIONS.partnerAcme.organizationId,
    scopes: ["partner_intake:create", "case:read"],
    source: "partner_contract_registry",
    validFrom: "2026-01-01T00:00:00.000Z",
    validUntil: "2026-12-31T23:59:59.000Z",
  },
  {
    grantId: "gnt_synthDanaCaseyParental01",
    kind: "parental_authority",
    actorId: PEOPLE.dana.actorId,
    subjectId: PEOPLE.casey.subjectId,
    organizationId: null,
    scopes: ["appointment:read", "invoice:read"],
    source: "legal_authority_registry",
    validFrom: "2024-01-01T00:00:00.000Z",
    validUntil: null,
    /** Minor confidentiality rules may still require human review for some records. */
    constraints: ["MINOR_CONFIDENTIALITY_REVIEW"],
  },
  {
    grantId: "gnt_synthEmeryBlakeExpired01",
    kind: "legal_representative",
    actorId: PEOPLE.emery.actorId,
    subjectId: PEOPLE.blake.subjectId,
    organizationId: null,
    scopes: ["appointment:read", "invoice:read"],
    source: "legal_authority_registry",
    validFrom: "2025-01-01T00:00:00.000Z",
    /** Expired proxy authority. */
    validUntil: "2026-06-30T23:59:59.000Z",
  },
] as const;

/** Treating relationships (provider -> client) from the enrollment system. */
export const TREATING_RELATIONSHIPS = [
  { providerActorId: PEOPLE.morgan.actorId, clientSubjectId: PEOPLE.avery.subjectId, validUntil: null },
] as const;

export const APPOINTMENTS = [
  {
    appointmentId: "apt_synthAveryAppt00001",
    subjectId: PEOPLE.avery.subjectId,
    providerActorId: PEOPLE.morgan.actorId,
    providerDisplayName: "Dr. Morgan",
    startsAt: "2026-10-22T17:00:00.000Z",
    timeZone: "America/Chicago",
    modality: "video",
    status: "SCHEDULED",
    version: "v1",
  },
  {
    appointmentId: "apt_synthBlakeAppt00001",
    subjectId: PEOPLE.blake.subjectId,
    providerActorId: PEOPLE.morgan.actorId,
    providerDisplayName: "Dr. Morgan",
    startsAt: "2026-10-23T15:00:00.000Z",
    timeZone: "America/New_York",
    modality: "video",
    status: "SCHEDULED",
    version: "v1",
  },
  {
    appointmentId: "apt_synthCaseyAppt00001",
    subjectId: PEOPLE.casey.subjectId,
    providerActorId: PEOPLE.morgan.actorId,
    providerDisplayName: "Dr. Morgan",
    startsAt: "2026-10-24T20:00:00.000Z",
    timeZone: "America/Chicago",
    modality: "video",
    status: "SCHEDULED",
    version: "v1",
  },
] as const;

/** Open administrative slots for Dr. Morgan. slt_synthMorganSlot0002 is the conflict-handling slot. */
export const SLOTS = [
  { slotId: "slt_synthMorganSlot0001", providerActorId: PEOPLE.morgan.actorId, providerDisplayName: "Dr. Morgan", startsAt: "2026-10-23T17:00:00.000Z", timeZone: "America/Chicago", modality: "video" },
  { slotId: "slt_synthMorganSlot0002", providerActorId: PEOPLE.morgan.actorId, providerDisplayName: "Dr. Morgan", startsAt: "2026-10-26T16:00:00.000Z", timeZone: "America/Chicago", modality: "video" },
  { slotId: "slt_synthMorganSlot0003", providerActorId: PEOPLE.morgan.actorId, providerDisplayName: "Dr. Morgan", startsAt: "2026-10-27T18:30:00.000Z", timeZone: "America/Chicago", modality: "video" },
] as const;

export const INVOICES = [
  {
    invoiceId: "inv_synthAveryInvoice001",
    subjectId: PEOPLE.avery.subjectId,
    issuedOn: "2026-10-01",
    dueOn: "2026-10-31",
    status: "OPEN",
    lines: [
      { lineId: "lin_synthAveryLine00001", code: "SESSION_FEE", serviceDate: "2026-09-20", amountMinor: 2500 },
      { lineId: "lin_synthAveryLine00002", code: "LATE_CANCELLATION", serviceDate: "2026-09-27", amountMinor: 7500 },
    ],
    balanceMinor: 10000,
    currency: "USD",
    version: "v1",
  },
  {
    invoiceId: "inv_synthBlakeInvoice001",
    subjectId: PEOPLE.blake.subjectId,
    issuedOn: "2026-10-01",
    dueOn: "2026-10-31",
    status: "OPEN",
    lines: [{ lineId: "lin_synthBlakeLine00001", code: "SESSION_FEE", serviceDate: "2026-09-21", amountMinor: 3000 }],
    balanceMinor: 3000,
    currency: "USD",
    version: "v1",
  },
] as const;

export const CLAIMS = [
  {
    claimId: "clm_synthAveryClaim0001",
    subjectId: PEOPLE.avery.subjectId,
    serviceDate: "2026-09-20",
    payerDisplayName: "Synthetic Health Plan",
    insurerStatus: "IN_PROCESS",
    statusAsOf: "2026-10-15T12:00:00.000Z",
  },
] as const;

export const ONBOARDING = [
  { providerId: PEOPLE.newbie.subjectId, stage: "DOCUMENTS_PENDING", missingDocumentTypes: ["MALPRACTICE_INSURANCE", "W9"], asOf: "2026-10-14T12:00:00.000Z" },
  { providerId: PEOPLE.morgan.subjectId, stage: "ACTIVE", missingDocumentTypes: [], asOf: "2025-02-01T12:00:00.000Z" },
] as const;

export const REMITTANCES = [
  { remittanceId: "rem_synthNorthRemit00001", practiceId: ORGANIZATIONS.practiceNorth.organizationId, periodStart: "2026-09-01", periodEnd: "2026-09-30", totalMinor: 1250000, status: "SENT", paidOn: "2026-10-05" },
  { remittanceId: "rem_synthNorthRemit00002", practiceId: ORGANIZATIONS.practiceNorth.organizationId, periodStart: "2026-10-01", periodEnd: "2026-10-15", totalMinor: 610000, status: "SCHEDULED", paidOn: null },
  { remittanceId: "rem_synthSouthRemit00001", practiceId: ORGANIZATIONS.practiceSouth.organizationId, periodStart: "2026-09-01", periodEnd: "2026-09-30", totalMinor: 990000, status: "SENT", paidOn: "2026-10-05" },
] as const;

/** Trusted transfer destinations (allowlist). Vendor queue refs are placeholders until Talkdesk exports exist. */
export const DESTINATIONS = [
  { destinationId: "dst_safety_priority", purpose: "SAFETY_PRIORITY", vendorQueueRef: "TALKDESK_QUEUE_PLACEHOLDER_SAFETY", fallbackDestinationIds: ["dst_safety_backup"], languages: ["en", "es"] },
  { destinationId: "dst_safety_backup", purpose: "SAFETY_PRIORITY", vendorQueueRef: "TALKDESK_QUEUE_PLACEHOLDER_SAFETY_BACKUP", fallbackDestinationIds: [], languages: ["en", "es"] },
  { destinationId: "dst_support_general", purpose: "STANDARD_SUPPORT", vendorQueueRef: "TALKDESK_QUEUE_PLACEHOLDER_GENERAL", fallbackDestinationIds: ["dst_outage_continuity"], languages: ["en", "es"] },
  { destinationId: "dst_billing_specialist", purpose: "BILLING_SPECIALIST", vendorQueueRef: "TALKDESK_QUEUE_PLACEHOLDER_BILLING", fallbackDestinationIds: ["dst_support_general"], languages: ["en"] },
  { destinationId: "dst_provider_support", purpose: "PROVIDER_SUPPORT", vendorQueueRef: "TALKDESK_QUEUE_PLACEHOLDER_PROVIDER", fallbackDestinationIds: ["dst_support_general"], languages: ["en"] },
  { destinationId: "dst_partner_support", purpose: "PARTNER_SUPPORT", vendorQueueRef: "TALKDESK_QUEUE_PLACEHOLDER_PARTNER", fallbackDestinationIds: ["dst_support_general"], languages: ["en"] },
  { destinationId: "dst_interpreter", purpose: "INTERPRETER", vendorQueueRef: "TALKDESK_QUEUE_PLACEHOLDER_INTERPRETER", fallbackDestinationIds: ["dst_support_general"], languages: ["*"] },
  { destinationId: "dst_clinical_route", purpose: "CLINICAL_ROUTE", vendorQueueRef: "TALKDESK_QUEUE_PLACEHOLDER_CLINICAL", fallbackDestinationIds: ["dst_support_general"], languages: ["en"] },
  { destinationId: "dst_outage_continuity", purpose: "OUTAGE_CONTINUITY", vendorQueueRef: "TALKDESK_QUEUE_PLACEHOLDER_CONTINUITY", fallbackDestinationIds: [], languages: ["en", "es"] },
] as const;

/** Workforce staff for the console (synthetic). */
export const STAFF = {
  supervisor: { staffId: "stf_synthSupervisor01", roles: ["supervisor"], idpSubject: "workforce|synth-supervisor" },
  agent: { staffId: "stf_synthSupportAgent1", roles: ["support_agent"], idpSubject: "workforce|synth-agent" },
  safety: { staffId: "stf_synthSafetyResp001", roles: ["safety_responder"], idpSubject: "workforce|synth-safety" },
  auditor: { staffId: "stf_synthAuditor00001", roles: ["auditor"], idpSubject: "workforce|synth-auditor" },
  policyApprover: { staffId: "stf_synthPolicyApprov1", roles: ["policy_approver"], idpSubject: "workforce|synth-policy" },
  knowledgeEditor: { staffId: "stf_synthKnowledgeEd1", roles: ["knowledge_editor"], idpSubject: "workforce|synth-knowledge" },
  deployOperator: { staffId: "stf_synthDeployOper01", roles: ["deployment_operator"], idpSubject: "workforce|synth-deploy" },
  securityAdmin: { staffId: "stf_synthSecurityAdm1", roles: ["security_admin"], idpSubject: "workforce|synth-security" },
} as const;

/** Synthetic calls. Caller ID values are fictional (555-01xx range). */
export const CALLS = {
  primary: { callId: "cal_synthCallPrimary0001", callerIdE164: "+15555550101" },
  concurrent: { callId: "cal_synthCallConcurrent1", callerIdE164: "+15555550102" },
  repeat: { callId: "cal_synthCallRepeat00001", callerIdE164: "+15555550101" },
} as const;
