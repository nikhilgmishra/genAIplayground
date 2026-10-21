/**
 * Layer 2 (WP-05): dual-controlled SSO-outage recovery (FO-14-51) on PostgreSQL 16 (every migration, the
 * app_console role under row-level security, a real connection pool), with the workforce IdP DOWN: the
 * WorkforceSsoService is built over the production OIDC adapters pointed at an address nothing listens on, so
 * everything here works without the IdP, as the recovery path must.
 *
 * Covered: a RECOVERY session is bound to the recovery identity it was activated with, not to the holder:
 * revoking that identity ends the session even while the holder keeps another ACTIVE identity, revoking the
 * holder's other identity does not; the per-request identity check holds even when the session row was not
 * revoked; and both orders of an activation racing a revocation end without a live session for a revoked
 * identity (the revocation committed first: refused inside the activation transaction; the activation holds
 * the identity row share lock first: the revocation waits for it and then revokes the new session). The same
 * holds for an IdP offboarding signal (suspension) racing an activation, about the requester or the co-signer. The database itself (migration 2051
 * CHECKs, trigger and row-level security under app_console) refuses an approval before the holder's proof, and
 * a holder confirmation or suspension written by anyone but the holder's own transaction. Two terminal paths of one
 * SSO session family racing on two connections (a logout and a replay closure, both held at their decision by a third
 * connection's lock on the family's rows) decide once: the row lock of `closeFamily` serializes them.
 *
 * Holders' earlier SSO sign-ins (before this outage) are console session rows written through the production
 * PgConsoleSessionStore: enrollment and activation require that positive IdP evidence (recovery.ts).
 * SYNTHETIC staff ids and keys only.
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { createServer } from "node:net";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { OidcRelyingPartyClient } from "../../../src/adapters/live/oidc-client.js";
import { OidcDiscovery } from "../../../src/adapters/live/oidc-discovery.js";
import { OidcHttp } from "../../../src/adapters/live/oidc-http.js";
import type { AuditWriter } from "../../../src/audit/ports.js";
import { PgAuditWriter } from "../../../src/audit/writer.js";
import { WorkforceTokenVerifier } from "../../../src/console-api/auth.js";
import { PgBreakGlassIssuance } from "../../../src/console-api/break-glass-issuance.js";
import { OidcGroupStaffDirectory } from "../../../src/console-api/oidc-staff-directory.js";
import { BREAK_GLASS_MAX_DURATION_SECONDS } from "../../../src/console-api/plugin.js";
import { PgRecoveryService, signRecoveryChallenge, signRecoveryEnrollment, signRecoveryRequest } from "../../../src/console-api/recovery.js";
import { PgConsoleSessionStore, consoleSessionHash, issuerDigestOf, newConsoleSessionToken, newSessionFamilyId, subjectDigestOf } from "../../../src/console-api/sessions.js";
import type { CustodianAnswer } from "../../../src/console-api/sessions.js";
import { DEFAULT_WORKFORCE_SESSION, parseWorkforceSsoConfig } from "../../../src/console-api/sso-config.js";
import { WorkforceSsoService } from "../../../src/console-api/sso.js";
import { consoleAuditInput } from "../../../src/console-api/stores.js";
import { AesGcmTokenSealer } from "../../../src/console-api/token-sealer.js";
import { ConnectorHttpTransport } from "../../../src/connectors/http/transport.js";
import type { Db, Queryable, TxOptions } from "../../../src/db/types.js";
import { createMemoryLogger } from "../../../src/observability/logger.js";
import { EgressGuard } from "../../../src/privacy/egress.js";
import type { AuditEvent, AuditEventInput, StaffRole } from "../../../src/protocol/index.js";
import { systemClock } from "../../../src/shared/clock.js";
import { newId } from "../../../src/shared/ids.js";
import { createIntegrationDb } from "../_harness/clients.js";
import type { IntegrationDb } from "../_harness/clients.js";
import { layer2, layer2Context } from "../_harness/layer2.js";
import { IDP_HOST, IDP_ORIGIN } from "./support.js";

const SERVICES = ["postgres"];
const it = layer2(SERVICES);
const TENANT = "tnt_synthRecoveryL2Tenant";
const ISSUER = `${IDP_ORIGIN}/realms/vsp-it-recovery-idp-down`;
const staff = () => `stf_${randomBytes(15).toString("base64url")}`;

let idb: IntegrationDb;
let writer: PgAuditWriter;
let sessions: PgConsoleSessionStore;
let recovery: PgRecoveryService;
let sso: WorkforceSsoService;

/** A loopback port that refuses connections: the workforce IdP is down for this whole file. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** WorkforceSsoService over the production OIDC adapters routed to a dead address (the IdP outage). */
function ssoWithIdpDown(db: Db, port: number): WorkforceSsoService {
  const egress = new EgressGuard(
    { policyVersion: "egress-recovery-l2-1", destinations: [{ destinationId: "egr_recovery_idp", kind: "VERIFICATION_SERVICE", hosts: [IDP_HOST], allowedClasses: ["PUBLIC", "VERIFICATION_SECRET"], coverage: { baaRef: null, approvalId: "apr_synthRecoveryL2Idp01" }, environments: ["local", "ci"], adapterKind: "live" }] },
    { environment: "local" },
  );
  const transport = new ConnectorHttpTransport({ environment: "local", egress, loopbackRoutes: new Map([[IDP_HOST, { port, tls: true }]]) });
  const http = new OidcHttp({ transport, egress, destination: { allowedHosts: [IDP_HOST], addressClass: "PUBLIC_INTERNET" }, timeoutMs: 2_000 });
  const discovery = new OidcDiscovery({ issuer: ISSUER, http, clock: systemClock });
  const secret = randomBytes(24).toString("base64url");
  const client = new OidcRelyingPartyClient({ clientId: "vsp-console", discovery, http, auth: { method: "client_secret_basic", clientSecret: async () => secret }, clock: systemClock, algorithms: ["RS256", "ES256"] });
  const config = parseWorkforceSsoConfig({
    tenantId: TENANT,
    issuer: ISSUER,
    clientId: "vsp-console",
    scopes: ["openid"],
    redirectUris: ["https://console.vsp-identity.test/auth/callback"],
    groupsClaim: "vsp_roles",
    membershipSource: { kind: "CLIENT_ROLES" },
    groupRoles: { supervisor: "supervisor" },
    managedGroupPrefix: null,
    acceptedMfaAmr: null,
    maxAuthAgeSeconds: 600,
    loginTransactionTtlSeconds: 600,
    session: { ...DEFAULT_WORKFORCE_SESSION, activeCheckIntervalSeconds: 0 },
    sessionParametersApprovalId: null,
  });
  return new WorkforceSsoService({
    config,
    oidc: client,
    directory: new OidcGroupStaffDirectory(config),
    verifier: WorkforceTokenVerifier.withKeys({ issuer: ISSUER, audience: "vsp-console", keys: discovery.keyResolver(), clock: systemClock, acceptedMfaAmr: config.acceptedMfaAmr }),
    sessions: new PgConsoleSessionStore(db),
    sealer: new AesGcmTokenSealer({ current: { id: "l2-recovery-sealer-1", key: randomBytes(32) } }),
    audit: new PgAuditWriter({ db, clock: systemClock, stream: "console.recovery-l2-sso", standaloneRole: "app_console" }),
    clock: systemClock,
    logger: createMemoryLogger().logger,
  });
}

