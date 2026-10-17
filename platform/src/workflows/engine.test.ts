import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../db/testing.js";
import type { PgliteDb } from "../db/pglite.js";
import { OTHER_TENANT_ID, TENANT_ID } from "../fixtures/synthetic-world.js";
import { createMemoryLogger } from "../observability/logger.js";
import type { LogRecord } from "../observability/logger.js";
import { sha256Hex } from "../shared/canonical.js";
import { FakeClock } from "../shared/clock.js";
import { AccessDeniedError, AuditUnavailableError, ConflictError, DependencyError, ValidationError } from "../shared/errors.js";
import { newId } from "../shared/ids.js";
import { billingDisputeReviewV1 } from "./definitions/index.js";
import { PgWorkflowEngine, WorkflowRecheckDeniedError, type WorkflowStartInput } from "./engine.js";
import { workflowOutcome } from "./outcome.js";
import type { PreDisclosureRecheck } from "./recheck.js";
import { createDefaultRegistry, WorkflowDefinitionRegistry } from "./registry.js";
import type { VersionedWorkflowDefinition } from "./types.js";
import { AuditWriterFixture, RecheckFixture, staffActor } from "./workflow-test-fixtures.js";

const START = "2026-10-17T15:00:00.000Z";
const SYSTEM = { kind: "system" as const, ref: null };

interface Harness {
  db: PgliteDb;
  audit: AuditWriterFixture;
  clock: FakeClock;
  engine: PgWorkflowEngine;
  logs: LogRecord[];
  registry: WorkflowDefinitionRegistry;
}

async function harness(opts: { recheck?: PreDisclosureRecheck; registry?: WorkflowDefinitionRegistry } = {}): Promise<Harness> {
  const db = await createTestDb({ include: /^04/ });
  const audit = await AuditWriterFixture.create(db);
  const clock = new FakeClock(START);
  const { logger, records } = createMemoryLogger();
  const registry = opts.registry ?? createDefaultRegistry();
  const engine = new PgWorkflowEngine({ db, registry, audit, clock, recheck: opts.recheck, logger });
  return { db, audit, clock, engine, logs: records, registry };
}

function startInput(overrides: Partial<WorkflowStartInput> = {}): WorkflowStartInput {
  return {
    tenantId: TENANT_ID,
    type: "billing_dispute_review",
    correlationId: newId("cor"),
    sourceRecordRefs: [newId("sr"), newId("act")],
    grantRef: newId("grt"),
    ...overrides,
  };
}

async function ownerQuery<T>(db: PgliteDb, sql: string, params: unknown[] = []): Promise<T[]> {
  return db.tx(async (tx) => (await tx.query<T>(sql, params)).rows, { role: "owner" });
}

async function toHuman(h: Harness, overrides: Partial<WorkflowStartInput> = {}) {
  const wf = await h.engine.start(startInput(overrides));
  await h.engine.signal({ tenantId: TENANT_ID, workflowId: wf.workflowId, event: "VALIDATE", actor: SYSTEM });
  const inst = await h.engine.signal({ tenantId: TENANT_ID, workflowId: wf.workflowId, event: "VALIDATION_PASSED", actor: SYSTEM });
  const tasks = (await h.engine.openTasks(TENANT_ID, ["support_agent", "supervisor"])).filter((t) => t.workflowId === wf.workflowId);
  const task = tasks[0];
  if (!task) throw new Error("expected open task");
  return { wf: inst, task };
}

const allowRecheck = () => new RecheckFixture(() => ({ allow: true }));

// ---------------------------------------------------------------------------

