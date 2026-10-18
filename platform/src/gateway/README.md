# platform/src/gateway: trusted tool gateway, MCP adapter and HTTP surface

Status: **IMPLEMENTED_OFFLINE**. Everything here runs and is tested over PGlite, the OPA
WASM policy bundle, the identity services and LOCAL FIXTURE adapters with SYNTHETIC data.
Nothing has been connected to Talkdesk, a real IdP, a vendor sandbox or production, and
nothing here claims HIPAA compliance or production readiness. `tools/` holds the business
tool modules (definitions and execution); the pipeline owns everything around them.

## Files

| File | Responsibility |
|---|---|
| `pipeline.ts` | `ToolPipeline.invoke()` — the trusted request flow below. Never throws; every failure is a `ToolResult` with a reason code. |
| `catalog.ts` | Pinned catalogue: strict JSON Schemas from zod (`additionalProperties: false` at every level, no `patternProperties`), forbidden identity fields, deterministic sha256 digest, frozen lookup, committed-file parsing with tamper detection, drift check. |
| `generate-catalog.ts` | CLI writing `schemas/tools/catalog.json` from the business tool modules; `--check` fails on drift. Modules are built over a services object that throws on access, so definitions cannot depend on runtime data. |
| `mask.ts` | `applyFieldMask` (pure; prototype keys ignored; arrays element-wise). |
| `auth.ts` | `LocalFixtureTokenAuthenticator` (LOCAL FIXTURE, local/ci only) and `JwtAccessTokenAuthenticator` (issuer, audience, asymmetric algorithms, expiry, max age, clock tolerance, client id → integration, scope → channel). |
| `session-binding.ts` | TB-01 modes: `trusted_header` (`X-VSP-Session-Ref`), `server_to_server_lookup` (`X-VSP-Interaction-Id` → `InteractionLookup`), `tool_argument_lookup_exception` (refused without an approval id). |
| `gateway-audit.ts` | Content-free audit helper; the bearer session reference is always converted with `sessionBindingRefFor()`. |
| `call-state.ts` | Per-process session leases and handoff index; read-only pending-action lookup. |
| `mcp.ts` | MCP Streamable HTTP adapter (`POST /mcp`, stateless, JSON responses; `GET`/`DELETE` 405). |
| `openapi.ts`, `generate-openapi.ts` | OpenAPI 3.1 document generated from the route definitions into `schemas/openapi/gateway.openapi.json`; `--check` fails on drift. |
| `http/route.ts`, `http/app.ts` | Route definitions (one source for Fastify and OpenAPI), auth hook before parsing, strict params/body, response validation, helmet, no CORS, body limit, per-integration rate limit, generic errors, opaque request ids. |
| `http/tool-routes.ts` | `GET /v1/tools/catalog`, `POST /v1/tools/:name/:version`. |
| `http/telephony-routes.ts` | Telephony-control API (TC-01..TC-08, TC-10..TC-12, utterance screening, human request). |
| `http/portal-routes.ts` | Secure-link portal API (describe, approve, step-up). |
| `http/webhook-routes.ts` | `POST /v1/webhooks/transfer-events` (TC-09): LOCAL FIXTURE HMAC in local/ci only; elsewhere `403 WEBHOOK_AUTH_UNVERIFIED`. |
| `http/health-routes.ts` | `GET /health/live`, `GET /health/ready` (database, policy bundle, audit, config guard). |
| `fixtures/` | LOCAL TEST FIXTURES (fixture tools, harnesses). Not used by the composition root except the stub business in tests. |

## Pipeline steps

(a) integration identity: channel `mcp_tools`, tenant and environment match →
(b) catalogue lookup by exact name + pinned version (MCP: name only, single pinned version) →
(c) arguments: byte bound, no server-established identity fields anywhere, strict schema →
(d) session from the trusted binding only; failure denies protected tools, while
`SAFETY_AND_HUMAN_ROUTE` tools continue without a session (`executeWithoutSession`, SAFE-02:
`request_human_transfer` and `request_safety_route` call the HandoffService with `ctx: null`
and the call id from the trusted transport binding; without a trusted call id they answer
`PERMANENT_FAILURE CALL_UNIDENTIFIED_USE_STUDIO_ROUTE`; no speech without a session; the
`tool.invoke` audit event carries the session reason code and the transport call id) →
(e) regional write fence (`VSP_MUTATIONS_ENABLED`) →
(f) kill-switch snapshot (unreadable fails closed) →
(g) admission (budgets, capacity, load shedding; safety/human always admitted) →
(h) authoritative resource description under a timeout →
(i) relationships →
(j) OPA decision for every permission (deny by default) →
(k) tool-request idempotency (replay, key reuse, in progress, key required) →
(l) execution with timeout, per-dependency breaker and bounded retries (never for safety tools) →
(m) strict output (violation: read → PERMANENT_FAILURE, consequential → UNKNOWN_OUTCOME),
field mask, speech directive pre-check (fallback `fallback.safe_explanation`) →
(n) audit (`tool.invoke`, binding ref, evidence pointers; AUDIT_READ data is withheld when
the append fails) →
(o) strict `ToolResult` and metrics/logs (content-free).

## Commands

```
npx tsx src/gateway/generate-catalog.ts [--check]   # schemas/tools/catalog.json
npx tsx src/gateway/generate-openapi.ts [--check]   # schemas/openapi/gateway.openapi.json
```

(`platform/package.json` is not owned by this module; script aliases are an interface
change request.)

## Tests of note

* `../main/sessionless-routing.test.ts` — SAFE-02 end to end over the LOCAL container with
  the real business module: no, an expired and a revoked session, over the HTTP tool route
  and the real MCP SDK client on 127.0.0.1; both routing tools route to an allowlisted
  destination and are audited; every other catalogue tool fails closed with the session
  reason code and has no effect.

## Changes after wave 2

* Tool permissions: `get_appointment_options` → `appointment:list_options` (options carry
  the opaque `slotId`; `prepare_appointment_change` accepts an optional `slotId`),
  `prepare_billing_review` → `billing:prepare_review` (no proposal digest any more).
* `submit_complaint` output gains `linkedToAccount`; `create_support_request` resolves a
  representative's link to the represented subject (purpose `representative_access`);
  `get_provider_onboarding_status` uses the provider record's practice organization.
* `begin_verification` speaks the secure-link match code through the DRAFT template
  `verification.secure_link_match_code` (voice slot type `match_code`).
* The tool catalogue was regenerated (`TOOL_CATALOG_VERSION` `2026-10-18.2`).
* A denied invocation without a session records the transport call id in its `tool.invoke`
  audit event (evidence only, never authority).

## BLOCKED / UNKNOWN

* TB-01 session transport: which mode Talkdesk supports is UNKNOWN; local uses
  `trusted_header`. The server-to-server interaction lookup is a LOCAL FIXTURE
  (`BlockedInteractionLookup` outside local/ci, PRQ-013/PRQ-034).
* Inbound OAuth2: `JwtAccessTokenAuthenticator` is tested only against a local JWKS; issuer,
  audience, JWKS URI and client ids are UNKNOWN, and the committed configs carry no
  `gateway.inboundAuth` section, so no deployed environment starts.
* TB-03 OTP is disabled by default (`OTP_DISABLED_TB03`).
* TB-07 / TB-09 transfer events: Talkdesk's webhook authentication is not documented; only
  the LOCAL FIXTURE HMAC is accepted, and only in local/ci.
* Leases, the handoff index and the turn tracker are per process (a multi-task deployment
  needs a shared store).
