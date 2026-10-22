# Layer-2 suite: domain (WP-23)

Production domain adapters (`platform/src/domain`) over the WP-06 connector runtime, the egress-classified TLS
transport (private test CA, server names verified), the Secrets Manager resolver over LocalStack, and the production
action executor (LedgerActionService on postgres:16), against the **reference business API** container.

```
make up PROFILE=core,domain
make test-integration SUITE=domain
```

Services declared: `reference-business-api`, `localstack`, `postgres`. Each test file provisions its own synthetic
tenant (account, OAuth clients per capability, a host name and certificate per system, a dedicated loopback endpoint per
system) through the API's fault-control listener, so connection-level faults stay inside one test. Exactly-once and
reach are read from the system's side (append-only effect log, request log, fault and endpoint counters).

| File | Covers |
|---|---|
| `reads.test.ts` | canonical reads with provenance, prohibited fields never ingested, AUTH-05 scoping, legacy-code dialect and zone mapping |
| `commit.test.ts` | prepare / commit / receipt / reconcile through the executor; duplicate delivery; seams `[FAULT:SCHEDULING_TIMEOUT_AFTER_COMMIT seam]`, `[FAULT:RECEIPT_LOST seam]`, `[FAULT:RECEIPT_LATE seam]`, `[FAULT:CHANGED_SLOT_DURING_CONFIRMATION seam]`, `[FAULT:CONCURRENT_SAME_ACCOUNT seam]`; AUTH-02 provider approval vs client consent; absence rule; business commit port compatibility |
| `faults.test.ts` | `[FAULT:SCHEDULING_UNAVAILABLE]`, `[FAULT:BILLING_TIMEOUT]`, `[FAULT:CLAIMS_TIMEOUT]`, `[FAULT:PROVIDER_API_TIMEOUT]`, `[FAULT:PARTIAL_WRITE]` at their injection points with postconditions |
| `legacy.test.ts` | the non-idempotent legacy create: never retried blindly, created only under the delivery's own reference reservation, reconciled by reference; absence only from the reference fence after the create's deadline (FENCED), and a later delivery under a fenced reference sends no create |
| `capability.test.ts` | operator capability tests: READY with EMULATOR_PASS evidence, sandbox write qualification, window mismatch, schema drift |
| `absence.test.ts` | the dispatch deadline: a write held behind another connection's row lock past its deadline is refused by the system (REJECTED) and only then NOT_FOUND; lock waits each within the bound but together past the deadline are refused by the final check; released before it, the write applies and reconciles COMMITTED; through the executor; the legacy create (its reference FENCED) |
| `fence.test.ts` | commit latency (`STALL_BEFORE_COMMIT`: the final deadline check passed, COMMIT held): at deadline + skew the write is not durable yet, and the decision is never NOT_FOUND: the domain port's fence waits and answers COMMITTED; through the executor the reconciliation is inconclusive until the COMMIT lands, then COMMITTED with the system's receipt; the legacy reference fence answers POSTED; an early fence changes nothing; a fenced reference refuses a later create |
| `lag.test.ts` | redelivery inside the account's lookup lag: the business `SchedulingCommitPort` and the domain port are never FAILED while the booking exists (UNKNOWN, the system's 422); the non-idempotent legacy create redelivered (or raced) sends exactly ONE create |
| `cancel.test.ts` | the cancellation write: a client's cancellation commits once with the system's receipt, reads CANCELLED, verifies; redelivery replays; a timeout after send is reconciled by key (one effect); a provider-approved cancellation on the provider's own schedule, another provider refused 403 |
| `authority.test.ts` | confused deputy: business-layer ports refuse without the acting party (no request); the system refuses another party (403); role switch and `commitCommand` from the wrong role |
| `redelivery.test.ts` | duplicate delivery of create, reschedule and billing review (one effect, one write for lookup-first); the business port redelivered with the ledger's key; a request id reused with another payload (422, UNKNOWN, `PAYLOAD_MISMATCH`) |
| `crash.test.ts` (+ `crash-child.ts`) | crash after commit per adapter (scheduling, billing, legacy): a child replica SIGKILLed while the system holds the response; a fresh replica reconciles by key, exactly one effect |
| `property.test.ts` | FO-00-13: fast-check (seed 2310, 28 generated runs plus 15 always-run examples) over prepare / confirm / commit / reconcile through the production executor, for domain-prepared and business-prepared bookings, reschedules and billing reviews, with interleaved faults (none, held response, dropped response, partial write, 503 once, unavailable throughout, slot changed, COMMIT held after the final deadline check), redelivery through the executor or directly to the port (after the window or at once), on an account whose lookup answers at once or LAGS; short-preparation examples reconcile after the dispatch deadline while the COMMIT is still held (never NOT_FOUND); at most one effect per action and the ledger COMMITTED exactly when the effect exists |

The suite refuses to run against a reference API that does not serve the checkout's service code (`REFBIZ_STALE_CODE`:
the service reports the digest of its sources on `GET /__admin/build`; the composition's container runs the checkout
from a bind mount and must be recreated after a service change). A developer can run the suite against a private
instance of the checkout's service with `VSP_REFBIZ_PORTS=<api>:<admin>:<health>` and `VSP_REFBIZ_DATABASE=<name>`
(the same check applies); by default the composition's container is used.

`support.ts` holds the shared tenant provisioning (`provisionTenant`, `composeAdapters`), the admin client
(`RefbizAdmin`: faults, barriers, effects, requests, stored change requests) and the session and confirmation helpers.

Fidelity notes: the reference API is the platform's own stand-in, not a vendor; `STALL_HANDSHAKE` holds a TCP
connection without TLS (a timeout before send), `REFUSE_CONNECTIONS` closes the listener (ECONNREFUSED). The seams of
WP-25's faults are exercised here as seam tests only.
