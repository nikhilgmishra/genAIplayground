# Workflows module — durable follow-up and call transfer

Status: **IMPLEMENTED_OFFLINE**. Verified only against PGlite (real PostgreSQL in WASM) and
labelled local fixtures. Nothing here has been verified against AWS Step Functions, SQS,
Aurora or Talkdesk. This module does not make the platform HIPAA compliant or production ready.

Spec sections: 3 (Step Functions Standard; no second workflow engine), 9 (durable follow-up),
10 (transfer contract), 15 Phase 5 (in-flight version compatibility).

## What is implemented

| File | Purpose |
|---|---|
| `ports.ts` | Shared port (unchanged signatures) |
| `types.ts` | `VersionedWorkflowDefinition` (adds transition guards, business-role documentation, per-event actor permissions `eventActors` and durable-grant actions `grantActions`), reserved engine events, business-role → staff-role mapping |
| `definitions/*.ts` | Versioned (`1.0.0`) definitions for all seven workflow types |
| `validator.ts` | Definition validator (reason codes only) |
| `registry.ts` | Registry keyed by type + version; immutable versions; newest-by-semver for new starts |
| `duration.ts` | Strict ISO-8601 durations (W/D/H/M/S only; 1 min .. 365 days) |
| `engine.ts` | `PgWorkflowEngine` — the local durable executor implementing `WorkflowEngine` |
| `tokens.ts` | Human-task tokens: 256-bit random, SHA-256 at rest, constant-time comparison |
| `recheck.ts` | Pre-disclosure / material-change recheck hook contract; fails closed when unwired |
| `grants.ts` | `PgDurableGrantStore` (`DurableGrantStore` port): issue / check / revoke narrowly scoped durable action grants (spec section 7) |
| `outcome.ts` | Workflow state → `Outcome` mapping (ACT-04) |
| `asl.ts`, `generate-asl.ts` | ASL generator + CLI writing `infra/stepfunctions/*.asl.json` (`--check` for drift) |
| `transfer.ts` | Pure transfer transition function, `TransferCoordinator`, `TransferStore` + `MemoryTransferStore` (local fixture) |
| `notification-policy.ts` | Follow-up notification decision: neutral templates, consent, preferences, verified channel, quiet hours |
| `../../migrations/0401_workflows.sql` | `workflow_instances`, `workflow_events` (append-only), `workflow_tasks`; RLS; least-privilege grants; due-work scan function |
| `../../migrations/0402_durable_action_grants.sql` | `durable_action_grants`: opaque grant id, tenant, subject, actor, `actions text[]` (dotted codes), expiry, single revocation, opaque source ref; forced tenant RLS; append-only except one revocation; no PHI columns |
| `workflow-test-fixtures.ts` | LOCAL TEST FIXTURES (audit writers, recheck, telephony) — tests only |

### Definitions

Every nonterminal state declares an owner queue (`q_*`), an ISO-8601 deadline, a retry budget and
an escalation `{event: "ESCALATED", ownerQueue: "q_*_supervisors"}` whose transition hands the work
to a human state (escalation can never end the work; the validator rejects that). Terminal states
are `COMPLETED`, `FAILED`, `CANCELLED`. **Deadlines and retry budgets are proposed engineering
defaults, not service-level commitments**; support operations must approve them (BLOCKED below).

The validator rejects: missing/invalid owner, missing/invalid/calendar-unit deadline, invalid retry
budget, missing or unrouted escalation, escalation into a terminal state, transitions to undefined
states, unreachable states, trap cycles with no path to a terminal state, reserved events declared
as transitions, human tasks without valid staff roles or without both decision routes,
`WAITING_FOR_HUMAN` without a human task, guarded transitions without a
`POLICY_CHANGED_PENDING_ACTION` route, guards on escalation routes, and role-mapping mismatches.
It also enforces **event actor permissions** and **durable-grant actions**:

