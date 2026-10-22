/**
 * The OpenAPI 3.1 description of the reference business API (WP-23; FO-06-74). The committed document
 * `openapi/reference-business-api.openapi.json` is generated from this module and checked for drift and for
 * parity with the registered routes by `src/openapi.test.ts`:
 *
 *   node --import tsx src/openapi.ts --write      (from services/reference-business-api)
 *
 * The fault-control API (admin.ts) is deliberately NOT part of this document: it is a local/ci test seam,
 * not a contract a tenant system offers.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCOPES } from "./auth.js";
import { metadataDocument } from "./metadata.js";

type Json = Record<string, unknown>;

const ref = (name: string): Json => ({ $ref: `#/components/schemas/${name}` });
const list = (item: string): Json => ({ type: "object", required: ["items"], properties: { items: { type: "array", items: ref(item) }, nextCursor: { type: ["string", "null"] } } });
const pathParam = (name: string, description: string): Json => ({ name, in: "path", required: true, description, schema: { type: "string", pattern: "^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$" } });
const queryInt = (name: string, min: number, max: number, dflt: number, description: string): Json => ({ name, in: "query", required: false, description, schema: { type: "integer", minimum: min, maximum: max, default: dflt } });

const ERRORS: Json = {
  "400": { $ref: "#/components/responses/Error" },
  "401": { $ref: "#/components/responses/Error" },
  "403": { $ref: "#/components/responses/Error" },
  "404": { $ref: "#/components/responses/Error" },
  "503": { $ref: "#/components/responses/Unavailable" },
};
const WRITE_ERRORS: Json = {
  ...ERRORS,
  "409": { $ref: "#/components/responses/Error" },
  "422": { $ref: "#/components/responses/Error" },
  "500": { $ref: "#/components/responses/PartialWrite" },
};

function read(operationId: string, summary: string, scope: string, params: Json[], schema: Json): Json {
  return {
    get: {
      operationId,
      summary,
      security: [{ oauth2: [scope] }],
      parameters: params,
      responses: { "200": { description: "OK", headers: { "Refbiz-Account": { $ref: "#/components/headers/Account" }, "Refbiz-Region": { $ref: "#/components/headers/Region" } }, content: { "application/json": { schema } } }, ...ERRORS },
    },
  };
}

function write(operationId: string, summary: string, scope: string, body: string, description: string): Json {
  return {
    put: {
      operationId,
      summary,
      description,
      security: [{ oauth2: [scope] }],
      parameters: [pathParam("requestId", "Client-chosen request id (the platform derives it from its provider idempotency key). The idempotency identity of the change.")],
      requestBody: { required: true, content: { "application/json": { schema: ref(body) } } },
      responses: {
        "200": {
          description:
            "The change is COMPLETED (first delivery or replay; a replay carries Refbiz-Replayed: true). The body carries the stored requestDigest; a client must not claim the change unless it equals the digest of the request it sent.",
          headers: { "Refbiz-Replayed": { schema: { type: "string", enum: ["true"] } } },
          content: { "application/json": { schema: ref("ChangeRequest") } },
        },
        ...WRITE_ERRORS,
        "409": {
          description:
            "A business refusal (VERSION_CONFLICT, SLOT_UNAVAILABLE, STATE_CONFLICT), DEADLINE_EXCEEDED (the request's notAfter passed before it could be committed) or FENCED (the request id was fenced: nothing can ever be applied under it). Nothing was applied; the request id is recorded REJECTED with that code.",
          content: { "application/json": { schema: ref("Error") } },
        },
        "422": {
          description:
            "REQUEST_ID_REUSED: the request id is already used by a DIFFERENT request (operation or body). That earlier request may have been applied: reconcile by GET /api/v1/change-requests/{requestId} and compare its requestDigest; never treat this answer as 'not applied'.",
          content: { "application/json": { schema: ref("Error") } },
        },
      },
    },
  };
}

const AUTHORITY = { type: "string", enum: ["CLIENT_CONFIRMED", "PROVIDER_APPROVED"], description: "CLIENT_CONFIRMED: the acting party is the record's client. PROVIDER_APPROVED: the acting party is the provider whose schedule it is. A provider approval never stands in for a client's consent." };
const ID = { type: "string", pattern: "^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$" };
const VERSION = { type: "string", pattern: "^[1-9][0-9]{0,8}$" };
const NOT_AFTER = {
  type: "string",
  format: "date-time",
  description:
    "Optional dispatch deadline (at most 24 hours ahead). The change is applied only if the final check, the last statement of its transaction (database clock), passes; otherwise the request is REJECTED with DEADLINE_EXCEEDED. Lock waits are bounded by the time left. The deadline bounds how long a delivery keeps trying; it does NOT make a lookup 404 definitive (the COMMIT after the final check can land after notAfter). Once notAfter has passed, POST /api/v1/change-requests/{requestId}/fence proves absence. Part of the request digest.",
};

export function openApiDocument(): Json {
  const objects = (metadataDocument("canonical").$defs ?? {}) as Record<string, Json>;
  const schemas: Record<string, Json> = {};
  for (const [name, schema] of Object.entries(objects)) {
    const { title: _t, ...rest } = schema;
    schemas[name] = rest;
  }
  schemas.AppointmentBooking = { type: "object", additionalProperties: false, required: ["subjectId", "slotId", "slotVersion", "authority", "actingPartyId"], properties: { subjectId: ID, slotId: ID, slotVersion: VERSION, authority: AUTHORITY, actingPartyId: ID, notAfter: NOT_AFTER } };
  schemas.AppointmentReschedule = {
    type: "object",
    additionalProperties: false,
    required: ["appointmentId", "expectedVersion", "slotId", "slotVersion", "authority", "actingPartyId"],
    properties: { appointmentId: ID, expectedVersion: VERSION, slotId: ID, slotVersion: VERSION, authority: AUTHORITY, actingPartyId: ID, notAfter: NOT_AFTER },
  };
  schemas.AppointmentCancellation = {
    type: "object",
    additionalProperties: false,
    required: ["appointmentId", "expectedVersion", "reasonCode", "authority", "actingPartyId"],
    properties: { appointmentId: ID, expectedVersion: VERSION, reasonCode: { type: "string", enum: ["CLIENT_REQUEST", "PROVIDER_UNAVAILABLE", "SCHEDULING_CONFLICT"] }, authority: AUTHORITY, actingPartyId: ID, notAfter: NOT_AFTER },
  };
  schemas.AvailabilityBlock = {
    type: "object",
    additionalProperties: false,
    required: ["providerId", "slotId", "slotVersion", "reasonCode", "authority", "actingPartyId"],
    properties: { providerId: ID, slotId: ID, slotVersion: VERSION, reasonCode: { type: "string", enum: ["PROVIDER_UNAVAILABLE", "ADMINISTRATIVE"] }, authority: { type: "string", enum: ["PROVIDER_APPROVED"] }, actingPartyId: ID, notAfter: NOT_AFTER },
  };
  schemas.BillingReviewRequest = {
    type: "object",
    additionalProperties: false,
    required: ["invoiceId", "expectedVersion", "reasonCode", "authority", "actingPartyId"],
    properties: { invoiceId: ID, expectedVersion: VERSION, reasonCode: { type: "string", enum: ["CHARGE_QUESTIONED", "DUPLICATE_CHARGE_SUSPECTED", "AMOUNT_QUESTIONED"] }, authority: { type: "string", enum: ["CLIENT_CONFIRMED"] }, actingPartyId: ID, notAfter: NOT_AFTER },
  };
  schemas.LegacyBooking = {
    type: "object",
    additionalProperties: false,
    required: ["clientRef", "providerRef", "startLocal", "modeCode"],
    properties: {
      clientRef: ID,
      providerRef: ID,
      startLocal: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$", description: "Wall-clock time in the account's time zone, no offset." },
      modeCode: { type: "string", enum: ["VID", "OFC", "TEL"] },
      notAfter: NOT_AFTER,
      dispatchId: { ...ID, description: "The dispatch that reserved the reference (PUT /api/v1/legacy/references/{externalRef}); a create naming another dispatch than the reservation's is refused 409 RESERVED_BY_ANOTHER_DISPATCH." },
    },
  };
  schemas.ChangeRequestFence = {
    type: "object",
    additionalProperties: false,
    required: ["operation", "notAfter"],
    properties: {
      operation: { type: "string", enum: ["scheduling.booking.put", "scheduling.reschedule.put", "scheduling.cancellation.put", "scheduling.availability_block.put", "billing.review_request.put"] },
      notAfter: { type: "string", format: "date-time", description: "The dispatch deadline the request was sent with. The fence inserts only once the database clock is past it." },
    },
  };
  schemas.LegacyReservation = { type: "object", additionalProperties: false, required: ["dispatchId"], properties: { dispatchId: { ...ID, description: "Opaque id of ONE dispatch (a fresh id per delivery attempt of the client)." }, notAfter: NOT_AFTER } };
  schemas.LegacyRelease = { type: "object", additionalProperties: false, required: ["dispatchId"], properties: { dispatchId: ID } };
  schemas.LegacyFence = { type: "object", additionalProperties: false, required: ["notAfter"], properties: { notAfter: { type: "string", format: "date-time", description: "The dispatch deadline of the create. The fence changes nothing before it." } } };
  schemas.TokenResponse = {
    type: "object",
    required: ["access_token", "token_type", "expires_in", "scope", "account_id", "region"],
    properties: { access_token: { type: "string" }, token_type: { type: "string", enum: ["Bearer"] }, expires_in: { type: "integer" }, scope: { type: "string" }, account_id: { type: "string" }, region: { type: "string" } },
  };
  schemas.Error = { type: "object", required: ["error"], properties: { error: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_]{2,63}$" } } };
  schemas.SchemaDocument = { type: "object", description: "JSON Schema (draft 2020-12) of every object in the account's dialect; `$defs` per object, `x-vsp-prohibited` marks fields a consumer must never ingest." };

  const paths: Record<string, Json> = {
    "/oauth/token": {
      post: {
        operationId: "issueToken",
        summary: "OAuth 2.0 client credentials (client_secret_basic or client_secret_post). The response names the account and region the client belongs to.",
        security: [],
        requestBody: {
          required: true,
          content: { "application/x-www-form-urlencoded": { schema: { type: "object", required: ["grant_type"], properties: { grant_type: { type: "string", enum: ["client_credentials"] }, scope: { type: "string" }, client_id: { type: "string" }, client_secret: { type: "string" } } } } },
        },
        responses: {
          "200": { description: "Token issued", content: { "application/json": { schema: ref("TokenResponse") } } },
          "400": { description: "invalid_request / invalid_scope / unsupported_grant_type" },
          "401": { description: "invalid_client (unknown client and wrong secret answer the same way)" },
        },
      },
    },
    "/api/v1/subjects/{subjectId}/appointments": read("listAppointments", "A client's appointments (cursor pagination).", "scheduling:read", [pathParam("subjectId", "Client id"), queryInt("limit", 1, 100, 50, "Page size"), { name: "cursor", in: "query", required: false, schema: { type: "string", pattern: "^cur_[A-Za-z0-9_-]{16,64}$" } }], list("Appointment")),
    "/api/v1/appointments/{appointmentId}": read("getAppointment", "One appointment with its version.", "scheduling:read", [pathParam("appointmentId", "Appointment id")], ref("Appointment")),
    "/api/v1/subjects/{subjectId}/slot-options": read(
      "listSlotOptions",
      "Open slots a client may book in the next `days` days; with appointmentId only that appointment's provider. Administrative availability only (no clinical suitability).",
      "scheduling:read",
      [pathParam("subjectId", "Client id"), queryInt("days", 1, 62, 14, "Window in days from now"), { name: "appointmentId", in: "query", required: false, schema: ID }],
      list("Slot"),
    ),
    "/api/v1/providers/{providerId}/slots": read("listProviderSlots", "A provider's own open slots.", "scheduling:read", [pathParam("providerId", "Provider id"), queryInt("days", 1, 62, 14, "Window in days from now")], list("Slot")),
    "/api/v1/slots/{slotId}": read("getSlot", "One slot with its version (read-back before confirmation; re-read at commit).", "scheduling:read", [pathParam("slotId", "Slot id")], ref("Slot")),
    "/api/v1/appointment-bookings/{requestId}": write("bookAppointment", "Book an open slot for a client (CLIENT_CONFIRMED by that client).", "scheduling:write", "AppointmentBooking", "Optimistic concurrency on the slot version; 409 SLOT_UNAVAILABLE or VERSION_CONFLICT when it changed."),
    "/api/v1/appointment-reschedules/{requestId}": write("rescheduleAppointment", "Move an appointment to another open slot of the same provider.", "scheduling:write", "AppointmentReschedule", "Checks the appointment version and the target slot version; releases the old slot."),
    "/api/v1/appointment-cancellations/{requestId}": write("cancelAppointment", "Cancel an appointment (client-confirmed or provider-approved).", "scheduling:write", "AppointmentCancellation", "Checks the appointment version; releases the slot."),
    "/api/v1/availability-blocks/{requestId}": write("blockAvailability", "A provider closes one of their own open slots (PROVIDER_APPROVED).", "scheduling:write", "AvailabilityBlock", "Another provider's slot is refused 403 AUTHORITY_REFUSED."),
    "/api/v1/change-requests/{requestId}": read(
      "getChangeRequest",
      "Lookup by request id (the reconciliation path). 404 for an unknown id AND for one not yet visible (the index lags by up to the account's visibility window, GET /api/v1/meta/{system}/consistency). A 404 is never proof of absence, whatever time has passed: once the request's notAfter has passed, POST /api/v1/change-requests/{requestId}/fence answers authoritatively. The body carries the stored requestDigest (SHA-256 hex of 'refbiz.request.v1\\n' + operation + '\\n' + canonical JSON of the request body: sorted keys, no whitespace) so a client can bind the found change to the request it would send. Needs the read scope of the request's system.",
      "scheduling:read",
      [pathParam("requestId", "Request id")],
      ref("ChangeRequest"),
    ),
    "/api/v1/change-requests/{requestId}/completion": {
      post: {
        operationId: "completeChangeRequest",
        summary: "Completes an INCOMPLETE change request (step 2 only: the receipt); never applies the change again. Replays a COMPLETED one; 404 for an unknown id. Needs the write scope of the request's system.",
        security: [{ oauth2: ["scheduling:write"] }, { oauth2: ["billing:write"] }],
        parameters: [pathParam("requestId", "Request id")],
        responses: { "200": { description: "COMPLETED", content: { "application/json": { schema: ref("ChangeRequest") } } }, ...WRITE_ERRORS },
      },
    },
    "/api/v1/change-requests/{requestId}/fence": {
      post: {
        operationId: "fenceChangeRequest",
        summary:
          "The proof of absence, allowed once the request's notAfter has passed (database clock). With a change request stored under the id it answers it as stored (no lookup lag; a delivery still inside its transaction is waited for). With nothing stored it records the id FENCED (REJECTED, failureCode FENCED, Refbiz-Fenced: true): no delivery of the id can ever be applied (each is refused 409 FENCED). Before notAfter with nothing stored: 409 FENCE_BEFORE_DEADLINE, nothing changes. Needs the write scope of the operation's system.",
        security: [{ oauth2: ["scheduling:write"] }, { oauth2: ["billing:write"] }],
        parameters: [pathParam("requestId", "Request id")],
        requestBody: { required: true, content: { "application/json": { schema: ref("ChangeRequestFence") } } },
        responses: {
          "200": { description: "The change request stored under the id, or the fence", headers: { "Refbiz-Fenced": { schema: { type: "string", enum: ["true"] } } }, content: { "application/json": { schema: ref("ChangeRequest") } } },
          ...ERRORS,
          "409": { description: "FENCE_BEFORE_DEADLINE: nothing stored and notAfter not passed yet; ask again later.", content: { "application/json": { schema: ref("Error") } } },
        },
      },
    },
    "/api/v1/receipts/{receiptId}": read("getReceipt", "The authoritative receipt of a completed change, with the request digest of the change it records.", "scheduling:read", [pathParam("receiptId", "Receipt id")], ref("Receipt")),
    "/api/v1/subjects/{subjectId}/invoices": read("listInvoices", "A client's invoices.", "billing:read", [pathParam("subjectId", "Client id")], list("Invoice")),
    "/api/v1/invoices/{invoiceId}": read("getInvoice", "One invoice with its version.", "billing:read", [pathParam("invoiceId", "Invoice id")], ref("Invoice")),
    "/api/v1/invoices/{invoiceId}/lines": read("listInvoiceLines", "Invoice lines.", "billing:read", [pathParam("invoiceId", "Invoice id")], list("InvoiceLine")),
    "/api/v1/invoices/{invoiceId}/payments": read("listPayments", "Payments the billing system received for an invoice.", "billing:read", [pathParam("invoiceId", "Invoice id")], list("Payment")),
    "/api/v1/billing-review-requests/{requestId}": write("requestBillingReview", "A client asks for a review of their invoice: IN_REVIEW, no amount changes.", "billing:write", "BillingReviewRequest", "Checks the invoice version; only the invoice's client may ask."),
    "/api/v1/subjects/{subjectId}/claims": read("listClaims", "Insurer-reported claim status (never an eligibility or payment guarantee).", "claims:read", [pathParam("subjectId", "Client id")], list("Claim")),
    "/api/v1/claims/{claimId}": read("getClaim", "One claim's insurer-reported status.", "claims:read", [pathParam("claimId", "Claim id")], ref("Claim")),
    "/api/v1/providers/{providerId}/onboarding": read("getOnboarding", "A provider's onboarding stage.", "provider:read", [pathParam("providerId", "Provider id")], ref("Onboarding")),
    "/api/v1/providers/{providerId}/onboarding/documents": read("listOnboardingDocuments", "Credentialing document status.", "provider:read", [pathParam("providerId", "Provider id")], list("OnboardingDocument")),
    "/api/v1/practices/{practiceId}/remittances": read("listRemittances", "A practice's most recent remittances.", "provider:read", [pathParam("practiceId", "Practice id"), queryInt("periods", 1, 24, 6, "Number of most recent periods")], list("Remittance")),
    "/api/v1/subjects/{subjectId}/referrals": read("listReferrals", "A client's referrals with their status.", "referrals:read", [pathParam("subjectId", "Client id")], list("Referral")),
    "/api/v1/referrals/{referralId}": read("getReferral", "One referral's status.", "referrals:read", [pathParam("referralId", "Referral id")], ref("Referral")),
    "/api/v1/subjects/{subjectId}/authorizations": read("listAuthorizations", "Payer-reported authorization status.", "referrals:read", [pathParam("subjectId", "Client id")], list("Authorization")),
    "/api/v1/subjects/{subjectId}/eligibility": read("getEligibility", "The payer's last eligibility response with its time (not a coverage decision).", "referrals:read", [pathParam("subjectId", "Client id")], ref("Eligibility")),
    "/api/v1/legacy/appointments/{externalRef}": {
      post: {
        operationId: "legacyCreateAppointment",
        summary:
          "Legacy product: creates an appointment. NOT idempotent: every delivery creates another one. A client creates only under its own reservation of the reference (PUT /api/v1/legacy/references/{externalRef}) and reconciles by GET /api/v1/legacy/appointments/by-reference/{externalRef} and, past its deadline, the reference fence; never by sending again. Refused 409 FENCED under a fenced reference and 409 RESERVED_BY_ANOTHER_DISPATCH under another dispatch's reservation. With notAfter the appointment is created only if the final deadline check passes (409 DEADLINE_EXCEEDED otherwise, nothing stored).",
        security: [{ oauth2: ["legacy:write"] }],
        parameters: [pathParam("externalRef", "Client reference stored with the appointment (not enforced unique)")],
        requestBody: { required: true, content: { "application/json": { schema: ref("LegacyBooking") } } },
        responses: { "200": { description: "Created", content: { "application/json": { schema: ref("LegacyAppointment") } } }, ...ERRORS, "409": { $ref: "#/components/responses/Error" } },
      },
    },
    "/api/v1/legacy/references/{externalRef}": {
      put: {
        operationId: "legacyReserveReference",
        summary:
          "Reserves the reference for one dispatch before its create (the dispatch marker of the non-idempotent product). The first reservation wins; any later one (another dispatch id) answers the stored state with reservedForDispatch false, so a client that creates only when reservedForDispatch is true never sends a second create for the reference. With notAfter no reservation is made after it (409 DEADLINE_EXCEEDED when nothing is stored).",
        security: [{ oauth2: ["legacy:write"] }],
        parameters: [pathParam("externalRef", "Client reference")],
        requestBody: { required: true, content: { "application/json": { schema: ref("LegacyReservation") } } },
        responses: { "200": { description: "The reference's state for this dispatch", content: { "application/json": { schema: ref("LegacyReference") } } }, ...ERRORS, "409": { $ref: "#/components/responses/Error" } },
      },
    },
    "/api/v1/legacy/references/{externalRef}/release": {
      post: {
        operationId: "legacyReleaseReference",
        summary: "Gives back a reservation whose create was provably never sent (only the reserving dispatch id, only while RESERVED). Otherwise answers the stored state unchanged.",
        security: [{ oauth2: ["legacy:write"] }],
        parameters: [pathParam("externalRef", "Client reference")],
        requestBody: { required: true, content: { "application/json": { schema: ref("LegacyRelease") } } },
        responses: { "200": { description: "RELEASED, or the stored state", content: { "application/json": { schema: ref("LegacyReference") } } }, ...ERRORS },
      },
    },
    "/api/v1/legacy/references/{externalRef}/fence": {
      post: {
        operationId: "legacyFenceReference",
        summary:
          "The legacy product's proof of absence, allowed once the create's notAfter has passed (database clock): POSTED when a create committed under the reference (a create still inside its transaction is waited for), otherwise FENCED (a reservation that never created is fenced too): no create can ever be stored under the reference. Before notAfter with nothing stored: 409 FENCE_BEFORE_DEADLINE.",
        security: [{ oauth2: ["legacy:write"] }],
        parameters: [pathParam("externalRef", "Client reference")],
        requestBody: { required: true, content: { "application/json": { schema: ref("LegacyFence") } } },
        responses: { "200": { description: "POSTED or FENCED", content: { "application/json": { schema: ref("LegacyReference") } } }, ...ERRORS, "409": { $ref: "#/components/responses/Error" } },
      },
    },
    "/api/v1/legacy/appointments/by-reference/{externalRef}": read(
      "legacyAppointmentsByReference",
      "The legacy product's reconciliation lookup: appointments carrying the reference, visible after the account's visibility window.",
      "legacy:read",
      [pathParam("externalRef", "Client reference")],
      { type: "object", required: ["items"], properties: { items: { type: "array", items: ref("LegacyAppointment") } } },
    ),
    "/api/v1/legacy/appointments/{apptRef}": read("legacyGetAppointment", "One legacy appointment.", "legacy:read", [pathParam("apptRef", "Appointment id")], ref("LegacyAppointment")),
  };
  for (const system of ["scheduling", "billing", "claims", "provider", "referrals", "legacy"]) {
    paths[`/api/v1/meta/${system}/consistency`] = read(
      `${system}Consistency`,
      "The account's documented visibility window and dialect, the dispatch-deadline guarantee of its writes (REQUEST_NOT_AFTER), the request digest scheme of its change requests (REFBIZ_REQUEST_V1), the proof of absence it offers (FENCE_AFTER_DEADLINE) and the legacy product's dispatch marker (RESERVE_BEFORE_CREATE).",
      `${system}:read`,
      [],
      ref("Consistency"),
    );
    paths[`/api/v1/meta/${system}/metadata`] = read(`${system}Metadata`, "JSON Schema of every object in the account's dialect.", `${system}:read`, [], ref("SchemaDocument"));
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Reference business API",
      version: "1.0.0",
      summary: "Documented reference integration for the canonical scheduling, billing / claims-status, provider network and referral / authorization contracts (WP-23).",
      description:
        "SYNTHETIC reference service. Writes are change requests keyed by a client-chosen request id: a replay never applies a change twice, a change applied but not finalized is completed by request id, and the lookup by request id is visible within the account's documented visibility window. A write with a dispatch deadline (notAfter) gives up when its final check fails, but absence is proved only by a fence after the deadline (never by a 404 plus elapsed time: a COMMIT can land late). Every answer about a change request carries its request digest. Responses carry Refbiz-Account and Refbiz-Region. Error bodies carry a reason code only.",
      license: { name: "MIT" },
    },
    servers: [{ url: "https://{host}", variables: { host: { default: "refbiz.example.test" } } }],
    security: [{ oauth2: [] }],
    paths,
    components: {
      securitySchemes: { oauth2: { type: "oauth2", flows: { clientCredentials: { tokenUrl: "/oauth/token", scopes: Object.fromEntries(SCOPES.map((s) => [s, s])) } } } },
      headers: {
        Account: { description: "Account (tenant instance) that answered", schema: { type: "string" } },
        Region: { description: "Region of the account", schema: { type: "string" } },
      },
      responses: {
        Error: { description: "Reason-coded error", content: { "application/json": { schema: ref("Error") } } },
        Unavailable: { description: "UNAVAILABLE or REQUEST_IN_PROGRESS; honour Retry-After", headers: { "Retry-After": { schema: { type: "integer" } } }, content: { "application/json": { schema: ref("Error") } } },
        PartialWrite: { description: "PARTIAL_WRITE: the change was applied, its finalization failed. Complete it by request id; never send a new request.", content: { "application/json": { schema: ref("Error") } } },
      },
      schemas,
    },
  };
}

export const OPENAPI_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "openapi", "reference-business-api.openapi.json");

export const renderOpenApi = (): string => `${JSON.stringify(openApiDocument(), null, 2)}\n`;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes("--write")) {
  writeFileSync(OPENAPI_PATH, renderOpenApi());
}
