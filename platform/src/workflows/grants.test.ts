import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PgliteDb } from "../db/pglite.js";
import { createTestDb } from "../db/testing.js";
import type { Db } from "../db/types.js";
import { OTHER_TENANT_ID, TENANT_ID } from "../fixtures/synthetic-world.js";
import { createMemoryLogger } from "../observability/logger.js";
import type { LogRecord } from "../observability/logger.js";
import { InMemoryMetrics } from "../observability/metrics.js";
import { FakeClock } from "../shared/clock.js";
import { DependencyError, ValidationError } from "../shared/errors.js";
import { newId } from "../shared/ids.js";
import { PgWorkflowEngine, WorkflowRecheckDeniedError, type WorkflowStartInput } from "./engine.js";
import { PgDurableGrantStore, type DurableGrantStore } from "./grants.js";
import { createDefaultRegistry } from "./registry.js";
import { AuditWriterFixture, RecheckFixture, staffActor } from "./workflow-test-fixtures.js";

const START = "2026-10-17T15:00:00.000Z";
const SYSTEM = { kind: "system" as const, ref: null };
const SUBJECT = "cli_synthClient000000001";
const ACTOR = "act_synthCallerActor0001";
const SOURCE = "act_synthBillingAction01";
const DAY = 86_400_000;

async function ownerQuery<T>(db: PgliteDb, sql: string, params: unknown[] = []): Promise<T[]> {
  return db.tx(async (tx) => (await tx.query<T>(sql, params)).rows, { role: "owner" });
}

