# Identity binding module (`platform/src/identity`)

Status: **IMPLEMENTED_OFFLINE**. Every path here has been exercised only against LOCAL
FIXTURES and SYNTHETIC identities (`platform/src/fixtures/synthetic-world.ts`). Nothing has run
against DynamoDB, a real IdP, AWS KMS, a notification provider or Talkdesk. This module does not
establish HIPAA compliance, NIST AAL certification or production readiness. The assurance tiers
A0..A3 are application policy tiers (spec section 7), not NIST levels.

Spec coverage: section 7 (assurance tiers, preferred verification journey, OTP fallback limits,
secure entry, enumeration-resistant lookup, trusted session fields, signed assertions, expiry and
privilege drop, transfer verification result, durable action grants), section 14 threats (caller
spoofing, SIM swap, enumeration, session fixation, replay), invariants AUTH-01, AUTH-03, AUTH-04,
AUTH-06, AUTH-07, DATA-01, DATA-04, and trust-boundary flags TB-01, TB-03, TB-06.

## What is implemented

| Component | File | Kind | Notes |
|---|---|---|---|
| KV port | `ports.ts` | — | `KvStore`, `SessionService`, `VerificationService`, `AssertionService`; additive `VerificationUnavailableReason` / optional `unavailableReason` on the begin results (OPS-KS-01) |
| Memory KV store | `kv/memory-kv-store.ts` (`MemoryKvStoreFixture`) | local_fixture | Exact CAS semantics of the Dynamo store; `get` ignores TTL; `putIfAbsent` conflicts with a TTL-expired-but-unswept item (like DynamoDB); `sweepExpired()` simulates the lazy TTL sweep; deep copies on read/write |
| DynamoDB KV store | `kv/dynamo-kv-store.ts` (`DynamoKvStore`) | live | `@aws-sdk/lib-dynamodb`: `GetCommand` (ConsistentRead), `PutCommand` + `attribute_not_exists(pk)`, CAS `PutCommand` + `#v = :expected` writing `version = expected + 1`, `DeleteCommand` + `attribute_exists(pk)` / `#v = :expected`, counters `UpdateCommand ADD #c :one, #v :one SET #t = if_not_exists(#t, :ttl)`. TTL attribute `ttl` (matches `infra/terraform/modules/dynamodb_sessions`). `ConditionalCheckFailedException` → `false`; every other SDK error → reason-coded `DependencyError` (SDK message dropped; unknown write outcome reported as `UNKNOWN`) |
| Key derivation | `keys.ts` | — | Records keyed by `sha256` of bearer values (`ses#<sha256(sessionRef)>`, `vtx#…`, `otp#…`, `jti#…`); non-bearer binding ref `ses_bnd_<b64url(sha256)>` identical to the action ledger's |
| Session record | `session-store.ts` | — | Strict zod `SessionRecord` (validated on every read and write), privilege drop, lifecycle (revoked / ended / `now >= expiresAt` via Clock) and binding checks, `toAuthContext` (zod-validated `AuthContext`), bounded CAS `mutate` |
| Sessions | `session-service.ts` (`TrustedSessionService`) | follows KV kind | See "Session model" |
| Auth Gate | `session-service.ts` (`interpretAuthGateVariable`, `authGateVariableFor`, `authGate`) | — | Open only for the boolean `true` |
| Verification | `verification-service.ts` (`SecureVerificationService`) | — | Secure link + OIDC (A2), OTP fallback (A1), step-up (A3 for one digest), portal `describeTransaction`, `effectiveAssuranceFor` |
| Match codes | `match-code.ts` | — | 256 fixed words, two distinct words via CSPRNG |
| Abuse monitor | `abuse-monitor.ts` (`VerificationAbuseMonitor`) | follows KV kind | Account-keyed (sha256 of account / destination id) hourly counters of account-derived abuse signals, plus the aggregated `vsp_challenge_abuse_signals_total{signal}` metric; never a session flag, policy input, tool result or session-linked log (AUTH-ENUM-01) |
| Assertions | `assertions/assertion-service.ts` (`SignedAssertionService`) | follows signer kind | ES256 compact JWS, `typ: vsp-assertion+jwt`; purposes `transfer_receiver`, `portal_binding` (single use, jti replay store in KV), `durable_action_grant` (1..8 listed actions, bounded TTL) |
| Key ring | `assertions/key-ring.ts` (`AssertionKeyRing`) | — | One active signer, retained public keys for rotation, `retire(kid)`; JWKS never contains private material |
| Signers | `assertions/signers.ts` | `LocalEs256Signer`: local_fixture; `KmsAssertionSigner`: live | KMS `Sign` (`ECDSA_SHA_256`, `MessageType: RAW`, 4096-byte limit enforced) + `GetPublicKey` (must be `ECC_NIST_P256`, `SIGN_VERIFY`) |
| DER → JOSE | `assertions/der.ts` | — | Strict ECDSA DER parsing (minimal ints, no trailing bytes, positive non-zero) |
| Config | `config.ts` | — | Strict zod schemas + defaults; `identityConfigFromPlatform()` maps `PlatformConfig.sessionBinding` / `.verification` |
| Test harness | `identity-harness.fixture.ts` | local_fixture | Wires everything over fixtures for tests and the local demo |

