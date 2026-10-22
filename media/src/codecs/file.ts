/**
 * Decoding of recorded audio files (Ogg Opus, WAV, raw G.711 containers) to PCM through the pinned Agents
 * framework's decoder (@livekit/agents audioFramesFromFile, which runs the framework's bundled FFmpeg with libopus).
 * Used for evidence and qualification audio, never on the live call path (the RTC stack decodes Opus there).
 */
import { audioFramesFromFile } from "@livekit/agents";
import { ensureFrameworkLogger } from "../worker/framework-log.js";
import { concat } from "./pcm.js";
import type { SampleRate } from "./pcm.js";

export async function decodeAudioFile(path: string, sampleRate: SampleRate, format?: string): Promise<Int16Array> {
  ensureFrameworkLogger();
  const parts: Int16Array[] = [];
  const stream = audioFramesFromFile(path, { sampleRate, numChannels: 1, ...(format ? { format } : {}) });
  for await (const frame of stream) parts.push(frame.data.slice());
  return concat(parts);
}
