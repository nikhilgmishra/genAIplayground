/**
 * Audit evidence module: durable in-transaction writer with per-stream hash
 * chains, bounded-buffering health, shipper to an append-only sink, integrity
 * verification and completeness reconciliation, and metadata-only query.
 * See README.md for what is LOCAL FIXTURE and what is BLOCKED.
 */
export * from "./ports.js";
export {
  AuditWriterInput,
  AuditEventInvalidError,
  EVIDENCE_POINTER_RE,
  TYPED_OPAQUE_REF_RE,
  STREAM_NAME_RE,
  EvidencePointer,
  AuditAction,
  auditStreamName,
  assertStreamName,
  looksPhiShaped,
  normalizeAuditInput,
  pseudonymousSessionRef,
  validateAuditInput,
} from "./schema.js";
export type { AuditInputIssue } from "./schema.js";
export {
  batchDigestOf,
  buildChainedEvent,
  buildManifest,
  computeEventHash,
  objectKeyFor,
  parseNdjson,
  parseObjectKey,
  toNdjson,
  verifyChain,
} from "./chain.js";
export type { ChainCheckResult, ChainFinding, ChainFindingCode } from "./chain.js";
export { PgAuditWriter } from "./writer.js";
export type { PgAuditWriterOptions } from "./writer.js";
export { PgAuditHealth, AUDIT_HEALTH_REASONS, validateBufferPolicy } from "./health.js";
export type { AuditBufferPolicy, PgAuditHealthOptions } from "./health.js";
export { AuditShipper, AuditShipBlockedError } from "./shipper.js";
export type { AuditShipperOptions, ShipRunResult, StreamShipResult } from "./shipper.js";
export { IntegrityVerifier, assessCompleteness, reconcileCounts } from "./verifier.js";
export { AuditCompletenessMonitor, COMMIT_EVIDENCE_ACTIONS, sourceComponentForStream } from "./monitor.js";
export type { AuditCompletenessMonitorOptions, AuditMonitorReport } from "./monitor.js";
export type {
  ActionTally,
  CompletenessAssessment,
  CompletenessVerdict,
  IngestionCheckResult,
  IngestionGap,
  IngestionGapCode,
  IntegrityFinding,
  IntegrityFindingCode,
  IntegrityVerifierOptions,
  ReconciliationCode,
  ReconciliationDiscrepancy,
  ReconciliationResult,
  SourceActivityReport,
  StreamVerification,
} from "./verifier.js";
export { PgAuditQuery, AuditSearchFilter, MAX_AUDIT_QUERY_LIMIT, auditedSearch } from "./query.js";
export type { AuditAccessor } from "./query.js";
export { buildAuditInput, auditFieldsFromAuth } from "./build-input.js";
export { DEFERRED_AUDIT_AFTER_SHUTDOWN, DEFERRED_AUDIT_BADGE, DEFERRED_AUDIT_MARKER_ACTION, DeferredAuditFlushTimer, DeferredAuditQueue } from "./deferred.js";
export type { DeferredAuditFlushTimerOptions, DeferredAuditQueueOptions, DeferredFinalFlushResult, DeferredFlushResult } from "./deferred.js";
export type { AuditInputFields } from "./build-input.js";
export {
  DURABLE_DEFERRED_AUDIT_BADGE,
  DurableDeferredAuditQueue,
  DynamoRouteAuditJournal,
  JOURNAL_ENTRY_QUARANTINED_ACTION,
  ROUTE_AUDIT_ACTION_RE,
  insertDeferral,
  journalEntryFor,
  parseJournalEntry,
  rejectedJournalItem,
  resolveIntents,
} from "./journal.js";
export type { DurableDeferredAuditQueueOptions, IndependentRouteAuditJournal, JournalDocumentSender, JournalEntry, JournalRead, RejectedJournalItem } from "./journal.js";
export {
  PgRouteAuditIntents,
  ROUTE_NOT_RECORDED_ACTION,
  RouteAuditReconciler,
  SAFETY_EVENT_UNAUDITED_ACTION,
  SAFETY_ROUTE_EVIDENCE_ACTIONS,
} from "./route-reconciler.js";
export type { PgRouteAuditIntentsOptions, RouteAuditReconcilerOptions, RouteReconcileResult } from "./route-reconciler.js";
export * from "./exporter/index.js";
export { AuditSinkError } from "./sinks/common.js";
export { LocalFsAuditSinkFixture, LOCAL_SINK_BADGE } from "./sinks/local-fs.js";
export { S3ObjectLockAuditSink, validateS3SinkConfig } from "./sinks/s3-object-lock.js";
export type { S3ObjectLockAuditSinkConfig, S3SendClient } from "./sinks/s3-object-lock.js";
export {
  AUDIT_FIXTURE_BADGE,
  AuditWriterOutageFixture,
  FaultInjectingAuditSinkFixture,
  InMemoryAuditWriterFixture,
  StaticAuditHealthFixture,
  createAuditFixtures,
} from "./fixtures.js";
