# Approval requests for Phase 2 (sandbox) — prepared, not granted

Execution-order step 5: approval is requested **only** for missing external access, PHI
handling, billable execution or deployment, each with concrete scope, cost estimate inputs
and rollback (spec section 16). Every request below is **PREPARED** — none has been
submitted or granted. The coding agent cannot sign, approve or fabricate an approval; a
granted approval is an `ApprovalRecord` (`platform/src/protocol/release.ts`) created by the
named human role and stored in `approvals/` (owner: config module loader).

Not requested in Phase 2: `PHI_PROCESSING`, `PRODUCTION_DEPLOYMENT`, `PILOT_EXPOSURE`,
production `POLICY_RELEASE` / `KNOWLEDGE_RELEASE`. Any step that would need one of them is
out of scope and stays BLOCKED.

`ApprovalScope` has no dedicated value for deploying a non-production AWS stack; AR-02 and
AR-15 therefore combine `BILLABLE_TEST_EXECUTION` and `SECURITY_REVIEW` (an interface change
request for a `SANDBOX_DEPLOYMENT` scope is in the delivery report).

| Request | Approval scope | Approver role(s) | Billable | Conditional |
|---|---|---|---|---|
| AR-01 | VENDOR_SANDBOX_INTEGRATION | talkdesk_admin, security_leadership | possibly (tenant licence) | no |
| AR-02 | BILLABLE_TEST_EXECUTION + SECURITY_REVIEW | finance, security_leadership, sre_lead | yes | no |
| AR-03 | VENDOR_SANDBOX_INTEGRATION | salesforce_admin, security_leadership | possibly | no |
| AR-04 | VENDOR_SANDBOX_INTEGRATION | identity_owner | possibly | no |
| AR-05 | PSTN_TEST_CALLS + BILLABLE_TEST_EXECUTION | finance, operations, talkdesk_admin, clinical_safety_lead | yes | no |
| AR-06 | BILLABLE_TEST_EXECUTION | finance, talkdesk_admin | UNKNOWN | no |
| AR-07 | BILLABLE_TEST_EXECUTION | finance, talkdesk_admin | yes | no |
| AR-08 | STATIC_CREDENTIAL_EXCEPTION | security_leadership | no | only if OAuth2 is unavailable |
| AR-09 | SECURITY_REVIEW | security_leadership, privacy_counsel | no | only if TB-01 options A and B fail |
| AR-10 | PSTN_TEST_CALLS | privacy_counsel, qa_language_lead | no | no |
| AR-11 | RETENTION_SCHEDULE | privacy_counsel, security_leadership | no | no |
| AR-12 | CLINICAL_SCRIPTS | clinical_safety_lead, privacy_counsel | no | no |
| AR-13 | MODEL_VOICE_SELECTION | talkdesk_admin, security_leadership, qa_language_lead | no | no |
| AR-14 | SECURITY_REVIEW + BILLABLE_TEST_EXECUTION | executive_sponsor, security_leadership, finance | UNKNOWN | optional Preview feature |
| AR-15 | SECURITY_REVIEW | security_leadership, sre_lead | no | no |

---

## AR-01 Talkdesk sandbox tenant access and configuration

* **Approval scope**: `VENDOR_SANDBOX_INTEGRATION`, environment `sandbox`.
* **Owner role**: talkdesk_admin (approver), security_leadership (co-approver).
* **Scope**: one Talkdesk sandbox tenant isolated from production (tenant id recorded on
  approval); create queues, Studio flows `vsp_main_inbound` and `vsp_authgate_probe`, AI
  Agent Platform agents/Skills/guardrails, one MCP connection to the sandbox gateway `/mcp`,
  HTTP steps to the sandbox telephony-control operations; synthetic personas only; no
  production numbers, queues, routing or recordings touched.
* **Cost estimate inputs**: `sandbox-cost-inputs.yaml` → `talkdesk.rateSandboxTenantMonth`,
  `talkdesk.tenantMonths` (licence cost UNKNOWN, VQ-TD-44).
* **Rollback**: `sandbox-plan.md` §10 steps 1, 2 and 4 (disable MCP connection and AI agent,
  revoke OAuth2 clients, revert/unpublish flows, remove queues).
* **Evidence to attach**: tenant id and plan; written answers to VQ-TD-20/VQ-TD-44; the
  reviewed `talkdesk/` package version (commit); named operators.
* **Remains blocked until approved**: every SF-T, AG, MB, MC, DT, BS, GX, VI, EX test;
  drift check against a real tenant; capability gate evidence CG-01..CG-09.

