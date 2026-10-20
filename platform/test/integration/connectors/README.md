# Layer-2 suite: connector runtime (WP-06)

```bash
make up PROFILE=core
make test-integration SUITE=connectors
```

The production connector runtime against the local composition: TLS to the emulated vendor (a private CA
generated per file with the system `openssl`; the server name is verified), credentials in LocalStack
Secrets Manager, capability evidence signed by LocalStack KMS, checkpoints on postgres:16. Nothing here uses a
LOCAL FIXTURE resolver, PGlite or an in-memory store.

| File | Requirement ids | What runs |
|---|---|---|
| `runtime.test.ts` (`localstack`) | FO-06-04, FO-03-29, FO-16-31, FO-06-03, FO-15-26, FO-05-56, FO-06-13, FO-06-20, FO-06-07, FO-06-08, FO-06-06, FO-06-11, FO-06-18, FO-06-05, ACT-03, AUTH-02, AUTH-04, OPS-03, OPS-04 | `SecretsManagerSecretResolver` (AWSCURRENT cache and TTL, AWSPENDING, stage promotion, typed refusals); the rotation test before promotion (`verifyPendingCredentials`: the AWSPENDING version staged with `PutSecretValue` authenticates while traffic keeps AWSCURRENT); rotation picked up without restart, both after a 401 and on the token endpoint (`invalid_client` once, then the rotated version); one refresh on 401; a read credential cannot write (runtime refusal and vendor 403); host outside the profile and redirects refused before I/O; account and region binding; Retry-After on the retry and as a connector-wide pause (also for a caller already queued on the connector or the operation budget when the pause arrives), after which the queued callers restart spaced at their budget (a `Retry-After: 2` with eight callers queued at 5/s: the vendor's own 6/s limiter never answers 429 and sees at most six requests in any second after the pause); token bucket below the vendor limit (a burst larger than the vendor's per-second limit never puts more than that limit in any one-second window on the wire and no request is answered 429, while the same burst with a budget above the limit is answered 429; asserted from the vendor's arrival times, not from per-request spacing, which TLS and token-fetch latency make noisy); UNKNOWN write and reconcile (a 404 lookup and a list-style lookup answering 200 with no record are not-found, a failing lookup throws); pagination past an empty page with an advanced cursor, TRUNCATED at the page bound, a non-advancing cursor refused, and OFFSET pagination (TRUNCATED with the offset to resume from, the resumed read returns the rest); active probe and KMS-signed evidence (`ECC_NIST_P256`, verified with the public key); a sandbox write never sent on a PRODUCTION_WRITE profile (admitted for staging with Secrets Manager references); the SCHEMA_DRIFT seam |
| `pinning.test.ts` (no emulator; the compose bridge's private host interface) | FO-06-20, SAFE-05 | the egress-classified transport's resolver path for real: a TLS server listening only on a private (RFC 1918) host interface; the injected resolver answers that address once (a second lookup would rebind the name to loopback). The request reaches the private interface from a client socket whose remote address is the checked answer, after exactly one lookup; the next request's loopback answer is refused before any connection (`CONNECTOR_ADDRESS_NOT_ALLOWED`). A host without a private interface fails the test (`LAYER2_PRIVATE_INTERFACE_MISSING`), never skips it |
| `checkpoints.test.ts` (`postgres`, `localstack`) | FO-06-09, ACT-02, FO-06-05 | the production `IncrementalReader` in a child process (`checkpoint-child.ts`) SIGKILLed inside a page transaction and after a commit; restart resumes with no gap and no duplicate; two readers on two connections race on one checkpoint, both for the first checkpoint (unique key) and from a stored position (the compare-and-set on the position digest: the loser blocks on the row lock, no longer matches and gets `CHECKPOINT_CONFLICT`; its page rolls back); an empty batch with an advanced position (a filtered change-feed window) committed on its own, so a reader SIGKILLed after it resumes past it; a drifted page or a refused projection write stops consumption and keeps the checkpoint |

Helpers: `emulator.ts` (the vendor protocol emulator, also used by the Layer-1 unit tests over plain HTTP; it
can filter change-feed windows, `feedFiltered`, accept two client secrets during a rotation overlap,
`addSecret`, answer a list-style lookup by external id, `?externalId=`, listen on another host address,
`host`, and report the vendor's busiest second from a given instant, `maxApiRequestsInWindow(ms, prefix, from)`),
`profiles.ts` (the SYNTHETIC profile of the emulated vendor), `support.ts` (test PKI, Secrets Manager secrets,
the live rig, the child runner), `seams.ts` (the SCHEMA_DRIFT seam).

Fault injection point built here: **SCHEMA_DRIFT** (`seams.ts schemaDriftSeam`): a renamed required field, a
retyped field or an unmapped picklist value from the emulator makes the mapping refuse the record whole with
`ConnectorSchemaDriftError`, writes nothing and turns the read capability UNKNOWN. Its local proofs are the
`[FAULT:SCHEMA_DRIFT seam]` tests here; WP-32 owns the `[FAULT:SCHEMA_DRIFT]` run with the readiness surface.

What this does not prove: any real vendor's documented behaviour, quotas, OAuth policies or schemas (vendor
sandbox runs are Layer 5); AWS IAM, key policies or the rotation Lambda (WP-39); LocalStack's Secrets Manager
and KMS stand in for the AWS services (deploy/local/README.md).
