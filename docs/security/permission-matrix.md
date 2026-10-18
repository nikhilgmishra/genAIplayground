# Permission matrix

Human-readable summary of who may do what, at which minimum assurance, under which
relationship, and where a human boundary applies. It follows spec section 4 (audience
permissions) and section 7 (assurance tiers, trusted session and permission model).

**Authority.** Permissions are enforced by the OPA policy bundle in `policy/`, evaluated in the
gateway through the `PolicyEngine` port (`platform/src/policy/ports.ts`,
[ADR-0002](../adr/ADR-0002-opa-wasm-in-process.md)), with tool-level minimum assurance and
permissions declared in each `ToolDefinition` (`platform/src/protocol/tools.ts`). The policy's
**golden decision probes are authoritative**: where this table and the probes differ, the
probes win and this table must be corrected in the same change. Nothing here grants access by
itself.

Policy action identifiers in `code` are the catalogue names in `policy/vsp/data.json`
(bundle `2026.10.18-2`) and the `permissions` of the pinned tool catalogue
(`schemas/tools/catalog.json`). Assurance tiers are application policy tiers, not NIST AAL
certifications. Minimum assurance values for consequential commits are proposed engineering
defaults pending the identity risk assessment (PRQ-030). The catalogue is an engineering
default pending the `POLICY_RELEASE` approval (PRQ-031), not an approved permission matrix.

## Rules that apply to every row

1. Actor, selected role, subject, organisation, delegated authority, scopes, assurance, consent
   and risk flags come from server-side session state, never from tool arguments (AUTH-03).
2. Every read, retrieval, write, export, notification and handoff checks actor-to-subject
   relationship, role, purpose, record classification, consent or other lawful authority,
   assurance, freshness and action limits (spec section 7). Default is deny.
3. Relationships come only from authoritative sources (identity provider, enrollment system,
   delegation registry, partner contract registry, legal authority registry). A provider
   identifier, partner email domain or caller statement establishes nothing (AUTH-05).
4. A multi-role user selects one role; privileges are never combined. Changing role starts a new
   session generation with dropped privileges.
5. Safety routing and human requests never require authentication, account ownership, payment
   or budget headroom, and are exempt from kill switches (SAFE-02, SAFE-03).
6. No account-existence disclosure below A2; verification responses are generic.
7. Every consequential commit needs a fresh confirmation bound to the prepared-action digest,
   captured by a trusted deterministic component ([ADR-0005](../adr/ADR-0005-trusted-confirmation-capture.md)).
8. Field-level minimisation: the policy decision's field mask strips everything else.
9. Session risk flags lower what is allowed: `FRAUD_REVIEW`, `ACCOUNT_RECOVERY_IN_PROGRESS` and
   `PARTICIPANT_CHANGED` deny protected requests; `ENUMERATION_SUSPECTED` and
   `OTP_ABUSE_SUSPECTED`, which every caller triggers the same way, deny `verification:begin`;
   an active safety escalation (`SAFETY_ESCALATION_ACTIVE`) revokes pending nonessential
   mutations. Signals derived from a real account (per-account limits, the OTP guess budget,
   `RECENT_NUMBER_CHANGE`) are never session flags or policy inputs; they stay in the
   account-keyed abuse monitor, so no later result reveals whether an account exists
   (AUTH-ENUM-01, [ADR-0014](../adr/ADR-0014-uniform-verification-abuse-handling.md)).
10. Consent: if automated processing is `DECLINED`, the caller is offered the approved
    alternative (human route); recording consent follows the approved disclosure flow (PRQ-026).

## Caller audiences

