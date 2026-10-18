# ADR-0013 Approval records carry a signed machine-checkable subject and are checked against an approver-role table, in the runtime guard and in the deploy gate

| Field | Value |
|---|---|
| Status | **Accepted for engineering**. Trusted signing key: **BLOCKED** (PRQ-023). Every approval record: **Pending human approval** (PRQ-024); `approvals/` holds no records |
| Date | 2026-10-18 |
| Decided by | Principal engineer (coding agent) for the engineering scope only |
| Approval needed from | Security leadership (signing-key custody, per-role keys, the role table); each scope's accountable approver |
| Related prerequisites | PRQ-023, PRQ-024, PRQ-031, PRQ-032, PRQ-028, PRQ-045 |

## Context

[ADR-0010](ADR-0010-signed-human-approvals.md) made approvals signed human records checked for
signature, scope, environment and validity window. Review finding **OPS-APPR-01**: that was not
enough. An approval named its artifact only in free-text `scopeDetail`, which software never
reads, so a valid `MODEL_VOICE_SELECTION` record for one model could be referenced by a
configuration that runs another, a `POLICY_RELEASE` record for bundle v1 could approve a config
loading v2, and any role could sign any scope. This is threat T-15 (approval replay) in
[`../security/threat-model.md`](../security/threat-model.md). OPS-04: production refuses missing
mandatory approvals; OPS-06: model, voice, knowledge, tools and policy versions are pinned and
reviewable.

## Decision

1. **Signed subject.** `ApprovalRecord` gains an optional `subject` (`ApprovalSubject`,
   `platform/src/protocol/release.ts`), part of the signed payload (the signature covers the
   whole record except `signature`), so it cannot be edited after signing. Members:
   `modelVoice` (model, voice, agentConfig), `policyBundle` (version, sha256 digest),
   `knowledgeSnapshotDigest`, `templateCatalogDigest`, `release.imageDigest`.
2. **Which scope needs which member** (`SUBJECT_KIND_BY_SCOPE`,
   `platform/src/config/approvals.ts`): `MODEL_VOICE_SELECTION` -> `modelVoice`;
   `POLICY_RELEASE` -> `policyBundle`; `KNOWLEDGE_RELEASE` -> `knowledgeSnapshotDigest`;
   `CLINICAL_SCRIPTS` -> `templateCatalogDigest`; `PRODUCTION_DEPLOYMENT` and `PILOT_EXPOSURE`
   -> `release`. Other scopes need no subject.
3. **Equality, fail closed** (`subjectBindingFailure`, used by `evaluateApproval`): the member
   must EQUAL the artifact the caller actually configured or loaded. Outcomes:
   `SUBJECT_MISSING` (scope needs a subject, record has none), `SUBJECT_MISMATCH` (names another
   artifact), `SUBJECT_UNVERIFIABLE` (the caller cannot state the artifact; never VALID),
   `SUBJECT_UNEXPECTED` (a member that does not belong to the scope).
4. **Approver-role table** (`APPROVER_ROLES_BY_SCOPE`): e.g. `PHI_PROCESSING` and
   `RETENTION_SCHEDULE` only `privacy_counsel`; `SECURITY_REVIEW` and
   `STATIC_CREDENTIAL_EXCEPTION` only `security_leadership`; `CLINICAL_SCRIPTS` only
   `clinical_safety_lead`; `BILLABLE_TEST_EXECUTION` only `finance`. Any other role yields
   `APPROVER_ROLE_NOT_PERMITTED`. Changing the table is a reviewed code change.
5. **Both gates apply it.** The runtime configuration guard (`platform/src/config/guard.ts`)
   compares against `models.active`, the loaded policy bundle, and the knowledge snapshot,
   template catalogue and image digests the composition supplies. The release-manifest builder
   (`platform/src/evaluation/manifest.ts`) and the deploy gate
   (`scripts/ci/check-release-manifest.ts`) use `releaseSubjectExpectations`: model, voice and
   agentConfig from `versions.*`, policy by `policyBundleDigest` (digest only; the manifest
   records no bundle label), knowledge by `knowledgeSnapshotDigest`, templates by
   `versions.promptTemplates` only when it is a sha256 digest, image by `build.imageDigest`.
   Unpinned or absent values become null, which makes the record `SUBJECT_UNVERIFIABLE`.

Tests (offline; TEST-ONLY keys and SYNTHETIC subjects created inside the tests, never written to
`approvals/`): `platform/src/config/approvals.test.ts` and `platform/src/config/guard.test.ts`
(`approval binding (OPS-APPR-01)`: subject covered by the signature, wrong model, policy v1 vs
v2, unknown digests fail closed, missing subject, disallowed roles) and
`scripts/ci/check-release-manifest.test.ts`. Status: IMPLEMENTED_OFFLINE.

## Consequences

* An approval now approves one exact artifact. A new model, voice, agent configuration, policy
  bundle, knowledge snapshot, template catalogue or image needs a new signed record.
* A composition that cannot state a digest (for example no knowledge snapshot digest) cannot
  satisfy a required record for that scope: the environment refuses to start and the deploy
  gate denies. This is intended.
* The role table is a consistency check on the signed record, not proof of who signed it: with
  one trusted key, its holder can sign any role. Per-role keys are part of the signing-key
  prerequisite (PRQ-023).
* `subject` is optional in the schema (additive), so records for scopes without a versioned
  artifact stay valid; scopes in `SUBJECT_KIND_BY_SCOPE` never count without it.
* Nothing changes for local and CI work. No approval record exists, so every environment that
  requires approvals is refused today and the deploy gate denies.

## Alternatives considered

| Alternative | Why not adopted |
|---|---|
| Keep the artifact in free-text `scopeDetail` | Not machine-checkable; a record approves whatever it is referenced from (T-15) |
| Reference the approval id from configuration only | The original OPS-APPR-01 gap: an unreviewed model listed with the id of a record for another model was accepted |
| Bind only in the deploy gate | Runtime configuration can differ from the manifest; both gates check |
| Per-role signing keys before any role check | Key custody belongs to security leadership (PRQ-023); the reviewed table is the interim consistency check |
| A separate record type per artifact kind | More schema surface; one optional, scope-checked `subject` keeps one signing payload |

## Linked requirements

OPS-03, OPS-04, OPS-05, OPS-06, SPEC-16 (approval records), SPEC-14 approval replay (T-15).

## Revisit when

Security leadership creates the signing key and decides on per-role keys (PRQ-023), approvers
create the first records (PRQ-024), or a new versioned artifact (for example the tool catalogue)
needs approval.
