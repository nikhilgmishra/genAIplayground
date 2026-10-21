# platform/src/connectors/runtime: the connector runtime (WP-06)

Status: **IMPLEMENTED**, exercised against the emulated vendor (`platform/test/integration/connectors`).
Environment: NOT_CONFIGURED. Nothing here is composed in a deployed process yet: the live composition (WP-07)
builds one `ConnectorRuntime` per admitted profile.

`ConnectorRuntime` runs the reviewed operations of one admitted `ConnectorProfile`
(`platform/src/connectors/profile`) through the egress-classified transport (`../http`), with credentials
from a `SecretResolver` (`../secrets`) and records mapped by the bounded DSL (`../dsl`).

## Per operation

1. **Declared and enabled, before any I/O.** An operation missing from the profile throws
   `OPERATION_NOT_DECLARED`; a disabled one throws `OPERATION_NOT_ENABLED` (`ConnectorRefusal`). Admission
   refuses an enabled write on a `READ_ONLY` profile; the runtime does not rely on it and refuses such a
   write itself (`CONNECTOR_WRITE_MODE_READ_ONLY`).
2. **Credential of the capability.** Each operation names its capability; the matching
   `capabilityCredentials` entry (READ or WRITE, its own `credentialRef` and scopes) is used. A write never
   uses the read credential (FO-05-56).
3. **Request from the reviewed template** (`renderRequest`): typed parameters only, no caller-built host or
   path. Writes carry a server-derived idempotency key.