describe("PgWorkflowEngine: start, signal, concurrency, idempotency", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness({ recheck: allowRecheck() });
  });
  afterAll(async () => h.db.close());

  it("[SPEC-9.workflow][OPS-01] start persists opaque references only and records an ACCEPTED event with audit evidence", async () => {
    const input = startInput({ policySnapshotVersion: "pol-2026.10.1" });
    const wf = await h.engine.start(input);
    expect(wf).toMatchObject({
      tenantId: TENANT_ID,
      type: "billing_dispute_review",
      definitionVersion: "1.0.0",
      state: "ACCEPTED",
      ownerQueue: "q_billing_intake",
      deadline: "2026-10-17T15:15:00.000Z",
      attempts: 0,
      version: 1,
      grantRef: input.grantRef,
    });
    expect(wf.workflowId).toMatch(/^wf_[A-Za-z0-9_-]{16,64}$/);
    expect(wf.sourceRecordRefs).toEqual(input.sourceRecordRefs);
    const history = await h.engine.history(TENANT_ID, wf.workflowId);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ fromState: null, toState: "ACCEPTED", trigger: "WORKFLOW_ACCEPTED", attempt: 0 });
    const audits = (await h.audit.all()).filter((a) => a.evidencePointers.includes(`workflow:${wf.workflowId}`));
    expect(audits.map((a) => a.action)).toEqual(["workflow.start"]);
    expect(audits[0]?.outcome).toBe("PENDING");
  });

  it("[DATA-01] free-text source references are rejected by the input schema and by the database constraint", async () => {
    await expect(h.engine.start(startInput({ sourceRecordRefs: ["Synthetic Person 1990-01-01"] }))).rejects.toBeInstanceOf(ValidationError);
    await expect(
      h.db.tx(
        (tx) =>
          tx.query(
            `insert into workflow_instances (workflow_id, tenant_id, workflow_type, definition_version, state, owner_queue, deadline,
               source_record_refs, correlation_id, row_version, state_entered_at, created_at, updated_at)
             values ($1, $2, 'billing_dispute_review', '1.0.0', 'ACCEPTED', 'q_billing_intake', now(), $3, $4, 1, now(), now(), now())`,
            [newId("wf"), TENANT_ID, ["call me at 555 0101"], newId("cor")],
          ),
        { rls: { tenantId: TENANT_ID } },
      ),
    ).rejects.toThrow();
  });

  it("[SPEC-9.workflow] start inside the caller's transaction is atomic with the accepting action", async () => {
    const correlationId = newId("cor");
    await expect(
      h.db.tx(
        async (tx) => {
          await h.engine.start(startInput({ correlationId }), tx);
          throw new Error("accepting action failed after workflow start");
        },
        { rls: { tenantId: TENANT_ID } },
      ),
    ).rejects.toThrow("accepting action failed");
    expect(await ownerQuery(h.db, "select 1 from workflow_instances where correlation_id = $1", [correlationId])).toHaveLength(0);
    expect((await h.audit.all()).filter((a) => a.correlationId === correlationId)).toHaveLength(0);

    const committed = await h.db.tx((tx) => h.engine.start(startInput({ correlationId }), tx), { rls: { tenantId: TENANT_ID } });
    expect((await h.engine.get(TENANT_ID, committed.workflowId))?.state).toBe("ACCEPTED");
  });

  it("[AUTH-02] start inside a transaction scoped to another tenant fails closed", async () => {
    await expect(
      h.db.tx((tx) => h.engine.start(startInput(), tx), { rls: { tenantId: OTHER_TENANT_ID } }),
    ).rejects.toMatchObject({ reasonCode: "TENANT_CONTEXT_MISMATCH" });
  });

  it("[SPEC-9.workflow] signal applies a declared transition and rejects an undeclared one without changing state", async () => {
    const wf = await h.engine.start(startInput());
    const v = await h.engine.signal({ tenantId: TENANT_ID, workflowId: wf.workflowId, event: "VALIDATE", actor: SYSTEM });
    expect(v).toMatchObject({ state: "VALIDATING", version: 2, ownerQueue: "q_billing_intake", deadline: "2026-10-17T16:00:00.000Z" });
    await expect(
      h.engine.signal({ tenantId: TENANT_ID, workflowId: wf.workflowId, event: "SYSTEM_CONFIRMED", actor: SYSTEM }),
    ).rejects.toMatchObject({ reasonCode: "TRANSITION_NOT_ALLOWED" });
    expect(await h.engine.get(TENANT_ID, wf.workflowId)).toMatchObject({ state: "VALIDATING", version: 2 });
    expect(await h.engine.history(TENANT_ID, wf.workflowId)).toHaveLength(2);
  });

  it("[SPEC-9.workflow] optimistic concurrency: a stale expectedVersion is rejected with a conflict", async () => {
    const wf = await h.engine.start(startInput());
    await h.engine.signal({ tenantId: TENANT_ID, workflowId: wf.workflowId, event: "VALIDATE", actor: SYSTEM, expectedVersion: 1 });
    await expect(
      h.engine.signal({ tenantId: TENANT_ID, workflowId: wf.workflowId, event: "NEEDS_CALLER_INFO", actor: SYSTEM, expectedVersion: 1 }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect((await h.engine.get(TENANT_ID, wf.workflowId))?.state).toBe("VALIDATING");
  });

  it("[ACT-02] a duplicate signal with the same dedupe key is ignored: one event, one transition", async () => {
    const wf = await h.engine.start(startInput());
    const a = await h.engine.signal({ tenantId: TENANT_ID, workflowId: wf.workflowId, event: "VALIDATE", actor: SYSTEM, dedupeKey: "sqs:msg-0001" });
    const b = await h.engine.signal({ tenantId: TENANT_ID, workflowId: wf.workflowId, event: "VALIDATE", actor: SYSTEM, dedupeKey: "sqs:msg-0001" });
    expect(b).toEqual(a);
    expect(await h.engine.history(TENANT_ID, wf.workflowId)).toHaveLength(2);
  });

  it("[ACT-02] a redelivered signal (same expectedVersion and event) is idempotent instead of conflicting", async () => {
    const wf = await h.engine.start(startInput());
    const first = await h.engine.signal({ tenantId: TENANT_ID, workflowId: wf.workflowId, event: "VALIDATE", actor: SYSTEM, expectedVersion: 1 });
    const redelivered = await h.engine.signal({ tenantId: TENANT_ID, workflowId: wf.workflowId, event: "VALIDATE", actor: SYSTEM, expectedVersion: 1 });
    expect(redelivered).toEqual(first);
    expect(await h.engine.history(TENANT_ID, wf.workflowId)).toHaveLength(2);
  });

  it("[SPEC-9.workflow] signals to a terminal workflow are rejected", async () => {
    const wf = await h.engine.start(startInput());
    await h.engine.signal({ tenantId: TENANT_ID, workflowId: wf.workflowId, event: "CANCEL", actor: { kind: "staff", ref: "stf_synthSupervisor01" } });
    await expect(h.engine.signal({ tenantId: TENANT_ID, workflowId: wf.workflowId, event: "VALIDATE", actor: SYSTEM })).rejects.toMatchObject({
      reasonCode: "WORKFLOW_TERMINAL",
    });
  });

  it("[SPEC-9.workflow] malformed signal input is rejected before touching the database", async () => {
    await expect(
      h.engine.signal({ tenantId: TENANT_ID, workflowId: "wf_short", event: "VALIDATE", actor: SYSTEM }),
    ).rejects.toMatchObject({ reasonCode: "WORKFLOW_SIGNAL_INPUT_INVALID" });
    await expect(
      h.engine.signal({ tenantId: TENANT_ID, workflowId: newId("wf"), event: "validate; drop table", actor: SYSTEM }),
    ).rejects.toMatchObject({ reasonCode: "WORKFLOW_SIGNAL_INPUT_INVALID" });
  });

  it("[ACT-04] workflow acceptance and waiting states never map to RESOLVED", async () => {
    const wf = await h.engine.start(startInput());
    const receipts = { commitReceiptIds: [newId("rcp")] };
    expect(workflowOutcome(wf.state, receipts)).toBe("REQUEST_ACCEPTED");
    const v = await h.engine.signal({ tenantId: TENANT_ID, workflowId: wf.workflowId, event: "VALIDATE", actor: SYSTEM });
    expect(workflowOutcome(v.state, receipts)).toBe("REQUEST_ACCEPTED");
    const w = await h.engine.signal({ tenantId: TENANT_ID, workflowId: wf.workflowId, event: "VALIDATION_PASSED", actor: SYSTEM });
    expect(w.state).toBe("WAITING_FOR_HUMAN");
    expect(workflowOutcome(w.state, receipts)).toBe("REQUEST_ACCEPTED");
  });
});

