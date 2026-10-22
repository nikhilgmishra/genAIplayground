/**
 * Regenerates the committed recorded-response cassettes (WP-08; FO-19-09) from the protocol-exact emulator:
 *
 *   cd platform && npx tsx test/emulators/models/record-cassettes.ts
 *
 * Each cassette holds the exact wire bytes of one synthetic exchange per provider (OpenAI Responses SSE, Bedrock
 * ConverseStream event stream, vLLM Chat Completions SSE), recorded through the production adapters. The replay test
 * (src/models/emulators/recorded.test.ts) runs the same requests against the cassettes with no network.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RecordingModelExchange } from "../../../src/models/emulators/recorded.js";
import { ModelEmulator } from "./server.js";
import { CASSETTE_REQUESTS, cassetteRig } from "./cassettes.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "recordings");
mkdirSync(out, { recursive: true });
const emulator = await new ModelEmulator({ httpPort: 0, frameDelayMs: 0 }).start();
try {
  for (const provider of ["openai_responses", "bedrock_converse", "vllm_openai_compatible"] as const) {
    const live = cassetteRig(provider, { emulator });
    const recorder = new RecordingModelExchange(live.exchange, { environment: "local" });
    const port = cassetteRig(provider, { exchange: recorder }).port;
    for (const req of CASSETTE_REQUESTS) {
      const r = await port.invoke(req);
      if (r.outcome !== "COMPLETED") throw new Error(`recording failed: ${provider} ${r.outcome}`);
    }
    writeFileSync(join(out, `${provider}.json`), `${JSON.stringify(recorder.cassette(provider, "emulator", new Date().toISOString().slice(0, 10)), null, 2)}\n`);
  }
} finally {
  await emulator.stop();
}
