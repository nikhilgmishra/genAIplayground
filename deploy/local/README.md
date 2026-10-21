# Local Layer-2 composition

The production adapters run here over their real protocols against local emulators
(prompt sections 16 and 17, Layer 2; `docs/ARCHITECTURE.md` section 6.3.2; ADR-0018 decision 6).
This is a test environment with synthetic data only. It is not a deployment and nothing in it is
production evidence: what an emulator does not prove is listed per service below and in the test
reports, and it stays `NOT_RUN` until a sandbox qualification (Layer 5).

Owner: WP-03 (`compose.yaml`, `services/core.compose.yaml`, the runner), then the runner group owner of
each phase (`docs/followon/work-packages.yaml`).

## Commands

```bash
pnpm install --frozen-lockfile        # once; the runner and the tests use the workspace dependencies
make up PROFILE=core                  # start the core services and wait for every health check
make test-integration                 # every Layer-2 suite (platform/test/integration/*); what CI runs
make test-integration SUITE=_harness  # one suite, here the harness (platform/test/integration/_harness)
make ps                               # services, health, published ports
make logs SERVICE=keycloak            # container logs
make down                             # remove containers and networks; volumes are kept
make down PURGE=1                     # also remove volumes, except audit volumes (refused, recorded)
make down PURGE=1 PURGE_AUDIT=1       # remove every volume of the project, audit evidence included
make check-deps ARGS=--inventory      # direct dependencies with locked version and licence (hand-off to docs/INVENTORY.md)
```

Every target delegates to `node scripts/vsp/runner.mts <command>` (Node 22, `.nvmrc`), which exits with
the real exit code of the tool it ran; GNU make reports any failing recipe as 2. `make help` prints the
runner usage. Each `up` and `down` writes a run record to `evidence/runs/local-{up,down}-<stamp>.json`
(gitignored): fragments with their SHA-256, services with image, state, health and ports, and for `down`
the volumes removed and the volumes retained with the reason. `up` exits non-zero, and records the
exit code, when a service does not become healthy within `TIMEOUT` (default 600 s).

`PURGE` and `PURGE_AUDIT` count only as make command-line assignments. GNU make imports environment
variables as make variables; the Makefile ignores (with a notice) a `PURGE` or `PURGE_AUDIT` exported
in the shell, so a variable left behind never turns a plain `make down` into a purge.

Requirements: Docker Engine with the Compose v2 plugin (2.20 or newer; checked by `up`), `openssl`
(generates the local TLS certificate), Node 22.22 and pnpm 10.28 (`packageManager`). In the session
container start the daemon with `dockerd > /tmp/dockerd.log 2>&1 &`. Images pull from Docker Hub.

## Files and conventions

`compose.yaml` is the entry file and holds no services. The runner loads it plus every
`services/*.compose.yaml` fragment in name order, so a package adds the services it needs in its own
fragment (`docs/ARCHITECTURE.md` section 6.3.2 lists the planned fragments and owners) and never edits
the entry file. Services are selected with compose profiles: `make up PROFILE=core,media`.

Every fragment follows these rules; `platform/test/integration/_harness/guards.test.ts` checks them:

* images are pinned by tag and digest (`name:tag@sha256:...`);
* published ports bind `127.0.0.1` only;
* credentials come from the generated state file, never from the repository: a value for a key named
  like a password, secret or key is a `${VSP_...}` reference;
* every service carries `io.vsp.emulates`, `io.vsp.protocol`, `io.vsp.not-emulated` and `io.vsp.licence`
  labels; the Layer-2 report copies them onto each test that used the service;
* every named volume carries `io.vsp.data-class` (`audit`, `operational`, `cache` or `ephemeral`);
  `audit` volumes survive `make down PURGE=1`;
* update checks and telemetry are disabled; no service calls a billable endpoint (OPS-05).

The policy engine is not a service: the production OPA engine runs in-process inside the platform from
the built WASM bundle (ADR-0002, FO-16-15), so the composition has no policy container.

## Generated state

`up` creates `.tools/vsp-local/` (gitignored, mode 0700) on first use:

| Item | Content |
|---|---|
| `env` | emulator credentials (random per checkout: Postgres, MinIO root and its single KMS key, Keycloak bootstrap admin, AWS emulator keys, LiveKit API key and secret, Valkey password); passed to compose with `--env-file` |
| `ca/` | a local CA (`ca.key` mode 0600), 825 days |
| `tls/` | `server.pem`, `server.key` for `localhost`, `keycloak`, `127.0.0.1` (397 days, renewed 30 days before expiry), `ca.pem` |

The values protect services bound to the loopback interface and are valid nowhere else. The server key
is world-readable inside the 0700 state directory because the Keycloak container (uid 1000) reads it
through a read-only bind mount. Delete the directory to rotate everything (then `make down PURGE=1
PURGE_AUDIT=1`, because existing volumes keep the old Postgres and MinIO credentials).
`make test-integration` sets `NODE_EXTRA_CA_CERTS` to `tls/ca.pem`, so the platform's HTTPS clients
trust Keycloak without any TLS check being disabled.