const keyPair = (): { privateKey: KeyObject; jwk: { kty: "EC"; crv: "P-256"; x: string; y: string } } => {
  const k = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const j = k.publicKey.export({ format: "jwk" }) as { x: string; y: string };
  return { privateKey: k.privateKey, jwk: { kty: "EC", crv: "P-256", x: j.x, y: j.y } };
};

const audit = (staffId: string, action: string, reasonCode: string) =>
  consoleAuditInput({ tenantId: TENANT, correlationId: newId("cor"), staffId, role: "security_admin" as StaffRole, action, outcome: "SUCCEEDED", reasonCode, occurredAt: systemClock.now() });

const reasonOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "NO_ERROR";
  } catch (e) {
    return (e as { reasonCode?: string }).reasonCode ?? String(e);
  }
};

/**
 * The holder's SSO sign-in from before the outage: an OIDC_SSO console session row (production store), i.e. the
 * positive IdP evidence enrollment and activation require. Returns the session hash (the holder's SSO session).
 */
async function ssoSignInBeforeOutage(holder: string, roles: StaffRole[] = ["supervisor"]): Promise<string> {
  const now = systemClock.now();
  const sessionHash = consoleSessionHash(newConsoleSessionToken());
  await sessions.insert(writer, {
    sessionHash,
    familyId: newSessionFamilyId(),
    generation: 1,
    kind: "OIDC_SSO",
    tenantId: TENANT,
    staffId: holder,
    issuerDigest: issuerDigestOf(ISSUER),
    subjectDigest: subjectDigestOf(ISSUER, `synthetic-${holder}`),
    roles,
    amr: ["pwd", "otp"],
    authenticatedAt: now,
    authTimeEpoch: Math.floor(now.getTime() / 1000),
    nonceHash: null,
    createdAt: now,
    lastActivityAt: now,
    idleTimeoutSeconds: 900,
    absoluteExpiresAt: new Date(now.getTime() + 3_600_000),
    activeCheckedAt: now,
    refresh: null,
    refreshExpiresAt: null,
  }, audit(holder, "console.auth.oidc_exchange", "WORKFORCE_SSO_SIGN_IN"));
  return sessionHash;
}

