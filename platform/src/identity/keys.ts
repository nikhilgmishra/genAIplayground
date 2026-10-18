import { SessionRef } from "../protocol/index.js";
import { sha256Hex } from "../shared/canonical.js";
import { SessionInvalidError, ValidationError } from "../shared/errors.js";

/**
 * KV key derivation. Bearer values (session references, transaction ids,
 * challenge ids) are never stored as keys or values: every key is a namespaced
 * sha256 digest, so a table dump or a log line cannot be replayed as authority.
 */
const BINDING_REF = /^ses_bnd_[A-Za-z0-9_-]{43}$/;

/** sha256 hex of a bearer session reference. Binding refs are rejected: they are not bearer values. */
export function sessionRefHash(sessionRef: unknown): string {
  const r = SessionRef.safeParse(sessionRef);
  if (!r.success || BINDING_REF.test(r.data)) throw new SessionInvalidError("SESSION_REF_INVALID");
  return sha256Hex(r.data);
}

/**
 * Non-bearer session binding reference (`ses_bnd_<base64url(sha256)>`), identical to
 * the derivation used by the action ledger, safe for logs, assertions and audit.
 */
export function bindingRefFromHash(hashHex: string): string {
  if (!/^[a-f0-9]{64}$/.test(hashHex)) throw new ValidationError("SESSION_HASH_INVALID");
  return `ses_bnd_${Buffer.from(hashHex, "hex").toString("base64url")}`;
}

export const sessionBindingRefFor = (sessionRef: string): string => bindingRefFromHash(sessionRefHash(sessionRef));

export const isSessionBindingRef = (ref: string): boolean => BINDING_REF.test(ref);

const ns = (namespace: string, ...parts: string[]) => `${namespace}#${sha256Hex(parts.join("\u0000"))}`;

export const kvKeys = {
  session: (hash: string) => `ses#${hash}`,
  callIndex: (tenantId: string, callId: string) => ns("call", tenantId, callId),
  secureLinkTx: (transactionId: string) => ns("vtx", transactionId),
  otpChallenge: (challengeId: string) => ns("otp", challengeId),
  /** Fixed-window throttle counters; the window index is part of the key. */
  throttle: (kind: string, subject: string, window: number) => `thr#${kind}:${window}:${sha256Hex(subject)}`,
  assertionJti: (issuer: string, jti: string) => ns("jti", issuer, jti),
} as const;

/** Fixed hourly window index for throttles. */
export const hourWindow = (now: Date): number => Math.floor(now.getTime() / 3_600_000);

export const epochSeconds = (d: Date): number => Math.floor(d.getTime() / 1000);
