/**
 * SYNTHETIC ConnectorProfile of the emulated reference vendor (emulator.ts), shared by the connector
 * runtime's unit tests (Layer 1) and its Layer-2 suite. Configuration data, not a fake: the profile is
 * admitted by the production admission rules and drives the production runtime. Hosts are under the
 * reserved `.test` TLD and reach the emulator only through an explicit local/ci loopback route.
 */
import type { ConnectorOperation, ConnectorProfile } from "../../../src/protocol/connector.js";
import { computeConnectorProfileDigest } from "../../../src/protocol/digests.js";
import type { EgressPolicyConfig } from "../../../src/privacy/egress.js";

export const API_HOST = "api.vendor.emulator.test";
export const AUTH_HOST = "auth.vendor.emulator.test";
export const TENANT_ID = "tnt_synthTenantConnector01";
export const PROFILE_ID = "cnp_synthEmulatedVendor01";
export const READ_CAPABILITY = "scheduling.appointments_read";
export const WRITE_CAPABILITY = "scheduling.appointments_write";

const readOp = (o: Partial<ConnectorOperation> & Pick<ConnectorOperation, "operationId" | "pathTemplate">): ConnectorOperation => ({
  kind: "READ",
  enabled: true,
  method: "GET",
  idempotency: "NATURALLY_IDEMPOTENT",
  reconcileOperationId: null,
  capability: READ_CAPABILITY,
  params: [],
  timeoutMs: 2_000,
  pagination: { strategy: "NONE", maxPageSize: 1, maxPages: 1, pageSizeParam: null, cursorParam: null, nextPointer: null, cursorExpiredStatus: null },
  rateBudget: { requestsPerSecond: 50, burst: 50, maxConcurrency: 8 },
  requiredScopes: ["appointments:read"],
  responseObject: "Appointment",
  recordsPointer: null,
  successStatuses: [200],
  ...o,
});

const appointmentIdParam = { name: "appointmentId", in: "path" as const, wireName: null, type: "opaque_id" as const, required: true, maxLength: 64, enumValues: null, integerRange: null };

export interface ProfileOptions {
  readRef: string;
  writeRef: string;
  writeMode?: ConnectorProfile["writeMode"];
  limits?: Partial<ConnectorProfile["limits"]>;
  listRateBudget?: ConnectorOperation["rateBudget"];
  listMaxPages?: number;
  binding?: ConnectorProfile["bindingVerification"];
  auth?: Partial<NonNullable<ConnectorProfile["auth"]>>;
  mutate?: (p: Omit<ConnectorProfile, "configDigest">) => Omit<ConnectorProfile, "configDigest">;
}

