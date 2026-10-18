# platform/src/adapters — business-system and vendor adapters

Status: **IMPLEMENTED_OFFLINE** only. Nothing in this module has been run against a
vendor sandbox, a real business system, a real telephone path or production. No
claim of HIPAA compliance or production readiness is made here.

The module implements the ports in [`ports.ts`](ports.ts) three ways:

| Kind | What it is | Where |
|---|---|---|
| `local_fixture` | SYNTHETIC in-memory systems with deterministic fault injection. Labelled `LOCAL FIXTURE — SYNTHETIC DATA ONLY`; rejected by the production configuration guard (OPS-04). | `local/` |
| `live` (documented) | Salesforce REST adapter written against the documented REST API (source register S23). Exercised only by **emulated** contract tests on 127.0.0.1. Schema **BLOCKED**. | `live/salesforce-rest-support-records.ts` |
| `live` (BLOCKED) | Stubs for capabilities with no documented API or tenant evidence. Every method throws `BLOCKED_CAPABILITY_UNVERIFIED`; nothing is simulated as success (spec section 16, OPS-03). | `live/talkdesk-blocked.ts`, `live/business-systems-blocked.ts` |

Ownership: `local/identity-directory.ts`, `local/oidc-fixture.ts`,
`local/notification-fixture.ts` and `live/oidc-verifier.ts` belong to the identity
module; everything else here belongs to this module. `index.ts` re-exports both.

## What is implemented

### Shared infrastructure
* **`local/synthetic-store.ts` — `SyntheticStore`**: a mutable deep copy of
  `platform/src/fixtures/synthetic-world.ts`. `reset()` restores the canonical world per
  test. Version counters: appointments/invoices carry `vN` versions bumped on every
  update; `revision` and `collectionRevision(c)` count mutations; the version before a
  record's latest change is kept for the `STALE_READ` fault. Accessors return copies.
* **`local/faults.ts` — `FaultInjector` / `FaultPlan`**: per `integrationId` + operation
  (or `*`) faults, `once` / `{ times: n }` / `persistent`, optional `skip`, fully
  deterministic (no randomness, injectable `sleep`). Fixtures declare which kinds each
  operation supports; injecting an unsupported kind is rejected and `unconsumed()` lists
  faults that never fired (a fault test that did nothing must not pass — OPS-03).

  | Fault | Error (reason code / outcome) | Effect applied? |
  |---|---|---|
  | `OUTAGE` | `CONNECTION_REFUSED` / NOT_STARTED (retryable); `health()` unhealthy | no |
  | `TIMEOUT_BEFORE_SEND` | `TIMEOUT_BEFORE_SEND` / NOT_STARTED (retryable) | no |
  | `QUOTA_EXHAUSTED` | `HTTP_429` / NOT_STARTED (retryable), `httpStatus` 429, `retryAfterMs` | no |
  | `REJECTED` (added) | `DEPENDENCY_REJECTED` / FAILED (not retryable), `httpStatus` 400 | no |
  | `TIMEOUT_AFTER_COMMIT` | `TIMEOUT_AFTER_SEND` / UNKNOWN (never retried) | **yes**, then the error |
  | `PARTIAL_WRITE` | `PARTIAL_WRITE` / UNKNOWN | first step only |
  | `SLOW(ms)` | none — delays the call | — |
  | `STALE_READ` | none — reads return the previous version | — |
  | `DUPLICATE_DELIVERY` | none — the request/event is processed twice | once (idempotent) |
  | `OUT_OF_ORDER` | none — events delivered permuted (telephony) | — |

  Reason codes align with `RetryPolicy.retryOn` in `protocol/tools.ts`, so
  `resilience/classify.isSafeToRetry` retries only NOT_STARTED codes. Errors are
  `AdapterDependencyError` (a `DependencyError` with `integrationId`, `operation`,
  `httpStatus`, `retryAfterMs`, `injected`). Messages are reason codes only.
* **`local/idempotency.ts`**: idempotency ledger (same key + same request → original
  result; same key + different request → `IDEMPOTENCY_KEY_REUSED`; lookup by key).

