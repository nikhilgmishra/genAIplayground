/**
 * Follow-on versions of the tool boundary contracts (follow-on prompt section 4; FO-04-15,
 * FO-04-17, FO-04-18): ToolRequestV2 and ToolResultV2.
 *
 * Both derive from the wire schemas in tools.ts (one source) and add the common envelope (schema
 * version, tenant, session generation, causation), bounded arguments and result data, receipt refs
 * and a safe explanation code on every branch, and the freshness of the permitted facts (source
 * watermark and age) on every SUCCESS and PENDING result.
 *
 * tools.ts belongs to the registry shared group, whose phase owner (WP-07 in phase B) switches the
 * gateway pipeline, the HTTP/MCP routes and the generated OpenAPI from ToolRequest/ToolResult to
 * these versions; until then the gateway keeps serving the original wire schemas.
 */
import { z } from "zod";
import { EvidencePointer, IsoDateTime, MAX_CLOCK_SKEW_MS, OpaqueId, SessionGeneration, SourceSystemId, findForbiddenProposalField } from "./common.js";
import { WatermarkId } from "./context-facts.js";
import { ReasonCode, SpeechDirective, ToolRequest, ToolResult } from "./tools.js";

export const TOOL_REQUEST_V2_SCHEMA_VERSION = "tool-request.v2";
export const TOOL_RESULT_V2_SCHEMA_VERSION = "tool-result.v2";

/** Largest serialized tool argument object (equals the catalogue's maxInputBytes ceiling). */
export const MAX_TOOL_ARGUMENT_BYTES = 16_384;
/** Largest serialized result `data` object. */
export const MAX_TOOL_RESULT_DATA_BYTES = 65_536;

function boundedRecord(maxKeys: number, maxBytes: number) {
  return z
    .record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/), z.unknown())
    .superRefine((rec, ctx) => {
      if (Object.keys(rec).length > maxKeys) ctx.addIssue({ code: "custom", message: "TOO_MANY_KEYS" });
      let size: number;
      try {
        size = new TextEncoder().encode(JSON.stringify(rec)).length;
      } catch {
        ctx.addIssue({ code: "custom", message: "NOT_JSON" });
        return;
      }
      if (size > maxBytes) ctx.addIssue({ code: "custom", message: "PAYLOAD_TOO_LARGE" });
    })
    .meta({ maxProperties: maxKeys, "x-max-serialized-bytes": maxBytes });
}

/**
 * Tool arguments from the untrusted conversational layer: bounded, and never carrying a
 * server-established or prototype key at any depth in any spelling (AUTH-03). The key scan runs on
 * the RAW value before the record is parsed, because zod drops an own `__proto__` key silently.
 */
export const BoundedToolArguments = z.preprocess((raw, ctx) => {
  const hit = findForbiddenProposalField(raw, 8);
  if (hit) ctx.addIssue({ code: "custom", message: `SERVER_ESTABLISHED_FIELD_IN_ARGUMENTS:${hit}`, input: raw });
  return raw;
}, boundedRecord(32, MAX_TOOL_ARGUMENT_BYTES));
/** Typed permitted facts after the field mask (trusted gateway output); bounded in keys and size. */
export const BoundedResultData = boundedRecord(64, MAX_TOOL_RESULT_DATA_BYTES);

export const ToolRequestV2 = ToolRequest.extend({
  schemaVersion: z.literal(TOOL_REQUEST_V2_SCHEMA_VERSION),
  /** Set by the gateway from the authenticated integration, never from the request body. */
  tenantId: OpaqueId,
  /** Interaction and session generation from the trusted CallBinding; null on session-less safety/human routes (SAFE-02). */
  interactionId: OpaqueId.nullable(),
  sessionGeneration: SessionGeneration.nullable(),
  /** Model decision or upstream event that caused the request. */
  causationId: OpaqueId.nullable(),
  arguments: BoundedToolArguments,
});
export type ToolRequestV2 = z.infer<typeof ToolRequestV2>;

/**
 * Freshness of the permitted facts in a result: per source, the watermark and the age of the newest
 * evidence. Unknown age is stale; a result is never "fresh" by default.
 */
