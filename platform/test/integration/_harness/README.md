# Layer-2 integration harness

Layer 2 (prompt section 17, FO-17-03): production adapters over their real protocols against the local
emulators of `deploy/local` (`deploy/local/README.md`). Never part of the default unit run.

```bash
make up PROFILE=core
make test-integration SUITE=_harness            # this directory
make test-integration SUITE=_harness FILTER=oidc,queue
make test-integration                           # every suite under platform/test/integration
```

`make test-integration` runs `vitest run --config vitest.integration.config.ts` in `platform/` with
`VSP_INTEGRATION=1`, the state directory (`.tools/vsp-local`), the compose project name and
`NODE_EXTRA_CA_CERTS` set, and writes `evidence/test-reports/vitest-integration.json` plus
`vitest-integration.emulation.json` (override the directory with `ARGS="--report-dir <dir>"`).
`FILTER` items match test file paths of the suite; when none matches, they become a test-name pattern.
The config refuses to load without `VSP_INTEGRATION=1`. Before it starts vitest, the runner removes
both reports of an earlier run from the report directory; when vitest writes no report (it crashed or
refused to start) or the emulation summary is missing, the run exits non-zero and nothing in the
directory claims a result.

## How a Layer-2 test is written

```ts
import { layer2, layer2Context } from "../_harness/layer2.js";
const it = layer2(["postgres", "elasticmq"]);
it("[FO-16-16] ...", async ({ l2 }) => { const port = l2.port("postgres", 5432); /* production adapter here */ });
```

* `layer2(services)` checks, before the test body, that each service is running and healthy; a missing
  service **fails** the test with `SERVICE_NOT_RUNNING` (OPS-03: an unrun check is never a pass) and the
  report lists it under `unavailableServices`. It records `layer: "L2"` and the services' emulation
  labels (`io.vsp.*` labels of the compose fragments) in the test meta, which the JSON report carries
  per test. The service list is the snapshot `global-setup.ts` took; a service that dies during the run
  shows up as a protocol failure of the test that uses it.
* `layer2.withoutServices(reason, realLocal?)` is for process-level checks that use no emulator (the
  runner's own tests); the reason is reported.
* `setup.ts` fails any test that is not declared through one of the two.
* `no-unit-fakes.ts` (a Vite plugin in the config) refuses static imports, from files under
  `test/integration`, of LOCAL FIXTURE adapters, `src/fixtures`, `src/**/testing.ts`, PGlite, in-memory
  stores and the local filesystem audit sink; bare specifiers resolved at run time are refused as well.
  Synthetic identifiers come from `src/shared/ids.ts`.
* `global-setup.ts` discovers the containers of the compose project by label and waits until every one
  is healthy (`VSP_HEALTH_TIMEOUT_MS`, default 300 s).
* Resources are unique per test (`uniqueName`): databases, queues, buckets, realms and rooms never
  collide between files that run in parallel (two workers). Temporary directories come from
  `scratchDir(prefix)` and are removed when the test finishes, pass or fail.
* The harness self-tests write throwaway probe files into `_harness/guard-probe-*/` (or, for the runner's
  own exit-code test, a `guard-probe-*` suite directory run through `test-integration --suite`) and run
  them in a separate vitest process with `VSP_LAYER2_PROBE=1`, which makes the config see probe files only.
  Regular runs (and the runner's file planning) exclude those directories, so a probe left behind by
  an interrupted run is inert; they are gitignored.

## Helpers

| File | Purpose |
|---|---|
| `clients.ts` | AWS SDK v3 clients pointed at the emulators; `createIntegrationDb` (fresh PostgreSQL database, every production migration applied through `PgPoolDb`, serialized by an advisory lock because roles are cluster-wide) |
| `keycloak.ts` | realm provisioning over the admin API; authorization-code login with PKCE, state and nonce through the hosted pages, TOTP enrolment and OTP (RFC 6238) |
| `protocols.ts` | wire-level clients for clamd, RESP, SMTP and SIP over UDP (OPTIONS, INVITE/ACK/BYE) |
| `discovery.ts`, `env.ts`, `layer2.ts` | service discovery, generated state, the test factory |
| `emulation-reporter.ts` | per-service summary: tests passed and failed, what each emulator stands in for and does not prove, tests that failed for an unavailable service |
| `scratch.ts` | `scratchDir(prefix)`: a temporary directory removed when the test finishes |

## Suites in this directory

| File | Requirement ids | What runs |
|---|---|---|
| `health.test.ts` | FO-16-01, FO-19-63, FO-16-13, FO-16-14 | protocol-level health of every core service, digest pins and labels |
| `postgres.test.ts` | FO-16-14 | migrations through `PgPoolDb`; a row lock that blocks a second backend (distinct `pg_backend_pid()`, `pg_blocking_pids` names the holder, `wait_event_type = 'Lock'`), NOWAIT, SKIP LOCKED, serializable conflict, deadlock detection, RLS across connections |
| `queue.test.ts` | FO-16-16, ACT-02 | `PgOutbox` + two `PgOutboxDispatcher`s + `SqsPublisher` to ElasticMQ; each row handed to the publisher exactly once by exactly one dispatcher (counted at the hand-off, because FIFO deduplication and the claim-token check in `settle()` would hide a double claim), FIFO dedupe, redelivery after a crash, handler failure, DLQ, `PgConsumerDedup` |
| `workflow.test.ts` | FO-16-16, ACT-02 | the generated `callback_request` ASL on Step Functions Local with task tokens through ElasticMQ |
| `audit-sink.test.ts` | FO-16-21, OPS-01 | `S3ObjectLockAuditSink` against MinIO with Object Lock and SSE-KMS |
| `oidc.test.ts` | FO-16-13, AUTH-01, AUTH-03 | client, provider and workforce realms; `JwksOidcVerifier`, `WorkforceTokenVerifier.remoteJwks`, `JwtAccessTokenAuthenticator` over HTTPS |
| `livekit.test.ts` | FO-17-03 | WebRTC participants exchanging audio through livekit-server; SIP INVITE to livekit-sip dispatched into a room, answered, ended |
| `runner.test.ts` | FO-19-63, FO-19-64, FO-19-67, FO-19-69, FO-03-14, FO-16-23 | the runner as a black box: exit codes and reports (including a crashed run next to an earlier passing report, and a failing Layer-2 probe suite whose report carries the failure and the compose labels of the service used), FILTER planning, runtime pin checks (`setup-node` reads `.nvmrc`), dependency pins, installed versions, licences and the `--inventory` hand-off; on throwaway projects: `up` exits non-zero and records it when a service never becomes healthy, `down` volume rules, and a `PURGE` / `PURGE_AUDIT` exported in the environment never purges |
| `deps.test.ts` | WP-03 dependency set | the native packages whose install scripts are ignored run on the CPU: the Silero VAD model of `@livekit/agents-plugin-silero` through `onnxruntime-node`, and the VAD and end-of-turn models of `@livekit/local-inference` (synthetic audio; quality on speech is WP-11) |
| `guards.test.ts` | FO-16-23, FO-16-01, FO-19-64 | the unit-fake guard, unlabelled and missing-service tests (separate vitest runs), leftover probe isolation, compose conventions, volume classes, test meta (a service test carries its service's `io.vsp.*` labels verbatim) |

Other packages add their suites as sibling directories (`substrate/` WP-04, `identity/` WP-05,
`connectors/` WP-06, `composition/` WP-07, ...), each with its own owner (`docs/followon/work-packages.yaml`).
