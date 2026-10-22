/**
 * The model adapters' HTTP seam over the WP-06 egress-classified transport (platform/src/connectors/http), the only
 * module allowed to open sockets (ESLint and the architecture suite enforce it; docs/ARCHITECTURE.md 6.4 rule 1).
 *
 * Every model request therefore gets, before any I/O: https only, the exact host allowlist of the endpoint, DNS
 * answers checked against the endpoint's address class and pinned, and the per-request egress check of the model
 * endpoint classes (EgressGuard.forModelEndpoint: provider, region and retention terms). During the exchange:
 * redirects refused, bounded bodies, the attempt deadline and the caller's AbortSignal, which destroys the socket so
 * the provider sees the stream closed (FO-09-45: abort propagates to the provider stream).
 *
 * `incremental` says whether body chunks reach the parser as they arrive. `modelExchangeFor` picks the exchange by
 * feature detection: the WP-06 transport's `send` delivers a response when it has ended (TransportModelExchange,
 * `incremental = false`; parsing, typing and cancellation are exact, but time-to-first-token equals the response time
 * and the first-event / idle watchdog is not armed, the attempt timeout bounds a stalled stream). A transport that
 * offers `stream()` (the additive method handed to the transport owner, README "Streaming") gets
 * StreamingTransportModelExchange (`incremental = true`) and the watchdog below is armed; adapters need no change.
 */
import type { Classification } from "../../protocol/common.js";
import { TransportError } from "../../connectors/http/transport.js";
import type { DestinationPolicy, TransportRequest, TransportResponse } from "../../connectors/http/transport.js";
import { parseRetryAfter } from "../../resilience/rate-limiter.js";
import { AccessDeniedError, DependencyError, PlatformError } from "../../shared/errors.js";
import { ModelCallError } from "../port/errors.js";

export interface ModelHttpRequest {
  method: "GET" | "POST";
  url: URL;
  headers: Record<string, string>;
  body: string | Buffer | null;
  dataClass: Classification;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface ModelHttpResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: AsyncIterable<Buffer>;
}

export interface ModelHttpExchange {
  /** True when body chunks are delivered as they arrive (arms the first-event and idle watchdog). */
  readonly incremental: boolean;
  send(req: ModelHttpRequest): Promise<ModelHttpResponse>;
}

/** The transport surface the exchange needs (ConnectorHttpTransport satisfies it). */
export interface ModelTransport {
  send(req: TransportRequest): Promise<TransportResponse>;
}

/** Metric dependency label of every model exchange (an allowlisted DEPENDENCY_IDS value). */
export const MODEL_DEPENDENCY = "model-provider";

async function* once(body: Buffer): AsyncIterable<Buffer> {
  if (body.length > 0) yield body;
}

/** Model exchanges over the egress-classified transport. */
export class TransportModelExchange implements ModelHttpExchange {
  readonly incremental = false;

  constructor(
    private readonly transport: ModelTransport,
    private readonly network: Pick<DestinationPolicy, "allowedHosts" | "addressClass">,
  ) {}

  async send(req: ModelHttpRequest): Promise<ModelHttpResponse> {
    let res: TransportResponse;
    try {
      res = await this.transport.send({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: req.body,
        policy: { allowedHosts: this.network.allowedHosts, addressClass: this.network.addressClass, dataClass: req.dataClass },
        // Inference changes no vendor state (provider-side storage is off in every adapter): a failure after send
        // is a definite FAILED, never an UNKNOWN commit.
        sideEffect: false,
        timeoutMs: Math.min(120_000, Math.max(1, Math.floor(req.timeoutMs))),
        signal: req.signal,
        dependency: MODEL_DEPENDENCY,
      });
    } catch (err) {
      throw transportFailureToModelError(err);
    }
    return { status: res.status, headers: res.headers, body: once(res.body) };
  }
}

/**
 * The incremental transport surface (the `stream()` exchange handed to the WP-06 transport owner): the promise
 * resolves at the response head and the body yields chunks as they arrive.
 */
