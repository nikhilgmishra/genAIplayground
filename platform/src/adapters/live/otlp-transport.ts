/**
 * OTLP/HTTP sender over the egress-classified transport (WP-07; FO-03-30, FO-14-53, DATA-01, AIN-37).
 *
 * The telemetry exporters (observability/otlp.ts) hand an already content-free OTLP JSON body to this sender.
 * It posts it through the ConnectorHttpTransport: https only, the collector host on the destination's exact
 * allowlist, the address class of the collector (an in-VPC collector is PRIVATE_NETWORK), the EgressGuard
 * checked for every request with data class INTERNAL (a telemetry destination accepts content-free classes
 * only), no redirects, bounded bodies and a deadline. A refusal or a transport failure is thrown with its
 * reason code; the exporter counts it (vsp_telemetry_export_total{result}) and never throws into the SDK.
 */
import type { DestinationPolicy, TransportRequest, TransportResponse } from "../../connectors/http/transport.js";
import type { OtlpPost } from "../../observability/otlp.js";
import { ValidationError } from "../../shared/errors.js";

export interface OtlpTransport {
  send(req: TransportRequest): Promise<TransportResponse>;
}

const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export class TransportOtlpPost implements OtlpPost {
  private readonly allowed: ReadonlySet<string>;

  constructor(
    private readonly transport: OtlpTransport,
    private readonly destination: { allowedHosts: readonly string[]; addressClass: DestinationPolicy["addressClass"] },
  ) {
    if (destination.allowedHosts.length === 0 || destination.allowedHosts.length > 4 || !destination.allowedHosts.every((h) => HOST.test(h))) throw new ValidationError("OTLP_DESTINATION_INVALID");
    this.allowed = new Set(destination.allowedHosts);
  }

  async post(url: URL, body: string, timeoutMs: number): Promise<{ status: number }> {
    if (url.protocol !== "https:" || !this.allowed.has(url.hostname.toLowerCase()) || url.username || url.password || url.search || url.hash) {
      throw new ValidationError("OTLP_ENDPOINT_NOT_ALLOWED");
    }
    const res = await this.transport.send({
      method: "POST",
      url,
      headers: { "content-type": "application/json", accept: "application/json" },
      body,
      policy: { allowedHosts: [...this.allowed], addressClass: this.destination.addressClass, dataClass: "INTERNAL" },
      // Re-sending a batch duplicates cumulative points at worst; never an external effect.
      sideEffect: false,
      timeoutMs,
      dependency: "telemetry",
    });
    return { status: res.status };
  }
}
