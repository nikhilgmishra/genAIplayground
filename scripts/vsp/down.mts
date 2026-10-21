/**
 * `down`: stops and removes the local composition (FO-19-64).
 *
 *   node scripts/vsp/runner.mts down [--purge] [--purge-audit]
 *   make down [PURGE=1] [PURGE_AUDIT=1]
 *
 * The destructive options are explicit flags of this command; nothing here reads them from the
 * environment. The Makefile passes them only for command-line assignments (`make down PURGE=1`): an
 * exported PURGE or PURGE_AUDIT, which GNU make would otherwise import as a make variable, is ignored
 * with a notice, so a variable left in a shell never turns a plain `make down` into a purge.
 *
 * Containers and networks of the compose project are always removed (by project label, so services
 * of every profile and every fragment go, even ones whose fragment was deleted since `up`).
 * Volumes are kept unless --purge is passed. Volumes labelled `io.vsp.data-class: audit` (they hold
 * audit evidence: the SQL audit journal in PostgreSQL and the Object Lock bucket in MinIO) are kept
 * even with --purge; removing them needs --purge-audit as well (which implies --purge). Every
 * teardown, including what was retained and why, is recorded in evidence/runs/local-down-<stamp>.json.
 *
 * Exit code 0 when no container of the project remains; 1 otherwise or when Docker fails.
 */
import { relative } from "node:path";
import { composeContext, err, gitCommit, lastValue, out, parseFlags, REPO_ROOT, requireDocker, run, UsageError, writeRunRecord } from "./up.mts";
import type { ContextOptions } from "./up.mts";

export const AUDIT_DATA_CLASS = "audit";
const PROJECT_LABEL = "com.docker.compose.project";

export interface DownOptions extends ContextOptions {
  purge: boolean;
  purgeAudit: boolean;
}

interface VolumeInfo {
  name: string;
  dataClass: string;
}

function projectVolumes(project: string): VolumeInfo[] {
  const ls = run("docker", ["volume", "ls", "--quiet", "--filter", `label=${PROJECT_LABEL}=${project}`]);
  if (ls.code !== 0) throw new UsageError(`docker volume ls failed: ${ls.stderr.trim()}`);
  const names = ls.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  if (names.length === 0) return [];
  const inspect = run("docker", ["volume", "inspect", ...names]);
  if (inspect.code !== 0) throw new UsageError(`docker volume inspect failed: ${inspect.stderr.trim()}`);
  const parsed = JSON.parse(inspect.stdout) as { Name: string; Labels?: Record<string, string> | null }[];
  return parsed.map((v) => ({ name: v.Name, dataClass: v.Labels?.["io.vsp.data-class"] ?? "unclassified" }));
}

export function projectContainers(project: string): string[] {
  const r = run("docker", ["ps", "--all", "--quiet", "--filter", `label=${PROJECT_LABEL}=${project}`]);
  if (r.code !== 0) throw new UsageError(`docker ps failed: ${r.stderr.trim()}`);
  return r.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
}

export function down(opts: DownOptions): number {
  const startedAt = new Date().toISOString();
  requireDocker();
  const ctx = composeContext(opts);
  const purge = opts.purge || opts.purgeAudit;
  out(`down: project ${ctx.project}${purge ? ` (purge${opts.purgeAudit ? " including audit volumes" : ""})` : ""}`);

  // Project-name mode: compose finds every container and network of the project by label.
  const composeDown = run("docker", ["compose", "--project-name", ctx.project, "down", "--remove-orphans", "--timeout", "20"], { inherit: true });

  const volumes = projectVolumes(ctx.project);
  const removed: string[] = [];
  const retained: { name: string; dataClass: string; reason: string }[] = [];
  let auditPurgeRefused = false;
  for (const v of volumes) {
    if (!purge) {
      retained.push({ ...v, reason: "kept by default (pass --purge / PURGE=1 to remove)" });
      continue;
    }
    if (v.dataClass === AUDIT_DATA_CLASS && !opts.purgeAudit) {
      auditPurgeRefused = true;
      retained.push({ ...v, reason: "REFUSED: holds audit evidence (pass --purge-audit / PURGE_AUDIT=1 to remove)" });
      continue;
    }
    const rm = run("docker", ["volume", "rm", v.name]);
    if (rm.code === 0) removed.push(v.name);
    else retained.push({ ...v, reason: `docker volume rm failed: ${rm.stderr.trim().slice(0, 200)}` });
  }

  const remaining = projectContainers(ctx.project);
  const failedVolumeRemovals = retained.filter((r) => r.reason.startsWith("docker volume rm failed"));
  const code = composeDown.code !== 0 || remaining.length > 0 || failedVolumeRemovals.length > 0 ? 1 : 0;
  const path = writeRunRecord(ctx.evidenceDir, "local-down", {
    schema: "vsp.local-composition.run.v1",
    action: "down",
    project: ctx.project,
    commit: gitCommit(),
    purge,
    purgeAudit: opts.purgeAudit,
    removedVolumes: removed,
    retainedVolumes: retained,
    auditPurgeRefused,
    containersRemaining: remaining.length,
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode: code,
  });
  for (const r of retained) out(`volume ${r.name} [${r.dataClass}] retained: ${r.reason}`);
  for (const name of removed) out(`volume ${name} removed`);
  if (remaining.length > 0) err(`down: ${remaining.length} container(s) of ${ctx.project} still present`);
  out(`run record: ${relative(REPO_ROOT, path)}`);
  out(code === 0 ? "down: no containers remain" : `down: FAILED (exit ${code})`);
  return code;
}

export function downMain(argv: readonly string[]): number {
  const f = parseFlags(argv, ["project", "evidence-dir", "state-dir", "compose-dir"], ["purge", "purge-audit"]);
  if (f.positionals.length > 0) throw new UsageError(`unexpected argument ${f.positionals[0]}`);
  // Destructive options are explicit flags only; no environment variable is consulted here, and the
  // Makefile forwards PURGE / PURGE_AUDIT only when they are make command-line assignments.
  return down({
    purge: f.booleans.has("purge"),
    purgeAudit: f.booleans.has("purge-audit"),
    project: lastValue(f, "project"),
    evidenceDir: lastValue(f, "evidence-dir"),
    stateDir: lastValue(f, "state-dir"),
    composeDir: lastValue(f, "compose-dir"),
  });
}
