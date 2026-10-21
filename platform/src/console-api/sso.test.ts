/**
 * Console workforce SSO (WP-05) through the console HTTP endpoints over real modules (PGlite with every
 * migration, PgConsoleSessionStore, AesGcmTokenSealer, OidcGroupStaffDirectory, WorkforceTokenVerifier,
 * OPA policy) and the LOCAL TEST FIXTURE workforce provider behind WorkforceOidcPort
 * (fixtures/workforce-oidc.fixture.ts). The same console code runs against Keycloak over the live
 * adapter in Layer 2 (platform/test/integration/identity). SYNTHETIC identities only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createConsoleHarness, workforceGroupFor } from "./fixtures/harness.fixture.js";
import type { ConsoleHarness, HarnessWorkforce } from "./fixtures/harness.fixture.js";
import { WORKFORCE_FIXTURE_REDIRECT, WORKFORCE_FIXTURE_REDIRECT_ALT, pkcePair } from "./fixtures/workforce-oidc.fixture.js";
import { oidcEgressRefusal } from "../adapters/live/oidc-http.js";
import { consoleSessionHash } from "./sessions.js";

let h: ConsoleHarness;
let wf: HarnessWorkforce;
beforeAll(async () => {
  h = await createConsoleHarness({ sso: true });
  if (!h.workforce) throw new Error("harness without SSO");
  wf = h.workforce;
});
afterAll(async () => {
  await h.close();
});

const errorOf = (body: string): { reasonCode: string; retryable: boolean } => (JSON.parse(body) as { error: { reasonCode: string; retryable: boolean } }).error;
const me = (token: string) => h.call("me", { token });

/** The IdP refresh token sealed in THIS console session's row (opened with the harness sealer). */
async function sealedRefreshTokenOf(hh: ConsoleHarness, token: string): Promise<string> {
  const r = await hh.db.query<{ refresh_ciphertext: Uint8Array; refresh_iv: Uint8Array; refresh_tag: Uint8Array; refresh_key_id: string }>(
    "select refresh_ciphertext, refresh_iv, refresh_tag, refresh_key_id from console_sessions where session_hash = $1",
    [consoleSessionHash(token)],
  );
  const row = r.rows[0];
  const w = hh.workforce;
  if (!row || !w) throw new Error("session row or workforce wiring missing");
  return w.sealer.open({ ciphertext: Buffer.from(row.refresh_ciphertext), iv: Buffer.from(row.refresh_iv), tag: Buffer.from(row.refresh_tag), keyId: row.refresh_key_id }, consoleSessionHash(token));
}

async function startLogin(subjectKey: Parameters<HarnessWorkforce["subjectOf"]>[0]) {
  const { verifier, challenge } = pkcePair();
  const start = await h.call("auth.oidcStart", { body: { redirectUri: WORKFORCE_FIXTURE_REDIRECT, codeChallenge: challenge, codeChallengeMethod: "S256" } });
  expect(start.statusCode).toBe(200);
  const s = JSON.parse(start.body) as { authorizationUrl: string; state: string };
  const { code, state } = wf.idp.login(s.authorizationUrl, wf.subjectOf(subjectKey));
  return { verifier, challenge, code, state, authorizationUrl: s.authorizationUrl };
}

