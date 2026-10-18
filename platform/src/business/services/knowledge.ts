/**
 * Public FAQ and portal login guidance from the approved knowledge corpus (spec
 * section 9). The audience is server-established: the policy catalogue action
 * (public:read, login_help:read) covers the reviewed PUBLIC corpus only, so search
 * always runs with audience "public" and the session's assurance (an A0 caller can
 * never reach a non-public item). Every hit carries its exact citation version.
 * Login help never resets credentials and never asks for a password.
 */
import type { KnowledgeHit } from "../../knowledge/ports.js";
import type { AuthContext } from "../../protocol/index.js";
import type { ToolDeps } from "../contract.js";

export const PUBLIC_FAQ_INTENTS = [
  "accessibility_help",
  "interpreter_request",
  "appointment_reschedule",
  "billing_statement_explain",
  "claim_status",
  "complaint_intake",
  "payment_help",
  "notification_question",
  "portal_login_help",
  "human_request",
  "recording_question",
  "representative_access",
  "case_follow_up",
  "verification_help",
  "provider_onboarding",
] as const;
export type PublicFaqIntent = (typeof PUBLIC_FAQ_INTENTS)[number];

/** Jurisdiction comes from trusted configuration; the local SYNTHETIC corpus is US. */
export const DEFAULT_JURISDICTION = "US";

export class KnowledgeAnswers {
  constructor(
    private readonly deps: ToolDeps,
    private readonly jurisdiction: string = DEFAULT_JURISDICTION,
  ) {}

  async search(auth: AuthContext, input: { intent: string; query: string | null; language: string; limit: number }): Promise<KnowledgeHit[]> {
    return this.deps.knowledge.search({
      tenantId: auth.tenantId,
      query: input.query ?? input.intent.replace(/_/g, " "),
      audience: "public",
      assurance: auth.assurance,
      intent: input.intent,
      language: input.language,
      jurisdiction: this.jurisdiction,
      now: this.deps.clock.now(),
      limit: input.limit,
    });
  }
}
