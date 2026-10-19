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

/** A reviewed operation; the model can never invent one. */
export const ConnectorOperation = z
  .strictObject({
    operationId: z.string().regex(/^[a-z][a-z0-9_.]{2,63}$/),
    kind: z.enum(["READ", "WRITE", "SUBSCRIBE", "RECONCILE_LOOKUP"]),
    enabled: z.boolean(),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    /** Path template with `{param}` placeholders from the allowlisted parameter set; no query strings. */
    pathTemplate: z.string().max(256).regex(/^\/[A-Za-z0-9._~/{}-]*$/),
    idempotency: z.enum(["NATURALLY_IDEMPOTENT", "IDEMPOTENCY_KEY_HEADER", "EXTERNAL_ID_UPSERT", "NOT_IDEMPOTENT_RECONCILE_REQUIRED"]),
    reconcileOperationId: z.string().regex(/^[a-z][a-z0-9_.]{2,63}$/).nullable(),
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
