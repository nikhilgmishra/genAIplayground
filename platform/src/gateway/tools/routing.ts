/**
 * request_human_transfer (human:request) and request_safety_route (safety:route).
 * SAFETY_AND_HUMAN_ROUTE: never require authentication, never gated by kill switches,
 * budgets or admission (SAFE-02, SAFE-03). No input can carry a destination: the
 * HandoffService resolves it from trusted configuration only (SAFE-05). The tool never
 * reports TRANSFERRED: a requested or dialled transfer is not a connection (SAFE-04).
 */
import { z } from "zod";
import type { DestinationConfig } from "../../config/ports.js";
import type { BusinessServices } from "../../business/services/types.js";
import { openResource } from "../../business/shared.js";
import { speechFor } from "../../business/speech.js";
import { IssueCategory } from "../../protocol/index.js";
import type { SafetySignal } from "../../safety/ports.js";
import type { ToolModule } from "../ports.js";
import { Id, LanguageArg, SupportRefArg, ok } from "./common.js";
import { TOOL_DEFINITIONS } from "./definitions.js";

const HUMAN_REASONS = [
  "CALLER_REQUESTED_HUMAN",
  "CLINICAL_QUESTION",
  "POLICY_REQUIRES_HUMAN",
  "VERIFICATION_RECOVERY",
  "UNSUPPORTED_LANGUAGE",
  "ACCESSIBILITY",
  "DEPENDENCY_FAILURE",
  "CONSENT_DECLINED_ALTERNATIVE",
] as const;

const Purpose = z.enum(["SAFETY_PRIORITY", "STANDARD_SUPPORT", "INTERPRETER", "CLINICAL_ROUTE", "PROVIDER_SUPPORT", "PARTNER_SUPPORT", "BILLING_SPECIALIST", "OUTAGE_CONTINUITY", "UNAVAILABLE"]);
const RouteStatus = z.enum(["TRANSFER_REQUESTED", "CONNECTED", "ROUTE_UNAVAILABLE_USE_STUDIO_ROUTE"]);

export const HumanInput = z.strictObject({
  reason: z.enum(HUMAN_REASONS),
  language: LanguageArg,
  issueCategory: IssueCategory.nullable(),
  accommodations: z.array(z.enum(["interpreter", "relay_service", "slower_speech", "repeat_on_request", "tty"])).max(5),
});
export const HumanOutput = z.strictObject({
  handoff: z.strictObject({ status: RouteStatus, transferId: Id.nullable(), destinationPurpose: Purpose, supportReference: SupportRefArg.nullable() }),
});

const purposeOf = (destinations: readonly DestinationConfig[], id: string): z.infer<typeof Purpose> => destinations.find((d) => d.destinationId === id)?.purpose ?? "UNAVAILABLE";

const statusOf = (j: { status: string } | null): z.infer<typeof RouteStatus> =>
  !j ? "ROUTE_UNAVAILABLE_USE_STUDIO_ROUTE" : j.status === "CONNECTED" || j.status === "COMPLETED" ? "CONNECTED" : "TRANSFER_REQUESTED";

export function requestHumanTransferTool(s: BusinessServices): ToolModule<z.infer<typeof HumanInput>, z.infer<typeof HumanOutput>> {
  return {
    definition: TOOL_DEFINITIONS.request_human_transfer,
    maskTarget: { collectionKey: "handoff", envelopeKeys: [] },
    input: HumanInput,
    output: HumanOutput,
    purpose: () => "human_handoff",
    resolveResource: async (auth) => openResource(auth, "support_request", "INTERNAL"),
    async execute(ctx, input) {
      const r = await s.handoff.requestHuman({
        tenantId: ctx.auth.tenantId,
        callId: ctx.auth.callId,
        ctx: ctx.auth,
        reason: input.reason,
        language: input.language,
        issueCategory: input.issueCategory,
        accommodations: input.accommodations,
      });
      return ok(
        { handoff: { status: statusOf(r.journey), transferId: r.transferId, destinationPurpose: purposeOf(s.deps.destinations, r.destinationId), supportReference: r.supportReference ?? null } },
        speechFor(s.deps.templates, r.speechTemplateId),
      );
    },
  };
}

export const SafetyInput = z.strictObject({
  signalSource: z.enum(["EXPLICIT_PHRASE", "SEMANTIC_SIGNAL", "CALLER_REQUEST"]),
  concernSubject: z.enum(["SELF", "THIRD_PARTY", "UNKNOWN"]),
  language: LanguageArg,
});
export const SafetyOutput = z.strictObject({
  handoff: z.strictObject({ status: RouteStatus, transferId: Id.nullable(), destinationPurpose: Purpose }),
});

export function requestSafetyRouteTool(s: BusinessServices): ToolModule<z.infer<typeof SafetyInput>, z.infer<typeof SafetyOutput>> {
  return {
    definition: TOOL_DEFINITIONS.request_safety_route,
    maskTarget: { collectionKey: "handoff", envelopeKeys: [] },
    input: SafetyInput,
    output: SafetyOutput,
    purpose: () => "safety_routing",
    resolveResource: async (auth) => openResource(auth, "support_request", "INTERNAL"),
    async execute(ctx, input) {
      // The conversational layer's request is itself an (unresolved) signal; deterministic
      // routing does the rest. Credibility is never inferred from the model.
      const signal: SafetySignal = {
        source: input.signalSource,
        ruleId: "tool.request_safety_route",
        strength: "UNRESOLVED",
        subject: input.concernSubject,
        temporal: "UNKNOWN",
        negated: false,
        locale: input.language,
      };
      const r = await s.handoff.requestSafetyRoute({ tenantId: ctx.auth.tenantId, callId: ctx.auth.callId, ctx: ctx.auth, signals: [signal], locale: input.language, validatedAt: ctx.now });
      return ok({ handoff: { status: statusOf(r.journey), transferId: r.transferId, destinationPurpose: purposeOf(s.deps.destinations, r.destinationId) } }, speechFor(s.deps.templates, r.speechTemplateId));
    },
  };
}
