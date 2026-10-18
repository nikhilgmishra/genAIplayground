import { z } from "zod";
import { Environment, IntegrationIdentity, OpaqueId, Role, VersionLabel } from "../protocol/index.js";
import { ValidationError } from "../shared/errors.js";

/**
 * Identity-binding configuration. Numeric verification limits default to the
 * spec's PROPOSED initial values (section 7: five-minute OTP expiry, three
 * incorrect attempts per challenge, five per account per hour). Security must
 * approve final values; `PlatformConfig.verification.approvedBySecurity` records
 * that approval and is null until it exists.
 *
 * OTP is OFF unless explicitly enabled: TB-03 (isolated DTMF capture that keeps
 * digits away from ASR, model, recording and transcript) is UNKNOWN, and without
 * it the spec requires secure link / portal / human verification only.
 */
const Scope = z.string().regex(/^[a-z_]+:[a-z_]+$/);
type Channel = IntegrationIdentity["channel"];
const Channel = z.enum(["mcp_tools", "telephony_control", "portal", "console", "worker", "webhook"]);

export const SessionConfigSchema = z.strictObject({
  tenantId: OpaqueId,
  environment: Environment,
  policyVersion: VersionLabel,
  /** Hard session expiry enforced by every reader (AUTH-04). */
  sessionTtlSeconds: z.number().int().min(60).max(86_400),
  /** Extra time the storage TTL waits after hard expiry before DynamoDB may delete the item (cleanup only). */
  storageTtlGraceSeconds: z.number().int().min(0).max(7 * 86_400),
  /** Channels whose credentials may present a session reference. */
  resolveChannels: z.array(Channel).min(1).max(6),
  /** Channels allowed to create a call session (the deterministic Studio step). */
  startCallChannels: z.array(Channel).min(1).max(6),
  /** Channels allowed to record consent: never the model-facing MCP channel (AUTH-03). */
  consentChannels: z.array(Channel).min(1).max(6),
  /** Bounded optimistic-concurrency retries for every session update. */
  casMaxAttempts: z.number().int().min(1).max(20),
});
export type SessionConfig = z.infer<typeof SessionConfigSchema>;

export const DEFAULT_ROLE_SCOPES: Record<Role, string[]> = {
  client: ["appointment:read", "appointment:write", "invoice:read", "billing_review:create", "claim:read", "case:read", "case:create"],
  prospective_client: ["case:create"],
  provider: ["onboarding:read", "remittance:read", "appointment:read", "case:read", "case:create"],
  practice_staff: ["case:read", "case:create"],
  partner: ["case:read", "case:create"],
  payer_representative: ["case:create"],
  personal_representative: ["case:read", "case:create"],
};

/**
 * Scopes for A1 (verified possession). The spec permits only "low-risk account
 * operations approved by the identity risk assessment"; that assessment does not
 * exist yet, so the default is the most limited useful set.
 */
export const DEFAULT_A1_SCOPES: string[] = ["case:create"];

/**
 * Authentication-method references accepted as MFA / phishing-resistant proof in
 * the ID token `amr` claim (RFC 8176 values plus "fido" used by some IdPs):
 * mfa (multiple factors), hwk (hardware-held key), swk (software-held key),
 * otp (one-time password as an additional factor at the IdP), fido (FIDO/passkey),
 * pop (proof of possession). "pwd" alone is never sufficient. The identity owner
 * must confirm what each production IdP actually emits.
 */
export const DEFAULT_ACCEPTED_AMR = ["mfa", "hwk", "swk", "otp", "fido", "pop"] as const;

export const VerificationConfigSchema = z.strictObject({
  secureLinkExpirySeconds: z.number().int().min(30).max(3600),
  /** Max age of the IdP authentication (auth_time) for a secure-link binding. */
  maxAuthAgeSeconds: z.number().int().min(30).max(86_400),
  /** Step-up requires a fresh IdP authentication (auth_time within this window). */
  stepUpMaxAuthAgeSeconds: z.number().int().min(10).max(900),
  /** How long a step-up stays valid for its single action digest. */
  stepUpValiditySeconds: z.number().int().min(30).max(900),
  otpEnabled: z.boolean(),
  otpExpirySeconds: z.number().int().min(30).max(900),
  otpMaxAttemptsPerChallenge: z.number().int().min(1).max(10),
  otpMaxPerAccountPerHour: z.number().int().min(1).max(50),
  otpMaxFailuresPerAccountPerHour: z.number().int().min(1).max(50),
  otpMaxPerDestinationPerHour: z.number().int().min(1).max(50),
  otpChannelKinds: z.array(z.enum(["sms", "voice"])).min(1).max(2),
  /** Secure links per account per hour (notification abuse control). */
  linkMaxPerAccountPerHour: z.number().int().min(1).max(50),
  /** Verification begins allowed per call session before routing to a human (enumeration control). */
  maxVerificationBeginsPerSession: z.number().int().min(1).max(50),
  /** A registered channel changed within this many days is a SIM-swap risk signal: no OTP is sent. */
  recentChannelChangeDays: z.number().int().min(1).max(365),
  /**
   * Storage TTL of the account-keyed abuse monitoring counters (abuse-monitor.ts, AUTH-ENUM-01).
   * Engineering default pending Security approval; not a legal retention decision.
   */
  abuseSignalRetentionHours: z.number().int().min(1).max(24 * 90),
  /** Channel kinds a secure link may be delivered to, in preference order. */
  linkChannelKinds: z.array(z.enum(["portal_push", "email", "sms"])).min(1).max(3),
  acceptedAmr: z.array(z.string().regex(/^[a-z0-9_-]{2,16}$/)).min(1).max(16),
  /** Portal path prefix for secure links. Only opaque ids and the nonce fragment follow it; never PHI. */
  portalVerifyPath: z.string().regex(/^\/[a-z0-9/_-]{1,64}\/$/),
  roleScopes: z.record(Role, z.array(Scope).max(64)),
  a1Scopes: z.array(Scope).max(16),
  templates: z.strictObject({
    secureLink: z.string().regex(/^[a-z][a-z0-9_.]{2,80}$/),
    stepUpLink: z.string().regex(/^[a-z][a-z0-9_.]{2,80}$/),
    otpCode: z.string().regex(/^[a-z][a-z0-9_.]{2,80}$/),
  }),
});
export type VerificationConfig = z.infer<typeof VerificationConfigSchema>;

