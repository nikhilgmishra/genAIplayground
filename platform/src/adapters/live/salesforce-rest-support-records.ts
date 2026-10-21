/**
 * LIVE adapter — Salesforce Service Cloud support records over the documented
 * Salesforce REST API (source register S23: "Salesforce REST upsert by external
 * ID", https://developer.salesforce.com/docs/platform/api-rest/guide/dome-upsert.html).
 *
 * STATUS: IMPLEMENTED_OFFLINE. Exercised only by EMULATED contract tests
 * against a 127.0.0.1 server that reproduces the documented responses
 * (salesforce-rest.contract.test.ts). That is NOT sandbox evidence. The Case /
 * interaction SCHEMA is BLOCKED: custom object and field API names are unknown
 * until the Salesforce administrator provides the Case schema, external ID
 * fields, sharing model and automation inventory (PRQ-006, PRQ-035;
 * VQ-SF-03..VQ-SF-08). The default mapping is PLACEHOLDER names and the adapter
 * refuses to call a real org with it.
 *
 * Documented behaviour used (and nothing else):
 *  - OAuth 2.0 client credentials flow: POST {My Domain}/services/oauth2/token
 *    (application/x-www-form-urlencoded: grant_type=client_credentials,
 *    client_id, client_secret); response JSON carries access_token and
 *    instance_url. A dedicated integration identity (connected app run-as
 *    user) is configured by the Salesforce administrator (spec section 8).
 *  - Upsert by external ID: PATCH /services/data/{apiVersion}/sobjects/{SObject}/
 *    {ExternalIdField}/{externalId} with a JSON body that does not repeat the
 *    external ID field. 201 = created; 200 (API 46.0+) or 204 (older) = updated;
 *    300 = the external ID matched more than one record; 400 / 404 = rejected.
 *  - Retrieve by external ID: GET the same path with `fields=` (minimal fields).
 *  - Related records referenced by their external ID inside the body
 *    (`Relationship__r: { ExternalIdField__c: value }`).
 *  - `Sforce-Limit-Info: api-usage=used/limit` response header (API allocation).
 *  - 403 with errorCode REQUEST_LIMIT_EXCEEDED when the org API limit is reached.
 *
 * Classification (ARCHITECTURE section 3, ACT-02, ACT-03):
 *  - 201 created, 200/204 updated (204 is followed by a minimal GET for the id);
 *  - 300 -> ConflictError SALESFORCE_EXTERNAL_ID_MULTIPLE_MATCHES (never pick one);
 *  - 400 / 404 -> permanent FAILED (not retryable);
 *  - 401 -> invalidate the cached token, request ONE new token and retry once;
 *    a second 401 -> FAILED SALESFORCE_AUTH_FAILED (no refresh loop);
 *  - 429 / 503 -> retryable NOT_STARTED (HTTP_429 / HTTP_503, Retry-After honoured);
 *  - network timeout after the request was sent -> UNKNOWN TIMEOUT_AFTER_SEND
 *    (reconcile by external ID before any retry); connection refused ->
 *    NOT_STARTED CONNECTION_REFUSED; other 5xx on a write -> UNKNOWN.
 * The adapter never retries on its own apart from the single 401 refresh (no
 * retry stacking; the resilience module owns retries). Redirects are not
 * followed. instance_url must equal the configured org origin (no token-driven
 * SSRF). Response bodies are size-bounded, parsed for the needed fields only,
 * and never copied into errors or logs (they can contain record data).
 *
 * Avoid pulling Salesforce on every turn (spec section 12): wrap this adapter
 * with CachingSupportRecords (../support-record-cache.ts).
 */
import { z } from "zod";
import { TransportError } from "../../connectors/http/transport.js";
import type { TransportRequest, TransportResponse } from "../../connectors/http/transport.js";
import { silentLogger } from "../../observability/logger.js";
import type { Logger } from "../../observability/ports.js";
import { sha256Hex } from "../../shared/canonical.js";
import { systemClock, type Clock } from "../../shared/clock.js";
import { ConflictError, PlatformError, ValidationError } from "../../shared/errors.js";
import { ADAPTER_REASON, AdapterDependencyError, BlockedCapabilityError } from "../errors.js";
import type { AdapterHealth, CaseFields, SupportRecordSystem } from "../ports.js";
import { CASE_FIELD_KEYS, CaseFieldsSchema, InteractionExternalId, InteractionFieldsSchema, IssueExternalId } from "../support-records-schema.js";

export const SALESFORCE_PREREQUISITES = ["PRQ-006", "PRQ-035", "PRQ-024"] as const;
export const SALESFORCE_SCHEMA_OWNER = "Salesforce administrator";

