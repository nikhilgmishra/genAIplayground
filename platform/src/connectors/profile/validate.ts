/**
 * ConnectorProfile admission (WP-06; FO-06-12..18, FO-05-56, FO-06-23).
 *
 * The contract (platform/src/protocol/connector.ts) checks structure. Admission decides whether a
 * profile may back a LIVE connector, and it is stricter: every declaration the runtime enforces must be
 * present and consistent, otherwise the profile is refused with reason codes and nothing is built:
 *   identity        vendor, API, API version, documentation URL and owner (FO-06-12), digest matches;
 *   network         token endpoint host in allowedHosts, explicit address class (FO-06-13, FO-06-20);
 *   auth            documented scheme with its required fields (FO-06-03, FO-06-14);
 *   per operation   capability, typed params, timeout, rate budget, pagination with bounds, success
 *                   statuses, required scopes declared on the profile (FO-06-16), template checks
 *                   (FO-06-23), response mapping compiles (FO-06-05);
 *   writes          an idempotency mechanism AND a reconcile lookup (or a naturally idempotent PUT /
 *                   DELETE); never on a READ_ONLY profile (FO-06-16, ACT-02, ACT-03);
 *   credentials     one least-privilege credential per capability and access, never shared between
 *                   capabilities, read and write, or with the profile default (FO-05-56);
 *   streams         deletion behaviour, retention and egress class per mapped source object (FO-06-17);
 *   probes          metadata and synthetic-record probes reference enabled reads (FO-06-11);
 *   binding         where the vendor reports account and region; writes need account verification.
 */
import { CredentialRef, ConnectorProfile } from "../../protocol/connector.js";
import type { ConnectorOperation, ConnectorProfile as ConnectorProfileT } from "../../protocol/connector.js";
import type { Classification, Environment } from "../../protocol/common.js";
import { computeConnectorProfileDigest } from "../../protocol/digests.js";
import { PlatformError } from "../../shared/errors.js";
import { MappingDefinitionError } from "../dsl/errors.js";
import { compileMapping, compileTables } from "../dsl/mapping.js";
import type { CompiledMapping } from "../dsl/mapping.js";
import { checkOperationTemplate, paramWireValue } from "../dsl/template.js";

/** A profile the runtime may use: parsed, digest-checked, every mapping compiled. */
export interface AdmittedProfile {
  readonly profile: ConnectorProfileT;
  readonly digest: string;
  readonly operations: ReadonlyMap<string, ConnectorOperation>;
  /** Compiled mapping per source object (keyed by FieldMapping.sourceObject). */
  readonly mappings: ReadonlyMap<string, CompiledMapping>;
  readonly environment: Environment;
}

/** Refusal with every violated rule (reason codes only; never profile values). */
export class ProfileRejectedError extends PlatformError {
  constructor(readonly violations: readonly string[]) {
    super("CONNECTOR_PROFILE_REJECTED", `CONNECTOR_PROFILE_REJECTED:${[...new Set(violations)].sort().join(",")}`, false);
  }
}

const CLASS_RANK: Record<Classification, number> = { PUBLIC: 0, INTERNAL: 1, FINANCIAL: 2, PHI: 3, PHI_RESTRICTED: 4, VERIFICATION_SECRET: 5 };
const READ_KINDS = new Set(["READ", "SUBSCRIBE", "RECONCILE_LOOKUP"]);

const hostOfUrl = (u: string): string => new URL(u).hostname.toLowerCase();

function presenceViolations(raw: unknown): string[] {
  const v: string[] = [];
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const vendor = (typeof o.vendor === "object" && o.vendor !== null ? o.vendor : {}) as Record<string, unknown>;
  if (typeof vendor.name !== "string" || vendor.name === "") v.push("PROFILE_VENDOR_MISSING");
  if (typeof vendor.api !== "string" || vendor.api === "") v.push("PROFILE_API_MISSING");
  if (typeof vendor.apiVersion !== "string" || vendor.apiVersion === "") v.push("PROFILE_API_VERSION_MISSING");
  if (typeof o.documentationUrl !== "string" || o.documentationUrl === "") v.push("PROFILE_DOCUMENTATION_URL_MISSING");
  if (typeof o.ownerRole !== "string" || o.ownerRole === "") v.push("PROFILE_OWNER_MISSING");
  return v;
}

