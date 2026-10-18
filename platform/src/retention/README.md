# platform/src/retention: retention policies, legal holds, deletion jobs and verification

Status: **IMPLEMENTED_OFFLINE** (PGlite). No retention duration has been set by
anyone authorized to set it; every class is `BLOCKED_RETENTION_UNSET` until privacy
counsel approves a schedule. No claim of HIPAA compliance or production readiness.

Spec: section 6 (four data classes; retention by class and legal purpose; no
universal duration; enforceable lifecycle; legal holds; vendor deletion requests;
deletion verification for derived copies, indexes, caches and backups), DATA-03.

## What is implemented

| File | Responsibility |
|---|---|
| `../../migrations/0800_retention.sql` | `retention_policies` (versioned, append-only; NULL duration = unset; a duration requires approval id, approver and legal purpose by CHECK), `legal_holds` (never deleted; released once), `retention_runs`, `deletion_records` and `deletion_verifications` (append-only evidence: counts, digests, opaque refs only), `vendor_deletion_requests` (forward-only status, CONFIRMED requires evidence). RLS by tenant on every table. |
| `ports.ts` | Dataset, verifier, report and approval-verifier types. |
| `registry.ts` | `DatasetRegistry` (strict identifier validation, quoted SQL identifiers, optional composite `keyColumns`, configuration digest for `ReleaseManifest.retentionConfigurationDigest`); `SUPPORT_MEMORY_DATASET`. |
| `datasets.ts` | Platform datasets and `createPlatformDatasetRegistry()` (see "Registered datasets"). |
| `policies.ts` | `RetentionPolicyStorePg` (MFA `security_admin`/`policy_approver`; a duration needs a `RETENTION_SCHEDULE` approval accepted by the injected verifier), `LegalHoldStorePg` (class / dataset / subject / record / tenant-wide scope, reason codes only), `VendorDeletionQueuePg` (operator transitions with evidence). Optional audit events in the same transaction. |
| `job.ts` | `RetentionJob.run(now)`; `pendingVendorDeletions()` (PENDING_VENDOR requests per vendor, for `vsp_vendor_deletion_requests_pending`). |
| `verifiers.ts` | `derivedTableVerifier` (derived tables/indexes), `cacheVerifier` (in-process caches), `unverifiableCopy` (backups / vendor copies: always reported UNVERIFIABLE). |
| `testing.ts` | `TestOnlyRetentionApprovalVerifierFixture` (LOCAL FIXTURE). |

### RetentionJob.run(now)

Per tenant and data class:

1. No policy, or a NULL duration => `BLOCKED_RETENTION_UNSET`; the job deletes nothing in that class. A duration is never invented.
2. Optional cross-check with `PlatformConfig.retention`: disagreement => `BLOCKED_RETENTION_CONFIG_MISMATCH`.
3. Otherwise, per registered dataset of the class, rows older than `now - retentionDays` that no active legal hold covers are deleted in bounded batches (`batchSize`, `maxBatchesPerDataset`). Each batch writes in the **same transaction**: the deletion, an append-only `deletion_records` row (counts, key digest, policy version, approval id, cutoff; no content), `vendor_deletion_requests` for vendor copies (`PENDING_VENDOR`; only opaque refs stored, others counted as rejected) and, when configured, a `retention.delete` audit event. Any failure rolls the batch back (OPS-01).
4. After commit, every derived-copy verifier runs over the deleted keys; results are stored in `deletion_verifications` and leftovers / unverifiable copies are reported in `unverifiedCopies` (run status `COMPLETED_WITH_UNVERIFIED_COPIES`). Unverifiable copies are never reported as deleted (OPS-03).
5. A subject-scoped hold on a dataset without a subject column cannot be resolved per row: the dataset is not touched (`HELD_SUBJECT_HOLD_UNRESOLVABLE`).
6. `CRYPTO_SHRED` is reported `STRATEGY_BLOCKED` (`RETENTION_CRYPTO_SHRED_BLOCKED`), never simulated; `APPEND_ONLY_PURGE_REQUIRED` (stores whose trigger refuses DELETE by design) is reported `STRATEGY_BLOCKED` (`RETENTION_PURGE_PATH_REQUIRED`).
7. Before deleting, the job checks the worker role's DELETE privilege on the table: without it the dataset is `STRATEGY_BLOCKED` (`RETENTION_DELETE_PRIVILEGE_MISSING`). If expired, unheld rows exist but none could be deleted (for example no row-level DELETE policy), the dataset is `FAILED` (`RETENTION_DELETE_BLOCKED`), never `NOTHING_EXPIRED`.
8. Composite-key datasets (`keyColumns`) are matched on the whole key tuple; the evidence key (digest, record-level holds) is the key columns joined with `/`.

### Registered datasets (`datasets.ts`, `createPlatformDatasetRegistry()`)

Every class stays `BLOCKED_RETENTION_UNSET` until counsel approves a duration. Data classes are
engineering classifications pending the counsel-approved retention matrix (PRQ-025).

