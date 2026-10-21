/**
 * Address and range parsing for the trusted-proxy rule and the console sign-in limiter (WP-07; STRIDE D).
 */
import { describe, expect, it } from "vitest";
import { addressBucket, clientAddress, inCidr, isPrivateCidr, parseCidr, parseIp } from "./cidr.js";
import { isEmulatorEndpoint, isEmulatorHost } from "./emulator-hosts.js";

const ip = (s: string) => {
  const a = parseIp(s);
  if (!a) throw new Error(`unparsable ${s}`);
  return a;
};
const cidr = (s: string) => {
  const c = parseCidr(s);
  if (!c) throw new Error(`unparsable ${s}`);
  return c;
};

describe("cidr helpers [STRIDE-D]", () => {
  it("parses IPv4 and IPv6 (compressed, embedded IPv4, bracketed); IPv4-mapped addresses fold to IPv4; malformed literals are refused", () => {
    expect(ip("10.0.0.1")).toEqual({ family: 4, value: 0x0a000001n });
    expect(ip("::ffff:10.1.2.3")).toEqual({ family: 4, value: 0x0a010203n });
    expect(ip("[::1]")).toEqual({ family: 6, value: 1n });
    expect(ip("2001:db8::1")).toEqual(ip("2001:db8:0:0:0:0:0:1"));
    for (const bad of ["1.2.3.256", "01.2.3.4", "1.2.3", "1::2::3", "2001:db8:::1", "12345::", "", "localhost", "1.2.3.4/32"]) expect(parseIp(bad), bad).toBeNull();
  });

  it("parses ranges strictly (no host bits below the prefix); private space only for trusted proxies", () => {
    expect(parseCidr("10.0.0.1/8")).toBeNull();
    expect(parseCidr("10.0.0.0/33")).toBeNull();
    expect(parseCidr("::/129")).toBeNull();
    for (const p of ["10.0.0.0/8", "10.40.16.0/20", "172.16.0.0/12", "192.168.4.0/24", "127.0.0.1/32", "100.64.0.0/10", "fd00:10::/48", "::1/128"]) expect(isPrivateCidr(cidr(p)), p).toBe(true);
    for (const p of ["0.0.0.0/0", "10.0.0.0/7", "172.0.0.0/8", "8.8.8.0/24", "2001:db8::/32", "::/0", "fe80::/10"]) expect(isPrivateCidr(cidr(p)), p).toBe(false);
    expect(inCidr(ip("10.40.31.255"), cidr("10.40.16.0/20"))).toBe(true);
    expect(inCidr(ip("10.40.32.0"), cidr("10.40.16.0/20"))).toBe(false);
    expect(inCidr(ip("10.40.17.1"), cidr("fd00::/8"))).toBe(false);
  });

  it("[STRIDE-D] client address: an untrusted peer's X-Forwarded-For is ignored; through trusted proxies the right-most untrusted entry is the client", () => {
    const trusted = [cidr("10.40.0.0/16")];
    expect(clientAddress("198.51.100.9", "203.0.113.1", trusted)).toEqual(ip("198.51.100.9"));
    expect(clientAddress("10.40.1.5", "198.51.100.7", trusted)).toEqual(ip("198.51.100.7"));
    // A client-supplied left-most entry never wins over what the proxies appended.
    expect(clientAddress("10.40.1.5", "192.0.2.1, 198.51.100.7, 10.40.2.2", trusted)).toEqual(ip("198.51.100.7"));
    expect(clientAddress("10.40.1.5", ["192.0.2.1", "198.51.100.7"], trusted)).toEqual(ip("198.51.100.7"));
    // No header, or garbage: the peer itself.
    expect(clientAddress("10.40.1.5", undefined, trusted)).toEqual(ip("10.40.1.5"));
    expect(clientAddress("10.40.1.5", "not-an-address", trusted)).toEqual(ip("10.40.1.5"));
    // No trusted ranges configured: always the peer.
    expect(clientAddress("10.40.1.5", "198.51.100.7", [])).toEqual(ip("10.40.1.5"));
    expect(clientAddress("::ffff:198.51.100.9", undefined, trusted)).toEqual(ip("198.51.100.9"));
    expect(clientAddress(undefined, "198.51.100.7", trusted)).toBeNull();
  });

  it("[STRIDE-D] buckets: one per IPv4 address, one per IPv6 /64 (an end site cannot spray keys)", () => {
    expect(addressBucket(ip("2001:db8:1:2::1"))).toBe(addressBucket(ip("2001:db8:1:2:ffff:ffff:ffff:ffff")));
    expect(addressBucket(ip("2001:db8:1:2::1"))).not.toBe(addressBucket(ip("2001:db8:1:3::1")));
    expect(addressBucket(ip("198.51.100.7"))).not.toBe(addressBucket(ip("198.51.100.8")));
  });

  it("[FO-14-53] emulator hosts: localhost, *.localhost, *.test and loopback only; endpoints are http(s) without credentials", () => {
    for (const h of ["localhost", "LOCALHOST", "kms.vsp.test", "sm.emulator.localhost", "127.0.0.1", "[::1]"]) expect(isEmulatorHost(h), h).toBe(true);
    for (const h of ["10.0.0.1", "localhost.example.com", "test", "example.test.com", "127.0.0.2"]) expect(isEmulatorHost(h), h).toBe(false);
    expect(isEmulatorEndpoint("http://localhost:4566")).toBe(true);
    for (const u of ["http://user:pw@localhost:4566", "ftp://localhost", "localhost:4566", "http://10.0.0.1"]) expect(isEmulatorEndpoint(u), u).toBe(false);
  });
});
