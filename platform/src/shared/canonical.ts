import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Deterministic JSON serialization (sorted object keys, no whitespace) used for
 * digests, hash chains and signatures. Rejects values that have no canonical form.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (value === null) return null;
  if (value === undefined) throw new TypeError("undefined has no canonical JSON form");
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite number has no canonical JSON form");
    return value;
  }
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) continue;
      out[key] = normalize(v);
    }
    return out;
  }
  throw new TypeError(`unsupported type ${typeof value}`);
}

export const sha256Hex = (input: string | Buffer): string => createHash("sha256").update(input).digest("hex");

export const digestOf = (value: unknown): string => sha256Hex(canonicalJson(value));

export const hmacHex = (key: string | Buffer, input: string): string => createHmac("sha256", key).update(input).digest("hex");

export function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
