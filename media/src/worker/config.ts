/**
 * Media worker configuration (WP-11). Non-secret settings come from a JSON file named by VSP_MEDIA_CONFIG_FILE;
 * the three secrets come from the environment, injected by the deployment from the secret store (the worker
 * imports no secret-store client, FO-06-04): LIVEKIT_API_KEY / LIVEKIT_API_SECRET (the Agents worker registration
 * and the egress API) and VSP_MEDIA_RUNTIME_CLIENT_SECRET (the runtime's OAuth client). Job processes forked by the
 * Agents server inherit the same environment and load the same configuration.
 *
 * Fail-closed rules: staging and production need wss/https everywhere, accept no loopback emulator route and no
 * fault seam; the recorder is only built when recording is enabled; the DTMF menu always offers a person.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import { Environment } from "@vsp/platform/src/protocol/common.js";
import { RuntimeAdapter, RuntimeInstanceRef } from "@vsp/platform/src/protocol/call-binding.js";
import { EgressPolicyConfig } from "@vsp/platform/src/privacy/egress.js";
import { DEFAULT_DTMF_MENU, DtmfMenuConfig } from "../playback/dtmf-menu.js";

export const MEDIA_WORKER_CONFIG_SCHEMA = "vsp.media-worker-config.v1";

const HttpsOrigin = z.string().url().refine((u) => {
  const x = new URL(u);
  return x.protocol === "https:" && !x.username && !x.password && !x.search && !x.hash && (x.pathname === "/" || x.pathname === "");
}, "https origin expected");
const AddressClass = z.enum(["PUBLIC_INTERNET", "PRIVATE_NETWORK"]);
const Host = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/);

export const MediaWorkerConfig = z
  .strictObject({
    schemaVersion: z.literal(MEDIA_WORKER_CONFIG_SCHEMA),
    environment: Environment,
    /** Explicit-dispatch agent name: the worker receives only jobs dispatched to it by name. */
    agentName: z.string().regex(/^[a-z][a-z0-9-]{2,63}$/),
    workerInstanceRef: RuntimeInstanceRef,
    adapter: RuntimeAdapter,
    language: z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/),
    livekit: z.strictObject({ wsUrl: z.string().url(), apiUrl: HttpsOrigin, addressClass: AddressClass }),
    gateway: z.strictObject({ baseUrl: HttpsOrigin, addressClass: AddressClass, timeoutMs: z.number().int().min(500).max(30_000) }),
    runtimeAuth: z.strictObject({ tokenUrl: z.string().url(), clientId: z.string().regex(/^[A-Za-z0-9_.-]{3,128}$/), scope: z.string().min(3).max(256), addressClass: AddressClass }),
    recording: z.strictObject({ enabled: z.boolean() }),
    egress: EgressPolicyConfig,
    loopbackRoutes: z.array(z.strictObject({ host: Host, port: z.number().int().min(1).max(65_535), tls: z.boolean() })).max(8).default([]),
    tlsCaFiles: z.array(z.string().min(1).max(512)).max(4).default([]),
    playback: z.strictObject({
      sampleRate: z.union([z.literal(16_000), z.literal(24_000), z.literal(48_000)]),
      comfortNoiseDbfs: z.number().min(-90).max(-40),
      slowerRate: z.number().min(0.6).max(0.95),
    }),
    dtmfMenu: DtmfMenuConfig.default(DEFAULT_DTMF_MENU),
    recovery: z.strictObject({
      bindDeadlineMs: z.number().int().min(1_000).max(120_000),
      humanDeadlineMs: z.number().int().min(1_000).max(120_000),
      /** How long one lifecycle report is retried before the call fails safe (speech refused, a person). */
      lifecycleDeadlineMs: z.number().int().min(1_000).max(60_000).default(10_000),
    }),
    reconcileIntervalMs: z.number().int().min(250).max(30_000),
    idleProcesses: z.number().int().min(0).max(16).default(1),
    /** Calls one worker process holds at most; its load reported to livekit-server is the share of these slots in use. */
    maxConcurrentCalls: z.number().int().min(1).max(64).default(4),
    faultSeams: z.boolean().default(false),
    health: z.strictObject({ host: z.string().regex(/^(127\.0\.0\.1|0\.0\.0\.0|::1?)$/), port: z.number().int().min(0).max(65_535) }),
  })
  .superRefine((c, ctx) => {
    const live = c.environment === "staging" || c.environment === "production";
    if (!live) return;
    if (!c.livekit.wsUrl.startsWith("wss://")) ctx.addIssue({ code: "custom", message: "MEDIA_LIVEKIT_WS_NOT_TLS", path: ["livekit", "wsUrl"] });
    if (!c.runtimeAuth.tokenUrl.startsWith("https://")) ctx.addIssue({ code: "custom", message: "MEDIA_TOKEN_URL_NOT_TLS", path: ["runtimeAuth", "tokenUrl"] });
    if (c.loopbackRoutes.length > 0) ctx.addIssue({ code: "custom", message: "MEDIA_LOOPBACK_ROUTE_IN_LIVE_ENVIRONMENT", path: ["loopbackRoutes"] });
    if (c.faultSeams) ctx.addIssue({ code: "custom", message: "MEDIA_FAULT_SEAM_IN_LIVE_ENVIRONMENT", path: ["faultSeams"] });
    // The reconciliation tick bounds how long a consent revocation recorded in the control plane takes to stop the
    // recorder and the taps (DATA-03): at most 5 s in a deployed environment.
    if (c.reconcileIntervalMs > 5_000) ctx.addIssue({ code: "custom", message: "MEDIA_RECONCILE_INTERVAL_TOO_LONG", path: ["reconcileIntervalMs"] });
  });
