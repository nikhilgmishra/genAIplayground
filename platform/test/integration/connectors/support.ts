/**
 * Layer-2 support for the connector runtime suite (WP-06). Everything here is production code wired to the
 * local emulators: the connector runtime, the egress-classified transport over TLS (a private test CA
 * generated with openssl; the server name is verified, nothing is skipped), the Secrets Manager
 * SecretResolver over LocalStack, and the vendor protocol emulator (emulator.ts) served over HTTPS on
 * 127.0.0.1 through explicit `local` loopback routes. No LOCAL FIXTURE secret resolver, no PGlite.
 */
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CreateSecretCommand, DeleteSecretCommand } from "@aws-sdk/client-secrets-manager";
import type { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { ConnectorHttpTransport } from "../../../src/connectors/http/transport.js";
import { admitConnectorProfile } from "../../../src/connectors/profile/validate.js";
import { ConnectorRuntime } from "../../../src/connectors/runtime/connector.js";
import { SecretsManagerSecretResolver } from "../../../src/connectors/secrets/resolver.js";
import { withConnectorMetrics } from "../../../src/observability/catalog/connectors.js";
import { DEFAULT_METRIC_CATALOGUE, InMemoryMetrics } from "../../../src/observability/metrics.js";
import { EgressGuard } from "../../../src/privacy/egress.js";
import type { Clock } from "../../../src/shared/clock.js";
import { systemClock } from "../../../src/shared/clock.js";
import { secretsClient, uniqueName } from "../_harness/clients.js";
import { PLATFORM_ROOT } from "../_harness/env.js";
import type { Layer2Context } from "../_harness/layer2.js";
import { VendorEmulator } from "./emulator.js";
import type { EmulatorOptions } from "./emulator.js";
import { API_HOST, AUTH_HOST, emulatorEgressPolicy, emulatorProfile } from "./profiles.js";
import type { ProfileOptions } from "./profiles.js";

export interface TestPki {
  dir: string;
  caPem: string;
  certPem: string;
  keyPem: string;
  caPath: string;
  dispose(): void;
}

/**
 * A private CA and a leaf certificate for the emulated vendor's API and token hosts (P-256, SAN DNS names,
 * serverAuth). Generated per test file with the system openssl; the transport trusts only this CA.
 */
export function createTestPki(): TestPki {
  const dir = mkdtempSync(join(tmpdir(), "vsp-conn-pki-"));
  const run = (args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
  run(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "ca.key"]);
  run(["req", "-x509", "-new", "-key", "ca.key", "-sha256", "-days", "2", "-subj", "/CN=VSP Layer-2 connector test CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-out", "ca.pem"]);
  run(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "leaf.key"]);
  run(["req", "-new", "-key", "leaf.key", "-subj", `/CN=${API_HOST}`, "-out", "leaf.csr"]);
  writeFileSync(join(dir, "leaf.ext"), `basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:${API_HOST},DNS:${AUTH_HOST}\n`);
  run(["x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-days", "2", "-sha256", "-extfile", "leaf.ext", "-out", "leaf.pem"]);
  const read = (f: string) => readFileSync(join(dir, f), "utf8");
  return { dir, caPem: read("ca.pem"), certPem: read("leaf.pem"), keyPem: read("leaf.key"), caPath: join(dir, "ca.pem"), dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Creates a Secrets Manager secret holding `value` (JSON) under a unique name; returns its ARN. */
export async function createSecret(sm: SecretsManagerClient, prefix: string, value: object): Promise<string> {
  const out = await sm.send(new CreateSecretCommand({ Name: uniqueName(`vsp-it/${prefix}`), SecretString: JSON.stringify(value) }));
  if (!out.ARN) throw new Error("LocalStack returned no ARN");
  return out.ARN;
}

export async function deleteSecret(sm: SecretsManagerClient, arn: string): Promise<void> {
  await sm.send(new DeleteSecretCommand({ SecretId: arn, ForceDeleteWithoutRecovery: true })).catch(() => undefined);
}

export interface LiveRig {
  em: VendorEmulator;
  rt: ConnectorRuntime;
  sm: SecretsManagerClient;
  secrets: SecretsManagerSecretResolver;
  transport: ConnectorHttpTransport;
  metrics: InMemoryMetrics;
  readRef: string;
  writeRef: string;
  dispose(): Promise<void>;
}

export interface LiveRigOptions {
  profile?: Partial<ProfileOptions>;
  emulator?: EmulatorOptions;
  clock?: Clock;
  cacheTtlMs?: number;
  /** Client secrets stored in Secrets Manager (and accepted by the emulated vendor). */
  readSecret?: string;
  writeSecret?: string;
  /** Environment the profile is admitted for (default local; a PRODUCTION_WRITE profile needs staging). */
  admitEnvironment?: "local" | "staging";
}

/** The production runtime over TLS, with its credentials in LocalStack Secrets Manager. */
export async function liveRig(l2: Layer2Context, pki: TestPki, o: LiveRigOptions = {}): Promise<LiveRig> {
  const readSecret = o.readSecret ?? `read-${uniqueName("s")}`;
  const writeSecret = o.writeSecret ?? `write-${uniqueName("s")}`;
  const em = await new VendorEmulator({
    tls: { cert: pki.certPem, key: pki.keyPem },
    clients: { "client-read": readSecret, "client-write": writeSecret },
    clientScopes: { "client-read": ["appointments:read"], "client-write": ["appointments:write"] },
    ...o.emulator,
  }).start();
  const sm = secretsClient(l2);
  const readRef = await createSecret(sm, "conn-read", { clientId: "client-read", clientSecret: readSecret });
  const writeRef = await createSecret(sm, "conn-write", { clientId: "client-write", clientSecret: writeSecret });
  const clock = o.clock ?? systemClock;
  const metrics = new InMemoryMetrics({ catalogue: withConnectorMetrics(DEFAULT_METRIC_CATALOGUE) });
  const secrets = new SecretsManagerSecretResolver(sm, { clock, cacheTtlMs: o.cacheTtlMs ?? 300_000, metrics });
  const transport = new ConnectorHttpTransport({
    environment: "local",
    egress: new EgressGuard(emulatorEgressPolicy(), { environment: "local" }),
    loopbackRoutes: new Map([
      [API_HOST, { port: em.port, tls: true }],
      [AUTH_HOST, { port: em.port, tls: true }],
    ]),
    tlsCa: [pki.caPem],
    metrics,
  });
  const admitted = admitConnectorProfile(emulatorProfile({ readRef, writeRef, ...o.profile }), o.admitEnvironment ?? "local");
  const rt = new ConnectorRuntime({ admitted, transport, secrets, clock, metrics });
  return {
    em,
    rt,
    sm,
    secrets,
    transport,
    metrics,
    readRef,
    writeRef,
    async dispose() {
      await em.stop();
      await deleteSecret(sm, readRef);
      await deleteSecret(sm, writeRef);
    },
  };
}

/** Sum of a counter's samples whose labels include `labels`. */
export function counter(metrics: InMemoryMetrics, name: string, labels: Record<string, string> = {}): number {
  return metrics
    .find(name)
    .filter((s) => Object.entries(labels).every(([k, v]) => s.labels[k] === v))
    .reduce((n, s) => n + s.value, 0);
}

export interface ChildRun {
  child: ChildProcess;
  lines: string[];
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/** Starts `node --import tsx <script>` in platform/, collecting stdout lines (the child prints opaque ids only). */
export function runChild(script: string, env: NodeJS.ProcessEnv): ChildRun {
  const child = spawn(process.execPath, ["--import", "tsx", script], { cwd: PLATFORM_ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
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

/** Waits until the child printed a line starting with `marker`; fails if it exits first or times out. */
export async function waitForLine(run: ChildRun, marker: string, timeoutMs = 60_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const line = run.lines.find((l) => l.startsWith(marker));
    if (line) return line;
    if (run.child.exitCode !== null || run.child.signalCode !== null) throw new Error(`CHILD_EXITED_BEFORE_MARKER: ${marker} (last lines: ${run.lines.slice(-5).join(" | ")})`);
    if (Date.now() > deadline) throw new Error(`CHILD_MARKER_TIMEOUT: ${marker}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
