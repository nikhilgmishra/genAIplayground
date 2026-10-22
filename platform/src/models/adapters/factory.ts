/**
 * Model port factory for the composition owner (WP-08 -> WP-17 in phase C; docs/ARCHITECTURE.md 6.4 rule 1).
 *
 *   const report = modelEndpointGuardViolations(config.models, { environment, egress: config.egress });
 *   const { ports } = createModelPorts(config.models, { environment, egress: guard, clock, credentials, metrics, logger });
 *
 * - The configuration is validated first (port/config.ts); a blocking violation throws ConfigurationRejectedError.
 * - Only CONFIGURED endpoints are composed: an endpoint without a reviewed credential, or without an egress allowlist
 *   entry approved for its provider, region and retention terms, gets NO port, so it can make no network call
 *   (FO-16-24); its status is in `report.status`.
 * - Each port is ResilientModelPort(adapter) over its own egress-classified transport whose per-request check is
 *   `EgressGuard.forModelEndpoint(binding)`, with its own circuit breaker and bulkhead.
 * - Credentials arrive as opaque handles from the composition root (`credentials(endpoint)`); this factory never
 *   resolves a secret. Emulator routes (`loopbackRoutes`, `tlsCa`) exist in local/ci only (the transport refuses them
 *   elsewhere).
 */
import { ConnectorHttpTransport } from "../../connectors/http/transport.js";
import type { LoopbackRoute, Resolver } from "../../connectors/http/transport.js";
import type { Logger, Metrics } from "../../observability/ports.js";
import type { EgressGuard } from "../../privacy/egress.js";
import type { Environment } from "../../protocol/common.js";
import { Bulkhead } from "../../resilience/bulkhead.js";
import { CircuitBreaker } from "../../resilience/circuit-breaker.js";
import type { TimerPort } from "../../resilience/timeout.js";
import type { Clock } from "../../shared/clock.js";
import { ConfigurationRejectedError } from "../../shared/errors.js";
import type { ModelAdapter } from "../port/adapter.js";
import { ModelEndpointsConfig, egressBindingFor, invokeUrlFor, modelEndpointGuardViolations } from "../port/config.js";
import type { ModelEndpointConfig, ModelGuardReport } from "../port/config.js";
import type { ModelCredential } from "../port/credentials.js";
import { proseRefusalClassifier } from "../port/refusal.js";
import { ResilientModelPort } from "../port/resilient.js";
import type { ModelPort } from "../port/types.js";
import { BedrockConverseAdapter } from "./bedrock-converse.js";
import { modelExchangeFor } from "./http-exchange.js";
import type { ModelHttpExchange } from "./http-exchange.js";
import { OpenAiResponsesAdapter } from "./openai-responses.js";
import { VllmChatAdapter } from "./vllm-chat.js";

/** Largest model response the transport accepts (bounded; a stream beyond it is MALFORMED). */
export const MODEL_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export interface ModelPortDeps {
  environment: Environment;
  egress: EgressGuard;
  /** The egress policy the guard was built from (the guard report checks every endpoint against it). */
  egressPolicy: Parameters<typeof modelEndpointGuardViolations>[1]["egress"];
  clock: Clock;
  /** The resolved credential handle of an endpoint (null when the composition root has none). */
  credentials: (endpoint: ModelEndpointConfig) => ModelCredential | null;
  metrics?: Metrics;
  logger?: Logger;
  timers?: TimerPort;
  /** local/ci only: emulator routes and their CA. */
  loopbackRoutes?: ReadonlyMap<string, LoopbackRoute>;
  tlsCa?: readonly string[];
  resolve?: Resolver;
}

/** The egress-classified transport of one model endpoint (its per-request check is bound to the endpoint's terms). */
export function createModelTransport(e: ModelEndpointConfig, deps: Pick<ModelPortDeps, "environment" | "egress" | "metrics" | "logger" | "loopbackRoutes" | "tlsCa" | "resolve">): ConnectorHttpTransport {
  return new ConnectorHttpTransport({
    environment: deps.environment,
    egress: deps.egress.forModelEndpoint(egressBindingFor(e)),
    maxResponseBytes: MODEL_MAX_RESPONSE_BYTES,
    ...(deps.loopbackRoutes ? { loopbackRoutes: deps.loopbackRoutes } : {}),
    ...(deps.tlsCa ? { tlsCa: deps.tlsCa } : {}),
    ...(deps.resolve ? { resolve: deps.resolve } : {}),
    ...(deps.metrics ? { metrics: deps.metrics } : {}),
    ...(deps.logger ? { logger: deps.logger } : {}),
  });
}

