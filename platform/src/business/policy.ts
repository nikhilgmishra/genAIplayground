/**
 * Commit-time re-authorization (spec section 8: "Commit rechecks authorization").
 * The session is re-resolved from server-side state, relationship facts are
 * re-read from the authoritative directory and the current kill-switch snapshot
 * is applied. Any failure throws; the action ledger treats that as a denial.
 */
import { buildPolicyInput } from "../policy/input.js";
import type { AuthContext, PolicyDecision, PolicyPurpose, ToolDefinition } from "../protocol/index.js";
import type { ToolDeps } from "./contract.js";
import type { PolicyResource } from "./shared.js";

export interface ReauthorizeSpec {
  action: string;
  purpose: PolicyPurpose;
  tool: Pick<ToolDefinition, "name" | "version" | "minAssurance" | "consequential">;
  resource: PolicyResource;
}

export async function decideNow(deps: ToolDeps, auth: AuthContext, spec: ReauthorizeSpec): Promise<PolicyDecision> {
  const current = await deps.sessions.resolve(auth.sessionRef, auth.integration);
  const relationships = current.actorId && current.selectedRole ? await deps.adapters.relationships.relationshipsFor(current.actorId, current.selectedRole) : [];
  const ks = await deps.killSwitches.snapshot(current.tenantId);
  const input = buildPolicyInput({
    auth: current,
    action: spec.action,
    purpose: spec.purpose,
    tool: spec.tool,
    resource: spec.resource,
    relationships,
    killSwitches: { aiAdmission: ks.aiAdmission, writes: ks.writes, intents: ks.intents, integrations: ks.integrations },
    environment: deps.environment,
    now: deps.clock.now(),
  });
  return deps.policy.decide(input);
}
