/**
 * Incremental streaming path (WP-08; FO-09-45, FO-09-07, FO-09-06): with a transport that offers `stream()` (the
 * hand-off to the WP-06 transport owner), the factory selects StreamingTransportModelExchange, deltas reach the
 * consumer while the provider is still generating, and the first-event / idle watchdog ends a stalled stream before
 * the attempt timeout and closes the connection.
 *
 * UNIT FAKE: `FakeStreamingTransport` below is a test-only stand-in for the proposed `ConnectorHttpTransport.stream()`
 * (node:http to the in-process emulator, no egress checks); production code never uses it. The production transport
 * path is covered by the other adapter tests and the Layer-2 suite.
 */
import { request as httpRequest } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TransportRequest } from "../../connectors/http/transport.js";
import { TransportError } from "../../connectors/http/transport.js";
import { systemClock } from "../../shared/clock.js";
import { ModelEmulator } from "../../../test/emulators/models/server.js";
import { endpointConfig, hostFor, request, syntheticAws, syntheticKey } from "../../../test/emulators/models/harness.js";
import type { ModelStreamEvent } from "../port/types.js";
import { createModelAdapter, createResilientPort } from "./factory.js";
import { StreamingTransportModelExchange, hasStreaming, modelExchangeFor } from "./http-exchange.js";
import type { ModelStreamingTransport, ModelTransport } from "./http-exchange.js";

/** UNIT FAKE streaming transport (test only). */
class FakeStreamingTransport implements ModelStreamingTransport, ModelTransport {
  constructor(private readonly port: number) {}
  send(): never {
    throw new Error("buffered send not used here");
  }
  stream(req: TransportRequest): ReturnType<ModelStreamingTransport["stream"]> {
    return new Promise((resolve, reject) => {
      const headers = { ...req.headers, host: req.url.host, ...(req.body !== null ? { "content-length": String(Buffer.byteLength(req.body)) } : {}) };
      const r = httpRequest({ method: req.method, host: "127.0.0.1", port: this.port, path: `${req.url.pathname}${req.url.search}`, headers }, (res) => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) if (typeof v === "string") headers[k] = v;
        async function* body(): AsyncGenerator<Buffer> {
          try {
            for await (const c of res) yield c as Buffer;
          } catch {
            throw new TransportError(req.signal?.aborted ? "CALLER_ABORTED" : "CONNECTION_LOST", "FAILED", false, "RESPONSE", true);
          }
        }
        resolve({ status: res.statusCode ?? 0, headers, body: body(), cancel: () => r.destroy() });
      });
      req.signal?.addEventListener("abort", () => r.destroy(), { once: true });
      r.on("error", () => reject(new TransportError(req.signal?.aborted ? "CALLER_ABORTED" : "CONNECTION_REFUSED", "NOT_STARTED", false, "CONNECT", false)));
      if (req.body !== null) r.write(req.body);
      r.end();
    });
  }
}

let emulator: ModelEmulator;
beforeAll(async () => {
  // A slow emulator: 60 ms between frames, so a whole answer takes several hundred ms.
  emulator = await new ModelEmulator({ httpPort: 0, frameDelayMs: 60 }).start();
});
afterAll(async () => {
  await emulator.stop();
});

function streamingPort(provider: "openai_responses" | "bedrock_converse", budget = { deadlineMs: 5_000, attemptTimeoutMs: 4_000, firstEventTimeoutMs: 300, idleTimeoutMs: 300, maxOutputTokens: 64, maxInputBytes: 65_536 }) {
  const host = hostFor(provider);
  const e = endpointConfig(provider, host, { budget });
  const key = syntheticKey();
  const aws = syntheticAws();
  emulator.registerHost(host, { bearer: [key], aws: [aws], region: e.region, models: ["emulated-text"] });
  const transport = new FakeStreamingTransport(emulator.httpPort);
  const exchange = modelExchangeFor(transport, { allowedHosts: [host], addressClass: "PUBLIC_INTERNET" });
  const credential = provider === "bedrock_converse" ? ({ kind: "aws", credentials: async () => aws } as const) : ({ kind: "bearer", token: async () => key } as const);
  return { host, exchange, budget, port: createResilientPort(e, createModelAdapter(e, exchange, credential), { clock: systemClock }) };
}

describe("incremental model streaming [FO-09-45][FO-09-07][FO-09-06]", () => {
  it("[FO-09-45] a transport with stream() gets the incremental exchange; one without gets the buffered one", () => {
    const t = new FakeStreamingTransport(1);
    expect(hasStreaming(t)).toBe(true);
    expect(modelExchangeFor(t, { allowedHosts: ["x.models.test"], addressClass: "PUBLIC_INTERNET" })).toBeInstanceOf(StreamingTransportModelExchange);
    expect(modelExchangeFor({ send: async () => ({ status: 200, headers: {}, body: Buffer.alloc(0) }) }, { allowedHosts: ["x.models.test"], addressClass: "PUBLIC_INTERNET" }).incremental).toBe(false);
  });

  for (const provider of ["openai_responses", "bedrock_converse"] as const) {
    it(`[FO-09-45] ${provider}: the first delta reaches the consumer well before the stream ends`, async () => {
      const p = streamingPort(provider);
      const started = Date.now();
      let firstDeltaAt = 0;
      const events: ModelStreamEvent[] = [];
      const result = await p.port.invoke(request({ budget: p.budget }), {
        onEvent: (e) => {
          if (e.type === "text_delta" && firstDeltaAt === 0) firstDeltaAt = Date.now() - started;
          events.push(e);
        },
      });
      const total = Date.now() - started;
      expect(result.outcome).toBe("COMPLETED");
      expect(firstDeltaAt).toBeGreaterThan(0);
      // At least two more frames (60 ms each) arrived after the first delta.
      expect(total - firstDeltaAt).toBeGreaterThanOrEqual(100);
    });

    it(`[FO-09-45][FAULT:MODEL_HANG seam] ${provider}: the idle watchdog ends a stalled stream before the attempt timeout and closes the connection`, async () => {
      const p = streamingPort(provider);
      emulator.injectFault(p.host, "MODEL_HANG");
      const started = Date.now();
      const result = await p.port.invoke(request({ budget: p.budget }));
      expect(result).toMatchObject({ outcome: "TIMED_OUT", phase: "STREAM_IDLE" });
      expect(Date.now() - started).toBeLessThan(2_000);
      await expect.poll(() => emulator.requests(p.host)[0]?.clientClosedEarly, { timeout: 2_000 }).toBe(true);
    });
  }
});
