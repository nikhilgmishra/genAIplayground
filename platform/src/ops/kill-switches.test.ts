import { afterEach, describe, expect, it } from "vitest";
import type { Db } from "../db/types.js";
import type { PgliteDb } from "../db/pglite.js";
import { OTHER_TENANT_ID, PEOPLE, TENANT_ID } from "../fixtures/synthetic-world.js";
import { InMemoryMetrics } from "../observability/metrics.js";
import { FakeClock } from "../shared/clock.js";
import { AccessDeniedError, AuditUnavailableError } from "../shared/errors.js";
import { FAIL_CLOSED_SNAPSHOT, KillSwitchServicePg, emptySnapshot, killSwitchBlock, notificationAllowed } from "./kill-switches.js";
import { LocalFixtureKillSwitchService } from "./fixtures.js";
import { InTxAuditWriterFixture, createOpsTestDb, staffActor } from "./testing.js";

let db: PgliteDb | undefined;
afterEach(async () => {
  await db?.close();
  db = undefined;
});

async function setup(opts: { cacheTtlMs?: number } = {}) {
  db = await createOpsTestDb();
  const clock = new FakeClock("2026-10-17T15:00:00.000Z");
  const audit = new InTxAuditWriterFixture(db);
  const metrics = new InMemoryMetrics();
  const svc = new KillSwitchServicePg({ db, audit, clock, metrics, cacheTtlMs: opts.cacheTtlMs });
  return { db, clock, audit, metrics, svc };
}

