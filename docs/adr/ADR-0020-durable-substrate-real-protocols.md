# ADR-0020 Durable substrate on real protocols: two-store route-audit journal, detached-route intents, KMS-signed manifests, a read-only verifier and an authenticated ingress inbox

| Field | Value |
|---|---|
| Status | **Accepted for engineering** (software scope; renumbered from the WP-04 proposal by the phase B integration package WP-07). AWS tables, task roles, key policies and alarms: **Pending human approval** (WP-39; AIN-01, AIN-03, AIN-25) |
| Date | 2026-10-21 (drafted in phase B by its work package; renumbered on integration) |
| Decided by | Principal engineer (coding agent) for the engineering scope only |
| Approval needed from | Security leadership (verifier identity and KMS key policies); audit owner (export, verification and quarantine semantics); privacy counsel (raw inbound payload retention) |
| Related prerequisites | PRQ-003, PRQ-011, PRQ-021; activation register AIN-01, AIN-03, AIN-07, AIN-25 |
| Origin | Proposed as `docs/adr/proposed/WP-04-durable-substrate.md` |

## Context

Context: follow-on FO-01-13, FO-01-19, FO-01-34, FO-03-10, FO-03-21, FO-03-22, FO-03-24, FO-03-26,
FO-06-10, FO-06-97, FO-06-98, FO-07-16 to FO-07-22, FO-10-43, FO-11-13, FO-15-28, FO-15-33, FO-15-34,
FO-15-37, FO-15-38, FO-15-40 to FO-15-42, FO-15-45, FO-15-48, FO-15-50, FO-16-03, FO-16-41, FO-19-07a,
FO-19-82, FO-22-08; ADR-0011 (deferred route audit), ADR-0018 decision 7.2 (PGlite is never concurrency
evidence). Environment status of everything here: NOT_CONFIGURED (nothing calls AWS).

## Decision

1. **Route evidence is journaled durably, in two independent stores.** The process-local
   `DeferredAuditQueue` is replaced by `DurableDeferredAuditQueue`: a route event whose audit append is refused
   is written to `audit_deferred` (migration 2040), inside the handoff's own transaction when the caller has
   one (savepoint around the append), else in its own transaction. When PostgreSQL itself refuses, the event
   goes to an independent DynamoDB journal (conditional put); only when both refuse is it held in a bounded
   memory list, loudly. The flush appends each deferral exactly once, in deferral order, with its
   `audit.deferred.recorded` marker, in one transaction per deferral under a tenant advisory lock. Consequential
   mutations are never journaled: they stay blocked (OPS-01).
   Tenant order holds across the three stores: before a direct append, `appendOrDefer` counts what waits for the
   tenant in `audit_deferred`, in the independent journal (entries another replica wrote while PostgreSQL refused)
   and in memory; when anything waits it moves those entries into `audit_deferred` first and drains a bounded
   number in order, and journals the new event behind whatever remains. When a journal cannot be read its content
   is unknown, so the new event is journaled, never appended ahead; the tenant's flush also stops while the
   independent journal is unreadable. We accept that trade-off (a DynamoDB read outage delays route evidence
   reaching the chain; it stays durable in `audit_deferred`, visible as `vsp_audit_journal_pending` and, past the
   grace, as a verifier discrepancy) over evidence that overtakes older evidence. Order means deferral time
   (`deferredAt`); at the same instant an entry first journaled in DynamoDB goes first; then journal order. Each
   queue issues strictly increasing deferral times, and an event journaled behind older entries is timed after the
   newest of them (the newest pending `audit_deferred` row, the newest pending DynamoDB item read newest-first, and
   the newest memory entry; clamped to 60 s ahead of its clock, so a skewed or forged entry cannot push deferral
   times far into the future; such an entry can be ordered after the new event instead). We accept that once the
   clamp is reached, the queue's monotonic deferral times stay up to 60 s ahead for about a minute, so another
   replica's events in that window can be ordered before them. Across replicas that did not see each other's
   entries (including one that puts an entry into DynamoDB while a flush pass is between its read and its appends),
   order is as good as their clock synchronisation. The flush reads DynamoDB in bounded passes; when a read is cut at its bound, the pass
   appends only deferrals it read or that are strictly older than the greatest sort key read, so a bounded pass (or
   the bounded inline drain) never lets a newer row overtake an entry it has not read yet. Pending counts are kept
   per store and recounted on every flush, also while the audit store is unwritable (nothing is appended then);
   one that cannot be counted keeps its last known value rather than reading 0, one a process has never counted
   reports no value at all (not 0), and the DynamoDB journal has its own
   `vsp_audit_journal_pending{journal="dynamodb"}` series, so the outage this journal exists for does not hide
   what it holds.
   Every item read back from the DynamoDB journal is re-validated (schema, input digest, the tenant partition it
   was read from, its sort key, a canonical deferral time - the exact `toISOString` form of an instant from 1970 to
   9999 - and an event time the audit store holds). One that fails, tampered with or corrupted, is quarantined
   rather than treated as an unreadable journal: otherwise a single bad item would hold all later route evidence of
   the tenant indefinitely. A time that JavaScript parses but PostgreSQL refuses (`2026`, year 0000) is such a
   failure, and so is an item whose content PostgreSQL refuses when the drain inserts it (SQLSTATE class 22, NOT
   NULL or CHECK violation): retrying it could never succeed. Any other refusal (connection, privilege, read-only)
   is not about the item and quarantines nothing.
   The quarantine is evidenced in the chain first (`audit.journal.entry_quarantined`, a content-free pointer, the
   reason code), then the item is marked QUARANTINED with its content kept for forensics; its content is never
   appended. Until that record can be written the item keeps the tenant's newer route events behind it, so a
   quarantine is never silent. A crash between the record and the mark repeats the record under the same
   correlation id (at least once, never lost). The digest is an integrity check, not a MAC: an insider who can write
   the table and recompute the digest is stopped by the table's IAM policy (WP-39), not by this check.
