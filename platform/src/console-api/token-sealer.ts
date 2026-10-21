/**
 * Sealing of IdP refresh tokens held server-side for console sessions (WP-05; FO-05-19; AUTH-06,
 * DATA-01). IdP tokens never reach the browser; the backend keeps the refresh token only as
 * AES-256-GCM ciphertext whose additional authenticated data binds it to exactly one console session
 * (the session hash) and purpose, so a ciphertext copied onto another row does not open.
 *
 * Keys live outside the database: the composition root resolves them from the secret store (Secrets
 * Manager in live composition, through the connector SecretResolver) and passes them here. Several key
 * versions may be configured for rotation: `seal` always uses `current`; `open` accepts any listed key id.
 *
 * The same keys also authenticate integrity-only tokens the backend hands out and later takes back (the sealed
 * login state of sso.ts): `mac` is HMAC-SHA256 under a per-purpose subkey derived with HKDF-SHA256 from the key,
 * so no key is used directly for two algorithms and a tag for one purpose never verifies for another.
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { AccessDeniedError, ValidationError } from "../shared/errors.js";

export interface SealedToken {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  keyId: string;
}

export interface TokenSealer {
  readonly currentKeyId: string;
  seal(plaintext: string, aad: string): SealedToken;
  /** Throws AccessDeniedError TOKEN_UNSEAL_FAILED for a tampered, foreign or unknown-key ciphertext. */
  open(sealed: SealedToken, aad: string): string;
  /** HMAC-SHA256 of `data` under the CURRENT key's subkey for `purpose` (32-byte tag). */
  mac(purpose: string, data: Buffer): { keyId: string; tag: Buffer };
  /** True when `tag` is `mac(purpose, data)` under the named key (any configured key id); constant time. */
  verifyMac(purpose: string, data: Buffer, keyId: string, tag: Buffer): boolean;
}

const MAC_PURPOSE = /^[a-z][a-z0-9.-]{2,63}$/;

const KEY_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export class AesGcmTokenSealer implements TokenSealer {
  readonly currentKeyId: string;
  private readonly keys = new Map<string, Buffer>();

  constructor(keys: { current: { id: string; key: Buffer }; previous?: readonly { id: string; key: Buffer }[] }) {
    for (const k of [keys.current, ...(keys.previous ?? [])]) {
      if (!KEY_ID.test(k.id) || !Buffer.isBuffer(k.key) || k.key.length !== 32) throw new ValidationError("TOKEN_SEALER_KEY_INVALID");
      if (this.keys.has(k.id)) throw new ValidationError("TOKEN_SEALER_KEY_DUPLICATE");
      this.keys.set(k.id, Buffer.from(k.key));
    }
    this.currentKeyId = keys.current.id;
  }

  /** Builds a sealer from a base64 32-byte key (the secret-store format: `{"keyId": ..., "key": <base64>}`). */
  static fromSecret(secret: { keyId: string; key: string }, previous: readonly { keyId: string; key: string }[] = []): AesGcmTokenSealer {
    const decode = (s: { keyId: string; key: string }) => ({ id: s.keyId, key: Buffer.from(s.key, "base64") });
    return new AesGcmTokenSealer({ current: decode(secret), previous: previous.map(decode) });
  }

  seal(plaintext: string, aad: string): SealedToken {
    const key = this.keys.get(this.currentKeyId) as Buffer;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(`vsp.console-token.v1|${aad}`, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return { ciphertext, iv, tag: cipher.getAuthTag(), keyId: this.currentKeyId };
  }

  private readonly macKeys = new Map<string, Buffer>();

  private macKey(keyId: string, purpose: string): Buffer | null {
    if (!MAC_PURPOSE.test(purpose)) throw new ValidationError("TOKEN_MAC_PURPOSE_INVALID");
    const key = this.keys.get(keyId);
    if (!key) return null;
    const id = `${keyId}\u0000${purpose}`;
    let sub = this.macKeys.get(id);
    if (!sub) {
      sub = Buffer.from(hkdfSync("sha256", key, Buffer.from("vsp.console-mac.v1", "utf8"), Buffer.from(purpose, "utf8"), 32));
      this.macKeys.set(id, sub);
    }
    return sub;
  }

  mac(purpose: string, data: Buffer): { keyId: string; tag: Buffer } {
    const key = this.macKey(this.currentKeyId, purpose) as Buffer;
    return { keyId: this.currentKeyId, tag: createHmac("sha256", key).update(data).digest() };
  }

  verifyMac(purpose: string, data: Buffer, keyId: string, tag: Buffer): boolean {
    const key = this.macKey(keyId, purpose);
    if (!key || tag.length !== 32) return false;
    return timingSafeEqual(createHmac("sha256", key).update(data).digest(), tag);
  }

  open(sealed: SealedToken, aad: string): string {
    const key = this.keys.get(sealed.keyId);
    if (!key || sealed.iv.length !== 12 || sealed.tag.length !== 16) throw new AccessDeniedError("TOKEN_UNSEAL_FAILED");
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, sealed.iv);
      decipher.setAAD(Buffer.from(`vsp.console-token.v1|${aad}`, "utf8"));
      decipher.setAuthTag(sealed.tag);
      return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString("utf8");
    } catch {
      throw new AccessDeniedError("TOKEN_UNSEAL_FAILED");
    }
  }
}
