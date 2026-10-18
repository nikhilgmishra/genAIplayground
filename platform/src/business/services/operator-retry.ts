/**
 * Operator-retry authority (ACT-F3; spec section 8 "Commit rechecks authorization, action freshness,
 * current state and confirmation"; section 7 "Expire privileges at call end, participant changes,
 * account switching, recovery, revocation, or risk escalation"; section 10: a safety concern revokes
 * pending nonessential mutations).
 *
 * A staff member's retry after a NOT_FOUND reconciliation (console reconciliation.retry ->
 * LedgerReconciledRetry -> LedgerActionService.retryAfterReconcile) executes a change the CALLER
 * confirmed. The staff member's own authority (workforce SSO, console RBAC) does not replace the
 * caller's: before the provider is called, the caller's CURRENT authority is re-established here,
 * from server-side state only, exactly as the caller-path commit re-authorizes (business/policy.ts):
 *   1. the session the action is bound to (by its non-bearer binding: the ledger never holds the
 *      bearer) is read from the trusted session store; missing, revoked, ended or expired fails;
 *   2. it must still be at the action's session generation (any role/participant/account change,
 *      recovery or call end bumps it), name the same tenant, actor and subject, and carry no
 *      SAFETY_ESCALATION_ACTIVE flag;
 *   3. the action-kind specific resource check (e.g. the appointment's authoritative subject);
 *   4. CURRENT relationship facts, kill-switch snapshot and policy bundle evaluate the commit action
 *      for the action's subject, bound to the action digest.
 * Any failure throws AccessDeniedError / SessionInvalidError with a reason code; the ledger then
 * refuses (and, for a session that is gone or a safety escalation, invalidates the action). The ledger
 * independently requires the caller's confirmation to be fresh and no durable invalidation request.
 * Content-free: opaque ids and codes only.
 */
import type { SessionRecord } from "../../identity/session-store.js";
import { lifecycleProblem } from "../../identity/session-store.js";
import { bindingRefFromHash } from "../../actions/digest.js";
import type { ProviderCommitPort } from "../../actions/ports.js";
import { PolicyInput, RelationshipFact } from "../../protocol/index.js";
import type { PolicyDecision, PolicyPurpose, PreparedAction, ToolDefinition } from "../../protocol/index.js";
import { AccessDeniedError, SessionInvalidError } from "../../shared/errors.js";
import { toolPolicyRef } from "../../policy/input.js";
import type { ToolDeps } from "../contract.js";
import type { PolicyResource } from "../shared.js";

/** What the operator retry re-evaluates for one action kind (the same action the caller-path commit evaluates). */
export interface OperatorRetrySpec {
  action: string;
  purpose: PolicyPurpose;
  tool: Pick<ToolDefinition, "name" | "version" | "minAssurance" | "consequential">;
  resource: (action: PreparedAction) => PolicyResource;
  /** Optional authoritative check of the target (throws AccessDeniedError on mismatch). */
  check?: (action: PreparedAction) => Promise<void>;
}

/** Read-only access to the trusted session record by its hash (identity's TrustedSessionService.store). */
interface SessionRecordReader {
  load(hash: string): Promise<{ rec: SessionRecord } | null>;
}

function sessionReader(sessions: unknown): SessionRecordReader | null {
  const store = typeof sessions === "object" && sessions !== null ? (sessions as { store?: unknown }).store : undefined;
  return typeof store === "object" && store !== null && typeof (store as { load?: unknown }).load === "function" ? (store as SessionRecordReader) : null;
}

/** The session hash behind a non-bearer binding ref (ses_bnd_<base64url sha256>), or null. */
function hashOfBinding(ref: string): string | null {
  if (!/^ses_bnd_[A-Za-z0-9_-]{43}$/.test(ref)) return null;
  const hash = Buffer.from(ref.slice("ses_bnd_".length), "base64url").toString("hex");
  return /^[a-f0-9]{64}$/.test(hash) && bindingRefFromHash(hash) === ref ? hash : null;
}