| Audience | Action (policy action) | Minimum assurance | Relationship requirement | Human or specialist boundary |
|---|---|---|---|---|
| Any caller | Public FAQ and approved runbook search (`public:read`, public corpus) | A0 | none | Conflicting or expired articles go to human review, not to the caller |
| Any caller | Login guidance without credential reset (`login_help:read`) | A0 | none | Never asks for passwords; recovery only through the identity provider's process |
| Any caller | Request a human (`human:request`) | A0 | none; also with no, an expired or a revoked session (SAFE-02) | Always available; destination only from the trusted allowlist; independent Studio route exists without the gateway |
| Any caller | Safety route (`safety:route`) | A0 | none; also with no, an expired or a revoked session (SAFE-02) | Clinician-approved fixed acknowledgment and priority human connection; no authentication |
| Any caller | Begin verification (`verification:begin`) | A0 | none (locator used only inside the verification service) | Ambiguous matches go to trusted human recovery; after `ENUMERATION_SUSPECTED` or `OTP_ABUSE_SUSPECTED` on the call, begin is denied with a human route (`RISK_VERIFICATION_ABUSE`, `REQUIRE_HUMAN`), identically for real and unknown people |
| Any caller | Minimal unverified intake, complaint intake (`support_request:create`, `intake:create`, `complaint:create`) | A0 | none; not linked to an account below A2 | No disclosure of whether an account exists |
| Client | Complaint linked to the own account (`complaint:create` for the intake; the link itself authorized as `support_request:create`) | A2 | `self` | Unverified complaints, or a link the policy refuses, stay unlinked; the complaint is still accepted |
| Client | Own appointment facts (`appointment:read`) | A2 | `self` | No clinical suitability matching |
| Client | Own appointments and open administrative times with opaque slot ids (`appointment:list_options`, tool `get_appointment_options`) | A2 | `self` | No clinical suitability matching |
| Client | Prepare appointment create or reschedule (`appointment:prepare_change`) | A2 | `self` | Conflicts and exceptions to a human |
| Client | Commit appointment create or reschedule (`appointment:commit_change`) | A3 proposed (A2 + digest-bound confirmation at minimum) | `self` | Disabled in autonomous flow until TB-02 (PRQ-014); human agent confirms meanwhile |
| Client | Invoice status and explanation from authoritative fields (`invoice:read`) | A2 | `self` | Never decides coverage, waives fees or promises a refund |
| Client | Prepare a billing review (`billing:prepare_review`) | A2 | `self` | Pending action only; nothing is submitted until trusted confirmation |
| Client | Submit billing review (`billing:submit_review`) | A3 proposed (A2 + digest-bound confirmation at minimum) | `self` | Disputed liability and exceptional refunds are human decisions; review is REQUEST_ACCEPTED, not RESOLVED |
| Client | Claim status (`claim:read`) | A2 | `self` | Insurer-reported status only; not an eligibility or payment guarantee |
| Client | Own case status and follow-up (`case:read`) | A2 | `self` | — |
| Client | Support request linked to the own account (`support_request:create`) | A2 | `self` | — |
| Client | Payment | A2 to receive the hosted payment page path | `self` | Card data never collected by voice (PRQ-050) |
| Client | Treatment questions, medication advice, safety concerns, identity recovery | — | — | Always human or clinician route (SAFE-01) |
| Prospective client | Public information, intake (`support_request:create`) | A0 | none | Treatment questions to a human or clinician route |
| Provider | Own onboarding and credentialing document status (`onboarding:read`) | A2 | `self` (provider record) | Credentialing decisions are human |
| Provider | Remittance status for a practice (`remittance:read`) | A2 | `practice_member` or `practice_delegate` with scope `remittance:read` for that organisation | Payout destination and tax changes always human |
| Provider | Appointment facts and options for a treating relationship (`appointment:read`, `appointment:list_options`) | A2 | `treating_provider` (enrollment system) for that client, with the action's own scope | No clinical records; unrelated clients denied even if identifiers are known (AUTH-05) |
| Provider | Own or delegated practice case status (`case:read`) | A2 | `self`, `practice_member` or `practice_delegate` with scope `case:read` | Ambiguous delegation to a human |
| Practice staff | Remittance and case status for the delegating practice (`remittance:read`, `case:read`) | A2 | `practice_delegate` from the delegation registry, scopes as granted, within validity window | Ambiguous or expired delegation to a human |
| Practice staff | Onboarding status of a provider of the delegating practice (`onboarding:read`, path `organization_with_subject`) | A2 | `practice_delegate` with scope `onboarding:read` for the practice the provider network records the provider under (`OnboardingStatus.organizationId`) | Providers of other practices, or with no practice on record, are denied |
| Partner or payer representative | Partner intake (`partner_intake:create`) | A2 | `partner_affiliate` plus `partner_contract_purpose` for the organisation | Ambiguous rights or benefit decisions to a human |
| Partner or payer representative | Organisation-scoped case status (`case:read`) | A2 | `partner_affiliate` for the case's organisation | No blanket patient search; an employer partner never sees an individual's treatment status |
| Personal representative or parent | Records covered by verified legal authority (`appointment:read`, `appointment:list_options`, `invoice:read` as granted) | A2 | `legal_representative` or `parental_authority`, unexpired, scopes as granted | `MINOR_CONFIDENTIALITY_REVIEW` or `CUSTODY_DISPUTE` constraint, expired authorisation or unsupported proxy access go to a human |
| Personal representative or parent | Support request linked to the represented person (`support_request:create`, purpose `representative_access`) | A2 | exactly one represented subject with scope `support_request:create`, unexpired | Missing, ambiguous or expired authority is denied (expired: human route) |

