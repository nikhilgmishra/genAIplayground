/**
 * Break-glass issuance with independent approval, expiry and post-use access review (FO-05-45), and the
 * dual-controlled SSO-outage recovery path (FO-14-51, FO-14-52), through the console HTTP endpoints over real
 * modules (PGlite with every migration, OPA policy, PgBreakGlassIssuance, PgRecoveryService). Workforce
 * sign-in uses the LOCAL TEST FIXTURE provider (fixtures/workforce-oidc.fixture.ts). SYNTHETIC only.
 * PGlite is one connection: races are shown on PostgreSQL 16 in test/integration/identity/recovery.test.ts.
 */
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import type { KeyObject } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { STAFF, TENANT_ID } from "../fixtures/synthetic-world.js";
import { AccessDeniedError, AuditUnavailableError, DependencyError } from "../shared/errors.js";
import { OIDC_REFRESH_MAX_REQUESTS, OIDC_REQUEST_TIMEOUT_MAX_MS } from "../protocol/index.js";
import type { StaffRole } from "../protocol/index.js";
import { PgBreakGlassIssuance } from "./break-glass-issuance.js";
import { createConsoleHarness, workforceGroupFor } from "./fixtures/harness.fixture.js";
import type { ConsoleHarness, HarnessWorkforce, StaffKey } from "./fixtures/harness.fixture.js";
import { signRecoveryChallenge, signRecoveryEnrollment, signRecoveryRequest } from "./recovery.js";
import { consoleSessionHash } from "./sessions.js";
import { REFRESH_IN_FLIGHT_SECONDS } from "./sso.js";
import { BREAK_GLASS_MAX_DURATION_SECONDS as PLUGIN_BREAK_GLASS_MAX } from "./plugin.js";
import { BREAK_GLASS_MAX_DURATION_SECONDS, BREAK_GLASS_MIN_DURATION_SECONDS, BreakGlassRequestCreateS } from "./schemas.js";
import { consoleAuditInput } from "./stores.js";

const SECOND_ADMIN = { staffId: "stf_synthSecondSecAdmin1", tenantId: TENANT_ID, displayLabel: "Synthetic Second Security Admin", roles: ["security_admin"] as StaffRole[], idpSubject: "workforce|synth-second-secadmin" };
const THIRD_ADMIN = { staffId: "stf_synthThirdSecAdmin01", tenantId: TENANT_ID, displayLabel: "Synthetic Third Security Admin", roles: ["security_admin"] as StaffRole[], idpSubject: "workforce|synth-third-secadmin" };

let h: ConsoleHarness;
let wf: HarnessWorkforce;
beforeAll(async () => {
  h = await createConsoleHarness({ sso: true, extraStaff: [SECOND_ADMIN, THIRD_ADMIN] });
  if (!h.workforce) throw new Error("harness without SSO");
  wf = h.workforce;
});
afterAll(async () => {
  await h.close();
});

const errorOf = (body: string): { reasonCode: string } => (JSON.parse(body) as { error: { reasonCode: string } }).error;
const json = <T>(body: string): T => JSON.parse(body) as T;
interface RequestView {
  requestId: string;
  status: string;
  requestedBy: string;
  decidedBy: string | null;
  grantId: string | null;
}
interface ReviewView {
  reviewId: string;
  subjectKind: string;
  subjectRef: string;
  holderStaffId: string;
  approverStaffId: string | null;
  status: string;
}

describe("[FO-05-45] one maximum break-glass duration", () => {
  it("[FO-05-45] the service constant, the request schema, policy data console.breakGlass.maxDurationSeconds and the CHECK of migration 2051 name the same maximum (and minimum)", () => {
    const repo = (rel: string) => readFileSync(new URL(`../../../${rel}`, import.meta.url), "utf8");
    const data = JSON.parse(repo("policy/vsp/data.json")) as { catalogue?: { console?: { breakGlass?: { maxDurationSeconds?: number } } } };
    const policyMax = findBreakGlassMax(data);
    const check = /requested_duration_seconds\s+integer\s+not null check \(requested_duration_seconds between (\d+) and (\d+)\)/.exec(repo("platform/migrations/2051_console_break_glass_issuance.sql"));
    expect(check, "CHECK of migration 2051").not.toBeNull();
    expect(BREAK_GLASS_MAX_DURATION_SECONDS).toBe(14_400);
    expect(policyMax).toBe(BREAK_GLASS_MAX_DURATION_SECONDS);
    expect(Number(check?.[2])).toBe(BREAK_GLASS_MAX_DURATION_SECONDS);
    expect(Number(check?.[1])).toBe(BREAK_GLASS_MIN_DURATION_SECONDS);
    const body = (durationSeconds: number) => ({ justificationCode: "SECURITY_INCIDENT", durationSeconds, reason: "INCIDENT_RESPONSE" });
    expect(BreakGlassRequestCreateS.safeParse(body(BREAK_GLASS_MAX_DURATION_SECONDS)).success).toBe(true);
    expect(BreakGlassRequestCreateS.safeParse(body(BREAK_GLASS_MAX_DURATION_SECONDS + 1)).success).toBe(false);
    expect(BreakGlassRequestCreateS.safeParse(body(BREAK_GLASS_MIN_DURATION_SECONDS - 1)).success).toBe(false);
    // The console API wires the issuance service with exactly this maximum.
    expect(PLUGIN_BREAK_GLASS_MAX).toBe(BREAK_GLASS_MAX_DURATION_SECONDS);
  });
});

/** console.breakGlass.maxDurationSeconds wherever the policy data nests the console section. */
function findBreakGlassMax(node: unknown): number | null {
  if (node === null || typeof node !== "object") return null;
  const rec = node as Record<string, unknown>;
  const bg = (rec.console as { breakGlass?: { maxDurationSeconds?: unknown } } | undefined)?.breakGlass;
  if (bg && typeof bg.maxDurationSeconds === "number") return bg.maxDurationSeconds;
  for (const v of Object.values(rec)) {
    const found = findBreakGlassMax(v);
    if (found !== null) return found;
  }
  return null;
}

describe("[FO-05-45] break-glass issuance: request, independent approval, expiry, post-use review", () => {
  it("[FO-05-45][AUTH-02] a request grants nothing; self-approval is refused; an independent approval issues a time-bound grant; first use opens one review that neither holder nor approver can complete", async () => {
    h.supportRequests.seed({ referenceNumber: "SR-RSTR-BGW5", restricted: true, now: h.clock.now() });
    const safety = await h.token("safety");
    const adminA = await h.token("securityAdmin");
    const adminB = await h.tokenForSubject(SECOND_ADMIN.idpSubject);
    const adminC = await h.tokenForSubject(THIRD_ADMIN.idpSubject);

    const created = await h.call("breakGlass.request", { token: safety, body: { justificationCode: "ACTIVE_SAFETY_INCIDENT", durationSeconds: 1800, reason: "INCIDENT_RESPONSE" } });
    expect(created.statusCode).toBe(200);
    const req = json<{ request: RequestView }>(created.body).request;
    expect(req).toMatchObject({ status: "PENDING", requestedBy: STAFF.safety.staffId, grantId: null });
    // Pending: no access yet.
    expect(errorOf((await h.call("supportRequests.trace", { token: safety, params: { ref: "SR-RSTR-BGW5" } })).body).reasonCode).toBe("BREAK_GLASS_REQUIRED");
    // The admin queue shows the pending request; the requester sees their own.
    expect(json<{ requests: RequestView[] }>((await h.call("breakGlass.list", { token: adminA })).body).requests.map((r) => r.requestId)).toContain(req.requestId);

    // A security admin cannot approve their own request (policy forbidSelfInitiated; service and DB too).
    const own = json<{ request: RequestView }>((await h.call("breakGlass.request", { token: adminA, body: { justificationCode: "SECURITY_INCIDENT", durationSeconds: 900, reason: "INCIDENT_RESPONSE" } })).body).request;
    const self = await h.call("breakGlass.decide", { token: adminA, params: { requestId: own.requestId }, body: { decision: "APPROVE", reason: "INCIDENT_VERIFIED" } });
    expect(self.statusCode).toBe(403);
    expect(errorOf(self.body).reasonCode).toBe("SELF_REVIEW_FORBIDDEN");
    // Free text is never a reason.
    expect((await h.call("breakGlass.decide", { token: adminA, params: { requestId: req.requestId }, body: { decision: "APPROVE", reason: "looks fine" } })).statusCode).toBe(400);

    const approved = await h.call("breakGlass.decide", { token: adminA, params: { requestId: req.requestId }, body: { decision: "APPROVE", reason: "INCIDENT_VERIFIED" } });
    expect(approved.statusCode).toBe(200);
    const decided = json<{ request: RequestView }>(approved.body).request;
    expect(decided).toMatchObject({ status: "APPROVED", decidedBy: STAFF.securityAdmin.staffId });
    expect(decided.grantId).toMatch(/^bgl_/);
    // Decided once.
    expect(errorOf((await h.call("breakGlass.decide", { token: adminB, params: { requestId: req.requestId }, body: { decision: "REJECT", reason: "DUPLICATE_REQUEST" } })).body).reasonCode).toBe("BREAK_GLASS_REQUEST_DECIDED");

    // First use opens the review (same transaction as the use audit); later uses add none.
    for (let i = 0; i < 2; i++) expect((await h.call("supportRequests.trace", { token: safety, params: { ref: "SR-RSTR-BGW5" } })).statusCode).toBe(200);
    const reviews = json<{ reviews: ReviewView[] }>((await h.call("accessReviews.list", { token: await h.token("auditor") })).body).reviews.filter((r) => r.subjectRef === decided.grantId);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ subjectKind: "BREAK_GLASS_GRANT", holderStaffId: STAFF.safety.staffId, approverStaffId: STAFF.securityAdmin.staffId, status: "OPEN" });
    const firstUse = await h.db.query<{ n: number }>("select count(*)::int as n from audit_outbox where action = 'console.break_glass.first_use' and event->>'actorRef' = $1", [STAFF.safety.staffId]);
    expect(firstUse.rows[0]?.n).toBe(1);

    const reviewId = (reviews[0] as ReviewView).reviewId;
    const body = { outcome: "APPROPRIATE", reason: "USE_MATCHED_JUSTIFICATION" };
    // The approver may not review the access they approved; the holder is not a reviewer role at all.
    expect(errorOf((await h.call("accessReviews.complete", { token: adminA, params: { reviewId }, body })).body).reasonCode).toBe("SELF_REVIEW_FORBIDDEN");
    expect((await h.call("accessReviews.complete", { token: safety, params: { reviewId }, body })).statusCode).toBe(403);
    // The auditor sees reviews but cannot complete them.
    expect((await h.call("accessReviews.complete", { token: await h.token("auditor"), params: { reviewId }, body })).statusCode).toBe(403);
    const done = await h.call("accessReviews.complete", { token: adminC, params: { reviewId }, body });
    expect(done.statusCode).toBe(200);
    expect(json<{ review: { status: string; outcome: string } }>(done.body).review).toMatchObject({ status: "COMPLETED", outcome: "APPROPRIATE" });
    expect(errorOf((await h.call("accessReviews.complete", { token: adminB, params: { reviewId }, body })).body).reasonCode).toBe("ACCESS_REVIEW_COMPLETED");

    // Time-bound: past the requested duration the grant no longer opens restricted records.
    h.clock.advanceSeconds(1801);
    expect(errorOf((await h.call("supportRequests.trace", { token: await h.token("safety"), params: { ref: "SR-RSTR-BGW5" } })).body).reasonCode).toBe("STAFF_BREAK_GLASS_EXPIRED");
  });

  it("[FO-05-45] an undecided request expires; a rejection issues no grant", async () => {
    const supervisor = await h.token("supervisor");
    const pending = json<{ request: RequestView }>((await h.call("breakGlass.request", { token: supervisor, body: { justificationCode: "PRIVACY_INCIDENT", durationSeconds: 600, reason: "AUDIT_REQUEST" } })).body).request;
    const rejected = json<{ request: RequestView }>((await h.call("breakGlass.request", { token: supervisor, body: { justificationCode: "PRIVACY_INCIDENT", durationSeconds: 600, reason: "AUDIT_REQUEST" } })).body).request;
    const r = await h.call("breakGlass.decide", { token: await h.token("securityAdmin"), params: { requestId: rejected.requestId }, body: { decision: "REJECT", reason: "SCOPE_TOO_BROAD" } });
    expect(json<{ request: RequestView }>(r.body).request).toMatchObject({ status: "REJECTED", grantId: null });
    h.clock.advanceSeconds(3601);
    const late = await h.call("breakGlass.decide", { token: await h.tokenForSubject(SECOND_ADMIN.idpSubject), params: { requestId: pending.requestId }, body: { decision: "APPROVE", reason: "INCIDENT_VERIFIED" } });
    expect(late.statusCode).toBe(409);
    expect(errorOf(late.body).reasonCode).toBe("BREAK_GLASS_REQUEST_EXPIRED");
    const mine = json<{ requests: RequestView[] }>((await h.call("breakGlass.list", { token: await h.token("supervisor") })).body).requests;
    expect(mine.find((x) => x.requestId === pending.requestId)?.status).toBe("EXPIRED");
    const grants = await h.db.query<{ n: number }>("select count(*)::int as n from console_break_glass_grants where staff_id = $1", [STAFF.supervisor.staffId]);
    expect(grants.rows[0]?.n).toBe(0);
  });

  it("[FO-05-45][OPS-01] when the post-use review cannot be opened the restricted access is refused (fail closed)", async () => {
    class ReviewStoreDown extends PgBreakGlassIssuance {
      override async recordUse(): Promise<never> {
        throw new Error("REVIEW_STORE_DOWN");
      }
    }
    const down = await createConsoleHarness({ patchDeps: (d) => ({ ...d, auth: { ...d.auth, breakGlassIssuance: new ReviewStoreDown(d.db, d.audit, 14_400) } }) });
    try {
      down.supportRequests.seed({ referenceNumber: "SR-RSTR-BGDN", restricted: true, now: down.clock.now() });
      const now = down.clock.now().getTime();
      await down.db.tx(
        (tx) =>
          tx.query(
            `insert into console_break_glass_grants (grant_id, tenant_id, staff_id, approved_by, justification_code, granted_at, expires_at, recorded_at)
             values ('bgl_synthGrantReviewDown01', $1, $2, $3, 'ACTIVE_SAFETY_INCIDENT', $4::timestamptz, $5::timestamptz, $4::timestamptz)`,
            [TENANT_ID, STAFF.safety.staffId, STAFF.securityAdmin.staffId, new Date(now - 60_000).toISOString(), new Date(now + 3_600_000).toISOString()],
          ),
        { role: "owner" },
      );
      const r = await down.call("supportRequests.trace", { token: await down.token("safety"), params: { ref: "SR-RSTR-BGDN" } });
      expect(r.statusCode).toBe(503);
      expect(errorOf(r.body).reasonCode).toBe("ACCESS_REVIEW_UNAVAILABLE");
      expect(r.body).not.toContain("SR-RSTR-BGDN");
    } finally {
      await down.close();
    }
  });
});

