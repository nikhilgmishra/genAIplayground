# corpus-local-20261019w5: held-out independence erratum

> **LOCAL FIXTURE — SYNTHETIC DATA — NOT PRODUCTION. Erratum to the held-out independence line of a committed combined run summary (analysis only; the summary and its report are unchanged).**

The summary records **34 of 225** held-out scenarios as independent acceptance evidence (rule: held out now and under `scenario-split.v1`). That rule ignored the intent family. With the family rule of `corpus-lineage.v2` the count is **0 of 225**.

| Blocker (among held-out scenarios) | Scenarios |
|---|---|
| `MOVED_INTO_HELDOUT` | 191 |
| `INTENT_FAMILY_EXPOSED` | 225 |
| `REVISED_AFTER_RUNS` | 35 |

Of the 34 scenarios the old rule counted: 34 belong to an intent skeleton with development members under `scenario-split.v1` (`INTENT_FAMILY_EXPOSED`) and 7 were revised after corpus runs (`REVISED_AFTER_RUNS`). The old rule reproduces the recorded count from the committed lineage.

Held-out results of this run are reported as results, not as independent acceptance evidence. Independent acceptance evidence needs held-out families that were never development or tuning evidence and whose expectations were not revised after runs (a newly authored, human-reviewed held-out set; AIN-31).

| Scenario | Version | Intent | Blockers |
|---|---|---|---|
| `scn_accessibility_long_pauses__baseline` | 1 | accessibility_long_pauses | INTENT_FAMILY_EXPOSED |
| `scn_appointment_cancel__dependency_failure` | 2 | appointment_cancel | INTENT_FAMILY_EXPOSED, REVISED_AFTER_RUNS |
| `scn_appointment_cancel__interrupted_or_noisy` | 2 | appointment_cancel | INTENT_FAMILY_EXPOSED, REVISED_AFTER_RUNS |
| `scn_appointment_cancel__malicious_instruction` | 2 | appointment_cancel | INTENT_FAMILY_EXPOSED, REVISED_AFTER_RUNS |
| `scn_appointment_cancel__verification_failure` | 2 | appointment_cancel | INTENT_FAMILY_EXPOSED, REVISED_AFTER_RUNS |
| `scn_appointment_lookup__verification_failure` | 1 | appointment_lookup | INTENT_FAMILY_EXPOSED |
| `scn_complaint_intake__dependency_failure` | 1 | complaint_intake | INTENT_FAMILY_EXPOSED |
| `scn_interpreter_request__dependency_failure` | 1 | interpreter_request | INTENT_FAMILY_EXPOSED |
| `scn_interpreter_request__interrupted_or_noisy` | 1 | interpreter_request | INTENT_FAMILY_EXPOSED |
| `scn_new_client_intake__frustrated` | 1 | new_client_intake | INTENT_FAMILY_EXPOSED |
| `scn_new_client_intake__verification_failure` | 1 | new_client_intake | INTENT_FAMILY_EXPOSED |
| `scn_partner_case_follow_up__dependency_failure` | 2 | partner_case_follow_up | INTENT_FAMILY_EXPOSED, REVISED_AFTER_RUNS |
| `scn_partner_case_follow_up__verification_failure` | 2 | partner_case_follow_up | INTENT_FAMILY_EXPOSED, REVISED_AFTER_RUNS |
| `scn_partner_intake__baseline` | 1 | partner_intake | INTENT_FAMILY_EXPOSED |
| `scn_payout_destination_change__frustrated` | 1 | payout_destination_change | INTENT_FAMILY_EXPOSED |
| `scn_payout_destination_change__malicious_instruction` | 1 | payout_destination_change | INTENT_FAMILY_EXPOSED |
| `scn_provider_clinical_records_request__dependency_failure` | 1 | provider_clinical_records_request | INTENT_FAMILY_EXPOSED |
| `scn_provider_tax_info_change__indirect_or_ambiguous` | 1 | provider_tax_info_change | INTENT_FAMILY_EXPOSED |
| `scn_provider_tax_info_change__verification_failure` | 1 | provider_tax_info_change | INTENT_FAMILY_EXPOSED |
| `scn_remittance_lookup__repeat_contact_or_handoff` | 1 | remittance_lookup | INTENT_FAMILY_EXPOSED |
| `scn_risk_audit_outage_008` | 1 | appointment_cancel | INTENT_FAMILY_EXPOSED |
| `scn_risk_audit_outage_016` | 1 | partner_intake | INTENT_FAMILY_EXPOSED |
| `scn_risk_audit_outage_018` | 1 | partner_intake | INTENT_FAMILY_EXPOSED |
| `scn_risk_audit_outage_020` | 1 | new_client_intake | INTENT_FAMILY_EXPOSED |
| `scn_risk_audit_outage_021` | 1 | new_client_intake | INTENT_FAMILY_EXPOSED |
| `scn_risk_auth_gate_string_values_031` | 2 | appointment_lookup | INTENT_FAMILY_EXPOSED, REVISED_AFTER_RUNS |
| `scn_risk_cross_account_004` | 1 | cross_account_request | INTENT_FAMILY_EXPOSED |
| `scn_risk_cross_account_020` | 1 | cross_account_request | INTENT_FAMILY_EXPOSED |
| `scn_risk_cross_account_022` | 1 | cross_account_request | INTENT_FAMILY_EXPOSED |
| `scn_risk_dial_target_injection_015` | 1 | interpreter_request | INTENT_FAMILY_EXPOSED |
| `scn_risk_dial_target_injection_018` | 1 | interpreter_request | INTENT_FAMILY_EXPOSED |
| `scn_risk_duplicate_webhook_006` | 1 | complaint_intake | INTENT_FAMILY_EXPOSED |
| `scn_risk_otp_leakage_001` | 1 | appointment_lookup | INTENT_FAMILY_EXPOSED |
| `scn_risk_prompt_injection_speech_014` | 1 | appointment_lookup | INTENT_FAMILY_EXPOSED |

Command: `cd platform && npx tsx ../evidence/evaluation/tools/lineage-erratum.mts --summary corpus-local-20261019w5 --json <file> --md <file>`.
