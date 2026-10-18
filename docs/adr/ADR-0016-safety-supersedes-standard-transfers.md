# ADR-0016 A safety route supersedes the standard transfer journeys of the same call: conditional write with bounded retry, and every standard step yields to an active safety journey

| Field | Value |
|---|---|
| Status | **Accepted for engineering**. Withdrawing a standard dial already in flight at the vendor: **BLOCKED** (no cancel operation; TB-07, PRQ-019). Live transfer store and live transfer events: **BLOCKED** (PRQ-004, PRQ-019) |
| Date | 2026-10-18 |
| Decided by | Principal engineer (coding agent) for the engineering scope only |
| Approval needed from | Clinical safety lead and support operations (accept the residual races below; update-prompt content) |
| Related prerequisites | PRQ-004, PRQ-008, PRQ-019, PRQ-028 |

## Context

Spec section 10: on a credible or unresolved safety concern, stop ordinary administrative work and
begin priority human connection; a dial command is not a transfer; if a transfer fails, play an
approved update and invoke the next staffed route; never abandon a vulnerable caller. SAFE-03:
nothing silently terminates a safety flow. SAFE-04: a transfer succeeds only with receiver
acceptance and a verified connection.

Review finding **SAFE-HANDOFF-02**: a STANDARD journey (the caller asked for a person) and a SAFETY
journey of the same call could both stay active, so the standard route kept timing out, playing
standard update prompts and re-dialling while the caller was on the safety route. The first fix
logged a version conflict on the supersede write and moved on, which left the STANDARD journey
ROUTING and re-dialled by the sweep (round 2 of the finding). **SAFE-HANDOFF-01** (a bridge drop
re-enters the fallback chain) shares the coordinator but is not part of this decision.

## Decision

In `TransferCoordinator` (`platform/src/workflows/transfer.ts`):

1. **At most one non-terminal journey per call, SAFETY first.** Starting or re-requesting a SAFETY
   journey marks every active STANDARD journey of the call `SUPERSEDED` (terminal; audited
   `transfer.superseded`, reason `SUPERSEDED_BY_SAFETY_ROUTE`). The SAFETY journey dials its
   priority route first and supersedes afterwards, so the safety route never waits on supersede
   writes. A STANDARD request while a SAFETY journey of the call is ROUTING or CONNECTED dials
   nothing and returns that SAFETY journey (audited `transfer.standard_request_superseded`).
2. **Conditional supersede write with bounded retry.** `supersedeJourney` writes `SUPERSEDED` with
   the stored version; a `ConflictError` (the journey was written between read and write, for
   example its vendor dial returned) is retried on a fresh read, at most `MAX_SUPERSEDE_WRITES`
   (8) times, then logged `TRANSFER_SUPERSEDE_RETRIES_EXHAUSTED`.
3. **Every STANDARD step yields.** `yieldsToSafety` runs first in the sweep, on a vendor event
   (rejected `TRANSFER_JOURNEY_SUPERSEDED`), in the failover, before retry and between-tries update
   prompts, and right before every dial (`startAttempt`). With an active SAFETY journey it
   supersedes and the step does not proceed, also when the supersede write failed. A failed lookup
   throws, so a STANDARD journey fails closed on store errors; SAFETY journeys keep routing.
4. **Write-then-read on both sides.** A new STANDARD journey is written before its first dial
   check and re-reads after routing (`supersedingSafety`); a SAFETY journey is written before its
   supersede read. Of two concurrent requests at least one sees the other.
5. **The sweep re-supersedes** for every routing SAFETY journey, so a supersede that could not be
   written (store outage, retries exhausted) is retried until it lands, including for CONNECTED or
   HOLDING_FOR_OPERATIONS STANDARD journeys that the sweep does not otherwise visit.
