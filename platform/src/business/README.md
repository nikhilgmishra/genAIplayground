# platform/src/business: resolution contracts, support requests, business services and tools

Status: **IMPLEMENTED_OFFLINE**. Exercised only against PGlite, the LOCAL fixture
adapters (`src/fixtures`), the real OPA WASM policy bundle, the real action ledger,
outbox, consumer dedup, audit writer, workflow engine, transfer coordinator, knowledge
and memory services. Nothing here has run against Aurora, Salesforce, the scheduling or
billing systems, Talkdesk or a real model. Every resolution contract is **DRAFT** with
`approvedBy: null`; every voice template added by this module is **DRAFT**. This module
does not establish HIPAA compliance or production readiness.

Spec: sections 4 (resolution contracts, outcomes), 8 (tool interface, support requests,
prepare/commit), 9 (support memory recap), 10 (handoff and safety route), 16 (journeys).

## Export

`index.ts` exports `buildBusiness: BuildBusiness` (see `contract.ts`). It returns
`{ tools, providers, contracts, handoff, supportRequests, outcomes, consumers }`.
`buildBusinessServices(deps, opts)` returns the same module plus the internal services
(used by the LOCAL harness and by tests).

## What is implemented

| Path | Responsibility |
|---|---|
| `contracts/*.ts` | 19 resolution contracts (DRAFT). `defineContract()` parses with the protocol schema and refuses `APPROVED` or a non-null `approvedBy`. |
| `contracts/render.ts`, `contracts/cli-generate-doc.ts` | Generates `docs/resolution-contracts.md`; `--check` exits 1 on drift (a test also checks it). |
| `../../migrations/0300_support_requests.sql` | `support_interactions`, `support_requests`, `support_request_links`, `interaction_actions`, `interaction_outcomes`; immutability and sync-state triggers; RLS (restricted rows hidden from `app_runtime`; `app_console` reads them only with `app.restricted_reader = 'on'`); security-definer lookups `support_request_by_creation_key`, `business_action_tenant`. |
| `support/support-request-service.ts` | `PgSupportRequestService`: `create()` writes the request, its links and an outbox `support_request.sync` message (opaque payload) in one transaction; `handleSyncMessage()` through `PgConsumerDedup`, idempotent upserts by external id, `RETRY_SCHEDULED` with bounded exponential backoff, `DEAD_LETTER` after `maxAttempts`, stale-claim recovery, operator `repairDeadLetter()` (audited); restricted records sync as a minimal restricted Case; `trace()`, `listUnsynced()`. |
| `support/summaries.ts` | Template-assembled summaries from codes only (no free text, no digit runs). |
| `providers.ts` | `ProviderCommitPort`s for `appointment.reschedule`, `appointment.create`, `billing.review.submit` (lookup by idempotency key; conflict and validation errors mapped to `FAILED` reason codes so the ledger does not record `UNKNOWN`). |
| `commit.ts` | Maps ledger results to `COMMITTED / FAILED / UNKNOWN / STATE_CHANGED / RETRYABLE / REJECTED / DENIED`. |
| `services/*.ts` | Appointments (options, prepare, commit, slot conflicts), billing (invoice facts, review prepare/commit with `onCommitted` follow-up), intake (general, complaint, partner), cases (status view, recap), knowledge (public FAQ search). |
| `handoff.ts` | `BusinessHandoffService`: destination only from trusted configuration, deterministic handoff id per call and priority (a repeat never dials twice), strict `HandoffPackage` with a single-use receiver assertion, safety route that invalidates pending mutations and escalates the session; audit and support-record creation never block the safety transfer. |
| `outcomes.ts` | `decideOutcome()` (pure) and `BusinessOutcomeService` (verifies claimed receipts against this call's `interaction_actions`). |
| `consumers.ts` | Outbox consumers `support_request.sync` and `action.committed` (records the receipt; billing follow-up exactly once on the reconciled path). |
| `../gateway/tools/*.ts` | 18 tool modules (below). |
| `testing/harness.ts` | **LOCAL TEST HARNESS, SYNTHETIC DATA ONLY**. Composes the real modules with LOCAL fixtures and runs a local copy of the gateway order (strict input, resolveResource, relationships, kill switches, policy, execute, strict output, field mask). Not a production composition. |

## Tools

| Tool | Policy action | Class |
|---|---|---|
| `search_approved_runbook` | `public:read` | PUBLIC_READ |
| `get_login_guidance` | `login_help:read` | PUBLIC_READ |
| `begin_verification` | `verification:begin` | INTAKE |
| `get_appointment_options` | `appointment:read` | PROTECTED_READ |
| `prepare_appointment_change` | `appointment:prepare_change` | PREPARE_MUTATION |
| `commit_appointment_change` | `appointment:commit_change` | COMMIT_MUTATION |
| `get_invoice_status` | `invoice:read` | PROTECTED_READ |
| `prepare_billing_review` | `billing:submit_review` (proposal digest) | PREPARE_MUTATION |
| `submit_billing_review` | `billing:submit_review` | COMMIT_MUTATION |
| `get_claim_status` | `claim:read` | PROTECTED_READ |
| `get_provider_onboarding_status` | `onboarding:read` | PROTECTED_READ |
| `get_remittance_status` | `remittance:read` | PROTECTED_READ |
| `submit_partner_intake` | `partner_intake:create` | INTAKE |
| `submit_complaint` | `complaint:create` | INTAKE |
| `create_support_request` | `support_request:create` | INTAKE |
| `get_authorized_case_status` | `case:read` | PROTECTED_READ |
| `request_human_transfer` | `human:request` | SAFETY_AND_HUMAN_ROUTE |
| `request_safety_route` | `safety:route` | SAFETY_AND_HUMAN_ROUTE |

Resources are resolved server-side from authoritative lookups only. An unknown id, another
person's id and a restricted record all resolve to the same denied resource.

## Design decisions

- **Billing review choice.** The policy catalogue has no prepare action for billing reviews.
  `prepare_billing_review` is authorized as `billing:submit_review` with a proposal digest
  (sha256 over kind, target, change, session binding and generation); `submit_billing_review`
  is the commit tool (`{actionId, digest}`) and is re-authorized against the prepared digest
  after the trusted confirmation. The review follow-up (`billing_dispute_review` workflow and
  a support request, `REQUEST_ACCEPTED`) runs in the ledger's `onCommitted` transaction; on the
  reconciled path the `action.committed` consumer does it idempotently.
- **Appointment options carry no slot id** because the `appointment:read` field mask has none;
  `prepare_appointment_change` takes `startsAt` (plus optional modality) and re-resolves the slot.
- **Commit conflicts.** `SLOT_UNAVAILABLE` returns `committed: false` with fresh options;
  `STATE_CHANGED` is a permanent failure (re-prepare); `UNKNOWN` returns `UNKNOWN_OUTCOME` with
  the action id as the reconciliation reference.
- **Outcomes.** `RESOLVED` only with a verified COMMITTED receipt of the contract's action kind
  for this call; acceptance, request or Case creation is `REQUEST_ACCEPTED`; `TRANSFERRED` only
  after caller-confirmed connection; anything without evidence is `OUTCOME_UNKNOWN`.
- **Support references** are spoken as pending synchronization, never as a Case number.
- **Recap** only at A2 for the same subject; risk flags suppress it.
- **Knowledge excerpts** are returned as cited data; templated speech is used only for mapped
  intents (free paraphrase of an excerpt is not spoken).
- **`support_intake@1`** was added because `create_support_request` had no fitting contract.
- **Additive change to `contract.ts`:** optional `HandoffResult.supportReference`.
- Sync policy defaults (`maxAttempts 6`, base 30 s, max 900 s, stale claim 120 s) and the memory
  horizon are engineering defaults, not approved values.

## BLOCKED

Live Salesforce, scheduling, billing, claims, provider and Talkdesk adapters (vendor access
and approvals not available here). Contract and template approval (no approver recorded).

## Interface change requests (not made here)

- policy: add `billing:prepare_review`; add `slotId` to the `appointment:read` field mask.
- adapters / ProviderSystem: return the practice of a provider for onboarding (practice staff are denied meanwhile).
- talkdesk: list `prepare_billing_review` and `get_login_guidance`.
- outbox: carry `tenantId` on `action.committed` (a definer lookup is used meanwhile).
- voice: a match-code slot type (the match code is not spoken meanwhile).
- retention: register the `support_requests` dataset.
- console-api: set `app.restricted_reader` for authorized staff.
- workflows: a durable action grant for `grantRef` (currently null).

## Tests

```bash
cd platform
npx vitest run src/business src/gateway/tools src/voice
npx tsx src/business/contracts/cli-generate-doc.ts --check
npx tsc -p tsconfig.json --noEmit
npx eslint src/business src/gateway/tools
```
