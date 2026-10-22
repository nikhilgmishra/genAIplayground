/**
 * Typed configuration and guard rule set of the model endpoints (WP-08), for the composition owner (WP-17 in phase
 * C) to load with the platform configuration and to call from a config guard rule file. This module only validates;
 * it never resolves a credential (credentials reach the adapters as opaque handles from the composition root,
 * docs/ARCHITECTURE.md section 6.4 rule 1) and never names a model: model ids are configuration data that the model
 * registry (WP-09) pins.
 *
 * `modelEndpointGuardViolations` returns:
 *  - `violations`: blocking `<CODE>@<path>` codes (the environment refuses to start): an emulator outside local/ci
 *    (OPS-04), a non-https or credential-bearing URL, a self-hosted endpoint on the public internet outside local/ci,
 *    a Bedrock endpoint whose host names another region, a vLLM tool parser vLLM does not ship, a verification-secret
 *    data-class ceiling (AUTH-06), duplicates;
 *  - `status`: per endpoint, CONFIGURED or NOT_CONFIGURED with the reasons (no credential reference, no egress
 *    allowlist entry approved for the endpoint's provider, region and retention terms). A NOT_CONFIGURED endpoint
 *    is never composed, so it makes no network call (FO-16-24).
 */
import { z } from "zod";
import { Classification, Environment, VersionLabel } from "../../protocol/common.js";
import { EgressGuard, ModelEndpointRegion } from "../../privacy/egress.js";
import type { EgressPolicyConfig, ModelEgressBinding } from "../../privacy/egress.js";
import { RefusalPhrases } from "./refusal.js";
import { ModelCallBudget, ModelProvider, ProviderModelId } from "./types.js";

/** vLLM tool-call parsers (vLLM `--tool-call-parser`); the registry pins one per model family (WP-09). */
export const VllmToolParser = z.enum([
  "hermes",
  "mistral",
  "llama3_json",
  "llama4_pythonic",
  "pythonic",
  "granite",
  "granite-20b-fc",
  "internlm",
  "jamba",
  "xlam",
  "phi4_mini_json",
  "deepseek_v3",
  "kimi_k2",
  "qwen3_coder",
  "openai",
]);
export type VllmToolParser = z.infer<typeof VllmToolParser>;

/**
 * Credential reference, in the grammar of the platform's secret resolvers (platform/src/connectors/secrets): a Secrets
 * Manager secret ARN (resolved by SecretsManagerSecretResolver), a `local-fixture:` reference (local and ci only, the
 * fixture resolver), or the task role for Bedrock (`aws:task-role`).
 */
export const ModelCredentialRef = z
  .string()
  .regex(/^(arn:aws:secretsmanager:[A-Za-z0-9-]{1,32}:[A-Za-z0-9]{1,32}:secret:[A-Za-z0-9/_+=.@-]{1,256}|local-fixture:[a-z0-9][a-z0-9._/-]{0,127}|aws:task-role)$/);

