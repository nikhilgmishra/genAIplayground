# ADR-0015 Pre-disclosure recheck: guarded workflow transitions re-evaluate current consent, representation, account state and policy before a protected disclosure or material change

| Field | Value |
|---|---|
| Status | **Accepted for engineering**. Live consent and account-state registries: **BLOCKED** (PRQ-026, PRQ-005). Recheck rule table: engineering default **Pending human approval** by the policy owner |
| Date | 2026-10-18 |
| Decided by | Principal engineer (coding agent) for the engineering scope only |
| Approval needed from | Policy owner (rule table); privacy counsel (consent registry); identity owner (account state, representative authority) |
| Related prerequisites | PRQ-005, PRQ-026, PRQ-031, PRQ-033 |

## Context

Spec section 9: "Before later disclosure or a material change, recheck consent, representation,
account state and relevant policy. Snapshot policies for reproducibility but apply revocations
and updated legal constraints immediately. Record when new policy changes a pending action."
Durable work (billing dispute review, complaint review, partner onboarding) is accepted during a
call and finished later by staff or the worker, after the call's session is gone.

`platform/src/workflows/recheck.ts` defined the `PreDisclosureRecheck` port, and with nothing
wired `unconfiguredRecheck` throws `RECHECK_NOT_CONFIGURED`, so every guarded transition failed
closed. Durable work therefore could not reach its disclosure or material-change step at all.

## Decision

1. **Where it runs.** `PgWorkflowEngine` (`platform/src/workflows/engine.ts`) calls the hook for
   every transition that has a transition guard, inside that transition's transaction
   (`RecheckContext.tx`, scoped to the tenant under row-level security and holding the instance
   row lock), after the durable action grant was checked valid for the transition's
   `grantAction`. The container wires `BusinessPreDisclosureRecheck`
   (`platform/src/business/recheck.ts`) into the engine (`platform/src/main/container.ts`).
2. **Current, server-established facts only**; nothing comes from the workflow event, the staff
   request, a caller or a model:
   1. rule for the grant action from the closed table `RECHECK_RULES` (billing review commit,
      decision and outcome notices -> `invoice:read` on the invoice; complaint response ->
      `case:read` on the linked subject; partner onboarding notice and activation -> `case:read`
      on the partner organization); anything else `RECHECK_RULE_UNDEFINED`;
   2. the durable grant's subject and actor, read in the transition's transaction;
   3. the authoritative record (invoice from the billing system, or the accepted support
      request) must still name the grant's subject or organization;
   4. representation: one role reconstructed from the directory (self first); anyone else needs a
      current legal authority, which policy evaluates from the registry facts including expiry;
   5. account state ACTIVE for the subject (and a representative's own account);
   6. consent: the consent registry's CURRENT record wins, so a revocation applies immediately;
      without one, the consent captured with the accepted work; UNKNOWN is never consent;
   7. kill switches: a material change is refused while writes are off;
   8. policy: the CURRENT bundle evaluates the rule's action for purpose `durable_follow_up`.
3. **Recording.** A deny returns a reason code; the engine records
   `POLICY_CHANGED_PENDING_ACTION` and the pending action stays with a human
   (`WorkflowRecheckDeniedError`). An allow under a newer policy version is audited as
   `POLICY_VERSION_CHANGED`. Each decision is audited `workflow.recheck.allowed` or
   `workflow.recheck.denied`.
4. **Fail closed.** An unreadable dependency throws, and the engine refuses the transition
   without recording a policy change (it was not one). A malformed hook result fails closed
   (`RecheckResultSchema`). A recheck that is not given the transition's transaction refuses to
   run.

Tests (offline, LOCAL FIXTURE registries, SYNTHETIC people): `platform/test/journeys/recheck.test.ts`
(complaint response allowed; unverified complaint waits for a human; expired affiliation and
expired legal authority deny; a newer bundle that no longer permits the action records
`POLICY_CHANGED_PENDING_ACTION`, one that still permits it records the new version; missing rule
and missing transaction fail closed) and `platform/test/journeys/j2-billing-dispute.test.ts`
(consent revoked and account closed after acceptance apply immediately). Status:
IMPLEMENTED_OFFLINE.

## Consequences

* Guarded transitions now complete when current facts allow them, and stop with a human when they
  do not; revocations apply at the moment of disclosure, not at acceptance.
* The consent and account-state registries are LOCAL FIXTURES (`LocalConsentRegistryFixture`,
  `LocalAccountStateFixture` in `platform/src/business/fixtures/recheck.fixture.ts`); the live
  versions are BLOCKED on privacy counsel (PRQ-026) and the identity owner (PRQ-005).
* A billing review accepted by reconciliation carries no consent snapshot (the worker never saw
  the call's consent), so its disclosures wait for a human until the consent registry records
  current consent.
* Grant actions of workflows the business layer does not start (callback outreach, claim
  findings, provider documents) have no rule and fail closed.
* The rule table is code, reviewed with the code; it should follow the resolution contracts
  (PRQ-033) and the released policy bundle (PRQ-031).
* Step Functions deployment of the same definitions stays BLOCKED
  ([ADR-0007](ADR-0007-workflow-single-source.md)); recheck task messages already carry the
  transition's `grantAction`.

## Alternatives considered

| Alternative | Why not adopted |
|---|---|
| Rely on the policy snapshot taken at acceptance | Spec section 9: revocations and updated legal constraints apply immediately |
| Recheck in the console or worker before sending the event | The facts would come from the request; they must be server-established at the transition (AUTH-03) |
| Recheck in a separate transaction | Deadlocks a single-connection engine (PGlite) and reads outside the transition's snapshot on PostgreSQL |
| Allow the transition when a registry is unreachable | Would disclose without current consent or authority |
| Keep failing closed with no hook (previous behaviour) | Durable work could never reach its disclosure step |

## Linked requirements

AUTH-02, AUTH-03, AUTH-05, DATA-03, OPS-06, SPEC-9.recheck, SPEC-7.durable-grant.

## Revisit when

Live consent and account-state registries exist (PRQ-026, PRQ-005), the policy owner approves the
rule table, or a new durable workflow type with a disclosure step is added.
