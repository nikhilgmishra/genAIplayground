/**
 * Builds the policy input from SERVER-ESTABLISHED state only (AUTH-03).
 *
 * Every identity field comes from the trusted AuthContext the gateway resolved
 * from server-side session state; relationships come from the authoritative
 * relationship directory; the resource comes from an authoritative lookup;
 * kill switches from the ops snapshot. Nothing here accepts a tool argument,
 * a caller statement or a model-proposed field: every object is strictly
 * re-parsed, so an extra property such as "callerClaimedRole" is rejected
 * (ValidationError with a reason code) instead of being forwarded.
 */
import type { z } from "zod";
import { AuthContext, RelationshipFact } from "../protocol/auth.js";
import { Environment, OpaqueId } from "../protocol/common.js";
import { PolicyInput, PolicyPurpose } from "../protocol/policy.js";
import type { ToolDefinition } from "../protocol/tools.js";
import { ValidationError } from "../shared/errors.js";

export type PolicyResource = PolicyInput["resource"];
export type PolicyToolRef = NonNullable<PolicyInput["tool"]>;

/** Structural subset of the ops KillSwitchSnapshot that policy evaluates. */
export interface PolicyKillSwitches {
  aiAdmission: boolean;
  writes: boolean;
  intents: readonly string[];
  integrations: readonly string[];
}

export interface BuildPolicyInputArgs {
  /** Trusted session context, or null when no session could be resolved (safety/human routes still allowed). */
  auth: AuthContext | null;
  /** Tenant of the authenticated integration; required when `auth` is null. */
  tenantId?: string | null;
  action: string;
  purpose: z.infer<typeof PolicyPurpose>;
  /** Pinned catalogue entry of the invoking tool, or null for non-tool evaluations (e.g. durable follow-up). */
  tool: Pick<ToolDefinition, "name" | "version" | "minAssurance" | "consequential"> | null;
  resource: PolicyResource;
  relationships: readonly RelationshipFact[];
  killSwitches: PolicyKillSwitches;
  environment: z.infer<typeof Environment>;
  now: Date;
}

/** Narrows a pinned ToolDefinition to the fields policy needs. */
export function toolPolicyRef(def: Pick<ToolDefinition, "name" | "version" | "minAssurance" | "consequential">): PolicyToolRef {
  return { name: def.name, version: def.version, minAssurance: def.minAssurance, consequential: def.consequential };
}

/** Policy view of a caller with no resolvable session: unauthenticated, already expired. */
export function unauthenticatedPolicyAuth(tenantId: string, now: Date): PolicyInput["auth"] {
  return {
    tenantId,
    sessionGeneration: 1,
    actorId: null,
    selectedRole: null,
    subjectId: null,
    organizationId: null,
    permittedScopes: [],
    assurance: "A0",
    authenticatedAt: null,
    expiresAt: now.toISOString(),
    revoked: true,
    riskFlags: [],
    consentRecording: "UNKNOWN",
    consentAutomatedProcessing: "UNKNOWN",
    stepUpDigest: null,
    stepUpExpiresAt: null,
  };
}

/** Maps the trusted AuthContext onto the policy's auth block. */
export function policyAuthFromContext(ctx: AuthContext): PolicyInput["auth"] {
  return {
    tenantId: ctx.tenantId,
    sessionGeneration: ctx.sessionGeneration,
    actorId: ctx.actorId,
    selectedRole: ctx.selectedRole,
    subjectId: ctx.subjectId,
    organizationId: ctx.organizationId,
    permittedScopes: [...ctx.permittedScopes],
    assurance: ctx.assurance,
    authenticatedAt: ctx.authenticatedAt,
    expiresAt: ctx.expiresAt,
    revoked: ctx.revoked,
    riskFlags: [...ctx.riskFlags],
    consentRecording: ctx.consent.recording,
    consentAutomatedProcessing: ctx.consent.automatedProcessing,
    stepUpDigest: ctx.stepUp?.actionDigest ?? null,
    stepUpExpiresAt: ctx.stepUp?.expiresAt ?? null,
  };
}

/**
 * Builds and strictly validates a PolicyInput. Throws ValidationError
 * (reason code only, no values) when any trusted input is malformed; the
 * caller must treat that as a denial.
 */
export function buildPolicyInput(args: BuildPolicyInputArgs): PolicyInput {
  let auth: PolicyInput["auth"];
  if (args.auth === null) {
    const tenant = OpaqueId.safeParse(args.tenantId);
    if (!tenant.success) throw new ValidationError("POLICY_INPUT_TENANT_REQUIRED");
    auth = unauthenticatedPolicyAuth(tenant.data, args.now);
  } else {
    const ctx = AuthContext.safeParse(args.auth);
    if (!ctx.success) throw new ValidationError("POLICY_INPUT_AUTH_INVALID");
    auth = policyAuthFromContext(ctx.data);
  }
  const relationships: RelationshipFact[] = [];
  for (const f of args.relationships) {
    const parsed = RelationshipFact.safeParse(f);
    if (!parsed.success) throw new ValidationError("POLICY_INPUT_RELATIONSHIP_INVALID");
    relationships.push(parsed.data);
  }
  const candidate = {
    action: args.action,
    purpose: args.purpose,
    environment: args.environment,
    now: args.now.toISOString(),
    tool: args.tool === null ? null : toolPolicyRef(args.tool),
    auth,
    resource: { ...args.resource },
    relationships,
    killSwitches: {
      aiAdmission: args.killSwitches.aiAdmission,
      writes: args.killSwitches.writes,
      intents: [...args.killSwitches.intents].sort(),
      integrations: [...args.killSwitches.integrations].sort(),
    },
  };
  const parsed = PolicyInput.safeParse(candidate);
  if (!parsed.success) throw new ValidationError("POLICY_INPUT_INVALID");
  return parsed.data;
}
