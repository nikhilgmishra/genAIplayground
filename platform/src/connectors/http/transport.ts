/**
 * Egress-classified HTTP transport (WP-06; FO-06-20, FO-15-19; DATA-01, SAFE-05, ACT-03).
 *
 * The only outbound HTTP client of the connector runtime, and the transport the untrusted-output group
 * (models, harness, media) may use (docs/ARCHITECTURE.md section 6.4 rule 1). It imports nothing but
 * protocol, shared, observability and node built-ins: no connector profile, secret resolver, mapping
 * DSL or connector family. Every request, before any socket exists:
 *   1. https URLs only (a local/ci emulator route may carry the exchange over loopback plain HTTP), no
 *      userinfo, no fragment;
 *   2. the host is a DNS name (never an IP literal) and an exact member of the destination's allowedHosts;
 *   3. the EgressGuard approves the destination for the payload's data class (checked per request);
 *   4. the name is resolved once and EVERY resolved address must belong to the destination's address
 *      class (public internet or private network; loopback, link-local and reserved ranges never), and
 *      the connection is pinned to that address (no second resolution: DNS rebinding defence).
 * Responses: redirects are refused (the Location target is never contacted), bodies are size-bounded,
 * the deadline is enforced and each failure is classified by how far the exchange got:
 *   nothing sent (DNS, connect, TLS)            NOT_STARTED, retryable unless TLS/policy
 *   sent, side-effecting request                UNKNOWN (reconcile before any retry, ACT-03)
 *   sent, read                                  FAILED, retryable (no side effect)
 * Errors carry reason codes only; headers and bodies are never logged (DATA-01).
 */
import { lookup as dnsLookup } from "node:dns";
import { request as httpRequest } from "node:http";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import type { RequestOptions as HttpsRequestOptions } from "node:https";
import type { Socket } from "node:net";
import type { Classification, Environment } from "../../protocol/common.js";
import type { Logger, Metrics } from "../../observability/ports.js";
import { silentLogger } from "../../observability/logger.js";
import { DependencyError, ValidationError } from "../../shared/errors.js";
import { addressesPermitted, isIpLiteral } from "./address.js";

/** What a request may reach: exact hosts, the address class they must resolve to, the payload class. */
export interface DestinationPolicy {
  readonly allowedHosts: readonly string[];
  readonly addressClass: "PUBLIC_INTERNET" | "PRIVATE_NETWORK";
  readonly dataClass: Classification;
}

/** The per-request egress check (platform/src/privacy/egress.ts EgressGuard satisfies it). */
export interface EgressCheck {
  assertAllowed(target: URL, dataClass: Classification): unknown;
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

/** Local/ci only: an emulator for `hostname` listens on the loopback port (TLS still verified for the name). */
export interface LoopbackRoute {
  readonly port: number;
  readonly tls: boolean;
}

export interface TransportOptions {
  environment: Environment;
  egress: EgressCheck;
  resolve?: Resolver;
  loopbackRoutes?: ReadonlyMap<string, LoopbackRoute>;
  /** Additional trusted CA certificates (PEM) for a private-network API with a private CA. */
  tlsCa?: readonly string[];
  maxResponseBytes?: number;
  maxRequestBytes?: number;
  metrics?: Metrics;
  logger?: Logger;
}

export interface TransportRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: URL;
  headers: Readonly<Record<string, string>>;
  body: string | Buffer | null;
  policy: DestinationPolicy;
  /** The request may change vendor state: a failure after it may have been sent is UNKNOWN (ACT-03). */
  sideEffect: boolean;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Dependency label for metrics (allowlisted; other values become "other"). */
  dependency: string;
}

export interface TransportResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: Buffer;
}

/** How far an exchange got before it failed. */
export type TransportPhase = "PRE_IO" | "CONNECT" | "TLS" | "SENT" | "RESPONSE";

/** Reason-coded transport failure; `requestSent` says whether the vendor may have seen the request. */
export class TransportError extends DependencyError {
  constructor(
    reasonCode: string,
    outcome: "NOT_STARTED" | "FAILED" | "UNKNOWN",
    retryable: boolean,
    readonly phase: TransportPhase,
    readonly requestSent: boolean,
    readonly httpStatus: number | null = null,
  ) {
    super(reasonCode, outcome, retryable);
  }
}