describe("PgWorkflowEngine: deadlines, retry budgets and escalation", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness({ recheck: allowRecheck() });
  });
  afterAll(async () => h.db.close());

  it("[SPEC-9.workflow] deadline escalation via FakeClock moves overdue work to the escalation owner and never drops it", async () => {
    h.clock.set(START);
    const wf = await h.engine.start(startInput());
    h.clock.advanceSeconds(14 * 60);
    expect((await h.engine.tick(h.clock.now())).filter((e) => e.workflowId === wf.workflowId)).toHaveLength(0);

    h.clock.advanceSeconds(2 * 60);
    const events = (await h.engine.tick(h.clock.now())).filter((e) => e.workflowId === wf.workflowId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ fromState: "ACCEPTED", toState: "WAITING_FOR_HUMAN", trigger: "ESCALATED", actor: SYSTEM });
    const escalated = await h.engine.get(TENANT_ID, wf.workflowId);
    expect(escalated).toMatchObject({ state: "WAITING_FOR_HUMAN", ownerQueue: "q_billing_supervisors" });
    const reason = await ownerQuery<{ reason_code: string }>(h.db, "select reason_code from workflow_events where workflow_id = $1 order by seq desc limit 1", [
      wf.workflowId,
    ]);
    expect(reason[0]?.reason_code).toBe("DEADLINE_EXCEEDED");
    const tasks1 = await ownerQuery<{ status: string; owner_queue: string }>(h.db, "select status, owner_queue from workflow_tasks where workflow_id = $1", [
      wf.workflowId,
    ]);
    expect(tasks1).toEqual([{ status: "OPEN", owner_queue: "q_billing_supervisors" }]);

    // Not due again until the escalated state's own deadline.
    expect((await h.engine.tick(h.clock.now())).filter((e) => e.workflowId === wf.workflowId)).toHaveLength(0);

    // The escalated human state is itself overdue after P2D: escalate again; the old task expires.
    h.clock.advanceSeconds(2 * 86400 + 1);
    const again = (await h.engine.tick(h.clock.now())).filter((e) => e.workflowId === wf.workflowId);
    expect(again).toMatchObject([{ fromState: "WAITING_FOR_HUMAN", toState: "WAITING_FOR_HUMAN", trigger: "ESCALATED" }]);
    const tasks2 = await ownerQuery<{ status: string }>(h.db, "select status from workflow_tasks where workflow_id = $1 order by created_at", [wf.workflowId]);
    expect(tasks2.map((t) => t.status)).toEqual(["EXPIRED", "OPEN"]);
    const audits = (await h.audit.all()).filter((a) => a.evidencePointers.includes(`workflow:${wf.workflowId}`) && a.action === "workflow.escalate");
    expect(audits.map((a) => a.reasonCode)).toEqual(["DEADLINE_EXCEEDED", "DEADLINE_EXCEEDED"]);
  });

  it("[SPEC-9.workflow] retry budget exhaustion escalates to the escalation owner instead of silently dropping", async () => {
    h.clock.set(START);
    const wf = await h.engine.start(startInput());
    await h.engine.signal({ tenantId: TENANT_ID, workflowId: wf.workflowId, event: "VALIDATE", actor: SYSTEM });
    for (let i = 1; i <= 3; i++) {
      const r = await h.engine.signal({ tenantId: TENANT_ID, workflowId: wf.workflowId, event: "RETRYABLE_FAILURE", actor: SYSTEM });
      expect(r).toMatchObject({ state: "VALIDATING", attempts: i, deadline: "2026-10-17T16:00:00.000Z" });
    }
    const exhausted = await h.engine.signal({ tenantId: TENANT_ID, workflowId: wf.workflowId, event: "RETRYABLE_FAILURE", actor: SYSTEM });
    expect(exhausted).toMatchObject({ state: "WAITING_FOR_HUMAN", ownerQueue: "q_billing_supervisors", attempts: 0 });
    const history = await h.engine.history(TENANT_ID, wf.workflowId);
    expect(history.map((e) => `${e.trigger}:${e.attempt}`)).toEqual([
      "WORKFLOW_ACCEPTED:0",
      "VALIDATE:0",
      "RETRYABLE_FAILURE:1",
      "RETRYABLE_FAILURE:2",
      "RETRYABLE_FAILURE:3",
      "ESCALATED:0",
    ]);
  });

  it("[SPEC-15.phase5][SPEC-9.workflow] tick reports, and keeps due, instances whose pinned definition version cannot be loaded", async () => {
    h.clock.set(START);
    const wf = await h.engine.start(startInput());
    const blind = new PgWorkflowEngine({ db: h.db, registry: new WorkflowDefinitionRegistry(), audit: h.audit, clock: h.clock });
    h.clock.advanceSeconds(20 * 60);
    const report = await blind.tickDetailed(h.clock.now());
    expect(report.failures).toContainEqual({ tenantId: TENANT_ID, workflowId: wf.workflowId, reasonCode: "DEFINITION_VERSION_UNAVAILABLE" });
    expect((await h.engine.get(TENANT_ID, wf.workflowId))?.state).toBe("ACCEPTED");
    const fixed = await h.engine.tick(h.clock.now());
    expect(fixed.some((e) => e.workflowId === wf.workflowId && e.trigger === "ESCALATED")).toBe(true);
  });

  it("[OPS-01] audit unavailability blocks start and transitions (fail closed, state unchanged)", async () => {
    h.clock.set(START);
    const wf = await h.engine.start(startInput());
    h.audit.unavailable = true;
    try {
      const correlationId = newId("cor");
      await expect(h.engine.start(startInput({ correlationId }))).rejects.toBeInstanceOf(AuditUnavailableError);
      expect(await ownerQuery(h.db, "select 1 from workflow_instances where correlation_id = $1", [correlationId])).toHaveLength(0);
      await expect(h.engine.signal({ tenantId: TENANT_ID, workflowId: wf.workflowId, event: "VALIDATE", actor: SYSTEM })).rejects.toBeInstanceOf(
        AuditUnavailableError,
      );
      expect(await h.engine.get(TENANT_ID, wf.workflowId)).toMatchObject({ state: "ACCEPTED", version: 1 });
      expect(await h.engine.history(TENANT_ID, wf.workflowId)).toHaveLength(1);
      h.clock.advanceSeconds(3600);
      const report = await h.engine.tickDetailed(h.clock.now());
      expect(report.failures.some((f) => f.workflowId === wf.workflowId && f.reasonCode === "AUDIT_FIXTURE_UNAVAILABLE")).toBe(true);
      expect((await h.engine.get(TENANT_ID, wf.workflowId))?.state).toBe("ACCEPTED");
    } finally {
      h.audit.unavailable = false;
    }
  });
});

