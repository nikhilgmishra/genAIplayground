/**
 * Egress-classified transport (WP-06; FO-06-20, FO-15-19, FO-06-08; DATA-01, SAFE-05, ACT-03).
 * Real sockets on 127.0.0.1 (node:http servers, a raw TCP server that never completes TLS, a closed
 * port); the production transport reaches them only through explicit local/ci loopback routes.
 */
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer as createTcpServer } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_METRIC_CATALOGUE, InMemoryMetrics } from "../../observability/metrics.js";
import { withConnectorMetrics } from "../../observability/catalog/connectors.js";
import { EgressGuard } from "../../privacy/egress.js";
import { AccessDeniedError } from "../../shared/errors.js";
import { addressesPermitted, classifyAddress, isIpLiteral } from "./address.js";
import { ConnectorHttpTransport, TransportError } from "./transport.js";
import type { LoopbackRoute, Resolver, TransportRequest } from "./transport.js";

const HOST = "api.vendor.emulator.test";
const OTHER = "other.vendor.emulator.test";

const guard = () =>
  new EgressGuard(
    {
      policyVersion: "egress-test-1",
      destinations: [
        { destinationId: "egr_vendor_test", kind: "SYSTEM_OF_RECORD", hosts: [HOST], allowedClasses: ["INTERNAL", "PHI"], coverage: { baaRef: "baa-synthetic", approvalId: "apr_synthApprovalTest01" }, environments: ["ci"], adapterKind: "live" },
        { destinationId: "egr_other_test", kind: "SYSTEM_OF_RECORD", hosts: [OTHER], allowedClasses: ["INTERNAL"], coverage: { baaRef: null, approvalId: null }, environments: ["ci"], adapterKind: "live" },
      ],
    },
    { environment: "ci" },
  );

interface Started {
  server: Server;
  port: number;
  requests: number;
  connections: number;
  close(): Promise<void>;
}

const open: Started[] = [];
const sockets: Socket[] = [];

async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<Started> {
  const s: Started = { server: createHttpServer(), port: 0, requests: 0, connections: 0, close: async () => undefined };
  s.server.on("request", (req, res) => {
    s.requests += 1;
    handler(req, res);
  });
  s.server.on("connection", (c: Socket) => {
    s.connections += 1;
    sockets.push(c);
  });
  await new Promise<void>((r) => s.server.listen(0, "127.0.0.1", r));
  s.port = (s.server.address() as AddressInfo).port;
  s.close = () => new Promise((r) => s.server.close(() => r()));
  open.push(s);
  return s;
}

afterEach(async () => {
  for (const c of sockets.splice(0)) c.destroy();
  await Promise.all(open.splice(0).map((s) => s.close()));
});

function transport(routes: Record<string, LoopbackRoute>, extra: Partial<ConstructorParameters<typeof ConnectorHttpTransport>[0]> = {}) {
  return new ConnectorHttpTransport({ environment: "ci", egress: guard(), loopbackRoutes: new Map(Object.entries(routes)), ...extra });
}

const req = (o: Partial<TransportRequest> = {}): TransportRequest => ({
  method: "GET",
  url: new URL(`https://${HOST}/api/v1/things`),
  headers: { accept: "application/json" },
  body: null,
  policy: { allowedHosts: [HOST], addressClass: "PUBLIC_INTERNET", dataClass: "PHI" },
  sideEffect: false,
  timeoutMs: 1_000,
  dependency: "scheduling",
  ...o,
});

async function failure(p: Promise<unknown>): Promise<TransportError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof TransportError) return e;
    throw e;
  }
  throw new Error("expected a transport failure");
}

