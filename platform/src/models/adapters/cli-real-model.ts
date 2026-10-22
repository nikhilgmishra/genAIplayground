/**
 * Real-model local profile command (WP-08; FO-16-24, OPS-05).
 *
 *   pnpm --filter @vsp/platform exec tsx src/models/adapters/cli-real-model.ts status --profile <profile.json>
 *   pnpm --filter @vsp/platform exec tsx src/models/adapters/cli-real-model.ts run    --profile <profile.json>
 *
 * `status` evaluates the profile without any network access and prints the status as JSON. `run` sends the profile's
 * synthetic text task only when the profile is CONFIGURED and executable (a paid provider also needs the billable
 * approval id in the profile, AIN-30); otherwise it prints the status and makes no request. Exit codes: 0 ran or
 * CONFIGURED, 2 invalid invocation or profile, 3 NOT_CONFIGURED or not executable (nothing was sent), 4 the call ran
 * and did not complete. Output is content-free except the model's synthetic reply length.
 */
import { readFileSync } from "node:fs";
import { systemClock } from "../../shared/clock.js";
import { evaluateRealModelProfile, runRealModelProfile } from "./real-model-profile.js";

function usage(): never {
  console.error("usage: cli-real-model.ts <status|run> --profile <profile.json>");
  process.exit(2);
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, flag, file] = argv;
  if ((command !== "status" && command !== "run") || flag !== "--profile" || !file) usage();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    console.error(JSON.stringify({ error: "REAL_MODEL_PROFILE_UNREADABLE" }));
    return 2;
  }
  if (command === "status") {
    const { credential: _credential, ...status } = evaluateRealModelProfile(raw);
    console.log(JSON.stringify(status, null, 2));
    if (status.violations.length > 0) return 2;
    return status.status === "CONFIGURED" ? 0 : 3;
  }
  const run = await runRealModelProfile(raw, { clock: systemClock });
  if (run.status.violations.length > 0) {
    console.log(JSON.stringify({ status: run.status }, null, 2));
    return 2;
  }
  if (!run.result) {
    console.log(JSON.stringify({ status: run.status, ran: false }, null, 2));
    return 3;
  }
  const r = run.result;
  console.log(
    JSON.stringify(
      {
        status: run.status,
        ran: true,
        outcome: r.outcome,
        reasonCode: "reasonCode" in r ? r.reasonCode : null,
        attempts: r.attempts,
        sentAttempts: r.sentAttempts,
        latencyMs: r.latencyMs,
        usage: r.usage,
        replyChars: r.outcome === "COMPLETED" ? r.text.length : 0,
      },
      null,
      2,
    ),
  );
  return r.outcome === "COMPLETED" ? 0 : 4;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  () => {
    console.error(JSON.stringify({ error: "REAL_MODEL_COMMAND_FAILED" }));
    process.exit(4);
  },
);
