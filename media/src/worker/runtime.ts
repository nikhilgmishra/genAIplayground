/**
 * Per-process services of the media worker (WP-11): the egress-classified transport, the runtime credential, the
 * gateway client and the recorder, built once per job process from the worker configuration.
 */
import { ConnectorHttpTransport } from "@vsp/platform/src/connectors/http/transport.js";
import { EgressGuard } from "@vsp/platform/src/privacy/egress.js";
import { createLogger } from "@vsp/platform/src/observability/logger.js";
import type { Logger } from "@vsp/platform/src/observability/ports.js";
import { MediaGatewayClient } from "../binding/client.js";
import { ClientCredentialsTokenSource } from "../binding/runtime-credential.js";
import { LiveKitEgressRecorder } from "../recording/egress.js";
import type { MediaCallConfig } from "./call.js";
import type { MediaWorkerConfig, MediaWorkerSecrets } from "./config.js";

export interface MediaRuntime {
  config: MediaWorkerConfig;
  gateway: MediaGatewayClient;
  recorder: LiveKitEgressRecorder | null;
  /** Observe-only view of the room's egress list (always present). */
  egressObserver: LiveKitEgressRecorder;
  credential: ClientCredentialsTokenSource;
  logger: Logger;
  callConfig: MediaCallConfig;
}

export function buildMediaRuntime(config: MediaWorkerConfig, secrets: MediaWorkerSecrets, tlsCa: readonly string[], logger: Logger = createLogger({ service: "vsp-media" })): MediaRuntime {
  const transport = new ConnectorHttpTransport({
    environment: config.environment,
    egress: new EgressGuard(config.egress, { environment: config.environment, logger }),
    loopbackRoutes: config.loopbackRoutes.length > 0 ? new Map(config.loopbackRoutes.map((r) => [r.host, { port: r.port, tls: r.tls }])) : undefined,
    tlsCa: tlsCa.length > 0 ? tlsCa : undefined,
    logger,
  });
  const credential = new ClientCredentialsTokenSource({
    tokenUrl: config.runtimeAuth.tokenUrl,
    clientId: config.runtimeAuth.clientId,
    clientSecret: () => secrets.runtimeClientSecret,
    scope: config.runtimeAuth.scope,
    transport,
    addressClass: config.runtimeAuth.addressClass,
  });
  const gateway = new MediaGatewayClient({
    baseUrl: config.gateway.baseUrl,
    transport,
    credential: () => credential.token(),
    invalidateCredential: () => credential.invalidate(),
    addressClass: config.gateway.addressClass,
    timeoutMs: config.gateway.timeoutMs,
  });
  // The egress API client: it always OBSERVES the room's recorders (a recorder nobody here started is a mismatch even
  // when this worker records nothing, DATA-03); it starts and stops recorders only when recording is enabled.
  const egressApi = new LiveKitEgressRecorder({ apiUrl: config.livekit.apiUrl, transport, credentials: async () => ({ apiKey: secrets.livekitApiKey, apiSecret: secrets.livekitApiSecret }), addressClass: config.livekit.addressClass });
  const recorder = config.recording.enabled ? egressApi : null;
  const callConfig: MediaCallConfig = {
    workerInstanceRef: config.workerInstanceRef,
    adapter: config.adapter,
    language: config.language,
    sampleRate: config.playback.sampleRate,
    comfortNoiseDbfs: config.playback.comfortNoiseDbfs,
    dtmfMenu: config.dtmfMenu,
    bindDeadlineMs: config.recovery.bindDeadlineMs,
    humanDeadlineMs: config.recovery.humanDeadlineMs,
    reconcileIntervalMs: config.reconcileIntervalMs,
    lifecycleDeadlineMs: config.recovery.lifecycleDeadlineMs,
    faultSeams: { environment: config.environment, faultSeams: config.faultSeams },
    slowerRate: config.playback.slowerRate,
  };
  return { config, gateway, recorder, egressObserver: egressApi, credential, logger, callConfig };
}