export const DEFAULT_SESSION_CONFIG: Omit<SessionConfig, "tenantId" | "environment" | "policyVersion"> = {
  sessionTtlSeconds: 7200,
  storageTtlGraceSeconds: 3600,
  resolveChannels: ["mcp_tools", "telephony_control", "portal"],
  startCallChannels: ["telephony_control"],
  consentChannels: ["telephony_control", "portal"],
  casMaxAttempts: 5,
};

export const DEFAULT_VERIFICATION_CONFIG: VerificationConfig = {
  secureLinkExpirySeconds: 300,
  maxAuthAgeSeconds: 900,
  stepUpMaxAuthAgeSeconds: 120,
  stepUpValiditySeconds: 300,
  otpEnabled: false,
  otpExpirySeconds: 300,
  otpMaxAttemptsPerChallenge: 3,
  otpMaxPerAccountPerHour: 5,
  otpMaxFailuresPerAccountPerHour: 5,
  otpMaxPerDestinationPerHour: 5,
  otpChannelKinds: ["sms"],
  linkMaxPerAccountPerHour: 5,
  maxVerificationBeginsPerSession: 5,
  recentChannelChangeDays: 30,
  abuseSignalRetentionHours: 168,
  linkChannelKinds: ["portal_push", "email", "sms"],
  acceptedAmr: [...DEFAULT_ACCEPTED_AMR],
  portalVerifyPath: "/verify/",
  roleScopes: DEFAULT_ROLE_SCOPES,
  a1Scopes: DEFAULT_A1_SCOPES,
  templates: { secureLink: "verify.secure_link", stepUpLink: "verify.step_up_link", otpCode: "verify.otp_code" },
};

function parseStrict<T>(schema: z.ZodType<T>, raw: unknown, reason: string): T {
  const r = schema.safeParse(raw);
  if (!r.success) throw new ValidationError(reason);
  return r.data;
}

export function sessionConfig(input: Pick<SessionConfig, "tenantId" | "environment" | "policyVersion"> & Partial<SessionConfig>): SessionConfig {
  return parseStrict(SessionConfigSchema, { ...DEFAULT_SESSION_CONFIG, ...input }, "SESSION_CONFIG_INVALID");
}

export function verificationConfig(overrides: Partial<VerificationConfig> = {}): VerificationConfig {
  return parseStrict(VerificationConfigSchema, { ...DEFAULT_VERIFICATION_CONFIG, ...overrides }, "VERIFICATION_CONFIG_INVALID");
}

/**
 * Maps the relevant subset of PlatformConfig (platform/src/config) onto identity
 * configuration. Structural typing keeps this module independent of the config
 * module's internals.
 */
export function identityConfigFromPlatform(
  p: {
    tenantId: string;
    environment: z.infer<typeof Environment>;
    sessionBinding: { sessionTtlSeconds: number };
    verification: {
      otpExpirySeconds: number;
      otpMaxAttemptsPerChallenge: number;
      otpMaxPerAccountPerHour: number;
      secureLinkExpirySeconds: number;
      maxAuthAgeSeconds: number;
    };
  },
  extras: { policyVersion: string; otpEnabled: boolean } & { session?: Partial<SessionConfig>; verification?: Partial<VerificationConfig> },
): { session: SessionConfig; verification: VerificationConfig } {
  return {
    session: sessionConfig({
      tenantId: p.tenantId,
      environment: p.environment,
      policyVersion: extras.policyVersion,
      sessionTtlSeconds: p.sessionBinding.sessionTtlSeconds,
      ...extras.session,
    }),
    verification: verificationConfig({
      otpExpirySeconds: p.verification.otpExpirySeconds,
      otpMaxAttemptsPerChallenge: p.verification.otpMaxAttemptsPerChallenge,
      otpMaxPerAccountPerHour: p.verification.otpMaxPerAccountPerHour,
      secureLinkExpirySeconds: p.verification.secureLinkExpirySeconds,
      maxAuthAgeSeconds: p.verification.maxAuthAgeSeconds,
      otpEnabled: extras.otpEnabled,
      ...extras.verification,
    }),
  };
}

export type { Channel as IntegrationChannel };
