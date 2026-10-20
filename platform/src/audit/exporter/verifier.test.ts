/**
 * Separate audit verifier (FO-15-40, FO-15-41, FO-15-38) over real PostgreSQL SQL (PGlite, every
 * migration), the real PgAuditWriter, AuditExporter (shipper + signer), the production LedgerActionService
 * (committed actions and their receipts) and the LOCAL FIXTURE filesystem sink, manifest key and provider.
 * The verifier connects through its OWN login (createTestLogin: a login granted app_audit_verifier only);
 * PGlite has no authentication, so the fixture runs each transaction under SET LOCAL SESSION AUTHORIZATION.
 * Layer 2 runs the same verifier against MinIO Object Lock and LocalStack KMS with a real verifier login
 * (test/integration/substrate/audit-export.test.ts, audit-reconciliation.test.ts) and through the
 * verify-audit CLI.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LedgerActionService } from "../../actions/action-service.js";
import { FakeProviderFixture } from "../../actions/fixtures/fake-provider.fixture.js";
import { allowDecision, confirmationFor, rescheduleInput, syntheticAuthContext, telephonyIntegration } from "../../actions/fixtures/world.fixture.js";
import type { PgliteDb } from "../../db/pglite.js";
import { createTestDb, createTestLogin } from "../../db/testing.js";
import type { TestLogin } from "../../db/testing.js";
import type { Db } from "../../db/types.js";
import { APPOINTMENTS } from "../../fixtures/synthetic-world.js";
import { PgOutbox } from "../../outbox/outbox.js";
import { InMemoryMetrics, createMetricCatalogue } from "../../observability/metrics.js";
import { withSubstrateMetrics } from "../../observability/catalog/substrate.js";
import type { AuditManifest } from "../../protocol/index.js";
import { canonicalJson } from "../../shared/canonical.js";
import { FakeClock, iso } from "../../shared/clock.js";
import { newId } from "../../shared/ids.js";
import { PgAuditHealth } from "../health.js";
import { DurableDeferredAuditQueue } from "../journal.js";
import { PgRouteAuditIntents, ROUTE_NOT_RECORDED_ACTION, RouteAuditReconciler } from "../route-reconciler.js";
import { MANIFEST_SUFFIX } from "../sinks/common.js";
import { LocalFsAuditSinkFixture } from "../sinks/local-fs.js";
import { OTHER_TENANT_ID, TENANT_ID, appendMany, sampleAuditInput } from "../testing.js";
import { AuditShipper } from "../shipper.js";
import { IntegrityVerifier } from "../verifier.js";
import { PgAuditWriter } from "../writer.js";
import { AuditExporter } from "./exporter.js";
import { LocalManifestSignerFixture, ManifestSignatureVerifier } from "./signer.js";
import { AuditExportVerifier } from "./verifier.js";

const STREAM = "actions.synth-export";
let db: PgliteDb;
let clock: FakeClock;
let dir: string;
let sink: LocalFsAuditSinkFixture;
let signer: LocalManifestSignerFixture;
let verifierLogin: TestLogin;
let opened: Db[] = [];

/** Opens a handle as `login` (by default the verifier's own login, granted app_audit_verifier only). */
async function as(login: TestLogin = verifierLogin): Promise<Db> {
  const h = await login.open();
  opened.push(h);
  return h;
}

/** Creating and migrating an embedded PostgreSQL can take long on a contended shared machine. */
const PGLITE_SETUP_TIMEOUT_MS = 120_000;

