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

Policy action identifiers in `code` are the ones used by the synthetic delegation fixtures
(`platform/src/fixtures/synthetic-world.ts`) where they exist; others are proposed names that
the tool catalogue confirms. Assurance tiers are application policy tiers, not NIST AAL
certifications. Minimum assurance values for consequential commits are proposed engineering
defaults pending the identity risk assessment (PRQ-030).

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
9. `RiskFlag` values such as `RECENT_NUMBER_CHANGE`, `ACCOUNT_RECOVERY_IN_PROGRESS`,
   `FRAUD_REVIEW` or `SAFETY_ESCALATION_ACTIVE` can lower what is allowed; an active safety
   escalation revokes pending nonessential mutations.
10. Consent: if automated processing is `DECLINED`, the caller is offered the approved
    alternative (human route); recording consent follows the approved disclosure flow (PRQ-026).

## Caller audiences

| Audience | Action (policy action) | Minimum assurance | Relationship requirement | Human or specialist boundary |
|---|---|---|---|---|
| Any caller | Public FAQ and approved runbook search (`knowledge:search`, public corpus) | A0 | none | Conflicting or expired articles go to human review, not to the caller |
| Any caller | Login guidance without credential reset | A0 | none | Never asks for passwords; recovery only through the identity provider's process |
| Any caller | Request a human (`handoff:request`) | A0 | none | Always available; independent Studio route exists without the gateway |
| Any caller | Safety route (`safety:route`) | A0 | none | Clinician-approved fixed acknowledgment and priority human connection; no authentication (SAFE-02) |
| Any caller | Begin verification (`verification:begin`) | A0 | none (locator used only inside the verification service) | Ambiguous matches go to trusted human recovery |
| Any caller | Minimal unverified intake, complaint intake (`support_request:create`, `complaint:create`) | A0 | none; not linked to an account until A2 | No disclosure of whether an account exists |
| Client | Own appointment facts and options (`appointment:read`) | A2 | `self` | No clinical suitability matching |
| Client | Prepare appointment create or reschedule (`appointment:prepare`) | A2 | `self` | Conflicts and exceptions to a human |
| Client | Commit appointment create or reschedule (`appointment:commit`) | A3 proposed (A2 + digest-bound confirmation at minimum) | `self` | Disabled in autonomous flow until TB-02 (PRQ-014); human agent confirms meanwhile |
| Client | Invoice status and explanation from authoritative fields (`invoice:read`) | A2 | `self` | Never decides coverage, waives fees or promises a refund |
| Client | Submit billing review (`billing_review:submit`) | A3 proposed (A2 + digest-bound confirmation at minimum) | `self` | Disputed liability and exceptional refunds are human decisions; review is REQUEST_ACCEPTED, not RESOLVED |
| Client | Claim status (`claim:read`) | A2 | `self` | Insurer-reported status only; not an eligibility or payment guarantee |
| Client | Own case status and follow-up (`case:read`) | A2 | `self` | — |
| Client | Payment | A2 to receive the hosted payment page path | `self` | Card data never collected by voice (PRQ-050) |
| Client | Treatment questions, medication advice, safety concerns, identity recovery | — | — | Always human or clinician route (SAFE-01) |
| Prospective client | Public information, intake (`support_request:create`) | A0 | none | Treatment questions to a human or clinician route |
| Provider | Own onboarding and credentialing document status (`onboarding:read`) | A2 | `self` (provider record) | Credentialing decisions are human |
| Provider | Remittance status for a practice (`remittance:read`) | A2 | `practice_member` or `practice_delegate` with scope `remittance:read` for that organisation | Payout destination and tax changes always human |
| Provider | Appointment facts for a treating relationship (`appointment:read`) | A2 | `treating_provider` (enrollment system) for that client | No clinical records; unrelated clients denied even if identifiers are known (AUTH-05) |
| Provider | Own or delegated practice case status (`case:read`) | A2 | `self`, `practice_member` or `practice_delegate` with scope `case:read` | Ambiguous delegation to a human |
| Practice staff | Remittance, onboarding and case status for the delegating practice (`remittance:read`, `onboarding:read`, `case:read`) | A2 | `practice_delegate` from the delegation registry, scopes as granted, within validity window | Ambiguous or expired delegation to a human |
| Partner or payer representative | Partner intake (`partner_intake:create`) | A2 | `partner_affiliate` plus `partner_contract_purpose` for the organisation | Ambiguous rights or benefit decisions to a human |
| Partner or payer representative | Organisation-scoped case status (`case:read`) | A2 | `partner_affiliate` for the case's organisation | No blanket patient search; an employer partner never sees an individual's treatment status |
| Personal representative or parent | Records covered by verified legal authority (`appointment:read`, `invoice:read` as granted) | A2 | `legal_representative` or `parental_authority`, unexpired, scopes as granted | `MINOR_CONFIDENTIALITY_REVIEW` or `CUSTODY_DISPUTE` constraint, expired authorisation or unsupported proxy access go to a human |

