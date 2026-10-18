/**
 * Business layer: versioned resolution contracts, business services, provider commit
 * ports, the support-request service, handoff, interaction outcomes, outbox consumers
 * and the tool modules (platform/src/gateway/tools). See README.md.
 */
import { createBusinessToolModules } from "../gateway/tools/index.js";
import type { BuildBusiness, BusinessModule, ToolDeps } from "./contract.js";
import { confirmationSlotsFor } from "./confirmation.js";
import { buildConsumers } from "./consumers.js";
import { RESOLUTION_CONTRACTS } from "./contracts/index.js";
import { BusinessHandoffService } from "./handoff.js";
import { InteractionIndex } from "./interactions.js";
import { BusinessOutcomeService } from "./outcomes.js";
import { AppointmentService } from "./services/appointments.js";
import { BillingService } from "./services/billing.js";
import { CaseService } from "./services/cases.js";
import { IntakeService } from "./services/intake.js";
import { KnowledgeAnswers } from "./services/knowledge.js";
import type { BusinessServices } from "./services/types.js";
import { PgSupportRequestService } from "./support/support-request-service.js";
import type { SupportSyncPolicy } from "./support/support-request-service.js";

export * from "./contract.js";
export * from "./contracts/index.js";
export { PgSupportRequestService, DEFAULT_SUPPORT_SYNC_POLICY, RESTRICTED_CASE_SUMMARY, SUPPORT_SYNC_CONSUMER } from "./support/support-request-service.js";
export type { SupportRequestRecordInput, SupportSyncPolicy, PgSupportRequestServiceOptions } from "./support/support-request-service.js";
export { SUMMARY_TEMPLATES, assembleSummary } from "./support/summaries.js";
export { SchedulingCommitPort, BillingReviewCommitPort, SLOT_OPEN_VERSION } from "./providers.js";
export { BusinessHandoffService, purposeFor, resolveDestination } from "./handoff.js";
export { BusinessOutcomeService, decideOutcome, RESOLVING_ACTION_KINDS } from "./outcomes.js";
export { InteractionIndex } from "./interactions.js";
export { ACTION_COMMITTED_CONSUMER } from "./consumers.js";
export { confirmationSlotsFor } from "./confirmation.js";
export { grantActionsFor, grantTtlMsFor, issueWorkflowGrant } from "./grants.js";
export type { BusinessServices } from "./services/types.js";
export { BUSINESS_TOOL_NAMES, TOOL_DEFINITIONS } from "../gateway/tools/index.js";

export interface BuildBusinessOptions {
  /** Support-record synchronization retry policy (engineering defaults when omitted). */
  sync?: Partial<SupportSyncPolicy>;
}

/** Builds the services and the module; also returns the services for workers and tests. */
export function buildBusinessServices(deps: ToolDeps, opts: BuildBusinessOptions = {}): { module: BusinessModule; services: BusinessServices } {
  const interactions = new InteractionIndex(deps.db, deps.clock);
  const support = new PgSupportRequestService({
    db: deps.db,
    clock: deps.clock,
    audit: deps.audit,
    outbox: deps.outbox,
    supportRecords: deps.adapters.supportRecords,
    versions: deps.versions,
    memory: deps.memory,
    auditQuery: deps.auditQuery,
    logger: deps.logger,
    metrics: deps.metrics,
    ...(opts.sync ? { sync: opts.sync } : {}),
  });
  const appointments = new AppointmentService(deps, interactions);
  const billing = new BillingService(deps, support, interactions);
  const handoff = new BusinessHandoffService(deps, interactions, support);
  const outcomes = new BusinessOutcomeService(deps, interactions);
  const services: BusinessServices = {
    deps,
    interactions,
    support,
    appointments,
    billing,
    intake: new IntakeService(deps, support),
    cases: new CaseService(deps, support),
    knowledge: new KnowledgeAnswers(deps),
    handoff,
    outcomes,
  };
  const module: BusinessModule = {
    tools: createBusinessToolModules(services),
    providers: {
      "appointment.reschedule": appointments.provider,
      "appointment.create": appointments.provider,
      "billing.review.submit": billing.provider,
    },
    contracts: [...RESOLUTION_CONTRACTS],
    handoff,
    supportRequests: support,
    outcomes,
    consumers: buildConsumers(deps, { support, billing, interactions }),
    confirmationSlots: (action) => confirmationSlotsFor(deps, action),
  };
  return { module, services };
}

export const buildBusiness: BuildBusiness = (deps) => buildBusinessServices(deps).module;
