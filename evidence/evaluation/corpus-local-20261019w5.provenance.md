# corpus-local-20261019w5: provenance

> **LOCAL FIXTURE — SYNTHETIC DATA — NOT PRODUCTION.** `executionMode: local_fixture`; LOCAL SIMULATED
> COORDINATOR (deterministic keyword rules, not a language model). Historical offline evidence (FO-01-07); it
> can never satisfy a sandbox, staging or production gate.

| Item | Value |
|---|---|
| Purpose | Fresh corpus run after fix wave 5 and the WP-01 scorer repairs (FO-01-07, FO-17-10, FO-17-12) |
| Supersedes | `corpus-local-20261018w4` (its summary, report and root-cause files are unchanged) |
| Reason code | `FIX_WAVE_5_RERUN` |
| Reruns | `run_local_20261018w4_journeys`, `_dev_0of3`, `_dev_1of3`, `_dev_2of3`, `_heldout_0of2`, `_heldout_1of2`, `_risk_0of4` to `_risk_3of4` |
| Source tree | `git archive` of commit `22763f6ffa53861bcf5d35498524f0113da99820` overlaid with the WP-01 working tree of `platform/src/evaluation/*.ts` and `scenarios/` (overlay digest `be012c565a039264`, recorded as `sourceTree` in every `run.json`; `sourceCommit` is null there because the snapshot carried no git metadata). Other packages' uncommitted work was not part of the run |
| Runs | `run_local_20261019w5_journeys`, `_dev_0of2`, `_dev_1of2`, `_tuning`, `_heldout`, `_regression`, `_risk_0of3`, `_risk_1of3`, `_risk_2of3` (`evidence/runs/`, which is git-ignored: the run directories are local; the committed record is the summary, report, root-cause and classification files) |
| Commands | `pnpm evidence run-partition --partition <p> [--shard k/n] --run-id <id> --rerun-of <w4 runs> --supersedes corpus-local-20261018w4 --reason FIX_WAVE_5_RERUN --source-tree "HEAD+overlay:be012c565a039264 ..."`; `pnpm evidence combine-runs --runs <w5 runs> --out corpus-local-20261019w5 --supersedes corpus-local-20261018w4 --reason FIX_WAVE_5_RERUN`; `npx tsx ../evidence/evaluation/tools/attribute-root-causes.mts` and `classify-root-causes.mts` (headers of both files) |
| Denominator | 2,711 required runs (`scenarios/manifests/required-scenarios.json`, digest `a78682d815a33324…`), 2,711 results, 0 excluded |
| Result | PASS 2,398, FAIL 286, INCONCLUSIVE 27, NOT_RUN 0; critical failures 0 (w4: 7); local gate FAIL; ci INCONCLUSIVE (no ci evidence); sandbox, staging, production BLOCKED |
| Held-out independence | Recorded in the summary and report: 34 of 225 (scenario-only rule of `corpus-lineage.v1`). Corrected: **0 of 225** under the family rule of `corpus-lineage.v2` (`corpus-local-20261019w5.lineage-erratum.{json,md}`); the summary and report are unchanged |

## Changes after the run

Made after the snapshot was taken; none changes a w5 verdict. This is checked, not assumed:
`corpus-local-20261019w5.rescore-check.{json,md}` re-scores all 2,711 results from the call evidence the w5
runs stored (`evidence/evaluation/tools/rescore-check.mts`) with the scorer as it stands after these changes
(scorer digest recorded in the file) and reproduces every verdict, failure code, gate result, assertion,
requestedFault and reachedFault exactly (2,711 same, 0 different).

- `scorer.ts`: `gate.audit.versions_bound` treats a version recorded as UNKNOWN or UNPINNED as unpinned
  (INCONCLUSIVE). Every w5 result recorded pinned labels, so no verdict changes.
- `manifest.ts`: unreadable migrations or an empty corpus are release blockers with placeholder digests.
- `fault-registry.ts`, `traceability.ts`, `catalog.ts`, tests and documentation (not used by the run).
- `evidence/evaluation/tools/attribute-root-causes.mts`: two root causes for the fault-plan.v2 reach check
  (`FAULT_NOT_REACHED_BY_EXPECTED_FLOW`, `FAULT_REACH_NOT_EVIDENCED_ON_EXEMPT_ROUTE`); the w4 attribution files
  were not regenerated.
- WP-01 refix round 2 (2026-10-19): `fault-reach.test.ts` (tests only; the reach rules are unchanged);
  `aggregate.ts` renders the language and audience latency tables that the report renderer skipped (the w5
  `report.md` therefore has six of the eight latency tables; the w5 `summary.json` holds all eight);
  `manifest.ts` binds the scorer version (`scorer_version` evidence entry); the `DUPLICATE_WEBHOOK` plan's
  `notes` text (not part of the plan digest the corpus lock and the scorer use; the corpus digest changes).
