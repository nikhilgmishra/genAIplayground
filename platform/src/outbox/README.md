# outbox — transactional outbox, dispatcher, consumer dedup, publishers

Status: **IMPLEMENTED_OFFLINE**, and **VERIFIED against protocol emulators (Layer 2)** for the
SQS path (ElasticMQ with a redrive policy) and multi-connection claims (postgres:16):
`platform/test/integration/substrate/sqs.test.ts`, `contention.test.ts` and
`platform/test/integration/ingress/http.test.ts` ([FAULT:DUPLICATE_WEBHOOK] outbox redelivery).
Not verified against real SQS (environment NOT_CONFIGURED). Nothing here establishes production
readiness.

Spec: section 8 ("Persist an action ledger and transactional outbox before initiating durable
delivery. Events are at least once; consumers deduplicate."; dead-letter queue and operator
repair flow) and section 12 (bounded retries with jitter, no retries on top of retries).

## What is implemented

| Piece | File | Notes |
|---|---|---|
| Migration | `migrations/0110_outbox.sql` | `outbox_messages` and `consumer_dedup`. RLS enabled and forced, tenant policies for `app_runtime` and `app_worker`. No DELETE grants. Guard trigger: immutable content, `DISPATCHED` is final, `DEAD` can only be requeued |
| `PgOutbox` (`Outbox` port) | `outbox.ts` | `enqueue(tx, msg)` inside the caller's transaction, under the tenant from `app_tenant()` (fails closed without one). `ON CONFLICT (tenant_id, dedupe_key) DO NOTHING` returns the original id. Payloads are restricted to opaque references and codes (no free text, phone- or DOB-like values, bounded size and depth) |
| `PgOutboxDispatcher` (`OutboxDispatcher` port) | `dispatcher.ts` | `runOnce`: see below. `listDead()` and `requeueDead(messageId, operator)` provide operator repair, audited in the same transaction. Fails closed (FO-06-10): without an `AuditWriter` a requeue is refused (`AuditUnavailableError OUTBOX_REQUEUE_AUDIT_NOT_CONFIGURED`), and a found message without an operator is refused (`OUTBOX_REQUEUE_OPERATOR_REQUIRED`). Audit events go to the **per-instance stream** `auditStreamName("outbox", instanceId)` (option `instanceId`, e.g. the ECS task id; default a random opaque id per dispatcher), exposed as `dispatcher.auditStream`, so dispatcher instances never contend on one chain head |
| `computeBackoffMs` (pure) | `dispatcher.ts` | Exponential backoff with equal jitter. `random` is injectable for deterministic tests |
| `PgConsumerDedup` (`ConsumerDedup` port) | `consumer-dedup.ts` | Inserts the dedupe row and runs the handler in ONE transaction. A duplicate is skipped. A handler failure rolls back both, so redelivery retries. `processOnceForTenant` serves multi-tenant consumers. `isProcessed(tenantId, consumer, messageId)` (on the port) is a read-only pre-check inside the tenant's RLS context, used by worker consumers that run their handler outside the dedupe transaction |
| `MemoryPublisherFixture` | `memory-publisher.fixture.ts` | **LOCAL FIXTURE** (`kind: "local_fixture"`). Records deliveries. Failure injection: throw, fail-all, fail-message. `duplicateEveryDelivery` and `redeliverAll()` simulate at-least-once delivery |
| `SqsDeadLetterRedrive`, `SqsDeadLetterWriter` | `sqs-dlq.ts` | **live**. FO-03-24 / FO-06-10: operator repair of the SQS dead-letter queue. `inspect(n)` returns metadata only (outbox message id, tenant, topic, redrive count, receive count). `redrive({ maxMessages, operator })` appends an `outbox.dlq_redrive` INTENT audit event FIRST (outcome PENDING; worker role, own transaction; refused => nothing moves, `stoppedBy: AUDIT_STORE_UNWRITABLE`), then sends the message back to the source queue with `vsp-redrive-count` + 1, deletes it from the DLQ, and records `outbox.dlq_redrive.completed` (SUCCEEDED, or FAILED with `SQS_DLQ_REDRIVE_SEND_FAILED` when the move failed; an unrecorded completion stops the run with `AUDIT_COMPLETION_UNRECORDED`), so the trail never claims a move that did not happen; messages already redriven `maxRedrives` times stay and are reported (`exhausted`). Reason codes from `DLQ_REDRIVE_REASON_CODES`; operator refs must be audit-carriable opaque ids. `SqsDeadLetterWriter.write` turns a refusing DLQ (deleted, or over the size limit) into `DependencyError DLQ_WRITE_REFUSED`, never a silent drop. |
| `SqsPublisher` | `sqs-publisher.ts` | **live** (`kind: "live"`). Documented `SendMessageBatch` (AWS SDK v3) with at most 10 entries per batch. FIFO queues get `MessageGroupId` = key and a stable `MessageDeduplicationId` = sha256 of the dedupe key. Per-entry `Failed` entries, omitted entries and batch exceptions all map to failed ids. Rejects malformed queue URLs and FIFO mismatches |

