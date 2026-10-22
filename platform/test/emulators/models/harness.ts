/**
 * Layer-1 harness for the model adapter tests (WP-08): the protocol-exact emulator in process (plain HTTP on
 * 127.0.0.1) and the PRODUCTION path over it: createModelPorts -> ResilientModelPort -> provider adapter ->
 * TransportModelExchange -> ConnectorHttpTransport with the per-request model egress check, routed to the emulator
 * through the transport's local loopback route. Nothing here replaces production code; the only test-side pieces are
 * the emulator itself and synthetic configuration (`emulated-*` model ids, `*_synth*` credentials, `.test` hosts).
 */
import { randomBytes } from "node:crypto";
import type { LoopbackRoute, Resolver } from "../../../src/connectors/http/transport.js";
import { withConnectorMetrics } from "../../../src/observability/catalog/connectors.js";
import { DEFAULT_METRIC_CATALOGUE, InMemoryMetrics } from "../../../src/observability/metrics.js";
import { EgressGuard } from "../../../src/privacy/egress.js";
import type { EgressDestination, EgressPolicyConfig } from "../../../src/privacy/egress.js";
import type { Classification } from "../../../src/protocol/common.js";
import { systemClock } from "../../../src/shared/clock.js";
import type { Clock } from "../../../src/shared/clock.js";
import { createModelPorts } from "../../../src/models/adapters/factory.js";
import type { ModelEndpointConfig, ModelEndpointConfigInput } from "../../../src/models/port/config.js";
import { ModelEndpointConfig as EndpointSchema } from "../../../src/models/port/config.js";
import type { ModelCredential } from "../../../src/models/port/credentials.js";
import { withModelMetrics } from "../../../src/models/port/metrics.js";
import type { ModelPort, ModelProvider, ModelRequestInput } from "../../../src/models/port/types.js";
import { ModelEmulator } from "./server.js";

export const unique = (): string => randomBytes(5).toString("hex");

/** A synthetic bearer key in the allowlisted fixture-credential shape. */
export const syntheticKey = (): string => `key_synth${randomBytes(8).toString("hex")}`;
export const syntheticAws = () => ({ accessKeyId: `akid_synth${randomBytes(6).toString("hex")}`, secretAccessKey: `sk_synth${randomBytes(16).toString("hex")}` });

export function hostFor(provider: ModelProvider): string {
  const label = provider === "openai_responses" ? "openai" : provider === "bedrock_converse" ? "bedrock" : "vllm";
  return `t${unique()}.${label}.models.test`;
}

export const REGION = "us-east-1";
export const RETENTION = "retention.emulator_none";

