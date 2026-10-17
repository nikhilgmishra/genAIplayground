/**
 * EMULATED CONTRACT TEST FIXTURE — a 127.0.0.1 node:http server that reproduces
 * the DOCUMENTED Salesforce REST responses the live adapter depends on
 * (OAuth 2.0 client credentials token endpoint; sObject upsert / retrieve by
 * external ID [S23]). It is NOT Salesforce, NOT a sandbox, and its results are
 * NOT sandbox evidence. Records are SYNTHETIC and held in memory.
 *
 * Emulated behaviour:
 *  - POST /services/oauth2/token (form): grant_type=client_credentials with the
 *    configured client id/secret -> 200 {access_token, instance_url, token_type,
 *    issued_at, ...}; otherwise 400 {error:"invalid_client"};
 *  - PATCH /services/data/{v}/sobjects/{SObject}/{Field}/{Value}: 401 without a
 *    valid bearer token; 400 if the body repeats the external id field or a
 *    related-record external id does not exist; 300 when the value matches
 *    several records; 201 {id, success, errors, created:true} when created;
 *    200 {created:false} (or 204 when configured) when updated;
 *  - GET the same path (?fields=): 200 with the requested fields, 404 when absent;
 *  - every API response carries `Sforce-Limit-Info: api-usage=N/LIMIT`;
 *  - scripted one-shot overrides: any status/body, "hang" (never respond),
 *    "apply_then_hang" (apply the write, never respond — timeout after commit),
 *    "destroy" (drop the connection before processing).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

export const SALESFORCE_EMULATOR_LABEL = "EMULATED CONTRACT TEST — documented Salesforce REST responses; not sandbox evidence";

export interface EmulatedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  authorization: string | null;
  contentType: string | null;
  body: string;
}

export type ScriptedResponse =
  | { status: number; body?: unknown; headers?: Record<string, string> }
  | { action: "hang" | "apply_then_hang" | "destroy" };

export interface ScriptRule {
  method?: string;
  pathIncludes?: string;
  times?: number;
  response: ScriptedResponse;
}

export interface SalesforceEmulatorOptions {
  clientId: string;
  clientSecret: string;
  apiVersion: string;
  /** Status for an update: 200 (API 46.0+) or 204 (older API versions). */
  updateStatus?: 200 | 204;
  /** Seconds; omitted from the token response when null (Salesforce may omit it). */
  tokenExpiresIn?: number | null;
  /** Overrides instance_url in the token response (to test the adapter's origin check). */
  instanceUrlOverride?: string;
  apiLimit?: number;
}

interface StoredRecord {
  id: string;
  fields: Record<string, unknown>;
}

const ID_PREFIX: Record<string, string> = { Case: "500" };

export class SalesforceRestEmulator {
  readonly label = SALESFORCE_EMULATOR_LABEL;
  readonly requests: EmulatedRequest[] = [];
  /** sobject -> record id -> record */
  readonly records = new Map<string, Map<string, StoredRecord>>();
  private readonly validTokens = new Set<string>();
  private readonly rules: (ScriptRule & { used: number })[] = [];
  private readonly multiMatch = new Set<string>();
  private readonly sockets = new Set<Socket>();
  private readonly hanging = new Set<ServerResponse>();
  private tokenCounter = 0;
  private idCounter = 0;
  private apiCalls = 0;
  private constructor(
    private readonly server: Server,
    private readonly opts: SalesforceEmulatorOptions,
    readonly origin: string,
  ) {}

