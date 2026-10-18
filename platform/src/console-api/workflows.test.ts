import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STAFF, TENANT_ID } from "../fixtures/synthetic-world.js";
import { createConsoleHarness, seedHumanTask } from "./fixtures/harness.fixture.js";
import type { ConsoleHarness } from "./fixtures/harness.fixture.js";

let h: ConsoleHarness;
/** Every plaintext task token minted during the test (captured server-side to prove it never leaves). */
const minted: string[] = [];

beforeAll(async () => {
  h = await createConsoleHarness({
    patchDeps: (d) => ({
      ...d,
      workflows: {
        openTasks: (t, r) => d.workflows.openTasks(t, r),
        get: (t, w) => d.workflows.get(t, w),
        completeHumanTask: (i) => d.workflows.completeHumanTask(i),
        issueTaskToken: async (i) => {
          const issued = await d.workflows.issueTaskToken(i);
          minted.push(issued.taskToken);
          return issued;
        },
      },
    }),
  });
});
afterAll(async () => {
  await h.close();
});

const errorOf = (body: string): { reasonCode: string } => (JSON.parse(body) as { error: { reasonCode: string } }).error;

describe("workflow human tasks through the console (spec section 9)", () => {
  it("[SPEC-9.workflow-token] the task list is filtered to the caller's roles and carries no task token", async () => {
    const billing = await seedHumanTask(h, "billing_dispute_review");
    const complaint = await seedHumanTask(h, "complaint_review");
    const agent = JSON.parse((await h.call("workflows.tasks", { token: await h.token("agent") })).body) as { tasks: { taskId: string; requiredStaffRoles: string[]; workflowType: string; ownerQueue: string }[] };
    expect(agent.tasks.map((t) => t.taskId)).toEqual([billing.taskId]);
    expect(agent.tasks[0]).toMatchObject({ workflowType: "billing_dispute_review", requiredStaffRoles: ["supervisor", "support_agent"], ownerQueue: "q_billing_specialists" });
    const sup = JSON.parse((await h.call("workflows.tasks", { token: await h.token("supervisor") })).body) as { tasks: { taskId: string }[] };
    expect(sup.tasks.map((t) => t.taskId).sort()).toEqual([billing.taskId, complaint.taskId].sort());
    expect(JSON.stringify(sup)).not.toMatch(/token/i);
  });

  it("[SPEC-9.workflow-token] a decision never exposes the task token: it is minted and consumed server-side; the reason is required and audited", async () => {
    const { taskId, instance } = await seedHumanTask(h, "billing_dispute_review");
    const token = await h.token("agent");
    const noReason = await h.call("workflows.decision", { token, params: { taskId }, body: { decision: "APPROVE" } });
    expect(noReason.statusCode).toBe(400);
    const wrongReason = await h.call("workflows.decision", { token, params: { taskId }, body: { decision: "APPROVE", reason: "EVIDENCE_INSUFFICIENT" } });
    expect(errorOf(wrongReason.body).reasonCode).toBe("REASON_NOT_ALLOWED");
    expect(minted).toHaveLength(0);

    const r = await h.call("workflows.decision", { token, params: { taskId }, body: { decision: "APPROVE", reason: "EVIDENCE_VERIFIED" } });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body) as { taskId: string; workflowId: string; decision: string; workflowState: string; auditEventId: string };
    expect(body).toMatchObject({ taskId, workflowId: instance.workflowId, decision: "APPROVE", workflowState: "READY_TO_COMMIT" });
    expect(Object.keys(body).sort()).toEqual(["auditEventId", "decision", "taskId", "workflowId", "workflowState"]);

    expect(minted).toHaveLength(1);
    const plaintext = minted[0] as string;
    expect(r.body).not.toContain(plaintext);
    expect(JSON.stringify(r.headers)).not.toContain(plaintext);
    const audit = await h.db.query<{ event: unknown }>("select event from audit_outbox");
    expect(JSON.stringify(audit.rows)).not.toContain(plaintext);
    expect(JSON.stringify(h.logs)).not.toContain(plaintext);
    const stored = await h.db.query<{ token_hash: string | null; status: string; completed_by: string }>("select token_hash, status, completed_by from workflow_tasks where task_id = $1", [taskId]);
    expect(stored.rows[0]).toMatchObject({ token_hash: null, status: "COMPLETED", completed_by: STAFF.agent.staffId });

    // The engine's completion event (same transaction as the transition) is returned; the console intent records the reason.
    const ev = await h.db.query<{ action: string; actor: string }>("select action, event->>'actorRef' as actor from audit_outbox where event_id = $1", [body.auditEventId]);
    expect(ev.rows[0]).toEqual({ action: "workflow.human_task.complete", actor: STAFF.agent.staffId });
    const intent = await h.db.query<{ reason: string }>("select event->>'reasonCode' as reason from audit_outbox where action = 'console.workflows.decision' and outcome = 'PENDING'");
    expect(intent.rows.map((x) => x.reason)).toContain("EVIDENCE_VERIFIED");

    const again = await h.call("workflows.decision", { token, params: { taskId }, body: { decision: "APPROVE", reason: "EVIDENCE_VERIFIED" } });
    expect(again.statusCode).toBe(404);
  });

  it("[SPEC-7.staff-separation] a workflow decision requires one of the task's required roles (complaint review: supervisor only)", async () => {
    const { taskId } = await seedHumanTask(h, "complaint_review");
    const agent = await h.call("workflows.decision", { token: await h.token("agent"), params: { taskId }, body: { decision: "REJECT", reason: "OUT_OF_POLICY" } });
    expect(agent.statusCode).toBe(403);
    expect(errorOf(agent.body).reasonCode).toBe("STAFF_ROLE_NOT_PERMITTED");
    const open = await h.workflows.openTasks(TENANT_ID, ["supervisor"]);
    expect(open.some((t) => t.taskId === taskId)).toBe(true);
    const sup = await h.call("workflows.decision", { token: await h.token("supervisor"), params: { taskId }, body: { decision: "REJECT", reason: "NEEDS_SPECIALIST_REVIEW" } });
    expect(sup.statusCode, sup.body).toBe(200);
    expect(JSON.parse(sup.body)).toMatchObject({ decision: "REJECT", workflowState: "VALIDATING" });
  });
});
