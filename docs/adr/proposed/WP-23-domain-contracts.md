# ADR (proposed by WP-23) Canonical domain contracts, live domain adapters over the WP-06 connector runtime, and a reference business API

| Field | Value |
|---|---|
| Status | **Proposed** (phase C; the phase integration package assigns the ADR number). Use against a tenant's real system of record, production writes or PHI: **Pending human approval** (tenant activation per AIN-10 and AIN-36, egress approval per AIN-49) |
| Date | 2026-10-21 (round 1 refix 2026-10-22; round 2 refix 2026-10-22: absence by fence, legacy dispatch reservation) |
| Decided by | Principal engineer (coding agent) for the engineering scope only |
| Approval needed from | Security leadership and privacy counsel (egress destinations and data classes per tenant system); the tenant's integration owner (profile, binding, visibility window, write mode); operations (sandbox write qualification) |
| Origin | `docs/adr/proposed/WP-23-domain-contracts.md` |

## Context

Follow-on FO-00-13, FO-01-14, FO-01-25, FO-01-26, FO-01-30, FO-03-09, FO-06-26, FO-06-72 to FO-06-76, FO-11-02,
FO-16-17, FO-17-24 (BILLING_TIMEOUT, CLAIMS_TIMEOUT, PROVIDER_API_TIMEOUT, SCHEDULING_UNAVAILABLE, PARTIAL_WRITE) and
FO-19-21. Before this package the business layer's scheduling, billing, claims and provider systems were in-process
LOCAL FIXTURES; no domain effect could run through a production adapter, and no system of record existed to prove
exactly-once and reconciliation over a real protocol. WP-06 delivered the connector runtime (admitted ConnectorProfiles,
the bounded mapping DSL, the egress-classified TLS transport, capability-scoped credentials, retry classification,
health probes). WP-07 owns the composition root; WP-25 owns the action contracts and EffectVerification from phase D.
Environment status of everything here: NOT_CONFIGURED; no tenant system has been connected.

## Decision

1. **Canonical contracts, not vendor shapes.** `platform/src/domain/contracts.ts` defines one model per capability:
   appointment and slot options (administrative availability only), invoice, payment, insurer-reported claim status,
   provider onboarding with derived missing documents, remittance, referral, payer authorization and eligibility status.
   Every record carries a `source` (profile id, configuration digest, mapping digest, operation, response digest, read
   time) that only a connector read creates, so memory, a summary or program membership can never be presented as an
   authoritative status (FO-01-30). No field states a coverage decision, a fee waiver, a refund, a payout authorization,
   a claim decision or a clinical suitability (FO-06-76). Fields the platform must never ingest (visit reason, diagnosis
   codes, card and bank fragments, member reference, clinical summary) are PROHIBITED rules in every reviewed mapping.
2. **Tenant mapping is data in the bounded DSL.** A tenant's system is connected with a reviewed ConnectorProfile
   (`referenceProfile` builds the reference API's) admitted by the WP-06 rules, plus a **domain binding**
   (`binding.ts`): canonical operation -> reviewed profile operation, the reconciliation lookup, the documented
   visibility window, the clock-skew allowance and how an incomplete multi-step write is completed. Status and modality
   codes of another dialect, wall-clock times in a business zone and units are enum, zone and unit tables of the DSL;
   a code outside the table is schema drift and the whole response is refused. A binding is refused when a write is
   not reconcilable through the contract's lookup (`BINDING_NON_IDEMPOTENT_WITHOUT_RECONCILIATION`,
   `BINDING_WRITE_WITHOUT_RECONCILIATION`, FO-06-75).
3. **Adapters are factories over the connector runtime.** `createDomainAdapters` admits every profile and binding
   (refusing credential reuse across the set), builds one ConnectorRuntime per profile and returns the adapters. They
   satisfy the existing `SchedulingSystem`, `BillingSystem`, `ClaimsSystem` and `ProviderSystem` ports structurally, and
   `DomainCommitPort` satisfies `ProviderCommitPort` (prepare by authoritative read-back, commit, receipt, reconcile,
   current version) plus `verifyEffect` (an `EffectVerification` by authoritative read-back, independent of the model).
   The domain module does not import actions, business or main (module register: write-port module).
4. **Exactly-once with a keyed request id.** Every write is a change request PUT to a request id derived one-way from
   the ledger's stable provider key (`requestIdFor`: opaque, URL-safe, stable across processes); retries, redelivery
   and a second replica send the same id and the system applies the change at most once. The system re-checks
   versions and the acting party's authority itself. Only a REJECTED answer is FAILED; any other answer that is not
   COMPLETED with a receipt (INCOMPLETE, COMPLETED without a receipt, a 422 for a request id reused with another
   payload, anything after send) is UNKNOWN and reconciled before any retry. The body of a domain-prepared write
   follows from the confirmed action alone; a business-layer preparation without slot versions looks its request id
   up before any body is derived from current state, so a redelivery never sends a second, different body under one
   key.