/** A local/ci endpoint configuration pointed at an emulator host (synthetic values; overridable). */
export function endpointConfig(provider: ModelProvider, host: string, over: Partial<ModelEndpointConfigInput> = {}): ModelEndpointConfig {
  return EndpointSchema.parse({
    endpointRef: `ep.${provider === "openai_responses" ? "openai" : provider === "bedrock_converse" ? "bedrock" : "vllm"}.${unique()}`,
    provider,
    baseUrl: `https://${host}`,
    region: REGION,
    retentionPolicyRef: RETENTION,
    network: "PUBLIC_INTERNET",
    model: { id: "emulated-text", revision: "emulated.1" },
    credentialRef: provider === "bedrock_converse" ? "aws:task-role" : "local-fixture:models/synth",
    maxDataClass: "INTERNAL",
    budget: { deadlineMs: 5_000, attemptTimeoutMs: 4_000, firstEventTimeoutMs: 2_000, idleTimeoutMs: 2_000, maxOutputTokens: 256, maxInputBytes: 65_536 },
    retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    breaker: { windowMs: 60_000, minimumRequests: 20, failureRateThreshold: 0.5, cooldownMs: 30_000, halfOpenMaxProbes: 1, halfOpenSuccessesToClose: 1 },
    bulkhead: { maxConcurrent: 8, maxQueue: 8, queueTimeoutMs: 2_000 },
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
 * `allowPhi`, the destinations also accept PHI under SYNTHETIC coverage references (the destination may then allow
 * more than an endpoint's own `maxDataClass`).
 */
export function egressPolicyFor(endpoints: readonly ModelEndpointConfig[], extraHosts: Readonly<Record<string, string[]>> = {}, o: { allowPhi?: boolean; classes?: readonly Classification[] } = {}): EgressPolicyConfig {
  const classes: Classification[] = o.classes ? [...o.classes] : o.allowPhi ? ["PUBLIC", "INTERNAL", "PHI"] : ["PUBLIC", "INTERNAL"];
  const restricted = classes.some((c) => c !== "PUBLIC" && c !== "INTERNAL");
  const destinations: EgressDestination[] = endpoints.map((e, i) => ({
    destinationId: `egr_model_${i}_${unique()}`,
    kind: e.provider === "vllm_openai_compatible" ? "MODEL_SELF_HOSTED" : "MODEL_PROVIDER_API",
    hosts: [new URL(e.baseUrl).hostname, ...(extraHosts[e.endpointRef] ?? [])],
    allowedClasses: classes,
    coverage: restricted ? { baaRef: "SYNTH-BAA-REF", approvalId: "apr_synthModelPhiEgress01" } : { baaRef: null, approvalId: null },
    environments: ["local", "ci"],
    adapterKind: "local_fixture",
    model: { provider: e.provider, region: e.region, retentionPolicyRef: e.retentionPolicyRef },
  }));
  return { policyVersion: `models-test.${unique()}`, destinations };
}

export function testMetrics(): InMemoryMetrics {
  return new InMemoryMetrics({ catalogue: withModelMetrics(withConnectorMetrics(DEFAULT_METRIC_CATALOGUE)) });
}

export interface Rig {
  emulator: ModelEmulator;
  port: ModelPort;
  endpoint: ModelEndpointConfig;
  host: string;
  metrics: InMemoryMetrics;
  /** DNS lookups the transport made (a loopback route never resolves; a real host would). */
  lookups: string[];
}

export interface RigOptions {
  endpoint?: Partial<ModelEndpointConfigInput>;
  clock?: Clock;
  /** Override the credential handed to the adapter (null: none). */
  credential?: ModelCredential | null;
  /** Register the host with the emulator (default true). */
  register?: boolean;
  emulator?: ModelEmulator;
  /** The endpoint's egress destination also accepts PHI (synthetic coverage). */
  egressAllowsPhi?: boolean;
  /** The exact classes the endpoint's egress destination approves (synthetic coverage for restricted ones). */
  egressClasses?: readonly Classification[];
}

/** Starts (or reuses) an in-process emulator and composes one production port for `provider` over it. */
export async function rig(provider: ModelProvider, o: RigOptions = {}): Promise<Rig> {
  const emulator = o.emulator ?? (await new ModelEmulator({ httpPort: 0, frameDelayMs: 1 }).start());
  const host = hostFor(provider);
  const endpoint = endpointConfig(provider, host, o.endpoint ?? {});
  const key = syntheticKey();
  const aws = syntheticAws();
  if (o.register !== false) emulator.registerHost(host, { bearer: [key], aws: [aws], region: REGION, models: ["emulated-text", "emulated-tools"] });
  const credential: ModelCredential | null =
    o.credential !== undefined ? o.credential : provider === "bedrock_converse" ? { kind: "aws", credentials: async () => aws } : { kind: "bearer", token: async () => key };
  const metrics = testMetrics();
  const lookups: string[] = [];
  const resolve: Resolver = async (h) => {
    lookups.push(h);
    throw new Error("no DNS in unit tests");
  };
  const policy = egressPolicyFor([endpoint], {}, { allowPhi: o.egressAllowsPhi === true, ...(o.egressClasses ? { classes: o.egressClasses } : {}) });
  const routes = new Map<string, LoopbackRoute>([[host, { port: emulator.httpPort, tls: false }]]);
  const { ports } = createModelPorts([endpoint], {
    environment: "local",
    egress: new EgressGuard(policy, { environment: "local", metrics }),
    egressPolicy: policy,
    clock: o.clock ?? systemClock,
    credentials: () => credential,
    metrics,
    loopbackRoutes: routes,
    resolve,
  });
  const port = ports.get(endpoint.endpointRef);
  if (!port) throw new Error("port not composed");
  return { emulator, port, endpoint, host, metrics, lookups };
}

/** A minimal synthetic request. */
export function request(over: Partial<ModelRequestInput> = {}): ModelRequestInput {
  return {
    invocationId: `minv_synth${unique()}${unique()}`,
    role: "router",
    instructions: "Synthetic instructions for the emulator.",
    messages: [{ role: "user", content: "Synthetic caller turn." }],
    dataClass: "INTERNAL",
    budget: { deadlineMs: 5_000, attemptTimeoutMs: 4_000, firstEventTimeoutMs: 2_000, idleTimeoutMs: 2_000, maxOutputTokens: 256, maxInputBytes: 65_536 },
    ...over,
  };
}

export const LOOKUP_TOOL = {
  name: "lookup_status",
  description: "Looks up the status of a synthetic support reference.",
  parameters: { type: "object", properties: { reference: { type: "string" } }, required: ["reference"], additionalProperties: false },
};
