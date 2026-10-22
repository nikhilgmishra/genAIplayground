/**
 * Media-path client of the gateway (WP-11; ADR-0018 decision 1.6): the worker reaches the control plane only over the
 * gateway's media routes (platform/src/gateway/http/media-routes.ts), with its own runtime credential, through the
 * egress-classified transport (platform/src/connectors/http, bound by the composition). Requests and responses are the
 * strict contracts of platform/src/protocol/call-binding.ts; a response that does not parse is a failure, never data.
 *
 * Hand-off: when the registry owner adds the media operations to schemas/openapi/gateway.openapi.json, the generated
 * gateway client (platform/src/gateway-client) can replace the request plumbing below; the contracts stay the same.
 */
import type { z } from "zod";
import {
  MediaBindResponse,
  MediaConsentDecisionResponse,
  MediaHeartbeatResponse,
  MediaLifecycleResponse,
  MediaProcessingReportResponse,
  MediaRecorderCheckResponse,
  MediaRouteResponse,
} from "@vsp/platform/src/protocol/call-binding.js";
import type {
  MediaBindRequest,
  MediaBindingClaim,
  MediaConsentDecisionRequest,
  MediaHumanRouteRequest,
  MediaLifecycleRequest,
  MediaProcessingState,
  MediaRecorderCheckRequest,
  MediaSafetyRouteRequest,
} from "@vsp/platform/src/protocol/call-binding.js";
import type { TransportRequest, TransportResponse } from "@vsp/platform/src/connectors/http/transport.js";

/** The egress-classified transport (ConnectorHttpTransport satisfies it). */
export interface MediaTransport {
  send(req: TransportRequest): Promise<TransportResponse>;
}

export interface MediaGatewayClientOptions {
  /** Gateway origin: https (a local/ci emulator route may map the name to the loopback interface). */
  baseUrl: string;
  transport: MediaTransport;
  /** The runtime's access token for the conversation_runtime channel, read per request (never cached here, never logged). */
  credential: () => Promise<string>;
  /**
   * Forgets the cached token after the gateway refused it (401/403: a rotated signing key, a revoked or expired
   * token). The request is then sent once more with a fresh token; a second refusal is final.
   */
  invalidateCredential?: () => void;
  addressClass: "PUBLIC_INTERNET" | "PRIVATE_NETWORK";
  timeoutMs?: number;
}

/** The gateway answered with a refusal (4xx): reason code only. 409 means the presented binding is not current. */
export class GatewayRefusedError extends Error {
  constructor(
    readonly status: number,
    readonly reasonCode: string,
  ) {
    super(reasonCode);
    this.name = "GatewayRefusedError";
  }
}

/** The gateway could not be reached or answered 5xx; `requestSent` says whether it may have acted. */
export class GatewayUnavailableError extends Error {
  constructor(
    readonly reasonCode: string,
    readonly requestSent: boolean,
  ) {
    super(reasonCode);
    this.name = "GatewayUnavailableError";
  }
}

const REASON = /^[A-Z][A-Z0-9_]{2,63}$/;

export class MediaGatewayClient {
  private readonly base: URL;
  private readonly timeoutMs: number;

