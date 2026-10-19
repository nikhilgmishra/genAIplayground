import { randomBytes, randomInt } from "node:crypto";
import { z } from "zod";
import {
  IntegrationIdentity,
  IsoDateTime,
  OpaqueId,
  Role,
  Sha256Hex,
  meetsAssurance,
} from "../protocol/index.js";
import type { Assurance, AuthContext, RiskFlag, VerificationMethod } from "../protocol/index.js";
import type { IdentityDirectory, NotificationSender, OidcClaims, OidcVerifier, RegisteredChannel } from "../adapters/ports.js";
import type { Clock } from "../shared/clock.js";
import { addMs, iso } from "../shared/clock.js";
import { constantTimeEqualHex, hmacHex, sha256Hex } from "../shared/canonical.js";
import { AccessDeniedError, ConflictError, PlatformError, SessionInvalidError, ValidationError } from "../shared/errors.js";
import { newId } from "../shared/ids.js";
import type { Logger, Metrics } from "../observability/ports.js";
import { silentLogger } from "../observability/logger.js";
import { noopMetrics } from "../observability/metrics.js";
import { FAIL_CLOSED_SNAPSHOT } from "../ops/kill-switches.js";
import { notificationBlock } from "../ops/notification-gate.js";
import type { KillSwitchSnapshot } from "../ops/ports.js";
import type { BeginVerificationInput, GenericVerificationResponse, KvStore, VerificationCompletion, VerificationService, VerificationUnavailableReason } from "./ports.js";
import type { VerificationConfig } from "./config.js";
import { VerificationAbuseMonitor } from "./abuse-monitor.js";
import { bindingRefFromHash, epochSeconds, hourWindow, kvKeys, sessionRefHash } from "./keys.js";
import { MATCH_CODE_PATTERN, newMatchCode } from "./match-code.js";
import { addRiskFlag, lifecycleProblem } from "./session-store.js";
import type { SessionRecord } from "./session-store.js";
import type { TrustedSessionService } from "./session-service.js";

/**
 * Verification (spec section 7).
 *
 * Preferred: a short-lived secure link sent to the account's pre-registered channel.
 * The person opens it, signs in to the existing IdP with MFA/passkey (OIDC, nonce
 * bound to this transaction), confirms the two-word match code they heard on the
 * call, and the platform binds that account to exactly this call session and
 * generation (A2). Fallback (only if enabled and TB-03 is evidenced): a six-digit
 * OTP to an existing verified sms/voice channel, entered through the isolated DTMF
 * path (A1). Step-up (A3 for one prepared action): fresh OIDC authentication bound
 * to the action digest.
 *
 * Enumeration resistance: name + DOB only LOCATE a candidate. Zero, one or many
 * matches, ineligible accounts, throttles and risk blocks all return the same
 * response shape and value; transactions/challenges are stored for every request
 * (decoys when nothing is sent). Eligibility is never logged.
 *
 * AUTH-ENUM-01: nothing a caller can observe LATER may depend on whether the locator
 * matched either. Per-account / per-destination throttles, the account OTP guess
 * budget, lockouts of a real account's challenge and recent number changes only
 * exist for real accounts, so they suppress the send or the comparison SILENTLY and
 * are recorded in the account-keyed abuse monitor (abuse-monitor.ts) — never as a
 * session risk flag (policy denies `verification:begin` on ENUMERATION_SUSPECTED /
 * OTP_ABUSE_SUSPECTED, which would turn the flag into a different tool result).
 * Session flags are set only by controls every caller triggers identically: too many
 * begins on the call, a locked challenge, the session OTP failure budget.
 *
 * Notifications switched off (OPS-KS-01, caller-facing): every begin (secure link, OTP,
 * step-up) first reads the kill-switch snapshot (`notificationSwitches`). While
 * OUTBOUND_NOTIFICATIONS or INTEGRATION <notification sender> is engaged, or the state is
 * unreadable, the composed KillSwitchGatedNotificationSender refuses every ROUTINE send, so
 * no link or code could arrive: the begin answers VERIFICATION_UNAVAILABLE_USE_HUMAN (human
 * route) BEFORE the per-session begin counter, any account lookup, any account or
 * destination throttle and any stored transaction. The switch state is global, so the answer
 * is identical for zero, one or many matches and spends no counter that only real accounts
 * have. The reason code (`unavailableReason`) is audit evidence only. A switch engaged
 * between this check and the send is still stopped by the gated sender (the caller then
 * hears the generic "if eligible" answer for that one request).
 *
 * Secrets: OTP codes exist in plaintext only on the way to the NotificationSender;
 * the store holds HMAC-SHA256(pepper, challengeId:code). Nonces are stored only as
 * sha256. Codes, nonces, ID tokens, names and DOBs are never logged or returned.
 */

const Locator = z.union([
  z.strictObject({
    fullName: z.string().min(1).max(200),
    dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)), "invalid date"),
  }),
  z.strictObject({ portalUsernameHint: z.string().min(3).max(64) }),
]);

/** Strict: a destination number, NPI, ZIP or any other caller-supplied field is rejected outright. */
export const BeginVerificationInputSchema = z.strictObject({ role: Role, locator: Locator });

const TransactionId = z.string().regex(/^vtx_[A-Za-z0-9_-]{16,64}$/);
const ChallengeId = z.string().regex(/^otc_[A-Za-z0-9_-]{16,64}$/);
const Nonce = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const ReasonCode = z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/);

const VerificationTx = z.strictObject({
  schema: z.literal("vsp.verification-tx.v1"),
  kind: z.enum(["secure_link", "step_up"]),
  status: z.enum(["PENDING", "CONSUMED"]),
  eligible: z.boolean(),
  tenantId: OpaqueId,
  sessionRefHash: Sha256Hex,
  generation: z.number().int().min(1),
  callId: OpaqueId,
  role: Role,
  candidateActorId: OpaqueId.nullable(),
  candidateAccountId: OpaqueId.nullable(),
  actionDigest: Sha256Hex.nullable(),
  nonceHash: Sha256Hex,
  matchCode: z.string().regex(MATCH_CODE_PATTERN).nullable(),
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
  consumedAt: IsoDateTime.nullable(),
  outcome: ReasonCode.nullable(),
});
type VerificationTx = z.infer<typeof VerificationTx>;

