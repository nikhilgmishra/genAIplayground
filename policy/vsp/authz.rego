# METADATA
# title: Caller-facing authorization decision (entrypoint vsp/authz/decision)
# description: |
#   Deny by default. Input is exactly the strict PolicyInput of
#   platform/src/protocol/policy.ts: server-established session fields,
#   authoritative relationship facts and an authoritative resource
#   description. Nothing here trusts a caller statement, a model-proposed
#   argument, a provider identifier or an e-mail domain (AUTH-01, AUTH-03).
#
#   Output: {allow, reasonCodes, fieldMask, obligations}, every array sorted.
#   Safety routing and human requests are always allowed (SAFE-02). Every
#   other action needs a valid session, tenant match, permitted role,
#   consent, assurance, a satisfied access path (relationship, scope,
#   purpose, classification) and no kill switch or risk denial. All
#   applicable deny reasons are reported together.
#
#   Engineering defaults pending POLICY_RELEASE approval (PRQ-031) and
#   privacy counsel (consent semantics, PRQ-026/PRQ-027). Not an approved
#   permission matrix.
package vsp.authz

import data.vsp.catalogue
import data.vsp.lib

# ---------------------------------------------------------------------------
# Fixed rules that catalogue data cannot change.
# ---------------------------------------------------------------------------

# Only these two actions bypass every check. Catalogue data cannot add an
# exemption: a SAFETY_AND_HUMAN_ROUTE class on any other action is ignored.
always_available := {
	"safety:route": "SAFETY_ROUTE_ALWAYS_AVAILABLE",
	"human:request": "HUMAN_ROUTE_ALWAYS_AVAILABLE",
}

# Actions still allowed when the caller declined recording or automated
# processing (offered the approved alternative). Policy default pending counsel.
consent_exempt_classes := {"SAFETY_AND_HUMAN_ROUTE", "PUBLIC_READ", "INTAKE"}

mutation_classes := {"PREPARE_MUTATION", "COMMIT_MUTATION"}

partner_roles := {"partner", "payer_representative"}

blocking_constraints := {"MINOR_CONFIDENTIALITY_REVIEW", "CUSTODY_DISPUTE"}

# Deny reasons that send the caller to a person (REQUIRE_HUMAN obligation).
human_reasons := {
	"AUTHORIZATION_EXPIRED",
	"CONSENT_DECLINED_ALTERNATIVE_ROUTE",
	"CUSTODY_DISPUTE",
	"HIGH_RISK_HUMAN_ONLY",
	"HUMAN_BOUNDARY",
	"MINOR_CONFIDENTIALITY_REVIEW",
	"RISK_VERIFICATION_ABUSE",
}

step_up_reasons := {"STEP_UP_DIGEST_MISMATCH", "STEP_UP_EXPIRED", "STEP_UP_REQUIRED"}

sha256_hex := `^[a-f0-9]{64}$`

# ---------------------------------------------------------------------------
# Basic facts about the request.
# ---------------------------------------------------------------------------

def := catalogue.actions[input.action]

known if def

exempt if always_available[input.action]

now_ms := lib.ts_ms(input.now)

role := input.auth.selectedRole

role_selected if is_string(input.auth.selectedRole)

subject_targeted if is_string(input.resource.subjectId)

organization_targeted if is_string(input.resource.organizationId)

# A request is protected when the action is, or when it touches a specific
# person's or organization's records.
protected_request if def.protected == true

protected_request if subject_targeted

protected_request if organization_targeted

mutation if def.class in mutation_classes

risk_flags := lib.string_set(input.auth.riskFlags)

human_boundary if def.class == "HUMAN_BOUNDARY"

# High-risk changes go to a person whatever the assurance tier (FO-05-06): the catalogue list holds even
# if an action's class were changed.
high_risk_human_only if input.action in catalogue.highRisk.humanOnlyActions

# ---------------------------------------------------------------------------
# Session, tenant, role.
# ---------------------------------------------------------------------------