export const ModelEndpointConfig = z.strictObject({
  endpointRef: z.string().regex(/^[a-z][a-z0-9_.-]{2,63}$/),
  provider: ModelProvider,
  /** https base URL: the provider API root, a VPC endpoint DNS name or the private vLLM service. */
  baseUrl: z.string().url().max(512),
  region: ModelEndpointRegion,
  retentionPolicyRef: z.string().regex(/^[a-z][a-z0-9_.-]{2,63}$/),
  network: z.enum(["PUBLIC_INTERNET", "PRIVATE_NETWORK"]),
  /** Exact provider model id / served model name and revision (configuration data from the registry entry). */
  model: z.strictObject({ id: ProviderModelId, revision: VersionLabel }),
  /** Null: no reviewed credential yet; the endpoint is NOT_CONFIGURED and is never composed. */
  credentialRef: ModelCredentialRef.nullable(),
  /**
   * Most sensitive class this endpoint may receive. Enforced on EVERY request before any I/O by the
   * ResilientModelPort (UNAVAILABLE MODEL_DATA_CLASS_EXCEEDS_ENDPOINT, no provider request), independently of the
   * egress destination's approved classes (one destination host can serve endpoints with different data controls,
   * for example a zero-retention project key and an ordinary one); also checked against the destination at startup.
   */
  maxDataClass: Classification,
  budget: ModelCallBudget,
  retry: z.strictObject({ maxAttempts: z.number().int().min(1).max(3), baseDelayMs: z.number().int().min(0).max(30_000), maxDelayMs: z.number().int().min(0).max(30_000) }),
  breaker: z.strictObject({
    windowMs: z.number().int().min(1_000).max(600_000),
    minimumRequests: z.number().int().min(1).max(1_000),
    failureRateThreshold: z.number().gt(0).max(1),
    cooldownMs: z.number().int().min(100).max(600_000),
    halfOpenMaxProbes: z.number().int().min(1).max(16),
    halfOpenSuccessesToClose: z.number().int().min(1).max(16),
  }),
  bulkhead: z.strictObject({ maxConcurrent: z.number().int().min(1).max(4_096), maxQueue: z.number().int().min(0).max(16_384), queueTimeoutMs: z.number().int().min(1).max(60_000) }),
  openai: z.strictObject({ organization: z.string().regex(/^org-[A-Za-z0-9]{1,64}$/).nullable(), project: z.string().regex(/^proj_[A-Za-z0-9]{1,64}$/).nullable(), strictToolSchemas: z.boolean() }).nullable().default(null),
  bedrock: z.strictObject({ guardrail: z.strictObject({ identifier: z.string().regex(/^[a-z0-9]{1,64}$|^arn:aws[a-z-]*:bedrock:[a-z0-9-]+:\d{12}:guardrail\/[a-z0-9]{1,64}$/), version: z.string().regex(/^(DRAFT|[1-9][0-9]{0,7})$/) }).nullable() }).nullable().default(null),
  vllm: z.strictObject({ toolParser: VllmToolParser, structuredOutput: z.enum(["json_schema", "none"]) }).nullable().default(null),
  /**
   * Extra refusal phrases of this endpoint for the port's refusal classifier (refusal.ts): for example the blocked
   * output message of the tenant's Bedrock guardrail, or a self-hosted model's documented refusal template.
   */
  refusalPhrases: RefusalPhrases.default([]),
  environments: z.array(Environment).min(1).max(5),
  /** `emulator`: a local/ci protocol emulator (refused elsewhere, OPS-04); `live`: a provider or self-hosted server. */
  adapterKind: z.enum(["live", "emulator"]),
});
export type ModelEndpointConfig = z.infer<typeof ModelEndpointConfig>;
export type ModelEndpointConfigInput = z.input<typeof ModelEndpointConfig>;

export const ModelEndpointsConfig = z.array(ModelEndpointConfig).max(32);

export interface ModelEndpointStatus {
  endpointRef: string;
  provider: ModelProvider;
  status: "CONFIGURED" | "NOT_CONFIGURED";
  reasons: string[];
}

export interface ModelGuardReport {
  violations: string[];
  status: ModelEndpointStatus[];
}

const OFFLINE: readonly Environment[] = ["local", "ci"];

/** The egress binding an endpoint's adapter is constructed with. */
export function egressBindingFor(e: Pick<ModelEndpointConfig, "provider" | "region" | "retentionPolicyRef">): ModelEgressBinding {
  return { provider: e.provider, region: e.region, retentionPolicyRef: e.retentionPolicyRef };
}

/** The request URL path of each provider protocol under the endpoint's base URL. */
export function invokeUrlFor(e: Pick<ModelEndpointConfig, "provider" | "baseUrl" | "model">): URL {
  const base = e.baseUrl.replace(/\/+$/, "");
  switch (e.provider) {
    case "openai_responses":
      return new URL(`${base}/v1/responses`);
    case "vllm_openai_compatible":
      return new URL(`${base}/v1/chat/completions`);
    case "bedrock_converse":
      return new URL(`${base}/model/${encodeURIComponent(e.model.id)}/converse-stream`);
  }
}