Adapters owned by this module's engineer (documented here, they live in `platform/src/adapters`):

| Adapter | File | Kind | Notes |
|---|---|---|---|
| `LocalIdentityDirectoryFixture` | `adapters/local/identity-directory.ts` | local_fixture | Over `PEOPLE`. Exact match after normalisation (NFKC, case fold, whitespace collapse, dash/apostrophe variants); no partial/prefix/DOB-only matching; synthetic portal usernames; unknown account state reads `CLOSED`; role-scoped `selfSubjectId` (client/provider only) and `organizationFor`; `extraPeople` for many-match tests; outage / state / channel test controls |
| `LocalOidcProviderFixture` | `adapters/local/oidc-fixture.ts` | local_fixture | LOCAL ES256 keys per issuer (client + provider IdPs), ID tokens with iss/aud/sub/iat/exp/nonce/auth_time/amr/acr, public JWKS, rotation, attacker-token options for tests |
| `LocalOidcVerifierFixture` | `adapters/local/oidc-fixture.ts` | local_fixture | Same verification core as the live verifier, keys from the provider fixture |
| `JwksOidcVerifier` | `adapters/live/oidc-verifier.ts` | live | OIDC Core 3.1.3.7 with `jose` `createRemoteJWKSet` + `jwtVerify`: issuer allowlist (exact), audience, `azp` for multi-audience, asymmetric alg allowlist (no `none`/HMAC), `exp`, `iat` age (`maxTokenAge`), clock tolerance, injected Clock (`currentDate`), constant-time nonce, required `auth_time` within `maxAuthAgeSeconds`, https-only JWKS (loopback http only with the test flag). JWKS fetch failures → `DependencyError OIDC_JWKS_UNAVAILABLE` (NOT_STARTED) and unhealthy `health()` |
| `NotificationFixture` | `adapters/local/notification-fixture.ts` | local_fixture | Captures messages in memory (tests read the link / code); approved neutral template ids only; exact slot sets with patterns; registered channel refs only (no raw numbers can even be expressed); idempotency keys |

## Session model

- `startCall` (telephony_control channel only, configured tenant + environment) creates a session
  at **A0, generation 1**, hard expiry `now + sessionTtlSeconds` (config; 7200 s locally), bound to
  tenant, environment, integration id and call id. The record is stored under
  `sha256(sessionRef)`; the bearer value is never persisted or logged. Caller ID is accepted only
  as a sha256 digest and stored as a risk signal (AUTH-01). `authGate` in the result is the
  literal `false`. A second `startCall` for the same call supersedes and revokes the first.
- `resolve` enforces, in order: well-formed bearer ref (binding refs rejected), record exists and
  parses, tenant / environment / integration id match, channel in `resolveChannels`
  (default `mcp_tools`, `telephony_control`, `portal`), not revoked, not ended, `now < expiresAt`
  by the injected Clock **even if the KV item still exists** (AUTH-04), optional
  `expectedCallId`. Returns a zod-validated `AuthContext` built only from the record (AUTH-03).
- `selectRole`: same role is a no-op; any change bumps the generation and drops actor, subject,
  organization, scopes, assurance, step-up (privileges never combined).
- `recordConsent`: `telephony_control` / `portal` only (never `mcp_tools`), capture source must match
  the channel, consent marked decided needs a capture source and time, no future capture times.
- `applyChange`: PARTICIPANT_CHANGED (also resets consent and flags), ACCOUNT_SWITCH,
  RECOVERY_STARTED, RISK_ESCALATION(flag), SAFETY_ESCALATION → generation++, A0, privileges
  cleared; risk flags (including `SAFETY_ESCALATION_ACTIVE`) are retained.
