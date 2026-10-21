/**
 * Sealed login state of console workforce SSO (WP-05; FO-05-10, FO-05-11, FO-05-13; STRIDE D of
 * docs/security/threats/proposed/WP-05-threats.md).
 *
 * The sign-in start endpoint is unauthenticated. It therefore writes NOTHING: the binding of one authorization
 * request (nonce hash, the browser's S256 code challenge, the exact redirect URI, issue time and lifetime) travels
 * in the OAuth `state` itself, authenticated with HMAC-SHA256 under a key outside the database (TokenSealer.mac,
 * per-purpose HKDF subkey) and bound to the tenant and the workforce issuer. An anonymous client can start as many
 * sign-ins as it likes without consuming any capacity a legitimate operator needs; the edge rate limit
 * (composition, WP-07) stays an extra layer.
 *
 * Single use is recorded only at the exchange: the first presentation of a valid, unexpired state inserts the hash of
 * its canonical encoding (sessions.ts `recordLoginStateUse`); every later one (replay, race, double submit, another
 * spelling of the same bytes) finds it and is refused. Only the canonical spelling opens at all.
 * Only states the backend itself issued and that have not expired can create such a row, so the table holds at
 * most the exchanges of one state lifetime, and the sweeper deletes rows once their state has expired.
 *
 * Wire format (base64url, no padding):
 *   0x01 | keyIdLength (1) | keyId | issuedAt (u32 BE, epoch s) | ttl (u16 BE, s) | nonceHash (32) |
 *   codeChallenge (43 ASCII) | redirectDigest (16) | tag (32)
 * The tag is HMAC over "vsp.console-login-state.v1" | tenantId | issuerDigest | everything before the tag.
 * Nothing in it is secret (the nonce itself, the PKCE verifier and every token stay out of it), but nothing in it
 * can be changed or minted without the key.
 */
import { sha256Hex } from "../shared/canonical.js";
import type { TokenSealer } from "./token-sealer.js";

const VERSION = 0x01;
const PURPOSE = "login-state";
const DOMAIN = "vsp.console-login-state.v1";
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const KEY_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const TAG_BYTES = 32;
const FIXED_BYTES = 4 + 2 + 32 + 43 + 16;

/** Base64url of the smallest (1-character key id: 132 bytes) to the largest (128-character key id: 259 bytes) state. */
export const LOGIN_STATE = /^[A-Za-z0-9_-]{176,346}$/;

export interface LoginStateBinding {
  tenantId: string;
  issuerDigest: string;
}

export interface LoginStateContent {
  nonceHash: string;
  codeChallenge: string;
  redirectUri: string;
  issuedAt: Date;
  ttlSeconds: number;
}

export interface OpenedLoginState {
  /**
   * The canonical base64url encoding of the authenticated bytes. Only that spelling opens (base64url leaves spare low
   * bits in the last character when the length is not a multiple of 3, so one byte string has several spellings); the
   * exchange keys the state's single use on it, never on the presented string.
   */
  canonical: string;
  nonceHash: string;
  codeChallenge: string;
  /** sha256-based digest of the redirect URI the sign-in started with (compare with `redirectDigestOf`). */
  redirectDigest: string;
  issuedAt: Date;
  expiresAt: Date;
}

/** First 16 bytes of a domain-separated sha256 of the redirect URI (exact string). */
export function redirectDigestOf(redirectUri: string): string {
  return sha256Hex(`vsp.console-redirect.v1|${redirectUri}`).slice(0, 32);
}

function macInput(binding: LoginStateBinding, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${DOMAIN}|${binding.tenantId}|${binding.issuerDigest}|`, "utf8"), body]);
}

/** Issues the sealed state for one authorization request. */
export function sealLoginState(signer: Pick<TokenSealer, "mac" | "currentKeyId">, binding: LoginStateBinding, c: LoginStateContent): string {
  if (!/^[a-f0-9]{64}$/.test(c.nonceHash) || !CHALLENGE.test(c.codeChallenge)) throw new Error("LOGIN_STATE_CONTENT_INVALID");
  if (!Number.isInteger(c.ttlSeconds) || c.ttlSeconds < 1 || c.ttlSeconds > 0xffff) throw new Error("LOGIN_STATE_TTL_INVALID");
  const keyId = Buffer.from(signer.currentKeyId, "utf8");
  if (!KEY_ID.test(signer.currentKeyId)) throw new Error("LOGIN_STATE_KEY_ID_INVALID");
  const issued = Math.floor(c.issuedAt.getTime() / 1000);
  const fixed = Buffer.alloc(FIXED_BYTES);
  fixed.writeUInt32BE(issued, 0);
  fixed.writeUInt16BE(c.ttlSeconds, 4);
  Buffer.from(c.nonceHash, "hex").copy(fixed, 6);
  Buffer.from(c.codeChallenge, "ascii").copy(fixed, 38);
  Buffer.from(redirectDigestOf(c.redirectUri), "hex").copy(fixed, 81);
  const body = Buffer.concat([Buffer.from([VERSION, keyId.length]), keyId, fixed]);
  const { keyId: used, tag } = signer.mac(PURPOSE, macInput(binding, body));
  if (used !== signer.currentKeyId) throw new Error("LOGIN_STATE_KEY_MISMATCH");
  return Buffer.concat([body, tag]).toString("base64url");
}

/**
 * Opens a state the backend issued for this tenant and issuer, or null for anything else (malformed, another
 * version, an unknown key, a forged or altered tag, another tenant's or issuer's state). Expiry is the caller's
 * check (an expired state is a distinct, audited refusal).
 */
export function openLoginState(signer: Pick<TokenSealer, "verifyMac">, binding: LoginStateBinding, state: string): OpenedLoginState | null {
  if (!LOGIN_STATE.test(state)) return null;
  const raw = Buffer.from(state, "base64url");
  // One spelling per byte string: a state whose spare low bits differ (same bytes, another string) is refused.
  const canonical = raw.toString("base64url");
  if (canonical !== state) return null;
  if (raw.length < 2 || raw[0] !== VERSION) return null;
  const keyIdLength = raw[1] ?? 0;
  if (raw.length !== 2 + keyIdLength + FIXED_BYTES + TAG_BYTES) return null;
  const keyId = raw.subarray(2, 2 + keyIdLength).toString("utf8");
  if (!KEY_ID.test(keyId)) return null;
  const body = raw.subarray(0, raw.length - TAG_BYTES);
  const tag = raw.subarray(raw.length - TAG_BYTES);
  if (!signer.verifyMac(PURPOSE, macInput(binding, body), keyId, tag)) return null;
  const fixed = raw.subarray(2 + keyIdLength, 2 + keyIdLength + FIXED_BYTES);
  const issuedAt = fixed.readUInt32BE(0) * 1000;
  const ttl = fixed.readUInt16BE(4);
  const codeChallenge = fixed.subarray(38, 81).toString("ascii");
  if (!CHALLENGE.test(codeChallenge)) return null;
  return {
    canonical,
    nonceHash: fixed.subarray(6, 38).toString("hex"),
    codeChallenge,
    redirectDigest: fixed.subarray(81, 97).toString("hex"),
    issuedAt: new Date(issuedAt),
    expiresAt: new Date(issuedAt + ttl * 1000),
  };
}
