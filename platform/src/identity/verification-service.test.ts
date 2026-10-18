import { describe, expect, it } from "vitest";
import { CALLS, IDP, PEOPLE } from "../fixtures/synthetic-world.js";
import { hmacHex, sha256Hex } from "../shared/canonical.js";
import { AccessDeniedError, SessionInvalidError, ValidationError } from "../shared/errors.js";
import { newId } from "../shared/ids.js";
import type { DirectoryPersonFixture } from "../adapters/local/identity-directory.js";
import { APPROVED_NOTIFICATION_TEMPLATES, NON_NEUTRAL_TERMS } from "../adapters/local/notification-fixture.js";
import { LOCAL_FIXTURE_OTP_PEPPER, createIdentityHarness, mcp, portal, telephony } from "./identity-harness.fixture.js";
import type { IdentityHarness } from "./identity-harness.fixture.js";
import { kvKeys, sessionBindingRefFor } from "./keys.js";
import { MATCH_CODE_PATTERN, MATCH_CODE_WORDS } from "./match-code.js";
import { effectiveAssuranceFor } from "./verification-service.js";
import type { BeginVerificationInput } from "./ports.js";

const averyLocator = { fullName: PEOPLE.avery.fullName, dateOfBirth: PEOPLE.avery.dateOfBirth };
const blakeLocator = { fullName: PEOPLE.blake.fullName, dateOfBirth: PEOPLE.blake.dateOfBirth };
const AVERY_SMS = PEOPLE.avery.channels[0].channelRef;
const BLAKE_SMS = PEOPLE.blake.channels[0].channelRef;

const AVERY_TWIN: DirectoryPersonFixture = {
  actorId: "act_synthClientAveryTwin",
  accountId: "acc_synthClientAveryTwin",
  subjectId: "sub_synthClientAveryTwin",
  roles: ["client"],
  displayName: "Avery Twin",
  fullName: "AVERY  synthetic-client", // same person-locator after normalisation => "many matches"
  dateOfBirth: PEOPLE.avery.dateOfBirth,
  idpIssuer: IDP.clientIssuer,
  idpSubject: "client|synth-avery-twin",
  channels: [{ channelRef: "chn_synthAveryTwinSms01", kind: "sms", verified: true, changedAt: null }],
  organizationId: null,
  accountState: "ACTIVE",
  portalUsername: null,
};

const reasonOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "NO_ERROR";
  } catch (e) {
    return (e as { reasonCode?: string }).reasonCode ?? "UNTYPED_ERROR";
  }
};

const shape = (o: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(o)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, typeof v === "string" ? (/^vtx_|^otc_/.test(v) ? "<opaque-id>" : MATCH_CODE_PATTERN.test(v) ? "<match-code>" : v) : v]),
  );

/** The audit-only binding an opened transaction reports: call id, NON-bearer binding ref, generation (never the bearer ref). */
const bindingOf = (sessionRef: string, callId: string, sessionGeneration = 1) => ({ callId, sessionBindingRef: sessionBindingRefFor(sessionRef), sessionGeneration });

async function newCall(h: IdentityHarness) {
  return h.startCall(newId("cal"));
}

