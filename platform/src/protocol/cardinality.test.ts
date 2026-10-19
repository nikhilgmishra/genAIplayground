/**
 * Record cardinality (follow-on prompt section 4; FO-04-45, FO-04-46): one person can hold several
 * roles, one call can carry several cases, several calls can share one case, and person, actor,
 * organization/delegation, call session, turn, case, action and durable task stay separate records.
 *
 * The contract checks are in-memory zod; the "one call, many cases" check also runs the REAL
 * support-request service over the REAL gateway tool pipeline and embedded PostgreSQL (PGlite,
 * single connection) with the LOCAL business harness (SYNTHETIC data only).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBusinessHarness, expectDone, type BusinessHarness } from "../business/testing/harness.js";
import { AuthContext } from "./auth.js";
import { CaseLink } from "./effects.js";
import { FOLLOWON_CONTRACTS } from "./followon.js";
import { activeAssignments, PersonRoleAssignment } from "./identity-link.js";
import { TurnEnvelope } from "./media.js";
import { SupportRequest } from "./support.js";
import * as F from "./fixtures/contracts.fixture.js";

describe("record cardinality", () => {
  it("[FO-04-46] one person can hold several roles; each assignment is its own record and a session still selects exactly one role", () => {
    const assignments = [
      F.personRoleAssignment("client", "Client0001"),
      F.personRoleAssignment("practice_staff", "Staff00001", "org_synthPracticeNorth01"),
      F.personRoleAssignment("personal_representative", "Rep0000001"),
    ].map((a) => PersonRoleAssignment.parse(a));
    const now = new Date(F.SYNTH.t0);
    const active = activeAssignments(assignments, F.SYNTH.tenantId, F.SYNTH.personRef, now);
    expect(active.map((a) => a.role)).toEqual(["client", "practice_staff", "personal_representative"]);
    expect(new Set(active.map((a) => a.actorRef)).size).toBe(3);
    expect(activeAssignments([{ ...assignments[0]!, revoked: true }, assignments[1]!], F.SYNTH.tenantId, F.SYNTH.personRef, now).map((a) => a.role)).toEqual(["practice_staff"]);
    expect(PersonRoleAssignment.safeParse({ ...F.personRoleAssignment("provider", "Prov000001"), organizationRef: null }).success).toBe(false);
    expect(AuthContext.shape.selectedRole.safeParse(["client", "practice_staff"]).success).toBe(false);
    expect(AuthContext.shape.selectedRole.safeParse("client").success).toBe(true);
  });

  it("[FO-04-46] many calls can share one case: a support request carries up to 32 source calls, and each call links the same case", () => {
    const calls = Array.from({ length: 32 }, (_, i) => `cal_synthCallShared${String(i).padStart(5, "0")}`);
    expect(SupportRequest.shape.sourceCallIds.safeParse(calls).success).toBe(true);
    expect(SupportRequest.shape.sourceCallIds.safeParse([...calls, "cal_synthCallShared99999"]).success).toBe(false);
    expect(SupportRequest.shape.sourceCallIds.safeParse([]).success).toBe(false);
    const first = CaseLink.parse(F.caseLink(F.SYNTH.caseId, F.SYNTH.interactionId));
    const repeat = CaseLink.parse({ ...F.caseLink(F.SYNTH.caseId, F.SYNTH.secondInteractionId), linkId: "csl_synthRepeatCallLink01" });
    expect(new Set([first.caseId, repeat.caseId]).size).toBe(1);
    expect(new Set([first.interactionId, repeat.interactionId]).size).toBe(2);
    const turnA = TurnEnvelope.parse({ ...F.turnEnvelope(), caseId: F.SYNTH.caseId });
    const turnB = TurnEnvelope.parse({ ...F.turnEnvelope(), interactionId: F.SYNTH.secondInteractionId, caseId: F.SYNTH.caseId });
    expect(turnA.caseId).toBe(turnB.caseId);
  });

  it("[FO-04-46] one call can carry several cases at the contract level: distinct case links share the interaction", () => {
    const a = CaseLink.parse(F.caseLink(F.SYNTH.caseId, F.SYNTH.interactionId));
    const b = CaseLink.parse({ ...F.caseLink(F.SYNTH.secondCaseId, F.SYNTH.interactionId), externalCaseRef: "500Ax00000SynthBBB" });
    expect(a.interactionId).toBe(b.interactionId);
    expect(a.caseId).not.toBe(b.caseId);
  });

  it("[FO-04-45] person, actor, organization/delegation, call session, turn, case, action and durable task are separate contracts with separate identifiers", () => {
    const separate = ["IdentityLink", "AuthContext", "CallBinding", "TurnEnvelope", "SupportRequest", "CaseLink", "PreparedAction", "ActionGrant", "HumanTask"] as const;
    const files = new Set(separate.map((n) => FOLLOWON_CONTRACTS[n].schemaKey));
    expect(files.size).toBe(separate.length);
    expect(Object.keys(PersonRoleAssignment.shape)).toEqual(expect.arrayContaining(["personRef", "actorRef", "organizationRef", "delegations"]));
    expect(Object.keys(TurnEnvelope.shape)).not.toContain("summary");
  });
});

describe("one call, many cases over the real support-request service (PGlite, single connection)", () => {
  let h: BusinessHarness;
  beforeEach(async () => {
    h = await createBusinessHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("[FO-04-46] two issues in one call create two separate support requests, both attributed to the same call", async () => {
    const { ctx } = await h.startCall();
    const create = async (issueCategory: string, turnId: string) => {
      const r = expectDone(await h.invoke("create_support_request", ctx, { issueCategory, linkToAccount: false, urgency: "STANDARD", language: "en" }, { turnId }));
      if (r.outcome.status !== "SUCCESS") throw new Error(`create ${r.outcome.status}`);
      return (r.outcome.data as { request: { supportReference: string } }).request.supportReference;
    };
    const refA = await create("billing_question", "turn_synthIssueOne01");
    const refB = await create("appointment", "turn_synthIssueTwo01");
    expect(refA).not.toBe(refB);
    const a = await h.services.support.getByReference(ctx.tenantId, refA);
    const b = await h.services.support.getByReference(ctx.tenantId, refB);
    expect(SupportRequest.parse(a).sourceCallIds).toEqual([ctx.callId]);
    expect(SupportRequest.parse(b).sourceCallIds).toEqual([ctx.callId]);
    expect(a?.supportRequestId).not.toBe(b?.supportRequestId);
    expect(a?.issueExternalId).not.toBe(b?.issueExternalId);
    expect(a?.interactionExternalId).toBe(b?.interactionExternalId);
  });
});
