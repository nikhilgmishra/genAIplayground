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
import type { HandoffResult, HandoffService, SupportRequestService, SupportRequestTrace, SupportRequestTraceOptions } from "../../business/contract.js";
import { AccessDeniedError, ConflictError } from "../../shared/errors.js";
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
  readonly requests: { callId: string; reason: TransferReason; authenticated: boolean; destinationId: string | null; initiatedBy: string | null }[] = [];

  constructor(
    private readonly coordinator: TransferCoordinator,
    private readonly destinations: readonly DestinationConfig[],
    private readonly clock: Clock,
  ) {}

  async requestHuman(input: Parameters<HandoffService["requestHuman"]>[0]): Promise<HandoffResult> {
    this.requests.push({ callId: input.callId, reason: input.reason, authenticated: input.ctx !== null, destinationId: input.destinationId ?? null, initiatedBy: input.initiatedBy?.staffId ?? null });
    const purpose = PURPOSE_BY_REASON[input.reason];
    // Mirrors the port: a staff-selected destination must be allowlisted (SAFE-05).
    const requested = input.destinationId ?? null;
    if (requested !== null && !this.destinations.some((d) => d.destinationId === requested)) throw new AccessDeniedError("DESTINATION_NOT_ALLOWLISTED");
    const destination =
      (requested !== null ? this.destinations.find((d) => d.destinationId === requested) : undefined) ??
      this.destinations.find((d) => d.purpose === purpose) ??
      this.destinations.find((d) => d.purpose === "STANDARD_SUPPORT");
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
  private readonly byRef = new Map<
    string,
    { sr: SupportRequest; actionIds: string[]; workflowIds: string[]; auditEventIds: string[]; attempts: number; lastAttemptAt: string | null; lastReasonCode: string | null; outboxMessageIds: string[] }
  >();
  /** Every trace read with its view, so tests can prove when the restricted-reader flag was set. */
  readonly traceReads: { referenceNumber: string; reader: "worker" | "console"; restrictedReader: boolean }[] = [];

  /** Adds a SYNTHETIC support request with canary free-text fields. */
  seed(input: {
    referenceNumber: string;
    restricted?: boolean;
    callId?: string;
    actionIds?: string[];
    workflowIds?: string[];
    auditEventIds?: string[];
    now: Date;
    syncState?: SupportRequest["syncState"];
    lastReasonCode?: string | null;
    outboxMessageIds?: string[];
  }): SupportRequest {
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
    this.byRef.set(sr.referenceNumber, {
      sr,
      actionIds: input.actionIds ?? [],
      workflowIds: input.workflowIds ?? [],
      auditEventIds: input.auditEventIds ?? [],
      attempts: 0,
      lastAttemptAt: null,
      lastReasonCode: input.lastReasonCode ?? null,
      outboxMessageIds: input.outboxMessageIds ?? [],
    });
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

  /** Emulates the database views: the console view hides restricted rows unless the restricted-reader flag is set (RLS). */
  async trace(tenantId: string, referenceNumber: string, options: SupportRequestTraceOptions = {}): Promise<SupportRequestTrace | null> {
    const consoleView = options.reader?.kind === "console";
    const restrictedReader = consoleView && options.reader?.restrictedReader === true;
    this.traceReads.push({ referenceNumber, reader: consoleView ? "console" : "worker", restrictedReader });
    const v = this.byRef.get(referenceNumber);
    if (!v || v.sr.tenantId !== tenantId) return null;
    if (consoleView && v.sr.restricted && !restrictedReader) return null;
    return {
      supportRequest: structuredClone(v.sr),
      salesforce: {
        caseId: v.sr.salesforceCaseId,
        syncState: v.sr.syncState,
        lastAttemptAt: v.lastAttemptAt,
        attempts: v.attempts,
        lastReasonCode: v.lastReasonCode,
        syncedAt: v.sr.syncState === "SYNCED" ? v.lastAttemptAt : null,
      },
      actionIds: [...v.actionIds],
      workflowIds: [...v.workflowIds],
      auditEventIds: [...v.auditEventIds],
      outboxMessageIds: [...v.outboxMessageIds],
    };
  }

  async listForCall(tenantId: string, callId: string): Promise<SupportRequest[]> {
    return [...this.byRef.values()].filter((v) => v.sr.tenantId === tenantId && v.sr.sourceCallIds.includes(callId)).map((v) => structuredClone(v.sr));
  }

  async listUnsynced(tenantId: string, limit: number): Promise<SupportRequest[]> {
    return [...this.byRef.values()].filter((v) => v.sr.tenantId === tenantId && v.sr.syncState !== "SYNCED").slice(0, limit).map((v) => structuredClone(v.sr));
  }

  /** Every operator repair (opaque ids and reason codes only). */
  readonly repairs: { supportRequestId: string; actorRef: string; reasonCode: string }[] = [];

  /** Mirrors PgSupportRequestService.repairDeadLetter: DEAD_LETTER only, back to PENDING with the attempt budget reset. */
  async repairDeadLetter(tenantId: string, supportRequestId: string, operator: { actorRef: string; reasonCode: string }): Promise<SupportRequest> {
    const v = [...this.byRef.values()].find((x) => x.sr.tenantId === tenantId && x.sr.supportRequestId === supportRequestId);
    if (!v) throw new AccessDeniedError("SUPPORT_REQUEST_NOT_FOUND");
    if (v.sr.syncState !== "DEAD_LETTER") throw new ConflictError("SUPPORT_REQUEST_NOT_DEAD_LETTERED");
    v.sr.syncState = "PENDING";
    v.attempts = 0;
    v.lastReasonCode = operator.reasonCode;
    this.repairs.push({ supportRequestId, actorRef: operator.actorRef, reasonCode: operator.reasonCode });
    return structuredClone(v.sr);
  }
}
