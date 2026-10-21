/**
 * EMULATED vendor API for the connector runtime (WP-06): a protocol-level emulator of a documented-style
 * REST vendor (OAuth 2.0 token endpoint, paginated reads, a list-style lookup by external id, upsert by
 * external id with an idempotency key, a change feed with continuation cursors, JSON Schema metadata,
 * account / region and rate-limit headers), served over real HTTP or HTTPS sockets on 127.0.0.1 (or a
 * private host interface a test names). The connector runtime runs its exact
 * production code against it (FO-06-02): transport, token manager, budgets, pagination, mapping.
 *
 * It is an emulator, not a fake of the runtime: it implements the vendor side of the protocol and
 * records what it received, so tests assert behaviour on the wire (requests counted at the socket,
 * tokens issued, effects applied). Faults are injected at the vendor side:
 *   status / Retry-After responses, hangs (before or after applying a write), connection drops,
 *   redirects, oversized bodies, cursor expiry, token revocation, client-secret rotation, granted-scope
 *   changes, account / region mismatch, filtered change-feed windows (an empty page with an advanced
 *   position), and SCHEMA DRIFT (renamed or retyped fields in records and
 *   metadata: the injection point of fault SCHEMA_DRIFT, whose Layer-2 run is WP-32's).
 * What it does not prove: any real vendor's documented behaviour, quotas, auth policies or schemas
 * (vendor evidence is a sandbox run, Layer 5). SYNTHETIC data only.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import { importSPKI, jwtVerify } from "jose";

export interface EmulatedRecord {
  id: string;
  /** Change-log sequence (1..n): the change feed's position. */
  seq: number;
  status: string;
  startsAt: string;
  durationMinutes: number;
  feeMajor: string;
  clinicalNotes: string;
  updatedAt: string;
}

export type Fault =
  | { kind: "status"; status: number; retryAfter?: string; times: number; body?: unknown }
  | { kind: "hang"; times: number }
  | { kind: "hang_after_apply"; times: number }
  | { kind: "error_after_apply"; status: number; times: number }
  | { kind: "drop"; times: number }
  | { kind: "redirect"; location: string; times: number }
  | { kind: "huge_body"; bytes: number; times: number }
  | { kind: "cursor_expired"; times: number }
  /** Answers normally after `ms` (API requests are counted in flight: concurrency-cap tests; also the token endpoint). */
  | { kind: "delay"; ms: number; times: number };

export interface Drift {
  /** Field of the record or the metadata renamed (old name -> new name). */
  rename?: Record<string, string>;
  /** Field whose JSON type changes (number becomes string, string becomes number). */
  retype?: string[];
  /** Picklist value the vendor starts returning that no enum table maps. */
  newStatusValue?: string;
}

export interface ReceivedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  at: number;
  authorization: "none" | "bearer" | "basic";
  /** sha256 of the bearer token (never the token itself). */
  tokenDigest: string | null;
  idempotencyKey: string | null;
  bodyBytes: number;
  /** Local address of the socket the request arrived on (which interface the client connected to). */
  localAddress: string | null;
}

interface IssuedToken {
  scopes: string[];
  expiresAtMs: number;
  revoked: boolean;
  clientId: string;
}