const OtpChallenge = z.strictObject({
  schema: z.literal("vsp.otp-challenge.v1"),
  status: z.enum(["PENDING", "VERIFIED", "LOCKED"]),
  eligible: z.boolean(),
  tenantId: OpaqueId,
  sessionRefHash: Sha256Hex,
  generation: z.number().int().min(1),
  callId: OpaqueId,
  role: Role,
  candidateActorId: OpaqueId.nullable(),
  candidateAccountId: OpaqueId.nullable(),
  channelKind: z.enum(["sms", "voice"]).nullable(),
  codeHmac: Sha256Hex,
  attempts: z.number().int().min(0),
  /** Position of this challenge among the session's OTP challenges; only the latest one accepts digits (AUTH-OTP-LIMIT-01). */
  sessionSeq: z.number().int().min(1),
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
});
type OtpChallenge = z.infer<typeof OtpChallenge>;

const SubmitOtpInput = z.strictObject({
  sessionRef: z.string().max(128),
  challengeId: ChallengeId,
  code: z.string().max(16),
});

const CompleteSecureLinkInput = z.strictObject({
  transactionId: TransactionId,
  nonce: Nonce,
  idToken: z.string().min(16).max(16_384),
  matchCodeConfirmed: z.boolean(),
});

const CompleteStepUpInput = z.strictObject({ transactionId: TransactionId, nonce: Nonce, idToken: z.string().min(16).max(16_384) });

interface Candidate {
  accountId: string;
  actorId: string;
  channel: RegisteredChannel;
}

export interface VerificationServiceDeps {
  sessions: TrustedSessionService;
  kv: KvStore;
  directory: IdentityDirectory;
  oidc: OidcVerifier;
  notifications: NotificationSender;
  clock: Clock;
  config: VerificationConfig;
  /**
   * HMAC pepper for OTP digests (>= 32 bytes). Live: loaded from Secrets Manager
   * (BLOCKED until provisioned). Tests: a labelled LOCAL value.
   */
  otpPepper: Buffer;
  logger?: Logger;
  metrics?: Metrics;
  /** Account-keyed abuse monitoring store (AUTH-ENUM-01); defaults to one over `kv`. */
  abuseMonitor?: VerificationAbuseMonitor;
  /**
   * OPS-KS-01 (caller-facing): reads the current kill-switch snapshot for the deployment's tenant
   * (`KillSwitchService.snapshot`, the same reader the KillSwitchGatedNotificationSender is composed
   * with). Consulted before any account lookup; a throw, a rejection or a malformed snapshot counts
   * as "switched off" (fail closed, like the gated sender). The INTEGRATION target is
   * `notifications.integrationId`. When omitted nothing is pre-checked and, while sends are refused, the
   * caller still hears the generic "if eligible" answer; a composition root must therefore always pass it
   * (README, integration contract item 0).
   */
  notificationSwitches?: () => Promise<KillSwitchSnapshot>;
}

const STORE_GRACE_SECONDS = 3600;

/**
 * Throttle counter kinds for the OTP submission limits (AUTH-OTP-LIMIT-01):
 * - OTP_ACCOUNT_GUESSES (per account, hourly window): one slot is RESERVED by an atomic increment
 *   before each comparison on a real account's challenge, so concurrent guesses across calls can
 *   never exceed `otpMaxFailuresPerAccountPerHour` compared guesses per account per hour (a correct
 *   entry also uses its slot). Also read by `beginOtp`: a spent budget means no new code is sent.
 * - OTP_SESSION_FAILURES (per session): incorrect entries on ANY challenge of the call, decoy or
 *   real, so it behaves identically for every caller.
 * - OTP_SESSION_SEQ (per session): sequence of the session's challenges; only the latest accepts digits.
 */
const OTP_ACCOUNT_GUESSES = "otp-guess";
const OTP_SESSION_FAILURES = "otp-sfail";
const OTP_SESSION_SEQ = "otp-seq";

/** Effective assurance for one prepared action: A3 only when an unexpired step-up is bound to exactly this digest. */
export function effectiveAssuranceFor(ctx: AuthContext, actionDigest: string, now: Date): Assurance {
  const s = ctx.stepUp;
  if (s && meetsAssurance(ctx.assurance, "A2") && s.actionDigest === actionDigest && now.getTime() < Date.parse(s.expiresAt)) return "A3";
  return ctx.assurance === "A3" ? "A2" : ctx.assurance;
}

export class SecureVerificationService implements VerificationService {
  private readonly logger: Logger;
  private readonly metrics: Metrics;
  private readonly cfg: VerificationConfig;
  /** Account-keyed abuse signals (security monitoring only; never caller-observable). */
  readonly abuse: VerificationAbuseMonitor;

  constructor(private readonly deps: VerificationServiceDeps) {
    if (!Buffer.isBuffer(deps.otpPepper) || deps.otpPepper.length < 32) throw new ValidationError("OTP_PEPPER_INVALID");
    this.cfg = deps.config;
    this.logger = (deps.logger ?? silentLogger).child({ component: "identity.verification" });
    this.metrics = deps.metrics ?? noopMetrics;
    this.abuse = deps.abuseMonitor ?? new VerificationAbuseMonitor({ kv: deps.kv, clock: deps.clock, metrics: this.metrics, retentionHours: deps.config.abuseSignalRetentionHours });
  }

  // =========================== secure link (preferred) ===========================

