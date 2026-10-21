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
| B | Scorer truth, invariant regressions, production composition, storage/session/workforce identity/audit, real transport adapter boundaries | IN_PROGRESS: waves B1 (WP-02, WP-03), B2 (WP-01, WP-04, WP-06) and B3 (WP-05) DONE; next B4 (WP-07) |
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
| B2 | WP-01, WP-04, WP-06 | wf_786b1518-a8e (wave), wf_334c062a-d28 and wf_3801b69b-969 (residuals) | DONE 2026-10-20: all three ACCEPTED by the independent verifier (WP-01 and WP-06 after one residual round, WP-04 after two). Coordinator: local-driver test hand-off applied, FO-17-24 faultSource relabelled, sharp 0.35.5 and adm-zip 0.6.1 overrides (no high advisories left), fault-registry owner rule for VERIFIED_LOCAL rows. Ledger: 102 rows moved (MISSING 577, IMPLEMENTED 440, VERIFIED_LOCAL 153). Two container restarts during the residual run; resumed. |
| B3 | WP-05 | wf_2e7d9aef-a72 (wave script v2: two-lens verifier panel, acceptance and adversarial security/failure; a requirement keeps the lower verified status of the two) | DONE 2026-10-21: three wave rounds and two residual rounds (wf_f14adc5a-7f2, wf_7591c960-603, script followon-residuals-v2.js), each judged by both lenses; the last panel left only four test-truth items (fallback branches of the terminal-path closure, expiry versus the refresh-race exception, logout audit count) and a runbook step number, which the coordinator closed with tests that kill the named mutants. Design change in the second residual round, by coordinator direction: the custodian decision fails closed (every terminal path of a custodian's SSO session suspends the recovery identity unless the IdP gives a positive, recorded answer). Coordinator: console OpenAPI regenerated, WP-01 policy-fault.ts switched to the new decorateEvaluator seam, Keycloak fidelity findings recorded in deploy/local/README.md. Ledger: 27 rows (MISSING 562, IMPLEMENTED 438, VERIFIED_LOCAL 170); FO-14-52 stays IMPLEMENTED (the verifiers' last check) although the coordinator's final tests kill the mutants they named. |

B2 close-out (2026-10-20): every Layer-2 suite (_harness, substrate, ingress, connectors) 179/179 on two
timed runs (206 s and 184 s) and once more from a clean worktree of the pushed commit; CI's integration job
now runs every suite and fetches the pinned tools first (the substrate suite re-runs unit suites on
postgres:16, which build the policy bundle with the pinned OPA binary; without them a fresh checkout fails
`src/audit/monitor.test.ts` with POLICY_BUNDLE_NOT_LOADED). The coordinator's local gate run has the same
two steps (all suites, then all suites from a clean worktree). CI on 1255c8d: success.

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
  media dependency set, hand it to WP-10/WP-17 with the failing evidence. Done 2026-10-20 (B2 close-out): pnpm overrides
  sharp 0.35.5 and adm-zip 0.6.1 (both published more than 7 days earlier); `pnpm audit` reports no high or
  critical advisory (3 moderate: uuid, sprintf-js, no fixed sprintf-js release), check-deps passes, and
  sharp loads and runs a native operation through @livekit/agents.
