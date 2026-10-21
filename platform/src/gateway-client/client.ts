/**
 * Typed client of the gateway HTTP surface (WP-07; FO-03-11 rule 1). The only way the untrusted-output group
 * (models, harness, media) and the HTTP-only clients reach the trusted side: it can call exactly the operations
 * of the generated table (operations.generated.ts, from schemas/openapi/gateway.openapi.json), with the declared
 * path parameters, the declared headers and a body only where the operation takes one, and it accepts only the
 * declared response statuses.
 *
 * The client opens no socket itself: the caller injects `GatewayHttp` (in the untrusted group, the WP-06
 * egress-classified transport bound to the gateway's own destination). The integration credential is read per
 * call from `credential()` and only ever placed in the Authorization header; it is never logged, echoed or put in
 * an error. Errors carry reason codes only.
 */
import { ValidationError } from "../shared/errors.js";
import { GATEWAY_OPERATIONS } from "./operations.generated.js";
import type { GatewayOperationId, GatewayRequestBodies, GatewayResponseBodies } from "./operations.generated.js";

export interface GatewayHttpRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: URL;
  headers: Record<string, string>;
  body: string | null;
  timeoutMs: number;
}

export interface GatewayHttpResponse {
  status: number;
  body: Buffer | string;
}

/** Sends one request (the caller binds it to its transport); rejects when nothing was answered. */
export interface GatewayHttp {
  send(req: GatewayHttpRequest): Promise<GatewayHttpResponse>;
}

/** Reason-coded client failure (never carries a credential, a URL query or a body). */
export class GatewayClientError extends ValidationError {}

type ResponsesOf<Op extends GatewayOperationId> = GatewayResponseBodies[Op];

/** A declared response: the status and its body type (ErrorBody for error statuses). */
export type GatewayResult<Op extends GatewayOperationId> = { [S in keyof ResponsesOf<Op>]: { status: S; body: ResponsesOf<Op>[S] } }[keyof ResponsesOf<Op>];

export interface GatewayCallInput<Op extends GatewayOperationId> {
  pathParams?: Readonly<Record<string, string>>;
  /** Declared request headers only (lower-case names); Authorization is set by the client. */
  headers?: Readonly<Record<string, string>>;
  body?: GatewayRequestBodies[Op];
  timeoutMs?: number;
}

export interface GatewayClientOptions {
  /** Origin of the gateway: https, or http on the loopback interface only (local composition). */
  baseUrl: string;
  http: GatewayHttp;
  /** The integration access token of this caller's channel (read on each call, never cached here). */
  credential: () => Promise<string>;
  timeoutMs?: number;
}

const PATH_PARAM = /^[A-Za-z0-9._~-]{1,128}$/;
const HEADER_VALUE = /^[\x21-\x7E][\x20-\x7E]{0,255}$/;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export class GatewayClient {
  private readonly base: URL;
  private readonly timeoutMs: number;

  constructor(private readonly o: GatewayClientOptions) {
    let base: URL;
    try {
      base = new URL(o.baseUrl);
    } catch {
      throw new GatewayClientError("GATEWAY_BASE_URL_INVALID");
    }
    if (base.username || base.password || base.search || base.hash || (base.pathname !== "/" && base.pathname !== "")) throw new GatewayClientError("GATEWAY_BASE_URL_INVALID");
    if (base.protocol !== "https:" && !(base.protocol === "http:" && LOOPBACK.has(base.hostname))) throw new GatewayClientError("GATEWAY_BASE_URL_INSECURE");
    this.base = base;
    this.timeoutMs = o.timeoutMs ?? 5_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 60_000) throw new GatewayClientError("GATEWAY_TIMEOUT_INVALID");
  }

  /** Calls one declared operation. Rejects (reason code) on anything the contract does not declare. */
  async call<Op extends GatewayOperationId>(operationId: Op, input: GatewayCallInput<Op> = {}): Promise<GatewayResult<Op>> {
    if (!Object.hasOwn(GATEWAY_OPERATIONS, operationId)) throw new GatewayClientError("GATEWAY_OPERATION_UNKNOWN");
    const spec = GATEWAY_OPERATIONS[operationId];
    // Path: every declared parameter, nothing else; values are opaque segments.
    const given = input.pathParams ?? {};
    const declared = spec.pathParams as readonly string[];
    if (Object.keys(given).some((k) => !declared.includes(k))) throw new GatewayClientError("GATEWAY_PATH_PARAM_UNDECLARED");
    let path: string = spec.path;
    for (const name of declared) {
      const v = Object.hasOwn(given, name) ? given[name] : undefined;
      if (typeof v !== "string" || !PATH_PARAM.test(v)) throw new GatewayClientError("GATEWAY_PATH_PARAM_INVALID");
      path = path.replace(`{${name}}`, encodeURIComponent(v));
    }
    // Headers: declared ones only, required ones present; the credential is the client's own.
    const headerSpecs = spec.headers as readonly { name: string; required: boolean }[];
    const headers: Record<string, string> = { accept: "application/json" };
    for (const [k, v] of Object.entries(input.headers ?? {})) {
      const name = k.toLowerCase();
      if (!headerSpecs.some((h) => h.name === name)) throw new GatewayClientError("GATEWAY_HEADER_UNDECLARED");
      if (typeof v !== "string" || !HEADER_VALUE.test(v)) throw new GatewayClientError("GATEWAY_HEADER_INVALID");
      headers[name] = v;
    }
    for (const h of headerSpecs) if (h.required && !Object.hasOwn(headers, h.name)) throw new GatewayClientError("GATEWAY_HEADER_MISSING");
    const token = await this.o.credential();
    if (typeof token !== "string" || token.length < 16 || token.length > 8_192 || /\s/.test(token)) throw new GatewayClientError("GATEWAY_CREDENTIAL_INVALID");
    headers.authorization = `Bearer ${token}`;
    // Body: only where the operation takes one.
    let body: string | null = null;
    if (input.body !== undefined) {
      if (spec.body === "none") throw new GatewayClientError("GATEWAY_BODY_NOT_ACCEPTED");
      body = JSON.stringify(input.body);
      headers["content-type"] = "application/json";
    } else if (spec.body === "required") throw new GatewayClientError("GATEWAY_BODY_MISSING");

    const res = await this.o.http.send({ method: spec.method, url: new URL(path, this.base), headers, body, timeoutMs: input.timeoutMs ?? this.timeoutMs });
    if (!(spec.statuses as readonly number[]).includes(res.status)) throw new GatewayClientError("GATEWAY_RESPONSE_UNDECLARED");
    const text = typeof res.body === "string" ? res.body : res.body.toString("utf8");
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new GatewayClientError("GATEWAY_RESPONSE_MALFORMED");
      }
    }
    return { status: res.status, body: parsed } as GatewayResult<Op>;
  }
}