function operationViolations(p: ConnectorProfileT, op: ConnectorOperation, ids: ReadonlyMap<string, ConnectorOperation>): string[] {
  const v: string[] = [];
  if (!op.enabled) return v;
  if (!op.capability) v.push("OPERATION_CAPABILITY_MISSING");
  if (op.params === undefined) v.push("OPERATION_PARAMS_MISSING");
  if (op.timeoutMs === undefined) v.push("OPERATION_TIMEOUT_MISSING");
  if (op.rateBudget === undefined) v.push("OPERATION_RATE_BUDGET_MISSING");
  if (op.pagination === undefined) v.push("OPERATION_PAGINATION_MISSING");
  if (op.successStatuses === undefined) v.push("OPERATION_SUCCESS_STATUSES_MISSING");
  if (op.rateBudget && (op.rateBudget.requestsPerSecond > p.limits.requestsPerSecond || op.rateBudget.maxConcurrency > p.limits.maxConcurrency)) v.push("OPERATION_BUDGET_EXCEEDS_CONNECTOR");
  if (op.timeoutMs !== undefined && op.timeoutMs > p.limits.timeoutMs) v.push("OPERATION_TIMEOUT_EXCEEDS_CONNECTOR");
  for (const s of op.requiredScopes ?? []) if (!p.scopes.includes(s)) v.push("OPERATION_SCOPE_UNDECLARED");
  const pg = op.pagination;
  if (pg) {
    if (pg.maxPageSize > p.pagination.maxPageSize) v.push("OPERATION_PAGE_SIZE_EXCEEDS_CONNECTOR");
    if (pg.strategy !== "NONE") {
      if (pg.nextPointer === null) v.push("PAGINATION_NEXT_POINTER_MISSING");
      if (pg.strategy !== "NEXT_LINK" && pg.cursorParam === null) v.push("PAGINATION_CURSOR_PARAM_MISSING");
      // OFFSET ends a read at the first page shorter than the page size, so the page size must be the one
      // requested: with the vendor's default page size a full default page would end the read early.
      if (pg.strategy === "OFFSET" && pg.pageSizeParam === null) v.push("PAGINATION_PAGE_SIZE_PARAM_MISSING");
      if (op.recordsPointer === undefined || op.recordsPointer === null || op.recordsPointer === "") v.push("PAGINATION_RECORDS_POINTER_MISSING");
      if (op.kind === "WRITE") v.push("PAGINATION_ON_WRITE");
    }
  }
  try {
    checkOperationTemplate(op);
  } catch (err) {
    v.push(err instanceof MappingDefinitionError ? err.reasonCode : "TEMPLATE_INVALID");
  }
  if (op.kind === "WRITE") {
    if (p.writeMode === "READ_ONLY") v.push("WRITE_ENABLED_ON_READ_ONLY_PROFILE");
    if (op.idempotency === "IDEMPOTENCY_KEY_HEADER" && !op.idempotencyKeyHeader) v.push("WRITE_IDEMPOTENCY_HEADER_MISSING");
    if (op.idempotency === "EXTERNAL_ID_UPSERT" && !op.externalIdParam) v.push("WRITE_EXTERNAL_ID_PARAM_MISSING");
    if (op.idempotency === "NATURALLY_IDEMPOTENT" && op.method !== "PUT" && op.method !== "DELETE") v.push("WRITE_NOT_NATURALLY_IDEMPOTENT");
    if (op.idempotency !== "NATURALLY_IDEMPOTENT" && op.reconcileOperationId === null) v.push("WRITE_WITHOUT_RECONCILE");
    if (op.reconcileOperationId !== null) {
      const r = ids.get(op.reconcileOperationId);
      if (!r || !r.enabled || r.method !== "GET" || (r.kind !== "RECONCILE_LOOKUP" && r.kind !== "READ")) v.push("RECONCILE_OPERATION_INVALID");
    }
  } else if ((op.kind === "RECONCILE_LOOKUP" && op.method !== "GET") || op.method === "PUT" || op.method === "PATCH" || op.method === "DELETE") {
    // Reads are GET (or a documented POST query such as a SQL API statement); never a mutating verb.
    v.push("READ_METHOD_INVALID");
  }
  return v;
}

