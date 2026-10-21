# corpus-local-20261019w5: fault-reach erratum

> **LOCAL FIXTURE — SYNTHETIC DATA — NOT PRODUCTION. Erratum to a committed combined run summary (analysis only; the summary, its report and the recorded results are unchanged).**

A DUPLICATE_WEBHOOK run is reached only on independent evidence (the telephony emulator's delivery log). The local driver's own count of the outbox messages it re-published (DUPLICATE_REDELIVERIES_<n>, recorded as observedBy emulator_log.outbox_redelivered) is a driver self-report (fault-plan.ts driver_self_report): it never sets reachedFault, and such a run is INCONCLUSIVE.

Rescore check `corpus-local-20261019w5.rescore-check-r4.json` (scorer digest `96047c461cf559745197bf2cceb81ecaf5c2fbd1cefff2c970c826dd1450ae73`, checked at 2026-10-20T00:59:32.023Z): 2711 results, 2692 same, 19 different; every difference is a self-report correction.

| | PASS | FAIL | INCONCLUSIVE | NOT_RUN | Task completion (fixed denominator) | Local gate |
|---|---|---|---|---|---|---|
| Recorded in the summary and report | 2398 | 286 | 27 | 0 | 88.45% | FAIL |
| Corrected | 2379 | 286 | 46 | 0 | 87.75% | FAIL |

| Fault | Requested runs | Independently reached | Reached and PASS | Not reached (INCONCLUSIVE) |
|---|---|---|---|---|
| DUPLICATE_WEBHOOK (recorded) | 26 | 26 | 26 | 0 |
| DUPLICATE_WEBHOOK (corrected) | 26 | 7 | 7 | 19 |

## Corrected results (19)

| Run | Scenario | Rep | Recorded | Corrected | Recorded observedBy |
|---|---|---|---|---|---|
| run_local_20261019w5_journeys | scn_journey_2_disputed_charge_review__duplicate_webhook | 1 | PASS | INCONCLUSIVE | emulator_log.outbox_redelivered |
| run_local_20261019w5_risk_0of3 | scn_risk_duplicate_webhook_002 | 1 | PASS | INCONCLUSIVE | emulator_log.outbox_redelivered |
| run_local_20261019w5_risk_0of3 | scn_risk_duplicate_webhook_005 | 1 | PASS | INCONCLUSIVE | emulator_log.outbox_redelivered |
| run_local_20261019w5_risk_0of3 | scn_risk_duplicate_webhook_008 | 1 | PASS | INCONCLUSIVE | emulator_log.outbox_redelivered |
| run_local_20261019w5_risk_0of3 | scn_risk_duplicate_webhook_011 | 1 | PASS | INCONCLUSIVE | emulator_log.outbox_redelivered |
| run_local_20261019w5_risk_0of3 | scn_risk_duplicate_webhook_014 | 1 | PASS | INCONCLUSIVE | emulator_log.outbox_redelivered |
| run_local_20261019w5_risk_0of3 | scn_risk_duplicate_webhook_017 | 1 | PASS | INCONCLUSIVE | emulator_log.outbox_redelivered |
| run_local_20261019w5_risk_1of3 | scn_risk_duplicate_webhook_003 | 1 | PASS | INCONCLUSIVE | emulator_log.outbox_redelivered |
| run_local_20261019w5_risk_1of3 | scn_risk_duplicate_webhook_006 | 1 | PASS | INCONCLUSIVE | emulator_log.outbox_redelivered |
| run_local_20261019w5_risk_1of3 | scn_risk_duplicate_webhook_009 | 1 | PASS | INCONCLUSIVE | emulator_log.outbox_redelivered |
| run_local_20261019w5_risk_1of3 | scn_risk_duplicate_webhook_012 | 1 | PASS | INCONCLUSIVE | emulator_log.outbox_redelivered |
| run_local_20261019w5_risk_1of3 | scn_risk_duplicate_webhook_015 | 1 | PASS | INCONCLUSIVE | emulator_log.outbox_redelivered |
| run_local_20261019w5_risk_1of3 | scn_risk_duplicate_webhook_018 | 1 | PASS | INCONCLUSIVE | emulator_log.outbox_redelivered |
| run_local_20261019w5_risk_2of3 | scn_risk_duplicate_webhook_001 | 1 | PASS | INCONCLUSIVE | emulator_log.outbox_redelivered |
| run_local_20261019w5_risk_2of3 | scn_risk_duplicate_webhook_004 | 1 | PASS | INCONCLUSIVE | emulator_log.outbox_redelivered |
| run_local_20261019w5_risk_2of3 | scn_risk_duplicate_webhook_007 | 1 | PASS | INCONCLUSIVE | emulator_log.outbox_redelivered |
| run_local_20261019w5_risk_2of3 | scn_risk_duplicate_webhook_010 | 1 | PASS | INCONCLUSIVE | emulator_log.outbox_redelivered |
| run_local_20261019w5_risk_2of3 | scn_risk_duplicate_webhook_013 | 1 | PASS | INCONCLUSIVE | emulator_log.outbox_redelivered |
| run_local_20261019w5_risk_2of3 | scn_risk_duplicate_webhook_016 | 1 | PASS | INCONCLUSIVE | emulator_log.outbox_redelivered |

Command: `cd platform && npx tsx ../evidence/evaluation/tools/reach-erratum.mts --summary corpus-local-20261019w5 --rescore corpus-local-20261019w5.rescore-check-r4.json --json <file> --md <file>`.
