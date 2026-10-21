# platform/src/console-api: console API v1 (contract + backend)

Status: **IMPLEMENTED_OFFLINE**. `contract.ts` defines the operations and incident control
console API (spec sections 6, 7, 12, 13 and 16); `plugin.ts` implements every endpoint as a
Fastify plugin (`registerConsoleApi(app, deps)`), tested with `fastify.inject` over real
modules on PGlite. The React console (`console/`) is tested against the same contract with a
labelled mock backend. Workforce SSO (WP-05) is implemented over real OpenID Connect
(discovery, authorization code + PKCE S256, backend exchange, refresh rotation, RFC 7662
introspection, RFC 7009 revocation) with server-side console sessions, and is verified locally
against Keycloak (`platform/test/integration/identity/workforce-sso.test.ts`). The tenant's
workforce IdP client, group names and approved parameters are activation inputs (PRQ-036,
VQ-IDP-08, AIN-12/13/15); the environment stays NOT_CONFIGURED. Nothing here has been verified
against a vendor, a real tenant IdP or production, and nothing here claims HIPAA compliance or
production readiness.

## Why types and constants only

`contract.ts` has no imports and no runtime dependencies. The console imports it with a
relative path (`console/src/api/contract.ts` re-exports it) and has no zod. The backend
implements matching strict zod schemas (`z.strictObject`, bounded sizes, closed enums) and
must assert type equality against these interfaces (see "Keeping the contract in sync").

## Endpoints (base `/console/api/v1`)

Generated from `CONSOLE_ENDPOINTS`, `ENDPOINT_ROLES` and `PUBLIC_ENDPOINTS`. The roles column
is necessary, not sufficient: the finer rules below also apply.

| Key | Method | Path | Roles (any one) |
|---|---|---|---|
| `auth.config` | GET | `/auth/config` | public (no token) |
| `auth.localStaff` | GET | `/auth/local/staff` | public (no token) |
| `auth.localToken` | POST | `/auth/local/token` | public (no token) |
| `auth.oidcStart` | POST | `/auth/oidc/start` | public (no token) |
| `auth.oidcExchange` | POST | `/auth/oidc/exchange` | public (no token) |
| `auth.refresh` | POST | `/auth/refresh` | public (console session bearer; no role check) |
| `auth.recoveryChallenge` | POST | `/auth/recovery/challenge` | public (no token) |
| `auth.recoveryActivate` | POST | `/auth/recovery/activate` | public (no token) |
| `auth.logout` | POST | `/auth/logout` | `support_agent`, `supervisor`, `safety_responder`, `auditor`, `knowledge_editor`, `policy_approver`, `deployment_operator`, `security_admin` |
| `me` | GET | `/me` | `support_agent`, `supervisor`, `safety_responder`, `auditor`, `knowledge_editor`, `policy_approver`, `deployment_operator`, `security_admin` |
| `overview` | GET | `/overview` | `support_agent`, `supervisor`, `safety_responder`, `deployment_operator`, `security_admin` |
| `calls.list` | GET | `/calls` | `support_agent`, `supervisor`, `safety_responder` |
| `calls.get` | GET | `/calls/:callId` | `support_agent`, `supervisor`, `safety_responder` |
| `calls.transfer` | POST | `/calls/:callId/transfer` | `support_agent`, `supervisor`, `safety_responder` |
| `supportRequests.trace` | GET | `/support-requests/:ref/trace` | `support_agent`, `supervisor`, `safety_responder` |
| `supportRequests.repair` | POST | `/support-requests/:ref/repair` | `supervisor` |
| `actions.pending` | GET | `/actions/pending` | `support_agent`, `supervisor` |
| `actions.cancel` | POST | `/actions/:actionId/cancel` | `support_agent`, `supervisor` |
| `reconciliation.list` | GET | `/reconciliation` | `supervisor` |
| `reconciliation.reconcile` | POST | `/reconciliation/:actionId/reconcile` | `supervisor` |
| `reconciliation.retry` | POST | `/reconciliation/:actionId/retry` | `supervisor` |
| `outbox.requeue` | POST | `/outbox/:messageId/requeue` | `supervisor` |
| `workflows.tasks` | GET | `/workflows/tasks` | `support_agent`, `supervisor` |
| `workflows.decision` | POST | `/workflows/tasks/:taskId/decision` | `support_agent`, `supervisor` |
| `safetyEvents.list` | GET | `/safety-events` | `safety_responder`, `supervisor` |
| `releases.list` | GET | `/releases` | `policy_approver`, `knowledge_editor`, `security_admin`, `auditor` |
| `releases.review` | POST | `/releases/:releaseId/review` | `policy_approver`, `knowledge_editor` |
| `budgets.list` | GET | `/budgets` | `supervisor`, `security_admin`, `deployment_operator` |
| `killSwitches.list` | GET | `/kill-switches` | `supervisor`, `security_admin`, `deployment_operator` |
| `killSwitches.set` | POST | `/kill-switches` | `supervisor`, `security_admin`, `deployment_operator` |
| `audit.search` | GET | `/audit/search` | `auditor`, `security_admin` |
| `destinations.list` | GET | `/destinations` | `support_agent`, `supervisor`, `safety_responder`, `security_admin` |
| `breakGlass.list` | GET | `/break-glass/requests` | every staff role (non-admins see their own requests) |
| `breakGlass.request` | POST | `/break-glass/requests` | `deployment_operator`, `knowledge_editor`, `policy_approver`, `safety_responder`, `security_admin`, `support_agent`, `supervisor` |
| `breakGlass.decide` | POST | `/break-glass/requests/:requestId/decision` | `security_admin` |
| `accessReviews.list` | GET | `/access-reviews` | `security_admin`, `auditor` |
| `accessReviews.complete` | POST | `/access-reviews/:reviewId/complete` | `security_admin` |
| `recoveryIdentities.list` | GET | `/recovery-identities` | `security_admin` |
| `recoveryIdentities.propose` | POST | `/recovery-identities` | `security_admin` |
| `recoveryIdentities.confirm` | POST | `/recovery-identities/:identityId/confirm` | the holder named by the identity only (`security_admin`, `supervisor`, `safety_responder`), in an SSO session |
| `recoveryIdentities.approve` | POST | `/recovery-identities/:identityId/approve` | `security_admin` |
| `recoveryIdentities.revoke` | POST | `/recovery-identities/:identityId/revoke` | `security_admin` |

