# ADR-0019 Test truth for the evaluation gates: fault reach on independent evidence, fixed denominators, family split, corpus guard and per-gate mutation

| Field | Value |
|---|---|
| Status | **Accepted for engineering** (software scope; renumbered from the WP-01 proposal by the phase B integration package WP-07). Acceptance claims from the corpus: **Pending human approval** (a newly authored, human-reviewed held-out set, AIN-31) |
| Date | 2026-10-21 (drafted in phase B by its work package; renumbered on integration) |
| Decided by | Principal engineer (coding agent) for the engineering scope only |
| Approval needed from | Evaluation owner and clinical safety lead (corpus review records, AIN-31); release owner (scorer version in the release manifest) |
| Related prerequisites | Activation register AIN-31 (human reviewers and labelled data) |
| Origin | Proposed as `docs/adr/proposed/WP-01-test-truth.md` |

## Context

Context: follow-on prompt section 17 (evaluation, test truth and release targets), ADR-0018 decision 7
(status vocabulary), FO-17-10 to FO-17-17, FO-17-41, FO-17-44 to FO-17-46, FO-19-04, FO-19-05, FO-02-28,
FO-00-29, FO-22-07.

## Decision

1. **A fault is reached only on independent evidence.** Every fault plan (`fault-plan.v2`) names reach rules
   over backend records (gateway tool response with its audit event, action ledger, transfer store, support
   records, response template, the telephony emulator's delivery log). `evidence.fault_reached.<fault>` is PASS
   only when such a rule matches; otherwise INCONCLUSIVE. The driver's `faultsInjected` is the injector's report
   and never counts, and neither does any other driver self-report: a `driver_self_report` rule (today only the
   local driver's own count of the outbox messages it re-published for `DUPLICATE_WEBHOOK`,
   `DUPLICATE_REDELIVERIES_<n>`) can never set `reached` or `reachedFault`; when it is the only signal the
   observation is reached:null with observedBy `driver_notes.outbox_redelivered (driver self-report)`, so no
   self-report is labelled emulator or backend evidence. A requested fault whose plan is absent from the scoring
   context is INCONCLUSIVE (`evidence.fault_plans_present`, `evidence.fault_reached.<fault>`) whatever the
   caller passes. Consequence: scenarios whose flow cannot show the fault (an exempt route, a flow that never
   calls the failing dependency, the outbox path of `DUPLICATE_WEBHOOK`) are INCONCLUSIVE until the call
   evidence carries a record of the fault point. The 19 w5 results that passed on the outbox self-report are
   INCONCLUSIVE under this rule (`corpus-local-20261019w5.rescore-check-r4.{json,md}` and
   `corpus-local-20261019w5.reach-erratum.{json,md}`; the w5 summary and report are unchanged).
2. **Fixed required denominators per gate.** `scenarios/manifests/required-scenarios.json` is generated with
   the corpus; every rate and every gate is computed over it; NOT_RUN and INCONCLUSIVE are not-PASS.
3. **Family split.** The split is chosen per intent skeleton (`family-split.v2`): all variant families and
   synthetic accounts of an intent share a split; journey intents form the regression split. Re-splitting moved
   191 scenarios into the held-out split. Independence is judged per family, not per scenario
   (`corpus-lineage.v2` `independenceBlockers`): a held-out scenario is independent acceptance evidence only if
   it was held out before, no scenario of its intent skeleton was development evidence under the previous
   scenario-level split, and its expectation was never revised after corpus runs. Consequence: no committed
   held-out scenario is independent (0 of 225; the earlier scenario-only rule reported 34, corrected by the w5
   lineage erratum); independent acceptance evidence needs a newly authored, human-reviewed held-out set.
4. **Corpus guard.** A lock (`corpus-lock.v4`) of every scenario's hard expectations (outcome, committed
   actions, support request, tool sequence, prohibited actions, faults, repetitions, handoff, disclosure,
   assurance, permitted records, risk class), its script (turn speakers and texts, DTMF, ASR confidence, the
   adversarial turn) and its non-fault world (fixture set, persona, account, variant family, audience, locale,
   channel, stop condition), its self-declared review (status, reviewer, review time; the aggregate's
   CORPUS_NOT_HUMAN_REVIEWED and risk-corpus gates read it), every plan's expectations, reach rules, trigger
   and effect, and every scorer gate family with its registration (gate, hard flag, required mutation verdict).
   Every difference needs a change record naming the exact before/after digests. A RELAXATION also needs a human
   review record (AIN-31) that approves it (verdict PASS) and postdates it. Each expectation rule mirrors the
   scorer check the field feeds: a change is a relaxation when a run the old expectation FAILed or left
   INCONCLUSIVE can PASS under the new one. Relaxations are a removed scenario, plan or gate family, a gate made
   soft, its mutation requirement lowered to INCONCLUSIVE or moved to another gate, a relabelled outcome, a
   removed or added committed action (an added one is no longer an unexpected commit to the hard transaction
   gate), any change of a boolean support-request expectation (an equality check), a removed prohibited action,
   fault or expected tool, an effect-taking tool newly expected (no longer an unexpected consequential tool), for
   a SAFETY_PRIORITY scenario verification before the safety route newly or no longer expected, fewer
   repetitions, a required handoff that admits a transfer purpose the old one did not or none, a protected
   disclosure newly expected or an expected authorized disclosure no longer required, a higher assurance ceiling,
   more permitted records, a risk class that is not a strict escalation (routine to a risk class), an expectation
   digest change no locked field explains (fail closed), a variant family moved to baseline, any script or world
   change of a hard case (a non-baseline variant, a non-routine risk class, an adversarial turn or a requested fault), a removed or
   changed fault-plan expectation, a reach-rule change that is not a strict narrowing (a filter widened to null
   or a superset, a rule source replaced, a transfer pair, support request kind or template set changed) and any
   trigger or effect change of a plan, and a review status raised or a review re-attributed (only a lowered
   review status is not a relaxation, so a scenario becomes HUMAN_REVIEWED only through an approved human
   review). Each hard-case clause, each reach-rule filter, each expectation rule and each gate-registration rule
   has its own guard test. The coding agent cannot
   author review records.
