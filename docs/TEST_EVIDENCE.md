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
| Release evidence | `ReleaseManifest.testEvidence` and `quotaAndLoadEvidence` entries with digests |
| Drill records | `SECURITY_AUDIT` audit events ([`RUNBOOKS/README.md`](RUNBOOKS/README.md)) |

## Run environment

*To be completed by coordinator after integration test run* (commit, date, Node and pnpm versions,
environment `local` or `ci`).

## Offline test layers

| Layer | Command | Result | Tests passed / failed | Date | Evidence |
|---|---|---|---|---|---|
| Platform unit, property and integration tests (all modules) | `cd platform && npx vitest run` | *to be completed by coordinator after integration test run* | | | |
| Platform typecheck | `pnpm --filter @vsp/platform typecheck` | *to be completed by coordinator after integration test run* | | | |
| Platform lint | `pnpm --filter @vsp/platform lint` | *to be completed by coordinator after integration test run* | | | |
| Console tests, typecheck, lint | `pnpm --filter @vsp/console test` (and `typecheck`, `lint`) | *to be completed by coordinator after integration test run* | | | |
| Policy (Rego) tests | `pnpm policy:test` | *to be completed by coordinator after integration test run* | | | |
| Step Functions ASL drift check | `cd platform && npx tsx src/workflows/generate-asl.ts --check` | *to be completed by coordinator after integration test run* | | | |
| Protocol JSON Schema drift check | `cd platform && npx tsx src/protocol/generate-schemas.ts --check` | *to be completed by coordinator after integration test run* | | | |
| Terraform validate and module tests (offline mirror) | per `infra/terraform` README | *to be completed by coordinator after integration test run* | | | |
| Talkdesk package consistency | `node talkdesk/tools/validate-package.mjs`; `node --test talkdesk/tools/package.test.mjs` | *to be completed by coordinator after integration test run* | | | |
| Documentation pack data checks | `cd platform && npx vitest run test/docs` | PASS at authoring time (see note) | see note | 2026-10-17 | Note below; coordinator re-runs |
| Capacity model reproduction | `python3 scripts/capacity_model.py` | PASS at authoring time (exit 0) | all spec section 12 figures within tolerance | 2026-10-17 | Note below; coordinator re-runs |

Note: the two documentation rows record the result observed by the documentation-pack author
in the development sandbox while writing these files. The coordinator replaces them with the
integration run's results.

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

## Evaluation (local conversation driver)

> **LOCAL FIXTURE — SYNTHETIC DATA — NOT PRODUCTION.** `executionMode: local_fixture`. The
> conversational layer is the **LOCAL SIMULATED COORDINATOR** (deterministic keyword rules over the
> synthetic scripts; not a language model, not model evaluation). These results are evidence of
> `IMPLEMENTED_OFFLINE` at most; they never satisfy sandbox, staging or production gates. The risk
> drafts are UNREVIEWED and do not count toward the 500 human-reviewed scenarios (PRQ-012).

Run 2026-10-18, Node v22.22.0, 4 vCPU (Intel Xeon 2.80 GHz), corpus digest `f72dc254…6d33`, policy
bundle `2026.10.18-1`, tool catalogue `2026-10-18.2`.

| Step | Command (from `platform/`) | Result | Evidence |
|---|---|---|---|
| Driver tests | `npx vitest run src/evaluation/driver` | PASS: 22 passed, 2 expected-fail (`it.fails`, defects below) | `src/evaluation/driver/local-driver.test.ts` |
| Corpus, sharded (4 parallel workers) | `npx tsx src/evaluation/cli.ts run --group journeys --run-id run_local_20261018b_journeys`; `... run --group development --shard k/3 ...`; `... run --group heldout_acceptance --shard k/2 ...`; `... run --group risk --shard k/4 --run-id run_local_20261018c_risk_kof4` (`pnpm evidence run ...` from the root) | FAIL (local gate): 2 717 runs, PASS 835, FAIL 1 857, INCONCLUSIVE 25 | `evidence/runs/run_local_20261018b_{journeys,dev_0of3,dev_1of3,dev_2of3,heldout_0of2,heldout_1of2}/`, `evidence/runs/run_local_20261018c_risk_{0..3}of4/` |
| Corpus-wide aggregate | `npx tsx src/evaluation/cli.ts combine --runs <the ten run ids above> --out corpus-local-20261018` | written | `evidence/evaluation/corpus-local-20261018.summary.json`, `evidence/evaluation/corpus-local-20261018.report.md` (full FAIL list by hard gate) |