  async beginSecureLink(
    ctx: AuthContext,
    input: BeginVerificationInput,
  ): Promise<{ transactionId: string; matchCode: string; response: GenericVerificationResponse; unavailableReason?: VerificationUnavailableReason }> {
    const req = this.parseBegin(input);
    const { hash, rec } = await this.currentSession(ctx);
    this.assertRole(rec, req.role);
    const transactionId = newId("vtx", 24);
    const matchCode = newMatchCode();
    // OPS-KS-01: decided before any counter or lookup (global state: identical for every caller).
    const switchedOff = await this.notificationsSwitchedOff(hash, "secure_link");
    if (switchedOff) return { transactionId, matchCode, response: "VERIFICATION_UNAVAILABLE_USE_HUMAN", unavailableReason: switchedOff };

    if (!(await this.sessionBeginAllowed(hash, rec))) return { transactionId, matchCode, response: "VERIFICATION_UNAVAILABLE_USE_HUMAN" };

    let candidate: Candidate | null;
    try {
      candidate = await this.findEligible(req, this.cfg.linkChannelKinds);
    } catch {
      // Directory outage affects every caller identically, so this response reveals nothing about any account.
      this.logger.warn("identity.verification.directory_unavailable", { sessionBindingRef: bindingRefFromHash(hash) });
      return { transactionId, matchCode, response: "VERIFICATION_UNAVAILABLE_USE_HUMAN" };
    }
    if (candidate && !(await this.withinLimit("link-acct", candidate.accountId, this.cfg.linkMaxPerAccountPerHour))) {
      // Protects the account holder from a flood of unsolicited links: delivery is suppressed SILENTLY and the
      // signal goes to the account-keyed monitor. No session flag: it would change this caller's later results
      // only when the locator is a real person (AUTH-ENUM-01).
      await this.abuse.record("LINK_ACCOUNT_LIMIT", { kind: "account", id: candidate.accountId });
      candidate = null;
    }

    const nonce = randomBytes(32).toString("base64url");
    const now = this.deps.clock.now();
    const tx: VerificationTx = {
      schema: "vsp.verification-tx.v1",
      kind: "secure_link",
      status: "PENDING",
      eligible: candidate !== null,
      tenantId: rec.tenantId,
      sessionRefHash: hash,
      generation: rec.generation,
      callId: rec.callId,
      role: req.role,
      candidateActorId: candidate?.actorId ?? null,
      candidateAccountId: candidate?.accountId ?? null,
      actionDigest: null,
      nonceHash: sha256Hex(nonce),
      matchCode,
      createdAt: iso(now),
      expiresAt: iso(addMs(now, this.cfg.secureLinkExpirySeconds * 1000)),
      consumedAt: null,
      outcome: null,
    };
    await this.storeNew(kvKeys.secureLinkTx(transactionId), tx, tx.expiresAt);
    if (candidate) await this.sendLink(candidate.channel.channelRef, this.cfg.templates.secureLink, transactionId, nonce);
    this.logger.info("identity.verification.secure_link.begun", { sessionBindingRef: bindingRefFromHash(hash), sessionGeneration: rec.generation });
    return { transactionId, matchCode, response: "IF_ELIGIBLE_A_LINK_WAS_SENT" };
  }

  /**
   * Portal step 1 (portal channel only): the portal page holds the transaction id
   * (path) and nonce (URL fragment, never sent in HTTP requests). Returns the match
   * code to display after sign-in. Unknown, consumed, expired, ineligible or
   * nonce-mismatched transactions are indistinguishable.
   */
  async describeTransaction(input: { transactionId: string; nonce: string }, integration: IntegrationIdentity): Promise<{ kind: "secure_link" | "step_up"; matchCode: string | null; expiresAt: string }> {
    const integ = IntegrationIdentity.safeParse(integration);
    if (!integ.success || integ.data.channel !== "portal") throw new AccessDeniedError("PORTAL_CHANNEL_REQUIRED");
    const p = z.strictObject({ transactionId: TransactionId, nonce: Nonce }).safeParse(input);
    if (!p.success) throw new AccessDeniedError("VERIFICATION_TRANSACTION_UNAVAILABLE");
    const item = await this.deps.kv.get<unknown>(kvKeys.secureLinkTx(p.data.transactionId));
    const tx = item ? VerificationTx.safeParse(item.data) : null;
    if (
      !tx?.success ||
      tx.data.status !== "PENDING" ||
      !tx.data.eligible ||
      tx.data.tenantId !== integ.data.tenantId ||
      this.deps.clock.now().getTime() >= Date.parse(tx.data.expiresAt) ||
      !constantTimeEqualHex(sha256Hex(p.data.nonce), tx.data.nonceHash)
    ) {
      throw new AccessDeniedError("VERIFICATION_TRANSACTION_UNAVAILABLE");
    }
    return { kind: tx.data.kind, matchCode: tx.data.matchCode, expiresAt: tx.data.expiresAt };
  }

  async completeSecureLink(input: { transactionId: string; nonce: string; idToken: string; matchCodeConfirmed: boolean }): Promise<VerificationCompletion> {
    const p = CompleteSecureLinkInput.safeParse(input);
    if (!p.success) return this.completion("secure_link_oidc", null, "VERIFICATION_INPUT_INVALID");
    const { transactionId, nonce, idToken, matchCodeConfirmed } = p.data;
    const opened = await this.openTransaction(transactionId, nonce, "secure_link");
    if ("reason" in opened) return this.completion("secure_link_oidc", null, opened.reason);
    const tx = opened.tx;
    if (!matchCodeConfirmed) return this.completion("secure_link_oidc", tx, "MATCH_CODE_NOT_CONFIRMED");
    if (!tx.eligible || !tx.candidateActorId || !tx.candidateAccountId) return this.completion("secure_link_oidc", tx, "VERIFICATION_TRANSACTION_UNAVAILABLE");

    const claims = await this.verifyToken(idToken, nonce, this.cfg.maxAuthAgeSeconds);
    if ("reason" in claims) return this.completion("secure_link_oidc", tx, claims.reason);
    const actorCheck = await this.checkActor(claims.claims, tx.candidateActorId, tx.candidateAccountId);
    if (actorCheck) return this.completion("secure_link_oidc", tx, actorCheck);

    let subjectId: string | null;
    let organizationId: string | null;
    try {
      subjectId = await this.deps.directory.selfSubjectId(tx.candidateActorId, tx.role);
      organizationId = await this.deps.directory.organizationFor(tx.candidateActorId, tx.role);
    } catch {
      return this.completion("secure_link_oidc", tx, "DIRECTORY_UNAVAILABLE");
    }
    const actorId = tx.candidateActorId;
    const accountId = tx.candidateAccountId;
    const authenticatedAt = iso(new Date(claims.claims.authTime * 1000));
    const bound = await this.deps.sessions.store.mutate(tx.sessionRefHash, (rec, now) => {
      const problem = this.bindingPreconditions(rec, tx, now);
      if (problem) return { abort: problem };
      if (rec.actorId !== null && rec.actorId !== actorId) return { abort: "ACCOUNT_ALREADY_BOUND" };
      return {
        ...rec,
        actorId,
        accountId,
        selectedRole: tx.role,
        subjectId,
        organizationId,
        delegatedAuthority: [],
        permittedScopes: [...(this.cfg.roleScopes[tx.role] ?? [])],
        assurance: "A2",
        authenticatedAt,
        verificationMethod: "secure_link_oidc",
        stepUp: null,
        lastChange: "VERIFIED_SECURE_LINK",
      };
    });
    if ("aborted" in bound) return this.completion("secure_link_oidc", tx, bound.aborted);
    return this.completion("secure_link_oidc", tx, "VERIFIED", bound.rec.generation);
  }

  // =========================== OTP fallback ===========================

