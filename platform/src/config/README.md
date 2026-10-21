# platform/src/config: configuration, deployment guard, approval records

Status: software IMPLEMENTED; the live-composition rules are exercised on Layer 2 against the local emulators
(`platform/test/integration/composition/`, LocalStack KMS and Secrets Manager); environment NOT_CONFIGURED.
Nothing here has been run against a real AWS account, KMS key or vendor. This module does not make any
environment compliant or production ready; it refuses to start environments whose prerequisites are not
evidenced.

## What is implemented

| File | Purpose |
|---|---|
| `ports.ts` | `PlatformConfig` (extended additively with optional `adapters.*.integrationApprovalId`, `phi.endpointsEnabled`, `ops`, and `gateway?: GatewayConfig` — inbound OAuth2 JWT validation (`inboundAuth`, one `integrationId` per vendor tenant with per-channel credentials) and HTTP limits, matching `GatewayConfigSchema`) |
| `index.ts` | Public surface; also exports `GatewayConfigSchema`, `GatewayInboundAuthSchema`, `gatewayConfigOf` (re-validates the section, fail closed), `loadInfrastructureEnv` and `InfrastructureEnvRejectedError` (strict `VSP_ENVIRONMENT` / `VSP_MUTATIONS_ENABLED` / `PORT`). |
| `schema.ts` | Strict zod schema (`PlatformConfigSchema`) kept in sync with `ports.ts` by a compile-time two-way assignability check (also for `GatewayConfig`). Credential fields accept only secret **references** (Secrets Manager / KMS / SSM ARNs, `local-fixture:` or `file:`), so a pasted secret fails to parse. Endpoints cannot carry query strings, fragments or userinfo. Parse errors report `path:code` only, never values. |
| `loader.ts` | Loads `platform/config/<env>.json`, checks the file's `environment`, strips `$comment`, applies **allowlisted** `VSP_CONFIG_*` overrides for references only (`DATABASE_CONNECTION_REF`, `ASSERTION_KEY_REF`, `APPROVALS_TRUSTED_KEY_REF`, `SESSION_TABLE_NAME`, `ADAPTER_<NAME>_CREDENTIAL_REF` for declared adapters). Any other `VSP_CONFIG_*` variable, or a value that is not a reference, is rejected. Pins, endpoints, adapter kinds, CORS, audit and approvals cannot be overridden (OPS-06). Records the file digest and the names (never values) of applied overrides. |
| `approvals.ts` | Loads `approvals/*.json`, strict-parses each against the protocol `ApprovalRecord`, verifies detached signatures with `node:crypto` (`ed25519`, `ecdsa-p256-sha256` DER, `rsa-pss-sha256` salt 32) against a trusted **public** key supplied by reference, and evaluates environment / validity window / expiry with an injected time. No trusted key ⇒ every record is `UNVERIFIED_NO_TRUST_KEY`. **Binding (OPS-APPR-01):** `APPROVER_ROLES_BY_SCOPE` (scope → allowed `approver.role`; otherwise `APPROVER_ROLE_NOT_PERMITTED`) and `SUBJECT_KIND_BY_SCOPE` (MODEL_VOICE_SELECTION → `subject.modelVoice`, POLICY_RELEASE → `subject.policyBundle`, KNOWLEDGE_RELEASE → `subject.knowledgeSnapshotDigest`, CLINICAL_SCRIPTS → `subject.templateCatalogDigest`, PRODUCTION_DEPLOYMENT / PILOT_EXPOSURE → `subject.release.imageDigest`). The signed subject must equal the caller's `expected` artifact: `SUBJECT_MISSING`, `SUBJECT_MISMATCH`, `SUBJECT_UNVERIFIABLE` (caller cannot state the artifact — fail closed) and `SUBJECT_UNEXPECTED` never count. `releaseSubjectExpectations(manifest)` maps a ReleaseManifest to expectations (used by the manifest builder and `scripts/ci/check-release-manifest.ts`). Resolvers: `FileTrustedKeyResolver` (LOCAL FIXTURE, `file:` refs) and `KmsTrustedKeyResolver` (live, documented KMS `GetPublicKey` of a key ARN; offline tests inject a fixture client) for the trust anchor; `KmsRuntimeSigningKeyResolver` (live, GetPublicKey by key ARN, bare key id or `mrk-` id, never an alias, any usage) for the runtime signing keys' public keys, used only by the key separation check, never as a trust anchor. |
| `guard.ts` | `evaluateDeployability(config, ctx)` → violations; `assertDeployable` throws `ConfigurationRejectedError` when there is any. Rule sets per environment (below). Violation strings are `<CODE>@<config path>` only. |
| `startup.ts` | `loadDeployableConfig(...)`: load config → load approvals → resolve trust key (and, in a live rule set, the runtime signing keys' public keys through `signingKeyResolvers`, default the trust resolvers; the live units pass `KmsRuntimeSigningKeyResolver`; `resolveRuntimeSigningPublicKeys`, for the key separation rule's key-material comparison: a key it cannot resolve is logged `config.runtime_signing_key.unresolved` and the guard refuses the environment, `RUNTIME_SIGNING_KEY_UNRESOLVED`) → `assertDeployable`. Startup must call this before serving. Optional inputs `knowledgeSnapshotDigest`, `templateCatalogDigest`, `releaseImageDigest` are passed to the guard for subject binding; a composition that does not supply them cannot satisfy KNOWLEDGE_RELEASE / CLINICAL_SCRIPTS / PRODUCTION_DEPLOYMENT (fail closed). |
| `platform/config/*.json` | `local`, `ci` (LOCAL FIXTURE: synthetic tenant, fixture adapters, PGlite, memory session store, local dev signing key, destinations mirroring `DESTINATIONS`), `sandbox`, `staging`, `production` (live kinds, `PLACEHOLDER` credential/key/table references, **null endpoints** because no vendor endpoint is verified, no approved model, nothing pinned, retention null). The latter three are **expected to be rejected today**. |
| `rules/` (WP-07) | One file per rule concern, registered in `rules/index.ts` (`GUARD_RULES`, run in order; `RULE_HELPER_FILES` lists the helpers; `index.test.ts` fails on an unregistered file): `universal`, `console-workforce`, `offline`, `sandbox`, `full`, `mandatory` (the substrate a live environment cannot start without: PostgreSQL by a real secret, never PGlite; DynamoDB tables; the outbox queue; the KMS signer), `cors`, `gateway` (`gateway-limits`: a disabled gateway rate limit, `gateway.http.rateLimit: null`, is refused in every live rule set, `GATEWAY_RATE_LIMIT_DISABLED`), `infrastructure` (AWS region and endpoint overrides: sandbox only and emulator hosts only, `INFRASTRUCTURE_ENDPOINT_OVERRIDE_NOT_EMULATOR` / `_FORBIDDEN`, the same definition the AWS client factory applies before any client exists, `shared/emulator-hosts.ts`; S3 path style; audit export identities never shared with the runtime, compared by secret identity; `trustedProxyCidrs` private ranges only, `TRUSTED_PROXY_CIDR_INVALID` / `_NOT_PRIVATE`, and in staging/production without them `operator.console` is NOT_CONFIGURED, `CONSOLE_TRUSTED_PROXY_NOT_CONFIGURED`; in staging/production the outbox dead-letter queue is required, `OUTBOX_DLQ_NOT_CONFIGURED`), `key-separation` (FO-14-56, AUTH-02, blocking in sandbox and full: the approval trust anchor is never the runtime assertion key or an audit manifest key of this or any other committed environment configuration, `APPROVAL_TRUST_KEY_IS_ASSERTION_KEY` / `_IS_MANIFEST_KEY`, compared by reference and by key material (`startup.ts` `resolveRuntimeSigningPublicKeys` resolves every form the runtime signs with, bare key ids included; when it resolved the keys, a configured signing key it could not resolve refuses the environment, `RUNTIME_SIGNING_KEY_UNRESOLVED@<path>`, fail closed), and the guard then does not use the anchor, so no record verifies; in reverse, this environment's assertion and manifest keys are never another committed environment's anchor, `ASSERTION_KEY_IS_APPROVAL_TRUST_KEY` / `AUDIT_MANIFEST_KEY_IS_APPROVAL_TRUST_KEY@environments.<env>.approvals.trustedSigningKeyRef`, and never another environment's signing key, `SIGNING_KEY_REUSED_ACROSS_ENVIRONMENTS`; manifest keys are never the assertion key, `AUDIT_MANIFEST_KEY_IS_ASSERTION_KEY`; every secret serves one purpose, the database login, the two peppers, the console session sealer, the exporter and verifier logins, each adapter credential and each connector profile credential of this environment (from `GuardContext.connectorCredentialSets`, reported at `connectors.credentials.<env>.profile:<id>:<capability>:<access>`), `SECRET_REUSED_ACROSS_PURPOSES` (the database logins among themselves are `infrastructure`'s `AUDIT_EXPORT_IDENTITY_SHARED`, adapter and profile credentials among themselves the `connectors` rule's), and none is another committed environment's secret, `SECRET_REUSED_ACROSS_ENVIRONMENTS` (connector credentials against another environment's adapter credentials are the `connectors` rule's when the supplied sets hold that environment, compared here otherwise); signing keys by key, never alias, `KMS_SIGNING_KEY_REF_IS_ALIAS`; references compare by key id, `types.ts` `sameKeyOrSecret`; the other environments' keys, anchors and secrets come from `GuardContext.committedSigningKeys`, read by `main/live-modules.ts` `committedSigningKeySets`, which sees committed references only and refuses the unit when a committed file does not parse with a valid environment, `COMMITTED_CONFIG_UNREADABLE@configDir.<name>`), `egress` (every outbound client's host on an allowlisted destination of its class), `observability` (content attributes DISABLED; an OTLP endpoint must be https on a `TELEMETRY_EXPORTER` destination), `connectors` (WP-06 credential separation, references normalized to one spelling per identity first, `types.ts` `canonicalReferences`, so a full and a partial Secrets Manager ARN of one secret are one credential; this environment's configured adapters are always compared), `approvals`; helpers `capabilities.ts` (which runtime capability each configured component serves) and `live-adapters.ts` (a live adapter's tenant inputs). |
| Guard report | `evaluateDeployability` returns `blocking` violations (the process refuses: fixtures outside local/ci, missing mandatory substrate, an override outside sandbox, a missing approval floor) and `capabilityViolations` (a tenant input of one component: the live composition makes that capability NOT_CONFIGURED, FO-00-26, FO-00-30); `deployable` is computed from `blocking` only. In the live composition the approval trust anchor is resolved by `KmsTrustedKeyResolver` only (FO-14-56): a non-KMS reference is `APPROVAL_TRUST_KEY_REF_NOT_KMS`, an unusable key `APPROVAL_TRUST_KEY_UNRESOLVED` (logged `config.approval_key.unresolved` with its reason code). |
| Live sections of `PlatformConfig` (WP-07) | `infrastructure` (AWS region, endpoint overrides, private network hosts, outbox and dead-letter queues, the route-audit journal table, the Object Lock audit sink, audit export identities, startup secret references, the ingress payload key), `observability`, `egress`, `consoleAuth` (WP-05 workforce SSO), `callerIdentity`, `connectors` (profile directory and change feeds), `knowledge`, `crm`. There is no `ingress` section: the ingress inbox is not composed in this build (software gap `INGRESS_PLUGIN_NOT_COMPOSED`), so the strict schema refuses a key nothing would read (FO-00-30). `loadInfrastructureEnv` also reads `VSP_LISTEN_HOST` (`0.0.0.0` or `127.0.0.1`; local/ci always loopback; otherwise `INFRA_ENV_LISTEN_HOST_INVALID`) and `VSP_RELEASE_IMAGE_DIGEST` (`sha256:<64 hex>` of the running image, the subject of PRODUCTION_DEPLOYMENT approvals; otherwise `INFRA_ENV_RELEASE_IMAGE_DIGEST_INVALID`). `infrastructure.trustedProxyCidrs` (optional): the load balancer ranges whose X-Forwarded-For the console's sign-in limiter believes. |
| `__evidence__/production-guard-violations.json` | Regenerated by `guard.test.ts`: the guard's verdict (REJECTED) and full violation list for the committed `production.json`. |

