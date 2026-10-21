# METADATA
# title: Unit tests for vsp/console/decision (SYNTHETIC staff identities)
package vsp.console_test

import data.vsp.console
import data.vsp.fixtures_test as fx

decide(x) := d if {
	d := console.decision with input as x
}

allowed(x, reasons, obligations) if {
	d := decide(x)
	d.allow == true
	d.reasonCodes == reasons
	d.obligations == obligations
}

denied(x, reasons) if {
	d := decide(x)
	d.allow == false
	d.reasonCodes == reasons
	d.obligations == ["AUDIT_ADMIN_ACTION"]
}

staff_ids := {
	"support_agent": "stf_synthSupportAgent1",
	"supervisor": "stf_synthSupervisor01",
	"safety_responder": "stf_synthSafetyResp001",
	"auditor": "stf_synthAuditor00001",
	"knowledge_editor": "stf_synthKnowledgeEd1",
	"policy_approver": "stf_synthPolicyApprov1",
	"deployment_operator": "stf_synthDeployOper01",
	"security_admin": "stf_synthSecurityAdm1",
}

staff(role) := {
	"staffId": staff_ids[role],
	"tenantId": fx.tenant,
	"roles": [role],
	"mfa": true,
	"authenticatedAt": "2026-10-17T14:00:00.000Z",
	"breakGlass": null,
}

resource := {
	"type": "console_resource",
	"tenantId": fx.tenant,
	"killSwitchScope": null,
	"initiatorStaffId": null,
	"assignedStaffId": null,
}

creq(action, s) := {
	"action": action,
	"origin": "workforce_console",
	"environment": "local",
	"now": fx.now,
	"staff": s,
	"resource": resource,
}

with_staff(x, patch) := object.union(x, {"staff": object.union(x.staff, patch)})

with_resource(x, patch) := object.union(x, {"resource": object.union(x.resource, patch)})

valid_break_glass := {
	"grantId": "bgl_synthBreakGlass0001",
	"approvedBy": "stf_synthSecurityAdm1",
	"justificationCode": "ACTIVE_SAFETY_INCIDENT",
	"grantedAt": "2026-10-17T14:30:00.000Z",
	"expiresAt": "2026-10-17T16:30:00.000Z",
}

restricted_view(role) := with_staff(creq("restricted_record:view", staff(role)), {"breakGlass": valid_break_glass})

# ------------------------------------------------------------- deny default ----

test_unknown_console_action_default_deny if denied(creq("console:do_anything", staff("security_admin")), ["ACTION_UNKNOWN", "DEFAULT_DENY"])

test_empty_console_input_denies if {
	d := console.decision with input as {}
	d.allow == false
}

test_prohibited_console_actions_never_allowed if {
	every a in ["db:raw_query", "secret:view", "transcript:download_unrestricted", "audit:modify", "audit:delete", "break_glass:self_grant"] {
		every r, _ in staff_ids {
			d := decide(creq(a, staff(r)))
			d.allow == false
			"CONSOLE_ACTION_PROHIBITED" in d.reasonCodes
		}
	}
}

# ------------------------------------------------------------- role separation ----

role_matrix := [
	["journey:inspect", "support_agent", "auditor"],
	["call:join", "safety_responder", "knowledge_editor"],
	["call:transfer", "supervisor", "deployment_operator"],
	["pending_action:review", "support_agent", "safety_responder"],
	["pending_action:cancel", "supervisor", "security_admin"],
	["operation:retry_reconciled", "supervisor", "support_agent"],
	["dlq:repair", "supervisor", "deployment_operator"],
	["human_task:decide", "support_agent", "policy_approver"],
	["safety_event:view", "safety_responder", "support_agent"],
	["safety_event:acknowledge", "supervisor", "knowledge_editor"],
	["audit:search", "auditor", "supervisor"],
	["audit:verify_integrity", "security_admin", "support_agent"],
	["knowledge:edit", "knowledge_editor", "policy_approver"],
	["knowledge:submit_release", "knowledge_editor", "supervisor"],
	["policy:review", "auditor", "support_agent"],
	["deployment:deploy", "deployment_operator", "security_admin"],
	["deployment:rollback", "deployment_operator", "supervisor"],
	["budget:define", "deployment_operator", "support_agent"],
	["recovery_identity:propose", "security_admin", "supervisor"],
	["recovery_identity:revoke", "security_admin", "auditor"],
	["secret:rotate", "security_admin", "deployment_operator"],
	["break_glass:request", "support_agent", "auditor"],
	["operations:overview", "safety_responder", "auditor"],
	["budget:view", "deployment_operator", "support_agent"],
	["kill_switch:view", "security_admin", "safety_responder"],
	["reconciliation:view", "supervisor", "support_agent"],
	["human_task:view", "support_agent", "safety_responder"],
	["release:view", "knowledge_editor", "supervisor"],
]