/** e.g. "v62.0". The tenant's API version is configuration; no default is claimed. */
export const SalesforceApiVersion = z.string().regex(/^v\d{2,3}\.\d$/);
const ApiName = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,79}$/);
const SalesforceId = z.string().regex(/^[a-zA-Z0-9]{15,18}$/);

export const SalesforceFieldMappingSchema = z.strictObject({
  interaction: z.strictObject({
    sobject: ApiName,
    externalIdField: ApiName,
    fields: z.strictObject({ callId: ApiName, language: ApiName, consentStatus: ApiName, startedAt: ApiName }),
  }),
  case: z.strictObject({
    sobject: ApiName,
    externalIdField: ApiName,
    /** Standard Case field read back for status. */
    statusField: ApiName,
    fields: z.strictObject(Object.fromEntries(CASE_FIELD_KEYS.map((k) => [k, ApiName])) as Record<keyof CaseFields, typeof ApiName>),
  }),
  /** Junction object: one interaction <-> many Cases, one Case <-> many interactions (spec section 8). */
  link: z.strictObject({
    sobject: ApiName,
    externalIdField: ApiName,
    interactionRelationship: ApiName,
    caseRelationship: ApiName,
  }),
});
export type SalesforceFieldMapping = z.infer<typeof SalesforceFieldMappingSchema>;

/**
 * PLACEHOLDER mapping. The custom object and field API names are NOT KNOWN; the
 * Salesforce administrator must supply them (PRQ-006). `Case` and `Status` are
 * the standard object and field; whether this org uses them for platform issues
 * is also part of the requested schema.
 */
export const PLACEHOLDER_SALESFORCE_MAPPING: SalesforceFieldMapping = {
  interaction: {
    sobject: "PLACEHOLDER_Support_Interaction__c",
    externalIdField: "PLACEHOLDER_Interaction_External_Id__c",
    fields: {
      callId: "PLACEHOLDER_Source_Call_Id__c",
      language: "PLACEHOLDER_Language__c",
      consentStatus: "PLACEHOLDER_Consent_Status__c",
      startedAt: "PLACEHOLDER_Started_At__c",
    },
  },
  case: {
    sobject: "Case",
    externalIdField: "PLACEHOLDER_Issue_External_Id__c",
    statusField: "Status",
    fields: {
      subjectRef: "PLACEHOLDER_Subject_Ref__c",
      audience: "PLACEHOLDER_Audience__c",
      issueCategory: "PLACEHOLDER_Issue_Category__c",
      disposition: "PLACEHOLDER_Disposition__c",
      ownerQueue: "PLACEHOLDER_Owner_Queue__c",
      priority: "PLACEHOLDER_Priority__c",
      summary: "PLACEHOLDER_Minimized_Summary__c",
      attempted: "PLACEHOLDER_Attempted__c",
      commitReceiptIds: "PLACEHOLDER_Commit_Receipts__c",
      sourceCallIds: "PLACEHOLDER_Source_Call_Ids__c",
      language: "PLACEHOLDER_Case_Language__c",
      consentStatus: "PLACEHOLDER_Case_Consent_Status__c",
      nextStep: "PLACEHOLDER_Next_Step__c",
      deadline: "PLACEHOLDER_Deadline__c",
      versions: "PLACEHOLDER_Config_Versions__c",
      restricted: "PLACEHOLDER_Restricted__c",
      supportReference: "PLACEHOLDER_Support_Reference__c",
    },
  },
  link: {
    sobject: "PLACEHOLDER_Interaction_Case_Link__c",
    externalIdField: "PLACEHOLDER_Link_External_Id__c",
    interactionRelationship: "PLACEHOLDER_Interaction__r",
    caseRelationship: "PLACEHOLDER_Case__r",
  },
};

const mappingNames = (m: SalesforceFieldMapping): string[] => [
  m.interaction.sobject,
  m.interaction.externalIdField,
  ...Object.values(m.interaction.fields),
  m.case.sobject,
  m.case.externalIdField,
  m.case.statusField,
  ...Object.values(m.case.fields),
  m.link.sobject,
  m.link.externalIdField,
  m.link.interactionRelationship,
  m.link.caseRelationship,
];
export const mappingHasPlaceholders = (m: SalesforceFieldMapping): boolean => mappingNames(m).some((n) => /PLACEHOLDER/i.test(n));

