# platform/src/safety: safety signals, deterministic routing, clinical boundary, conversation guard

Status: **IMPLEMENTED_OFFLINE**. Verified only by local unit, property and PGlite
tests on SYNTHETIC text. Nothing here has been clinically reviewed, evaluated on
real or consented speech, or run on a telephone path. This module does not make
the platform clinically safe or compliant on its own; accountable humans own the
clinical procedures it routes into.

## What is implemented

| File | What it does |
|---|---|
| `text.ts` | Deterministic normalization (accents, apostrophes, fillers, sentence/clause markers) and a small phrase-pattern compiler. Caller text stays in memory. |
| `lexicon.ts` | **LOCAL DRAFT lexicon** (`LEXICON_VERSION`, `PENDING_CLINICAL_APPROVAL`): en-US and es-US phrase rules with stable rule ids, idioms, negation / historical / recency / third-party cues, administrative-context words, partial risk lexemes, a short multilingual lexeme screen and local distress cues. |
| `detector.ts` | `RuleBasedSafetySignalDetector` (EXPLICIT_PHRASE, CALLER_REQUEST, ASR_UNCERTAIN, unsupported locale), the `SemanticSignalDetector` interface with `LocalHeuristicSemanticDetector` (**LOCAL FIXTURE**), `CompositeSafetySignalDetector`, `humanInterventionSignal()`, `failSafeSignal()` (source `FAIL_SAFE`), strict `SafetySignalSchema`, deployment checks. |
| `clinical-boundary.ts` | `RuleBasedClinicalBoundaryDetector`: diagnosis, medication, therapy-advice and screening questions in en/es → `CLINICAL_BOUNDARY_ROUTE`. Administrative mentions ("reschedule my therapy session") do not trigger it. |
| `router.ts` | `DeterministicSafetyRouter` (implements `SafetyRouter`), `StickySafetyRouter` + `InMemorySafetyModeStoreFixture`, `safetyModeFromRiskFlags()`. |
| `conversation-guard.ts` | Pure `decide(state, event)` and the `ConversationGuard` wrapper: turn, silence, refusal, guardrail-trigger, duration and cost limits that only ever CONTINUE, PLAY_TEMPLATE, OFFER_HUMAN, TRANSFER_HUMAN or SAFETY_ROUTE. There is no terminate or hang-up action. |
| `safety-events.ts` + `migrations/0610_safety_events.sql`, `0611_safety_fail_safe_source.sql` (adds `FAIL_SAFE` to the allowed `signal_sources`) | `SafetyEventRecorder`: a content-free, append-only `safety_events` table (RLS by tenant), with an audit event per phase written through the `AuditWriter` port in the same transaction. Time from validated signal to route initiation is measured with the injected `Clock` against the 2 s target, and utterance-to-detection latency separately. |
| `pipeline.ts` | `SafetyPipeline.evaluate()`: detector + clinical detector + router in one call. |

### Behaviour

- **Multiple signals.** Explicit phrases, the local "semantic" heuristic, uncertain ASR, caller requests (crisis line, clinician now) and human intervention.
  - Both rule languages run on every supported-locale utterance, because callers code-switch.
  - Detection is never claimed complete. Deterministic policy, not a model, picks the route.
- **Negation is never ignored.** "I don't want to kill myself" gives an UNRESOLVED, `negated: true` signal that still routes to a human.
  - **Negation scope.** A negation cue covers risk content within 5 tokens in the same clause. Its scope ends at a clause breaker ("but", "pero", commas) and at a coordinator that opens a new clause with its own subject ("I don't sleep anymore **and I** want to die" is not negated). A disjunction carries the scope ("not going to hurt myself **or** kill myself": both negated).
  - **Residual risk content.** A negated frame never cancels later risk content: "I'm not saying I'd do anything, but sometimes I wish I wouldn't wake up" raises `indirect.en.passive_ideation` (UNRESOLVED, not negated). "I don't think I'm suicidal, but I've been looking up ways to die" raises the negated `explicit.en.suicide_term` and a CREDIBLE `indirect.en.method_research`. Negations that are part of the risk content ("wouldn't wake up", "if I wasn't here", "no le veo sentido a seguir viviendo") sit inside the pattern and never mark the signal negated.
- **Historical references** give UNRESOLVED HISTORICAL signals. A recency cue in the same clause ("again tonight") overrides them.
- **Third-party concerns** come from reflexive forms or a backward clause scan, and are labelled `THIRD_PARTY`. Threats to the caller ("he is going to kill me") are separate rules.
  - Warning-sign families (UNRESOLVED): `indirect.en.not_being_around` ("talking about not being around much longer"), `indirect.en.farewell` ("posting goodbye messages", "saying goodbye to people"), giving possessions away, and the es counterparts `indirect.es.farewell` ("mensajes de despedida", "se está despidiendo de todos", "regalando sus cosas").