describe("pre-I/O destination checks [FO-06-20][DATA-01][SAFE-05]", () => {
  it("[FO-06-20] positive: an allowlisted, egress-approved destination is reached and answers", async () => {
    const s = await serve((_q, r) => r.end(JSON.stringify({ ok: true })));
    const res = await transport({ [HOST]: { port: s.port, tls: false } }).send(req());
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body.toString())).toEqual({ ok: true });
    expect(s.requests).toBe(1);
  });

  it("[FO-06-20][SAFE-05] adversarial: a host outside the destination's allowlist is refused before any connection", async () => {
    const s = await serve((_q, r) => r.end("{}"));
    const t = transport({ [HOST]: { port: s.port, tls: false }, [OTHER]: { port: s.port, tls: false } });
    const e = await failure(t.send(req({ url: new URL(`https://${OTHER}/api/v1/things`) })));
    expect([e.reasonCode, e.phase, e.outcome, e.requestSent]).toEqual(["CONNECTOR_HOST_NOT_ALLOWED", "PRE_IO", "NOT_STARTED", false]);
    expect(s.connections).toBe(0);
  });

  it("[FO-06-20] adversarial: IP literals in every spelling are refused before I/O", async () => {
    const t = transport({});
    for (const u of ["https://127.0.0.1/x", "https://[::1]/x", "https://2130706433/x", "https://0x7f.0.0.1/x", "https://169.254.169.254/latest/meta-data"]) {
      const e = await failure(t.send(req({ url: new URL(u), policy: { allowedHosts: [new URL(u).hostname], addressClass: "PUBLIC_INTERNET", dataClass: "INTERNAL" } })));
      expect(e.reasonCode, u).toBe("CONNECTOR_IP_LITERAL_REFUSED");
    }
    expect(isIpLiteral("api.vendor.emulator.test")).toBe(false);
  });

  it("[FO-06-20] adversarial: userinfo, fragments, plain http and header injection are refused before I/O", async () => {
    const t = transport({});
    expect((await failure(t.send(req({ url: new URL(`https://user:pw@${HOST}/x`) })))).reasonCode).toBe("CONNECTOR_URL_USERINFO_REFUSED");
    expect((await failure(t.send(req({ url: new URL(`https://${HOST}/x#frag`) })))).reasonCode).toBe("CONNECTOR_URL_FRAGMENT_REFUSED");
    expect((await failure(t.send(req({ url: new URL(`http://${HOST}/x`) })))).reasonCode).toBe("CONNECTOR_URL_INSECURE");
    expect((await failure(t.send(req({ headers: { "x-evil": "a\r\nHost: other" } })))).reasonCode).toBe("CONNECTOR_HEADER_INVALID");
  });

  it("[FO-06-20] adversarial (DNS rebinding): every resolved address must match the address class; one bad answer refuses the name before any connection", async () => {
    const cases: [string[], "PUBLIC_INTERNET" | "PRIVATE_NETWORK", boolean][] = [
      [["93.184.216.34"], "PUBLIC_INTERNET", true],
      [["93.184.216.34", "127.0.0.1"], "PUBLIC_INTERNET", false],
      [["169.254.169.254"], "PUBLIC_INTERNET", false],
      [["10.1.2.3"], "PUBLIC_INTERNET", false],
      [["::ffff:127.0.0.1"], "PUBLIC_INTERNET", false],
      [["2606:4700::1111", "2002:7f00:1::1"], "PUBLIC_INTERNET", false], // a 6to4 answer embedding loopback
      [["2001:0:4136:e378:8000:63bf:3fff:fdd2"], "PUBLIC_INTERNET", false], // Teredo
      [["fe80::1"], "PRIVATE_NETWORK", false],
      [["10.1.2.3"], "PRIVATE_NETWORK", true],
      [["93.184.216.34"], "PRIVATE_NETWORK", false],
    ];
    for (const [addresses, addressClass, permitted] of cases) {
      expect(addressesPermitted(addresses, addressClass), addresses.join(",")).toBe(permitted);
      if (permitted) continue; // the transport would connect: no real outbound connection from a unit test
      let resolved = 0;
      const resolve: Resolver = async () => {
        resolved += 1;
        return addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
      };
      const e = await failure(transport({}, { resolve }).send(req({ policy: { allowedHosts: [HOST], addressClass, dataClass: "INTERNAL" } })));
      expect([e.reasonCode, e.phase, e.requestSent], addresses.join(",")).toEqual(["CONNECTOR_ADDRESS_NOT_ALLOWED", "PRE_IO", false]);
      // Resolved exactly once: the checked answer is the one the connection would be pinned to.
      expect(resolved).toBe(1);
    }
    expect(addressesPermitted([], "PUBLIC_INTERNET")).toBe(false);
  });

  it("[FO-15-19][DATA-01] the EgressGuard is checked per request: a payload class the destination is not approved for is refused before I/O", async () => {
    const s = await serve((_q, r) => r.end("{}"));
    const metrics = new InMemoryMetrics({ catalogue: withConnectorMetrics(DEFAULT_METRIC_CATALOGUE) });
    const t = transport({ [OTHER]: { port: s.port, tls: false } }, { metrics });
    const p = t.send(req({ url: new URL(`https://${OTHER}/x`), policy: { allowedHosts: [OTHER], addressClass: "PUBLIC_INTERNET", dataClass: "PHI" } }));
    await expect(p).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(p).rejects.toThrow("EGRESS_PHI_NOT_APPROVED_FOR_DESTINATION");
    expect(s.connections).toBe(0);
    expect(metrics.counterValue("vsp_connector_http_requests_total", { result: "refused_pre_io" })).toBe(1);
    // The same destination is fine for content it is approved for.
    expect((await t.send(req({ url: new URL(`https://${OTHER}/x`), policy: { allowedHosts: [OTHER], addressClass: "PUBLIC_INTERNET", dataClass: "INTERNAL" } }))).status).toBe(200);
  });

  it("[FO-06-20] emulator routes exist only in local/ci: a deployed environment refuses them at construction", () => {
    expect(() => new ConnectorHttpTransport({ environment: "production", egress: guard(), loopbackRoutes: new Map([[HOST, { port: 1, tls: true }]]) })).toThrow("TRANSPORT_LOOPBACK_ROUTE_OUTSIDE_LOCAL");
  });
});

