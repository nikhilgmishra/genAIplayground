/**
 * ChangeProposal and CanarySpec (follow-on prompt section 18; FO-04-38).
 *
 * A ChangeProposal binds evidence, the suspected cause (verified cause or hypothesis, kept
 * distinct), the exact diff of each changed artifact, affected capabilities, expected benefit,
 * risks, required tests and rollback. Candidate generation may run autonomously, but nothing in a
 * proposal can promote itself: promotion needs human review records, and a change to permissions,
 * policy or authority controls needs separate governance review (no self-promotion, no
 * self-editing permissions).
 *
 * A CanarySpec carries the signed limits of one canary: tenant/cohort/intents/language, sample and
 * period targets, error budget and automatic rollback thresholds. Crisis instructions, consent and
 * authority controls are never experimented on.
 *
 * Created by WP-02 in phase B; owned by WP-36 from phase F.
 */
import { z } from "zod";
import {
  CapabilityId,
  EvidencePointer,
  IsoDateTime,
  QualificationResult,
  Sha256Hex,
  VersionLabel,
  envelope,
  isAfter,
  opaqueIdWithPrefix,
} from "./common.js";

export const CHANGE_PROPOSAL_SCHEMA_VERSION = "change-proposal.v1";
export const CANARY_SPEC_SCHEMA_VERSION = "canary-spec.v1";

export const ChangeTarget = z.enum([
  "PROMPT_TEMPLATE",
  "KNOWLEDGE_ARTICLE",
  "MODEL_ROUTE",
  "RETRIEVAL_TUNING",
  "ROUTER_CALIBRATION",
  "TOOL_CONFIGURATION",
  "TENANT_CONFIGURATION",
  "POLICY_BUNDLE",
  "PERMISSION_SET",
  "FINE_TUNED_ARTIFACT",
]);
export type ChangeTarget = z.infer<typeof ChangeTarget>;

/** Targets whose change can alter authority; they always need separate governance review. */
export const AUTHORITY_CHANGE_TARGETS = ["POLICY_BUNDLE", "PERMISSION_SET"] as const satisfies readonly ChangeTarget[];

export const ChangeProposalState = z.enum(["DRAFT", "EVALUATING", "IN_REVIEW", "APPROVED_FOR_CANARY", "CANARY", "PROMOTED", "ROLLED_BACK", "REJECTED"]);
export type ChangeProposalState = z.infer<typeof ChangeProposalState>;

const ReviewRef = opaqueIdWithPrefix("rvw");

export const ChangeProposal = z
  .strictObject({
    ...envelope(CHANGE_PROPOSAL_SCHEMA_VERSION, ["tenantId", "occurredAt"], ["causationId"]),
    proposalId: opaqueIdWithPrefix("chp"),
    authoredBy: z.strictObject({ kind: z.enum(["optimizer", "staff"]), ref: z.string().regex(/^[a-z][a-z0-9_-]{1,11}_[A-Za-z0-9_-]{8,64}$/) }),
    evidenceRefs: z.array(EvidencePointer).min(1).max(32),
    suspectedCause: z.strictObject({
      statementCode: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
      status: z.enum(["VERIFIED_CAUSE", "HYPOTHESIS"]),
      evidenceRefs: z.array(EvidencePointer).max(16),
    }),
    changes: z
      .array(
        z.strictObject({
          target: ChangeTarget,
          targetRef: z.string().regex(/^[A-Za-z0-9_.:@/-]{3,128}$/),
          fromVersion: VersionLabel,
          toVersion: VersionLabel,
          diffDigest: Sha256Hex,
          diffRef: EvidencePointer,
        }),
      )
      .min(1)
      .max(16),
    affectedCapabilities: z.array(CapabilityId).min(1).max(32),
    expectedBenefit: z.strictObject({ metric: z.string().regex(/^[a-z][a-z0-9_.]{2,80}$/), direction: z.enum(["INCREASE", "DECREASE"]), magnitude: z.number().finite().min(-1e6).max(1e6).nullable() }),
    risks: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/)).max(16),
    tests: z.array(z.strictObject({ suiteRef: z.string().regex(/^[a-z][a-z0-9_.:/-]{2,128}$/), required: z.boolean(), result: QualificationResult })).min(1).max(32),
    rollback: z.strictObject({ targetVersion: VersionLabel, procedureRef: EvidencePointer }),
    state: ChangeProposalState,
    reviewRefs: z.array(ReviewRef).max(16),
    governanceReviewRef: ReviewRef.nullable(),
    /** Held-out acceptance results are reported, never fed back to the optimizer. */
    heldOutFeedbackUsed: z.literal(false),
  })
  .superRefine((p, ctx) => {
    if (p.suspectedCause.status === "VERIFIED_CAUSE" && p.suspectedCause.evidenceRefs.length === 0) {
      ctx.addIssue({ code: "custom", message: "VERIFIED_CAUSE_WITHOUT_EVIDENCE", path: ["suspectedCause", "evidenceRefs"] });
    }
    const advanced: readonly ChangeProposalState[] = ["APPROVED_FOR_CANARY", "CANARY", "PROMOTED"];
    if (advanced.includes(p.state)) {
      if (p.reviewRefs.length === 0) ctx.addIssue({ code: "custom", message: "PROMOTION_WITHOUT_HUMAN_REVIEW", path: ["reviewRefs"] });
      if (p.tests.some((t) => t.required && t.result !== "PASS")) ctx.addIssue({ code: "custom", message: "PROMOTION_WITH_REQUIRED_TEST_NOT_PASSED", path: ["tests"] });
    }
    const touchesAuthority = p.changes.some((c) => (AUTHORITY_CHANGE_TARGETS as readonly string[]).includes(c.target));
    if (touchesAuthority && advanced.includes(p.state) && p.governanceReviewRef === null) {
      ctx.addIssue({ code: "custom", message: "AUTHORITY_CHANGE_WITHOUT_GOVERNANCE_REVIEW", path: ["governanceReviewRef"] });
    }
    // The governance review is a SEPARATE review: the record that approved the change cannot also
    // count as its governance review (no self-promotion of authority changes).
    if (touchesAuthority && p.governanceReviewRef !== null && p.reviewRefs.includes(p.governanceReviewRef)) {
      ctx.addIssue({ code: "custom", message: "GOVERNANCE_REVIEW_NOT_SEPARATE", path: ["governanceReviewRef"] });
    }
    if (touchesAuthority && p.authoredBy.kind === "optimizer") ctx.addIssue({ code: "custom", message: "OPTIMIZER_CANNOT_CHANGE_AUTHORITY", path: ["changes"] });
  });
