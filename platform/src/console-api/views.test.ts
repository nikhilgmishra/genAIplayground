import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CALLS, STAFF, TENANT_ID } from "../fixtures/synthetic-world.js";
import type { StaffRole } from "../protocol/index.js";
import { NEXT_STEP_CANARY, SUMMARY_CANARY } from "./fixtures/business-stubs.fixture.js";
import { createConsoleHarness, seedBudget, seedCallEvents, seedPendingAction, seedReleases, seedSafetyIncident } from "./fixtures/harness.fixture.js";
import type { ConsoleHarness } from "./fixtures/harness.fixture.js";

/** Keys that would carry caller words, recordings or other content; none may appear in any console response. */
const CONTENT_KEYS = /^(transcript|transcripts|utterance|utterances|text|words|speech|audio|recording|recordingUrl|summary|nextStep|body|content|excerpt|taskToken|token|sessionRef|vendorQueueRef|confirmation|providerIdempotencyKey)$/i;

function keysDeep(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) for (const v of value) keysDeep(v, out);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysDeep(v, out);
    }
  }
  return out;
}

const errorOf = (body: string): { reasonCode: string; retryable: boolean } => (JSON.parse(body) as { error: { reasonCode: string; retryable: boolean } }).error;
const AUDITOR_APPROVER = { staffId: "stf_synthAuditorApprove1", tenantId: TENANT_ID, displayLabel: "Synthetic Auditor Approver", roles: ["auditor", "policy_approver"] as StaffRole[], idpSubject: "workforce|synth-auditor-approver" };

let h: ConsoleHarness;
let releaseIds: { policyReleaseId: string; knowledgeReleaseId: string };
beforeAll(async () => {
  h = await createConsoleHarness({ extraStaff: [AUDITOR_APPROVER] });
  await seedCallEvents(h, CALLS.primary.callId);
  await seedPendingAction(h, { callId: CALLS.primary.callId, confirm: true });
  await seedSafetyIncident(h, CALLS.primary.callId);
  releaseIds = await seedReleases(h);
  await seedBudget(h);
});
afterAll(async () => {
  await h.close();
});