## Core services (`services/core.compose.yaml`, profile `core`)

Pinned 2026-10-19. Tags were chosen from releases at least 7 days old where one existed.

| Service | Image (tag; digest in the fragment) | Licence | Host port | Stands in for | Not proven here |
|---|---|---|---|---|---|
| postgres | `pgvector/pgvector:0.8.7-pg16-trixie` | PostgreSQL | 55432 | Aurora PostgreSQL 16 with pgvector | failover, replication lag, IAM auth, storage durability |
| dynamodb | `amazon/dynamodb-local:3.3.1` | DynamoDB Local licence | 58000 | DynamoDB | throttling, IAM conditions, PITR, TTL timing |
| elasticmq | `softwaremill/elasticmq-native:1.7.1` | Apache-2.0 | 59324 | SQS standard and FIFO with redrive | IAM and queue policies, SSE-KMS, account isolation, quotas |
| minio | `pgsty/minio:RELEASE.2026-08-04T00-00-00Z` | AGPL-3.0 | 59000 | S3 with Object Lock (audit bucket, QA media) | cross-account IAM and bucket policies, `ExpectedBucketOwner`, AWS KMS key policy |
| localstack | `localstack/localstack:4.14.0` | Apache-2.0 | 54566 | KMS, Secrets Manager, SNS, SES | IAM and key policies, key custody, delivery, quotas |
| keycloak | `keycloak/keycloak:26.7.5` | Apache-2.0 | 58443 (HTTPS) | client, provider and workforce OIDC IdPs | tenant claims, amr/acr values, MFA policies, rotation cadence |
| stepfunctions | `amazon/aws-stepfunctions-local:2.0.0` | Step Functions Local licence | 58083 | Step Functions STANDARD | IAM role, history limits and quotas, logging, versions/aliases |
| mailpit | `axllent/mailpit:v1.31.4` | MIT | 51025 (SMTP), 58025 (API) | outbound email endpoint (capture only) | delivery, bounces, SPF/DKIM/DMARC |
| clamav | `clamav/clamav:1.5.4` | GPL-2.0 | 53310 | malware scanning of uploads | signature freshness (database frozen in the image), throughput |
| valkey | `valkey/valkey:8.1.10-alpine` | BSD-3-Clause | 56379 | LiveKit's message bus only (never business state) | ElastiCache failover, TLS, token rotation |
| livekit | `livekit/livekit-server:v1.13.9` | Apache-2.0 | 57880 (API/WS), 57881/tcp, 57882/udp (WebRTC) | self-hosted media plane | PSTN, TURN, multi-node routing, real network impairment |
| livekit-sip | `livekit/sip:v1.18.0` | Apache-2.0 | 55060 udp+tcp (SIP); RTP 10000-10099 inside the network | SIP gateway for the carrier trunk | carrier trunks and allowlists, SIP TLS/SRTP, carrier DTMF and recordings |

Host ports are overridable with `VSP_PORT_<SERVICE>` (for example `VSP_PORT_POSTGRES=55433 make up`);
the harness discovers the published ports from Docker, so tests follow an override. LiveKit's WebRTC
ports are fixed (57881, 57882) because the ICE candidates must advertise the published numbers; the
configuration is inline (`LIVEKIT_CONFIG`, `SIP_CONFIG_BODY`) until WP-11 adds `deploy/local/livekit/`.
Its ICE candidates advertise `127.0.0.1`, which suits participants on the host (the test runner);
participants in other containers need the network-aware configuration WP-11 adds.

## Fidelity findings recorded while pinning (2026-10-19)

These are behaviours of the pinned emulators, observed by the `_harness` tests, that later packages must
design around. None is a claim about AWS, a carrier or a tenant IdP.

1. **Step Functions Local 2.0.0** accepts the generated ASL as is (`JitterStrategy`, `MaxDelaySeconds`),
   delivers `.waitForTaskToken` task messages through ElasticMQ, routes `SendTaskSuccess` output through
   the Choice states and `SendTaskFailure` into `Catch`. A token reused while the execution waits on a
   later task is refused with `TaskTimedOut` (as in AWS); a callback for an execution that already ended
   is accepted silently (AWS answers `TaskTimedOut`), with no effect on the execution. The workflow bridge
   (WP-26) must deduplicate callbacks itself. **Race:** the emulator can deliver the task message to the
   queue before it has recorded `TaskSubmitted`. A `SendTaskSuccess` sent in that gap fails the execution
   with `States.Runtime` "The input {MD5OfMessageBody: ..., MessageId: ...} is not valid JSON". This was
   seen once in the WP-03 verifier's Layer-2 runs (2026-10-19). It did not reproduce in 18 isolated and
   CPU-stressed runs, or in 20 runs with the wait removed. `workflow.test.ts` waits (bounded) until every
   running execution has submitted its callback tasks before it signals. A WP-26 bridge that consumes task
   messages promptly can hit the same gap in Layer 2, so it must tolerate it (wait or retry); whether AWS
   has this gap is not established here. The emulator sends to the host named in `QueueUrl`
   (`SQS_ENDPOINT` does not redirect AWS-format URLs), so Layer-2 renders the ASL placeholders with
   emulator URLs (`http://elasticmq:9324/...`), the way Terraform renders them with real ones. This answers
   ADR-0018 open item 5 for the paths exercised; history limits and quotas remain `NOT_RUN`.
