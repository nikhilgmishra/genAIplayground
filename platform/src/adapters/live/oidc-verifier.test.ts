/**
 * JwksOidcVerifier tests. Keys are LOCAL FIXTURE keys from LocalOidcProviderFixture.
 * Two key paths are exercised: (1) an injected jose createLocalJWKSet resolver and
 * (2) the real createRemoteJWKSet fetching from an in-process HTTP server bound to
 * 127.0.0.1 (no external network). No real IdP was contacted.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SignJWT, createLocalJWKSet } from "jose";
import { IDP, PEOPLE } from "../../fixtures/synthetic-world.js";
import { FakeClock } from "../../shared/clock.js";
import { AccessDeniedError, DependencyError, ValidationError } from "../../shared/errors.js";
import { LocalOidcProviderFixture } from "../local/oidc-fixture.js";
import { JwksOidcVerifier } from "./oidc-verifier.js";
import type { TrustedIssuer } from "./oidc-verifier.js";

const NONCE = "Q".repeat(43);
const AUD = IDP.portalAudience;

async function injected() {
  const clock = new FakeClock();
  const idp = await LocalOidcProviderFixture.create({ clock });
  const verifier = new JwksOidcVerifier({
    integrationId: "oidc-client-idp",
    issuers: idp.trustedIssuers(AUD),
    clock,
    keyResolverFactory: (i: TrustedIssuer) => (h, t) => createLocalJWKSet(idp.jwks(i.issuer))(h, t),
  });
  return { clock, idp, verifier };
}

const reason = async (p: Promise<unknown>) => {
  try {
    await p;
    return "NO_ERROR";
  } catch (e) {
    return (e as { reasonCode?: string }).reasonCode ?? "UNTYPED";
  }
};

describe("JwksOidcVerifier (kind live) with injected local JWKS", () => {
  it("[SPEC-7.OIDC] accepts a valid ID token and extracts only the needed claims", async () => {
    const { idp, verifier } = await injected();
    expect(verifier.kind).toBe("live");
    const token = await idp.issueFor(PEOPLE.avery, { nonce: NONCE, amr: ["mfa"], acr: "urn:local:mfa" });
    const claims = await verifier.verifyIdToken(token, { nonce: NONCE, maxAuthAgeSeconds: 900 });
    expect(claims).toEqual({ issuer: IDP.clientIssuer, sub: PEOPLE.avery.idpSubject, audience: AUD, nonce: NONCE, authTime: 1792249200, amr: ["mfa"], acr: "urn:local:mfa" });
  });

  it("[SPEC-7.OIDC] rejects untrusted issuer, wrong audience, nonce mismatch, expiry, stale auth_time, future auth_time and missing claims", async () => {
    const { idp, verifier, clock } = await injected();
    const now = Math.floor(clock.now().getTime() / 1000);
    const untrustedIdp = await LocalOidcProviderFixture.create({ clock, issuers: ["https://evil.local.invalid"] });
    const cases: [string, Promise<string>][] = [
      ["OIDC_ISSUER_NOT_TRUSTED", untrustedIdp.issueIdToken({ issuer: "https://evil.local.invalid", sub: "x", nonce: NONCE })],
      ["OIDC_AUDIENCE_MISMATCH", idp.issueFor(PEOPLE.avery, { nonce: NONCE, audience: "other-client" })],
      ["OIDC_NONCE_MISMATCH", idp.issueFor(PEOPLE.avery, { nonce: "Z".repeat(43) })],
      ["OIDC_AUTH_TOO_OLD", idp.issueFor(PEOPLE.avery, { nonce: NONCE, authTime: now - 906 })],
      ["OIDC_AUTH_TIME_IN_FUTURE", idp.issueFor(PEOPLE.avery, { nonce: NONCE, authTime: now + 60 })],
      ["OIDC_REQUIRED_CLAIM_MISSING", idp.issueFor(PEOPLE.avery, { nonce: NONCE, authTime: null })],
      ["OIDC_TOKEN_TOO_OLD", idp.issueFor(PEOPLE.avery, { nonce: NONCE, issuedAt: now - 700, ttlSeconds: 3600, authTime: now - 10 })],
      ["OIDC_AZP_MISMATCH", idp.issueFor(PEOPLE.avery, { nonce: NONCE, audience: [AUD, "other-client"] })],
      ["OIDC_AZP_MISMATCH", idp.issueFor(PEOPLE.avery, { nonce: NONCE, azp: "other-client" })],
      ["OIDC_SIGNATURE_INVALID", idp.issueFor(PEOPLE.avery, { nonce: NONCE, signWithUntrustedKey: true })],
    ];
    for (const [expected, tokenP] of cases) {
      expect([expected, await reason(verifier.verifyIdToken(await tokenP, { nonce: NONCE, maxAuthAgeSeconds: 900 }))]).toEqual([expected, expected]);
    }
    const expiring = await idp.issueFor(PEOPLE.avery, { nonce: NONCE, ttlSeconds: 60 });
    clock.advanceSeconds(66);
    expect(await reason(verifier.verifyIdToken(expiring, { nonce: NONCE, maxAuthAgeSeconds: 900 }))).toBe("OIDC_TOKEN_EXPIRED");
  });

  it("[SPEC-7.OIDC] multi-audience tokens are accepted only with azp equal to our client id", async () => {
    const { idp, verifier } = await injected();
    const ok = await idp.issueFor(PEOPLE.avery, { nonce: NONCE, audience: [AUD, "other-client"], azp: AUD });
    await expect(verifier.verifyIdToken(ok, { nonce: NONCE, maxAuthAgeSeconds: 900 })).resolves.toBeTruthy();
  });

  it("[SPEC-7.OIDC] rejects alg none, HMAC-signed and malformed tokens; errors carry no token content", async () => {
    const { verifier, clock } = await injected();
    const now = Math.floor(clock.now().getTime() / 1000);
    const body = { iss: IDP.clientIssuer, aud: AUD, sub: PEOPLE.avery.idpSubject, iat: now, exp: now + 60, nonce: NONCE, auth_time: now, amr: ["mfa"] };
    const none = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify(body)).toString("base64url")}.`;
    expect(await reason(verifier.verifyIdToken(none, { nonce: NONCE, maxAuthAgeSeconds: 900 }))).toBe("OIDC_TOKEN_MALFORMED");
    const hs = await new SignJWT(body).setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode("s".repeat(32)));
    const err = (await verifier.verifyIdToken(hs, { nonce: NONCE, maxAuthAgeSeconds: 900 }).catch((e: unknown) => e)) as AccessDeniedError;
    expect(err).toBeInstanceOf(AccessDeniedError);
    expect(err.reasonCode).toBe("OIDC_ALG_NOT_ALLOWED");
    expect(err.message).not.toContain(PEOPLE.avery.idpSubject);
    expect(await reason(verifier.verifyIdToken("abc", { nonce: NONCE, maxAuthAgeSeconds: 900 }))).toBe("OIDC_TOKEN_MALFORMED");
    expect(await reason(verifier.verifyIdToken(hs, { nonce: "short", maxAuthAgeSeconds: 900 }))).toBe("OIDC_EXPECTATION_INVALID");
  });

  it("[SPEC-7.OIDC] configuration is validated: https issuers/JWKS only, no duplicates, supported algorithms", () => {
    const clock = new FakeClock();
    const ok: TrustedIssuer = { issuer: "https://idp.example.invalid", audience: "client-1", jwksUri: "https://idp.example.invalid/jwks" };
    expect(() => new JwksOidcVerifier({ integrationId: "oidc-client-idp", issuers: [{ ...ok, jwksUri: "http://idp.example.invalid/jwks" }], clock })).toThrow(ValidationError);
    expect(() => new JwksOidcVerifier({ integrationId: "oidc-client-idp", issuers: [{ ...ok, jwksUri: "http://127.0.0.1:9/jwks" }], clock })).toThrow(ValidationError);
    expect(() => new JwksOidcVerifier({ integrationId: "oidc-client-idp", issuers: [ok, ok], clock })).toThrow(ValidationError);
    expect(() => new JwksOidcVerifier({ integrationId: "oidc-client-idp", issuers: [], clock })).toThrow(ValidationError);
    expect(() => new JwksOidcVerifier({ integrationId: "oidc-client-idp", issuers: [ok], clock, policy: { algorithms: ["HS256" as never] } })).toThrow(ValidationError);
    expect(new JwksOidcVerifier({ integrationId: "oidc-client-idp", issuers: [ok], clock }).integrationId).toBe("oidc-client-idp");
  });
});

describe("JwksOidcVerifier over a 127.0.0.1 JWKS server (real createRemoteJWKSet, no external network)", () => {
  let server: Server;
  let base = "";
  let idp: LocalOidcProviderFixture;
  const clock = new FakeClock();
  let served: "ok" | "500" = "ok";
  let fetches = 0;

  beforeAll(async () => {
    idp = await LocalOidcProviderFixture.create({ clock });
    server = createServer((req, res) => {
      fetches++;
      if (served === "500") {
        res.writeHead(500).end();
        return;
      }
      const issuer = req.url === "/provider/jwks" ? IDP.providerIssuer : IDP.clientIssuer;
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(idp.jwks(issuer)));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  function verifier(cooldownMs = 0) {
    return new JwksOidcVerifier({
      integrationId: "oidc-client-idp",
      issuers: [
        { issuer: IDP.clientIssuer, audience: AUD, jwksUri: `${base}/client/jwks` },
        { issuer: IDP.providerIssuer, audience: AUD, jwksUri: `${base}/provider/jwks` },
      ],
      clock,
      allowLoopbackHttp: true,
      remote: { timeoutMs: 2000, cooldownMs, cacheMaxAgeMs: 60_000 },
    });
  }

  it("[SPEC-7.OIDC] fetches the issuer JWKS over HTTP and verifies tokens from both trusted issuers", async () => {
    served = "ok";
    const v = verifier();
    await expect(v.verifyIdToken(await idp.issueFor(PEOPLE.avery, { nonce: NONCE }), { nonce: NONCE, maxAuthAgeSeconds: 900 })).resolves.toMatchObject({ issuer: IDP.clientIssuer });
    await expect(v.verifyIdToken(await idp.issueFor(PEOPLE.morgan, { nonce: NONCE }), { nonce: NONCE, maxAuthAgeSeconds: 900 })).resolves.toMatchObject({ issuer: IDP.providerIssuer });
    expect(fetches).toBeGreaterThanOrEqual(2);
    expect(await v.health()).toEqual({ healthy: true, reasonCode: null });
  });

  it("[SPEC-7.OIDC] picks up a rotated IdP key by refetching on an unknown kid", async () => {
    served = "ok";
    const v = verifier(0);
    await v.verifyIdToken(await idp.issueFor(PEOPLE.avery, { nonce: NONCE }), { nonce: NONCE, maxAuthAgeSeconds: 900 });
    await idp.rotate(IDP.clientIssuer);
    await expect(v.verifyIdToken(await idp.issueFor(PEOPLE.avery, { nonce: NONCE }), { nonce: NONCE, maxAuthAgeSeconds: 900 })).resolves.toBeTruthy();
  });

  it("[SPEC-7.OIDC] an unavailable JWKS endpoint fails closed with a NOT_STARTED dependency error and unhealthy status", async () => {
    served = "500";
    const v = verifier();
    const err = await v.verifyIdToken(await idp.issueFor(PEOPLE.avery, { nonce: NONCE }), { nonce: NONCE, maxAuthAgeSeconds: 900 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DependencyError);
    expect((err as DependencyError).reasonCode).toBe("OIDC_JWKS_UNAVAILABLE");
    expect(await v.health()).toEqual({ healthy: false, reasonCode: "OIDC_JWKS_UNAVAILABLE" });
    served = "ok";
  });
});
