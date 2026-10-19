# Follow-on continuation state

Working state for the follow-on programme, kept current so a context reset or container restart does
not lose requirements (follow-on prompt section 21: "Maintain continuation state as you work").
It records what is being done and where; results live in the evidence and status documents.

## Source of truth

| Item | Location |
|---|---|
| Follow-on prompt (verbatim, 1 536 lines) | [`../spec/voice-support-followon-specification.txt`](../spec/voice-support-followon-specification.txt) |
| Original specification (verbatim) | [`../spec/voice-support-specification.txt`](../spec/voice-support-specification.txt) |
| Requirement extraction (machine-readable) | [`requirements.yaml`](requirements.yaml) (FO-* ids, mapped to the original ids) |
| Gap ledger | [`gap-ledger.yaml`](gap-ledger.yaml) and [`../GAP_CLOSURE.md`](../GAP_CLOSURE.md) |
| Work packages, dependencies, file ownership | [`work-packages.yaml`](work-packages.yaml) |

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
| A | Inventory, requirement extraction, gap ledger, architecture/threat/data-flow diagrams, decision record, implementation and activation registers | IN_PROGRESS |
| B | Scorer truth, invariant regressions, production composition, storage/session/workforce identity/audit, real transport adapter boundaries | NOT_STARTED (fix wave 5 already repairs part of the scorer and harness) |
| C | Live model adapters, controllable media (LiveKit/SIP), protected output, fallback audio, turn/session fencing, real local audio-to-action journey | NOT_STARTED |
| D | Historical/event/live context, entity linking, knowledge ingestion, deletions, model registry, specialist loops, canonical domain adapters | NOT_STARTED |
| E | Every workflow family, CRM/outbox sync, long-horizon work, secure companion, notifications, accepted human transfer | NOT_STARTED |
| F | Operator onboarding/studio/console, configuration publication, evidence views, eval platform, self-improvement | NOT_STARTED |
| G | Deterministic/contract/integration/security/audio/chaos checks; packaging, images, migrations/rollback, load/soak/DR jobs, release preflight, qualification | NOT_STARTED |
| H | Authorized external executions only if scoped authority exists; otherwise exact activation commands and qualification list | NOT_STARTED |

## In flight

* Fix wave 5 (started under the original specification, still valid): knowledge sanitizer residuals,
  transfer event ordering (verified FIXED), resolution metrics, audit/infra gaps, verification kill-switch
  wiring, evaluation generator/harness fixes. Final verification round running; then full gates.
* Draft PR #26 on branch `claude/spec-prompt-implementation-l9zicg` carries this work.
* Phase A workflow `followon-gap-ledger` (run `wf_6d1f0b41-abd`): requirement extraction + skeptic-checked
  gap ledger per prompt-section group (scratch: `followon/c1..c5.json` and `.challenge.json` in the session
  scratchpad), then planner (requirements.yaml, gap-ledger.yaml, work-packages.yaml, GAP_CLOSURE.md,
  ACTIVATION_REGISTER.md), architect (ARCHITECTURE.md target section, ADR-0018) and a completeness critic.
  If a container restart kills it, resume with the workflow script and `resumeFromRunId`.

## Decisions log (short; ADRs hold the reasoning)

* 2026-10-19: follow-on prompt adopted; committed verbatim under `docs/spec/`.
* 2026-10-19: Docker-based local composition is feasible in this environment and becomes the
  Layer-2 integration target (production adapters over real protocols against emulators).
