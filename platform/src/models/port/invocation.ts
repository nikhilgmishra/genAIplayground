/**
 * Minimized invocation audit metadata (WP-08; FO-09-45 "audit invocations with minimized metadata", OPS-06, DATA-01).
 *
 * Builds the ModelInvocation contract record (platform/src/protocol/models.ts) for one ModelPort call that reached
 * the provider: the pinned registry entry and endpoint, a KEYED digest and the class of what the model received, the
 * tool scope, the budget, the typed outcome and the provider-reported usage. Prompt and completion text are NEVER
 * part of the record (`contentRecorded: false`); restricted content is kept only under its own retention and purpose
 * policy elsewhere.
 *
 *  - The input digest is HMAC-SHA256 under a key from the composition root (the audit or tenant digest key, at least
 *    32 bytes; shared/canonical.ts `hmacHex` over the canonical request), never a bare SHA-256: a low-entropy prompt
 *    (a date of birth, a short reference) cannot be confirmed by hashing guesses without the key.
 *  - A record exists for EVERY call whose request bytes reached (or may have reached) the provider
 *    (`result.sentAttempts >= 1`, counted per attempt by the ResilientModelPort from the transport's own
 *    sent / not-started classification), whatever the outcome: a 401/403 (UNAVAILABLE MODEL_AUTH_REJECTED), a 4xx, a
 *    5xx, a timeout after send or a cancelled stream is recorded with its error code, because the prompt left the
 *    platform (security review r3: the outcome is never the proxy for "sent").
 *  - The contract states `egress.endpointAllowlisted: true`, so no record exists for a call refused before any byte
 *    was sent (egress refused, data class above the endpoint's ceiling, circuit open, backpressure, credential
 *    unavailable, connection or TLS refused: `sentAttempts` 0), nor when the endpoint's own egress check (the same
 *    check the transport applied) does not allow the request's class. Those refusals are visible in the content-free
 *    metrics (`vsp_model_calls_total{outcome="UNAVAILABLE"}`, `vsp_egress_denied_total`), not as invocation records.
 */
import { ModelInvocation } from "../../protocol/models.js";
import type { ModelRole } from "../../protocol/models.js";
import type { Classification, ProcessingPurpose } from "../../protocol/common.js";
import { canonicalJson, hmacHex } from "../../shared/canonical.js";
import { ValidationError } from "../../shared/errors.js";
import { cappedBudget } from "./resilient.js";
import type { ModelCallBudget, ModelRequest, ModelResult } from "./types.js";

/** Smallest accepted digest key (bytes). */
export const MODEL_DIGEST_KEY_MIN_BYTES = 32;

export interface InvocationAuditContext {
  tenantId: string;
  requestId: string;
  interactionId: string | null;
  turnId: string | null;
  caseId: string | null;
  causationId: string | null;
  /** Model registry entry reference (`planner.primary@3`, WP-09). */
  registryRef: string;
  revision: string;
  endpointRef: string;
  region: string;
  retentionPolicyRef: string;
  pins: { promptTemplate: string; harness: string; policyVersion: string; toolSchemaDigest: string | null };
  contextSnapshotRef: string | null;
  purposes: ProcessingPurpose[];
  maxInputTokens: number;
  /** Registry cost version and price per million tokens (micro-USD), when the registry has one. */
  cost: { costVersion: string; inputMicroUsdPerMTok: number; outputMicroUsdPerMTok: number } | null;
  startedAt: Date;
  completedAt: Date;
  /** Keyed-digest secret from the composition root (audit or tenant digest key, >= 32 bytes). Never stored. */
  digestKey: string | Buffer;
  /**
   * The endpoint's per-request egress decision for a data class: the same model egress check the transport applies
   * (adapters/factory.ts `invocationEgressCheck`). A record claims allowlisting only when this allows the request.
   */
  egressAllowed: (dataClass: Classification) => boolean;
  /**
   * The endpoint's budget ceiling (ModelEndpointConfig.budget, the same `budgetCeiling` the factory gives the port).
   * The record states the budget the call actually ran with: the request's budget capped field by field at this
   * ceiling, never a larger budget the caller asked for. Absent: the request's own budget (no ceiling configured).
   */
  budgetCeiling?: ModelCallBudget;
}

