# platform/src/voice: approved templates, before-speech response gate, turn tracking, speech queue

Status: **IMPLEMENTED_OFFLINE**. Templates are a LOCAL DRAFT: **no template is approved**.
Nothing here proves that the vendor speech path (Talkdesk native AI) validates a
protected utterance before audio is emitted (TB-04 UNKNOWN). This is the
deterministic rendering path that a validated runtime would use.

## What is implemented

| File | What it does |
|---|---|
| `templates/en-US.json`, `templates/es-US.json` | 36 templates per locale with ids, versions, response classes, typed slots, approval status and review metadata. Every template is DRAFT, PENDING_CLINICAL_APPROVAL (SAFETY, CLINICAL_BOUNDARY) or PENDING_LEGAL_APPROVAL (recording, consent, disclosure). Safety and clinical text are short neutral procedural placeholders marked `[PENDING CLINICAL SAFETY LEAD APPROVAL]`; they are not clinical guidance. Spanish is marked `PENDING_NATIVE_SPEAKER_REVIEW`. |
| `registry.ts` | `CatalogTemplateRegistry` (implements `TemplateRegistry`). It validates catalogs strictly, and `digest()` is sha256 over the canonical catalog set (independent of file order) for `VersionSet.promptTemplates`. `effectiveApproval()` counts APPROVED only when the `apr_…` record id was verified by the approvals loader. `catalogDeploymentViolations()` / `assertCatalogDeployable()` refuse non-local environments with unapproved required templates. Load fails closed on any of the problems listed below. |
| `slots.ts` | Typed slot validation and table-driven spoken rendering, listed below. |
| `gate.ts` | `TemplateResponseGate` (implements `ResponseGate`), `isGateApproved()`, `isGateFallback()`, `postCheck()`. |
| `turns.ts` | `InMemoryTurnTracker` (implements `TurnTracker`, **LOCAL FIXTURE**). Barge-in invalidates the current turn, a newer generation invalidates older turns, invalidation listeners are available, and the session map is bounded. |
| `speech-queue.ts` | `SpeechQueue` (**LOCAL FIXTURE**). Segments are tagged with turn id and generation. Barge-in stops playback and drops queued segments, and stale segments are dropped again at dequeue. Protected segments that did not pass the gate, forged copies and un-gated text are refused. |

Registry load fails closed on:

- unknown fields;
- placeholders that do not match declared slots, and stray braces;
- class/approval inconsistency, and APPROVED without an approval record;
- missing review markers;
- safety text that is too long or has slots;
- cross-locale drift;
- any diagnostic, therapeutic, screening or medication-advice pattern, or invented-feelings pattern (SAFE-01).

Slot types and how they render:

| Type | Validation | Spoken rendering |
|---|---|---|
| `date` | `YYYY-MM-DD`, a real calendar date | Month name |
| `time` | `HH:MM` | 12-hour time |
| `time_zone` | IANA allowlist | Named zone |
| `money_minor_usd` | Integer minor units | Dollars and cents |
| `person_display_name` | `/^[A-Za-z][A-Za-z .'-]{0,60}$/` | As written, optionally spelled out |
| `support_reference` | Matches the protocol `SupportReference` | Spelled out |
| `enum` | One of the allowed values | Its label |
| `count` | Count | Number |
| `spelled_code` | Letters and digits | Spelled out |
| `portal_path` | Must start with `/portal/` | Readable path |
| `match_code` | Two distinct words of the identity module's match-code list (`identity/match-code.ts`), joined by `-` | The two words with a pause (`maple, otter`); used by the DRAFT template `verification.secure_link_match_code` so the caller can compare it with the portal. Not a secret. |

### Gate order (fail closed, before the first audible segment)

