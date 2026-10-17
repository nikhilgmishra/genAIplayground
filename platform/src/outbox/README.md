# outbox — transactional outbox, dispatcher, consumer dedup, publishers

Status: **IMPLEMENTED_OFFLINE**. Verified against PGlite with a LOCAL FIXTURE publisher and a
stub SQS client (contract test). Not verified against real SQS. Nothing here establishes
production readiness.

Spec: section 8 ("Persist an action ledger and transactional outbox before initiating durable
delivery. Events are at least once; consumers deduplicate."; dead-letter queue and operator
repair flow) and section 12 (bounded retries with jitter, no retries on top of retries).

## What is implemented

| Piece | File | Notes |
|---|---|---|
| Migration | `migrations/0110_outbox.sql` | `outbox_messages` and `consumer_dedup`. RLS enabled and forced, tenant policies for `app_runtime` and `app_worker`. No DELETE grants. Guard trigger: immutable content, `DISPATCHED` is final, `DEAD` can only be requeued |
| `PgOutbox` (`Outbox` port) | `outbox.ts` | `enqueue(tx, msg)` inside the caller's transaction, under the tenant from `app_tenant()` (fails closed without one). `ON CONFLICT (tenant_id, dedupe_key) DO NOTHING` returns the original id. Payloads are restricted to opaque references and codes (no free text, phone- or DOB-like values, bounded size and depth) |
| `PgOutboxDispatcher` (`OutboxDispatcher` port) | `dispatcher.ts` | `runOnce`: see below. `listDead()` and `requeueDead(messageId)` provide operator repair, audited in the same transaction when an `AuditWriter` is configured (fails closed) |
| `computeBackoffMs` (pure) | `dispatcher.ts` | Exponential backoff with equal jitter. `random` is injectable for deterministic tests |
| `PgConsumerDedup` (`ConsumerDedup` port) | `consumer-dedup.ts` | Inserts the dedupe row and runs the handler in ONE transaction. A duplicate is skipped. A handler failure rolls back both, so redelivery retries. `processOnceForTenant` serves multi-tenant consumers |
| `MemoryPublisherFixture` | `memory-publisher.fixture.ts` | **LOCAL FIXTURE** (`kind: "local_fixture"`). Records deliveries. Failure injection: throw, fail-all, fail-message. `duplicateEveryDelivery` and `redeliverAll()` simulate at-least-once delivery |
| `SqsPublisher` | `sqs-publisher.ts` | **live** (`kind: "live"`). Documented `SendMessageBatch` (AWS SDK v3) with at most 10 entries per batch. FIFO queues get `MessageGroupId` = key and a stable `MessageDeduplicationId` = sha256 of the dedupe key. Per-entry `Failed` entries, omitted entries and batch exceptions all map to failed ids. Rejects malformed queue URLs and FIFO mismatches |

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
- `SqsPublisher` is tested only with an injected stub client
  (`sqs-publisher.contract.test.ts`, labelled CONTRACT).

## BLOCKED

| Item | Why | Prerequisite |
|---|---|---|
| Real SQS publishing (FIFO queue + DLQ, redrive policy, visibility timeout, KMS) | No AWS account, queue, IAM role or approval | Approved sandbox account, Terraform-applied queue with DLQ, IAM role for the dispatcher, cost approval |
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
```