describe("[FO-14-51] dual-controlled SSO-outage recovery identities", () => {
  type KeyPair = { privateKey: KeyObject; jwk: { kty: "EC"; crv: "P-256"; x: string; y: string } };
  const keyPair = (): KeyPair => {
    const k = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const j = k.publicKey.export({ format: "jwk" }) as { x: string; y: string };
    return { privateKey: k.privateKey, jwk: { kty: "EC", crv: "P-256", x: j.x, y: j.y } };
  };
  interface IdentityView {
    identityId: string;
    staffId: string;
    keyThumbprint: string;
    status: string;
    holderConfirmedAt: string | null;
    suspendReason: string | null;
  }
  let attestation = 0;
  const nextAttestation = () => `att_synthHardwareKeyRef${String(++attestation).padStart(4, "0")}`;

  /** Proposal by `proposer` for `holder` (who must have signed in by SSO): the identity and its enrollment challenge. */
  const propose = async (proposer: string, holder: StaffKey | string, key: KeyPair, roles: string[]) =>
    h.call("recoveryIdentities.propose", { token: proposer, body: { staffId: holder.startsWith("stf_") ? holder : wf.staffIdOf(holder as StaffKey), publicJwk: key.jwk, attestationRef: nextAttestation(), roles } });
  const enrollmentSignature = (identity: IdentityView, challenge: string, key: KeyPair) =>
    signRecoveryEnrollment({ privateKey: key.privateKey, tenantId: TENANT_ID, identityId: identity.identityId, staffId: identity.staffId, keyThumbprint: identity.keyThumbprint, challenge, now: h.clock.now() });

  /** Full enrollment: propose (admin A), the holder confirms in their SSO session, approve (admin B). */
  const enroll = async (o: { proposer: string; approver: string; holder: StaffKey; holderToken: string; key: KeyPair; roles: string[] }): Promise<string> => {
    const p = await propose(o.proposer, o.holder, o.key, o.roles);
    expect(p.statusCode, p.body).toBe(200);
    const { identity, enrollment } = json<{ identity: IdentityView; enrollment: { challenge: string } }>(p.body);
    const c = await h.call("recoveryIdentities.confirm", { token: o.holderToken, params: { identityId: identity.identityId }, body: { signature: await enrollmentSignature(identity, enrollment.challenge, o.key) } });
    expect(c.statusCode, c.body).toBe(200);
    const a = await h.call("recoveryIdentities.approve", { token: o.approver, params: { identityId: identity.identityId } });
    expect(a.statusCode, a.body).toBe(200);
    return identity.identityId;
  };
  /** The custodian's signed activation request (only the key holder can ask for a challenge). */
  const challenge = async (identityId: string, key: KeyPair, nonce?: string) =>
    h.call("auth.recoveryChallenge", { body: { identityId, proof: await signRecoveryRequest({ privateKey: key.privateKey, tenantId: TENANT_ID, identityId, now: h.clock.now(), nonce }) } });
  const sign = (activationId: string, c: string, identityId: string, key: KeyObject) => signRecoveryChallenge({ privateKey: key, tenantId: TENANT_ID, activationId, challenge: c, identityId, now: h.clock.now() });
  /** Challenge + both signatures -> the activation response. */
  const activate = async (x: { id: string; key: KeyPair }, y: { id: string; key: KeyPair }) => {
    const cr = await challenge(x.id, x.key);
    if (cr.statusCode !== 200) return cr;
    const c = json<{ activationId: string; challenge: string }>(cr.body);
    return h.call("auth.recoveryActivate", { body: { activationId: c.activationId, approvals: [{ identityId: x.id, signature: await sign(c.activationId, c.challenge, x.id, x.key.privateKey) }, { identityId: y.id, signature: await sign(c.activationId, c.challenge, y.id, y.key.privateKey) }] } });
  };
  const identityOf = async (admin: string, identityId: string): Promise<IdentityView | undefined> =>
    json<{ identities: IdentityView[] }>((await h.call("recoveryIdentities.list", { token: admin })).body).identities.find((i) => i.identityId === identityId);
  const auditCount = async (action: string, reason: string, staffId: string) =>
    (await h.db.query<{ n: number }>("select count(*)::int as n from audit_outbox where action = $1 and event->>'reasonCode' = $2 and event->>'actorRef' = $3", [action, reason, staffId])).rows[0]?.n ?? 0;

  it("[FO-14-51][AUTH-02] two admins and the holder register a custodian key (never self-approved, never before the holder's proof); activation needs two different custodians' signatures and yields a short RECOVERY session that works while the IdP is down and opens an access review", async () => {
    const adminA = await h.token("securityAdmin");
    const adminB = await h.tokenForSubject(SECOND_ADMIN.idpSubject);
    const holder = keyPair();
    const cosigner = keyPair();
    const holderStaff = wf.staffIdOf("supervisor");
    const cosignerStaff = wf.staffIdOf("safety");
    const holderSso = (await wf.signIn("supervisor")).token;
    const cosignerSso = (await wf.signIn("safety")).token;
    const proposeX = await propose(adminA, "supervisor", holder, ["supervisor"]);
    expect(proposeX.statusCode).toBe(200);
    const px = json<{ identity: IdentityView; enrollment: { challenge: string; expiresAt: string } }>(proposeX.body);
    expect(px.identity).toMatchObject({ status: "PROPOSED", holderConfirmedAt: null });
    // The proposer cannot approve (dual control); nobody can approve before the holder proved possession.
    const selfApprove = await h.call("recoveryIdentities.approve", { token: adminA, params: { identityId: px.identity.identityId } });
    expect(selfApprove.statusCode).toBe(403);
    expect(errorOf(selfApprove.body).reasonCode).toBe("SELF_REVIEW_FORBIDDEN");
    expect(errorOf((await h.call("recoveryIdentities.approve", { token: adminB, params: { identityId: px.identity.identityId } })).body).reasonCode).toBe("RECOVERY_HOLDER_UNCONFIRMED");
    const confirmed = await h.call("recoveryIdentities.confirm", { token: holderSso, params: { identityId: px.identity.identityId }, body: { signature: await enrollmentSignature(px.identity, px.enrollment.challenge, holder) } });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(json<{ identity: IdentityView }>(confirmed.body).identity.holderConfirmedAt).not.toBeNull();
    expect(json<{ identity: { status: string } }>((await h.call("recoveryIdentities.approve", { token: adminB, params: { identityId: px.identity.identityId } })).body).identity.status).toBe("ACTIVE");
    const x = { id: px.identity.identityId, key: holder };
    const y = { id: await enroll({ proposer: adminB, approver: adminA, holder: "safety", holderToken: cosignerSso, key: cosigner, roles: ["safety_responder"] }), key: cosigner };
    // The same public key cannot be registered twice; private key material is refused by the schema.
    expect(errorOf((await propose(adminA, "supervisor", holder, ["supervisor"])).body).reasonCode).toBe("RECOVERY_KEY_ALREADY_REGISTERED");
    expect((await h.call("recoveryIdentities.propose", { token: adminA, body: { staffId: holderStaff, publicJwk: { ...keyPair().jwk, d: "x" }, attestationRef: nextAttestation(), roles: ["supervisor"] } })).statusCode).toBe(400);
    const listed = json<{ identities: Record<string, unknown>[] }>((await h.call("recoveryIdentities.list", { token: adminA })).body).identities;
    expect(JSON.stringify(listed)).not.toContain(holder.jwk.x);
    expect(json<{ recoveryAvailable: boolean }>((await h.call("auth.config")).body).recoveryAvailable).toBe(true);

    // The workforce IdP is down for the rest of the test.
    wf.idp.unavailable = true;
    try {
      // One custodian signing twice is not dual control; the activation is then closed.
      const c1 = json<{ activationId: string; challenge: string }>((await challenge(x.id, holder)).body);
      const sx = await sign(c1.activationId, c1.challenge, x.id, holder.privateKey);
      const single = await h.call("auth.recoveryActivate", { body: { activationId: c1.activationId, approvals: [{ identityId: x.id, signature: sx }, { identityId: x.id, signature: sx }] } });
      expect(errorOf(single.body).reasonCode).toBe("RECOVERY_DUAL_CONTROL_REQUIRED");
      const sy1 = await sign(c1.activationId, c1.challenge, y.id, cosigner.privateKey);
      expect(errorOf((await h.call("auth.recoveryActivate", { body: { activationId: c1.activationId, approvals: [{ identityId: x.id, signature: sx }, { identityId: y.id, signature: sy1 }] } })).body).reasonCode).toBe("RECOVERY_ACTIVATION_UNAVAILABLE");
      // A signature by the wrong key is refused.
      const c2 = json<{ activationId: string; challenge: string }>((await challenge(x.id, holder)).body);
      const forged = await sign(c2.activationId, c2.challenge, y.id, keyPair().privateKey);
      expect(errorOf((await h.call("auth.recoveryActivate", { body: { activationId: c2.activationId, approvals: [{ identityId: x.id, signature: await sign(c2.activationId, c2.challenge, x.id, holder.privateKey) }, { identityId: y.id, signature: forged }] } })).body).reasonCode).toBe("RECOVERY_SIGNATURE_INVALID");

      const ok = await activate(x, y);
      expect(ok.statusCode, ok.body).toBe(200);
      const t = json<{ accessToken: string; sessionKind: string; idleTimeoutSeconds: number }>(ok.body);
      expect(t).toMatchObject({ sessionKind: "RECOVERY", idleTimeoutSeconds: 600 });
      const m = json<{ sessionKind: string; staff: { staffId: string; roles: string[] } }>((await h.call("me", { token: t.accessToken })).body);
      expect(m).toMatchObject({ sessionKind: "RECOVERY", staff: { staffId: holderStaff, roles: ["supervisor"] } });
      // Usable during the IdP outage (no active-state check for a recovery session) for supervisor work.
      expect((await h.call("killSwitches.list", { token: t.accessToken })).statusCode).toBe(200);
      const review = json<{ reviews: ReviewView[] }>((await h.call("accessReviews.list", { token: adminA })).body).reviews.find((r) => r.subjectKind === "RECOVERY_SESSION" && r.holderStaffId === holderStaff);
      expect(review).toMatchObject({ status: "OPEN", approverStaffId: cosignerStaff });
      // No refresh for a recovery session; a recovery session never confirms an enrollment (it proves no IdP
      // identity), even for its own holder with a valid signature.
      expect((await h.call("auth.refresh", { headers: { authorization: `Bearer ${t.accessToken}` } })).statusCode).toBe(401);
      wf.idp.unavailable = false;
      const viaRecoveryKey = keyPair();
      const pending = json<{ identity: IdentityView; enrollment: { challenge: string } }>((await propose(adminA, "supervisor", viaRecoveryKey, ["supervisor"])).body);
      wf.idp.unavailable = true;
      const viaRecovery = await h.call("recoveryIdentities.confirm", { token: t.accessToken, params: { identityId: pending.identity.identityId }, body: { signature: await enrollmentSignature(pending.identity, pending.enrollment.challenge, viaRecoveryKey) } });
      expect(viaRecovery.statusCode).toBe(403);
      expect(errorOf(viaRecovery.body).reasonCode).toBe("RECOVERY_HOLDER_SSO_REQUIRED");

      // A holder with a SECOND active identity: revoking the identity this session came from still ends it.
      wf.idp.unavailable = false;
      const x2 = { id: await enroll({ proposer: adminA, approver: adminB, holder: "supervisor", holderToken: holderSso, key: keyPair(), roles: ["supervisor"] }) };
      const x3key = keyPair();
      const x3 = { id: await enroll({ proposer: adminA, approver: adminB, holder: "supervisor", holderToken: holderSso, key: x3key, roles: ["supervisor"] }), key: x3key };
      wf.idp.unavailable = true;
      // Revoking the OTHER identity leaves this session alone (it is bound to x, not to the holder).
      expect((await h.call("recoveryIdentities.revoke", { token: adminA, params: { identityId: x2.id }, body: { reason: "ROTATION" } })).statusCode).toBe(200);
      expect((await h.call("me", { token: t.accessToken })).statusCode).toBe(200);
      // Revoking the identity ends its recovery sessions immediately.
      expect((await h.call("recoveryIdentities.revoke", { token: adminB, params: { identityId: x.id }, body: { reason: "ROTATION" } })).statusCode).toBe(200);
      expect(errorOf((await h.call("me", { token: t.accessToken })).body).reasonCode).toBe("SESSION_REVOKED");
      expect((await challenge(x.id, holder)).statusCode).toBe(404);

      // Per-request check, independent of the session-row revocation: a fresh recovery session from a third
      // identity of the holder; that identity is then revoked by a writer that bypasses the service (owner
      // role, no session-row update), so only the request-time identity check can end the session.
      const ok3 = await activate(x3, y);
      expect(ok3.statusCode, ok3.body).toBe(200);
      const t3 = json<{ accessToken: string }>(ok3.body).accessToken;
      expect((await h.call("me", { token: t3 })).statusCode).toBe(200);
      await h.db.query("update console_recovery_identities set status = 'REVOKED', revoked_by = $2, revoked_at = now(), revoke_reason = 'ROTATION' where identity_id = $1", [x3.id, SECOND_ADMIN.staffId]);
      const bypass = await h.call("me", { token: t3 });
      expect(bypass.statusCode).toBe(401);
      expect(errorOf(bypass.body).reasonCode).toBe("RECOVERY_IDENTITY_REVOKED");
      expect(errorOf((await h.call("me", { token: t3 })).body).reasonCode).toBe("SESSION_REVOKED");
    } finally {
      wf.idp.unavailable = false;
    }
  });

  it("[FO-14-51][AUTH-02][AUTH-03] enrollment is bound to the holder at the IdP: a fabricated holder, roles the directory does not grant, a key only the proposer holds, a non-holder confirmation and a recovery session's confirmation are all refused (probe P2)", async () => {
    const adminA = await h.token("securityAdmin");
    const adminB = await h.tokenForSubject(SECOND_ADMIN.idpSubject);
    const before = (await h.db.query<{ n: number }>("select count(*)::int as n from console_recovery_identities")).rows[0]?.n ?? 0;
    // P2: admin A proposes two fabricated staff ids with keys A holds: refused, nothing written.
    for (const fake of ["stf_synthNoSuchStaff0001", "stf_synthNoSuchStaff0002"]) {
      const r = await propose(adminA, fake, keyPair(), ["security_admin"]);
      expect(r.statusCode, r.body).toBe(409);
      expect(errorOf(r.body).reasonCode).toBe("RECOVERY_HOLDER_NOT_AUTHENTICATED");
    }
    expect((await h.db.query<{ n: number }>("select count(*)::int as n from console_recovery_identities")).rows[0]?.n).toBe(before);
    // Roles the directory does not map for the holder (a support agent proposed as security_admin).
    const agentSso = (await wf.signIn("agent")).token;
    const escalated = await propose(adminA, "agent", keyPair(), ["security_admin"]);
    expect(escalated.statusCode).toBe(403);
    expect(errorOf(escalated.body).reasonCode).toBe("RECOVERY_ROLES_NOT_GRANTED");
    // A key admin A holds, proposed for a real holder: only the holder may confirm, and only with the enrolled key.
    const proposerHeld = keyPair();
    const holderSso = (await wf.signIn("supervisor")).token;
    const p = json<{ identity: IdentityView; enrollment: { challenge: string } }>((await propose(adminA, "supervisor", proposerHeld, ["supervisor"])).body);
    const proposerSignature = await enrollmentSignature(p.identity, p.enrollment.challenge, proposerHeld);
    // The proposer (not the holder) presenting a valid signature: refused by policy (holder only).
    const byProposer = await h.call("recoveryIdentities.confirm", { token: adminA, params: { identityId: p.identity.identityId }, body: { signature: proposerSignature } });
    expect(byProposer.statusCode).toBe(403);
    // Another staff member's SSO session: refused (not the named holder).
    const byOther = await h.call("recoveryIdentities.confirm", { token: agentSso, params: { identityId: p.identity.identityId }, body: { signature: proposerSignature } });
    expect(byOther.statusCode).toBe(403);
    // The holder signing with their OWN key (they do not hold the proposer's): proof invalid; still unconfirmed.
    const byHolderOwnKey = await h.call("recoveryIdentities.confirm", { token: holderSso, params: { identityId: p.identity.identityId }, body: { signature: await enrollmentSignature(p.identity, p.enrollment.challenge, keyPair()) } });
    expect(errorOf(byHolderOwnKey.body).reasonCode).toBe("RECOVERY_HOLDER_PROOF_INVALID");
    // A signature over another challenge, by the right key: refused.
    const wrongChallenge = await h.call("recoveryIdentities.confirm", { token: holderSso, params: { identityId: p.identity.identityId }, body: { signature: await enrollmentSignature(p.identity, "A".repeat(43), proposerHeld) } });
    expect(errorOf(wrongChallenge.body).reasonCode).toBe("RECOVERY_HOLDER_PROOF_INVALID");
    // Below the route (defence in depth behind the holder-only policy): the service refuses another staff
    // member's SSO session, with a valid signature, and so would the database trigger.
    const agentSession = await wf.service.authenticate(`Bearer ${agentSso}`);
    const direct = await wf.recovery
      .confirm({ holder: { staffId: agentSession.staffId, sessionKind: "OIDC_SSO", sessionHash: agentSession.sessionHash, roles: ["supervisor"] }, identityId: p.identity.identityId, signature: proposerSignature, now: h.clock.now(), audit: consoleAuditInput({ tenantId: TENANT_ID, correlationId: "cor_synthRecoveryUnitConfirm01", staffId: agentSession.staffId, role: null, action: "console.recovery_identities.confirm", outcome: "SUCCEEDED", reasonCode: "RECOVERY_IDENTITY_HOLDER_CONFIRMED", occurredAt: h.clock.now() }) })
      .catch((e: unknown) => e);
    expect(direct).toMatchObject({ reasonCode: "RECOVERY_HOLDER_MISMATCH" });
    // Roles: proposed while the holder held them; the holder's CURRENT session no longer maps them -> refused.
    const reducedKey = keyPair();
    const reduced = json<{ identity: IdentityView; enrollment: { challenge: string } }>((await propose(adminA, "supervisor", reducedKey, ["supervisor"])).body);
    const holderUser = wf.idp.users.get(wf.subjectOf("supervisor"));
    if (!holderUser) throw new Error("fixture user missing");
    const holderGroups = [...holderUser.groups];
    // Still a recovery role (safety responder, so the holder-only policy lets them through), not the proposed one.
    holderUser.groups = ["/vsp/safety-responder"];
    h.clock.advanceMs(10);
    const reducedSso = (await wf.signIn("supervisor")).token;
    holderUser.groups = holderGroups;
    const reducedConfirm = await h.call("recoveryIdentities.confirm", { token: reducedSso, params: { identityId: reduced.identity.identityId }, body: { signature: await enrollmentSignature(reduced.identity, reduced.enrollment.challenge, reducedKey) } });
    expect(reducedConfirm.statusCode).toBe(403);
    expect(errorOf(reducedConfirm.body).reasonCode).toBe("RECOVERY_ROLES_NOT_GRANTED");
    // Nothing above confirmed it: approval is still refused.
    expect(errorOf((await h.call("recoveryIdentities.approve", { token: adminB, params: { identityId: p.identity.identityId } })).body).reasonCode).toBe("RECOVERY_HOLDER_UNCONFIRMED");
    expect((await identityOf(adminA, p.identity.identityId))?.status).toBe("PROPOSED");
    // The database refuses an approval without the holder's confirmation, whatever the code path.
    await expect(
      h.db.query("update console_recovery_identities set status = 'ACTIVE', approved_by = $2, approved_at = now() where identity_id = $1", [p.identity.identityId, SECOND_ADMIN.staffId]),
    ).rejects.toThrow(/console_rci_approval_after_confirmation/);
    // An expired enrollment cannot be confirmed.
    h.clock.advanceSeconds(86_401);
    const lateSso = (await wf.signIn("supervisor")).token;
    const late = await h.call("recoveryIdentities.confirm", { token: lateSso, params: { identityId: p.identity.identityId }, body: { signature: await enrollmentSignature(p.identity, p.enrollment.challenge, proposerHeld) } });
    expect(errorOf(late.body).reasonCode).toBe("RECOVERY_ENROLLMENT_EXPIRED");
  });

  it("[FO-14-52][FO-14-51][AUTH-04] offboarding at the IdP reaches recovery: a disabled custodian's identities are SUSPENDED and their RECOVERY session ends at the next check, activation is refused, and only a new SSO sign-in with the roles reinstates them (probe P1)", async () => {
    const adminA = await h.token("securityAdmin");
    const adminB = await h.tokenForSubject(SECOND_ADMIN.idpSubject);
    const holderStaff = wf.staffIdOf("supervisor");
    const holderSso = (await wf.signIn("supervisor")).token;
    const cosignerSso = (await wf.signIn("safety")).token;
    // Two identities of the same holder: both follow the IdP.
    const otherId = await enroll({ proposer: adminA, approver: adminB, holder: "supervisor", holderToken: holderSso, key: keyPair(), roles: ["supervisor"] });
    const xKey = keyPair();
    const xId = await enroll({ proposer: adminA, approver: adminB, holder: "supervisor", holderToken: holderSso, key: xKey, roles: ["supervisor"] });
    const yKey = keyPair();
    const yId = await enroll({ proposer: adminB, approver: adminA, holder: "safety", holderToken: cosignerSso, key: yKey, roles: ["safety_responder"] });
    const recovered = await activate({ id: xId, key: xKey }, { id: yId, key: yKey });
    expect(recovered.statusCode, recovered.body).toBe(200);
    const recoveryToken = json<{ accessToken: string }>(recovered.body).accessToken;
    // The operator is disabled at the IdP; the next active-state check (here: their next request) sees it.
    const user = wf.idp.users.get(wf.subjectOf("supervisor"));
    if (!user) throw new Error("fixture user missing");
    user.active = false;
    h.clock.advanceMs(61_000);
    const me1 = await h.call("me", { token: holderSso });
    expect(errorOf(me1.body).reasonCode).toBe("STAFF_DEPROVISIONED");
    for (const id of [otherId, xId]) expect(await identityOf(adminA, id)).toMatchObject({ status: "SUSPENDED", suspendReason: "CUSTODIAN_OFFBOARDED" });
    // The live RECOVERY session of the holder ended in the same transaction.
    expect(errorOf((await h.call("me", { token: recoveryToken })).body).reasonCode).toBe("SESSION_REVOKED");
    // Activation is refused (no challenge for a SUSPENDED identity), and the suspension is audited.
    expect(errorOf((await challenge(xId, xKey)).body).reasonCode).toBe("RECOVERY_IDENTITY_UNAVAILABLE");
    expect(await auditCount("console.recovery_identity.suspended", "CUSTODIAN_OFFBOARDED", holderStaff)).toBeGreaterThan(0);
    // Re-enabled at the IdP: only a NEW SSO sign-in reinstates (an identity whose roles it covers), audited.
    user.active = true;
    expect((await identityOf(adminA, xId))?.status).toBe("SUSPENDED");
    await wf.signIn("supervisor");
    expect(await identityOf(adminA, xId)).toMatchObject({ status: "ACTIVE", suspendReason: null });
    expect(await auditCount("console.recovery_identity.reinstated", "RECOVERY_IDENTITY_REINSTATED", holderStaff)).toBeGreaterThan(0);
    expect((await activate({ id: xId, key: xKey }, { id: yId, key: yKey })).statusCode).toBe(200);
  });

  it("[FO-14-52][FO-14-51] the sweep, a group removal, a role reduction, a logout after deprovisioning and another sign-in's logout followed by deprovisioning all reach the custodian; a request racing its own logout or its own refresh decides nothing (the logout, the refresh decide), and a token past its known expiry is no explanation (fail closed)", async () => {
    const adminA = await h.token("securityAdmin");
    const adminB = await h.tokenForSubject(SECOND_ADMIN.idpSubject);
    const enrolled = async (staff: StaffKey, roles: string[]) => {
      h.clock.advanceMs(10);
      const sso = (await wf.signIn(staff)).token;
      const key = keyPair();
      return { sso, key, id: await enroll({ proposer: adminA, approver: adminB, holder: staff, holderToken: sso, key, roles }) };
    };
    const user = (staff: StaffKey) => {
      const u = wf.idp.users.get(wf.subjectOf(staff));
      if (!u) throw new Error("fixture user missing");
      return u;
    };
    // 1. Sweep: disabled without any request.
    const safety = await enrolled("safety", ["safety_responder"]);
    user("safety").active = false;
    h.clock.advanceMs(61_000);
    await wf.service.sweep();
    expect(await identityOf(adminA, safety.id)).toMatchObject({ status: "SUSPENDED", suspendReason: "CUSTODIAN_OFFBOARDED" });
    user("safety").active = true;
    // 2. Removed from every managed group (still enabled): STAFF_NOT_PROVISIONED suspends.
    const sup = await enrolled("supervisor", ["supervisor"]);
    const groups = [...user("supervisor").groups];
    user("supervisor").groups = [];
    h.clock.advanceMs(61_000);
    expect(errorOf((await h.call("me", { token: sup.sso })).body).reasonCode).toBe("STAFF_NOT_PROVISIONED");
    expect(await identityOf(adminA, sup.id)).toMatchObject({ status: "SUSPENDED", suspendReason: "CUSTODIAN_OFFBOARDED" });
    user("supervisor").groups = groups;
    // 3. Roles reduced at the IdP (still provisioned, but no longer supervisor): CUSTODIAN_ROLES_REDUCED; the
    //    session goes on with the reduced roles.
    const sup2 = await enrolled("supervisor", ["supervisor"]);
    expect(await identityOf(adminA, sup.id)).toMatchObject({ status: "ACTIVE" });
    user("supervisor").groups = ["/vsp/support-agent"];
    h.clock.advanceMs(61_000);
    expect((await h.call("me", { token: sup2.sso })).statusCode).toBe(200);
    for (const id of [sup.id, sup2.id]) expect(await identityOf(adminA, id)).toMatchObject({ status: "SUSPENDED", suspendReason: "CUSTODIAN_ROLES_REDUCED" });
    // A sign-in that does not map the roles does not reinstate.
    h.clock.advanceMs(10);
    await wf.signIn("supervisor");
    expect((await identityOf(adminA, sup.id))?.status).toBe("SUSPENDED");
    user("supervisor").groups = groups;
    h.clock.advanceMs(10);
    await wf.signIn("supervisor");
    expect((await identityOf(adminA, sup.id))?.status).toBe("ACTIVE");
    // 4. Disabled at the IdP, then logs out before any active check: the logout itself sees it.
    const leaver = await enrolled("supervisor", ["supervisor"]);
    user("supervisor").active = false;
    expect((await h.call("auth.logout", { token: leaver.sso })).statusCode).toBe(200);
    expect(await identityOf(adminA, leaver.id)).toMatchObject({ status: "SUSPENDED", suspendReason: "CUSTODIAN_OFFBOARDED" });
    user("supervisor").active = true;
    await wf.signIn("supervisor");
    expect((await identityOf(adminA, leaver.id))?.status).toBe("ACTIVE");
    // 5. Another sign-in's logout explains nothing (Keycloak 26 keeps the user's other IdP sessions active when one
    //    session's refresh token is revoked: Layer-2 probe K1). Two browsers, logout of one, then disabled: the other
    //    sign-in's next check is an offboarding signal, the identity is SUSPENDED and activation is refused.
    const second = await enrolled("supervisor", ["supervisor"]);
    const firstBrowser = (await wf.signIn("supervisor")).token;
    h.clock.advanceMs(1_000);
    expect((await h.call("auth.logout", { token: firstBrowser })).statusCode).toBe(200);
    user("supervisor").active = false;
    h.clock.advanceMs(61_000);
    expect(errorOf((await h.call("me", { token: second.sso })).body).reasonCode).toBe("STAFF_DEPROVISIONED");
    expect(await identityOf(adminA, second.id)).toMatchObject({ status: "SUSPENDED", suspendReason: "CUSTODIAN_OFFBOARDED" });
    expect(errorOf((await challenge(second.id, second.key)).body).reasonCode).toBe("RECOVERY_IDENTITY_UNAVAILABLE");
    user("supervisor").active = true;
    h.clock.advanceMs(10);
    await wf.signIn("supervisor");
    expect((await identityOf(adminA, second.id))?.status).toBe("ACTIVE");
    // 5b. Two sign-ins that share ONE IdP session (one browser), so the logout of one ends the other at the IdP: the
    //     console cannot tell that from offboarding and fails closed (suspended), reinstated by the next sign-in.
    wf.idp.revokeEndsUserSession = true;
    try {
      const a = (await wf.signIn("supervisor")).token;
      const b = (await wf.signIn("supervisor")).token;
      h.clock.advanceMs(1_000);
      expect((await h.call("auth.logout", { token: a })).statusCode).toBe(200);
      h.clock.advanceMs(61_000);
      expect(errorOf((await h.call("me", { token: b })).body).reasonCode).toBe("STAFF_DEPROVISIONED");
      expect(await identityOf(adminA, second.id)).toMatchObject({ status: "SUSPENDED", suspendReason: "CUSTODIAN_OFFBOARDED" });
    } finally {
      wf.idp.revokeEndsUserSession = false;
    }
    h.clock.advanceMs(10);
    await wf.signIn("supervisor");
    expect((await identityOf(adminA, second.id))?.status).toBe("ACTIVE");
    // 6. A request that races its own family's terminal path decides nothing: (a) a request racing its own logout (the
    //    logout decided: active), (b) a request racing its own refresh after the rotation committed, (c) a request
    //    while its own refresh is in flight (the IdP already redeemed the old token, the rotation is not committed yet).
    //    (d) A token past its known expiry explains nothing: the IdP no longer honours it, the custodian is suspended.
    const racedLogout = (await wf.signIn("supervisor")).token;
    h.clock.advanceMs(61_000);
    wf.idp.beforeIntrospect = async () => {
      expect((await h.call("auth.logout", { token: racedLogout })).statusCode).toBe(200);
    };
    expect(errorOf((await h.call("me", { token: racedLogout })).body).reasonCode).toBe("SESSION_REVOKED");
    expect((await identityOf(adminA, second.id))?.status).toBe("ACTIVE");
    const racedRefresh = (await wf.signIn("supervisor")).token;
    h.clock.advanceMs(61_000);
    let successor = "";
    wf.idp.beforeIntrospect = async () => {
      const r = await h.call("auth.refresh", { headers: { authorization: `Bearer ${racedRefresh}` } });
      expect(r.statusCode, r.body).toBe(200);
      successor = json<{ accessToken: string }>(r.body).accessToken;
    };
    const rotatedUnderneath = await h.call("me", { token: racedRefresh });
    expect(errorOf(rotatedUnderneath.body)).toMatchObject({ reasonCode: "SESSION_ROTATED", retryable: true });
    expect((await identityOf(adminA, second.id))?.status).toBe("ACTIVE");
    expect((await h.call("me", { token: successor })).statusCode).toBe(200);
    const inFlight = (await wf.signIn("supervisor")).token;
    h.clock.advanceMs(61_000);
    let during: { statusCode: number; body: string } | null = null;
    wf.idp.afterRefreshRedeemed = async () => {
      during = await h.call("me", { token: inFlight });
    };
    const refreshed = await h.call("auth.refresh", { headers: { authorization: `Bearer ${inFlight}` } });
    expect(refreshed.statusCode, refreshed.body).toBe(200);
    expect(during).not.toBeNull();
    expect(errorOf((during as unknown as { body: string }).body)).toMatchObject({ reasonCode: "SESSION_ROTATED", retryable: true });
    expect((await identityOf(adminA, second.id))?.status).toBe("ACTIVE");
    expect((await h.call("me", { token: json<{ accessToken: string }>(refreshed.body).accessToken })).statusCode).toBe(200);
    const c = (await wf.signIn("supervisor")).token;
    const row = await h.db.query<{ refresh_ciphertext: Uint8Array; refresh_iv: Uint8Array; refresh_tag: Uint8Array; refresh_key_id: string }>(
      "select refresh_ciphertext, refresh_iv, refresh_tag, refresh_key_id from console_sessions where session_hash = $1",
      [consoleSessionHash(c)],
    );
    const sealed = row.rows[0];
    if (!sealed) throw new Error("session row missing");
    const refreshToken = wf.sealer.open({ ciphertext: Buffer.from(sealed.refresh_ciphertext), iv: Buffer.from(sealed.refresh_iv), tag: Buffer.from(sealed.refresh_tag), keyId: sealed.refresh_key_id }, consoleSessionHash(c));
    await wf.idp.revoke(refreshToken);
    await h.db.query("update console_sessions set refresh_expires_at = $2::timestamptz where session_hash = $1", [consoleSessionHash(c), new Date(h.clock.now().getTime() - 1_000).toISOString()]);
    h.clock.advanceMs(61_000);
    expect(errorOf((await h.call("me", { token: c })).body).reasonCode).toBe("STAFF_DEPROVISIONED");
    expect(await identityOf(adminA, second.id)).toMatchObject({ status: "SUSPENDED", suspendReason: "CUSTODIAN_OFFBOARDED" });
    h.clock.advanceMs(10);
    await wf.signIn("supervisor");
    expect((await identityOf(adminA, second.id))?.status).toBe("ACTIVE");
  });

  // ------------------------------------------------------------------------------------------------------------------
  // The fail-closed custodian rule (FO-14-52; sessions.ts closeFamily): every TERMINAL path of an SSO session family
  // decides once, under a lock on the family's rows, with the IdP's answer; only a positive answer keeps a custodian.
  // ------------------------------------------------------------------------------------------------------------------
  const supUser = () => {
    const u = wf.idp.users.get(wf.subjectOf("supervisor"));
    if (!u) throw new Error("fixture user missing");
    return u;
  };
  /** A supervisor custodian: one fresh SSO session and one new ACTIVE identity (proposed by admin A, approved by B). */
  const custodian = async () => {
    const adminA = await h.token("securityAdmin");
    const adminB = await h.tokenForSubject(SECOND_ADMIN.idpSubject);
    h.clock.advanceMs(10);
    const sso = (await wf.signIn("supervisor")).token;
    const key = keyPair();
    return { adminA, sso, key, id: await enroll({ proposer: adminA, approver: adminB, holder: "supervisor", holderToken: sso, key, roles: ["supervisor"] }) };
  };
  const refreshCall = (token: string) => h.call("auth.refresh", { headers: { authorization: `Bearer ${token}` } });
  /** Holds the next IdP refresh before the provider is reached (nothing redeemed yet). */
  const holdNextRefresh = () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const reached = new Promise<void>((r) => (entered = r));
    wf.idp.beforeRefresh = async () => {
      entered();
      await gate;
    };
    return { reached, release };
  };
  const sealedTokenOf = async (bearer: string): Promise<string> => {
    const r = (
      await h.db.query<{ refresh_ciphertext: Uint8Array; refresh_iv: Uint8Array; refresh_tag: Uint8Array; refresh_key_id: string }>(
        "select refresh_ciphertext, refresh_iv, refresh_tag, refresh_key_id from console_sessions where session_hash = $1",
        [consoleSessionHash(bearer)],
      )
    ).rows[0];
    if (!r) throw new Error("session row missing");
    return wf.sealer.open({ ciphertext: Buffer.from(r.refresh_ciphertext), iv: Buffer.from(r.refresh_iv), tag: Buffer.from(r.refresh_tag), keyId: r.refresh_key_id }, consoleSessionHash(bearer));
  };
  /** Re-enabled at the IdP: the next SSO sign-in reinstates every SUSPENDED identity of the holder its roles cover. */
  const reinstate = async () => {
    supUser().active = true;
    h.clock.advanceMs(10);
    await wf.signIn("supervisor");
  };
  /** Identity status read by a security admin whose token is issued now (the clock moves far in these cases). */
  const stateOf = async (identityId: string) => {
    const i = await identityOf(await h.token("securityAdmin"), identityId);
    return { status: i?.status, suspendReason: i?.suspendReason ?? null };
  };
  const KEPT = { status: "ACTIVE", suspendReason: null };
  const OFFBOARDED = { status: "SUSPENDED", suspendReason: "CUSTODIAN_OFFBOARDED" };
  const EVIDENCE_LOST = { status: "SUSPENDED", suspendReason: "CUSTODIAN_EVIDENCE_LOST" };
  /** A refresh claim on the row `ageSeconds` old (a refresh in flight, or one whose process ended mid-refresh). */
  const setClaim = (bearer: string, ageSeconds: number) =>
    h.db.query("update console_sessions set refresh_started_at = $2::timestamptz where session_hash = $1", [consoleSessionHash(bearer), new Date(h.clock.now().getTime() - ageSeconds * 1000).toISOString()]);
  const revokeReasonOf = async (bearer: string) => (await h.db.query<{ revoke_reason: string | null }>("select revoke_reason from console_sessions where session_hash = $1", [consoleSessionHash(bearer)])).rows[0]?.revoke_reason ?? null;
  const suspensions = async () => (await h.db.query<{ n: number }>("select count(*)::int as n from audit_outbox where action = 'console.recovery_identity.suspended' and event->>'actorRef' = $1", [wf.staffIdOf("supervisor")])).rows[0]?.n ?? 0;
  const idpRefreshCalls = () => wf.idp.calls.filter((c) => c === "token:refresh_token").length;

  describe("[FO-14-52] the fail-closed custodian rule at every terminal path", () => {
    // Earlier cases leave sessions whose IdP tokens they revoked (one with revokeEndsUserSession): every closure now
    // asks the IdP, so they are all closed first (beyond the absolute lifetime) and the holders signed in again.
    beforeAll(async () => {
      for (const u of wf.idp.users.values()) u.active = true;
      h.clock.advanceSeconds(wf.config.session.absoluteLifetimeSeconds + 1);
      for (let i = 0; i < 10 && (await wf.service.sweep(1_000)).revoked > 0; i++);
      h.clock.advanceMs(10);
      for (const staff of ["supervisor", "safety"] as const) await wf.signIn(staff);
    });
    // Each case starts with every fixture user enabled, the IdP reachable and no race seam armed.
    beforeEach(() => {
      for (const u of wf.idp.users.values()) u.active = true;
      wf.idp.unavailable = false;
      wf.idp.beforeRefresh = null;
      wf.idp.afterRefreshRedeemed = null;
      wf.idp.beforeIntrospect = null;
      wf.idp.afterIntrospect = null;
    });

    it("[FO-14-52][FO-14-51][AUTH-04] logout decides at once with the IdP's answer, whatever refresh of the row is in flight (probe R): active keeps the custodian, and a refresh the logout's revocation then refuses decides nothing more; an inactive token or no answer suspends, with a fresh or a stale refresh claim; after a reinstatement the closed family never suspends again", async () => {
      // (a) An employed custodian logs out while their refresh is held before the IdP is asked: the logout's answer is
      //     ACTIVE (nothing redeemed yet), the custodian stays; the refresh then reaches the IdP and is refused (the logout
      //     revoked the token there), and that refusal on a family the logout already closed suspends nothing.
      const a = await custodian();
      h.clock.advanceMs(1_000);
      const beforeA = await suspensions();
      const heldA = holdNextRefresh();
      const refreshingA = refreshCall(a.sso);
      await heldA.reached;
      expect((await h.call("auth.logout", { token: a.sso })).statusCode).toBe(200);
      expect(await stateOf(a.id)).toEqual(KEPT);
      expect(await revokeReasonOf(a.sso)).toBe("STAFF_LOGOUT");
      const callsA = idpRefreshCalls();
      heldA.release();
      expect(errorOf((await refreshingA).body).reasonCode).toBe("SESSION_REFRESH_REFUSED");
      expect(idpRefreshCalls()).toBe(callsA + 1);
      expect(await stateOf(a.id)).toEqual(KEPT);
      expect(await suspensions()).toBe(beforeA);
      expect(await revokeReasonOf(a.sso)).toBe("STAFF_LOGOUT");

      // Probe R: a DISABLED custodian, a refresh of the session in flight, a logout of that session. The logout sees the
      // token inactive and suspends at once (it never waits for the refresh); the refresh is then refused and decides
      // nothing more (one suspension event).
      const r = await custodian();
      supUser().active = false;
      h.clock.advanceMs(1_000);
      const beforeR = await suspensions();
      const heldR = holdNextRefresh();
      const refreshingR = refreshCall(r.sso);
      await heldR.reached;
      expect((await h.call("auth.logout", { token: r.sso })).statusCode).toBe(200);
      expect(await stateOf(r.id)).toEqual(OFFBOARDED);
      expect(errorOf((await challenge(r.id, r.key)).body).reasonCode).toBe("RECOVERY_IDENTITY_UNAVAILABLE");
      heldR.release();
      expect(errorOf((await refreshingR).body).reasonCode).toBe("SESSION_REFRESH_REFUSED");
      expect(await stateOf(r.id)).toEqual(OFFBOARDED);
      expect(await suspensions()).toBe(beforeR + 1);
      // (f) Reinstated by a new sign-in: nothing about the closed family (the sweep included) suspends the custodian again.
      await reinstate();
      expect(await stateOf(r.id)).toEqual(KEPT);
      h.clock.advanceMs(61_000);
      await wf.service.sweep();
      expect(await stateOf(r.id)).toEqual(KEPT);

      // (f) The same order with the held refresh released only AFTER the reinstatement: its refusal on the closed family
      //     decides nothing, the sweep neither.
      const f = await custodian();
      supUser().active = false;
      h.clock.advanceMs(1_000);
      const heldF = holdNextRefresh();
      const refreshingF = refreshCall(f.sso);
      await heldF.reached;
      expect((await h.call("auth.logout", { token: f.sso })).statusCode).toBe(200);
      expect(await stateOf(f.id)).toEqual(OFFBOARDED);
      await reinstate();
      expect(await stateOf(f.id)).toEqual(KEPT);
      heldF.release();
      expect(errorOf((await refreshingF).body).reasonCode).toBe("SESSION_REFRESH_REFUSED");
      expect(await stateOf(f.id)).toEqual(KEPT);
      h.clock.advanceMs(61_000);
      await wf.service.sweep();
      expect(await stateOf(f.id)).toEqual(KEPT);

      // (c) The IdP cannot be asked at the logout and nothing is in flight: no answer is no positive answer, the
      //     custodian is suspended (CUSTODIAN_EVIDENCE_LOST), reinstated by the next sign-in. The logout is audited once,
      //     by the route (STAFF_LOGOUT); its family closure appends no console.auth.session_revoked event of its own.
      const c = await custodian();
      h.clock.advanceMs(1_000);
      const staffLogoutEvents = async () =>
        (await h.db.query<{ n: number }>("select count(*)::int as n from audit_outbox where event->>'reasonCode' = 'STAFF_LOGOUT' and event->>'actorRef' = $1", [wf.staffIdOf("supervisor")])).rows[0]?.n ?? 0;
      const logoutEventsBefore = await staffLogoutEvents();
      const routeLogoutBefore = await auditCount("console.auth.logout", "STAFF_LOGOUT", wf.staffIdOf("supervisor"));
      const logoutRevokedBefore = await auditCount("console.auth.session_revoked", "STAFF_LOGOUT", wf.staffIdOf("supervisor"));
      wf.idp.unavailable = true;
      try {
        expect((await h.call("auth.logout", { token: c.sso })).statusCode).toBe(200);
      } finally {
        wf.idp.unavailable = false;
      }
      expect(await revokeReasonOf(c.sso)).toBe("STAFF_LOGOUT");
      expect(await staffLogoutEvents()).toBe(logoutEventsBefore + 1);
      expect(await auditCount("console.auth.logout", "STAFF_LOGOUT", wf.staffIdOf("supervisor"))).toBe(routeLogoutBefore + 1);
      expect(await auditCount("console.auth.session_revoked", "STAFF_LOGOUT", wf.staffIdOf("supervisor"))).toBe(logoutRevokedBefore);
      expect(await stateOf(c.id)).toEqual(EVIDENCE_LOST);
      expect(await auditCount("console.recovery_identity.suspended", "CUSTODIAN_EVIDENCE_LOST", wf.staffIdOf("supervisor"))).toBeGreaterThan(0);
      await reinstate();
      expect(await stateOf(c.id)).toEqual(KEPT);

      // A disabled custodian whose row carries a refresh claim, stale (its process ended mid-refresh) or fresh (in
      // flight): the logout suspends at once either way; nothing waits for a refresh or for the sweep.
      for (const age of [REFRESH_IN_FLIGHT_SECONDS + 1, 5]) {
        const s = await custodian();
        await setClaim(s.sso, age);
        supUser().active = false;
        h.clock.advanceMs(1_000);
        expect((await h.call("auth.logout", { token: s.sso })).statusCode).toBe(200);
        expect(await stateOf(s.id), `claim ${age} s old`).toEqual(OFFBOARDED);
        await reinstate();
      }

      // An EMPLOYED custodian whose refresh the IdP has just redeemed when the logout asks: the old token is inactive and
      // nothing explains that away (fail closed: suspended, reinstated by the next sign-in). The refresh then finds the
      // family closed, answers SESSION_REVOKED, and the tokens the IdP just issued are revoked there.
      const e = await custodian();
      h.clock.advanceMs(1_000);
      const rtE = await sealedTokenOf(e.sso);
      wf.idp.afterRefreshRedeemed = async () => {
        expect((await h.call("auth.logout", { token: e.sso })).statusCode).toBe(200);
      };
      expect(errorOf((await refreshCall(e.sso)).body).reasonCode).toBe("SESSION_REVOKED");
      expect(await stateOf(e.id)).toEqual(OFFBOARDED);
      expect(wf.idp.familyStateOf(rtE)).toEqual(["REVOKED", "REVOKED"]);
      await reinstate();

      // A logout whose ACTIVE answer maps fewer roles than an identity carries: that identity is suspended
      // (CUSTODIAN_ROLES_REDUCED), the session is logged out as usual.
      const rr = await custodian();
      const groupsRr = [...supUser().groups];
      supUser().groups = [workforceGroupFor("support_agent")];
      try {
        expect((await h.call("auth.logout", { token: rr.sso })).statusCode).toBe(200);
      } finally {
        supUser().groups = groupsRr;
      }
      expect(await stateOf(rr.id)).toEqual({ status: "SUSPENDED", suspendReason: "CUSTODIAN_ROLES_REDUCED" });
      await reinstate();
      expect(await stateOf(rr.id)).toEqual(KEPT);

      // A double logout of one session (an employed custodian): the first one decided (active); the second one asks the
      // IdP after the first revoked the token there and finds the family already closed: nothing more is decided.
      const d = await custodian();
      h.clock.advanceMs(1_000);
      wf.idp.beforeIntrospect = async () => {
        expect((await h.call("auth.logout", { token: d.sso })).statusCode).toBe(200);
      };
      expect((await h.call("auth.logout", { token: d.sso })).statusCode).toBe(200);
      expect(await stateOf(d.id)).toEqual(KEPT);
    });

    it("[FO-14-52][FO-14-51][AUTH-04] a refresh the IdP refuses is a terminal path: a disabled custodian and an employed one whose token is past its known expiry are both suspended (no expiry explanation, fail closed); a second refresh of a row in flight is refused SESSION_ROTATED (retryable) without reaching the IdP, inside the in-flight window and not after it; an outage releases the claim", async () => {
      // A disabled custodian's refresh is refused by the IdP: suspended, activation refused.
      const x = await custodian();
      supUser().active = false;
      h.clock.advanceMs(1_000);
      expect(errorOf((await refreshCall(x.sso)).body).reasonCode).toBe("SESSION_REFRESH_REFUSED");
      expect(await stateOf(x.id)).toEqual(OFFBOARDED);
      expect(await revokeReasonOf(x.sso)).toBe("SESSION_REFRESH_REFUSED");
      expect(errorOf((await challenge(x.id, x.key)).body).reasonCode).toBe("RECOVERY_IDENTITY_UNAVAILABLE");
      await reinstate();
      expect(await stateOf(x.id)).toEqual(KEPT);

      // (b) An EMPLOYED custodian whose refresh token is past its known refresh_expires_at (the IdP no longer honours it):
      //     the refused refresh suspends, and so does the logout that finds such a token inactive.
      const expiredAt = () => new Date(h.clock.now().getTime() - 1_000).toISOString();
      const b1 = await custodian();
      await wf.idp.revoke(await sealedTokenOf(b1.sso));
      await h.db.query("update console_sessions set refresh_expires_at = $2::timestamptz where session_hash = $1", [consoleSessionHash(b1.sso), expiredAt()]);
      expect(errorOf((await refreshCall(b1.sso)).body).reasonCode).toBe("SESSION_REFRESH_REFUSED");
      expect(await stateOf(b1.id)).toEqual(OFFBOARDED);
      await reinstate();
      const b2 = await custodian();
      await wf.idp.revoke(await sealedTokenOf(b2.sso));
      await h.db.query("update console_sessions set refresh_expires_at = $2::timestamptz where session_hash = $1", [consoleSessionHash(b2.sso), expiredAt()]);
      expect((await h.call("auth.logout", { token: b2.sso })).statusCode).toBe(200);
      expect(await stateOf(b2.id)).toEqual(OFFBOARDED);
      await reinstate();

      // (d)(e) One refresh of a row reaches the IdP at a time: a second one while the first is held before the IdP (also
      //        5 s later, inside the window) is refused retryable and never reaches the IdP; nothing is suspended.
      const dd = await custodian();
      h.clock.advanceMs(1_000);
      const held = holdNextRefresh();
      const first = refreshCall(dd.sso);
      await held.reached;
      const calls = idpRefreshCalls();
      expect(errorOf((await refreshCall(dd.sso)).body)).toMatchObject({ reasonCode: "SESSION_ROTATED", retryable: true });
      h.clock.advanceSeconds(5);
      expect(errorOf((await refreshCall(dd.sso)).body)).toMatchObject({ reasonCode: "SESSION_ROTATED", retryable: true });
      expect(idpRefreshCalls()).toBe(calls);
      held.release();
      const firstDone = await first;
      expect(firstDone.statusCode, firstDone.body).toBe(200);
      expect(idpRefreshCalls()).toBe(calls + 1);
      expect(await stateOf(dd.id)).toEqual(KEPT);
      // The window's size: a claim one second inside it still refuses (no IdP call); one second beyond it has lapsed (a
      // crashed refresh never blocks the row for longer) and the refresh runs.
      const successor = json<{ accessToken: string }>(firstDone.body).accessToken;
      await setClaim(successor, REFRESH_IN_FLIGHT_SECONDS - 1);
      expect(errorOf((await refreshCall(successor)).body)).toMatchObject({ reasonCode: "SESSION_ROTATED", retryable: true });
      expect(idpRefreshCalls()).toBe(calls + 1);
      await setClaim(successor, REFRESH_IN_FLIGHT_SECONDS + 1);
      expect((await refreshCall(successor)).statusCode).toBe(200);
      expect(idpRefreshCalls()).toBe(calls + 2);
      expect(await stateOf(dd.id)).toEqual(KEPT);

      // An answer about the PERSON always applies, also on a family another path already closed: the logout asks the
      // IdP (active), the custodian is then removed from every group, the IdP redeems the held refresh before the
      // logout's revocation, and the logout closes the family first (active: nothing suspended). The refreshed ID token
      // then maps no role: the custodian is suspended all the same, and the tokens the IdP just issued are revoked.
      const p = await custodian();
      h.clock.advanceMs(1_000);
      const groupsP = [...supUser().groups];
      const heldP = holdNextRefresh();
      const refreshingP = refreshCall(p.sso);
      await heldP.reached;
      let redeemed!: () => void;
      const redeemedP = new Promise<void>((r) => (redeemed = r));
      let logoutDone!: () => void;
      const logoutDoneP = new Promise<void>((r) => (logoutDone = r));
      wf.idp.afterIntrospect = async () => {
        supUser().groups = [];
        heldP.release();
        await redeemedP;
      };
      wf.idp.afterRefreshRedeemed = async () => {
        redeemed();
        await logoutDoneP;
      };
      try {
        expect((await h.call("auth.logout", { token: p.sso })).statusCode).toBe(200);
        expect(await stateOf(p.id)).toEqual(KEPT);
        logoutDone();
        expect(errorOf((await refreshingP).body).reasonCode).toBe("STAFF_NOT_PROVISIONED");
      } finally {
        supUser().groups = groupsP;
      }
      expect(await stateOf(p.id)).toEqual(OFFBOARDED);
      expect(await revokeReasonOf(p.sso)).toBe("STAFF_LOGOUT");
      await reinstate();

      // An in-flight refresh that fails for an outage, with no logout: its claim is released at once (an immediate retry
      // runs) and nothing is suspended.
      const o = await custodian();
      h.clock.advanceMs(1_000);
      const heldO = holdNextRefresh();
      const failing = refreshCall(o.sso);
      await heldO.reached;
      wf.idp.unavailable = true;
      try {
        heldO.release();
        expect((await failing).statusCode).toBe(503);
      } finally {
        wf.idp.unavailable = false;
      }
      expect((await refreshCall(o.sso)).statusCode).toBe(200);
      expect(await stateOf(o.id)).toEqual(KEPT);
    });

    it("[FO-14-52][FO-14-51][AUTH-04] a request's active check that lost a refresh race on a live family is refused SESSION_ROTATED (retryable) and decides nothing, also 5 s into the in-flight window; a claim older than the window decides at once (suspended), and so does a fresh one once it lapses", async () => {
      // The window outlasts the IdP part of one refresh at the OIDC transport's maximum per-request deadline: the most
      // sequential requests one refresh makes (OIDC_REFRESH_MAX_REQUESTS, pinned in oidc-client.test.ts), 30 s each, plus
      // a margin for the console's database work (README step 5 names the value).
      expect(REFRESH_IN_FLIGHT_SECONDS * 1000).toBeGreaterThan(OIDC_REFRESH_MAX_REQUESTS * OIDC_REQUEST_TIMEOUT_MAX_MS);
      expect(REFRESH_IN_FLIGHT_SECONDS).toBe(180);
      {
        // (e) The IdP has redeemed the old token, the rotation is not committed yet, and 5 s pass: the request's active
        //     check sees the token inactive while the refresh is in flight and only refuses retryably.
        const e = await custodian();
        h.clock.advanceMs(61_000);
        let during: { statusCode: number; body: string } | null = null;
        wf.idp.afterRefreshRedeemed = async () => {
          h.clock.advanceSeconds(5);
          during = await h.call("me", { token: e.sso });
        };
        const refreshed = await refreshCall(e.sso);
        expect(refreshed.statusCode, refreshed.body).toBe(200);
        expect(errorOf((during as unknown as { body: string }).body)).toMatchObject({ reasonCode: "SESSION_ROTATED", retryable: true });
        expect(await stateOf(e.id)).toEqual(KEPT);
        expect((await h.call("me", { token: json<{ accessToken: string }>(refreshed.body).accessToken })).statusCode).toBe(200);

        // A refresh that committed its rotation only after its claim lapsed (a slow IdP): the request still holding the
        // superseded row lost the race on a live family, and the committed rotation alone makes it retryable.
        const rt = await custodian();
        h.clock.advanceMs(61_000);
        let successorRt = "";
        wf.idp.beforeIntrospect = async () => {
          const r = await refreshCall(rt.sso);
          expect(r.statusCode, r.body).toBe(200);
          successorRt = json<{ accessToken: string }>(r.body).accessToken;
          await setClaim(rt.sso, REFRESH_IN_FLIGHT_SECONDS + 1);
        };
        expect(errorOf((await h.call("me", { token: rt.sso })).body)).toMatchObject({ reasonCode: "SESSION_ROTATED", retryable: true });
        expect(await stateOf(rt.id)).toEqual(KEPT);
        expect((await h.call("me", { token: successorRt })).statusCode).toBe(200);

        // A disabled custodian whose row carries a claim older than the window (the refreshing process ended): the next
        // active check closes the family and suspends at once (no wait for the sweep).
        const s = await custodian();
        await setClaim(s.sso, REFRESH_IN_FLIGHT_SECONDS + 1);
        supUser().active = false;
        h.clock.advanceMs(61_000);
        expect(errorOf((await h.call("me", { token: s.sso })).body).reasonCode).toBe("STAFF_DEPROVISIONED");
        expect(await stateOf(s.id)).toEqual(OFFBOARDED);
        await reinstate();

        // The adapter refuses the introspection (not an outage): no answer about the person, so the active check closes
      // the family and suspends (CUSTODIAN_EVIDENCE_LOST); an outage instead keeps the session within the staleness
      // bound and decides nothing.
      const ar = await custodian();
      h.clock.advanceMs(61_000);
      const introspect = wf.idp.introspect.bind(wf.idp);
      wf.idp.introspect = async () => {
        throw new AccessDeniedError("OIDC_INTROSPECTION_REFUSED");
      };
      try {
        expect(errorOf((await h.call("me", { token: ar.sso })).body).reasonCode).toBe("STAFF_DEPROVISIONED");
      } finally {
        wf.idp.introspect = introspect;
      }
      expect(await stateOf(ar.id)).toEqual(EVIDENCE_LOST);
      await reinstate();

      // A claim inside the window (a refresh in flight): refused retryably, undecided; once the claim lapses, the next
        // check decides (suspended).
        const w = await custodian();
        supUser().active = false;
        h.clock.advanceMs(61_000);
        await setClaim(w.sso, REFRESH_IN_FLIGHT_SECONDS - 2);
        expect(errorOf((await h.call("me", { token: w.sso })).body)).toMatchObject({ reasonCode: "SESSION_ROTATED", retryable: true });
        expect(await stateOf(w.id)).toEqual(KEPT);
        h.clock.advanceSeconds(3);
        expect(errorOf((await h.call("me", { token: w.sso })).body).reasonCode).toBe("STAFF_DEPROVISIONED");
        expect(await stateOf(w.id)).toEqual(OFFBOARDED);
        await reinstate();
      }
    });

    it("[FO-14-52][FO-14-51][AUTH-04] the refresh-token replay closure asks the IdP about the family's live row (probe Q1): a disabled custodian who presents their own superseded bearer is suspended CUSTODIAN_OFFBOARDED and cannot activate, through refresh or a request; an employed one keeps the identity; no answer suspends; a replay raced between a logout's own answer and its decision decides once (probe Q2)", async () => {
      // Q1: one refresh while employed, disabled at the IdP, the superseded bearer presented to the refresh endpoint.
      const q = await custodian();
      h.clock.advanceMs(1_000);
      const r1 = await refreshCall(q.sso);
      expect(r1.statusCode, r1.body).toBe(200);
      const q2 = json<{ accessToken: string }>(r1.body).accessToken;
      supUser().active = false;
      h.clock.advanceMs(2_000);
      expect(errorOf((await refreshCall(q.sso)).body).reasonCode).toBe("SESSION_TOKEN_REPLAYED");
      expect(await stateOf(q.id)).toEqual(OFFBOARDED);
      expect(await revokeReasonOf(q2)).toBe("SESSION_TOKEN_REPLAYED");
      expect(errorOf((await h.call("me", { token: q2 })).body).reasonCode).toBe("SESSION_REVOKED");
      h.clock.advanceMs(61_000);
      await wf.service.sweep();
      expect(await stateOf(q.id)).toEqual(OFFBOARDED);
      expect(errorOf((await challenge(q.id, q.key)).body).reasonCode).toBe("RECOVERY_IDENTITY_UNAVAILABLE");
      await reinstate();

      // The same through an ordinary request after the rotation grace.
      const g = await custodian();
      const g1 = await refreshCall(g.sso);
      expect(g1.statusCode).toBe(200);
      supUser().active = false;
      h.clock.advanceSeconds(30);
      expect(errorOf((await h.call("me", { token: g.sso })).body).reasonCode).toBe("SESSION_TOKEN_REPLAYED");
      expect(await stateOf(g.id)).toEqual(OFFBOARDED);
      await reinstate();

      // An employed custodian's replay: the IdP vouches for the live row's subject with the roles, the identity stays
      // (the family is revoked all the same).
      const k = await custodian();
      const k1 = await refreshCall(k.sso);
      h.clock.advanceSeconds(30);
      expect(errorOf((await h.call("me", { token: k.sso })).body).reasonCode).toBe("SESSION_TOKEN_REPLAYED");
      expect(await stateOf(k.id)).toEqual(KEPT);
      expect(errorOf((await h.call("me", { token: json<{ accessToken: string }>(k1.body).accessToken })).body).reasonCode).toBe("SESSION_REVOKED");

      // No answer at the replay (the IdP cannot be asked): suspended CUSTODIAN_EVIDENCE_LOST.
      const u = await custodian();
      expect((await refreshCall(u.sso)).statusCode).toBe(200);
      wf.idp.unavailable = true;
      try {
        expect(errorOf((await refreshCall(u.sso)).body).reasonCode).toBe("SESSION_TOKEN_REPLAYED");
      } finally {
        wf.idp.unavailable = false;
      }
      expect(await stateOf(u.id)).toEqual(EVIDENCE_LOST);
      await reinstate();

      // Q2: a disabled custodian logs out of the successor; between the logout's own (inactive) answer and its locked
      //     decision the superseded bearer is replayed. The replay closure decides (suspended) and the logout then finds
      //     the family closed: one decision, the custodian stays suspended.
      const z = await custodian();
      const z1 = await refreshCall(z.sso);
      expect(z1.statusCode).toBe(200);
      const z2 = json<{ accessToken: string }>(z1.body).accessToken;
      supUser().active = false;
      h.clock.advanceMs(2_000);
      let replay: { statusCode: number; body: string } | null = null;
      let logoutAnswer: boolean | null = null;
      wf.idp.afterIntrospect = async (answer) => {
        logoutAnswer = answer.active;
        replay = await refreshCall(z.sso);
      };
      expect((await h.call("auth.logout", { token: z2 })).statusCode).toBe(200);
      expect(logoutAnswer).toBe(false);
      expect(errorOf((replay as unknown as { body: string }).body).reasonCode).toBe("SESSION_TOKEN_REPLAYED");
      expect(await stateOf(z.id)).toEqual(OFFBOARDED);
      expect(await revokeReasonOf(z2)).toBe("SESSION_TOKEN_REPLAYED");
      await reinstate();
    });

    it("[FO-14-52][FO-14-51][AUTH-04] an idle or absolute expiry closure is a terminal path too: the sweep and a request ask the IdP before they close an expired session, so a custodian disabled since the last active check is suspended, an employed one is not, and an unreachable IdP suspends (CUSTODIAN_EVIDENCE_LOST)", async () => {
      // Disabled right after the last check, the session then idles out: the sweep's expiry closure (it runs before the
      // due active checks) asks the IdP and suspends; activation is refused.
      const i = await custodian();
      supUser().active = false;
      h.clock.advanceSeconds(901);
      await wf.service.sweep();
      expect(await revokeReasonOf(i.sso)).toBe("SESSION_IDLE_EXPIRED");
      expect(await stateOf(i.id)).toEqual(OFFBOARDED);
      expect(errorOf((await challenge(i.id, i.key)).body).reasonCode).toBe("RECOVERY_IDENTITY_UNAVAILABLE");
      await reinstate();

      // An employed custodian's session idles out: the IdP vouches for them, the identity stays.
      const k = await custodian();
      h.clock.advanceSeconds(901);
      await wf.service.sweep();
      expect(await revokeReasonOf(k.sso)).toBe("SESSION_IDLE_EXPIRED");
      expect(await stateOf(k.id)).toEqual(KEPT);

      // The same closure through a request with the idle bearer.
      const q = await custodian();
      supUser().active = false;
      h.clock.advanceSeconds(901);
      expect(errorOf((await h.call("me", { token: q.sso })).body).reasonCode).toBe("SESSION_IDLE_EXPIRED");
      expect(await stateOf(q.id)).toEqual(OFFBOARDED);
      await reinstate();

      // Absolute expiry with continuous use: disabled within the active-check interval before the end, closed by the
      // sweep as SESSION_EXPIRED after asking the IdP: suspended.
      const a = await custodian();
      const absoluteEnd = h.clock.now().getTime() + wf.config.session.absoluteLifetimeSeconds * 1000;
      while (absoluteEnd - h.clock.now().getTime() > 830_000) {
        h.clock.advanceSeconds(800);
        expect((await h.call("me", { token: a.sso })).statusCode).toBe(200);
      }
      h.clock.set(new Date(absoluteEnd - 30_000));
      expect((await h.call("me", { token: a.sso })).statusCode).toBe(200);
      supUser().active = false;
      h.clock.advanceSeconds(31);
      await wf.service.sweep();
      expect(await revokeReasonOf(a.sso)).toBe("SESSION_EXPIRED");
      expect(await stateOf(a.id)).toEqual(OFFBOARDED);
      await reinstate();

      // The IdP cannot be asked when the sweep closes an idle session: no positive answer, suspended.
      const n = await custodian();
      h.clock.advanceSeconds(901);
      wf.idp.unavailable = true;
      try {
        await wf.service.sweep();
      } finally {
        wf.idp.unavailable = false;
      }
      expect(await revokeReasonOf(n.sso)).toBe("SESSION_IDLE_EXPIRED");
      expect(await stateOf(n.id)).toEqual(EVIDENCE_LOST);
      await reinstate();
    });

    it("[FO-14-52][FO-14-51][AUTH-04] an expiry closure is never subject to the refresh-race exception: a disabled custodian whose row carries a fresh refresh claim (5 s old) and idles out is closed SESSION_IDLE_EXPIRED and suspended CUSTODIAN_OFFBOARDED at once, by the sweep and by a request presenting the bearer, and so is one whose session reaches its absolute expiry", async () => {
      // The sweep's idle expiry closure: the claim inside REFRESH_IN_FLIGHT_SECONDS defers nothing.
      const s = await custodian();
      supUser().active = false;
      h.clock.advanceSeconds(901);
      await setClaim(s.sso, 5);
      await wf.service.sweep();
      expect(await revokeReasonOf(s.sso)).toBe("SESSION_IDLE_EXPIRED");
      expect(await stateOf(s.id)).toEqual(OFFBOARDED);
      expect(errorOf((await challenge(s.id, s.key)).body).reasonCode).toBe("RECOVERY_IDENTITY_UNAVAILABLE");
      await reinstate();

      // A request presenting the idle bearer: closed and suspended within that request.
      const q = await custodian();
      supUser().active = false;
      h.clock.advanceSeconds(901);
      await setClaim(q.sso, 5);
      expect(errorOf((await h.call("me", { token: q.sso })).body).reasonCode).toBe("SESSION_IDLE_EXPIRED");
      expect(await revokeReasonOf(q.sso)).toBe("SESSION_IDLE_EXPIRED");
      expect(await stateOf(q.id)).toEqual(OFFBOARDED);
      await reinstate();

      // Absolute expiry with continuous use and a fresh claim, closed by the sweep: SESSION_EXPIRED, suspended.
      const a = await custodian();
      const absoluteEnd = h.clock.now().getTime() + wf.config.session.absoluteLifetimeSeconds * 1000;
      while (absoluteEnd - h.clock.now().getTime() > 830_000) {
        h.clock.advanceSeconds(800);
        expect((await h.call("me", { token: a.sso })).statusCode).toBe(200);
      }
      h.clock.set(new Date(absoluteEnd - 30_000));
      expect((await h.call("me", { token: a.sso })).statusCode).toBe(200);
      supUser().active = false;
      h.clock.advanceSeconds(31);
      await setClaim(a.sso, 5);
      await wf.service.sweep();
      expect(await revokeReasonOf(a.sso)).toBe("SESSION_EXPIRED");
      expect(await stateOf(a.id)).toEqual(OFFBOARDED);
      await reinstate();
    });

    it("[FO-14-51][FO-14-52] a SUSPENDED custodian can neither request an activation nor co-sign one; reinstated by a new SSO sign-in, both work again", async () => {
      const x = await custodian();
      const adminB = await h.tokenForSubject(SECOND_ADMIN.idpSubject);
      h.clock.advanceMs(10);
      const ySso = (await wf.signIn("safety")).token;
      const yKey = keyPair();
      const yId = await enroll({ proposer: adminB, approver: x.adminA, holder: "safety", holderToken: ySso, key: yKey, roles: ["safety_responder"] });
      expect((await activate({ id: x.id, key: x.key }, { id: yId, key: yKey })).statusCode).toBe(200);
      // The co-signer is disabled at the IdP and logs out: suspended.
      const safety = wf.idp.users.get(wf.subjectOf("safety"));
      if (!safety) throw new Error("fixture user missing");
      safety.active = false;
      expect((await h.call("auth.logout", { token: ySso })).statusCode).toBe(200);
      expect(await stateOf(yId)).toEqual(OFFBOARDED);
      // As co-signer: refused inside the activation (the requester's challenge is issued, the activation is not).
      const cosigned = await activate({ id: x.id, key: x.key }, { id: yId, key: yKey });
      expect(cosigned.statusCode).not.toBe(200);
      expect(errorOf(cosigned.body).reasonCode).toBe("RECOVERY_IDENTITY_UNAVAILABLE");
      // As requester: no challenge at all.
      expect(errorOf((await challenge(yId, yKey)).body).reasonCode).toBe("RECOVERY_IDENTITY_UNAVAILABLE");
      safety.active = true;
      h.clock.advanceMs(10);
      await wf.signIn("safety");
      expect(await stateOf(yId)).toEqual(KEPT);
      expect((await activate({ id: x.id, key: x.key }, { id: yId, key: yKey })).statusCode).toBe(200);
    });

    const ROLES_REDUCED = { status: "SUSPENDED", suspendReason: "CUSTODIAN_ROLES_REDUCED" };
    const familyOf = async (bearer: string): Promise<string> => {
      const r = (await h.db.query<{ family_id: string }>("select family_id from console_sessions where session_hash = $1", [consoleSessionHash(bearer)])).rows[0];
      if (!r) throw new Error("session row missing");
      return r.family_id;
    };
    const introspections = () => wf.idp.calls.filter((c) => c === "introspect").length;

    it("[FO-14-52][FO-14-51][AUTH-04] only a new SSO sign-in reinstates a SUSPENDED identity: the positive answers of an active check, a refresh and a logout never do, nor do roles that come back at an active check or a refresh; an ACTIVE answer on a family another path already closed still suspends what its roles no longer cover (verifier probes N3, N4, N5, P1, P2)", async () => {
      // N3/P2: suspended (CUSTODIAN_EVIDENCE_LOST) through another sign-in's logout while the IdP could not be asked; the
      // first session then gets positive answers at its active check, its refresh and its logout: none reinstates.
      const n3 = await custodian();
      h.clock.advanceMs(10);
      const other = (await wf.signIn("supervisor")).token;
      wf.idp.unavailable = true;
      try {
        expect((await h.call("auth.logout", { token: other })).statusCode).toBe(200);
      } finally {
        wf.idp.unavailable = false;
      }
      expect(await stateOf(n3.id)).toEqual(EVIDENCE_LOST);
      h.clock.advanceSeconds(61);
      const checks = introspections();
      expect((await h.call("me", { token: n3.sso })).statusCode).toBe(200);
      expect(introspections()).toBe(checks + 1);
      expect(await stateOf(n3.id)).toEqual(EVIDENCE_LOST);
      const n3r = await refreshCall(n3.sso);
      expect(n3r.statusCode, n3r.body).toBe(200);
      expect(await stateOf(n3.id)).toEqual(EVIDENCE_LOST);
      expect((await h.call("auth.logout", { token: json<{ accessToken: string }>(n3r.body).accessToken })).statusCode).toBe(200);
      expect(await stateOf(n3.id)).toEqual(EVIDENCE_LOST);
      await reinstate();
      expect(await stateOf(n3.id)).toEqual(KEPT);

      const groups = [...supUser().groups];
      try {
        // N4: the active check maps fewer roles (suspended CUSTODIAN_ROLES_REDUCED); the roles come back and the next
        //     active check maps them again: the identity stays suspended.
        const n4 = await custodian();
        supUser().groups = [workforceGroupFor("support_agent")];
        h.clock.advanceSeconds(61);
        expect((await h.call("me", { token: n4.sso })).statusCode).toBe(200);
        expect(await stateOf(n4.id)).toEqual(ROLES_REDUCED);
        supUser().groups = groups;
        h.clock.advanceSeconds(61);
        expect((await h.call("me", { token: n4.sso })).statusCode).toBe(200);
        expect(await stateOf(n4.id)).toEqual(ROLES_REDUCED);
        await reinstate();
        expect(await stateOf(n4.id)).toEqual(KEPT);

        // N5: the same through two refreshes (fewer roles, then the roles again).
        const n5 = await custodian();
        supUser().groups = [workforceGroupFor("support_agent")];
        h.clock.advanceSeconds(1);
        const r1 = await refreshCall(n5.sso);
        expect(r1.statusCode, r1.body).toBe(200);
        expect(await stateOf(n5.id)).toEqual(ROLES_REDUCED);
        supUser().groups = groups;
        h.clock.advanceSeconds(1);
        const r2 = await refreshCall(json<{ accessToken: string }>(r1.body).accessToken);
        expect(r2.statusCode, r2.body).toBe(200);
        const r2Row = await h.db.query<{ roles: string[] }>("select roles from console_sessions where session_hash = $1", [consoleSessionHash(json<{ accessToken: string }>(r2.body).accessToken)]);
        expect(r2Row.rows[0]?.roles).toEqual(["supervisor"]);
        expect(await stateOf(n5.id)).toEqual(ROLES_REDUCED);
        await reinstate();
        expect(await stateOf(n5.id)).toEqual(KEPT);

        // P1: a logout whose ACTIVE answer maps fewer roles; before its locked decision a second logout of the session
        //     (the roles back, ACTIVE) closes the family and keeps the identity. The first answer still applies on the
        //     closed family: an answer about the person is never dropped (CUSTODIAN_ROLES_REDUCED).
        const p1 = await custodian();
        supUser().groups = [workforceGroupFor("support_agent")];
        wf.idp.afterIntrospect = async () => {
          supUser().groups = groups;
          expect((await h.call("auth.logout", { token: p1.sso })).statusCode).toBe(200);
          expect(await stateOf(p1.id)).toEqual(KEPT);
        };
        expect((await h.call("auth.logout", { token: p1.sso })).statusCode).toBe(200);
        expect(await stateOf(p1.id)).toEqual(ROLES_REDUCED);
        expect(await revokeReasonOf(p1.sso)).toBe("STAFF_LOGOUT");
      } finally {
        supUser().groups = groups;
      }
      await reinstate();
    });

    it("[FO-14-52][FO-14-51][AUTH-04] the refresh-race exception is narrow: an answer about the person suspends at once although a refresh of the row is in flight; a family another path closed meanwhile is no race (SESSION_REVOKED, not retryable); a logout that finds its family closed asks the IdP nothing; a replay whose family has no live row left suspends (no answer)", async () => {
      // A refresh of the row is held before the IdP (claimed just now); the custodian is removed from every group and the
      // request's active check gets an answer about the PERSON: closed and suspended at once, no race exception.
      const pr = await custodian();
      h.clock.advanceSeconds(61);
      const groups = [...supUser().groups];
      const held = holdNextRefresh();
      const refreshing = refreshCall(pr.sso);
      await held.reached;
      supUser().groups = [];
      try {
        expect(errorOf((await h.call("me", { token: pr.sso })).body).reasonCode).toBe("STAFF_NOT_PROVISIONED");
        expect(await stateOf(pr.id)).toEqual(OFFBOARDED);
      } finally {
        supUser().groups = groups;
        held.release();
      }
      expect(errorOf((await refreshing).body).reasonCode).toBe("SESSION_REFRESH_REFUSED");
      expect(await stateOf(pr.id)).toEqual(OFFBOARDED);
      await reinstate();

      // A disabled custodian whose row carries a fresh refresh claim; between the active check's (inactive) answer and
      // its locked decision the session is logged out, and that logout decides (suspended). The active check then finds
      // the family closed: SESSION_REVOKED, not the retryable SESSION_ROTATED of a race on a live family.
      const rc = await custodian();
      supUser().active = false;
      h.clock.advanceSeconds(61);
      await setClaim(rc.sso, 5);
      const famRc = await familyOf(rc.sso);
      wf.idp.afterIntrospect = async () => {
        await wf.service.logout({ tenantId: wf.config.tenantId, familyId: famRc, sessionHash: consoleSessionHash(rc.sso) }, h.clock.now());
      };
      expect(errorOf((await h.call("me", { token: rc.sso })).body)).toMatchObject({ reasonCode: "SESSION_REVOKED", retryable: false });
      expect(await revokeReasonOf(rc.sso)).toBe("STAFF_LOGOUT");
      expect(await stateOf(rc.id)).toEqual(OFFBOARDED);
      await reinstate();

      // A logout that finds its family already closed (another terminal path ended it between the request's
      // authentication and the logout): nothing is asked, nothing decided.
      const lc = await custodian();
      const famLc = await familyOf(lc.sso);
      expect((await h.call("auth.logout", { token: lc.sso })).statusCode).toBe(200);
      const asked = introspections();
      await wf.service.logout({ tenantId: wf.config.tenantId, familyId: famLc, sessionHash: consoleSessionHash(lc.sso) }, h.clock.now());
      expect(introspections()).toBe(asked);
      expect(await stateOf(lc.id)).toEqual(KEPT);

      // A family left without a live row (its successor revoked on its own, outside a family closure): a replay of the
      // superseded bearer has no token to ask the IdP about, so it is no positive answer: closed and suspended.
      const ln = await custodian();
      const ln1 = await refreshCall(ln.sso);
      expect(ln1.statusCode, ln1.body).toBe(200);
      await h.db.query("update console_sessions set revoked_at = $2::timestamptz, revoke_reason = 'OPERATOR_REVOKED' where session_hash = $1", [consoleSessionHash(json<{ accessToken: string }>(ln1.body).accessToken), h.clock.now().toISOString()]);
      h.clock.advanceSeconds(30);
      const askedLn = introspections();
      expect(errorOf((await h.call("me", { token: ln.sso })).body).reasonCode).toBe("SESSION_TOKEN_REPLAYED");
      expect(introspections()).toBe(askedLn);
      expect(await revokeReasonOf(ln.sso)).toBe("SESSION_TOKEN_REPLAYED");
      expect(await stateOf(ln.id)).toEqual(EVIDENCE_LOST);
      await reinstate();
    });

    it("[FO-14-52][FO-14-51][AUTH-04] a refresh still running beyond REFRESH_IN_FLIGHT_SECONDS (a paused process) lets a second refresh of the row reach the IdP; the one presenting the token the IdP already redeemed is refused, the family closes and the custodian is suspended: availability only, never fail open (verifier probe P3)", async () => {
      const p3 = await custodian();
      h.clock.advanceMs(1_000);
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let reached!: () => void;
      const redeemed = new Promise<void>((r) => (reached = r));
      wf.idp.afterRefreshRedeemed = async () => {
        reached();
        await gate;
      };
      const first = refreshCall(p3.sso);
      await redeemed;
      h.clock.advanceSeconds(REFRESH_IN_FLIGHT_SECONDS + 1);
      const calls = idpRefreshCalls();
      const second = await refreshCall(p3.sso);
      expect(idpRefreshCalls()).toBe(calls + 1);
      expect(errorOf(second.body).reasonCode).toBe("SESSION_REFRESH_REFUSED");
      expect(await revokeReasonOf(p3.sso)).toBe("SESSION_REFRESH_REFUSED");
      expect(await stateOf(p3.id)).toEqual(OFFBOARDED);
      release();
      expect(errorOf((await first).body).reasonCode).toBe("SESSION_REVOKED");
      expect(await stateOf(p3.id)).toEqual(OFFBOARDED);
      expect(await h.db.query<{ n: number }>("select count(*)::int as n from console_sessions where family_id = $1", [await familyOf(p3.sso)]).then((r) => r.rows[0]?.n)).toBe(1);
      await reinstate();
    });

    it("[FO-05-19][FO-14-52][OPS-01] a terminal path whose audit write fails still closes, without its audit events, and appends them on their own: a replayed bearer revokes the family (the successor is refused after the audit store recovers) and suspends a disabled custodian; with the audit store down entirely the active check's revocation still closes and suspends, and both failures are logged; on a family another path closed, an answer about the person still suspends and no revocation is recorded for it (verifier probe N2)", async () => {
      const writer = h.consoleAudit;
      const append = writer.append.bind(writer);
      const appendStandalone = writer.appendStandalone.bind(writer);
      const auditOf = async (action: string, reason: string) =>
        (await h.db.query<{ n: number }>("select count(*)::int as n from audit_outbox where action = $1 and event->>'reasonCode' = $2 and event->>'actorRef' = $3", [action, reason, wf.staffIdOf("supervisor")])).rows[0]?.n ?? 0;
      const logged = (event: string) => h.logs.filter((r) => r.event === event && r.level === "error").length;

      // The replay closure: the in-transaction append of its session event fails once (the transaction rolls back).
      const n2 = await custodian();
      h.clock.advanceSeconds(1);
      const r1 = await refreshCall(n2.sso);
      expect(r1.statusCode, r1.body).toBe(200);
      const successor = json<{ accessToken: string }>(r1.body).accessToken;
      const successorRefresh = await sealedTokenOf(successor);
      expect(wf.idp.familyStateOf(successorRefresh)).toEqual(["ROTATED", "ACTIVE"]);
      supUser().active = false;
      h.clock.advanceSeconds(30);
      const revokedEvents = await auditOf("console.auth.session_revoked", "SESSION_TOKEN_REPLAYED");
      const suspendedEvents = await suspensions();
      const unaudited = logged("console.sso.terminal_closure_unaudited");
      let failures = 0;
      writer.append = async (tx, ev, stream) => {
        if (ev.action === "console.auth.session_revoked") {
          failures += 1;
          throw new AuditUnavailableError("AUDIT_STORE_UNWRITABLE");
        }
        return append(tx, ev, stream);
      };
      let replay: { statusCode: number; body: string };
      try {
        replay = await h.call("me", { token: n2.sso });
      } finally {
        writer.append = append;
      }
      expect(failures).toBe(1);
      expect(errorOf(replay.body).reasonCode).toBe("SESSION_TOKEN_REPLAYED");
      expect(await revokeReasonOf(n2.sso)).toBe("SESSION_TOKEN_REPLAYED");
      expect(await revokeReasonOf(successor)).toBe("SESSION_TOKEN_REPLAYED");
      expect(errorOf((await h.call("me", { token: successor })).body).reasonCode).toBe("SESSION_REVOKED");
      // The fallback keeps the decision's IdP side: the closed family's refresh token is revoked at the IdP (RFC 7009).
      const idpFamily = wf.idp.familyStateOf(successorRefresh);
      expect(idpFamily).toHaveLength(2);
      expect(idpFamily?.every((state) => state === "REVOKED"), JSON.stringify(idpFamily)).toBe(true);
      expect(await stateOf(n2.id)).toEqual(OFFBOARDED);
      expect(logged("console.sso.terminal_closure_unaudited")).toBe(unaudited + 1);
      // The events were appended on their own once the decision stood.
      expect(await auditOf("console.auth.session_revoked", "SESSION_TOKEN_REPLAYED")).toBe(revokedEvents + 1);
      expect(await suspensions()).toBe(suspendedEvents + 1);
      await reinstate();

      // The audit store refuses every session and custodian event, in a transaction and on its own: the active check of
      // a disabled custodian still closes the family and suspends; each unwritten event is logged.
      const down = await custodian();
      supUser().active = false;
      h.clock.advanceSeconds(61);
      const unwritten = logged("console.sso.terminal_audit_unwritten");
      const refused = new Set(["console.auth.session_revoked", "console.recovery_identity.suspended"]);
      writer.append = async (tx, ev, stream) => {
        if (refused.has(ev.action)) throw new AuditUnavailableError("AUDIT_STORE_UNWRITABLE");
        return append(tx, ev, stream);
      };
      writer.appendStandalone = async (ev, stream) => {
        if (refused.has(ev.action)) throw new AuditUnavailableError("AUDIT_STORE_UNWRITABLE");
        return appendStandalone(ev, stream);
      };
      try {
        expect(errorOf((await h.call("me", { token: down.sso })).body).reasonCode).toBe("STAFF_DEPROVISIONED");
      } finally {
        writer.append = append;
        writer.appendStandalone = appendStandalone;
      }
      expect(await revokeReasonOf(down.sso)).toBe("STAFF_DEPROVISIONED");
      expect(await stateOf(down.id)).toEqual(OFFBOARDED);
      expect(logged("console.sso.terminal_audit_unwritten")).toBe(unwritten + 2);
      await reinstate();

      // On a family another path closed meanwhile: the active check's answer about the person (no mapped role) still
      // suspends; its custodian event fails inside the transaction, so the decision runs again without it and the event
      // is appended on its own; no session revocation is recorded for this path, which revoked nothing.
      const pc = await custodian();
      const famPc = await familyOf(pc.sso);
      h.clock.advanceSeconds(61);
      const groups = [...supUser().groups];
      supUser().groups = [];
      wf.idp.afterIntrospect = async () => {
        supUser().groups = groups;
        await wf.service.logout({ tenantId: wf.config.tenantId, familyId: famPc, sessionHash: consoleSessionHash(pc.sso) }, h.clock.now());
        expect(await stateOf(pc.id)).toEqual(KEPT);
      };
      const notProvisioned = await auditOf("console.auth.session_revoked", "STAFF_NOT_PROVISIONED");
      const suspendedBefore = await suspensions();
      const unauditedBefore = logged("console.sso.terminal_closure_unaudited");
      writer.append = async (tx, ev, stream) => {
        if (ev.action === "console.recovery_identity.suspended") throw new AuditUnavailableError("AUDIT_STORE_UNWRITABLE");
        return append(tx, ev, stream);
      };
      try {
        expect(errorOf((await h.call("me", { token: pc.sso })).body).reasonCode).toBe("STAFF_NOT_PROVISIONED");
      } finally {
        writer.append = append;
        supUser().groups = groups;
      }
      expect(await revokeReasonOf(pc.sso)).toBe("STAFF_LOGOUT");
      expect(await stateOf(pc.id)).toEqual(OFFBOARDED);
      expect(logged("console.sso.terminal_closure_unaudited")).toBe(unauditedBefore + 1);
      expect(await suspensions()).toBe(suspendedBefore + 1);
      expect(await auditOf("console.auth.session_revoked", "STAFF_NOT_PROVISIONED")).toBe(notProvisioned);
      await reinstate();
    });

    it("[FO-05-19][FO-14-52][OPS-01] a terminal path whose closure the database refuses on both attempts (not an audit failure) answers the original error: a logout is not reported done (503 DB_UNAVAILABLE), an active check of a disabled custodian and a replay closure are not answered 401; nothing is revoked or suspended, no session or custodian event is appended and no unaudited closure is logged; once the database is back the same path closes and suspends (verifier probes DB-1, F2)", async () => {
      const store = wf.sessions;
      const closeFamily = store.closeFamily.bind(store);
      const staffId = wf.staffIdOf("supervisor");
      const eventsOf = async (action: string) => (await h.db.query<{ n: number }>("select count(*)::int as n from audit_outbox where action = $1 and event->>'actorRef' = $2", [action, staffId])).rows[0]?.n ?? 0;
      /** Session and custodian events of the custodian, and the unaudited-closure logs (any level). */
      const trail = async () => ({
        sessionRevoked: await eventsOf("console.auth.session_revoked"),
        suspended: await eventsOf("console.recovery_identity.suspended"),
        reinstated: await eventsOf("console.recovery_identity.reinstated"),
        unaudited: h.logs.filter((r) => r.event === "console.sso.terminal_closure_unaudited").length,
      });
      /** Runs `call` while every closeFamily attempt fails because the database refuses it (DependencyError). */
      const whileDatabaseRefuses = async (call: () => Promise<{ statusCode: number; body: string }>) => {
        let attempts = 0;
        store.closeFamily = async () => {
          attempts += 1;
          throw new DependencyError("DB_UNAVAILABLE", "NOT_STARTED", true);
        };
        try {
          const response = await call();
          return { response, attempts };
        } finally {
          store.closeFamily = closeFamily;
        }
      };
      const expectOriginalError = (r: { response: { statusCode: number; body: string }; attempts: number }) => {
        expect(r.attempts).toBe(2);
        expect(r.response.statusCode, r.response.body).toBe(503);
        expect(errorOf(r.response.body).reasonCode).toBe("DB_UNAVAILABLE");
      };

      // (a) Logout of a disabled custodian (the IdP answers inactive): 503 DB_UNAVAILABLE, never 200 loggedOut.
      const a = await custodian();
      supUser().active = false;
      h.clock.advanceMs(1_000);
      const beforeA = await trail();
      const logout = await whileDatabaseRefuses(() => h.call("auth.logout", { token: a.sso }));
      expectOriginalError(logout);
      expect(logout.response.body).not.toContain("loggedOut");
      expect(await revokeReasonOf(a.sso)).toBeNull();
      expect(await stateOf(a.id)).toEqual(KEPT);
      expect(await trail()).toEqual(beforeA);
      expect((await h.call("auth.logout", { token: a.sso })).statusCode).toBe(200);
      expect(await revokeReasonOf(a.sso)).toBe("STAFF_LOGOUT");
      expect(await stateOf(a.id)).toEqual(OFFBOARDED);
      await reinstate();

      // (b) The due active check of a disabled custodian: not 401 STAFF_DEPROVISIONED.
      const b = await custodian();
      supUser().active = false;
      h.clock.advanceSeconds(61);
      const beforeB = await trail();
      const check = await whileDatabaseRefuses(() => h.call("me", { token: b.sso }));
      expectOriginalError(check);
      expect(await revokeReasonOf(b.sso)).toBeNull();
      expect(await stateOf(b.id)).toEqual(KEPT);
      expect(await trail()).toEqual(beforeB);
      expect(errorOf((await h.call("me", { token: b.sso })).body).reasonCode).toBe("STAFF_DEPROVISIONED");
      expect(await revokeReasonOf(b.sso)).toBe("STAFF_DEPROVISIONED");
      expect(await stateOf(b.id)).toEqual(OFFBOARDED);
      await reinstate();

      // (c) The refresh-token replay closure: a superseded bearer presented after the grace, the custodian disabled
      //     meanwhile: not 401 SESSION_TOKEN_REPLAYED; the successor row stays unrevoked.
      const c = await custodian();
      h.clock.advanceSeconds(1);
      const c1 = await refreshCall(c.sso);
      expect(c1.statusCode, c1.body).toBe(200);
      const successor = json<{ accessToken: string }>(c1.body).accessToken;
      supUser().active = false;
      h.clock.advanceSeconds(30);
      const beforeC = await trail();
      const replay = await whileDatabaseRefuses(() => h.call("me", { token: c.sso }));
      expectOriginalError(replay);
      expect(await revokeReasonOf(successor)).toBeNull();
      expect(await revokeReasonOf(c.sso)).toBeNull();
      expect(await stateOf(c.id)).toEqual(KEPT);
      expect(await trail()).toEqual(beforeC);
      expect(errorOf((await h.call("me", { token: c.sso })).body).reasonCode).toBe("SESSION_TOKEN_REPLAYED");
      expect(await revokeReasonOf(successor)).toBe("SESSION_TOKEN_REPLAYED");
      expect(await stateOf(c.id)).toEqual(OFFBOARDED);
      await reinstate();
    });
  });

  it("[FO-14-51][FO-14-52] activation needs both custodians' recent positive IdP evidence (14 days) and the requester's roles still mapped; an IdP-authenticated sign-in the directory refuses suspends the custodian", async () => {
    const adminA = await h.token("securityAdmin");
    const adminB = await h.tokenForSubject(SECOND_ADMIN.idpSubject);
    h.clock.advanceMs(10);
    const xKey = keyPair();
    const xId = await enroll({ proposer: adminA, approver: adminB, holder: "supervisor", holderToken: (await wf.signIn("supervisor")).token, key: xKey, roles: ["supervisor"] });
    const yKey = keyPair();
    const yId = await enroll({ proposer: adminB, approver: adminA, holder: "safety", holderToken: (await wf.signIn("safety")).token, key: yKey, roles: ["safety_responder"] });
    expect((await activate({ id: xId, key: xKey }, { id: yId, key: yKey })).statusCode).toBe(200);
    // 14 days and a second later, with no SSO answer about the holder since: refused, though the identity is ACTIVE.
    h.clock.advanceSeconds(14 * 86_400 + 1);
    await wf.signIn("safety");
    const stale = await activate({ id: xId, key: xKey }, { id: yId, key: yKey });
    expect(errorOf(stale.body).reasonCode).toBe("RECOVERY_HOLDER_NOT_AUTHENTICATED");
    expect((await identityOf(await h.token("securityAdmin"), xId))?.status).toBe("ACTIVE");
    // The holder signs in again: the path is back. Now the co-signer is the stale one.
    await wf.signIn("supervisor");
    expect((await activate({ id: xId, key: xKey }, { id: yId, key: yKey })).statusCode).toBe(200);
    h.clock.advanceSeconds(14 * 86_400 + 1);
    await wf.signIn("supervisor");
    expect(errorOf((await activate({ id: xId, key: xKey }, { id: yId, key: yKey })).body).reasonCode).toBe("RECOVERY_COSIGNER_NOT_AUTHENTICATED");
    await wf.signIn("safety");
    // Defence in depth: the holder's newest IdP evidence maps fewer roles than the identity carries (a row written
    // behind the service's back, so no suspension ran): the activation itself refuses.
    h.clock.advanceMs(10);
    await h.db.query(
      `insert into console_sessions (session_hash, family_id, generation, kind, tenant_id, staff_id, issuer_digest, subject_digest, roles, amr, authenticated_at, created_at, last_activity_at,
         idle_timeout_seconds, absolute_expires_at, active_checked_at, audit_event_id)
       select $1, 'csf_synthEvidenceRowOnly0001', 1, 'OIDC_SSO', tenant_id, staff_id, issuer_digest, subject_digest, array['support_agent'], amr, $2::timestamptz, $2::timestamptz, $2::timestamptz,
              idle_timeout_seconds, $2::timestamptz + interval '1 hour', $2::timestamptz, audit_event_id
         from console_sessions where staff_id = $3 and kind = 'OIDC_SSO' order by active_checked_at desc limit 1`,
      ["e".repeat(64), h.clock.now().toISOString(), wf.staffIdOf("supervisor")],
    );
    expect(errorOf((await activate({ id: xId, key: xKey }, { id: yId, key: yKey })).body).reasonCode).toBe("RECOVERY_ROLES_NOT_GRANTED");
    // An IdP-authenticated sign-in the directory refuses (removed from every managed group, no live session
    // checked): the refusal itself suspends the custodian's identities.
    const u = wf.idp.users.get(wf.subjectOf("safety"));
    if (!u) throw new Error("fixture user missing");
    const groups = [...u.groups];
    u.groups = [];
    await expect(wf.signIn("safety")).rejects.toThrow(/STAFF_NOT_PROVISIONED/);
    expect(await identityOf(await h.token("securityAdmin"), yId)).toMatchObject({ status: "SUSPENDED", suspendReason: "CUSTODIAN_OFFBOARDED" });
    u.groups = groups;
  });

  it("[FO-14-51][OPS-01][STRIDE-D] the challenge endpoint consumes nothing for anonymous requests: no proof, a wrong key, a stale or replayed proof are refused with nothing written, and the custodian's own signed request still gets a challenge (probe P4)", async () => {
    const adminA = await h.token("securityAdmin");
    const adminB = await h.tokenForSubject(SECOND_ADMIN.idpSubject);
    h.clock.advanceMs(10);
    const supSso = (await wf.signIn("supervisor")).token;
    const key = keyPair();
    const id = await enroll({ proposer: adminA, approver: adminB, holder: "supervisor", holderToken: supSso, key, roles: ["supervisor"] });
    const rows = async () => (await h.db.query<{ n: number }>("select count(*)::int as n from console_recovery_activations where identity_id = $1", [id])).rows[0]?.n ?? 0;
    const attempts = [
      h.call("auth.recoveryChallenge", { body: { identityId: id } }),
      h.call("auth.recoveryChallenge", { body: { identityId: id, proof: "eyJhbGciOiJFUzI1NiJ9.eyJ4IjoxfQ.c2lnbmF0dXJlLW5vdC12YWxpZA" } }),
      h.call("auth.recoveryChallenge", { body: { identityId: id, proof: await signRecoveryRequest({ privateKey: keyPair().privateKey, tenantId: TENANT_ID, identityId: id, now: h.clock.now() }) } }),
      h.call("auth.recoveryChallenge", { body: { identityId: id, proof: await signRecoveryRequest({ privateKey: key.privateKey, tenantId: TENANT_ID, identityId: id, now: new Date(h.clock.now().getTime() - 600_000) }) } }),
    ];
    for (let i = 0; i < 5; i++) attempts.push(h.call("auth.recoveryChallenge", { body: { identityId: id, proof: await signRecoveryRequest({ privateKey: keyPair().privateKey, tenantId: TENANT_ID, identityId: id, now: h.clock.now() }) } }));
    const statuses = (await Promise.all(attempts)).map((r) => r.statusCode);
    expect(statuses.every((st) => st === 400 || st === 401), String(statuses)).toBe(true);
    expect(await rows()).toBe(0);
    // The custodian's signed request gets a challenge; replaying that exact request is refused, nothing written.
    const nonce = "N".repeat(43);
    expect((await challenge(id, key, nonce)).statusCode).toBe(200);
    const replay = await challenge(id, key, nonce);
    expect(errorOf(replay.body).reasonCode).toBe("RECOVERY_REQUEST_REPLAYED");
    expect(await rows()).toBe(1);
    // The per-identity budget counts only signed requests: 3 pending, then refused (retryable).
    expect((await challenge(id, key)).statusCode).toBe(200);
    expect((await challenge(id, key)).statusCode).toBe(200);
    expect(errorOf((await challenge(id, key)).body).reasonCode).toBe("RECOVERY_CHALLENGE_LIMIT");
    expect(await rows()).toBe(3);
  });
});
