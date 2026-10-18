# METADATA
# title: Workforce console authorization (entrypoint vsp/console/decision)
# description: |
#   Deny by default. Separated staff roles (spec section 7): support_agent,
#   supervisor, safety_responder, auditor, knowledge_editor, policy_approver,
#   deployment_operator, security_admin. MFA is required for every console
#   action. Auditors are read-only: holding the auditor role taints a staff
#   identity so it cannot mutate anything, whatever other roles it holds.
#   Break-glass is time-bound, justified, approved by someone else and only
#   unlocks actions marked requiresBreakGlass; it never adds a role. Requests
#   from a conversational agent or automation never reach console actions
#   (the model cannot request or grant itself break-glass access).
#
#   Input (TypeScript ConsoleDecisionInput, platform/src/policy/console.ts):
#   {action, origin, environment, now, staff, resource}.
#   Output: {allow, reasonCodes, obligations}, arrays sorted.
#
#   Engineering defaults pending POLICY_RELEASE approval (PRQ-031) and
#   security leadership (break-glass duration, session age).
package vsp.console

import data.vsp.catalogue
import data.vsp.lib

console := catalogue.console

def := console.actions[input.action]

known if def

staff := input.staff

roles := lib.string_set(staff.roles)

now_ms := lib.ts_ms(input.now)

has_role(r) if r in roles

# Anything other than an explicit false counts as mutating (fail closed).
mutates if not def.mutates == false

# ---------------------------------------------------------------------------
# Role checks.
# ---------------------------------------------------------------------------

scope_roles := def.scopeRoles if is_object(def.scopeRoles)

role_grant contains "ALLOW_STAFF_ROLE" if {
	not scope_roles
	some r in def.roles
	has_role(r)
}

role_grant contains "ALLOW_STAFF_ROLE" if {
	some r in scope_roles[input.resource.killSwitchScope]
	has_role(r)
}

role_grant contains "ALLOW_ASSIGNED_STAFF" if {
	some r in def.assignedRoles
	has_role(r)
	is_string(input.resource.assignedStaffId)
	input.resource.assignedStaffId == staff.staffId
}

role_permitted if count(role_grant) > 0

# ---------------------------------------------------------------------------
# Staff authentication freshness.
# ---------------------------------------------------------------------------

auth_ms := lib.ts_ms(staff.authenticatedAt)

auth_time_valid if auth_ms <= now_ms + (console.authFutureSkewSeconds * 1000)

auth_fresh if now_ms - auth_ms <= console.maxAuthAgeSeconds * 1000

# ---------------------------------------------------------------------------
# Break-glass.
# ---------------------------------------------------------------------------

bg := staff.breakGlass

bg_present if is_object(staff.breakGlass)

bg_self_granted if {
	bg_present
	bg.approvedBy == staff.staffId
}

bg_not_expired if lib.ts_ms(bg.expiresAt) > now_ms

bg_started if lib.ts_ms(bg.grantedAt) <= now_ms

bg_duration_ok if {
	duration := lib.ts_ms(bg.expiresAt) - lib.ts_ms(bg.grantedAt)
	duration > 0
	duration <= console.breakGlass.maxDurationSeconds * 1000
}

bg_justified if bg.justificationCode in console.breakGlass.justificationCodes

requires_break_glass if def.requiresBreakGlass == true

# ---------------------------------------------------------------------------
# Deny reasons.
# ---------------------------------------------------------------------------

deny contains "ACTION_UNKNOWN" if not known

deny contains "CONSOLE_ACTION_PROHIBITED" if {
	known
	not def.prohibited == false
}

deny contains "ORIGIN_NOT_PERMITTED" if not input.origin == "workforce_console"

deny contains "STAFF_MFA_REQUIRED" if not staff.mfa == true

deny contains "STAFF_AUTH_TIME_INVALID" if not auth_time_valid

deny contains "STAFF_AUTH_STALE" if {
	auth_time_valid
	not auth_fresh
}

resource_tenant_ok if input.resource.tenantId == null

resource_tenant_ok if {
	is_string(input.resource.tenantId)
	input.resource.tenantId == staff.tenantId
}

deny contains "TENANT_MISMATCH" if not resource_tenant_ok

staff_tenant_present if is_string(staff.tenantId)

deny contains "TENANT_MISMATCH" if not staff_tenant_present

deny contains "ROLE_NOT_PERMITTED" if {
	known
	def.prohibited == false
	not role_permitted
}

kill_switch_scope_present if is_string(input.resource.killSwitchScope)

deny contains "KILL_SWITCH_SCOPE_REQUIRED" if {
	known
	scope_roles
	not kill_switch_scope_present
}

# Audit-view users cannot also rewrite evidence or change anything (spec 13).
deny contains "AUDITOR_READ_ONLY" if {
	known
	has_role("auditor")
	mutates
}

deny contains "SELF_APPROVAL_PROHIBITED" if {
	known
	def.forbidSelfInitiated == true
	input.resource.initiatorStaffId == staff.staffId
}

initiator_present if is_string(input.resource.initiatorStaffId)

# Positive helper rules: in Rego `not f(ref)` with an undefined ref is
# undefined, so negated checks go through a rule (fail closed).
deny contains "INITIATOR_REQUIRED" if {
	known
	def.forbidSelfInitiated == true
	not initiator_present
}

# A self-approved grant is a security event: it invalidates the request
# whatever the action.
deny contains "BREAK_GLASS_SELF_GRANTED" if bg_self_granted

deny contains "BREAK_GLASS_REQUIRED" if {
	requires_break_glass
	not bg_present
}

deny contains "BREAK_GLASS_EXPIRED" if {
	requires_break_glass
	bg_present
	not bg_not_expired
}

deny contains "BREAK_GLASS_NOT_YET_VALID" if {
	requires_break_glass
	bg_present
	not bg_started
}

deny contains "BREAK_GLASS_DURATION_EXCEEDED" if {
	requires_break_glass
	bg_present
	not bg_duration_ok
}

deny contains "BREAK_GLASS_JUSTIFICATION_INVALID" if {
	requires_break_glass
	bg_present
	not bg_justified
}

# ---------------------------------------------------------------------------
# Decision.
# ---------------------------------------------------------------------------

allow if {
	known
	count(deny) == 0
	role_permitted
}

allow_reasons := role_grant | {"ALLOW_BREAK_GLASS"} if requires_break_glass

allow_reasons := role_grant if not requires_break_glass

allow_obligations := (lib.string_set(def.obligations) | {"AUDIT_ADMIN_ACTION"}) | {"BREAK_GLASS_REVIEW"} if requires_break_glass

allow_obligations := lib.string_set(def.obligations) | {"AUDIT_ADMIN_ACTION"} if not requires_break_glass

deny_reasons := deny | {"DEFAULT_DENY"} if not known

deny_reasons := deny if {
	known
	count(deny) > 0
}

deny_reasons := {"DEFAULT_DENY"} if {
	known
	count(deny) == 0
}

default decision := {
	"allow": false,
	"reasonCodes": ["DEFAULT_DENY"],
	"obligations": [],
}

decision := {
	"allow": true,
	"reasonCodes": sort(allow_reasons),
	"obligations": sort(allow_obligations),
} if allow

# Denied console attempts are still audited.
decision := {
	"allow": false,
	"reasonCodes": sort(deny_reasons),
	"obligations": ["AUDIT_ADMIN_ACTION"],
} if not allow
