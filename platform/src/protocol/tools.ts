/**
 * Tool interface (spec section 8). Tool calls arrive from an untrusted
 * conversational layer; the gateway injects trusted AuthContext after
 * validating the transport. ToolRequest therefore carries no identity fields.
 */
import { z } from "zod";
import { Assurance, Classification, IsoDateTime, OpaqueId, Sha256Hex, VersionLabel } from "./common.js";

export const ToolName = z.string().regex(/^[a-z][a-z0-9_]{2,63}$/);
export type ToolName = z.infer<typeof ToolName>;

export const ToolRef = z.strictObject({ name: ToolName, version: z.string().regex(/^\d+\.\d+\.\d+$/) });
export type ToolRef = z.infer<typeof ToolRef>;

export const RetryPolicy = z.strictObject({
  /** Retries performed by the gateway itself. Never stacked with caller retries. */
  maxAttempts: z.number().int().min(1).max(3),
  backoffMs: z.number().int().min(0).max(5_000),
  jitter: z.boolean(),
  /** Retrying a consequential commit requires reconciliation first (ACT-03). */
  retryOn: z.array(z.enum(["TIMEOUT_BEFORE_SEND", "CONNECTION_REFUSED", "HTTP_429", "HTTP_503"])).max(4),
});
export type RetryPolicy = z.infer<typeof RetryPolicy>;

export const ToolSafetyClass = z.enum([
  /** Always available, even when AI admission, budgets or writes are switched off (SAFE-02, SAFE-03). */
  "SAFETY_AND_HUMAN_ROUTE",
  "PUBLIC_READ",
  "PROTECTED_READ",
  "PREPARE_MUTATION",
  "COMMIT_MUTATION",
  "INTAKE",
]);
export type ToolSafetyClass = z.infer<typeof ToolSafetyClass>;

/** Catalogue entry. The pinned catalogue is hashed; unknown name/version is rejected. */
export const ToolDefinition = z.strictObject({
  name: ToolName,
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  description: z.string().min(10).max(600),
  safetyClass: ToolSafetyClass,
  /** JSON Schema (draft 2020-12) for arguments; additionalProperties false at every object level. */
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()),
  dataClassification: Classification,
  minAssurance: Assurance,
  /** Policy action identifiers evaluated by OPA, e.g. "appointment:read". */
  permissions: z.array(z.string().regex(/^[a-z_]+:[a-z_]+$/)).min(1).max(8),
  timeoutMs: z.number().int().min(100).max(10_000),
  retryPolicy: RetryPolicy,
  idempotency: z.enum(["NATURALLY_IDEMPOTENT", "IDEMPOTENCY_KEY_REQUIRED", "PREPARED_ACTION_DIGEST"]),
  consequential: z.boolean(),
  maxInputBytes: z.number().int().min(64).max(16_384),
  /** Which resolution contract(s) the tool serves. */
  contracts: z.array(z.string().regex(/^[a-z_]+@\d+$/)).max(8),
});
export type ToolDefinition = z.infer<typeof ToolDefinition>;

export const ToolCatalogManifest = z.strictObject({
  catalogVersion: VersionLabel,
  generatedAt: IsoDateTime,
  tools: z.array(z.strictObject({ name: ToolName, version: z.string(), digest: Sha256Hex })),
  /** sha256 over canonical JSON of the full definitions, pinned in ReleaseManifest. */
  digest: Sha256Hex,
});
export type ToolCatalogManifest = z.infer<typeof ToolCatalogManifest>;

/** Request envelope produced by the transport adapter (MCP or HTTP) before identity injection. */
export const ToolRequest = z.strictObject({
  requestId: OpaqueId,
  tool: ToolRef,
  /** Supplied by the trusted transport (header) when supported; never authority on its own. */
  sessionRef: z.string().max(128).nullable(),
  turnId: z.string().regex(/^turn_[A-Za-z0-9_-]{4,64}$/),
  arguments: z.record(z.string(), z.unknown()),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/).nullable(),
  receivedAt: IsoDateTime,
});
export type ToolRequest = z.infer<typeof ToolRequest>;

