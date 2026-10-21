import type {
  AuthContext,
  AuthGateResponse,
  ConsentState,
  IntegrationIdentity,
  RiskFlag,
  Role,
  VerificationAssertionClaims,
} from "../protocol/index.js";

/**
 * DynamoDB-shaped key-value store with conditional writes. The DynamoDB
 * implementation uses ConditionExpression; the in-memory implementation is a
 * LOCAL FIXTURE with identical compare-and-swap semantics. Storage TTL is
 * advisory only: readers MUST enforce expiry themselves (AUTH-04).
 */
export interface KvItem<T = Record<string, unknown>> {
  pk: string;
  version: number;
  /** Epoch seconds used for the DynamoDB TTL attribute. */
  ttlEpochSeconds: number | null;
  data: T;
}

export interface KvStore {
  readonly kind: "local_fixture" | "live";
  get<T>(pk: string): Promise<KvItem<T> | null>;
  /** Creates only if absent. Returns false on conflict. */
  putIfAbsent<T>(item: KvItem<T>): Promise<boolean>;
  /** Replaces only if the stored version equals expectedVersion; new version = expectedVersion + 1. */
  compareAndSwap<T>(pk: string, expectedVersion: number, data: T, ttlEpochSeconds: number | null): Promise<boolean>;
  delete(pk: string, expectedVersion?: number): Promise<boolean>;
  /** Atomic counter within a fixed window (throttles). Returns the post-increment value. */
  increment(pk: string, ttlEpochSeconds: number): Promise<number>;
}

export interface StartCallInput {
  integration: IntegrationIdentity;
  /** Vendor interaction id; an identifier only, never authority (spec section 7). */
  callId: string;
  /** Caller ID / ANI is a risk signal only and never authenticates (AUTH-01). */
  callerIdHash: string | null;
  consent: ConsentState;
}

export interface StartCallResult {
  sessionRef: string;
  sessionGeneration: number;
  /** Always false at call start; never a value that could accidentally open the Talkdesk Auth Gate. */
  authGate: false;
  expiresAt: string;
}

export type SessionChange =
  | { kind: "PARTICIPANT_CHANGED" }
  | { kind: "ACCOUNT_SWITCH" }
  | { kind: "RECOVERY_STARTED" }
  | { kind: "RISK_ESCALATION"; flag: RiskFlag }
  | { kind: "SAFETY_ESCALATION" };

export interface SessionService {
  startCall(input: StartCallInput): Promise<StartCallResult>;
  /**
   * Reconstructs AuthContext from server-side state. Throws SessionInvalidError
   * when the session is unknown, expired (even if TTL cleanup has not run),
   * revoked, ended, or bound to a different integration/tenant.
   */
  resolve(sessionRef: string, integration: IntegrationIdentity): Promise<AuthContext>;
  /** Role chosen by the caller from a deterministic menu. Changing role drops privileges (new generation). */
  selectRole(sessionRef: string, integration: IntegrationIdentity, role: Role): Promise<AuthContext>;
  recordConsent(sessionRef: string, integration: IntegrationIdentity, consent: ConsentState): Promise<AuthContext>;
  /** Participant change, account switch, recovery or risk escalation: generation++, privileges dropped. */
  applyChange(sessionRef: string, integration: IntegrationIdentity, change: SessionChange): Promise<AuthContext>;
  revoke(sessionRef: string, reasonCode: string): Promise<void>;
  endCall(sessionRef: string, integration: IntegrationIdentity): Promise<void>;
  /** Strict boolean for the Talkdesk Auth Gate variable (AUTH-07). */
  authGate(sessionRef: string, integration: IntegrationIdentity): Promise<AuthGateResponse>;
}

/** Generic responses prevent account enumeration: zero, one or many matches look identical. */
export type GenericVerificationResponse = "IF_ELIGIBLE_A_LINK_WAS_SENT" | "IF_ELIGIBLE_A_CODE_WAS_SENT" | "VERIFICATION_UNAVAILABLE_USE_HUMAN";