export interface EmulatorOptions {
  tls?: { cert: string; key: string };
  /** Address the emulator listens on (default 127.0.0.1; a test may bind a private host interface). */
  host?: string;
  /** Accepted client credentials (client id -> secret); rotate with acceptSecret. */
  clients?: Record<string, string>;
  /** Registered private_key_jwt public keys (client id -> SPKI PEM and algorithm). */
  jwtClients?: Record<string, { pem: string; alg: "ES256" | "RS256" | "PS256" }>;
  tokenExpiresIn?: number;
  accountId?: string;
  region?: string;
  /** Rate limit the emulator enforces itself (requests per second, sliding 1 s window); 0 = none. */
  vendorRateLimitPerSecond?: number;
  rateLimitHeaderLimit?: number;
  records?: number;
  /** Scopes each OAuth client may be granted (requested scopes outside them are not granted). */
  clientScopes?: Record<string, string[]>;
  /** Issuers whose self-signed bearer JWTs the API accepts (SIGNED_JWT_BEARER schemes). */
  bearerJwtIssuers?: Record<string, { pem: string; alg: "ES256" | "RS256" | "PS256"; audience: string }>;
  /** API keys accepted in the `x-api-key` header (API_KEY_HEADER schemes). */
  apiKeys?: string[];
}

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...headers });
  res.end(text);
};

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function synthRecord(i: number): EmulatedRecord {
  const day = String((i % 27) + 1).padStart(2, "0");
  return {
    id: `apt-${String(i).padStart(5, "0")}`,
    seq: i,
    status: ["booked", "cancelled", "completed"][i % 3] ?? "booked",
    startsAt: `2026-11-${day}T15:30:00Z`,
    durationMinutes: 30 + (i % 3) * 15,
    feeMajor: `${40 + (i % 5)}.50`,
    clinicalNotes: "SYNTHETIC restricted note",
    updatedAt: `2026-10-${String((i % 18) + 1).padStart(2, "0")}T08:00:00Z`,
  };
}

export class VendorEmulator {
  readonly records: EmulatedRecord[] = [];
  readonly received: ReceivedRequest[] = [];
  /** Upserts actually applied (external id -> times applied); an idempotent replay does not add one. */
  readonly applied = new Map<string, number>();
  readonly tokens = new Map<string, IssuedToken>();
  tokenRequests = 0;
  /** API requests the vendor's own rate limiter answered 429 (vendorRateLimitPerSecond). */
  rateLimitedResponses = 0;
  /** Outcome of every token request in order: "issued:<clientId>" or "invalid_client:<clientId>". */
  readonly tokenOutcomes: string[] = [];
  /** Scope behaviour of the token endpoint: echo the requested scopes, add one, drop one, omit the field. */
  scopeMode: "echo" | "broader" | "narrower" | "omit" = "echo";
  accountId: string;
  region: string;
  /** Account / region the token response and headers report (default: the emulator's own). */
  reportAccountId: string | null = null;
  reportRegion: string | null = null;
  drift: Drift = {};
  /**
   * Change-log sequences the feed consumes but does not serve (changes the client may not see, or
   * tombstones the vendor filters): a page whose whole window is filtered is empty yet carries an advanced
   * position, the way filtered change feeds and sync-token APIs answer.
   */
  readonly feedFiltered = new Set<number>();
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  private readonly faults = new Map<string, Fault[]>();
  private readonly idempotency = new Map<string, string>();
  /** Accepted client secrets per client id (two during a rotation overlap). */
  private clients: Map<string, string[]>;
  private readonly jwtClients: Map<string, { pem: string; alg: "ES256" | "RS256" | "PS256" }>;
  private readonly opts: EmulatorOptions;
  private hangs: ServerResponse[] = [];
  /** API requests currently being handled, and the most seen at once (concurrency caps). */
  inFlight = 0;
  maxInFlight = 0;

  constructor(opts: EmulatorOptions = {}) {
    this.opts = opts;
    this.clients = new Map(Object.entries(opts.clients ?? { "client-read": "secret-read-v1", "client-write": "secret-write-v1" }).map(([id, secret]) => [id, [secret]]));
    this.jwtClients = new Map(Object.entries(opts.jwtClients ?? {}));
    this.accountId = opts.accountId ?? "acct-emulated-001";
    this.region = opts.region ?? "us-east-1";
    for (let i = 1; i <= (opts.records ?? 23); i += 1) this.records.push(synthRecord(i));
  }

  get port(): number {
    return (this.server?.address() as AddressInfo).port;
  }

