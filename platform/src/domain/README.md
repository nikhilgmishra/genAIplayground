# platform/src/domain — canonical domain contracts and live domain adapters (WP-23)

Module `domain` in `platform/architecture/modules.yaml` (kind `domain`, a write-port module: imported only by the
action executor, the composition root and the worker). It may import the connector runtime, DSL, HTTP transport,
profile and secrets modules, config, observability, protocol, resilience and shared code; never actions, business,
adapters or main.

## What is here

| File | Purpose |
|---|---|
| `contracts.ts` | Canonical records per capability (appointment, slot option, invoice, payment, claim status, onboarding, remittance, referral, authorization, eligibility) with a connector-only `source`; `DomainRead` (AVAILABLE / NOT_FOUND / UNAVAILABLE with a next step); action kinds and their authority families; the fields that must never be ingested |
| `binding.ts` | Domain bindings: canonical operation -> reviewed profile operation, reconciliation lookup, documented visibility window, skew allowance, incomplete-write handling, dispatch deadline (`REQUEST_NOT_AFTER` / `NONE`) and request-digest scheme; `admitBinding` refuses writes without the contract's lookup and, with a deadline, a write without the deadline field |
| `runner.ts` | `DomainConnector`: a binding plus the runtime of its profile; provenance; fail-closed record accessors; honest read classification (`readSafely`) |
| `authority.ts` | Acting party from the session; client vs provider authority; record scope |
| `changes.ts` | Keyed change requests (`requestIdFor`), lookup, completion, receipts; the request digest (`requestDigestOf`, `REFBIZ_REQUEST_V1`) and payload match; the reconciliation decision and the absence rule |
| `scheduling.ts`, `billing.ts`, `network.ts` | `HttpScheduling`, `HttpBilling`, `HttpClaims`, `HttpProviderNetwork`, `HttpReferralStatus`: party-scoped canonical reads, and the existing `SchedulingSystem` / `BillingSystem` / `ClaimsSystem` / `ProviderSystem` ports (structurally) |
| `commit.ts` | `DomainCommitPort`: prepare (authoritative read-back, digest-bound preparation), commit (deadline, lookup first for business-layer preparations, payload-checked settle), currentVersion, lookup / reconcileDecision, verifyEffect (EffectVerification, cross-checks the system's receipt), commitCommand (provider availability block; preparation digest and kind authority checked) |
| `legacy.ts` | `HttpLegacyScheduling`: a NON-idempotent create (with a dispatch deadline) sent only under the delivery's own reservation of its reference; reconciled by reference and, past the deadline, the reference fence; a found appointment must match the action |
| `profiles.ts` | Reviewed ConnectorProfiles and bindings of the reference business API (tenant values are inputs) |
| `capability.ts` | `runDomainCapabilityTest`: WP-06 probes plus the visibility-window, dispatch-deadline, request-digest, fence and dispatch-reservation checks, an optional authorized fence probe, and the canonical-record check; evidence records |
| `factory.ts` | `createDomainAdapters`: admits profiles and bindings, refuses credential reuse, builds runtimes and adapters |
| `unit-fake.fixture.ts` | UNIT FAKE runner for Docker-free unit tests only |

## Rules this module keeps

- **No vendor shape escapes.** Records are mapped by the bounded DSL of the reviewed profile and validated against the
  canonical contract; drift refuses the whole response.
- **Exactly once.** One request id per ledger key; only REJECTED is FAILED; every other answer that is not COMPLETED
  with a receipt (INCOMPLETE, a receipt-less COMPLETED, a 422 for a reused request id, anything after send) is UNKNOWN
  and is reconciled by lookup before any retry. A business-layer preparation looks its request id up before deriving
  a body from current state. A non-idempotent API is reconciled only through its declared lookup.
- **A found change is this action's only when its request digest and resource match** the confirmed action
  (`PAYLOAD_MISMATCH` is UNKNOWN otherwise).
- **Absence is proved only by the system's fence, never by a clock.** A lookup 404 is never NOT_FOUND by itself (a
  write's COMMIT can land after its deadline). Once the request's dispatch deadline `notAfter` (preparation expiry plus
  write timeout) plus the skew allowance has passed, the binding's fence (`fenceOperationId`) asks the system: it
  answers the change it holds (waiting for a delivery still in its transaction) or records the id FENCED so nothing
  can ever apply under it. Only FENCED (or a REJECTED request) is NOT_FOUND; without a fence, before the deadline, or
  when the fence cannot answer, the decision stays UNKNOWN.
- **A non-idempotent create runs only under its own dispatch reservation** (`dispatchReservation`): each delivery
  reserves the reference with a fresh dispatch id and creates only when the reservation is its own, so a redelivery
  inside the lookup's lag never sends a second create (UNKNOWN until the earlier appointment is visible).
- **The domain command path** (`commitCommand`) commits only kinds the ledger does not know
  (`DOMAIN_KIND_REQUIRES_LEDGER` otherwise), with the preparation's own digest-bound expiry (never a caller's).
- **Authority.** A provider's approval is never a client's consent; the acting party comes from the session or the
  confirmed action, never from the record (the business-layer `reschedule` and `markInReview` refuse
  `ACTING_PARTY_REQUIRED` without it); another party's record reads as not available.
- **Honest reads.** Every failure is UNAVAILABLE with a reason code, the outcome class and the next step
  (`OFFER_HUMAN_OR_CALLBACK`); nothing is retried here (the runtime owns the one retry policy).

## Composition (WP-07) and actions (WP-25)

`createDomainAdapters` is the factory the composition root calls with the tenant's profiles and bindings and the WP-06
runtime dependencies. The wiring proposal (a diff of `platform/src/main/live-container.ts`) is described in the WP-23
report's docNotes. `DomainCommitPort` is the recommended `ProviderCommitPort` for scheduling and billing actions; the
business layer's `SchedulingCommitPort` also runs over `HttpScheduling` for creates, but its key lookup cannot prove an
absence (it answers UNKNOWN), and its reschedule and billing review need the acting party passed (a WP-25 change:
`actingPartyId: action.subjectId`). Provider-approved kinds need ledger ActionKinds and policy (WP-25).

## Tests

Unit (Docker-free): `*.test.ts` here. Layer 2: `platform/test/integration/domain` against the reference business API
(`make up PROFILE=core,domain && make test-integration SUITE=domain`).
