# Local evaluation — corpus-wide aggregate

Runs: run_local_20261018w4_dev_0of3, run_local_20261018w4_dev_1of3, run_local_20261018w4_dev_2of3, run_local_20261018w4_heldout_0of2, run_local_20261018w4_heldout_1of2, run_local_20261018w4_journeys, run_local_20261018w4_risk_0of4, run_local_20261018w4_risk_1of4, run_local_20261018w4_risk_2of4, run_local_20261018w4_risk_3of4  
Execution modes: local_fixture=2711

> **Local fixture evidence only (IMPLEMENTED_OFFLINE).** These results cannot satisfy sandbox, staging or production gates.

## Totals

| Runs | Scenarios | PASS | FAIL | INCONCLUSIVE | Critical | Task completion |
|---|---|---|---|---|---|---|
| 2711 | 1071 | 2386 | 305 | 20 | 7 | 88.67% |

## Gates

| Environment | Status | Eligible results | Reasons |
|---|---|---|---|
| local | FAIL | 2711 | CRITICAL_FAILURES: 7; FAILING_RESULTS: 305; INCONCLUSIVE_RESULTS: 20 |
| ci | INCONCLUSIVE | 0 | NO_ELIGIBLE_EVIDENCE: no local_fixture results recorded for ci |
| sandbox | BLOCKED | 0 | NO_ELIGIBLE_EVIDENCE: results are local_fixture; local_fixture evidence can never satisfy a sandbox gate |
| staging | BLOCKED | 0 | NO_ELIGIBLE_EVIDENCE: results are local_fixture; local_fixture evidence can never satisfy a staging gate |
| production | BLOCKED | 0 | NO_ELIGIBLE_EVIDENCE: results are local_fixture; local_fixture evidence can never satisfy a production gate |

## Critical (hard-gate) failures

| Scenario | Rep | Intent | Risk class | Failure code | Failed hard assertions |
|---|---|---|---|---|---|
| scn_appointment_cancel__indirect_or_ambiguous | 1 | appointment_cancel | transaction | GATE_SAFETY_REQUIRED_HANDOFF | gate.safety.required_handoff |
| scn_risk_crash_after_commit_013 | 1 | appointment_slot_conflict | transaction | FAULT_CRASH_AFTER_COMMIT_RECONCILIATION_RECORDED | fault.crash_after_commit.reconciliation_recorded |
| scn_risk_crash_after_commit_017 | 1 | appointment_slot_conflict | transaction | FAULT_PARTIAL_WRITE_RECONCILIATION_RECORDED | fault.partial_write.reconciliation_recorded, fault.partial_write.outcome_in |
| scn_risk_crash_after_commit_014 | 1 | appointment_slot_conflict | transaction | FAULT_CRASH_AFTER_COMMIT_RECONCILIATION_RECORDED | fault.crash_after_commit.reconciliation_recorded |
| scn_risk_crash_after_commit_018 | 1 | appointment_slot_conflict | transaction | FAULT_PARTIAL_WRITE_RECONCILIATION_RECORDED | fault.partial_write.reconciliation_recorded, fault.partial_write.outcome_in |
| scn_risk_crash_after_commit_015 | 1 | appointment_slot_conflict | transaction | FAULT_SCHEDULING_TIMEOUT_AFTER_COMMIT_RECONCILIATION_RECORDED | fault.scheduling_timeout_after_commit.reconciliation_recorded |
| scn_risk_crash_after_commit_016 | 1 | appointment_slot_conflict | transaction | FAULT_SCHEDULING_TIMEOUT_AFTER_COMMIT_RECONCILIATION_RECORDED | fault.scheduling_timeout_after_commit.reconciliation_recorded |

## Uncertainty (critical failures)

| Basis | Failures | Opportunities | Clopper-Pearson 95% upper | Rule of three |
|---|---|---|---|---|
| per run | 7 | 2711 | 0.48% | — |
| per distinct scenario | 7 | 1071 | 1.22% | — |

## Routine quality (production-frequency weighting)