  async beginOtp(ctx: AuthContext, input: BeginVerificationInput): Promise<{ challengeId: string; response: GenericVerificationResponse; unavailableReason?: VerificationUnavailableReason }> {
    const req = this.parseBegin(input);
    const { hash, rec } = await this.currentSession(ctx);
    this.assertRole(rec, req.role);
    const challengeId = newId("otc", 24);
    // OTP stays off until TB-03 (isolated DTMF capture) is evidenced; the response is identical for every caller.
    if (!this.cfg.otpEnabled) return { challengeId, response: "VERIFICATION_UNAVAILABLE_USE_HUMAN" };
    // OPS-KS-01: before the session counters and the account lookup (no code could be delivered).
    const switchedOff = await this.notificationsSwitchedOff(hash, "otp");
    if (switchedOff) return { challengeId, response: "VERIFICATION_UNAVAILABLE_USE_HUMAN", unavailableReason: switchedOff };
    if (!(await this.sessionBeginAllowed(hash, rec))) return { challengeId, response: "VERIFICATION_UNAVAILABLE_USE_HUMAN" };

    let candidate: Candidate | null;
    try {
      candidate = await this.findEligible(req, this.cfg.otpChannelKinds);
    } catch {
      this.logger.warn("identity.verification.directory_unavailable", { sessionBindingRef: bindingRefFromHash(hash) });
      return { challengeId, response: "VERIFICATION_UNAVAILABLE_USE_HUMAN" };
    }
    const now = this.deps.clock.now();
    if (candidate && rec.riskFlags.includes("OTP_ABUSE_SUSPECTED")) {
      // Once this call has shown OTP abuse signals, no further codes are sent on it (the caller still hears the generic response).
      candidate = null;
    }
    // Account-derived risk signals below suppress the send SILENTLY and go to the account-keyed monitor, never to
    // the session: a session flag would change this caller's later results only for real people (AUTH-ENUM-01).
    if (candidate && this.recentlyChanged(candidate.channel, now)) {
      // SIM-swap risk: never send a possession challenge to a recently changed number.
      await this.abuse.record("RECENT_NUMBER_CHANGE", { kind: "account", id: candidate.accountId });
      candidate = null;
    }
    if (candidate) {
      const account = { kind: "account", id: candidate.accountId } as const;
      const guesses = await this.counterValue(OTP_ACCOUNT_GUESSES, candidate.accountId).catch(() => Number.POSITIVE_INFINITY);
      const accountOk = await this.withinLimit("otp-acct", candidate.accountId, this.cfg.otpMaxPerAccountPerHour);
      const destinationOk = await this.withinLimit("otp-dest", candidate.channel.channelRef, this.cfg.otpMaxPerDestinationPerHour);
      if (!accountOk) await this.abuse.record("OTP_ACCOUNT_LIMIT", account);
      if (!destinationOk) await this.abuse.record("OTP_DESTINATION_LIMIT", { kind: "destination", id: candidate.channel.channelRef });
      if (guesses >= this.cfg.otpMaxFailuresPerAccountPerHour) await this.abuse.record("OTP_ACCOUNT_GUESS_LIMIT", account);
      if (!accountOk || !destinationOk || guesses >= this.cfg.otpMaxFailuresPerAccountPerHour) candidate = null;
    }

    // Every stored challenge (decoy or real) becomes the session's only outstanding one (AUTH-OTP-LIMIT-01).
    const sessionSeq = await this.deps.kv.increment(kvKeys.throttle(OTP_SESSION_SEQ, hash, 0), this.sessionCounterTtl(rec.expiresAt));
    // A code is generated for every request; for decoys it is discarded immediately.
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const challenge: OtpChallenge = {
      schema: "vsp.otp-challenge.v1",
      status: "PENDING",
      eligible: candidate !== null,
      tenantId: rec.tenantId,
      sessionRefHash: hash,
      generation: rec.generation,
      callId: rec.callId,
      role: req.role,
      candidateActorId: candidate?.actorId ?? null,
      candidateAccountId: candidate?.accountId ?? null,
      channelKind: candidate ? (candidate.channel.kind === "voice" ? "voice" : "sms") : null,
      codeHmac: this.codeDigest(challengeId, code),
      attempts: 0,
      sessionSeq,
      createdAt: iso(now),
      expiresAt: iso(addMs(now, this.cfg.otpExpirySeconds * 1000)),
    };
    await this.storeNew(kvKeys.otpChallenge(challengeId), challenge, challenge.expiresAt);
    if (candidate) {
      try {
        await this.deps.notifications.send({
          channelRef: candidate.channel.channelRef,
          templateId: this.cfg.templates.otpCode,
          slots: { code, expiryMinutes: String(Math.ceil(this.cfg.otpExpirySeconds / 60)) },
          idempotencyKey: `otc:${sha256Hex(challengeId).slice(0, 40)}`,
        });
      } catch (err) {
        this.logger.warn("identity.verification.notification_failed", { reasonCode: err instanceof PlatformError ? err.reasonCode : "NOTIFICATION_FAILED" });
      }
    }
    this.logger.info("identity.verification.otp.begun", { sessionBindingRef: bindingRefFromHash(hash), sessionGeneration: rec.generation });
    return { challengeId, response: "IF_ELIGIBLE_A_CODE_WAS_SENT" };
  }

