/**
 * Layer-2 support for the model suite (WP-08). The production model path (createModelPorts -> ResilientModelPort ->
 * provider adapter -> TransportModelExchange -> ConnectorHttpTransport with the per-request model egress check) over
 * TLS to the `model-emulator` compose service (deploy/local/services/model-emulator.compose.yaml): the server name is
 * verified against a private test CA generated per test file with the system openssl; nothing is skipped. Hosts are
 * unique per test (`t<random>.<provider>.models.test`), registered with the emulator through its admin API together
 * with their synthetic credentials, so parallel test files never share emulator state.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoopbackRoute } from "../../../src/connectors/http/transport.js";
import { withConnectorMetrics } from "../../../src/observability/catalog/connectors.js";
import { DEFAULT_METRIC_CATALOGUE, InMemoryMetrics } from "../../../src/observability/metrics.js";
import { EgressGuard } from "../../../src/privacy/egress.js";
import type { EgressPolicyConfig } from "../../../src/privacy/egress.js";
import { systemClock } from "../../../src/shared/clock.js";
import { createModelPorts } from "../../../src/models/adapters/factory.js";
import { ModelEndpointConfig } from "../../../src/models/port/config.js";
import type { ModelEndpointConfigInput } from "../../../src/models/port/config.js";
import type { ModelCredential } from "../../../src/models/port/credentials.js";
import { withModelMetrics } from "../../../src/models/port/metrics.js";
import type { ModelPort, ModelProvider } from "../../../src/models/port/types.js";
import type { EmulatorScript } from "../../../src/models/emulators/scenarios.js";
import type { HostCredentials, RequestLogEntry } from "../../emulators/models/server.js";
import type { Layer2Context } from "../_harness/layer2.js";

export const SERVICE = "model-emulator";
export const HTTPS_PORT = 8443;
export const ADMIN_PORT = 8080;
export const REGION = "us-east-1";
export const RETENTION = "retention.emulator_none";

const rand = (n = 5) => randomBytes(n).toString("hex");
export const syntheticKey = (): string => `key_synth${rand(8)}`;
export const syntheticAws = () => ({ accessKeyId: `akid_synth${rand(6)}`, secretAccessKey: `sk_synth${rand(16)}` });

const LABEL: Record<ModelProvider, string> = { openai_responses: "openai", bedrock_converse: "bedrock", vllm_openai_compatible: "vllm" };
export const hostFor = (provider: ModelProvider): string => `t${rand()}.${LABEL[provider]}.models.test`;

export interface TestPki {
  dir: string;
  caPem: string;
  caPath: string;
  certPem: string;
  keyPem: string;
  dispose(): void;
}

/** A private CA and one wildcard leaf for `*.openai|bedrock|vllm.models.test` (P-256, serverAuth), per test file. */
export function createModelPki(): TestPki {
  const dir = mkdtempSync(join(tmpdir(), "vsp-models-pki-"));
  const run = (args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
  run(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "ca.key"]);
  run(["req", "-x509", "-new", "-key", "ca.key", "-sha256", "-days", "2", "-subj", "/CN=VSP Layer-2 model emulator test CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-out", "ca.pem"]);
  run(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "leaf.key"]);
  run(["req", "-new", "-key", "leaf.key", "-subj", "/CN=models.test", "-out", "leaf.csr"]);
  writeFileSync(join(dir, "leaf.ext"), "basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:*.openai.models.test,DNS:*.bedrock.models.test,DNS:*.vllm.models.test\n");
  run(["x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-days", "2", "-sha256", "-extfile", "leaf.ext", "-out", "leaf.pem"]);
  const read = (f: string) => readFileSync(join(dir, f), "utf8");
  return { dir, caPem: read("ca.pem"), caPath: join(dir, "ca.pem"), certPem: read("leaf.pem"), keyPem: read("leaf.key"), dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The emulator's admin API (plain HTTP on 127.0.0.1). */
export class EmulatorAdmin {
  constructor(private readonly base: string) {}

  static of(l2: Layer2Context): EmulatorAdmin {
    return new EmulatorAdmin(`http://127.0.0.1:${l2.port(SERVICE, ADMIN_PORT)}`);
  }

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${this.base}${path}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : null });
    const out = (await res.json()) as unknown;
    if (!res.ok) throw new Error(`EMULATOR_ADMIN_${res.status}`);
    return out;
  }

  async tls(servername: string, pki: TestPki): Promise<void> {
    await this.call("POST", "/__emulator/tls", { servername, cert: pki.certPem, key: pki.keyPem });
  }

  async host(host: string, credentials: HostCredentials): Promise<void> {
    await this.call("POST", "/__emulator/hosts", { host, credentials });
  }

  async scripts(host: string, ...scripts: EmulatorScript[]): Promise<void> {
    await this.call("POST", "/__emulator/scripts", { host, scripts });
  }

  async fault(host: string, fault: "MODEL_REFUSAL" | "MODEL_HANG" | "MODEL_OVERLOAD", count = 1, override: Partial<EmulatorScript> = {}): Promise<void> {
    await this.call("POST", "/__emulator/faults", { host, fault, count, override });
  }

  async requests(host: string): Promise<RequestLogEntry[]> {
    return ((await this.call("GET", `/__emulator/requests?host=${encodeURIComponent(host)}`)) as { requests: RequestLogEntry[] }).requests;
  }

  async forget(host: string): Promise<void> {
    await this.call("DELETE", `/__emulator/hosts?host=${encodeURIComponent(host)}`);
  }
}

