# Local evaluation — corpus-wide aggregate (fixed required denominator)

Runs: run_local_20261019w5_dev_0of2, run_local_20261019w5_dev_1of2, run_local_20261019w5_heldout, run_local_20261019w5_journeys, run_local_20261019w5_regression, run_local_20261019w5_risk_0of3, run_local_20261019w5_risk_1of3, run_local_20261019w5_risk_2of3, run_local_20261019w5_tuning  
Execution modes: local_fixture=2711

> **Local fixture evidence only.** These results cannot satisfy sandbox, staging or production gates and are not measurements.

Fixed denominator: 2711 required runs (required-scenario manifest `a78682d815a33324…`); 2711 have a result; 0 result(s) excluded.

## Totals

| Results | Scenarios | Required | NOT_RUN | PASS | FAIL | INCONCLUSIVE | Critical | Task completion (fixed denominator) |
|---|---|---|---|---|---|---|---|---|
| 2711 | 1071 | 2711 | 0 | 2398 | 286 | 27 | 0 | 88.45% |

## Gates

| Environment | Status | Required runs | Required PASS | NOT_RUN | Eligible results | Reasons |
|---|---|---|---|---|---|---|
| local | FAIL | 2711 | 2398 | 0 | 2711 | FAILING_RESULTS: 286; INCONCLUSIVE_RESULTS: 27 |
| ci | INCONCLUSIVE | 587 | 0 | 587 | 0 | NO_ELIGIBLE_EVIDENCE: no local_fixture results recorded for ci; REQUIRED_NOT_RUN: 587 of 587 required runs |
| sandbox | BLOCKED | 2711 | 0 | 2711 | 0 | NO_ELIGIBLE_EVIDENCE: results are local_fixture; local_fixture evidence can never satisfy a sandbox gate; REQUIRED_NOT_RUN: 2711 of 2711 required runs |
| staging | BLOCKED | 2711 | 0 | 2711 | 0 | NO_ELIGIBLE_EVIDENCE: results are local_fixture; local_fixture evidence can never satisfy a staging gate; REQUIRED_NOT_RUN: 2711 of 2711 required runs |
| production | BLOCKED | 2711 | 0 | 2711 | 0 | NO_ELIGIBLE_EVIDENCE: results are local_fixture; local_fixture evidence can never satisfy a production gate; REQUIRED_NOT_RUN: 2711 of 2711 required runs |

## Critical (hard-gate) failures

None observed in this run (see uncertainty bounds below; this is not proof of zero risk).

## Uncertainty (critical failures)

| Basis | Failures | Opportunities | Clopper-Pearson 95% upper | Rule of three |
|---|---|---|---|---|
| per run | 0 | 2711 | 0.11% | 0.11% |
| per distinct scenario | 0 | 1071 | 0.28% | 0.28% |

## Routine quality and the PROPOSED goal-completion target

Routine goal completion 1249/1317 = 94.84% over the fixed required denominator (NOT_RUN and INCONCLUSIVE count as not-PASS) against the PROPOSED 95.00% target (an engineering proposal, not a legal threshold or a measurement); execution mode local_fixture; MISSES_PROPOSED_TARGET on non-measured evidence: no target is stated as met.  
Weighted task completion: — — UNKNOWN: production-frequency weights require approved traffic statistics (PRQ-046); weighted completion not computed.  
Intents below the proposed target or with critical failures: 21

## Oversampled risk sets (unweighted)

| Risk class | Required | Results | PASS | FAIL | INCONCLUSIVE | NOT_RUN | Critical |
|---|---|---|---|---|---|---|---|
| authorization | 288 | 288 | 257 | 31 | 0 | 0 | 0 |
| clinical_boundary | 240 | 240 | 240 | 0 | 0 | 0 | 0 |
| privacy | 72 | 72 | 57 | 15 | 0 | 0 | 0 |
| safety_routing | 720 | 720 | 545 | 175 | 0 | 0 | 0 |
| transaction | 74 | 74 | 50 | 9 | 15 | 0 | 0 |

## Coverage holes and unsupported steps

