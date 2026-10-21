# METADATA
# title: Catalogue lint tests (structural invariants of the versioned action data)
# description: |
#   These tests fail when catalogue data drifts into an unsafe shape, e.g. a
#   PHI action reachable without a relationship, an exemption outside the two
#   always-available routes, or a mutation that escapes the writes kill switch.
package vsp.catalogue_test

import data.vsp.catalogue

actions := catalogue.actions

classes := {"SAFETY_AND_HUMAN_ROUTE", "PUBLIC_READ", "INTAKE", "VERIFICATION", "PROTECTED_READ", "PREPARE_MUTATION", "COMMIT_MUTATION", "HUMAN_BOUNDARY"}

roles := {"client", "prospective_client", "provider", "practice_staff", "partner", "payer_representative", "personal_representative"}

staff_roles := {"support_agent", "supervisor", "safety_responder", "auditor", "knowledge_editor", "policy_approver", "deployment_operator", "security_admin"}

sensitive := {"PHI", "PHI_RESTRICTED", "FINANCIAL", "VERIFICATION_SECRET"}

test_every_action_has_known_class_and_intent if {
	every name, a in actions {
		a.class in classes
		regex.match(`^[a-z][a-z_]{2,63}$`, a.intent)
		regex.match(`^[a-z_]+:[a-z_]+$`, name)
	}
}

test_exemption_only_for_safety_and_human if {
	every name, a in actions {
		always := name in {"safety:route", "human:request"}
		exempt_switch := a.killSwitchClass == "EXEMPT"
		exempt_class := a.class == "SAFETY_AND_HUMAN_ROUTE"
		exempt_switch == always
		exempt_class == always
	}
}

test_mutations_are_write_class_and_commits_need_digest if {
	every _, a in actions {
		is_mutation := a.class in {"PREPARE_MUTATION", "COMMIT_MUTATION"}
		is_write := a.killSwitchClass == "WRITE"
		is_commit := a.class == "COMMIT_MUTATION"
		is_mutation == is_write
		is_commit == a.requiresActionDigest
	}
}

mutations := [a | some a in actions; a.class in {"PREPARE_MUTATION", "COMMIT_MUTATION"}]

test_mutation_obligations_include_confirmation if {
	count(mutations) >= 3
	every a in mutations {
		"REQUIRE_CONFIRMATION" in a.obligations
		a.protected == true
	}
}

human_boundaries := [a | some a in actions; a.class == "HUMAN_BOUNDARY"]

test_human_boundary_actions_grant_nothing if {
	count(human_boundaries) >= 5
	every a in human_boundaries {
		count(a.access) == 0
		count(a.fieldMask) == 0
	}
}

# Reads and mutations of sensitive data. INTAKE creates a record (which may
# hold caller-volunteered PHI) but discloses nothing: see the intake test.
sensitive_actions := [a |
	some a in actions
	not a.class in {"SAFETY_AND_HUMAN_ROUTE", "HUMAN_BOUNDARY", "INTAKE"}
	some c in a.classifications
	c in sensitive
]

test_sensitive_actions_need_relationship_and_a2 if {
	count(sensitive_actions) > 0
	every a in sensitive_actions {
		a.protected == true
		every p in a.access {
			p.target != "none"
			count(p.factTypes) > 0
			p.minAssurance in {"A2", "A3"}
		}
	}
}

open_read_paths := [p |
	some a in actions
	a.class != "INTAKE"
	some p in a.access
	p.target == "none"
]

test_open_read_paths_only_reach_non_sensitive_data if {
	count(open_read_paths) > 0
	every p in open_read_paths {
		count(p.factTypes) == 0
		every c in p.classifications {
			not c in sensitive
		}
	}
}

intake_actions := [a | some a in actions; a.class == "INTAKE"]

# Intake never discloses records: only a support reference and a status.
test_intake_discloses_nothing_but_reference if {
	count(intake_actions) >= 4
	every a in intake_actions {
		every f in a.fieldMask {
			f in {"status", "supportReference"}
		}
	}
}

