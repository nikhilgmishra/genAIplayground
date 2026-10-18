import { describe, expect, it } from "vitest";
import { decodeJwt, decodeProtectedHeader } from "jose";
import { IDP, PEOPLE } from "../../fixtures/synthetic-world.js";
import { FakeClock } from "../../shared/clock.js";
import { LocalOidcProviderFixture, LocalOidcVerifierFixture } from "./oidc-fixture.js";

const NONCE = "N".repeat(43);

describe("LocalOidcProviderFixture / LocalOidcVerifierFixture (LOCAL FIXTURE)", () => {
  it("[SPEC-7.OIDC] issues ES256 ID tokens with iss, aud, sub, nonce, auth_time, amr and acr for SYNTHETIC people", async () => {
    const clock = new FakeClock();
    const idp = await LocalOidcProviderFixture.create({ clock });
    expect(idp.label).toContain("LOCAL FIXTURE");
    const token = await idp.issueFor(PEOPLE.avery, { nonce: NONCE, amr: ["pwd", "mfa"], acr: "urn:local:acr:mfa" });
    const header = decodeProtectedHeader(token);
    const payload = decodeJwt(token);
    expect(header).toMatchObject({ alg: "ES256", typ: "JWT" });
    expect(header.kid).toMatch(/^local-idp-/);
    expect(payload).toMatchObject({ iss: IDP.clientIssuer, aud: IDP.portalAudience, sub: PEOPLE.avery.idpSubject, nonce: NONCE, auth_time: 1792249200, amr: ["pwd", "mfa"], acr: "urn:local:acr:mfa" });
  });

  it("[SPEC-7.OIDC] publishes public JWKS only, per issuer, including retired keys after rotation", async () => {
    const idp = await LocalOidcProviderFixture.create({ clock: new FakeClock() });
    const before = idp.jwks(IDP.clientIssuer);
    expect(before.keys).toHaveLength(1);
    for (const k of before.keys) expect(k).not.toHaveProperty("d");
    await idp.rotate(IDP.clientIssuer);
    expect(idp.jwks(IDP.clientIssuer).keys).toHaveLength(2);
    expect(idp.jwks("https://unknown.local.invalid").keys).toEqual([]);
  });

  it("[SPEC-7.OIDC] the fixture verifier runs the live verification core: valid token accepted, tampering rejected", async () => {
    const clock = new FakeClock();
    const idp = await LocalOidcProviderFixture.create({ clock });
    const v = new LocalOidcVerifierFixture(idp, { clock });
    expect(v.kind).toBe("local_fixture");
    const ok = await v.verifyIdToken(await idp.issueFor(PEOPLE.morgan, { nonce: NONCE }), { nonce: NONCE, maxAuthAgeSeconds: 900 });
    expect(ok).toMatchObject({ issuer: IDP.providerIssuer, sub: PEOPLE.morgan.idpSubject, audience: IDP.portalAudience, amr: ["pwd", "mfa"], acr: null });
    const untrusted = await idp.issueFor(PEOPLE.morgan, { nonce: NONCE, signWithUntrustedKey: true });
    await expect(v.verifyIdToken(untrusted, { nonce: NONCE, maxAuthAgeSeconds: 900 })).rejects.toMatchObject({ reasonCode: "OIDC_SIGNATURE_INVALID" });
    const spoofedIss = await idp.issueIdToken({ issuer: IDP.clientIssuer, payloadIssuerOverride: IDP.providerIssuer, sub: PEOPLE.morgan.idpSubject, nonce: NONCE });
    // Signed by the client IdP's key but claiming the provider issuer: the key is not in the provider's JWKS.
    await expect(v.verifyIdToken(spoofedIss, { nonce: NONCE, maxAuthAgeSeconds: 900 })).rejects.toMatchObject({ reasonCode: "OIDC_KEY_NOT_FOUND" });
  });

  it("[SPEC-7.OIDC] key rotation: tokens signed with the new key verify immediately; dropped keys stop verifying", async () => {
    const clock = new FakeClock();
    const idp = await LocalOidcProviderFixture.create({ clock });
    const v = new LocalOidcVerifierFixture(idp, { clock });
    const old = await idp.issueFor(PEOPLE.avery, { nonce: NONCE });
    await idp.rotate(IDP.clientIssuer);
    await expect(v.verifyIdToken(await idp.issueFor(PEOPLE.avery, { nonce: NONCE }), { nonce: NONCE, maxAuthAgeSeconds: 900 })).resolves.toBeTruthy();
    await expect(v.verifyIdToken(old, { nonce: NONCE, maxAuthAgeSeconds: 900 })).resolves.toBeTruthy();
    await idp.rotate(IDP.clientIssuer, true);
    await expect(v.verifyIdToken(old, { nonce: NONCE, maxAuthAgeSeconds: 900 })).rejects.toMatchObject({ reasonCode: "OIDC_KEY_NOT_FOUND" });
  });
});
