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
 * - A commit of this call still COMMITTING or UNKNOWN in the ledger (or committed there but its
 *   receipt not yet recorded for the call) at call end is OUTCOME_UNKNOWN
 *   (COMMIT_OUTCOME_UNKNOWN), never INFORMATION_PROVIDED (ACT-03: nothing is announced before
 *   reconciliation).
 * - Outcomes are append-only (migration 0300 trigger): when the reconciler later records the
 *   action COMMITTED, the action.committed consumer calls reviseAfterCommit(), which appends a
 *   REVISION row (evidence.revision names the outcome it revises, the trigger and the action)
 *   whenever the decision with the now-verified receipt differs. Nothing is overwritten; the
 *   latest row (recorded_at, strictly increasing per call) is the current outcome.
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
import type { InteractionActionRecord, InteractionIndex } from "./interactions.js";

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

/**
 * Pure decision given verified committed receipt kinds (exported for property tests).
 * `unresolvedCommits`: this call's actions whose commit outcome is not settled (ledger COMMITTING /
 * UNKNOWN, or committed but not yet recorded for the call); any => OUTCOME_UNKNOWN unless the call
 * was transferred or already resolved by verified evidence.
 */
export function decideOutcome(
  contractId: string | null,
  evidence: z.infer<typeof Input>["evidence"],
  verifiedCommittedKinds: readonly ActionKind[],
  unresolvedCommits = 0,
): Decision {
  if (evidence.transferConnected) return { outcome: "TRANSFERRED", reasonCode: "CALLER_CONFIRMED_CONNECTED" };
  const contract = contractId ? contractById(contractId) : null;
  if (contractId && !contract) return { outcome: "OUTCOME_UNKNOWN", reasonCode: "CONTRACT_UNKNOWN" };
  if (contract?.resolvedOutcome === "RESOLVED") {
    const kinds = RESOLVING_ACTION_KINDS[contract.contractId] ?? [];
    if (kinds.length > 0 && verifiedCommittedKinds.some((k) => kinds.includes(k))) return { outcome: "RESOLVED", reasonCode: "COMMITTED_RECEIPT_VERIFIED" };
  }
  // An ambiguous commit is reconciled before anything is announced (ACT-03): not "information provided".
  if (unresolvedCommits > 0) return { outcome: "OUTCOME_UNKNOWN", reasonCode: "COMMIT_OUTCOME_UNKNOWN" };
  // Workflow acceptance, case or support-request creation is never resolution (ACT-04).
  if (evidence.requestAccepted) return { outcome: "REQUEST_ACCEPTED", reasonCode: "REQUEST_ACCEPTED_NOT_RESOLUTION" };
  if (evidence.informationProvided) return { outcome: "INFORMATION_PROVIDED", reasonCode: "INFORMATION_PROVIDED" };
  if (evidence.policyDeclined) return { outcome: "DECLINED_BY_POLICY", reasonCode: "POLICY_DECLINED" };
  if (evidence.callerDisconnected) return { outcome: "CALLER_DISCONNECTED", reasonCode: "CALLER_DISCONNECTED" };
  if (evidence.failed) return { outcome: "FAILED", reasonCode: "FAILED" };
  return { outcome: "OUTCOME_UNKNOWN", reasonCode: evidence.commitReceiptIds.length > 0 ? "RECEIPT_NOT_VERIFIED" : "NO_SUCCESS_EVIDENCE" };
}

/** Contract of the call's verified committed actions: a resolving contract first, else the first recorded one. */
function inferContract(records: readonly { contractId: string | null }[]): string | null {
  const ids = records.map((r) => r.contractId).filter((c): c is string => c !== null && contractById(c) !== null);
  return ids.find((c) => (RESOLVING_ACTION_KINDS[c]?.length ?? 0) > 0) ?? ids[0] ?? null;
}

/** Ledger states of a call's action whose commit outcome is not settled for the call yet. */
const UNSETTLED_STATES: ReadonlySet<string> = new Set(["COMMITTING", "UNKNOWN", "COMMITTED"]);

/** Evidence stored with an outcome (the record() input evidence plus server-side derivations). */
const StoredEvidence = Input.shape.evidence.extend({
  verifiedCommittedKinds: z.array(z.string()).max(16).optional(),
  contractInferred: z.boolean().optional(),
  unresolvedActionIds: z.array(OpaqueId).max(32).optional(),
  revision: z.unknown().optional(),
});