## AR-02 AWS sandbox deployment (`infra/terraform/envs/sandbox`)

* **Approval scope**: `BILLABLE_TEST_EXECUTION` + `SECURITY_REVIEW`, environment `sandbox`.
* **Owner role**: finance (spend), security_leadership (network exposure, IAM), sre_lead (operations).
* **Scope**: `terraform apply` of the reviewed plan for the sandbox stack (modules listed in
  `sandbox-plan.md` §3) in the sandbox workload and audit accounts, one region; public
  ingress limited to the ALB routes in §3 behind TLS and WAF; egress limited to the
  allowlisted vendor endpoints (Talkdesk only if documented, Salesforce sandbox, IdP test
  tenants) and AWS endpoints; synthetic data only; no quota increase with cost commitment.
  Includes authority to run the rollback/destroy in §10.
* **Cost estimate inputs**: `sandbox-cost-inputs.yaml` → `aws.components[*]` quantities and
  `rate*` fields (all `RATE_CARD_REQUIRED`), `months`, `contingency`.
* **Rollback**: `sandbox-plan.md` §10 step 3 (`plan -destroy` review then apply, in reverse
  order; audit bucket retained under Object Lock per AR-11).
* **Evidence to attach**: plan JSON digest, security review of the plan, Terraform module
  test results (`terraform test`) from the infrastructure module, AWS account ids, budget
  alert configuration, VQ-AWS-02/03/04 answers.
* **Remains blocked until approved**: any deployed gateway; MCP/telephony-control contract
  tests; every Talkdesk sandbox test that needs a reachable gateway.

## AR-03 Salesforce sandbox and integration identity

* **Approval scope**: `VENDOR_SANDBOX_INTEGRATION`, environment `sandbox`.
* **Owner role**: salesforce_admin (approver), security_leadership (co-approver).
* **Scope**: one Salesforce sandbox of a type that copies **no production data**; a dedicated
  integration user with a permission set limited to interaction/Case objects and the fields
  of VQ-SF-04; external ID fields; synthetic records only; credential stored under
  `vsp-sandbox-salesforce`.
* **Cost estimate inputs**: `sandbox-cost-inputs.yaml` → `salesforce.*`.
* **Rollback**: deactivate the integration user, delete the secret, delete synthetic records
  or refresh the sandbox (`sandbox-plan.md` §10 steps 2 and 5).
* **Evidence to attach**: sandbox type and id, permission-set export, automation inventory
  (VQ-SF-08), duplicate-rule list, API allocation (VQ-SF-07).
* **Remains blocked until approved**: Case writes, upsert idempotency and outage
  reconciliation tests against Salesforce.

## AR-04 Identity provider test clients and service OAuth2 clients

* **Approval scope**: `VENDOR_SANDBOX_INTEGRATION`, environment `sandbox`.
* **Owner role**: identity_owner.
* **Scope**: OIDC test clients for client and provider portals, workforce SSO client and
  groups for console roles, synthetic test users with MFA in non-production IdP tenants;
  two OAuth2 client-credential clients (`talkdesk-mcp-sandbox`, `talkdesk-studio-sandbox`)
  on the service authorization server.
* **Cost estimate inputs**: `sandbox-cost-inputs.yaml` → `identity.*`.
* **Rollback**: disable/delete the clients and synthetic users; delete secrets
  (`sandbox-plan.md` §10 steps 2 and 5).
* **Evidence to attach**: issuer metadata (public), client ids (not secrets), amr/acr values
  (VQ-IDP-06), token lifetimes, JWKS rotation cadence.
* **Remains blocked until approved**: secure-link verification, A2/A3 tiers, console SSO,
  MCP/Studio OAuth2 authentication.

## AR-05 PSTN test calls within a finance-approved ceiling

