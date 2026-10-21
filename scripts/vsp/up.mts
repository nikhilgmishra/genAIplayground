/**
 * `up`: starts the local Layer-2 composition (docs/ARCHITECTURE.md section 6.3.2, ADR-0018 decision 6).
 *
 *   node scripts/vsp/runner.mts up [--profile core[,media,...]] [--timeout 600]
 *   make up PROFILE=core
 *
 * Loads deploy/local/compose.yaml plus every deploy/local/services/*.compose.yaml fragment (packages add
 * services in their own fragment; nobody edits the entry file), selects services by compose profile,
 * waits for every container health check (`docker compose up --wait`), and writes a run record to
 * evidence/runs/local-up-<stamp>.json (gitignored). The exit code is the compose exit code: non-zero
 * when a service fails to become healthy within the timeout.
 *
 * Credentials and TLS material for the emulators are GENERATED locally on first use into the state
 * directory (.tools/vsp-local by default, gitignored): nothing secret is committed, nothing is shared
 * between checkouts, and none of it is valid anywhere but on this machine's loopback interface.
 *
 * No service in the composition calls a billable endpoint (OPS-05): every image is a local emulator
 * or open-source server pinned by digest; their outbound update/telemetry calls are disabled in
 * deploy/local/services/core.compose.yaml.
 *
 * This module also holds the compose helpers shared by down.mts and runner.mts.
 */
import { spawnSync } from "node:child_process";
import type { SpawnSyncOptions } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DEFAULT_PROJECT = "vsp-local";
export const DEFAULT_COMPOSE_DIR = join(REPO_ROOT, "deploy", "local");
export const DEFAULT_STATE_DIR = join(REPO_ROOT, ".tools", "vsp-local");
export const DEFAULT_EVIDENCE_DIR = join(REPO_ROOT, "evidence", "runs");
export const DEFAULT_PROFILES = ["core"];
/** Minimum Docker Compose version: `up --wait` and `--wait-timeout` (2.17), `config --profiles` (2.20). */
export const MIN_COMPOSE_VERSION: readonly [number, number] = [2, 20];

const PROJECT_RE = /^vsp-[a-z0-9][a-z0-9-]{0,40}$/;
const PROFILE_RE = /^[a-z][a-z0-9-]{0,31}$/;

export interface ComposeContext {
  project: string;
  composeDir: string;
  stateDir: string;
  envFile: string;
  evidenceDir: string;
  /** Entry file first, then the fragments in name order. */
  files: string[];
}

export interface ContextOptions {
  project?: string | undefined;
  composeDir?: string | undefined;
  stateDir?: string | undefined;
  evidenceDir?: string | undefined;
}

export function composeContext(opts: ContextOptions = {}): ComposeContext {
  const project = opts.project ?? process.env.VSP_COMPOSE_PROJECT ?? DEFAULT_PROJECT;
  if (!PROJECT_RE.test(project)) throw new UsageError(`invalid compose project name "${project}" (expected ${PROJECT_RE.source})`);
  const composeDir = resolve(opts.composeDir ?? process.env.VSP_COMPOSE_DIR ?? DEFAULT_COMPOSE_DIR);
  const stateDir = resolve(opts.stateDir ?? process.env.VSP_LOCAL_STATE_DIR ?? DEFAULT_STATE_DIR);
  const evidenceDir = resolve(opts.evidenceDir ?? process.env.VSP_EVIDENCE_DIR ?? DEFAULT_EVIDENCE_DIR);
  return { project, composeDir, stateDir, envFile: join(stateDir, "env"), evidenceDir, files: discoverFragments(composeDir) };
}

/** deploy/local/compose.yaml followed by every services/*.compose.yaml, sorted by name. */
export function discoverFragments(composeDir: string): string[] {
  const entry = join(composeDir, "compose.yaml");
  if (!existsSync(entry)) throw new UsageError(`compose entry file missing: ${entry}`);
  const servicesDir = join(composeDir, "services");
  const fragments = existsSync(servicesDir)
    ? readdirSync(servicesDir)
        .filter((f) => f.endsWith(".compose.yaml"))
        .sort()
        .map((f) => join(servicesDir, f))
    : [];
  return [entry, ...fragments];
}

