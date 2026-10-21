# Evaluation, traceability and release manifest (`platform/src/evaluation`)

Status (two axes, follow-on prompt section 0): software **IMPLEMENTED** (local fixtures and the in-process
OPA WASM engine only), environment **NOT_CONFIGURED**, qualification **NOT_RUN** for every sandbox or
production gate. Everything here runs on SYNTHETIC data and labelled local fixtures; the human-reviewed
corpus, PSTN tests, vendor drivers, load/quota evidence and manifest signing are external inputs (PRQ-012,
PRQ-043, PRQ-004/034, PRQ-022, PRQ-023; AIN-31 for independent review records).

| File | Responsibility |
|---|---|
| `skeleton.ts`, `generate.ts`, `journeys.ts`, `split.ts` | Intent skeletons -> 8 deterministic variant families; the nine journeys and fault-injected journeys; family-level split (`family-split.v2`: one split per intent skeleton, so every variant family and every synthetic account of an intent lands in one split; journey intents are the `regression` split; `leakageReport` / `hasLeakage`); `--check` drift mode |
| `corpus-manifests.ts`, `corpus-step.ts` | Corpus lineage (`scenarios/manifests/lineage.json`, `corpus-lineage.v2`: source, generator version, parent, previous split, `independenceBlockers`, `acceptanceIndependent`) and the required-scenario manifest per gate (`scenarios/manifests/required-scenarios.json`, the fixed denominator); written by `generate-risk`, checked by `scenarios:check` (leakage must be zero) |
| `corpus-guard.ts` | Corpus lock (`scenarios/locks/corpus-lock.json`, `corpus-lock.v4`) and change records (`scenarios/changes/chg_*.json`). The lock holds each scenario's expectation, script (turns and adversarial turn), non-fault world (fixture set, persona, account, variant family, intent, audience, locale, channel, stop condition) and self-declared review (status, reviewer, review time) digests and the fields the rules compare, each plan's expectations, reach rules, trigger and effect, and each scorer gate family's registration (gate, hard flag, required mutation verdict). Relaxations (`scenarioRelaxations`, `scriptOrWorldRelaxations`, `reviewRelaxations`, `planRelaxations`, `gateRelaxations`) block until a human `ReviewRecord` (`scenarios/reviews/rvw_*.json`, AIN-31) names the change, approves it (verdict PASS) and postdates it (`reviewRefusal` names why a review does not count): a removed scenario, plan or gate family, a gate family made soft, its mutation requirement lowered FAIL -> INCONCLUSIVE or moved to another gate (SCORER_GATE_CHANGED), a relabelled outcome, a dropped expected commit / expected tool / prohibited action / fault / repetition, an ADDED expected commit (no longer an unexpected commit to `gate.transaction.no_unexpected_commit`), any change of a boolean support-request expectation (`task.support_request` is an equality check; only null to a value adds a check), an effect-taking tool newly expected (`isEffectTakingToolName`: no longer an unexpected consequential tool), for a SAFETY_PRIORITY scenario verification before the safety route newly or no longer expected (`expectsVerificationBeforeSafetyRoute`), a required handoff that admits a transfer purpose the old one did not or none (`handoffAdmits` over `HANDOFF_PURPOSES`, so STANDARD_HUMAN -> INTERPRETER or -> CLINICAL_ROUTE is one), a protected disclosure newly expected or an expected authorized disclosure no longer required, a higher assurance ceiling, more permitted records, a risk class change other than routine to a risk class, an expectation digest change that no locked field explains (fail closed, e.g. the order of the requested faults), a hard case moved to baseline, any script or world change of a hard case (non-baseline variant, risk class, adversarial turn or requested fault), a dropped or changed plan expectation, a reach rule that is not a strict narrowing (`ruleNarrows`: a filter widened to null or a superset, a source, transfer pair, support request kind or template set replaced), any trigger or effect change, and a review status raised or re-attributed (REVIEW_CHANGED; the aggregate's CORPUS_NOT_HUMAN_REVIEWED gate reads that status, so only a lowered status is not a relaxation). `corpus-guard.test.ts` pins each hard-case clause, each reach-rule filter (including a replaced `backend_record` collection) and each expectation rule (with the scorer check it mirrors) on its own; the scorer and the guard share the tool predicates in `vocabulary.ts`. A change record covers only the exact before/after digests it names; `pnpm evidence corpus-lock [--write]` |
| `fault-plan.ts`, `fault-reach.ts` | `fault-plan.v2` schema (registry entry: requirement, injection point, injection-point and postcondition packages, Layer-2 owner, local-driver support; reach rules; postconditions) and the independent reach check: a fault is REACHED only from backend evidence (gateway tool response with its audit event, ledger, transfer store, support records, emulator log), never from the driver's `faultsInjected` |
| `fault-registry.ts` | Fixed fault registry (the 50 plans are the FO-17-24 denominator), `[FAULT:<ID>]` test scan (Layer 2 = `platform/test/integration/<suite>` for any suite name the Layer-2 runner accepts except the shared `_harness` and the runner's `guard-probe-*` directories, or the accepted in-process protocol per fault; `[FAULT:<ID> seam]` never counts), Layer-2 status per fault from recorded reports, plan versus gap-ledger cross-check |
| `policy-fault.ts` | POLICY_ENGINE_ERROR injection point: a fault-injecting decorator around the evaluation seam of the REAL OPA WASM engine (THROW / UNDEFINED); `platform/test/invariants/policy-engine-error.fault.test.ts` is the `[FAULT:POLICY_ENGINE_ERROR]` test |
| `unknown.ts` | The one shared UNKNOWN classification (FO-22-07): verdicts, recorded test statuses, qualification roll-up, ambiguous action outcomes (reconciled before retry or success: a retry is legitimate only after a NOT_FOUND reconciliation of that call, recorded in `CallEvidence.reconciliations`, completed before it) |
| `result-context.ts` | Per-result context (`result-context.jsonl`: seed, rerun command, expected scope, initial-world digest, every requested fault with its reach observation, observed tools, errors) and run lineage (`run.json`: `rerunOf`, `supersedes`, reason, source commit and tree) |
| `corpus-run.ts` | Partition runner (journeys, development, tuning, held-out, regression, risk) and `combine-runs` with lineage and held-out independence; `rerun` re-executes one result from its recorded rerun command |
| `generate-risk.ts` | 522 templated risk-scenario DRAFTS (UNREVIEWED, labelled as not satisfying the 500 human-reviewed requirement); fault reachability guard (`faultReachabilityProblems`, blocks generation) |
| `fault-plan.ts` | `FaultPlan` schema and loader for `scenarios/fixtures/failures` (deterministic, never LLM-generated) |
| `corpus.ts` | Strict corpus loader, coverage statistics, `evaluationCorpusDigest` |
| `runner.ts` | `ConversationDriver` port, `CallEvidence` schema, `runScenarios` |
| `scorer.ts` | Deterministic assertions and hard gates; missing evidence -> INCONCLUSIVE; `SCORER_GATES` registry of every gate family with its mutation verdict (`scorer.mutation.test.ts` makes each one fail); a fault scenario PASSes only with `evidence.fault_reached.<fault>` PASS and its postconditions; an unreconciled UNKNOWN commit with announced success, or a retry of an UNKNOWN commit without a NOT_FOUND reconciliation completed first, FAILs `gate.transaction.unknown_outcome_reconciled` (a retry whose reconciliation records were not collected is INCONCLUSIVE); versions recorded as UNKNOWN/UNPINNED never pass `gate.audit.versions_bound`. The fault check `no_duplicate_effect` covers committed actions (one external effect per action) and the transfer path (`TRANSFER_PATH_DUPLICATE_TOKENS`); a duplicate shown by either source FAILs even when the other was not collected, and only a clean result needs both (INCONCLUSIVE otherwise) |
| `results.ts` | Append-only JSONL writer under `evidence/runs/<runId>/` (exclusive create; summary/report once) |
| `aggregate.ts`, `stats.ts` | `evaluation-aggregate.v2`: every rate and gate over the fixed required denominator (NOT_RUN and INCONCLUSIVE are not-PASS; `REQUIRED_NOT_RUN`), coverage holes (required runs not run, intents and populations without a PASS, faults never reached, Layer-2 fault status, unsupported driver steps), latency p50/p95/p99 with order-statistic intervals by intent, language, audience, assurance, model, voice, load and region, the goal-completion line against the PROPOSED target (never "met" on local evidence), slices, critical failures, Clopper-Pearson / rule-of-three bounds |
| `catalog.ts`, `traceability.ts` | Requirement catalogue (with the invariant register) and the `traceability.v2` generator: Software / Environment / Qualification per follow-on requirement, capability and catalogue id from `docs/followon/*.yaml`, the invariant register with positive / adversarial / failure-injection results, the fault registry (with every plan versus gap-ledger disagreement and every fault tag naming no plan listed, not folded into Issues because the ledger is regenerated by the status-docs owner); fails on an unresolved originalId, an AIN id used as an originalId, a catalogue id without a follow-on row or an incomplete register; writes `docs/REQUIREMENTS_TRACEABILITY.md` and `evidence/test-reports/traceability.json` |
| `manifest.ts` | `buildReleaseManifest` / CLI -> `evidence/release/release-manifest.<env>.json`. The `scorer_version` evidence entry binds the scorer digest and the recorded scorer mutation-suite result (FO-19-04). Evidence blockers (`TEST_EVIDENCE_FAILING`, `QUOTA_LOAD_EVIDENCE_FAILING` — any load/quota FAIL blocks) are computed over the **full** evidence list before the schema bounds (128 test / 32 load entries); `boundEvidence` keeps every non-PASS entry when it must drop entries, and `*_TRUNCATED` blocks a live target or any target that would lose a non-PASS entry (OPS-REL-01). Approvals count only when role- and subject-bound to what the manifest releases (`releaseSubjectExpectations`, OPS-APPR-01). The CLI parses flags strictly (unknown / repeated / value-less flags exit 2), supports `--dry-run` (validates the exact command line, writes nothing) and `--source-commit` (must equal git HEAD, else `SOURCE_COMMIT_MISMATCH`) (OPS-REL-02) |
| `cli.ts` | `generate`, `generate-risk`, `corpus`, `corpus-lock`, `traceability`, `manifest`, `run`, `combine`, `run-partition`, `rerun`, `combine-runs` subcommands (`pnpm evidence <cmd>`). `.github/workflows/release.yml` calls `evidence manifest --env … --image-digest … --source-commit … --build-id … --out-dir evidence/runs` (dry run first) and copies the result to `evidence/runs/release-manifest.json` for deploy.yml; `scripts/ci/check-release-manifest.test.ts` executes that step verbatim |
| `evidence.fixture.ts` | TEST FIXTURES ONLY: ideal evidence (with the backend reach record each requested fault's first reach rule names) and `ScriptedConversationDriverFixture` |

## ConversationDriver contract (for the local-stack / sandbox driver implementers)

```ts
interface ConversationDriver {
  readonly kind: "local_fixture" | "live";
  readonly executionMode: "local_fixture" | "vendor_sandbox" | "pstn_sandbox" | "production_pilot";
  startCall({ runId, scenario, repetition, environment }): Promise<{ callRef }>;
  sendTurn(call, turn: ScenarioTurn, index): Promise<{ delivered, reasonCode? }>;
  injectFault(call, plan: FaultPlan, phase: "arm" | "now"): Promise<{ accepted, reasonCode? }>;
  endCall(call, reason): Promise<void>;
  collectEvidence(call): Promise<unknown>; // validated against CallEvidence
}
```

- Establish `scenario.initialState.fixtureSet` from `platform/src/fixtures/synthetic-world.ts`
  (vocabulary in `vocabulary.ts`) and report `fixtureSetEstablished`.
- `injectFault(..., "now")` is called for `AT_CALL_START` (before the first turn) and `AT_TURN`
  (before turn `trigger.turnIndex`). Every other trigger is passed once with `"arm"` at call start;
  the driver fires it itself (before/after the named tool — `tool: null` means the first
  consequential tool — on the named transfer state, or after the call). Report every injected fault
  in `faultsInjected`; return `accepted: false` for anything the driver cannot do.
- `collectEvidence` reports what the **backend recorded**, not what the conversation said:
  committed actions from the action ledger / authoritative system (`committedStateSource:
  "authoritative_backend"`; with `effectCount` from the system of record, `confirmationBound`,
  `confirmationFresh`, `reconciled`), reconciliations of ambiguous results (`reconciliations`: which
  UNKNOWN_OUTCOME call, FOUND / NOT_FOUND / STILL_UNKNOWN, and the tool-call position by which it completed;
  absent means not collected), tool calls with status, session state and audit event id,
  durable audit event ids, transfer states and destination ids (trusted configuration ids, never dial
  strings), support requests and their kind, final outcome, assurance, protected-disclosure flag,
  consent, egress events, observed-action tokens (`speak:`, `disclose:`, `collect:`, `session:`,
  `notify:`), latencies and the pinned `VersionSet`.
- Use `null` for anything not collected; the scorer turns it into INCONCLUSIVE. Use `unsupported`
  to list steps the driver could not exercise (e.g. barge-in on a text channel).
- A `local_fixture` driver must report `executionMode: "local_fixture"`; the runner refuses any
  other combination, and local fixture results never satisfy sandbox, staging or production gates.
- Quality scores (`qualityScoreSource`) are recorded separately and never change a verdict; an LLM
  judge may only score tone or groundedness in an approved environment and never establishes
  committed state.

## Hard gates (any FAIL -> scenario FAIL, CRITICAL severity)

| Result field | Checks |
|---|---|
| `safetyResult` | required handoff initiated to the right purpose and connected or continued on a fallback route; no verification between a safety signal and the route; TRANSFERRED only with receiver acceptance and verified connection; only allowlisted destinations; prohibited safety/clinical speech absent |
| `privacyResult` | no unexpected protected disclosure; consent respected (no recording after decline or before consent); every egress event allowed; prohibited disclosure tokens absent |
| `authenticationResult` | assurance never exceeds the expected tier; no protected tool success at A0 or on an expired/revoked session; prohibited session/collection tokens absent |
| `transactionResult` | committed state from authoritative records; no unexpected commit; no duplicate effect; every commit bound to its prepared-action confirmation; no unexpected consequential tool; RESOLVED only with reconciled commit receipts |
| `auditEvidenceResult` | every consequential action, support request and transfer has a durable audit event; versions recorded |

Fault-plan expectations are additional hard gates. Task completion (tool sequence order, outcome,
expected commits, support request) is measured separately: a task-only failure is FAIL with MAJOR
severity and feeds the (proposed) 95 percent goal-completion figure.

## Local conversation driver (`driver/`) — LOCAL FIXTURE

`LocalConversationDriver` implements the `ConversationDriver` port against the full local
stack, labelled **LOCAL FIXTURE — SYNTHETIC DATA — NOT PRODUCTION**. It never reports anything
but `executionMode: "local_fixture"`.

| File | Responsibility |
|---|---|
| `driver/local-stack.ts` | One fresh `buildContainer({environment:"local"})` per call with the REAL business module, FakeClock, memory logger; REAL worker loops run on their own schedule as simulated time passes (`drain`); clients for the public surface only: telephony-control and portal via `fastify.inject`, tools via the HTTP tool route or the MCP SDK client on a 127.0.0.1 listener |
| `driver/call-session.ts` | Per-call Studio steps (TC-01..TC-11), portal secure-link approval with the LOCAL FIXTURE OIDC provider, tool calls with speech rendered through the `TemplateResponseGate`; one backend utterance screening per caller turn, recorded with its `turnIndex`; a session-less `request_human_transfer` (no gateway speech) gets the Studio stand-in's connecting prompt (`transfer.in_progress`, or `language.interpreter_route` for UNSUPPORTED_LANGUAGE) |
| `driver/coordinator.ts` | **LOCAL SIMULATED COORDINATOR**: a deterministic keyword-rule stand-in for the Talkdesk conversational layer. NOT a language model and NOT model evaluation. It defers to the backend safety screen (which runs on every caller utterance first) and never decides authorization; turns it cannot interpret make the run INCONCLUSIVE. Keyword rules of 2026-10-18: a stated non-attendance with an explicit time ("can't make it next week") is the honest cancellation handoff, except that an utterance that also contains one of the guarded words `anymore`, `on my own`, `much longer`, `through` or `this far` is not read as a cancellation on that basis: with no other keyword it stays uninterpreted, and every other keyword rule still applies (one that also names an appointment, session or visit, for example, gets an appointment lookup after verification). The guard is that fixed word list and nothing more: any other idiom next to an explicit time phrase (for example "I can't make it tomorrow because I won't be here.") still reaches the cancellation handoff, and verification starts, whenever the backend screen finds no signal in it (the screen's recall on such lines is an open question for the clinical safety lead, PRQ-008); "what we talked about" / "what we discussed" is a case-status follow-up; a narrow "waiting to hear back from my insurance" claim rule; an explicit hours question outranks a bare billing mention; a role switch needs a stated personal request ("one personal" alone selects no role); after a submitted billing review a follow-up is answered by `get_authorized_case_status`, never a second review, and only a turn that is nothing but an acknowledgement ("Thanks.", "Okay, great.") gets no read, so "Okay, can you give me the reference number again?" is still answered. A tool refused for an invalid session (POLICY_DENIED SESSION_*) gets the approved `verification.failed_generic` notice and re-verification by a person (SF-11c), like any other verification failure. No identity-assertion rule exists (`scn_caller_id_assertion__indirect_or_ambiguous` stays INCONCLUSIVE; corpus-owner decision) |
| `driver/local-driver.ts` | Fixture sets (open case, shared device, slot conflict, adversarial knowledge) established through the public surface; fault plans mapped to real faults (DB grants revoked, fixture faults, scripted transfers, policy-engine failure); faults it cannot inject are refused (`UNINJECTABLE_FAULTS`: REGIONAL_FAILOVER, REDACTION_FAILURE) and never simulated as success. KNOWLEDGE_STALE is injected through the REAL knowledge service: each article version in service for the searched intent gets a successor version (same content and approval) expiring one second later, the pipeline lets it supersede the old version, simulated time passes the expiry, and the fault counts as injected only if no unexpired servable article remains. PARTIAL_WRITE / SCHEDULING_TIMEOUT_AFTER_COMMIT count as injected only if the scheduling effect exists. DUPLICATE_WEBHOOK redelivers every telephony lifecycle event of the call's transfers with the same event id (the telephony fixture's DUPLICATE_DELIVERY) and every outbox message after the first consequential tool; it counts as injected only once a duplicate was actually delivered (driver note `TELEPHONY_DUPLICATE_EVENTS_<n>`). A recording decline before the first caller turn sets the decline STATE in `startCall` (the AI layer is out of the call from then on); only Studio's approved alternative (speech and one SF-13 request) waits for the first step, so faults armed right after `startCall` apply to that transfer |
| `driver/evidence.ts` | `CallEvidence` from authoritative records: ledger rows and fixture effect logs, support requests and their Salesforce trace, transfer journeys, `interaction_outcomes`, egress scans of logs/audit/vendor fixtures, pinned versions; audit event ids count only for streams the platform `IntegrityVerifier` verifies (a numeric-order chain recomputation is kept for attribution only). Transfer-path findings (`transferPathFindings`) become observed-action tokens for `no_duplicate_effect`: `transfer:attempt_history_regressed` (an attempt state repeated, reversed or skipped, or anything after its end), `transfer:attempt_redialled` (a second dial for one attempt, a dial no attempt or journey accounts for, or an attempt started before the previous attempt of its journey failed with TIMED_OUT, RECEIVER_UNAVAILABLE, BRIDGE_DROPPED or FAILED: a re-dial recorded as a new attempt) and `transfer:handoff_record_duplicated` (more handoff support records than the business creation keys allow: one SAFETY record per call, one STANDARD record per transfer reason, the reason read from the template-assembled summary) |
| `driver/run-corpus.ts` | `pnpm evidence run --group journeys|development|heldout_acceptance|risk [--shard k/n]` -> `evidence/runs/<runId>/`; `pnpm evidence combine --runs a,b --out <name>` -> `evidence/evaluation/<name>.summary.json` + `.report.md` (verdicts per group, split, risk class, variant family; failing hard gates; FAIL list) |
| `driver/labels.ts`, `driver/personas.ts` | Badges and labels; synthetic personas (fictional 555-01xx caller ids) |

Demo: `pnpm demo` (`platform/src/demo/run-demo.ts`). Load smoke: `platform/test/load` and
`scripts/load/run-local-load.mts`. Results and numbers: [`docs/TEST_EVIDENCE.md`](../../../docs/TEST_EVIDENCE.md).

## Corpus expectation decisions (2026-10-18)

The local corpus run found expectations that disagreed with spec-correct backend behaviour. They were
fixed in the generators (never by editing generated files) and are guarded by
`corpus.test.ts` "corpus expectations agree with spec-correct behaviour":

| Conflict | Decision |
|---|---|
| `repeat_contact_or_handoff` added a human transfer but kept `supportRequestCreated: false` | Every handoff writes a `summary.human_handoff` support record, so the added transfer expects one (`supportRequestCreated: true`) |
| SALESFORCE_OUTAGE case-follow-up variants expected a transfer and no disclosure | `get_authorized_case_status` reads the internal support record (contract `case_follow_up@1`, source system `support_records`): the outage does not change the authorized answer (`INFORMATION_PROVIDED`). The SALESFORCE_OUTAGE plan (v2) admits `INFORMATION_PROVIDED` for those reads |
| consent_declined drafts approved verification before the decline but expected no disclosure | The authorized read happens before the decline, so it is an expected disclosure; nothing protected follows the decline (`recording:started_after_decline` stays prohibited) |
| concurrent_same_account expected no commit | Its script re-confirms a freshly re-prepared action and its fault plan allows RESOLVED for exactly that path: one fresh, bound commit is expected (no-duplicate and fresh-confirmation checks still apply) |
| BILLING/CLAIMS timeouts expected `create_support_request` while every other read-only timeout expected a transfer | One configured rule for a failed dependency read: a person (the coordinator's documented rule) |
| appointment_cancel expected a committed cancellation | Cancellation is not in the spec's initial workflow catalogue and no catalogued tool expresses it: verified honest handoff, no prepare or commit (`tool:commit_appointment_change` prohibited); crash-after-commit drafts no longer use cancel (522 drafts) |
| PARTIAL_WRITE (afterExternalCommit) expected OUTCOME_UNKNOWN only | Once the fixture records the booking under the idempotency key, the reconciled commit can end RESOLVED like the other after-commit faults; the plan (v2) adds `no_duplicate_effect` and still excludes a silently dropped action (INFORMATION_PROVIDED / DECLINED_BY_POLICY) |
| crash_after_commit drafts 013-018 (slot-conflict flow) confirmed once, so the slot conflict consumed the only commit and the commit-point fault never fired (hard-gate FAIL on `reconciliation_recorded`) | The flow conflicts and recovers like the skeleton and journey 1 (two confirmations, two prepare/commit pairs, `slt_synthMorganSlot0001` permitted); the fault lands on the second commit. Draft version 2; held-out draft 017 changes content as part of this generator-wide fixture fix, which is not aimed at system behaviour. The hangs_up drafts (014/016/018) keep their PRQ-033 outcome placeholder |
| payer_claim_inquiry `dependency_failure` paired CLAIMS_TIMEOUT (before `get_claim_status`) with an unverified payer who never reaches that tool (AUTH-01, AUTH-05) | IDP_UNAVAILABLE (before `begin_verification`), skeleton v2; CLAIMS_TIMEOUT stays covered by `scn_claim_status__dependency_failure`. `CLAIMS_TIMEOUT.appliesToIntents` still lists payer_claim_inquiry: whether a payer with verified affiliation may query claim status is a corpus/business owner scope decision, not settled here |
| journey 1 AUTH_EXPIRY_MID_CALL expected DECLINED_BY_POLICY with no commit attempt | The commit is refused SESSION_EXPIRED (AUTH-04), nothing commits and the caller is routed to re-verification by a person: `TRANSFERRED`, `STANDARD_HUMAN`, version 2, persona and script describe the expiry (the conflict-only turn is dropped). Deciding sources are repository-derived: `talkdesk/studio-flow-spec.md` SF-11c, SF-12 step 3 and SF-11a, and `scenarios/fixtures/failures/AUTH_EXPIRY_MID_CALL.json` (`outcome_in`, `callerVisible`); the specification itself requires only the fail-closed refusal and an accurate outcome label. After the SESSION_* denial the local harness speaks the approved `verification.failed_generic` notice ("I wasn't able to complete verification. I can connect you with a person who can help.") and then Studio's `transfer.in_progress` connecting prompt for the session-less human route (asserted in `driver/local-driver.test.ts`); the PASS itself is scored on tools, backend state and outcome |
| auth_gate_string_values 027-032 (a session reused from a previous call, expired, or of another call) expected DECLINED_BY_POLICY | The presented session is refused SESSION_* (AUTH-04, AUTH-07), nothing protected is disclosed and the caller is routed to a person (SF-11c): `TRANSFERRED`, `STANDARD_HUMAN`, version 2; the other 26 values keep DECLINED_BY_POLICY. No agent instruction covers a SESSION_* denial (noted in `talkdesk/ai-agent-config.yaml`) |
| consent_declined decline-first safety drafts (010/012/022/024) expected the agent tool `request_safety_route` | After the SF-04 decline the AI agent is not used: the Studio alternative is `request_human_transfer` via telephony_control and the `SAFETY_PRIORITY` handoff stays the hard check (in this LOCAL harness the backend utterance screen raises it; in Studio the documented entry is SF-S from the human agent, VQ-TD-07). Version 2; risk-first drafts keep `request_safety_route` |
| otp_read_aloud_attempt and role_switch_mid_call indirect variants never stated the request their expected sequence presumes | A second indirect line states it (expectations unchanged); skeleton v2, which re-versions all eight variants |

A changed scenario keeps its id and gets a new version (skeleton `skeletonVersion`, draft `version` in
`generate-risk.ts`, faulted-journey `override.version`): results are keyed by scenario ID/version, ids are
never renumbered or reused, and the stable split never moves a scenario.

**Fault reachability guard** (`faultReachabilityProblems`, run by `planRiskFiles`; problems exit 2 like
`validateReferences`). For risk drafts: (a) a BEFORE_TOOL / AFTER_TOOL_RESULT trigger that names a tool needs
that tool in the expected sequence; (b) on `synthetic_world_slot_conflict` an afterExternalCommit fault on
`commit_appointment_change` needs at least two confirmations; (c) a `tool: null` trigger needs a consequential
tool, and a DUPLICATE_DELIVERY fault (DUPLICATE_WEBHOOK) is also reached by a transfer tool
(`DUPLICATE_DELIVERY_TRANSFER_TOOLS`). That allowance is valid only together with the harness change of the
same fix (the driver redelivers the call's telephony transfer events, marks the fault injected only once a
duplicate was delivered, and `no_duplicate_effect` observes dials, state history and handoff records on the
transfer path); without it the rule is "a consequential tool" only and the transfer-only DUPLICATE_WEBHOOK
drafts 019/021/023 are flagged (retired, never renumbered). On the pre-fix drafts the guard flags exactly the
six slot-conflict crash drafts. It is not applied to the routine skeleton corpus: rule (a) would flag
`scn_representative_minor_access__dependency_failure`, whose fault is reached only because the coordinator
calls the tool (corpus owner and privacy counsel, PRQ-027).

**Held-out disclosure (spec section 16, "separate development scenarios from held-out acceptance
scenarios").** Held-out scenarios changed by these fixes: `scn_risk_crash_after_commit_017` (script, generator-wide
fixture fix), `scn_risk_auth_gate_string_values_031` (expectation, family-wide), and
`scn_role_switch_mid_call__indirect_or_ambiguous` (the skeleton edit was made after inspecting that held-out
scenario's failure; `__verification_failure` changes version only). Post-fix results for
`scn_role_switch_mid_call__indirect_or_ambiguous` are not independent acceptance evidence.

Simulated-coordinator rule added with KNOWLEDGE_STALE: when `search_approved_runbook` returns no
current approved article, the gateway speaks `knowledge.no_answer` ("I can connect you with a
person") and the coordinator routes to a person. This also makes visible that the knowledge search
returns nothing for `human_request`, `case_follow_up` and `notification_question` with the default
query (the intent name does not occur in the article text) and for every Spanish FAQ; runs that used
to end `INFORMATION_PROVIDED` with zero articles (for example "What are your hours?") now end
TRANSFERRED and fail `task.outcome` honestly. The fix belongs to the knowledge corpus / business
knowledge search owners.


## Test truth (WP-01, 2026-10-19)

Commands (repository-relative; nothing here is billable or calls a vendor):

```sh
pnpm --filter @vsp/platform exec vitest run src/evaluation test/invariants   # unit + invariant suites
pnpm --filter @vsp/platform scenarios:check        # generators in --check mode: drift, leakage (must be 0), manifests, corpus guard
pnpm evidence corpus-lock                           # guard report; --write advances the lock only when lockMayAdvance
pnpm evidence run-partition --partition <journeys|development|tuning|heldout_acceptance|regression|risk> [--shard i/n] \
  --run-id <run_...> [--rerun-of <run ids>] [--supersedes <aggregate>] --reason <CODE> [--source-tree <label>]
pnpm evidence combine-runs --runs <run ids> --out corpus-local-<date><wave> --supersedes <previous aggregate> --reason <CODE>
pnpm evidence rerun --scenario <id> --version <v> --repetition <n> --seed <seed> --rerun-of <runId>
pnpm evidence traceability --vitest-report <json>... --opa-report <json>... --json ../evidence/test-reports/traceability.json
```

- **Fixed denominators (FO-17-14).** `scenarios/manifests/required-scenarios.json` lists every required run
  per gate (local, ci, sandbox, staging, production). A gate PASSes only when every required run is PASS;
  `taskCompletionRate` and every slice rate are PASS / required. A run that did not happen is NOT_RUN and
  counts as not-PASS.
- **Splits and lineage (FO-17-16, FO-17-17).** The split key is the intent skeleton (`<intent>:<account>` is
  the `DatasetItem.familyKey`), so variants and synthetic accounts never straddle splits; `scenarios:check`
  fails on any family or intent in two splits and on any scenario whose split is not the one its family key
  assigns (`misassigned`, e.g. a whole development family relabelled held-out). The lineage file
  (`corpus-lineage.v2`) records each scenario's previous split and every reason it is not independent
  acceptance evidence (`independenceBlockers`): `NOT_HELDOUT`, `MOVED_INTO_HELDOUT` (a development scenario
  under `scenario-split.v1`), `INTENT_FAMILY_EXPOSED` (a scenario of its intent skeleton, itself or another, was
  development evidence under `scenario-split.v1`; journeys always were) and `REVISED_AFTER_RUNS` (version > 1). No
  committed held-out scenario is independent today (0 of 225: every held-out intent family had development
  members under the scenario-level split); the combined summary reports the count and the blocker totals.
  Summaries written before `corpus-lineage.v2` used the scenario-only rule (34 of 225 for w5); the correction
  is `evidence/evaluation/corpus-local-20261019w5.lineage-erratum.{json,md}` (`evidence/evaluation/tools/
  lineage-erratum.mts`), and the w5 summary and report are unchanged.
- **Fault reach (FO-17-11).** `evidence.fault_reached.<fault>` is PASS only when the plan's reach rule matches
  backend evidence (`reached === true`); no rule, uncollected evidence (`reached: null`) and a collected miss
  (`reached: false`) are all INCONCLUSIVE and record no `reachedFault`, so a fault scenario can never PASS on
  the driver's word. `fault-reach.test.ts` exercises every rule source on its MATCH (with the exact evidence
  pointer), NO_MATCH (the near misses: another tool, status, reason code or session state; non-adjacent or
  reversed transfer states; an ambiguous commit without an external effect; verification that raised
  assurance; a zero or malformed emulator count; a template that was not rendered) and NOT_COLLECTED branches,
  and the scorer on each of the three observations. The telephony `emulator_log` counter (`DUPLICATE_WEBHOOK`)
  is computed from the telephony emulator's own delivery log and still carried in the driver's notes (typed
  collector fields are a driver change, WP-34). The outbox redelivery count (`DUPLICATE_REDELIVERIES_n`) is the
  driver's own account of what it re-published: a `driver_self_report` rule, never reach evidence. When it is
  the only signal the observation is `reached: null` with observedBy `driver_notes.outbox_redelivered (driver
  self-report)` and the run is INCONCLUSIVE; the 19 w5 results that passed on it are corrected by
  `evidence/evaluation/corpus-local-20261019w5.reach-erratum.{json,md}` (rescore
  `corpus-local-20261019w5.rescore-check-r4.{json,md}`). A requested fault whose plan is absent from the
  scoring context is INCONCLUSIVE (`evidence.fault_plans_present` and `evidence.fault_reached.<fault>`), even
  when the caller passes no `missingFaultPlans`.
- **Mutation per gate (FO-19-04, FO-01-23).** `scorer.mutation.test.ts` has one case per `SCORER_GATES`
  family; adding a gate without a case, or emitting an unregistered assertion id, fails the suite.
- **Scorer version in the release manifest (FO-19-04).** `manifest.ts` adds a `scorer_version` test-evidence
  entry: the digest of the verdict-deciding sources (`SCORER_SOURCES`: aggregate, fault-plan, fault-reach,
  scorer, unknown, vocabulary) and the recorded result of `scorer.mutation.test.ts` in the evidence directory's
  test reports (PASS only when every recorded case passed; a failure blocks even a local manifest; no recorded
  result is NOT_RUN, noted locally and a blocker for live targets).
- **Coverage holes and latency tables (FO-17-15, FO-17-41).** Every coverage-hole field (required runs not
  run, intents, audiences and locales without a passing required run, per-fault requested / reached / reached
  and PASS / not reached counts, unsupported driver steps, INCONCLUSIVE reasons) has its own test, and the
  rendered report has one latency table for each of the eight `LATENCY_DIMENSIONS` (before 2026-10-19 the
  report skipped the language and audience tables, so `corpus-local-20261019w5.report.md` lacks them; its
  summary JSON has all eight, and `corpus-local-20261019w5.latency-addendum.md` renders them with the current
  renderer, `latencySectionOf`). `stats.test.ts` holds value tests of the quantile intervals: known
  order-statistic ranks (1..100 median: estimate 50, interval [40, 61]; 1..1000 p95 [936, 965] and p99
  [983, 998]), null bounds for small samples and tail quantiles, each cross-checked against the binomial
  coverage (at least 95%).
- **Historical classification (FO-17-10).** `historical-classification.test.ts` checks the committed
  classification (`evidence/evaluation/corpus-local-20261019w5.historical-classification.json`) against the
  committed w4 and w5 attributions: every w4 non-PASS run is classified once, with its recorded verdict, in one
  of the four categories and with the cause the attribution gave it; every classified run has a rerun verdict
  that matches the w5 rerun; every w5 non-PASS run that was not historical is listed as newly non-PASS.
- **Rescore check (FO-01-07).** `evidence/evaluation/tools/rescore-check.mts` re-scores every result of a run
  from the call evidence that run stored, with the current scorer, and compares verdict, failure code, gate
  results, every assertion, requestedFault and reachedFault (exit 1 on any difference); it proves that scorer
  changes made after a run leave its verdicts unchanged without rerunning anything.
- **Corpus guard (FO-17-13).** See `corpus-guard.ts` above; nothing in this package can author a review record.
- **Append-only results and reruns (FO-17-12, FO-17-45).** Run directories are created exclusively; each
  result carries `seed` and `rerunCommand`; `run.json` links reruns to the runs and aggregates they rerun or
  supersede with a reason code. The w4 aggregate (`evidence/evaluation/corpus-local-20261018w4.*`) is kept
  unchanged; the w5 aggregate supersedes it.
- **Invariant register (FO-02-28, FO-19-05).** `docs/requirements/catalog.yaml` `register` per invariant;
  `platform/test/invariants/register.test.ts` checks every attribute against its source of truth;
  `platform/test/invariants/failure-injection.test.ts` holds the endpoint failure-injection tests and
  `evaluation-boundary.test.ts` the positive / adversarial / failure tests at this package's boundary.
