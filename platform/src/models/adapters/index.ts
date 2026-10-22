/**
 * Provider adapters (WP-08): OpenAI Responses, Amazon Bedrock ConverseStream, vLLM OpenAI-compatible Chat
 * Completions, all over the egress-classified transport; the composition factory, catalogue discovery and the
 * real-model local profile. See ../README.md.
 */
export { OpenAiResponsesAdapter, openAiHttpFailure, openAiResponsesBody } from "./openai-responses.js";
export type { OpenAiResponsesSettings } from "./openai-responses.js";
export { BedrockConverseAdapter, TransportRequestHandler, bedrockConverseInput, bedrockFailure, bedrockMessages } from "./bedrock-converse.js";
export type { BedrockConverseSettings } from "./bedrock-converse.js";
export { TOOL_PARSER_MARKERS, VllmChatAdapter, vllmChatBody, vllmHttpFailure } from "./vllm-chat.js";
export type { VllmChatSettings } from "./vllm-chat.js";
export { MODEL_DEPENDENCY, StreamingTransportModelExchange, TransportModelExchange, hasStreaming, modelExchangeFor, readBody, retryAfterFrom, transportFailureToModelError, watched } from "./http-exchange.js";
export type { ModelHttpExchange, ModelHttpRequest, ModelHttpResponse, ModelStreamingTransport, ModelTransport } from "./http-exchange.js";
export { SseLimitError, SseParser } from "./sse.js";
export type { SseEvent } from "./sse.js";
export { MODEL_MAX_RESPONSE_BYTES, createModelAdapter, createModelPorts, createModelTransport, createResilientPort, invocationEgressCheck, modelEgressTargets } from "./factory.js";
export type { ModelEgressTargetSpec, ModelPortDeps, ModelPorts } from "./factory.js";
export { CATALOGUE_SNAPSHOT_SCHEMA_VERSION, bedrockControlPlaneUrl, discoverCatalogue, snapshotFileName } from "./discovery.js";
export type { CatalogueModel, CatalogueSnapshot, DiscoveryDeps } from "./discovery.js";
export { REAL_MODEL_PROFILE_SCHEMA_VERSION, REAL_MODEL_TASK, RealModelCredentialSource, RealModelProfile, evaluateRealModelProfile, processEnv, profileExchange, realModelDestination, runRealModelProfile } from "./real-model-profile.js";
export type { RealModelDestination, RealModelProfileEnv, RealModelProfileStatus, RealModelRun, RealModelRunDeps } from "./real-model-profile.js";
export { amzDate, canonicalQuery, canonicalRequest, canonicalUri, signRequest, signingKey, stringToSign, uriEncode } from "./sigv4.js";
