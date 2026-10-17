import { randomBytes, randomInt } from "node:crypto";

/**
 * Opaque identifiers: `<prefix>_<base64url>` with 144 bits of randomness by default.
 * Never derive identifiers from names, phone numbers, dates of birth or other PHI.
 */
export function newId(prefix: string, bytes = 18): string {
  if (!/^[a-z][a-z0-9]{1,11}$/.test(prefix)) throw new Error(`invalid id prefix ${prefix}`);
  return `${prefix}_${randomBytes(bytes).toString("base64url")}`;
}

/** High-entropy bearer handle (256 bits), e.g. session references. */
export const newSessionRef = (): string => newId("ses", 32);

export const newTurnId = (): string => `turn_${randomBytes(9).toString("base64url")}`;

/** Unambiguous alphabet for references spoken aloud (no 0/O, 1/I). */
const REF_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function newSupportReference(): string {
  const pick = () => REF_ALPHABET[randomInt(REF_ALPHABET.length)];
  const block = () => Array.from({ length: 4 }, pick).join("");
  return `SR-${block()}-${block()}`;
}
