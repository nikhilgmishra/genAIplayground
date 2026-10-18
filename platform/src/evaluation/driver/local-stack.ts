/**
 * LOCAL STACK for the evaluation driver, the demo and the load smoke: one fresh
 * LOCAL FIXTURE composition per call (buildContainer("local") with the REAL
 * business module), the REAL worker loops (outbox dispatch/consume, ledger
 * reconcile/expire, audit shipping, workflow ticks, transfer sweeps, LOCAL
 * FIXTURE telephony event delivery) run deterministically on demand, and clients
 * for the public surface only:
 *
 *  - telephony-control (Studio identity) and portal routes via fastify.inject;
 *  - tools as mcp_tools over the HTTP tool route (fastify.inject) or the REAL MCP
 *    SDK client against a 127.0.0.1 listener (ephemeral port, no external network).
 *
 * Time is a FakeClock. SYNTHETIC data and LOCAL FIXTURE tokens only.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AddressInfo } from "node:net";
import { performance } from "node:perf_hooks";
import { buildBusiness as realBuildBusiness } from "../../business/index.js";
import type { BuildBusiness } from "../../business/contract.js";
import { LOCAL_FIXTURE_TOKENS } from "../../gateway/auth.js";
import { IDEMPOTENCY_KEY_HEADER, INTERACTION_ID_HEADER, SESSION_REF_HEADER, TURN_ID_HEADER } from "../../gateway/session-binding.js";
import { buildContainer } from "../../main/container.js";
import type { Container } from "../../main/container.js";
import { createMemoryLogger } from "../../observability/logger.js";
import type { LogRecord } from "../../observability/logger.js";
import { ToolResult } from "../../protocol/index.js";
import { FakeClock } from "../../shared/clock.js";
import { newId } from "../../shared/ids.js";
import { workerLoopsFor } from "../../worker/worker.js";
import type { LoopReport, WorkerLoop } from "../../worker/loops.js";

export type ToolTransport = "http" | "mcp";
export type Channel = keyof typeof LOCAL_FIXTURE_TOKENS;

/** Start of simulated time: a Sunday morning before the synthetic appointments (2026-10-22 onwards). */
export const DEFAULT_CLOCK_START = "2026-10-18T09:00:00.000Z";

export interface HttpReply {
  status: number;
  body: unknown;
  latencyMs: number;
}

export interface ToolCallReply {
  /** Strictly parsed ToolResult; null when the transport answered something else. */
  result: ToolResult | null;
  httpStatus: number;
  latencyMs: number;
  transport: ToolTransport;
}

export interface TrustedBinding {
  sessionRef: string | null;
  callId: string | null;
}

export interface LocalStackOptions {
  transport?: ToolTransport;
  clockStart?: string;
  buildBusiness?: BuildBusiness;
  ingestKnowledge?: boolean;
  /** Per-integration rate limit (null disables; the corpus and demo run with the configured default). */
  rateLimit?: { max: number; timeWindowMs: number } | null;
  /** Listen on 127.0.0.1 even for the HTTP transport (load smoke). */
  listen?: boolean;
}