describe("PgWorkflowEngine: tenant isolation and storage controls", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness({ recheck: allowRecheck() });
  });
  afterAll(async () => h.db.close());

  it("[AUTH-05] row-level security: another tenant cannot read, list tasks of, or signal an instance", async () => {
    const { wf } = await toHuman(h);
    expect(await h.engine.get(OTHER_TENANT_ID, wf.workflowId)).toBeNull();
    expect(await h.engine.history(OTHER_TENANT_ID, wf.workflowId)).toEqual([]);
    expect(await h.engine.openTasks(OTHER_TENANT_ID, ["support_agent", "supervisor"])).toEqual([]);
    await expect(h.engine.signal({ tenantId: OTHER_TENANT_ID, workflowId: wf.workflowId, event: "CANCEL", actor: SYSTEM })).rejects.toMatchObject({
      reasonCode: "WORKFLOW_NOT_FOUND",
    });
    const raw = await h.db.tx((tx) => tx.query("select workflow_id from workflow_instances where workflow_id = $1", [wf.workflowId]), {
      rls: { tenantId: OTHER_TENANT_ID },
    });
    expect(raw.rows).toHaveLength(0);
  });

  it("[OPS-01] workflow events are append-only for runtime roles and for the owner", async () => {
    const wf = await h.engine.start(startInput());
    await expect(
      h.db.tx((tx) => tx.query("update workflow_events set trigger = 'TAMPERED' where workflow_id = $1", [wf.workflowId]), { rls: { tenantId: TENANT_ID } }),
    ).rejects.toThrow();
    await expect(
      h.db.tx((tx) => tx.query("delete from workflow_events where workflow_id = $1", [wf.workflowId]), { rls: { tenantId: TENANT_ID } }),
    ).rejects.toThrow();
    await expect(h.db.tx((tx) => tx.query("delete from workflow_events where workflow_id = $1", [wf.workflowId]), { role: "owner" })).rejects.toThrow(
      /WORKFLOW_EVENTS_APPEND_ONLY/,
    );
    expect(await h.engine.history(TENANT_ID, wf.workflowId)).toHaveLength(1);
  });

  it("[SPEC-15.phase5] runtime roles cannot change an instance's pinned definition version", async () => {
    const wf = await h.engine.start(startInput());
    await expect(
      h.db.tx((tx) => tx.query("update workflow_instances set definition_version = '9.9.9' where workflow_id = $1", [wf.workflowId]), {
        rls: { tenantId: TENANT_ID },
      }),
    ).rejects.toThrow();
    expect((await h.engine.get(TENANT_ID, wf.workflowId))?.definitionVersion).toBe("1.0.0");
  });

  it("[OPS-04] the engine labels itself a local fixture when running on embedded PGlite", () => {
    expect(h.engine.kind).toBe("local_fixture");
  });

  it("[DATA-01] workflow tables contain no free-text columns", async () => {
    const cols = await ownerQuery<{ table_name: string; column_name: string }>(
      h.db,
      `select table_name, column_name from information_schema.columns
       where table_name in ('workflow_instances','workflow_events','workflow_tasks') order by table_name, column_name`,
    );
    const names = cols.map((c) => c.column_name);
    for (const banned of ["name", "summary", "notes", "description", "payload", "transcript", "phone", "email", "dob", "task_token", "token"]) {
      expect(names).not.toContain(banned);
    }
    expect(names).toContain("token_hash");
  });
});