- `revoke` / `endCall`: generation++, privileges cleared, idempotent.
- `authGate`: strict boolean, `true` only for a valid, unexpired, unrevoked, not-ended session with
  an actor at A2 or above; never throws (KV failure → closed). `interpretAuthGateVariable(v)` is
  `v === true`.
- Every update is a compare-and-swap with bounded retries (`casMaxAttempts`, default 5) →
  `ConflictError SESSION_UPDATE_CONFLICT` (retryable) when exhausted.

## Verification

**Secure link (preferred, A2).** `beginSecureLink(ctx, {role, locator})` re-derives the session
from server state (only `ctx.sessionRef`, `ctx.integration` and the expected generation are used),
checks the role against the selected role, applies a per-session attempt limit, looks up candidates
through `IdentityDirectory`, and returns `{transactionId, matchCode, response:
"IF_ELIGIBLE_A_LINK_WAS_SENT"}` whatever the lookup found (the uniform `VERIFICATION_UNAVAILABLE_USE_HUMAN`
only for causes that are the same for every caller: notifications switched off, see below, the
per-session attempt limit or a directory outage). A transaction (decoy when ineligible) is stored for
every request that reaches the lookup.
Only exactly one ACTIVE candidate holding the role with a verified `portal_push` / `email` / `sms`
channel (and within the per-account link limit, 5 per hour) gets a link. Over the limit, delivery is
suppressed silently (the account holder is protected from a link flood) and `LINK_ACCOUNT_LIMIT` is
recorded in the abuse monitor; the caller's session is NOT flagged (see "Enumeration resistance").
A directory failure after exactly one candidate was found is treated as "not eligible" (nothing sent,
generic response) because only real people can reach it. Template `verify.secure_link`, link
path `/verify/<vtx_ opaque id>#n=<32-byte nonce>` — the nonce is in the URL fragment (not sent to
servers) and nothing in the URL is PHI. The transaction stores `sha256(nonce)`, session hash,
generation, call, candidate, role and expiry (300 s default).

Portal flow: the portal page (portal channel) calls `describeTransaction({transactionId, nonce})`
to show the match code after sign-in; then `completeSecureLink({transactionId, nonce, idToken,
matchCodeConfirmed})`: nonce check (does not burn the transaction) → single-use consume by CAS →
expiry → match code confirmed → eligibility → `OidcVerifier.verifyIdToken(nonce, maxAuthAgeSeconds)`
→ `amr` must contain one of `mfa, hwk, swk, otp, fido, pop` (RFC 8176 values plus `fido`; `pwd`
alone never suffices; the identity owner must confirm what each IdP emits) → `(iss, sub)` maps to the
candidate actor → account still ACTIVE → session CAS only if not revoked/ended/expired, same call,
**same generation** (session fixation) and no other actor bound. Sets actor, role, subject
(`selfSubjectId`), organization, A2, `authenticatedAt` = IdP `auth_time`, `secure_link_oidc`, role
default scopes. Delegated authority is not set here; it comes from the relationship directory at
policy time.

**OTP fallback (A1).** Disabled unless `otpEnabled` (default `false`, because TB-03 is UNKNOWN);
disabled → `VERIFICATION_UNAVAILABLE_USE_HUMAN` for everyone. Codes go only to an existing verified
`sms` (optionally `voice`) channel from the directory; there is no input that can carry a
destination. Recent channel change (< 30 days, configurable) → nothing sent, `RECENT_NUMBER_CHANGE`
recorded in the abuse monitor against the account (not on the session). Limits (proposed, pending
security approval), all enforced where they bite:

