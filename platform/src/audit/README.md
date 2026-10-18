# Audit evidence module (`platform/src/audit`)

Status: **IMPLEMENTED_OFFLINE**. Tested against real PostgreSQL SQL in PGlite and a
local-filesystem sink fixture only. Nothing here has run against Aurora, S3, KMS or
the audit account. This module does not establish HIPAA compliance or production
readiness.

Spec coverage: section 13 (audit event model, append-only independent store,
tamper-evident manifests, integrity checks, monitored ingestion gaps, completeness
reconciliation, bounded local outbox, block consequential actions when evidence
cannot be written), section 6 (retention classes, Object Lock), invariants
OPS-01, DATA-01, AUTH-06 (plus AUTH-02/AUTH-05 for reads and OPS-03 for "hashing is not completeness").

## What is implemented

| Component | File | Notes |
|---|---|---|
| Migration | `platform/migrations/0201_audit_evidence.sql` | `audit_outbox`, `audit_chain_heads`, `audit_manifests`, `audit_purge_watermarks`, `audit_sink_status`, `audit_write_probe`, view `audit_event_metadata`, triggers, RLS, grants, two security-definer functions |
| Strict input schema | `schema.ts` | Protocol `AuditEventInput` tightened: dotted `action` grammar (>= 2 segments), reason codes without 4+ digit runs, evidence pointers in the preferred URI form `^(s3\|db\|sf\|ledger\|wf\|kv)://[A-Za-z0-9/_.:@-]{3,190}$` or the typed opaque form `<kind>:<OpaqueId>` (value must be an opaque id), both with PHI-shape heuristics (email, phone, SSN, calendar dates) and no `..`/`//` segments; opaque `sessionRef`, `turn_` grammar, token grammar for `idempotencyKey`, `VersionLabel` for `policyVersion`. Unknown keys rejected. Errors carry schema paths only, never values or unknown key names. |
| Hash chain | `chain.ts` | `hash = sha256(canonicalJson(event without hash))`; NDJSON batches; manifests; deterministic object keys `<stream>/<first12>-<last12>.ndjson`; pure `verifyChain`. |
| Writer | `writer.ts` (`PgAuditWriter`) | Per-instance stream (`auditStreamName(component, instanceId)`), sequence/prevHash/hash assigned under `SELECT ... FOR UPDATE` on the stream's chain head inside the caller's transaction (`append`) or its own (`appendStandalone`). Every storage failure becomes `AuditUnavailableError` (`AUDIT_STORE_UNWRITABLE`, `AUDIT_CHAIN_CONTENTION`, `AUDIT_TENANT_CONTEXT_MISMATCH`, ...). Driver errors (which carry SQL text and bound parameters) are dropped. Bearer session refs (`ses_...`) are stored only as a one-way pseudonym (`sref_...`, see `pseudonymousSessionRef`); hash-derived binding refs (`ses_bnd_...`) are kept as given. Rejects events stamped > 300 s in the future. |
| Health | `health.ts` (`PgAuditHealth`) | Bounded buffering: write probe (privileges, not a read replica, probe row upsert) AND backlog count <= `maxBacklog` AND oldest unshipped age <= `maxBacklogAgeSeconds`. Reasons, in precedence order: `AUDIT_STORE_UNWRITABLE`, `AUDIT_BACKLOG_EXCEEDED`, `AUDIT_SINK_STALE`. `assertCanAcceptConsequential()` throws `AuditUnavailableError`. Optional `cacheTtlMs` (<= 10 s) reuses healthy results only. |
| Shipper | `shipper.ts` (`AuditShipper`) | Per stream, in sequence order: plan batch (recorded `PLANNED` locally first) -> `sink.putBatch` -> mark rows shipped + manifest `SHIPPED` in one transaction. Idempotent across a crash/lost response between put and mark (re-puts exactly the planned batch). Re-verifies hashes and links before planning; refuses to ship across a gap or broken link (`AUDIT_CHAIN_GAP` / `AUDIT_CHAIN_BROKEN`). Records sink health. `purgeVerified(stream)` deletes the local prefix only through the purge function. |
| Sinks | `sinks/local-fs.ts`, `sinks/s3-object-lock.ts` | See LOCAL FIXTURE / BLOCKED below. Both refuse inconsistent batches (digest, key, range, line count). |
| Integrity verifier | `verifier.ts` (`IntegrityVerifier`) | `verifyStream` (schema, recomputed hashes, links, gaps, column/document consistency, chain head for tail truncation, purge watermark), `verifyShipped` (per-manifest digest and content, continuity across manifests from sequence 1, overlap, local SHIPPED manifests missing from the sink, local rows diverging from the shipped copy; `markVerified` sets `verified_at` only when the whole shipped stream is clean), `detectIngestionGaps` (STREAM_SILENT, COUNT_SHORTFALL, COUNT_EXCESS, UNKNOWN_STREAM, SINK_INGESTION_LAG against source-reported counts), `observedActionKeys`. Pure `reconcileCounts(expectedBySourceAction, observed)` (keyed or counted) and `assessCompleteness` (PASS only if integrity, ingestion monitoring AND reconciliation all ran clean; otherwise FAIL or INCONCLUSIVE). |
| Query | `query.ts` (`PgAuditQuery`, `auditedSearch`) | Metadata-only search (tenant, correlationId, callId, action, half-open time range, `limit` 1..200) via `audit_event_metadata` as `app_auditor` or `app_console`. `auditedSearch` records the access as an `audit.query.executed` event and returns nothing if that record cannot be written. |
| Deferred route audit | `deferred.ts` (`DeferredAuditQueue`, port `DeferredAuditSink` in `ports.ts`) | ROUTE evidence only (human / safety handoff events whose route must proceed during an audit outage, OPS-02/SAFE-03). `appendOrDefer` appends now; when the store is unwritable the event is kept in a bounded, process-local FIFO (default 1000, `maxEntries` 1..10000) and appended later, in deferral order, by `flush` (worker loop `audit.deferred_flush`; skipped while `AuditHealth` reports `AUDIT_STORE_UNWRITABLE`) or by the next `appendOrDefer`, which first drains up to 16 older entries. Each late event keeps its original `occurredAt` and is followed by an `audit.deferred.recorded` marker (`parentId` = the late event, `reasonCode` = why it was deferred). Overflow drops the NEW event, counted and logged at error level; an event the writer refuses as invalid is dropped loudly. Metrics `vsp_audit_deferred_total{result,reason}`, `vsp_audit_deferred_depth`, `vsp_audit_deferred_age_ms`; error-level `audit.deferred.queued` / `audit.deferred.dropped` logs (action codes, opaque ids, reason codes only). **Crash-loss limit:** the queue is in process memory, so a crash or restart loses queued events; the `safety_events` row (audit_status `AUDIT_UNAVAILABLE`) remains the durable incident record for a safety route. **Never for consequential mutations** (they stay blocked by `assertCanAcceptConsequential` and the in-transaction `append`). |
| Helpers | `build-input.ts` | `buildAuditInput(fields, clock?)` fills defaults (`dataClass: SECURITY_AUDIT`, nulls, `[]`) and validates strictly. `auditFieldsFromAuth(authContext)` copies the server-established identity fields. |
| Fixtures | `fixtures.ts`, `testing.ts` | See LOCAL FIXTURE below. |

