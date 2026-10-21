/**
 * IP address and CIDR helpers without a network module (WP-07; STRIDE D, OPS-01).
 *
 * Used by the deployment guard (the load balancer ranges of `infrastructure.trustedProxyCidrs` must be private
 * address space) and by the live console's sign-in rate limit (which client a request comes from: the socket
 * peer, or, only when that peer is a trusted proxy, the address the proxy appended to X-Forwarded-For).
 * Pure parsing: nothing here resolves, connects or reads the environment.
 */

export interface IpAddress {
  family: 4 | 6;
  value: bigint;
}

export interface Cidr {
  family: 4 | 6;
  base: bigint;
  prefix: number;
}

function parseV4(s: string): bigint | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  let v = 0n;
  for (const p of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    v = (v << 8n) | BigInt(n);
  }
  return v;
}

function parseV6(raw: string): bigint | null {
  let s = raw.toLowerCase();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  if (!/^[0-9a-f:.]{2,45}$/.test(s)) return null;
  // An embedded IPv4 suffix (::ffff:192.0.2.1) becomes its two 16-bit words.
  const lastColon = s.lastIndexOf(":");
  if (lastColon < 0) return null;
  if (s.slice(lastColon + 1).includes(".")) {
    const v4 = parseV4(s.slice(lastColon + 1));
    if (v4 === null) return null;
    s = `${s.slice(0, lastColon + 1)}${((v4 >> 16n) & 0xffffn).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const words = (h: string): bigint[] | null => {
    if (h === "") return [];
    const out: bigint[] = [];
    for (const w of h.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(w)) return null;
      out.push(BigInt(parseInt(w, 16)));
    }
    return out;
  };
  const head = words(halves[0] ?? "");
  const rest = halves.length === 2 ? words(halves[1] ?? "") : [];
  if (!head || !rest) return null;
  const given = head.length + rest.length;
  if (halves.length === 1 ? given !== 8 : given > 7) return null;
  const all = [...head, ...new Array<bigint>(8 - given).fill(0n), ...rest];
  return all.reduce((acc, w) => (acc << 16n) | w, 0n);
}

/** Parses an IPv4 or IPv6 literal; an IPv4-mapped IPv6 address (::ffff:a.b.c.d) is returned as IPv4. */
export function parseIp(s: string): IpAddress | null {
  if (typeof s !== "string" || s.length === 0 || s.length > 64) return null;
  const v4 = parseV4(s);
  if (v4 !== null) return { family: 4, value: v4 };
  const v6 = parseV6(s);
  if (v6 === null) return null;
  if (v6 >> 32n === 0xffffn) return { family: 4, value: v6 & 0xffffffffn };
  return { family: 6, value: v6 };
}

/** Parses `a.b.c.d/n` or `<ipv6>/n`; the base must have no bits set below the prefix. */
export function parseCidr(s: string): Cidr | null {
  if (typeof s !== "string") return null;
  const slash = s.indexOf("/");
  if (slash < 0 || !/^\d{1,3}$/.test(s.slice(slash + 1))) return null;
  const prefix = Number(s.slice(slash + 1));
  const literal = s.slice(0, slash);
  const v4 = parseV4(literal);
  const family: 4 | 6 = v4 !== null ? 4 : 6;
  const value = v4 ?? parseV6(literal);
  if (value === null) return null;
  const bits = family === 4 ? 32 : 128;
  if (prefix > bits) return null;
  const host = (1n << BigInt(bits - prefix)) - 1n;
  if ((value & host) !== 0n) return null;
  if (family === 6 && value >> 32n === 0xffffn && prefix >= 96) return { family: 4, base: value & 0xffffffffn, prefix: prefix - 96 };
  return { family, base: value, prefix };
}

export function inCidr(addr: IpAddress, cidr: Cidr): boolean {
  if (addr.family !== cidr.family) return false;
  const bits = addr.family === 4 ? 32 : 128;
  return addr.value >> BigInt(bits - cidr.prefix) === cidr.base >> BigInt(bits - cidr.prefix);
}

const PRIVATE_V4: readonly Cidr[] = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8", "100.64.0.0/10"].map((c) => parseCidr(c) as Cidr);
const PRIVATE_V6: readonly Cidr[] = ["fc00::/7", "::1/128"].map((c) => parseCidr(c) as Cidr);

/** True when the whole range lies in private (RFC 1918, shared, loopback, ULA) address space. */
export function isPrivateCidr(cidr: Cidr): boolean {
  const ranges = cidr.family === 4 ? PRIVATE_V4 : PRIVATE_V6;
  return ranges.some((r) => cidr.prefix >= r.prefix && inCidr({ family: cidr.family, value: cidr.base }, r));
}

/**
 * The client of a request: the socket peer, unless that peer lies in a trusted proxy range, in which case the
 * right-most X-Forwarded-For entry that is not itself a trusted proxy (the address the outermost trusted proxy
 * saw). A client cannot move itself to another key by sending X-Forwarded-For: an untrusted peer's header is
 * ignored, and through a trusted proxy only the entries the proxies appended count. Unparsable: the peer.
 */
export function clientAddress(peer: string | undefined, forwardedFor: string | readonly string[] | undefined, trusted: readonly Cidr[]): IpAddress | null {
  const p = parseIp(peer ?? "");
  if (!p) return null;
  if (trusted.length === 0 || !trusted.some((c) => inCidr(p, c))) return p;
  const header = Array.isArray(forwardedFor) ? forwardedFor.join(",") : typeof forwardedFor === "string" ? forwardedFor : "";
  const hops = header
    .split(",")
    .map((h) => h.trim())
    .filter((h) => h.length > 0)
    .slice(-32);
  for (let i = hops.length - 1; i >= 0; i--) {
    const a = parseIp(hops[i] ?? "");
    if (!a) return p;
    if (!trusted.some((c) => inCidr(a, c))) return a;
  }
  return p;
}

/** Rate-limit bucket of an address: the IPv4 address, or the IPv6 /64 (one end site cannot spray keys). */
export function addressBucket(a: IpAddress): string {
  if (a.family === 4) return `v4:${a.value.toString(16)}`;
  return `v6:${(a.value >> 64n).toString(16)}`;
}
