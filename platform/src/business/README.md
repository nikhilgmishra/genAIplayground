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
| `support/support-request-service.ts` | `PgSupportRequestService`: `create()` writes the request, its links and an outbox `support_request.sync` message (opaque payload) in one transaction; `handleSyncMessage()` through `PgConsumerDedup`, idempotent upserts by external id, `RETRY_SCHEDULED` with bounded exponential backoff, `DEAD_LETTER` after `maxAttempts`, stale-claim recovery, operator `repairDeadLetter()` (audited); restricted records sync as a minimal restricted Case; `trace()` (worker view by default; console view as `app_console` under RLS, with `app.restricted_reader` set only when the caller passes `restrictedReader: true`; carries `lastReasonCode`, `syncedAt` and the request's `support_request.sync` outbox message ids), `listForCall()` (requests created for or linked to one call, worker view), `listUnsynced()`. |
| `support/summaries.ts` | Template-assembled summaries from codes only (no free text, no digit runs). |
| `providers.ts` | `ProviderCommitPort`s for `appointment.reschedule`, `appointment.create`, `billing.review.submit` (lookup by idempotency key; conflict and validation errors mapped to `FAILED` reason codes so the ledger does not record `UNKNOWN`). |
| `commit.ts` | Maps ledger results to `COMMITTED / FAILED / UNKNOWN / STATE_CHANGED / RETRYABLE / REJECTED / DENIED`. |
| `services/*.ts` | Appointments (options with opaque slot ids, prepare with optional slot id, commit, slot conflicts), billing (invoice facts, review prepare/commit with `onCommitted` follow-up), intake (general incl. representative-linked requests, complaint with policy-authorized subject link, partner), cases (status view, recap), knowledge (public FAQ search). |
| `handoff.ts` | `BusinessHandoffService`: destination only from trusted configuration (a console-initiated `requestHuman` may name a staff-selected `destinationId`, which must be an allowlisted entry, and `initiatedBy {staffId}`, audited as the actor with sourceComponent `console`), deterministic handoff id per call and priority (a repeat never dials twice), strict `HandoffPackage` with a single-use receiver assertion, safety route that invalidates pending mutations and escalates the session; audit and support-record creation never block the safety transfer. |
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
| `get_appointment_options` | `appointment:list_options` | PROTECTED_READ |
| `prepare_appointment_change` | `appointment:prepare_change` | PREPARE_MUTATION |
| `commit_appointment_change` | `appointment:commit_change` | COMMIT_MUTATION |
| `get_invoice_status` | `invoice:read` | PROTECTED_READ |
| `prepare_billing_review` | `billing:prepare_review` | PREPARE_MUTATION |
| `submit_billing_review` | `billing:submit_review` | COMMIT_MUTATION |
| `get_claim_status` | `claim:read` | PROTECTED_READ |
| `get_provider_onboarding_status` | `onboarding:read` | PROTECTED_READ |
| `get_remittance_status` | `remittance:read` | PROTECTED_READ |
| `submit_partner_intake` | `partner_intake:create` | INTAKE |
| `submit_complaint` | `complaint:create` | INTAKE |
| `create_support_request` | `support_request:create` | INTAKE |
| `get_authorized_case_status` | `case:read` | PROTECTED_READ |
| `request_human_transfer` | `human:request` | SAFETY_AND_HUMAN_ROUTE (also session-less, SAFE-02) |
| `request_safety_route` | `safety:route` | SAFETY_AND_HUMAN_ROUTE (also session-less, SAFE-02) |

Resources are resolved server-side from authoritative lookups only. An unknown id, another
person's id and a restricted record all resolve to the same denied resource.

## Design decisions

- **Billing review choice.** `prepare_billing_review` is authorized by the dedicated
  `billing:prepare_review` action (PREPARE_MUTATION: A2 client self, writes switch, no digest,
  `REQUIRE_CONFIRMATION`); `submit_billing_review` is the commit tool (`{actionId, digest}`,
  `billing:submit_review`) and is re-authorized against the prepared digest after the trusted
  confirmation. The review follow-up (`billing_dispute_review` workflow and
  a support request, `REQUEST_ACCEPTED`) runs in the ledger's `onCommitted` transaction; on the
  reconciled path the `action.committed` consumer does it idempotently.
- **Appointment options carry the opaque slot id** (`appointment:list_options` field mask;
  existing appointments carry `slotId: null`). `prepare_appointment_change` takes `startsAt`
  plus the optional `modality` and `slotId` and re-resolves the slot from authoritative
  availability: a slot id that is not the open slot at that time selects nothing
  (`SLOT_UNAVAILABLE`). `appointment:read` is unchanged.
- **Session-less safety and human routes (SAFE-02).** With no, an expired or a revoked
  session the gateway calls the routing tools' `executeWithoutSession`; the HandoffService
  runs with `ctx: null` and the call id from the trusted transport binding
  (`X-VSP-Interaction-Id`). Without a trusted call id there is nothing to transfer:
  `PERMANENT_FAILURE CALL_UNIDENTIFIED_USE_STUDIO_ROUTE` (Studio's independent route remains).
- **Complaint linking.** A verified (A2, own subject) caller's complaint is linked to that
  subject only when `support_request:create` (self path, subject-linked record) allows it at
  creation time (`decideNow`); otherwise, and for every unverified caller, it stays unlinked
  and is still accepted. The tool output says `linkedToAccount`.
- **Representative support requests.** `create_support_request` with `linkToAccount` by a
  `personal_representative` at A2 targets the single represented subject the legal-authority
  registry names with scope `support_request:create` (purpose `representative_access`);
  missing or ambiguous authority resolves to a denied resource, expired authority is denied
  with the human route.
- **Practice onboarding.** `get_provider_onboarding_status` resolves the provider record's
  practice (`OnboardingStatus.organizationId` from the provider network) as the resource
  organization, so delegated practice staff read their practice's providers only.
- **Match code.** `begin_verification` (secure link) speaks the two-word match code only
  through the DRAFT template `verification.secure_link_match_code` (voice slot type
  `match_code`); it is never a data field. It is generated for every request, so it reveals
  nothing about account existence, and is not a secret.
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
- **Additive changes to `contract.ts`:** optional `HandoffResult.supportReference`;
  `HandoffService.requestHuman` optional `destinationId` and `initiatedBy`;
  `SupportRequestTrace.salesforce.lastReasonCode` / `syncedAt` and `outboxMessageIds`;
  `SupportRequestTraceOptions` (console view); `SupportRequestService.listForCall()`.
- Sync policy defaults (`maxAttempts 6`, base 30 s, max 900 s, stale claim 120 s) and the memory
  horizon are engineering defaults, not approved values.

## BLOCKED

Live Salesforce, scheduling, billing, claims, provider and Talkdesk adapters (vendor access
and approvals not available here). Contract and template approval (no approver recorded).

## Interface change requests (not made here)

Resolved after wave 2: `billing:prepare_review` and `appointment:list_options` policy actions,
ProviderSystem practice mapping, Talkdesk tool assignment, voice `match_code` slot type,
console restricted-reader flag. Still open (owned by other modules):

- outbox: carry `tenantId` on `action.committed` (a definer lookup is used meanwhile).
- retention: register the `support_requests` dataset.
- ~~workflows: a durable action grant for `grantRef`~~ — done in wave 4 (below).

## Tests

```bash
cd platform
npx vitest run src/business src/gateway/tools src/voice src/main/sessionless-routing.test.ts
npx tsx src/business/contracts/cli-generate-doc.ts --check
npx tsc -p tsconfig.json --noEmit
npx eslint src/business src/gateway/tools
```

## Wave 4 wiring

* **Durable grants** (`grants.ts`): `issueWorkflowGrant` issues, inside the accepting transaction,
  a grant whose actions are exactly the workflow definition's declared `grantActions` and whose
  expiry is the sum of its nonterminal deadlines (ENGINEERING DEFAULT, bounded 1 h..30 d). Subject:
  the linked account subject; for partner work the partner organization; for an unlinked complaint
  the support request itself. Used by the billing review follow-up (both the commit hook and the
  reconciled `action.committed` consumer), partner onboarding and complaint review. Without
  `ToolDeps.grants` the grantRef stays null and guarded transitions fail closed.
* **Confirmation slots** (`confirmation.ts`, `BusinessModule.confirmationSlots`): typed values for
  the TC-07 confirmation template from the prepared action (appointment from/to) or the system of
  record (invoice issue date); anything missing => null => human route.
* **Outcomes**: with `contractId: null` (TC-11) the contract is inferred from the call's verified
  committed actions (a resolving contract first); the evidence row records `contractInferred`.
* **Handoff observer**: `BusinessHandoffService` reports every returned handoff to
  `ToolDeps.handoffObserver` (never affects the route).
* **Port additions** (additive, optional): `SupportRequestService.retryDue` and
  `repairDeadLetter` (the worker owner can now run the retry sweep; see the journeys README for the
  missing loop), `ToolDeps.grants`, `ToolDeps.handoffObserver`, `BusinessModule.confirmationSlots`.