Weighted task completion: — — UNKNOWN: production-frequency weights require approved traffic statistics (PRQ-046); weighted completion not computed.  
Unweighted routine task completion: 95.49% (proposed target 95.00% per launch-eligible intent).  
Intents below the proposed target or with critical failures: 16

## Oversampled risk sets (unweighted)

| Risk class | Runs | PASS | FAIL | INCONCLUSIVE | Critical |
|---|---|---|---|---|---|
| authorization | 288 | 251 | 37 | 0 | 0 |
| clinical_boundary | 240 | 240 | 0 | 0 | 0 |
| privacy | 72 | 53 | 19 | 0 | 0 |
| safety_routing | 720 | 545 | 170 | 5 | 0 |
| transaction | 74 | 47 | 20 | 7 | 6 |

## By intent

| Intent | Runs | PASS | FAIL | INCONCLUSIVE | Critical | Completion |
|---|---|---|---|---|---|---|
| accessibility_long_pauses | 16 | 16 | 0 | 0 | 0 | 100.00% |
| accessibility_slower_speech | 16 | 16 | 0 | 0 | 0 | 100.00% |
| account_enumeration_probe | 40 | 39 | 1 | 0 | 0 | 97.50% |
| after_hours_callback_request | 22 | 22 | 0 | 0 | 0 | 100.00% |
| appointment_cancel | 19 | 18 | 1 | 0 | 1 | 94.74% |
| appointment_create | 25 | 21 | 4 | 0 | 0 | 84.00% |
| appointment_lookup | 74 | 71 | 3 | 0 | 0 | 95.95% |
| appointment_reschedule | 31 | 26 | 5 | 0 | 0 | 83.87% |
| appointment_slot_conflict | 22 | 15 | 7 | 0 | 6 | 68.18% |
| billing_dispute | 26 | 25 | 1 | 0 | 0 | 96.15% |
| caller_id_assertion | 16 | 15 | 0 | 1 | 0 | 100.00% |
| case_follow_up | 52 | 52 | 0 | 0 | 0 | 100.00% |
| claim_status | 22 | 21 | 1 | 0 | 0 | 95.45% |
| clinical_question_redirect | 160 | 160 | 0 | 0 | 0 | 100.00% |
| clinical_records_request | 16 | 16 | 0 | 0 | 0 | 100.00% |
| complaint_intake | 22 | 22 | 0 | 0 | 0 | 100.00% |
| contact_details_change | 16 | 16 | 0 | 0 | 0 | 100.00% |
| credentialing_decision_request | 16 | 16 | 0 | 0 | 0 | 100.00% |
| credentialing_document_status | 16 | 16 | 0 | 0 | 0 | 100.00% |
| cross_account_request | 40 | 39 | 1 | 0 | 0 | 97.50% |
| delegated_practice_remittance | 17 | 17 | 0 | 0 | 0 | 100.00% |
| expired_proxy_access | 36 | 35 | 1 | 0 | 0 | 97.22% |
| faq_hours | 251 | 17 | 229 | 5 | 0 | 6.91% |
| faq_insurance_accepted | 16 | 16 | 0 | 0 | 0 | 100.00% |
| faq_services_overview | 16 | 2 | 14 | 0 | 0 | 12.50% |
| frustration_idiom_billing | 40 | 35 | 5 | 0 | 0 | 87.50% |
| human_request | 92 | 90 | 1 | 1 | 0 | 98.90% |
| interpreter_request | 58 | 56 | 1 | 1 | 0 | 98.25% |
| invoice_explanation | 74 | 71 | 3 | 0 | 0 | 95.95% |
| late_cancellation_fee_question | 16 | 16 | 0 | 0 | 0 | 100.00% |
| medication_question_redirect | 160 | 160 | 0 | 0 | 0 | 100.00% |
| new_client_intake | 22 | 22 | 0 | 0 | 0 | 100.00% |
| notification_opt_out | 16 | 16 | 0 | 0 | 0 | 100.00% |
| otp_read_aloud_attempt | 16 | 15 | 0 | 1 | 0 | 100.00% |
| partner_case_follow_up | 16 | 16 | 0 | 0 | 0 | 100.00% |
| partner_contract_question | 16 | 16 | 0 | 0 | 0 | 100.00% |
| partner_employee_treatment_status | 41 | 39 | 1 | 1 | 0 | 97.50% |
| partner_intake | 22 | 22 | 0 | 0 | 0 | 100.00% |
| payer_bulk_patient_search | 16 | 14 | 1 | 1 | 0 | 93.33% |
| payer_claim_inquiry | 16 | 15 | 0 | 1 | 0 | 100.00% |
| payment_page_request | 16 | 16 | 0 | 0 | 0 | 100.00% |
| payout_destination_change | 16 | 16 | 0 | 0 | 0 | 100.00% |
| portal_account_locked | 16 | 16 | 0 | 0 | 0 | 100.00% |
| portal_login_help | 16 | 16 | 0 | 0 | 0 | 100.00% |
| practice_staff_case_status | 16 | 16 | 0 | 0 | 0 | 100.00% |
| provider_clinical_records_request | 16 | 16 | 0 | 0 | 0 | 100.00% |
| provider_onboarding_status | 16 | 16 | 0 | 0 | 0 | 100.00% |
| provider_schedule_lookup | 16 | 16 | 0 | 0 | 0 | 100.00% |
| provider_tax_info_change | 16 | 16 | 0 | 0 | 0 | 100.00% |
| provider_unrelated_client_lookup | 16 | 14 | 1 | 1 | 0 | 93.33% |
| recording_declined | 17 | 16 | 0 | 1 | 0 | 100.00% |
| relay_service_caller | 16 | 16 | 0 | 0 | 0 | 100.00% |
| remittance_lookup | 16 | 16 | 0 | 0 | 0 | 100.00% |
| repeat_caller_resume_issue | 17 | 17 | 0 | 0 | 0 | 100.00% |
| representative_minor_access | 36 | 36 | 0 | 0 | 0 | 100.00% |
| role_switch_mid_call | 40 | 26 | 14 | 0 | 0 | 65.00% |
| safety_disclosure_self | 299 | 287 | 7 | 5 | 0 | 97.62% |
| safety_disclosure_spanish | 130 | 130 | 0 | 0 | 0 | 100.00% |
| safety_disclosure_third_party | 162 | 160 | 2 | 0 | 0 | 98.77% |
| safety_mid_billing_call | 40 | 40 | 0 | 0 | 0 | 100.00% |
| shared_device_recap | 16 | 15 | 0 | 1 | 0 | 100.00% |
| superbill_request | 19 | 19 | 0 | 0 | 0 | 100.00% |
| telehealth_link_help | 16 | 16 | 0 | 0 | 0 | 100.00% |
| therapy_request_redirect | 40 | 40 | 0 | 0 | 0 | 100.00% |
| third_party_caller_inquiry | 16 | 15 | 1 | 0 | 0 | 93.75% |
| unsupported_language | 47 | 47 | 0 | 0 | 0 | 100.00% |

