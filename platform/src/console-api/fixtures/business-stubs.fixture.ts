/**
 * LOCAL TEST FIXTURES — labelled stand-ins for the business-layer services the
 * console depends on (platform/src/business/contract.ts HandoffService and
 * SupportRequestService). The business layer is being written concurrently;
 * these fixtures exist only so the console API can be tested now. SYNTHETIC
 * data only, never production.
 *
 * - HandoffServiceFixture routes through the REAL TransferCoordinator (trusted
 *   destination allowlist, telephony fixture), choosing the destination by
 *   reason from trusted configuration, as the port requires (no caller- or
 *   staff-supplied dial target).
 * - SupportRequestServiceFixture is an in-memory store of SYNTHETIC support
 *   requests. Their `summary` / `nextStep` carry CANARY strings so tests can
 *   prove the console never returns them.
 */
import type { HandoffResult, HandoffService, SupportRequestService, SupportRequestTrace } from "../../business/contract.js";
import type { DestinationConfig } from "../../config/ports.js";
import { CALLS, PEOPLE, TENANT_ID } from "../../fixtures/synthetic-world.js";
import type { SupportRequest, TransferReason } from "../../protocol/index.js";
import { newId } from "../../shared/ids.js";
import type { Clock } from "../../shared/clock.js";
import { iso } from "../../shared/clock.js";
import type { TransferCoordinator } from "../../workflows/transfer.js";

export const BUSINESS_STUB_LABEL = "LOCAL TEST FIXTURE — business-layer stand-in (HandoffService / SupportRequestService), SYNTHETIC";
export const SUMMARY_CANARY = "SYNTHETIC-SUMMARY-CANARY caller said they want to cancel";
export const NEXT_STEP_CANARY = "SYNTHETIC-NEXTSTEP-CANARY call back the caller";

const PURPOSE_BY_REASON: Readonly<Record<TransferReason, DestinationConfig["purpose"]>> = {
  CALLER_REQUESTED_HUMAN: "STANDARD_SUPPORT",
  SAFETY_PRIORITY: "SAFETY_PRIORITY",
  CLINICAL_QUESTION: "CLINICAL_ROUTE",
  POLICY_REQUIRES_HUMAN: "STANDARD_SUPPORT",
  VERIFICATION_RECOVERY: "STANDARD_SUPPORT",
  UNSUPPORTED_LANGUAGE: "INTERPRETER",
  ACCESSIBILITY: "STANDARD_SUPPORT",
  DEPENDENCY_FAILURE: "OUTAGE_CONTINUITY",
  AI_UNAVAILABLE: "OUTAGE_CONTINUITY",
  CONSENT_DECLINED_ALTERNATIVE: "STANDARD_SUPPORT",
};

export class HandoffServiceFixture implements HandoffService {
  readonly kind = "local_fixture" as const;
  readonly label = BUSINESS_STUB_LABEL;
  readonly requests: { callId: string; reason: TransferReason; authenticated: boolean }[] = [];

  constructor(
    private readonly coordinator: TransferCoordinator,
    private readonly destinations: readonly DestinationConfig[],
    private readonly clock: Clock,
  ) {}

  async requestHuman(input: Parameters<HandoffService["requestHuman"]>[0]): Promise<HandoffResult> {
    this.requests.push({ callId: input.callId, reason: input.reason, authenticated: input.ctx !== null });
    const purpose = PURPOSE_BY_REASON[input.reason];
    const destination = this.destinations.find((d) => d.purpose === purpose) ?? this.destinations.find((d) => d.purpose === "STANDARD_SUPPORT");
    if (!destination) return { handoffId: newId("hnd"), transferId: null, destinationId: "dst_unconfigured", journey: null, speechTemplateId: "transfer.failed_next_route" };
    const handoffId = newId("hnd");
    const journey = await this.coordinator.requestTransfer({
      handoffId,
      tenantId: input.tenantId,
      callId: input.callId,
      sessionGeneration: Math.max(1, input.ctx?.sessionGeneration ?? 1),
      reason: input.reason,
      destinationId: destination.destinationId,
      statedIssue: input.issueCategory ?? "other",
      issueSummary: "Template-assembled synthetic handoff summary.",
      assurance: input.ctx?.assurance ?? "A0",
      assuranceLimits: [],
      authorizedSubjectRef: null,
      consent: { recording: "UNKNOWN", automatedProcessing: "UNKNOWN", disclosureTemplateVersion: null, capturedAt: null, capturedBy: "none" },
      actionReceiptIds: [],
      pendingActionIds: [],
      unresolvedTasks: [],
      supportReference: null,
      language: input.language,
      accommodations: input.accommodations ?? [],
      safetyRoutingReason: input.reason === "SAFETY_PRIORITY" ? "HUMAN_INTERVENTION" : null,
      clinicalStatementsIncluded: false,
      verificationAssertion: null,
      createdAt: iso(this.clock.now()),
    });
    return { handoffId, transferId: journey.currentTransferId, destinationId: journey.routePlan[journey.routeIndex] ?? destination.destinationId, journey, speechTemplateId: "transfer.in_progress" };
  }

