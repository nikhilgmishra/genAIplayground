/**
 * LOCAL TEST FIXTURE — SYNTHETIC builders for action-ledger tests, derived from
 * platform/src/fixtures/synthetic-world.ts. Not real people, not PHI.
 */
import { createTestDb } from "../../db/testing.js";
import type { PgliteDb } from "../../db/pglite.js";
import { APPOINTMENTS, CALLS, PEOPLE, SLOTS, TENANT_ID } from "../../fixtures/synthetic-world.js";
import type { ActionConfirmation, AuthContext, IntegrationIdentity, PolicyDecision, PreparedAction } from "../../protocol/index.js";
import type { Clock } from "../../shared/clock.js";
import { FakeClock, addMs, iso } from "../../shared/clock.js";
import { newId, newSessionRef, newTurnId } from "../../shared/ids.js";
import { PgOutbox } from "../../outbox/outbox.js";
import { LedgerActionService } from "../action-service.js";
import type { ActionLedgerConfig, LedgerActionServiceOptions } from "../action-service.js";
import type { Db } from "../../db/types.js";
import type { PrepareInput } from "../ports.js";
import { AuditHealthFixture, InTxAuditWriterFixture, installAuditFixtureTable } from "./audit-writer.fixture.js";
import { FakeProviderFixture } from "./fake-provider.fixture.js";

export const POLICY_VERSION = "policy-2026-10-17.1";
export const APPOINTMENT = APPOINTMENTS[0];
export const SLOT = SLOTS[0];

export function mcpIntegration(tenantId: string = TENANT_ID): IntegrationIdentity {
  return { integrationId: "talkdesk-mcp-local", tenantId, environment: "local", channel: "mcp_tools", credentialId: "fixture-cred-mcp", authMethod: "local_fixture" };
}

export function telephonyIntegration(tenantId: string = TENANT_ID): IntegrationIdentity {
  return { integrationId: "talkdesk-telephony-local", tenantId, environment: "local", channel: "telephony_control", credentialId: "fixture-cred-tel", authMethod: "local_fixture" };
}

export function portalIntegration(tenantId: string = TENANT_ID): IntegrationIdentity {
  return { integrationId: "portal-local", tenantId, environment: "local", channel: "portal", credentialId: "fixture-cred-portal", authMethod: "local_fixture" };
}

/** SYNTHETIC verified client (Avery) on the primary synthetic call, account-authenticated (A2). */
export function syntheticAuthContext(clock: Clock, overrides: Partial<AuthContext> = {}): AuthContext {
  const now = clock.now();
  return {
    tenantId: TENANT_ID,
    callId: CALLS.primary.callId,
    sessionRef: newSessionRef(),
    sessionGeneration: 1,
    actorId: PEOPLE.avery.actorId,
    selectedRole: "client",
    subjectId: PEOPLE.avery.subjectId,
    organizationId: null,
    delegatedAuthority: [],
    permittedScopes: ["appointment:read", "appointment:write"],
    assurance: "A2",
    authenticatedAt: iso(now),
    expiresAt: iso(addMs(now, 15 * 60_000)),
    verificationMethod: "secure_link_oidc",
    consent: { recording: "GRANTED", automatedProcessing: "GRANTED", disclosureTemplateVersion: "disclosure-v1", capturedAt: iso(now), capturedBy: "studio_flow" },
    riskFlags: [],
    policyVersion: POLICY_VERSION,
    revoked: false,
    stepUp: null,
    integration: mcpIntegration(overrides.tenantId ?? TENANT_ID),
    ...overrides,
  };
}

export function allowDecision(clock: Clock, overrides: Partial<PolicyDecision> = {}): PolicyDecision {
  return {
    decisionId: newId("pdc"),
    allow: true,
    reasonCodes: ["ALLOW_SELF_SERVICE"],
    fieldMask: [],
    obligations: ["REQUIRE_CONFIRMATION"],
    policyVersion: POLICY_VERSION,
    evaluatedAt: iso(clock.now()),
    ...overrides,
  };
}

export function rescheduleInput(overrides: Partial<PrepareInput> = {}): PrepareInput {
  return {
    kind: "appointment.reschedule",
    target: { system: "scheduling", recordType: "appointment", recordRef: APPOINTMENT.appointmentId, beforeVersion: "v1" },
    change: { slotId: SLOT.slotId },
    impact: { summaryTemplateId: "appointment.reschedule.summary", fees: null, reversible: true },
    confirmationTemplateId: "appointment.reschedule.confirm",
    ttlSeconds: 300,
    requiresStepUp: false,
    ...overrides,
  };
}

export function confirmationFor(action: PreparedAction, sessionRef: string, clock: Clock, overrides: Partial<ActionConfirmation> = {}): ActionConfirmation {
  return {
    actionId: action.actionId,
    digest: action.digest,
    sessionRef,
    sessionGeneration: action.sessionGeneration,
    turnId: newTurnId(),
    method: "dtmf_keypress",
    capturedBy: "studio-confirm-skill",
    capturedAt: iso(clock.now()),
    ...overrides,
  };
}

export interface LedgerHarness {
  db: PgliteDb;
  clock: FakeClock;
  audit: InTxAuditWriterFixture;
  health: AuditHealthFixture;
  outbox: PgOutbox;
  provider: FakeProviderFixture;
  service: LedgerActionService;
  makeService(db?: Db, config?: Partial<ActionLedgerConfig>, extra?: Partial<LedgerActionServiceOptions>): LedgerActionService;
}

/** Fresh PGlite with only the 01xx (actions/outbox) migrations plus the audit fixture table. */
export async function createLedgerHarness(config: Partial<ActionLedgerConfig> = {}, providerOpts: { providerDedupByKey?: boolean } = {}): Promise<LedgerHarness> {
  const db = await createTestDb({ include: /^01/ });
  await installAuditFixtureTable(db);
  const clock = new FakeClock();
  const audit = new InTxAuditWriterFixture(db);
  const health = new AuditHealthFixture(audit);
  const outbox = new PgOutbox({ clock });
  const provider = new FakeProviderFixture(providerOpts);
  provider.seedRecord("scheduling", APPOINTMENT.appointmentId, 1);
  const makeService = (d: Db = db, cfg: Partial<ActionLedgerConfig> = config, extra: Partial<LedgerActionServiceOptions> = {}) =>
    new LedgerActionService({ db: d, clock, audit, auditHealth: health, outbox, config: cfg, ...extra });
  return { db, clock, audit, health, outbox, provider, service: makeService(), makeService };
}
