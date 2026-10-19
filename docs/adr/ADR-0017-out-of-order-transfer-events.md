# ADR-0017 Out-of-order transfer events: an early progress event is held per attempt and applied only after its predecessor, never early

| Field | Value |
|---|---|
| Status | **Accepted for engineering**. Live transfer events and their delivery order guarantees: **UNKNOWN / BLOCKED** (TB-07, PRQ-019). Webhook authentication: **UNKNOWN** (TB-09, PRQ-021). Vendor transfer-state query for a truly lost predecessor: **BLOCKED** (TB-07, PRQ-004) |
| Date | 2026-10-18 |
| Decided by | Principal engineer (coding agent) for the engineering scope only |
| Approval needed from | Clinical safety lead and telephony owner (accept the lost-predecessor residual below); business owner and corpus owners (the separate post-call outcome revision item) |
| Related prerequisites | PRQ-004, PRQ-008, PRQ-019, PRQ-021, PRQ-033 |

## Context

Spec section 10: implement transfer as REQUESTED, QUEUED, RECEIVER_ACCEPTED, BRIDGED,
CALLER_CONFIRMED_CONNECTED and COMPLETED; the caller is not transferred when a dial command
succeeds; if the transfer fails, play an approved update and invoke the next staffed route.
Section 8: events are at least once and consumers deduplicate; preserve customer intent when
vendors redeliver webhooks. Section 14 (test layers) asks for vendor-failure tests with
out-of-order events and duplicate callbacks; section 16 injects duplicate webhooks. SAFE-04: a
transfer succeeds only with receiver acceptance and a verified connection.

Corpus cause **OUT_OF_ORDER_TRANSFER_EVENT_DROPPED** (7 failing runs in the w4 risk corpus:
`scn_risk_duplicate_webhook_020`, `_022` (SAFETY, 5 runs) and `_024`). With the
`EVENTS_OUT_OF_ORDER` fault the LOCAL FIXTURE telephony swaps adjacent events, so
CALLER_CONFIRMED_CONNECTED arrives before BRIDGED. The pure transition rejected it
(`TRANSFER_EVENT_OUT_OF_ORDER`) and the coordinator only audited the rejection. Neither delivery
path redelivers an event that was answered normally (the worker loop returns, the webhook answered
200), so the event was lost. The attempt sat at BRIDGED until the sweep timed it out (60 s STANDARD,
30 s SAFETY); the coordinator then played the approved update prompt and dialled the next route,
although the caller was already connected to a human. The fault plan says "No caller-visible
change". The caller-visible effects were the update prompt and the second dial.

## Decision

In `TransferCoordinator` (`platform/src/workflows/transfer.ts`); the pure `transferTransition` is
unchanged, so its SAFE-04 property test keeps its meaning:

