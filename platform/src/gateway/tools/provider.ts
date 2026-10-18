/**
 * get_provider_onboarding_status (onboarding:read), get_remittance_status
 * (remittance:read) and submit_partner_intake (partner_intake:create).
 *
 * - Onboarding: the provider record is the resource subject. The provider network port
 *   exposes no authoritative provider -> practice mapping, so a practice-staff request for
 *   another provider resolves without an organization and policy denies it (fail closed;
 *   interface change request filed for ProviderSystem).
 * - Remittance: the resource is the practice ORGANIZATION (own practice by default); a
 *   practice the caller holds no delegation for is denied by policy.
 * - Partner intake: the partner's server-established organization only; no input can
 *   name an individual.
 */
import { z } from "zod";
import type { OnboardingStatus, Remittance } from "../../adapters/ports.js";
import { PARTNER_REQUEST_TYPES, URGENCY } from "../../business/services/intake.js";
import type { BusinessServices } from "../../business/services/types.js";
import { organizationResource, subjectResource, unresolvableResource } from "../../business/shared.js";
import { speechFor } from "../../business/speech.js";
import { canonicalJson, sha256Hex } from "../../shared/canonical.js";
import type { AuthContext, PolicyPurpose } from "../../protocol/index.js";
import type { ToolModule } from "../ports.js";
import { DateArg, Id, InstantArg, SupportRefArg, denied, fromError, ok, sourceRef } from "./common.js";
import { TOOL_DEFINITIONS } from "./definitions.js";

const DOCUMENT_TYPES = ["LICENSE", "MALPRACTICE_INSURANCE", "W9", "DEA", "BOARD_CERTIFICATION"] as const;

export const OnboardingInput = z.strictObject({ providerId: Id.nullable(), detail: z.enum(["STAGE", "DOCUMENTS"]) });
export const OnboardingOutput = z.strictObject({
  onboarding: z.strictObject({
    stage: z.enum(["APPLICATION_RECEIVED", "DOCUMENTS_PENDING", "CREDENTIALING_IN_REVIEW", "CONTRACTING", "ACTIVE", "ON_HOLD"]),
    missingDocumentTypes: z.array(z.enum(DOCUMENT_TYPES)).max(5),
    asOf: InstantArg,
  }),
  detail: z.enum(["STAGE", "DOCUMENTS"]),
});

const STAGE_TEMPLATE: Record<OnboardingStatus["stage"], string> = {
  APPLICATION_RECEIVED: "IN_REVIEW",
  DOCUMENTS_PENDING: "DOCUMENTS_PENDING",
  CREDENTIALING_IN_REVIEW: "IN_REVIEW",
  CONTRACTING: "IN_REVIEW",
  ACTIVE: "ACTIVE",
  ON_HOLD: "ON_HOLD",
};

const onboardingPurpose = (auth: AuthContext, providerId: string | null): PolicyPurpose =>
  auth.selectedRole === "provider" && (providerId === null || providerId === auth.subjectId) ? "caller_self_service" : "delegated_practice_administration";

export function getProviderOnboardingStatusTool(s: BusinessServices): ToolModule<z.infer<typeof OnboardingInput>, z.infer<typeof OnboardingOutput>> {
  return {
    definition: TOOL_DEFINITIONS.get_provider_onboarding_status,
    maskTarget: { collectionKey: "onboarding", envelopeKeys: ["detail"] },
    input: OnboardingInput,
    output: OnboardingOutput,
    purpose: (auth, input) => onboardingPurpose(auth, input.providerId),
    async resolveResource(auth, input) {
      const providerId = input.providerId ?? auth.subjectId;
      if (!providerId) return unresolvableResource(auth, "provider_onboarding", "INTERNAL");
      const record = await s.deps.adapters.provider.getOnboardingStatus(providerId);
      return record ? subjectResource(auth, "provider_onboarding", record.providerId, "INTERNAL") : unresolvableResource(auth, "provider_onboarding", "INTERNAL");
    },
    async execute(ctx, input) {
      try {
        const providerId = input.providerId ?? ctx.auth.subjectId;
        const record = providerId ? await s.deps.adapters.provider.getOnboardingStatus(providerId) : null;
        if (!record) return denied("RESOURCE_NOT_AUTHORIZED");
        const refs = [sourceRef("provider", record.providerId)];
        const firstMissing = record.missingDocumentTypes[0];
        const speech =
          input.detail === "DOCUMENTS" && firstMissing
            ? speechFor(s.deps.templates, "credentialing.documents_missing", { missingCount: record.missingDocumentTypes.length, documentType: firstMissing }, refs)
            : speechFor(s.deps.templates, "onboarding.status", { stage: STAGE_TEMPLATE[record.stage], missingCount: record.missingDocumentTypes.length }, refs);
        return ok({ onboarding: { stage: record.stage, missingDocumentTypes: [...record.missingDocumentTypes], asOf: record.asOf }, detail: input.detail }, speech);
      } catch (err) {
        return fromError(err, "PROVIDER_LOOKUP_FAILED");
      }
    },
  };
}

