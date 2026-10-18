# RB-ACCESS-REVIEW Access review

| Field | Value |
|---|---|
| Runbook id | RB-ACCESS-REVIEW |
| Severity | Procedure |
| Primary owner role | Security admin (reviewers: role owners) |
| Last drilled | NEVER (not yet run) |
| Status | Draft; workforce SSO groups and console are not yet live (PRQ-036) |

## Trigger and detection signals

Scheduled review (cadence set by security leadership); personnel or role change; break-glass use; finding from [authentication-bypass.md](authentication-bypass.md) or [phi-exposure.md](phi-exposure.md).

## Immediate containment

Remove access that has no current justification immediately; do not wait for the review cycle.

## Evidence preservation

Privacy counsel determines any reporting obligations and deadlines; the software preserves evidence and supports the process.

The review itself is evidence: record scope, reviewer, findings, removals and date as a `SECURITY_AUDIT` event (spec section 13: retain proof of access reviews).

## Step-by-step actions

1. Export the current membership of each workforce role group: support agent, supervisor, safety responder, auditor, knowledge editor, policy approver, deployment operator, security admin.
2. Confirm separation of duties: auditors cannot write evidence; policy approvers do not deploy their own bundles; deployment operators do not approve policy; nobody holds combined roles without a recorded justification.
3. Review break-glass grants: each time-bound, justified and reviewed; the model can never request or grant break-glass.
4. Review service identities per environment and integration (MCP, telephony-control, worker, CI deploy role, Salesforce integration user): least privilege, no unused permissions, no static tokens without an approved exception.
5. Review database roles (`app_runtime`, `app_worker`, `app_console`, `app_auditor`, owner) and who can assume the owner role.
6. Review audit-account administrators (independent from workload administrators).
7. Review vendor-side admin accounts (Talkdesk, Salesforce).
8. Record findings, removals and follow-ups with owners and dates.

## Verification

Post-removal export shows the intended membership; the review record is stored.

## Communication roles

Security admin; role owners (support operations, clinical safety lead, policy approver lead, SRE lead); Talkdesk and Salesforce administrators.

## Drill requirement

First review before pilot; then on the cadence set by security leadership.
