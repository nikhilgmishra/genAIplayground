# platform/src/memory: limited, provenance-labelled support memory

Status: **IMPLEMENTED_OFFLINE** (PGlite). Not verified against Aurora. No claim of
HIPAA compliance or production readiness.

Spec: section 9 ("Persist only useful support memory ..."), DATA-04, DATA-03.

## What is implemented

* `ports.ts`: `SupportMemory` port. Added (backward compatible): optional `riskFlags` on `recapFor()`.
* `support-memory.ts`: `SupportMemoryPg` over migration `0700_support_memory.sql`.
* `record()`:
  * strict input schema; `expiresAt` is mandatory and must be in the future; an optional `maxTtlMs` cap can be set from an **approved** retention policy (no default is invented);
  * closed key set per kind with typed formats (UPPER_SNAKE codes, opaque refs, `SR-XXXX-XXXX` support references, ISO timestamps, `q_*` queues, language tags, IANA time zones, non-negative integers, booleans). Free text is rejected, so no clinical narrative can be stored;
  * **DATA-04**: keys naming identity, assurance, consent, authentication/authorization, verification, role, scope, permission, subject/actor, or clinical concepts (diagnosis, medication, symptom, risk, therapy, ...) are rejected (`MEMORY_FORBIDDEN_KEY`); clinical or authorization concepts in code values (e.g. `MEDICATION_QUESTION`, `CONSENT_GRANTED`, `A2`) are rejected (`MEMORY_FORBIDDEN_VALUE`). The database trigger repeats the key check (case-insensitive) and rejects nested values;
  * provenance must match the source: `CALLER_REPORTED` => `call://...`; `VERIFIED` never from a call; `REVIEWED_SUMMARY` => `review://rvw_...` (human review record). Enforced in code and by CHECK constraints.
* `recapFor()`: returns entries only when assurance is **A2/A3** and `authorizedSubjectId === subjectId`; never on A0/A1 (caller ID or a shared phone is not authentication), never for another subject or tenant (RLS requires tenant **and** subject context), never with risk flags `PARTICIPANT_CHANGED`, `ACCOUNT_RECOVERY_IN_PROGRESS`, `FRAUD_REVIEW`, `SAFETY_ESCALATION_ACTIVE`; only unexpired entries (enforced on read, independent of `expire()`); stored rows are re-validated before disclosure.
* **Machine-inferred entries are never recapped as facts.** Decision: a `MACHINE_INFERRED` entry is recap-eligible only when its kind is `REVIEWED_SUMMARY` and its source is a human review record (`review://rvw_...`); it keeps the `MACHINE_INFERRED` label and `recapLabel()` returns `MACHINE_SUMMARY_HUMAN_REVIEWED` so the voice layer can present it as a reviewed summary. Every other `MACHINE_INFERRED` entry is stored (for staff use) but excluded from recaps.
* `recapLabel()` always reports `grantsAuthorization: false, medicalFact: false`. Nothing in this module produces an `AuthContext`, consent state or policy input.
* `expire(now)`: tenant-scoped deletion (role `app_worker`) for the configured tenants.
* Entries are immutable (UPDATE refused by trigger). The retention job deletes by data-class policy (`SUPPORT_MEMORY_DATASET` in `platform/src/retention`), honouring subject legal holds.

Not implemented, by design (spec section 9): nightly "dreaming", self-editing policies, cross-customer memory, online reinforcement learning, automatic retraining. There is no cross-subject read API.

## LOCAL FIXTURES

None in production code. Tests use SYNTHETIC subjects from `fixtures/synthetic-world.ts` and synthetic `call://`, `ledger://`, `review://` references.

## BLOCKED

| Item | Prerequisite |
|---|---|
| Memory data class and maximum horizon | Privacy counsel retention matrix (PRQ-025); `BUSINESS_RECORD` is an engineering default |
| Human review workflow that issues `review://rvw_...` records | Console/workflow module and an approved review procedure |
| Spoken recap templates | Voice template registry approvals (PRQ-028) |

## Tests

```
cd platform && npx vitest run src/memory
```

## Requirement IDs enforced here

DATA-04 (memory cannot establish identity, consent or medical fact; recap only after authentication of the same subject), DATA-03 (mandatory expiry, enforced on read).
