/**
 * ModelInvocation and ModelDecision (follow-on prompt section 9; FO-04-13, FO-04-14; OPS-06).
 *
 * A ModelInvocation is the minimized audit record of one model call: the pinned registry entry,
 * prompt/tool/policy/harness versions, the digest and classification of what the model received,
 * the tool and data scope it was allowed, its budgets and its actual usage and outcome. Model
 * identifiers are configuration data in the model registry; this contract carries only references.
 *
 * A ModelDecision is typed model output and is a PROPOSAL ONLY: deterministic authorization,
 * confirmation and effect verification always outrank model confidence. A proposal can never
 * carry a server-established field (AUTH-03), so a model cannot set tenant, actor, subject,
 * role, assurance, consent, scopes or session generation.
 *
 * Created by WP-02 in phase B; owned by WP-09 from phase C.
 */
import { z } from "zod";
import {
  Classification,
  OpaqueId,
  ProcessingPurpose,
  Sha256Hex,
  VersionLabel,
  envelope,
  findForbiddenProposalField,
  opaqueIdWithPrefix,
} from "./common.js";
import { CitationId } from "./knowledge.js";
import { TransferReason } from "./support.js";
import { ReasonCode, ResponseClass, ToolName, ToolRef } from "./tools.js";

export const MODEL_INVOCATION_SCHEMA_VERSION = "model-invocation.v1";
export const MODEL_DECISION_SCHEMA_VERSION = "model-decision.v1";

export const ModelRole = z.enum([
  "frontier_planner",
  "router",
  "extractor",
  "summarizer",
  "retrieval_embedder",
  "reranker",
  "safety_auxiliary",
  "monitor_judge",
  "asr",
  "tts",
  "vad",
  "native_audio",
]);
export type ModelRole = z.infer<typeof ModelRole>;

/** Model registry entry reference (platform/config/model-registry, WP-09), e.g. `planner.primary@3`. */
export const ModelRegistryRef = z.string().regex(/^[a-z][a-z0-9_.-]{1,63}@[1-9][0-9]{0,5}$/, "model registry entry reference expected");

export const InvocationId = opaqueIdWithPrefix("minv");

export const ModelInvocationStatus = z.enum(["STARTED", "COMPLETED", "REFUSED", "TIMED_OUT", "CANCELLED", "OVERLOADED", "FAILED"]);
export type ModelInvocationStatus = z.infer<typeof ModelInvocationStatus>;

const TokenCount = z.number().int().min(0).max(10_000_000);

export const ModelInvocation = z
  .strictObject({
    ...envelope(MODEL_INVOCATION_SCHEMA_VERSION, ["tenantId", "requestId", "occurredAt"], ["interactionId", "turnId", "caseId", "causationId"]),
    invocationId: InvocationId,
    role: ModelRole,
    model: z.strictObject({
      registryRef: ModelRegistryRef,
      /** Exact revision pinned by the registry entry (configuration data, not a code constant). */
      revision: VersionLabel,
      endpointRef: z.string().regex(/^[a-z][a-z0-9_.-]{2,63}$/),
      region: z.string().regex(/^[a-z]{2}(-[a-z]+)+-[0-9]$|^local$/),
    }),
    pins: z.strictObject({
      promptTemplate: VersionLabel,
      harness: VersionLabel,
      policyVersion: VersionLabel,
      toolSchemaDigest: Sha256Hex.nullable(),
    }),
    input: z.strictObject({
      digest: Sha256Hex,
      classification: Classification,
      contextSnapshotRef: opaqueIdWithPrefix("ctx").nullable(),
    }),
    scope: z.strictObject({
      allowedTools: z.array(ToolName).max(32),
      purposes: z.array(ProcessingPurpose).min(1).max(8),
    }),
    budget: z.strictObject({
      maxInputTokens: TokenCount,
      maxOutputTokens: TokenCount,
      deadlineMs: z.number().int().min(1).max(600_000),
    }),
    status: ModelInvocationStatus,
    completedAt: z.iso.datetime({ offset: false }).nullable(),
    usage: z
      .strictObject({
        inputTokens: TokenCount,
        outputTokens: TokenCount,
        latencyMs: z.number().int().min(0).max(3_600_000),
        /** Cost in micro-USD from the registry's cost version; null when the provider reports none. */
        costMicroUsd: z.number().int().min(0).max(1_000_000_000_000).nullable(),
        costVersion: VersionLabel.nullable(),
      })
      .nullable(),
    egress: z.strictObject({
      /** The endpoint was on the egress allowlist with its approved region and retention terms. */
      endpointAllowlisted: z.literal(true),
      retentionPolicyRef: z.string().regex(/^[a-z][a-z0-9_.-]{2,63}$/),
    }),
    /** Restricted content (prompt/response text) recorded only under its retention/purpose policy. */
    contentRecorded: z.boolean(),
    errorCode: ReasonCode.nullable(),
  })
  .superRefine((m, ctx) => {
    if (m.input.classification === "VERIFICATION_SECRET") ctx.addIssue({ code: "custom", message: "VERIFICATION_SECRET_SENT_TO_MODEL", path: ["input", "classification"] });
    if (m.status === "STARTED" && (m.completedAt !== null || m.usage !== null)) ctx.addIssue({ code: "custom", message: "STARTED_WITH_COMPLETION", path: ["status"] });
    if (m.status !== "STARTED" && m.completedAt === null) ctx.addIssue({ code: "custom", message: "FINISHED_WITHOUT_COMPLETION_TIME", path: ["completedAt"] });
    if (m.usage && (m.usage.inputTokens > m.budget.maxInputTokens || m.usage.outputTokens > m.budget.maxOutputTokens)) {
      ctx.addIssue({ code: "custom", message: "USAGE_EXCEEDS_BUDGET", path: ["usage"] });
    }
    if (["FAILED", "REFUSED", "OVERLOADED", "TIMED_OUT"].includes(m.status) && m.errorCode === null) {
      ctx.addIssue({ code: "custom", message: "FAILURE_WITHOUT_CODE", path: ["errorCode"] });
    }
  });