- Required runs not run: 0
- Intents with no passing required run: none
- Audiences with no passing run: none; locales with no passing run: none
- Faults of the fixed registry without an independently reached, passing run (local or Layer-2): 30 of 50 (ASR_FAILURE, AUTH_EXPIRY_DURING_SPEECH, AUTH_EXPIRY_IDLE, BUDGET_EXHAUSTED, CHANGED_SLOT_DURING_CONFIRMATION, CONSENT_REVOKED, CONTRADICTORY_EVENT, DELEGATION_REVOKED, DLQ_FULL, GUARDRAIL_LIMIT, JUDGE_FAILURE, LOCAL_PERSISTENCE_FAILURE, MISSING_WEBHOOK, MODEL_HANG, MODEL_OVERLOAD, MODEL_REFUSAL, POLICY_ENGINE_ERROR, QUOTA_EXHAUSTED, RECEIPT_LATE, RECEIPT_LOST, RECEIVER_DECLINED, RECORDING_REFUSED, REDACTION_FAILURE, REGIONAL_FAILOVER, SCHEMA_DRIFT, SOURCE_DELETED, SOURCE_MERGED, SOURCE_SPLIT, STALE_SOURCE, TTS_FAILURE)
- Unsupported driver steps: COORDINATOR_COULD_NOT_PARSE (1)
- Most frequent INCONCLUSIVE reasons: evidence.fault_reached (26), evidence.driver_supported (1)

| Fault | Requested runs | Independently reached | Reached and PASS | Not reached (INCONCLUSIVE) | Layer-2 run |
|---|---|---|---|---|---|
| ASR_FAILURE | 0 | 0 | 0 | 0 | UNKNOWN |
| AUDIT_OUTAGE | 25 | 10 | 10 | 15 | UNKNOWN |
| AUTH_EXPIRY_DURING_SPEECH | 0 | 0 | 0 | 0 | UNKNOWN |
| AUTH_EXPIRY_IDLE | 0 | 0 | 0 | 0 | UNKNOWN |
| AUTH_EXPIRY_MID_CALL | 1 | 1 | 1 | 0 | UNKNOWN |
| BILLING_TIMEOUT | 7 | 7 | 7 | 0 | UNKNOWN |
| BRIDGE_DROPPED | 5 | 5 | 5 | 0 | UNKNOWN |
| BUDGET_EXHAUSTED | 0 | 0 | 0 | 0 | UNKNOWN |
| CHANGED_SLOT_DURING_CONFIRMATION | 0 | 0 | 0 | 0 | UNKNOWN |
| CLAIMS_TIMEOUT | 1 | 1 | 1 | 0 | UNKNOWN |
| CONCURRENT_SAME_ACCOUNT | 1 | 1 | 1 | 0 | UNKNOWN |
| CONSENT_REVOKED | 0 | 0 | 0 | 0 | UNKNOWN |
| CONTRADICTORY_EVENT | 0 | 0 | 0 | 0 | UNKNOWN |
| CRASH_AFTER_COMMIT | 7 | 7 | 4 | 0 | UNKNOWN |
| DELEGATION_REVOKED | 0 | 0 | 0 | 0 | UNKNOWN |
| DLQ_FULL | 0 | 0 | 0 | 0 | UNKNOWN |
| DUPLICATE_WEBHOOK | 26 | 26 | 26 | 0 | UNKNOWN |
| EVENTS_OUT_OF_ORDER | 7 | 7 | 7 | 0 | UNKNOWN |
| GUARDRAIL_LIMIT | 0 | 0 | 0 | 0 | UNKNOWN |
| IDP_UNAVAILABLE | 2 | 2 | 2 | 0 | UNKNOWN |
| INTERRUPTED_CONFIRMATION | 1 | 1 | 1 | 0 | UNKNOWN |
| JUDGE_FAILURE | 0 | 0 | 0 | 0 | UNKNOWN |
| KNOWLEDGE_STALE | 8 | 8 | 8 | 0 | UNKNOWN |
| LOCAL_PERSISTENCE_FAILURE | 0 | 0 | 0 | 0 | UNKNOWN |
| MISSING_WEBHOOK | 0 | 0 | 0 | 0 | UNKNOWN |
| MODEL_HANG | 0 | 0 | 0 | 0 | UNKNOWN |
| MODEL_OVERLOAD | 0 | 0 | 0 | 0 | UNKNOWN |
| MODEL_REFUSAL | 0 | 0 | 0 | 0 | UNKNOWN |
| NOTIFICATION_PROVIDER_DOWN | 1 | 1 | 1 | 0 | UNKNOWN |
| PARTIAL_WRITE | 6 | 6 | 3 | 0 | UNKNOWN |
| POLICY_ENGINE_ERROR | 7 | 7 | 0 | 0 | UNKNOWN |
| PROVIDER_API_TIMEOUT | 5 | 5 | 5 | 0 | UNKNOWN |
| QUOTA_EXHAUSTED | 5 | 0 | 0 | 5 | UNKNOWN |
| RECEIPT_LATE | 0 | 0 | 0 | 0 | UNKNOWN |
| RECEIPT_LOST | 0 | 0 | 0 | 0 | UNKNOWN |
| RECEIVER_DECLINED | 0 | 0 | 0 | 0 | UNKNOWN |
| RECEIVER_UNAVAILABLE | 31 | 31 | 31 | 0 | UNKNOWN |
| RECORDING_REFUSED | 0 | 0 | 0 | 0 | UNKNOWN |
| REDACTION_FAILURE | 0 | 0 | 0 | 0 | UNKNOWN |
| REGIONAL_FAILOVER | 0 | 0 | 0 | 0 | UNKNOWN |
| SALESFORCE_OUTAGE | 15 | 9 | 9 | 6 | UNKNOWN |
| SCHEDULING_TIMEOUT_AFTER_COMMIT | 10 | 10 | 4 | 0 | UNKNOWN |
| SCHEDULING_UNAVAILABLE | 3 | 3 | 3 | 0 | UNKNOWN |
| SCHEMA_DRIFT | 0 | 0 | 0 | 0 | UNKNOWN |
| SOURCE_DELETED | 0 | 0 | 0 | 0 | UNKNOWN |
| SOURCE_MERGED | 0 | 0 | 0 | 0 | UNKNOWN |
| SOURCE_SPLIT | 0 | 0 | 0 | 0 | UNKNOWN |
| STALE_SOURCE | 0 | 0 | 0 | 0 | UNKNOWN |
| TRANSFER_FAILED | 30 | 30 | 30 | 0 | UNKNOWN |
| TTS_FAILURE | 0 | 0 | 0 | 0 | UNKNOWN |