### Database privilege model (migration 0201)

| Role | audit_outbox | audit_chain_heads | audit_manifests | metadata view | functions |
|---|---|---|---|---|---|
| app_runtime | INSERT (RLS: `tenant_id = app_tenant()`), SELECT own tenant | SELECT/INSERT/UPDATE (trigger-checked) | none | none | `audit_backlog_stats()` |
| app_console | INSERT (RLS tenant) | SELECT/INSERT/UPDATE (trigger-checked) | none | SELECT (tenant filtered) | `audit_backlog_stats()` |
| app_worker (shipper/verifier) | INSERT (RLS tenant), SELECT all, UPDATE `(shipped_at, manifest_id)` once | SELECT/INSERT/UPDATE | SELECT/INSERT, UPDATE `(status, shipped_at, verified_at)` | none | `audit_backlog_stats()`, `audit_purge_verified()` |
| app_auditor | none | none | none | SELECT (tenant filtered) | none |

Triggers enforce, for every role including the owner while triggers are active:
an inserted event must be exactly the next link (`sequence = head + 1`, `prev_hash = head hash`);
a chain head starts empty and only advances by one to an existing event with that hash;
event rows are never updated except `shipped_at`/`manifest_id` set once by a role with
`app_worker` privileges; DELETE only inside `audit_purge_verified()` for rows shipped in
manifests verified against the sink; TRUNCATE rejected; manifest records immutable apart
from `PLANNED -> SHIPPED` and a one-time `verified_at`. CHECK constraints keep the indexed
columns identical to the hashed JSON document.

A database superuser can disable triggers (`session_replication_role = replica`). That
is the insider threat the hash chain, the chain head, the shipped manifests and the
independent sink exist to detect; tests simulate exactly that.

