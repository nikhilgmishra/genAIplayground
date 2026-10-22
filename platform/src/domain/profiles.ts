/**
 * Reviewed ConnectorProfiles and domain bindings for the reference business API contract (WP-23; FO-06-74,
 * FO-06-75, FO-19-21, FO-06-76, FO-00-13).
 *
 * These builders produce configuration DATA for a tenant whose system of record speaks the reference business API
 * (services/reference-business-api, OpenAPI in services/reference-business-api/openapi). A tenant's own values
 * (host, account, region, credentials, CA, dialect, business time zone, visibility window) are inputs; nothing
 * here is a credential or an endpoint of a real system. Every profile is admitted by the WP-06 admission rules
 * (`admitConnectorProfile`) before use, and its binding by `admitBinding`; the unit tests admit every variant.
 *
 * Tenant mappings run through the bounded DSL only: enum tables for the account dialect's codes (`canonical` or
 * `legacy_codes`), a zone table for the legacy product's wall-clock times, and PROHIBITED rules for fields the
 * platform must never ingest (visit reason, diagnosis codes, card and bank fragments, member reference, clinical
 * summary). A code outside the table, a missing required field or a changed type is schema drift: the whole
 * response is refused, never partially used.
 *
 * Writes are keyed (EXTERNAL_ID_UPSERT: the request id in the path is derived from the ledger's stable key) and
 * reconciled through the change-request lookup; the legacy product's create is NOT idempotent and is reconciled
 * through its by-reference lookup (FO-06-75). Every write carries the optional dispatch deadline `notAfter` the
 * reference API enforces (its bindings declare REQUEST_NOT_AFTER), and the change-request answers carry the
 * request digest (REFBIZ_REQUEST_V1) plus the changed resource's slot and subject, which bind a change found
 * under a request id to the confirmed action (ACT-02, ACT-03). Absence is proved only by the API's fences (a
 * request id's `change.fence`, a legacy reference's `reference.fence`, accepted once the deadline has passed), and
 * the legacy create runs only under the dispatch's own reservation of its reference (`reference.reserve`), so a
 * redelivery inside the lookup's lag never sends a second create.
 */
import type { Classification } from "../protocol/common.js";
import type { ConnectorOperation, ConnectorProfile, FieldMapping, OperationParam, OperationRequestField } from "../protocol/connector.js";
import { computeConnectorProfileDigest } from "../protocol/digests.js";
import type { DomainBinding, DomainContract } from "./binding.js";

export type ReferenceDialect = "canonical" | "legacy_codes";

/** Tenant-specific values of one reference-API connector (configuration, never secrets themselves). */
export interface ReferenceProfileInput {
  tenantId: string;
  /** `cnp_` opaque id of the profile. */
  profileId: string;
  profileVersion?: number;
  occurredAt: string;
  /** Host of the tenant's API (token endpoint on the same host). */
  host: string;
  /** Account the credentials belong to at the system of record (verified on every token response). */
  externalAccountRef: string;
  region: string;
  /** Default and read credential (one capability-scoped credential per access; never the write credential). */
  readCredentialRef: string;
  /** Write credential; null for a read-only profile. */
  writeCredentialRef: string | null;
  writeMode: ConnectorProfile["writeMode"];
  dialect: ReferenceDialect;
  /** IANA zone of the legacy product's wall-clock times (legacy contract only). */
  businessTimeZone?: string;
  addressClass: "PUBLIC_INTERNET" | "PRIVATE_NETWORK";
  /** Private CA of an internal API (secret reference), or null for a publicly trusted certificate. */
  tlsCaRef: string | null;
  /** Approved synthetic record for the health / capability probe (opaque id at the system), or null. */
  syntheticRecordId: string | null;
  /** Per-operation timeout (ms) of reads and writes; bounded by the connector timeout. */
  readTimeoutMs?: number;
  writeTimeoutMs?: number;
  retryBudget?: number;
  /** Provider-approved availability blocks offered by this tenant (scheduling only). */
  availabilityBlocks?: boolean;
}

const API_VERSION = "2026-10-01";
const CONNECTOR_TIMEOUT_MS = 10_000;

const NO_PAGINATION: NonNullable<ConnectorOperation["pagination"]> = { strategy: "NONE", maxPageSize: 1, maxPages: 1, pageSizeParam: null, cursorParam: null, nextPointer: null, cursorExpiredStatus: null };

const idParam = (name: string): OperationParam => ({ name, in: "path", wireName: null, type: "opaque_id", required: true, maxLength: 64, enumValues: null, integerRange: null });
const intQuery = (name: string, min: number, max: number, required: boolean): OperationParam => ({ name, in: "query", wireName: name, type: "integer", required, maxLength: 4, enumValues: null, integerRange: { min, max } });
const idQuery = (name: string): OperationParam => ({ name, in: "query", wireName: name, type: "opaque_id", required: false, maxLength: 64, enumValues: null, integerRange: null });

interface OpCtx {
  readCapability: string;
  writeCapability: string;
  readScope: string;
  writeScope: string;
  readTimeoutMs: number;
  writeTimeoutMs: number;
}

function read(c: OpCtx, o: Pick<ConnectorOperation, "operationId" | "pathTemplate"> & Partial<ConnectorOperation>): ConnectorOperation {
  return {
    kind: "READ",
    enabled: true,
    method: "GET",
    idempotency: "NATURALLY_IDEMPOTENT",
    reconcileOperationId: null,
    capability: c.readCapability,
    params: [],
    timeoutMs: c.readTimeoutMs,
    pagination: NO_PAGINATION,
    rateBudget: { requestsPerSecond: 20, burst: 20, maxConcurrency: 8 },
    requiredScopes: [c.readScope],
    responseObject: null,
    recordsPointer: null,
    successStatuses: [200],
    ...o,
  };
}

const list = (c: OpCtx, o: Pick<ConnectorOperation, "operationId" | "pathTemplate" | "responseObject"> & Partial<ConnectorOperation>): ConnectorOperation =>
  read(c, { recordsPointer: "/items", ...o });

const field = (inputField: string, type: OperationRequestField["type"], classification: Classification = "INTERNAL", maxLength = 64): OperationRequestField => ({
  targetPointer: `/${inputField}`,
  inputField,
  type,
  requirement: "REQUIRED",
  classification,
  maxLength,
});

/** The dispatch deadline of a write (an instant; the system applies the write only up to it). */
const NOT_AFTER: OperationRequestField = { targetPointer: "/notAfter", inputField: "notAfter", type: "instant", requirement: "OPTIONAL", classification: "INTERNAL", maxLength: 40 };

