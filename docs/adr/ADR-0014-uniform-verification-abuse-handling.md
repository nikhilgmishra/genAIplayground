# ADR-0014 Uniform verification abuse handling: account-keyed abuse monitor, no account-derived session flags, OTP limits enforced at submission

| Field | Value |
|---|---|
| Status | **Accepted for engineering**. Verification and abuse parameters: **Pending human approval** (PRQ-029). OTP fallback: **BLOCKED** until TB-03 (PRQ-015); `otpEnabled` defaults to false |
| Date | 2026-10-18 |
| Decided by | Principal engineer (coding agent) for the engineering scope only |
| Approval needed from | Security leadership with the identity owner |
| Related prerequisites | PRQ-029, PRQ-015, PRQ-005, PRQ-048, PRQ-025 |

## Context

Spec section 7: name and date of birth only locate a candidate; use generic responses for zero,
one or multiple matches; do not confirm that an individual receives mental-health services
before authorization. OTP needs throttling, attempt limits, account and destination abuse
detection and recent-number-change signals; the proposed limits are three incorrect attempts per
challenge and five per account per hour, and Security must approve final values.
[ADR-0009](ADR-0009-identity-verification.md) set the verification methods.

Review findings:

* **AUTH-ENUM-01**: the first response was generic, but per-account and per-destination
  throttles, the account guess budget, a real account's challenge lockout and a recent number
  change set risk flags on the caller's session. Policy denies `verification:begin` on
  `ENUMERATION_SUSPECTED` / `OTP_ABUSE_SUSPECTED`, so a LATER result on the call differed only
  when the locator was a real person: an account-existence oracle (threat T-03).
* **AUTH-OTP-LIMIT-01**: limits were applied when a code was sent, not when digits were
  submitted, so guesses spread over calls or sent concurrently could exceed the account budget,
  and several challenges per call could be open at once.

## Decision

1. **Account-derived signals never touch the session.** Signals that exist only for a real,
   eligible account (`LINK_ACCOUNT_LIMIT`, `OTP_ACCOUNT_LIMIT`, `OTP_DESTINATION_LIMIT`,
   `OTP_ACCOUNT_GUESS_LIMIT`, `OTP_ACCOUNT_CHALLENGE_LOCKED`, `RECENT_NUMBER_CHANGE`) suppress
   the send or the comparison SILENTLY and are recorded only in `VerificationAbuseMonitor`
   (`platform/src/identity/abuse-monitor.ts`): hourly counters inside the restricted
   verification store, keyed by `sha256(kind NUL id)` of the account or destination. Never as a
   session risk flag, policy input, tool result, speech slot, telephony-control response or a
   log line linked to the call. The only other output is the aggregate counter
   `vsp_challenge_abuse_signals_total{signal}`. Recording never throws.
2. **Session flags only from uniform controls.** `ENUMERATION_SUSPECTED` and
   `OTP_ABUSE_SUSPECTED` are set only by controls every caller triggers identically: too many
   verification begins on the call, a locked challenge (decoys lock the same way), the session
   OTP failure budget.
3. **Same answer either way.** Zero, one or many matches, ineligible accounts, throttles and
   risk blocks return the same response; a challenge record is stored for every request (a decoy
   when nothing is sent); a directory failure after exactly one candidate answers like no match
   (`platform/src/identity/verification-service.ts`).
4. **OTP limits at submission** (`submitOtp`):
   * one outstanding challenge per call: each new challenge, decoy or real, takes the next
     session sequence number and only the latest accepts digits (`OTP_CHALLENGE_SUPERSEDED`);
   * the account guess budget (`otpMaxFailuresPerAccountPerHour`) is reserved by an atomic
     increment BEFORE each comparison on a real account's challenge, so concurrent or cross-call
     guesses cannot exceed it; a spent budget skips the comparison and the attempt is handled
     exactly like a wrong code (what every decoy does);
   * a session failure counter counts incorrect entries on any challenge of the call; once spent,
     or after any lockout, no challenge on the call accepts digits; an unavailable counter is
     treated as spent (fail closed);
   * digits are accepted only from the isolated `telephony_control` path, never the model-facing
     MCP channel.
5. Defaults (`DEFAULT_VERIFICATION_CONFIG`, `platform/src/identity/config.ts`) equal the spec's
   proposals: 3 attempts per challenge; 5 challenges per account, 5 per destination, 5 failures
   per account and 5 secure links per account per hour; 5 verification begins per call. They
   are engineering defaults, not approved values.

Tests (offline, LOCAL FIXTURE adapters, SYNTHETIC people): `platform/src/identity/abuse-monitor.test.ts`,
`platform/src/identity/verification-service.test.ts` (`[AUTH-ENUM-01]`, `[AUTH-OTP-LIMIT-01]`)
and `platform/src/identity/enumeration-resistance.integration.test.ts` (full container: the
observable result sequence for a real and an unknown person must be identical, over the secure
link and the OTP path). Status: IMPLEMENTED_OFFLINE; T-03 stays IN_PROGRESS in the threat model.

## Consequences

* The account holder is still protected (deliveries and comparisons stop at the limits), but
  the caller always hears the generic response; a real person who hits a limit is not told why.
  Recovery is the human route.
* Investigation of account abuse reads the monitor by account or destination; by design there
  is no link from a monitor counter to a call or session.
* The session failure budget reuses the `otpMaxFailuresPerAccountPerHour` value; there is no
  separate parameter for it.
* Residual (T-03): timing is not equalised; an eligible candidate awaits one notification send.
  Human agents can still disclose (training).
* The monitor's storage TTL (`abuseSignalRetentionHours`) is an engineering default pending
  Security approval and is not a legal retention decision (PRQ-025).

## Alternatives considered

| Alternative | Why not adopted |
|---|---|
| Session risk flags for account-derived signals (previous behaviour) | Policy turns a flag into a different later result only for real people (AUTH-ENUM-01) |
| Tell the caller they are throttled or locked | Discloses that the locator is an enrolled person (spec section 7) |
| Enforce OTP limits only when a code is sent | Guesses spread over calls or sent concurrently exceed the budget (AUTH-OTP-LIMIT-01) |
| Hard account lockout | Lets an attacker lock out real users (T-19); throttles route to a human recovery path instead |
| Equalise response latency now | Send latency of a real notification provider is unknown (no provider yet, PRQ-048); padding against a fixture would prove nothing |

## Linked requirements

AUTH-01, AUTH-03, AUTH-06, SPEC-7.no-enumeration, SPEC-7.OTP, SPEC-14 account enumeration (T-03).

## Revisit when

Security approves the verification and abuse parameters (PRQ-029), TB-03 evidence permits OTP
(PRQ-015), or a live notification provider allows timing measurement (PRQ-048).
