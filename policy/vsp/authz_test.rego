# METADATA
# title: Unit tests for vsp/authz/decision (SYNTHETIC fixtures only)
# description: |
#   Positive and negative cases for every catalogue action and every global
#   rule. Requirement tags in test names map to the spec invariants:
#   auth02 (deny by default), auth03 (server-established only), auth04
#   (expiry/revocation), auth05 (unrelated records), safe02 (safety/human
#   always available), ops03 (fail closed on malformed input).
package vsp.authz_test

import data.vsp.authz
import data.vsp.fixtures_test as fx

decide(x) := d if {
	d := authz.decision with input as x
}

allowed(x, reasons) if {
	d := decide(x)
	d.allow == true
	d.reasonCodes == reasons
}

denied(x, reasons) if {
	d := decide(x)
	d.allow == false
	d.reasonCodes == reasons
	d.fieldMask == []
}

denied_with(x, reasons, obligations) if {
	denied(x, reasons)
	decide(x).obligations == obligations
}

expired_session(x) := fx.with_auth(x, {"expiresAt": fx.earlier})

worst_case(action) := {
	"action": action,
	"purpose": "audit_review",
	"environment": "production",
	"now": fx.now,
	"tool": fx.tool("A3"),
	"auth": object.union(fx.anon_auth, {
		"revoked": true,
		"expiresAt": fx.earlier,
		"riskFlags": fx.all_risk_flags,
		"consentRecording": "DECLINED",
		"consentAutomatedProcessing": "DECLINED",
		"tenantId": fx.other_tenant,
	}),
	"resource": fx.resource("call_session", fx.avery.subject, fx.acme, "VERIFICATION_SECRET"),
	"relationships": [],
	"killSwitches": fx.ks_all,
}

# ---------------------------------------------------------------- SAFE-02 ----

test_safe02_safety_route_anonymous_allowed if {
	x := fx.anon("safety:route", "safety_routing", "call_session", "INTERNAL")
	allowed(x, ["SAFETY_ROUTE_ALWAYS_AVAILABLE"])
	decide(x).obligations == ["RESTRICTED_RECORD"]
	decide(x).fieldMask == ["destinationPurpose", "status", "transferId"]
}

test_safe02_human_request_anonymous_allowed if {
	x := fx.anon("human:request", "human_handoff", "call_session", "INTERNAL")
	allowed(x, ["HUMAN_ROUTE_ALWAYS_AVAILABLE"])
	decide(x).fieldMask == ["destinationPurpose", "status", "supportReference", "transferId"]
}

test_safe02_safety_route_survives_every_failure if allowed(worst_case("safety:route"), ["SAFETY_ROUTE_ALWAYS_AVAILABLE"])

test_safe02_human_request_survives_every_failure if allowed(worst_case("human:request"), ["HUMAN_ROUTE_ALWAYS_AVAILABLE"])

test_safe02_safety_route_never_needs_assurance if {
	x := object.union(fx.anon("safety:route", "safety_routing", "call_session", "INTERNAL"), {"tool": fx.tool("A3")})
	allowed(x, ["SAFETY_ROUTE_ALWAYS_AVAILABLE"])
}

test_safe02_human_request_with_expired_authenticated_session if {
	x := expired_session(object.union(fx.avery_appt, {"action": "human:request"}))
	allowed(x, ["HUMAN_ROUTE_ALWAYS_AVAILABLE"])
}

# ---------------------------------------------------------------- AUTH-02 ----

test_auth02_unknown_action_default_deny if {
	x := object.union(fx.avery_appt, {"action": "records:export_all"})
	denied(x, ["ACTION_UNKNOWN", "DEFAULT_DENY"])
}

test_auth02_generic_update_record_not_in_catalogue if {
	x := object.union(fx.avery_appt, {"action": "record:update"})
	denied(x, ["ACTION_UNKNOWN", "DEFAULT_DENY"])
}

test_auth02_empty_input_denies if {
	d := authz.decision with input as {}
	d.allow == false
}

test_auth02_missing_tool_field_denies if {
	x := object.remove(fx.avery_appt, ["tool"])
	d := decide(x)
	d.allow == false
}

human_boundary_actions := [
	"account:change_payout_destination",
	"account:change_tax_info",
	"credentialing:decide",
	"clinical_record:read",
	"identity:recover",
	"credential:reset",
]

test_auth02_human_boundary_actions_always_deny_require_human if {
	every a in human_boundary_actions {
		x := object.union(fx.avery_appt, {"action": a, "auth": object.union(fx.avery_appt.auth, {"assurance": "A3"})})
		denied_with(x, ["HUMAN_BOUNDARY"], ["REQUIRE_HUMAN"])
	}
}

test_auth02_human_boundary_actions_deny_anonymous if {
	every a in human_boundary_actions {
		denied_with(fx.anon(a, "caller_self_service", "account", "INTERNAL"), ["HUMAN_BOUNDARY"], ["REQUIRE_HUMAN"])
	}
}

# ---------------------------------------------------------------- public ----

test_public_read_anonymous_allowed if {
	x := fx.anon("public:read", "public_information", "knowledge_article", "PUBLIC")
	allowed(x, ["ALLOW_PUBLIC_INFORMATION"])
	decide(x).fieldMask == ["articleId", "articleVersion", "body", "citationId", "title"]
}

test_public_read_phi_classification_denied if {
	denied(fx.anon("public:read", "public_information", "knowledge_article", "PHI"), ["CLASSIFICATION_NOT_PERMITTED"])
}