6. **A dial that was already sent** when the supersede committed is recorded on the superseded
   journey (`recordSupersededDial`: vendor reference kept; audited `transfer.attempt_started`,
   outcome `INVALIDATED`, reason `SUPERSEDED_BY_SAFETY_ROUTE`), so its late vendor events are
   matched and rejected; it is never retried or failed over.
7. In the business layer, `HandoffService.requestHuman` (`platform/src/business/handoff.ts`)
   takes the safety route instead of a STANDARD one when the call already has an active SAFETY
   journey, the session carries `SAFETY_ESCALATION_ACTIVE`, or the reason, category or selected
   destination is a safety one.

Tests (offline, LOCAL FIXTURE store and telephony, SYNTHETIC calls): `platform/src/workflows/transfer.test.ts`
(`[SAFE-HANDOFF-02]`), `platform/src/workflows/transfer.supersede-race.test.ts` (forced
interleavings with explicit gates, bounded retries under endless contention, and an exhaustive
grid of 2 x 2 x 36 x 30 microtask interleavings asserting no active STANDARD journey beside the
SAFETY journey and no STANDARD dial or prompt in later sweeps),
`platform/test/journeys/safety-supersede-race.test.ts` (composition) and
`platform/src/business/handoff.test.ts` (`SAFE-HANDOFF-02`). Status: IMPLEMENTED_OFFLINE.

## Consequences

Known residuals (the tests assert the state after concurrent requests settle; they do not exclude
these windows):

* **One STANDARD update prompt can still play in a narrow race.** The failover, retry and
  between-tries paths check `yieldsToSafety` and then call `playUpdate` with no write in between.
  If the SAFETY journey is written after that check and before the prompt is sent, one STANDARD
  update prompt (an approved template id) plays; the next step re-checks before dialling and
  yields.
* **A dial whose pre-dial write committed before the supersede read can still be sent.**
  `startAttempt` checks, writes the attempt (pre-dial write), then sends the dial. A SAFETY journey
  created after the check whose supersede read sees that write supersedes the journey while the
  dial is still sent; the post-dial write then conflicts, and the dial is recorded and its events
  rejected (decision 6). The `TelephonyControl` port has no cancel operation, so the dial is not
  withdrawn at the vendor (TB-07, PRQ-019); what the vendor does with that call leg is UNKNOWN.

Other consequences:

* `MemoryTransferStore` is a LOCAL FIXTURE. The invariant depends on the live store offering
  conditional writes and a read-after-write consistent per-call listing (`listForCall`); the live
  store is BLOCKED (`platform/src/workflows/README.md`).
* Superseded STANDARD journeys stay in the store for review (`journeysForCall`) and are visible
  through the audit events above;
  [`../RUNBOOKS/failed-safety-transfer.md`](../RUNBOOKS/failed-safety-transfer.md) does not yet
  describe superseded journeys or a superseded dial that a human answered.
* Update-prompt content and the staffed safety response plan are clinical and operational
  approvals (PRQ-028, PRQ-008), not engineering facts.

## Alternatives considered

| Alternative | Why not adopted |
|---|---|
| Log the version conflict and continue (first fix) | Left the STANDARD journey ROUTING; the sweep re-dialled it (round 2 of SAFE-HANDOFF-02) |
| Let STANDARD and SAFETY journeys coexist | Two humans could be dialled and the caller bridged to a standard queue during a safety concern |
| Supersede before the safety dial | Puts store writes ahead of the priority route (2 s engineering target to route initiation) |
| A per-call lock in the coordinator | Holds only within one process; the store is the shared point between gateway processes |
| Re-check between the pre-dial write and the dial | Narrows but cannot close the window without a vendor cancel operation; the dial is recorded and rejected instead |

## Linked requirements

SAFE-02, SAFE-03, SAFE-04, OPS-02, SPEC-10 (transfer contract, safety escape route).

## Revisit when

Talkdesk documents transfer events and a transfer-cancel capability (TB-07, PRQ-019), the live
transfer store is designed (PRQ-004), or the clinical safety lead reviews the residual races.
