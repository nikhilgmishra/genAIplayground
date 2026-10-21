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
| `../../migrations/0301_interaction_outcome_subject.sql` | `interaction_outcomes.subject_ref` (opaque id of the call's authorized subject, null when none or ambiguous) and a partial index for repeat-contact lookups. 0300's tenant RLS and append-only trigger cover the column; 0301 replaces `app_console`'s table-wide SELECT with a column grant that leaves out `subject_ref` (only `app_runtime` and `app_worker` read it). |
| `../../migrations/0302_support_case_observations.sql` | `support_case_observations`: append-only, `app_worker`-only (RLS) record of mapped Case states (`OPEN` / `CLOSED`, recorded on change only; a `CLOSED` -> `OPEN` row is a reopening). Vendor status text is never stored. |
| `support/support-request-service.ts` | `PgSupportRequestService`: `create()` writes the request, its links and an outbox `support_request.sync` message (opaque payload) in one transaction; `handleSyncMessage()` through `PgConsumerDedup`, idempotent upserts by external id, `RETRY_SCHEDULED` with bounded exponential backoff, `DEAD_LETTER` after `maxAttempts`, stale-claim recovery, operator `repairDeadLetter()` (audited); restricted records sync as a minimal restricted Case; `trace()` (worker view by default; console view as `app_console` under RLS, with `app.restricted_reader` set only when the caller passes `restrictedReader: true`; carries `lastReasonCode`, `syncedAt` and the request's `support_request.sync` outbox message ids), `listForCall()` (requests created for or linked to one call, worker view), `listUnsynced()`; `observeCaseStatus()` (reopened cases, below). |
| `support/summaries.ts` | Template-assembled summaries from codes only (no free text, no digit runs). |
| `providers.ts` | `ProviderCommitPort`s for `appointment.reschedule`, `appointment.create`, `billing.review.submit` (lookup by idempotency key; conflict and validation errors mapped to `FAILED` reason codes so the ledger does not record `UNKNOWN`). |
| `commit.ts` | Maps ledger results to `COMMITTED / FAILED / UNKNOWN / STATE_CHANGED / RETRYABLE / REJECTED / DENIED`. |
| `services/*.ts` | Appointments (options with opaque slot ids, prepare with optional slot id, commit, slot conflicts), billing (invoice facts, review prepare/commit with `onCommitted` follow-up), intake (general incl. representative-linked requests, complaint with policy-authorized subject link, partner), cases (status view, recap), knowledge (public FAQ search). |
| `handoff.ts` | `BusinessHandoffService`: destination only from trusted configuration (a console-initiated `requestHuman` may name a staff-selected `destinationId`, which must be an allowlisted entry, and `initiatedBy {staffId}`, audited as the actor with sourceComponent `console`), deterministic handoff id per call and priority (a repeat never dials twice), strict `HandoffPackage` with a single-use receiver assertion, safety route that invalidates pending mutations and escalates the session (resolving the call's live session server-side when no context came with the request); a human request in safety mode takes the safety route; every safety route records content-free safety evidence; clinical / privacy / safety handoff records are restricted (`handoffRecordPlacement`); audit and support-record creation never block the safety transfer. |
| `outcomes.ts` | `decideOutcome()` (pure) and `BusinessOutcomeService` (verifies claimed receipts against this call's `interaction_actions`; a call action still unsettled in the ledger => `OUTCOME_UNKNOWN` / `COMMIT_OUTCOME_UNKNOWN`; `reviseAfterCommit()` appends a revision when the reconciler commits it). Records the call's authorized subject (`subject_ref`) and emits the resolution measures: verified resolution, containment and repeat contact (below). |
| `recheck.ts` | `BusinessPreDisclosureRecheck` (the `PreDisclosureRecheck` wired into the container's `PgWorkflowEngine`): current consent, representation, account state, kill switches and the OPA decision for purpose `durable_follow_up` with the durable grant's actor/subject, per grant-action rule (`RECHECK_RULES`). Ports `AccountStateLookup`, `ConsentRegistry`. |
| `fixtures/recheck.fixture.ts` | **LOCAL FIXTURE**: `LocalAccountStateFixture` (actor/subject -> account over the SYNTHETIC directory, current state from `LocalIdentityDirectoryFixture`), `LocalConsentRegistryFixture` (in-memory consent changes after acceptance; `revoke`, `record`). Live versions BLOCKED. |
| `consumers.ts` | Outbox consumers `support_request.sync` and `action.committed` (records the receipt; billing follow-up exactly once on the reconciled path; append-only outcome revision for a call that ended with the commit unsettled). |
| `../gateway/tools/*.ts` | 18 tool modules (below). |
| `testing/harness.ts` | **LOCAL TEST HARNESS, SYNTHETIC DATA ONLY**. Composes the real modules with LOCAL fixtures and runs a local copy of the gateway order (strict input, resolveResource, relationships, kill switches, policy, execute, strict output, field mask). Not a production composition. |

## Resolution measures (spec section 13; SPEC-13.resolution-metrics)

Metrics are in the content-free catalogue (`../observability/metrics.ts`, dashboard `resolution`);
labels are code constants only. No subject, actor, account, call, session, request or Case id is
ever a label, log field or alert text (DATA-01).

| Measure | Where | Definition |
|---|---|---|
| Interaction outcomes | `outcomes.ts` `record()` | `vsp_interaction_outcomes_total{outcome, intent}`; `intent` is the contract intent (closed list `CONTRACT_INTENTS`, a test keeps it equal to the contracts), `unknown` without a contract. |
| Verified resolution | `outcomes.ts` `record()`, `reviseAfterCommit()` | `vsp_verified_resolutions_total{intent, source}`: `RESOLVED` only, which `decideOutcome()` reaches only with the contract's committed receipt verified for the call. `REQUEST_ACCEPTED` (accepted workflow, created Case or support request) is never a resolution (ACT-04). A call counts once, at its first `RESOLVED` row: a call-end `record()` (`source="call_end"`, including a repeated `record()` that resolves a call first recorded unresolved) or a reconciliation revision (`"reconciliation"`). A later `RESOLVED` row of a call that already had one is not counted again (for example a call resolved at call end, recorded again without its receipt, then restored by a revision). |
| Containment | `outcomes.ts` `record()` | `vsp_contained_interactions_total{outcome, intent}`, once per call at its first recorded outcome: no human or safety transfer was attempted for the call. `record()` reads that server-side from the call's own transfer journeys (`deps.transfers.journeysForCall`, the same `TransferCoordinator` the gateway routes with): any journey of any status (routing, holding, connected, completed, abandoned by the caller, superseded) is an attempt, so a transfer the caller abandoned while queued, or a safety route still in progress at call end, is not contained. A failed lookup also counts as an attempt (logged as `business.outcome.transfer_lookup_failed`, no identifiers), and connected or failed transfer evidence (`evidence.transferConnected` / `evidence.failed`) is never contained either. This is the evaluation aggregate's definition (`isContainedResult`: `transferOutcome` `NOT_ATTEMPTED`, i.e. no journey). Measured apart from resolution and never a success measure: no service objective, alarm or evaluation gate uses it. |
| Repeat contact | `outcomes.ts` `record()` | At a call's FIRST recorded outcome only (a repeated `record()` for the same call is not a contact), the call's authorized subject is resolved server-side and the most recent earlier call of that subject is looked up in `interaction_outcomes` (tenant-scoped, as `app_runtime` under RLS; revision rows are not contacts). `vsp_repeat_contacts_total{window, prior_outcome, prior_intent}` counts it once per configured window it falls in; `vsp_repeat_contact_checks_total{result}` (`repeat`, `first_contact`, `no_authorized_subject`, `subject_ambiguous`, `check_failed`) is the denominator. The check never changes or blocks the outcome. |
| Reopened cases | `support/support-request-service.ts` `observeCaseStatus()` | `vsp_cases_reopened_total{issue_category}` and `vsp_case_status_observations_total{case_state}`; audited as `support_request.case_reopened`. |

**Authorized subject.** From server-side records only: the `subjectRef` a trusted component may pass
to `record()` (the subject of the call's authorized session, never a caller, model or tool value), the
`subjectId` of every ledger action of the call (prepared only after a policy allow for that subject)
and the `subject_ref` of the call's support requests (linked only at A2+; restricted rows stay
invisible to `app_runtime`). Exactly one distinct subject is stored; none is `no_authorized_subject`,
several are `subject_ambiguous` (stored null, never guessed), an unreadable ledger entry or a
failed read of the call's support-request links is `check_failed` (stored null, never guessed from
the remaining sources, the trusted `subjectRef` included). A failed prior-contact lookup is
`check_failed` too, never `first_contact` (logged as `business.outcome.repeat_contact_check_failed`,
no identifiers). In every case the outcome row is still written. The gateway's TC-11 does not pass `subjectRef` yet (the interface in `contract.ts`
does not carry it; see Interface change requests), so a read-only call with no action and no
subject-linked support request is counted as `no_authorized_subject` and not measured today.
`interaction_outcomes.subject_ref` is readable by `app_runtime` and `app_worker` only: migration 0301
replaces the console's table-wide SELECT with a column grant without it, so the outcome row of a call
whose handoff record is restricted names no subject to the console.

**Once per call under concurrency.** `record()` and `reviseAfterCommit()` take the same
transaction-scoped advisory lock (`interaction_outcomes:<tenant>:<call>`) before reading the call's
rows, so under Aurora's READ COMMITTED two concurrent TC-11 requests (or a request and the
`action.committed` consumer) for one call cannot both see "no earlier row" and both count the call's
containment, repeat-contact check or verified resolution. `record()` also writes its row strictly
after the call's latest row, so the current outcome is unambiguous within one millisecond. PGlite runs
one transaction at a time, so the race itself cannot be reproduced offline; a unit test pins that both
writers take that one lock before any read, and the concurrent behaviour is UNVERIFIED until a test
against PostgreSQL with concurrent connections exists.

**Windows (placeholder).** `DEFAULT_REPEAT_CONTACT_POLICY.windows = ["24h", "7d"]`, the two windows
spec section 13 names; overrides are validated against the closed list `REPEAT_CONTACT_WINDOWS`
(`24h`, `72h`, `7d`, `14d`, `30d`; the id is the duration). What counts as a contact (any intent and
outcome, transfers and safety routes included, no exclusion for callbacks the organisation initiated)
is an engineering default pending the support / operations owner's success-measure definitions
(PRQ-001), not an approved definition.

**Reopened cases.** Case status and ownership are managed by humans in Salesforce and the sync only
pushes, so a reopening is measured where the platform READS the status
(`SupportRecordSystem.getCaseByExternalId`, through the kill-switch gate). `observeCaseStatus()` maps
the vendor value with `CaseStateMapping` (`DEFAULT_CASE_STATE_MAPPING` is a placeholder that maps
nothing: the tenant's Case Status picklist and closed semantics are UNKNOWN until PRQ-006 / VQ-SF-04,
so every observation is `unmapped` and nothing is recorded or guessed), appends a
`support_case_observations` row only on a change, and counts `CLOSED` -> `OPEN` as a reopening. A
request with no recorded Case id (`CASE_NOT_SYNCED`, even when a timed-out write left a Case in the
vendor) is not read at all; a failed or held read, and a Case found under the request's external id
with another Case id (`CASE_ID_MISMATCH`, e.g. recreated in the vendor), change nothing. Nothing calls it on a schedule yet: the trigger (a
Salesforce change notification or a bounded poll inside the API allocation, VQ-SF-07) is BLOCKED on
the Salesforce administrator, so reopened cases are measurable offline only with the LOCAL fixture
(`setCaseStatus`) and a TEST-ONLY mapping.

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
- **Organization-scoped support requests.** `create_support_request` with `linkToAccount` by an
  organization role (practice staff, partner, payer representative) at A2 links the request to the
  caller's server-established organization (`organization_ref`, never a subject). The link is
  authorized at creation by the organization's `case:read` path (purpose
  `delegated_practice_administration` / `partner_administration`, scope from the authoritative
  delegation / partner-contract registry), the same path `get_authorized_case_status` reads it back
  through; a refused link (expired delegation, no scope) denies the request instead of creating a
  person-only request. Staff of another practice neither list it nor read it by reference
  (`RELATIONSHIP_NOT_ESTABLISHED`).
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
- **Success speech from the authoritative receipt (ACT-05, finding ACT-F4).** After a COMMITTED
  ledger result, `AppointmentService.committedAppointment` never trusts a plain re-read: a
  system-of-record read is used only when its version equals the receipt's `afterVersion` and its
  provider evidence (`{appointmentId, startsAt, timeZone, status}`, the shape `SchedulingCommitPort`
  records) hashes to the receipt's `evidenceHash`; otherwise the digest-bound prepared change is
  checked against the same receipt evidence. Nothing that does not match the receipt is spoken: the
  result is `UNKNOWN_OUTCOME` / `COMMITTED_RECORD_UNREADABLE` (a replica-lag / stale read can no longer
  announce the old time as the new one). If the provider evidence shape changes, the check fails
  closed (UNKNOWN), never open.
- **Complete trusted readback (ACT-01, finding ACT-F5).** The digest-bound change carries every
  caller-relevant fact the commit applies and the confirmation templates (DRAFT `0.2.0-draft`) read
  all of them back: reschedule = old and new date / time / time zone **and visit type**
  (`fromModality`, `toModality`; the scheduling commit copies the slot's modality); new booking = date
  / time / time zone, visit type and the provider (`providerName`); billing review = the invoice date
  and the **review reason** (`reasonCategory`). `confirmation.ts` `READBACK_FIELDS` /
  `INTERNAL_CHANGE_FIELDS` list them per kind (a test asserts the change has no other field); an
  action missing one is never read back partially (null => human route). The prepare-tool speech and
  TC-07 use the same `confirmationSlotsFor`.
- **Staff retry re-authorization (ACT-01, finding ACT-F3).** The appointment and billing provider
  ports carry `authorizeOperatorRetry` (`services/operator-retry.ts`): before a console retry after a
  NOT_FOUND reconciliation, the CALLER's current authority is re-established from server-side state
  only: the bound session read by its non-bearer hash from the trusted session store (missing,
  revoked, ended or expired fails; it must still be at the action's generation, same tenant, actor and
  subject, without `SAFETY_ESCALATION_ACTIVE`), the authoritative target check, CURRENT relationships,
  kill switches and policy for the same commit action, purpose and resource as the caller-path commit.
  The ledger additionally requires the caller's confirmation to be fresh (see actions README).
- **Intake creation key (ACT-02, finding ACT-F2).** The idempotent creation key of a support request,
  complaint or partner intake is derived from the transport idempotency key (the tools require one),
  not from a per-invocation turn id: a same-key retry after an ambiguous timeout, even after its gateway
  reservation was re-taken, finds the record (and workflow, grant, sync message) the first execution
  created. A direct business call without a key falls back to the turn id.
- **Outcomes.** `RESOLVED` only with a verified COMMITTED receipt of the contract's action kind
  for this call; acceptance, request or Case creation is `REQUEST_ACCEPTED`; `TRANSFERRED` only
  after caller-confirmed connection; anything without evidence is `OUTCOME_UNKNOWN`. A call action
  whose commit is unsettled at call end (ledger COMMITTING / UNKNOWN, or COMMITTED but not yet
  recorded for the call; an unreadable ledger row counts as unsettled) makes the outcome
  `OUTCOME_UNKNOWN` / `COMMIT_OUTCOME_UNKNOWN` (only TRANSFERRED or a verified RESOLVED outrank it),
  never INFORMATION_PROVIDED. `interaction_outcomes` is append-only (migration 0300 trigger): the
  `action.committed` consumer calls `reviseAfterCommit()` (idempotent; the per-call advisory lock it shares with `record()`),
  which re-decides the call's latest outcome with the now-recorded receipt and, when the decision
  differs, appends a revision row (`evidence.revision = { revises, previousOutcome, trigger:
  ACTION_COMMITTED_AFTER_CALL_END, actionId }`, recorded strictly after the row it revises) and an
  `interaction.outcome_revised` audit event. The revision is written with `app_runtime`, the only
  role with INSERT on `interaction_outcomes` (a dedicated worker grant would need a 03xx migration).
- **Pre-disclosure recheck** (`recheck.ts`, spec section 9). Called by `PgWorkflowEngine` inside
  the guarded transition's transaction (`RecheckContext.tx`, added to the workflows port), after
  the durable grant check. Per grant action (`RECHECK_RULES`, ENGINEERING DEFAULT pending the policy
  owner: billing review commit / decision / outcome notices -> `invoice:read` on the authoritative
  invoice; complaint response -> `case:read` on the linked subject; partner onboarding notice /
  activation -> `case:read` on the partner organization; anything else `RECHECK_RULE_UNDEFINED`) it
  re-reads the grant's actor/subject, the authoritative record (invoice subject / support request
  link), reconstructs ONE role from the directory (self first; otherwise representative, whose
  current registry facts policy evaluates), requires ACTIVE accounts (`ACCOUNT_CLOSED`, ...), current
  consent (registry record first, `CONSENT_REVOKED`; else the consent captured with the accepted
  work; UNKNOWN => `CONSENT_NOT_ESTABLISHED`), refuses a material change while writes are off, and
  evaluates the CURRENT bundle (purpose `durable_follow_up`, A2 — grants naming an account or
  organization are only issued for work accepted at A2; tool null). The policy version and decision
  id are returned, so the engine records `POLICY_VERSION_CHANGED` for a newer bundle that allows and
  `POLICY_CHANGED_PENDING_ACTION` (with the reason) for any deny; the pending action stays with a
  human. An unverified complaint (grant names the request itself) => `RECHECK_SUBJECT_NOT_ESTABLISHED`;
  restricted records are invisible to the runtime role and fail closed. Workflows started by the
  business layer snapshot `policySnapshotVersion` (the pinned bundle version).
- **Provider's own schedule.** `get_appointment_options` with no appointment id by a provider lists
  that provider's own open slots only (`AppointmentService.ownScheduleOptions`; INTERNAL,
  `caller_self_service`, policy path `provider_own_schedule`), never a client's appointment.
