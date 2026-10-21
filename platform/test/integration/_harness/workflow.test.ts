/**
 * Layer 2, FO-16-16 (workflow half): the generated STANDARD state machine
 * (infra/stepfunctions/callback_request.asl.json, rendered exactly as Terraform's templatefile()
 * renders it, with AWS-format queue URLs) runs on Step Functions Local. Task tokens travel through the
 * SQS service integration (.waitForTaskToken) to ElasticMQ; the test acts as the workflow worker with
 * SendTaskSuccess / SendTaskFailure. Covers routing by actor kind, the escalation path, Catch
 * semantics and redelivered task messages (a token advances the execution at most once).
 * This records the task-token callback fidelity asked for by ADR-0018 open item 5.
 *
 * The placeholders are rendered with the emulator's queue URLs (http://elasticmq:9324/...), the way
 * Terraform renders them with each environment's real URLs: Step Functions Local sends to the host
 * named in QueueUrl (its SQS_ENDPOINT does not redirect AWS-format URLs), so an AWS-format URL would
 * make the emulator try the public SQS endpoint.
 */
import { CreateStateMachineCommand, DescribeExecutionCommand, GetExecutionHistoryCommand, SendTaskFailureCommand, SendTaskSuccessCommand, StartExecutionCommand, StopExecutionCommand } from "@aws-sdk/client-sfn";
import type { HistoryEvent, SFNClient } from "@aws-sdk/client-sfn";
import { CreateQueueCommand, DeleteMessageCommand, ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import type { Message, SQSClient } from "@aws-sdk/client-sqs";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect } from "vitest";
import { newId } from "../../../src/shared/ids.js";
import { sfnClient, sqsClient, SYNTHETIC_ACCOUNT, uniqueName } from "./clients.js";
import { REPO_ROOT } from "./env.js";
import { layer2, layer2Context } from "./layer2.js";

const it = layer2(["stepfunctions", "elasticmq"]);
const ASL_DIR = join(REPO_ROOT, "infra", "stepfunctions");
const QUEUES = ["system", "human", "notify", "escalation", "recheck"] as const;
type QueueRole = (typeof QUEUES)[number];
/** Keys a task message may carry: opaque ids and codes only (no PHI rides the workflow transport). */
const ALLOWED_BODY_KEYS = new Set(["workflowId", "tenantId", "workflowType", "definitionVersion", "state", "ownerQueue", "taskToken", "event", "toState", "guard", "grantAction", "escalationOwnerQueue", "cause"]);

let sfn: SFNClient;
let sqs: SQSClient;
let stateMachineArn: string;
const queueUrl = {} as Record<QueueRole, string>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface TaskMessage {
  body: Record<string, string>;
  message: Message;
}

async function nextMessage(role: QueueRole, opts: { del?: boolean; visibility?: number; timeoutMs?: number } = {}): Promise<TaskMessage> {
  const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
  while (Date.now() < deadline) {
    const r = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl[role], MaxNumberOfMessages: 1, WaitTimeSeconds: 1, VisibilityTimeout: opts.visibility, MessageSystemAttributeNames: ["ApproximateReceiveCount"] }));
    const m = r.Messages?.[0];
    if (m) {
      if (opts.del !== false) await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl[role], ReceiptHandle: m.ReceiptHandle }));
      return { body: JSON.parse(m.Body ?? "{}") as Record<string, string>, message: m };
    }
  }
  throw new Error(`no message on the ${role} queue`);
}

async function emptyFor(role: QueueRole, ms: number): Promise<boolean> {
  await sleep(ms);
  const r = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl[role], MaxNumberOfMessages: 1, WaitTimeSeconds: 0 }));
  return (r.Messages ?? []).length === 0;
}

async function start(): Promise<{ executionArn: string; workflowId: string; tenantId: string }> {
  const workflowId = newId("wf");
  const tenantId = newId("tnt");
  const r = await sfn.send(new StartExecutionCommand({ stateMachineArn, name: workflowId, input: JSON.stringify({ workflowId, tenantId }) }));
  started.push(r.executionArn ?? "");
  return { executionArn: r.executionArn ?? "", workflowId, tenantId };
}

/** Executions started by this file; a callback waits until each running one has submitted its tasks. */
const started: string[] = [];

