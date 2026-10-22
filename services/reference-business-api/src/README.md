# reference-business-api — a system of record behind the canonical domain contracts (WP-23)

A small Fastify + PostgreSQL service that stands in for a tenant's scheduling, billing, claims, provider-network and
referral systems so the platform's production domain adapters can be exercised over a real protocol. It is **not** a
mock of any vendor and holds **synthetic data only**. Contract: `../openapi/reference-business-api.openapi.json`
(regenerate with `node --import tsx src/openapi.ts --write`; `openapi.test.ts` refuses drift).

## Protocol

- OAuth 2.0 client credentials at `POST /oauth/token` (client_secret_post or basic), scopes per system and access
  (`scheduling:read`, `scheduling:write`, `billing:read`, `billing:write`, `claims:read`, `provider:read`,
  `referrals:read`, `legacy:read`, `legacy:write`); the token response reports `account_id` and `region` for the
  connector runtime's binding verification.
- Reads under `/api/v1/...` in the account's **dialect** (`canonical` or `legacy_codes`), list envelopes
  `{items, nextCursor}`, JSON Schema metadata per system at `/api/v1/meta/{system}/metadata` (with `x-vsp-prohibited`
  fields), the documented visibility window at `/api/v1/meta/{system}/consistency`.
- Writes are **change requests**: `PUT /api/v1/<resource>/{requestId}` where the client chooses the request id. Step 1
  applies the change and appends to the effect log in one transaction (row locks, version and authority checks); step 2
  writes the receipt. Same id + same body replays; same id + another body is `422 REQUEST_ID_REUSED`. The system
  stores a request digest (`REFBIZ_REQUEST_V1`: SHA-256 over `refbiz.request.v1`, the operation and the canonical JSON
  body; see `ids.ts`) and returns it in the lookup and the receipt.
- Every write may carry a **dispatch deadline** `notAfter` (at most 24 h ahead, else 400). It is enforced inside the
  write transaction (`deadline.ts`: lock and statement timeouts bounded by the time left, and a final
  `clock_timestamp() <= notAfter` check as the last statement before COMMIT); past it the request is recorded REJECTED
  `DEADLINE_EXCEEDED` (409) and the change is rolled back. That bounds how long a delivery keeps trying; it does not
  make a 404 definitive (the COMMIT after the final check can land after the deadline).
- **Fences** prove absence: `POST /api/v1/change-requests/{id}/fence` (`{operation, notAfter}`), accepted once the
  database clock is past `notAfter`, answers the change request stored under the id (no lookup lag) or inserts a
  FENCED row (REJECTED, failure `FENCED`) in the same unique key the write inserts, waiting for a delivery still inside
  its transaction; every later delivery of a fenced id is refused 409 `FENCED`. Before the deadline with nothing stored:
  409 `FENCE_BEFORE_DEADLINE`. The consistency report states `dispatchDeadline: REQUEST_NOT_AFTER`,
  `requestDigest: REFBIZ_REQUEST_V1`, `absenceProof: FENCE_AFTER_DEADLINE` and `dispatchReservation: RESERVE_BEFORE_CREATE`.
  `GET /api/v1/change-requests/{id}` is the lookup (404 until the account's visibility lag passed; `INCOMPLETE` after a
  partial write); `POST /api/v1/change-requests/{id}/completion` finishes step 2 only; `GET /api/v1/receipts/{id}`.
- Authority is enforced here too: `CLIENT_CONFIRMED` by the record's client, `PROVIDER_APPROVED` by the provider whose
  schedule it is; anything else is `403 AUTHORITY_REFUSED`.
- The **legacy** product: `POST /api/v1/legacy/appointments/{externalRef}` is NOT idempotent (every delivery creates an
  appointment); `GET /api/v1/legacy/appointments/by-reference/{externalRef}` is its supported reconciliation path. It
  enforces the same dispatch deadline (409 `DEADLINE_EXCEEDED`, nothing created). Its dispatch marker:
  `PUT /api/v1/legacy/references/{externalRef}` reserves the reference for one dispatch id (the first wins; the answer
  says `reservedForDispatch`), `POST .../release` gives back a reservation whose create never left, and
  `POST .../fence` (past the deadline) answers POSTED or fences the reference (a create under it is refused 409
  `FENCED`; one naming another dispatch than the reservation's 409 `RESERVED_BY_ANOTHER_DISPATCH`).

## Fault control (local and ci only)

`REFBIZ_FAULT_CONTROL=enabled` (refused outside local/ci; the admin bind and the API bind must be loopback; every admin
request must carry a loopback `Host`, else 421 `HOST_REFUSED`, against DNS rebinding) starts the admin listener
(`admin.ts`): synthetic accounts, clients and seeds; per-host TLS certificates (SNI); dedicated loopback endpoints whose
mode can be `REFUSE_CONNECTIONS` or `STALL_HANDSHAKE`; account-scoped faults (`DELAY_RESPONSE`, `HTTP_STATUS`,
`PARTIAL_WRITE`, `COMMIT_THEN_DELAY`, `DROP_RESPONSE_AFTER_COMMIT`, `LATE_RECEIPT`, `SLOT_VERSION_CHANGE`,
`STALL_BEFORE_COMMIT`: the write passed its final deadline check and its transaction is held open before COMMIT) with
hit counters; commit barriers; the effect and request logs; a stored change request regardless of visibility; a
legacy reference's state; the code digest of the running sources (`GET /__admin/build`, `build.ts`), which the
Layer-2 suite compares with the checkout before it runs. With
nothing armed the API behaves as documented; without the admin listener the fault board records nothing. Expired
tokens are purged on issuance (bounded).

## Running

The image build context is the repository root, whose `.dockerignore` is an allowlist: the build needs
`!services/reference-business-api/` re-included there (owner of `.dockerignore`; reported by WP-23).

Local composition: `make up PROFILE=core,domain` (fragment `deploy/local/services/reference-business-api.compose.yaml`,
host networking, ports on 127.0.0.1). The container runs the checkout's sources from a bind mount: after a change to
`src/` it must be recreated (`docker compose ... up -d --force-recreate reference-business-api`, or `make up` after the
fragment changed); the Layer-2 suite refuses a stale instance (`REFBIZ_STALE_CODE`). Image: `services/reference-business-api/Dockerfile` (fault control disabled by
default; TLS and database TLS required outside local).
