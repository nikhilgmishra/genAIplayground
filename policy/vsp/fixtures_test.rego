# METADATA
# title: SYNTHETIC test fixtures for the policy unit tests
# description: |
#   LOCAL FIXTURE data only. Identifiers mirror
#   platform/src/fixtures/synthetic-world.ts (every id contains "synth").
#   Not real people, not PHI. Excluded from the built bundle (*_test.rego).
package vsp.fixtures_test

now := "2026-10-17T15:00:00.000Z"

later := "2026-10-17T15:30:00.000Z"

earlier := "2026-10-17T14:00:00.000Z"

tenant := "tnt_synthTenantPrimary01"

other_tenant := "tnt_synthTenantOther0001"

digest_a := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

digest_b := "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

avery := {"actor": "act_synthClientAvery01", "subject": "sub_synthClientAvery01"}

blake := {"actor": "act_synthClientBlake01", "subject": "sub_synthClientBlake01"}

casey := {"actor": "act_synthClientCasey01", "subject": "sub_synthClientCasey01"}

dana := {"actor": "act_synthRepDana00001"}

emery := {"actor": "act_synthRepEmery0001"}

morgan := {"actor": "act_synthProvMorgan01", "subject": "prv_synthProvMorgan01"}

newbie := {"actor": "act_synthProvNewbie01", "subject": "prv_synthProvNewbie01"}

riley := {"actor": "act_synthStaffRiley01"}

quinn := {"actor": "act_synthPartnerQuinn1"}

north := "org_synthPracticeNorth1"

south := "org_synthPracticeSouth1"

acme := "org_synthPartnerAcme01"

ks_off := {"aiAdmission": false, "writes": false, "intents": [], "integrations": []}

ks_all := {
	"aiAdmission": true,
	"writes": true,
	"intents": ["safety_handoff", "human_handoff", "appointment_lookup"],
	"integrations": ["talkdesk-telephony", "salesforce", "scheduling"],
}

all_risk_flags := [
	"RECENT_NUMBER_CHANGE",
	"OTP_ABUSE_SUSPECTED",
	"ENUMERATION_SUSPECTED",
	"SHARED_DEVICE_POSSIBLE",
	"PARTICIPANT_CHANGED",
	"ACCOUNT_RECOVERY_IN_PROGRESS",
	"FRAUD_REVIEW",
	"SAFETY_ESCALATION_ACTIVE",
]

auth(actor, role, subject, org, assurance) := {
	"tenantId": tenant,
	"sessionGeneration": 1,
	"actorId": actor,
	"selectedRole": role,
	"subjectId": subject,
	"organizationId": org,
	"permittedScopes": [],
	"assurance": assurance,
	"authenticatedAt": "2026-10-17T14:55:00.000Z",
	"expiresAt": later,
	"revoked": false,
	"riskFlags": [],
	"consentRecording": "GRANTED",
	"consentAutomatedProcessing": "GRANTED",
	"stepUpDigest": null,
	"stepUpExpiresAt": null,
}

# Unverified caller with an A0 session (no actor, no role).
anon_auth := auth(null, null, null, null, "A0")

resource(type, subject, org, classification) := {
	"type": type,
	"tenantId": tenant,
	"subjectId": subject,
	"organizationId": org,
	"classification": classification,
	"actionDigest": null,
}

fact(type, actor, subject, org, scopes, source) := {
	"type": type,
	"actorId": actor,
	"subjectId": subject,
	"organizationId": org,
	"scopes": scopes,
	"source": source,
	"validUntil": null,
	"constraints": [],
}

self_fact(person) := fact("self", person.actor, person.subject, null, [], "identity_provider")

treating_fact(provider, client) := fact("treating_provider", provider.actor, client.subject, null, ["appointment:read"], "enrollment_system")

rep_fact(rep, client, scopes) := fact("legal_representative", rep.actor, client.subject, null, scopes, "legal_authority_registry")

delegate_fact(actor, org, scopes) := fact("practice_delegate", actor.actor, null, org, scopes, "delegation_registry")

member_fact(actor, org, scopes) := fact("practice_member", actor.actor, null, org, scopes, "enrollment_system")

partner_fact(actor, org, scopes) := fact("partner_affiliate", actor.actor, null, org, scopes, "partner_contract_registry")

tool(min) := {"name": "synthetic_probe_tool", "version": "1.0.0", "minAssurance": min, "consequential": false}