4. **Resilience, in this order:** `retry` (only NOT_STARTED / retryable FAILED, never UNKNOWN; a vendor
   `Retry-After` lengthens the delay and a hint above the budget ends retries instead of being shortened) ->
   `CircuitBreaker` (availability failures only) -> bulkheads (the connector's `limits.maxConcurrency`
   across all its operations, then each operation's own cap; past the queue `BULKHEAD_FULL` before I/O) ->
   token buckets (the operation's budget, then the connector's). A 429/503 `Retry-After` pauses every bucket
   of the connector, including callers already waiting for a token when it arrives; when the pause ends each
   bucket restarts with a burst of one and releases its queued callers in order, spaced at its sustained
   rate, so the backlog never reaches the vendor as one burst. A caller may wait up to the connector's
   `timeoutMs` in each bucket (the operation's `timeoutMs` bounds its request on the wire); a longer wait is
   refused `RATE_BUDGET_EXHAUSTED` (NOT_STARTED). Nested retries are refused (`NESTED_RETRY_REFUSED`).
5. **Token** from `TokenManager`: OAuth 2.0 client credentials (`client_secret_post` / `basic`),
   `private_key_jwt`, a self-signed JWT bearer, or an API key header. Tokens are cached per capability
   credential, bounded by `expires_in` and `tokenMaxAgeSeconds`, with one request in flight per credential.
   Granted scopes are checked: broader than declared is refused, narrower refuses only the operations that
   need the missing scope. The account and region the vendor reports are checked against the profile's
   binding on first use (`CONNECTOR_ACCOUNT_BINDING_MISMATCH`, `CONNECTOR_REGION_MISMATCH`).
6. **Exactly one refresh on 401:** the token and the cached secret are dropped, a new token is requested and
   the request is sent once more; a second 401 is `CONNECTOR_AUTH_FAILED` and the capability turns
   NOT_READY. A token endpoint that rejects the client (`invalid_client`) re-reads the secret once and
   retries only if its version changed (rotation picked up without restart).
7. **Classification:** timeout before send / connection refused are NOT_STARTED; timeout after send, a
   dropped connection or a 5xx on a write are UNKNOWN (reconcile first, `reconcile()` runs the declared
   lookup). 429 is NOT_STARTED and retryable; 503 too, except on a `NOT_IDEMPOTENT_RECONCILE_REQUIRED` write,
   where an intermediary may answer 503 after the origin applied it: UNKNOWN, never retried (a key-based or
   naturally idempotent write is retried with the same key). Redirects are refused; usage headers feed
   `vsp_connector_vendor_quota_remaining_ratio`.
8. **Mapping:** the response object goes through the compiled mapping. A drifted record is refused whole
   (`ConnectorSchemaDriftError`, CONNECTOR_SCHEMA_DRIFT) and the capability turns UNKNOWN; this is the
   injection point of fault SCHEMA_DRIFT (Layer-2 run with readiness: WP-32).

`readAll` / `page` follow the declared pagination (cursor, page token, keyset, offset or next link, each
bounded by `maxPageSize` and `maxPages`). A read is `COMPLETE` only when the vendor reports no further
position: no next cursor, an empty page at the position asked for, or (offset) a page shorter than the page
size (admission requires an offset operation to send its page size, `PAGINATION_PAGE_SIZE_PARAM_MISSING`).
An empty page that carries an advanced cursor (a filtered feed) is read past. The page-count bound returns a
partial result labelled `TRUNCATED` (`PAGE_LIMIT`) with the resume position: the next cursor, or for offset
pagination the offset of the first record not read; `readAll(op, input, { startCursor })` resumes from it (an
offset that is not a decimal integer is refused before I/O, `PAGINATION_START_OFFSET_INVALID`). A cursor that
expires after the first page returns `TRUNCATED` (`CURSOR_EXPIRED`) with no resume cursor: an expired position
cannot be resumed, so the read starts again. A non-empty page whose next cursor is the one requested is
refused (`PAGINATION_CURSOR_NOT_ADVANCING`) instead of re-serving its records. A next link to another host is
refused before I/O.

## Health, readiness and evidence

* `readiness()` starts UNKNOWN for every capability (never contacted is not healthy); `health()` fails closed.
* `fetchMetadata` / `validateMappings` run the profile's metadata operation on the same path as every other
  operation (its budget and bulkhead, retry policy, scope check, 401 refresh, classification and the account /
  region header binding).
* Caches: a token request or a secret read still in flight when `TokenManager.invalidate()` /
  `SecretResolver.refresh()` runs answers the callers already waiting for it but is never cached; later
  callers request again (a stale value cannot be re-cached after a 401 or a rotation).
* `probeConnector(rt, { sandboxWrite? })`: VALIDATE_CONFIGURATION, AUTHENTICATE, INSPECT_METADATA (fetched
  metadata against the mappings), INSPECT_SYNTHETIC_RECORD (the approved synthetic record), and
  WRITE_RECONCILE_TEST only when an authorized sandbox write is given (write capabilities stay UNKNOWN
  without it), COMPARE_MAPPING. The sandbox write runs only on a `SANDBOX_WRITE` profile; on a
  `PRODUCTION_WRITE` or `READ_ONLY` profile it is never sent (NOT_RUN `WRITE_TEST_REQUIRES_SANDBOX_PROFILE`),
  and it must name an enabled WRITE operation (a read or an undeclared one is NOT_RUN
  `SANDBOX_WRITE_NOT_AUTHORIZED`, nothing sent for it).
* `reconcile(write, input)` answers `found: false, result: null` when the lookup is 404, and `found: false`
  when a list-style lookup (records under `recordsPointer`) answers 200 with no record: an unapplied write is
  never taken as applied. A failing lookup throws instead of answering either way.
* `verifyPendingCredentials(rt)` is the rotation test (docs/RUNBOOKS/secret-rotation.md): each enabled
  capability credential's `AWSPENDING` version authenticates (token request; the synthetic read for the read
  credential) while traffic keeps `AWSCURRENT`. Pending tokens are cached apart and never serve traffic, a
  write never runs on a pending credential (`PENDING_CREDENTIAL_WRITE_REFUSED`), and readiness is unchanged.
* `capabilityEvidenceFrom(report)` builds schema-valid `CapabilityEvidence`; `signCapabilityEvidence` signs its
  content digest with `KmsEvidenceSigner` (KMS `ECDSA_SHA_256`, MessageType RAW); `verifyEvidenceSignature`
  needs only the public key. A capability that is not READY is never evidenced as passing.

## Checkpoints (migration 2060)

`PgConnectorCheckpointStore` keeps one row per (tenant, profile, stream): cursor, replay id, watermark,
position digest, counters, mapping digest. `advance` is a compare-and-set on the position digest inside the
caller's transaction (`CHECKPOINT_CONFLICT` when another reader moved first). `IncrementalReader.runOnce`
projects each page and advances the checkpoint in **one** transaction (role `app_worker`), so a crash
re-reads at most the uncommitted page and never duplicates; a page without a continuation cursor is
refused, and so is a non-empty page at the stored position (`PAGINATION_CURSOR_NOT_ADVANCING`: nothing
projected, checkpoint unchanged). An empty page with an advanced cursor commits that position on its own
(records delta 0), so the reader moves past filtered windows instead of stalling before them. A refused
projection write stops consumption and keeps the checkpoint. Triggers keep the key
immutable, the counters and watermark monotonic, and refuse delete and truncate.

## How to test

```
cd platform && npx vitest run src/connectors src/adapters src/resilience     # Layer 1 (real sockets, PGlite)
make up PROFILE=core && make test-integration SUITE=connectors                # Layer 2 (TLS, LocalStack, postgres:16)
```

LOCAL FIXTURE: `LocalFixtureSecretResolver` (`../secrets`) serves labelled synthetic secrets to Layer-1 tests
only; the Layer-2 suite uses the Secrets Manager resolver.
