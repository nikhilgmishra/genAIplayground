/**
 * Shared pieces of the business tool modules (spec section 8 "Tool interface").
 *
 * Inputs carry only opaque ids, enums, dates and bounded scalars. Nothing in a tool
 * argument can set actor, role, subject, organization, assurance, consent, scopes
 * or a destination (AUTH-03, SAFE-05): those come from the trusted AuthContext and
 * configuration. Outputs are strict; the gateway applies the policy field mask.
 */
import { z } from "zod";
import { IsoDateTime, OpaqueId, ReasonCode, RetryPolicy, SupportReference } from "../../protocol/index.js";
import type { RetryPolicy as RetryPolicyT } from "../../protocol/index.js";
import type { ToolOutcome } from "../ports.js";
import type { ToolSpeech } from "../../business/speech.js";
import { reasonOf } from "../../business/shared.js";
import { AccessDeniedError, AuditUnavailableError, ConflictError, DependencyError, SessionInvalidError } from "../../shared/errors.js";

export const TOOL_VERSION = "1.0.0";

/** Reads: one bounded gateway retry on provably-not-sent failures only. */
export const READ_RETRY: RetryPolicyT = RetryPolicy.parse({ maxAttempts: 2, backoffMs: 200, jitter: true, retryOn: ["TIMEOUT_BEFORE_SEND", "CONNECTION_REFUSED", "HTTP_503"] });
/** Writes, intakes and commits: no gateway retry (reconcile first, ACT-03; no retry stacking). */
export const NO_RETRY: RetryPolicyT = RetryPolicy.parse({ maxAttempts: 1, backoffMs: 0, jitter: false, retryOn: [] });

export const Id = OpaqueId;
export const DateArg = z.iso.date();
export const InstantArg = IsoDateTime;
/** Detected caller language as a code (never free text). */
export const LanguageArg = z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/);
export const SupportRefArg = SupportReference;
export const Sha256Arg = z.string().regex(/^[a-f0-9]{64}$/);
export const ActionIdArg = z.string().regex(/^act_[A-Za-z0-9_-]{16,64}$/);

/** The commit tools take exactly the prepared action id and its digest (ACT-01). */
export const CommitInput = z.strictObject({ actionId: ActionIdArg, digest: Sha256Arg });
export type CommitInputT = z.infer<typeof CommitInput>;

export const ok = <O>(data: O, speech: ToolSpeech | null): ToolOutcome<O> => ({ status: "SUCCESS", data, speech });
export const denied = <O>(reasonCode: string): ToolOutcome<O> => ({ status: "POLICY_DENIED", reasonCode: code(reasonCode, "POLICY_DENIED") });
export const failed = <O>(reasonCode: string): ToolOutcome<O> => ({ status: "PERMANENT_FAILURE", reasonCode: code(reasonCode, "PERMANENT_FAILURE") });
export const retryable = <O>(reasonCode: string, retryAfterMs = 1000): ToolOutcome<O> => ({
  status: "RETRYABLE_FAILURE",
  reasonCode: code(reasonCode, "RETRYABLE_FAILURE"),
  retryAfterMs: Math.min(Math.max(retryAfterMs, 0), 60_000),
});
export const unknownOutcome = <O>(reasonCode: string, reconciliationRef: string): ToolOutcome<O> => ({
  status: "UNKNOWN_OUTCOME",
  reasonCode: code(reasonCode, "COMMIT_OUTCOME_UNKNOWN"),
  reconciliationRef,
});

/** Reason codes only ever leave as UPPER_SNAKE codes (never messages or values). */
export function code(reason: string, fallback: string): string {
  return ReasonCode.safeParse(reason).success && !/\d{4,}/.test(reason) ? reason : fallback;
}

export const sourceRef = (system: string, id: string): string => `${system}:${id}`;

/**
 * Error mapping for reads, prepares and intakes (never for commits, whose outcomes come
 * from the action ledger). Denials stay denials; audit or dependency outages are
 * retryable only when nothing could have happened.
 */
export function fromError<O>(err: unknown, fallback: string): ToolOutcome<O> {
  if (err instanceof AccessDeniedError || err instanceof SessionInvalidError) return denied(reasonOf(err, "POLICY_DENIED"));
  if (err instanceof AuditUnavailableError) return retryable(reasonOf(err, "AUDIT_UNAVAILABLE"), 5000);
  if (err instanceof DependencyError) return err.outcome === "NOT_STARTED" ? retryable(reasonOf(err, "DEPENDENCY_UNAVAILABLE")) : failed(reasonOf(err, fallback));
  if (err instanceof ConflictError && err.retryable) return retryable(reasonOf(err, fallback));
  return failed(reasonOf(err, fallback));
}
