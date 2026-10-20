# platform/src/connectors/http: the egress-classified transport (WP-06)

Status: **IMPLEMENTED**. The one module that opens outbound sockets (the ESLint configuration bans `fetch`,
`node:http(s)`, `net`, `tls`, `undici`, `axios` and `ws` everywhere else). It imports only observability,
the egress check, protocol and shared, so the untrusted-output group may use it (docs/ARCHITECTURE.md 6.4
rule 1).

`ConnectorHttpTransport.send(req)` performs one exchange:

* **Before any I/O:** https only; no userinfo, fragment or IP literal (every spelling); the host must be in
  the destination's exact allowlist (`CONNECTOR_HOST_NOT_ALLOWED`); headers and body size bounded; the
  `EgressGuard` is checked **per request** for the payload's data class (FO-15-19).
* **DNS:** every answer is classified (PUBLIC, PRIVATE, LOOPBACK, LINK_LOCAL, RESERVED) against the
  destination's address class; one bad answer refuses the name (rebinding defence), and the connection is
  pinned to the checked address with the original server name for TLS: the name is resolved once per
  request and never again for the connection (Layer 2, `test/integration/connectors/pinning.test.ts`, proves
  the socket reaches the checked answer on a private host interface). IPv4-mapped / compatible and NAT64
  addresses are classified as the IPv4 address they embed; an IPv6 address is PUBLIC only inside global
  unicast 2000::/3 and outside the transition and special-purpose blocks (6to4 2002::/16, Teredo and the
  rest of 2001::/23, documentation 2001:db8::/32 and 3fff::/20), which are RESERVED whatever they embed.
* **During the exchange:** redirects are refused (their Location is never contacted); response bodies are
  bounded (declared length and streamed); the deadline covers DNS, connect, TLS and the response.
* **Failure phases:** `TransportError` carries the phase (PRE_IO, CONNECT, TLS, SENT, RESPONSE) and whether the
  request was sent: NOT_STARTED before send; after send a write is UNKNOWN (never retried) and a read a
  retryable FAILED.
* **Emulator routes:** `loopbackRoutes` send a named host to 127.0.0.1 (plain HTTP for Layer-1 unit runs, TLS
  with the name verified against `tlsCa` in Layer 2); they exist only in `local` and `ci` and a deployed
  environment refuses them at construction.

Test: `cd platform && npx vitest run src/connectors/http`.