describe("responses: redirects and bounds [FO-06-20]", () => {
  it("[FO-06-20] adversarial: a redirect is refused and its Location is never contacted (read FAILED, write UNKNOWN)", async () => {
    const target = await serve((_q, r) => r.end("{}"));
    const s = await serve((_q, r) => {
      r.writeHead(302, { location: `https://${OTHER}:${target.port}/steal` });
      r.end();
    });
    const t = transport({ [HOST]: { port: s.port, tls: false }, [OTHER]: { port: target.port, tls: false } });
    const read = await failure(t.send(req()));
    expect([read.reasonCode, read.outcome, read.httpStatus]).toEqual(["CONNECTOR_REDIRECT_REFUSED", "FAILED", 302]);
    const write = await failure(t.send(req({ method: "POST", body: "{}", sideEffect: true })));
    expect([write.reasonCode, write.outcome]).toEqual(["CONNECTOR_REDIRECT_REFUSED", "UNKNOWN"]);
    expect(target.requests).toBe(0);
  });

  it("[FO-06-20] response bodies are bounded (declared length and streamed chunks)", async () => {
    const declared = await serve((_q, r) => {
      r.writeHead(200, { "content-length": String(2_000_000) });
      r.end("x".repeat(2_000_000));
    });
    const chunked = await serve((_q, r) => {
      r.writeHead(200);
      for (let i = 0; i < 40; i += 1) r.write("y".repeat(65_536));
      r.end();
    });
    const t = transport({ [HOST]: { port: declared.port, tls: false }, [OTHER]: { port: chunked.port, tls: false } });
    expect((await failure(t.send(req()))).reasonCode).toBe("CONNECTOR_RESPONSE_TOO_LARGE");
    const e = await failure(t.send(req({ url: new URL(`https://${OTHER}/x`), policy: { allowedHosts: [OTHER], addressClass: "PUBLIC_INTERNET", dataClass: "INTERNAL" } })));
    expect(e.reasonCode).toBe("CONNECTOR_RESPONSE_TOO_LARGE");
  });
});

