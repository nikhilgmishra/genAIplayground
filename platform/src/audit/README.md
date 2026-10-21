# Audit evidence module (`platform/src/audit`)

Status: **IMPLEMENTED_OFFLINE**, with the follow-on WP-04 pieces **VERIFIED against protocol
emulators (Layer 2)**: postgres:16 provisioned as on Aurora (non-superuser owner, runtime roles
granted to an application login), MinIO with Object Lock, LocalStack KMS and DynamoDB Local
(`platform/test/integration/substrate`). Nothing here has run against Aurora, S3, KMS or the
audit account in AWS (environment NOT_CONFIGURED). This module does not establish HIPAA
compliance or production readiness.

Spec coverage: section 13 (audit event model, append-only independent store,
tamper-evident manifests, integrity checks, monitored ingestion gaps, completeness
reconciliation, bounded local outbox, block consequential actions when evidence
cannot be written), section 6 (retention classes, Object Lock), invariants
OPS-01, DATA-01, AUTH-06 (plus AUTH-02/AUTH-05 for reads and OPS-03 for "hashing is not completeness").

## What is implemented

| Component | File | Notes |
|---|---|---|
| Migration | `platform/migrations/0201_audit_evidence.sql` | `audit_outbox`, `audit_chain_heads`, `audit_manifests`, `audit_purge_watermarks`, `audit_sink_status`, `audit_write_probe`, view `audit_event_metadata`, triggers, RLS, grants, two security-definer functions |
| Strict input schema | `schema.ts` | Protocol `AuditEventInput` tightened: dotted `action` grammar (>= 2 segments), reason codes without 4+ digit runs, evidence pointers in the preferred URI form `^(s3\|db\|sf\|ledger\|wf\|kv)://[A-Za-z0-9/_.:@-]{3,190}$` or the typed opaque form `<kind>:<OpaqueId>` (value must be an opaque id), both with PHI-shape heuristics (email, phone, SSN, calendar dates) and no `..`/`//` segments; opaque `sessionRef`, `turn_` grammar, token grammar for `idempotencyKey`, `VersionLabel` for `policyVersion`, and an `occurredAt` from 1970 to 9999 (`StorableEventTime`: the ISO grammar also admits year 0000, which timestamptz refuses, so such an event is invalid at once instead of being deferred and never appended). Unknown keys rejected. Errors carry schema paths only, never values or unknown key names. |
| Hash chain | `chain.ts` | `hash = sha256(canonicalJson(event without hash))`; NDJSON batches; manifests; deterministic object keys `<stream>/<first12>-<last12>.ndjson`; pure `verifyChain`. |
| Writer | `writer.ts` (`PgAuditWriter`) | Per-instance stream (`auditStreamName(component, instanceId)`), sequence/prevHash/hash assigned under `SELECT ... FOR UPDATE` on the stream's chain head inside the caller's transaction (`append`) or its own (`appendStandalone`). Every storage failure becomes `AuditUnavailableError` (`AUDIT_STORE_UNWRITABLE`, `AUDIT_CHAIN_CONTENTION`, `AUDIT_TENANT_CONTEXT_MISMATCH`, ...). Driver errors (which carry SQL text and bound parameters) are dropped. Bearer session refs (`ses_...`) are stored only as a one-way pseudonym (`sref_...`, see `pseudonymousSessionRef`); hash-derived binding refs (`ses_bnd_...`) are kept as given. Rejects events stamped > 300 s in the future. |
| Health | `health.ts` (`PgAuditHealth`) | Bounded buffering: write probe (privileges, not a read replica, probe row upsert) AND backlog count <= `maxBacklog` AND oldest unshipped age <= `maxBacklogAgeSeconds`. Reasons, in precedence order: `AUDIT_STORE_UNWRITABLE`, `AUDIT_BACKLOG_EXCEEDED`, `AUDIT_SINK_STALE`. `assertCanAcceptConsequential()` throws `AuditUnavailableError`. Optional `cacheTtlMs` (<= 10 s) reuses healthy results only. |
| Shipper | `shipper.ts` (`AuditShipper`) | Per stream, in sequence order: plan batch (recorded `PLANNED` locally first) -> `sink.putBatch` -> mark rows shipped + manifest `SHIPPED` in one transaction. Idempotent across a crash/lost response between put and mark (re-puts exactly the planned batch). Re-verifies hashes and links before planning; refuses to ship across a gap or broken link (`AUDIT_CHAIN_GAP` / `AUDIT_CHAIN_BROKEN`). Records sink health. `purgeVerified(stream)` deletes the local prefix only through the purge function. |
| Sinks | `sinks/local-fs.ts`, `sinks/s3-object-lock.ts` | See LOCAL FIXTURE / BLOCKED below. Both refuse inconsistent batches (digest, key, range, line count). |
| Integrity verifier | `verifier.ts` (`IntegrityVerifier`) | `verifyStream` (schema, recomputed hashes, links, gaps, column/document consistency, chain head for tail truncation, purge watermark), `verifyShipped` (per-manifest digest and content, continuity across manifests from sequence 1, overlap, local SHIPPED manifests missing from the sink, local rows diverging from the shipped copy; `markVerified` sets `verified_at` only when the whole shipped stream is clean), `detectIngestionGaps` (STREAM_SILENT, COUNT_SHORTFALL, COUNT_EXCESS, UNKNOWN_STREAM, SINK_INGESTION_LAG against source-reported counts), `observedActionKeys`. Pure `reconcileCounts(expectedBySourceAction, observed)` (keyed or counted) and `assessCompleteness` (PASS only if integrity, ingestion monitoring AND reconciliation all ran clean; otherwise FAIL or INCONCLUSIVE). |
| Completeness monitor | `monitor.ts` (`AuditCompletenessMonitor`, worker loop `audit.verify`, OPS-AUD-01) | Every run: `verifyStream` and (with a sink reader) `verifyShipped` per stream; writer chain head vs rows present (`COUNT_SHORTFALL` / `COUNT_EXCESS`) and unshipped events past the export grace (`SINK_INGESTION_LAG`); keyed reconciliation of every COMMITTED ledger action in the lookback (default 24 h) against its commit audit event (`receipt.auditEventId`, `action.commit.succeeded` / `action.reconciled`, same tenant, `idempotencyKey` = the ledger's `provider_idempotency_key`; events purged after verified shipping are left to `verifyShipped`); `assessCompleteness`. No sink reader => `SHIPPED_INTEGRITY_NOT_VERIFIED`, never PASS. Emits `vsp_audit_ingestion_gaps_total{source_component}` + unlabelled aggregate (findings + gaps + discrepancies; 0 every run as a heartbeat for the critical alarm, which treats missing data as breaching), `vsp_audit_export_completeness_ratio{source_component}` + overall (shipped / events older than the grace; 1 when none due) and `vsp_audit_backlog_events`. A FAIL verdict is reported through details, metrics and an error-level log (codes and counts only), not as a loop failure. Stream -> label: `runtime` -> `gateway`, a known component prefix -> itself, anything else -> `worker`. |
| Query | `query.ts` (`PgAuditQuery`, `auditedSearch`) | Metadata-only search (tenant, correlationId, callId, action, half-open time range, `limit` 1..200) via `audit_event_metadata` as `app_auditor` or `app_console`. `auditedSearch` records the access as an `audit.query.executed` event and returns nothing if that record cannot be written. |
| Deferred route audit | `deferred.ts` (`DeferredAuditQueue`, port `DeferredAuditSink` in `ports.ts`) | ROUTE evidence only (human / safety handoff events whose route must proceed during an audit outage, OPS-02/SAFE-03). `appendOrDefer` appends now; when the store is unwritable the event is kept in a bounded, process-local FIFO (default 1000, `maxEntries` 1..10000) and appended later, in deferral order, by `flush` (skipped while `AuditHealth` reports `AUDIT_STORE_UNWRITABLE`) or by the next `appendOrDefer`, which first drains up to 16 older entries. Only the process holding the queue can drain it: the worker runs the loop `audit.deferred_flush`; the gateway-only entry point (`platform/src/main/server.ts`, no worker loops) runs `DeferredAuditFlushTimer` (unref'd timer, default every 5 s, at most 100 events per run, never overlapping, never throwing) and on graceful shutdown, once its listener closed, the open responses were drained (bounded, default 5 s), the app force-closed the rest and their route handlers settled (bounded, default 10 s; `server.shutdown_handlers_unsettled` at error level with the count when that bound expires), `stop()` waits for `appendOrDefer` calls in progress (`inProgress`), drains the queue in bounded batches for at most `finalFlushTimeoutMs` (default 5 s) and logs any event still queued, and any append still running, as `audit.deferred.unflushed_at_shutdown` (error level; `remaining`, `inProgress` and the reason code); that bound's own timer is not unref'd, so the process stays alive until the loss is logged even when a stuck flush holds no handle of its own. In the same synchronous step `stop()` seals the queue (`seal()`): an event that reaches `appendOrDefer` later and cannot be appended at once is then not queued (nothing would flush it) but dropped, counted as `vsp_audit_deferred_total{result="dropped",reason="store_unavailable"}` and logged at error level as `audit.deferred.lost_at_shutdown` (reason `AUDIT_DEFERRED_AFTER_SHUTDOWN`, with the store's reason and a running count); a direct append that succeeds still works. **Limit:** the queue reports only what reaches it while the process is alive; a caller that has not called `appendOrDefer` when the process exits loses its event without a log from this module, which is why the gateway entry waits for its handlers first and logs, by count, the ones it gave up on. It does not wait for a route-tool execution that its tool timeout detached from the request (the pipeline answered `TIMEOUT` while the handoff work continues, because `withTimeout` does not cancel the module): if the process exits before that work reaches the queue, its route evidence is lost **with no log**; detect it from `TIMEOUT` results and `vsp_timeouts_total` for `request_human_transfer` / `request_safety_route` shortly before a stop, cross-checked against transfer journeys and `safety_events`. The follow-on durable route journal replaces this process-local queue. Every `flush` reports `vsp_audit_deferred_depth`, also 0 for an empty queue, as a heartbeat for the sustained-depth alarm (`infra/terraform/modules/observability`). Each late event keeps its original `occurredAt` and is followed by an `audit.deferred.recorded` marker (`parentId` = the late event, `reasonCode` = why it was deferred). Overflow drops the NEW event, counted and logged at error level; an event the writer refuses as invalid is dropped loudly. Metrics `vsp_audit_deferred_total{result,reason}`, `vsp_audit_deferred_depth`, `vsp_audit_deferred_age_ms`; error-level `audit.deferred.queued` / `audit.deferred.dropped` / `audit.deferred.unflushed_at_shutdown` / `audit.deferred.lost_at_shutdown` logs (action codes, opaque ids, reason codes and counts only). **Crash-loss limit:** the queue is in process memory, so a crash or restart loses queued events; the `safety_events` row (audit_status `AUDIT_UNAVAILABLE`) remains the durable incident record for a safety route. **Never for consequential mutations** (they stay blocked by `assertCanAcceptConsequential` and the in-transaction `append`). |
| Helpers | `build-input.ts` | `buildAuditInput(fields, clock?)` fills defaults (`dataClass: SECURITY_AUDIT`, nulls, `[]`) and validates strictly. `auditFieldsFromAuth(authContext)` copies the server-established identity fields. |
| Fixtures | `fixtures.ts`, `testing.ts` | See LOCAL FIXTURE below. |

### Follow-on WP-04: durable route journal, independent export, separate verifier

| Component | File | Notes |
|---|---|---|
| Migrations | `platform/migrations/2040_route_audit_journal.sql`, `2042_audit_verifier_role.sql`, `2045_audit_deferred_evidence_guard.sql` (a deferral starts PENDING with nothing recorded and becomes RECORDED only together with the chained deferred event and its `audit.deferred.recorded` marker) | `audit_deferred` (journal of route events whose append was refused; PENDING / RECORDED / DROPPED, digest-checked input, `journal` postgres or dynamodb), `route_audit_intents` (opened before a detached route execution; OPEN / RECORDED / NOT_RECORDED), `route_audit_reconciliations` (one row per reconciled safety incident or intent). Guard triggers, FORCE RLS, column grants. 2042 creates the read-only role `app_audit_verifier` (SELECT on the audit tables and the reconciliation columns of `action_ledger`, `support_requests`, `audit_deferred`, `route_audit_reconciliations`, `inbound_events` metadata; no write grant anywhere). |
| Durable route journal | `journal.ts` (`DurableDeferredAuditQueue`, `DynamoRouteAuditJournal`) | Replaces the process-local `DeferredAuditQueue` for route evidence (FO-01-19, FO-15-45). `appendOrDefer` appends now or journals the event in `audit_deferred` (own transaction); `appendOrDeferIn(tx, ...)` does the same inside the handoff's own transaction under a savepoint, so a route record never commits without its evidence or its deferral. When PostgreSQL refuses the deferral, the event goes to the independent DynamoDB journal (conditional put, `pk raj#<tenant>`, `sk <deferredAt>#<deferralId>`); only when both refuse is it held in a bounded memory list (loud `audit.journal.memory_fallback`). `flush` drains DynamoDB and memory into `audit_deferred`, then appends each PENDING deferral exactly once, in deferral order, with its `audit.deferred.recorded` marker, in ONE transaction per deferral (tenant advisory lock 7300040, `FOR UPDATE`); invalid entries are DROPPED loudly. **Tenant order across the stores:** before a direct append, `appendOrDefer` checks what waits for the tenant in `audit_deferred`, in the independent journal (entries another replica wrote while PostgreSQL refused) and in memory; when anything waits it first moves those entries into `audit_deferred` and drains up to `maxInlineDrain` in order, and journals the new event behind whatever remains (`AUDIT_DEFERRED_QUEUE_PENDING`); `appendOrDeferIn` journals behind them without draining. When a journal cannot be read, the new event is journaled (`AUDIT_JOURNAL_READ_FAILED`), never appended ahead of what that journal may hold, and the tenant's flush appends nothing until the independent journal can be read again: route evidence then waits durably in `audit_deferred` (`vsp_audit_journal_pending`; past the grace, a verifier discrepancy). Order is deferral time (`deferredAt`); at the same instant an entry first journaled in DynamoDB goes first; then journal order. Deferral times are strictly increasing per queue instance, and an event journaled behind older entries is timed after the newest of them (the newest pending `audit_deferred` row, the newest pending DynamoDB item - `newestPendingMs`, a newest-first query - and the newest memory entry; clamped to 60 s ahead of its clock), so it never ties with or precedes them, also when another replica with a clock ahead wrote them (an entry timed further ahead, by a skewed clock or a forged row, can be ordered after it instead of pushing deferral times into the future); across replicas that did not see each other's entries, order is as good as their clock synchronisation. **Bounded flush:** the DynamoDB read of a pass is bounded (valid and rejected items both count); when it is cut at the bound, older entries may still wait there, so the pass appends only deferrals it read or whose deferral time is below the greatest sort key read, and leaves newer rows `PENDING` for the next pass (the inline drain of `appendOrDefer`, `maxInlineDrain`, is bounded the same way). **Integrity of the DynamoDB journal:** every item read back is re-validated (schema, input digest, the tenant partition it was read from, sort key = `deferredAt#deferralId`, a canonical deferral time - `isCanonicalDeferralTime`: the exact `toISOString` form of an instant from 1970 to 9999, so `2026`, which `Date.parse` accepts and timestamptz refuses, is invalid - and an event time the audit store holds, see `schema.ts`); `read` returns valid entries and rejected items separately (`pending` is the strict variant). An item whose content PostgreSQL refuses when the drain inserts it (SQLSTATE class 22, NOT NULL or CHECK violation) is rejected the same way; any other refusal (connection, privilege, read-only) quarantines nothing. A rejected (tampered or corrupted) item is never appended and never blocks the tenant: the drain first appends `audit.journal.entry_quarantined` to the chain (outcome FAILED, reason `AUDIT_JOURNAL_ENTRY_DIGEST_MISMATCH` or `AUDIT_JOURNAL_ENTRY_INVALID`, pointer `kv://route-audit-journal/<sha256 of the sort key>`, correlation id derived from it), then marks the item QUARANTINED (conditional on PENDING, content kept for forensics); counted as `vsp_audit_journal_entries_total{journal="dynamodb",result="dropped"}` and in the flush's `dropped`, logged `audit.journal.quarantined` (reference and reason only). While that record cannot be written (audit store unwritable) the item stays PENDING and newer route events wait behind it; a crash between the two steps repeats the record under the same correlation id. Every flush recounts what waits per store into `remaining`, `depth`, `vsp_audit_deferred_depth` and `vsp_audit_journal_pending{journal="postgres"|"dynamodb"|"memory"}` (`dynamodb` only with an independent journal), also while `AuditHealth` reports the audit store unwritable (nothing is appended then, but both journals are still counted); a store that cannot be counted (PostgreSQL down, DynamoDB unreadable) keeps its last known count instead of reading 0, so evidence held in DynamoDB during a PostgreSQL outage stays visible, and a store this process has never counted (it started during that store's outage) reports no gauge value at all rather than 0 (the flush's `reasonCode`, e.g. `DB_UNAVAILABLE`, says why). Survives SIGKILL and SIGTERM (Layer 2: `route-audit-crash.test.ts`, including the cross-replica order across the DynamoDB journal). Metrics `vsp_audit_journal_entries_total{journal,result}`, `vsp_audit_journal_pending{journal}` plus the legacy deferred metrics. |
| Route reconciler | `route-reconciler.ts` (`RouteAuditReconciler`, `PgRouteAuditIntents`) | FO-01-34, FO-15-48: every safety incident in `safety_events` older than the grace (>= 60 s, default 300 s) is matched to route evidence (an audit event or a deferral of `handoff.safety_requested` / `handoff.safety_transfer_failed` / `safety.route.initiated` for the call); none => an `audit.route.not_recorded` marker; evidence but rows written during an outage => `audit.safety_event.unaudited`. Every route intent past its deadline without evidence => `audit.route.not_recorded`. Only route evidence of the intent's kind resolves an intent (`journal.ts` `routeKindOfAction`, also in the deferred sink's `resolveIntents`): a `SAFETY_ROUTE` intent needs `handoff.safety_*` or `safety.route.*`, a `HUMAN_TRANSFER` intent any `handoff.*` or `safety.route.*` event (a human transfer escalated to a safety route is audited); any other event that merely carries the correlation id never closes one. Exactly once per subject (advisory lock 7300041 + unique row), proven with two concurrent reconcilers on postgres:16. Metric `vsp_route_audit_reconciled_total{subject,result}`. |
| Manifest signatures | `exporter/signer.ts` (`KmsManifestSigner`, `ManifestSignatureVerifier`) | FO-15-38: KMS `Sign` (ECDSA_SHA_256, MessageType RAW, key ECC_NIST_P256 / SIGN_VERIFY checked with `GetPublicKey`) over `"vsp.audit.manifest.sig.v1\n" + canonical manifest without signature`. The shipper signs at plan time, so the PLANNED record and every re-put carry the identical signed manifest; a live sink refuses to ship unsigned (`AUDIT_MANIFEST_SIGNER_REQUIRED`). The verifier trusts public keys only (`trustKms` reads the public key) and classifies VALID / UNSIGNED / PARTIAL / UNTRUSTED_KEY / INVALID / WRONG_SIGNER_ROLE. `LocalManifestSignerFixture` and `exporter/testing.ts` `KmsSignStubFixture` are labelled unit-test fixtures. |
| Exporter | `exporter/exporter.ts` (`AuditExporter`) | The shipper with a signer, as its own task identity (WRITER sink credentials; entry point `platform/src/main/audit-exporter.ts` is WP-07's). Metric `vsp_audit_manifest_signatures_total{result}`. |
| Separate verifier | `exporter/verifier.ts` (`AuditExportVerifier`) | FO-15-40, FO-15-41, FO-22-08: connects with its OWN login (granted `app_audit_verifier` only) and runs every transaction as `app_audit_verifier`; `checkIdentity` judges the login, not just the acting role — the session user and, on PostgreSQL, the backend's authenticated login (`pg_stat_activity`), with every role they can reach — and refuses a verdict (`VERIFIER_IDENTITY_NOT_READ_ONLY`, failed conditions in `identity.findings`: `VERIFIER_LOGIN_PRIVILEGED`, `VERIFIER_LOGIN_WRITER_MEMBER`, `VERIFIER_LOGIN_OWNS_OBJECTS`, `VERIFIER_IDENTITY_CAN_WRITE`, `VERIFIER_IDENTITY_DEFINER_WRITE_PATH`, `VERIFIER_IDENTITY_CAN_CREATE`, `VERIFIER_LOGIN_UNRESOLVED`). The sink is read with READER credentials distinct from the exporter's writer (`exporter/sts.ts`: STS session policies list/get vs put, enforced by MinIO in Layer 2). Integrity (local and shipped), manifest signatures, ingestion gaps, and KEYED reconciliation against exported evidence: committed actions (the receipt's commit event, same tenant, a commit-evidence action, bound to the ledger's provider idempotency key), provider receipts (that commit event references the receipt id), CRM writes (`support_request.synced` per SYNCED request) and route evidence (no deferral pending past the grace; every deferral marked RECORDED has its route event exported — same tenant, action and correlation; every not-recorded marker is the tenant's exported `audit.route.not_recorded` event). Each source reports `expected` / `observed` / `unverified` / `discrepancies`. Without signature keys: INCONCLUSIVE (`SIGNATURES_NOT_VERIFIED`), never PASS. Without a sink reader the exported copy cannot be read, so reconciliation runs against the LOCAL outbox: evidence already shipped, or possibly purged after a verified export, is `unverified` (`RECONCILIATION_NOT_VERIFIED_WITHOUT_SINK`), never missing and never observed, and the verdict is INCONCLUSIVE (`SINK_READER_NOT_CONFIGURED`, CLI exit 2) — unless something is visible locally: a local chain gap, an ingestion gap, a deferral pending past the grace, evidence unshipped past the grace (known not exported), a local event that contradicts the ledger, deferral or marker (another tenant, action, key, correlation or receipt), or — when no stream was ever purged — evidence that was never written. Those FAIL (exit 1) with or without the reader. Metrics `vsp_audit_verifier_runs_total{verdict}`, `vsp_audit_reconciliation_discrepancies_total{source}`. |
| Command | `exporter/verify-cli.ts`, `scripts/vsp/verify-audit.mts` | FO-19-82. `--env local --database <db> [--bucket <b>] [--kms-key <arn>]`; exit 0 PASS, 1 FAIL, 2 INCONCLUSIVE, 3 usage, 4 dependency. `--env live` needs `VSP_AUDIT_VERIFY_LIVE=1` and the verifier's own credentials; never from a default command. |
| Event fields | `platform/src/protocol/audit.ts`, `build-input.ts` | FO-15-34: optional `sourceSequence`, `contextSnapshotId`, `configDigest`, `receiptRefs`, `ingress` (source, payload digest, schema, actual authentication mechanism, credential version). Absent fields hash exactly as before. |

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
   The process that holds the queue must run `DeferredAuditQueue.flush`: the worker loop
   `audit.deferred_flush`, or `DeferredAuditFlushTimer` in a process without worker loops (the
   gateway-only entry point), whose `stop()` runs once the process stopped taking work (in the
   gateway: listener closed, open responses drained, the rest force-closed, and their handlers
   settled or the bounded wait for them expired) and before the database closes. `stop()` waits
   for appends in progress and seals the queue, so an event that reaches the queue later is
   reported lost, not queued. A caller that never reaches the queue before the process exits is
   invisible to it: its process must wait for its own work first (see
   `platform/src/main/server.ts`).

Operations wiring: the worker runs `AuditShipper.runOnce()` (`audit.ship`) and the
completeness monitor (`audit.verify`, `monitor.ts`), which verifies integrity, monitors
ingestion, reconciles the action ledger and publishes the audit-export metrics (spec
section 13). Still NOT scheduled: `verifyShipped(stream, { markVerified: true })` followed by
`purgeVerified(stream)` (local rows are kept; purging is an operations decision), and
`detectIngestionGaps` with independent per-source counters (the monitor uses the writer chain
heads as the source count).

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
| `S3ObjectLockAuditSink` against a real bucket | No audit account, bucket, KMS key or IAM role exist; no approved retention | Audit AWS account with an Object Lock-enabled, versioned bucket; audit-account KMS key; the roles of `infra/terraform/modules/audit`: the WRITE-ONLY writer role (`s3:PutObject` + `kms:GenerateDataKey` via S3; explicitly denied `s3:GetObject*`, `s3:ListBucket*`, `kms:Decrypt`) for the shipper, and the READ-ONLY verifier role (`verifier_principal_arns`, `s3:GetObject`/`s3:ListBucket` + `kms:Decrypt` via S3, never a writer) for `audit.verify` (platform/security); Object Lock mode decision COMPLIANCE vs GOVERNANCE (security + counsel) |
| Shipped-object verification in a live composition | The live composition is not implemented; `audit.verify` and `AuditExportVerifier` must run under the verifier identity, in a task whose role is not a writer | Live composition with a verifier-identity `S3ObjectLockAuditSink` passed to `AuditCompletenessMonitor({ sink })` and `AuditExportVerifier({ sink })` (WP-07 entry point, WP-39 IAM); until then a run without a reader is INCONCLUSIVE when nothing is visible locally, FAIL when a local finding is |
| Retention duration for `SECURITY_AUDIT` | Spec forbids inventing a duration; `PlatformConfig.retention.SECURITY_AUDIT` is null | Counsel-approved duration per data class; the sink refuses to start with `null` (`AUDIT_RETENTION_UNAPPROVED`) |
| Independently administered account controls (separate admins, deletion restrictions, SCPs) | Infrastructure, not application code | Terraform audit-account stack + approvals (infra module) |
| Real multi-connection concurrency on Aurora | PGlite serializes transactions. Now exercised on postgres:16 with several pools (Layer 2: `substrate/route-audit-crash.test.ts`, `contention.test.ts`, and the audit unit suites re-run on postgres:16 through `VSP_TEST_DB=pg` in `pg-pool.test.ts`); Aurora itself is not | Sandbox Aurora run (AIN-01) |

The S3 sink has two layers of tests. The unit contract test (`sinks/s3-object-lock.test.ts`, an injected
client) asserts the exact `PutObject` / `HeadObject` / `GetObject` / `ListObjectsV2` inputs
(`ObjectLockMode`, `ObjectLockRetainUntilDate = now + approved days`, `ChecksumAlgorithm: "SHA256"`
+ `ChecksumSHA256`, `IfNoneMatch: "*"`, SSE-KMS key, `ExpectedBucketOwner`). Layer 2 runs the same sink against
MinIO with Object Lock: `test/integration/_harness/audit-sink.test.ts` (WP-03: 412 on an existing key, retention
headers) and `test/integration/substrate/audit-export.test.ts`, `audit-reconciliation.test.ts` and `faults.test.ts`
(GOVERNANCE retention and SSE-KMS asserted on the stored objects; the exporter writes with put-only and the
verifier reads with list/get-only STS session credentials, both enforced by MinIO). MinIO is not AWS: the
audit-account administration, SCPs and IAM principals are environment controls (AIN-01, AIN-03).

412 handling (OPS-AUD-02) follows the audit IAM: the writer role can never read evidence
(HeadObject is authorized as `s3:GetObject`, and the stored checksum of an SSE-KMS object needs
`kms:Decrypt`; both are denied). With `existingObjectCheck: "defer_to_verifier"` (default) a
412 on the batch's deterministic key (a lost response, or a crash before the manifest or the
local mark) is accepted without reading and counted in `existingObjectsUnverified`; the
read-only verifier identity then proves the stored content (`verifyShipped`:
`MANIFEST_DIGEST_MISMATCH`, `MANIFEST_CONTENT_MISMATCH`, `LOCAL_SINK_DIVERGENCE`), and local rows
are purged only after a clean verification, so a foreign object at our key is detected and the
local copy is kept. Before this, a lost response wedged the stream (`AUDIT_SINK_UNAVAILABLE` on
every retry) until `AUDIT_SINK_STALE` blocked every consequential action. `"head_checksum"`
(the previous behaviour) is only for an identity allowed HeadObject + kms:Decrypt.
`sinks/s3-iam-model.test.ts` models the Terraform permissions per identity (writer: PutObject
only; verifier: List/Get only) end to end with the shipper, `PgAuditHealth` and
`verifyShipped`. None of this proves that a real bucket enforces Object Lock.

## How to test

```bash
cd platform
npx vitest run src/audit                                          # all audit tests (PGlite, offline)
make -C .. test-integration SUITE=substrate                        # Layer 2: postgres:16, MinIO, LocalStack KMS, DynamoDB Local
tsx ../scripts/vsp/verify-audit.mts --env local --database <db> --bucket <bucket> --kms-key <arn>
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
| OPS-03 missing evidence is not PASS | `assessCompleteness` returns INCONCLUSIVE without reconciliation/ingestion monitoring; `AuditExportVerifier` without a sink reader reports shipped evidence as `unverified` (INCONCLUSIVE, never PASS, never a false FAIL) and still FAILs local findings | `verifier.test.ts`, `exporter/verifier.test.ts`, `test/integration/substrate/audit-export.test.ts`, `audit-reconciliation.test.ts` |
| SPEC-13 tamper evidence, gaps, manifests, ingestion monitoring, reconciliation | `chain.ts`, `verifier.ts`, `shipper.ts`, `monitor.ts` (running continuously as worker loop `audit.verify`, OPS-AUD-01) | `chain.test.ts`, `verifier.test.ts`, `shipper.test.ts`, `monitor.test.ts`, `sinks/*.test.ts` |
| OPS-01 availability: crash/lost-response recovery under the write-only writer IAM (OPS-AUD-02) | `sinks/s3-object-lock.ts` `existingObjectCheck: "defer_to_verifier"`; verifier role in `infra/terraform/modules/audit` | `sinks/s3-iam-model.test.ts`, `infra/terraform/modules/audit/tests/audit.tftest.hcl` |
| SPEC-6 retention classes / Object Lock | S3 sink requires approved class duration; Object Lock params | `sinks/s3-object-lock.test.ts` |
| ACT-02 no duplicate effect on retry/crash (shipping) | PLANNED manifest before put; identical re-put no-op | `shipper.test.ts`, `sinks/local-fs.test.ts`, `sinks/s3-object-lock.test.ts` |

## Known gaps

- A stream blocked by `AUDIT_CHAIN_GAP`/`AUDIT_CHAIN_BROKEN`/`AUDIT_PLANNED_BATCH_DIVERGED`
  (or, in `head_checksum` mode, `AUDIT_SINK_OBJECT_EXISTS`) stays blocked, and its backlog
  eventually makes `AuditHealth` (`AUDIT_SINK_STALE`, computed over all streams) block every
  consequential action. That is the bounded-buffer policy failing closed. There is no "seal
  and continue" procedure: excluding a sealed stream's backlog from health needs a new audit
  migration (a seal record + a revised `audit_backlog_stats()`), an explicit
  gap-acknowledgement manifest and a security-approved runbook; restarting the writer under a
  new stream name does not unblock health because the old backlog still counts. The common
  crash / lost-response case no longer wedges (see 412 handling above).
- The writer does not hard-cap local outbox growth; the bound is enforced by gating
  consequential actions through `AuditHealth`. Disk/storage alarms are an operations concern.
- PHI-shape checks are heuristics and cannot prove absence of PHI inside opaque tokens.
- Two shippers running concurrently on one stream are safe (unique planned start, idempotent
  re-put and mark) but may waste work; no advisory lock is taken.
- Access auditing is provided by `auditedSearch`; whether the console uses it is up to `console-api`.
- The process-local `DeferredAuditQueue` is superseded by `DurableDeferredAuditQueue` (journal.ts) but
  the composition root still constructs the old queue: wiring the durable journal, the reconciler loop
  and handoff route intents into `platform/src/main/container.ts`, the gateway's detached route
  execution and the business handoff belongs to WP-07 / WP-14 / WP-25 (not owned here). Gateway
  session/screening events (`GatewayAudit`) and `TransferCoordinator` transfer events written during an
  outage are still only logged (the coordinator counts them as `auditGaps`).
- The memory last resort of the durable journal is lost on a crash (both durable journals refused);
  the route reconciler then surfaces the gap as `audit.route.not_recorded`.
