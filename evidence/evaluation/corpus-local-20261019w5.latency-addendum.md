# corpus-local-20261019w5: latency addendum

> **LOCAL FIXTURE — SYNTHETIC DATA — NOT PRODUCTION. Addendum to a committed combined run report (the summary and the report are unchanged).**

The `corpus-local-20261019w5.report.md` renderer skipped the language and audience latency tables; `corpus-local-20261019w5.summary.json` holds all eight dimensions. This is the latency section of that summary rendered by the current report renderer (`platform/src/evaluation/aggregate.ts` `latencySectionOf`, the section `renderReport` writes). Latencies are on the simulated clock of the local fixture driver.

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

### language

| Key | Calls | Samples | Missing observations | p50 ms [95% CI] | p95 ms [95% CI] | p99 ms [95% CI] |
|---|---|---|---|---|---|---|
| en-US | 2534 | 9118 | 0 | 39 [38, 40] | 138 [134, 141] | 207 [198, 217] |
| es-US | 161 | 277 | 0 | 71 [51, 104] | 191 [177, 223] | 258 [207, ?] |
| pt-BR | 16 | 58 | 0 | 3 [2, 7] | 76 [59, ?] | 102 [75, ?] |

### audience

| Key | Calls | Samples | Missing observations | p50 ms [95% CI] | p95 ms [95% CI] | p99 ms [95% CI] |
|---|---|---|---|---|---|---|
| client | 1136 | 4710 | 0 | 37 [35, 39] | 123 [119, 127] | 184 [175, 212] |
| partner | 115 | 549 | 0 | 33 [21, 36] | 99 [91, 109] | 136 [120, ?] |
| payer_representative | 32 | 148 | 0 | 16 [5, 24] | 73 [65, 95] | 95 [78, ?] |
| personal_representative | 74 | 311 | 0 | 41 [36, 46] | 123 [108, 141] | 150 [141, ?] |
| practice_staff | 41 | 217 | 0 | 38 [34, 41] | 83 [76, 98] | 103 [88, ?] |
| prospective_client | 112 | 506 | 0 | 9 [7, 17] | 105 [95, 126] | 137 [132, ?] |
| provider | 192 | 974 | 0 | 34 [30, 36] | 90 [83, 96] | 123 [115, 159] |
| unidentified | 1009 | 2038 | 0 | 67 [64, 72] | 183 [178, 193] | 247 [233, 285] |

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

Command: `cd platform && npx tsx ../evidence/evaluation/tools/latency-addendum.mts --summary corpus-local-20261019w5 --md <file>`.