- **Unspecified past attempts** (`indirect.en.attempt_unspecified`, `indirect.es.attempt_unspecified`): intransitive "I attempted a few days ago", "made an attempt", "hospitalized after an attempt", "tuve un intento", "sobreviví a un intento". An object ("attempted to log in", "the payment", "intento de pago") never matches, and the rule is suppressed when the sentence is about an administrative object.
- **Passive ideation and ambivalence** (`indirect.en.passive_ideation`, `indirect.en.ambivalence_living`, `indirect.es.passive_ideation`, `indirect.es.no_point_living`): "I wish I wouldn't wake up", "it'd be easier if I wasn't here", "I'm not sure I want to live anymore", "ojalá no despertara", "sería más fácil si yo no estuviera", "no le veo sentido a seguir viviendo". Benign completions ("wake up late", "if I wasn't here at eight") are excluded by whole-word lookaheads.
- **Recurrence** (`indirect.en.recurrence`, `indirect.es.recurrence`): "those thoughts are back", "after what happened ... thinking about it again", "volvieron esos pensamientos". Ambiguous: suppressed with an administrative object and never upgraded by a recency cue. A bare "thinking about it again" is deliberately not a rule.
- **Whole-word lookarounds.** Every lookahead exclusion list ends at a word boundary (a structural test enforces this). Before 2026-10-18 the lists matched word prefixes, so "I'm going to jump tonight" was excluded by "to" and "jump at midnight" by "a"; the `wanna`/`gonna` alternatives were also written as "wanna to", which never matched.
- **Idioms** ("this bill is killing me", "I could die of embarrassment", "dead tired", "me muero de vergüenza") are masked before rules run.
  - Masking is restricted to thing or "you" subjects. "My husband is killing me" stays a signal.
  - Ambiguous distress about an administrative object (hold music, bill, portal) is treated as frustration: no signal.
- **ASR uncertainty.** Below the confidence threshold (default 0.6, a placeholder), any partial risk lexeme in the unmasked text gives UNRESOLVED `ASR_UNCERTAIN`.
  - This is deliberately conservative: when recognition is uncertain, so is the idiom reading.
  - An out-of-range confidence counts as low.
- **Unsupported locale** means `interpreterRequired: true`. A multilingual or partial risk lexeme also gives UNRESOLVED `locale.unsupported.risk_lexeme`, which routes to safety priority with the interpreter accommodation.
- **Fail safe (`FAIL_SAFE` source).** Malformed input (`input.invalid.fail_safe`), oversized input (`input.oversize.fail_safe`), malformed signals (`signal.malformed.fail_safe`), a crashed rule stage (`rules.stage_failed.fail_safe`) and a failing semantic stage on an utterance with a partial risk lexeme (`semantic.unavailable.risk_lexeme`) raise an UNRESOLVED signal with source **`FAIL_SAFE`** (previously reported as `ASR_UNCERTAIN`, which conflated recognizer uncertainty with system fail-safe). It always routes to `SAFETY_PRIORITY_HUMAN`; with only fail-safe signals the reason code is `SAFETY_INPUT_UNASSESSED_FAIL_SAFE` and `safetyRoutingReason` is `FAIL_SAFE` (also a value of `HandoffPackage.safetyRoutingReason`). Metrics use `signal_source="fail_safe"`. A malformed router context still means safety mode active. None of them returns "no signal". A semantic-stage failure on an utterance **without** any partial risk lexeme keeps the rule-stage assessment and is reported as degraded coverage (`coverage.semanticDetector.degraded`, warning log), not as a safety route: the rule stage did assess the utterance.
- **Routing.** Any signal, or a call already in safety mode, routes to `SAFETY_PRIORITY_HUMAN`. The decision sets:
  - `acknowledgmentTemplateId: "safety.acknowledgment"`, `destinationId: "dst_safety_priority"`, `revokePendingActions: true`, `suspendAdministrativeAutomation: true`;
  - `requiresAuthentication: false`, with no identity input at all (SAFE-02);
  - `externalEmergencyConferencing: "NOT_AUTOMATED_HUMAN_OWNED"`.

  After hours the route is the same; the transfer coordinator's staffed fallback chain handles unavailable responders. A clinical question alone routes to `CLINICAL_BOUNDARY_ROUTE` (`clinical.boundary`, `dst_clinical_route`). Safety always takes precedence.
