/**
 * Protocol-exact model emulator server (WP-08; FO-16-18, FO-09-36). TEST EMULATOR: never imported by production
 * code (docs/ARCHITECTURE.md 6.4 rule 4). One process serves the three wire protocols the adapters speak, routed by
 * path, keyed by the request's host name (so parallel test files never share state):
 *
 *   POST /v1/responses                     OpenAI Responses SSE (bearer key)
 *   POST /v1/chat/completions              vLLM OpenAI-compatible Chat Completions SSE (bearer key or none)
 *   GET  /v1/models, /health, /version     model listing (OpenAI and vLLM shapes), vLLM liveness and version
 *   POST /model/{modelId}/converse-stream  Bedrock ConverseStream, AWS event stream, SigV4 verified (service bedrock)
 *   GET  /foundation-models                Bedrock control-plane catalogue, SigV4 verified
 *
 * TLS: an HTTPS listener serves per-host certificates (SNI) registered by the test that owns the host name; a plain
 * HTTP listener serves Layer-1 unit runs over the transport's local loopback routes. Credentials (synthetic bearer
 * keys, synthetic AWS key pairs) are registered per host; an unregistered host is refused (401/403), fail closed.
 *
 * Admin API (plain HTTP, loopback only, `/__emulator/*`): register TLS and credentials, queue scripts or the
 * MODEL_REFUSAL / MODEL_HANG / MODEL_OVERLOAD faults for a host, read the request log (content-free: what was asked,
 * whether it was authorized, signed and streamed, whether the client closed the stream early).
 *
 * The admin API is unauthenticated and bound to 127.0.0.1 only: it scripts synthetic responses and holds no data.
 */
import { randomBytes } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { Socket } from "node:net";
import { createSecureContext } from "node:tls";
import type { SecureContext } from "node:tls";
import { verifySigV4 } from "../../../src/models/emulators/sigv4-verify.js";
import { FAULT_SCRIPTS, defaultScript, renderBedrockConverse, renderChatCompletions, renderOpenAiResponses, bedrockHttpError } from "../../../src/models/emulators/scenarios.js";
import type { EmulatedResponse, EmulatorFault, EmulatorScript, RenderInput } from "../../../src/models/emulators/scenarios.js";
import { parseBedrockConverseRequest, parseChatCompletionsRequest, parseOpenAiResponsesRequest } from "../../../src/models/emulators/requests.js";

export type EmulatedApi = "openai_responses" | "chat_completions" | "bedrock_converse" | "bedrock_control" | "models" | "health" | "unknown";

/** One request as the emulator saw it (content-free). */
export interface RequestLogEntry {
  at: string;
  host: string;
  method: string;
  path: string;
  api: EmulatedApi;
  model: string | null;
  authorized: boolean;
  authFailure: string | null;
  /** Bedrock only: SigV4 verified with the registered key pair. */
  sigv4: "VERIFIED" | "REFUSED" | null;
  stream: boolean | null;
  /** OpenAI `store` field as sent (the adapters must send false). */
  store: unknown;
  /** Bedrock only: the request carried a `guardrailConfig` (null for the other APIs). */
  guardrail: boolean | null;
  toolCount: number;
  script: EmulatorScript["kind"] | null;
  status: number;
  framesWritten: number;
  /** The client closed the connection before the response ended (cancellation reached the emulator). */
  clientClosedEarly: boolean;
  completed: boolean;
  /** Header names received (lower case), never values. */
  headerNames: string[];
}

export interface HostCredentials {
  /** Accepted bearer keys, or "none" for a vLLM server without --api-key. */
  bearer?: readonly string[] | "none";
  /** Accepted AWS key pairs (Bedrock SigV4). */
  aws?: readonly { accessKeyId: string; secretAccessKey: string }[];
  region?: string;
  /** Model ids /v1/models and /foundation-models list for this host. */
  models?: readonly string[];
  /** vLLM tool-parser markup used by the tool_markup_leak script. */
  toolMarkup?: string;
}

interface HostState {
  credentials: HostCredentials | null;
  scripts: EmulatorScript[];
  log: RequestLogEntry[];
}

