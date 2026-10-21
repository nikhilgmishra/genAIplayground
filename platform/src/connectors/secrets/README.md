# platform/src/connectors/secrets: the SecretResolver (WP-06)

Status: **IMPLEMENTED**; verified against LocalStack Secrets Manager (Layer 2). Environment: NOT_CONFIGURED
(the per-connector secrets and their rotation owners are activation input AIN-36; the rotation functions are
Terraform, WP-39).

* `SecretsManagerSecretResolver` resolves `arn:aws:secretsmanager:...` references with `GetSecretValue` by
  version stage (`AWSCURRENT` by default, `AWSPENDING` during a rotation: the connector runtime's
  `verifyPendingCredentials` reads it to test a rotation before promotion), caches each (reference, stage) for a
  bounded TTL (default 300 s, at most 3 600 s, so a rotation is picked up within the bound even without an
  auth failure), coalesces concurrent fetches, and drops a reference on `refresh(ref)` (called by the token
  manager after a 401 or an `invalid_client`).
* Typed failures: `SECRET_NOT_FOUND` / `SECRET_ACCESS_DENIED` (not retryable), `SECRET_STORE_UNAVAILABLE`
  (NOT_STARTED, retryable), `SECRET_MALFORMED`; a KMS key ARN (`SECRET_REF_NOT_A_SECRET`) and an SSM
  parameter (`SECRET_STORE_NOT_SUPPORTED`) are refused before any call.
* `SecretValue` holds the material: only `reveal()` returns it; `toString`, `toJSON` and `util.inspect` print
  a redaction marker, so a value cannot reach a log, an error or a serialized object by accident.
* `secretResolverCredentials(resolver, ref)` adapts a reference to the credentials callback of the existing
  Salesforce adapter (WP-07 moves that adapter onto the connector transport).
* `LocalFixtureSecretResolver` (LOCAL FIXTURE, labelled): synthetic values for `local-fixture:` references in
  Layer-1 tests; it is never composed in a deployed process.

The ESLint configuration allows `@aws-sdk/client-secrets-manager` only here (and in the inbound credential
verifier, `platform/src/ingress/credentials.ts`).

Test: `cd platform && npx vitest run src/connectors/secrets`; Layer 2: `make test-integration SUITE=connectors`.