* every event used by any transition, plus `RETRYABLE_FAILURE`, declares the actor kinds
  (`caller`, `system`, `staff`, `external_system`) that may send it (`EVENT_ACTORS_MISSING`,
  `EVENT_ACTORS_EMPTY`, `EVENT_ACTOR_UNKNOWN`, `EVENT_ACTOR_DUPLICATE`, `EVENT_ACTORS_UNUSED`);
* `HUMAN_APPROVED` / `HUMAN_REJECTED` are exactly `["staff"]` (and are still only accepted through
  `completeHumanTask`); `POLICY_CHANGED_PENDING_ACTION` is `[]` (engine-raised only);
  `RETRYABLE_FAILURE` may not include `caller`; every escalation event includes `system`;
* every guarded transition names the grant action it consumes (`GUARD_GRANT_ACTION_MISSING`,
  `GRANT_ACTION_INVALID`, `GRANT_ACTION_WITHOUT_GUARD`).

Shipped actor sets (`definitions/builders.ts` `ACTORS` / `COMMON_EVENT_ACTORS`): validation,
commit, consent and sync events are `system` (some also `staff`); system-of-record outcomes
(`SYSTEM_CONFIRMED`, `SYSTEM_REJECTED`, `PERMANENT_FAILURE`, `SYNCED`) are `system` /
`external_system`; `CANCEL` and `ESCALATED` are `system` / `staff`; a `caller` may send only
`CALLER_RESPONDED` and `DOCUMENTS_SUBMITTED`. Shipped grant actions: `billing.review.commit`,
`billing.review.decision_notice`, `billing.review.outcome_notice`, `callback.outreach`,
`claim.findings.disclose`, `complaint.response.disclose`, `partner.onboarding.activate`,
`partner.onboarding.decision_notice`, `provider.documents.record_review`,
`provider.documents.request_correction`. These are reviewed engineering choices, editable only
through a new definition version.

### Role mapping (human tasks)

`StaffRole` currently has no business-specialist roles, so each human task names a business
approval role that is mapped onto staff roles (`types.ts`, `BUSINESS_ROLE_STAFF_MAPPING`):

| Business role | Staff roles | Used by |
|---|---|---|
| billing_specialist | supervisor, support_agent | billing_dispute_review |
| provider_relations_specialist | supervisor, support_agent | provider_document_review |
| claims_specialist | supervisor, support_agent | claim_investigation |
| partner_manager | supervisor | partner_onboarding |
| crm_repair_operator | supervisor, support_agent | support_request_sync |
| callback_agent | support_agent, supervisor | callback_request |
| complaints_reviewer | supervisor | complaint_review |

This is an interim mapping: any support agent can decide a billing dispute task. A dedicated
workforce role is requested below.

### Engine guarantees (`PgWorkflowEngine`)

* `start(input, tx?)` runs inside the caller's transaction when given (atomic with the accepting
  action) and refuses a transaction whose RLS tenant differs from `input.tenantId`.
* Instances hold opaque ids, queue ids, versions and references only. `source_record_refs` must be
  opaque ids or `SR-XXXX-XXXX` references (enforced by zod and a CHECK constraint).
* `definition_version` is pinned at start; runtime roles have **no UPDATE privilege on that column**.
  Old versions stay in the registry so in-flight instances keep their definition (Phase 5).
* `signal` validates the event against the pinned definition, uses optimistic concurrency
  (`expectedVersion`, plus `row_version` in the UPDATE predicate), and ignores duplicates: the same
  `dedupeKey` (or, if absent, the same `expectedVersion` + event) is a no-op returning the current
  instance. Invalid transitions throw `TRANSITION_NOT_ALLOWED` without changing state.
* `RETRYABLE_FAILURE` consumes the state's retry budget; exhaustion fires the escalation event.
* `tick(now)` escalates overdue states and exhausted budgets via a `SECURITY DEFINER` due-work scan
  that returns opaque ids only; each instance is then processed in its own tenant-scoped (RLS)
  transaction. Failures (e.g. an unloadable definition version, audit outage) are reported by
  `tickDetailed` and the instance stays due — nothing is dropped silently.
