/**
 * Caller session idle expiry, same-actor re-verification, processing basis and the injected-clock expiry
 * seam (WP-05). Real TrustedSessionService / SecureVerificationService over the LOCAL FIXTURE KV store and
 * OIDC provider of identity-harness.fixture.ts (the same services run over DynamoDB Local and Keycloak in
 * platform/test/integration/identity). SYNTHETIC people only.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { PEOPLE } from "../fixtures/synthetic-world.js";
import { AuthContext } from "../protocol/index.js";
import { sha256Hex } from "../shared/canonical.js";
import { ConfigurationRejectedError, DependencyError } from "../shared/errors.js";
import { sessionConfig } from "./config.js";
import { SessionExpirySeam } from "./expiry-seam.js";
import { createIdentityHarness, mcp } from "./identity-harness.fixture.js";
import type { IdentityHarness } from "./identity-harness.fixture.js";
import { kvKeys } from "./keys.js";
import { TrustedSessionService } from "./session-service.js";

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

async function verifiedSession() {
  const { sessionRef } = await h.startCall();
  const v = await h.verifyWithSecureLink(PEOPLE.avery, sessionRef);
  expect(v.result.bound).toBe(true);
  return { sessionRef, ctx: await h.sessions.resolve(sessionRef, mcp()) };
}

describe("[FO-05-18][AUTH-04] idle expiry of verified caller privileges", () => {
  it("[FO-05-18][AUTH-04] use inside the idle window keeps A2; idle beyond it refuses SESSION_IDLE_EXPIRED once, drops privileges and fences the generation while the record still exists", async () => {
    const { sessionRef, ctx } = await verifiedSession();
    expect(ctx.assurance).toBe("A2");
    // Activity keeps the privileges alive far beyond one idle window.
    for (let i = 0; i < 4; i++) {
      h.clock.advanceSeconds(600);
      expect((await h.sessions.resolve(sessionRef, mcp())).assurance, `use ${i}`).toBe("A2");
    }
    h.clock.advanceSeconds(901);
    expect(await reason(h.sessions.resolve(sessionRef, mcp()))).toBe("SESSION_IDLE_EXPIRED");
    // The record still exists (storage TTL cleanup has not run) - the refusal is application logic.
    expect(h.kv.keys()).toContain(kvKeys.session(sha256Hex(sessionRef)));
    const after = await h.sessions.resolve(sessionRef, mcp());
    expect(after).toMatchObject({ assurance: "A0", actorId: null, subjectId: null, permittedScopes: [], verificationMethod: "none" });
    expect(after.sessionGeneration).toBe(ctx.sessionGeneration + 1);
    expect(h.records.some((r) => r.event === "identity.session.idle_expired")).toBe(true);
    expect(h.metrics.counterValue("vsp_identity_denials_total", { reason: "SESSION_EXPIRED" })).toBeGreaterThan(0);
  });

  it("[FO-05-18] an unverified A0 session has nothing to lapse and is never refused for idleness", async () => {
    const { sessionRef } = await h.startCall();
    h.clock.advanceSeconds(3_000);
    expect((await h.sessions.resolve(sessionRef, mcp())).assurance).toBe("A0");
  });

  it("[FO-05-18][AUTH-04] the hard expiry still applies and wins over activity", async () => {
    const { sessionRef } = await verifiedSession();
    for (let elapsed = 0; elapsed < 7_200; elapsed += 600) {
      h.clock.advanceSeconds(600);
      const r = await reason(h.sessions.resolve(sessionRef, mcp()));
      if (r !== "NO_ERROR") {
        expect(r).toBe("SESSION_EXPIRED");
        return;
      }
    }
    throw new Error("hard expiry never applied");
  });
});

describe("[FAULT:AUTH_EXPIRY_IDLE][AUTH-07] the Talkdesk auth gate applies the idle limit", () => {
  it("[FAULT:AUTH_EXPIRY_IDLE][FO-05-18][AUTH-07][AUTH-04] read FIRST after the idle limit, the gate is closed, the privileges are dropped and the generation is fenced; reading the gate is not activity", async () => {
    const { sessionRef, ctx } = await verifiedSession();
    expect(await h.sessions.authGate(sessionRef, mcp())).toMatchObject({ isAuthenticated: true, sessionGeneration: ctx.sessionGeneration });
    // Gate reads inside the window do not extend it.
    h.clock.advanceSeconds(600);
    expect((await h.sessions.authGate(sessionRef, mcp())).isAuthenticated).toBe(true);
    h.clock.advanceSeconds(301);
    const gate = await h.sessions.authGate(sessionRef, mcp());
    expect(gate).toMatchObject({ isAuthenticated: false, sessionGeneration: ctx.sessionGeneration + 1 });
    expect(h.records.some((r) => r.event === "identity.auth_gate.closed" && r.fields.reasonCode === "SESSION_IDLE_EXPIRED")).toBe(true);
    // The gate already dropped the privileges: the next protected read sees A0 at the fenced generation.
    const after = await h.sessions.resolve(sessionRef, mcp());
    expect(after).toMatchObject({ assurance: "A0", actorId: null, sessionGeneration: ctx.sessionGeneration + 1 });
    expect((await h.sessions.authGate(sessionRef, mcp())).isAuthenticated).toBe(false);
  });

  it("[FAULT:AUTH_EXPIRY_IDLE][FO-05-05][AUTH-04] a step-up completed after the idle limit is refused: lapsed A2 is no base for A3", async () => {
    const short = await createIdentityHarness({ session: { privilegeIdleTimeoutSeconds: 120 } });
    const { sessionRef } = await short.startCall();
    expect((await short.verifyWithSecureLink(PEOPLE.avery, sessionRef)).result.bound).toBe(true);
    const digest = sha256Hex("synthetic-action-idle-step-up");
    await short.verification.beginStepUp(await short.sessions.resolve(sessionRef, mcp()), digest);
    const channel = PEOPLE.avery.channels[0]?.channelRef ?? "";
    const link = short.linkFor(channel);
    if (!link) throw new Error("FIXTURE_NO_LINK");
    short.clock.advanceSeconds(200);
    const idToken = await short.idp.issueFor(PEOPLE.avery, { nonce: link.nonce, amr: ["hwk"] });
    expect(await short.verification.completeStepUp({ ...link, idToken })).toMatchObject({ bound: false, reasonCode: "SESSION_IDLE_EXPIRED" });
    expect(await reason(short.sessions.resolve(sessionRef, mcp()))).toBe("SESSION_IDLE_EXPIRED");
    expect((await short.sessions.resolve(sessionRef, mcp())).stepUp).toBeNull();
  });
});

describe("[FO-05-19][FO-22-05] same-actor re-verification after idle expiry", () => {
  it("[FO-05-19][FO-22-05][AUTH-01] the same caller re-verifies to A2; a different person cannot silently take over the call; an explicit account switch allows it", async () => {
    const { sessionRef, ctx } = await verifiedSession();
    h.clock.advanceSeconds(901);
    expect(await reason(h.sessions.resolve(sessionRef, mcp()))).toBe("SESSION_IDLE_EXPIRED");
    // Another person (different account) verifying in the same call is refused.
    const other = await h.verifyWithSecureLink(PEOPLE.blake, sessionRef);
    expect(other.result).toMatchObject({ bound: false, reasonCode: "SESSION_ACTOR_MISMATCH" });
    expect((await h.sessions.resolve(sessionRef, mcp())).actorId).toBeNull();
    // The same actor re-verifies and gets A2 back (new generation).
    const again = await h.verifyWithSecureLink(PEOPLE.avery, sessionRef);
    expect(again.result.bound).toBe(true);
    const restored = await h.sessions.resolve(sessionRef, mcp());
    expect(restored).toMatchObject({ assurance: "A2", actorId: ctx.actorId, subjectId: ctx.subjectId });
    expect(restored.sessionGeneration).toBeGreaterThan(ctx.sessionGeneration);
    // An explicit, audited account switch is the only way to bind someone else.
    h.clock.advanceSeconds(901);
    await reason(h.sessions.resolve(sessionRef, mcp()));
    await h.sessions.applyChange(sessionRef, mcp(), { kind: "ACCOUNT_SWITCH" });
    const switched = await h.verifyWithSecureLink(PEOPLE.blake, sessionRef);
    expect(switched.result.bound).toBe(true);
    expect((await h.sessions.resolve(sessionRef, mcp())).actorId).not.toBe(ctx.actorId);
  });
});

describe("[FO-05-22] the verified identity service supplies the processing basis", () => {
  it("[FO-05-22] every context carries schemaVersion and a server-established basis: UNKNOWN until the matrix is approved, the approved basis for the verified role once configured", async () => {
    const { ctx } = await verifiedSession();
    expect(AuthContext.parse(ctx)).toBeTruthy();
    expect(ctx.schemaVersion).toBe("auth-context.v1");
    expect(ctx.processingBasis).toMatchObject({ basis: "UNKNOWN", approvalRef: null, jurisdiction: "UNKNOWN", source: "identity_service" });

    const approved = await createIdentityHarness({
      session: { jurisdiction: "US-CA", approvedProcessingBases: [{ role: "client", basis: "INDIVIDUAL_REQUEST", purpose: "support_administration", approvalRef: "apr_synthMatrixClientUsCa1" }] },
    });
    const { sessionRef } = await approved.startCall();
    expect((await approved.sessions.resolve(sessionRef, mcp())).processingBasis?.basis).toBe("UNKNOWN");
    await approved.verifyWithSecureLink(PEOPLE.avery, sessionRef);
    const v = await approved.sessions.resolve(sessionRef, mcp());
    expect(v.processingBasis).toMatchObject({ basis: "INDIVIDUAL_REQUEST", purpose: "support_administration", jurisdiction: "US-CA", approvalRef: "apr_synthMatrixClientUsCa1" });
    expect(v.processingBasis?.establishedAt).toBe(v.authenticatedAt);
    // A matrix entry must carry a well-formed approval reference (the config refuses anything else).
    expect(() => sessionConfig({ tenantId: "tnt_synthTenantPrimary01", environment: "local", policyVersion: "p1", approvedProcessingBases: [{ role: "client", basis: "INDIVIDUAL_REQUEST", purpose: "support_administration", approvalRef: "short" }] })).toThrow();
  });

  it("[FO-05-22] an approved matrix entry is never applied while the jurisdiction is UNKNOWN (an unknown jurisdiction inherits nothing)", async () => {
    const noJurisdiction = await createIdentityHarness({
      // jurisdiction left at its default UNKNOWN
      session: { approvedProcessingBases: [{ role: "client", basis: "INDIVIDUAL_REQUEST", purpose: "support_administration", approvalRef: "apr_synthMatrixClientUsCa1" }] },
    });
    expect(noJurisdiction.sessions.config.jurisdiction).toBe("UNKNOWN");
    const { sessionRef } = await noJurisdiction.startCall();
    expect((await noJurisdiction.verifyWithSecureLink(PEOPLE.avery, sessionRef)).result.bound).toBe(true);
    const v = await noJurisdiction.sessions.resolve(sessionRef, mcp());
    expect(v.assurance).toBe("A2");
    expect(v.selectedRole).toBe("client");
    expect(v.processingBasis).toMatchObject({ basis: "UNKNOWN", approvalRef: null, jurisdiction: "UNKNOWN", source: "identity_service" });
  });

  it("[FO-05-22] the basis is the one approved for the VERIFIED role: a role absent from the matrix gets UNKNOWN, and a matrix entry for another role is never borrowed", async () => {
    const providerOnly = await createIdentityHarness({
      session: { jurisdiction: "US-CA", approvedProcessingBases: [{ role: "provider", basis: "HIPAA_TREATMENT_PAYMENT_OPERATIONS", purpose: "support_administration", approvalRef: "apr_synthMatrixProviderUs1" }] },
    });
    const first = await providerOnly.startCall();
    expect((await providerOnly.verifyWithSecureLink(PEOPLE.avery, first.sessionRef)).result.bound).toBe(true);
    const client = await providerOnly.sessions.resolve(first.sessionRef, mcp());
    expect(client.selectedRole).toBe("client");
    expect(client.processingBasis).toMatchObject({ basis: "UNKNOWN", approvalRef: null, jurisdiction: "US-CA" });

    // With entries for both roles, the client gets the client's entry even when another role's comes first.
    const both = await createIdentityHarness({
      session: {
        jurisdiction: "US-CA",
        approvedProcessingBases: [
          { role: "provider", basis: "HIPAA_TREATMENT_PAYMENT_OPERATIONS", purpose: "support_administration", approvalRef: "apr_synthMatrixProviderUs1" },
          { role: "client", basis: "INDIVIDUAL_REQUEST", purpose: "support_administration", approvalRef: "apr_synthMatrixClientUsCa1" },
        ],
      },
    });
    const second = await both.startCall();
    expect((await both.verifyWithSecureLink(PEOPLE.avery, second.sessionRef)).result.bound).toBe(true);
    expect((await both.sessions.resolve(second.sessionRef, mcp())).processingBasis).toMatchObject({ basis: "INDIVIDUAL_REQUEST", approvalRef: "apr_synthMatrixClientUsCa1", jurisdiction: "US-CA" });
  });
});

describe("[FAULT:AUTH_EXPIRY_MID_CALL seam] injected-clock session expiry", () => {
  it("[FAULT:AUTH_EXPIRY_MID_CALL seam][AUTH-04] the seam moves only time: the next reader refuses SESSION_EXPIRED (hard) or SESSION_IDLE_EXPIRED (idle) while the record is unchanged in the store", async () => {
    const seam = SessionExpirySeam.wrap(h.clock, { environment: "ci" });
    const sessions = new TrustedSessionService({ kv: h.kv, clock: seam, config: h.sessions.config });
    const { sessionRef, ctx } = await verifiedSession();
    expect((await sessions.resolve(sessionRef, mcp())).assurance).toBe("A2");
    const before = h.kv.dump();
    seam.jumpPastExpiry(ctx.expiresAt);
    expect(await reason(sessions.resolve(sessionRef, mcp()))).toBe("SESSION_EXPIRED");
    expect(h.kv.dump()).toBe(before);
    expect(seam.injections).toBe(1);
    seam.reset();
    expect((await sessions.resolve(sessionRef, mcp())).assurance).toBe("A2");
    seam.jumpPastIdle(ctx, h.sessions.config);
    expect(await reason(sessions.resolve(sessionRef, mcp()))).toBe("SESSION_IDLE_EXPIRED");
    // Never in a deployed environment.
    for (const environment of ["sandbox", "staging", "production"] as const) expect(() => SessionExpirySeam.wrap(h.clock, { environment })).toThrow(ConfigurationRejectedError);
    expect(() => seam.advance(-1)).toThrow(RangeError);
  });
});

describe("[FAULT:IDP_UNAVAILABLE seam] caller IdP unavailable during secure-link approval", () => {
  it("[FAULT:IDP_UNAVAILABLE seam][AUTH-01] the binding fails closed with IDP_UNAVAILABLE, assurance stays A0 and no weaker method is substituted", async () => {
    const { sessionRef } = await h.startCall();
    // Labelled unit double: the verifier's key set cannot be fetched (the Layer-2 test stops the real IdP).
    const original = h.oidc.verifyIdToken.bind(h.oidc);
    h.oidc.verifyIdToken = async () => {
      throw new DependencyError("OIDC_JWKS_UNAVAILABLE", "FAILED", true);
    };
    try {
      const v = await h.verifyWithSecureLink(PEOPLE.avery, sessionRef);
      expect(v.result).toMatchObject({ bound: false, reasonCode: "IDP_UNAVAILABLE" });
    } finally {
      h.oidc.verifyIdToken = original;
    }
    expect((await h.sessions.resolve(sessionRef, mcp())).assurance).toBe("A0");
    expect(h.records.some((r) => r.event === "identity.verification.idp_unavailable")).toBe(true);
  });
});
