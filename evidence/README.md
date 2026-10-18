# Evidence

**LOCAL FIXTURE — SYNTHETIC DATA — NOT PRODUCTION.** Everything here was produced offline on the
LOCAL FIXTURE composition (PGlite, labelled local adapters, SYNTHETIC people, LOCAL SIMULATED
COORDINATOR). It is evidence of `IMPLEMENTED_OFFLINE` at most and never satisfies a sandbox,
staging or production gate. Commands, numbers and their interpretation:
[`docs/TEST_EVIDENCE.md`](../docs/TEST_EVIDENCE.md).

| Path | Content | Written by | Committed |
|---|---|---|---|
| `runs/<runId>/` | Per-run append-only `results.jsonl`, `call-evidence.jsonl`, `summary.json`, `report.md` | `platform/src/evaluation/cli.ts run` (exclusive create; a run directory is never reused) | No (gitignored) |
| `evaluation/<name>.summary.json`, `<name>.report.md` | Corpus-wide aggregate of named runs: verdicts per corpus group, split, risk class and variant family; gates; critical failures; FAIL list by failing hard gate | `platform/src/evaluation/cli.ts combine` (written once, never overwritten) | Yes |
| `evaluation/<name>.root-causes.json`, `<name>.root-causes.md` | Root-cause attribution of every FAIL / INCONCLUSIVE run (analysis only; verdicts unchanged) | `evaluation/tools/attribute-root-causes.mts` | Yes |
| `demo/<runId>.json`, `<runId>.stdout.txt` | `pnpm demo` transcript (no caller utterances) and its console output (SYNTHETIC scripted lines from `scenarios/journeys/`) | `platform/src/demo/run-demo.ts` | Yes |
| `load/<runId>.json` | LOCAL LOOPBACK load record (PGlite single connection; NOT capacity evidence) | `scripts/load/run-local-load.mts` | Yes |

Older aggregates (`corpus-local-20261018.*`, earlier demo and load records) described the system
before the wave-3 fixes; they were never committed and are not kept here. Their numbers remain in
`docs/TEST_EVIDENCE.md` as committed in `c1af717`. The superseded run directories are still under
`runs/` (gitignored).