* Every transition writes an append-only `workflow_events` row and an audit event **in the same
  transaction**; if the `AuditWriter` throws, the transition rolls back (OPS-01).
* Human tasks: entering `WAITING_FOR_HUMAN` opens a task (one open task per workflow, expiring at
  the state deadline). `issueTaskToken` mints a token for an authenticated staff member with a
  required role, MFA and no expired break-glass, returns the plaintext **once** (for an authenticated
  console response body — never a URL) and stores only its SHA-256, bound to that staff member and
  expiring at `min(task expiry, now + taskTokenTtlSeconds)` (default 900 s, pending security
  approval). Re-issuing rotates the token. `completeHumanTask` verifies the digest in constant time,
  token and task expiry, OPEN status, the binding to the presenting staff member, and re-validates
  current role / MFA / break-glass; it is single use (status COMPLETED, digest erased). Denials are
  audited (reason code only, never the token).
* `HUMAN_APPROVED`, `HUMAN_REJECTED` and `POLICY_CHANGED_PENDING_ACTION` are engine-only: `signal`
  refuses them, so a model or caller cannot complete a task by inventing an approval.
* **Actor permissions**: `signal` loads the pinned definition and refuses an actor kind that the
  definition does not declare for the event with `WorkflowActorNotPermittedError`
  (`ACTOR_NOT_PERMITTED`) *before* dedupe, version or state checks; the transaction rolls back (the
  instance is unchanged) and the denial is audited (`workflow.signal.denied`, `SECURITY_AUDIT`). An
  event the definition does not declare at all is `TRANSITION_NOT_ALLOWED`. `completeHumanTask`
  additionally requires the decision event to be declared for `staff`.
* Guarded transitions (`transitionGuards`: `disclosure` / `material_change`) require a durable
  action grant. With `PgWorkflowEngineOptions.grantStore` wired, the engine calls
  `grantStore.check(tenantId, grantRef, grantAction, now, tx)` inside the transition's transaction
  for the transition's declared `grantActions` entry: an invalid, expired, revoked, mis-scoped or
  unknown grant takes the **recheck-denied path** (`workflow.grant.denied` audit +
  `POLICY_CHANGED_PENDING_ACTION`, `WorkflowRecheckDeniedError` with `GRANT_*` reason) and the
  recheck hook is not called; an unreachable store or malformed answer fails closed with no
  transition and no policy-change record. An instance **without** a `grantRef` keeps the previous
  behaviour (`DURABLE_GRANT_MISSING` deny) and reports `GRANT_ABSENT` (log + `vsp_grant_checks_total{result="absent"}`).
  Without a wired store, `grantRef` is only passed to the recheck hook (previous behaviour) and
  `GRANT_STORE_UNCONFIGURED` is reported (`result="store_unconfigured"`). The engine then calls
  `PreDisclosureRecheck` (context now includes `grantAction`) with the current context and the
  policy snapshot version. A deny records `POLICY_CHANGED_PENDING_ACTION` (routed per definition, e.g. back to a
  human or `CANCELLED` for a callback whose consent was revoked) and throws
  `WorkflowRecheckDeniedError`. A failing or malformed hook fails closed with no transition. An
  allowed recheck under a newer policy version is audited as `POLICY_VERSION_CHANGED`.

### ASL (Step Functions STANDARD)

The worker answer is now `{"event": "<EVENT>", "actorKind": "<kind>"}`: `ResultSelector` keeps
both fields and each route `Choice` rule requires the event **and** one of its declared actor kinds
(`And` of `StringEquals` plus an `Or` over the kinds). A missing field, an undeclared event or a
non-permitted actor escalates; `POLICY_CHANGED_PENDING_ACTION` is not routable from a worker
answer (only from a recheck decision); escalation `Pass` states carry `actorKind: "system"`.
Recheck task messages carry the transition's `grantAction`. The worker-contract paragraph in
`infra/stepfunctions/README.md` documents the same `{"event", "actorKind"}` answer.