describe("[FO-05-41][FO-14-02] backend authorization-code exchange with PKCE", () => {
  it("[FO-05-09][FO-05-10][AUTH-01] the browser gets an opaque console session; IdP tokens, state and nonce never leave the backend; roles come from IdP groups", async () => {
    const l = await startLogin("supervisor");
    const url = new URL(l.authorizationUrl);
    // The authorization request carries a backend nonce and the browser's S256 challenge, never a verifier.
    expect(url.searchParams.get("code_challenge")).toBe(l.challenge);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("nonce")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const ex = await h.call("auth.oidcExchange", { body: { code: l.code, state: l.state, codeVerifier: l.verifier, redirectUri: WORKFORCE_FIXTURE_REDIRECT } });
    expect(ex.statusCode).toBe(200);
    const t = JSON.parse(ex.body) as Record<string, unknown>;
    expect(Object.keys(t).sort()).toEqual(["accessToken", "expiresAt", "idleTimeoutSeconds", "localFixture", "sessionKind", "tokenType"]);
    expect(t).toMatchObject({ tokenType: "Bearer", sessionKind: "OIDC_SSO", localFixture: false, idleTimeoutSeconds: 900 });
    expect(String(t.accessToken)).toMatch(/^vcs_[A-Za-z0-9_-]{43}$/);
    const m = JSON.parse((await me(String(t.accessToken))).body) as { staff: { staffId: string; roles: string[] }; sessionKind: string; idleTimeoutSeconds: number };
    expect(m).toMatchObject({ sessionKind: "OIDC_SSO", idleTimeoutSeconds: 900, staff: { staffId: wf.staffIdOf("supervisor"), roles: ["supervisor"] } });
    // Stored server side: hashes only, the refresh token sealed (never the raw value).
    const row = await h.db.query<{ refresh_ciphertext: string | null; subject_digest: string }>("select refresh_ciphertext, subject_digest from console_sessions where session_hash = $1", [consoleSessionHash(String(t.accessToken))]);
    expect(row.rows[0]?.refresh_ciphertext).toBeTruthy();
    expect(row.rows[0]?.subject_digest).toMatch(/^[0-9a-f]{64}$/);
    const audit = await h.db.query<{ outcome: string; reason_code: string }>("select outcome, event->>'reasonCode' as reason_code from audit_outbox where action = 'console.auth.oidc_exchange' and event->>'actorRef' = $1", [wf.staffIdOf("supervisor")]);
    expect(audit.rows).toContainEqual({ outcome: "SUCCEEDED", reason_code: "WORKFORCE_SSO_SIGN_IN" });
  });

  it("[FO-05-11][FO-05-10] a replayed callback (state reuse) and a replayed code are refused; a wrong PKCE verifier never reaches the IdP", async () => {
    const l = await startLogin("agent");
    const body = { code: l.code, state: l.state, codeVerifier: l.verifier, redirectUri: WORKFORCE_FIXTURE_REDIRECT };
    expect((await h.call("auth.oidcExchange", { body })).statusCode).toBe(200);
    const replay = await h.call("auth.oidcExchange", { body });
    expect(replay.statusCode).toBe(401);
    expect(errorOf(replay.body).reasonCode).toBe("LOGIN_TRANSACTION_UNAVAILABLE");
    // The same code under a fresh login transaction is refused by the provider (single-use code).
    const fresh = await startLogin("agent");
    const reused = await h.call("auth.oidcExchange", { body: { ...body, state: fresh.state, codeVerifier: fresh.verifier } });
    expect(reused.statusCode).toBe(401);
    expect(errorOf(reused.body).reasonCode).toBe("OIDC_GRANT_INVALID");
    // Wrong verifier: refused before the token endpoint is called.
    const third = await startLogin("agent");
    const before = wf.idp.calls.filter((c) => c === "token:authorization_code").length;
    const wrong = await h.call("auth.oidcExchange", { body: { code: third.code, state: third.state, codeVerifier: pkcePair().verifier, redirectUri: WORKFORCE_FIXTURE_REDIRECT } });
    expect(wrong.statusCode).toBe(401);
    expect(errorOf(wrong.body).reasonCode).toBe("PKCE_VERIFIER_MISMATCH");
    expect(wf.idp.calls.filter((c) => c === "token:authorization_code").length).toBe(before);
    // A forged state is refused.
    const forged = await h.call("auth.oidcExchange", { body: { ...body, state: "A".repeat(43) } });
    expect(errorOf(forged.body).reasonCode).toBe("LOGIN_TRANSACTION_UNAVAILABLE");
  });

  it("[FO-05-13] callback allowlist: an unknown redirect is refused at start and at exchange; a redirect other than the bound one is refused", async () => {
    const { challenge } = pkcePair();
    for (const redirectUri of ["https://console.vsp-local.test/auth/callback/", "https://evil.vsp-local.test/auth/callback", "https://console.vsp-local.test/auth/callback?x=1"]) {
      const r = await h.call("auth.oidcStart", { body: { redirectUri, codeChallenge: challenge, codeChallengeMethod: "S256" } });
      expect(r.statusCode, redirectUri).toBe(400);
      expect(errorOf(r.body).reasonCode, redirectUri).toBe("REDIRECT_URI_NOT_ALLOWED");
    }
    const l = await startLogin("agent");
    const bad = await h.call("auth.oidcExchange", { body: { code: l.code, state: l.state, codeVerifier: l.verifier, redirectUri: "https://evil.vsp-local.test/auth/callback" } });
    expect(bad.statusCode).toBe(400);
    expect(errorOf(bad.body).reasonCode).toBe("REDIRECT_URI_NOT_ALLOWED");
    // Both redirects are allowlisted, but the callback is bound to the one the login started with: the
    // backend refuses before the code reaches the IdP, and the transaction is spent.
    const other = await startLogin("agent");
    const callsBefore = wf.idp.calls.length;
    const switched = await h.call("auth.oidcExchange", { body: { code: other.code, state: other.state, codeVerifier: other.verifier, redirectUri: WORKFORCE_FIXTURE_REDIRECT_ALT } });
    expect(switched.statusCode).toBe(400);
    expect(errorOf(switched.body).reasonCode).toBe("REDIRECT_URI_MISMATCH");
    expect(wf.idp.calls.slice(callsBefore)).not.toContain("token:authorization_code");
    const retry = await h.call("auth.oidcExchange", { body: { code: other.code, state: other.state, codeVerifier: other.verifier, redirectUri: WORKFORCE_FIXTURE_REDIRECT } });
    expect(errorOf(retry.body).reasonCode).toBe("LOGIN_TRANSACTION_UNAVAILABLE");
  });

  it("[FO-05-41][AUTH-01] MFA amr is required and an unknown managed group refuses sign-in (directory drift fails closed)", async () => {
    wf.idp.addUser({ subject: "wf-pwd-only", groups: [workforceGroupFor("supervisor")], active: true, amr: ["pwd"] });
    wf.idp.addUser({ subject: "wf-drift", groups: [workforceGroupFor("supervisor"), "/vsp/retired-role"], active: true, amr: ["pwd", "otp"] });
    wf.idp.addUser({ subject: "wf-nogroups", groups: ["/other/team"], active: true, amr: ["pwd", "otp"] });
    for (const [subject, reason] of [["wf-pwd-only", "STAFF_MFA_REQUIRED"], ["wf-drift", "STAFF_GROUP_UNKNOWN"], ["wf-nogroups", "STAFF_NOT_PROVISIONED"]] as const) {
      const { verifier, challenge } = pkcePair();
      const s = JSON.parse((await h.call("auth.oidcStart", { body: { redirectUri: WORKFORCE_FIXTURE_REDIRECT, codeChallenge: challenge, codeChallengeMethod: "S256" } })).body) as { authorizationUrl: string };
      const { code, state } = wf.idp.login(s.authorizationUrl, subject);
      const r = await h.call("auth.oidcExchange", { body: { code, state, codeVerifier: verifier, redirectUri: WORKFORCE_FIXTURE_REDIRECT } });
      expect(r.statusCode, subject).toBe(401);
      expect(errorOf(r.body).reasonCode, subject).toBe(reason);
    }
  });
});

