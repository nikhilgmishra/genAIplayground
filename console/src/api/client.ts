/**
 * Typed console API client (contract: platform/src/console-api/contract.ts).
 *
 * - Bearer token from the in-memory TokenStore only; cookies are never sent
 *   (`credentials: "omit"`), so cross-site requests carry no ambient authority.
 * - Every failure surfaces as a ConsoleApiError carrying a reason code (and the
 *   server's correlation id when present). Response bodies of failed requests
 *   are reduced to those fields; nothing else is kept or displayed.
 * - The UI hides actions a role cannot perform, but authorization is enforced
 *   by the server on every request (AUTH-02).
 */
import { AUTHORIZATION_HEADER, CONSOLE_ENDPOINTS, IDEMPOTENCY_HEADER, OPAQUE_ID_PATTERN, PUBLIC_ENDPOINTS, REASON_CODE_PATTERN } from "./contract";
import type { ConsoleEndpointTypes, EndpointKey, PathParams } from "./contract";
import { InvalidReferenceError, buildApiPath, buildQueryString } from "./paths";
import type { TokenStore } from "./token";
import { newIdempotencyKey } from "../lib/random";

const REASON_RE = new RegExp(REASON_CODE_PATTERN);
const OPAQUE_RE = new RegExp(OPAQUE_ID_PATTERN);

export class ConsoleApiError extends Error {
  constructor(
    readonly reasonCode: string,
    readonly status: number,
    readonly correlationId: string | null = null,
    readonly retryable = false,
  ) {
    super(reasonCode);
    this.name = "ConsoleApiError";
  }
}

export function toConsoleApiError(err: unknown): ConsoleApiError {
  if (err instanceof ConsoleApiError) return err;
  if (err instanceof InvalidReferenceError) return new ConsoleApiError("INVALID_REFERENCE", 0);
  return new ConsoleApiError("CLIENT_ERROR", 0);
}

type ParamsArg<K extends EndpointKey> = [keyof PathParams<K>] extends [never] ? { params?: undefined } : { params: PathParams<K> };
type QueryArg<K extends EndpointKey> = ConsoleEndpointTypes[K]["query"] extends undefined
  ? { query?: undefined }
  : { query: ConsoleEndpointTypes[K]["query"] };
type BodyArg<K extends EndpointKey> = ConsoleEndpointTypes[K]["body"] extends undefined
  ? { body?: undefined }
  : { body: ConsoleEndpointTypes[K]["body"] };

export type RequestArgs<K extends EndpointKey> = ParamsArg<K> &
  QueryArg<K> &
  BodyArg<K> & {
    /** Reuse one key per confirmed operator action so a double submit cannot apply twice. */
    idempotencyKey?: string;
  };

export type ResponseOf<K extends EndpointKey> = ConsoleEndpointTypes[K]["response"];

export interface ConsoleApiClientOptions {
  tokenStore: TokenStore;
  fetchImpl?: typeof fetch;
  /** Origin prefix; empty for same-origin (the Vite dev server proxies /console/api). */
  baseUrl?: string;
}

const PUBLIC_KEYS: ReadonlySet<string> = new Set(PUBLIC_ENDPOINTS);
/** Public endpoints that act on the current console session: they carry its bearer (never another credential). */
const SESSION_BEARER_PUBLIC_KEYS: ReadonlySet<string> = new Set(["auth.refresh"]);

export class ConsoleApiClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private unauthenticatedHandler: ((reasonCode: string) => void) | null = null;

  constructor(private readonly options: ConsoleApiClientOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.baseUrl = options.baseUrl ?? "";
  }

  get tokens(): TokenStore {
    return this.options.tokenStore;
  }

  /** Called when the server (or the local expiry check) says the session is no longer valid. */
  onUnauthenticated(handler: ((reasonCode: string) => void) | null): void {
    this.unauthenticatedHandler = handler;
  }

  async request<K extends EndpointKey>(key: K, args: RequestArgs<K>): Promise<ResponseOf<K>> {
    const spec = CONSOLE_ENDPOINTS[key];
    let path: string;
    try {
      path = buildApiPath(key, (args.params ?? {}) as PathParams<K>);
    } catch (err) {
      throw toConsoleApiError(err);
    }
    const headers: Record<string, string> = { Accept: "application/json" };
    if (SESSION_BEARER_PUBLIC_KEYS.has(key)) {
      const token = this.options.tokenStore.get();
      if (!token) throw new ConsoleApiError("SESSION_EXPIRED", 401);
      headers[AUTHORIZATION_HEADER] = `Bearer ${token}`;
    } else if (!PUBLIC_KEYS.has(key)) {
      const token = this.options.tokenStore.get();
      if (!token) {
        this.unauthenticatedHandler?.("SESSION_EXPIRED");
        throw new ConsoleApiError("SESSION_EXPIRED", 401);
      }
      headers[AUTHORIZATION_HEADER] = `Bearer ${token}`;
    }
    const init: RequestInit = {
      method: spec.method,
      headers,
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
    };
    if (spec.method === "POST") {
      headers["Content-Type"] = "application/json";
      headers[IDEMPOTENCY_HEADER] = args.idempotencyKey ?? newIdempotencyKey();
      init.body = JSON.stringify(args.body ?? {});
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}${buildQueryString(args.query)}`, init);
    } catch {
      throw new ConsoleApiError("NETWORK_UNAVAILABLE", 0, null, true);
    }

    const payload = await readJson(response);
    if (!response.ok) {
      const error = errorFromBody(payload, response.status);
      if (response.status === 401) {
        this.options.tokenStore.clear();
        this.unauthenticatedHandler?.(error.reasonCode);
      }
      throw error;
    }
    if (payload === undefined || payload === null || typeof payload !== "object") {
      throw new ConsoleApiError("RESPONSE_MALFORMED", response.status);
    }
    return payload as ResponseOf<K>;
  }
}

async function readJson(response: Response): Promise<unknown> {
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) return undefined;
  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
}

const STATUS_FALLBACK: Readonly<Record<number, string>> = {
  400: "VALIDATION_FAILED",
  401: "UNAUTHENTICATED",
  403: "STAFF_ROLE_NOT_PERMITTED",
  404: "NOT_FOUND",
  409: "STATE_CONFLICT",
  429: "RATE_LIMITED",
  503: "SERVICE_UNAVAILABLE",
};

/** Keeps only the reason code, correlation id and retryable flag from an error body. */
function errorFromBody(payload: unknown, status: number): ConsoleApiError {
  const fallback = STATUS_FALLBACK[status] ?? (status >= 500 ? "SERVER_ERROR" : "REQUEST_FAILED");
  if (!payload || typeof payload !== "object" || !("error" in payload)) return new ConsoleApiError(fallback, status);
  const body = (payload as { error: unknown }).error;
  if (!body || typeof body !== "object") return new ConsoleApiError(fallback, status);
  const { reasonCode, correlationId, retryable } = body as Record<string, unknown>;
  const code = typeof reasonCode === "string" && REASON_RE.test(reasonCode) ? reasonCode : fallback;
  const corr = typeof correlationId === "string" && OPAQUE_RE.test(correlationId) ? correlationId : null;
  return new ConsoleApiError(code, status, corr, retryable === true);
}