### Guard rule sets

- **offline (`local`, `ci`)**: universal rules; live adapters, a live audit sink,
  PHI endpoints and `PHI_PROCESSING` scopes are rejected.
- **sandbox**: universal rules; PHI must be impossible (PHI endpoints off, no
  `PHI_PROCESSING` record or requirement); every live adapter must reference its
  own valid, signed `VENDOR_SANDBOX_INTEGRATION` record (`integrationApprovalId`)
  and have an https, routable, non-placeholder endpoint, a real credential
  reference and real authentication; fixtures stay allowed for systems not yet
  approved; audit on; strict CORS; session-binding exception approved.
- **full (`staging`, `production`)**: no `local_fixture` adapter (declared or
  instantiated), no memory session store, no PGlite, no local audit sink, audit
  enabled; live adapters fully credentialed (see sandbox); static-token exception
  needs a valid `STATIC_CREDENTIAL_EXCEPTION` record; the active model+voice pair is
  in the approved list and its `MODEL_VOICE_SELECTION` record is valid **and its
  signed subject names that exact model, voice and agentConfig**; policy
  `expectedVersion`/`expectedDigest` and tool-catalogue digest pinned and equal to
  what is loaded; CORS has no wildcard and only exact https routable origins;
  `verification.approvedBySecurity` references a valid `SECURITY_REVIEW` record;
  every retention class set (by counsel); no local dev key; real KMS/Secrets
  Manager references (no placeholders, no `local-fixture:`/`file:`); approval trust
  anchor is a KMS key ARN; session-binding exception approved; destination queue
  refs not placeholders; `ops` block present; tenant not synthetic/placeholder.
