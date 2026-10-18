/**
 * Business tool modules (spec section 8). The gateway pipeline owns transport auth,
 * catalogue pinning, schema validation, session resolution, kill switches, policy,
 * output validation, field masking and audit; these modules describe resources from
 * authoritative lookups and execute the business operation.
 */
import type { BusinessServices } from "../../business/services/types.js";
import type { ToolModule } from "../ports.js";
import { commitAppointmentChangeTool, getAppointmentOptionsTool, prepareAppointmentChangeTool } from "./appointments.js";
import { getClaimStatusTool, getInvoiceStatusTool, prepareBillingReviewTool, submitBillingReviewTool } from "./billing.js";
import { createSupportRequestTool, getAuthorizedCaseStatusTool, submitComplaintTool } from "./intake.js";
import { getLoginGuidanceTool, searchApprovedRunbookTool } from "./knowledge.js";
import { getProviderOnboardingStatusTool, getRemittanceStatusTool, submitPartnerIntakeTool } from "./provider.js";
import { requestHumanTransferTool, requestSafetyRouteTool } from "./routing.js";
import { beginVerificationTool } from "./verification.js";

export { BUSINESS_TOOL_NAMES, TOOL_DEFINITIONS, type BusinessToolName, type StaticToolDefinition } from "./definitions.js";

export function createBusinessToolModules(s: BusinessServices): ToolModule[] {
  const tools = [
    requestSafetyRouteTool(s),
    requestHumanTransferTool(s),
    searchApprovedRunbookTool(s),
    getLoginGuidanceTool(s),
    beginVerificationTool(s),
    getAppointmentOptionsTool(s),
    prepareAppointmentChangeTool(s),
    commitAppointmentChangeTool(s),
    getInvoiceStatusTool(s),
    prepareBillingReviewTool(s),
    submitBillingReviewTool(s),
    getClaimStatusTool(s),
    getProviderOnboardingStatusTool(s),
    getRemittanceStatusTool(s),
    submitPartnerIntakeTool(s),
    submitComplaintTool(s),
    createSupportRequestTool(s),
    getAuthorizedCaseStatusTool(s),
  ];
  return tools as unknown as ToolModule[];
}