- WP-01 refix round 3 (2026-10-19):
  - Held-out independence erratum. The summary's "34 of 225 held-out scenarios are independent acceptance
    evidence" used a scenario-only rule (held out now and under `scenario-split.v1`). Every one of those 34
    belongs to an intent skeleton with development members under `scenario-split.v1`, and 7 were revised after
    corpus runs, so none is independent; `scenarios/manifests/lineage.json` (`corpus-lineage.v2`) now records
    the reasons per scenario (`independenceBlockers`) and 0 of 225. The correction is
    `corpus-local-20261019w5.lineage-erratum.{json,md}` (`evidence/evaluation/tools/lineage-erratum.mts`); the
    w5 summary and report are not edited.
  - `unknown.ts` / `scorer.ts` / `runner.ts`: a retry of an ambiguous (UNKNOWN_OUTCOME) commit now FAILs
    `gate.transaction.unknown_outcome_reconciled` unless a NOT_FOUND reconciliation of that call completed
    before it (new optional `CallEvidence.reconciliations`; INCONCLUSIVE when not collected), and such a
    legitimate retry is a fresh commit whose receipt backs RESOLVED (`gate.transaction.outcome_evidence`). No w5 result
    retried an ambiguous commit: `corpus-local-20261019w5.rescore-check-r3.{json,md}` re-scores all 2,711
    results with this scorer (digest recorded there) and reproduces every verdict (2,711 same, 0 different).
  - `corpus-guard.ts`: a review counts only when it approves the change (verdict PASS) and postdates it;
    `split.ts` unchanged; `fault-registry.ts`: suite-name grammar of the Layer-2 runner; tests only otherwise.
- WP-01 wave B2 residual fixes (2026-10-20):
  - Fault reach. The `DUPLICATE_WEBHOOK` plan (version 3) no longer counts the local driver's own number of
    re-published outbox messages (`DUPLICATE_REDELIVERIES_<n>`, recorded as observedBy
    `emulator_log.outbox_redelivered`) as reach evidence: it is a `driver_self_report` rule that never sets
    reachedFault. `corpus-local-20261019w5.rescore-check-r4.{json,md}` re-scores all 2,711 results with this
    scorer (digest recorded there): 2,692 same and 19 different, every one a `DUPLICATE_WEBHOOK` run that had
    passed on that self-report and is INCONCLUSIVE now (7 runs stay reached on the telephony emulator's log).
    The correction is `corpus-local-20261019w5.reach-erratum.{json,md}` (`evidence/evaluation/tools/
    reach-erratum.mts`): PASS 2,379, FAIL 286, INCONCLUSIVE 46 (recorded 2,398 / 286 / 27); task completion
    87.75% (recorded 88.45%); the local gate stays FAIL. The w5 summary and report are not edited.
  - `scorer.ts`: a requested fault whose plan is absent from the scoring context is INCONCLUSIVE
    (`evidence.fault_plans_present`, `evidence.fault_reached.<fault>`) whatever the caller passes as
    `missingFaultPlans`; the w5 runs scored with every plan present, so no w5 verdict changes (rescore r4).
  - Latency tables. `corpus-local-20261019w5.latency-addendum.md` (`evidence/evaluation/tools/
    latency-addendum.mts`) is the latency section of the unchanged w5 summary rendered by the current renderer
    (`aggregate.ts` `latencySectionOf`): all eight tables, the six the report has unchanged.
  - `corpus-guard.ts`: lock format `corpus-lock.v2` (script, non-fault world, reach rules, trigger and effect
    in the lock; wider relaxation classes). The lock was regenerated from the corpus after checking that the
    uncommitted `corpus-lock.v1` matched it except for the `DUPLICATE_WEBHOOK` plan change, which is recorded in
    `scenarios/changes/chg_duplicate_webhook_self_report.json`; `split.ts`: `SPLIT_SCHEME_VERSION` and the
    lineage field `splitSchemeVersion` (renamed; values unchanged). Neither changes a verdict.
  - `corpus-guard.ts`, second residual round: lock format `corpus-lock.v3` adds each scenario's self-declared
    review (status, reviewer, review time) and the REVIEW_CHANGED difference (a raised or re-attributed review
    is a relaxation). The lock was regenerated after checking that the v3 lock without the review fields equals
    the v2 lock (canonical JSON); every scenario is UNREVIEWED. No verdict changes.
  - `corpus-guard.ts`, third residual round: lock format `corpus-lock.v4` records each scorer gate family's
    registration (gate, hard flag, required mutation verdict) and the SCORER_GATE_CHANGED difference; the
    expectation rules now mirror the scorer checks in both directions (an added expected commit or effect-taking
    tool, any boolean support-request relabel, a disclosure expectation dropped, a handoff route admitting a new
    purpose, a SAFETY_PRIORITY verify-first change and an unexplained digest change are relaxations). The lock was
    regenerated after checking that the v3 lock's scenarios and fault plans equal the current corpus exactly
    (canonical JSON) and its gate family list equals the registry; only `lockVersion` and `scorerGates` changed.
    `scorer.ts` reads the shared tool predicates of `vocabulary.ts` (same behaviour). No verdict changes.
