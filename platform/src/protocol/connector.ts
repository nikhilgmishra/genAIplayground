/**
 * ConnectorProfile and CapabilityEvidence (follow-on prompt section 6; FO-04-34).
 *
 * A ConnectorProfile is the reviewed, declarative description of one tenant connection: vendor/API
 * version, documented base URL and allowed hosts, scopes, credential REFERENCE, region, account
 * binding, enabled operations, field mappings (required/optional/prohibited with type and
 * semantics), event schema, pagination, limits, idempotency/reconcile semantics, deletion
 * behaviour, retention/egress class, documentation URL, owner, capability evidence and a
 * configuration digest. It never holds a secret value, an arbitrary host, SQL, a shell command or
 * an executable mapping expression; existing read-only connections default to READ_ONLY.
 *
 * CapabilityEvidence records one connector test-wizard run and distinguishes a code pass, an
 * emulator pass and an actual vendor pass.
 *
 * Created by WP-02 in phase B; owned by WP-06 (phase B), then WP-32 (phase F).
 *
 * WP-06 added the runtime declarations as OPTIONAL fields (additive: every profile valid before stays
 * valid): typed operation parameters, per-operation pagination, rate budget, timeout, idempotency
 * key header / external-id parameter, request-body template and response records pointer; the
 * authentication scheme; capability-scoped credentials; per-stream deletion, retention and egress
 * classes; active health probes; network address class; account and region binding verification;
 * enum and time-zone tables of the bounded mapping DSL; vendor usage headers. The contract keeps
 * only structural rules; the connector runtime's profile admission
 * (platform/src/connectors/profile/validate.ts) REQUIRES these declarations for every enabled
 * operation and checks the cross-field rules before a live connector is built.
 */
import { z } from "zod";
import {
  Classification,
  DataClass,
  EvidencePointer,
  IsoDateTime,
  QualificationResult,
  Sha256Hex,
  SourceSystemId,
  VersionLabel,
  envelope,
  isAfter,
  opaqueIdWithPrefix,
} from "./common.js";

export const CONNECTOR_PROFILE_SCHEMA_VERSION = "connector-profile.v1";
export const CAPABILITY_EVIDENCE_SCHEMA_VERSION = "capability-evidence.v1";

/**
 * Secret reference: AWS ARN (Secrets Manager / KMS / SSM) or a labelled local fixture reference.
 * Same grammar as platform/src/config/schema.ts SECRET_REF_PATTERN; a pasted token fails to parse.
 */
export const CredentialRef = z
  .string()
  .max(512)
  .regex(/^(arn:aws:(secretsmanager|kms|ssm):[A-Za-z0-9-]{1,32}:[A-Za-z0-9]{1,32}:[A-Za-z0-9/_+=.@:-]{1,256}|local-fixture:[a-z0-9][a-z0-9._/-]{0,127})$/, "secret reference expected");

/** https URL without userinfo, query string or fragment. */
export const HttpsUrl = z
  .string()
  .max(512)
  .regex(/^https:\/\/[A-Za-z0-9.-]{1,253}(:\d{2,5})?(\/[A-Za-z0-9._~/-]*)?$/, "https URL without query, fragment or userinfo expected");

/** Exact DNS hostname (no wildcard, no IP literal). */
export const Hostname = z
  .string()
  .max(253)
  .regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "lowercase DNS hostname expected");

export const hostOf = (url: string): string => new URL(url).hostname.toLowerCase();

export const ConnectorFamily = z.enum([
  "contact_center",
  "sip_carrier",
  "crm",
  "cdp",
  "warehouse",
  "lakehouse",
  "business_system",
  "knowledge",
  "notification",
  "identity",
  "model_provider",
]);
export type ConnectorFamily = z.infer<typeof ConnectorFamily>;

export const ConnectorWriteMode = z.enum(["READ_ONLY", "SANDBOX_WRITE", "PRODUCTION_WRITE"]);
export type ConnectorWriteMode = z.infer<typeof ConnectorWriteMode>;

