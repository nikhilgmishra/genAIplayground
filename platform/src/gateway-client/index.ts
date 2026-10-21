/**
 * Gateway client (WP-07): the generated operation table and body types of the gateway HTTP surface, and the
 * typed client over an injected HTTP port. The untrusted-output group and the HTTP-only clients import this
 * module only (platform/architecture/modules.yaml `gateway-client`).
 */
export { GatewayClient, GatewayClientError } from "./client.js";
export type { GatewayCallInput, GatewayClientOptions, GatewayHttp, GatewayHttpRequest, GatewayHttpResponse, GatewayResult } from "./client.js";
export { GATEWAY_API_VERSION, GATEWAY_CONTRACT_SHA256, GATEWAY_OPERATIONS } from "./operations.generated.js";
export type { ErrorBody, GatewayOperationId, GatewayOperationSpec, GatewayRequestBodies, GatewayResponseBodies } from "./operations.generated.js";