export interface ModelStreamingTransport {
  stream(req: TransportRequest): Promise<{ status: number; headers: Readonly<Record<string, string>>; body: AsyncIterable<Buffer>; cancel(): void }>;
}

/** True when the transport offers the incremental exchange. */
export function hasStreaming(t: unknown): t is ModelStreamingTransport {
  return typeof (t as { stream?: unknown } | null)?.stream === "function";
}

async function* mapFailures(body: AsyncIterable<Buffer>): AsyncIterable<Buffer> {
  try {
    yield* body;
  } catch (err) {
    throw transportFailureToModelError(err);
  }
}

/**
 * Model exchanges whose body chunks reach the parser as they arrive (`incremental = true`): deltas are emitted while
 * the provider is still generating, and the first-event / idle watchdog bounds a stalled stream before the attempt
 * timeout. The factory selects it whenever the transport offers `stream()`.
 */
export class StreamingTransportModelExchange implements ModelHttpExchange {
  readonly incremental = true;

  constructor(
    private readonly transport: ModelStreamingTransport,
    private readonly network: Pick<DestinationPolicy, "allowedHosts" | "addressClass">,
  ) {}

  async send(req: ModelHttpRequest): Promise<ModelHttpResponse> {
    try {
      const res = await this.transport.stream({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: req.body,
        policy: { allowedHosts: this.network.allowedHosts, addressClass: this.network.addressClass, dataClass: req.dataClass },
        sideEffect: false,
        timeoutMs: Math.min(120_000, Math.max(1, Math.floor(req.timeoutMs))),
        signal: req.signal,
        dependency: MODEL_DEPENDENCY,
      });
      return { status: res.status, headers: res.headers, body: mapFailures(res.body) };
    } catch (err) {
      throw transportFailureToModelError(err);
    }
  }
}

/** The exchange for a transport: incremental when it offers `stream()`, otherwise the buffered exchange. */
export function modelExchangeFor(transport: ModelTransport, network: Pick<DestinationPolicy, "allowedHosts" | "addressClass">): ModelHttpExchange {
  return hasStreaming(transport) ? new StreamingTransportModelExchange(transport, network) : new TransportModelExchange(transport, network);
}

const PRE_IO_CANCEL = new Set(["CALLER_ABORTED"]);

/** Maps a transport or egress failure onto the typed model failure (reason codes only). */
export function transportFailureToModelError(err: unknown): ModelCallError {
  if (err instanceof ModelCallError) return err;
  if (err instanceof AccessDeniedError) return new ModelCallError({ kind: "UNAVAILABLE", reasonCode: err.reasonCode, errorClass: "PERMANENT", notStarted: true });
  if (err instanceof DependencyError) {
    const phase = err instanceof TransportError ? err.phase : null;
    const sent = err instanceof TransportError ? err.requestSent : err.outcome !== "NOT_STARTED";
    const code = err.reasonCode;
    if (PRE_IO_CANCEL.has(code)) return new ModelCallError({ kind: "CANCELLED", reasonCode: "MODEL_CALL_CANCELLED", errorClass: "PERMANENT", notStarted: !sent });
    if (code === "TIMEOUT_BEFORE_SEND") return new ModelCallError({ kind: "TIMED_OUT", reasonCode: "TIMEOUT_BEFORE_SEND", errorClass: "RETRYABLE", notStarted: true, timeoutPhase: "BEFORE_SEND" });
    if (code === "READ_TIMEOUT" || code === "TIMEOUT_AFTER_SEND") {
      // No response head yet: the provider never started streaming. Head received: the stream stalled.
      return new ModelCallError({ kind: "TIMED_OUT", reasonCode: "MODEL_READ_TIMEOUT", errorClass: "RETRYABLE", timeoutPhase: phase === "RESPONSE" ? "STREAM_IDLE" : "FIRST_EVENT" });
    }
    if (code === "CONNECTION_REFUSED") return new ModelCallError({ kind: "FAILED", reasonCode: "CONNECTION_REFUSED", errorClass: "RETRYABLE", notStarted: !sent });
    if (code === "CONNECTION_LOST") return new ModelCallError({ kind: "FAILED", reasonCode: "CONNECTION_LOST", errorClass: "RETRYABLE" });
    if (code === "CONNECTOR_RESPONSE_TOO_LARGE") return new ModelCallError({ kind: "MALFORMED", reasonCode: "MODEL_RESPONSE_TOO_LARGE", errorClass: "PERMANENT" });
    if (code === "CONNECTOR_TLS_FAILED") return new ModelCallError({ kind: "FAILED", reasonCode: code, errorClass: "PERMANENT", notStarted: true });
    if (code === "CONNECTOR_REDIRECT_REFUSED") return new ModelCallError({ kind: "FAILED", reasonCode: code, errorClass: "PERMANENT" });
    if (phase === "PRE_IO") return new ModelCallError({ kind: "UNAVAILABLE", reasonCode: code, errorClass: "PERMANENT", notStarted: true });
    return new ModelCallError({ kind: "FAILED", reasonCode: code, errorClass: err.outcome === "UNKNOWN" ? "UNKNOWN" : err.retryable ? "RETRYABLE" : "PERMANENT", notStarted: err.outcome === "NOT_STARTED" });
  }
  if (err instanceof PlatformError) return new ModelCallError({ kind: "UNAVAILABLE", reasonCode: err.reasonCode, errorClass: "PERMANENT", notStarted: true });
  return new ModelCallError({ kind: "FAILED", reasonCode: "UNCLASSIFIED_ERROR", errorClass: "UNKNOWN" });
}