  async start(): Promise<this> {
    const handler = (req: IncomingMessage, res: ServerResponse) => {
      void this.handle(req, res).catch(() => {
        if (!res.headersSent) json(res, 500, { error: "emulator_error" });
        else res.destroy();
      });
    };
    this.server = this.opts.tls ? createHttpsServer({ cert: this.opts.tls.cert, key: this.opts.tls.key }, handler) : createHttpServer(handler);
    this.server.on("connection", (s: Socket) => {
      this.sockets.add(s);
      s.on("close", () => this.sockets.delete(s));
    });
    await new Promise<void>((resolve) => this.server?.listen(0, this.opts.host ?? "127.0.0.1", resolve));
    return this;
  }

  async stop(): Promise<void> {
    for (const r of this.hangs) r.destroy();
    this.hangs = [];
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }

  /** Queues a fault for requests whose `METHOD path` starts with `route` (e.g. "GET /api/v1/appointments"). */
  inject(route: string, fault: Fault): this {
    this.faults.set(route, [...(this.faults.get(route) ?? []), fault]);
    return this;
  }

  clearFaults(): void {
    this.faults.clear();
  }

  /** Vendor-side rotation: only `secret` authenticates `clientId` from now on. */
  acceptSecret(clientId: string, secret: string): void {
    this.clients.set(clientId, [secret]);
  }

  /** Vendor-side rotation overlap (a vendor that allows two active client secrets): `secret` is accepted too. */
  addSecret(clientId: string, secret: string): void {
    this.clients.set(clientId, [...(this.clients.get(clientId) ?? []), secret]);
  }

  /** Vendor-side revocation of every issued token (API calls then answer 401). */
  revokeAllTokens(): void {
    for (const t of this.tokens.values()) t.revoked = true;
  }

  /**
   * Largest number of API requests that arrived within any window of `windowMs` (the vendor's view),
   * counting only requests that arrived at or after `fromMs` (epoch ms; default: all).
   */
  maxApiRequestsInWindow(windowMs = 1_000, pathPrefix = "/api/", fromMs = 0): number {
    const at = this.received.filter((r) => r.path.startsWith(pathPrefix) && r.at >= fromMs).map((r) => r.at).sort((a, b) => a - b);
    let best = 0;
    for (let i = 0, j = 0; i < at.length; i += 1) {
      while ((at[i] ?? 0) - (at[j] ?? 0) >= windowMs) j += 1;
      best = Math.max(best, i - j + 1);
    }
    return best;
  }

  requestsTo(method: string, pathPrefix: string): ReceivedRequest[] {
    return this.received.filter((r) => r.method === method && r.path.startsWith(pathPrefix));
  }

  private takeFault(method: string, path: string): Fault | null {
    for (const [route, list] of this.faults) {
      if (!`${method} ${path}`.startsWith(route)) continue;
      const f = list[0];
      if (!f) continue;
      f.times -= 1;
      if (f.times <= 0) list.shift();
      return f;
    }
    return null;
  }

  private async body(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  }

  private rateLimited(now: number): boolean {
    const limit = this.opts.vendorRateLimitPerSecond ?? 0;
    if (limit <= 0) return false;
    return this.received.filter((r) => r.path.startsWith("/api/") && now - r.at < 1_000).length > limit;
  }

