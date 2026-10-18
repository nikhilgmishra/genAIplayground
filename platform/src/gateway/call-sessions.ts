/**
 * Server-side resolution of a call's live session for safety routes that arrive
 * without a session context (finding SAFE-HANDOFF-05: a staff-raised safety
 * concern from the console; also session-less safety tools and screening).
 *
 * The session is found from the trusted call binding that the telephony-control
 * start-call route (TC-01) recorded in the interaction index, never from a caller,
 * model, tool or console value, and is then resolved through the normal session
 * service checks (tenant, environment, integration, channel, expiry, revocation,
 * call id). The HandoffService uses the result ONLY to revoke the session's
 * pending mutations and apply SAFETY_ESCALATION; it is never used to disclose
 * anything or to build the receiver's handoff package.
 *
 * LOCAL FIXTURE: in the local composition the interaction index is the in-memory
 * LocalInteractionLookupFixture. A live deployment needs either the verified
 * Talkdesk interaction lookup (TB-01, PRQ-013/PRQ-034; BLOCKED) or an identity
 * service operation keyed by the session store's call index; until then this
 * resolver is not composed and the console revokes the call's pending actions
 * through the ledger instead (the session flag is then not set).
 */
import type { AuthContext, IntegrationIdentity } from "../protocol/index.js";
import { OpaqueId } from "../protocol/index.js";
import type { InteractionLookup } from "./session-binding.js";

export interface CallSessionResolverOptions {
  lookup: InteractionLookup;
  sessions: { resolve(sessionRef: string, integration: IntegrationIdentity, options?: { expectedCallId?: string }): Promise<AuthContext> };
  /** The Talkdesk telephony integration identity the call's session is bound to (trusted configuration). */
  integration: () => Promise<IntegrationIdentity | null>;
}

export class InteractionIndexCallSessions {
  readonly kind: "local_fixture" | "live";

  constructor(private readonly opts: CallSessionResolverOptions) {
    this.kind = opts.lookup.kind;
  }

  /** The call's live session, or null (unknown call, no binding, expired, revoked, ended or any failure). */
  async resolveForCall(tenantId: string, callId: string): Promise<AuthContext | null> {
    if (!OpaqueId.safeParse(callId).success || !OpaqueId.safeParse(tenantId).success) return null;
    try {
      const integration = await this.opts.integration();
      if (!integration || integration.tenantId !== tenantId) return null;
      const sessionRef = await this.opts.lookup.lookup({ tenantId, integrationId: integration.integrationId, interactionId: callId });
      if (!sessionRef) return null;
      const ctx = await this.opts.sessions.resolve(sessionRef, integration, { expectedCallId: callId });
      return ctx.tenantId === tenantId && ctx.callId === callId ? ctx : null;
    } catch {
      return null;
    }
  }
}
