/**
 * LOCAL TEST FIXTURE — wires the identity module over LOCAL fixtures and the
 * SYNTHETIC world for tests and the local demo: FakeClock, in-memory KV store,
 * synthetic identity directory, local OIDC provider/verifier, capturing
 * notification sender, memory logger and in-memory metrics. Nothing here is a
 * production configuration (OPS-04).
 */
import { CALLS, IDP, PEOPLE, TENANT_ID } from "../fixtures/synthetic-world.js";
import type { ConsentState, IntegrationIdentity } from "../protocol/index.js";
import { FakeClock } from "../shared/clock.js";
import { createMemoryLogger } from "../observability/logger.js";
import { InMemoryMetrics } from "../observability/metrics.js";
import { LocalIdentityDirectoryFixture } from "../adapters/local/identity-directory.js";
import type { DirectoryPersonFixture } from "../adapters/local/identity-directory.js";
import { NotificationFixture } from "../adapters/local/notification-fixture.js";
import { LocalOidcProviderFixture, LocalOidcVerifierFixture } from "../adapters/local/oidc-fixture.js";
import { sessionConfig, verificationConfig } from "./config.js";
import type { SessionConfig, VerificationConfig } from "./config.js";
import { MemoryKvStoreFixture } from "./kv/memory-kv-store.js";
import { TrustedSessionService } from "./session-service.js";
import { SecureVerificationService } from "./verification-service.js";

/** LOCAL FIXTURE pepper: a labelled, non-secret test value. Live peppers come from Secrets Manager (BLOCKED). */
export const LOCAL_FIXTURE_OTP_PEPPER = Buffer.from("LOCAL-FIXTURE-OTP-PEPPER--NOT-A-SECRET--0123456789", "utf8");

export const LOCAL_POLICY_VERSION = "policy-local-2026.10.17";

export function integration(channel: IntegrationIdentity["channel"], overrides: Partial<IntegrationIdentity> = {}): IntegrationIdentity {
  return {
    integrationId: "talkdesk-local",
    tenantId: TENANT_ID,
    environment: "local",
    channel,
    credentialId: `cred-local-${channel}`,
    authMethod: "local_fixture",
    ...overrides,
  };
}

export const telephony = (o: Partial<IntegrationIdentity> = {}) => integration("telephony_control", o);
export const mcp = (o: Partial<IntegrationIdentity> = {}) => integration("mcp_tools", o);
export const portal = (o: Partial<IntegrationIdentity> = {}) => integration("portal", o);

export const CONSENT_UNKNOWN: ConsentState = {
  recording: "UNKNOWN",
  automatedProcessing: "UNKNOWN",
  disclosureTemplateVersion: null,
  capturedAt: null,
  capturedBy: "none",
};

export function consentGranted(capturedAt: string): ConsentState {
  return { recording: "GRANTED", automatedProcessing: "GRANTED", disclosureTemplateVersion: "disclosure-local-v1", capturedAt, capturedBy: "studio_flow" };
}

export interface HarnessOptions {
  session?: Partial<SessionConfig>;
  verification?: Partial<VerificationConfig>;
  extraPeople?: DirectoryPersonFixture[];
}

export type IdentityHarness = Awaited<ReturnType<typeof createIdentityHarness>>;

export async function createIdentityHarness(opts: HarnessOptions = {}) {
  const clock = new FakeClock();
  const kv = new MemoryKvStoreFixture();
  const { logger, records } = createMemoryLogger();
  const metrics = new InMemoryMetrics();
  const directory = new LocalIdentityDirectoryFixture({ extraPeople: opts.extraPeople ?? [] });
  const notifications = new NotificationFixture({ clock, registeredChannelRefs: directory.allVerifiedChannelRefs() });
  const idp = await LocalOidcProviderFixture.create({ clock });
  const oidc = new LocalOidcVerifierFixture(idp, { clock });
  const sessions = new TrustedSessionService({
    kv,
    clock,
    logger,
    metrics,
    config: sessionConfig({ tenantId: TENANT_ID, environment: "local", policyVersion: LOCAL_POLICY_VERSION, ...opts.session }),
  });
  const verification = new SecureVerificationService({
    sessions,
    kv,
    directory,
    oidc,
    notifications,
    clock,
    logger,
    metrics,
    otpPepper: LOCAL_FIXTURE_OTP_PEPPER,
    config: verificationConfig({ otpEnabled: true, ...opts.verification }),
  });

  async function startCall(callId: string = CALLS.primary.callId, callerIdHash: string | null = null) {
    const started = await sessions.startCall({ integration: telephony(), callId, callerIdHash, consent: consentGranted(clock.now().toISOString()) });
    return { ...started, ctx: await sessions.resolve(started.sessionRef, mcp()) };
  }

  /** Reads the secure link a SYNTHETIC person received and splits it into transaction id and nonce. */
  function linkFor(channelRef: string): { transactionId: string; nonce: string } | null {
    const msg = notifications.lastTo(channelRef);
    const path = msg?.slots.linkPath;
    const m = path ? /\/(vtx_[A-Za-z0-9_-]+)#n=([A-Za-z0-9_-]{43})$/.exec(path) : null;
    return m && m[1] && m[2] ? { transactionId: m[1], nonce: m[2] } : null;
  }

  function otpFor(channelRef: string): string | null {
    const msg = notifications.lastTo(channelRef);
    return msg?.templateId === "verify.otp_code" ? (msg.slots.code ?? null) : null;
  }

  /** Full preferred journey for a SYNTHETIC person: begin, receive link, OIDC sign-in with MFA, confirm match code. */
  async function verifyWithSecureLink(
    person: (typeof PEOPLE)[keyof typeof PEOPLE],
    sessionRef: string,
    role = person.role,
    channelRef = person.channels[0]?.channelRef ?? "",
  ) {
    const ctx = await sessions.resolve(sessionRef, mcp());
    const locator = person.dateOfBirth ? { fullName: person.fullName, dateOfBirth: person.dateOfBirth } : { portalUsernameHint: `${person.displayName.replace(/^Dr\. /, "").toLowerCase()}.synthetic` };
    const begun = await verification.beginSecureLink(ctx, { role, locator });
    const link = linkFor(channelRef);
    if (!link) throw new Error("FIXTURE_NO_LINK_DELIVERED");
    const idToken = await idp.issueFor(person, { nonce: link.nonce, amr: ["pwd", "mfa"] });
    const result = await verification.completeSecureLink({ ...link, idToken, matchCodeConfirmed: true });
    return { begun, link, result };
  }

  return { clock, kv, logger, records, metrics, directory, notifications, idp, oidc, sessions, verification, startCall, linkFor, otpFor, verifyWithSecureLink, IDP };
}