Denied in every case (no matching row): raw SQL, arbitrary Salesforce queries, arbitrary HTTP
fetch, unrestricted file export, shell execution, broad CRM search, generic record update,
dialling a number supplied by a caller, model or tool result (SAFE-05).

## Workforce (console) roles

Staff authenticate through workforce SSO with MFA (PRQ-036). Elevated access is audited;
break-glass is time-bound, justified and reviewed; the model cannot request or grant it.

| Console action | Allowed staff roles | Notes | Source |
|---|---|---|---|
| Own console session: who am I, sign out (`console:session`) | every staff role | MFA, workforce origin, tenant and authentication age still apply | `policy/vsp/data.json` |
| Operations overview, counts only (`operations:overview`) | `support_agent`, `supervisor`, `safety_responder`, `deployment_operator`, `security_admin` | No record-level data | `policy/vsp/data.json` |
| View budgets (`budget:view`) and kill-switch state (`kill_switch:view`) | `supervisor`, `security_admin`, `deployment_operator` | Read-only; changes need `budget:define` / `kill_switch:engage`/`release` | `policy/vsp/data.json` |
| View the reconciliation queue (`reconciliation:view`) | `supervisor` | Reconcile and retry need `operation:retry_reconciled` | `policy/vsp/data.json` |
| View human tasks (`human_task:view`) | `support_agent`, `supervisor` | Deciding needs `human_task:decide` and the task's required role | `policy/vsp/data.json` |
| View release candidates (`release:view`) | `auditor`, `knowledge_editor`, `policy_approver`, `security_admin` | Policy bundle items additionally need `policy:review` | `policy/vsp/data.json` |
| Engage or release kill switch: AI admission, intent, integration, writes, outbound notifications | `security_admin`, `supervisor` | Switches preserve safety and human routes | `platform/src/ops/staff-authz.ts` (`KILL_SWITCH_ROLES`) |
| Engage or release kill switch: model version, voice version | `security_admin`, `supervisor`, `deployment_operator` | | `platform/src/ops/staff-authz.ts` |
| Define a budget | `security_admin`, `supervisor`, `deployment_operator` | Financial authority is the referenced approval record | `platform/src/ops/staff-authz.ts` (`BUDGET_ROLES`) |
| Inspect an active support journey (`journey:inspect`); join or transfer through supported Talkdesk controls (`call:join`, `call:transfer`) | `support_agent`, `supervisor`, `safety_responder` | A transfer goes to the staff-selected destination only if it is allowlisted; the initiating staff member is audited. A transfer whose reason or destination purpose is `SAFETY_PRIORITY` is a staff safety escalation and takes the full safety route: the call's pending mutations are revoked (session and ledger), `SAFETY_ESCALATION` is applied, a restricted safety record and safety events are written (SAFE-HANDOFF-05). A transfer requested while the call's safety route is active returns that route and dials nothing new. No join endpoint exists (TB-07) | spec sections 10 and 13; `platform/src/console-api` (`calls.transfer`) |
| View a restricted (clinical-question, privacy or safety) support request (`restricted_record:view`) | `safety_responder`, `supervisor`, `security_admin` with a valid break-glass grant approved by someone else | Only then does the console read the row with the row-level-security restricted-reader setting. Clinical-question, privacy-concern and safety-concern handoff records are always restricted and synchronise as a minimal RESTRICTED Case; clinical-question records are never linked to the subject (DP-01). Repairing a restricted request's dead-lettered sync needs the same grant | spec sections 7, 8 and 13; `platform/src/business/handoff.ts` (`handoffRecordPlacement`) |
| Review a pending action; cancel uncommitted work (`pending_action:review`, `pending_action:cancel`) | `supervisor` (and `support_agent` for calls they currently own) | Only `PREPARED` / `CONFIRMED` actions; `COMMITTING` and later are refused. No call-ownership source exists yet (TB-07), so only supervisors can cancel (fail closed) | spec section 13; `platform/src/console-api` |
| Retry a reconciled operation (`operation:retry_reconciled`); DLQ repair (`dlq:repair`) | `supervisor` | Retry only after the latest reconciliation returned NOT_FOUND, for an action without a durable invalidation request (barge-in, changed request or safety escalation while in doubt), while the caller's confirmation is still fresh, and only when the CALLER's current authority is re-established from server-side state (live session at the action's generation without a safety escalation, current relationships, kill switches including `WRITES`, policy). The staff member's role never substitutes for the caller's authority (ACT-F1, ACT-F3). DLQ repair requeues outbox dead letters and dead-lettered Salesforce syncs | spec section 13; [`../RUNBOOKS/reconciliation-and-dlq-repair.md`](../RUNBOOKS/reconciliation-and-dlq-repair.md) |
| Human task decisions (billing dispute, document review, claim investigation, partner onboarding, complaints, callbacks, CRM repair) | Per workflow business-role mapping | Interim mapping in `platform/src/workflows/types.ts`; dedicated roles proposed | `platform/src/workflows` |
| Safety events view and acknowledgement | `safety_responder`, `supervisor` | Every safety route, including model-raised and staff-initiated ones, writes safety events (SAFE-HANDOFF-07). No acknowledgement endpoint exists yet | spec section 13 |
| Metadata-only audit search | `auditor` (and `security_admin`) | Every search is itself audited; auditors cannot rewrite evidence | `platform/src/audit` (`AuditQuery`) |
| Knowledge item edit | `knowledge_editor` | Release requires `KNOWLEDGE_RELEASE` approval (PRQ-032) | [`../RUNBOOKS/knowledge-release.md`](../RUNBOOKS/knowledge-release.md) |
| Policy bundle review | `policy_approver`, `security_admin`, `auditor` (read) | Release requires `POLICY_RELEASE` approval (PRQ-031) | [`../RUNBOOKS/policy-release.md`](../RUNBOOKS/policy-release.md) |
| Deployment and rollback | `deployment_operator` | Production requires `PRODUCTION_DEPLOYMENT` approval | spec section 16 |
| Access reviews, secret rotation, break-glass approval | `security_admin` | | [`../RUNBOOKS/access-review.md`](../RUNBOOKS/access-review.md), [`../RUNBOOKS/secret-rotation.md`](../RUNBOOKS/secret-rotation.md) |

No console role can view raw database queries, shared secrets or unrestricted transcript
downloads (spec section 16).

## CI and deployment identities

Enforced by IAM in `infra/terraform/modules/iam_ci` (rendered plans only; tested by
`infra/terraform/modules/iam_ci/tests/iam_ci.tftest.hcl` and the OPA rules `CI-BOUNDARY`,
`CI-STATE`, `CI-IDENTITY` and `IAM` in `infra/terraform/policy`). Nothing here has been applied to
an AWS account (PRQ-037).

| Identity | May | May not | Source |
|---|---|---|---|
| CI plan role | Be assumed through GitHub OIDC only by `deploy.yml` on `main` in the `<env>-plan` environment (exact subject, audience `sts.amazonaws.com`); read the Terraform state; write only the state lock (`<key>.tflock`); produce the plan | Write, delete or restore the state object or its versions; change the state bucket's versioning, lifecycle or policy; change its own or the apply role's policies, trust or boundary; the data-plane reads and the export and sharing calls the boundary lists | VSP-INF-02, VSP-INF-03 |
| CI apply role | Be assumed the same way in the `<env>` environment, which has required reviewers; overwrite the state; delete only the lock; create and change roles that carry the CI boundary within the stack's name prefix; apply the reviewed plan | Delete the state or its versions; change its own identity, trust, inline or attached policies or boundary, or pass itself to a service; change, retarget or pass roles CI did not create; assume roles in the workload account; change identity providers, users, groups or managed policies; the listed data-plane reads (session items, queue messages, secret values, log events, decrypt outside the state); table export and resource policy, snapshot sharing and export, log export and subscription filters, bucket replication and ACLs, queue `AddPermission`; KMS grants not created by an AWS service; secret policies without Block Public Policy | VSP-INF-02, VSP-INF-03 |
| Administrator (outside CI) | The initial `iam_ci` apply and every later change to it; branch rules restricting every `<env>-plan` and `<env>` environment to `main`; the repository OIDC subject customization | — | `infra/terraform/README.md` |

Residual (VSP-INF-02): code running with the apply credentials can still share data through the
resource policies Terraform manages (key, bucket, queue and secret policies), through roles CI
creates and the code it deploys, through configuration changes the deploy permissions allow, and
through item writes that return old values. Closing these needs an AWS Organizations data
perimeter, which is not in place (`infra/terraform/README.md`). The IAM effects were evaluated
offline with AWS IAM semantics, not against AWS; the GitHub environment rules and the OIDC subject
customization are repository-administrator settings that are not verified here.

## Reconciliation with the policy bundle

| Check | Status |
|---|---|
| Every caller row above has a golden probe allowing it | PASS offline (local/ci only): base probes in `policy/golden/probes.json` (916 probes for bundle `2026.10.18-2`), e.g. `authz.client_list_appointment_options.base`, `authz.client_prepare_billing_review.base`, `authz.representative_support_request_with_subject.base`, `authz.practice_delegate_onboarding.base`; evaluated by `platform/src/policy/golden.test.ts`, which passed in `evidence/test-reports/vitest-platform.json` |
| Adjacent unrelated-subject, expired-relationship, below-assurance and missing-scope denials | PASS offline: perturbation probes per base (`*.relationships_removed`, `*.assurance_a1`, `*.session_expired`, ...) and explicit probes (`authz.explicit.list_options_*`, `authz.explicit.prepare_billing_review_*`) |
| Every console row has allow and deny probes | PASS offline: `console.<action>.base`, `console.<action>.role_<role>` and the MFA / origin / stale-auth / tenant / self-granted break-glass perturbations; `console.explicit.*` for the new read actions |
| Every tool in the pinned catalogue maps to a row | PASS: `schemas/tools/catalog.json` permissions are `verification:begin`, `appointment:commit_change`, `support_request:create`, `appointment:list_options`, `case:read`, `claim:read`, `invoice:read`, `login_help:read`, `onboarding:read`, `remittance:read`, `appointment:prepare_change`, `billing:prepare_review`, `human:request`, `safety:route`, `public:read`, `billing:submit_review`, `complaint:create`, `partner_intake:create` |
| Approved for release | NOT APPROVED: no `POLICY_RELEASE` approval record exists (PRQ-031); nothing here is evidence from a sandbox or production environment |
