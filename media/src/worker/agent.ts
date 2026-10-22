/**
 * The LiveKit Agents job entry of the conversation runtime (WP-11; FO-10-01). The Agents server forks a job
 * process per dispatched room job and imports this module there; `entry` connects to the room (audio only), runs
 * one MediaCall and ends the job when the call ends.
 */
import { AutoSubscribe, defineAgent } from "@livekit/agents";
import type { JobContext } from "@livekit/agents";
import { MediaCall } from "./call.js";
import { loadMediaWorkerConfig } from "./config.js";
import { LiveKitRoomPort } from "./livekit-room.js";
import { buildMediaRuntime } from "./runtime.js";
import type { MediaRuntime } from "./runtime.js";

let runtime: MediaRuntime | null = null;

function processRuntime(): MediaRuntime {
  if (!runtime) {
    const { config, secrets, tlsCa } = loadMediaWorkerConfig(process.env);
    const rt = buildMediaRuntime(config, secrets, tlsCa);
    runtime = rt;
    // The framework does not report a job process that exits: say so, content-free, so a job lost mid-call (a hang-up
    // never reported) can be told apart from a runtime that missed the event (a native crash leaves no line at all).
    process.once("exit", (code) => rt.logger.warn("media.job.exit", { reasonCode: `EXIT_${code}` }));
  }
  return runtime;
}

export async function runJob(ctx: JobContext): Promise<void> {
  const rt = processRuntime();
  await ctx.connect(undefined, AutoSubscribe.AUDIO_ONLY);
  const agentIdentity = ctx.room.localParticipant?.identity ?? "";
  const call = new MediaCall(
    { room: new LiveKitRoomPort(ctx.room, rt.callConfig.sampleRate), gateway: rt.gateway, recorder: rt.recorder, egressObserver: rt.egressObserver, logger: rt.logger },
    { jobRef: ctx.job.id, agentIdentity, expectedCaller: ctx.job.participant?.identity ?? null, metadata: ctx.job.metadata || undefined },
    rt.callConfig,
  );
  ctx.addShutdownCallback(async () => call.stop("JOB_SHUTDOWN"));
  await call.start();
  const outcome = await call.done;
  ctx.shutdown(outcome.reasonCode);
}

export default defineAgent({ entry: runJob });