async function activeIdentity(svc: PgRecoveryService, holder: string, adminA: string, adminB: string, attestation: string) {
  const key = keyPair();
  const holderSession = await ssoSignInBeforeOutage(holder);
  const proposed = await svc.propose({ proposerId: adminA, body: { staffId: holder, publicJwk: key.jwk, attestationRef: attestation, roles: ["supervisor"] }, now: systemClock.now(), audit: audit(adminA, "console.recovery_identity.propose", "RECOVERY_IDENTITY_PROPOSED") });
  const identity = proposed.identity;
  const signature = await signRecoveryEnrollment({ privateKey: key.privateKey, tenantId: TENANT, identityId: identity.identityId, staffId: holder, keyThumbprint: identity.keyThumbprint, challenge: proposed.enrollment.challenge, now: systemClock.now() });
  await svc.confirm({ holder: { staffId: holder, sessionKind: "OIDC_SSO", sessionHash: holderSession, roles: ["supervisor"] }, identityId: identity.identityId, signature, now: systemClock.now(), audit: audit(holder, "console.recovery_identities.confirm", "RECOVERY_IDENTITY_HOLDER_CONFIRMED") });
  const approved = await svc.approve({ approverId: adminB, identityId: identity.identityId, now: systemClock.now(), audit: audit(adminB, "console.recovery_identity.approve", "RECOVERY_IDENTITY_APPROVED") });
  expect(approved.status).toBe("ACTIVE");
  return { identityId: identity.identityId, key };
}

type Identity = Awaited<ReturnType<typeof activeIdentity>>;

/** The custodian's signed activation request (only the key holder can ask for a challenge). */
const requestProof = (who: Identity, nonce?: string) => signRecoveryRequest({ privateKey: who.key.privateKey, tenantId: TENANT, identityId: who.identityId, now: systemClock.now(), nonce });

async function signedActivation(svc: PgRecoveryService, requester: Identity, cosigner: Identity) {
  const c = await svc.challenge({ identityId: requester.identityId, proof: await requestProof(requester), correlationId: newId("cor") });
  const sign = (who: Identity) => signRecoveryChallenge({ privateKey: who.key.privateKey, tenantId: TENANT, activationId: c.activationId, challenge: c.challenge, identityId: who.identityId, now: systemClock.now() });
  return { activationId: c.activationId, approvals: [{ identityId: requester.identityId, signature: await sign(requester) }, { identityId: cosigner.identityId, signature: await sign(cosigner) }] };
}

const revokeInput = (adminId: string, identityId: string) => ({ adminId, identityId, reason: "ROTATION", now: systemClock.now(), audit: audit(adminId, "console.recovery_identity.revoke", "RECOVERY_IDENTITY_REVOKED") });

/** Test seam: holds the n-th transaction this service starts until released (a revocation then commits first). */
class TxBarrierDb implements Db {
  readonly engine = "pg" as const;
  private calls = 0;
  private holdAt = 0;
  arrived = false;
  private release: () => void = () => undefined;
  private gate: Promise<void> = Promise.resolve();
  constructor(private readonly inner: Db) {}
  holdNthTransaction(n: number): void {
    this.calls = 0;
    this.holdAt = n;
    this.arrived = false;
    this.gate = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }
  open(): void {
    this.holdAt = 0;
    this.release();
  }
  async tx<T>(fn: (tx: Queryable) => Promise<T>, opts?: TxOptions): Promise<T> {
    this.calls += 1;
    if (this.holdAt > 0 && this.calls === this.holdAt) {
      this.arrived = true;
      await Promise.race([this.gate, new Promise((r) => setTimeout(r, 15_000))]);
    }
    return this.inner.tx(fn, opts);
  }
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
    return this.inner.query<T>(sql, params);
  }
  exec(sql: string): Promise<void> {
    return this.inner.exec(sql);
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** Test seam: the activation's audit append (inside its transaction, after the identity share lock) waits. */
class ActivationAuditBarrier implements AuditWriter {
  arrived = false;
  private release: () => void = () => undefined;
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });
  constructor(private readonly inner: AuditWriter) {}
  open(): void {
    this.release();
  }
  async append(tx: Queryable, input: AuditEventInput, stream?: string): Promise<AuditEvent> {
    if (input.action === "console.auth.recovery_activate" && input.outcome === "SUCCEEDED") {
      this.arrived = true;
      await Promise.race([this.gate, new Promise((r) => setTimeout(r, 15_000))]);
    }
    return this.inner.append(tx, input, stream);
  }
  appendStandalone(input: AuditEventInput, stream?: string): Promise<AuditEvent> {
    return this.inner.appendStandalone(input, stream);
  }
}