req(action, purpose, a, r, rels) := {
	"action": action,
	"purpose": purpose,
	"environment": "local",
	"now": now,
	"tool": null,
	"auth": a,
	"resource": r,
	"relationships": rels,
	"killSwitches": ks_off,
}

with_auth(x, patch) := object.union(x, {"auth": object.union(x.auth, patch)})

with_resource(x, patch) := object.union(x, {"resource": object.union(x.resource, patch)})

with_ks(x, patch) := object.union(x, {"killSwitches": object.union(x.killSwitches, patch)})

# --- Canonical allowed requests -------------------------------------------------

avery_appt := req(
	"appointment:read", "caller_self_service",
	auth(avery.actor, "client", avery.subject, null, "A2"),
	resource("appointment", avery.subject, null, "PHI"),
	[self_fact(avery)],
)

avery_prepare := req(
	"appointment:prepare_change", "caller_self_service",
	auth(avery.actor, "client", avery.subject, null, "A2"),
	resource("appointment", avery.subject, null, "PHI"),
	[self_fact(avery)],
)

avery_commit := with_resource(
	req(
		"appointment:commit_change", "caller_self_service",
		auth(avery.actor, "client", avery.subject, null, "A2"),
		resource("appointment", avery.subject, null, "PHI"),
		[self_fact(avery)],
	),
	{"actionDigest": digest_a},
)

avery_invoice := req(
	"invoice:read", "caller_self_service",
	auth(avery.actor, "client", avery.subject, null, "A2"),
	resource("invoice", avery.subject, null, "FINANCIAL"),
	[self_fact(avery)],
)

avery_billing := with_resource(
	req(
		"billing:submit_review", "caller_self_service",
		auth(avery.actor, "client", avery.subject, null, "A2"),
		resource("invoice", avery.subject, null, "FINANCIAL"),
		[self_fact(avery)],
	),
	{"actionDigest": digest_a},
)

avery_claim := req(
	"claim:read", "caller_self_service",
	auth(avery.actor, "client", avery.subject, null, "A2"),
	resource("claim", avery.subject, null, "PHI"),
	[self_fact(avery)],
)

avery_case := req(
	"case:read", "caller_self_service",
	auth(avery.actor, "client", avery.subject, null, "A2"),
	resource("support_case", avery.subject, null, "PHI"),
	[self_fact(avery)],
)

morgan_treating_appt := req(
	"appointment:read", "caller_self_service",
	auth(morgan.actor, "provider", morgan.subject, north, "A2"),
	resource("appointment", avery.subject, null, "PHI"),
	[self_fact(morgan), treating_fact(morgan, avery), member_fact(morgan, north, ["remittance:read", "onboarding:read", "case:read", "appointment:read"])],
)

emery_rep_appt := req(
	"appointment:read", "representative_access",
	auth(emery.actor, "personal_representative", null, null, "A2"),
	resource("appointment", blake.subject, null, "PHI"),
	[rep_fact(emery, blake, ["appointment:read", "invoice:read"])],
)

newbie_onboarding := req(
	"onboarding:read", "caller_self_service",
	auth(newbie.actor, "provider", newbie.subject, null, "A2"),
	resource("provider_onboarding", newbie.subject, null, "INTERNAL"),
	[self_fact(newbie)],
)

riley_onboarding := req(
	"onboarding:read", "delegated_practice_administration",
	auth(riley.actor, "practice_staff", null, north, "A2"),
	resource("provider_onboarding", morgan.subject, north, "INTERNAL"),
	[delegate_fact(riley, north, ["remittance:read", "onboarding:read", "case:read"])],
)

riley_remit := req(
	"remittance:read", "delegated_practice_administration",
	auth(riley.actor, "practice_staff", null, north, "A2"),
	resource("remittance", null, north, "FINANCIAL"),
	[delegate_fact(riley, north, ["remittance:read", "onboarding:read", "case:read"])],
)

quinn_intake := req(
	"partner_intake:create", "partner_administration",
	auth(quinn.actor, "partner", null, acme, "A2"),
	resource("partner_intake", null, acme, "INTERNAL"),
	[partner_fact(quinn, acme, ["partner_intake:create", "case:read"])],
)

anon(action, purpose, type, classification) := req(action, purpose, anon_auth, resource(type, null, null, classification), [])
