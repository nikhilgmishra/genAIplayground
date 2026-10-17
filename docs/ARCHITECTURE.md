# Architecture and engineering conventions

Status: **IMPLEMENTED_OFFLINE** scope only. Nothing here has been verified against a
vendor sandbox, a real telephone path or production. See `docs/IMPLEMENTATION_STATUS.md`.

## 1. System boundary

```
 PSTN caller ──► Talkdesk (numbers, Studio routing, queues, human legs)   ◄── independent human route (no AI/gateway dependency)
                   │  Studio deterministic steps (consent, DTMF capture, auth-gate fetch, confirmation capture)
                   │        └──► Telephony-control API  (service identity: telephony_control)
                   │  Autopilot Agentic / AI Agent Platform (untrusted conversational layer)
                   │        └──► MCP Streamable HTTP adapter (service identity: mcp_tools)
                   ▼
           ┌──────────────── AWS control plane (this repository) ─────────────────┐
           │ gateway (Fastify, ECS Fargate)                                       │
           │   transport auth → pinned catalogue → strict schema → session        │
           │   resolve (server-side) → kill switch/admission → OPA decision →     │
           │   business operation → output schema → field mask → audit → result  │
           │ identity  (DynamoDB sessions, secure-link/OIDC, OTP, assertions)      │
           │ actions   (Aurora ledger: prepare/confirm/commit/reconcile, outbox)   │
           │ audit     (in-tx durable outbox → S3 Object Lock in audit account)    │
           │ workflows (definitions → local executor | Step Functions Standard)   │
           │ knowledge (approved corpus, FTS + pgvector, permission-filtered)      │
           │ console API + React console (workforce SSO, RBAC, audited actions)    │
           └──────────────────────────────────────────────────────────────────────┘
                   │                     │                    │
             Salesforce Service     Scheduling / billing /   Client & provider IdPs (OIDC),
             Cloud (system of       claims / provider APIs   notification providers
             record for Cases)
```

The caller and everything the caller says are untrusted. So are retrieved
articles, tool-returned free text, transcripts and uploaded files. Talkdesk is a
trusted *service identity* plus an independently established call binding; it
holds no business-system credentials. The gateway reconstructs permissions from
server-side state on every request.

## 2. Repository layout

| Path | Responsibility |
|---|---|
| `platform/src/protocol` | Strict zod schemas for every protocol artifact; exported to `schemas/protocol/*.schema.json` |
| `platform/src/shared` | Clock, opaque ids, canonical JSON + digests, typed errors |
| `platform/src/db` | Database port; PGlite (offline, real PostgreSQL in WASM) and `pg` (Aurora) adapters; migrator |
| `platform/migrations` | Ordered SQL migrations incl. row-level security |
| `platform/src/observability` | Content-free logger, metrics with label allowlists, tracing helpers |
| `platform/src/config` | Typed configuration, production guard (OPS-04), approval-record loader |
| `platform/src/resilience` | Timeouts, bounded retry with jitter, circuit breaker, bulkhead |
| `platform/src/ops` | Kill switches, budgets, admission control |
| `platform/src/policy` + `/policy` | OPA Rego bundle, golden decision tests, WASM evaluation engine |
| `platform/src/identity` | KV store (DynamoDB + memory), sessions, verification, assertions, auth gate |
| `platform/src/actions`, `platform/src/outbox` | Action ledger, idempotency, commit protocol, reconciliation, transactional outbox |
| `platform/src/audit` | Audit writer, hash chain, health, shipper, sinks, integrity verification |
| `platform/src/adapters` | Vendor/business ports, LOCAL fixtures with fault injection, documented live adapters |
| `platform/src/workflows` | Workflow definitions, local durable executor, ASL generator, human tasks, transfer state machine |
| `platform/src/safety`, `platform/src/voice` | Safety signals + deterministic routing; templates, response gate, turn tracking, conversation guard |
| `platform/src/knowledge`, `platform/src/memory`, `platform/src/retention` | Knowledge ingestion/retrieval, provenance-labelled memory, retention/deletion jobs |
| `platform/src/business` | Resolution contracts and business services per workflow |
| `platform/src/gateway` | Tool pipeline, tool modules, MCP adapter, telephony-control and portal endpoints |
| `platform/src/console-api` | Console backend (workforce SSO, RBAC, audited admin actions) |
| `platform/src/evaluation` | Scenario runner, scorecard, release manifest builder |
| `platform/src/demo`, `platform/src/main` | Local demo journeys and local start command |
| `platform/src/fixtures` | SYNTHETIC world shared by all local adapters and tests |
| `console/` | React + TypeScript operations console |
| `scenarios/` | Scenario corpus (development and held-out acceptance splits) |
| `infra/terraform` | Terraform modules and per-environment stacks (plan only) |
| `talkdesk/` | Talkdesk Studio / AI Agent configuration specs and operator runbooks |
| `approvals/` | Human approval records (none exist; the coding agent cannot create them) |
| `docs/` | Status, prerequisites, decisions, traceability, evidence, runbooks |

## 3. Engineering conventions (binding for all modules)

1. **Strict schemas.** Every external input is parsed with a strict zod schema
   (`z.strictObject`), bounded in size, with enums for closed sets. Unknown fields fail.