Finer rules the server enforces:

* `killSwitches.set`: the staff member also needs a role in `KILL_SWITCH_SCOPE_ROLES[scope]`
  (mirrors `KILL_SWITCH_ROLES` in `platform/src/ops/staff-authz.ts`: model and voice version
  switches also allow `deployment_operator`).
* `workflows.decision`: the staff member needs one of the task's `requiredStaffRoles`
  (`BUSINESS_ROLE_STAFF_MAPPING`, `platform/src/workflows/types.ts`); `workflows.tasks` returns
  only tasks for the caller's roles.
* `releases.review`: role per release kind (`RELEASE_REVIEW_ROLES`); a reviewer never reviews a
  release they submitted (`SELF_REVIEW_FORBIDDEN`).
* `actions.cancel`: `support_agent` only for calls they currently own; only `PREPARED` /
  `CONFIRMED` actions; `COMMITTING` and later are refused (`ACTION_NOT_CANCELLABLE`).
* `reconciliation.retry`: only when the action's latest reconciliation returned `NOT_FOUND` and
  `reconciliationId` names that reconciliation (`RECONCILE_REQUIRED` otherwise) (ACT-03).
* `calls.transfer`: `destinationId` must be in the trusted allowlist (`DESTINATION_NOT_ALLOWLISTED`,
  SAFE-05); the response state is `REQUESTED`/`QUEUED`, never success (SAFE-04).
* `supportRequests.repair`: only a `DEAD_LETTER` Salesforce sync (`409 STATE_CONFLICT` otherwise);
  restricted (privacy / safety) requests additionally need `restricted_record:view` (valid break-glass
  approved by someone else), exactly as reading them; reason codes from
  `OPERATOR_REASON_CODES["supportRequests.repair"]`; the response is `syncState: PENDING` (the sync is
  asynchronous, never reported done here).

## Authentication