function parseJsonOrNull(text: string): unknown {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Loops excluded from on-demand draining (daily retention; nothing to purge within a call). */
const SKIPPED_LOOPS = new Set(["retention.run"]);

export class LocalStack {
  private readonly mcpClients = new Map<string, Client>();
  private closed = false;

  private constructor(
    readonly container: Container,
    readonly clock: FakeClock,
    readonly logRecords: LogRecord[],
    readonly transport: ToolTransport,
    private readonly loops: WorkerLoop[],
    private readonly closers: (() => void)[],
    readonly baseUrl: string | null,
  ) {}

  static async create(opts: LocalStackOptions = {}): Promise<LocalStack> {
    const clock = new FakeClock(opts.clockStart ?? DEFAULT_CLOCK_START);
    const { logger, records } = createMemoryLogger();
    const container = await buildContainer({
      environment: "local",
      buildBusiness: opts.buildBusiness ?? realBuildBusiness,
      clock,
      env: {},
      logger,
      ...(opts.rateLimit !== undefined ? { rateLimit: opts.rateLimit } : { rateLimit: null }),
      ...(opts.ingestKnowledge === false ? { ingestKnowledge: false } : {}),
    });
    const transport = opts.transport ?? "http";
    let baseUrl: string | null = null;
    try {
      if (transport === "mcp" || opts.listen) {
        await container.app.listen({ host: "127.0.0.1", port: 0 });
        const addr = container.app.server.address() as AddressInfo;
        if (addr.address !== "127.0.0.1") throw new Error("LOOPBACK_REQUIRED");
        baseUrl = `http://127.0.0.1:${addr.port}`;
      }
      const { loops, closers } = workerLoopsFor(container);
      return new LocalStack(container, clock, records, transport, loops.filter((l) => !SKIPPED_LOOPS.has(l.name)), closers, baseUrl);
    } catch (err) {
      await container.close();
      throw err;
    }
  }

  get tenantId(): string {
    return this.container.config.tenantId;
  }

  /** Public HTTP surface via fastify.inject (deterministic; no sockets). */
  async inject(method: "GET" | "POST", url: string, channel: Channel | null, opts: { headers?: Record<string, string>; payload?: unknown } = {}): Promise<HttpReply> {
    const started = performance.now();
    const res = await this.container.app.inject({
      method,
      url,
      headers: { ...(channel ? { authorization: `Bearer ${LOCAL_FIXTURE_TOKENS[channel]}` } : {}), ...(opts.headers ?? {}) },
      ...(opts.payload !== undefined ? { payload: opts.payload as Record<string, unknown> } : {}),
    });
    return { status: res.statusCode, body: parseJsonOrNull(res.body), latencyMs: performance.now() - started };
  }

  /** Trusted transport headers (TB-01 trusted_header mode): never tool arguments. */
  static trustedHeaders(b: TrustedBinding): Record<string, string> {
    return { ...(b.sessionRef ? { [SESSION_REF_HEADER]: b.sessionRef } : {}), ...(b.callId ? { [INTERACTION_ID_HEADER]: b.callId } : {}) };
  }

  /** Invokes one pinned tool as the mcp_tools identity over the configured transport. */
  async callTool(name: string, args: Record<string, unknown>, binding: TrustedBinding, opts: { idempotencyKey?: string; turnId?: string; locale?: string } = {}): Promise<ToolCallReply> {
    const idempotencyKey = opts.idempotencyKey ?? newId("idk", 18).replace(/^idk_/, "idk-");
    if (this.transport === "mcp") return this.callToolMcp(name, args, binding, idempotencyKey);
    const started = performance.now();
    const res = await this.container.app.inject({
      method: "POST",
      url: `/v1/tools/${name}/1.0.0`,
      headers: {
        authorization: `Bearer ${LOCAL_FIXTURE_TOKENS.mcp_tools}`,
        ...LocalStack.trustedHeaders(binding),
        [IDEMPOTENCY_KEY_HEADER]: idempotencyKey,
        ...(opts.turnId ? { [TURN_ID_HEADER]: opts.turnId } : {}),
      },
      payload: { arguments: args, ...(opts.locale ? { locale: opts.locale } : {}) },
    });
    const latencyMs = performance.now() - started;
    const r = ToolResult.safeParse(parseJsonOrNull(res.body));
    return { result: r.success ? r.data : null, httpStatus: res.statusCode, latencyMs, transport: "http" };
  }

  private async mcpClient(binding: TrustedBinding): Promise<Client> {
    if (!this.baseUrl) throw new Error("MCP_LISTENER_NOT_STARTED");
    const key = `${binding.sessionRef ?? "-"}|${binding.callId ?? "-"}`;
    const existing = this.mcpClients.get(key);
    if (existing) return existing;
    const client = new Client({ name: "vsp-local-evaluation-driver", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${this.baseUrl}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${LOCAL_FIXTURE_TOKENS.mcp_tools}`, ...LocalStack.trustedHeaders(binding) } },
      }),
    );
    this.mcpClients.set(key, client);
    return client;
  }

  private async callToolMcp(name: string, args: Record<string, unknown>, binding: TrustedBinding, idempotencyKey: string): Promise<ToolCallReply> {
    const started = performance.now();
    try {
      const client = await this.mcpClient(binding);
      const res = await client.callTool({ name, arguments: args, _meta: { idempotencyKey } });
      const r = ToolResult.safeParse(res.structuredContent);
      return { result: r.success ? r.data : null, httpStatus: 200, latencyMs: performance.now() - started, transport: "mcp" };
    } catch {
      return { result: null, httpStatus: 0, latencyMs: performance.now() - started, transport: "mcp" };
    }
  }

  /**
   * Lets `ms` of simulated time pass while the REAL worker loops run on their own
   * schedule (a loop runs when its interval has elapsed since its previous run, as
   * the TimerLoopScheduler would). Deterministic: FakeClock steps of `stepMs`.
   * Returns the number of items the loops processed.
   */
  async drain(ms = 2_000, stepMs = 500): Promise<number> {
    let total = 0;
    const steps = Math.max(1, Math.ceil(ms / stepMs));
    for (let i = 0; i < steps; i++) {
      this.clock.advanceMs(stepMs);
      total += await this.runDue();
    }
    return total;
  }

  /**
   * Runs one named worker loop once WITHOUT advancing simulated time (the load smoke ships audit
   * events on a real-time interval while traffic runs). Unknown loop names fail closed.
   */
  async runLoopOnce(name: string): Promise<LoopReport> {
    const loop = this.loops.find((l) => l.name === name);
    if (!loop) throw new Error(`UNKNOWN_WORKER_LOOP:${name}`);
    return loop.runOnce();
  }

  private readonly lastRun = new Map<string, number>();

  private async runDue(): Promise<number> {
    const now = this.clock.now().getTime();
    let processed = 0;
    for (const loop of this.loops) {
      const last = this.lastRun.get(loop.name);
      if (last !== undefined && now - last < loop.intervalMs) continue;
      this.lastRun.set(loop.name, now);
      const r = await loop.runOnce();
      processed += r.processed;
    }
    return processed;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const c of this.mcpClients.values()) await c.close().catch(() => undefined);
    for (const close of this.closers) {
      try {
        close();
      } catch {
        // closing a LOCAL FIXTURE subscription cannot fail meaningfully
      }
    }
    await this.container.close();
  }
}