export const ToolResultFreshness = z
  .strictObject({
    observedAt: IsoDateTime,
    maxAgeMs: z.number().int().min(0).max(31 * 86_400_000),
    sources: z
      .array(
        z.strictObject({
          system: SourceSystemId,
          /**
           * Source watermark the facts were read under (FO-04-18). Always present: a fresh
           * authoritative read advances its source watermark, so it is never "no watermark".
           */
          watermarkId: WatermarkId,
          sourceUpdatedAt: IsoDateTime.nullable(),
          /** Age of the newest evidence for the source; null is unknown age, which is always stale. */
          ageMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
        }),
      )
      .min(1)
      .max(16),
    stale: z.boolean(),
  })
  .superRefine((f, ctx) => {
    const unknownOrOld = f.sources.some((s) => s.ageMs === null || s.ageMs > f.maxAgeMs);
    if (unknownOrOld && !f.stale) ctx.addIssue({ code: "custom", message: "STALE_RESULT_REPORTED_FRESH", path: ["stale"] });
    // A source update stamped after the read observed it (beyond clock skew) is not evidence.
    f.sources.forEach((s, i) => {
      if (s.sourceUpdatedAt !== null && Date.parse(s.sourceUpdatedAt) > Date.parse(f.observedAt) + MAX_CLOCK_SKEW_MS) {
        ctx.addIssue({ code: "custom", message: "SOURCE_UPDATE_AFTER_OBSERVATION", path: ["sources", i, "sourceUpdatedAt"] });
      }
    });
  });
export type ToolResultFreshness = z.infer<typeof ToolResultFreshness>;

/** SpeechDirective with bounded typed slots (at most 16, bounded numbers) and opaque source refs (no free text). */
export const SpeechDirectiveV2 = SpeechDirective.extend({
  /** Knowledge citation ids, action receipt ids or source record refs: opaque pointers, never prose. */
  sourceRefs: z.array(EvidencePointer).max(16),
  slots: z
    .record(z.string().regex(/^[a-z][a-zA-Z0-9]{0,40}$/), z.union([z.string().max(200), z.number().finite().min(-1e13).max(1e13), z.boolean()]))
    .refine((r) => Object.keys(r).length <= 16, "too many slots")
    .meta({ maxProperties: 16 }),
});
export type SpeechDirectiveV2 = z.infer<typeof SpeechDirectiveV2>;

const V2_COMMON = {
  speech: SpeechDirectiveV2.nullable(),
  schemaVersion: z.literal(TOOL_RESULT_V2_SCHEMA_VERSION),
  tenantId: OpaqueId,
  causationId: OpaqueId.nullable(),
  /** Commit receipts, effect verifications or source record refs backing the result. */
  receiptRefs: z.array(OpaqueId).max(16),
  /** Safe explanation code on every branch (no free text, no model narrative). */
  explanationCode: ReasonCode,
};

const [SuccessV1, RetryableV1, PermanentV1, DeniedV1, PendingV1, UnknownV1] = ToolResult.options;

/** Builds the six-branch V2 union; `data` is the typed permitted-facts schema for SUCCESS and PENDING. */
export function toolResultV2<T extends z.ZodType>(data: T) {
  return z.discriminatedUnion("status", [
    SuccessV1.extend({ ...V2_COMMON, data, freshness: ToolResultFreshness }),
    RetryableV1.extend(V2_COMMON),
    PermanentV1.extend(V2_COMMON),
    DeniedV1.extend(V2_COMMON),
    PendingV1.extend({ ...V2_COMMON, data, freshness: ToolResultFreshness }),
    UnknownV1.extend(V2_COMMON),
  ]);
}

/** Generic V2 result with bounded untyped data; per-tool results use toolResultV2(outputSchema). */
export const ToolResultV2 = toolResultV2(BoundedResultData);
export type ToolResultV2 = z.infer<typeof ToolResultV2>;

/** Lifts a wire ToolResult into V2 with the trusted fields the gateway supplies. */
export function toolResultV2From(
  legacy: ToolResult,
  trusted: { tenantId: string; causationId: string | null; receiptRefs: string[]; explanationCode: string; freshness: ToolResultFreshness | null },
): ToolResultV2 {
  const r = ToolResult.parse(legacy);
  const common = {
    schemaVersion: TOOL_RESULT_V2_SCHEMA_VERSION,
    tenantId: trusted.tenantId,
    causationId: trusted.causationId,
    receiptRefs: trusted.receiptRefs,
    explanationCode: trusted.explanationCode,
  };
  if (r.status === "SUCCESS" || r.status === "PENDING") return ToolResultV2.parse({ ...r, ...common, freshness: trusted.freshness });
  return ToolResultV2.parse({ ...r, ...common });
}
