/**
 * Evaluation and evidence CLI (`pnpm evidence <command>` from the repository root,
 * or `npx tsx src/evaluation/cli.ts <command>` from platform/).
 *
 *   generate [--check]          skeletons x variant families + journeys -> scenarios/generated, scenarios/journeys
 *   generate-risk [--check]     risk-scenario drafts -> scenarios/risk (UNREVIEWED drafts)
 *   corpus                      validate the whole corpus and print coverage statistics and digest
 *   traceability [...]          docs/REQUIREMENTS_TRACEABILITY.md (see traceability.ts for flags)
 *   manifest --env <env> [...]  evidence/release/release-manifest.<env>.json (see manifest.ts for flags)
 *   run --group <group> [...]   run a corpus group through the LOCAL FIXTURE LocalConversationDriver
 *                               (driver/run-corpus.ts) -> evidence/runs/<runId>/
 *   combine --runs a,b --out n  corpus-wide aggregate -> evidence/evaluation/<n>.summary.json + .report.md
 *
 * Vendor sandbox and PSTN drivers are BLOCKED (PRQ-004, PRQ-034, PRQ-043); local
 * fixture results never satisfy sandbox, staging or production gates.
 */
import { pathToFileURL } from "node:url";
import { corpusDigest, corpusStats, loadCorpus } from "./corpus.js";
import { RUN_USAGE, runCorpusCommand } from "./driver/run-corpus.js";
import { main as generateMain } from "./generate.js";
import { main as riskMain } from "./generate-risk.js";
import { main as manifestMain } from "./manifest.js";
import { main as traceMain } from "./traceability.js";
import { RISK_DRAFT_LABEL } from "./vocabulary.js";

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "generate":
      return generateMain(rest);
    case "generate-risk":
      return riskMain(rest);
    case "traceability":
      return traceMain(rest);
    case "manifest":
      return manifestMain(rest);
    case "run":
    case "combine": {
      const out = await runCorpusCommand(command, rest);
      for (const l of out.lines) (out.code === 0 ? console.log : console.error)(l);
      return out.code;
    }
    case "corpus": {
      const corpus = loadCorpus();
      const stats = corpusStats(corpus);
      console.log(JSON.stringify({ ...stats, corpusDigest: corpusDigest().digest, riskLabel: RISK_DRAFT_LABEL }, null, 2));
      return 0;
    }
    default:
      console.error("usage: cli.ts <generate|generate-risk|corpus|traceability|manifest|run|combine> [options]");
      console.error(RUN_USAGE);
      return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : "evaluation CLI failed");
      process.exitCode = 1;
    },
  );
}
