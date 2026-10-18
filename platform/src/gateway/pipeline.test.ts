/**
 * ToolPipeline tests, including the direct hostile-call suite (spec section 14:
 * "Test the gateway directly with hostile tool calls even if the conversational
 * prompt would never generate them"). Real policy bundle, PGlite, PgAuditWriter,
 * identity session service; LOCAL FIXTURE tools and adapters; SYNTHETIC data.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CALLS, OTHER_TENANT_ID, PEOPLE, TENANT_ID } from "../fixtures/synthetic-world.js";
import { FailClosedPolicyEngine } from "../policy/engine.js";
import { sessionConfig } from "../identity/config.js";
import { TrustedSessionService } from "../identity/session-service.js";
import { consentGranted, mcp, telephony, LOCAL_POLICY_VERSION } from "../identity/identity-harness.fixture.js";
import { sessionBindingRefFor } from "../identity/keys.js";
import { ToolResult } from "../protocol/index.js";
import { createGatewayHarness, ManualTimersFixture, ThrowingPolicyEngineFixture } from "./fixtures/harness.fixture.js";
import type { GatewayHarness } from "./fixtures/harness.fixture.js";

let h: GatewayHarness;
afterEach(async () => {
  await h?.close();
});

const header = (sessionRef: string) => ({ sessionRefHeader: sessionRef });

describe("ToolPipeline — allowed paths", () => {
  beforeEach(async () => {
    h = await createGatewayHarness();
  });

  it("[AUTH-02][SPEC-8.tool-pipeline] a verified client reads own appointments; field mask strips non-masked fields; speech is bound to turn, generation and decision", async () => {
    const { sessionRef } = await h.verifiedAveryCall();
    const r = await h.call({ name: "fixture_get_appointments", turnId: "turn_fixtureTurn01" }, header(sessionRef));
    expect(r.status).toBe("SUCCESS");
    expect(ToolResult.safeParse(r).success).toBe(true);
    if (r.status !== "SUCCESS") return;
    const rows = r.data.appointments as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(["appointmentId", "modality", "providerDisplayName", "startsAt", "status", "timeZone"]);
    expect(rows[0]).not.toHaveProperty("subjectId");
    expect(rows[0]).not.toHaveProperty("version");
    expect(r.data.count).toBe(1);
    expect(r.speech?.turnId).toBe("turn_fixtureTurn01");
    expect(r.speech?.sessionGeneration).toBe(r.sessionGeneration);
    expect(r.speech?.authorizationRef).toBe(r.policyDecisionId);
    expect(r.localFixture).toBe(true);
    expect(r.auditEventId).not.toBeNull();
  });

  it("[OPS-01][DATA-01] every invocation is audited as tool.invoke with the non-bearer binding ref, never the bearer session ref", async () => {
    const { sessionRef } = await h.verifiedAveryCall();
    await h.call({ name: "fixture_get_appointments" }, header(sessionRef));
    await h.call({ name: "fixture_get_appointments", arguments: { subjectId: PEOPLE.blake.subjectId } }, header(sessionRef));
    await h.call({ name: "no_such_tool" }, header(sessionRef));
    const rows = (await h.auditRows()).filter((r) => r.action === "tool.invoke");
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.outcome)).toEqual(["SUCCEEDED", "FAILED", "FAILED"]);
    const serialized = JSON.stringify(rows.map((r) => r.event));
    expect(serialized).not.toContain(sessionRef);
    expect(rows[0]?.session_ref).toBe(sessionBindingRefFor(sessionRef));
    expect(serialized).toContain("db://tool_catalog/fixture_get_appointments/1.0.0");
    expect(JSON.stringify(h.records)).not.toContain(sessionRef);
  });

  it("[SPEC-13.metrics] tool calls are counted by tool and status with allowlisted labels", async () => {
    const { sessionRef } = await h.verifiedAveryCall();
    await h.call({ name: "fixture_get_appointments" }, header(sessionRef));
    await h.call({ name: "fixture_public_faq", arguments: { topic: "portal_login" } }, header(sessionRef));
    expect(h.metrics.counterValue("vsp_tool_calls_total", { tool: "fixture_get_appointments", status: "SUCCESS" })).toBe(1);
    expect(h.metrics.counterValue("vsp_tool_calls_total", { tool: "fixture_public_faq", status: "SUCCESS" })).toBe(1);
    expect(h.metrics.observations("vsp_tool_latency_ms", { tool: "fixture_public_faq" })).toHaveLength(1);
  });

  it("[SPEC-8.tool-pipeline] MCP calls carry no version: the single pinned version applies; HTTP calls name it", async () => {
    const { sessionRef } = await h.startCall();
    const viaMcp = await h.call({ name: "fixture_public_faq", version: null, arguments: { topic: "portal_login" } }, header(sessionRef));
    const viaHttp = await h.call({ name: "fixture_public_faq", version: "1.0.0", arguments: { topic: "portal_login" } }, { ...header(sessionRef), kind: "http" });
    expect(viaMcp.status).toBe("SUCCESS");
    expect(viaHttp.status).toBe("SUCCESS");
    expect(viaMcp.tool).toEqual({ name: "fixture_public_faq", version: "1.0.0" });
  });
});

describe("ToolPipeline — hostile tool calls (spec section 14)", () => {
  beforeEach(async () => {
    h = await createGatewayHarness();
  });

  it("[AUTH-03][SPEC-14.hostile] forged identity fields in arguments are rejected before any session or policy work", async () => {
    const { sessionRef } = await h.startCall();
    for (const args of [
      { subjectId: PEOPLE.blake.subjectId },
      { assurance: "A3" },
      { actorId: PEOPLE.avery.actorId },
      { selectedRole: "provider" },
      { consent: { recording: "GRANTED" } },
      { permittedScopes: ["appointment:read"] },
      { nested: { deeper: [{ organizationId: "org_synthPracticeNorth1" }] } },
      { tenantId: OTHER_TENANT_ID },
    ]) {
      const r = await h.call({ name: "fixture_get_appointments", arguments: args }, header(sessionRef));
      expect(r.status).toBe("PERMANENT_FAILURE");
      if (r.status === "PERMANENT_FAILURE") expect(r.reasonCode).toBe("IDENTITY_FIELD_IN_ARGUMENTS");
      expect(r.policyDecisionId).toBeNull();
    }
    expect(h.faults.executions).toBe(0);
  });

  it("[SPEC-8.tool-schema] unknown tool names and unknown versions are rejected (UNKNOWN_TOOL_VERSION) without echoing the requested name", async () => {
    const { sessionRef } = await h.startCall();
    const a = await h.call({ name: "fixture_get_appointments", version: "9.9.9" }, { ...header(sessionRef), kind: "http" });
    const b = await h.call({ name: "export_all_records" }, header(sessionRef));
    const c = await h.call({ name: "rm -rf /; drop table" }, header(sessionRef));
    for (const r of [a, b, c]) {
      expect(r.status).toBe("PERMANENT_FAILURE");
      if (r.status === "PERMANENT_FAILURE") expect(r.reasonCode).toBe("UNKNOWN_TOOL_VERSION");
      expect(r.tool).toEqual({ name: "unknown_tool", version: "0.0.0" });
    }
  });

  it("[SPEC-8.tool-schema] oversized input is rejected by the byte bound; unknown fields and wrong types by the strict schema, without echoing values", async () => {
    const { sessionRef } = await h.startCall();
    const big = await h.call({ name: "fixture_public_faq", arguments: { topic: "portal_login", pad: "x".repeat(500) } }, header(sessionRef));
    expect(big.status === "PERMANENT_FAILURE" && big.reasonCode).toBe("ARGUMENTS_TOO_LARGE");
    const extra = await h.call({ name: "fixture_public_faq", arguments: { topic: "portal_login", note: "Avery 1990-01-01" } }, header(sessionRef));
    expect(extra.status === "PERMANENT_FAILURE" && extra.reasonCode).toBe("INVALID_ARGUMENTS");
    const wrongEnum = await h.call({ name: "fixture_public_faq", arguments: { topic: "anything" } }, header(sessionRef));
    expect(wrongEnum.status === "PERMANENT_FAILURE" && wrongEnum.reasonCode).toBe("INVALID_ARGUMENTS");
    const notObject = await h.call({ name: "fixture_public_faq", arguments: ["portal_login"] }, header(sessionRef));
    expect(notObject.status === "PERMANENT_FAILURE" && notObject.reasonCode).toBe("INVALID_ARGUMENTS");
    const all = JSON.stringify([big, extra, wrongEnum, notObject]) + JSON.stringify(await h.auditRows()) + JSON.stringify(h.records);
    expect(all).not.toContain("Avery 1990-01-01");
    expect(all).not.toContain("xxxxxxxxxx");
  });

  it("[AUTH-04] an expired session fails closed for protected tools even though the KV item still exists", async () => {
    const { sessionRef } = await h.verifiedAveryCall();
    h.identity.clock.advanceSeconds(7201);
    const r = await h.call({ name: "fixture_get_appointments" }, header(sessionRef));
    expect(r.status).toBe("POLICY_DENIED");
    if (r.status === "POLICY_DENIED") expect(r.reasonCode).toBe("SESSION_EXPIRED");
    expect(h.faults.executions).toBe(0);
  });

  it("[AUTH-04] revoked and ended sessions fail closed", async () => {
    const a = await h.verifiedAveryCall(CALLS.primary.callId);
    await h.identity.sessions.revoke(a.sessionRef, "SAFETY_TEST_REVOKE");
    const revoked = await h.call({ name: "fixture_get_appointments" }, header(a.sessionRef));
    expect(revoked.status === "POLICY_DENIED" && revoked.reasonCode).toBe("SESSION_REVOKED");
    const b = await h.verifiedAveryCall(CALLS.concurrent.callId);
    await h.identity.sessions.endCall(b.sessionRef, telephony());
    const ended = await h.call({ name: "fixture_get_appointments" }, header(b.sessionRef));
    expect(ended.status === "POLICY_DENIED" && ended.reasonCode).toBe("SESSION_ENDED");
  });

  it("[AUTH-05][SPEC-14.cross-tenant] a session created for another tenant is not resolvable by this gateway", async () => {
    const other = new TrustedSessionService({
      kv: h.identity.kv,
      clock: h.identity.clock,
      config: sessionConfig({ tenantId: OTHER_TENANT_ID, environment: "local", policyVersion: LOCAL_POLICY_VERSION }),
    });
    const started = await other.startCall({ integration: telephony({ tenantId: OTHER_TENANT_ID }), callId: CALLS.primary.callId, callerIdHash: null, consent: consentGranted(h.identity.clock.now().toISOString()) });
    const r = await h.call({ name: "fixture_public_faq", arguments: { topic: "portal_login" } }, header(started.sessionRef));
    expect(r.status === "POLICY_DENIED" && r.reasonCode).toBe("SESSION_TENANT_MISMATCH");
    const cross = await h.call({ name: "fixture_public_faq", arguments: { topic: "portal_login" } }, header(started.sessionRef), mcp({ tenantId: OTHER_TENANT_ID }));
    expect(cross.status === "POLICY_DENIED" && cross.reasonCode).toBe("INTEGRATION_NOT_PERMITTED");
  });

  it("[AUTH-07][SPEC-14.session-fixation] another call's session reference is rejected when the trusted binding names the current call", async () => {
    const first = await h.verifiedAveryCall(CALLS.primary.callId);
    await h.startCall(CALLS.concurrent.callId);
    const r = await h.call({ name: "fixture_get_appointments" }, { sessionRefHeader: first.sessionRef, interactionIdHeader: CALLS.concurrent.callId });
    expect(r.status === "POLICY_DENIED" && r.reasonCode).toBe("SESSION_CALL_MISMATCH");
  });

  it("[AUTH-07] a superseded session (second call start for the same call) is revoked and fails closed", async () => {
    const first = await h.verifiedAveryCall(CALLS.primary.callId);
    await h.startCall(CALLS.primary.callId);
    const r = await h.call({ name: "fixture_get_appointments" }, header(first.sessionRef));
    expect(r.status === "POLICY_DENIED" && r.reasonCode).toBe("SESSION_REVOKED");
  });

  it("[AUTH-02][AUTH-01] an unverified (A0) caller is denied a protected read by policy, regardless of any client-side gate", async () => {
    const { sessionRef } = await h.startCall();
    const r = await h.call({ name: "fixture_get_appointments" }, header(sessionRef));
    expect(r.status).toBe("POLICY_DENIED");
    expect(r.policyDecisionId).not.toBeNull();
    expect(h.faults.executions).toBe(0);
  });

  it("[AUTH-03] the session reference is taken only from the trusted header, never from arguments, in trusted_header mode", async () => {
    const { sessionRef } = await h.verifiedAveryCall();
    const r = await h.call({ name: "fixture_get_appointments", arguments: { sessionRef } }, {});
    expect(r.status).toBe("PERMANENT_FAILURE");
    if (r.status === "PERMANENT_FAILURE") expect(r.reasonCode).toBe("IDENTITY_FIELD_IN_ARGUMENTS");
    const noHeader = await h.call({ name: "fixture_get_appointments" }, {});
    expect(noHeader.status === "POLICY_DENIED" && noHeader.reasonCode).toBe("SESSION_REF_MISSING");
  });

  it("[SAFE-05][SPEC-14.hostile] model-supplied destination numbers or queues are not accepted by the human-route tool", async () => {
    const { sessionRef } = await h.startCall();
    for (const args of [
      { reason: "CALLER_REQUESTED_HUMAN", language: "en", destination: "+15555550199" },
      { reason: "CALLER_REQUESTED_HUMAN", language: "en", destinationId: "dst_safety_priority" },
      { reason: "CALLER_REQUESTED_HUMAN", language: "en", queue: "sip:attacker@example.invalid" },
    ]) {
      const r = await h.call({ name: "fixture_request_human", arguments: args }, header(sessionRef));
      expect(r.status === "PERMANENT_FAILURE" && r.reasonCode).toBe("INVALID_ARGUMENTS");
    }
    expect(h.faults.effects).not.toContain("human_requested");
    expect(JSON.stringify(await h.auditRows())).not.toContain("5555550199");
  });

  it("[SPEC-8.output-schema][SPEC-14.hostile] output with unexpected fields fails closed (read: PERMANENT_FAILURE; consequential: UNKNOWN_OUTCOME) and is audited", async () => {
    const { sessionRef } = await h.verifiedAveryCall();
    h.faults.mode = "extra_field";
    const read = await h.call({ name: "fixture_get_appointments" }, header(sessionRef));
    expect(read.status === "PERMANENT_FAILURE" && read.reasonCode).toBe("OUTPUT_SCHEMA_VIOLATION");
    expect(JSON.stringify(read)).not.toContain("unexpected dependency field");
    const rows = await h.auditRows();
    expect(rows.at(-1)?.reason_code).toBe("OUTPUT_SCHEMA_VIOLATION");
  });

  it("[AUTH-02][SPEC-14.policy-failure] a policy engine that errors or cannot load denies every protected tool", async () => {
    await h.close();
    for (const policy of [new ThrowingPolicyEngineFixture(), new FailClosedPolicyEngine("POLICY_BUNDLE_NOT_FOUND")]) {
      h = await createGatewayHarness({ policy });
      const { sessionRef } = await h.verifiedAveryCall();
      const r = await h.call({ name: "fixture_get_appointments" }, header(sessionRef));
      expect(r.status).toBe("POLICY_DENIED");
      if (r.status === "POLICY_DENIED") expect(r.reasonCode).toBe("POLICY_ENGINE_ERROR");
      expect(h.faults.executions).toBe(0);
      await h.close();
    }
    h = await createGatewayHarness();
  });

  it("[OPS-01][SPEC-13.audit-outage] AUDIT_READ: when the audit append fails no protected data is returned (RETRYABLE_FAILURE AUDIT_UNAVAILABLE)", async () => {
    const { sessionRef } = await h.verifiedAveryCall();
    h.audit.setOutage(true);
    const r = await h.call({ name: "fixture_get_appointments" }, header(sessionRef));
    expect(r.status).toBe("RETRYABLE_FAILURE");
    if (r.status === "RETRYABLE_FAILURE") expect(r.reasonCode).toBe("AUDIT_UNAVAILABLE");
    expect(JSON.stringify(r)).not.toContain("Dr. Morgan");
    expect(r.speech).toBeNull();
  });

  it("[SAFE-02][SPEC-13.audit-outage] an audit outage never blocks the human route", async () => {
    const { sessionRef } = await h.startCall();
    h.audit.setOutage(true);
    const r = await h.call({ name: "fixture_request_human", arguments: { reason: "CALLER_REQUESTED_HUMAN", language: "en" } }, header(sessionRef));
    expect(r.status).toBe("PENDING");
    expect(r.auditEventId).toBeNull();
  });
});

describe("ToolPipeline — SAFE-02 safety and human routes without a session", () => {
  beforeEach(async () => {
    h = await createGatewayHarness();
  });

  it("[SAFE-02] the human route works with no session header, an unknown ref, an expired session and a revoked session", async () => {
    const live = await h.startCall();
    await h.identity.sessions.revoke(live.sessionRef, "TEST_REVOKE");
    const expired = await h.startCall(CALLS.concurrent.callId);
    h.identity.clock.advanceSeconds(7201);
    for (const transport of [{}, { sessionRefHeader: "ses_doesNotExist0000000000000000000000000000" }, header(live.sessionRef), header(expired.sessionRef)]) {
      const r = await h.call({ name: "fixture_request_human", arguments: { reason: "CALLER_REQUESTED_HUMAN", language: "en" } }, transport);
      expect(r.status).toBe("PENDING");
      expect(r.sessionGeneration).toBe(0);
      expect(r.speech).toBeNull();
    }
    expect(h.faults.sessionlessExecutions).toBe(4);
  });

  it("[SAFE-02] a sessionless route still receives the call id when the trusted binding names it (identifier only)", async () => {
    await h.call({ name: "fixture_request_human", arguments: { reason: "CALLER_REQUESTED_HUMAN", language: "en" } }, { interactionIdHeader: CALLS.primary.callId });
    expect(h.faults.lastCallId).toBe(CALLS.primary.callId);
  });

  it("[SAFE-02][SAFE-03] kill switches, admission refusal and a failing policy engine never block the human route", async () => {
    const { sessionRef } = await h.startCall();
    h.killSwitches.state = { ...h.killSwitches.state, aiAdmission: true, writes: true, modelVersions: [h.versions.model], intents: ["human_handoff"] };
    h.admission.next = { admitted: false, continuity: "HUMAN_QUEUE", reasonCode: "BUDGET_EXHAUSTED" };
    const r = await h.call({ name: "fixture_request_human", arguments: { reason: "CALLER_REQUESTED_HUMAN", language: "en" } }, header(sessionRef));
    expect(r.status).toBe("PENDING");
    await h.close();
    h = await createGatewayHarness({ policy: new ThrowingPolicyEngineFixture() });
    const s = await h.startCall();
    const r2 = await h.call({ name: "fixture_request_human", arguments: { reason: "CALLER_REQUESTED_HUMAN", language: "en" } }, header(s.sessionRef));
    expect(r2.status).toBe("PENDING");
    // With no valid decision nothing is disclosed: the policy field mask falls back to empty.
    if (r2.status === "PENDING") expect(r2.data).toEqual({});
  });

  it("[SAFE-02] a safety tool without a sessionless implementation fails honestly (never a fake success) so Studio's independent route applies", async () => {
    const r = await h.call({ name: "fixture_safety_route", arguments: { signal: "CALLER_REQUEST" } }, {});
    expect(r.status === "PERMANENT_FAILURE" && r.reasonCode).toBe("SESSIONLESS_ROUTE_UNSUPPORTED");
  });

  it("[SAFE-02] protected tools stay closed without a session", async () => {
    const r = await h.call({ name: "fixture_public_faq", arguments: { topic: "portal_login" } }, {});
    expect(r.status === "POLICY_DENIED" && r.reasonCode).toBe("SESSION_REF_MISSING");
  });
});

describe("ToolPipeline — kill switches, fence, admission, idempotency, dependency mapping", () => {
  beforeEach(async () => {
    h = await createGatewayHarness();
  });

  it("[SPEC-13.kill-switch] the writes switch denies commits through policy; an engaged model-version switch stops in-flight automation", async () => {
    const { sessionRef } = await h.verifiedAveryCall();
    h.killSwitches.state = { ...h.killSwitches.state, writes: true };
    const commit = await h.call({ name: "fixture_commit_change", arguments: { actionId: "act_synthFixtureAction01", digest: "a".repeat(64) } }, header(sessionRef));
    expect(commit.status).toBe("POLICY_DENIED");
    h.killSwitches.state = { ...h.killSwitches.state, writes: false, modelVersions: [h.versions.model] };
    const read = await h.call({ name: "fixture_get_appointments" }, header(sessionRef));
    expect(read.status).toBe("POLICY_DENIED");
    expect(h.faults.executions).toBe(0);
  });

  it("[OPS-02] an unreadable kill-switch state fails closed for protected tools", async () => {
    const { sessionRef } = await h.verifiedAveryCall();
    h.killSwitches.failing = true;
    const r = await h.call({ name: "fixture_get_appointments" }, header(sessionRef));
    expect(r.status).toBe("POLICY_DENIED");
  });

  it("[SPEC-15.dr-fence] VSP_MUTATIONS_ENABLED=false fences every prepare/commit tool", async () => {
    await h.close();
    h = await createGatewayHarness({ mutationsEnabled: false });
    const { sessionRef } = await h.verifiedAveryCall();
    const r = await h.call({ name: "fixture_commit_change", arguments: { actionId: "act_synthFixtureAction01", digest: "a".repeat(64) } }, header(sessionRef));
    expect(r.status === "POLICY_DENIED" && r.reasonCode).toBe("MUTATIONS_FENCED");
  });

  it("[OPS-02][SPEC-12.admission] admission refusal (budget, load shedding) is a reason-coded denial, never a silent drop", async () => {
    const { sessionRef } = await h.startCall();
    h.admission.next = { admitted: false, continuity: "HUMAN_QUEUE", reasonCode: "LOAD_SHED_CONSTRAINED" };
    const r = await h.call({ name: "fixture_public_faq", arguments: { topic: "portal_login" } }, header(sessionRef));
    expect(r.status === "POLICY_DENIED" && r.reasonCode).toBe("LOAD_SHED_CONSTRAINED");
    expect(h.admission.calls.at(-1)).toMatchObject({ class: "PUBLIC", vendor: "talkdesk-local", modelVersion: "local-fixture-model" });
  });

  it("[ACT-02][SPEC-8.idempotency] IDEMPOTENCY_KEY_REQUIRED: same key + same request returns the stored result; a changed request with the same key is rejected; no key is refused", async () => {
    const { sessionRef } = await h.startCall();
    const key = "idem_fixtureKey_000001";
    const args = { category: "general_question", urgency: "normal" };
    const first = await h.call({ name: "fixture_create_request", arguments: args, idempotencyKey: key }, header(sessionRef));
    const replay = await h.call({ name: "fixture_create_request", arguments: args, idempotencyKey: key }, header(sessionRef));
    expect(first.status).toBe("SUCCESS");
    expect(replay).toEqual(first);
    expect(h.faults.effects.filter((e) => e.startsWith("intake_"))).toHaveLength(1);
    const changed = await h.call({ name: "fixture_create_request", arguments: { ...args, urgency: "low" }, idempotencyKey: key }, header(sessionRef));
    expect(changed.status === "PERMANENT_FAILURE" && changed.reasonCode).toBe("IDEMPOTENCY_KEY_REUSED");
    const missing = await h.call({ name: "fixture_create_request", arguments: args }, header(sessionRef));
    expect(missing.status === "PERMANENT_FAILURE" && missing.reasonCode).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(h.faults.effects.filter((e) => e.startsWith("intake_"))).toHaveLength(1);
  });

  it("[ACT-02] the same idempotency key from a different session is a different request (session binding is part of the hash)", async () => {
    const a = await h.startCall(CALLS.primary.callId);
    const b = await h.startCall(CALLS.concurrent.callId);
    const key = "idem_fixtureKey_000002";
    const args = { category: "general_question", urgency: "normal" };
    expect((await h.call({ name: "fixture_create_request", arguments: args, idempotencyKey: key }, header(a.sessionRef))).status).toBe("SUCCESS");
    const other = await h.call({ name: "fixture_create_request", arguments: args, idempotencyKey: key }, header(b.sessionRef));
    expect(other.status === "PERMANENT_FAILURE" && other.reasonCode).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("[ACT-03] DependencyError mapping: NOT_STARTED -> RETRYABLE_FAILURE, UNKNOWN (consequential) -> UNKNOWN_OUTCOME, FAILED -> PERMANENT_FAILURE", async () => {
    const { sessionRef } = await h.verifiedAveryCall();
    const commit = () => h.call({ name: "fixture_commit_change", arguments: { actionId: "act_synthFixtureAction01", digest: "a".repeat(64) } }, header(sessionRef));
    h.faults.mode = "not_started";
    const ns = await commit();
    expect(ns.status === "RETRYABLE_FAILURE" && ns.reasonCode).toBe("CONNECTION_REFUSED");
    h.faults.mode = "unknown";
    const unk = await commit();
    expect(unk.status).toBe("UNKNOWN_OUTCOME");
    if (unk.status === "UNKNOWN_OUTCOME") expect(unk.reconciliationRef).toBe(unk.requestId);
    h.faults.mode = "failed";
    const failed = await commit();
    expect(failed.status === "PERMANENT_FAILURE" && failed.reasonCode).toBe("DEPENDENCY_REJECTED");
  });

  it("[ACT-03][DATA-01] an unclassified error after a consequential execution is UNKNOWN_OUTCOME and its free text never propagates", async () => {
    const { sessionRef } = await h.verifiedAveryCall();
    h.faults.mode = "throw_plain";
    const plain = await h.call({ name: "fixture_commit_change", arguments: { actionId: "act_synthFixtureAction01", digest: "a".repeat(64) } }, header(sessionRef));
    expect(plain.status === "UNKNOWN_OUTCOME" && plain.reasonCode).toBe("UNCLASSIFIED_ERROR");
    expect(JSON.stringify(plain) + JSON.stringify(await h.auditRows()) + JSON.stringify(h.records)).not.toContain("Synthetic-Client 1990-01-01");
  });

  it("[SPEC-12.retry] bounded retries apply only to NOT_STARTED errors listed in the tool's retry policy", async () => {
    const { sessionRef } = await h.startCall();
    h.faults.mode = "not_started";
    const r = await h.call({ name: "fixture_public_faq", arguments: { topic: "portal_login" } }, header(sessionRef));
    expect(r.status).toBe("RETRYABLE_FAILURE");
    expect(h.faults.executions).toBe(3);
  });

  it("[SPEC-12.circuit-breaker] repeated dependency failures open the per-dependency breaker; further calls fail fast as CIRCUIT_OPEN", async () => {
    const { sessionRef } = await h.verifiedAveryCall();
    h.faults.mode = "failed";
    for (let i = 0; i < 3; i++) await h.call({ name: "fixture_get_appointments" }, header(sessionRef));
    const before = h.faults.executions;
    const r = await h.call({ name: "fixture_get_appointments" }, header(sessionRef));
    expect(r.status === "RETRYABLE_FAILURE" && r.reasonCode).toBe("CIRCUIT_OPEN");
    expect(h.faults.executions).toBe(before);
  });

  it("[ACT-03][SPEC-8.timeout] a tool that exceeds its timeout: read -> RETRYABLE_FAILURE; consequential -> UNKNOWN_OUTCOME (never success)", async () => {
    await h.close();
    const timers = new ManualTimersFixture();
    h = await createGatewayHarness({ timers });
    const { sessionRef } = await h.verifiedAveryCall();
    h.faults.mode = "hang";
    const fire = async <T>(p: Promise<T>): Promise<T> => {
      for (let i = 0; i < 200 && timers.pending.size === 0; i++) await new Promise((r) => setImmediate(r));
      // resolveResource completes immediately; the remaining pending timer is the execution timeout.
      for (let i = 0; i < 200; i++) {
        await new Promise((r) => setImmediate(r));
        if (timers.pending.size > 0 && h.faults.executions > 0) break;
      }
      timers.fireAll();
      return p;
    };
    const read = await fire(h.call({ name: "fixture_get_appointments" }, header(sessionRef)));
    expect(read.status === "RETRYABLE_FAILURE" && read.reasonCode).toBe("TIMEOUT");
    const commit = await fire(h.call({ name: "fixture_commit_change", arguments: { actionId: "act_synthFixtureAction01", digest: "a".repeat(64) } }, header(sessionRef)));
    expect(commit.status).toBe("UNKNOWN_OUTCOME");
  });

  it("[ACT-05][SPEC-11.templates] invalid speech from a tool is replaced by the approved safe explanation (never dependency text)", async () => {
    const { sessionRef } = await h.verifiedAveryCall();
    h.faults.mode = "bad_speech";
    const r = await h.call({ name: "fixture_get_appointments" }, header(sessionRef));
    expect(r.status).toBe("SUCCESS");
    expect(r.speech?.templateId).toBe("fallback.safe_explanation");
    expect(r.speech?.authorizationRef).toBeNull();
  });

  it("[SPEC-15.integration-identity] a telephony_control credential cannot invoke tools (separate service identities)", async () => {
    const { sessionRef } = await h.startCall();
    const r = await h.call({ name: "fixture_public_faq", arguments: { topic: "portal_login" } }, header(sessionRef), telephony());
    expect(r.status === "POLICY_DENIED" && r.reasonCode).toBe("INTEGRATION_NOT_PERMITTED");
  });
});

describe("ToolPipeline — session binding modes", () => {
  it("[AUTH-03][TB-01] server_to_server_lookup resolves the session bound to the trusted interaction id; an unknown interaction fails closed", async () => {
    h = await createGatewayHarness({ mode: "server_to_server_lookup" });
    await h.startCall(CALLS.primary.callId);
    const ok = await h.call({ name: "fixture_public_faq", arguments: { topic: "portal_login" } }, { interactionIdHeader: CALLS.primary.callId });
    expect(ok.status).toBe("SUCCESS");
    const unknown = await h.call({ name: "fixture_public_faq", arguments: { topic: "portal_login" } }, { interactionIdHeader: "cal_synthCallUnknown0001" });
    expect(unknown.status === "POLICY_DENIED" && unknown.reasonCode).toBe("SESSION_NOT_BOUND_TO_INTERACTION");
    const headerOnly = await h.call({ name: "fixture_public_faq", arguments: { topic: "portal_login" } }, { sessionRefHeader: "ses_xxxxxxxxxxxxxxxxxxxxxxxxxx" });
    expect(headerOnly.status === "POLICY_DENIED" && headerOnly.reasonCode).toBe("INTERACTION_ID_MISSING");
  });

  it("[AUTH-03][TB-01] tool_argument_lookup_exception reads the sessionRef argument only with an approved exception id; without it construction is refused", async () => {
    await expect(createGatewayHarness({ mode: "tool_argument_lookup_exception", exceptionApprovalId: null })).rejects.toThrow(/SESSION_BINDING_EXCEPTION_UNAPPROVED/);
    h = await createGatewayHarness({ mode: "tool_argument_lookup_exception", exceptionApprovalId: "apr_synthSecurityException01" });
    const { sessionRef } = await h.startCall();
    const ok = await h.call({ name: "fixture_public_faq", arguments: { topic: "portal_login", sessionRef } }, {});
    expect(ok.status).toBe("SUCCESS");
    const forged = await h.call({ name: "fixture_public_faq", arguments: { topic: "portal_login", sessionRef: "ses_forgedForgedForgedForged0001" } }, {});
    expect(forged.status).toBe("POLICY_DENIED");
  });

  it("[AUTH-04] TTL independence: the binding check uses the injected clock, not storage cleanup", async () => {
    h = await createGatewayHarness();
    const { sessionRef } = await h.startCall();
    h.identity.clock.advanceSeconds(7199);
    expect((await h.call({ name: "fixture_public_faq", arguments: { topic: "portal_login" } }, header(sessionRef))).status).toBe("SUCCESS");
    h.identity.clock.advanceSeconds(2);
    expect((await h.call({ name: "fixture_public_faq", arguments: { topic: "portal_login" } }, header(sessionRef))).status).toBe("POLICY_DENIED");
    expect(TENANT_ID).toBe(h.mcpIdentity.tenantId);
  });
});
