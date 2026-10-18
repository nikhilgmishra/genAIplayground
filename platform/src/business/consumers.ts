/**
 * Outbox topic consumers run by the worker (spec section 8: "Events are at least once;
 * consumers deduplicate"). Each handler is idempotent:
 *
 *   support_request.sync  -> PgSupportRequestService.handleSyncMessage (consumer dedup +
 *                            idempotent upsert by external id).
 *   action.committed      -> follow-up of a commit completed by reconciliation (the
 *                            ledger's per-call onCommitted hook did not run): billing
 *                            review workflow + support request, created at most once per
 *                            action; commit receipts recorded in the per-call index.
 *
 * The action.committed payload carries no tenant; the tenant is resolved from the
 * business layer's own action index (narrow SECURITY DEFINER lookup, opaque ids only).
 */
import { z } from "zod";
import { PgConsumerDedup } from "../outbox/consumer-dedup.js";
import { OpaqueId } from "../protocol/index.js";
import { ValidationError } from "../shared/errors.js";
import type { BusinessModule, ToolDeps } from "./contract.js";
import type { InteractionIndex } from "./interactions.js";
import type { BillingService } from "./services/billing.js";
import type { PgSupportRequestService } from "./support/support-request-service.js";

export const ACTION_COMMITTED_CONSUMER = "business.action.committed";

const ActionCommittedPayload = z.object({
  actionId: z.string().regex(/^act_[A-Za-z0-9_-]{16,64}$/),
  kind: z.string(),
  receiptId: OpaqueId,
});

export function buildConsumers(deps: ToolDeps, svc: { support: PgSupportRequestService; billing: BillingService; interactions: InteractionIndex }): BusinessModule["consumers"] {
  const dedup = new PgConsumerDedup({ db: deps.db, clock: deps.clock, role: "app_worker" });

  async function actionCommitted(messageId: string, payload: Record<string, unknown>): Promise<void> {
    const p = ActionCommittedPayload.safeParse(payload);
    if (!p.success) throw new ValidationError("ACTION_COMMITTED_PAYLOAD_INVALID");
    const { actionId, receiptId } = p.data;
    const tenantId = await svc.interactions.tenantOf(actionId);
    // Not prepared through the business layer (or not ours): nothing to follow up.
    if (!tenantId) return;
    const action = await deps.actions.get(tenantId, actionId);
    if (!action || action.state !== "COMMITTED") return;
    await dedup.processOnceForTenant(tenantId, ACTION_COMMITTED_CONSUMER, messageId, async (tx) => {
      await svc.interactions.recordReceipt(tenantId, { actionId, receiptId, outcome: "COMMITTED" }, "app_worker", tx);
      if (action.kind === "billing.review.submit") {
        await svc.billing.followUpInTx(tx, action, { receiptId }, { callId: null, consent: null, audience: null });
      }
      return null;
    });
  }

  return {
    "support_request.sync": async (messageId, payload) => {
      await svc.support.handleSyncMessage(messageId, payload);
    },
    "action.committed": actionCommitted,
  };
}