/** RFC 6901 JSON pointer, bounded; the empty pointer is the whole document. Never an expression. */
export const JsonPointer = z.string().max(200).regex(/^(\/([A-Za-z0-9_.$@-]|~[01])*)*$/, "JSON pointer expected");

/** Capability id a connector operation, credential or probe serves (same grammar as CapabilityEvidence.capability). */
export const ConnectorCapabilityId = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$/);

/** Name of a query parameter or HTTP header the profile may set; never a free-form string. */
const WireName = z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,40}$/);
const OperationIdRef = z.string().regex(/^[a-z][a-z0-9_.]{2,63}$/);
const InputFieldName = z.string().regex(/^[a-z][a-zA-Z0-9_]{0,40}$/);

/**
 * Typed parameter of a reviewed operation. Values are validated against the type before a request is
 * built: none of the types admits `/`, `?`, `#`, `%`, whitespace or `..`, so a parameter can never add a
 * path segment, a query string or a host (FO-06-23).
 */
export const OperationParam = z.strictObject({
  name: InputFieldName,
  in: z.enum(["path", "query"]),
  /** Wire name of a query parameter; null for a path parameter (named by its `{name}` placeholder). */
  wireName: WireName.nullable(),
  type: z.enum(["opaque_id", "token", "integer", "enum_code", "date", "instant"]),
  required: z.boolean(),
  maxLength: z.number().int().min(1).max(200),
  enumValues: z.array(z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/)).min(1).max(64).nullable(),
  integerRange: z.strictObject({ min: z.number().int().min(-1_000_000_000), max: z.number().int().max(1_000_000_000) }).nullable(),
});
export type OperationParam = z.infer<typeof OperationParam>;

/** Documented pagination of one operation, bounded in page size and page count (FO-06-06). */
export const OperationPagination = z.strictObject({
  strategy: z.enum(["NONE", "CURSOR", "PAGE_TOKEN", "KEYSET", "OFFSET", "NEXT_LINK"]),
  maxPageSize: z.number().int().min(1).max(1_000),
  maxPages: z.number().int().min(1).max(1_000),
  pageSizeParam: WireName.nullable(),
  /** Query parameter carrying the cursor, page token, keyset value or offset. */
  cursorParam: WireName.nullable(),
  /** Where the response carries the next cursor / page token / keyset value / next link. */
  nextPointer: JsonPointer.nullable(),
  /** Vendor status that means the cursor expired (for example 410); surfaces as CURSOR_EXPIRED. */
  cursorExpiredStatus: z.number().int().min(400).max(499).nullable(),
});
export type OperationPagination = z.infer<typeof OperationPagination>;

/** Per-operation rate and concurrency sub-budget inside the connector's `limits` (FO-06-07, FO-06-16). */
export const OperationRateBudget = z.strictObject({
  requestsPerSecond: z.number().min(0.01).max(10_000),
  burst: z.number().int().min(1).max(10_000),
  maxConcurrency: z.number().int().min(1).max(1_000),
});
export type OperationRateBudget = z.infer<typeof OperationRateBudget>;

/** One field of a write request body: a typed input placed at a reviewed JSON pointer (no expressions). */
export const OperationRequestField = z.strictObject({
  targetPointer: JsonPointer.refine((p) => p.length > 0, "non-empty pointer expected"),
  inputField: InputFieldName,
  type: z.enum(["string", "integer", "number", "boolean", "instant", "date", "money_minor_units", "currency_code", "enum_code", "opaque_id"]),
  requirement: z.enum(["REQUIRED", "OPTIONAL"]),
  classification: Classification,
  maxLength: z.number().int().min(1).max(4_000),
});
export type OperationRequestField = z.infer<typeof OperationRequestField>;