## Latency by slice

Turn latencies on the simulated clock (local fixture FakeClock: they are not real-time or handset latencies). Intervals are distribution-free 95% order-statistic intervals that assume independent samples; turns of one call and repetitions of one scenario are not independent, and null bounds mean the sample is too small.

### intent

| Key | Calls | Samples | Missing observations | p50 ms [95% CI] | p95 ms [95% CI] | p99 ms [95% CI] |
|---|---|---|---|---|---|---|
| accessibility_long_pauses | 16 | 123 | 0 | 5 [2, 10] | 57 [46, 145] | 77 [70, ?] |
| accessibility_slower_speech | 16 | 90 | 0 | 8 [3, 15] | 77 [64, ?] | 287 [86, ?] |
| account_enumeration_probe | 40 | 146 | 0 | 22 [16, 31] | 68 [64, 126] | 126 [74, ?] |
| after_hours_callback_request | 22 | 91 | 0 | 17 [7, 43] | 114 [89, ?] | 137 [115, ?] |
| appointment_cancel | 19 | 151 | 0 | 2 [2, 7] | 96 [87, 119] | 119 [112, ?] |
| appointment_create | 25 | 190 | 0 | 44 [35, 51] | 170 [131, 212] | 274 [187, ?] |
| appointment_lookup | 74 | 317 | 0 | 39 [33, 43] | 91 [79, 120] | 132 [120, ?] |
| appointment_reschedule | 31 | 237 | 0 | 50 [42, 56] | 178 [137, 349] | 370 [328, ?] |
| appointment_slot_conflict | 22 | 199 | 0 | 59 [49, 70] | 124 [117, 138] | 148 [130, ?] |
| billing_dispute | 26 | 196 | 0 | 40 [23, 46] | 158 [140, 221] | 222 [183, ?] |
| caller_id_assertion | 16 | 104 | 0 | 8 [2, 35] | 75 [60, ?] | 111 [81, ?] |
| case_follow_up | 52 | 232 | 0 | 41 [37, 44] | 77 [71, 99] | 117 [97, ?] |
| claim_status | 22 | 112 | 0 | 38 [29, 43] | 106 [75, 177] | 140 [113, ?] |
| clinical_question_redirect | 160 | 270 | 0 | 62 [54, 79] | 141 [129, 164] | 216 [164, ?] |
| clinical_records_request | 16 | 58 | 0 | 2 [2, 9] | 85 [68, ?] | 92 [79, ?] |
| complaint_intake | 22 | 92 | 0 | 14 [3, 54] | 112 [85, ?] | 132 [124, ?] |
| contact_details_change | 16 | 58 | 0 | 3 [2, 9] | 84 [77, ?] | 180 [82, ?] |
| credentialing_decision_request | 16 | 88 | 0 | 47 [36, 54] | 119 [94, ?] | 159 [127, ?] |
| credentialing_document_status | 16 | 88 | 0 | 31 [8, 42] | 79 [60, ?] | 113 [82, ?] |
| cross_account_request | 40 | 184 | 0 | 25 [21, 40] | 90 [85, 105] | 108 [96, ?] |
| delegated_practice_remittance | 17 | 93 | 0 | 37 [32, 43] | 90 [80, ?] | 145 [91, ?] |
| expired_proxy_access | 36 | 168 | 0 | 40 [34, 46] | 94 [78, 121] | 121 [102, ?] |
| faq_hours | 251 | 641 | 0 | 72 [69, 75] | 145 [139, 161] | 184 [177, 221] |
| faq_insurance_accepted | 16 | 74 | 0 | 22 [7, 31] | 63 [52, ?] | 228 [63, ?] |
| faq_services_overview | 16 | 74 | 0 | 8 [2, 43] | 120 [91, ?] | 160 [120, ?] |
| frustration_idiom_billing | 40 | 180 | 0 | 42 [37, 48] | 119 [94, 160] | 182 [134, ?] |
| human_request | 92 | 212 | 0 | 10 [8, 51] | 115 [93, 166] | 175 [155, ?] |
| interpreter_request | 58 | 145 | 0 | 16 [11, 50] | 120 [96, 198] | 198 [164, ?] |
| invoice_explanation | 74 | 331 | 0 | 38 [31, 41] | 95 [88, 103] | 137 [103, ?] |
| late_cancellation_fee_question | 16 | 88 | 0 | 31 [9, 42] | 87 [62, ?] | 112 [98, ?] |
| medication_question_redirect | 160 | 310 | 0 | 81 [70, 86] | 157 [144, 207] | 227 [198, ?] |
| new_client_intake | 22 | 91 | 0 | 42 [25, 46] | 115 [88, ?] | 164 [126, ?] |
| notification_opt_out | 16 | 74 | 0 | 7 [2, 41] | 83 [59, ?] | 93 [83, ?] |
| otp_read_aloud_attempt | 16 | 90 | 0 | 29 [8, 37] | 81 [63, ?] | 123 [87, ?] |
| partner_case_follow_up | 16 | 88 | 0 | 32 [8, 36] | 70 [54, ?] | 134 [71, ?] |
| partner_contract_question | 16 | 73 | 0 | 19 [5, 43] | 103 [83, ?] | 120 [103, ?] |
| partner_employee_treatment_status | 41 | 188 | 0 | 36 [26, 42] | 106 [88, 146] | 170 [123, ?] |
| partner_intake | 22 | 111 | 0 | 40 [9, 52] | 108 [88, 164] | 149 [108, ?] |
| payer_bulk_patient_search | 16 | 74 | 0 | 16 [2, 23] | 57 [49, ?] | 85 [57, ?] |
| payer_claim_inquiry | 16 | 74 | 0 | 22 [2, 44] | 78 [69, ?] | 102 [78, ?] |
| payment_page_request | 16 | 74 | 0 | 14 [3, 27] | 54 [46, ?] | 117 [54, ?] |
| payout_destination_change | 16 | 73 | 0 | 8 [5, 39] | 96 [74, ?] | 110 [96, ?] |
| portal_account_locked | 16 | 74 | 0 | 6 [2, 45] | 102 [80, ?] | 121 [102, ?] |
| portal_login_help | 16 | 74 | 0 | 16 [2, 28] | 62 [50, ?] | 98 [62, ?] |
| practice_staff_case_status | 16 | 88 | 0 | 34 [10, 40] | 81 [69, ?] | 103 [83, ?] |
| provider_clinical_records_request | 16 | 73 | 0 | 17 [4, 42] | 104 [85, ?] | 138 [104, ?] |
| provider_onboarding_status | 16 | 88 | 0 | 31 [9, 41] | 85 [63, ?] | 106 [91, ?] |
| provider_schedule_lookup | 16 | 88 | 0 | 32 [11, 39] | 81 [64, ?] | 101 [81, ?] |
| provider_tax_info_change | 16 | 73 | 0 | 21 [3, 44] | 104 [84, ?] | 159 [104, ?] |
| provider_unrelated_client_lookup | 16 | 88 | 0 | 30 [10, 37] | 78 [61, ?] | 131 [79, ?] |
| recording_declined | 17 | 77 | 0 | 3 [2, 4] | 60 [42, ?] | 85 [60, ?] |
| relay_service_caller | 16 | 104 | 0 | 11 [4, 36] | 71 [58, ?] | 96 [73, ?] |
| remittance_lookup | 16 | 88 | 0 | 34 [20, 40] | 80 [68, ?] | 155 [85, ?] |
| repeat_caller_resume_issue | 17 | 93 | 0 | 35 [11, 41] | 79 [72, ?] | 125 [94, ?] |
| representative_minor_access | 36 | 131 | 0 | 38 [7, 51] | 143 [123, 256] | 181 [145, ?] |
| role_switch_mid_call | 40 | 208 | 0 | 42 [40, 47] | 83 [73, 115] | 117 [96, ?] |
| safety_disclosure_self | 299 | 482 | 0 | 119 [112, 124] | 216 [204, 240] | 295 [247, ?] |
| safety_disclosure_spanish | 130 | 230 | 0 | 106 [50, 112] | 193 [179, 240] | 258 [218, ?] |
| safety_disclosure_third_party | 162 | 296 | 0 | 112 [65, 116] | 211 [187, 234] | 271 [234, ?] |
| safety_mid_billing_call | 40 | 180 | 0 | 44 [38, 51] | 180 [156, 213] | 230 [193, ?] |
| shared_device_recap | 16 | 104 | 0 | 7 [5, 39] | 69 [61, ?] | 82 [73, ?] |
| superbill_request | 19 | 99 | 0 | 40 [24, 51] | 145 [94, ?] | 236 [149, ?] |
| telehealth_link_help | 16 | 74 | 0 | 8 [4, 31] | 71 [55, ?] | 122 [71, ?] |
| therapy_request_redirect | 40 | 110 | 0 | 4 [2, 10] | 88 [75, 216] | 108 [91, ?] |
| third_party_caller_inquiry | 16 | 74 | 0 | 25 [19, 29] | 79 [52, ?] | 108 [79, ?] |
| unsupported_language | 47 | 105 | 0 | 5 [2, 50] | 84 [75, ?] | 105 [85, ?] |

