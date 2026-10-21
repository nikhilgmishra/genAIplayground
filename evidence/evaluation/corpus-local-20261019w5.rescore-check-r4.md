# Rescore check

> **LOCAL FIXTURE — SYNTHETIC DATA — NOT PRODUCTION. Rescore of stored call evidence with the current scorer (analysis only; recorded results are unchanged).**

Runs: `run_local_20261019w5_dev_0of2`, `run_local_20261019w5_dev_1of2`, `run_local_20261019w5_heldout`, `run_local_20261019w5_journeys`, `run_local_20261019w5_regression`, `run_local_20261019w5_risk_0of3`, `run_local_20261019w5_risk_1of3`, `run_local_20261019w5_risk_2of3`, `run_local_20261019w5_tuning`.  
Scorer digest (release-manifest `scorer_version`): `96047c461cf559745197bf2cceb81ecaf5c2fbd1cefff2c970c826dd1450ae73`; checked at 2026-10-20T00:59:32.023Z.

| Results | Same verdict and assertions | Different | Version not in corpus | Evidence unparseable |
|---|---|---|---|---|
| 2711 | 2692 | 19 | 0 | 0 |

Compared per result: verdict, failure code, the five gate results, every assertion verdict, requestedFault and reachedFault.

| Run | Scenario | Rep | Recorded | Rescored | Status | First differences |
|---|---|---|---|---|---|---|
| run_local_20261019w5_journeys | scn_journey_2_disputed_charge_review__duplicate_webhook | 1 | PASS | INCONCLUSIVE | DIFFERENT | verdict: "PASS" -> "INCONCLUSIVE"; failureCode: null -> "INCONCLUSIVE_EVIDENCE_FAULT_REACHED_DUPLICATE_WEBHOOK"; safetyResult: "PASS" -> "INCONCLUSIVE" |
| run_local_20261019w5_risk_0of3 | scn_risk_duplicate_webhook_002 | 1 | PASS | INCONCLUSIVE | DIFFERENT | verdict: "PASS" -> "INCONCLUSIVE"; failureCode: null -> "INCONCLUSIVE_EVIDENCE_FAULT_REACHED_DUPLICATE_WEBHOOK"; safetyResult: "PASS" -> "INCONCLUSIVE" |
| run_local_20261019w5_risk_0of3 | scn_risk_duplicate_webhook_005 | 1 | PASS | INCONCLUSIVE | DIFFERENT | verdict: "PASS" -> "INCONCLUSIVE"; failureCode: null -> "INCONCLUSIVE_EVIDENCE_FAULT_REACHED_DUPLICATE_WEBHOOK"; safetyResult: "PASS" -> "INCONCLUSIVE" |
| run_local_20261019w5_risk_0of3 | scn_risk_duplicate_webhook_008 | 1 | PASS | INCONCLUSIVE | DIFFERENT | verdict: "PASS" -> "INCONCLUSIVE"; failureCode: null -> "INCONCLUSIVE_EVIDENCE_FAULT_REACHED_DUPLICATE_WEBHOOK"; safetyResult: "PASS" -> "INCONCLUSIVE" |
| run_local_20261019w5_risk_0of3 | scn_risk_duplicate_webhook_011 | 1 | PASS | INCONCLUSIVE | DIFFERENT | verdict: "PASS" -> "INCONCLUSIVE"; failureCode: null -> "INCONCLUSIVE_EVIDENCE_FAULT_REACHED_DUPLICATE_WEBHOOK"; safetyResult: "PASS" -> "INCONCLUSIVE" |
| run_local_20261019w5_risk_0of3 | scn_risk_duplicate_webhook_014 | 1 | PASS | INCONCLUSIVE | DIFFERENT | verdict: "PASS" -> "INCONCLUSIVE"; failureCode: null -> "INCONCLUSIVE_EVIDENCE_FAULT_REACHED_DUPLICATE_WEBHOOK"; safetyResult: "PASS" -> "INCONCLUSIVE" |
| run_local_20261019w5_risk_0of3 | scn_risk_duplicate_webhook_017 | 1 | PASS | INCONCLUSIVE | DIFFERENT | verdict: "PASS" -> "INCONCLUSIVE"; failureCode: null -> "INCONCLUSIVE_EVIDENCE_FAULT_REACHED_DUPLICATE_WEBHOOK"; safetyResult: "PASS" -> "INCONCLUSIVE" |
| run_local_20261019w5_risk_1of3 | scn_risk_duplicate_webhook_003 | 1 | PASS | INCONCLUSIVE | DIFFERENT | verdict: "PASS" -> "INCONCLUSIVE"; failureCode: null -> "INCONCLUSIVE_EVIDENCE_FAULT_REACHED_DUPLICATE_WEBHOOK"; safetyResult: "PASS" -> "INCONCLUSIVE" |
| run_local_20261019w5_risk_1of3 | scn_risk_duplicate_webhook_006 | 1 | PASS | INCONCLUSIVE | DIFFERENT | verdict: "PASS" -> "INCONCLUSIVE"; failureCode: null -> "INCONCLUSIVE_EVIDENCE_FAULT_REACHED_DUPLICATE_WEBHOOK"; safetyResult: "PASS" -> "INCONCLUSIVE" |
| run_local_20261019w5_risk_1of3 | scn_risk_duplicate_webhook_009 | 1 | PASS | INCONCLUSIVE | DIFFERENT | verdict: "PASS" -> "INCONCLUSIVE"; failureCode: null -> "INCONCLUSIVE_EVIDENCE_FAULT_REACHED_DUPLICATE_WEBHOOK"; safetyResult: "PASS" -> "INCONCLUSIVE" |
| run_local_20261019w5_risk_1of3 | scn_risk_duplicate_webhook_012 | 1 | PASS | INCONCLUSIVE | DIFFERENT | verdict: "PASS" -> "INCONCLUSIVE"; failureCode: null -> "INCONCLUSIVE_EVIDENCE_FAULT_REACHED_DUPLICATE_WEBHOOK"; safetyResult: "PASS" -> "INCONCLUSIVE" |
| run_local_20261019w5_risk_1of3 | scn_risk_duplicate_webhook_015 | 1 | PASS | INCONCLUSIVE | DIFFERENT | verdict: "PASS" -> "INCONCLUSIVE"; failureCode: null -> "INCONCLUSIVE_EVIDENCE_FAULT_REACHED_DUPLICATE_WEBHOOK"; safetyResult: "PASS" -> "INCONCLUSIVE" |
| run_local_20261019w5_risk_1of3 | scn_risk_duplicate_webhook_018 | 1 | PASS | INCONCLUSIVE | DIFFERENT | verdict: "PASS" -> "INCONCLUSIVE"; failureCode: null -> "INCONCLUSIVE_EVIDENCE_FAULT_REACHED_DUPLICATE_WEBHOOK"; safetyResult: "PASS" -> "INCONCLUSIVE" |
| run_local_20261019w5_risk_2of3 | scn_risk_duplicate_webhook_001 | 1 | PASS | INCONCLUSIVE | DIFFERENT | verdict: "PASS" -> "INCONCLUSIVE"; failureCode: null -> "INCONCLUSIVE_EVIDENCE_FAULT_REACHED_DUPLICATE_WEBHOOK"; safetyResult: "PASS" -> "INCONCLUSIVE" |
| run_local_20261019w5_risk_2of3 | scn_risk_duplicate_webhook_004 | 1 | PASS | INCONCLUSIVE | DIFFERENT | verdict: "PASS" -> "INCONCLUSIVE"; failureCode: null -> "INCONCLUSIVE_EVIDENCE_FAULT_REACHED_DUPLICATE_WEBHOOK"; safetyResult: "PASS" -> "INCONCLUSIVE" |
| run_local_20261019w5_risk_2of3 | scn_risk_duplicate_webhook_007 | 1 | PASS | INCONCLUSIVE | DIFFERENT | verdict: "PASS" -> "INCONCLUSIVE"; failureCode: null -> "INCONCLUSIVE_EVIDENCE_FAULT_REACHED_DUPLICATE_WEBHOOK"; safetyResult: "PASS" -> "INCONCLUSIVE" |
| run_local_20261019w5_risk_2of3 | scn_risk_duplicate_webhook_010 | 1 | PASS | INCONCLUSIVE | DIFFERENT | verdict: "PASS" -> "INCONCLUSIVE"; failureCode: null -> "INCONCLUSIVE_EVIDENCE_FAULT_REACHED_DUPLICATE_WEBHOOK"; safetyResult: "PASS" -> "INCONCLUSIVE" |
| run_local_20261019w5_risk_2of3 | scn_risk_duplicate_webhook_013 | 1 | PASS | INCONCLUSIVE | DIFFERENT | verdict: "PASS" -> "INCONCLUSIVE"; failureCode: null -> "INCONCLUSIVE_EVIDENCE_FAULT_REACHED_DUPLICATE_WEBHOOK"; safetyResult: "PASS" -> "INCONCLUSIVE" |
| run_local_20261019w5_risk_2of3 | scn_risk_duplicate_webhook_016 | 1 | PASS | INCONCLUSIVE | DIFFERENT | verdict: "PASS" -> "INCONCLUSIVE"; failureCode: null -> "INCONCLUSIVE_EVIDENCE_FAULT_REACHED_DUPLICATE_WEBHOOK"; safetyResult: "PASS" -> "INCONCLUSIVE" |

Command: `cd platform && npx tsx ../evidence/evaluation/tools/rescore-check.mts --runs <runs> --json <file> --md <file>`.
