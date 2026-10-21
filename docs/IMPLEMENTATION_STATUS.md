# Implementation status

> **Current register: the follow-on gap ledger.** This file is the single-axis status record of the
> original offline slice. It stays in that vocabulary until WP-44 regenerates it per capability
> (ADR-0018 decision 7.4). The current two-axis register (software status, environment status,
> qualification, evidence and work package for every requirement) is
> [`followon/gap-ledger.yaml`](followon/gap-ledger.yaml), rendered as [`GAP_CLOSURE.md`](GAP_CLOSURE.md);
> both axes per capability are in [`followon/capabilities.yaml`](followon/capabilities.yaml), and missing
> external inputs are in [`ACTIVATION_REGISTER.md`](ACTIVATION_REGISTER.md). Where this file and the
> ledger differ, the ledger is current.

Checkpoint for handoff (spec "Progress and handoff"): what is implemented, how it was verified,
what is blocked and what comes next, so another session can continue without guessing.

**Overall release status: `IMPLEMENTED_OFFLINE` work in progress. Nothing is `VERIFIED_SANDBOX`,
`APPROVED_PILOT` or `VERIFIED_PRODUCTION`.** Mocked or fixture-backed integrations are not
production-ready, and code completion does not establish HIPAA compliance. Sections marked
*to be completed by coordinator after integration test run* are intentionally empty: results are
recorded only from actual runs ([`TEST_EVIDENCE.md`](TEST_EVIDENCE.md)), never anticipated.

## Status vocabulary

| Status | Meaning |
|---|---|
| `IMPLEMENTED_OFFLINE` | Implemented and tested against labelled local fixtures and synthetic data only |
| `VERIFIED_SANDBOX` | Verified against an approved vendor sandbox with synthetic records (requires approvals) |
| `APPROVED_PILOT` | Human approvals exist for a restricted pilot cohort |
| `VERIFIED_PRODUCTION` | Verified in production with reviewed evidence and named approvals |
| `BLOCKED` | Cannot proceed until a prerequisite exists (PRQ id given) |
| `NOT_RUN` | Implemented or specified, but the verifying test, drill or check has not been executed |

`BLOCKED`, `NOT_RUN`, `UNKNOWN` and missing evidence are never PASS (OPS-03).

## Module and area status

For each module: status, evidence (test command and result reference), blockers, next step.

### Protocol (`platform/src/protocol`, `schemas/protocol`)
*To be completed by coordinator after integration test run.*

### Database and migrations (`platform/src/db`, `platform/migrations`)
*To be completed by coordinator after integration test run.* Deployed Aurora: BLOCKED (PRQ-037).

### Observability (`platform/src/observability`)
*To be completed by coordinator after integration test run.* Metrics export: BLOCKED (PRQ-047).

### Configuration and production guard (`platform/src/config`)
*To be completed by coordinator after integration test run.* Trusted approval key: BLOCKED (PRQ-023).

### Resilience (`platform/src/resilience`)
*To be completed by coordinator after integration test run.*

### Operations controls: kill switches, budgets, admission (`platform/src/ops`)
*To be completed by coordinator after integration test run.* Budgets and rate cards: BLOCKED (PRQ-010).

### Policy (`platform/src/policy`, `policy/`)
*To be completed by coordinator after integration test run.* Bundle release: BLOCKED (PRQ-031).

### Identity (`platform/src/identity`)
*To be completed by coordinator after integration test run.* Real IdPs: BLOCKED (PRQ-005, PRQ-036). OTP fallback: BLOCKED (PRQ-015, PRQ-029).

### Actions ledger and outbox (`platform/src/actions`, `platform/src/outbox`)
*To be completed by coordinator after integration test run.* Provider idempotency semantics: UNKNOWN (PRQ-007).

### Audit (`platform/src/audit`)
*To be completed by coordinator after integration test run.* Live S3 Object Lock sink: BLOCKED (PRQ-037, PRQ-040).

### Vendor and business adapters (`platform/src/adapters`)
*To be completed by coordinator after integration test run.* Every live adapter: BLOCKED ([`vendor-integration-inventory.md`](vendor-integration-inventory.md)).

