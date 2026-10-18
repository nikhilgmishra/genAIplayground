# actions — action ledger, idempotency, commit protocol, reconciliation

Status: **IMPLEMENTED_OFFLINE**. Verified only against PGlite (real PostgreSQL in WASM) with
labelled local fixtures. Not verified against Aurora, a vendor sandbox or production. Nothing
here establishes HIPAA compliance or production readiness.

Spec: section 8 (tool interface; preparing and committing changes; Salesforce idempotency
behaviour), section 12 (bounded retries, no retries on retries), section 13 (audit before
acknowledgement; block consequential actions when durable evidence cannot be written).

## What is implemented

| Piece | File | Notes |
|---|---|---|
| Migrations | `migrations/0100_action_ledger.sql`, `0101_action_reconciliations.sql`, `0102_action_invalidation_requests.sql`, `0105_tool_request_idempotency.sql` | RLS enabled **and forced**, tenant policies for `app_runtime` and `app_worker`, no DELETE for runtime, state-machine trigger, partial unique index; append-only reconciliation records with a one-time retry consumption; durable, immutable invalidation requests on in-doubt rows (0102, ACT-F1) |
| `computeActionDigest` (pure) | `digest.ts` | sha256 over canonical JSON of every `PreparedAction` field except `digest`/`state`. The field list comes from the protocol schema |
| Session binding | `digest.ts` | The ledger stores only `sha256(sessionRef)`. `PreparedAction.sessionRef` returned by this module is the non-bearer **binding ref** `ses_bnd_<base64url(sha256)>` |
| Stable provider key | `digest.ts` `providerIdempotencyKeyFor` | Derived from the action id. The same key is used on every attempt and every reconciliation |
| `LedgerActionService` (`ActionService` port) | `action-service.ts` | prepare / confirm / invalidatePending / commit / reconcile / get / listNeedingReconciliation, plus (optional on the port) `listForSession`, `reconcileWithResult`, `retryAfterReconcile`, `latestReconciliation`, `describe`, `cancelPending`, and `expireDue` |
| `ToolRequestIdempotency` | `tool-idempotency.ts` | reserve / complete(InTx) / release / lookup / record / purgeExpired. Rejects a request-hash mismatch. **Keyed request hash (DP-02):** callers pass the in-memory fingerprint from `computeToolRequestHash`; the store writes, compares and reads only `HMAC-SHA256(pepper, "vsp.tool-request.v2" NUL fingerprint)` (`keyedRequestHash`), so locator arguments (begin_verification name + DOB) cannot be recovered from the table or backups by a dictionary attack. Option `requestHashPepper` = `{ ref, key }` (ref: Secrets Manager secret ARN or `local-fixture:`; key >= 32 bytes; invalid → `IDEMPOTENCY_REQUEST_HASH_PEPPER_INVALID`). Without it a random per-instance key is used (`requestHashKeying: "ephemeral_single_instance"`): still unrecoverable, but a replay reaching another instance or a restarted one fails closed as `IDEMPOTENCY_KEY_REUSED`. A pepper rotation has the same fail-closed effect for keys inside the retention window |

### Commit protocol (as built)

No external call (policy, audit health, provider) is made while a DB transaction is open.
That rule avoids PGlite single-connection deadlocks and avoids holding row locks across
network calls.

1. **AUTH-04**: the AuthContext must be unrevoked and unexpired, and its integration tenant must
   equal its session tenant. This is checked before any ledger read.
2. Snapshot checks:
   - The session hash must match. A mismatch is rejected and the state is not changed.
   - The digest must match. A mismatch invalidates the action.
   - The generation must match. A mismatch invalidates the action.
   - Ledger integrity is checked by recomputing the digest.
   - `COMMITTED` returns the stored receipt with no provider call.
   - `UNKNOWN`, or `COMMITTING` older than `committingStaleAfterSeconds`, is **reconciled first**.
   - `COMMITTING` that is not stale returns `COMMIT_IN_PROGRESS`.
3. The state must be `CONFIRMED`. The preparation must be unexpired. The confirmation must be
   fresh (default 120 s, measured from min(capturedAt, receivedAt)).
