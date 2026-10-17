import { beforeEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { CALLS, OTHER_TENANT_ID, PEOPLE, TENANT_ID } from "../fixtures/synthetic-world.js";
import { AuthContext, SERVER_ESTABLISHED_FIELDS } from "../protocol/index.js";
import type { IntegrationIdentity } from "../protocol/index.js";
import { sha256Hex } from "../shared/canonical.js";
import { AccessDeniedError, ConflictError, SessionInvalidError, ValidationError } from "../shared/errors.js";
import { newSessionRef } from "../shared/ids.js";
import { CONSENT_UNKNOWN, consentGranted, createIdentityHarness, integration, mcp, portal, telephony } from "./identity-harness.fixture.js";
import type { IdentityHarness } from "./identity-harness.fixture.js";
import { MemoryKvStoreFixture } from "./kv/memory-kv-store.js";
import type { KvStore } from "./ports.js";
import { sessionConfig } from "./config.js";
import { kvKeys, sessionBindingRefFor } from "./keys.js";
import { TrustedSessionService, authGateVariableFor, interpretAuthGateVariable } from "./session-service.js";
import { FakeClock } from "../shared/clock.js";

const reason = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "NO_ERROR";
  } catch (e) {
    return (e as { reasonCode?: string }).reasonCode ?? "UNTYPED_ERROR";
  }
};

let h: IdentityHarness;
beforeEach(async () => {
  h = await createIdentityHarness();
});

describe("startCall", () => {
  it("[AUTH-07] initial session is A0, generation 1, and its Auth Gate value is literally false", async () => {
    const started = await h.sessions.startCall({ integration: telephony(), callId: CALLS.primary.callId, callerIdHash: null, consent: CONSENT_UNKNOWN });
    expect(started.authGate).toBe(false);
    expect(started.sessionGeneration).toBe(1);
    expect(started.sessionRef).toMatch(/^ses_[A-Za-z0-9_-]{43}$/);
    const gate = await h.sessions.authGate(started.sessionRef, telephony());
    expect(gate.isAuthenticated).toBe(false);
    expect(interpretAuthGateVariable(gate.isAuthenticated)).toBe(false);
    const ctx = await h.sessions.resolve(started.sessionRef, mcp());
    expect(ctx).toMatchObject({ assurance: "A0", actorId: null, subjectId: null, selectedRole: null, verificationMethod: "none", sessionGeneration: 1 });
    expect(ctx.expiresAt).toBe("2026-10-17T17:00:00.000Z"); // FakeClock start + 7200 s hard expiry
  });

  it("[SPEC-7.SESSION] record is stored under sha256(sessionRef); the bearer value is never persisted", async () => {
    const { sessionRef } = await h.startCall();
    const dump = h.kv.dump();
    expect(dump).not.toContain(sessionRef);
    expect(h.kv.keys()).toContain(kvKeys.session(sha256Hex(sessionRef)));
    expect(JSON.stringify(h.records)).not.toContain(sessionRef);
    expect(JSON.stringify(h.records)).toContain(sessionBindingRefFor(sessionRef));
  });

  it("[AUTH-01] caller ID is stored only as a risk-signal digest and never raises assurance", async () => {
    const callerIdHash = sha256Hex(CALLS.primary.callerIdE164);
    const a = await h.startCall(CALLS.primary.callId, callerIdHash);
    const b = await h.startCall(CALLS.repeat.callId, callerIdHash); // same ANI again
    expect(a.ctx.assurance).toBe("A0");
    expect(b.ctx.assurance).toBe("A0");
    expect((await h.sessions.authGate(b.sessionRef, telephony())).isAuthenticated).toBe(false);
    expect(h.kv.dump()).not.toContain(CALLS.primary.callerIdE164);
    // A raw phone number is not accepted where a digest is expected.
    expect(
      await reason(h.sessions.startCall({ integration: telephony(), callId: CALLS.concurrent.callId, callerIdHash: CALLS.primary.callerIdE164, consent: CONSENT_UNKNOWN })),
    ).toBe("START_CALL_INPUT_INVALID");
  });

  it("[AUTH-03] only the deterministic telephony-control channel may start a call session, in the configured tenant and environment", async () => {
    const base = { callId: CALLS.primary.callId, callerIdHash: null, consent: CONSENT_UNKNOWN };
    expect(await reason(h.sessions.startCall({ ...base, integration: mcp() }))).toBe("START_CALL_CHANNEL_NOT_ALLOWED");
    expect(await reason(h.sessions.startCall({ ...base, integration: portal() }))).toBe("START_CALL_CHANNEL_NOT_ALLOWED");
    expect(await reason(h.sessions.startCall({ ...base, integration: telephony({ tenantId: OTHER_TENANT_ID }) }))).toBe("INTEGRATION_TENANT_MISMATCH");
    expect(await reason(h.sessions.startCall({ ...base, integration: telephony({ environment: "production" }) }))).toBe("INTEGRATION_ENVIRONMENT_MISMATCH");
    expect(await reason(h.sessions.startCall({ ...base, integration: telephony(), callId: "+15555550101" }))).toBe("START_CALL_INPUT_INVALID");
    const extra = { ...base, integration: telephony(), assurance: "A2" } as unknown as Parameters<typeof h.sessions.startCall>[0];
    expect(await reason(h.sessions.startCall(extra))).toBe("START_CALL_INPUT_INVALID");
  });

  it("[SPEC-7.SESSION] consent marked GRANTED without a capture source is rejected", async () => {
    const bad = { ...CONSENT_UNKNOWN, recording: "GRANTED" as const };
    expect(await reason(h.sessions.startCall({ integration: telephony(), callId: CALLS.primary.callId, callerIdHash: null, consent: bad }))).toBe("START_CALL_INPUT_INVALID");
  });

  it("[AUTH-07] a second session for the same call supersedes and revokes the first (no reused session)", async () => {
    const first = await h.startCall(CALLS.primary.callId);
    const second = await h.startCall(CALLS.primary.callId);
    expect(await reason(h.sessions.resolve(first.sessionRef, mcp()))).toBe("SESSION_REVOKED");
    expect((await h.sessions.resolve(second.sessionRef, mcp())).assurance).toBe("A0");
  });
});