  static async start(opts: SalesforceEmulatorOptions): Promise<SalesforceRestEmulator> {
    let emulator: SalesforceRestEmulator | null = null;
    const server = createServer((req, res) => {
      void emulator?.handle(req, res);
    });
    server.on("connection", (s) => {
      emulator?.sockets.add(s);
      s.on("close", () => emulator?.sockets.delete(s));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (addr === null || typeof addr === "string") throw new Error("EMULATOR_ADDRESS_UNAVAILABLE");
    emulator = new SalesforceRestEmulator(server, opts, `http://127.0.0.1:${addr.port}`);
    return emulator;
  }

  async close(): Promise<void> {
    for (const r of this.hanging) r.destroy();
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  script(rule: ScriptRule): void {
    this.rules.push({ ...rule, used: 0 });
  }

  /** Every issued token becomes invalid (session expired / revoked). */
  revokeTokens(): void {
    this.validTokens.clear();
  }

  /** The external id value matches several records (300 Multiple Choices). */
  forceMultipleMatches(sobject: string, field: string, value: string): void {
    this.multiMatch.add(`${sobject}|${field}|${value}`);
  }

  get tokenRequests(): number {
    return this.requests.filter((r) => r.path === "/services/oauth2/token").length;
  }

  recordsOf(sobject: string): StoredRecord[] {
    return [...(this.records.get(sobject)?.values() ?? [])].map((r) => structuredClone(r));
  }

  findByExternalId(sobject: string, field: string, value: string): StoredRecord[] {
    return this.recordsOf(sobject).filter((r) => r.fields[field] === value);
  }

  // ---------------------------------------------------------------- internals

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    const url = new URL(req.url ?? "/", this.origin);
    const request: EmulatedRequest = {
      method: req.method ?? "GET",
      path: decodeURIComponent(url.pathname),
      query: Object.fromEntries(url.searchParams.entries()),
      authorization: req.headers.authorization ?? null,
      contentType: req.headers["content-type"] ?? null,
      body,
    };
    this.requests.push(request);

    const rule = this.rules.find(
      (r) => r.used < (r.times ?? 1) && (r.method === undefined || r.method === request.method) && (r.pathIncludes === undefined || request.path.includes(r.pathIncludes)),
    );
    if (rule) {
      rule.used += 1;
      const s = rule.response;
      if ("action" in s) {
        if (s.action === "destroy") {
          req.socket.destroy();
          return;
        }
        if (s.action === "apply_then_hang") this.route(request);
        this.hanging.add(res);
        return;
      }
      this.send(res, s.status, s.body, s.headers);
      return;
    }
    const r = this.route(request);
    this.send(res, r.status, r.body, r.headers);
  }

  private route(req: EmulatedRequest): { status: number; body?: unknown; headers?: Record<string, string> } {
    if (req.path === "/services/oauth2/token" && req.method === "POST") return this.token(req);
    const m = /^\/services\/data\/(v[^/]+)\/sobjects\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(req.path);
    if (!m) return { status: 404, body: [{ errorCode: "NOT_FOUND", message: "The requested resource does not exist" }] };
    const [, version, sobject, field, value] = m as unknown as [string, string, string, string, string];
    const token = /^Bearer (.+)$/.exec(req.authorization ?? "")?.[1];
    if (!token || !this.validTokens.has(token)) return { status: 401, body: [{ errorCode: "INVALID_SESSION_ID", message: "Session expired or invalid" }] };
    this.apiCalls += 1;
    const limit = { "Sforce-Limit-Info": `api-usage=${this.apiCalls}/${this.opts.apiLimit ?? 15000}` };
    if (version !== this.opts.apiVersion) return { status: 404, body: [{ errorCode: "NOT_FOUND", message: "The requested resource does not exist" }], headers: limit };
    const matches: StoredRecord[] = this.multiMatch.has(`${sobject}|${field}|${value}`)
      ? [
          { id: "multi1", fields: {} },
          { id: "multi2", fields: {} },
        ]
      : this.recordsOf(sobject).filter((r) => r.fields[field] === value);
    if (matches.length > 1) {
      return { status: 300, body: matches.map((r) => `/services/data/${version}/sobjects/${sobject}/${r.id}`), headers: limit };
    }
    if (req.method === "GET") {
      const rec = matches[0];
      if (!rec) return { status: 404, body: [{ errorCode: "NOT_FOUND", message: "The requested resource does not exist" }], headers: limit };
      const wanted = (req.query.fields ?? "").split(",").filter(Boolean);
      const out: Record<string, unknown> = { attributes: { type: sobject, url: `/services/data/${version}/sobjects/${sobject}/${rec.id}` } };
      for (const f of wanted.length ? wanted : ["Id", ...Object.keys(rec.fields)]) out[f] = f === "Id" ? rec.id : (rec.fields[f] ?? null);
      return { status: 200, body: out, headers: limit };
    }
    if (req.method !== "PATCH") return { status: 405, body: [{ errorCode: "METHOD_NOT_ALLOWED" }], headers: limit };
    if (!(req.contentType ?? "").startsWith("application/json")) return { status: 415, body: [{ errorCode: "UNSUPPORTED_MEDIA_TYPE" }], headers: limit };
    let parsed: unknown;
    try {
      parsed = JSON.parse(req.body);
    } catch {
      return { status: 400, body: [{ errorCode: "JSON_PARSER_ERROR" }], headers: limit };
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { status: 400, body: [{ errorCode: "JSON_PARSER_ERROR" }], headers: limit };
    const fields = parsed as Record<string, unknown>;
    if (field in fields) return { status: 400, body: [{ errorCode: "INVALID_FIELD", message: "external id field in body" }], headers: limit };
    // Related records referenced by external id must exist.
    for (const v of Object.values(fields)) {
      if (typeof v === "object" && v !== null && !Array.isArray(v)) {
        const [[refField, refValue] = []] = Object.entries(v as Record<string, unknown>);
        const exists = [...this.records.values()].some((byId) => [...byId.values()].some((r) => refField !== undefined && r.fields[refField] === refValue));
        if (!exists) return { status: 400, body: [{ errorCode: "INVALID_FIELD", message: "Foreign key external ID not found" }], headers: limit };
      }
    }
    const existing = matches[0];
    if (existing) {
      const stored = this.records.get(sobject)?.get(existing.id);
      if (stored) Object.assign(stored.fields, fields);
      if ((this.opts.updateStatus ?? 200) === 204) return { status: 204, headers: limit };
      return { status: 200, body: { id: existing.id, success: true, errors: [], created: false }, headers: limit };
    }
    const id = `${ID_PREFIX[sobject] ?? "a0E"}EMU${String(++this.idCounter).padStart(12, "0")}`;
    let byId = this.records.get(sobject);
    if (!byId) {
      byId = new Map();
      this.records.set(sobject, byId);
    }
    byId.set(id, { id, fields: { ...fields, [field]: value } });
    return { status: 201, body: { id, success: true, errors: [], created: true }, headers: limit };
  }

  private token(req: EmulatedRequest): { status: number; body: unknown } {
    const form = new URLSearchParams(req.body);
    if (!(req.contentType ?? "").startsWith("application/x-www-form-urlencoded")) return { status: 400, body: { error: "invalid_request" } };
    if (form.get("grant_type") !== "client_credentials") return { status: 400, body: { error: "unsupported_grant_type" } };
    if (form.get("client_id") !== this.opts.clientId || form.get("client_secret") !== this.opts.clientSecret) {
      return { status: 400, body: { error: "invalid_client", error_description: "invalid client credentials" } };
    }
    const accessToken = `00DEMULATED!token${++this.tokenCounter}`;
    this.validTokens.add(accessToken);
    const body: Record<string, unknown> = {
      access_token: accessToken,
      instance_url: this.opts.instanceUrlOverride ?? this.origin,
      id: `${this.origin}/id/00DEMULATED/005EMULATED`,
      token_type: "Bearer",
      issued_at: "1760713200000",
      signature: "ZW11bGF0ZWQ=",
      scope: "api",
    };
    if (this.opts.tokenExpiresIn !== undefined && this.opts.tokenExpiresIn !== null) body.expires_in = this.opts.tokenExpiresIn;
    return { status: 200, body };
  }

  private send(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
    if (status === 204 || body === undefined) {
      res.writeHead(status, headers);
      res.end();
      return;
    }
    res.writeHead(status, { "content-type": "application/json;charset=UTF-8", ...headers });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  }
}