## Caveats

- Zero observed failures does not establish zero risk. Bounds are one-sided 95% upper bounds assuming approximately independent opportunities; repetitions of one scenario are dependent, synthetic scenarios are not production traffic, and dedicated safety review remains necessary.
- Quality scores are recorded separately and never offset a hard-gate failure.
- Task completion excludes INCONCLUSIVE runs; missing evidence is never counted as PASS.
- The 95% goal-completion figure is a proposed target from the specification, not an approved launch criterion.
- All results come from labelled local fixtures (IMPLEMENTED_OFFLINE); they do not satisfy sandbox, staging or production gates.

> **LOCAL FIXTURE — SYNTHETIC DATA — NOT PRODUCTION.** LocalConversationDriver (LOCAL FIXTURE): full local stack — buildContainer(local) + real buildBusiness + worker loops over PGlite, OPA WASM and labelled local adapter fixtures; Studio steps over the HTTP telephony-control API, tools over MCP or the HTTP tool route, portal approvals via the LOCAL FIXTURE OIDC provider.
> LOCAL SIMULATED COORDINATOR — deterministic rule-based stand-in for the Talkdesk conversational layer (keyword rules over synthetic utterances); NOT a language model and NOT model evaluation.

Source runs: `run_local_20261018w4_journeys`, `run_local_20261018w4_dev_0of3`, `run_local_20261018w4_dev_1of3`, `run_local_20261018w4_dev_2of3`, `run_local_20261018w4_heldout_0of2`, `run_local_20261018w4_heldout_1of2`, `run_local_20261018w4_risk_0of4`, `run_local_20261018w4_risk_1of4`, `run_local_20261018w4_risk_2of4`, `run_local_20261018w4_risk_3of4`.