## Integration contract for other modules

1. Gate consequential actions: `await auditHealth.assertCanAcceptConsequential()`; on
   `AuditUnavailableError` degrade to safe routing (do not block safety/human routes).
2. Write evidence in the same transaction as the change:
   `await auditWriter.append(tx, buildAuditInput({...}, clock))`. The transaction must carry
   `rls.tenantId === input.tenantId` (RLS + an explicit check). If `append` throws, let the
   transaction roll back and do not acknowledge the mutation (OPS-01).
3. One writer per process instance with `stream: auditStreamName("<component>", instanceId)`.
4. Evidence pointers: prefer `ledger://actions/<actionId>`, `wf://workflows/<workflowId>`, `db://<table>/<id>`,
   `s3://<bucket>/<key>`; `<kind>:<OpaqueId>` is accepted. Values that are not opaque ids
   (e.g. `confirmation_method:dtmf`, `guard:<name>`) are rejected: put such facts in
   `reasonCode` or a typed field instead.
5. Actions are dotted codes with at least two segments (e.g. `action.commit.succeeded`);
   reason codes are upper-case codes without 4+ digit runs; never put caller words,
   transcripts, secrets or model reasoning in any field. Use evidence pointers to
   separately access-controlled stores for sensitive content.
6. `append` may throw `AuditUnavailableError("AUDIT_CHAIN_CONTENTION")` (retryable) when the
   caller uses REPEATABLE READ / SERIALIZABLE and another transaction advanced the same
   stream; per-instance streams keep this rare.
7. For reconciliation, put the source action's idempotency key in `idempotencyKey`.
8. Unit tests without a database: `InMemoryAuditWriterFixture`, `AuditWriterOutageFixture`,
   `StaticAuditHealthFixture`. They are not durable and cannot demonstrate atomicity.
9. Route evidence that must not block a human or safety route (handoffs) goes through
   `DeferredAuditSink.appendOrDefer` (`ToolDeps.deferredAudit`), never a mutation's audit event.
   The process that holds the queue must run `DeferredAuditQueue.flush` (worker loop
   `audit.deferred_flush`).

Operations wiring (not in this module): schedule `AuditShipper.runOnce()` (e.g. on the
`audit.ship` outbox topic or a timer), `IntegrityVerifier.verifyShipped(stream, { markVerified: true })`
then `purgeVerified(stream)`, `detectIngestionGaps` with source counters, and
`reconcileCounts` against the action ledger; export results to the audit-export
completeness dashboard (spec section 13).

## LOCAL FIXTURES (labelled `kind: "local_fixture"`)

- `LocalFsAuditSinkFixture`: directory-backed sink simulating Object Lock WORM (refuses a
  different overwrite, identical re-put is a no-op, atomic hard-link writes). Same host,
  deletable: **not independent evidence storage**. Badge `LOCAL_SINK_BADGE`.
- `FaultInjectingAuditSinkFixture`: sink outage (`failPuts`) and put-then-lost-response (`crashAfterPut`).
- `InMemoryAuditWriterFixture`, `AuditWriterOutageFixture`, `StaticAuditHealthFixture`.
- `testing.ts`: SYNTHETIC inputs from `platform/src/fixtures/synthetic-world.ts`; PGlite test DB.
- PGlite itself is the offline engine; production uses `PgPoolDb` on Aurora.

## BLOCKED (code path exists; execution needs external prerequisites)

| Item | Why blocked | Prerequisite (owner) |
|---|---|---|
| `S3ObjectLockAuditSink` against a real bucket | No audit account, bucket, KMS key or IAM role exist; no approved retention | Audit AWS account with an Object Lock-enabled, versioned bucket; audit-account KMS key; cross-account role limited to `s3:PutObject`/`GetObject`/`ListBucket` (+ `PutObjectRetention` if required) on the audit prefix (platform/security); Object Lock mode decision COMPLIANCE vs GOVERNANCE (security + counsel) |
| Retention duration for `SECURITY_AUDIT` | Spec forbids inventing a duration; `PlatformConfig.retention.SECURITY_AUDIT` is null | Counsel-approved duration per data class; the sink refuses to start with `null` (`AUDIT_RETENTION_UNAPPROVED`) |
| Independently administered account controls (separate admins, deletion restrictions, SCPs) | Infrastructure, not application code | Terraform audit-account stack + approvals (infra module) |
| Real multi-connection concurrency on Aurora | PGlite serializes transactions, so row-lock contention is not exercised offline | Sandbox Aurora/PostgreSQL run of `writer.test.ts`-style concurrent appends |

