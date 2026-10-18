/**
 * Golden probe generator and expansion gate (SPEC-14: a policy update cannot
 * silently expand access).
 *
 *   npx tsx src/policy/golden-generate.ts
 *       CHECK (default): probes.json equals what the declarative matrix
 *       generates, and the WASM bundle satisfies every probe. Exit 1 otherwise.
 *   npx tsx src/policy/golden-generate.ts --update
 *       Rewrites policy/golden/probes.json from the matrix. REFUSES (exit 2,
 *       nothing written) when a probe would flip deny -> allow, widen a field
 *       mask, drop an obligation, be removed, or have a deny probe's input
 *       changed, unless policy/golden/approved-expansions.json lists the probe
 *       with an existing POLICY_RELEASE approval record in approvals/.
 *   npx tsx src/policy/golden-generate.ts --gate <baseline-probes.json>
 *       CI gate: compares the committed probes.json with an approved baseline
 *       (e.g. the file from the main branch). Exit 2 on unapproved expansions.
 *
 * Output is probe ids, outcome codes and reason codes only (SYNTHETIC data).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadApprovalRecords } from "../config/approvals.js";
import { OpaWasmPolicyEngine, REPO_ROOT } from "./engine.js";
import { ensurePolicyBundle } from "./ensure-bundle.js";
import {
  APPROVED_EXPANSIONS_FILE,
  PROBES_FILE,
  GoldenProbeFile,
  compareProbe,
  evaluateProbe,
  findExpansions,
  loadApprovedExpansions,
  loadProbeFile,
  resolveApprovedExpansions,
  serializeProbeFile,
  type ProbeComparison,
} from "./golden.js";
import { buildProbeFile } from "./golden-matrix.js";

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

export interface CliPaths {
  probesFile: string;
  approvedExpansionsFile: string;
  approvalsDir: string;
  bundleDir?: string;
}

export const DEFAULT_CLI_PATHS: CliPaths = {
  probesFile: PROBES_FILE,
  approvedExpansionsFile: APPROVED_EXPANSIONS_FILE,
  approvalsDir: join(REPO_ROOT, "approvals"),
};

const stdIo: CliIo = {
  out: (l) => void process.stdout.write(`${l}\n`),
  err: (l) => void process.stderr.write(`${l}\n`),
};

function approvedSet(paths: CliPaths, io: CliIo): Set<string> {
  const entries = existsSync(paths.approvedExpansionsFile) ? loadApprovedExpansions(paths.approvedExpansionsFile) : [];
  const records = loadApprovalRecords(paths.approvalsDir).records.map((r) => ({ approvalId: r.approvalId, scope: r.scope }));
  const { approved, rejected } = resolveApprovedExpansions(entries, records);
  for (const r of rejected) io.err(`approved-expansion entry does not count: ${r.probeId} ${r.reasonCode}`);
  return approved;
}

function report(results: ProbeComparison[], io: CliIo): number {
  let failures = 0;
  for (const r of results) {
    if (r.outcome === "MATCH") continue;
    if (r.outcome === "APPROVED_EXPANSION") {
      io.out(`APPROVED_EXPANSION ${r.probeId} ${r.expansion.join(",")}`);
      continue;
    }
    failures += 1;
    io.err(`${r.outcome} ${r.probeId}${r.expansion.length ? ` [${r.expansion.join(",")}]` : ""} ${r.diffs.join("; ")}`);
  }
  io.out(`probes evaluated: ${results.length}; failures: ${failures}`);
  return failures;
}

async function loadEngine(paths: CliPaths): Promise<OpaWasmPolicyEngine> {
  const bundleDir = paths.bundleDir ?? ensurePolicyBundle().bundleDir;
  return OpaWasmPolicyEngine.load({ bundleDir });
}

/** Runs the CLI; returns the process exit code (0 ok, 1 check failed, 2 expansion refused, 64 usage). */
export async function runGoldenCli(argv: readonly string[], io: CliIo = stdIo, paths: CliPaths = DEFAULT_CLI_PATHS): Promise<number> {
  const mode = argv.includes("--update") ? "update" : argv.includes("--gate") ? "gate" : "check";
  const engine = await loadEngine(paths);
  const approved = approvedSet(paths, io);
  const next = GoldenProbeFile.parse(buildProbeFile(engine.catalogue, engine.policyVersion));

  if (mode === "gate") {
    const baselinePath = argv[argv.indexOf("--gate") + 1];
    if (!baselinePath) {
      io.err("usage: golden-generate.ts --gate <baseline-probes.json>");
      return 64;
    }
    const findings = findExpansions(loadProbeFile(resolve(baselinePath)), loadProbeFile(paths.probesFile), approved);
    const blocked = findings.filter((f) => !f.approved);
    for (const f of findings) (f.approved ? io.out : io.err)(`${f.approved ? "APPROVED_EXPANSION" : "UNAPPROVED_EXPANSION"} ${f.probeId} ${f.kinds.join(",")}`);
    io.out(`expansion gate: ${findings.length} expansion(s), ${blocked.length} unapproved`);
    return blocked.length > 0 ? 2 : 0;
  }

  if (mode === "update") {
    if (existsSync(paths.probesFile)) {
      const previous = loadProbeFile(paths.probesFile);
      const blocked = findExpansions(previous, next, approved).filter((f) => !f.approved);
      if (blocked.length > 0) {
        for (const f of blocked) io.err(`REFUSED ${f.probeId} ${f.kinds.join(",")} (needs an approved-expansions entry backed by a POLICY_RELEASE approval)`);
        io.err(`update refused: ${blocked.length} unapproved expansion(s); probes.json not written`);
        return 2;
      }
    }
    writeFileSync(paths.probesFile, serializeProbeFile(next));
    io.out(`wrote ${next.probes.length} probes for policy ${engine.policyVersion}`);
    return report(next.probes.map((p) => compareProbe(p, evaluateProbe(engine, p), approved)), io) > 0 ? 1 : 0;
  }

  if (!existsSync(paths.probesFile)) {
    io.err("probes.json missing; run with --update");
    return 1;
  }
  const committed = readFileSync(paths.probesFile, "utf8");
  let code = 0;
  if (committed !== serializeProbeFile(next)) {
    io.err("probes.json is out of date with the declarative matrix; run with --update");
    code = 1;
  }
  const current = loadProbeFile(paths.probesFile);
  if (report(current.probes.map((p) => compareProbe(p, evaluateProbe(engine, p), approved)), io) > 0) code = 1;
  return code;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  runGoldenCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      process.stderr.write(`golden-generate failed: ${e instanceof Error ? e.name : "error"}\n`);
      process.exitCode = 1;
    },
  );
}