* **Workforce SSO (`sso.ts`, WP-05).** Authorization code + PKCE (S256, RFC 7636), backend
  exchange, IdP tokens never reach the browser.
  1. `GET auth/config` reports `oidc.state: CONFIGURED` with the issuer, client id and the
     authorization endpoint resolved from the issuer's discovery document (exact issuer match,
     https endpoints, cached with a bounded TTL; `authorizationEndpoint: null` +
     `blockedReasonCode: WORKFORCE_IDP_UNAVAILABLE` while discovery fails), the session policy
     (`idleTimeoutSeconds`, `absoluteLifetimeSeconds`) and whether recovery is available.
  2. `POST auth/oidc/start {redirectUri, codeChallenge}`: the redirect must be in the exact
     allowlist (`consoleAuth.redirectUris`; `REDIRECT_URI_NOT_ALLOWED`); the backend creates the
     nonce and a SEALED state (`login-state.ts`: nonce hash, the browser's challenge, a digest of the
     redirect, issue time and lifetime, HMAC-SHA256 under a per-purpose subkey of the sealer key, bound
     to tenant and issuer) and returns the authorization URL built from the DISCOVERED endpoint with
     `max_age = maxAuthAgeSeconds`, so the IdP re-authenticates an operator whose IdP session is older
     than the exchange accepts (a returning operator is never handed a code the backend must refuse).
     The unauthenticated start WRITES NOTHING: an anonymous flood of starts consumes no capacity a
     legitimate sign-in needs (no per-tenant cap to exhaust; the WP-07 edge rate limit stays an extra
     layer). The browser keeps only state and code verifier (sessionStorage, consumed once) and checks
     the URL's origin and path equal the configured endpoint before redirecting.
  3. `POST auth/oidc/exchange {code, state, codeVerifier, redirectUri}`: before the IdP is
     contacted the state must open under the key for this tenant and issuer (forged, altered or
     foreign, or any spelling but the canonical base64url one of its bytes: `LOGIN_TRANSACTION_UNAVAILABLE`,
     logged, not audited per request; expired: the same code, audited through the anonymous budget), its
     single use is recorded, keyed on the canonical encoding of the authenticated bytes
     (`console_login_transactions` row inserted consumed; a replayed or raced callback
     `LOGIN_TRANSACTION_UNAVAILABLE`), the redirect
     equals the sealed one (`REDIRECT_URI_MISMATCH`) and S256(verifier) equals the sealed challenge
     (`PKCE_VERIFIER_MISMATCH`). The code is redeemed at the token endpoint, the
     ID token is validated (signature over the discovered JWKS, iss, aud, azp, nonce hash,
     auth_time / max age, at_hash) and checked again by `WorkforceTokenVerifier` (MFA: `amrSatisfiesMfa`,
     `STAFF_MFA_REQUIRED`), the membership claim maps to staff roles (below) and an opaque console
     session bearer (`vcs_` + 256 bits) is issued, audited in the same transaction as the session row
     (`console_sessions`, hash only).
     * **MFA (FO-05-41, AIN-13).** Without a tenant override (`acceptedMfaAmr: null`) the default rule
       needs `mfa` or amr values of two DISTINCT RFC 8176 factor classes (pwd + otp, hwk + pin): a single
       value (otp, swk, hwk, pop, sms alone) is one factor and never MFA. A tenant override lists the
       values it accepts (any one suffices; `pwd` can never be listed).
     * **Membership (FO-05-41, FO-01-09).** `membershipSource` declares what `groupsClaim` carries.
       `CLIENT_ROLES` (required unless attested otherwise): the console client's own roles at the IdP
       (Keycloak: a client role mapper restricted to the client, each managed group granting one role),
       mapped exactly by `groupRoles`; every value is managed, so an unlisted role refuses
       (`STAFF_GROUP_UNKNOWN`) and `managedGroupPrefix` must be null. Group NAMES never grant a role: on
       Keycloak 26 a top-level group named `vsp/security-admin` has the same full path as the managed
       nested group (Layer-2 fidelity finding). `GROUP_PATHS` is accepted only with
       `unambiguousPathsRef`, the approval that the tenant IdP makes paths unambiguous (Keycloak:
       escape-slashes-in-group-path), an IdP activation requirement; an unlisted path under the managed
       prefix refuses. No mapped role: `STAFF_NOT_PROVISIONED`.
  4. Every request: the bearer is looked up by hash; revocation, replay of a superseded bearer
     (revokes the whole family, `SESSION_TOKEN_REPLAYED`), absolute expiry (`SESSION_EXPIRED`) and
     idle expiry (`SESSION_IDLE_EXPIRED`, `lastActivityAt + idleTimeoutSeconds`) are enforced on
     every use; activity is recorded at a bounded write rate; at most every
     `activeCheckIntervalSeconds` the backend introspects the sealed IdP refresh token (RFC 7662):
     a disabled, deleted or logged-out user loses the session (`STAFF_DEPROVISIONED`), the membership
     claim is re-mapped every time and changes take effect. An ABSENT membership claim is an empty
     set (Keycloak omits the claim for a user without groups or roles), so a user removed from every
     managed group loses the session (`STAFF_NOT_PROVISIONED`); the introspected subject must be the
     session's (`SESSION_SUBJECT_CHANGED`). Configuration requirement: the IdP must put the membership
     claim into token introspection, otherwise every session ends at its first check (fail closed).
     When the IdP cannot answer the session keeps working only within
     `activeCheckMaxStalenessSeconds`, then fails closed (`STAFF_ACTIVE_STATE_UNVERIFIED`).
  5. `POST auth/refresh` (the console bearer in `Authorization`): the row is first claimed
     (`refresh_started_at`; one refresh of a row reaches the IdP at a time: a second one within
     `REFRESH_IN_FLIGHT_SECONDS` is refused `SESSION_ROTATED` retryable without an IdP call), then the
     sealed refresh token is redeemed (rotation); the refreshed ID token must carry the same issuer and
     subject, a different subject revokes the family (`SESSION_SUBJECT_CHANGED`, never a silent actor
     switch); the console bearer is rotated (old bearer superseded atomically). Refresh is not
     activity: it never extends the idle window or the absolute lifetime. A refresh the IdP refuses
     (`invalid_grant`) is a terminal path: the family is closed (`SESSION_REFRESH_REFUSED`) and decides
     about the custodian (below); a refresh that ends without a redemption the backend recorded (IdP
     unreachable, unknown outcome, an invalid answer) releases its own claim and closes nothing (the next
     active check asks the IdP). When the family was closed while the IdP redeemed the token (a logout
     raced the refresh), the tokens the IdP just issued are revoked there and the response is
     `401 SESSION_REVOKED`. `REFRESH_IN_FLIGHT_SECONDS` (180) is the IdP part of one refresh at the OIDC
     transport's maximum per-request deadline (`OIDC_REFRESH_MAX_REQUESTS`, 5 sequential requests: an
     expired discovery document, the token request, the key set, the discovery document expiring again
     during the refresh and an unknown-kid key refetch, `OIDC_REQUEST_TIMEOUT_MAX_MS` 30 s each; pinned in
     `oidc-client.test.ts`) plus a 30 s margin for the console's database work; a crashed refresh's claim
     lapses after it. The window does not bound a paused process or a database wait beyond the margin: a
     refresh still running after it lets a second refresh of the row reach the IdP, the one that presents
     the token the IdP already redeemed is refused, the family closes and the custodian is suspended
     (availability only, never fail open; `break-glass.test.ts`, verifier probe P3).
  6. `POST auth/logout` revokes the family and its IdP refresh token (RFC 7009, best effort,
     `OIDC_REVOCATION_FAILED` logged). Revocation ends that token family only: Keycloak 26 keeps the
     user's other IdP sessions (other browsers) active (Layer-2 probe K1, asserted in
     `workforce-sso-adversarial.test.ts`). It first asks the IdP (best effort) whether the token is still
     active; that answer decides about the custodian (below), whatever refresh of the row is in flight.
     `WorkforceSsoService.sweep` closes idle and absolutely expired sessions (each asks the IdP first and
     decides, like every terminal path), re-checks active sessions in the background so offboarding does
     not wait for the next request (disabled users and users removed from every managed group), closes
     RECOVERY sessions whose identity is no longer ACTIVE, and deletes the single-use rows of expired
     login states in bounded batches (the database refuses to delete a live one, migration `2052`). The
     composition must schedule it (WP-07).
  The IdP refresh token is sealed with AES-256-GCM (`token-sealer.ts`, key id recorded per row,
  the session hash as associated data). Configuration: `WorkforceSsoConfigSchema`
  (`sso-config.ts`): the schema refuses, in every environment, redirect URIs that are not absolute
  canonical https URLs or carry a wildcard, userinfo, query or fragment, issuers that are not absolute
  canonical https URLs (no userinfo, query, fragment, dot segments, default port or trailing slash),
  `pwd` in an MFA list, a GROUP_PATHS source without its approval and idle timeouts above the absolute
  lifetime; `workforceSsoGuardViolations` adds the environment rules (loopback redirects and emulator
  issuers outside local/ci, unapproved session parameters in staging/production).
  Anonymous exchange refusals (no verified identity behind them: wrong PKCE verifier, redirect or
  issuer mismatch, a code the IdP refuses, an ID token failing the independent check, an expired
  transaction) pass the anonymous audit budget (`anonymous-audit.ts`): at most one audit event per
  action and reason per 60 s window per instance, the suppressed count carried on the next event
  (`kv://console-anonymous-audit/suppressed/<n>`) and one log line per window; a refused sign-in of
  an IdP-authenticated person (MFA, groups) is audited per event under their pseudonymous staff id.
  An IdP URL the egress policy refuses (for example an issuer path the PHI heuristic flags) is a
  configuration refusal: `503 OIDC_EGRESS_REFUSED`, not retryable, never `WORKFORCE_IDP_UNAVAILABLE`.