export const SalesforceSchemaEvidence = z.discriminatedUnion("status", [
  /** Default: schema unknown -> every operation fails closed with BLOCKED_CAPABILITY_UNVERIFIED. */
  z.strictObject({ status: z.literal("BLOCKED"), prerequisite: z.literal("PRQ-006"), owner: z.literal(SALESFORCE_SCHEMA_OWNER) }),
  /** Schema supplied by the Salesforce administrator; placeholders are rejected. */
  z.strictObject({
    status: z.literal("PROVIDED"),
    providedBy: z.literal(SALESFORCE_SCHEMA_OWNER),
    evidenceRef: z.string().min(3).max(512),
    approvalId: z.string().regex(/^apr_[A-Za-z0-9_-]{8,64}$/),
  }),
  /** Contract tests against the local emulator only: requires a loopback http(s) origin. */
  z.strictObject({ status: z.literal("EMULATED_CONTRACT_TEST") }),
]);
export type SalesforceSchemaEvidence = z.infer<typeof SalesforceSchemaEvidence>;

export const SalesforceRestConfigSchema = z.strictObject({
  integrationId: z.string().regex(/^[a-z][a-z0-9-]{2,63}$/).default("salesforce"),
  /**
   * Origin of the org's My Domain, e.g. https://<MyDomain>.my.salesforce.com (no path, query or
   * credentials). May be null only while the schema is BLOCKED (no request is ever made then).
   */
  myDomainUrl: z.string().max(253).nullable(),
  /** Required unless the schema is BLOCKED. Never defaulted: the tenant's version is not claimed. */
  apiVersion: SalesforceApiVersion.nullable(),
  timeoutMs: z.number().int().min(100).max(30_000),
  /**
   * Client-side upper bound on token reuse. The org's session timeout policy is
   * UNKNOWN; a 401 always forces one refresh regardless.
   */
  tokenMaxAgeSeconds: z.number().int().min(60).max(86_400).default(900),
  maxResponseBytes: z.number().int().min(1_024).max(1_048_576).default(65_536),
  schema: SalesforceSchemaEvidence,
  mapping: SalesforceFieldMappingSchema.default(PLACEHOLDER_SALESFORCE_MAPPING),
});
export type SalesforceRestConfig = z.input<typeof SalesforceRestConfigSchema>;

export interface SalesforceClientCredentials {
  clientId: string;
  clientSecret: string;
}

/** The part of the egress-classified ConnectorHttpTransport the adapter uses (the production transport satisfies it). */
export interface SalesforceTransport {
  send(req: TransportRequest): Promise<TransportResponse>;
}

export interface SalesforceRestDeps {
  /** Resolves the connected-app credentials from the approved secret store (Secrets Manager). Never logged. */
  credentials: () => Promise<SalesforceClientCredentials>;
  /**
   * WP-07: the egress-classified transport (https only, exact host allowlist, address class, EgressGuard on
   * every request, no redirects, bounded bodies). The live composition always passes it; `fetch` remains only
   * for the loopback contract emulator of salesforce-rest.contract.test.ts.
   */
  transport?: SalesforceTransport;
  /** Address class of the org's My Domain host for the transport (default PUBLIC_INTERNET). */
  addressClass?: "PUBLIC_INTERNET" | "PRIVATE_NETWORK";
  fetch?: typeof fetch;
  clock?: Clock;
  logger?: Logger;
}

const TokenResponse = z.object({
  access_token: z.string().min(8).max(4096),
  instance_url: z.string().min(8).max(512),
  token_type: z.string().max(32).optional(),
  expires_in: z.union([z.number(), z.string().regex(/^\d{1,9}$/)]).optional(),
});
const UpsertResponse = z.object({
  id: SalesforceId,
  success: z.boolean().optional(),
  created: z.boolean().optional(),
});
const ErrorBody = z.array(z.object({ errorCode: z.string().max(64).optional() })).max(32);

interface HttpResult {
  status: number;
  headers: Headers;
  text: string;
}
interface CallContext {
  operation: string;
  mutation: boolean;
}
interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

class ResponseTooLargeError extends Error {}

const TOKEN_EXPIRY_MARGIN_MS = 30_000;
const NOT_CONNECTED_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);

function isLoopback(u: URL): boolean {
  return u.hostname === "127.0.0.1" || u.hostname === "[::1]";
}

function errorCodeOf(err: unknown): string | null {
  const direct = (err as { code?: unknown } | null)?.code;
  if (typeof direct === "string") return direct;
  const cause = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof cause === "string" ? cause : null;
}

function retryAfterMs(headers: Headers): number | null {
  const v = headers.get("retry-after");
  if (v === null || !/^\d{1,6}$/.test(v.trim())) return null;
  return Number(v.trim()) * 1000;
}