export interface ModelEmulatorOptions {
  /** Plain HTTP listener port (0 = ephemeral; null = none). */
  httpPort?: number | null;
  /** HTTPS listener port (0 = ephemeral; null = none). */
  httpsPort?: number | null;
  /** Admin listener port (0 = ephemeral; null = none, in-process use only). */
  adminPort?: number | null;
  bindAddress?: string;
  /** Delay between written frames (ms), so a stream arrives as a stream. */
  frameDelayMs?: number;
  now?: () => Date;
}

const MAX_BODY = 1_048_576;

function hostOf(req: IncomingMessage): string {
  return (req.headers.host ?? "").toLowerCase().replace(/:\d+$/, "");
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > MAX_BODY) throw new Error("BODY_TOO_LARGE");
    parts.push(c as Buffer);
  }
  return Buffer.concat(parts);
}

export class ModelEmulator {
  private readonly hosts = new Map<string, HostState>();
  private readonly contexts = new Map<string, SecureContext>();
  private readonly servers: Server[] = [];
  private readonly sockets = new Set<Socket>();
  private readonly now: () => Date;
  private httpPortValue: number | null = null;
  private httpsPortValue: number | null = null;
  private adminPortValue: number | null = null;

  constructor(private readonly opts: ModelEmulatorOptions = {}) {
    this.now = opts.now ?? (() => new Date());
  }

  get httpPort(): number {
    if (this.httpPortValue === null) throw new Error("HTTP listener not started");
    return this.httpPortValue;
  }

  get httpsPort(): number {
    if (this.httpsPortValue === null) throw new Error("HTTPS listener not started");
    return this.httpsPortValue;
  }

  get adminPort(): number {
    if (this.adminPortValue === null) throw new Error("admin listener not started");
    return this.adminPortValue;
  }