* **Recovery custodians follow the IdP, fail closed (FO-14-52).** A staff member's recovery
  identities are decided at every TERMINAL path of their SSO session family: logout, a refused refresh,
  the refresh-token replay closure (a superseded bearer presented after the grace), an idle or absolute
  expiry closure (by a request or the sweep), and the revocation by an active check. Each path asks the
  IdP (RFC 7662 introspection of the family's live refresh token; for a replay the LIVE row's, never the
  superseded one's) or uses the IdP's own answer (a refused grant), then decides ONCE, under a lock on
  the family's rows and in the same transaction as the revocation and its audit events
  (`sessions.ts` `closeFamily`):
  * the IdP vouches for the session's subject now and its membership maps roles: identities those roles
    still cover stay ACTIVE, the others are suspended (`CUSTODIAN_ROLES_REDUCED`);
  * the token is inactive or refused (disabled or deleted user, IdP logout, a token past its expiry,
    another sign-in sharing the IdP session, a refresh of the row that redeemed it): every ACTIVE identity
    is suspended (`CUSTODIAN_OFFBOARDED`);
  * no answer at all (the IdP cannot be asked, a timeout, an adapter refusal, no refresh token): every
    ACTIVE identity is suspended (`CUSTODIAN_EVIDENCE_LOST`);
  * an answer about the person that covers nothing (another subject, a membership that maps to no or an
    unknown role): every ACTIVE identity is suspended (`CUSTODIAN_OFFBOARDED`), even when another terminal
    path closed the family first.
  Suspending also revokes the staff member's RECOVERY sessions, audited
  (`console.recovery_identity.suspended` with the reason). Nothing explains an inactive token away: not
  its known expiry, not the row's own refresh, not another sign-in's logout. A token state or a missing
  answer on a family another terminal path already closed decides nothing more (that path decided with
  its own answer and revoked the token at the IdP; for example a refresh that was waiting for the IdP
  while its family was logged out is refused because of that logout). The only non-terminal case is a
  request whose active check lost a refresh race on a live family (its row rotated by a committed
  refresh, or a refresh of it claimed within `REFRESH_IN_FLIGHT_SECONDS`): it is refused `401
  SESSION_ROTATED` (retryable), closes nothing, and the refresh decides by its own outcome; an answer
  about the person is never deferred to such a race, and a family another path closed meanwhile is no
  race (`401 SESSION_REVOKED`). An ACTIVE answer on a family another path already closed still suspends
  the identities its roles no longer cover. Suspension is cheap and reversible: only a new SSO sign-in
  (MFA) whose mapped roles cover a SUSPENDED identity reinstates it (`console.recovery_identity.reinstated`);
  a positive answer at an active check, a refresh or a logout never does, nor do roles that come back
  there. When a terminal path's transaction fails (its audit events cannot be written), the same decision
  runs again under the same lock WITHOUT them, because it only revokes and suspends, and the events are
  then appended on their own; `console.sso.terminal_closure_unaudited` is logged as an error, and
  `console.sso.terminal_audit_unwritten` for each event the audit store still refuses (access-review
  runbook step 3b). An audit outage therefore never leaves a replayed or offboarded family live; when the
  database itself fails, the original error stands (no session can be used then either). Consequences, accepted by design: an employed
  custodian is suspended when their session ends with an inactive token (a refresh that redeemed it,
  two console sign-ins sharing one IdP session, a token past its expiry) or while the IdP cannot be
  asked (an IdP outage); configure the IdP's refresh-token lifetime (Keycloak: SSO session idle and
  max) above the console's idle timeout and absolute lifetime so a normal idle or absolute expiry finds
  the token active. During an IdP outage, custodians whose SSO session ends are suspended and cannot be
  reinstated until the IdP is back: break-glass then relies on custodians whose sessions did not end
  during the outage (access-review runbook).
* **Break-glass recovery (`recovery.ts`, WP-05).** When the workforce IdP is unavailable, a
  dual-controlled recovery identity (hardware-backed P-256 key, proposed by one security admin,
  confirmed by the holder, approved by another admin) can open a RECOVERY session:
  `auth/recovery/challenge` needs a request signed by the requester's own key (compact ES256 JWS,
  `typ: vsp-recovery-request+jwt`, single-use nonce; anonymous, wrong-key, stale and replayed
  requests write and count nothing: `401 RECOVERY_REQUEST_PROOF_INVALID` / `RECOVERY_REQUEST_REPLAYED`)
  and issues a single-use challenge; `auth/recovery/activate` needs compact ES256 JWS signatures
  (`typ: vsp-recovery+jwt`) over that challenge from TWO different custodians' identities. The
  session is short-lived, holds the identity's roles only, and opens a post-use access review. A
  RECOVERY session is bound to the identity it was activated with (its subject digest): every
  request re-checks that this identity is still ACTIVE (`RECOVERY_IDENTITY_REVOKED`), revoking the
  identity revokes its recovery sessions in the same transaction whatever other identities the
  holder has, and the activation claims, re-checks both identities under a share lock and issues
  the session in ONE transaction (a concurrent revocation or suspension is seen, or waits and then
  ends the new session). Inside that transaction BOTH custodians must still have positive
  workforce-IdP evidence (an SSO sign-in, refresh or active check) within `holderSsoMaxAgeSeconds`
  (default 14 days) and the requester's identity roles must still be mapped for them
  (`RECOVERY_HOLDER_NOT_AUTHENTICATED`, `RECOVERY_ROLES_NOT_GRANTED`,
  `RECOVERY_COSIGNER_NOT_AUTHENTICATED`). The per-identity bound (3 pending challenges and 20 per
  hour, `503 RECOVERY_CHALLENGE_LIMIT`, nothing written) counts signed requests only.
* **Local fixture (offline only).** `GET auth/local/staff` lists synthetic staff from
  `platform/src/fixtures/synthetic-world.ts` `STAFF`; `POST auth/local/token` with `{staffId}`
  authenticates one of them through the local workforce IdP fixture (mfa true, amr
  `local_fixture`) and returns a token with `localFixture: true`. Register these two routes ONLY
  when the environment is `local` or `ci` and the workforce IdP adapter kind is `local_fixture`;
  everywhere else they return 404 `LOCAL_FIXTURE_DISABLED`, and the production configuration
  guard must reject them (OPS-04). The console additionally shows the picker only when
  `auth/config` reports `mode: local_fixture`, `localFixture: true` and environment local/ci.
* Every authenticated request carries `Authorization: Bearer <token>`. The console keeps the token
  in memory only; cookies are never used (`credentials: "omit"`), so there is no ambient
  authority for CSRF.