### LOCAL fixtures (all `kind: "local_fixture"`, SYNTHETIC)
| Fixture | Port | Integration id | Behaviour worth knowing |
|---|---|---|---|
| `SchedulingFixture` | `SchedulingSystem` | `scheduling` | Administrative availability only (no clinical matching). `beforeVersion` check → `ConflictError STATE_CHANGED`; slot taken by a concurrent booking → `ConflictError SLOT_UNAVAILABLE`; idempotent `reschedule`/`create`; `findByIdempotencyKey` for reconciliation; reschedule releases the previously held slot; PARTIAL_WRITE applies the booking step (effect logged and recorded under the provider idempotency key, so reconciliation finds it) and then fails the confirmation step with PARTIAL_WRITE (UNKNOWN); a same-key retry replays it without a second effect; effect and delivery logs; `simulateConcurrentBooking` / `simulateConcurrentChange`. `listSlots` with a provider's own subject (no appointment id) lists that provider's own open slots only (provider own schedule). |
| `BillingFixture` | `BillingSystem` | `billing` | Authoritative line codes and minor units; `markInReview` changes status only (no refund, waiver or balance change), idempotent, `findReviewByIdempotencyKey`; `hostedPaymentPath` returns a configured identifier-free portal path (LOCAL FIXTURE placeholder `/billing/pay` pending PRQ-050); non-OPEN invoices are not payable. |
| `ClaimsFixture` | `ClaimsSystem` | `claims` | Exactly the `ClaimStatus` fields: insurer-reported status + as-of time; no eligibility/payment guarantee. |
| `ProviderFixture` | `ProviderSystem` | `provider-system` | Onboarding stage + missing document types + the provider's practice organization (`OnboardingStatus.organizationId`, additive optional port field; fixture value from the SYNTHETIC provider record's enrolled practice, `null` when none); remittances by practice and period overlap with a bounded range. |
| `RelationshipDirectoryFixture` | `RelationshipDirectory` | `relationship-directory` | Builds `RelationshipFact[]` from DELEGATIONS, TREATING_RELATIONSHIPS and self records, strictly validated against the protocol schema; facts only for the selected role; expired grants returned with `validUntil` + `AUTHORIZATION_EXPIRED`; future grants omitted; unknown registry constraints drop the whole fact (fail closed); representative facts over a minor always carry `MINOR_CONFIDENTIALITY_REVIEW` (conservative fixture rule pending PRQ-027). Self/treating scope sets are fixture values, not an approved permission matrix (a treating relationship contributes `appointment:read` and `appointment:list_options`; a provider's self fact carries `appointment:list_options` for the provider's own schedule). |
| `SupportRecordsFixture` | `SupportRecordSystem` | `salesforce` | Salesforce-like: upsert by external id never duplicates; interaction and Case are separate objects with many-to-many links (one call → several Cases; repeat call → existing Case); restricted records stay restricted; Case status is never reset by an upsert (a created Case is not a resolution, ACT-04); outage / timeout-after-write / partial write / duplicate delivery; `records()` for assertions; API call counts. |
| `TelephonyFixture` | `TelephonyControl` | `talkdesk-telephony` | `requestTransfer` accepts only destination ids in the trusted allowlist passed at construction (validated: no dial targets in ids or vendor refs); everything else → `AccessDeniedError DESTINATION_NOT_ALLOWLISTED`, nothing dialled, rejected value never stored. Lifecycle events REQUESTED → QUEUED → RECEIVER_ACCEPTED → BRIDGED → CALLER_CONFIRMED_CONNECTED (optionally COMPLETED) via `subscribe()`, with scripted RECEIVER_UNAVAILABLE / TIMED_OUT / BRIDGE_DROPPED / CALLER_DISCONNECTED / STALLED, duplicate and out-of-order delivery, at-least-once redelivery when a subscriber fails, `simulateCallerDisconnect`. Delivery is explicit (`deliverNext` / `deliverAll`). `playApprovedUpdate` records template ids only. No hang-up operation. `TRANSFER_EVENT_FOR_STATE` maps states to the workflow coordinator's event names. |

`local/fixture-set.ts` wires all of the above to one store and one injector and
registers them under the config adapter keys (`createLocalFixtureSet`).

