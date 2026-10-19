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
| B | Scorer truth, invariant regressions, production composition, storage/session/workforce identity/audit, real transport adapter boundaries | IN_PROGRESS: wave B1 (WP-02, WP-03) DONE; next B2 (WP-01, WP-04, WP-06), B3 (WP-05), B4 (WP-07) |
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
gates, fixes what the final verifier left (PARTIAL residuals), applies the statuses to
`docs/followon/source/` and regenerates the ledger (`python3 -I docs/tools/followon/generate.py`), then
commits and pushes. The applied software status is the verifier's `verifiedStatus`, never the
implementer's claim alone; evidence and gap come from the implementer's final report, and each row
records the move in `provenance.waveUpdates` (rendered in GAP_CLOSURE.md, "Implementation waves").
Waves follow the dependency order in `docs/followon/work-packages.yaml`.

| Wave | Packages | Run id | State |
|---|---|---|---|
| B1 | WP-02, WP-03 (+ ledger fix job) | wf_5abdf51f-ed0 | DONE: both PARTIAL after 3 rounds; the coordinator fixed the residuals (WP-02 snapshot watermark rules, party-URI refs, byte-size args, hand-over notes; WP-03 Step Functions Local TaskSubmitted race, missing-emulation-summary exit, digest pointer). Ledger: 56 rows moved (MISSING 613, IMPLEMENTED 450, VERIFIED_LOCAL 107). Layer-2 `_harness` 72/72 three times; workflow file 20/20 |
| B2 | WP-01, WP-04, WP-06 | wf_786b1518-a8e | RUNNING (launched 2026-10-19 16:05 UTC; resume with resumeFromRunId after a restart) |

B1 close-out gates (2026-10-19, local, all PASS): check-runtime, check-deps, lint, typecheck, make test-unit
(platform 3531/3531, console 107/107), contract/docs/journey projects, OPA policy tests, policy golden
gate, schema/catalogue/OpenAPI/resolution-contract/ASL/scenario drift checks, CI tooling tests, metric
names, workflow lint, Talkdesk package, prerequisite render, capacity model, follow-on generator --check,
Terraform check, Terraform policy test, offline-plan policy gate, gitleaks over git history (38 commits,
no leaks) and pnpm audit at the CI threshold (critical). Layer-2 `make test-integration SUITE=_harness`
72/72 three times. A gitleaks scan of the working tree flags the generated emulator credentials in
`.tools/vsp-local/` (gitignored, mode 0700, created by `make up`); that is expected and not committed.

Pending coordinator items (between waves, as owner of the workspace dependency set while WP-03's phase B
ownership is finished and no package holds it):

* `pnpm audit` reports 9 high and 6 moderate advisories, all transitive in the `media` workspace (adm-zip
  under onnxruntime-node, sharp under @livekit/agents and @huggingface/transformers) plus uuid and
  sprintf-js. Apply pnpm overrides to patched versions (sharp >= 0.35.5, adm-zip >= 0.6.1) between B2 and
  B3, re-run check-deps and the media smoke import, and record the result; if an override breaks the
  media dependency set, hand it to WP-10/WP-17 with the failing evidence.
* CI on 709125c failed one unit test that passed locally: the WP-02 registry test read
  `evidence/runs/**/results.jsonl`, which is gitignored local output (fixed in c344192: the test now
  generates the scorer's output over the committed corpus). The local gates now also run `make test-unit`
  in a clean worktree of the commit being pushed. After wave B2 completes (not while it runs, so a resume
  keeps its cache), add to the wave prompt: tests must pass on a fresh checkout and never read gitignored
  or untracked state (`evidence/runs`, `.tools/`, report directories).