export class SalesforceRestSupportRecords implements SupportRecordSystem {
  readonly kind = "live" as const;
  readonly integrationId: string;
  /** BLOCKED until the administrator-provided schema is configured (read by the adapter registry). */
  readonly capabilityStatus: "BLOCKED" | "EMULATED_CONTRACT_TEST" | "SCHEMA_PROVIDED";
  readonly prerequisites: readonly string[] = SALESFORCE_PREREQUISITES;
  private readonly cfg: z.infer<typeof SalesforceRestConfigSchema>;
  private readonly origin: string;
  private readonly apiVersion: string;
  private readonly fetchImpl: typeof fetch;
  private readonly transport: SalesforceTransport | null;
  private readonly addressClass: "PUBLIC_INTERNET" | "PRIVATE_NETWORK";
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly credentials: () => Promise<SalesforceClientCredentials>;
  private token: CachedToken | null = null;
  private tokenInFlight: Promise<CachedToken> | null = null;
  private lastFailure: string | null = null;
  private apiUsage: { used: number; limit: number } | null = null;
  private tokenRequestCount = 0;

  constructor(config: SalesforceRestConfig, deps: SalesforceRestDeps) {
    const parsed = SalesforceRestConfigSchema.safeParse(config);
    if (!parsed.success) throw new ValidationError("SALESFORCE_CONFIG_INVALID");
    const cfg = parsed.data;
    if (cfg.schema.status === "PROVIDED" && mappingHasPlaceholders(cfg.mapping)) throw new ValidationError("SALESFORCE_MAPPING_PLACEHOLDER");
    if (cfg.apiVersion === null && cfg.schema.status !== "BLOCKED") throw new ValidationError("SALESFORCE_API_VERSION_REQUIRED");
    let origin = "";
    if (cfg.myDomainUrl === null) {
      if (cfg.schema.status !== "BLOCKED") throw new ValidationError("SALESFORCE_ENDPOINT_INVALID");
    } else {
      let url: URL;
      try {
        url = new URL(cfg.myDomainUrl);
      } catch {
        throw new ValidationError("SALESFORCE_ENDPOINT_INVALID");
      }
      if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw new ValidationError("SALESFORCE_ENDPOINT_INVALID");
      if (cfg.schema.status === "EMULATED_CONTRACT_TEST") {
        if (!isLoopback(url) || (url.protocol !== "http:" && url.protocol !== "https:")) throw new ValidationError("SALESFORCE_EMULATION_REQUIRES_LOOPBACK");
      } else if (url.protocol !== "https:" || !url.hostname.endsWith(".my.salesforce.com")) {
        throw new ValidationError("SALESFORCE_ENDPOINT_INVALID");
      }
      origin = url.origin;
    }
    this.cfg = cfg;
    this.apiVersion = cfg.apiVersion ?? "UNSET";
    this.origin = origin;
    this.integrationId = cfg.integrationId;
    this.capabilityStatus = cfg.schema.status === "BLOCKED" ? "BLOCKED" : cfg.schema.status === "PROVIDED" ? "SCHEMA_PROVIDED" : "EMULATED_CONTRACT_TEST";
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
    this.transport = deps.transport ?? null;
    this.addressClass = deps.addressClass ?? "PUBLIC_INTERNET";
    this.clock = deps.clock ?? systemClock;
    this.logger = (deps.logger ?? silentLogger).child({ component: "salesforce_rest", integration: cfg.integrationId });
    this.credentials = deps.credentials;
  }

  async health(): Promise<AdapterHealth> {
    if (this.capabilityStatus === "BLOCKED") return { healthy: false, reasonCode: "BLOCKED_CAPABILITY_UNVERIFIED" };
    return this.lastFailure ? { healthy: false, reasonCode: this.lastFailure } : { healthy: true, reasonCode: null };
  }

  /** Last observed `Sforce-Limit-Info` API usage (for quota dashboards). */
  get lastApiUsage(): { used: number; limit: number } | null {
    return this.apiUsage ? { ...this.apiUsage } : null;
  }

  /** Token requests made by this instance (tests assert caching / single refresh). */
  get tokenRequests(): number {
    return this.tokenRequestCount;
  }

  async upsertInteraction(
    externalId: string,
    fields: { callId: string; language: string; consentStatus: string; startedAt: string },
  ): Promise<{ recordId: string; created: boolean }> {
    this.assertUnblocked("upsertInteraction");
    if (!InteractionExternalId.safeParse(externalId).success) throw new ValidationError("SUPPORT_EXTERNAL_ID_INVALID");
    const f = InteractionFieldsSchema.safeParse(fields);
    if (!f.success) throw new ValidationError("SUPPORT_INTERACTION_FIELDS_INVALID");
    const m = this.cfg.mapping.interaction;
    const body = {
      [m.fields.callId]: f.data.callId,
      [m.fields.language]: f.data.language,
      [m.fields.consentStatus]: f.data.consentStatus,
      [m.fields.startedAt]: f.data.startedAt,
    };
    const r = await this.upsert(m.sobject, m.externalIdField, externalId, body, "upsertInteraction");
    return { recordId: r.id, created: r.created };
  }

