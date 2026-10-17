# Phase 0–5 promotion gates

Evidence, not a calendar date, decides promotion (spec sections 1 and 15). Status values:
`NOT_STARTED`, `IN_PROGRESS`, `BLOCKED` (external prerequisite missing), `EVIDENCED`
(evidence reference exists and was reviewed), `APPROVED` (human approval record exists).
Only humans move an item to `APPROVED`; missing evidence is never PASS (OPS-03). Status
below is a snapshot written with the Talkdesk package (2026-10-17) and is maintained by the
coordinator in the repository status documents.

Release status vocabulary: `IMPLEMENTED_OFFLINE` → `VERIFIED_SANDBOX` → `APPROVED_PILOT` →
`VERIFIED_PRODUCTION` (spec section 16). Current repository status: `IMPLEMENTED_OFFLINE`
work in progress; nothing is `VERIFIED_SANDBOX`.

## Phase 0 — discovery and evidence

| # | Gate item | Evidence pointer | Status |
|---|---|---|---|
| 0.1 | Repository inventory and prerequisite register | `docs/INVENTORY.md`, prerequisite register (coordinator) | IN_PROGRESS |
| 0.2 | Architecture decisions, data-flow and threat models | `docs/ARCHITECTURE.md`, ADRs (coordinator) | IN_PROGRESS |
| 0.3 | Permission matrix | policy module (`policy/`) | IN_PROGRESS |
| 0.4 | Vendor capability inventory without changing production settings | `talkdesk/capability-gate.md` (all UNKNOWN), `talkdesk/vendor-questions.md` (all UNANSWERED) | IN_PROGRESS |
| 0.5 | Traffic statistics and de-identified intent summaries via approved, rate-limited exports (Explore API reports verified individually, [S24]) | VQ-TD-36; export approval not yet requested | BLOCKED |
| 0.6 | Traffic and cost models | spec section 12 illustrative model; `docs/release/sandbox-cost-inputs.yaml` (method only) | IN_PROGRESS |
| 0.7 | Integration inventory and capability blockers | `talkdesk/README.md`, TB-01..TB-10 in `docs/ARCHITECTURE.md` | IN_PROGRESS |

Promotion to Phase 1: inventory, ADRs and prerequisite register reviewed. Synthetic fixtures
continue for every unavailable system.

## Phase 1 — complete offline slice

| # | Gate item | Evidence pointer | Status |
|---|---|---|---|
| 1.1 | One journey: unverified caller → secure mock authentication → authorised lookup → prepared and confirmed action → durable case → failed-dependency recovery → warm-transfer state machine → audit trace | demo journeys (`platform/src/demo`), `pnpm demo` | IN_PROGRESS |
| 1.2 | Real policy and business logic against labelled local adapters (not a mock returning success) | module tests tagged with requirement ids; `pnpm test` | IN_PROGRESS |
| 1.3 | Invariants AUTH/DATA/ACT/SAFE/OPS covered by tagged tests | requirement-to-test matrix (coordinator) | IN_PROGRESS |
| 1.4 | Talkdesk package internally consistent | `node talkdesk/tools/validate-package.mjs`, `node --test talkdesk/tools/package.test.mjs` | EVIDENCED (offline consistency only) |
| 1.5 | Production configuration rejects fixtures and missing approvals (OPS-04) | config module guard tests | IN_PROGRESS |

Promotion to Phase 2: offline slice tests pass; the sandbox plan and approval requests are
complete (this directory); approvals AR-01..AR-07, AR-10..AR-13, AR-15 granted.

## Phase 2 — sandbox integration