describe("resolve", () => {
  it("[AUTH-03] AuthContext is rebuilt from server state only and validates against the strict protocol schema", async () => {
    const { sessionRef } = await h.startCall();
    await h.verifyWithSecureLink(PEOPLE.avery, sessionRef);
    const ctx = await h.sessions.resolve(sessionRef, mcp());
    expect(AuthContext.safeParse(ctx).success).toBe(true);
    expect(ctx).toMatchObject({
      tenantId: TENANT_ID,
      callId: CALLS.primary.callId,
      actorId: PEOPLE.avery.actorId,
      subjectId: PEOPLE.avery.subjectId,
      selectedRole: "client",
      assurance: "A2",
      verificationMethod: "secure_link_oidc",
    });
    // Mutating a returned context (as a hostile tool argument would) never changes server state.
    const tampered = { ...ctx, actorId: PEOPLE.blake.actorId, subjectId: PEOPLE.blake.subjectId, assurance: "A3" };
    expect(tampered.actorId).not.toBe(ctx.actorId);
    const again = await h.sessions.resolve(sessionRef, mcp());
    for (const f of SERVER_ESTABLISHED_FIELDS) expect(again[f]).toEqual(ctx[f]);
  });

  it("[AUTH-03] the MCP (model-facing) channel cannot record consent; telephony control can", async () => {
    const { sessionRef } = await h.startCall();
    const consent = consentGranted(h.clock.now().toISOString());
    expect(await reason(h.sessions.recordConsent(sessionRef, mcp(), consent))).toBe("CONSENT_CHANNEL_NOT_ALLOWED");
    expect(await reason(h.sessions.recordConsent(sessionRef, portal(), consent))).toBe("CONSENT_CAPTURE_SOURCE_MISMATCH");
    const ok = await h.sessions.recordConsent(sessionRef, telephony(), { ...consent, recording: "DECLINED" });
    expect(ok.consent.recording).toBe("DECLINED");
    expect(ok.sessionGeneration).toBe(1);
    expect(await reason(h.sessions.recordConsent(sessionRef, telephony(), { ...consent, capturedAt: "2026-10-18T00:00:00.000Z" }))).toBe("CONSENT_CAPTURED_IN_FUTURE");
  });

  it("[AUTH-04] expired session fails closed although the KV item still exists (TTL sweep has not run)", async () => {
    const { sessionRef } = await h.startCall();
    await h.verifyWithSecureLink(PEOPLE.avery, sessionRef);
    h.clock.advanceSeconds(7200);
    expect(await h.kv.get(kvKeys.session(sha256Hex(sessionRef)))).not.toBeNull();
    expect(await reason(h.sessions.resolve(sessionRef, mcp()))).toBe("SESSION_EXPIRED");
    expect((await h.sessions.authGate(sessionRef, telephony())).isAuthenticated).toBe(false);
    expect(await reason(h.sessions.selectRole(sessionRef, mcp(), "provider"))).toBe("SESSION_EXPIRED");
    expect(h.metrics.counterValue("vsp_identity_denials_total", { reason: "SESSION_EXPIRED" })).toBeGreaterThan(0);
  });

  it("[AUTH-04] one millisecond before hard expiry the session is valid; at expiry it is not", async () => {
    const { sessionRef } = await h.startCall();
    h.clock.advanceMs(7200 * 1000 - 1);
    await expect(h.sessions.resolve(sessionRef, mcp())).resolves.toBeTruthy();
    h.clock.advanceMs(1);
    await expect(h.sessions.resolve(sessionRef, mcp())).rejects.toBeInstanceOf(SessionInvalidError);
  });

  it("[AUTH-04] revoked and ended sessions fail closed; unknown and malformed refs fail closed", async () => {
    const a = await h.startCall(CALLS.primary.callId);
    const b = await h.startCall(CALLS.concurrent.callId);
    await h.verifyWithSecureLink(PEOPLE.avery, a.sessionRef);
    await h.sessions.revoke(a.sessionRef, "FRAUD_REVIEW_OPENED");
    expect(await reason(h.sessions.resolve(a.sessionRef, mcp()))).toBe("SESSION_REVOKED");
    await h.sessions.endCall(b.sessionRef, telephony());
    expect(await reason(h.sessions.resolve(b.sessionRef, mcp()))).toBe("SESSION_ENDED");
    expect(await reason(h.sessions.resolve(newSessionRef(), mcp()))).toBe("SESSION_NOT_FOUND");
    expect(await reason(h.sessions.resolve("not-a-session", mcp()))).toBe("SESSION_REF_INVALID");
    expect(await reason(h.sessions.resolve(sessionBindingRefFor(b.sessionRef), mcp()))).toBe("SESSION_REF_INVALID");
    // revoke and endCall are idempotent
    await h.sessions.revoke(a.sessionRef, "FRAUD_REVIEW_OPENED");
    await h.sessions.endCall(b.sessionRef, telephony());
    await expect(h.sessions.revoke(a.sessionRef, "not a code")).rejects.toBeInstanceOf(ValidationError);
  });

  it("[AUTH-04] a session swept by TTL stays invalid (not found), never silently recreated", async () => {
    const { sessionRef } = await h.startCall();
    h.clock.advanceSeconds(7200 + 3600 + 1);
    h.kv.sweepExpired(Math.floor(h.clock.now().getTime() / 1000));
    expect(await reason(h.sessions.resolve(sessionRef, mcp()))).toBe("SESSION_NOT_FOUND");
  });

  it("[SPEC-7.SESSION] session is bound to tenant, environment, integration id and an allowed channel", async () => {
    const { sessionRef } = await h.startCall();
    const cases: [IntegrationIdentity, string][] = [
      [mcp({ tenantId: OTHER_TENANT_ID }), "SESSION_TENANT_MISMATCH"],
      [mcp({ environment: "sandbox" }), "SESSION_ENVIRONMENT_MISMATCH"],
      [mcp({ integrationId: "other-connector" }), "SESSION_INTEGRATION_MISMATCH"],
      [integration("worker"), "SESSION_CHANNEL_NOT_ALLOWED"],
      [integration("console"), "SESSION_CHANNEL_NOT_ALLOWED"],
      [integration("webhook"), "SESSION_CHANNEL_NOT_ALLOWED"],
      [{ ...mcp(), channel: "anything" } as unknown as IntegrationIdentity, "SESSION_INTEGRATION_MISMATCH"],
    ];
    for (const [integ, expected] of cases) expect(await reason(h.sessions.resolve(sessionRef, integ))).toBe(expected);
    for (const ok of [mcp(), telephony(), portal()]) await expect(h.sessions.resolve(sessionRef, ok)).resolves.toBeTruthy();
  });

  it("[AUTH-07] a session reference from a previous call is rejected for the current call", async () => {
    const previous = await h.startCall(CALLS.primary.callId);
    await h.verifyWithSecureLink(PEOPLE.avery, previous.sessionRef);
    expect(await reason(h.sessions.resolve(previous.sessionRef, mcp(), { expectedCallId: CALLS.repeat.callId }))).toBe("SESSION_CALL_MISMATCH");
    const gate = await h.sessions.authGate(previous.sessionRef, telephony(), { expectedCallId: CALLS.repeat.callId });
    expect(gate.isAuthenticated).toBe(false);
  });
});

