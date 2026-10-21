# RB-ACCESS-REVIEW Access review

| Field | Value |
|---|---|
| Runbook id | RB-ACCESS-REVIEW |
| Severity | Procedure |
| Primary owner role | Security admin (reviewers: role owners) |
| Last drilled | NEVER (not yet run) |
| Status | Draft; the console runs live workforce SSO against Keycloak locally (WP-05); tenant IdP groups and approved parameters are activation inputs (AIN-12, AIN-13, AIN-15) |

## Trigger and detection signals

Scheduled review (cadence set by security leadership); personnel or role change; break-glass use; finding from [authentication-bypass.md](authentication-bypass.md) or [phi-exposure.md](phi-exposure.md).

Post-use reviews are opened automatically (WP-05): the first use of a break-glass grant and every dual-controlled recovery session create an OPEN row in `console_access_reviews`, due 72 hours later, in the same transaction as the use's audit event (`console.break_glass.first_use`, `console.access_review.opened`). The console lists them at `GET /console/api/v1/access-reviews` (security admin and auditor). An OPEN review past `dueAt` is the detection signal for a missed review.

## Immediate containment

Remove access that has no current justification immediately; do not wait for the review cycle.

## Evidence preservation

Privacy counsel determines any reporting obligations and deadlines; the software preserves evidence and supports the process.

The review itself is evidence: record scope, reviewer, findings, removals and date as a `SECURITY_AUDIT` event (spec section 13: retain proof of access reviews).

## Step-by-step actions