  private headers(): Record<string, string> {
    const limit = this.opts.rateLimitHeaderLimit ?? 1_000;
    const used = this.received.filter((r) => r.path.startsWith("/api/")).length;
    return {
      "x-account-id": this.reportAccountId ?? this.accountId,
      "x-region": this.reportRegion ?? this.region,
      "ratelimit-limit": String(limit),
      "ratelimit-remaining": String(Math.max(0, limit - used)),
    };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://emulator.invalid");
    const body = await this.body(req);
    const auth = req.headers.authorization ?? "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    const now = Date.now();
    this.received.push({
      method: req.method ?? "GET",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      at: now,
      authorization: bearer ? "bearer" : auth.startsWith("Basic ") ? "basic" : "none",
      tokenDigest: bearer ? sha(bearer) : null,
      idempotencyKey: typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"] : null,
      bodyBytes: body.length,
      localAddress: req.socket.localAddress ?? null,
    });
    const method = req.method ?? "GET";
    if (url.pathname === "/oauth/token" && method === "POST") return this.token(req, res, body);

    const fault = this.takeFault(method, url.pathname);
    if (fault?.kind === "hang") {
      this.hangs.push(res);
      return;
    }
    if (fault?.kind === "drop") {
      req.socket.destroy();
      return;
    }
    if (fault?.kind === "status") {
      // A scripted success still carries the vendor's account / region / usage headers.
      return json(res, fault.status, fault.body ?? { error: "injected" }, { ...(fault.status < 300 ? this.headers() : {}), ...(fault.retryAfter ? { "retry-after": fault.retryAfter } : {}) });
    }
    if (fault?.kind === "redirect") {
      res.writeHead(302, { location: fault.location, "content-length": "0" });
      res.end();
      return;
    }
    if (fault?.kind === "huge_body") {
      const blob = "x".repeat(fault.bytes);
      return json(res, 200, { items: [], blob });
    }

    // API: an issued bearer token (not revoked, not expired), a valid self-signed bearer JWT, or an API key.
    let t = bearer ? this.tokens.get(sha(bearer)) : undefined;
    if (!t && bearer && bearer.split(".").length === 3) t = await this.verifyBearerJwt(bearer);
    const apiKey = req.headers["x-api-key"];
    if (!t && typeof apiKey === "string" && (this.opts.apiKeys ?? []).includes(apiKey)) t = { scopes: ["appointments:read", "appointments:write"], expiresAtMs: now + 60_000, revoked: false, clientId: "api-key" };
    if (!t || t.revoked || t.expiresAtMs <= now) return json(res, 401, { error: "invalid_token" });
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    res.once("close", () => {
      this.inFlight -= 1;
    });
    if (fault?.kind === "delay") await new Promise((r) => setTimeout(r, fault.ms));
    if (this.rateLimited(now)) {
      this.rateLimitedResponses += 1;
      return json(res, 429, { error: "rate_limited" }, { "retry-after": "1" });
    }

    if (method === "GET" && url.pathname === "/api/v1/metadata/appointments") return json(res, 200, this.metadata(), this.headers());
    if (method === "GET" && url.pathname === "/api/v1/appointments") {
      if (!t.scopes.includes("appointments:read")) return json(res, 403, { error: "insufficient_scope" });
      if (fault?.kind === "cursor_expired") return json(res, 410, { error: "cursor_expired" });
      // List-style lookup by external id (a query that answers 200 with the matching records, possibly none).
      const externalId = url.searchParams.get("externalId");
      if (externalId !== null) {
        const hits = this.records.filter((r) => r.id === externalId).map((r) => this.wire(r));
        return json(res, 200, { items: hits, nextCursor: null }, this.headers());
      }
      const limit = Math.min(Number(url.searchParams.get("limit") ?? "10"), 100);
      const start = Number(url.searchParams.get("cursor") ?? "0");
      if (!Number.isInteger(start) || start < 0) return json(res, 400, { error: "bad_cursor" });
      const page = this.records.slice(start, start + limit).map((r) => this.wire(r));
      const next = start + limit < this.records.length ? String(start + limit) : null;
      return json(res, 200, { items: page, nextCursor: next }, this.headers());
    }
    if (method === "GET" && url.pathname === "/api/v1/changes") {
      if (!t.scopes.includes("appointments:read")) return json(res, 403, { error: "insufficient_scope" });
      const after = Number(url.searchParams.get("cursor") ?? "0");
      const limit = Math.min(Number(url.searchParams.get("limit") ?? "5"), 100);
      const window = this.records.filter((r) => r.seq > after).slice(0, limit);
      const page = window.filter((r) => !this.feedFiltered.has(r.seq));
      // A change feed always returns a continuation position: the last sequence consumed (or the request's).
      const position = window.length > 0 ? String(window[window.length - 1]?.seq) : String(after);
      return json(res, 200, { items: page.map((r) => this.wire(r)), nextCursor: position }, this.headers());
    }
    const one = /^\/api\/v1\/appointments\/([A-Za-z0-9_-]{1,64})$/.exec(url.pathname);
    if (one?.[1] && method === "GET") {
      if (!t.scopes.includes("appointments:read")) return json(res, 403, { error: "insufficient_scope" });
      const r = this.records.find((x) => x.id === one[1]);
      return r ? json(res, 200, this.wire(r), this.headers()) : json(res, 404, { error: "not_found" }, this.headers());
    }
    if (one?.[1] && method === "PUT") {
      if (!t.scopes.includes("appointments:write")) return json(res, 403, { error: "insufficient_scope" });
      const key = typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"] : null;
      if (!key) return json(res, 400, { error: "idempotency_key_required" });
      const digest = sha(body.toString("utf8"));
      const prior = this.idempotency.get(key);
      if (prior !== undefined && prior !== digest) return json(res, 409, { error: "idempotency_key_reused" });
      const id = one[1];
      if (prior === undefined) {
        this.idempotency.set(key, digest);
        this.applied.set(id, (this.applied.get(id) ?? 0) + 1);
        let parsed: Partial<EmulatedRecord>;
        try {
          parsed = JSON.parse(body.toString("utf8")) as Partial<EmulatedRecord>;
        } catch {
          return json(res, 400, { error: "bad_json" });
        }
        const existing = this.records.find((x) => x.id === id);
        if (existing) Object.assign(existing, { status: parsed.status ?? existing.status, startsAt: parsed.startsAt ?? existing.startsAt });
        else this.records.push({ ...synthRecord(this.records.length + 1), id, status: parsed.status ?? "booked", startsAt: parsed.startsAt ?? "2026-11-01T15:00:00Z", seq: this.records.length + 1 });
      }
      if (fault?.kind === "hang_after_apply") {
        this.hangs.push(res);
        return;
      }
      if (fault?.kind === "error_after_apply") return json(res, fault.status, { error: "injected_after_apply" });
      const rec = this.records.find((x) => x.id === id);
      return json(res, 200, rec ? this.wire(rec) : {}, this.headers());
    }
    return json(res, 404, { error: "no_route" });
  }