4. An active `SAFETY_ESCALATION_ACTIVE` flag invalidates the action.
5. `deps.reauthorize(action)` must return a strictly valid, fresh decision with `allow`. Any
   error is treated as a deny.
6. Step-up applies when `requiresStepUp` is set or policy returns `REQUIRE_STEP_UP`. It needs
   `ctx.stepUp.actionDigest == digest`, an unexpired step-up, and `verifiedAt` at or after
   `preparedAt`.
7. `AuditHealth.assertCanAcceptConsequential()` is called (OPS-01).
8. **tx1** (`app_runtime`, tenant RLS):
   - `SELECT … FOR UPDATE`
   - the row version must be unchanged since the snapshot
   - claim the per-record slot (partial unique index: at most one `COMMITTING`/`UNKNOWN` per
     tenant+system+recordRef)
   - set `COMMITTING`, `commit_attempt_id` and `committing_since`
   - audit `action.commit.started`

   If the audit write fails, tx1 rolls back and no provider call is made.
9. `provider.currentVersion(action)` must equal `target.beforeVersion`. It is checked while this
   action holds the record slot. Otherwise the action becomes `INVALIDATED`/`STATE_CHANGED` and
   `commit` is never called.
10. `provider.commit(action, stableKey)`:
    - `DependencyError NOT_STARTED`: back to `CONFIRMED`. A bounded caller retry reuses the same key.
    - `FAILED`: `FAILED` + audit. A provider `VERSION_CONFLICT` becomes `INVALIDATED`/`STATE_CHANGED`.
    - Ambiguous timeout (`DependencyError UNKNOWN`), any unexpected exception, or an invalid
      response: `UNKNOWN` + audit `action.commit.unknown`. Returns an `UNKNOWN` receipt.
11. **tx2**, atomically:
    - `COMMITTED` + receipt (`evidenceHash` = sha256 of the canonical evidence)
    - audit `action.commit.succeeded`
    - outbox `action.committed` (dedupe key `action.committed:<actionId>`)
    - service-level and per-call `onCommitted` hooks

    The receipt is returned only after tx2 commits. If tx2 fails, the action is marked `UNKNOWN`.
    If even that cannot be written (audit or DB down, or a crash), it stays `COMMITTING` and the
    caller gets `DependencyError(…, "UNKNOWN")`. It is **never** a success.
