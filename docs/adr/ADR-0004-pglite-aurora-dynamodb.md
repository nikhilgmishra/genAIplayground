# ADR-0004 PGlite for offline tests, Aurora PostgreSQL in deployment, DynamoDB sessions with application-enforced expiry

| Field | Value |
|---|---|
| Status | **Accepted for engineering** |
| Date | 2026-10-17 |
| Decided by | Principal engineer (coding agent) |
| Approval needed from | None for offline use; Aurora and DynamoDB deployment follows PRQ-037 and PRQ-038 |
| Related prerequisites | PRQ-037, PRQ-038, PRQ-039 |

## Context

The business ledger, transactional outbox, audit outbox, workflow state and support records
need real PostgreSQL semantics in tests: transactions, constraints, triggers and row-level
security. A mock that returns success is explicitly not completion (spec section 15). The
development sandbox has no Docker daemon, so a containerised PostgreSQL is not available
(`docs/INVENTORY.md`). Call session state needs conditional writes and fast expiry checks;
spec section 7 notes that DynamoDB TTL deletion is not immediate.

## Decision

1. A single `Db` port (`platform/src/db`) with two adapters: **PGlite** 0.3.15 (PostgreSQL
   compiled to WebAssembly, with the pgvector extension) for local, test and CI runs, and
   **`pg`** 8.23.1 for Aurora PostgreSQL in deployed environments.
2. The **same ordered SQL migrations** (`platform/migrations`, module-numbered, append-only,
   changed applied migrations fail startup) run on both. Runtime transactions use the
   `app_runtime` role with row-level security and `rls.tenantId`; the `owner` role is for
   migrations and fixtures only.
3. **DynamoDB** holds call sessions with conditional writes (compare-and-swap on a version).
   The offline `KvStore` is an in-memory LOCAL FIXTURE with identical compare-and-swap
   semantics. **Every reader enforces `expiresAt` in application logic**; the TTL attribute is
   storage cleanup only.

## Consequences

* Tests exercise real SQL, constraints, triggers and RLS without Docker.
* Not verified offline and therefore BLOCKED until a sandbox: Aurora failover, replication
  lag, connection pooling, real concurrent sessions and isolation behaviour under load, KMS
  encryption, IAM authentication, parameter groups, and extension version parity between
  PGlite and the Aurora engine version (record both versions when the sandbox exists).
* PGlite runs a single connection per instance, so some concurrency tests simulate
  interleavings rather than parallel sessions; this limitation must be stated in test evidence.
* DynamoDB conditional-write behaviour, throttling and global-table behaviour (if used for the
  secondary region) are verified only in the sandbox.

## Alternatives considered

| Alternative | Why not adopted |
|---|---|
| Docker PostgreSQL for tests | No Docker daemon in the development sandbox; can be added in CI later as an extra layer |
| SQLite | Different SQL dialect; no row-level security; would not test the deployed schema |
| In-memory mocks of the ledger | Cannot demonstrate atomicity, idempotency or RLS; spec rejects mocks as completion |
| Sessions in Aurora | Possible, but DynamoDB conditional writes and per-item expiry fit call-session load; spec selects DynamoDB |
| Relying on DynamoDB TTL for expiry | TTL deletion is delayed; AUTH-04 requires readers to fail closed |

## Linked requirements

AUTH-04, ACT-02, OPS-01, SPEC-3 (business ledger, call session state), SPEC-15 (a mock
returning success is not completion).

## Revisit when

A CI runner with a PostgreSQL service becomes available (add it as an additional test layer,
not a replacement), or sandbox measurements show PGlite-Aurora behaviour differences.