/**
 * EMULATOR WORKAROUND (Step Functions Local 2.0.0 race, see deploy/local/README.md fidelity finding 1):
 * a task-token callback that arrives before the emulator has recorded TaskSubmitted for that task fails
 * the execution with States.Runtime "... is not valid JSON". The SQS message can be received before
 * that event is recorded, so wait (bounded) until every scheduled callback task of every running execution has
 * been submitted.
 */
async function awaitTasksSubmitted(): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (const executionArn of started) {
    for (;;) {
      const h = await sfn.send(new GetExecutionHistoryCommand({ executionArn, maxResults: 1000 }));
      const events = h.events ?? [];
      // Only callback tasks record TaskSubmitted; a plain sendMessage task (the escalation notice) does not.
      const scheduled = events.filter((e) => e.type === "TaskScheduled" && (e.taskScheduledEventDetails?.resource ?? "").endsWith(".waitForTaskToken")).length;
      const submitted = events.filter((e) => e.type === "TaskSubmitted").length;
      const ended = events.some((e) => e.type === "ExecutionSucceeded" || e.type === "ExecutionFailed" || e.type === "ExecutionAborted" || e.type === "ExecutionTimedOut");
      if (ended || submitted >= scheduled) break;
      if (Date.now() > deadline) throw new Error(`Step Functions Local never recorded TaskSubmitted for ${executionArn}`);
      await sleep(50);
    }
  }
}

const signal = async (token: string, output: Record<string, string>) => {
  await awaitTasksSubmitted();
  return sfn.send(new SendTaskSuccessCommand({ taskToken: token, output: JSON.stringify(output) }));
};

async function finalStatus(executionArn: string): Promise<{ status: string; states: string[] }> {
  for (let i = 0; i < 50; i++) {
    const d = await sfn.send(new DescribeExecutionCommand({ executionArn }));
    if (d.status !== "RUNNING") {
      const h = await sfn.send(new GetExecutionHistoryCommand({ executionArn, maxResults: 1000 }));
      const states = (h.events ?? []).map((e: HistoryEvent) => e.stateEnteredEventDetails?.name).filter((n): n is string => typeof n === "string");
      return { status: d.status ?? "UNKNOWN", states };
    }
    await sleep(200);
  }
  return { status: "RUNNING", states: [] };
}