test_each_console_action_allowed_for_its_role if {
	every row in role_matrix {
		d := decide(creq(row[0], staff(row[1])))
		d.allow == true
		"AUDIT_ADMIN_ACTION" in d.obligations
	}
}

test_each_console_action_denied_for_other_role if {
	every row in role_matrix {
		d := decide(creq(row[0], staff(row[2])))
		d.allow == false
		"ROLE_NOT_PERMITTED" in d.reasonCodes
	}
}

# Every console read action (least privilege; none mutates, so the auditor taint never applies) with the exact role
# set a plain staff request (MFA, no break-glass grant) is allowed for. An empty set: no role may read it that way
# (restricted_record:view needs a break-glass grant, tested in its own tests; secret:view and
# transcript:download_unrestricted are granted to no role).
console_read_role_sets := {
	"console:session": {"auditor", "deployment_operator", "knowledge_editor", "policy_approver", "safety_responder", "security_admin", "support_agent", "supervisor"},
	"operations:overview": {"deployment_operator", "safety_responder", "security_admin", "support_agent", "supervisor"},
	"budget:view": {"deployment_operator", "security_admin", "supervisor"},
	"kill_switch:view": {"deployment_operator", "security_admin", "supervisor"},
	"reconciliation:view": {"supervisor"},
	"human_task:view": {"support_agent", "supervisor"},
	"journey:inspect": {"safety_responder", "support_agent", "supervisor"},
	"pending_action:review": {"support_agent", "supervisor"},
	"safety_event:view": {"safety_responder", "supervisor"},
	"release:view": {"auditor", "knowledge_editor", "policy_approver", "security_admin"},
	"access_review:view": {"auditor", "security_admin"},
	"recovery_identity:view": {"security_admin"},
	"audit:search": {"auditor", "security_admin"},
	"audit:verify_integrity": {"auditor", "security_admin"},
	"policy:review": {"auditor", "policy_approver", "security_admin"},
	"restricted_record:view": set(),
	"secret:view": set(),
	"transcript:download_unrestricted": set(),
}

role_allowed(set, r) if r in set

role_allowed(set, r) := false if not r in set

# The table pins EVERY read action of the production catalogue, and nothing else: a read action added to the
# catalogue without a pinned role set, or an entry dropped from the table, fails here (no decisions evaluated).
test_console_read_role_sets_cover_every_catalogue_read_action if {
	{a | some a, d in data.vsp.catalogue.console.actions; d.mutates == false} == {a | some a, _ in console_read_role_sets}
}

# Every read action allows exactly its role set and nothing mutates. ONE data-driven test over the whole table: each
# action is its own case (opa test reports a PASS or FAIL line per action), so no table entry can lack its assertion
# and no part of the table can lose its test on its own. It evaluates 144 decisions (about 2.6 s, more under load):
# scripts/policy.sh runs opa test with an explicit 60 s per-test deadline instead of OPA's default 5 s.
test_console_read_role_set[action] if {
	some action, allowed_roles in console_read_role_sets
	data.vsp.catalogue.console.actions[action].mutates == false
	every r, _ in staff_ids {
		d := decide(creq(action, staff(r)))
		d.allow == role_allowed(allowed_roles, r)
	}
}

