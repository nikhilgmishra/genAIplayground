/**
 * `verify-audit`: the separate audit verifier as a command (follow-on FO-19-82, FO-15-40, FO-22-08).
 *
 *   tsx scripts/vsp/verify-audit.mts --env local --database <name> [--bucket <name>] [--kms-key <key-id>]
 *                                    [--from <ISO>] [--to <ISO>] [--prefix audit/] [--json <file>]
 *   tsx scripts/vsp/verify-audit.mts --env live   (needs VSP_AUDIT_VERIFY_LIVE=1 under scoped authority)
 *
 * Exit codes: 0 PASS; 1 FAIL; 2 INCONCLUSIVE (never a pass); 3 usage or configuration; 4 dependency
 * unreachable. Implementation and the full description: platform/src/audit/exporter/verify-cli.ts.
 *
 * Composition of the local run: the STS call that derives the verifier's read-only sink credentials goes
 * through the egress-classified transport (platform/src/connectors/http) to exactly one allowlisted
 * destination, the local MinIO STS endpoint, routed to its loopback port (a local-environment route; a
 * deployed environment refuses loopback routes).
 */
import { ConnectorHttpTransport } from "../../platform/src/connectors/http/index.ts";
import { LOCAL_STS_HOST, localStsRoute, runVerifyAuditCli } from "../../platform/src/audit/exporter/verify-cli.ts";
import type { StsHttpPost } from "../../platform/src/audit/exporter/sts.ts";

const route = localStsRoute();
const transport = new ConnectorHttpTransport({
  environment: "local",
  egress: {
    assertAllowed(target: URL) {
      if (target.hostname !== LOCAL_STS_HOST) throw new Error("EGRESS_DESTINATION_NOT_ALLOWED");
    },
  },
  loopbackRoutes: new Map([[route.host, { port: route.port, tls: false }]]),
});
const stsHttp: StsHttpPost = {
  async post(url, headers, body) {
    const r = await transport.send({
      method: "POST",
      url,
      headers,
      body,
      policy: { allowedHosts: [LOCAL_STS_HOST], addressClass: "PRIVATE_NETWORK", dataClass: "INTERNAL" },
      sideEffect: false,
      timeoutMs: 10_000,
      dependency: "audit_sts",
    });
    return { status: r.status, body: r.body.toString("utf8") };
  },
};

runVerifyAuditCli(process.argv.slice(2), { stsHttp }).then(
  (code) => process.exit(code),
  () => process.exit(4),
);
