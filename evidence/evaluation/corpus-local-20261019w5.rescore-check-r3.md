# Rescore check

> **LOCAL FIXTURE — SYNTHETIC DATA — NOT PRODUCTION. Rescore of stored call evidence with the current scorer (analysis only; recorded results are unchanged).**

Runs: `run_local_20261019w5_dev_0of2`, `run_local_20261019w5_dev_1of2`, `run_local_20261019w5_heldout`, `run_local_20261019w5_journeys`, `run_local_20261019w5_regression`, `run_local_20261019w5_risk_0of3`, `run_local_20261019w5_risk_1of3`, `run_local_20261019w5_risk_2of3`, `run_local_20261019w5_tuning`.  
Scorer digest (release-manifest `scorer_version`): `92265c0f5dc5dc1b7493df68e487c2df4ca6d43d2484f92e343ca4a269abf197`; checked at 2026-10-19T21:24:42.127Z.

| Results | Same verdict and assertions | Different | Version not in corpus | Evidence unparseable |
|---|---|---|---|---|
| 2711 | 2711 | 0 | 0 | 0 |

Compared per result: verdict, failure code, the five gate results, every assertion verdict, requestedFault and reachedFault.

Every compared result is reproduced exactly by the current scorer.

Command: `cd platform && npx tsx ../evidence/evaluation/tools/rescore-check.mts --runs <runs> --json <file> --md <file>`.