describe("PgWorkflowEngine: human tasks and scoped task tokens", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness({ recheck: allowRecheck() });
  });
  afterAll(async () => h.db.close());

  it("[SPEC-9.human-task] a human-task state opens a task requiring the mapped staff roles (billing specialist -> supervisor/support_agent)", async () => {
    h.clock.set(START);
    const { wf, task } = await toHuman(h);
    expect(task).toMatchObject({ workflowId: wf.workflowId, taskType: "billing_dispute_decision", status: "OPEN" });
    expect([...task.requiredStaffRoles].sort()).toEqual(["supervisor", "support_agent"]);
    expect((await h.engine.openTasks(TENANT_ID, ["auditor"])).some((t) => t.taskId === task.taskId)).toBe(false);
    expect((await h.engine.openTasks(TENANT_ID, ["support_agent"])).some((t) => t.taskId === task.taskId)).toBe(true);
  });

  it("[SPEC-9.human-task] issuing a token returns the plaintext once, stores only its SHA-256, and never records it in events, audit or logs", async () => {
    h.clock.set(START);
    const { wf, task } = await toHuman(h);
    const issued = await h.engine.issueTaskToken({ tenantId: TENANT_ID, taskId: task.taskId, staff: staffActor("agent") });
    expect(issued.taskToken).toMatch(/^wtt_[A-Za-z0-9_-]{43}$/);
    expect(issued.tokenExpiresAt).toBe("2026-10-17T15:15:00.000Z");
    const stored = await ownerQuery<{ token_hash: string }>(h.db, "select token_hash from workflow_tasks where task_id = $1", [task.taskId]);
    expect(stored[0]?.token_hash).toBe(sha256Hex(issued.taskToken));

    const done = await h.engine.completeHumanTask({ tenantId: TENANT_ID, taskId: task.taskId, taskToken: issued.taskToken, decision: "APPROVE", staff: staffActor("agent") });
    expect(done.state).toBe("READY_TO_COMMIT");

    const dumps = await ownerQuery<{ d: string }>(
      h.db,
      `select (select coalesce(json_agg(t), '[]')::text from workflow_tasks t) ||
              (select coalesce(json_agg(e), '[]')::text from workflow_events e) ||
              (select coalesce(json_agg(i), '[]')::text from workflow_instances i) as d`,
    );
    expect(dumps[0]?.d).not.toContain(issued.taskToken);
    expect(await h.audit.rawDump()).not.toContain(issued.taskToken);
    expect(JSON.stringify(h.logs)).not.toContain(issued.taskToken);
    const events = await h.engine.history(TENANT_ID, wf.workflowId);
    expect(JSON.stringify(events)).not.toContain(issued.taskToken);
    expect(events.at(-1)).toMatchObject({ trigger: "HUMAN_APPROVED", actor: { kind: "staff", ref: "stf_synthSupportAgent1" } });
    // Single use: the digest itself is erased on completion.
    const after = await ownerQuery<{ token_hash: string | null; completed_by: string }>(h.db, "select token_hash, completed_by from workflow_tasks where task_id = $1", [
      task.taskId,
    ]);
    expect(after[0]).toEqual({ token_hash: null, completed_by: "stf_synthSupportAgent1" });
  });

  it("[SPEC-9.human-task] a wrong or malformed token is rejected", async () => {
    h.clock.set(START);
    const { task } = await toHuman(h);
    await h.engine.issueTaskToken({ tenantId: TENANT_ID, taskId: task.taskId, staff: staffActor("agent") });
    const forged = `wtt_${"A".repeat(43)}`;
    await expect(
      h.engine.completeHumanTask({ tenantId: TENANT_ID, taskId: task.taskId, taskToken: forged, decision: "APPROVE", staff: staffActor("agent") }),
    ).rejects.toMatchObject({ reasonCode: "TASK_TOKEN_INVALID" });
    await expect(
      h.engine.completeHumanTask({ tenantId: TENANT_ID, taskId: task.taskId, taskToken: "approve-please", decision: "APPROVE", staff: staffActor("agent") }),
    ).rejects.toMatchObject({ reasonCode: "TASK_TOKEN_INVALID" });
  });

  it("[SPEC-9.human-task] a token for a task that was never issued is rejected", async () => {
    h.clock.set(START);
    const { task } = await toHuman(h);
    await expect(
      h.engine.completeHumanTask({ tenantId: TENANT_ID, taskId: task.taskId, taskToken: `wtt_${"B".repeat(43)}`, decision: "REJECT", staff: staffActor("agent") }),
    ).rejects.toMatchObject({ reasonCode: "TASK_TOKEN_NOT_ISSUED" });
  });

  it("[SPEC-9.human-task] an expired token is rejected", async () => {
    h.clock.set(START);
    const { task } = await toHuman(h);
    const issued = await h.engine.issueTaskToken({ tenantId: TENANT_ID, taskId: task.taskId, staff: staffActor("agent") });
    h.clock.advanceSeconds(16 * 60);
    await expect(
      h.engine.completeHumanTask({ tenantId: TENANT_ID, taskId: task.taskId, taskToken: issued.taskToken, decision: "APPROVE", staff: staffActor("agent") }),
    ).rejects.toMatchObject({ reasonCode: "TASK_TOKEN_EXPIRED" });
  });

  it("[SPEC-9.human-task] an expired task is rejected even with a fresh token", async () => {
    h.clock.set(START);
    const { task } = await toHuman(h);
    h.clock.advanceSeconds(2 * 86400 - 60);
    const issued = await h.engine.issueTaskToken({ tenantId: TENANT_ID, taskId: task.taskId, staff: staffActor("agent") });
    expect(issued.tokenExpiresAt).toBe(task.expiresAt); // bounded by the task's own expiry
    h.clock.advanceSeconds(61);
    await expect(
      h.engine.completeHumanTask({ tenantId: TENANT_ID, taskId: task.taskId, taskToken: issued.taskToken, decision: "APPROVE", staff: staffActor("agent") }),
    ).rejects.toMatchObject({ reasonCode: "TASK_EXPIRED" });
    await expect(h.engine.issueTaskToken({ tenantId: TENANT_ID, taskId: task.taskId, staff: staffActor("agent") })).rejects.toMatchObject({
      reasonCode: "TASK_EXPIRED",
    });
  });

  it("[SPEC-9.human-task] a used token cannot be reused (single use)", async () => {
    h.clock.set(START);
    const { task } = await toHuman(h);
    const issued = await h.engine.issueTaskToken({ tenantId: TENANT_ID, taskId: task.taskId, staff: staffActor("supervisor") });
    await h.engine.completeHumanTask({ tenantId: TENANT_ID, taskId: task.taskId, taskToken: issued.taskToken, decision: "REJECT", staff: staffActor("supervisor") });
    await expect(
      h.engine.completeHumanTask({ tenantId: TENANT_ID, taskId: task.taskId, taskToken: issued.taskToken, decision: "REJECT", staff: staffActor("supervisor") }),
    ).rejects.toMatchObject({ reasonCode: "TASK_NOT_OPEN" });
  });

  it("[SPEC-9.human-task] re-issuing rotates the token and invalidates the previous one", async () => {
    h.clock.set(START);
    const { task } = await toHuman(h);
    const first = await h.engine.issueTaskToken({ tenantId: TENANT_ID, taskId: task.taskId, staff: staffActor("agent") });
    const second = await h.engine.issueTaskToken({ tenantId: TENANT_ID, taskId: task.taskId, staff: staffActor("agent") });
    expect(second.taskToken).not.toBe(first.taskToken);
    await expect(
      h.engine.completeHumanTask({ tenantId: TENANT_ID, taskId: task.taskId, taskToken: first.taskToken, decision: "APPROVE", staff: staffActor("agent") }),
    ).rejects.toMatchObject({ reasonCode: "TASK_TOKEN_INVALID" });
  });

  it("[SPEC-9.human-task][AUTH-02] staff without a required role are rejected, and authority is re-validated at completion", async () => {
    h.clock.set(START);
    const { task } = await toHuman(h);
    await expect(h.engine.issueTaskToken({ tenantId: TENANT_ID, taskId: task.taskId, staff: staffActor("auditor") })).rejects.toMatchObject({
      reasonCode: "STAFF_ROLE_NOT_PERMITTED",
    });
    const issued = await h.engine.issueTaskToken({ tenantId: TENANT_ID, taskId: task.taskId, staff: staffActor("agent") });
    // The agent's role is revoked after issuance; the stale token no longer carries authority.
    await expect(
      h.engine.completeHumanTask({
        tenantId: TENANT_ID,
        taskId: task.taskId,
        taskToken: issued.taskToken,
        decision: "APPROVE",
        staff: staffActor("agent", { roles: ["auditor"] }),
      }),
    ).rejects.toMatchObject({ reasonCode: "STAFF_ROLE_NOT_PERMITTED" });
    expect((await h.engine.openTasks(TENANT_ID, ["support_agent"])).some((t) => t.taskId === task.taskId)).toBe(true);
  });

  it("[SPEC-9.human-task] staff without MFA are rejected", async () => {
    h.clock.set(START);
    const { task } = await toHuman(h);
    await expect(
      h.engine.issueTaskToken({ tenantId: TENANT_ID, taskId: task.taskId, staff: staffActor("agent", { mfa: false }) }),
    ).rejects.toMatchObject({ reasonCode: "STAFF_MFA_REQUIRED" });
    const issued = await h.engine.issueTaskToken({ tenantId: TENANT_ID, taskId: task.taskId, staff: staffActor("agent") });
    await expect(
      h.engine.completeHumanTask({
        tenantId: TENANT_ID,
        taskId: task.taskId,
        taskToken: issued.taskToken,
        decision: "APPROVE",
        staff: staffActor("agent", { mfa: false }),
      }),
    ).rejects.toMatchObject({ reasonCode: "STAFF_MFA_REQUIRED" });
  });

  it("[SPEC-9.human-task] an expired break-glass grant is rejected", async () => {
    h.clock.set(START);
    const { task } = await toHuman(h);
    const issued = await h.engine.issueTaskToken({ tenantId: TENANT_ID, taskId: task.taskId, staff: staffActor("supervisor") });
    const expiredBreakGlass = { reason: "synthetic incident drill access", expiresAt: "2026-10-17T14:30:00.000Z", approvedBy: "stf_synthSecurityAdm1" };
    await expect(
      h.engine.completeHumanTask({
        tenantId: TENANT_ID,
        taskId: task.taskId,
        taskToken: issued.taskToken,
        decision: "APPROVE",
        staff: staffActor("supervisor", { breakGlass: expiredBreakGlass }),
      }),
    ).rejects.toMatchObject({ reasonCode: "BREAK_GLASS_EXPIRED" });
  });

  it("[SPEC-9.human-task] a token issued to one staff member cannot be used by another", async () => {
    h.clock.set(START);
    const { task } = await toHuman(h);
    const issued = await h.engine.issueTaskToken({ tenantId: TENANT_ID, taskId: task.taskId, staff: staffActor("agent") });
    await expect(
      h.engine.completeHumanTask({ tenantId: TENANT_ID, taskId: task.taskId, taskToken: issued.taskToken, decision: "APPROVE", staff: staffActor("supervisor") }),
    ).rejects.toMatchObject({ reasonCode: "TASK_TOKEN_NOT_ISSUED_TO_ACTOR" });
  });

  it("[SPEC-9.human-task] a model or caller cannot complete a task by signalling an approval event", async () => {
    h.clock.set(START);
    const { wf, task } = await toHuman(h);
    for (const event of ["HUMAN_APPROVED", "HUMAN_REJECTED", "POLICY_CHANGED_PENDING_ACTION"]) {
      await expect(
        h.engine.signal({ tenantId: TENANT_ID, workflowId: wf.workflowId, event, actor: { kind: "caller", ref: null } }),
      ).rejects.toMatchObject({ reasonCode: "EVENT_RESERVED_FOR_ENGINE" });
    }
    expect((await h.engine.get(TENANT_ID, wf.workflowId))?.state).toBe("WAITING_FOR_HUMAN");
    expect((await h.engine.openTasks(TENANT_ID, ["support_agent"])).some((t) => t.taskId === task.taskId)).toBe(true);
    const denials = (await h.audit.all()).filter((a) => a.action === "workflow.signal.denied" && a.evidencePointers.includes(`workflow:${wf.workflowId}`));
    expect(denials).toHaveLength(3);
    expect(denials.every((d) => d.outcome === "DENIED" && d.reasonCode === "EVENT_RESERVED_FOR_ENGINE")).toBe(true);
  });

  it("[SPEC-9.human-task] denied completion attempts are audited with reason codes and without the presented token", async () => {
    h.clock.set(START);
    const { task } = await toHuman(h);
    const presented = `wtt_${"C".repeat(43)}`;
    await h.engine.issueTaskToken({ tenantId: TENANT_ID, taskId: task.taskId, staff: staffActor("agent") });
    await expect(
      h.engine.completeHumanTask({ tenantId: TENANT_ID, taskId: task.taskId, taskToken: presented, decision: "APPROVE", staff: staffActor("agent") }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    const denied = (await h.audit.all()).filter((a) => a.action === "workflow.human_task.denied" && a.evidencePointers.includes(`workflow_task:${task.taskId}`));
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ outcome: "DENIED", reasonCode: "TASK_TOKEN_INVALID", dataClass: "SECURITY_AUDIT" });
    expect(await h.audit.rawDump()).not.toContain(presented);
  });

  it("[SPEC-9.human-task] leaving the human state cancels its open task and erases the token digest", async () => {
    h.clock.set(START);
    const { wf, task } = await toHuman(h);
    const issued = await h.engine.issueTaskToken({ tenantId: TENANT_ID, taskId: task.taskId, staff: staffActor("agent") });
    await h.engine.signal({ tenantId: TENANT_ID, workflowId: wf.workflowId, event: "CANCEL", actor: { kind: "staff", ref: "stf_synthSupervisor01" } });
    const rows = await ownerQuery<{ status: string; token_hash: string | null }>(h.db, "select status, token_hash from workflow_tasks where task_id = $1", [task.taskId]);
    expect(rows[0]).toEqual({ status: "CANCELLED", token_hash: null });
    await expect(
      h.engine.completeHumanTask({ tenantId: TENANT_ID, taskId: task.taskId, taskToken: issued.taskToken, decision: "APPROVE", staff: staffActor("agent") }),
    ).rejects.toMatchObject({ reasonCode: "TASK_NOT_OPEN" });
  });

  it("[SPEC-9.human-task][AUTH-05] a task cannot be completed through another tenant's context", async () => {
    h.clock.set(START);
    const { task } = await toHuman(h);
    const issued = await h.engine.issueTaskToken({ tenantId: TENANT_ID, taskId: task.taskId, staff: staffActor("agent") });
    await expect(
      h.engine.completeHumanTask({ tenantId: OTHER_TENANT_ID, taskId: task.taskId, taskToken: issued.taskToken, decision: "APPROVE", staff: staffActor("agent") }),
    ).rejects.toMatchObject({ reasonCode: "TASK_NOT_FOUND" });
  });
});