* **Approval scope**: `PSTN_TEST_CALLS` + `BILLABLE_TEST_EXECUTION`, environment `sandbox`.
* **Owner role**: finance (ceiling), operations (receiving agents' time), talkdesk_admin
  (numbers/routing), clinical_safety_lead (safety-route drills; no public crisis lines).
* **Scope**: up to the planned call count in `sandbox-cost-inputs.yaml` `callTestPlan`
  (planning assumption, about 134 calls before re-run contingency) into the sandbox test
  number only, from company test handsets, by consented staff using synthetic scripts;
  receiving agents are internal staff in sandbox queues; spend capped by
  `callTestBudgetCeilingUsd` (`TO_BE_APPROVED_BY_FINANCE`).
* **Cost estimate inputs**: `callTestPlan.*`, `talkdesk.rateInboundMinute`,
  `talkdesk.rateHumanLegMinute`, `talkdesk.rateAiUsageUnit`, `internalLabour.*`.
* **Rollback**: stop rule and un-assign the test number (`sandbox-plan.md` §10 step 1).
* **Evidence to attach**: call schedule, persona script ids, receiving-agent roster,
  spend-tracking method and stop owner.
* **Remains blocked until approved**: SF-T-*, AG-12..AG-19, DT-*, BS-*, GX-*, demonstration
  journeys and failure injections over the telephone path.

## AR-06 Talkdesk AI Agent Platform and Simulator usage

* **Approval scope**: `BILLABLE_TEST_EXECUTION`, environment `sandbox`.
* **Owner role**: finance, talkdesk_admin.
* **Scope**: AI agent sessions created by AR-05 calls and Simulator chat/voice runs of
  reviewed scenarios, up to a finance-set number of runs; whether Simulator runs are billable
  is UNKNOWN (VQ-TD-31) and must be answered before the first run.
* **Cost estimate inputs**: `talkdesk.aiUsageUnit` (UNKNOWN), `talkdesk.rateAiUsageUnit`,
  `talkdesk.simulatorRuns`, `talkdesk.rateSimulatorRun`.
* **Rollback**: stop runs; disable the AI agent (`sandbox-plan.md` §10 step 1).
* **Evidence to attach**: written billing answer (VQ-TD-31), run plan from
  `talkdesk/simulator-and-evaluation-runbook.md`.
* **Remains blocked until approved**: all Simulator runs; AI-path PSTN tests.

## AR-07 Sandbox test numbers and test handsets

* **Approval scope**: `BILLABLE_TEST_EXECUTION`, environment `sandbox`.
* **Owner role**: finance, talkdesk_admin.
* **Scope**: provision the planned number count (`talkdesk.testNumbers`, planning assumption
  2) in the sandbox tenant and the company test handsets/lines used to place calls; numbers
  recorded only in the restricted test-asset register.
* **Cost estimate inputs**: `talkdesk.testNumbers`, `talkdesk.rateNumberMonth`, `months`.
* **Rollback**: release numbers after Phase 2 (`sandbox-plan.md` §10 step 1).
* **Evidence to attach**: number provisioning order reference (not the numbers themselves in
  the repository).
* **Remains blocked until approved**: every PSTN test.

## AR-08 Static bearer credential exception (conditional)

* **Approval scope**: `STATIC_CREDENTIAL_EXCEPTION`, environment `sandbox`.
* **Owner role**: security_leadership.
* **Scope**: only if Studio HTTP steps (VQ-TD-22) or the MCP connection (VQ-TD-24) cannot use
  OAuth2 client credentials: one static token per affected integration id, sandbox only,
  narrow channel scope, hash-only storage at the gateway, rotation interval set by security.
* **Cost estimate inputs**: none (no billable component).
* **Rollback**: rotate/delete the token and its hash; gateway rejects it immediately.
* **Evidence to attach**: Talkdesk written answer showing OAuth2 is unavailable for the plan;
  `AdapterConfig.exceptionApprovalId` change for review.
* **Remains blocked until approved**: the affected integration (Studio telephony-control or
  MCP) cannot authenticate.

## AR-09 Session-binding argument exception (conditional)

* **Approval scope**: `SECURITY_REVIEW`, environment `sandbox`.
* **Owner role**: security_leadership, privacy_counsel.
* **Scope**: only if TB-01 options A and B both fail (`talkdesk/mcp-connection.md` §5):
  permit `tool_argument_lookup_exception` in sandbox for named protected tools, with the
  residual-risk statement and compensating controls listed there.
* **Cost estimate inputs**: none.
* **Rollback**: set `sessionBinding.mode` back; protected tools return to BLOCKED.
* **Evidence to attach**: MB-01..MB-05 results for options A/B, threat-model entry.
* **Remains blocked until approved**: protected tools in the autonomous flow (if A/B fail).

## AR-10 Consented voice fixtures and synthetic persona callers

* **Approval scope**: `PSTN_TEST_CALLS` (privacy sign-off component), environment `sandbox`.
* **Owner role**: privacy_counsel, qa_language_lead.
* **Scope**: internal staff who consent in writing to have their test-call voices recorded,
  transcribed and processed by the sandbox AI path, and/or approved pre-recorded persona
  audio; scripts limited to synthetic personas; no biometric enrolment, no cloning.
* **Cost estimate inputs**: `internalLabour.personaCallerHours`.
* **Rollback**: withdraw consent → stop calls; delete that person's sandbox recordings per AR-11.
* **Evidence to attach**: consent form template (approved by counsel), roster reference.
* **Remains blocked until approved**: PSTN tests that use human voices.

## AR-11 Retention schedule for sandbox test artefacts

* **Approval scope**: `RETENTION_SCHEDULE`, environment `sandbox`.
* **Owner role**: privacy_counsel, security_leadership.
* **Scope**: retention durations for sandbox synthetic recordings, transcripts, Simulator
  data, exports and audit evidence per data class (`TRANSIENT_CONVERSATION`,
  `BUSINESS_RECORD`, `RESTRICTED_QA_MEDIA`, `SECURITY_AUDIT`), the Object Lock mode for the
  sandbox audit bucket (VQ-AWS-09), and vendor deletion requests (VQ-TD-05). No duration is
  proposed by this package.
* **Cost estimate inputs**: `aws.components[s3_audit_and_logs]`, Talkdesk recording storage (if billed).
* **Rollback**: not applicable (a retention decision is changed by a new approval).
* **Evidence to attach**: retention matrix for sandbox.
* **Remains blocked until approved**: enabling recording in the sandbox flow; audit bucket
  Object Lock configuration.

## AR-12 Disclosure, consent and safety templates for sandbox use

* **Approval scope**: `CLINICAL_SCRIPTS` (with privacy counsel for disclosure/consent wording),
  environment `sandbox`.
* **Owner role**: clinical_safety_lead, privacy_counsel.
* **Scope**: approve for sandbox testing the template ids listed in
  `talkdesk/expected-config.yaml` `templateApprovals` (opening, disclosure, consent,
  declined alternative, safety acknowledgment, optional safety menu option). Without this,
  sandbox tests run with templates labelled DRAFT and their results cannot count toward
  consent or safety acceptance gates.
* **Cost estimate inputs**: none.
* **Rollback**: revert to DRAFT labels; affected results become INCONCLUSIVE.
* **Evidence to attach**: template ids, versions and digests from the template registry
  (`platform/src/voice`).
* **Remains blocked until approved**: SF-T-05..SF-T-09 and SF-T-18..SF-T-22 as acceptance evidence.

## AR-13 Sandbox model and voice selection

* **Approval scope**: `MODEL_VOICE_SELECTION`, environment `sandbox`.
* **Owner role**: talkdesk_admin, security_leadership, qa_language_lead.
* **Scope**: the Talkdesk AI agent model and licensed stock voice used in the sandbox, with
  identifiers recorded (currently UNKNOWN, VQ-TD-02); sandbox only; no cloning.
* **Cost estimate inputs**: any model/voice-specific rate in `talkdesk.rateAiUsageUnit`.
* **Rollback**: revert agent configuration to the previous version.
* **Evidence to attach**: identifiers as shown by the tenant; VQ-SPV-05/06 answers if a
  subprocessor is named.
* **Remains blocked until approved**: `PlatformConfig.models.approved` for sandbox; version
  binding in evaluation records.

## AR-14 Batch Agent Evaluation (Preview) — optional

* **Approval scope**: `SECURITY_REVIEW` + `BILLABLE_TEST_EXECUTION`, environment `sandbox`.
* **Owner role**: executive_sponsor (accepts Preview risk and support terms), security_leadership, finance.
* **Scope**: enrolment in the Preview feature for synthetic scenarios only; results
  supplementary, never hard-gate evidence ([S6]).
* **Cost estimate inputs**: Preview pricing UNKNOWN (VQ-TD-32).
* **Rollback**: stop using the feature; delete uploaded synthetic datasets.
* **Evidence to attach**: written Preview terms (VQ-TD-20, VQ-TD-32).
* **Remains blocked until approved**: any use of Batch Agent Evaluation.

## AR-15 CI OIDC deploy role and Terraform state backend

* **Approval scope**: `SECURITY_REVIEW`, environment `sandbox`.
* **Owner role**: security_leadership, sre_lead.
* **Scope**: OIDC trust from the existing CI to a sandbox deploy role limited to the sandbox
  accounts and the modules in `sandbox-plan.md` §3; state backend location and locking
  (VQ-AWS-08); no long-lived access keys.
* **Cost estimate inputs**: state storage (part of `aws.components[s3_audit_and_logs]` or a
  separate bucket — owner decides).
* **Rollback**: remove the role trust (`iam_ci`); retain or delete state per owner.
* **Evidence to attach**: role policy review, trust policy conditions.
* **Remains blocked until approved**: running `terraform plan/apply` for the sandbox from CI.