  async upsertCase(externalId: string, interactionExternalId: string, fields: CaseFields): Promise<{ caseId: string; created: boolean }> {
    this.assertUnblocked("upsertCase");
    if (!IssueExternalId.safeParse(externalId).success || !InteractionExternalId.safeParse(interactionExternalId).success) {
      throw new ValidationError("SUPPORT_EXTERNAL_ID_INVALID");
    }
    const f = CaseFieldsSchema.safeParse(fields);
    if (!f.success) throw new ValidationError("SUPPORT_CASE_FIELDS_INVALID");
    const m = this.cfg.mapping;
    const body: Record<string, string | boolean | null> = {};
    for (const key of CASE_FIELD_KEYS) {
      const v = f.data[key];
      // Arrays are ';'-joined pending the administrator's schema (PRQ-006); ids and codes never contain ';'.
      body[m.case.fields[key]] = Array.isArray(v) ? v.join(";") : v;
    }
    const c = await this.upsert(m.case.sobject, m.case.externalIdField, externalId, body, "upsertCase");
    const linkExternalId = `lnk_${sha256Hex(`${interactionExternalId}|${externalId}`)}`;
    const linkBody = {
      [m.link.interactionRelationship]: { [m.interaction.externalIdField]: interactionExternalId },
      [m.link.caseRelationship]: { [m.case.externalIdField]: externalId },
    };
    try {
      await this.upsert(m.link.sobject, m.link.externalIdField, linkExternalId, linkBody, "upsertCaseLink");
    } catch (err) {
      // The Case exists but its interaction link may not: report UNKNOWN; both upserts are idempotent by external id.
      this.logger.warn("salesforce.upsert_case.partial", { reasonCode: err instanceof PlatformError ? err.reasonCode : "UNCLASSIFIED_ERROR" });
      throw new AdapterDependencyError(ADAPTER_REASON.PARTIAL_WRITE, "UNKNOWN", {
        integrationId: this.integrationId,
        operation: "upsertCase",
        httpStatus: err instanceof AdapterDependencyError ? err.httpStatus : null,
      });
    }
    return { caseId: c.id, created: c.created };
  }

  async getCaseByExternalId(externalId: string): Promise<{ caseId: string; status: string; ownerQueue: string } | null> {
    this.assertUnblocked("getCaseByExternalId");
    if (!IssueExternalId.safeParse(externalId).success) throw new ValidationError("SUPPORT_EXTERNAL_ID_INVALID");
    const m = this.cfg.mapping.case;
    const ownerField = m.fields.ownerQueue;
    const res = await this.getByExternalId(m.sobject, m.externalIdField, externalId, ["Id", m.statusField, ownerField], "getCaseByExternalId");
    if (res === null) return null;
    const row = z.object({ Id: SalesforceId }).catchall(z.unknown()).safeParse(res);
    const status = row.success ? row.data[m.statusField] : undefined;
    const owner = row.success ? row.data[ownerField] : undefined;
    if (!row.success || (status !== null && typeof status !== "string") || (owner !== null && owner !== undefined && typeof owner !== "string")) {
      throw this.depError("SALESFORCE_RESPONSE_INVALID", "FAILED", "getCaseByExternalId", null);
    }
    if (typeof status === "string" && status.length > 255) throw this.depError("SALESFORCE_RESPONSE_INVALID", "FAILED", "getCaseByExternalId", null);
    return { caseId: row.data.Id, status: typeof status === "string" ? status : "UNKNOWN", ownerQueue: typeof owner === "string" ? owner.slice(0, 80) : "UNASSIGNED" };
  }

  // ---------------- REST primitives ----------------

  private sobjectPath(sobject: string, field: string, value: string): string {
    return `/services/data/${this.apiVersion}/sobjects/${sobject}/${field}/${encodeURIComponent(value)}`;
  }

