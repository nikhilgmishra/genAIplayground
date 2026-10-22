/**
 * Real-model local profile (WP-08; FO-16-24, FO-19-09, OPS-05, DATA-01): run real model text tasks locally with
 * nothing more than a REVIEWED model credential (OpenAI, Bedrock) or licensed local weights served by vLLM.
 *
 * Evaluating a profile never touches the network. It is CONFIGURED only when every input exists:
 *  - a credential source (an environment variable, an owner-only file, the AWS environment credentials, or for
 *    local weights no key) whose value is present now;
 *  - a review record of that credential and its data controls (approval id and data-controls reference, AIN-26 and
 *    AIN-49), or for local weights the licence review of the weights (AIN-28) and their manifest digest;
 *  - an egress allowlist entry approved for the endpoint's provider, region and retention terms;
 *  - synthetic data only: the endpoint's maximum data class is PUBLIC or INTERNAL (a local profile never carries PHI).
 * Otherwise it is NOT_CONFIGURED with the reasons, and no port, transport or socket is created.
 *
 * Billability and the review requirement are derived from the DESTINATION, never from a self-declared label
 * (security review D7):
 *  - EMULATOR: every request host is routed to a loopback emulator (`emulatorRoutes` covers the endpoint host; the
 *    transport then connects to 127.0.0.1 only). `adapterKind: "emulator"` without such a route is a profile error
 *    (REAL_MODEL_EMULATOR_ROUTES_MISSING), so the label cannot make a provider host look local;
 *  - SELF_HOSTED_PRIVATE: a vLLM endpoint on the PRIVATE_NETWORK address class (the transport refuses any DNS answer
 *    outside private ranges) whose egress destination is MODEL_SELF_HOSTED. Only here do licensed local weights
 *    stand in for a credential review, and nothing is billable;
 *  - HOSTED: everything else, whatever the provider label: the credential review is required, and the run is a paid
 *    call that is not EXECUTABLE without a billable-execution approval id (AIN-30, BILLABLE_TEST_EXECUTION).
 *    `runRealModelProfile` refuses it before any request.
 */
