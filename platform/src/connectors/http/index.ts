/**
 * Egress-classified HTTP transport (WP-06; FO-06-20, FO-15-19). Imports only protocol, shared,
 * observability and node built-ins, so the untrusted-output group (models, harness, media) may use it
 * (docs/ARCHITECTURE.md section 6.4 rule 1). See README.md.
 */
export { ConnectorHttpTransport, DEFAULT_MAX_REQUEST_BYTES, DEFAULT_MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES_LIMIT, TransportError } from "./transport.js";
export type { DestinationPolicy, EgressCheck, LoopbackRoute, ResolvedAddress, Resolver, TransportOptions, TransportPhase, TransportRequest, TransportResponse } from "./transport.js";
export { addressesPermitted, classifyAddress, isIpLiteral, permittedKinds } from "./address.js";
export type { AddressKind } from "./address.js";