  async start(): Promise<this> {
    const bind = this.opts.bindAddress ?? "127.0.0.1";
    const track = (s: Server) => {
      s.on("connection", (sock: Socket) => {
        this.sockets.add(sock);
        sock.on("close", () => this.sockets.delete(sock));
      });
      this.servers.push(s);
    };
    const listen = (s: Server, port: number) =>
      new Promise<number>((resolve, reject) => {
        s.once("error", reject);
        s.listen(port, bind, () => {
          const a = s.address();
          resolve(typeof a === "object" && a ? a.port : port);
        });
      });
    if (this.opts.httpPort !== null) {
      const s = createHttpServer((req, res) => void this.serve(req, res));
      track(s);
      this.httpPortValue = await listen(s, this.opts.httpPort ?? 0);
    }
    if (this.opts.httpsPort !== undefined && this.opts.httpsPort !== null) {
      const fallback = selfContextPlaceholder();
      const s = createHttpsServer(
        {
          SNICallback: (servername, cb) => {
            const ctx = this.contexts.get(servername.toLowerCase());
            if (ctx) cb(null, ctx);
            else cb(new Error("UNKNOWN_SERVERNAME"), fallback);
          },
        },
        (req, res) => void this.serve(req, res),
      );
      track(s);
      this.httpsPortValue = await listen(s, this.opts.httpsPort);
    }
    if (this.opts.adminPort !== undefined && this.opts.adminPort !== null) {
      const s = createHttpServer((req, res) => void this.admin(req, res));
      track(s);
      this.adminPortValue = await listen(s, this.opts.adminPort);
    }
    return this;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await Promise.all(this.servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
    this.servers.length = 0;
  }

  /* ---------------------------------------------------------------- control */

  private state(host: string): HostState {
    let s = this.hosts.get(host);
    if (!s) {
      s = { credentials: null, scripts: [], log: [] };
      this.hosts.set(host, s);
    }
    return s;
  }

  addTlsContext(servername: string, cert: string, key: string): void {
    this.contexts.set(servername.toLowerCase(), createSecureContext({ cert, key }));
  }

  registerHost(host: string, credentials: HostCredentials): void {
    this.state(host.toLowerCase()).credentials = credentials;
  }

  queue(host: string, ...scripts: EmulatorScript[]): void {
    this.state(host.toLowerCase()).scripts.push(...scripts);
  }

  /** Fault injection seam (FO-17-24: MODEL_REFUSAL, MODEL_HANG, MODEL_OVERLOAD) for the next `count` requests. */
  injectFault(host: string, fault: EmulatorFault, count = 1, override: Partial<EmulatorScript> = {}): void {
    const script = { ...FAULT_SCRIPTS[fault], ...override } as EmulatorScript;
    for (let i = 0; i < count; i += 1) this.queue(host, script);
  }

  requests(host: string): RequestLogEntry[] {
    return [...(this.hosts.get(host.toLowerCase())?.log ?? [])];
  }

  clear(host: string): void {
    this.hosts.delete(host.toLowerCase());
  }

  /* ---------------------------------------------------------------- serving */

  private async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = hostOf(req);
    const url = new URL(req.url ?? "/", "http://emulator.invalid");
    const path = url.pathname;
    const st = this.state(host);
    const entry: RequestLogEntry = {
      at: this.now().toISOString(),
      host,
      method: req.method ?? "",
      path: req.url ?? "/",
      api: "unknown",
      model: null,
      authorized: false,
      authFailure: null,
      sigv4: null,
      stream: null,
      store: undefined,
      guardrail: null,
      toolCount: 0,
      script: null,
      status: 0,
      framesWritten: 0,
      clientClosedEarly: false,
      completed: false,
      headerNames: Object.keys(req.headers).sort(),
    };
    st.log.push(entry);
    let body: Buffer;
    try {
      body = await readBody(req);
    } catch {
      return this.write(res, entry, { status: 413, headers: { "content-type": "application/json" }, frames: [Buffer.from("{}")], stallAfterFrames: null, stallBeforeHead: false });
    }
    const creds = st.credentials;
    const bedrockModel = /^\/model\/([^/]+)\/converse-stream$/.exec(path);
    if (bedrockModel || path === "/foundation-models") {
      entry.api = bedrockModel ? "bedrock_converse" : "bedrock_control";
      const secrets = new Map((creds?.aws ?? []).map((k) => [k.accessKeyId, k.secretAccessKey] as const));
      const v = verifySigV4({
        method: req.method ?? "",
        rawPath: path === url.pathname ? (req.url ?? "/").split("?")[0] ?? "/" : path,
        rawQuery: (req.url ?? "").includes("?") ? (req.url ?? "").slice((req.url ?? "").indexOf("?") + 1) : "",
        headers: Object.fromEntries(Object.entries(req.headers).map(([k, val]) => [k, Array.isArray(val) ? val.join(",") : (val ?? "")])),
        body,
        now: this.now(),
        secrets,
        region: creds?.region ?? "us-east-1",
        service: "bedrock",
      });
      entry.sigv4 = v.valid ? "VERIFIED" : "REFUSED";
      if (!v.valid) {
        entry.authFailure = v.reason;
        const exception = v.reason === "UNKNOWN_ACCESS_KEY" ? "UnrecognizedClientException" : "InvalidSignatureException";
        return this.write(res, entry, bedrockHttpError(403, exception, "The request signature we calculated does not match the signature you provided (emulated)."));
      }
      entry.authorized = true;
      if (!bedrockModel) {
        const models = (creds?.models ?? []).map((id) => ({ modelArn: `arn:aws:bedrock:${creds?.region ?? "us-east-1"}::foundation-model/${id}`, modelId: id, modelName: id, providerName: "Emulator", inputModalities: ["TEXT"], outputModalities: ["TEXT"], responseStreamingSupported: true, customizationsSupported: [], inferenceTypesSupported: ["ON_DEMAND"], modelLifecycle: { status: "ACTIVE" } }));
        return this.write(res, entry, { status: 200, headers: { "content-type": "application/json" }, frames: [Buffer.from(JSON.stringify({ modelSummaries: models }))], stallAfterFrames: null, stallBeforeHead: false });
      }
      const modelId = decodeURIComponent(bedrockModel[1] ?? "");
      entry.model = modelId;
      const parsed = parseBedrockConverseRequest(modelId, safeJson(body), body.length);
      if (!parsed.ok) return this.write(res, entry, bedrockHttpError(400, "ValidationException", parsed.message));
      entry.stream = true;
      entry.toolCount = parsed.input.tools.length;
      entry.guardrail = parsed.input.guardrail;
      return this.respond(res, entry, st, parsed.input, (s, input) => renderBedrockConverse(s, input));
    }
    // Bearer-authenticated APIs (OpenAI Responses, vLLM Chat Completions, model listing).
    if (path === "/health") {
      entry.api = "health";
      entry.authorized = true;
      return this.write(res, entry, { status: 200, headers: {}, frames: [], stallAfterFrames: null, stallBeforeHead: false });
    }
    const auth = req.headers.authorization ?? "";
    const bearer = creds?.bearer;
    const ok = bearer === "none" || (Array.isArray(bearer) && bearer.some((k) => auth === `Bearer ${k}`));
    if (!ok) {
      entry.authFailure = creds === null ? "HOST_NOT_REGISTERED" : auth === "" ? "MISSING_AUTHORIZATION" : "KEY_REJECTED";
      return this.write(res, entry, { status: 401, headers: { "content-type": "application/json" }, frames: [Buffer.from(JSON.stringify({ error: { message: "Incorrect API key provided (emulated).", type: "invalid_request_error", param: null, code: "invalid_api_key" } }))], stallAfterFrames: null, stallBeforeHead: false });
    }
    entry.authorized = true;
    if (path === "/v1/models" && req.method === "GET") {
      entry.api = "models";
      const data = (creds?.models ?? []).map((id) => ({ id, object: "model", created: 1_760_000_000, owned_by: "emulator", root: id, parent: null, max_model_len: 32_768 }));
      return this.write(res, entry, { status: 200, headers: { "content-type": "application/json" }, frames: [Buffer.from(JSON.stringify({ object: "list", data }))], stallAfterFrames: null, stallBeforeHead: false });
    }
    if (path === "/version" && req.method === "GET") {
      entry.api = "health";
      return this.write(res, entry, { status: 200, headers: { "content-type": "application/json" }, frames: [Buffer.from(JSON.stringify({ version: "emulated" }))], stallAfterFrames: null, stallBeforeHead: false });
    }
    if (path === "/v1/responses" && req.method === "POST") {
      entry.api = "openai_responses";
      const parsed = parseOpenAiResponsesRequest(safeJson(body), body.length);
      if (!parsed.ok) return this.write(res, entry, { status: parsed.status, headers: { "content-type": "application/json" }, frames: [Buffer.from(JSON.stringify({ error: { message: parsed.message, type: "invalid_request_error", param: null, code: null } }))], stallAfterFrames: null, stallBeforeHead: false });
      entry.model = parsed.input.model;
      entry.stream = parsed.stream;
      entry.store = parsed.store;
      entry.toolCount = parsed.input.tools.length;
      return this.respond(res, entry, st, parsed.input, (s, input) => renderOpenAiResponses(s, input));
    }
    if (path === "/v1/chat/completions" && req.method === "POST") {
      entry.api = "chat_completions";
      const parsed = parseChatCompletionsRequest(safeJson(body), body.length);
      if (!parsed.ok) return this.write(res, entry, { status: 400, headers: { "content-type": "application/json" }, frames: [Buffer.from(JSON.stringify({ object: "error", message: parsed.message, type: "BadRequestError", param: null, code: 400 }))], stallAfterFrames: null, stallBeforeHead: false });
      entry.model = parsed.input.model;
      entry.stream = parsed.stream;
      entry.toolCount = parsed.input.tools.length;
      const markup = creds?.toolMarkup ?? "<tool_call>";
      return this.respond(res, entry, st, parsed.input, (s, input) => renderChatCompletions(s, input, { toolMarkup: markup }));
    }
    return this.write(res, entry, { status: 404, headers: { "content-type": "application/json" }, frames: [Buffer.from('{"error":{"message":"Not found (emulated)."}}')], stallAfterFrames: null, stallBeforeHead: false });
  }

