# RB-UNSAFE-OUTPUT Unsafe output (clinical boundary or prohibited assertion)

| Field | Value |
|---|---|
| Runbook id | RB-UNSAFE-OUTPUT |
| Severity | SEV-1 |
| Primary owner role | Clinical safety lead (with SRE on-call for containment) |
| Last drilled | NEVER (not yet run) |
| Status | Draft; not executed against any real environment |

## Trigger and detection signals

* `<prefix>-boundary-violation` alarm (`vsp_boundary_violations_total`; dashboard `<prefix>-safety`).
* `vsp_unsupported_clinical_requests_total` spike (dashboard `<prefix>-safety`) together with complaints.
* QA or pilot review finding diagnosis, therapy, clinical screening, medication advice, invented feelings, a promised refund, an eligibility guarantee or another prohibited assertion of a resolution contract.
* Caller or staff report.

## Immediate containment

1. Declare SEV-1. Any confirmed critical event blocks the affected automation (spec section 13); do not wait for an average.
2. Engage the narrowest [kill switch](kill-switch-operations.md): `INTENT` for the affected intent; `MODEL_VERSION` or `VOICE_VERSION` if a version change is implicated; `AI_ADMISSION` if scope is unclear. Safety and human routes stay available.
3. If the caller may be at risk, the safety responder on-call follows up through the approved safety procedure (owned by the clinical safety lead).

## Evidence preservation

* Preserve the response record (template id, slots, authorization reference, sources and versions), the vendor interaction id and the release manifest versions (model, voice, prompts, knowledge snapshot, policy bundle).
* Preserve the audio and transcript in the restricted QA store only if an approved purpose exists; never paste them into tickets or chat.
* Privacy counsel determines whether reporting obligations apply and their deadlines; the software preserves evidence.

## Step-by-step actions

1. Classify: was the output a template (approved text), a bounded paraphrase, or unrestricted model text?
2. Template → clinical safety lead reviews and withdraws or corrects the template version; the template change follows the clinical-scripts approval (PRQ-028).
3. Paraphrase or model text → restrict that response class to deterministic templates (`ResponseGate`, `platform/src/voice`) and add a scenario to the safety corpus with tags `[SAFE-01]` and the variant family.
4. Knowledge-derived → withdraw the article version ([knowledge-release.md](knowledge-release.md)).
5. Re-run the safety and clinical-boundary suite for the affected intent and version; selected nondeterministic cases at least five times.
6. Release the kill switch only with clinical safety lead approval.

## Verification

* The new scenario fails on the previous configuration and passes on the fix.
* Pilot review of all subsequent safety transfers and detected critical events for the intent shows no recurrence.

## Communication roles

Incident commander; clinical safety lead (decision owner); safety responder on-call; privacy counsel (reporting); SRE on-call (switches); Talkdesk administrator (vendor configuration); communications lead.

## Drill requirement

Tabletop before pilot with a synthetic transcript; repeat after any model, voice, prompt or knowledge release.
