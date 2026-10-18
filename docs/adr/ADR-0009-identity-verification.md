# ADR-0009 Identity: secure link with OIDC MFA preferred; OTP restricted; name and date of birth locate only

| Field | Value |
|---|---|
| Status | **Accepted for engineering**. Verification parameters and A1 scope: **Pending human approval** (PRQ-029, PRQ-030). OTP fallback: **BLOCKED** until TB-03 (PRQ-015) |
| Date | 2026-10-17 |
| Decided by | Principal engineer (coding agent) for the engineering scope only |
| Approval needed from | Security leadership and identity owner |
| Related prerequisites | PRQ-005, PRQ-015, PRQ-029, PRQ-030, PRQ-036, PRQ-048 |

## Context

AUTH-01: caller ID, date of birth, NPI and spoken claims never authenticate a session alone.
AUTH-06: verification secrets never reach a model, transcript or ordinary logs. NIST guidance
withdraws knowledge-based questions as authenticators and treats PSTN out-of-band verification
as restricted (S7, S8). Spec section 7 describes the preferred journey: a short-lived secure
link or in-portal approval requiring existing account authentication, bound with a nonce and
explicit transaction matching to the current trusted call session.

## Decision

1. **Assurance tiers A0–A3** are application policy tiers, not NIST AAL certifications
   (`Assurance` in `platform/src/protocol/common.ts`). Authentication proves an actor;
   authorisation separately decides rights to a subject, organisation, record and action.
2. **Preferred**: secure link to the pre-registered channel (or in-portal approval) that
   requires an existing IdP session with MFA or passkey (OIDC: issuer, audience, nonce,
   `auth_time` / max age, `amr`). The link carries a transaction id and a match code; the
   portal binds the account to exactly this call session and generation. Reused, expired or
   mismatched transactions fail.
3. **OTP fallback is restricted**: only to an existing verified channel (never a number supplied
   during the call), neutral message, one-time challenge, proposed five-minute expiry, proposed
   limits of three incorrect attempts per challenge and five per account per hour, abuse
   detection and risk signals for recent number changes. All values require security approval
   (PRQ-029). Digits are entered only through a genuinely isolated DTMF path or portal (TB-03);
   until that is evidenced OTP fallback stays disabled. Single-factor SMS is not called strong MFA.
4. **Name and date of birth only locate a candidate** inside the restricted verification
   service (`IdentityDirectory.findCandidates`). Zero, one and multiple matches produce the same
   generic response; ambiguity goes to trusted human recovery. The platform never confirms that
   a person receives services before authorisation.
5. Caller ID / ANI is a hashed risk signal only. Knowledge-based answers, NPI, ZIP code,
   invoice details and voice familiarity never raise assurance.
6. Account recovery is never performed by the voice channel; login help follows the identity
   provider's recovery process (VQ-IDP-04).
7. A multi-role user selects one role; privileges are never combined. Role change starts a new
   session generation.

## Consequences

* Callers without a registered channel or portal account reach a human for verification;
  automation coverage is lower but enumeration and SIM-swap exposure are reduced.
* The verification service holds the only locator logic; the model never sees candidate counts.
* Real IdP behaviour (claims, MFA `amr` values, token lifetimes, JWKS rotation) is UNKNOWN until
  PRQ-036.

## Alternatives considered

| Alternative | Why not adopted |
|---|---|
| Date of birth plus another identifier as authentication | Discoverable identifiers; spec and NIST guidance reject |
| Voice biometrics | Biometric-law, licensing and spoofing concerns; not in scope (spec sections 2 and 11) |
| OTP to a number the caller supplies | Spec prohibits; trivially attacker-controlled |
| A second identity database | Spec: reuse existing IdPs, enrollment and recovery |

## Linked requirements

AUTH-01, AUTH-03, AUTH-05, AUTH-06, TB-03, SPEC-7 (assurance tiers, preferred verification
journey).

## Revisit when

Security approves verification parameters (PRQ-029), the identity owner publishes the A1
allowlist (PRQ-030), or TB-03 evidence arrives.