export const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
export const MAX_RESPONSE_BYTES_LIMIT = 16_777_216;
export const DEFAULT_MAX_REQUEST_BYTES = 262_144;
const MAX_HEADERS = 64;
const MAX_HEADER_VALUE = 1_024;
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const NOT_CONNECTED = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL"]);

const defaultResolver: Resolver = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 })));
    });
  });

const preIo = (reasonCode: string, retryable = false) => new TransportError(reasonCode, "NOT_STARTED", retryable, "PRE_IO", false);

function errorCode(err: unknown): string | null {
  const c = (err as { code?: unknown } | null)?.code;
  return typeof c === "string" ? c : null;
}

export class ConnectorHttpTransport {
  readonly kind = "live" as const;
  private readonly opts: TransportOptions;
  private readonly resolver: Resolver;
  private readonly maxResponseBytes: number;
  private readonly maxRequestBytes: number;
  private readonly logger: Logger;

  constructor(opts: TransportOptions) {
    const max = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    const maxReq = opts.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
    if (!Number.isInteger(max) || max < 1_024 || max > MAX_RESPONSE_BYTES_LIMIT) throw new ValidationError("TRANSPORT_RESPONSE_BOUND_INVALID");
    if (!Number.isInteger(maxReq) || maxReq < 1_024 || maxReq > MAX_RESPONSE_BYTES_LIMIT) throw new ValidationError("TRANSPORT_REQUEST_BOUND_INVALID");
    const routes = opts.loopbackRoutes;
    if (routes && routes.size > 0 && opts.environment !== "local" && opts.environment !== "ci") {
      // Emulator routing exists for local/ci regression runs only; a deployed process never has it.
      throw new ValidationError("TRANSPORT_LOOPBACK_ROUTE_OUTSIDE_LOCAL");
    }
    for (const [host, r] of routes ?? []) {
      if (!HOSTNAME.test(host) || !Number.isInteger(r.port) || r.port < 1 || r.port > 65_535) throw new ValidationError("TRANSPORT_LOOPBACK_ROUTE_INVALID");
    }
    this.opts = opts;
    this.resolver = opts.resolve ?? defaultResolver;
    this.maxResponseBytes = max;
    this.maxRequestBytes = maxReq;
    this.logger = (opts.logger ?? silentLogger).child({ component: "connector_http" });
  }

  /** Performs one exchange. Throws TransportError (or the egress guard's AccessDeniedError) on failure. */
  async send(req: TransportRequest): Promise<TransportResponse> {
    try {
      const res = await this.exchange(req);
      this.count(req.dependency, res.status >= 200 && res.status < 300 ? "success" : res.status >= 500 ? "server_error" : "client_error");
      return res;
    } catch (err) {
      if (err instanceof TransportError) {
        this.count(req.dependency, err.phase === "PRE_IO" ? "refused_pre_io" : err.requestSent ? "failed_after_send" : "failed_before_send");
        this.logger.warn("connector.http.failed", { reasonCode: err.reasonCode, outcome: err.outcome, state: err.phase.toLowerCase(), integration: req.dependency });
      } else {
        this.count(req.dependency, "refused_pre_io");
      }
      throw err;
    }
  }

  private count(dependency: string, result: string): void {
    try {
      this.opts.metrics?.increment("vsp_connector_http_requests_total", { dependency, result });
    } catch {
      // metrics never change the outcome of a request
    }
  }

  /** Pre-I/O checks: everything that can be refused without touching the network. */
  private checkDestination(req: TransportRequest): { route: LoopbackRoute | null } {
    const url = req.url;
    if (url.username || url.password) throw preIo("CONNECTOR_URL_USERINFO_REFUSED");
    if (url.hash) throw preIo("CONNECTOR_URL_FRAGMENT_REFUSED");
    const host = url.hostname.toLowerCase();
    if (isIpLiteral(host)) throw preIo("CONNECTOR_IP_LITERAL_REFUSED");
    if (!HOSTNAME.test(host)) throw preIo("CONNECTOR_HOST_INVALID");
    if (!req.policy.allowedHosts.includes(host)) throw preIo("CONNECTOR_HOST_NOT_ALLOWED");
    const route = this.opts.loopbackRoutes?.get(host) ?? null;
    // Destinations are https. Only an explicit local/ci emulator route may carry the exchange over plain
    // HTTP on the loopback interface (Layer-1 unit runs); Layer-2 routes keep TLS with the name verified.
    if (url.protocol !== "https:") throw preIo("CONNECTOR_URL_INSECURE");
    if (!Number.isInteger(req.timeoutMs) || req.timeoutMs < 1 || req.timeoutMs > 120_000) throw new ValidationError("TRANSPORT_TIMEOUT_INVALID");
    const bytes = req.body === null ? 0 : Buffer.byteLength(req.body);
    if (bytes > this.maxRequestBytes) throw preIo("CONNECTOR_REQUEST_TOO_LARGE");
    if (req.method === "GET" && req.body !== null) throw preIo("CONNECTOR_GET_WITH_BODY");
    for (const [k, v] of Object.entries(req.headers)) {
      if (!/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(k) || /[\r\n\0]/.test(v) || v.length > 8_192) throw preIo("CONNECTOR_HEADER_INVALID");
    }
    // Per-request egress classification (FO-15-19): throws AccessDeniedError with the EGRESS_* reason.
    this.opts.egress.assertAllowed(url, req.policy.dataClass);
    return { route };
  }