session_valid if {
	input.auth.revoked == false
	lib.ts_ms(input.auth.expiresAt) > now_ms
}

tenant_match if {
	is_string(input.auth.tenantId)
	input.auth.tenantId == input.resource.tenantId
}

role_permitted if "*" in def.roles

role_permitted if {
	role_selected
	role in def.roles
}

role_in(roles) if "*" in roles

role_in(roles) if {
	role_selected
	role in roles
}

# ---------------------------------------------------------------------------
# Assurance. A3 is transaction-bound: it counts as A3 only for the prepared
# action whose digest the step-up verified, and only until it expires;
# otherwise the session counts as A2.
# ---------------------------------------------------------------------------

session_rank := lib.assurance_rank[input.auth.assurance]

step_up_bound if {
	is_string(input.auth.stepUpDigest)
	is_string(input.resource.actionDigest)
	input.auth.stepUpDigest == input.resource.actionDigest
	lib.ts_ms(input.auth.stepUpExpiresAt) > now_ms
}

effective_rank := 3 if {
	input.auth.assurance == "A3"
	step_up_bound
}

effective_rank := 2 if {
	input.auth.assurance == "A3"
	not step_up_bound
}

# A1 (approved possession verification) counts as A1 only for an operation the tenant approved for it
# (catalogue assuranceA1, with an approval record); otherwise it counts as A0 (FO-05-03).
a1_approved if {
	is_string(catalogue.assuranceA1.approvalRef)
	input.action in catalogue.assuranceA1.operations
}

effective_rank := 1 if {
	input.auth.assurance == "A1"
	a1_approved
}

effective_rank := 0 if {
	input.auth.assurance == "A1"
	not a1_approved
}

effective_rank := session_rank if {
	input.auth.assurance != "A3"
	input.auth.assurance != "A1"
}

tool_rank := 0 if input.tool == null

tool_rank := r if {
	is_object(input.tool)
	r := lib.assurance_rank[input.tool.minAssurance]
}

tool_minimum_readable if lib.assurance_rank[input.tool.minAssurance]

# An unreadable tool minimum can never be met (fail closed).
tool_rank := 99 if {
	is_object(input.tool)
	not tool_minimum_readable
}

action_rank := lib.assurance_rank[def.minAssurance]

path_required_rank(p) := max([tool_rank, action_rank, lib.assurance_rank[p.minAssurance]])

# ---------------------------------------------------------------------------
# Relationships. A fact counts only when it belongs to this actor, comes from
# the authoritative source for its type and is valid for the selected role
# (a multi-role user's privileges are never combined).
# ---------------------------------------------------------------------------

usable_fact(f) if {
	is_string(input.auth.actorId)
	f.actorId == input.auth.actorId
	role_selected
	f.type in catalogue.roleFactTypes[role]
	f.source in catalogue.factSources[f.type]
	is_array(f.scopes)
	is_array(f.constraints)
}

# Live only when explicitly unexpired; an unreadable validUntil is expired.
fact_live(f) if {
	f.validUntil == null
	not "AUTHORIZATION_EXPIRED" in f.constraints
}

fact_live(f) if {
	lib.ts_ms(f.validUntil) > now_ms
	not "AUTHORIZATION_EXPIRED" in f.constraints
}

fact_expired(f) if not fact_live(f)

scope_ok(p, _) if p.scope == null

scope_ok(p, f) if {
	is_string(p.scope)
	p.scope in f.scopes
}

fact_blocked(f) if {
	some c in f.constraints
	c in blocking_constraints
}

auth_subject_ok(p) if p.requireAuthSubject == false

auth_subject_ok(p) if {
	p.requireAuthSubject == true
	is_string(input.auth.subjectId)
	input.auth.subjectId == input.resource.subjectId
}

target_match(p, f) if {
	p.target == "subject"
	subject_targeted
	f.subjectId == input.resource.subjectId
	auth_subject_ok(p)
}