describe("PgDurableGrantStore (spec section 7: narrowly authorized durable action grants)", () => {
  let db: PgliteDb;
  let audit: AuditWriterFixture;
  let clock: FakeClock;
  let store: PgDurableGrantStore;

  beforeAll(async () => {
    db = await createTestDb({ include: /^04/ });
    audit = await AuditWriterFixture.create(db);
    clock = new FakeClock(START);
    store = new PgDurableGrantStore({ db, clock, audit });
  });
  afterAll(async () => db.close());

  const issue = (overrides: Partial<Parameters<DurableGrantStore["issue"]>[0]> = {}) =>
    store.issue({
      tenantId: TENANT_ID,
      subjectId: SUBJECT,
      actorId: ACTOR,
      actions: ["billing.review.commit", "billing.review.outcome_notice"],
      expiresAt: new Date(Date.parse(START) + 7 * DAY),
      sourceRef: SOURCE,
      ...overrides,
    });

  it("[SPEC-7.durable-grant][DATA-01] issue stores opaque references and code tokens only, and audits the issuance", async () => {
    clock.set(START);
    const { grantRef } = await issue();
    expect(grantRef).toMatch(/^grt_[A-Za-z0-9_-]{16,64}$/);
    const rows = await ownerQuery<Record<string, unknown>>(db, "select * from durable_action_grants where grant_id = $1", [grantRef]);
    expect(rows[0]).toMatchObject({ tenant_id: TENANT_ID, subject_id: SUBJECT, actor_id: ACTOR, source_ref: SOURCE, revoked_at: null });
    expect(rows[0]?.actions).toEqual(["billing.review.commit", "billing.review.outcome_notice"]);
    const events = (await audit.all()).filter((a) => a.evidencePointers.includes(`grant:${grantRef}`));
    expect(events.map((e) => [e.action, e.outcome, e.dataClass])).toEqual([["workflow.grant.issued", "SUCCEEDED", "SECURITY_AUDIT"]]);
  });

  it("[SPEC-7.durable-grant] check is valid only for a declared action, before expiry and while unrevoked", async () => {
    clock.set(START);
    const { grantRef } = await issue();
    const now = clock.now();
    expect(await store.check(TENANT_ID, grantRef, "billing.review.commit", now)).toEqual({ valid: true, reasonCode: "GRANT_VALID" });
    expect(await store.check(TENANT_ID, grantRef, "billing.review.refund", now)).toEqual({ valid: false, reasonCode: "GRANT_ACTION_NOT_PERMITTED" });
    expect(await store.check(TENANT_ID, grantRef, "billing.review.commit", new Date(Date.parse(START) + 7 * DAY - 1))).toMatchObject({ valid: true });
    expect(await store.check(TENANT_ID, grantRef, "billing.review.commit", new Date(Date.parse(START) + 7 * DAY))).toEqual({ valid: false, reasonCode: "GRANT_EXPIRED" });
  });

  it("[AUTH-04][SPEC-7.durable-grant] a revoked grant fails closed immediately; revocation is idempotent, audited and final", async () => {
    clock.set(START);
    const { grantRef } = await issue();
    await store.revoke(TENANT_ID, grantRef, "CONSENT_REVOKED");
    await store.revoke(TENANT_ID, grantRef, "SAFETY_ESCALATION");
    expect(await store.check(TENANT_ID, grantRef, "billing.review.commit", clock.now())).toEqual({ valid: false, reasonCode: "GRANT_REVOKED" });
    const rows = await ownerQuery<{ revoked_reason: string }>(db, "select revoked_reason from durable_action_grants where grant_id = $1", [grantRef]);
    expect(rows[0]?.revoked_reason).toBe("CONSENT_REVOKED");
    const revoked = (await audit.all()).filter((a) => a.action === "workflow.grant.revoked" && a.evidencePointers.includes(`grant:${grantRef}`));
    expect(revoked).toHaveLength(1);
    expect(revoked[0]).toMatchObject({ outcome: "INVALIDATED", reasonCode: "CONSENT_REVOKED" });
    // The revocation cannot be cleared even by a runtime role writing the table directly.
    await expect(
      db.tx((tx) => tx.query("update durable_action_grants set revoked_at = null, revoked_reason = null where grant_id = $1", [grantRef]), { rls: { tenantId: TENANT_ID } }),
    ).rejects.toThrow();
  });

  it("[AUTH-05] grants are tenant-isolated: another tenant's context sees no grant", async () => {
    clock.set(START);
    const { grantRef } = await issue();
    expect(await store.check(OTHER_TENANT_ID, grantRef, "billing.review.commit", clock.now())).toEqual({ valid: false, reasonCode: "GRANT_NOT_FOUND" });
    await expect(store.revoke(OTHER_TENANT_ID, grantRef, "CONSENT_REVOKED")).rejects.toMatchObject({ reasonCode: "GRANT_NOT_FOUND" });
    expect(await store.check(TENANT_ID, grantRef, "billing.review.commit", clock.now())).toMatchObject({ valid: true });
  });

  it("[SPEC-7.durable-grant] unknown or malformed references and actions are never valid", async () => {
    const now = clock.now();
    expect(await store.check(TENANT_ID, newId("grt"), "billing.review.commit", now)).toEqual({ valid: false, reasonCode: "GRANT_NOT_FOUND" });
    expect(await store.check(TENANT_ID, "not a grant", "billing.review.commit", now)).toEqual({ valid: false, reasonCode: "GRANT_INPUT_INVALID" });
    expect(await store.check(TENANT_ID, newId("grt"), "Billing Review", now)).toEqual({ valid: false, reasonCode: "GRANT_INPUT_INVALID" });
    expect(await store.check(TENANT_ID, newId("grt"), "billing.review.commit", new Date(Number.NaN))).toEqual({ valid: false, reasonCode: "GRANT_INPUT_INVALID" });
  });

  it("[SPEC-7.durable-grant][DATA-01] issue rejects past or over-long expiries, duplicate or free-text actions and PHI-shaped references", async () => {
    clock.set(START);
    await expect(issue({ expiresAt: new Date(Date.parse(START) - 1) })).rejects.toMatchObject({ reasonCode: "GRANT_EXPIRY_NOT_IN_FUTURE" });
    await expect(issue({ expiresAt: new Date(Date.parse(START) + 31 * DAY) })).rejects.toMatchObject({ reasonCode: "GRANT_EXPIRY_BEYOND_MAXIMUM" });
    await expect(issue({ actions: [] })).rejects.toBeInstanceOf(ValidationError);
    await expect(issue({ actions: ["billing.review.commit", "billing.review.commit"] })).rejects.toBeInstanceOf(ValidationError);
    await expect(issue({ actions: ["refund the caller"] })).rejects.toBeInstanceOf(ValidationError);
    await expect(issue({ subjectId: "Synthetic Person 1990-01-01" })).rejects.toBeInstanceOf(ValidationError);
    await expect(issue({ sourceRef: "call me at 555 0101" })).rejects.toBeInstanceOf(ValidationError);
    // The database refuses free text too, even for the owner.
    await expect(
      db.tx(
        (tx) =>
          tx.query(
            `insert into durable_action_grants (grant_id, tenant_id, subject_id, actor_id, actions, source_ref, issued_at, expires_at)
             values ($1, $2, $3, null, $4::text[], $5, now(), now() + interval '1 day')`,
            [newId("grt"), TENANT_ID, SUBJECT, ["refund everything now"], SOURCE],
          ),
        { role: "owner" },
      ),
    ).rejects.toThrow();
  });

  it("[OPS-01] grants are append-only: fields are immutable and rows cannot be deleted", async () => {
    clock.set(START);
    const { grantRef } = await issue();
    await expect(
      db.tx((tx) => tx.query("update durable_action_grants set actions = array['billing.review.refund'] where grant_id = $1", [grantRef]), { role: "owner" }),
    ).rejects.toThrow(/DURABLE_GRANT_IMMUTABLE_FIELD/);
    await expect(db.tx((tx) => tx.query("delete from durable_action_grants where grant_id = $1", [grantRef]), { role: "owner" })).rejects.toThrow(
      /DURABLE_GRANT_APPEND_ONLY/,
    );
    await expect(
      db.tx((tx) => tx.query("update durable_action_grants set expires_at = expires_at + interval '1 year' where grant_id = $1", [grantRef]), {
        role: "app_runtime",
        rls: { tenantId: TENANT_ID },
      }),
    ).rejects.toThrow();
  });

  it("[OPS-01][SPEC-7.durable-grant] issue inside the accepting transaction is atomic with it; audit unavailability blocks issuance", async () => {
    clock.set(START);
    let issued: string | null = null;
    await expect(
      db.tx(
        async (tx) => {
          const inner = await store.issue(
            { tenantId: TENANT_ID, subjectId: SUBJECT, actorId: null, actions: ["callback.outreach"], expiresAt: new Date(Date.parse(START) + DAY), sourceRef: SOURCE },
            tx,
          );
          issued = inner.grantRef;
          throw new Error("accepting action failed");
        },
        { rls: { tenantId: TENANT_ID } },
      ),
    ).rejects.toThrow();
    expect(issued).not.toBeNull();
    expect(await store.check(TENANT_ID, issued as unknown as string, "callback.outreach", clock.now())).toEqual({ valid: false, reasonCode: "GRANT_NOT_FOUND" });
    await expect(
      db.tx((tx) => store.issue({ tenantId: TENANT_ID, subjectId: SUBJECT, actorId: null, actions: ["callback.outreach"], expiresAt: new Date(Date.parse(START) + DAY), sourceRef: SOURCE }, tx), {
        rls: { tenantId: OTHER_TENANT_ID },
      }),
    ).rejects.toMatchObject({ reasonCode: "TENANT_CONTEXT_MISMATCH" });
    audit.unavailable = true;
    try {
      await expect(issue()).rejects.toThrow();
    } finally {
      audit.unavailable = false;
    }
  });

  it("[OPS-04] the store labels itself a local fixture on embedded PGlite", () => {
    expect(store.kind).toBe("local_fixture");
  });
});