| Limit | Default | Enforced at | When exceeded |
|---|---|---|---|
| Incorrect attempts per challenge | 3 | submit (CAS-counted) | challenge LOCKED; session `OTP_ABUSE_SUSPECTED` (uniform: decoys lock the same way) |
| Challenges per account per hour | 5 | begin | nothing sent, `OTP_ACCOUNT_LIMIT` monitored |
| Challenges per destination per hour | 5 | begin | nothing sent, `OTP_DESTINATION_LIMIT` monitored |
| Compared guesses per account per hour | 5 | **submit** (a slot is reserved by an atomic increment before each comparison, so guesses over many calls or sent concurrently cannot exceed it; a correct entry also uses its slot) and begin (no new code while spent) | the comparison is skipped and the attempt is handled exactly like a wrong code (what every decoy does); `OTP_ACCOUNT_GUESS_LIMIT` monitored |
| Outstanding challenges per call | 1 | submit | a newer challenge supersedes older ones: `OTP_CHALLENGE_SUPERSEDED`, no attempt used |
| Incorrect attempts per call (any challenge, decoy or real) | 5 (`otpMaxFailuresPerAccountPerHour`) | submit | `OTP_CHALLENGE_LOCKED` + session `OTP_ABUSE_SUSPECTED` |
| After `OTP_ABUSE_SUSPECTED` on the call | — | begin and submit | no further codes sent; no challenge on the call accepts digits (`OTP_CHALLENGE_LOCKED`) |

Every begin returns `IF_ELIGIBLE_A_CODE_WAS_SENT`. Code = 6 digits from `crypto.randomInt`, stored only as
`HMAC-SHA256(pepper, "vsp.otp.v1:" + challengeId + ":" + code)`, expiry 300 s. `submitOtp` is
accepted only from `telephony_control` (`mcp_tools` → `AccessDeniedError
OTP_SUBMIT_CHANNEL_NOT_ALLOWED`), constant-time compare, CAS-counted attempts (concurrent guesses
cannot exceed the limit), single use, bound to session + generation + call + the session's latest
challenge (`sessionSeq`). Success → A1,
`otp_sms_registered_channel` (or voice), A1 scopes (`case:create` by default). SMS OTP is never
treated as strong MFA.

**Step-up (A3 for one digest).** `beginStepUp(ctx, actionDigest)` requires A2 with a bound
account; sends `verify.step_up_link` to the account's registered channel (or answers
`VERIFICATION_UNAVAILABLE_USE_HUMAN` while notifications are switched off, see below). `completeStepUp` requires
a fresh IdP authentication (`auth_time` within 120 s), the same actor, the same generation, and sets
`stepUp = {actionDigest, verifiedAt, expiresAt (300 s)}` without raising the session-wide
assurance. `effectiveAssuranceFor(ctx, digest, now)` returns A3 only for that digest while unexpired;
`resolve` drops an expired step-up.