1. Export the current membership of each workforce role group: support agent, supervisor, safety responder, auditor, knowledge editor, policy approver, deployment operator, security admin.
2. Confirm separation of duties: auditors cannot write evidence; policy approvers do not deploy their own bundles; deployment operators do not approve policy; nobody holds combined roles without a recorded justification.
3. Review break-glass grants: each time-bound, justified and reviewed; the model can never request or grant break-glass. Issuance is a console workflow (`POST /console/api/v1/break-glass/requests` by the requester, `.../decision` by a different security admin before `decideBy`; the database refuses a self-decided request and a self-granted grant). Complete each post-use review with `POST /console/api/v1/access-reviews/{reviewId}/complete` and an outcome (`APPROPRIATE`, `INAPPROPRIATE`, `FOLLOW_UP_REQUIRED`) plus a reason code; the reviewer must be neither the holder nor the approver (refused `SELF_REVIEW_FORBIDDEN`).
3a. Review recovery identities (`GET /console/api/v1/recovery-identities`): every ACTIVE identity has a current custodian, a hardware-key attestation reference, a holder confirmation (`holderConfirmedAt`: the custodian signed the enrollment challenge with that key in their own SSO session) and was approved by a second security admin; revoke (`.../revoke`, reason `CUSTODIAN_OFFBOARDED`, `KEY_LOST_OR_COMPROMISED`, `ROTATION` or `ACCESS_REVIEW_FINDING`) any that do not. Revocation ends the recovery sessions activated with that identity immediately (same transaction), even when the custodian holds another ACTIVE identity; every request of a recovery session re-checks its identity.
3b. SUSPENDED identities: the console suspends a custodian's identities by itself, fail closed, whenever one of their SSO sessions ends (logout, a refused refresh, the replay of a superseded bearer, an idle or absolute expiry, an active check) without a positive answer from the workforce IdP: the token is inactive or refused, or the person no longer maps (disabled, removed from the managed groups, subject changed, a token past its expiry, a logout racing the session's own refresh: `suspendReason` `CUSTODIAN_OFFBOARDED`), the IdP could not be asked (outage, timeout: `CUSTODIAN_EVIDENCE_LOST`), or the roles no longer cover the identity (`CUSTODIAN_ROLES_REDUCED`). Each is audited as `console.recovery_identity.suspended` with the reason, and their recovery sessions end in the same transaction. A suspended identity comes back only with the custodian's next SSO sign-in that maps its roles (`console.recovery_identity.reinstated`); a role that comes back at the IdP does not reinstate it by itself (the custodian signs in again). An error log `console.sso.terminal_closure_unaudited` means a session closure or suspension was applied while the audit store refused its events (fail closed); each `console.sso.terminal_audit_unwritten` names an event (`action`) that was still not written afterwards: record those suspensions and revocations in the review from the console's identity list and session rows, since the audit trail lacks them. `CUSTODIAN_EVIDENCE_LOST` and an employed custodian's `CUSTODIAN_OFFBOARDED` after a normal logout are expected occasionally (fail closed); the custodian signs in again. During a workforce IdP outage a custodian whose SSO session ends is suspended and cannot be reinstated until the IdP is back: break-glass then needs two custodians whose sessions did not end during the outage, so keep enough custodians enrolled (and do not end custodian sessions on purpose during an outage). Check that the IdP's refresh-token lifetime (Keycloak: SSO session idle and max) exceeds the console idle timeout and absolute lifetime, or every normal expiry suspends custodians. For a custodian who has LEFT, revoke the suspended identity (`CUSTODIAN_OFFBOARDED`) rather than wait. Activation also requires each custodian's last positive SSO answer to be at most 14 days old (`holderSsoMaxAgeSeconds`): a custodian who has not signed in for that long cannot recover until they do; check the list against people on long leave.
3c. Enrolling a custodian (dual control, holder-bound): (1) a security admin who is not the custodian proposes the key (`POST /console/api/v1/recovery-identities`; refused unless the custodian signed in by SSO within 14 days and holds every requested role at the IdP) and hands the returned enrollment challenge (shown once, valid 24 hours) to the custodian; (2) the custodian, signed in by SSO, signs it with the hardware key and confirms (`POST .../:identityId/confirm`); (3) a second security admin, neither the proposer nor the custodian, approves (`POST .../:identityId/approve`; refused before the confirmation). A proposal whose challenge expired is revoked (`ROTATION`) and proposed again.
3d. Confirm the IdP mapping in the console configuration matches the role groups exported in step 1: with the default `membershipSource: CLIENT_ROLES`, each role group must grant exactly its console client role at the IdP and `consoleAuth.groupRoles` must list every console client role (an unlisted one is refused `STAFF_GROUP_UNKNOWN`; the refusal count in the audit trail shows drift). Also list who may map roles of the console client and who may create groups: a group NAME never grants a role (a top-level group named like a managed one, e.g. `vsp/security-admin`, has the same path on Keycloak 26), only the client-role mapping does. With `GROUP_PATHS` (only with the tenant's unambiguous-paths approval), confirm no group under the managed prefix is unmapped.
4. Review service identities per environment and integration (MCP, telephony-control, worker, CI deploy role, Salesforce integration user): least privilege, no unused permissions, no static tokens without an approved exception.
5. Review database roles (`app_runtime`, `app_worker`, `app_console`, `app_auditor`, owner) and who can assume the owner role.
6. Review audit-account administrators (independent from workload administrators).
7. Review vendor-side admin accounts (Talkdesk, Salesforce).
8. Record findings, removals and follow-ups with owners and dates.

## Verification

Post-removal export shows the intended membership; the review record is stored. A disabled IdP user (`STAFF_DEPROVISIONED`) and a user removed from every managed group (`STAFF_NOT_PROVISIONED`; the IdP omits the groups claim) lose console access at the next active-state check (introspection, at most `activeCheckIntervalSeconds` after the change): their next request is refused. Closing the session rows without any request depends on `WorkforceSsoService.sweep`, which the composition must schedule (not yet wired, WP-07). Every post-use review in scope is COMPLETED.

## Communication roles

Security admin; role owners (support operations, clinical safety lead, policy approver lead, SRE lead); Talkdesk and Salesforce administrators.

## Drill requirement

First review before pilot; then on the cadence set by security leadership.
