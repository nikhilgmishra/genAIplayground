/**
 * Strict validation of audit writer input (spec section 13, DATA-01, AUTH-06).
 *
 * The protocol AuditEventInput is already strict (unknown keys rejected). The
 * writer tightens every free-form string the protocol leaves open so that
 * transcript text, model reasoning, verification secrets or PHI-shaped values
 * cannot be smuggled into long-retention security evidence:
 *   - action: dotted code grammar with at least two segments, no 4+ digit runs
 *   - reasonCode / policy reason codes: upper-case code grammar, no 4+ digit runs
 *   - evidencePointers: scheme-restricted pointer grammar + PHI-shape heuristics
 *   - sessionRef: opaque identifier only (bearer handles are pseudonymized)
 *   - turnId: turn id grammar; idempotencyKey: token grammar + PHI-shape heuristics
 *   - policyVersion: version label grammar
 * The PHI-shape checks are heuristics (email, phone, SSN, calendar date shapes);
 * they reduce risk but do not prove absence of PHI. The schema prevents free text
 * by construction; the heuristics catch structured identifiers inside tokens.
 */
import { z } from "zod";
import { AuditEventInput, OpaqueId, ReasonCode, VersionLabel } from "../protocol/index.js";
import type { AuditEventInput as AuditEventInputType } from "../protocol/index.js";
import { sha256Hex } from "../shared/canonical.js";
import { ValidationError } from "../shared/errors.js";

/** Evidence pointer grammar: a known internal scheme plus a bounded opaque path (preferred form). */
export const EVIDENCE_POINTER_RE = /^(s3|db|sf|ledger|wf|kv):\/\/[A-Za-z0-9/_.:@-]{3,190}$/;

/**
 * Typed opaque reference `<kind>:<opaque id>`, e.g. "action:act_..." or "workflow:wf_...".
 * The value must be an opaque identifier (prefix + 16..64 random chars) and nothing else,
 * so it cannot carry names, codes or other content.
 */
export const TYPED_OPAQUE_REF_RE = /^[a-z][a-z0-9_]{1,31}:[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$/;

/** Stream names are per writer instance ("<component>.<instanceId>") to avoid one global hot row. */
export const STREAM_NAME_RE = /^[a-z0-9_.-]{3,64}$/;

const ACTION_RE = /^[a-z][a-z0-9_]{0,31}(\.[a-z][a-z0-9_]{0,31}){1,5}$/;
const TURN_ID_RE = /^turn_[A-Za-z0-9_-]{4,64}$/;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/;
const FOUR_DIGIT_RUN = /\d{4,}/;

/** Structured-identifier shapes that must never appear inside tokens (heuristic, not exhaustive). */
const PHI_SHAPES: readonly RegExp[] = [
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/, // email address
  /(^|[^0-9])\d{3}[-.]\d{3}[-.]\d{4}([^0-9]|$)/, // NANP phone number
  /\+\d{10,15}/, // E.164 phone number
  /(^|[^0-9])\d{3}-\d{2}-\d{4}([^0-9]|$)/, // SSN
  /(^|[^0-9])(18|19|20)\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])([^0-9]|$)/, // calendar date (e.g. DOB)
  /(^|[^0-9])(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])\/(18|19|20)\d{2}([^0-9]|$)/, // US date
];

export function looksPhiShaped(value: string): boolean {
  return PHI_SHAPES.some((re) => re.test(value));
}

const CodeNoDigitRuns = ReasonCode.refine((v) => !FOUR_DIGIT_RUN.test(v), { message: "code must not carry digit runs" });

export const EvidencePointer = z
  .string()
  .max(200)
  .refine((v) => EVIDENCE_POINTER_RE.test(v) || TYPED_OPAQUE_REF_RE.test(v), { message: "pointer grammar" })
  .refine((v) => !looksPhiShaped(v), { message: "pointer must not carry PHI-shaped values" })
  .refine((v) => !v.includes("..") && (!v.includes("://") || !v.includes("//", v.indexOf("://") + 3)), { message: "pointer path must be normalized" });

export const AuditAction = z
  .string()
  .regex(ACTION_RE)
  .refine((v) => !FOUR_DIGIT_RUN.test(v), { message: "action must not carry digit runs" });

