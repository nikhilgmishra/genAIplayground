/**
 * Interaction outcomes with evidence rules (spec section 4; ACT-04, SAFE-04).
 *
 * - RESOLVED only when the contract's success evidence exists: for a commit contract,
 *   a COMMITTED receipt of the contract's action kind recorded for THIS call (verified
 *   against the per-call action index, not taken on trust from the caller).
 * - Read-only contracts end in INFORMATION_PROVIDED; workflow acceptance, case or
 *   support-request creation end in REQUEST_ACCEPTED, never RESOLVED.
 * - TRANSFERRED only after CALLER_CONFIRMED_CONNECTED (transferConnected).
 * - A hang-up, an HTTP 200 or a created Case alone never set RESOLVED; anything without
 *   evidence is OUTCOME_UNKNOWN.
 */
import { z } from "zod";
import { buildAuditInput } from "../audit/build-input.js";
import type { ActionKind, Outcome } from "../protocol/index.js";
import { OpaqueId } from "../protocol/index.js";
import { iso } from "../shared/clock.js";
import { newId } from "../shared/ids.js";
import { ValidationError } from "../shared/errors.js";
import type { InteractionOutcomeService, ToolDeps } from "./contract.js";
import { contractById } from "./contracts/index.js";
import type { InteractionIndex } from "./interactions.js";

/** Action kinds whose COMMITTED receipt is the success evidence of each RESOLVED contract. */
export const RESOLVING_ACTION_KINDS: Readonly<Record<string, readonly ActionKind[]>> = Object.freeze({
  "appointment_reschedule@1": ["appointment.reschedule"],
  "appointment_create@1": ["appointment.create"],
});

const Input = z.strictObject({
  tenantId: OpaqueId,
  callId: OpaqueId,
  contractId: z.string().regex(/^[a-z_]+@\d+$/).nullable(),
  evidence: z.strictObject({
    commitReceiptIds: z.array(OpaqueId).max(16),
    informationProvided: z.boolean(),
    requestAccepted: z.boolean(),
    transferConnected: z.boolean(),
    callerDisconnected: z.boolean(),
    policyDeclined: z.boolean(),
    failed: z.boolean(),
  }),
});

type Decision = { outcome: Outcome; reasonCode: string };

/** Pure decision given verified committed receipt kinds (exported for property tests). */
export function decideOutcome(
  contractId: string | null,
  evidence: z.infer<typeof Input>["evidence"],
  verifiedCommittedKinds: readonly ActionKind[],
): Decision {
  if (evidence.transferConnected) return { outcome: "TRANSFERRED", reasonCode: "CALLER_CONFIRMED_CONNECTED" };
  const contract = contractId ? contractById(contractId) : null;
  if (contractId && !contract) return { outcome: "OUTCOME_UNKNOWN", reasonCode: "CONTRACT_UNKNOWN" };
  if (contract?.resolvedOutcome === "RESOLVED") {
    const kinds = RESOLVING_ACTION_KINDS[contract.contractId] ?? [];
    if (kinds.length > 0 && verifiedCommittedKinds.some((k) => kinds.includes(k))) return { outcome: "RESOLVED", reasonCode: "COMMITTED_RECEIPT_VERIFIED" };
  }
  // Workflow acceptance, case or support-request creation is never resolution (ACT-04).
  if (evidence.requestAccepted) return { outcome: "REQUEST_ACCEPTED", reasonCode: "REQUEST_ACCEPTED_NOT_RESOLUTION" };
  if (evidence.informationProvided) return { outcome: "INFORMATION_PROVIDED", reasonCode: "INFORMATION_PROVIDED" };
  if (evidence.policyDeclined) return { outcome: "DECLINED_BY_POLICY", reasonCode: "POLICY_DECLINED" };
  if (evidence.callerDisconnected) return { outcome: "CALLER_DISCONNECTED", reasonCode: "CALLER_DISCONNECTED" };
  if (evidence.failed) return { outcome: "FAILED", reasonCode: "FAILED" };
  return { outcome: "OUTCOME_UNKNOWN", reasonCode: evidence.commitReceiptIds.length > 0 ? "RECEIPT_NOT_VERIFIED" : "NO_SUCCESS_EVIDENCE" };
}

export class BusinessOutcomeService implements InteractionOutcomeService {
  constructor(
    private readonly deps: ToolDeps,
    private readonly interactions: InteractionIndex,
  ) {}

  async record(raw: Parameters<InteractionOutcomeService["record"]>[0]): Promise<{ outcome: Outcome; reasonCode: string }> {
    const p = Input.safeParse(raw);
    if (!p.success) throw new ValidationError("OUTCOME_INPUT_INVALID");
    const input = p.data;
    const callActions = await this.interactions.forCall(input.tenantId, input.callId);
    const verified = callActions
      .filter((a) => a.receiptOutcome === "COMMITTED" && a.receiptId !== null && input.evidence.commitReceiptIds.includes(a.receiptId))
      .map((a) => a.actionKind);
    const decision = decideOutcome(input.contractId, input.evidence, verified);
    const now = this.deps.clock.now();
    const outcomeId = newId("ioc");
    await this.deps.db.tx(
      async (tx) => {
        await tx.query(
          `insert into interaction_outcomes (outcome_id, tenant_id, call_id, contract_id, outcome, reason_code, evidence, recorded_at)
           values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
          [outcomeId, input.tenantId, input.callId, input.contractId, decision.outcome, decision.reasonCode, JSON.stringify({ ...input.evidence, verifiedCommittedKinds: verified }), iso(now)],
        );
        await this.deps.audit.append(
          tx,
          buildAuditInput(
            {
              tenantId: input.tenantId,
              correlationId: outcomeId,
              sourceComponent: "gateway",
              action: "interaction.outcome_recorded",
              outcome: "SUCCEEDED",
              callId: input.callId,
              evidencePointers: [`db://interaction_outcomes/${outcomeId}`, ...input.evidence.commitReceiptIds.slice(0, 8).map((r) => `receipt:${r}`)],
              reasonCode: decision.reasonCode,
              versions: this.deps.versions,
            },
            this.deps.clock,
          ),
        );
      },
      { role: "app_runtime", rls: { tenantId: input.tenantId } },
    );
    const intent = input.contractId ? (contractById(input.contractId)?.intent ?? "unknown") : "unknown";
    this.deps.metrics.increment("vsp_interaction_outcomes_total", { outcome: decision.outcome, intent });
    return decision;
  }
}