/** Provider-directed retry delay: `retry-after-ms` (OpenAI), then `retry-after` (seconds or HTTP date), capped. */
export function retryAfterFrom(headers: Readonly<Record<string, string>>, now: Date, capMs = 120_000): number | null {
  const ms = headers["retry-after-ms"];
  if (ms !== undefined && /^\d{1,9}(\.\d+)?$/.test(ms.trim())) return Math.min(Math.ceil(Number(ms)), capMs);
  return parseRetryAfter(headers["retry-after"], now, capMs);
}

/** Reads a whole (bounded) body, e.g. an error document. */
export async function readBody(body: AsyncIterable<Buffer>, maxBytes = 65_536): Promise<Buffer> {
  const parts: Buffer[] = [];
  let n = 0;
  for await (const c of body) {
    n += c.length;
    if (n > maxBytes) throw new ModelCallError({ kind: "MALFORMED", reasonCode: "MODEL_ERROR_BODY_TOO_LARGE", errorClass: "PERMANENT" });
    parts.push(c);
  }
  return Buffer.concat(parts);
}

/** Parses a JSON document without letting a parse failure escape untyped. */
export function parseJson(buf: Buffer | string): unknown {
  try {
    return JSON.parse(typeof buf === "string" ? buf : buf.toString("utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Chunks of `body` under the stream watchdog (incremental exchanges only): FIRST_EVENT when nothing arrives within
 * `firstEventTimeoutMs`, STREAM_IDLE when the gap between chunks exceeds `idleTimeoutMs`. On a timeout the iteration
 * ends with a typed ModelCallError and `abort` is called so the exchange closes the provider stream.
 */
export async function* watched(
  body: AsyncIterable<Buffer>,
  o: { incremental: boolean; firstEventTimeoutMs: number; idleTimeoutMs: number; abort: () => void },
): AsyncIterable<Buffer> {
  if (!o.incremental) {
    yield* body;
    return;
  }
  const it = body[Symbol.asyncIterator]();
  let first = true;
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = first ? o.firstEventTimeoutMs : o.idleTimeoutMs;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), limit);
    });
    const next = await Promise.race([it.next(), timeout]).finally(() => clearTimeout(timer));
    if (next === "timeout") {
      o.abort();
      void it.return?.();
      throw new ModelCallError({ kind: "TIMED_OUT", reasonCode: first ? "MODEL_FIRST_EVENT_TIMEOUT" : "MODEL_STREAM_IDLE_TIMEOUT", errorClass: "RETRYABLE", timeoutPhase: first ? "FIRST_EVENT" : "STREAM_IDLE" });
    }
    if (next.done) return;
    first = false;
    yield next.value;
  }
}
