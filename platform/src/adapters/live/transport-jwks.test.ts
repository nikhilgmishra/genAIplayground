/**
 * JWKS resolver over the egress-classified transport (WP-07; FO-14-53, AUTH-01, DATA-01): the gateway's
 * inbound authenticator gets its keys only through OidcHttp, and the resolver refuses what a key set must never
 * contain. The http client below is a UNIT FAKE (labelled): it records requests and answers fixed JSON; the
 * real transport over a TLS listener is exercised by the composition Layer-2 suite (inbound-auth.test.ts).
 */
import { generateKeyPairSync } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import type { JWK } from "jose";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../../shared/clock.js";
import { DependencyError, ValidationError } from "../../shared/errors.js";
import type { OidcHttp } from "./oidc-http.js";
import { transportJwksResolver } from "./transport-jwks.js";

const URI = "https://idp.integration.example.com/jwks";

function keyPair(kid: string) {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pub = { ...(publicKey.export({ format: "jwk" }) as JWK), kid, alg: "ES256", use: "sig" };
  const priv = privateKey.export({ format: "jwk" }) as JWK;
  return { pub, privateKey, privJwk: { ...priv, kid } };
}

/** UNIT FAKE of OidcHttp: allowlist of one URI, a mutable JSON answer, a request log. */
function fakeHttp(answer: () => Record<string, unknown> | Error) {
  const requests: string[] = [];
  const http = {
    allows: (u: URL) => u.href === URI,
    preflight: () => undefined,
    getJson: async (u: URL) => {
      requests.push(u.href);
      const a = answer();
      if (a instanceof Error) throw a;
      return a;
    },
  } as unknown as OidcHttp;
  return { http, requests };
}

const sign = (privateKey: ReturnType<typeof keyPair>["privateKey"], kid: string) =>
  new SignJWT({ scope: "tools" }).setProtectedHeader({ alg: "ES256", kid }).setIssuer("https://idp.integration.example.com").setAudience("vsp-gateway").setIssuedAt().setExpirationTime("5m").sign(privateKey);