describe("PgWorkflowEngine: pre-disclosure / material-change recheck", () => {
  async function toReadyToCommit(h: Harness, overrides: Partial<WorkflowStartInput> = {}) {
    const { wf, task } = await toHuman(h, overrides);
    const issued = await h.engine.issueTaskToken({ tenantId: TENANT_ID, taskId: task.taskId, staff: staffActor("agent") });
    const ready = await h.engine.completeHumanTask({ tenantId: TENANT_ID, taskId: task.taskId, taskToken: issued.taskToken, decision: "APPROVE", staff: staffActor("agent") });
    expect(ready.state).toBe("READY_TO_COMMIT");
    return wf;
  }

  it("[SPEC-9.recheck] a guarded material change runs the recheck with the current context and proceeds when allowed", async () => {
    const recheck = allowRecheck();
    const h = await harness({ recheck });
    try {
      const grantRef = newId("grt");
      const wf = await toReadyToCommit(h, { grantRef, policySnapshotVersion: "pol-2026.10.1" });
      const committed = await h.engine.signal({ tenantId: TENANT_ID, workflowId: wf.workflowId, event: "COMMIT", actor: SYSTEM });
      expect(committed.state).toBe("WAITING_FOR_SYSTEM");
      expect(recheck.calls).toHaveLength(1);
      expect(recheck.calls[0]).toMatchObject({
        guard: "material_change",
        fromState: "READY_TO_COMMIT",
        toState: "WAITING_FOR_SYSTEM",
        event: "COMMIT",
        grantRef,
        policySnapshotVersion: "pol-2026.10.1",
        now: START,
      });
      const done = await h.engine.signal({ tenantId: TENANT_ID, workflowId: wf.workflowId, event: "SYSTEM_CONFIRMED", actor: { kind: "external_system", ref: null } });
      expect(done.state).toBe("COMPLETED");
      expect(recheck.calls.map((c) => c.guard)).toEqual(["material_change", "disclosure"]);
      expect(workflowOutcome(done.state, { commitReceiptIds: [] })).toBe("OUTCOME_UNKNOWN");
      expect(workflowOutcome(done.state, { commitReceiptIds: [newId("rcp")] })).toBe("RESOLVED");
    } finally {
      await h.db.close();
    }
  });

  it("[SPEC-9.recheck] a denied recheck records POLICY_CHANGED_PENDING_ACTION and blocks the change", async () => {
    const h = await harness({ recheck: new RecheckFixture(() => ({ allow: false, reasonCode: "CONSENT_REVOKED", policyVersion: "pol-2026.10.2" })) });
    try {
      const wf = await toReadyToCommit(h);
      const err = await h.engine.signal({ tenantId: TENANT_ID, workflowId: wf.workflowId, event: "COMMIT", actor: SYSTEM }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WorkflowRecheckDeniedError);
      expect((err as WorkflowRecheckDeniedError).reasonCode).toBe("CONSENT_REVOKED");
      expect((err as WorkflowRecheckDeniedError).instance.state).toBe("WAITING_FOR_HUMAN");
      const inst = await h.engine.get(TENANT_ID, wf.workflowId);
      expect(inst?.state).toBe("WAITING_FOR_HUMAN");
      const last = (await h.engine.history(TENANT_ID, wf.workflowId)).at(-1);
      expect(last).toMatchObject({ fromState: "READY_TO_COMMIT", toState: "WAITING_FOR_HUMAN", trigger: "POLICY_CHANGED_PENDING_ACTION" });
      const audits = (await h.audit.all()).filter((a) => a.evidencePointers.includes(`workflow:${wf.workflowId}`));
      expect(audits.find((a) => a.action === "workflow.recheck.denied")).toMatchObject({ outcome: "DENIED", reasonCode: "CONSENT_REVOKED" });
      expect(audits.find((a) => a.action === "workflow.policy_changed_pending_action")).toMatchObject({ reasonCode: "CONSENT_REVOKED" });
      // The pending action goes back to a human with a fresh task.
      expect((await h.engine.openTasks(TENANT_ID, ["supervisor"])).some((t) => t.workflowId === wf.workflowId)).toBe(true);
    } finally {
      await h.db.close();
    }
  });

  it("[SPEC-9.recheck] an unavailable or malformed recheck fails closed without any transition", async () => {
    let mode: "throw" | "malformed" = "throw";
    const recheck: PreDisclosureRecheck = {
      kind: "local_fixture",
      async recheck() {
        if (mode === "throw") throw new Error("policy service timeout");
        return { allow: "yes" } as unknown as { allow: true };
      },
    };
    const h = await harness({ recheck });
    try {
      const wf = await toReadyToCommit(h);
      await expect(h.engine.signal({ tenantId: TENANT_ID, workflowId: wf.workflowId, event: "COMMIT", actor: SYSTEM })).rejects.toMatchObject({
        reasonCode: "RECHECK_UNAVAILABLE",
      });
      mode = "malformed";
      await expect(h.engine.signal({ tenantId: TENANT_ID, workflowId: wf.workflowId, event: "COMMIT", actor: SYSTEM })).rejects.toBeInstanceOf(DependencyError);
      expect((await h.engine.get(TENANT_ID, wf.workflowId))?.state).toBe("READY_TO_COMMIT");
      expect((await h.engine.history(TENANT_ID, wf.workflowId)).some((e) => e.trigger === "POLICY_CHANGED_PENDING_ACTION")).toBe(false);
    } finally {
      await h.db.close();
    }
  });

  it("[SPEC-9.recheck] with no recheck wired, guarded transitions are refused (fail closed)", async () => {
    const h = await harness({});
    try {
      // HUMAN_APPROVED is not guarded in billing_dispute_review; COMMIT is.
      const wf = await toReadyToCommit(h);
      await expect(h.engine.signal({ tenantId: TENANT_ID, workflowId: wf.workflowId, event: "COMMIT", actor: SYSTEM })).rejects.toMatchObject({
        reasonCode: "RECHECK_NOT_CONFIGURED",
      });
      expect((await h.engine.get(TENANT_ID, wf.workflowId))?.state).toBe("READY_TO_COMMIT");
    } finally {
      await h.db.close();
    }
  });

  it("[SPEC-9.recheck] a guarded transition without a durable action grant is denied and recorded", async () => {
    const recheck = allowRecheck();
    const h = await harness({ recheck });
    try {
      const wf = await toReadyToCommit(h, { grantRef: null });
      await expect(h.engine.signal({ tenantId: TENANT_ID, workflowId: wf.workflowId, event: "COMMIT", actor: SYSTEM })).rejects.toMatchObject({
        reasonCode: "DURABLE_GRANT_MISSING",
      });
      expect(recheck.calls).toHaveLength(0);
      expect((await h.engine.history(TENANT_ID, wf.workflowId)).at(-1)?.trigger).toBe("POLICY_CHANGED_PENDING_ACTION");
    } finally {
      await h.db.close();
    }
  });

  it("[SPEC-9.recheck] a newer policy version that still allows is recorded as POLICY_VERSION_CHANGED evidence", async () => {
    const h = await harness({ recheck: new RecheckFixture(() => ({ allow: true, policyVersion: "pol-2026.10.2", decisionId: newId("dec") })) });
    try {
      const wf = await toReadyToCommit(h, { policySnapshotVersion: "pol-2026.10.1" });
      await h.engine.signal({ tenantId: TENANT_ID, workflowId: wf.workflowId, event: "COMMIT", actor: SYSTEM });
      const allowed = (await h.audit.all()).find((a) => a.action === "workflow.recheck.allowed" && a.evidencePointers.includes(`workflow:${wf.workflowId}`));
      expect(allowed).toMatchObject({ outcome: "ALLOWED", reasonCode: "POLICY_VERSION_CHANGED" });
      expect(allowed?.policyDecision).toMatchObject({ allow: true, policyVersion: "pol-2026.10.2" });
    } finally {
      await h.db.close();
    }
  });

  it("[SPEC-9.recheck] a revoked consent cancels a pending callback before outreach", async () => {
    const h = await harness({ recheck: new RecheckFixture((ctx) => (ctx.guard === "disclosure" ? { allow: false, reasonCode: "CONSENT_REVOKED" } : { allow: true })) });
    try {
      const wf = await h.engine.start(startInput({ type: "callback_request" }));
      await h.engine.signal({ tenantId: TENANT_ID, workflowId: wf.workflowId, event: "VALIDATE", actor: SYSTEM });
      await expect(
        h.engine.signal({ tenantId: TENANT_ID, workflowId: wf.workflowId, event: "CONSENT_CONFIRMED", actor: SYSTEM }),
      ).rejects.toBeInstanceOf(WorkflowRecheckDeniedError);
      expect((await h.engine.get(TENANT_ID, wf.workflowId))?.state).toBe("CANCELLED");
      expect((await h.engine.openTasks(TENANT_ID, ["support_agent"])).some((t) => t.workflowId === wf.workflowId)).toBe(false);
    } finally {
      await h.db.close();
    }
  });
});