describe("secure link (preferred verification journey)", () => {
  it("[SPEC-7.VERIFY] exactly-one active candidate is bound at A2 with server-established actor, subject, role and scopes", async () => {
    const h = await createIdentityHarness();
    const { sessionRef } = await h.startCall();
    const { begun, result } = await h.verifyWithSecureLink(PEOPLE.avery, sessionRef);
    expect(begun.response).toBe("IF_ELIGIBLE_A_LINK_WAS_SENT");
    expect(begun.matchCode).toMatch(MATCH_CODE_PATTERN);
    expect(result).toEqual({ bound: true, reasonCode: "VERIFIED", binding: bindingOf(sessionRef, CALLS.primary.callId) });
    expect(JSON.stringify(result)).not.toContain(sessionRef);
    const ctx = await h.sessions.resolve(sessionRef, mcp());
    expect(ctx).toMatchObject({
      actorId: PEOPLE.avery.actorId,
      subjectId: PEOPLE.avery.subjectId,
      selectedRole: "client",
      organizationId: null,
      assurance: "A2",
      verificationMethod: "secure_link_oidc",
      authenticatedAt: h.clock.now().toISOString(),
      sessionGeneration: 1,
      delegatedAuthority: [],
    });
    expect(ctx.permittedScopes).toContain("appointment:read");
    expect((await h.sessions.authGate(sessionRef, telephony())).isAuthenticated).toBe(true);
    expect(h.metrics.counterValue("vsp_identity_verifications_total", { method: "secure_link_oidc", result: "success" })).toBe(1);
  });

  it("[DATA-01] the secure link carries only an opaque transaction id and a nonce fragment: no PHI in the URL", async () => {
    const h = await createIdentityHarness();
    const { ctx } = await h.startCall();
    const begun = await h.verification.beginSecureLink(ctx, { role: "client", locator: averyLocator });
    const msg = h.notifications.lastTo(AVERY_SMS);
    expect(msg?.templateId).toBe("verify.secure_link");
    const path = msg?.slots.linkPath ?? "";
    expect(path).toMatch(/^\/verify\/vtx_[A-Za-z0-9_-]{32}#n=[A-Za-z0-9_-]{43}$/);
    expect(path).toContain(begun.transactionId);
    for (const forbidden of [PEOPLE.avery.fullName, "Avery", PEOPLE.avery.dateOfBirth, "1990", PEOPLE.avery.actorId, PEOPLE.avery.accountId, PEOPLE.avery.subjectId, ctx.sessionRef, ctx.callId]) {
      expect(path).not.toContain(forbidden);
    }
    // The verification store never holds the locator (name, DOB) or the nonce in clear.
    const dump = h.kv.dump();
    for (const forbidden of [PEOPLE.avery.fullName, PEOPLE.avery.dateOfBirth, path.split("#n=")[1] ?? "<none>", ctx.sessionRef, begun.transactionId]) {
      expect(dump).not.toContain(forbidden);
    }
  });

  it("[AUTH-01] name + DOB, caller ID and NPI-like claims never raise assurance; only OIDC secure link or OTP do", async () => {
    const h = await createIdentityHarness();
    const { sessionRef, ctx } = await h.startCall(CALLS.primary.callId, sha256Hex(CALLS.primary.callerIdE164));
    await h.verification.beginSecureLink(ctx, { role: "client", locator: averyLocator });
    expect((await h.sessions.resolve(sessionRef, mcp())).assurance).toBe("A0");
    const provider = await newCall(h);
    await h.verification.beginSecureLink(provider.ctx, { role: "provider", locator: { portalUsernameHint: "morgan.synthetic" } });
    expect((await h.sessions.resolve(provider.sessionRef, mcp())).assurance).toBe("A0");
    // There is no input that can carry an NPI, a phone number or a claimed relationship.
    for (const extra of [{ npi: "1234567893" }, { destinationPhone: "+15555550199" }, { relationship: "parent" }]) {
      const input = { role: "provider", locator: { portalUsernameHint: "morgan.synthetic" }, ...extra } as unknown as BeginVerificationInput;
      await expect(h.verification.beginSecureLink(provider.ctx, input)).rejects.toBeInstanceOf(ValidationError);
    }
    const npiLocator = { role: "provider", locator: { npi: "1234567893" } } as unknown as BeginVerificationInput;
    expect(await reasonOf(h.verification.beginSecureLink(provider.ctx, npiLocator))).toBe("VERIFICATION_INPUT_INVALID");
    expect((await h.sessions.authGate(provider.sessionRef, telephony())).isAuthenticated).toBe(false);
  });

  it("[SPEC-14.ENUMERATION] zero, one and many matches (and ineligible accounts) return identical response objects", async () => {
    const h = await createIdentityHarness({ extraPeople: [AVERY_TWIN] });
    h.directory.setAccountState(PEOPLE.dana.accountId, "LOCKED");
    const cases: [string, BeginVerificationInput][] = [
      ["zero", { role: "client", locator: { fullName: "Nobody Synthetic-Unknown", dateOfBirth: "1999-09-09" } }],
      ["one", { role: "client", locator: blakeLocator }],
      ["many", { role: "client", locator: averyLocator }],
      ["no-channel", { role: "client", locator: { fullName: PEOPLE.casey.fullName, dateOfBirth: PEOPLE.casey.dateOfBirth } }],
      ["locked", { role: "personal_representative", locator: { fullName: PEOPLE.dana.fullName, dateOfBirth: PEOPLE.dana.dateOfBirth } }],
      ["wrong-role", { role: "provider", locator: blakeLocator }],
    ];
    const shapes: unknown[] = [];
    for (const [, input] of cases) {
      const { ctx } = await newCall(h);
      const r = await h.verification.beginSecureLink(ctx, input);
      expect(Object.keys(r).sort()).toEqual(["matchCode", "response", "transactionId"]);
      shapes.push(shape(r));
    }
    for (const s of shapes) expect(s).toEqual(shapes[0]);
    expect(shapes[0]).toEqual({ matchCode: "<match-code>", response: "IF_ELIGIBLE_A_LINK_WAS_SENT", transactionId: "<opaque-id>" });
    // Only the exactly-one eligible candidate actually received a link.
    expect(h.notifications.sent.map((m) => m.channelRef)).toEqual([BLAKE_SMS]);
    // A transaction record exists for every request (decoys included), so storage behaviour is uniform too.
    expect(h.kv.keys().filter((k) => k.startsWith("vtx#"))).toHaveLength(cases.length);
    // Eligibility is never logged.
    const logs = JSON.stringify(h.records);
    expect(logs).not.toMatch(/eligib|CANDIDATE|MATCH_COUNT/i);
  });

  it("[SPEC-14.ENUMERATION] the same applies to OTP begin: identical responses for zero, one, many and risk-blocked", async () => {
    const h = await createIdentityHarness({ extraPeople: [AVERY_TWIN] });
    const inputs: BeginVerificationInput[] = [
      { role: "client", locator: { fullName: "Nobody Synthetic-Unknown", dateOfBirth: "1999-09-09" } },
      { role: "personal_representative", locator: { fullName: PEOPLE.dana.fullName, dateOfBirth: PEOPLE.dana.dateOfBirth } },
      { role: "client", locator: averyLocator },
      { role: "client", locator: blakeLocator }, // recent number change
    ];
    const shapes: unknown[] = [];
    for (const input of inputs) {
      const { ctx } = await newCall(h);
      shapes.push(shape(await h.verification.beginOtp(ctx, input)));
    }
    for (const s of shapes) expect(s).toEqual({ challengeId: "<opaque-id>", response: "IF_ELIGIBLE_A_CODE_WAS_SENT" });
    expect(h.notifications.sent.map((m) => m.channelRef)).toEqual([PEOPLE.dana.channels[0].channelRef]);
  });

  it("[SPEC-14.ENUMERATION] per-session verification attempts are bounded; excess attempts route to a human without a lookup", async () => {
    const h = await createIdentityHarness();
    const { ctx, sessionRef } = await h.startCall();
    for (let i = 0; i < 5; i++) {
      const r = await h.verification.beginSecureLink(ctx, { role: "client", locator: { fullName: `Probe Person ${i}`, dateOfBirth: "1980-01-01" } });
      expect(r.response).toBe("IF_ELIGIBLE_A_LINK_WAS_SENT");
    }
    const lookups = h.directory.lookups;
    const sixth = await h.verification.beginSecureLink(ctx, { role: "client", locator: averyLocator });
    expect(sixth.response).toBe("VERIFICATION_UNAVAILABLE_USE_HUMAN");
    expect(h.directory.lookups).toBe(lookups);
    expect(h.notifications.sent).toHaveLength(0);
    expect((await h.sessions.resolve(sessionRef, mcp())).riskFlags).toContain("ENUMERATION_SUSPECTED");
  });

  it("[SPEC-7.VERIFY] directory outage returns the same unavailable response for everyone (fail closed)", async () => {
    const h = await createIdentityHarness();
    h.directory.setUnavailable(true);
    const { ctx, sessionRef } = await h.startCall();
    const r = await h.verification.beginSecureLink(ctx, { role: "client", locator: averyLocator });
    expect(r.response).toBe("VERIFICATION_UNAVAILABLE_USE_HUMAN");
    expect((await h.sessions.resolve(sessionRef, mcp())).assurance).toBe("A0");
  });

  it("[SPEC-14.REPLAY] a transaction is single use", async () => {
    const h = await createIdentityHarness();
    const { sessionRef } = await h.startCall();
    const { link } = await h.verifyWithSecureLink(PEOPLE.avery, sessionRef);
    const idToken = await h.idp.issueFor(PEOPLE.avery, { nonce: link.nonce });
    expect(await h.verification.completeSecureLink({ ...link, idToken, matchCodeConfirmed: true })).toEqual({ bound: false, reasonCode: "VERIFICATION_TRANSACTION_ALREADY_USED" });
  });

  it("[SPEC-14.REPLAY] concurrent completions of one transaction bind at most once", async () => {
    const h = await createIdentityHarness();
    const { ctx } = await h.startCall();
    await h.verification.beginSecureLink(ctx, { role: "client", locator: averyLocator });
    const link = h.linkFor(AVERY_SMS);
    if (!link) throw new Error("FIXTURE_NO_LINK");
    const tokens = await Promise.all([1, 2, 3].map(() => h.idp.issueFor(PEOPLE.avery, { nonce: link.nonce })));
    const results = await Promise.all(tokens.map((idToken) => h.verification.completeSecureLink({ ...link, idToken, matchCodeConfirmed: true })));
    expect(results.filter((r) => r.bound)).toHaveLength(1);
  });

  it("[SPEC-7.VERIFY] secure-link transactions expire after five minutes", async () => {
    const h = await createIdentityHarness();
    const { ctx, sessionRef } = await h.startCall();
    await h.verification.beginSecureLink(ctx, { role: "client", locator: averyLocator });
    const link = h.linkFor(AVERY_SMS);
    if (!link) throw new Error("FIXTURE_NO_LINK");
    h.clock.advanceSeconds(300);
    const idToken = await h.idp.issueFor(PEOPLE.avery, { nonce: link.nonce });
    expect(await h.verification.completeSecureLink({ ...link, idToken, matchCodeConfirmed: true })).toEqual({ bound: false, reasonCode: "VERIFICATION_TRANSACTION_EXPIRED" });
    expect((await h.sessions.resolve(sessionRef, mcp())).assurance).toBe("A0");
  });

  it("[SPEC-14.FIXATION] completing a transaction after the session generation changed fails", async () => {
    const h = await createIdentityHarness();
    const { ctx, sessionRef } = await h.startCall();
    await h.verification.beginSecureLink(ctx, { role: "client", locator: averyLocator });
    const link = h.linkFor(AVERY_SMS);
    if (!link) throw new Error("FIXTURE_NO_LINK");
    await h.sessions.applyChange(sessionRef, telephony(), { kind: "PARTICIPANT_CHANGED" });
    const idToken = await h.idp.issueFor(PEOPLE.avery, { nonce: link.nonce });
    // The binding names the transaction's own call and generation (1), not the changed session.
    expect(await h.verification.completeSecureLink({ ...link, idToken, matchCodeConfirmed: true })).toEqual({ bound: false, reasonCode: "SESSION_GENERATION_CHANGED", binding: bindingOf(sessionRef, ctx.callId, 1) });
    const after = await h.sessions.resolve(sessionRef, mcp());
    expect(after.assurance).toBe("A0");
    expect(after.actorId).toBeNull();
  });

  it("[SPEC-14.FIXATION] a transaction from call A can never elevate call B", async () => {
    const h = await createIdentityHarness();
    const a = await h.startCall(CALLS.primary.callId);
    const b = await h.startCall(CALLS.concurrent.callId);
    await h.verification.beginSecureLink(a.ctx, { role: "client", locator: averyLocator });
    const link = h.linkFor(AVERY_SMS);
    if (!link) throw new Error("FIXTURE_NO_LINK");
    const idToken = await h.idp.issueFor(PEOPLE.avery, { nonce: link.nonce });
    expect((await h.verification.completeSecureLink({ ...link, idToken, matchCodeConfirmed: true })).bound).toBe(true);
    expect((await h.sessions.resolve(a.sessionRef, mcp())).assurance).toBe("A2");
    expect((await h.sessions.resolve(b.sessionRef, mcp())).assurance).toBe("A0");
    expect((await h.sessions.authGate(b.sessionRef, telephony())).isAuthenticated).toBe(false);

    // And once call A has ended, a pending transaction for A cannot bind anything.
    const c = await h.startCall(CALLS.repeat.callId);
    await h.verification.beginSecureLink(c.ctx, { role: "client", locator: averyLocator });
    const linkC = h.linkFor(AVERY_SMS);
    if (!linkC) throw new Error("FIXTURE_NO_LINK");
    await h.sessions.endCall(c.sessionRef, telephony());
    const tokenC = await h.idp.issueFor(PEOPLE.avery, { nonce: linkC.nonce });
    expect(await h.verification.completeSecureLink({ ...linkC, idToken: tokenC, matchCodeConfirmed: true })).toEqual({ bound: false, reasonCode: "SESSION_ENDED", binding: bindingOf(c.sessionRef, CALLS.repeat.callId) });
  });

  it("[SPEC-14.FIXATION] the person must confirm the match code heard on this call; a refusal burns the transaction", async () => {
    const h = await createIdentityHarness();
    const { ctx, sessionRef } = await h.startCall();
    const begun = await h.verification.beginSecureLink(ctx, { role: "client", locator: averyLocator });
    const link = h.linkFor(AVERY_SMS);
    if (!link) throw new Error("FIXTURE_NO_LINK");
    const shown = await h.verification.describeTransaction(link, portal());
    expect(shown.matchCode).toBe(begun.matchCode);
    const idToken = await h.idp.issueFor(PEOPLE.avery, { nonce: link.nonce });
    expect(await h.verification.completeSecureLink({ ...link, idToken, matchCodeConfirmed: false })).toEqual({ bound: false, reasonCode: "MATCH_CODE_NOT_CONFIRMED", binding: bindingOf(sessionRef, ctx.callId) });
    // A reused (unopened) transaction is never attributed to a call.
    expect(await h.verification.completeSecureLink({ ...link, idToken, matchCodeConfirmed: true })).toEqual({ bound: false, reasonCode: "VERIFICATION_TRANSACTION_ALREADY_USED" });
    expect((await h.sessions.resolve(sessionRef, mcp())).assurance).toBe("A0");
  });

  it("[SPEC-7.VERIFY] portal describe is portal-channel only and indistinguishable for wrong nonce, ineligible or used transactions", async () => {
    const h = await createIdentityHarness();
    const a = await h.startCall();
    await h.verification.beginSecureLink(a.ctx, { role: "client", locator: averyLocator });
    const link = h.linkFor(AVERY_SMS);
    if (!link) throw new Error("FIXTURE_NO_LINK");
    expect(await reasonOf(h.verification.describeTransaction(link, mcp()))).toBe("PORTAL_CHANNEL_REQUIRED");
    expect(await reasonOf(h.verification.describeTransaction({ ...link, nonce: "A".repeat(43) }, portal()))).toBe("VERIFICATION_TRANSACTION_UNAVAILABLE");
    const b = await newCall(h);
    const decoy = await h.verification.beginSecureLink(b.ctx, { role: "client", locator: { fullName: "Nobody", dateOfBirth: "1999-01-01" } });
    expect(await reasonOf(h.verification.describeTransaction({ transactionId: decoy.transactionId, nonce: link.nonce }, portal()))).toBe("VERIFICATION_TRANSACTION_UNAVAILABLE");
  });

  it("[SPEC-7.VERIFY] a wrong nonce is rejected without consuming the transaction", async () => {
    const h = await createIdentityHarness();
    const { ctx } = await h.startCall();
    await h.verification.beginSecureLink(ctx, { role: "client", locator: averyLocator });
    const link = h.linkFor(AVERY_SMS);
    if (!link) throw new Error("FIXTURE_NO_LINK");
    const forged = "B".repeat(43);
    const forgedToken = await h.idp.issueFor(PEOPLE.avery, { nonce: forged });
    expect(await h.verification.completeSecureLink({ transactionId: link.transactionId, nonce: forged, idToken: forgedToken, matchCodeConfirmed: true })).toEqual({
      bound: false,
      reasonCode: "VERIFICATION_NONCE_MISMATCH",
    });
    const idToken = await h.idp.issueFor(PEOPLE.avery, { nonce: link.nonce });
    expect((await h.verification.completeSecureLink({ ...link, idToken, matchCodeConfirmed: true })).bound).toBe(true);
  });

  it("[SPEC-7.VERIFY] ID-token defects fail: no MFA, other person, token nonce mismatch, wrong audience, untrusted key, stale auth", async () => {
    const cases: [string, (h: IdentityHarness, nonce: string) => Promise<string>][] = [
      ["MFA_REQUIRED", (h, nonce) => h.idp.issueFor(PEOPLE.avery, { nonce, amr: ["pwd"] })],
      ["MFA_REQUIRED", (h, nonce) => h.idp.issueFor(PEOPLE.avery, { nonce, amr: null })],
      ["ACTOR_MISMATCH", (h, nonce) => h.idp.issueFor(PEOPLE.blake, { nonce })],
      ["OIDC_NONCE_MISMATCH", (h) => h.idp.issueFor(PEOPLE.avery, { nonce: "C".repeat(43) })],
      ["OIDC_AUDIENCE_MISMATCH", (h, nonce) => h.idp.issueFor(PEOPLE.avery, { nonce, audience: "some-other-client" })],
      ["OIDC_SIGNATURE_INVALID", (h, nonce) => h.idp.issueFor(PEOPLE.avery, { nonce, signWithUntrustedKey: true })],
      ["OIDC_AUTH_TOO_OLD", (h, nonce) => h.idp.issueFor(PEOPLE.avery, { nonce, authTime: Math.floor(h.clock.now().getTime() / 1000) - 1000 })],
      ["OIDC_REQUIRED_CLAIM_MISSING", (h, nonce) => h.idp.issueFor(PEOPLE.avery, { nonce, authTime: null })],
    ];
    for (const [expected, mkToken] of cases) {
      const h = await createIdentityHarness();
      const { ctx, sessionRef } = await h.startCall();
      await h.verification.beginSecureLink(ctx, { role: "client", locator: averyLocator });
      const link = h.linkFor(AVERY_SMS);
      if (!link) throw new Error("FIXTURE_NO_LINK");
      const r = await h.verification.completeSecureLink({ ...link, idToken: await mkToken(h, link.nonce), matchCodeConfirmed: true });
      expect([expected, r.reasonCode]).toEqual([expected, expected]);
      expect(r.bound).toBe(false);
      expect((await h.sessions.resolve(sessionRef, mcp())).assurance).toBe("A0");
    }
  });

  it("[AUTH-04] verification cannot bind a session that expired meanwhile (KV item still present), nor accept OTP on it", async () => {
    const h = await createIdentityHarness({ session: { sessionTtlSeconds: 60 } });
    const { ctx, sessionRef } = await h.startCall();
    await h.verification.beginSecureLink(ctx, { role: "client", locator: averyLocator });
    const link = h.linkFor(AVERY_SMS);
    if (!link) throw new Error("FIXTURE_NO_LINK");
    const otp = await h.verification.beginOtp(ctx, { role: "client", locator: averyLocator });
    const code = h.otpFor(AVERY_SMS) ?? "";
    h.clock.advanceSeconds(61);
    const idToken = await h.idp.issueFor(PEOPLE.avery, { nonce: link.nonce });
    expect(await h.verification.completeSecureLink({ ...link, idToken, matchCodeConfirmed: true })).toEqual({ bound: false, reasonCode: "SESSION_EXPIRED", binding: bindingOf(sessionRef, ctx.callId) });
    expect(await reasonOf(h.verification.submitOtp({ sessionRef, challengeId: otp.challengeId, code }, telephony()))).toBe("SESSION_EXPIRED");
    expect(await h.sessions.store.load(sha256Hex(sessionRef))).not.toBeNull();
    expect((await h.sessions.authGate(sessionRef, telephony())).isAuthenticated).toBe(false);
  });

  it("[SPEC-7.VERIFY] an account locked after the link was sent cannot be bound", async () => {
    const h = await createIdentityHarness();
    const { ctx, sessionRef } = await h.startCall();
    await h.verification.beginSecureLink(ctx, { role: "client", locator: averyLocator });
    const link = h.linkFor(AVERY_SMS);
    if (!link) throw new Error("FIXTURE_NO_LINK");
    h.directory.setAccountState(PEOPLE.avery.accountId, "RECOVERY_IN_PROGRESS");
    const idToken = await h.idp.issueFor(PEOPLE.avery, { nonce: link.nonce });
    expect(await h.verification.completeSecureLink({ ...link, idToken, matchCodeConfirmed: true })).toEqual({ bound: false, reasonCode: "ACCOUNT_NOT_ACTIVE", binding: bindingOf(sessionRef, ctx.callId) });
  });

  it("[AUTH-03] verification cannot silently switch accounts: a second account on the same generation is refused", async () => {
    const h = await createIdentityHarness();
    h.directory.setChannels(PEOPLE.blake.accountId, [{ channelRef: BLAKE_SMS, kind: "sms", verified: true, changedAt: null }]);
    const { sessionRef } = await h.startCall();
    await h.verifyWithSecureLink(PEOPLE.avery, sessionRef);
    const ctx = await h.sessions.resolve(sessionRef, mcp());
    await h.verification.beginSecureLink(ctx, { role: "client", locator: blakeLocator });
    const link = h.linkFor(BLAKE_SMS);
    if (!link) throw new Error("FIXTURE_NO_LINK");
    const idToken = await h.idp.issueFor(PEOPLE.blake, { nonce: link.nonce });
    expect(await h.verification.completeSecureLink({ ...link, idToken, matchCodeConfirmed: true })).toEqual({ bound: false, reasonCode: "ACCOUNT_ALREADY_BOUND", binding: bindingOf(sessionRef, CALLS.primary.callId) });
    expect((await h.sessions.resolve(sessionRef, mcp())).actorId).toBe(PEOPLE.avery.actorId);
  });

  it("[AUTH-03] verification for a role other than the selected role is refused; stale ctx generations are refused", async () => {
    const h = await createIdentityHarness();
    const { sessionRef } = await h.startCall();
    const ctx = await h.sessions.selectRole(sessionRef, mcp(), "provider");
    expect(await reasonOf(h.verification.beginSecureLink(ctx, { role: "client", locator: averyLocator }))).toBe("ROLE_NOT_SELECTED");
    const stale = { ...ctx, sessionGeneration: 1 };
    expect(await reasonOf(h.verification.beginSecureLink(stale, { role: "provider", locator: { portalUsernameHint: "morgan.synthetic" } }))).toBe("SESSION_GENERATION_CHANGED");
    const forged = { ...ctx, sessionRef: newId("ses", 32) };
    await expect(h.verification.beginSecureLink(forged, { role: "provider", locator: { portalUsernameHint: "morgan.synthetic" } })).rejects.toBeInstanceOf(SessionInvalidError);
  });

  it("[SPEC-7.VERIFY] a provider verifies by portal username hint and gets organization from the directory", async () => {
    const h = await createIdentityHarness();
    const { sessionRef } = await h.startCall();
    const { result } = await h.verifyWithSecureLink(PEOPLE.morgan, sessionRef, "provider", PEOPLE.morgan.channels[0].channelRef);
    expect(result.bound).toBe(true);
    const ctx = await h.sessions.resolve(sessionRef, mcp());
    expect(ctx).toMatchObject({ actorId: PEOPLE.morgan.actorId, subjectId: PEOPLE.morgan.subjectId, organizationId: PEOPLE.morgan.organizationId, selectedRole: "provider" });
  });

  it("[SPEC-7.VERIFY] notification failure still returns the generic response and binds nothing", async () => {
    const h = await createIdentityHarness();
    h.notifications.setFailing(true);
    const { ctx, sessionRef } = await h.startCall();
    const r = await h.verification.beginSecureLink(ctx, { role: "client", locator: averyLocator });
    expect(r.response).toBe("IF_ELIGIBLE_A_LINK_WAS_SENT");
    expect((await h.sessions.resolve(sessionRef, mcp())).assurance).toBe("A0");
  });
});

describe("OTP fallback", () => {
  async function beginAveryOtp(h: IdentityHarness, call = newId("cal")) {
    const { ctx, sessionRef } = await h.startCall(call);
    const begun = await h.verification.beginOtp(ctx, { role: "client", locator: averyLocator });
    return { ctx, sessionRef, begun, code: h.otpFor(AVERY_SMS) };
  }

  it("[SPEC-7.OTP] correct code from the isolated DTMF path binds A1 (never A2) with otp_sms_registered_channel", async () => {
    const h = await createIdentityHarness();
    const { sessionRef, begun, code } = await beginAveryOtp(h);
    expect(begun.response).toBe("IF_ELIGIBLE_A_CODE_WAS_SENT");
    expect(code).toMatch(/^\d{6}$/);
    expect(await h.verification.submitOtp({ sessionRef, challengeId: begun.challengeId, code: code ?? "" }, telephony())).toEqual({ verified: true, reasonCode: "VERIFIED" });
    const ctx = await h.sessions.resolve(sessionRef, mcp());
    expect(ctx).toMatchObject({ assurance: "A1", verificationMethod: "otp_sms_registered_channel", actorId: PEOPLE.avery.actorId, permittedScopes: ["case:create"] });
    expect((await h.sessions.authGate(sessionRef, telephony())).isAuthenticated).toBe(false);
    // single use
    expect(await h.verification.submitOtp({ sessionRef, challengeId: begun.challengeId, code: code ?? "" }, telephony())).toEqual({ verified: false, reasonCode: "OTP_CHALLENGE_ALREADY_USED" });
  });

  it("[AUTH-06] submitOtp from the model-facing MCP channel (or any channel but telephony control) is denied", async () => {
    const h = await createIdentityHarness();
    const { sessionRef, begun, code } = await beginAveryOtp(h);
    for (const integ of [mcp(), portal()]) {
      const err = await h.verification.submitOtp({ sessionRef, challengeId: begun.challengeId, code: code ?? "" }, integ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AccessDeniedError);
      expect((err as AccessDeniedError).reasonCode).toBe("OTP_SUBMIT_CHANNEL_NOT_ALLOWED");
    }
    // Denied submissions did not consume an attempt.
    expect((await h.verification.submitOtp({ sessionRef, challengeId: begun.challengeId, code: code ?? "" }, telephony())).verified).toBe(true);
  });

  it("[SPEC-7.OTP] three incorrect attempts lock the challenge; the correct code is then refused", async () => {
    const h = await createIdentityHarness();
    const { sessionRef, begun, code } = await beginAveryOtp(h);
    const wrong = code === "000000" ? "111111" : "000000";
    const r1 = await h.verification.submitOtp({ sessionRef, challengeId: begun.challengeId, code: wrong }, telephony());
    const r2 = await h.verification.submitOtp({ sessionRef, challengeId: begun.challengeId, code: "12a456" }, telephony());
    const r3 = await h.verification.submitOtp({ sessionRef, challengeId: begun.challengeId, code: wrong }, telephony());
    expect([r1.reasonCode, r2.reasonCode, r3.reasonCode]).toEqual(["OTP_INCORRECT", "OTP_INCORRECT", "OTP_CHALLENGE_LOCKED"]);
    expect(await h.verification.submitOtp({ sessionRef, challengeId: begun.challengeId, code: code ?? "" }, telephony())).toEqual({ verified: false, reasonCode: "OTP_CHALLENGE_LOCKED" });
    const ctx = await h.sessions.resolve(sessionRef, mcp());
    expect(ctx.assurance).toBe("A0");
    expect(ctx.riskFlags).toContain("OTP_ABUSE_SUSPECTED");
  });

  it("[SPEC-7.OTP] after a lockout no further codes are sent on the same call (generic response unchanged)", async () => {
    const h = await createIdentityHarness();
    const { ctx, sessionRef, begun, code } = await beginAveryOtp(h);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 3; i++) await h.verification.submitOtp({ sessionRef, challengeId: begun.challengeId, code: wrong }, telephony());
    const sent = h.notifications.sent.length;
    const again = await h.verification.beginOtp(ctx, { role: "client", locator: averyLocator });
    expect(again.response).toBe("IF_ELIGIBLE_A_CODE_WAS_SENT");
    expect(h.notifications.sent.length).toBe(sent);
  });

  it("[SPEC-7.OTP] concurrent wrong guesses cannot exceed the per-challenge attempt limit", async () => {
    const h = await createIdentityHarness();
    const { sessionRef, begun, code } = await beginAveryOtp(h);
    const wrong = code === "000000" ? "111111" : "000000";
    const results = await Promise.all(Array.from({ length: 6 }, () => h.verification.submitOtp({ sessionRef, challengeId: begun.challengeId, code: wrong }, telephony())));
    expect(results.filter((r) => r.reasonCode === "OTP_INCORRECT")).toHaveLength(2);
    expect(results.every((r) => !r.verified)).toBe(true);
  });

  it("[SPEC-7.OTP] [AUTH-ENUM-01] the 6th challenge for one account within an hour is throttled (no code sent, abuse recorded against the account, never on the caller's session); the next hour is allowed", async () => {
    const h = await createIdentityHarness();
    for (let i = 0; i < 5; i++) await beginAveryOtp(h);
    expect(h.notifications.sent).toHaveLength(5);
    const sixth = await beginAveryOtp(h);
    expect(sixth.begun.response).toBe("IF_ELIGIBLE_A_CODE_WAS_SENT");
    expect(h.notifications.sent).toHaveLength(5);
    expect(await h.verification.abuse.count("OTP_ACCOUNT_LIMIT", { kind: "account", id: PEOPLE.avery.accountId })).toBe(1);
    // A session flag here would make policy deny this caller's next begin only because the locator is real.
    expect((await h.sessions.resolve(sixth.sessionRef, mcp())).riskFlags).toEqual([]);
    expect(h.metrics.counterValue("vsp_challenge_abuse_signals_total", { signal: "OTP_ABUSE_SUSPECTED" })).toBeGreaterThan(0);
    h.clock.advanceSeconds(3600);
    await beginAveryOtp(h);
    expect(h.notifications.sent).toHaveLength(6);
  });

  it("[SPEC-7.OTP] five incorrect attempts per account per hour block further challenges for that account", async () => {
    const h = await createIdentityHarness({ verification: { otpMaxPerAccountPerHour: 20 } });
    for (let i = 0; i < 2; i++) {
      const { sessionRef, begun, code } = await beginAveryOtp(h);
      const wrong = code === "000000" ? "111111" : "000000";
      for (let j = 0; j < 3; j++) await h.verification.submitOtp({ sessionRef, challengeId: begun.challengeId, code: wrong }, telephony());
    }
    const sent = h.notifications.sent.length;
    await beginAveryOtp(h);
    expect(h.notifications.sent.length).toBe(sent);
  });

  it("[SPEC-7.OTP] per-destination limit applies across accounts sharing one registered number", async () => {
    const shared: DirectoryPersonFixture = { ...AVERY_TWIN, fullName: "Shared Synthetic-Number", channels: [{ ...PEOPLE.avery.channels[0] }] };
    const h = await createIdentityHarness({ extraPeople: [shared], verification: { otpMaxPerAccountPerHour: 10 } });
    for (let i = 0; i < 3; i++) await beginAveryOtp(h);
    for (let i = 0; i < 3; i++) {
      const { ctx } = await h.startCall(newId("cal"));
      await h.verification.beginOtp(ctx, { role: "client", locator: { fullName: shared.fullName, dateOfBirth: shared.dateOfBirth ?? "" } });
    }
    expect(h.notifications.sent.filter((m) => m.channelRef === AVERY_SMS)).toHaveLength(5);
  });

  it("[SPEC-14.SIM_SWAP] [AUTH-ENUM-01] a recent number change blocks OTP, records RECENT_NUMBER_CHANGE against the account (not on the caller's session) and returns the generic response", async () => {
    const h = await createIdentityHarness();
    const { ctx, sessionRef } = await h.startCall();
    const r = await h.verification.beginOtp(ctx, { role: "client", locator: blakeLocator });
    expect(r.response).toBe("IF_ELIGIBLE_A_CODE_WAS_SENT");
    expect(h.notifications.lastTo(BLAKE_SMS)).toBeNull();
    expect(await h.verification.abuse.count("RECENT_NUMBER_CHANGE", { kind: "account", id: PEOPLE.blake.accountId })).toBe(1);
    expect(h.metrics.counterValue("vsp_challenge_abuse_signals_total", { signal: "RECENT_NUMBER_CHANGE" })).toBe(1);
    const after = await h.sessions.resolve(sessionRef, mcp());
    // The risk signal is account-derived: on the session it would tell this caller the locator is a real person.
    expect(after.riskFlags).not.toContain("RECENT_NUMBER_CHANGE");
    expect(after.assurance).toBe("A0");
    for (const code of ["000000", "123456"]) {
      expect((await h.verification.submitOtp({ sessionRef, challengeId: r.challengeId, code }, telephony())).verified).toBe(false);
    }
    // 30 days after the change the number is no longer "recent".
    h.clock.set("2026-11-16T09:00:01.000Z");
    const later = await h.startCall(newId("cal"));
    await h.verification.beginOtp(later.ctx, { role: "client", locator: blakeLocator });
    expect(h.notifications.lastTo(BLAKE_SMS)?.templateId).toBe("verify.otp_code");
  });

  it("[SPEC-7.OTP] codes go only to an existing verified sms/voice channel from the directory, never to a caller-supplied number", async () => {
    const h = await createIdentityHarness();
    const { ctx } = await h.startCall();
    const withNumber = { role: "client", locator: averyLocator, sendTo: "+15555550199" } as unknown as BeginVerificationInput;
    await expect(h.verification.beginOtp(ctx, withNumber)).rejects.toBeInstanceOf(ValidationError);
    // email-only provider: nothing sent, generic response
    const prov = await h.startCall(newId("cal"));
    const r = await h.verification.beginOtp(prov.ctx, { role: "provider", locator: { portalUsernameHint: "morgan.synthetic" } });
    expect(r.response).toBe("IF_ELIGIBLE_A_CODE_WAS_SENT");
    // unverified sms channel: nothing sent
    h.directory.setChannels(PEOPLE.avery.accountId, [{ ...PEOPLE.avery.channels[0], verified: false }]);
    const un = await h.startCall(newId("cal"));
    await h.verification.beginOtp(un.ctx, { role: "client", locator: averyLocator });
    expect(h.notifications.sent).toHaveLength(0);
    // The sender itself refuses raw numbers and unregistered refs.
    await expect(h.notifications.send({ channelRef: "+15555550199", templateId: "verify.otp_code", slots: { code: "123456", expiryMinutes: "5" }, idempotencyKey: "idem-raw-number" })).rejects.toMatchObject({
      reasonCode: "NOTIFICATION_INPUT_INVALID",
    });
  });

  it("[AUTH-06] the code is stored only as HMAC-SHA256(pepper, challengeId:code) and expires after 300 s", async () => {
    const h = await createIdentityHarness();
    const { sessionRef, begun, code } = await beginAveryOtp(h);
    const item = await h.kv.get<{ codeHmac: string; expiresAt: string }>(kvKeys.otpChallenge(begun.challengeId));
    expect(item?.data.codeHmac).toBe(hmacHex(LOCAL_FIXTURE_OTP_PEPPER, `vsp.otp.v1:${begun.challengeId}:${code}`));
    expect(item?.data.expiresAt).toBe("2026-10-17T15:05:00.000Z");
    expect(h.kv.dump()).not.toContain(`"${code}"`);
    expect(h.kv.dump()).not.toContain(begun.challengeId);
    h.clock.advanceSeconds(300);
    expect(await h.verification.submitOtp({ sessionRef, challengeId: begun.challengeId, code: code ?? "" }, telephony())).toEqual({ verified: false, reasonCode: "OTP_CHALLENGE_EXPIRED" });
  });

  it("[SPEC-14.FIXATION] an OTP challenge is bound to its session and generation", async () => {
    const h = await createIdentityHarness();
    const { sessionRef, begun, code } = await beginAveryOtp(h);
    const other = await h.startCall(newId("cal"));
    expect(await h.verification.submitOtp({ sessionRef: other.sessionRef, challengeId: begun.challengeId, code: code ?? "" }, telephony())).toEqual({ verified: false, reasonCode: "OTP_CHALLENGE_INVALID" });
    await h.sessions.applyChange(sessionRef, telephony(), { kind: "PARTICIPANT_CHANGED" });
    expect(await h.verification.submitOtp({ sessionRef, challengeId: begun.challengeId, code: code ?? "" }, telephony())).toEqual({ verified: false, reasonCode: "OTP_SESSION_CHANGED" });
    expect(await h.verification.submitOtp({ sessionRef, challengeId: newId("otc", 24), code: "123456" }, telephony())).toEqual({ verified: false, reasonCode: "OTP_CHALLENGE_INVALID" });
  });

  it("[SPEC-7.OTP] decoy challenges (no match) behave exactly like a wrong code", async () => {
    const h = await createIdentityHarness();
    const { ctx, sessionRef } = await h.startCall();
    const r = await h.verification.beginOtp(ctx, { role: "client", locator: { fullName: "Nobody Synthetic-Unknown", dateOfBirth: "1999-09-09" } });
    expect(await h.verification.submitOtp({ sessionRef, challengeId: r.challengeId, code: "123456" }, telephony())).toEqual({ verified: false, reasonCode: "OTP_INCORRECT" });
  });

  it("[SPEC-7.OTP] OTP is disabled unless explicitly enabled (TB-03 unknown): uniform unavailable response, nothing sent", async () => {
    const h = await createIdentityHarness({ verification: { otpEnabled: false } });
    const { ctx } = await h.startCall();
    const r = await h.verification.beginOtp(ctx, { role: "client", locator: averyLocator });
    expect(r.response).toBe("VERIFICATION_UNAVAILABLE_USE_HUMAN");
    expect(h.notifications.sent).toHaveLength(0);
  });
});