describe("KillSwitchServicePg", () => {
  it("[OPS-02] kill switch requires authorized MFA staff and is audited in the same transaction", async () => {
    const { svc, audit, metrics, db } = await setup();
    const ks = await svc.set({ tenantId: TENANT_ID, scope: "AI_ADMISSION", target: "*", engaged: true, reason: "INCIDENT_UNSAFE_OUTPUT", staff: staffActor("supervisor") });
    expect(ks).toMatchObject({ scope: "AI_ADMISSION", target: "*", engaged: true, changedBy: "stf_synthSupervisor01" });
    expect((await svc.snapshot(TENANT_ID)).aiAdmission).toBe(true);
    const events = await audit.committed();
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe("killswitch.set");
    expect(events[0]?.outcome).toBe("SUCCEEDED");
    expect(events[0]?.body).toMatchObject({ actorRef: "stf_synthSupervisor01", role: "supervisor", sourceComponent: "console", reasonCode: "INCIDENT_UNSAFE_OUTPUT", dataClass: "SECURITY_AUDIT" });
    const history = await svc.history(TENANT_ID);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ version: 1, authorizingRole: "supervisor", auditEventId: events[0]?.event_id });
    expect(events[0]?.body.evidencePointers[0]).toMatch(/^db:\/\/kill_switch_history\/ksh_/);
    expect(metrics.counterValue("vsp_killswitch_changes_total", { scope: "AI_ADMISSION", engaged: "true" })).toBe(1);
    const owner = await db.query<{ n: number }>("select count(*)::int as n from kill_switch_history");
    expect(owner.rows[0]?.n).toBe(1);
  });

  it("[OPS-02] staff without MFA, without an allowed role, or with an expired break-glass session are denied and the denial is audited", async () => {
    const { svc, audit } = await setup();
    const cases = [
      { staff: staffActor("supervisor", { mfa: false }), code: "STAFF_MFA_REQUIRED" },
      { staff: staffActor("agent"), code: "STAFF_ROLE_NOT_PERMITTED" },
      { staff: staffActor("auditor"), code: "STAFF_ROLE_NOT_PERMITTED" },
      { staff: staffActor("deployOperator"), code: "STAFF_ROLE_NOT_PERMITTED" },
      {
        staff: staffActor("supervisor", { breakGlass: { reason: "synthetic expired break glass", expiresAt: "2026-10-17T14:00:00.000Z", approvedBy: "stf_synthSecurityAdm1" } }),
        code: "STAFF_BREAK_GLASS_EXPIRED",
      },
      { staff: { ...staffActor("supervisor"), roles: ["security_admin"], extra: true } as never, code: "STAFF_INVALID" },
    ];
    for (const c of cases) {
      await expect(svc.set({ tenantId: TENANT_ID, scope: "WRITES", target: "*", engaged: true, reason: "INCIDENT_DUPLICATE_COMMIT", staff: c.staff })).rejects.toMatchObject({
        reasonCode: c.code,
      });
    }
    expect(await svc.list(TENANT_ID)).toEqual([]);
    expect(await audit.committed()).toEqual([]);
    expect(audit.standalone.map((e) => [e.action, e.outcome, e.reasonCode])).toEqual(cases.map((c) => ["killswitch.set", "DENIED", c.code]));
  });

  it("[OPS-02] deployment operators may switch model and voice versions only; security admins may switch anything", async () => {
    const { svc } = await setup();
    await svc.set({ tenantId: TENANT_ID, scope: "MODEL_VERSION", target: "model-candidate-2", engaged: true, reason: "MODEL_REGRESSION", staff: staffActor("deployOperator") });
    await svc.set({ tenantId: TENANT_ID, scope: "VOICE_VERSION", target: "voice-candidate-3", engaged: true, reason: "VOICE_REGRESSION", staff: staffActor("deployOperator") });
    await expect(svc.set({ tenantId: TENANT_ID, scope: "INTEGRATION", target: "salesforce", engaged: true, reason: "DEPENDENCY_OUTAGE", staff: staffActor("deployOperator") })).rejects.toThrow(AccessDeniedError);
    await svc.set({ tenantId: TENANT_ID, scope: "INTEGRATION", target: "salesforce", engaged: true, reason: "DEPENDENCY_OUTAGE", staff: staffActor("securityAdmin") });
    const snap = await svc.snapshot(TENANT_ID);
    expect(snap.modelVersions).toEqual(["model-candidate-2"]);
    expect(snap.voiceVersions).toEqual(["voice-candidate-3"]);
    expect(snap.integrations).toEqual(["salesforce"]);
  });

  it("[OPS-01] when the audit event cannot be written the switch change does not happen", async () => {
    const { svc, audit } = await setup();
    audit.failAppend = true;
    await expect(svc.set({ tenantId: TENANT_ID, scope: "WRITES", target: "*", engaged: true, reason: "INCIDENT_DUPLICATE_COMMIT", staff: staffActor("supervisor") })).rejects.toBeInstanceOf(
      AuditUnavailableError,
    );
    expect(await svc.list(TENANT_ID)).toEqual([]);
    expect(await svc.history(TENANT_ID)).toEqual([]);
    expect((await svc.snapshot(TENANT_ID)).writes).toBe(false);
  });

  it("[SPEC-13.kill-switches] kill switch history is append-only for every role, including the owner", async () => {
    const { svc, db } = await setup();
    const staff = staffActor("supervisor");
    await svc.set({ tenantId: TENANT_ID, scope: "INTENT", target: "appointment_reschedule@1", engaged: true, reason: "INCIDENT_UNSAFE_OUTPUT", staff });
    await svc.set({ tenantId: TENANT_ID, scope: "INTENT", target: "appointment_reschedule@1", engaged: false, reason: "INCIDENT_RESOLVED", staff });
    const h = await svc.history(TENANT_ID);
    expect(h.map((x) => [x.version, x.engaged])).toEqual([
      [2, false],
      [1, true],
    ]);
    for (const sql of ["update kill_switch_history set engaged = true", "delete from kill_switch_history"]) {
      await expect(db.tx((tx) => tx.query(sql), { role: "app_console", rls: { tenantId: TENANT_ID } })).rejects.toThrow(/permission denied/);
      await expect(db.tx((tx) => tx.query(sql), { role: "owner" })).rejects.toThrow(/KILL_SWITCH_HISTORY_APPEND_ONLY/);
    }
    await expect(db.tx((tx) => tx.query("truncate kill_switch_history"), { role: "owner" })).rejects.toThrow(/KILL_SWITCH_HISTORY_APPEND_ONLY/);
    expect((await svc.history(TENANT_ID)).length).toBe(2);
  });

  it("[AUTH-05] kill switch state is tenant-isolated by row-level security and the runtime role cannot change it", async () => {
    const { svc, db } = await setup();
    await svc.set({ tenantId: TENANT_ID, scope: "WRITES", target: "*", engaged: true, reason: "INCIDENT_DUPLICATE_COMMIT", staff: staffActor("supervisor") });
    expect((await svc.snapshot(TENANT_ID)).writes).toBe(true);
    expect((await svc.snapshot(OTHER_TENANT_ID)).writes).toBe(false);
    expect(await svc.list(OTHER_TENANT_ID)).toEqual([]);
    await expect(
      db.tx((tx) => tx.query("update kill_switches set engaged = false"), { role: "app_runtime", rls: { tenantId: TENANT_ID } }),
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.tx(
        (tx) =>
          tx.query(
            "insert into kill_switches (tenant_id, scope, target, switch_id, engaged, reason, changed_by, changed_at, version) values ($1,'WRITES','*','ksw_x', false, 'XYZ', 'stf_x', now(), 1)",
            [OTHER_TENANT_ID],
          ),
        { role: "app_console", rls: { tenantId: TENANT_ID } },
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("[SPEC-13.kill-switches] snapshot fails closed (all automation engaged) when state cannot be read", async () => {
    const metrics = new InMemoryMetrics();
    const broken: Db = {
      engine: "pg",
      query: async () => Promise.reject(new Error("connection refused")),
      exec: async () => Promise.reject(new Error("connection refused")),
      tx: async () => Promise.reject(new Error("connection refused")),
      close: async () => undefined,
    };
    const svc = new KillSwitchServicePg({ db: broken, audit: new InTxAuditWriterFixture(broken), clock: new FakeClock(), metrics });
    expect(await svc.snapshot(TENANT_ID)).toEqual(FAIL_CLOSED_SNAPSHOT);
    expect(await svc.snapshot("not-an-opaque-tenant")).toEqual(FAIL_CLOSED_SNAPSHOT);
    expect(metrics.counterValue("vsp_killswitch_snapshot_failures_total")).toBe(2);
  });

  it("[SPEC-13.kill-switches] cache TTL defaults to 0; a positive TTL bounds staleness and own writes invalidate it", async () => {
    const { svc, db, clock, audit } = await setup({ cacheTtlMs: 5_000 });
    const otherInstance = new KillSwitchServicePg({ db, audit, clock });
    expect((await svc.snapshot(TENANT_ID)).aiAdmission).toBe(false); // cached
    await otherInstance.set({ tenantId: TENANT_ID, scope: "AI_ADMISSION", target: "*", engaged: true, reason: "INCIDENT_UNSAFE_OUTPUT", staff: staffActor("supervisor") });
    expect((await svc.snapshot(TENANT_ID)).aiAdmission).toBe(false); // stale within TTL (documented trade-off)
    expect((await otherInstance.snapshot(TENANT_ID)).aiAdmission).toBe(true); // TTL 0 reads current state
    clock.advanceMs(5_000);
    expect((await svc.snapshot(TENANT_ID)).aiAdmission).toBe(true);
    await svc.set({ tenantId: TENANT_ID, scope: "AI_ADMISSION", target: "*", engaged: false, reason: "INCIDENT_RESOLVED", staff: staffActor("supervisor") });
    expect((await svc.snapshot(TENANT_ID)).aiAdmission).toBe(false); // own write invalidated the cache
    expect(() => new KillSwitchServicePg({ db, audit, clock, cacheTtlMs: 120_000 })).toThrow("KILL_SWITCH_CACHE_TTL_INVALID");
  });

  it("[DATA-01] reasons are reason codes (optionally with an opaque incident id), never free text; targets are shape-checked", async () => {
    const { svc } = await setup();
    const staff = staffActor("supervisor");
    const bad = [
      { scope: "WRITES" as const, target: "*", reason: `caller ${PEOPLE.avery.fullName} reported a problem` },
      { scope: "WRITES" as const, target: "*", reason: "INCIDENT_5555550101" },
      { scope: "WRITES" as const, target: "salesforce", reason: "INCIDENT_X" },
      { scope: "INTEGRATION" as const, target: "*", reason: "INCIDENT_X" },
      { scope: "INTENT" as const, target: "Avery Synthetic", reason: "INCIDENT_X" },
    ];
    for (const b of bad) {
      await expect(svc.set({ tenantId: TENANT_ID, ...b, engaged: true, staff })).rejects.toThrow("KILL_SWITCH_INPUT_INVALID");
    }
    const ok = await svc.set({ tenantId: TENANT_ID, scope: "OUTBOUND_NOTIFICATIONS", target: "*", engaged: true, reason: "INCIDENT_PHI_EXPOSURE:inc_synthIncident000000001", staff });
    expect(ok.reason).toBe("INCIDENT_PHI_EXPOSURE:inc_synthIncident000000001");
  });
});

describe("kill switch evaluation", () => {
  it("[SAFE-02] no kill switch ever blocks SAFETY or HUMAN_ROUTE", () => {
    const all = { ...emptySnapshot(), aiAdmission: true, writes: true, outboundNotifications: true, intents: ["safety_handoff"], integrations: ["talkdesk-telephony"], modelVersions: ["m1"], voiceVersions: ["v1"] };
    for (const cls of ["SAFETY", "HUMAN_ROUTE"] as const) {
      expect(killSwitchBlock(all, { class: cls, newSession: true, intent: "safety_handoff", integration: "talkdesk-telephony", modelVersion: "m1", voiceVersion: "v1" })).toBeNull();
    }
  });

  it("[SPEC-13.kill-switches] separate switches for new AI admissions, an intent, an integration, writes, a model and a voice version", () => {
    const s = emptySnapshot();
    expect(killSwitchBlock({ ...s, aiAdmission: true }, { class: "PUBLIC", newSession: true })).toBe("KILL_SWITCH_AI_ADMISSION");
    expect(killSwitchBlock({ ...s, aiAdmission: true }, { class: "PUBLIC", newSession: false })).toBeNull();
    expect(killSwitchBlock({ ...s, writes: true }, { class: "WRITE" })).toBe("KILL_SWITCH_WRITES");
    expect(killSwitchBlock({ ...s, writes: true }, { class: "PROTECTED_READ" })).toBeNull();
    expect(killSwitchBlock({ ...s, intents: ["billing_dispute"] }, { class: "PROTECTED_READ", intent: "billing_dispute" })).toBe("KILL_SWITCH_INTENT");
    expect(killSwitchBlock({ ...s, integrations: ["salesforce"] }, { class: "WRITE", integration: "salesforce" })).toBe("KILL_SWITCH_INTEGRATION");
    expect(killSwitchBlock({ ...s, modelVersions: ["m2"] }, { class: "PUBLIC", modelVersion: "m2" })).toBe("KILL_SWITCH_MODEL_VERSION");
    expect(killSwitchBlock({ ...s, voiceVersions: ["v2"] }, { class: "PUBLIC", voiceVersion: "v2" })).toBe("KILL_SWITCH_VOICE_VERSION");
  });

  it("[SPEC-13.kill-switches] the outbound notifications switch blocks routine notifications but not safety escalation paging", () => {
    const s = { ...emptySnapshot(), outboundNotifications: true };
    expect(notificationAllowed(s, "ROUTINE")).toBe(false);
    expect(notificationAllowed(s, "SAFETY_ESCALATION")).toBe(true);
    expect(notificationAllowed(emptySnapshot(), "ROUTINE")).toBe(true);
  });

  it("[OPS-02] LOCAL FIXTURE kill switch service applies the same authorization rules", async () => {
    const svc = new LocalFixtureKillSwitchService({ clock: new FakeClock() });
    await expect(svc.set({ tenantId: TENANT_ID, scope: "WRITES", target: "*", engaged: true, reason: "INCIDENT_X", staff: staffActor("agent") })).rejects.toThrow(AccessDeniedError);
    await svc.set({ tenantId: TENANT_ID, scope: "WRITES", target: "*", engaged: true, reason: "INCIDENT_X", staff: staffActor("supervisor") });
    expect((await svc.snapshot(TENANT_ID)).writes).toBe(true);
    expect(svc.kind).toBe("local_fixture");
  });
});