describe("PgWorkflowEngine: definition version compatibility", () => {
  function billingV110(): VersionedWorkflowDefinition {
    const v = structuredClone(billingDisputeReviewV1) as VersionedWorkflowDefinition;
    v.version = "1.1.0";
    const accepted = v.states.ACCEPTED;
    const validating = v.states.VALIDATING;
    if (!accepted || !validating) throw new Error("fixture definition incomplete");
    accepted.deadline = "PT30M";
    delete validating.transitions.NEEDS_CALLER_INFO;
    return v;
  }

  it("[SPEC-15.phase5] an in-flight instance keeps its pinned definition version after a new version registers", async () => {
    const registry = createDefaultRegistry();
    const h = await harness({ recheck: allowRecheck(), registry });
    try {
      const old = await h.engine.start(startInput());
      await h.engine.signal({ tenantId: TENANT_ID, workflowId: old.workflowId, event: "VALIDATE", actor: SYSTEM });
      registry.register(billingV110());
      expect(registry.versions("billing_dispute_review")).toEqual(["1.0.0", "1.1.0"]);

      const fresh = await h.engine.start(startInput());
      expect(fresh).toMatchObject({ definitionVersion: "1.1.0", deadline: "2026-10-17T15:30:00.000Z" });
      await h.engine.signal({ tenantId: TENANT_ID, workflowId: fresh.workflowId, event: "VALIDATE", actor: SYSTEM });
      await expect(
        h.engine.signal({ tenantId: TENANT_ID, workflowId: fresh.workflowId, event: "NEEDS_CALLER_INFO", actor: SYSTEM }),
      ).rejects.toMatchObject({ reasonCode: "TRANSITION_NOT_ALLOWED" });

      // The in-flight 1.0.0 instance still follows 1.0.0 transitions.
      const stillOld = await h.engine.signal({ tenantId: TENANT_ID, workflowId: old.workflowId, event: "NEEDS_CALLER_INFO", actor: SYSTEM });
      expect(stillOld).toMatchObject({ definitionVersion: "1.0.0", state: "WAITING_FOR_CALLER" });
      expect((await h.engine.history(TENANT_ID, old.workflowId)).every((e) => e.definitionVersion === "1.0.0")).toBe(true);

      // An explicit pin to the older version remains possible for a controlled rollback.
      const pinned = await h.engine.start(startInput({ definitionVersion: "1.0.0" }));
      expect(pinned.definitionVersion).toBe("1.0.0");
    } finally {
      await h.db.close();
    }
  });

  it("[SPEC-15.phase5] a registered version is immutable; identical re-registration is a no-op", () => {
    const registry = createDefaultRegistry();
    expect(() => registry.register(billingDisputeReviewV1)).not.toThrow();
    const tampered = structuredClone(billingDisputeReviewV1) as VersionedWorkflowDefinition;
    const accepted = tampered.states.ACCEPTED;
    if (!accepted) throw new Error("fixture definition incomplete");
    accepted.deadline = "PT20M";
    expect(() => registry.register(tampered)).toThrow(ConflictError);
    expect(registry.get("billing_dispute_review", "1.0.0")?.states.ACCEPTED?.deadline).toBe("PT15M");
    // Registered definitions are frozen copies.
    const got = registry.get("billing_dispute_review", "1.0.0");
    expect(Object.isFrozen(got?.states.ACCEPTED?.transitions)).toBe(true);
  });
});
