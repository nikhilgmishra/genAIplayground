/**
 * Recorded-response provider (WP-08; FO-19-09, FO-09-36): the committed cassettes
 * (platform/test/emulators/models/recordings, recorded from the protocol emulator through the production adapters by
 * test/emulators/models/record-cassettes.ts) replay through the SAME adapters with no socket at all. A request the
 * cassette does not hold is refused, and recording refuses non-synthetic classes.
 */
import { readFileSync } from "node:fs";
import * as net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CASSETTE_REQUESTS, cassetteRig } from "../../../test/emulators/models/cassettes.js";
import { ModelEmulator } from "../../../test/emulators/models/server.js";
import { ModelCassette, RecordedModelExchange, RecordingModelExchange } from "./recorded.js";

const here = dirname(fileURLToPath(import.meta.url));
const cassette = (provider: string) => JSON.parse(readFileSync(join(here, "../../../test/emulators/models/recordings", `${provider}.json`), "utf8")) as unknown;

afterEach(() => vi.restoreAllMocks());

describe("recorded-response provider [FO-19-09][FO-09-36]", () => {
  for (const provider of ["openai_responses", "bedrock_converse", "vllm_openai_compatible"] as const) {
    it(`[FO-19-09][FO-09-36] ${provider}: the committed cassette replays a tool call and its tool-result turn through the production adapter with no socket`, async () => {
      const connect = vi.spyOn(net.Socket.prototype, "connect");
      const exchange = new RecordedModelExchange(cassette(provider), { environment: "ci" });
      const { port } = cassetteRig(provider, { exchange });
      const first = await port.invoke(CASSETTE_REQUESTS[0]!);
      expect(first).toMatchObject({ outcome: "COMPLETED", toolCalls: [{ name: "lookup_status", arguments: { reference: "synthetic" } }] });
      const second = await port.invoke(CASSETTE_REQUESTS[1]!);
      expect(second).toMatchObject({ outcome: "COMPLETED", text: "The synthetic tool result was received.", toolCalls: [] });
      expect(exchange.replayed).toBe(2);
      expect(connect).not.toHaveBeenCalled();
    });
  }

  it("[FO-19-09] adversarial: a request the cassette does not hold is refused (a changed request shape is detected, never answered)", async () => {
    const { port } = cassetteRig("openai_responses", { exchange: new RecordedModelExchange(cassette("openai_responses"), { environment: "ci" }) });
    const changed = { ...CASSETTE_REQUESTS[0]!, instructions: "Different synthetic instructions." };
    expect(await port.invoke(changed)).toMatchObject({ outcome: "UNAVAILABLE", reasonCode: "MODEL_RECORDING_MISSING" });
    expect(() => new RecordedModelExchange({ schemaVersion: "model-cassette.v1", provider: "openai_responses" }, { environment: "ci" })).toThrow();
  });

  it("[DATA-01] recording is synthetic-only, keeps no request header, and the recorded bytes replay identically", async () => {
    const em = await new ModelEmulator({ httpPort: 0, frameDelayMs: 0 }).start();
    try {
      const live = cassetteRig("openai_responses", { emulator: em });
      const recorder = new RecordingModelExchange(live.exchange, { environment: "local" });
      const { port } = cassetteRig("openai_responses", { exchange: recorder });
      expect((await port.invoke({ ...CASSETTE_REQUESTS[0]!, dataClass: "PHI" })).outcome).toBe("UNAVAILABLE");
      expect(recorder.interactions).toHaveLength(0);
      expect((await port.invoke(CASSETTE_REQUESTS[0]!)).outcome).toBe("COMPLETED");
      const c = recorder.cassette("openai_responses", "emulator", "2026-10-21");
      expect(ModelCassette.safeParse(c).success).toBe(true);
      const dump = JSON.stringify(c);
      expect(dump).not.toContain("key_synthCassette");
      expect(dump).not.toMatch(/authorization/i);
      const replay = await cassetteRig("openai_responses", { exchange: new RecordedModelExchange(c, { environment: "local" }) }).port.invoke(CASSETTE_REQUESTS[0]!);
      expect(replay.outcome).toBe("COMPLETED");
    } finally {
      await em.stop();
    }
  });

  it("[OPS-04] adversarial: neither the replaying nor the recording exchange can be built outside local and ci", () => {
    for (const environment of ["sandbox", "staging", "production"] as const) {
      expect(() => new RecordedModelExchange(cassette("openai_responses"), { environment })).toThrow(expect.objectContaining({ violations: ["MODEL_RECORDING_OUTSIDE_LOCAL"] }));
      expect(() => new RecordingModelExchange({ incremental: false, send: async () => { throw new Error("never"); } }, { environment })).toThrow(expect.objectContaining({ violations: ["MODEL_RECORDING_OUTSIDE_LOCAL"] }));
    }
  });
});