  private async upsert(sobject: string, field: string, value: string, body: Record<string, unknown>, operation: string): Promise<{ id: string; created: boolean }> {
    const ctx: CallContext = { operation, mutation: true };
    const res = await this.api("PATCH", this.sobjectPath(sobject, field, value), JSON.stringify(body), ctx);
    if (res.status === 201 || res.status === 200) {
      const parsed = UpsertResponse.safeParse(this.json(res.text));
      const created = res.status === 201;
      if (!parsed.success || parsed.data.success === false || (parsed.data.created !== undefined && parsed.data.created !== created)) {
        throw this.depError("SALESFORCE_RESPONSE_INVALID", "UNKNOWN", operation, res.status);
      }
      this.succeeded(operation, res.status);
      return { id: parsed.data.id, created };
    }
    if (res.status === 204) {
      // Updated without a body (API versions before 46.0): read back the id with minimal fields.
      let row: Record<string, unknown> | null;
      try {
        row = await this.getByExternalId(sobject, field, value, ["Id"], `${operation}Readback`);
      } catch {
        throw this.depError("SALESFORCE_UPSERT_ID_UNAVAILABLE", "UNKNOWN", operation, 204);
      }
      const id = SalesforceId.safeParse(row?.Id);
      if (!id.success) throw this.depError("SALESFORCE_UPSERT_ID_UNAVAILABLE", "UNKNOWN", operation, 204);
      this.succeeded(operation, 204);
      return { id: id.data, created: false };
    }
    throw this.failure(res, ctx);
  }

  private async getByExternalId(sobject: string, field: string, value: string, fields: string[], operation: string): Promise<Record<string, unknown> | null> {
    const ctx: CallContext = { operation, mutation: false };
    const path = `${this.sobjectPath(sobject, field, value)}?fields=${encodeURIComponent(fields.join(","))}`;
    const res = await this.api("GET", path, undefined, ctx);
    if (res.status === 404) {
      this.succeeded(operation, 404);
      return null;
    }
    if (res.status !== 200) throw this.failure(res, ctx);
    const parsed = z.record(z.string(), z.unknown()).safeParse(this.json(res.text));
    if (!parsed.success) throw this.depError("SALESFORCE_RESPONSE_INVALID", "FAILED", operation, 200);
    this.succeeded(operation, 200);
    return parsed.data;
  }

  /** Authenticated API call with exactly one token refresh on 401. */
  private async api(method: "GET" | "PATCH", path: string, body: string | undefined, ctx: CallContext): Promise<HttpResult> {
    const call = async (token: CachedToken) =>
      this.send(
        `${this.origin}${path}`,
        {
          method,
          headers: {
            authorization: `Bearer ${token.accessToken}`,
            accept: "application/json",
            ...(body !== undefined ? { "content-type": "application/json" } : {}),
          },
          ...(body !== undefined ? { body } : {}),
        },
        ctx,
        "api",
      );
    let token = await this.getToken(ctx.operation);
    let res = await call(token);
    if (res.status === 401) {
      if (this.token?.accessToken === token.accessToken) this.token = null;
      token = await this.getToken(ctx.operation);
      res = await call(token);
      if (res.status === 401) {
        this.token = null;
        throw this.depError("SALESFORCE_AUTH_FAILED", "FAILED", ctx.operation, 401, false);
      }
    }
    this.recordLimitInfo(res.headers);
    return res;
  }

  private async getToken(operation: string): Promise<CachedToken> {
    if (this.token && this.clock.now().getTime() < this.token.expiresAtMs) return this.token;
    this.tokenInFlight ??= this.requestToken(operation).finally(() => {
      this.tokenInFlight = null;
    });
    return this.tokenInFlight;
  }

