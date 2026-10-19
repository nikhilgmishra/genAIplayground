/**
 * The pinned media inference stack runs on this machine (WP-03 dependency set, ADR-0018 decision 1.1 and
 * open item 2). Two native packages have their install scripts ignored (`pnpm.ignoredBuiltDependencies`):
 * onnxruntime-node (its postinstall only downloads the optional CUDA provider) and @livekit/local-inference
 * (its install script is a no-op; the prebuilt binary comes from a platform package). These checks show
 * that both load and run inference on the CPU without those scripts: the Silero VAD model shipped with
 * @livekit/agents-plugin-silero runs through onnxruntime-node, and the on-device VAD and end-of-turn
 * models of @livekit/local-inference return probabilities. Synthetic audio only (silence and a tone);
 * what the models decide on real speech is WP-11's to qualify.
 */
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { REPO_ROOT } from "./env.js";
import { layer2 } from "./layer2.js";

const it = layer2.withoutServices("process-level check of the pinned native inference packages of the media worker; no emulator involved");

const MEDIA = join(REPO_ROOT, "media");
const fromMedia = createRequire(join(MEDIA, "package.json"));
/** Directory of a package as pnpm links it for the media workspace package. */
const packageDir = (name: string, base = join(MEDIA, "node_modules")) => realpathSync(join(base, ...name.split("/")));

interface OrtTensor {
  data: ArrayLike<number | bigint>;
}
interface Ort {
  InferenceSession: {
    create(path: string, opts: Record<string, unknown>): Promise<{ inputNames: readonly string[]; run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensor>> }>;
  };
  Tensor: new (type: string, data: ArrayLike<number> | BigInt64Array, dims?: number[]) => unknown;
}
interface LocalInference {
  predict(pcm: Int16Array): Promise<number>;
  createVad(): { predict(pcm: Int16Array): Promise<number>; reset(): void };
  VAD_WINDOW_SAMPLES: number;
}

const SAMPLE_RATE = 16_000;
const WINDOW = 512;
const CONTEXT = 64;

/** 16 kHz float samples: silence, or a 440 Hz tone at the given amplitude. */
function signal(samples: number, amplitude: number): Float32Array {
  const x = new Float32Array(samples);
  for (let i = 0; i < samples; i++) x[i] = amplitude * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE);
  return x;
}
const toInt16 = (x: Float32Array) => Int16Array.from(x, (v) => Math.round(v * 32767));

describe("pinned media inference packages", () => {
  it("[WP-03] onnxruntime-node runs the Silero VAD model shipped with @livekit/agents-plugin-silero on the CPU without its install script", async () => {
    const ort = fromMedia("onnxruntime-node") as Ort;
    const model = join(packageDir("@livekit/agents-plugin-silero"), "dist", "silero_vad.onnx");
    const session = await ort.InferenceSession.create(model, { executionProviders: ["cpu"], intraOpNumThreads: 1, interOpNumThreads: 1 });
    expect([...session.inputNames].sort()).toEqual(["input", "sr", "state"]);
    // The same windowing as the plugin's OnnxModel: 64 samples of context plus a 512-sample window at 16 kHz.
    const run = async (audio: Float32Array): Promise<number[]> => {
      let state = new Float32Array(2 * 128);
      let context = new Float32Array(CONTEXT);
      const probabilities: number[] = [];
      for (let off = 0; off + WINDOW <= audio.length; off += WINDOW) {
        const input = new Float32Array(CONTEXT + WINDOW);
        input.set(context, 0);
        input.set(audio.subarray(off, off + WINDOW), CONTEXT);
        const out = await session.run({
          input: new ort.Tensor("float32", input, [1, CONTEXT + WINDOW]),
          state: new ort.Tensor("float32", state, [2, 1, 128]),
          sr: new ort.Tensor("int64", BigInt64Array.from([BigInt(SAMPLE_RATE)])),
        });
        state = Float32Array.from(out.stateN?.data as ArrayLike<number>);
        context = input.slice(-CONTEXT);
        probabilities.push(Number(out.output?.data[0]));
      }
      return probabilities;
    };
    const silence = await run(signal(SAMPLE_RATE, 0));
    expect(silence).toHaveLength(Math.floor(SAMPLE_RATE / WINDOW));
    for (const p of silence) {
      expect(Number.isFinite(p)).toBe(true);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThan(0.5);
    }
    const tone = await run(signal(SAMPLE_RATE, 0.5));
    for (const p of tone) expect(p >= 0 && p <= 1).toBe(true);
  });

  it("[WP-03] @livekit/local-inference (pulled in by @livekit/agents) loads its prebuilt binary and returns VAD and end-of-turn probabilities", async () => {
    const agentsDir = packageDir("@livekit/agents");
    const fromAgents = createRequire(join(agentsDir, "package.json"));
    const local = fromAgents("@livekit/local-inference") as LocalInference;
    expect(local.VAD_WINDOW_SAMPLES).toBe(WINDOW);
    const vad = local.createVad();
    const window = await vad.predict(new Int16Array(WINDOW));
    expect(window >= 0 && window <= 1).toBe(true);
    expect(window).toBeLessThan(0.5);
    vad.reset();
    const eot = await local.predict(toInt16(signal(SAMPLE_RATE, 0.3)));
    expect(Number.isFinite(eot) && eot >= 0 && eot <= 1).toBe(true);
  });
});