2. **Detached route executions open an intent first.** `route_audit_intents` is written before a route tool
   execution can be detached by its timeout; the reconciler resolves it against audit or journal evidence, or
   writes `audit.route.not_recorded` after its deadline. Only route evidence of the intent's kind resolves it: a
   `SAFETY_ROUTE` intent needs a `handoff.safety_*` or `safety.route.*` event, a `HUMAN_TRANSFER` intent any
   `handoff.*` or `safety.route.*` event (a human transfer escalated to a safety route is audited); another event
   that only carries the correlation id never closes an intent. Safety incidents in `safety_events` are reconciled the
   same way (`audit.route.not_recorded`, or `audit.safety_event.unaudited` when rows were written during an
   outage). No route is silently unaudited (FO-01-34, FO-15-48). Opening intents in the handoff and the gateway
   is the composition packages' work (WP-14, WP-25).
3. **Manifests are signed by KMS and verified with public keys only.** Signature input
   `"vsp.audit.manifest.sig.v1\n" + canonical manifest without signature`, KMS `Sign` with `ECDSA_SHA_256` and
   `MessageType RAW` (Node's signer cannot sign a pre-hashed digest, so RAW keeps the local fixture signer and KMS
   byte-compatible; inputs are bounded to KMS's 4096-byte RAW limit). The shipper signs at plan time, so a re-put after a crash is byte-identical. A live sink refuses
   to ship unsigned.
4. **The verifier is a separate identity that cannot write.** Its own database LOGIN granted only
   `app_audit_verifier` (migration 2042, SELECT only), and sink READER credentials distinct from the exporter's
   writer (STS session policies list/get vs put; in AWS separate task roles). The verifier judges the LOGIN, not
   only the role it switched to: the session user and the backend's authenticated login (`pg_stat_activity`,
   which `SET SESSION AUTHORIZATION` does not change), with every role they can reach (`pg_has_role MEMBER`),
   must be neither superuser nor CREATEROLE, own nothing, belong to no writer role, hold no write or CREATE
   privilege and reach no volatile SECURITY DEFINER function; otherwise `VERIFIER_IDENTITY_NOT_READ_ONLY`
   instead of a verdict. The local CLI provisions a per-run verifier login and MinIO session credentials and
   drops the login afterwards. Completeness is reconciled by key against exported evidence (committed actions:
   the receipt's commit event of the same tenant bound to the ledger's idempotency key; provider receipts: that
   event references the receipt; CRM writes; route evidence including RECORDED deferrals), because a perfect
   chain can omit events (FO-15-41). Without signature keys the verdict is INCONCLUSIVE. Without a sink reader the
   exported copy cannot be read: reconciliation runs against the local outbox, evidence already shipped (or
   possibly purged after a verified export) is reported as `unverified`, never as missing, and the verdict is
   INCONCLUSIVE (CLI exit 2) — but a finding the verifier can see locally (a chain or ingestion gap, a deferral
   pending past the grace, evidence unshipped past the grace, a local event that contradicts the ledger, a
   deferral or a marker, or evidence never written when nothing was ever purged) is still FAIL. Reporting every
   shipped event as missing would make a sink-reader outage indistinguishable from evidence loss.