target_match(p, f) if {
	p.target == "organization"
	organization_targeted
	not subject_targeted
	f.organizationId == input.resource.organizationId
}

target_match(p, f) if {
	p.target == "organization_with_subject"
	organization_targeted
	f.organizationId == input.resource.organizationId
}

paths := def.access

# Relationship-free path (public, intake, verification start).
open_path_matches(i) if {
	p := paths[i]
	p.target == "none"
	count(p.factTypes) == 0
	role_in(p.roles)
	not subject_targeted
	not organization_targeted
}

# [path index, fact index] pairs whose fact could support the path.
candidates contains [i, j] if {
	some i, p in paths
	p.target != "none"
	role_in(p.roles)
	some j, f in input.relationships
	f.type in p.factTypes
	usable_fact(f)
	target_match(p, f)
}

candidate_facts contains input.relationships[j] if some [_, j] in candidates

relationship_path(i) if open_path_matches(i)

relationship_path(i) if {
	some [k, j] in candidates
	k == i
	f := input.relationships[j]
	fact_live(f)
	not fact_blocked(f)
	scope_ok(paths[i], f)
}

relationship_paths contains i if {
	some i, _ in paths
	relationship_path(i)
}

any_blocked_candidate if {
	some f in candidate_facts
	fact_blocked(f)
}

purpose_ok(p) if input.purpose in p.purposes

classification_ok(p) if input.resource.classification in p.classifications

purpose_paths contains i if {
	some i in relationship_paths
	purpose_ok(paths[i])
}

classified_paths contains i if {
	some i in purpose_paths
	classification_ok(paths[i])
}

assured_paths contains i if {
	some i in classified_paths
	effective_rank >= path_required_rank(paths[i])
}

granted_paths := assured_paths

grant if count(granted_paths) > 0

# Minimum assurance the caller would need: over relationship-satisfied paths
# when any exist, otherwise over every path of the action.
needed_rank := min({path_required_rank(paths[i]) | some i in classified_paths}) if count(classified_paths) > 0

needed_rank := min({path_required_rank(p) | some p in paths}) if {
	count(classified_paths) == 0
	count(paths) > 0
}

# ---------------------------------------------------------------------------
# Deny reasons. Every rule is written so that a missing or malformed input
# field produces a denial, never an allow.
# ---------------------------------------------------------------------------

deny contains "ACTION_UNKNOWN" if not known

deny contains "SESSION_INVALID" if {
	known
	not exempt
	not session_valid
}

deny contains "TENANT_MISMATCH" if {
	known
	not exempt
	not tenant_match
}

deny contains "ROLE_NOT_SELECTED" if {
	known
	not exempt
	not human_boundary
	protected_request
	not role_selected
}

deny contains "ROLE_NOT_PERMITTED" if {
	known
	not exempt
	role_selected
	not role_permitted
}

# Positive helper rules: in Rego `not f(ref)` with an undefined ref is
# undefined, so every negated check goes through a rule (fail closed).
action_purpose_ok if "*" in def.purposes

action_purpose_ok if input.purpose in def.purposes

action_classification_ok if "*" in def.classifications

action_classification_ok if input.resource.classification in def.classifications

resource_type_ok if "*" in def.resourceTypes

resource_type_ok if input.resource.type in def.resourceTypes

deny contains "PURPOSE_NOT_PERMITTED" if {
	known
	not exempt
	not human_boundary
	not action_purpose_ok
}

deny contains "PURPOSE_NOT_PERMITTED" if {
	known
	not exempt
	not human_boundary
	count(relationship_paths) > 0
	count(purpose_paths) == 0
}

deny contains "CLASSIFICATION_NOT_PERMITTED" if {
	known
	not exempt
	not human_boundary
	not action_classification_ok
}

deny contains "CLASSIFICATION_NOT_PERMITTED" if {
	known
	not exempt
	not human_boundary
	count(purpose_paths) > 0
	count(classified_paths) == 0
}