export function endpointConfig(provider: ModelProvider, host: string, over: Partial<ModelEndpointConfigInput> = {}): ModelEndpointConfig {
  return ModelEndpointConfig.parse({
    endpointRef: `ep.${LABEL[provider]}.${rand()}`,
    provider,
    baseUrl: `https://${host}`,
    region: REGION,
    retentionPolicyRef: RETENTION,
    network: "PUBLIC_INTERNET",
    model: { id: "emulated-text", revision: "emulated.1" },
    credentialRef: provider === "bedrock_converse" ? "aws:task-role" : "local-fixture:models/synth",
    maxDataClass: "INTERNAL",
    budget: { deadlineMs: 8_000, attemptTimeoutMs: 6_000, firstEventTimeoutMs: 4_000, idleTimeoutMs: 4_000, maxOutputTokens: 256, maxInputBytes: 65_536 },
    retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    breaker: { windowMs: 60_000, minimumRequests: 20, failureRateThreshold: 0.5, cooldownMs: 30_000, halfOpenMaxProbes: 1, halfOpenSuccessesToClose: 1 },
    bulkhead: { maxConcurrent: 8, maxQueue: 8, queueTimeoutMs: 4_000 },
    openai: provider === "openai_responses" ? { organization: null, project: null, strictToolSchemas: false } : null,
    bedrock: provider === "bedrock_converse" ? { guardrail: null } : null,
    vllm: provider === "vllm_openai_compatible" ? { toolParser: "hermes", structuredOutput: "json_schema" } : null,
    environments: ["local", "ci"],
    adapterKind: "emulator",
    ...over,
  });
}

/**
 * An egress policy approving each endpoint's host as a model-class destination with its exact terms. With
 * `allowPhi`, the destinations also accept PHI under SYNTHETIC coverage references.
 */
export function egressPolicyFor(endpoints: readonly ModelEndpointConfig[], extraHosts: readonly string[] = [], o: { allowPhi?: boolean } = {}): EgressPolicyConfig {
  return {
    policyVersion: `models-l2.${rand()}`,
    destinations: endpoints.map((e, i) => ({
      destinationId: `egr_model_l2_${i}_${rand(3)}`,
      kind: e.provider === "vllm_openai_compatible" ? "MODEL_SELF_HOSTED" : "MODEL_PROVIDER_API",
      hosts: [new URL(e.baseUrl).hostname, ...(i === 0 ? extraHosts : [])],
      allowedClasses: o.allowPhi ? ["PUBLIC", "INTERNAL", "PHI"] : ["PUBLIC", "INTERNAL"],
      coverage: o.allowPhi ? { baaRef: "SYNTH-BAA-REF", approvalId: "apr_synthModelPhiEgress01" } : { baaRef: null, approvalId: null },
      environments: ["local", "ci"],
      adapterKind: "local_fixture",
      model: { provider: e.provider, region: e.region, retentionPolicyRef: e.retentionPolicyRef },
    })),
  };
}