2. **Opaque identifiers only.** `newId(prefix)`; never embed PHI in ids, workflow names,
   URLs, metric labels, log fields, alert text, resource names, trace baggage or errors.
3. **No PHI in logs.** Use `platform/src/observability` loggers only; `console.log` is
   lint-banned outside CLI/demo entry points. Error messages carry reason codes only.
4. **Fail closed.** Missing session, expired session, policy error, audit unavailability,
   unknown tool version or unexpected response field ⇒ deny / safe route. Never "best effort".
5. **Server-established identity.** Nothing in a tool argument can set actor, role,
   subject, organization, assurance, consent or scopes (AUTH-03).
6. **Fixtures are labelled.** Every adapter/store has `kind: "local_fixture" | "live"`.
   Fixture data comes from `platform/src/fixtures/synthetic-world.ts` and is marked
   SYNTHETIC. Production config rejects fixtures (OPS-04).
7. **Injectable time.** Use `Clock` (`FakeClock` in tests). No `Date.now()` in domain logic.
8. **Database access** goes through the `Db` port; runtime transactions use role
   `app_runtime` (RLS enforced) and set `rls.tenantId`. `owner` role is for migrations/fixtures.
9. **Migrations** are append-only files `NNNN_name.sql`, numbered by module range:
   0001 foundation · 01xx actions/outbox · 02xx audit · 03xx support records · 04xx workflows ·
   05xx knowledge · 06xx ops (kill switches, budgets, safety events) · 07xx memory ·
   08xx retention · 09xx console. A changed applied migration fails startup.
10. **Tests** live beside code as `*.test.ts` (vitest). Test titles carry requirement tags,
    e.g. `it("[AUTH-04] expired session fails closed before TTL cleanup", ...)`. The
    traceability generator scans these tags. Mocks/fixtures are named `*Fixture*` or live in
    `fixtures/` and are explicitly labelled in test names when relevant.
11. **No new dependencies** without recording version + license in `docs/INVENTORY.md`.
12. **Caller-facing text** comes only from approved templates with typed slots
    (`platform/src/voice`). Dependency free text is never spoken.
13. **Money** is integer minor units; times are ISO-8601 UTC strings with an explicit time zone
    field for presentation.

## 4. Request flow (tool call)

1. Transport authenticates the integration (OAuth2 client credentials in live; labelled
   local fixture tokens offline) → `IntegrationIdentity` with channel `mcp_tools`.
2. Tool name + version must exist in the pinned catalogue (digest pinned in ReleaseManifest).
3. Arguments validated against the tool's strict schema and byte bound.
4. Session reference taken from the trusted transport binding (see TB-01) and resolved to
   `AuthContext` from DynamoDB with expiry/revocation/generation/integration checks.
5. Kill switches and admission (budget, capacity) — safety and human-route tools are exempt.
6. Resource described from authoritative lookups; relationship facts from authoritative
   enrollment/delegation registries; OPA decision (deny by default).
7. Business operation with timeout, circuit breaker and bounded retries (no retry stacking).
8. Output validated against the tool's output schema (unexpected fields rejected); field mask
   from the policy decision applied.
9. Audit event appended durably (in the same transaction for consequential actions) before
   the result is returned.
10. `ToolResult` tagged with `turnId` + `sessionGeneration`; speech only as a `SpeechDirective`
    rendered by the response gate before any audio.

## 5. Unresolved trust-boundary capabilities (flagged)

| ID | Capability | Status | Consequence if unavailable |
|---|---|---|---|
| TB-01 | Talkdesk can pass the opaque session reference to MCP tools outside model-controlled arguments (header/context mapping) | UNKNOWN | Protected tools use `server_to_server_lookup` (verified interaction lookup) or stay BLOCKED; argument-supplied refs require an approved exception |
| TB-02 | Deterministic Studio/Skill step can capture confirmation (DTMF/affirmative) and call the telephony-control API | UNKNOWN | Consequential commits stay disabled for autonomous flow; human agent confirms |
| TB-03 | Isolated DTMF capture where digits reach neither ASR, model, recording nor transcript | UNKNOWN | OTP fallback disabled; secure link / portal / human verification only |
| TB-04 | Every protected utterance can be validated before audio emission | UNKNOWN | Protected classes use deterministic rendering path only; else the fallback speech runtime (ADR-0006) |
| TB-05 | Early safety signal available before guardrail refusal/termination, with deterministic handoff | UNKNOWN | Autonomous flow does not launch (spec section 2) |
| TB-06 | Auth Gate variable can be cleared on expiry and cannot be mutated by the model | UNKNOWN | Gate treated as UX only; gateway enforcement is authoritative regardless |
| TB-07 | Transfer events (receiver accepted, bridged, caller connected) exported to the gateway | UNKNOWN | Transfer success cannot be recorded; outcome stays OUTCOME_UNKNOWN and humans reconcile |
| TB-08 | Version identity of agent/model/voice/prompt in event exports | UNKNOWN | ReleaseManifest cannot bind vendor configuration; release BLOCKED |
| TB-09 | Webhook authentication mechanism documented by Talkdesk for event delivery | UNKNOWN | Webhook ingestion disabled; no invented signature protocol |
| TB-10 | Contracted concurrency / quotas for AI sessions, ASR/TTS, tools | UNKNOWN | Capacity gates BLOCKED |
