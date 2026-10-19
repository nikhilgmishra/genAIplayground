/**
 * Follow-on contract behaviour (follow-on prompt sections 4-18): a valid SYNTHETIC instance of each
 * contract parses, and the rules each contract enforces at its boundary reject the unsafe variants.
 * In-memory zod validation only; SYNTHETIC values (fixtures/contracts.fixture.ts).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ActivationRecord, ActivationReport, permittedActivationState } from "./activation.js";
import { ActionGrant, CommitReceipt, ConfirmationReceipt, PreparedAction, checkActionGrant, checkConfirmationReceipt, confirmationReceiptFrom, receiptConfirms, type ActionGrantUse } from "./actions.js";
import { AuthContext } from "./auth.js";
import { CallBinding, checkBinding } from "./call-binding.js";
import { ConsentDimensionState, ConsentValue, ConsentValueV2, DisclosureClassification, MAX_CLOCK_SKEW_MS } from "./common.js";
import { CapabilityEvidence, ConnectorProfile } from "./connector.js";
import { ContextFact, SourceWatermark, factIsCurrent, watermarkAgeMs, watermarkIsFresh } from "./context-facts.js";
import { ContextSnapshot } from "./context-snapshot.js";
import { computeConnectorProfileDigest, computeSpeechPlanDigest, computeTenantConfigDigest, sealSpeechPlan, verifySpeechPlanDigest } from "./digests.js";
import { CaseLink, EffectVerification, effectVerified } from "./effects.js";
import { EvaluationResult, faultReached } from "./evaluation.js";
import { IdentityLink, PersonRoleAssignment, activeAssignments, linkAuthorizes } from "./identity-link.js";
import { CanarySpec, ChangeProposal } from "./improvement.js";
import { KnowledgeCitation, citationIsCurrent } from "./knowledge.js";
import { AudioReleaseReceipt, CarrierEvent, FACT_PROTECTED_CLASSES, SpeechPlan, TurnEnvelope, literalStatesValue, receiptPlanIssues, templatePlaceholders } from "./media.js";
import { ModelDecision, ModelInvocation } from "./models.js";
import { LongHorizonPlan, authorityExpansion } from "./plan.js";
import { ReleaseManifest } from "./release.js";
import { DatasetItem, ReviewRecord, familiesLeakingAcrossSplits } from "./review.js";
import { SupportRequest, caseLinksOf } from "./support.js";
import { TenantConfig, tenantBusinessDate, unsetRetentionClasses } from "./tenant.js";
import { ToolRequestV2, ToolResultFreshness, ToolResultV2, toolResultV2From } from "./tool-envelope.js";
import { HumanTask } from "./workflow.js";
import * as F from "./fixtures/contracts.fixture.js";

const NOW = new Date(F.SYNTH.t0);
const issues = (r: { success: boolean; error?: { issues: { message: string }[] } }): string[] => (r.success ? [] : (r.error?.issues ?? []).map((i) => i.message));

describe("CallBinding [FO-04-06]", () => {
  it("[FO-04-06] a trusted binding parses and the currency check fails closed on every mismatch", () => {
    const b = CallBinding.parse(F.callBinding());
    const claim = { tenantId: b.tenantId, interactionId: b.interactionId, sessionGeneration: 1, fencingToken: 7 };
    expect(checkBinding(b, claim, NOW)).toEqual({ current: true });
    expect(checkBinding(b, { ...claim, sessionGeneration: 2 }, NOW)).toEqual({ current: false, reasonCode: "BINDING_GENERATION_STALE" });
    expect(checkBinding(b, { ...claim, fencingToken: 6 }, NOW)).toEqual({ current: false, reasonCode: "BINDING_FENCING_TOKEN_STALE" });
    expect(checkBinding(b, { ...claim, tenantId: F.SYNTH.otherTenantId }, NOW)).toEqual({ current: false, reasonCode: "BINDING_TENANT_MISMATCH" });
    expect(checkBinding(b, claim, new Date(F.at(3_600_000)))).toEqual({ current: false, reasonCode: "BINDING_EXPIRED" });
    expect(checkBinding({ ...b, state: "REVOKED" }, claim, NOW)).toEqual({ current: false, reasonCode: "BINDING_NOT_ACTIVE" });
  });

  it("[FO-04-06][AUTH-01] caller ANI can never become the carrier interaction reference, and a model is never a binding source", () => {
    for (const ani of ["+15555550101", "555-0101-1234", "(555) 010-1234", "tel:15555550101", "sip:15555550101", "SIP:15555550101", "sips:15555550101"]) {
      expect(CallBinding.safeParse({ ...F.callBinding(), carrier: { ...F.callBinding().carrier, interactionRef: ani } }).success, ani).toBe(false);
    }
    expect(CallBinding.safeParse({ ...F.callBinding(), boundBy: "model_argument" }).success).toBe(false);
    expect(issues(CallBinding.safeParse({ ...F.callBinding(), expiresAt: F.SYNTH.t0 }))).toContain("BINDING_EXPIRY_NOT_AFTER_ISSUE");
  });
});

describe("TurnEnvelope, CarrierEvent, SpeechPlan, AudioReleaseReceipt [FO-04-07][FO-04-30][FO-04-31][FO-04-32]", () => {
  it("[FO-04-07][AUTH-06] a minimized turn parses; DTMF never reaches a transcript or ASR and transcript text is never inline", () => {
    expect(TurnEnvelope.parse(F.turnEnvelope()).turnId).toBe(F.SYNTH.turnId);
    const dtmf = { ...F.turnEnvelope(), inputKind: "DTMF_ISOLATED" as const, dtmfCaptured: true };
    expect(issues(TurnEnvelope.safeParse(dtmf))).toContain("DTMF_REACHED_TRANSCRIPT_OR_ASR");
    expect(TurnEnvelope.safeParse({ ...dtmf, asr: null, transcriptRef: null }).success).toBe(true);
    expect(TurnEnvelope.safeParse({ ...F.turnEnvelope(), transcript: "caller said" }).success).toBe(false);
    expect(issues(TurnEnvelope.safeParse({ ...F.turnEnvelope(), dataClassification: "VERIFICATION_SECRET" }))).toContain("TURN_HOLDS_VERIFICATION_SECRET");
  });

  it("[FO-04-30][SAFE-04] carrier transfer events carry transfer detail and an accepting receiver; the dedup key and causal clock are explicit", () => {
    expect(CarrierEvent.parse(F.carrierEvent()).type).toBe("TRANSFER_RECEIVER_ACCEPTED");
    const ev = F.carrierEvent();
    expect(issues(CarrierEvent.safeParse({ ...ev, transfer: null }))).toContain("TRANSFER_EVENT_WITHOUT_TRANSFER");
    expect(issues(CarrierEvent.safeParse({ ...ev, transfer: { ...ev.transfer!, receiverRef: null } }))).toContain("ACCEPTANCE_WITHOUT_RECEIVER");
    expect(issues(CarrierEvent.safeParse({ ...ev, clockSource: "platform_receipt" }))).toContain("RECEIPT_CLOCK_MUST_EQUAL_RECEIVED_AT");
    expect(CarrierEvent.safeParse({ ...ev, transfer: { ...ev.transfer!, destinationId: "+15555550101" } }).success).toBe(false);
  });

  it("[FO-04-31][ACT-05] a protected-fact plan needs authorization, a source and fixed wording; protected classes never route to native speech", () => {
    const plan = F.speechPlan();
    expect(SpeechPlan.parse(plan).planId).toBe("spl_synthSpeechPlan00001");
    expect(issues(SpeechPlan.safeParse({ ...plan, authorizationRef: null }))).toContain("PROTECTED_FACT_WITHOUT_AUTHORIZATION");
    expect(issues(SpeechPlan.safeParse({ ...plan, sourceRefs: [] }))).toContain("PROTECTED_FACT_WITHOUT_SOURCE");
    expect(issues(SpeechPlan.safeParse({ ...plan, route: "NATIVE_ALLOWED" }))).toContain("PROTECTED_CLASS_NOT_NATIVE");
    const paraphrase = { kind: "BOUNDED_PARAPHRASE" as const, paraphrasePolicyId: "billing.explain", text: "About forty-five dollars.", maxChars: 80, allowedSourceRefs: ["billing/invoices/inv_synthInvoice0000001"] };
    expect(issues(SpeechPlan.safeParse({ ...plan, segments: [paraphrase] }))).toContain("PARAPHRASE_FOR_PROTECTED_CLASS");
    const seg = plan.segments[0]!;
    expect(issues(SpeechPlan.safeParse({ ...plan, segments: [{ ...seg, slotNames: ["balance", "undeclared"] }] }))).toContain("UNDECLARED_SLOT");
    expect(issues(SpeechPlan.safeParse({ ...plan, utteranceClass: "COMMITMENT" }))).toContain("COMMITMENT_WITHOUT_RECEIPT");
  });

  it("[FO-04-31][SAFE-02] safety wording needs no account authorization but stays fixed; a low-risk class may be native after qualification", () => {
    const safety = { ...F.unsealedSpeechPlan(), utteranceClass: "SAFETY" as const, authorizationRef: null, sourceRefs: [], protectedSlots: [], segments: [{ kind: "TEMPLATE_EXACT" as const, templateId: "safety.priority_ack", templateVersion: "1.0.0", text: "I am connecting you with a person now.", slotNames: [] }] };
    expect(SpeechPlan.safeParse(sealSpeechPlan(safety)).success).toBe(true);
    const lowRisk = { ...safety, utteranceClass: "LOW_RISK_GROUNDED" as const, route: "NATIVE_ALLOWED" as const, allowedRenderers: ["native_buffer_checked" as const] };
    expect(SpeechPlan.safeParse(sealSpeechPlan(lowRisk)).success).toBe(true);
  });

  it("[FO-04-31] the output-decision digest binds every field: a changed slot, turn or expiry no longer verifies", () => {
    const plan = F.speechPlan();
    expect(verifySpeechPlanDigest(plan)).toBe(true);
    expect(computeSpeechPlanDigest(plan)).toBe(plan.outputDecisionDigest);
    const slot = plan.protectedSlots[0]!;
    const changedSlot = { ...plan, protectedSlots: [{ ...slot, value: { currency: "USD" as const, minorUnits: 450 } }, plan.protectedSlots[1]!] } as SpeechPlan;
    expect(verifySpeechPlanDigest(changedSlot)).toBe(false);
    expect(verifySpeechPlanDigest({ ...plan, turnId: "turn_synth0002" })).toBe(false);
    expect(verifySpeechPlanDigest({ ...plan, expiresAt: F.at(60_000) })).toBe(false);
    expect(verifySpeechPlanDigest({ ...plan, extra: "x" } as unknown as SpeechPlan)).toBe(false);
  });

  it("[FO-04-32][ACT-05] a receipt can never record emitted audio that failed a release check; rejections carry a reason", () => {
    expect(AudioReleaseReceipt.parse(F.audioReleaseReceipt()).status).toBe("EMITTED_COMPLETE");
    const r = F.audioReleaseReceipt();
    expect(issues(AudioReleaseReceipt.safeParse({ ...r, emissionCheck: { ...r.emissionCheck!, generationCurrent: false } }))).toContain("EMITTED_WITHOUT_PASSING_EMISSION_CHECK");
    expect(issues(AudioReleaseReceipt.safeParse({ ...r, enqueueCheck: { ...r.enqueueCheck, digestVerified: false } }))).toContain("EMITTED_AFTER_FAILED_ENQUEUE_CHECK");
    expect(issues(AudioReleaseReceipt.safeParse({ ...r, renderedAudioDigest: null }))).toContain("EMITTED_WITHOUT_AUDIO_DIGEST");
    const rejected = { ...r, status: "NOT_EMITTED_REJECTED" as const, playback: null, emissionCheck: { ...r.emissionCheck!, turnCurrent: false } };
    expect(issues(AudioReleaseReceipt.safeParse(rejected))).toContain("REJECTION_WITHOUT_REASON");
    expect(AudioReleaseReceipt.safeParse({ ...rejected, rejectionReason: "TURN_SUPERSEDED" }).success).toBe(true);
    expect(issues(AudioReleaseReceipt.safeParse({ ...rejected, rejectionReason: "TURN_SUPERSEDED", playback: r.playback }))).toContain("NOT_EMITTED_WITH_PLAYBACK");
  });
});

describe("ContextFact, SourceWatermark, ContextSnapshot [FO-04-08][FO-04-09][FO-04-10]", () => {
  it("[FO-04-09][DATA-04] facts keep provenance; identity/consent/clinical facts must be source-verified and inferences cite support", () => {
    expect(ContextFact.parse(F.contextFact()).factId).toBe("fct_synthFactBalance0001");
    const f = F.contextFact();
    expect(issues(ContextFact.safeParse({ ...f, factType: "identity.portal_account.active", verification: "CALLER_REPORTED", authorityRank: 10 }))).toContain("SOURCE_ONLY_FACT_NOT_SOURCE_VERIFIED");
    expect(issues(ContextFact.safeParse({ ...f, factType: "consent.recording", verification: "INFERRED", authorityRank: 10, supportingFactIds: ["fct_synthFactOther00001"] }))).toContain("SOURCE_ONLY_FACT_NOT_SOURCE_VERIFIED");
    expect(issues(ContextFact.safeParse({ ...f, verification: "INFERRED", authorityRank: 10 }))).toContain("INFERRED_FACT_WITHOUT_SUPPORT");
    expect(issues(ContextFact.safeParse({ ...f, verification: "CALLER_REPORTED" }))).toContain("UNVERIFIED_FACT_OUTRANKS_SOURCES");
    expect(issues(ContextFact.safeParse({ ...f, effectiveUntil: f.effectiveFrom }))).toContain("EFFECTIVE_INTERVAL_EMPTY");
  });

  it("[FO-04-09] business-effective time is separate from ingestion time; retraction and expiry make a fact unusable", () => {
    const f = ContextFact.parse(F.contextFact());
    expect(factIsCurrent(f, NOW)).toBe(true);
    expect(factIsCurrent({ ...f, lineage: { ...f.lineage, retracted: true, retractionReason: "SOURCE_CORRECTED" } }, NOW)).toBe(false);
    expect(factIsCurrent({ ...f, expiresAt: F.at(-1) }, NOW)).toBe(false);
    expect(factIsCurrent({ ...f, effectiveFrom: F.at(60_000) }, NOW)).toBe(false);
  });

  it("[FO-04-10] a watermark is fresh only with known age within budget and no gap; missing events cannot be reported as no gap", () => {
    const w = SourceWatermark.parse(F.sourceWatermark());
    expect(watermarkAgeMs(w, NOW)).toBe(5_000);
    expect(watermarkIsFresh(w, NOW)).toBe(true);
    expect(watermarkIsFresh(w, new Date(F.at(600_000)))).toBe(false);
    expect(watermarkIsFresh({ ...w, gapState: "SOURCE_SILENT_UNVERIFIED" }, NOW)).toBe(false);
    expect(watermarkAgeMs({ ...w, lastHeartbeatAt: null, lastEventReceivedAt: null, high: { offset: "9", eventTime: null } }, NOW)).toBeNull();
    expect(issues(SourceWatermark.safeParse({ ...F.sourceWatermark(), deliveredCount: 40 }))).toContain("MISSING_EVENTS_REPORTED_AS_NO_GAP");
  });

  it("[FO-04-08][AUTH-05] a snapshot holds only the authorized subject's facts under its ceiling and purpose, and is never labelled COMPLETE when partial", () => {
    expect(ContextSnapshot.parse(F.contextSnapshot()).completeness).toBe("COMPLETE");
    const s = F.contextSnapshot();
    const other = { ...F.contextFact(), factId: "fct_synthFactOther00001", subjectRef: F.SYNTH.otherSubjectRef };
    expect(issues(ContextSnapshot.safeParse({ ...s, facts: [...s.facts, other] }))).toContain("FACT_FOR_OTHER_SUBJECT");
    expect(issues(ContextSnapshot.safeParse({ ...s, facts: [{ ...F.contextFact(), tenantId: F.SYNTH.otherTenantId }] }))).toContain("FACT_FROM_OTHER_TENANT");
    expect(issues(ContextSnapshot.safeParse({ ...s, facts: [{ ...F.contextFact(), dataClassification: "PHI" }] }))).toContain("FACT_ABOVE_CLASSIFICATION_CEILING");
    expect(issues(ContextSnapshot.safeParse({ ...s, purpose: "marketing" }))).toContain("FACT_PURPOSE_NOT_ALLOWED");
    const partial = { ...s, coverage: { ...s.coverage, unavailableSources: [{ system: "claims", reasonCode: "SOURCE_TIMEOUT" }] } };
    expect(issues(ContextSnapshot.safeParse(partial))).toContain("PARTIAL_SNAPSHOT_LABELLED_COMPLETE");
    expect(ContextSnapshot.safeParse({ ...partial, completeness: "PARTIAL" }).success).toBe(true);
    expect(issues(ContextSnapshot.safeParse({ ...s, timelineSummary: { ...s.timelineSummary!, supportingFactIds: ["fct_synthFactMissing0001"] } }))).toContain("SUMMARY_CLAIM_WITHOUT_FACT");
  });
});

describe("IdentityLink, KnowledgeCitation [FO-04-11][FO-04-12]", () => {
  it("[FO-04-11] only an authoritative, active, verified link authorizes; alias and probabilistic links never do", () => {
    const l = IdentityLink.parse(F.identityLink());
    expect(linkAuthorizes(l, NOW)).toBe(true);
    expect(issues(IdentityLink.safeParse({ ...F.identityLink(), basis: "ANALYTICS_ALIAS_SIGNAL" }))).toContain("NON_AUTHORITATIVE_LINK_ELIGIBLE");
    expect(issues(IdentityLink.safeParse({ ...F.identityLink(), basis: "PROBABILISTIC_MATCH" }))).toContain("NON_AUTHORITATIVE_LINK_ELIGIBLE");
    expect(IdentityLink.safeParse({ ...F.identityLink(), basis: "ANALYTICS_ALIAS_SIGNAL", authorizationEligible: false }).success).toBe(true);
    expect(issues(IdentityLink.safeParse({ ...F.identityLink(), basis: "STAFF_REVIEWED_MERGE" }))).toContain("MERGE_WITHOUT_REVIEW_EVIDENCE");
    expect(linkAuthorizes({ ...l, state: "QUARANTINED_AMBIGUOUS", authorizationEligible: false }, NOW)).toBe(false);
    expect(linkAuthorizes({ ...l, validUntil: F.at(-1) }, NOW)).toBe(false);
  });

  it("[FO-04-12] a citation pins version, snapshot, span and freshness; a stale or expired citation is not usable", () => {
    const c = KnowledgeCitation.parse(F.knowledgeCitation());
    expect(citationIsCurrent(c, NOW)).toBe(true);
    expect(citationIsCurrent({ ...c, freshness: { ...c.freshness, stale: true } }, NOW)).toBe(false);
    expect(KnowledgeCitation.safeParse({ ...F.knowledgeCitation(), citationId: "kb_billing-faq" }).success).toBe(false);
    expect(KnowledgeCitation.safeParse({ ...F.knowledgeCitation(), span: { kind: "chars", start: 10, end: 10 } }).success).toBe(false);
    expect(issues(KnowledgeCitation.safeParse({ ...F.knowledgeCitation(), audiences: ["client"] }))).toContain("PUBLIC_FAQ_WITHOUT_PUBLIC_AUDIENCE");
  });
});

describe("ModelInvocation, ModelDecision [FO-04-13][FO-04-14]", () => {
  it("[FO-04-13][OPS-06] an invocation pins the registry entry, prompt, harness and policy versions and never carries verification secrets", () => {
    expect(ModelInvocation.parse(F.modelInvocation()).model.registryRef).toBe("router.primary@1");
    const m = F.modelInvocation();
    expect(issues(ModelInvocation.safeParse({ ...m, input: { ...m.input, classification: "VERIFICATION_SECRET" } }))).toContain("VERIFICATION_SECRET_SENT_TO_MODEL");
    expect(issues(ModelInvocation.safeParse({ ...m, usage: { ...m.usage!, outputTokens: 999 } }))).toContain("USAGE_EXCEEDS_BUDGET");
    expect(issues(ModelInvocation.safeParse({ ...m, status: "REFUSED" }))).toContain("FAILURE_WITHOUT_CODE");
    expect(ModelInvocation.safeParse({ ...m, egress: { ...m.egress, endpointAllowlisted: false } }).success).toBe(false);
  });

  it("[FO-04-14] a model decision is a typed proposal only and can never claim authority", () => {
    expect(ModelDecision.parse(F.modelDecision()).authority).toBe("PROPOSAL_ONLY");
    expect(ModelDecision.safeParse({ ...F.modelDecision(), authority: "AUTHORIZED" }).success).toBe(false);
    expect(ModelDecision.safeParse({ ...F.modelDecision(), decisions: [{ kind: "COMMIT", actionId: "act_synthAction000000001" }] }).success).toBe(false);
    expect(ModelDecision.safeParse({ ...F.modelDecision(), decisions: [{ kind: "SAFETY_SIGNAL", signal: "UNCERTAIN", uncertainty: 0.6, reasonCodes: ["ASR_UNCERTAIN"] }] }).success).toBe(true);
    expect(ModelDecision.safeParse({ ...F.modelDecision(), decisions: [{ kind: "SAFETY_SIGNAL", signal: "DIAGNOSIS", uncertainty: 0.1, reasonCodes: ["X_Y"] }] }).success).toBe(false);
    // A speech request cites opaque fact/receipt ids or citation ids, never free text the model wrote.
    const speech = (sourceRefs: string[]) => ({ ...F.modelDecision(), decisions: [{ kind: "SPEECH_REQUEST", utteranceClass: "FINANCIAL_FACT", templateId: "billing.balance_due", sourceRefs }] });
    expect(ModelDecision.safeParse(speech(["fct_synthFactBalance0001", "kb_billing-faq@v3"])).success).toBe(true);
    for (const bad of ["Avery Synthetic balance 45", "dob 1990-01-01", "555-0101"]) expect(ModelDecision.safeParse(speech([bad])).success, bad).toBe(false);
  });
});

describe("Tool boundary V2 [FO-04-15][FO-04-17][FO-04-18]", () => {
  it("[FO-04-15] ToolRequestV2 carries the envelope and bounded arguments", () => {
    expect(ToolRequestV2.parse(F.toolRequestV2()).schemaVersion).toBe("tool-request.v2");
    const many = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, i]));
    expect(issues(ToolRequestV2.safeParse(F.toolRequestV2(many)))).toContain("TOO_MANY_KEYS");
    expect(issues(ToolRequestV2.safeParse(F.toolRequestV2({ note: "x".repeat(17_000) })))).toContain("PAYLOAD_TOO_LARGE");
    expect(ToolRequestV2.safeParse({ ...F.toolRequestV2(), tenantId: undefined }).success).toBe(false);
  });

  it("[FO-04-17][FO-04-18] every V2 result branch carries receipts and an explanation code; SUCCESS and PENDING carry freshness that cannot claim fresh with unknown age", () => {
    const legacy = {
      requestId: F.SYNTH.requestId,
      tool: { name: "get_balance", version: "1.0.0" },
      turnId: F.SYNTH.turnId,
      sessionGeneration: 1,
      completedAt: F.at(300),
      auditEventId: "aud_synthAudit000000001",
      policyDecisionId: "dec_synthDecision000001",
      speech: null,
      localFixture: true,
      status: "SUCCESS" as const,
      data: { balanceMinor: 4_500, currency: "USD" },
    };
    const freshness = { observedAt: F.at(300), maxAgeMs: 300_000, sources: [{ system: "billing", watermarkId: "wmk_synthWatermarkBill01", sourceUpdatedAt: F.at(-3_600_000), ageMs: 5_000 }], stale: false };
    const trusted = { tenantId: F.SYNTH.tenantId, causationId: F.SYNTH.requestId, receiptRefs: [], explanationCode: "BALANCE_FROM_BILLING", freshness };
    const v2 = toolResultV2From(legacy, trusted);
    expect(v2.status).toBe("SUCCESS");
    expect(() => toolResultV2From(legacy, { ...trusted, freshness: null })).toThrow();
    expect(ToolResultV2.safeParse({ ...v2, freshness: { ...freshness, sources: [{ ...freshness.sources[0]!, ageMs: null }] } }).success).toBe(false);
    expect(ToolResultV2.safeParse({ ...v2, freshness: { ...freshness, sources: [{ ...freshness.sources[0]!, ageMs: 900_000 }], stale: true } }).success).toBe(true);
    // Every source names its watermark (FO-04-18 "source watermark and age"); a missing one is refused even when stale.
    expect(ToolResultV2.safeParse({ ...v2, freshness: { ...freshness, sources: [{ ...freshness.sources[0]!, watermarkId: null, ageMs: null }], stale: true } }).success).toBe(false);
    expect(ToolResultFreshness.safeParse({ ...freshness, sources: [{ system: "billing", sourceUpdatedAt: null, ageMs: null }], stale: true }).success).toBe(false);
    // Speech source refs are opaque pointers, never prose.
    const speech = { templateId: "billing.balance_due", templateVersion: "1.0.0", responseClass: "FINANCIAL_FACT", slots: { balance: 4_500 }, authorizationRef: "dec_synthDecision000001", sourceRefs: ["inv_synthInvoice0000001"], turnId: F.SYNTH.turnId, sessionGeneration: 1 };
    expect(ToolResultV2.safeParse({ ...v2, speech }).success).toBe(true);
    expect(ToolResultV2.safeParse({ ...v2, speech: { ...speech, sourceRefs: ["the balance is 45 dollars"] } }).success).toBe(false);
    const { data: _data, ...withoutData } = legacy;
    const denied = toolResultV2From({ ...withoutData, status: "POLICY_DENIED", reasonCode: "SUBJECT_NOT_AUTHORIZED" }, { ...trusted, explanationCode: "SUBJECT_NOT_AUTHORIZED", freshness: null });
    expect(denied.status).toBe("POLICY_DENIED");
    expect(ToolResultV2.safeParse({ ...denied, explanationCode: "not a code" }).success).toBe(false);
  });
});

describe("Actions, grants, receipts and effects [FO-04-20..24]", () => {
  it("[FO-04-20][FO-04-44] PreparedAction fees use ISO 4217 money and the bounded change map", () => {
    const shape = PreparedAction.shape;
    expect(shape.impact.shape.fees.unwrap().shape.currency.options).toContain("EUR");
    expect(shape.impact.shape.fees.safeParse({ currency: "XXX", minorUnits: 1 }).success).toBe(false);
    expect(shape.impact.shape.fees.safeParse({ currency: "USD", minorUnits: 1.5 }).success).toBe(false);
    expect(shape.change.safeParse(Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`f${i}`, i]))).success).toBe(false);
  });

  it("[FO-04-21][ACT-01] a confirmation receipt is built from the trusted confirmation and confirms only the same tenant, action, digest, session, generation, actor and fresh window", () => {
    const r = ConfirmationReceipt.parse(F.confirmationReceipt());
    const action = { actionId: r.actionId, digest: r.digest, tenantId: r.tenantId, sessionRef: r.sessionRef, sessionGeneration: 1, actorId: r.actorRef, preparedAt: F.at(-30_000), expiresAt: F.at(300_000) };
    expect(checkConfirmationReceipt(r, action, NOW)).toEqual({ valid: true });
    expect(receiptConfirms(r, action, NOW)).toBe(true);
    const refused: [Partial<typeof action>, Date, string][] = [
      [{ tenantId: F.SYNTH.otherTenantId }, NOW, "RECEIPT_TENANT_MISMATCH"],
      [{ actionId: "act_synthOtherAction0001" }, NOW, "RECEIPT_ACTION_MISMATCH"],
      [{ digest: F.digestOf("other") }, NOW, "RECEIPT_DIGEST_MISMATCH"],
      // Probe P3 of the WP-02 verifier: the same digest confirmed on ANOTHER session, or by another actor.
      [{ sessionRef: "ses_otherSessionRef0000001" }, NOW, "RECEIPT_SESSION_MISMATCH"],
      [{ sessionGeneration: 2 }, NOW, "RECEIPT_GENERATION_STALE"],
      [{ actorId: "act_someoneElse00000001" }, NOW, "RECEIPT_ACTOR_MISMATCH"],
      // An earlier "yes" (captured before this action was prepared) never confirms it.
      [{ preparedAt: F.at(1_000) }, new Date(F.at(2_000)), "RECEIPT_PREDATES_ACTION"],
      [{}, new Date(F.at(-1_000)), "RECEIPT_CAPTURED_IN_FUTURE"],
      [{}, new Date(F.at(120_000)), "RECEIPT_EXPIRED"],
      [{ expiresAt: F.at(10_000) }, new Date(F.at(10_000)), "ACTION_EXPIRED"],
    ];
    for (const [over, at, code] of refused) {
      expect(checkConfirmationReceipt(r, { ...action, ...over }, at), code).toEqual({ valid: false, reasonCode: code });
      expect(receiptConfirms(r, { ...action, ...over }, at), code).toBe(false);
    }
    const built = confirmationReceiptFrom(
      { actionId: r.actionId, digest: r.digest, sessionRef: r.sessionRef, sessionGeneration: 1, turnId: r.turnId, method: "dtmf_keypress", capturedBy: "telephony-control", capturedAt: r.capturedAt },
      { receiptId: r.receiptId, tenantId: r.tenantId, actorRef: r.actorRef, expiresAt: r.expiresAt, auditEventId: r.auditEventId, causationId: null },
    );
    expect(built).toEqual(r);
    expect(issues(ConfirmationReceipt.safeParse({ ...F.confirmationReceipt(), expiresAt: F.SYNTH.t0 }))).toContain("CONFIRMATION_EXPIRY_NOT_AFTER_CAPTURE");
    expect(ConfirmationReceipt.safeParse({ ...F.confirmationReceipt(), method: "model_asserted" }).success).toBe(false);
  });

  it("[FO-04-22][ACT-01] an action grant is narrow: subject, actor, purpose, window, uses, permitted actions, digest and parameter bounds all fail closed", () => {
    const g = ActionGrant.parse(F.actionGrant());
    const use: ActionGrantUse = {
      tenantId: F.SYNTH.tenantId,
      subjectRef: F.SYNTH.subjectRef,
      actorRef: F.SYNTH.actorRef,
      purpose: "durable_follow_up",
      action: "billing.review.commit",
      preparedActionDigest: null,
      parameters: { disputedAmount: { currency: "USD", minorUnits: 12_000 } },
    };
    expect(checkActionGrant(g, use, NOW)).toEqual({ valid: true });
    expect(checkActionGrant(g, { ...use, action: "appointment.cancel.commit" }, NOW)).toEqual({ valid: false, reasonCode: "GRANT_ACTION_NOT_PERMITTED" });
    expect(checkActionGrant({ ...g, usesConsumed: 1 }, use, NOW)).toEqual({ valid: false, reasonCode: "GRANT_EXHAUSTED" });
    expect(checkActionGrant({ ...g, revokedAt: F.SYNTH.t0, revocationReason: "CONSENT_WITHDRAWN" }, use, NOW)).toEqual({ valid: false, reasonCode: "GRANT_REVOKED" });
    expect(checkActionGrant(g, use, new Date(F.at(15 * 86_400_000)))).toEqual({ valid: false, reasonCode: "GRANT_EXPIRED" });
    expect(checkActionGrant(g, use, new Date(F.at(-1)))).toEqual({ valid: false, reasonCode: "GRANT_NOT_YET_VALID" });
    expect(checkActionGrant({ ...g, preparedActionDigest: F.digestOf("a") }, { ...use, preparedActionDigest: F.digestOf("b") }, NOW)).toEqual({ valid: false, reasonCode: "GRANT_DIGEST_MISMATCH" });
    expect(checkActionGrant(g, { ...use, tenantId: F.SYNTH.otherTenantId }, NOW)).toEqual({ valid: false, reasonCode: "GRANT_TENANT_MISMATCH" });
    // Probe P2 of the WP-02 verifier: the grant used for ANOTHER subject, by another actor, for another purpose.
    expect(checkActionGrant(g, { ...use, subjectRef: F.SYNTH.otherSubjectRef }, NOW)).toEqual({ valid: false, reasonCode: "GRANT_SUBJECT_MISMATCH" });
    expect(checkActionGrant(g, { ...use, actorRef: "act_someoneElse00000001" }, NOW)).toEqual({ valid: false, reasonCode: "GRANT_ACTOR_MISMATCH" });
    expect(checkActionGrant(g, { ...use, actorRef: null }, NOW)).toEqual({ valid: false, reasonCode: "GRANT_ACTOR_MISMATCH" });
    expect(checkActionGrant({ ...g, actorRef: null }, { ...use, actorRef: "act_someoneElse00000001" }, NOW)).toEqual({ valid: true });
    expect(checkActionGrant(g, { ...use, purpose: "staff_support" }, NOW)).toEqual({ valid: false, reasonCode: "GRANT_PURPOSE_MISMATCH" });
    // Probe P2b: parameter bounds are enforced, not just declared.
    const out = (parameters: ActionGrantUse["parameters"]) => checkActionGrant(g, { ...use, parameters }, NOW);
    expect(out({})).toEqual({ valid: false, reasonCode: "GRANT_PARAMETER_MISSING", field: "disputedAmount" });
    expect(out({ disputedAmount: { currency: "USD", minorUnits: 50_001 } })).toEqual({ valid: false, reasonCode: "GRANT_PARAMETER_OUT_OF_BOUNDS", field: "disputedAmount" });
    expect(out({ disputedAmount: { currency: "USD", minorUnits: 50_000 } })).toEqual({ valid: true });
    expect(out({ disputedAmount: { currency: "EUR", minorUnits: 100 } })).toEqual({ valid: false, reasonCode: "GRANT_PARAMETER_OUT_OF_BOUNDS", field: "disputedAmount" });
    expect(out({ disputedAmount: { currency: "USD", minorUnits: -5 } })).toEqual({ valid: false, reasonCode: "GRANT_PARAMETER_OUT_OF_BOUNDS", field: "disputedAmount" });
    expect(out({ disputedAmount: 100 })).toEqual({ valid: false, reasonCode: "GRANT_PARAMETER_OUT_OF_BOUNDS", field: "disputedAmount" });
    const bounded = ActionGrant.parse({
      ...F.actionGrant(),
      parameterBounds: [
        { kind: "ALLOWED_VALUES", field: "reasonCategory", values: ["CHARGE_NOT_RECOGNIZED"] },
        { kind: "TIME_WINDOW", field: "startsAt", from: F.at(86_400_000), to: F.at(2 * 86_400_000) },
      ],
    });
    const within = { reasonCategory: "CHARGE_NOT_RECOGNIZED", startsAt: F.at(86_400_000) };
    expect(checkActionGrant(bounded, { ...use, parameters: within }, NOW)).toEqual({ valid: true });
    expect(checkActionGrant(bounded, { ...use, parameters: { ...within, reasonCategory: "OTHER" } }, NOW)).toEqual({ valid: false, reasonCode: "GRANT_PARAMETER_OUT_OF_BOUNDS", field: "reasonCategory" });
    expect(checkActionGrant(bounded, { ...use, parameters: { ...within, startsAt: F.at(2 * 86_400_000) } }, NOW)).toEqual({ valid: false, reasonCode: "GRANT_PARAMETER_OUT_OF_BOUNDS", field: "startsAt" });
    expect(checkActionGrant(bounded, { ...use, parameters: { ...within, startsAt: "tomorrow" } }, NOW)).toEqual({ valid: false, reasonCode: "GRANT_PARAMETER_OUT_OF_BOUNDS", field: "startsAt" });
    expect(issues(ActionGrant.safeParse({ ...F.actionGrant(), usesConsumed: 2 }))).toContain("GRANT_USES_EXCEEDED");
    expect(ActionGrant.safeParse({ ...F.actionGrant(), permittedActions: ["billing.review.commit", "billing.review.commit"] }).success).toBe(false);
  });

  it("[FO-04-23] a commit receipt can link its independent effect verification", () => {
    expect(Object.keys(CommitReceipt.shape)).toEqual(expect.arrayContaining(["schemaVersion", "tenantId", "causationId", "effectVerificationRef"]));
    expect(CommitReceipt.shape.effectVerificationRef.safeParse("efv_synthVerification001").success).toBe(true);
    expect(CommitReceipt.shape.effectVerificationRef.safeParse("rcp_synthCommitReceipt01").success).toBe(false);
  });

  it("[FO-04-24][ACT-03][ACT-04] VERIFIED needs a matching independent observation; not-found inside the visibility window is never definitive", () => {
    const v = EffectVerification.parse(F.effectVerification());
    expect(effectVerified(v)).toBe(true);
    const e = F.effectVerification();
    expect(issues(EffectVerification.safeParse({ ...e, observed: { ...e.observed!, stateDigest: F.digestOf("other") } }))).toContain("VERIFIED_WITHOUT_MATCHING_OBSERVATION");
    expect(issues(EffectVerification.safeParse({ ...e, observed: { ...e.observed!, version: "9" } }))).toContain("VERIFIED_WITH_VERSION_MISMATCH");
    expect(issues(EffectVerification.safeParse({ ...e, method: "HUMAN_ATTESTATION" }))).toContain("HUMAN_ATTESTATION_IS_NOT_SOURCE_VERIFICATION");
    const notFound = { ...e, result: "NOT_FOUND_AFTER_WINDOW" as const, observed: { ...e.observed!, stateDigest: null }, visibilityWindowEndsAt: F.at(60_000) };
    expect(issues(EffectVerification.safeParse(notFound))).toContain("NOT_FOUND_IS_NOT_DEFINITIVE_INSIDE_WINDOW");
    expect(EffectVerification.safeParse({ ...notFound, result: "NOT_FOUND_WITHIN_WINDOW" }).success).toBe(true);
    expect(EffectVerification.safeParse({ ...e, verifier: { ...e.verifier, independentOfModel: false } }).success).toBe(false);
    expect(effectVerified(EffectVerification.parse({ ...e, result: "PENDING_VISIBILITY", observed: null }))).toBe(false);
  });
});

describe("Cases, workflows and handoff [FO-04-25..29]", () => {
  it("[FO-04-26] a case link never invents an external id: SYNCED requires the returned record", () => {
    expect(CaseLink.parse(F.caseLink()).syncState).toBe("SYNCED");
    expect(issues(CaseLink.safeParse({ ...F.caseLink(), externalCaseRef: null }))).toContain("SYNCED_WITHOUT_EXTERNAL_RECORD");
    expect(CaseLink.safeParse({ ...F.caseLink(), externalCaseRef: null, syncState: "PENDING", lastSyncedAt: null }).success).toBe(true);
    expect(issues(CaseLink.safeParse({ ...F.caseLink(), kind: "REOPENED_FROM" }))).toContain("RELATED_LINK_WITHOUT_CASE");
  });

  it("[FO-04-28] a human task never carries a task token and a completed task records the authenticated decision", () => {
    expect(HumanTask.parse(F.humanTask()).status).toBe("OPEN");
    expect(HumanTask.safeParse({ ...F.humanTask(), taskToken: "x".repeat(43) }).success).toBe(false);
    expect(issues(HumanTask.safeParse({ ...F.humanTask(), status: "COMPLETED" }))).toContain("COMPLETED_TASK_WITHOUT_DECISION");
    expect(HumanTask.safeParse({ ...F.humanTask(), status: "COMPLETED", decision: "APPROVE", decidedBy: F.SYNTH.staffId, decidedAt: F.at(1_000) }).success).toBe(true);
    expect(issues(HumanTask.safeParse({ ...F.humanTask(), decision: "APPROVE" }))).toContain("DECISION_ON_OPEN_TASK");
  });

  it("[FO-04-25] SupportRequest exposes its CRM link as a CaseLink derived from the legacy Salesforce id (never invented)", () => {
    const base = {
      supportRequestId: F.SYNTH.caseId,
      referenceNumber: "SR-7KQM-W4XP",
      tenantId: F.SYNTH.tenantId,
      interactionExternalId: "int_synthInteraction0001",
      issueExternalId: "iss_synthIssue0000000001",
      audience: "client" as const,
      subjectRef: F.SYNTH.subjectRef,
      issueCategory: "billing_question" as const,
      disposition: "REQUEST_ACCEPTED" as const,
      ownerQueue: "q_billing",
      priority: "P3_STANDARD" as const,
      summary: "Billing question; follow-up accepted.",
      summaryProvenance: "template_assembled" as const,
      attempted: [],
      commitReceiptIds: [],
      sourceCallIds: [F.SYNTH.interactionId],
      language: "en",
      consent: { recording: "GRANTED" as const, automatedProcessing: "GRANTED" as const, disclosureTemplateVersion: "disclosure-en-1", capturedAt: F.SYNTH.t0, capturedBy: "studio_flow" as const },
      nextStep: null,
      deadline: null,
      versions: { agentConfig: "agent-1", model: "model-1", voice: "voice-1", promptTemplates: "prompts-1", policyBundle: "policy-1", toolCatalog: F.digestOf("catalog"), knowledgeSnapshot: "kb-1", schema: "2026-10-17.1" },
      restricted: false,
      syncState: "PENDING" as const,
      salesforceCaseId: null,
      createdAt: F.SYNTH.t0,
      updatedAt: F.SYNTH.t0,
    };
    const pending = SupportRequest.parse(base);
    expect(caseLinksOf(pending)).toEqual([]);
    const synced = SupportRequest.parse({ ...base, syncState: "SYNCED", salesforceCaseId: "500Ax00000SynthAAA", updatedAt: F.at(60_000) });
    const [link] = caseLinksOf(synced);
    expect(link?.externalCaseRef).toBe("500Ax00000SynthAAA");
    expect(link?.caseId).toBe(F.SYNTH.caseId);
    expect(CaseLink.parse(link).syncState).toBe("SYNCED");
    const retrying = SupportRequest.parse({ ...base, syncState: "RETRY_SCHEDULED" });
    expect(caseLinksOf(retrying)[0]?.externalCaseRef).toBeNull();
    expect(SupportRequest.safeParse({ ...base, issueOutcome: F.issueOutcome({ evidenceRefs: [] }) }).success).toBe(false);
  });

  it("[FO-04-25][FO-04-26][AUTH-05] a support request accepts only its own case links: same tenant, same case, one of its calls, unique link ids", () => {
    const base = {
      supportRequestId: F.SYNTH.caseId, referenceNumber: "SR-7KQM-W4XP", tenantId: F.SYNTH.tenantId, interactionExternalId: "int_synthInteraction0001",
      issueExternalId: "iss_synthIssue0000000001", audience: "client", subjectRef: F.SYNTH.subjectRef, issueCategory: "billing_question",
      disposition: "REQUEST_ACCEPTED", ownerQueue: "q_billing", priority: "P3_STANDARD", summary: "Billing question; follow-up accepted.",
      summaryProvenance: "template_assembled", attempted: [], commitReceiptIds: [], sourceCallIds: [F.SYNTH.interactionId], language: "en",
      consent: { recording: "GRANTED", automatedProcessing: "GRANTED", disclosureTemplateVersion: "disclosure-en-1", capturedAt: F.SYNTH.t0, capturedBy: "studio_flow" },
      nextStep: null, deadline: null,
      versions: { agentConfig: "agent-1", model: "model-1", voice: "voice-1", promptTemplates: "prompts-1", policyBundle: "policy-1", toolCatalog: F.digestOf("catalog"), knowledgeSnapshot: "kb-1", schema: "2026-10-17.1" },
      restricted: false, syncState: "SYNCED", salesforceCaseId: null, createdAt: F.SYNTH.t0, updatedAt: F.SYNTH.t0,
    } as const;
    const own = SupportRequest.parse({ ...base, caseLinks: [F.caseLink(), F.caseLink(F.SYNTH.caseId, null)].map((l, i) => ({ ...l, linkId: `csl_synthOwnLink00000${i}` })) });
    expect(caseLinksOf(own).map((l) => l.caseId)).toEqual([F.SYNTH.caseId, F.SYNTH.caseId]);
    // The verifier's probe: a link from another tenant and another case is refused, not carried.
    const foreign = { ...F.caseLink(F.SYNTH.secondCaseId, F.SYNTH.interactionId), tenantId: F.SYNTH.otherTenantId };
    expect(CaseLink.safeParse(foreign).success).toBe(true);
    expect(issues(SupportRequest.safeParse({ ...base, caseLinks: [foreign] }))).toEqual(expect.arrayContaining(["CASE_LINK_FROM_OTHER_TENANT", "CASE_LINK_FOR_OTHER_CASE"]));
    // caseLinksOf validates its input, so an unparsed record with a foreign link throws instead of leaking it.
    expect(() => caseLinksOf({ ...base, caseLinks: [foreign] } as unknown as SupportRequest)).toThrow();
    // Many calls, one case: a link created on the case's follow-up call is accepted once that call is a source call.
    const repeat = { ...F.caseLink(F.SYNTH.caseId, F.SYNTH.secondInteractionId), linkId: "csl_synthRepeatLink0001" };
    expect(issues(SupportRequest.safeParse({ ...base, caseLinks: [repeat] }))).toContain("CASE_LINK_FROM_UNRELATED_CALL");
    expect(SupportRequest.safeParse({ ...base, sourceCallIds: [F.SYNTH.interactionId, F.SYNTH.secondInteractionId], caseLinks: [repeat] }).success).toBe(true);
  });
});

describe("Connectors, tenant configuration, activation, improvement, review, plans [FO-04-34][FO-04-35][FO-04-38][FO-04-41][FO-04-43]", () => {
  it("[FO-04-34] a connector profile holds only a secret reference, allowlisted hosts and reviewed operations; read-only profiles cannot enable writes", () => {
    const p = { ...F.connectorProfile(), configDigest: computeConnectorProfileDigest(F.connectorProfile()) };
    expect(ConnectorProfile.parse(p).writeMode).toBe("READ_ONLY");
    expect(ConnectorProfile.safeParse({ ...p, credentialRef: "Bearer synthetic-token-value" }).success).toBe(false);
    expect(ConnectorProfile.safeParse({ ...p, baseUrl: "https://scheduling.example.invalid/api?token=x" }).success).toBe(false);
    expect(issues(ConnectorProfile.safeParse({ ...p, allowedHosts: ["other.example.invalid"] }))).toContain("BASE_URL_HOST_NOT_ALLOWED");
    const write = { operationId: "appointments.update", kind: "WRITE" as const, enabled: true, method: "PATCH" as const, pathTemplate: "/appointments/{id}", idempotency: "IDEMPOTENCY_KEY_HEADER" as const, reconcileOperationId: null };
    expect(issues(ConnectorProfile.safeParse({ ...p, operations: [...p.operations, write] }))).toContain("WRITE_ENABLED_ON_READ_ONLY_PROFILE");
    expect(issues(ConnectorProfile.safeParse({ ...p, writeMode: "SANDBOX_WRITE", operations: [...p.operations, write] }))).toContain("WRITES_WITHOUT_VERIFIED_ACCOUNT_BINDING");
    expect(computeConnectorProfileDigest({ ...p, profileVersion: 2 })).not.toBe(p.configDigest);
  });

  it("[FO-04-34] capability evidence distinguishes code, emulator and vendor passes; vendor evidence must be signed", () => {
    expect(CapabilityEvidence.parse(F.capabilityEvidence()).level).toBe("EMULATOR_PASS");
    expect(issues(CapabilityEvidence.safeParse({ ...F.capabilityEvidence(), level: "VENDOR_SANDBOX_PASS" }))).toContain("VENDOR_EVIDENCE_UNSIGNED");
    const failed = { ...F.capabilityEvidence(), steps: [{ step: "AUTHENTICATE" as const, result: "FAIL" as const, detailCode: "TOKEN_REFUSED" }] };
    expect(issues(CapabilityEvidence.safeParse(failed))).toContain("PASS_WITH_FAILED_STEP");
  });

  it("[FO-04-35][FO-04-43] tenant configuration carries the explicit business timezone used for dates, with reviewed publication", () => {
    const c = { ...F.tenantConfig(), configDigest: computeTenantConfigDigest(F.tenantConfig()) };
    const parsed = TenantConfig.parse(c);
    expect(tenantBusinessDate(parsed, "2026-11-01T04:30:00.000Z")).toBe("2026-10-31");
    expect(tenantBusinessDate({ businessTimeZone: "Asia/Tokyo" }, "2026-11-01T04:30:00.000Z")).toBe("2026-11-01");
    expect(unsetRetentionClasses(parsed)).toEqual(["TRANSIENT_CONVERSATION", "BUSINESS_RECORD", "RESTRICTED_QA_MEDIA", "SECURITY_AUDIT"]);
    expect(TenantConfig.safeParse({ ...c, businessTimeZone: "+05:00" }).success).toBe(false);
    expect(TenantConfig.safeParse({ ...c, businessTimeZone: "Mars/Olympus" }).success).toBe(false);
    expect(issues(TenantConfig.safeParse({ ...c, reviewedBy: c.publishedBy }))).toContain("SELF_REVIEWED_PUBLICATION");
    expect(issues(TenantConfig.safeParse({ ...c, regions: { primary: "eu-west-1", secondary: null, usOnly: true } }))).toContain("US_ONLY_REGION_OUTSIDE_US");
  });

  it("[FO-04-41][OPS-03][OPS-04] activation claims no more than its evidence: ACTIVE needs PASS, approvals, no missing inputs and an approved pilot environment", () => {
    expect(ActivationReport.parse(F.activationReport()).summary.notEligible).toBe(1);
    expect(issues(ActivationRecord.safeParse(F.activationRecord({ state: "ACTIVE" })))).toEqual(
      expect.arrayContaining(["ELIGIBLE_WITHOUT_QUALIFICATION_PASS", "ELIGIBLE_WITH_MISSING_INPUTS", "ELIGIBLE_WITH_MISSING_APPROVALS", "ACTIVE_BELOW_APPROVED_PILOT"]),
    );
    const ready = F.activationRecord({ qualification: "PASS", evidenceRefs: ["evidence/qualification/q-1"], missingInputs: [], approvalsPresent: [{ scope: "PHI_PROCESSING", approvalId: "apr_synthPhiApproval1" }], environment: "VERIFIED_SANDBOX", state: "ELIGIBLE", reasonCodes: [] });
    expect(ActivationRecord.safeParse(ready).success).toBe(true);
    expect(permittedActivationState(ready)).toBe("ELIGIBLE");
    expect(permittedActivationState({ ...ready, environment: "APPROVED_PILOT" })).toBe("ACTIVE");
    expect(permittedActivationState({ ...ready, qualification: "INCONCLUSIVE" })).toBe("NOT_ELIGIBLE");
    expect(issues(ActivationReport.safeParse({ ...F.activationReport(), summary: { active: 1, eligible: 0, notEligible: 0, suspended: 0, deactivated: 0 } }))).toContain("SUMMARY_DOES_NOT_MATCH_RECORDS");
  });

  it("[FO-04-38] no self-promotion: promotion needs human review and passing required tests; an optimizer cannot change authority", () => {
    expect(ChangeProposal.parse(F.changeProposal()).state).toBe("EVALUATING");
    expect(issues(ChangeProposal.safeParse({ ...F.changeProposal(), state: "PROMOTED" }))).toEqual(expect.arrayContaining(["PROMOTION_WITHOUT_HUMAN_REVIEW", "PROMOTION_WITH_REQUIRED_TEST_NOT_PASSED"]));
    const policy = { ...F.changeProposal(), changes: [{ ...F.changeProposal().changes[0]!, target: "PERMISSION_SET" as const }] };
    expect(issues(ChangeProposal.safeParse(policy))).toContain("OPTIMIZER_CANNOT_CHANGE_AUTHORITY");
    expect(ChangeProposal.safeParse({ ...F.changeProposal(), heldOutFeedbackUsed: true }).success).toBe(false);
    expect(CanarySpec.parse(F.canarySpec()).rollbackOnCriticalFailure).toBe(true);
    expect(CanarySpec.safeParse({ ...F.canarySpec(), excludedBehaviours: ["CRISIS_INSTRUCTIONS", "CONSENT_CONTROLS"] }).success).toBe(false);
  });

  it("[FO-04-37] review records are human and signed; dataset families never leak across splits; a fault result needs independent reached-fault evidence", () => {
    expect(ReviewRecord.parse(F.reviewRecord()).reviewer.kind).toBe("human");
    expect(ReviewRecord.safeParse({ ...F.reviewRecord(), reviewer: { ...F.reviewRecord().reviewer, kind: "synthetic" } }).success).toBe(false);
    expect(issues(ReviewRecord.safeParse({ ...F.reviewRecord(), labels: [{ key: "safety.missed_route", value: "MISSED", severity: "CRITICAL" }] }))).toContain("PASS_WITH_CRITICAL_LABEL");
    expect(DatasetItem.parse(F.datasetItem()).split).toBe("development");
    expect(issues(DatasetItem.safeParse({ ...F.datasetItem(), provenance: "CONSENTED_REVIEWED_PRODUCTION" }))).toEqual(expect.arrayContaining(["PRODUCTION_DATA_WITHOUT_CONSENT", "PRODUCTION_DATA_UNREVIEWED"]));
    expect(familiesLeakingAcrossSplits([{ familyKey: "a", split: "development" }, { familyKey: "a", split: "heldout_acceptance" }, { familyKey: "b", split: "tuning" }])).toEqual(["a"]);
    expect(faultReached({ requestedFault: "CRM_DOWN", reachedFault: null })).toBe(false);
    expect(faultReached({ requestedFault: "CRM_DOWN", reachedFault: { faultId: "CRM_DOWN", evidenceRef: "evidence/runs/x/outbox.jsonl", observedBy: "outbox.inspector" } })).toBe(true);
    expect(faultReached({ requestedFault: null })).toBe(true);
    expect(EvaluationResult.shape.executionMode.safeParse("local_emulator").success).toBe(false);
  });

  it("[FO-04-45] long-horizon plans stay within their grant ceiling and a replan cannot widen it", () => {
    const p = LongHorizonPlan.parse(F.longHorizonPlan());
    expect(authorityExpansion(p, p)).toEqual([]);
    const widened = { ...p, revision: 2, supersedesRevision: 1, authorityCeiling: { ...p.authorityCeiling, permittedActions: ["billing.review.commit", "billing.refund.commit"] } };
    expect(authorityExpansion(p, LongHorizonPlan.parse(widened))).toEqual(["billing.refund.commit"]);
    // A replan that keeps the same action names under a different grant still expands authority.
    const swapped = { ...p, revision: 2, supersedesRevision: 1, authorityCeiling: { ...p.authorityCeiling, grantRef: "grt_synthOtherGrant00001" } };
    expect(authorityExpansion(p, LongHorizonPlan.parse(swapped))).toEqual(["<grant-changed>"]);
    const step = p.steps[1]!;
    expect(issues(LongHorizonPlan.safeParse({ ...p, steps: [p.steps[0]!, { ...step, action: "billing.refund.commit" }] }))).toContain("STEP_EXCEEDS_AUTHORITY_CEILING");
    expect(issues(LongHorizonPlan.safeParse({ ...p, nextActionStepId: null }))).toContain("OPEN_PLAN_WITHOUT_NEXT_ACTION");
  });

  it("[FO-04-40] ReleaseManifest can carry the two-axis status and per-capability records next to the legacy status", () => {
    expect(Object.keys(ReleaseManifest.shape)).toEqual(expect.arrayContaining(["status", "statusAxes", "capabilities"]));
  });

  it("[FO-04-05] AuthContext gains the server-established processing basis, consent profile and data classification (optional until the session service sets them)", () => {
    const keys = Object.keys(AuthContext.shape);
    for (const k of ["schemaVersion", "processingBasis", "consentProfile", "dataClassification"]) expect(keys).toContain(k);
    const basis = AuthContext.shape.processingBasis.unwrap();
    expect(basis.safeParse({ basis: "HIPAA_TREATMENT_PAYMENT_OPERATIONS", purpose: "support_administration", jurisdiction: "US-IL", approvalRef: "apr_synthMatrix0001", establishedAt: F.SYNTH.t0, source: "policy_matrix" }).success).toBe(true);
    expect(basis.safeParse({ basis: "CALLER_SAID_SO", purpose: "support_administration", jurisdiction: "US", approvalRef: null, establishedAt: F.SYNTH.t0, source: "policy_matrix" }).success).toBe(false);
  });
});

/* ---- regression tests for the round-2 verifier probes (P1-P9) and the receipt/plan binding ---- */

