/**
 * ConnectorRuntime: one live connector over its admitted ConnectorProfile (WP-06; follow-on prompt
 * section 6; FO-06-03..18, FO-06-20, FO-06-23, FO-16-39, FO-19-08; DATA-01, ACT-02, ACT-03, AUTH-02).
 *
 * Every call follows the same path, so classification and limits are uniform across connectors:
 *   1. declared and enabled operation (OPERATION_NOT_DECLARED / OPERATION_NOT_ENABLED before I/O), write
 *      mode, capability credential of the right access (read and write identities never mix);
 *   2. reviewed template rendering from typed values (no caller-built host, path or query);
 *   3. resilience: at most one retry scope (no stacking: NESTED_RETRY_REFUSED), circuit breaker per
 *      connector, bulkheads per connector and operation, token buckets per operation then per connector
 *      (throttles below the vendor's 429); a vendor Retry-After pauses every bucket of the connector (a
 *      caller already queued is held too) and the queued callers restart spaced at their budget's rate;
 *   4. token from the shared TokenManager; scopes the vendor did not grant refuse the operation;
 *      a 401 invalidates the token and the cached secret and retries ONCE with a fresh token;
 *   5. the egress-classified transport (allowlisted host, pinned address, per-request EgressGuard);
 *   6. classification (classify.ts), header binding checks (account / region), vendor usage metrics;
 *   7. the bounded mapping DSL on the response; a drifted record refuses the whole response and turns
 *      the capability's readiness UNKNOWN until requalified (fault SCHEMA_DRIFT).
 * UNKNOWN outcomes are never retried here: `reconcile()` runs the operation's reconcile lookup.
 */
import type { Classification } from "../../protocol/common.js";
import type { CapabilityCredential, ConnectorOperation, ConnectorProfile } from "../../protocol/connector.js";
import type { Logger, Metrics } from "../../observability/ports.js";
import { silentLogger } from "../../observability/logger.js";
import { Bulkhead } from "../../resilience/bulkhead.js";
import { CircuitBreaker } from "../../resilience/circuit-breaker.js";
import { TokenBucket } from "../../resilience/rate-limiter.js";
import { RETRY_MAX_ATTEMPTS, retry } from "../../resilience/retry.js";
import { sha256Hex } from "../../shared/canonical.js";
import type { Clock } from "../../shared/clock.js";
import { PlatformError } from "../../shared/errors.js";
import { ConnectorSchemaDriftError, MappingDefinitionError } from "../dsl/errors.js";
import { applyMapping } from "../dsl/mapping.js";
import type { CompiledMapping, MappedRecord } from "../dsl/mapping.js";
import { parseMetadata, validateMappingAgainstMetadata } from "../dsl/metadata.js";
import type { ObjectMetadata } from "../dsl/metadata.js";
import { parsePointer, readPointer } from "../dsl/pointer.js";
import { TemplateInputError, renderRequest } from "../dsl/template.js";
import type { ParamValue, RenderedRequest } from "../dsl/template.js";
import type { ConnectorHttpTransport, TransportResponse } from "../http/transport.js";
import { TransportError } from "../http/transport.js";
import type { AdmittedProfile } from "../profile/validate.js";
import type { SecretResolver } from "../secrets/resolver.js";
import { classifyResponse, fromTransport, isAvailabilityFailure, retryAfterOf } from "./classify.js";
import { ConnectorError, ConnectorRefusal, OPERATION_NOT_DECLARED, OPERATION_NOT_ENABLED } from "./errors.js";
import { TokenManager } from "./token-manager.js";
import type { CredentialStage, TokenGrant } from "./token-manager.js";