  async requestSafetyRoute(input: Parameters<HandoffService["requestSafetyRoute"]>[0]): Promise<HandoffResult> {
    return this.requestHuman({ tenantId: input.tenantId, callId: input.callId, ctx: input.ctx, reason: "SAFETY_PRIORITY", language: "en", issueCategory: "safety_concern" });
  }
}

const VERSIONS = {
  agentConfig: "agent-fixture-v1",
  model: "model-fixture-v1",
  voice: "voice-fixture-v1",
  promptTemplates: "templates-fixture-v1",
  policyBundle: "policy-fixture-v1",
  toolCatalog: "a".repeat(64),
  knowledgeSnapshot: "kb-fixture-v1",
  schema: "2026-10-17.1",
};

export class SupportRequestServiceFixture implements SupportRequestService {
  readonly kind = "local_fixture" as const;
  readonly label = BUSINESS_STUB_LABEL;
  private readonly byRef = new Map<string, { sr: SupportRequest; actionIds: string[]; workflowIds: string[]; auditEventIds: string[]; attempts: number; lastAttemptAt: string | null }>();

  /** Adds a SYNTHETIC support request with canary free-text fields. */
  seed(input: { referenceNumber: string; restricted?: boolean; callId?: string; actionIds?: string[]; workflowIds?: string[]; auditEventIds?: string[]; now: Date; syncState?: SupportRequest["syncState"] }): SupportRequest {
    const sr: SupportRequest = {
      supportRequestId: newId("srq"),
      referenceNumber: input.referenceNumber,
      tenantId: TENANT_ID,
      interactionExternalId: newId("int"),
      issueExternalId: newId("iss"),
      audience: "client",
      subjectRef: PEOPLE.avery.subjectId,
      issueCategory: input.restricted ? "privacy_concern" : "billing_dispute",
      disposition: "REQUEST_ACCEPTED",
      ownerQueue: "q_billing_specialists",
      priority: input.restricted ? "P2_URGENT" : "P3_STANDARD",
      summary: SUMMARY_CANARY,
      summaryProvenance: "template_assembled",
      attempted: ["billing.lookup"],
      commitReceiptIds: [],
      sourceCallIds: [input.callId ?? CALLS.primary.callId],
      language: "en",
      consent: { recording: "GRANTED", automatedProcessing: "GRANTED", disclosureTemplateVersion: "disclosure-v1", capturedAt: iso(input.now), capturedBy: "studio_flow" },
      nextStep: NEXT_STEP_CANARY,
      deadline: null,
      versions: VERSIONS,
      restricted: input.restricted ?? false,
      syncState: input.syncState ?? "PENDING",
      salesforceCaseId: null,
      createdAt: iso(input.now),
      updatedAt: iso(input.now),
    };
    this.byRef.set(sr.referenceNumber, { sr, actionIds: input.actionIds ?? [], workflowIds: input.workflowIds ?? [], auditEventIds: input.auditEventIds ?? [], attempts: 0, lastAttemptAt: null });
    return sr;
  }

  async create(): Promise<SupportRequest> {
    throw new Error("SupportRequestServiceFixture.create is not used by the console");
  }

  async handleSyncMessage(): Promise<{ duplicate: boolean; syncState: SupportRequest["syncState"] }> {
    throw new Error("SupportRequestServiceFixture.handleSyncMessage is not used by the console");
  }

  async get(tenantId: string, supportRequestId: string): Promise<SupportRequest | null> {
    for (const v of this.byRef.values()) if (v.sr.tenantId === tenantId && v.sr.supportRequestId === supportRequestId) return structuredClone(v.sr);
    return null;
  }

  async getByReference(tenantId: string, referenceNumber: string): Promise<SupportRequest | null> {
    const v = this.byRef.get(referenceNumber);
    return v && v.sr.tenantId === tenantId ? structuredClone(v.sr) : null;
  }

  async trace(tenantId: string, referenceNumber: string): Promise<SupportRequestTrace | null> {
    const v = this.byRef.get(referenceNumber);
    if (!v || v.sr.tenantId !== tenantId) return null;
    return {
      supportRequest: structuredClone(v.sr),
      salesforce: { caseId: v.sr.salesforceCaseId, syncState: v.sr.syncState, lastAttemptAt: v.lastAttemptAt, attempts: v.attempts },
      actionIds: [...v.actionIds],
      workflowIds: [...v.workflowIds],
      auditEventIds: [...v.auditEventIds],
    };
  }

  async listUnsynced(tenantId: string, limit: number): Promise<SupportRequest[]> {
    return [...this.byRef.values()].filter((v) => v.sr.tenantId === tenantId && v.sr.syncState !== "SYNCED").slice(0, limit).map((v) => structuredClone(v.sr));
  }
}
