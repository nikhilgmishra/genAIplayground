# Step Functions STANDARD state machines (generated)

Status: **IMPLEMENTED_OFFLINE (generated, validated locally)**. Nothing in this directory has
been deployed to, or verified in, an AWS account. Deployment is BLOCKED until an AWS sandbox
account, a reviewed Terraform plan and the approvals described in the specification exist.

## What is here

| File | Content |
|---|---|
| `<workflow_type>.asl.json` | Amazon States Language for the newest registered definition version of each workflow type |
| `manifest.json` | Generator id, `stateMachineType: "STANDARD"`, logging requirement, placeholder list, and the SHA-256 of every document |

All files except this README are **generated** from the versioned TypeScript definitions in
`platform/src/workflows/definitions/` by `platform/src/workflows/asl.ts`. Do not edit them.

```bash
cd platform
npx tsx src/workflows/generate-asl.ts           # regenerate
npx tsx src/workflows/generate-asl.ts --check   # CI drift check: exits 1 on any drift
```

Every document is validated in tests with `asl-validator` 4.0.0 (path and ARN checks enabled):
`npx vitest run src/workflows/asl.test.ts`.

## Deployment requirements (for the Terraform module owner)

* **Type must be `STANDARD`** (`aws_sfn_state_machine.type = "STANDARD"`). Follow-up work must
  survive hang-up, outages, approvals and days of waiting (spec section 3); EXPRESS is not allowed.
* **Render with `templatefile()`.** Queue URLs are Terraform template placeholders (below). The
  ASL itself contains `$.`/`$$.` JSONPath expressions but no `${...}` sequences other than these
  placeholders and no `%{` directives, so `templatefile` renders it unchanged otherwise.
* **Logging:** `logging_configuration { level = "ERROR", include_execution_data = false }`.
  Execution data must not go to CloudWatch Logs: the Step Functions task token is part of the
  resolved SQS message parameters, and workflow state must never reach general logs.
* **Execution history access** (`states:GetExecutionHistory`, `states:DescribeExecution`) is a
  restricted permission: resolved task parameters (which include the task token) are visible
  there. Grant it only to the workflow worker role and audited break-glass roles.
* **Execution names** must be the opaque workflow id (`wf_...`) only — never names, dates,
  phone numbers or any other PHI (spec sections 6 and 9).
* **Execution input** is exactly `{"workflowId": "wf_...", "tenantId": "tnt_..."}`.
* **Versioning:** publish a new state machine version per definition version (`publish = true`)
  and route new starts through an alias. Executions already running continue on the version they
  started with, which is how in-flight workflows retain compatibility (spec section 15, Phase 5).
  Never delete a published version that still has running executions.
* **One engine per instance.** An instance runs either on the local durable executor
  (`PgWorkflowEngine`, offline) or on Step Functions — never both (spec section 3).

## Terraform template placeholders

| Placeholder | Meaning |
|---|---|
| `${system_task_queue_url}` | SQS queue for system work items (ACCEPTED, VALIDATING, WAITING_FOR_SYSTEM, READY_TO_COMMIT), consumed by the workflow worker |
| `${human_task_queue_url}` | SQS queue for WAITING_FOR_HUMAN work items, consumed by the human-task bridge that opens the console task |
| `${notify_queue_url}` | SQS queue for WAITING_FOR_CALLER: neutral notification per preferences, quiet hours and consent, then wait for the caller |
| `${escalation_queue_url}` | SQS queue receiving escalation notices (deadline exceeded, retry budget exhausted, invalid signal) for the escalation owner queue |
| `${recheck_queue_url}` | SQS queue for pre-disclosure / material-change rechecks (consent, representation, account state, current policy) |

Every queue must have a dead-letter queue, KMS encryption and an IAM policy limited to the state
machine role (send) and the worker role (receive/delete). Queue names must not contain PHI.

## Worker contract (what the trusted worker must do)

* Receive the SQS message; the body contains only opaque ids, the state name, the definition
  version, the owner queue (and for human tasks the task type and required staff roles) plus
  `taskToken`. Store the Step Functions task token server-side only (encrypted); never log it,
  never put it in a URL, a notification, a console link or a model context.
* Answer with `SendTaskSuccess` and output **exactly** `{"event": "<EVENT>", "actorKind": "<KIND>"}`
  where `<EVENT>` is a declared transition of that state and `<KIND>` is one of the actor kinds the
  definition declares for that event (`caller`, `system`, `staff` or `external_system`; for example
  `caller` only for `CALLER_RESPONDED` / `DOCUMENTS_SUBMITTED`, `system` or `external_system` for
  `SYSTEM_CONFIRMED` / `SYNCED` / `PERMANENT_FAILURE`). Send it only after the SAME signal passed
  `PgWorkflowEngine.signal` (or `completeHumanTask`) in the platform, which checks the actor kind
  and, for guarded transitions, the instance's durable action grant for the transition's declared
  `grantAction`. Each route `Choice` rule requires the event **and** a declared actor kind;
  `POLICY_CHANGED_PENDING_ACTION` is never routable from a worker answer (only from a recheck
  decision). Recheck tasks carry the transition's `grantAction` and answer
  `{"decision": "ALLOW" | "DENY"}`. Anything else is routed to escalation. Note: if the output
  lacks a selected field, the `ResultSelector` fails with `States.Runtime`, which Step Functions
  does not let `Catch` handle; the worker bridge must therefore validate its own output before
  sending.
* For retryable failures send `SendTaskFailure` with error `Workflow.Retryable`; this consumes the
  state's retry budget (`MaxAttempts`) with full jitter, after which the work escalates.
* Send `SendTaskHeartbeat` at least every `HeartbeatSeconds` while the work item is open
  (including open human tasks). A silent worker fleet therefore surfaces as an escalation.
* `HUMAN_APPROVED` / `HUMAN_REJECTED` may only be reported after the platform's own scoped human
  task token was verified by `PgWorkflowEngine.completeHumanTask` semantics (one task, one staff
  member, expiring, single use, required role + MFA + no expired break-glass re-validated).

## BLOCKED

| Item | Prerequisite |
|---|---|
| Deploying these state machines | AWS sandbox account, reviewed Terraform plan, cost estimate and approval (spec section 5) |
| Worker / human-task bridge against real Step Functions and SQS (`SendTaskSuccess`, heartbeats, encrypted token storage) | AWS account + KMS key + approved IAM design; verified against the live service |
| Production deadlines and retry budgets | Support-operations approval of per-workflow service deadlines (current values are proposed engineering defaults) |