5. **Reconciliation semantics.** COMPLETED with its receipt is COMMITTED; INCOMPLETE (step 1 applied, receipt missing:
   PARTIAL_WRITE) is completed by its request id (step 2 only) when the binding declares `COMPLETE_BY_REQUEST_ID`, else
   it stays UNKNOWN for a human; REJECTED is no effect. A found change counts for the action only when its **request
   digest** (`REFBIZ_REQUEST_V1`: SHA-256 over `refbiz.request.v1`, the operation and the canonical JSON body, stored
   by the system and returned in the lookup and the receipt) equals the digest the platform recomputes from the
   confirmed action, and its resource (record, slot, subject, start as an instant) matches; otherwise the decision is
   UNKNOWN `PAYLOAD_MISMATCH`, never the other action's receipt.
6. **Absence is proved by the system's fence, never by a clock.** A lookup 404 proves nothing by itself: the index
   lags, a write can wait behind a lock, and a write that passed its final deadline check can still COMMIT after the
   deadline (a stalled process, a slow fsync, a replication wait: round-2 verifier probe commitlatency). Every keyed
   write carries `notAfter` (the preparation's expiry plus the write timeout: deterministic from the confirmed action,
   identical on every replica and redelivery); the reference API bounds lock waits by it and checks it as the last
   statement before COMMIT (past it: REJECTED `DEADLINE_EXCEEDED`, 409). That bounds how long a delivery keeps trying
   (liveness). The proof of absence is the binding's **fence** (`reconciliation.fenceOperationId`): once the deadline
   plus the skew allowance has passed, the platform asks `POST /change-requests/{requestId}/fence` (legacy:
   `POST /legacy/references/{externalRef}/fence`) with that deadline. The system inserts a FENCED row under the same
   unique key the write inserts, only while its own clock is past the deadline; the insert waits for a delivery still
   inside its transaction, so the answer is either the change that exists (no lookup lag) or a fence under which no
   delivery can ever apply (409 FENCED). Only FENCED (or a REJECTED request) is NOT_FOUND; a fence that cannot
   answer, an early fence (409 `FENCE_BEFORE_DEADLINE`), or a binding without a fence is UNKNOWN. A fence needs the
   deadline (`BINDING_FENCE_WITHOUT_DEADLINE`); the system states both in its consistency report (`absenceProof:
   FENCE_AFTER_DEADLINE`) and the capability test probes the fence with a synthetic id.
7. **A non-idempotent API needs its supported path and a dispatch marker.** The legacy product's create
   (`scheduling.legacy.v1`) creates another appointment on every delivery. It carries an external reference derived
   from the stable key and is never retried by the runtime after send (NOT_IDEMPOTENT_RECONCILE_REQUIRED). Because the
   by-reference lookup lags, it cannot tell a redelivery whether a create was sent (round-2 verifier probe legacylag:
   two appointments from one key). Each delivery therefore first **reserves** the reference with a fresh dispatch id
   (`PUT /legacy/references/{externalRef}`: the first reservation wins) and creates only when the reservation is its
   own; a redelivery never creates (UNKNOWN until the appointment is visible, then that appointment); a create that
   provably never left releases its reservation; the fence settles an unknown outcome (POSTED or FENCED). A binding of
   a non-idempotent write without a reservation or a fence is refused. A found appointment must match the action
   (subject, provider, start); more than one under a reference is UNKNOWN for a human.
8. **Authority families.** Client actions are CLIENT_CONFIRMED by the record's own client; provider-approved actions
   (`provider.appointment.reschedule`, `provider.appointment.cancel`, `provider.availability.block`) are
   PROVIDER_APPROVED by the provider whose schedule it is. A provider's approval is never a client's consent: refused
   before any I/O by the port and again by the system of record (403 AUTHORITY_REFUSED). Bookings and billing reviews are
   client-only. The acting party comes from the session or the confirmed action, never from the record being changed:
   the business-layer `reschedule` and `markInReview` refuse `ACTING_PARTY_REQUIRED` before any I/O when the caller does
   not pass it. The availability block has no ledger kind until WP-25 adds it; it runs through
   `DomainCommitPort.commitCommand`, which refuses any kind the ledger knows (`DOMAIN_KIND_REQUIRES_LEDGER`),
   re-checks the preparation digest (which covers its preparation and expiry times) and that the authority is the
   kind's own, refuses an expired or self-extended preparation, and derives the dispatch deadline from its expiry.