export type ChangeProposal = z.infer<typeof ChangeProposal>;

/** Behaviours a canary may never vary (follow-on prompt section 18). */
export const CANARY_EXCLUDED_BEHAVIOURS = ["CRISIS_INSTRUCTIONS", "CONSENT_CONTROLS", "AUTHORITY_CONTROLS"] as const;

export const CanarySpec = z
  .strictObject({
    ...envelope(CANARY_SPEC_SCHEMA_VERSION, ["tenantId", "occurredAt", "expiresAt"], ["causationId"]),
    canaryId: opaqueIdWithPrefix("cny"),
    proposalId: opaqueIdWithPrefix("chp"),
    cohort: z.strictObject({
      cohortKey: z.string().regex(/^[a-z][a-z0-9_]{2,40}$/),
      intents: z.array(z.string().regex(/^[a-z_]{3,64}$/)).min(1).max(32),
      languages: z.array(z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/)).min(1).max(8),
      /** Exposure in basis points (0..10000) with stable, auditable assignment. */
      exposureBasisPoints: z.number().int().min(1).max(10_000),
      assignment: z.literal("STABLE_HASH"),
    }),
    sampleTarget: z.number().int().min(1).max(10_000_000),
    periodDays: z.number().int().min(1).max(90),
    errorBudget: z.strictObject({ metric: z.string().regex(/^[a-z][a-z0-9_.]{2,80}$/), maxRate: z.number().min(0).max(1) }),
    rollbackThresholds: z
      .array(z.strictObject({ metric: z.string().regex(/^[a-z][a-z0-9_.]{2,80}$/), comparator: z.enum(["GT", "GTE", "LT", "LTE"]), threshold: z.number().finite().min(-1e9).max(1e9) }))
      .min(1)
      .max(16),
    excludedBehaviours: z.array(z.enum(CANARY_EXCLUDED_BEHAVIOURS)).length(CANARY_EXCLUDED_BEHAVIOURS.length),
    /** Any critical privacy/authorization/clinical-boundary/effect failure rolls back immediately. */
    rollbackOnCriticalFailure: z.literal(true),
    signature: z.strictObject({
      signerRole: z.enum(["deployment_operator", "policy_approver"]),
      keyRef: z.string().regex(/^(arn:aws:kms:[A-Za-z0-9-]{1,32}:[0-9]{12}:key\/[A-Za-z0-9-]{1,128}|local-fixture:[a-z0-9][a-z0-9._/-]{0,127})$/),
      value: z.string().min(16).max(1024).regex(/^[A-Za-z0-9_-]+$/),
      signedAt: IsoDateTime,
    }),
  })
  .superRefine((c, ctx) => {
    if (!isAfter(c.expiresAt, c.occurredAt)) ctx.addIssue({ code: "custom", message: "CANARY_EXPIRY_NOT_AFTER_START", path: ["expiresAt"] });
    if (new Set(c.excludedBehaviours).size !== CANARY_EXCLUDED_BEHAVIOURS.length) ctx.addIssue({ code: "custom", message: "CANARY_MUST_EXCLUDE_PROTECTED_BEHAVIOURS", path: ["excludedBehaviours"] });
  });
export type CanarySpec = z.infer<typeof CanarySpec>;