// ---------------------------------------------------------------------------
// Engine integration
// ---------------------------------------------------------------------------

/** LOCAL TEST FIXTURE: a Db whose transactions fail as if the database were unreachable. */
function unreachableDb(real: Db): Db {
  return {
    engine: real.engine,
    query: () => Promise.reject(new Error("connection refused")),
    exec: () => Promise.reject(new Error("connection refused")),
    tx: () => Promise.reject(new Error("connection refused")),
    close: () => Promise.resolve(),
  };
}

describe("PgWorkflowEngine with durable action grants (guarded transitions)", () => {
  let db: PgliteDb;
  let audit: AuditWriterFixture;
  let clock: FakeClock;
  let grants: PgDurableGrantStore;
  let metrics: InMemoryMetrics;
  let logs: LogRecord[];
  let recheck: RecheckFixture;
  let engine: PgWorkflowEngine;

  beforeAll(async () => {
    db = await createTestDb({ include: /^04/ });
    audit = await AuditWriterFixture.create(db);
    clock = new FakeClock(START);
    grants = new PgDurableGrantStore({ db, clock, audit });
    metrics = new InMemoryMetrics();
    const mem = createMemoryLogger();
    logs = mem.records;
    recheck = new RecheckFixture(() => ({ allow: true }));
    engine = new PgWorkflowEngine({ db, registry: createDefaultRegistry(), audit, clock, recheck, grantStore: grants, metrics, logger: mem.logger });
  });
  afterAll(async () => db.close());

  async function grantFor(actions: string[], ttlMs = 7 * DAY): Promise<string> {
    return (await grants.issue({ tenantId: TENANT_ID, subjectId: SUBJECT, actorId: ACTOR, actions, expiresAt: new Date(clock.now().getTime() + ttlMs), sourceRef: SOURCE })).grantRef;
  }

  /** billing_dispute_review to READY_TO_COMMIT (HUMAN_APPROVED is unguarded there). */
  async function readyToCommit(e: PgWorkflowEngine, grantRef: string | null, type: WorkflowStartInput["type"] = "billing_dispute_review") {
    const wf = await e.start({ tenantId: TENANT_ID, type, correlationId: newId("cor"), sourceRecordRefs: [SOURCE], grantRef });
    await e.signal({ tenantId: TENANT_ID, workflowId: wf.workflowId, event: "VALIDATE", actor: SYSTEM });
    await e.signal({ tenantId: TENANT_ID, workflowId: wf.workflowId, event: "VALIDATION_PASSED", actor: SYSTEM });
    const task = (await e.openTasks(TENANT_ID, ["supervisor"])).find((t) => t.workflowId === wf.workflowId);
    if (!task) throw new Error("expected an open task");
    const issued = await e.issueTaskToken({ tenantId: TENANT_ID, taskId: task.taskId, staff: staffActor("supervisor") });
    const ready = await e.completeHumanTask({ tenantId: TENANT_ID, taskId: task.taskId, taskToken: issued.taskToken, decision: "APPROVE", staff: staffActor("supervisor") });
    expect(ready.state).toBe("READY_TO_COMMIT");
    return ready;
  }

  it("[SPEC-7.durable-grant][SPEC-9.recheck] a valid grant for the transition's declared action lets the material change proceed (then the recheck runs)", async () => {
    clock.set(START);
    const grantRef = await grantFor(["billing.review.commit", "billing.review.outcome_notice"]);
    const wf = await readyToCommit(engine, grantRef);
    const before = recheck.calls.length;
    const committed = await engine.signal({ tenantId: TENANT_ID, workflowId: wf.workflowId, event: "COMMIT", actor: SYSTEM });
    expect(committed.state).toBe("WAITING_FOR_SYSTEM");
    expect(recheck.calls.slice(before)).toMatchObject([{ event: "COMMIT", grantRef, grantAction: "billing.review.commit" }]);
    expect(metrics.counterValue("vsp_grant_checks_total", { result: "valid", guard: "material_change" })).toBeGreaterThanOrEqual(1);
    const done = await engine.signal({ tenantId: TENANT_ID, workflowId: wf.workflowId, event: "SYSTEM_CONFIRMED", actor: { kind: "external_system", ref: null } });
    expect(done.state).toBe("COMPLETED");
  });

  it.each([
    ["a grant without the declared action", "GRANT_ACTION_NOT_PERMITTED", async () => grantFor(["billing.review.decision_notice"])],
    [
      "an expired grant",
      "GRANT_EXPIRED",
      async () => {
        const g = await grantFor(["billing.review.commit"], 60 * 60 * 1000);
        return g;
      },
    ],
    [
      "a revoked grant",
      "GRANT_REVOKED",
      async () => {
        const g = await grantFor(["billing.review.commit"]);
        await grants.revoke(TENANT_ID, g, "CONSENT_REVOKED");
        return g;
      },
    ],
    ["a grant reference that was never issued", "GRANT_NOT_FOUND", async () => newId("grt")],
  ] as const)(
    "[SPEC-7.durable-grant][SPEC-9.recheck] %s takes the recheck-denied path: POLICY_CHANGED_PENDING_ACTION, no material change, audited",
    async (_label, reason, makeGrant) => {
      clock.set(START);
      const grantRef = await makeGrant();
      const wf = await readyToCommit(engine, grantRef);
      if (reason === "GRANT_EXPIRED") clock.advanceSeconds(2 * 60 * 60);
      const before = recheck.calls.length;
      const err = await engine.signal({ tenantId: TENANT_ID, workflowId: wf.workflowId, event: "COMMIT", actor: SYSTEM }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WorkflowRecheckDeniedError);
      expect((err as WorkflowRecheckDeniedError).reasonCode).toBe(reason);
      expect((err as WorkflowRecheckDeniedError).instance.state).toBe("WAITING_FOR_HUMAN");
      expect(recheck.calls.length).toBe(before); // no recheck runs on an invalid grant
      const history = await engine.history(TENANT_ID, wf.workflowId);
      expect(history.at(-1)).toMatchObject({ fromState: "READY_TO_COMMIT", toState: "WAITING_FOR_HUMAN", trigger: "POLICY_CHANGED_PENDING_ACTION" });
      expect(history.some((e) => e.trigger === "COMMIT")).toBe(false);
      const evidence = (await audit.all()).filter((a) => a.evidencePointers.includes(`workflow:${wf.workflowId}`));
      expect(evidence.find((a) => a.action === "workflow.grant.denied")).toMatchObject({ outcome: "DENIED", reasonCode: reason });
      expect(evidence.find((a) => a.action === "workflow.policy_changed_pending_action")).toMatchObject({ reasonCode: reason });
    },
  );

  it("[SPEC-7.durable-grant][SPEC-9.human-task] a guarded human decision with a revoked grant is recorded as a policy change and the disclosure does not happen", async () => {
    clock.set(START);
    const grantRef = await grantFor(["claim.findings.disclose"]);
    const wf = await engine.start({ tenantId: TENANT_ID, type: "claim_investigation", correlationId: newId("cor"), sourceRecordRefs: [SOURCE], grantRef });
    await engine.signal({ tenantId: TENANT_ID, workflowId: wf.workflowId, event: "VALIDATE", actor: SYSTEM });
    await engine.signal({ tenantId: TENANT_ID, workflowId: wf.workflowId, event: "VALIDATION_PASSED", actor: SYSTEM });
    await engine.signal({ tenantId: TENANT_ID, workflowId: wf.workflowId, event: "SYSTEM_CONFIRMED", actor: SYSTEM });
    await grants.revoke(TENANT_ID, grantRef, "REPRESENTATION_ENDED");
    const task = (await engine.openTasks(TENANT_ID, ["supervisor"])).find((t) => t.workflowId === wf.workflowId);
    if (!task) throw new Error("expected an open task");
    const issued = await engine.issueTaskToken({ tenantId: TENANT_ID, taskId: task.taskId, staff: staffActor("supervisor") });
    await expect(
      engine.completeHumanTask({ tenantId: TENANT_ID, taskId: task.taskId, taskToken: issued.taskToken, decision: "APPROVE", staff: staffActor("supervisor") }),
    ).rejects.toMatchObject({ reasonCode: "GRANT_REVOKED" });
    const inst = await engine.get(TENANT_ID, wf.workflowId);
    expect(inst?.state).toBe("WAITING_FOR_HUMAN");
    expect((await engine.history(TENANT_ID, wf.workflowId)).some((e) => e.toState === "COMPLETED")).toBe(false);
  });

  it("[SPEC-7.durable-grant] an instance without a grantRef keeps the fail-closed behaviour (DURABLE_GRANT_MISSING) and reports GRANT_ABSENT", async () => {
    clock.set(START);
    const wf = await readyToCommit(engine, null);
    await expect(engine.signal({ tenantId: TENANT_ID, workflowId: wf.workflowId, event: "COMMIT", actor: SYSTEM })).rejects.toMatchObject({
      reasonCode: "DURABLE_GRANT_MISSING",
    });
    expect(metrics.counterValue("vsp_grant_checks_total", { result: "absent" })).toBeGreaterThanOrEqual(1);
    expect(logs.some((l) => l.event === "workflow.grant.absent" && l.fields.reasonCode === "GRANT_ABSENT")).toBe(true);
  });

  it("[SPEC-7.durable-grant] without a wired grant store the previous behaviour applies and the gap is reported (GRANT_STORE_UNCONFIGURED)", async () => {
    clock.set(START);
    const legacy = new PgWorkflowEngine({ db, registry: createDefaultRegistry(), audit, clock, recheck, metrics, logger: createMemoryLogger().logger });
    const wf = await readyToCommit(legacy, newId("grt"));
    const committed = await legacy.signal({ tenantId: TENANT_ID, workflowId: wf.workflowId, event: "COMMIT", actor: SYSTEM });
    expect(committed.state).toBe("WAITING_FOR_SYSTEM");
    expect(metrics.counterValue("vsp_grant_checks_total", { result: "store_unconfigured" })).toBeGreaterThanOrEqual(1);
  });

  it("[SPEC-7.durable-grant][SPEC-9.recheck] an unreachable grant store fails closed: no transition and no policy-change record", async () => {
    clock.set(START);
    const grantRef = await grantFor(["billing.review.commit"]);
    const wf = await readyToCommit(engine, grantRef);
    const broken = new PgWorkflowEngine({
      db,
      registry: createDefaultRegistry(),
      audit,
      clock,
      recheck,
      grantStore: {
        kind: "local_fixture",
        issue: () => Promise.reject(new Error("unused")),
        revoke: () => Promise.reject(new Error("unused")),
        check: () => new PgDurableGrantStore({ db: unreachableDb(db), clock }).check(TENANT_ID, grantRef, "billing.review.commit", clock.now()),
      },
    });
    await expect(broken.signal({ tenantId: TENANT_ID, workflowId: wf.workflowId, event: "COMMIT", actor: SYSTEM })).rejects.toBeInstanceOf(DependencyError);
    const malformed = new PgWorkflowEngine({
      db,
      registry: createDefaultRegistry(),
      audit,
      clock,
      recheck,
      grantStore: { kind: "local_fixture", issue: () => Promise.reject(new Error("unused")), revoke: () => Promise.reject(new Error("unused")), check: async () => ({ valid: true, reasonCode: "OK please" }) },
    });
    await expect(malformed.signal({ tenantId: TENANT_ID, workflowId: wf.workflowId, event: "COMMIT", actor: SYSTEM })).rejects.toMatchObject({
      reasonCode: "GRANT_CHECK_RESULT_INVALID",
    });
    expect((await engine.get(TENANT_ID, wf.workflowId))?.state).toBe("READY_TO_COMMIT");
    expect((await engine.history(TENANT_ID, wf.workflowId)).some((e) => e.trigger === "POLICY_CHANGED_PENDING_ACTION")).toBe(false);
  });
});
