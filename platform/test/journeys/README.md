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
| `j2-billing-dispute.test.ts` | J2 disputed charge -> durable review (the caller names the charge with the typed line selector; IN_REVIEW, workflow + durable grant, SR synced to the Salesforce fixture, REQUEST_ACCEPTED, no refund wording); reconciled-commit follow-up by the worker; the specialist's decision notice passes the grant check and the CURRENT pre-disclosure recheck and completes; consent revoked / account closed after acceptance => POLICY_CHANGED_PENDING_ACTION (human keeps it), restored state completes; a reconciled review without a consent snapshot waits for current consent |
| `j3-j4-authorization.test.ts` | J3 practice staff: North remittance allowed, South denied; Riley's request linked to the account is organization-scoped (North) and found again through `get_authorized_case_status`; J4 partner denied individual records, organization intake accepted (workflow + organization-scoped grant); a provider's own schedule (own open slots, no client record; an unrelated client's appointment denied) |
| `j5-j7-j8-routing.test.ts` | J5 unverified human request, warm transfer to CALLER_CONFIRMED_CONNECTED, TRANSFERRED only then; J7 declined recording; J8 unsupported language -> interpreter |
| `j6-safety-handoff.test.ts` | J6 safety handoff without authentication (A0 screening, PENDING_CLINICAL_APPROVAL template, receiver unavailable -> backup -> connected, time to route, console safety view); pending mutation invalidated by a safety signal |
| `j9-repeat-caller.test.ts` | J9 repeat caller: open issue remembered; shared-phone unverified call gets no recap; verified repeat call hears the recap |
| `faults.test.ts` | Injected faults: auth expiry, two concurrent calls, interrupted confirmation, duplicate/out-of-order webhooks, crash after commit, Salesforce outage, failed transfer, audit outage (each in its own container) |
| `console-retry.test.ts` | Staff retry after a NOT_FOUND reconciliation through the console API (ACT-03) |
| `transactions.test.ts` | Transaction-safety regressions (one fresh composition per block): barge-in after an UNKNOWN commit invalidates it durably (ACT-F1); staff retry after a safety escalation or a stale confirmation commits nothing (ACT-F3); TC-07 states a modality change (ACT-F5); a stale read after COMMITTED still speaks the receipt-bound new time (ACT-F4); an intake timeout is UNKNOWN_OUTCOME and the same-key retry replays the one complaint + workflow (ACT-F2); a date-shaped idempotency key is refused on a protected read and never blocks a safety route (VSP-GW-04); a closed complaint is not recapped as open (DP-03) |
| `recheck.test.ts` | Pre-disclosure recheck (`src/business/recheck.ts`) on guarded transitions of real accepted work: linked complaint allowed, unverified complaint waits for a human, partner notice allowed then denied after the affiliation ends, representative-held grant denied on expired authority and allowed once renewed, a newer policy bundle (temp build with the pinned OPA) denies (POLICY_CHANGED_PENDING_ACTION with the new version) or is recorded as POLICY_VERSION_CHANGED, undefined rule and missing transaction fail closed |
| `outcomes.test.ts` | TC-11 outcome without a live session (expired, revoked; a session of another call or a repeated end records nothing); a commit UNKNOWN / COMMITTING at call end is OUTCOME_UNKNOWN and the reconciler's commit appends a RESOLVED revision exactly once (append-only) |

## Commands

```bash
cd platform
npx vitest run test/journeys          # all journeys and faults
npx vitest run test/journeys/j6-safety-handoff.test.ts
```

## Known failing cases (`it.fails`)

None. The former `j1-reschedule.test.ts` cases ("IntegrityVerifier verifies the journey's audit
streams", "the audit shipper exports every journey event": text-ordered sequences in
`src/audit/verifier.ts` / `shipper.ts`) are normal tests since the audit fix, and J2's guarded
transition no longer expects `RECHECK_NOT_CONFIGURED` (a real recheck is wired).

The former `faults.test.ts` known failure ("with only the composed worker loops ... syncs after
Salesforce recovers") is now a normal test: the worker loop `support.sync_retry` runs
`SupportRequestService.retryDue`.

`expectAuditChainIntact()` still verifies each stream with the audit module's own `verifyChain`
over rows read in numeric sequence order, plus the chain head (independent of the verifier).

## Simulations used (all LOCAL FIXTURE)

* Crash after commit: the provider commit succeeds, then every database write of the process fails
  until "restart" (the harness swaps `db.tx`), leaving the ledger in COMMITTING (faults, outcomes).
* Consent revocation / account closure after acceptance: the LOCAL FIXTURE consent registry
  (`container.recheck.consent`) and `LocalIdentityDirectoryFixture.setAccountState`; registry
  changes (affiliation ended, authority renewed) through `RelationshipDirectoryFixture`.
* Policy change: a copy of `policy/` with a changed catalogue and VERSION built in a temp directory
  with the pinned OPA, loaded into a second workflow engine over the same database.
* Ambiguous timeout before the provider (console retry): the provider port throws
  `DependencyError(TIMEOUT_AFTER_SEND, UNKNOWN)` without calling the fixture.
* Audit outage: `revoke insert on audit_outbox from app_runtime` for the duration of the fault.
* Salesforce outage, billing timeout-after-commit: the shared `FaultInjector`.
* Transfers: scripted telephony fixture outcomes and signed LOCAL FIXTURE webhook events.
