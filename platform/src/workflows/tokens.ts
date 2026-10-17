/**
 * Human-task tokens (spec section 9). A token is scoped to exactly one task and
 * one issuing staff member, expires, is single use, and is stored only as a
 * SHA-256 digest. The plaintext is returned once to an authenticated console /
 * approval endpoint in a response body; it must never be placed in a URL, a log
 * line, a workflow name, an event, an audit record or a notification.
 *
 * 256 bits of randomness make an unsalted SHA-256 digest sufficient (the token
 * is not a low-entropy secret that could be brute-forced from its hash).
 */
import { randomBytes } from "node:crypto";
import { constantTimeEqualHex, sha256Hex } from "../shared/canonical.js";

export const TASK_TOKEN_RE = /^wtt_[A-Za-z0-9_-]{43}$/;
const HEX64 = /^[a-f0-9]{64}$/;

export function newTaskToken(): string {
  return `wtt_${randomBytes(32).toString("base64url")}`;
}

export function hashTaskToken(token: string): string {
  return sha256Hex(token);
}

/** Constant-time comparison of a presented token against a stored digest. */
export function taskTokenMatches(presented: string, storedHash: string | null): boolean {
  if (storedHash === null || !HEX64.test(storedHash)) return false;
  // Hash first so the comparison length never depends on the presented value.
  const presentedHash = hashTaskToken(typeof presented === "string" ? presented : "");
  const formatOk = TASK_TOKEN_RE.test(presented);
  const equal = constantTimeEqualHex(presentedHash, storedHash);
  return formatOk && equal;
}