### Live adapters
* **`SalesforceRestSupportRecords`** (`kind: "live"`): OAuth 2.0 client credentials
  (`POST {My Domain}/services/oauth2/token`, form-encoded) with in-memory token caching
  (client-side bound `tokenMaxAgeSeconds`, shorter `expires_in` honoured, one in-flight
  request); upsert via `PATCH /services/data/{apiVersion}/sobjects/{SObject}/{ExternalIdField}/{externalId}`
  (body never repeats the external id field); 201 created, 200/204 updated (204 → minimal
  `GET ?fields=Id` read-back), 300 → `ConflictError SALESFORCE_EXTERNAL_ID_MULTIPLE_MATCHES`,
  400/404 → FAILED permanent, 401 → exactly one token refresh then `SALESFORCE_AUTH_FAILED`,
  403 `REQUEST_LIMIT_EXCEEDED` → NOT_STARTED non-retryable, 429/503 → NOT_STARTED retryable
  with Retry-After, timeout or dropped connection after sending a write → UNKNOWN,
  connection refused → NOT_STARTED. Interaction↔Case links are upserted into a
  (proposed, placeholder) junction object; a link failure after the Case write is
  `PARTIAL_WRITE` (UNKNOWN). No redirects, bounded response bodies, `instance_url` must
  equal the configured origin, `Sforce-Limit-Info` usage recorded, errors/logs carry
  reason codes only. `apiVersion` is configuration — no tenant version is claimed.
* **`CachingSupportRecords`** (`support-record-cache.ts`): bounded TTL (≤ 60 s) + LRU cache of
  `getCaseByExternalId` with source timestamps; `getCaseFresh` for real-time commit checks;
  writes invalidate before and after (also on UNKNOWN); null/failures never cached (spec section 12).
* **BLOCKED stubs**: `TalkdeskTelephonyLive`, `TalkdeskExploreClient` (`HistoricalReportSource`
  port), `SchedulingLiveBlocked`, `BillingLiveBlocked`, `ClaimsLiveBlocked`,
  `ProviderSystemLiveBlocked`, `RelationshipDirectoryLiveBlocked`. Each lists
  `prerequisites` (PRQ ids) and `requiredEvidence` (exact evidence, vendor question ids,
  trust-boundary flags). They contain no endpoint, path, scope or event name.
  `live/blocked-set.ts` (`createBlockedLiveRegistry`) wires them plus the Salesforce adapter
  in BLOCKED schema state — what a deployed process would hold today.

### Registry and inventory
* **`registry.ts` — `AdapterRegistry`**: records `kind`, `integrationId`, capability status
  (BLOCKED detected via the `BlockedCapability` marker), prerequisites and fixture label.
  `kinds()` is exactly `GuardContext.adapterKinds` for `config/guard.ts` (which rejects
  fixtures in staging/production — the registry only reports); `summary().badge` is the
  SYNTHETIC badge whenever any fixture is registered (console LOCAL FIXTURE badge);
  `healthReport()` fails closed on throwing/slow/malformed health checks; `freeze()`
  prevents late registration. Registration rejects invalid kinds, ids and duplicates.
* **`integration-inventory.ts`**: machine-readable inventory (method, endpoint, version, auth
  mechanism, schema ref, rate limit, retention, data class, classification, source doc,
  status, implementation files, PRQ ids, vendor question ids, trust boundaries) for
  Salesforce, Talkdesk (MCP inbound, Studio HTTP steps, telephony transfer, approved
  update, lifecycle events, Explore), every business system, IdPs, workforce SSO, identity
  directory, notifications and AWS services. Unverified values are `UNKNOWN`; endpoints
  appear only where a source-register document or named standard documents them; no
  retention duration is invented. Statuses: `IMPLEMENTED_OFFLINE` (Salesforce only),
  `BLOCKED`, `UNKNOWN`.

## What is BLOCKED and why

