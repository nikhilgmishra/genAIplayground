import { beforeAll, describe, expect, it } from "vitest";
import { ValidationError } from "../shared/errors.js";
import type { OpaWasmPolicyEngine } from "./engine.js";
import { LATER, NOW, P, TENANT_ID, averyAuthContext, loadTestEngine, resource, selfFact } from "./fixtures/inputs.fixture.js";
import { buildPolicyInput, toolPolicyRef } from "./input.js";

let engine: OpaWasmPolicyEngine;
beforeAll(async () => {
  engine = await loadTestEngine();
});

const killSwitches = { aiAdmission: false, writes: false, intents: [] as string[], integrations: [] as string[] };
const base = () => ({
  auth: averyAuthContext(),
  action: "appointment:read",
  purpose: "caller_self_service" as const,
  tool: { name: "get_appointment_options", version: "1.0.0", minAssurance: "A2" as const, consequential: false },
  resource: resource("appointment", P.avery.subjectId, null, "PHI"),
  relationships: [selfFact(P.avery)],
  killSwitches,
  environment: "local" as const,
  now: new Date(NOW),
});

describe("buildPolicyInput (server-established fields only)", () => {
  it("[AUTH-03] maps AuthContext session, consent and step-up fields; nothing else", () => {
    const ctx = averyAuthContext({ stepUp: { actionDigest: "c".repeat(64), verifiedAt: NOW, expiresAt: LATER }, assurance: "A3" });
    const input = buildPolicyInput({ ...base(), auth: ctx });
    expect(input.auth).toEqual({
      tenantId: TENANT_ID,
      sessionGeneration: 2,
      actorId: P.avery.actorId,
      selectedRole: "client",
      subjectId: P.avery.subjectId,
      organizationId: null,
      permittedScopes: ["appointment:read"],
      assurance: "A3",
      authenticatedAt: "2026-10-17T14:55:00.000Z",
      expiresAt: LATER,
      revoked: false,
      riskFlags: [],
      consentRecording: "GRANTED",
      consentAutomatedProcessing: "GRANTED",
      stepUpDigest: "c".repeat(64),
      stepUpExpiresAt: LATER,
    });
    expect(input.now).toBe(NOW);
    expect(engine.decideSync(buildPolicyInput(base()))).toMatchObject({ allow: true, reasonCodes: ["ALLOW_SELF"] });
  });

  it("[AUTH-03] a model-proposed field smuggled into the auth context is rejected", () => {
    const tampered = { ...averyAuthContext(), callerClaimedRole: "provider" } as unknown as ReturnType<typeof averyAuthContext>;
    expect(() => buildPolicyInput({ ...base(), auth: tampered })).toThrow(ValidationError);
    try {
      buildPolicyInput({ ...base(), auth: tampered });
    } catch (e) {
      expect((e as ValidationError).reasonCode).toBe("POLICY_INPUT_AUTH_INVALID");
      expect((e as Error).message).not.toContain("provider");
    }
  });

  it("[AUTH-03] extra resource or relationship properties are rejected, not forwarded", () => {
    expect(() => buildPolicyInput({ ...base(), resource: { ...resource("appointment", P.avery.subjectId, null, "PHI"), ownerClaim: "x" } as never })).toThrow(ValidationError);
    expect(() => buildPolicyInput({ ...base(), relationships: [{ ...selfFact(P.avery), statedByCaller: true } as never] })).toThrow(ValidationError);
  });

  it("[AUTH-03] the tool reference is narrowed to policy fields", () => {
    const full = { name: "get_appointment_options", version: "1.0.0", minAssurance: "A2" as const, consequential: false, description: "ignored", timeoutMs: 1000 };
    expect(toolPolicyRef(full)).toEqual({ name: "get_appointment_options", version: "1.0.0", minAssurance: "A2", consequential: false });
    expect(buildPolicyInput({ ...base(), tool: full }).tool).toEqual(toolPolicyRef(full));
  });

  it("[SAFE-02] no resolvable session: safety and human routes stay available, everything else is denied", () => {
    const anon = { ...base(), auth: null, tenantId: TENANT_ID, tool: null, relationships: [], resource: resource("call_session", null, null, "INTERNAL") };
    const safety = buildPolicyInput({ ...anon, action: "safety:route", purpose: "safety_routing" });
    expect(safety.auth).toMatchObject({ actorId: null, selectedRole: null, assurance: "A0", revoked: true, expiresAt: NOW });
    expect(engine.decideSync(safety).allow).toBe(true);
    expect(engine.decideSync(buildPolicyInput({ ...anon, action: "human:request", purpose: "human_handoff" })).allow).toBe(true);
    const faq = engine.decideSync(buildPolicyInput({ ...anon, action: "public:read", purpose: "public_information", resource: resource("knowledge_article", null, null, "PUBLIC") }));
    expect(faq).toMatchObject({ allow: false, reasonCodes: ["SESSION_INVALID"] });
  });

  it("[OPS-03] missing tenant for an unauthenticated input is an error, not a default", () => {
    expect(() => buildPolicyInput({ ...base(), auth: null })).toThrow(ValidationError);
  });

  it("[SPEC-13.kill-switch] kill switch lists are copied and sorted from the ops snapshot", () => {
    const snapshot = { aiAdmission: false, writes: true, intents: ["b_intent", "a_intent"], integrations: ["scheduling"], outboundNotifications: true, modelVersions: [], voiceVersions: [] };
    const input = buildPolicyInput({ ...base(), killSwitches: snapshot });
    expect(input.killSwitches).toEqual({ aiAdmission: false, writes: true, intents: ["a_intent", "b_intent"], integrations: ["scheduling"] });
    snapshot.intents.push("c_intent");
    expect(input.killSwitches.intents).toHaveLength(2);
  });

  it("[AUTH-04] an expired AuthContext is still mapped faithfully so policy denies it", () => {
    const input = buildPolicyInput({ ...base(), auth: averyAuthContext({ expiresAt: "2026-10-17T14:00:00.000Z" }) });
    expect(engine.decideSync(input)).toMatchObject({ allow: false, reasonCodes: ["SESSION_INVALID"] });
  });
});