# Verification secrets never flow through tools (AUTH-06), in any environment.
deny contains "VERIFICATION_SECRET_PROHIBITED" if {
	known
	not exempt
	input.resource.classification == "VERIFICATION_SECRET"
}

deny contains "RESOURCE_TYPE_NOT_PERMITTED" if {
	known
	not exempt
	not resource_type_ok
}

deny contains "HUMAN_BOUNDARY" if human_boundary

deny contains "HIGH_RISK_HUMAN_ONLY" if {
	known
	not exempt
	high_risk_human_only
}

deny contains "PARTNER_NO_INDIVIDUAL_ACCESS" if {
	known
	not exempt
	role in partner_roles
	subject_targeted
}

deny contains "RELATIONSHIP_NOT_ESTABLISHED" if {
	known
	not exempt
	not human_boundary
	count(relationship_paths) == 0
	count(candidate_facts) == 0
}

deny contains "AUTHORIZATION_EXPIRED" if {
	known
	not exempt
	not human_boundary
	count(relationship_paths) == 0
	some f in candidate_facts
	fact_expired(f)
}

deny contains "SCOPE_NOT_GRANTED" if {
	known
	not exempt
	not human_boundary
	count(relationship_paths) == 0
	not any_blocked_candidate
	some [k, j] in candidates
	f := input.relationships[j]
	fact_live(f)
	not scope_ok(paths[k], f)
}

# Constraint on any matching fact forces human review, even if another fact
# for the same subject would otherwise apply.
deny contains c if {
	known
	not exempt
	some f in candidate_facts
	some c in f.constraints
	c in blocking_constraints
}

deny contains "ASSURANCE_INSUFFICIENT" if {
	known
	not exempt
	not human_boundary
	not grant
	effective_rank < needed_rank
}

deny contains "ASSURANCE_INSUFFICIENT" if {
	known
	not exempt
	not human_boundary
	not effective_rank
}

# An A1 session asked for an operation the tenant did not approve for A1 (reported with the denial).
deny contains "A1_OPERATION_NOT_APPROVED" if {
	known
	not exempt
	not human_boundary
	not grant
	input.auth.assurance == "A1"
	not a1_approved
	needed_rank == 1
}

step_up_present if is_string(input.auth.stepUpDigest)

step_up_digest_matches if {
	step_up_present
	input.auth.stepUpDigest == input.resource.actionDigest
}

step_up_unexpired if lib.ts_ms(input.auth.stepUpExpiresAt) > now_ms

deny contains "STEP_UP_REQUIRED" if {
	step_up_needed
	not step_up_present
}

deny contains "STEP_UP_DIGEST_MISMATCH" if {
	step_up_needed
	step_up_present
	not step_up_digest_matches
}

deny contains "STEP_UP_EXPIRED" if {
	step_up_needed
	step_up_digest_matches
	not step_up_unexpired
}

step_up_needed if {
	known
	not exempt
	not human_boundary
	not grant
	needed_rank == 3
	effective_rank < 3
}

deny contains "ACTION_DIGEST_REQUIRED" if {
	known
	def.requiresActionDigest == true
	not valid_action_digest
}

valid_action_digest if {
	is_string(input.resource.actionDigest)
	regex.match(sha256_hex, input.resource.actionDigest)
}

# Consent (policy default pending privacy counsel, PRQ-026): a caller who
# declined recording or automated processing gets safety, human, public and
# minimal intake only; everything else waits for the approved alternative.
consent_declined if input.auth.consentAutomatedProcessing == "DECLINED"

consent_declined if input.auth.consentRecording == "DECLINED"

processing_consent_ok if input.auth.consentAutomatedProcessing in {"GRANTED", "NOT_REQUIRED"}

consent_exempt if def.class in consent_exempt_classes

deny contains "CONSENT_DECLINED_ALTERNATIVE_ROUTE" if {
	known
	not exempt
	not consent_exempt
	consent_declined
}