test_public_read_wrong_resource_type_denied if {
	denied(fx.anon("public:read", "public_information", "invoice", "PUBLIC"), ["RESOURCE_TYPE_NOT_PERMITTED"])
}

test_public_read_wrong_purpose_denied if {
	denied(fx.anon("public:read", "audit_review", "knowledge_article", "PUBLIC"), ["PURPOSE_NOT_PERMITTED"])
}

test_auth04_public_read_expired_session_denied if {
	x := expired_session(fx.anon("public:read", "public_information", "knowledge_article", "PUBLIC"))
	denied(x, ["SESSION_INVALID"])
}

test_public_read_consent_declined_still_allowed if {
	x := fx.with_auth(fx.anon("public:read", "public_information", "knowledge_article", "PUBLIC"), {"consentAutomatedProcessing": "DECLINED", "consentRecording": "DECLINED"})
	allowed(x, ["ALLOW_PUBLIC_INFORMATION"])
}

test_public_read_ai_admission_kill_switch_denied if {
	x := fx.with_ks(fx.anon("public:read", "public_information", "knowledge_article", "PUBLIC"), {"aiAdmission": true})
	denied(x, ["KILL_SWITCH_AI_ADMISSION"])
}

test_public_read_intent_kill_switch_denied if {
	x := fx.with_ks(fx.anon("public:read", "public_information", "knowledge_article", "PUBLIC"), {"intents": ["public_faq"]})
	denied(x, ["KILL_SWITCH_INTENT"])
}

test_public_read_targeting_a_subject_is_protected if {
	x := fx.with_resource(fx.anon("public:read", "public_information", "knowledge_article", "PUBLIC"), {"subjectId": fx.avery.subject})
	denied(x, ["RELATIONSHIP_NOT_ESTABLISHED", "ROLE_NOT_SELECTED"])
}

test_login_help_allowed_and_public_only if {
	allowed(fx.anon("login_help:read", "caller_self_service", "knowledge_article", "PUBLIC"), ["ALLOW_PUBLIC_INFORMATION"])
	denied(fx.anon("login_help:read", "caller_self_service", "knowledge_article", "INTERNAL"), ["CLASSIFICATION_NOT_PERMITTED"])
}

# ---------------------------------------------------------------- intake ----

test_intake_anonymous_allowed_minimal_mask if {
	x := fx.anon("intake:create", "caller_self_service", "support_request", "INTERNAL")
	allowed(x, ["ALLOW_MINIMAL_INTAKE"])
	decide(x).fieldMask == ["status", "supportReference"]
}

test_intake_consent_declined_still_allowed if {
	x := fx.with_auth(fx.anon("intake:create", "caller_self_service", "support_request", "PHI"), {"consentAutomatedProcessing": "DECLINED"})
	allowed(x, ["ALLOW_MINIMAL_INTAKE"])
}

test_intake_not_linked_to_subject if {
	x := fx.with_resource(fx.anon("intake:create", "caller_self_service", "support_request", "INTERNAL"), {"subjectId": fx.avery.subject})
	denied(x, ["RELATIONSHIP_NOT_ESTABLISHED", "ROLE_NOT_SELECTED"])
}

test_intake_writes_kill_switch_does_not_block_limited_intake if {
	x := fx.with_ks(fx.anon("intake:create", "caller_self_service", "support_request", "INTERNAL"), {"writes": true})
	allowed(x, ["ALLOW_MINIMAL_INTAKE"])
}

test_intake_integration_kill_switch_denied if {
	x := fx.with_ks(fx.anon("intake:create", "caller_self_service", "support_request", "INTERNAL"), {"integrations": ["salesforce"]})
	denied(x, ["KILL_SWITCH_INTEGRATION"])
}

test_complaint_intake_allowed_and_kill_switch if {
	x := fx.anon("complaint:create", "caller_self_service", "complaint", "INTERNAL")
	allowed(x, ["ALLOW_MINIMAL_INTAKE"])
	denied(fx.with_ks(x, {"aiAdmission": true}), ["KILL_SWITCH_AI_ADMISSION"])
}

# ---------------------------------------------------------- verification ----

verification := fx.anon("verification:begin", "caller_self_service", "verification_challenge", "INTERNAL")

test_verification_begin_anonymous_allowed if {
	allowed(verification, ["ALLOW_VERIFICATION_START"])
	decide(verification).fieldMask == ["nextStep", "status", "verificationId"]
}

test_verification_enumeration_suspected_routes_to_human if {
	denied_with(fx.with_auth(verification, {"riskFlags": ["ENUMERATION_SUSPECTED"]}), ["RISK_VERIFICATION_ABUSE"], ["REQUIRE_HUMAN"])
	denied_with(fx.with_auth(verification, {"riskFlags": ["OTP_ABUSE_SUSPECTED"]}), ["RISK_VERIFICATION_ABUSE"], ["REQUIRE_HUMAN"])
}

test_verification_consent_declined_alternative_route if {
	denied_with(fx.with_auth(verification, {"consentAutomatedProcessing": "DECLINED"}), ["CONSENT_DECLINED_ALTERNATIVE_ROUTE"], ["REQUIRE_HUMAN"])
}

test_verification_consent_unknown_not_established if {
	denied(fx.with_auth(verification, {"consentAutomatedProcessing": "UNKNOWN"}), ["CONSENT_NOT_ESTABLISHED"])
}

test_auth06_verification_secret_never_through_tools_any_environment if {
	x := fx.with_resource(verification, {"classification": "VERIFICATION_SECRET"})
	denied(x, ["CLASSIFICATION_NOT_PERMITTED", "VERIFICATION_SECRET_PROHIBITED"])
	denied(object.union(x, {"environment": "production"}), ["CLASSIFICATION_NOT_PERMITTED", "VERIFICATION_SECRET_PROHIBITED"])
}

