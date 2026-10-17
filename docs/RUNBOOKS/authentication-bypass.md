# RB-AUTH-BYPASS Authentication or authorisation bypass

| Field | Value |
|---|---|
| Runbook id | RB-AUTH-BYPASS |
| Severity | SEV-1 |
| Primary owner role | Security operations on-call |
| Last drilled | NEVER (not yet run) |
| Status | Draft; not executed against any real environment |

## Trigger and detection signals

* Dashboard `<prefix>-audit`, panel "Protected actions without decision or audit" (`vsp_protected_actions_total{authorization="missing_decision"}`) above zero.
* Dashboard `<prefix>-identity`: spikes in verification failures, challenge abuse signals (`vsp_challenge_abuse_signals_total`) or denials.
* An Auth Gate opening without a gateway `authGate: true` response (AG test regression or vendor report).
* A protected read or mutation for a subject without an authoritative relationship (audit review, complaint, penetration test finding).
* Session reference from one call accepted on another (binding test MB-02 regression).

## Immediate containment

1. Declare SEV-1. Engage `WRITES` immediately if any mutation path is implicated; engage `INTENT` or `AI_ADMISSION` for affected read paths ([kill-switch-operations.md](kill-switch-operations.md)). Safety and human routes stay available.
2. Revoke affected sessions (`SessionService.revoke` with a reason code); revocation fails closed even before TTL cleanup (AUTH-04).
3. If a credential is implicated (service identity, OAuth2 client, assertion signing key), follow [secret-rotation.md](secret-rotation.md) emergency path.
4. If an approval or policy bundle is implicated, roll back to the last approved policy bundle ([policy-release.md](policy-release.md)).

## Evidence preservation

* Preserve audit events and policy decision ids for the window, session generations, integration identity ids, verification transaction ids, risk flags, policy bundle digest and version.
* Preserve WAF and load balancer logs (content-free) for the window.
* Privacy counsel determines whether reporting obligations apply and their deadlines.

## Step-by-step actions

1. Reproduce with a hostile tool call against a non-production gateway using SYNTHETIC records; record the exact pipeline stage that failed (transport auth, catalogue pin, schema, session resolve, policy, field mask).
2. Fix and add a regression test tagged `[AUTH-02]`, `[AUTH-03]`, `[AUTH-05]` or `[AUTH-07]` as applicable; add a golden policy probe if policy was involved.
3. List affected subjects and records (opaque ids) from audit evidence; hand the list to privacy counsel.
4. Release switches after the fix is deployed and verified.

## Verification

* The hostile request is denied with the expected reason code in the fixed release.
* Golden probes and the expansion gate pass; binding tests pass.

## Communication roles

Incident commander; security operations on-call; privacy counsel; identity owner; Talkdesk administrator (Auth Gate configuration); SRE on-call.

## Drill requirement

Hostile gateway test set runs every release (CI). Tabletop of the containment steps before pilot; penetration test findings feed new probes (PRQ-051).