### assurance

| Key | Calls | Samples | Missing observations | p50 ms [95% CI] | p95 ms [95% CI] | p99 ms [95% CI] |
|---|---|---|---|---|---|---|
| A0 | 1793 | 4542 | 0 | 40 [37, 42] | 158 [154, 164] | 223 [215, 234] |
| A2 | 818 | 4101 | 0 | 37 [36, 39] | 103 [99, 109] | 156 [145, 167] |
| A3 | 100 | 810 | 0 | 47 [44, 51] | 150 [137, 172] | 274 [212, 393] |

### model

| Key | Calls | Samples | Missing observations | p50 ms [95% CI] | p95 ms [95% CI] | p99 ms [95% CI] |
|---|---|---|---|---|---|---|
| local-fixture-model | 2711 | 9453 | 0 | 39 [38, 40] | 140 [137, 145] | 208 [201, 218] |

### voice

| Key | Calls | Samples | Missing observations | p50 ms [95% CI] | p95 ms [95% CI] | p99 ms [95% CI] |
|---|---|---|---|---|---|---|
| local-fixture-voice | 2711 | 9453 | 0 | 39 [38, 40] | 140 [137, 145] | 208 [201, 218] |

### load

| Key | Calls | Samples | Missing observations | p50 ms [95% CI] | p95 ms [95% CI] | p99 ms [95% CI] |
|---|---|---|---|---|---|---|
| single_call_no_concurrency | 2711 | 9453 | 0 | 39 [38, 40] | 140 [137, 145] | 208 [201, 218] |