interface OutcomeRow {
  outcome_id: string;
  contract_id: string | null;
  outcome: Outcome;
  reason_code: string;
  evidence: unknown;
  recorded_at: Date | string;
}

const msOf = (v: Date | string): number => (v instanceof Date ? v.getTime() : Date.parse(v));

export class BusinessOutcomeService implements InteractionOutcomeService {
  constructor(
    private readonly deps: ToolDeps,
    private readonly interactions: InteractionIndex,
  ) {}

  /**
   * This call's actions whose commit is not settled for the call: no COMMITTED receipt recorded in the
   * per-call index while the ledger says COMMITTING, UNKNOWN or COMMITTED (receipt not yet indexed). An
   * unreadable ledger row counts as unsettled (never a guessed outcome).
   */
  private async unsettledCommits(tenantId: string, callActions: readonly InteractionActionRecord[]): Promise<string[]> {
    const out: string[] = [];
    for (const a of callActions) {
      if (a.receiptOutcome === "COMMITTED") continue;
      const action = await this.deps.actions.get(tenantId, a.actionId).catch(() => undefined);
      if (action === undefined || (action !== null && UNSETTLED_STATES.has(action.state))) out.push(a.actionId);
    }
    return out;
  }

  async record(raw: Parameters<InteractionOutcomeService["record"]>[0]): Promise<{ outcome: Outcome; reasonCode: string }> {
    const p = Input.safeParse(raw);
    if (!p.success) throw new ValidationError("OUTCOME_INPUT_INVALID");
    const input = p.data;
    const callActions = await this.interactions.forCall(input.tenantId, input.callId);
    const verifiedRecords = callActions.filter((a) => a.receiptOutcome === "COMMITTED" && a.receiptId !== null && input.evidence.commitReceiptIds.includes(a.receiptId));
    const verified = verifiedRecords.map((a) => a.actionKind);
    const unsettled = await this.unsettledCommits(input.tenantId, callActions);
    // Call end (TC-11) names no contract: infer it from this call's own verified committed actions,
    // preferring a contract whose success evidence is a commit (never from caller or model input).
    const contractId = input.contractId ?? inferContract(verifiedRecords);
    const decision = decideOutcome(contractId, input.evidence, verified, unsettled.length);
    const now = this.deps.clock.now();
    const outcomeId = newId("ioc");
    await this.deps.db.tx(
      async (tx) => {
        await tx.query(
          `insert into interaction_outcomes (outcome_id, tenant_id, call_id, contract_id, outcome, reason_code, evidence, recorded_at)
           values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
          [
            outcomeId,
            input.tenantId,
            input.callId,
            contractId,
            decision.outcome,
            decision.reasonCode,
            JSON.stringify({ ...input.evidence, verifiedCommittedKinds: verified, contractInferred: input.contractId === null && contractId !== null, unresolvedActionIds: unsettled }),
            iso(now),
          ],
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
    const intent = contractId ? (contractById(contractId)?.intent ?? "unknown") : "unknown";
    this.deps.metrics.increment("vsp_interaction_outcomes_total", { outcome: decision.outcome, intent });
    return decision;
  }

  /**
   * Append-only outcome revision after the reconciler records `actionId` COMMITTED (called by the
   * action.committed consumer, idempotent and safe on redelivery). The call's CURRENT outcome is
   * re-decided with the now-recorded receipt; when the decision differs, a revision row is appended
   * (evidence.revision = { revises, previousOutcome, trigger, actionId }) with its own audit event.
   * No outcome yet (the call is still live) => nothing to revise: call end decides with the receipt.
   */
  async reviseAfterCommit(tenantId: string, actionId: string): Promise<{ revised: boolean; outcome: Outcome | null; reasonCode: string }> {
    if (!OpaqueId.safeParse(tenantId).success || !OpaqueId.safeParse(actionId).success) throw new ValidationError("OUTCOME_REVISION_INPUT_INVALID");
    const rec = await this.interactions.get(tenantId, actionId);
    if (!rec || rec.receiptOutcome !== "COMMITTED" || rec.receiptId === null) return { revised: false, outcome: null, reasonCode: "RECEIPT_NOT_RECORDED" };
    const receiptId = rec.receiptId;
    // Server-side facts first (each read opens its own transaction; none may run inside the revision's).
    const callActions = await this.interactions.forCall(tenantId, rec.callId);
    const unsettled = await this.unsettledCommits(tenantId, callActions);
    const now = this.deps.clock.now();
    const result = await this.deps.db.tx(
      async (tx) => {
        // One revision at a time per call (concurrent consumers or redeliveries).
        await tx.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`interaction_outcomes:${tenantId}:${rec.callId}`]);
        const latest = (
          await tx.query<OutcomeRow>(
            "select outcome_id, contract_id, outcome, reason_code, evidence, recorded_at from interaction_outcomes where call_id = $1 order by recorded_at desc, outcome_id desc limit 1",
            [rec.callId],
          )
        ).rows[0];
        if (!latest) return { revised: false, outcome: null, reasonCode: "NO_OUTCOME_RECORDED" };
        const prior = StoredEvidence.safeParse(typeof latest.evidence === "string" ? (JSON.parse(latest.evidence) as unknown) : latest.evidence);
        if (!prior.success) return { revised: false, outcome: latest.outcome, reasonCode: "OUTCOME_EVIDENCE_UNREADABLE" };
        const evidence = {
          commitReceiptIds: [...new Set([...prior.data.commitReceiptIds, receiptId])].slice(0, 16),
          informationProvided: prior.data.informationProvided,
          requestAccepted: prior.data.requestAccepted,
          transferConnected: prior.data.transferConnected,
          callerDisconnected: prior.data.callerDisconnected,
          policyDeclined: prior.data.policyDeclined,
          failed: prior.data.failed,
        };
        const verifiedRecords = callActions.filter((a) => a.receiptOutcome === "COMMITTED" && a.receiptId !== null && evidence.commitReceiptIds.includes(a.receiptId));
        const verified = verifiedRecords.map((a) => a.actionKind);
        const contractId = inferContract(verifiedRecords) ?? latest.contract_id;
        const decision = decideOutcome(contractId, evidence, verified, unsettled.length);
        if (decision.outcome === latest.outcome && decision.reasonCode === latest.reason_code) return { revised: false, outcome: latest.outcome, reasonCode: latest.reason_code };
        const outcomeId = newId("ioc");
        // Strictly later than the outcome it revises, so "latest" is unambiguous even with a frozen clock.
        const recordedAt = new Date(Math.max(now.getTime(), msOf(latest.recorded_at) + 1));
        await tx.query(
          `insert into interaction_outcomes (outcome_id, tenant_id, call_id, contract_id, outcome, reason_code, evidence, recorded_at)
           values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
          [
            outcomeId,
            tenantId,
            rec.callId,
            contractId,
            decision.outcome,
            decision.reasonCode,
            JSON.stringify({
              ...evidence,
              verifiedCommittedKinds: verified,
              contractInferred: contractId !== null,
              unresolvedActionIds: unsettled,
              revision: { revises: latest.outcome_id, previousOutcome: latest.outcome, trigger: "ACTION_COMMITTED_AFTER_CALL_END", actionId },
            }),
            iso(recordedAt),
          ],
        );
        await this.deps.audit.append(
          tx,
          buildAuditInput(
            {
              tenantId,
              correlationId: outcomeId,
              sourceComponent: "gateway",
              action: "interaction.outcome_revised",
              outcome: "SUCCEEDED",
              callId: rec.callId,
              evidencePointers: [`db://interaction_outcomes/${outcomeId}`, `db://interaction_outcomes/${latest.outcome_id}`, `receipt:${receiptId}`],
              reasonCode: decision.reasonCode,
              versions: this.deps.versions,
            },
            this.deps.clock,
          ),
        );
        return { revised: true, outcome: decision.outcome, reasonCode: decision.reasonCode };
      },
      // interaction_outcomes accepts inserts from the runtime role only (migration 0300); the revision is the
      // outcome service's own write, in the tenant's RLS context.
      { role: "app_runtime", rls: { tenantId } },
    );
    if (result.revised) this.deps.logger.info("business.outcome.revised", { reasonCode: result.reasonCode, outcome: result.outcome ?? null });
    return result;
  }
}
