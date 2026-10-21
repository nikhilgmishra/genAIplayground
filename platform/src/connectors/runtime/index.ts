/**
 * Connector runtime (WP-06; follow-on prompt section 6): one runtime that every live connector shares.
 * See README.md for the call path, classification table and what is emulated versus vendor-verified.
 */
export { ConnectorRuntime } from "./connector.js";
export type { CapabilityReadiness, ConnectorHealth, ConnectorRuntimeDeps, ExecuteInput, OperationResult, PagedResult, ReadinessStatus } from "./connector.js";
export { TokenManager } from "./token-manager.js";
export type { AuthorizationHeader, CredentialStage, TokenGrant, TokenManagerDeps } from "./token-manager.js";
export { ConnectorError, ConnectorRefusal, OPERATION_NOT_DECLARED, OPERATION_NOT_ENABLED } from "./errors.js";
export { classifyResponse, defaultSuccessStatuses, fromTransport, isAvailabilityFailure, retryAfterOf } from "./classify.js";
export { probeConnector, verifyPendingCredentials } from "./health.js";
export type { PendingCredentialCheck, ProbeReport, ProbeStepResult, SandboxWriteProbe } from "./health.js";
export { KmsEvidenceSigner, capabilityEvidenceFrom, evidenceContentDigest, signCapabilityEvidence, verifyEvidenceSignature } from "./evidence.js";
export type { EvidenceOptions, EvidenceSigner, KmsSender } from "./evidence.js";
export { IncrementalReader, PgConnectorCheckpointStore, positionDigest } from "./checkpoints.js";
export type { Checkpoint, CheckpointAdvance, CheckpointKey, IncrementalReaderOptions, IncrementalRunResult } from "./checkpoints.js";