describe("Talkdesk Auth Gate", () => {
  it("[AUTH-07] interpretAuthGateVariable truth table: only boolean true opens the gate", () => {
    const closed: unknown[] = [false, null, undefined, "true", "false", "TRUE", 1, 0, "1", "yes", {}, [], [true], { value: true }, NaN, Symbol("true"), () => true, new Boolean(true)];
    for (const v of closed) expect(interpretAuthGateVariable(v)).toBe(false);
    expect(interpretAuthGateVariable(true)).toBe(true);
  });

  it("[AUTH-07] property: every value other than boolean true is closed", () => {
    fc.assert(
      fc.property(fc.anything(), (v) => {
        expect(interpretAuthGateVariable(v)).toBe(v === true);
      }),
      { seed: 7, numRuns: 2000 },
    );
  });

  it("[AUTH-07] authGateVariableFor closes on malformed gate responses", () => {
    expect(authGateVariableFor({ isAuthenticated: true, sessionGeneration: 1, evaluatedAt: "2026-10-17T15:00:00.000Z" })).toBe(true);
    expect(authGateVariableFor({ isAuthenticated: "true", sessionGeneration: 1, evaluatedAt: "2026-10-17T15:00:00.000Z" })).toBe(false);
    expect(authGateVariableFor({ isAuthenticated: true, sessionGeneration: 1, evaluatedAt: "2026-10-17T15:00:00.000Z", extra: 1 })).toBe(false);
    expect(authGateVariableFor(null)).toBe(false);
    expect(authGateVariableFor(undefined)).toBe(false);
  });

  it("[AUTH-07] gate is false for unknown, ended, expired, revoked, A0 and A1 sessions and true only for A2", async () => {
    const unknown = await h.sessions.authGate(newSessionRef(), telephony());
    expect(unknown.isAuthenticated).toBe(false);
    expect(await h.sessions.authGate("garbage", telephony())).toMatchObject({ isAuthenticated: false });
    expect(await h.sessions.authGate(undefined as unknown as string, telephony())).toMatchObject({ isAuthenticated: false });
    expect(await h.sessions.authGate(null as unknown as string, telephony())).toMatchObject({ isAuthenticated: false });

    const a0 = await h.startCall(CALLS.primary.callId);
    expect((await h.sessions.authGate(a0.sessionRef, telephony())).isAuthenticated).toBe(false);

    // A1 via OTP: still closed
    const a1 = await h.startCall(CALLS.concurrent.callId);
    const otp = await h.verification.beginOtp(a1.ctx, { role: "client", locator: { fullName: PEOPLE.avery.fullName, dateOfBirth: PEOPLE.avery.dateOfBirth } });
    const code = h.otpFor(PEOPLE.avery.channels[0].channelRef);
    expect(code).toMatch(/^\d{6}$/);
    expect((await h.verification.submitOtp({ sessionRef: a1.sessionRef, challengeId: otp.challengeId, code: code ?? "" }, telephony())).verified).toBe(true);
    expect((await h.sessions.resolve(a1.sessionRef, mcp())).assurance).toBe("A1");
    expect((await h.sessions.authGate(a1.sessionRef, telephony())).isAuthenticated).toBe(false);

    // A2: open
    const a2 = await h.startCall(CALLS.repeat.callId);
    await h.verifyWithSecureLink(PEOPLE.avery, a2.sessionRef);
    const open = await h.sessions.authGate(a2.sessionRef, telephony());
    expect(open.isAuthenticated).toBe(true);
    expect(interpretAuthGateVariable(open.isAuthenticated)).toBe(true);

    // revoked
    await h.sessions.revoke(a2.sessionRef, "RISK_REVIEW");
    expect((await h.sessions.authGate(a2.sessionRef, telephony())).isAuthenticated).toBe(false);
  });

  it("[AUTH-07] gate closes at call end and at expiry even though the item is still stored", async () => {
    const a = await h.startCall(CALLS.primary.callId);
    await h.verifyWithSecureLink(PEOPLE.avery, a.sessionRef);
    const b = await h.startCall(CALLS.concurrent.callId);
    await h.verifyWithSecureLink(PEOPLE.avery, b.sessionRef);
    await h.sessions.endCall(a.sessionRef, telephony());
    expect((await h.sessions.authGate(a.sessionRef, telephony())).isAuthenticated).toBe(false);
    expect((await h.sessions.authGate(b.sessionRef, telephony())).isAuthenticated).toBe(true);
    h.clock.advanceSeconds(7200);
    expect((await h.sessions.authGate(b.sessionRef, telephony())).isAuthenticated).toBe(false);
    expect(h.kv.size).toBeGreaterThan(0);
  });

  it("[AUTH-07] gate fails closed (does not throw) when the session store is unavailable", async () => {
    const { sessionRef } = await h.startCall();
    const broken: KvStore = {
      kind: "local_fixture",
      get: async () => {
        throw new Error("down");
      },
      putIfAbsent: async () => false,
      compareAndSwap: async () => false,
      delete: async () => false,
      increment: async () => 0,
    };
    const svc = new TrustedSessionService({ kv: broken, clock: h.clock, config: h.sessions.config });
    const gate = await svc.authGate(sessionRef, telephony());
    expect(gate.isAuthenticated).toBe(false);
  });
});