### region

| Key | Calls | Samples | Missing observations | p50 ms [95% CI] | p95 ms [95% CI] | p99 ms [95% CI] |
|---|---|---|---|---|---|---|
| local_process | 2711 | 9453 | 0 | 39 [38, 40] | 140 [137, 145] | 208 [201, 218] |

## Verified resolution and containment (reported separately)

Verified resolution: 65/2711 (2.40%). Containment: 882/2711 (32.53%), of which without verified resolution: 817. Missed required handoffs (hard-gate failures): 0.  
Containment is never a success measure and feeds no gate, completion rate or target.

| Intent | Runs | Verified resolution | Contained | Contained without verified resolution | Missed required handoff |
|---|---|---|---|---|---|
| accessibility_long_pauses | 16 | 0.00% | 87.50% | 14 | 0 |
| accessibility_slower_speech | 16 | 0.00% | 87.50% | 14 | 0 |
| account_enumeration_probe | 40 | 0.00% | 97.50% | 39 | 0 |
| after_hours_callback_request | 22 | 0.00% | 81.82% | 18 | 0 |
| appointment_cancel | 19 | 0.00% | 0.00% | 0 | 0 |
| appointment_create | 25 | 80.00% | 80.00% | 0 | 0 |
| appointment_lookup | 74 | 0.00% | 83.78% | 62 | 0 |
| appointment_reschedule | 31 | 80.65% | 80.65% | 0 | 0 |
| appointment_slot_conflict | 22 | 90.91% | 90.91% | 0 | 0 |
| billing_dispute | 26 | 0.00% | 76.92% | 20 | 0 |
| caller_id_assertion | 16 | 0.00% | 81.25% | 13 | 0 |
| case_follow_up | 52 | 0.00% | 96.15% | 50 | 0 |
| claim_status | 22 | 0.00% | 86.36% | 19 | 0 |
| clinical_question_redirect | 160 | 0.00% | 0.00% | 0 | 0 |
| clinical_records_request | 16 | 0.00% | 0.00% | 0 | 0 |
| complaint_intake | 22 | 0.00% | 81.82% | 18 | 0 |
| contact_details_change | 16 | 0.00% | 0.00% | 0 | 0 |
| credentialing_decision_request | 16 | 0.00% | 87.50% | 14 | 0 |
| credentialing_document_status | 16 | 0.00% | 81.25% | 13 | 0 |
| cross_account_request | 40 | 0.00% | 92.50% | 37 | 0 |
| delegated_practice_remittance | 17 | 0.00% | 82.35% | 14 | 0 |
| expired_proxy_access | 36 | 0.00% | 91.67% | 33 | 0 |
| faq_hours | 251 | 0.00% | 3.59% | 9 | 0 |
| faq_insurance_accepted | 16 | 0.00% | 87.50% | 14 | 0 |
| faq_services_overview | 16 | 0.00% | 0.00% | 0 | 0 |
| frustration_idiom_billing | 40 | 0.00% | 50.00% | 20 | 0 |
| human_request | 92 | 0.00% | 0.00% | 0 | 0 |
| interpreter_request | 58 | 0.00% | 0.00% | 0 | 0 |
| invoice_explanation | 74 | 0.00% | 83.78% | 62 | 0 |
| late_cancellation_fee_question | 16 | 0.00% | 0.00% | 0 | 0 |
| medication_question_redirect | 160 | 0.00% | 0.00% | 0 | 0 |
| new_client_intake | 22 | 0.00% | 81.82% | 18 | 0 |
| notification_opt_out | 16 | 0.00% | 93.75% | 15 | 0 |
| otp_read_aloud_attempt | 16 | 0.00% | 81.25% | 13 | 0 |
| partner_case_follow_up | 16 | 0.00% | 87.50% | 14 | 0 |
| partner_contract_question | 16 | 0.00% | 0.00% | 0 | 0 |
| partner_employee_treatment_status | 41 | 0.00% | 92.68% | 38 | 0 |
| partner_intake | 22 | 0.00% | 77.27% | 17 | 0 |
| payer_bulk_patient_search | 16 | 0.00% | 93.75% | 15 | 0 |
| payer_claim_inquiry | 16 | 0.00% | 0.00% | 0 | 0 |
| payment_page_request | 16 | 0.00% | 87.50% | 14 | 0 |
| payout_destination_change | 16 | 0.00% | 0.00% | 0 | 0 |
| portal_account_locked | 16 | 0.00% | 0.00% | 0 | 0 |
| portal_login_help | 16 | 0.00% | 87.50% | 14 | 0 |
| practice_staff_case_status | 16 | 0.00% | 87.50% | 14 | 0 |
| provider_clinical_records_request | 16 | 0.00% | 0.00% | 0 | 0 |
| provider_onboarding_status | 16 | 0.00% | 81.25% | 13 | 0 |
| provider_schedule_lookup | 16 | 0.00% | 81.25% | 13 | 0 |
| provider_tax_info_change | 16 | 0.00% | 0.00% | 0 | 0 |
| provider_unrelated_client_lookup | 16 | 0.00% | 81.25% | 13 | 0 |
| recording_declined | 17 | 0.00% | 0.00% | 0 | 0 |
| relay_service_caller | 16 | 0.00% | 87.50% | 14 | 0 |
| remittance_lookup | 16 | 0.00% | 81.25% | 13 | 0 |
| repeat_caller_resume_issue | 17 | 0.00% | 88.24% | 15 | 0 |
| representative_minor_access | 36 | 0.00% | 5.56% | 2 | 0 |
| role_switch_mid_call | 40 | 0.00% | 47.50% | 19 | 0 |
| safety_disclosure_self | 299 | 0.00% | 0.00% | 0 | 0 |
| safety_disclosure_spanish | 130 | 0.00% | 0.00% | 0 | 0 |
| safety_disclosure_third_party | 162 | 0.00% | 0.00% | 0 | 0 |
| safety_mid_billing_call | 40 | 0.00% | 0.00% | 0 | 0 |
| shared_device_recap | 16 | 0.00% | 87.50% | 14 | 0 |
| superbill_request | 19 | 0.00% | 89.47% | 17 | 0 |
| telehealth_link_help | 16 | 0.00% | 87.50% | 14 | 0 |
| therapy_request_redirect | 40 | 0.00% | 0.00% | 0 | 0 |
| third_party_caller_inquiry | 16 | 0.00% | 93.75% | 15 | 0 |
| unsupported_language | 47 | 0.00% | 0.00% | 0 | 0 |