/** A keyed change request: PUT to the request id (derived from the ledger's stable key), reconciled by lookup. */
function keyedWrite(c: OpCtx, operationId: string, resource: string, fields: OperationRequestField[], lookupId: string): ConnectorOperation {
  return {
    operationId,
    kind: "WRITE",
    enabled: true,
    method: "PUT",
    pathTemplate: `/${resource}/{requestId}`,
    idempotency: "EXTERNAL_ID_UPSERT",
    externalIdParam: "requestId",
    reconcileOperationId: lookupId,
    capability: c.writeCapability,
    params: [idParam("requestId")],
    timeoutMs: c.writeTimeoutMs,
    pagination: NO_PAGINATION,
    rateBudget: { requestsPerSecond: 5, burst: 5, maxConcurrency: 4 },
    requiredScopes: [c.writeScope],
    responseObject: "ChangeRequest",
    recordsPointer: null,
    requestBody: { fields: [...fields, NOT_AFTER] },
    successStatuses: [200, 201],
  };
}

const map = (sourceObject: string, sourcePointer: string, targetField: string, type: FieldMapping["type"], o: Partial<FieldMapping> = {}): FieldMapping => ({
  sourceObject,
  sourcePointer,
  targetField,
  requirement: "REQUIRED",
  type,
  semantic: null,
  authoritative: true,
  classification: "INTERNAL",
  ...o,
});
const opt = (o: Partial<FieldMapping> = {}): Partial<FieldMapping> => ({ requirement: "OPTIONAL", authoritative: false, ...o });
const prohibited = (sourceObject: string, sourcePointer: string, targetField: string, classification: Classification): FieldMapping => ({
  sourceObject,
  sourcePointer,
  targetField,
  requirement: "PROHIBITED",
  type: "string",
  semantic: null,
  authoritative: false,
  classification,
});

const STATUS_CODES = { SCHEDULED: "BKD", CANCELLED: "CXL", COMPLETED: "CMP" } as const;
const MODALITY_CODES = { video: "VID", in_person: "OFC", phone: "TEL" } as const;

/** Enum tables of an account dialect: identity for canonical codes, the legacy product's codes otherwise. */
function dialectTables(dialect: ReferenceDialect): NonNullable<ConnectorProfile["mappingTables"]>["enums"] {
  const pairs = <K extends string>(codes: Record<K, string>) =>
    (Object.entries(codes) as [K, string][]).map(([canonical, legacy]) => ({ from: dialect === "legacy_codes" ? legacy : canonical, to: canonical }));
  return [
    { tableId: "appointment_status", entries: pairs(STATUS_CODES) },
    { tableId: "modality", entries: pairs(MODALITY_CODES) },
  ];
}

const changeRequestMappings = (): FieldMapping[] => [
  map("ChangeRequest", "/requestId", "requestId", "opaque_id"),
  map("ChangeRequest", "/operation", "operation", "enum_code"),
  map("ChangeRequest", "/state", "state", "enum_code"),
  map("ChangeRequest", "/receiptId", "receiptId", "opaque_id", opt({ authoritative: true })),
  map("ChangeRequest", "/resourceType", "resourceType", "enum_code", opt()),
  map("ChangeRequest", "/resourceId", "resourceId", "opaque_id", opt({ authoritative: true })),
  map("ChangeRequest", "/resourceVersion", "resourceVersion", "opaque_id", opt({ authoritative: true })),
  map("ChangeRequest", "/resource/startsAt", "resourceStartsAt", "instant", opt({ classification: "PHI" })),
  map("ChangeRequest", "/resource/timeZone", "resourceTimeZone", "string", opt()),
  map("ChangeRequest", "/resource/slotId", "resourceSlotId", "opaque_id", opt()),
  map("ChangeRequest", "/resource/subjectId", "resourceSubjectId", "opaque_id", opt()),
  map("ChangeRequest", "/requestDigest", "requestDigest", "opaque_id", opt({ authoritative: true })),
  map("ChangeRequest", "/failureCode", "failureCode", "enum_code", opt()),
];

const receiptMappings = (): FieldMapping[] => [
  map("Receipt", "/receiptId", "receiptId", "opaque_id"),
  map("Receipt", "/requestId", "requestId", "opaque_id"),
  map("Receipt", "/operation", "operation", "enum_code"),
  map("Receipt", "/resourceType", "resourceType", "enum_code"),
  map("Receipt", "/resourceId", "resourceId", "opaque_id"),
  map("Receipt", "/resourceVersion", "resourceVersion", "opaque_id"),
  map("Receipt", "/stateDigest", "stateDigest", "opaque_id"),
  map("Receipt", "/requestDigest", "requestDigest", "opaque_id", opt({ authoritative: true })),
  map("Receipt", "/committedAt", "committedAt", "instant"),
];

const consistencyMappings = (): FieldMapping[] => [
  map("Consistency", "/visibilityWindowMs", "visibilityWindowMs", "integer"),
  map("Consistency", "/timeZone", "timeZone", "string", opt()),
  map("Consistency", "/dispatchDeadline", "dispatchDeadline", "string", opt()),
  map("Consistency", "/requestDigest", "requestDigestScheme", "string", opt()),
  map("Consistency", "/absenceProof", "absenceProof", "string", opt()),
  map("Consistency", "/dispatchReservation", "dispatchReservation", "string", opt()),
];

/** A legacy reference: the reservation / fence state (the reserving dispatch id is never disclosed). */
const referenceMappings = (): FieldMapping[] => [
  map("LegacyReference", "/externalRef", "externalRef", "opaque_id"),
  map("LegacyReference", "/state", "referenceState", "enum_code"),
  map("LegacyReference", "/reservedForDispatch", "reservedForDispatch", "boolean"),
];

/** A legacy reference write (reserve / release / fence), keyed by the reference, reconciled by the lookup. */
function referenceWrite(c: OpCtx, operationId: string, method: "PUT" | "POST", suffix: string, fields: OperationRequestField[]): ConnectorOperation {
  return {
    operationId,
    kind: "WRITE",
    enabled: true,
    method,
    pathTemplate: `/legacy/references/{externalRef}${suffix}`,
    idempotency: "EXTERNAL_ID_UPSERT",
    externalIdParam: "externalRef",
    reconcileOperationId: "legacy.appointments.by_reference",
    capability: c.writeCapability,
    params: [idParam("externalRef")],
    timeoutMs: c.writeTimeoutMs,
    pagination: NO_PAGINATION,
    rateBudget: { requestsPerSecond: 5, burst: 5, maxConcurrency: 4 },
    requiredScopes: [c.writeScope],
    responseObject: "LegacyReference",
    recordsPointer: null,
    requestBody: { fields },
    successStatuses: [200],
  };
}

