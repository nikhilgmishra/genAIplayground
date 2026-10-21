import type { Queryable } from "../db/types.js";
import type { AuditEvent, AuditEventInput, AuditManifest } from "../protocol/index.js";

export interface AuditWriter {
  /**
   * Appends to the local durable audit outbox inside the caller's transaction,
   * assigning per-stream sequence and hash chain. Throws AuditUnavailableError
   * when evidence cannot be durably written (callers fail closed, OPS-01).
   */
  append(tx: Queryable, input: AuditEventInput, stream?: string): Promise<AuditEvent>;
  /** Same, in its own transaction. */
  appendStandalone(input: AuditEventInput, stream?: string): Promise<AuditEvent>;
}

export interface AuditHealthStatus {
  canAcceptConsequential: boolean;
  backlogCount: number;
  oldestUnshippedAgeSeconds: number | null;
  sinkHealthy: boolean;
  reasonCode: string | null;
}

export interface AuditHealth {
  status(): Promise<AuditHealthStatus>;
  /** Throws AuditUnavailableError when the bounded buffering policy is exceeded or the store is unwritable. */
  assertCanAcceptConsequential(): Promise<void>;
}

/** Independently administered append-only sink (S3 Object Lock in the audit account; local fixture offline). */
export interface AuditSink {
  readonly kind: "local_fixture" | "live";
  putBatch(manifest: AuditManifest, eventsNdjson: string): Promise<void>;
  listManifests(stream: string): Promise<AuditManifest[]>;
  getBatch(objectKey: string): Promise<string>;
}

export interface AuditQuery {
  /** Metadata-only search for console auditors; never returns sensitive content. */
  search(filter: {
    tenantId: string;
    correlationId?: string;
    callId?: string;
    action?: string;
    from?: string;
    to?: string;
    limit: number;
  }): Promise<AuditEvent[]>;
}

/** Result of DeferredAuditSink.appendOrDefer. */
export interface DeferredAppendResult {
  /** Durably appended now (eventId set). */
  written: boolean;
  /** Not written now; queued in the bounded process-local deferred queue (written later, in order). */
  deferred: boolean;
  eventId: string | null;
  /** Why it was not written now (AUDIT_STORE_UNWRITABLE, AUDIT_DEFERRED_QUEUE_FULL, ...); null when written. */
  reasonCode: string | null;
  /**
   * Where a deferred event is held (DurableDeferredAuditQueue, audit/journal.ts): "postgres" and "dynamodb"
   * survive a crash, "memory" is the bounded last resort when neither journal accepted it. Absent for the
   * process-local DeferredAuditQueue.
   */
  journal?: "postgres" | "dynamodb" | "memory" | null;
  /** Opaque id of the deferral (dfr_...) when deferred. */
  deferralId?: string | null;
}

/**
 * Bounded deferral for ROUTE evidence only: the audit events of human / safety handoffs, whose
 * route must proceed during an audit outage (OPS-02, SAFE-03). Appends now when it can; otherwise
 * keeps the event in a bounded, process-local queue that is flushed in order once the audit store
 * is writable again (audit/deferred.ts). NEVER use it for consequential mutations: they stay
 * blocked by AuditHealth and their in-transaction append (OPS-01, spec section 13 "Do not
 * acknowledge a mutation and hope to log it later").
 */
export interface DeferredAuditSink {
  appendOrDefer(input: AuditEventInput, stream?: string): Promise<DeferredAppendResult>;
}

/**
 * A started human or safety route that must leave audit evidence by its deadline (route_audit_intents,
 * migration 2040). Opened when the route starts (in the caller's transaction when it has one); resolved
 * by the deferred sink when the route event is written or journaled; turned into an
 * audit.route.not_recorded marker by RouteAuditReconciler when nothing arrived (FO-01-34).
 */
export interface RouteAuditIntentRecorder {
  open(input: {
    tenantId: string;
    routeKind: "HUMAN_TRANSFER" | "SAFETY_ROUTE";
    /** Correlation id the route's audit event will carry (the handoff id). */
    correlationId: string;
    callId: string;
    safetyIncidentId?: string | null;
    /** Seconds until an intent without evidence is reported (default 300, 30..86400). */
    deadlineSeconds?: number;
  }, tx?: Queryable): Promise<{ intentId: string; created: boolean }>;
}