describe("[FO-05-18][AUTH-04] idle and absolute expiry, enforced on every use", () => {
  it("[FO-05-18][AUTH-04] use within the idle window keeps the session; idle beyond it ends the session (revoked, not resumable)", async () => {
    const s = await wf.signIn("deployOperator");
    for (let i = 0; i < 3; i++) {
      h.clock.advanceSeconds(600);
      expect((await me(s.token)).statusCode, `use ${i}`).toBe(200);
    }
    h.clock.advanceSeconds(901);
    const r = await me(s.token);
    expect(r.statusCode).toBe(401);
    expect(errorOf(r.body).reasonCode).toBe("SESSION_IDLE_EXPIRED");
    const row = await h.db.query<{ revoke_reason: string }>("select revoke_reason from console_sessions where session_hash = $1", [consoleSessionHash(s.token)]);
    expect(row.rows[0]?.revoke_reason).toBe("SESSION_IDLE_EXPIRED");
    // Revoked: coming back within what would have been a window does not resurrect it.
    expect(errorOf((await me(s.token)).body).reasonCode).toBe("SESSION_REVOKED");
    const refresh = await h.call("auth.refresh", { headers: { authorization: `Bearer ${s.token}` } });
    expect(refresh.statusCode).toBe(401);
  });

  it("[FO-05-18] the absolute lifetime ends the session even with continuous use", async () => {
    const s = await wf.signIn("knowledgeEditor");
    let last = 200;
    for (let elapsed = 0; elapsed <= 28_800 && last === 200; elapsed += 800) {
      h.clock.advanceSeconds(800);
      last = (await me(s.token)).statusCode;
    }
    expect(last).toBe(401);
  });
});