test_verification_identity_integration_kill_switch if {
	denied(fx.with_ks(verification, {"integrations": ["identity-directory"]}), ["KILL_SWITCH_INTEGRATION"])
}

# ------------------------------------------------------- appointment:read ----

test_client_self_appointment_read_allowed if {
	allowed(fx.avery_appt, ["ALLOW_SELF"])
	d := decide(fx.avery_appt)
	d.obligations == ["AUDIT_READ"]
	d.fieldMask == ["appointmentId", "modality", "providerDisplayName", "startsAt", "status", "timeZone"]
}

test_client_self_below_assurance_denied if {
	denied(fx.with_auth(fx.avery_appt, {"assurance": "A1"}), ["ASSURANCE_INSUFFICIENT"])
	denied(fx.with_auth(fx.avery_appt, {"assurance": "A0"}), ["ASSURANCE_INSUFFICIENT"])
}

test_auth05_client_cannot_read_other_client if {
	x := fx.with_resource(fx.avery_appt, {"subjectId": fx.blake.subject})
	denied(x, ["RELATIONSHIP_NOT_ESTABLISHED"])
}

test_auth03_self_requires_session_subject_match if {
	denied(fx.with_auth(fx.avery_appt, {"subjectId": fx.blake.subject}), ["RELATIONSHIP_NOT_ESTABLISHED"])
}

test_auth03_fact_of_another_actor_does_not_count if {
	x := object.union(fx.avery_appt, {"relationships": [object.union(fx.self_fact(fx.avery), {"actorId": fx.blake.actor})]})
	denied(x, ["RELATIONSHIP_NOT_ESTABLISHED"])
}

test_auth03_fact_from_non_authoritative_source_does_not_count if {
	x := object.union(fx.avery_appt, {"relationships": [object.union(fx.self_fact(fx.avery), {"source": "enrollment_system"})]})
	denied(x, ["RELATIONSHIP_NOT_ESTABLISHED"])
}

test_role_not_selected_for_protected_action if {
	denied(fx.with_auth(fx.avery_appt, {"selectedRole": null}), ["RELATIONSHIP_NOT_ESTABLISHED", "ROLE_NOT_SELECTED"])
}

test_unverified_caller_protected_read_reports_all_gaps if {
	x := fx.req("appointment:read", "caller_self_service", fx.anon_auth, fx.resource("appointment", fx.avery.subject, null, "PHI"), [])
	denied(x, ["ASSURANCE_INSUFFICIENT", "RELATIONSHIP_NOT_ESTABLISHED", "ROLE_NOT_SELECTED"])
}

test_auth04_expired_session_denied if denied(expired_session(fx.avery_appt), ["SESSION_INVALID"])

test_auth04_revoked_session_denied if denied(fx.with_auth(fx.avery_appt, {"revoked": true}), ["SESSION_INVALID"])

test_auth04_expiry_boundary_is_exclusive if {
	denied(fx.with_auth(fx.avery_appt, {"expiresAt": fx.now}), ["SESSION_INVALID"])
	allowed(fx.with_auth(fx.avery_appt, {"expiresAt": "2026-10-17T15:00:00.001Z"}), ["ALLOW_SELF"])
}

test_ops03_non_canonical_expiry_fails_closed if {
	denied(fx.with_auth(fx.avery_appt, {"expiresAt": "2026-10-17T15:30:00Z"}), ["SESSION_INVALID"])
}

test_ops03_non_canonical_now_fails_closed if {
	d := decide(object.union(fx.avery_appt, {"now": "yesterday"}))
	d.allow == false
	"SESSION_INVALID" in d.reasonCodes
}

test_tenant_mismatch_denied if denied(fx.with_resource(fx.avery_appt, {"tenantId": fx.other_tenant}), ["TENANT_MISMATCH"])

test_consent_declined_processing_alternative_route if {
	denied_with(fx.with_auth(fx.avery_appt, {"consentAutomatedProcessing": "DECLINED"}), ["CONSENT_DECLINED_ALTERNATIVE_ROUTE"], ["REQUIRE_HUMAN"])
}

test_consent_declined_recording_alternative_route if {
	denied_with(fx.with_auth(fx.avery_appt, {"consentRecording": "DECLINED"}), ["CONSENT_DECLINED_ALTERNATIVE_ROUTE"], ["REQUIRE_HUMAN"])
}

test_consent_unknown_not_established if denied(fx.with_auth(fx.avery_appt, {"consentAutomatedProcessing": "UNKNOWN"}), ["CONSENT_NOT_ESTABLISHED"])

test_consent_not_required_allowed if allowed(fx.with_auth(fx.avery_appt, {"consentAutomatedProcessing": "NOT_REQUIRED", "consentRecording": "NOT_REQUIRED"}), ["ALLOW_SELF"])

test_risk_fraud_review_denied if denied(fx.with_auth(fx.avery_appt, {"riskFlags": ["FRAUD_REVIEW"]}), ["RISK_FRAUD_REVIEW"])

test_risk_account_recovery_denied if denied(fx.with_auth(fx.avery_appt, {"riskFlags": ["ACCOUNT_RECOVERY_IN_PROGRESS"]}), ["RISK_ACCOUNT_RECOVERY_IN_PROGRESS"])

test_risk_participant_changed_denied if denied(fx.with_auth(fx.avery_appt, {"riskFlags": ["PARTICIPANT_CHANGED"]}), ["RISK_PARTICIPANT_CHANGED"])