/** A reviewed operation; the model can never invent one. */
export const ConnectorOperation = z
  .strictObject({
    operationId: OperationIdRef,
    kind: z.enum(["READ", "WRITE", "SUBSCRIBE", "RECONCILE_LOOKUP"]),
    enabled: z.boolean(),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    /** Path template with `{param}` placeholders from the allowlisted parameter set; no query strings. */
    pathTemplate: z.string().max(256).regex(/^\/[A-Za-z0-9._~/{}-]*$/),
    idempotency: z.enum(["NATURALLY_IDEMPOTENT", "IDEMPOTENCY_KEY_HEADER", "EXTERNAL_ID_UPSERT", "NOT_IDEMPOTENT_RECONCILE_REQUIRED"]),
    reconcileOperationId: OperationIdRef.nullable(),
    // ---- runtime declarations (WP-06; optional in the contract, required by profile admission) ----
    /** Capability this operation serves: selects the capability-scoped credential and the readiness row. */
    capability: ConnectorCapabilityId.optional(),
    params: z.array(OperationParam).max(16).optional(),
    timeoutMs: z.number().int().min(100).max(30_000).optional(),
    pagination: OperationPagination.optional(),
    rateBudget: OperationRateBudget.optional(),
    /** Header carrying the server-derived idempotency key (IDEMPOTENCY_KEY_HEADER). */
    idempotencyKeyHeader: WireName.nullable().optional(),
    /** Path parameter carrying the server-derived external id (EXTERNAL_ID_UPSERT). */
    externalIdParam: InputFieldName.nullable().optional(),
    /** Scopes the operation needs; each must be declared on the profile and granted to the token. */
    requiredScopes: z.array(z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:/-]+$/)).max(16).optional(),
    /** Source object (FieldMapping.sourceObject) of the records the response carries. */
    responseObject: z.string().regex(/^[A-Za-z][A-Za-z0-9_.]{0,63}$/).nullable().optional(),
    /** Where the response carries the records array (empty pointer: the body is one record). */
    recordsPointer: JsonPointer.nullable().optional(),
    requestBody: z.strictObject({ fields: z.array(OperationRequestField).min(1).max(64) }).nullable().optional(),
    /** HTTP statuses that mean success for this operation (anything else is classified as a failure). */
    successStatuses: z.array(z.number().int().min(200).max(299)).min(1).max(5).optional(),
  })
  .superRefine((o, ctx) => {
    if (o.kind === "WRITE" && o.method === "GET") ctx.addIssue({ code: "custom", message: "WRITE_OVER_GET", path: ["method"] });
    if (o.kind === "WRITE" && o.idempotency === "NOT_IDEMPOTENT_RECONCILE_REQUIRED" && o.reconcileOperationId === null) {
      ctx.addIssue({ code: "custom", message: "NON_IDEMPOTENT_WRITE_WITHOUT_RECONCILE", path: ["reconcileOperationId"] });
    }
  });
export type ConnectorOperation = z.infer<typeof ConnectorOperation>;

export const FieldMapping = z
  .strictObject({
    sourceObject: z.string().regex(/^[A-Za-z][A-Za-z0-9_.]{0,63}$/),
    /** RFC 6901 JSON pointer into the reviewed source payload. */
    sourcePointer: z.string().max(200).regex(/^(\/([A-Za-z0-9_.~-]|~[01])*)+$/),
    targetField: z.string().regex(/^[a-z][a-zA-Z0-9_.]{0,80}$/),
    requirement: z.enum(["REQUIRED", "OPTIONAL", "PROHIBITED"]),
    type: z.enum(["string", "integer", "number", "boolean", "instant", "date", "money_minor_units", "currency_code", "enum_code", "opaque_id"]),
    /** Semantic check beyond type, e.g. `status_code_table:billing.v2`; null when the type is enough. */
    semantic: z.string().regex(/^[a-z][a-z0-9_.:-]{2,80}$/).nullable(),
    authoritative: z.boolean(),
    classification: Classification,
  })
  .superRefine((m, ctx) => {
    if (m.requirement === "PROHIBITED" && m.authoritative) ctx.addIssue({ code: "custom", message: "PROHIBITED_FIELD_AUTHORITATIVE", path: ["authoritative"] });
    if (m.classification === "VERIFICATION_SECRET" && m.requirement !== "PROHIBITED") {
      ctx.addIssue({ code: "custom", message: "VERIFICATION_SECRET_MAPPED", path: ["requirement"] });
    }
  });