describe("failure classification by phase [FO-06-08][ACT-03]", () => {
  it("[FO-06-08] timeout before send: a TLS handshake that never completes is NOT_STARTED (nothing reached the vendor)", async () => {
    const raw = createTcpServer((c) => sockets.push(c));
    await new Promise<void>((r) => raw.listen(0, "127.0.0.1", r));
    const port = (raw.address() as AddressInfo).port;
    try {
      const e = await failure(transport({ [HOST]: { port, tls: true } }).send(req({ method: "PUT", body: "{}", sideEffect: true, timeoutMs: 300 })));
      expect([e.reasonCode, e.outcome, e.requestSent, e.retryable]).toEqual(["TIMEOUT_BEFORE_SEND", "NOT_STARTED", false, true]);
    } finally {
      for (const c of sockets.splice(0)) c.destroy();
      await new Promise((r) => raw.close(r));
    }
  });

  it("[FO-06-08] timeout before send: a name that never resolves is NOT_STARTED within the deadline", async () => {
    const resolve: Resolver = () => new Promise(() => undefined);
    const e = await failure(transport({}, { resolve }).send(req({ timeoutMs: 150 })));
    expect([e.reasonCode, e.outcome, e.requestSent]).toEqual(["TIMEOUT_BEFORE_SEND", "NOT_STARTED", false]);
  });

  it("[FO-06-08][ACT-03] timeout after send: a write is UNKNOWN and not retryable; a read is a retryable FAILED", async () => {
    const s = await serve(() => undefined); // reads the request, never answers
    const t = transport({ [HOST]: { port: s.port, tls: false } });
    const w = await failure(t.send(req({ method: "PUT", body: "{}", sideEffect: true, timeoutMs: 300 })));
    expect([w.reasonCode, w.outcome, w.retryable, w.requestSent]).toEqual(["TIMEOUT_AFTER_SEND", "UNKNOWN", false, true]);
    const r = await failure(t.send(req({ timeoutMs: 300 })));
    expect([r.reasonCode, r.outcome, r.retryable]).toEqual(["READ_TIMEOUT", "FAILED", true]);
    expect(s.requests).toBe(2);
  });

  it("[FO-06-08] connection refused is NOT_STARTED and retryable", async () => {
    const s = await serve((_q, r) => r.end());
    const port = s.port;
    await s.close();
    open.splice(open.indexOf(s), 1);
    const e = await failure(transport({ [HOST]: { port, tls: false } }).send(req({ method: "PUT", body: "{}", sideEffect: true })));
    expect([e.reasonCode, e.outcome, e.retryable, e.requestSent]).toEqual(["CONNECTION_REFUSED", "NOT_STARTED", true, false]);
  });

  it("[FO-06-08][ACT-03] a connection dropped after the request arrived: write UNKNOWN, read retryable FAILED", async () => {
    const s = await serve((q) => q.socket.destroy());
    const t = transport({ [HOST]: { port: s.port, tls: false } });
    const w = await failure(t.send(req({ method: "POST", body: "{}", sideEffect: true })));
    expect([w.reasonCode, w.outcome]).toEqual(["CONNECTION_LOST", "UNKNOWN"]);
    const r = await failure(t.send(req()));
    expect([r.reasonCode, r.outcome, r.retryable]).toEqual(["CONNECTION_LOST", "FAILED", true]);
  });

});

describe("address classification [FO-06-20]", () => {
  it.each([
    ["8.8.8.8", "PUBLIC"],
    ["127.0.0.53", "LOOPBACK"],
    ["10.0.0.1", "PRIVATE"],
    ["172.16.5.5", "PRIVATE"],
    ["172.32.0.1", "PUBLIC"],
    ["192.168.1.1", "PRIVATE"],
    ["100.64.0.1", "PRIVATE"],
    ["169.254.169.254", "LINK_LOCAL"],
    ["0.0.0.0", "RESERVED"],
    ["224.0.0.1", "RESERVED"],
    ["::1", "LOOPBACK"],
    ["::", "RESERVED"],
    ["::ffff:10.0.0.1", "PRIVATE"],
    ["::ffff:7f00:1", "LOOPBACK"],
    ["fd00::1", "PRIVATE"],
    ["fe80::1%eth0", "LINK_LOCAL"],
    ["ff02::1", "RESERVED"],
    ["2001:db8::1", "RESERVED"],
    ["2606:4700::1111", "PUBLIC"],
    ["64:ff9b::7f00:1", "LOOPBACK"],
    ["64:ff9b::a00:1", "PRIVATE"],
    // Transition / special-purpose IPv6 forms never count as public, whatever they embed.
    ["2002:7f00:1::1", "RESERVED"], // 6to4 of 127.0.0.1
    ["2002:a00:1::1", "RESERVED"], // 6to4 of 10.0.0.1
    ["2002:808:808::1", "RESERVED"], // 6to4 of a public IPv4: still a relay-tunnelled form
    ["2001:0:4136:e378:8000:63bf:3fff:fdd2", "RESERVED"], // Teredo
    ["2001:2::1", "RESERVED"], // benchmarking
    ["2001:20::1", "RESERVED"], // ORCHIDv2
    ["3fff::1", "RESERVED"], // documentation (RFC 9637)
    ["100::1", "RESERVED"], // discard-only
    ["::ffff:0:7f00:1", "RESERVED"], // IPv4-translated
    ["4000::1", "RESERVED"], // outside global unicast 2000::/3
    ["2001:4860:4860::8888", "PUBLIC"],
    ["2a00:1450:4001:81c::200e", "PUBLIC"],
    ["not-an-ip", "RESERVED"],
  ])("[FO-06-20] %s is %s", (address, kind) => {
    expect(classifyAddress(address)).toBe(kind);
  });
});
