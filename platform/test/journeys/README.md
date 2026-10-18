# platform/test/journeys: end-to-end journeys on the LOCAL FIXTURE composition

**LOCAL FIXTURE — SYNTHETIC DATA ONLY.** Status: IMPLEMENTED_OFFLINE. Nothing here ran against
Talkdesk, Salesforce, an IdP, a business system, AWS or a telephone network, and nothing here is
sandbox or production evidence (spec section 16 "Completion reporting").

Every test builds the full local container (`src/main/container.ts` with the REAL business module),
the local console composition and the worker loops, and drives the real HTTP surface:

| Surface | Identity | How |
|---|---|---|
| Telephony-control (TC-01..TC-12, screening, human request) | `telephony_control` (Studio) | `fastify.inject` |
| Tools | `mcp_tools` + trusted `X-VSP-Session-Ref` / `X-VSP-Interaction-Id` | REAL MCP SDK client over 127.0.0.1 (ephemeral port) |
| Portal secure-link approval | `portal` | ID tokens with `amr [pwd, mfa]` minted for SYNTHETIC people by `LocalOidcProviderFixture` |
| Console API | SYNTHETIC staff (LOCAL FIXTURE workforce IdP, MFA) | `fastify.inject` |
| Transfer events (TC-09) | LOCAL FIXTURE HMAC (not a vendor scheme) | signed webhook deliveries |

Time is a `FakeClock`; worker loops are run explicitly. Caller-visible behaviour = the utterances the
response gate renders from approved templates (tool speech, TC-07 prompts) plus the template ids
Studio plays. Backend evidence = database rows (owner-role reads), LOCAL FIXTURE effect logs
(scheduling, billing, Salesforce, telephony), audit events and the audit chain.

## Files

| File | Covers |
|---|---|
| `harness.ts` | Harness (not a test): container, console, worker loops, MCP client, Studio/portal/console helpers, audit chain check |
| `j1-reschedule.test.ts` | J1 verified client reschedules with conflict handling (SLOT_UNAVAILABLE, new options, confirmed commit, one effect, RESOLVED) |
| `j2-billing-dispute.test.ts` | J2 disputed charge -> durable review (IN_REVIEW, workflow + durable grant, SR synced to the Salesforce fixture, REQUEST_ACCEPTED, no refund wording); reconciled-commit follow-up by the worker; guarded transition grant check |
| `j3-j4-authorization.test.ts` | J3 practice staff: North remittance allowed, South denied; J4 partner denied individual records, organization intake accepted (workflow + organization-scoped grant) |
| `j5-j7-j8-routing.test.ts` | J5 unverified human request, warm transfer to CALLER_CONFIRMED_CONNECTED, TRANSFERRED only then; J7 declined recording; J8 unsupported language -> interpreter |
| `j6-safety-handoff.test.ts` | J6 safety handoff without authentication (A0 screening, PENDING_CLINICAL_APPROVAL template, receiver unavailable -> backup -> connected, time to route, console safety view); pending mutation invalidated by a safety signal |
| `j9-repeat-caller.test.ts` | J9 repeat caller: open issue remembered; shared-phone unverified call gets no recap; verified repeat call hears the recap |
| `faults.test.ts` | Injected faults: auth expiry, two concurrent calls, interrupted confirmation, duplicate/out-of-order webhooks, crash after commit, Salesforce outage, failed transfer, audit outage (each in its own container) |
| `console-retry.test.ts` | Staff retry after a NOT_FOUND reconciliation through the console API (ACT-03) |

## Commands

```bash
cd platform
npx vitest run test/journeys          # all journeys and faults
npx vitest run test/journeys/j6-safety-handoff.test.ts
```

## Known failing cases (`it.fails`, defects outside this module's ownership)

| Test | Defect | Proposed fix |
|---|---|---|
| `j1-reschedule.test.ts` "IntegrityVerifier verifies the journey's audit streams" | `src/audit/verifier.ts:283` (and `:415`) select `sequence::text as sequence ... order by sequence`; PostgreSQL orders by the TEXT alias, so any stream with >= 10 events reports SEQUENCE_GAP / SEQUENCE_OUT_OF_ORDER / PREV_HASH_MISMATCH / HEAD_MISMATCH although the chain is intact | `order by audit_outbox.sequence` |
| `j1-reschedule.test.ts` "the audit shipper exports every journey event" | same pattern in `src/audit/shipper.ts:198-200` and `:259-261`: a stream with >= 10 unshipped events fails its own continuity check (`AUDIT_CHAIN_GAP`) and stops shipping | `order by audit_outbox.sequence` in both queries |
| `faults.test.ts` "with only the composed worker loops ... syncs after Salesforce recovers" | no worker loop calls `PgSupportRequestService.retryDue`, so a request whose first sync failed stays RETRY_SCHEDULED forever | add a support-sync retry loop to `src/worker/worker.ts` `workerLoopsFor` (port method `SupportRequestService.retryDue` now exists) and a `WORKER_LOOP_NAMES` entry |

Because of the first defect, `expectAuditChainIntact()` verifies each stream with the audit
module's own `verifyChain` over rows read in numeric sequence order, plus the chain head.

## Simulations used (all LOCAL FIXTURE)

* Crash after commit: the provider commit succeeds, then every database write of the process fails
  until "restart" (the harness swaps `db.tx`), leaving the ledger in COMMITTING.
* Ambiguous timeout before the provider (console retry): the provider port throws
  `DependencyError(TIMEOUT_AFTER_SEND, UNKNOWN)` without calling the fixture.
* Audit outage: `revoke insert on audit_outbox from app_runtime` for the duration of the fault.
* Salesforce outage, billing timeout-after-commit: the shared `FaultInjector`.
* Transfers: scripted telephony fixture outcomes and signed LOCAL FIXTURE webhook events.