* `GET me` returns the server-established `StaffView`, the session kind (`LOCAL_FIXTURE`,
  `OIDC_SSO`, `RECOVERY`) and the idle timeout. Sessions without MFA are refused. Outside local/ci
  only console session bearers are accepted (a raw IdP or fixture JWT answers `401
  UNAUTHENTICATED`), and the plugin refuses to register without SSO
  (`WORKFORCE_SSO_NOT_CONFIGURED`).
* **Break-glass issuance (`break-glass-issuance.ts`, WP-05).** `breakGlass.request` records a
  justified, time-bound request (at most `BREAK_GLASS_MAX_DURATION_SECONDS`, 4 hours, defined once in
  `schemas.ts` and pinned by `break-glass.test.ts` "[FO-05-45] one maximum" to policy data
  `console.breakGlass.maxDurationSeconds` and the CHECK of migration 2051; reason
  code + opaque ticket reference); `breakGlass.decide` by a DIFFERENT `security_admin` before
  `decideBy` approves (creating the grant in `console_break_glass_grants`) or rejects; the
  database refuses a self-decided request and a self-granted grant. The FIRST use of a grant
  (a policy decision with the `BREAK_GLASS_REVIEW` obligation) opens a post-use access review
  in the same transaction as the `console.break_glass.first_use` audit event (concurrent first
  uses open one review and commit one first-use event; the loser rolls back); if the review
  cannot be recorded the request is refused (`503 ACCESS_REVIEW_UNAVAILABLE`). Row-level security
  hides a request from its requester for update, and table constraints refuse self-decision,
  self-grant and self-review for any writer. `accessReviews.complete`
  needs a reviewer who is neither the holder nor the approver.
* **Recovery identities.** Enrollment is bound to the holder at the workforce IdP:
  1. `recoveryIdentities.propose` (public JWK, custodian staff id, attestation reference, roles) by a
     security admin who is not the holder. Refused unless the holder signed in by SSO within
     `holderSsoMaxAgeSeconds` (`409 RECOVERY_HOLDER_NOT_AUTHENTICATED`: a staff id that never
     authenticated through the IdP) and every role is one the directory mapped for them
     (`403 RECOVERY_ROLES_NOT_GRANTED`). Returns the one-time enrollment challenge (shown once).
  2. `recoveryIdentities.confirm` by the HOLDER, in their own SSO session (policy
     `recovery_identity:confirm`, holder only; a recovery or local session is refused
     `RECOVERY_HOLDER_SSO_REQUIRED`): a compact ES256 JWS by the enrolled key
     (`typ: vsp-recovery-enroll+jwt`) over the challenge, the identity, the staff id and the key
     thumbprint. A key the proposer holds can never be confirmed by the holder
     (`RECOVERY_HOLDER_PROOF_INVALID`).
  3. `recoveryIdentities.approve` by a different security admin, only after the confirmation
     (`409 RECOVERY_HOLDER_UNCONFIRMED`; also a database CHECK).
  `revoke` with a reason ends the recovery sessions activated with THAT identity, in the same
  transaction. Status: `PROPOSED`, `ACTIVE`, `SUSPENDED` (the IdP no longer vouches for the
  holder; `suspendReason`), `REVOKED`.

## Binding backend rules

1. Authorize every request server-side from the verified token (AUTH-02, AUTH-03). Never trust
   a role, staff id or tenant in a body or query.
2. Path parameters must match `PATH_PARAM_PATTERNS` (opaque ids, `SR-XXXX-XXXX` references);
   query parameters are metadata filters only. No PHI in URLs (spec section 6).
3. Responses are content-free: no transcript text, audio, recording links, caller summaries,
   raw queries, shared secrets, evidence-object bodies or Step Functions task tokens. There is
   deliberately no field in the contract that could carry them.
4. Every mutation writes its audit event in the same transaction as the change and refuses with
   `AUDIT_UNAVAILABLE` when it cannot (OPS-01). Searches are audited too (`auditedSearch`).
5. Operator reasons are reason codes from `OPERATOR_REASON_CODES` for that endpoint, optionally
   `CODE:<opaque incident id>` (`OPERATOR_REASON_PATTERN`, same shape as `KILL_SWITCH_REASON`).
   Free text is rejected (`REASON_NOT_ALLOWED`). The catalogue is a PROPOSED engineering list
   pending review by support operations and security.
6. `killSwitches.set` re-checks `confirmationPhrase` equals `ENGAGE|RELEASE <scope> <target>`
   (`CONFIRMATION_MISMATCH`) and that `target` is `*` for global scopes or one of the configured
   `targets`. Switches never gate the safety and human routes (`safetyRoutesPreserved: true`).
7. `POST` requests carry `Idempotency-Key` (`IDEMPOTENCY_KEY_PATTERN`); return the first result
   for a repeated key per staff member and endpoint.
8. `releases.review` records an opinion. It is never an approval record; releasing requires a
   signed `POLICY_RELEASE` / `KNOWLEDGE_RELEASE` approval (`approvals/`), which the console cannot
   create (`approvalRecordCreated: false`).
9. Errors: `ConsoleErrorBody` with reason code, correlation id and retryable flag only.

## Implementation map (existing platform ports)