test_safety_escalation_does_not_block_reads if allowed(fx.with_auth(fx.avery_appt, {"riskFlags": ["SAFETY_ESCALATION_ACTIVE"]}), ["ALLOW_SELF"])

test_recent_number_change_is_not_a_policy_denial if allowed(fx.with_auth(fx.avery_appt, {"riskFlags": ["RECENT_NUMBER_CHANGE"]}), ["ALLOW_SELF"])

test_kill_switch_ai_admission_blocks_reads if denied(fx.with_ks(fx.avery_appt, {"aiAdmission": true}), ["KILL_SWITCH_AI_ADMISSION"])

test_kill_switch_writes_does_not_block_reads if allowed(fx.with_ks(fx.avery_appt, {"writes": true}), ["ALLOW_SELF"])

test_kill_switch_intent_and_integration if {
	denied(fx.with_ks(fx.avery_appt, {"intents": ["appointment_lookup"]}), ["KILL_SWITCH_INTENT"])
	denied(fx.with_ks(fx.avery_appt, {"integrations": ["scheduling"]}), ["KILL_SWITCH_INTEGRATION"])
	allowed(fx.with_ks(fx.avery_appt, {"intents": ["billing_dispute"], "integrations": ["billing"]}), ["ALLOW_SELF"])
}

test_ops03_kill_switch_fields_missing_fail_closed if {
	x := object.union(object.remove(fx.avery_appt, ["killSwitches"]), {"killSwitches": {}})
	denied(x, ["KILL_SWITCH_AI_ADMISSION", "KILL_SWITCH_INTEGRATION", "KILL_SWITCH_INTENT"])
}

test_restricted_classification_denied if denied(fx.with_resource(fx.avery_appt, {"classification": "PHI_RESTRICTED"}), ["CLASSIFICATION_NOT_PERMITTED"])

test_purpose_not_permitted_action_level if denied(object.union(fx.avery_appt, {"purpose": "staff_support"}), ["PURPOSE_NOT_PERMITTED"])

test_purpose_not_permitted_path_level if denied(object.union(fx.avery_appt, {"purpose": "representative_access"}), ["PURPOSE_NOT_PERMITTED"])

test_tool_minimum_a3_requires_bound_step_up if {
	x := object.union(fx.avery_appt, {"tool": fx.tool("A3")})
	denied_with(x, ["ASSURANCE_INSUFFICIENT", "STEP_UP_REQUIRED"], ["REQUIRE_STEP_UP"])
}

test_ops03_unreadable_tool_minimum_fails_closed if {
	x := object.union(fx.avery_appt, {"tool": fx.tool("A9")})
	denied(x, ["ASSURANCE_INSUFFICIENT"])
}

test_ops03_unreadable_session_assurance_fails_closed if {
	denied(fx.with_auth(fx.avery_appt, {"assurance": "AX"}), ["ASSURANCE_INSUFFICIENT"])
}

test_treating_provider_appointment_read_allowed if allowed(fx.morgan_treating_appt, ["ALLOW_TREATING_PROVIDER"])

test_auth05_provider_cannot_read_unrelated_client_appointment if {
	x := fx.with_resource(fx.morgan_treating_appt, {"subjectId": fx.blake.subject})
	denied(x, ["RELATIONSHIP_NOT_ESTABLISHED"])
}

test_auth05_provider_knowing_identifiers_and_practice_does_not_reach_client if {
	# Practice membership with appointment:read scope never reaches an individual's appointment.
	x := fx.with_resource(fx.morgan_treating_appt, {"subjectId": fx.blake.subject, "organizationId": fx.north})
	denied(x, ["RELATIONSHIP_NOT_ESTABLISHED"])
}

test_treating_provider_requires_scope if {
	x := object.union(fx.morgan_treating_appt, {"relationships": [object.union(fx.treating_fact(fx.morgan, fx.avery), {"scopes": []})]})
	denied(x, ["SCOPE_NOT_GRANTED"])
}

test_treating_provider_expired_relationship if {
	x := object.union(fx.morgan_treating_appt, {"relationships": [object.union(fx.treating_fact(fx.morgan, fx.avery), {"validUntil": fx.earlier})]})
	denied_with(x, ["AUTHORIZATION_EXPIRED"], ["REQUIRE_HUMAN"])
}

test_multi_role_privileges_never_combined if {
	# Morgan selects "client": provider facts are not valid for that role.
	x := fx.with_auth(fx.morgan_treating_appt, {"selectedRole": "client"})
	denied(x, ["RELATIONSHIP_NOT_ESTABLISHED"])
}

test_representative_with_valid_authority_allowed if allowed(fx.emery_rep_appt, ["ALLOW_REPRESENTATIVE"])

test_auth05_expired_proxy_denied_to_human if {
	x := object.union(fx.emery_rep_appt, {"relationships": [object.union(fx.rep_fact(fx.emery, fx.blake, ["appointment:read"]), {"validUntil": "2026-06-30T23:59:59.000Z"})]})
	denied_with(x, ["AUTHORIZATION_EXPIRED"], ["REQUIRE_HUMAN"])
}

test_representative_expired_constraint_without_date if {
	x := object.union(fx.emery_rep_appt, {"relationships": [object.union(fx.rep_fact(fx.emery, fx.blake, ["appointment:read"]), {"constraints": ["AUTHORIZATION_EXPIRED"]})]})
	denied_with(x, ["AUTHORIZATION_EXPIRED"], ["REQUIRE_HUMAN"])
}