  private async requestToken(operation: string): Promise<CachedToken> {
    let creds: SalesforceClientCredentials;
    try {
      creds = await this.credentials();
    } catch {
      throw this.depError("SALESFORCE_CREDENTIALS_UNAVAILABLE", "NOT_STARTED", operation, null, false);
    }
    if (typeof creds?.clientId !== "string" || typeof creds.clientSecret !== "string" || !creds.clientId || !creds.clientSecret || creds.clientId.length > 512 || creds.clientSecret.length > 512) {
      throw this.depError("SALESFORCE_CREDENTIALS_UNAVAILABLE", "NOT_STARTED", operation, null, false);
    }
    const form = new URLSearchParams({ grant_type: "client_credentials", client_id: creds.clientId, client_secret: creds.clientSecret });
    this.tokenRequestCount += 1;
    const res = await this.send(
      `${this.origin}/services/oauth2/token`,
      { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: form.toString() },
      { operation, mutation: false },
      "token",
    );
    if (res.status === 429) throw this.depError(ADAPTER_REASON.HTTP_429, "NOT_STARTED", operation, 429, true, retryAfterMs(res.headers));
    if (res.status === 503) throw this.depError(ADAPTER_REASON.HTTP_503, "NOT_STARTED", operation, 503, true, retryAfterMs(res.headers));
    if (res.status >= 500) throw this.depError("SALESFORCE_TOKEN_ENDPOINT_UNAVAILABLE", "NOT_STARTED", operation, res.status, true);
    if (res.status !== 200) throw this.depError("SALESFORCE_TOKEN_REQUEST_REJECTED", "FAILED", operation, res.status, false);
    const parsed = TokenResponse.safeParse(this.json(res.text));
    if (!parsed.success) throw this.depError("SALESFORCE_TOKEN_RESPONSE_INVALID", "FAILED", operation, 200, false);
    let instance: URL;
    try {
      instance = new URL(parsed.data.instance_url);
    } catch {
      throw this.depError("SALESFORCE_INSTANCE_URL_UNEXPECTED", "FAILED", operation, 200, false);
    }
    if (instance.origin !== this.origin) throw this.depError("SALESFORCE_INSTANCE_URL_UNEXPECTED", "FAILED", operation, 200, false);
    const advertised = parsed.data.expires_in === undefined ? null : Number(parsed.data.expires_in);
    const maxAgeMs = Math.min(advertised ?? this.cfg.tokenMaxAgeSeconds, this.cfg.tokenMaxAgeSeconds) * 1000;
    const lifetimeMs = Math.max(maxAgeMs - TOKEN_EXPIRY_MARGIN_MS, Math.min(maxAgeMs, TOKEN_EXPIRY_MARGIN_MS));
    const token = { accessToken: parsed.data.access_token, expiresAtMs: this.clock.now().getTime() + lifetimeMs };
    this.token = token;
    this.logger.info("salesforce.token.issued", { action: operation });
    return token;
  }

  /** One HTTP exchange with timeout, no redirects and a bounded body. */
  private async send(url: string, init: RequestInit, ctx: CallContext, phase: "token" | "api"): Promise<HttpResult> {
    if (this.transport) return this.sendViaTransport(url, init, ctx, phase);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    try {
      const res = await this.fetchImpl(url, { ...init, signal: controller.signal, redirect: "manual" });
      const text = await this.readBounded(res);
      return { status: res.status, headers: res.headers, text };
    } catch (err) {
      throw this.networkError(err, ctx, phase, controller.signal.aborted);
    } finally {
      clearTimeout(timer);
    }
  }

  /** The same exchange over the egress-classified transport (live composition). */
  private async sendViaTransport(url: string, init: RequestInit, ctx: CallContext, phase: "token" | "api"): Promise<HttpResult> {
    const transport = this.transport as SalesforceTransport;
    const target = new URL(url);
    const method = (init.method ?? "GET").toUpperCase() as TransportRequest["method"];
    let res: TransportResponse;
    try {
      res = await transport.send({
        method,
        url: target,
        headers: { ...((init.headers as Record<string, string> | undefined) ?? {}) },
        body: typeof init.body === "string" ? init.body : null,
        policy: { allowedHosts: [target.hostname], addressClass: this.addressClass, dataClass: "INTERNAL" },
        sideEffect: ctx.mutation && phase === "api",
        timeoutMs: this.cfg.timeoutMs,
        dependency: "salesforce",
      });
    } catch (err) {
      if (err instanceof TransportError) {
        // Not sent (refused before I/O, connection refused, TLS failure): nothing reached the org.
        if (!err.requestSent) throw this.depError(ADAPTER_REASON.CONNECTION_REFUSED, "NOT_STARTED", ctx.operation, null, err.retryable);
        if (phase === "api" && ctx.mutation) throw this.depError(err.reasonCode.includes("TIMEOUT") ? ADAPTER_REASON.TIMEOUT_AFTER_SEND : "CONNECTION_LOST", "UNKNOWN", ctx.operation, null, false);
        throw this.depError(err.reasonCode.includes("TIMEOUT") ? ADAPTER_REASON.READ_TIMEOUT : "CONNECTION_LOST", "NOT_STARTED", ctx.operation, null, true);
      }
      // An EgressGuard refusal (AccessDeniedError) or a validation refusal: nothing was sent.
      if (err instanceof PlatformError) throw err;
      throw this.depError(ADAPTER_REASON.CONNECTION_REFUSED, "NOT_STARTED", ctx.operation, null, false);
    }
    if (res.body.length > this.cfg.maxResponseBytes) throw this.networkError(new ResponseTooLargeError(), ctx, phase, false);
    return { status: res.status, headers: new Headers(res.headers), text: res.body.toString("utf8") };
  }