test_console_session_for_every_staff_role_but_never_without_mfa if {
	every r, _ in staff_ids {
		allowed(creq("console:session", staff(r)), ["ALLOW_STAFF_ROLE"], ["AUDIT_ADMIN_ACTION"])
		denied(with_staff(creq("console:session", staff(r)), {"mfa": false}), ["STAFF_MFA_REQUIRED"])
	}
	denied(object.union(creq("console:session", staff("supervisor")), {"origin": "conversational_agent"}), ["ORIGIN_NOT_PERMITTED"])
}

test_console_read_actions_never_mutate_anything_for_auditor if {
	allowed(creq("release:view", staff("auditor")), ["ALLOW_STAFF_ROLE"], ["AUDIT_ADMIN_ACTION"])
	denied(creq("reconciliation:view", staff("auditor")), ["ROLE_NOT_PERMITTED"])
	allowed(creq("reconciliation:view", staff("supervisor")), ["ALLOW_STAFF_ROLE"], ["AUDIT_ADMIN_ACTION", "AUDIT_READ"])
}

test_audit_search_obligations if allowed(creq("audit:search", staff("auditor")), ["ALLOW_STAFF_ROLE"], ["AUDIT_ADMIN_ACTION", "AUDIT_READ"])

mutating_actions := [name | some name, d in data.vsp.catalogue.console.actions; d.mutates == true]

test_auditor_cannot_mutate_anything if {
	count(mutating_actions) > 10
	every name in mutating_actions {
		r := decide(creq(name, staff("auditor")))
		r.allow == false
		"AUDITOR_READ_ONLY" in r.reasonCodes
	}
}

test_auditor_role_taints_combined_identity if {
	x := with_staff(creq("secret:rotate", staff("security_admin")), {"roles": ["auditor", "security_admin"]})
	denied(x, ["AUDITOR_READ_ONLY"])
}

test_auditor_combined_identity_can_still_read if {
	x := with_staff(creq("audit:search", staff("security_admin")), {"roles": ["auditor", "security_admin"]})
	allowed(x, ["ALLOW_STAFF_ROLE"], ["AUDIT_ADMIN_ACTION", "AUDIT_READ"])
}

test_support_agent_cancels_only_own_handoff if {
	own := with_resource(creq("pending_action:cancel", staff("support_agent")), {"assignedStaffId": staff_ids.support_agent})
	allowed(own, ["ALLOW_ASSIGNED_STAFF"], ["AUDIT_ADMIN_ACTION"])
	other := with_resource(creq("pending_action:cancel", staff("support_agent")), {"assignedStaffId": staff_ids.supervisor})
	denied(other, ["ROLE_NOT_PERMITTED"])
}

test_kill_switch_roles_per_scope if {
	ai := with_resource(creq("kill_switch:engage", staff("supervisor")), {"killSwitchScope": "AI_ADMISSION"})
	allowed(ai, ["ALLOW_STAFF_ROLE"], ["AUDIT_ADMIN_ACTION"])
	deploy_ai := with_resource(creq("kill_switch:engage", staff("deployment_operator")), {"killSwitchScope": "AI_ADMISSION"})
	denied(deploy_ai, ["ROLE_NOT_PERMITTED"])
	deploy_model := with_resource(creq("kill_switch:release", staff("deployment_operator")), {"killSwitchScope": "MODEL_VERSION"})
	allowed(deploy_model, ["ALLOW_STAFF_ROLE"], ["AUDIT_ADMIN_ACTION"])
}

test_kill_switch_scope_required if {
	denied(creq("kill_switch:engage", staff("security_admin")), ["KILL_SWITCH_SCOPE_REQUIRED", "ROLE_NOT_PERMITTED"])
}

# --------------------------------------------------------------------- MFA ----

test_mfa_required_for_every_console_action if {
	every row in role_matrix {
		x := with_staff(creq(row[0], staff(row[1])), {"mfa": false})
		denied(x, ["STAFF_MFA_REQUIRED"])
	}
}