describe("[AUTH-ENUM-01] no caller-observable state depends on whether the locator is a real person", () => {
  const UNKNOWN = { fullName: "Nobody Synthetic-Unknown", dateOfBirth: "1999-09-09" };
  const AVERY_CHANNELS: readonly string[] = PEOPLE.avery.channels.map((c) => c.channelRef);
  /** Opaque ids and match codes differ per request by construction; everything else must be identical. */
  const norm = (v: unknown): unknown =>
    JSON.parse(JSON.stringify(v), (_k, x: unknown) => (typeof x === "string" ? (/^(vtx|otc)_/.test(x) ? "<opaque-id>" : MATCH_CODE_PATTERN.test(x) ? "<match-code>" : x) : x));
  /** What policy, the handoff package and every later tool call see of the session. */
  async function observe(h: IdentityHarness, sessionRef: string) {
    const c = await h.sessions.resolve(sessionRef, mcp());
    return { riskFlags: [...c.riskFlags].sort(), assurance: c.assurance, sessionGeneration: c.sessionGeneration, actorId: c.actorId, verificationMethod: c.verificationMethod };
  }

  async function secureLinkScript(locator: BeginVerificationInput["locator"]) {
    const h = await createIdentityHarness();
    const transcript: unknown[] = [];
    // Four calls x six begins: past the per-account link limit (5/h) on calls 2-4 and past the per-session limit (5) on every call.
    for (let call = 0; call < 4; call++) {
      const { ctx, sessionRef } = await h.startCall(newId("cal"));
      for (let i = 0; i < 6; i++) {
        transcript.push(norm(await h.verification.beginSecureLink(ctx, { role: "client", locator })));
        transcript.push(await observe(h, sessionRef));
      }
    }
    // Then the finder's probe: a new call asking about someone else.
    const probe = await h.startCall(newId("cal"));
    transcript.push(norm(await h.verification.beginSecureLink(probe.ctx, { role: "client", locator: { fullName: "Probe Synthetic-Other", dateOfBirth: "1970-01-01" } })));
    transcript.push(await observe(h, probe.sessionRef));
    return { h, transcript };
  }

  it("[SPEC-14.ENUMERATION] [AUTH-ENUM-01] secure link: the full result + session sequence for a real and an unknown person is identical past the per-account limit; the account holder still gets at most 5 links an hour", async () => {
    const real = await secureLinkScript(averyLocator);
    const unknown = await secureLinkScript(UNKNOWN);
    expect(real.transcript).toEqual(unknown.transcript);
    expect(real.h.notifications.sent.filter((m) => AVERY_CHANNELS.includes(m.channelRef))).toHaveLength(5);
    expect(unknown.h.notifications.sent).toHaveLength(0);
    // Security monitoring sees the abuse against the account (calls 2-4: 3 x 5 suppressed links).
    expect(await real.h.verification.abuse.count("LINK_ACCOUNT_LIMIT", { kind: "account", id: PEOPLE.avery.accountId })).toBe(15);
    expect(real.h.metrics.counterValue("vsp_challenge_abuse_signals_total", { signal: "OTP_ABUSE_SUSPECTED" })).toBe(15);
    // ...but never in a log line (no eligibility, no account, no session link for the account signal).
    expect(JSON.stringify(real.h.records)).not.toMatch(/LINK_ACCOUNT_LIMIT|acc_synth|eligib/i);
  });

  async function otpScript(locator: BeginVerificationInput["locator"], role: BeginVerificationInput["role"] = "client") {
    const h = await createIdentityHarness();
    const transcript: unknown[] = [];
    const wrongFor = () => {
      const last = PEOPLE.avery.channels.map((c) => h.otpFor(c.channelRef)).find((x) => x !== null) ?? null;
      return last === "000000" ? "111111" : "000000";
    };
    // Four calls; on each: two challenges with two wrong entries each, a submission to the superseded first
    // challenge, then a third challenge whose first wrong entry spends the call's failure budget. Together this
    // passes the per-account send limit, the per-destination limit and the account guess budget for a real person.
    for (let call = 0; call < 4; call++) {
      const { ctx, sessionRef } = await h.startCall(newId("cal"));
      const ids: string[] = [];
      for (let c = 0; c < 3; c++) {
        const begun = await h.verification.beginOtp(ctx, { role, locator });
        ids.push(begun.challengeId);
        transcript.push(norm(begun));
        for (let k = 0; k < (c < 2 ? 2 : 1); k++) transcript.push(await h.verification.submitOtp({ sessionRef, challengeId: begun.challengeId, code: wrongFor() }, telephony()));
        if (c === 1) transcript.push(await h.verification.submitOtp({ sessionRef, challengeId: ids[0] as string, code: wrongFor() }, telephony()));
        transcript.push(await observe(h, sessionRef));
      }
    }
    return { h, transcript };
  }

  it("[SPEC-14.ENUMERATION] [AUTH-ENUM-01] OTP: identical sequences past the per-account, per-destination and account-guess limits; signals go to the account monitor only", async () => {
    const real = await otpScript(averyLocator);
    const unknown = await otpScript(UNKNOWN);
    expect(real.transcript).toEqual(unknown.transcript);
    expect(real.h.notifications.sent.filter((m) => AVERY_CHANNELS.includes(m.channelRef)).length).toBeLessThanOrEqual(5);
    expect(unknown.h.notifications.sent).toHaveLength(0);
    const account = { kind: "account", id: PEOPLE.avery.accountId } as const;
    expect(await real.h.verification.abuse.count("OTP_ACCOUNT_GUESS_LIMIT", account)).toBeGreaterThan(0);
    expect((await real.h.verification.abuse.count("OTP_ACCOUNT_LIMIT", account)) + (await real.h.verification.abuse.count("OTP_ACCOUNT_GUESS_LIMIT", account))).toBeGreaterThan(0);
  });

  it("[SPEC-14.SIM_SWAP] [AUTH-ENUM-01] a recently changed number on a real account leaves the same session state as an unknown person", async () => {
    const run = async (locator: BeginVerificationInput["locator"]) => {
      const h = await createIdentityHarness();
      const { ctx, sessionRef } = await h.startCall();
      const begun = await h.verification.beginOtp(ctx, { role: "client", locator });
      const submitted = await h.verification.submitOtp({ sessionRef, challengeId: begun.challengeId, code: "000000" }, telephony());
      return [norm(begun), submitted, await observe(h, sessionRef), h.notifications.sent.length];
    };
    expect(await run(blakeLocator)).toEqual(await run(UNKNOWN));
  });

  it("[SPEC-14.ENUMERATION] [AUTH-ENUM-01] a directory failure after exactly one candidate was found answers like no match (it can only happen for real people)", async () => {
    const h = await createIdentityHarness();
    const { ctx, sessionRef } = await h.startCall();
    const directory = h.directory as unknown as { accountState: (id: string) => Promise<string> };
    directory.accountState = async () => {
      throw new Error("FIXTURE_PARTIAL_OUTAGE");
    };
    const r = await h.verification.beginSecureLink(ctx, { role: "client", locator: averyLocator });
    const u = await h.verification.beginSecureLink(ctx, { role: "client", locator: UNKNOWN });
    expect(norm(r)).toEqual(norm(u));
    expect(r.response).toBe("IF_ELIGIBLE_A_LINK_WAS_SENT");
    expect(h.notifications.sent).toHaveLength(0);
    expect((await h.sessions.resolve(sessionRef, mcp())).riskFlags).toEqual([]);
  });
});