const here = dirname(fileURLToPath(import.meta.url));
interface CatalogTemplate {
  id?: string;
  templateId?: string;
  responseClass: string;
  text: string;
}
const catalogTemplates = (locale: string): CatalogTemplate[] => {
  const raw = JSON.parse(readFileSync(join(here, `../voice/templates/${locale}.json`), "utf8")) as { templates?: CatalogTemplate[] | Record<string, CatalogTemplate> } | CatalogTemplate[];
  const list = Array.isArray(raw) ? raw : raw.templates ?? [];
  return Array.isArray(list) ? list : Object.values(list);
};

describe("contract boundary regressions [WP-02 verifier round 2]", () => {
  it("[FO-04-05][AUTH-03] P1: a processing basis that relies on the approved matrix names its approval; UNKNOWN never carries one and an unknown jurisdiction admits only public, unknown or safety bases", () => {
    const basis = AuthContext.shape.processingBasis.unwrap();
    const b = { basis: "HIPAA_AUTHORIZATION", purpose: "support_administration", jurisdiction: "US", approvalRef: "apr_synthMatrix0001", establishedAt: F.SYNTH.t0, source: "policy_matrix" };
    expect(basis.safeParse(b).success).toBe(true);
    expect(issues(basis.safeParse({ ...b, approvalRef: null }))).toContain("PROCESSING_BASIS_WITHOUT_APPROVAL");
    expect(issues(basis.safeParse({ ...b, basis: "PART2_WRITTEN_CONSENT", approvalRef: null }))).toContain("PROCESSING_BASIS_WITHOUT_APPROVAL");
    expect(basis.safeParse({ ...b, basis: "PUBLIC_INFORMATION", approvalRef: null }).success).toBe(true);
    expect(basis.safeParse({ ...b, basis: "UNKNOWN", approvalRef: null, jurisdiction: "UNKNOWN" }).success).toBe(true);
    expect(issues(basis.safeParse({ ...b, basis: "UNKNOWN" }))).toContain("UNKNOWN_BASIS_WITH_APPROVAL");
    expect(issues(basis.safeParse({ ...b, jurisdiction: "UNKNOWN" }))).toContain("BASIS_FOR_UNKNOWN_JURISDICTION");
    // Safety routing never waits for jurisdiction (SAFE-02), but still names its approved matrix entry.
    expect(basis.safeParse({ ...b, basis: "SAFETY_ROUTING", purpose: "safety_routing", jurisdiction: "UNKNOWN" }).success).toBe(true);
    expect(issues(basis.safeParse({ ...b, basis: "SAFETY_ROUTING", purpose: "safety_routing", jurisdiction: "UNKNOWN", approvalRef: null }))).toContain("PROCESSING_BASIS_WITHOUT_APPROVAL");
  });

  it("[FO-04-05][AUTH-06] P9: the session's disclosure ceiling can never be VERIFICATION_SECRET", () => {
    const ceiling = AuthContext.shape.dataClassification.unwrap();
    expect(ceiling.options).toEqual(DisclosureClassification.options);
    expect(ceiling.safeParse("VERIFICATION_SECRET").success).toBe(false);
    for (const c of ["PUBLIC", "INTERNAL", "PHI", "PHI_RESTRICTED", "FINANCIAL"]) expect(ceiling.safeParse(c).success, c).toBe(true);
  });

  it("[DATA-03][WP-02] P8: EXPIRED lives in ConsentValueV2 only; the ConsentValue that existing consumers parse refuses it, so their fail-closed parse branch applies", () => {
    expect(ConsentValue.safeParse("EXPIRED").success).toBe(false);
    expect(ConsentValueV2.safeParse("EXPIRED").success).toBe(true);
    expect(ConsentDimensionState.safeParse({ ...F.consentDimension(), value: "EXPIRED" }).success).toBe(true);
    // The session capture and the existing consumers keep the four wire values.
    expect(ConsentValue.options).toEqual(["GRANTED", "DECLINED", "UNKNOWN", "NOT_REQUIRED"]);
  });

  it("[FO-04-31][ACT-05] P5: a protected-fact plan states no value in its wording: amounts, dates and counts come only from typed slots named by placeholders", () => {
    const base = F.unsealedSpeechPlan();
    const literal = (text: string, slotNames: string[] = []) => ({ ...base, protectedSlots: slotNames.length ? base.protectedSlots : [], segments: [{ kind: "TEMPLATE_EXACT" as const, templateId: "billing.balance_due", templateVersion: "1.0.0", text, slotNames }] });
    // sealSpeechPlan refuses (throws on) an invalid plan, so refused variants carry a placeholder digest.
    const unsealed = (p: object) => ({ ...p, outputDecisionDigest: F.digestOf("plan-under-test") });
    expect(() => sealSpeechPlan(literal("Your balance is 45 dollars."))).toThrow(/PROTECTED_VALUE_OUTSIDE_SLOT/);
    expect(issues(SpeechPlan.safeParse(unsealed(literal("Your balance is 45 dollars."))))).toContain("PROTECTED_VALUE_OUTSIDE_SLOT");
    expect(issues(SpeechPlan.safeParse(unsealed(literal("Your balance is forty-five dollars."))))).toContain("PROTECTED_VALUE_OUTSIDE_SLOT");
    expect(issues(SpeechPlan.safeParse(unsealed(literal("Your balance is $ {balance}, due on {dueOn}.", ["balance", "dueOn"]))))).toContain("PROTECTED_VALUE_OUTSIDE_SLOT");
    expect(issues(SpeechPlan.safeParse(unsealed({ ...literal("Su saldo es de cuarenta y cinco dólares."), language: "es-US" })))).toContain("PROTECTED_VALUE_OUTSIDE_SLOT");
    expect(issues(SpeechPlan.safeParse(unsealed(literal("Your current balance is {balance}.", ["balance", "dueOn"]))))).toContain("TEMPLATE_PLACEHOLDER_MISMATCH");
    expect(issues(SpeechPlan.safeParse(unsealed(literal("Your current balance is {balance, due on {dueOn}.", ["balance", "dueOn"]))))).toContain("TEMPLATE_PLACEHOLDER_MISMATCH");
    expect(SpeechPlan.safeParse(sealSpeechPlan(literal("Your current balance is {balance}, due on {dueOn}.", ["balance", "dueOn"]))).success).toBe(true);
    // Fixed safety wording may state its own digits (a crisis line number is approved wording, not a protected fact).
    const safety = { ...base, utteranceClass: "SAFETY" as const, authorizationRef: null, sourceRefs: [], protectedSlots: [], segments: [{ kind: "TEMPLATE_EXACT" as const, templateId: "safety.crisis_line", templateVersion: "1.0.0", text: "You can call or text 988 at any time.", slotNames: [] }] };
    expect(SpeechPlan.safeParse(sealSpeechPlan(safety)).success).toBe(true);
    // Every approved protected-class template of the voice catalog satisfies the rule in its own language.
    let checked = 0;
    for (const [locale, language] of [["en-US", "en-US"], ["es-US", "es-US"]] as const) {
      for (const t of catalogTemplates(locale)) {
        if (!(FACT_PROTECTED_CLASSES as readonly string[]).includes(t.responseClass)) continue;
        checked++;
        expect(literalStatesValue(t.text, language), `${locale} ${t.id ?? t.templateId}: ${t.text}`).toBe(false);
        expect(templatePlaceholders(t.text).strayBrace, `${locale} ${t.id ?? t.templateId}`).toBe(false);
      }
    }
    expect(checked).toBeGreaterThan(40);
  });

  it("[FO-04-31][FO-04-32] P6: clip audio is never attributed to a plan, and a receipt must be consistent with the plan it names", () => {
    const r = F.audioReleaseReceipt();
    expect(issues(AudioReleaseReceipt.safeParse({ ...r, renderer: "fallback_clip" }))).toContain("PLAN_RENDERED_AS_CLIP");
    const plan = F.speechPlan();
    const forPlan = AudioReleaseReceipt.parse({ ...r, source: { kind: "speech_plan", planId: plan.planId, outputDecisionDigest: plan.outputDecisionDigest } });
    expect(receiptPlanIssues(forPlan, plan)).toEqual([]);
    expect(receiptPlanIssues({ ...forPlan, source: { ...forPlan.source, outputDecisionDigest: F.digestOf("other") } } as AudioReleaseReceipt, plan)).toEqual(["RECEIPT_PLAN_DIGEST_MISMATCH"]);
    expect(receiptPlanIssues({ ...forPlan, sessionGeneration: 2 }, plan)).toEqual(["RECEIPT_GENERATION_MISMATCH"]);
    expect(receiptPlanIssues({ ...forPlan, turnId: "turn_synth0002" }, plan)).toEqual(["RECEIPT_TURN_MISMATCH"]);
    expect(receiptPlanIssues({ ...forPlan, tenantId: F.SYNTH.otherTenantId, interactionId: F.SYNTH.secondInteractionId }, plan)).toEqual(["RECEIPT_TENANT_MISMATCH", "RECEIPT_INTERACTION_MISMATCH"]);
    expect(receiptPlanIssues({ ...forPlan, renderer: "native_buffer_checked" }, plan)).toEqual(["RENDERER_NOT_ALLOWED_BY_PLAN"]);
    expect(receiptPlanIssues({ ...forPlan, source: { ...forPlan.source, planId: "spl_synthSpeechPlan00002" } } as AudioReleaseReceipt, plan)).toEqual(["RECEIPT_FOR_OTHER_PLAN"]);
    const late = { ...forPlan, playback: { ...forPlan.playback!, firstFrameAt: plan.expiresAt, lastFrameAt: F.at(40_000) } };
    expect(receiptPlanIssues(late, plan)).toEqual(["EMITTED_AFTER_PLAN_EXPIRY"]);
    // A clip standing in for the plan (TTS failure) is a clip receipt that names the plan.
    const clip = AudioReleaseReceipt.parse({ ...r, renderer: "fallback_clip", source: { kind: "fallback_clip", clipRef: "clip_billing_followup@v1", clipManifestDigest: F.digestOf("clips"), planId: plan.planId } });
    expect(receiptPlanIssues(clip, plan)).toEqual([]);
    expect(receiptPlanIssues(clip, { ...plan, allowedRenderers: ["controlled_tts"] })).toEqual(["RENDERER_NOT_ALLOWED_BY_PLAN"]);
    const withClip = sealSpeechPlan({ ...F.unsealedSpeechPlan(), segments: [...F.unsealedSpeechPlan().segments, { kind: "FALLBACK_CLIP", clipRef: "clip_billing_other@v2", clipManifestDigest: F.digestOf("clips") }] });
    expect(receiptPlanIssues(clip, withClip)).toEqual(["CLIP_NOT_IN_PLAN"]);
    expect(receiptPlanIssues({ ...clip, source: { ...clip.source, planId: null } } as AudioReleaseReceipt, plan)).toEqual(["RECEIPT_FOR_OTHER_PLAN"]);
  });

  it("[FO-04-10][FO-04-18] P7: a heartbeat or source update stamped in the future is never evidence of freshness", () => {
    const w = SourceWatermark.parse(F.sourceWatermark());
    const future = { ...w, lastHeartbeatAt: "2030-01-01T00:00:00.000Z" };
    expect(watermarkAgeMs(future, NOW)).toBeNull();
    expect(watermarkIsFresh(future, NOW)).toBe(false);
    expect(watermarkIsFresh({ ...w, high: { ...w.high, eventTime: F.at(60_000) } }, NOW)).toBe(false);
    // Within the tolerated skew the age is zero, not unknown.
    expect(watermarkAgeMs({ ...w, lastHeartbeatAt: F.at(MAX_CLOCK_SKEW_MS) }, NOW)).toBe(0);
    expect(watermarkAgeMs({ ...w, lastHeartbeatAt: F.at(MAX_CLOCK_SKEW_MS + 1) }, NOW)).toBeNull();
    expect(issues(SourceWatermark.safeParse({ ...F.sourceWatermark(), lastHeartbeatAt: "2030-01-01T00:00:00.000Z" }))).toContain("WATERMARK_EVIDENCE_AFTER_RECORD");
    expect(issues(SourceWatermark.safeParse({ ...F.sourceWatermark(), lastEventReceivedAt: F.at(60_000) }))).toContain("WATERMARK_EVIDENCE_AFTER_RECORD");
    const f = { observedAt: F.SYNTH.t0, maxAgeMs: 60_000, sources: [{ system: "billing", watermarkId: "wmk_synthWatermarkBill01", sourceUpdatedAt: F.at(60_000), ageMs: 0 }], stale: false };
    expect(issues(ToolResultFreshness.safeParse(f))).toContain("SOURCE_UPDATE_AFTER_OBSERVATION");
  });

  it("[FO-04-11][FO-04-45] a CDP profile or analytics verification never authorizes; role assignments are filtered by tenant", () => {
    const l = F.identityLink();
    expect(issues(IdentityLink.safeParse({ ...l, linked: { ...l.linked, kind: "CDP_PROFILE", issuer: null } }))).toContain("ELIGIBLE_LINK_FROM_ANALYTICS");
    expect(IdentityLink.safeParse({ ...l, linked: { ...l.linked, kind: "CDP_PROFILE", issuer: null }, authorizationEligible: false }).success).toBe(true);
    const a = PersonRoleAssignment.parse(F.personRoleAssignment("client", "Client00001"));
    expect(activeAssignments([a], F.SYNTH.tenantId, a.personRef, NOW)).toHaveLength(1);
    expect(activeAssignments([a], F.SYNTH.otherTenantId, a.personRef, NOW)).toEqual([]);
  });

  it("[FO-04-08][FO-04-12][FO-04-24][FO-04-28] snapshots hold only usable facts, citations pin their own version, event verifications name the event, decisions fall inside the task window", () => {
    const s = F.contextSnapshot();
    expect(issues(ContextSnapshot.safeParse({ ...s, facts: [{ ...s.facts[0]!, expiresAt: F.at(-1) }] }))).toContain("EXPIRED_FACT_IN_SNAPSHOT");
    expect(issues(KnowledgeCitation.safeParse({ ...F.knowledgeCitation(), citationId: "kb_billing-faq@v2" }))).toContain("CITATION_VERSION_MISMATCH");
    const e = F.effectVerification();
    expect(issues(EffectVerification.safeParse({ ...e, method: "EXTERNAL_KEY_LOOKUP", observed: { ...e.observed!, sourceEventRef: null } }))).toContain("VERIFIED_WITHOUT_SOURCE_EVENT");
    expect(EffectVerification.safeParse({ ...e, observed: { ...e.observed!, sourceEventRef: null } }).success).toBe(true);
    const done = { ...F.humanTask(), status: "COMPLETED" as const, decision: "APPROVE" as const, decidedBy: F.SYNTH.staffId, decidedAt: F.at(60_000) };
    expect(HumanTask.safeParse(done).success).toBe(true);
    expect(issues(HumanTask.safeParse({ ...done, decidedAt: F.at(2 * 86_400_000) }))).toContain("DECISION_AFTER_EXPIRY");
  });
});