12. `reconcile(actionId, provider)`: `provider.lookup` by the same key.
    - `COMMITTED`: records a `COMMITTED` receipt with `reconciled=true` and audits `action.reconciled`.
    - `NOT_FOUND`: if an invalidation was requested while the action was in doubt (see
      "Durable invalidation requests" below) the action becomes `INVALIDATED` (state reason = the
      request's reason, audits `action.reconciled` + `action.invalidate`) and can never be committed.
      Otherwise back to `CONFIRMED` if the confirmation is still fresh and the action has not
      expired; else `EXPIRED`, and a re-prepare is required.
    - `UNKNOWN` (or the lookup throws): stays/becomes `UNKNOWN`.

    Compensation is never automatic.

    Every reconciliation (worker `reconcile`, the commit path's reconcile-first step, an operator
    `reconcileWithResult`) appends a durable `action_reconciliations` row **in the same
    transaction** as the ledger transition: trigger, result (`COMMITTED` / `NOT_FOUND` /
    `UNKNOWN`), ledger state and row version after it, receipt id, audit event id.
13. `reconcileWithResult(tenantId, actionId, provider)` → `{ receipt, reconciliationId, result }`:
    tenant-scoped (no locator); `receipt` is the authoritative `COMMITTED` receipt, otherwise null.
14. `retryAfterReconcile(tenantId, actionId, { reconciliationId, reasonCode, staffRef }, provider)`:
    staff-initiated retry of a change the CALLER confirmed. The staff member's own authority does
    not replace the caller's (ACT-01, ACT-F3). Allowed only when:
    - the reconciliation is the **latest** for the action, its result is `NOT_FOUND`, and it has
      not been consumed;
    - the ledger row is still at exactly the recorded row version in `CONFIRMED` with the caller's
      confirmation recorded and **no durable invalidation request**;
    - the preparation is unexpired **and the caller's confirmation is still fresh**
      (`confirmationFreshSeconds`, the same window as the caller path; checked on the snapshot and
      again under the row lock). A stale confirmation refuses with `CONFIRMATION_STALE` and expires
      the action: a new preparation and a new trusted caller confirmation are required;
    - `provider.authorizeOperatorRetry(action)` (optional `ProviderCommitPort` method, implemented by
      the business layer, `business/services/operator-retry.ts`) re-establishes the caller's
      CURRENT authority and returns a fresh allow without `REQUIRE_HUMAN`. A port without it is
      refused (`REAUTHORIZATION_UNAVAILABLE`); an error refuses with its reason code (a session that
      is gone, a changed generation/identity or `SAFETY_ESCALATION_ACTIVE` also INVALIDATES the
      action); a denial is `POLICY_DENIED`, a stale decision `POLICY_DECISION_STALE`. A step-up-bound
      action is never retried by an operator (`STEP_UP_REQUIRED`: the step-up belongs to the caller).
    Never on `COMMITTED` or `UNKNOWN` (`RECONCILIATION_RESULT_NOT_RETRYABLE`); other refusals:
    `RECONCILIATION_NOT_LATEST`, `RECONCILIATION_ALREADY_CONSUMED`, `ACTION_ALREADY_COMMITTED`,
    `ACTION_CHANGED_SINCE_RECONCILIATION`, `ACTION_NOT_COMMITTABLE`, `PREPARATION_EXPIRED` (also
    expires the action). Refusals are audited (`action.retry_after_reconcile.rejected`) with the
    staff actor and make no provider call. tx1 consumes the reconciliation (single use) and claims
    the commit slot together; the `action.retry_after_reconcile.started` audit event carries the
    re-authorization decision; the provider is called with the **same** idempotency key, and
    outcomes are recorded exactly as on the caller path (`UNKNOWN` again is reconciled first).
    Authentication and authorization of the staff member (workforce SSO, MFA, console policy) is
    the console API's job before calling.
15. `listForSession(tenantId, sessionRef)`: every action bound to the session (bearer **or**
    `ses_bnd_` binding ref), any state (effective expiry applied), oldest first, at most 200,
    as `LedgerEntryView` (now with `state` and `receiptId`), tenant RLS (`app_runtime`). The
    bearer is hashed, never stored or returned.
16. `reconcile(actionId, provider, tenantId?)` and `invalidatePending(sessionRef, reasonCode,
    tenantId?)`: with `tenantId` the operation runs inside that tenant only and skips the
    cross-tenant `action_locator` read; old call sites without it keep working.

### Durable invalidation requests (ACT-01, ACT-03; finding ACT-F1)

A barge-in, changed request, role / participant / account change, recovery, safety escalation or
call end can arrive while an action is **in doubt** (`COMMITTING` or `UNKNOWN`). Its effect may
already exist, so it cannot simply become `INVALIDATED` (it must be reconciled first, ACT-03); but
the interruption must not be forgotten either. `invalidatePending` therefore invalidates
`PREPARED`/`CONFIRMED` actions as before **and** records `invalidation_requested_at` /
`invalidation_reason` on the session's in-doubt actions (audit `action.invalidation_requested`,
outcome `PENDING`). `prepare` does the same with reason `SUPERSEDED` for an in-doubt action of the
same session on the same record (a changed request). The request is honoured by every later step:
- reconciliation `NOT_FOUND` → `INVALIDATED` (never back to `CONFIRMED`, so the reconcile-first
  path of a later `commit` cannot revive and commit the interrupted change);
- a provably-not-sent in-flight attempt (`NOT_STARTED`) → `INVALIDATED` instead of `CONFIRMED`;
- reconciliation `COMMITTED` → `COMMITTED` (truth is recorded, never hidden; compensation stays
  domain-owned);
- the staff retry refuses a row that carries one.
The returned count of `invalidatePending` is unchanged (transitioned pending actions only); flagged
in-doubt actions are logged as `action.invalidation_requested` with a count.

