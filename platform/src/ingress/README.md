# ingress — authenticated inbound event inbox

Status: **IMPLEMENTED**, **VERIFIED against protocol emulators (Layer 2)** for the HTTP, mTLS,
KMS, Secrets Manager and PostgreSQL paths (`platform/test/integration/ingress`), unit-tested on
PGlite and re-run on postgres:16 (`VSP_TEST_DB=pg`, `substrate/pg-pool.test.ts`). Nothing here has
received a real vendor webhook; no source is configured in any environment (NOT_CONFIGURED). The
Kinesis adapter has **no emulator run** (its SDK client is not in the workspace yet). SYNTHETIC
events only. Nothing here establishes HIPAA compliance or production readiness.

Follow-on requirements: FO-07-16..22, FO-06-97, FO-06-98, FO-15-50, FO-03-21, FO-03-26, FO-16-41.
Invariants at this boundary: AUTH-04 / AUTH-06 (credentials, never logged), ACT-02 (one effect per
event), OPS-01 (audited acceptance and replay), DATA-01/02 (encrypted raw payloads, restricted columns).

## Flow

```
POST /v1/ingress/:sourceId/events   (gateway/http/webhook-routes.ts ingressPlugin, raw bytes)
  -> IngressRouter.handle            profile lookup, size limit, InboundVerifier (documented mechanism)
  -> PgInbox.accept                  KMS data key seals the payload; one transaction: advisory lock on
                                     (tenant, source, event id), durable replay key (token-authenticated
                                     deliveries), dedupe, audit ingress.event.accepted / quarantined,
                                     inbound_events row, inbound_deliveries row
  <- 200 {decision, inboxId}         only after the commit (persist before acknowledge); 503 otherwise;
                                     an authentic byte-identical redelivery is 200 "duplicate" (recorded)
InboxProcessor.runOnce (worker)      SKIP LOCKED claim with lease; KMS decrypt; digest check; re-classify;
                                     handler + source-version projection + PROCESSED in one transaction,
                                     fenced by the claim token; failures back off, then INBOUND_DEAD
InboxReplayService.replay (console)  MFA <= 900 s, allowed reason, audit FIRST in the same transaction
StreamIngestor (worker)              existing Kinesis / Kafka stream -> same inbox, checkpoint after commit
```

## What is implemented