  private respond(res: ServerResponse, entry: RequestLogEntry, st: HostState, base: Omit<RenderInput, "seed" | "createdAt">, render: (s: EmulatorScript, input: RenderInput) => EmulatedResponse): Promise<void> {
    const input: RenderInput = { ...base, seed: randomBytes(9).toString("base64url").replace(/[-_]/g, "x"), createdAt: Math.floor(this.now().getTime() / 1000) };
    const script = st.scripts.shift() ?? defaultScript(input);
    entry.script = script.kind;
    return this.write(res, entry, render(script, input));
  }

  private write(res: ServerResponse, entry: RequestLogEntry, out: EmulatedResponse): Promise<void> {
    entry.status = out.status;
    return new Promise<void>((resolve) => {
      let closed = false;
      res.on("close", () => {
        closed = true;
        if (!entry.completed) entry.clientClosedEarly = true;
        resolve();
      });
      if (out.stallBeforeHead) return; // MODEL_HANG before any byte: wait for the client to give up.
      const headers = { ...out.headers };
      if (out.stallAfterFrames === null && !headers["content-type"]?.startsWith("text/event-stream") && !headers["content-type"]?.startsWith("application/vnd.amazon.eventstream")) {
        headers["content-length"] = String(out.frames.reduce((n, f) => n + f.length, 0));
      }
      res.writeHead(out.status, headers);
      const delay = this.opts.frameDelayMs ?? 2;
      let i = 0;
      const next = () => {
        if (closed) return;
        if (out.stallAfterFrames !== null && i >= out.stallAfterFrames) return; // MODEL_HANG: stall with the stream open.
        if (i >= out.frames.length) {
          entry.completed = true;
          res.end();
          return;
        }
        res.write(out.frames[i] as Buffer);
        entry.framesWritten = ++i;
        setTimeout(next, delay);
      };
      next();
    });
  }