| # | Gate item | Evidence pointer | Status |
|---|---|---|---|
| 2.1 | Approvals granted for each external access / billable item | `approvals/` records for AR-01..AR-15 as applicable (`approval-requests.md`) | BLOCKED |
| 2.2 | Sandbox stack applied from a reviewed plan | plan digest; `sandbox-plan.md` §3 | BLOCKED |
| 2.3 | Adapters replaced by documented Talkdesk, Salesforce, IdP and business APIs (success and failure paths, synthetic records) | contract test results | BLOCKED |
| 2.4 | Reviewed Talkdesk configuration export or precise UI setup instructions | `talkdesk/studio-flow-spec.md`, `ai-agent-config.yaml`, `mcp-connection.md` (instructions exist; tenant export UNKNOWN, VQ-TD-37) | IN_PROGRESS |
| 2.5 | Versions pinned (agent, model, voice, prompts, tool catalogue, policy) | `ReleaseManifest`; CG-07 | BLOCKED |
| 2.6 | Successful telephone journey with synthetic personas | EvaluationResult `pstn_sandbox` | BLOCKED |
| 2.7 | Actual configuration reconciled against repository definitions (drift) | `node talkdesk/tools/drift-check.mjs` verdict CLEAN | BLOCKED |
| 2.8 | Capability gate CG-01..CG-10 each EVIDENCED or FAIL with consequence recorded | `talkdesk/capability-gate.md` | BLOCKED |
| 2.9 | Independent human route and safety branch proven with AI and gateway down | SF-T-15, SF-T-16, SF-T-18..SF-T-22 | BLOCKED |
| 2.10 | Spend within the approved ceiling; rollback rehearsed | vendor usage data; rollback evidence (`sandbox-plan.md` §10) | BLOCKED |

Promotion to Phase 3: all `sandbox-plan.md` §11 exit criteria met.

## Phase 3 — hardening and operational readiness

| # | Gate item | Evidence pointer | Status |
|---|---|---|---|
| 3.1 | All eligible intents; ≥ 50 reviewed intents × 8 variant families; ≥ 500 human-reviewed privacy/authorization/clinical-boundary/safety scenarios | `scenarios/`, scorecard | BLOCKED |
| 3.2 | Direct hostile gateway tests | gateway adversarial tests | IN_PROGRESS (offline) |
| 3.3 | Clinical-safety review and approved scripts | AR-12 successor for patient-facing use | BLOCKED |
| 3.4 | Language validation with native-speaker reviewers | QA/language leads | BLOCKED |
| 3.5 | Transfer and safety drills (receiver unavailable, dropped bridge) | drill evidence | BLOCKED |
| 3.6 | Independent security assessment and penetration test (backend and telephone journey); no unresolved critical finding | security report | BLOCKED |
| 3.7 | Quota tests per vendor dimension; sustained load (≥ 400 tool req/s illustrative target); cost measurement | CC-01..CC-03; load evidence | BLOCKED |
| 3.8 | Backup restore and regional recovery drills | recovery evidence | BLOCKED |
| 3.9 | AI-off route under realistic staffing assumptions; whole-Talkdesk outage continuity arrangement | VQ-OPS-01, outage exercise | BLOCKED |

## Phase 4 — restricted pilot

| # | Gate item | Evidence pointer | Status |
|---|---|---|---|
| 4.1 | Executed BAAs and service-specific coverage for every PHI processor | VQ-TD-46, VQ-SF-01, VQ-AWS-01, VQ-SPV-01 | BLOCKED |
| 4.2 | `PHI_PROCESSING`, `PILOT_EXPOSURE`, `PRODUCTION_DEPLOYMENT` approvals | `approvals/` | BLOCKED |
| 4.3 | Internal and consented callers first, then cohort at ~1 % → 5 → 10 → 25 → 50 % as evidence warrants; exposure also limited by calls per day | pilot plan | BLOCKED |
| 4.4 | Safety, accessibility, fraud and human-request exits available at every stage | SF-T-15..SF-T-22 in production configuration | BLOCKED |
| 4.5 | Review of all critical events and safety transfers plus a stratified routine sample | review log | BLOCKED |
| 4.6 | Containment on any critical privacy breach, unauthorised mutation, unsafe clinical response or failed safety handoff — immediately, not on a monthly average | incident playbooks | BLOCKED |

## Phase 5 — scale and continuous operation

| # | Gate item | Evidence pointer | Status |
|---|---|---|---|
| 5.1 | Endurance tests and real pilot evidence across peak periods | pilot reports | BLOCKED |
| 5.2 | Rehearsed rollback to known-good orchestration, tool catalogue, policy and schema; in-flight workflow version compatibility | rollback drill evidence | BLOCKED |
| 5.3 | Model, voice, prompt, knowledge, schema, vendor and policy changes each trigger the regression suite | CI gates | BLOCKED |
| 5.4 | No autonomous self-promotion or unreviewed production learning | release process | BLOCKED |

## Owners notified on a hard-gate failure

Clinical safety lead (safety routing), privacy counsel (disclosure, PHI exposure), security
leadership (authentication bypass, credential issues), support operations (human route),
finance (unexpected spend), Talkdesk administrator (tenant configuration). The coding agent
records evidence and stops the affected scenario family; it does not decide reporting
obligations.
