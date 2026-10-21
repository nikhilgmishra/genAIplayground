/**
 * Live worker unit (WP-07; FO-16-11, FO-19-06; WP-04 and WP-06 hand-offs).
 *
 * Production entry point (modules.yaml `entryPoints`, transitive): the live container (unit "worker", database
 * role app_worker), the live loops (worker/live-loops.ts) and the connector change feeds of
 * PlatformConfig.connectors (ConnectorRuntime over the egress-classified transport, IncrementalReader with
 * durable checkpoints, the content-free feed index, the SQS dead-letter writer). Health on PORT (8081).
 */
import type { AddressInfo } from "node:net";
import { ConnectorFeedSync } from "../adapters/live/connector-feed.js";
import type { BuildBusiness } from "../business/contract.js";
import { loadInfrastructureEnv } from "../config/loader.js";
import { IncrementalReader, PgConnectorCheckpointStore } from "../connectors/runtime/checkpoints.js";
import { ConnectorRuntime } from "../connectors/runtime/connector.js";
import type { Logger } from "../observability/ports.js";
import { SqsDeadLetterWriter } from "../outbox/sqs-dlq.js";
import type { SqsQueueClient } from "../outbox/sqs-dlq.js";
import { ConfigurationRejectedError } from "../shared/errors.js";
import { TimerLoopScheduler } from "../worker/scheduler.js";
import type { LoopScheduler } from "../worker/scheduler.js";
import { liveWorkerLoopsFor } from "../worker/live-loops.js";
import type { LiveWorkerIntervals } from "../worker/live-loops.js";
import { Worker, buildWorkerHealthApp } from "../worker/runtime.js";
import { buildLiveContainer } from "./live-container.js";
import type { LiveContainer, LiveContainerOptions } from "./live-container.js";

export interface LiveWorkerRuntime {
  container: LiveContainer;
  worker: Worker;
  feeds: ConnectorFeedSync[];
  healthUrl: string;
  close(): Promise<void>;
}

/**
 * The connector change feeds of the configuration (none when connectors are NOT_CONFIGURED). The profiles are
 * the ones the container loaded before the guard (the credential separation rule saw exactly these).
 */
export function composeConnectorFeeds(c: LiveContainer): ConnectorFeedSync[] {
  const cfg = c.config.connectors;
  const feeds = cfg?.profileDirectory ? cfg.feeds : [];
  if (feeds.length === 0) return [];
  const profiles = c.connectorProfiles;
  const store = new PgConnectorCheckpointStore(c.clock);
  return feeds.map((f) => {
    const admitted = profiles.find((p) => p.profile.profileId === f.profileId && p.profile.tenantId === c.config.tenantId);
    if (!admitted) throw new ConfigurationRejectedError([`CONNECTOR_FEED_PROFILE_UNKNOWN@connectors.feeds.${f.streamId}`]);
    const runtime = new ConnectorRuntime({ admitted, transport: c.transport, secrets: c.secrets, clock: c.clock, metrics: c.metrics, logger: c.logger });
    let sync: ConnectorFeedSync | null = null;
    const reader = new IncrementalReader({
      runtime,
      db: c.db,
      store,
      tenantId: c.config.tenantId,
      streamId: f.streamId,
      operationId: f.operationId,
      apply: (tx, records) => (sync as ConnectorFeedSync).project(tx, records),
      ...(f.updatedAtField ? { watermarkField: f.updatedAtField } : {}),
    });
    sync = new ConnectorFeedSync({
      reader,
      digester: c.feedDigester,
      deadLetters: new SqsDeadLetterWriter(c.aws.sqs as unknown as SqsQueueClient, f.deadLetterQueueUrl),
      tenantId: c.config.tenantId,
      profileId: f.profileId,
      streamId: f.streamId,
      keyField: f.keyField,
      updatedAtField: f.updatedAtField,
      maxPagesPerRun: f.maxPagesPerRun,
      clock: c.clock,
      metrics: c.metrics,
      logger: c.logger,
    });
    return sync;
  });
}

export async function startLiveWorker(
  opts: { env?: Readonly<Record<string, string | undefined>>; buildBusiness: BuildBusiness; logger?: Logger; scheduler?: LoopScheduler; intervals?: LiveWorkerIntervals; container?: Omit<LiveContainerOptions, "environment" | "buildBusiness" | "env" | "unit"> },
): Promise<LiveWorkerRuntime> {
  const env = opts.env ?? process.env;
  const infra = loadInfrastructureEnv(env, { defaultPort: 8081 });
  const container = await buildLiveContainer({ ...(opts.container ?? {}), environment: infra.environment, buildBusiness: opts.buildBusiness, env, unit: "worker", ...(opts.logger ? { logger: opts.logger } : {}) });
  try {
    const feeds = composeConnectorFeeds(container);
    const instanceId = env.VSP_INSTANCE_ID && /^[A-Za-z0-9_.-]{1,48}$/.test(env.VSP_INSTANCE_ID) ? env.VSP_INSTANCE_ID : "worker-1";
    const loops = liveWorkerLoopsFor(container, { feeds, instanceId, ...(opts.intervals ? { intervals: opts.intervals } : {}) });
    const worker = new Worker({ loops, scheduler: opts.scheduler ?? new TimerLoopScheduler(), clock: container.clock, logger: container.logger });
    const health = await buildWorkerHealthApp(worker, container.logger);
    try {
      await health.listen({ host: infra.listenHost, port: infra.port });
    } catch (err) {
      await health.close().catch(() => undefined);
      throw err;
    }
    worker.start();
    return {
      container,
      worker,
      feeds,
      healthUrl: `http://${infra.listenHost}:${(health.server.address() as AddressInfo).port}`,
      async close() {
        await worker.stop();
        await health.close().catch(() => undefined);
        await container.close();
      },
    };
  } catch (err) {
    await container.close();
    throw err;
  }
}