See `infra/stepfunctions/README.md` for the document shape, the Terraform placeholders
(`${system_task_queue_url}`, `${human_task_queue_url}`, `${notify_queue_url}`,
`${escalation_queue_url}`, `${recheck_queue_url}`), logging/IAM requirements and the worker contract.
Every document is validated with `asl-validator` in tests; a property test walks the ASL and the
definition with the same events from permitted actors (identical states required) and checks that
every non-permitted actor kind escalates.

### Transfer coordinator

* Pure `transferTransition`: forward path REQUESTED → (QUEUED optional) → RECEIVER_ACCEPTED →
  BRIDGED → CALLER_CONFIRMED_CONNECTED → COMPLETED; failure events TIMEOUT, RECEIVER_UNAVAILABLE,
  BRIDGE_DROPPED, CALLER_DISCONNECTED, DIAL_FAILED; duplicates ignored; out-of-order/invalid events
  rejected without state change; terminal attempt states absorb.
* Outcome is `TRANSFERRED` only once `CALLER_CONFIRMED_CONNECTED` was reached (cleared again if the
  bridge drops). A successful dial is never a transfer (SAFE-04).
* Journey status: `ROUTING` whenever an attempt is in flight or awaiting a retry (the sweep's work
  list), `CONNECTED` only while the caller is confirmed connected (`connectedAt` set). A bridge drop
  after `CALLER_CONFIRMED_CONNECTED` puts the journey back to `ROUTING` and re-enters the fallback
  chain, so the sweep times out and re-dials the next attempt (SAFETY and STANDARD); a caller
  disconnect between attempts closes the journey even if it was CONNECTED before (finding
  SAFE-HANDOFF-01).
* One active journey per call, SAFETY first (SAFE-03, finding SAFE-HANDOFF-02): starting or
  re-requesting a SAFETY journey marks every active STANDARD journey of the call `SUPERSEDED`
  (audited `transfer.superseded`, reason `SUPERSEDED_BY_SAFETY_ROUTE`; no further timeouts,
  failovers, update prompts or dials; late vendor events on it are rejected
  `TRANSFER_JOURNEY_SUPERSEDED`). A STANDARD request while a SAFETY journey of the call is ROUTING
  or CONNECTED dials nothing and returns that SAFETY journey (audited
  `transfer.standard_request_superseded`). `activeSafetyJourney()` / `journeysForCall()` expose
  this to the HandoffService; `TransferStore.listForCall` backs it.
* The invariant holds under concurrent writes (SAFE-HANDOFF-02 round 2; the first fix logged a
  version conflict on the supersede write and moved on, leaving the STANDARD journey ROUTING and
  re-dialled by the sweep):
  * the SUPERSEDED write is conditional; a `ConflictError` (the STANDARD journey was written between
    the read and the write, e.g. its vendor dial returned) is retried on a fresh read, at most
    `MAX_SUPERSEDE_WRITES` (8) times, then logged `TRANSFER_SUPERSEDE_RETRIES_EXHAUSTED`;
  * every STANDARD routing step first checks the call for an active SAFETY journey and supersedes
    instead of proceeding (`yieldsToSafety`): the sweep (before a TIMEOUT or retry), a vendor event
    (`applyEvent` rejects it `TRANSFER_JOURNEY_SUPERSEDED`), the failover, the retry and between-tries
    update prompts, and right before every dial (`startAttempt`). It also stops when the supersede
    write itself failed (fail closed; nothing STANDARD is prompted or dialled) and throws on a failed
    lookup (STANDARD fails closed on store errors);
  * write-then-read on both sides: a new STANDARD journey is written before its first dial check and
    re-reads after routing (`supersedingSafety`, the request then returns the SAFETY journey); a SAFETY
    journey is written before its supersede read. Of two concurrent requests at least one sees the
    other;
  * the sweep re-supersedes for every routing SAFETY journey, so a supersede that could not be
    written (store outage, retries exhausted) is retried until it lands, also for CONNECTED or
    HOLDING_FOR_OPERATIONS STANDARD journeys that the sweep does not otherwise visit;
  * a STANDARD dial already in flight when the supersede commits is recorded on the superseded
    journey (vendor reference, audited `transfer.attempt_started` / `INVALIDATED` /
    `SUPERSEDED_BY_SAFETY_ROUTE`), so its late vendor events are matched and rejected; it is never
    retried or failed over.