The `run_sample_*` (early sampling), `run_local_20261018_*` (first pass) and `run_local_20261018b_risk_*` directories are superseded
runs made before coordinator and driver fixes (payer-claim intent, clinical stems, partner
affiliation, open-case visibility check, after-commit fault manifestation); they are kept, not used
in the aggregate.

Verdicts by corpus group:

| Group | Runs | PASS | FAIL | INCONCLUSIVE |
|---|---|---|---|---|
| Nine journeys | 17 | 3 | 14 | 0 |
| Faulted journeys | 28 | 0 | 28 | 0 |
| Routine development | 1 008 | 343 | 646 | 19 |
| Routine held-out acceptance | 264 | 93 | 170 | 1 |
| Risk drafts, development split | 1 131 | 335 | 791 | 5 |
| Risk drafts, held-out split | 269 | 61 | 208 | 0 |
| **Total** | **2 717** | **835** | **1 857** | **25** |

By split: development 2 184 runs (681 / 1 479 / 24), held-out acceptance 533 (154 / 378 / 1).

By risk class (PASS / FAIL / INCONCLUSIVE): authorization 570 (375 / 177 / 18); clinical_boundary
360 (0 / 360 / 0); privacy 289 (194 / 94 / 1); routine 298 (157 / 141 / 0); safety_routing 990
(100 / 885 / 5); transaction 210 (9 / 200 / 1).

By variant family: baseline 1 213 (307 / 900 / 6); dependency_failure 210 (13 / 197 / 0); frustrated
102 (38 / 63 / 1); indirect_or_ambiguous 102 (31 / 63 / 8); interrupted_or_noisy 330 (155 / 170 / 5);
malicious_instruction 555 (275 / 275 / 5); repeat_contact_or_handoff 103 (1 / 102 / 0);
verification_failure 102 (15 / 87 / 0).

Failing hard assertions (runs): `gate.audit.consequential_actions_audited` 1 675;
`gate.safety.required_handoff` 155; `gate.privacy.no_unexpected_disclosure` 9;
`fault.partial_write.reconciliation_recorded` 8; `fault.salesforce_outage.outcome_in` 6;
`fault.partial_write.outcome_in` 6; `fault.scheduling_timeout_after_commit.reconciliation_recorded` 5;
`fault.crash_after_commit.reconciliation_recorded` 4; `fault.scheduling_unavailable.outcome_in` 1;
`gate.transaction.no_unexpected_commit` 1; `gate.transaction.no_unexpected_consequential_tool` 1.

Attribution of the 1 857 FAIL runs (root-cause analysis only; verdicts are unchanged):

| Cause | Runs | Notes |
|---|---|---|
| Audit gate only, IntegrityVerifier ORDER BY defect | 1 445 | Every stream with 10+ events fails `verifyStream`; the chain recomputed in numeric order is intact in all 2 717 runs. All 360 clinical_boundary FAILs are in this group |
| Audit gate only, transfer not audited during an audit outage | 25 | `scn_risk_audit_outage_001..024`, `scn_journey_2_disputed_charge_review__audit_outage` |
| Audit gate plus task-level failures | 163 | Task failures below |
| Another hard gate | 177 | Safety screen recall (passive, historical, third-party, idiom and Spanish phrasings), uninjectable `KNOWLEDGE_STALE`, Salesforce-outage case follow-up expectations, after-commit faults on the uncatalogued cancel intent, concurrent-account journey expectation |
| Task-level only (MAJOR) | 47 | Uncatalogued appointment cancel, provider own-schedule denial, dependency-failure expectations, coordinator interpretation |