| Endpoint(s) | Backing service |
|---|---|
| `killSwitches.*` | `KillSwitchService` (`platform/src/ops/ports.ts`) |
| `budgets.list` | `BudgetService.statusFor` (`platform/src/ops`) |
| `reconciliation.list`, `reconcile`, `retry` | `ActionService.listNeedingReconciliation`, `reconcile`, commit protocol (`platform/src/actions`) |
| `reconciliation.list` (dead letters), `outbox.requeue` | `PgOutboxDispatcher.listDead`, `requeueDead` (`platform/src/outbox/dispatcher.ts`) |
| `supportRequests.repair` | `SupportRequestService.trace` (worker view: existence, restricted flag, sync state) + `repairDeadLetter` (`PgSupportRequestService`: back to `PENDING` with a fresh sync message and a reset attempt budget, audited in its transaction as `support_request.repair_requeued`, actor = the staff member); `503 REPAIR_PATH_UNAVAILABLE` when the business module has no repair |
| `actions.pending`, `actions.cancel` | Pending list: console column-allowlisted read of `action_ledger` (migration 0900). Cancel: `LedgerActionService.cancelPending` (not on the `ActionService` port; interface change requested) |
| `workflows.tasks`, `workflows.decision` | `WorkflowEngine.openTasks`; for a decision the backend calls `PgWorkflowEngine.issueTaskToken` and then `completeHumanTask` for the same authenticated staff member inside the one request, so the plaintext token never leaves the server. `completeHumanTask` takes no reason code yet (interface change requested); until then the reason is recorded in the console audit event |
| `safetyEvents.list` | `safety_events` rows written by `SafetyEventRecorder` (`platform/src/safety/safety-events.ts`) |
| `audit.search` | `PgAuditQuery` as app_auditor plus a console audit event for the search (same semantics as `auditedSearch`, which does not return the event id) |
| `calls.transfer` | `HandoffService.requestHuman`, or `HandoffService.requestSafetyRoute` for a staff safety escalation (`platform/src/business/contract.ts`), both routing through the `TransferCoordinator`; `LedgerActionService.cancelPending` for the escalation's pending-action revocation |
| `destinations.list` | Trusted `DestinationConfig` (vendor queue refs never returned) |
| `supportRequests.trace` | `SupportRequestService.trace` + ledger `describe` + `WorkflowEngine.get/openTasks` |
| `calls.list`, `calls.get`, `overview` | `read-models.ts` over `audit_event_metadata` (app_console), `safety_events`, `TransferStore.listActive/get`, kill switches, budgets, capacity, `AuditHealth` |
| `releases.*` | `console_release_submissions` / `console_release_reviews` (migration 0900), `knowledge_snapshots`, `KnowledgeServicePg.reviewQueue` |

## Keeping the contract in sync

* `console/src/api/contract.test.ts` reads the platform sources as raw text and fails when
  `StaffRole`, `KillSwitchScope`, `TransferReason`, `KILL_SWITCH_ROLES`, `BUDGET_ROLES`,
  `GLOBAL_SCOPES`, `KILL_SWITCH_REASON` or `BUSINESS_ROLE_STAFF_MAPPING` drift from the contract.
* `schemas.test.ts` asserts type-level equality between every zod-inferred type and the
  interface here (`expectTypeOf<z.infer<typeof S.MeResponseS>>().toEqualTypeOf<C.MeResponse>()`).
* `ReleaseReviewItem.heldItems` was added compatibly (optional) by the backend.

## Backend implementation (`plugin.ts`)

| File | Purpose |
|---|---|
| `plugin.ts` | `registerConsoleApi(app, deps)`: every endpoint under `/console/api/v1`, error handler, not-found handler (`LOCAL_FIXTURE_DISABLED` for `auth/local/*` outside local/ci), `no-store` headers. `assertConsoleDeps` refuses local fixture identity components outside local/ci; `consoleRuntimeComponents` reports them to the configuration guard |
| `deps.ts` | `ConsoleApiDeps`: the explicit ports / narrow class slices the composition root supplies (`HandoffService`, `SupportRequestService` from `business/contract.ts`; ledger, outbox dispatcher, workflow engine, transfer store, knowledge, ops, audit, policy) |
| `schemas.ts` | Strict zod schemas for every request and response; `schemas.test.ts` asserts the inferred types equal the contract interfaces (`expectTypeOf`) |
| `auth.ts` | `WorkforceTokenVerifier` (jose: issuer, audience, exp, nbf, iat lifetime, jti, auth_time, MFA amr; local JWKS, remote JWKS URL or discovered keys), `StaffDirectory` port, `LocalStaffDirectoryFixture`, `LocalWorkforceSignInFixture` |
| `break-glass.ts` | `PgBreakGlassGrantSource`: authoritative grants from `console_break_glass_grants`, mapped into the console policy input |
| `sso.ts`, `sso-config.ts` | `WorkforceSsoService` (start / exchange / authenticate / refresh / logout / sweep, recovery custodians following the IdP), `WorkforceSsoConfigSchema` (redirect and issuer form, membership source), redirect allowlist, membership-to-role mapping, guard violations |
| `login-state.ts` | Sealed login state of the unauthenticated start (HMAC, tenant and issuer bound, one canonical spelling, single use recorded at the exchange) |
| `anonymous-audit.ts` | `AnonymousAuditBudget`: bounded audit volume for anonymous refusals (per action and reason, per window, suppressed count carried) |
| `sessions.ts`, `token-sealer.ts` | `PgConsoleSessionStore` (sessions, single use of login states, refresh claim, release and rotation, the row-locked terminal decision `closeFamily` with the fail-closed custodian rule, idle and absolute expiry verdict), `AesGcmTokenSealer` (AES-256-GCM sealing and per-purpose HMAC) |
| `oidc-staff-directory.ts` | `OidcGroupStaffDirectory`: staff resolved from the verified ID token groups and the session's last active check (no static roster) |
| `break-glass-issuance.ts`, `recovery.ts` | `PgBreakGlassIssuance` (requests, decisions, grants, post-use access reviews), `PgRecoveryService` (dual-controlled recovery identities and sessions) |
| `routes/auth/workforce-auth.ts` | Route handlers for `auth.oidcStart`, `auth.oidcExchange`, `auth.refresh`, `auth.recovery*` and the `auth.config` OIDC view |
| migrations `2050`, `2051`, `2052` | `console_sessions`, `console_login_transactions` (hashes only, single use); `console_break_glass_requests`, `console_access_reviews`, `console_recovery_identities`, `console_recovery_activations` (database-enforced separation of duties); `2052`: challenge and holder-evidence indexes, delete of expired login-state rows only |
| `authorize.ts` | ENDPOINT_ROLES + `decideConsole` (any one mapped catalogue action allowing suffices) and the deny-reason mapping |
| `stores.ts` | Console-owned state: idempotency, session revocations, release submissions and reviews, reconciliations; console audit input builder |
| `read-models.ts` | Content-free read models from audit metadata (`audit_event_metadata`, app_console), `safety_events`, the ledger column allowlist |
| `fixtures/` | LOCAL TEST FIXTURES: the harness over real modules and the labelled business-service stand-ins |
| migration `0900_console.sql` | `console_break_glass_grants` (never self-granted, time-bound), `console_token_revocations`, `console_idempotency`, `console_release_submissions`, `console_release_reviews` (`approval_record` is always false), `console_reconciliations`, and a column-allowlisted, tenant-RLS console read policy on `action_ledger` |

