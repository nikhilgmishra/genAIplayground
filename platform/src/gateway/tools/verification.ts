/**
 * begin_verification (verification:begin). The locator only LOCATES a candidate
 * inside the restricted verification service; it never authenticates (AUTH-01) and is
 * never echoed, logged or audited. The response is generic for zero, one or many
 * matches (no enumeration). The secure-link match code (two words, generated for every
 * request, eligible or not; not a secret) is never a tool output field: it is spoken only
 * through the approved-template path (verification.secure_link_match_code, slot type
 * match_code) so the caller can compare it with the words the portal shows.
 */
import { z } from "zod";
import type { BusinessServices } from "../../business/services/types.js";
import { openResource } from "../../business/shared.js";
import { speechFor } from "../../business/speech.js";
import type { GenericVerificationResponse } from "../../identity/ports.js";
import { DependencyError } from "../../shared/errors.js";
import { isValidMatchCode } from "../../voice/slots.js";
import type { ToolModule } from "../ports.js";
import { DateArg, failed, ok, retryable } from "./common.js";
import { TOOL_DEFINITIONS } from "./definitions.js";

const Locator = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("PORTAL_USERNAME_HINT"), hint: z.string().regex(/^[a-z][a-z0-9._-]{2,63}$/) }),
  z.strictObject({
    kind: z.literal("NAME_AND_DATE_OF_BIRTH"),
    fullName: z.string().min(2).max(80).regex(/^[\p{L}][\p{L} .'-]{1,79}$/u),
    dateOfBirth: DateArg,
  }),
]);

export const VerificationInput = z.strictObject({
  method: z.enum(["SECURE_LINK", "ONE_TIME_CODE"]),
  locator: Locator,
});

const STATUS = ["IF_ELIGIBLE_A_LINK_WAS_SENT", "IF_ELIGIBLE_A_CODE_WAS_SENT", "VERIFICATION_UNAVAILABLE_USE_HUMAN"] as const satisfies readonly GenericVerificationResponse[];

export const VerificationOutput = z.strictObject({
  verification: z.strictObject({
    verificationId: z.string().regex(/^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$/),
    status: z.enum(STATUS),
    nextStep: z.enum(["APPROVE_SECURE_LINK_IN_PORTAL", "ENTER_CODE_ON_SECURE_PROMPT", "HUMAN_VERIFICATION"]),
  }),
});

const TEMPLATE_BY_STATUS: Record<(typeof STATUS)[number], string> = {
  IF_ELIGIBLE_A_LINK_WAS_SENT: "verification.secure_link_sent",
  IF_ELIGIBLE_A_CODE_WAS_SENT: "verification.otp_sent",
  VERIFICATION_UNAVAILABLE_USE_HUMAN: "verification.failed_generic",
};

export function beginVerificationTool(s: BusinessServices): ToolModule<z.infer<typeof VerificationInput>, z.infer<typeof VerificationOutput>> {
  return {
    definition: TOOL_DEFINITIONS.begin_verification,
    maskTarget: { collectionKey: "verification", envelopeKeys: [] },
    input: VerificationInput,
    output: VerificationOutput,
    purpose: () => "caller_self_service",
    resolveResource: async (auth) => openResource(auth, "verification_challenge", "INTERNAL"),
    async execute(ctx, input) {
      const role = ctx.auth.selectedRole;
      // Not account-specific: the same answer for every caller without a selected role.
      if (!role) return failed("ROLE_NOT_SELECTED");
      const locator = input.locator.kind === "PORTAL_USERNAME_HINT" ? { portalUsernameHint: input.locator.hint } : { fullName: input.locator.fullName, dateOfBirth: input.locator.dateOfBirth };
      let verificationId: string;
      let status: (typeof STATUS)[number];
      let matchCode: string | null = null;
      try {
        if (input.method === "SECURE_LINK") {
          const r = await s.deps.verification.beginSecureLink(ctx.auth, { role, locator });
          verificationId = r.transactionId;
          status = r.response;
          matchCode = isValidMatchCode(r.matchCode) ? r.matchCode : null;
        } else {
          const r = await s.deps.verification.beginOtp(ctx.auth, { role, locator });
          verificationId = r.challengeId;
          status = r.response;
        }
      } catch (err) {
        if (err instanceof DependencyError && err.outcome === "NOT_STARTED") return retryable("VERIFICATION_SERVICE_UNAVAILABLE");
        return failed("VERIFICATION_UNAVAILABLE_USE_HUMAN");
      }
      const nextStep = status === "VERIFICATION_UNAVAILABLE_USE_HUMAN" ? "HUMAN_VERIFICATION" : status === "IF_ELIGIBLE_A_CODE_WAS_SENT" ? "ENTER_CODE_ON_SECURE_PROMPT" : "APPROVE_SECURE_LINK_IN_PORTAL";
      const speech =
        status === "IF_ELIGIBLE_A_LINK_WAS_SENT" && matchCode !== null
          ? speechFor(s.deps.templates, "verification.secure_link_match_code", { matchCode })
          : speechFor(s.deps.templates, TEMPLATE_BY_STATUS[status]);
      return ok({ verification: { verificationId, status, nextStep } }, speech);
    },
  };
}