### Workflows and transfer (`platform/src/workflows`, `infra/stepfunctions`)
*To be completed by coordinator after integration test run.* Step Functions deployment: BLOCKED (PRQ-037).

### Safety and voice (`platform/src/safety`, `platform/src/voice`)
*To be completed by coordinator after integration test run.* Clinical scripts: BLOCKED (PRQ-008, PRQ-028). Before-speech control: UNKNOWN (PRQ-016).

### Knowledge, memory and retention (`platform/src/knowledge`, `platform/src/memory`, `platform/src/retention`)
*To be completed by coordinator after integration test run.* Approved corpus: BLOCKED (PRQ-032). Retention durations: BLOCKED (PRQ-025).

### Business services and resolution contracts (`platform/src/business`)
*To be completed by coordinator after integration test run.* Contract approvals: BLOCKED (PRQ-033).

### Gateway and MCP adapter (`platform/src/gateway`)
*To be completed by coordinator after integration test run.* Session binding mode: UNKNOWN until TB-01 (PRQ-013).

### Console API and console (`platform/src/console-api`, `console/`)
*To be completed by coordinator after integration test run.* Workforce SSO: BLOCKED (PRQ-036).

### Live composition root (`platform/src/main` live units, `platform/src/config/rules`, WP-07)
In this file's vocabulary: **IMPLEMENTED_OFFLINE** against local emulators only (SYNTHETIC data); on the two axes
of the gap ledger: software IMPLEMENTED or VERIFIED_LOCAL per requirement, environment NOT_CONFIGURED
([ADR-0023](adr/ADR-0023-live-composition-root.md)). sandbox, staging and production compose the gateway
(`server.ts` `startLiveServer`), worker (`worker/main.ts` `startLiveWorker`) and console (`live-console.ts`) from
real adapters through `buildLiveContainer`; the audit exporter (`audit-exporter.ts`) is its own unit with its own
AWS clients and database pool (it does not reuse the live container) and hands the guard the same inputs as the
other units; fixtures and development bypasses are refused; a missing tenant input disables only its capability
(activation map, `/health/ready`). With telephony a NOT_CONFIGURED guard port in this build, the safety and
human routing tools answer `ROUTE_UNAVAILABLE_USE_STUDIO_ROUTE` (the contact centre's own route), never a
claimed transfer; a worker outbox loop that cannot publish or consume is failing (counted, alarmed, readiness
503), never healthy. Evidence: `make test-integration SUITE=composition` (Layer-2 tests on
postgres:16, DynamoDB Local, ElasticMQ, LocalStack KMS and Secrets Manager, Keycloak 26 and a throwaway
OpenTelemetry Collector, including `[FAULT:AUTH_EXPIRY_MID_CALL]` and `[FAULT:DLQ_FULL]`; run record in
[`TEST_EVIDENCE.md`](TEST_EVIDENCE.md)); the audit exporter has unit tests only here (`src/main/audit-exporter.test.ts`). Not composed in this build (software
gaps with owning packages): business systems, caller identity directory, relationships, notifications, Talkdesk,
transfers, context store, models, media, harness and the ingress plugin. AWS account, tenant IdP, vendors and
telemetry export: NOT_CONFIGURED (AIN-01, AIN-12, AIN-13, AIN-36, AIN-37).

### Evaluation, demo and local start (`platform/src/evaluation`, `platform/src/demo`, `platform/src/main`, `scenarios/`)
Evaluation (scorer, corpus, generators, local driver), journeys, demo and load smoke: **IMPLEMENTED_OFFLINE**, evidence of 2026-10-18 in the four subsections below (scenario generators up to date: 549 scenarios, 522 risk drafts, all UNREVIEWED). Local start (`platform/src/main`): *to be completed by coordinator after integration test run.* PSTN tests: BLOCKED (PRQ-043).

### Evaluation — local conversation driver (`platform/src/evaluation/driver`)
**IMPLEMENTED_OFFLINE** (LOCAL FIXTURE — SYNTHETIC DATA — NOT PRODUCTION). `LocalConversationDriver`
runs every corpus scenario against a fresh `buildContainer({environment:"local"})` with the real
business module and real worker loops, over the public telephony-control, portal and tool/MCP
surfaces only. The conversational layer is the **LOCAL SIMULATED COORDINATOR** (deterministic
keyword rules; not a language model, not model evaluation). Evidence comes from authoritative
records (ledger rows, fixture effect logs, support requests and their Salesforce trace, transfer
journeys, `interaction_outcomes`, egress scans, IntegrityVerifier). Faults it cannot inject
(`REGIONAL_FAILOVER`, `REDACTION_FAILURE`) are refused, never simulated; `KNOWLEDGE_STALE` is
injected through the real knowledge service.

Evidence (2026-10-18, after the wave-3 fixes): driver tests 27 passed, 0 expected-fail. Full corpus
run `run_local_20261018w3_*` (ten shards): **2 711 runs, PASS 2 386, FAIL 305, INCONCLUSIVE 20**
(previous record before the fixes: 2 717 runs, PASS 835, FAIL 1 857, INCONCLUSIVE 25). Held-out
acceptance 533 runs (480 / 52 / 1). 7 CRITICAL FAIL runs: 6 after-commit fault gates on
slot_conflict drafts whose single confirmation hits a taken slot, so the fault point is never
reached, and 1 `gate.safety.required_handoff` on
`scn_appointment_cancel__indirect_or_ambiguous`, where the simulated coordinator could not interpret
the turns. No audit-gate failure (IntegrityVerifier findings in 0 of 2 711 runs). The other 298 FAIL
runs are task-level only (MAJOR): no approved hours / services article (143), borderline safety
over-routing awaiting PRQ-008 (75), coordinator limitations, corpus expectation decisions, and one
newly visible backend finding (out-of-order `CALLER_CONFIRMED_CONNECTED` dropped by
`platform/src/workflows/transfer.ts`). Local gate status: FAIL. Aggregate, root-cause attribution and
commands: [`TEST_EVIDENCE.md`](TEST_EVIDENCE.md#evaluation-local-conversation-driver),
`evidence/evaluation/corpus-local-20261018w3.{summary.json,report.md,root-causes.md}`. Vendor
sandbox and PSTN drivers: BLOCKED (PRQ-004, PRQ-034, PRQ-043); local results never satisfy sandbox,
staging or production gates.

### End-to-end journeys (`platform/test/journeys`)
**IMPLEMENTED_OFFLINE** (LOCAL FIXTURE composition, SYNTHETIC data). Ten test files drive the full
local container, console composition and worker loops over the real HTTP / MCP surfaces (J1 to J9,
injected faults, console retry, pre-disclosure recheck, outcomes without a live session). Evidence
(2026-10-18): `cd platform && npx vitest run test/journeys` inside the full platform run, 41 passed,
0 failed, 0 expected-fail (faults 9, outcomes 4, recheck 6, J2 5, J3/J4 4, J5/J7/J8 6, J6 2, J1 3,
J9 1, console retry 1). In the corpus run the 17 journey runs PASS 17 and the 28 faulted-journey runs
PASS 27 / FAIL 1 (`scn_journey_1_client_reschedule_conflict__auth_expiry_mid_call`, task outcome
TRANSFERRED vs expected DECLINED_BY_POLICY: an expectation conflict with the coordinator's
re-verification rule). Nothing here ran against Talkdesk, Salesforce, an IdP, AWS or a telephone
network.

### Demo (`platform/src/demo`)
**IMPLEMENTED_OFFLINE**. `pnpm demo` drives the nine journeys through the local driver and prints,
per step, the tool calls, every caller-heard line with its template id and approval status, and a
backend snapshot (assurance, ledger, support requests, workflows, transfer, audit count), framed by
the LOCAL FIXTURE badge. It writes `evidence/demo/<runId>.json` and exits non-zero if any journey
lacks backend evidence. Evidence (2026-10-18): exit 0, 9 of 9 journeys with backend evidence, scorer
PASS 9 (`evidence/demo/run_demo_iUkfzr-ZvIwdKkmY7uiGWqFJ.json`); `--faulted` exit 0, 21 of 21 with
backend evidence, PASS 20, FAIL 1 (the auth-expiry journey above;
`evidence/demo/run_demo_4tSfGzwe90rgZL-I1Cp8ZVbp.json`). Results: [`TEST_EVIDENCE.md`](TEST_EVIDENCE.md#demo).

### Load smoke (`platform/test/load`, `scripts/load`)
**IMPLEMENTED_OFFLINE** as a LOCAL LOOPBACK smoke only (PGlite single connection, NOT the
vendor/telephone path, NOT capacity evidence). autocannon drives a PUBLIC_READ and a PROTECTED_READ
tool on a 127.0.0.1 gateway listener; every response body is checked and the final audit state is
verified. Evidence (2026-10-18): smoke test 7 passed, 0 expected-fail; long run
`evidence/load/run_load_pIpldOT9sAHduHcGYIgLNJ3-.json` sustained 42.83 req/s (PUBLIC_READ) and
49.18 req/s (PROTECTED_READ) with zero errors, every success audited, shipper backlog 0 and the
IntegrityVerifier clean; repeat `evidence/load/run_load_LSJ9LDQB_eifhLTLXAqU1917.json` 46.70 and
47.94 req/s. The 400 req/s sustained target is **not met** locally (numbers in
[`TEST_EVIDENCE.md`](TEST_EVIDENCE.md#load-local-loopback-smoke)); quota and vendor-path load tests
remain BLOCKED (PRQ-022, PRQ-037).

### Infrastructure (`infra/terraform`)
*To be completed by coordinator after integration test run.* Apply in any account: BLOCKED (PRQ-037).

### Talkdesk package (`talkdesk/`)
*To be completed by coordinator after integration test run.* Tenant evidence: BLOCKED (PRQ-004, PRQ-034).

### Release pack (`docs/release/`)
*To be completed by coordinator after integration test run.* Approvals: BLOCKED (PRQ-024).

### Requirements traceability (`docs/requirements/`)
*To be completed by coordinator after integration test run.*

### Discovery and governance documentation pack (`docs/`, `scripts/capacity_model.py`, `platform/test/docs`)

| Item | Status | Evidence |
|---|---|---|
| Inventory ([`INVENTORY.md`](INVENTORY.md)) | IMPLEMENTED_OFFLINE | Snapshot 2026-10-17 |
| Prerequisite register ([`prerequisites.yaml`](prerequisites.yaml), [`PREREQUISITES.md`](PREREQUISITES.md)) | IMPLEMENTED_OFFLINE; every external record UNKNOWN or BLOCKED | `cd platform && npx vitest run test/docs` |
| ADRs ([`DECISIONS.md`](DECISIONS.md)) | IMPLEMENTED_OFFLINE (engineering); human approvals pending where stated | `platform/test/docs/docs-pack.test.ts` structure checks |
| Threat model and permission matrix ([`security/`](security/threat-model.md)) | Draft awaiting review (PRQ-003) | — |
| Data-flow inventory and retention matrix ([`privacy/`](privacy/data-flow-inventory.md)) | Draft awaiting review (PRQ-003, PRQ-025) | — |
| Capacity and cost model ([`capacity-cost-model.md`](capacity-cost-model.md)) | IMPLEMENTED_OFFLINE (illustrative only) | `python3 scripts/capacity_model.py` |
| Vendor integration inventory ([`vendor-integration-inventory.md`](vendor-integration-inventory.md)) | IMPLEMENTED_OFFLINE; integrations UNKNOWN/BLOCKED | — |
| Runbooks ([`RUNBOOKS/`](RUNBOOKS/README.md)) | Drafts; every drill NOT_RUN | — |

## Acceptance invariants

Enforcement locations are the design intent; status and evidence are filled from actual runs.

| Invariant | Enforcement location | Status | Evidence | Blocking prerequisites |
|---|---|---|---|---|
| AUTH-01 | `platform/src/identity`, `policy/` | *coordinator* | *coordinator* | PRQ-005, PRQ-029, PRQ-030 |
| AUTH-02 | `platform/src/gateway`, `platform/src/policy` | *coordinator* | *coordinator* | PRQ-013 |
| AUTH-03 | `platform/src/identity` (`SessionService`), gateway | *coordinator* | *coordinator* | PRQ-013 |
| AUTH-04 | `platform/src/identity` (expiry on read) | *coordinator* | *coordinator* | — |
| AUTH-05 | `policy/`, `RelationshipDirectory`, RLS | *coordinator* | *coordinator* | PRQ-005 |
| AUTH-06 | `platform/src/identity`, `platform/src/observability`, `platform/src/audit` | *coordinator* | *coordinator* | PRQ-015 |
| AUTH-07 | `SessionService.authGate`, `talkdesk/auth-gate.md` | *coordinator* | *coordinator* | PRQ-018 |
| DATA-01 | `platform/src/observability`, gateway field masks, config guard | *coordinator* | *coordinator* | PRQ-002, PRQ-047 |
| DATA-02 | Data-flow inventory; restricted QA media | *coordinator* | *coordinator* | PRQ-003 |
| DATA-03 | Consent state, retention module | *coordinator* | *coordinator* | PRQ-025, PRQ-026 |
| DATA-04 | `platform/src/memory` | *coordinator* | *coordinator* | — |
| ACT-01 | `platform/src/actions` | *coordinator* | *coordinator* | PRQ-014 |
| ACT-02 | `platform/src/actions`, `platform/src/outbox` | *coordinator* | *coordinator* | PRQ-007 |
| ACT-03 | `platform/src/actions` (reconciliation) | *coordinator* | *coordinator* | PRQ-007 |
| ACT-04 | `platform/src/workflows` (outcome mapping), business contracts | *coordinator* | *coordinator* | PRQ-033 |
| ACT-05 | `platform/src/voice` (`ResponseGate`) | *coordinator* | *coordinator* | PRQ-016 |
| SAFE-01 | `platform/src/safety`, templates | *coordinator* | *coordinator* | PRQ-008, PRQ-028 |
| SAFE-02 | `platform/src/safety`, admission exemptions | *coordinator* | *coordinator* | PRQ-017 |
| SAFE-03 | `platform/src/ops`, `platform/src/safety` | *coordinator* | *coordinator* | PRQ-017 |
| SAFE-04 | `platform/src/workflows` (`transfer.ts`) | *coordinator* | *coordinator* | PRQ-019 |
| SAFE-05 | `platform/src/config` (destinations), `TelephonyControl` | *coordinator* | *coordinator* | — |
| OPS-01 | `platform/src/audit` | *coordinator* | *coordinator* | PRQ-037, PRQ-040 |
| OPS-02 | Studio independent route, `platform/src/ops` | *coordinator* | *coordinator* | PRQ-009, PRQ-022, PRQ-049 |
| OPS-03 | Evaluation scorecard, audit completeness, prerequisite register | *coordinator* | `platform/test/docs` (register rules) | — |
| OPS-04 | `platform/src/config` (guard) | *coordinator* | *coordinator* | PRQ-023 |
| OPS-05 | Config guard, approvals, budgets | *coordinator* | *coordinator* | PRQ-010, PRQ-024 |
| OPS-06 | ReleaseManifest, pins | *coordinator* | *coordinator* | PRQ-020, PRQ-041, PRQ-042 |

## Reproducible commands

```bash
pnpm install --frozen-lockfile        # dependencies as locked (network: npm registry)
bash scripts/fetch-tools.sh           # pinned OPA and Terraform into .tools
pnpm typecheck && pnpm lint && pnpm test
cd platform && npx vitest run test/docs   # documentation pack data checks
python3 scripts/capacity_model.py         # illustrative capacity model (exit 0 = figures reproduced)
node docs/tools/render-prerequisites.mjs  # regenerate docs/PREREQUISITES.md after editing docs/prerequisites.yaml
```

Further commands per module: *to be completed by coordinator after integration test run.*

## Current versions

Toolchain and dependency versions: [`INVENTORY.md`](INVENTORY.md). Pinned model, voice, policy,
tool catalogue and knowledge versions: none pinned yet (PRQ-020, PRQ-031, PRQ-032, PRQ-045).

## Spend incurred

None. No billable execution has been authorised or performed.

## Next steps

1. Coordinator: run the integration test suite and fill the sections above from actual results.
2. Owners: work the smallest next actions in [`PREREQUISITES.md`](PREREQUISITES.md), starting with
   PRQ-003 review, PRQ-023 signing key and the Phase 2 approval requests (PRQ-024).
3. Engineering: continue unblocked offline work; do not simulate blocked capabilities as success.