- **Invoice line selector.** `get_invoice_status` `line: { chargeCode, amountMinor }` makes
  `LINE_EXPLANATION` explain exactly the one matching line (`selectInvoiceLine`); none or several
  matches explain no line (balance facts).
- **Support references** are spoken as pending synchronization, never as a Case number.
- **Recap** only at A2 for the same subject; risk flags suppress it. Support memory is only a
  POINTER (DATA-04, finding DP-03): `CaseService.recap` re-reads the referenced support request in the
  caller's runtime view and speaks the recap only when it still names the caller's own subject, is not
  RESOLVED and its authoritative status is open (not COMPLETED / CLOSED); the spoken category is the
  record's. A stale entry (cancelled or completed workflow) is skipped and the caller hears the
  authoritative `case.status`.
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
- contract.ts / gateway (SPEC-13.resolution-metrics, repeat contact): add the optional
  `subjectRef` to `InteractionOutcomeService.record`'s input (`outcomes.ts` already accepts it as
  `OutcomeRecordInput`), and have the gateway's TC-11 pass the subject of the call's AUTHORIZED
  session (A2+, server-side session state only, never a caller, model or tool value). Until then a
  read-only call with no ledger action and no subject-linked support request is
  `no_authorized_subject`.
- ~~contract.ts / gateway (SPEC-13.resolution-metrics, containment): a `transferRequested` outcome
  evidence flag~~ — not needed: `outcomes.ts` reads the call's transfer journeys through
  `deps.transfers` itself (Containment row above).
