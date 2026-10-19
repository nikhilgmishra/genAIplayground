# RB-AUTH-BYPASS Authentication or authorisation bypass

| Field | Value |
|---|---|
| Runbook id | RB-AUTH-BYPASS |
| Severity | SEV-1 |
| Primary owner role | Security operations on-call |
| Last drilled | NEVER (not yet run) |
| Status | Draft; not executed against any real environment |

## Trigger and detection signals

* Dashboard `<prefix>-audit`, panel "Protected actions without decision or audit" (`vsp_protected_actions_total{authorization="missing_decision"}`) above zero. The same panel's `audit="not_recorded"` series is an audit gap ([audit-sink-outage.md](audit-sink-outage.md)).
* Dashboard `<prefix>-identity`: spikes in verification failures, challenge abuse signals (`vsp_challenge_abuse_signals_total` by signal; no alarm rule exists) or denials. Per-account detail lives only in the account-keyed abuse monitor (`VerificationAbuseMonitor.count`: `OTP_ACCOUNT_LIMIT`, `OTP_DESTINATION_LIMIT`, `OTP_ACCOUNT_GUESS_LIMIT`, `RECENT_NUMBER_CHANGE` and others, hashed keys), read by security monitoring; it has no console view.
* Any observable difference between a real and an unknown person after a verification limit (a later tool result, policy denial, Auth Gate value, risk flag or assurance), from a test, a penetration tester or a complaint: an account-existence oracle (AUTH-ENUM-01).
* An Auth Gate opening without a gateway `authGate: true` response (AG test regression or vendor report).
* A protected read or mutation for a subject without an authoritative relationship (audit review, complaint, penetration test finding).
* Session reference from one call accepted on another (binding test MB-02 regression).

## Immediate containment

1. Declare SEV-1. Engage `WRITES` immediately if any mutation path is implicated; engage `INTENT` or `AI_ADMISSION` for affected read paths ([kill-switch-operations.md](kill-switch-operations.md)). Safety and human routes stay available.
2. Revoke affected sessions (`SessionService.revoke` with a reason code); revocation fails closed even before TTL cleanup (AUTH-04).
3. If a credential is implicated (service identity, OAuth2 client, assertion signing key), follow [secret-rotation.md](secret-rotation.md) emergency path.
4. If an approval or policy bundle is implicated, roll back to the last approved policy bundle ([policy-release.md](policy-release.md)).
5. Suspected enumeration or OTP guessing across calls: the per-call limits already act uniformly (`ENUMERATION_SUSPECTED`, `OTP_ABUSE_SUSPECTED`; begin is then denied with a human route) and the account-derived limits act silently, so no switch is needed for a single call. For a pattern spanning many calls, engage `OUTBOUND_NOTIFICATIONS` to stop sends. Every verification begin then answers `VERIFICATION_UNAVAILABLE_USE_HUMAN` with the human route (OPS-KS-01) for every caller alike, decided before any account lookup and without spending any verification throttle, so the switch itself is no account-existence oracle; begins are audited with `KILL_SWITCH_OUTBOUND_NOTIFICATIONS`. See [kill-switch-operations.md](kill-switch-operations.md), `OUTBOUND_NOTIFICATIONS` row. Warn the support operations lead: all verification moves to staff. Never add a reaction that is visible to the caller or on the session and that only real accounts trigger ([ADR-0014](../adr/ADR-0014-uniform-verification-abuse-handling.md)).
6. A real person whose hourly OTP guess budget was spent by someone else gets the same answer as for a wrong code, even for the correct one (AUTH-OTP-LIMIT-01). Route them to the human recovery route and do not tell the caller why: that would disclose that the account exists.

## Evidence preservation

* Preserve audit events and policy decision ids for the window, session generations, integration identity ids, verification transaction ids, risk flags, policy bundle digest and version.
* Preserve WAF and load balancer logs (content-free) for the window. WAF logs redact `authorization`, `cookie`, `mcp-session-id`, `x-vsp-session-ref`, `x-vsp-interaction-id`, `idempotency-key` and the query string (VSP-INF-01); an unredacted bearer value found there is itself a finding: revoke the affected sessions and treat the log group as exposed.
* Preserve the abuse-monitor counters for the window (hashed account and destination keys only; they expire after `abuseSignalRetentionHours`).
* Privacy counsel determines whether reporting obligations apply and their deadlines.

## Step-by-step actions

1. Reproduce with a hostile tool call against a non-production gateway using SYNTHETIC records; record the exact pipeline stage that failed (transport auth, catalogue pin, schema, session resolve, policy, field mask).
2. Fix and add a regression test tagged `[AUTH-02]`, `[AUTH-03]`, `[AUTH-05]` or `[AUTH-07]` as applicable (`[AUTH-ENUM-01]` / `[AUTH-OTP-LIMIT-01]` for verification abuse; compare the full observable sequence of a real and an unknown person past every limit, as `platform/src/identity/enumeration-resistance.integration.test.ts` does); add a golden policy probe if policy was involved.
3. List affected subjects and records (opaque ids) from audit evidence; hand the list to privacy counsel.
4. Release switches after the fix is deployed and verified.

## Verification

* The hostile request is denied with the expected reason code in the fixed release.
* While `OUTBOUND_NOTIFICATIONS` is engaged, a begin for a real and an unknown synthetic person returns an identical result and no message is sent: `VERIFICATION_UNAVAILABLE_USE_HUMAN` (`[OPS-KS-01]` tests on the identity and gateway test harnesses and over the composed LOCAL container). After release the same probe pair returns the identical generic `IF_ELIGIBLE_A_LINK_WAS_SENT`.
* Golden probes and the expansion gate pass; binding tests pass.

## Communication roles

Incident commander; security operations on-call; privacy counsel; identity owner; Talkdesk administrator (Auth Gate configuration); SRE on-call.

## Drill requirement

Hostile gateway test set runs every release (CI). Tabletop of the containment steps before pilot; penetration test findings feed new probes (PRQ-051).