### Database-enforced controls (defence in depth)

- A trigger allows only legal state transitions. `COMMITTED` and `FAILED` are terminal.
- Every digest-covered field and binding is immutable after insert, and a recorded confirmation
  is immutable. `row_version` must increase by exactly 1, and inserts must be `PREPARED`.
- Check constraints:
  - `COMMITTED` requires a receipt, and a receipt is only allowed when `COMMITTED`.
  - `COMMITTING` requires an attempt id and a start time.
  - Every state from `CONFIRMED` onward requires a recorded confirmation.
- One in-doubt commit per record (`action_ledger_one_in_doubt_per_record`).
- An invalidation request (0102) can be recorded only on a `COMMITTING`/`UNKNOWN` row, is immutable
  once set, and a row that carries one can never (re-)enter `CONFIRMED` or `COMMITTING`. `UNKNOWN` →
  `INVALIDATED` is legal (the reconciled `NOT_FOUND` of such a row); `COMMITTING` → `COMMITTING` is
  legal only to record the request (attempt id and start time unchanged).
- Late authoritative provider evidence is always recordable. `EXPIRED`, `INVALIDATED` or
  `CANCELLED` can still become `COMMITTED`, audited with `LATE_PROVIDER_CONFIRMATION`, so an
  effect that really happened is never hidden.

### Confirmation (ACT-01)

`confirm` accepts only `IntegrationIdentity.channel` `telephony_control` (methods
`dtmf_keypress`, `deterministic_skill_affirmative`, `human_agent`) or `portal` (method
`portal_approval`). `mcp_tools`, `console`, `worker` and `webhook` are rejected, and the attempt
is audited. RLS scopes it to the integration's tenant.

These cases invalidate the pending action:
- a generation mismatch
- a digest mismatch
- a confirmation captured before `preparedAt` ("a yes from an earlier turn")
- a capture time in the future beyond the clock skew
- a stale capture

A different session's bearer, or the binding ref offered in place of the bearer, is rejected
without changing state. A redelivered identical confirmation is idempotent.

## LOCAL FIXTURES (tests only, never production)

| Fixture | Purpose |
|---|---|
| `fixtures/fake-provider.fixture.ts` `FakeProviderFixture` | Fake system of record. Effects log keyed by idempotency key. Faults: `timeout_before_send`, `timeout_after_commit`, `crash_after_commit`, `permanent_failure`, `version_conflict_on_commit`, a concurrent version change, and lookup `unknown`/`throw`. `providerDedupByKey:false` disables provider-side idempotency. Counts `redundantCommitCalls`. `operatorRetryAuthority` (unset = refused with `REAUTHORIZATION_UNAVAILABLE`) stands in for the business layer's operator-retry re-authorization; counts `operatorRetryAuthorizations` |
| `fixtures/audit-writer.fixture.ts` `InTxAuditWriterFixture` / `AuditHealthFixture` | Writes audit rows **inside the caller's transaction** into `test_fixture_audit_events`, so rollback is real. Outage modes throw `AuditUnavailableError`. Mirrors the audit module's evidence-pointer and action-name grammar |
| `fixtures/crashing-db.fixture.ts` `CrashingDbFixture` | After `crash()`, every DB call fails (process death). `restart()` models a new process |
| `fixtures/world.fixture.ts` | SYNTHETIC AuthContext, decisions, confirmations and a harness from `platform/src/fixtures/synthetic-world.ts` |
| `fixtures/request-hash-pepper.fixture.ts` `LOCAL_FIXTURE_REQUEST_HASH_PEPPER` | Labelled, NON-SECRET request-hash pepper (`local-fixture:tool-request-hash-pepper`) used by the local container and tests (DP-02) |

## BLOCKED

