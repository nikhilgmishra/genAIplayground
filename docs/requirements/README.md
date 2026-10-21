# Requirement catalogue

[`catalog.yaml`](catalog.yaml) lists every acceptance invariant (AUTH-01..07, DATA-01..04,
ACT-01..05, SAFE-01..05, OPS-01..06, exact text from the specification) and 141 specification
requirements as `SPEC-<section>.<topic>` ids covering sections 2 to 16, including one entry per
required demonstration journey (`SPEC-16.journey-1`..`9`) and injected fault (`SPEC-16.fault-*`).
Each entry records:

| Field | Meaning |
|---|---|
| `text`, `section` | Requirement statement and source section |
| `enforcement` | Module paths where the requirement is enforced (design intent; verified only by tests) |
| `verification` | `unit`, `property`, `contract`, `adversarial`, `workflow`, `audio`, `load`, `manual`, `operational` |
| `aliases` | Tags already used in test titles that resolve to this id (e.g. `SPEC-13.4` -> `SPEC-13.console`); a sub-topic tag is aliased only when every test carrying it verifies the requirement |
| `externalBlock` | Reason and `PRQ-` prerequisites when verification beyond the offline slice is externally BLOCKED |
| `register` (invariants only) | The invariant register (FO-02-28): follow-on row (`FO-02-NN`), threat-model rows, positive / direct adversarial / failure-injection tests (`file` plus a distinctive part of the test `title`), evidence artifact, owner role and owning package, activation dependencies (`AIN-NN`), secondary packages and open register gaps (e.g. `AUDIO_RELEASE_BOUNDARY_NOT_BUILT` for ACT-05, AUTH-06, DATA-02) |

`platform/test/invariants/register.test.ts` fails when any register attribute is missing or stale: the
follow-on row, owner, secondary packages and activation dependencies must equal
`docs/followon/gap-ledger.yaml`; every threat id must be a row of `docs/security/threat-model.md` that names
the invariant; every cited test must exist, carry the invariant's tag and serve one role only. Failure-injection
tests added by WP-01 also carry the role tag `[FAILURE:<invariant>]` (with `[POSITIVE:<invariant>]` and
`[ADVERSARIAL:<invariant>]` at the evaluation boundary); these role tags are not requirement ids.

## Tagging tests

Put the id in square brackets in the test title, e.g.
`it("[AUTH-04] expired session fails closed before TTL cleanup", ...)`; in Rego tests put a
`# [AUTH-05] ...` comment directly above the `test_` rule. Tag only what the test actually
verifies: a test of the evaluation scorer that detects a SAFE-04 violation does not verify that the
platform enforces SAFE-04.

## Generating the matrix

From `platform/` (two status axes plus qualification, `traceability.v2`):

```bash
npx vitest run --reporter=json --outputFile=<report-dir>/vitest-platform.json
npx tsx src/evaluation/traceability.ts \
  --vitest-report <report-dir>/vitest-platform.json \
  [--vitest-report ../evidence/test-reports/vitest-console.json] \
  [--opa-report ../evidence/test-reports/opa-vsp.json] \
  --json ../evidence/test-reports/traceability.json
npx tsx src/evaluation/traceability.ts --check    # validate the inputs only; writes nothing
```

Inputs: this catalogue, `docs/followon/requirements.yaml`, `gap-ledger.yaml`, `capabilities.yaml`,
`activation-register.yaml` and the fault plans. Output: `docs/REQUIREMENTS_TRACEABILITY.md` (or `--out <md>`)
and the JSON report. Rules:

- Software (`MISSING` < `IMPLEMENTED` < `VERIFIED_LOCAL` < `RELEASE_PACKAGE_VERIFIED`), Environment
  (`NOT_CONFIGURED` < `CONFIGURED` < `VERIFIED_SANDBOX` < `APPROVED_PILOT` < `VERIFIED_PRODUCTION`) and
  Qualification (`NOT_RUN`, `FAIL`, `INCONCLUSIVE`, `PASS`) are the gap ledger's values per follow-on
  requirement; per capability and per catalogue id they are the least advanced follow-on member (qualification
  PASS only when every member is PASS). The generator never raises a status.
- Local tests per catalogue id: `PASS` only if at least one tagged test exists and every tagged test passed in a
  supplied report; `NOT_RUN` when a tagged test has no recorded result (or was skipped); `NO_TEST` when no test
  carries the tag (listed as a gap); `FAIL` when a tagged test failed. Local tests are software evidence, never
  qualification. `externalBlock` is listed separately.
- Invariant register: each role (positive, adversarial, failure injection) is PASS only when every cited test
  passed in a supplied report; without a report every role is NOT_RUN.
- The generator exits 1 and writes nothing on an originalId that resolves to no catalogue id or alias, an
  activation id (`AIN-NN`) used as an originalId, a catalogue id that no follow-on row maps, a follow-on row
  without a ledger row, an unknown capability, a status value outside the vocabulary, a stale capability
  roll-up or an incomplete invariant register.
- Test tags resolve against catalogue ids and aliases and against follow-on ids (`[FO-17-14]`,
  `[FO-17-24.POLICY_ENGINE_ERROR]`); fault tags `[FAULT:<ID>]` feed the fault registry section.

Tags found in tests but in neither the catalogue nor the follow-on requirements are reported as unknown tags.

Expected unknown tags (the catalogue format has no list of non-requirement tags):

- Review-finding ids (`ACT-F*`, `AUTH-ENUM-01`, `AUTH-OTP-LIMIT-01`, `DP-0*`, `OPS-APPR-01`, `OPS-AUD-0*`,
  `OPS-KS-0*`, `SAFE-HANDOFF-*`, `VSP-*`) link a test to its finding in the
  [adversarial review](../security/adversarial-review.md); they are not requirements. `OPS-REL-01` and
  `OPS-REL-02` stay aliases of OPS-03 and OPS-06 only because the evaluation module's own tags must resolve.
- Vendor capability ids `TB-01`..`TB-10` ([capability gate](../../talkdesk/capability-gate.md)) are verified
  only by a tenant demonstration (SPEC-3.vendor-capability-gate, BLOCKED); every test carrying one also
  carries the requirement it verifies offline.
- `SPEC-8.tool-pipeline`, `SPEC-14.policy-failure` and `SPEC-15.worker` name no single requirement (their
  tests cover transport parity, fail-closed policy evaluation, and worker scheduling and readiness), so they
  are not aliased.