  async submitOtp(input: { sessionRef: string; challengeId: string; code: string }, integration: IntegrationIdentity): Promise<{ verified: boolean; reasonCode: string }> {
    const integ = IntegrationIdentity.safeParse(integration);
    // Only the isolated DTMF capture path may submit digits; the model-facing MCP channel never sees or relays them.
    if (!integ.success || integ.data.channel !== "telephony_control") throw new AccessDeniedError("OTP_SUBMIT_CHANNEL_NOT_ALLOWED");
    const p = SubmitOtpInput.safeParse(input);
    if (!p.success) throw new ValidationError("OTP_INPUT_INVALID");
    const ctx = await this.deps.sessions.resolve(p.data.sessionRef, integ.data);
    const hash = sessionRefHash(p.data.sessionRef);
    const pk = kvKeys.otpChallenge(p.data.challengeId);
    const candidateDigest = this.codeDigest(p.data.challengeId, p.data.code);
    const formatOk = /^\d{6}$/.test(p.data.code);
    const now = this.deps.clock.now();

    // Session-scoped limits (AUTH-OTP-LIMIT-01). They depend only on what happened on this call, never on
    // whether a challenge is a decoy, so they behave identically for every caller (AUTH-ENUM-01):
    // only the session's latest challenge accepts digits; after any lockout (OTP_ABUSE_SUSPECTED) or once the
    // session's failure budget is spent, no challenge on this call accepts digits.
    const currentSeq = await this.counterAt(kvKeys.throttle(OTP_SESSION_SEQ, hash, 0));
    const sessionFailures = await this.counterAt(kvKeys.throttle(OTP_SESSION_FAILURES, hash, 0));
    const sessionBlocked = ctx.riskFlags.includes("OTP_ABUSE_SUSPECTED") || sessionFailures >= this.cfg.otpMaxFailuresPerAccountPerHour;
    const gate = (ch: OtpChallenge): string | null => {
      if (ch.sessionRefHash !== hash || ch.callId !== ctx.callId || ch.tenantId !== ctx.tenantId) return "OTP_CHALLENGE_INVALID";
      if (ch.generation !== ctx.sessionGeneration) return "OTP_SESSION_CHANGED";
      if (ch.status === "VERIFIED") return "OTP_CHALLENGE_ALREADY_USED";
      if (ch.sessionSeq !== currentSeq) return "OTP_CHALLENGE_SUPERSEDED";
      if (sessionBlocked || ch.status === "LOCKED" || ch.attempts >= this.cfg.otpMaxAttemptsPerChallenge) return "OTP_CHALLENGE_LOCKED";
      if (now.getTime() >= Date.parse(ch.expiresAt)) return "OTP_CHALLENGE_EXPIRED";
      return null;
    };

    // Account guess budget ("five per account per hour", spec section 7), enforced at SUBMISSION: a slot is
    // reserved atomically before the comparison, so guesses spread over many calls or sent concurrently can
    // never exceed it. A spent budget skips the comparison: the attempt is handled exactly like a wrong code,
    // which is what every decoy challenge does, so the caller learns nothing (the signal goes to the monitor).
    let budgetOk = true;
    const pre = await this.readRecord(pk, OtpChallenge);
    if (pre && gate(pre) === null && pre.eligible && pre.candidateAccountId) {
      budgetOk = await this.withinLimit(OTP_ACCOUNT_GUESSES, pre.candidateAccountId, this.cfg.otpMaxFailuresPerAccountPerHour);
      if (!budgetOk) await this.abuse.record("OTP_ACCOUNT_GUESS_LIMIT", { kind: "account", id: pre.candidateAccountId });
    }

    const outcome: { verdict: "MATCH" | "OTP_INCORRECT" | "OTP_CHALLENGE_LOCKED" | null } = { verdict: null };
    const updated = await this.updateRecord(pk, OtpChallenge, (ch) => {
      const problem = gate(ch);
      if (problem) return { abort: problem };
      const match = budgetOk && constantTimeEqualHex(candidateDigest, ch.codeHmac) && formatOk && ch.eligible;
      if (match) {
        outcome.verdict = "MATCH";
        return { ...ch, status: "VERIFIED" as const };
      }
      const attempts = ch.attempts + 1;
      const locked = attempts >= this.cfg.otpMaxAttemptsPerChallenge;
      outcome.verdict = locked ? "OTP_CHALLENGE_LOCKED" : "OTP_INCORRECT";
      return { ...ch, attempts, status: locked ? ("LOCKED" as const) : ch.status };
    });
    if ("aborted" in updated) {
      if (updated.aborted === "OTP_CHALLENGE_EXPIRED") this.verificationMetric("otp_sms_registered_channel", "expired");
      return this.otpResult(false, updated.aborted === "NOT_FOUND" ? "OTP_CHALLENGE_INVALID" : updated.aborted, hash);
    }
    const ch = updated.value;
    let verdict = outcome.verdict ?? "OTP_INCORRECT";
    if (verdict !== "MATCH") {
      // Counted for decoy and real challenges alike; an unavailable counter is treated as a spent budget (fail closed).
      const failures = await this.deps.kv.increment(kvKeys.throttle(OTP_SESSION_FAILURES, hash, 0), this.sessionCounterTtl(ctx.expiresAt)).catch(() => Number.POSITIVE_INFINITY);
      if (failures >= this.cfg.otpMaxFailuresPerAccountPerHour) verdict = "OTP_CHALLENGE_LOCKED";
      if (verdict === "OTP_CHALLENGE_LOCKED") {
        if (ch.eligible && ch.candidateAccountId) await this.abuse.record("OTP_ACCOUNT_CHALLENGE_LOCKED", { kind: "account", id: ch.candidateAccountId });
        // Session-scoped and uniform: decoy challenges lock the same way.
        await this.flagSession(hash, "OTP_ABUSE_SUSPECTED");
        this.verificationMetric("otp_sms_registered_channel", "locked");
      } else this.verificationMetric("otp_sms_registered_channel", "failure");
      return this.otpResult(false, verdict, hash);
    }

    if (!ch.candidateActorId || !ch.candidateAccountId) return this.otpResult(false, "OTP_CHALLENGE_INVALID", hash);
    const actorId = ch.candidateActorId;
    const accountId = ch.candidateAccountId;
    let subjectId: string | null;
    let organizationId: string | null;
    try {
      if ((await this.deps.directory.accountState(accountId)) !== "ACTIVE") return this.otpResult(false, "ACCOUNT_NOT_ACTIVE", hash);
      subjectId = await this.deps.directory.selfSubjectId(actorId, ch.role);
      organizationId = await this.deps.directory.organizationFor(actorId, ch.role);
    } catch {
      return this.otpResult(false, "DIRECTORY_UNAVAILABLE", hash);
    }
    const method: VerificationMethod = ch.channelKind === "voice" ? "otp_voice_registered_channel" : "otp_sms_registered_channel";
    const bound = await this.deps.sessions.store.mutate(hash, (rec, now) => {
      const problem = lifecycleProblem(rec, now) ?? (rec.generation !== ch.generation ? "SESSION_GENERATION_CHANGED" : null);
      if (problem) return { abort: problem };
      if (rec.actorId !== null && rec.actorId !== actorId) return { abort: "ACCOUNT_ALREADY_BOUND" };
      if (rec.actorId === actorId && meetsAssurance(rec.assurance, "A1")) return rec; // never downgrade an existing binding
      return {
        ...rec,
        actorId,
        accountId,
        selectedRole: ch.role,
        subjectId,
        organizationId,
        delegatedAuthority: [],
        permittedScopes: [...this.cfg.a1Scopes],
        assurance: "A1",
        authenticatedAt: iso(now),
        verificationMethod: method,
        stepUp: null,
        lastChange: "VERIFIED_OTP",
      };
    });
    if ("aborted" in bound) return this.otpResult(false, bound.aborted, hash);
    this.verificationMetric(method, "success");
    return this.otpResult(true, "VERIFIED", hash);
  }

