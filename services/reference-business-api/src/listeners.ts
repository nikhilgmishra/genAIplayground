/**
 * TLS listeners of the API (WP-23).
 *
 *   SniContexts      server certificates per host name (SNI). A deployment configures one certificate from files
 *                    (the server's default context); in local/ci the fault-control API registers per-host
 *                    certificates issued by a test's private CA, so the platform's transport verifies the name it
 *                    connects to (no TLS check is ever disabled). An unknown name without a default certificate
 *                    fails the handshake. Certificates are attached to the API's TLS server with its own
 *                    `addContext` (no TLS module is loaded here).
 *   EndpointPool     local/ci only: dedicated loopback listeners, each standing in for one system's network
 *                    endpoint (scheduling, billing, claims, provider network, referrals). Connection-level faults
 *                    are applied per endpoint without touching any other test:
 *                      REFUSE_CONNECTIONS  the listener is closed (the kernel refuses connections: ECONNREFUSED,
 *                                          nothing sent) until the mode is cleared, then reopens on the same port;
 *                      STALL_HANDSHAKE     connections are accepted and held without starting TLS (a client deadline
 *                                          expires before the request is sent: timeout before send).
 *                    Each endpoint is a bare listening socket (a Fastify instance whose HTTP connection handling is
 *                    replaced) that hands accepted sockets to the API's TLS server. Counters (connections, stalled,
 *                    refused windows) are the reach evidence of those faults.
 */
import type { Socket } from "node:net";
import type { SecureContextOptions } from "node:tls";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { newId } from "./ids.js";

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** The part of a TLS server certificates are attached to (node:tls Server#addContext). */
export interface ContextTarget {
  addContext(hostname: string, context: SecureContextOptions): void;
}

export class SniContexts {
  private readonly byHost = new Map<string, { cert: string; key: string }>();
  private target: ContextTarget | null = null;

  /** Attaches the API's TLS server; certificates registered earlier are added to it. */
  attach(target: ContextTarget): void {
    this.target = target;
    for (const [host, m] of this.byHost) target.addContext(host, { cert: m.cert, key: m.key, minVersion: "TLSv1.2" });
  }

  /** Registers (or replaces: the latest registration of a name wins) the certificate of one host name. */
  register(hostname: string, certPem: string, keyPem: string): void {
    if (!HOSTNAME.test(hostname)) throw new Error("TLS_HOSTNAME_INVALID");
    // addContext builds the secure context at once: invalid material is refused here, before it is stored.
    this.target?.addContext(hostname, { cert: certPem, key: keyPem, minVersion: "TLSv1.2" });
    this.byHost.set(hostname, { cert: certPem, key: keyPem });
  }

  has(hostname: string): boolean {
    return this.byHost.has(hostname);
  }
}

export type EndpointMode = "NORMAL" | "REFUSE_CONNECTIONS" | "STALL_HANDSHAKE";

export interface EndpointView {
  endpointId: string;
  port: number;
  mode: EndpointMode;
  connections: number;
  stalled: number;
  refusedWindows: number;
}

interface Endpoint {
  endpointId: string;
  port: number;
  mode: EndpointMode;
  listener: FastifyInstance | null;
  connections: number;
  stalled: number;
  refusedWindows: number;
  held: Set<Socket>;
}

/** Dedicated per-test endpoints that hand accepted sockets to the API's TLS server. */
export class EndpointPool {
  private readonly endpoints = new Map<string, Endpoint>();

  /** `accept` hands a raw socket to the TLS server (`tlsServer.emit("connection", socket)`). */
  constructor(
    private readonly accept: (socket: Socket) => void,
    private readonly bind = "127.0.0.1",
  ) {}

  async open(): Promise<EndpointView> {
    const ep: Endpoint = { endpointId: newId("ept"), port: 0, mode: "NORMAL", listener: null, connections: 0, stalled: 0, refusedWindows: 0, held: new Set() };
    ep.port = await this.listen(ep, 0);
    this.endpoints.set(ep.endpointId, ep);
    return this.view(ep);
  }

  get(endpointId: string): EndpointView | null {
    const ep = this.endpoints.get(endpointId);
    return ep ? this.view(ep) : null;
  }

  async setMode(endpointId: string, mode: EndpointMode): Promise<EndpointView | null> {
    const ep = this.endpoints.get(endpointId);
    if (!ep) return null;
    if (ep.mode === mode) return this.view(ep);
    if (mode === "REFUSE_CONNECTIONS") {
      ep.mode = mode;
      ep.refusedWindows += 1;
      await this.closeListener(ep);
    } else {
      const wasRefusing = ep.mode === "REFUSE_CONNECTIONS";
      ep.mode = mode;
      if (mode === "NORMAL") for (const s of ep.held) s.destroy();
      ep.held.clear();
      if (wasRefusing) await this.listen(ep, ep.port);
    }
    return this.view(ep);
  }

  async close(endpointId: string): Promise<boolean> {
    const ep = this.endpoints.get(endpointId);
    if (!ep) return false;
    this.endpoints.delete(endpointId);
    for (const s of ep.held) s.destroy();
    await this.closeListener(ep);
    return true;
  }

  async closeAll(): Promise<void> {
    for (const id of [...this.endpoints.keys()]) await this.close(id);
  }

  private view(ep: Endpoint): EndpointView {
    return { endpointId: ep.endpointId, port: ep.port, mode: ep.mode, connections: ep.connections, stalled: ep.stalled, refusedWindows: ep.refusedWindows };
  }

  private async listen(ep: Endpoint, port: number): Promise<number> {
    // Reopening on the same port can race the close of the previous listening handle: retry briefly.
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.listenOnce(ep, port);
      } catch (e) {
        if ((e as { code?: string }).code !== "EADDRINUSE" || port === 0 || attempt >= 40) throw e;
        await new Promise((r) => setTimeout(r, 25));
      }
    }
  }

  private async listenOnce(ep: Endpoint, port: number): Promise<number> {
    const listener = Fastify({ logger: false });
    // A bare listening socket: the HTTP connection handling is replaced by the endpoint's own.
    listener.server.removeAllListeners("connection");
    listener.server.on("connection", (socket: Socket) => {
      ep.connections += 1;
      socket.on("error", () => undefined);
      if (ep.mode === "STALL_HANDSHAKE") {
        ep.stalled += 1;
        ep.held.add(socket);
        socket.on("close", () => ep.held.delete(socket));
        return;
      }
      this.accept(socket);
    });
    try {
      await listener.listen({ port, host: this.bind });
    } catch (e) {
      await listener.close().catch(() => undefined);
      throw e;
    }
    ep.listener = listener;
    const addr = listener.server.address();
    return typeof addr === "object" && addr !== null ? addr.port : port;
  }

  private async closeListener(ep: Endpoint): Promise<void> {
    const l = ep.listener;
    ep.listener = null;
    if (!l) return;
    // Stop accepting at once (the port is released; connections already handed over finish on their own).
    l.server.close();
    await new Promise((resolve) => setImmediate(resolve));
  }
}