/** HMAC-SHA256 over the canonical request (instructions, messages, tools, choice, schema): what the model received. */
export function modelInputDigest(request: Pick<ModelRequest, "instructions" | "messages" | "tools" | "toolChoice" | "responseSchema">, key: string | Buffer): string {
  if (Buffer.byteLength(key) < MODEL_DIGEST_KEY_MIN_BYTES) throw new ValidationError("MODEL_DIGEST_KEY_TOO_SHORT");
  const canonical = canonicalJson({ i: request.instructions, m: request.messages, t: request.tools, c: request.toolChoice, s: request.responseSchema });
  return hmacHex(key, canonical);
}

const STATUS: Record<ModelResult["outcome"], ModelInvocation["status"]> = {
  COMPLETED: "COMPLETED",
  REFUSED: "REFUSED",
  INCOMPLETE: "FAILED",
  OVERLOADED: "OVERLOADED",
  TIMED_OUT: "TIMED_OUT",
  CANCELLED: "CANCELLED",
  MALFORMED: "FAILED",
  UNAVAILABLE: "FAILED",
  FAILED: "FAILED",
};

/** True when at least one attempt's request bytes reached (or may have reached) the provider. */
export function reachedProvider(result: ModelResult): boolean {
  return result.sentAttempts >= 1;
}

/**
 * The validated ModelInvocation record of a call that reached the allowlisted endpoint, or null when it did not (see
 * the module comment). Throws when a record would violate the contract.
 */
export function modelInvocationRecord(request: ModelRequest, result: ModelResult, ctx: InvocationAuditContext): ModelInvocation | null {
  if (!reachedProvider(result)) return null;
  if (!ctx.egressAllowed(request.dataClass)) return null;
  const effective = ctx.budgetCeiling ? cappedBudget(request.budget, ctx.budgetCeiling) : request.budget;
  const usage = result.usage;
  const cost =
    usage && ctx.cost
      ? Math.round((usage.inputTokens * ctx.cost.inputMicroUsdPerMTok + usage.outputTokens * ctx.cost.outputMicroUsdPerMTok) / 1_000_000)
      : null;
  const errorCode =
    result.outcome === "COMPLETED" ? null : result.outcome === "REFUSED" ? result.refusal.reasonCode : "reasonCode" in result ? result.reasonCode : "MODEL_CALL_FAILED";
  return ModelInvocation.parse({
    schemaVersion: "model-invocation.v1",
    tenantId: ctx.tenantId,
    requestId: ctx.requestId,
    occurredAt: ctx.startedAt.toISOString(),
    interactionId: ctx.interactionId,
    turnId: ctx.turnId,
    caseId: ctx.caseId,
    causationId: ctx.causationId,
    invocationId: request.invocationId,
    role: request.role satisfies ModelRole,
    model: { registryRef: ctx.registryRef, revision: ctx.revision, endpointRef: ctx.endpointRef, region: ctx.region },
    pins: ctx.pins,
    input: { digest: modelInputDigest(request, ctx.digestKey), classification: request.dataClass, contextSnapshotRef: ctx.contextSnapshotRef },
    scope: { allowedTools: request.tools.map((t) => t.name), purposes: ctx.purposes },
    budget: { maxInputTokens: ctx.maxInputTokens, maxOutputTokens: effective.maxOutputTokens, deadlineMs: effective.deadlineMs },
    status: STATUS[result.outcome],
    completedAt: ctx.completedAt.toISOString(),
    usage: usage
      ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, latencyMs: result.latencyMs, costMicroUsd: cost, costVersion: ctx.cost?.costVersion ?? null }
      : null,
    egress: { endpointAllowlisted: true, retentionPolicyRef: ctx.retentionPolicyRef },
    contentRecorded: false,
    errorCode,
  });
}