### Messages carry the tenant

`OutboxMessage.tenantId` is the tenant the message was enqueued for (the enqueuing transaction's
RLS tenant). Publishers and consumers receive it with every message (`DispatchedOutboxMessage`
is now an alias of `OutboxMessage`), and the SQS envelope carries it. The ledger's
`action.committed` payload also carries `tenantId` (opaque), so consumers no longer need a
cross-tenant lookup to set their RLS context.

### `runOnce`

1. Claims due `PENDING` rows with `FOR UPDATE SKIP LOCKED` plus a lease (`claim_token`,
   `claimed_until`).
2. Publishes **outside** any database transaction.
3. Settles each row by claim token:
   - Published rows become `DISPATCHED`.
   - Failed, ambiguous or unreported rows get `attempts + 1`, an exponential backoff with
     jitter, and become `DEAD` after `maxAttempts`.
4. Per-key head-of-line ordering is on by default.
5. A crash between publish and settle re-publishes after the lease expires. That is at least
   once, so consumers must deduplicate.
6. The dispatcher runs as `app_worker` inside each configured tenant's RLS context.

### Payload rule (DATA-01)

String values must be one of:
- an opaque id
- an UPPER_CODE
- a lower-case token with no run of 4 or more digits
- an ISO-8601 UTC timestamp
- a sha256 hex value
- a semver string
- a support reference

Strings are at most 200 characters, nesting is at most 3 levels, and the canonical payload is
at most 8 KiB. Anything else fails with `OUTBOX_PAYLOAD_NOT_OPAQUE`. This is a guard against
free text, not a PHI detector.

## LOCAL FIXTURE vs live

- `MemoryPublisherFixture` is local only. The production configuration guard must reject
  `kind: "local_fixture"` (OPS-04, enforced by the config module).
- `SqsPublisher` is tested with an injected stub client (`sqs-publisher.contract.test.ts`,
  labelled CONTRACT) and against ElasticMQ in Layer 2 (two dispatchers on two pools, each message
  published once; dead-lettering after `maxReceiveCount`; audited bounded redrive).
- ElasticMQ fidelity: version 1.7.1 neither stores nor enforces a per-queue `MaximumMessageSize`;
  it enforces the global 1 MiB limit. The DLQ_FULL seam therefore uses a message over 1 MiB.

## BLOCKED

| Item | Why | Prerequisite |
|---|---|---|
| Real SQS publishing (FIFO queue + DLQ, redrive policy, visibility timeout, KMS) | No AWS account, queue, IAM role or approval (the same code runs against ElasticMQ in Layer 2) | Approved sandbox account, Terraform-applied queue with DLQ, IAM role for the dispatcher and the redrive operator, cost approval |
| SQS consumer (ReceiveMessage/DeleteMessage loop) | Owned by the worker module. Depends on the same AWS prerequisites | As above |

## Known limits

- Ordering is per key and best effort. A dead-lettered message no longer blocks later messages
  for the same key. Consumers must tolerate reordering (they deduplicate and use version
  checks).
- `requeueDead`/`listDead` iterate the configured tenants. The tenant list must come from
  trusted configuration.
- `dispatched_at`/`dead_at` rows are not purged here. Retention is owned by the retention
  module.

## Requirement IDs enforced here

ACT-02 (dedupe at enqueue, consumer dedup, duplicate redelivery), DATA-01 (opaque payloads),
AUTH-05 (tenant RLS), OPS-01 (audited operator repair), SPEC-8.3, SPEC-8.4, SPEC-12.3.

## How to test

```
cd platform
npx vitest run src/outbox
npx eslint src/outbox
make -C .. test-integration SUITE=substrate FILTER=sqs        # ElasticMQ + postgres:16
make -C .. test-integration SUITE=substrate FILTER=contention # two dispatchers, SKIP LOCKED, lease fencing
```