* CI on 709125c failed one unit test that passed locally: the WP-02 registry test read
  `evidence/runs/**/results.jsonl`, which is gitignored local output (fixed in c344192: the test now
  generates the scorer's output over the committed corpus). The local gates now also run `make test-unit`
  in a clean worktree of the commit being pushed. Done after wave B2 (2026-10-20): the wave prompt now
  requires tests to pass on a fresh checkout (no gitignored or untracked state), allowlisted fixture
  credential shapes with a gitleaks check of changed files, and compact status reports; verifiers get a
  compact view of the reports (latest last, 60 000 characters) because B2's verifiers saw truncated
  status lists.
* 2026-10-20 00:17 UTC, at the owner's request: a point-in-time snapshot of the unverified wave B2 working
  tree was pushed to branch `claude/spec-prompt-implementation-l9zicg-wip-b2` (commit 8485153, no PR, CI
  does not run on it). It is not the verified result; the B2 close-out commit goes to the PR branch.
  gitleaks flags 10 false positives in it (SYNTHETIC client secrets and API keys in WP-06 connector
  tests, and the `family-split.v2` split-key version in WP-01): at close-out, rename the fixture values to
  the allowlisted `<prefix>_synth...` form or add a narrow allowlist, so CI's history scan stays clean.
* 2026-10-20 02:43 and 03:17 UTC: two container restarts killed the B2 residual-fix workflow; it was
  resumed with resumeFromRunId each time after `dockerd` and `make up`. The resume re-ran round-1
  verification for WP-01 and WP-04 against a tree that already held later fixes (prompt keys changed), so
  at close-out take the orphaned fix:WP-01-r2 report (journal key ending 04ce263d) into account. Killed
  verifiers mutate through vitest aliases and scratch copies, not in place (checked: no leftover mutants
  or backup files). The WIP snapshot branch was refreshed at 03:20 UTC (commit 57ed02f, gitleaks clean).

Open hand-offs from wave B2 (owners named; none is done by the package that raised it):

* WP-07 (composition): register the WP-04 ingress plugin; swap the process-local DeferredAuditQueue in
  container.ts for the durable queue; schedule the RouteAuditReconciler, InboxProcessor, StreamIngestor and
  purge loops; add the audit-exporter entry point; decide whether `reconcile_by_lookup` requires
  gatewayCredentials (fail closed) or is rate-limited at the WAF (WP-39). Compose the WP-06 connector runtime.
* WP-34 (evaluation driver): record requestedFault/reachedFault in EvaluationResult so the FO-17-24
  DUPLICATE_WEBHOOK and AUDIT_OUTAGE rows can be run; collect CallEvidence.reconciliations for
  ambiguous-outcome retries. The coordinator applied WP-01's patch to
  platform/src/evaluation/driver/local-driver.test.ts (outbox-path DUPLICATE_WEBHOOK is a driver self-report,
  so INCONCLUSIVE, not PASS).
* WP-05: a public seam for PolicyEvaluationFault (it decorates the engine's private evaluator today).
* Dependency set (phase C owner WP-17): @aws-sdk/client-kinesis and kafkajs plus compose services for the
  WP-04 stream ingestion emulator runs.
* Retention owner: register `inbound_raw_payloads` (INBOUND_RAW_REPLAY) under an approved duration (FO-07-22).
* WP-39: TTL or delete-on-drain for drained independent-journal items in DynamoDB.
* Plan edge: WP-04's substrate/support.ts and scripts/vsp/verify-audit.mts import WP-06's
  platform/src/connectors/http; a change to that transport API must run WP-04's Layer-2 suite.
* .github/gitleaks.toml owner: in `gitleaks dir` mode the AND-conditioned path allowlists act as file filters,
  so test fixtures are not scanned; only git mode (CI's) scans them.
* AIN-31 (human review keys): the corpus lock (corpus-lock.v4) and earlier relabels have no human
  ReviewRecord; ReviewRecord signatures are schema-checked only.

Open hand-offs from wave B3 (WP-05; scratch hand-off files in the session scratchpad waves/wp05r2/handoff,
summarised here so they survive the session):

* WP-07 (composition):
  * wire `consoleAuth`: membershipSource CLIENT_ROLES by default, and acceptedMfaAmr null for the default
    rule (`mfa`, or two distinct RFC 8176 factor classes);
  * call `workforceSsoGuardViolations` from the config guard;
  * add an edge rate limit on `/console/api/v1/auth/*`;
  * schedule `WorkforceSsoService.sweep`; each expiry closure makes one IdP introspection and one revocation;
  * compose `OidcHttp` with the same EgressGuard as its ConnectorHttpTransport (required). `OidcDiscovery`
    throws ConfigurationRejectedError at startup for a refused issuer;
  * compose PgRecoveryService with a logger and the recovery policy values;
  * apply the policy environment to OpaWasmPolicyEngine (container-policy-environment diff);
  * alert on `console.sso.terminal_closure_unaudited` and `console.sso.terminal_audit_unwritten`;
  * the workforce realm's http://localhost:5173 redirect cannot be allowlisted (https is required), so the
    local console needs an https origin or a separate local-only client.
* [FAULT:AUTH_EXPIRY_MID_CALL] (WP-07): drive SessionExpirySeam (platform/src/identity/expiry-seam.ts,
  local/ci only), documented in the identity README.
* WP-34/WP-42: register the AUTH_EXPIRY_IDLE and IDP_UNAVAILABLE Layer-2 results as EvaluationResult
  records (requestedFault/reachedFault); until then both FO-17-24 rows stay IMPLEMENTED.
* Retention owner: register console_sessions (kept at least holderSsoMaxAgeSeconds, 14 days, because
  recovery enrolment and activation read the custodian's latest positive IdP evidence from it),
  console_recovery_identities, console_recovery_activations and console_login_transactions.
* Privacy/egress owner: decide on treating canonical UUID path segments as opaque in
  urlCarriesSensitivePattern (tenant IdPs such as Entra use /<uuid>/v2.0 issuers; refused today with
  OIDC_EGRESS_REFUSED, fail closed); the proposed diff is in the hand-off directory.
* Business/identity owner: assertion-service.ts and business/handoff.ts treat A1 as verified outside the
  Rego A1 gate (A1 is reachable only through OTP, disabled by default).
* AIN-13 / AIN-15 (identity owner): tenant amr values (the caller-side DEFAULT_ACCEPTED_AMR still accepts a
  single possession value) and the availability cost of the fail-closed custodian rule: during a workforce
  IdP outage every custodian whose session ends is suspended CUSTODIAN_EVIDENCE_LOST until the IdP is back.
  A SCIM deprovisioning feed would close the remaining "disabled with no live session" window (today the
  14-day evidence window and the access review cover it).
* Audit owner and OPS-01: when a terminal path's audit events cannot be written, the protective closure
  (revocation and suspension) is applied without them, and the events are then appended on their own. If
  that append also fails, only the two error log events above record the closure.
* Recovery enrolment proof of possession is not hardware attested; only an attestation reference is stored.
* Policy tests: the console read role-set Rego test runs 144 decisions in 3-10 s under load. It needs the
  explicit per-test deadline in scripts/policy.sh (`--timeout 60s`, which CI uses); a bare `opa test` can hit
  the 5 s default.
* Migration 2050 was edited in place during the residual rounds. That is acceptable only because it has
  never been applied outside throwaway databases; from now on it changes only through new migrations.