/** The provider adapter of one endpoint over the given exchange (throws when the credential kind does not fit). */
export function createModelAdapter(e: ModelEndpointConfig, exchange: ModelHttpExchange, credential: ModelCredential | null): ModelAdapter {
  switch (e.provider) {
    case "openai_responses":
      if (credential?.kind !== "bearer") throw new ConfigurationRejectedError([`MODEL_CREDENTIAL_KIND_MISMATCH@models.${e.endpointRef}`]);
      return new OpenAiResponsesAdapter({
        url: invokeUrlFor(e),
        model: e.model.id,
        organization: e.openai?.organization ?? null,
        project: e.openai?.project ?? null,
        strictToolSchemas: e.openai?.strictToolSchemas ?? false,
        credential,
        exchange,
      });
    case "vllm_openai_compatible":
      if (credential !== null && credential.kind !== "bearer") throw new ConfigurationRejectedError([`MODEL_CREDENTIAL_KIND_MISMATCH@models.${e.endpointRef}`]);
      if (!e.vllm) throw new ConfigurationRejectedError([`MODEL_VLLM_SETTINGS_MISSING@models.${e.endpointRef}`]);
      return new VllmChatAdapter({ url: invokeUrlFor(e), servedModel: e.model.id, toolParser: e.vllm.toolParser, structuredOutput: e.vllm.structuredOutput, credential, exchange });
    case "bedrock_converse":
      if (credential?.kind !== "aws") throw new ConfigurationRejectedError([`MODEL_CREDENTIAL_KIND_MISMATCH@models.${e.endpointRef}`]);
      return new BedrockConverseAdapter({ region: e.region, endpoint: e.baseUrl.replace(/\/+$/, ""), modelId: e.model.id, guardrail: e.bedrock?.guardrail ?? null, credential, exchange });
  }
}

/**
 * One ResilientModelPort over the given adapter, with the endpoint's data-class ceiling, refusal phrases, breaker,
 * bulkhead and retry settings.
 */
export function createResilientPort(e: ModelEndpointConfig, adapter: ModelAdapter, deps: Pick<ModelPortDeps, "clock" | "metrics" | "logger" | "timers">): ResilientModelPort {
  const breaker = new CircuitBreaker({ dependency: "model-provider", clock: deps.clock, ...e.breaker, ...(deps.metrics ? { metrics: deps.metrics } : {}) });
  const bulkhead = new Bulkhead({ dependency: "model-provider", maxConcurrent: e.bulkhead.maxConcurrent, maxQueue: e.bulkhead.maxQueue, queueTimeoutMs: e.bulkhead.queueTimeoutMs, ...(deps.metrics ? { metrics: deps.metrics } : {}) });
  return new ResilientModelPort(adapter, {
    endpointRef: e.endpointRef,
    maxDataClass: e.maxDataClass,
    refusalClassifier: proseRefusalClassifier(e.refusalPhrases),
    budgetCeiling: e.budget,
    clock: deps.clock,
    retry: e.retry,
    breaker,
    bulkhead,
    ...(deps.metrics ? { metrics: deps.metrics } : {}),
    ...(deps.logger ? { logger: deps.logger } : {}),
    ...(deps.timers ? { timers: deps.timers } : {}),
  });
}

export interface ModelPorts {
  ports: Map<string, ModelPort>;
  report: ModelGuardReport;
}

/** Every CONFIGURED endpoint as a ModelPort; throws ConfigurationRejectedError on a blocking violation. */
export function createModelPorts(config: unknown, deps: ModelPortDeps): ModelPorts {
  const report = modelEndpointGuardViolations(config, { environment: deps.environment, egress: deps.egressPolicy });
  if (report.violations.length > 0) throw new ConfigurationRejectedError(report.violations);
  const endpoints = ModelEndpointsConfig.parse(config);
  const ports = new Map<string, ModelPort>();
  for (const e of endpoints) {
    const s = report.status.find((x) => x.endpointRef === e.endpointRef);
    if (s?.status !== "CONFIGURED") continue;
    const credential = deps.credentials(e);
    if (credential === null && e.provider !== "vllm_openai_compatible") {
      s.status = "NOT_CONFIGURED";
      s.reasons.push("MODEL_CREDENTIAL_NOT_RESOLVED");
      continue;
    }
    const url = invokeUrlFor(e);
    const exchange = modelExchangeFor(createModelTransport(e, deps), { allowedHosts: [url.hostname.toLowerCase()], addressClass: e.network });
    ports.set(e.endpointRef, createResilientPort(e, createModelAdapter(e, exchange, credential), deps));
  }
  return { ports, report };
}

/**
 * A model endpoint as a startup egress target: structurally `ModelEndpointTarget` of privacy/egress-startup.ts, which
 * the composition root passes to `egressTargetsFor(config, telemetry, models)` (this module may not import it).
 */
export interface ModelEgressTargetSpec {
  ref: string;
  url: string;
  dataClass: ModelEndpointConfig["maxDataClass"];
  binding: ReturnType<typeof egressBindingFor>;
}

/**
 * The per-request egress decision of one endpoint, for the invocation audit record (port/invocation.ts
 * `egressAllowed`): the same model egress check the endpoint's transport applies to every request.
 */
export function invocationEgressCheck(e: ModelEndpointConfig, egress: Pick<EgressGuard, "peekModelEndpoint">): (dataClass: ModelEndpointConfig["maxDataClass"]) => boolean {
  const url = invokeUrlFor(e);
  const binding = egressBindingFor(e);
  // A decision only (no denial is counted): the transport's own per-request check already counted any refusal.
  return (dataClass) => egress.peekModelEndpoint(url, dataClass, binding).allowed;
}

/** The live model endpoints of a configuration for the startup egress check. */
export function modelEgressTargets(config: unknown, environment: Environment): ModelEgressTargetSpec[] {
  const parsed = ModelEndpointsConfig.safeParse(config);
  if (!parsed.success) throw new ConfigurationRejectedError(["MODEL_ENDPOINTS_CONFIG_INVALID@models"]);
  return parsed.data
    .filter((e) => e.environments.includes(environment) && e.adapterKind === "live")
    .map((e) => ({ ref: e.endpointRef.replace(/[.-]/g, "_").slice(0, 41), url: invokeUrlFor(e).toString(), dataClass: e.maxDataClass, binding: egressBindingFor(e) }));
}