/**
 * Added (additive, OPS-KS-01 caller-facing follow-up): why a begin answered
 * `VERIFICATION_UNAVAILABLE_USE_HUMAN` without looking anything up, when the cause is GLOBAL
 * deployment state that stops every ROUTINE notification: the OUTBOUND_NOTIFICATIONS switch,
 * the INTEGRATION switch of the notification sender, or an unreadable switch state (fail closed).
 * It is the same for every caller, so it reveals nothing about any account. Audit evidence only
 * (the gateway puts it on the begin's audit event); never returned to the caller.
 */
export type VerificationUnavailableReason = "KILL_SWITCH_OUTBOUND_NOTIFICATIONS" | "KILL_SWITCH_INTEGRATION" | "KILL_SWITCH_STATE_UNAVAILABLE";

export interface BeginVerificationInput {
  role: Role;
  /** Locates a candidate inside the restricted verification service only; never authenticates. */
  locator: { fullName: string; dateOfBirth: string } | { portalUsernameHint: string };
}

/**
 * Added (additive): the server-side binding of an opened verification transaction, for audit
 * evidence only (the portal audit event, the call's investigation timeline). Never returned to
 * the portal or any caller-facing surface. `sessionBindingRef` is the NON-bearer
 * `ses_bnd_<base64url(sha256)>` reference (keys.ts), never the bearer session reference.
 */
export interface VerificationBinding {
  /** Vendor interaction id of the call the transaction was issued for (an identifier, never authority). */
  callId: string;
  sessionBindingRef: string;
  /** Session generation after the binding (or the transaction's generation when nothing was bound). */
  sessionGeneration: number;
}

/**
 * Result of completeSecureLink / completeStepUp. `binding` is present only when the transaction
 * was opened (nonce matched, not reused, not expired); unknown, reused or expired links are never
 * attributed to a call.
 */
export interface VerificationCompletion {
  bound: boolean;
  reasonCode: string;
  binding?: VerificationBinding;
}

export interface VerificationService {
  /**
   * Preferred: short-lived secure link to the pre-registered channel, approved inside an MFA portal session.
   * `unavailableReason` is present only when outbound notifications are switched off (see VerificationUnavailableReason).
   */
  beginSecureLink(
    ctx: AuthContext,
    input: BeginVerificationInput,
  ): Promise<{ transactionId: string; matchCode: string; response: GenericVerificationResponse; unavailableReason?: VerificationUnavailableReason }>;
  /** Portal callback after OIDC authentication; binds the account to exactly this call session + generation. */
  completeSecureLink(input: { transactionId: string; nonce: string; idToken: string; matchCodeConfirmed: boolean }): Promise<VerificationCompletion>;
  /** Fallback OTP to the existing verified channel only (never a number supplied during the call). */
  beginOtp(ctx: AuthContext, input: BeginVerificationInput): Promise<{ challengeId: string; response: GenericVerificationResponse; unavailableReason?: VerificationUnavailableReason }>;
  /** Called only by the isolated DTMF capture path (telephony_control identity); digits never reach the model. */
  submitOtp(input: { sessionRef: string; challengeId: string; code: string }, integration: IntegrationIdentity): Promise<{ verified: boolean; reasonCode: string }>;
  /** A3: fresh, transaction-bound verification for one prepared-action digest. */
  beginStepUp(ctx: AuthContext, actionDigest: string): Promise<{ transactionId: string; response: GenericVerificationResponse; unavailableReason?: VerificationUnavailableReason }>;
  completeStepUp(input: { transactionId: string; nonce: string; idToken: string }): Promise<VerificationCompletion>;
}

export interface AssertionService {
  /** Signed short-lived assertion (issuer, audience, expiry, nonce, key id). */
  mint(claims: Omit<VerificationAssertionClaims, "iss" | "iat" | "nbf" | "exp" | "jti">, ttlSeconds: number): Promise<string>;
  verify(token: string, expected: { audience: string; purpose: VerificationAssertionClaims["purpose"] }): Promise<VerificationAssertionClaims>;
  /** Public JWKS for trusted verifiers; supports rotation (multiple active kids). */
  jwks(): Promise<{ keys: Record<string, unknown>[] }>;
}