export function composeBaseArgs(ctx: ComposeContext): string[] {
  const args = ["compose", "--project-name", ctx.project, "--project-directory", ctx.composeDir, "--env-file", ctx.envFile];
  for (const f of ctx.files) args.push("-f", f);
  return args;
}

export class UsageError extends Error {}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a command; `inherit` streams output to the terminal (stdout/stderr are then empty). */
export function run(cmd: string, args: readonly string[], opts: { inherit?: boolean; cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {}): RunResult {
  const spawnOpts: SpawnSyncOptions = {
    cwd: opts.cwd ?? REPO_ROOT,
    env: opts.env ?? process.env,
    stdio: opts.inherit ? ["ignore", "inherit", "inherit"] : ["pipe", "pipe", "pipe"],
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  };
  if (opts.input !== undefined) spawnOpts.input = opts.input;
  const r = spawnSync(cmd, args, spawnOpts);
  if (r.error) return { code: 127, stdout: "", stderr: String(r.error.message) };
  return { code: r.status ?? (r.signal ? 128 : 1), stdout: typeof r.stdout === "string" ? r.stdout : "", stderr: typeof r.stderr === "string" ? r.stderr : "" };
}

export function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

export function err(line: string): void {
  process.stderr.write(`${line}\n`);
}

/** Fails unless the Docker daemon answers and Compose is new enough. Returns the compose version. */
export function requireDocker(): string {
  const info = run("docker", ["info", "--format", "{{.ServerVersion}}"]);
  if (info.code !== 0) {
    throw new UsageError("Docker daemon not reachable (docker info failed). Start Docker (in the session container: dockerd > /tmp/dockerd.log 2>&1 &) and retry.");
  }
  const v = run("docker", ["compose", "version", "--short"]);
  if (v.code !== 0) throw new UsageError("Docker Compose v2 plugin not found (docker compose version failed).");
  const version = v.stdout.trim().replace(/^v/, "");
  const m = /^(\d+)\.(\d+)/.exec(version);
  const major = Number(m?.[1] ?? 0);
  const minor = Number(m?.[2] ?? 0);
  if (major < MIN_COMPOSE_VERSION[0] || (major === MIN_COMPOSE_VERSION[0] && minor < MIN_COMPOSE_VERSION[1])) {
    throw new UsageError(`Docker Compose ${version} is too old; ${MIN_COMPOSE_VERSION.join(".")} or newer is required.`);
  }
  return version;
}

/* ------------------------------------------------------------------ state (credentials, TLS) */

const hex = (bytes: number): string => randomBytes(bytes).toString("hex");

/**
 * Emulator credentials, generated per checkout. They protect services bound to 127.0.0.1 only and
 * are never valid for a real system. Existing values are kept, so a restart reuses the volumes.
 */
const GENERATED_ENV: ReadonlyArray<readonly [string, () => string]> = [
  ["VSP_POSTGRES_PASSWORD", () => hex(24)],
  ["VSP_MINIO_ROOT_USER", () => `vsp-minio-${hex(4)}`],
  ["VSP_MINIO_ROOT_PASSWORD", () => hex(24)],
  // MinIO built-in single-key KMS (SSE-KMS for the audit bucket): "<key-name>:<base64 32 bytes>".
  ["VSP_MINIO_KMS_SECRET_KEY", () => `vsp-audit-local:${randomBytes(32).toString("base64")}`],
  ["VSP_KEYCLOAK_ADMIN_USER", () => "vsp-admin"],
  ["VSP_KEYCLOAK_ADMIN_PASSWORD", () => hex(24)],
  ["VSP_AWS_ACCESS_KEY_ID", () => `LKIA${hex(8).toUpperCase()}`],
  ["VSP_AWS_SECRET_ACCESS_KEY", () => hex(30)],
  ["VSP_LIVEKIT_API_KEY", () => `API${hex(6)}`],
  ["VSP_LIVEKIT_API_SECRET", () => hex(32)],
  ["VSP_VALKEY_PASSWORD", () => hex(24)],
];

export function parseEnvFile(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    env[key] = value;
  }
  return env;
}