type SystemKey = "scheduling" | "billing" | "claims" | "provider" | "referrals" | "legacy";

interface Plan {
  system: string;
  family: ConnectorProfile["family"];
  egressClass: Classification;
  api: string;
  readScope: string;
  writeScope: string | null;
  operations: (c: OpCtx) => ConnectorOperation[];
  mappings: FieldMapping[];
  streams: { streamId: string; sourceObject: string; egressClass: Classification; deletionBehavior?: NonNullable<ConnectorProfile["streams"]>[number]["deletionBehavior"] }[];
  syntheticOperationId: string;
  syntheticParam: string;
  tables: (input: ReferenceProfileInput) => NonNullable<ConnectorProfile["mappingTables"]>;
}

const changeOps = (c: OpCtx, prefix: string): ConnectorOperation[] => [
  read(c, { operationId: `${prefix}.change.lookup`, kind: "RECONCILE_LOOKUP", pathTemplate: "/change-requests/{requestId}", params: [idParam("requestId")], responseObject: "ChangeRequest" }),
  {
    operationId: `${prefix}.change.complete`,
    kind: "WRITE",
    enabled: true,
    method: "POST",
    pathTemplate: "/change-requests/{requestId}/completion",
    idempotency: "EXTERNAL_ID_UPSERT",
    externalIdParam: "requestId",
    reconcileOperationId: `${prefix}.change.lookup`,
    capability: c.writeCapability,
    params: [idParam("requestId")],
    timeoutMs: c.writeTimeoutMs,
    pagination: NO_PAGINATION,
    rateBudget: { requestsPerSecond: 5, burst: 5, maxConcurrency: 4 },
    requiredScopes: [c.writeScope],
    responseObject: "ChangeRequest",
    recordsPointer: null,
    requestBody: null,
    successStatuses: [200],
  },
  read(c, { operationId: `${prefix}.receipt.get`, pathTemplate: "/receipts/{receiptId}", params: [idParam("receiptId")], responseObject: "Receipt" }),
  // The fence: once the request's deadline has passed, the change stored under the id (no lag) or a FENCED id.
  {
    operationId: `${prefix}.change.fence`,
    kind: "WRITE",
    enabled: true,
    method: "POST",
    pathTemplate: "/change-requests/{requestId}/fence",
    idempotency: "EXTERNAL_ID_UPSERT",
    externalIdParam: "requestId",
    reconcileOperationId: `${prefix}.change.lookup`,
    capability: c.writeCapability,
    params: [idParam("requestId")],
    timeoutMs: c.writeTimeoutMs,
    pagination: NO_PAGINATION,
    rateBudget: { requestsPerSecond: 5, burst: 5, maxConcurrency: 4 },
    requiredScopes: [c.writeScope],
    responseObject: "ChangeRequest",
    recordsPointer: null,
    requestBody: { fields: [field("operation", "enum_code", "INTERNAL", 64), { ...NOT_AFTER, requirement: "REQUIRED" }] },
    successStatuses: [200],
  },
];

const metaOps = (c: OpCtx, prefix: string, system: string): ConnectorOperation[] => [
  read(c, { operationId: `${prefix}.consistency`, pathTemplate: `/meta/${system}/consistency`, responseObject: "Consistency" }),
  read(c, { operationId: `${prefix}.metadata`, pathTemplate: `/meta/${system}/metadata` }),
];

const DEFAULT_STREAM_DELETION = "RECONCILIATION_ONLY" as const;