  private async readBounded(res: Response): Promise<string> {
    if (!res.body) return "";
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > this.cfg.maxResponseBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseTooLargeError();
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  private networkError(err: unknown, ctx: CallContext, phase: "token" | "api", timedOut: boolean): PlatformError {
    if (err instanceof PlatformError) return err;
    if (err instanceof ResponseTooLargeError) {
      return this.depError("SALESFORCE_RESPONSE_TOO_LARGE", ctx.mutation && phase === "api" ? "UNKNOWN" : "FAILED", ctx.operation, null, false);
    }
    // Token phase: the business request has not been sent, whatever happened to the token request.
    if (phase === "token") {
      return this.depError(timedOut ? ADAPTER_REASON.TIMEOUT_BEFORE_SEND : ADAPTER_REASON.CONNECTION_REFUSED, "NOT_STARTED", ctx.operation, null, true);
    }
    const code = errorCodeOf(err);
    if (!timedOut && code !== null && NOT_CONNECTED_CODES.has(code)) {
      return this.depError(ADAPTER_REASON.CONNECTION_REFUSED, "NOT_STARTED", ctx.operation, null, true);
    }
    if (ctx.mutation) {
      // Sent (or possibly sent): the effect may exist. Reconcile by external id before any retry (ACT-03).
      return this.depError(timedOut ? ADAPTER_REASON.TIMEOUT_AFTER_SEND : "CONNECTION_LOST", "UNKNOWN", ctx.operation, null, false);
    }
    return this.depError(timedOut ? ADAPTER_REASON.READ_TIMEOUT : "CONNECTION_LOST", "NOT_STARTED", ctx.operation, null, true);
  }

  private failure(res: HttpResult, ctx: CallContext): PlatformError {
    const op = ctx.operation;
    switch (res.status) {
      case 300:
        this.noteFailure("SALESFORCE_EXTERNAL_ID_MULTIPLE_MATCHES", op, 300);
        return new ConflictError("SALESFORCE_EXTERNAL_ID_MULTIPLE_MATCHES");
      case 400:
        return this.depError("SALESFORCE_REQUEST_REJECTED", "FAILED", op, 400, false);
      case 403: {
        const body = ErrorBody.safeParse(this.json(res.text));
        const limit = body.success && body.data.some((e) => e.errorCode === "REQUEST_LIMIT_EXCEEDED");
        return limit
          ? this.depError("SALESFORCE_API_LIMIT_EXCEEDED", "NOT_STARTED", op, 403, false)
          : this.depError("SALESFORCE_FORBIDDEN", "FAILED", op, 403, false);
      }
      case 404:
        return this.depError("SALESFORCE_RESOURCE_NOT_FOUND", "FAILED", op, 404, false);
      case 429:
        return this.depError(ADAPTER_REASON.HTTP_429, "NOT_STARTED", op, 429, true, retryAfterMs(res.headers));
      case 503:
        return this.depError(ADAPTER_REASON.HTTP_503, "NOT_STARTED", op, 503, true, retryAfterMs(res.headers));
      default:
        if (res.status >= 500) return this.depError("SALESFORCE_SERVER_ERROR", ctx.mutation ? "UNKNOWN" : "FAILED", op, res.status, false);
        return this.depError("SALESFORCE_UNEXPECTED_STATUS", ctx.mutation ? "UNKNOWN" : "FAILED", op, res.status, false);
    }
  }

  private depError(
    reasonCode: string,
    outcome: "NOT_STARTED" | "FAILED" | "UNKNOWN",
    operation: string,
    httpStatus: number | null,
    retryable?: boolean,
    retryAfter: number | null = null,
  ): AdapterDependencyError {
    this.noteFailure(reasonCode, operation, httpStatus);
    return new AdapterDependencyError(reasonCode, outcome, {
      integrationId: this.integrationId,
      operation,
      httpStatus,
      retryAfterMs: retryAfter,
      ...(retryable !== undefined ? { retryable } : {}),
    });
  }

  private noteFailure(reasonCode: string, operation: string, httpStatus: number | null): void {
    this.lastFailure = reasonCode;
    this.logger.warn("salesforce.request.failed", { action: operation, reasonCode, httpStatus });
  }

  private succeeded(operation: string, httpStatus: number): void {
    this.lastFailure = null;
    this.logger.info("salesforce.request.completed", { action: operation, httpStatus });
  }

  private recordLimitInfo(headers: Headers): void {
    const m = /api-usage=(\d{1,12})\/(\d{1,12})/.exec(headers.get("sforce-limit-info") ?? "");
    if (m?.[1] && m[2]) this.apiUsage = { used: Number(m[1]), limit: Number(m[2]) };
  }

  private json(text: string): unknown {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  }

  private assertUnblocked(operation: string): void {
    if (this.capabilityStatus === "BLOCKED") throw new BlockedCapabilityError(this.integrationId, operation, this.prerequisites);
  }
}