5. **Inbound events are authenticated, sealed and persisted before acknowledgement.** One inbox
   (`inbound_events`, migration 2041) for webhooks, delivery receipts, CDC and existing streams. The verifier
   follows each source's documented mechanism (HMAC header, JWT bearer, mTLS, reconcile-by-lookup, stream IAM;
   LiveKit's own webhooks, sent by livekit-server from the composition's pinned image, verify end to end in Layer 2;
   a Talkdesk or carrier mechanism is added as a profile once its vendor documents it, AIN-07, never invented);
   credentials come from Secrets Manager stages with an overlap window counted from the PROMOTION of the
   current version (durable first observation shared by every replica, migration 2044; an unwitnessed promotion
   falls back to a lower bound, an unknown one to no overlap); the verifying version and the ACTUAL mechanism
   are recorded per event. An authentic byte-identical redelivery is a recorded duplicate (200), never a
   refusal: a vendor whose acknowledgement was lost must not see a failure. Token reuse over other bytes is
   refused by a DURABLE replay cache (migration 2043), not a per-process one. Payloads are sealed with a per-event KMS data key (AES-256-GCM, encryption
   context and AAD bound to tenant, source, event id and digest) in restricted columns, purged at retention
   unless a legal hold applies (RetentionJob hold semantics, any data class).
   Dedupe on `(tenant, source, event_id)` under an advisory lock (proven load-bearing by a deterministic Layer-2
   race: two replicas held inside the accept transaction, the second observed waiting for the lock, both
   answered 200); ordering by `(source_version, occurred_at,
   event_id)`, never arrival; unknown schemas quarantined; poison events INBOUND_DEAD after bounded attempts;
   replay only with fresh MFA and an audit record written first.
6. **Multi-connection behaviour is proven on postgres:16, never on PGlite.** The Layer-2 substrate suite
   provisions each database as on Aurora (non-superuser owner running the migrations, runtime roles granted to an
   application login) and races real backends (`contention-harness.ts`). The default unit suites stay on PGlite
   and Docker-free; `VSP_TEST_DB=pg` re-runs the audit, ingress, outbox, db and KV unit suites on postgres:16.
7. **Transactions retry only on serialization failure, bounded.** `TxOptions.retry` (2..10 attempts, jittered)
   retries 40001 / 40P01 only and then fails with `DB_TX_SERIALIZATION_EXHAUSTED`; pool exhaustion and an
   unreachable server are typed dependency errors (`DB_POOL_EXHAUSTED`, `DB_UNAVAILABLE`), never a hang.
8. **Fault seams are real.** AUTH_EXPIRY (DynamoDB Local + injected clock), CONCURRENT_SAME_ACCOUNT and
   CRASH_AFTER_COMMIT (two backends; SIGKILL of a child process), DLQ_FULL (ElasticMQ refusing the write),
   LOCAL_PERSISTENCE_FAILURE (database read-only; a throwaway postgres:16 container stopped). The shared
   composition is never stopped.

## Emulator fidelity findings (Layer 2)

- **ElasticMQ 1.7.1** neither stores nor enforces a per-queue `MaximumMessageSize` attribute (it is accepted
  and ignored); it enforces the global 1 MiB limit (a 300 KB message is accepted, a 1.1 MB message is refused
  with `InvalidAttributeValue`). The DLQ_FULL seam therefore sends a message over 1 MiB.
- **pgvector** cannot be created by a non-superuser database owner; on Aurora the operator (rds_superuser)
  pre-creates the extension. The Aurora-like harness does the same.
