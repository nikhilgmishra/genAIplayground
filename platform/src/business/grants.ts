/**
 * Durable action grants for workflows the business layer starts (spec section 7:
 * "Asynchronous workflows use a narrowly authorized durable action grant; they do not
 * reuse an expired call token as unlimited authority").
 *
 * The grant is issued INSIDE the transaction that accepts the durable work (the same
 * transaction that starts the workflow), so either both exist or neither does. It names:
 *  - subject: the account subject the work is for when one is server-established; for
 *    organization-scoped partner work, the partner's server-established organization; for
 *    work with no account subject (an unverified caller's complaint), the support request
 *    itself, so the grant authorizes action on exactly that record and nothing else;
 *  - actor: the caller's server-established actor id when known;
 *  - actions: exactly the dotted action names the workflow definition declares for its
 *    guarded transitions (VersionedWorkflowDefinition.grantActions), never more;
 *  - expiry: the sum of the definition's nonterminal state deadlines (ENGINEERING DEFAULT,
 *    bounded to [1 h, 30 d] pending security approval). An expired grant fails closed: the
 *    guarded transition takes the recheck-denied path and a human decides;
 *  - source: the opaque record that justified it (action id or support request id).
 * Without a grant store (tests, stub compositions) grantRef is null, and the engine refuses
 * every guarded transition (DURABLE_GRANT_MISSING): fail closed.
 */
import type { Queryable } from "../db/types.js";
import type { WorkflowType } from "../protocol/index.js";
import { addMs } from "../shared/clock.js";
import { durationSeconds } from "../workflows/duration.js";
import { createDefaultRegistry } from "../workflows/registry.js";
import type { WorkflowEngine } from "../workflows/ports.js";
import type { ToolDeps } from "./contract.js";

/**
 * WorkflowEngine.start input plus the policy version snapshotted at acceptance (accepted by
 * PgWorkflowEngine, workflows/engine.ts WorkflowStartInput). The engine compares it with the
 * version the pre-disclosure recheck reports and records a newer policy (spec section 9).
 */
export type WorkflowStartWithSnapshot = Parameters<WorkflowEngine["start"]>[0] & { policySnapshotVersion: string };

const MIN_GRANT_MS = 3_600_000;
const MAX_GRANT_MS = 30 * 86_400_000;
const SHIPPED = createDefaultRegistry();

/** Distinct grant actions the latest shipped definition of `type` declares (sorted). */
export function grantActionsFor(type: WorkflowType): string[] {
  const def = SHIPPED.latest(type);
  if (!def) return [];
  const out = new Set<string>();
  for (const byEvent of Object.values(def.grantActions)) for (const a of Object.values(byEvent ?? {})) if (typeof a === "string") out.add(a);
  return [...out].sort();
}

/** Grant lifetime from the definition's nonterminal deadlines (ENGINEERING DEFAULT, bounded). */
export function grantTtlMsFor(type: WorkflowType): number {
  const def = SHIPPED.latest(type);
  let total = 0;
  for (const s of Object.values(def?.states ?? {})) if (s && !s.terminal && s.deadline) total += durationSeconds(s.deadline) * 1000;
  return Math.min(MAX_GRANT_MS, Math.max(MIN_GRANT_MS, total));
}

/**
 * Issues the workflow's durable grant in `tx` (already scoped to the tenant). Returns null
 * when no grant store is wired or the definition declares no guarded action.
 */
export async function issueWorkflowGrant(
  deps: Pick<ToolDeps, "grants" | "clock" | "logger">,
  tx: Queryable,
  input: { tenantId: string; type: WorkflowType; subjectId: string; actorId: string | null; sourceRef: string },
): Promise<string | null> {
  const actions = grantActionsFor(input.type);
  if (actions.length === 0) return null;
  if (!deps.grants) {
    deps.logger.warn("business.grant.store_unconfigured", { reasonCode: "GRANT_STORE_UNCONFIGURED" });
    return null;
  }
  const expiresAt = addMs(deps.clock.now(), grantTtlMsFor(input.type));
  const { grantRef } = await deps.grants.issue({ tenantId: input.tenantId, subjectId: input.subjectId, actorId: input.actorId, actions, expiresAt, sourceRef: input.sourceRef }, tx);
  return grantRef;
}