1. **Hold, never apply early.** `applyEvent` runs its existing checks first (unknown attempt,
   `SUPERSEDED` journey, `yieldsToSafety`, stale attempt), so superseded journeys and stale
   attempts never hold anything. Then a BRIDGED, CALLER_CONFIRMED_CONNECTED or COMPLETE that the
   pure function rejects `TRANSFER_EVENT_OUT_OF_ORDER` is stored on the journey
   (`deferredEvents`: transferId, event, eventId, original source, receivedAt). The decision is
   `deferred` with reason `TRANSFER_EVENT_AWAITING_PREDECESSOR`, audited `transfer.event_deferred`
   (PENDING). State, history, `connectedAt` and `appliedEventIds` are unchanged, and the timeout
   clock (the attempt's last applied history entry) is not refreshed.
2. **Bounded and idempotent.** At most one held entry per (transferId, event) and per eventId, and
   at most 3 per attempt (`TRANSFER_DEFERRED_EVENTS_FULL` beyond that, unreachable with valid input).
3. **Drain in order.** After each applied progress transition, the current attempt's held events
   are taken in progression order. Each one goes through `transferTransition` again, and draining
   stops at the first one that is still out of order, so CALLER_CONFIRMED_CONNECTED applies only
   from BRIDGED. Each drained entry of a STANDARD journey is a STANDARD routing step and yields to
   the call's active SAFETY journey first (`yieldsToSafety`, SAFE-03, ADR-0016): a safety route that
   started after the event's own check, in the predecessor's write window, stops the drain even when
   its supersede write failed, and the entry stays held until the supersede discards it. The
   applied history entry keeps the event's original vendor source (never a coordinator source),
   `rememberEvent` records the original eventId at drain time (a later redelivery is a duplicate),
   and the application is its own `transfer.state_changed` audit entry.
   It carries the same opaque event reference as the deferral (`transfer_event:tev_<digest>`); the
   vendor event id itself is never written to audit (DATA-01).
4. **Discard when the attempt cannot use them.** Held events are removed and audited
   `transfer.deferred_events_discarded` (INVALIDATED) when their attempt reaches a terminal or
   failover state or CALLER_DISCONNECTED (`TRANSFER_ATTEMPT_CLOSED`), the journey ends on a caller
   disconnect between attempts (`CALLER_DISCONNECTED`), a new attempt starts
   (`TRANSFER_ATTEMPT_REPLACED`), or the journey is superseded by the safety route
   (`SUPERSEDED_BY_SAFETY_ROUTE`, in the same conditional write). A held CALLER_CONFIRMED_CONNECTED
   never connects a timed-out attempt or the next attempt.
5. **Recovery of a lost drain write.** A drain whose write loses a version race leaves the event in
   the stored journey; the sweep drains held events of routing journeys before its timeout check.
   The sweep does not visit CONNECTED journeys: a held COMPLETE whose drain write lost stays held
   until a later event of that attempt (the journey stays CONNECTED, the outcome TRANSFERRED).
6. **Webhook.** `POST /v1/webhooks/transfer-events` answers 200 `{accepted: true, decision:
   "deferred"}` for a held event (the event is durably held; a 2xx tells the sender not to
   redeliver). The response enum and `schemas/openapi/gateway.openapi.json` include `deferred`. No
   vendor sequence number is used for ordering (its semantics are UNKNOWN, TB-07); the route still
   refuses with 403 `WEBHOOK_AUTH_UNVERIFIED` outside local/ci (TB-09).

Tests (offline; LOCAL FIXTURE store and telephony, SYNTHETIC calls, FakeClock):
`platform/src/workflows/transfer.test.ts` (explicit SAFE-04 assertions right after the early
event), `platform/src/workflows/transfer.out-of-order.test.ts` (timeout and failover exactly at
`attemptTimeoutMs` for STANDARD 60 s and SAFETY 30 s, discard on close, replace and supersede,
stale attempts and superseded journeys never hold, bounded redelivery, vendor provenance, drain
recovery by the sweep, a drain that yields to a safety route started in the predecessor's write
window while its supersede write fails, a fast-check property under permutation and duplication,
and out-of-order-only delivery through `LocalTelephonyDeliveryLoop`),
`platform/src/gateway/http/webhook-routes.test.ts`, and `platform/test/journeys/faults.test.ts`
(webhook and worker-loop delivery, STANDARD and SAFETY). The SAFE-HANDOFF-02 race tests
(`transfer.supersede-race.test.ts`, `test/journeys/safety-supersede-race.test.ts`) still pass.
Status: IMPLEMENTED_OFFLINE.

## Consequences

* With every event eventually delivered (only permuted), the first leg connects: one attempt, no
  update prompt, one dial, and TC-11 records TRANSFERRED from the full acceptance, bridge and
  connection evidence. Nothing here is Talkdesk or production evidence.
* **Residual: a truly lost predecessor still fails over.** If BRIDGED never arrives while the
  vendor reports the caller connected, the held CALLER_CONFIRMED_CONNECTED is discarded at the
  timeout and the next route is dialled. BRIDGED is never inferred from CALLER_CONFIRMED_CONNECTED
  (SAFE-04). The complete fix is a vendor transfer-state reconciliation before failing over an
  accepted or bridged attempt; `TelephonyControl` has no such operation (TB-07). This is for the
  clinical safety lead and the telephony owner (PRQ-008, PRQ-004, PRQ-019).
* **Drain and supersede.** Without the yield in the drain, a held CALLER_CONFIRMED_CONNECTED
  drained after a safety route had started (its supersede write failed in a store outage) connected
  the STANDARD journey. A CONNECTED STANDARD journey is outside the sweep's work list, so once the
  safety leg was also CONNECTED nothing superseded it, and a later STANDARD bridge drop failed over
  with STANDARD update prompts and dials on a call that had a safety route (found in independent
  verification; covered by `transfer.out-of-order.test.ts`). The yield closes this drain path. It
  does not change the ADR-0016 behaviour for a STANDARD journey that was already CONNECTED before
  the safety route started and whose supersede write failed until the safety leg connected.
* **Residual: a lost drain write fails the delivery.** `applyEvent` throws the drain's
  `ConflictError` although the predecessor was written, so the webhook answers 500 (a retry with the
  same signature is refused 401 `WEBHOOK_REPLAYED`) and recovery relies on the sweep (routing
  journeys only). A supersede that lands in that window is not such a race any more: the drain's
  yield adopts the stored SUPERSEDED journey and the delivery succeeds.
* **Residual: a SAFETY store gap can lose a held event.** For SAFETY journeys `persist` counts and
  logs non-conflict store errors instead of failing, and the next event reloads the stored journey.
  A held event whose write was lost is then gone, and behaviour falls back to timeout and failover
  (fail-safe; same as before this decision). Only a version conflict leaves the entry stored for the
  sweep.
* **Not decided here: post-call outcome revision.** A transfer that connects after TC-11 has
  recorded OUTCOME_UNKNOWN is not revised to TRANSFERRED; no transfer-driven revision exists. That is
  a separate item for the business owner and corpus owners, together with
  `RECONCILED_COMMIT_OUTCOME_REVISION` (PRQ-033). If pursued it must revise only from
  OUTCOME_UNKNOWN without a recorded caller disconnect, never override CALLER_DISCONNECTED,
  DECLINED_BY_POLICY or FAILED, require a server-side journey with `connectedAt` set, and run after
  the transfer write without throwing into or delaying `applyEvent`.
* `deferredEvents` is optional on stored journeys (journeys written before this decision read as
  empty). The live transfer store is BLOCKED (PRQ-004); it must keep the field within the same
  conditional write as the attempt.
* The `EVENTS_OUT_OF_ORDER` fault-plan description ("BRIDGED arrives before RECEIVER_ACCEPTED") does
  not match the fixture's pairwise swap (RECEIVER_ACCEPTED before QUEUED, CALLER_CONFIRMED_CONNECTED
  before BRIDGED); reported to the corpus owners, not changed here.

