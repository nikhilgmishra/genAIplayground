/**
 * Test plumbing: runs the production media worker (createMediaAgentServer) as its own process for the Layer-2
 * media suite (platform/test/integration/media). Started with `node --import tsx` from media/, configured only
 * through VSP_MEDIA_CONFIG_FILE and the three secrets in the environment, exactly as a deployment would.
 * Prints one line "MEDIA_WORKER_READY <workerId>" once the Agents server is registered with livekit-server.
 */
import { loadMediaWorkerConfig } from "../../src/worker/config.js";
import { createMediaAgentServer } from "../../src/worker/server.js";

const { config, secrets } = loadMediaWorkerConfig(process.env);
const server = createMediaAgentServer(config, secrets);
let ready = false;
const timer = setInterval(() => {
  try {
    if (!ready && server.id && server.id !== "unregistered") {
      ready = true;
      process.stdout.write(`MEDIA_WORKER_READY ${server.id}\n`);
    }
  } catch {
    // not registered yet
  }
}, 100);
const stop = async () => {
  clearInterval(timer);
  await server.close().catch(() => undefined);
  process.exit(0);
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
server.run().catch((err: unknown) => {
  process.stderr.write(`MEDIA_WORKER_FAILED ${err instanceof Error ? err.name : "UNKNOWN"}\n`);
  process.exit(1);
});