/** Strict writer input: the protocol AuditEventInput with every open string tightened. */
export const AuditWriterInput = AuditEventInput.extend({
  action: AuditAction,
  reasonCode: CodeNoDigitRuns.nullable(),
  policyDecision: z
    .strictObject({
      decisionId: OpaqueId,
      allow: z.boolean(),
      reasonCodes: z.array(CodeNoDigitRuns).max(16),
      policyVersion: VersionLabel,
    })
    .nullable(),
  sessionRef: OpaqueId.nullable(),
  turnId: z.string().regex(TURN_ID_RE).nullable(),
  evidencePointers: z
    .array(EvidencePointer)
    .max(16)
    .refine((ps) => new Set(ps).size === ps.length, { message: "duplicate evidence pointer" }),
  idempotencyKey: z
    .string()
    .regex(IDEMPOTENCY_KEY_RE)
    .refine((v) => !looksPhiShaped(v), { message: "idempotency key must not carry PHI-shaped values" })
    .nullable(),
});

export interface AuditInputIssue {
  /** Dotted path of a schema-defined field (never a caller-supplied key name). */
  path: string;
  code: string;
}

/** Invalid audit input. The message is a reason code only; issues carry schema paths, never values. */
export class AuditEventInvalidError extends ValidationError {
  constructor(readonly issues: readonly AuditInputIssue[]) {
    super("AUDIT_EVENT_INVALID");
  }
}

const KNOWN_KEYS = new Set(Object.keys(AuditWriterInput.shape));

function safeIssues(error: z.ZodError): AuditInputIssue[] {
  return error.issues.slice(0, 32).map((issue) => {
    // Only schema-known top-level keys and numeric indexes are reported; an
    // unrecognized key name could itself be content, so it is never echoed.
    const parts: string[] = [];
    for (const [i, p] of issue.path.entries()) {
      if (typeof p === "number") parts.push(String(p));
      else if (i === 0 && typeof p === "string" && KNOWN_KEYS.has(p)) parts.push(p);
      else if (i > 0 && typeof p === "string" && /^[a-zA-Z]{1,40}$/.test(p)) parts.push(p);
      else parts.push("?");
    }
    return { path: parts.join(".") || "(root)", code: issue.code };
  });
}

/** Parses untrusted input into a strict AuditEventInput or throws AuditEventInvalidError. */
export function validateAuditInput(input: unknown): AuditEventInputType {
  const parsed = AuditWriterInput.safeParse(input);
  if (!parsed.success) throw new AuditEventInvalidError(safeIssues(parsed.error));
  return parsed.data;
}

const SESSION_PSEUDONYM_PREFIX = "sref";

/**
 * Session references are high-entropy bearer handles (prefix "ses"). Audit evidence
 * is long-retention and auditor-readable, so the writer stores a one-way pseudonym
 * instead. Correlate by computing the same function over a known session ref.
 */
export function pseudonymousSessionRef(sessionRef: string): string {
  if (sessionRef.startsWith(`${SESSION_PSEUDONYM_PREFIX}_`)) return sessionRef;
  const digest = Buffer.from(sha256Hex(`vsp.audit.session_ref.v1\n${sessionRef}`), "hex").toString("base64url");
  return `${SESSION_PSEUDONYM_PREFIX}_${digest}`;
}

/**
 * Normalization applied after validation and before hashing. Raw session handles
 * ("ses_...") are replaced by their pseudonym. Binding references that are already
 * one-way derivations of the session hash ("ses_bnd_...", actions module) are kept.
 */
export function normalizeAuditInput(input: AuditEventInputType): AuditEventInputType {
  const ref = input.sessionRef;
  const sessionRef = ref && ref.startsWith("ses_") && !ref.startsWith("ses_bnd_") ? pseudonymousSessionRef(ref) : ref;
  return { ...input, sessionRef };
}

/**
 * Builds a per-writer-instance stream name, e.g. auditStreamName("gateway", "task-7f3a")
 * => "gateway.task-7f3a". Lower-cased; characters outside [a-z0-9_.-] become "-".
 */
export function auditStreamName(component: string, instanceId: string): string {
  const clean = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "");
  const name = `${clean(component)}.${clean(instanceId)}`.slice(0, 64).replace(/[-.]+$/g, "");
  return assertStreamName(name);
}

export function assertStreamName(stream: string): string {
  if (!STREAM_NAME_RE.test(stream) || stream.includes("..") || stream.startsWith(".")) {
    throw new ValidationError("AUDIT_STREAM_INVALID");
  }
  return stream;
}