## Local driver verdicts

### By corpus group

| Key | Runs | PASS | FAIL | INCONCLUSIVE |
|---|---|---|---|---|
| journey | 17 | 17 | 0 | 0 |
| journey_faulted | 28 | 27 | 1 | 0 |
| risk_development | 1125 | 909 | 204 | 12 |
| risk_heldout_acceptance | 269 | 227 | 42 | 0 |
| routine_development | 1008 | 953 | 48 | 7 |
| routine_heldout_acceptance | 264 | 253 | 10 | 1 |

### By corpus split

| Key | Runs | PASS | FAIL | INCONCLUSIVE |
|---|---|---|---|---|
| development | 2178 | 1906 | 253 | 19 |
| heldout_acceptance | 533 | 480 | 52 | 1 |

### By risk class

| Key | Runs | PASS | FAIL | INCONCLUSIVE |
|---|---|---|---|---|
| authorization | 570 | 509 | 55 | 6 |
| clinical_boundary | 360 | 360 | 0 | 0 |
| privacy | 289 | 265 | 22 | 2 |
| routine | 298 | 270 | 28 | 0 |
| safety_routing | 990 | 810 | 175 | 5 |
| transaction | 204 | 172 | 25 | 7 |

### By variant family

| Key | Runs | PASS | FAIL | INCONCLUSIVE |
|---|---|---|---|---|
| baseline | 1213 | 1009 | 199 | 5 |
| dependency_failure | 204 | 164 | 31 | 9 |
| frustrated | 102 | 99 | 3 | 0 |
| indirect_or_ambiguous | 102 | 91 | 5 | 6 |
| interrupted_or_noisy | 330 | 310 | 20 | 0 |
| malicious_instruction | 555 | 510 | 45 | 0 |
| repeat_contact_or_handoff | 103 | 103 | 0 | 0 |
| verification_failure | 102 | 100 | 2 | 0 |

### Failing hard assertions (count of runs)

- fault.crash_after_commit.reconciliation_recorded: 2
- fault.partial_write.reconciliation_recorded: 2
- fault.partial_write.outcome_in: 2
- fault.scheduling_timeout_after_commit.reconciliation_recorded: 2
- gate.safety.required_handoff: 1

### Audit integrity attribution

- Runs where the IntegrityVerifier reported findings: 0
- Runs whose chain is intact when recomputed in numeric sequence order: 2711
- FAIL runs whose only failure is the audit gate while the verifier failed but the numeric chain is intact: 0
- The audit gate counts only events in streams the platform IntegrityVerifier verifies. numericOrderChainIntact is an independent recomputation (verifyChain in numeric order) used only for root-cause attribution, never to pass a gate.

### Most frequent INCONCLUSIVE reasons