test_stale_staff_authentication_denied if {
	denied(with_staff(creq("audit:search", staff("auditor")), {"authenticatedAt": "2026-10-16T14:59:59.999Z"}), ["STAFF_AUTH_STALE"])
}

test_future_staff_authentication_denied if {
	denied(with_staff(creq("audit:search", staff("auditor")), {"authenticatedAt": "2026-10-17T15:10:00.000Z"}), ["STAFF_AUTH_TIME_INVALID"])
}

test_unreadable_staff_authentication_denied if {
	denied(with_staff(creq("audit:search", staff("auditor")), {"authenticatedAt": "recently"}), ["STAFF_AUTH_TIME_INVALID"])
}

# -------------------------------------------------- origin and separation ----

test_model_cannot_reach_console_actions if {
	x := object.union(creq("break_glass:request", staff("support_agent")), {"origin": "conversational_agent"})
	denied(x, ["ORIGIN_NOT_PERMITTED"])
	y := object.union(creq("kill_switch:release", staff("security_admin")), {"origin": "service_automation"})
	"ORIGIN_NOT_PERMITTED" in decide(y).reasonCodes
}

test_tenant_isolation if {
	denied(with_resource(creq("journey:inspect", staff("supervisor")), {"tenantId": fx.other_tenant}), ["TENANT_MISMATCH"])
}

test_policy_approver_cannot_approve_own_change if {
	x := with_resource(creq("policy:approve", staff("policy_approver")), {"initiatorStaffId": staff_ids.policy_approver})
	denied(x, ["SELF_APPROVAL_PROHIBITED"])
	y := with_resource(creq("policy:approve", staff("policy_approver")), {"initiatorStaffId": staff_ids.knowledge_editor})
	allowed(y, ["ALLOW_STAFF_ROLE"], ["AUDIT_ADMIN_ACTION"])
	denied(creq("policy:approve", staff("policy_approver")), ["INITIATOR_REQUIRED"])
}

test_break_glass_approval_never_self if {
	x := with_resource(creq("break_glass:approve", staff("security_admin")), {"initiatorStaffId": staff_ids.security_admin})
	denied(x, ["SELF_APPROVAL_PROHIBITED"])
	y := with_resource(creq("break_glass:approve", staff("security_admin")), {"initiatorStaffId": staff_ids.supervisor})
	allowed(y, ["ALLOW_STAFF_ROLE"], ["AUDIT_ADMIN_ACTION"])
	denied(creq("break_glass:approve", staff("security_admin")), ["INITIATOR_REQUIRED"])
}

# WP-05: the holder never reviews their own emergency access; recovery identities need a second admin.
test_access_review_and_recovery_identity_approval_never_self if {
	every action in ["access_review:perform", "recovery_identity:approve"] {
		denied(with_resource(creq(action, staff("security_admin")), {"initiatorStaffId": staff_ids.security_admin}), ["SELF_APPROVAL_PROHIBITED"])
		allowed(with_resource(creq(action, staff("security_admin")), {"initiatorStaffId": staff_ids.supervisor}), ["ALLOW_STAFF_ROLE"], ["AUDIT_ADMIN_ACTION"])
		denied(creq(action, staff("security_admin")), ["INITIATOR_REQUIRED"])
		d := decide(with_resource(creq(action, staff("supervisor")), {"initiatorStaffId": staff_ids.security_admin}))
		d.allow == false
		"ROLE_NOT_PERMITTED" in d.reasonCodes
	}

	# The auditor reads reviews but never completes one (role and read-only taint).
	a := decide(with_resource(creq("access_review:perform", staff("auditor")), {"initiatorStaffId": staff_ids.supervisor}))
	a.allow == false
	"ROLE_NOT_PERMITTED" in a.reasonCodes
}