  // =========================== step-up (A3, one action digest) ===========================

  async beginStepUp(ctx: AuthContext, actionDigest: string): Promise<{ transactionId: string; response: GenericVerificationResponse; unavailableReason?: VerificationUnavailableReason }> {
    if (!Sha256Hex.safeParse(actionDigest).success) throw new ValidationError("ACTION_DIGEST_INVALID");
    const { hash, rec } = await this.currentSession(ctx);
    if (!meetsAssurance(rec.assurance, "A2") || !rec.actorId || !rec.accountId || !rec.selectedRole) throw new AccessDeniedError("STEP_UP_REQUIRES_A2");
    const transactionId = newId("vtx", 24);
    // OPS-KS-01: no step-up link could be delivered; the human route instead (before the account lookup).
    const switchedOff = await this.notificationsSwitchedOff(hash, "step_up");
    if (switchedOff) return { transactionId, response: "VERIFICATION_UNAVAILABLE_USE_HUMAN", unavailableReason: switchedOff };
    let channel: RegisteredChannel | null = null;
    try {
      if ((await this.deps.directory.accountState(rec.accountId)) === "ACTIVE") {
        channel = this.pickChannel(await this.deps.directory.registeredChannels(rec.accountId), this.cfg.linkChannelKinds);
      }
    } catch {
      channel = null;
    }
    if (!channel) return { transactionId, response: "VERIFICATION_UNAVAILABLE_USE_HUMAN" };
    const nonce = randomBytes(32).toString("base64url");
    const now = this.deps.clock.now();
    const tx: VerificationTx = {
      schema: "vsp.verification-tx.v1",
      kind: "step_up",
      status: "PENDING",
      eligible: true,
      tenantId: rec.tenantId,
      sessionRefHash: hash,
      generation: rec.generation,
      callId: rec.callId,
      role: rec.selectedRole,
      candidateActorId: rec.actorId,
      candidateAccountId: rec.accountId,
      actionDigest,
      nonceHash: sha256Hex(nonce),
      matchCode: null,
      createdAt: iso(now),
      expiresAt: iso(addMs(now, this.cfg.secureLinkExpirySeconds * 1000)),
      consumedAt: null,
      outcome: null,
    };
    await this.storeNew(kvKeys.secureLinkTx(transactionId), tx, tx.expiresAt);
    await this.sendLink(channel.channelRef, this.cfg.templates.stepUpLink, transactionId, nonce);
    this.logger.info("identity.verification.step_up.begun", { sessionBindingRef: bindingRefFromHash(hash), actionDigest });
    return { transactionId, response: "IF_ELIGIBLE_A_LINK_WAS_SENT" };
  }

  async completeStepUp(input: { transactionId: string; nonce: string; idToken: string }): Promise<VerificationCompletion> {
    const p = CompleteStepUpInput.safeParse(input);
    if (!p.success) return this.completion("secure_link_oidc", null, "VERIFICATION_INPUT_INVALID");
    const opened = await this.openTransaction(p.data.transactionId, p.data.nonce, "step_up");
    if ("reason" in opened) return this.completion("secure_link_oidc", null, opened.reason);
    const tx = opened.tx;
    if (!tx.candidateActorId || !tx.candidateAccountId || !tx.actionDigest) return this.completion("secure_link_oidc", tx, "VERIFICATION_TRANSACTION_UNAVAILABLE");
    const claims = await this.verifyToken(p.data.idToken, p.data.nonce, this.cfg.stepUpMaxAuthAgeSeconds);
    if ("reason" in claims) return this.completion("secure_link_oidc", tx, claims.reason);
    const actorCheck = await this.checkActor(claims.claims, tx.candidateActorId, tx.candidateAccountId);
    if (actorCheck) return this.completion("secure_link_oidc", tx, actorCheck);
    const actionDigest = tx.actionDigest;
    const actorId = tx.candidateActorId;
    const bound = await this.deps.sessions.store.mutate(tx.sessionRefHash, (rec, now) => {
      const problem = this.bindingPreconditions(rec, tx, now);
      if (problem) return { abort: problem };
      if (rec.actorId !== actorId || !meetsAssurance(rec.assurance, "A2")) return { abort: "STEP_UP_REQUIRES_A2" };
      return {
        ...rec,
        stepUp: { actionDigest, verifiedAt: iso(now), expiresAt: iso(addMs(now, this.cfg.stepUpValiditySeconds * 1000)) },
        lastChange: "STEP_UP_VERIFIED",
      };
    });
    if ("aborted" in bound) return this.completion("secure_link_oidc", tx, bound.aborted);
    return this.completion("secure_link_oidc", tx, "STEP_UP_VERIFIED", bound.rec.generation);
  }

  // =========================== internals ===========================

  private parseBegin(input: BeginVerificationInput): z.infer<typeof BeginVerificationInputSchema> {
    const r = BeginVerificationInputSchema.safeParse(input);
    if (!r.success) throw new ValidationError("VERIFICATION_INPUT_INVALID");
    return r.data;
  }

  /** Re-derives the session from server state; only the bearer ref, integration and expected generation are taken from ctx (AUTH-03). */
  private async currentSession(ctx: AuthContext): Promise<{ hash: string; rec: SessionRecord }> {
    if (!ctx || typeof ctx !== "object") throw new SessionInvalidError("SESSION_REF_INVALID");
    const fresh = await this.deps.sessions.resolve(ctx.sessionRef, ctx.integration);
    if (fresh.sessionGeneration !== ctx.sessionGeneration) throw new SessionInvalidError("SESSION_GENERATION_CHANGED");
    const hash = sessionRefHash(ctx.sessionRef);
    const loaded = await this.deps.sessions.store.load(hash);
    if (!loaded || loaded.rec.generation !== ctx.sessionGeneration) throw new SessionInvalidError("SESSION_GENERATION_CHANGED");
    return { hash, rec: loaded.rec };
  }

  private assertRole(rec: SessionRecord, role: z.infer<typeof Role>): void {
    if (rec.selectedRole !== null && rec.selectedRole !== role) throw new AccessDeniedError("ROLE_NOT_SELECTED");
  }