export function modelEndpointGuardViolations(input: unknown, opts: { environment: Environment; egress: EgressPolicyConfig | null }): ModelGuardReport {
  const violations: string[] = [];
  const status: ModelEndpointStatus[] = [];
  const parsed = ModelEndpointsConfig.safeParse(input);
  if (!parsed.success) return { violations: ["MODEL_ENDPOINTS_CONFIG_INVALID@models"], status };
  const offline = OFFLINE.includes(opts.environment);
  let guard: EgressGuard | null = null;
  if (opts.egress) {
    try {
      guard = new EgressGuard(opts.egress, { environment: opts.environment });
    } catch {
      violations.push("EGRESS_POLICY_REJECTED@egress");
    }
  }
  const seen = new Set<string>();
  parsed.data.forEach((e, i) => {
    const at = (code: string, path = "") => `${code}@models.${i}${path}`;
    const reasons: string[] = [];
    if (seen.has(e.endpointRef)) violations.push(at("MODEL_ENDPOINT_DUPLICATE", ".endpointRef"));
    seen.add(e.endpointRef);
    if (!e.environments.includes(opts.environment)) {
      status.push({ endpointRef: e.endpointRef, provider: e.provider, status: "NOT_CONFIGURED", reasons: ["MODEL_ENDPOINT_NOT_FOR_ENVIRONMENT"] });
      return;
    }
    if (e.adapterKind === "emulator" && !offline) violations.push(at("MODEL_EMULATOR_OUTSIDE_LOCAL", ".adapterKind"));
    const url = new URL(e.baseUrl);
    if (url.protocol !== "https:") violations.push(at("MODEL_ENDPOINT_NOT_HTTPS", ".baseUrl"));
    if (url.username || url.password || url.search || url.hash) violations.push(at("MODEL_ENDPOINT_URL_NOT_PLAIN", ".baseUrl"));
    if (e.provider === "vllm_openai_compatible" && e.network !== "PRIVATE_NETWORK" && !offline) violations.push(at("MODEL_SELF_HOSTED_ON_PUBLIC_NETWORK", ".network"));
    if (e.provider === "vllm_openai_compatible" && e.vllm === null) violations.push(at("MODEL_VLLM_SETTINGS_MISSING", ".vllm"));
    if (e.provider !== "vllm_openai_compatible" && e.vllm !== null) violations.push(at("MODEL_VLLM_SETTINGS_ON_OTHER_PROVIDER", ".vllm"));
    if (e.provider !== "openai_responses" && e.openai !== null) violations.push(at("MODEL_OPENAI_SETTINGS_ON_OTHER_PROVIDER", ".openai"));
    if (e.provider !== "bedrock_converse" && e.bedrock !== null) violations.push(at("MODEL_BEDROCK_SETTINGS_ON_OTHER_PROVIDER", ".bedrock"));
    if (e.provider === "bedrock_converse") {
      const m = /^bedrock-runtime(?:-fips)?\.([a-z]{2}(?:-[a-z]+)+-\d)\.amazonaws\.com$/.exec(url.hostname);
      if (m && m[1] !== e.region) violations.push(at("MODEL_BEDROCK_REGION_MISMATCH", ".region"));
    }
    if (e.credentialRef === "aws:task-role" && e.provider !== "bedrock_converse") violations.push(at("MODEL_TASK_ROLE_ONLY_FOR_BEDROCK", ".credentialRef"));
    if (e.credentialRef?.startsWith("local-fixture:") && !offline) violations.push(at("MODEL_FIXTURE_CREDENTIAL_OUTSIDE_LOCAL", ".credentialRef"));
    if (e.region === "local" && !offline) violations.push(at("MODEL_LOCAL_REGION_OUTSIDE_LOCAL", ".region"));
    // Verification secrets never reach a model (AUTH-06): no endpoint may declare them as its ceiling.
    if (e.maxDataClass === "VERIFICATION_SECRET") violations.push(at("MODEL_MAX_DATA_CLASS_SECRET", ".maxDataClass"));
    if (e.budget.maxOutputTokens < 1) reasons.push("MODEL_BUDGET_INVALID");
    // Capability status: an endpoint without a reviewed credential or an approved egress entry is never composed.
    if (e.credentialRef === null && e.adapterKind === "live") reasons.push("MODEL_CREDENTIAL_NOT_CONFIGURED");
    if (!guard) reasons.push("EGRESS_POLICY_NOT_CONFIGURED");
    else {
      const decision = guard.checkModelEndpoint(invokeUrlFor(e), e.maxDataClass, egressBindingFor(e));
      if (!decision.allowed) reasons.push(decision.reasonCode);
    }
    status.push({ endpointRef: e.endpointRef, provider: e.provider, status: reasons.length === 0 ? "CONFIGURED" : "NOT_CONFIGURED", reasons });
  });
  return { violations, status };
}