export function metrics(): InMemoryMetrics {
  return new InMemoryMetrics({ catalogue: withModelMetrics(withConnectorMetrics(DEFAULT_METRIC_CATALOGUE)) });
}

export interface LiveRig {
  port: ModelPort;
  /** The emulator's HTTPS port as published on 127.0.0.1 (the only port the transport may connect to). */
  emulatorPort: number;
  endpoint: ModelEndpointConfig;
  host: string;
  admin: EmulatorAdmin;
  metrics: InMemoryMetrics;
}

export interface LiveRigOptions {
  endpoint?: Partial<ModelEndpointConfigInput>;
  credential?: ModelCredential | null;
  hostCredentials?: (keys: { bearer: string; aws: { accessKeyId: string; secretAccessKey: string } }) => HostCredentials;
  /** CA the transport trusts (default: the file's test CA). */
  tlsCa?: readonly string[];
  /** The endpoint's egress destination also accepts PHI (synthetic coverage references). */
  egressAllowsPhi?: boolean;
}

/** The production model port for `provider` over TLS to the compose emulator. */
export async function liveRig(l2: Layer2Context, pki: TestPki, provider: ModelProvider, o: LiveRigOptions = {}): Promise<LiveRig> {
  const admin = EmulatorAdmin.of(l2);
  const host = hostFor(provider);
  const endpoint = endpointConfig(provider, host, o.endpoint ?? {});
  const bearer = syntheticKey();
  const aws = syntheticAws();
  await admin.tls(host, pki);
  await admin.host(host, o.hostCredentials ? o.hostCredentials({ bearer, aws }) : { bearer: [bearer], aws: [aws], region: REGION, models: ["emulated-text", "emulated-tools"] });
  const credential: ModelCredential | null = o.credential !== undefined ? o.credential : provider === "bedrock_converse" ? { kind: "aws", credentials: async () => aws } : { kind: "bearer", token: async () => bearer };
  const m = metrics();
  const policy = egressPolicyFor([endpoint], [], { allowPhi: o.egressAllowsPhi === true });
  const routes = new Map<string, LoopbackRoute>([[host, { port: l2.port(SERVICE, HTTPS_PORT), tls: true }]]);
  const { ports } = createModelPorts([endpoint], {
    environment: "local",
    egress: new EgressGuard(policy, { environment: "local", metrics: m }),
    egressPolicy: policy,
    clock: systemClock,
    credentials: () => credential,
    metrics: m,
    loopbackRoutes: routes,
    tlsCa: o.tlsCa ?? [pki.caPem],
  });
  const port = ports.get(endpoint.endpointRef);
  if (!port) throw new Error("MODEL_PORT_NOT_COMPOSED");
  return { port, emulatorPort: l2.port(SERVICE, HTTPS_PORT), endpoint, host, admin, metrics: m };
}

export const LOOKUP_TOOL = {
  name: "lookup_status",
  description: "Looks up the status of a synthetic support reference.",
  parameters: { type: "object", properties: { reference: { type: "string" } }, required: ["reference"], additionalProperties: false },
};

export function request(over: Record<string, unknown> = {}) {
  return {
    invocationId: `minv_synth${rand()}${rand()}`,
    role: "router" as const,
    instructions: "Synthetic instructions for the Layer-2 emulator.",
    messages: [{ role: "user" as const, content: "Synthetic caller turn." }],
    dataClass: "INTERNAL" as const,
    budget: { deadlineMs: 8_000, attemptTimeoutMs: 6_000, firstEventTimeoutMs: 4_000, idleTimeoutMs: 4_000, maxOutputTokens: 256, maxInputBytes: 65_536 },
    ...over,
  };
}

/** Polls the emulator log until `pred` holds (bounded). */
export async function waitForLog(admin: EmulatorAdmin, host: string, pred: (log: RequestLogEntry[]) => boolean, timeoutMs = 5_000): Promise<RequestLogEntry[]> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const log = await admin.requests(host);
    if (pred(log) || Date.now() > until) return log;
    await new Promise((r) => setTimeout(r, 50));
  }
}