  private async sessionBeginAllowed(hash: string, rec: SessionRecord): Promise<boolean> {
    const ttl = epochSeconds(new Date(rec.expiresAt)) + STORE_GRACE_SECONDS;
    const n = await this.deps.kv.increment(kvKeys.throttle("vbegin", hash, 0), ttl);
    if (n <= this.cfg.maxVerificationBeginsPerSession) return true;
    await this.flagSession(hash, "ENUMERATION_SUSPECTED");
    return false;
  }

  /**
   * OPS-KS-01: the reason ROUTINE notifications are switched off right now, or null. Uses the same pure
   * decision as the KillSwitchGatedNotificationSender (`notificationBlock`, purpose ROUTINE, INTEGRATION
   * target = the sender's integration id). Unreadable or malformed state fails closed. Reads nothing
   * account-related and touches no counter.
   */
  private async notificationsSwitchedOff(hash: string, method: "secure_link" | "otp" | "step_up"): Promise<VerificationUnavailableReason | null> {
    const read = this.deps.notificationSwitches;
    if (!read) return null;
    let snapshot: KillSwitchSnapshot | null = null;
    try {
      const s = await read();
      if (s && typeof s.outboundNotifications === "boolean" && Array.isArray(s.integrations)) snapshot = s;
    } catch {
      snapshot = null; // unreadable: fail closed
    }
    const block = notificationBlock(snapshot ?? FAIL_CLOSED_SNAPSHOT, "ROUTINE", this.deps.notifications.integrationId);
    if (!block) return null;
    const reasonCode: VerificationUnavailableReason = snapshot === null ? "KILL_SWITCH_STATE_UNAVAILABLE" : block;
    this.logger.warn("identity.verification.notifications_switched_off", { sessionBindingRef: bindingRefFromHash(hash), reasonCode, method });
    return reasonCode;
  }

  /** Exactly one ACTIVE candidate holding the role, with a verified channel of an allowed kind; otherwise null. */
  private async findEligible(req: z.infer<typeof BeginVerificationInputSchema>, kinds: readonly RegisteredChannel["kind"][]): Promise<Candidate | null> {
    const candidates = await this.deps.directory.findCandidates(req.locator);
    if (candidates.length !== 1) return null;
    const c = candidates[0];
    if (!c || !c.roles.includes(req.role)) return null;
    // A failure AFTER exactly one candidate was found only happens for real people; it must not surface as a
    // different response (AUTH-ENUM-01). Fail closed silently: treated as not eligible, nothing is sent.
    try {
      if ((await this.deps.directory.accountState(c.accountId)) !== "ACTIVE") return null;
      const channel = this.pickChannel(await this.deps.directory.registeredChannels(c.accountId), kinds);
      return channel ? { accountId: c.accountId, actorId: c.actorId, channel } : null;
    } catch {
      return null;
    }
  }

  private pickChannel(channels: RegisteredChannel[], kinds: readonly RegisteredChannel["kind"][]): RegisteredChannel | null {
    for (const kind of kinds) {
      const ch = channels.find((c) => c.kind === kind && c.verified === true && /^chn_[A-Za-z0-9_-]{16,64}$/.test(c.channelRef));
      if (ch) return ch;
    }
    return null;
  }

  private recentlyChanged(channel: RegisteredChannel, now: Date): boolean {
    if (channel.changedAt === null) return false;
    const changed = Date.parse(channel.changedAt);
    // An unparseable or future change time is treated as recent (fail closed).
    if (Number.isNaN(changed) || changed > now.getTime()) return true;
    return now.getTime() - changed < this.cfg.recentChannelChangeDays * 86_400_000;
  }

  private async withinLimit(kind: string, subject: string, limit: number): Promise<boolean> {
    try {
      return (await this.bump(kind, subject)) <= limit;
    } catch {
      return false; // throttle store unavailable: do not send (fail closed)
    }
  }

  private async bump(kind: string, subject: string): Promise<number> {
    const now = this.deps.clock.now();
    const w = hourWindow(now);
    return this.deps.kv.increment(kvKeys.throttle(kind, subject, w), (w + 2) * 3600);
  }

  private async counterValue(kind: string, subject: string): Promise<number> {
    return this.counterAt(kvKeys.throttle(kind, subject, hourWindow(this.deps.clock.now())));
  }

  private async counterAt(pk: string): Promise<number> {
    const item = await this.deps.kv.get<{ count?: unknown }>(pk);
    const c = item?.data.count;
    return typeof c === "number" ? c : 0;
  }

  /** Storage TTL for per-session counters: session hard expiry plus the store grace (cleanup only; readers never rely on it). */
  private sessionCounterTtl(sessionExpiresAt: string): number {
    return epochSeconds(new Date(sessionExpiresAt)) + STORE_GRACE_SECONDS;
  }

  private async readRecord<T>(pk: string, schema: z.ZodType<T>): Promise<T | null> {
    const item = await this.deps.kv.get<unknown>(pk);
    const r = item ? schema.safeParse(item.data) : null;
    return r?.success ? r.data : null;
  }

  private async flagSession(hash: string, flag: RiskFlag): Promise<void> {
    this.metrics.increment("vsp_challenge_abuse_signals_total", { signal: flag });
    try {
      await this.deps.sessions.store.mutate(hash, (rec, now) => {
        if (lifecycleProblem(rec, now)) return { abort: "SESSION_INVALID" };
        if (rec.riskFlags.includes(flag)) return { abort: "ALREADY_FLAGGED" };
        return { ...rec, riskFlags: addRiskFlag(rec.riskFlags, flag) };
      });
    } catch (err) {
      this.logger.warn("identity.verification.flag_failed", { reasonCode: err instanceof PlatformError ? err.reasonCode : "FLAG_FAILED" });
    }
    this.logger.info("identity.verification.risk_flag", { sessionBindingRef: bindingRefFromHash(hash), reasonCode: flag });
  }

  private codeDigest(challengeId: string, code: string): string {
    return hmacHex(this.deps.otpPepper, `vsp.otp.v1:${challengeId}:${code}`);
  }

  private async storeNew(pk: string, data: VerificationTx | OtpChallenge, expiresAt: string): Promise<void> {
    const ttl = epochSeconds(new Date(expiresAt)) + STORE_GRACE_SECONDS;
    if (!(await this.deps.kv.putIfAbsent({ pk, version: 1, ttlEpochSeconds: ttl, data }))) throw new ConflictError("VERIFICATION_ID_COLLISION");
  }