describe("[FO-05-19][FO-01-31] same-actor refresh with rotation", () => {
  it("[FO-05-19] refresh rotates the bearer, keeps the subject and does not extend the idle window; a superseded bearer replayed after the grace revokes the family", async () => {
    const s = await wf.signIn("policyApprover");
    h.clock.advanceSeconds(300);
    const r = await h.call("auth.refresh", { headers: { authorization: `Bearer ${s.token}` } });
    expect(r.statusCode).toBe(200);
    const next = JSON.parse(r.body) as { accessToken: string; sessionKind: string };
    expect(next.accessToken).not.toBe(s.token);
    expect(JSON.parse((await me(next.accessToken)).body).staff.staffId).toBe(wf.staffIdOf("policyApprover"));
    // In-flight use of the old bearer inside the grace: retryable refusal, not a replay.
    const inGrace = await me(s.token);
    expect(errorOf(inGrace.body)).toMatchObject({ reasonCode: "SESSION_ROTATED", retryable: true });
    // Refresh is not activity: idle expiry counts from the last real use.
    const lastUse = h.clock.now().getTime();
    h.clock.advanceSeconds(800);
    const r2 = await h.call("auth.refresh", { headers: { authorization: `Bearer ${next.accessToken}` } });
    expect(r2.statusCode).toBe(200);
    const third = (JSON.parse(r2.body) as { accessToken: string }).accessToken;
    h.clock.set(new Date(lastUse + 901_000));
    expect(errorOf((await me(third)).body).reasonCode).toBe("SESSION_IDLE_EXPIRED");
    // Replay of a superseded bearer after the grace revokes the whole family and the provider refresh tokens.
    const s2 = await wf.signIn("policyApprover");
    const rot = JSON.parse((await h.call("auth.refresh", { headers: { authorization: `Bearer ${s2.token}` } })).body) as { accessToken: string };
    h.clock.advanceSeconds(30);
    const replay = await me(s2.token);
    expect(errorOf(replay.body).reasonCode).toBe("SESSION_TOKEN_REPLAYED");
    expect(errorOf((await me(rot.accessToken)).body).reasonCode).toBe("SESSION_REVOKED");
  });

  it("[FO-05-19][AUTH-01] a refresh that returns a different subject is never adopted: the family is revoked", async () => {
    const s = await wf.signIn("auditor");
    wf.idp.switchSubjectOnRefresh = wf.subjectOf("securityAdmin");
    const r = await h.call("auth.refresh", { headers: { authorization: `Bearer ${s.token}` } });
    expect(r.statusCode).toBe(401);
    expect(errorOf(r.body).reasonCode).toBe("SESSION_SUBJECT_CHANGED");
    expect(errorOf((await me(s.token)).body).reasonCode).toBe("SESSION_REVOKED");
    const audit = await h.db.query<{ n: number }>("select count(*)::int as n from audit_outbox where action = 'console.auth.session_revoked' and event->>'reasonCode' = 'SESSION_SUBJECT_CHANGED'");
    expect(audit.rows[0]?.n).toBeGreaterThan(0);
  });

  it("[FO-05-19][AUTH-03] defence in depth: even a port that skips its own subject check cannot switch the actor on refresh", async () => {
    const s = await wf.signIn("auditor");
    wf.idp.skipExpectedSubjectCheck = true;
    wf.idp.switchSubjectOnRefresh = wf.subjectOf("securityAdmin");
    try {
      const r = await h.call("auth.refresh", { headers: { authorization: `Bearer ${s.token}` } });
      expect(r.statusCode).toBe(401);
      expect(errorOf(r.body).reasonCode).toBe("SESSION_SUBJECT_CHANGED");
      expect(errorOf((await me(s.token)).body).reasonCode).toBe("SESSION_REVOKED");
    } finally {
      wf.idp.skipExpectedSubjectCheck = false;
    }
  });
});