## Alternatives considered

| Alternative | Why not adopted |
|---|---|
| Keep rejecting and rely on redelivery (make `TRANSFER_EVENT_OUT_OF_ORDER` retryable: throw in the worker loop, 409/503 from the webhook) | Works on the fixture only because it redelivers; depends on undocumented vendor redelivery (TB-07, TB-09); the webhook replay guard refuses an identical re-signed retry; the fixture caps redeliveries |
| Order by the vendor's sequence number | Sequence semantics are UNKNOWN (TB-07); the transfer state machine already defines the order |
| Infer BRIDGED when CALLER_CONFIRMED_CONNECTED arrives | Violates SAFE-04: success would be claimed without bridge evidence |
| Apply the early event at once and reorder history afterwards | `connectedAt` would be set before the predecessor exists; the SAFE-04 property no longer holds at every step |
| Refresh the attempt timeout when an early event arrives | A predecessor that never arrives would delay the failover of a vulnerable caller (spec section 10: a numeric deadline must never abandon a caller; neither may a held event postpone the next route) |
| Record a drained event with a coordinator source | The connection evidence would show the platform, not the vendor, as its origin |

## Linked requirements

SAFE-03, SAFE-04, ACT-02, OPS-01, OPS-02, SPEC-10 (transfer contract), SPEC-14.failure-injection
(alias SPEC-14.faults: out-of-order events, duplicate callbacks), SPEC-16.fault-injection (duplicate
webhooks).

## Revisit when

Talkdesk documents transfer events, their ordering and redelivery semantics or a transfer-state
query (TB-07, PRQ-019), webhook authentication is documented (TB-09, PRQ-021), the live transfer
store is designed (PRQ-004), or the business owner decides on post-call outcome revision (PRQ-033).