**Notifications switched off (OPS-KS-01, caller-facing).** The composition root wraps the
NotificationSender in `KillSwitchGatedNotificationSender` (`platform/src/ops/notification-gate.ts`), which
refuses every ROUTINE send while `OUTBOUND_NOTIFICATIONS` or `INTEGRATION notifications` is engaged or the
switch state is unreadable. So that the caller is not told to wait for a message that is never sent, the
service takes the same snapshot reader (`VerificationServiceDeps.notificationSwitches`, i.e.
`KillSwitchService.snapshot` for the deployment's tenant) and, at the start of `beginSecureLink`, `beginOtp`
(after the `otpEnabled` check) and `beginStepUp`, applies the same pure decision (`notificationBlock`,
purpose ROUTINE, INTEGRATION target = `notifications.integrationId`). When notifications are off it
answers `VERIFICATION_UNAVAILABLE_USE_HUMAN` with `unavailableReason`
`KILL_SWITCH_OUTBOUND_NOTIFICATIONS` / `KILL_SWITCH_INTEGRATION` / `KILL_SWITCH_STATE_UNAVAILABLE` (unreadable or
malformed state, fail closed), and logs `identity.verification.notifications_switched_off` (reason code,
binding ref, method only). This is decided BEFORE the per-session begin counter, any directory lookup, any
account or destination throttle and any stored transaction or challenge: the switch state is global, so
zero, one and many matches get the identical answer, and no counter that only real accounts have is spent
(after release, the same call can still verify). `unavailableReason` is audit evidence only: the gateway
records it on the `tool.invoke` event (MCP) or the `verification.begun` event (`DENIED`, telephony
control) and never returns it. A switch engaged between this check and the send is still enforced by the
gated sender (that one caller then hears the generic "if eligible" answer). Without the reader nothing is
pre-checked. Tests: `[OPS-KS-01]` in `verification-service.test.ts`, `gateway/tools/verification.test.ts`,
`gateway/http/routes.test.ts` (the identity and gateway test harnesses pass the reader).
**Composition status (open):** the LOCAL container (`platform/src/main/container.ts`) does not yet pass
`notificationSwitches`, so the composed app does not yet pre-check: while these switches are engaged the gated
sender refuses the send and the caller still hears the generic "if eligible" answer. See integration
contract item 0.

**Completion result and audit binding (additive).** `completeSecureLink` / `completeStepUp` return
`VerificationCompletion = { bound, reasonCode, binding? }`. `binding` = `{ callId, sessionBindingRef,
sessionGeneration }` of the transaction's own call: the vendor interaction id, the NON-bearer
`ses_bnd_<base64url(sha256)>` binding ref and the generation (after the binding, or the transaction's
generation when nothing was bound). It is present only when the transaction was OPENED (nonce
matched, not reused, not expired), on success and on later refusals (match code not confirmed,
OIDC/actor/account problems, session-fixation aborts); an unknown, reused or expired link is never
attributed to a call. It is audit evidence only: the portal route puts it on the
`verification.bound` / `verification.failed` audit event (so the call's audit timeline and the
console investigation show the binding) and never returns it to the portal. The bearer session
reference is never returned.

## Enumeration resistance (AUTH-ENUM-01)

Name + DOB only locate. Beyond the identical response to each begin, nothing the caller can observe
LATER (the next tool result, a policy denial, a TC response, the Auth Gate, the session's risk flags,
assurance or generation) may depend on whether the locator matched a real, eligible account:

- Controls derived from account- or destination-specific facts (per-account link and OTP limits,
  per-destination limit, account guess budget, a real account's challenge locking, recent number
  change) act SILENTLY (suppress the send or the comparison) and are recorded only in
  `VerificationAbuseMonitor`: KV counters `abm#<signal>:<hour>:<sha256(kind NUL id)>` with a TTL of
  `abuseSignalRetentionHours` (default 168, engineering default pending Security approval), plus the
  aggregated metric. They are never written to the session, never logged with a session binding ref,
  and never reach policy. Security monitoring reads them with `abuse.count(signal, subject, at?)`.
- Session risk flags are set only by controls every caller triggers identically: more than
  `maxVerificationBeginsPerSession` begins (`ENUMERATION_SUSPECTED`), a locked challenge or the call's
  OTP failure budget (`OTP_ABUSE_SUSPECTED`). Policy (`policy/vsp/authz.rego`) denies
  `verification:begin` on those two flags; that denial is therefore the same for real and unknown people.
- Tests compare the FULL observable sequence for a real and an unknown person past every limit, at the
  service level (`[AUTH-ENUM-01]` in `verification-service.test.ts`) and through the full container
  with the real MCP client, pipeline and OPA policy (`enumeration-resistance.integration.test.ts`).
- The model-facing `begin_verification` request hash persisted by the gateway replay cache is keyed
  with a secret pepper (DP-02, `platform/src/actions/tool-idempotency.ts`), so name + DOB cannot be
  recovered from `tool_request_idempotency` or its backups by a dictionary attack.

## Assertions

`SignedAssertionService.mint/verify/jwks` (port) plus helpers `mintTransferResult` /
`verifyTransferResult` (same call, authorised receiver audience, single use) and
`mintDurableActionGrant` / `authorizeDurableAction` (A2 required, listed actions only). `sid` must be
the non-bearer binding ref. Max lifetimes: transfer_receiver 300 s, portal_binding 300 s,
durable_action_grant 7 days (configurable; the verifier also rejects tokens whose lifetime exceeds
its own policy). Verify checks header (`alg ES256`, `typ`, known `kid`), signature, `iss`, `aud`,
`exp`/`nbf` with tolerance, strict claim schema, purpose, lifetime, nonce/call/action expectations,
then the jti replay store for single-use purposes. Rotation: `keyRing.rotate(newSigner)` keeps the
previous public key until `retire(kid)`.

## LOCAL FIXTURES (rejected by the production guard, OPS-04)

`MemoryKvStoreFixture`, `LocalEs256Signer` (kid `local-dev-…`, label "LOCAL DEVELOPMENT ASSERTION
KEY"), `LocalIdentityDirectoryFixture`, `LocalOidcProviderFixture`, `LocalOidcVerifierFixture`,
`NotificationFixture` (template wording is placeholder copy, not approved production text),
`LOCAL_FIXTURE_OTP_PEPPER` and `createIdentityHarness` in `identity-harness.fixture.ts`. All data is
SYNTHETIC.

## BLOCKED (code path exists or is specified; execution needs the prerequisite)

| Item | Why blocked | Prerequisite |
|---|---|---|
| `DynamoKvStore` against DynamoDB | Contract-tested with stub clients only. DynamoDB Local was **NOT RUN** (no container runtime in this environment); no AWS account access | Provisioned table from `infra/terraform/modules/dynamodb_sessions`, IAM for the gateway role, approved sandbox; then run the shared KV suite against DynamoDB Local and the sandbox table |
| `JwksOidcVerifier` against real IdPs | Tested with LOCAL keys (injected JWKS and a 127.0.0.1 JWKS server) | Identity owner: OIDC test clients (issuer, client id, JWKS URI), confirmed `amr`/`acr` values, account linking `(iss, sub) → actor` |
| Live `IdentityDirectory` | No live adapter exists; no documented API was available | Identity owner's restricted verification / account-linking / registered-channel APIs and recovery policy |
| Live `NotificationSender` | No BAA-covered provider or documented API approved | Privacy counsel + procurement (BAA), approved neutral templates, provider API docs |
| `KmsAssertionSigner` against KMS | Contract-tested with a stub client | KMS asymmetric key `ECC_NIST_P256`/`SIGN_VERIFY`, IAM grant, security approval |
| OTP pepper from Secrets Manager | Only a labelled LOCAL value exists | Secret provisioned and rotated in Secrets Manager |
| OTP fallback in any real flow | TB-03 (isolated DTMF capture keeping digits from ASR, model, recording, transcript) is UNKNOWN | Talkdesk evidence for TB-03 and security approval of limits (`verification.approvedBySecurity`); until then `otpEnabled: false` |
| Talkdesk Auth Gate variable | TB-06 (variable cleared on expiry, not model-mutable) is UNKNOWN | Talkdesk evidence; until then the gate is UX only and the gateway authorises every protected call |
| Session reference transport | TB-01 (session ref passed outside model-controlled arguments) is UNKNOWN; gateway concern | Talkdesk evidence; otherwise server-to-server lookup or BLOCKED protected tools |

## Integration contract for other modules

0. Composition root: pass `notificationSwitches` (the same `KillSwitchService.snapshot` reader the
   `KillSwitchGatedNotificationSender` uses) to `SecureVerificationService`, so verification answers the
   human route while notifications are switched off (OPS-KS-01). The dependency is optional, so omitting it
   compiles and silently keeps the "if eligible" answer; `platform/src/main/container.ts` omits it today
   (open: `notificationSwitches: () => ops.killSwitches.snapshot(tenantId),`). Once it is wired, the field
   should become required so a composition root cannot omit it.
1. Gateway: obtain the bearer `sessionRef` from the trusted transport binding (TB-01), call
   `sessions.resolve(sessionRef, integration)` on EVERY request; treat any `SessionInvalidError` or
   `DependencyError` as deny. Never accept actor/role/subject/assurance/consent from tool arguments.
2. Studio (telephony_control): `startCall` at call start, `recordConsent` after the consent flow,
   `authGate(sessionRef, integration, { expectedCallId })` for the Auth Gate variable, then set the
   variable with `authGateVariableFor(response)`; `endCall` at hang-up; `submitOtp` only from the
   isolated DTMF path.
3. Portal backend (portal channel): `describeTransaction` then `completeSecureLink` /
   `completeStepUp`. The portal must authenticate its own integration identity before calling
   (the port signatures of the completion methods carry no integration parameter). Record the
   result's `binding` (call id, binding ref, generation) on the audit event; never echo it.
4. Policy: use `effectiveAssuranceFor(ctx, actionDigest, now)` for A3 checks; delegated authority
   comes from the relationship directory, not from the session.
5. Safety / participant detection: `applyChange` drops privileges; safety routing does not depend on
   any session state (SAFE-02).

## How to test

```
cd platform
npx vitest run src/identity src/adapters/local/identity-directory.test.ts src/adapters/local/oidc-fixture.test.ts \
  src/adapters/local/notification-fixture.test.ts src/adapters/live/oidc-verifier.test.ts
npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E "src/identity|src/adapters/local/(identity-directory|oidc-fixture|notification-fixture)|src/adapters/live/oidc-verifier"
npx eslint src/identity src/adapters/local/identity-directory*.ts src/adapters/local/oidc-fixture*.ts \
  src/adapters/local/notification-fixture*.ts src/adapters/live/oidc-verifier*.ts
```

All tests are offline and deterministic (FakeClock, fixed fast-check seeds; the only socket is an
in-process HTTP server on 127.0.0.1).

## Requirement IDs enforced here

| ID | Enforcement | Tests (tags) |
|---|---|---|
| AUTH-01 | Only `completeSecureLink` (OIDC + MFA amr) and `submitOtp` raise assurance; name/DOB only locate; caller ID stored as digest risk signal; strict inputs reject NPI/phone fields | `[AUTH-01]` in session-service, verification-service, identity-directory tests |
| AUTH-03 | AuthContext rebuilt from the KV record; consent not settable from `mcp_tools`; role changes drop privileges; no silent account switch | `[AUTH-03]`, `[DATA-04]` |
| AUTH-04 | Clock-based expiry, revocation and end-of-call checks on every read, independent of storage TTL | `[AUTH-04]` |
| AUTH-06 | OTP only as HMAC; nonces as sha256; codes never logged/returned; submit only via telephony_control; content-free logs | `[AUTH-06]` |
| AUTH-07 | `interpretAuthGateVariable` truth table + property test; gate false for unknown/ended/expired/revoked/A0/A1/previous-call sessions; initial value literal false | `[AUTH-07]` |
| DATA-01 | No PHI in links, KV records, logs or metric labels | `[DATA-01]`, `[AUTH-06]` |
| DATA-04 | No API accepts summary/memory-derived identity, assurance or consent | `[DATA-04]` |
| Spec 7 / 14 | Enumeration, fixation, replay, SIM swap, step-up, assertions, KV contract | `[SPEC-7.*]`, `[SPEC-14.*]` |
| AUTH-ENUM-01 | Account-derived abuse signals only in the account-keyed monitor; identical observable sequences for real and unknown people past every limit; partial directory failure answers like no match | `[AUTH-ENUM-01]` in verification-service and enumeration-resistance integration tests |
| AUTH-OTP-LIMIT-01 | Account guess budget reserved before each comparison; one outstanding challenge per call; call failure budget; abuse-flagged call accepts no digits | `[AUTH-OTP-LIMIT-01]` |
| DP-02 (with actions) | Locator-bearing tool request hashes persisted only as HMAC(pepper, fingerprint) | `[DP-02]` in enumeration-resistance integration test and `actions/tool-idempotency.test.ts` |
| OPS-KS-01 (caller-facing, with ops) | Notifications switched off ⇒ every begin (link, OTP, step-up) answers `VERIFICATION_UNAVAILABLE_USE_HUMAN` before any counter or lookup; reason code for audit only | `[OPS-KS-01]` in verification-service tests and gateway tool / route tests |

## Known gaps

- Timing side channel: for an eligible candidate the service awaits one notification send (and a
  few extra KV writes, including abuse-monitor increments) that decoys do not perform. Response
  bodies and later results are identical; latency is not equalised. Dispatching notifications
  through the outbox asynchronously would close this.
- The account guess budget is shared by everyone who can reach a challenge for that account, so an
  attacker can spend a real person's budget for the hour (denial of service, which spec section 7
  anticipates); that person then needs the human recovery route. Spending it is visible to security
  monitoring (`OTP_ACCOUNT_GUESS_LIMIT`), not to callers. A correct entry also uses a slot.
- The abuse monitor has no console view or alarm rule of its own yet; investigation reads the KV
  counters and the aggregated metric. Its retention default needs Security approval.
- Identity events are written to the content-free logger and metrics only; they are not yet
  appended to the durable audit chain (the audit writer is transaction-bound to PostgreSQL; session
  state lives in the KV store). Wiring `session.*` / `verification.*` audit events is integration work.
- Durable action grants are bounded by expiry only; there is no revocation list for an issued grant.
- `verifyTransferResult` does not re-check the live session generation; receivers that need that
  must also resolve the session server-to-server.
- The match code depends on the person comparing two words; it mitigates, not eliminates, social
  engineering of the approval. Ambiguous matches go to the (not implemented here) human recovery route.
- Global-table replicas evaluate conditional writes per region; correctness assumes the single
  write region documented in the Terraform module.
- OPS-KS-01 caller-facing pre-check: not yet composed in the LOCAL container (see integration contract
  item 0). Its INTEGRATION target is `notifications.integrationId` (the wrapped sender's id); the gated
  sender targets its `integrationId` option when one is set, which the container does not set today, so the
  two agree only while no custom gate target is configured.
