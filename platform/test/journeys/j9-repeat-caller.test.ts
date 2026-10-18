/**
 * [SPEC-16.journey-9] A repeat caller resumes an authorized open issue (SYNTHETIC client
 * Avery, LOCAL FIXTURE composition):
 *  1. first call: verified caller opens a support request linked to the account; the open
 *     issue is remembered (support memory, provenance-labelled, expiring);
 *  2. a second, UNVERIFIED call from the same (shared) phone hears no recap and learns nothing
 *     about the account or the issue (DATA-04, spec section 9);
 *  3. a third call, verified again, hears the short recap of the open issue instead of
 *     repeating the story.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CALLS } from "../../src/fixtures/synthetic-world.js";
import { sha256Hex } from "../../src/shared/canonical.js";
import { AVERY, createJourneyHarness } from "./harness.js";
import type { JourneyHarness } from "./harness.js";

let h: JourneyHarness;
beforeAll(async () => {
  h = await createJourneyHarness({ ingestKnowledge: false });
}, 180_000);
afterAll(async () => {
  await h?.close();
});

describe("[SPEC-16.journey-9] repeat caller resumes an authorized open issue", () => {
  it("[SPEC-16.journey-9][DATA-04][AUTH-01] open issue remembered; shared-phone unverified call gets no recap; verified repeat call hears the recap", async () => {
    // 1. First call: verified, opens a linked support request.
    const first = h.call();
    await first.start();
    await first.role("client");
    expect((await first.verify(AVERY, "avery.synthetic")).bound).toBe(true);
    const created = await first.tool("create_support_request", { issueCategory: "billing_question", linkToAccount: true, urgency: "STANDARD", language: "en" });
    expect(created.status).toBe("SUCCESS");
    expect(created.data).toMatchObject({ linkedToAccount: true, synchronization: "PENDING_SYNC" });
    const ref = (created.data?.request as { supportReference: string }).supportReference;
    expect(created.speech?.templateId).toBe("support_reference.pending_sync");
    expect((await first.end("FLOW_COMPLETED")).outcome).toBe("REQUEST_ACCEPTED");

    const memory = await h.q<{ kind: string; provenance: string; source_ref: string; expires_at: Date }>(
      "select kind, provenance, source_ref, expires_at from support_memory where subject_id = $1",
      [AVERY.subjectId],
    );
    expect(memory.length).toBeGreaterThanOrEqual(1);
    expect(memory.some((m) => m.kind === "OPEN_ISSUE")).toBe(true);
    expect(memory.every((m) => new Date(m.expires_at).getTime() > h.clock.now().getTime())).toBe(true);
    const [sr] = await h.q<{ subject_ref: string | null }>("select subject_ref from support_requests where reference_number = $1", [ref]);
    expect(sr?.subject_ref).toBe(AVERY.subjectId);

    h.clock.advanceMs(3_600_000);

    // 2. Shared phone, unverified: the same caller-id digest is a risk signal only (AUTH-01); no recap, no disclosure.
    const shared = h.call();
    const sharedStart = await shared.studio("POST", "/telephony/v1/calls", { callId: shared.callId, callerIdHash: sha256Hex(CALLS.repeat.callerIdE164), consent: shared.consent() }, false);
    expect(sharedStart.status).toBe(201);
    shared.sessionRef = sharedStart.body.sessionRef as string;
    await shared.role("client");
    const withheldBefore = h.c.metrics.counterValue("vsp_memory_recap_withheld_total");
    const status = await shared.tool("get_authorized_case_status", { supportReference: null });
    expect(status.status).toBe("POLICY_DENIED");
    expect(status.data ?? null).toBeNull();
    expect(status.speech).toBeNull();
    const byRef = await shared.tool("get_authorized_case_status", { supportReference: ref });
    expect(byRef.status).toBe("POLICY_DENIED");
    expect(JSON.stringify(shared.results)).not.toContain(ref);
    expect(shared.utterances()).toEqual([]);
    // The memory service itself withholds below A2 (and counts it), even if asked directly.
    const direct = await h.c.memory.recapFor({ tenantId: h.c.config.tenantId, subjectId: AVERY.subjectId, assurance: "A0", authorizedSubjectId: null, now: h.clock.now() });
    expect(direct).toEqual([]);
    expect(h.c.metrics.counterValue("vsp_memory_recap_withheld_total")).toBeGreaterThan(withheldBefore);
    expect((await shared.end("CALLER_HANGUP")).outcome).toBe("DECLINED_BY_POLICY");

    // 3. Verified repeat call: the short recap of the open issue.
    const repeat = h.call();
    await repeat.start();
    await repeat.role("client");
    expect((await repeat.verify(AVERY, "avery.synthetic")).bound).toBe(true);
    const recap = await repeat.tool("get_authorized_case_status", { supportReference: null });
    expect(recap.status).toBe("SUCCESS");
    expect(recap.data?.recapAvailable).toBe(true);
    expect(recap.speech?.templateId).toBe("case.recap_open_issue");
    // The recap is gate-rendered from the approved template (support reference spoken via its typed slot).
    const heard = repeat.render(recap);
    expect(typeof heard).toBe("string");
    expect((heard as string).length).toBeGreaterThan(0);
    expect(repeat.heard.at(-1)).toMatchObject({ templateId: "case.recap_open_issue" });
    expect(((recap.data?.cases as { caseRef: string }[]) ?? []).map((c) => c.caseRef)).toContain(ref);
    expect((await repeat.end("FLOW_COMPLETED")).outcome).toBe("INFORMATION_PROVIDED");
    await h.expectAuditChainIntact();
  }, 120_000);
});