import { closeSync, constants as fsConstants, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { ConnectorHttpTransport } from "../../connectors/http/transport.js";
import type { LoopbackRoute } from "../../connectors/http/transport.js";
import type { Metrics } from "../../observability/ports.js";
import { EgressGuard, EgressPolicyConfig } from "../../privacy/egress.js";
import { Sha256Hex } from "../../protocol/common.js";
import type { Clock } from "../../shared/clock.js";
import { newId } from "../../shared/ids.js";
import { ModelEndpointConfig, modelEndpointGuardViolations } from "../port/config.js";
import type { ModelCredential } from "../port/credentials.js";
import type { ModelPort, ModelResult } from "../port/types.js";
import { createModelAdapter, createResilientPort, MODEL_MAX_RESPONSE_BYTES } from "./factory.js";
import { modelExchangeFor } from "./http-exchange.js";
import type { ModelHttpExchange } from "./http-exchange.js";
import { egressBindingFor, invokeUrlFor } from "../port/config.js";

export const REAL_MODEL_PROFILE_SCHEMA_VERSION = "real-model-profile.v1";

const ApprovalId = z.string().regex(/^apr_[A-Za-z0-9_-]{8,64}$/);

export const RealModelCredentialSource = z.discriminatedUnion("source", [
  /** A bearer key in this environment variable (OpenAI project key, vLLM --api-key). */
  z.strictObject({ source: z.literal("env"), variable: z.string().regex(/^VSP_MODEL_[A-Z0-9_]{1,40}$/) }),
  /** A bearer key in an owner-only file (mode 0600 or stricter). */
  z.strictObject({ source: z.literal("file"), path: z.string().min(2).max(1_024).refine((p) => isAbsolute(p), "absolute path expected") }),
  /** AWS credentials from AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN (Bedrock). */
  z.strictObject({ source: z.literal("aws_env") }),
  /** No key: a private vLLM server started without --api-key (local weights only). */
  z.strictObject({ source: z.literal("none") }),
]);

export const RealModelProfile = z.strictObject({
  schemaVersion: z.literal(REAL_MODEL_PROFILE_SCHEMA_VERSION),
  profileId: z.string().regex(/^[a-z][a-z0-9_-]{2,40}$/),
  endpoint: ModelEndpointConfig,
  credential: RealModelCredentialSource.nullable(),
  /** Review of the credential and the provider data controls (AIN-26, AIN-49). */
  review: z.strictObject({ approvalId: ApprovalId, dataControlsRef: z.string().regex(/^[a-z][a-z0-9_.-]{2,63}$/), reviewedOn: z.iso.date() }).nullable(),
  /** Licensed local weights served by the vLLM endpoint (AIN-28 licence review, pinned manifest digest). */
  localWeights: z.strictObject({ manifestSha256: Sha256Hex, licenceReviewRef: z.string().regex(/^[a-z][a-z0-9_.-]{2,63}$/) }).nullable(),
  /** Billable test execution approval (AIN-30); required to run a paid provider. */
  billable: z.strictObject({ approvalId: ApprovalId }).nullable(),
  egress: EgressPolicyConfig,
  /** local/ci emulator runs of this path only: TLS routes to the emulator and its CA file. */
  emulatorRoutes: z.strictObject({ routes: z.array(z.strictObject({ host: z.string().min(4).max(253), port: z.number().int().min(1).max(65_535) })).min(1).max(8), caFile: z.string().min(2).max(1_024) }).nullable().default(null),
});
export type RealModelProfile = z.infer<typeof RealModelProfile>;

export interface RealModelProfileEnv {
  getEnv(name: string): string | undefined;
  /** Reads a credential file after checking it is owner-only; throws when missing or readable by others. */
  readSecretFile(path: string): string;
}

/**
 * The production credential-file reader (local profile only). The path is opened ONCE, without following a symlink
 * (O_NOFOLLOW: a link at the path is refused, never followed to a file someone else controls) and without blocking on
 * a FIFO (O_NONBLOCK); the checks and the read then use that same open file, so nothing can be swapped between them
 * (no time-of-check gap): a regular file, no group or world permission bits, owned by this process's user.
 */
function readOwnerOnlyFile(path: string): string {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === "ELOOP") throw new Error("MODEL_CREDENTIAL_FILE_INSECURE", { cause: err });
    throw err;
  }
  try {
    const st = fstatSync(fd);
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (!st.isFile() || (st.mode & 0o077) !== 0 || (uid !== null && st.uid !== uid)) throw new Error("MODEL_CREDENTIAL_FILE_INSECURE");
    return readFileSync(fd, "utf8").trim();
  } finally {
    closeSync(fd);
  }
}

export const processEnv: RealModelProfileEnv = {
  getEnv: (name) => process.env[name],
  readSecretFile: readOwnerOnlyFile,
};

export interface RealModelProfileStatus {
  profileId: string;
  provider: RealModelProfile["endpoint"]["provider"];
  status: "CONFIGURED" | "NOT_CONFIGURED";
  /** CONFIGURED and allowed to run now (a paid provider also needs the billable approval). */
  executable: boolean;
  reasons: string[];
  /** Blocking profile errors (the profile itself is wrong, not just incomplete). */
  violations: string[];
}

/** Where a profile's requests go, derived from the routes, the address class and the egress destination. */
export type RealModelDestination = "EMULATOR" | "SELF_HOSTED_PRIVATE" | "HOSTED";

/** The destination class of a (parsed) profile; never trusts `adapterKind` or the provider label alone. */
export function realModelDestination(p: RealModelProfile): RealModelDestination {
  const host = invokeUrlFor(p.endpoint).hostname.toLowerCase();
  const routed = (p.emulatorRoutes?.routes ?? []).some((r) => r.host.toLowerCase() === host);
  if (p.endpoint.adapterKind === "emulator" && routed) return "EMULATOR";
  const destination = p.egress.destinations.find((d) => d.hosts.includes(host));
  if (p.endpoint.provider === "vllm_openai_compatible" && p.endpoint.network === "PRIVATE_NETWORK" && destination?.kind === "MODEL_SELF_HOSTED") return "SELF_HOSTED_PRIVATE";
  return "HOSTED";
}

