# platform/src/resilience: timeouts, bounded retries, circuit breakers, bulkheads

Status: **IMPLEMENTED_OFFLINE**. Thresholds used in tests are illustrative;
production values need measured vendor latency and load-test evidence (TB-10).

## What is implemented

| Primitive | Behaviour |
|---|---|
| `withTimeout(ms, fn, opts)` | Passes an `AbortSignal` to the operation and aborts it at the deadline. A timeout is outcome **UNKNOWN, not retryable** by default (the request may have reached the dependency, ACT-03); only `idempotent: true` operations time out as `FAILED` + retryable. Caller cancellation before start is `NOT_STARTED`, after start `UNKNOWN`. Injectable timer port. |
| `retry(fn, opts)` | At most 3 attempts (protocol `RetryPolicy` maximum), full jitter `random() * min(maxDelay, base * 2^(n-1))`, injectable `random`/`sleep`. Retries only errors classified safe: typed platform errors with `retryable` true whose outcome is not `UNKNOWN` (optionally restricted to `retryOn` reason codes). **Never retries UNKNOWN outcomes**, unclassified errors, circuit-open or bulkhead-full. |
| No nested retries | `AsyncLocalStorage` scope: entering `retry` while another retry is active in the same call chain throws `NestedRetryError` (`NESTED_RETRY_REFUSED`) before doing any work, so retries cannot multiply. Parallel sibling retries are fine. |
| `CircuitBreaker` | closed / open / half-open; rolling failure-rate window with minimum request count; cooldown measured with the injected `Clock`; bounded concurrent half-open probes; caller-side and backpressure errors are neutral. `CircuitBreakerRegistry` keeps one breaker per dependency with overrides. Open circuit ⇒ `CIRCUIT_OPEN` (`NOT_STARTED`, not retryable). |
| `Bulkhead` | Max concurrent + bounded FIFO queue (+ optional queue timeout, abort while queued). Overflow ⇒ `BULKHEAD_FULL` (`NOT_STARTED`, not retryable: backpressure propagates). |
| `retry(..., { delayFor })` | Server-directed delay (WP-06): `delayFor(err)` returns a hint such as a parsed `Retry-After`; the delay is `max(jitter, hint)`, and a hint above `maxDelayMs` ends the retries (the error is rethrown with its hint) instead of being shortened. UNKNOWN outcomes are still never retried. |
| `TokenBucket` | Rate budget (WP-06, FO-06-07): `ratePerSecond` with a `burst`, injectable clock and sleep, kept as a FIFO schedule of start slots (GCRA, equivalent to a token bucket). `take()` reserves the next slot and waits until it is due, or refuses with `RATE_BUDGET_EXHAUSTED` (NOT_STARTED, not retryable) instead of waiting longer than `maxWaitMs`, reserving nothing. `pauseUntil(ms)` records a vendor pause: no request starts before it ends, and the schedule restarts at its end with a burst of one, so the callers already waiting keep their order and start 1/rate apart from the pause end (never together); burst capacity returns only as the bucket idles. A later, shorter pause never shortens it. A caller whose slot a pause moves past its `maxWaitMs`, or that aborts, is refused and its slot returned when it is the latest reservation (otherwise the slot stays empty, never faster than the budget). `available()` is negative while reservations or a pause hold callers. Emits `vsp_rate_limit_waits_total` / `vsp_rate_limit_rejections_total` (catalogue fragment `observability/catalog/connectors.ts`). `parseRetryAfter(value, now)` reads delta seconds or an HTTP date, capped at 300 s. |
| `callDependency(policy, op)` | retry → breaker → bulkhead → timeout → op. Converts unclassified thrown errors into `DependencyError("UNCLASSIFIED_ERROR", "UNKNOWN")` so dependency free text never propagates and is never retried. Records dependency latency, errors by outcome and unknown commits. |

All primitives emit metrics from the catalogue (`vsp_timeouts_total`,
`vsp_retry_attempts_total`, `vsp_nested_retry_refused_total`,
`vsp_circuit_transitions_total`, `vsp_dependency_health`,
`vsp_circuit_rejections_total`, `vsp_bulkhead_*`, `vsp_dependency_*`,
`vsp_unknown_commits_total`). Dependency labels outside the allowlist become `other`.

Safety and human routing must never be placed behind a breaker or bulkhead whose
opening would block them (OPS-02); the independent Talkdesk Studio human route
does not depend on this service at all.

## LOCAL FIXTURE / BLOCKED

No fixtures in this module (tests use a manual timer port and `FakeClock`).
BLOCKED: production thresholds (windows, failure rates, cooldowns, bulkhead
sizes, timeouts) need measured dependency latency, vendor quotas and load tests
(TB-10, spec section 12).

## How to test

```
cd platform
npx vitest run src/resilience
```

The connector runtime (`platform/src/connectors/runtime`) composes these per connector and per operation:
retry with `Retry-After`, then the circuit breaker, then bulkheads, then token buckets; the Layer-2 suite
`make test-integration SUITE=connectors` exercises them over TLS.

## Requirements enforced

ACT-02 / ACT-03 (no retry of UNKNOWN outcomes; reconciliation first), spec section
12 (timeouts, bounded retries with jitter, no retries on retries, circuit breakers,
bulkheads, backpressure), DATA-01 (unclassified dependency errors are reduced to a
reason code).
