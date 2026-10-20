/**
 * IP address classification for the egress-classified transport (FO-06-20: DNS-rebinding defence).
 * A hostname is resolved once, every resolved address is classified, and the connection is pinned to an
 * address that the destination's address class permits; the transport never re-resolves between the
 * check and the connect. Loopback, link-local (including the 169.254.169.254 instance-metadata address),
 * multicast, unspecified and reserved ranges are never a connector destination.
 */
import { isIP } from "node:net";

export type AddressKind = "PUBLIC" | "PRIVATE" | "LOOPBACK" | "LINK_LOCAL" | "RESERVED";

function v4Kind(a: number, b: number): AddressKind {
  if (a === 127) return "LOOPBACK";
  if (a === 169 && b === 254) return "LINK_LOCAL";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return "PRIVATE";
  // 0/8, multicast 224/4, reserved 240/4, broadcast, documentation and benchmarking ranges.
  if (a === 0 || a >= 224 || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0)) return "RESERVED";
  return "PUBLIC";
}

function parseV4(s: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const parts = [m[1], m[2], m[3], m[4]].map(Number) as [number, number, number, number];
  return parts.every((p) => p <= 255) ? parts : null;
}

/** Expands an IPv6 address into eight 16-bit groups (embedded IPv4 tail supported). */
function parseV6(s: string): number[] | null {
  let addr = s.toLowerCase();
  const zone = addr.indexOf("%");
  if (zone >= 0) addr = addr.slice(0, zone);
  let tail: number[] = [];
  const lastColon = addr.lastIndexOf(":");
  const maybeV4 = addr.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    const v4 = parseV4(maybeV4);
    if (!v4) return null;
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    addr = `${addr.slice(0, lastColon + 1)}0:0`;
  }
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - rest.length;
  if ((halves.length === 1 && fill !== 0) || fill < 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...rest].map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : Number.NaN));
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g))) return null;
  if (tail.length === 2) {
    groups[6] = tail[0] ?? 0;
    groups[7] = tail[1] ?? 0;
  }
  return groups;
}

export function classifyAddress(address: string): AddressKind {
  const fam = isIP(address);
  if (fam === 4) {
    const p = parseV4(address);
    return p ? v4Kind(p[0], p[1]) : "RESERVED";
  }
  if (fam !== 6) return "RESERVED";
  const g = parseV6(address);
  if (!g) return "RESERVED";
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible forms are classified as the embedded IPv4 address.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) {
    if (g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) return g7 === 1 ? "LOOPBACK" : "RESERVED";
    return v4Kind(g6 >> 8, g6 & 0xff);
  }
  if ((g0 & 0xffc0) === 0xfe80) return "LINK_LOCAL";
  if ((g0 & 0xfe00) === 0xfc00) return "PRIVATE";
  if ((g0 & 0xff00) === 0xff00) return "RESERVED"; // multicast
  if (g0 === 0x0064 && g1 === 0xff9b) return v4Kind(g6 >> 8, g6 & 0xff); // NAT64 well-known prefix (RFC 6052 / 8215)
  // Global unicast is 2000::/3; everything else (the rest of ::/8, 100::/64 discard, unassigned space) is not a destination.
  if ((g0 & 0xe000) !== 0x2000) return "RESERVED";
  // Transition and special-purpose blocks that tunnel to, or embed, another address: 6to4 2002::/16 (an
  // embedded IPv4 such as 2002:7f00:1:: is loopback), Teredo 2001::/32 and the rest of the IETF protocol
  // assignments 2001::/23 (benchmarking, ORCHID); documentation 2001:db8::/32 and 3fff::/20.
  if (g0 === 0x2002) return "RESERVED";
  if (g0 === 0x2001 && g1 < 0x0200) return "RESERVED";
  if (g0 === 0x2001 && g1 === 0x0db8) return "RESERVED";
  if ((g0 & 0xfff0) === 0x3ff0) return "RESERVED";
  return "PUBLIC";
}

/** True for an IP literal (v4, v6 or bracketed v6): connectors address hosts by DNS name only. */
export function isIpLiteral(hostname: string): boolean {
  const h = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (isIP(h) !== 0) return true;
  // Numeric forms WHATWG URL parsing would canonicalise into an IPv4 address (e.g. 2130706433, 0x7f.1).
  return /^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+)){0,3}$/i.test(h);
}

/** Address kinds a destination's address class permits (loopback only through an explicit local/ci emulator route). */
export function permittedKinds(addressClass: "PUBLIC_INTERNET" | "PRIVATE_NETWORK"): ReadonlySet<AddressKind> {
  return new Set(addressClass === "PUBLIC_INTERNET" ? ["PUBLIC"] : ["PRIVATE"]);
}

/** True when every resolved address belongs to a kind the destination's address class permits. */
export function addressesPermitted(addresses: readonly string[], addressClass: "PUBLIC_INTERNET" | "PRIVATE_NETWORK"): boolean {
  const allowed = permittedKinds(addressClass);
  return addresses.length > 0 && addresses.every((a) => allowed.has(classifyAddress(a)));
}