describe("call investigation read models (spec sections 13 and 16)", () => {
  it("[SPEC-16.console] the call timeline is derived from content-free audit metadata: no transcript or free-text field exists in the response", async () => {
    const supervisor = await h.token("supervisor");
    const transfer = await h.call("calls.transfer", { token: supervisor, params: { callId: CALLS.primary.callId }, body: { destinationId: "dst_support_general", reason: "CALLER_REQUESTED_HUMAN" } });
    expect(transfer.statusCode).toBe(200);
    h.supportRequests.seed({ referenceNumber: "SR-TRCE-KQ4M", callId: CALLS.primary.callId, now: h.clock.now() });

    const r = await h.call("calls.get", { token: supervisor, params: { callId: CALLS.primary.callId } });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body) as { contentAvailable: boolean; timeline: { kind: string }[]; controls: { join: { available: boolean; reasonCode: string } }; call: { safetyFlag: boolean; state: string } };
    expect(body.contentAvailable).toBe(false);
    expect(body.controls.join).toEqual({ available: false, reasonCode: "TALKDESK_CONTROL_UNAVAILABLE" });
    expect(body.call).toMatchObject({ safetyFlag: true, state: "IN_TRANSFER" });
    const kinds = new Set(body.timeline.map((e) => e.kind));
    for (const k of ["session", "tool_invocation", "policy_decision", "action", "transfer", "safety_event"]) expect(kinds, k).toContain(k);
    for (const k of kinds) expect(["session", "tool_invocation", "policy_decision", "action", "transfer", "safety_event", "support_request"]).toContain(k);
    for (const e of body.timeline as { kind: string; change?: string }[]) {
      if (e.kind === "session") expect(["STARTED", "ROLE_SELECTED", "CONSENT_RECORDED", "VERIFIED", "GENERATION_CHANGED", "REVOKED", "ENDED"]).toContain(e.change);
      else expect(e.change).toBeUndefined();
    }
    const keys = [...keysDeep(body)];
    expect(keys.filter((k) => CONTENT_KEYS.test(k))).toEqual([]);
    expect(r.body).not.toContain(SUMMARY_CANARY);
    expect(r.body).not.toContain(CALLS.primary.callerIdE164);
  });

  it("[SPEC-13.console] reading a call investigation is audited before data is returned; without durable audit nothing is returned", async () => {
    const token = await h.token("safety");
    const before = await h.db.query<{ n: number }>("select count(*)::int as n from audit_outbox where action = 'console.calls.get' and outcome = 'ALLOWED' and call_id = $1", [CALLS.primary.callId]);
    expect((await h.call("calls.get", { token, params: { callId: CALLS.primary.callId } })).statusCode).toBe(200);
    const after = await h.db.query<{ n: number; actor: string }>(
      "select count(*)::int as n, max(event->>'actorRef') as actor from audit_outbox where action = 'console.calls.get' and outcome = 'ALLOWED' and call_id = $1",
      [CALLS.primary.callId],
    );
    expect(after.rows[0]?.n).toBe((before.rows[0]?.n ?? 0) + 1);
    await h.db.exec("revoke insert on audit_outbox from app_console");
    try {
      for (const req of [
        h.call("calls.get", { token, params: { callId: CALLS.primary.callId } }),
        h.call("safetyEvents.list", { token }),
        h.call("supportRequests.trace", { token, params: { ref: "SR-TRCE-KQ4M" } }),
      ]) {
        const r = await req;
        expect(r.statusCode).toBe(503);
        expect(errorOf(r.body).reasonCode).toBe("AUDIT_UNAVAILABLE");
        expect(r.body).not.toContain(CALLS.primary.callId);
      }
    } finally {
      await h.db.exec("grant insert on audit_outbox to app_console");
    }
  });

  it("[SAFE-05] a transfer goes only to an allowlisted destination; a dial target or unknown destination is refused; success is never claimed", async () => {
    const token = await h.token("agent");
    for (const destinationId of ["+15555550123", "dst_not_in_allowlist", "15555550123"]) {
      const r = await h.call("calls.transfer", { token, params: { callId: CALLS.primary.callId }, body: { destinationId, reason: "CALLER_REQUESTED_HUMAN" } });
      expect(r.statusCode, destinationId).toBe(400);
      expect(["DESTINATION_NOT_ALLOWLISTED", "VALIDATION_FAILED"], destinationId).toContain(errorOf(r.body).reasonCode);
    }
    await seedCallEvents(h, CALLS.repeat.callId);
    const ok = await h.call("calls.transfer", { token, params: { callId: CALLS.repeat.callId }, body: { destinationId: "dst_support_general", reason: "CALLER_REQUESTED_HUMAN" } });
    expect(ok.statusCode).toBe(200);
    const body = JSON.parse(ok.body) as { state: string; auditEventId: string; transferId: string };
    expect(["REQUESTED", "QUEUED"]).toContain(body.state);
    const ev = await h.db.query<{ action: string; outcome: string }>("select action, outcome from audit_outbox where event_id = $1", [body.auditEventId]);
    expect(ev.rows[0]).toEqual({ action: "console.calls.transfer", outcome: "SUCCEEDED" });
    const intent = await h.db.query<{ n: number }>("select count(*)::int as n from audit_outbox where action = 'console.calls.transfer' and outcome = 'PENDING' and call_id = $1", [CALLS.repeat.callId]);
    expect(intent.rows[0]?.n).toBe(1);
  });

  it("[SAFE-02] safety events are content-free (rule ids and timings only), visible to safety responders, and every read is audited", async () => {
    const r = await h.call("safetyEvents.list", { token: await h.token("safety") });
    expect(r.statusCode).toBe(200);
    const events = (JSON.parse(r.body) as { events: Record<string, unknown>[] }).events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ callId: CALLS.primary.callId, route: "SAFETY_PRIORITY_HUMAN", signalSources: ["HUMAN_INTERVENTION"], latencyMs: 400, withinTarget: true, outcome: "IN_PROGRESS", auditStatus: "RECORDED" });
    expect([...keysDeep(events)].filter((k) => CONTENT_KEYS.test(k))).toEqual([]);
    const audited = await h.db.query<{ n: number }>("select count(*)::int as n from audit_outbox where action = 'console.safety_events.list' and outcome = 'ALLOWED'");
    expect(audited.rows[0]?.n).toBeGreaterThan(0);
    const overview = JSON.parse((await h.call("overview", { token: await h.token("safety") })).body) as { openSafetyEvents: number; liveSessions: { safetyActive: number } };
    expect(overview.openSafetyEvents).toBe(1);
    expect(overview.liveSessions.safetyActive).toBeGreaterThan(0);
  });

  it("[SPEC-13.console] a support request trace returns opaque references and states only, never the summary or next step, and is audited", async () => {
    const r = await h.call("supportRequests.trace", { token: await h.token("agent"), params: { ref: "SR-TRCE-KQ4M" } });
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain(SUMMARY_CANARY);
    expect(r.body).not.toContain(NEXT_STEP_CANARY);
    const body = JSON.parse(r.body) as { supportRequest: { referenceNumber: string; restricted: boolean }; sync: { salesforceCaseId: string | null; state: string } };
    expect(body.supportRequest).toMatchObject({ referenceNumber: "SR-TRCE-KQ4M", restricted: false });
    expect(body.sync).toMatchObject({ salesforceCaseId: null, state: "PENDING" });
    expect([...keysDeep(body)].filter((k) => CONTENT_KEYS.test(k))).toEqual([]);
    const audited = await h.db.query<{ n: number }>("select count(*)::int as n from audit_outbox where action = 'console.support_requests.trace' and outcome = 'ALLOWED'");
    expect(audited.rows[0]?.n).toBe(1);
    expect((await h.call("supportRequests.trace", { token: await h.token("agent"), params: { ref: "SR-ZZZZ-ZZZZ" } })).statusCode).toBe(404);
  });
});

