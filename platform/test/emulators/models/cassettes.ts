/**
 * Deterministic configuration of the recorded-response cassettes (WP-08; FO-19-09): fixed synthetic hosts, endpoint
 * configurations, credentials and requests, so the request bodies (and therefore the cassette keys) are identical
 * between recording (record-cassettes.ts) and replay (src/models/emulators/recorded.test.ts).
 */
import { ConnectorHttpTransport } from "../../../src/connectors/http/transport.js";
import { EgressGuard } from "../../../src/privacy/egress.js";
import { systemClock } from "../../../src/shared/clock.js";
import { createModelAdapter, createResilientPort } from "../../../src/models/adapters/factory.js";
import { TransportModelExchange } from "../../../src/models/adapters/http-exchange.js";
import type { ModelHttpExchange } from "../../../src/models/adapters/http-exchange.js";
import { egressBindingFor } from "../../../src/models/port/config.js";
import type { ModelCredential } from "../../../src/models/port/credentials.js";
import type { ModelPort, ModelProvider, ModelRequestInput } from "../../../src/models/port/types.js";
import { endpointConfig, egressPolicyFor, LOOKUP_TOOL } from "./harness.js";
import type { ModelEmulator } from "./server.js";

export const CASSETTE_HOSTS: Readonly<Record<ModelProvider, string>> = {
  openai_responses: "cassette.openai.models.test",
  bedrock_converse: "cassette.bedrock.models.test",
  vllm_openai_compatible: "cassette.vllm.models.test",
};

const BEARER = "key_synthCassette";
const AWS = { accessKeyId: "akid_synthCassette", secretAccessKey: "sk_synthCassetteSecret" };

const budget = { deadlineMs: 5_000, attemptTimeoutMs: 4_000, firstEventTimeoutMs: 2_000, idleTimeoutMs: 2_000, maxOutputTokens: 128, maxInputBytes: 65_536 };

/** A tool call, then the tool result answered with text (one cassette holds both exchanges). */
export const CASSETTE_REQUESTS: readonly ModelRequestInput[] = [
  {
    invocationId: "minv_synthCassette0000001",
    role: "router",
    instructions: "Synthetic cassette instructions.",
    messages: [{ role: "user", content: "Synthetic cassette caller turn." }],
    tools: [LOOKUP_TOOL],
    dataClass: "INTERNAL",
    budget,
  },
  {
    invocationId: "minv_synthCassette0000002",
    role: "router",
    instructions: "Synthetic cassette instructions.",
    messages: [
      { role: "user", content: "Synthetic cassette caller turn." },
      { role: "assistant", content: "", toolCalls: [{ callId: "call_synthCassette", name: "lookup_status", arguments: { reference: "synthetic" } }] },
      { role: "tool", callId: "call_synthCassette", name: "lookup_status", content: "{\"status\":\"SYNTHETIC_OPEN\"}" },
    ],
    tools: [LOOKUP_TOOL],
    dataClass: "INTERNAL",
    budget,
  },
];

export function cassetteEndpoint(provider: ModelProvider) {
  return endpointConfig(provider, CASSETTE_HOSTS[provider], { endpointRef: `ep.cassette.${provider.split("_")[0]}`, model: { id: "emulated-tools", revision: "emulated.1" }, budget });
}

const credentialFor = (provider: ModelProvider): ModelCredential => (provider === "bedrock_converse" ? { kind: "aws", credentials: async () => AWS } : { kind: "bearer", token: async () => BEARER });

/**
 * The production port for a cassette endpoint over `exchange`, or (with `emulator`) over the egress-classified
 * transport to the in-process emulator, whose host is then registered with the cassette credentials.
 */
export function cassetteRig(provider: ModelProvider, o: { exchange?: ModelHttpExchange; emulator?: ModelEmulator }): { port: ModelPort; exchange: ModelHttpExchange } {
  const e = cassetteEndpoint(provider);
  let exchange = o.exchange;
  if (!exchange) {
    if (!o.emulator) throw new Error("exchange or emulator required");
    const host = CASSETTE_HOSTS[provider];
    o.emulator.registerHost(host, { bearer: [BEARER], aws: [AWS], region: e.region, models: ["emulated-tools"] });
    const policy = egressPolicyFor([e]);
    const transport = new ConnectorHttpTransport({ environment: "local", egress: new EgressGuard(policy, { environment: "local" }).forModelEndpoint(egressBindingFor(e)), loopbackRoutes: new Map([[host, { port: o.emulator.httpPort, tls: false }]]) });
    exchange = new TransportModelExchange(transport, { allowedHosts: [host], addressClass: "PUBLIC_INTERNET" });
  }
  return { port: createResilientPort(e, createModelAdapter(e, exchange, credentialFor(provider)), { clock: systemClock }), exchange };
}