export type FieldMapping = z.infer<typeof FieldMapping>;

/** Documented authentication scheme of the connector (FO-06-03, FO-06-14). */
export const ConnectorAuth = z.strictObject({
  scheme: z.enum(["OAUTH2_CLIENT_CREDENTIALS", "OAUTH2_JWT_BEARER", "SIGNED_JWT_BEARER", "API_KEY_HEADER"]),
  /** Token endpoint (OAuth schemes); its host must be one of allowedHosts. */
  tokenUrl: HttpsUrl.nullable(),
  /** How the client authenticates to the token endpoint (OAuth client credentials). */
  clientAuth: z.enum(["CLIENT_SECRET_POST", "CLIENT_SECRET_BASIC", "PRIVATE_KEY_JWT"]).nullable(),
  /** `aud` of a signed assertion or self-signed bearer JWT. */
  audience: z.string().min(1).max(256).regex(/^[A-Za-z0-9_.:/-]+$/).nullable(),
  /** Client-side upper bound on token reuse (the vendor's expires_in can only shorten it). */
  tokenMaxAgeSeconds: z.number().int().min(60).max(86_400),
  /** Header carrying the key (API_KEY_HEADER). */
  apiKeyHeader: WireName.nullable(),
});
export type ConnectorAuth = z.infer<typeof ConnectorAuth>;

/** A least-privilege credential for one capability and access (FO-05-56). */
export const CapabilityCredential = z.strictObject({
  capability: ConnectorCapabilityId,
  access: z.enum(["READ", "WRITE"]),
  credentialRef: CredentialRef,
  scopes: z.array(z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:/-]+$/)).max(32),
});
export type CapabilityCredential = z.infer<typeof CapabilityCredential>;

/** One data stream (source object) with its deletion behaviour and retention / egress classes (FO-06-17). */
export const ConnectorStream = z.strictObject({
  streamId: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
  sourceObject: z.string().regex(/^[A-Za-z][A-Za-z0-9_.]{0,63}$/),
  deletionBehavior: z.enum(["DELETE_EVENT", "TOMBSTONE", "SOFT_DELETE_FLAG", "RECONCILIATION_ONLY", "NOT_SUPPORTED"]),
  retentionClass: DataClass,
  egressClass: Classification,
  /** Documented vendor deletion operation (privacy deletion propagation); null when the vendor has none. */
  vendorDeletionOperationId: OperationIdRef.nullable(),
  /** Pinned event schema of the stream's change events; null for a read-only polled stream. */
  eventSchema: z.strictObject({ schemaRef: z.string().regex(/^[a-z][a-z0-9_.:-]{2,80}$/), version: VersionLabel }).nullable(),
});
export type ConnectorStream = z.infer<typeof ConnectorStream>;

/** Active probes of the connector test wizard and the health check (FO-06-11). */
export const ConnectorHealthProbes = z.strictObject({
  /** Operation returning the vendor's metadata for the mapped objects. */
  metadataOperationId: OperationIdRef.nullable(),
  metadataFormat: z.enum(["JSON_SCHEMA", "FIELD_DESCRIBE"]).nullable(),
  /** Approved synthetic record read through the production mapping. */
  syntheticRecord: z
    .strictObject({
      operationId: OperationIdRef,
      params: z.array(z.strictObject({ name: InputFieldName, value: z.union([z.string().max(200), z.number().int().min(-1_000_000_000).max(1_000_000_000)]) })).max(16),
    })
    .nullable(),
});
export type ConnectorHealthProbes = z.infer<typeof ConnectorHealthProbes>;

