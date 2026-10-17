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
