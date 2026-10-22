import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { EndpointPool, SniContexts } from "./listeners.js";

/** A private CA and one leaf for `host` (P-256, SAN DNS), generated with the system openssl. */
function pki(host: string): { ca: string; cert: string; key: string; dispose(): void } {
  const dir = mkdtempSync(join(tmpdir(), "refbiz-sni-"));
  const run = (args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
  run(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "ca.key"]);
  run(["req", "-x509", "-new", "-key", "ca.key", "-sha256", "-days", "1", "-subj", "/CN=refbiz unit CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign", "-out", "ca.pem"]);
  run(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "leaf.key"]);
  run(["req", "-new", "-key", "leaf.key", "-subj", `/CN=${host}`, "-out", "leaf.csr"]);
  writeFileSync(join(dir, "leaf.ext"), `basicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:${host}\n`);
  run(["x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-days", "1", "-sha256", "-extfile", "leaf.ext", "-out", "leaf.pem"]);
  const read = (f: string) => readFileSync(join(dir, f), "utf8");
  return { ca: read("ca.pem"), cert: read("leaf.pem"), key: read("leaf.key"), dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

function handshake(port: number, servername: string, ca: string): Promise<{ ok: boolean; authorized: boolean }> {
  return new Promise((resolve) => {
    const s = tlsConnect({ port, host: "127.0.0.1", servername, ca });
    s.once("secureConnect", () => {
      resolve({ ok: true, authorized: s.authorized });
      s.destroy();
    });
    s.once("error", () => resolve({ ok: false, authorized: false }));
  });
}

const pools: EndpointPool[] = [];
afterEach(async () => {
  for (const p of pools.splice(0)) await p.closeAll();
});

function connect(port: number): Promise<{ ok: true; socket: Socket } | { ok: false; code: string }> {
  return new Promise((resolve) => {
    const s = createConnection({ port, host: "127.0.0.1" });
    s.once("connect", () => resolve({ ok: true, socket: s }));
    s.once("error", (e: NodeJS.ErrnoException) => resolve({ ok: false, code: e.code ?? "ERROR" }));
  });
}

describe("dedicated endpoints and connection-level fault modes [FO-17-24]", () => {
  it("[FAULT:SCHEDULING_UNAVAILABLE seam] REFUSE_CONNECTIONS closes the endpoint (ECONNREFUSED, nothing accepted) and NORMAL reopens it on the same port", async () => {
    const accepted: Socket[] = [];
    const pool = new EndpointPool((s) => accepted.push(s));
    pools.push(pool);
    const ep = await pool.open();
    const first = await connect(ep.port);
    expect(first.ok).toBe(true);
    if (first.ok) first.socket.destroy();
    await pool.setMode(ep.endpointId, "REFUSE_CONNECTIONS");
    const refused = await connect(ep.port);
    expect(refused).toEqual({ ok: false, code: "ECONNREFUSED" });
    await pool.setMode(ep.endpointId, "NORMAL");
    const again = await connect(ep.port);
    expect(again.ok).toBe(true);
    if (again.ok) again.socket.destroy();
    const v = pool.get(ep.endpointId);
    expect(v?.port).toBe(ep.port);
    expect(v?.refusedWindows).toBe(1);
    expect(accepted.length).toBe(2);
    for (const s of accepted) s.destroy();
  });

  it("[FAULT:PROVIDER_API_TIMEOUT seam] STALL_HANDSHAKE accepts the connection and holds it without handing it to the TLS server", async () => {
    const accepted: Socket[] = [];
    const pool = new EndpointPool((s) => accepted.push(s));
    pools.push(pool);
    const ep = await pool.open();
    await pool.setMode(ep.endpointId, "STALL_HANDSHAKE");
    const c = await connect(ep.port);
    expect(c.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(accepted).toHaveLength(0);
    expect(pool.get(ep.endpointId)?.stalled).toBe(1);
    // Clearing the mode drops the held connections.
    await pool.setMode(ep.endpointId, "NORMAL");
    if (c.ok) await new Promise<void>((r) => (c.socket.destroyed ? r() : c.socket.once("close", () => r())));
  });

  it("[FO-06-74] an unknown server name without a configured certificate fails the handshake; a registered name is served with its own certificate", async () => {
    const host = "known.refbiz.test";
    const p = pki(host);
    const app = Fastify({ logger: false, https: { minVersion: "TLSv1.2" } });
    try {
      const sni = new SniContexts();
      sni.attach(app.server);
      sni.register(host, p.cert, p.key);
      expect(sni.has(host)).toBe(true);
      app.get("/x", async () => ({ ok: true }));
      await app.listen({ port: 0, host: "127.0.0.1" });
      const a = app.server.address();
      const port = typeof a === "object" && a !== null ? a.port : 0;
      expect(await handshake(port, "unknown.refbiz.test", p.ca)).toEqual({ ok: false, authorized: false });
      expect(await handshake(port, host, p.ca)).toEqual({ ok: true, authorized: true });
      expect(() => sni.register("10.0.0.1", p.cert, p.key)).toThrow("TLS_HOSTNAME_INVALID");
      // Invalid material is refused before it is stored.
      expect(() => sni.register("broken.refbiz.test", "not a certificate", "not a key")).toThrow();
      expect(sni.has("broken.refbiz.test")).toBe(false);
    } finally {
      await app.close();
      p.dispose();
    }
  });
});