- **all environments**: SAFETY_PRIORITY, STANDARD_SUPPORT and OUTAGE_CONTINUITY
  destinations exist; destination ids unique and fallbacks resolvable; declared
  adapter kinds match instantiated kinds; safety reserve ≤ capacity.
- **approvals**: `REQUIRED_APPROVALS_BY_ENVIRONMENT` is a floor the config cannot
  lower (production: PHI_PROCESSING, PRODUCTION_DEPLOYMENT, SECURITY_REVIEW,
  CLINICAL_SCRIPTS, RETENTION_SCHEDULE, MODEL_VOICE_SELECTION, POLICY_RELEASE,
  KNOWLEDGE_RELEASE; staging: VENDOR_SANDBOX_INTEGRATION, SECURITY_REVIEW). Each
  must be satisfied by a record that is signed, verifies against the trusted key,
  is for this environment, is inside its validity window, is signed by a role allowed
  for the scope, and — for subject-bound scopes — whose signed subject equals the active
  model/voice/agentConfig, the loaded policy bundle (version and digest) and the
  knowledge snapshot / template catalogue / running image digests in the guard context
  (OPS-APPR-01). Each failing candidate is reported (`APPROVAL_EXPIRED`,
  `APPROVAL_WRONG_ENVIRONMENT`, `APPROVAL_UNSIGNED`, `APPROVAL_SIGNATURE_INVALID`,
  `APPROVAL_APPROVER_ROLE_NOT_PERMITTED`, `APPROVAL_SUBJECT_MISMATCH`,
  `APPROVAL_SUBJECT_UNVERIFIABLE`, ...). Malformed files and duplicate ids are
  violations.