/**
 * Policy auth block of a trusted session record. Mirrors policy/input.ts policyAuthFromContext over
 * the AuthContext identity/session-store.ts toAuthContext would build (an expired step-up is dropped);
 * operator-retry.test.ts pins the equivalence.
 */
export function policyAuthFromSessionRecord(rec: SessionRecord, now: Date): PolicyInput["auth"] {
  const stepUp = rec.stepUp && now.getTime() < Date.parse(rec.stepUp.expiresAt) ? rec.stepUp : null;
  return {
    tenantId: rec.tenantId,
    sessionGeneration: rec.generation,
    actorId: rec.actorId,
    selectedRole: rec.selectedRole,
    subjectId: rec.subjectId,
    organizationId: rec.organizationId,
    permittedScopes: [...rec.permittedScopes],
    assurance: rec.assurance,
    authenticatedAt: rec.authenticatedAt,
    expiresAt: rec.expiresAt,
    revoked: rec.revoked,
    riskFlags: [...rec.riskFlags],
    consentRecording: rec.consent.recording,
    consentAutomatedProcessing: rec.consent.automatedProcessing,
    stepUpDigest: stepUp?.actionDigest ?? null,
    stepUpExpiresAt: stepUp?.expiresAt ?? null,
  };
}

/** Re-establishes the caller's CURRENT authority for an operator retry of `action` (see module comment). */
export async function authorizeOperatorRetry(deps: ToolDeps, spec: OperatorRetrySpec, action: PreparedAction): Promise<PolicyDecision> {
  const reader = sessionReader(deps.sessions);
  if (!reader) throw new AccessDeniedError("REAUTHORIZATION_UNAVAILABLE");
  const hash = hashOfBinding(action.sessionRef);
  if (!hash) throw new SessionInvalidError("SESSION_NOT_FOUND");
  const loaded = await reader.load(hash);
  if (!loaded) throw new SessionInvalidError("SESSION_NOT_FOUND");
  const rec = loaded.rec;
  const now = deps.clock.now();
  const problem = lifecycleProblem(rec, now);
  if (problem) throw new SessionInvalidError(problem);
  if (rec.tenantId !== action.tenantId) throw new AccessDeniedError("SESSION_TENANT_MISMATCH");
  if (rec.generation !== action.sessionGeneration) throw new SessionInvalidError("SESSION_GENERATION_CHANGED");
  if (rec.actorId !== action.actorId || rec.subjectId !== action.subjectId) throw new AccessDeniedError("SESSION_IDENTITY_CHANGED");
  if (rec.riskFlags.includes("SAFETY_ESCALATION_ACTIVE")) throw new AccessDeniedError("SAFETY_ESCALATION_ACTIVE");
  if (spec.check) await spec.check(action);

  const relationships = rec.actorId && rec.selectedRole ? await deps.adapters.relationships.relationshipsFor(rec.actorId, rec.selectedRole) : [];
  const ks = await deps.killSwitches.snapshot(rec.tenantId);
  const parsed = PolicyInput.safeParse({
    action: spec.action,
    purpose: spec.purpose,
    environment: deps.environment,
    now: now.toISOString(),
    tool: toolPolicyRef(spec.tool),
    auth: policyAuthFromSessionRecord(rec, now),
    resource: { ...spec.resource(action), actionDigest: action.digest },
    relationships: relationships.map((f) => RelationshipFact.parse(f)),
    killSwitches: { aiAdmission: ks.aiAdmission, writes: ks.writes, intents: [...ks.intents].sort(), integrations: [...ks.integrations].sort() },
  });
  if (!parsed.success) throw new AccessDeniedError("POLICY_INPUT_INVALID");
  return deps.policy.decide(parsed.data);
}

/** The provider port with the operator-retry authority attached (ProviderCommitPort.authorizeOperatorRetry). */
export function withOperatorRetryAuthority<P extends ProviderCommitPort>(port: P, authority: (action: PreparedAction) => Promise<PolicyDecision>): P & Required<Pick<ProviderCommitPort, "authorizeOperatorRetry">> {
  return Object.assign(port, { authorizeOperatorRetry: authority });
}
