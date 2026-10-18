# Evaluation, traceability and release manifest (`platform/src/evaluation`)

Status: **IMPLEMENTED_OFFLINE**. Everything here runs on synthetic data and labelled local
fixtures. Nothing is VERIFIED_SANDBOX; the human-reviewed corpus, PSTN tests, vendor drivers,
load/quota evidence and manifest signing are BLOCKED (PRQ-012, PRQ-043, PRQ-004/034, PRQ-022,
PRQ-023).

| File | Responsibility |
|---|---|
| `skeleton.ts`, `generate.ts`, `journeys.ts`, `split.ts` | Intent skeletons -> 8 deterministic variant families; the nine journeys and fault-injected journeys; stable hash split; `--check` drift mode |
| `generate-risk.ts` | 528 templated risk-scenario DRAFTS (UNREVIEWED, labelled as not satisfying the 500 human-reviewed requirement) |
| `fault-plan.ts` | `FaultPlan` schema and loader for `scenarios/fixtures/failures` (deterministic, never LLM-generated) |
| `corpus.ts` | Strict corpus loader, coverage statistics, `evaluationCorpusDigest` |
| `runner.ts` | `ConversationDriver` port, `CallEvidence` schema, `runScenarios` |
| `scorer.ts` | Deterministic assertions and hard gates; missing evidence -> INCONCLUSIVE |
| `results.ts` | Append-only JSONL writer under `evidence/runs/<runId>/` (exclusive create; summary/report once) |
| `aggregate.ts`, `stats.ts` | Slices, critical-failure listing, production-weight vs oversampled-risk separation, gate status per environment, Clopper-Pearson / rule-of-three bounds |
| `catalog.ts`, `traceability.ts` | Requirement catalogue loader and `docs/REQUIREMENTS_TRACEABILITY.md` generator |
| `manifest.ts` | `buildReleaseManifest` / CLI -> `evidence/release/release-manifest.<env>.json` |
| `cli.ts` | `generate`, `generate-risk`, `corpus`, `traceability`, `manifest`, `run`, `combine` subcommands (`pnpm evidence <cmd>`) |
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
| `driver/local-driver.ts` | Fixture sets (open case, shared device, slot conflict, adversarial knowledge) established through the public surface; fault plans mapped to real faults (DB grants revoked, fixture faults, scripted transfers, policy-engine failure); faults it cannot inject are refused (`UNINJECTABLE_FAULTS`) and never simulated as success |
| `driver/evidence.ts` | `CallEvidence` from authoritative records: ledger rows and fixture effect logs, support requests and their Salesforce trace, transfer journeys, `interaction_outcomes`, egress scans of logs/audit/vendor fixtures, pinned versions; audit event ids count only for streams the platform `IntegrityVerifier` verifies (a numeric-order chain recomputation is kept for attribution only) |
| `driver/run-corpus.ts` | `pnpm evidence run --group journeys|development|heldout_acceptance|risk [--shard k/n]` -> `evidence/runs/<runId>/`; `pnpm evidence combine --runs a,b --out <name>` -> `evidence/evaluation/<name>.summary.json` + `.report.md` (verdicts per group, split, risk class, variant family; failing hard gates; FAIL list) |
| `driver/labels.ts`, `driver/personas.ts` | Badges and labels; synthetic personas (fictional 555-01xx caller ids) |

Demo: `pnpm demo` (`platform/src/demo/run-demo.ts`). Load smoke: `platform/test/load` and
`scripts/load/run-local-load.mts`. Results and numbers: [`docs/TEST_EVIDENCE.md`](../../../docs/TEST_EVIDENCE.md).
