/** URL-safe random string from the Web Crypto CSPRNG. */
export function randomUrlSafe(bytes = 24): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  return base64UrlEncode(buf);
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Idempotency key for one confirmed mutation (contract IDEMPOTENCY_KEY_PATTERN). */
export const newIdempotencyKey = (): string => randomUrlSafe(24);