function credentialViolations(p: ConnectorProfileT, environment: Environment): string[] {
  const v: string[] = [];
  const local = environment === "local" || environment === "ci";
  const creds = p.capabilityCredentials;
  const allRefs = [p.credentialRef, ...(creds ?? []).map((c) => c.credentialRef), ...(p.network?.tlsCaRef ? [p.network.tlsCaRef] : [])];
  for (const r of allRefs) {
    if (!CredentialRef.safeParse(r).success) v.push("CREDENTIAL_REF_INVALID");
    if (r.startsWith("local-fixture:") && !local) v.push("FIXTURE_CREDENTIAL_OUTSIDE_LOCAL");
    if (r.startsWith("arn:aws:kms:")) v.push("CREDENTIAL_REF_NOT_A_SECRET");
  }
  if (!creds || creds.length === 0) {
    v.push("CAPABILITY_CREDENTIALS_MISSING");
    return v;
  }
  const pairs = new Set<string>();
  const byRef = new Map<string, string>();
  for (const c of creds) {
    const pair = `${c.capability}|${c.access}`;
    if (pairs.has(pair)) v.push("CAPABILITY_CREDENTIAL_DUPLICATE");
    pairs.add(pair);
    const prior = byRef.get(c.credentialRef);
    if (prior !== undefined && prior !== pair) v.push("CREDENTIAL_REUSED_ACROSS_CAPABILITIES");
    byRef.set(c.credentialRef, pair);
    for (const s of c.scopes) if (!p.scopes.includes(s)) v.push("CREDENTIAL_SCOPE_UNDECLARED");
    if (c.access === "WRITE" && c.credentialRef === p.credentialRef) v.push("DEFAULT_CREDENTIAL_IS_WRITE_CREDENTIAL");
    if (c.access === "WRITE" && p.writeMode === "READ_ONLY") v.push("WRITE_CREDENTIAL_ON_READ_ONLY_PROFILE");
  }
  for (const op of p.operations.filter((o) => o.enabled && o.capability)) {
    const access = op.kind === "WRITE" ? "WRITE" : "READ";
    const c = creds.find((x) => x.capability === op.capability && x.access === access);
    if (!c) v.push("CAPABILITY_CREDENTIAL_MISSING");
    else for (const s of op.requiredScopes ?? []) if (!c.scopes.includes(s)) v.push("CAPABILITY_CREDENTIAL_SCOPE_MISSING");
  }
  return v;
}

function authViolations(p: ConnectorProfileT): string[] {
  const v: string[] = [];
  const a = p.auth;
  if (!a) return ["PROFILE_AUTH_MISSING"];
  const oauth = a.scheme === "OAUTH2_CLIENT_CREDENTIALS" || a.scheme === "OAUTH2_JWT_BEARER";
  if (oauth) {
    if (a.tokenUrl === null) v.push("AUTH_TOKEN_URL_MISSING");
    else if (!p.allowedHosts.includes(hostOfUrl(a.tokenUrl))) v.push("AUTH_TOKEN_HOST_NOT_ALLOWED");
    if (a.scheme === "OAUTH2_CLIENT_CREDENTIALS" && (a.clientAuth === null || a.clientAuth === "PRIVATE_KEY_JWT")) v.push("AUTH_CLIENT_AUTH_INVALID");
    if (a.scheme === "OAUTH2_JWT_BEARER" && a.clientAuth !== "PRIVATE_KEY_JWT") v.push("AUTH_CLIENT_AUTH_INVALID");
  } else if (a.tokenUrl !== null) {
    v.push("AUTH_TOKEN_URL_UNEXPECTED");
  }
  if ((a.scheme === "OAUTH2_JWT_BEARER" || a.scheme === "SIGNED_JWT_BEARER") && a.audience === null) v.push("AUTH_AUDIENCE_MISSING");
  if (a.scheme === "API_KEY_HEADER" && a.apiKeyHeader === null) v.push("AUTH_API_KEY_HEADER_MISSING");
  if (a.scheme !== "API_KEY_HEADER" && a.apiKeyHeader !== null) v.push("AUTH_API_KEY_HEADER_UNEXPECTED");
  return v;
}

function streamViolations(p: ConnectorProfileT, ids: ReadonlyMap<string, ConnectorOperation>): string[] {
  const v: string[] = [];
  const streams = p.streams;
  const readObjects = new Set(p.operations.filter((o) => o.enabled && READ_KINDS.has(o.kind) && o.responseObject).map((o) => o.responseObject as string));
  if (!streams) return readObjects.size > 0 ? ["PROFILE_STREAMS_MISSING"] : [];
  const seenIds = new Set<string>();
  for (const s of streams) {
    if (seenIds.has(s.streamId)) v.push("STREAM_DUPLICATE");
    seenIds.add(s.streamId);
    if (s.vendorDeletionOperationId !== null && !ids.has(s.vendorDeletionOperationId)) v.push("STREAM_DELETION_OPERATION_UNKNOWN");
    if (CLASS_RANK[s.egressClass] > CLASS_RANK[p.egressClass]) v.push("STREAM_EGRESS_EXCEEDS_PROFILE");
  }
  for (const obj of readObjects) if (!streams.some((s) => s.sourceObject === obj)) v.push("STREAM_MISSING_FOR_SOURCE_OBJECT");
  return v;
}