describe("release review, budgets, destinations and audit search", () => {
  it("[OPS-06] releases show the loaded policy bundle digest and knowledge snapshot with held items; visibility follows the reviewer roles", async () => {
    const approver = JSON.parse((await h.call("releases.list", { token: await h.token("policyApprover") })).body) as { releases: { kind: string; digest: string; approvalStatus: string; heldItems?: { status: string }[] }[] };
    const policy = approver.releases.find((r) => r.kind === "POLICY_BUNDLE");
    expect(policy).toMatchObject({ digest: h.policy.bundleDigest, approvalStatus: "MISSING" });
    const editor = JSON.parse((await h.call("releases.list", { token: await h.token("knowledgeEditor") })).body) as { releases: { kind: string; heldItems?: { status: string; reasonCodes: string[] }[] }[] };
    expect(editor.releases.map((r) => r.kind)).toEqual(["KNOWLEDGE_SNAPSHOT"]);
    expect(editor.releases[0]?.heldItems?.map((i) => i.status)).toEqual(["HELD_FOR_REVIEW", "HELD_FOR_REVIEW"]);
    expect(JSON.stringify(editor)).not.toContain("different steps to reschedule");
  });

  it("[SPEC-16.console] a release review records an opinion, never an approval record; self-review and the wrong reviewer role are refused", async () => {
    const r = await h.call("releases.review", { token: await h.token("policyApprover"), params: { releaseId: releaseIds.policyReleaseId }, body: { decision: "NO_OBJECTION", reason: "DIFF_REVIEWED" } });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body) as { reviewId: string; approvalRecordCreated: boolean; auditEventId: string };
    expect(body.approvalRecordCreated).toBe(false);
    const row = await h.db.query<{ approval_record: boolean; audit_event_id: string; reviewer_role: string }>("select approval_record, audit_event_id, reviewer_role from console_release_reviews where review_id = $1", [body.reviewId]);
    expect(row.rows[0]).toEqual({ approval_record: false, audit_event_id: body.auditEventId, reviewer_role: "policy_approver" });
    const listed = JSON.parse((await h.call("releases.list", { token: await h.token("auditor") })).body) as { releases: { releaseId: string; reviews: unknown[]; approvalStatus: string }[] };
    expect(listed.releases.find((x) => x.releaseId === releaseIds.policyReleaseId)).toMatchObject({ approvalStatus: "MISSING", reviews: [expect.objectContaining({ decision: "NO_OBJECTION" })] });

    const self = await h.call("releases.review", { token: await h.token("knowledgeEditor"), params: { releaseId: releaseIds.knowledgeReleaseId }, body: { decision: "NO_OBJECTION", reason: "TESTS_REVIEWED" } });
    expect(self.statusCode).toBe(403);
    expect(errorOf(self.body).reasonCode).toBe("SELF_REVIEW_FORBIDDEN");
    const wrongRole = await h.call("releases.review", { token: await h.token("policyApprover"), params: { releaseId: releaseIds.knowledgeReleaseId }, body: { decision: "NO_OBJECTION", reason: "TESTS_REVIEWED" } });
    expect(wrongRole.statusCode).toBe(403);
    expect(errorOf(wrongRole.body).reasonCode).toBe("STAFF_ROLE_NOT_PERMITTED");
    const tainted = await h.call("releases.review", { token: await h.tokenForSubject(AUDITOR_APPROVER.idpSubject), params: { releaseId: releaseIds.policyReleaseId }, body: { decision: "CHANGES_REQUESTED", reason: "MISSING_EVIDENCE" } });
    expect(tainted.statusCode).toBe(403);
    expect(errorOf(tainted.body).reasonCode).toBe("AUDITOR_READ_ONLY");
    // Even a direct insert bypassing the API cannot record a self-review.
    await expect(
      h.db.tx(
        (tx) =>
          tx.query(
            `insert into console_release_reviews (review_id, tenant_id, release_id, release_digest, reviewer_staff_id, reviewer_role, decision, reason, reviewed_at, audit_event_id)
             select 'rvw_synthSelfReview000001', tenant_id, release_id, digest, submitted_by, 'knowledge_editor', 'NO_OBJECTION', 'DIFF_REVIEWED', now(), 'aud_synthAuditEvent000001'
               from console_release_submissions where release_id = $1`,
            [releaseIds.knowledgeReleaseId],
          ),
        { role: "app_console", rls: { tenantId: TENANT_ID, actorId: STAFF.knowledgeEditor.staffId } },
      ),
    ).rejects.toThrow();
  });

  it("[SPEC-12.budgets] budgets come from BudgetService with the safety reserve and metering-delay projection; figures are labelled illustrative", async () => {
    const r = JSON.parse((await h.call("budgets.list", { token: await h.token("supervisor") })).body) as { figuresIllustrative: boolean; budgets: Record<string, unknown>[] };
    expect(r.figuresIllustrative).toBe(true);
    expect(r.budgets).toHaveLength(1);
    expect(r.budgets[0]).toMatchObject({ limitUsd: 100, safetyReserveUsd: 20, spentUsd: 12.5, nonSafetySpentUsd: 12.5, safetyReserveRemainingUsd: 20, meteringDelayMinutes: 60, exhausted: false, approvedBy: null });
    expect(r.budgets[0]?.projectedUsd as number).toBeGreaterThanOrEqual(12.5);
  });

  it("[SAFE-05] destinations are trusted configuration; vendor queue references are never returned", async () => {
    const r = await h.call("destinations.list", { token: await h.token("securityAdmin") });
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain("TALKDESK_QUEUE_PLACEHOLDER");
    const body = JSON.parse(r.body) as { source: string; destinations: { vendorQueueConfigured: boolean }[] };
    expect(body.source).toBe("trusted_configuration");
    expect(body.destinations.every((d) => d.vendorQueueConfigured === false)).toBe(true);
  });

  it("[SPEC-16.console] audit search is metadata only, never raw evidence pointers or session references, and the search itself is audited", async () => {
    const r = await h.call("audit.search", { token: await h.token("auditor"), query: { callId: CALLS.primary.callId, limit: "50" } });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body) as { events: Record<string, unknown>[]; searchAuditEventId: string; limit: number };
    expect(body.events.length).toBeGreaterThan(0);
    expect(body.events.every((e) => e.callId === CALLS.primary.callId && typeof e.evidencePointerCount === "number")).toBe(true);
    expect([...keysDeep(body)].some((k) => ["evidencePointers", "sessionRef", "idempotencyKey", "versions"].includes(k))).toBe(false);
    const ev = await h.db.query<{ action: string; actor: string }>("select action, event->>'actorRef' as actor from audit_outbox where event_id = $1", [body.searchAuditEventId]);
    expect(ev.rows[0]).toEqual({ action: "console.audit.search", actor: STAFF.auditor.staffId });
    const freeText = await h.call("audit.search", { token: await h.token("auditor"), query: { limit: "50", q: "avery" } });
    expect(freeText.statusCode).toBe(400);
  });

  it("[AUTH-02] the OIDC code exchange is BLOCKED (no workforce client) and refuses rather than inventing an IdP flow", async () => {
    const r = await h.call("auth.oidcExchange", { body: { code: "synthetic-code-0000", codeVerifier: "v".repeat(43), redirectUri: "https://console.example.com/auth/callback", nonce: "n".repeat(16) } });
    expect(r.statusCode).toBe(503);
    expect(errorOf(r.body)).toMatchObject({ reasonCode: "OIDC_NOT_CONFIGURED", retryable: false });
  });
});

describe("strict response validation", () => {
  it("[SPEC-16.console] a dependency that returns an extra (content) field cannot leak it: the response is refused, not passed through", async () => {
    const leaky = await createConsoleHarness({
      patchDeps: (d) => ({
        ...d,
        dependencyHealth: async () => [{ dependencyId: "talkdesk-telephony", kind: "local_fixture", status: "HEALTHY", circuit: "CLOSED", reasonCode: null, checkedAt: null, transcript: "SYNTHETIC-TRANSCRIPT-CANARY" } as never],
      }),
    });
    try {
      const r = await leaky.call("overview", { token: await leaky.token("supervisor") });
      expect(r.statusCode).toBe(500);
      expect(errorOf(r.body).reasonCode).toBe("RESPONSE_SCHEMA_VIOLATION");
      expect(r.body).not.toContain("SYNTHETIC-TRANSCRIPT-CANARY");
      expect(JSON.stringify(leaky.logs)).not.toContain("SYNTHETIC-TRANSCRIPT-CANARY");
    } finally {
      await leaky.close();
    }
  });
});