  private async verifyBearerJwt(token: string): Promise<IssuedToken | undefined> {
    for (const [iss, reg] of Object.entries(this.opts.bearerJwtIssuers ?? {})) {
      try {
        const key = await importSPKI(reg.pem, reg.alg);
        const { payload } = await jwtVerify(token, key, { issuer: iss, audience: reg.audience });
        return { scopes: ["appointments:read", "appointments:write"], expiresAtMs: (payload.exp ?? 0) * 1000, revoked: false, clientId: iss };
      } catch {
        // try the next registered issuer
      }
    }
    return undefined;
  }

  /** The record as the vendor serializes it, with drift applied (renamed / retyped fields). */
  private wire(r: EmulatedRecord): Record<string, unknown> {
    const out: Record<string, unknown> = { ...r };
    if (this.drift.newStatusValue) out.status = this.drift.newStatusValue;
    for (const f of this.drift.retype ?? []) {
      const v = out[f];
      out[f] = typeof v === "number" ? String(v) : typeof v === "string" ? 12345 : v;
    }
    for (const [from, to] of Object.entries(this.drift.rename ?? {})) {
      out[to] = out[from];
      delete out[from];
    }
    return out;
  }

  private metadata(): Record<string, unknown> {
    const props: Record<string, Record<string, unknown>> = {
      id: { type: "string" },
      seq: { type: "integer" },
      status: { type: "string", enum: ["booked", "cancelled", "completed", ...(this.drift.newStatusValue ? [this.drift.newStatusValue] : [])] },
      startsAt: { type: "string", format: "date-time" },
      durationMinutes: { type: "integer", "x-unit": "minutes" },
      feeMajor: { type: "string", "x-unit": "major_units" },
      clinicalNotes: { type: "string", "x-vsp-classification": "PHI_RESTRICTED" },
      updatedAt: { type: "string", format: "date-time" },
    };
    for (const f of this.drift.retype ?? []) {
      const p = props[f];
      if (p) props[f] = { ...p, type: p.type === "integer" ? "string" : "integer" };
    }
    for (const [from, to] of Object.entries(this.drift.rename ?? {})) {
      const p = props[from];
      if (p) {
        props[to] = p;
        delete props[from];
      }
    }
    return { $schema: "https://json-schema.org/draft/2020-12/schema", title: "Appointment", type: "object", properties: props, required: ["id", "status", "startsAt"] };
  }