function probeViolations(p: ConnectorProfileT, ids: ReadonlyMap<string, ConnectorOperation>): string[] {
  const v: string[] = [];
  const h = p.health;
  if (!h) return ["PROFILE_HEALTH_PROBES_MISSING"];
  const readable = (id: string) => {
    const op = ids.get(id);
    return op !== undefined && op.enabled && op.method === "GET" && op.kind !== "WRITE";
  };
  if (h.metadataOperationId !== null && !readable(h.metadataOperationId)) v.push("HEALTH_METADATA_OPERATION_INVALID");
  if ((h.metadataOperationId === null) !== (h.metadataFormat === null)) v.push("HEALTH_METADATA_FORMAT_MISMATCH");
  if (h.syntheticRecord !== null) {
    const op = ids.get(h.syntheticRecord.operationId);
    if (!op || !readable(h.syntheticRecord.operationId)) v.push("HEALTH_SYNTHETIC_OPERATION_INVALID");
    else {
      for (const { name, value } of h.syntheticRecord.params) {
        const decl = (op.params ?? []).find((x) => x.name === name);
        try {
          if (!decl) throw new MappingDefinitionError("X");
          paramWireValue(decl, value);
        } catch {
          v.push("HEALTH_SYNTHETIC_PARAMS_INVALID");
        }
      }
    }
  }
  return v;
}

function bindingViolations(p: ConnectorProfileT): string[] {
  const b = p.bindingVerification;
  if (!b) return ["PROFILE_BINDING_VERIFICATION_MISSING"];
  const writes = p.operations.some((o) => o.enabled && o.kind === "WRITE");
  const v: string[] = [];
  if (writes && b.account === null) v.push("WRITES_WITHOUT_ACCOUNT_VERIFICATION");
  if (p.accountBinding.tenantBindingVerified && b.account === null) v.push("BINDING_VERIFIED_WITHOUT_SOURCE");
  for (const s of [b.account, b.region]) {
    if (s === null) continue;
    if (s.source === "TOKEN_RESPONSE" && !s.locator.startsWith("/")) v.push("BINDING_LOCATOR_INVALID");
    if (s.source === "RESPONSE_HEADER" && s.locator.startsWith("/")) v.push("BINDING_LOCATOR_INVALID");
    if (s.source === "TOKEN_RESPONSE" && (p.auth?.scheme === "API_KEY_HEADER" || p.auth?.scheme === "SIGNED_JWT_BEARER")) v.push("BINDING_SOURCE_WITHOUT_TOKEN_RESPONSE");
  }
  return v;
}

/**
 * Admits a profile for live use, or throws ProfileRejectedError with every violation. `raw` is untrusted
 * (a file, the configuration store or the operator studio).
 */
export function admitConnectorProfile(raw: unknown, environment: Environment): AdmittedProfile {
  const presence = presenceViolations(raw);
  const parsed = ConnectorProfile.safeParse(raw);
  if (!parsed.success) throw new ProfileRejectedError([...presence, "PROFILE_SCHEMA_INVALID"]);
  if (presence.length > 0) throw new ProfileRejectedError(presence);
  const p = parsed.data;
  const v: string[] = [];
  const digest = computeConnectorProfileDigest(p);
  if (digest !== p.configDigest) v.push("PROFILE_DIGEST_MISMATCH");
  const ids = new Map(p.operations.map((o) => [o.operationId, o]));
  if (!p.network) v.push("PROFILE_NETWORK_MISSING");
  if (p.writeMode === "SANDBOX_WRITE" && environment === "production") v.push("SANDBOX_WRITE_PROFILE_IN_PRODUCTION");
  if (p.writeMode === "PRODUCTION_WRITE" && environment !== "production" && environment !== "staging") v.push("PRODUCTION_WRITE_PROFILE_OUTSIDE_PRODUCTION");
  v.push(...authViolations(p));
  for (const op of p.operations) v.push(...operationViolations(p, op, ids));
  v.push(...credentialViolations(p, environment));
  v.push(...streamViolations(p, ids));
  v.push(...probeViolations(p, ids));
  v.push(...bindingViolations(p));
  for (const m of p.mappings) if (CLASS_RANK[m.classification] > CLASS_RANK[p.egressClass] && m.requirement !== "PROHIBITED") v.push("MAPPING_CLASS_EXCEEDS_EGRESS_CLASS");
  const mappings = new Map<string, CompiledMapping>();
  try {
    compileTables(p.mappingTables);
    for (const obj of new Set(p.mappings.map((m) => m.sourceObject))) mappings.set(obj, compileMapping(obj, p.mappings, p.mappingTables));
  } catch (err) {
    v.push(err instanceof MappingDefinitionError ? err.reasonCode : "MAPPING_INVALID");
  }
  for (const op of p.operations.filter((o) => o.enabled && o.responseObject)) {
    if (!mappings.has(op.responseObject as string)) v.push("OPERATION_RESPONSE_OBJECT_UNMAPPED");
  }
  if (v.length > 0) throw new ProfileRejectedError(v);
  return { profile: p, digest, operations: ids, mappings, environment };
}