/** Typed slot value; the template registry declares and validates each slot's type. */
export const SlotValue = z.union([z.string().max(200), z.number().finite(), z.boolean()]);
export type SlotValue = z.infer<typeof SlotValue>;

export const ResponseClass = z.enum([
  "IDENTITY",
  "FINANCIAL_FACT",
  "COMMITMENT",
  "CLINICAL_BOUNDARY",
  "RECORDING_DISCLOSURE",
  "SAFETY",
  "PROTECTED_FACT",
  "LOW_RISK_GROUNDED",
  "GENERIC_STATUS",
]);
export type ResponseClass = z.infer<typeof ResponseClass>;

/**
 * Caller-facing speech is derived only from approved templates plus typed slots,
 * never from opaque dependency strings (spec section 16).
 */
export const SpeechDirective = z.strictObject({
  templateId: z.string().regex(/^[a-z][a-z0-9_.]{2,80}$/),
  templateVersion: VersionLabel,
  responseClass: ResponseClass,
  slots: z.record(z.string().regex(/^[a-z][a-zA-Z0-9]{0,40}$/), SlotValue),
  /** Policy decision id authorizing the disclosure; required for protected classes. */
  authorizationRef: OpaqueId.nullable(),
  /** Knowledge citation ids, action receipt ids or source record refs. */
  sourceRefs: z.array(z.string().max(160)).max(16),
  turnId: z.string().regex(/^turn_[A-Za-z0-9_-]{4,64}$/),
  sessionGeneration: z.number().int().min(1),
});
export type SpeechDirective = z.infer<typeof SpeechDirective>;

export const ToolStatus = z.enum([
  "SUCCESS",
  "RETRYABLE_FAILURE",
  "PERMANENT_FAILURE",
  "POLICY_DENIED",
  "PENDING",
  "UNKNOWN_OUTCOME",
]);
export type ToolStatus = z.infer<typeof ToolStatus>;

export const ReasonCode = z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/);
export type ReasonCode = z.infer<typeof ReasonCode>;

const ToolResultBase = {
  requestId: OpaqueId,
  tool: ToolRef,
  turnId: z.string().regex(/^turn_[A-Za-z0-9_-]{4,64}$/),
  sessionGeneration: z.number().int().min(0),
  completedAt: IsoDateTime,
  auditEventId: OpaqueId.nullable(),
  policyDecisionId: OpaqueId.nullable(),
  speech: SpeechDirective.nullable(),
  /** True when the gateway is running against labelled local fixtures. */
  localFixture: z.boolean(),
};

export const ToolResult = z.discriminatedUnion("status", [
  z.strictObject({ ...ToolResultBase, status: z.literal("SUCCESS"), data: z.record(z.string(), z.unknown()) }),
  z.strictObject({
    ...ToolResultBase,
    status: z.literal("RETRYABLE_FAILURE"),
    reasonCode: ReasonCode,
    retryAfterMs: z.number().int().min(0).max(60_000),
  }),
  z.strictObject({ ...ToolResultBase, status: z.literal("PERMANENT_FAILURE"), reasonCode: ReasonCode }),
  z.strictObject({ ...ToolResultBase, status: z.literal("POLICY_DENIED"), reasonCode: ReasonCode }),
  z.strictObject({
    ...ToolResultBase,
    status: z.literal("PENDING"),
    reasonCode: ReasonCode,
    pendingRef: OpaqueId,
    data: z.record(z.string(), z.unknown()),
  }),
  z.strictObject({
    ...ToolResultBase,
    status: z.literal("UNKNOWN_OUTCOME"),
    reasonCode: ReasonCode,
    reconciliationRef: OpaqueId,
  }),
]);
export type ToolResult = z.infer<typeof ToolResult>;