- PHI endpoints are permitted (`phiEndpointsPermitted`) only when the full rule set
  passes with zero violations, `phi.endpointsEnabled` is true and a valid
  `PHI_PROCESSING` record exists.

## LOCAL FIXTURE

`local.json`/`ci.json`, `FileTrustedKeyResolver`, `local-fixture:` references and
the synthetic tenant. Tests generate **TEST-ONLY** key pairs in memory to prove the
guard is satisfiable; no key or approval record is ever written to `approvals/`.

## BLOCKED (prerequisite needed)

| Item | Prerequisite |
|---|---|
| Real approval records | Signed by the accountable humans (privacy counsel, security, clinical safety, finance, operations); the coding agent cannot create them |
| Approval trust anchor | KMS asymmetric SIGN_VERIFY key + key policy owned by security leadership; per-role signing keys would make the role check cryptographic rather than a consistency check (PRQ-023) |
| Live composition inputs for subject binding | The live composition (`main/live-container.ts`) does not yet pass the served knowledge snapshot digest, the template catalogue digest and the running image digest (e.g. ECS task metadata) to `loadDeployableConfig`; until it does, KNOWLEDGE_RELEASE, CLINICAL_SCRIPTS and PRODUCTION_DEPLOYMENT approvals are `SUBJECT_UNVERIFIABLE` (fail closed) |
| Vendor endpoints in sandbox/staging/production | Verified tenant-specific documentation/sandbox access (Talkdesk, Salesforce, IdPs, business systems) |
| Credential, KMS, database and table references | Provisioned accounts and Secrets Manager entries (Terraform apply is approval-gated) |
| Model/voice approval, policy and tool-catalogue pins | Model/voice selection evidence, released policy bundle and pinned catalogue digest |
| Retention durations | Counsel-approved retention schedule (never invented here) |
| Verification values approval | Security approval of OTP/secure-link values (current values are the spec's proposals) |
| Ops capacity values | Contracted vendor concurrency (TB-10) and finance/safety approval of the reserve |

## How to test

```
cd platform
npx vitest run src/config
```

`guard.test.ts` rewrites `src/config/__evidence__/production-guard-violations.json`.

## Requirements enforced

OPS-04 (production refuses fixtures and missing approvals), OPS-05 (sandbox needs
scoped vendor approval; PHI impossible offline and in sandbox), OPS-06 (pins cannot
be overridden; must match loaded artifacts), DATA-01 (no values in violation
strings or parse errors; no query strings in endpoints), AUTH-06 (secrets cannot be
placed in config or overrides), SAFE-02 / SAFE-05 (safety, human and continuity
destinations must exist in trusted config), spec section 16 (production
configuration rejections, PHI endpoints disabled until evidenced, approval records
identify approver, role, scope, time, expiry, evidence and cannot be fabricated).