describe("[AUTH-OTP-LIMIT-01] OTP limits are enforced when digits are submitted, not only when a code is sent", () => {
  const codeOf = (h: IdentityHarness) => h.otpFor(AVERY_SMS) ?? "";
  const wrongOf = (code: string) => (code === "000000" ? "111111" : "000000");

  it("[SPEC-7.OTP] [AUTH-01] [AUTH-OTP-LIMIT-01] at most one outstanding challenge per call: a newer challenge supersedes older ones, which refuse even their correct code without using attempts", async () => {
    const h = await createIdentityHarness();
    const { ctx, sessionRef } = await h.startCall();
    const first = await h.verification.beginOtp(ctx, { role: "client", locator: averyLocator });
    const firstCode = codeOf(h);
    const second = await h.verification.beginOtp(ctx, { role: "client", locator: averyLocator });
    const secondCode = codeOf(h);
    expect(await h.verification.submitOtp({ sessionRef, challengeId: first.challengeId, code: firstCode }, telephony())).toEqual({ verified: false, reasonCode: "OTP_CHALLENGE_SUPERSEDED" });
    expect((await h.sessions.resolve(sessionRef, mcp())).assurance).toBe("A0");
    expect(await h.verification.submitOtp({ sessionRef, challengeId: second.challengeId, code: secondCode }, telephony())).toEqual({ verified: true, reasonCode: "VERIFIED" });
  });

  it("[SPEC-7.OTP] [AUTH-01] [AUTH-OTP-LIMIT-01] five incorrect attempts per account per hour hold at submission across calls: a challenge issued earlier then refuses its correct code; the next hour works", async () => {
    const h = await createIdentityHarness({ verification: { otpMaxPerAccountPerHour: 20 } });
    const issued: { sessionRef: string; challengeId: string; code: string }[] = [];
    for (let i = 0; i < 3; i++) {
      const { ctx, sessionRef } = await h.startCall(newId("cal"));
      const begun = await h.verification.beginOtp(ctx, { role: "client", locator: averyLocator });
      issued.push({ sessionRef, challengeId: begun.challengeId, code: codeOf(h) });
    }
    const [a, b, c] = issued as [(typeof issued)[0], (typeof issued)[0], (typeof issued)[0]];
    for (let k = 0; k < 3; k++) await h.verification.submitOtp({ sessionRef: a.sessionRef, challengeId: a.challengeId, code: wrongOf(a.code) }, telephony());
    for (let k = 0; k < 2; k++) await h.verification.submitOtp({ sessionRef: b.sessionRef, challengeId: b.challengeId, code: wrongOf(b.code) }, telephony());
    // Five incorrect attempts for this account in the hour: the correct code on call C is not even compared.
    const results = [];
    for (let k = 0; k < 3; k++) results.push(await h.verification.submitOtp({ sessionRef: c.sessionRef, challengeId: c.challengeId, code: c.code }, telephony()));
    expect(results.map((r) => r.reasonCode)).toEqual(["OTP_INCORRECT", "OTP_INCORRECT", "OTP_CHALLENGE_LOCKED"]);
    expect(results.some((r) => r.verified)).toBe(false);
    expect((await h.sessions.resolve(c.sessionRef, mcp())).assurance).toBe("A0");
    expect(await h.verification.abuse.count("OTP_ACCOUNT_GUESS_LIMIT", { kind: "account", id: PEOPLE.avery.accountId })).toBe(3);
    // No new code while the budget is spent; the next hourly window restores it.
    const sent = h.notifications.sent.length;
    await h.verification.beginOtp((await h.startCall(newId("cal"))).ctx, { role: "client", locator: averyLocator });
    expect(h.notifications.sent.length).toBe(sent);
    h.clock.advanceSeconds(3600);
    const later = await h.startCall(newId("cal"));
    const fresh = await h.verification.beginOtp(later.ctx, { role: "client", locator: averyLocator });
    expect(await h.verification.submitOtp({ sessionRef: later.sessionRef, challengeId: fresh.challengeId, code: codeOf(h) }, telephony())).toEqual({ verified: true, reasonCode: "VERIFIED" });
  });

  it("[SPEC-7.OTP] [AUTH-OTP-LIMIT-01] concurrent guesses spread over five calls cannot exceed the account budget: no correct code verifies afterwards", async () => {
    const h = await createIdentityHarness({ verification: { otpMaxPerAccountPerHour: 20 } });
    const issued: { sessionRef: string; challengeId: string; code: string }[] = [];
    for (let i = 0; i < 5; i++) {
      const { ctx, sessionRef } = await h.startCall(newId("cal"));
      const begun = await h.verification.beginOtp(ctx, { role: "client", locator: averyLocator });
      issued.push({ sessionRef, challengeId: begun.challengeId, code: codeOf(h) });
    }
    await Promise.all(issued.flatMap((x) => [0, 1].map(() => h.verification.submitOtp({ sessionRef: x.sessionRef, challengeId: x.challengeId, code: wrongOf(x.code) }, telephony()))));
    const finals = await Promise.all(issued.map((x) => h.verification.submitOtp({ sessionRef: x.sessionRef, challengeId: x.challengeId, code: x.code }, telephony())));
    expect(finals.every((r) => !r.verified)).toBe(true);
    // 15 submissions, at most 5 compared: the other 10 were refused by the account budget.
    expect(await h.verification.abuse.count("OTP_ACCOUNT_GUESS_LIMIT", { kind: "account", id: PEOPLE.avery.accountId })).toBe(10);
  });

  it("[SPEC-7.OTP] [AUTH-OTP-LIMIT-01] once the call has five failures (decoy or real challenges alike) or a lockout, no challenge on the call accepts digits", async () => {
    const h = await createIdentityHarness();
    const { ctx, sessionRef } = await h.startCall();
    const nobody = { fullName: "Nobody Synthetic-Unknown", dateOfBirth: "1999-09-09" };
    for (let c = 0; c < 2; c++) {
      const decoy = await h.verification.beginOtp(ctx, { role: "client", locator: nobody });
      for (let k = 0; k < 2; k++) expect((await h.verification.submitOtp({ sessionRef, challengeId: decoy.challengeId, code: "123456" }, telephony())).reasonCode).toBe("OTP_INCORRECT");
    }
    const real = await h.verification.beginOtp(ctx, { role: "client", locator: averyLocator });
    const code = codeOf(h);
    expect(code).toMatch(/^\d{6}$/);
    expect(await h.verification.submitOtp({ sessionRef, challengeId: real.challengeId, code: wrongOf(code) }, telephony())).toEqual({ verified: false, reasonCode: "OTP_CHALLENGE_LOCKED" });
    expect(await h.verification.submitOtp({ sessionRef, challengeId: real.challengeId, code }, telephony())).toEqual({ verified: false, reasonCode: "OTP_CHALLENGE_LOCKED" });
    const after = await h.sessions.resolve(sessionRef, mcp());
    expect(after.assurance).toBe("A0");
    expect(after.riskFlags).toContain("OTP_ABUSE_SUSPECTED");
    // Only one guess on this account was ever compared.
    expect(await h.verification.abuse.count("OTP_ACCOUNT_GUESS_LIMIT", { kind: "account", id: PEOPLE.avery.accountId })).toBe(0);
  });
});