/** The emulated vendor's profile, with its configuration digest computed (admissible as is). */
export function emulatorProfile(o: ProfileOptions): ConnectorProfile {
  const base: Omit<ConnectorProfile, "configDigest"> = {
    schemaVersion: "connector-profile.v1",
    tenantId: TENANT_ID,
    occurredAt: "2026-10-19T00:00:00.000Z",
    causationId: null,
    profileId: PROFILE_ID,
    profileVersion: 1,
    family: "business_system",
    system: "scheduling",
    vendor: { name: "reference", api: "scheduling-api", apiVersion: "2026-09-01" },
    baseUrl: `https://${API_HOST}/api/v1`,
    allowedHosts: [API_HOST, AUTH_HOST],
    scopes: ["appointments:read", "appointments:write"],
    credentialRef: o.readRef,
    region: "us-east-1",
    accountBinding: { externalAccountRef: "acct-emulated-001", tenantBindingVerified: true },
    writeMode: o.writeMode ?? "SANDBOX_WRITE",
    operations: [
      readOp({
        operationId: "appointments.list",
        pathTemplate: "/appointments",
        pagination: { strategy: "CURSOR", maxPageSize: 10, maxPages: o.listMaxPages ?? 5, pageSizeParam: "limit", cursorParam: "cursor", nextPointer: "/nextCursor", cursorExpiredStatus: 410 },
        recordsPointer: "/items",
        ...(o.listRateBudget ? { rateBudget: o.listRateBudget } : {}),
      }),
      readOp({ operationId: "appointments.get", pathTemplate: "/appointments/{appointmentId}", params: [appointmentIdParam] }),
      readOp({
        operationId: "appointments.changes",
        pathTemplate: "/changes",
        pagination: { strategy: "CURSOR", maxPageSize: 5, maxPages: 100, pageSizeParam: "limit", cursorParam: "cursor", nextPointer: "/nextCursor", cursorExpiredStatus: null },
        recordsPointer: "/items",
      }),
      readOp({ operationId: "appointments.metadata", pathTemplate: "/metadata/appointments", responseObject: null }),
      {
        operationId: "appointments.upsert",
        kind: "WRITE",
        enabled: true,
        method: "PUT",
        pathTemplate: "/appointments/{appointmentId}",
        idempotency: "IDEMPOTENCY_KEY_HEADER",
        reconcileOperationId: "appointments.lookup",
        capability: WRITE_CAPABILITY,
        params: [appointmentIdParam],
        timeoutMs: 1_000,
        pagination: { strategy: "NONE", maxPageSize: 1, maxPages: 1, pageSizeParam: null, cursorParam: null, nextPointer: null, cursorExpiredStatus: null },
        rateBudget: { requestsPerSecond: 20, burst: 20, maxConcurrency: 4 },
        idempotencyKeyHeader: "Idempotency-Key",
        requiredScopes: ["appointments:write"],
        responseObject: "Appointment",
        recordsPointer: null,
        requestBody: {
          fields: [
            { targetPointer: "/status", inputField: "status", type: "enum_code", requirement: "REQUIRED", classification: "PHI", maxLength: 32 },
            { targetPointer: "/startsAt", inputField: "startsAt", type: "instant", requirement: "REQUIRED", classification: "PHI", maxLength: 40 },
          ],
        },
        successStatuses: [200, 201],
      },
      readOp({ operationId: "appointments.lookup", kind: "RECONCILE_LOOKUP", pathTemplate: "/appointments/{appointmentId}", params: [appointmentIdParam] }),
      {
        operationId: "appointments.cancel",
        kind: "WRITE",
        enabled: false,
        method: "DELETE",
        pathTemplate: "/appointments/{appointmentId}",
        idempotency: "NATURALLY_IDEMPOTENT",
        reconcileOperationId: null,
        params: [appointmentIdParam],
      },
    ],
    mappings: [
      { sourceObject: "Appointment", sourcePointer: "/id", targetField: "appointmentId", requirement: "REQUIRED", type: "opaque_id", semantic: null, authoritative: true, classification: "INTERNAL" },
      { sourceObject: "Appointment", sourcePointer: "/status", targetField: "status", requirement: "REQUIRED", type: "enum_code", semantic: "enum:appointment_status", authoritative: true, classification: "PHI" },
      { sourceObject: "Appointment", sourcePointer: "/startsAt", targetField: "startsAt", requirement: "REQUIRED", type: "instant", semantic: null, authoritative: true, classification: "PHI" },
      { sourceObject: "Appointment", sourcePointer: "/durationMinutes", targetField: "durationSeconds", requirement: "OPTIONAL", type: "integer", semantic: "unit:minutes:seconds", authoritative: false, classification: "INTERNAL" },
      { sourceObject: "Appointment", sourcePointer: "/feeMajor", targetField: "feeMinor", requirement: "OPTIONAL", type: "money_minor_units", semantic: "unit:major_units:minor_units", authoritative: false, classification: "FINANCIAL" },
      { sourceObject: "Appointment", sourcePointer: "/updatedAt", targetField: "updatedAt", requirement: "OPTIONAL", type: "instant", semantic: null, authoritative: false, classification: "INTERNAL" },
      { sourceObject: "Appointment", sourcePointer: "/seq", targetField: "sequence", requirement: "OPTIONAL", type: "integer", semantic: null, authoritative: false, classification: "INTERNAL" },
      { sourceObject: "Appointment", sourcePointer: "/clinicalNotes", targetField: "clinicalNotes", requirement: "PROHIBITED", type: "string", semantic: null, authoritative: false, classification: "PHI_RESTRICTED" },
    ],
    eventSchema: null,
    pagination: { strategy: "CURSOR", maxPageSize: 100 },
    limits: { requestsPerSecond: 50, maxConcurrency: 8, timeoutMs: 2_000, retryBudget: 1, ...o.limits },
    deletionBehavior: "TOMBSTONE",
    retentionClass: "BUSINESS_RECORD",
    egressClass: "PHI",
    documentationUrl: `https://${API_HOST}/docs`,
    ownerRole: "integration_owner",
    capabilityEvidenceRefs: [],
    auth: { scheme: "OAUTH2_CLIENT_CREDENTIALS", tokenUrl: `https://${AUTH_HOST}/oauth/token`, clientAuth: "CLIENT_SECRET_POST", audience: null, tokenMaxAgeSeconds: 900, apiKeyHeader: null, ...o.auth },
    capabilityCredentials: [
      { capability: READ_CAPABILITY, access: "READ", credentialRef: o.readRef, scopes: ["appointments:read"] },
      { capability: WRITE_CAPABILITY, access: "WRITE", credentialRef: o.writeRef, scopes: ["appointments:write"] },
    ],
    streams: [
      { streamId: "appointments", sourceObject: "Appointment", deletionBehavior: "TOMBSTONE", retentionClass: "BUSINESS_RECORD", egressClass: "PHI", vendorDeletionOperationId: null, eventSchema: { schemaRef: "reference.appointment.changed", version: "1" } },
    ],
    health: { metadataOperationId: "appointments.metadata", metadataFormat: "JSON_SCHEMA", syntheticRecord: { operationId: "appointments.get", params: [{ name: "appointmentId", value: "apt-00001" }] } },
    network: { addressClass: "PUBLIC_INTERNET", tlsCaRef: null },
    bindingVerification: o.binding ?? { account: { source: "TOKEN_RESPONSE", locator: "/instance_id" }, region: { source: "RESPONSE_HEADER", locator: "x-region" } },
    mappingTables: {
      enums: [{ tableId: "appointment_status", entries: [{ from: "booked", to: "BOOKED" }, { from: "cancelled", to: "CANCELLED" }, { from: "completed", to: "COMPLETED" }] }],
      timeZones: [],
    },
    usageHeaders: { remaining: "RateLimit-Remaining", limit: "RateLimit-Limit" },
  };
  const p = o.mutate ? o.mutate(base) : base;
  return { ...p, configDigest: computeConnectorProfileDigest(p) };
}

/** Egress policy approving the emulated vendor for PHI in local/ci only (synthetic coverage references). */
export function emulatorEgressPolicy(): EgressPolicyConfig {
  return {
    policyVersion: "egress-emulated-1",
    destinations: [
      {
        destinationId: "egr_scheduling",
        kind: "SYSTEM_OF_RECORD",
        hosts: [API_HOST, AUTH_HOST],
        allowedClasses: ["INTERNAL", "PHI", "FINANCIAL"],
        coverage: { baaRef: "baa-synthetic-emulator", approvalId: "apr_synthEmulatorApproval1" },
        environments: ["local", "ci"],
        adapterKind: "live",
      },
    ],
  };
}
