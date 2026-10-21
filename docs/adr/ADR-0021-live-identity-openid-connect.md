# ADR-0021 Live caller and workforce identity over real OpenID Connect: backend code exchange, platform-terminated sessions, exact role mapping, break-glass workflow and dual-controlled recovery

| Field | Value |
|---|---|
| Status | **Accepted for engineering** (software scope; renumbered from the WP-05 proposal by the phase B integration package WP-07). Tenant IdP clients, groups, session parameters and processing bases: **Pending human approval** (AIN-12, AIN-13, AIN-15) |
| Date | 2026-10-21 (drafted in phase B by its work package; renumbered on integration) |
| Decided by | Principal engineer (coding agent) for the engineering scope only |
| Approval needed from | Security leadership (session parameters, recovery and break-glass procedure); tenant identity administrators (workforce client, role mapping, MFA amr values); privacy counsel (processing bases) |
| Related prerequisites | PRQ-003, PRQ-036; activation register AIN-12, AIN-13, AIN-15 |
| Origin | Proposed as `docs/adr/proposed/WP-05-workforce-sso.md` |

## Context

Context: follow-on FO-01-09, FO-01-11, FO-01-31, FO-03-28, FO-05-03 to FO-05-07, FO-05-09 to FO-05-11,
FO-05-13, FO-05-18, FO-05-19, FO-05-22, FO-05-27, FO-05-30, FO-05-41, FO-05-45, FO-14-02, FO-14-51, FO-14-52,
FO-17-24 (AUTH_EXPIRY_IDLE, IDP_UNAVAILABLE), FO-19-07, FO-22-05; invariants AUTH-01 to AUTH-07; ADR-0018
(follow-on architecture). Environment status: NOT_CONFIGURED (no tenant IdP client, group set, approved session
parameter or processing basis exists). Everything below is verified against the local Keycloak 26 only.

## Decision

1. **One OpenID Connect relying-party implementation, on the connector transport.** Discovery
   (`adapters/live/oidc-discovery.ts`), the relying-party client (`oidc-client.ts`) and the ID-token verifier
   use `jose` and the WP-06 `ConnectorHttpTransport` (egress-classified, pinned https, no redirects, bounded
   bodies). No OIDC client library is added (`openid-client` is not pinned in the repository). Discovery
   requires the exact issuer string, https endpoints on the issuer's host, `S256` PKCE, and fails closed after
   its cache TTL (no stale metadata). The authorization URL is built only from the discovered endpoint.