describe("privilege changes", () => {
  it("[AUTH-03] role switch drops privileges and bumps the generation (privileges never combined)", async () => {
    const { sessionRef } = await h.startCall();
    await h.verifyWithSecureLink(PEOPLE.avery, sessionRef);
    const before = await h.sessions.resolve(sessionRef, mcp());
    expect(before.assurance).toBe("A2");
    const same = await h.sessions.selectRole(sessionRef, mcp(), "client");
    expect(same.sessionGeneration).toBe(before.sessionGeneration);
    expect(same.assurance).toBe("A2");
    const switched = await h.sessions.selectRole(sessionRef, mcp(), "provider");
    expect(switched).toMatchObject({ selectedRole: "provider", assurance: "A0", actorId: null, subjectId: null, organizationId: null, permittedScopes: [], verificationMethod: "none" });
    expect(switched.sessionGeneration).toBe(before.sessionGeneration + 1);
    expect((await h.sessions.authGate(sessionRef, telephony())).isAuthenticated).toBe(false);
    await expect(h.sessions.selectRole(sessionRef, mcp(), "admin" as never)).rejects.toBeInstanceOf(ValidationError);
  });

  it("[AUTH-03] participant change drops privileges, resets consent, flags risk and bumps the generation", async () => {
    const { sessionRef } = await h.startCall();
    await h.verifyWithSecureLink(PEOPLE.avery, sessionRef);
    const changed = await h.sessions.applyChange(sessionRef, mcp(), { kind: "PARTICIPANT_CHANGED" });
    expect(changed).toMatchObject({ assurance: "A0", actorId: null, subjectId: null, sessionGeneration: 2, verificationMethod: "none" });
    expect(changed.riskFlags).toContain("PARTICIPANT_CHANGED");
    expect(changed.consent.recording).toBe("UNKNOWN");
    expect((await h.sessions.authGate(sessionRef, telephony())).isAuthenticated).toBe(false);
  });

  it("[AUTH-03] account switch, recovery, risk and safety escalation each drop privileges; the safety flag is retained", async () => {
    const kinds = [
      { change: { kind: "ACCOUNT_SWITCH" as const }, flag: null },
      { change: { kind: "RECOVERY_STARTED" as const }, flag: "ACCOUNT_RECOVERY_IN_PROGRESS" },
      { change: { kind: "RISK_ESCALATION" as const, flag: "FRAUD_REVIEW" as const }, flag: "FRAUD_REVIEW" },
      { change: { kind: "SAFETY_ESCALATION" as const }, flag: "SAFETY_ESCALATION_ACTIVE" },
    ];
    for (const k of kinds) {
      const hh = await createIdentityHarness();
      const { sessionRef } = await hh.startCall();
      await hh.verifyWithSecureLink(PEOPLE.avery, sessionRef);
      const ctx = await hh.sessions.applyChange(sessionRef, telephony(), k.change);
      expect(ctx.assurance).toBe("A0");
      expect(ctx.actorId).toBeNull();
      expect(ctx.subjectId).toBeNull();
      expect(ctx.sessionGeneration).toBe(2);
      expect(ctx.consent.recording).toBe("GRANTED");
      if (k.flag) expect(ctx.riskFlags).toContain(k.flag);
    }
    const { sessionRef } = await h.startCall();
    await h.sessions.applyChange(sessionRef, mcp(), { kind: "SAFETY_ESCALATION" });
    const after = await h.sessions.applyChange(sessionRef, mcp(), { kind: "ACCOUNT_SWITCH" });
    expect(after.riskFlags).toContain("SAFETY_ESCALATION_ACTIVE");
    await expect(h.sessions.applyChange(sessionRef, mcp(), { kind: "PROMOTE" } as never)).rejects.toBeInstanceOf(ValidationError);
    await expect(h.sessions.applyChange(sessionRef, mcp(), { kind: "RISK_ESCALATION", flag: "NOT_A_FLAG" } as never)).rejects.toBeInstanceOf(ValidationError);
  });

  it("[AUTH-04] revocation bumps the generation and clears every privilege", async () => {
    const { sessionRef } = await h.startCall();
    await h.verifyWithSecureLink(PEOPLE.avery, sessionRef);
    await h.sessions.revoke(sessionRef, "SECURITY_REVOCATION");
    const stored = await h.sessions.store.load(sha256Hex(sessionRef));
    expect(stored?.rec).toMatchObject({ revoked: true, revokedReason: "SECURITY_REVOCATION", assurance: "A0", actorId: null, generation: 2 });
  });

  it("[SPEC-7.SESSION] endCall from a foreign integration is rejected", async () => {
    const { sessionRef } = await h.startCall();
    expect(await reason(h.sessions.endCall(sessionRef, telephony({ integrationId: "other-connector" })))).toBe("SESSION_INTEGRATION_MISMATCH");
    await expect(h.sessions.resolve(sessionRef, mcp())).resolves.toBeTruthy();
  });
});