Denied in every case (no matching row): raw SQL, arbitrary Salesforce queries, arbitrary HTTP
fetch, unrestricted file export, shell execution, broad CRM search, generic record update,
dialling a number supplied by a caller, model or tool result (SAFE-05).

## Workforce (console) roles

Staff authenticate through workforce SSO with MFA (PRQ-036). Elevated access is audited;
break-glass is time-bound, justified and reviewed; the model cannot request or grant it.

| Console action | Allowed staff roles | Notes | Source |
|---|---|---|---|
| Engage or release kill switch: AI admission, intent, integration, writes, outbound notifications | `security_admin`, `supervisor` | Switches preserve safety and human routes | `platform/src/ops/staff-authz.ts` (`KILL_SWITCH_ROLES`) |
| Engage or release kill switch: model version, voice version | `security_admin`, `supervisor`, `deployment_operator` | | `platform/src/ops/staff-authz.ts` |
| Define a budget | `security_admin`, `supervisor`, `deployment_operator` | Financial authority is the referenced approval record | `platform/src/ops/staff-authz.ts` (`BUDGET_ROLES`) |
| Inspect an active support journey; join or transfer through supported Talkdesk controls | `support_agent`, `supervisor`, `safety_responder` | Proposed; console API in progress | spec section 13 |
| Review a pending action; cancel uncommitted work | `supervisor` (and `support_agent` for their own handoffs) | Proposed | spec section 13 |
| Retry a reconciled operation; DLQ repair | `supervisor` | Only after reconciliation shows NOT_STARTED or FAILED | spec section 13; [`../RUNBOOKS/reconciliation-and-dlq-repair.md`](../RUNBOOKS/reconciliation-and-dlq-repair.md) |
| Human task decisions (billing dispute, document review, claim investigation, partner onboarding, complaints, callbacks, CRM repair) | Per workflow business-role mapping | Interim mapping in `platform/src/workflows/types.ts`; dedicated roles proposed | `platform/src/workflows` |
| Safety events view and acknowledgement | `safety_responder`, `supervisor` | | spec section 13 |
| Metadata-only audit search | `auditor` (and `security_admin`) | Every search is itself audited; auditors cannot rewrite evidence | `platform/src/audit` (`AuditQuery`) |
| Knowledge item edit | `knowledge_editor` | Release requires `KNOWLEDGE_RELEASE` approval (PRQ-032) | [`../RUNBOOKS/knowledge-release.md`](../RUNBOOKS/knowledge-release.md) |
| Policy bundle review | `policy_approver`, `security_admin`, `auditor` (read) | Release requires `POLICY_RELEASE` approval (PRQ-031) | [`../RUNBOOKS/policy-release.md`](../RUNBOOKS/policy-release.md) |
| Deployment and rollback | `deployment_operator` | Production requires `PRODUCTION_DEPLOYMENT` approval | spec section 16 |
| Access reviews, secret rotation, break-glass approval | `security_admin` | | [`../RUNBOOKS/access-review.md`](../RUNBOOKS/access-review.md), [`../RUNBOOKS/secret-rotation.md`](../RUNBOOKS/secret-rotation.md) |

No console role can view raw database queries, shared secrets or unrestricted transcript
downloads (spec section 16).

## Reconciliation with the policy bundle

| Check | Status |
|---|---|
| Every row above has at least one golden probe allowing it and probes denying the adjacent unrelated-subject, expired-relationship and below-assurance cases | NOT_RUN — to be completed by the policy module owner and coordinator after the integration test run |
| Every tool in the pinned catalogue maps to a row | NOT_RUN — catalogue not yet pinned |
