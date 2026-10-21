/**
 * Contention and crash helpers for Layer-2 runs on postgres:16 (WP-04 deliverable; used by the
 * CONCURRENT_SAME_ACCOUNT and CRASH_AFTER_COMMIT fault runs of WP-25 and by contention.test.ts).
 *
 *  - raceOnTwoConnections: runs two transaction bodies on two DIFFERENT pools (two backends, proven by
 *    pg_backend_pid) and holds both at a barrier inside their transactions until both have reached it, so the
 *    race is real, not an accident of scheduling. Returns each side's outcome.
 *  - runChildUntil / killChild: starts a TypeScript child process (tsx) and SIGKILLs or SIGTERMs it once it has
 *    printed a marker line (a worker killed at a known point: after a commit, before an acknowledgement).
 * Neither fakes anything: the transactions, the server and the process deaths are real.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import type { Db, Queryable, TxOptions } from "../../../src/db/types.js";
import { PLATFORM_ROOT } from "../_harness/env.js";

export interface RaceSide<T> {
  db: Db;
  opts?: TxOptions;
  /** Runs inside the transaction; `barrier` resolves once both sides have reached it. */
  body(tx: Queryable, barrier: () => Promise<void>): Promise<T>;
}

export type RaceOutcome<T> = { ok: true; value: T; backendPid: number } | { ok: false; error: unknown; backendPid: number | null };

export async function raceOnTwoConnections<A, B>(a: RaceSide<A>, b: RaceSide<B>, barrierTimeoutMs = 10_000): Promise<[RaceOutcome<A>, RaceOutcome<B>]> {
  let arrived = 0;
  let open: () => void = () => undefined;
  const both = new Promise<void>((resolve) => (open = resolve));
  const barrier = async () => {
    arrived += 1;
    if (arrived === 2) open();
    await Promise.race([both, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("RACE_BARRIER_TIMEOUT")), barrierTimeoutMs))]);
  };
  const side = async <T>(s: RaceSide<T>): Promise<RaceOutcome<T>> => {
    let pid: number | null = null;
    try {
      const value = await s.db.tx(async (tx) => {
        pid = Number((await tx.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]?.pid);
        return s.body(tx, barrier);
      }, s.opts);
      return { ok: true, value, backendPid: pid ?? -1 };
    } catch (error) {
      return { ok: false, error, backendPid: pid };
    }
  };
  return Promise.all([side(a), side(b)]);
}

export interface ChildRun {
  child: ChildProcess;
  lines: string[];
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/** Starts `node --import tsx <script> ...args` in the platform directory, collecting stdout lines. */
export function runChild(script: string, args: string[], env: NodeJS.ProcessEnv = {}): ChildRun {
  const child = spawn(process.execPath, ["--import", "tsx", script, ...args], {
    cwd: PLATFORM_ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines: string[] = [];
  let buf = "";
  child.stdout?.on("data", (d: Buffer) => {
    buf += d.toString("utf8");
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      lines.push(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  });
  child.stderr?.on("data", () => undefined);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  return { child, lines, exited };
}

/** Waits until the child printed a line starting with `marker` (or exited / timed out). */
export async function waitForLine(run: ChildRun, marker: string, timeoutMs = 60_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const line = run.lines.find((l) => l.startsWith(marker));
    if (line) return line;
    if (run.child.exitCode !== null || run.child.signalCode !== null) throw new Error(`CHILD_EXITED_BEFORE_MARKER: ${marker} (lines: ${run.lines.slice(-5).join(" | ")})`);
    if (Date.now() > deadline) throw new Error(`CHILD_MARKER_TIMEOUT: ${marker}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Runs the child until `marker`, then kills it with `signal`; resolves with how it exited. */
export async function killAfter(script: string, args: string[], marker: string, signal: NodeJS.Signals = "SIGKILL", env: NodeJS.ProcessEnv = {}): Promise<{ line: string; exit: { code: number | null; signal: NodeJS.Signals | null }; lines: string[] }> {
  const run = runChild(script, args, env);
  try {
    const line = await waitForLine(run, marker);
    run.child.kill(signal);
    const exit = await run.exited;
    return { line, exit, lines: run.lines };
  } catch (err) {
    run.child.kill("SIGKILL");
    await run.exited;
    throw err;
  }
}

export const CHILD_DIR = join(PLATFORM_ROOT, "test", "integration", "substrate");
