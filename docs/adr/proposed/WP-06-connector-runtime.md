# Proposed ADR (WP-06): one connector runtime, enforced module boundaries, decision-gated technologies

Status: **PROPOSED** (drafted by work package WP-06, phase B; the phase integration package renumbers proposed
ADRs). Context: follow-on FO-03-11, FO-03-25, FO-03-29, FO-05-39, FO-05-56, FO-06-02 to FO-06-09, FO-06-11 to
FO-06-18, FO-06-20 to FO-06-23, FO-06-25, FO-08-17, FO-08-35, FO-15-19, FO-15-26, FO-16-31, FO-16-39, FO-19-08,
FO-23-08; ADR-0018 (follow-on architecture) and docs/ARCHITECTURE.md section 6.4. Environment status of
everything here: NOT_CONFIGURED (no tenant profile, secret or key exists; nothing calls a vendor).

## Decisions

1. **Every connector runs on one runtime driven by a reviewed `ConnectorProfile`.** Families (WP-19, WP-20,
   WP-21, WP-29) declare operations, scopes, budgets, pagination, timeouts, idempotency and reconcile lookups,
   account and region binding, data streams with deletion / retention / egress classes, health probes and
   mappings in the profile; `platform/src/connectors/runtime` enforces them per operation. A family adds
   configuration and, where a vendor needs it, a narrow protocol helper; it does not re-implement retries,
   tokens, budgets or mapping. Admission is strict even though the contract's new fields are optional
   (additive contract, strict loader).
2. **One outbound transport.** `platform/src/connectors/http` is the only module allowed to open sockets
   or resolve names (lint-enforced, deep imports and aliased globals included, and re-checked by an
   independent import scan in `platform/test/architecture`; lint is a first gate, not a sandbox). It
   refuses before I/O what can be refused before I/O (host allowlist, IP literals,
   http, userinfo, egress classification per request), pins the connection to a DNS answer checked against
   the destination's address class, refuses redirects and bounds bodies, and reports failures by phase so
   that a write after send is UNKNOWN. WP-07 moves the Salesforce adapter, the notification sender and the
   OTLP exporter onto it.
3. **Credentials are references, resolved at run time, scoped per capability.** One `credentialRef` per
   (capability, access); reuse across capabilities, connectors or environments is refused. The resolver
   reads Secrets Manager by version stage with a bounded cache; the token manager drops token and secret
   once on a 401 and re-reads the secret once on `invalid_client`, so rotation needs no restart and never
   loops. Before promotion, `verifyPendingCredentials` authenticates each credential's AWSPENDING version
   (its token is cached apart and never serves traffic; a write never runs on it). KMS key ARNs and SSM
   parameters are refused with typed reasons (SSM support would need `@aws-sdk/client-ssm`, not added).
4. **Mapping is data, not code.** A bounded, total interpreter (pointers, casts, enum tables, units, zones;
   step and size limits) with REQUIRED / OPTIONAL / PROHIBITED fields; drift refuses the whole record and
   turns the capability UNKNOWN. This is the SCHEMA_DRIFT injection point.
5. **Incremental reads commit projection and checkpoint together.** Migration 2060 holds one checkpoint per
   (tenant, profile, stream), advanced by compare-and-set on its position digest in the page's transaction.
   A read ends only when the vendor reports no further position: an empty page with an advanced cursor
   commits that position (a filtered feed is read past, not mistaken for the end), and a non-empty page
   that does not advance the cursor is refused rather than projected again.
5a. **Budgets are taken operation first, connector last.** The connector bucket carries the vendor's
   Retry-After pause and is the last wait before a request is sent, and the pause is re-checked after every
   wake, so a caller already queued when a 429 / 503 arrives is held as well.
6. **Readiness starts UNKNOWN and is earned.** Active probes (auth, metadata, approved synthetic record)
   make reads READY; writes need an authorized sandbox write and reconcile. Capability evidence is signed by
   a KMS key (`ECDSA_SHA_256`) and verified with the public key only.
7. **Module boundaries are a register, enforced three ways.** `platform/architecture/modules.yaml` declares
   every module (present and planned) under the TypeScript roots with its allowed imports; the ESLint rule
   `vsp/module-boundaries` (platform, media, companion, console), `.dependency-cruiser.cjs` (generated from
   the register, adds transitive entry-point reachability) and `platform/test/architecture` (register schema,
   undeclared directories, meta-rules 1 to 6, repository graph) apply the same register. The console API
   contract files became their own module so `protocol` no longer reaches the console API.
8. **Decision-gated technologies need an Accepted ADR before they appear.** EventBridge fan-out (FO-03-25),
   graph retrieval (FO-08-17, plus a WP-20 retrieval evaluation report), similarity-keyed caches (FO-08-35,
   plus the FO-07-42 key and the disclosure re-check on return) and the Personal Agent Protocol (FO-23-08)
   are listed with package names, import patterns and module kinds; manifests, the lockfile, imports, module
   kinds and cache declarations are checked. Every cache declares `exact` or `semantic`.
9. **Refusals are typed.** `UNSUPPORTED_UNDOCUMENTED` (no documented behaviour) is distinct from
   `NOT_IMPLEMENTED` (documented, not built); the live composition (WP-07) refuses any NOT_IMPLEMENTED
   operation.

## Emulator fidelity findings (Layer 2)

* LocalStack 4.14.0 Secrets Manager honours `VersionStages` on `PutSecretValue` (AWSPENDING only) and
  `UpdateSecretVersionStage` (moving AWSCURRENT); `GetSecretValue` by stage returns the staged version.
* LocalStack 4.14.0 KMS creates `ECC_NIST_P256` `SIGN_VERIFY` keys and signs `ECDSA_SHA_256` with
  `MessageType: RAW`; the DER signature verifies with the SubjectPublicKeyInfo from `GetPublicKey`.
  Key policies, grants and custody are not emulated.
* LocalStack 4.14.0 `GetSecretValue` with `VersionStage: AWSPENDING` on a secret that has no pending version
  answers `ResourceNotFoundException` (mapped to `SECRET_NOT_FOUND`, so the rotation test reports
  `CONNECTOR_CREDENTIAL_INVALID` for a credential with nothing staged).
* No new finding contradicts deploy/local/README.md.

## Consequences and open points

* WP-07: compose `ConnectorRuntime` per admitted profile in the live container; bind the Secrets Manager
  resolver and `secretResolverCredentials`; wire `credentialReuseViolations` into `config/guard.ts`; merge
  `CONNECTOR_METRICS` into the platform catalogue; refuse NOT_IMPLEMENTED live operations; move existing
  outbound clients onto the transport.
* WP-32: readiness surface and the `[FAULT:SCHEMA_DRIFT]` Layer-2 run; WP-40 / WP-01 pin
  `profileDigestEntries` in the release manifest; WP-22 consumes `retentionRulesFor`.
* WP-39: Secrets Manager rotation functions and KMS key policies; AIN-36 supplies the per-connector secrets
  and rotation owners.
* Production thresholds (budgets, breaker windows, timeouts) need measured vendor latency and quotas.