9. **A reference business API stands in for tenant systems.** `services/reference-business-api` (Fastify + PostgreSQL,
   OpenAPI 3.1 in `openapi/`) implements the contracts over OAuth client credentials with scopes, TLS by SNI per host,
   change requests with lookup-by-key, receipts, documented visibility windows, two account dialects and a legacy
   non-idempotent endpoint. Its fault-control listener (faults, barriers, endpoints that refuse or stall connections,
   synthetic seeding) exists only with `REFBIZ_FAULT_CONTROL=enabled` in local/ci, binds loopback, requires the API
   bind to be loopback too and refuses any request whose `Host` is not loopback (DNS rebinding); the configuration
   refuses it anywhere else, and without it the fault board records nothing.
10. **Operator capability test.** `runDomainCapabilityTest` runs the WP-06 probes and adds a FRESHNESS_TEST step: the
   system's own documented window must not exceed the binding's, the system must enforce the dispatch deadline and
   offer the request digest, the fence and the dispatch reservation the binding declares
   (`DISPATCH_DEADLINE_NOT_ENFORCED`, `REQUEST_DIGEST_NOT_OFFERED`, `FENCE_NOT_OFFERED`,
   `DISPATCH_RESERVATION_NOT_OFFERED`); an authorized fence probe of a synthetic id must come back FENCED; and
   the approved synthetic record must map into the canonical contract. A write capability is qualified only by an authorized sandbox write and its reconcile lookup.

## Consequences

- The composition owner can swap the LOCAL FIXTURE systems for the live adapters without changing the business layer;
  the business `SchedulingCommitPort` already runs unchanged over `HttpScheduling` (its key lookup cannot prove an
  absence without the action and answers UNKNOWN), and `DomainCommitPort` is the recommended commit port.
- The absence rule is deliberately conservative: an action whose write may have been dispatched is proved absent only
  by the system's fence after its dispatch deadline, so a retry after a definitive NOT_FOUND is a new, re-confirmed
  action (the ledger expires the old one). A tenant system without a fence still works, but its in-doubt actions are
  resolved by a human; a legacy system without a reservation operation cannot be bound until a platform-side dispatch
  journal exists.
- The business layer must pass the acting party to `reschedule` and `markInReview` (WP-25); until then those two
  writes fail closed through the live adapters.
- Faults and seams are deterministic and observable from the system's side (effect log, request log, fault and
  endpoint counters), so Layer-2 tests prove reach and postconditions without trusting the platform's own counters.

## Alternatives considered

- **Idempotency-Key header on POST.** Rejected for the reference contract: an upsert keyed by the request id in the
  path makes the lookup and the completion address the same resource and keeps keys out of headers that proxies log.
- **Absence after deadline plus window plus skew (the round-1 rule).** Rejected (round-2 probe commitlatency): the
  final deadline check runs before COMMIT, and no skew allowance bounds commit latency; only an ordering at the
  system's unique key (the fence) proves absence.
- **A platform-side dispatch journal for the legacy create.** Deferred: it needs a ledger migration and the ledger's
  attempt record (WP-25); the system-side reservation is the dispatch marker for the reference contract.
- **Absence after window since the attempt time, without a deadline at the system.** Rejected (verifier probe L1): a
  request held behind a row lock or in a queue can apply after any client-side bound, so absence proves nothing unless
  the system itself refuses late requests. The deadline is the expiry plus the write timeout because the commit
  attempt time is not part of the provider port and the value must be identical on every replica.
- **Comparing the resource only on reconciliation.** Rejected (probe L3): a request id reused with another payload for
  the same record would be claimed; the request digest binds the whole confirmed body.
- **Vendor-specific adapters per tenant.** Rejected: tenant variation is data (profile + binding + DSL tables), so a new
  tenant needs a review, not code.

## Status of evidence

Software `VERIFIED_LOCAL` for the elements covered by `platform/test/integration/domain` (reads, commits, absence
under a row lock and under commit latency through the fence, redelivery inside the lookup lag, the cancellation write,
authority, redelivery and key reuse, crash after commit per adapter, a fast-check property test
over the production executor on postgres:16, faults, legacy, capability tests) over the composed reference API;
`IMPLEMENTED` where an element is still missing (business-layer acting-party wiring and provider-kind policy in
WP-25, the canonical case model, CRM and notification emulators); environment `NOT_CONFIGURED`; vendor qualification
`NOT_RUN`.
