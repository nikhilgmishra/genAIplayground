/**
 * Full-container regression tests (LOCAL FIXTURE composition, SYNTHETIC people) for the
 * verification enumeration / locator-privacy findings:
 *  - AUTH-ENUM-01: the observable result sequence for a real and an unknown person must be identical
 *    past every per-account / per-destination limit, through the REAL MCP client, gateway pipeline and
 *    OPA policy (which denies `verification:begin` on session abuse flags).
 *  - AUTH-OTP-LIMIT-01: the same over the OTP path (model-facing begin + isolated TC-06 submission).
 *  - DP-02: the persisted replay-cache request hash of a name + date-of-birth begin_verification is
 *    keyed: the finder's offline dictionary attack (computeToolRequestHash over candidates, with the
 *    binding ref read from audit) recovers nothing.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createJourneyHarness, JOURNEY_START } from "../../test/journeys/harness.js";
import type { JourneyHarness, ToolResultView } from "../../test/journeys/harness.js";
import { LOCAL_FIXTURE_REQUEST_HASH_PEPPER } from "../actions/fixtures/request-hash-pepper.fixture.js";
import { computeToolRequestHash, keyedRequestHash } from "../actions/tool-idempotency.js";
import { buildBusiness } from "../business/index.js";
import { PEOPLE } from "../fixtures/synthetic-world.js";
import { LOCAL_FIXTURE_TOKENS } from "../gateway/auth.js";
import { buildContainer } from "../main/container.js";
import type { Container } from "../main/container.js";
import { createMemoryLogger } from "../observability/logger.js";
import { FakeClock } from "../shared/clock.js";
import { newId } from "../shared/ids.js";

const AVERY = PEOPLE.avery;
const AVERY_CHANNELS: readonly string[] = AVERY.channels.map((c) => c.channelRef);
const UNKNOWN = { fullName: "Zed Nonexistent-Person", dateOfBirth: "1991-02-03" };
const OTHERS = ["Probe Synthetic-Alpha", "Probe Synthetic-Beta", "Probe Synthetic-Gamma", "Probe Synthetic-Delta"];
const nameDob = (method: "SECURE_LINK" | "ONE_TIME_CODE", fullName: string, dateOfBirth: string) => ({ method, locator: { kind: "NAME_AND_DATE_OF_BIRTH", fullName, dateOfBirth } });

/** Everything the conversational layer (and so the caller) can see of a tool result, minus per-request opaque values. */
const view = (r: ToolResultView) => {
  const v = (r.data as { verification?: { status?: string; nextStep?: string } } | null | undefined)?.verification;
  return { status: r.status, reasonCode: r.reasonCode ?? null, verification: v ? { status: v.status, nextStep: v.nextStep } : null, speech: r.speech?.templateId ?? null };
};

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.();
});

async function journey(): Promise<JourneyHarness> {
  const h = await createJourneyHarness({ ingestKnowledge: false });
  closers.push(() => h.close());
  return h;
}

describe("[AUTH-ENUM-01] account-existence oracle through abuse throttles (full container, real MCP client and policy)", () => {
  async function secureLinkAttack(fullName: string, dateOfBirth: string) {
    const h = await journey();
    const seq: unknown[] = [];
    // Call A: five begins for the target (per-session limit). Call B: the account's sixth begin, then
    // the finder's probes about unrelated people. Call C: more begins for the target and one more probe.
    for (const [targetBegins, probes] of [
      [5, 0],
      [1, 4],
      [3, 1],
    ] as const) {
      const call = h.call();
      await call.start();
      await call.role("client");
      for (let i = 0; i < targetBegins; i++) seq.push(view(await call.tool("begin_verification", nameDob("SECURE_LINK", fullName, dateOfBirth))));
      for (let j = 0; j < probes; j++) seq.push(view(await call.tool("begin_verification", nameDob("SECURE_LINK", OTHERS[j] as string, "1970-01-01"))));
      seq.push({ authGate: await call.authGate() });
    }
    const linksToAvery = h.c.identity.notifications.sent.filter((m) => AVERY_CHANNELS.includes(m.channelRef)).length;
    return { h, seq, linksToAvery };
  }

  it("[SPEC-7.no-enumeration] [AUTH-ENUM-01] secure link: identical result sequences for a real and an unknown person past the per-account limit; the account holder gets at most 5 links an hour", { timeout: 120_000 }, async () => {
    const real = await secureLinkAttack(AVERY.fullName, AVERY.dateOfBirth as string);
    const unknown = await secureLinkAttack(UNKNOWN.fullName, UNKNOWN.dateOfBirth);
    expect(real.seq).toEqual(unknown.seq);
    // The finder's B2 probe in particular is no longer denied by policy for the real person.
    expect(real.seq[6]).toEqual({ status: "SUCCESS", reasonCode: null, verification: { status: "IF_ELIGIBLE_A_LINK_WAS_SENT", nextStep: "APPROVE_SECURE_LINK_IN_PORTAL" }, speech: "verification.secure_link_match_code" });
    expect(real.linksToAvery).toBe(5);
    expect(unknown.linksToAvery).toBe(0);
    expect(await real.h.c.identity.verification.abuse.count("LINK_ACCOUNT_LIMIT", { kind: "account", id: AVERY.accountId })).toBe(4);
  });
});