### Request pipeline

1. Console session bearer authenticated (`WorkforceSsoService.authenticate`: revocation,
   replay, absolute and idle expiry, bounded IdP active check) or, in local/ci only, the local
   fixture JWT verified (`WorkforceTokenVerifier`); staff resolved (roles from the session's
   last verified groups, or re-read from the fixture directory), the latest break-glass grant
   loaded. Tokens without an MFA amr are refused (`401 STAFF_MFA_REQUIRED`).
2. `ENDPOINT_ROLES` (`403 STAFF_ROLE_NOT_PERMITTED`, audited as a denial).
3. Strict path / query / body validation (`400 VALIDATION_FAILED`; reasons `REASON_NOT_ALLOWED`).
4. Console policy decision(s) (`403` with the mapped reason code, audited).
5. `Idempotency-Key` for every mutating POST (first result wins per staff member and endpoint).
6. Handler with the finer rules (scope roles, task roles, release roles, self-review, typed
   confirmation, reason allowlists, break-glass for restricted records).
7. Strict response validation: a response with any field outside the contract is refused
   (`500 RESPONSE_SCHEMA_VIOLATION`) instead of being sent.

### Policy mapping

Every read view maps to a dedicated, non-mutating console catalogue action whose role set
equals the endpoint's `ENDPOINT_ROLES` (checked by `policy-alignment.test.ts`); mutations keep
their mutating actions (auditor read-only taint applies).

| Endpoint | Console policy action(s) (any one) |
|---|---|
| `me`, `auth.logout` | `console:session` (every staff role) |
| `overview` | `operations:overview` |
| `calls.list`, `calls.get`, `supportRequests.trace` | `journey:inspect`; restricted support requests additionally `restricted_record:view` (break-glass) |
| `calls.transfer` | `call:transfer` |
| `actions.pending` | `pending_action:review` |
| `reconciliation.list` | `reconciliation:view` (supervisor) |
| `actions.cancel` | `pending_action:cancel` (supervisor; support_agent only when the call is assigned to them) |
| `reconciliation.reconcile`, `reconciliation.retry` | `operation:retry_reconciled` |
| `outbox.requeue` | `dlq:repair` |
| `supportRequests.repair` | `dlq:repair` (same operator repair action); restricted requests additionally `restricted_record:view` (break-glass) |
| `workflows.tasks` | `human_task:view` |
| `workflows.decision` | `human_task:decide` |
| `safetyEvents.list` | `safety_event:view` |
| `releases.list` | `release:view`; per item, policy bundles additionally `policy:review` |
| `releases.review` | `policy:approve` with initiator = submitter (policy bundles), `knowledge:submit_release` (knowledge snapshots) |
| `budgets.list` | `budget:view` |
| `killSwitches.list` | `kill_switch:view` |
| `killSwitches.set` | `kill_switch:engage` / `kill_switch:release` with the requested scope |
| `audit.search` | `audit:search` |
| `destinations.list` | `journey:inspect`, `policy:review` |
| `breakGlass.list` | `console:session` |
| `breakGlass.request` | `break_glass:request` |
| `breakGlass.decide` | `break_glass:approve` with initiator = requester (never self, `SUBMITTER_UNKNOWN` without one) |
| `accessReviews.list` | `access_review:view` |
| `accessReviews.complete` | `access_review:perform` with initiator = grant holder |
| `recoveryIdentities.list` / `propose` / `revoke` | `recovery_identity:view` / `recovery_identity:propose` / `recovery_identity:revoke` |
| `recoveryIdentities.approve` | `recovery_identity:approve` with initiator = proposer |
| `recoveryIdentities.confirm` | `recovery_identity:confirm` with assignedStaffId = the identity's holder (no role reaches it otherwise) |

### Restricted support requests and the trace

* The worker-view trace decides only which gate applies (existence and the restricted flag);
  nothing from it is returned. A restricted request needs `restricted_record:view` (valid
  break-glass approved by someone else).
* The returned data is read through `SupportRequestService.trace(..., { reader: { kind:
  "console", restrictedReader } })`: as `app_console` under row-level security, with
  `app.restricted_reader = 'on'` (migration 0300) set in that transaction ONLY after the
  `restricted_record:view` decision allowed. A row RLS hides answers 404.