describe("step-up (A3 bound to one prepared action)", () => {
  const DIGEST = sha256Hex("prepared-action-1");
  const OTHER_DIGEST = sha256Hex("prepared-action-2");

  async function a2(h: IdentityHarness) {
    const { sessionRef } = await h.startCall();
    await h.verifyWithSecureLink(PEOPLE.avery, sessionRef);
    return { sessionRef, ctx: await h.sessions.resolve(sessionRef, mcp()) };
  }

  it("[SPEC-7.STEP_UP] requires A2: A0 and A1 sessions are refused", async () => {
    const h = await createIdentityHarness();
    const a0 = await h.startCall();
    expect(await reasonOf(h.verification.beginStepUp(a0.ctx, DIGEST))).toBe("STEP_UP_REQUIRES_A2");
    const b = await h.startCall(newId("cal"));
    const otp = await h.verification.beginOtp(b.ctx, { role: "client", locator: averyLocator });
    await h.verification.submitOtp({ sessionRef: b.sessionRef, challengeId: otp.challengeId, code: h.otpFor(AVERY_SMS) ?? "" }, telephony());
    const a1 = await h.sessions.resolve(b.sessionRef, mcp());
    expect(a1.assurance).toBe("A1");
    expect(await reasonOf(h.verification.beginStepUp(a1, DIGEST))).toBe("STEP_UP_REQUIRES_A2");
    await expect(h.verification.beginStepUp(a1, "not-a-digest")).rejects.toBeInstanceOf(ValidationError);
  });

  it("[SPEC-7.STEP_UP] fresh OIDC auth binds a step-up to exactly one action digest, which expires", async () => {
    const h = await createIdentityHarness();
    const { sessionRef, ctx } = await a2(h);
    const begun = await h.verification.beginStepUp(ctx, DIGEST);
    expect(begun.response).toBe("IF_ELIGIBLE_A_LINK_WAS_SENT");
    expect(h.notifications.lastTo(AVERY_SMS)?.templateId).toBe("verify.step_up_link");
    const link = h.linkFor(AVERY_SMS);
    if (!link) throw new Error("FIXTURE_NO_LINK");
    const idToken = await h.idp.issueFor(PEOPLE.avery, { nonce: link.nonce, amr: ["hwk"] });
    expect(await h.verification.completeStepUp({ ...link, idToken })).toEqual({ bound: true, reasonCode: "STEP_UP_VERIFIED", binding: bindingOf(sessionRef, ctx.callId) });
    const after = await h.sessions.resolve(sessionRef, mcp());
    expect(after.assurance).toBe("A2");
    expect(after.stepUp).toEqual({ actionDigest: DIGEST, verifiedAt: "2026-10-17T15:00:00.000Z", expiresAt: "2026-10-17T15:05:00.000Z" });
    expect(effectiveAssuranceFor(after, DIGEST, h.clock.now())).toBe("A3");
    expect(effectiveAssuranceFor(after, OTHER_DIGEST, h.clock.now())).toBe("A2");
    h.clock.advanceSeconds(300);
    const expired = await h.sessions.resolve(sessionRef, mcp());
    expect(expired.stepUp).toBeNull();
    expect(effectiveAssuranceFor(expired, DIGEST, h.clock.now())).toBe("A2");
  });

  it("[SPEC-7.STEP_UP] an authentication older than 120 s, another person, or a changed generation is refused", async () => {
    {
      const h = await createIdentityHarness();
      const { ctx, sessionRef } = await a2(h);
      await h.verification.beginStepUp(ctx, DIGEST);
      const link = h.linkFor(AVERY_SMS);
      if (!link) throw new Error("FIXTURE_NO_LINK");
      const stale = await h.idp.issueFor(PEOPLE.avery, { nonce: link.nonce, authTime: Math.floor(h.clock.now().getTime() / 1000) - 121 - 5 });
      expect(await h.verification.completeStepUp({ ...link, idToken: stale })).toEqual({ bound: false, reasonCode: "OIDC_AUTH_TOO_OLD", binding: bindingOf(sessionRef, ctx.callId) });
    }
    {
      const h = await createIdentityHarness();
      const { ctx, sessionRef } = await a2(h);
      await h.verification.beginStepUp(ctx, DIGEST);
      const link = h.linkFor(AVERY_SMS);
      if (!link) throw new Error("FIXTURE_NO_LINK");
      const other = await h.idp.issueFor(PEOPLE.blake, { nonce: link.nonce });
      expect(await h.verification.completeStepUp({ ...link, idToken: other })).toEqual({ bound: false, reasonCode: "ACTOR_MISMATCH", binding: bindingOf(sessionRef, ctx.callId) });
    }
    {
      const h = await createIdentityHarness();
      const { ctx, sessionRef } = await a2(h);
      await h.verification.beginStepUp(ctx, DIGEST);
      const link = h.linkFor(AVERY_SMS);
      if (!link) throw new Error("FIXTURE_NO_LINK");
      await h.sessions.applyChange(sessionRef, telephony(), { kind: "RISK_ESCALATION", flag: "FRAUD_REVIEW" });
      const idToken = await h.idp.issueFor(PEOPLE.avery, { nonce: link.nonce });
      expect(await h.verification.completeStepUp({ ...link, idToken })).toEqual({ bound: false, reasonCode: "SESSION_GENERATION_CHANGED", binding: bindingOf(sessionRef, ctx.callId, 1) });
    }
  });

  it("[SPEC-7.STEP_UP] step-up and secure-link transactions are not interchangeable", async () => {
    const h = await createIdentityHarness();
    const { ctx } = await a2(h);
    await h.verification.beginStepUp(ctx, DIGEST);
    const link = h.linkFor(AVERY_SMS);
    if (!link) throw new Error("FIXTURE_NO_LINK");
    const idToken = await h.idp.issueFor(PEOPLE.avery, { nonce: link.nonce });
    expect(await h.verification.completeSecureLink({ ...link, idToken, matchCodeConfirmed: true })).toEqual({ bound: false, reasonCode: "VERIFICATION_TRANSACTION_UNAVAILABLE" });
    expect((await h.verification.completeStepUp({ ...link, idToken })).bound).toBe(true);
  });
});