test_representative_old_expired_grant_ignored_when_current_grant_exists if {
	old := object.union(fx.rep_fact(fx.emery, fx.blake, ["appointment:read"]), {"validUntil": fx.earlier})
	x := object.union(fx.emery_rep_appt, {"relationships": [old, fx.rep_fact(fx.emery, fx.blake, ["appointment:read"])]})
	allowed(x, ["ALLOW_REPRESENTATIVE"])
}

dana_casey_appt := fx.req(
	"appointment:read", "representative_access",
	fx.auth(fx.dana.actor, "personal_representative", null, null, "A2"),
	fx.resource("appointment", fx.casey.subject, null, "PHI"),
	[object.union(
		fx.fact("parental_authority", fx.dana.actor, fx.casey.subject, null, ["appointment:read", "invoice:read"], "legal_authority_registry"),
		{"constraints": ["MINOR_CONFIDENTIALITY_REVIEW"]},
	)],
)

test_minor_confidentiality_review_requires_human if denied_with(dana_casey_appt, ["MINOR_CONFIDENTIALITY_REVIEW"], ["REQUIRE_HUMAN"])

test_custody_dispute_requires_human if {
	x := object.union(dana_casey_appt, {"relationships": [object.union(dana_casey_appt.relationships[0], {"constraints": ["CUSTODY_DISPUTE"]})]})
	denied_with(x, ["CUSTODY_DISPUTE"], ["REQUIRE_HUMAN"])
}

test_constraint_on_any_matching_fact_wins if {
	clean := fx.fact("legal_representative", fx.dana.actor, fx.casey.subject, null, ["appointment:read"], "legal_authority_registry")
	x := object.union(dana_casey_appt, {"relationships": [dana_casey_appt.relationships[0], clean]})
	denied_with(x, ["MINOR_CONFIDENTIALITY_REVIEW"], ["REQUIRE_HUMAN"])
}

test_representative_scope_must_match_action if {
	x := object.union(fx.emery_rep_appt, {"relationships": [fx.rep_fact(fx.emery, fx.blake, ["invoice:read"])]})
	denied(x, ["SCOPE_NOT_GRANTED"])
}

test_representative_from_non_authoritative_source if {
	x := object.union(fx.emery_rep_appt, {"relationships": [object.union(fx.rep_fact(fx.emery, fx.blake, ["appointment:read"]), {"source": "identity_provider"})]})
	denied(x, ["RELATIONSHIP_NOT_ESTABLISHED"])
}

test_representative_wrong_purpose if denied(object.union(fx.emery_rep_appt, {"purpose": "caller_self_service"}), ["PURPOSE_NOT_PERMITTED"])

test_auth05_partner_denied_individual_appointment if {
	x := fx.req(
		"appointment:read", "partner_administration",
		fx.auth(fx.quinn.actor, "partner", null, fx.acme, "A2"),
		fx.resource("appointment", fx.avery.subject, fx.acme, "PHI"),
		[fx.partner_fact(fx.quinn, fx.acme, ["partner_intake:create", "case:read", "appointment:read"])],
	)
	denied(x, ["PARTNER_NO_INDIVIDUAL_ACCESS", "PURPOSE_NOT_PERMITTED", "RELATIONSHIP_NOT_ESTABLISHED", "ROLE_NOT_PERMITTED"])
}

test_practice_staff_cannot_read_appointments if {
	x := fx.req(
		"appointment:read", "delegated_practice_administration",
		fx.auth(fx.riley.actor, "practice_staff", null, fx.north, "A2"),
		fx.resource("appointment", fx.avery.subject, fx.north, "PHI"),
		[fx.delegate_fact(fx.riley, fx.north, ["appointment:read"])],
	)
	denied(x, ["RELATIONSHIP_NOT_ESTABLISHED", "ROLE_NOT_PERMITTED"])
}

# ------------------------------------------------- prepare / commit change ----

test_prepare_change_self_allowed_requires_confirmation if {
	allowed(fx.avery_prepare, ["ALLOW_SELF"])
	decide(fx.avery_prepare).obligations == ["REQUIRE_CONFIRMATION"]
}

test_prepare_change_writes_kill_switch if denied(fx.with_ks(fx.avery_prepare, {"writes": true}), ["KILL_SWITCH_WRITES"])

test_prepare_change_safety_mode_revokes_mutations if {
	denied(fx.with_auth(fx.avery_prepare, {"riskFlags": ["SAFETY_ESCALATION_ACTIVE"]}), ["SAFETY_MODE_MUTATIONS_REVOKED"])
}

test_prepare_change_not_for_representative_or_provider if {
	rep := object.union(fx.emery_rep_appt, {"action": "appointment:prepare_change"})
	denied(rep, ["PURPOSE_NOT_PERMITTED", "RELATIONSHIP_NOT_ESTABLISHED", "ROLE_NOT_PERMITTED"])
	prov := object.union(fx.morgan_treating_appt, {"action": "appointment:prepare_change"})
	denied(prov, ["RELATIONSHIP_NOT_ESTABLISHED", "ROLE_NOT_PERMITTED"])
}

test_commit_change_with_digest_allowed if {
	allowed(fx.avery_commit, ["ALLOW_SELF"])
	decide(fx.avery_commit).obligations == ["REQUIRE_CONFIRMATION"]
}

test_act01_commit_change_requires_action_digest if {
	denied(fx.with_resource(fx.avery_commit, {"actionDigest": null}), ["ACTION_DIGEST_REQUIRED"])
	denied(fx.with_resource(fx.avery_commit, {"actionDigest": "not-a-digest"}), ["ACTION_DIGEST_REQUIRED"])
}