export type ModelInvocation = z.infer<typeof ModelInvocation>;

/* ------------------------------------------------------------------------ */
/* ModelDecision                                                             */
/* ------------------------------------------------------------------------ */

const MAX_PROPOSAL_ARGUMENT_BYTES = 8_192;

/**
 * Tool arguments proposed by a model: a bounded JSON object (key count, serialized size, depth)
 * that never names a server-established or prototype key at any depth, in any spelling (AUTH-03).
 * The key scan runs on the RAW value before the record is parsed: zod drops an own `__proto__` key
 * from a record silently, so scanning the parsed value would miss it.
 */
export const ProposedArguments = z.preprocess(
  (raw, ctx) => {
    const hit = findForbiddenProposalField(raw, 6);
    if (hit) ctx.addIssue({ code: "custom", message: `SERVER_ESTABLISHED_FIELD_IN_PROPOSAL:${hit}`, input: raw });
    return raw;
  },
  z
    .record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/), z.unknown())
    .superRefine((args, ctx) => {
      if (Object.keys(args).length > 32) ctx.addIssue({ code: "custom", message: "TOO_MANY_ARGUMENTS" });
      let size: number;
      try {
        // UTF-8 bytes, as advertised by x-max-serialized-bytes (and as BoundedToolArguments counts).
        size = new TextEncoder().encode(JSON.stringify(args)).length;
      } catch {
        ctx.addIssue({ code: "custom", message: "ARGUMENTS_NOT_JSON" });
        return;
      }
      if (size > MAX_PROPOSAL_ARGUMENT_BYTES) ctx.addIssue({ code: "custom", message: "ARGUMENTS_TOO_LARGE" });
    })
    .meta({ maxProperties: 32, "x-max-serialized-bytes": MAX_PROPOSAL_ARGUMENT_BYTES }),
);

export const ModelDecisionBody = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("TOOL_PROPOSAL"), tool: ToolRef, arguments: ProposedArguments }),
  z.strictObject({
    kind: z.literal("SPEECH_REQUEST"),
    utteranceClass: ResponseClass,
    /** Approved template the harness asks the gateway to plan; the gateway decides the final SpeechPlan. */
    templateId: z.string().regex(/^[a-z][a-z0-9_.]{2,80}$/).nullable(),
    /** Opaque fact, receipt or record ids, or knowledge citation ids: never free text (no PHI-shaped strings). */
    sourceRefs: z.array(z.union([OpaqueId, CitationId])).max(16),
  }),
  z.strictObject({ kind: z.literal("CLARIFY"), questionTemplateId: z.string().regex(/^[a-z][a-z0-9_.]{2,80}$/) }),
  z.strictObject({ kind: z.literal("HANDOFF_PROPOSAL"), reason: TransferReason }),
  z.strictObject({
    kind: z.literal("SAFETY_SIGNAL"),
    /** Routing signal with uncertainty and reason codes; never a diagnosis or clinical risk score (SAFE-01). */
    signal: z.enum(["EXPLICIT_CONCERN", "INDIRECT_CONCERN", "THIRD_PARTY_CONCERN", "UNCERTAIN"]),
    uncertainty: z.number().min(0).max(1),
    reasonCodes: z.array(ReasonCode).min(1).max(8),
  }),
  z.strictObject({
    kind: z.literal("INTENT_CANDIDATES"),
    candidates: z.array(z.strictObject({ intent: z.string().regex(/^[a-z_]{3,64}$/), score: z.number().min(0).max(1) })).min(1).max(5),
  }),
  z.strictObject({ kind: z.literal("REFUSAL"), reasonCode: ReasonCode }),
  z.strictObject({ kind: z.literal("END_TURN") }),
]);
export type ModelDecisionBody = z.infer<typeof ModelDecisionBody>;

export const ModelDecision = z.strictObject({
  ...envelope(MODEL_DECISION_SCHEMA_VERSION, ["tenantId", "causationId", "occurredAt"], ["interactionId", "turnId"]),
  decisionId: opaqueIdWithPrefix("mdec"),
  invocationId: InvocationId,
  /** Model output never grants authority; the gateway re-authorizes every proposal. */
  authority: z.literal("PROPOSAL_ONLY"),
  /** Model-reported confidence, informational only: never an authorization or confirmation signal. */
  modelConfidence: z.number().min(0).max(1).nullable(),
  decisions: z.array(ModelDecisionBody).min(1).max(8),
});
export type ModelDecision = z.infer<typeof ModelDecision>;