describe("[FO-14-52] operator offboarding through the IdP active state", () => {
  it("[FO-14-52][AUTH-04] a user disabled at the IdP loses the session at the next active-state check, with or without a request; role changes in the IdP take effect", async () => {
    const s = await wf.signIn("safety");
    // Role change at the IdP: picked up at the next check.
    const user = wf.idp.users.get(wf.subjectOf("safety"));
    if (!user) throw new Error("fixture user missing");
    user.groups = [workforceGroupFor("safety_responder"), workforceGroupFor("supervisor")];
    h.clock.advanceSeconds(61);
    const m = JSON.parse((await me(s.token)).body) as { staff: { roles: string[] } };
    expect(m.staff.roles.sort()).toEqual(["safety_responder", "supervisor"]);
    // Offboarding: disabled -> the sweeper revokes without any console request.
    user.active = false;
    h.clock.advanceSeconds(61);
    const swept = await wf.service.sweep();
    expect(swept.revoked).toBeGreaterThan(0);
    const r = await me(s.token);
    expect(r.statusCode).toBe(401);
    expect(errorOf(r.body).reasonCode).toBe("SESSION_REVOKED");
    const row = await h.db.query<{ revoke_reason: string }>("select revoke_reason from console_sessions where session_hash = $1", [consoleSessionHash(s.token)]);
    expect(row.rows[0]?.revoke_reason).toBe("STAFF_DEPROVISIONED");
    // A disabled user cannot sign in again (the provider refuses the code).
    await expect(wf.signIn("safety")).rejects.toThrow(/HARNESS_SSO_EXCHANGE_FAILED 401/);
    user.active = true;
    user.groups = [workforceGroupFor("safety_responder")];
  });

  it("[FO-14-52][FO-19-07][AUTH-04] a user removed from every managed group (account still enabled, groups claim ABSENT) loses the session at the next check and in the sweep", async () => {
    const user = wf.idp.users.get(wf.subjectOf("supervisor"));
    if (!user) throw new Error("fixture user missing");
    const groups = [...user.groups];
    try {
      // Through a request: the IdP still says active, but omits the groups claim (no groups left).
      const viaRequest = await wf.signIn("supervisor");
      user.groups = [];
      h.clock.advanceSeconds(61);
      const r = await me(viaRequest.token);
      expect(r.statusCode).toBe(401);
      expect(errorOf(r.body).reasonCode).toBe("STAFF_NOT_PROVISIONED");
      const row = await h.db.query<{ revoke_reason: string }>("select revoke_reason from console_sessions where session_hash = $1", [consoleSessionHash(viaRequest.token)]);
      expect(row.rows[0]?.revoke_reason).toBe("STAFF_NOT_PROVISIONED");
      // Through the sweeper, without any console request.
      user.groups = groups;
      const viaSweep = await wf.signIn("supervisor");
      user.groups = [];
      h.clock.advanceSeconds(61);
      const swept = await wf.service.sweep();
      expect(swept.revoked).toBeGreaterThan(0);
      const after = await me(viaSweep.token);
      expect(errorOf(after.body).reasonCode).toBe("SESSION_REVOKED");
      const swRow = await h.db.query<{ revoke_reason: string }>("select revoke_reason from console_sessions where session_hash = $1", [consoleSessionHash(viaSweep.token)]);
      expect(swRow.rows[0]?.revoke_reason).toBe("STAFF_NOT_PROVISIONED");
      // And a zero-group user cannot sign in again.
      await expect(wf.signIn("supervisor")).rejects.toThrow(/HARNESS_SSO_EXCHANGE_FAILED 401/);
    } finally {
      user.groups = groups;
    }
  });

  it("[FO-05-19][AUTH-03] an active-state answer about another subject is never adopted: the family is revoked", async () => {
    const s = await wf.signIn("auditor");
    wf.idp.introspectAs = wf.subjectOf("securityAdmin");
    try {
      h.clock.advanceSeconds(61);
      const r = await me(s.token);
      expect(r.statusCode).toBe(401);
      expect(errorOf(r.body).reasonCode).toBe("SESSION_SUBJECT_CHANGED");
    } finally {
      wf.idp.introspectAs = null;
    }
    expect(errorOf((await me(s.token)).body).reasonCode).toBe("SESSION_REVOKED");
  });

  it("[FO-14-52] logout revokes the session family and the IdP refresh token of THIS sign-in (and only its family)", async () => {
    const other = await wf.signIn("securityAdmin");
    const s = await wf.signIn("securityAdmin");
    const mine = await sealedRefreshTokenOf(h, s.token);
    const theirs = await sealedRefreshTokenOf(h, other.token);
    expect(wf.idp.familyStateOf(mine)).toEqual(["ACTIVE"]);
    expect((await h.call("auth.logout", { token: s.token })).statusCode).toBe(200);
    expect(errorOf((await me(s.token)).body).reasonCode).toBe("SESSION_REVOKED");
    // The IdP no longer honours this session's own refresh token (RFC 7009 revocation reached the provider)...
    expect(wf.idp.refreshTokenState(mine)).toBe("REVOKED");
    expect(wf.idp.familyStateOf(mine)).toEqual(["REVOKED"]);
    await expect(wf.idp.refresh({ refreshToken: mine, expected: { isSameSubject: () => true, authTime: null, nonceHash: null } })).rejects.toMatchObject({ reasonCode: "OIDC_GRANT_INVALID" });
    // ...while another sign-in of the same person keeps its own family and session.
    expect(wf.idp.refreshTokenState(theirs)).toBe("ACTIVE");
    expect((await me(other.token)).statusCode).toBe(200);
  });
});

