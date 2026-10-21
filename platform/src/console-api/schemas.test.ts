import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import type * as C from "./contract.js";
import { CONSOLE_ENDPOINTS } from "./contract.js";
import type { EndpointKey } from "./contract.js";
import * as S from "./schemas.js";

type Out<T extends z.ZodType> = z.infer<T>;

describe("console-api schemas mirror the contract", () => {
  it("[SPEC-16.console] every zod-inferred request/response type equals its contract interface (compile-time)", () => {
    expectTypeOf<Out<typeof S.ConsoleErrorBodyS>>().toEqualTypeOf<C.ConsoleErrorBody>();
    expectTypeOf<Out<typeof S.OidcClientConfigS>>().toEqualTypeOf<C.OidcClientConfig>();
    expectTypeOf<Out<typeof S.AuthConfigResponseS>>().toEqualTypeOf<C.AuthConfigResponse>();
    expectTypeOf<Out<typeof S.LocalStaffOptionS>>().toEqualTypeOf<C.LocalStaffOption>();
    expectTypeOf<Out<typeof S.LocalStaffResponseS>>().toEqualTypeOf<C.LocalStaffResponse>();
    expectTypeOf<Out<typeof S.LocalTokenRequestS>>().toEqualTypeOf<C.LocalTokenRequest>();
    expectTypeOf<Out<typeof S.OidcExchangeRequestS>>().toEqualTypeOf<C.OidcExchangeRequest>();
    expectTypeOf<Out<typeof S.OidcStartRequestS>>().toEqualTypeOf<C.OidcStartRequest>();
    expectTypeOf<Out<typeof S.OidcStartResponseS>>().toEqualTypeOf<C.OidcStartResponse>();
    expectTypeOf<Out<typeof S.SessionPolicyViewS>>().toEqualTypeOf<C.SessionPolicyView>();
    expectTypeOf<Out<typeof S.RecoveryChallengeRequestS>>().toEqualTypeOf<C.RecoveryChallengeRequest>();
    expectTypeOf<Out<typeof S.RecoveryChallengeResponseS>>().toEqualTypeOf<C.RecoveryChallengeResponse>();
    expectTypeOf<Out<typeof S.RecoveryActivateRequestS>>().toEqualTypeOf<C.RecoveryActivateRequest>();
    expectTypeOf<Out<typeof S.BreakGlassRequestCreateS>>().toEqualTypeOf<C.BreakGlassRequestCreate>();
    expectTypeOf<Out<typeof S.BreakGlassRequestViewS>>().toEqualTypeOf<C.BreakGlassRequestView>();
    expectTypeOf<Out<typeof S.BreakGlassRequestsResponseS>>().toEqualTypeOf<C.BreakGlassRequestsResponse>();
    expectTypeOf<Out<typeof S.BreakGlassDecisionRequestS>>().toEqualTypeOf<C.BreakGlassDecisionRequest>();
    expectTypeOf<Out<typeof S.BreakGlassDecisionResponseS>>().toEqualTypeOf<C.BreakGlassDecisionResponse>();
    expectTypeOf<Out<typeof S.AccessReviewViewS>>().toEqualTypeOf<C.AccessReviewView>();
    expectTypeOf<Out<typeof S.AccessReviewsResponseS>>().toEqualTypeOf<C.AccessReviewsResponse>();
    expectTypeOf<Out<typeof S.AccessReviewCompleteRequestS>>().toEqualTypeOf<C.AccessReviewCompleteRequest>();
    expectTypeOf<Out<typeof S.AccessReviewCompleteResponseS>>().toEqualTypeOf<C.AccessReviewCompleteResponse>();
    expectTypeOf<Out<typeof S.RecoveryPublicJwkS>>().toEqualTypeOf<C.RecoveryPublicJwk>();
    expectTypeOf<Out<typeof S.RecoveryIdentityViewS>>().toEqualTypeOf<C.RecoveryIdentityView>();
    expectTypeOf<Out<typeof S.RecoveryIdentitiesResponseS>>().toEqualTypeOf<C.RecoveryIdentitiesResponse>();
    expectTypeOf<Out<typeof S.RecoveryIdentityProposeRequestS>>().toEqualTypeOf<C.RecoveryIdentityProposeRequest>();
    expectTypeOf<Out<typeof S.RecoveryIdentityResponseS>>().toEqualTypeOf<C.RecoveryIdentityResponse>();
    expectTypeOf<Out<typeof S.RecoveryIdentityRevokeRequestS>>().toEqualTypeOf<C.RecoveryIdentityRevokeRequest>();
    expectTypeOf<Out<typeof S.TokenResponseS>>().toEqualTypeOf<C.TokenResponse>();
    expectTypeOf<Out<typeof S.BreakGlassViewS>>().toEqualTypeOf<C.BreakGlassView>();
    expectTypeOf<Out<typeof S.StaffViewS>>().toEqualTypeOf<C.StaffView>();
    expectTypeOf<Out<typeof S.MeResponseS>>().toEqualTypeOf<C.MeResponse>();
    expectTypeOf<Out<typeof S.LogoutResponseS>>().toEqualTypeOf<C.ConsoleEndpointTypes["auth.logout"]["response"]>();
    expectTypeOf<Out<typeof S.QueueHealthS>>().toEqualTypeOf<C.QueueHealth>();
    expectTypeOf<Out<typeof S.DependencyHealthS>>().toEqualTypeOf<C.DependencyHealth>();
    expectTypeOf<Out<typeof S.OverviewResponseS>>().toEqualTypeOf<C.OverviewResponse>();
    expectTypeOf<Out<typeof S.CallsListQueryS>>().toEqualTypeOf<C.CallsListQuery>();
    expectTypeOf<Out<typeof S.CallSummaryS>>().toEqualTypeOf<C.CallSummary>();
    expectTypeOf<Out<typeof S.CallsListResponseS>>().toEqualTypeOf<C.CallsListResponse>();
    // Union of intersections: compare member by member, then mutual assignability of the whole union.
    type ZTimeline = Out<typeof S.CallTimelineEventS>;
    type Member<U, K> = Extract<U, { kind: K }>;
    type Flat<T> = { [P in keyof T]: T[P] };
    expectTypeOf<Member<ZTimeline, "session">>().toEqualTypeOf<Flat<Member<C.CallTimelineEvent, "session">>>();
    expectTypeOf<Member<ZTimeline, "tool_invocation">>().toEqualTypeOf<Flat<Member<C.CallTimelineEvent, "tool_invocation">>>();
    expectTypeOf<Member<ZTimeline, "policy_decision">>().toEqualTypeOf<Flat<Member<C.CallTimelineEvent, "policy_decision">>>();
    expectTypeOf<Member<ZTimeline, "action">>().toEqualTypeOf<Flat<Member<C.CallTimelineEvent, "action">>>();
    expectTypeOf<Member<ZTimeline, "transfer">>().toEqualTypeOf<Flat<Member<C.CallTimelineEvent, "transfer">>>();
    expectTypeOf<Member<ZTimeline, "safety_event">>().toEqualTypeOf<Flat<Member<C.CallTimelineEvent, "safety_event">>>();
    expectTypeOf<Member<ZTimeline, "support_request">>().toEqualTypeOf<Flat<Member<C.CallTimelineEvent, "support_request">>>();
    expectTypeOf<ZTimeline>().toExtend<C.CallTimelineEvent>();
    expectTypeOf<C.CallTimelineEvent>().toExtend<ZTimeline>();
    expectTypeOf<ZTimeline["kind"]>().toEqualTypeOf<C.CallTimelineEvent["kind"]>();
    expectTypeOf<Out<typeof S.ControlAvailabilityS>>().toEqualTypeOf<C.ControlAvailability>();
    expectTypeOf<Out<typeof S.VersionSetViewS>>().toEqualTypeOf<C.VersionSetView>();
    expectTypeOf<Omit<Out<typeof S.CallDetailResponseS>, "timeline">>().toEqualTypeOf<Omit<C.CallDetailResponse, "timeline">>();
    expectTypeOf<Out<typeof S.CallDetailResponseS>["timeline"]>().toEqualTypeOf<ZTimeline[]>();
    expectTypeOf<Out<typeof S.CallDetailResponseS>>().toExtend<C.CallDetailResponse>();
    expectTypeOf<C.CallDetailResponse>().toExtend<Out<typeof S.CallDetailResponseS>>();
    expectTypeOf<Out<typeof S.TransferRequestS>>().toEqualTypeOf<C.TransferRequest>();
    expectTypeOf<Out<typeof S.TransferResponseS>>().toEqualTypeOf<C.TransferResponse>();
    expectTypeOf<Out<typeof S.SupportTraceResponseS>>().toEqualTypeOf<C.SupportTraceResponse>();
    expectTypeOf<Out<typeof S.PendingActionViewS>>().toEqualTypeOf<C.PendingActionView>();
    expectTypeOf<Out<typeof S.PendingActionsResponseS>>().toEqualTypeOf<C.PendingActionsResponse>();
    expectTypeOf<Out<typeof S.CancelActionRequestS>>().toEqualTypeOf<C.CancelActionRequest>();
    expectTypeOf<Out<typeof S.CancelActionResponseS>>().toEqualTypeOf<C.CancelActionResponse>();
    expectTypeOf<Out<typeof S.ReconcileResultViewS>>().toEqualTypeOf<C.ReconcileResultView>();
    expectTypeOf<Out<typeof S.ReconciliationItemS>>().toEqualTypeOf<C.ReconciliationItem>();
    expectTypeOf<Out<typeof S.DeadLetterItemS>>().toEqualTypeOf<C.DeadLetterItem>();
    expectTypeOf<Out<typeof S.ReconciliationResponseS>>().toEqualTypeOf<C.ReconciliationResponse>();
    expectTypeOf<Out<typeof S.ReconcileRequestS>>().toEqualTypeOf<C.ReconcileRequest>();
    expectTypeOf<Out<typeof S.ReconcileResponseS>>().toEqualTypeOf<C.ReconcileResponse>();
    expectTypeOf<Out<typeof S.RetryRequestS>>().toEqualTypeOf<C.RetryRequest>();
    expectTypeOf<Out<typeof S.RetryResponseS>>().toEqualTypeOf<C.RetryResponse>();
    expectTypeOf<Out<typeof S.RequeueRequestS>>().toEqualTypeOf<C.RequeueRequest>();
    expectTypeOf<Out<typeof S.RequeueResponseS>>().toEqualTypeOf<C.RequeueResponse>();
    expectTypeOf<Out<typeof S.SupportRepairRequestS>>().toEqualTypeOf<C.SupportRepairRequest>();
    expectTypeOf<Out<typeof S.SupportRepairResponseS>>().toEqualTypeOf<C.SupportRepairResponse>();
    expectTypeOf<Out<typeof S.HumanTaskViewS>>().toEqualTypeOf<C.HumanTaskView>();
    expectTypeOf<Out<typeof S.WorkflowTasksResponseS>>().toEqualTypeOf<C.WorkflowTasksResponse>();
    expectTypeOf<Out<typeof S.WorkflowDecisionRequestS>>().toEqualTypeOf<C.WorkflowDecisionRequest>();
    expectTypeOf<Out<typeof S.WorkflowDecisionResponseS>>().toEqualTypeOf<C.WorkflowDecisionResponse>();
    expectTypeOf<Out<typeof S.SafetyEventViewS>>().toEqualTypeOf<C.SafetyEventView>();
    expectTypeOf<Out<typeof S.SafetyEventsResponseS>>().toEqualTypeOf<C.SafetyEventsResponse>();
    expectTypeOf<Out<typeof S.HeldItemS>>().toEqualTypeOf<C.HeldKnowledgeItem>();
    expectTypeOf<Out<typeof S.ReleaseReviewItemS>>().toEqualTypeOf<C.ReleaseReviewItem>();
    expectTypeOf<Out<typeof S.ReleasesResponseS>>().toEqualTypeOf<C.ReleasesResponse>();
    expectTypeOf<Out<typeof S.ReleaseReviewRequestS>>().toEqualTypeOf<C.ReleaseReviewRequest>();
    expectTypeOf<Out<typeof S.ReleaseReviewResponseS>>().toEqualTypeOf<C.ReleaseReviewResponse>();
    expectTypeOf<Out<typeof S.BudgetViewS>>().toEqualTypeOf<C.BudgetView>();
    expectTypeOf<Out<typeof S.BudgetsResponseS>>().toEqualTypeOf<C.BudgetsResponse>();
    expectTypeOf<Out<typeof S.KillSwitchViewS>>().toEqualTypeOf<C.KillSwitchView>();
    expectTypeOf<Out<typeof S.KillSwitchesResponseS>>().toEqualTypeOf<C.KillSwitchesResponse>();
    expectTypeOf<Out<typeof S.KillSwitchConfirmationPhraseS>>().toEqualTypeOf<C.KillSwitchConfirmationPhrase>();
    expectTypeOf<Out<typeof S.SetKillSwitchRequestS>>().toEqualTypeOf<C.SetKillSwitchRequest>();
    expectTypeOf<Out<typeof S.SetKillSwitchResponseS>>().toEqualTypeOf<C.SetKillSwitchResponse>();
    expectTypeOf<Out<typeof S.AuditSearchQueryS>>().toEqualTypeOf<C.AuditSearchQuery>();
    expectTypeOf<Out<typeof S.AuditEventMetadataS>>().toEqualTypeOf<C.AuditEventMetadata>();
    expectTypeOf<Out<typeof S.AuditSearchResponseS>>().toEqualTypeOf<C.AuditSearchResponse>();
    expectTypeOf<Out<typeof S.DestinationViewS>>().toEqualTypeOf<C.DestinationView>();
    expectTypeOf<Out<typeof S.DestinationsResponseS>>().toEqualTypeOf<C.DestinationsResponse>();
    expect(true).toBe(true);
  });

  it("[SPEC-16.console] ENDPOINT_SCHEMAS covers every endpoint in CONSOLE_ENDPOINTS and nothing else", () => {
    expect(Object.keys(S.ENDPOINT_SCHEMAS).sort()).toEqual(Object.keys(CONSOLE_ENDPOINTS).sort());
    for (const key of Object.keys(CONSOLE_ENDPOINTS) as EndpointKey[]) {
      const spec = CONSOLE_ENDPOINTS[key];
      if (spec.method === "GET") expect(S.ENDPOINT_SCHEMAS[key].body, key).toBeNull();
    }
  });

  it("[SPEC-16.console] response schemas are strict: a transcript or task-token field is rejected, never passed through", () => {
    const detail = {
      call: {
        callId: "cal_synthCallPrimary0001",
        state: "ACTIVE",
        assurance: "A2",
        intentCategory: null,
        safetyFlag: false,
        startedAt: "2026-10-17T15:00:00.000Z",
        transferState: null,
        sessionGeneration: 1,
        language: "und",
        localFixture: true,
      },
      versions: null,
      controls: { transfer: { available: true, reasonCode: null }, join: { available: false, reasonCode: "TALKDESK_CONTROL_UNAVAILABLE" } },
      timeline: [],
      supportRequestRefs: [],
      contentAvailable: false,
    };
    expect(S.CallDetailResponseS.safeParse(detail).success).toBe(true);
    expect(S.CallDetailResponseS.safeParse({ ...detail, transcript: "caller said" }).success).toBe(false);
    expect(S.CallDetailResponseS.safeParse({ ...detail, contentAvailable: true }).success).toBe(false);
    const decision = { taskId: "tsk_synthTask0000000001", workflowId: "wf_synthWorkflow00000001", decision: "APPROVE", workflowState: "READY_TO_COMMIT", auditEventId: "aud_synthAudit000000001" };
    expect(S.WorkflowDecisionResponseS.safeParse(decision).success).toBe(true);
    expect(S.WorkflowDecisionResponseS.safeParse({ ...decision, taskToken: "x".repeat(43) }).success).toBe(false);
  });

  it("[SPEC-16.console] operator reasons are reason codes only: free text and digit runs are rejected", () => {
    expect(S.OperatorReasonS.safeParse("INCIDENT_CONTAINMENT").success).toBe(true);
    expect(S.OperatorReasonS.safeParse("INCIDENT_CONTAINMENT:inc_synthIncident000001").success).toBe(true);
    expect(S.OperatorReasonS.safeParse("caller asked to cancel").success).toBe(false);
    expect(S.OperatorReasonS.safeParse("DOB_19800101").success).toBe(false);
  });

  it("[SPEC-13.console] the kill-switch confirmation phrase is typed and bounded", () => {
    expect(S.KillSwitchConfirmationPhraseS.safeParse("ENGAGE AI_ADMISSION *").success).toBe(true);
    expect(S.KillSwitchConfirmationPhraseS.safeParse("engage AI_ADMISSION *").success).toBe(false);
    expect(S.KillSwitchConfirmationPhraseS.safeParse("ENGAGE EVERYTHING *").success).toBe(false);
  });

  it("[SPEC-6.no-phi-url] audit search accepts metadata filters only and bounds the limit", () => {
    expect(S.AuditSearchQueryS.safeParse({ limit: "50" }).success).toBe(true);
    expect(S.AuditSearchQueryS.safeParse({ limit: "201" }).success).toBe(false);
    expect(S.AuditSearchQueryS.safeParse({ limit: "50", text: "smith" }).success).toBe(false);
    expect(S.AuditSearchQueryS.safeParse({ limit: "50", callId: "+15555550101" }).success).toBe(false);
  });
});