export type MediaWorkerConfig = z.infer<typeof MediaWorkerConfig>;

export interface MediaWorkerSecrets {
  livekitApiKey: string;
  livekitApiSecret: string;
  runtimeClientSecret: string;
}

export class MediaConfigError extends Error {
  constructor(readonly reasonCodes: readonly string[]) {
    super(`MEDIA_CONFIG_REJECTED: ${reasonCodes.join(",")}`);
    this.name = "MediaConfigError";
  }
}

export function parseMediaWorkerConfig(raw: unknown): MediaWorkerConfig {
  const parsed = MediaWorkerConfig.safeParse(raw);
  if (!parsed.success) throw new MediaConfigError(parsed.error.issues.map((i) => (i.code === "custom" ? i.message : `${i.path.join(".")}:${i.code}`)));
  return parsed.data;
}

/** Reads the configuration file and the secrets; a missing or malformed value fails the start. */
export function loadMediaWorkerConfig(env: Readonly<Record<string, string | undefined>>): { config: MediaWorkerConfig; secrets: MediaWorkerSecrets; tlsCa: string[] } {
  const file = env.VSP_MEDIA_CONFIG_FILE;
  if (!file) throw new MediaConfigError(["VSP_MEDIA_CONFIG_FILE_MISSING"]);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new MediaConfigError(["VSP_MEDIA_CONFIG_FILE_UNREADABLE"]);
  }
  const config = parseMediaWorkerConfig(raw);
  const missing = ["LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "VSP_MEDIA_RUNTIME_CLIENT_SECRET"].filter((k) => !env[k]);
  if (missing.length > 0) throw new MediaConfigError(missing.map((k) => `${k}_MISSING`));
  let tlsCa: string[];
  try {
    tlsCa = config.tlsCaFiles.map((f) => readFileSync(f, "utf8"));
  } catch {
    throw new MediaConfigError(["MEDIA_TLS_CA_UNREADABLE"]);
  }
  return {
    config,
    secrets: { livekitApiKey: env.LIVEKIT_API_KEY as string, livekitApiSecret: env.LIVEKIT_API_SECRET as string, runtimeClientSecret: env.VSP_MEDIA_RUNTIME_CLIENT_SECRET as string },
    tlsCa,
  };
}