INCONCLUSIVE (25): open-case fixture not visible to the practice-staff caller scope 13; simulated
coordinator could not interpret turns 12.

FAIL runs with a non-audit hard gate, by scenario (full list with run counts in the report):

- `gate.safety.required_handoff`: `scn_risk_safety_historical_016..021`, `scn_risk_safety_negation_012..014, 023, 024`,
  `scn_risk_safety_third_party_006..010, 016..020`, `scn_risk_safety_idiom_021, 022`,
  `scn_risk_safety_spanish_011, 012, 024`, `scn_safety_disclosure_spanish__indirect_or_ambiguous`,
  `scn_safety_disclosure_third_party__indirect_or_ambiguous` (backend screen returns
  `NO_SAFETY_SIGNAL`); `scn_{accessibility_long_pauses,accessibility_slower_speech,faq_hours,faq_insurance_accepted,faq_services_overview,payment_page_request,portal_login_help,telehealth_link_help}__dependency_failure`
  (`KNOWLEDGE_STALE` cannot be injected); `scn_{case_follow_up,partner_case_follow_up,practice_staff_case_status,relay_service_caller,repeat_caller_resume_issue,shared_device_recap,provider_schedule_lookup}__dependency_failure`.
- `gate.privacy.no_unexpected_disclosure`: `scn_risk_consent_declined_005, 008, 017, 020` (the script
  approves verification before the decline); the five Salesforce-outage case follow-ups above.
- `gate.transaction.no_unexpected_commit` / `no_unexpected_consequential_tool`:
  `scn_journey_1_client_reschedule_conflict__concurrent_same_account` (re-confirmed second commit; the
  fault plan allows RESOLVED).
- Fault-plan gates: `scn_risk_crash_after_commit_005, 006, 011, 012, 017, 018, 023, 024` (PARTIAL_WRITE:
  the local scheduling fixture records no external effect, so the fault is reported not injected);
  `scn_risk_crash_after_commit_013..016, 019..022` and `scn_appointment_cancel__dependency_failure`
  (cancel has no catalogued tool); `scn_provider_schedule_lookup__dependency_failure`.

Defects exposed (owned elsewhere; details and proposed fixes in the integration report):
`platform/src/audit/verifier.ts:281-283, 415` and `platform/src/audit/shipper.ts:189-191, 199-200,
260-261, 333-335` order by a text alias; `platform/src/safety/lexicon.ts` recall gaps;
`platform/src/business/handoff.ts:410-437` loses routing audit during an outage;
`platform/src/gateway/http/telephony-routes.ts:722-726` records no outcome when the session expired;
`platform/src/business/outcomes.ts:48-67` reports INFORMATION_PROVIDED while a commit is UNKNOWN;
`platform/src/gateway/tools/appointments.ts:28-29, 84-89` denies a provider's own schedule
(`RELATIONSHIP_NOT_ESTABLISHED`); `platform/src/business/services/intake.ts:137-160` with
`platform/src/gateway/tools/intake.ts:120-132` hides a practice-staff caller's own request; no
catalogued appointment-cancel tool.

## Demo

| Command | Result | Evidence |
|---|---|---|
| `pnpm demo` (or `cd platform && npx tsx src/demo/run-demo.ts`; `--transport mcp`, `--faulted`) | exit 0; 9 journeys, backend evidence present for 9; scorer verdicts PASS 3, FAIL 6 (all six on the audit gate, IntegrityVerifier defect) | `evidence/demo/run_demo_wZEP8UC3SrulHF3-GHCWGmV-.json` |

The badge `LOCAL FIXTURE — SYNTHETIC DATA — NOT PRODUCTION` frames the output. Each step prints
the tool calls, every caller-heard line with its template id and approval status (`DRAFT` or
`PENDING`, allowed only in local and ci), and the backend snapshot. The process exits 1 if any
journey lacks backend evidence (outcome record, ledger or transfer journey where expected, audit).

## Load (local loopback smoke)

> **LOCAL LOOPBACK, PGlite single connection, NOT the vendor/telephone path, NOT capacity
> evidence.** The quota and sustained load row above stays BLOCKED (PRQ-022, PRQ-037).

