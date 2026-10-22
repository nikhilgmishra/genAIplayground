/**
 * Identifier and digest helpers. Every identifier the API issues is an opaque token
 * (`<prefix>_<base64url>`, 128 bits of randomness): never derived from a name, date or number, and safe in a
 * URL path for the platform's egress check.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const OPAQUE_ID = /^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$/;
/** A client-chosen request id (the provider idempotency key in URL-safe form). */
export const KEY_REF = /^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$/;

export const newId = (prefix: string): string => `${prefix}_${randomBytes(16).toString("base64url")}`;

export const sha256Hex = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");

/** Canonical JSON (sorted keys, no whitespace) of a JSON value. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

/** Digest of a write request: the operation plus its canonical body. Same key + different digest = key reuse. */
export const requestDigest = (operation: string, body: unknown): string => sha256Hex(`refbiz.request.v1\n${operation}\n${canonicalJson(body)}`);

/** Constant-time comparison of two hex digests. */
export function digestEquals(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}