  /* ---------------------------------------------------------------- admin */

  private async admin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://admin.invalid");
    const send = (status: number, body: unknown) => {
      const b = Buffer.from(JSON.stringify(body));
      res.writeHead(status, { "content-type": "application/json", "content-length": String(b.length) });
      res.end(b);
    };
    try {
      const body = req.method === "POST" ? (safeJson(await readBody(req)) as Record<string, unknown>) : {};
      const host = String(url.searchParams.get("host") ?? body?.host ?? "").toLowerCase();
      switch (`${req.method} ${url.pathname}`) {
        case "GET /__emulator/health":
          return send(200, { ok: true });
        case "POST /__emulator/tls":
          this.addTlsContext(String(body.servername), String(body.cert), String(body.key));
          return send(200, { ok: true });
        case "POST /__emulator/hosts":
          this.registerHost(host, body.credentials as HostCredentials);
          return send(200, { ok: true });
        case "POST /__emulator/scripts":
          this.queue(host, ...((body.scripts as EmulatorScript[]) ?? []));
          return send(200, { ok: true });
        case "POST /__emulator/faults": {
          const fault = String(body.fault);
          if (!(fault in FAULT_SCRIPTS)) return send(400, { error: "UNKNOWN_FAULT" });
          this.injectFault(host, fault as EmulatorFault, typeof body.count === "number" ? body.count : 1, (body.override as Partial<EmulatorScript>) ?? {});
          return send(200, { ok: true });
        }
        case "GET /__emulator/requests":
          return send(200, { requests: this.requests(host) });
        case "DELETE /__emulator/hosts":
          this.clear(host);
          return send(200, { ok: true });
        default:
          return send(404, { error: "NOT_FOUND" });
      }
    } catch {
      return send(400, { error: "BAD_REQUEST" });
    }
  }
}

function safeJson(buf: Buffer): unknown {
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    return undefined;
  }
}

/** A context for unknown server names: the handshake is refused before it is used (SNICallback error). */
function selfContextPlaceholder(): SecureContext {
  return createSecureContext({});
}