  constructor(private readonly o: MediaGatewayClientOptions) {
    const base = new URL(o.baseUrl);
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || (base.pathname !== "/" && base.pathname !== "")) throw new Error("MEDIA_GATEWAY_URL_INVALID");
    this.base = base;
    this.timeoutMs = o.timeoutMs ?? 4_000;
  }

  bind(req: MediaBindRequest): Promise<z.infer<typeof MediaBindResponse>> {
    return this.post("/media/v1/calls/bindings", req, MediaBindResponse, 201);
  }

  heartbeat(claim: MediaBindingClaim): Promise<z.infer<typeof MediaHeartbeatResponse>> {
    return this.post(`/media/v1/calls/bindings/${claim.bindingId}/heartbeat`, { claim }, MediaHeartbeatResponse, 200);
  }

  lifecycle(req: MediaLifecycleRequest): Promise<z.infer<typeof MediaLifecycleResponse>> {
    return this.post(`/media/v1/calls/bindings/${req.claim.bindingId}/events`, req, MediaLifecycleResponse, 200);
  }

  consentDecision(req: MediaConsentDecisionRequest): Promise<z.infer<typeof MediaConsentDecisionResponse>> {
    return this.post(`/media/v1/calls/bindings/${req.claim.bindingId}/consent`, req, MediaConsentDecisionResponse, 200);
  }

  reportProcessing(claim: MediaBindingClaim, state: MediaProcessingState): Promise<z.infer<typeof MediaProcessingReportResponse>> {
    return this.post(`/media/v1/calls/bindings/${claim.bindingId}/processing`, { claim, state }, MediaProcessingReportResponse, 200);
  }

  /** The call's recorders and their consent for a job refused into a person route; issues no binding (DATA-03). */
  recorders(req: MediaRecorderCheckRequest): Promise<z.infer<typeof MediaRecorderCheckResponse>> {
    return this.post("/media/v1/calls/recorders", req, MediaRecorderCheckResponse, 200);
  }

  /** A person for the call; needs no binding (SAFE-02). */
  humanRoute(req: MediaHumanRouteRequest): Promise<z.infer<typeof MediaRouteResponse>> {
    return this.post("/media/v1/calls/human-route", req, MediaRouteResponse, 200);
  }

  /** The safety route; needs no binding (SAFE-02). */
  safetyRoute(req: MediaSafetyRouteRequest): Promise<z.infer<typeof MediaRouteResponse>> {
    return this.post("/media/v1/calls/safety-route", req, MediaRouteResponse, 200);
  }

  private async post<T extends z.ZodType>(path: string, body: unknown, schema: T, okStatus: number): Promise<z.infer<T>> {
    try {
      return await this.postOnce(path, body, schema, okStatus);
    } catch (err) {
      // A refused credential (401, or a 403 about the runtime credential itself such as a missing scope) is retried
      // once with a fresh token; the refusal happened before the body was read. Other 403s (the media plane did not
      // confirm the job) are not about the token and are never retried here.
      const credentialRefused = err instanceof GatewayRefusedError && (err.status === 401 || (err.status === 403 && err.reasonCode.startsWith("RUNTIME_")));
      if (!credentialRefused || !this.o.invalidateCredential) throw err;
      this.o.invalidateCredential();
      return this.postOnce(path, body, schema, okStatus);
    }
  }

  private async postOnce<T extends z.ZodType>(path: string, body: unknown, schema: T, okStatus: number): Promise<z.infer<T>> {
    let token: string;
    try {
      token = await this.o.credential();
    } catch {
      throw new GatewayUnavailableError("RUNTIME_CREDENTIAL_UNAVAILABLE", false);
    }
    let res: TransportResponse;
    try {
      res = await this.o.transport.send({
        method: "POST",
        url: new URL(path, this.base),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
        // Opaque binding identifiers and room names (which can carry a caller number): INTERNAL, to the gateway only.
        policy: { allowedHosts: [this.base.hostname], addressClass: this.o.addressClass, dataClass: "INTERNAL" },
        sideEffect: true,
        timeoutMs: this.timeoutMs,
        dependency: "gateway",
      });
    } catch (err) {
      const e = err as { reasonCode?: unknown; requestSent?: unknown };
      throw new GatewayUnavailableError(typeof e.reasonCode === "string" && REASON.test(e.reasonCode) ? e.reasonCode : "GATEWAY_UNREACHABLE", e.requestSent === true);
    }
    let json: unknown;
    try {
      json = res.body.length > 0 ? JSON.parse(res.body.toString("utf8")) : null;
    } catch {
      throw new GatewayUnavailableError("GATEWAY_RESPONSE_MALFORMED", true);
    }
    if (res.status === okStatus) {
      const parsed = schema.safeParse(json);
      if (!parsed.success) throw new GatewayUnavailableError("GATEWAY_RESPONSE_INVALID", true);
      return parsed.data as z.infer<T>;
    }
    const reason = (json as { error?: { reasonCode?: unknown } } | null)?.error?.reasonCode;
    const code = typeof reason === "string" && REASON.test(reason) ? reason : `HTTP_${res.status}`;
    if (res.status >= 400 && res.status < 500) throw new GatewayRefusedError(res.status, code);
    throw new GatewayUnavailableError(code, true);
  }
}