- **PGlite** reports `rowCount` 0 for SELECT statements; code must use `rows.length` for reads (fixed in this
  package's code).
- **LocalStack Secrets Manager** returns `CreatedDate` for each version stage, honours `AWSPENDING` staged
  with `PutSecretValue VersionStages`, and moves AWSPREVIOUS to the old version on `UpdateSecretVersionStage`
  (AWSCURRENT to a staged version). Neither it nor AWS records WHEN a version became current, hence the
  promotion ledger.
- **PGlite 0.3.15** does not revert `SET [LOCAL] SESSION AUTHORIZATION` at the end of a transaction, and
  `RESET SESSION AUTHORIZATION` does not restore the superuser (postgres:16 reverts it at commit). A separate
  login on PGlite is therefore a COPY of the database opened with `username` (`PgliteDb.openCopyAs`,
  `createTestLogin`). PGlite's `pg_stat_activity` is empty, and reading `pg_database` is refused there, so the
  identity check uses `pg_database_owner` membership for database ownership.
- **PostgreSQL regular expressions** accept repetition bounds up to 255 only (`{1,512}` is an invalid
  regular expression); length limits use `char_length` instead.
- **MinIO** implements STS `AssumeRole` with an inline session policy for the root user and enforces the
  policy on S3 calls (AccessDenied 403), and verifies the SigV4 signature of the STS request.
- **LocalStack KMS** supports `ECC_NIST_P256` `Sign` / `GetPublicKey` with `MessageType RAW` and symmetric
  `GenerateDataKey` / `Decrypt` with encryption context; a wrong context fails `Decrypt`.
- **livekit-server v1.13.9** (the composition's image, run as a throwaway container with `webhook.api_key` and
  `webhook.urls`; the shared service has no webhook configuration) sends `application/webhook+json` with a bare
  HS256 JWT in `Authorization` (no `Bearer` prefix, no `iat`, a `sha256` claim of the body), one delivery per URL
  per event; the test observed one delivery per URL per event, including for the deliveries it refused (401). Room events carry the room's TURN credential
  (`room.turnPassword`), so the raw webhook payload is a secret-bearing artifact. A container reaches the host
  on the Docker bridge gateway (`host-gateway`), so the test ingress listens there.
- Found by this test (a defect, now fixed): the ingress logged source ids under `sourceId`, which the
  content-free logger always redacts (a source id is not an opaque-id shape), and the decision under `decision`
  (not an allowlisted key). The ingress now logs `integration` (the source id, as the connector runtime does) and
  `outcome`; a unit test asserts no ingress log field is redacted.

## Consequences

- Composition (container wiring of the durable journal and reconciler loop, the ingress plugin registration,
  the metric catalogue merge of `catalog/substrate.ts`, the `audit-exporter` entry point) belongs to WP-07;
  Terraform tables, roles and alarms (DynamoDB journal table, verifier task role, inbox alarms) to WP-39.
- `KinesisStreamSource` has no emulator run until `@aws-sdk/client-kinesis` is added and LocalStack starts
  `kinesis`; a Kafka/MSK source needs a client library (dependency requests).
- A body-only HMAC signature carries no freshness; the inbox never deletes rows, so a replay is always a
  recorded duplicate without effect.
- The raw replay payload is not yet a registered retention dataset (`inbound_raw_payloads`); its duration is
  the source profile's until the retention owner registers it with an approved duration.
- Phase B integration (WP-07, [ADR-0023](ADR-0023-live-composition-root.md)): the live container composes `DurableDeferredAuditQueue` with the DynamoDB journal, the reconciler and flush loops run in the live worker, the substrate metrics are merged into the platform catalogue, and `platform/src/main/audit-exporter.ts` is the export / verify unit. The ingress webhook plugin is NOT composed yet: `ingress.events` is NOT_CONFIGURED with the software gap `INGRESS_PLUGIN_NOT_COMPOSED` (owner WP-07).

## Alternatives considered

| Alternative | Why not adopted |
|---|---|
| Keep the process-local DeferredAuditQueue | Route evidence of a safety or human handoff would be lost on a crash during an audit outage (FO-01-34); kept only in the regression composition (local/ci) |
| One durable store for deferred evidence | The outage this journal exists for can be a PostgreSQL outage; a second, independent store (DynamoDB) keeps evidence durable then |
| Sign manifests with a local key | A key on the exporter host lets the exporter forge its own evidence; KMS Sign with public-key-only verification separates the identities |
| Run the verifier under the exporter's identity | A verifier that can write can repair or hide evidence; it runs as a separate read-only login and sink reader |
| Prove concurrency on PGlite | PGlite is a single connection; ADR-0018 decision 7.2 makes postgres:16 the only concurrency evidence |

## Linked requirements

OPS-01, OPS-02, AUTH-02, DATA-01, DATA-03, SAFE-03; FO-01-13, FO-01-19, FO-01-34, FO-03-10, FO-03-21, FO-03-22, FO-03-24, FO-03-26, FO-06-10, FO-06-97, FO-06-98, FO-07-16 to FO-07-22, FO-10-43, FO-11-13, FO-15-28, FO-15-33, FO-15-34, FO-15-37, FO-15-38, FO-15-40 to FO-15-42, FO-15-45, FO-15-48, FO-15-50, FO-16-03, FO-16-41, FO-19-07a, FO-19-82, FO-22-08

## Revisit when

When a vendor documents its event authentication (AIN-07), the Kinesis client is added (WP-17), the retention owner registers `inbound_raw_payloads`, or the AWS resources land (WP-39).