The S3 sink is covered only by a contract test with an injected stub client asserting
the exact `PutObject` / `HeadObject` / `GetObject` / `ListObjectsV2` inputs
(`ObjectLockMode`, `ObjectLockRetainUntilDate = now + approved days`, `ChecksumAlgorithm: "SHA256"`
+ `ChecksumSHA256`, `IfNoneMatch: "*"`, SSE-KMS key, `ExpectedBucketOwner`). A 412 is
accepted as an idempotent re-put only when `HeadObject` (ChecksumMode ENABLED) proves the
stored SHA-256 matches; otherwise `AUDIT_SINK_OBJECT_EXISTS`. This does not prove that a
real bucket enforces Object Lock.

## How to test

```bash
cd platform
npx vitest run src/audit                                          # all audit tests (PGlite, offline)
npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E "src/audit"       # expect no output
npx eslint src/audit                                              # expect clean
```

Tests use `createTestDb({ include: /^02/ })` (foundation + audit migrations), `FakeClock`,
temp directories and stub clients only. No network.

## Requirement -> enforcement -> tests

| Requirement | Enforcement | Tests (file) |
|---|---|---|
| OPS-01 durable independent evidence for accepted consequential actions | in-tx `append`; `AuditUnavailableError` on any failure; health gate; append-only triggers/grants; shipper + verifier; purge only after verification | `writer.test.ts`, `migration.test.ts`, `health.test.ts`, `shipper.test.ts`, `evidence-flow.test.ts`, `fixtures.test.ts` |
| OPS-01 / SAFE-03 route evidence during an audit outage (handoffs proceed; their events are appended later, in order, bounded) | `DeferredAuditQueue` | `deferred.test.ts`, `platform/src/worker/deferred-audit.test.ts` |
| DATA-01 no PHI to unapproved sinks/logs | strict schema + PHI-shape heuristics; content-free logs; driver errors dropped; metadata-only query | `schema.test.ts`, `writer.test.ts`, `query.test.ts` |
| AUTH-06 verification secrets never in ordinary logs/evidence | unknown keys rejected, no digit-run codes, session-ref pseudonymization | `schema.test.ts`, `writer.test.ts` |
| AUTH-02 / AUTH-05 audit reads authorized and tenant isolated | RLS on base table, tenant-filtered security-barrier view, no base-table grants to auditor/console | `migration.test.ts`, `query.test.ts` |
| OPS-03 missing evidence is not PASS | `assessCompleteness` returns INCONCLUSIVE without reconciliation/ingestion monitoring | `verifier.test.ts` |
| SPEC-13 tamper evidence, gaps, manifests, ingestion monitoring, reconciliation | `chain.ts`, `verifier.ts`, `shipper.ts` | `chain.test.ts`, `verifier.test.ts`, `shipper.test.ts`, `sinks/*.test.ts` |
| SPEC-6 retention classes / Object Lock | S3 sink requires approved class duration; Object Lock params | `sinks/s3-object-lock.test.ts` |
| ACT-02 no duplicate effect on retry/crash (shipping) | PLANNED manifest before put; identical re-put no-op | `shipper.test.ts`, `sinks/local-fs.test.ts`, `sinks/s3-object-lock.test.ts` |

## Known gaps

- A stream blocked by `AUDIT_CHAIN_GAP`/`AUDIT_CHAIN_BROKEN` stays blocked (its backlog
  eventually makes health block consequential actions). There is no automated "seal and
  continue" procedure; an operator runbook and an explicit gap-acknowledgement manifest are
  not implemented. Restarting the writer under a new stream name lets new events ship.
- The writer does not hard-cap local outbox growth; the bound is enforced by gating
  consequential actions through `AuditHealth`. Disk/storage alarms are an operations concern.
- PHI-shape checks are heuristics and cannot prove absence of PHI inside opaque tokens.
- Two shippers running concurrently on one stream are safe (unique planned start, idempotent
  re-put and mark) but may waste work; no advisory lock is taken.
- Access auditing is provided by `auditedSearch`; whether the console uses it is up to `console-api`.
- The deferred route-audit queue is process-local (see crash-loss limit above); a durable deferral
  store would need its own migration and an approved storage location. Only the business handoff
  uses it: gateway session/screening events (`GatewayAudit`) and `TransferCoordinator` transfer events
  written during an outage are still only logged (the coordinator counts them as `auditGaps`).