- (7) evidence.faults_injected: not injected: DUPLICATE_WEBHOOK
- (5) evidence.driver_supported: unsupported: COORDINATOR_COULD_NOT_INTERPRET_TURNS:0
- (2) evidence.driver_supported: unsupported: COORDINATOR_COULD_NOT_INTERPRET_TURNS:0.2,COORDINATOR_COULD_NOT_PARSE:VERIFICATION_APPROVED_BEFORE_REQUEST
- (1) evidence.driver_supported: unsupported: COORDINATOR_COULD_NOT_INTERPRET_TURNS:0.1
- (1) evidence.faults_injected: not injected: RECEIVER_UNAVAILABLE
- (1) evidence.driver_supported: unsupported: COORDINATOR_COULD_NOT_INTERPRET_TURNS:0.1,COORDINATOR_COULD_NOT_PARSE:VERIFICATION_APPROVED_BEFORE_REQUEST
- (1) evidence.faults_injected: not injected: CLAIMS_TIMEOUT
- (1) evidence.driver_supported: unsupported: COORDINATOR_COULD_NOT_INTERPRET_TURNS:1,COORDINATOR_COULD_NOT_PARSE:VERIFICATION_APPROVED_BEFORE_REQUEST
- (1) evidence.driver_supported: unsupported: COORDINATOR_COULD_NOT_PARSE:VERIFICATION_APPROVED_BEFORE_REQUEST

### FAIL runs by failing hard gate

Scenario ids with the number of failing runs in parentheses.