test_commit_change_writes_and_safety_mode if {
	denied(fx.with_ks(fx.avery_commit, {"writes": true}), ["KILL_SWITCH_WRITES"])
	denied(fx.with_auth(fx.avery_commit, {"riskFlags": ["SAFETY_ESCALATION_ACTIVE"]}), ["SAFETY_MODE_MUTATIONS_REVOKED"])
}

a3_commit := object.union(fx.avery_commit, {"tool": fx.tool("A3")})

test_commit_a3_with_bound_step_up_allowed if {
	x := fx.with_auth(a3_commit, {"assurance": "A3", "stepUpDigest": fx.digest_a, "stepUpExpiresAt": fx.later})
	allowed(x, ["ALLOW_SELF"])
}

test_commit_a3_step_up_for_other_action_denied if {
	x := fx.with_auth(a3_commit, {"assurance": "A3", "stepUpDigest": fx.digest_b, "stepUpExpiresAt": fx.later})
	denied_with(x, ["ASSURANCE_INSUFFICIENT", "STEP_UP_DIGEST_MISMATCH"], ["REQUIRE_STEP_UP"])
}

test_commit_a3_expired_step_up_denied if {
	x := fx.with_auth(a3_commit, {"assurance": "A3", "stepUpDigest": fx.digest_a, "stepUpExpiresAt": fx.now})
	denied_with(x, ["ASSURANCE_INSUFFICIENT", "STEP_UP_EXPIRED"], ["REQUIRE_STEP_UP"])
}

test_commit_a3_without_step_up_denied if {
	denied_with(a3_commit, ["ASSURANCE_INSUFFICIENT", "STEP_UP_REQUIRED"], ["REQUIRE_STEP_UP"])
}

test_a3_session_counts_as_a2_for_other_actions if {
	x := fx.with_auth(fx.avery_commit, {"assurance": "A3", "stepUpDigest": fx.digest_b, "stepUpExpiresAt": fx.later})
	allowed(x, ["ALLOW_SELF"])
}

test_commit_below_a2_denied if denied(fx.with_auth(fx.avery_commit, {"assurance": "A1"}), ["ASSURANCE_INSUFFICIENT"])

# ---------------------------------------------------------- invoice / billing ----

test_invoice_self_allowed_with_line_fields if {
	allowed(fx.avery_invoice, ["ALLOW_SELF"])
	"lines.amountMinor" in decide(fx.avery_invoice).fieldMask
}

test_invoice_representative_allowed if {
	x := object.union(fx.emery_rep_appt, {"action": "invoice:read", "resource": fx.resource("invoice", fx.blake.subject, null, "FINANCIAL")})
	allowed(x, ["ALLOW_REPRESENTATIVE"])
}

test_auth05_provider_cannot_read_client_invoice if {
	x := object.union(fx.morgan_treating_appt, {"action": "invoice:read", "resource": fx.resource("invoice", fx.avery.subject, null, "FINANCIAL")})
	denied(x, ["RELATIONSHIP_NOT_ESTABLISHED", "ROLE_NOT_PERMITTED"])
}

test_invoice_internal_classification_denied if denied(fx.with_resource(fx.avery_invoice, {"classification": "INTERNAL"}), ["CLASSIFICATION_NOT_PERMITTED"])

test_invoice_minor_confidentiality if {
	x := object.union(dana_casey_appt, {"action": "invoice:read", "resource": fx.resource("invoice", fx.casey.subject, null, "FINANCIAL")})
	denied_with(x, ["MINOR_CONFIDENTIALITY_REVIEW"], ["REQUIRE_HUMAN"])
}

test_billing_review_self_allowed_never_refund if {
	allowed(fx.avery_billing, ["ALLOW_SELF"])
	d := decide(fx.avery_billing)
	d.obligations == ["REQUIRE_CONFIRMATION"]
	d.fieldMask == ["reviewId", "status", "supportReference"]
	every f in d.fieldMask {
		not contains(lower(f), "refund")
	}
}

test_billing_review_requires_digest_and_writes if {
	denied(fx.with_resource(fx.avery_billing, {"actionDigest": null}), ["ACTION_DIGEST_REQUIRED"])
	denied(fx.with_ks(fx.avery_billing, {"writes": true}), ["KILL_SWITCH_WRITES"])
	denied(fx.with_ks(fx.avery_billing, {"intents": ["billing_dispute"]}), ["KILL_SWITCH_INTENT"])
}

test_billing_review_not_for_provider if {
	x := object.union(fx.avery_billing, {"auth": fx.morgan_treating_appt.auth, "relationships": fx.morgan_treating_appt.relationships})
	denied(x, ["RELATIONSHIP_NOT_ESTABLISHED", "ROLE_NOT_PERMITTED"])
}

# ----------------------------------------------------------------- claim ----

test_claim_self_allowed if allowed(fx.avery_claim, ["ALLOW_SELF"])

test_claim_not_for_representative if {
	x := object.union(fx.emery_rep_appt, {"action": "claim:read", "resource": fx.resource("claim", fx.blake.subject, null, "PHI")})
	denied(x, ["PURPOSE_NOT_PERMITTED", "RELATIONSHIP_NOT_ESTABLISHED", "ROLE_NOT_PERMITTED"])
}

test_claim_integration_kill_switch if denied(fx.with_ks(fx.avery_claim, {"integrations": ["claims"]}), ["KILL_SWITCH_INTEGRATION"])

# ------------------------------------------------------------ onboarding ----