covered(list, _) if "*" in list

covered(list, x) if x in list

test_paths_never_widen_action_lists if {
	every _, a in actions {
		every p in a.access {
			every r in p.roles {
				covered(a.roles, r)
			}
			every pu in p.purposes {
				covered(a.purposes, pu)
			}
			every c in p.classifications {
				c in a.classifications
			}
		}
	}
}

test_path_fact_types_valid_for_path_roles if {
	every _, a in actions {
		every p in a.access {
			every t in p.factTypes {
				some r in p.roles
				t in catalogue.roleFactTypes[r]
			}
		}
	}
}

test_grant_reasons_are_reason_codes if {
	every _, a in actions {
		every p in a.access {
			regex.match(`^ALLOW_[A-Z0-9_]{2,57}$`, p.grantReason)
		}
	}
}

test_role_names_are_protocol_roles if {
	every _, a in actions {
		every r in a.roles {
			r in (roles | {"*"})
		}
	}
	every r, _ in catalogue.roleFactTypes {
		r in roles
	}
}

test_every_fact_type_has_authoritative_source if {
	every _, types in catalogue.roleFactTypes {
		every t in types {
			count(catalogue.factSources[t]) > 0
		}
	}
}

partner_paths := [p |
	some a in actions
	some p in a.access
	some r in p.roles
	r in {"partner", "payer_representative"}
]

test_partner_paths_are_organization_scoped if {
	count(partner_paths) > 0
	every p in partner_paths {
		p.target == "organization"
	}
}

test_console_roles_are_staff_roles if {
	every _, a in catalogue.console.actions {
		every r in a.roles {
			r in staff_roles
		}
		every r in a.assignedRoles {
			r in staff_roles
		}
	}
}

auditor_actions := [a | some a in catalogue.console.actions; "auditor" in a.roles]

test_console_auditor_only_on_read_only_actions if {
	count(auditor_actions) > 0
	every a in auditor_actions {
		a.mutates == false
	}
}

prohibited_actions := [a | some a in catalogue.console.actions; a.prohibited == true]

test_console_prohibited_actions_have_no_roles if {
	count(prohibited_actions) >= 5
	every a in prohibited_actions {
		count(a.roles) == 0
		count(a.assignedRoles) == 0
		a.scopeRoles == null
	}
}

test_break_glass_bounds_present if {
	catalogue.console.breakGlass.maxDurationSeconds > 0
	catalogue.console.breakGlass.maxDurationSeconds <= 86400
	count(catalogue.console.breakGlass.justificationCodes) > 0
}

# ------------------------------------------- WP-05: high-risk list and A1 operations ----

human_boundary_not_listed contains name if {
	some name, a in actions
	a.class == "HUMAN_BOUNDARY"
	not name in catalogue.highRisk.humanOnlyActions
}

test_high_risk_list_covers_human_boundaries if count(human_boundary_not_listed) == 0

test_high_risk_list_names_known_actions_never_safety_routes if {
	every name in catalogue.highRisk.humanOnlyActions {
		actions[name]
		not name in {"safety:route", "human:request"}
	}
}

a1_eligible_classes := {"PUBLIC_READ", "INTAKE", "VERIFICATION", "PROTECTED_READ"}

test_a1_operations_are_known_low_risk_and_approved if {
	count(catalogue.assuranceA1.operations) == 0
} else if {
	is_string(catalogue.assuranceA1.approvalRef)
	every name in catalogue.assuranceA1.operations {
		a := actions[name]
		a.class in a1_eligible_classes
		not name in catalogue.highRisk.humanOnlyActions
		every c in a.classifications {
			not c in sensitive
			c != "*"
		}
	}
}

a1_paths_outside_approval contains [name, p.id] if {
	some name, a in actions
	some p in a.access
	p.minAssurance == "A1"
	not name in catalogue.assuranceA1.operations
}

test_a1_path_minimum_only_on_approved_operations if count(a1_paths_outside_approval) == 0