describe("[FAULT:IDP_UNAVAILABLE seam] workforce IdP outage", () => {
  it("[FAULT:IDP_UNAVAILABLE seam][OPS-01] sign-in fails closed as unavailable (never as a bad password); live sessions keep working only within the staleness bound", async () => {
    const s = await wf.signIn("agent");
    wf.idp.unavailable = true;
    try {
      const { challenge } = pkcePair();
      const start = await h.call("auth.oidcStart", { body: { redirectUri: WORKFORCE_FIXTURE_REDIRECT, codeChallenge: challenge, codeChallengeMethod: "S256" } });
      expect(start.statusCode).toBe(503);
      expect(errorOf(start.body)).toMatchObject({ reasonCode: "WORKFORCE_IDP_UNAVAILABLE", retryable: true });
      const cfg = JSON.parse((await h.call("auth.config")).body) as { oidc: { authorizationEndpoint: string | null; blockedReasonCode: string | null } };
      expect(cfg.oidc).toMatchObject({ authorizationEndpoint: null, blockedReasonCode: "WORKFORCE_IDP_UNAVAILABLE" });
      // Within the staleness bound (300 s past the last check) the session works; beyond it, fail closed.
      for (let i = 0; i < 4; i++) {
        h.clock.advanceSeconds(70);
        expect((await me(s.token)).statusCode, `within bound ${i}`).toBe(200);
      }
      h.clock.advanceSeconds(70);
      const r = await me(s.token);
      expect(r.statusCode).toBe(503);
      expect(errorOf(r.body).reasonCode).toBe("STAFF_ACTIVE_STATE_UNVERIFIED");
      const refresh = await h.call("auth.refresh", { headers: { authorization: `Bearer ${s.token}` } });
      expect(refresh.statusCode).toBe(503);
    } finally {
      wf.idp.unavailable = false;
    }
    // Recovered IdP: the session resumes (it was never revoked by the outage).
    expect((await me(s.token)).statusCode).toBe(200);
  });
});

