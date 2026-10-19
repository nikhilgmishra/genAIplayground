# Follow-on continuation state

Working state for the follow-on programme, kept current so a context reset or container restart does
not lose requirements (follow-on prompt section 21: "Maintain continuation state as you work").
It records what is being done and where; results live in the evidence and status documents.

## Source of truth

| Item | Location |
|---|---|
| Follow-on prompt (verbatim, 1 536 lines) | [`../spec/voice-support-followon-specification.txt`](../spec/voice-support-followon-specification.txt) |
| Original specification (verbatim) | [`../spec/voice-support-specification.txt`](../spec/voice-support-specification.txt) |
| Requirement extraction (machine-readable) | [`requirements.yaml`](requirements.yaml) (FO-* ids; `originalIds` resolve to [`../requirements/catalog.yaml`](../requirements/catalog.yaml), other references in `derivedFrom`) |
| Gap ledger (both status axes, qualification, evidence, work package per requirement) | [`gap-ledger.yaml`](gap-ledger.yaml); human rendering [`../GAP_CLOSURE.md`](../GAP_CLOSURE.md) |
| Capabilities (both status axes per capability) | [`capabilities.yaml`](capabilities.yaml) |
| Work packages, dependencies, file ownership | [`work-packages.yaml`](work-packages.yaml) |
| Activation register (AIN-NN external inputs) | [`activation-register.yaml`](activation-register.yaml); human rendering [`../ACTIVATION_REGISTER.md`](../ACTIVATION_REGISTER.md) |
| Sources of the files above (edit these, not the generated files) | [`source/`](source/) (requirement records per section, packages, activations, capabilities, narrative) |
| Generator and drift check | [`../tools/followon/generate.py`](../tools/followon/generate.py): `python3 -I docs/tools/followon/generate.py` writes, `--check` fails on drift |

Precedence (prompt section 0 and 22): the follow-on prompt supersedes the earlier preference to defer a
custom speech runtime and a bounded agent harness; the 27 invariant ids keep their meaning; the offline
slice becomes a regression environment, not the delivery endpoint.

## Status axes (prompt section 0)

* Software: `MISSING` / `IMPLEMENTED` / `VERIFIED_LOCAL` / `RELEASE_PACKAGE_VERIFIED`.
* Environment: `NOT_CONFIGURED` / `CONFIGURED` / `VERIFIED_SANDBOX` / `APPROVED_PILOT` / `VERIFIED_PRODUCTION`.
* Qualification: `NOT_RUN` / `FAIL` / `INCONCLUSIVE` / `PASS`, always with evidence.

Missing external inputs go to one activation register; they never block software work and never
become a code stub.

## Execution authority (unchanged)

Implement complete code and automation for paid calls, PHI access, notifications, live routing,
production mutation, releases and approvals, but leave their execution disabled until separately
scoped authority exists. No billable endpoint is invoked by a safe local default.

## Environment facts (probed 2026-10-19)

* Docker daemon can be started in the session container (`dockerd`); images pull from Docker Hub
  (postgres:16-alpine and livekit/livekit-server pulled). The daemon does not survive a container
  restart: start it again with `dockerd &`.
* Reachable: npm, PyPI, the Go module proxy, Hugging Face. Blocked: github.com release downloads.
* Node 22.22, Python 3.13, uv, Go, Java, ffmpeg, make are installed. 4 CPUs, 15 GB RAM, no GPU.
* Container restarts have happened mid-run twice; long workflows must checkpoint, and work is pushed
  as `[skip ci]` checkpoints on the branch between verified commits.

## Phase plan (prompt section 19)