* Destinations come only from `DestinationConfig[]`; ids/queue refs that look like phone numbers
  (`+…`, ≥7 digits), tel/sip/http URIs, emails or paths are rejected (SAFE-05). A **safety** handoff
  carrying a bad or non-safety destination is routed to the configured `SAFETY_PRIORITY`
  destination instead (the supplied value is never dialled, the correction is audited).
* On TIMED_OUT / RECEIVER_UNAVAILABLE / BRIDGE_DROPPED / dial failure: play the approved update
  template (id only) and invoke the next route of the plan *primary → fallbacks (transitive) →
  OUTAGE_CONTINUITY*. The call is never ended (the port has no hang-up). STANDARD journeys retry
  continuity up to `maxStandardContinuityAttempts`, then hold for operations (caller still
  connected, error logged, outcome FAILED). SAFETY journeys cycle through the staffed routes and
  continuity indefinitely — no timeout, attempt count or budget abandons them (SAFE-03). If
  telephony control is down, one bounded pass is attempted and the sweep retries later.
* Time to route initiation is measured with the Clock from the validated safety event to the first
  dial command; misses of the 2000 ms engineering target are logged and audited, never abandoned.
* Transfers are the safe route: audit or (for SAFETY) store unavailability never blocks them; gaps
  are counted on the journey (`auditGaps`, `persistenceGaps`) for reconciliation (OPS-02).

## LOCAL FIXTURES

* `MemoryTransferStore` (`kind: "local_fixture"`). The coordinator refuses fixture store/telephony
  in `production` (OPS-04).