test_onboarding_provider_self_allowed if allowed(fx.newbie_onboarding, ["ALLOW_SELF"])

test_auth05_provider_cannot_read_other_provider_onboarding if {
	denied(fx.with_resource(fx.newbie_onboarding, {"subjectId": fx.morgan.subject}), ["RELATIONSHIP_NOT_ESTABLISHED"])
}

test_onboarding_practice_delegate_allowed if allowed(fx.riley_onboarding, ["ALLOW_PRACTICE_DELEGATION"])

test_onboarding_practice_delegate_other_practice_denied if {
	denied(fx.with_resource(fx.riley_onboarding, {"organizationId": fx.south}), ["RELATIONSHIP_NOT_ESTABLISHED"])
}

test_onboarding_delegate_without_scope if {
	x := object.union(fx.riley_onboarding, {"relationships": [fx.delegate_fact(fx.riley, fx.north, ["remittance:read"])]})
	denied(x, ["SCOPE_NOT_GRANTED"])
}

test_onboarding_never_phi if denied(fx.with_resource(fx.riley_onboarding, {"classification": "PHI"}), ["CLASSIFICATION_NOT_PERMITTED"])

test_onboarding_not_for_clients if {
	x := object.union(fx.avery_appt, {"action": "onboarding:read", "resource": fx.resource("provider_onboarding", fx.avery.subject, null, "INTERNAL")})
	denied(x, ["RELATIONSHIP_NOT_ESTABLISHED", "ROLE_NOT_PERMITTED"])
}

# ------------------------------------------------------------- remittance ----

test_remittance_practice_delegate_allowed if allowed(fx.riley_remit, ["ALLOW_PRACTICE_DELEGATION"])

test_remittance_practice_member_allowed if {
	x := fx.req(
		"remittance:read", "caller_self_service",
		fx.auth(fx.morgan.actor, "provider", fx.morgan.subject, fx.north, "A2"),
		fx.resource("remittance", null, fx.north, "FINANCIAL"),
		[fx.member_fact(fx.morgan, fx.north, ["remittance:read"])],
	)
	allowed(x, ["ALLOW_PRACTICE_DELEGATION"])
}

test_auth05_remittance_other_practice_denied if denied(fx.with_resource(fx.riley_remit, {"organizationId": fx.south}), ["RELATIONSHIP_NOT_ESTABLISHED"])

test_remittance_org_scope_never_reaches_individual if {
	denied(fx.with_resource(fx.riley_remit, {"subjectId": fx.avery.subject}), ["RELATIONSHIP_NOT_ESTABLISHED"])
}

test_remittance_expired_delegation if {
	x := object.union(fx.riley_remit, {"relationships": [object.union(fx.delegate_fact(fx.riley, fx.north, ["remittance:read"]), {"validUntil": fx.earlier})]})
	denied_with(x, ["AUTHORIZATION_EXPIRED"], ["REQUIRE_HUMAN"])
}

test_remittance_delegate_fact_wrong_source if {
	x := object.union(fx.riley_remit, {"relationships": [object.union(fx.delegate_fact(fx.riley, fx.north, ["remittance:read"]), {"source": "enrollment_system"})]})
	denied(x, ["RELATIONSHIP_NOT_ESTABLISHED"])
}

test_remittance_role_switch_drops_delegation if {
	x := fx.with_auth(fx.riley_remit, {"selectedRole": "partner"})
	denied(x, ["RELATIONSHIP_NOT_ESTABLISHED", "ROLE_NOT_PERMITTED"])
}

test_remittance_unaffiliated_provider_denied if {
	x := fx.req(
		"remittance:read", "caller_self_service",
		fx.auth(fx.newbie.actor, "provider", fx.newbie.subject, null, "A2"),
		fx.resource("remittance", null, fx.north, "FINANCIAL"),
		[fx.self_fact(fx.newbie)],
	)
	denied(x, ["RELATIONSHIP_NOT_ESTABLISHED"])
}

# ---------------------------------------------------------- partner intake ----

test_partner_intake_allowed if {
	allowed(fx.quinn_intake, ["ALLOW_PARTNER_AFFILIATION"])
	allowed(fx.with_auth(fx.quinn_intake, {"selectedRole": "payer_representative"}), ["ALLOW_PARTNER_AFFILIATION"])
}

test_partner_intake_other_organization_denied if denied(fx.with_resource(fx.quinn_intake, {"organizationId": fx.north}), ["RELATIONSHIP_NOT_ESTABLISHED"])

test_auth05_partner_intake_individual_subject_denied if {
	denied(fx.with_resource(fx.quinn_intake, {"subjectId": fx.avery.subject}), ["PARTNER_NO_INDIVIDUAL_ACCESS", "RELATIONSHIP_NOT_ESTABLISHED"])
}

test_partner_intake_requires_scope if {
	x := object.union(fx.quinn_intake, {"relationships": [fx.partner_fact(fx.quinn, fx.acme, ["case:read"])]})
	denied(x, ["SCOPE_NOT_GRANTED"])
}

test_partner_intake_requires_a2 if denied(fx.with_auth(fx.quinn_intake, {"assurance": "A1"}), ["ASSURANCE_INSUFFICIENT"])

test_partner_intake_purpose if denied(object.union(fx.quinn_intake, {"purpose": "caller_self_service"}), ["PURPOSE_NOT_PERMITTED"])

test_partner_email_domain_style_claim_establishes_nothing if {
	# Same organization in the session but no authoritative affiliation fact.
	denied(object.union(fx.quinn_intake, {"relationships": []}), ["RELATIONSHIP_NOT_ESTABLISHED"])
}

