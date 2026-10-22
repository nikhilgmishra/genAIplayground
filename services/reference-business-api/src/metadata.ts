/**
 * Self-description of the reference API's objects as JSON Schema (draft 2020-12 subset), served per account
 * dialect at `/api/v1/meta/{system}/metadata`. The platform's connector test wizard compares its reviewed
 * mappings with this document (INSPECT_METADATA): types, formats, enum value sets, and the fields the tenant
 * classifies as prohibited (`x-vsp-prohibited`) or restricted (`x-vsp-classification`).
 */
import type { Dialect } from "./representation.js";
import { CANONICAL_MODALITY_CODES, CANONICAL_STATUS_CODES, LEGACY_MODALITY_CODES, LEGACY_STATUS_CODES } from "./representation.js";

type Node = Record<string, unknown>;

const str = (extra: Node = {}): Node => ({ type: "string", ...extra });
const nstr = (extra: Node = {}): Node => ({ type: ["string", "null"], ...extra });
const int = (extra: Node = {}): Node => ({ type: "integer", ...extra });
const instant = (nullable = false): Node => ({ type: nullable ? ["string", "null"] : "string", format: "date-time" });
const day = (nullable = false): Node => ({ type: nullable ? ["string", "null"] : "string", format: "date" });
const prohibited = (classification: string): Node => ({ type: ["string", "null"], "x-vsp-prohibited": true, "x-vsp-classification": classification });
const obj = (title: string, properties: Record<string, Node>, required: string[]): Node => ({ title, type: "object", properties, required });