describe("transportJwksResolver [FO-14-53][AUTH-01]", () => {
  it("[AUTH-01] positive: verifies a token with the published key, fetched once through the transport and cached for the TTL", async () => {
    const k = keyPair("k1");
    const clock = new FakeClock("2026-10-21T00:00:00.000Z");
    const { http, requests } = fakeHttp(() => ({ keys: [k.pub] }));
    const getKey = transportJwksResolver({ http, jwksUri: URI, clock, ttlSeconds: 60 });
    const token = await sign(k.privateKey, "k1");
    expect((await jwtVerify(token, getKey)).payload.scope).toBe("tools");
    await jwtVerify(token, getKey);
    expect(requests).toEqual([URI]);
    clock.advanceMs(61_000);
    await jwtVerify(token, getKey);
    expect(requests).toEqual([URI, URI]);
  });

  it("[AUTH-01][DATA-01] adversarial: a key set that publishes PRIVATE key members is refused (JWKS_PRIVATE_KEY_PUBLISHED), never used", async () => {
    const k = keyPair("k1");
    const { http } = fakeHttp(() => ({ keys: [{ ...k.privJwk, alg: "ES256", use: "sig" }] }));
    const getKey = transportJwksResolver({ http, jwksUri: URI, clock: new FakeClock("2026-10-21T00:00:00.000Z") });
    const err = await jwtVerify(await sign(k.privateKey, "k1"), getKey).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(DependencyError);
    expect(err).toMatchObject({ reasonCode: "JWKS_PRIVATE_KEY_PUBLISHED", retryable: false });
    // Each private member alone is refused too (oct "k" and RSA members included).
    for (const m of ["d", "p", "q", "dp", "dq", "qi", "k", "oth"]) {
      const one = fakeHttp(() => ({ keys: [{ ...k.pub, [m]: "AAAA" }] }));
      const resolve = transportJwksResolver({ http: one.http, jwksUri: URI, clock: new FakeClock("2026-10-21T00:00:00.000Z") });
      const r = await Promise.resolve(resolve({ alg: "ES256", kid: "k1" }, { payload: "", signature: "" } as never)).then(() => null, (e: unknown) => e);
      expect(r, m).toMatchObject({ reasonCode: "JWKS_PRIVATE_KEY_PUBLISHED" });
    }
  });

  it("[AUTH-01] adversarial: an empty, malformed or encryption-only key set fails closed (JWKS_UNAVAILABLE); an unreachable IdP is JWKS_UNAVAILABLE, not acceptance", async () => {
    const k = keyPair("k1");
    const token = await sign(k.privateKey, "k1");
    for (const body of [{ keys: [] }, { keys: "x" }, { nokeys: true }, { keys: [{ ...k.pub, use: "enc" }] }, { keys: [{ kid: "no-kty" }] }]) {
      const { http } = fakeHttp(() => body as Record<string, unknown>);
      const err = await jwtVerify(token, transportJwksResolver({ http, jwksUri: URI, clock: new FakeClock("2026-10-21T00:00:00.000Z") })).then(() => null, (e: unknown) => e);
      expect(err, JSON.stringify(body)).toMatchObject({ reasonCode: "JWKS_UNAVAILABLE" });
    }
    const down = fakeHttp(() => new DependencyError("OIDC_PROVIDER_UNAVAILABLE", "UNKNOWN", true));
    const e = await jwtVerify(token, transportJwksResolver({ http: down.http, jwksUri: URI, clock: new FakeClock("2026-10-21T00:00:00.000Z") })).then(() => null, (x: unknown) => x);
    expect(e).toMatchObject({ reasonCode: "JWKS_UNAVAILABLE", outcome: "FAILED" });
  });

  it("[AUTH-01] rotation: an unknown kid refetches once, then the cooldown spaces further refetches (no refetch storm)", async () => {
    const k1 = keyPair("k1");
    const k2 = keyPair("k2");
    let published = [k1.pub];
    const clock = new FakeClock("2026-10-21T00:00:00.000Z");
    const { http, requests } = fakeHttp(() => ({ keys: published }));
    const getKey = transportJwksResolver({ http, jwksUri: URI, clock, refetchCooldownSeconds: 30 });
    await jwtVerify(await sign(k1.privateKey, "k1"), getKey);
    published = [k1.pub, k2.pub];
    await jwtVerify(await sign(k2.privateKey, "k2"), getKey);
    expect(requests).toHaveLength(2);
    const k3 = keyPair("k3");
    const unknown = await sign(k3.privateKey, "k3");
    expect(await jwtVerify(unknown, getKey).then(() => "accepted", () => "refused")).toBe("refused");
    expect(await jwtVerify(unknown, getKey).then(() => "accepted", () => "refused")).toBe("refused");
    expect(requests).toHaveLength(2);
    clock.advanceMs(31_000);
    expect(await jwtVerify(unknown, getKey).then(() => "accepted", () => "refused")).toBe("refused");
    expect(requests).toHaveLength(3);
  });

  it("[FO-14-53] configuration: only an https URI the transport's destination allows, without credentials or fragment, and a sane cache window", () => {
    const { http } = fakeHttp(() => ({ keys: [] }));
    const clock = new FakeClock("2026-10-21T00:00:00.000Z");
    for (const bad of ["http://idp.integration.example.com/jwks", "https://user:pw@idp.integration.example.com/jwks", `${URI}#frag`, "not a url"]) {
      expect(() => transportJwksResolver({ http, jwksUri: bad, clock }), bad).toThrow(ValidationError);
    }
    expect(() => transportJwksResolver({ http, jwksUri: "https://other.example.com/jwks", clock })).toThrow(/JWKS_URI_NOT_ALLOWED/);
    expect(() => transportJwksResolver({ http, jwksUri: URI, clock, ttlSeconds: 5 })).toThrow(/JWKS_CACHE_INVALID/);
  });
});