# ------------------------------------------------------------------ case ----

test_case_self_allowed if allowed(fx.avery_case, ["ALLOW_SELF"])

test_case_practice_org_allowed if {
	x := object.union(fx.riley_remit, {"action": "case:read", "resource": fx.resource("support_case", null, fx.north, "INTERNAL")})
	allowed(x, ["ALLOW_PRACTICE_DELEGATION"])
}

test_case_partner_org_allowed if {
	x := object.union(fx.quinn_intake, {"action": "case:read", "resource": fx.resource("support_case", null, fx.acme, "INTERNAL")})
	allowed(x, ["ALLOW_PARTNER_AFFILIATION"])
}

test_auth05_employer_partner_never_sees_treatment_status if {
	x := object.union(fx.quinn_intake, {"action": "case:read", "resource": fx.resource("support_case", null, fx.acme, "PHI")})
	denied(x, ["CLASSIFICATION_NOT_PERMITTED"])
	y := object.union(fx.quinn_intake, {"action": "case:read", "resource": fx.resource("support_case", fx.avery.subject, fx.acme, "PHI")})
	denied(y, ["PARTNER_NO_INDIVIDUAL_ACCESS", "RELATIONSHIP_NOT_ESTABLISHED"])
}

test_case_practice_org_path_internal_only if {
	x := object.union(fx.riley_remit, {"action": "case:read", "resource": fx.resource("support_case", null, fx.north, "PHI")})
	denied(x, ["CLASSIFICATION_NOT_PERMITTED"])
}

test_case_provider_self_allowed if {
	x := fx.req(
		"case:read", "caller_self_service",
		fx.auth(fx.morgan.actor, "provider", fx.morgan.subject, fx.north, "A2"),
		fx.resource("support_case", fx.morgan.subject, null, "INTERNAL"),
		[fx.self_fact(fx.morgan)],
	)
	allowed(x, ["ALLOW_SELF"])
}

# --------------------------------------------------------- support request ----

test_support_request_anonymous_without_subject_allowed if {
	allowed(fx.anon("support_request:create", "caller_self_service", "support_request", "INTERNAL"), ["ALLOW_MINIMAL_INTAKE"])
}

test_support_request_anonymous_with_subject_denied if {
	x := fx.with_resource(fx.anon("support_request:create", "caller_self_service", "support_request", "INTERNAL"), {"subjectId": fx.avery.subject})
	denied(x, ["RELATIONSHIP_NOT_ESTABLISHED", "ROLE_NOT_SELECTED"])
}

support_self := object.union(fx.avery_case, {"action": "support_request:create", "resource": fx.resource("support_request", fx.avery.subject, null, "PHI")})

test_support_request_self_with_subject_allowed if allowed(support_self, ["ALLOW_SELF"])

test_support_request_self_with_subject_requires_a2 if denied(fx.with_auth(support_self, {"assurance": "A0"}), ["ASSURANCE_INSUFFICIENT"])

test_support_request_for_other_subject_denied if denied(fx.with_resource(support_self, {"subjectId": fx.blake.subject}), ["RELATIONSHIP_NOT_ESTABLISHED"])

test_support_request_representative_allowed if {
	x := object.union(fx.emery_rep_appt, {
		"action": "support_request:create",
		"resource": fx.resource("support_request", fx.blake.subject, null, "PHI"),
		"relationships": [fx.rep_fact(fx.emery, fx.blake, ["support_request:create"])],
	})
	allowed(x, ["ALLOW_REPRESENTATIVE"])
}

# ------------------------------------------------------ multiple reasons ----

test_all_deny_reasons_reported_together if {
	x := fx.with_ks(
		fx.with_resource(
			fx.with_auth(fx.avery_prepare, {
				"expiresAt": fx.earlier,
				"riskFlags": ["FRAUD_REVIEW", "SAFETY_ESCALATION_ACTIVE"],
				"consentAutomatedProcessing": "DECLINED",
			}),
			{"tenantId": fx.other_tenant},
		),
		{"aiAdmission": true, "writes": true},
	)
	denied_with(
		x, [
			"CONSENT_DECLINED_ALTERNATIVE_ROUTE",
			"KILL_SWITCH_AI_ADMISSION",
			"KILL_SWITCH_WRITES",
			"RISK_FRAUD_REVIEW",
			"SAFETY_MODE_MUTATIONS_REVOKED",
			"SESSION_INVALID",
			"TENANT_MISMATCH",
		],
		["REQUIRE_HUMAN"],
	)
}

test_ops03_malformed_relationship_fact_ignored if {
	broken := object.remove(fx.self_fact(fx.avery), ["constraints"])
	denied(object.union(fx.avery_appt, {"relationships": [broken]}), ["RELATIONSHIP_NOT_ESTABLISHED"])
}

test_ops03_unreadable_fact_expiry_treated_expired if {
	x := object.union(fx.emery_rep_appt, {"relationships": [object.union(fx.rep_fact(fx.emery, fx.blake, ["appointment:read"]), {"validUntil": "soon"})]})
	denied_with(x, ["AUTHORIZATION_EXPIRED"], ["REQUIRE_HUMAN"])
}

test_allowed_decisions_never_expose_unlisted_fields if {
	every x in [fx.avery_appt, fx.avery_invoice, fx.avery_claim, fx.riley_remit, fx.quinn_intake] {
		d := decide(x)
		d.allow
		every f in d.fieldMask {
			f in data.vsp.catalogue.actions[x.action].fieldMask
		}
	}
}