- **Port fields.** `SafetyDecision` (ports.ts) now has the optional extended fields `enterSafetyMode`, `riskFlagToSet`, `interpreterRequired`, `transferReason` and `externalEmergencyConferencing`; `DeterministicSafetyRouter` always sets them (its `SafetyRoutingDecision` makes them required). Older callers that build a minimal `SafetyDecision` still compile.
- **Sticky safety mode.** The decision returns `riskFlagToSet: "SAFETY_ESCALATION_ACTIVE"`. Callers persist it in the session, and `safetyModeFromRiskFlags()` reads it back. Automation never clears it.
- **Guard (SAFE-03).** In safety mode every event produces a `SAFETY_ROUTE` action to `dst_safety_priority`:
  - budget exhaustion gives `MAINTAIN` / `SAFETY_RESERVE_IN_USE`;
  - a failed transfer gives `UPDATE_CALLER` with `transfer.safety_update`;
  - a caller disconnect gives `NOTIFY_SAFETY_RESPONDER`.

  During an active transfer, limits are ignored and only a safety signal escalates. Outside safety mode, limits offer and then transfer to a human:
  - silence goes to the accessibility route;
  - budget exhaustion goes to continuity (`dst_outage_continuity`);
  - an unsupported language goes to the interpreter.

  The application guardrail limit must stay below the vendor trigger limit, so the call is transferred before the vendor closes it.
- **Evidence (DATA-01, OPS-01).** Every `safety_events` column is an opaque id, a closed-set code, a boolean, a bounded integer or a timestamp, each enforced by a check constraint.
  - Latency must match the timestamps. TRANSFERRED requires a transfer id. The table is append-only for every role, the owner included.
  - If the audit write fails, the row is still kept as `AUDIT_UNAVAILABLE`. If the database is down, the result says so.
  - Recording never throws into, or delays, the safety route.

## LOCAL FIXTURES (labelled)

- `LocalHeuristicSemanticDetector` (`kind: "local_fixture"`, badge "LOCAL HEURISTIC — NOT AN APPROVED SEMANTIC CLASSIFIER").
- `InMemorySafetyModeStoreFixture`, and the in-memory state map of `ConversationGuard` (`kind: "local_fixture"`). In a deployment the latch is the session risk flag and the guard counters live with the session.
- `__fixtures__/utterances.json`: 231 SYNTHETIC cases (en-US and es-US, including 6 unsupported-locale cases), written by the coding agent. They are **not** clinician-reviewed or native-speaker-reviewed. Version `2026-10-18.draft.2` added 50 cases: the phrasings the local corpus run missed (risk drafts and routine indirect variants) and precision probes that reuse the same words administratively ("attempted to log in", "wake up late for my appointment", "intento de pago", "no le veo sentido a pagar dos veces").
- `__fixtures__/audit-writer.fixture.ts`: `RecordingAuditWriterFixture`. In-test only; not durable or independent evidence. The real `PgAuditWriter` is also exercised in one integration test.

## BLOCKED (needs a human or external prerequisite)

| Item | Why blocked | Prerequisite |
|---|---|---|
| Clinical approval of the lexicon, the acknowledgment / boundary / safety-update scripts and the routing procedures (immediate danger, ambiguous concern, third party, refusal, disconnect, after hours, unavailable responder) | The coding agent cannot approve clinical content or procedures | Clinical safety lead: approved escalation scripts, staffed response plan, external transfer agreements, after-hours protocol (spec §5) |
| Real semantic classifier | No approved model, data path or evaluation exists offline. Sending caller text to an endpoint needs BAA and service coverage (DATA-01) | Approved model and endpoint, privacy approval, evaluation evidence against a reviewed corpus |
| Reviewed lexicons and corpus for en/es and other languages; the 500 human-reviewed safety and clinical-boundary scenarios (spec §14) | The corpus is developer-authored, and the multilingual screen is a short unreviewed list | QA and language leads, native-speaker reviewers, clinical review of labels |
| ASR confidence threshold | Confidence semantics are vendor-specific | ASR vendor documentation plus calibration on consented telephone audio |
| Vendor guardrail trigger limit and an early safety signal before refusal or termination (TB-05) | Talkdesk behaviour is not evidenced (spec §2) | Talkdesk tenant evidence. Without it the autonomous flow does not launch. |
| Operational guard limits (turns, silences, refusals, per-call cost) | `DEFAULT_GUARD_LIMITS` are planning placeholders | Support operations and safety lead values; finance for the cost limits |
| End-of-utterance timestamps (detection latency) and transfer events | Vendor event exports are unknown (TB-07) | Talkdesk event export evidence |
| External crisis or emergency conferencing | Never automated by design | Human safety responder procedures and operational agreements |

`safetyDetectorDeploymentViolations()` reports `SAFETY_LEXICON_NOT_APPROVED` and `SEMANTIC_DETECTOR_LOCAL_FIXTURE` (or `SEMANTIC_DETECTOR_MISSING`) outside local/ci, so a production configuration cannot treat this as approved.