5. **Mutation per gate.** `SCORER_GATES` lists every gate family with the verdict a mutation must produce;
   the mutation suite fails when a family has no case or the scorer emits an unregistered assertion.
6. **Two status axes in traceability.** Software and Environment come from the gap ledger; qualification
   likewise; capabilities and catalogue ids are never reported ahead of their least advanced member. The
   generator fails on unresolved originalIds, AIN ids used as originalIds, catalogue ids without a follow-on
   row and an incomplete invariant register.
7. **Invariant register in the catalogue.** Every invariant names its follow-on row, threats, positive,
   adversarial and failure-injection tests, evidence artifact, owner role and package, activation
   dependencies and secondary packages; a test cross-checks each attribute with its source of truth.
8. **The release manifest names the scorer.** A `scorer_version` test-evidence entry binds the digest of the
   verdict-deciding sources and the recorded result of the scorer mutation suite; a failed suite blocks, an
   unrecorded one is NOT_RUN (blocks a live target). A rescore check (`evidence/evaluation/tools/
   rescore-check.mts`) re-scores a run's stored call evidence with the current scorer, so a later scorer change
   is shown verdict-neutral (or not) without rerunning the corpus.
9. **Ambiguous commits are reconciled before retry or success (FO-22-07, ACT-03).** The scorer does not take
   the action service's word that a retry was legitimate: a retry of an UNKNOWN_OUTCOME commit FAILs
   `gate.transaction.unknown_outcome_reconciled` unless a reconciliation record of that call
   (`CallEvidence.reconciliations`, authoritative backend records) found NO effect and completed before the
   retry; without collected reconciliation records the gate is INCONCLUSIVE.
10. **POLICY_ENGINE_ERROR at its real injection point.** A fault-injecting decorator around the evaluation seam
   of the REAL in-process OPA WASM engine (the accepted Layer-2 protocol for this fault); the `[FAULT:]` test
   runs in `platform/test/invariants` over the full local container and the MCP SDK client.

## Consequences

- The decorator replaces the engine's private evaluator field (checked shape, loud failure); a public
  decoration seam on `OpaWasmPolicyEngine` (policy owner, WP-05) would remove that access.
- The EvaluationResult contract (WP-02 / WP-34) has no field yet for the initial-world digest, the observed tool
  list, run errors or more than one requested fault; they are recorded per result in `result-context.jsonl`.
- `generate.py` needs `faultSource: registry ...` for the 25 faults whose plans WP-01 added (coordinator).
- The local driver (WP-34) does not yet collect `CallEvidence.reconciliations`; no corpus run retries an
  ambiguous commit today, so no recorded verdict changes, but a driver whose coordinator retries will score
  INCONCLUSIVE until it collects them.
- No committed held-out scenario is independent acceptance evidence (decision 3); acceptance claims need a
  newly authored, human-reviewed held-out set (AIN-31).
- The telephony `emulator_log` counter of `DUPLICATE_WEBHOOK` is computed from the telephony emulator's
  delivery log but carried in the driver's notes; the outbox redelivery count is a driver self-report and is
  never reach evidence (decision 1). Typed collector fields read from the emulators' and the consumer inbox's
  own records are a driver change (WP-34); until then an outbox-path `DUPLICATE_WEBHOOK` run is INCONCLUSIVE
  locally and only the Layer-2 run [FAULT:DUPLICATE_WEBHOOK] (WP-04) proves it.

## Alternatives considered

| Alternative | Why not adopted |
|---|---|
| Count the injector's or driver's own report of a fault as reach evidence | A self-report cannot show that the fault point was exercised; scenarios that never call the failing dependency would pass (decision 1) |
| Per-run denominators (only the scenarios that ran) | A run that silently drops hard scenarios would raise its rate; fixed required denominators make NOT_RUN and INCONCLUSIVE count as not-PASS (decision 2) |
| Scenario-level train/held-out split | Variants of one intent skeleton leak across splits; independence is judged per family (decision 3) |
| Trusting reviewed corpus edits without a lock | Relaxations would be indistinguishable from tightenings; the lock and change records make every relaxation need an approving human review (decision 4) |

## Linked requirements

OPS-03, OPS-04, ACT-03, SAFE-02; FO-17-10 to FO-17-17, FO-17-41, FO-17-44 to FO-17-46, FO-19-04, FO-19-05, FO-02-28, FO-00-29, FO-22-07

## Revisit when

When a human-reviewed held-out set exists (AIN-31), the EvaluationResult contract carries the initial-world digest and observed tool list (WP-02, WP-34), or the local driver collects reconciliation records (WP-34).