  private async sendLink(channelRef: string, templateId: string, transactionId: string, nonce: string): Promise<void> {
    try {
      await this.deps.notifications.send({
        channelRef,
        templateId,
        // Opaque transaction id in the path; the nonce in the fragment (never sent to servers, never in access logs). No PHI.
        slots: { linkPath: `${this.cfg.portalVerifyPath}${transactionId}#n=${nonce}` },
        idempotencyKey: `vtx:${sha256Hex(transactionId).slice(0, 40)}`,
      });
    } catch (err) {
      this.logger.warn("identity.verification.notification_failed", { reasonCode: err instanceof PlatformError ? err.reasonCode : "NOTIFICATION_FAILED" });
    }
  }

  /** Loads, nonce-checks and consumes (single use, CAS) a transaction, then checks expiry. */
  private async openTransaction(transactionId: string, nonce: string, kind: VerificationTx["kind"]): Promise<{ tx: VerificationTx } | { reason: string }> {
    const pk = kvKeys.secureLinkTx(transactionId);
    const nonceHash = sha256Hex(nonce);
    const now = this.deps.clock.now();
    const consumed = await this.updateRecord(pk, VerificationTx, (tx) => {
      if (tx.kind !== kind) return { abort: "VERIFICATION_TRANSACTION_UNAVAILABLE" };
      // A wrong nonce does not burn the transaction (it proves nothing about the link holder).
      if (!constantTimeEqualHex(nonceHash, tx.nonceHash)) return { abort: "VERIFICATION_NONCE_MISMATCH" };
      if (tx.status !== "PENDING") return { abort: "VERIFICATION_TRANSACTION_ALREADY_USED" };
      return { ...tx, status: "CONSUMED" as const, consumedAt: iso(now) };
    });
    if ("aborted" in consumed) return { reason: consumed.aborted === "NOT_FOUND" ? "VERIFICATION_TRANSACTION_UNAVAILABLE" : consumed.aborted };
    if (now.getTime() >= Date.parse(consumed.value.expiresAt)) return { reason: "VERIFICATION_TRANSACTION_EXPIRED" };
    return { tx: consumed.value };
  }

  private async verifyToken(idToken: string, nonce: string, maxAuthAgeSeconds: number): Promise<{ claims: OidcClaims } | { reason: string }> {
    let claims: OidcClaims;
    try {
      claims = await this.deps.oidc.verifyIdToken(idToken, { nonce, maxAuthAgeSeconds });
    } catch (err) {
      return { reason: err instanceof PlatformError ? err.reasonCode : "OIDC_TOKEN_INVALID" };
    }
    if (!claims.amr.some((m) => this.cfg.acceptedAmr.includes(m))) return { reason: "MFA_REQUIRED" };
    return { claims };
  }

  /** The IdP subject must map to exactly the candidate actor, whose account must still be ACTIVE. */
  private async checkActor(claims: OidcClaims, expectedActorId: string, accountId: string): Promise<string | null> {
    try {
      const actor = await this.deps.directory.actorForIdpSubject(claims.issuer, claims.sub);
      if (actor === null || actor !== expectedActorId) return "ACTOR_MISMATCH";
      if ((await this.deps.directory.accountState(accountId)) !== "ACTIVE") return "ACCOUNT_NOT_ACTIVE";
      return null;
    } catch {
      return "DIRECTORY_UNAVAILABLE";
    }
  }

  /** Session-fixation and cross-call defences: same session, same generation, same call, still live. */
  private bindingPreconditions(rec: SessionRecord, tx: VerificationTx, now: Date): string | null {
    const lifecycle = lifecycleProblem(rec, now);
    if (lifecycle) return lifecycle;
    if (rec.sessionRefHash !== tx.sessionRefHash || rec.tenantId !== tx.tenantId || rec.callId !== tx.callId) return "SESSION_CALL_MISMATCH";
    if (rec.generation !== tx.generation) return "SESSION_GENERATION_CHANGED";
    if (rec.selectedRole !== null && rec.selectedRole !== tx.role) return "ROLE_NOT_SELECTED";
    return null;
  }

  private async updateRecord<T>(pk: string, schema: z.ZodType<T>, fn: (cur: T) => T | { abort: string }): Promise<{ value: T } | { aborted: string }> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const item = await this.deps.kv.get<unknown>(pk);
      if (!item) return { aborted: "NOT_FOUND" };
      const cur = schema.safeParse(item.data);
      if (!cur.success) return { aborted: "NOT_FOUND" };
      const next = fn(cur.data);
      if (typeof next === "object" && next !== null && "abort" in next) return { aborted: (next as { abort: string }).abort };
      const value = schema.parse(next);
      if (await this.deps.kv.compareAndSwap(pk, item.version, value, item.ttlEpochSeconds)) return { value };
    }
    throw new ConflictError("VERIFICATION_UPDATE_CONFLICT", "VERIFICATION_UPDATE_CONFLICT", true);
  }

  /**
   * Completion result. When the transaction was opened (its nonce matched), the result also
   * carries the server-side binding of that transaction (call id, NON-bearer session binding ref,
   * session generation) for audit evidence only; unopened transactions carry none, so an unknown,
   * reused or expired link is never attributed to a call. The bearer session reference is never
   * returned.
   */
  private completion(method: VerificationMethod, tx: VerificationTx | null, reasonCode: string, generation?: number): VerificationCompletion {
    const bound = reasonCode === "VERIFIED" || reasonCode === "STEP_UP_VERIFIED";
    this.verificationMetric(method, bound ? "success" : reasonCode === "VERIFICATION_TRANSACTION_EXPIRED" ? "expired" : "failure");
    const sessionBindingRef = tx ? bindingRefFromHash(tx.sessionRefHash) : null;
    this.logger.info("identity.verification.completed", {
      reasonCode,
      sessionBindingRef,
      sessionGeneration: generation ?? null,
      method,
    });
    if (!tx || !sessionBindingRef) return { bound, reasonCode };
    return { bound, reasonCode, binding: { callId: tx.callId, sessionBindingRef, sessionGeneration: generation ?? tx.generation } };
  }

  private otpResult(verified: boolean, reasonCode: string, hash: string): { verified: boolean; reasonCode: string } {
    this.logger.info("identity.verification.otp.submitted", { reasonCode, sessionBindingRef: bindingRefFromHash(hash) });
    return { verified, reasonCode };
  }

  private verificationMetric(method: VerificationMethod, result: "success" | "failure" | "abandoned" | "locked" | "expired"): void {
    this.metrics.increment("vsp_identity_verifications_total", { method, result });
  }
}