const PLANS: Readonly<Record<SystemKey, Plan>> = {
  scheduling: {
    system: "scheduling",
    family: "business_system",
    egressClass: "PHI",
    api: "scheduling",
    readScope: "scheduling:read",
    writeScope: "scheduling:write",
    operations: (c) => [
      list(c, {
        operationId: "scheduling.appointments.list",
        pathTemplate: "/subjects/{subjectId}/appointments",
        params: [idParam("subjectId")],
        responseObject: "Appointment",
        pagination: { strategy: "CURSOR", maxPageSize: 50, maxPages: 20, pageSizeParam: "limit", cursorParam: "cursor", nextPointer: "/nextCursor", cursorExpiredStatus: null },
      }),
      read(c, { operationId: "scheduling.appointment.get", pathTemplate: "/appointments/{appointmentId}", params: [idParam("appointmentId")], responseObject: "Appointment" }),
      list(c, {
        operationId: "scheduling.slot_options.list",
        pathTemplate: "/subjects/{subjectId}/slot-options",
        params: [idParam("subjectId"), intQuery("days", 1, 62, true), idQuery("appointmentId")],
        responseObject: "Slot",
      }),
      list(c, { operationId: "scheduling.provider_slots.list", pathTemplate: "/providers/{providerId}/slots", params: [idParam("providerId"), intQuery("days", 1, 62, true)], responseObject: "Slot" }),
      read(c, { operationId: "scheduling.slot.get", pathTemplate: "/slots/{slotId}", params: [idParam("slotId")], responseObject: "Slot" }),
      keyedWrite(
        c,
        "scheduling.booking.put",
        "appointment-bookings",
        [field("subjectId", "opaque_id"), field("slotId", "opaque_id"), field("slotVersion", "string", "INTERNAL", 9), field("authority", "enum_code", "INTERNAL", 32), field("actingPartyId", "opaque_id")],
        "scheduling.change.lookup",
      ),
      keyedWrite(
        c,
        "scheduling.reschedule.put",
        "appointment-reschedules",
        [
          field("appointmentId", "opaque_id"),
          field("expectedVersion", "string", "INTERNAL", 9),
          field("slotId", "opaque_id"),
          field("slotVersion", "string", "INTERNAL", 9),
          field("authority", "enum_code", "INTERNAL", 32),
          field("actingPartyId", "opaque_id"),
        ],
        "scheduling.change.lookup",
      ),
      keyedWrite(
        c,
        "scheduling.cancellation.put",
        "appointment-cancellations",
        [
          field("appointmentId", "opaque_id"),
          field("expectedVersion", "string", "INTERNAL", 9),
          field("reasonCode", "enum_code", "INTERNAL", 32),
          field("authority", "enum_code", "INTERNAL", 32),
          field("actingPartyId", "opaque_id"),
        ],
        "scheduling.change.lookup",
      ),
      keyedWrite(
        c,
        "scheduling.availability_block.put",
        "availability-blocks",
        [
          field("providerId", "opaque_id"),
          field("slotId", "opaque_id"),
          field("slotVersion", "string", "INTERNAL", 9),
          field("reasonCode", "enum_code", "INTERNAL", 32),
          field("authority", "enum_code", "INTERNAL", 32),
          field("actingPartyId", "opaque_id"),
        ],
        "scheduling.change.lookup",
      ),
      ...changeOps(c, "scheduling"),
      ...metaOps(c, "scheduling", "scheduling"),
    ],
    mappings: [
      map("Appointment", "/id", "appointmentId", "opaque_id"),
      map("Appointment", "/subjectId", "subjectId", "opaque_id"),
      map("Appointment", "/providerId", "providerRef", "opaque_id"),
      map("Appointment", "/providerDisplayName", "providerDisplayName", "string", { classification: "PHI" }),
      map("Appointment", "/slotId", "slotId", "opaque_id", opt()),
      map("Appointment", "/startsAt", "startsAt", "instant", { classification: "PHI" }),
      map("Appointment", "/timeZone", "timeZone", "string"),
      map("Appointment", "/modality", "modality", "enum_code", { semantic: "enum:modality", classification: "PHI" }),
      map("Appointment", "/status", "status", "enum_code", { semantic: "enum:appointment_status", classification: "PHI" }),
      map("Appointment", "/version", "version", "opaque_id"),
      prohibited("Appointment", "/visitReason", "visitReason", "PHI_RESTRICTED"),
      map("Slot", "/id", "slotId", "opaque_id"),
      map("Slot", "/providerId", "providerRef", "opaque_id"),
      map("Slot", "/providerDisplayName", "providerDisplayName", "string", { classification: "PHI" }),
      map("Slot", "/startsAt", "startsAt", "instant"),
      map("Slot", "/timeZone", "timeZone", "string"),
      map("Slot", "/modality", "modality", "enum_code", { semantic: "enum:modality" }),
      map("Slot", "/state", "state", "enum_code", { semantic: "enum:slot_state" }),
      map("Slot", "/version", "version", "opaque_id"),
      ...changeRequestMappings(),
      ...receiptMappings(),
      ...consistencyMappings(),
    ],
    streams: [
      { streamId: "appointments", sourceObject: "Appointment", egressClass: "PHI" },
      { streamId: "slots", sourceObject: "Slot", egressClass: "PHI" },
      { streamId: "change_requests", sourceObject: "ChangeRequest", egressClass: "PHI" },
      { streamId: "receipts", sourceObject: "Receipt", egressClass: "INTERNAL" },
      { streamId: "consistency", sourceObject: "Consistency", egressClass: "INTERNAL", deletionBehavior: "NOT_SUPPORTED" },
    ],
    syntheticOperationId: "scheduling.appointment.get",
    syntheticParam: "appointmentId",
    tables: (input) => ({ enums: [...dialectTables(input.dialect), { tableId: "slot_state", entries: ["OPEN", "BOOKED", "BLOCKED"].map((s) => ({ from: s, to: s })) }], timeZones: [] }),
  },
  billing: {
    system: "billing",
    family: "business_system",
    egressClass: "PHI",
    api: "billing",
    readScope: "billing:read",
    writeScope: "billing:write",
    operations: (c) => [
      list(c, { operationId: "billing.invoices.list", pathTemplate: "/subjects/{subjectId}/invoices", params: [idParam("subjectId")], responseObject: "Invoice" }),
      read(c, { operationId: "billing.invoice.get", pathTemplate: "/invoices/{invoiceId}", params: [idParam("invoiceId")], responseObject: "Invoice" }),
      list(c, { operationId: "billing.invoice_lines.list", pathTemplate: "/invoices/{invoiceId}/lines", params: [idParam("invoiceId")], responseObject: "InvoiceLine" }),
      list(c, { operationId: "billing.payments.list", pathTemplate: "/invoices/{invoiceId}/payments", params: [idParam("invoiceId")], responseObject: "Payment" }),
      keyedWrite(
        c,
        "billing.review_request.put",
        "billing-review-requests",
        [
          field("invoiceId", "opaque_id"),
          field("expectedVersion", "string", "INTERNAL", 9),
          field("reasonCode", "enum_code", "INTERNAL", 32),
          field("authority", "enum_code", "INTERNAL", 32),
          field("actingPartyId", "opaque_id"),
        ],
        "billing.change.lookup",
      ),
      ...changeOps(c, "billing"),
      ...metaOps(c, "billing", "billing"),
    ],
    mappings: [
      map("Invoice", "/id", "invoiceId", "opaque_id"),
      map("Invoice", "/subjectId", "subjectId", "opaque_id"),
      map("Invoice", "/issuedOn", "issuedOn", "date", { classification: "FINANCIAL" }),
      map("Invoice", "/dueOn", "dueOn", "date", { classification: "FINANCIAL" }),
      map("Invoice", "/status", "status", "enum_code", { semantic: "enum:invoice_status", classification: "FINANCIAL" }),
      map("Invoice", "/balanceMinor", "balanceMinor", "money_minor_units", { classification: "FINANCIAL" }),
      map("Invoice", "/currency", "currency", "currency_code", { classification: "FINANCIAL" }),
      map("Invoice", "/version", "version", "opaque_id"),
      map("InvoiceLine", "/lineId", "lineId", "opaque_id"),
      map("InvoiceLine", "/code", "code", "enum_code", { semantic: "enum:invoice_line_code", classification: "FINANCIAL" }),
      map("InvoiceLine", "/serviceDate", "serviceDate", "date", { classification: "PHI" }),
      map("InvoiceLine", "/amountMinor", "amountMinor", "money_minor_units", { classification: "FINANCIAL" }),
      map("Payment", "/paymentId", "paymentId", "opaque_id"),
      map("Payment", "/invoiceId", "invoiceId", "opaque_id"),
      map("Payment", "/amountMinor", "amountMinor", "money_minor_units", { classification: "FINANCIAL" }),
      map("Payment", "/receivedAt", "receivedAt", "instant", { classification: "FINANCIAL" }),
      map("Payment", "/method", "method", "enum_code", { semantic: "enum:payment_method", classification: "FINANCIAL" }),
      prohibited("Payment", "/cardLast4", "cardLast4", "FINANCIAL"),
      ...changeRequestMappings(),
      ...receiptMappings(),
      ...consistencyMappings(),
    ],
    streams: [
      { streamId: "invoices", sourceObject: "Invoice", egressClass: "FINANCIAL" },
      { streamId: "invoice_lines", sourceObject: "InvoiceLine", egressClass: "PHI" },
      { streamId: "payments", sourceObject: "Payment", egressClass: "FINANCIAL" },
      { streamId: "change_requests", sourceObject: "ChangeRequest", egressClass: "PHI" },
      { streamId: "receipts", sourceObject: "Receipt", egressClass: "INTERNAL" },
      { streamId: "consistency", sourceObject: "Consistency", egressClass: "INTERNAL", deletionBehavior: "NOT_SUPPORTED" },
    ],
    syntheticOperationId: "billing.invoice.get",
    syntheticParam: "invoiceId",
    tables: () => ({
      enums: [
        { tableId: "invoice_status", entries: ["OPEN", "PAID", "IN_REVIEW", "VOID"].map((s) => ({ from: s, to: s })) },
        { tableId: "invoice_line_code", entries: ["SESSION_FEE", "LATE_CANCELLATION", "NO_SHOW", "ADJUSTMENT", "PAYMENT"].map((s) => ({ from: s, to: s })) },
        { tableId: "payment_method", entries: ["CARD", "ACH", "CHECK", "PORTAL"].map((s) => ({ from: s, to: s })) },
      ],
      timeZones: [],
    }),
  },
  claims: {
    system: "claims",
    family: "business_system",
    egressClass: "PHI",
    api: "claims",
    readScope: "claims:read",
    writeScope: null,
    operations: (c) => [
      list(c, { operationId: "claims.list", pathTemplate: "/subjects/{subjectId}/claims", params: [idParam("subjectId")], responseObject: "Claim" }),
      read(c, { operationId: "claims.get", pathTemplate: "/claims/{claimId}", params: [idParam("claimId")], responseObject: "Claim" }),
      ...metaOps(c, "claims", "claims"),
    ],
    mappings: [
      map("Claim", "/id", "claimId", "opaque_id"),
      map("Claim", "/subjectId", "subjectId", "opaque_id"),
      map("Claim", "/serviceDate", "serviceDate", "date", { classification: "PHI" }),
      map("Claim", "/payerDisplayName", "payerDisplayName", "string", { classification: "PHI" }),
      map("Claim", "/insurerStatus", "insurerStatus", "enum_code", { semantic: "enum:claim_status", classification: "PHI" }),
      map("Claim", "/statusAsOf", "statusAsOf", "instant"),
      prohibited("Claim", "/diagnosisCodes", "diagnosisCodes", "PHI_RESTRICTED"),
      ...consistencyMappings(),
    ],
    streams: [
      { streamId: "claims", sourceObject: "Claim", egressClass: "PHI" },
      { streamId: "consistency", sourceObject: "Consistency", egressClass: "INTERNAL", deletionBehavior: "NOT_SUPPORTED" },
    ],
    syntheticOperationId: "claims.get",
    syntheticParam: "claimId",
    tables: () => ({
      enums: [{ tableId: "claim_status", entries: ["RECEIVED", "IN_PROCESS", "ADJUDICATED_PAID", "ADJUDICATED_DENIED", "NEEDS_INFORMATION"].map((s) => ({ from: s, to: s })) }],
      timeZones: [],
    }),
  },
  provider: {
    system: "provider",
    family: "business_system",
    egressClass: "FINANCIAL",
    api: "provider-network",
    readScope: "provider:read",
    writeScope: null,
    operations: (c) => [
      read(c, { operationId: "provider.onboarding.get", pathTemplate: "/providers/{providerId}/onboarding", params: [idParam("providerId")], responseObject: "Onboarding" }),
      list(c, { operationId: "provider.documents.list", pathTemplate: "/providers/{providerId}/onboarding/documents", params: [idParam("providerId")], responseObject: "OnboardingDocument" }),
      list(c, {
        operationId: "provider.remittances.list",
        pathTemplate: "/practices/{practiceId}/remittances",
        params: [idParam("practiceId"), intQuery("periods", 1, 24, true)],
        responseObject: "Remittance",
      }),
      ...metaOps(c, "provider", "provider"),
    ],
    mappings: [
      map("Onboarding", "/providerId", "providerId", "opaque_id"),
      map("Onboarding", "/stage", "stage", "enum_code", { semantic: "enum:onboarding_stage" }),
      map("Onboarding", "/asOf", "asOf", "instant"),
      map("Onboarding", "/organizationId", "organizationId", "opaque_id", opt()),
      map("OnboardingDocument", "/documentType", "documentType", "enum_code", { semantic: "enum:document_type" }),
      map("OnboardingDocument", "/status", "status", "enum_code", { semantic: "enum:document_status" }),
      map("OnboardingDocument", "/updatedAt", "updatedAt", "instant"),
      map("Remittance", "/id", "remittanceId", "opaque_id"),
      map("Remittance", "/practiceId", "practiceId", "opaque_id"),
      map("Remittance", "/periodStart", "periodStart", "date", { classification: "FINANCIAL" }),
      map("Remittance", "/periodEnd", "periodEnd", "date", { classification: "FINANCIAL" }),
      map("Remittance", "/totalMinor", "totalMinor", "money_minor_units", { classification: "FINANCIAL" }),
      map("Remittance", "/status", "status", "enum_code", { semantic: "enum:remittance_status", classification: "FINANCIAL" }),
      map("Remittance", "/paidOn", "paidOn", "date", opt({ classification: "FINANCIAL" })),
      prohibited("Remittance", "/bankAccountLast4", "bankAccountLast4", "FINANCIAL"),
      ...consistencyMappings(),
    ],
    streams: [
      { streamId: "onboarding", sourceObject: "Onboarding", egressClass: "INTERNAL" },
      { streamId: "onboarding_documents", sourceObject: "OnboardingDocument", egressClass: "INTERNAL" },
      { streamId: "remittances", sourceObject: "Remittance", egressClass: "FINANCIAL" },
      { streamId: "consistency", sourceObject: "Consistency", egressClass: "INTERNAL", deletionBehavior: "NOT_SUPPORTED" },
    ],
    syntheticOperationId: "provider.onboarding.get",
    syntheticParam: "providerId",
    tables: () => ({
      enums: [
        { tableId: "onboarding_stage", entries: ["APPLICATION_RECEIVED", "DOCUMENTS_PENDING", "CREDENTIALING_IN_REVIEW", "CONTRACTING", "ACTIVE", "ON_HOLD"].map((s) => ({ from: s, to: s })) },
        { tableId: "document_type", entries: ["LICENSE", "MALPRACTICE_INSURANCE", "W9", "DEA", "BOARD_CERTIFICATION"].map((s) => ({ from: s, to: s })) },
        { tableId: "document_status", entries: ["RECEIVED", "MISSING", "EXPIRED", "IN_REVIEW", "ACCEPTED"].map((s) => ({ from: s, to: s })) },
        { tableId: "remittance_status", entries: ["SCHEDULED", "SENT", "RETURNED"].map((s) => ({ from: s, to: s })) },
      ],
      timeZones: [],
    }),
  },
  referrals: {
    system: "referrals",
    family: "business_system",
    egressClass: "PHI",
    api: "referrals",
    readScope: "referrals:read",
    writeScope: null,
    operations: (c) => [
      list(c, { operationId: "referrals.list", pathTemplate: "/subjects/{subjectId}/referrals", params: [idParam("subjectId")], responseObject: "Referral" }),
      read(c, { operationId: "referrals.get", pathTemplate: "/referrals/{referralId}", params: [idParam("referralId")], responseObject: "Referral" }),
      list(c, { operationId: "referrals.authorizations.list", pathTemplate: "/subjects/{subjectId}/authorizations", params: [idParam("subjectId")], responseObject: "Authorization" }),
      read(c, { operationId: "referrals.eligibility.get", pathTemplate: "/subjects/{subjectId}/eligibility", params: [idParam("subjectId")], responseObject: "Eligibility" }),
      ...metaOps(c, "referrals", "referrals"),
    ],
    mappings: [
      map("Referral", "/id", "referralId", "opaque_id"),
      map("Referral", "/subjectId", "subjectId", "opaque_id"),
      map("Referral", "/specialtyCode", "specialtyCode", "enum_code", { classification: "PHI" }),
      map("Referral", "/status", "status", "enum_code", { semantic: "enum:referral_status", classification: "PHI" }),
      map("Referral", "/statusAsOf", "statusAsOf", "instant"),
      map("Referral", "/receivedOn", "receivedOn", "date", { classification: "PHI" }),
      map("Referral", "/referringOrganizationId", "referringOrganizationId", "opaque_id", opt()),
      prohibited("Referral", "/clinicalSummary", "clinicalSummary", "PHI_RESTRICTED"),
      map("Authorization", "/id", "authorizationId", "opaque_id"),
      map("Authorization", "/subjectId", "subjectId", "opaque_id"),
      map("Authorization", "/payerDisplayName", "payerDisplayName", "string", { classification: "PHI" }),
      map("Authorization", "/serviceCode", "serviceCode", "enum_code", { classification: "PHI" }),
      map("Authorization", "/status", "status", "enum_code", { semantic: "enum:authorization_status", classification: "PHI" }),
      map("Authorization", "/unitsApproved", "unitsApproved", "integer", opt({ classification: "PHI" })),
      map("Authorization", "/unitsUsed", "unitsUsed", "integer", opt({ classification: "PHI" })),
      map("Authorization", "/validFrom", "validFrom", "date", opt({ classification: "PHI" })),
      map("Authorization", "/validTo", "validTo", "date", opt({ classification: "PHI" })),
      map("Authorization", "/statusAsOf", "statusAsOf", "instant"),
      map("Eligibility", "/subjectId", "subjectId", "opaque_id"),
      map("Eligibility", "/payerDisplayName", "payerDisplayName", "string", { classification: "PHI" }),
      map("Eligibility", "/coverageStatus", "coverageStatus", "enum_code", { semantic: "enum:coverage_status", classification: "PHI" }),
      map("Eligibility", "/verifiedAt", "verifiedAt", "instant"),
      prohibited("Eligibility", "/memberReference", "memberReference", "PHI_RESTRICTED"),
      ...consistencyMappings(),
    ],
    streams: [
      { streamId: "referrals", sourceObject: "Referral", egressClass: "PHI" },
      { streamId: "authorizations", sourceObject: "Authorization", egressClass: "PHI" },
      { streamId: "eligibility", sourceObject: "Eligibility", egressClass: "PHI" },
      { streamId: "consistency", sourceObject: "Consistency", egressClass: "INTERNAL", deletionBehavior: "NOT_SUPPORTED" },
    ],
    syntheticOperationId: "referrals.get",
    syntheticParam: "referralId",
    tables: () => ({
      enums: [
        { tableId: "referral_status", entries: ["RECEIVED", "IN_REVIEW", "ACCEPTED", "DECLINED", "SCHEDULED", "CLOSED"].map((s) => ({ from: s, to: s })) },
        { tableId: "authorization_status", entries: ["PENDING", "APPROVED", "DENIED", "EXPIRED"].map((s) => ({ from: s, to: s })) },
        { tableId: "coverage_status", entries: ["ACTIVE", "INACTIVE", "NOT_FOUND_AT_PAYER"].map((s) => ({ from: s, to: s })) },
      ],
      timeZones: [],
    }),
  },
  legacy: {
    system: "scheduling",
    family: "business_system",
    egressClass: "PHI",
    api: "legacy-scheduling",
    readScope: "legacy:read",
    writeScope: "legacy:write",
    operations: (c) => [
      {
        operationId: "legacy.appointment.post",
        kind: "WRITE",
        enabled: true,
        method: "POST",
        pathTemplate: "/legacy/appointments/{externalRef}",
        // The legacy product creates another appointment on every delivery: never retried after send; an unknown
        // outcome is reconciled through the by-reference lookup (FO-06-75).
        idempotency: "NOT_IDEMPOTENT_RECONCILE_REQUIRED",
        reconcileOperationId: "legacy.appointments.by_reference",
        capability: c.writeCapability,
        params: [idParam("externalRef")],
        timeoutMs: c.writeTimeoutMs,
        pagination: NO_PAGINATION,
        rateBudget: { requestsPerSecond: 2, burst: 2, maxConcurrency: 2 },
        requiredScopes: [c.writeScope],
        responseObject: "LegacyAppointment",
        recordsPointer: null,
        requestBody: {
          fields: [
            field("clientRef", "opaque_id"),
            field("providerRef", "opaque_id"),
            { targetPointer: "/startLocal", inputField: "startLocal", type: "string", requirement: "REQUIRED", classification: "PHI", maxLength: 16 },
            field("modeCode", "enum_code", "PHI", 8),
            NOT_AFTER,
            { ...field("dispatchId", "opaque_id"), requirement: "OPTIONAL" },
          ],
        },
        successStatuses: [200, 201],
      },
      // The dispatch marker: the create runs only under the dispatch's own reservation of the reference.
      referenceWrite(c, "legacy.reference.reserve", "PUT", "", [field("dispatchId", "opaque_id"), NOT_AFTER]),
      referenceWrite(c, "legacy.reference.release", "POST", "/release", [field("dispatchId", "opaque_id")]),
      // The proof of absence once the create's deadline has passed: POSTED, or FENCED (nothing can be created).
      referenceWrite(c, "legacy.reference.fence", "POST", "/fence", [{ ...NOT_AFTER, requirement: "REQUIRED" }]),
      list(c, {
        operationId: "legacy.appointments.by_reference",
        kind: "RECONCILE_LOOKUP",
        pathTemplate: "/legacy/appointments/by-reference/{externalRef}",
        params: [idParam("externalRef")],
        responseObject: "LegacyAppointment",
      }),
      read(c, { operationId: "legacy.appointment.get", pathTemplate: "/legacy/appointments/{apptRef}", params: [idParam("apptRef")], responseObject: "LegacyAppointment" }),
      ...metaOps(c, "legacy", "legacy"),
    ],
    mappings: [
      map("LegacyAppointment", "/apptRef", "appointmentId", "opaque_id"),
      map("LegacyAppointment", "/clientRef", "subjectId", "opaque_id"),
      map("LegacyAppointment", "/providerRef", "providerRef", "opaque_id"),
      // Wall-clock local time of the tenant's business zone -> UTC instant (DSL zone table).
      map("LegacyAppointment", "/startLocal", "startsAt", "instant", { semantic: "zone:business", classification: "PHI" }),
      map("LegacyAppointment", "/modeCode", "modality", "enum_code", { semantic: "enum:modality", classification: "PHI" }),
      map("LegacyAppointment", "/state", "status", "enum_code", { semantic: "enum:appointment_status", classification: "PHI" }),
      map("LegacyAppointment", "/rev", "version", "opaque_id"),
      map("LegacyAppointment", "/externalRef", "externalRef", "opaque_id", opt()),
      ...referenceMappings(),
      ...consistencyMappings(),
    ],
    streams: [
      { streamId: "legacy_appointments", sourceObject: "LegacyAppointment", egressClass: "PHI" },
      { streamId: "legacy_references", sourceObject: "LegacyReference", egressClass: "INTERNAL", deletionBehavior: "NOT_SUPPORTED" },
      { streamId: "consistency", sourceObject: "Consistency", egressClass: "INTERNAL", deletionBehavior: "NOT_SUPPORTED" },
    ],
    syntheticOperationId: "legacy.appointment.get",
    syntheticParam: "apptRef",
    tables: (input) => {
      if (input.businessTimeZone === undefined) throw new Error("LEGACY_PROFILE_ZONE_REQUIRED");
      return { enums: dialectTables("legacy_codes"), timeZones: [{ zoneKey: "business", ianaZone: input.businessTimeZone }] };
    },
  },
};