* `workflow-test-fixtures.ts`: `AuditWriterFixture` (writes validated audit inputs into a test table
  inside the caller's transaction so rollback is real), `MemoryAuditWriterFixture`,
  `RecheckFixture`, `TelephonyControlFixture`, `staffActor()` (from the SYNTHETIC world).
* Destination ids and placeholder vendor queue refs come from `fixtures/synthetic-world.ts`.

## BLOCKED (not implemented; prerequisite needed)

| Item | Why | Prerequisite |
|---|---|---|
| Deploying the generated state machines; worker / human-task bridge against real Step Functions + SQS (`SendTaskSuccess`, heartbeats, KMS-encrypted SFN token storage) | Requires real AWS resources and billable execution | AWS sandbox account, reviewed Terraform plan, cost estimate, approval (spec section 5) |
| Live `TransferStore` (DynamoDB conditional writes, incl. a per-call index for `listForCall`) and live TelephonyControl events | Transfer events export (TB-07) and webhook authentication (TB-09) are UNKNOWN | Talkdesk sandbox + documented transfer event API; without TB-07 outcomes stay OUTCOME_UNKNOWN and humans reconcile |
| Withdrawing a STANDARD dial already in flight at the vendor when a safety route supersedes it | The `TelephonyControl` port has no cancel operation; the superseded journey is only never retried or failed over | Talkdesk documented transfer-cancel capability (TB-07) |
| Production deadlines, retry budgets, attempt timeouts, continuity attempt cap, task-token TTL | Operational/security commitments, not engineering facts | Support operations and security approval |
| Approved update template content (`updateTemplateIds`) and safety disconnect / after-hours procedures | Clinical and legal scripts | Clinical safety lead approval (spec section 5) |
| Live recheck hook (OPA decision + consent / representation / account-state lookups) | Owned by policy and identity modules | Those modules' live implementations |
| Retention / deletion of workflow history | `workflow_events` is append-only (trigger blocks UPDATE/DELETE); no retention durations exist | Counsel-approved retention class + a reviewed purge migration |

## Requirement coverage

| ID | Enforcement | Tests |
|---|---|---|
| ACT-04 | `outcome.ts`; audit outcome PENDING for nonterminal | `engine.test.ts`, `definitions.test.ts` (`[ACT-04]`) |
| ACT-02 | dedupe keys + unique index; single-use tasks; no CANCEL after commit submission | `[ACT-02]` tests |
| SAFE-03 | safety journeys cycle routes forever (also after a bridge drop); route timing; audit/store gaps tolerated; SAFETY supersedes STANDARD journeys of the call, also under concurrent writes (conflict retry, STANDARD steps yield, sweep re-supersedes) | `transfer.test.ts` `[SAFE-03]`, `[SAFE-HANDOFF-01]`, `[SAFE-HANDOFF-02]`; `transfer.supersede-race.test.ts` `[SAFE-03][SAFE-HANDOFF-02]` (forced interleavings + exhaustive microtask grid) |
| SAFE-04 | `transferTransition`, `journeyOutcome` | `[SAFE-04]` incl. property test |
| SAFE-05 | `looksLikeDialTarget`, allowlist, `validateDestinations` | `[SAFE-05]` incl. property test |
| OPS-01 | audit in the transition transaction; fail closed | `[OPS-01]` |
| OPS-02 | continuity routing; never ends call; audit outage tolerated for transfers | `[OPS-02]` |
| OPS-04 | coordinator refuses fixtures in production | `[OPS-04]` |
| AUTH-02 / AUTH-05 | tenant-context check in `start`; RLS; staff authority re-validation | `[AUTH-02]`, `[AUTH-05]` |
| AUTH-03 | per-event actor permissions in definitions, engine and ASL | `engine.test.ts`, `definitions.test.ts`, `asl.test.ts` (`[AUTH-03]`) |
| SPEC-7.durable-grant | `grants.ts`, migration 0402, engine grant check on guarded transitions | `grants.test.ts` (`[SPEC-7.durable-grant]`) |
| DATA-01 | constrained columns, no free text, content-free logs | `[DATA-01]` |
| SPEC-9.* / SPEC-10.* / SPEC-3.* / SPEC-15.phase5 | as described above | tagged tests in all five test files |

## How to test

```bash
cd platform
npx vitest run src/workflows
npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E "src/workflows"   # expect no output
npx eslint src/workflows
npx tsx src/workflows/generate-asl.ts --check                      # ASL drift check (regenerate: drop --check)
```

## Interface change requests (not applied; owned elsewhere)

* `WorkflowEngine.signal` input: add optional `dedupeKey` (implemented as an extended input type).
* Composition root (`platform/src/main/container.ts`): construct `PgDurableGrantStore` and pass it as
  `grantStore` (plus `metrics`) to `PgWorkflowEngine`; business layer: issue a grant (inside the
  accepting transaction, `issue(input, tx)`) with the definition's grant actions and pass its
  `grantRef` to `workflows.start`.
* `WorkflowEngine.start` input: add optional `policySnapshotVersion` and `definitionVersion`.
* `WorkflowEngine`: add `issueTaskToken` (token minting for authenticated console endpoints).
* `StaffRole`: add a dedicated `billing_specialist` (and similar) role so billing decisions are not
  open to every support agent.
* `TransferRecord`: optional vendor transfer reference (kept in the journey meanwhile).

## Known gaps

* The engine authorizes the actor **kind** per event; it cannot prove which caller, staff member or
  system a `ref` names. The calling backend (gateway, console API, worker) must still establish the
  actor from server-side state (AUTH-03) before signalling.
* The grant check does not bind a grant to a specific workflow instance beyond the `grantRef` the
  trusted backend stored at `start`; the issuer must mint one grant per accepted work item.
* Grants are not yet issued by the business layer (it starts workflows with `grantRef: null`);
  the composition root does not yet pass `grantStore` to `PgWorkflowEngine`.
* The Step Functions worker bridge is not implemented (BLOCKED); in AWS mode the ledger tables would
  be mirrored by that bridge.
* PGlite is single-connection, so true concurrent-transaction races are exercised only through the
  optimistic-concurrency predicates, not with parallel connections.