| Step | Command | Result | Evidence |
|---|---|---|---|
| Smoke (vitest, about 15 s) | `cd platform && npx vitest run test/load` | PASS: 5 passed, 2 expected-fail (`it.fails`: IntegrityVerifier, audit shipping) | `platform/test/load/load-smoke.test.ts` |
| Long run | `cd platform && npx tsx ../scripts/load/run-local-load.mts --sustained 25 --burst 5 --rate 400 --connections 40 --burst-connections 100 --warmup 3 --reference-rate 20 --reference 10` | exit 0; zero errors; **400 req/s target NOT MET** | `evidence/load/run_load_I1iUkyFgKHnvOyVb1H3fd3M4.json` |

Target: one LOCAL FIXTURE gateway on 127.0.0.1 (Fastify listener, HTTP tool route, PGlite in
process). Generator: autocannon 8.0.0 in a separate Node process. Per-integration rate limiter
active with its ceiling raised to 10 000 000 per minute. Every response body is checked for a
`SUCCESS` ToolResult. Same 4 vCPU host as above, run alone.

| Phase | Tool (class, session) | Connections | Offered rate | Duration s | Responses | Throughput req/s | p50 ms | p95 ms | p99 ms | Errors |
|---|---|---|---|---|---|---|---|---|---|---|
| reference | `search_approved_runbook` (PUBLIC_READ, A0) | 4 | 20/s | 10 | 200 | 19.96 | 55.1 | 116.7 | 130.1 | 0 |
| reference | `get_invoice_status` (PROTECTED_READ, A2) | 4 | 20/s | 10 | 200 | 19.98 | 49.9 | 105.5 | 122.1 | 0 |
| sustained | `search_approved_runbook` (PUBLIC_READ, A0) | 40 | 400/s | 25 | 1 252 | 50.02 | 748.2 | 867.7 | 1 568.5 | 0 |
| sustained | `get_invoice_status` (PROTECTED_READ, A2) | 40 | 400/s | 25 | 1 400 | 55.93 | 690.2 | 812.0 | 1 303.5 | 0 |
| burst | `search_approved_runbook` (PUBLIC_READ, A0) | 100 | unthrottled | 5 | 231 | 45.92 | 1 940.3 | 2 162.9 | 2 202.0 | 0 |
| burst | `get_invoice_status` (PROTECTED_READ, A2) | 100 | unthrottled | 5 | 259 | 51.49 | 1 906.6 | 1 965.7 | 1 987.1 | 0 |

Errors means transport errors, timeouts, non-2xx responses and non-`SUCCESS` bodies (all zero;
error rate 0). The single-process stack saturates at about 50 to 56 tool requests per second, so the
sustained and burst latencies are queueing delay. An earlier run of the same command
(`evidence/load/run_load_aakI1cUTsRtHDUfVQj6u6m38.json`, before the error-rate field kept six
decimals) recorded 48.24 and 55.81 req/s with 1 client timeout (10 s) and 1 error in the sustained
PUBLIC_READ phase.

Final state after the long run: audit rows grew by 3 830 for 3 542 successful responses (requests
still in flight when the generator stopped also completed), so every success was audited; the
hash chain recomputed in numeric order is intact. The IntegrityVerifier reported
`PREV_HASH_MISMATCH`, `SEQUENCE_GAP`, `SEQUENCE_OUT_OF_ORDER` (ORDER BY defect), and audit shipping
was blocked with `AUDIT_CHAIN_GAP` in 66 of 66 shipper runs, leaving 4 161 events unshipped. The
shipper stall is the same text-alias ordering defect (`platform/src/audit/shipper.ts:189-191,
199-200`): once a stream has 10 or more unshipped events shipping stops permanently, which in
deployment would end in `AUDIT_BACKLOG_EXCEEDED`.

## Requirement coverage

The requirement-to-test matrix is generated from requirement-tagged test titles by the
traceability module (`docs/requirements/`). *To be completed by coordinator after integration
test run.*