  private async pin(req: TransportRequest, route: LoopbackRoute | null): Promise<ResolvedAddress> {
    if (route !== null) return { address: "127.0.0.1", family: 4 };
    let addresses: ResolvedAddress[];
    try {
      addresses = await this.resolver(req.url.hostname.toLowerCase());
    } catch {
      throw new TransportError("CONNECTION_REFUSED", "NOT_STARTED", true, "CONNECT", false);
    }
    if (addresses.length === 0) throw new TransportError("CONNECTION_REFUSED", "NOT_STARTED", true, "CONNECT", false);
    // Every answer must be acceptable: one rebinding answer among good ones still refuses the name.
    if (!addressesPermitted(addresses.map((a) => a.address), req.policy.addressClass)) throw preIo("CONNECTOR_ADDRESS_NOT_ALLOWED");
    const first = addresses[0];
    if (!first) throw new TransportError("CONNECTION_REFUSED", "NOT_STARTED", true, "CONNECT", false);
    return first;
  }

  private async exchange(req: TransportRequest): Promise<TransportResponse> {
    if (req.signal?.aborted) throw preIo("CALLER_ABORTED");
    const { route } = this.checkDestination(req);
    const started = Date.now();
    // The deadline covers name resolution too: a resolver that never answers is a timeout before send.
    let resolveTimer: ReturnType<typeof setTimeout> | undefined;
    const pinned = await Promise.race([
      this.pin(req, route),
      new Promise<never>((_resolve, reject) => {
        resolveTimer = setTimeout(() => reject(new TransportError("TIMEOUT_BEFORE_SEND", "NOT_STARTED", true, "CONNECT", false)), req.timeoutMs);
      }),
    ]).finally(() => clearTimeout(resolveTimer));
    if (req.signal?.aborted) throw preIo("CALLER_ABORTED");
    const remainingMs = Math.max(1, req.timeoutMs - (Date.now() - started));
    const url = req.url;
    const tls = route !== null ? route.tls : true;
    const port = route?.port ?? (url.port ? Number(url.port) : 443);
    const headers: Record<string, string> = { ...req.headers, host: url.host };
    if (req.body !== null) headers["content-length"] = String(Buffer.byteLength(req.body));

    return new Promise<TransportResponse>((resolve, reject) => {
      let phase: TransportPhase = "CONNECT";
      let settled = false;
      let request: ClientRequest | null = null;
      const sent = () => phase === "SENT" || phase === "RESPONSE";
      const classify = (reasonBefore: string, reasonAfterWrite: string, reasonAfterRead: string, retryableBefore = true): TransportError => {
        if (!sent()) return new TransportError(reasonBefore, "NOT_STARTED", retryableBefore, phase, false);
        return req.sideEffect ? new TransportError(reasonAfterWrite, "UNKNOWN", false, phase, true) : new TransportError(reasonAfterRead, "FAILED", true, phase, true);
      };
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.signal?.removeEventListener("abort", onAbort);
        fn();
      };
      const fail = (e: TransportError) =>
        finish(() => {
          request?.destroy();
          reject(e);
        });
      const timer = setTimeout(() => fail(classify("TIMEOUT_BEFORE_SEND", "TIMEOUT_AFTER_SEND", "READ_TIMEOUT")), remainingMs);
      const onAbort = () => fail(classify("CALLER_ABORTED", "CALLER_ABORTED", "CALLER_ABORTED", false));
      req.signal?.addEventListener("abort", onAbort, { once: true });

      const lookup: RequestOptions["lookup"] = ((_host: string, options: { all?: boolean }, cb: (...args: unknown[]) => void) => {
        if (options?.all) cb(null, [{ address: pinned.address, family: pinned.family }]);
        else cb(null, pinned.address, pinned.family);
      }) as RequestOptions["lookup"];
      const base: RequestOptions = {
        method: req.method,
        hostname: url.hostname,
        port,
        path: `${url.pathname}${url.search}`,
        headers,
        agent: false,
        lookup,
      };
      const onResponse = (res: IncomingMessage) => {
        phase = "RESPONSE";
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          // The Location target is never contacted. For a write the vendor may have processed it (303).
          fail(req.sideEffect ? new TransportError("CONNECTOR_REDIRECT_REFUSED", "UNKNOWN", false, "RESPONSE", true, status) : new TransportError("CONNECTOR_REDIRECT_REFUSED", "FAILED", false, "RESPONSE", true, status));
          return;
        }
        const declared = Number(res.headers["content-length"] ?? "0");
        if (Number.isFinite(declared) && declared > this.maxResponseBytes) {
          // Settle first: destroying the response emits its own close/error events.
          fail(req.sideEffect ? new TransportError("CONNECTOR_RESPONSE_TOO_LARGE", "UNKNOWN", false, "RESPONSE", true, status) : new TransportError("CONNECTOR_RESPONSE_TOO_LARGE", "FAILED", false, "RESPONSE", true, status));
          res.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (c: Buffer) => {
          total += c.length;
          if (total > this.maxResponseBytes) {
            fail(req.sideEffect ? new TransportError("CONNECTOR_RESPONSE_TOO_LARGE", "UNKNOWN", false, "RESPONSE", true, status) : new TransportError("CONNECTOR_RESPONSE_TOO_LARGE", "FAILED", false, "RESPONSE", true, status));
            res.destroy();
            return;
          }
          chunks.push(c);
        });
        res.on("error", () => fail(classify("CONNECTION_LOST", "CONNECTION_LOST", "CONNECTION_LOST")));
        res.on("aborted", () => fail(classify("CONNECTION_LOST", "CONNECTION_LOST", "CONNECTION_LOST")));
        res.on("end", () => {
          const out: Record<string, string> = {};
          let n = 0;
          for (const [k, v] of Object.entries(res.headers)) {
            if (n >= MAX_HEADERS || v === undefined) continue;
            const value = Array.isArray(v) ? v.join(", ") : v;
            if (value.length <= MAX_HEADER_VALUE) {
              out[k.toLowerCase()] = value;
              n += 1;
            }
          }
          finish(() => resolve({ status, headers: out, body: Buffer.concat(chunks) }));
        });
      };
      try {
        request = tls
          ? httpsRequest({ ...base, servername: url.hostname, ...(this.opts.tlsCa && this.opts.tlsCa.length > 0 ? { ca: [...this.opts.tlsCa] } : {}) } as HttpsRequestOptions, onResponse)
          : httpRequest(base, onResponse);
      } catch {
        fail(new TransportError("CONNECTION_REFUSED", "NOT_STARTED", true, "CONNECT", false));
        return;
      }
      request.on("socket", (socket: Socket) => {
        const connected = () => {
          // From here on the request bytes may reach the vendor.
          if (phase === "CONNECT" || phase === "TLS") phase = "SENT";
        };
        if (tls) {
          socket.once("connect", () => {
            if (phase === "CONNECT") phase = "TLS";
          });
          socket.once("secureConnect", connected);
        } else {
          socket.once("connect", connected);
        }
      });
      request.on("error", (err: unknown) => {
        const code = errorCode(err);
        if (!sent() && code !== null && NOT_CONNECTED.has(code)) return fail(new TransportError("CONNECTION_REFUSED", "NOT_STARTED", true, phase, false));
        if (phase === "TLS" || (code !== null && (code.startsWith("ERR_TLS") || code.startsWith("ERR_SSL") || code.includes("CERT") || code === "DEPTH_ZERO_SELF_SIGNED_CERT"))) {
          if (!sent()) return fail(new TransportError("CONNECTOR_TLS_FAILED", "NOT_STARTED", false, phase, false));
        }
        return fail(classify("CONNECTION_REFUSED", "CONNECTION_LOST", "CONNECTION_LOST"));
      });
      if (req.body !== null) request.write(req.body);
      request.end();
    });
  }
}