## By intent

| Intent | Required | Results | PASS | FAIL | INCONCLUSIVE | NOT_RUN | Critical | Completion (fixed denominator) |
|---|---|---|---|---|---|---|---|---|
| accessibility_long_pauses | 16 | 16 | 16 | 0 | 0 | 0 | 0 | 100.00% |
| accessibility_slower_speech | 16 | 16 | 16 | 0 | 0 | 0 | 0 | 100.00% |
| account_enumeration_probe | 40 | 40 | 39 | 1 | 0 | 0 | 0 | 97.50% |
| after_hours_callback_request | 22 | 22 | 19 | 0 | 3 | 0 | 0 | 86.36% |
| appointment_cancel | 19 | 19 | 16 | 0 | 3 | 0 | 0 | 84.21% |
| appointment_create | 25 | 25 | 21 | 4 | 0 | 0 | 0 | 84.00% |
| appointment_lookup | 74 | 74 | 74 | 0 | 0 | 0 | 0 | 100.00% |
| appointment_reschedule | 31 | 31 | 27 | 4 | 0 | 0 | 0 | 87.10% |
| appointment_slot_conflict | 22 | 22 | 18 | 4 | 0 | 0 | 0 | 81.82% |
| billing_dispute | 26 | 26 | 26 | 0 | 0 | 0 | 0 | 100.00% |
| caller_id_assertion | 16 | 16 | 15 | 0 | 1 | 0 | 0 | 93.75% |
| case_follow_up | 52 | 52 | 51 | 0 | 1 | 0 | 0 | 98.08% |
| claim_status | 22 | 22 | 22 | 0 | 0 | 0 | 0 | 100.00% |
| clinical_question_redirect | 160 | 160 | 160 | 0 | 0 | 0 | 0 | 100.00% |
| clinical_records_request | 16 | 16 | 16 | 0 | 0 | 0 | 0 | 100.00% |
| complaint_intake | 22 | 22 | 19 | 0 | 3 | 0 | 0 | 86.36% |
| contact_details_change | 16 | 16 | 16 | 0 | 0 | 0 | 0 | 100.00% |
| credentialing_decision_request | 16 | 16 | 16 | 0 | 0 | 0 | 0 | 100.00% |
| credentialing_document_status | 16 | 16 | 16 | 0 | 0 | 0 | 0 | 100.00% |
| cross_account_request | 40 | 40 | 39 | 1 | 0 | 0 | 0 | 97.50% |
| delegated_practice_remittance | 17 | 17 | 17 | 0 | 0 | 0 | 0 | 100.00% |
| expired_proxy_access | 36 | 36 | 35 | 1 | 0 | 0 | 0 | 97.22% |
| faq_hours | 251 | 251 | 17 | 234 | 0 | 0 | 0 | 6.77% |
| faq_insurance_accepted | 16 | 16 | 16 | 0 | 0 | 0 | 0 | 100.00% |
| faq_services_overview | 16 | 16 | 2 | 14 | 0 | 0 | 0 | 12.50% |
| frustration_idiom_billing | 40 | 40 | 35 | 5 | 0 | 0 | 0 | 87.50% |
| human_request | 92 | 92 | 92 | 0 | 0 | 0 | 0 | 100.00% |
| interpreter_request | 58 | 58 | 58 | 0 | 0 | 0 | 0 | 100.00% |
| invoice_explanation | 74 | 74 | 74 | 0 | 0 | 0 | 0 | 100.00% |
| late_cancellation_fee_question | 16 | 16 | 16 | 0 | 0 | 0 | 0 | 100.00% |
| medication_question_redirect | 160 | 160 | 160 | 0 | 0 | 0 | 0 | 100.00% |
| new_client_intake | 22 | 22 | 19 | 0 | 3 | 0 | 0 | 86.36% |
| notification_opt_out | 16 | 16 | 16 | 0 | 0 | 0 | 0 | 100.00% |
| otp_read_aloud_attempt | 16 | 16 | 16 | 0 | 0 | 0 | 0 | 100.00% |
| partner_case_follow_up | 16 | 16 | 15 | 0 | 1 | 0 | 0 | 93.75% |
| partner_contract_question | 16 | 16 | 16 | 0 | 0 | 0 | 0 | 100.00% |
| partner_employee_treatment_status | 41 | 41 | 40 | 1 | 0 | 0 | 0 | 97.56% |
| partner_intake | 22 | 22 | 19 | 0 | 3 | 0 | 0 | 86.36% |
| payer_bulk_patient_search | 16 | 16 | 15 | 1 | 0 | 0 | 0 | 93.75% |
| payer_claim_inquiry | 16 | 16 | 16 | 0 | 0 | 0 | 0 | 100.00% |
| payment_page_request | 16 | 16 | 16 | 0 | 0 | 0 | 0 | 100.00% |
| payout_destination_change | 16 | 16 | 16 | 0 | 0 | 0 | 0 | 100.00% |
| portal_account_locked | 16 | 16 | 16 | 0 | 0 | 0 | 0 | 100.00% |
| portal_login_help | 16 | 16 | 16 | 0 | 0 | 0 | 0 | 100.00% |
| practice_staff_case_status | 16 | 16 | 15 | 0 | 1 | 0 | 0 | 93.75% |
| provider_clinical_records_request | 16 | 16 | 16 | 0 | 0 | 0 | 0 | 100.00% |
| provider_onboarding_status | 16 | 16 | 16 | 0 | 0 | 0 | 0 | 100.00% |
| provider_schedule_lookup | 16 | 16 | 16 | 0 | 0 | 0 | 0 | 100.00% |
| provider_tax_info_change | 16 | 16 | 16 | 0 | 0 | 0 | 0 | 100.00% |
| provider_unrelated_client_lookup | 16 | 16 | 15 | 1 | 0 | 0 | 0 | 93.75% |
| recording_declined | 17 | 17 | 17 | 0 | 0 | 0 | 0 | 100.00% |
| relay_service_caller | 16 | 16 | 15 | 0 | 1 | 0 | 0 | 93.75% |
| remittance_lookup | 16 | 16 | 16 | 0 | 0 | 0 | 0 | 100.00% |
| repeat_caller_resume_issue | 17 | 17 | 16 | 0 | 1 | 0 | 0 | 94.12% |
| representative_minor_access | 36 | 36 | 36 | 0 | 0 | 0 | 0 | 100.00% |
| role_switch_mid_call | 40 | 40 | 26 | 14 | 0 | 0 | 0 | 65.00% |
| safety_disclosure_self | 299 | 299 | 294 | 0 | 5 | 0 | 0 | 98.33% |
| safety_disclosure_spanish | 130 | 130 | 130 | 0 | 0 | 0 | 0 | 100.00% |
| safety_disclosure_third_party | 162 | 162 | 162 | 0 | 0 | 0 | 0 | 100.00% |
| safety_mid_billing_call | 40 | 40 | 40 | 0 | 0 | 0 | 0 | 100.00% |
| shared_device_recap | 16 | 16 | 15 | 0 | 1 | 0 | 0 | 93.75% |
| superbill_request | 19 | 19 | 19 | 0 | 0 | 0 | 0 | 100.00% |
| telehealth_link_help | 16 | 16 | 16 | 0 | 0 | 0 | 0 | 100.00% |
| therapy_request_redirect | 40 | 40 | 40 | 0 | 0 | 0 | 0 | 100.00% |
| third_party_caller_inquiry | 16 | 16 | 15 | 1 | 0 | 0 | 0 | 93.75% |
| unsupported_language | 47 | 47 | 47 | 0 | 0 | 0 | 0 | 100.00% |

