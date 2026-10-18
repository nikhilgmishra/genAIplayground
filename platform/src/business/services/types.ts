/** The business services the tool modules use (built once per ToolDeps by buildBusiness). */
import type { HandoffService, InteractionOutcomeService, ToolDeps } from "../contract.js";
import type { InteractionIndex } from "../interactions.js";
import type { PgSupportRequestService } from "../support/support-request-service.js";
import type { AppointmentService } from "./appointments.js";
import type { BillingService } from "./billing.js";
import type { CaseService } from "./cases.js";
import type { IntakeService } from "./intake.js";
import type { KnowledgeAnswers } from "./knowledge.js";

export interface BusinessServices {
  deps: ToolDeps;
  interactions: InteractionIndex;
  support: PgSupportRequestService;
  appointments: AppointmentService;
  billing: BillingService;
  intake: IntakeService;
  cases: CaseService;
  knowledge: KnowledgeAnswers;
  handoff: HandoffService;
  outcomes: InteractionOutcomeService;
}