| Phase | Scope | State |
|---|---|---|
| A | Inventory, requirement extraction, gap ledger, architecture/threat/data-flow diagrams, decision record, implementation and activation registers | DONE (commit bf25655; last minor/one material ledger fix runs with wave B1) |
| B | Scorer truth, invariant regressions, production composition, storage/session/workforce identity/audit, real transport adapter boundaries | IN_PROGRESS: wave B1 (WP-02, WP-03) running; then B2 (WP-01, WP-04, WP-06), B3 (WP-05), B4 (WP-07) |
| C | Live model adapters, controllable media (LiveKit/SIP), protected output, fallback audio, turn/session fencing, real local audio-to-action journey | NOT_STARTED |
| D | Historical/event/live context, entity linking, knowledge ingestion, deletions, model registry, specialist loops, canonical domain adapters | NOT_STARTED |
| E | Every workflow family, CRM/outbox sync, long-horizon work, secure companion, notifications, accepted human transfer | NOT_STARTED |
| F | Operator onboarding/studio/console, configuration publication, evidence views, eval platform, self-improvement | NOT_STARTED |
| G | Deterministic/contract/integration/security/audio/chaos checks; packaging, images, migrations/rollback, load/soak/DR jobs, release preflight, qualification | NOT_STARTED |
| H | Authorized external executions only if scoped authority exists; otherwise exact activation commands and qualification list | NOT_STARTED |

## In flight

* Draft PR #26 on branch `claude/spec-prompt-implementation-l9zicg` carries this work.
* Phase A workflow `followon-gap-ledger` (run `wf_6d1f0b41-abd`): requirement extraction + skeptic-checked
  gap ledger per prompt-section group (scratch: `followon/c1..c5.json` and `.challenge.json` in the session
  scratchpad), then planner (requirements.yaml, gap-ledger.yaml, work-packages.yaml, GAP_CLOSURE.md,
  ACTIVATION_REGISTER.md), architect (ARCHITECTURE.md target section, ADR-0018) and a completeness critic.
  If a container restart kills it, resume with the workflow script and `resumeFromRunId`.
  Result: 1,097 requirements, 45 work packages (WP-01..WP-45, phases B-H), 45 activation entries;
  the completeness critic found 18 material plan defects (VERIFIED_LOCAL overclaims, fault-matrix
  granularity, ownership holes, id collision ACT-NN vs invariants, no capability axis, no section 23
  rows, invariant sequencing, path inconsistencies, missing follow-on threat model).
* Phase A repair workflow `followon-phase-a-repair` (run `wf_2a6fcac4-05b`): regenerates the ledger
  and plan from a committed generator (docs/tools/followon/, --check), re-verifies every
  VERIFIED_LOCAL claim, renames activation ids to AIN-NN, adds capabilities.yaml, and fixes the
  architecture/ADR/threat-model/data-flow docs; the critic re-runs up to two more rounds.
* Fix wave 5 is merged on the branch (commit 8c0f5a0, CI green on PR #26).

## Decisions log (short; ADRs hold the reasoning)

* 2026-10-19: follow-on prompt adopted; committed verbatim under `docs/spec/`.
* 2026-10-19: Docker-based local composition is feasible in this environment and becomes the
  Layer-2 integration target (production adapters over real protocols against emulators).

## How waves run

Each wave runs the reusable workflow script
`/root/.claude/projects/-home-user-genAIplayground/f299c1b0-44d2-5934-b2f9-0f6e3fe0b812/workflows/scripts/followon-wave-wf_5abdf51f-ed0.js`
with `args = {wave, packages: [WP ids], extra: [optional extra jobs]}`: one implementer per package, an
independent adversarial verifier, up to two refix rounds. Between waves the coordinator runs the full
gates, applies the implementers' `statusUpdates` to `docs/followon/source/` and regenerates the ledger
(`python3 -I docs/tools/followon/generate.py`), commits and pushes. Waves follow the dependency order in
`docs/followon/work-packages.yaml`.

| Wave | Packages | Run id | State |
|---|---|---|---|
| B1 | WP-02, WP-03 (+ ledger fix job) | wf_5abdf51f-ed0 | RUNNING |