/**
 * Capability ids of a system: reads (lookups included) and writes are separate capabilities with separate
 * least-privilege credentials, so a read capability can be READY while the write capability still waits for its
 * sandbox write-and-reconcile qualification (FO-06-11, FO-05-56).
 */
export const capabilityOf = (key: SystemKey, access: "read" | "write"): string => `domain.${key}.${access}`;

/** The reviewed reference-API ConnectorProfile of one system, with its configuration digest (admit before use). */
export function referenceProfile(key: SystemKey, input: ReferenceProfileInput): ConnectorProfile {
  const plan = PLANS[key];
  const writes = plan.writeScope !== null && input.writeMode !== "READ_ONLY";
  if (writes && input.writeCredentialRef === null) throw new Error("WRITE_CREDENTIAL_REQUIRED");
  const c: OpCtx = {
    readCapability: capabilityOf(key, "read"),
    writeCapability: capabilityOf(key, "write"),
    readScope: plan.readScope,
    writeScope: plan.writeScope ?? plan.readScope,
    readTimeoutMs: input.readTimeoutMs ?? 2_500,
    writeTimeoutMs: input.writeTimeoutMs ?? 5_000,
  };
  const operations = plan.operations(c).map((o) => {
    if (o.kind !== "WRITE") return o;
    if (!writes) return { ...o, enabled: false };
    if (o.operationId === "scheduling.availability_block.put" && input.availabilityBlocks === false) return { ...o, enabled: false };
    return o;
  });
  const base: Omit<ConnectorProfile, "configDigest"> = {
    schemaVersion: "connector-profile.v1",
    tenantId: input.tenantId,
    occurredAt: input.occurredAt,
    causationId: null,
    profileId: input.profileId,
    profileVersion: input.profileVersion ?? 1,
    family: plan.family,
    system: plan.system,
    vendor: { name: "reference", api: plan.api, apiVersion: API_VERSION },
    baseUrl: `https://${input.host}/api/v1`,
    allowedHosts: [input.host],
    scopes: plan.writeScope === null ? [plan.readScope] : [plan.readScope, plan.writeScope],
    credentialRef: input.readCredentialRef,
    region: input.region,
    accountBinding: { externalAccountRef: input.externalAccountRef, tenantBindingVerified: true },
    writeMode: writes ? input.writeMode : "READ_ONLY",
    operations,
    mappings: plan.mappings,
    eventSchema: null,
    pagination: { strategy: "CURSOR", maxPageSize: 100 },
    limits: { requestsPerSecond: 50, maxConcurrency: 16, timeoutMs: CONNECTOR_TIMEOUT_MS, retryBudget: input.retryBudget ?? 1 },
    deletionBehavior: DEFAULT_STREAM_DELETION,
    retentionClass: "BUSINESS_RECORD",
    egressClass: plan.egressClass,
    documentationUrl: `https://${input.host}/api/v1/meta/${key === "legacy" ? "legacy" : plan.system}/metadata`,
    ownerRole: "integration_owner",
    capabilityEvidenceRefs: [],
    auth: { scheme: "OAUTH2_CLIENT_CREDENTIALS", tokenUrl: `https://${input.host}/oauth/token`, clientAuth: "CLIENT_SECRET_POST", audience: null, tokenMaxAgeSeconds: 900, apiKeyHeader: null },
    capabilityCredentials: [
      { capability: c.readCapability, access: "READ", credentialRef: input.readCredentialRef, scopes: [plan.readScope] },
      ...(writes && plan.writeScope !== null && input.writeCredentialRef !== null ? [{ capability: c.writeCapability, access: "WRITE" as const, credentialRef: input.writeCredentialRef, scopes: [plan.writeScope] }] : []),
    ],
    streams: plan.streams.map((s) => ({
      streamId: s.streamId,
      sourceObject: s.sourceObject,
      deletionBehavior: s.deletionBehavior ?? DEFAULT_STREAM_DELETION,
      retentionClass: "BUSINESS_RECORD",
      egressClass: s.egressClass,
      vendorDeletionOperationId: null,
      eventSchema: null,
    })),
    health: {
      metadataOperationId: `${key}.metadata`,
      metadataFormat: "JSON_SCHEMA",
      syntheticRecord: input.syntheticRecordId === null ? null : { operationId: plan.syntheticOperationId, params: [{ name: plan.syntheticParam, value: input.syntheticRecordId }] },
    },
    network: { addressClass: input.addressClass, tlsCaRef: input.tlsCaRef },
    bindingVerification: { account: { source: "TOKEN_RESPONSE", locator: "/account_id" }, region: { source: "TOKEN_RESPONSE", locator: "/region" } },
    mappingTables: plan.tables(input),
    usageHeaders: null,
  };
  return { ...base, configDigest: computeConnectorProfileDigest(base) };
}

