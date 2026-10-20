# platform/src/connectors/profile: ConnectorProfile admission, derivations and reviewed changes (WP-06)

Status: **IMPLEMENTED**. Environment: NOT_CONFIGURED (no tenant profile exists; AIN-36 supplies the
per-connector secrets and owners).

The contract is `ConnectorProfile` in `platform/src/protocol/connector.ts` (generated schema
`schemas/protocol/ConnectorProfile.schema.json`). The contract keeps WP-06's additions optional so earlier
records stay valid; **admission** (`admitConnectorProfile(raw, environment)`) is where a profile becomes
usable, and it is strict:

* schema-valid and digest-bound (`PROFILE_SCHEMA_INVALID`, `PROFILE_DIGEST_MISMATCH`);
* vendor, API, API version, documentation URL and owner present (`PROFILE_VENDOR_MISSING`, `PROFILE_API_MISSING`,
  `PROFILE_API_VERSION_MISSING`, `PROFILE_DOCUMENTATION_URL_MISSING`, `PROFILE_OWNER_MISSING`);
* auth scheme, network class, account / region binding verification, health probes and data streams declared
  (`PROFILE_AUTH_MISSING`, `PROFILE_NETWORK_MISSING`, `PROFILE_BINDING_VERIFICATION_MISSING`,
  `PROFILE_HEALTH_PROBES_MISSING`, `PROFILE_STREAMS_MISSING`), every stream with deletion behaviour, retention
  class and egress class;
* every enabled operation declares its capability, typed parameters, timeout, pagination, rate budget,
  success statuses and required scopes, within the connector's limits (`OPERATION_*_MISSING`,
  `OPERATION_BUDGET_EXCEEDS_CONNECTOR`, ...); a write declares its idempotency mechanism and, unless
  naturally idempotent, an enabled reconcile lookup (`WRITE_WITHOUT_RECONCILE`); no write on a `READ_ONLY`
  profile; templates and mappings compile through the DSL (hosts and paths only from the allowlist);
* capability-scoped credentials: one entry per (capability, access) with its own `credentialRef` (a secret
  reference, never a KMS key) and declared scopes covering every operation of that capability
  (`CAPABILITY_CREDENTIAL_MISSING`, `CAPABILITY_CREDENTIAL_SCOPE_MISSING`, `CREDENTIAL_REF_INVALID`,
  `CREDENTIAL_REF_NOT_A_SECRET`, `CREDENTIAL_SCOPE_UNDECLARED`, `CREDENTIAL_REUSED_ACROSS_CAPABILITIES`,
  `DEFAULT_CREDENTIAL_IS_WRITE_CREDENTIAL`); `local-fixture:` references only in local and ci.

`credentialReuseViolations(sets)` also refuses a reference shared by two connectors or by two environments'
committed configuration (`committedConfigCredentialRefs(platform/config)`); WP-07 wires it into the
configuration guard.

Derivations: `egressDestinationFor` (the EgressGuard destination of a profile), `retentionRulesFor` (vendor-copy
and deletion rules for the retention registry, WP-22), `profileDigestEntries` (configuration digests for the
release manifest, WP-40).

`ConnectorProfileRegistry` applies profile changes only with a review bound to the new digest, by a second
person (`CONNECTOR_PROFILE_SELF_REVIEW`), with a version increase, and writes its audit event first
(`CONNECTOR_PROFILE_AUDIT_UNAVAILABLE` refuses the change when the audit port cannot record it).

Test: `cd platform && npx vitest run src/connectors/profile`.