export function metadataDocument(dialect: Dialect): Node {
  const status = dialect === "legacy_codes" ? LEGACY_STATUS_CODES : CANONICAL_STATUS_CODES;
  const modality = dialect === "legacy_codes" ? LEGACY_MODALITY_CODES : CANONICAL_MODALITY_CODES;
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "reference-business-api",
    $defs: {
      Appointment: obj(
        "Appointment",
        {
          id: str(),
          subjectId: str(),
          providerId: str(),
          providerDisplayName: str({ "x-vsp-classification": "PHI" }),
          slotId: nstr(),
          startsAt: instant(),
          timeZone: str(),
          modality: str({ enum: modality }),
          status: str({ enum: status }),
          version: str(),
          updatedAt: instant(),
          visitReason: prohibited("PHI_RESTRICTED"),
        },
        ["id", "subjectId", "providerId", "startsAt", "timeZone", "modality", "status", "version"],
      ),
      Slot: obj(
        "Slot",
        {
          id: str(),
          providerId: str(),
          providerDisplayName: str({ "x-vsp-classification": "PHI" }),
          startsAt: instant(),
          timeZone: str(),
          modality: str({ enum: modality }),
          state: str({ enum: ["OPEN", "BOOKED", "BLOCKED"] }),
          version: str(),
        },
        ["id", "providerId", "startsAt", "timeZone", "modality", "state", "version"],
      ),
      Invoice: obj(
        "Invoice",
        {
          id: str(),
          subjectId: str(),
          issuedOn: day(),
          dueOn: day(),
          status: str({ enum: ["OPEN", "PAID", "IN_REVIEW", "VOID"] }),
          balanceMinor: int({ "x-unit": "minor_units" }),
          currency: str(),
          version: str(),
        },
        ["id", "subjectId", "issuedOn", "dueOn", "status", "balanceMinor", "currency", "version"],
      ),
      InvoiceLine: obj(
        "InvoiceLine",
        { lineId: str(), code: str({ enum: ["SESSION_FEE", "LATE_CANCELLATION", "NO_SHOW", "ADJUSTMENT", "PAYMENT"] }), serviceDate: day(), amountMinor: int({ "x-unit": "minor_units" }) },
        ["lineId", "code", "serviceDate", "amountMinor"],
      ),
      Payment: obj(
        "Payment",
        { paymentId: str(), invoiceId: str(), amountMinor: int({ "x-unit": "minor_units" }), receivedAt: instant(), method: str({ enum: ["CARD", "ACH", "CHECK", "PORTAL"] }), cardLast4: prohibited("FINANCIAL") },
        ["paymentId", "invoiceId", "amountMinor", "receivedAt", "method"],
      ),
      Claim: obj(
        "Claim",
        {
          id: str(),
          subjectId: str(),
          serviceDate: day(),
          payerDisplayName: str(),
          insurerStatus: str({ enum: ["RECEIVED", "IN_PROCESS", "ADJUDICATED_PAID", "ADJUDICATED_DENIED", "NEEDS_INFORMATION"] }),
          statusAsOf: instant(),
          diagnosisCodes: prohibited("PHI_RESTRICTED"),
        },
        ["id", "subjectId", "serviceDate", "payerDisplayName", "insurerStatus", "statusAsOf"],
      ),
      Onboarding: obj(
        "Onboarding",
        {
          providerId: str(),
          stage: str({ enum: ["APPLICATION_RECEIVED", "DOCUMENTS_PENDING", "CREDENTIALING_IN_REVIEW", "CONTRACTING", "ACTIVE", "ON_HOLD"] }),
          asOf: instant(),
          organizationId: nstr(),
        },
        ["providerId", "stage", "asOf"],
      ),
      OnboardingDocument: obj(
        "OnboardingDocument",
        {
          documentType: str({ enum: ["LICENSE", "MALPRACTICE_INSURANCE", "W9", "DEA", "BOARD_CERTIFICATION"] }),
          status: str({ enum: ["RECEIVED", "MISSING", "EXPIRED", "IN_REVIEW", "ACCEPTED"] }),
          updatedAt: instant(),
        },
        ["documentType", "status", "updatedAt"],
      ),
      Remittance: obj(
        "Remittance",
        {
          id: str(),
          practiceId: str(),
          periodStart: day(),
          periodEnd: day(),
          totalMinor: int({ "x-unit": "minor_units" }),
          status: str({ enum: ["SCHEDULED", "SENT", "RETURNED"] }),
          paidOn: day(true),
          bankAccountLast4: prohibited("FINANCIAL"),
        },
        ["id", "practiceId", "periodStart", "periodEnd", "totalMinor", "status"],
      ),
      Referral: obj(
        "Referral",
        {
          id: str(),
          subjectId: str(),
          specialtyCode: str(),
          status: str({ enum: ["RECEIVED", "IN_REVIEW", "ACCEPTED", "DECLINED", "SCHEDULED", "CLOSED"] }),
          statusAsOf: instant(),
          receivedOn: day(),
          referringOrganizationId: nstr(),
          clinicalSummary: prohibited("PHI_RESTRICTED"),
        },
        ["id", "subjectId", "specialtyCode", "status", "statusAsOf", "receivedOn"],
      ),
      Authorization: obj(
        "Authorization",
        {
          id: str(),
          subjectId: str(),
          payerDisplayName: str(),
          serviceCode: str(),
          status: str({ enum: ["PENDING", "APPROVED", "DENIED", "EXPIRED"] }),
          unitsApproved: { type: ["integer", "null"] },
          unitsUsed: { type: ["integer", "null"] },
          validFrom: day(true),
          validTo: day(true),
          statusAsOf: instant(),
        },
        ["id", "subjectId", "payerDisplayName", "serviceCode", "status", "statusAsOf"],
      ),
      Eligibility: obj(
        "Eligibility",
        {
          subjectId: str(),
          payerDisplayName: str(),
          coverageStatus: str({ enum: ["ACTIVE", "INACTIVE", "NOT_FOUND_AT_PAYER"] }),
          verifiedAt: instant(),
          memberReference: prohibited("PHI_RESTRICTED"),
        },
        ["subjectId", "payerDisplayName", "coverageStatus", "verifiedAt"],
      ),
      ChangeRequest: obj(
        "ChangeRequest",
        {
          requestId: str(),
          operation: str(),
          state: str({ enum: ["COMPLETED", "INCOMPLETE", "REJECTED"] }),
          receiptId: nstr(),
          resourceType: nstr(),
          resourceId: nstr(),
          resourceVersion: nstr(),
          appliedAt: instant(true),
          completedAt: instant(true),
          notAfter: instant(true),
          requestDigest: str({ pattern: "^[0-9a-f]{64}$" }),
          failureCode: nstr(),
          resource: {
            type: ["object", "null"],
            properties: { startsAt: instant(true), timeZone: nstr(), status: nstr(), state: nstr(), version: nstr(), slotId: nstr(), subjectId: nstr() },
          },
        },
        ["requestId", "operation", "state"],
      ),
      Receipt: obj(
        "Receipt",
        { receiptId: str(), requestId: str(), operation: str(), resourceType: str(), resourceId: str(), resourceVersion: str(), stateDigest: str(), requestDigest: str({ pattern: "^[0-9a-f]{64}$" }), committedAt: instant() },
        ["receiptId", "requestId", "operation", "resourceType", "resourceId", "resourceVersion", "stateDigest", "requestDigest", "committedAt"],
      ),
      Consistency: obj(
        "Consistency",
        {
          accountId: str(),
          dialect: str({ enum: ["canonical", "legacy_codes"] }),
          timeZone: str(),
          visibilityWindowMs: int(),
          dispatchDeadline: str({ enum: ["REQUEST_NOT_AFTER"] }),
          requestDigest: str({ enum: ["REFBIZ_REQUEST_V1"] }),
          absenceProof: str({ enum: ["FENCE_AFTER_DEADLINE"] }),
          dispatchReservation: str({ enum: ["RESERVE_BEFORE_CREATE"] }),
        },
        ["accountId", "dialect", "timeZone", "visibilityWindowMs", "dispatchDeadline", "requestDigest", "absenceProof", "dispatchReservation"],
      ),
      LegacyReference: obj(
        "LegacyReference",
        {
          externalRef: str(),
          state: str({ enum: ["RESERVED", "POSTED", "FENCED", "RELEASED"] }),
          reservedForDispatch: { type: "boolean" },
          reservedAt: instant(true),
          postedAt: instant(true),
          fencedAt: instant(true),
        },
        ["externalRef", "state", "reservedForDispatch"],
      ),
      LegacyAppointment: obj(
        "LegacyAppointment",
        {
          apptRef: str(),
          clientRef: str(),
          providerRef: str(),
          startLocal: str(),
          modeCode: str({ enum: LEGACY_MODALITY_CODES }),
          state: str({ enum: LEGACY_STATUS_CODES }),
          rev: int(),
          externalRef: nstr(),
        },
        ["apptRef", "clientRef", "providerRef", "startLocal", "modeCode", "state", "rev"],
      ),
    },
  };
}
