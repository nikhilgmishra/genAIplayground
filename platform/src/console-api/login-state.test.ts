/**
 * Sealed login state of console workforce SSO (WP-05; FO-05-10, FO-05-11, FO-05-13; STRIDE D): what the
 * unauthenticated start endpoint hands out instead of storing a login transaction. SYNTHETIC values only.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../shared/canonical.js";
import { LOGIN_STATE, openLoginState, redirectDigestOf, sealLoginState } from "./login-state.js";
import { AesGcmTokenSealer } from "./token-sealer.js";

const k1 = { id: "login-key-1", key: randomBytes(32) };
const k2 = { id: "login-key-2", key: randomBytes(32) };
const binding = { tenantId: "tnt_synthLoginStateTenant01", issuerDigest: sha256Hex("vsp.issuer.v1|https://idp.vsp-unit.invalid/realms/workforce") };
const content = {
  nonceHash: sha256Hex("synthetic-nonce-value"),
  codeChallenge: "A".repeat(42) + "Q",
  redirectUri: "https://console.vsp-unit.invalid/auth/callback",
  issuedAt: new Date("2026-10-20T12:00:00.000Z"),
  ttlSeconds: 600,
};

describe("[FO-05-10][STRIDE-D] sealed login state", () => {
  it("[FO-05-10] round trip: the state carries the nonce hash, challenge, redirect digest and lifetime, and nothing secret", () => {
    const sealer = new AesGcmTokenSealer({ current: k1 });
    const state = sealLoginState(sealer, binding, content);
    expect(state).toMatch(LOGIN_STATE);
    expect(openLoginState(sealer, binding, state)).toEqual({
      canonical: state,
      nonceHash: content.nonceHash,
      codeChallenge: content.codeChallenge,
      redirectDigest: redirectDigestOf(content.redirectUri),
      issuedAt: content.issuedAt,
      expiresAt: new Date(content.issuedAt.getTime() + 600_000),
    });
    // Two starts never share a state (the nonce differs), and the raw nonce is not in it.
    expect(sealLoginState(sealer, binding, { ...content, nonceHash: sha256Hex("other") })).not.toBe(state);
    expect(Buffer.from(state, "base64url").toString("latin1")).not.toContain("synthetic-nonce-value");
    expect(redirectDigestOf("https://console.vsp-unit.invalid/auth/callback/")).not.toBe(redirectDigestOf(content.redirectUri));
  });

  it("[FO-05-10][FO-05-11] a state is bound to its tenant, its issuer and the backend's key: anything else opens to nothing", () => {
    const sealer = new AesGcmTokenSealer({ current: k1 });
    const state = sealLoginState(sealer, binding, content);
    expect(openLoginState(sealer, { ...binding, tenantId: "tnt_synthLoginStateTenant02" }, state)).toBeNull();
    expect(openLoginState(sealer, { ...binding, issuerDigest: sha256Hex("vsp.issuer.v1|https://other.vsp-unit.invalid") }, state)).toBeNull();
    expect(openLoginState(new AesGcmTokenSealer({ current: k2 }), binding, state)).toBeNull();
    // A key rotation keeps states issued under the previous key valid for their lifetime.
    expect(openLoginState(new AesGcmTokenSealer({ current: k2, previous: [k1] }), binding, state)?.nonceHash).toBe(content.nonceHash);
    // The key id names the key: the same bytes under another id do not verify.
    expect(openLoginState(new AesGcmTokenSealer({ current: { id: "login-key-9", key: k1.key } }), binding, state)).toBeNull();
  });

  it("[FO-05-10][STRIDE-T] any altered byte, a truncation, an extension, another version or a non-canonical encoding is refused", () => {
    const sealer = new AesGcmTokenSealer({ current: k1 });
    const state = sealLoginState(sealer, binding, content);
    const raw = Buffer.from(state, "base64url");
    for (let i = 0; i < raw.length; i++) {
      const t = Buffer.from(raw);
      t[i] = (t[i] ?? 0) ^ 0x01;
      expect(openLoginState(sealer, binding, t.toString("base64url")), `byte ${i}`).toBeNull();
    }
    expect(openLoginState(sealer, binding, raw.subarray(0, raw.length - 1).toString("base64url"))).toBeNull();
    expect(openLoginState(sealer, binding, Buffer.concat([raw, Buffer.from([0])]).toString("base64url"))).toBeNull();
    expect(openLoginState(sealer, binding, `${state}=`)).toBeNull();
    for (const junk of ["", "A".repeat(43), "A".repeat(200), "!".repeat(200), state.toUpperCase()]) expect(openLoginState(sealer, binding, junk), junk.slice(0, 8)).toBeNull();
  });

  it("[FO-05-10][FO-05-11][STRIDE-T] one spelling per state: a second base64url spelling of the same bytes (other spare low bits in the last character) never opens, so it can neither replay a used state nor be a second key for its single use (verifier probe S)", () => {
    const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    // Key id lengths give every residue of the byte length mod 3: 2 (2 spare bits), 1 (4 spare bits) and 0 (none).
    const spareBits = { kk: 4, kkk: 2, k: 0 } as const;
    for (const [id, spare] of Object.entries(spareBits)) {
      const sealer = new AesGcmTokenSealer({ current: { id, key: randomBytes(32) } });
      const state = sealLoginState(sealer, binding, content);
      const raw = Buffer.from(state, "base64url");
      expect(raw.length % 3, id).toBe(spare === 4 ? 1 : spare === 2 ? 2 : 0);
      expect(openLoginState(sealer, binding, state)?.canonical, id).toBe(state);
      const last = ALPHABET.indexOf(state.slice(-1));
      for (let bit = 0; bit < spare; bit++) {
        const respelled = state.slice(0, -1) + (ALPHABET[last ^ (1 << bit)] ?? "");
        expect(respelled, `${id} bit ${bit}`).not.toBe(state);
        expect(respelled, `${id} bit ${bit}`).toMatch(LOGIN_STATE);
        // Same authenticated bytes, so the MAC would verify: only the canonical-encoding rule refuses it.
        expect(Buffer.from(respelled, "base64url").equals(raw), `${id} bit ${bit}`).toBe(true);
        expect(openLoginState(sealer, binding, respelled), `${id} bit ${bit}`).toBeNull();
      }
    }
  });

  it("[FO-05-10] the encoding fits the advertised bounds for the shortest and longest key ids and refuses malformed content", () => {
    for (const id of ["k", "k".repeat(128)]) {
      const s = sealLoginState(new AesGcmTokenSealer({ current: { id, key: randomBytes(32) } }), binding, content);
      expect(s, `key id length ${id.length}`).toMatch(LOGIN_STATE);
    }
    const sealer = new AesGcmTokenSealer({ current: k1 });
    expect(() => sealLoginState(sealer, binding, { ...content, codeChallenge: "short" })).toThrow("LOGIN_STATE_CONTENT_INVALID");
    expect(() => sealLoginState(sealer, binding, { ...content, nonceHash: "zz" })).toThrow("LOGIN_STATE_CONTENT_INVALID");
    expect(() => sealLoginState(sealer, binding, { ...content, ttlSeconds: 0 })).toThrow("LOGIN_STATE_TTL_INVALID");
    expect(() => sealLoginState(sealer, binding, { ...content, ttlSeconds: 70_000 })).toThrow("LOGIN_STATE_TTL_INVALID");
  });

  it("[AUTH-03] the MAC subkey is per purpose: a tag for one purpose never verifies for another, and no purpose outside the grammar is accepted", () => {
    const sealer = new AesGcmTokenSealer({ current: k1 });
    const data = Buffer.from("synthetic-data");
    const { keyId, tag } = sealer.mac("login-state", data);
    expect(sealer.verifyMac("login-state", data, keyId, tag)).toBe(true);
    expect(sealer.verifyMac("recovery-state", data, keyId, tag)).toBe(false);
    expect(sealer.verifyMac("login-state", Buffer.from("synthetic-datA"), keyId, tag)).toBe(false);
    expect(sealer.verifyMac("login-state", data, "unknown-key", tag)).toBe(false);
    expect(sealer.verifyMac("login-state", data, keyId, tag.subarray(0, 16))).toBe(false);
    expect(() => sealer.mac("Bad Purpose", data)).toThrow();
  });
});