describe("compare-and-swap updates", () => {
  it("[SPEC-7.SESSION] concurrent changes are serialised by CAS: no lost update, generation counts every change", async () => {
    const { sessionRef } = await h.startCall();
    const changes = Array.from({ length: 4 }, (_, i) => (i % 2 === 0 ? { kind: "ACCOUNT_SWITCH" as const } : { kind: "RISK_ESCALATION" as const, flag: "FRAUD_REVIEW" as const }));
    await Promise.all(changes.map((c) => h.sessions.applyChange(sessionRef, mcp(), c)));
    const ctx = await h.sessions.resolve(sessionRef, mcp());
    expect(ctx.sessionGeneration).toBe(1 + changes.length);
  });

  it("[SPEC-7.SESSION] persistent CAS conflicts exhaust the bounded retries and fail closed", async () => {
    const inner = new MemoryKvStoreFixture();
    const conflicting: KvStore = {
      kind: "local_fixture",
      get: (pk) => inner.get(pk),
      putIfAbsent: (item) => inner.putIfAbsent(item),
      compareAndSwap: async () => false,
      delete: (pk, v) => inner.delete(pk, v),
      increment: (pk, ttl) => inner.increment(pk, ttl),
    };
    const clock = new FakeClock();
    const svc = new TrustedSessionService({ kv: conflicting, clock, config: sessionConfig({ tenantId: TENANT_ID, environment: "local", policyVersion: "p1", casMaxAttempts: 3 }) });
    const { sessionRef } = await svc.startCall({ integration: telephony(), callId: CALLS.primary.callId, callerIdHash: null, consent: CONSENT_UNKNOWN });
    await expect(svc.applyChange(sessionRef, mcp(), { kind: "ACCOUNT_SWITCH" })).rejects.toBeInstanceOf(ConflictError);
    expect((await svc.resolve(sessionRef, mcp())).sessionGeneration).toBe(1);
  });

  it("[AUTH-03] property: after any sequence of role selections and changes, a privilege drop always leaves A0 with no actor", async () => {
    type Step = { t: "role"; role: "client" | "provider" | "partner" } | { t: "change"; kind: "PARTICIPANT_CHANGED" | "ACCOUNT_SWITCH" | "RECOVERY_STARTED" | "SAFETY_ESCALATION" } | { t: "verify" };
    const step: fc.Arbitrary<Step> = fc.oneof(
      fc.record({ t: fc.constant("role" as const), role: fc.constantFrom("client" as const, "provider" as const, "partner" as const) }),
      fc.record({ t: fc.constant("change" as const), kind: fc.constantFrom("PARTICIPANT_CHANGED" as const, "ACCOUNT_SWITCH" as const, "RECOVERY_STARTED" as const, "SAFETY_ESCALATION" as const) }),
      fc.record({ t: fc.constant("verify" as const) }),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 6 }), async (steps) => {
        const hh = await createIdentityHarness({ verification: { maxVerificationBeginsPerSession: 50, linkMaxPerAccountPerHour: 50 } });
        const { sessionRef } = await hh.startCall();
        let lastGen = 1;
        for (const s of steps) {
          const before = await hh.sessions.resolve(sessionRef, mcp());
          let after = before;
          if (s.t === "role") after = await hh.sessions.selectRole(sessionRef, mcp(), s.role);
          else if (s.t === "change") after = await hh.sessions.applyChange(sessionRef, mcp(), { kind: s.kind });
          else if (before.selectedRole === null || before.selectedRole === "client") {
            await hh.verifyWithSecureLink(PEOPLE.avery, sessionRef);
            after = await hh.sessions.resolve(sessionRef, mcp());
          }
          expect(after.sessionGeneration).toBeGreaterThanOrEqual(lastGen);
          if (after.sessionGeneration > before.sessionGeneration) {
            expect(after.assurance).toBe("A0");
            expect(after.actorId).toBeNull();
            expect(after.subjectId).toBeNull();
            expect(after.permittedScopes).toEqual([]);
          }
          if (after.actorId !== null) expect(after.selectedRole).toBe("client");
          lastGen = after.sessionGeneration;
        }
      }),
      { seed: 11, numRuns: 25 },
    );
  });
});

