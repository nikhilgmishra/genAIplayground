# Test evidence

Record of test runs actually executed: command, environment, result and evidence location.
**Missing evidence is INCONCLUSIVE, never PASS** (spec section 14). Nothing here is anticipated:
a row without a run stays `NOT_RUN` or `BLOCKED`. Synthetic fixtures and local adapters are
labelled; an offline PASS is evidence of `IMPLEMENTED_OFFLINE` only.

## Result vocabulary

| Result | Meaning |
|---|---|
| `PASS` | The command ran and every assertion passed |
| `FAIL` | The command ran and at least one assertion failed |
| `INCONCLUSIVE` | Ran, but evidence is missing or insufficient (for example sample size) |
| `NOT_RUN` | Exists but was not executed for this record |
| `BLOCKED` | Cannot run until a prerequisite exists (PRQ id given) |

Release status vocabulary: `IMPLEMENTED_OFFLINE`, `VERIFIED_SANDBOX`, `APPROVED_PILOT`,
`VERIFIED_PRODUCTION`, `BLOCKED`, `NOT_RUN` ([`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md)).

## Evidence locations

| Kind | Location |
|---|---|
| Local run output | `evidence/runs/` (gitignored; generated per run) |
| Evaluation results and scorecards | `EvaluationResult` records (append-only), produced by the evaluation module |
| Release evidence | `ReleaseManifest.testEvidence` and `quotaAndLoadEvidence` entries with digests |
| Drill records | `SECURITY_AUDIT` audit events ([`RUNBOOKS/README.md`](RUNBOOKS/README.md)) |

## Run environment

*To be completed by coordinator after integration test run* (commit, date, Node and pnpm versions,
environment `local` or `ci`).

## Offline test layers

| Layer | Command | Result | Tests passed / failed | Date | Evidence |
|---|---|---|---|---|---|
| Platform unit, property and integration tests (all modules) | `cd platform && npx vitest run` | *to be completed by coordinator after integration test run* | | | |
| Platform typecheck | `pnpm --filter @vsp/platform typecheck` | *to be completed by coordinator after integration test run* | | | |
| Platform lint | `pnpm --filter @vsp/platform lint` | *to be completed by coordinator after integration test run* | | | |
| Console tests, typecheck, lint | `pnpm --filter @vsp/console test` (and `typecheck`, `lint`) | *to be completed by coordinator after integration test run* | | | |
| Policy (Rego) tests | `pnpm policy:test` | *to be completed by coordinator after integration test run* | | | |
| Step Functions ASL drift check | `cd platform && npx tsx src/workflows/generate-asl.ts --check` | *to be completed by coordinator after integration test run* | | | |
| Protocol JSON Schema drift check | `cd platform && npx tsx src/protocol/generate-schemas.ts --check` | *to be completed by coordinator after integration test run* | | | |
| Terraform validate and module tests (offline mirror) | per `infra/terraform` README | *to be completed by coordinator after integration test run* | | | |
| Talkdesk package consistency | `node talkdesk/tools/validate-package.mjs`; `node --test talkdesk/tools/package.test.mjs` | *to be completed by coordinator after integration test run* | | | |
| Documentation pack data checks | `cd platform && npx vitest run test/docs` | PASS at authoring time (see note) | see note | 2026-10-17 | Note below; coordinator re-runs |
| Capacity model reproduction | `python3 scripts/capacity_model.py` | PASS at authoring time (exit 0) | all spec section 12 figures within tolerance | 2026-10-17 | Note below; coordinator re-runs |

Note: the two documentation rows record the result observed by the documentation-pack author
in the development sandbox while writing these files. The coordinator replaces them with the
integration run's results.

## Vendor, telephone, load and drill layers

| Layer | Status | Prerequisite |
|---|---|---|
| Talkdesk sandbox tests (AG, MB, DT, BS, GX, VI, EX, MC, SF-T) | BLOCKED | PRQ-004, PRQ-034 |
| Salesforce sandbox contract tests | BLOCKED | PRQ-006, PRQ-035 |
| IdP sandbox tests | BLOCKED | PRQ-036 |
| Business-system contract tests | BLOCKED | PRQ-007 |
| PSTN telephone tests (codecs, interruptions, transfers, consent, noisy audio) | BLOCKED | PRQ-043 |
| Quota and sustained load tests (illustrative target at least 400 tool requests per second) | BLOCKED | PRQ-022, PRQ-037 |
| Human-reviewed safety and privacy corpus (at least 500 scenarios) | BLOCKED | PRQ-012 |
| Independent security assessment and penetration test | BLOCKED | PRQ-051 |
| Runbook drills (all) | NOT_RUN | PRQ-011 |
| Restore and regional failover drills | NOT_RUN | PRQ-037, PRQ-039 |

## Requirement coverage

The requirement-to-test matrix is generated from requirement-tagged test titles by the
traceability module (`docs/requirements/`). *To be completed by coordinator after integration
test run.*