/** Address class the connector's hosts must resolve to (DNS rebinding defence, FO-06-20). */
export const ConnectorNetwork = z.strictObject({
  addressClass: z.enum(["PUBLIC_INTERNET", "PRIVATE_NETWORK"]),
  /** Private CA of an internal API (a reference into the secret store, never the PEM itself). */
  tlsCaRef: CredentialRef.nullable(),
});
export type ConnectorNetwork = z.infer<typeof ConnectorNetwork>;

/** Where a vendor value is read: a JSON pointer into the token response or a response header. */
export const BindingSource = z.strictObject({
  source: z.enum(["TOKEN_RESPONSE", "RESPONSE_HEADER"]),
  /** JSON pointer (TOKEN_RESPONSE) or header name (RESPONSE_HEADER). */
  locator: z.string().min(1).max(200).regex(/^(\/([A-Za-z0-9_.$@-]|~[01])*)+$|^[A-Za-z][A-Za-z0-9_.-]{0,40}$/),
});
export type BindingSource = z.infer<typeof BindingSource>;

export const ConnectorBindingVerification = z.strictObject({
  /** The value must equal accountBinding.externalAccountRef on the first authenticated exchange. */
  account: BindingSource.nullable(),
  /** The value must equal `region`. */
  region: BindingSource.nullable(),
});
export type ConnectorBindingVerification = z.infer<typeof ConnectorBindingVerification>;

export const ConnectorMappingTables = z.strictObject({
  enums: z
    .array(
      z.strictObject({
        tableId: z.string().regex(/^[a-z][a-z0-9_.-]{1,60}$/),
        entries: z.array(z.strictObject({ from: z.string().min(1).max(64), to: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/) })).min(1).max(256),
      }),
    )
    .max(32),
  timeZones: z
    .array(
      z.strictObject({
        zoneKey: z.string().regex(/^[a-z][a-z0-9_]{1,30}$/),
        ianaZone: z.string().regex(/^(UTC|[A-Za-z_]{2,30}(\/[A-Za-z0-9_+-]{2,30}){1,2})$/),
      }),
    )
    .max(8),
});
export type ConnectorMappingTables = z.infer<typeof ConnectorMappingTables>;