  private async token(req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<void> {
    this.tokenRequests += 1;
    const fault = this.takeFault("POST", "/oauth/token");
    if (fault?.kind === "status") return json(res, fault.status, fault.body ?? { error: "temporarily_unavailable" }, fault.retryAfter ? { "retry-after": fault.retryAfter } : {});
    if (fault?.kind === "hang") {
      this.hangs.push(res);
      return;
    }
    if (fault?.kind === "delay") await new Promise((r) => setTimeout(r, fault.ms));
    const form = new URLSearchParams(body.toString("utf8"));
    if (form.get("grant_type") !== "client_credentials") return json(res, 400, { error: "unsupported_grant_type" });
    let clientId: string;
    const basic = req.headers.authorization?.startsWith("Basic ") ? Buffer.from(req.headers.authorization.slice(6), "base64").toString("utf8") : null;
    if (form.get("client_assertion_type") === "urn:ietf:params:oauth:client-assertion-type:jwt-bearer") {
      const id = form.get("client_id") ?? "";
      const reg = this.jwtClients.get(id);
      if (!reg) return this.rejectClient(res, id);
      try {
        const key = await importSPKI(reg.pem, reg.alg);
        const { payload } = await jwtVerify(form.get("client_assertion") ?? "", key, { issuer: id, subject: id });
        if (typeof payload.jti !== "string") return this.rejectClient(res, id);
        clientId = id;
      } catch {
        return this.rejectClient(res, id);
      }
    } else {
      const [id, secret] = basic ? basic.split(":").map(decodeURIComponent) : [form.get("client_id"), form.get("client_secret")];
      const accepted = id ? (this.clients.get(id) ?? []) : [];
      if (!id || !secret || !accepted.some((x) => x.length === secret.length && timingSafeEqual(Buffer.from(x), Buffer.from(secret)))) {
        return this.rejectClient(res, id ?? "");
      }
      clientId = id;
    }
    const requested = (form.get("scope") ?? "").split(" ").filter((s) => s.length > 0);
    const allowed = this.opts.clientScopes?.[clientId];
    const permitted = allowed ? requested.filter((x) => allowed.includes(x)) : requested;
    const granted = this.scopeMode === "broader" ? [...permitted, "appointments:admin"] : this.scopeMode === "narrower" ? permitted.slice(0, Math.max(0, permitted.length - 1)) : permitted;
    const token = randomBytes(24).toString("base64url");
    const expiresIn = this.opts.tokenExpiresIn ?? 3_600;
    this.tokens.set(sha(token), { scopes: granted, expiresAtMs: Date.now() + expiresIn * 1000, revoked: false, clientId });
    this.tokenOutcomes.push(`issued:${clientId}`);
    return json(res, 200, {
      access_token: token,
      token_type: "Bearer",
      expires_in: expiresIn,
      ...(this.scopeMode === "omit" ? {} : { scope: granted.join(" ") }),
      instance_id: this.reportAccountId ?? this.accountId,
      region: this.reportRegion ?? this.region,
    });
  }

  private rejectClient(res: ServerResponse, clientId: string): void {
    this.tokenOutcomes.push(`invalid_client:${clientId}`);
    json(res, 401, { error: "invalid_client" });
  }
}