describe("Step Functions Local runs the generated ASL with SQS task tokens (ElasticMQ)", () => {
  beforeAll(async () => {
    const l2 = layer2Context(["stepfunctions", "elasticmq"]);
    sfn = sfnClient(l2);
    sqs = sqsClient(l2);
    let asl = readFileSync(join(ASL_DIR, "callback_request.asl.json"), "utf8");
    for (const role of QUEUES) {
      const name = uniqueName(`vsp-it-wf-${role}`);
      await sqs.send(new CreateQueueCommand({ QueueName: name }));
      queueUrl[role] = `http://elasticmq:9324/000000000000/${name}`;
      asl = asl.replaceAll(`\${${role}_task_queue_url}`, queueUrl[role]).replaceAll(`\${${role}_queue_url}`, queueUrl[role]);
    }
    expect(asl).not.toMatch(/\$\{[a-z_]+\}/);
    const sm = await sfn.send(
      new CreateStateMachineCommand({ name: uniqueName("vsp-it-callback-request"), definition: asl, roleArn: `arn:aws:iam::${SYNTHETIC_ACCOUNT}:role/vsp-it-workflows`, type: "STANDARD" }),
    );
    stateMachineArn = sm.stateMachineArn ?? "";
  });

  it("[FO-16-16] callback_request runs ACCEPTED -> VALIDATING -> recheck ALLOW -> WAITING_FOR_HUMAN -> COMPLETED through task tokens", async () => {
    const run = await start();
    const accepted = await nextMessage("system");
    expect(accepted.body).toMatchObject({ workflowId: run.workflowId, tenantId: run.tenantId, workflowType: "callback_request", state: "ACCEPTED" });
    expect(Object.keys(accepted.body).every((k) => ALLOWED_BODY_KEYS.has(k))).toBe(true);
    await signal(accepted.body.taskToken ?? "", { event: "VALIDATE", actorKind: "system" });
    const validating = await nextMessage("system");
    expect(validating.body.state).toBe("VALIDATING");
    await signal(validating.body.taskToken ?? "", { event: "CONSENT_CONFIRMED", actorKind: "system" });
    const recheck = await nextMessage("recheck");
    expect(recheck.body).toMatchObject({ guard: "disclosure", grantAction: "callback.outreach", toState: "WAITING_FOR_HUMAN" });
    await signal(recheck.body.taskToken ?? "", { decision: "ALLOW" });
    const human = await nextMessage("human");
    expect(human.body.state).toBe("WAITING_FOR_HUMAN");
    await signal(human.body.taskToken ?? "", { event: "HUMAN_APPROVED", actorKind: "staff" });
    const done = await finalStatus(run.executionArn);
    expect(done.status).toBe("SUCCEEDED");
    expect(done.states).toEqual(expect.arrayContaining(["ACCEPTED", "VALIDATING", "VALIDATING__Recheck_CONSENT_CONFIRMED", "WAITING_FOR_HUMAN", "COMPLETED"]));
    expect(done.states).not.toContain("CANCELLED");
  });

  it("[FO-16-16] a signal from an actor kind the transition does not permit escalates instead of advancing", async () => {
    const run = await start();
    const accepted = await nextMessage("system");
    await signal(accepted.body.taskToken ?? "", { event: "VALIDATE", actorKind: "caller" });
    const escalation = await nextMessage("escalation");
    expect(escalation.body).toMatchObject({ workflowId: run.workflowId, cause: "INVALID_SIGNAL", escalationOwnerQueue: "q_callback_supervisors" });
    const human = await nextMessage("human");
    expect(human.body.state).toBe("WAITING_FOR_HUMAN");
    expect(await emptyFor("system", 500)).toBe(true);
    await signal(human.body.taskToken ?? "", { event: "CANCEL", actorKind: "staff" });
    const done = await finalStatus(run.executionArn);
    expect(done.status).toBe("SUCCEEDED");
    expect(done.states).toContain("CANCELLED");
    expect(done.states).not.toContain("VALIDATING");
  });

  it("[FO-16-16] SendTaskFailure is caught (States.ALL) and routed to the failure escalation", async () => {
    const run = await start();
    const accepted = await nextMessage("system");
    await awaitTasksSubmitted();
    await sfn.send(new SendTaskFailureCommand({ taskToken: accepted.body.taskToken ?? "", error: "Workflow.Fatal", cause: "SYNTHETIC_FAILURE" }));
    const escalation = await nextMessage("escalation");
    expect(escalation.body).toMatchObject({ workflowId: run.workflowId, cause: "RETRY_BUDGET_EXHAUSTED" });
    const human = await nextMessage("human");
    await signal(human.body.taskToken ?? "", { event: "CANCEL", actorKind: "system" });
    expect((await finalStatus(run.executionArn)).status).toBe("SUCCEEDED");
  });

  it("[FO-16-16][ACT-02] a redelivered task message carries the same token, and a used token cannot advance the execution twice", async () => {
    const run = await start();
    const first = await nextMessage("system", { del: false, visibility: 1 });
    await sleep(1_300);
    const redelivered = await nextMessage("system", { del: true, visibility: 5 });
    expect(redelivered.message.Attributes?.ApproximateReceiveCount).toBe("2");
    expect(redelivered.body.taskToken).toBe(first.body.taskToken);
    await signal(first.body.taskToken ?? "", { event: "VALIDATE", actorKind: "system" });
    await expect(signal(redelivered.body.taskToken ?? "", { event: "VALIDATE", actorKind: "system" })).rejects.toMatchObject({ name: expect.stringMatching(/^(TaskTimedOut|InvalidToken|TaskDoesNotExist)$/) });
    const validating = await nextMessage("system");
    expect(validating.body).toMatchObject({ workflowId: run.workflowId, state: "VALIDATING" });
    expect(await emptyFor("system", 500)).toBe(true);
    await signal(validating.body.taskToken ?? "", { event: "CANCEL", actorKind: "system" });
    const done = await finalStatus(run.executionArn);
    expect(done.status).toBe("SUCCEEDED");
    expect(done.states.filter((s) => s === "VALIDATING")).toHaveLength(1);
  });
  it("[FO-16-16] fidelity record: a callback for an execution that already ended is not rejected by Step Functions Local, and it changes nothing", async () => {
    const run = await start();
    const accepted = await nextMessage("system");
    await signal(accepted.body.taskToken ?? "", { event: "CANCEL", actorKind: "system" });
    const done = await finalStatus(run.executionArn);
    expect(done.status).toBe("SUCCEEDED");
    const before = await sfn.send(new GetExecutionHistoryCommand({ executionArn: run.executionArn, maxResults: 1000 }));
    // AWS answers TaskTimedOut here; the emulator accepts it. Consumers must deduplicate callbacks themselves.
    const duplicate = await signal(accepted.body.taskToken ?? "", { event: "VALIDATE", actorKind: "system" }).then(() => "accepted", (e: { name?: string }) => e.name ?? "rejected");
    expect(["accepted", "TaskTimedOut", "InvalidToken"]).toContain(duplicate);
    const after = await sfn.send(new GetExecutionHistoryCommand({ executionArn: run.executionArn, maxResults: 1000 }));
    expect((await sfn.send(new DescribeExecutionCommand({ executionArn: run.executionArn }))).status).toBe("SUCCEEDED");
    expect(after.events?.length).toBe(before.events?.length);
    expect(await emptyFor("system", 500)).toBe(true);
  });
  it("[FO-16-16] every generated STANDARD definition (manifest digests intact) is accepted by Step Functions Local and reaches its first task-token state", async () => {
    const manifest = JSON.parse(readFileSync(join(ASL_DIR, "manifest.json"), "utf8")) as { workflows: { workflowType: string; definitionVersion: string; file: string; sha256: string }[] };
    expect(manifest.workflows.length).toBeGreaterThanOrEqual(7);
    for (const wf of manifest.workflows) {
      const raw = readFileSync(join(ASL_DIR, wf.file), "utf8");
      expect(createHash("sha256").update(raw).digest("hex"), wf.file).toBe(wf.sha256);
      const systemName = uniqueName(`vsp-it-wf-${wf.workflowType.replace(/_/g, "-")}`).slice(0, 70);
      await sqs.send(new CreateQueueCommand({ QueueName: systemName }));
      const systemUrl = `http://elasticmq:9324/000000000000/${systemName}`;
      let asl = raw.replaceAll("${system_task_queue_url}", systemUrl);
      for (const role of QUEUES.filter((r) => r !== "system")) asl = asl.replaceAll(`\${${role}_task_queue_url}`, queueUrl[role]).replaceAll(`\${${role}_queue_url}`, queueUrl[role]);
      expect(asl, wf.file).not.toMatch(/\$\{[a-z_]+\}/);
      const sm = await sfn.send(new CreateStateMachineCommand({ name: uniqueName(`vsp-it-${wf.workflowType.replace(/_/g, "-")}`).slice(0, 80), definition: asl, roleArn: `arn:aws:iam::${SYNTHETIC_ACCOUNT}:role/vsp-it-workflows`, type: "STANDARD" }));
      const workflowId = newId("wf");
      const ex = await sfn.send(new StartExecutionCommand({ stateMachineArn: sm.stateMachineArn, name: workflowId, input: JSON.stringify({ workflowId, tenantId: newId("tnt") }) }));
      let body: Record<string, string> | null = null;
      for (let i = 0; i < 15 && !body; i++) {
        const r = await sqs.send(new ReceiveMessageCommand({ QueueUrl: systemUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 1 }));
        body = r.Messages?.[0] ? (JSON.parse(r.Messages[0].Body ?? "{}") as Record<string, string>) : null;
      }
      expect(body, wf.file).toMatchObject({ workflowId, workflowType: wf.workflowType, definitionVersion: wf.definitionVersion, state: "ACCEPTED" });
      expect(Object.keys(body ?? {}).every((k) => ALLOWED_BODY_KEYS.has(k)), wf.file).toBe(true);
      await sfn.send(new StopExecutionCommand({ executionArn: ex.executionArn, error: "Layer2.Stopped", cause: "first task state reached" }));
      expect((await sfn.send(new DescribeExecutionCommand({ executionArn: ex.executionArn }))).status, wf.file).toBe("ABORTED");
    }
  });
});