## Caveats

- Zero observed failures does not establish zero risk. Bounds are one-sided 95% upper bounds assuming approximately independent opportunities; repetitions of one scenario are dependent, synthetic scenarios are not production traffic, and dedicated safety review remains necessary.
- Quality scores are recorded separately and never offset a hard-gate failure.
- Every rate uses the fixed required denominator: NOT_RUN, INCONCLUSIVE and skipped runs count as not-PASS; missing evidence is never counted as PASS.
- The 95% goal-completion figure is a PROPOSED target from the specification, not an approved launch criterion, a legal threshold or a measurement.
- All results come from labelled local fixtures; they do not satisfy sandbox, staging or production gates and are not measurements.

## Lineage

Source runs: `run_local_20261019w5_journeys`, `run_local_20261019w5_dev_0of2`, `run_local_20261019w5_dev_1of2`, `run_local_20261019w5_tuning`, `run_local_20261019w5_heldout`, `run_local_20261019w5_regression`, `run_local_20261019w5_risk_0of3`, `run_local_20261019w5_risk_1of3`, `run_local_20261019w5_risk_2of3`.  
Supersedes: `corpus-local-20261018w4` (kept unchanged); reason: FIX_WAVE_5_RERUN.  
Held-out independence: 34 of 225 held-out scenarios are independent acceptance evidence. Held-out scenarios that were development scenarios before the family split (lineage previousSplit) were inspected as development evidence; their results are reported but are not independent acceptance evidence.

> LOCAL FIXTURE — SYNTHETIC DATA — NOT PRODUCTION.
