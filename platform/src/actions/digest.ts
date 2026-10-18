/**
 * Pure helpers for prepared-action digests and session bindings (spec section 8, ACT-01).
 *
 * The digest is sha256 over the canonical JSON (sorted keys, no whitespace) of every
 * PreparedAction field except `digest` and `state`. Confirmation and step-up are bound to it,
 * so a "yes" for one prepared action can never confirm a different one.
 *
 * The ledger never stores or returns the session bearer value. A PreparedAction produced by
 * this module carries a *session binding reference* in `sessionRef`: `ses_bnd_` followed by the
 * base64url sha256 of the bearer. It identifies the session exactly, cannot be used to resolve
 * a session, and keeps the digest reproducible from stored state alone.
 */
import { z } from "zod";
import { PreparedAction } from "../protocol/index.js";
import { canonicalJson, constantTimeEqualHex, sha256Hex } from "../shared/canonical.js";
import { ValidationError } from "../shared/errors.js";

/** Field list derived from the protocol schema so new protocol fields are digest-covered automatically. */
export const DIGEST_FIELDS = Object.keys(PreparedAction.shape).filter((k) => k !== "digest" && k !== "state") as readonly (keyof PreparedAction)[];

const DigestInput = PreparedAction.omit({ digest: true, state: true });
export type PreparedActionFields = z.infer<typeof DigestInput>;

/**
 * sha256 hex over canonical JSON of every PreparedAction field except digest/state.
 * Input is strictly validated (unknown fields rejected) so the digest is never computed over
 * extra, unvalidated data. Accepts a full PreparedAction (digest/state ignored).
 */
export function computeActionDigest(action: PreparedActionFields | PreparedAction): string {
  const picked: Record<string, unknown> = {};
  for (const key of DIGEST_FIELDS) picked[key] = (action as Record<string, unknown>)[key];
  const parsed = DigestInput.safeParse(picked);
  if (!parsed.success) throw new ValidationError("ACTION_DIGEST_INPUT_INVALID");
  return sha256Hex(canonicalJson(parsed.data));
}

/** True when the action's stored digest matches its content (constant-time compare). */
export function verifyActionDigest(action: PreparedAction): boolean {
  try {
    return constantTimeEqualHex(computeActionDigest(action), action.digest);
  } catch {
    return false;
  }
}

const BEARER_SESSION_REF = /^ses_[A-Za-z0-9_-]{16,64}$/;
const BINDING_REF = /^ses_bnd_[A-Za-z0-9_-]{43}$/;

/** sha256 hex of the session bearer value; the only form persisted by the ledger. */
export function sessionRefHash(sessionRef: string): string {
  if (!BEARER_SESSION_REF.test(sessionRef) || BINDING_REF.test(sessionRef)) throw new ValidationError("SESSION_REF_INVALID");
  return sha256Hex(sessionRef);
}

/** Non-bearer session binding reference derived from the stored hash. */
export function bindingRefFromHash(hashHex: string): string {
  if (!/^[a-f0-9]{64}$/.test(hashHex)) throw new ValidationError("SESSION_HASH_INVALID");
  return `ses_bnd_${Buffer.from(hashHex, "hex").toString("base64url")}`;
}

/** Non-bearer session binding reference for a bearer session ref. */
export const sessionBindingRef = (sessionRef: string): string => bindingRefFromHash(sessionRefHash(sessionRef));

/** Binding references are not bearer values and are never accepted where a session must be proven. */
export const isSessionBindingRef = (ref: string): boolean => BINDING_REF.test(ref);

/**
 * Stable provider idempotency key for an action: identical across every commit attempt and
 * reconciliation of the same action (ACT-02), distinct between actions, and not revealing the
 * internal action id to the vendor.
 */
export function providerIdempotencyKeyFor(actionId: string): string {
  if (!/^act_[A-Za-z0-9_-]{16,64}$/.test(actionId)) throw new ValidationError("ACTION_ID_INVALID");
  return `vsp-${sha256Hex(`vsp.provider-idempotency.v1:${actionId}`).slice(0, 48)}`;
}

/** sha256 over canonical provider evidence; falls back to a marked digest if evidence has no canonical form. */
export function evidenceHashOf(evidence: {
  providerSystem: string;
  providerReference: string;
  afterVersion: string | null;
  evidence: Record<string, unknown>;
}): { hash: string; canonical: boolean } {
  try {
    return { hash: sha256Hex(canonicalJson(evidence)), canonical: true };
  } catch {
    return {
      hash: sha256Hex(
        canonicalJson({ ...evidence, evidence: null, evidenceRejected: "NON_CANONICAL_EVIDENCE" }),
      ),
      canonical: false,
    };
  }
}