| Piece | File | Notes |
|---|---|---|
| Migrations | `platform/migrations/2041_inbound_inbox.sql`; `2043_inbound_replay_keys.sql` (durable replay cache: SHA-256 of (source, jti) with the digest of the bytes it first authenticated, kept until the token expires); `2044_ingress_credential_promotions.sql` (when each credential version was first observed as current, and the overlap anchor of the previous version) | `inbound_events` (unique `(tenant, source, event_id)`, sealed payload columns, payload digest, schema id/version, ACTUAL auth mechanism and verifying credential version, stream partition/position, status RECEIVED / PROCESSED / QUARANTINED / INBOUND_DEAD, attempts and backoff, claim lease, duplicate and replay counts, raw retention), `inbound_deliveries` (every delivery, duplicate flag, digest match), `inbound_replays`, `inbox_projection_versions` (version-regression trigger), `inbox_stream_checkpoints` (regression trigger), `inbox_stream_gaps`. Guard trigger (identity immutable, legal transitions only, replay count +1). FORCE RLS. Column grants: the gateway inserts and reads identity/digest only; the console reads metadata and replay columns, never the payload; the worker processes and purges. |
| Source profiles | `profile.ts` | Strict schema per source: tenant, family, vendor + documentation URL (the verifier follows the vendor's documented mechanism, never an invented one), verifier config, envelope field names, contracts per event type, body limit, raw retention days, bounded processing policy, rotation overlap, pending-credential acceptance. |
| Credentials | `credentials.ts` | `SecretsManagerCredentialResolver`: AWSCURRENT, AWSPREVIOUS and AWSPENDING (only when the profile accepts it); bounded cache, rotation without restart, `refresh(ref)` for a scheduler. AWSPREVIOUS verifies for `rotationOverlapSeconds` counted from the PROMOTION of the current version, recorded by `PgCredentialPromotionLedger` (migration 2044, shared by every replica, survives restarts): WITNESSED when the previous version had been seen as current within the observation bound (anchor = first observation of the new one: at least the full overlap after the promotion, at most the bound longer); otherwise a LOWER bound (the previous version's last observation, or the new version's CreatedDate): a shorter overlap, never a longer one; UNKNOWN (no creation time, nothing witnessed): no overlap. A missing CreatedDate is never replaced by "now". Secret format `{"key": base64}` or `{"fingerprint": sha256 hex}`. `StaticCredentialResolverFixture` is a labelled LOCAL FIXTURE. |
| Verifiers | `verifiers.ts` | HMAC header (sha256/sha1, hex/base64, optional timestamp in the signed payload with a tolerance window; the signature binds the bytes, so a byte-identical replay or vendor redelivery is authentic and the inbox records it as a duplicate), JWT bearer (HS256 versions or JWKS over HTTPS, body-hash claim as LiveKit sends it, bounded lifetime; a token that does not bind the body must carry a jti, whose replay key goes to the durable replay cache: same token over other bytes => 401 `INGRESS_REPLAYED` on every replica), mTLS (socket chain verified by Node, or the ALB's verified leaf header; SHA-256 fingerprint pinned through credential versions), reconcile-by-lookup (the authoritative record is fetched server-side), stream IAM (pull only). Constant-time comparisons; reason codes only. |
| Contracts | `contracts.ts` | Explicit zod contracts per `(contractId, version)`; unknown types, schema violations and unknown fields are QUARANTINED, never promoted into context. |
| Cipher | `cipher.ts` | `KmsEnvelopeCipher`: `GenerateDataKey` AES_256 with encryption context `{purpose, tenantId, sourceId}`, AES-256-GCM with AAD binding tenant, source, event id and digest; `Decrypt` needs the same context. `LocalAesCipherFixture` is a labelled LOCAL FIXTURE. |
| Inbox | `inbox.ts` (`PgInbox`) | `accept` as above; `purgeExpiredPayloads(tenant)` nulls the sealed columns of terminal rows after retention, keeping digests and evidence, EXCEPT under an active legal hold (`legal_holds`, RetentionJob predicate semantics: tenant, dataset `inbound_raw_payloads` or unset, record key = inbox id or unset, any data class; a subject-scoped hold keeps every expired payload of the tenant, `LEGAL_HOLD_SUBJECT_SCOPE_UNRESOLVABLE`), reported as `{purged, held, reasonCode}`; `purgeExpiredReplayKeys(tenant)` deletes replay keys whose token expired. |
| Processor | `processor.ts` (`InboxProcessor`) | Claims in arrival order (FOR UPDATE SKIP LOCKED, lease), checks the entity's source-version order FIRST (an event already superseded by a newer projected version is marked SUPERSEDED and its handler never runs), processes with handlers keyed `contractId@version`, bounded exponential backoff, INBOUND_DEAD after `maxAttempts` with an error log and `vsp_inbox_dead_letter_total`, stream gaps for positions not applied. The decrypted payload is re-hashed against the recorded digest before anything runs (a mismatch is INBOUND_DEAD at once, `INBOX_PAYLOAD_DIGEST_MISMATCH`). A late attempt whose lease was taken over is fenced by the claim token and applies nothing. |
| Ordering | `projection.ts` | Total order `(source_version, occurred_at, event_id)`; reordered, delayed, duplicated, replayed or backfilled versions leave the newest state (SUPERSEDED); the table refuses a regression. |
| Replay | `replay.ts` (`InboxReplayService`) | Only QUARANTINED / INBOUND_DEAD, bounded per event (`maxReplays`, then `INBOX_REPLAY_LIMIT_REACHED`), staff ref (opaque id), allowed reason code, fresh MFA (within `mfaMaxAgeSeconds` and never in the future); the `inbox.replay` audit event is appended first in the same transaction, so no audit means no replay. |
| Router | `router.ts` (`IngressRouter`) | 200 / 400 / 401 / 404 / 413 / 503 with reason codes only. For reconcile-by-lookup, an authoritative record that describes another event than the one announced is refused (401 `INGRESS_LOOKUP_EVENT_MISMATCH`, counted as `auth_rejected`, nothing stored). |
| Streams | `streams.ts` (`StreamIngestor`, `KinesisStreamSource`) | Checkpoint after commit, heartbeats, lag and open-gap gauges. Kinesis over the structural `KinesisApi`; Kafka/MSK through the same `StreamSource` port. |
| HTTP | `platform/src/gateway/http/webhook-routes.ts` `ingressPlugin` | Encapsulated raw-body parser (signatures are over the exact bytes), body limit = largest source limit, optional socket client certificates. Registration in the gateway composition is WP-07's. |

Logs (the content-free logger keeps only allowlisted keys and value shapes): the source id as `integration`, the
decision as `outcome`, inbox ids, payload digests and reason codes; never a header value, a token, a signature,
a secret or payload content (`ingress.test.ts` asserts no ingress log field is redacted or leaks). The verifying
credential version is recorded on the inbox row and in the audit event (FO-07-19).

Metrics (catalogue fragment `platform/src/observability/catalog/substrate.ts`):
`vsp_inbox_events_total{result,auth}`, `vsp_inbox_quarantined_total{reason}`,
`vsp_inbox_processed_total{result}`, `vsp_inbox_dead_letter_total`, `vsp_inbox_replays_total{result}`,
`vsp_inbox_backlog`, `vsp_inbox_stream_lag`, `vsp_inbox_stream_open_gaps`.

## Layer-2 evidence (`make test-integration SUITE=ingress`)

| Test | Proves |
|---|---|
| `http.test.ts` signed event | authenticate before persist, KMS-sealed payload, audit in the same transaction, wrong key refused, an identical replayed request a recorded duplicate |
| `http.test.ts` persist before acknowledge | read-only database => 503, nothing stored; the sender's retry accepted once |
| `http.test.ts` rotation | Secrets Manager AWSCURRENT / AWSPREVIOUS / AWSPENDING: both keys inside the overlap only, pending only when accepted, verifying version recorded |
| `http.test.ts` staged rotation | a next key staged as AWSPENDING two hours before `UpdateSecretVersionStage` promotes it: the old key verifies for the full overlap after the promotion (WITNESSED anchor), at a second replica too, and is refused after it |
| `http.test.ts` cross-replica redelivery | a body-signed webhook redelivered byte for byte to another replica => 200 duplicate, recorded; a bearer token reused over other bytes at another replica => 401 `INGRESS_REPLAYED` |
| `crash.test.ts` | a replica SIGKILLed after the inbox commit and before the response (no acknowledgement; the event is durable; the redelivery is a recorded duplicate), and after the insert before the commit (rolled back; the redelivery is accepted once) |
| `http.test.ts` mTLS | CA-verified and pinned certificate accepted; unpinned, foreign and absent certificates refused |
| `http.test.ts` [FAULT:DUPLICATE_WEBHOOK] | ten concurrent redeliveries => one row, nine recorded duplicates; SQS redelivery of the produced outbox message => one effect, dedupe row |
| `http.test.ts` deterministic accept race | two replicas' accepts of one event held at the same point inside the transaction (`acceptRaceBarrier` seam in `support.ts`): the second is observed in `pg_locks` waiting for the per-event accept lock, both answer 200 (accepted + recorded duplicate), one row, two deliveries; without the lock both reach the duplicate check and one fails with 23505 (503), so the lock is load-bearing on every run |
| `livekit-webhook.test.ts` | webhooks SENT BY livekit-server (the composition's pinned image as a throwaway container with `webhook.api_key` / `webhook.urls`): HS256 JWT binding the body's SHA-256, verified against the API secret version in Secrets Manager; room_started / room_finished stored RECEIVED with `JWT_BEARER` and the verifying version, sealed, audited, processed; deliveries to a source holding another key refused (401, nothing stored, LiveKit's own delivery log shows 200 / 401); the payload's TURN credential (`room.turnPassword`) never in a log |
| `processing.test.ts` | poison => INBOUND_DEAD with backoff and alarm; replay refused without audit or MFA; two processors exactly once; lease takeover fenced; source-version ordering (late older versions run no handler); quarantine; restricted columns and retention purge, a payload under a legal hold kept until the release |

## Known limits

- A body-only HMAC signature (GitHub-style) carries no freshness: a captured request stays authentic
  forever. The inbox never deletes rows, so its replay is always a recorded duplicate with no effect; the
  raw-payload purge keeps the row's identity and digest.
- The raw replay payload has no retention class in the retention registry yet: its duration is the source
  profile's `rawRetentionDays` until the retention owner registers `inbound_raw_payloads` with an approved
  duration (open issue).
- LiveKit room webhooks carry a TURN credential (`room.turnPassword`) and room names: the raw payload is a
  restricted, sealed artifact, and handlers must not copy those fields into projections or logs.
- No carrier (telephony provider) webhook verifier exists yet: the carrier and its documented signature scheme
  are an activation input (AIN-07); the verifier interface takes one more `kind` when it is chosen.
- `mtls` in `alb_header` mode trusts `X-Amzn-Mtls-Clientcert`: only behind an ALB in mTLS verify mode that
  strips a client-supplied copy of the header.
- `KinesisStreamSource` needs `@aws-sdk/client-kinesis` (and LocalStack `kinesis`) for an emulator
  run; a Kafka/MSK source needs a client library. Both are dependency requests, not in the workspace.
- Wiring (router in the gateway, processor / stream loops in the worker, replay endpoint in the
  console API, alarms in Terraform) belongs to the composition packages.

## How to test

```bash
cd platform
npx vitest run src/ingress
make -C .. test-integration SUITE=ingress
```