describe("[AUTH-OTP-LIMIT-01] [AUTH-ENUM-01] OTP path: begin over the tool pipeline, digits over isolated TC-06 (full container)", () => {
  const bearer = (channel: keyof typeof LOCAL_FIXTURE_TOKENS) => ({ authorization: `Bearer ${LOCAL_FIXTURE_TOKENS[channel]}` });

  async function otpContainer(): Promise<{ c: Container; clock: FakeClock }> {
    const clock = new FakeClock(JOURNEY_START);
    const c = await buildContainer({ environment: "local", buildBusiness, clock, env: {}, logger: createMemoryLogger().logger, rateLimit: null, ingestKnowledge: false, instanceId: "enum-otp-test-1", otpEnabled: true });
    closers.push(() => c.close());
    return { c, clock };
  }

  async function otpAttack(fullName: string, dateOfBirth: string) {
    const { c, clock } = await otpContainer();
    const seq: unknown[] = [];
    let idem = 0;
    for (let call = 0; call < 3; call++) {
      const callId = newId("cal");
      const studio = { ...bearer("telephony_control"), "x-vsp-interaction-id": callId };
      const started = await c.app.inject({
        method: "POST",
        url: "/telephony/v1/calls",
        headers: studio,
        payload: { callId, callerIdHash: null, consent: { recording: "GRANTED", automatedProcessing: "GRANTED", disclosureTemplateVersion: "disclosure-local-v1", capturedAt: clock.now().toISOString(), capturedBy: "studio_flow" } },
      });
      expect(started.statusCode).toBe(201);
      const sessionRef = (started.json() as { sessionRef: string }).sessionRef;
      const tc = { ...studio, "x-vsp-session-ref": sessionRef };
      expect((await c.app.inject({ method: "POST", url: "/telephony/v1/session/role", headers: tc, payload: { role: "client" } })).statusCode).toBe(200);
      const begin = async () => {
        const res = await c.app.inject({
          method: "POST",
          url: "/v1/tools/begin_verification/1.0.0",
          headers: { ...bearer("mcp_tools"), "x-vsp-session-ref": sessionRef, "x-vsp-interaction-id": callId, "idempotency-key": `idem_synthEnumOtp${String(++idem).padStart(4, "0")}${callId.slice(-8)}` },
          payload: { arguments: nameDob("ONE_TIME_CODE", fullName, dateOfBirth) },
        });
        expect(res.statusCode).toBe(200);
        const r = res.json() as ToolResultView;
        seq.push(view(r));
        return (r.data as { verification?: { verificationId?: string } } | null)?.verification?.verificationId ?? null;
      };
      const submit = async (challengeId: string | null) => {
        if (!challengeId) return seq.push({ submit: "NO_CHALLENGE" });
        const sent = AVERY_CHANNELS.map((ch) => c.identity.notifications.lastTo(ch)).find((m) => m?.templateId === "verify.otp_code")?.slots.code;
        const res = await c.app.inject({ method: "POST", url: "/telephony/v1/session/otp", headers: tc, payload: { challengeId, code: sent === "000000" ? "111111" : "000000" } });
        seq.push({ http: res.statusCode, body: res.json() as unknown });
      };
      const first = await begin();
      await submit(first);
      await submit(first);
      const second = await begin(); // supersedes the first
      await submit(first);
      for (let k = 0; k < 3; k++) await submit(second); // locks: session flagged for every caller alike
      await begin(); // policy now routes to a human for every caller alike
      const gate = await c.app.inject({ method: "GET", url: "/telephony/v1/session/auth-gate", headers: tc });
      seq.push({ authGate: (gate.json() as { isAuthenticated: unknown }).isAuthenticated });
    }
    const codesToAvery = c.identity.notifications.sent.filter((m) => AVERY_CHANNELS.includes(m.channelRef)).length;
    return { c, seq, codesToAvery };
  }

  it("[SPEC-7.OTP] [SPEC-7.no-enumeration] [AUTH-ENUM-01] [AUTH-OTP-LIMIT-01] identical sequences for a real and an unknown person across calls past the account guess and send limits", { timeout: 120_000 }, async () => {
    const real = await otpAttack(AVERY.fullName, AVERY.dateOfBirth as string);
    const unknown = await otpAttack(UNKNOWN.fullName, UNKNOWN.dateOfBirth);
    expect(real.seq).toEqual(unknown.seq);
    // Superseded and locked challenges are refused for everyone; no session was ever verified.
    expect(JSON.stringify(real.seq)).toContain("OTP_CHALLENGE_SUPERSEDED");
    expect(JSON.stringify(real.seq)).not.toContain('"verified":true');
    expect(real.seq.filter((x) => JSON.stringify(x) === JSON.stringify({ authGate: false }))).toHaveLength(3);
    expect(real.codesToAvery).toBeLessThanOrEqual(5);
    expect(unknown.codesToAvery).toBe(0);
    expect(await real.c.identity.verification.abuse.count("OTP_ACCOUNT_GUESS_LIMIT", { kind: "account", id: AVERY.accountId })).toBeGreaterThan(0);
  });
});