export const ConnectorProfile = z
  .strictObject({
    ...envelope(CONNECTOR_PROFILE_SCHEMA_VERSION, ["tenantId", "occurredAt"], ["causationId"]),
    profileId: opaqueIdWithPrefix("cnp"),
    profileVersion: z.number().int().min(1).max(1_000_000),
    family: ConnectorFamily,
    system: SourceSystemId,
    vendor: z.strictObject({
      name: z.string().regex(/^[a-z][a-z0-9_-]{1,40}$/),
      api: z.string().regex(/^[a-z][a-z0-9_.-]{1,63}$/),
      apiVersion: VersionLabel,
    }),
    baseUrl: HttpsUrl,
    allowedHosts: z.array(Hostname).min(1).max(16),
    scopes: z.array(z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:/-]+$/)).max(64),
    credentialRef: CredentialRef,
    region: z.string().regex(/^[a-z]{2}(-[a-z]+)+-[0-9]$|^global$|^local$/),
    accountBinding: z.strictObject({
      /** Vendor account / org / instance id the credential belongs to (opaque). */
      externalAccountRef: z.string().min(3).max(128).regex(/^[A-Za-z0-9_.:-]+$/),
      tenantBindingVerified: z.boolean(),
    }),
    writeMode: ConnectorWriteMode,
    operations: z.array(ConnectorOperation).min(1).max(64),
    mappings: z.array(FieldMapping).max(256),
    eventSchema: z.strictObject({ schemaRef: z.string().regex(/^[a-z][a-z0-9_.:-]{2,80}$/), version: VersionLabel }).nullable(),
    pagination: z.strictObject({
      strategy: z.enum(["NONE", "CURSOR", "PAGE_TOKEN", "KEYSET", "OFFSET"]),
      maxPageSize: z.number().int().min(1).max(1_000),
    }),
    limits: z.strictObject({
      requestsPerSecond: z.number().min(0.01).max(10_000),
      maxConcurrency: z.number().int().min(1).max(1_000),
      timeoutMs: z.number().int().min(100).max(30_000),
      retryBudget: z.number().int().min(0).max(5),
    }),
    deletionBehavior: z.enum(["DELETE_EVENT", "TOMBSTONE", "SOFT_DELETE_FLAG", "RECONCILIATION_ONLY", "NOT_SUPPORTED"]),
    retentionClass: DataClass,
    egressClass: Classification,
    documentationUrl: HttpsUrl,
    ownerRole: z.string().regex(/^[a-z][a-z_]{2,40}$/),
    capabilityEvidenceRefs: z.array(opaqueIdWithPrefix("cpe")).max(64),
    // ---- runtime declarations (WP-06; optional in the contract, required by profile admission) ----
    auth: ConnectorAuth.optional(),
    /** One least-privilege credential per capability and access (FO-05-56); the read and write identities differ. */
    capabilityCredentials: z.array(CapabilityCredential).max(32).optional(),
    /** Deletion behaviour and retention / egress class per data stream (FO-06-17). */
    streams: z.array(ConnectorStream).max(32).optional(),
    /** Active health probes: authenticate, read metadata, read the approved synthetic record (FO-06-11). */
    health: ConnectorHealthProbes.optional(),
    network: ConnectorNetwork.optional(),
    /** Where the vendor reports the account and region a credential belongs to (FO-06-13). */
    bindingVerification: ConnectorBindingVerification.optional(),
    /** Tables of the bounded mapping DSL: enum maps and business time zones referenced by FieldMapping.semantic. */
    mappingTables: ConnectorMappingTables.optional(),
    /** Vendor rate-limit usage headers, exported as content-free usage metrics (FO-06-07). */
    usageHeaders: z.strictObject({ remaining: WireName, limit: WireName }).nullable().optional(),
    /** sha256 over the canonical profile without this field. */
    configDigest: Sha256Hex,
  })
  .superRefine((p, ctx) => {
    const hosts = new Set(p.allowedHosts);
    if (!hosts.has(hostOf(p.baseUrl))) ctx.addIssue({ code: "custom", message: "BASE_URL_HOST_NOT_ALLOWED", path: ["baseUrl"] });
    if (hosts.size !== p.allowedHosts.length) ctx.addIssue({ code: "custom", message: "DUPLICATE_ALLOWED_HOST", path: ["allowedHosts"] });
    const ids = new Set<string>();
    p.operations.forEach((o, i) => {
      if (ids.has(o.operationId)) ctx.addIssue({ code: "custom", message: "DUPLICATE_OPERATION", path: ["operations", i, "operationId"] });
      ids.add(o.operationId);
      if (o.kind === "WRITE" && o.enabled && p.writeMode === "READ_ONLY") ctx.addIssue({ code: "custom", message: "WRITE_ENABLED_ON_READ_ONLY_PROFILE", path: ["operations", i, "enabled"] });
    });
    p.operations.forEach((o, i) => {
      if (o.reconcileOperationId !== null && !ids.has(o.reconcileOperationId)) ctx.addIssue({ code: "custom", message: "UNKNOWN_RECONCILE_OPERATION", path: ["operations", i, "reconcileOperationId"] });
    });
    if (p.writeMode !== "READ_ONLY" && !p.accountBinding.tenantBindingVerified) {
      ctx.addIssue({ code: "custom", message: "WRITES_WITHOUT_VERIFIED_ACCOUNT_BINDING", path: ["accountBinding", "tenantBindingVerified"] });
    }
    if (p.credentialRef.startsWith("local-fixture:") && p.writeMode === "PRODUCTION_WRITE") {
      ctx.addIssue({ code: "custom", message: "FIXTURE_CREDENTIAL_FOR_PRODUCTION_WRITES", path: ["credentialRef"] });
    }
  });