describe("identity cannot be established from summaries or memory", () => {
  it("[DATA-04] memory- or summary-derived identity, assurance and consent fields are rejected by every session mutation", async () => {
    const { sessionRef } = await h.startCall();
    const claimed = { actorId: PEOPLE.avery.actorId, subjectId: PEOPLE.avery.subjectId, assurance: "A2", provenance: "machine_inferred" };
    await expect(h.sessions.applyChange(sessionRef, mcp(), { kind: "ACCOUNT_SWITCH", ...claimed } as never)).rejects.toBeInstanceOf(ValidationError);
    await expect(h.sessions.selectRole(sessionRef, mcp(), { role: "client", ...claimed } as never)).rejects.toBeInstanceOf(ValidationError);
    await expect(h.sessions.recordConsent(sessionRef, telephony(), { ...consentGranted(h.clock.now().toISOString()), source: "summary" } as never)).rejects.toBeInstanceOf(ValidationError);
    expect(
      await reason(h.sessions.startCall({ integration: telephony(), callId: CALLS.concurrent.callId, callerIdHash: null, consent: CONSENT_UNKNOWN, ...claimed } as never)),
    ).toBe("START_CALL_INPUT_INVALID");
    const ctx = await h.sessions.resolve(sessionRef, mcp());
    expect(ctx).toMatchObject({ actorId: null, subjectId: null, assurance: "A0", verificationMethod: "none" });
    expect(ctx.consent.recording).toBe("GRANTED"); // consent recorded at call start by the Studio flow, not by any summary
  });
});

describe("errors and logs", () => {
  it("[AUTH-06] session errors are reason codes only and logs never contain bearer session refs", async () => {
    const { sessionRef } = await h.startCall();
    const err = await h.sessions.resolve(sessionRef, mcp({ tenantId: OTHER_TENANT_ID })).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(SessionInvalidError);
    expect((err as Error).message).toBe("SESSION_TENANT_MISMATCH");
    expect(JSON.stringify(h.records)).not.toContain(sessionRef);
    await expect(h.sessions.recordConsent(sessionRef, mcp(), CONSENT_UNKNOWN)).rejects.toBeInstanceOf(AccessDeniedError);
  });
});
