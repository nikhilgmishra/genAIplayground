/**
 * LOCAL FIXTURE — SYNTHETIC policy inputs for tests (identities from
 * platform/src/fixtures/synthetic-world.ts; not real people, not PHI).
 */
import { ORGANIZATIONS, OTHER_TENANT_ID, PEOPLE, STAFF, TENANT_ID } from "../../fixtures/synthetic-world.js";
import type { AuthContext, RelationshipFact } from "../../protocol/auth.js";
import type { PolicyInput } from "../../protocol/policy.js";
import type { ConsoleDecisionInput } from "../console.js";
import { OpaWasmPolicyEngine } from "../engine.js";
import { ensurePolicyBundle } from "../ensure-bundle.js";

export const NOW = "2026-10-17T15:00:00.000Z";
export const LATER = "2026-10-17T15:30:00.000Z";
export const EARLIER = "2026-10-17T14:59:59.000Z";
export const DIGEST_A = "a".repeat(64);
export const DIGEST_B = "b".repeat(64);
export { OTHER_TENANT_ID, TENANT_ID };
export const P = PEOPLE;
export const NORTH = ORGANIZATIONS.practiceNorth.organizationId;
export const SOUTH = ORGANIZATIONS.practiceSouth.organizationId;
export const ACME = ORGANIZATIONS.partnerAcme.organizationId;

let enginePromise: Promise<OpaWasmPolicyEngine> | null = null;

/** Builds policy/build if stale (pinned OPA) and loads the real WASM engine once per test file. */
export function loadTestEngine(): Promise<OpaWasmPolicyEngine> {
  enginePromise ??= OpaWasmPolicyEngine.load({ bundleDir: ensurePolicyBundle().bundleDir });
  return enginePromise;
}

type Auth = PolicyInput["auth"];
type Resource = PolicyInput["resource"];

export function auth(actorId: string | null, role: Auth["selectedRole"], subjectId: string | null, organizationId: string | null, assurance: Auth["assurance"] = "A2"): Auth {
  return {
    tenantId: TENANT_ID,
    sessionGeneration: 1,
    actorId,
    selectedRole: role,
    subjectId,
    organizationId,
    permittedScopes: [],
    assurance,
    authenticatedAt: actorId === null ? null : "2026-10-17T14:55:00.000Z",
    expiresAt: LATER,
    revoked: false,
    riskFlags: [],
    consentRecording: "GRANTED",
    consentAutomatedProcessing: "GRANTED",
    stepUpDigest: null,
    stepUpExpiresAt: null,
  };
}

export const anonAuth = (): Auth => auth(null, null, null, null, "A0");

export function resource(type: string, subjectId: string | null, organizationId: string | null, classification: Resource["classification"], actionDigest: string | null = null): Resource {
  return { type, tenantId: TENANT_ID, subjectId, organizationId, classification, actionDigest };
}

export function fact(type: RelationshipFact["type"], actorId: string, subjectId: string | null, organizationId: string | null, scopes: string[], source: RelationshipFact["source"], extra: Partial<RelationshipFact> = {}): RelationshipFact {
  return { type, actorId, subjectId, organizationId, scopes, source, validUntil: null, constraints: [], ...extra };
}

export const selfFact = (p: { actorId: string; subjectId: string | null }) => fact("self", p.actorId, p.subjectId, null, [], "identity_provider");
export const treatingFact = fact("treating_provider", P.morgan.actorId, P.avery.subjectId, null, ["appointment:read"], "enrollment_system");
export const rileyDelegate = fact("practice_delegate", P.riley.actorId, null, NORTH, ["remittance:read", "onboarding:read", "case:read"], "delegation_registry");
export const quinnAffiliation = fact("partner_affiliate", P.quinn.actorId, null, ACME, ["partner_intake:create", "case:read"], "partner_contract_registry");
export const emeryRenewed = fact("legal_representative", P.emery.actorId, P.blake.subjectId, null, ["appointment:read", "invoice:read"], "legal_authority_registry");
export const emeryExpired = fact("legal_representative", P.emery.actorId, P.blake.subjectId, null, ["appointment:read", "invoice:read"], "legal_authority_registry", { validUntil: "2026-06-30T23:59:59.000Z" });
export const danaParental = fact("parental_authority", P.dana.actorId, P.casey.subjectId, null, ["appointment:read", "invoice:read"], "legal_authority_registry", { constraints: ["MINOR_CONFIDENTIALITY_REVIEW"] });

export function req(action: string, purpose: PolicyInput["purpose"], a: Auth, r: Resource, relationships: RelationshipFact[], tool: PolicyInput["tool"] = null): PolicyInput {
  return { action, purpose, environment: "local", now: NOW, tool, auth: a, resource: r, relationships, killSwitches: { aiAdmission: false, writes: false, intents: [], integrations: [] } };
}