/** The credential handle of a profile, resolved from the local environment (no network). */
function credentialFor(p: RealModelProfile, env: RealModelProfileEnv): { handle: ModelCredential | null; reason: string | null } {
  const c = p.credential;
  if (c === null) return { handle: null, reason: "MODEL_CREDENTIAL_NOT_CONFIGURED" };
  switch (c.source) {
    case "none":
      return p.endpoint.provider === "vllm_openai_compatible" ? { handle: null, reason: null } : { handle: null, reason: "MODEL_CREDENTIAL_NOT_CONFIGURED" };
    case "env": {
      const v = env.getEnv(c.variable);
      if (!v || v.trim() === "") return { handle: null, reason: "MODEL_CREDENTIAL_UNAVAILABLE" };
      const token = v.trim();
      return { handle: { kind: "bearer", token: async () => token }, reason: null };
    }
    case "file": {
      let token: string;
      try {
        token = env.readSecretFile(c.path);
      } catch (err) {
        return { handle: null, reason: err instanceof Error && err.message === "MODEL_CREDENTIAL_FILE_INSECURE" ? "MODEL_CREDENTIAL_FILE_INSECURE" : "MODEL_CREDENTIAL_UNAVAILABLE" };
      }
      if (token === "") return { handle: null, reason: "MODEL_CREDENTIAL_UNAVAILABLE" };
      return { handle: { kind: "bearer", token: async () => token }, reason: null };
    }
    case "aws_env": {
      const accessKeyId = env.getEnv("AWS_ACCESS_KEY_ID");
      const secretAccessKey = env.getEnv("AWS_SECRET_ACCESS_KEY");
      const sessionToken = env.getEnv("AWS_SESSION_TOKEN");
      if (!accessKeyId || !secretAccessKey) return { handle: null, reason: "MODEL_CREDENTIAL_UNAVAILABLE" };
      return { handle: { kind: "aws", credentials: async () => ({ accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) }) }, reason: null };
    }
  }
}

/** Status of a profile. Never opens a socket. */
export function evaluateRealModelProfile(raw: unknown, env: RealModelProfileEnv = processEnv): RealModelProfileStatus & { credential: ModelCredential | null } {
  const parsed = RealModelProfile.safeParse(raw);
  if (!parsed.success) return { profileId: "invalid", provider: "openai_responses", status: "NOT_CONFIGURED", executable: false, reasons: [], violations: ["REAL_MODEL_PROFILE_INVALID"], credential: null };
  const p = parsed.data;
  const reasons: string[] = [];
  const violations: string[] = [];
  const e = p.endpoint;
  if (e.maxDataClass !== "PUBLIC" && e.maxDataClass !== "INTERNAL") violations.push("REAL_MODEL_PROFILE_SYNTHETIC_ONLY");
  if (!e.environments.includes("local")) violations.push("REAL_MODEL_PROFILE_LOCAL_ONLY");
  if (p.emulatorRoutes !== null && e.adapterKind !== "emulator") violations.push("REAL_MODEL_EMULATOR_ROUTES_ON_LIVE_ENDPOINT");
  const destination = realModelDestination(p);
  // An emulator label must be backed by a loopback route for the endpoint host: otherwise it would call the host.
  if (e.adapterKind === "emulator" && destination !== "EMULATOR") violations.push("REAL_MODEL_EMULATOR_ROUTES_MISSING");
  const report = modelEndpointGuardViolations([e], { environment: "local", egress: p.egress });
  violations.push(...report.violations);
  const st = report.status[0];
  for (const r of st?.reasons ?? []) if (r !== "MODEL_CREDENTIAL_NOT_CONFIGURED") reasons.push(r);
  // Licensed local weights replace the credential review only for a private self-hosted server (or its emulator).
  const weights = e.provider === "vllm_openai_compatible" && p.localWeights !== null && destination !== "HOSTED";
  if (e.provider === "vllm_openai_compatible" && p.localWeights !== null && destination === "HOSTED") reasons.push("MODEL_LOCAL_WEIGHTS_NOT_PRIVATE");
  if (weights) {
    if (p.credential === null) reasons.push("MODEL_CREDENTIAL_NOT_CONFIGURED");
  } else if (p.review === null) reasons.push("MODEL_CREDENTIAL_NOT_REVIEWED");
  if (e.provider === "vllm_openai_compatible" && p.localWeights === null && p.review === null) reasons.push("MODEL_WEIGHTS_NOT_LICENSED");
  const cred = credentialFor(p, env);
  if (cred.reason) reasons.push(cred.reason);
  const unique = [...new Set(reasons)];
  const configured = unique.length === 0 && violations.length === 0;
  // Every hosted destination is a paid, live call (whatever the provider label says).
  const paidWithoutApproval = destination === "HOSTED" && p.billable === null;
  return {
    profileId: p.profileId,
    provider: e.provider,
    status: configured ? "CONFIGURED" : "NOT_CONFIGURED",
    executable: configured && !paidWithoutApproval,
    reasons: configured && paidWithoutApproval ? ["BILLABLE_EXECUTION_NOT_APPROVED"] : unique,
    violations,
    credential: configured ? cred.handle : null,
  };
}