2. **ElasticMQ** resolves a queue by name and ignores the host and account of the queue URL, so the
   production `SqsPublisher` runs unchanged with AWS-format URLs and the SDK endpoint pointed at ElasticMQ.
3. **MinIO** enforces `If-None-Match: *` (412), Object Lock retention (mode and retain-until returned),
   server-side SHA-256 checksums and SSE-KMS with its built-in key. A delete of a locked version is refused
   with 400 `InvalidRequest` where S3 answers 403 `AccessDenied`. MinIO stopped publishing official images
   in 2025; `pgsty/minio` is a community build of the upstream source (AGPL-3.0, used unmodified for local
   tests only).
4. **LocalStack** 4.14.0 is the last Community image that runs without an account token (its banner
   announces a unified image from March 2026). It emulates SES v1, not SESv2: `@aws-sdk/client-ses` is
   pinned next to `client-sesv2` so the notification adapter (WP-27) can be verified locally; Mailpit
   covers the SMTP path.
5. **Keycloak** 26.7.5: issuer `https://localhost:58443/realms/<realm>`. `amr` appears only with the AMR
   protocol mapper and authenticator reference values; with a reference max age of 0 the value is dropped
   whenever the token is issued in a later second than the authentication step (an empty `amr`, seen
   intermittently), so the harness sets one hour. Enrolling TOTP through the `CONFIGURE_TOTP` required
   action yields a password-only session (`amr` without `otp`); the next login with the OTP form carries
   `otp`. Keycloak refuses an OTP code reused within its 30 s step.
6. **livekit-sip** v1.18.0 needs the Redis-compatible bus (Valkey here) shared with livekit-server. An
   INVITE matched by an inbound trunk and dispatch rule creates a room with a SIP participant and stays at
   180 Ringing until another participant publishes a track the SIP participant can subscribe to; then it
   answers 200 OK with SDP. An INVITE for a number no trunk serves gets `404 Does not match Trunks or
   Dispatch Rules`.
7. **ClamAV** 1.5.4 ships its signature database in the image; `freshclam` is disabled, so detection is
   frozen at the image digest (the EICAR test file is detected).
8. **Keycloak** 26.7.5, recorded by WP-05 (wave B3, 2026-10-20):
   - The `groups` claim is missing from token introspection (RFC 7662) responses unless a groups mapper
     is added with "add to token introspection" on. A relying party that reads group membership from
     introspection then sees no groups for everyone. The WP-05 realm templates add the mapper. A tenant
     IdP must put the membership claim in its introspection responses.
   - Group full paths are not unique. A top-level group named `vsp/security-admin` gets the path
     `/vsp/security-admin`, the same as the nested `security-admin` group under `vsp`, unless the realm
     escapes slashes in group paths. Never map roles from group path strings. WP-05 maps the console
     client's own client roles, granted through the managed groups.
   - Revoking a refresh token that has already been redeemed also ends the token that replaced it. A
     test that expects the successor to stay usable after such a revocation is testing Keycloak, not the
     relying party.
   - Other sign-ins of the same user stay active when one of them logs out. A logout is never evidence
     about the user's other sessions.
   - RFC 7009 revocation ends one token family only, never the user's other sign-ins.
   - With `revokeRefreshToken` on and a maximum reuse of 0, a refresh token that has just been redeemed
     introspects as inactive before the client has stored the rotated token. An active check that races
     a refresh therefore sees "inactive" for a user who is still employed. The WP-05 code treats such a
     race as a retryable `SESSION_ROTATED`, not as offboarding.
   - Test convention, not an emulator behaviour: realm names are letters only. The platform egress check
     refuses URL paths with long digit runs or Luhn-valid numbers, so a realm named with digits would be
     refused before Keycloak is reached.

## What is not here yet

The application images (gateway, worker, media workers, audit exporter, console, companion) and the
OpenTelemetry Collector (`app.compose.yaml`, `otel-collector.compose.yaml`, WP-07), the Keycloak realm
import with the synthetic users of the journeys (`deploy/local/keycloak/`, WP-05; the harness creates its
own throwaway realms through the admin API), LiveKit configuration (WP-11), SIP test agents (WP-12),
model, speech, retrieval, lakehouse, timeline and reference-business-API emulators (WP-08, WP-13, WP-20,
WP-21, WP-18, WP-23) and network fault injection (WP-42). Until the application images exist, `make up`
starts the dependencies and the tests compose the production adapters in the test process.