/** Contract of each reference system. */
export const CONTRACT_OF: Readonly<Record<SystemKey, DomainContract>> = Object.freeze({
  scheduling: "scheduling.v1",
  billing: "billing.v1",
  claims: "claims.v1",
  provider: "provider.v1",
  referrals: "referrals.v1",
  legacy: "scheduling.legacy.v1",
});

const OPERATIONS_OF: Readonly<Record<SystemKey, Readonly<Record<string, string>>>> = Object.freeze({
  scheduling: {
    listAppointments: "scheduling.appointments.list",
    getAppointment: "scheduling.appointment.get",
    listSlotOptions: "scheduling.slot_options.list",
    listProviderSlots: "scheduling.provider_slots.list",
    getSlot: "scheduling.slot.get",
    book: "scheduling.booking.put",
    reschedule: "scheduling.reschedule.put",
    cancel: "scheduling.cancellation.put",
    blockAvailability: "scheduling.availability_block.put",
    lookupChange: "scheduling.change.lookup",
    completeChange: "scheduling.change.complete",
    fenceChange: "scheduling.change.fence",
    getReceipt: "scheduling.receipt.get",
    consistency: "scheduling.consistency",
  },
  billing: {
    listInvoices: "billing.invoices.list",
    getInvoice: "billing.invoice.get",
    listInvoiceLines: "billing.invoice_lines.list",
    listPayments: "billing.payments.list",
    requestReview: "billing.review_request.put",
    lookupChange: "billing.change.lookup",
    completeChange: "billing.change.complete",
    fenceChange: "billing.change.fence",
    getReceipt: "billing.receipt.get",
    consistency: "billing.consistency",
  },
  claims: { listClaims: "claims.list", getClaim: "claims.get", consistency: "claims.consistency" },
  provider: { getOnboarding: "provider.onboarding.get", listDocuments: "provider.documents.list", listRemittances: "provider.remittances.list", consistency: "provider.consistency" },
  referrals: {
    listReferrals: "referrals.list",
    getReferral: "referrals.get",
    listAuthorizations: "referrals.authorizations.list",
    getEligibility: "referrals.eligibility.get",
    consistency: "referrals.consistency",
  },
  legacy: {
    createAppointment: "legacy.appointment.post",
    reserveReference: "legacy.reference.reserve",
    releaseReference: "legacy.reference.release",
    fenceReference: "legacy.reference.fence",
    lookupByReference: "legacy.appointments.by_reference",
    getAppointment: "legacy.appointment.get",
    consistency: "legacy.consistency",
  },
});