export type ConnectorProfile = z.infer<typeof ConnectorProfile>;

/* ------------------------------------------------------------------------ */
/* CapabilityEvidence                                                        */
/* ------------------------------------------------------------------------ */

/** What the evidence proves: code alone, the production adapter against an emulator, or the actual vendor. */
export const EvidenceLevel = z.enum(["CODE_PASS", "EMULATOR_PASS", "VENDOR_SANDBOX_PASS", "VENDOR_PRODUCTION_PASS"]);
export type EvidenceLevel = z.infer<typeof EvidenceLevel>;

/** Connector test-wizard steps (follow-on prompt section 6). */
export const WizardStep = z.enum([
  "VALIDATE_CONFIGURATION",
  "AUTHENTICATE",
  "INSPECT_METADATA",
  "INSPECT_SYNTHETIC_RECORD",
  "COMPARE_MAPPING",
  "FRESHNESS_TEST",
  "WRITE_RECONCILE_TEST",
]);
export type WizardStep = z.infer<typeof WizardStep>;

export const CapabilityEvidence = z
  .strictObject({
    ...envelope(CAPABILITY_EVIDENCE_SCHEMA_VERSION, ["tenantId", "occurredAt", "expiresAt"], ["causationId"]),
    evidenceId: opaqueIdWithPrefix("cpe"),
    profileId: opaqueIdWithPrefix("cnp"),
    profileConfigDigest: Sha256Hex,
    capability: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$/),
    level: EvidenceLevel,
    result: QualificationResult,
    steps: z.array(z.strictObject({ step: WizardStep, result: QualificationResult, detailCode: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/) })).min(1).max(7),
    evidenceRef: EvidencePointer,
    evidenceDigest: Sha256Hex,
    /** Required for vendor levels: the accountable operator signs; software never self-signs vendor evidence. */
    signature: z
      .strictObject({
        signerRole: z.enum(["deployment_operator", "security_admin", "integration_owner"]),
        keyRef: CredentialRef,
        algorithm: z.enum(["ECDSA_P256_SHA256", "RSASSA_PSS_SHA256", "ED25519"]),
        value: z.string().min(16).max(1024).regex(/^[A-Za-z0-9_-]+$/),
        signedAt: IsoDateTime,
      })
      .nullable(),
  })
  .superRefine((e, ctx) => {
    if (!isAfter(e.expiresAt, e.occurredAt)) ctx.addIssue({ code: "custom", message: "EVIDENCE_EXPIRY_NOT_AFTER_RUN", path: ["expiresAt"] });
    const vendor = e.level === "VENDOR_SANDBOX_PASS" || e.level === "VENDOR_PRODUCTION_PASS";
    if (vendor && e.signature === null) ctx.addIssue({ code: "custom", message: "VENDOR_EVIDENCE_UNSIGNED", path: ["signature"] });
    // A local fixture key is software's own key; it never signs evidence of an actual vendor run.
    if (vendor && e.signature !== null && e.signature.keyRef.startsWith("local-fixture:")) {
      ctx.addIssue({ code: "custom", message: "VENDOR_EVIDENCE_FIXTURE_KEY", path: ["signature", "keyRef"] });
    }
    if (e.result === "PASS" && e.steps.some((s) => s.result === "FAIL" || s.result === "INCONCLUSIVE")) {
      ctx.addIssue({ code: "custom", message: "PASS_WITH_FAILED_STEP", path: ["result"] });
    }
    if (new Set(e.steps.map((s) => s.step)).size !== e.steps.length) ctx.addIssue({ code: "custom", message: "DUPLICATE_STEP", path: ["steps"] });
  });
export type CapabilityEvidence = z.infer<typeof CapabilityEvidence>;
