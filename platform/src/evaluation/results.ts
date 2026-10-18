/**
 * Append-only evaluation results (spec section 14 "Scorecard and release evidence").
 *
 * Layout: <evidenceRoot>/runs/<runId>/
 *   results.jsonl        one EvaluationResult per line (canonical JSON), append-only
 *   call-evidence.jsonl  the driver evidence each result was scored from
 *   summary.json         aggregate (written once by finalize)
 *   report.md            human-readable report (written once by finalize)
 *
 * A run directory is created exclusively: an existing run is never reopened,
 * overwritten or truncated. Every record is validated against the protocol
 * schema before it is written. Only SYNTHETIC evidence may be written to a
 * repository checkout; production-derived evidence belongs in the approved
 * restricted evidence store (PRQ-003).
 */
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EvaluationResult } from "../protocol/index.js";
import { canonicalJson } from "../shared/canonical.js";
import { newId } from "../shared/ids.js";
import type { CallEvidence, ResultSink } from "./runner.js";

export class ResultsWriterError extends Error {
  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

export interface RunWriterOptions {
  /** Directory that holds `runs/` (normally <repo>/evidence). */
  evidenceRoot: string;
  /** Prefix used in evidence references (normally "evidence"). */
  refPrefix?: string;
  runId?: string;
  idSource?: () => string;
}

const RUN_ID = /^run_[A-Za-z0-9_-]{8,64}$/;

export class RunResultWriter implements ResultSink {
  private finalized = false;
  private count = 0;

  private constructor(
    readonly runId: string,
    readonly dir: string,
    private readonly refPrefix: string,
  ) {}

  /** Creates `<evidenceRoot>/runs/<runId>/` exclusively; refuses an existing run directory. */
  static create(opts: RunWriterOptions): RunResultWriter {
    const runId = opts.runId ?? (opts.idSource ?? (() => newId("run")))();
    if (!RUN_ID.test(runId)) throw new ResultsWriterError("RUN_ID_INVALID");
    const runsDir = join(opts.evidenceRoot, "runs");
    mkdirSync(runsDir, { recursive: true });
    const dir = join(runsDir, runId);
    try {
      mkdirSync(dir);
    } catch {
      throw new ResultsWriterError("RUN_ALREADY_EXISTS");
    }
    for (const f of ["results.jsonl", "call-evidence.jsonl"]) closeSync(openSync(join(dir, f), "wx"));
    return new RunResultWriter(runId, dir, `${opts.refPrefix ?? "evidence"}/runs/${runId}`);
  }

  get resultsPath(): string {
    return join(this.dir, "results.jsonl");
  }

  get recordCount(): number {
    return this.count;
  }

  /** Reference stored in EvaluationResult.evidenceRef for a scenario repetition. */
  evidenceRefFor = (scenarioId: string, repetition: number): string => `${this.refPrefix}/call-evidence.jsonl#${scenarioId}/${repetition}`;

  append(result: EvaluationResult, evidence: CallEvidence | null): void {
    if (this.finalized) throw new ResultsWriterError("RUN_FINALIZED");
    const parsed = EvaluationResult.safeParse(result);
    if (!parsed.success) throw new ResultsWriterError("RESULT_SCHEMA_INVALID");
    if (parsed.data.runId !== this.runId) throw new ResultsWriterError("RESULT_RUN_ID_MISMATCH");
    appendFileSync(this.resultsPath, `${canonicalJson(parsed.data)}\n`, { flag: "a" });
    appendFileSync(
      join(this.dir, "call-evidence.jsonl"),
      `${canonicalJson({ scenarioId: parsed.data.scenarioId, repetition: parsed.data.repetition, evidence })}\n`,
      { flag: "a" },
    );
    this.count++;
  }

  /** Writes summary.json and report.md exactly once; later appends are refused. */
  finalize(summary: unknown, reportMarkdown: string): void {
    if (this.finalized) throw new ResultsWriterError("RUN_FINALIZED");
    try {
      writeFileSync(join(this.dir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx" });
      writeFileSync(join(this.dir, "report.md"), reportMarkdown, { flag: "wx" });
    } catch {
      throw new ResultsWriterError("RUN_SUMMARY_EXISTS");
    }
    this.finalized = true;
  }
}

/** Reads and strictly validates a run's results.jsonl. */
export function readRunResults(runDir: string): EvaluationResult[] {
  const raw = readFileSync(join(runDir, "results.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((line) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new ResultsWriterError("RESULT_LINE_UNPARSEABLE");
      }
      return EvaluationResult.parse(value);
    });
}