export const averyAppointment = (): PolicyInput =>
  req("appointment:read", "caller_self_service", auth(P.avery.actorId, "client", P.avery.subjectId, null), resource("appointment", P.avery.subjectId, null, "PHI"), [selfFact(P.avery)]);

export const averyCommit = (): PolicyInput =>
  req("appointment:commit_change", "caller_self_service", auth(P.avery.actorId, "client", P.avery.subjectId, null), resource("appointment", P.avery.subjectId, null, "PHI", DIGEST_A), [selfFact(P.avery)]);

export const morganAppointment = (subjectId: string = P.avery.subjectId): PolicyInput =>
  req("appointment:read", "caller_self_service", auth(P.morgan.actorId, "provider", P.morgan.subjectId, NORTH), resource("appointment", subjectId, null, "PHI"), [selfFact(P.morgan), treatingFact]);

export const anonymous = (action: string, purpose: PolicyInput["purpose"], type = "call_session", classification: Resource["classification"] = "INTERNAL"): PolicyInput =>
  req(action, purpose, anonAuth(), resource(type, null, null, classification), []);

export const withAuth = (x: PolicyInput, patch: Partial<Auth>): PolicyInput => ({ ...x, auth: { ...x.auth, ...patch } });
export const withResource = (x: PolicyInput, patch: Partial<Resource>): PolicyInput => ({ ...x, resource: { ...x.resource, ...patch } });
export const withKs = (x: PolicyInput, patch: Partial<PolicyInput["killSwitches"]>): PolicyInput => ({ ...x, killSwitches: { ...x.killSwitches, ...patch } });

/** SYNTHETIC trusted AuthContext as the identity module would resolve it. */
export function averyAuthContext(patch: Partial<AuthContext> = {}): AuthContext {
  return {
    tenantId: TENANT_ID,
    callId: "cal_synthCallPrimary0001",
    sessionRef: "ses_synthSessionRefAvery000000000001",
    sessionGeneration: 2,
    actorId: P.avery.actorId,
    selectedRole: "client",
    subjectId: P.avery.subjectId,
    organizationId: null,
    delegatedAuthority: [],
    permittedScopes: ["appointment:read"],
    assurance: "A2",
    authenticatedAt: "2026-10-17T14:55:00.000Z",
    expiresAt: LATER,
    verificationMethod: "secure_link_oidc",
    consent: { recording: "GRANTED", automatedProcessing: "GRANTED", disclosureTemplateVersion: "disclosure-local-v1", capturedAt: "2026-10-17T14:54:00.000Z", capturedBy: "studio_flow" },
    riskFlags: [],
    policyVersion: "2026.10.17-1",
    revoked: false,
    stepUp: null,
    integration: {
      integrationId: "talkdesk-mcp-local",
      tenantId: TENANT_ID,
      environment: "local",
      channel: "mcp_tools",
      credentialId: "cred_local_fixture",
      authMethod: "local_fixture",
    },
    ...patch,
  };
}

export function consoleInput(action: string, role: keyof typeof STAFF_ROLE_IDS, patch: Partial<ConsoleDecisionInput["resource"]> = {}): ConsoleDecisionInput {
  return {
    action,
    origin: "workforce_console",
    environment: "local",
    now: NOW,
    staff: { staffId: STAFF_ROLE_IDS[role], tenantId: TENANT_ID, roles: [role], mfa: true, authenticatedAt: "2026-10-17T14:00:00.000Z", breakGlass: null },
    resource: { type: "console_resource", tenantId: TENANT_ID, killSwitchScope: null, initiatorStaffId: null, assignedStaffId: null, ...patch },
  };
}

export const STAFF_ROLE_IDS = {
  support_agent: STAFF.agent.staffId,
  supervisor: STAFF.supervisor.staffId,
  safety_responder: STAFF.safety.staffId,
  auditor: STAFF.auditor.staffId,
  knowledge_editor: STAFF.knowledgeEditor.staffId,
  policy_approver: STAFF.policyApprover.staffId,
  deployment_operator: STAFF.deployOperator.staffId,
  security_admin: STAFF.securityAdmin.staffId,
} as const;

export const VALID_BREAK_GLASS = {
  grantId: "bgl_synthBreakGlass0001",
  approvedBy: STAFF.securityAdmin.staffId,
  justificationCode: "ACTIVE_SAFETY_INCIDENT" as const,
  grantedAt: "2026-10-17T14:30:00.000Z",
  expiresAt: "2026-10-17T16:30:00.000Z",
};
