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

## Tagging tests

Put the id in square brackets in the test title, e.g.
`it("[AUTH-04] expired session fails closed before TTL cleanup", ...)`; in Rego tests put a
`# [AUTH-05] ...` comment directly above the `test_` rule. Tag only what the test actually
verifies: a test of the evaluation scorer that detects a SAFE-04 violation does not verify that the
platform enforces SAFE-04.

## Generating the matrix

From `platform/`:

```bash
npx vitest run --reporter=json --outputFile=../evidence/test-reports/vitest-platform.json
npx tsx src/evaluation/traceability.ts \
  --vitest-report ../evidence/test-reports/vitest-platform.json \
  [--vitest-report ../evidence/test-reports/vitest-console.json] \
  [--opa-report ../evidence/test-reports/opa.json] \
  [--json ../evidence/test-reports/traceability.json]
```

This writes `docs/REQUIREMENTS_TRACEABILITY.md` (or the `--out <md>` path; columns: requirement,
short text, enforcement location, test ids, latest result, evidence path, release status). Status rules:

- `IMPLEMENTED_OFFLINE` only if at least one tagged test exists and every tagged test passed in a
  supplied report;
- `NOT_RUN` when no result is recorded for a tagged test (or it was skipped);
- `NO_TEST` when no test carries the tag (listed as a gap);
- `FAILING` when a tagged test failed;
- `BLOCKED` when `externalBlock` is set: it overrides the release status for sandbox/production
  readiness (the offline status is shown alongside).

Tags found in tests but absent from the catalogue are reported as unknown tags. The generator never
emits `VERIFIED_SANDBOX`, `APPROVED_PILOT` or `VERIFIED_PRODUCTION`.

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