# WP-05 round 2: only the holder named by a recovery identity confirms it (proof of possession in their own SSO
# session); no role reaches it otherwise, and an unassigned identity is confirmed by nobody.
test_recovery_identity_confirm_only_by_the_named_holder if {
	every role in ["security_admin", "supervisor", "safety_responder"] {
		own := with_resource(creq("recovery_identity:confirm", staff(role)), {"assignedStaffId": staff_ids[role]})
		allowed(own, ["ALLOW_ASSIGNED_STAFF"], ["AUDIT_ADMIN_ACTION"])
	}
	every role in ["security_admin", "supervisor", "safety_responder", "auditor", "support_agent"] {
		other := with_resource(creq("recovery_identity:confirm", staff(role)), {"assignedStaffId": staff_ids.deployment_operator})
		d := decide(other)
		d.allow == false
	}
	denied(creq("recovery_identity:confirm", staff("security_admin")), ["ROLE_NOT_PERMITTED"])

	# A holder whose roles hold no recovery role cannot confirm even their own assignment.
	d := decide(with_resource(creq("recovery_identity:confirm", staff("support_agent")), {"assignedStaffId": staff_ids.support_agent}))
	d.allow == false
}

# --------------------------------------------------------------- break-glass ----

test_break_glass_valid_grant_allows_emergency_view if {
	allowed(restricted_view("supervisor"), ["ALLOW_BREAK_GLASS", "ALLOW_STAFF_ROLE"], ["AUDIT_ADMIN_ACTION", "AUDIT_READ", "BREAK_GLASS_REVIEW"])
}

test_break_glass_required_for_emergency_view if {
	denied(creq("restricted_record:view", staff("supervisor")), ["BREAK_GLASS_REQUIRED"])
}

test_break_glass_never_adds_a_role if {
	denied(restricted_view("support_agent"), ["ROLE_NOT_PERMITTED"])
}

test_break_glass_self_granted_denied_for_any_action if {
	self_bg := object.union(valid_break_glass, {"approvedBy": staff_ids.supervisor})
	denied(with_staff(restricted_view("supervisor"), {"breakGlass": self_bg}), ["BREAK_GLASS_SELF_GRANTED"])
	denied(with_staff(creq("journey:inspect", staff("supervisor")), {"breakGlass": self_bg}), ["BREAK_GLASS_SELF_GRANTED"])
}

test_break_glass_expired_denied if {
	x := with_staff(restricted_view("supervisor"), {"breakGlass": object.union(valid_break_glass, {"expiresAt": fx.now})})
	denied(x, ["BREAK_GLASS_EXPIRED"])
}

test_break_glass_not_yet_valid_denied if {
	bg := object.union(valid_break_glass, {"grantedAt": "2026-10-17T15:05:00.000Z", "expiresAt": "2026-10-17T16:05:00.000Z"})
	denied(with_staff(restricted_view("supervisor"), {"breakGlass": bg}), ["BREAK_GLASS_NOT_YET_VALID"])
}

test_break_glass_duration_bounded if {
	bg := object.union(valid_break_glass, {"grantedAt": "2026-10-17T09:00:00.000Z", "expiresAt": "2026-10-17T21:00:00.000Z"})
	denied(with_staff(restricted_view("supervisor"), {"breakGlass": bg}), ["BREAK_GLASS_DURATION_EXCEEDED"])
}

test_break_glass_justification_required if {
	bg := object.union(valid_break_glass, {"justificationCode": "CURIOSITY"})
	denied(with_staff(restricted_view("supervisor"), {"breakGlass": bg}), ["BREAK_GLASS_JUSTIFICATION_INVALID"])
}

test_break_glass_unreadable_times_fail_closed if {
	bg := object.union(valid_break_glass, {"expiresAt": "later"})
	d := decide(with_staff(restricted_view("supervisor"), {"breakGlass": bg}))
	d.allow == false
	"BREAK_GLASS_EXPIRED" in d.reasonCodes
}

test_expired_break_glass_irrelevant_for_ordinary_actions if {
	bg := object.union(valid_break_glass, {"expiresAt": fx.earlier, "grantedAt": "2026-10-17T13:00:00.000Z"})
	allowed(with_staff(creq("journey:inspect", staff("supervisor")), {"breakGlass": bg}), ["ALLOW_STAFF_ROLE"], ["AUDIT_ADMIN_ACTION", "AUDIT_READ"])
}