2. **The console uses a backend-for-frontend code exchange and opaque server-side sessions.** The browser
   holds only the PKCE verifier and state (consumed once) and an opaque console bearer (`vcs_`, 256 bits).
   The binding of one authorization request (nonce hash, challenge, exact redirect digest, lifetime) travels
   in a SEALED state (HMAC under a key outside the database, bound to tenant and issuer) whose single use is
   recorded at the exchange; the unauthenticated start writes nothing (decision 11). The authorization
   request carries `max_age = maxAuthAgeSeconds`, so the IdP re-authenticates a returning operator whose IdP
   session is older than the exchange accepts instead of handing back a code the backend must refuse. The
   backend redeems the code, validates the ID token twice (relying-party checks, then the workforce verifier with
   MFA amr), seals the IdP refresh token (AES-256-GCM, session hash as associated data) and stores only
   hashes. Alternatives considered: handing the IdP access token to the browser (rejected: a stolen token
   outlives logout and offboarding, and the console cannot enforce idle expiry on it); a cookie session
   (rejected: the console's no-cookie rule removes CSRF ambient authority).
3. **Sessions end on the platform's terms, not only the IdP's.** Every request enforces revocation, replay
   of a superseded bearer (whole family revoked), absolute lifetime and idle expiry against stored
   activity; refresh is not activity and never extends either limit. A bounded-interval RFC 7662
   introspection of the sealed refresh token is the offboarding signal (disabled or deleted user, IdP logout,
   group change); a background sweep applies it without a request. The groups are re-mapped at every check
   and an absent groups claim is an EMPTY group set, so removal from every managed group ends the session
   (an IdP whose introspection never carries the claim therefore ends sessions at the first check: fail
   closed). When the IdP cannot answer, a session keeps working only within a staleness bound, then fails
   closed.
4. **Same-actor continuity is checked, never assumed.** A refreshed ID token must carry the same issuer and
   subject (a different subject revokes the family). For callers, idle expiry drops privileges and fences the
   generation while remembering the lapsed actor; re-verification of a different actor is refused
   `SESSION_ACTOR_MISMATCH` unless an explicit participant change or account switch happened.
5. **Roles come from the console client's own IdP roles, mapped exactly; never from group names.** The
   default membership source is `CLIENT_ROLES`: the claim carries the roles of the console client at the IdP
   (Keycloak: a client role mapper restricted to the client; each managed group grants one role), every
   value is managed (an unlisted one refuses sign-in: drift fails closed). Group PATHS are spoofable on
   Keycloak 26 (a top-level group named `vsp/security-admin` has the managed group's path; fidelity finding
   below), so `GROUP_PATHS` is accepted only with the tenant's approval that its IdP makes paths unambiguous
   (Keycloak: escape-slashes-in-group-path), an IdP activation requirement. There is no static staff roster
   outside local/ci. MFA without a tenant override needs `mfa` or two distinct RFC 8176 factor classes.
6. **Break-glass is an issuance workflow with database-enforced separation of duties.** Request (reason code,
   ticket reference, at most four hours), independent decision before a deadline, grant, first use opening
   a post-use access review in the same transaction as its audit event, and an independent review. The
   database refuses self-decision, self-grant and self-review; a failure to open the review refuses the
   restricted access.
7. **SSO outage recovery is dual controlled and stays bound to the workforce IdP.** Recovery identities are
   hardware-backed P-256 keys proposed by one security admin for a holder who signed in by SSO recently and
   holds every proposed role at the IdP, confirmed by the HOLDER (a signature by the enrolled key over a
   one-time challenge, made in the holder's own SSO session: proof of possession tied to the IdP identity),
   and approved by another admin only after that confirmation (service and database CHECK). A RECOVERY
   session needs a request signed by the requester's key (anonymous requests consume nothing), ES256
   signatures over a single-use challenge from two different custodians who both still have recent positive
   IdP evidence, is short-lived, carries the identity's roles only and opens a post-use review on activation.
   A RECOVERY session is bound to the identity it was activated with: revoking or suspending that identity
   ends its sessions in the same transaction, every request re-checks the identity, and activation claims,
   re-checks both identities and both custodians under a share lock and issues the session in one
   transaction. The IdP keeps governing custodians, and the rule fails closed: every TERMINAL path of a staff
   member's SSO session family (logout, a refused refresh, the refresh-token replay closure, an idle or absolute
   expiry closure, the active check's revocation) asks the IdP (for a replay about the family's LIVE row) or uses
   its own answer, and decides once under a lock on the family's rows (`closeFamily`). Only a positive answer
   (the IdP vouches for the session's subject now with mapped roles) keeps an identity, and only one those roles
   cover (`CUSTODIAN_ROLES_REDUCED` otherwise); an inactive or refused token suspends every identity
   (`CUSTODIAN_OFFBOARDED`), and so does no answer at all (`CUSTODIAN_EVIDENCE_LOST`). No explanation of an
   inactive token is accepted (not its known expiry, not the row's own refresh, not another sign-in's logout:
   see the fidelity findings below); a family another terminal path already closed decides nothing more on a
   token state, but an answer about the person (another subject, no mapped role) always suspends. A request
   whose active check lost a refresh race on a live family is refused retryable and closes nothing (the refresh
   decides); the race window `REFRESH_IN_FLIGHT_SECONDS` (180 s) is the IdP part of one refresh at the transport's
   maximum (`OIDC_REFRESH_MAX_REQUESTS`, five sequential requests, 30 s each) plus a 30 s margin, and a refresh
   still running after it (a paused process) only fails closed: a second refresh reaches the IdP, the one with
   the redeemed token is refused, the family closes and the custodian is suspended. An ACTIVE answer on a family
   another path already closed still suspends the identities its roles no longer cover. Only a new MFA sign-in
   that maps the roles reinstates: never a positive answer at an active check, a refresh or a logout, nor roles
   that come back there. A terminal path whose transaction fails because its audit events cannot be written runs
   the same decision again without them (it only tightens) and appends the events on their own, logging an
   error, so an audit outage cannot keep a replayed or offboarded family live (OPS-01 is about accepting
   consequential actions; a revocation is protective, like the RECOVERY revocations already audited best effort
   after the fact). Rationale: three earlier rounds of
   verification each found a new edge case in a decision that grew explanation branches (a logout racing its own
   refresh, a refresh beyond the in-flight window, the replay closure that asked the IdP nothing); suspension is
   cheap and reversible, activation still needs a second custodian, so the decision now has no explanation to get
   wrong. Cost, accepted: an employed custodian whose session ends with an inactive token or without an IdP
   answer is suspended until their next sign-in, so during an IdP outage custodians whose SSO session ends cannot
   be reinstated until the IdP is back (break-glass relies on the others; access-review runbook). Alternatives
   rejected: permanently revoking on an inactive token (a normal logout or IdP session end would destroy the
   recovery credential exactly when it might be needed); explaining inactive tokens by the family's own events
   (each explanation was an unexplored race); no link at all (an offboarded operator with a cosigner keeps
   console access).
8. **High-risk human-only actions and A1 operations are policy data.** `catalogue.highRisk.humanOnlyActions`
   denies those actions to any non-human actor (`HIGH_RISK_HUMAN_ONLY`); A1 (OTP) counts as A0 unless the
   tenant approved the operation list (`catalogue.assuranceA1`, approval reference required, only low-risk
   operations admissible), enforced by Rego and by catalogue invariants.
9. **Fault seams are injected clocks and real outages, and can only tighten.** `SessionExpirySeam` moves time
   without touching the stored record (refused outside local/ci); IdP unavailability is a real stopped TLS
   front in Layer 2. The policy engine's evaluator decoration seam (POLICY_ENGINE_ERROR) is refused outside
   local/ci and on an engine loaded for a deployed environment, and is tighten-only for any substituted
   evaluator: a decorated allow wider than the loaded policy's decision for the engine's own input is a
   `POLICY_ENGINE_ERROR` deny. The decoration never sees that input: it gets a deep-frozen clone, and the
   loaded evaluator it wraps is a frozen view kept in a private field.
10. **Every reader of a caller session applies idle expiry.** `resolve`, the Talkdesk auth gate and the
   step-up completion refuse lapsed privileges; the gate closes and fences the generation exactly as
   `resolve` does.
11. **Unauthenticated auth endpoints are bounded in storage and in audit volume without a shared cap.** The
   sign-in start is stateless (sealed state), so an anonymous flood consumes nothing a legitimate sign-in needs;
   a per-tenant pending cap was rejected because an anonymous client could fill it and lock every operator out
   for a whole state lifetime (verifier probe B). Single-use rows are written only for valid, unexpired states
   at the exchange and deleted by the sweeper after expiry (the database refuses to delete live ones),
   forged, foreign and used states are not audited, every other anonymous exchange refusal passes a per-window audit budget
   that carries the suppressed count, and recovery challenges need the custodian's own signature before the
   per-identity cap counts them. Request-rate limiting at the edge belongs to the composition.
12. **An IdP URL the egress policy refuses is a configuration error, not an outage.** The issuer's discovery
   URL is checked against the egress policy when the discovery adapter is built, discovered server-side
   endpoints when they are validated, and a request-time refusal maps to `OIDC_EGRESS_REFUSED`
   (`ConfigurationRejectedError`, never retried; the console answers `503 OIDC_EGRESS_REFUSED`, not
   retryable). The egress PHI heuristic itself (privacy owner) should treat UUID-shaped path segments as
   opaque (hand-off).

## Emulator fidelity findings (Layer 2)

* Keycloak 26 OMITS the `groups` claim from the ID token and from refresh-token introspection when the user
  has no groups; it never sends an empty array. The console reads an absent claim as "no groups" (a group
  unassignment ends the session); unit fixtures model the same omission.

* The production transport refuses loopback and IP literals, so the suite fronts the shared Keycloak with a
  per-run TLS proxy and a per-run test CA as `idp.vsp-identity.test`; each realm's `frontendUrl` makes the
  issuer, authorization and end-session endpoints use that origin, while back-channel endpoints follow the
  forwarded `Host`.
* Keycloak's own SSO cookie signs the previous user in again in the same user agent; tests use a fresh agent
  per login, except `workforce-reauth.test.ts`, which keeps ONE agent on purpose: with `max_age` Keycloak
  re-authenticates (password page with the user known, then TOTP) once the IdP session is older than the
  bound, and answers from the SSO session without a form inside it. A tenant console may need `prompt=login`
  for shared workstations (open point).
* RFC 7009 revocation of one sign-in's refresh token ends that token family only: Keycloak 26 keeps the
  user's other IdP sessions (other browsers) and their refresh tokens active (verifier probe K1, asserted in
  `workforce-sso-adversarial.test.ts`). The IdP therefore never "ends every token on logout": one sign-in's
  logout says nothing about another, and the console never takes it as an explanation.
* With `revokeRefreshToken` and `refreshTokenMaxReuse: 0`, Keycloak 26 reports a refresh token it has just
  redeemed as INACTIVE to introspection, before the console has recorded the rotation (asserted in
  `workforce-sso-adversarial.test.ts`, verifier probe R). A logout racing the session's own refresh therefore
  sees an inactive token and, under the fail-closed rule, suspends even an employed custodian (asserted; the next
  sign-in reinstates them); a request whose active check races that refresh is refused retryable. Revoking that
  redeemed token (RFC 7009, the logout) also ends the successor Keycloak issued to the refresh: the test's
  assertion that the successor is inactive held even with the console's own revocation of it removed
  (Layer-2 mutant run). The console revokes the successor itself anyway (the unit fixture's revocation does not
  end it, and the unit test fails without it), so an IdP that behaves like the fixture still loses the tokens.
* Group full paths are not unique on Keycloak 26: a top-level group whose NAME contains `/`
  (`vsp/security-admin`) gets the path `/vsp/security-admin`, byte-identical to the nested managed group, and
  the group membership mapper emits it unchanged (verifier probe K2, asserted in
  `workforce-sso-adversarial.test.ts`). The escape-slashes-in-group-path server option would make it
  `/vsp~/security-admin`; it is a server-wide startup option, so the shared local Keycloak is not switched
  (hand-off to the `deploy/local/README.md` owner to record it as a composition fidelity note).
* With only the OTP step labelled (`auth-otp-form` reference `otp`), a password + TOTP login carries
  `amr: ["otp"]`: amr reflects the labelled steps, not the factors used. The default MFA rule refuses it.
* A freshly created realm's first discovery can exceed three seconds under shared load; the suite waits for
  the realm and uses a ten-second timeout. Production timeouts stay configuration.
* A TOTP credential can be pre-provisioned through realm import; logins then carry `amr` `pwd` + `otp` when
  the authenticator references are configured. `revokeRefreshToken` with `refreshTokenMaxReuse: 0` makes a
  reused refresh token `invalid_grant`; a disabled user introspects `active: false` and cannot log in.

## Consequences

* The composition root (WP-07) must construct the live console SSO dependencies, add `consoleAuth` to
  `PlatformConfig` with the guard call, schedule the sweep, and pass identity configuration
  (`privilegeIdleTimeoutSeconds`, `approvedProcessingBases`, `jurisdiction`).
* Retention registration (WP-22) for the new console session, login, break-glass, access-review and recovery
  tables.
* Tenant inputs: the workforce OIDC client and secret reference, the console client roles and the groups that
  grant them (or, for GROUP_PATHS, the unambiguous-paths approval), MFA amr values (or the default rule),
  session parameters approved by security (AIN-12, AIN-13, AIN-15), and counsel-approved processing bases.
* The portal application's own OIDC client is outside this repository; the gateway portal routes are
  unchanged.
* Phase B integration (WP-07, [ADR-0023](ADR-0023-live-composition-root.md)): `platform/src/main/live-console.ts` builds the console SSO dependencies from the live container (OIDC over the connector transport, sealed refresh tokens with a Secrets Manager key, the PostgreSQL session store), adds `consoleAuth` to `PlatformConfig` with its guard rules, schedules the sweep and passes the recovery policy values; the app-level auth prefix rate limit is per source address (the per-client edge limit is the WAF, WP-39).

## Alternatives considered

| Alternative | Why not adopted |
|---|---|
| An OIDC client library (openid-client) | Not pinned in the repository; the relying party is built on `jose` and the WP-06 egress-classified transport so every IdP call passes the same egress and TLS checks |
| Hand the IdP access token to the browser | A stolen token outlives logout and offboarding, and the console cannot enforce idle expiry on it (decision 2) |
| Cookie sessions | The console's no-cookie rule removes CSRF ambient authority (decision 2) |
| Roles from group names or paths | Group paths are spoofable on Keycloak 26 (fidelity finding); roles come from the console client's own IdP roles (decision 5) |
| Explain inactive tokens at terminal paths | Each explanation branch was an unexplored race; the custodian decision fails closed (decision 7) |

## Linked requirements

AUTH-01, AUTH-02, AUTH-03, AUTH-04, AUTH-05, AUTH-06, AUTH-07, OPS-01; FO-01-09, FO-01-11, FO-01-31, FO-03-28, FO-05-03 to FO-05-07, FO-05-09 to FO-05-11, FO-05-13, FO-05-18, FO-05-19, FO-05-22, FO-05-27, FO-05-30, FO-05-41, FO-05-45, FO-14-02, FO-14-51, FO-14-52, FO-17-24 (AUTH_EXPIRY_IDLE, IDP_UNAVAILABLE), FO-19-07, FO-22-05

## Revisit when

When a tenant workforce IdP is selected (AIN-13), the egress owner treats UUID-shaped path segments as opaque, or a shared-workstation policy needs `prompt=login`.
