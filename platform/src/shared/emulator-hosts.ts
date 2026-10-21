/**
 * Emulator endpoints (WP-07; FO-14-53, OPS-04): the only hosts an AWS endpoint override may name, and only in
 * the sandbox profile. One definition shared by the deployment guard (config/rules/infrastructure.ts) and the
 * AWS client factory of the live composition (adapters/live/aws-clients.ts), which checks it BEFORE any client
 * exists, so no signed request ever leaves for a host the guard would refuse.
 */

/** Emulator host names: `localhost`, `*.localhost`, `*.test` (RFC 6761) and the loopback literals. */
export function isEmulatorHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "localhost" || h.endsWith(".test") || h.endsWith(".localhost") || h === "127.0.0.1" || h === "[::1]";
}

/** An http(s) URL without credentials whose host is an emulator host. */
export function isEmulatorEndpoint(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (u.username !== "" || u.password !== "") return false;
  return isEmulatorHost(u.hostname);
}