/** The synthetic text task of the profile (no caller data; DATA-01). */
export const REAL_MODEL_TASK = {
  instructions: "You are a test harness endpoint. Reply with one short sentence confirming you are reachable. Do not ask questions.",
  prompt: "Synthetic connectivity check: please confirm you are reachable.",
} as const;

export interface RealModelRunDeps {
  clock: Clock;
  env?: RealModelProfileEnv;
  metrics?: Metrics;
  /** Exchange override for tests (the default is the egress-classified transport built from the profile). */
  exchange?: ModelHttpExchange;
  readCaFile?: (path: string) => string;
}

export interface RealModelRun {
  status: RealModelProfileStatus;
  /** Null when the profile did not run (NOT_CONFIGURED or not executable): no request was made. */
  result: ModelResult | null;
}

/** The exchange of a CONFIGURED profile (its own transport, bound to the endpoint's egress terms). */
export function profileExchange(p: RealModelProfile, readCaFile: (path: string) => string = (f) => readFileSync(f, "utf8"), metrics?: Metrics): ModelHttpExchange {
  const guard = new EgressGuard(p.egress, { environment: "local" });
  const routes = new Map<string, LoopbackRoute>((p.emulatorRoutes?.routes ?? []).map((r) => [r.host.toLowerCase(), { port: r.port, tls: true }]));
  const transport = new ConnectorHttpTransport({
    environment: "local",
    egress: guard.forModelEndpoint(egressBindingFor(p.endpoint)),
    maxResponseBytes: MODEL_MAX_RESPONSE_BYTES,
    ...(routes.size > 0 ? { loopbackRoutes: routes } : {}),
    ...(p.emulatorRoutes ? { tlsCa: [readCaFile(p.emulatorRoutes.caFile)] } : {}),
    ...(metrics ? { metrics } : {}),
  });
  return modelExchangeFor(transport, { allowedHosts: [invokeUrlFor(p.endpoint).hostname.toLowerCase(), ...[...routes.keys()]], addressClass: p.endpoint.network });
}

/** Runs the synthetic task when the profile is CONFIGURED and executable; otherwise returns the status, no request. */
export async function runRealModelProfile(raw: unknown, deps: RealModelRunDeps): Promise<RealModelRun> {
  const evaluated = evaluateRealModelProfile(raw, deps.env ?? processEnv);
  const { credential, ...status } = evaluated;
  try {
    deps.metrics?.gauge("vsp_model_profile_status", 1, { provider: status.provider, status: status.status });
  } catch {
    // metrics never change the outcome
  }
  if (status.status !== "CONFIGURED" || !status.executable) return { status, result: null };
  const p = RealModelProfile.parse(raw);
  const exchange = deps.exchange ?? profileExchange(p, deps.readCaFile, deps.metrics);
  const port: ModelPort = createResilientPort(p.endpoint, createModelAdapter(p.endpoint, exchange, credential), { clock: deps.clock, ...(deps.metrics ? { metrics: deps.metrics } : {}) });
  const result = await port.invoke({
    invocationId: newId("minv"),
    role: "router",
    instructions: REAL_MODEL_TASK.instructions,
    messages: [{ role: "user", content: REAL_MODEL_TASK.prompt }],
    dataClass: "INTERNAL",
    budget: p.endpoint.budget,
  });
  return { status, result };
}