export function readEnvFile(path: string): Record<string, string> {
  return existsSync(path) ? parseEnvFile(readFileSync(path, "utf8")) : {};
}

function openssl(args: readonly string[], cwd: string): void {
  const r = run("openssl", args, { cwd });
  if (r.code !== 0) throw new UsageError(`openssl ${args[0] ?? ""} failed (openssl is required to generate the local TLS certificate): ${r.stderr.trim().split("\n").slice(-2).join(" ")}`);
}

/** Local CA plus a server certificate for localhost / keycloak / 127.0.0.1, renewed 30 days before expiry. */
function ensureTls(stateDir: string): string[] {
  const created: string[] = [];
  const caDir = join(stateDir, "ca");
  const tlsDir = join(stateDir, "tls");
  mkdirSync(caDir, { recursive: true, mode: 0o700 });
  mkdirSync(tlsDir, { recursive: true, mode: 0o755 });
  const caKey = join(caDir, "ca.key");
  const caPem = join(caDir, "ca.pem");
  const caValid = existsSync(caKey) && existsSync(caPem) && run("openssl", ["x509", "-checkend", String(60 * 86_400), "-noout", "-in", caPem]).code === 0;
  if (!caValid) {
    openssl(
      ["req", "-x509", "-newkey", "rsa:3072", "-sha256", "-days", "825", "-nodes", "-keyout", caKey, "-out", caPem, "-subj", "/CN=VSP local Layer-2 CA (SYNTHETIC, loopback only)",
        "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"],
      caDir,
    );
    chmodSync(caKey, 0o600);
    rmSync(join(tlsDir, "server.pem"), { force: true });
    created.push("tls-ca");
  }
  const serverPem = join(tlsDir, "server.pem");
  const serverKey = join(tlsDir, "server.key");
  const serverValid = existsSync(serverPem) && existsSync(serverKey) && run("openssl", ["x509", "-checkend", String(30 * 86_400), "-noout", "-in", serverPem]).code === 0;
  if (!serverValid) {
    const csr = join(caDir, "server.csr");
    const ext = join(caDir, "server.ext");
    writeFileSync(ext, "subjectAltName=DNS:localhost,DNS:keycloak,IP:127.0.0.1\nbasicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n");
    openssl(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", serverKey, "-out", csr, "-subj", "/CN=localhost"], caDir);
    openssl(["x509", "-req", "-in", csr, "-CA", caPem, "-CAkey", caKey, "-CAcreateserial", "-days", "397", "-sha256", "-extfile", ext, "-out", serverPem], caDir);
    // The Keycloak container runs as uid 1000 and must read the key through the read-only bind mount.
    // It is a loopback-only certificate signed by this checkout's local CA (never trusted elsewhere).
    chmodSync(serverKey, 0o644);
    created.push("tls-server");
  }
  copyFileSync(caPem, join(tlsDir, "ca.pem"));
  return created;
}

/** Creates or completes the state directory; returns the names of generated items (never values). */
export function ensureState(stateDir: string): string[] {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const envFile = join(stateDir, "env");
  const env = readEnvFile(envFile);
  const created: string[] = [];
  for (const [key, gen] of GENERATED_ENV) {
    if (!env[key]) {
      env[key] = gen();
      created.push(key);
    }
  }
  env.VSP_LOCAL_STATE_DIR = stateDir;
  const lines = [
    "# GENERATED by scripts/vsp/up.mts: credentials for the LOCAL EMULATORS only (127.0.0.1 bindings).",
    "# Not valid for any real system. Regenerated on demand; delete this directory to rotate everything.",
    ...Object.entries(env)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}="${v}"`),
    "",
  ];
  writeFileSync(envFile, lines.join("\n"), { mode: 0o600 });
  chmodSync(envFile, 0o600);
  created.push(...ensureTls(stateDir));
  return created;
}

/* ------------------------------------------------------------------ compose inspection */

export interface ComposePsEntry {
  Name: string;
  Service: string;
  State: string;
  Health: string;
  Image: string;
  Publishers?: { URL?: string; TargetPort?: number; PublishedPort?: number; Protocol?: string }[] | null;
}

/** Parses `docker compose ps --format json` (a JSON array in older releases, NDJSON in newer ones). */
export function parsePsJson(stdout: string): ComposePsEntry[] {
  const text = stdout.trim();
  if (text === "") return [];
  if (text.startsWith("[")) return JSON.parse(text) as ComposePsEntry[];
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as ComposePsEntry);
}

export function composePs(ctx: ComposeContext): ComposePsEntry[] {
  const r = run("docker", [...composeBaseArgs(ctx), "ps", "--all", "--format", "json"]);
  if (r.code !== 0) throw new UsageError(`docker compose ps failed: ${r.stderr.trim()}`);
  return parsePsJson(r.stdout);
}

export function availableProfiles(ctx: ComposeContext): string[] {
  const r = run("docker", [...composeBaseArgs(ctx), "config", "--profiles"]);
  if (r.code !== 0) throw new UsageError(`docker compose config failed (invalid fragment?): ${r.stderr.trim()}`);
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

export function parseProfiles(value: string | undefined): string[] {
  const list = (value ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "");
  const profiles = list.length > 0 ? list : [...DEFAULT_PROFILES];
  for (const p of profiles) if (!PROFILE_RE.test(p)) throw new UsageError(`invalid profile "${p}"`);
  return [...new Set(profiles)];
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** UTC timestamp with milliseconds, lexically sortable: 20261019T113114123Z. */
export function stamp(d = new Date()): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.(\d{3})Z$/, "$1Z");
}

/** Writes evidence/runs/<name>-<stamp>.json (gitignored run records). Returns the path. */
export function writeRunRecord(evidenceDir: string, name: string, record: Record<string, unknown>): string {
  mkdirSync(evidenceDir, { recursive: true });
  const path = join(evidenceDir, `${name}-${stamp()}-${hex(3)}.json`);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

export function gitCommit(): string | null {
  const r = run("git", ["rev-parse", "HEAD"]);
  return r.code === 0 ? r.stdout.trim() : null;
}

/* ------------------------------------------------------------------ flags */

export interface ParsedFlags {
  values: Map<string, string[]>;
  booleans: Set<string>;
  rest: string[];
  positionals: string[];
}

/** Minimal flag parser: --name value, --name=value, boolean --flag, and everything after `--` in rest. */
export function parseFlags(argv: readonly string[], valueFlags: readonly string[], booleanFlags: readonly string[]): ParsedFlags {
  const values = new Map<string, string[]>();
  const booleans = new Set<string>();
  const rest: string[] = [];
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (!a.startsWith("--")) {
      positionals.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
    if (booleanFlags.includes(name)) {
      if (eq > 0) throw new UsageError(`flag --${name} takes no value`);
      booleans.add(name);
      continue;
    }
    if (!valueFlags.includes(name)) throw new UsageError(`unknown flag --${name}`);
    const value = eq > 0 ? a.slice(eq + 1) : argv[++i];
    if (value === undefined) throw new UsageError(`flag --${name} needs a value`);
    values.set(name, [...(values.get(name) ?? []), value]);
  }
  return { values, booleans, rest, positionals };
}

export const lastValue = (f: ParsedFlags, name: string): string | undefined => f.values.get(name)?.at(-1);

/* ------------------------------------------------------------------ up */

export interface UpOptions extends ContextOptions {
  profiles: string[];
  timeoutSeconds: number;
}

function portsOf(e: ComposePsEntry): string[] {
  return (e.Publishers ?? [])
    .filter((p) => (p.PublishedPort ?? 0) > 0)
    .map((p) => `${p.URL ?? "127.0.0.1"}:${p.PublishedPort}->${p.TargetPort}/${p.Protocol ?? "tcp"}`);
}

export function up(opts: UpOptions): number {
  const startedAt = new Date().toISOString();
  const composeVersion = requireDocker();
  const ctx = composeContext(opts);
  const generated = ensureState(ctx.stateDir);
  if (generated.length > 0) out(`generated local emulator state in ${relative(REPO_ROOT, ctx.stateDir) || ctx.stateDir}: ${generated.join(", ")}`);
  const available = availableProfiles(ctx);
  const unknown = opts.profiles.filter((p) => !available.includes(p));
  if (unknown.length > 0) throw new UsageError(`unknown profile(s) ${unknown.join(", ")}; available: ${available.join(", ")}`);
  const profileArgs = opts.profiles.flatMap((p) => ["--profile", p]);
  out(`up: project ${ctx.project}, profiles ${opts.profiles.join(",")}, fragments ${ctx.files.map((f) => relative(ctx.composeDir, f)).join(" ")}`);
  const upResult = run(
    "docker",
    [...composeBaseArgs(ctx), ...profileArgs, "up", "--detach", "--wait", "--wait-timeout", String(opts.timeoutSeconds), "--pull", "missing", "--remove-orphans", "--quiet-pull"],
    { inherit: true },
  );
  const ps = composePs(ctx);
  const unhealthy = ps.filter((e) => e.State !== "running" || (e.Health !== "" && e.Health !== "healthy"));
  for (const e of unhealthy) {
    err(`service ${e.Service}: state=${e.State} health=${e.Health || "none"}; last log lines:`);
    const logs = run("docker", [...composeBaseArgs(ctx), "logs", "--no-color", "--tail", "40", e.Service]);
    err(logs.stdout.trimEnd());
  }
  const code = upResult.code !== 0 ? upResult.code : unhealthy.length > 0 ? 1 : 0;
  const record = {
    schema: "vsp.local-composition.run.v1",
    action: "up",
    project: ctx.project,
    profiles: opts.profiles,
    composeVersion,
    commit: gitCommit(),
    fragments: ctx.files.map((f) => ({ path: relative(REPO_ROOT, f), sha256: sha256File(f) })),
    services: ps.map((e) => ({ service: e.Service, image: e.Image, state: e.State, health: e.Health || "none", ports: portsOf(e) })),
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode: code,
    note: "Local emulators only; no billable endpoint is called (OPS-05). Emulated behaviour per service: io.vsp.* labels in the compose fragments.",
  };
  const path = writeRunRecord(ctx.evidenceDir, "local-up", record);
  out("");
  out(`${"service".padEnd(24)} ${"state".padEnd(10)} ${"health".padEnd(10)} ports`);
  for (const s of record.services) out(`${s.service.padEnd(24)} ${s.state.padEnd(10)} ${s.health.padEnd(10)} ${s.ports.join(" ")}`);
  out(`run record: ${relative(REPO_ROOT, path)}`);
  out(code === 0 ? "up: all services healthy" : `up: FAILED (exit ${code})`);
  return code;
}

export function upMain(argv: readonly string[]): number {
  const f = parseFlags(argv, ["profile", "timeout", "project", "compose-dir", "state-dir", "evidence-dir"], []);
  if (f.positionals.length > 0) throw new UsageError(`unexpected argument ${f.positionals[0]}`);
  const timeout = Number(lastValue(f, "timeout") ?? process.env.VSP_UP_TIMEOUT ?? 600);
  if (!Number.isInteger(timeout) || timeout < 10 || timeout > 3600) throw new UsageError("--timeout must be 10..3600 seconds");
  return up({
    profiles: parseProfiles(lastValue(f, "profile") ?? process.env.PROFILE),
    timeoutSeconds: timeout,
    project: lastValue(f, "project"),
    composeDir: lastValue(f, "compose-dir"),
    stateDir: lastValue(f, "state-dir"),
    evidenceDir: lastValue(f, "evidence-dir"),
  });
}
