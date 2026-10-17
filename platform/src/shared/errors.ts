/**
 * Typed errors carry a stable reason code. Messages must never contain PHI,
 * secrets, identifiers supplied by callers, or dependency free text.
 */
export class PlatformError extends Error {
  constructor(
    readonly reasonCode: string,
    message: string = reasonCode,
    readonly retryable = false,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Fail closed: an authorization, session, policy or audit precondition is not met. */
export class AccessDeniedError extends PlatformError {}

/** Session is expired, revoked, from another generation or bound to another integration. */
export class SessionInvalidError extends PlatformError {}

/** Durable audit evidence cannot be written; consequential actions must be blocked. */
export class AuditUnavailableError extends PlatformError {
  constructor(reasonCode = "AUDIT_UNAVAILABLE") {
    super(reasonCode, reasonCode, true);
  }
}

/** A dependency failed; `outcome` distinguishes safe-to-retry from unknown commit state. */
export class DependencyError extends PlatformError {
  constructor(
    reasonCode: string,
    readonly outcome: "NOT_STARTED" | "FAILED" | "UNKNOWN",
    retryable = outcome === "NOT_STARTED",
  ) {
    super(reasonCode, reasonCode, retryable);
  }
}

export class ValidationError extends PlatformError {}

export class ConflictError extends PlatformError {}

/** Production configuration guard rejection (OPS-04). */
export class ConfigurationRejectedError extends PlatformError {
  constructor(readonly violations: string[]) {
    super("CONFIGURATION_REJECTED", `configuration rejected: ${violations.join("; ")}`);
  }
}