beforeEach(async () => {
  db = await createTestDb();
  clock = new FakeClock("2026-10-19T10:00:00.000Z");
  dir = mkdtempSync(join(tmpdir(), "vsp-audit-export-"));
  sink = new LocalFsAuditSinkFixture(dir);
  signer = new LocalManifestSignerFixture(clock);
  verifierLogin = await createTestLogin(db, ["app_audit_verifier"]);
}, PGLITE_SETUP_TIMEOUT_MS);
afterEach(async () => {
  for (const h of opened) await h.close();
  opened = [];
  await verifierLogin.drop();
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

const window = () => ({ from: "2026-10-19T00:00:00.000Z", to: iso(new Date(clock.now().getTime() + 3_600_000)) });
const trusted = () => new ManifestSignatureVerifier().trust(signer.keyRef, signer.publicKey);

/** Commits `n` actions through the production LedgerActionService (real PgAuditWriter); returns their ledger rows. */
async function committedActions(n: number): Promise<{ actionId: string; receiptId: string; auditEventId: string }[]> {
  const stream = "actions.synth-reconcile";
  const provider = new FakeProviderFixture();
  const service = new LedgerActionService({
    db,
    clock,
    audit: new PgAuditWriter({ db, clock, stream }),
    auditHealth: new PgAuditHealth({ db, clock, policy: { maxBacklog: 100_000, maxBacklogAgeSeconds: 86_400 * 30 }, probeId: "probe.synth-reconcile" }),
    outbox: new PgOutbox({ clock }),
    config: { auditStream: stream },
  });
  const out: { actionId: string; receiptId: string; auditEventId: string }[] = [];
  for (let i = 0; i < n; i++) {
    const recordRef = APPOINTMENTS[i]?.appointmentId ?? "";
    provider.seedRecord("scheduling", recordRef, 1);
    const ctx = syntheticAuthContext(clock);
    const input = rescheduleInput({ target: { system: "scheduling", recordType: "appointment", recordRef, beforeVersion: "v1" } });
    const prepared = await service.prepare(ctx, input, allowDecision(clock));
    const confirmed = await service.confirm(confirmationFor(prepared, ctx.sessionRef, clock), telephonyIntegration());
    const receipt = await service.commit(ctx, { actionId: confirmed.actionId, digest: confirmed.digest }, { reauthorize: async () => allowDecision(clock), provider });
    expect(receipt.outcome).toBe("COMMITTED");
    out.push({ actionId: confirmed.actionId, receiptId: receipt.receiptId, auditEventId: receipt.auditEventId });
  }
  return out;
}

/** An insider (superuser, triggers bypassed) rewrites which audit event a committed action's receipt names. */
async function repointReceipt(actionId: string, auditEventId: string): Promise<void> {
  await db.tx(
    async (tx) => {
      await tx.query("set local session_replication_role = replica");
      const r = await tx.query("update action_ledger set receipt = jsonb_set(receipt, '{auditEventId}', to_jsonb($2::text)) where action_id = $1", [actionId, auditEventId]);
      expect(r.rowCount).toBe(1);
    },
    { role: "owner" },
  );
}

/** The ledger's provider idempotency key of a committed action (read as the owner). */
async function idempotencyKeyOf(actionId: string): Promise<string> {
  const r = await db.tx((tx) => tx.query<{ k: string }>("select provider_idempotency_key as k from action_ledger where action_id = $1", [actionId]), { role: "owner" });
  const k = r.rows[0]?.k;
  if (!k) throw new Error("no ledger row");
  return k;
}

const noSinkRun = async () => new AuditExportVerifier({ db: await as(), sink: null, signatures: null, clock }).run(window());
const sinkRun = async () => new AuditExportVerifier({ db: await as(), sink, signatures: trusted(), clock }).run(window());
const sourceOf = (r: { reconciliation: { source: string }[] }, s: string) => r.reconciliation.find((x) => x.source === s);

/** A route deferral recorded during an audit outage and flushed after it (DurableDeferredAuditQueue); returns its correlation id. */
async function recordedRouteDeferral(): Promise<{ correlationId: string; queue: DurableDeferredAuditQueue }> {
  const queue = new DurableDeferredAuditQueue({ db, writer: new PgAuditWriter({ db, clock, stream: "runtime" }), clock, tenants: [TENANT_ID] });
  const correlationId = newId("hnd");
  await db.exec("revoke insert on audit_outbox from app_runtime");
  await queue.appendOrDefer(sampleAuditInput(clock, { action: "handoff.requested", correlationId, sourceComponent: "gateway", outcome: "PENDING" }));
  await db.exec("grant insert on audit_outbox to app_runtime");
  return { correlationId, queue };
}

/** An insider (superuser, triggers bypassed) rewrites which audit event the RECORDED deferral names. */
async function repointDeferral(eventId: string): Promise<void> {
  await db.tx(
    async (tx) => {
      await tx.query("set local session_replication_role = replica");
      const r = await tx.query("update audit_deferred set recorded_event_id = $1 where status = 'RECORDED'", [eventId]);
      expect(r.rowCount).toBe(1);
    },
    { role: "owner" },
  );
}

/** A support request synchronised to the CRM as SupportRequestService records it (with its support_request.synced event when `audited`). */
async function syncedSupportRequest(audited: boolean): Promise<string> {
  const srId = newId("sr");
  const callId = newId("call");
  const intId = newId("int");
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const pick = () => Array.from(randomBytes(4), (b) => alphabet.charAt(b % alphabet.length)).join("");
  const ref = `SR-${pick()}-${pick()}`;
  await db.tx(
    async (tx) => {
      await tx.query("insert into support_interactions (interaction_external_id, tenant_id, call_id, language, consent_status, started_at, created_at) values ($1, $2, $3, 'en', 'GRANTED', now(), now())", [intId, TENANT_ID, callId]);
      await tx.query(
        `insert into support_requests (support_request_id, tenant_id, reference_number, interaction_external_id, issue_external_id, call_id, issue_category, disposition,
           owner_queue, priority, summary, summary_template_id, summary_provenance, attempted, commit_receipt_ids, source_call_ids, language, consent, versions,
           restricted, sync_state, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, 'general_question', 'REQUEST_ACCEPTED', 'q_general', 'P3_STANDARD', 'Synthetic support request', 'summary.general_question',
           'template_assembled', '[]', '[]', $7::jsonb, 'en', '{}', '{}', false, 'PENDING', now(), now())`,
        [srId, TENANT_ID, ref, intId, newId("iss"), callId, JSON.stringify([callId])],
      );
    },
    { role: "app_runtime", rls: { tenantId: TENANT_ID } },
  );
  const writer = new PgAuditWriter({ db, clock, stream: "worker.synth-crm-sync", standaloneRole: "app_worker" });
  await db.tx(
    async (tx) => {
      await tx.query("update support_requests set sync_state = 'SYNCING', sync_claim_token = $2, last_sync_attempt_at = now(), sync_attempts = 1, row_version = row_version + 1, updated_at = now() where support_request_id = $1", [srId, newId("scl")]);
      await tx.query("update support_requests set sync_state = 'SYNCED', salesforce_case_id = $2, synced_at = $3::timestamptz, sync_claim_token = null, row_version = row_version + 1, updated_at = now() where support_request_id = $1", [srId, `500${"A".repeat(12)}`, iso(clock.now())]);
      if (audited) await writer.append(tx, sampleAuditInput(clock, { correlationId: srId, sourceComponent: "worker", action: "support_request.synced", outcome: "SUCCEEDED", evidencePointers: [`db://support_requests/${srId}`], dataClass: "BUSINESS_RECORD", idempotencyKey: null }), "worker.synth-crm-sync");
    },
    { role: "app_worker", rls: { tenantId: TENANT_ID } },
  );
  return srId;
}

/**
 * An insider with write access to the (LOCAL FIXTURE) sink directory replaces a stored manifest in place,
 * bypassing the fixture's write-once put (on S3 Object Lock this is a new object version: Layer 2,
 * test/integration/substrate/audit-signatures.test.ts).
 */
function overwriteStoredManifest(m: AuditManifest): void {
  writeFileSync(join(dir, `${m.objectKey}${MANIFEST_SUFFIX}`), canonicalJson(m), "utf8");
}

async function exportAll(): Promise<void> {
  const r = await new AuditExporter({ db, sink, signer, clock }).runOnce();
  expect(r.failedStreams).toBe(0);
}

async function exported(n: number) {
  const writer = new PgAuditWriter({ db, clock, stream: STREAM });
  await appendMany(n, (i) => writer.appendStandalone(i), clock);
  const r = await new AuditExporter({ db, sink, signer, clock, batchSize: 2 }).runOnce();
  expect(r.failedStreams).toBe(0);
}

describe("AuditExportVerifier (separate read-only identity)", () => {
  it("[FO-15-40][FO-15-42][OPS-01] runs on its own login as app_audit_verifier, which can read the evidence and write nothing (not even verified_at)", async () => {
    await exported(3);
    const vdb = await as();
    const v = new AuditExportVerifier({ db: vdb, sink, signatures: trusted(), clock });
    expect(await v.checkIdentity()).toMatchObject({ readOnly: true, reasonCodes: [] });
    const who = await vdb.tx((tx) => tx.query<{ s: string; c: string }>("select session_user::text as s, current_user::text as c"), { role: "app_audit_verifier" });
    expect(who.rows[0]).toEqual({ s: verifierLogin.login, c: "app_audit_verifier" });
    const reason = (p: Promise<unknown>) => p.then(() => "RESOLVED", (e: Error) => e.message);
    expect(await reason(vdb.tx((tx) => tx.query("update audit_manifests set verified_at = now()"), { role: "app_audit_verifier" }))).toContain("permission denied");
    expect(await reason(vdb.tx((tx) => tx.query("delete from audit_outbox"), { role: "app_audit_verifier" }))).toContain("permission denied");
    expect(await reason(vdb.tx((tx) => tx.query("insert into audit_chain_heads (source_stream, last_sequence, updated_at) values ('x.verifier-probe', 0, now())"), { role: "app_audit_verifier" }))).toContain("permission denied");
    // The login cannot take a writer role either: SET ROLE needs membership.
    expect(await reason(vdb.tx((tx) => tx.query("select 1"), { role: "app_worker" }))).toContain("permission denied");
    const rows = await vdb.tx((tx) => tx.query<{ n: number }>("select count(*)::int as n from audit_outbox"), { role: "app_audit_verifier" });
    expect(rows.rows[0]?.n).toBe(3);
  }, PGLITE_SETUP_TIMEOUT_MS);

  it("[FO-15-40][FO-15-42][OPS-01] adversarial: the identity is judged by its LOGIN, not by the role it switched to — a writer-role member, a login with a direct write grant, a creator and the superuser session give no verdict", async () => {
    await exported(2);
    const verdictOf = async (handle: Db) => new AuditExportVerifier({ db: handle, sink, signatures: trusted(), clock }).run(window());
    // The application's login pattern: member of app_worker (and of the verifier role, so SET ROLE succeeds).
    const appLike = await createTestLogin(db, ["app_audit_verifier", "app_worker"]);
    try {
      const r = await verdictOf(await as(appLike));
      expect(r).toMatchObject({ verdict: "FAIL", reasonCodes: ["VERIFIER_IDENTITY_NOT_READ_ONLY"], identity: { readOnly: false } });
      expect(r.identity.findings).toEqual(expect.arrayContaining(["VERIFIER_LOGIN_WRITER_MEMBER", "VERIFIER_IDENTITY_CAN_WRITE"]));
      expect(r.streams).toBe(0); // nothing was examined
    } finally {
      await appLike.drop();
    }
    // A dedicated login that was given one direct write grant.
    const granted = await createTestLogin(db, ["app_audit_verifier"]);
    try {
      await db.exec(`grant update (verified_at) on audit_manifests to ${granted.login}`);
      const r = await verdictOf(await as(granted));
      expect(r.identity.findings).toEqual(["VERIFIER_IDENTITY_CAN_WRITE"]);
      expect(r.verdict).toBe("FAIL");
      await db.exec(`revoke update (verified_at) on audit_manifests from ${granted.login}`);
      expect((await verdictOf(await as(granted))).verdict).toBe("PASS");
      // A VOLATILE SECURITY DEFINER function the login may execute is a write path under its owner's rights.
      await db.exec("grant execute on function audit_purge_verified(text, bigint, timestamptz) to " + granted.login);
      expect((await verdictOf(await as(granted))).identity.findings).toEqual(["VERIFIER_IDENTITY_DEFINER_WRITE_PATH"]);
      await db.exec("revoke execute on function audit_purge_verified(text, bigint, timestamptz) from " + granted.login);
      // CREATE on an application schema.
      await db.exec(`grant create on schema public to ${granted.login}`);
      expect((await verdictOf(await as(granted))).identity.findings).toEqual(["VERIFIER_IDENTITY_CAN_CREATE"]);
      await db.exec(`revoke create on schema public from ${granted.login}`);
    } finally {
      await granted.drop();
    }
    // The administrative session (superuser, owner of every object) is never a verifier identity.
    const admin = await verdictOf(db);
    expect(admin.verdict).toBe("FAIL");
    expect(admin.identity.findings).toEqual(expect.arrayContaining(["VERIFIER_LOGIN_PRIVILEGED", "VERIFIER_LOGIN_OWNS_OBJECTS"]));
    // A login that was never granted the verifier role cannot run at all.
    const stranger = await createTestLogin(db, []);
    try {
      await expect(verdictOf(await as(stranger))).rejects.toMatchObject({ reasonCode: "AUDIT_STORE_UNAVAILABLE" });
    } finally {
      await stranger.drop();
    }
  }, PGLITE_SETUP_TIMEOUT_MS);

  it("[FO-15-40][OPS-03] without a sink reader the verdict is INCONCLUSIVE, never PASS", async () => {
    await exported(2);
    const r = await new AuditExportVerifier({ db: await as(), sink: null, signatures: trusted(), clock }).run(window());
    expect(r.verdict).toBe("INCONCLUSIVE");
    expect(r.reasonCodes).toContain("SINK_READER_NOT_CONFIGURED");
    const noKeys = await new AuditExportVerifier({ db: await as(), sink, signatures: null, clock }).run(window());
    expect(noKeys).toMatchObject({ verdict: "INCONCLUSIVE", reasonCodes: expect.arrayContaining(["SIGNATURES_NOT_VERIFIED"]) });
  }, PGLITE_SETUP_TIMEOUT_MS);

  it("[FO-15-40][FO-15-41][FO-19-82][OPS-03] without a sink reader an intact database with exported committed actions and recorded route evidence is INCONCLUSIVE — never PASS, never a false FAIL: shipped evidence is unverified, evidence not yet due is observed", async () => {
    await committedActions(2);
    const { queue } = await recordedRouteDeferral();
    await queue.flush();
    await exportAll();
    clock.advanceSeconds(10);
    expect((await sinkRun()).verdict, "the same database is PASS with the sink reader").toBe("PASS");
    const r = await noSinkRun();
    expect(r.verdict).toBe("INCONCLUSIVE");
    expect(r.reasonCodes).toEqual(["SINK_READER_NOT_CONFIGURED", "RECONCILIATION_NOT_VERIFIED_WITHOUT_SINK"]);
    expect(r).toMatchObject({ integrityFindings: 0, ingestionGaps: 0, exportedEventsChecked: 0, discrepancies: [] });
    expect(sourceOf(r, "committed_action")).toEqual({ source: "committed_action", expected: 2, observed: 0, unverified: 2, discrepancies: 0 });
    expect(sourceOf(r, "provider_receipt")).toEqual({ source: "provider_receipt", expected: 2, observed: 0, unverified: 2, discrepancies: 0 });
    expect(sourceOf(r, "route_evidence")).toEqual({ source: "route_evidence", expected: 1, observed: 0, unverified: 1, discrepancies: 0 });
    // An action committed within the export grace is not yet due in the sink: its local evidence counts as observed.
    await committedActions(1);
    const fresh = await noSinkRun();
    expect(fresh.verdict).toBe("INCONCLUSIVE");
    expect(sourceOf(fresh, "committed_action")).toEqual({ source: "committed_action", expected: 3, observed: 1, unverified: 2, discrepancies: 0 });
  }, PGLITE_SETUP_TIMEOUT_MS);

  it("[FO-15-40][FO-15-41][OPS-01] without a sink reader, what the verifier can see locally still FAILs: a receipt naming another action's commit event, a commit event never written (nothing was purged), evidence unshipped past the export grace", async () => {
    const [a, b] = await committedActions(2);
    if (!a || !b) throw new Error("two actions expected");
    await exportAll();
    expect((await noSinkRun()).verdict).toBe("INCONCLUSIVE");
    // 1. The receipt names another action's (shipped) commit event: the local copy contradicts the ledger.
    await repointReceipt(a.actionId, b.auditEventId);
    let r = await noSinkRun();
    expect(r.verdict).toBe("FAIL");
    expect(r.reasonCodes).toContain("RECONCILIATION_DISCREPANCIES");
    expect(sourceOf(r, "committed_action")).toEqual({ source: "committed_action", expected: 2, observed: 0, unverified: 1, discrepancies: 1 });
    expect(r.discrepancies.filter((d) => d.source === "committed_action").map((d) => d.key)).toEqual([a.actionId]);
    // 2. The receipt names an event that was never written; no stream was ever purged, so it cannot be in the sink only.
    await repointReceipt(a.actionId, newId("aud"));
    r = await noSinkRun();
    expect(r.verdict).toBe("FAIL");
    expect(r.discrepancies.filter((d) => d.source === "committed_action").map((d) => d.key)).toEqual([a.actionId]);
    expect(r.discrepancies.filter((d) => d.source === "provider_receipt").map((d) => d.key)).toEqual([a.receiptId]);
    await repointReceipt(a.actionId, a.auditEventId);
    expect((await noSinkRun()).verdict).toBe("INCONCLUSIVE");
    // 3. Evidence known NOT to be exported: an action committed and left unshipped past the export grace.
    const [c] = await committedActions(1);
    clock.advanceSeconds(301);
    r = await noSinkRun();
    expect(r.verdict).toBe("FAIL");
    expect(r.reasonCodes).toEqual(expect.arrayContaining(["INGESTION_GAPS", "RECONCILIATION_DISCREPANCIES", "SINK_READER_NOT_CONFIGURED"]));
    expect(r.discrepancies.filter((d) => d.source === "committed_action").map((d) => d.key)).toEqual([c?.actionId]);
  }, PGLITE_SETUP_TIMEOUT_MS);

  it("[FO-15-40][OPS-03] evidence purged from the local outbox after a verified export: the sink reader proves it (PASS); without it the run is INCONCLUSIVE, and a commit event that never existed cannot be told from a purged one (never PASS)", async () => {
    const [a] = await committedActions(1);
    if (!a) throw new Error("one action expected");
    const shipper = new AuditShipper({ db, sink, clock, signer, role: "app_worker" });
    expect((await shipper.runOnce()).failedStreams).toBe(0);
    expect((await new IntegrityVerifier({ db, sink, clock }).verifyShipped("actions.synth-reconcile", { markVerified: true })).ok).toBe(true);
    expect((await shipper.purgeVerified("actions.synth-reconcile")).deleted).toBeGreaterThan(0);
    const present = await db.tx((tx) => tx.query("select 1 from audit_outbox where event_id = $1", [a.auditEventId]), { role: "owner" });
    expect(present.rows, "the commit event exists only in the sink now").toEqual([]);
    clock.advanceSeconds(10);
    const withSink = await sinkRun();
    expect(withSink.verdict, JSON.stringify(withSink.reasonCodes)).toBe("PASS");
    expect(sourceOf(withSink, "committed_action")).toEqual({ source: "committed_action", expected: 1, observed: 1, unverified: 0, discrepancies: 0 });
    const r = await noSinkRun();
    expect(r).toMatchObject({ verdict: "INCONCLUSIVE", reasonCodes: ["SINK_READER_NOT_CONFIGURED", "RECONCILIATION_NOT_VERIFIED_WITHOUT_SINK"] });
    expect(sourceOf(r, "committed_action")).toEqual({ source: "committed_action", expected: 1, observed: 0, unverified: 1, discrepancies: 0 });
    await repointReceipt(a.actionId, newId("aud"));
    expect((await noSinkRun()).verdict).toBe("INCONCLUSIVE");
    expect((await sinkRun()).verdict, "the sink reader turns it into a finding").toBe("FAIL");
  }, PGLITE_SETUP_TIMEOUT_MS);

  it("[FO-01-13][FO-15-38][FO-22-08] an intact, signed, exported chain with nothing outstanding is PASS", async () => {
    await exported(5);
    const metrics = new InMemoryMetrics({ catalogue: withSubstrateMetrics(createMetricCatalogue()) });
    const r = await new AuditExportVerifier({ db: await as(), sink, signatures: trusted(), clock, metrics }).run(window());
    expect(r).toMatchObject({ verdict: "PASS", reasonCodes: [], integrityFindings: 0, ingestionGaps: 0, localEventsChecked: 5, exportedEventsChecked: 5 });
    expect(r.signatures).toEqual({ manifests: 3, valid: 3, unsigned: 0, invalid: 0, untrustedKey: 0, partial: 0 });
    expect(metrics.counterValue("vsp_audit_verifier_runs_total", { verdict: "pass" })).toBe(1);
  }, PGLITE_SETUP_TIMEOUT_MS);

  it("[FO-15-38][OPS-01] manifests signed by an untrusted key fail the run", async () => {
    await exported(2);
    const other = new LocalManifestSignerFixture(clock);
    const r = await new AuditExportVerifier({ db: await as(), sink, signatures: new ManifestSignatureVerifier().trust(other.keyRef, other.publicKey), clock }).run(window());
    expect(r.verdict).toBe("FAIL");
    expect(r.signatures?.untrustedKey).toBe(1);
    expect(r.findings.map((f) => f.code)).toContain("MANIFEST_SIGNATURE_INVALID");
  }, PGLITE_SETUP_TIMEOUT_MS);

  it("[FO-15-38][OPS-01] adversarial: a manifest in the sink WITHOUT its signature, signedAt and signerRole (rewritten by an insider) fails the run with MANIFEST_UNSIGNED", async () => {
    await exported(4);
    const [first, second] = await sink.listManifests(STREAM);
    if (!first || !second) throw new Error("expected two manifests");
    const { signature: _sig, signedAt: _at, signerRole: _role, ...stripped } = first;
    overwriteStoredManifest(stripped);
    const metrics = new InMemoryMetrics({ catalogue: withSubstrateMetrics(createMetricCatalogue()) });
    const r = await new AuditExportVerifier({ db: await as(), sink, signatures: trusted(), clock, metrics }).run(window());
    expect(r.signatures).toEqual({ manifests: 2, valid: 1, unsigned: 1, invalid: 0, untrustedKey: 0, partial: 0 });
    expect(r.verdict).toBe("FAIL");
    expect(r.reasonCodes).toContain("MANIFEST_SIGNATURE_FINDINGS");
    // The signature check is the only thing that sees it: the chain, digests and content are intact.
    expect(r.findings).toEqual([{ code: "MANIFEST_UNSIGNED", sourceStream: STREAM, sequence: first.firstSequence, manifestId: first.manifestId }]);
    expect(metrics.counterValue("vsp_audit_manifest_signatures_total", { result: "unsigned" })).toBe(1);
    expect(metrics.counterValue("vsp_audit_manifest_signatures_total", { result: "verified" })).toBe(1);
    expect(second.signature?.keyRef).toBe(signer.keyRef);
  }, PGLITE_SETUP_TIMEOUT_MS);

  it("[FO-15-38][OPS-01] adversarial: a manifest carrying ANOTHER manifest's signature under the trusted keyRef fails the run with MANIFEST_SIGNATURE_INVALID", async () => {
    await exported(4);
    const [first, second] = await sink.listManifests(STREAM);
    if (!first?.signature || !second?.signature) throw new Error("expected two signed manifests");
    expect(second.signature.keyRef).toBe(signer.keyRef);
    overwriteStoredManifest({ ...first, signature: second.signature, signedAt: second.signedAt });
    const metrics = new InMemoryMetrics({ catalogue: withSubstrateMetrics(createMetricCatalogue()) });
    const r = await new AuditExportVerifier({ db: await as(), sink, signatures: trusted(), clock, metrics }).run(window());
    expect(r.signatures).toEqual({ manifests: 2, valid: 1, unsigned: 0, invalid: 1, untrustedKey: 0, partial: 0 });
    expect(r.verdict).toBe("FAIL");
    expect(r.reasonCodes).toContain("MANIFEST_SIGNATURE_FINDINGS");
    expect(r.findings).toEqual([{ code: "MANIFEST_SIGNATURE_INVALID", sourceStream: STREAM, sequence: first.firstSequence, manifestId: first.manifestId }]);
    expect(metrics.counterValue("vsp_audit_manifest_signatures_total", { result: "invalid" })).toBe(1);
  }, PGLITE_SETUP_TIMEOUT_MS);

  it("[FO-19-82][OPS-01] a deleted local event (trigger disabled by a superuser) is a FAIL with the gap located", async () => {
    await exported(4);
    await db.exec("alter table audit_outbox disable trigger audit_outbox_before_delete");
    await db.exec(`delete from audit_outbox where source_stream = '${STREAM}' and sequence = 2`);
    const r = await new AuditExportVerifier({ db: await as(), sink, signatures: trusted(), clock }).run(window());
    expect(r.verdict).toBe("FAIL");
    expect(r.findings.some((f) => f.sourceStream === STREAM && (f.code === "SEQUENCE_GAP" || f.code === "PREV_HASH_MISMATCH"))).toBe(true);
    expect(r.ingestionGaps).toBeGreaterThan(0);
  }, PGLITE_SETUP_TIMEOUT_MS);

  it("[FO-15-41][FO-15-48][OPS-03] a route deferral pending past the export grace is a reconciliation discrepancy (a gap is surfaced, not hidden)", async () => {
    const { correlationId, queue } = await recordedRouteDeferral();
    clock.advanceSeconds(301);
    const r = await sinkRun();
    expect(r.verdict).toBe("FAIL");
    expect(r.reconciliation.find((s) => s.source === "route_evidence")).toMatchObject({ expected: 1, observed: 0, discrepancies: 1 });
    expect(r.discrepancies[0]).toMatchObject({ source: "route_evidence", code: "MISSING_AUDIT_EVIDENCE" });
    // Without the sink reader the same pending deferral is visible locally: still a FAIL, never INCONCLUSIVE.
    expect((await noSinkRun()).verdict).toBe("FAIL");
    // Once flushed and exported, the same run is clean.
    await queue.flush();
    await new AuditExporter({ db, sink, signer, clock }).runOnce();
    const clean = await sinkRun();
    expect(clean.verdict).toBe("PASS");
    expect(clean.reconciliation.find((s) => s.source === "route_evidence")).toMatchObject({ expected: 1, observed: 1, discrepancies: 0 });
    // Adversarial: the deferral is rewritten (triggers bypassed) to name an event that is not exported.
    await repointDeferral(newId("aud"));
    const forged = await sinkRun();
    expect(forged.verdict).toBe("FAIL");
    expect(forged.discrepancies).toEqual([expect.objectContaining({ source: "route_evidence", code: "MISSING_AUDIT_EVIDENCE" })]);
    expect(correlationId).toMatch(/^hnd_/);
  }, PGLITE_SETUP_TIMEOUT_MS);

  it("[FO-15-41][FO-15-45][OPS-01] adversarial: a RECORDED route deferral that names an EXPORTED event of another correlation, another action or another tenant is not route evidence (guard bypassed as a superuser)", async () => {
    const { correlationId, queue } = await recordedRouteDeferral();
    await queue.flush();
    // Real, chained, exported events that differ from the deferral in exactly one key each.
    const w = new PgAuditWriter({ db, clock, stream: "gateway.synth-route-decoys" });
    const decoys = {
      otherCorrelation: await w.appendStandalone(sampleAuditInput(clock, { action: "handoff.requested", correlationId: newId("hnd"), sourceComponent: "gateway", outcome: "PENDING" })),
      otherAction: await w.appendStandalone(sampleAuditInput(clock, { action: "tool.invoke", correlationId, sourceComponent: "gateway", outcome: "SUCCEEDED" })),
      otherTenant: await w.appendStandalone(sampleAuditInput(clock, { tenantId: OTHER_TENANT_ID, action: "handoff.requested", correlationId, sourceComponent: "gateway", outcome: "PENDING" })),
    };
    await exportAll();
    clock.advanceSeconds(10);
    const recorded = await db.tx((tx) => tx.query<{ id: string }>("select recorded_event_id as id from audit_deferred where status = 'RECORDED'"), { role: "owner" });
    const original = recorded.rows[0]?.id ?? "";
    expect((await sinkRun()).verdict).toBe("PASS");
    for (const [name, decoy] of Object.entries(decoys)) {
      await repointDeferral(decoy.eventId);
      const r = await sinkRun();
      expect(r.integrityFindings, name).toBe(0);
      expect(r.verdict, name).toBe("FAIL");
      expect(sourceOf(r, "route_evidence"), name).toEqual({ source: "route_evidence", expected: 1, observed: 0, unverified: 0, discrepancies: 1 });
      // The local copy contradicts the deferral as well: no sink reader is needed to see it.
      expect((await noSinkRun()).verdict, name).toBe("FAIL");
    }
    await repointDeferral(original);
    expect((await sinkRun()).verdict).toBe("PASS");
  }, PGLITE_SETUP_TIMEOUT_MS);

  it("[FO-15-41][FO-15-48][FO-01-34][OPS-01] a not_recorded marker is route evidence only when its exported event is that tenant's audit.route.not_recorded marker; a marker re-pointed at another action's or another tenant's event fails the run", async () => {
    const intents = new PgRouteAuditIntents({ db, clock });
    const worker = "worker.synth-reconciler";
    const reconciler = new RouteAuditReconciler({ db, writer: new PgAuditWriter({ db, clock, stream: worker, standaloneRole: "app_worker" }), clock, tenants: [TENANT_ID], stream: worker, graceSeconds: 300 });
    await intents.open({ tenantId: TENANT_ID, routeKind: "HUMAN_TRANSFER", correlationId: newId("hnd"), callId: newId("call"), deadlineSeconds: 60 });
    clock.advanceSeconds(61);
    expect((await reconciler.runOnce()).routeIntents).toEqual({ evidenced: 0, notRecorded: 1 });
    const w = new PgAuditWriter({ db, clock, stream: "gateway.synth-marker-decoys" });
    const decoys = {
      otherAction: await w.appendStandalone(sampleAuditInput(clock, { action: "tool.invoke", sourceComponent: "gateway" })),
      otherTenant: await w.appendStandalone(sampleAuditInput(clock, { tenantId: OTHER_TENANT_ID, action: ROUTE_NOT_RECORDED_ACTION, sourceComponent: "worker", outcome: "UNKNOWN", reasonCode: "ROUTE_AUDIT_NOT_RECORDED" })),
    };
    await exportAll();
    clock.advanceSeconds(10);
    const clean = await sinkRun();
    expect(clean.verdict, JSON.stringify(clean.reasonCodes)).toBe("PASS");
    expect(sourceOf(clean, "route_evidence")).toEqual({ source: "route_evidence", expected: 1, observed: 1, unverified: 0, discrepancies: 0 });
    expect(sourceOf(await noSinkRun(), "route_evidence")).toEqual({ source: "route_evidence", expected: 1, observed: 0, unverified: 1, discrepancies: 0 });
    const marker = await db.tx((tx) => tx.query<{ id: string }>("select audit_event_id as id from route_audit_reconciliations where result = 'NOT_RECORDED'"), { role: "owner" });
    const original = marker.rows[0]?.id ?? "";
    const repoint = (eventId: string) =>
      db.tx(
        async (tx) => {
          await tx.query("set local session_replication_role = replica");
          const r = await tx.query("update route_audit_reconciliations set audit_event_id = $1 where result = 'NOT_RECORDED'", [eventId]);
          expect(r.rowCount).toBe(1);
        },
        { role: "owner" },
      );
    for (const [name, decoy] of Object.entries(decoys)) {
      await repoint(decoy.eventId);
      const r = await sinkRun();
      expect(r.verdict, name).toBe("FAIL");
      expect(sourceOf(r, "route_evidence"), name).toEqual({ source: "route_evidence", expected: 1, observed: 0, unverified: 0, discrepancies: 1 });
      expect((await noSinkRun()).verdict, `${name} (no sink reader)`).toBe("FAIL");
    }
    await repoint(original);
    expect((await sinkRun()).verdict).toBe("PASS");
  }, PGLITE_SETUP_TIMEOUT_MS);

  it("[FO-15-41][FO-15-40][OPS-01] keyed CRM-write reconciliation: a synchronised Case without its support_request.synced event fails the run with or without the sink reader; with the event it is observed (sink) or unverified (no sink)", async () => {
    const audited = await syncedSupportRequest(true);
    await exportAll();
    clock.advanceSeconds(10);
    const clean = await sinkRun();
    expect(clean.verdict, JSON.stringify(clean.reasonCodes)).toBe("PASS");
    expect(sourceOf(clean, "crm_write")).toEqual({ source: "crm_write", expected: 1, observed: 1, unverified: 0, discrepancies: 0 });
    const noSink = await noSinkRun();
    expect(noSink.verdict).toBe("INCONCLUSIVE");
    expect(sourceOf(noSink, "crm_write")).toEqual({ source: "crm_write", expected: 1, observed: 0, unverified: 1, discrepancies: 0 });
    // A Case synchronised without its event (nothing was ever purged, so the sink cannot hold it either).
    const missing = await syncedSupportRequest(false);
    for (const r of [await sinkRun(), await noSinkRun()]) {
      expect(r.verdict).toBe("FAIL");
      expect(r.discrepancies.filter((d) => d.source === "crm_write").map((d) => d.key)).toEqual([missing]);
    }
    // An event not yet due for export counts as observed even without the reader.
    const fresh = await syncedSupportRequest(true);
    const r = await noSinkRun();
    expect(sourceOf(r, "crm_write")).toEqual({ source: "crm_write", expected: 3, observed: 1, unverified: 1, discrepancies: 1 });
    expect([audited, fresh]).not.toContain(missing);
  }, PGLITE_SETUP_TIMEOUT_MS);

  it("[FO-15-41][OPS-01] keyed reconciliation of committed actions and provider receipts: every COMMITTED action has its exported commit event and receipt evidence", async () => {
    const actions = await committedActions(2);
    await exportAll();
    const r = await new AuditExportVerifier({ db: await as(), sink, signatures: trusted(), clock }).run(window());
    expect(r.reconciliation.find((x) => x.source === "committed_action")).toEqual({ source: "committed_action", expected: 2, observed: 2, unverified: 0, discrepancies: 0 });
    expect(r.reconciliation.find((x) => x.source === "provider_receipt")).toEqual({ source: "provider_receipt", expected: 2, observed: 2, unverified: 0, discrepancies: 0 });
    expect(r.verdict, JSON.stringify(r.reasonCodes)).toBe("PASS");
    expect(actions.map((a) => a.auditEventId)).toHaveLength(2);
  }, PGLITE_SETUP_TIMEOUT_MS);

  it("[FO-15-41][OPS-01] adversarial: a committed action whose commit event is absent from the export fails the run although every chain is intact (a perfect chain can omit events)", async () => {
    const [a] = await committedActions(1);
    await exportAll();
    // The receipt names an audit event that was never written (an effect committed without its evidence).
    const absent = newId("aud");
    await repointReceipt(a?.actionId ?? "", absent);
    const r = await new AuditExportVerifier({ db: await as(), sink, signatures: trusted(), clock }).run(window());
    expect(r.integrityFindings).toBe(0);
    expect(r.verdict).toBe("FAIL");
    expect(r.reconciliation.find((x) => x.source === "committed_action")).toMatchObject({ expected: 1, observed: 0, discrepancies: 1 });
    expect(r.reconciliation.find((x) => x.source === "provider_receipt")).toMatchObject({ expected: 1, observed: 0, discrepancies: 1 });
    expect(r.discrepancies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "committed_action", key: a?.actionId, code: "MISSING_AUDIT_EVIDENCE" }),
        expect.objectContaining({ source: "provider_receipt", key: a?.receiptId, code: "MISSING_AUDIT_EVIDENCE" }),
      ]),
    );
  }, PGLITE_SETUP_TIMEOUT_MS);

  it("[FO-15-41][OPS-01] adversarial: a receipt that names ANOTHER action's commit event (different idempotency key, other receipt) is not evidence for this action", async () => {
    const [a, b] = await committedActions(2);
    await exportAll();
    await repointReceipt(a?.actionId ?? "", b?.auditEventId ?? "");
    const r = await new AuditExportVerifier({ db: await as(), sink, signatures: trusted(), clock }).run(window());
    expect(r.integrityFindings).toBe(0);
    expect(r.verdict).toBe("FAIL");
    expect(r.reconciliation.find((x) => x.source === "committed_action")).toMatchObject({ expected: 2, observed: 1, discrepancies: 1 });
    expect(r.reconciliation.find((x) => x.source === "provider_receipt")).toMatchObject({ expected: 2, observed: 1, discrepancies: 1 });
    expect(r.discrepancies.filter((d) => d.source === "committed_action").map((d) => d.key)).toEqual([a?.actionId]);
    expect(r.discrepancies.filter((d) => d.source === "provider_receipt").map((d) => d.key)).toEqual([a?.receiptId]);
  }, PGLITE_SETUP_TIMEOUT_MS);

  it("[FO-15-41][OPS-01] adversarial: a commit event of ANOTHER TENANT, or of a non-commit action, that carries this action's idempotency key and references its receipt is not evidence for it", async () => {
    const [a] = await committedActions(1);
    if (!a) throw new Error("one action expected");
    const key = await idempotencyKeyOf(a.actionId);
    // Forged events appended through the real writer and exported: every chain stays intact.
    const w = new PgAuditWriter({ db, clock, stream: "actions.synth-forged" });
    const forged = {
      otherTenant: await w.appendStandalone(sampleAuditInput(clock, { tenantId: OTHER_TENANT_ID, action: "action.commit.succeeded", idempotencyKey: key, evidencePointers: [`receipt:${a.receiptId}`], receiptRefs: [a.receiptId] })),
      notACommit: await w.appendStandalone(sampleAuditInput(clock, { action: "tool.invoke", idempotencyKey: key, evidencePointers: [`receipt:${a.receiptId}`], receiptRefs: [a.receiptId] })),
    };
    await exportAll();
    expect((await sinkRun()).verdict).toBe("PASS");
    for (const [name, ev] of Object.entries(forged)) {
      await repointReceipt(a.actionId, ev.eventId);
      const r = await sinkRun();
      expect(r.integrityFindings, name).toBe(0);
      expect(r.verdict, name).toBe("FAIL");
      expect(sourceOf(r, "committed_action"), name).toEqual({ source: "committed_action", expected: 1, observed: 0, unverified: 0, discrepancies: 1 });
      expect(sourceOf(r, "provider_receipt"), name).toEqual({ source: "provider_receipt", expected: 1, observed: 0, unverified: 0, discrepancies: 1 });
      expect((await noSinkRun()).verdict, `${name} (no sink reader)`).toBe("FAIL");
    }
    await repointReceipt(a.actionId, a.auditEventId);
    expect((await sinkRun()).verdict).toBe("PASS");
  }, PGLITE_SETUP_TIMEOUT_MS);

  it("[FO-15-41][OPS-01] adversarial: a commit event that does not reference the receipt it is named by leaves the receipt unevidenced", async () => {
    const [a] = await committedActions(1);
    await exportAll();
    // The receipt id itself was rewritten after the fact: the exported commit event references the original one.
    await db.tx(
      async (tx) => {
        await tx.query("set local session_replication_role = replica");
        await tx.query("update action_ledger set receipt = jsonb_set(receipt, '{receiptId}', to_jsonb($2::text)) where action_id = $1", [a?.actionId, newId("rcp")]);
      },
      { role: "owner" },
    );
    const r = await new AuditExportVerifier({ db: await as(), sink, signatures: trusted(), clock }).run(window());
    expect(r.reconciliation.find((x) => x.source === "committed_action")).toMatchObject({ expected: 1, observed: 1, discrepancies: 0 });
    expect(r.reconciliation.find((x) => x.source === "provider_receipt")).toMatchObject({ expected: 1, observed: 0, discrepancies: 1 });
    expect(r.verdict).toBe("FAIL");
  }, PGLITE_SETUP_TIMEOUT_MS);

  it("[OPS-03] an invalid window is refused", async () => {
    await expect(new AuditExportVerifier({ db: await as(), sink, signatures: trusted(), clock }).run({ from: "2026-10-19T10:00:00.000Z", to: "2026-10-19T09:00:00.000Z" })).rejects.toThrow("AUDIT_VERIFY_WINDOW_INVALID");
  }, PGLITE_SETUP_TIMEOUT_MS);
});