export interface ReferenceBindingInput {
  bindingId: string;
  /** The system's documented visibility window of its lookup (the capability test checks the system reports no more). */
  visibilityWindowMs: number;
  clockSkewAllowanceMs: number;
  incompleteWrite?: "COMPLETE_BY_REQUEST_ID" | "ROUTE_TO_HUMAN";
  /** The reference API enforces the dispatch deadline (default); NONE describes a system that does not. */
  dispatchDeadline?: "REQUEST_NOT_AFTER" | "NONE";
  /** The reference API offers fences (default: with the dispatch deadline); false describes a system without one. */
  fence?: boolean;
  /** Tenant-approved hosted payment page path (billing only). */
  paymentPortalPath?: string;
}

/** The domain binding of a reference profile (admit with `admitBinding` against the admitted profile). */
export function referenceBinding(key: SystemKey, profile: ConnectorProfile, input: ReferenceBindingInput): DomainBinding {
  const ops: Record<string, string> = { ...OPERATIONS_OF[key] };
  const enabled = new Set(profile.operations.filter((o) => o.enabled).map((o) => o.operationId));
  // An optional operation the tenant does not offer is left out of the binding (blockAvailability, a fence).
  if (ops.blockAvailability !== undefined && !enabled.has(ops.blockAvailability)) delete ops.blockAvailability;
  const fenceName = key === "legacy" ? "fenceReference" : "fenceChange";
  // A fence needs the dispatch deadline (the system accepts it only once the deadline has passed).
  const fenced = input.fence ?? input.dispatchDeadline !== "NONE";
  if (!fenced || (ops[fenceName] !== undefined && !enabled.has(ops[fenceName]))) delete ops[fenceName];
  const fence = ops[fenceName] ?? null;
  const writes = profile.operations.some((o) => o.enabled && o.kind === "WRITE");
  const lookup = key === "legacy" ? ops.lookupByReference : ops.lookupChange;
  return {
    bindingId: input.bindingId,
    contract: CONTRACT_OF[key],
    connectorProfileId: profile.profileId,
    operations: ops,
    reconciliation:
      writes && lookup !== undefined
        ? {
            lookupOperationId: lookup,
            completionOperationId: key === "legacy" ? null : (ops.completeChange ?? null),
            visibilityWindowMs: input.visibilityWindowMs,
            clockSkewAllowanceMs: input.clockSkewAllowanceMs,
            incompleteWrite: key === "legacy" ? "ROUTE_TO_HUMAN" : (input.incompleteWrite ?? "COMPLETE_BY_REQUEST_ID"),
            dispatchDeadline: input.dispatchDeadline ?? "REQUEST_NOT_AFTER",
            // The legacy product keeps no change-request record (no digest); the keyed contracts document one.
            requestDigest: key === "legacy" ? null : "REFBIZ_REQUEST_V1",
            fenceOperationId: fence,
            dispatchReservation:
              key === "legacy" && ops.reserveReference !== undefined && ops.releaseReference !== undefined ? { reserveOperationId: ops.reserveReference, releaseOperationId: ops.releaseReference } : null,
          }
        : null,
    paymentPortalPath: key === "billing" ? (input.paymentPortalPath ?? null) : null,
  };
}

export type { SystemKey as ReferenceSystem };