describe("[DATA-01] [DP-02] begin_verification locators are not recoverable from the replay cache (full container)", () => {
  it("[DATA-01] [DP-02] the persisted request hash is keyed: the finder's dictionary attack with the audited binding ref recovers nothing", { timeout: 120_000 }, async () => {
    const h = await journey();
    expect(h.c.toolIdempotency.requestHashKeying).toBe("local_fixture");
    const call = h.call();
    await call.start();
    await call.role("client");
    const args = nameDob("SECURE_LINK", AVERY.fullName, AVERY.dateOfBirth as string);
    const r = await call.tool("begin_verification", args);
    expect(r.status).toBe("SUCCESS");
    const rows = await h.q<Record<string, unknown> & { idempotency_key: string; request_hash: string; tool_name: string; tool_version: string }>(
      "select * from tool_request_idempotency where tool_name = 'begin_verification'",
    );
    expect(rows).toHaveLength(1);
    const row = rows[0] as (typeof rows)[0];
    const audit = (await h.auditFor(call.callId)).filter((e) => e.action === "tool.invoke" && e.idempotencyKey === row.idempotency_key);
    const binding = audit[0]?.sessionRef ?? null;
    expect(binding).toMatch(/^ses_bnd_/);
    const candidates = [
      ["Blake Synthetic", "1985-05-05"],
      [AVERY.fullName, AVERY.dateOfBirth as string],
      ["Casey Example", "1979-12-31"],
    ] as const;
    const fingerprint = (fullName: string, dateOfBirth: string) =>
      computeToolRequestHash({ toolName: row.tool_name, toolVersion: row.tool_version, arguments: nameDob("SECURE_LINK", fullName, dateOfBirth), sessionBinding: binding });
    for (const [n, d] of candidates) expect(row.request_hash).not.toBe(fingerprint(n, d));
    // It is the keyed value of the true request (verifiable only with the pepper).
    expect(row.request_hash).toBe(keyedRequestHash(LOCAL_FIXTURE_REQUEST_HASH_PEPPER, fingerprint(AVERY.fullName, AVERY.dateOfBirth as string)));
    // No persisted column carries the locator or its unkeyed digest.
    const dump = JSON.stringify(row);
    expect(dump).not.toMatch(/Avery|Synthetic-Client|1990-01-01/);
    expect(dump).not.toContain(fingerprint(AVERY.fullName, AVERY.dateOfBirth as string));
  });
});
