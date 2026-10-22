/**
 * The media worker process (WP-11; FO-10-01): an Agents server that registers with livekit-server as an Agents
 * worker under an explicit agent name and runs each dispatched room job in a forked job process (agent.ts).
 * The composition entry point (media/src/main.ts, composition group) only loads the configuration and calls
 * `startMediaWorker`; its HTTP health endpoint binds the configured host (127.0.0.1 by default).
 */
import { AgentServer, ServerOptions, WorkerPermissions } from "@livekit/agents";
import { ensureFrameworkLogger } from "./framework-log.js";
import type { MediaWorkerConfig, MediaWorkerSecrets } from "./config.js";

export function agentEntryFile(): string {
  // Running from sources (tsx) the job process imports agent.ts; from the build it imports agent.js.
  const ext = import.meta.url.endsWith(".ts") ? "ts" : "js";
  return new URL(`./agent.${ext}`, import.meta.url).pathname;
}

export function createMediaAgentServer(config: MediaWorkerConfig, secrets: MediaWorkerSecrets): AgentServer {
  // The framework's info records can carry room names and SIP attributes (a caller number): warn and above only.
  ensureFrameworkLogger("warn");
  return new AgentServer(
    new ServerOptions({
      agent: agentEntryFile(),
      agentName: config.agentName,
      wsURL: config.livekit.wsUrl,
      apiKey: secrets.livekitApiKey,
      apiSecret: secrets.livekitApiSecret,
      host: config.health.host,
      port: config.health.port,
      numIdleProcesses: config.idleProcesses,
      // Capacity is call slots, not host CPU: livekit-server stops offering jobs to a worker whose reported load is
      // high, and the framework's default (host-wide CPU share) made a worker on a busy shared host refuse every call
      // after its first (observed locally). Full when every slot holds a call.
      loadFunc: async (s) => Math.min(1, s.activeJobs.length / config.maxConcurrentCalls),
      loadThreshold: 1,
      logLevel: "warn",
      production: config.environment === "staging" || config.environment === "production",
      // Publish (the output track), subscribe (the caller's audio), attributes (the processing readout), hidden: no.
      permissions: new WorkerPermissions(true, true, true, true, [], false),
    }),
  );
}

/** Registers the worker and runs until `run()` returns (the server closed) or throws (registration failed). */
export async function startMediaWorker(config: MediaWorkerConfig, secrets: MediaWorkerSecrets): Promise<AgentServer> {
  const server = createMediaAgentServer(config, secrets);
  void server.run();
  return server;
}