## Known limitations (honest)

- **The lexicon is not complete and still requires clinical review (PRQ-008) and a reviewed, native-speaker-checked corpus (PRQ-012).** Every phrase family is a developer draft. The 2026-10-18 widening came from failures in the local corpus run (`run_local_20261018c_risk_*`), so the corpus that now passes was partly written from the misses; it is not held-out evidence.
- Precision / recall of the safety route, measured locally on 2026-10-18 (positive = expected `SAFETY_PRIORITY_HUMAN`):

  | Set | Before (lexicon draft.2) | After (draft.3) |
  |---|---|---|
  | Utterance corpus, 231 cases | precision 100.0 %, recall 78.8 % (28 FN, 0 FP) | precision 100.0 %, recall 100.0 % (0 FN, 0 FP) |
  | Scenario corpus, 1077 scenarios (any caller turn screened to the safety route) | precision 87.3 %, recall 78.6 % (28 FN, 15 FP) | precision 87.9 %, recall 100.0 % (0 FN, 18 FP) |

  The scenario-corpus false positives are deliberate conservative routing: 15 borderline risk drafts with a negated-only or remote historical reference (the drafts expect no route; whether a check-in is required is a clinical decision, PRQ-008), 2 "crisis team" mentions and 1 low-confidence ASR idiom. The 3 new ones are "hospitalized after an attempt" (remote historical, UNRESOLVED HISTORICAL by design, like "years ago I tried to kill myself").
- Known over-escalation risks of the new families: someone "saying goodbye to people" because they are moving, a provider who "won't be here much longer", "I attempted yesterday but it didn't go through" without an administrative word. All route to a human; none is silent.
- Regex phrase detection is not complete or infallible. A developer held-out probe of 25 phrasings (17 risk, 8 benign), run before they were added to the corpus, missed 11 of the 17 risk phrasings. The lexicon was widened, and those phrasings are now regression cases, but other phrasings will still be missed. Independent held-out evaluation is still required.
- The corpus confusion matrix (printed by `detector.test.ts`) shows 0 errors because rules and labels were written together. It is not evidence of population performance.
- Conservative choices over-escalate in some cases, for example:
  - a person-subject idiom ("my kids are killing me");
  - "I don't need the crisis line" (negated request, still routed);
  - low-confidence ASR on an idiom.
- Negation and subject inference use a fixed window and do not resolve long-range syntax. A wrong strength label (CREDIBLE vs UNRESOLVED) still routes identically.
- The multilingual screen cannot read scripts or languages that are not listed.

## How to test

```bash
cd platform
npx vitest run src/safety          # unit + property + PGlite migration tests (prints the corpus confusion matrix)
npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E "src/safety|src/voice"   # expect no output
npx eslint src/safety
```

## Requirement coverage

| ID | Enforcement | Tests |
|---|---|---|
| SAFE-01 | `clinical-boundary.ts`, `router.ts` (boundary route); templates checked in `voice/registry.ts` | `clinical-boundary.test.ts`, corpus clinical and medication cases, `router.test.ts` |
| SAFE-02 | `router.ts` takes no identity input and sets `requiresAuthentication: false`; guard human and safety actions require no authentication | `router.test.ts`, `safety-flow.test.ts`, `conversation-guard.test.ts` |
| SAFE-03 | `conversation-guard.ts` `decide()` | `conversation-guard.property.test.ts`, `conversation-guard.test.ts`, `safety-flow.test.ts` |
| SAFE-04 (evidence side) | `safety_events` requires a transfer id for TRANSFERRED | `safety-events.test.ts` |
| SAFE-05 | Fixed allowlisted `dst_safety_priority`; caller text never selects a destination | `router.test.ts` |
| DATA-01 | Signals are closed-set values; content-free table and audit inputs; content-free logs | `detector.test.ts`, `detector.property.test.ts`, `safety-events.test.ts` |
| OPS-01 | Row and audit event in one transaction; append-only table | `safety-events.test.ts` |
| SPEC-10 / SPEC-2 / SPEC-12 topics | See the test-title tags `[SPEC-10.*]`, `[SPEC-2.guardrail]`, `[SPEC-12.budget]` | all test files above |

## Integration notes for other modules

- The transfer coordinator's `updateTemplateIds` should be `{ STANDARD: "transfer.failed_next_route", SAFETY: "transfer.safety_update" }`.
- Handoff packages can take `safetyRoutingReason` from `SafetyRoutingDecision.safetyRoutingReason`, and the interpreter accommodation from `interpreterRequired`.
- Gateway and kill switches must admit `SAFETY` / `HUMAN_ROUTE` independently of this module's recording success.