| Item | Why | Prerequisite |
|---|---|---|
| Live `ProviderCommitPort` implementations (scheduling, billing, Salesforce upsert by external id) | Owned by `platform/src/adapters`. No vendor sandbox or credentials | Business-system and Salesforce sandboxes, documented commit and lookup-by-idempotency-key semantics, approvals (spec section 5) |
| Running against Aurora PostgreSQL | No AWS account or approval | Approved sandbox account and Aurora cluster. The SQL is standard PostgreSQL and the same code path runs on `PgPoolDb` |
| Provider lookup must be read-your-writes consistent | Reconciliation treats `NOT_FOUND` as not started | Written confirmation from each system owner. Otherwise that integration must keep `UNKNOWN` until a human resolves it |
| Live request-hash pepper (DP-02) | Only the labelled LOCAL FIXTURE pepper exists; no config field names its secret reference and the live composition is refused | A Secrets Manager secret (>= 32 random bytes, gateway-role-only read, rotation plan), a `PlatformConfig` secret-reference field for it (config module) and live composition that loads it |

## Configuration (`ActionLedgerConfig`)

| Setting | Default | Meaning |
|---|---|---|
| `confirmationFreshSeconds` | 120 | Maximum confirmation age at commit time |
| `committingStaleAfterSeconds` | 30 | **Must exceed the provider call timeout**, or a slow in-flight call could be reconciled as `NOT_FOUND` and then confirmed later. Late truth is still recorded |
| `minPrepareTtlSeconds` / `maxPrepareTtlSeconds` | 15 / 900 | Allowed range for the preparation TTL |
| `decisionMaxAgeSeconds` | 60 | Maximum age of the policy decision |
| `clockSkewSeconds` | 5 | Tolerated skew for timestamps from trusted components |
| `auditStream` | `"actions"` | Audit stream name |

## Integration notes for other modules

- `PreparedAction.sessionRef` from this module is a binding ref, **not** the bearer. Compare
  sessions with `sessionBindingRef(ctx.sessionRef) === action.sessionRef`.
- Never put a returned PreparedAction's internals into model context beyond what the tool
  output schema allows.
- The staff retry needs no caller `AuthContext` and never accepts a session bearer; the console
  API wires it (`ConsoleApiDeps.reconciledRetry`) after its own gates. The caller's CURRENT
  authority comes from `provider.authorizeOperatorRetry` (the business layer reads the bound session
  by its non-bearer hash and re-runs policy); a provider port without it cannot be retried by staff.
- `commit` outcomes:
  - Returns a `COMMITTED`, `UNKNOWN` or `FAILED` receipt.
  - Throws `DependencyError(…, "NOT_STARTED")` (retryable) or `DependencyError(…, "UNKNOWN")`.
  - Throws `ConflictError` (`STATE_CHANGED`; `COMMIT_IN_PROGRESS`/`RECORD_COMMIT_IN_PROGRESS`
    are retryable).
  - Throws `AccessDeniedError` / `SessionInvalidError` (deny) or `AuditUnavailableError`.

  Gateway mapping: `COMMITTED` → SUCCESS, `UNKNOWN` → UNKNOWN_OUTCOME, `FAILED` →
  PERMANENT_FAILURE (reason via `describe()`).
- `onCommitted` hooks run inside tx2 and must use the passed `tx` only. A hook that calls
  `db.query` deadlocks on PGlite.
- `ToolRequestIdempotency.computeToolRequestHash` should be given `sessionBinding:
  sessionBindingRef(sessionRef)`, never the bearer.

## Requirement IDs enforced here

ACT-01, ACT-02, ACT-03, OPS-01, AUTH-04, AUTH-05 (tenant RLS), AUTH-02/AUTH-03 (server-side
re-checks), DATA-01 (no bearer or PHI in ledger, audit or outbox), SPEC-8.x and SPEC-12.3.
Review findings closed here: ACT-F1 (durable invalidation of in-doubt actions;
`action-service.invalidation.test.ts`), ACT-F3 (staff retry freshness and re-authorization; same file
and `action-service.reconciliation.test.ts`).

## How to test

```
cd platform
npx vitest run src/actions src/outbox
npx tsc -p tsconfig.json --noEmit | grep -E "src/(actions|outbox)/"
npx eslint src/actions src/outbox
```

The property test (`action-service.property.test.ts`) runs 150 fixed-seed interleavings with
provider-side deduplication disabled.