const MAX_REMITTANCE_DAYS = 92;
export const RemittanceInput = z
  .strictObject({ practiceId: Id.nullable(), fromDate: DateArg, toDate: DateArg })
  .refine((v) => v.toDate >= v.fromDate && (Date.parse(v.toDate) - Date.parse(v.fromDate)) / 86_400_000 < MAX_REMITTANCE_DAYS, { message: "WINDOW_INVALID" });
const RemittanceRecord = z.strictObject({
  remittanceId: Id,
  periodStart: DateArg,
  periodEnd: DateArg,
  totalMinor: z.number().int().min(0),
  status: z.enum(["SCHEDULED", "SENT", "RETURNED"]),
  paidOn: DateArg.nullable(),
});
export const RemittanceOutput = z.strictObject({ remittances: z.array(RemittanceRecord).max(24), remittanceCount: z.number().int().min(0).max(24) });

export function getRemittanceStatusTool(s: BusinessServices): ToolModule<z.infer<typeof RemittanceInput>, z.infer<typeof RemittanceOutput>> {
  return {
    definition: TOOL_DEFINITIONS.get_remittance_status,
    maskTarget: { collectionKey: "remittances", envelopeKeys: ["remittanceCount"] },
    input: RemittanceInput,
    output: RemittanceOutput,
    purpose: () => "delegated_practice_administration",
    async resolveResource(auth, input) {
      const practice = input.practiceId ?? auth.organizationId;
      return practice ? organizationResource(auth, "remittance", practice, "FINANCIAL") : unresolvableResource(auth, "remittance", "FINANCIAL");
    },
    async execute(ctx, input) {
      const practice = input.practiceId ?? ctx.auth.organizationId;
      if (!practice) return denied("RESOURCE_NOT_AUTHORIZED");
      try {
        const list: Remittance[] = (await s.deps.adapters.provider.listRemittances({ practiceId: practice, fromDate: input.fromDate, toDate: input.toDate }))
          // Defense in depth: only the authorized practice's records leave this tool.
          .filter((r) => r.practiceId === practice)
          .slice(0, 24);
        const first = list[0];
        const refs = first ? [sourceRef("provider", first.remittanceId)] : [];
        const speech = !first
          ? speechFor(s.deps.templates, "lookup.none_found")
          : first.status === "RETURNED"
            ? speechFor(s.deps.templates, "remittance.returned", { periodStart: first.periodStart, periodEnd: first.periodEnd, amount: first.totalMinor }, refs)
            : speechFor(s.deps.templates, "remittance.status", { periodStart: first.periodStart, periodEnd: first.periodEnd, remittanceStatus: first.status, amount: first.totalMinor }, refs);
        return ok(
          {
            remittances: list.map((r) => ({ remittanceId: r.remittanceId, periodStart: r.periodStart, periodEnd: r.periodEnd, totalMinor: r.totalMinor, status: r.status, paidOn: r.paidOn })),
            remittanceCount: list.length,
          },
          speech,
        );
      } catch (err) {
        return fromError(err, "REMITTANCE_LOOKUP_FAILED");
      }
    },
  };
}

export const PartnerIntakeInput = z.strictObject({ requestType: z.enum(PARTNER_REQUEST_TYPES), urgency: z.enum(URGENCY), language: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/) });
export const PartnerIntakeOutput = z.strictObject({
  intake: z.strictObject({ status: z.literal("REQUEST_ACCEPTED"), supportReference: SupportRefArg }),
  workflowAccepted: z.boolean(),
});

export const argsDigest = (input: unknown): string => sha256Hex(canonicalJson(input));

export function submitPartnerIntakeTool(s: BusinessServices): ToolModule<z.infer<typeof PartnerIntakeInput>, z.infer<typeof PartnerIntakeOutput>> {
  const definition = TOOL_DEFINITIONS.submit_partner_intake;
  return {
    definition,
    maskTarget: { collectionKey: "intake", envelopeKeys: ["workflowAccepted"] },
    input: PartnerIntakeInput,
    output: PartnerIntakeOutput,
    purpose: () => "partner_administration",
    resolveResource: async (auth) => (auth.organizationId ? organizationResource(auth, "partner_intake", auth.organizationId, "INTERNAL") : unresolvableResource(auth, "partner_intake", "INTERNAL")),
    async execute(ctx, input) {
      if (!ctx.auth.organizationId) return denied("RESOURCE_NOT_AUTHORIZED");
      try {
        const r = await s.intake.partner({ auth: ctx.auth, turnId: ctx.request.turnId, tool: definition.name, argsDigest: argsDigest(input), language: input.language }, input);
        return ok(
          { intake: { status: "REQUEST_ACCEPTED", supportReference: r.supportRequest.referenceNumber }, workflowAccepted: r.workflowId !== null },
          speechFor(s.deps.templates, "commitment.request_accepted_pending_sync", { supportReference: r.supportRequest.referenceNumber }, [sourceRef("sr", r.supportRequest.supportRequestId)]),
        );
      } catch (err) {
        return fromError(err, "INTAKE_FAILED");
      }
    },
  };
}