describe("[STRIDE-D] bounds of the unauthenticated workforce auth endpoints", () => {
  it("[FO-05-10][OPS-01][STRIDE-D] an anonymous flood of sign-in starts stores nothing and cannot lock operators out: a legitimate sign-in started DURING the flood succeeds; forged, altered, foreign and replayed states are refused without an audit event per request; the sweeper purges used states after expiry", async () => {
    const small = await createConsoleHarness({ sso: { config: { loginTransactionTtlSeconds: 60 } } });
    try {
      const w = small.workforce;
      if (!w) throw new Error("harness without SSO");
      const rows = async () => (await small.db.query<{ n: number }>("select count(*)::int as n from console_login_transactions")).rows[0]?.n ?? 0;
      const anonymousStart = () => small.call("auth.oidcStart", { body: { redirectUri: WORKFORCE_FIXTURE_REDIRECT, codeChallenge: pkcePair().challenge, codeChallengeMethod: "S256" } });
      // The flood (no IdP interaction, no client identity) and the operator's own sign-in run concurrently.
      const legit = (async () => {
        const pair = pkcePair();
        const st = await small.call("auth.oidcStart", { body: { redirectUri: WORKFORCE_FIXTURE_REDIRECT, codeChallenge: pair.challenge, codeChallengeMethod: "S256" } });
        expect(st.statusCode).toBe(200);
        const { code, state } = w.idp.login((JSON.parse(st.body) as { authorizationUrl: string }).authorizationUrl, w.subjectOf("supervisor"));
        return small.call("auth.oidcExchange", { body: { code, state, codeVerifier: pair.verifier, redirectUri: WORKFORCE_FIXTURE_REDIRECT } });
      })();
      const flood = Array.from({ length: 1_500 }, () => anonymousStart());
      const [signedIn, ...flooded] = await Promise.all([legit, ...flood]);
      expect(signedIn?.statusCode, signedIn?.body).toBe(200);
      expect(flooded.every((r) => r.statusCode === 200)).toBe(true);
      // The unauthenticated start wrote nothing; the one exchange recorded its single use.
      expect(await rows()).toBe(1);
      // Another start after the flood still works, and so does a sign-in 59 s later.
      small.clock.advanceSeconds(59);
      expect((await w.signIn("supervisor")).token).toMatch(/^vcs_/);
      expect(await rows()).toBe(2);
      const audits = async () => (await small.db.query<{ n: number }>("select count(*)::int as n from audit_outbox where action = 'console.auth.oidc_exchange'")).rows[0]?.n ?? 0;
      const before = await audits();
      const exchange = (state: string, verifier = pkcePair().verifier) => small.call("auth.oidcExchange", { body: { code: "synthetic-code-unknown-state", state, codeVerifier: verifier, redirectUri: WORKFORCE_FIXTURE_REDIRECT } });
      const issued = JSON.parse((await anonymousStart()).body) as { state: string };
      const raw = Buffer.from(issued.state, "base64url");
      const flipped = Buffer.from(raw);
      flipped[flipped.length - 40] = (flipped[flipped.length - 40] ?? 0) ^ 1;
      // A state of another harness (other key, same tenant and issuer) is foreign here.
      const other = await createConsoleHarness({ sso: true });
      let foreign = "";
      try {
        foreign = (JSON.parse((await other.call("auth.oidcStart", { body: { redirectUri: WORKFORCE_FIXTURE_REDIRECT, codeChallenge: pkcePair().challenge, codeChallengeMethod: "S256" } })).body) as { state: string }).state;
      } finally {
        await other.close();
      }
      for (const forged of ["A".repeat(43), "A".repeat(200), flipped.toString("base64url"), foreign, `${issued.state.slice(0, -1)}${issued.state.endsWith("A") ? "B" : "A"}`]) {
        const r = await exchange(forged);
        expect(r.statusCode, forged.slice(0, 12)).toBe(401);
        expect(errorOf(r.body).reasonCode).toBe("LOGIN_TRANSACTION_UNAVAILABLE");
      }
      expect(await audits()).toBe(before);
      expect(await rows()).toBe(2);
      // An expired state is refused (audited once through the anonymous budget) and writes nothing.
      small.clock.advanceSeconds(61);
      const expired = await exchange(issued.state);
      expect(errorOf(expired.body).reasonCode).toBe("LOGIN_TRANSACTION_UNAVAILABLE");
      expect(await rows()).toBe(2);
      // Used states are deleted once expired.
      small.clock.advanceSeconds(70);
      const swept = await w.service.sweep();
      expect(swept.purgedLoginTransactions).toBe(2);
      expect(await rows()).toBe(0);
      expect((await w.signIn("supervisor")).token).toMatch(/^vcs_/);
    } finally {
      await small.close();
    }
  });

  it("[FO-05-09][FO-01-09] the authorization request asks the IdP to re-authenticate beyond maxAuthAgeSeconds (max_age), so a returning operator is never sent a code the exchange must refuse", async () => {
    const { challenge } = pkcePair();
    const st = await h.call("auth.oidcStart", { body: { redirectUri: WORKFORCE_FIXTURE_REDIRECT, codeChallenge: challenge, codeChallengeMethod: "S256" } });
    const url = new URL((JSON.parse(st.body) as { authorizationUrl: string }).authorizationUrl);
    expect(url.searchParams.get("max_age")).toBe(String(wf.config.maxAuthAgeSeconds));
    expect(wf.idp.lastMaxAgeSeconds).toBe(wf.config.maxAuthAgeSeconds);
  });

  it("[FO-05-10][OPS-01][STRIDE-D] anonymous exchange refusals cannot grow the audit log: N start + bad-exchange rounds (wrong verifier, garbage code the IdP refuses) write a bounded number of events, the next window carries the suppressed count (probe P8)", async () => {
    const hh = await createConsoleHarness({ sso: true });
    try {
      const w = hh.workforce;
      if (!w) throw new Error("harness without SSO");
      const audited = async (reason: string) =>
        (await hh.db.query<{ n: number; pointers: string[] | null }>(
          "select count(*)::int as n, array_agg(p) filter (where p is not null) as pointers from audit_outbox left join lateral jsonb_array_elements_text(event->'evidencePointers') p on true where action = 'console.auth.oidc_exchange' and event->>'reasonCode' = $1",
          [reason],
        )).rows[0] ?? { n: 0, pointers: null };
      const round = async (verifier: string | null) => {
        const pair = pkcePair();
        const st = await hh.call("auth.oidcStart", { body: { redirectUri: WORKFORCE_FIXTURE_REDIRECT, codeChallenge: pair.challenge, codeChallengeMethod: "S256" } });
        expect(st.statusCode).toBe(200);
        const { state } = JSON.parse(st.body) as { state: string };
        // No IdP login at all: the backend's own state, a garbage code, a wrong (or the right) verifier.
        return hh.call("auth.oidcExchange", { body: { code: "c0de".repeat(4), state, codeVerifier: verifier ?? pair.verifier, redirectUri: WORKFORCE_FIXTURE_REDIRECT } });
      };
      for (let i = 0; i < 40; i++) expect(errorOf((await round(pkcePair().verifier)).body).reasonCode).toBe("PKCE_VERIFIER_MISMATCH");
      // The right verifier and a garbage code: the IdP is contacted and refuses the code; still anonymous.
      for (let i = 0; i < 40; i++) expect(errorOf((await round(null)).body).reasonCode).toBe("OIDC_GRANT_INVALID");
      await new Promise((r) => setTimeout(r, 50));
      expect((await audited("PKCE_VERIFIER_MISMATCH")).n).toBe(1);
      expect((await audited("OIDC_GRANT_INVALID")).n).toBe(1);
      // A suppression log line per window, not per request.
      expect(hh.logs.filter((r) => r.event === "console.sso.anonymous_audit_suppressed").length).toBe(2);
      // The next window: one more event per key, carrying the number suppressed in between.
      hh.clock.advanceSeconds(61);
      await round(pkcePair().verifier);
      await new Promise((r) => setTimeout(r, 50));
      const next = await audited("PKCE_VERIFIER_MISMATCH");
      expect(next.n).toBe(2);
      expect(next.pointers).toContain("kv://console-anonymous-audit/suppressed/39");
      // A refused sign-in of an IdP-authenticated person is attributed and audited per event (not budgeted).
      w.idp.users.set("wf-unmapped", { subject: "wf-unmapped", groups: [], active: true, amr: ["pwd", "otp"] });
      for (let i = 0; i < 2; i++) {
        const pair = pkcePair();
        const st = JSON.parse((await hh.call("auth.oidcStart", { body: { redirectUri: WORKFORCE_FIXTURE_REDIRECT, codeChallenge: pair.challenge, codeChallengeMethod: "S256" } })).body) as { authorizationUrl: string };
        const { code, state } = w.idp.login(st.authorizationUrl, "wf-unmapped");
        expect(errorOf((await hh.call("auth.oidcExchange", { body: { code, state, codeVerifier: pair.verifier, redirectUri: WORKFORCE_FIXTURE_REDIRECT } })).body).reasonCode).toBe("STAFF_NOT_PROVISIONED");
      }
      await new Promise((r) => setTimeout(r, 50));
      const attributed = await hh.db.query<{ n: number }>("select count(*)::int as n from audit_outbox where action = 'console.auth.oidc_exchange' and event->>'reasonCode' = 'STAFF_NOT_PROVISIONED' and event->>'actorRef' = $1", [w.directory.staffIdFor(w.config.issuer, "wf-unmapped")]);
      expect(attributed.rows[0]?.n).toBe(2);
    } finally {
      await hh.close();
    }
  });

  it("[FO-05-07][OPS-04] an IdP URL the egress policy refuses is a configuration refusal for the console (503 OIDC_EGRESS_REFUSED, not retryable), never a phantom IdP outage", async () => {
    const original = wf.idp.authorizationRequest.bind(wf.idp);
    wf.idp.authorizationRequest = async () => {
      throw oidcEgressRefusal("discovery", "EGRESS_URL_CONTAINS_SENSITIVE_PATTERN");
    };
    try {
      const r = await h.call("auth.oidcStart", { body: { redirectUri: WORKFORCE_FIXTURE_REDIRECT, codeChallenge: pkcePair().challenge, codeChallengeMethod: "S256" } });
      expect(r.statusCode).toBe(503);
      expect(errorOf(r.body)).toMatchObject({ reasonCode: "OIDC_EGRESS_REFUSED", retryable: false });
    } finally {
      wf.idp.authorizationRequest = original;
    }
  });
});