const until = async (cond: () => boolean, ms = 10_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("BARRIER_NEVER_REACHED");
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("dual-controlled recovery on PostgreSQL 16 with the workforce IdP down", () => {
  beforeAll(async () => {
    const l2 = layer2Context(SERVICES);
    idb = await createIntegrationDb(l2);
    writer = new PgAuditWriter({ db: idb.db, clock: systemClock, stream: "console.recovery-l2", standaloneRole: "app_console" });
    sessions = new PgConsoleSessionStore(idb.db);
    const issuance = new PgBreakGlassIssuance(idb.db, writer, BREAK_GLASS_MAX_DURATION_SECONDS);
    recovery = new PgRecoveryService({ db: idb.db, audit: writer, sessions, issuance, clock: systemClock, tenantId: TENANT });
    sso = ssoWithIdpDown(idb.db, await closedPort());
  }, 120_000);

  afterAll(async () => {
    await idb?.drop();
  });

  it("[FO-14-51][AUTH-04][AUTH-02] a RECOVERY session is bound to the identity it was activated with: revoking it ends the session although the holder keeps another ACTIVE identity; revoking the other one does not", async () => {
    const [adminA, adminB, holder, custodian] = [staff(), staff(), staff(), staff()];
    const x1 = await activeIdentity(recovery, holder, adminA, adminB, "att_synthRecoveryL2Hold1");
    const x2 = await activeIdentity(recovery, holder, adminA, adminB, "att_synthRecoveryL2Hold2");
    const y = await activeIdentity(recovery, custodian, adminB, adminA, "att_synthRecoveryL2Cust1");
    // The IdP is down: workforce sign-in fails closed as unavailable; recovery does not need the IdP.
    expect(await reasonOf(sso.start({ redirectUri: "https://console.vsp-identity.test/auth/callback", codeChallenge: randomBytes(32).toString("base64url") }))).toBe("WORKFORCE_IDP_UNAVAILABLE");
    const s1 = await recovery.activate({ body: await signedActivation(recovery, x1, y), correlationId: newId("cor") });
    expect(await sso.authenticate(`Bearer ${s1.token}`)).toMatchObject({ kind: "RECOVERY", staffId: holder, roles: ["supervisor"] });
    // The holder's OTHER identity is revoked: this session (from x1) is untouched.
    await recovery.revoke(revokeInput(adminA, x2.identityId));
    expect((await sso.authenticate(`Bearer ${s1.token}`)).staffId).toBe(holder);
    const x3 = await activeIdentity(recovery, holder, adminA, adminB, "att_synthRecoveryL2Hold3");
    // x1 itself is revoked while the holder still has x3 ACTIVE: the session ends in the same transaction.
    await recovery.revoke(revokeInput(adminB, x1.identityId));
    const row = await idb.db.query<{ revoke_reason: string | null }>("select revoke_reason from console_sessions where session_hash = $1", [consoleSessionHash(s1.token)]);
    expect(row.rows[0]?.revoke_reason).toBe("RECOVERY_IDENTITY_REVOKED");
    expect(await reasonOf(sso.authenticate(`Bearer ${s1.token}`))).toBe("SESSION_REVOKED");
    expect(await recovery.hasActiveIdentity(holder)).toBe(true);
    // Per-request check, independent of the row revocation: x3 is revoked by a writer that bypasses the service.
    const s3 = await recovery.activate({ body: await signedActivation(recovery, x3, y), correlationId: newId("cor") });
    expect((await sso.authenticate(`Bearer ${s3.token}`)).staffId).toBe(holder);
    await idb.db.query("update console_recovery_identities set status = 'REVOKED', revoked_by = $2, revoked_at = now(), revoke_reason = 'ROTATION' where identity_id = $1", [x3.identityId, adminA]);
    expect(await reasonOf(sso.authenticate(`Bearer ${s3.token}`))).toBe("RECOVERY_IDENTITY_REVOKED");
    expect(await reasonOf(sso.authenticate(`Bearer ${s3.token}`))).toBe("SESSION_REVOKED");
  });

  it("[FO-14-51][OPS-01][STRIDE-D] the unauthenticated challenge endpoint is bounded per identity and only the key holder can consume the bound: anonymous, wrong-key and replayed requests write nothing; 3 signed pending challenges, then refused (retryable)", async () => {
    const [adminA, adminB, holder] = [staff(), staff(), staff()];
    const x = await activeIdentity(recovery, holder, adminA, adminB, "att_synthRecoveryL2Bound1");
    const rows = async () => (await idb.db.query<{ n: number }>("select count(*)::int as n from console_recovery_activations where identity_id = $1", [x.identityId])).rows[0]?.n ?? 0;
    const audited = async (correlationId: string) => (await idb.db.query<{ n: number }>("select count(*)::int as n from audit_outbox where action = 'console.auth.recovery_challenge' and correlation_id = $1", [correlationId])).rows[0]?.n ?? 0;
    // Five anonymous floods (another key, a garbage JWS) before the custodian: nothing written, nothing counted.
    for (let i = 0; i < 5; i++) {
      const forged = await signRecoveryRequest({ privateKey: keyPair().privateKey, tenantId: TENANT, identityId: x.identityId, now: systemClock.now() });
      expect(await reasonOf(recovery.challenge({ identityId: x.identityId, proof: i % 2 === 0 ? forged : "eyJhbGciOiJFUzI1NiJ9.e30.c2ln", correlationId: newId("cor") }))).toBe("RECOVERY_REQUEST_PROOF_INVALID");
    }
    expect(await rows()).toBe(0);
    const first = newId("cor");
    const nonce = randomBytes(32).toString("base64url");
    await recovery.challenge({ identityId: x.identityId, proof: await requestProof(x, nonce), correlationId: first });
    expect(await audited(first)).toBe(1);
    // The same signed request replayed (unique nonce per identity, enforced by the database): refused, nothing written.
    expect(await reasonOf(recovery.challenge({ identityId: x.identityId, proof: await requestProof(x, nonce), correlationId: newId("cor") }))).toBe("RECOVERY_REQUEST_REPLAYED");
    for (let i = 0; i < 2; i++) await recovery.challenge({ identityId: x.identityId, proof: await requestProof(x), correlationId: newId("cor") });
    expect(await rows()).toBe(3);
    const refusedCorrelation = newId("cor");
    expect(await reasonOf(recovery.challenge({ identityId: x.identityId, proof: await requestProof(x), correlationId: refusedCorrelation }))).toBe("RECOVERY_CHALLENGE_LIMIT");
    expect(await rows()).toBe(3);
    expect(await audited(refusedCorrelation)).toBe(0);
    // An unknown identity id writes nothing either.
    expect(await reasonOf(recovery.challenge({ identityId: newId("rci", 24), proof: await requestProof(x), correlationId: newId("cor") }))).toBe("RECOVERY_IDENTITY_UNAVAILABLE");
  });

  it("[FO-14-51][AUTH-02] the database binds enrollment and suspension to the holder: no approval before the holder's proof, and a confirmation or suspension written in another actor's transaction is refused (app_console, row-level security and trigger)", async () => {
    const [adminA, adminB, holder] = [staff(), staff(), staff()];
    const holderSession = await ssoSignInBeforeOutage(holder);
    const key = keyPair();
    const proposed = await recovery.propose({ proposerId: adminA, body: { staffId: holder, publicJwk: key.jwk, attestationRef: "att_synthRecoveryL2DbBind1", roles: ["supervisor"] }, now: systemClock.now(), audit: audit(adminA, "console.recovery_identity.propose", "RECOVERY_IDENTITY_PROPOSED") });
    const id = proposed.identity.identityId;
    const asActor = (actorId: string, sql: string, params: unknown[]) => reasonOf(idb.db.tx((tx) => tx.query(sql, params), { role: "app_console", rls: { tenantId: TENANT, actorId } }));
    // Approval by a second admin before the holder confirmed: the CHECK refuses it (whatever the code path).
    expect(await asActor(adminB, "update console_recovery_identities set status = 'ACTIVE', approved_by = $2, approved_at = now() where identity_id = $1", [id, adminB])).toMatch(/console_rci_approval_after_confirmation|CHECK|23514|check/i);
    // The proposer writing the holder's confirmation in their own transaction: refused by the trigger.
    expect(await asActor(adminA, "update console_recovery_identities set holder_confirmed_at = now() where identity_id = $1", [id])).not.toBe("NO_ERROR");
    // The real path: the holder confirms in their SSO session; then the approval holds.
    const signature = await signRecoveryEnrollment({ privateKey: key.privateKey, tenantId: TENANT, identityId: id, staffId: holder, keyThumbprint: proposed.identity.keyThumbprint, challenge: proposed.enrollment.challenge, now: systemClock.now() });
    await recovery.confirm({ holder: { staffId: holder, sessionKind: "OIDC_SSO", sessionHash: holderSession, roles: ["supervisor"] }, identityId: id, signature, now: systemClock.now(), audit: audit(holder, "console.recovery_identities.confirm", "RECOVERY_IDENTITY_HOLDER_CONFIRMED") });
    expect((await recovery.approve({ approverId: adminB, identityId: id, now: systemClock.now(), audit: audit(adminB, "console.recovery_identity.approve", "RECOVERY_IDENTITY_APPROVED") })).status).toBe("ACTIVE");
    // A suspension written in an admin's transaction (not the holder's): refused; the identity stays ACTIVE.
    expect(await asActor(adminA, "update console_recovery_identities set status = 'SUSPENDED', suspended_at = now(), suspend_reason = 'CUSTODIAN_OFFBOARDED' where identity_id = $1", [id])).not.toBe("NO_ERROR");
    expect((await recovery.get(adminA, id))?.status).toBe("ACTIVE");
    // A proposal for a staff id that never signed in by SSO writes nothing.
    expect(await reasonOf(recovery.propose({ proposerId: adminA, body: { staffId: staff(), publicJwk: keyPair().jwk, attestationRef: "att_synthRecoveryL2DbBind2", roles: ["supervisor"] }, now: systemClock.now(), audit: audit(adminA, "console.recovery_identity.propose", "RECOVERY_IDENTITY_PROPOSED") }))).toBe("RECOVERY_HOLDER_NOT_AUTHENTICATED");
  });

  it("[FO-14-51][AUTH-04] race, revocation first: the identity is revoked after the activation read it but before the activation transaction; nothing is issued", async () => {
    const [adminA, adminB, holder, custodian] = [staff(), staff(), staff(), staff()];
    const x = await activeIdentity(recovery, holder, adminA, adminB, "att_synthRecoveryL2RaceA1");
    const y = await activeIdentity(recovery, custodian, adminB, adminA, "att_synthRecoveryL2RaceA2");
    const body = await signedActivation(recovery, x, y);
    const barrierDb = new TxBarrierDb(idb.db);
    const racing = new PgRecoveryService({ db: barrierDb, audit: writer, sessions, issuance: new PgBreakGlassIssuance(idb.db, writer, BREAK_GLASS_MAX_DURATION_SECONDS), clock: systemClock, tenantId: TENANT });
    // activate: (1) read the activation, (2) read both identities, (3) the claiming transaction <- held here.
    barrierDb.holdNthTransaction(3);
    const activation = reasonOf(racing.activate({ body, correlationId: newId("cor") }));
    await until(() => barrierDb.arrived);
    await recovery.revoke(revokeInput(adminA, x.identityId));
    barrierDb.open();
    expect(await activation).toBe("RECOVERY_IDENTITY_UNAVAILABLE");
    const issued = await idb.db.query<{ n: number }>("select count(*)::int as n from console_sessions where kind = 'RECOVERY' and staff_id = $1", [holder]);
    expect(issued.rows[0]?.n).toBe(0);
    const act = await idb.db.query<{ status: string; outcome: string }>("select status, outcome from console_recovery_activations where activation_id = $1", [body.activationId]);
    expect(act.rows[0]).toMatchObject({ status: "REFUSED", outcome: "RECOVERY_IDENTITY_UNAVAILABLE" });
  });

  it("[FO-14-52][FO-14-51][AUTH-04] race, activation first, IdP offboarding signal second: the suspension waits for the activation's identity lock and then ends the session it created; suspension first: the activation is refused", async () => {
    const [adminA, adminB, holder, custodian] = [staff(), staff(), staff(), staff()];
    const x = await activeIdentity(recovery, holder, adminA, adminB, "att_synthRecoveryL2RaceC1");
    const y = await activeIdentity(recovery, custodian, adminB, adminA, "att_synthRecoveryL2RaceC2");
    const suspend = () => sessions.suspendCustodian(writer, { tenantId: TENANT, staffId: holder, now: systemClock.now(), custodian: (c) => [consoleAuditInput({ tenantId: TENANT, correlationId: newId("cor"), staffId: holder, role: null, action: "console.recovery_identity.suspended", outcome: "SUCCEEDED", reasonCode: c.reason ?? "CUSTODIAN_OFFBOARDED", occurredAt: systemClock.now() })] });
    const body = await signedActivation(recovery, x, y);
    const barrier = new ActivationAuditBarrier(writer);
    const racing = new PgRecoveryService({ db: idb.db, audit: barrier, sessions, issuance: new PgBreakGlassIssuance(idb.db, writer, BREAK_GLASS_MAX_DURATION_SECONDS), clock: systemClock, tenantId: TENANT });
    const activation = racing.activate({ body, correlationId: newId("cor") });
    await until(() => barrier.arrived);
    let suspendedAt: number | null = null;
    const suspension = suspend().then((v) => {
      suspendedAt = Date.now();
      return v;
    });
    await new Promise((r) => setTimeout(r, 750));
    expect(suspendedAt).toBeNull();
    const releasedAt = Date.now();
    barrier.open();
    const issued = await activation;
    const change = await suspension;
    expect(change.suspended).toEqual([x.identityId]);
    expect(change.recoverySessionsRevoked).toBe(1);
    expect(suspendedAt as unknown as number).toBeGreaterThanOrEqual(releasedAt);
    const row = await idb.db.query<{ revoke_reason: string | null }>("select revoke_reason from console_sessions where session_hash = $1", [consoleSessionHash(issued.token)]);
    expect(row.rows[0]?.revoke_reason).toBe("CUSTODIAN_OFFBOARDED");
    expect(await reasonOf(sso.authenticate(`Bearer ${issued.token}`))).toBe("SESSION_REVOKED");
    // Suspension first: an activation that read the identity before is refused inside its transaction.
    const [holder2, custodian2] = [staff(), staff()];
    const x2 = await activeIdentity(recovery, holder2, adminA, adminB, "att_synthRecoveryL2RaceC3");
    const y2 = await activeIdentity(recovery, custodian2, adminB, adminA, "att_synthRecoveryL2RaceC4");
    const body2 = await signedActivation(recovery, x2, y2);
    const barrierDb = new TxBarrierDb(idb.db);
    const racing2 = new PgRecoveryService({ db: barrierDb, audit: writer, sessions, issuance: new PgBreakGlassIssuance(idb.db, writer, BREAK_GLASS_MAX_DURATION_SECONDS), clock: systemClock, tenantId: TENANT });
    barrierDb.holdNthTransaction(3);
    const activation2 = reasonOf(racing2.activate({ body: body2, correlationId: newId("cor") }));
    await until(() => barrierDb.arrived);
    await sessions.suspendCustodian(writer, { tenantId: TENANT, staffId: holder2, now: systemClock.now(), custodian: () => [] });
    barrierDb.open();
    expect(await activation2).toBe("RECOVERY_IDENTITY_UNAVAILABLE");
    const issued2 = await idb.db.query<{ n: number }>("select count(*)::int as n from console_sessions where kind = 'RECOVERY' and staff_id = $1", [holder2]);
    expect(issued2.rows[0]?.n).toBe(0);
  });

  it("[FO-14-52][FO-14-51][AUTH-04] race, the CO-SIGNER's suspension first: an IdP offboarding signal about the co-signer commits after the activation read both identities but before its transaction; the activation is refused inside it and nothing is issued", async () => {
    const [adminA, adminB, holder, custodian] = [staff(), staff(), staff(), staff()];
    const x = await activeIdentity(recovery, holder, adminA, adminB, "att_synthRecoveryL2RaceD1");
    const y = await activeIdentity(recovery, custodian, adminB, adminA, "att_synthRecoveryL2RaceD2");
    const body = await signedActivation(recovery, x, y);
    const barrierDb = new TxBarrierDb(idb.db);
    const racing = new PgRecoveryService({ db: barrierDb, audit: writer, sessions, issuance: new PgBreakGlassIssuance(idb.db, writer, BREAK_GLASS_MAX_DURATION_SECONDS), clock: systemClock, tenantId: TENANT });
    // activate: (1) read the activation, (2) read both identities (both ACTIVE), (3) the claiming transaction <- held.
    barrierDb.holdNthTransaction(3);
    const activation = reasonOf(racing.activate({ body, correlationId: newId("cor") }));
    await until(() => barrierDb.arrived);
    const change = await sessions.suspendCustodian(writer, { tenantId: TENANT, staffId: custodian, now: systemClock.now(), custodian: () => [] });
    expect(change.suspended).toEqual([y.identityId]);
    barrierDb.open();
    expect(await activation).toBe("RECOVERY_IDENTITY_UNAVAILABLE");
    const issued = await idb.db.query<{ n: number }>("select count(*)::int as n from console_sessions where kind = 'RECOVERY' and staff_id = $1", [holder]);
    expect(issued.rows[0]?.n).toBe(0);
    const act = await idb.db.query<{ status: string; outcome: string }>("select status, outcome from console_recovery_activations where activation_id = $1", [body.activationId]);
    expect(act.rows[0]).toMatchObject({ status: "REFUSED", outcome: "RECOVERY_IDENTITY_UNAVAILABLE" });
  });

  it("[FO-14-51][AUTH-04] race, activation first: the revocation waits for the activation's identity lock and then revokes the session it created", async () => {
    const [adminA, adminB, holder, custodian] = [staff(), staff(), staff(), staff()];
    const x = await activeIdentity(recovery, holder, adminA, adminB, "att_synthRecoveryL2RaceB1");
    const y = await activeIdentity(recovery, custodian, adminB, adminA, "att_synthRecoveryL2RaceB2");
    const body = await signedActivation(recovery, x, y);
    const barrier = new ActivationAuditBarrier(writer);
    const racing = new PgRecoveryService({ db: idb.db, audit: barrier, sessions, issuance: new PgBreakGlassIssuance(idb.db, writer, BREAK_GLASS_MAX_DURATION_SECONDS), clock: systemClock, tenantId: TENANT });
    const activation = racing.activate({ body, correlationId: newId("cor") });
    // Inside the activation transaction, after the identity share lock, before the session insert.
    await until(() => barrier.arrived);
    let revokedAt: number | null = null;
    const revocation = recovery.revoke(revokeInput(adminA, x.identityId)).then((v) => {
      revokedAt = Date.now();
      return v;
    });
    await new Promise((r) => setTimeout(r, 750));
    // The revocation is blocked on the row lock while the activation transaction is open.
    expect(revokedAt).toBeNull();
    const releasedAt = Date.now();
    barrier.open();
    const issued = await activation;
    expect((await revocation).status).toBe("REVOKED");
    expect(revokedAt).not.toBeNull();
    expect(revokedAt as unknown as number).toBeGreaterThanOrEqual(releasedAt);
    const row = await idb.db.query<{ revoke_reason: string | null }>("select revoke_reason from console_sessions where session_hash = $1", [consoleSessionHash(issued.token)]);
    expect(row.rows[0]?.revoke_reason).toBe("RECOVERY_IDENTITY_REVOKED");
    expect(await reasonOf(sso.authenticate(`Bearer ${issued.token}`))).toBe("SESSION_REVOKED");
  });

  it("[FO-14-52][FO-14-51][AUTH-04] two terminal paths of ONE session family racing on two PostgreSQL connections decide once: both reach the decision while a third connection holds the family's rows; the row lock of closeFamily serializes them, the first closes the family and decides, the second finds it closed (one revocation, one audit event, the custodian state the first one's answer gives)", async () => {
    const [adminA, adminB, holder] = [staff(), staff(), staff()];
    const x = await activeIdentity(recovery, holder, adminA, adminB, "att_synthRecoveryL2LockRace1");
    const familyHash = await ssoSignInBeforeOutage(holder);
    const live = await sessions.load(TENANT, familyHash);
    if (!live) throw new Error("SESSION_ROW_MISSING");
    // A third connection holds the family's rows, so both closures reach their decision before either can proceed.
    let releaseHolder!: () => void;
    const holderGate = new Promise<void>((r) => (releaseHolder = r));
    let holding!: () => void;
    const holdingP = new Promise<void>((r) => (holding = r));
    const holderTx = idb.db.tx(
      async (tx) => {
        await tx.query("select 1 from console_sessions where family_id = $1 for update", [live.familyId]);
        holding();
        await holderGate;
      },
      { role: "app_console", rls: { tenantId: TENANT, actorId: null } },
    );
    await holdingP;
    const close = (answer: CustodianAnswer, reasonCode: string) =>
      sessions.closeFamily(writer, {
        tenantId: TENANT,
        familyId: live.familyId,
        sessionHash: live.sessionHash,
        staffId: holder,
        reasonCode,
        now: systemClock.now(),
        answer,
        sessionAudit: audit(holder, "console.auth.session_revoked", reasonCode),
        custodian: (c) => (c.suspended.length > 0 ? [audit(holder, "console.recovery_identity.suspended", c.reason ?? "CUSTODIAN_OFFBOARDED")] : []),
      });
    // A logout whose IdP answer was active and a replay closure whose answer was an inactive token, at once.
    const logout = close({ kind: "ACTIVE", roles: ["supervisor"] }, "STAFF_LOGOUT");
    const replay = close({ kind: "TOKEN_INACTIVE" }, "SESSION_TOKEN_REPLAYED");
    // Both transactions now wait on a row lock in this database (two distinct backends).
    const waiting = async () => (await idb.db.query<{ n: number }>("select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'")).rows[0]?.n ?? 0;
    for (const end = Date.now() + 10_000; (await waiting()) < 2; ) {
      if (Date.now() > end) throw new Error("RACE_NEVER_REACHED");
      await new Promise((r) => setTimeout(r, 20));
    }
    releaseHolder();
    await holderTx;
    const [l, r] = await Promise.all([logout, replay]);
    // Exactly one of them closed the family; the other found it closed and decided nothing more.
    expect([l.outcome, r.outcome].sort()).toEqual(["ALREADY_CLOSED", "CLOSED"]);
    const winner = l.outcome === "CLOSED" ? "STAFF_LOGOUT" : "SESSION_TOKEN_REPLAYED";
    const row = await idb.db.query<{ revoke_reason: string | null }>("select revoke_reason from console_sessions where session_hash = $1", [familyHash]);
    expect(row.rows[0]?.revoke_reason).toBe(winner);
    const events = await idb.db.query<{ n: number }>("select count(*)::int as n from audit_outbox where action = 'console.auth.session_revoked' and event->>'actorRef' = $1", [holder]);
    expect(events.rows[0]?.n).toBe(1);
    const identity = await idb.db.query<{ status: string; suspend_reason: string | null }>("select status, suspend_reason from console_recovery_identities where identity_id = $1", [x.identityId]);
    expect(identity.rows[0]).toEqual(winner === "STAFF_LOGOUT" ? { status: "ACTIVE", suspend_reason: null } : { status: "SUSPENDED", suspend_reason: "CUSTODIAN_OFFBOARDED" });
  });
});