| Capability | Status | Prerequisite (owner) | Smallest next action |
|---|---|---|---|
| Salesforce Case / interaction schema, external id fields, junction object, sharing model, encrypted fields, automation inventory | BLOCKED (adapter refuses PLACEHOLDER names with `PROVIDED` status; BLOCKED status throws `BLOCKED_CAPABILITY_UNVERIFIED` with no network) | PRQ-006, PRQ-035 (**Salesforce administrator**); AR-03 approval (PRQ-024) | Administrator answers VQ-SF-03..VQ-SF-08 and supplies the field API names; then configure `schema: { status: "PROVIDED", evidenceRef, approvalId }` and the mapping |
| Salesforce API version, API allocation, OAuth connected app for the integration identity | UNKNOWN | PRQ-006 (Salesforce administrator), VQ-SF-03, VQ-SF-07 | Record the org's API version and allocation |
| Talkdesk transfer control, approved-update playback | BLOCKED | PRQ-004, PRQ-034, PRQ-014, PRQ-022 (Talkdesk administrator / vendor) | Written answers to VQ-TD-22, -27, -28, -39 |
| Talkdesk transfer lifecycle events and their authentication | BLOCKED (TB-07, TB-09) | PRQ-019, PRQ-021 | VQ-TD-33, VQ-TD-34; until then live transfers end OUTCOME_UNKNOWN |
| Talkdesk Explore historical reports | BLOCKED | PRQ-046, PRQ-004, PRQ-034, PRQ-002 | VQ-TD-36 per-report facts; privacy approval of a de-identified export |
| Scheduling, billing, claims, provider-network APIs | BLOCKED | PRQ-007 (**business-system owners**), PRQ-033 | Each owner confirms idempotency keys + lookup by key (without them ACT-03 cannot be proven) |
| Hosted payment page path | BLOCKED | PRQ-050 (billing owner) | Confirm the hosted page; until then payment requests go to a human |
| Relationship registries (delegation, partner contract, legal authority) | BLOCKED | PRQ-005 (identity owner), PRQ-007, PRQ-027 (privacy counsel) | Name the systems of record and minor/representative rules |

## How to test

```sh
cd platform
npx vitest run src/adapters                      # all adapter tests (includes identity-owned files)
npx tsc -p tsconfig.json --noEmit 2>&1 | grep src/adapters/
npx eslint src/adapters
```

The Salesforce contract tests (`live/salesforce-rest.contract.test.ts`) start a node:http
emulator on 127.0.0.1 (`live/salesforce-emulator.fixture.ts`). They are labelled
**EMULATED CONTRACT TESTS — not sandbox evidence**. All tests are offline and use
`FakeClock`; the only real-time waits are two short (≤ 300 ms) client timeouts against the
local emulator.

## Requirement IDs enforced or evidenced here

* **ACT-02** — idempotency ledgers, upsert by external id, duplicate-delivery faults, property tests
  (`scheduling-fixture.property.test.ts`, `faults.property.test.ts`).
* **ACT-03** — TIMEOUT_AFTER_COMMIT / PARTIAL_WRITE produce UNKNOWN; lookup by key / external id
  reconciles; Salesforce timeout-after-send is UNKNOWN; no adapter-level retries except one 401 refresh.
* **ACT-04** — a created Case keeps its Salesforce-managed status; billing review is not a refund.
* **AUTH-02 / AUTH-04** — Salesforce token handling (single refresh, client-side expiry bound).
* **AUTH-05** — relationship facts only from authoritative records, per selected role; remittances
  scoped by practice; other subjects' appointments indistinguishable from missing ones.
* **SAFE-04** — transfer events model receiver acceptance and bridge before connection; contract test
  against the workflow state machine under arbitrary duplication/reordering.
* **SAFE-05** — telephony fixture allowlist; strict input schema; allowlist validation.
* **DATA-01** — reason-code-only errors and content-free logs (tested with SYNTHETIC names/DOBs).
* **DATA-03** — inventory never invents retention durations.
* **OPS-03** — BLOCKED stubs, unconsumed-fault detection, inventory statuses never claim verification.
* **OPS-04** — every fixture declares `kind: "local_fixture"`; the registry feeds the guard, which
  rejects fixtures in production (tested with the real `config/guard.ts`).
* **SPEC-4.\*, SPEC-8.4, SPEC-10.transfer, SPEC-12.\*, SPEC-14.faults, SPEC-16.\*** — see test titles.
