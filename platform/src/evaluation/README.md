# Evaluation, traceability and release manifest (`platform/src/evaluation`)

Status: **IMPLEMENTED_OFFLINE**. Everything here runs on synthetic data and labelled local
fixtures. Nothing is VERIFIED_SANDBOX; the human-reviewed corpus, PSTN tests, vendor drivers,
load/quota evidence and manifest signing are BLOCKED (PRQ-012, PRQ-043, PRQ-004/034, PRQ-022,
PRQ-023).

| File | Responsibility |
|---|---|
| `skeleton.ts`, `generate.ts`, `journeys.ts`, `split.ts` | Intent skeletons -> 8 deterministic variant families; the nine journeys and fault-injected journeys; stable hash split; `--check` drift mode |
| `generate-risk.ts` | 522 templated risk-scenario DRAFTS (UNREVIEWED, labelled as not satisfying the 500 human-reviewed requirement) |
| `fault-plan.ts` | `FaultPlan` schema and loader for `scenarios/fixtures/failures` (deterministic, never LLM-generated) |
| `corpus.ts` | Strict corpus loader, coverage statistics, `evaluationCorpusDigest` |
| `runner.ts` | `ConversationDriver` port, `CallEvidence` schema, `runScenarios` |
| `scorer.ts` | Deterministic assertions and hard gates; missing evidence -> INCONCLUSIVE |
| `results.ts` | Append-only JSONL writer under `evidence/runs/<runId>/` (exclusive create; summary/report once) |
| `aggregate.ts`, `stats.ts` | Slices, critical-failure listing, production-weight vs oversampled-risk separation, gate status per environment, Clopper-Pearson / rule-of-three bounds |
| `catalog.ts`, `traceability.ts` | Requirement catalogue loader and `docs/REQUIREMENTS_TRACEABILITY.md` generator |
| `manifest.ts` | `buildReleaseManifest` / CLI -> `evidence/release/release-manifest.<env>.json`. Evidence blockers (`TEST_EVIDENCE_FAILING`, `QUOTA_LOAD_EVIDENCE_FAILING` — any load/quota FAIL blocks) are computed over the **full** evidence list before the schema bounds (128 test / 32 load entries); `boundEvidence` keeps every non-PASS entry when it must drop entries, and `*_TRUNCATED` blocks a live target or any target that would lose a non-PASS entry (OPS-REL-01). Approvals count only when role- and subject-bound to what the manifest releases (`releaseSubjectExpectations`, OPS-APPR-01). The CLI parses flags strictly (unknown / repeated / value-less flags exit 2), supports `--dry-run` (validates the exact command line, writes nothing) and `--source-commit` (must equal git HEAD, else `SOURCE_COMMIT_MISMATCH`) (OPS-REL-02) |
| `cli.ts` | `generate`, `generate-risk`, `corpus`, `traceability`, `manifest`, `run`, `combine` subcommands (`pnpm evidence <cmd>`). `.github/workflows/release.yml` calls `evidence manifest --env … --image-digest … --source-commit … --build-id … --out-dir evidence/runs` (dry run first) and copies the result to `evidence/runs/release-manifest.json` for deploy.yml; `scripts/ci/check-release-manifest.test.ts` executes that step verbatim |
| `evidence.fixture.ts` | TEST FIXTURES ONLY: ideal evidence and `ScriptedConversationDriverFixture` |

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
  `confirmationFresh`, `reconciled`), tool calls with status, session state and audit event id,
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
| `driver/call-session.ts` | Per-call Studio steps (TC-01..TC-11), portal secure-link approval with the LOCAL FIXTURE OIDC provider, tool calls with speech rendered through the `TemplateResponseGate` |
| `driver/coordinator.ts` | **LOCAL SIMULATED COORDINATOR**: a deterministic keyword-rule stand-in for the Talkdesk conversational layer. NOT a language model and NOT model evaluation. It defers to the backend safety screen and never decides authorization; turns it cannot interpret make the run INCONCLUSIVE |
| `driver/local-driver.ts` | Fixture sets (open case, shared device, slot conflict, adversarial knowledge) established through the public surface; fault plans mapped to real faults (DB grants revoked, fixture faults, scripted transfers, policy-engine failure); faults it cannot inject are refused (`UNINJECTABLE_FAULTS`: REGIONAL_FAILOVER, REDACTION_FAILURE) and never simulated as success. KNOWLEDGE_STALE is injected through the REAL knowledge service: each article version in service for the searched intent gets a successor version (same content and approval) expiring one second later, the pipeline lets it supersede the old version, simulated time passes the expiry, and the fault counts as injected only if no unexpired servable article remains. PARTIAL_WRITE / SCHEDULING_TIMEOUT_AFTER_COMMIT count as injected only if the scheduling effect exists |
| `driver/evidence.ts` | `CallEvidence` from authoritative records: ledger rows and fixture effect logs, support requests and their Salesforce trace, transfer journeys, `interaction_outcomes`, egress scans of logs/audit/vendor fixtures, pinned versions; audit event ids count only for streams the platform `IntegrityVerifier` verifies (a numeric-order chain recomputation is kept for attribution only) |
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

Simulated-coordinator rule added with KNOWLEDGE_STALE: when `search_approved_runbook` returns no
current approved article, the gateway speaks `knowledge.no_answer` ("I can connect you with a
person") and the coordinator routes to a person. This also makes visible that the knowledge search
returns nothing for `human_request`, `case_follow_up` and `notification_question` with the default
query (the intent name does not occur in the article text) and for every Spanish FAQ; runs that used
to end `INFORMATION_PROVIDED` with zero articles (for example "What are your hours?") now end
TRANSFERRED and fail `task.outcome` honestly. The fix belongs to the knowledge corpus / business
knowledge search owners.