* `sync.lastReasonCode`, `sync.syncedAt` and `sync.outboxMessageIds` come from the business
  trace (`last_sync_reason`, `synced_at`, the request's `support_request.sync` outbox ids).

### Console-initiated transfers

`calls.transfer` passes the staff-selected destination (`destinationId`, already checked
against the allowlist here) and `initiatedBy {staffId}` to `HandoffService.requestHuman`,
which re-checks the allowlist (refusal: `400 DESTINATION_NOT_ALLOWLISTED`, nothing dialled)
and audits the staff member as the actor. A different dialled destination (coordinator
fallback) is still reported as `TRANSFER_DESTINATION_SUBSTITUTED`.

**Staff safety escalation (spec section 10: human intervention is a safety signal; finding
SAFE-HANDOFF-05).** When the reason is `SAFETY_PRIORITY` or the selected destination has purpose
`SAFETY_PRIORITY`, the handler calls `HandoffService.requestSafetyRoute` with
`humanInterventionSignal()` and `initiatedBy {staffId}` instead of a plain human request: the
priority route is requested first, then the business layer resolves the call's live session
server-side to revoke its pending mutations and apply `SAFETY_ESCALATION` (TC-12 then answers
priority SAFETY), writes the restricted P1 safety record and the safety incident (`safety_events`,
time-to-routing metric). The console additionally cancels the call's remaining `PREPARED` /
`CONFIRMED` actions through the ledger (`action.cancel`, reason `SAFETY_ESCALATION`, actor the staff
member), so revocation does not depend on that session resolution (which is a LOCAL FIXTURE in the
local composition and BLOCKED live, TB-01). The success audit reason code is
`SAFETY_ESCALATION_ROUTED`. A human request for a call whose safety route is active is answered with
that safety route (the business layer never dials a STANDARD destination then).

### Audit (OPS-01)

* Console-owned effects (logout revocation, release review, console reconciliation record and
  its retry consumption) are written in ONE app_console transaction with their console audit
  event (`sourceComponent: "console"`, action `console.<endpoint>`).
* Effects owned by other modules are audited in-transaction by that module: kill switches
  (`killswitch.set`, sourceComponent console), ledger cancel (`action.cancel`), ledger
  reconcile (`action.reconciled` / `action.reconcile.inconclusive`), outbox requeue
  (`outbox.requeue`), support-request repair (`support_request.repair_requeued`), human task
  completion (`workflow.human_task.complete`). Their module APIs
  take no transaction, so the console first writes a write-ahead intent event (`PENDING`) that
  must succeed (`503 AUDIT_UNAVAILABLE` otherwise, nothing attempted), then a best-effort
  completion event. Responses return the effect's own in-transaction audit event id.
* Sensitive reads (`calls.get`, `supportRequests.trace`, `safetyEvents.list`) and every
  `audit.search` are audited before data is returned; if that is impossible nothing is returned.
* Denials are audited best-effort (`DENIED`); the denial stands either way.

### Content-free read models

* Active calls / investigation timelines: audit METADATA by callId (session lifecycle from
  `SESSION_AUDIT_ACTIONS`, `tool.invoke` with `db://tool_catalog/<name>/<version>` pointers,
  `transfer.*` joined to the transfer store, `action.*` joined to the ledger, policy decisions)
  plus `safety_events` rows. Intent category and caller language are not carried by
  content-free metadata, so they are reported as `null` / `und`, never guessed.
* Queue health: transfer journeys per allowlisted destination; staffed-agent availability is
  `null` (Talkdesk queue telemetry, TB-07 UNKNOWN). AI admission: kill-switch snapshot, budget
  exhaustion, capacity.
* Releases: release submissions recorded by the release pipeline (`ReleaseSubmissionRegistryPg.record`,
  app_worker) for the loaded policy bundle digest and knowledge snapshot digest, held knowledge
  items (`heldItems`), reviewer opinions. `approvalStatus` is `MISSING`: no signed approval
  record exists and the console cannot create one.

### Local sign-in (local/ci only)

`LocalWorkforceSignInFixture` issues tokens through `LocalOidcProviderFixture` for
`IDP.workforceIssuer` / `IDP.consoleAudience` (amr `local_fixture` + `mfa`, 15 minutes) for the
SYNTHETIC `STAFF`. It refuses to be constructed outside local/ci, `registerConsoleApi` refuses
local identity components outside local/ci, the routes are not registered there (404
`LOCAL_FIXTURE_DISABLED`), and the configuration guard rejects the `console-local-sign-in` runtime
component and a local_fixture `workforce-sso` runtime kind outside local/ci (declared kind:
staging/production).

## Known gaps

* Workforce SSO is verified against local Keycloak only. The tenant workforce OIDC client,
  managed group names, MFA amr values and approved session parameters are activation inputs
  (PRQ-036, VQ-IDP-08, AIN-12/13/15). Without `ConsoleApiDeps.auth.sso` the OIDC endpoints answer
  `503 OIDC_NOT_CONFIGURED` (local/ci) and registration outside local/ci is refused. Composition
  of the live SSO dependencies in the composition root (`main/`, WP-07) and scheduling of
  `WorkforceSsoService.sweep` are not part of this module.
* `reconciliation.retry` enforces every gate (latest unconsumed NOT_FOUND console reconciliation
  within 10 minutes, ledger back in CONFIRMED), consumes the console reconciliation and then
  calls `ConsoleApiDeps.reconciledRetry`. The local composition (`main/console.ts`) wires
  `LedgerReconciledRetry` (`reconciled-retry.ts`): it reads the ledger's LATEST reconciliation
  record (must be NOT_FOUND and unconsumed) and calls `LedgerActionService.retryAfterReconcile`
  with that ledger id, the staff ref and the provider port, so the ledger re-checks the row
  version, the CONFIRMED state, the expiry, the recorded confirmation **and its freshness** (the
  caller-path window; stale => `CONFIRMATION_STALE`, action expired), refuses an action carrying a
  durable invalidation request, and requires the port's `authorizeOperatorRetry` to re-establish the
  CALLER's current authority (live, unrevoked session at the action's generation without a safety
  escalation; current relationships, kill switches and policy) before it commits with the SAME
  provider idempotency key (ACT-01, finding ACT-F3). The staff member's console authorization never
  substitutes for the caller's. Without a port the endpoint still answers `503 RETRY_PATH_UNAVAILABLE`.
  End to end: `platform/test/journeys/console-retry.test.ts` (UNKNOWN commit -> reconcile
  NOT_FOUND -> retry COMMITTED, one scheduling effect, a second retry refused) and
  `platform/test/journeys/transactions.test.ts` (safety escalation while in doubt -> reconcile
  INVALIDATED, retry commits nothing; stale confirmation -> retry refused, action expired).
* Safety events: the `FAIL_SAFE` signal source (the safety pipeline could not assess an utterance
  and routed to safety) is part of `SafetySignalSource` in `contract.ts`, `schemas.ts` and the read
  model; up to six sources per incident.
* `actions.cancel` for support agents needs a call-ownership source (Talkdesk agent assignment,
  TB-07); without one only supervisors can cancel (fail closed).
* `calls.transfer` passes the staff-selected allowlisted destination and the initiating staff
  member (see "Console-initiated transfers"); the plugin's tests use the labelled
  `HandoffServiceFixture`, and `platform/src/main/console.test.ts` exercises the real
  business layer for the restricted trace.
* No rate limiting on the auth endpoints in this plugin (composition root / gateway).
* No `join` endpoint: the supported Talkdesk join control is unverified (TB-07);
  `CallDetailResponse.controls.join` reports availability only.
* No endpoint for safety-event acknowledgement, legal holds or policy source text; "inspect a
  source policy" is served by policy decision ids, reason codes and versions on the call
  timeline and by release diff summaries.