# UNKNOWN is never consent: protected work waits for the consent flow.
deny contains "CONSENT_NOT_ESTABLISHED" if {
	known
	not exempt
	not consent_exempt
	not consent_declined
	not processing_consent_ok
}

deny contains "RISK_FRAUD_REVIEW" if {
	known
	not exempt
	protected_request
	"FRAUD_REVIEW" in risk_flags
}

deny contains "RISK_ACCOUNT_RECOVERY_IN_PROGRESS" if {
	known
	not exempt
	protected_request
	"ACCOUNT_RECOVERY_IN_PROGRESS" in risk_flags
}

# Participant change or account switch expires privileges (spec section 7).
deny contains "RISK_PARTICIPANT_CHANGED" if {
	known
	not exempt
	protected_request
	"PARTICIPANT_CHANGED" in risk_flags
}

deny contains "RISK_VERIFICATION_ABUSE" if {
	input.action == "verification:begin"
	some flag in {"ENUMERATION_SUSPECTED", "OTP_ABUSE_SUSPECTED"}
	flag in risk_flags
}

# A credible safety concern revokes pending nonessential mutations (spec 10).
deny contains "SAFETY_MODE_MUTATIONS_REVOKED" if {
	known
	not exempt
	mutation
	"SAFETY_ESCALATION_ACTIVE" in risk_flags
}

# Kill switches (spec 13). Anything but an explicit false counts as engaged.
deny contains "KILL_SWITCH_AI_ADMISSION" if {
	known
	not exempt
	not input.killSwitches.aiAdmission == false
}

deny contains "KILL_SWITCH_WRITES" if {
	known
	not exempt
	write_class
	not input.killSwitches.writes == false
}

write_class if def.killSwitchClass == "WRITE"

write_class if mutation

deny contains "KILL_SWITCH_INTENT" if {
	known
	not exempt
	def.intent in lib.string_set(input.killSwitches.intents)
}

intents_readable if is_array(input.killSwitches.intents)

integrations_readable if is_array(input.killSwitches.integrations)

deny contains "KILL_SWITCH_INTENT" if {
	known
	not exempt
	not intents_readable
}

deny contains "KILL_SWITCH_INTEGRATION" if {
	known
	not exempt
	some integration in def.integrations
	integration in lib.string_set(input.killSwitches.integrations)
}

deny contains "KILL_SWITCH_INTEGRATION" if {
	known
	not exempt
	not integrations_readable
}

# ---------------------------------------------------------------------------
# Decision.
# ---------------------------------------------------------------------------

allow if exempt

allow if {
	not exempt
	known
	count(deny) == 0
	grant
}

grant_reasons contains paths[i].grantReason if some i in granted_paths

allow_reasons := {always_available[input.action]} if exempt

allow_reasons := grant_reasons if not exempt

deny_reasons := deny | {"DEFAULT_DENY"} if not known

deny_reasons := deny | {"DEFAULT_DENY"} if {
	known
	count(deny) == 0
}

deny_reasons := deny if {
	known
	count(deny) > 0
}

# Exempt routes stay allowed even if their catalogue entry were missing.
allow_field_mask := m if {
	m := sort(lib.string_set(def.fieldMask))
} else := []

allow_obligations := o if {
	o := sort(lib.string_set(def.obligations))
} else := []

deny_obligations contains "REQUIRE_HUMAN" if {
	some r in deny_reasons
	r in human_reasons
}

deny_obligations contains "REQUIRE_STEP_UP" if {
	some r in deny_reasons
	r in step_up_reasons
}

default decision := {
	"allow": false,
	"reasonCodes": ["DEFAULT_DENY"],
	"fieldMask": [],
	"obligations": [],
}

decision := {
	"allow": true,
	"reasonCodes": sort(allow_reasons),
	"fieldMask": allow_field_mask,
	"obligations": allow_obligations,
} if allow

decision := {
	"allow": false,
	"reasonCodes": sort(deny_reasons),
	"fieldMask": [],
	"obligations": sort(deny_obligations),
} if not allow
