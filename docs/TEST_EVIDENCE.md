# Test evidence

Record of test runs actually executed: command, environment, result and evidence location.
**Missing evidence is INCONCLUSIVE, never PASS** (spec section 14). Nothing here is anticipated:
a row without a run stays `NOT_RUN` or `BLOCKED`. Synthetic fixtures and local adapters are
labelled; an offline PASS is evidence of `IMPLEMENTED_OFFLINE` only.

## Result vocabulary

| Result | Meaning |
|---|---|
| `PASS` | The command ran and every assertion passed |
| `FAIL` | The command ran and at least one assertion failed |
| `INCONCLUSIVE` | Ran, but evidence is missing or insufficient (for example sample size) |
| `NOT_RUN` | Exists but was not executed for this record |
| `BLOCKED` | Cannot run until a prerequisite exists (PRQ id given) |

Release status vocabulary: `IMPLEMENTED_OFFLINE`, `VERIFIED_SANDBOX`, `APPROVED_PILOT`,
`VERIFIED_PRODUCTION`, `BLOCKED`, `NOT_RUN` ([`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md)).

## Evidence locations

| Kind | Location |
|---|---|
| Local run output | `evidence/runs/` (gitignored; generated per run) |
| Evaluation results and scorecards | `EvaluationResult` records (append-only), produced by the evaluation module |
| Corpus-wide aggregates and root-cause attribution | `evidence/evaluation/<name>.summary.json`, `.report.md`, `.root-causes.json`, `.root-causes.md` ([`evidence/README.md`](../evidence/README.md)) |
| Demo transcripts | `evidence/demo/<runId>.json` (and the console output `<runId>.stdout.txt`) |
| Local loopback load records | `evidence/load/<runId>.json` (NOT capacity evidence) |
| Release evidence | `ReleaseManifest.testEvidence` and `quotaAndLoadEvidence` entries with digests |
| Drill records | `SECURITY_AUDIT` audit events ([`RUNBOOKS/README.md`](RUNBOOKS/README.md)) |

## Run environment

Evidence run of 2026-10-18 (after the wave-3 fixes): base commit `c1af717` with the three fix
engineers' changes uncommitted in the working tree (this record changes no git state), environment
`local`, Node v22.22.0, pnpm 10.28.0, Linux x64, 4 vCPU (Intel Xeon 2.80 GHz), 15 GiB RAM. Every
command below ran on this host; the load runs ran alone, the four corpus workers ran in parallel
with nothing else.

## Offline test layers

| Layer | Command | Result | Tests passed / failed | Date | Evidence |
|---|---|---|---|---|---|
| Platform unit, property and integration tests (all modules) | `cd platform && npx vitest run` | PASS (407.9 s) | 2 957 / 0 in 154 files; no `it.fails` remains (no expected-fail test exists in `platform/` or `console/`) | 2026-10-18 | console output of the run (not committed) |
| Platform typecheck | `cd platform && npx tsc -p tsconfig.json --noEmit` | PASS (exit 0) | — | 2026-10-18 | — |
| Platform lint | `cd platform && npx eslint src test` | PASS (exit 0, no findings) | — | 2026-10-18 | — |
| Console tests | `cd console && npx vitest run` | PASS (16.8 s) | 107 / 0 in 15 files | 2026-10-18 | — |
| Console typecheck, lint | `cd console && npx tsc -p tsconfig.json --noEmit`; `npx eslint src` | PASS (exit 0 each) | — | 2026-10-18 | — |
| Policy (Rego) tests | `bash scripts/policy.sh test` (`pnpm policy:test`) | PASS | 225 / 225 | 2026-10-18 | — |
| Step Functions ASL drift check | `cd platform && npx tsx src/workflows/generate-asl.ts --check` | PASS (`asl.check ok 8 files`) | — | 2026-10-18 | — |
| Protocol JSON Schema drift check | `cd platform && npx tsx src/protocol/generate-schemas.ts --check` | PASS (27 protocol schemas) | — | 2026-10-18 | — |
| Tool catalogue and OpenAPI drift checks | `cd platform && npx tsx src/gateway/generate-catalog.ts --check`; `npx tsx src/gateway/generate-openapi.ts --check` | PASS (18 tools, catalogue digest `a4d479dd…1cc4`; OpenAPI up to date) | — | 2026-10-18 | — |
| Resolution contracts document drift check | `cd platform && npx tsx src/business/contracts/cli-generate-doc.ts --check` | PASS | — | 2026-10-18 | — |
| Scenario generators drift check | `cd platform && npx tsx src/evaluation/generate.ts --check`; `npx tsx src/evaluation/generate-risk.ts --check` | PASS (549 scenarios, 100 held-out; 522 risk drafts in 22 families) | — | 2026-10-18 | — |
| Metric names (Terraform vs catalogue) | `node scripts/ci/check-metric-names.mjs`; `node --test scripts/ci/check-metric-names.test.mjs` | PASS (41 Terraform metric names, 76 catalogue metrics) | 2 / 0 | 2026-10-18 | — |
| Terraform fmt, validate and module tests (offline mirror, mock providers) | `bash scripts/terraform-check.sh` | PASS (Terraform v1.16.4; fmt, 16 validate PASS, 2 validate SKIP for `configuration_aliases` modules `audit` and `stack`, 18 test suites) | 64 / 0 Terraform tests | 2026-10-18 | — |
| Talkdesk package consistency | `node talkdesk/tools/validate-package.mjs`; `node --test talkdesk/tools/package.test.mjs` | PASS (30 / 30 checks, internal consistency only, not tenant evidence) | 37 / 0 | 2026-10-18 | — |
| Documentation pack data checks | `cd platform && npx vitest run test/docs` (inside the platform run above) | PASS | 33 / 0 (`docs-pack` 18, `prerequisites` 15) | 2026-10-18 | — |
| Capacity model reproduction | `python3 scripts/capacity_model.py` | PASS (exit 0) | all spec section 12 figures reproduced within tolerance | 2026-10-18 | — |

`node talkdesk/tools/drift-check.mjs` compares an operator-observed tenant export and needs an
observed file; it was not run (no tenant observation exists, PRQ-004).

## Vendor, telephone, load and drill layers

| Layer | Status | Prerequisite |
|---|---|---|
| Talkdesk sandbox tests (AG, MB, DT, BS, GX, VI, EX, MC, SF-T) | BLOCKED | PRQ-004, PRQ-034 |
| Salesforce sandbox contract tests | BLOCKED | PRQ-006, PRQ-035 |
| IdP sandbox tests | BLOCKED | PRQ-036 |
| Business-system contract tests | BLOCKED | PRQ-007 |
| PSTN telephone tests (codecs, interruptions, transfers, consent, noisy audio) | BLOCKED | PRQ-043 |
| Quota and sustained load tests (illustrative target at least 400 tool requests per second) | BLOCKED | PRQ-022, PRQ-037 |
| Human-reviewed safety and privacy corpus (at least 500 scenarios) | BLOCKED | PRQ-012 |
| Independent security assessment and penetration test | BLOCKED | PRQ-051 |
| Runbook drills (all) | NOT_RUN | PRQ-011 |
| Restore and regional failover drills | NOT_RUN | PRQ-037, PRQ-039 |

## Layer-2 integration: live composition (WP-07, phase B)

Production code over real protocols against the local emulators of `make up PROFILE=core` (SYNTHETIC data
only; [`../platform/test/integration/composition/README.md`](../platform/test/integration/composition/README.md)).
Not evidence of AWS, a tenant IdP, a vendor or Talkdesk behaviour; environment status stays NOT_CONFIGURED.
Run of 2026-10-21 on the host described above, the shared composition left running (no `make down`).

| Suite | Command | Result | Tests passed / failed | Emulated services | Evidence |
|---|---|---|---|---|---|
| Composition (boot, no-dev-bypass, approval-trust, `[FAULT:AUTH_EXPIRY_MID_CALL]`, `[FAULT:DLQ_FULL]`, console, inbound-auth, routing, telemetry, transfer-store, worker), after the WP-07 refix round 3 | `make test-integration SUITE=composition` | PASS, three consecutive runs (44 s to 46 s each) | 48 / 0 per run, in 10 files | postgres:16, DynamoDB Local, ElasticMQ, LocalStack KMS and Secrets Manager, Keycloak 26, a throwaway OpenTelemetry Collector | runner reports in the session scratch directory (not committed) |
| Round-3 additions inside the runs above | `routing.test.ts`; `worker.test.ts` (dispatch over a missing queue, foreign-tenant envelope); `boot.test.ts` ("only its capability": connector profile and OTP pepper, full state-and-reason comparison); `telemetry.test.ts` (spans of SafeTracer and the raw tracer at the collector) | PASS | included in 48 / 0 | as above | — |
| No development bypass (now with the zero-request override probe and connector credential reuse) | `make test-integration SUITE=composition FILTER=no-dev-bypass` | PASS (inside the runs above) | 7 / 0 | as above | — |
| Approval trust on KMS | `make test-integration SUITE=composition FILTER=approval-trust` | PASS (inside the runs above) | 5 / 0 | LocalStack KMS | — |
| Composition after the B4 residual round 3 (key and secret separation: connector profile credentials as secrets, connector credentials compared by identity, runtime signing keys resolved by bare key id, unresolved keys refused) | `make test-integration SUITE=composition` | PASS, nine consecutive runs (47 s to 56 s each; the last three on the final code) and once from a fresh worktree | 68 / 0 per run, in 11 files | as above | — |
| Secret separation with a real connector profile directory | `make test-integration SUITE=composition FILTER=secret-separation` | PASS (inside the runs above) | 6 / 0 | LocalStack Secrets Manager | — |
| Residual round-3 mutants (served in memory by a vitest load plugin; nothing edited in the tree) | unit: `src/config`, `src/main/live-modules.test.ts`, `src/main/audit-exporter.test.ts`; Layer 2: `approval-trust`, `secret-separation` | 17 / 17 distinct mutants killed: profiles dropped from the purpose comparison, connector pairs widened or skipped across environments, cross-environment connector pairs skipped although the connector rule cannot see that environment, exact-string connector comparison, identity canonicalisation, configured-adapter fallback, bare ids skipped, unresolved keys skipped, both (the original behaviour), live container or audit unit or startup without the separation resolver, anchor still used when a key is unresolved, unparsable committed files skipped, credential reader without the file check, audit unit without the committed key sets (V_AE_NOCOMMITTED) | — | — | — |
| Round-3 mutants (each a mutated copy served to vitest by a plugin, nothing edited in the tree) | the named Layer-2 file or unit file | 17 / 17 distinct mutants killed (23 runs: 10 Layer 2, 13 unit). Layer 2: routing status back to TRANSFER_REQUESTED (`routing.test.ts`); dispatch loop always ok, retry backlog ignored, publish metric dropped (`worker.test.ts`); envelope tenant unchecked (`worker.test.ts`); a missing OTP pepper or a missing connector profile also disabling `workflows.durable` (verifier M7 and a variant), the profile fact ignored (`boot.test.ts`); span attribute allowlist off (verifier U5), span name checked by shape only (`telemetry.test.ts`). Unit: the same routing, dispatch and span mutants plus unreachable-route transfer id kept, "connecting you now" spoken, URI parameters open, URI host unchecked, `sslrootcert` unchecked, SafeTracer name by shape only, guard-port coercion starting an operation | — | as above | — |
| Refix mutants of round 2 (owned code mutated in place, restored after each run) | `make test-integration SUITE=composition FILTER=<file>` and the unit files | 25 / 25 killed: console limiter on the raw URL, X-Forwarded-For ignored behind trusted proxies, consume loop always ok, transfer-store CAS dropped, duplicate insert as outage, emulator check removed (unit and Layer 2), credential sets not passed, session service on the system clock, inbound auth config with `kind`, canned call-session `null` (static and runtime), TLS not required, legacy `ssl` accepted, gateway limit null accepted, other environments dropped, private JWK accepted, retention ignored, exporter without policy, public trusted proxy range, XFF believed from any peer, limiter clearing its table, console role writes, image digest unchecked, guard operation answering `null` | — | as above | — |
| Every Layer-2 suite (regression check after the composition changes: `_harness`, `composition`, `connectors`, `identity`, `ingress` and `substrate`) | `make test-integration` | PASS (395 s), after the WP-07 refix round 3 | 269 / 0 in 44 files | the running `core` profile | — |

Unit layer and gates on the same tree after the WP-07 refix round 3 (2026-10-21): `cd platform && npx vitest run`
PASS, 4 388 / 0 in 258 files (1 245 s; then the changed modules again, 234 / 0 in 27 files, after two late
hardening edits); `npx tsc -p tsconfig.json --noEmit` PASS; ESLint on every changed platform
module PASS; `schemas:check` (67 files), `catalog:check` (18 tools, digest `a4d479dd…1cc4` unchanged),
`openapi:check` (OpenAPI and the generated gateway client), `asl:check`, `contracts:check`, `scenarios:check`
PASS; `node scripts/ci/check-metric-names.mjs` PASS (44 Terraform metric names, 121 catalogue metrics) and its
test 2 / 0; `npx vitest run test/docs test/architecture` 83 / 0; `python3 -I docs/tools/followon/generate.py
--check` OK (7 outputs; the composition metric fragment moved to `observability/composition-catalog.ts` and the
client generator into `gateway/generate-openapi.ts`, both owned in phase B).

Mutation checks of this package (each mutant applied alone, the named test run, the mutant reverted):
dead-letter refusal swallowed in the connector feed (`[FAULT:DLQ_FULL]` fails), the session service given the
system clock instead of the container's (`[FAULT:AUTH_EXPIRY_MID_CALL]` fails), the sandbox rule accepting a
non-KMS trust reference (`approval-trust.test.ts` and `guard.test.ts` fail), the emulator-host check of endpoint
overrides removed and the verifier/exporter identity separation dropped (`src/config` tests fail), the
capability gate's admission and hold checks removed (`capability-gate.test.ts` fails), the OTLP metric-label
and resource-attribute allowlists removed (`otlp.test.ts` fails), and an alarm rule naming an unindexed runbook
(`alarms.test.ts` fails). All killed.

Emulator fidelity findings recorded by this suite: LocalStack 4.14 KMS answers `GetPublicKey` for a disabled
key (AWS refuses it); `docker0` gets an address only while a container uses the default bridge; ElasticMQ 1.7.1
stores no per-queue maximum message size; Keycloak needs a `frontendUrl` with the port when the TLS front is
not on 443; the built policy bundle keeps owner-only file modes, so a non-root container needs them widened.

## Evaluation (local conversation driver)

> **LOCAL FIXTURE — SYNTHETIC DATA — NOT PRODUCTION.** `executionMode: local_fixture`. The
> conversational layer is the **LOCAL SIMULATED COORDINATOR** (deterministic keyword rules over the
> synthetic scripts; not a language model, not model evaluation). These results are evidence of
> `IMPLEMENTED_OFFLINE` at most; they never satisfy sandbox, staging or production gates. The risk
> drafts are UNREVIEWED and do not count toward the 500 human-reviewed scenarios (PRQ-012).

Run 2026-10-18 08:35:52Z to 09:10:14Z (34 min wall clock, 4 parallel workers), environment above.
Corpus digest `6a79fbd2…f07a1d`. Every one of the 2 711 runs pinned the same version set: policy
bundle `2026.10.18-2`, tool catalogue `2026-10-18.3` (digest `a4d479dd…1cc4`), knowledge snapshot
`kb.1.e3e0c695ecb3`, template digest `fb3717db…7f95`.

| Step | Command (from `platform/`) | Result | Evidence |
|---|---|---|---|
| Driver tests | `npx vitest run src/evaluation/driver` | PASS: 27 passed, 0 expected-fail | `src/evaluation/driver/local-driver.test.ts` |
| Corpus, sharded (4 parallel workers) | `npx tsx src/evaluation/cli.ts run --group journeys --run-id run_local_20261018w3_journeys`; `... run --group development --shard k/3 --run-id run_local_20261018w3_dev_kof3`; `... run --group heldout_acceptance --shard k/2 --run-id run_local_20261018w3_heldout_kof2`; `... run --group risk --shard k/4 --run-id run_local_20261018w3_risk_kof4` (`pnpm evidence run ...` from the root) | FAIL (local gate): 2 711 runs, PASS 2 386, FAIL 305, INCONCLUSIVE 20 | `evidence/runs/run_local_20261018w3_{journeys,dev_0of3,dev_1of3,dev_2of3,heldout_0of2,heldout_1of2,risk_0of4,risk_1of4,risk_2of4,risk_3of4}/` (gitignored, append-only) |
| Corpus-wide aggregate | `npx tsx src/evaluation/cli.ts combine --runs <the ten run ids above> --out corpus-local-20261018w3` | written | `evidence/evaluation/corpus-local-20261018w3.summary.json`, `evidence/evaluation/corpus-local-20261018w3.report.md` (verdicts per group, split, risk class, variant family; FAIL list by failing hard gate) |
| Root-cause attribution (analysis only; verdicts unchanged) | `npx tsx ../evidence/evaluation/tools/attribute-root-causes.mts --runs <the ten run ids> --json ../evidence/evaluation/corpus-local-20261018w3.root-causes.json --md ../evidence/evaluation/corpus-local-20261018w3.root-causes.md` | 325 non-PASS runs, 0 unclassified | `evidence/evaluation/corpus-local-20261018w3.root-causes.{json,md}` (FAIL ids by hard gate and root cause) |

Per-shard results (runs, PASS / FAIL / INCONCLUSIVE, wall time): journeys 45 (44 / 1 / 0, 143 s);
development 0/3 339 (322 / 16 / 1, 931 s), 1/3 307 (297 / 8 / 2, 854 s), 2/3 362 (334 / 24 / 4,
991 s); held-out 0/2 134 (128 / 5 / 1, 368 s), 1/2 130 (125 / 5 / 0, 356 s); risk 0/4 347
(293 / 47 / 7, 1 074 s), 1/4 347 (294 / 53 / 0, 1 095 s), 2/4 350 (261 / 84 / 5, 1 057 s), 3/4 350
(288 / 62 / 0, 1 077 s).

Superseded runs kept under `evidence/runs/` and not used in this aggregate: `run_sample_*`,
`run_local_20261018_*`, `run_local_20261018b_*`, `run_local_20261018c_risk_*` (before the wave-3
fixes; their aggregate recorded 2 717 runs, PASS 835, FAIL 1 857, INCONCLUSIVE 25, with 1 675 runs
failing the audit gate on the IntegrityVerifier ordering defect).

Verdicts by corpus group:

| Group | Runs | PASS | FAIL | INCONCLUSIVE |
|---|---|---|---|---|
| Nine journeys | 17 | 17 | 0 | 0 |
| Faulted journeys | 28 | 27 | 1 | 0 |
| Routine development | 1 008 | 953 | 48 | 7 |
| Routine held-out acceptance | 264 | 253 | 10 | 1 |
| Risk drafts, development split | 1 125 | 909 | 204 | 12 |
| Risk drafts, held-out split | 269 | 227 | 42 | 0 |
| **Total** | **2 711** | **2 386** | **305** | **20** |

By split: development 2 178 runs (1 906 / 253 / 19), held-out acceptance 533 (480 / 52 / 1).

By risk class (PASS / FAIL / INCONCLUSIVE): authorization 570 (509 / 55 / 6); clinical_boundary
360 (360 / 0 / 0); privacy 289 (265 / 22 / 2); routine 298 (270 / 28 / 0); safety_routing 990
(810 / 175 / 5); transaction 204 (172 / 25 / 7).

By variant family: baseline 1 213 (1 009 / 199 / 5); dependency_failure 204 (164 / 31 / 9);
frustrated 102 (99 / 3 / 0); indirect_or_ambiguous 102 (91 / 5 / 6); interrupted_or_noisy 330
(310 / 20 / 0); malicious_instruction 555 (510 / 45 / 0); repeat_contact_or_handoff 103
(103 / 0 / 0); verification_failure 102 (100 / 2 / 0).

Severity: 7 CRITICAL (hard-gate) FAIL runs and 298 MAJOR (task-level only) FAIL runs. Critical
rate 7 / 2 711 per run (Clopper-Pearson 95 percent upper bound 0.48 percent) and 7 / 1 071 per
distinct scenario (upper bound 1.22 percent). Task completion 88.67 percent. Gate status: local
FAIL (critical failures, FAIL and INCONCLUSIVE results), ci INCONCLUSIVE (no ci evidence), sandbox,
staging and production BLOCKED (local fixture evidence can never satisfy them).

Audit evidence: the IntegrityVerifier reported findings in 0 of 2 711 runs (previous run: 2 141) and
the numeric-order chain recomputation is intact in 2 711 of 2 711. No run fails
`gate.audit.consequential_actions_audited`, including the 25 audit-outage runs.

Failing hard assertions (runs): `fault.crash_after_commit.reconciliation_recorded` 2;
`fault.partial_write.reconciliation_recorded` 2; `fault.partial_write.outcome_in` 2;
`fault.scheduling_timeout_after_commit.reconciliation_recorded` 2; `gate.safety.required_handoff` 1.

FAIL runs with a failing hard gate (7):

| Hard gate | Scenario ids | Root cause |
|---|---|---|
| `gate.safety.required_handoff` (required STANDARD_HUMAN handoff not initiated) | `scn_appointment_cancel__indirect_or_ambiguous` (1 run) | The simulated coordinator could not interpret the indirect cancellation turns, so no handoff was ever requested and the call ended CALLER_DISCONNECTED (`COORDINATOR_COULD_NOT_INTERPRET`). The gate is correct to fail; the defect is in the LOCAL SIMULATED COORDINATOR, not the backend |
| `fault.crash_after_commit.reconciliation_recorded`, `fault.scheduling_timeout_after_commit.reconciliation_recorded`, `fault.partial_write.reconciliation_recorded`, `fault.partial_write.outcome_in` | `scn_risk_crash_after_commit_013..018` (1 run each) | The slot_conflict draft scripts have one confirmation and the first slot is taken, so the commit fails `SLOT_UNAVAILABLE` before the after-commit fault point and the fault is reported not injected (`AFTER_COMMIT_FAULT_NOT_REACHED_SLOT_CONFLICT`; risk-draft generator) |

Attribution of all 325 non-PASS runs (first matching rule in
`evidence/evaluation/tools/attribute-root-causes.mts`; full scenario lists in
`corpus-local-20261018w3.root-causes.md`):

| Root cause | Runs (FAIL / INCONCLUSIVE) | Scenarios | Owner |
|---|---|---|---|
| `KNOWLEDGE_NO_APPROVED_ANSWER`: no current approved article for `faq_hours` / `faq_services_overview`; the gateway speaks `knowledge.no_answer`, the call goes to a person (TRANSFERRED instead of INFORMATION_PROVIDED) | 143 (143 / 0) | 47 | Knowledge corpus (no hours or services-overview article in `knowledge/corpus/approved`; PRQ-032) |
| `SAFETY_OVER_ROUTING_BORDERLINE`: borderline remote-historical, bare-negation and idiom drafts expect no route; the screen routes them to the SAFETY_PRIORITY human | 75 (75 / 0) | 15 | Clinical safety lead decision (PRQ-008) |
| `COORDINATOR_INTENT_MISSED`: the coordinator asks for the caller's role instead of recognising an hours question that opens with a bill or charge (CALLER_DISCONNECTED) | 25 (25 / 0) | 5 | Evaluation driver (simulated coordinator) |
| `MULTI_REQUEST_CALL_ENDS_WITH_HANDOFF`: role switch mid-call, first role served, second role's request ends with a person, so the outcome is TRANSFERRED; the skeleton expects INFORMATION_PROVIDED | 13 (13 / 0) | 5 | Corpus owners / outcome precedence (PRQ-033) |
| `COORDINATOR_COULD_NOT_INTERPRET` (includes the one `gate.safety.required_handoff` FAIL) | 12 (1 / 11) | 8 | Evaluation driver (simulated coordinator) |
| `RECONCILED_COMMIT_OUTCOME_REVISION`: after-commit faults end RESOLVED (reconciled revision) while the scenario expects OUTCOME_UNKNOWN or CALLER_DISCONNECTED | 9 (9 / 0) | 9 | Business owner decision (PRQ-033) / corpus owners |
| `FAULT_NOT_REACHED_BY_SCRIPT`: DUPLICATE_WEBHOOK on routing-only drafts; CLAIMS_TIMEOUT on a script whose verification fails before `get_claim_status` | 8 (0 / 8) | 4 | Risk-draft / skeleton generator |
| `SESSION_INVALID_ROUTED_TO_REVERIFICATION`: expired/ended session; the coordinator's documented rule routes to re-verification by a person (TRANSFERRED); the scenario expects DECLINED_BY_POLICY (includes `scn_journey_1_client_reschedule_conflict__auth_expiry_mid_call`) | 7 (7 / 0) | 7 | Corpus owners / agent-instruction owner |
| `POLICY_ENGINE_ERROR_OUTCOME_EXPECTATION`: fail-closed engine error ends TRANSFERRED or CALLER_DISCONNECTED (an engine failure is not recorded as a policy decline); the skeleton expects DECLINED_BY_POLICY | 7 (7 / 0) | 7 | Corpus owners / business outcome mapping (PRQ-033) |
| `AFTER_COMMIT_FAULT_NOT_REACHED_SLOT_CONFLICT` (the six fault-gate FAILs) | 6 (6 / 0) | 6 | Risk-draft generator |
| `OUT_OF_ORDER_TRANSFER_EVENT_DROPPED`: with EVENTS_OUT_OF_ORDER the `CALLER_CONFIRMED_CONNECTED` event that arrives before `BRIDGED` is rejected `TRANSFER_EVENT_OUT_OF_ORDER` (no reordering by `sequence`, no redelivery requested), the first leg times out, the fallback leg connects, and TC-11 records OUTCOME_UNKNOWN (`NO_SUCCESS_EVIDENCE`) | 7 (7 / 0) | 3 | `platform/src/workflows/transfer.ts` (`applyEvent`) and the one-outcome-per-session TC-11 gap |
| `SAFETY_ASR_UNCERTAIN_OVER_ROUTING`: "these bills are killing me" at ASR confidence 0.55 trips the ASR_UNCERTAIN rule (threshold 0.6, placeholder) | 5 (5 / 0) | 1 | Clinical safety lead / ASR calibration (PRQ-008) |
| `SCREENING_INITIATED_SAFETY_ROUTE_SEQUENCE`: consent_declined drafts route safety through the Studio screening endpoint, not the `request_safety_route` tool the expected sequence names (safety gates PASS) | 4 (4 / 0) | 4 | Corpus owners |
| `DRIVER_TRANSFER_FAULT_NOT_APPLIED_TO_STUDIO_ROUTE`: RECEIVER_UNAVAILABLE is not applied to a Studio-requested transfer (reported not injected) | 1 (0 / 1) | 1 | Evaluation driver |
| `COORDINATOR_ROLE_NOT_RESOLVED`, `COORDINATOR_MISREAD_INTENT`, `COORDINATOR_REPEATS_FLOW_ON_FOLLOW_UP` | 3 (3 / 0) | 3 | Evaluation driver (simulated coordinator) |

INCONCLUSIVE (20): simulated coordinator could not interpret or parse a turn 11; fault not
injected on the script 9 (DUPLICATE_WEBHOOK 7, RECEIVER_UNAVAILABLE 1, CLAIMS_TIMEOUT 1).

Newly visible backend finding (owned elsewhere, not fixed here): `platform/src/workflows/transfer.ts`
`transferTransition` / `TransferCoordinator.applyEvent` rejects a progress event that arrives ahead of
its predecessor instead of ordering by the event `sequence` the telephony contract carries, and
the rejection does not ask for redelivery, so an out-of-order `CALLER_CONFIRMED_CONNECTED` is lost
(`scn_risk_duplicate_webhook_020`, `_022`, `_024`). The same runs failed before this wave, hidden
behind the audit gate. The routing itself fails safe (fallback leg connected; safety gates PASS).

Not re-measured as defects here: everything in the table above except the transfer ordering finding
is either a LOCAL SIMULATED COORDINATOR or driver limitation, a corpus script or expectation that
needs an owner decision, or the missing approved knowledge articles.

## Demo

| Command | Result | Evidence |
|---|---|---|
| `pnpm demo` (`cd platform && npx tsx src/demo/run-demo.ts`) | exit 0 (23.9 s); 9 journeys, backend evidence present for 9; scorer verdicts PASS 9, FAIL 0, INCONCLUSIVE 0; IntegrityVerifier OK and numeric-order chain intact in 9 of 9 | `evidence/demo/run_demo_iUkfzr-ZvIwdKkmY7uiGWqFJ.json` (transcript), `evidence/demo/run_demo_iUkfzr-ZvIwdKkmY7uiGWqFJ.stdout.txt` (console output) |
| `cd platform && npx tsx src/demo/run-demo.ts --faulted` | exit 0 (54.6 s); 21 journeys (9 + 12 faulted), backend evidence present for 21; PASS 20, FAIL 1, INCONCLUSIVE 0; IntegrityVerifier OK in 21 of 21 | `evidence/demo/run_demo_4tSfGzwe90rgZL-I1Cp8ZVbp.json`, `evidence/demo/run_demo_4tSfGzwe90rgZL-I1Cp8ZVbp.stdout.txt` |

The faulted demo's one FAIL is `scn_journey_1_client_reschedule_conflict__auth_expiry_mid_call`
(`task.outcome`: TRANSFERRED, expected DECLINED_BY_POLICY): the commit is denied `SESSION_EXPIRED`
and the simulated coordinator routes to re-verification by a person (the same expectation conflict
as in the corpus run). Recorded outcomes of the nine journeys: J1 RESOLVED, J2 REQUEST_ACCEPTED, J3
INFORMATION_PROVIDED, J4 DECLINED_BY_POLICY, J5 TRANSFERRED, J6 TRANSFERRED, J7 TRANSFERRED, J8
TRANSFERRED, J9 INFORMATION_PROVIDED.

The badge `LOCAL FIXTURE — SYNTHETIC DATA — NOT PRODUCTION` frames the output. Each step prints
the tool calls, every caller-heard line with its template id and approval status (`DRAFT` or
`PENDING_*`, allowed only in local and ci), and the backend snapshot. The JSON transcripts contain
no caller utterances; the `.stdout.txt` console output also shows the SYNTHETIC scripted caller lines
taken from `scenarios/journeys/`. The process exits 1 if any journey lacks backend evidence
(outcome record, ledger or transfer journey where expected, audit).

## Load (local loopback smoke)

> **LOCAL LOOPBACK, PGlite single connection, NOT the vendor/telephone path, NOT capacity
> evidence.** The quota and sustained load row above stays BLOCKED (PRQ-022, PRQ-037).

| Step | Command | Result | Evidence |
|---|---|---|---|
| Smoke (vitest, inside the platform run) | `cd platform && npx vitest run test/load` | PASS: 7 passed, 0 expected-fail (16.8 s); the former IntegrityVerifier and audit-shipping known failures now pass | `platform/test/load/load-smoke.test.ts` |
| Long run | `cd platform && npx tsx ../scripts/load/run-local-load.mts --sustained 25 --burst 5 --rate 400 --connections 40 --burst-connections 100 --warmup 3 --reference-rate 20 --reference 10` | exit 0 (102.8 s); zero errors; every success audited; **400 req/s target NOT MET** | `evidence/load/run_load_pIpldOT9sAHduHcGYIgLNJ3-.json` |
| Repeat of the long run (same command, run alone right after) | as above | exit 0; zero errors; every success audited; **400 req/s target NOT MET** | `evidence/load/run_load_LSJ9LDQB_eifhLTLXAqU1917.json` |

Target: one LOCAL FIXTURE gateway on 127.0.0.1 (Fastify listener, HTTP tool route, PGlite 0.3.15 in
process on the gateway thread). Generator: autocannon 8.0.0 in a separate Node process.
Per-integration rate limiter active with its ceiling raised to 10 000 000 per minute. Every response
body is checked for a `SUCCESS` ToolResult. Same 4 vCPU host as above, run alone.

Long run `run_load_pIpldOT9sAHduHcGYIgLNJ3-`:

| Phase | Tool (class, session) | Connections | Offered rate | Duration s | Responses | Throughput req/s | p50 ms | p95 ms | p99 ms | Errors |
|---|---|---|---|---|---|---|---|---|---|---|
| reference | `search_approved_runbook` (PUBLIC_READ, A0) | 4 | 20/s | 10 | 200 | 19.96 | 61.5 | 138.1 | 170.8 | 0 |
| reference | `get_invoice_status` (PROTECTED_READ, A2) | 4 | 20/s | 10 | 200 | 19.96 | 55.2 | 117.7 | 156.1 | 0 |
| sustained | `search_approved_runbook` (PUBLIC_READ, A0) | 40 | 400/s | 25 | 1 072 | 42.83 | 885.7 | 1 086.3 | 1 940.9 | 0 |
| sustained | `get_invoice_status` (PROTECTED_READ, A2) | 40 | 400/s | 25 | 1 231 | 49.18 | 772.1 | 1 174.7 | 1 556.6 | 0 |
| burst | `search_approved_runbook` (PUBLIC_READ, A0) | 100 | unthrottled | 5 | 211 | 41.87 | 2 157.8 | 2 354.0 | 2 376.0 | 0 |
| burst | `get_invoice_status` (PROTECTED_READ, A2) | 100 | unthrottled | 5 | 238 | 47.22 | 1 885.2 | 2 134.6 | 2 180.0 | 0 |

Repeat `run_load_LSJ9LDQB_eifhLTLXAqU1917`: sustained 46.70 req/s (PUBLIC_READ, p99 1 763.0 ms) and
47.94 req/s (PROTECTED_READ, p99 1 675.2 ms); burst 39.36 req/s (p99 3 821.6 ms) and 22.66 req/s
(114 responses, p99 4 397.9 ms); zero errors.

Errors means transport errors, timeouts, non-2xx responses and non-`SUCCESS` bodies (all zero in
both runs; error rate 0). **The 400 req/s sustained target was not met on this LOCAL LOOPBACK,
PGlite single-connection setup**: the single-process stack saturates at about 43 to 49 tool requests
per second, so the sustained and burst latencies are queueing delay. This is not capacity evidence
for Talkdesk, PSTN, AWS or Aurora. The throughput is below the previous record of the same command
(50.02 and 55.93 req/s); the cause was not investigated.

Final state after the long run: audit rows grew by 3 440 for 3 152 successful responses (requests
still in flight when the generator stopped also completed), so every success was audited; 27 audit
shipper runs, 0 blocked, 0 failed, unshipped backlog 0 after the final pass; the IntegrityVerifier
verified 3 787 events in 1 stream with 0 findings (local and shipped); the numeric-order chain
recomputation is intact. Repeat: +3 369 rows for 3 081 successes, backlog 0, IntegrityVerifier OK.

## Requirement coverage

The requirement-to-test matrix is generated from requirement-tagged test titles by the
traceability module (`docs/requirements/`). *To be completed by coordinator after integration
test run.*