export interface ConnectorRuntimeDeps {
  admitted: AdmittedProfile;
  transport: ConnectorHttpTransport;
  secrets: SecretResolver;
  clock: Clock;
  metrics?: Metrics;
  logger?: Logger;
  /** Circuit breaker of this connector's dependency (default: one with conservative settings). */
  breaker?: CircuitBreaker;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

export interface ExecuteInput {
  params?: Readonly<Record<string, ParamValue>>;
  body?: Readonly<Record<string, unknown>>;
  /** Server-derived idempotency key (writes); never caller or model text. */
  idempotencyKey?: string;
  signal?: AbortSignal;
  /**
   * Version stage of the capability credential. AWSPENDING only to test a rotation with a read (the
   * pending-credential probe); a write never runs on a pending credential. Default AWSCURRENT.
   */
  credentialStage?: CredentialStage;
}

export interface OperationResult {
  readonly operationId: string;
  readonly httpStatus: number;
  readonly records: readonly MappedRecord[];
  /** Digest of the compiled mapping the records went through (null: the operation maps no records). */
  readonly mappingDigest: string | null;
  /** Content-free receipt: digests of what was sent and received, and the credential version used. */
  readonly receipt: { readonly requestDigest: string; readonly responseDigest: string; readonly secretVersionId: string; readonly at: string };
  /** Next cursor / page token / link reported by the vendor (pagination). */
  readonly next: string | null;
}

export interface PagedResult {
  readonly operationId: string;
  readonly records: readonly MappedRecord[];
  readonly pages: number;
  readonly completeness: "COMPLETE" | "TRUNCATED";
  readonly truncatedReason: "PAGE_LIMIT" | "CURSOR_EXPIRED" | null;
  readonly nextCursor: string | null;
  readonly mappingDigest: string | null;
}

export type ReadinessStatus = "READY" | "NOT_READY" | "UNKNOWN";

/** Same shape as the adapter port's AdapterHealth (platform/src/adapters/ports.ts), declared here so the
 *  connector runtime does not import the adapters module (adapters build on connectors, not the reverse). */
export interface ConnectorHealth {
  healthy: boolean;
  reasonCode: string | null;
}

export interface CapabilityReadiness {
  readonly capability: string;
  readonly status: ReadinessStatus;
  readonly reasonCode: string;
  readonly checkedAt: string | null;
}

const READ_KINDS = new Set(["READ", "SUBSCRIBE", "RECONCILE_LOOKUP"]);

const BREAKER_DEFAULTS = { windowMs: 60_000, minimumRequests: 10, failureRateThreshold: 0.5, cooldownMs: 30_000, halfOpenMaxProbes: 1, halfOpenSuccessesToClose: 2 } as const;

function parseJson(body: Buffer): unknown {
  if (body.length === 0) return null;
  try {
    return JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

export class ConnectorRuntime {
  readonly kind = "live" as const;
  readonly integrationId: string;
  readonly profile: ConnectorProfile;
  readonly tokens: TokenManager;
  private readonly admitted: AdmittedProfile;
  private readonly deps: ConnectorRuntimeDeps;
  private readonly logger: Logger;
  private readonly breaker: CircuitBreaker;
  private readonly connectorBucket: TokenBucket;
  private readonly connectorBulkhead: Bulkhead;
  private readonly opBuckets = new Map<string, TokenBucket>();
  private readonly opBulkheads = new Map<string, Bulkhead>();
  private readonly readinessByCapability = new Map<string, CapabilityReadiness>();
  private apiRequestCount = 0;

  constructor(deps: ConnectorRuntimeDeps) {
    this.deps = deps;
    this.admitted = deps.admitted;
    this.profile = deps.admitted.profile;
    this.integrationId = this.profile.system;
    this.logger = (deps.logger ?? silentLogger).child({ component: "connector_runtime", integration: this.profile.system });
    this.tokens = new TokenManager({ profile: this.profile, transport: deps.transport, secrets: deps.secrets, clock: deps.clock, metrics: deps.metrics, logger: deps.logger });
    const dependency = this.profile.system;
    this.breaker = deps.breaker ?? new CircuitBreaker({ ...BREAKER_DEFAULTS, dependency, clock: deps.clock, metrics: deps.metrics, isFailure: isAvailabilityFailure });
    const l = this.profile.limits;
    this.connectorBucket = new TokenBucket({ dependency, ratePerSecond: l.requestsPerSecond, burst: Math.max(1, Math.ceil(l.requestsPerSecond)), maxWaitMs: l.timeoutMs, clock: deps.clock, sleep: deps.sleep, metrics: deps.metrics });
    this.connectorBulkhead = new Bulkhead({ dependency, maxConcurrent: l.maxConcurrency, maxQueue: l.maxConcurrency * 4, queueTimeoutMs: l.timeoutMs, metrics: deps.metrics });
    for (const op of this.profile.operations) {
      if (!op.enabled || !op.rateBudget) continue;
      // A vendor pause holds callers in their operation bucket too (pauseVendor), so an operation bucket
      // may hold a caller as long as the connector bucket may: the connector's timeout (admission keeps
      // every operation timeout within it). The operation's own timeout bounds its request on the wire.
      this.opBuckets.set(op.operationId, new TokenBucket({ dependency, ratePerSecond: op.rateBudget.requestsPerSecond, burst: op.rateBudget.burst, maxWaitMs: l.timeoutMs, clock: deps.clock, sleep: deps.sleep, metrics: deps.metrics }));
      this.opBulkheads.set(op.operationId, new Bulkhead({ dependency, maxConcurrent: op.rateBudget.maxConcurrency, maxQueue: op.rateBudget.maxConcurrency * 4, queueTimeoutMs: op.timeoutMs ?? l.timeoutMs, metrics: deps.metrics }));
    }
    for (const c of new Set(this.profile.operations.filter((o) => o.enabled && o.capability).map((o) => o.capability as string))) {
      this.readinessByCapability.set(c, { capability: c, status: "UNKNOWN", reasonCode: "CONNECTOR_NEVER_PROBED", checkedAt: null });
    }
  }

  /** API requests sent (excluding token requests); tests assert that refusals happen before I/O. */
  get apiRequests(): number {
    return this.apiRequestCount;
  }

  get circuit(): CircuitBreaker {
    return this.breaker;
  }

  /** The compiled mapping of a source object (null when the profile maps none). */
  mappingFor(sourceObject: string): CompiledMapping | null {
    return this.admitted.mappings.get(sourceObject) ?? null;
  }

  // ------------------------------------------------------------------ readiness and health

  readiness(): CapabilityReadiness[] {
    return [...this.readinessByCapability.values()].sort((a, b) => a.capability.localeCompare(b.capability));
  }

  setReadiness(capability: string, status: ReadinessStatus, reasonCode: string): void {
    if (!this.readinessByCapability.has(capability)) return;
    this.readinessByCapability.set(capability, { capability, status, reasonCode, checkedAt: this.deps.clock.now().toISOString() });
    try {
      this.deps.metrics?.gauge("vsp_connector_capability_ready", status === "READY" ? 1 : 0, { dependency: this.integrationId, readiness: status.toLowerCase() });
    } catch {
      // metrics never change readiness
    }
  }

  /** Fails closed: healthy only when every capability passed its active probes; never contacted is not healthy. */
  async health(): Promise<ConnectorHealth> {
    const rows = this.readiness();
    if (rows.length === 0) return { healthy: false, reasonCode: "CONNECTOR_NO_ENABLED_CAPABILITY" };
    const bad = rows.find((r) => r.status !== "READY");
    return bad ? { healthy: false, reasonCode: bad.reasonCode } : { healthy: true, reasonCode: null };
  }

  // ------------------------------------------------------------------ operations

  private operation(operationId: string): ConnectorOperation {
    const op = this.admitted.operations.get(operationId);
    if (!op) throw new ConnectorRefusal(OPERATION_NOT_DECLARED, this.integrationId, operationId);
    if (!op.enabled) throw new ConnectorRefusal(OPERATION_NOT_ENABLED, this.integrationId, operationId);
    if (op.kind === "WRITE" && this.profile.writeMode === "READ_ONLY") throw new ConnectorRefusal("CONNECTOR_WRITE_MODE_READ_ONLY", this.integrationId, operationId);
    return op;
  }

  private credentialFor(op: ConnectorOperation): CapabilityCredential {
    const access = op.kind === "WRITE" ? "WRITE" : "READ";
    const c = (this.profile.capabilityCredentials ?? []).find((x) => x.capability === op.capability && x.access === access);
    if (!c) throw new ConnectorRefusal("CAPABILITY_CREDENTIAL_MISSING", this.integrationId, op.operationId);
    return c;
  }

  private dataClassFor(op: ConnectorOperation): Classification {
    const s = (this.profile.streams ?? []).find((x) => x.sourceObject === op.responseObject);
    return s?.egressClass ?? this.profile.egressClass;
  }

  private render(op: ConnectorOperation, input: ExecuteInput, runtimeQuery: [string, string][] = []): RenderedRequest {
    try {
      return renderRequest(this.profile.baseUrl, op, { params: input.params, body: input.body, idempotencyKey: input.idempotencyKey, runtimeQuery });
    } catch (e) {
      if (e instanceof TemplateInputError || e instanceof MappingDefinitionError) throw new ConnectorRefusal(e.reasonCode, this.integrationId, op.operationId);
      throw e;
    }
  }

  /** Runs one reviewed operation and maps its records. */
  async execute(operationId: string, input: ExecuteInput = {}): Promise<OperationResult> {
    const op = this.operation(operationId);
    const stage = input.credentialStage ?? "AWSCURRENT";
    if (stage !== "AWSCURRENT" && op.kind === "WRITE") throw new ConnectorRefusal("PENDING_CREDENTIAL_WRITE_REFUSED", this.integrationId, operationId);
    const req = this.render(op, input);
    return this.run(op, req, input.signal, stage);
  }

  /**
   * Runs the reconcile lookup of a write (ACT-03): after an UNKNOWN outcome the caller asks whether the
   * effect exists before any retry or success claim. A 404 means "not found", never "failed".
   */
  async reconcile(writeOperationId: string, input: ExecuteInput): Promise<{ found: boolean; result: OperationResult | null }> {
    const write = this.operation(writeOperationId);
    if (write.reconcileOperationId === null) throw new ConnectorRefusal("WRITE_WITHOUT_RECONCILE", this.integrationId, writeOperationId);
    try {
      const result = await this.execute(write.reconcileOperationId, { params: input.params, signal: input.signal });
      return { found: result.records.length > 0 || result.mappingDigest === null, result };
    } catch (e) {
      if (e instanceof ConnectorError && e.reasonCode === "CONNECTOR_NOT_FOUND") return { found: false, result: null };
      throw e;
    }
  }

  private async run(op: ConnectorOperation, req: RenderedRequest, signal?: AbortSignal, stage: CredentialStage = "AWSCURRENT"): Promise<OperationResult> {
    return this.runWith(op, req, signal, stage, (res, grant) => this.result(op, req, res, grant));
  }

  /**
   * The one call path of every operation (records, metadata): retry scope, breaker, bulkheads, budgets,
   * token and scopes, the 401 refresh, classification and header binding; `finish` turns the accepted
   * response into the caller's result inside the attempt (a failure there is classified like the rest).
   */
  private async runWith<T>(op: ConnectorOperation, req: RenderedRequest, signal: AbortSignal | undefined, stage: CredentialStage, finish: (res: TransportResponse, grant: TokenGrant) => T): Promise<T> {
    const credential = this.credentialFor(op);
    const budget = Math.min(this.profile.limits.retryBudget, RETRY_MAX_ATTEMPTS - 1);
    const attempt = () => this.attempt(op, req, credential, signal, stage, finish);
    const started = this.deps.clock.now().getTime();
    try {
      const out =
        budget === 0
          ? await attempt()
          : await retry(attempt, {
              dependency: this.integrationId,
              maxAttempts: 1 + budget,
              baseDelayMs: 100,
              maxDelayMs: Math.min(30_000, Math.max(1_000, op.timeoutMs ?? this.profile.limits.timeoutMs) * 2),
              random: this.deps.random,
              sleep: this.deps.sleep,
              signal,
              metrics: this.deps.metrics,
              delayFor: (err) => retryAfterOf(err),
            });
      this.countOp(op, "success", started);
      return out;
    } catch (e) {
      this.countOp(op, e instanceof ConnectorRefusal ? "refused" : e instanceof ConnectorSchemaDriftError ? "schema_drift" : e instanceof ConnectorError ? e.outcome.toLowerCase() : "error", started);
      throw e;
    }
  }

  private countOp(op: ConnectorOperation, result: string, started: number): void {
    try {
      this.deps.metrics?.increment("vsp_connector_operations_total", { dependency: this.integrationId, kind: op.kind.toLowerCase(), result });
      this.deps.metrics?.observe("vsp_connector_operation_latency_ms", Math.max(0, this.deps.clock.now().getTime() - started), { dependency: this.integrationId, kind: op.kind.toLowerCase() });
    } catch {
      // metrics never change a call
    }
  }

  private async attempt<T>(op: ConnectorOperation, req: RenderedRequest, credential: CapabilityCredential, signal: AbortSignal | undefined, stage: CredentialStage, finish: (res: TransportResponse, grant: TokenGrant) => T): Promise<T> {
    return this.breaker.execute(() =>
      this.connectorBulkhead.run(
        () => {
          const opBulkhead = this.opBulkheads.get(op.operationId);
          const inner = () => this.exchange(op, req, credential, signal, stage, finish);
          return opBulkhead ? opBulkhead.run(inner, { signal }) : inner();
        },
        { signal },
      ),
    );
  }

  private async exchange<T>(op: ConnectorOperation, req: RenderedRequest, credential: CapabilityCredential, signal: AbortSignal | undefined, stage: CredentialStage, finish: (res: TransportResponse, grant: TokenGrant) => T): Promise<T> {
    // The operation's own budget first, the connector's last (a caller queued for an operation token
    // reserves no connector capacity while it waits). A vendor Retry-After pauses every bucket of the
    // connector (pauseVendor): the callers queued in either are held until it ends and then re-spaced at
    // their bucket's sustained rate, so the backlog does not reach the vendor as one burst.
    await this.opBuckets.get(op.operationId)?.take(signal);
    await this.connectorBucket.take(signal);
    let grant = await this.tokens.grant(credential, op.operationId, stage);
    this.assertScopes(op, grant);
    let res = await this.send(op, req, grant, signal);
    if (res.status === 401) {
      // Exactly one refresh: drop the token and the cached secret (rotation), ask again, send once more.
      this.tokens.invalidate(credential, stage);
      grant = await this.tokens.grant(credential, op.operationId, stage);
      this.assertScopes(op, grant);
      res = await this.send(op, req, grant, signal);
      if (res.status === 401) {
        this.tokens.invalidate(credential, stage);
        // A pending credential under test failing says nothing about the one serving traffic.
        if (op.capability && stage === "AWSCURRENT") this.setReadiness(op.capability, "NOT_READY", "CONNECTOR_AUTH_FAILED");
        throw new ConnectorError("CONNECTOR_AUTH_FAILED", op.kind === "WRITE" ? "FAILED" : "FAILED", this.integrationId, op.operationId, { httpStatus: 401, retryable: false });
      }
    }
    this.recordUsage(res);
    try {
      classifyResponse(this.integrationId, op, res, this.deps.clock.now());
    } catch (e) {
      if (e instanceof ConnectorError && (e.reasonCode === "HTTP_429" || e.reasonCode === "HTTP_503") && e.retryAfterMs !== null) {
        this.pauseVendor(this.deps.clock.now().getTime() + e.retryAfterMs);
      }
      throw e;
    }
    // A successful answer is used (or claimed) only when it comes from the bound account and region.
    this.verifyHeaderBinding(op, res);
    return finish(res, grant);
  }

  /**
   * A vendor Retry-After applies to the whole connector: the connector bucket and every operation bucket
   * pause until `epochMs`. Each restarts with a burst of one, so callers released by an operation budget
   * after the pause are spaced at that budget's rate and the connector bucket spaces what they add up to.
   */
  private pauseVendor(epochMs: number): void {
    this.connectorBucket.pauseUntil(epochMs);
    for (const b of this.opBuckets.values()) b.pauseUntil(epochMs);
  }

  private assertScopes(op: ConnectorOperation, grant: TokenGrant): void {
    const missing = (op.requiredScopes ?? []).filter((s) => grant.missingScopes.includes(s));
    if (missing.length > 0) throw new ConnectorRefusal("CONNECTOR_SCOPE_NOT_GRANTED", this.integrationId, op.operationId);
  }

  private async send(op: ConnectorOperation, req: RenderedRequest, grant: TokenGrant, signal?: AbortSignal): Promise<TransportResponse> {
    const body = req.body === null ? null : JSON.stringify(req.body);
    this.apiRequestCount += 1;
    try {
      return await this.deps.transport.send({
        method: req.method,
        url: req.url,
        headers: { ...req.headers, [grant.header.name]: grant.header.value.reveal() },
        body,
        policy: { allowedHosts: this.profile.allowedHosts, addressClass: this.profile.network?.addressClass ?? "PUBLIC_INTERNET", dataClass: this.dataClassFor(op) },
        sideEffect: op.kind === "WRITE",
        timeoutMs: op.timeoutMs ?? this.profile.limits.timeoutMs,
        signal,
        dependency: this.integrationId,
      });
    } catch (e) {
      if (e instanceof TransportError && e.phase === "PRE_IO") this.apiRequestCount -= 1;
      if (e instanceof TransportError) throw fromTransport(this.integrationId, op.operationId, e);
      throw e;
    }
  }

  /** Account / region reported in response headers must match the profile binding (FO-06-13). */
  private verifyHeaderBinding(op: ConnectorOperation, res: TransportResponse): void {
    const b = this.profile.bindingVerification;
    const check = (src: { source: string; locator: string } | null | undefined, expected: string, reason: string) => {
      if (!src || src.source !== "RESPONSE_HEADER") return;
      const v = res.headers[src.locator.toLowerCase()];
      if (v !== expected) {
        if (op.capability) this.setReadiness(op.capability, "NOT_READY", reason);
        // A write already reached a host that answered for another account or region: its effect is unknown.
        throw new ConnectorError(reason, op.kind === "WRITE" ? "UNKNOWN" : "FAILED", this.integrationId, op.operationId, { httpStatus: res.status, retryable: false });
      }
    };
    check(b?.account, this.profile.accountBinding.externalAccountRef, "CONNECTOR_ACCOUNT_BINDING_MISMATCH");
    check(b?.region, this.profile.region, "CONNECTOR_REGION_MISMATCH");
  }

  private recordUsage(res: TransportResponse): void {
    const u = this.profile.usageHeaders;
    if (!u) return;
    const remaining = Number(res.headers[u.remaining.toLowerCase()]);
    const limit = Number(res.headers[u.limit.toLowerCase()]);
    if (!Number.isFinite(remaining) || !Number.isFinite(limit) || limit <= 0 || remaining < 0) return;
    try {
      this.deps.metrics?.gauge("vsp_connector_vendor_quota_remaining_ratio", Math.min(1, remaining / limit), { dependency: this.integrationId });
    } catch {
      // metrics never change a call
    }
  }

  private result(op: ConnectorOperation, req: RenderedRequest, res: TransportResponse, grant: TokenGrant): OperationResult {
    const json = parseJson(res.body);
    const mapping = op.responseObject ? this.admitted.mappings.get(op.responseObject) : undefined;
    let records: MappedRecord[] = [];
    if (mapping) {
      if (json === undefined || (json === null && res.status !== 204)) {
        // A success status whose body is not JSON: a write's effect cannot be confirmed from it.
        throw new ConnectorError("CONNECTOR_RESPONSE_NOT_JSON", op.kind === "WRITE" ? "UNKNOWN" : "FAILED", this.integrationId, op.operationId, { httpStatus: res.status, retryable: false });
      }
      if (json !== null) {
        try {
          records = applyMapping(mapping, json, op.recordsPointer ?? null);
        } catch (e) {
          if (e instanceof ConnectorSchemaDriftError && op.capability) {
            // The capability is unqualified until a new mapping is reviewed (fault SCHEMA_DRIFT postcondition).
            this.setReadiness(op.capability, "UNKNOWN", "CONNECTOR_SCHEMA_DRIFT");
            this.logger.warn("connector.mapping.drift", { reasonCode: e.reasonCode, mappingDigest: e.mappingDigest });
          }
          // A write whose receipt drifted has an effect we cannot read back: UNKNOWN, reconcile first.
          if (e instanceof ConnectorSchemaDriftError && op.kind === "WRITE") throw new ConnectorError("CONNECTOR_RECEIPT_SCHEMA_DRIFT", "UNKNOWN", this.integrationId, op.operationId, { httpStatus: res.status, retryable: false });
          throw e;
        }
      }
    }
    let next: string | null = null;
    const pointer = op.pagination?.nextPointer;
    if (pointer && json !== undefined && json !== null) {
      const v = readPointer(json, parsePointer(pointer));
      if (typeof v === "string" && v.length > 0 && v.length <= 2_048) next = v;
      else if (typeof v === "number" && Number.isSafeInteger(v)) next = String(v);
    }
    return {
      operationId: op.operationId,
      httpStatus: res.status,
      records,
      mappingDigest: mapping?.digest ?? null,
      next,
      receipt: {
        requestDigest: sha256Hex(`${req.method} ${req.url.pathname}${req.url.search}\n${req.body === null ? "" : JSON.stringify(req.body)}`),
        responseDigest: sha256Hex(res.body),
        secretVersionId: grant.secretVersionId,
        at: this.deps.clock.now().toISOString(),
      },
    };
  }

  // ------------------------------------------------------------------ pagination

  /**
   * Reads pages of a paginated operation within the declared bounds (FO-06-06). The read is COMPLETE only
   * when the vendor reports no further position: no next cursor, an empty page at the same position (a
   * change feed's "caught up"), or (OFFSET) a page shorter than the page size. An empty page that carries
   * an advanced cursor is not the end (a filtered feed moves its position without returning records): the
   * read continues from that cursor. When the page-count bound is reached with more data reported, the
   * records read so far are returned labelled TRUNCATED (PAGE_LIMIT) with the resume position: the next
   * cursor, or for OFFSET the offset of the first record not read; `startCursor` resumes from it. A cursor
   * that expires after the first page also returns TRUNCATED (CURSOR_EXPIRED), with no resume cursor: the
   * expired position cannot be resumed and the read starts again. A non-empty page whose next cursor
   * equals the one requested would serve the same records forever: PAGINATION_CURSOR_NOT_ADVANCING.
   */
  async readAll(operationId: string, input: ExecuteInput = {}, opts: { maxPages?: number; startCursor?: string | null } = {}): Promise<PagedResult> {
    const op = this.operation(operationId);
    if (!READ_KINDS.has(op.kind)) throw new ConnectorRefusal("PAGINATION_ON_WRITE", this.integrationId, operationId);
    const pg = op.pagination;
    if (!pg || pg.strategy === "NONE") {
      const r = await this.execute(operationId, input);
      return { operationId, records: r.records, pages: 1, completeness: "COMPLETE", truncatedReason: null, nextCursor: null, mappingDigest: r.mappingDigest };
    }
    const maxPages = Math.min(pg.maxPages, opts.maxPages ?? pg.maxPages);
    const records: MappedRecord[] = [];
    let cursor: string | null = opts.startCursor ?? null;
    // OFFSET: the position is the offset of the next record to read; a resume position is a decimal offset.
    let offset = 0;
    if (pg.strategy === "OFFSET" && cursor !== null) {
      if (!/^(0|[1-9][0-9]{0,8})$/.test(cursor)) throw new ConnectorRefusal("PAGINATION_START_OFFSET_INVALID", this.integrationId, operationId);
      offset = Number(cursor);
    }
    let pages = 0;
    let digest: string | null = null;
    for (;;) {
      if (pages >= maxPages) {
        return { operationId, records, pages, completeness: "TRUNCATED", truncatedReason: "PAGE_LIMIT", nextCursor: pg.strategy === "OFFSET" ? String(offset) : cursor, mappingDigest: digest };
      }
      let page: OperationResult;
      try {
        page = await this.page(op, input, pg.strategy === "OFFSET" ? String(offset) : cursor);
      } catch (e) {
        if (e instanceof ConnectorError && e.reasonCode === "CURSOR_EXPIRED" && pages > 0) {
          return { operationId, records, pages, completeness: "TRUNCATED", truncatedReason: "CURSOR_EXPIRED", nextCursor: null, mappingDigest: digest };
        }
        throw e;
      }
      pages += 1;
      digest = page.mappingDigest;
      records.push(...page.records);
      offset += page.records.length;
      const complete = (): PagedResult => ({ operationId, records, pages, completeness: "COMPLETE", truncatedReason: null, nextCursor: null, mappingDigest: digest });
      if (pg.strategy === "OFFSET") {
        // An offset page shorter than the page size (an empty one included) is the last page.
        if (page.records.length < pg.maxPageSize) return complete();
        continue;
      }
      if (page.next === null) return complete();
      if (page.next === cursor) {
        // Same position: empty is the vendor's "nothing further"; non-empty would re-serve these records forever.
        if (page.records.length === 0) return complete();
        throw new ConnectorError("PAGINATION_CURSOR_NOT_ADVANCING", "FAILED", this.integrationId, operationId, { retryable: false });
      }
      // An advanced position, with or without records: keep reading from it within the page bound.
      cursor = page.next;
    }
  }

  /** One page at `cursor` (null: first page). Used by readAll and the incremental reader. */
  async page(opOrId: ConnectorOperation | string, input: ExecuteInput, cursor: string | null): Promise<OperationResult> {
    const op = typeof opOrId === "string" ? this.operation(opOrId) : opOrId;
    const pg = op.pagination;
    if (!pg || pg.strategy === "NONE") return this.execute(op.operationId, input);
    const stage = input.credentialStage ?? "AWSCURRENT";
    if (pg.strategy === "NEXT_LINK" && cursor !== null) return this.run(op, this.nextLinkRequest(op, input, cursor), input.signal, stage);
    const q: [string, string][] = [];
    if (pg.pageSizeParam) q.push([pg.pageSizeParam, String(pg.maxPageSize)]);
    if (cursor !== null && pg.cursorParam) q.push([pg.cursorParam, cursor]);
    return this.run(op, this.render(op, input, q), input.signal, stage);
  }

  /** A vendor-supplied next link is followed only on the base origin, under the base path (refused before I/O otherwise). */
  private nextLinkRequest(op: ConnectorOperation, input: ExecuteInput, link: string): RenderedRequest {
    const base = new URL(this.profile.baseUrl);
    let url: URL;
    try {
      url = new URL(link, base);
    } catch {
      throw new ConnectorRefusal("CONNECTOR_NEXT_LINK_INVALID", this.integrationId, op.operationId);
    }
    const basePath = base.pathname.replace(/\/+$/, "");
    if (url.origin !== base.origin || url.username || url.password || url.hash || !url.pathname.startsWith(`${basePath}/`) || /(^|\/)\.\.?(\/|$)/.test(url.pathname)) {
      throw new ConnectorRefusal("CONNECTOR_NEXT_LINK_OFF_ORIGIN", this.integrationId, op.operationId);
    }
    const first = this.render(op, input);
    return { ...first, url };
  }

  // ------------------------------------------------------------------ metadata and events

  /**
   * Fetches the vendor metadata of a mapped source object through the profile's metadata operation, on the
   * same path as every other operation: its budget and bulkhead, the retry policy, the scope check, the
   * single 401 refresh, classification and the account / region header binding.
   */
  async fetchMetadata(sourceObject: string, signal?: AbortSignal): Promise<ObjectMetadata> {
    const h = this.profile.health;
    if (!h?.metadataOperationId || !h.metadataFormat) throw new ConnectorRefusal("CONNECTOR_METADATA_PROBE_NOT_DECLARED", this.integrationId, "metadata");
    const op = this.operation(h.metadataOperationId);
    const req = this.render(op, {});
    const json = await this.runWith(op, req, signal, "AWSCURRENT", (res) => parseJson(res.body));
    try {
      return parseMetadata(h.metadataFormat, sourceObject, json);
    } catch (e) {
      throw new ConnectorError(e instanceof PlatformError ? e.reasonCode : "METADATA_INVALID", "FAILED", this.integrationId, op.operationId, { retryable: false });
    }
  }

  /** Compares every compiled mapping with freshly fetched metadata; drift turns the affected capabilities UNKNOWN. */
  async validateMappings(signal?: AbortSignal): Promise<Record<string, ReturnType<typeof validateMappingAgainstMetadata>>> {
    const out: Record<string, ReturnType<typeof validateMappingAgainstMetadata>> = {};
    for (const [obj, mapping] of this.admitted.mappings) {
      const meta = await this.fetchMetadata(obj, signal);
      const issues = validateMappingAgainstMetadata(mapping, meta);
      out[obj] = issues;
      if (issues.length > 0) {
        for (const op of this.profile.operations.filter((o) => o.enabled && o.responseObject === obj && o.capability)) this.setReadiness(op.capability as string, "UNKNOWN", "CONNECTOR_SCHEMA_DRIFT");
      }
    }
    return out;
  }

  /** Inbound change events must carry the stream's pinned event schema (FO-06-15). */
  assertEventSchema(streamId: string, schemaRef: string, version: string): void {
    const s = (this.profile.streams ?? []).find((x) => x.streamId === streamId);
    if (!s || s.eventSchema === null) throw new ConnectorRefusal("CONNECTOR_STREAM_HAS_NO_EVENT_SCHEMA", this.integrationId, streamId);
    if (s.eventSchema.schemaRef !== schemaRef || s.eventSchema.version !== version) throw new ConnectorRefusal("CONNECTOR_EVENT_SCHEMA_NOT_PINNED", this.integrationId, streamId);
  }
}