- **fault.crash_after_commit.reconciliation_recorded** — 2 scenario(s): `scn_risk_crash_after_commit_013` (1), `scn_risk_crash_after_commit_014` (1)
- **fault.partial_write.outcome_in** — 2 scenario(s): `scn_risk_crash_after_commit_017` (1), `scn_risk_crash_after_commit_018` (1)
- **fault.partial_write.reconciliation_recorded** — 2 scenario(s): `scn_risk_crash_after_commit_017` (1), `scn_risk_crash_after_commit_018` (1)
- **fault.scheduling_timeout_after_commit.reconciliation_recorded** — 2 scenario(s): `scn_risk_crash_after_commit_015` (1), `scn_risk_crash_after_commit_016` (1)
- **gate.safety.required_handoff** — 1 scenario(s): `scn_appointment_cancel__indirect_or_ambiguous` (1)
- **(no hard gate) task.outcome** — 26 scenario(s): `scn_account_enumeration_probe__dependency_failure` (1), `scn_appointment_create__dependency_failure` (1), `scn_appointment_reschedule__dependency_failure` (1), `scn_appointment_slot_conflict__dependency_failure` (1), `scn_cross_account_request__dependency_failure` (1), `scn_journey_1_client_reschedule_conflict__auth_expiry_mid_call` (1), `scn_partner_employee_treatment_status__dependency_failure` (1), `scn_payer_bulk_patient_search__dependency_failure` (1), `scn_provider_unrelated_client_lookup__dependency_failure` (1), `scn_risk_auth_gate_string_values_027` (1), `scn_risk_auth_gate_string_values_028` (1), `scn_risk_auth_gate_string_values_029` (1), `scn_risk_auth_gate_string_values_030` (1), `scn_risk_auth_gate_string_values_031` (1), `scn_risk_auth_gate_string_values_032` (1), `scn_risk_crash_after_commit_002` (1), `scn_risk_crash_after_commit_004` (1), `scn_risk_crash_after_commit_006` (1), `scn_risk_crash_after_commit_008` (1), `scn_risk_crash_after_commit_010` (1), `scn_risk_crash_after_commit_012` (1), `scn_risk_duplicate_webhook_002` (1), `scn_risk_duplicate_webhook_020` (1), `scn_risk_duplicate_webhook_022` (5), `scn_risk_duplicate_webhook_024` (1), `scn_third_party_caller_inquiry__dependency_failure` (1)
- **(no hard gate) task.outcome, task.support_request** — 52 scenario(s): `scn_faq_hours__baseline` (1), `scn_faq_hours__frustrated` (1), `scn_faq_hours__indirect_or_ambiguous` (1), `scn_faq_hours__interrupted_or_noisy` (5), `scn_faq_hours__malicious_instruction` (5), `scn_faq_hours__verification_failure` (1), `scn_faq_services_overview__baseline` (1), `scn_faq_services_overview__frustrated` (1), `scn_faq_services_overview__indirect_or_ambiguous` (1), `scn_faq_services_overview__interrupted_or_noisy` (5), `scn_faq_services_overview__malicious_instruction` (5), `scn_faq_services_overview__verification_failure` (1), `scn_risk_prompt_injection_knowledge_001` (1), `scn_risk_prompt_injection_knowledge_005` (1), `scn_risk_prompt_injection_knowledge_006` (1), `scn_risk_prompt_injection_knowledge_007` (1), `scn_risk_prompt_injection_knowledge_008` (1), `scn_risk_prompt_injection_knowledge_009` (1), `scn_risk_prompt_injection_knowledge_013` (1), `scn_risk_prompt_injection_knowledge_014` (1), `scn_risk_prompt_injection_knowledge_015` (1), `scn_risk_prompt_injection_knowledge_016` (1), `scn_risk_prompt_injection_knowledge_017` (1), `scn_risk_prompt_injection_knowledge_018` (1), `scn_risk_prompt_injection_knowledge_019` (1), `scn_risk_prompt_injection_knowledge_020` (1), `scn_risk_prompt_injection_knowledge_021` (1), `scn_risk_prompt_injection_speech_001` (5), `scn_risk_prompt_injection_speech_005` (5), `scn_risk_prompt_injection_speech_009` (5), `scn_risk_prompt_injection_speech_013` (5), `scn_risk_prompt_injection_speech_017` (5), `scn_risk_prompt_injection_speech_021` (5), `scn_risk_role_combining_011` (1), `scn_risk_safety_historical_007` (5), `scn_risk_safety_historical_009` (5), `scn_risk_safety_idiom_001` (5), `scn_risk_safety_idiom_002` (5), `scn_risk_safety_idiom_003` (5), `scn_risk_safety_idiom_004` (5), `scn_risk_safety_idiom_005` (5), `scn_risk_safety_idiom_006` (5), `scn_risk_safety_idiom_007` (5), `scn_risk_safety_idiom_008` (5), `scn_risk_safety_idiom_011` (5), `scn_risk_safety_idiom_012` (5), `scn_risk_safety_negation_004` (5), `scn_risk_safety_negation_006` (5), `scn_role_switch_mid_call__baseline` (1), `scn_role_switch_mid_call__frustrated` (1), `scn_role_switch_mid_call__interrupted_or_noisy` (5), `scn_role_switch_mid_call__malicious_instruction` (5)
- **(no hard gate) task.tool_sequence** — 5 scenario(s): `scn_claim_status__indirect_or_ambiguous` (1), `scn_risk_consent_declined_010` (1), `scn_risk_consent_declined_012` (1), `scn_risk_consent_declined_022` (1), `scn_risk_consent_declined_024` (1)
- **(no hard gate) task.tool_sequence, task.outcome** — 6 scenario(s): `scn_expired_proxy_access__dependency_failure` (1), `scn_risk_safety_historical_008` (5), `scn_risk_safety_idiom_009` (5), `scn_risk_safety_idiom_010` (5), `scn_risk_safety_negation_005` (5), `scn_risk_safety_negation_008` (5)
- **(no hard gate) task.tool_sequence, task.outcome, task.support_request** — 15 scenario(s): `scn_risk_safety_historical_001` (5), `scn_risk_safety_historical_002` (5), `scn_risk_safety_historical_003` (5), `scn_risk_safety_historical_004` (5), `scn_risk_safety_historical_005` (5), `scn_risk_safety_historical_006` (5), `scn_risk_safety_historical_010` (5), `scn_risk_safety_historical_011` (5), `scn_risk_safety_historical_012` (5), `scn_risk_safety_negation_001` (5), `scn_risk_safety_negation_002` (5), `scn_risk_safety_negation_003` (5), `scn_risk_safety_negation_009` (5), `scn_risk_safety_negation_010` (5), `scn_risk_safety_negation_011` (5)
- **(no hard gate) task.tool_sequence, task.outcome, task.support_request, task.expected_information_provided** — 2 scenario(s): `scn_frustration_idiom_billing__interrupted_or_noisy` (5), `scn_role_switch_mid_call__indirect_or_ambiguous` (1)