| Dataset | Table (migration) | Class | Timestamp | Strategy | Derived copies / vendor copies |
|---|---|---|---|---|---|
| `support_memory` | `support_memory` (0700) | BUSINESS_RECORD | `created_at` | HARD_DELETE | — |
| `support_requests` | `support_requests` (0300) | BUSINESS_RECORD | `created_at` | APPEND_ONLY_PURGE_REQUIRED | `support_request_links_by_request` (derived table), `database_backups` (UNVERIFIABLE); vendor `salesforce` via `salesforce_case_id` |
| `support_request_links` | `support_request_links` (0300) | BUSINESS_RECORD | `created_at` | APPEND_ONLY_PURGE_REQUIRED | `database_backups` |
| `support_interactions` | `support_interactions` (0300) | BUSINESS_RECORD | `created_at` | APPEND_ONLY_PURGE_REQUIRED | `support_requests_by_interaction` (derived table), `database_backups` |
| `interaction_actions` | `interaction_actions` (0300) | BUSINESS_RECORD | `created_at` | APPEND_ONLY_PURGE_REQUIRED | `database_backups` |
| `interaction_outcomes` | `interaction_outcomes` (0300) | BUSINESS_RECORD | `recorded_at` | APPEND_ONLY_PURGE_REQUIRED | `database_backups` |
| `tool_request_idempotency` | `tool_request_idempotency` (0105) | TRANSIENT_CONVERSATION | `created_at` | HARD_DELETE, key (`integration_id`, `idempotency_key`) | `database_backups` |
| `console_idempotency` | `console_idempotency` (0900) | SECURITY_AUDIT | `created_at` | HARD_DELETE, key (`staff_id`, `endpoint`, `idempotency_key_hash`) | `database_backups` |

* The 0300 support records are append-only by design (trigger `support_records_no_delete` /
  `interaction_actions_guard` refuse DELETE for every role); deleting them needs a reviewed purge
  path from the business owner (BLOCKED below).
* `console_idempotency` grants nothing to `app_worker` (console migration 0900, which sorts after
  every migration range this module owns), so the job reports `RETENTION_DELETE_PRIVILEGE_MISSING`
  until the console owner adds, in a 09xx migration, column-level SELECT (`tenant_id, staff_id,
  endpoint, idempotency_key_hash, created_at, expires_at`), DELETE and tenant RLS select/delete
  policies for `app_worker`.
* The composition root must use `createPlatformDatasetRegistry()` instead of registering only
  `SUPPORT_MEMORY_DATASET` (`platform/src/main/container.ts`, outside this module).

## LOCAL FIXTURES

* `TestOnlyRetentionApprovalVerifierFixture` accepts listed synthetic approval ids; it is not an approval record and verifies no signature.
* Tests use TEST-ONLY placeholder durations (labelled in `retention.test.ts`) and synthetic test tables.

## BLOCKED (and the prerequisite needed)

| Item | Why | Prerequisite |
|---|---|---|
| Any retention duration, legal purpose per class | Set by privacy counsel; must not be invented | RETENTION_SCHEDULE approval (PRQ-025, AR-11) |
| Binding the approval verifier to signed approval records | Requires the trusted signing key and a `RETENTION_SCHEDULE` record | PRQ-023/PRQ-024 (config module approvals loader) |
| Vendor deletion API calls (Talkdesk recordings/transcripts, Salesforce, speech vendors) | No documented, verified deletion API in scope; must not invent endpoints | Vendor written answers (e.g. VQ-TD-05) and sandbox access; until then operators record evidence manually |
| Backup / snapshot deletion verification | Aurora snapshots and S3 versions age out under infrastructure retention, not verifiable from the app | Infrastructure retention settings approved and evidenced |
| Crypto-shredding | Needs per-record KMS key design and approval | Security architecture decision |
| Registration of the remaining datasets (transcripts, recordings, audit evidence, workflow history, durable grants, reconciliation records, safety events) | Each owner must declare table, class, subject column and derived copies; several are append-only by design | Owning modules + retention matrix |
| Purge path for the append-only 0300 support records | Their triggers refuse DELETE for every role by design; a purge must not weaken that control silently | Business owner: a reviewed purge migration (e.g. a narrow SECURITY DEFINER purge for expired, unheld rows) + counsel-approved durations |
| Worker purge privilege on `console_idempotency` | Console migration 0900 grants app_worker nothing | Console owner: 09xx migration (see "Registered datasets") |

## Tests

```
cd platform && npx vitest run src/retention   # datasets.test.ts runs the full migration set
```

## Requirement IDs enforced here

DATA-03 (retention follows approved controls; legal holds; deletion evidence; derived-copy verification; vendor deletion requests), OPS-01 (deletion evidence atomic with deletion), OPS-03 (unverifiable is not success; missing privilege or a silently blocked delete is reported, never "nothing expired"), DATA-04 (memory dataset deletion with subject holds).