describe("verification secrets never leak (AUTH-06)", () => {
  it("[AUTH-06] OTP code, DOB, name, nonce, ID token and session ref never appear in any log record or returned object", async () => {
    const h = await createIdentityHarness();
    const returned: unknown[] = [];
    const secrets: string[] = [PEOPLE.avery.dateOfBirth, PEOPLE.avery.fullName, "Synthetic-Client", PEOPLE.blake.dateOfBirth];

    const call1 = await h.startCall();
    secrets.push(call1.sessionRef);
    const otp = await h.verification.beginOtp(call1.ctx, { role: "client", locator: averyLocator });
    returned.push(otp);
    const code = h.otpFor(AVERY_SMS) ?? "";
    secrets.push(code);
    returned.push(await h.verification.submitOtp({ sessionRef: call1.sessionRef, challengeId: otp.challengeId, code: code === "000000" ? "111111" : "000000" }, telephony()));
    returned.push(await h.verification.submitOtp({ sessionRef: call1.sessionRef, challengeId: otp.challengeId, code }, telephony()));
    // validation errors carry no input either
    const vErr = await h.verification.submitOtp({ sessionRef: call1.sessionRef, challengeId: otp.challengeId, code: `${code}${code}${code}` }, telephony()).catch((e: unknown) => e as Error);
    returned.push((vErr as Error).message);

    const call2 = await h.startCall(newId("cal"));
    secrets.push(call2.sessionRef);
    const begun = await h.verification.beginSecureLink(call2.ctx, { role: "client", locator: averyLocator });
    returned.push(begun);
    const link = h.linkFor(AVERY_SMS);
    if (!link) throw new Error("FIXTURE_NO_LINK");
    secrets.push(link.nonce);
    const idToken = await h.idp.issueFor(PEOPLE.avery, { nonce: link.nonce });
    secrets.push(idToken);
    returned.push(await h.verification.completeSecureLink({ ...link, idToken, matchCodeConfirmed: true }));
    returned.push(await h.verification.beginSecureLink(await h.sessions.resolve(call2.sessionRef, mcp()), { role: "client", locator: blakeLocator }));
    returned.push(await h.sessions.resolve(call2.sessionRef, mcp()).then(({ sessionRef: _s, ...rest }) => rest));

    expect(code).toMatch(/^\d{6}$/);
    const logText = JSON.stringify(h.records);
    const returnedText = JSON.stringify(returned);
    for (const s of secrets) {
      expect(logText.includes(s), "log contains a verification secret or PHI").toBe(false);
      expect(returnedText.includes(s), "returned object contains a verification secret or PHI").toBe(false);
    }
    expect(h.records.length).toBeGreaterThan(5);
    expect(logText).not.toContain("[redacted]"); // nothing sensitive was even attempted
  });

  it("[AUTH-06] notification text is neutral: no services, clinical terms or account facts in any approved template", async () => {
    const sample: Record<string, string> = { linkPath: `/verify/${newId("vtx", 24)}#n=${"A".repeat(43)}`, code: "123456", expiryMinutes: "5" };
    for (const [id, t] of Object.entries(APPROVED_NOTIFICATION_TEMPLATES)) {
      const slots = Object.fromEntries(Object.keys(t.slots).map((k) => [k, sample[k] ?? ""]));
      const text = t.render(slots).toLowerCase();
      for (const term of NON_NEUTRAL_TERMS) expect([id, text.includes(term)]).toEqual([id, false]);
    }
    const h = await createIdentityHarness();
    const { ctx } = await h.startCall();
    await h.verification.beginSecureLink(ctx, { role: "client", locator: averyLocator });
    for (const m of h.notifications.sent) {
      expect(m.text).not.toContain(PEOPLE.avery.displayName);
      for (const term of NON_NEUTRAL_TERMS) expect(m.text.toLowerCase()).not.toContain(term);
    }
  });

  it("[SPEC-7.VERIFY] match-code word list is fixed, unique and lower-case; codes use two distinct words", async () => {
    expect(MATCH_CODE_WORDS).toHaveLength(256);
    expect(new Set(MATCH_CODE_WORDS).size).toBe(256);
    for (const w of MATCH_CODE_WORDS) expect(w).toMatch(/^[a-z]{3,10}$/);
    const h = await createIdentityHarness();
    const codes = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const { ctx } = await h.startCall(newId("cal"));
      const r = await h.verification.beginSecureLink(ctx, { role: "client", locator: { fullName: "Nobody", dateOfBirth: "1999-01-01" } });
      const [a, b] = r.matchCode.split("-");
      expect(a).not.toBe(b);
      codes.add(r.matchCode);
    }
    expect(codes.size).toBeGreaterThan(1);
  });
});
