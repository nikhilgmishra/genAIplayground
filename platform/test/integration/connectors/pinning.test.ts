/**
 * Layer 2 (WP-06; FO-06-20, SAFE-05): the egress-classified transport connects to the address it checked.
 *
 * The transport resolves a destination name once, checks every answer against the destination's address
 * class, and pins the connection to that answer (no second resolution: the DNS-rebinding defence). The
 * Layer-1 tests reach their servers through loopback emulator routes, which bypass resolution; this test
 * runs the resolver path for real. A TLS server (private test CA, the server name verified) listens ONLY
 * on a private (RFC 1918) interface of this host, which the compose project's bridge network provides while
 * the local composition runs. The injected resolver answers that address for the vendor's name and, if it
 * were asked again, a loopback address (a rebinding attempt): the request must arrive on the private
 * interface, from a client socket whose remote address is the checked answer, after exactly one lookup.
 * What it does not prove: real DNS, a vendor's network, or TLS policy beyond the private test CA.
 */
import { channel } from "node:diagnostics_channel";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { classifyAddress } from "../../../src/connectors/http/address.js";
import { ConnectorHttpTransport, TransportError } from "../../../src/connectors/http/transport.js";
import type { ResolvedAddress } from "../../../src/connectors/http/transport.js";
import { EgressGuard } from "../../../src/privacy/egress.js";
import { layer2 } from "../_harness/layer2.js";
import { API_HOST } from "./profiles.js";
import { createTestPki } from "./support.js";
import type { TestPki } from "./support.js";

const it = layer2.withoutServices("the transport's address pinning runs against a TLS server on a private host interface; no emulator container is used", ["the compose project's bridge network interface on this host (a private IPv4 address)"]);

let pki: TestPki;
beforeAll(() => {
  pki = createTestPki();
});
afterAll(() => pki?.dispose());

/** A private IPv4 address of a host interface (the compose bridge while the local composition runs). */
function privateInterfaceAddress(): string {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal && classifyAddress(a.address) === "PRIVATE") return a.address;
  }
  // A precondition of Layer 2 (the compose bridge), never a skip: an unrun check is not a pass (OPS-03).
  throw new Error("LAYER2_PRIVATE_INTERFACE_MISSING: no private IPv4 host interface; start the composition with make up PROFILE=core");
}

describe("connection pinning to the checked DNS answer [FO-06-20][SAFE-05]", () => {
  it("[FO-06-20][SAFE-05] the connection goes to the address the resolver answered and the address check accepted, resolved exactly once; a rebinding answer on a second lookup is never used", async () => {
    const address = privateInterfaceAddress();
    const arrivals: { localAddress: string | undefined }[] = [];
    const server = createServer({ cert: pki.certPem, key: pki.keyPem }, (req: IncomingMessage, res: ServerResponse) => {
      arrivals.push({ localAddress: req.socket.localAddress });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, address, resolve));
    const port = (server.address() as AddressInfo).port;
    // Client sockets created by the transport (node:net publishes each one on this channel).
    const remotes: (string | undefined)[] = [];
    const onSocket = (msg: unknown) => {
      const socket = (msg as { socket: Socket }).socket;
      socket.once("connect", () => remotes.push(socket.remoteAddress));
    };
    const sockets = channel("net.client.socket");
    sockets.subscribe(onSocket);
    try {
      const lookups: string[] = [];
      const resolve = async (hostname: string): Promise<ResolvedAddress[]> => {
        lookups.push(hostname);
        // First answer: the private interface (accepted for a PRIVATE_NETWORK destination). Any later lookup
        // would rebind the name to loopback, which the address check never accepts.
        return lookups.length === 1 ? [{ address, family: 4 }] : [{ address: "127.0.0.1", family: 4 }];
      };
      // The destination is approved for INTERNAL payloads on this exact host and port (local only).
      const egress = new EgressGuard(
        {
          policyVersion: "egress-pinning-test-1",
          destinations: [{ destinationId: "egr_scheduling_pinned", kind: "SYSTEM_OF_RECORD", hosts: [`${API_HOST}:${port}`], allowedClasses: ["INTERNAL"], coverage: { baaRef: null, approvalId: null }, environments: ["local"], adapterKind: "live" }],
        },
        { environment: "local" },
      );
      const transport = new ConnectorHttpTransport({ environment: "local", egress, resolve, tlsCa: [pki.caPem] });
      const send = () =>
        transport.send({
          method: "GET",
          url: new URL(`https://${API_HOST}:${port}/api/v1/ping`),
          headers: { accept: "application/json" },
          body: null,
          policy: { allowedHosts: [API_HOST], addressClass: "PRIVATE_NETWORK", dataClass: "INTERNAL" },
          sideEffect: false,
          timeoutMs: 5_000,
          dependency: "scheduling",
        });
      const res = await send();
      expect([res.status, JSON.parse(res.body.toString("utf8"))]).toEqual([200, { ok: true }]);
      // One lookup for one request, and the socket went to exactly that answer (the server listens nowhere else).
      expect(lookups).toEqual([API_HOST]);
      expect(remotes).toEqual([address]);
      expect(arrivals).toEqual([{ localAddress: address }]);
      // A second request resolves again; this time the answer is loopback: refused before any connection.
      const e = (await send().then(() => null, (x: unknown) => x)) as TransportError;
      expect([e.constructor.name, e.reasonCode, e.phase, e.requestSent]).toEqual(["TransportError", "CONNECTOR_ADDRESS_NOT_ALLOWED", "PRE_IO", false]);
      expect([lookups.length, remotes.length, arrivals.length]).toEqual([2, 1, 1]);
    } finally {
      sockets.unsubscribe(onSocket);
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