- ~~workflows: a durable action grant for `grantRef`~~ — done in wave 4 (below).

## Tests

```bash
cd platform
npx vitest run src/business src/gateway/tools src/voice src/main/sessionless-routing.test.ts
npx vitest run src/business/transactions.test.ts test/journeys/transactions.test.ts   # ACT-F2..F5, DP-03
npx vitest run test/journeys/recheck.test.ts test/journeys/outcomes.test.ts test/journeys/j2-billing-dispute.test.ts
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
  the TC-07 confirmation template from the prepared action (appointment from/to times, time zones and
  visit types; new booking provider; billing review reason) or the system of record (invoice issue
  date); anything missing => null => human route.
* **Outcomes**: with `contractId: null` (TC-11) the contract is inferred from the call's verified
  committed actions (a resolving contract first); the evidence row records `contractInferred`.
* **Handoff observer**: `BusinessHandoffService` reports every returned handoff to
  `ToolDeps.handoffObserver` (never affects the route).
* **Port additions** (additive, optional): `SupportRequestService.retryDue` and
  `repairDeadLetter` (the worker owner can now run the retry sweep; see the journeys README for the
  missing loop), `ToolDeps.grants`, `ToolDeps.handoffObserver`, `BusinessModule.confirmationSlots`.

## Wave 5 business-correctness fixes

* Pre-disclosure recheck implemented and wired (`recheck.ts`; container `recheck`): guarded workflow
  transitions no longer fail closed `RECHECK_NOT_CONFIGURED`; denials record
  `POLICY_CHANGED_PENDING_ACTION`. Interface changes outside this module (additive): workflows
  `RecheckContext.tx` (engine passes the transition's transaction); container field `recheck`.
* Outcomes: `COMMIT_OUTCOME_UNKNOWN` at call end and append-only revisions (`reviseAfterCommit`,
  optional on the `InteractionOutcomeService` port).
* Organization-scoped support requests for organization roles; provider own-schedule options;
  invoice line selector (see Design decisions).
* LOCAL FIXTURE data: provider self facts carry `appointment:list_options`; the scheduling fixture
  lists a provider subject's own open slots.
* Known limits: the consent and account-state registries are LOCAL FIXTURES (live BLOCKED: privacy
  counsel PRQ-026, identity owner PRQ-005); recheck rules are engineering defaults pending the policy
  owner; a billing review accepted by reconciliation carries no consent snapshot (the worker never
  saw the call's consent), so its disclosures wait for a human until the consent registry records
  current consent; the provider own-schedule offer reuses the client-oriented DRAFT template
  `appointment.option_offer` (a provider-facing template is a voice-module request).

## Safety-handoff review fixes (SAFE-HANDOFF-02, -05, -07, DP-01)

* **Safety supersedes standard journeys (SAFE-HANDOFF-02, SAFE-03).** `requestHuman` takes the
  safety route instead (SAFETY_ROUTE MAINTAIN when a safety journey is active, otherwise a new
  safety route) when the reason is `SAFETY_PRIORITY`, the staff-selected destination has purpose
  `SAFETY_PRIORITY`, the stated category is `safety_concern`, the call has a SAFETY journey that is
  ROUTING or CONNECTED (bounded lookup) or the session carries `SAFETY_ESCALATION_ACTIVE`. It never
  dials a STANDARD destination then; the coordinator enforces the same invariant and supersedes the
  call's STANDARD journeys when a safety route starts (`workflows/README.md`). The signal is
  `CALLER_REQUEST` (UNRESOLVED) for caller-originated requests and `HUMAN_INTERVENTION` for staff.
  A human request that races a safety route (the safety signal arrives while its STANDARD dial is
  pending, or before its journey is written) is resolved in the coordinator under concurrent writes
  (conflict retry, STANDARD steps yield to an active SAFETY journey, write-then-read): the STANDARD
  journey ends `SUPERSEDED` and `requestHuman` answers with the SAFETY journey it gets back (round 2
  of SAFE-HANDOFF-02; end to end in `test/journeys/safety-supersede-race.test.ts`).
* **Staff safety escalation (SAFE-HANDOFF-05).** `requestSafetyRoute` accepts `initiatedBy` (audited
  as the actor, sourceComponent `console`). With no usable context it resolves the call's live
  session server-side through `ToolDeps.callSessions` (trusted call binding; composed in the local
  container over the LOCAL FIXTURE interaction index) and uses it ONLY to revoke pending mutations
  and apply `SAFETY_ESCALATION`, never for disclosure or the receiver package. Live resolution is
  BLOCKED (TB-01 / an identity-owned call-index operation); the console then revokes the call's
  pending actions through the ledger and the session flag is not set (recorded gap).
* **Safety evidence for every source (SAFE-HANDOFF-07).** With `ToolDeps.safetyEvents` composed,
  `requestSafetyRoute` begins the incident (validated instant, no I/O) before routing and records
  ROUTE_INITIATED (time to route, `vsp_safety_time_to_routing_ms`) and SIGNAL_VALIDATED after the
  route was requested, bounded and never blocking it: screening, `request_safety_route` with or
  without a session, console escalation and a human request in safety mode (a request that only
  maintains an already active safety journey passes `recordSafetyEvent: false`). The result says
  `safetyEventRecorded`, so the screening route does not record twice. The reason code is the
  caller's deterministic decision (`decisionReasonCode`) or `SafetyRouter.decide`.
* **Restricted handoff records (DP-01, DATA-01, spec section 8).** `handoffRecordPlacement`:
  reason `CLINICAL_QUESTION` or category `clinical_question_redirected` => restricted,
  `q_clinical_route`, never subject-linked; `privacy_concern` => restricted, `q_privacy_office`;
  `safety_concern` / `SAFETY_PRIORITY` => restricted P1 `q_safety_responders` (in practice the
  safety record). Restricted rows are hidden from the runtime role (RLS) and synchronize as the
  minimal RESTRICTED Case. `request_human_transfer` keeps the full category enum on purpose: a
  schema rejection would fail the human route, so the restriction is derived server-side. Owner
  queue names are placeholders pending the operations queue configuration.
* **Additive contract changes:** `ToolDeps.safetyEvents`, `ToolDeps.callSessions`;
  `HandoffResult.priority`, `HandoffResult.safetyEventRecorded`; `requestSafetyRoute` optional
  `initiatedBy`, `decisionReasonCode`, `correlationId`, `recordSafetyEvent`.