1. Strict `SpeechDirective` and `GateContext` parsing. Unknown fields and dependency free text are rejected.
2. Generation and turn must be current (`STALE_GENERATION` / `STALE_TURN`); the optional turn tracker is checked too. A stale result is **dropped silently** (`DROP_STALE`), so a late result never speaks into a new state.
3. The template must exist for the locale, and its version and response class must match.
4. Approval. Outside `local`/`ci` (that is, sandbox, staging and production), only effectively APPROVED templates render. In local/ci, PENDING/DRAFT templates render with `localUnapprovedBadge: true` for the demo's LOCAL badge.
5. Protected classes (IDENTITY, FINANCIAL_FACT, COMMITMENT, PROTECTED_FACT) need `authorizationRef ∈ ctx.validAuthorizationRefs`. **SAFETY, CLINICAL_BOUNDARY and RECORDING_DISCLOSURE are exempt.** They must render at A0 for an unverified caller (SAFE-02) and disclose no account data. Generic verification prompts are GENERIC_STATUS for the same reason: they are enumeration-safe and are spoken before any account is located.
6. FINANCIAL_FACT, PROTECTED_FACT and COMMITMENT must cite `sourceRefs`.
7. Slots: none missing, none extra, each valid for its type.
8. Post-check: no braces, control characters, `undefined`/`null`/`NaN` artifacts or prohibited clinical content, and at most 500 characters.

Any failure returns `fallback.safe_explanation` plus `routeToHuman: true`. If the fallback itself is not approved for the environment, the disposition becomes `ROUTE_HUMAN_WITHOUT_SPEECH` and the human route proceeds without speech. A success result is frozen and carries a content-free `record` (template, version, class, approval, authorizationRef, sourceRefs, turn, generation, catalog digest), never slot values. "Let me check that." is flagged `acknowledgmentOnly` and never counts as resolution.

## BLOCKED

| Item | Why blocked | Prerequisite |
|---|---|---|
| Approval of every template | The coding agent cannot approve | Clinical safety lead (SAFETY, CLINICAL_BOUNDARY); privacy counsel (recording, consent, disclosure, per jurisdiction); support operations (DRAFT); QA and language leads (es-US native review). Signed approval records verified by the config approvals loader. |
| Real company name in `opening.disclosure` | The enum value is the SYNTHETIC "Synthetic Support Co" | Approved catalog for the tenant |
| LOW_RISK_GROUNDED bounded paraphrase (model-generated text) | Not implemented as free generation; approved output checks do not exist | Approved output-check design and evaluation. Until then only templates render. |
| Before-speech guarantee on the vendor path (TB-04) | Talkdesk capability unknown | Vendor evidence, or the fallback speech runtime (ADR-0006) |
| Live turn tracker and speech queue | In-process fixtures only | Speech runtime with per-call affinity (vendor or ADR-0006) |
| Time-zone list and Spanish formatting | Local choices | Support operations and language review |

`catalogDeploymentViolations(registry, "production")` currently lists every required template as `REQUIRED_TEMPLATE_NOT_APPROVED`. That is the intended state: production refuses to start (OPS-04).

## How to test

```bash
cd platform
npx vitest run src/voice
npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E "src/voice"   # expect no output
npx eslint src/voice
```

## Requirement coverage

| ID | Enforcement | Tests |
|---|---|---|
| ACT-05 | `gate.ts` (authorization, stale turn and generation, approval per environment, slot types, post-check); `speech-queue.ts` (gate-issued only, stale drop) | `gate.test.ts`, `speech-queue.test.ts`, `slots.test.ts` |
| SAFE-01 | `registry.ts` prohibited clinical-content patterns at load; `postCheck` after render | `registry.test.ts`, `gate.test.ts`, `safety/clinical-boundary.test.ts` |
| SAFE-02 | Authorization exemption for SAFETY, CLINICAL_BOUNDARY and RECORDING_DISCLOSURE; generic A0 prompts | `gate.test.ts`, `safety/safety-flow.test.ts` |
| ACT-04 | Commitment templates never claim resolution; acknowledgment-only flag | `registry.test.ts`, `gate.test.ts` |
| DATA-01 | Content-free response record and logs | `gate.test.ts` |
| OPS-03 / OPS-04 | No approved template; unverified approvals do not count; production refusal | `registry.test.ts`, `gate.test.ts` |
| OPS-06 | `digest()` over the canonical catalog | `registry.test.ts` |
| SPEC-11 topics | Tags `[SPEC-11.*]` (opening, templates, confirmation, acknowledgment, barge-in, interpreter, fail-closed) | as above |
